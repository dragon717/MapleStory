//! 属性派生纯函数。
//!
//! 负责：由职业/基础属性/法师技能推导 `derived_stats` 与 `derived_max_mp`
//! （`compute_derived_stats`），以及把派生结果连同升级表回写进玩家状态
//! （`refresh_player_derived`，被 growth / skills / elemental / dialogue / revive 等
//! 众多子模块在状态变更后调用）。
//! 不负责：HP/MP 的自然恢复节奏（`world.rs` 的 step 路径）、存档读写（`auth` 的 Store）。
//!
//! 接线：自由函数裸名调用靠 `world.rs` 的 `use self::derived::*;` 恢复，
//! 并经各兄弟子模块的 `use super::*;` 透传（与 auth/db.rs 同模式）。

use super::*;

pub(super) fn compute_derived_stats(
    gameplay: &Gameplay,
    mage_skills: &MageSkills,
    job: u32,
    base_max_mp: i64,
    character_level: u32,
    skills: &BTreeMap<u32, u32>,
    ability_stats: &AbilityStats,
    equipped: &[crate::protocol::InventoryItem],
    magic_guard: bool,
    meditation_mad: i64,
    meditation_remaining_ms: Option<u64>,
    ice_teleport: bool,
    teleport_mastery: bool,
    teleport_boost: bool,
    hyper_barrier_active: bool,
    hyper_teleport_enabled: bool,
    adaptation_charges: u32,
    adaptation_cooldown_ms: Option<u64>,
    beginner_speed_percent: i64,
    skill_cooldowns: &BTreeMap<u32, u64>,
    skill_buffs: &BTreeMap<u32, u64>,
) -> (DerivedStats, i64) {
    let mut config = gameplay.player.clone();
    // PlayerConfig::with_equipment treats maxMp as the unmodified character
    // baseline.  Keep the persisted baseline separate from the wire snapshot
    // so Magic Boost and equipment can be recomputed without compounding.
    config.max_mp = Some(base_max_mp.max(0));
    let int_bonus = [SKILL_INTELLIGENCE, SKILL_BOOSTER]
        .iter()
        .filter_map(|skill_id| {
            skills
                .get(skill_id)
                .and_then(|level| mage_skills.level(*skill_id, *level))
                .and_then(|level| level.int_x)
        })
        .sum::<i64>();
    let mut ability = ability_stats.clone();
    ability.intelligence = ability.intelligence.saturating_add(int_bonus);
    // Maple Warrior's source marker is an AP-only percentage.  Apply it to
    // the persisted four stat values before equipment is folded in, so gear
    // never receives the passive multiplier.
    let basic_stat_up = skills
        .get(&SKILL_MAPLE_WARRIOR)
        .and_then(|level| mage_skills.level(SKILL_MAPLE_WARRIOR, *level))
        .and_then(|level| level.basic_stat_up)
        .unwrap_or(0)
        .clamp(0, 100);
    if basic_stat_up > 0 {
        let scale = |value: i64| value.saturating_mul(100 + basic_stat_up) / 100;
        ability.strength = scale(ability.strength);
        ability.dexterity = scale(ability.dexterity);
        ability.intelligence = scale(ability.intelligence);
        ability.luck = scale(ability.luck);
    }
    let mut derived = config.with_ability_stats(&ability, equipped, job);
    let bonus = |key: &str| {
        equipped.iter().fold(0i64, |total, item| {
            total.saturating_add(inventory::equipment_attribute(item, key))
        })
    };
    let raw_mp = derived.max_mp.unwrap_or(0).max(0);
    let boost_level = skills.get(&SKILL_MAGIC_BOOST).copied().unwrap_or(0);
    let boost = mage_skills.level(SKILL_MAGIC_BOOST, boost_level);
    let boost_percent = boost.and_then(|level| level.mmp_r).unwrap_or(0).max(0);
    let boost_flat = boost.and_then(|level| level.lv2mmp).unwrap_or(0).max(0);
    let derived_max_mp = raw_mp
        .saturating_add(raw_mp.saturating_mul(boost_percent) / 100)
        // P: String.h describes lv2mmp as per-character-level MP; use the
        // current level during every recomputation so reconnects/equipment
        // changes cannot compound the bonus.
        .saturating_add(boost_flat.saturating_mul(i64::from(character_level.max(1))))
        .max(if mage_job_allowed(job) {
            MAGE_TRANSFER_MIN_MP
        } else {
            0
        });
    let spell_mastery = skills
        .get(&SKILL_SPELL_MASTERY)
        .and_then(|level| mage_skills.level(SKILL_SPELL_MASTERY, *level))
        .and_then(|level| level.mastery)
        .map(|value| (value as f64 / 100.0).clamp(0.0, 1.0))
        .unwrap_or_else(|| derived.mastery.unwrap_or(0.1));
    let demon_mastery = skills
        .get(&SKILL_ICE_DEMON)
        .and_then(|level| mage_skills.level(SKILL_ICE_DEMON, *level))
        .and_then(|level| level.mastery)
        .map(|value| (value as f64 / 100.0).clamp(0.0, 1.0))
        .unwrap_or(0.0);
    // Ice Demon's source mastery is a permanent coverage value: it replaces
    // a lower Spell Mastery value and never adds a second mastery band.
    derived.mastery = Some(spell_mastery.max(demon_mastery));
    let int = derived.base_int.unwrap_or(0).max(0);
    let luk = derived.base_luk.unwrap_or(0).max(0);
    let master_magic_level = skills
        .get(&SKILL_MASTER_MAGIC)
        .and_then(|level| mage_skills.level(SKILL_MASTER_MAGIC, *level));
    let master_magic_mad = master_magic_level
        .and_then(|level| level.mad_x)
        .unwrap_or(0)
        .max(0);
    // P: the selected export does not contain the final player magic formula;
    // this deliberately visible first-job rule gives INT/LUK/level/MAD all a
    // real effect while keeping the same value in damage and snapshots.
    let magic_attack = int
        .saturating_mul(4)
        .saturating_add(luk)
        .saturating_add(i64::from(character_level.max(1)))
        .saturating_add(
            skills
                .get(&SKILL_SPELL_MASTERY)
                .and_then(|level| mage_skills.level(SKILL_SPELL_MASTERY, *level))
                .and_then(|level| level.x)
                .unwrap_or(0)
                .max(0),
        )
        .saturating_add(meditation_mad.max(0))
        .saturating_add(master_magic_mad)
        .saturating_add(bonus("incMAD"))
        .max(1);
    let shield_level = skills.get(&SKILL_MAGIC_SHIELD).copied().unwrap_or(0);
    let shield_bonus = mage_skills
        .level(SKILL_MAGIC_SHIELD, shield_level)
        .and_then(|level| level.pdd_x)
        .unwrap_or(0)
        .max(0);
    let defense = derived
        .weapon_defense
        .unwrap_or(0)
        .max(0)
        .saturating_add(shield_bonus);
    let teleport_level = skills.get(&SKILL_TELEPORT).copied().unwrap_or(0);
    let teleport_speed = mage_skills
        .level(SKILL_TELEPORT, teleport_level)
        .and_then(|level| level.psd_speed)
        .unwrap_or(0)
        .max(0);
    let teleport_speed_max = mage_skills
        .level(SKILL_TELEPORT, teleport_level)
        .and_then(|level| level.speed_max)
        .unwrap_or(0)
        .max(0);
    // P: psdSpeed is the passive percent and speedMax is used as its source
    // cap; the exported values are applied to the real 125 px/s walker.
    let source_speed_percent = bonus("incSpeed").saturating_add(teleport_speed).clamp(
        0,
        if teleport_speed_max > 0 {
            teleport_speed_max.min(100)
        } else {
            100
        },
    );
    let speed_percent = source_speed_percent
        .saturating_add(beginner_speed_percent.max(0))
        .clamp(0, 100);
    let move_speed = WALK_SPEED * (1.0 + speed_percent as f64 / 100.0);
    let adaptation_level = skills
        .get(&SKILL_ELEMENTAL_ADAPTING)
        .copied()
        .and_then(|level| mage_skills.level(SKILL_ELEMENTAL_ADAPTING, level));
    let status_resistance = adaptation_level.and_then(|level| level.asr_r);
    let element_resistance = adaptation_level.and_then(|level| level.ter_r);
    let infinity_enhanced = skill_buffs
        .get(&SKILL_INFINITY)
        .copied()
        .filter(|remaining| *remaining > 0)
        .is_some_and(|remaining| {
            let Some(infinity_level) = skills
                .get(&SKILL_INFINITY)
                .and_then(|level| mage_skills.level(SKILL_INFINITY, *level))
            else {
                return false;
            };
            let source_time_ms = u64::try_from(infinity_level.time.unwrap_or(0).max(0))
                .unwrap_or(0)
                .saturating_mul(1_000);
            let bufftime = master_magic_level
                .and_then(|level| level.buff_time_r)
                .unwrap_or(0)
                .max(0) as u64;
            let full_ms = source_time_ms.saturating_mul(100 + bufftime) / 100;
            let threshold_percent = infinity_level.w2.unwrap_or(30).clamp(0, 100) as u64;
            let threshold = full_ms.saturating_mul(threshold_percent) / 100;
            full_ms > 0 && remaining <= threshold
        });
    (
        DerivedStats {
            magic_attack,
            defense,
            move_speed,
            magic_guard: magic_guard && skills.get(&SKILL_MAGIC_GUARD).copied().unwrap_or(0) > 0,
            hyper_barrier_active,
            hyper_teleport_enabled,
            damage_reduction_percent: if hyper_barrier_active { 20 } else { 0 },
            regeneration_passives: regeneration_passives_for_job(job),
            meditation_remaining_ms,
            skill_cooldowns: (!skill_cooldowns.is_empty()).then(|| skill_cooldowns.clone()),
            skill_buffs: (!skill_buffs.is_empty()).then(|| skill_buffs.clone()),
            infinity_enhanced,
            ice_teleport: Some(ice_teleport),
            teleport_mastery: skills
                .contains_key(&SKILL_TELEPORT_MASTERY)
                .then_some(teleport_mastery),
            teleport_boost: skills
                .contains_key(&SKILL_TELEPORT_BOOST)
                .then_some(teleport_boost),
            adaptation_charges: skills
                .contains_key(&SKILL_ELEMENTAL_ADAPTING)
                .then_some(adaptation_charges),
            adaptation_cooldown_ms,
            status_resistance,
            element_resistance,
            strength: Some(derived.base_str.unwrap_or(0).max(0)),
            dexterity: Some(derived.base_dex.unwrap_or(0).max(0)),
            intelligence: Some(int),
            luck: Some(luk),
        },
        derived_max_mp,
    )
}

pub(super) fn refresh_player_derived(
    gameplay: &Gameplay,
    mage_skills: &MageSkills,
    player: &mut Player,
) {
    let (derived_stats, derived_max_mp) = compute_derived_stats(
        gameplay,
        mage_skills,
        player.state.job,
        player.base_max_mp,
        player.state.level,
        &player.state.skills,
        &player.state.ability_stats,
        &player.state.equipped,
        player.magic_guard,
        player.meditation_mad,
        None,
        player.ice_teleport_enabled,
        player.teleport_mastery_enabled,
        player.teleport_boost_enabled,
        hyper_barrier_active(player),
        player.hyper_teleport_enabled,
        if player.adaptation_active {
            player.adaptation_charges
        } else {
            0
        },
        (player.adaptation_cooldown_ms > 0).then_some(player.adaptation_cooldown_ms),
        player.beginner_speed_percent,
        &player.skill_cooldowns,
        &player.skill_buffs,
    );
    player.state.derived_stats = derived_stats.clone();
    player.state.max_mp = derived_max_mp;
    player.state.mp = player.state.mp.clamp(0, derived_max_mp);
    player.move_speed = derived_stats.move_speed;
}
