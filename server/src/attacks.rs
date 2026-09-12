//! 攻击结算（tick 内动作阶段）。
//!
//! 负责：挂起攻击的逐 tick 结算（`resolve_pending_attacks`——攻击窗口推进、
//! 目标判定、伤害事件广播、死亡与掉落触发）与目标选择
//! （`nearest_attack_target`，矩形攻击范围对怪物的最近命中）。
//! 不负责：攻击命令的入口校验（`handle_attack` 留在 `world.rs`）、
//! 怪物受伤/仇恨状态（`monsters.rs`）、经验与掉落分配（`auth` 的 loot 事务）。
//! 方法可见性 pub(super) 与原 private 可达范围相同；全为方法调用、无需 glob。

use super::*;

impl World {
    pub(super) fn resolve_pending_attacks(&mut self) {
        let ready: Vec<String> = self
            .pending_attacks
            .iter()
            .filter(|(_, attack)| attack.hit_tick <= self.tick)
            .map(|(id, _)| id.clone())
            .collect();
        for action_id in ready {
            let Some(attack) = self.pending_attacks.remove(&action_id) else {
                continue;
            };
            let Some(player) = self.players.get(&attack.player_id) else {
                continue;
            };
            if player.state.action == "dead" || player.state.climbing {
                continue;
            }
            let map_id = player.map_id.clone();
            let quests = player.quests.clone();
            let target_id = self.nearest_attack_target(player);
            let (target_hp, max_hp, target_template, target_x, target_y) = target_id
                .as_ref()
                .and_then(|id| self.monsters.get(id))
                .map(|monster| {
                    (
                        monster.state.hp,
                        monster.state.max_hp,
                        monster.template.clone(),
                        monster.state.x,
                        monster.state.y,
                    )
                })
                .unwrap_or((
                    0,
                    0,
                    MonsterTemplate {
                        template_id: String::new(),
                        level: 0,
                        max_hp: 0,
                        max_mp: 0,
                        boss: false,
                        pa_damage: None,
                        pd_damage: None,
                        pd_rate: None,
                        md_rate: None,
                        exp: 0,
                        body_attack: false,
                        move_speed: None,
                        source_speed: None,
                        hitbox_width: None,
                        hitbox_height: None,
                        hitbox_lt: None,
                        hitbox_rb: None,
                        die_duration_ms: None,
                        stand_delay_ms: None,
                        move_duration_ms: None,
                        drop: None,
                        skills: Vec::new(),
                        body_disease: None,
                        body_disease_level: None,
                    },
                    player.state.x,
                    player.state.y,
                ));
            let mut target_template = target_template;
            if let Some(target_id) = target_id.as_ref() {
                let bind_pdr = self
                    .monsters
                    .get(target_id)
                    .filter(|monster| monster.bind_until > self.tick)
                    .map(|monster| monster.bind_pd_rate_reduction)
                    .unwrap_or(0)
                    .clamp(0, 100) as f64;
                if bind_pdr > 0.0 {
                    if let Some(rate) = target_template.pd_rate.as_mut() {
                        *rate = (*rate - bind_pdr).max(0.0);
                    }
                }
            }
            let mut damage = self
                .gameplay
                .player
                .with_ability_stats(
                    &player.state.ability_stats,
                    &player.state.equipped,
                    player.state.job,
                )
                .attack_damage_against(player.state.level, &target_template);
            if player
                .skill_buffs
                .get(&SKILL_INFINITY)
                .copied()
                .is_some_and(|remaining| remaining > 0)
            {
                damage = (damage as f64 * (100 + player.infinity_damage_bonus.max(0)) as f64
                    / 100.0)
                    .floor()
                    .max(1.0) as i64;
            }
            if let Some(level) = player
                .state
                .skills
                .get(&SKILL_MYSTIC_STRIKE)
                .copied()
                .and_then(|level| self.mage_skills.level(SKILL_MYSTIC_STRIKE, level))
            {
                let bonus = level
                    .x
                    .unwrap_or(0)
                    .max(0)
                    .saturating_mul(i64::from(player.mystic_strike_stacks));
                if bonus > 0 {
                    damage = (damage as f64 * (100 + bonus) as f64 / 100.0)
                        .floor()
                        .max(1.0) as i64;
                }
            }
            let hyper_adventurer_bonus = if player
                .skill_buffs
                .get(&SKILL_HYPER_ADVENTURER)
                .copied()
                .is_some_and(|remaining| remaining > 0)
            {
                player
                    .state
                    .skills
                    .get(&SKILL_HYPER_ADVENTURER)
                    .copied()
                    .and_then(|skill_level| {
                        self.mage_skills.level(SKILL_HYPER_ADVENTURER, skill_level)
                    })
                    .and_then(|level| level.indie_dam_r)
                    .unwrap_or(10)
                    .clamp(0, 100)
            } else {
                0
            };
            if hyper_adventurer_bonus > 0 {
                damage = (damage as f64 * (100 + hyper_adventurer_bonus) as f64 / 100.0)
                    .floor()
                    .max(1.0) as i64;
            }
            let guard_percent = self.boss_damage_multiplier(&map_id, false);
            damage = (damage as i128 * i128::from(guard_percent) / 100).max(1) as i64;
            let killed = target_id.is_some() && target_hp > 0 && damage >= target_hp;
            let applied_damage = target_id
                .is_some()
                .then_some(damage.min(target_hp.max(0)))
                .unwrap_or(0);
            let practice = auth::is_practice_map(&map_id);
            let drops = if killed && !practice {
                self.choose_drops(
                    &target_template,
                    target_x,
                    target_y,
                    &attack.player_id,
                    &quests,
                )
            } else {
                Vec::new()
            };
            let eligible_accounts: Vec<String> = self.players.keys().cloned().collect();
            let resolution = match self.store.as_ref() {
                Some(store) => store.resolve_attack_with_party(
                    &attack.player_id,
                    &map_id,
                    &attack.request_id,
                    target_id.as_deref(),
                    applied_damage,
                    killed,
                    target_template.exp,
                    max_hp,
                    &drops,
                    &self.gameplay.exp_table,
                    &eligible_accounts,
                    &self.party_exp_members(&attack.player_id),
                ),
                None => Ok(auth::AttackResolution {
                    already_resolved: false,
                    target_id: target_id.clone(),
                    damage: applied_damage,
                    killed,
                    exp_gain: if killed && !practice {
                        target_template.exp
                    } else {
                        0
                    },
                    drop: drops.first().cloned(),
                    drops,
                    profile: None,
                    profiles: Vec::new(),
                }),
            };
            let Ok(resolution) = resolution else {
                if let Some(player) = self.players.get(&attack.player_id) {
                    let _ = player.output.try_send(reject(
                        "persistence",
                        "Attack persistence failed; retry the action",
                        Some(&attack.request_id),
                    ));
                }
                let mut retry = attack;
                retry.hit_tick = self.tick + 1;
                self.pending_attacks.insert(retry.action_id.clone(), retry);
                continue;
            };
            if resolution.already_resolved {
                continue;
            }
            if resolution.damage > 0 {
                if let Some(target_id) = resolution.target_id.as_deref() {
                    self.advance_mystic_strike(&attack.player_id, &attack.request_id, target_id);
                }
            }
            if let Some(target_id) = resolution.target_id.as_deref() {
                if let Some(monster) = self.monsters.get_mut(target_id) {
                    if resolution.damage > 0 {
                        let contribution = monster
                            .damage_by_player
                            .entry(attack.player_id.clone())
                            .or_default();
                        *contribution = contribution.saturating_add(resolution.damage);
                        // A direct normal attack marks its author as hostile;
                        // see `step_monsters` for the pursuit resolution.
                        mark_monster_hit_aggro(monster, &attack.player_id, self.tick);
                    }
                    monster.state.hp = (monster.state.hp - resolution.damage).max(0);
                    monster.state.action = if monster.state.hp == 0 { "die" } else { "hit" };
                    monster.state.action_started_tick = self.tick;
                    if monster.state.hp == 0 {
                        monster.freeze_until = 0;
                        monster.state.freeze_stacks = None;
                        monster.stun_until = 0;
                        let die_ticks = monster
                            .template
                            .die_duration_ms
                            .unwrap_or(1)
                            .div_ceil(TICK_MS)
                            .max(1);
                        monster.death_until = Some(self.tick + die_ticks);
                        monster.respawn_at = respawn_deadline(
                            self.tick,
                            self.gameplay.monster_respawn_ms,
                            monster.spawn.mob_time,
                        );
                    }
                }
                if resolution.damage > 0 {
                    let damage_event = serde_json::json!({
                        "type": "damageEvent",
                        "eventId": format!("damage-event-{}", attack.action_id),
                        "serverTick": self.tick,
                        "attackerId": attack.player_id,
                        "targetId": target_id,
                        "x": target_x,
                        "y": target_y,
                        "damage": resolution.damage,
                        "killed": resolution.killed
                    })
                    .to_string();
                    self.broadcast_to_map(&map_id, &damage_event);
                }
            }
            if resolution.damage > 0 {
                if let Some(target_id) = resolution.target_id.as_deref() {
                    // A normal player attack is also a non-summon direct hit.
                    // The passive helper rechecks the live target and learned
                    // Blizzard level, so a lethal hit cannot proc on a dead mob
                    // and a replay cannot create a second hidden attack.
                    if let Err(error) = self.maybe_cast_blizzard_follow_up(
                        &attack.player_id,
                        &attack.request_id,
                        target_id,
                    ) {
                        self.handle_accepted_effect_error(
                            &attack.player_id,
                            &attack.request_id,
                            &error,
                        );
                    }
                }
            }
            if !resolution.profiles.is_empty() {
                for (participant, profile) in resolution.profiles {
                    if let Some(player) = self.players.get_mut(&participant) {
                        apply_profile_to_player(&self.gameplay, &self.mage_skills, player, profile);
                    }
                }
            } else if let Some(profile) = resolution.profile {
                if let Some(player) = self.players.get_mut(&attack.player_id) {
                    apply_profile_to_player(&self.gameplay, &self.mage_skills, player, profile);
                }
            } else if resolution.exp_gain > 0 && self.store.is_none() {
                if let Some(player) = self.players.get_mut(&attack.player_id) {
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
                self.drop_maps.insert(drop_id.clone(), map_id.clone());
            }
        }
    }

    pub(super) fn nearest_attack_target(&self, player: &Player) -> Option<String> {
        let (local_left, local_right, local_top, local_bottom) =
            self.gameplay.player.attack_bounds(player.state.facing)?;
        let attack_left = player.state.x + local_left;
        let attack_right = player.state.x + local_right;
        let attack_top = player.state.y + local_top;
        let attack_bottom = player.state.y + local_bottom;
        self.monsters
            .iter()
            .filter_map(|(id, monster)| {
                if monster.map_id != player.map_id || monster.state.hp <= 0 {
                    return None;
                }
                let (mob_left, mob_right, mob_top, mob_bottom) = monster
                    .template
                    .body_bounds(monster.state.x, monster.state.y)?;
                let overlaps = attack_left <= mob_right
                    && attack_right >= mob_left
                    && attack_top <= mob_bottom
                    && attack_bottom >= mob_top;
                overlaps.then_some((id, monster))
            })
            .min_by(|(a_id, a), (b_id, b)| {
                (a.state.x - player.state.x)
                    .abs()
                    .total_cmp(&(b.state.x - player.state.x).abs())
                    .then_with(|| a_id.cmp(b_id))
            })
            .map(|(id, _)| id.clone())
    }
}
