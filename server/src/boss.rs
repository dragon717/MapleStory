use super::*;
use crate::protocol::BossPracticeAction;

pub(super) const BOSS_PRACTICE_SOURCE_MAP: &str = "102020500";
const BOSS_PRACTICE_BOSS_ID: &str = "3220000";
const BOSS_PRACTICE_MIN_LEVEL: u32 = 25;
const BOSS_HP: i64 = 7_500;
const BOSS_PAD: i64 = 90;
const BOSS_MAD: i64 = 85;
const BOSS_ATTACK_DURATION_TICKS: u64 = 3_420_u64.div_ceil(TICK_MS);
const BOSS_ATTACK1_EFFECT_TICKS: u64 = 1_500_u64.div_ceil(TICK_MS);
const BOSS_ATTACK2_EFFECT_TICKS: u64 = 1_320_u64.div_ceil(TICK_MS);
const BOSS_SKILL_DURATION_TICKS: u64 = 2_700_u64.div_ceil(TICK_MS);
const BOSS_GUARD_TICKS: u64 = 30_000_u64.div_ceil(TICK_MS);
const BOSS_GUARD_COOLDOWN_TICKS: u64 = 10_000_u64.div_ceil(TICK_MS);
const BOSS_HEAL_COOLDOWN_TICKS: u64 = 30_000_u64.div_ceil(TICK_MS);
const BOSS_HEAL_HP: i64 = 700;
const BOSS_HEAL_THRESHOLD_PERCENT: i64 = 80;
const BOSS_ACTION_GAP_TICKS: u64 = 20;
const BOSS_HEAL_EFFECT_TICKS: u64 = 2_060_u64.div_ceil(TICK_MS);

#[derive(Clone)]
pub(super) struct BossRequestRecord {
    pub(super) action: BossPracticeAction,
    pub(super) encounter_id: Option<String>,
    pub(super) sequence: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum BossPracticeStatus {
    Cleared,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BossAction {
    Attack1,
    Attack2,
    PhysicalGuard,
    MagicGuard,
    Heal,
}

impl BossAction {
    fn wire_action(self) -> &'static str {
        match self {
            Self::Attack1 => "attack1",
            Self::Attack2 => "attack2",
            Self::PhysicalGuard | Self::MagicGuard | Self::Heal => "skill1",
        }
    }

    fn phase_label(self) -> &'static str {
        match self {
            Self::Attack1 => "樹妖王正在准备近身攻击",
            Self::Attack2 => "樹妖王正在准备范围攻击",
            Self::PhysicalGuard => "樹妖王发动物理防御强化",
            Self::MagicGuard => "樹妖王发动魔法防御强化",
            Self::Heal => "樹妖王正在恢复生命",
        }
    }

    fn duration_ticks(self) -> u64 {
        match self {
            Self::Attack1 | Self::Attack2 => BOSS_ATTACK_DURATION_TICKS.max(1),
            Self::PhysicalGuard | Self::MagicGuard | Self::Heal => BOSS_SKILL_DURATION_TICKS.max(1),
        }
    }

    fn effect_after_ticks(self) -> u64 {
        match self {
            Self::Attack1 => BOSS_ATTACK1_EFFECT_TICKS,
            Self::Attack2 => BOSS_ATTACK2_EFFECT_TICKS,
            // MobSkill 112/114 preserve source effectAfter=1500; 113 keeps
            // source effectAfter=0.  The action itself is still the exported
            // skill1 timeline, not an invented player animation.
            Self::PhysicalGuard | Self::Heal => 1_500_u64.div_ceil(TICK_MS),
            Self::MagicGuard => 0,
        }
    }
}

#[derive(Clone)]
pub(super) struct BossPractice {
    pub(super) source_map_id: String,
    pub(super) instance_map_id: String,
    pub(super) monster_id: String,
    pub(super) status: Option<BossPracticeStatus>,
    return_x: f64,
    return_y: f64,
    action: Option<BossAction>,
    action_started_tick: u64,
    action_until: u64,
    action_effect_at: u64,
    action_applied: bool,
    next_action_at: u64,
    action_sequence: u64,
    physical_guard_until: u64,
    magic_guard_until: u64,
    physical_guard_started_at: u64,
    magic_guard_started_at: u64,
    heal_effect_until: u64,
    heal_effect_started_at: u64,
    physical_guard_ready_at: u64,
    magic_guard_ready_at: u64,
    heal_ready_at: u64,
}

impl World {
    pub(super) fn handle_boss_practice(
        &mut self,
        id: String,
        request_id: String,
        action: BossPracticeAction,
        encounter_id: Option<String>,
    ) {
        let request_key = (id.clone(), request_id.clone());
        if let Some(prior) = self.boss_requests.get(&request_key).cloned() {
            if prior.action == action && prior.encounter_id == encounter_id {
                // A replay is an observation, never a second enter/leave or
                // retry.  The current snapshot also carries the current
                // encounter id, so the client can converge after reconnect.
                self.send_snapshot(&id);
            } else {
                self.send_reject(
                    &id,
                    "request_conflict",
                    "练习请求编号已用于另一场次或操作。",
                    Some(&request_id),
                );
            }
            return;
        }
        if !matches!(action, BossPracticeAction::Enter) {
            let current_encounter = self
                .boss_practices
                .get(&id)
                .map(|practice| practice.instance_map_id.as_str());
            if encounter_id.as_deref() != current_encounter {
                self.send_reject(
                    &id,
                    "boss_practice_encounter",
                    "练习场次已变化，请刷新后重试。",
                    Some(&request_id),
                );
                return;
            }
        }
        let result = match action {
            BossPracticeAction::Enter => self.start_boss_practice(&id, false),
            BossPracticeAction::Retry => self.retry_boss_practice(&id),
            BossPracticeAction::Leave => self.leave_boss_practice(&id),
        };
        if let Err((code, message)) = result {
            self.send_reject(&id, code, message, Some(&request_id));
            return;
        }
        self.boss_request_sequence = self.boss_request_sequence.saturating_add(1);
        self.boss_requests.insert(
            request_key,
            BossRequestRecord {
                action,
                encounter_id,
                sequence: self.boss_request_sequence,
            },
        );
        while self.boss_requests.len() > 256 {
            let Some(oldest) = self
                .boss_requests
                .iter()
                .min_by_key(|(_, record)| record.sequence)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.boss_requests.remove(&oldest);
        }
        self.send_snapshot(&id);
    }

    fn start_boss_practice(
        &mut self,
        id: &str,
        retry: bool,
    ) -> Result<(), (&'static str, &'static str)> {
        let Some(player_snapshot) = self.players.get(id).map(|player| {
            (
                player.map_id.clone(),
                player.state.hp,
                player.state.action,
                player.state.level,
                player.state.x,
                player.state.y,
            )
        }) else {
            return Err(("player_unknown", "角色不存在。"));
        };
        let (map_id, hp, action, level, return_x, return_y) = player_snapshot;
        if map_id != BOSS_PRACTICE_SOURCE_MAP {
            return Err(("boss_practice_map", "请先到102020500再进入练习。"));
        }
        if hp <= 0 || action == "dead" {
            return Err(("boss_practice_dead", "死亡角色不能进入练习。"));
        }
        if level < BOSS_PRACTICE_MIN_LEVEL {
            return Err(("boss_practice_level", "练习需要等级25。"));
        }
        if let Some(practice) = self.boss_practices.get(id) {
            if practice.status.is_none() {
                return Err(("boss_practice_active", "练习已经进行中。"));
            }
            if !retry && practice.status.is_some() {
                // Enter starts a fresh encounter after an explicit leave or a
                // previous result; stale instance rows are removed below.
            }
        } else if retry {
            return Err(("boss_practice_retry", "当前没有可重试的练习。"));
        }
        if retry
            && self
                .boss_practices
                .get(id)
                .and_then(|practice| practice.status)
                .is_none()
        {
            return Err(("boss_practice_retry", "当前练习仍在进行中。"));
        }

        let Some(source_map) = self.maps.get(BOSS_PRACTICE_SOURCE_MAP).cloned() else {
            return Err(("boss_practice_unavailable", "练习地图尚未加载。"));
        };
        let Some(template) = self
            .gameplay
            .monsters
            .iter()
            .find(|template| template.template_id == BOSS_PRACTICE_BOSS_ID)
        else {
            return Err(("boss_practice_unavailable", "练习Boss资源尚未加载。"));
        };
        if !template.boss || template.max_hp != BOSS_HP {
            return Err(("boss_practice_unavailable", "练习Boss源数据无效。"));
        }
        let Some((boss_foothold_id, boss_x, boss_y, player_foothold_id, player_x, player_y)) =
            practice_start_positions(&source_map)
        else {
            return Err(("boss_practice_unavailable", "练习出生点没有合法地面。"));
        };

        if let Some(old) = self.boss_practices.remove(id) {
            self.remove_practice_entities(&old.instance_map_id);
        }
        let encounter_id = auth::random_id();
        let instance_map_id = format!("practice:{BOSS_PRACTICE_SOURCE_MAP}:{encounter_id}");
        let mut instance_map = source_map;
        instance_map.id = instance_map_id.clone();
        // The private copy intentionally has no portals.  Leaving is an
        // explicit BossPractice command, so normal map portals cannot leak a
        // second player or a destination into this encounter.
        instance_map.portals.clear();
        self.maps.insert(instance_map_id.clone(), instance_map);
        let spawn = MonsterSpawn {
            id: format!("practice-boss-{encounter_id}"),
            template_id: BOSS_PRACTICE_BOSS_ID.to_owned(),
            x: boss_x,
            y: boss_y,
            foothold_id: Some(boss_foothold_id),
            map_id: instance_map_id.clone(),
            facing: 1,
            mob_time: -1,
            rx0: None,
            rx1: None,
        };
        if let Err(_) = self.spawn_monster_on_map(instance_map_id.clone(), spawn.clone()) {
            self.maps.remove(&instance_map_id);
            return Err(("boss_practice_unavailable", "练习Boss无法生成。"));
        }
        let Some(monster_id) = self
            .monsters
            .values()
            .find(|monster| monster.map_id == instance_map_id && monster.spawn.id == spawn.id)
            .map(|monster| monster.state.id.clone())
        else {
            self.maps.remove(&instance_map_id);
            return Err(("boss_practice_unavailable", "练习Boss生成结果无效。"));
        };
        if let Some(monster) = self.monsters.get_mut(&monster_id) {
            // The practice AI owns this private Boss timeline; do not let a
            // source movement flag make the initial snapshot look like the
            // Boss is drifting before its first telegraph.
            monster.state.action = "stand";
            monster.state.action_started_tick = self.tick;
            monster.horizontal_speed = 0.0;
        }
        let practice = BossPractice {
            source_map_id: BOSS_PRACTICE_SOURCE_MAP.to_owned(),
            instance_map_id: instance_map_id.clone(),
            monster_id,
            status: None,
            return_x,
            return_y,
            action: None,
            action_started_tick: self.tick,
            action_until: self.tick,
            action_effect_at: self.tick,
            action_applied: false,
            next_action_at: self.tick.saturating_add(BOSS_ACTION_GAP_TICKS),
            action_sequence: 0,
            physical_guard_until: 0,
            magic_guard_until: 0,
            physical_guard_started_at: 0,
            magic_guard_started_at: 0,
            heal_effect_until: 0,
            heal_effect_started_at: 0,
            physical_guard_ready_at: 0,
            magic_guard_ready_at: 0,
            heal_ready_at: 0,
        };
        self.boss_practices.insert(id.to_owned(), practice);
        self.pending_attacks
            .retain(|_, attack| attack.player_id != id);
        self.move_player_into_practice(
            id,
            &instance_map_id,
            player_foothold_id,
            player_x,
            player_y,
        );
        Ok(())
    }

    fn retry_boss_practice(&mut self, id: &str) -> Result<(), (&'static str, &'static str)> {
        let Some(practice) = self.boss_practices.get(id) else {
            return Err(("boss_practice_retry", "当前没有失败的练习。"));
        };
        if practice.status != Some(BossPracticeStatus::Failed) {
            return Err(("boss_practice_retry", "当前练习不能重试。"));
        }
        self.start_boss_practice(id, true)
    }

    fn leave_boss_practice(&mut self, id: &str) -> Result<(), (&'static str, &'static str)> {
        if !self.boss_practices.contains_key(id) {
            return Err(("boss_practice_leave", "当前没有进行中的练习。"));
        }
        if self.finish_boss_practice(id, None, true, true) {
            Ok(())
        } else {
            Err(("persistence", "练习返回位置保存失败，请稍后重试。"))
        }
    }

    fn move_player_into_practice(
        &mut self,
        id: &str,
        instance_map_id: &str,
        foothold_id: u64,
        x: f64,
        y: f64,
    ) {
        let map = self.map_for(instance_map_id).clone();
        let Some(player) = self.players.get_mut(id) else {
            return;
        };
        clear_practice_player_effects(player);
        player.map_id = instance_map_id.to_owned();
        player.state.x = x.clamp(map.bounds.x_min, map.bounds.x_max);
        player.state.y = y;
        player.state.grounded = true;
        player.state.vx = 0.0;
        player.state.vy = 0.0;
        player.foothold_id = foothold_id;
        player.last_foothold_id = foothold_id;
        player.state.action = "stand";
        player.state.action_started_tick = self.tick;
        refresh_player_derived(&self.gameplay, &self.mage_skills, player);
    }

    fn remove_practice_entities(&mut self, instance_map_id: &str) {
        self.monsters
            .retain(|_, monster| monster.map_id != instance_map_id);
        let drop_ids: Vec<String> = self
            .drop_maps
            .iter()
            .filter(|(_, map)| map.as_str() == instance_map_id)
            .map(|(drop_id, _)| drop_id.clone())
            .collect();
        for drop_id in drop_ids {
            self.drops.remove(&drop_id);
            self.drop_instances.remove(&drop_id);
            self.drop_owners.remove(&drop_id);
            self.drop_maps.remove(&drop_id);
        }
        // A stale sidecar without a DropState must never survive instance
        // teardown and later become visible on an authored map.
        self.drop_instances
            .retain(|drop_id, _| self.drops.contains_key(drop_id));
        self.drop_owners
            .retain(|drop_id, _| self.drops.contains_key(drop_id));
        self.drop_maps
            .retain(|drop_id, _| self.drops.contains_key(drop_id));
        self.maps.remove(instance_map_id);
    }

    /// Finish, clear, or disconnect an encounter.  `status=None` means an
    /// explicit leave/disconnect and removes the status row entirely; a result
    /// status remains only while the player is back on the real source map.
    pub(super) fn finish_boss_practice(
        &mut self,
        id: &str,
        status: Option<BossPracticeStatus>,
        notify: bool,
        persist: bool,
    ) -> bool {
        let Some(practice) = self.boss_practices.get(id).cloned() else {
            return false;
        };
        let map_is_instance = self
            .players
            .get(id)
            .is_some_and(|player| player.map_id == practice.instance_map_id);
        let candidate = if map_is_instance {
            self.players
                .get(id)
                .and_then(|player| self.practice_return_candidate(player, &practice))
        } else {
            None
        };
        if map_is_instance && candidate.is_none() {
            // A disconnected output cannot be kept alive.  Its already
            // persisted profile still points at the real source map; clear
            // the runtime instance so the next connection cannot inherit a
            // private map that no longer has a player.
            if status.is_none() && !notify {
                self.boss_practices.remove(id);
                self.remove_practice_entities(&practice.instance_map_id);
            }
            return false;
        }
        if let Some(candidate) = candidate.as_ref() {
            if persist {
                if let Some(store) = self.store.as_ref() {
                    let profile = profile_from_state(
                        &candidate.state,
                        &candidate.map_id,
                        &candidate.death_id,
                        candidate.base_max_mp,
                    );
                    if store.save_profile(id, &profile).is_err() {
                        if status.is_none() && !notify {
                            // The profile written before entering still has a
                            // canonical source map.  Drop the orphaned
                            // runtime instance on a closed connection rather
                            // than pretending the return write succeeded.
                            self.boss_practices.remove(id);
                            self.remove_practice_entities(&practice.instance_map_id);
                        }
                        return false;
                    }
                }
            }
        }
        self.boss_practices.remove(id);
        self.remove_practice_entities(&practice.instance_map_id);
        self.pending_attacks
            .retain(|_, attack| attack.player_id != id);
        if let Some(candidate) = candidate {
            if let Some(player) = self.players.get_mut(id) {
                *player = candidate;
            }
        }
        let mut settled_practice = practice;
        if let Some(status) = status {
            settled_practice.status = Some(status);
            settled_practice.action = None;
            settled_practice.action_until = self.tick;
            settled_practice.action_effect_at = self.tick;
            self.boss_practices.insert(id.to_owned(), settled_practice);
        }
        if notify {
            let (code, message) = match status {
                Some(BossPracticeStatus::Cleared) => (
                    "boss_practice_cleared",
                    "练习Boss已击败；练习不发放经验或掉落。",
                ),
                Some(BossPracticeStatus::Failed) => (
                    "boss_practice_failed",
                    "练习失败，角色已返回源地图；请复活后重试。",
                ),
                None => ("boss_practice_left", "已退出Boss练习。"),
            };
            self.send_reject(id, code, message, None);
        }
        true
    }

    fn practice_return_candidate(
        &self,
        player: &Player,
        practice: &BossPractice,
    ) -> Option<Player> {
        let Some(source_map) = self.maps.get(&practice.source_map_id).cloned() else {
            return None;
        };
        let mut x = practice
            .return_x
            .clamp(source_map.bounds.x_min, source_map.bounds.x_max);
        let foothold_id;
        let mut y = practice.return_y;
        if let Some((near_id, ground)) = source_map.ground_near(x, y) {
            foothold_id = near_id;
            y = ground;
        } else {
            x = source_map.spawn.x;
            y = source_map.spawn.y;
            foothold_id = source_map.ground_near(x, y).map(|(id, _)| id).unwrap_or(0);
        }
        let mut candidate = player.clone();
        clear_practice_player_effects(&mut candidate);
        candidate.map_id = practice.source_map_id.clone();
        candidate.state.x = x;
        candidate.state.y = y;
        candidate.state.vx = 0.0;
        candidate.state.vy = 0.0;
        candidate.state.grounded = true;
        candidate.state.climbing = false;
        candidate.state.ladder_id = None;
        candidate.foothold_id = foothold_id;
        candidate.last_foothold_id = foothold_id;
        candidate.state.action = if candidate.state.hp <= 0 {
            "dead"
        } else {
            "stand"
        };
        candidate.state.action_started_tick = self.tick;
        refresh_player_derived(&self.gameplay, &self.mage_skills, &mut candidate);
        Some(candidate)
    }

    pub(super) fn disconnect_boss_player(&mut self, id: &str) -> bool {
        if self.boss_practices.contains_key(id) {
            self.finish_boss_practice(id, None, false, true)
        } else {
            true
        }
    }

    pub(super) fn prepare_boss_replacement(&mut self, id: &str) -> bool {
        if self.boss_practices.contains_key(id) {
            // The old connection is still alive while Join is being
            // validated, so a failed return write must leave it untouched.
            self.finish_boss_practice(id, None, true, true)
        } else {
            true
        }
    }

    pub(super) fn boss_snapshot_fields(
        &self,
        id: &str,
        map_id: &str,
    ) -> Option<(String, serde_json::Value)> {
        let practice = self.boss_practices.get(id);
        let on_source = map_id == BOSS_PRACTICE_SOURCE_MAP;
        let active = practice.filter(|practice| practice.status.is_none());
        if !on_source && active.is_none() {
            return None;
        }
        let source_map = practice
            .map(|practice| practice.source_map_id.clone())
            .unwrap_or_else(|| BOSS_PRACTICE_SOURCE_MAP.to_owned());
        let status = match practice {
            Some(practice) if practice.status.is_none() => "active",
            Some(practice) => match practice.status {
                Some(BossPracticeStatus::Cleared) => "cleared",
                Some(BossPracticeStatus::Failed) => "failed",
                None => "active",
            },
            None => "available",
        };
        let (can_enter, block_reason) = if active.is_some() {
            (false, Some("练习进行中"))
        } else if !on_source {
            (false, Some("请先到102020500"))
        } else if self
            .players
            .get(id)
            .is_none_or(|player| player.state.hp <= 0 || player.state.action == "dead")
        {
            (false, Some("死亡角色不能进入练习"))
        } else if self
            .players
            .get(id)
            .is_none_or(|player| player.state.level < BOSS_PRACTICE_MIN_LEVEL)
        {
            (false, Some("练习需要等级25"))
        } else {
            (true, None)
        };
        let mut value = serde_json::json!({
            "status": status,
            "sourceMapId": source_map,
            "bossId": BOSS_PRACTICE_BOSS_ID,
            "minimumLevel": BOSS_PRACTICE_MIN_LEVEL,
            "canEnter": can_enter,
        });
        if let Some(practice) = practice {
            // The private map id is the encounter token.  It is exposed for
            // active and settled rows so Leave/Retry cannot target an older
            // instance after reconnect or a failed command replay.
            value["encounterId"] = practice.instance_map_id.clone().into();
        }
        if let Some(reason) = block_reason {
            value["blockReason"] = reason.into();
        }
        if let Some(practice) = active {
            if let Some(monster) = self.monsters.get(&practice.monster_id) {
                if let Some(action) = practice.action {
                    value["phaseLabel"] = action.phase_label().into();
                    if !practice.action_applied && practice.action_effect_at > self.tick {
                        let remaining = practice
                            .action_effect_at
                            .saturating_sub(self.tick)
                            .saturating_mul(TICK_MS);
                        match action {
                            BossAction::Attack1 => {
                                let facing = source_facing_multiplier(monster.state.facing);
                                let left = monster.state.x + -288.0 * facing;
                                let right = monster.state.x + 255.0 * facing;
                                value["telegraph"] = serde_json::json!({
                                    "kind": "rect",
                                    "x": left.min(right),
                                    "y": monster.state.y - 172.0,
                                    "width": (right - left).abs(),
                                    "height": 172.0,
                                    "remainingMs": remaining,
                                });
                            }
                            BossAction::Attack2 => {
                                value["telegraph"] = serde_json::json!({
                                    "kind": "circle",
                                    "x": monster.state.x + 6.0 * source_facing_multiplier(monster.state.facing),
                                    "y": monster.state.y - 60.0,
                                    "radius": 200.0,
                                    "remainingMs": remaining,
                                });
                            }
                            BossAction::PhysicalGuard
                            | BossAction::MagicGuard
                            | BossAction::Heal => {}
                        }
                    }
                }
            }
            let mut effects = Vec::new();
            if practice.physical_guard_until > self.tick {
                effects.push(serde_json::json!({
                    "skillId": 112,
                    "elapsedMs": self.tick.saturating_sub(practice.physical_guard_started_at).saturating_mul(TICK_MS),
                    "remainingMs": practice.physical_guard_until.saturating_sub(self.tick).saturating_mul(TICK_MS),
                }));
            }
            if practice.magic_guard_until > self.tick {
                effects.push(serde_json::json!({
                    "skillId": 113,
                    "elapsedMs": self.tick.saturating_sub(practice.magic_guard_started_at).saturating_mul(TICK_MS),
                    "remainingMs": practice.magic_guard_until.saturating_sub(self.tick).saturating_mul(TICK_MS),
                }));
            }
            if practice.heal_effect_until > self.tick {
                effects.push(serde_json::json!({
                    "skillId": 114,
                    "elapsedMs": self.tick.saturating_sub(practice.heal_effect_started_at).saturating_mul(TICK_MS),
                    "remainingMs": practice.heal_effect_until.saturating_sub(self.tick).saturating_mul(TICK_MS),
                }));
            }
            if !effects.is_empty() {
                value["effects"] = serde_json::Value::Array(effects);
            }
        }
        Some((BOSS_PRACTICE_SOURCE_MAP.to_owned(), value))
    }

    pub(super) fn boss_damage_multiplier(&self, map_id: &str, magic: bool) -> i64 {
        let Some(practice) = self
            .boss_practices
            .values()
            .find(|practice| practice.status.is_none() && practice.instance_map_id == map_id)
        else {
            return 100;
        };
        let guarded = if magic {
            practice.magic_guard_until > self.tick
        } else {
            practice.physical_guard_until > self.tick
        };
        if guarded {
            85
        } else {
            100
        }
    }

    pub(super) fn step_boss_practice(&mut self) {
        let ids: Vec<String> = self.boss_practices.keys().cloned().collect();
        for id in ids {
            let Some(practice) = self.boss_practices.get(&id).cloned() else {
                continue;
            };
            if practice.status.is_some() {
                continue;
            }
            let Some(player) = self.players.get(&id) else {
                self.finish_boss_practice(&id, None, false, false);
                continue;
            };
            if player.state.hp <= 0 || player.state.action == "dead" {
                self.finish_boss_practice(&id, Some(BossPracticeStatus::Failed), true, true);
                continue;
            }
            if player.map_id != practice.instance_map_id {
                self.finish_boss_practice(&id, Some(BossPracticeStatus::Failed), true, true);
                continue;
            }
            let Some(monster) = self.monsters.get(&practice.monster_id) else {
                self.finish_boss_practice(&id, Some(BossPracticeStatus::Failed), true, true);
                continue;
            };
            if monster.state.hp <= 0 {
                if monster
                    .death_until
                    .is_some_and(|death_until| self.tick < death_until)
                {
                    continue;
                }
                self.finish_boss_practice(&id, Some(BossPracticeStatus::Cleared), true, true);
                continue;
            }
            self.step_one_boss_action(&id);
        }
    }

    fn step_one_boss_action(&mut self, id: &str) {
        let Some(practice) = self.boss_practices.get(id).cloned() else {
            return;
        };
        if let Some(monster) = self.monsters.get_mut(&practice.monster_id) {
            if monster.bind_until <= self.tick {
                monster.bind_pd_rate_reduction = 0;
                monster.bind_md_rate_reduction = 0;
            }
            if monster.freeze_until <= self.tick && monster.state.freeze_stacks.is_some() {
                monster.freeze_until = 0;
                monster.state.freeze_stacks = None;
                if monster.state.action == "freeze" {
                    monster.state.action = "stand";
                    monster.state.action_started_tick = self.tick;
                }
            }
            if monster.stun_until <= self.tick && monster.state.action == "hit" {
                monster.state.action = "stand";
                monster.state.action_started_tick = self.tick;
            }
        }
        let Some(monster) = self.monsters.get(&practice.monster_id) else {
            return;
        };
        if monster.bind_until > self.tick
            || monster.stun_until > self.tick
            || monster.freeze_until > self.tick
        {
            // A player freeze/bind/stun must cancel a queued warning.  The
            // unlocked boss starts a fresh warning instead of resolving an
            // attack whose telegraph elapsed while it was controlled.
            if let Some(practice) = self.boss_practices.get_mut(id) {
                practice.action = None;
                practice.action_applied = false;
                practice.action_until = self.tick;
                practice.action_effect_at = self.tick;
                practice.next_action_at = self.tick.saturating_add(1);
            }
            return;
        }
        if let Some(action) = practice.action {
            if let Some(monster) = self.monsters.get_mut(&practice.monster_id) {
                if monster.state.hp > 0 && monster.state.action == "hit" {
                    // A normal player hit may briefly mark the mob as HIT;
                    // restore the still-running Boss animation so its warning
                    // and authoritative action timeline remain aligned.
                    monster.state.action = action.wire_action();
                    monster.state.action_started_tick = practice.action_started_tick;
                }
            }
        } else if monster.state.action == "hit" {
            if let Some(monster) = self.monsters.get_mut(&practice.monster_id) {
                monster.state.action = "stand";
                monster.state.action_started_tick = self.tick;
            }
        }
        if let Some(action) = practice.action {
            if !practice.action_applied && practice.action_effect_at <= self.tick {
                if !self.apply_boss_action_effect(id, action) {
                    if let Some(practice) = self.boss_practices.get_mut(id) {
                        practice.action_until = self.tick.saturating_add(1);
                        practice.action_effect_at = self.tick.saturating_add(1);
                    }
                    return;
                }
            }
            let still_active = self
                .boss_practices
                .get(id)
                .is_some_and(|practice| practice.action_until > self.tick);
            if still_active {
                return;
            }
            if let Some(monster) = self.monsters.get_mut(&practice.monster_id) {
                if monster.state.hp > 0 {
                    monster.state.action = "stand";
                    monster.state.action_started_tick = self.tick;
                }
            }
            if let Some(practice) = self.boss_practices.get_mut(id) {
                practice.action = None;
                practice.action_applied = false;
                practice.next_action_at = self.tick.saturating_add(BOSS_ACTION_GAP_TICKS);
            }
            return;
        }
        if practice.next_action_at > self.tick {
            return;
        }
        let Some(monster) = self.monsters.get(&practice.monster_id) else {
            return;
        };
        let sequence = practice.action_sequence;
        let action = if monster.mp >= 10
            && self.tick >= practice.heal_ready_at
            && monster.state.hp.saturating_mul(100)
                <= monster
                    .state
                    .max_hp
                    .saturating_mul(BOSS_HEAL_THRESHOLD_PERCENT)
            && sequence % 5 == 4
        {
            BossAction::Heal
        } else if monster.mp >= 5
            && self.tick >= practice.physical_guard_ready_at
            && sequence % 5 == 2
        {
            BossAction::PhysicalGuard
        } else if monster.mp >= 5 && self.tick >= practice.magic_guard_ready_at && sequence % 5 == 3
        {
            BossAction::MagicGuard
        } else if sequence % 2 == 0 {
            BossAction::Attack1
        } else {
            BossAction::Attack2
        };
        self.begin_boss_action(id, action);
    }

    fn begin_boss_action(&mut self, id: &str, action: BossAction) {
        let Some(practice) = self.boss_practices.get_mut(id) else {
            return;
        };
        let Some(monster) = self.monsters.get_mut(&practice.monster_id) else {
            return;
        };
        practice.action = Some(action);
        practice.action_started_tick = self.tick;
        practice.action_until = self.tick.saturating_add(action.duration_ticks().max(1));
        practice.action_effect_at = self.tick.saturating_add(action.effect_after_ticks());
        practice.action_applied = false;
        practice.action_sequence = practice.action_sequence.saturating_add(1);
        monster.state.action = action.wire_action();
        monster.state.action_started_tick = self.tick;
    }

    fn apply_boss_action_effect(&mut self, id: &str, action: BossAction) -> bool {
        let Some(practice) = self.boss_practices.get(id).cloned() else {
            return false;
        };
        if self
            .players
            .get(id)
            .is_none_or(|player| player.map_id != practice.instance_map_id)
        {
            return false;
        }
        let Some((monster_x, monster_y, monster_facing, monster_hp)) = self
            .monsters
            .get(&practice.monster_id)
            .filter(|monster| monster.map_id == practice.instance_map_id)
            .map(|monster| {
                (
                    monster.state.x,
                    monster.state.y,
                    monster.state.facing,
                    monster.state.hp,
                )
            })
        else {
            return false;
        };
        if monster_hp <= 0 {
            return true;
        }
        let mut effect_succeeded = true;
        match action {
            BossAction::Attack1 | BossAction::Attack2 => {
                let Some(player) = self.players.get(id) else {
                    return false;
                };
                let player_x = player.state.x;
                let player_y = player.state.y;
                let hit = if action == BossAction::Attack1 {
                    boss_attack1_contains_at(
                        monster_x,
                        monster_y,
                        monster_facing,
                        player_x,
                        player_y,
                    )
                } else {
                    boss_attack2_contains_at(
                        monster_x,
                        monster_y,
                        monster_facing,
                        player_x,
                        player_y,
                    )
                };
                if hit {
                    let magic = action == BossAction::Attack2;
                    let raw_damage = if magic { BOSS_MAD } else { BOSS_PAD };
                    let protected = self.players.get(id).is_some_and(|player| {
                        player.state.action == "dead"
                            || player.state.hp <= 0
                            || player.contact_invulnerable_until > self.tick
                            || (player.channel_until > self.tick
                                && player.channel_skill_id == Some(SKILL_ICE_DRAGON_BREATH))
                    });
                    if !protected {
                        effect_succeeded = self.apply_boss_player_damage(
                            id,
                            &practice.monster_id,
                            raw_damage,
                            magic,
                        );
                    }
                }
            }
            BossAction::PhysicalGuard => {
                if let Some(monster) = self.monsters.get_mut(&practice.monster_id) {
                    if monster.mp >= 5 {
                        monster.mp -= 5;
                        if let Some(practice) = self.boss_practices.get_mut(id) {
                            practice.physical_guard_until = self.tick + BOSS_GUARD_TICKS;
                            practice.physical_guard_started_at = self.tick;
                            practice.physical_guard_ready_at =
                                self.tick + BOSS_GUARD_COOLDOWN_TICKS;
                        }
                    }
                }
            }
            BossAction::MagicGuard => {
                if let Some(monster) = self.monsters.get_mut(&practice.monster_id) {
                    if monster.mp >= 5 {
                        monster.mp -= 5;
                        if let Some(practice) = self.boss_practices.get_mut(id) {
                            practice.magic_guard_until = self.tick + BOSS_GUARD_TICKS;
                            practice.magic_guard_started_at = self.tick;
                            practice.magic_guard_ready_at = self.tick + BOSS_GUARD_COOLDOWN_TICKS;
                        }
                    }
                }
            }
            BossAction::Heal => {
                if let Some(monster) = self.monsters.get_mut(&practice.monster_id) {
                    // `hp=80` is the source threshold interpretation for this
                    // P practice scheduler; the original selection script is
                    // absent, so the trigger is deliberately documented.
                    if monster.mp >= 10
                        && monster.state.hp.saturating_mul(100)
                            <= monster
                                .state
                                .max_hp
                                .saturating_mul(BOSS_HEAL_THRESHOLD_PERCENT)
                    {
                        monster.mp -= 10;
                        monster.state.hp =
                            (monster.state.hp + BOSS_HEAL_HP).min(monster.state.max_hp);
                        if let Some(practice) = self.boss_practices.get_mut(id) {
                            practice.heal_ready_at = self.tick + BOSS_HEAL_COOLDOWN_TICKS;
                            practice.heal_effect_started_at = self.tick;
                            practice.heal_effect_until = self.tick + BOSS_HEAL_EFFECT_TICKS;
                        }
                    }
                }
            }
        }
        if !effect_succeeded {
            return false;
        }
        if let Some(practice) = self.boss_practices.get_mut(id) {
            practice.action_applied = true;
        }
        true
    }

    fn apply_boss_player_damage(
        &mut self,
        id: &str,
        monster_id: &str,
        raw_damage: i64,
        magic: bool,
    ) -> bool {
        let Some((map_id, defense)) = self.players.get(id).map(|player| {
            // 与接触伤害同一条口径：**装备侧** `weapon_defense`。魔力之盾的 `pddX`
            // 由 `commit_incoming_damage` 在内部减一次，这里再读含 `pddX` 的聚合
            // `defense()` 会变成同一击扣两次（见 `monsters.rs::apply_contact_damage`）。
            let defense = self
                .gameplay
                .player
                .with_ability_stats(
                    &player.state.ability_stats,
                    &player.state.equipped,
                    player.state.job,
                )
                .weapon_defense
                .unwrap_or(0)
                .max(0);
            (player.map_id.clone(), defense)
        }) else {
            return false;
        };
        let damage = if magic {
            raw_damage.max(1)
        } else {
            raw_damage.saturating_sub(defense).max(1)
        };
        let Some((hp_damage, mp_damage, killed)) = self.commit_incoming_damage(id, damage) else {
            return false;
        };
        let (x, y) = self
            .players
            .get(id)
            .map(|player| (player.state.x, player.state.y))
            .unwrap_or((0.0, 0.0));
        let event = serde_json::json!({
            "type": "damageEvent",
            "eventId": format!("damage-event-boss-{id}-{}", self.tick),
            "serverTick": self.tick,
            "attackerId": monster_id,
            "targetId": id,
            "x": x,
            "y": y,
            "damage": hp_damage,
            "mpDamage": mp_damage,
            "killed": killed,
        })
        .to_string();
        self.broadcast_to_map(&map_id, &event);
        true
    }
}

fn clear_practice_player_effects(player: &mut Player) {
    clear_beginner_buffs(player);
    player.direction = 0;
    player.vertical = 0;
    player.jump = false;
    player.attack_until = 0;
    player.contact_invulnerable_until = 0;
    player.knockback_vx = 0.0;
    player.knockback_until = 0;
    player.magic_guard = false;
    player.magic_wave_used = false;
    player.magic_wave_float_used = false;
    player.slow_fall_until = 0;
    player.meditation_until = 0;
    player.meditation_mad = 0;
    player.ice_teleport_enabled = false;
    player.ice_fields.clear();
    player.teleport_mastery_enabled = false;
    player.teleport_boost_enabled = false;
    player.adaptation_active = false;
    player.adaptation_charges = 0;
    player.summons.clear();
    player.state.action_id = None;
    player.state.climbing = false;
    player.state.ladder_id = None;
    player.state.vx = 0.0;
    player.state.vy = 0.0;
    player.state.action_started_tick = 0;
}

/// Pick two separated points on one authored platform.  The map's entrance
/// footholds are split into short WZ segments, so contiguous horizontal
/// segments at the same height are grouped before checking the 150px safety
/// gap.  This keeps the player and Boss from spawning inside one another while
/// still using a source-backed legal foothold near the map spawn.
fn practice_start_positions(map: &Map) -> Option<(u64, f64, f64, u64, f64, f64)> {
    let mut segments: Vec<(u64, f64, f64, f64)> = map
        .footholds
        .iter()
        .filter(|foothold| !foothold.is_wall() && (foothold.y1 - foothold.y2).abs() <= 1.0)
        .map(|foothold| {
            (
                foothold.id,
                foothold.left(),
                foothold.right(),
                (foothold.y1 + foothold.y2) / 2.0,
            )
        })
        .collect();
    segments.sort_by(|a, b| a.3.total_cmp(&b.3).then_with(|| a.1.total_cmp(&b.1)));
    let mut groups: Vec<(f64, f64, f64)> = Vec::new();
    for (_, left, right, y) in segments {
        let extends = groups.last().is_some_and(|(_, group_right, group_y)| {
            (y - *group_y).abs() <= 1.0 && left <= *group_right + 1.0
        });
        if extends {
            let (group_left, group_right, group_y) = groups.last_mut()?;
            *group_left = (*group_left).min(left);
            *group_right = (*group_right).max(right);
            *group_y = (*group_y + y) / 2.0;
        } else {
            groups.push((left, right, y));
        }
    }
    groups
        .into_iter()
        .filter_map(|(left, right, y)| {
            if right - left < 200.0 {
                return None;
            }
            let boss_x = left + 25.0;
            let player_x = right - 25.0;
            if player_x - boss_x < 150.0 {
                return None;
            }
            let boss_fh = map.footholds.iter().find(|foothold| {
                foothold.at(boss_x).is_some()
                    && ((foothold.y1 + foothold.y2) / 2.0 - y).abs() <= 1.0
            })?;
            let player_fh = map.footholds.iter().find(|foothold| {
                foothold.at(player_x).is_some()
                    && ((foothold.y1 + foothold.y2) / 2.0 - y).abs() <= 1.0
            })?;
            let boss_y = boss_fh.at(boss_x)?;
            Some((
                boss_fh.id,
                boss_x,
                boss_y,
                player_fh.id,
                player_x,
                player_fh.at(player_x)?,
            ))
        })
        .min_by(|a, b| {
            let da = (a.1 - map.spawn.x).abs() + (a.2 - map.spawn.y).abs();
            let db = (b.1 - map.spawn.x).abs() + (b.2 - map.spawn.y).abs();
            da.total_cmp(&db).then_with(|| a.0.cmp(&b.0))
        })
}

fn boss_attack1_contains_at(
    monster_x: f64,
    monster_y: f64,
    monster_facing: i8,
    player_x: f64,
    player_y: f64,
) -> bool {
    let facing = source_facing_multiplier(monster_facing);
    let local_x = (player_x - monster_x) * facing;
    let local_y = player_y - monster_y;
    (-288.0..=255.0).contains(&local_x) && (-172.0..=0.0).contains(&local_y)
}

fn boss_attack2_contains_at(
    monster_x: f64,
    monster_y: f64,
    monster_facing: i8,
    player_x: f64,
    player_y: f64,
) -> bool {
    let facing = source_facing_multiplier(monster_facing);
    let center_x = monster_x + 6.0 * facing;
    let center_y = monster_y - 60.0;
    (player_x - center_x).hypot(player_y - center_y) <= 200.0
}

/// Mob source canvases face left.  MonsterView mirrors when the authoritative
/// facing is `1`, so WZ attack offsets use the opposite sign at runtime.
fn source_facing_multiplier(monster_facing: i8) -> f64 {
    if monster_facing < 0 {
        1.0
    } else {
        -1.0
    }
}
