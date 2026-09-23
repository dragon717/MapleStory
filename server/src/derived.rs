//! 属性派生纯函数。
//!
//! 职责：把 [`aggregate_attributes`] 算出的属性**组装成协议快照** `DerivedStats`
//! （`compute_derived_stats`），以及把快照回写进玩家状态
//! （`refresh_player_derived`，被 growth / skills / elemental / dialogue / revive 等
//! 众多子模块在状态变更后调用）。
//!
//! **本模块不再自己算任何属性口径**：四维、魔法攻击、防御、熟练度、最大 HP/MP、
//! 移动速度、状态/元素抗性一律来自 `attribute.rs` 的聚合结果（层序与加算/取高者
//! 的规定都在那里）。这里只负责「哪些字段要上报」与「运行期开关怎么投影」。
//!
//! 不负责：HP/MP 的自然恢复节奏（`world.rs` 的 step 路径）、存档读写（`auth` 的 Store）。
//!
//! 接线：自由函数裸名调用靠 `world.rs` 的 `use self::derived::*;` 恢复，
//! 并经各兄弟子模块的 `use super::*;` 透传（与 auth/db.rs 同模式）。

use super::*;

/// `DerivedStats` 里那些**不属于属性**的运行期开关。
///
/// 收成一个结构的原因：改前 `compute_derived_stats` 有 16 个位置参数，其中 11 个是
/// 开关/表，调用点写错顺序编译器不会说话（`false, false, false, 0, None, …`）。
/// 这些开关各自只有一个来源（`Player` 或加入路径的 profile），所以让它们自带取值方式。
pub(super) struct DerivedRuntime<'a> {
    pub(super) magic_guard: bool,
    pub(super) meditation_remaining_ms: Option<u64>,
    pub(super) ice_teleport: bool,
    pub(super) teleport_mastery: bool,
    pub(super) teleport_boost: bool,
    pub(super) hyper_barrier_active: bool,
    pub(super) hyper_teleport_enabled: bool,
    pub(super) adaptation_charges: u32,
    pub(super) adaptation_cooldown_ms: Option<u64>,
    pub(super) skill_cooldowns: &'a BTreeMap<u32, u64>,
    /// `PlayerStatus::buff_map()` 返回的是**所有权**（复制一份），所以这里也留所有权。
    pub(super) skill_buffs: BTreeMap<u32, u64>,
}

impl<'a> DerivedRuntime<'a> {
    /// 在世界的 tick / 重算路径上，从 `Player` 取运行期开关。
    /// `meditation_remaining_ms` 由调用方给出——tick 路径知道真实剩余（拿 tick 算），
    /// 而「状态变更后立刻重算」那几个点没有 tick，只能报 `None`（改前就是这个行为）。
    pub(super) fn of(player: &'a Player, meditation_remaining_ms: Option<u64>) -> Self {
        Self {
            magic_guard: player.magic_guard,
            meditation_remaining_ms,
            ice_teleport: player.ice_teleport_enabled,
            teleport_mastery: player.teleport_mastery_enabled,
            teleport_boost: player.teleport_boost_enabled,
            hyper_barrier_active: hyper_barrier_active(player),
            hyper_teleport_enabled: player.hyper_teleport_enabled,
            adaptation_charges: if player.adaptation_active {
                player.adaptation_charges
            } else {
                0
            },
            adaptation_cooldown_ms: (player.adaptation_cooldown_ms > 0)
                .then_some(player.adaptation_cooldown_ms),
            skill_cooldowns: &player.skill_cooldowns,
            skill_buffs: player.status.buff_map(),
        }
    }

    /// 加入路径（`commands.rs` 的 join）：此刻还没有 `Player`，所以除「装备冷却还剩多少」
    /// 之外一个开关都不成立——状态类（魔心 / 冥想 / 冰雷传送 / 熟练传送 / 超能屏障 /
    /// 元素适应）在存档里没有位置，加入时不带任何增益。改前这里是一串
    /// `false, false, false, 0, None, …` 的位置参数，写错顺序编译器不说话。
    pub(super) fn joining(
        adaptation_cooldown_ms: u64,
        skill_cooldowns: &'a BTreeMap<u32, u64>,
    ) -> Self {
        Self {
            magic_guard: false,
            meditation_remaining_ms: None,
            ice_teleport: false,
            teleport_mastery: false,
            teleport_boost: false,
            hyper_barrier_active: false,
            hyper_teleport_enabled: false,
            adaptation_charges: 0,
            adaptation_cooldown_ms: (adaptation_cooldown_ms > 0).then_some(adaptation_cooldown_ms),
            skill_cooldowns,
            skill_buffs: BTreeMap::new(),
        }
    }
}

/// 把聚合后的属性组装成协议快照。**不含任何属性口径**——那些在 `attribute.rs`。
pub(super) fn compute_derived_stats(
    mage_skills: &MageSkills,
    attributes: &PlayerAttributes,
    skills: &BTreeMap<u32, u32>,
    job: u32,
    runtime: &DerivedRuntime<'_>,
) -> DerivedStats {
    // 无限：增益生效中、且剩余时长已进入源 `w2` 的加强段时才上报「已强化」。
    // 阈值 = 全时长 × w2%，全时长 = 源 time × (100 + 大師魔法 bufftimeR)%。
    // 「哪一本在生效」取自 `INFINITY_SKILLS`（2221004 / 2121004 / 2321004），
    // 不再写死冰雷那一本——火毒／主教玩家的 `infinityEnhanced` 改前永远是 false。
    let active_infinity = INFINITY_SKILLS
        .iter()
        .copied()
        .find(|skill_id| runtime.skill_buffs.contains_key(skill_id));
    let infinity_enhanced = if let Some(infinity_skill) = active_infinity {
        let level = skills
            .get(&infinity_skill)
            .and_then(|level| mage_skills.level(infinity_skill, *level));
        match level {
            None => false,
            Some(infinity_level) => {
                let remaining = runtime.skill_buffs[&infinity_skill];
                let source_time_ms = u64::try_from(infinity_level.time.unwrap_or(0).max(0))
                    .unwrap_or(0)
                    .saturating_mul(1_000);
                let bufftime = skills
                    .get(&SKILL_MASTER_MAGIC)
                    .and_then(|level| mage_skills.level(SKILL_MASTER_MAGIC, *level))
                    .and_then(|level| level.buff_time_r)
                    .unwrap_or(0)
                    .max(0) as u64;
                let full_ms = source_time_ms.saturating_mul(100 + bufftime) / 100;
                let threshold_percent = infinity_level.w2.unwrap_or(30).clamp(0, 100) as u64;
                let threshold = full_ms.saturating_mul(threshold_percent) / 100;
                full_ms > 0 && remaining <= threshold
            }
        }
    } else {
        false
    };
    DerivedStats {
        magic_attack: attributes.magic_attack,
        defense: attributes.defense(),
        move_speed: attributes.move_speed,
        magic_guard: runtime.magic_guard && skills.get(&SKILL_MAGIC_GUARD).copied().unwrap_or(0) > 0,
        hyper_barrier_active: runtime.hyper_barrier_active,
        hyper_teleport_enabled: runtime.hyper_teleport_enabled,
        damage_reduction_percent: if runtime.hyper_barrier_active { 20 } else { 0 },
        regeneration_passives: regeneration_passives_for_job(job),
        meditation_remaining_ms: runtime.meditation_remaining_ms,
        skill_cooldowns: (!runtime.skill_cooldowns.is_empty())
            .then(|| runtime.skill_cooldowns.clone()),
        skill_buffs: (!runtime.skill_buffs.is_empty()).then(|| runtime.skill_buffs.clone()),
        infinity_enhanced,
        ice_teleport: Some(runtime.ice_teleport),
        teleport_mastery: skills
            .contains_key(&SKILL_TELEPORT_MASTERY)
            .then_some(runtime.teleport_mastery),
        teleport_boost: skills
            .contains_key(&SKILL_TELEPORT_BOOST)
            .then_some(runtime.teleport_boost),
        adaptation_charges: skills
            .contains_key(&SKILL_ELEMENTAL_ADAPTING)
            .then_some(runtime.adaptation_charges),
        adaptation_cooldown_ms: runtime.adaptation_cooldown_ms,
        status_resistance: attributes.status_resistance,
        element_resistance: attributes.element_resistance,
        strength: Some(attributes.strength()),
        dexterity: Some(attributes.dexterity()),
        intelligence: Some(attributes.intelligence()),
        luck: Some(attributes.luck()),
    }
}

pub(super) fn refresh_player_derived(
    gameplay: &Gameplay,
    mage_skills: &MageSkills,
    player: &mut Player,
) {
    let attributes = aggregate_attributes(AttributeInput::of(gameplay, mage_skills, player));
    let derived_stats = compute_derived_stats(
        mage_skills,
        &attributes,
        &player.state.skills,
        player.state.job,
        &DerivedRuntime::of(player, None),
    );
    player.state.derived_stats = derived_stats.clone();
    player.state.max_mp = attributes.max_mp();
    player.state.mp = player.state.mp.clamp(0, attributes.max_mp());
    player.move_speed = derived_stats.move_speed;
}
