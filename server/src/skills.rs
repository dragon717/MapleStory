//! 技能施法管线与通用结算：施法/释放入口、MP 消耗、施法事件、新手三技能、
//! 状态净化与疾病施加、传送/魔波/能量弹、范围目标选取、暴击与被动伤害结算、
//! 冥想/魔力吸收/冰冻目标、自然恢复。雷球与元素领域也走这里的通用入口。
//!
//! 从 `world.rs` 机械搬出的第七块完整职责（超大文件治理 P2，热路径）。搬的是**代码位置**，
//! 不是数据布局：技能常量、`PlayerState.skills`、协议与 Tick 次序均在原处。
//! 冰雷/超技能/召唤物/冰原的专属运行时在兄弟模块 `elemental`。
//!
//! ## 不负责
//! - 技能学习/分配（`handle_learn_skill` 留在 `world.rs`）。
//! - MobSkill 疾病与怪物步进（`monsters.rs`）；任务/NPC 表现（`quest.rs`）。
//! - 冰雷专属激活器与通道（`elemental.rs`）。

use super::*;

impl World {
    pub(super) fn handle_cast_skill(
        &mut self,
        id: String,
        request_id: String,
        skill_id: u32,
        direction: Option<i8>,
        vertical: Option<i8>,
    ) {
        if let Some(store) = self.store.as_ref() {
            match store.prior_skill_action(&id, &request_id, "cast", skill_id) {
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
            if outcome.operation != "cast" || outcome.skill_id != skill_id {
                outcome.success = false;
                outcome.code = "request_conflict".to_owned();
            }
            self.send_skill_result_with_request(&id, &request_id, &outcome);
            return;
        }
        // 骑乘中不能施法：骑宠的动作集合（源 `Character/TamingMob/*.img`）里没有任何
        // `swing*` / `shoot*` 帧，源里也没有「骑乘中施法」的可执行规则。落点选在
        // 冷却与 MP 消耗**之前**，因此被拒的技能不扣 MP、不进冷却（与 `skill_hidden`
        // 同一处早退位置）。坐姿则相反：先起立再施放，而不是「坐着出招」。
        match self
            .players
            .get(&id)
            .map(|player| (player.mount.is_some(), player.chair.is_some()))
        {
            Some((true, _)) => {
                self.send_reject(
                    &id,
                    "mounted_no_attack",
                    "騎乘中無法攻擊。",
                    Some(&request_id),
                );
                return;
            }
            Some((false, true)) => self.stand_up(&id, "cast"),
            _ => {}
        }
        let Some(skill) = self.mage_skills.get(skill_id).cloned() else {
            self.send_reject(&id, "skill_unknown", "未知法师技能。", Some(&request_id));
            return;
        };
        if (skill.hidden || skill.fixed_level) && skill_id != SKILL_MAGIC_WAVE_HIDDEN {
            self.send_reject(
                &id,
                "skill_hidden",
                "该技能由职业规则自动启用。",
                Some(&request_id),
            );
            return;
        }
        let Some(player) = self.players.get(&id) else {
            return;
        };
        if !skill_job_allowed(player.state.job, skill.book_id)
            || player.state.hp <= 0
            || player.state.action == "dead"
            || player.state.climbing
        {
            self.send_reject(
                &id,
                "invalid_state",
                "当前状态不能施放技能。",
                Some(&request_id),
            );
            return;
        }
        // Seal and stun both silence the skill bar: seal only blocks skills,
        // stun blocks every action and is already filtered at input, but the
        // cast path re-checks so a queued cast cannot slip through a stun.
        if player.status.suppresses_skill_cast() {
            self.send_reject(
                &id,
                "status_sealed",
                "受到異常狀態影響，無法施放技能。",
                Some(&request_id),
            );
            return;
        }
        if player.channel_until > self.tick {
            self.send_reject(&id, "skill_busy", "冰龙吐息进行中。", Some(&request_id));
            return;
        }
        let skill_level = player.state.skills.get(&skill_id).copied().unwrap_or(0);
        let Some(level) = self.mage_skills.level(skill_id, skill_level).cloned() else {
            self.send_reject(&id, "not_learned", "请先学习该技能。", Some(&request_id));
            return;
        };
        if skill.hyper > 0 && player.state.level < skill.required_level {
            self.send_reject(
                &id,
                "level_requirement",
                "尚未达到Hyper技能等级要求。",
                Some(&request_id),
            );
            return;
        }
        let mut direction = direction.unwrap_or(player.state.facing).clamp(-1, 1);
        let vertical = vertical.unwrap_or(0).clamp(-1, 1);
        if direction == 0 && vertical == 0 {
            direction = if player.state.facing < 0 { -1 } else { 1 };
        }
        if !matches!(
            skill_id,
            SKILL_MAGIC_GUARD
                | SKILL_TELEPORT
                | SKILL_ENERGY_BOLT
                | SKILL_MAGIC_WAVE
                | SKILL_MAGIC_WAVE_HIDDEN
                | SKILL_MEDITATION
                | SKILL_COLD_BEAM
                | SKILL_THUNDER_BOLT
                | SKILL_ICE_TELEPORT
                | SKILL_ICE_STORM
                | SKILL_GLACIAL_WALL
                | SKILL_THUNDER_SPHERE
                | SKILL_ELEMENTAL_ADAPTING
                | SKILL_TELEPORT_MASTERY
                | SKILL_TELEPORT_BOOST
                | SKILL_HYPER_TELEPORT_DISTANCE
                | SKILL_MAPLE_WARRIOR
                | SKILL_INFINITY
                | SKILL_ICE_DEMON
                | SKILL_CHAIN_LIGHTNING
                | SKILL_BLIZZARD
                | SKILL_MAPLE_CURE
                | SKILL_ICE_DRAGON_BREATH
                | SKILL_FROZEN_ORB
                | SKILL_HYPER_THUNDER
                | SKILL_HYPER_ADVENTURER
                | SKILL_HYPER_VORTEX
                | SKILL_THREE_SNAILS
                | SKILL_RECOVERY
                | SKILL_NIMBLE_FEET
        ) {
            self.send_reject(
                &id,
                "skill_passive",
                "被动技能不能主动施放。",
                Some(&request_id),
            );
            return;
        }
        if skill_id == SKILL_ELEMENTAL_ADAPTING && player.adaptation_cooldown_ms > 0 {
            self.send_reject(
                &id,
                "skill_cooldown",
                "元素适应尚在冷却中。",
                Some(&request_id),
            );
            return;
        }
        if player
            .skill_cooldowns
            .get(&skill_id)
            .copied()
            .is_some_and(|remaining| remaining > 0)
        {
            self.send_reject(&id, "skill_cooldown", "技能尚在冷却中。", Some(&request_id));
            return;
        }
        if skill_id == SKILL_HYPER_VORTEX
            && vertical > 0
            && player
                .skill_cooldowns
                .get(&SKILL_HYPER_VORTEX_HIDDEN)
                .copied()
                .is_some_and(|remaining| remaining > 0)
        {
            self.send_reject(
                &id,
                "skill_cooldown",
                "漩涡生成尚在冷却中。",
                Some(&request_id),
            );
            return;
        }
        let teleport = if skill_id == SKILL_TELEPORT {
            match self.plan_teleport(&id, &level, direction, vertical) {
                Ok(plan) => Some(plan),
                Err(code) => {
                    self.send_reject(&id, &code, "瞬間移動被地图碰撞阻挡。", Some(&request_id));
                    return;
                }
            }
        } else {
            None
        };
        let has_magic_wave = player
            .state
            .skills
            .get(&SKILL_MAGIC_WAVE)
            .copied()
            .unwrap_or(0)
            > 0;
        let has_magic_wave_hidden = player
            .state
            .skills
            .get(&SKILL_MAGIC_WAVE_HIDDEN)
            .copied()
            .unwrap_or(0)
            > 0;
        let has_magic_wave_skill = (skill_id == SKILL_MAGIC_WAVE && has_magic_wave)
            || (skill_id == SKILL_MAGIC_WAVE_HIDDEN && has_magic_wave_hidden);
        // The hidden float node (2001012) is the *jump* half of 魔力波動: once
        // the body is airborne one jump press is enough.  It used to also
        // demand a held ↓ (`vertical <= 0` -> reject), which turned the skill
        // into the 上+跳 / 下+跳 two-step; ↑/↓ no longer participates, so `跳`
        // alone floats.  Landing / leaving the water still resets the one-use
        // flag, and the visible node (2001011) keeps requiring ↑.
        if matches!(skill_id, SKILL_MAGIC_WAVE | SKILL_MAGIC_WAVE_HIDDEN)
            && (!has_magic_wave_skill
                || (skill_id == SKILL_MAGIC_WAVE && vertical >= 0)
                || (skill_id == SKILL_MAGIC_WAVE_HIDDEN && player.state.grounded)
                || (skill_id == SKILL_MAGIC_WAVE && player.magic_wave_used)
                || (skill_id == SKILL_MAGIC_WAVE_HIDDEN && player.magic_wave_float_used))
        {
            self.send_reject(
                &id,
                "skill_cooldown",
                "魔力波動当前不能使用。",
                Some(&request_id),
            );
            return;
        }
        if matches!(
            skill_id,
            SKILL_ENERGY_BOLT
                | SKILL_THREE_SNAILS
                | SKILL_COLD_BEAM
                | SKILL_THUNDER_BOLT
                | SKILL_ICE_STORM
                | SKILL_GLACIAL_WALL
                | SKILL_THUNDER_SPHERE
                | SKILL_ICE_DEMON
                | SKILL_CHAIN_LIGHTNING
                | SKILL_BLIZZARD
                | SKILL_ICE_DRAGON_BREATH
                | SKILL_FROZEN_ORB
                | SKILL_HYPER_THUNDER
        ) && player.attack_until > self.tick
        {
            self.send_reject(&id, "skill_busy", "技能动作尚未结束。", Some(&request_id));
            return;
        }
        let mut mp_cost = self.skill_mp_cost(&id, skill_id, &level, vertical);
        if skill_id == SKILL_HYPER_VORTEX && player.hyper_barrier_enabled && vertical <= 0 {
            // Turning the barrier off does not charge the next second.
            mp_cost = 0;
        }
        // 用户指定规则（2026-09-10）：瞬移全等级固定 10 MP，等级差异体现在距离与冷却。
        // 数值来自 shared/mage-skills.json#2001009（覆盖表见 scripts/tms273_skill_manifest.cjs），
        // 原版 TMS273 为 mpCon 28→20 且没有 cooltime——此处按用户指定执行，不冒充原作。
        let cooldown_ms: i64 = if skill_id == SKILL_TELEPORT {
            level.cooldown_ms.unwrap_or(0).max(0)
        } else if BEGINNER_SKILLS.contains(&skill_id)
            || skill_id == SKILL_ELEMENTAL_ADAPTING
            || (skill.book_id == FOURTH_BOOK && level.cooltime.is_some())
        {
            level.cooltime.unwrap_or(0).max(0).saturating_mul(1_000)
        } else {
            0
        };
        // 瞬移是高频移动技能：冷却只进内存 skill_cooldowns 做施放节流，不写 skill_cooldowns 表。
        // 逐次瞬移都落一条持久冷却只会制造无谓事务，秒级冷却也没有跨登录保留的意义。
        let durable_cooldown_ms = if skill_id == SKILL_TELEPORT {
            0
        } else {
            cooldown_ms
        };
        let outcome = match self.store.as_ref() {
            Some(store) if skill_id == SKILL_HYPER_VORTEX && vertical > 0 => store
                .cast_hyper_vortex(
                    &id,
                    &request_id,
                    mp_cost,
                    if vertical > 0 {
                        level.cooltime.unwrap_or(60).max(0).saturating_mul(1_000)
                    } else {
                        0
                    },
                ),
            Some(store) if durable_cooldown_ms > 0 => store.cast_skill_with_cooldown(
                &id,
                &request_id,
                skill_id,
                skill.book_id,
                skill.book_id,
                skill.max_level,
                mp_cost,
                cooldown_ms,
            ),
            Some(store) => store.cast_skill(
                &id,
                &request_id,
                skill_id,
                skill.book_id,
                skill.book_id,
                skill.max_level,
                mp_cost,
            ),
            None => Ok(self.local_cast_skill(&id, &request_id, skill_id, skill.book_id, mp_cost)),
        };
        let Ok(outcome) = outcome else {
            self.send_reject(
                &id,
                "persistence",
                "技能施放保存失败，请重试。",
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
        if let Some(player) = self.players.get_mut(&id) {
            player.state.mp = outcome.mp;
            if cooldown_ms > 0 {
                player
                    .skill_cooldowns
                    .insert(skill_id, u64::try_from(cooldown_ms).unwrap_or(u64::MAX));
            }
            if skill_id == SKILL_HYPER_VORTEX && vertical > 0 {
                let vortex_cooldown = u64::try_from(level.cooltime.unwrap_or(60).max(0))
                    .unwrap_or(60)
                    .saturating_mul(1_000);
                if vortex_cooldown > 0 {
                    player
                        .skill_cooldowns
                        .insert(SKILL_HYPER_VORTEX_HIDDEN, vortex_cooldown);
                }
            }
        }
        let duration_ms = if skill_id == SKILL_THREE_SNAILS {
            SKILL_CAST_DURATION_MS
        } else if skill_id == SKILL_HYPER_THUNDER {
            780
        } else if matches!(skill_id, SKILL_HYPER_ADVENTURER | SKILL_HYPER_VORTEX) {
            600
        } else if skill_id == SKILL_MAGIC_WAVE_HIDDEN {
            level.time.unwrap_or(5).max(0).try_into().unwrap_or(5_000) * 1_000
        } else if skill_id == SKILL_INFINITY {
            // The source has an alert/activation action but no authored
            // duration field.  Keep the visual cast finite and independent
            // of weapon action speed; the actual buff duration is tracked
            // separately by activate_infinity.
            600
        } else if skill_id == SKILL_ICE_DRAGON_BREATH {
            // q is the held-key maximum from String.h.  Master Magic
            // buff-time does not extend this channel ceiling.
            u64::try_from(level.q.unwrap_or(0).max(0)).unwrap_or(0) * 1_000
        } else if matches!(
            skill_id,
            SKILL_ENERGY_BOLT
                | SKILL_MAGIC_WAVE
                | SKILL_COLD_BEAM
                | SKILL_THUNDER_BOLT
                | SKILL_ICE_STORM
                | SKILL_GLACIAL_WALL
                | SKILL_THUNDER_SPHERE
                | SKILL_ICE_DEMON
                | SKILL_CHAIN_LIGHTNING
                | SKILL_BLIZZARD
                | SKILL_ICE_DRAGON_BREATH
                | SKILL_FROZEN_ORB
                | SKILL_HYPER_THUNDER
                | SKILL_HYPER_VORTEX
        ) {
            if skill_id == SKILL_ENERGY_BOLT {
                self.energy_duration_ms(&id)
            } else {
                self.skill_duration_ms(&id, skill_id)
            }
        } else {
            0
        };
        let event = if skill_id == SKILL_HYPER_THUNDER {
            self.skill_cast_event_phase(
                &id,
                &request_id,
                skill_id,
                duration_ms,
                &level,
                Some("prepare"),
                None,
            )
        } else {
            self.skill_cast_event(
                &id,
                &request_id,
                skill_id,
                duration_ms,
                &level,
                (skill_id == SKILL_THREE_SNAILS).then_some(skill_level),
            )
        };
        let map_id = self.players.get(&id).map(|player| player.map_id.clone());
        if let Some(map_id) = map_id.as_deref() {
            self.broadcast_to_map(map_id, &event);
        }
        match skill_id {
            SKILL_MAGIC_GUARD => {
                if let Some(player) = self.players.get_mut(&id) {
                    player.magic_guard = !player.magic_guard;
                    refresh_player_derived(&self.gameplay, &self.mage_skills, player);
                }
            }
            SKILL_TELEPORT => {
                if let Some(plan) = teleport {
                    let start = self
                        .players
                        .get(&id)
                        .map(|player| (player.state.x, player.state.y));
                    self.apply_teleport(&id, plan);
                    if let Some((start_x, start_y)) = start {
                        self.maybe_create_ice_field(&id, start_x, start_y);
                    }
                    let mastery = self.players.get(&id).and_then(|player| {
                        player
                            .teleport_mastery_enabled
                            .then(|| player.state.skills.get(&SKILL_TELEPORT_MASTERY).copied())
                            .flatten()
                            .and_then(|level| self.mage_skills.level(SKILL_TELEPORT_MASTERY, level))
                            .cloned()
                    });
                    if let Some(mastery) = mastery {
                        if let Err(error) = self.cast_teleport_mastery(&id, &request_id, &mastery) {
                            self.handle_accepted_effect_error(&id, &request_id, &error);
                            return;
                        }
                    }
                }
            }
            SKILL_MEDITATION => self.apply_meditation(&id, &level),
            SKILL_COLD_BEAM => {
                if let Err(error) =
                    self.cast_elemental_area(&id, &request_id, skill_id, &level, false)
                {
                    self.handle_accepted_effect_error(&id, &request_id, &error);
                    return;
                }
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.action = "attack";
                    player.state.action_started_tick = self.tick;
                    player.attack_until = self.tick + duration_ms.div_ceil(TICK_MS).max(1);
                }
            }
            SKILL_THUNDER_BOLT => {
                if let Err(error) =
                    self.cast_elemental_area(&id, &request_id, skill_id, &level, true)
                {
                    self.handle_accepted_effect_error(&id, &request_id, &error);
                    return;
                }
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.action = "attack";
                    player.state.action_started_tick = self.tick;
                    player.attack_until = self.tick + duration_ms.div_ceil(TICK_MS).max(1);
                }
            }
            SKILL_ICE_STORM => {
                if let Err(error) =
                    self.cast_elemental_area(&id, &request_id, skill_id, &level, false)
                {
                    self.handle_accepted_effect_error(&id, &request_id, &error);
                    return;
                }
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.action = "attack";
                    player.state.action_started_tick = self.tick;
                    player.attack_until = self.tick + duration_ms.div_ceil(TICK_MS).max(1);
                }
            }
            SKILL_GLACIAL_WALL => {
                if let Err(error) = self.cast_glacial_wall(&id, &request_id, &level) {
                    self.handle_accepted_effect_error(&id, &request_id, &error);
                    return;
                }
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.action = "attack";
                    player.state.action_started_tick = self.tick;
                    player.attack_until = self.tick + duration_ms.div_ceil(TICK_MS).max(1);
                }
            }
            SKILL_THUNDER_SPHERE => {
                if let Err(error) = self.cast_thunder_sphere(&id, &request_id, &level, vertical) {
                    self.handle_accepted_effect_error(&id, &request_id, &error);
                    return;
                }
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.action = "attack";
                    player.state.action_started_tick = self.tick;
                    player.attack_until = self.tick + duration_ms.div_ceil(TICK_MS).max(1);
                }
            }
            SKILL_ELEMENTAL_ADAPTING => {
                if let Some(player) = self.players.get_mut(&id) {
                    // Elemental Adapting is a guarded activation with a
                    // durable cooldown, not an on/off toggle.  A successful
                    // cast always refreshes its source charge count.
                    player.adaptation_active = true;
                    player.adaptation_charges = u32::try_from(level.y.unwrap_or(7).max(0))
                        .unwrap_or(0)
                        .max(1);
                    player.adaptation_cooldown_ms = u64::try_from(cooldown_ms).unwrap_or(0);
                }
            }
            SKILL_MAPLE_WARRIOR => {
                let duration_ms = self.buff_duration_ms(
                    &id,
                    &level,
                    level.time.unwrap_or(0).max(0) as u64 * 1_000,
                );
                if let Some(player) = self.players.get_mut(&id) {
                    player.status.apply_buff(
                        SKILL_MAPLE_WARRIOR,
                        duration_ms,
                        self.tick,
                        Release::None,
                    );
                }
            }
            SKILL_INFINITY => {
                if let Err(error) = self.activate_infinity(&id, &level) {
                    self.handle_accepted_effect_error(&id, &request_id, &error);
                    return;
                }
            }
            SKILL_ICE_DEMON => {
                if let Err(error) = self.cast_ice_demon(&id, &request_id, &level) {
                    self.handle_accepted_effect_error(&id, &request_id, &error);
                    return;
                }
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.action = "attack";
                    player.state.action_started_tick = self.tick;
                    player.attack_until = self.tick + duration_ms.div_ceil(TICK_MS).max(1);
                }
            }
            SKILL_CHAIN_LIGHTNING | SKILL_BLIZZARD => {
                if let Err(error) = self.cast_elemental_area(
                    &id,
                    &request_id,
                    skill_id,
                    &level,
                    skill_id == SKILL_CHAIN_LIGHTNING,
                ) {
                    self.handle_accepted_effect_error(&id, &request_id, &error);
                    return;
                }
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.action = "attack";
                    player.state.action_started_tick = self.tick;
                    player.attack_until = self.tick + duration_ms.div_ceil(TICK_MS).max(1);
                }
                if skill_id == SKILL_CHAIN_LIGHTNING {
                    self.apply_chain_stun(&id, &request_id, &level);
                }
            }
            SKILL_MAPLE_CURE => self.activate_status_cleanse(&id, &level),
            SKILL_ICE_DRAGON_BREATH => {
                if let Err(error) = self.cast_ice_dragon_breath(&id, &request_id, &level) {
                    self.handle_accepted_effect_error(&id, &request_id, &error);
                    return;
                }
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.action = "attack";
                    player.state.action_started_tick = self.tick;
                    player.attack_until = player.channel_until;
                }
            }
            SKILL_HYPER_THUNDER => {
                if let Err(error) = self.start_hyper_thunder(&id, &request_id, &level) {
                    self.handle_accepted_effect_error(&id, &request_id, &error);
                    return;
                }
            }
            SKILL_HYPER_ADVENTURER => {
                self.activate_hyper_adventurer(&id, &level);
            }
            SKILL_HYPER_VORTEX => {
                if let Err(error) = self.activate_hyper_vortex(&id, &request_id, &level, vertical) {
                    self.handle_accepted_effect_error(&id, &request_id, &error);
                    return;
                }
            }
            SKILL_FROZEN_ORB => {
                if let Err(error) = self.cast_frozen_orb(&id, &request_id, &level) {
                    self.handle_accepted_effect_error(&id, &request_id, &error);
                    return;
                }
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.action = "attack";
                    player.state.action_started_tick = self.tick;
                    player.attack_until = self.tick + duration_ms.div_ceil(TICK_MS).max(1);
                }
            }
            SKILL_THREE_SNAILS => {
                if let Err(error) = self.cast_beginner_throw(&id, &request_id, &level, skill_level)
                {
                    self.handle_accepted_effect_error(&id, &request_id, &error);
                    return;
                }
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.action = "attack";
                    player.state.action_started_tick = self.tick;
                    player.attack_until = self.tick + duration_ms.div_ceil(TICK_MS).max(1);
                }
            }
            SKILL_RECOVERY | SKILL_NIMBLE_FEET => {
                self.activate_beginner_buff(&id, skill_id, &level);
            }
            SKILL_TELEPORT_MASTERY => {
                if let Some(player) = self.players.get_mut(&id) {
                    player.teleport_mastery_enabled = !player.teleport_mastery_enabled;
                }
            }
            SKILL_TELEPORT_BOOST => {
                if let Some(player) = self.players.get_mut(&id) {
                    player.teleport_boost_enabled = !player.teleport_boost_enabled;
                    if player.teleport_boost_enabled {
                        player.hyper_teleport_enabled = false;
                    }
                }
            }
            SKILL_HYPER_TELEPORT_DISTANCE => {
                if let Some(player) = self.players.get_mut(&id) {
                    player.hyper_teleport_enabled = !player.hyper_teleport_enabled;
                    if player.hyper_teleport_enabled {
                        player.teleport_boost_enabled = false;
                    }
                }
            }
            SKILL_ICE_TELEPORT => {
                if let Some(player) = self.players.get_mut(&id) {
                    player.ice_teleport_enabled = !player.ice_teleport_enabled;
                }
            }
            SKILL_MAGIC_WAVE | SKILL_MAGIC_WAVE_HIDDEN => {
                self.apply_magic_wave(&id, &level, vertical, skill_id == SKILL_MAGIC_WAVE_HIDDEN)
            }
            SKILL_ENERGY_BOLT => {
                if let Err(error) = self.cast_energy_bolt(&id, &request_id, skill_id, &level) {
                    self.handle_accepted_effect_error(&id, &request_id, &error);
                    return;
                }
            }
            _ => {}
        }
        if let Some(player) = self.players.get_mut(&id) {
            refresh_player_derived(&self.gameplay, &self.mage_skills, player);
        }
        if self.store.is_some() {
            if let Err(error) = self.persist_player(&id) {
                self.handle_accepted_effect_error(&id, &request_id, &error);
                return;
            }
        }
        self.send_skill_result_with_request(&id, &request_id, &outcome);
    }

    pub(super) fn handle_release_skill(&mut self, id: String, request_id: String) {
        let Some((channel_skill, channel_request, channel_until, hp, action)) =
            self.players.get(&id).map(|player| {
                (
                    player.channel_skill_id,
                    player.channel_request_id.clone(),
                    player.channel_until,
                    player.state.hp,
                    player.state.action,
                )
            })
        else {
            return;
        };
        let valid = matches!(
            channel_skill,
            Some(SKILL_ICE_DRAGON_BREATH) | Some(SKILL_HYPER_THUNDER)
        ) && channel_request
            .as_deref()
            .is_some_and(|value| value == request_id)
            && channel_until > self.tick
            && action != "dead"
            && hp > 0;
        if !valid {
            // Key-up can arrive after the channel naturally expired, after a
            // death/map change cleared it, or as a duplicate network packet.
            // Treat those cases as an idempotent no-op so a stale release
            // cannot surface a false gameplay error or affect a new channel.
            return;
        }
        if channel_skill == Some(SKILL_HYPER_THUNDER) {
            if let Err(error) = self.finish_hyper_thunder(&id, &request_id) {
                self.handle_accepted_effect_error(&id, &request_id, &error);
            }
            return;
        }
        let Some(player) = self.players.get_mut(&id) else {
            return;
        };
        player.channel_request_id = None;
        player.channel_skill_id = None;
        player.channel_until = 0;
        player.channel_level = 0;
        player.status.remove_buff(SKILL_ICE_DRAGON_BREATH);
        player.attack_until = self.tick;
        player.state.action = "stand";
        player.state.action_started_tick = self.tick;
        let map_id = player.map_id.clone();
        let event = serde_json::json!({
            "type": "skillCast",
            "eventId": format!("skill-release-{id}-{request_id}"),
            "serverTick": self.tick,
            "playerId": id,
            "skillId": SKILL_ICE_DRAGON_BREATH,
            "requestId": request_id,
            "x": player.state.x,
            "y": player.state.y,
            "facing": player.state.facing,
            "durationMs": 0,
            "released": true,
        })
        .to_string();
        refresh_player_derived(&self.gameplay, &self.mage_skills, player);
        self.broadcast_to_map(&map_id, &event);
    }

    pub(super) fn handle_accepted_effect_error(&mut self, id: &str, request_id: &str, error: &str) {
        // MP/cooldown was already committed by auth.  Never turn a durable
        // cast into a client-visible retry that could spend it twice.  A
        // fresh snapshot lets the client reconcile MP/toggles before the next
        // request; the explicit code tells it that only the effect failed.
        self.send_reject(id, "effect_persistence", error, Some(request_id));
        self.send_snapshot(id);
    }

    pub(super) fn skill_mp_cost(
        &self,
        id: &str,
        skill_id: u32,
        level: &MageLevel,
        vertical: i8,
    ) -> i64 {
        // Hyper Thunder's accepted cast is the first sustained pulse: the P
        // contract charges its authored 30 MP up front and starts the durable
        // 60-second cooldown.  Keep it outside Amp/Infinity adjustments so a
        // tap cannot create a free release or an under/overcharged first hit.
        if skill_id == SKILL_HYPER_THUNDER {
            return level.mp_con.unwrap_or(30).max(0);
        }
        let mut cost = level.mp_con.unwrap_or(0).max(0);
        if is_magic_attack_skill(skill_id) {
            let amp_level = self
                .players
                .get(id)
                .and_then(|player| player.state.skills.get(&SKILL_ELEMENT_AMP))
                .copied()
                .and_then(|level| self.mage_skills.level(SKILL_ELEMENT_AMP, level));
            if let Some(amp) = amp_level {
                cost = cost.saturating_mul(100 + amp.costmp_r.unwrap_or(0).max(0)) / 100;
            }
        }
        if skill_id == SKILL_TELEPORT {
            if let Some(master_level) = self
                .players
                .get(id)
                .and_then(|player| player.state.skills.get(&SKILL_TELEPORT_MASTERY))
                .copied()
                .and_then(|level| self.mage_skills.level(SKILL_TELEPORT_MASTERY, level))
            {
                if self
                    .players
                    .get(id)
                    .is_some_and(|player| player.teleport_mastery_enabled)
                {
                    cost = cost.saturating_add(master_level.y.unwrap_or(0).max(0));
                }
            }
        } else if skill_id == SKILL_TELEPORT_BOOST
            && self
                .players
                .get(id)
                .is_some_and(|player| player.teleport_boost_enabled)
        {
            // Turning the toggle off has no source MP cost.
            cost = 0;
        } else if skill_id == SKILL_THUNDER_SPHERE
            && vertical > 0
            && self.players.get(id).is_some_and(|player| {
                player.summon.as_ref().is_some_and(|summon| {
                    matches!(
                        summon.skill_id,
                        SKILL_THUNDER_SPHERE | SKILL_THUNDER_SPHERE_HIDDEN
                    )
                })
            })
        {
            // Re-anchoring the existing sphere is a control action; only the
            // initial summon consumes its authored mpCon.
            cost = 0;
        }
        // Infinity is an authoritative active buff.  Its no-MP rule applies
        // to every other accepted skill, including skills whose source value
        // is zero or whose Elemental Amp adjustment was already calculated.
        if skill_id != SKILL_INFINITY
            && self
                .players
                .get(id)
                .is_some_and(|player| player.status.buff_active(SKILL_INFINITY))
        {
            cost = 0;
        }
        cost
    }

    pub(super) fn local_cast_skill(
        &mut self,
        id: &str,
        request_id: &str,
        skill_id: u32,
        book_id: u32,
        mp_cost: i64,
    ) -> auth::SkillActionOutcome {
        if let Some(prior) = self
            .skill_requests
            .get(&(id.to_owned(), request_id.to_owned()))
        {
            let mut prior = prior.clone();
            prior.already_resolved = true;
            if prior.operation != "cast" || prior.skill_id != skill_id {
                prior.success = false;
                prior.code = "request_conflict".into();
            }
            return prior;
        }
        let Some(player) = self.players.get_mut(id) else {
            return auth::SkillActionOutcome {
                operation: "cast".into(),
                skill_id,
                success: false,
                code: "player_unknown".into(),
                level: 0,
                remaining_sp: 0,
                mp: 0,
                already_resolved: false,
            };
        };
        let level = player.state.skills.get(&skill_id).copied().unwrap_or(0);
        let mut outcome = auth::SkillActionOutcome {
            operation: "cast".into(),
            skill_id,
            success: level > 0 && player.state.mp >= mp_cost,
            code: String::new(),
            level,
            remaining_sp: player
                .state
                .skill_points
                .get(&book_id)
                .copied()
                .unwrap_or(0),
            mp: player.state.mp,
            already_resolved: false,
        };
        if level == 0 {
            outcome.success = false;
            outcome.code = "not_learned".into();
        } else if player.state.mp < mp_cost {
            outcome.success = false;
            outcome.code = "not_enough_mp".into();
        } else {
            player.state.mp -= mp_cost;
            outcome.mp = player.state.mp;
        }
        self.skill_requests
            .insert((id.to_owned(), request_id.to_owned()), outcome.clone());
        outcome
    }

    pub(super) fn skill_cast_event(
        &self,
        id: &str,
        request_id: &str,
        skill_id: u32,
        duration_ms: u64,
        level: &MageLevel,
        skill_level: Option<u32>,
    ) -> String {
        let (x, y, facing) = self
            .players
            .get(id)
            .map(|player| (player.state.x, player.state.y, player.state.facing))
            .unwrap_or((0.0, 0.0, 1));
        let mut value = serde_json::json!({
            "type": "skillCast",
            "eventId": format!("skill-cast-{id}-{request_id}"),
            "serverTick": self.tick,
            "playerId": id,
            "skillId": skill_id,
            "requestId": request_id,
            "x": x,
            "y": y,
            "facing": facing,
            "durationMs": duration_ms,
        });
        if let Some(skill_level) = skill_level {
            value["skillLevel"] = skill_level.into();
        }
        if matches!(
            skill_id,
            SKILL_THREE_SNAILS
                | SKILL_ENERGY_BOLT
                | SKILL_COLD_BEAM
                | SKILL_THUNDER_BOLT
                | SKILL_ICE_STORM
                | SKILL_GLACIAL_WALL
                | SKILL_TELEPORT_MASTERY
                | SKILL_THUNDER_SPHERE
                | SKILL_ICE_DEMON
                | SKILL_CHAIN_LIGHTNING
                | SKILL_BLIZZARD
                | SKILL_ICE_DRAGON_BREATH
                | SKILL_FROZEN_ORB
                | SKILL_HYPER_THUNDER
                | SKILL_HYPER_VORTEX
        ) {
            let target_ids = if skill_id == SKILL_THREE_SNAILS {
                self.beginner_throw_targets(id)
            } else if skill_id == SKILL_ENERGY_BOLT {
                self.energy_targets(id, level)
            } else {
                self.skill_area_targets(id, skill_id, level)
            };
            if let Some(target_id) = target_ids.first() {
                if let Some(target) = self.monsters.get(target_id) {
                    value["targetId"] = serde_json::Value::String(target_id.to_owned());
                    value["targetX"] = target.state.x.into();
                    value["targetY"] = target.state.y.into();
                }
            } else {
                let range = if skill_id == SKILL_THREE_SNAILS {
                    BEGINNER_THROW_RANGE
                } else {
                    level.range.unwrap_or(0).max(0) as f64
                };
                value["targetX"] = (x + f64::from(if facing < 0 { -1 } else { 1 }) * range).into();
                value["targetY"] = y.into();
            }
        }
        value.to_string()
    }

    pub(super) fn skill_cast_event_phase(
        &self,
        id: &str,
        request_id: &str,
        skill_id: u32,
        duration_ms: u64,
        level: &MageLevel,
        phase: Option<&str>,
        skill_level: Option<u32>,
    ) -> String {
        let mut value: serde_json::Value = serde_json::from_str(&self.skill_cast_event(
            id,
            request_id,
            skill_id,
            duration_ms,
            level,
            skill_level,
        ))
        .unwrap_or_else(|_| serde_json::json!({"type":"skillCast"}));
        if let Some(phase) = phase {
            value["phase"] = serde_json::Value::String(phase.to_owned());
        }
        value.to_string()
    }

    pub(super) fn activate_beginner_buff(&mut self, id: &str, skill_id: u32, level: &MageLevel) {
        let duration_ms = u64::try_from(level.time.unwrap_or(0).max(0))
            .unwrap_or(0)
            .saturating_mul(1_000);
        let duration_ms = self.buff_duration_ms(id, level, duration_ms);
        if duration_ms == 0 {
            return;
        }
        let Some(player) = self.players.get_mut(id) else {
            return;
        };
        // 增益与它的附属状态绑成同一条记录：到期时由 `Release` 说明要收回哪些
        // 字段，`world.rs` 的 tick 块 `match` 到全部变体（新增一种带附属状态的
        // 增益而不写清理会编译不过，不再是「名单漏一个就静默泄漏」）。
        let release = match skill_id {
            SKILL_RECOVERY => Release::BeginnerRecovery,
            SKILL_NIMBLE_FEET => Release::BeginnerSpeed,
            _ => Release::None,
        };
        player
            .status
            .apply_buff(skill_id, duration_ms, self.tick, release);
        match skill_id {
            SKILL_RECOVERY => {
                player.beginner_heal_next_tick = self
                    .tick
                    .saturating_add((BEGINNER_HEAL_TICK_MS / TICK_MS).max(1));
                player.beginner_heal_remaining_ticks = BEGINNER_HEAL_TICKS;
                player.beginner_heal_per_tick = level.x.unwrap_or(0).max(0);
            }
            SKILL_NIMBLE_FEET => {
                player.beginner_speed_percent = level.speed.unwrap_or(0).clamp(0, 100);
            }
            _ => {}
        }
    }

    pub(super) fn beginner_throw_targets(&self, id: &str) -> Vec<String> {
        // P: the selected export has no authoritative 1000 rectangle/range.
        // Reuse the existing remote bolt adapter's 340 px range while keeping
        // the source's single target/count semantics explicit.
        let level = MageLevel {
            range: Some(BEGINNER_THROW_RANGE as i64),
            mob_count: Some(1),
            attack_count: Some(1),
            ..MageLevel::default()
        };
        self.energy_targets(id, &level)
    }

    pub(super) fn apply_beginner_heal_tick(&mut self, id: &str) {
        let Some((state, map_id, death_id, base_max_mp, next_tick, remaining_ticks, per_tick)) =
            self.players.get(id).and_then(|player| {
                player.status.buff_active(SKILL_RECOVERY).then(|| {
                    (
                        player.state.clone(),
                        player.map_id.clone(),
                        player.death_id.clone(),
                        player.base_max_mp,
                        player.beginner_heal_next_tick,
                        player.beginner_heal_remaining_ticks,
                        player.beginner_heal_per_tick,
                    )
                })
            })
        else {
            return;
        };
        if state.hp <= 0 || next_tick > self.tick || remaining_ticks == 0 || per_tick <= 0 {
            return;
        }
        let healed_hp = state.hp.saturating_add(per_tick).min(state.max_hp.max(1));
        let next_remaining_ticks = remaining_ticks.saturating_sub(1);
        let next_tick = if next_remaining_ticks > 0 {
            self.tick
                .saturating_add((BEGINNER_HEAL_TICK_MS / TICK_MS).max(1))
        } else {
            0
        };
        // 跳字要的是**实际增加量**：`healed_hp` 已被 `max_hp` 夹过，顶着上限时它
        // 比 `per_tick` 小。必须在 `state` 被 move 进 `healed_state` 之前算出来。
        let healed_gain = healed_hp - state.hp;
        if healed_hp != state.hp {
            let mut healed_state = state;
            healed_state.hp = healed_hp;
            if let Some(store) = self.store.as_ref() {
                let profile = profile_from_state(&healed_state, &map_id, &death_id, base_max_mp);
                // The durable profile is written before the in-memory HP is
                // advanced.  A transient DB failure therefore cannot make a
                // heal appear in a snapshot that was never saved.
                if store.save_profile(id, &profile).is_err() {
                    return;
                }
            }
            if let Some(player) = self.players.get_mut(id) {
                player.state.hp = healed_hp;
            }
            self.emit_recovery_event(id, healed_gain, 0, "recovery");
        }
        if let Some(player) = self.players.get_mut(id) {
            player.beginner_heal_remaining_ticks = next_remaining_ticks;
            player.beginner_heal_next_tick = next_tick;
        }
    }

    /// Apply one authoritative one-second natural-recovery interval.  The
    /// candidate profile is durable before HP/MP advance in memory; a failed
    /// write schedules only the next one-second retry and never replays the
    /// failed interval on every 50 ms tick.
    pub(super) fn step_natural_recovery(&mut self, id: &str) {
        let retry_tick = self.tick.saturating_add(NATURAL_RECOVERY_INTERVAL_TICKS);
        let (state, map_id, death_id, base_max_mp, hp_per_second, mp_per_second) = {
            let Some(player) = self.players.get_mut(id) else {
                return;
            };
            if player.state.hp <= 0 || player.state.action == "dead" {
                player.natural_recovery_next_tick = retry_tick;
                return;
            }
            if player.natural_recovery_next_tick > self.tick {
                return;
            }
            let (hp_per_second, mp_per_second) = regeneration_passives_for_job(player.state.job)
                .into_iter()
                .fold((0_i64, 0_i64), |(hp, mp), passive| {
                    (
                        hp.saturating_add(passive.hp_per_second.max(0)),
                        mp.saturating_add(passive.mp_per_second.max(0)),
                    )
                });
            if player.state.hp >= player.state.max_hp.max(0)
                && player.state.mp >= player.state.max_mp.max(0)
            {
                player.natural_recovery_next_tick = retry_tick;
                return;
            }
            (
                player.state.clone(),
                player.map_id.clone(),
                player.death_id.clone(),
                player.base_max_mp,
                hp_per_second,
                mp_per_second,
            )
        };
        let candidate_hp = state
            .hp
            .saturating_add(hp_per_second)
            .min(state.max_hp.max(0));
        let candidate_mp = state
            .mp
            .saturating_add(mp_per_second)
            .min(state.max_mp.max(0));
        if candidate_hp == state.hp && candidate_mp == state.mp {
            // Full resources consume the interval without issuing an SQLite
            // write, so taking damage immediately after a full interval still
            // waits for a complete new second before recovery.
            if let Some(player) = self.players.get_mut(id) {
                player.natural_recovery_next_tick = retry_tick;
            }
            return;
        }
        let mut candidate = state;
        candidate.hp = candidate_hp;
        candidate.mp = candidate_mp;
        if let Some(store) = self.store.as_ref() {
            if store
                .save_profile(
                    id,
                    &profile_from_state(&candidate, &map_id, &death_id, base_max_mp),
                )
                .is_err()
            {
                if let Some(player) = self.players.get_mut(id) {
                    player.natural_recovery_next_tick = retry_tick;
                }
                return;
            }
        }
        if let Some(player) = self.players.get_mut(id) {
            player.state.hp = candidate_hp;
            player.state.mp = candidate_mp;
            player.natural_recovery_next_tick = retry_tick;
        }
    }

    pub(super) fn buff_duration_ms(&self, id: &str, level: &MageLevel, base_ms: u64) -> u64 {
        let bufftime = self
            .players
            .get(id)
            .and_then(|player| player.state.skills.get(&SKILL_MASTER_MAGIC))
            .copied()
            .and_then(|level| self.mage_skills.level(SKILL_MASTER_MAGIC, level))
            .and_then(|level| level.buff_time_r)
            .unwrap_or(0)
            .max(0) as u64;
        let _ = level;
        base_ms.saturating_mul(100 + bufftime) / 100
    }

    pub(super) fn activate_status_cleanse(&mut self, id: &str, _level: &MageLevel) {
        let Some(player) = self.players.get_mut(id) else {
            return;
        };
        // 楓葉淨化 (Maple Cure) now actually clears the monster-inflicted
        // abnormal statuses modelled below, then re-arms the source's separate
        // three-second immunity window.  The immunity deadline is consumed by
        // the abnormal-status entry point, so a cleanse both removes current
        // diseases and blocks new ones for the authored window.
        //
        // 两件事都收在 `PlayerStatus` 里：`cleanse()` 一次清空全部疾病**并**盖章
        // 免疫窗；增益记录自带 `Release::StatusImmunity`，所以它到期时不需要第二处
        // 去清那个窗口（窗口自己按截止点失效）。
        player.status.cleanse(self.tick, 3_000);
        player
            .status
            .apply_buff(SKILL_MAPLE_CURE, 3_000, self.tick, Release::StatusImmunity);
    }

    /// Resolve the player-side defenses against one monster disease, returning
    /// `true` when the disease is blocked.  The order is authoritative and
    /// mirrors the authored layers:
    ///   1. 楓葉淨化 immunity window (`status_immune_until`) — a fresh cleanse
    ///      blocks everything for its three-second deadline;
    ///   2. 元素適應 charges (`adaptation_charges`) — one charge negates one
    ///      incoming abnormal status and is consumed on use;
    ///   3. 元素適應 status resistance (`asrR`) — a percent chance to shrug it
    ///      off entirely.
    /// A consumed charge / immune window is a real cost, so a blocked disease
    /// still spends the defence rather than being a free no-op.
    pub(super) fn disease_is_blocked(&mut self, id: &str, parts: &[&str]) -> bool {
        // Read the resistance number first (immutable borrow released before
        // the mutable borrow below), then consume the defence layers.
        let resistance = self
            .players
            .get(id)
            .and_then(|player| player.state.skills.get(&SKILL_ELEMENTAL_ADAPTING))
            .copied()
            .and_then(|level| self.mage_skills.level(SKILL_ELEMENTAL_ADAPTING, level))
            .and_then(|level| level.asr_r)
            .unwrap_or(0)
            .clamp(0, 100) as u64;
        let Some(player) = self.players.get_mut(id) else {
            return true;
        };
        if player.status.is_immune() {
            return true;
        }
        if player.adaptation_active && player.adaptation_charges > 0 {
            player.adaptation_charges -= 1;
            return true;
        }
        resistance > 0 && deterministic_percent(parts) < resistance
    }

    /// Inflict one modelled disease on a player, honouring the defence layers
    /// above and writing the authoritative deadline.  The duration comes from
    /// the resolved MobSkill effect (`time` seconds for debuff skills, or the
    /// authored contact `bodyDiseaseLevel`-scaled window).  Returns `false`
    /// when the disease was blocked or the source authored no usable duration.
    pub(super) fn inflict_disease(
        &mut self,
        id: &str,
        disease: Disease,
        duration_ms: u64,
        monster_id: &str,
    ) -> bool {
        if duration_ms == 0 {
            return false;
        }
        let parts = [id, monster_id, disease.as_str(), &self.tick.to_string()];
        if self.disease_is_blocked(id, &parts) {
            return false;
        }
        let Some(player) = self.players.get_mut(id) else {
            return false;
        };
        // 截止点与脉冲节拍都由 `PlayerStatus` 记（每格疾病各自独立，所以一种源
        // 技能不会把另一种挤掉）。
        player.status.apply_disease(disease, duration_ms, self.tick);
        true
    }

    pub(super) fn energy_duration_ms(&self, id: &str) -> u64 {
        let action_speed = self
            .players
            .get(id)
            .map(|player| self.action_speed_bonus(player))
            .unwrap_or(0);
        // P: the source actionSpeed=-1 shortens the 600 ms server animation
        // lock by one 50 ms world tick; damage still resolves in this request.
        (600_i64 + action_speed.saturating_mul(TICK_MS as i64)).clamp(250, 1_000) as u64
    }

    pub(super) fn action_speed_bonus(&self, player: &Player) -> i64 {
        let first = player
            .state
            .skills
            .get(&SKILL_MAGIC_BOOST)
            .and_then(|level| self.mage_skills.level(SKILL_MAGIC_BOOST, *level))
            .and_then(|level| level.action_speed)
            .unwrap_or(0);
        let second = player
            .state
            .skills
            .get(&SKILL_BOOSTER)
            .and_then(|level| self.mage_skills.level(SKILL_BOOSTER, *level))
            .and_then(|level| level.action_speed)
            .or_else(|| {
                self.mage_skills
                    .get(SKILL_BOOSTER)
                    .and_then(|skill| skill.booster_action_speed)
            })
            .unwrap_or(0);
        first.min(0).saturating_add(second.min(0))
    }

    pub(super) fn cast_beginner_throw(
        &mut self,
        id: &str,
        request_id: &str,
        level: &MageLevel,
        skill_level: u32,
    ) -> Result<(), String> {
        let target_id = self.beginner_throw_targets(id).into_iter().next();
        let Some(target_id) = target_id else {
            return Ok(());
        };
        let Some((target_template, target_hp, target_max_hp, target_x, target_y, map_id, quests)) =
            self.monsters.get(&target_id).map(|monster| {
                let quests = self
                    .players
                    .get(id)
                    .map(|player| player.quests.clone())
                    .unwrap_or_default();
                (
                    monster.template.clone(),
                    monster.state.hp,
                    monster.state.max_hp,
                    monster.state.x,
                    monster.state.y,
                    monster.map_id.clone(),
                    quests,
                )
            })
        else {
            return Ok(());
        };
        let damage = level.fixdamage.unwrap_or(0).max(0);
        let killed = damage >= target_hp;
        let applied_damage = damage.min(target_hp.max(0));
        let practice = auth::is_practice_map(&map_id);
        let drops = if killed && !practice {
            self.choose_drops(&target_template, target_x, target_y, id, &quests)
        } else {
            Vec::new()
        };
        let quest_kills = if killed && !practice {
            self.active_kill_objectives(id, &target_template.template_id)
        } else {
            Vec::new()
        };
        let action_request = format!("{request_id}:t{target_id}");
        let action_id = format!("skill-{request_id}-{target_id}");
        let resolution = if let Some(store) = self.store.as_ref() {
            let claim = store.claim_attack(id, &map_id, &action_request, &action_id, "skill")?;
            if claim.resolved {
                return Ok(());
            }
            store.resolve_attack_with_party(
                id,
                &map_id,
                &action_request,
                Some(&target_id),
                applied_damage,
                killed,
                target_template.exp,
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
                target_id: Some(target_id.clone()),
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
            }
        };
        if resolution.already_resolved {
            return Ok(());
        }
        // 击退方向要「远离攻击者」，先把攻击者的 x 取出来（进 `monsters.get_mut`
        // 之后就借不到 `players` 了）。
        let attacker_x = self.players.get(id).map(|player| player.state.x);
        if let Some(monster) = self.monsters.get_mut(&target_id) {
            if resolution.damage > 0 {
                let contribution = monster.damage_by_player.entry(id.to_owned()).or_default();
                *contribution = contribution.saturating_add(resolution.damage);
                // A successful hit is what turns the mob hostile toward this
                // attacker (pursuit resolution happens each step in
                // `step_monsters`).
                mark_monster_hit_aggro(monster, &id, self.tick);
            }
            monster.state.hp = (monster.state.hp - resolution.damage).max(0);
            register_monster_knockback(monster, resolution.damage, attacker_x);
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
            self.broadcast_to_map(
                &map_id,
                &serde_json::json!({
                    "type": "damageEvent",
                    "eventId": format!("damage-event-{id}-{request_id}-{target_id}"),
                    "serverTick": self.tick,
                    "attackerId": id,
                    "targetId": target_id,
                    "x": target_x,
                    "y": target_y,
                    "damage": resolution.damage,
                    "killed": resolution.killed,
                    "skillId": SKILL_THREE_SNAILS,
                    "skillLevel": skill_level,
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
            self.drop_maps.insert(drop_id, map_id.clone());
        }
        if resolution.killed {
            self.apply_quest_kill_credit(id, &quest_kills);
        }
        Ok(())
    }

    pub(super) fn skill_duration_ms(&self, id: &str, skill_id: u32) -> u64 {
        // P: no server hit scheduler is exported for these second-job attacks;
        // resolve all authored attackCount segments immediately and retain a
        // 600 ms action lock (500 ms after action-speed reductions).
        let base = match skill_id {
            SKILL_COLD_BEAM
            | SKILL_THUNDER_BOLT
            | SKILL_ICE_STORM
            | SKILL_GLACIAL_WALL
            | SKILL_THUNDER_SPHERE
            | SKILL_ICE_DEMON
            | SKILL_CHAIN_LIGHTNING
            | SKILL_BLIZZARD
            | SKILL_ICE_DRAGON_BREATH
            | SKILL_FROZEN_ORB => 600,
            _ => SKILL_CAST_DURATION_MS,
        };
        let action_speed = self
            .players
            .get(id)
            .map(|player| self.action_speed_bonus(player))
            .unwrap_or(0);
        (i64::try_from(base).unwrap_or(600) + action_speed * TICK_MS as i64).clamp(250, 1_000)
            as u64
    }

    pub(super) fn plan_teleport(
        &self,
        id: &str,
        level: &MageLevel,
        direction: i8,
        vertical: i8,
    ) -> Result<TeleportPlan, String> {
        let Some(player) = self.players.get(id) else {
            return Err("player_unknown".to_owned());
        };
        if direction == 0 && vertical == 0 {
            return Err("teleport_no_direction".to_owned());
        }
        let map_id = player.map_id.clone();
        let map = self.map_for(&map_id).clone();
        let boost = if player.teleport_boost_enabled {
            self.players
                .get(id)
                .and_then(|player| player.state.skills.get(&SKILL_TELEPORT_BOOST))
                .copied()
                .and_then(|skill_level| self.mage_skills.level(SKILL_TELEPORT_BOOST, skill_level))
        } else {
            None
        };
        let (boost_x, boost_y) = boost
            .map(|level| (level.x.unwrap_or(0).max(0), level.y.unwrap_or(0).max(0)))
            .unwrap_or((0, 0));
        let hyper_distance = if player.hyper_teleport_enabled {
            self.players
                .get(id)
                .and_then(|player| player.state.skills.get(&SKILL_HYPER_TELEPORT_DISTANCE))
                .copied()
                .and_then(|skill_level| {
                    self.mage_skills
                        .level(SKILL_HYPER_TELEPORT_DISTANCE, skill_level)
                })
                .and_then(|value| value.x)
                .unwrap_or(0)
                .max(0)
        } else {
            0
        };
        let horizontal_distance =
            level.x.unwrap_or(0).max(0) as f64 + boost_x as f64 + hyper_distance as f64;
        let vertical_distance_abs = level.y.unwrap_or(0).max(0) as f64 + boost_y as f64;
        let horizontal = horizontal_distance * f64::from(direction);
        let vertical_distance = vertical_distance_abs * f64::from(vertical);
        let mut target_x = (player.state.x + horizontal).clamp(map.bounds.x_min, map.bounds.x_max);
        if direction != 0 && player.state.grounded {
            let wall = map.wall_for(player.foothold_id, direction < 0, player.state.y);
            target_x = if direction < 0 {
                target_x.max(wall)
            } else {
                target_x.min(wall)
            };
        }
        let mut target_y =
            (player.state.y + vertical_distance).clamp(map.bounds.y_min, map.bounds.y_max);
        let mut foothold_id = 0;
        let mut grounded = false;
        if vertical == 0 {
            if let Some((id, ground)) = map.ground_near(target_x, player.state.y) {
                if (ground - player.state.y).abs() <= 24.0 {
                    foothold_id = id;
                    target_y = ground;
                    grounded = true;
                }
            }
        } else if vertical > 0 {
            if let Some((id, ground)) = map.ground_near(target_x, target_y) {
                if ground >= player.state.y - 1.0
                    && ground <= target_y + 24.0
                    && ground - player.state.y <= vertical_distance_abs + 24.0
                {
                    foothold_id = id;
                    target_y = ground;
                    grounded = true;
                }
            }
        }
        if (target_x - player.state.x).abs() < 0.001 && (target_y - player.state.y).abs() < 0.001 {
            return Err("teleport_blocked".to_owned());
        }
        if !target_x.is_finite() || !target_y.is_finite() {
            return Err("teleport_blocked".to_owned());
        }
        Ok(TeleportPlan {
            map_id,
            x: target_x,
            y: target_y,
            foothold_id,
            grounded,
        })
    }

    pub(super) fn apply_teleport(&mut self, id: &str, plan: TeleportPlan) {
        let Some(player) = self.players.get_mut(id) else {
            return;
        };
        player.map_id = plan.map_id;
        player.state.x = plan.x;
        player.state.y = plan.y;
        player.state.vx = 0.0;
        player.state.vy = 0.0;
        player.state.grounded = plan.grounded;
        player.state.climbing = false;
        player.state.ladder_id = None;
        player.state.action_id = None;
        player.state.action = if plan.grounded { "stand" } else { "jump" };
        player.state.action_started_tick = self.tick;
        player.swimming = false;
        player.foothold_id = plan.foothold_id;
        player.last_foothold_id = plan.foothold_id;
        player.drop_fh = 0;
        player.fall_boundary_hold = false;
        player.attack_until = 0;
    }

    pub(super) fn apply_magic_wave(
        &mut self,
        id: &str,
        level: &MageLevel,
        _vertical: i8,
        hidden: bool,
    ) {
        let tick = self.tick;
        let Some(player) = self.players.get_mut(id) else {
            return;
        };
        // Both nodes share one feel: 1.5x the normal jump displacement, then a
        // slow descent at the source's v=95 px/s for the source's time window.
        // The visible node keeps its authored y scaling around that baseline.
        let authored = if hidden {
            1.0
        } else {
            (level.y.unwrap_or(1_200).max(0) as f64 / 1_200.0).clamp(0.75, 1.5)
        };
        player.state.vy = -(JUMP_SPEED * MAGIC_WAVE_LAUNCH_HEIGHT_RATIO.sqrt() * authored);
        player.state.grounded = false;
        player.state.action = "jump";
        player.state.action_started_tick = tick;
        let seconds = level.time.unwrap_or(MAGIC_WAVE_SLOW_FALL_SECONDS).max(0) as u64;
        player.slow_fall_until =
            tick.saturating_add(seconds.saturating_mul(1_000).div_ceil(TICK_MS));
        if hidden {
            player.magic_wave_float_used = true;
        } else {
            player.foothold_id = 0;
            player.magic_wave_used = true;
            player.magic_wave_float_used = false;
        }
    }

    pub(super) fn energy_targets(&self, id: &str, level: &MageLevel) -> Vec<String> {
        let Some(player) = self.players.get(id) else {
            return Vec::new();
        };
        let range = level.range.unwrap_or(0).max(0) as f64;
        let max_targets = level.mob_count.unwrap_or(1).clamp(1, 4) as usize;
        let facing = if player.state.facing < 0 { -1.0 } else { 1.0 };
        let mut candidates = self
            .monsters
            .iter()
            .filter_map(|(monster_id, monster)| {
                if monster.map_id != player.map_id || monster.state.hp <= 0 {
                    return None;
                }
                let dx = (monster.state.x - player.state.x) * facing;
                let dy = (monster.state.y - player.state.y).abs();
                (dx >= 0.0 && dx <= range && dy <= 90.0).then_some((dx, dy, monster_id.clone()))
            })
            .collect::<Vec<_>>();
        candidates.sort_by(|a, b| {
            a.0.total_cmp(&b.0)
                .then_with(|| a.1.total_cmp(&b.1))
                .then_with(|| a.2.cmp(&b.2))
        });
        let Some((_, _, first_id)) = candidates.first().cloned() else {
            return Vec::new();
        };
        let Some(first) = self.monsters.get(&first_id) else {
            return Vec::new();
        };
        let (lt_x, rb_x) = level
            .lt
            .zip(level.rb)
            .map(|(lt, rb)| (lt.x, rb.x))
            .unwrap_or((-120.0, 120.0));
        let (lt_y, rb_y) = level
            .lt
            .zip(level.rb)
            .map(|(lt, rb)| (lt.y, rb.y))
            .unwrap_or((-75.0, 75.0));
        let mut selected = self
            .monsters
            .iter()
            .filter_map(|(monster_id, monster)| {
                if monster.map_id != player.map_id || monster.state.hp <= 0 {
                    return None;
                }
                let dx = monster.state.x - first.state.x;
                let dy = monster.state.y - first.state.y;
                (dx >= lt_x && dx <= rb_x && dy >= lt_y && dy <= rb_y)
                    .then_some(((dx * dx + dy * dy).sqrt(), monster_id.clone()))
            })
            .collect::<Vec<_>>();
        selected.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        selected
            .into_iter()
            .take(max_targets)
            .map(|(_, id)| id)
            .collect()
    }

    pub(super) fn area_targets(&self, id: &str, level: &MageLevel) -> Vec<String> {
        let Some(player) = self.players.get(id) else {
            return Vec::new();
        };
        self.area_targets_at(
            id,
            level,
            player.state.x,
            player.state.y,
            player.state.facing,
        )
    }

    pub(super) fn skill_area_targets(
        &self,
        id: &str,
        skill_id: u32,
        level: &MageLevel,
    ) -> Vec<String> {
        self.area_targets(id, &self.hyper_area_level(id, skill_id, level))
    }

    pub(super) fn hyper_area_level(&self, id: &str, skill_id: u32, level: &MageLevel) -> MageLevel {
        let mut adjusted = level.clone();
        if skill_id == SKILL_CHAIN_LIGHTNING && adjusted.lt.is_none() && adjusted.rb.is_none() {
            // Chain Lightning's source exposes range=420 and y=350 rather
            // than an lt/rb rectangle.  Keep that authored envelope while
            // allowing the Hyper target passive to add two slots.
            let range = adjusted.range.unwrap_or(420).max(0) as f64;
            let vertical = adjusted.y.unwrap_or(350).abs() as f64;
            adjusted.lt = Some(crate::mage::MagePoint {
                x: -range,
                y: -vertical,
            });
            adjusted.rb = Some(crate::mage::MagePoint {
                x: range,
                y: vertical,
            });
        }
        let target_plus_id = match skill_id {
            SKILL_TELEPORT_MASTERY => Some(SKILL_HYPER_TELEPORT_TARGET),
            SKILL_CHAIN_LIGHTNING => Some(SKILL_HYPER_CHAIN_TARGET),
            SKILL_ICE_DEMON => Some(SKILL_HYPER_ICE_TARGET),
            _ => None,
        };
        if let Some(passive_id) = target_plus_id {
            let learned = self
                .players
                .get(id)
                .and_then(|player| player.state.skills.get(&passive_id))
                .copied()
                .unwrap_or(0);
            if learned > 0 {
                let plus = self
                    .mage_skills
                    .level(passive_id, learned)
                    .and_then(|value| value.target_plus)
                    .unwrap_or(0);
                adjusted.mob_count =
                    Some(adjusted.mob_count.unwrap_or(1).saturating_add(plus).min(15));
            }
        }
        adjusted
    }

    pub(super) fn area_targets_at(
        &self,
        id: &str,
        level: &MageLevel,
        origin_x: f64,
        origin_y: f64,
        facing: i8,
    ) -> Vec<String> {
        let Some(player) = self.players.get(id) else {
            return Vec::new();
        };
        let (lt, rb) = level.lt.zip(level.rb).map(|(lt, rb)| (lt, rb)).unwrap_or((
            crate::mage::MagePoint {
                x: -250.0,
                y: -75.0,
            },
            crate::mage::MagePoint { x: 250.0, y: 75.0 },
        ));
        let max_targets = level.mob_count.unwrap_or(1).clamp(1, 15) as usize;
        let facing = if facing < 0 { -1.0 } else { 1.0 };
        let mut candidates = self
            .monsters
            .iter()
            .filter_map(|(monster_id, monster)| {
                if monster.map_id != player.map_id || monster.state.hp <= 0 {
                    return None;
                }
                // WZ rectangles are authored facing left; mirroring the local
                // x coordinate keeps the source lt/rb geometry for both ways.
                let local_x = -((monster.state.x - origin_x) * facing);
                let local_y = monster.state.y - origin_y;
                (local_x >= lt.x && local_x <= rb.x && local_y >= lt.y && local_y <= rb.y)
                    .then_some(((monster.state.x - origin_x).abs(), monster_id.clone()))
            })
            .collect::<Vec<_>>();
        candidates.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        candidates
            .into_iter()
            .take(max_targets)
            .map(|(_, id)| id)
            .collect()
    }

    pub(super) fn apply_meditation(&mut self, id: &str, level: &MageLevel) {
        let duration_ms =
            self.buff_duration_ms(id, level, level.time.unwrap_or(40).max(0) as u64 * 1_000);
        let mad = level.indie_mad.unwrap_or(10).max(0);
        // With a party model the buff finally has someone to reach: it now
        // applies to the party members actually standing on the caster's map.
        // `party_members_on_map` returns the caster alone when there is no
        // party, so solo behaviour is unchanged.  P: the source still has no
        // party-target contract; the level/floor rules are untouched.
        let targets = self.party_members_on_map(id);
        let until = self.tick.saturating_add(duration_ms.div_ceil(TICK_MS));
        for target in targets {
            let Some(player) = self.players.get_mut(&target) else {
                continue;
            };
            player.meditation_mad = mad;
            player.meditation_until = until;
        }
    }

    pub(super) fn maybe_absorb_monster_mp(&mut self, id: &str, target_id: &str) {
        let level = self
            .players
            .get(id)
            .and_then(|player| player.state.skills.get(&SKILL_MANA_ABSORB))
            .copied()
            .and_then(|level| self.mage_skills.level(SKILL_MANA_ABSORB, level).cloned());
        let Some(level) = level else {
            return;
        };
        let prop = level.prop.unwrap_or(0).clamp(0, 100);
        if prop == 0 || rand::thread_rng().gen_range(0..100) >= prop {
            return;
        }
        let Some((remaining, max_mp, boss)) = self.monsters.get(target_id).map(|monster| {
            (
                monster.mp.max(0),
                monster.template.max_mp.max(0),
                monster.template.boss,
            )
        }) else {
            return;
        };
        if remaining == 0 || max_mp == 0 {
            return;
        }
        let percent = if boss {
            level.y.unwrap_or(0)
        } else {
            level.x.unwrap_or(0)
        }
        .clamp(0, 100);
        // The WZ x/y expressions are percentages of the mob's maximum MP;
        // clamp the result to the mob's current remaining pool and the
        // player's current MP capacity.  Zero after integer truncation is a
        // valid source result and does not mint a point of MP.
        let amount = max_mp.saturating_mul(percent) / 100;
        let amount = amount.min(remaining);
        if amount == 0 {
            return;
        }
        let Some(monster) = self.monsters.get_mut(target_id) else {
            return;
        };
        monster.mp = monster.mp.saturating_sub(amount);
        if let Some(player) = self.players.get_mut(id) {
            player.state.mp = player
                .state
                .mp
                .saturating_add(amount)
                .min(player.state.max_mp);
        }
    }

    pub(super) fn freeze_target(&mut self, target_id: &str, delta: i32) -> u32 {
        let Some(monster) = self.monsters.get_mut(target_id) else {
            return 0;
        };
        let expired = monster.freeze_until <= self.tick;
        let current = if expired {
            0
        } else {
            monster.state.freeze_stacks.unwrap_or(0)
        };
        // P: freeze is authoritative movement lock for the exported v=-75
        // slow value; the source s/v physics effect is not otherwise applied.
        let next = if delta >= 0 {
            current
                .saturating_add(u32::try_from(delta).unwrap_or(0))
                .min(ICE_FREEZE_STACK_CAP)
        } else {
            current.saturating_sub(delta.unsigned_abs())
        };
        monster.state.freeze_stacks = (next > 0).then_some(next);
        if next > 0 {
            monster.freeze_until = self
                .tick
                .saturating_add(ICE_FREEZE_DURATION_MS.div_ceil(TICK_MS));
            monster.state.action = "freeze";
            monster.state.action_started_tick = self.tick;
        } else {
            monster.freeze_until = 0;
            if monster.state.action == "freeze" {
                monster.state.action = if monster.template.can_move() {
                    "move"
                } else {
                    "stand"
                };
                monster.state.action_started_tick = self.tick;
            }
        }
        next
    }

    pub(super) fn magic_critical_chance(&self, id: &str) -> i64 {
        let Some(player) = self.players.get(id) else {
            return 0;
        };
        let mastery_crit = player
            .state
            .skills
            .get(&SKILL_SPELL_MASTERY)
            .and_then(|level| self.mage_skills.level(SKILL_SPELL_MASTERY, *level))
            .and_then(|level| level.cr)
            .unwrap_or(0);
        let third_crit = player
            .state
            .skills
            .get(&SKILL_MAGIC_CRITICAL)
            .and_then(|level| self.mage_skills.level(SKILL_MAGIC_CRITICAL, *level))
            .and_then(|level| level.cr)
            .unwrap_or(0);
        let wand_crit = player
            .state
            .skills
            .get(&SKILL_MAGIC_BOOST)
            .is_some_and(|level| *level > 0)
            && player.state.equipped.iter().any(|item| {
                item.slot == 11
                    && item
                        .item_id
                        .parse::<i64>()
                        .ok()
                        .is_some_and(|item_id| item_id / 10_000 == 137)
            });
        let hyper_ice_crit = player
            .state
            .skills
            .get(&SKILL_HYPER_ICE_CRIT)
            .copied()
            .and_then(|level| self.mage_skills.level(SKILL_HYPER_ICE_CRIT, level))
            .and_then(|level| level.cr)
            .unwrap_or(0)
            .max(0);
        (mastery_crit + third_crit + hyper_ice_crit + if wand_crit { 5 } else { 0 }).clamp(0, 100)
    }

    /// 魔法技能命中一次的**可解释求值**：把该技能的全部玩家侧修正来源收齐，
    /// 交给 [`DamagePipeline`] 统一求值。分组（加算 / 独立乘算 / 暴击）、取整层与
    /// 上限层的口径全在 `damage.rs` 的模块头，这里只负责「说出有哪些来源」。
    ///
    /// `pre` 是「命中本身携带、但不由技能表决定」的前置修正（元素弱化的 `x`、
    /// 被消耗掉的冻结层的 `x`/`y`）：调用点算出**百分比与来源**，求值仍走同一处。
    pub(super) fn magic_damage_breakdown(
        &self,
        id: &str,
        skill_id: u32,
        target_id: &str,
        base_damage: i64,
        critical: bool,
        request_id: &str,
        segment: u32,
        pre: &[(DamageSource, i64)],
    ) -> DamageBreakdown {
        let Some(target) = self.monsters.get(target_id) else {
            // 目标已经不在了：不做任何修正，如实返回基准。
            return DamagePipeline::new(base_damage.max(1)).resolve();
        };
        let mut pipeline = DamagePipeline::new(base_damage);
        // 冻结层拆解 → 无视魔法防御。层数上限来自源（五层），每层独立掷一次。
        let frozen_stacks = target
            .state
            .freeze_stacks
            .unwrap_or(0)
            .min(ICE_FREEZE_STACK_CAP);
        let frozen_break = self
            .players
            .get(id)
            .and_then(|player| player.state.skills.get(&SKILL_FROZEN_BREAK))
            .copied()
            .and_then(|level| self.mage_skills.level(SKILL_FROZEN_BREAK, level));
        let mut ignored_md_rate = 0_i64;
        if let Some(level) = frozen_break {
            let prop = level.prop.unwrap_or(0).clamp(0, 100) as u64;
            let sub_prop = level.sub_prop.unwrap_or(0).clamp(0, 100) as u64;
            for layer in 0..frozen_stacks {
                let roll = deterministic_percent(&[
                    id,
                    request_id,
                    target_id,
                    &segment.to_string(),
                    &layer.to_string(),
                ]);
                // subProp is the per-layer chance; a successful layer adds
                // prop percent of magic defense ignore, capped at five layers.
                if roll < sub_prop {
                    ignored_md_rate = ignored_md_rate.saturating_add(prop as i64);
                }
            }
        }
        let (mystic_ignore, mystic_bonus, infinity_bonus) = self
            .players
            .get(id)
            .map(|player| {
                let mystic = player
                    .state
                    .skills
                    .get(&SKILL_MYSTIC_STRIKE)
                    .copied()
                    .and_then(|level| self.mage_skills.level(SKILL_MYSTIC_STRIKE, level));
                (
                    mystic
                        .and_then(|level| level.ignore_mob_pdp_r)
                        .unwrap_or(0)
                        .clamp(0, 100),
                    if is_nonsummon_direct_skill(skill_id) {
                        mystic
                            .and_then(|level| level.x)
                            .unwrap_or(0)
                            .max(0)
                            .saturating_mul(i64::from(player.mystic_strike_stacks))
                    } else {
                        0
                    },
                    if player.status.buff_active(SKILL_INFINITY) {
                        player.infinity_damage_bonus.max(0)
                    } else {
                        0
                    },
                )
            })
            .unwrap_or((0, 0, 0));
        ignored_md_rate = ignored_md_rate.saturating_add(mystic_ignore);
        let bind_md_rate = (target.bind_until > self.tick)
            .then_some(target.bind_md_rate_reduction)
            .unwrap_or(0)
            .clamp(0, 100) as f64;
        if let Some(md_rate) = target.template.md_rate {
            // 目标侧减免是既有的第 0 层（公式逐字保留），无视防御只作用于它。
            pipeline.apply_target_mitigation((md_rate - bind_md_rate).max(0.0), ignored_md_rate);
        }
        for (source, percent) in pre {
            pipeline.add(*source, *percent);
        }
        // 源 `damR`（总伤害，加算组）与源 `indieDamR`（独立乘算组）**分组不同**，
        // 改前它们被写进同一个百分比、乘在同一步里 ⇒ 同一份源数据两条路径两种口径。
        let hyper_passive = match skill_id {
            SKILL_TELEPORT_MASTERY => SKILL_HYPER_TELEPORT_DAMAGE,
            SKILL_CHAIN_LIGHTNING => SKILL_HYPER_CHAIN_DAMAGE,
            SKILL_ICE_DEMON => SKILL_HYPER_ICE_DAMAGE,
            _ => 0,
        };
        if hyper_passive != 0 {
            let passive_bonus = self
                .players
                .get(id)
                .and_then(|player| player.state.skills.get(&hyper_passive))
                .copied()
                .and_then(|level| self.mage_skills.level(hyper_passive, level))
                .and_then(|level| level.dam_r)
                .unwrap_or(0)
                .max(0);
            pipeline.add(
                DamageSource::DamageRate {
                    skill_id: hyper_passive,
                },
                passive_bonus,
            );
        }
        if let Some(player) = self.players.get(id) {
            if player.status.buff_active(SKILL_HYPER_ADVENTURER) {
                pipeline.add(
                    DamageSource::IndependentDamageRate {
                        skill_id: SKILL_HYPER_ADVENTURER,
                    },
                    hyper_adventurer_damage_percent(&self.mage_skills, player),
                );
            }
        }
        let amp = self
            .players
            .get(id)
            .and_then(|player| player.state.skills.get(&SKILL_ELEMENT_AMP))
            .copied()
            .and_then(|level| self.mage_skills.level(SKILL_ELEMENT_AMP, level))
            .and_then(|level| level.dam_r)
            .unwrap_or(0)
            .max(0);
        if is_magic_attack_skill(skill_id) {
            pipeline.add(
                DamageSource::DamageRate {
                    skill_id: SKILL_ELEMENT_AMP,
                },
                amp,
            );
        }
        let reset = self
            .players
            .get(id)
            .and_then(|player| player.state.skills.get(&SKILL_ELEMENTAL_RESET))
            .copied()
            .and_then(|level| self.mage_skills.level(SKILL_ELEMENTAL_RESET, level))
            .and_then(|level| level.md_r)
            .unwrap_or(0)
            .max(0);
        // P: no current mob export carries an elemental-resistance target, so
        // source `u` is intentionally not applied to mdRate.  mdR is the
        // independent final-damage multiplier and always applies here.
        pipeline.add(
            DamageSource::UnmarkedField {
                skill_id: SKILL_ELEMENTAL_RESET,
                field: "mdR",
            },
            reset,
        );
        let extreme = self
            .players
            .get(id)
            .and_then(|player| player.state.skills.get(&SKILL_EXTREME_MAGIC))
            .copied()
            .and_then(|level| self.mage_skills.level(SKILL_EXTREME_MAGIC, level))
            .and_then(|level| level.z)
            .unwrap_or(0)
            .max(0);
        let has_status =
            target.state.freeze_stacks.unwrap_or(0) > 0 || target.stun_until > self.tick;
        if has_status {
            pipeline.add(
                DamageSource::UnmarkedField {
                    skill_id: SKILL_EXTREME_MAGIC,
                    field: "z",
                },
                extreme,
            );
        }
        if critical {
            let critical_damage = self
                .players
                .get(id)
                .and_then(|player| player.state.skills.get(&SKILL_MAGIC_CRITICAL))
                .copied()
                .and_then(|level| self.mage_skills.level(SKILL_MAGIC_CRITICAL, level))
                .and_then(|level| level.critical_damage)
                .unwrap_or(0)
                .max(0);
            // 暴击组的基准是 200：没学 魔法爆擊 时 `criticaldamage = 0`，仍是 ×2。
            pipeline.add(
                DamageSource::CriticalDamage {
                    skill_id: SKILL_MAGIC_CRITICAL,
                },
                critical_damage,
            );
        }
        pipeline.add(
            DamageSource::UnmarkedField {
                skill_id: SKILL_MYSTIC_STRIKE,
                field: "x",
            },
            mystic_bonus,
        );
        pipeline.add(
            DamageSource::UnmarkedField {
                skill_id: SKILL_INFINITY,
                field: "damage",
            },
            infinity_bonus,
        );
        pipeline.add(
            DamageSource::RegionGuard,
            self.boss_damage_multiplier(&target.map_id, true) - 100,
        );
        pipeline.resolve()
    }

    /// 一次魔法命中的伤害数字。签名与改前相同，便于既有验收与调用点不动；
    /// 本体就是上面那条管线取权威值。
    #[cfg_attr(not(test), allow(dead_code))] // 生产调用点都要传 `pre`，走 `magic_damage_breakdown`
    pub(super) fn magic_damage_with_passives(
        &self,
        id: &str,
        skill_id: u32,
        target_id: &str,
        base_damage: i64,
        critical: bool,
        request_id: &str,
        segment: u32,
    ) -> i64 {
        self.magic_damage_breakdown(
            id,
            skill_id,
            target_id,
            base_damage,
            critical,
            request_id,
            segment,
            &[],
        )
        .total()
    }

    pub(super) fn advance_mystic_strike(&mut self, id: &str, request_id: &str, target_id: &str) {
        let Some(level) = self
            .players
            .get(id)
            .and_then(|player| player.state.skills.get(&SKILL_MYSTIC_STRIKE))
            .copied()
            .and_then(|level| self.mage_skills.level(SKILL_MYSTIC_STRIKE, level).cloned())
        else {
            return;
        };
        let prop = level.prop.unwrap_or(0).clamp(0, 100) as u64;
        if prop == 0 || deterministic_percent(&[id, request_id, target_id, "mystic-strike"]) >= prop
        {
            return;
        }
        let cap = u32::try_from(level.y.unwrap_or(5).max(0))
            .unwrap_or(5)
            .min(5);
        let duration_ticks = u64::try_from(level.time.unwrap_or(5).max(0))
            .unwrap_or(5)
            .saturating_mul(1_000)
            .div_ceil(TICK_MS)
            .max(1);
        if let Some(player) = self.players.get_mut(id) {
            player.mystic_strike_stacks = player.mystic_strike_stacks.saturating_add(1).min(cap);
            player.mystic_strike_until = self.tick.saturating_add(duration_ticks);
        }
    }

    pub(super) fn cast_elemental_area(
        &mut self,
        id: &str,
        request_id: &str,
        skill_id: u32,
        level: &MageLevel,
        lightning: bool,
    ) -> Result<(), String> {
        self.cast_elemental_area_at(id, request_id, skill_id, level, lightning, None)
    }

    pub(super) fn cast_elemental_area_at(
        &mut self,
        id: &str,
        request_id: &str,
        skill_id: u32,
        level: &MageLevel,
        lightning: bool,
        origin: Option<(f64, f64, i8)>,
    ) -> Result<(), String> {
        self.cast_elemental_area_at_filtered(
            id, request_id, skill_id, level, lightning, origin, None,
        )
    }

    pub(super) fn cast_elemental_area_at_filtered(
        &mut self,
        id: &str,
        request_id: &str,
        skill_id: u32,
        level: &MageLevel,
        lightning: bool,
        origin: Option<(f64, f64, i8)>,
        excluded: Option<&BTreeSet<String>>,
    ) -> Result<(), String> {
        let target_level = self.hyper_area_level(id, skill_id, level);
        let targets = origin
            .map(|(x, y, facing)| self.area_targets_at(id, &target_level, x, y, facing))
            .unwrap_or_else(|| self.area_targets(id, &target_level))
            .into_iter()
            .filter(|target_id| excluded.is_none_or(|excluded| !excluded.contains(target_id)))
            .collect::<Vec<_>>();
        let mut attack_count = level.attack_count.unwrap_or(1).clamp(
            1,
            if skill_id == SKILL_HYPER_THUNDER {
                15
            } else {
                12
            },
        );
        if skill_id == SKILL_CHAIN_LIGHTNING {
            let learned = self
                .players
                .get(id)
                .and_then(|player| player.state.skills.get(&SKILL_HYPER_CHAIN_ATTACK))
                .copied()
                .unwrap_or(0);
            if learned > 0 {
                let extra = self
                    .mage_skills
                    .level(SKILL_HYPER_CHAIN_ATTACK, learned)
                    .and_then(|value| value.attack_count)
                    .unwrap_or(1);
                attack_count = attack_count.saturating_add(extra).min(12);
            }
        }
        let target_count = targets.len();
        let lightning_effect = lightning || skill_id == SKILL_CHAIN_LIGHTNING;
        let magic_attack = self
            .players
            .get(id)
            .map(|player| player.state.derived_stats.magic_attack)
            .unwrap_or(1)
            .max(1);
        let mut consumed = BTreeMap::new();
        let mut successful_direct_targets = BTreeSet::new();
        for target_id in &targets {
            if lightning_effect {
                if self
                    .monsters
                    .get(target_id)
                    .is_some_and(|monster| monster.freeze_until <= self.tick)
                {
                    self.freeze_target(target_id, 0);
                }
                if self
                    .monsters
                    .get(target_id)
                    .and_then(|monster| monster.state.freeze_stacks)
                    .is_some_and(|stacks| stacks > 0)
                {
                    consumed.insert(
                        target_id.clone(),
                        self.monsters
                            .get(target_id)
                            .and_then(|monster| monster.state.freeze_stacks)
                            .unwrap_or(0),
                    );
                }
            }
        }
        // Preserve the existing freeze-effect coverage for every elemental
        // area source, including summons and the hidden Blizzard follow-up.
        // Fourth-job fixed level replaces the third-job node when both are
        // present; it must never create two independent layers.
        let fixed_effect = {
            let fourth = self
                .players
                .get(id)
                .and_then(|player| player.state.skills.get(&SKILL_FOURTH_FREEZE))
                .copied()
                .and_then(|level| self.mage_skills.level(SKILL_FOURTH_FREEZE, level))
                .map(|level| {
                    (
                        SKILL_FOURTH_FREEZE,
                        level.x.unwrap_or(0).max(0),
                        level.y.unwrap_or(0).max(0),
                    )
                });
            fourth.or_else(|| {
                self.players
                    .get(id)
                    .and_then(|player| player.state.skills.get(&SKILL_ICE_EFFECT))
                    .copied()
                    .and_then(|level| self.mage_skills.level(SKILL_ICE_EFFECT, level))
                    .map(|level| {
                        (
                            SKILL_ICE_EFFECT,
                            level.x.unwrap_or(0).max(0),
                            level.y.unwrap_or(0).max(0),
                        )
                    })
            })
        };
        // 冻结层加成带着**它的来源技能 id** 一起走：管线的诊断串要说清是哪一层来的。
        let freeze_layer_skill = fixed_effect.map(|effect| effect.0);
        let fixed_crit = fixed_effect.map(|effect| effect.1).unwrap_or(0);
        let fixed_lightning = fixed_effect.map(|effect| effect.2).unwrap_or(0);
        if !lightning_effect && fixed_effect.is_some() {
            for target_id in &targets {
                if let Some(stacks) = self
                    .monsters
                    .get(target_id)
                    .and_then(|monster| monster.state.freeze_stacks)
                {
                    if stacks > 0 {
                        consumed.insert(target_id.clone(), stacks);
                    }
                }
            }
        }
        let critical_chance = self
            .magic_critical_chance(id)
            .saturating_add(
                (skill_id == SKILL_CHAIN_LIGHTNING)
                    .then_some(level.cr.unwrap_or(0).max(0))
                    .unwrap_or(0),
            )
            .clamp(0, 100);
        let weaken_level = self
            .players
            .get(id)
            .and_then(|player| player.state.skills.get(&SKILL_ELEMENTAL_WEAKEN))
            .copied()
            .unwrap_or(0);
        let weaken = self
            .mage_skills
            .level(SKILL_ELEMENTAL_WEAKEN, weaken_level)
            .cloned();
        for segment in 1..=attack_count {
            for target_id in &targets {
                if self
                    .monsters
                    .get(target_id)
                    .is_none_or(|monster| monster.state.hp <= 0)
                {
                    continue;
                }
                let (target_hp, target_max_hp, target_template, target_x, target_y, map_id, quests) =
                    match self.monsters.get(target_id) {
                        Some(monster) => (
                            monster.state.hp,
                            monster.state.max_hp,
                            monster.template.clone(),
                            monster.state.x,
                            monster.state.y,
                            monster.map_id.clone(),
                            self.players
                                .get(id)
                                .map(|player| player.quests.clone())
                                .unwrap_or_default(),
                        ),
                        None => continue,
                    };
                let normal_bonus = if !target_template.boss
                    && matches!(skill_id, SKILL_THUNDER_SPHERE | SKILL_THUNDER_SPHERE_HIDDEN)
                {
                    level.u2.unwrap_or(0).max(0)
                } else {
                    0
                };
                let multiplier = level
                    .damage
                    .unwrap_or(1)
                    .max(1)
                    .saturating_add(normal_bonus);
                let mut damage = (magic_attack as f64 * multiplier as f64 / 100.0)
                    .floor()
                    .max(1.0) as i64;
                if weaken.as_ref().is_some_and(|_| {
                    rand::thread_rng().gen_range(0..100)
                        < weaken
                            .as_ref()
                            .and_then(|level| level.prop)
                            .unwrap_or(0)
                            .clamp(0, 100)
                }) {
                    if let Some(monster) = self.monsters.get_mut(target_id) {
                        let seconds = weaken
                            .as_ref()
                            .and_then(|value| value.time)
                            .unwrap_or(5)
                            .max(0) as u64;
                        monster.elemental_weaken_until = self
                            .tick
                            .saturating_add(seconds.saturating_mul(1_000).div_ceil(TICK_MS));
                    }
                }
                let critical = rand::thread_rng().gen_range(0..100) < critical_chance;
                // 命中携带的前置修正：只交出**来源 + 百分比**，求值仍走同一条管线
                // （分组、取整层与上限层的口径见 `damage.rs` 模块头）。
                let mut pre: Vec<(DamageSource, i64)> = Vec::new();
                if self
                    .monsters
                    .get(target_id)
                    .is_some_and(|monster| monster.elemental_weaken_until > self.tick)
                {
                    pre.push((
                        DamageSource::UnmarkedField {
                            skill_id: SKILL_ELEMENTAL_WEAKEN,
                            field: "x",
                        },
                        weaken
                            .as_ref()
                            .and_then(|level| level.x)
                            .unwrap_or(20)
                            .max(0),
                    ));
                }
                if let Some(stacks) = consumed.get(target_id).copied() {
                    if let Some(skill_id) = freeze_layer_skill {
                        let layer_bonus = if lightning_effect { fixed_lightning } else { 0 }
                            .saturating_add(if critical { fixed_crit } else { 0 });
                        pre.push((
                            DamageSource::FreezeLayerBonus { skill_id },
                            layer_bonus.saturating_mul(i64::from(stacks)),
                        ));
                    }
                }
                damage = self
                    .magic_damage_breakdown(
                        id, skill_id, target_id, damage, critical, request_id, segment, &pre,
                    )
                    .total();
                let killed = damage >= target_hp;
                let applied_damage = damage.min(target_hp.max(0));
                let practice = auth::is_practice_map(&map_id);
                let drops = if killed && !practice {
                    self.choose_drops(&target_template, target_x, target_y, id, &quests)
                } else {
                    Vec::new()
                };
                let quest_kills = if killed && !practice {
                    self.active_kill_objectives(id, &target_template.template_id)
                } else {
                    Vec::new()
                };
                let action_request = format!("{request_id}:s{segment}:t{target_id}");
                let action_id = format!("skill-{request_id}-{segment}-{target_id}");
                let resolution = if let Some(store) = self.store.as_ref() {
                    let claim =
                        store.claim_attack(id, &map_id, &action_request, &action_id, "skill")?;
                    if claim.resolved {
                        continue;
                    }
                    store.resolve_attack_with_party(
                        id,
                        &map_id,
                        &action_request,
                        Some(target_id),
                        applied_damage,
                        killed,
                        target_template.exp,
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
                        target_id: Some(target_id.clone()),
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
                    }
                };
                if resolution.already_resolved {
                    continue;
                }
                // 同上：攻击者位置要在借走 `monsters` 之前取。
                let attacker_x = self.players.get(id).map(|player| player.state.x);
                if resolution.damage > 0 && is_nonsummon_direct_skill(skill_id) {
                    self.advance_mystic_strike(id, request_id, target_id);
                    successful_direct_targets.insert(target_id.clone());
                }
                if let Some(monster) = self.monsters.get_mut(target_id) {
                    monster.state.hp = (monster.state.hp - resolution.damage).max(0);
                    register_monster_knockback(monster, resolution.damage, attacker_x);
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
                        &map_id,
                        &serde_json::json!({
                            "type": "damageEvent",
                            "eventId": format!("damage-event-{id}-{request_id}-{segment}-{target_id}"),
                            "serverTick": self.tick,
                            "attackerId": id,
                            "targetId": target_id,
                            "x": target_x,
                            "y": target_y,
                            "damage": resolution.damage,
                            "killed": resolution.killed,
                            "skillId": skill_id,
                            "segment": segment,
                            "targetCount": target_count,
                            "critical": critical,
                        })
                        .to_string(),
                    );
                }
                if !resolution.profiles.is_empty() {
                    for (participant, profile) in resolution.profiles {
                        if let Some(player) = self.players.get_mut(&participant) {
                            apply_profile_to_player(
                                &self.gameplay,
                                &self.mage_skills,
                                player,
                                profile,
                            );
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
                if segment == 1 {
                    // Apply absorption after a stored resolution profile so
                    // the MP delta cannot be overwritten by the old profile.
                    self.maybe_absorb_monster_mp(id, target_id);
                }
                if lightning_effect
                    && segment == 1
                    && fixed_effect.is_some()
                    && consumed.contains_key(target_id)
                {
                    // Consume one fixed-effect layer only after the attack
                    // resolution succeeds, so a persistent replay/failure
                    // cannot spend a freeze stack.
                    self.freeze_target(target_id, -1);
                }
                if !lightning
                    && skill_id != SKILL_CHAIN_LIGHTNING
                    && segment == 1
                    && resolution.damage > 0
                    && self
                        .monsters
                        .get(target_id)
                        .is_some_and(|monster| monster.state.hp > 0)
                {
                    // Freeze is a post-resolution effect.  This prevents a
                    // failed/duplicate DB claim from leaving a free stack,
                    // and the same cast cannot consume the stack it creates.
                    self.freeze_target(target_id, 1);
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
                    self.drop_maps.insert(drop_id, map_id.clone());
                }
                if resolution.killed {
                    self.apply_quest_kill_credit(id, &quest_kills);
                }
            }
        }
        if is_nonsummon_direct_skill(skill_id) && skill_id != SKILL_BLIZZARD_HIDDEN {
            if !successful_direct_targets.is_empty() {
                let index = deterministic_percent(&[id, request_id, "blizzard-target"]) as usize
                    % successful_direct_targets.len();
                if let Some(target_id) = successful_direct_targets.iter().nth(index).cloned() {
                    self.maybe_cast_blizzard_follow_up(id, request_id, &target_id)?;
                }
            }
        }
        Ok(())
    }

    pub(super) fn cast_thunder_sphere(
        &mut self,
        id: &str,
        request_id: &str,
        level: &MageLevel,
        vertical: i8,
    ) -> Result<(), String> {
        let Some(player_snapshot) = self.players.get(id).map(|player| {
            (
                player.map_id.clone(),
                player.state.x,
                player.state.y,
                player.state.facing,
                player.summon.clone(),
            )
        }) else {
            return Err("player_unknown".to_owned());
        };
        let (map_id, x, y, facing, existing) = player_snapshot;
        let hidden_level = self
            .mage_skills
            .level(
                SKILL_THUNDER_SPHERE_HIDDEN,
                self.players
                    .get(id)
                    .and_then(|player| player.state.skills.get(&SKILL_THUNDER_SPHERE))
                    .copied()
                    .unwrap_or(1),
            )
            .cloned()
            .unwrap_or_else(|| level.clone());
        let anchor = vertical > 0;
        let duration_source = if anchor {
            hidden_level.time.unwrap_or(20)
        } else {
            level.time.unwrap_or(60)
        };
        let duration_ticks = u64::try_from(duration_source.max(0))
            .unwrap_or(if anchor { 20 } else { 60 })
            .saturating_mul(1_000)
            .div_ceil(TICK_MS)
            .max(1);
        if let Some(existing) = existing
            .clone()
            .filter(|summon| {
                summon.skill_id == SKILL_THUNDER_SPHERE
                    || summon.skill_id == SKILL_THUNDER_SPHERE_HIDDEN
            })
            .filter(|_| anchor)
        {
            if let Some(player) = self.players.get_mut(id) {
                player.summon = Some(ThunderSummon {
                    x,
                    y,
                    facing,
                    anchored: true,
                    skill_id: SKILL_THUNDER_SPHERE_HIDDEN,
                    expires_at: existing
                        .expires_at
                        .min(self.tick.saturating_add(duration_ticks)),
                    ..existing
                });
            }
            return Ok(());
        }
        let summon = ThunderSummon {
            summon_id: format!("thunder-sphere-{id}-{request_id}"),
            skill_id: if anchor {
                SKILL_THUNDER_SPHERE_HIDDEN
            } else {
                SKILL_THUNDER_SPHERE
            },
            level: self
                .players
                .get(id)
                .and_then(|player| player.state.skills.get(&SKILL_THUNDER_SPHERE))
                .copied()
                .unwrap_or(1),
            map_id,
            x,
            y,
            facing,
            anchored: anchor,
            expires_at: self.tick.saturating_add(duration_ticks),
            next_hit_at: self.tick,
            pulse_index: 0,
        };
        if let Some(player) = self.players.get_mut(id) {
            player.summon = Some(summon);
        }
        Ok(())
    }

    pub(super) fn cast_energy_bolt(
        &mut self,
        id: &str,
        request_id: &str,
        skill_id: u32,
        level: &MageLevel,
    ) -> Result<(), String> {
        let targets = self.energy_targets(id, level);
        let attack_count = level.attack_count.unwrap_or(1).clamp(1, 4);
        let target_count = targets.len();
        let magic_attack = self
            .players
            .get(id)
            .map(|player| player.state.derived_stats.magic_attack)
            .unwrap_or(1)
            .max(1);
        let critical_chance = self.magic_critical_chance(id);
        let mut successful_direct_targets = BTreeSet::new();
        for segment in 1..=attack_count {
            for target_id in &targets {
                if self
                    .monsters
                    .get(target_id)
                    .is_none_or(|monster| monster.state.hp <= 0)
                {
                    continue;
                }
                let (target_template, target_hp, target_max_hp, target_x, target_y, map_id, quests) =
                    match self.monsters.get(target_id) {
                        Some(monster) => {
                            let quests = self
                                .players
                                .get(id)
                                .map(|player| player.quests.clone())
                                .unwrap_or_default();
                            (
                                monster.template.clone(),
                                monster.state.hp,
                                monster.state.max_hp,
                                monster.state.x,
                                monster.state.y,
                                monster.map_id.clone(),
                                quests,
                            )
                        }
                        None => continue,
                    };
                let damage_percent = level.damage.unwrap_or(1).max(1) as f64 / 100.0;
                let mut damage = (magic_attack as f64 * damage_percent).floor().max(1.0) as i64;
                let mut critical = false;
                let weaken_level = self
                    .players
                    .get(id)
                    .and_then(|player| player.state.skills.get(&SKILL_ELEMENTAL_WEAKEN))
                    .copied()
                    .unwrap_or(0);
                if weaken_level > 0 {
                    let weaken = self.mage_skills.level(SKILL_ELEMENTAL_WEAKEN, weaken_level);
                    let prop = weaken
                        .and_then(|value| value.prop)
                        .unwrap_or(0)
                        .clamp(0, 100);
                    let applies = rand::thread_rng().gen_range(0..100) < prop;
                    if applies {
                        let seconds =
                            weaken.and_then(|value| value.time).unwrap_or(5).max(0) as u64;
                        if let Some(monster) = self.monsters.get_mut(target_id) {
                            monster.elemental_weaken_until = self
                                .tick
                                .saturating_add(seconds.saturating_mul(1_000).div_ceil(TICK_MS));
                        }
                    }
                }
                // P/R: Character/Weapon 1372000's source display flag carries
                // cr=5; second-job Spell Mastery adds its exported `cr`.
                if rand::thread_rng().gen_range(0..100) < critical_chance {
                    critical = true;
                }
                // 元素弱化与上面那条元素场路径同源同口径：只交出**来源 + 百分比**。
                let mut pre: Vec<(DamageSource, i64)> = Vec::new();
                if self
                    .monsters
                    .get(target_id)
                    .is_some_and(|monster| monster.elemental_weaken_until > self.tick)
                {
                    pre.push((
                        DamageSource::UnmarkedField {
                            skill_id: SKILL_ELEMENTAL_WEAKEN,
                            field: "x",
                        },
                        self.mage_skills
                            .level(SKILL_ELEMENTAL_WEAKEN, weaken_level)
                            .and_then(|value| value.x)
                            .unwrap_or(20)
                            .max(0),
                    ));
                }
                damage = self
                    .magic_damage_breakdown(
                        id, skill_id, target_id, damage, critical, request_id, segment, &pre,
                    )
                    .total();
                let killed = damage >= target_hp;
                let applied_damage = damage.min(target_hp.max(0));
                let practice = auth::is_practice_map(&map_id);
                let drops = if killed && !practice {
                    self.choose_drops(&target_template, target_x, target_y, id, &quests)
                } else {
                    Vec::new()
                };
                let quest_kills = if killed && !practice {
                    self.active_kill_objectives(id, &target_template.template_id)
                } else {
                    Vec::new()
                };
                let action_request = format!("{request_id}:s{segment}:t{target_id}");
                let action_id = format!("skill-{request_id}-{segment}-{target_id}");
                let resolution = if let Some(store) = self.store.as_ref() {
                    let claim =
                        store.claim_attack(id, &map_id, &action_request, &action_id, "skill")?;
                    if claim.resolved {
                        continue;
                    }
                    store.resolve_attack_with_party(
                        id,
                        &map_id,
                        &action_request,
                        Some(target_id),
                        applied_damage,
                        killed,
                        target_template.exp,
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
                        target_id: Some(target_id.clone()),
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
                    }
                };
                if resolution.already_resolved {
                    continue;
                }
                // 同上：攻击者位置要在借走 `monsters` 之前取。
                let attacker_x = self.players.get(id).map(|player| player.state.x);
                if resolution.damage > 0 {
                    self.advance_mystic_strike(id, request_id, target_id);
                    successful_direct_targets.insert(target_id.clone());
                }
                if let Some(monster) = self.monsters.get_mut(target_id) {
                    if resolution.damage > 0 {
                        let contribution =
                            monster.damage_by_player.entry(id.to_owned()).or_default();
                        *contribution = contribution.saturating_add(resolution.damage);
                        // Prey turns hostile to this attacker; see
                        // `step_monsters` for the per-step pursuit resolution.
                        mark_monster_hit_aggro(monster, &id, self.tick);
                    }
                    monster.state.hp = (monster.state.hp - resolution.damage).max(0);
                    register_monster_knockback(monster, resolution.damage, attacker_x);
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
                    self.broadcast_to_map(
                        &map_id,
                        &serde_json::json!({
                            "type": "damageEvent",
                            "eventId": format!("damage-event-{id}-{request_id}-{segment}-{target_id}"),
                            "serverTick": self.tick,
                            "attackerId": id,
                            "targetId": target_id,
                            "x": target_x,
                            "y": target_y,
                            "damage": resolution.damage,
                            "killed": resolution.killed,
                            "skillId": skill_id,
                            "segment": segment,
                            "targetCount": target_count,
                            "critical": critical,
                        })
                        .to_string(),
                    );
                }
                if !resolution.profiles.is_empty() {
                    for (participant, profile) in resolution.profiles {
                        if let Some(player) = self.players.get_mut(&participant) {
                            apply_profile_to_player(
                                &self.gameplay,
                                &self.mage_skills,
                                player,
                                profile,
                            );
                        }
                    }
                } else if let Some(profile) = resolution.profile {
                    if let Some(player) = self.players.get_mut(id) {
                        apply_profile_to_player(&self.gameplay, &self.mage_skills, player, profile);
                    }
                }
                if segment == 1 {
                    self.maybe_absorb_monster_mp(id, target_id);
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
                    self.drop_maps.insert(drop_id, map_id.clone());
                }
                if resolution.killed {
                    self.apply_quest_kill_credit(id, &quest_kills);
                }
            }
        }
        if let Some(target_id) = successful_direct_targets.iter().next() {
            self.maybe_cast_blizzard_follow_up(id, request_id, target_id)?;
        }
        // Leave the player action visible for the source/client animation.
        let attack_duration_ticks = self.energy_duration_ms(id).div_ceil(TICK_MS);
        if let Some(player) = self.players.get_mut(id) {
            player.state.action = "attack";
            player.state.action_started_tick = self.tick;
            player.attack_until = self.tick + attack_duration_ticks;
        }
        Ok(())
    }
}
