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
        // 技能轉換（`2321054 復仇天使`）是这条闸门的**唯一例外**：被转换出来的「復仇」
        // 形态在源里刻意 `invisible: 1`（技能窗不列、玩家点不到），唯一的授予路径就是
        // 那次转换 —— 所以判据是「这本復仇技能真的在这条玩家的技能表里」
        // （`transform_grants`），而不是另立一个布尔位。没转换过的玩家点它照旧被拒。
        let transform_granted = self
            .players
            .get(&id)
            .is_some_and(|player| transform_grants(player, skill_id));
        if (skill.hidden || skill.fixed_level)
            && skill_id != SKILL_MAGIC_WAVE_HIDDEN
            && !transform_granted
        {
            self.send_reject(
                &id,
                "skill_hidden",
                "该技能由职业规则自动启用。",
                Some(&request_id),
            );
            return;
        }
        // 转换的另一半：执行过转换之后，「慈愛」那一侧不再可施放（源：「各別轉換成」）。
        // 落点与上面那条同一处早退位置 —— 冷却与 MP 消耗之前，所以被拒的技能不扣 MP。
        if self.players.get(&id).is_some_and(|player| {
            transform_form(skill_id) == Some(TransformForm::Love) && transform_done(player)
        }) {
            self.send_reject(
                &id,
                "skill_transformed",
                "該技能已轉換為復仇技能。",
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
        // 已接执行链的技能白名单（`castable`）。**不在表里的**分两种，消息要分开说：
        // 真被动技能（源里只有被动字段）回「被动技能不能主动施放。」；
        // 源里是主动、但本包还没接执行链的（召唤物/治疗/DoT 场等）回「该技能尚未开放施放。」。
        // 改前这两类共用前一句话 —— 火毒/主教分支补齐准入之后，他们的主动技能会被
        // 误报成「被动技能」。判据按源数据派生（`MageSkill::is_active_source_skill`），
        // 不另写一张人工清单。
        let castable = matches!(
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
                | SKILL_CHAIN_LIGHTNING
                | SKILL_BLIZZARD
                | SKILL_ICE_DRAGON_BREATH
                | SKILL_FROZEN_ORB
                | SKILL_HYPER_THUNDER
                | SKILL_HYPER_VORTEX
                | SKILL_THREE_SNAILS
                | SKILL_RECOVERY
                | SKILL_NIMBLE_FEET
        ) || BRANCH_AREA_ATTACKS.contains(&skill_id)
            || PHYSICAL_AREA_ATTACKS.contains(&skill_id)
            // 火毒／主教四转的「同一格副本」（2026-09-23）：楓葉祝福 / 魔力無限 /
            // 楓葉淨化 / 召喚火魔 / 傳說冒險 与冰雷那几条同机制，收进同一张表后一起进
            // 白名单。表定义在 `world.rs`，判据只有那一处。
            || MAPLE_WARRIOR_SKILLS.contains(&skill_id)
            || INFINITY_SKILLS.contains(&skill_id)
            || MAPLE_CURE_SKILLS.contains(&skill_id)
            // 召唤系（冰魔 / 火魔 / 聖龍，2026-09-23 起三条共用同一张表）。
            || SUMMON_SKILLS.contains(&skill_id)
            || HYPER_ADVENTURER_SKILLS.contains(&skill_id)
            // 進階祝福 `2321005`（2026-09-23）：源 `common` 带 `time` 的队伍增益窗，
            // 与上面几张表同形 ⇒ 同样由 `world.rs` 的那一张表决定准入。
            || ADVANCED_BLESSING_SKILLS.contains(&skill_id)
            // 復甦之光 `2321006`（2026-09-24）：主教四转的**队伍复活** —— 主动、带
            // `mpCon`，源 `action` 是 `resurrectionNew`。与上面几张表同形 ⇒ 同样由
            // `world.rs` 的那一张表决定准入，不在这里写 `if skill_id == …`。
            || REVIVAL_LIGHT_SKILLS.contains(&skill_id)
            // 開關技能（源 `info.type=15`：「使用時啟動、再次使用時關閉」）：冰雷
            // `2221054 冰雪結界` 与火毒 `2121054 火靈結界` 是**同一格**（2026-09-24 收口）。
            // 改前这里写死 `SKILL_HYPER_VORTEX`（它是上方 `matches!` 里的一个字面量），
            // 于是同一格的火毒副本连白名单都进不来。
            || TOGGLE_FIELD_SKILLS.contains(&skill_id)
            // 技能轉換 `2321054 復仇天使`（源 `info.type=50`）：主动、带 `mpCon`，
            // 那次「慈愛→復仇」的转换就是它的效果。
            || TRANSFORM_SKILLS.contains(&skill_id);
        if !castable {
            let active = skill.is_active_source_skill();
            self.send_reject(
                &id,
                if active { "skill_unimplemented" } else { "skill_passive" },
                if active {
                    "该技能尚未开放施放。"
                } else {
                    "被动技能不能主动施放。"
                },
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
        if (matches!(
            skill_id,
            SKILL_ENERGY_BOLT
                | SKILL_THREE_SNAILS
                | SKILL_COLD_BEAM
                | SKILL_THUNDER_BOLT
                | SKILL_ICE_STORM
                | SKILL_GLACIAL_WALL
                | SKILL_THUNDER_SPHERE
                | SKILL_CHAIN_LIGHTNING
                | SKILL_BLIZZARD
                | SKILL_ICE_DRAGON_BREATH
                | SKILL_FROZEN_ORB
                | SKILL_HYPER_THUNDER
        ) || SUMMON_SKILLS.contains(&skill_id))
            && player.attack_until > self.tick
        {
            self.send_reject(&id, "skill_busy", "技能动作尚未结束。", Some(&request_id));
            return;
        }
        let mut mp_cost = self.skill_mp_cost(&id, skill_id, &level, vertical);
        // 開關技能的两条规则（2026-09-24 从「写死 `SKILL_HYPER_VORTEX`」收口成读表）：
        //   * **开启**那一拍付源 `mpCon`——它就是源文案里「每秒消耗MP #mpCon」的**第一秒**
        //     （`set_toggle_field` 把下一次 upkeep 定在 `now + 1 秒`，所以不会重复收）；
        //   * **关闭**那一拍免费（`vertical <= 0` 排除掉冰雷的下键漩涡，那是另一件事）。
        // 与 `SKILL_TELEPORT_BOOST` 那条「Turning the toggle off has no source MP cost.」
        // 同一条口径。
        if TOGGLE_FIELD_SKILLS.contains(&skill_id)
            && toggle_field_enabled(player, skill_id)
            && vertical <= 0
        {
            mp_cost = 0;
        }
        // 用户指定规则（2026-09-10）：瞬移全等级固定 10 MP，等级差异体现在距离与冷却。
        // 数值来自 shared/mage-skills.json#2001009（覆盖表见 scripts/tms273_skill_manifest.cjs），
        // 原版 TMS273 为 mpCon 28→20 且没有 cooltime——此处按用户指定执行，不冒充原作。
        let cooldown_ms: i64 = if skill_id == SKILL_TELEPORT {
            level.cooldown_ms.unwrap_or(0).max(0)
        } else if BEGINNER_SKILLS.contains(&skill_id)
            || skill_id == SKILL_ELEMENTAL_ADAPTING
            // 四转书（212 火毒 / 222 冰雷 / 232 主教）的 `cooltime` 是秒单位。
            // 改前判据写死冰雷那一本（`book_id == FOURTH_BOOK`）⇒ 火毒与主教四转技能的
            // 冷却永远算成 0。判据改成「四转层级的书」，三条分支一起生效。
            || (crate::mage::FOURTH_JOB_BOOKS.contains(&skill.book_id)
                && level.cooltime.is_some())
        {
            level.cooltime.unwrap_or(0).max(0).saturating_mul(1_000)
        } else if TRANSFORM_SKILLS.contains(&skill_id) {
            // 技能轉換 `2321054 復仇天使`：源 `common` 用的是 **`cooltimeMS`** 而不是
            // `cooltime`（值 500），而**全目录只有这一条**用这个字段名。`MageLevel` 的
            // `cooltime` 带 `serde(rename = "cooltime")`、投影器 `RUNTIME_INTEGER_FIELDS`
            // 也只出 `cooltime` ⇒ `cooltimeMS` 进不了运行期模型（给它加字段会立刻要求
            // 同步改投影器与 `check_tms273_skill_manifest.cjs` 的双向断言）。
            // 所以冷却按**调用点字面量**写。单位是毫秒：源帮助文本写的是
            // 「冷卻時間 #cooltimeMS秒」—— 那个 500 是**秒**，不是毫秒。
            500_000
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
        } else if HYPER_ADVENTURER_SKILLS.contains(&skill_id)
            || TOGGLE_FIELD_SKILLS.contains(&skill_id)
            || TRANSFORM_SKILLS.contains(&skill_id)
        {
            // 傳說冒險三本、開關技能（冰雷 冰雪结界 / 火毒 火靈結界）与技能轉換
            // （復仇天使 `2321054`）：源里都没有施法时长字段（`2321054` 连 `action`
            // 都是 null），600ms 是本包与 2221053 一致的施法动作时长。
            // 判据从「写死 2221053」收口成表，所以这三格拿到同一个值。
            600
        } else if skill_id == SKILL_MAGIC_WAVE_HIDDEN {
            level.time.unwrap_or(5).max(0).try_into().unwrap_or(5_000) * 1_000
        } else if INFINITY_SKILLS.contains(&skill_id) {
            // The source has an alert/activation action but no authored
            // duration field.  Keep the visual cast finite and independent
            // of weapon action speed; the actual buff duration is tracked
            // separately by activate_infinity.  三本副本（222/212/232）同形，
            // 所以这条判据也从常量收口成表。
            600
        } else if ADVANCED_BLESSING_SKILLS.contains(&skill_id) {
            // 進階祝福：源 `action` 是 `alert2`，同样**没有**施法时长字段 ⇒
            // 与上面两条增益同取本包既有的 600ms 施法动作（窗口时长另由
            // `activate_advanced_blessing` 按源 `time` 挂）。
            600
        } else if skill_id == SKILL_ICE_DRAGON_BREATH {
            // q is the held-key maximum from String.h.  Master Magic
            // buff-time does not extend this channel ceiling.
            u64::try_from(level.q.unwrap_or(0).max(0)).unwrap_or(0) * 1_000
        } else if REVIVAL_LIGHT_SKILLS.contains(&skill_id) {
            // 復甦之光：源 `action` 是 `resurrectionNew`（起手动作），同样**没有**
            // 施法时长字段 ⇒ 与 傳說冒險 / 開關技能 / 進階祝福 取同一个本包既有的
            // 600ms 施法动作（它随 `skillCast` 广播的 `durationMs` 下发给客户端）。
            // 無敵窗口是另一件事（源 `time` 秒），由 `activate_revive_light` 按它叠到
            // `contact_invulnerable_until` 上，与这里的动作时长无关。
            600
        } else if matches!(
            skill_id,
            SKILL_ENERGY_BOLT
                | SKILL_MAGIC_WAVE
                | SKILL_COLD_BEAM
                | SKILL_THUNDER_BOLT
                | SKILL_ICE_STORM
                | SKILL_GLACIAL_WALL
                | SKILL_THUNDER_SPHERE
                | SKILL_CHAIN_LIGHTNING
                | SKILL_BLIZZARD
                | SKILL_ICE_DRAGON_BREATH
                | SKILL_FROZEN_ORB
                | SKILL_HYPER_THUNDER
                | SKILL_HYPER_VORTEX
        ) || SUMMON_SKILLS.contains(&skill_id)
        {
            if skill_id == SKILL_ENERGY_BOLT {
                self.energy_duration_ms(&id)
            } else {
                self.skill_duration_ms(&id, skill_id)
            }
        } else if BRANCH_AREA_ATTACKS.contains(&skill_id) || PHYSICAL_AREA_ATTACKS.contains(&skill_id) {
            // 火毒/主教的攻击技能与冰雷同一条动作锁（源里都是 600ms 的攻击动作，
            // 再按极速詠唱的动作速度加成收敛）；物理线一转攻击技能同形
            // （`1001010 躍進攻擊` 自带 `attackDelay`，由 skill_duration_ms 收敛）。
            self.skill_duration_ms(&id, skill_id)
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
            // 楓葉祝福：三条分支的四转各一本（2221000 / 2121000 / 2321000）。源里三本
            // 都**没有** `time`，所以 `buff_duration_ms` 的基数恒为 0——真正的
            // `basicStatUp` 早已按 `MAPLE_WARRIOR_SKILLS` 数组「学得即生效」消费
            // （`attribute.rs` 第 3 层），这里只保留冰雷既有的「施放即挂一个空窗」行为，
            // 不因为副本就凭空补一个源里没有的时长。
            other if MAPLE_WARRIOR_SKILLS.contains(&other) => {
                let duration_ms = self.buff_duration_ms(
                    &id,
                    &level,
                    level.time.unwrap_or(0).max(0) as u64 * 1_000,
                );
                if let Some(player) = self.players.get_mut(&id) {
                    player
                        .status
                        .apply_buff(other, duration_ms, self.tick, Release::None);
                }
            }
            // 魔力無限：2221004 / 2121004 / 2321004，三本源 `common` 逐字段同形。
            other if INFINITY_SKILLS.contains(&other) => {
                if let Err(error) = self.activate_infinity(&id, other, &level) {
                    self.handle_accepted_effect_error(&id, &request_id, &error);
                    return;
                }
            }
            // 召唤系：召喚冰魔 2221005、召喚火魔 2121005、召喚聖龍 2321003。实体、
            // 存活时长、脉冲周期与位移形态都从源字段派生（S5 建成的通用槽位），
            // 本臂不写技能名单以外的分支。
            other if SUMMON_SKILLS.contains(&other) => {
                if let Err(error) = self.cast_summon(&id, &request_id, other, &level) {
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
            // 楓葉淨化：2221008 / 2121008 / 2321009，三本源 `common` 逐字段同形
            // （`mpCon,cooltime,time`），走同一条「清疾病 + 3 秒免疫窗」。
            other if MAPLE_CURE_SKILLS.contains(&other) => {
                self.activate_status_cleanse(&id, other, &level)
            }
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
            // 傳說冒險三本共用同一条施法臂：增益按**施放的那一本**挂出，
            // 所以火毒／主教那两本不再落到 `_ => {}`（「尚未开放施放」）。
            adventurer if HYPER_ADVENTURER_SKILLS.contains(&adventurer) => {
                self.activate_hyper_adventurer(&id, adventurer, &level);
            }
            // 進階祝福 `2321005`：源 `common` 带 `time`（240 秒）的队伍增益窗，
            // 三格加算（`x`/`y`/`z`）随窗口挂给同图队友，到期由
            // `Release::AdvancedBlessing` 收回。
            blessing if ADVANCED_BLESSING_SKILLS.contains(&blessing) => {
                self.activate_advanced_blessing(&id, blessing, &level);
            }
            // 開關技能（源 `info.type=15`）：冰雷 `2221054 冰雪結界` 与火毒
            // `2121054 火靈結界` 是同一格 ⇒ 共用同一条臂（改前只认 `SKILL_HYPER_VORTEX`）。
            // `vertical > 0` 的 ↓ 变体只有冰雷那本有，由 `activate_toggle_field` 内部拒绝。
            toggle if TOGGLE_FIELD_SKILLS.contains(&toggle) => {
                if let Err(error) =
                    self.activate_toggle_field(&id, &request_id, toggle, &level, vertical)
                {
                    self.handle_accepted_effect_error(&id, &request_id, &error);
                    return;
                }
            }
            // 技能轉換 `2321054 復仇天使`：施放＝**执行那次转换** —— 把四本復仇技能按
            // 慈愛那一侧的已学等级写进技能存档（源 perLevel：「…各別轉換成…」）。
            // 转换态本身从技能表派生（`transform_done`），所以这条臂不另立状态位；
            // `[被動效果]` 三项早已按「学得即生效」在属性层与伤害管线里消费。
            avenging if TRANSFORM_SKILLS.contains(&avenging) => {
                if let Err(error) =
                    self.activate_skill_transform(&id, &request_id, avenging, &level)
                {
                    self.handle_accepted_effect_error(&id, &request_id, &error);
                    return;
                }
            }
            // 復甦之光 `2321006`（2026-09-24）：施放＝复活**同图死亡队员**，再给施法者
            // 自己叠源 `time` 秒無敵。目标集合与無敵归属的理由都写在
            // `world.rs::SKILL_REVIVAL_LIGHT`；这半句只记「它落在这条臂上」。
            // 复活走既有的唯一写路径（`complete_revive`），所以不销碑、不换图。
            revival if REVIVAL_LIGHT_SKILLS.contains(&revival) => {
                self.activate_revive_light(&id, revival, &level);
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
            // 火毒（210/211/212）与主教（230/231/232）的攻击技能：与冰雷走**同一条**
            // 元素范围管线（`cast_elemental_area`）。命中盒取源 `common/lt|rb` 绕玩家、
            // 伤害倍率与段数取 `level`；`lightning = false` 表示不触发冰冻层 ——
            // 火（`f`）/毒（`s`）/聖（`h`）三系在源里没有冻结字段，也不需要那条分支。
            // 四转火毒的三条 Hyper 强化被动（`damR`）由 `magic_damage_breakdown` 的
            // 「被强化技能 → 强化被动」配对表消费。
            //
            // 2026-09-23 从「逐条写常量」收口成**读表**：`BRANCH_AREA_ATTACKS` 已经是
            // `castable` 白名单（第 169 行）与动作时长入口（第 437 行）的判据，施法臂
            // 再抄一遍 14 个常量，等于新接一条要改四处、漏一处就「能施放但打不出」。
            // 收口后三处共用同一张表，判据只有 `world.rs::BRANCH_AREA_ATTACKS` 那一处。
            other if BRANCH_AREA_ATTACKS.contains(&other) => {
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
            // 战士 / 飞侠的一转攻击技能：走**同一条**范围管线的物理分支
            // （`cast_elemental_area_at_filtered` 按 `PHYSICAL_AREA_ATTACKS` 判定）：
            // 伤害基准是普攻攻击区间 × `damage%`，无暴击/冰冻层参与。
            SKILL_SWORD_SLASH
            | SKILL_RUSH_ATTACK
            | SKILL_RISING_DRAGON
            | SKILL_TRIPLE_THROW
            | SKILL_DOUBLE_THROW
            | SKILL_SAVAGE_BLUNT => {
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
            // 物理线**二转以上**的攻击技能：**从表派生的通用执行臂**，不逐条写常量。
            // 改前这里只有上面那六条一转技能，26 条分支技能**在 `castable` 里、MP 与冷却
            // 照扣、castEvent 照发，却没有任何结算**——是「能放但打不到」的静默缺口
            // （第十三轮核查发现，四支柱落地时一并修掉）。它们走与一转六条**完全相同**
            // 的一条范围管线：命中盒取源 `common/lt|rb` 绕玩家、段数与目标数取 `level`、
            // 伤害是普攻攻击区间 × `damage%`；机制层（DoT / 投射物 / 二段命中）由
            // `mechanics.rs` 从源字段派生，不在这里判技能。
            other if PHYSICAL_AREA_ATTACKS.contains(&other) => {
                if let Err(error) = self.cast_elemental_area(&id, &request_id, other, &level, false)
                {
                    self.handle_accepted_effect_error(&id, &request_id, &error);
                    return;
                }
                // S1 施放窗：自增益技能（物理线唯一带**自增益** `time` 的是
                // `1221052 神之滅擊`）施放时给施法者自己开一段 buff 窗，复用
                // `player_status` 既有唯一时钟，到期由既有清理点自动收回。
                // **`time` 的三义分级只此一处**（`mechanics.rs::self_buff_window_ms`）：
                // burn 窗（`time` 逐级等于 `dotTime`，如 `1121015 烈焰翔斬`）返回 `None`，
                // 负面状态窗 / 召唤存活时长仍被门禁挡在表外 ⇒ 都不会走到这里。
                if let Some(window_ms) = AttackPlan::of(&level).self_buff_window_ms {
                    if let Some(player) = self.players.get_mut(&id) {
                        player.status.apply_buff(other, window_ms, self.tick, Release::None);
                    }
                }
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.action = "attack";
                    player.state.action_started_tick = self.tick;
                    player.attack_until = self.tick + duration_ms.div_ceil(TICK_MS).max(1);
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
            // 魔力激發（冰雷 2210001 / 火毒 2110001）的 `costmpR` 减 MP 消耗，各记各的：
            // 两本都按「先乘 100+costmpR 再整除 100」逐个作用，与改前同一口径。
            for amp_skill in ELEMENT_AMP_SKILLS {
                let amp_level = self
                    .players
                    .get(id)
                    .and_then(|player| player.state.skills.get(&amp_skill))
                    .copied()
                    .and_then(|level| self.mage_skills.level(amp_skill, level));
                if let Some(amp) = amp_level {
                    cost = cost.saturating_mul(100 + amp.costmp_r.unwrap_or(0).max(0)) / 100;
                }
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
                player.summons.iter().any(|summon| {
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
        // 三本副本（2221004 / 2121004 / 2321004）共用这条判据：改前只认冰雷那一本，
        // 火毒／主教放了無限之后仍然照扣 MP。
        if !INFINITY_SKILLS.contains(&skill_id)
            && self
                .players
                .get(id)
                .is_some_and(infinity_buff_active)
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
                | SKILL_CHAIN_LIGHTNING
                | SKILL_BLIZZARD
                | SKILL_ICE_DRAGON_BREATH
                | SKILL_FROZEN_ORB
                | SKILL_HYPER_THUNDER
                | SKILL_HYPER_VORTEX
        ) || SUMMON_SKILLS.contains(&skill_id)
            || PHYSICAL_AREA_ATTACKS.contains(&skill_id)
        {
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

    pub(super) fn activate_status_cleanse(&mut self, id: &str, skill_id: u32, _level: &MageLevel) {
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
        //
        // 免疫窗挂在**施放的那一本**上（2221008 / 2121008 / 2321009）：
        // `buff_remaining_ms` 是按技能 id 查的，写死冰雷那一本会让火毒／主教玩家
        // 的免疫窗读不到（净化本身仍然生效，但窗口的到期回收会漏）。
        player.status.cleanse(self.tick, 3_000);
        player
            .status
            .apply_buff(skill_id, 3_000, self.tick, Release::StatusImmunity);
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
        // 極速詠唱：三本分支各一本（冰雷 2200012 / 火毒 2100011 / 僧侶 2300011）。
        // 源加速值在 `psdWeaponBooster.actionSpeed`（导出成技能条目的 `boosterActionSpeed`），
        // 等级行本身不带 `actionSpeed`；口径是「**学过哪一本才吃哪一本**」，先查等级行、
        // 缺则回落到条目值 —— 这正是三本可以各自独立生效的前提（改前只读冰雷那一本，
        // 且回落链在未学时也会命中，属于链式写法的副作用；这里把闸门提到最前面）。
        let mut second = 0i64;
        for booster in BOOSTER_SKILLS {
            let Some(level) = player.state.skills.get(&booster) else {
                continue;
            };
            let value = self
                .mage_skills
                .level(booster, *level)
                .and_then(|level| level.action_speed)
                .or_else(|| {
                    self.mage_skills
                        .get(booster)
                        .and_then(|skill| skill.booster_action_speed)
                })
                .unwrap_or(0);
            second = second.saturating_add(value.min(0));
        }
        first.min(0).saturating_add(second)
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
            | SKILL_CHAIN_LIGHTNING
            | SKILL_BLIZZARD
            | SKILL_ICE_DRAGON_BREATH
            | SKILL_FROZEN_ORB => 600,
            // 召唤系（冰魔 / 火魔 / 聖龍）与上列同为 600ms 动作；三条共用同一张
            // 接纳表，所以判据从常量收口成表。
            other if SUMMON_SKILLS.contains(&other) => 600,
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
        if let Some(rider) = &player.colossus {
            if rider.arrival_until>self.tick { return Err("teleport_blocked".into()); }
            let runtime = self.colossus.as_ref().ok_or("teleport_blocked")?;
            let body = rider.body.teleport(&runtime.config, &runtime.frame, runtime.bridge(),
                horizontal_distance * f64::from(direction) / 60.0,
                -vertical_distance_abs * f64::from(vertical) / 60.0).ok_or("teleport_blocked")?;
            return Ok(TeleportPlan { map_id, x: body.s * 60.0, y: -body.position[1] * 60.0,
                grounded: body.grounded, foothold_id: 0, colossus: Some(body) });
        }
        let map = self.map_for(&map_id).clone();
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
            colossus: None,
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
        if let Some(body) = plan.colossus {
            if let Some(rider) = player.colossus.as_mut() { rider.body = body; }
        }
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
        if let Some(rider)=player.colossus.as_mut() {
            rider.body.vertical_speed=-player.state.vy/60.0;
            rider.body.grounded=false;
        }
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
        // 段数的 Hyper 追加与目标数放在**同一处**调整：链锁闪电的 `閃電連擊` 被动加的是
        // 段数，不是目标数。改前这段逻辑写在段循环的调用点里，机制计划（`AttackPlan`）
        // 一旦从 `level` 单独派生就会少算这些段 —— 「生效等级」必须只有一份。
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
                adjusted.attack_count = Some(
                    adjusted
                        .attack_count
                        .unwrap_or(1)
                        .saturating_add(extra)
                        .min(12),
                );
            }
        }
        adjusted
    }

    /// 源 `common/lt|rb` 围成的矩形是否包住某点。**绕施法者**，与
    /// [`Self::area_targets_at`] 同一套坐标口径（`local = 目标 − origin`）。
    ///
    /// ⚠️ 与攻击盒那一路**唯一**的分歧是朝向镜像：`area_targets_at` 要为「源把攻击盒写成
    /// 朝左」补一次 x 镜像；而复甦之光的框是**支援**技能的框（不是朝向攻击盒），所以这里
    /// 按源矩形原样判。`2321006` 的框左右对称（`lt.x = -400` / `rb.x = 400`）⇒ 在这条
    /// 技能上两种读法数值完全一致；把差别写出来是为了将来接别的支援技能时不会照抄错那一半。
    ///
    /// `lt`／`rb` 缺一即**不命中**：没有框就没有「範圍內」可言，替源补一个默认框
    /// 等于替源编语义。
    pub(super) fn inside_source_box(
        &self,
        level: &MageLevel,
        origin: (f64, f64),
        point: (f64, f64),
    ) -> bool {
        let (Some(lt), Some(rb)) = (level.lt.as_ref(), level.rb.as_ref()) else {
            return false;
        };
        let local_x = point.0 - origin.0;
        let local_y = point.1 - origin.1;
        local_x >= lt.x && local_x <= rb.x && local_y >= lt.y && local_y <= rb.y
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
        let passive_crit = self.critical_chance_from(id, &CRITICAL_CHANCE_SKILLS);
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
        (passive_crit + hyper_ice_crit + if wand_crit { 5 } else { 0 }).clamp(0, 100)
    }

    /// 把一张「同一格」的技能表逐本读出来再加算：分支互斥时只会命中一本，
    /// 但**各记各的**让留痕能指认来源，也避免以后新增分支时漏掉某处调用点。
    fn critical_chance_from(&self, id: &str, skills: &[u32]) -> i64 {
        skills
            .iter()
            .filter_map(|skill_id| {
                self.players
                    .get(id)
                    .and_then(|player| player.state.skills.get(skill_id))
                    .and_then(|level| self.mage_skills.level(*skill_id, *level))
                    .and_then(|level| level.cr)
            })
            .fold(0i64, |total, value| total.saturating_add(value.max(0)))
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
        let (mystic_ignore, mystic_bonus, infinity_bonus, infinity_source) = self
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
                    if infinity_buff_active(player) {
                        player.infinity_damage_bonus.max(0)
                    } else {
                        0
                    },
                    // 留痕要写**真正生效的那一本**（2221004 / 2121004 / 2321004），
                    // 不能永远写冰雷那一本：三本互斥，但账本必须对得上玩家手里的书。
                    active_infinity_skill(player).unwrap_or(SKILL_INFINITY),
                )
            })
            .unwrap_or((0, 0, 0, SKILL_INFINITY));
        ignored_md_rate = ignored_md_rate.saturating_add(mystic_ignore);
        // 技能轉換 `2321054 復仇天使` 的 `#c[被動效果]#` 之一：
        // 「無視怪物防禦率增加 #ignoreMobpdpR%」。与上一条（神秘狙擊）同一条累加口径 ——
        // 都进 `ignored_md_rate`、末端一次作用于目标侧减免；差别是它**没有叠层**，
        // 按已学等级直读（源把它标成 `被動效果`，拥有即生效）。
        for ignore_skill in TRANSFORM_SKILLS {
            let passive_ignore = self
                .players
                .get(id)
                .and_then(|player| player.state.skills.get(&ignore_skill))
                .copied()
                .and_then(|level| self.mage_skills.level(ignore_skill, level))
                .and_then(|level| level.ignore_mob_pdp_r)
                .unwrap_or(0)
                .clamp(0, 100);
            ignored_md_rate = ignored_md_rate.saturating_add(passive_ignore);
        }
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
            // 火毒四转的三条 Hyper 强化被动：源里只带 `damR`，强化的是哪一招
            // 只能按技能名配对（见 `world.rs` 的常量注释）。火毒这一组与冰雷那三条
            // 同形 —— 只有在**被强化的那一招打出去**时才把这份 damR 加进加算组。
            SKILL_POISON_BREATH => SKILL_HYPER_POISON_DAMAGE,
            SKILL_FLAME_SWEEP => SKILL_HYPER_FLAME_DAMAGE,
            SKILL_HELLFIRE => SKILL_HYPER_HELLFIRE_DAMAGE,
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
            // 傳說冒險：同 `attacks.rs` 的普攻路径，两条路径读同一个访问器、
            // 留痕同一个 `skill_id`（真正在计时的那一本）。
            if let Some(adventurer) = active_adventurer_skill(player) {
                pipeline.add(
                    DamageSource::IndependentDamageRate {
                        skill_id: adventurer,
                    },
                    hyper_adventurer_damage_percent(&self.mage_skills, player, adventurer),
                );
            }
        }
        // 常駐段：魔力激發（冰雷 2210001 / 火毒 2110001）。分支互斥，但**各记各的**——
        // 留痕里的 `skill_id` 要能指认是哪一本给的。两本共用同一道「魔法攻击技能」闸门。
        if is_magic_attack_skill(skill_id) {
            for amp_skill in ELEMENT_AMP_SKILLS {
                let amp = self
                    .players
                    .get(id)
                    .and_then(|player| player.state.skills.get(&amp_skill))
                    .copied()
                    .and_then(|level| self.mage_skills.level(amp_skill, level))
                    .and_then(|level| level.dam_r)
                    .unwrap_or(0)
                    .max(0);
                pipeline.add(
                    DamageSource::DamageRate {
                        skill_id: amp_skill,
                    },
                    amp,
                );
            }
        }
        // P: no current mob export carries an elemental-resistance target, so
        // source `u` is intentionally not applied to mdRate.  mdR is the
        // independent final-damage multiplier and always applies here.
        // 两本（冰雷 2210016 / 火毒 2110015）各记各的；源里 mdR 没有分组标记 ⇒ 独立乘算。
        for reset_skill in ELEMENTAL_RESET_SKILLS {
            let reset = self
                .players
                .get(id)
                .and_then(|player| player.state.skills.get(&reset_skill))
                .copied()
                .and_then(|level| self.mage_skills.level(reset_skill, level))
                .and_then(|level| level.md_r)
                .unwrap_or(0)
                .max(0);
            pipeline.add(
                DamageSource::UnmarkedField {
                    skill_id: reset_skill,
                    field: "mdR",
                },
                reset,
            );
        }
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
            // 暴击组的基准是 200：没学 魔法爆擊 时 `criticaldamage = 0`，仍是 ×2。
            // 三本（冰雷 2210009 / 火毒 2110009 / 僧侶 2310010）各记各的。
            for critical_skill in MAGIC_CRITICAL_SKILLS {
                let critical_damage = self
                    .players
                    .get(id)
                    .and_then(|player| player.state.skills.get(&critical_skill))
                    .copied()
                    .and_then(|level| self.mage_skills.level(critical_skill, level))
                    .and_then(|level| level.critical_damage)
                    .unwrap_or(0)
                    .max(0);
                pipeline.add(
                    DamageSource::CriticalDamage {
                        skill_id: critical_skill,
                    },
                    critical_damage,
                );
            }
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
                skill_id: infinity_source,
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
        // 支柱③「投射物」的**发射端**（见 `mechanics.rs`）：源里写了段间隔的技能先登记
        // 成飞行物，本拍只结算立即段；每段落地时再按段重做碰撞判定。
        // 不带段间隔的技能（本包现在的绝大多数）在这里直接走下方同一条路径，
        // 行为与本轮之前逐字相同。
        let plan = AttackPlan::of(&self.hyper_area_level(id, skill_id, level));
        let flying = plan.flying_segments();
        if flying.is_empty() {
            let segments = plan.immediate_segments();
            return self.settle_area_segments(
                id, request_id, skill_id, level, lightning, origin, excluded, &segments, true,
            );
        }
        // 发射点必须**冻结**：投射物不会跟着主人走。没有显式原点时取施法拍的位置。
        let Some(frozen) = origin.or_else(|| {
            self.players
                .get(id)
                .map(|player| (player.state.x, player.state.y, player.state.facing))
        }) else {
            return Ok(());
        };
        self.launch_projectiles(
            id, request_id, skill_id, level, lightning, frozen, excluded, &flying,
        );
        // 满段都在飞 ⇒ 本拍没有立即结算；收尾交给**最后一段**落地时做（`finalize`）。
        let immediate = plan.immediate_segments();
        if immediate.is_empty() {
            return Ok(());
        }
        self.settle_area_segments(
            id,
            request_id,
            skill_id,
            level,
            lightning,
            Some(frozen),
            excluded,
            &immediate,
            false,
        )
    }

    /// 一次施法里**一段或多段**命中盒结算。施法链的立即段与投射物的到达段共用这一份实现，
    /// 所以两条路径的伤害管线、幂等键、播报与经验口径不可能分叉。
    ///
    /// `finalize` 为真时收尾做两件事：冰雷暴风雪的隐藏追击（既有行为）与二段命中判定。
    /// 分段发射时只有**最后一段**带这个标记。
    #[allow(clippy::too_many_arguments)]
    pub(super) fn settle_area_segments(
        &mut self,
        id: &str,
        request_id: &str,
        skill_id: u32,
        level: &MageLevel,
        lightning: bool,
        origin: Option<(f64, f64, i8)>,
        excluded: Option<&BTreeSet<String>>,
        segments: &[u32],
        finalize: bool,
    ) -> Result<(), String> {
        // 段数上界：源 `attackCount` 的最大合法值（雷霆 15、其余 12）。
        // **超了改上界，不是改技能**；这里只做「本拍要结算的段是否落在上界内」的过滤。
        let max_segments = if skill_id == SKILL_HYPER_THUNDER { 15 } else { 12 };
        // 「生效等级」是**唯一**的一份：目标数（`target_plus`）与段数（链锁闪电的 Hyper
        // 追加段）都在 `hyper_area_level` 里调整。机制计划也从它派生，否则「段计划」与
        // 「段结算」会各算一套段数。
        let target_level = self.hyper_area_level(id, skill_id, level);
        let segments = segments
            .iter()
            .copied()
            .filter(|segment| *segment <= max_segments)
            .collect::<Vec<_>>();
        // 机制计划：DoT 参数与第二命中盒都从这里取，一次性派生（派生规则见
        // `mechanics.rs::AttackPlan`），不在循环里逐段重算。
        let plan = AttackPlan::of(&target_level);
        // 原点解析成「值」而不是「可选」：`None` 等价于「取施法者当前位置」，
        // 而 `area_targets_at(当前位置)` 与旧的 `area_targets()` 在同一拍内逐字等价。
        let origin = origin.or_else(|| {
            self.players
                .get(id)
                .map(|player| (player.state.x, player.state.y, player.state.facing))
        });
        let targets = origin
            .map(|(x, y, facing)| self.area_targets_at(id, &target_level, x, y, facing))
            .unwrap_or_default()
            .into_iter()
            .filter(|target_id| excluded.is_none_or(|excluded| !excluded.contains(target_id)))
            .collect::<Vec<_>>();
        let target_count = targets.len();
        let lightning_effect = lightning || skill_id == SKILL_CHAIN_LIGHTNING;
        // 物理线一转攻击技能：伤害基准是**普攻攻击区间**（`attack_damage_against`，
        // 含四维聚合、等级差与目标侧 PDD 的既有 P 适配），乘 `damage%` 后不再走
        // 魔法管线与暴击/冰冻层——与普攻同一口径（普攻也不掷暴击）。
        let physical = PHYSICAL_AREA_ATTACKS.contains(&skill_id);
        let physical_attributes = physical.then(|| {
            self.players.get(id).map(|player| {
                (
                    aggregate_attributes(AttributeInput::of(
                        &self.gameplay,
                        &self.mage_skills,
                        player,
                    )),
                    player.state.level,
                )
            })
        }).flatten();
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
        for segment in segments {
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
                let damage = if let Some((attributes, player_level)) = &physical_attributes {
                    // 物理分支：普攻攻击区间 × damage%（基准已含目标侧修正，见上）。
                    let base = attributes.attack_damage_against(*player_level, &target_template);
                    (base as f64 * multiplier as f64 / 100.0).floor().max(1.0) as i64
                } else {
                    (magic_attack as f64 * multiplier as f64 / 100.0)
                        .floor()
                        .max(1.0) as i64
                };
                if !physical
                    && weaken.as_ref().is_some_and(|_| {
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
                // 暴击只在魔法分支掷骰；物理分支恒 false（与普攻同口径），
                // 但 damageEvent 事件里两分支都要带这个字段。
                let critical = !physical && rand::thread_rng().gen_range(0..100) < critical_chance;
                // 物理分支走简单的普攻同款管线（区域系数只保留 Boss 练习场护盾），
                // 魔法分支走 magic_damage_breakdown（damR 加算组 / 暴击 / 冰冻层）。
                // 区域系数的 `magic` 参数必须跟着**伤害种类**走：物理技能与普攻同口径
                // 取 `false`（源 `PhysicalGuard` 112 的 `physical_guard_until`），
                // 魔法路径取 `true`（`MagicGuard` 113）。写成 `true` 会让战士/飞侠的
                // 技能去吃魔法护盾、同时无视物理护盾——两个方向都错。
                let damage = if physical {
                    let mut pipeline = DamagePipeline::new(damage);
                    pipeline.add(
                        DamageSource::RegionGuard,
                        self.boss_damage_multiplier(&map_id, false) - 100,
                    );
                    pipeline.resolve().total()
                } else {
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
                    self.magic_damage_breakdown(
                        id, skill_id, target_id, damage, critical, request_id, segment, &pre,
                    )
                    .total()
                };
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
                // 两件事在这里分开了（原本被 `counts_as_direct_hit` 一起门着，效果是
                // **物理线的二段命中永远凑不出「首段真的打到人」**）：
                // ① `successful_direct_targets` 是「本次结算里真的打出过伤害的目标」，
                //    二段命中与暴风雪的隐藏追击都读它 —— 与技能是不是「直接命中类」无关；
                // ② 神秘狙擊叠层只认 `counts_as_direct_hit`（命中**次数**的语义），
                //    并进 ① 会让物理线凭空开始叠法师的层。
                if resolution.damage > 0 {
                    successful_direct_targets.insert(target_id.clone());
                    if counts_as_direct_hit(skill_id) {
                        self.advance_mystic_strike(id, request_id, target_id);
                    }
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
                // 支柱②「持续伤害」的**挂载点**：第 1 段真的打出伤害之后才掷 `prop` 挂载。
                // 只挂首段而不是每段都挂：段与段之间只差几十毫秒，每段都掷一次骰会让
                // 「叠层数」变成段数的副产物，而不是源 `prop` 驱动的结果。
                if segment == 1 && resolution.damage > 0 {
                    if let Some(dot) = plan.dot {
                        // 每跳伤害按**目标模板**算定（物理线含等级差与 PDD，与直接命中同基准），
                        // 之后每跳都是这个数：DoT 是「挂上去就固定」的残余伤害。
                        let per_tick =
                            if let Some((attributes, player_level)) = &physical_attributes {
                                let base = attributes
                                    .attack_damage_against(*player_level, &target_template);
                                ((base as f64) * dot.per_tick_percent as f64 / 100.0)
                                    .floor()
                                    .max(1.0) as i64
                            } else {
                                ((magic_attack as f64) * dot.per_tick_percent as f64 / 100.0)
                                    .floor()
                                    .max(1.0) as i64
                            };
                        self.apply_dot_hit(id, request_id, skill_id, target_id, &dot, per_tick);
                    }
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
        if finalize && is_nonsummon_direct_skill(skill_id) && skill_id != SKILL_BLIZZARD_HIDDEN {
            if !successful_direct_targets.is_empty() {
                let index = deterministic_percent(&[id, request_id, "blizzard-target"]) as usize
                    % successful_direct_targets.len();
                if let Some(target_id) = successful_direct_targets.iter().nth(index).cloned() {
                    self.maybe_cast_blizzard_follow_up(id, request_id, &target_id)?;
                }
            }
        }
        // 支柱④「二段命中」：**首段链收尾时仍有真实命中**才追加。判定用
        // `successful_direct_targets`（本次结算里真的打出过伤害的目标集合），
        // 所以空挥、全被闪避、目标已死都不会凭空多出一段。
        if finalize {
            if let Some(second) = plan.second {
                if !successful_direct_targets.is_empty() {
                    if let Some((origin_x, origin_y, facing)) = origin {
                        // 二段复用首段的属性快照，不重新聚合：两段之间夹一次属性变更
                        // （升级 / 增益到期）会让「同一次攻击的两段」用两个面板值。
                        let basis = match physical_attributes {
                            Some((attributes, player_level)) => DamageBasis::Physical {
                                attributes,
                                player_level,
                            },
                            None => DamageBasis::Magic { magic_attack },
                        };
                        let second_basis = SecondHitBasis {
                            origin: (origin_x, origin_y, facing),
                            level: target_level.clone(),
                            basis,
                        };
                        self.settle_second_hit(id, request_id, skill_id, &second, &second_basis)?;
                    }
                }
            }
        }
        Ok(())
    }

    pub(super) fn cast_thunder_sphere(
        &mut self,
        id: &str,
        request_id: &str,
        _level: &MageLevel,
        vertical: i8,
    ) -> Result<(), String> {
        let Some(player_snapshot) = self.players.get(id).map(|player| {
            (
                player.map_id.clone(),
                player.state.x,
                player.state.y,
                player.state.facing,
                player.summons.iter().position(|summon| {
                    matches!(
                        summon.skill_id,
                        SKILL_THUNDER_SPHERE | SKILL_THUNDER_SPHERE_HIDDEN
                    )
                }),
            )
        }) else {
            return Err("player_unknown".to_owned());
        };
        let (map_id, x, y, facing, existing_index) = player_snapshot;
        let learned = self
            .players
            .get(id)
            .and_then(|player| player.state.skills.get(&SKILL_THUNDER_SPHERE))
            .copied()
            .unwrap_or(1);
        let anchor = vertical > 0;
        // 存活时长走唯一派生点（`mechanics.rs::summon_lifetime_ms`）：本函数收口前
        // 自己把 `time` 当秒换算、还另写了 20／60 两个默认值，与冰魔／冰鋒刃那两处
        // 各写一份。现在单位判据（秒 vs 毫秒）与默认值都只剩那一处。
        // 锚定形态读**隐藏那本** `2211015` 的 `time`（与改前同源），非锚定读 `2211011`。
        let duration_ticks = summon_lifetime_ms(
            &self.mage_skills,
            if anchor {
                SKILL_THUNDER_SPHERE_HIDDEN
            } else {
                SKILL_THUNDER_SPHERE
            },
            learned,
        )
        .div_ceil(TICK_MS)
        .max(1);
        if let Some(index) = existing_index.filter(|_| anchor) {
            // 重新锚定既有球形闪电：只改形态与到期（保留 `summon_id` / `next_hit_at` /
            // `pulse_index`，所以锚定不会重置它的打击节拍），并把到期收紧为
            // `min(旧, 现在 + 锚定形态时长)`。这是「同技能重放即替换」在通用队列上的写法。
            if let Some(player) = self.players.get_mut(id) {
                if let Some(existing) = player.summons.get_mut(index) {
                    existing.x = x;
                    existing.y = y;
                    existing.facing = facing;
                    existing.motion = SummonMotion::Anchored;
                    existing.skill_id = SKILL_THUNDER_SPHERE_HIDDEN;
                    existing.expires_at = existing
                        .expires_at
                        .min(self.tick.saturating_add(duration_ticks));
                }
            }
            return Ok(());
        }
        let summon = Summon {
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
            motion: if anchor {
                SummonMotion::Anchored
            } else {
                SummonMotion::Follow
            },
            expires_at: self.tick.saturating_add(duration_ticks),
            next_hit_at: self.tick,
            pulse_index: 0,
        };
        let Some(player) = self.players.get_mut(id) else {
            return Err("player_unknown".to_owned());
        };
        player.summons.retain(|old| {
            !matches!(
                old.skill_id,
                SKILL_THUNDER_SPHERE | SKILL_THUNDER_SPHERE_HIDDEN
            )
        });
        if !Self::summon_slots_available(player) {
            return Err("summon_limit".to_owned());
        }
        player.summons.push(summon);
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
