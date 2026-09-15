//! 战斗掉落持久化：攻击认领、伤害分账结算（含队伍分成）、掉落表读取、
//! 拾取幂等回执与拾取事务，以及 StoredResolution 快照与贡献/掉落读取辅助。
//!
//! 从 `auth.rs` 机械搬出的第四块完整职责（超大文件治理）。搬的是**代码位置**，
//! 不是数据布局：attacks / attack_drops / drop 表结构与结算口径均未改变。

use super::*;

impl Store {
    pub fn claim_attack(
        &self,
        account_id: &str,
        map_id: &str,
        request_id: &str,
        action_id: &str,
        event: &str,
    ) -> Result<AttackClaim, String> {
        if map_id.is_empty() {
            return Err("attack map missing".into());
        }
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        let prior: Option<(String, String, i64, String)> = tx
            .query_row(
                "SELECT action_id,event,resolved,map_id FROM attack_actions WHERE account_id=?1 AND request_id=?2",
                params![account_id, request_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(|_| "account persistence failed")?;
        if let Some((action_id, event, resolved, prior_map_id)) = prior {
            if resolved == 0 {
                if prior_map_id.is_empty() {
                    return Err("attack request has no bound map".into());
                }
                if prior_map_id != map_id {
                    return Err("attack request map changed".into());
                }
            }
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(AttackClaim {
                action_id,
                event,
                resolved: resolved != 0,
            });
        }
        tx.execute(
            "INSERT INTO attack_actions(account_id,request_id,action_id,event,map_id) VALUES (?1,?2,?3,?4,?5)",
            params![account_id, request_id, action_id, event, map_id],
        )
        .map_err(|_| "account persistence failed")?;
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(AttackClaim {
            action_id: action_id.to_owned(),
            event: event.to_owned(),
            resolved: false,
        })
    }

    /// Settle one attack without a party: the solo path every caller used
    /// before parties existed, and the entry point the store's own tests use.
    #[allow(dead_code)] // production callers pass a party list; tests use the solo form.
    pub fn resolve_attack(
        &self,
        account_id: &str,
        map_id: &str,
        request_id: &str,
        target_id: Option<&str>,
        damage: i64,
        killed: bool,
        exp_gain: u64,
        target_max_hp: i64,
        drops: &[DropRecord],
        exp_table: &[u64],
        eligible_accounts: &[String],
    ) -> Result<AttackResolution, String> {
        self.resolve_attack_with_party(
            account_id,
            map_id,
            request_id,
            target_id,
            damage,
            killed,
            exp_gain,
            target_max_hp,
            drops,
            exp_table,
            eligible_accounts,
            &[],
            &[],
        )
    }

    /// Settle one attack, optionally sharing a party EXP bonus.
    ///
    /// `party_members` are the characters the world says are grouped with the
    /// killer *and* standing on the killer's map, already resolved to real
    /// accounts; an empty slice leaves the existing damage-share arithmetic
    /// untouched.  The bonus is granted inside the same transaction as the
    /// kill, so a retry of the same request settles exactly once.
    ///
    /// `quest_kills` are the `(quest_id, mob template id)` kill objectives the
    /// killer has *active* and that this monster template satisfies.  They are
    /// bumped by one inside the same transaction, and only when the kill was
    /// the one that claimed `monster_rewards` (`reward_claimed`), so a replayed
    /// death message or a duplicate request cannot add progress twice.  The
    /// count belongs to the account whose attack landed the kill; party credit
    /// is a separate decision that this path does not make on its own.
    pub fn resolve_attack_with_party(
        &self,
        account_id: &str,
        map_id: &str,
        request_id: &str,
        target_id: Option<&str>,
        damage: i64,
        killed: bool,
        exp_gain: u64,
        target_max_hp: i64,
        drops: &[DropRecord],
        exp_table: &[u64],
        eligible_accounts: &[String],
        party_members: &[String],
        quest_kills: &[(String, String)],
    ) -> Result<AttackResolution, String> {
        if map_id.is_empty() {
            return Err("attack map missing".into());
        }
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        let practice = is_practice_map(map_id);
        let effective_exp_gain = if practice { 0 } else { exp_gain };
        let effective_drops: &[DropRecord] = if practice { &[] } else { drops };
        let prior: Option<StoredResolution> = tx
            .query_row(
                "SELECT map_id,resolved,target_id,damage,killed,exp_gain,drop_id,drop_item_id,drop_quantity,drop_x,drop_y
                 FROM attack_actions WHERE account_id=?1 AND request_id=?2",
                params![account_id, request_id],
                StoredResolution::from_row,
            )
            .optional()
            .map_err(|_| "account persistence failed")?;
        let Some(prior) = prior else {
            return Err("unknown attack request".into());
        };
        if prior.resolved {
            let drops = read_attack_drops(&tx, account_id, request_id, prior.drop)?;
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(AttackResolution {
                already_resolved: true,
                target_id: prior.target_id,
                damage: prior.damage,
                killed: prior.killed,
                exp_gain: prior.exp_gain,
                drop: drops.first().cloned(),
                drops,
                profile: None,
                profiles: Vec::new(),
            });
        }
        if prior.map_id.is_empty() {
            return Err("attack request has no bound map".into());
        }
        if prior.map_id != map_id {
            return Err("attack request map changed".into());
        }

        if let Some(monster_id) = target_id.filter(|_| damage > 0) {
            tx.execute(
                "INSERT INTO monster_damage(monster_id,account_id,damage) VALUES (?1,?2,?3)
                 ON CONFLICT(monster_id,account_id) DO UPDATE SET damage=damage+excluded.damage",
                params![monster_id, account_id, damage],
            )
            .map_err(|_| "account persistence failed")?;
        }

        // A member can be both a damage contributor and a party member; the
        // map keeps one authoritative row per character so the world never has
        // to decide which of two profiles is newer.
        let mut profiles: BTreeMap<String, Profile> = BTreeMap::new();
        let mut awarded_exp = 0u64;
        let mut awarded_drops = Vec::new();
        let mut reward_claimed = false;
        if killed {
            if let Some(monster_id) = target_id {
                let contributions = read_damage_contributions(&tx, monster_id)?;
                let winner = contributions
                    .iter()
                    .max_by(|(a_id, a_damage), (b_id, b_damage)| {
                        a_damage.cmp(b_damage).then_with(|| b_id.cmp(a_id))
                    })
                    .map(|(participant, _)| participant.clone())
                    .unwrap_or_else(|| account_id.to_owned());
                let persisted_exp_gain =
                    i64::try_from(effective_exp_gain).map_err(|_| "account persistence failed")?;
                // Practice rows are encounter facts only.  Any future formal
                // kill/quest counter must query this table with practice=0.
                reward_claimed = tx
                    .execute(
                        "INSERT OR IGNORE INTO monster_rewards(monster_id,account_id,request_id,exp_gain,drop_id,practice)
                         VALUES (?1,?2,?3,?4,?5,?6)",
                        params![
                            monster_id,
                            winner.as_str(),
                            request_id,
                            persisted_exp_gain,
                            effective_drops.first().map(|d| d.id.as_str()),
                            if practice { 1 } else { 0 },
                        ],
                    )
                    .map_err(|_| "account persistence failed")?
                    > 0;
                if reward_claimed {
                    let total_damage = target_max_hp.max(1) as f64;
                    for (participant, contribution) in contributions {
                        if !eligible_accounts.iter().any(|id| id == &participant) {
                            continue;
                        }
                        let share = ((persisted_exp_gain.max(0) as f64)
                            * (contribution.max(0) as f64)
                            / total_damage)
                            .round()
                            .max(0.0) as u64;
                        if share == 0 {
                            continue;
                        }
                        let mut profile = read_profile(&tx, &participant)?;
                        add_exp(&mut profile, share, exp_table);
                        write_profile(&tx, &participant, &profile)?;
                        if participant == account_id {
                            awarded_exp = share;
                        }
                        profiles.insert(participant, profile);
                    }
                    // Party bonus pool.  P: the TMS273 export carries no
                    // party EXP rule, so the bonus is a fixed share of the
                    // monster's authored EXP split by level between the
                    // grouped characters that are actually present — including
                    // members who never hit the monster, which is the reason
                    // to form a party at all.  It sits inside the kill
                    // transaction so a retried request cannot pay it twice.
                    if party_members.len() > 1 && persisted_exp_gain > 0 {
                        let rate = (PARTY_EXP_BONUS_PER_MEMBER * (party_members.len() - 1) as f64)
                            .min(PARTY_EXP_BONUS_CAP);
                        let pool = ((persisted_exp_gain as f64) * rate).round() as u64;
                        if pool > 0 {
                            // Read every grouped character once: it is both the
                            // level weight and the row the new total is written
                            // back into.
                            let mut weights: Vec<(String, u64)> = Vec::new();
                            let mut rows: BTreeMap<String, Profile> = BTreeMap::new();
                            for member in party_members {
                                let profile = match profiles.remove(member) {
                                    Some(profile) => profile,
                                    None => read_profile(&tx, member)?,
                                };
                                weights.push((member.clone(), profile.level.max(1) as u64));
                                rows.insert(member.clone(), profile);
                            }
                            let total_weight: u64 =
                                weights.iter().map(|(_, level)| *level).sum::<u64>().max(1);
                            for (member, level) in weights {
                                let Some(mut profile) = rows.remove(&member) else {
                                    continue;
                                };
                                let share = ((pool as f64) * (level as f64) / total_weight as f64)
                                    .floor() as u64;
                                if share > 0 {
                                    add_exp(&mut profile, share, exp_table);
                                    write_profile(&tx, &member, &profile)?;
                                    if member == account_id {
                                        awarded_exp = awarded_exp.saturating_add(share);
                                    }
                                }
                                profiles.insert(member, profile);
                            }
                        }
                    }
                    // Quest kill progress rides the kill-reward identity: only
                    // the kill that claimed `monster_rewards` advances it, so
                    // a replayed death message or a duplicated request can
                    // never add the same monster twice.  Practice kills are
                    // encounter facts, never quest progress.
                    if !practice {
                        for (quest_id, mob_id) in quest_kills {
                            if quest_id.trim().is_empty() || mob_id.trim().is_empty() {
                                continue;
                            }
                            tx.execute(
                                "INSERT INTO quest_kills(account_id,quest_id,mob_id,kill_count)
                                 VALUES(?1,?2,?3,1)
                                 ON CONFLICT(account_id,quest_id,mob_id)
                                 DO UPDATE SET kill_count=kill_count+1",
                                params![account_id, quest_id, mob_id],
                            )
                            .map_err(|_| "account persistence failed")?;
                        }
                    }
                    let protected_until_ms = now_ms().saturating_add(DROP_PROTECTION_MS);
                    for drop in effective_drops {
                        let mut drop = drop.clone();
                        drop.owner_id = Some(winner.clone());
                        drop.protected_until_ms = protected_until_ms;
                        let stats_json =
                            serde_json::to_string(&drop.stats.clone().unwrap_or_default())
                                .map_err(|_| "account persistence failed")?;
                        let upgrade_count = drop.upgrade_count.unwrap_or(0);
                        let remaining_slots = drop.remaining_slots.unwrap_or(0);
                        tx.execute(
                            "INSERT OR IGNORE INTO drops(id,map_id,item_id,quantity,x,y,owner_account_id,protected_until_ms,
                             stats_json,upgrade_count,remaining_slots,active)
                             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,1)",
                            params![
                                drop.id,
                                map_id,
                                drop.item_id,
                                drop.quantity as i64,
                                drop.x,
                                drop.y,
                                drop.owner_id,
                                drop.protected_until_ms,
                                stats_json,
                                i64::from(upgrade_count),
                                i64::from(remaining_slots),
                            ],
                        )
                        .map_err(|_| "account persistence failed")?;
                        tx.execute(
                            "INSERT OR IGNORE INTO attack_drops(account_id,request_id,drop_id)
                             VALUES (?1,?2,?3)",
                            params![account_id, request_id, drop.id],
                        )
                        .map_err(|_| "account persistence failed")?;
                        awarded_drops.push(drop);
                    }
                }
            }
        }

        let profile = profiles.get(account_id).cloned();
        tx.execute(
            "UPDATE attack_actions SET resolved=1,target_id=?3,damage=?4,killed=?5,exp_gain=?6,
             drop_id=?7,drop_item_id=?8,drop_quantity=?9,drop_x=?10,drop_y=?11
             WHERE account_id=?1 AND request_id=?2",
            params![
                account_id,
                request_id,
                target_id,
                damage,
                if reward_claimed { 1 } else { 0 },
                awarded_exp as i64,
                awarded_drops.first().map(|d| d.id.as_str()),
                awarded_drops.first().map(|d| d.item_id.as_str()),
                awarded_drops.first().map(|d| d.quantity as i64),
                awarded_drops.first().map(|d| d.x),
                awarded_drops.first().map(|d| d.y)
            ],
        )
        .map_err(|_| "account persistence failed")?;
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(AttackResolution {
            already_resolved: false,
            target_id: target_id.map(str::to_owned),
            damage,
            killed: reward_claimed,
            exp_gain: awarded_exp,
            drop: awarded_drops.first().cloned(),
            drops: awarded_drops,
            profile,
            profiles: profiles.into_iter().collect(),
        })
    }

    pub fn load_drops(&self, map_id: &str) -> Result<Vec<DropRecord>, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        let mut stmt = db
            .prepare("SELECT id,item_id,quantity,x,y,owner_account_id,protected_until_ms,stats_json,upgrade_count,remaining_slots FROM drops WHERE map_id=?1 AND active=1")
            .map_err(|_| "account persistence failed")?;
        let rows = stmt
            .query_map([map_id], |row| {
                Ok(DropRecord {
                    id: row.get(0)?,
                    item_id: row.get(1)?,
                    quantity: row.get::<_, i64>(2)?.try_into().unwrap_or(0),
                    x: row.get(3)?,
                    y: row.get(4)?,
                    owner_id: row.get(5)?,
                    protected_until_ms: row.get(6)?,
                    stats: row
                        .get::<_, String>(7)
                        .ok()
                        .and_then(|json| serde_json::from_str(&json).ok()),
                    upgrade_count: row
                        .get::<_, i64>(8)
                        .ok()
                        .and_then(|value| u32::try_from(value.max(0)).ok()),
                    remaining_slots: row
                        .get::<_, i64>(9)
                        .ok()
                        .and_then(|value| u32::try_from(value.max(0)).ok()),
                })
            })
            .map_err(|_| "account persistence failed")?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| "account persistence failed".into())
    }

    pub fn prior_pickup(
        &self,
        account_id: &str,
        request_id: &str,
    ) -> Result<Option<PickupOutcome>, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        db.query_row(
            "SELECT drop_id,item_id,quantity,slot,success,code FROM pickup_actions
             WHERE account_id=?1 AND request_id=?2",
            params![account_id, request_id],
            |row| {
                Ok(PickupOutcome {
                    drop_id: row.get(0)?,
                    item_id: row.get(1)?,
                    quantity: row.get::<_, i64>(2)?.try_into().unwrap_or(0),
                    slot: row
                        .get::<_, Option<i64>>(3)?
                        .and_then(|slot| slot.try_into().ok()),
                    success: row.get::<_, i64>(4)? != 0,
                    code: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(|_| "account persistence failed".into())
    }

    pub fn pickup(
        &self,
        account_id: &str,
        map_id: &str,
        request_id: &str,
        drop_id: &str,
    ) -> Result<PickupOutcome, String> {
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        normalize_inventory_tx(&tx)?;
        normalize_equipped_tx(&tx)?;
        if let Some(prior) = read_pickup_action(&tx, account_id, request_id)? {
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(prior);
        }
        let drop: Option<(
            String,
            i64,
            Option<String>,
            i64,
            String,
            i64,
            i64,
        )> = tx
            .query_row(
                "SELECT item_id,quantity,owner_account_id,protected_until_ms,stats_json,upgrade_count,remaining_slots
                 FROM drops WHERE id=?1 AND map_id=?2 AND active=1",
                params![drop_id, map_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| "account persistence failed")?;
        let (item_id, quantity, slot, success, code) = if let Some((
            item_id,
            quantity,
            owner_id,
            protected_until_ms,
            stats_json,
            upgrade_count,
            remaining_slots,
        )) = drop
        {
            // 世界事实判定（世界模型 §3.3 / §41）：`Owner` + `ItemState` 由
            // `item_world` 唯一翻译，这里不再内联比较保护窗与 owner 列。
            let (owner, state) = item_world::drop_fact(owner_id.as_deref(), protected_until_ms);
            if !item_world::pickup_allowed(&owner, &state, account_id, now_ms()) {
                (item_id, quantity, None, false, "drop_owned".to_owned())
            } else if quantity <= 0 || u32::try_from(quantity).is_err() {
                (item_id, quantity, None, false, "drop_invalid".to_owned())
            } else {
                let quantity_u32 = u32::try_from(quantity).unwrap_or(0);
                // Claim the row before awarding anything.  A second SQLite
                // connection can have read the same active row while the
                // first transaction is still open; making this conditional
                // update the first write guarantees that at most one caller
                // can proceed to reward mutation.
                let claimed = tx
                    .execute(
                        "UPDATE drops SET active=0 WHERE id=?1 AND map_id=?2 AND active=1",
                        params![drop_id, map_id],
                    )
                    .map_err(|_| "account persistence failed")?;
                if claimed != 1 {
                    (
                        item_id,
                        quantity,
                        None,
                        false,
                        "drop_unavailable".to_owned(),
                    )
                } else {
                    let add_result = if item_id == "0" {
                        Ok(Ok(None))
                    } else if inventory::consume_on_pickup(&item_id) {
                        let existing: i64 = tx
                            .query_row(
                                "SELECT COALESCE(quantity,0) FROM monster_book_cards
                                     WHERE account_id=?1 AND item_id=?2",
                                params![account_id, item_id.as_str()],
                                |row| row.get(0),
                            )
                            .optional()
                            .map_err(|_| "account persistence failed")?
                            .unwrap_or(0);
                        // Cosmic consumes every consumeOnPickup card even
                        // after the MonsterBook reaches five copies.  Only
                        // the persisted count saturates at five; the drop is
                        // still claimed successfully.
                        let capped_existing = existing.clamp(0, 5);
                        let accepted = (5 - capped_existing).min(i64::from(quantity_u32));
                        if accepted > 0 {
                            tx.execute(
                                    "INSERT INTO monster_book_cards(account_id,item_id,quantity)
                                     VALUES (?1,?2,?3)
                                     ON CONFLICT(account_id,item_id) DO UPDATE SET quantity=quantity+excluded.quantity",
                                    params![account_id, item_id.as_str(), accepted],
                                )
                                .map_err(|_| "account persistence failed")?;
                        }
                        Ok(Ok(None))
                    } else {
                        let stats = serde_json::from_str::<BTreeMap<String, i64>>(&stats_json).ok();
                        add_inventory_tx(
                            &tx,
                            account_id,
                            &item_id,
                            quantity_u32,
                            stats.as_ref(),
                            u32::try_from(remaining_slots.max(0)).ok(),
                            u32::try_from(upgrade_count.max(0)).ok(),
                        )
                        .map(|result| result.map(Some))
                    };
                    match add_result {
                        Err(error) => return Err(error),
                        Ok(Err(code)) => {
                            // Business-level rejection (full tab or card
                            // cap) must leave the drop available.  Restoring
                            // the claim inside this transaction also keeps
                            // the failure action durable without a reward.
                            let restored = tx
                                .execute(
                                    "UPDATE drops SET active=1 WHERE id=?1 AND map_id=?2 AND active=0",
                                    params![drop_id, map_id],
                                )
                                .map_err(|_| "account persistence failed")?;
                            if restored != 1 {
                                return Err("account persistence failed".to_owned());
                            }
                            (item_id, quantity, None, false, code.to_owned())
                        }
                        Ok(Ok(inventory_slot)) => {
                            if item_id == "0" {
                                tx.execute(
                                    "UPDATE player_stats SET mesos=mesos+?2 WHERE account_id=?1",
                                    params![account_id, quantity],
                                )
                                .map_err(|_| "account persistence failed")?;
                            }
                            (item_id, quantity, inventory_slot, true, String::new())
                        }
                    }
                }
            }
        } else {
            (String::new(), 0, None, false, "drop_unavailable".to_owned())
        };
        tx.execute(
            "INSERT INTO pickup_actions(account_id,request_id,drop_id,item_id,quantity,slot,success,code)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                account_id,
                request_id,
                drop_id,
                item_id,
                quantity,
                slot.map(i64::from),
                if success { 1 } else { 0 },
                code
            ],
        )
        .map_err(|_| "account persistence failed")?;
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(PickupOutcome {
            drop_id: drop_id.to_owned(),
            item_id,
            quantity: quantity.try_into().unwrap_or(0),
            slot,
            success,
            code,
        })
    }
}

#[derive(Clone, Debug)]
struct StoredResolution {
    map_id: String,
    resolved: bool,
    target_id: Option<String>,
    damage: i64,
    killed: bool,
    exp_gain: u64,
    drop: Option<DropRecord>,
}

impl StoredResolution {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        let drop_id: Option<String> = row.get(6)?;
        let drop = if let Some(id) = drop_id {
            Some(DropRecord {
                id,
                item_id: row.get::<_, Option<String>>(7)?.unwrap_or_default(),
                quantity: row
                    .get::<_, Option<i64>>(8)?
                    .unwrap_or(0)
                    .try_into()
                    .unwrap_or(0),
                x: row.get::<_, Option<f64>>(9)?.unwrap_or(0.0),
                y: row.get::<_, Option<f64>>(10)?.unwrap_or(0.0),
                owner_id: None,
                protected_until_ms: 0,
                ..DropRecord::default()
            })
        } else {
            None
        };
        Ok(Self {
            map_id: row.get(0)?,
            resolved: row.get::<_, i64>(1)? != 0,
            target_id: row.get(2)?,
            damage: row.get(3)?,
            killed: row.get::<_, i64>(4)? != 0,
            exp_gain: row.get::<_, i64>(5)?.max(0) as u64,
            drop,
        })
    }
}

fn read_damage_contributions(
    tx: &rusqlite::Transaction<'_>,
    monster_id: &str,
) -> Result<Vec<(String, i64)>, String> {
    let mut stmt = tx
        .prepare(
            "SELECT account_id,damage FROM monster_damage
             WHERE monster_id=?1 AND damage>0 ORDER BY account_id",
        )
        .map_err(|_| "account persistence failed")?;
    let rows = stmt
        .query_map([monster_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|_| "account persistence failed")?
        .collect::<Result<Vec<_>, _>>();
    rows.map_err(|_| "account persistence failed".into())
}

fn read_attack_drops(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    request_id: &str,
    legacy_drop: Option<DropRecord>,
) -> Result<Vec<DropRecord>, String> {
    let mut stmt = tx
        .prepare(
            "SELECT d.id,d.item_id,d.quantity,d.x,d.y,d.owner_account_id,d.protected_until_ms,
                    d.stats_json,d.upgrade_count,d.remaining_slots
             FROM attack_drops a JOIN drops d ON d.id=a.drop_id
             WHERE a.account_id=?1 AND a.request_id=?2 ORDER BY d.id",
        )
        .map_err(|_| "account persistence failed")?;
    let drops = stmt
        .query_map(params![account_id, request_id], |row| {
            Ok(DropRecord {
                id: row.get(0)?,
                item_id: row.get(1)?,
                quantity: row.get::<_, i64>(2)?.try_into().unwrap_or(0),
                x: row.get(3)?,
                y: row.get(4)?,
                owner_id: row.get(5)?,
                protected_until_ms: row.get(6)?,
                stats: row
                    .get::<_, String>(7)
                    .ok()
                    .and_then(|json| serde_json::from_str(&json).ok()),
                upgrade_count: row
                    .get::<_, i64>(8)
                    .ok()
                    .and_then(|value| u32::try_from(value.max(0)).ok()),
                remaining_slots: row
                    .get::<_, i64>(9)
                    .ok()
                    .and_then(|value| u32::try_from(value.max(0)).ok()),
                ..DropRecord::default()
            })
        })
        .map_err(|_| "account persistence failed")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "account persistence failed")?;
    if drops.is_empty() {
        Ok(legacy_drop.into_iter().collect())
    } else {
        Ok(drops)
    }
}
