//! 角色成长命令：能力值分配、技能学习与超技重置。
//!
//! 负责：AP 分配（`handle_allocate_ap` / `local_allocate_ap`）、技能学习
//! （`handle_learn_skill` / `local_learn_skill`）、超技重置（`handle_reset_hyper` / `local_reset_hyper`）
//! 与对应回执（`send_ability_result` / `send_skill_result_with_request`）。
//! 不负责：技能施法管线（`skills.rs` / `elemental.rs`）、SP 规则的存档事务（`auth` 的 Store）。

use super::*;

impl World {
    pub(super) fn handle_allocate_ap(&mut self, id: String, request_id: String, stat: AbilityStat) {
        let Some(player) = self.players.get(&id) else {
            return;
        };
        if player.state.hp <= 0 || player.state.action == "dead" {
            self.send_reject(
                &id,
                "invalid_state",
                "死亡角色不能加点。",
                Some(&request_id),
            );
            return;
        }
        let outcome = match self.store.as_ref() {
            Some(store) => match store.allocate_ap(&id, &request_id, stat) {
                Ok(outcome) => outcome,
                Err(error) => {
                    self.send_reject(&id, "persistence", &error, Some(&request_id));
                    return;
                }
            },
            None => self.local_allocate_ap(&id, &request_id, stat),
        };
        if outcome.success && !outcome.already_resolved {
            if let Some(player) = self.players.get_mut(&id) {
                player.state.ability_stats = outcome.stats.clone();
                refresh_player_derived(&self.gameplay, &self.mage_skills, player);
            }
            if let Err(error) = self.persist_player(&id) {
                self.send_reject(&id, "persistence", &error, Some(&request_id));
                return;
            }
        }
        self.send_ability_result(&id, &request_id, &outcome);
        self.send_snapshot(&id);
    }

    pub(super) fn local_allocate_ap(
        &mut self,
        id: &str,
        request_id: &str,
        stat: AbilityStat,
    ) -> auth::AbilityActionOutcome {
        if let Some(prior) = self
            .ability_requests
            .get(&(id.to_owned(), request_id.to_owned()))
            .cloned()
        {
            let (prior_stat, prior) = prior;
            return auth::AbilityActionOutcome {
                success: prior.success && prior_stat == stat,
                code: if prior_stat == stat {
                    prior.code
                } else {
                    "request_conflict".into()
                },
                stats: prior.stats,
                already_resolved: true,
            };
        }
        let Some(player) = self.players.get_mut(id) else {
            return auth::AbilityActionOutcome {
                success: false,
                code: "player_unknown".into(),
                stats: AbilityStats::default(),
                already_resolved: false,
            };
        };
        let mut stats = player.state.ability_stats.clone();
        let success = stats.add_point(stat);
        let outcome = auth::AbilityActionOutcome {
            success,
            code: if success {
                String::new()
            } else {
                "not_enough_ap".into()
            },
            stats: if success {
                stats.clone()
            } else {
                player.state.ability_stats.clone()
            },
            already_resolved: false,
        };
        if success {
            player.state.ability_stats = stats;
            refresh_player_derived(&self.gameplay, &self.mage_skills, player);
        }
        self.ability_requests.insert(
            (id.to_owned(), request_id.to_owned()),
            (stat, outcome.clone()),
        );
        outcome
    }

    pub(super) fn send_ability_result(
        &self,
        id: &str,
        request_id: &str,
        outcome: &auth::AbilityActionOutcome,
    ) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let _ = player.output.try_send(
            serde_json::json!({
                "type": "abilityResult",
                "requestId": request_id,
                "success": outcome.success,
                "code": outcome.code,
                "abilityStats": outcome.stats,
            })
            .to_string(),
        );
    }

    pub(super) fn handle_reset_hyper(&mut self, id: String, request_id: String, expected_cost: u64) {
        let store_prior = if let Some(store) = self.store.as_ref() {
            match store.prior_skill_action(&id, &request_id, "hyper_reset", 0) {
                Ok(prior) => prior,
                Err(error) => {
                    self.send_reject(&id, "persistence", &error, Some(&request_id));
                    return;
                }
            }
        } else {
            None
        };
        if self.store.is_none() {
            if let Some(prior) = self
                .skill_requests
                .get(&(id.clone(), request_id.clone()))
                .cloned()
            {
                let quoted = self
                    .hyper_reset_quotes
                    .get(&(id.clone(), request_id.clone()))
                    .copied();
                let mut outcome = prior;
                outcome.already_resolved = true;
                if outcome.operation != "hyper_reset"
                    || outcome.skill_id != 0
                    || quoted != Some(expected_cost)
                {
                    outcome.success = false;
                    outcome.code = "request_conflict".to_owned();
                }
                self.send_skill_result_with_request(&id, &request_id, &outcome);
                return;
            }
        }
        if store_prior.is_none()
            && self
                .players
                .get(&id)
                .is_none_or(|player| player.state.hp <= 0)
        {
            self.send_reject(
                &id,
                "invalid_state",
                "当前状态不能重置Hyper技能。",
                Some(&request_id),
            );
            return;
        }
        let outcome = match self.store.as_ref() {
            Some(store) => store.reset_hyper_skills(&id, &request_id, expected_cost),
            None => Ok(self.local_reset_hyper(&id, &request_id, expected_cost)),
        };
        let Ok(outcome) = outcome else {
            self.send_reject(
                &id,
                "persistence",
                "Hyper重置保存失败，请重试。",
                Some(&request_id),
            );
            return;
        };
        if outcome.already_resolved {
            self.send_skill_result_with_request(&id, &request_id, &outcome);
            return;
        }
        if !outcome.success {
            self.send_skill_result_with_request(&id, &request_id, &outcome);
            return;
        }
        let next_reset_count = self
            .store
            .as_ref()
            .and_then(|store| store.hyper_reset_count(&id).ok());
        if let Some(player) = self.players.get_mut(&id) {
            player
                .state
                .skills
                .retain(|skill_id, _| !is_hyper_skill(*skill_id));
            player.state.mesos = player.state.mesos.saturating_sub(expected_cost);
            player.hyper_reset_count = next_reset_count
                .unwrap_or_else(|| player.hyper_reset_count.saturating_add(1).min(4));
            player.state.hyper_reset_count = player.hyper_reset_count;
            player.state.hyper_reset_cost = auth::hyper_reset_cost(player.hyper_reset_count);
            player.state.hyper_points =
                hyper_points_for_state(player.state.level, &player.state.skills);
            clear_hyper_runtime(player);
            refresh_player_derived(&self.gameplay, &self.mage_skills, player);
        }
        self.send_skill_result_with_request(&id, &request_id, &outcome);
        self.send_snapshot(&id);
    }

    pub(super) fn local_reset_hyper(
        &mut self,
        id: &str,
        request_id: &str,
        expected_cost: u64,
    ) -> auth::SkillActionOutcome {
        if let Some(prior) = self
            .skill_requests
            .get(&(id.to_owned(), request_id.to_owned()))
        {
            let mut prior = prior.clone();
            prior.already_resolved = true;
            return prior;
        }
        let Some(player) = self.players.get_mut(id) else {
            return auth::SkillActionOutcome {
                operation: "hyper_reset".into(),
                skill_id: 0,
                success: false,
                code: "player_unknown".into(),
                level: 0,
                remaining_sp: 0,
                mp: 0,
                already_resolved: false,
            };
        };
        let current = auth::hyper_reset_cost(player.hyper_reset_count);
        let success =
            player.state.hp > 0 && expected_cost == current && player.state.mesos >= expected_cost;
        let outcome = auth::SkillActionOutcome {
            operation: "hyper_reset".into(),
            skill_id: 0,
            success,
            code: if success {
                String::new()
            } else {
                "invalid_state".into()
            },
            level: 0,
            remaining_sp: auth::hyper_points(player.state.level, &player.state.skills, 1),
            mp: player.state.mp,
            already_resolved: false,
        };
        self.hyper_reset_quotes
            .insert((id.to_owned(), request_id.to_owned()), expected_cost);
        self.skill_requests
            .insert((id.to_owned(), request_id.to_owned()), outcome.clone());
        outcome
    }

    pub(super) fn handle_learn_skill(&mut self, id: String, request_id: String, skill_id: u32) {
        if let Some(store) = self.store.as_ref() {
            match store.prior_skill_action(&id, &request_id, "learn", skill_id) {
                Ok(Some(outcome)) => {
                    self.send_skill_result_with_request(&id, &request_id, &outcome);
                    return;
                }
                Ok(None) => {}
                Err(error) => {
                    self.send_reject(&id, "persistence", &error, Some(&request_id));
                    return;
                }
            }
        } else if let Some(prior) = self
            .skill_requests
            .get(&(id.clone(), request_id.clone()))
            .cloned()
        {
            let mut outcome = prior;
            outcome.already_resolved = true;
            if outcome.operation != "learn" || outcome.skill_id != skill_id {
                outcome.success = false;
                outcome.code = "request_conflict".to_owned();
            }
            self.send_skill_result_with_request(&id, &request_id, &outcome);
            return;
        }
        let Some(skill) = self.mage_skills.get(skill_id).cloned() else {
            self.send_reject(&id, "skill_unknown", "未知法师技能。", Some(&request_id));
            return;
        };
        if skill.hidden {
            self.send_reject(
                &id,
                "skill_hidden",
                "该技能由职业规则自动启用。",
                Some(&request_id),
            );
            return;
        }
        if skill.fixed_level {
            self.send_reject(
                &id,
                "skill_fixed_level",
                "该技能由职业规则固定启用。",
                Some(&request_id),
            );
            return;
        }
        let Some(player) = self.players.get(&id) else {
            return;
        };
        if !skill_job_allowed(player.state.job, skill.book_id) {
            self.send_reject(
                &id,
                "wrong_job",
                "当前职业不能学习法师技能。",
                Some(&request_id),
            );
            return;
        }
        if skill.hyper > 0 {
            let kind = skill.hyper;
            if player.state.level < skill.required_level {
                self.send_reject(
                    &id,
                    "level_requirement",
                    "尚未达到Hyper技能等级要求。",
                    Some(&request_id),
                );
                return;
            }
            if auth::hyper_points(player.state.level, &player.state.skills, kind) == 0 {
                self.send_reject(
                    &id,
                    "not_enough_hyper_points",
                    "没有可用的Hyper点数。",
                    Some(&request_id),
                );
                return;
            }
        }
        let prerequisites = skill
            .prerequisites
            .iter()
            .filter_map(|(id, level)| id.parse::<u32>().ok().map(|id| (id, *level)))
            .collect::<BTreeMap<_, _>>();
        let outcome = match self.store.as_ref() {
            Some(store) => store.learn_skill(
                &id,
                &request_id,
                skill_id,
                skill.book_id,
                skill.book_id,
                skill.max_level,
                &prerequisites,
                false,
            ),
            None => Ok(self.local_learn_skill(
                &id,
                &request_id,
                skill_id,
                skill.book_id,
                skill.max_level,
                &prerequisites,
            )),
        };
        let Ok(outcome) = outcome else {
            self.send_reject(
                &id,
                "persistence",
                "技能学习保存失败，请重试。",
                Some(&request_id),
            );
            return;
        };
        if outcome.success && !outcome.already_resolved {
            if let Some(player) = self.players.get_mut(&id) {
                player.state.skills.insert(skill_id, outcome.level);
                player
                    .state
                    .skill_points
                    .insert(skill.book_id, outcome.remaining_sp);
                refresh_player_derived(&self.gameplay, &self.mage_skills, player);
            }
        }
        self.send_skill_result_with_request(&id, &request_id, &outcome);
        if outcome.success && skill.hyper > 0 {
            self.send_snapshot(&id);
        }
    }

    pub(super) fn local_learn_skill(
        &mut self,
        id: &str,
        request_id: &str,
        skill_id: u32,
        book_id: u32,
        max_level: u32,
        prerequisites: &BTreeMap<u32, u32>,
    ) -> auth::SkillActionOutcome {
        if let Some(prior) = self
            .skill_requests
            .get(&(id.to_owned(), request_id.to_owned()))
        {
            let mut prior = prior.clone();
            prior.already_resolved = true;
            if prior.operation != "learn" || prior.skill_id != skill_id {
                prior.success = false;
                prior.code = "request_conflict".into();
            }
            return prior;
        }
        let Some(player) = self.players.get_mut(id) else {
            return auth::SkillActionOutcome {
                operation: "learn".into(),
                skill_id,
                success: false,
                code: "player_unknown".into(),
                level: 0,
                remaining_sp: 0,
                mp: 0,
                already_resolved: false,
            };
        };
        let current = player.state.skills.get(&skill_id).copied().unwrap_or(0);
        let mut outcome = auth::SkillActionOutcome {
            operation: "learn".into(),
            skill_id,
            success: false,
            code: String::new(),
            level: current,
            remaining_sp: player
                .state
                .skill_points
                .get(&book_id)
                .copied()
                .unwrap_or(0),
            mp: player.state.mp,
            already_resolved: false,
        };
        if current >= max_level {
            outcome.code = "max_level".into();
        } else if prerequisites
            .iter()
            .any(|(id, required)| player.state.skills.get(id).copied().unwrap_or(0) < *required)
        {
            outcome.code = "prerequisite".into();
        } else if hyper_skill_kind(skill_id).is_none() && outcome.remaining_sp == 0 {
            outcome.code = "not_enough_sp".into();
        } else {
            outcome.success = true;
            outcome.level = current + 1;
            if hyper_skill_kind(skill_id).is_none() {
                outcome.remaining_sp -= 1;
            }
            player.state.skills.insert(skill_id, outcome.level);
            if hyper_skill_kind(skill_id).is_none() {
                player
                    .state
                    .skill_points
                    .insert(book_id, outcome.remaining_sp);
            }
            player.state.hyper_points =
                hyper_points_for_state(player.state.level, &player.state.skills);
        }
        self.skill_requests
            .insert((id.to_owned(), request_id.to_owned()), outcome.clone());
        outcome
    }

    pub(super) fn send_skill_result_with_request(
        &self,
        id: &str,
        request_id: &str,
        outcome: &auth::SkillActionOutcome,
    ) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let _ = player.output.try_send(
            serde_json::json!({
                "type": "skillResult",
                "requestId": request_id,
                "skillId": outcome.skill_id,
                "operation": outcome.operation,
                "success": outcome.success,
                "code": outcome.code,
                "level": outcome.level,
                "skillPoints": outcome.remaining_sp,
                "mp": outcome.mp,
            })
            .to_string(),
        );
    }

}
