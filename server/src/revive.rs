//! 死亡复活命令。
//!
//! 负责：复活请求（`handle_revive`，death_id 绑定与幂等）、复活落点与状态恢复
//! （`complete_revive`）与回执下发（`send_revive_outcome`）。
//! 不负责：死亡判定与经验惩罚（`combat.rs`）、复活后的地图广播（由 warp/switchMap 流程接手）。

use super::*;

impl World {
    pub(super) fn handle_revive(&mut self, id: String, request_id: String) {
        if self.players.get(&id).is_some_and(|player| {
            auth::is_practice_map(&player.map_id) && player.state.action == "dead"
        }) {
            // Resolve the private encounter before applying the normal revive
            // transaction, so a revived player cannot remain in a deleted
            // practice map or revive a Boss state that was already failed.
            if !self.finish_boss_practice(&id, Some(boss::BossPracticeStatus::Failed), true, true) {
                self.send_reject(
                    &id,
                    "persistence",
                    "练习结果尚未保存，请稍后重试。",
                    Some(&request_id),
                );
                return;
            }
        }
        // Check a persisted request first.  A response from an earlier death
        // must never revive a later death that happens to reuse the same
        // client request id.
        let death_id = self
            .players
            .get(&id)
            .map(|player| player.death_id.clone())
            .unwrap_or_default();
        let dead = self
            .players
            .get(&id)
            .is_some_and(|player| player.state.action == "dead");

        if let Some(store) = self.store.as_ref() {
            match store.prior_revive(&id, &request_id) {
                Ok(Some(prior)) => {
                    if prior.success && dead && prior.death_id == death_id {
                        self.complete_revive(&id, &death_id);
                        self.send_revive_outcome(&id, prior);
                    } else if prior.success && dead && prior.death_id != death_id {
                        self.send_revive_outcome(
                            &id,
                            auth::ReviveOutcome {
                                request_id,
                                death_id,
                                success: false,
                                code: "revive_stale".to_owned(),
                            },
                        );
                    } else {
                        // A successful replay after the same death has
                        // already completed is still the original idempotent
                        // result.  Only a currently-dead later death is
                        // stale; an alive player has no new state to mutate.
                        self.send_revive_outcome(&id, prior);
                    }
                    return;
                }
                Ok(None) => {}
                Err(error) => {
                    if let Some(player) = self.players.get(&id) {
                        let _ = player.output.try_send(reject(
                            "persistence",
                            &error,
                            Some(&request_id),
                        ));
                    }
                    return;
                }
            }
            if !dead || death_id.is_empty() {
                if let Some(player) = self.players.get(&id) {
                    let _ = player.output.try_send(reject(
                        "invalid_state",
                        "Cannot revive while alive",
                        Some(&request_id),
                    ));
                }
                return;
            }
            match store.revive(&id, &request_id, &death_id) {
                Ok(outcome) => {
                    if outcome.success {
                        self.complete_revive(&id, &death_id);
                    }
                    self.send_revive_outcome(&id, outcome);
                }
                Err(error) => {
                    if let Some(player) = self.players.get(&id) {
                        let _ = player.output.try_send(reject(
                            "persistence",
                            &error,
                            Some(&request_id),
                        ));
                    }
                }
            }
            return;
        }

        if let Some(prior) = self
            .revive_requests
            .get(&(id.clone(), request_id.clone()))
            .cloned()
        {
            if prior.success && dead && prior.death_id == death_id {
                self.complete_revive(&id, &death_id);
                self.send_revive_outcome(&id, prior);
            } else if prior.success && dead && prior.death_id != death_id {
                self.send_revive_outcome(
                    &id,
                    auth::ReviveOutcome {
                        request_id,
                        death_id,
                        success: false,
                        code: "revive_stale".to_owned(),
                    },
                );
            } else {
                // See the persisted branch above: replaying a completed
                // request while alive returns its original result.
                self.send_revive_outcome(&id, prior);
            }
            return;
        }
        if !dead || death_id.is_empty() {
            if let Some(player) = self.players.get(&id) {
                let _ = player.output.try_send(reject(
                    "invalid_state",
                    "Cannot revive while alive",
                    Some(&request_id),
                ));
            }
            return;
        }
        let outcome = auth::ReviveOutcome {
            request_id: request_id.clone(),
            death_id: death_id.clone(),
            success: true,
            code: String::new(),
        };
        self.revive_requests
            .insert((id.clone(), request_id), outcome.clone());
        self.complete_revive(&id, &death_id);
        self.send_revive_outcome(&id, outcome);
    }

    pub(super) fn complete_revive(&mut self, id: &str, death_id: &str) {
        let Some(map_id) = self.players.get(id).map(|player| player.map_id.clone()) else {
            return;
        };
        let map = self.map_for(&map_id).clone();
        let Some(player) = self.players.get_mut(id) else {
            return;
        };
        if player.state.action != "dead" || player.death_id != death_id {
            return;
        }
        player.state.hp = 50_i64.min(player.state.max_hp.max(1));
        // Cosmic's ordinary respawn restores HP while leaving MP untouched.
        player.state.x = map.spawn.x;
        player.state.y = map.spawn.y;
        player.state.vx = 0.0;
        player.state.vy = 0.0;
        player.state.grounded = false;
        player.state.ladder_id = None;
        player.state.climbing = false;
        player.state.action_id = None;
        player.state.action = "stand";
        player.state.action_started_tick = self.tick;
        player.swimming = false;
        player.death_id.clear();
        player.natural_recovery_next_tick =
            self.tick.saturating_add(NATURAL_RECOVERY_INTERVAL_TICKS);
        player.attack_until = 0;
        player.magic_wave_used = false;
        player.magic_wave_float_used = false;
        player.slow_fall_until = 0;
        player.meditation_until = 0;
        player.meditation_mad = 0;
        clear_beginner_buffs(player);
        player.ice_teleport_enabled = false;
        player.ice_fields.clear();
        player.teleport_mastery_enabled = false;
        player.teleport_boost_enabled = false;
        player.adaptation_active = false;
        player.adaptation_charges = 0;
        player.summon = None;
        refresh_player_derived(&self.gameplay, &self.mage_skills, player);
        player.contact_invulnerable_until = 0;
        player.direction = 0;
        player.vertical = 0;
        player.jump = false;
        player.foothold_id = map
            .ground_near(map.spawn.x, map.spawn.y)
            .map_or(0, |(foothold_id, _)| foothold_id);
        player.last_foothold_id = player.foothold_id;
        player.fall_boundary_hold = false;
        player.drop_fh = 0;
        let _ = self.persist_player(id);
    }

    pub(super) fn send_revive_outcome(&self, id: &str, outcome: auth::ReviveOutcome) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let message = serde_json::json!({
            "type":"reviveResult",
            "requestId":outcome.request_id,
            "success":outcome.success,
            "code":outcome.code
        })
        .to_string();
        let _ = player.output.try_send(message);
    }


}
