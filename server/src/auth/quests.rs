//! 任务进度持久化：读取任务状态表、（测试）直接写状态、提交任务与任务交互事务。
//!
//! 从 `auth.rs` 机械搬出的第二块完整职责（超大文件治理）。搬的是**代码位置**，
//! 不是数据布局：quest_states 表结构与回执语义均未改变。

use super::*;

impl Store {
    /// Load the quest status map (quest id -> "active" | "completed") for an
    /// account.  The table lives separately from `player_stats` so development
    /// databases do not need a column migration.
    pub fn load_quests(&self, account_id: &str) -> Result<BTreeMap<String, String>, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        let mut stmt = db
            .prepare("SELECT quest_id,status FROM player_quests WHERE account_id=?1")
            .map_err(|_| "account persistence failed")?;
        let rows = stmt
            .query_map(params![account_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|_| "account persistence failed")?;
        let mut quests = BTreeMap::new();
        for row in rows {
            let (quest_id, status) = row.map_err(|_| "account persistence failed")?;
            quests.insert(quest_id, status);
        }
        Ok(quests)
    }

    /// Upsert one quest status row for existing store-level fixtures.
    #[cfg(test)]
    pub fn save_quest(&self, account_id: &str, quest_id: &str, status: &str) -> Result<(), String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        db.execute(
            "INSERT INTO player_quests(account_id,quest_id,status) VALUES(?1,?2,?3)
             ON CONFLICT(account_id,quest_id) DO UPDATE SET status=?3",
            params![account_id, quest_id, status],
        )
        .map_err(|_| "account persistence failed")?;
        Ok(())
    }

    /// Commit a quest transition and its player-side rewards as one durable
    /// business operation.  `(account_id, quest_id)` is the idempotency key;
    /// a retry after a committed transition returns `false` and rolls back.
    pub fn commit_quest(
        &self,
        account_id: &str,
        quest_id: &str,
        status: &str,
        profile: &Profile,
    ) -> Result<bool, String> {
        if quest_id.trim().is_empty() {
            return Err("invalid quest id".to_owned());
        }
        if !matches!(status, "active" | "completed") {
            return Err("invalid quest status".to_owned());
        }

        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;

        // Read through the same transaction so an unknown character cannot
        // create a quest row or leave a partial reward behind.  The durable
        // profile is also the authority for the q1402 transfer guard; the
        // world-supplied profile is an internal candidate, never client input.
        let durable_profile = read_profile(&tx, account_id)?;
        let previous: Option<String> = tx
            .query_row(
                "SELECT status FROM player_quests WHERE account_id=?1 AND quest_id=?2",
                params![account_id, quest_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "account persistence failed")?;

        let transition_allowed = match previous.as_deref() {
            None if status == "active" => true,
            Some("active") if status == "completed" => true,
            None if status == "completed" => {
                return Err("quest is not active".to_owned());
            }
            None => return Err("invalid quest transition".to_owned()),
            Some("active") | Some("completed") => false,
            Some(_) => return Err("invalid saved quest status".to_owned()),
        };
        if !transition_allowed {
            // Do not commit read_profile's normalization or any other write
            // on an idempotent retry; the caller reloads authoritative state.
            tx.rollback().map_err(|_| "account persistence failed")?;
            return Ok(false);
        }

        let mut first_mage_transfer = false;
        if quest_id == "1402" && status == "completed" {
            if durable_profile.level < 10 {
                return Err("q1402 level requirement missing".to_owned());
            }
            let prerequisite: Option<String> = tx
                .query_row(
                    "SELECT status FROM player_quests WHERE account_id=?1 AND quest_id='36307'",
                    [account_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|_| "account persistence failed")?;
            if prerequisite.as_deref() != Some("completed") {
                return Err("q1402 prerequisite missing".to_owned());
            }
            match durable_profile.job {
                0 => {
                    // World must prepare the candidate with the same pure
                    // first-job grant. Compare only transfer-owned fields so
                    // a stale beginner profile cannot overwrite job/SP/MP.
                    let mut expected = durable_profile.clone();
                    grant_first_mage(&mut expected);
                    if profile.job != expected.job
                        || profile.max_mp != expected.max_mp
                        || profile.mp != expected.mp
                        || profile.skills != expected.skills
                        || profile.skill_points != expected.skill_points
                    {
                        return Err("invalid q1402 first-job candidate".to_owned());
                    }
                    first_mage_transfer = true;
                }
                200 | 220 | THIRD_JOB | FOURTH_JOB => {
                    // A shortcut/older transferred character may recover the
                    // original story, but q1402 must not grant another job,
                    // SP or MP entitlement.
                    if profile.job != durable_profile.job {
                        return Err("q1402 job changed during story recovery".to_owned());
                    }
                }
                _ => return Err("q1402 job is not eligible".to_owned()),
            }
        }

        write_profile(&tx, account_id, profile)?;
        write_inventory_tx(&tx, account_id, &profile.inventory)?;
        if first_mage_transfer {
            let changed = tx
                .execute(
                    "UPDATE player_stats SET mage_support_granted=1 WHERE account_id=?1 AND job=200",
                    [account_id],
                )
                .map_err(|_| "account persistence failed")?;
            if changed != 1 {
                return Err("account persistence failed".to_owned());
            }
        }
        tx.execute(
            "INSERT INTO player_quests(account_id,quest_id,status) VALUES(?1,?2,?3)
             ON CONFLICT(account_id,quest_id) DO UPDATE SET status=?3",
            params![account_id, quest_id, status],
        )
        .map_err(|_| "account persistence failed")?;
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(true)
    }

    /// Recover the one authored quest interaction item from the durable
    /// inventory fact.  The interaction has no request table: possession is
    /// its idempotency key, so a retry with any request id cannot mint a
    /// second hairpin.
    pub fn commit_quest_interaction(
        &self,
        account_id: &str,
        quest_id: &str,
        item_id: &str,
        quantity: u32,
        profile: &Profile,
    ) -> Result<bool, String> {
        // P: the first authored interaction is Candy's quest 36301.  Keep
        // both sides of the pair fixed here so a caller cannot turn this
        // recovery hook into a generic item grant.
        if quest_id != "36301" || item_id != "4036846" || quantity != 1 {
            return Err("invalid quest interaction".to_owned());
        }

        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        let durable = read_profile(&tx, account_id)?;
        let status: Option<String> = tx
            .query_row(
                "SELECT status FROM player_quests WHERE account_id=?1 AND quest_id=?2",
                params![account_id, quest_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "account persistence failed")?;
        if status.as_deref() != Some("active") {
            return Err("quest is not active".to_owned());
        }

        let held = durable
            .inventory
            .iter()
            .filter(|item| item.item_id == item_id)
            .fold(0u32, |total, item| total.saturating_add(item.quantity));
        if held >= quantity {
            // read_profile may normalize legacy inventory rows.  An
            // idempotent retry must not commit even that normalization.
            tx.rollback().map_err(|_| "account persistence failed")?;
            return Ok(false);
        }

        let missing = quantity - held;
        let mut next_inventory = durable.inventory;
        let slots = read_inventory_slots_tx(&tx, account_id)
            .map_err(|_| "quest interaction rejected".to_owned())?;
        let slot_limit = slots
            .get(&inventory::inventory_type(item_id).unwrap_or(4))
            .copied()
            .unwrap_or(inventory::SLOT_LIMIT);
        inventory::add_items(&mut next_inventory, item_id.to_owned(), missing, slot_limit).map_err(
            |error| match error {
                inventory::InventoryError::InventoryFull => "quest interaction inventory full",
                inventory::InventoryError::UnknownItem => "quest interaction unknown item",
                _ => "quest interaction rejected",
            },
        )?;

        // Keep the world-supplied profile fields (notably its current
        // position), but never trust its inventory snapshot: the DB fact is
        // the base and only the missing quantity is added above.
        let mut next_profile = profile.clone();
        next_profile.inventory = next_inventory;
        write_profile(&tx, account_id, &next_profile)?;
        write_inventory_tx(&tx, account_id, &next_profile.inventory)?;
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(true)
    }

}
