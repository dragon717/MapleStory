//! 冰雷法师专属运行时：无限（Infinity）、冰雷 summons、超技能（雷霆/漩涡/冒险家/暴风雪追击）、
//! 冰魔/冰凤凰/冰龙吐息、冰原（生成/步进/命中判定）、冰墙推挤与传送精通。
//!
//! 从 `world.rs` 机械搬出的第七块完整职责的冰雷半区（超大文件治理 P2，热路径）。
//! 施法管线与通用结算在兄弟模块 `skills`；技能常量与数据布局均在 `world.rs` 原处。

use super::*;

impl World {

    pub(super) fn activate_infinity(&mut self, id: &str, level: &MageLevel) -> Result<(), String> {
        let base_ms = u64::try_from(level.time.unwrap_or(0).max(0))
            .map_err(|_| "infinity_duration_invalid".to_owned())?
            .saturating_mul(1_000);
        let duration_ms = self.buff_duration_ms(id, level, base_ms);
        if duration_ms == 0 {
            return Err("infinity_duration_invalid".to_owned());
        }
        let next_tick = self.tick.saturating_add((5_000_u64 / TICK_MS).max(1));
        let initial_bonus = level.q.unwrap_or(0).max(0);
        let Some(player) = self.players.get_mut(id) else {
            return Err("player_unknown".to_owned());
        };
        player.skill_buffs.insert(SKILL_INFINITY, duration_ms);
        player.infinity_next_tick = next_tick;
        player.infinity_damage_bonus = initial_bonus.min(level.w.unwrap_or(0).max(0));
        Ok(())
    }

    /// Apply Infinity's five-second HP/MP candidate only after the profile
    /// write succeeds.  The damage stage is session state and advances on the
    /// same successful interval; a failed write leaves both stages retryable.
    pub(super) fn step_infinity_tick(&mut self, id: &str) {
        let Some(snapshot) = self.players.get(id).map(|player| {
            (
                player.state.clone(),
                player.map_id.clone(),
                player.death_id.clone(),
                player.base_max_mp,
                player.infinity_next_tick,
                player
                    .skill_buffs
                    .get(&SKILL_INFINITY)
                    .copied()
                    .unwrap_or(0),
                player
                    .state
                    .skills
                    .get(&SKILL_INFINITY)
                    .copied()
                    .and_then(|level| self.mage_skills.level(SKILL_INFINITY, level).cloned()),
            )
        }) else {
            return;
        };
        let (state, map_id, death_id, base_max_mp, next_tick, remaining, level) = snapshot;
        if remaining == 0 || next_tick > self.tick || state.hp <= 0 {
            return;
        }
        let Some(level) = level else {
            return;
        };
        let percent = level.y.unwrap_or(0).clamp(0, 100);
        let hp_gain = state.max_hp.max(0).saturating_mul(percent) / 100;
        // String.h specifies the base MP recovery.  Do not let Magic Boost,
        // equipment, or a previous recomputation turn the tick into a larger
        // percentage of the derived MP pool.
        let mp_gain = base_max_mp.max(0).saturating_mul(percent) / 100;
        let candidate_hp = state.hp.saturating_add(hp_gain).min(state.max_hp.max(1));
        let candidate_mp = state.mp.saturating_add(mp_gain).min(state.max_mp.max(0));
        let mut candidate = state.clone();
        candidate.hp = candidate_hp;
        candidate.mp = candidate_mp;
        if let Some(store) = self.store.as_ref() {
            if store
                .save_profile(
                    &id,
                    &profile_from_state(&candidate, &map_id, &death_id, base_max_mp),
                )
                .is_err()
            {
                return;
            }
        }
        if let Some(player) = self.players.get_mut(id) {
            player.state.hp = candidate_hp;
            player.state.mp = candidate_mp;
            let increment = level.damage.unwrap_or(0).max(0);
            let cap = level.w.unwrap_or(0).max(0);
            player.infinity_damage_bonus = player
                .infinity_damage_bonus
                .saturating_add(increment)
                .min(cap.max(player.infinity_damage_bonus));
            player.infinity_next_tick = self.tick.saturating_add((5_000_u64 / TICK_MS).max(1));
        }
    }

    pub(super) fn cast_ice_demon(
        &mut self,
        id: &str,
        request_id: &str,
        level: &MageLevel,
    ) -> Result<(), String> {
        let Some((map_id, x, y, facing, skill_level)) = self.players.get(id).map(|player| {
            (
                player.map_id.clone(),
                player.state.x,
                player.state.y,
                player.state.facing,
                player
                    .state
                    .skills
                    .get(&SKILL_ICE_DEMON)
                    .copied()
                    .unwrap_or(1),
            )
        }) else {
            return Err("player_unknown".to_owned());
        };
        let duration_ticks = u64::try_from(level.time.unwrap_or(0).max(0))
            .unwrap_or(0)
            .saturating_mul(1_000)
            .div_ceil(TICK_MS)
            .max(1);
        let summon = ThunderSummon {
            summon_id: format!("ice-demon-{id}-{request_id}"),
            skill_id: SKILL_ICE_DEMON,
            level: skill_level,
            map_id,
            x,
            y,
            facing,
            anchored: true,
            expires_at: self.tick.saturating_add(duration_ticks),
            next_hit_at: self.tick.saturating_add((1_080_u64 / TICK_MS).max(1)),
            pulse_index: 0,
        };
        let Some(player) = self.players.get_mut(id) else {
            return Err("player_unknown".to_owned());
        };
        player.summons.retain(|old| old.skill_id != SKILL_ICE_DEMON);
        if player.summons.len() >= 2 {
            return Err("summon_limit".to_owned());
        }
        player.summons.push(summon);
        Ok(())
    }

    pub(super) fn cast_frozen_orb(
        &mut self,
        id: &str,
        request_id: &str,
        _level: &MageLevel,
    ) -> Result<(), String> {
        let Some((map_id, x, y, facing, skill_level)) = self.players.get(id).map(|player| {
            (
                player.map_id.clone(),
                player.state.x,
                player.state.y,
                player.state.facing,
                player
                    .state
                    .skills
                    .get(&SKILL_FROZEN_ORB)
                    .copied()
                    .unwrap_or(1),
            )
        }) else {
            return Err("player_unknown".to_owned());
        };
        let summon = ThunderSummon {
            summon_id: format!("frozen-orb-{id}-{request_id}"),
            skill_id: SKILL_FROZEN_ORB,
            level: skill_level,
            map_id,
            x,
            y,
            facing,
            anchored: false,
            expires_at: self.tick.saturating_add(4_000_u64.div_ceil(TICK_MS)),
            next_hit_at: self.tick.saturating_add((210_u64 / TICK_MS).max(1)),
            pulse_index: 0,
        };
        let Some(player) = self.players.get_mut(id) else {
            return Err("player_unknown".to_owned());
        };
        player
            .summons
            .retain(|old| old.skill_id != SKILL_FROZEN_ORB);
        if player.summons.len() >= 2 {
            return Err("summon_limit".to_owned());
        }
        player.summons.push(summon);
        Ok(())
    }

    pub(super) fn cast_ice_dragon_breath(
        &mut self,
        id: &str,
        request_id: &str,
        level: &MageLevel,
    ) -> Result<(), String> {
        let targets = self.area_targets(id, level);
        let excluded: BTreeSet<String> = targets
            .iter()
            .filter(|target_id| {
                self.monsters
                    .get(*target_id)
                    .is_some_and(|monster| monster.bind_immune_until > self.tick)
            })
            .cloned()
            .collect();
        let before: BTreeMap<String, (i64, i64)> = targets
            .iter()
            .filter(|target_id| !excluded.contains(*target_id))
            .filter_map(|target_id| {
                self.monsters
                    .get(target_id)
                    .map(|monster| (target_id.clone(), (monster.state.hp, monster.state.max_hp)))
            })
            .collect();
        if !before.is_empty() {
            self.cast_elemental_area_at_filtered(
                id,
                request_id,
                SKILL_ICE_DRAGON_BREATH,
                level,
                false,
                None,
                Some(&excluded),
            )?;
        }
        let base_seconds = u64::try_from(level.time.unwrap_or(0).max(0)).unwrap_or(0);
        let base_ticks = base_seconds.saturating_mul(1_000).div_ceil(TICK_MS).max(1);
        for (target_id, (old_hp, max_hp)) in before {
            let Some(monster) = self.monsters.get_mut(&target_id) else {
                continue;
            };
            if monster.state.hp <= 0 || monster.bind_immune_until > self.tick {
                continue;
            }
            let dealt = old_hp.saturating_sub(monster.state.hp).max(0);
            if dealt == 0 {
                continue;
            }
            let ratio = if max_hp > 0 {
                ((dealt as i128 * 100) / max_hp as i128).clamp(0, 100) as u64
            } else {
                0
            };
            let bind_ticks = base_ticks.saturating_mul(100 + ratio).div_ceil(100).max(1);
            monster.bind_until = self.tick.saturating_add(bind_ticks);
            monster.bind_immune_until = self.tick.saturating_add((90_000_u64 / TICK_MS).max(1));
            // String.h calls this action armor melting: v lowers PDRate and
            // w lowers MDRate for the bind window.  Keep both reductions
            // independent from the ninety-second bind immunity timer.
            monster.bind_pd_rate_reduction = level.v.unwrap_or(0).clamp(0, 100);
            monster.bind_md_rate_reduction = level.w.unwrap_or(0).clamp(0, 100);
            monster.state.action = "hit";
            monster.state.action_started_tick = self.tick;
        }
        // String.h makes q the hard held-key maximum; only ordinary buffs
        // use Master Magic's buff-time multiplier.
        let duration_ms = u64::try_from(level.q.unwrap_or(0).max(0)).unwrap_or(0) * 1_000;
        let Some(player) = self.players.get_mut(id) else {
            return Err("player_unknown".to_owned());
        };
        player.channel_request_id = Some(request_id.to_owned());
        player.channel_skill_id = Some(SKILL_ICE_DRAGON_BREATH);
        player.channel_until = self
            .tick
            .saturating_add(duration_ms.div_ceil(TICK_MS).max(1));
        player.channel_level = player
            .state
            .skills
            .get(&SKILL_ICE_DRAGON_BREATH)
            .copied()
            .unwrap_or(1);
        player
            .skill_buffs
            .insert(SKILL_ICE_DRAGON_BREATH, duration_ms);
        Ok(())
    }

    pub(super) fn start_hyper_thunder(
        &mut self,
        id: &str,
        request_id: &str,
        level: &MageLevel,
    ) -> Result<(), String> {
        let prepare_ticks = 780_u64.div_ceil(TICK_MS).max(1);
        let hold_ticks = u64::try_from(level.q.unwrap_or(2).max(0))
            .unwrap_or(2)
            .saturating_mul(1_000)
            .div_ceil(TICK_MS)
            .max(1);
        let channel_until = self.tick.saturating_add(prepare_ticks + hold_ticks);
        let Some(player) = self.players.get_mut(id) else {
            return Err("player_unknown".to_owned());
        };
        player.channel_request_id = Some(request_id.to_owned());
        player.channel_skill_id = Some(SKILL_HYPER_THUNDER);
        player.channel_until = channel_until;
        player.channel_level = player
            .state
            .skills
            .get(&SKILL_HYPER_THUNDER)
            .copied()
            .unwrap_or(1);
        player.hyper_channel_prepare_until = self.tick.saturating_add(prepare_ticks);
        player.hyper_channel_next_pulse = player.hyper_channel_prepare_until;
        player.hyper_channel_pulse_index = 0;
        player.skill_buffs.insert(
            SKILL_HYPER_THUNDER,
            (prepare_ticks + hold_ticks).saturating_mul(TICK_MS),
        );
        player.state.action = "attack";
        player.state.action_started_tick = self.tick;
        player.attack_until = channel_until;
        Ok(())
    }

    pub(super) fn step_hyper_channels(&mut self) {
        let ids: Vec<String> = self
            .players
            .iter()
            .filter_map(|(id, player)| {
                (player.channel_skill_id == Some(SKILL_HYPER_THUNDER)).then_some(id.clone())
            })
            .collect();
        for id in ids {
            let Some(snapshot) = self.players.get(&id).map(|player| {
                (
                    player.channel_until,
                    player.hyper_channel_prepare_until,
                    player.hyper_channel_next_pulse,
                    player.hyper_channel_pulse_index,
                    player.channel_request_id.clone(),
                    player.channel_level,
                    player.state.hp,
                )
            }) else {
                continue;
            };
            if snapshot.6 <= 0 || snapshot.0 <= self.tick {
                if snapshot.6 > 0 {
                    let request = snapshot.4.as_deref().unwrap_or("hyper-timeout");
                    if let Err(error) = self.finish_hyper_thunder(&id, request) {
                        self.handle_accepted_effect_error(&id, request, &error);
                    }
                } else {
                    self.stop_hyper_thunder(&id, snapshot.4.as_deref().unwrap_or("hyper-dead"));
                }
                continue;
            }
            if self.tick < snapshot.1 || self.tick < snapshot.2 {
                continue;
            }
            let Some(level) = self
                .mage_skills
                .level(SKILL_HYPER_THUNDER, snapshot.5.max(1))
                .cloned()
            else {
                self.stop_hyper_thunder(&id, snapshot.4.as_deref().unwrap_or("hyper-invalid"));
                continue;
            };
            let base_request = snapshot.4.as_deref().unwrap_or("hyper");
            let pulse_request = format!("{base_request}:pulse:{}", snapshot.3 + 1);
            // The accepted cast pre-pays the first source MP charge and owns
            // the durable 60-second cooldown.  The first pulse therefore
            // resolves without a second debit; every later pulse is its own
            // durable 30 MP action with cooldown=0.
            let prepaid_first_pulse = snapshot.3 == 0;
            let mut pulse_mp = self.players.get(&id).map(|p| p.state.mp).unwrap_or(0);
            if !prepaid_first_pulse {
                let outcome = match self.store.as_ref() {
                    Some(store) => store.cast_skill_with_cooldown(
                        &id,
                        &pulse_request,
                        SKILL_HYPER_THUNDER,
                        ICE_FOURTH_JOB,
                        FOURTH_BOOK,
                        1,
                        level.mp_con.unwrap_or(30).max(0),
                        0,
                    ),
                    None => Ok(self.local_cast_skill(
                        &id,
                        &pulse_request,
                        SKILL_HYPER_THUNDER,
                        FOURTH_BOOK,
                        level.mp_con.unwrap_or(30).max(0),
                    )),
                };
                let Ok(outcome) = outcome else {
                    self.stop_hyper_thunder(&id, base_request);
                    self.send_reject(&id, "effect_persistence", "Hyper持续脉冲保存失败。", None);
                    continue;
                };
                if !outcome.success {
                    self.stop_hyper_thunder(&id, base_request);
                    self.send_reject(
                        &id,
                        "hyper_pulse_stopped",
                        "MP不足，Hyper持续攻击已结束。",
                        None,
                    );
                    continue;
                }
                pulse_mp = outcome.mp;
            }
            if let Some(player) = self.players.get_mut(&id) {
                player.state.mp = pulse_mp;
                player.hyper_channel_pulse_index =
                    player.hyper_channel_pulse_index.saturating_add(1);
                player.hyper_channel_next_pulse =
                    self.tick.saturating_add(200_u64.div_ceil(TICK_MS));
            }
            if let Err(error) =
                self.cast_elemental_area(&id, &pulse_request, SKILL_HYPER_THUNDER, &level, false)
            {
                self.stop_hyper_thunder(&id, base_request);
                self.handle_accepted_effect_error(&id, &pulse_request, &error);
                continue;
            }
            if snapshot.3 == 0 {
                let event = self.skill_cast_event_phase(
                    &id,
                    base_request,
                    SKILL_HYPER_THUNDER,
                    2_000,
                    &level,
                    Some("sustain"),
                    None,
                );
                if let Some(map_id) = self.players.get(&id).map(|player| player.map_id.clone()) {
                    self.broadcast_to_map(&map_id, &event);
                }
            }
        }
    }

    pub(super) fn stop_hyper_thunder(&mut self, id: &str, request_id: &str) {
        let Some(player) = self.players.get_mut(id) else {
            return;
        };
        let map_id = player.map_id.clone();
        let x = player.state.x;
        let y = player.state.y;
        let facing = player.state.facing;
        player.channel_request_id = None;
        player.channel_skill_id = None;
        player.channel_until = 0;
        player.channel_level = 0;
        player.hyper_channel_prepare_until = 0;
        player.hyper_channel_next_pulse = 0;
        player.hyper_channel_pulse_index = 0;
        player.skill_buffs.remove(&SKILL_HYPER_THUNDER);
        player.attack_until = self.tick;
        if player.state.action == "attack" {
            player.state.action = "stand";
            player.state.action_started_tick = self.tick;
        }
        let event = serde_json::json!({
            "type": "skillCast",
            "eventId": format!("skill-hyper-stop-{id}-{request_id}"),
            "serverTick": self.tick,
            "playerId": id,
            "skillId": SKILL_HYPER_THUNDER,
            "requestId": request_id,
            "x": x,
            "y": y,
            "facing": facing,
            "durationMs": 0,
            "phase": "sustain",
        })
        .to_string();
        self.broadcast_to_map(&map_id, &event);
    }

    pub(super) fn finish_hyper_thunder(&mut self, id: &str, request_id: &str) -> Result<(), String> {
        let Some((level, map_id)) = self.players.get(id).map(|player| {
            (
                self.mage_skills
                    .level(SKILL_HYPER_THUNDER, player.channel_level.max(1))
                    .cloned()
                    .unwrap_or_default(),
                player.map_id.clone(),
            )
        }) else {
            return Err("player_unknown".to_owned());
        };
        let mut final_level = level.clone();
        final_level.damage = level.x.or(level.damage);
        final_level.attack_count = Some(level.w.unwrap_or(15).max(0) as u32);
        final_level.mob_count = Some(level.mob_count.unwrap_or(15));
        self.stop_hyper_thunder(id, request_id);
        self.cast_elemental_area(
            id,
            &format!("{request_id}:final"),
            SKILL_HYPER_THUNDER,
            &final_level,
            false,
        )?;
        if let Some(player) = self.players.get_mut(id) {
            player.attack_until = self.tick.saturating_add(900_u64.div_ceil(TICK_MS).max(1));
            player.state.action = "attack";
            player.state.action_started_tick = self.tick;
        }
        let event = self.skill_cast_event_phase(
            id,
            request_id,
            SKILL_HYPER_THUNDER,
            900,
            &final_level,
            Some("final"),
            None,
        );
        self.broadcast_to_map(&map_id, &event);
        Ok(())
    }

    pub(super) fn activate_hyper_adventurer(&mut self, id: &str, level: &MageLevel) {
        // The source describes an adventurer-wide damage buff.  It now reaches
        // the party members standing on the caster's map; a caster without a
        // party still gets exactly the old self-only behaviour.  Its duration
        // is independent of Master Magic's buff-time multiplier.
        let duration_ms = u64::try_from(level.time.unwrap_or(60).max(0))
            .unwrap_or(60)
            .saturating_mul(1_000);
        if duration_ms == 0 {
            return;
        }
        for target in self.party_members_on_map(id) {
            if let Some(player) = self.players.get_mut(&target) {
                player
                    .skill_buffs
                    .insert(SKILL_HYPER_ADVENTURER, duration_ms);
            }
        }
    }

    pub(super) fn activate_hyper_vortex(
        &mut self,
        id: &str,
        request_id: &str,
        level: &MageLevel,
        vertical: i8,
    ) -> Result<(), String> {
        let Some((map_id, x, y, facing, barrier_enabled)) = self.players.get(id).map(|player| {
            (
                player.map_id.clone(),
                player.state.x,
                player.state.y,
                player.state.facing,
                player.hyper_barrier_enabled,
            )
        }) else {
            return Err("player_unknown".to_owned());
        };
        if vertical > 0 {
            let hidden_level = self
                .mage_skills
                .level(SKILL_HYPER_VORTEX_HIDDEN, 1)
                .cloned()
                .unwrap_or_else(|| level.clone());
            let duration_ms = u64::try_from(hidden_level.u2.unwrap_or(30).max(0))
                .unwrap_or(30)
                .saturating_mul(1_000);
            let pulse_ms =
                u64::try_from(hidden_level.sub_time.unwrap_or(1_200).max(1)).unwrap_or(1_200);
            if duration_ms == 0 || pulse_ms == 0 {
                return Err("invalid_hyper_vortex".to_owned());
            }
            let Some(player) = self.players.get_mut(id) else {
                return Err("player_unknown".to_owned());
            };
            player.hyper_vortex = Some(HyperVortex {
                request_id: request_id.to_owned(),
                map_id: map_id.clone(),
                x,
                y,
                facing,
                hidden: true,
                expires_at: self.tick.saturating_add(duration_ms.div_ceil(TICK_MS)),
                next_pulse_at: self.tick,
            });
            // A down-key vortex is a separate area object; it does not turn
            // the visible ON/OFF barrier off or on and has no damage path.
            let event = serde_json::json!({
                "type": "skillCast",
                "eventId": format!("skill-hyper-vortex-{id}-{request_id}"),
                "serverTick": self.tick,
                "playerId": id,
                "skillId": SKILL_HYPER_VORTEX_HIDDEN,
                "requestId": request_id,
                "x": x,
                "y": y,
                "facing": facing,
                "durationMs": duration_ms,
            })
            .to_string();
            self.broadcast_to_map(&map_id, &event);
        } else {
            let Some(player) = self.players.get_mut(id) else {
                return Err("player_unknown".to_owned());
            };
            player.hyper_barrier_enabled = !barrier_enabled;
            if player.hyper_barrier_enabled {
                player.hyper_barrier_next_mp =
                    self.tick.saturating_add(1_000_u64.div_ceil(TICK_MS));
                player.hyper_barrier_next_pulse = self.tick;
            } else {
                player.hyper_barrier_next_mp = 0;
                player.hyper_barrier_next_pulse = 0;
            }
        }
        Ok(())
    }

    pub(super) fn step_hyper_effects(&mut self) {
        let ids: Vec<String> = self.players.keys().cloned().collect();
        for id in ids {
            let Some(snapshot) = self.players.get(&id).map(|player| {
                (
                    player.state.hp,
                    player.map_id.clone(),
                    player.hyper_barrier_enabled,
                    player.hyper_barrier_next_mp,
                    player.hyper_barrier_next_pulse,
                    player.hyper_vortex.clone(),
                )
            }) else {
                continue;
            };
            if snapshot.0 <= 0 {
                if let Some(player) = self.players.get_mut(&id) {
                    clear_hyper_runtime(player);
                    refresh_player_derived(&self.gameplay, &self.mage_skills, player);
                }
                continue;
            }

            if snapshot.2 && snapshot.3 <= self.tick {
                let upkeep_request = format!("hyper-barrier:{id}:{}", self.tick);
                let cost = if self
                    .players
                    .get(&id)
                    .is_some_and(|player| player.skill_buffs.contains_key(&SKILL_INFINITY))
                {
                    0
                } else {
                    60
                };
                let outcome = match self.store.as_ref() {
                    Some(store) => store.cast_skill(
                        &id,
                        &upkeep_request,
                        SKILL_HYPER_VORTEX,
                        ICE_FOURTH_JOB,
                        FOURTH_BOOK,
                        1,
                        cost,
                    ),
                    None => Ok(self.local_cast_skill(
                        &id,
                        &upkeep_request,
                        SKILL_HYPER_VORTEX,
                        FOURTH_BOOK,
                        cost,
                    )),
                };
                match outcome {
                    Ok(outcome) if outcome.success => {
                        if let Some(player) = self.players.get_mut(&id) {
                            player.state.mp = outcome.mp;
                            player.hyper_barrier_next_mp =
                                self.tick.saturating_add(1_000_u64.div_ceil(TICK_MS));
                        }
                    }
                    Ok(_) | Err(_) => {
                        if let Some(player) = self.players.get_mut(&id) {
                            player.hyper_barrier_enabled = false;
                            player.hyper_barrier_next_mp = 0;
                            player.hyper_barrier_next_pulse = 0;
                            refresh_player_derived(&self.gameplay, &self.mage_skills, player);
                        }
                        self.send_reject(
                            &id,
                            "hyper_barrier_stopped",
                            "MP不足，冰雪結界已结束。",
                            None,
                        );
                        self.send_snapshot(&id);
                    }
                }
            }

            // The upkeep transaction may turn the barrier off in this same
            // tick.  Read the committed runtime flag again before applying
            // its freeze pulse; the pre-charge snapshot must not grant one
            // last free effect after an MP/persistence failure.
            let barrier_enabled = self
                .players
                .get(&id)
                .is_some_and(|player| player.hyper_barrier_enabled);
            if barrier_enabled && snapshot.4 <= self.tick {
                let Some(level) = self.mage_skills.level(SKILL_HYPER_VORTEX, 1).cloned() else {
                    continue;
                };
                let targets = self.area_targets(&id, &level);
                for target_id in targets {
                    self.freeze_target(&target_id, 1);
                }
                if let Some(player) = self.players.get_mut(&id) {
                    player.hyper_barrier_next_pulse =
                        self.tick.saturating_add(2_400_u64.div_ceil(TICK_MS));
                }
            }

            let Some(vortex) = snapshot.5 else {
                continue;
            };
            if vortex.map_id != snapshot.1 || vortex.expires_at <= self.tick {
                if let Some(player) = self.players.get_mut(&id) {
                    player.hyper_vortex = None;
                }
                let event = serde_json::json!({
                    "type": "skillCast",
                    "eventId": format!("skill-hyper-vortex-stop-{id}-{}", vortex.request_id),
                    "serverTick": self.tick,
                    "playerId": id,
                    "skillId": SKILL_HYPER_VORTEX_HIDDEN,
                    "requestId": vortex.request_id,
                    "x": vortex.x,
                    "y": vortex.y,
                    "facing": vortex.facing,
                    "durationMs": 0,
                })
                .to_string();
                self.broadcast_to_map(&snapshot.1, &event);
                self.refresh_hyper_player_derived(&id);
                continue;
            }
            if vortex.next_pulse_at <= self.tick {
                let Some(level) = self
                    .mage_skills
                    .level(SKILL_HYPER_VORTEX_HIDDEN, 1)
                    .cloned()
                else {
                    continue;
                };
                let targets = self.area_targets_at(&id, &level, vortex.x, vortex.y, vortex.facing);
                for target_id in targets {
                    self.freeze_target(&target_id, 1);
                }
                if let Some(player) = self.players.get_mut(&id) {
                    if let Some(active) = player.hyper_vortex.as_mut() {
                        let pulse_ms =
                            u64::try_from(level.sub_time.unwrap_or(1_200).max(1)).unwrap_or(1_200);
                        active.next_pulse_at = self.tick.saturating_add(pulse_ms.div_ceil(TICK_MS));
                    }
                }
            }
            self.refresh_hyper_player_derived(&id);
        }
    }

    pub(super) fn refresh_hyper_player_derived(&mut self, id: &str) {
        if let Some(player) = self.players.get_mut(id) {
            refresh_player_derived(&self.gameplay, &self.mage_skills, player);
        }
    }

    pub(super) fn maybe_cast_blizzard_follow_up(
        &mut self,
        id: &str,
        request_id: &str,
        target_id: &str,
    ) -> Result<(), String> {
        let Some(level) = self
            .players
            .get(id)
            .and_then(|player| player.state.skills.get(&SKILL_BLIZZARD))
            .copied()
            .and_then(|skill_level| self.mage_skills.level(SKILL_BLIZZARD, skill_level))
            .cloned()
        else {
            return Ok(());
        };
        let Some((target_x, target_y, map_id)) = self.monsters.get(target_id).and_then(|monster| {
            (monster.state.hp > 0).then_some((
                monster.state.x,
                monster.state.y,
                monster.map_id.clone(),
            ))
        }) else {
            return Ok(());
        };
        if self
            .players
            .get(id)
            .is_none_or(|player| player.map_id != map_id)
        {
            return Ok(());
        }
        let prop = level.prop.unwrap_or(0).clamp(0, 100) as u64;
        if deterministic_percent(&[id, request_id, target_id, "blizzard-follow-up"]) >= prop {
            return Ok(());
        }
        let mut follow = level.clone();
        follow.damage = level.x;
        follow.mob_count = Some(1);
        follow.attack_count = Some(1);
        follow.lt = Some(crate::mage::MagePoint {
            x: -500.0,
            y: -500.0,
        });
        follow.rb = Some(crate::mage::MagePoint { x: 500.0, y: 500.0 });
        // Anchor the hidden hit at the target that actually survived the
        // triggering cast, then exclude every other mob.  A second scan from
        // the caster would let a nearby mob steal the passive hit.
        let excluded = self
            .monsters
            .keys()
            .filter(|other_id| other_id.as_str() != target_id)
            .cloned()
            .collect::<BTreeSet<_>>();
        self.cast_elemental_area_at_filtered(
            id,
            &format!("{request_id}:blizzard-passive"),
            SKILL_BLIZZARD_HIDDEN,
            &follow,
            false,
            Some((
                target_x,
                target_y,
                self.players.get(id).map(|p| p.state.facing).unwrap_or(1),
            )),
            Some(&excluded),
        )
    }

    pub(super) fn apply_chain_stun(&mut self, id: &str, request_id: &str, level: &MageLevel) {
        let prop = level.prop.unwrap_or(0).clamp(0, 100) as u64;
        let duration_ticks = u64::try_from(level.time.unwrap_or(1).max(0))
            .unwrap_or(1)
            .saturating_mul(1_000)
            .div_ceil(TICK_MS)
            .max(1);
        for target_id in self.skill_area_targets(id, SKILL_CHAIN_LIGHTNING, level) {
            if deterministic_percent(&[id, request_id, target_id.as_str(), "chain-stun"]) >= prop {
                continue;
            }
            if let Some(monster) = self.monsters.get_mut(&target_id) {
                if monster.state.hp > 0 {
                    monster.stun_until = self.tick.saturating_add(duration_ticks);
                    monster.state.action = "hit";
                    monster.state.action_started_tick = self.tick;
                }
            }
        }
    }

    pub(super) fn step_summons(&mut self) {
        let ids: Vec<String> = self.players.keys().cloned().collect();
        let mut due = Vec::new();
        for id in ids {
            let map_id = self
                .players
                .get(&id)
                .map(|player| player.map_id.clone())
                .unwrap_or_default();
            let map = self.map_for(&map_id).clone();
            let Some(player) = self.players.get_mut(&id) else {
                continue;
            };
            if player.state.action == "dead" {
                player.summon = None;
                player.summons.clear();
                continue;
            }
            if let Some(mut summon) = player.summon.take() {
                if summon.expires_at > self.tick && summon.map_id == player.map_id {
                    if !summon.anchored {
                        summon.x = player.state.x;
                        summon.y = player.state.y;
                        summon.facing = player.state.facing;
                    }
                    if summon.next_hit_at <= self.tick {
                        due.push((id.clone(), summon.clone()));
                        let pulse_skill = if summon.skill_id == SKILL_THUNDER_SPHERE_HIDDEN {
                            SKILL_THUNDER_SPHERE_HIDDEN
                        } else {
                            SKILL_THUNDER_SPHERE
                        };
                        let pulse_ms = self
                            .mage_skills
                            .level(pulse_skill, summon.level)
                            .and_then(|level| level.sub_time)
                            .unwrap_or(1_080)
                            .max(1) as u64;
                        summon.next_hit_at = self.tick.saturating_add(pulse_ms.div_ceil(TICK_MS));
                        summon.pulse_index = summon.pulse_index.saturating_add(1);
                    }
                    player.summon = Some(summon);
                }
            }
            let mut retained = Vec::with_capacity(player.summons.len());
            for mut summon in std::mem::take(&mut player.summons) {
                if summon.expires_at <= self.tick || summon.map_id != player.map_id {
                    continue;
                }
                if summon.skill_id == SKILL_FROZEN_ORB {
                    let direction = if summon.facing < 0 { -1.0 } else { 1.0 };
                    summon.x = (summon.x + direction * 180.0 * TICK_MS as f64 / 1_000.0)
                        .clamp(map.bounds.x_min, map.bounds.x_max);
                }
                if summon.next_hit_at <= self.tick {
                    due.push((id.clone(), summon.clone()));
                    let pulse_ms = match summon.skill_id {
                        // The exported subTime is a source-side delay field,
                        // while this P implementation's periodic demon hit
                        // is explicitly 1080ms.  Do not interpret source 8
                        // as eight milliseconds.
                        SKILL_ICE_DEMON => 1_080,
                        SKILL_FROZEN_ORB => self
                            .mage_skills
                            .level(SKILL_FROZEN_ORB, summon.level)
                            .and_then(|level| level.attack_delay)
                            .unwrap_or(210)
                            .max(1) as u64,
                        _ => 1_080,
                    };
                    summon.next_hit_at = self.tick.saturating_add(pulse_ms.div_ceil(TICK_MS));
                    summon.pulse_index = summon.pulse_index.saturating_add(1);
                }
                retained.push(summon);
            }
            player.summons = retained;
        }
        for (id, summon) in due {
            // The anchored form is a display variant of the same skill: its
            // own catalog row carries no attack geometry, so the pulse has to
            // resolve against the parent row or it would hit for a fraction.
            let pulse_skill = if summon.skill_id == SKILL_THUNDER_SPHERE_HIDDEN {
                SKILL_THUNDER_SPHERE
            } else {
                summon.skill_id
            };
            let Some(pulse_level) = self
                .mage_skills
                .level(pulse_skill, summon.level)
                .cloned()
                .or_else(|| {
                    self.mage_skills
                        .level(SKILL_THUNDER_SPHERE, summon.level)
                        .cloned()
                })
            else {
                continue;
            };
            let request_id = format!("{}-pulse-{}", summon.summon_id, summon.pulse_index);
            let lightning = matches!(
                summon.skill_id,
                SKILL_THUNDER_SPHERE | SKILL_THUNDER_SPHERE_HIDDEN
            );
            let result = self.cast_elemental_area_at(
                &id,
                &request_id,
                summon.skill_id,
                &pulse_level,
                lightning,
                Some((summon.x, summon.y, summon.facing)),
            );
            if let Err(error) = result {
                self.handle_accepted_effect_error(&id, &request_id, &error);
            }
        }
    }

    pub(super) fn cast_glacial_wall(
        &mut self,
        id: &str,
        request_id: &str,
        level: &MageLevel,
    ) -> Result<(), String> {
        let targets = self.area_targets(id, level);
        self.cast_elemental_area(id, request_id, SKILL_GLACIAL_WALL, level, false)?;
        for target_id in targets {
            self.apply_glacial_push(id, &target_id);
        }
        Ok(())
    }

    pub(super) fn apply_glacial_push(&mut self, caster_id: &str, target_id: &str) {
        let Some(caster_facing) = self
            .players
            .get(caster_id)
            .map(|player| player.state.facing)
        else {
            return;
        };
        let Some((map_id, x, y)) = self
            .monsters
            .get(target_id)
            .map(|monster| (monster.map_id.clone(), monster.state.x, monster.state.y))
        else {
            return;
        };
        let map = self.map_for(&map_id).clone();
        let direction = if caster_facing < 0 { -1.0 } else { 1.0 };
        // P: String/Skill has no server displacement contract for `u=480`;
        // use one bounded source-facing push so the wall has a visible,
        // collision-safe effect without inventing a map-wide knockback.
        let pushed_x = (x + direction * 48.0).clamp(map.bounds.x_min, map.bounds.x_max);
        let Some((foothold_id, pushed_y)) = map
            .ground_near(pushed_x, y)
            .filter(|(_, ground)| (ground - y).abs() <= 48.0)
            .map(|(foothold_id, ground)| (foothold_id, ground))
        else {
            return;
        };
        if let Some(monster) = self.monsters.get_mut(target_id) {
            if monster.state.hp <= 0 {
                return;
            }
            monster.state.x = pushed_x;
            monster.state.y = pushed_y;
            monster.foothold_id = foothold_id;
        }
    }

    pub(super) fn cast_teleport_mastery(
        &mut self,
        id: &str,
        request_id: &str,
        level: &MageLevel,
    ) -> Result<(), String> {
        let targets = self.skill_area_targets(id, SKILL_TELEPORT_MASTERY, level);
        self.cast_elemental_area(id, request_id, SKILL_TELEPORT_MASTERY, level, true)?;
        let chance = level.sub_prop.unwrap_or(0).clamp(0, 100) as u64;
        let duration_ticks = u64::try_from(level.time.unwrap_or(2).max(0))
            .unwrap_or(2)
            .saturating_mul(1_000)
            .div_ceil(TICK_MS);
        for target_id in targets {
            let roll =
                deterministic_percent(&[id, request_id, target_id.as_str(), "teleport-mastery"]);
            if roll >= chance {
                continue;
            }
            if let Some(monster) = self.monsters.get_mut(&target_id) {
                if monster.state.hp > 0 {
                    monster.stun_until = self.tick.saturating_add(duration_ticks.max(1));
                    monster.state.action = "hit";
                    monster.state.action_started_tick = self.tick;
                }
            }
        }
        Ok(())
    }

    pub(super) fn maybe_create_ice_field(&mut self, id: &str, start_x: f64, start_y: f64) {
        let Some((map_id, end_x, end_y, facing, level)) = self.players.get(id).and_then(|player| {
            if !player.ice_teleport_enabled {
                return None;
            }
            player
                .state
                .skills
                .get(&SKILL_ICE_TELEPORT)
                .and_then(|level| self.mage_skills.level(SKILL_ICE_TELEPORT, *level))
                .cloned()
                .map(|level| {
                    (
                        player.map_id.clone(),
                        player.state.x,
                        player.state.y,
                        player.state.facing,
                        level,
                    )
                })
        }) else {
            return;
        };
        let prop = level.prop.unwrap_or(0).clamp(0, 100);
        if prop == 0
            || rand::thread_rng().gen_range(0..100) >= prop
            || (start_x - end_x).abs() < 0.001 && (start_y - end_y).abs() < 0.001
        {
            return;
        }
        let lt = level
            .lt
            .map(|point| (point.x, point.y))
            .unwrap_or((-20.0, -20.0));
        let rb = level
            .rb
            .map(|point| (point.x, point.y))
            .unwrap_or((40.0, 20.0));
        // P: use the authored rectangle as a swept corridor and round the
        // source subTime to the fixed world tick; no source tile scheduler is
        // available in this server.
        let sub_time_ms = level
            .sub_time
            .unwrap_or(i64::try_from(ICE_TELEPORT_FIELD_DEFAULT_SUB_TIME_MS).unwrap_or(1_200))
            .max(1) as u64;
        let duration_ms = (level.time.unwrap_or(6).max(0) as u64).saturating_mul(1_000);
        let expires_at = self.tick.saturating_add(duration_ms.div_ceil(TICK_MS));
        let field_index = self
            .players
            .get(id)
            .map(|player| player.ice_fields.len())
            .unwrap_or(0);
        let field_id = format!("ice-field-cast-{id}-{}-{field_index}", self.tick);
        let field = IceField {
            field_id: field_id.clone(),
            map_id: map_id.clone(),
            start_x,
            start_y,
            end_x,
            end_y,
            lt,
            rb,
            damage_percent: level.damage.unwrap_or(2).max(0),
            expires_at,
            next_hit_at: self.tick,
            sub_time_ms,
        };
        let pushed = if let Some(player) = self.players.get_mut(id) {
            player.ice_fields.push(field);
            true
        } else {
            false
        };
        if pushed {
            // P: reuse the existing skillCast envelope so clients can render
            // the authored rectangular corridor without a new protocol type.
            self.broadcast_to_map(
                &map_id,
                &serde_json::json!({
                    "type": "skillCast",
                    "eventId": field_id,
                    "serverTick": self.tick,
                    "playerId": id,
                    "skillId": SKILL_ICE_TELEPORT,
                    "requestId": format!("ice-field-cast-{id}-{}-{field_index}", self.tick),
                    "x": start_x,
                    "y": start_y,
                    "targetX": end_x,
                    "targetY": end_y,
                    "facing": facing,
                    "durationMs": duration_ms,
                })
                .to_string(),
            );
        }
    }

    pub(super) fn step_ice_fields(&mut self) {
        let ids: Vec<String> = self.players.keys().cloned().collect();
        let mut due = Vec::new();
        for id in ids {
            let Some(player) = self.players.get(&id) else {
                continue;
            };
            for (index, field) in player.ice_fields.iter().enumerate() {
                if field.expires_at <= self.tick || field.next_hit_at > self.tick {
                    continue;
                }
                let targets = self
                    .monsters
                    .iter()
                    .filter_map(|(monster_id, monster)| {
                        (monster.map_id == field.map_id
                            && monster.state.hp > 0
                            && self.ice_field_contains(field, monster.state.x, monster.state.y))
                        .then_some(monster_id.clone())
                    })
                    .take(6)
                    .collect::<Vec<_>>();
                due.push((id.clone(), index, field.clone(), targets));
            }
        }
        for (id, index, field, targets) in due {
            for target_id in targets {
                let _ = self.resolve_ice_field_hit(&id, &field, &target_id);
            }
            if let Some(player) = self.players.get_mut(&id) {
                if let Some(field) = player.ice_fields.get_mut(index) {
                    field.next_hit_at = self
                        .tick
                        .saturating_add(field.sub_time_ms.div_ceil(TICK_MS));
                }
            }
        }
        for player in self.players.values_mut() {
            player
                .ice_fields
                .retain(|field| field.expires_at > self.tick);
        }
    }

    pub(super) fn ice_field_contains(&self, field: &IceField, x: f64, y: f64) -> bool {
        let left = field.start_x.min(field.end_x) + field.lt.0.min(field.rb.0);
        let right = field.start_x.max(field.end_x) + field.lt.0.max(field.rb.0);
        let top = field.start_y.min(field.end_y) + field.lt.1.min(field.rb.1);
        let bottom = field.start_y.max(field.end_y) + field.lt.1.max(field.rb.1);
        x >= left && x <= right && y >= top && y <= bottom
    }

    pub(super) fn resolve_ice_field_hit(
        &mut self,
        id: &str,
        field: &IceField,
        target_id: &str,
    ) -> Result<(), String> {
        let (target_hp, target_max_hp, template, x, y, quests) = match self.monsters.get(target_id)
        {
            Some(monster) if monster.state.hp > 0 => (
                monster.state.hp,
                monster.state.max_hp,
                monster.template.clone(),
                monster.state.x,
                monster.state.y,
                self.players
                    .get(id)
                    .map(|player| player.quests.clone())
                    .unwrap_or_default(),
            ),
            _ => return Ok(()),
        };
        let magic_attack = self
            .players
            .get(id)
            .map(|player| player.state.derived_stats.magic_attack)
            .unwrap_or(1)
            .max(1);
        let base_damage = (magic_attack as f64 * field.damage_percent as f64 / 100.0)
            .floor()
            .max(1.0) as i64;
        let request_id = format!("{}-hit-{}-{}", field.field_id, self.tick, target_id);
        let critical = rand::thread_rng().gen_range(0..100) < self.magic_critical_chance(id);
        let damage = self.magic_damage_with_passives(
            id,
            SKILL_ICE_TELEPORT,
            target_id,
            base_damage,
            critical,
            &request_id,
            1,
        );
        let killed = damage >= target_hp;
        let applied_damage = damage.min(target_hp.max(0));
        let practice = auth::is_practice_map(&field.map_id);
        let drops = if killed && !practice {
            self.choose_drops(&template, x, y, id, &quests)
        } else {
            Vec::new()
        };
        // Same kill-objective rule as a normal attack: only an active quest can
        // be advanced, and only by the kill that claims the monster's reward.
        let quest_kills = if killed && !practice {
            self.active_kill_objectives(id, &template.template_id)
        } else {
            Vec::new()
        };
        let resolution = if let Some(store) = self.store.as_ref() {
            let action_id = request_id.clone();
            let claim = store.claim_attack(id, &field.map_id, &request_id, &action_id, "skill")?;
            if claim.resolved {
                return Ok(());
            }
            store.resolve_attack_with_party(
                id,
                &field.map_id,
                &request_id,
                Some(target_id),
                applied_damage,
                killed,
                template.exp,
                target_max_hp,
                &drops,
                &self.gameplay.exp_table,
                &self.players.keys().cloned().collect::<Vec<_>>(),
                &self.party_exp_members(id),
                &quest_kills,
            )?
        } else {
            auth::AttackResolution {
                already_resolved: false,
                target_id: Some(target_id.to_owned()),
                damage: applied_damage,
                killed,
                exp_gain: if killed && !practice { template.exp } else { 0 },
                drop: drops.first().cloned(),
                drops,
                profile: None,
                profiles: Vec::new(),
            }
        };
        if resolution.already_resolved {
            return Ok(());
        }
        self.freeze_target(target_id, 1);
        if let Some(monster) = self.monsters.get_mut(target_id) {
            monster.state.hp = (monster.state.hp - resolution.damage).max(0);
            monster.state.action = if monster.state.hp == 0 { "die" } else { "hit" };
            monster.state.action_started_tick = self.tick;
            if monster.state.hp == 0 {
                monster.freeze_until = 0;
                monster.state.freeze_stacks = None;
                monster.stun_until = 0;
                monster.death_until = Some(
                    self.tick
                        + monster
                            .template
                            .die_duration_ms
                            .unwrap_or(1)
                            .div_ceil(TICK_MS)
                            .max(1),
                );
                monster.respawn_at = respawn_deadline(
                    self.tick,
                    self.gameplay.monster_respawn_ms,
                    monster.spawn.mob_time,
                );
            }
        }
        if resolution.damage > 0 {
            self.broadcast_to_map(
                &field.map_id,
                &serde_json::json!({
                    "type": "damageEvent",
                    "eventId": format!("damage-event-{request_id}"),
                    "serverTick": self.tick,
                    "attackerId": id,
                    "targetId": target_id,
                    "x": x,
                    "y": y,
                    "damage": resolution.damage,
                    "killed": resolution.killed,
                    "skillId": SKILL_ICE_TELEPORT,
                    "segment": 1,
                    "targetCount": 1,
                    "critical": critical,
                })
                .to_string(),
            );
        }
        if !resolution.profiles.is_empty() {
            for (participant, profile) in resolution.profiles {
                if let Some(player) = self.players.get_mut(&participant) {
                    apply_profile_to_player(&self.gameplay, &self.mage_skills, player, profile);
                }
            }
        } else if let Some(profile) = resolution.profile {
            if let Some(player) = self.players.get_mut(id) {
                apply_profile_to_player(&self.gameplay, &self.mage_skills, player, profile);
            }
        } else if resolution.exp_gain > 0 && self.store.is_none() {
            if let Some(player) = self.players.get_mut(id) {
                Self::add_exp(
                    &mut player.state,
                    resolution.exp_gain,
                    &self.gameplay.exp_table,
                );
                refresh_player_derived(&self.gameplay, &self.mage_skills, player);
            }
        }
        for drop in resolution.drops {
            let drop_id = drop.id.clone();
            self.drops.insert(
                drop_id.clone(),
                DropState {
                    id: drop.id.clone(),
                    item_id: drop.item_id.clone(),
                    quantity: drop.quantity,
                    x: drop.x,
                    y: drop.y,
                },
            );
            self.drop_instances
                .insert(drop_id.clone(), DropInstance::from_record(&drop));
            self.drop_owners
                .insert(drop_id.clone(), (drop.owner_id, drop.protected_until_ms));
            self.drop_maps.insert(drop_id, field.map_id.clone());
        }
        if resolution.killed {
            self.apply_quest_kill_credit(id, &quest_kills);
        }
        Ok(())
    }
}
