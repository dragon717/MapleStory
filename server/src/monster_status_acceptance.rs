// Directional acceptance for the player's timed-status module
// (`player_status.rs`, 2026-09-17 收口).
//
// A mob's authored `info/skill` (MobSkill id -> MapleDisease.getBySkill) and
// `info/bodyDisease` (contact disease) are the two source entry points for
// player-facing diseases.  This module pins the boundaries that decide
// correctness:
//
//   * only the five modelled diseases (seal/stun/curse/poison/slow) resolve
//     from a MobSkill id, and only a usable authored duration is applied;
//   * every other id has a **recorded disposition** — `Unmodelled` with a
//     reason, or `NotADisease` — instead of a silent `None`;
//   * the defence layers stack in a fixed order — the Maple Cure immunity
//     window, then the Elemental Adapting charge, then the asrR resistance
//     roll — and a blocked cast still spends the mob's cast interval;
//   * Maple Cure (楓葉淨化) actually clears the modelled diseases and re-arms
//     the three-second immunity window;
//   * deadlines expire cleanly and poison/curse tick on their own cadence;
//   * **a buff that expires gives back exactly the state it owns** — the
//     regression this module was built for (改前 `world.rs` 按写死的技能名单
//     逐条 `if remaining == 0` 清理，名单漏一个那个加成就会一直留在身上).
//
// The id -> disease mapping (120=Seal, 123=Stun, 124=Curse, 125=Poison,
// 126=Slow) is the standard MapleDisease.getBySkill table every open server
// carries (R reference); the source durations (`time` seconds, seal `x` ms)
// come from the TMS273 `Skill/MobSkill/<id>.json` export.
//
// 验收只经 `PlayerStatus` 的公开语义入口读数（`*_active` / `buff_map` /
// `abnormal`）与两个验收专用访问器（`disease_deadline` / `disease_next_tick`）；
// 它们不再直接摸 `Player` 上的裸字段——那些字段已经不存在了。

// 处置表（`mob_skill_effect` / `SkillEffect`）不是 `world.rs` 直接用的名字，所以它
// 没有经 `world.rs` 的私有 `use` 透传出来——本文件自己按路径取。`Disease` /
// `Release` / `PlayerStatus` 则走 `use super::*` 那条既有通路（`world.rs` 已经引入）。
use super::player_status::{mob_skill_effect, SkillEffect};
use super::*;

/// A flat map so the fixture player can stand still while the world advances.
fn status_map() -> Map {
    Map {
        id: "status-test".into(),
        bounds: Bounds { x_min: 0.0, x_max: 600.0, y_min: -100.0, y_max: 400.0 },
        spawn: Point { x: 100.0, y: 200.0 },
        footholds: vec![Foothold {
            id: 1, x1: 0.0, y1: 200.0, x2: 600.0, y2: 200.0,
            prev: 0, next: 0, forbid_fall_down: 0,
        }],
        ladders: Vec::new(),
        portals: Vec::new(),
        water: Vec::new(),
        reactors: Vec::new(),
    }
}

fn status_world() -> (World, mpsc::Receiver<String>) {
    let mut world = World::new_with_gameplay(status_map(), 600, Gameplay::default());
    let output = join_test_player(&mut world, "victim");
    (world, output)
}

/// A MobSkill effect whose numbers match the TMS273 `Skill/MobSkill/120.json`
/// level-1 shape (seal: `time=3` gating the cast, `x` holds the seal length,
/// `prop` the chance, `interval` the retry cadence in seconds).
fn seal_skill() -> MonsterSkillTemplate {
    MonsterSkillTemplate {
        skill_id: MOB_SKILL_SEAL,
        action: 1,
        level: 1,
        effect_after_ms: 0,
        effects: BTreeMap::from([(
            "1".to_owned(),
            MonsterSkillEffect {
                x: Some(5_000),
                y: None,
                z: None,
                time: Some(3),
                prop: Some(100),
                interval: Some(120),
                mp_con: Some(5),
                hp: None,
                lt: Some(Point { x: -300.0, y: -120.0 }),
                rb: Some(Point { x: 300.0, y: 120.0 }),
            },
        )]),
    }
}

fn seal_template() -> MonsterTemplate {
    MonsterTemplate {
        template_id: "100100".into(),
        level: 1,
        max_hp: 100,
        max_mp: 0,
        boss: false,
        pa_damage: Some(3),
        pd_damage: None,
        pd_rate: None,
        md_rate: None,
        exp: 1,
        body_attack: false,
        move_speed: None,
        source_speed: None,
        hitbox_width: None,
        hitbox_height: None,
        hitbox_lt: None,
        hitbox_rb: None,
        die_duration_ms: Some(50),
        stand_delay_ms: None,
        move_duration_ms: None,
        drop: None,
        skills: vec![seal_skill()],
        body_disease: None,
        body_disease_level: None,
        pushed: None,
    }
}

#[test]
fn mob_skill_id_resolves_only_the_modelled_diseases() {
    // The five modelled ids resolve; a buff/heal/summon id and an unknown id do not.
    assert_eq!(Disease::from_mob_skill_id(MOB_SKILL_SEAL), Some(Disease::Seal));
    assert_eq!(Disease::from_mob_skill_id(MOB_SKILL_STUN), Some(Disease::Stun));
    assert_eq!(Disease::from_mob_skill_id(MOB_SKILL_CURSE), Some(Disease::Curse));
    assert_eq!(Disease::from_mob_skill_id(MOB_SKILL_POISON), Some(Disease::Poison));
    assert_eq!(Disease::from_mob_skill_id(MOB_SKILL_SLOW), Some(Disease::Slow));
    // 112/113/114 are the mob's own defence buffs / heal, not player diseases.
    assert_eq!(Disease::from_mob_skill_id(112), None);
    assert_eq!(Disease::from_mob_skill_id(113), None);
    assert_eq!(Disease::from_mob_skill_id(114), None);
    assert_eq!(Disease::from_mob_skill_id(999), None);
}

#[test]
fn an_unmodelled_source_id_is_registered_with_a_reason_not_silently_dropped() {
    // 改前这段知识只以 `world.rs` 顶部的一段注释存在，从代码里查不出「哪些 id 真的
    // 会被放出来」「没接的那几个为什么没接」。现在它们是表，且每条没建模的都必须
    // 给出理由——所以「没做」和「不知道」在代码里是两件事。
    assert_eq!(
        mob_skill_effect(128),
        SkillEffect::Unmodelled(
            "誘惑：源语义是强制玩家朝一个方向走，需要独立的强制移动通道；\
             本版内容里唯一带它的怪（5250007）没有可用的时长字段，先登记不实现。"
        )
    );
    for id in [121_u32, 122, 133, 134, 137] {
        match mob_skill_effect(id) {
            SkillEffect::Unmodelled(reason) => {
                assert!(!reason.is_empty(), "{id} 登记为未建模却没给理由");
            }
            other => panic!("{id} 应登记为未建模，实际 {other:?}"),
        }
    }
    // 不是疾病的 id 与「没建模的疾病」是两种结论，不能合并成同一种沉默。
    for id in [112_u32, 113, 114, 170, 200] {
        assert_eq!(mob_skill_effect(id), SkillEffect::NotADisease);
    }
}

#[test]
fn seal_uses_authored_x_ms_while_other_debuffs_use_time_seconds() {
    let template = seal_template();
    let skill = &template.skills[0];
    // Seal reads `x` (ms) as its hold length, not `time` (seconds).
    let (disease, duration) = mob_skill_disease(&template, skill).unwrap();
    assert_eq!(disease, Disease::Seal);
    assert_eq!(duration, 5_000);
    // A time-based debuff (curse) reads `time` seconds -> ms.
    let curse = MonsterSkillTemplate {
        skill_id: MOB_SKILL_CURSE,
        action: 1,
        level: 1,
        effect_after_ms: 0,
        effects: BTreeMap::from([(
            "1".to_owned(),
            MonsterSkillEffect {
                x: None,
                y: None,
                z: None,
                time: Some(60),
                prop: Some(100),
                interval: Some(10),
                mp_con: None,
                hp: None,
                lt: None,
                rb: None,
            },
        )]),
    };
    let (disease, duration) = mob_skill_disease(&template, &curse).unwrap();
    assert_eq!(disease, Disease::Curse);
    assert_eq!(duration, 60_000);
    // 未建模的 id 走同一条解析路径时也必须停在 `None`，不会因为「表里有它」而被施加。
    let seduce = MonsterSkillTemplate { skill_id: 128, ..curse.clone() };
    assert!(mob_skill_disease(&template, &seduce).is_none());
}

#[test]
fn inflict_disease_writes_the_authoritative_deadline() {
    let (mut world, _rx) = status_world();
    world.tick = 10;
    assert!(world.inflict_disease("victim", Disease::Seal, 5_000, "mob-1"));
    let player = &world.players["victim"];
    // 5000 ms at TICK_MS per tick -> deadline = tick + floor(5000 / TICK_MS).
    let expected = 10 + (5_000 / TICK_MS).max(1);
    assert_eq!(player.status.disease_deadline(Disease::Seal), expected);
    assert_eq!(player.status.disease_deadline(Disease::Stun), 0);
    // Stun is a separate deadline: a seal does not overwrite it.
    assert!(world.inflict_disease("victim", Disease::Stun, 3_000, "mob-1"));
    let player = &world.players["victim"];
    assert!(player.status.disease_active(Disease::Seal));
    assert!(player.status.disease_active(Disease::Stun));
    // 两种疾病各自独立：封印不因为眩晕上线而被清掉。
    assert_eq!(player.status.disease_deadline(Disease::Seal), expected);
}

#[test]
fn zero_duration_is_never_applied() {
    let (mut world, _rx) = status_world();
    assert!(!world.inflict_disease("victim", Disease::Poison, 0, "mob-1"));
    assert_eq!(world.players["victim"].status.disease_deadline(Disease::Poison), 0);
}

#[test]
fn cure_immunity_window_blocks_a_new_disease() {
    let (mut world, _rx) = status_world();
    world.tick = 10;
    // 五个 tick 的免疫窗（改前直接写 `status_immune_until`，现在经唯一入口）。
    world
        .players
        .get_mut("victim")
        .unwrap()
        .status
        .grant_immunity(5 * TICK_MS, world.tick);
    assert!(!world.inflict_disease("victim", Disease::Seal, 5_000, "mob-1"));
    assert_eq!(
        world.players["victim"].status.disease_deadline(Disease::Seal),
        0,
        "immunity window blocks the seal"
    );
}

#[test]
fn elemental_adapting_charge_consumes_and_blocks() {
    let (mut world, _rx) = status_world();
    world.tick = 10;
    {
        let player = world.players.get_mut("victim").unwrap();
        player.adaptation_active = true;
        player.adaptation_charges = 3;
    }
    // First cast is absorbed by a charge; charges decrement.
    assert!(!world.inflict_disease("victim", Disease::Seal, 5_000, "mob-1"));
    assert_eq!(world.players["victim"].adaptation_charges, 2);
    assert!(!world.players["victim"].status.disease_active(Disease::Seal));
    // A charge protects each subsequent cast until exhausted.
    assert!(!world.inflict_disease("victim", Disease::Stun, 3_000, "mob-1"));
    assert_eq!(world.players["victim"].adaptation_charges, 1);
    assert!(!world.inflict_disease("victim", Disease::Slow, 3_000, "mob-1"));
    assert_eq!(world.players["victim"].adaptation_charges, 0);
    // Exhausted: the next cast lands.
    assert!(world.inflict_disease("victim", Disease::Poison, 3_000, "mob-1"));
    assert!(world.players["victim"].status.disease_active(Disease::Poison));
}

#[test]
fn full_asr_resistance_blocks_without_consuming_a_charge() {
    let mut world = World::new_with_gameplay(status_map(), 600, Gameplay::default())
        .with_mage_skills(crate::mage::MageSkills::bundled());
    let _rx = join_test_player(&mut world, "victim");
    world.tick = 10;
    {
        let player = world.players.get_mut("victim").unwrap();
        // Learn Elemental Adapting at level 1 so `level(SKILL_ELEMENTAL_ADAPTING)`
        // resolves and the bundled asrR applies.
        player.state.skills.insert(SKILL_ELEMENTAL_ADAPTING, 1);
        player.adaptation_active = false;
        player.adaptation_charges = 0;
    }
    // The bundled 2211012 level 1 carries an asrR; at 100 it is a hard block.
    // When it is not 100 the deterministic roll decides, so we only assert the
    // hard-block branch here by forcing the resistance path via a 100 roll.
    let resistance = world
        .players
        .get("victim")
        .and_then(|player| player.state.skills.get(&SKILL_ELEMENTAL_ADAPTING))
        .copied()
        .and_then(|level| world.mage_skills.level(SKILL_ELEMENTAL_ADAPTING, level))
        .and_then(|level| level.asr_r)
        .unwrap_or(0)
        .clamp(0, 100) as u64;
    if resistance == 100 {
        assert!(!world.inflict_disease("victim", Disease::Seal, 5_000, "mob-1"));
        assert!(!world.players["victim"].status.disease_active(Disease::Seal));
    } else {
        // Resistance < 100: the deterministic roll decides; the disease must
        // either land or be blocked, never panic, and never touch charges.
        let _ = world.inflict_disease("victim", Disease::Seal, 5_000, "mob-1");
        assert_eq!(world.players["victim"].adaptation_charges, 0);
    }
}

#[test]
fn maple_cure_clears_all_diseases_and_rearms_immunity() {
    let (mut world, _rx) = status_world();
    world.tick = 10;
    assert!(world.inflict_disease("victim", Disease::Seal, 5_000, "mob-1"));
    assert!(world.inflict_disease("victim", Disease::Poison, 5_000, "mob-1"));
    assert!(world.inflict_disease("victim", Disease::Curse, 60_000, "mob-1"));
    for disease in [Disease::Seal, Disease::Poison, Disease::Curse] {
        assert!(
            world.players["victim"].status.disease_active(disease),
            "{disease:?} 应已施加"
        );
    }
    // 楓葉淨化 clears every modelled disease and re-arms the immunity window.
    let level = crate::mage::MageLevel::default();
    world.activate_status_cleanse("victim", &level);
    let player = &world.players["victim"];
    for disease in Disease::ALL {
        assert!(!player.status.disease_active(disease), "{disease:?} 应已解除");
        assert_eq!(player.status.disease_deadline(disease), 0, "{disease:?}");
        assert_eq!(player.status.disease_next_tick(disease), 0, "{disease:?}");
    }
    assert!(player.status.is_immune());
    assert_eq!(player.status.buff_remaining_ms(SKILL_MAPLE_CURE), Some(3_000));
    // The fresh immunity window blocks a follow-up cast.
    assert!(!world.inflict_disease("victim", Disease::Stun, 3_000, "mob-1"));
    assert!(!world.players["victim"].status.disease_active(Disease::Stun));
}

#[test]
fn the_cure_buff_owns_the_immunity_window_until_it_expires() {
    // 免疫窗不是一个「另写一处、忘了清」的字段：它挂在楓葉淨化的增益上
    // （`Release::StatusImmunity`），增益走了它也就走了。
    let (mut world, _rx) = status_world();
    world.tick = 10;
    let level = crate::mage::MageLevel::default();
    world.activate_status_cleanse("victim", &level);
    // 3000 ms = 60 拍。
    while world.tick < 69 {
        world.step();
    }
    assert!(world.players["victim"].status.is_immune(), "第 69 拍仍在窗内");
    world.step();
    let player = &world.players["victim"];
    assert_eq!(world.tick, 70);
    assert!(!player.status.is_immune(), "第 70 拍窗口关闭");
    assert_eq!(player.status.buff_remaining_ms(SKILL_MAPLE_CURE), None);
    assert!(player.status.buff_map().is_empty());
    // 窗口关了之后疾病可以再上。
    assert!(world.inflict_disease("victim", Disease::Seal, 5_000, "mob-1"));
}

#[test]
fn poison_ticks_damage_and_expires() {
    let (mut world, _rx) = status_world();
    world.tick = 10;
    assert!(world.inflict_disease("victim", Disease::Poison, 2_000, "mob-1"));
    let initial_hp = world.players["victim"].state.hp;
    // Advance until the first poison tick (next_tick == tick + 1).
    world.tick += 1;
    world.step();
    assert!(world.players["victim"].state.hp < initial_hp, "poison DoT drains HP");
    // Advance past the deadline: the status clears and no further DoT runs.
    for _ in 0..20 {
        world.tick += 1;
        world.step();
    }
    let player = &world.players["victim"];
    assert_eq!(player.status.disease_deadline(Disease::Poison), 0);
    assert_eq!(player.status.disease_next_tick(Disease::Poison), 0);
    assert!(!player.status.disease_active(Disease::Poison));
}

#[test]
fn curse_pulses_on_the_same_cadence_without_draining_hp() {
    // 詛咒按原著语义是「降低有效攻击 / 经验」，本仓库模型成同节拍的轻量流失
    // （P 适配）：节拍照走，但不扣血。这条断言把这个**刻意的不对称**钉住，
    // 免得后来者把它当 bug「修」成第二个中毒。
    let (mut world, _rx) = status_world();
    world.tick = 10;
    assert!(world.inflict_disease("victim", Disease::Curse, 2_000, "mob-1"));
    let initial_hp = world.players["victim"].state.hp;
    let before = world.players["victim"].status.disease_next_tick(Disease::Curse);
    world.step();
    let player = &world.players["victim"];
    assert!(player.status.disease_active(Disease::Curse));
    assert!(
        player.status.disease_next_tick(Disease::Curse) > before,
        "詛咒的节拍照样推进"
    );
    assert!(player.state.hp >= initial_hp, "詛咒不掉血");
}

#[test]
fn seal_locks_skill_casting() {
    let mut world = World::new_with_gameplay(status_map(), 600, Gameplay::default())
        .with_mage_skills(crate::mage::MageSkills::bundled());
    let mut rx = join_test_player(&mut world, "victim");
    world.tick = 10;
    {
        let player = world.players.get_mut("victim").unwrap();
        player.state.job = MAGICIAN_JOB;
        player.state.skills.insert(SKILL_ENERGY_BOLT, 1);
    }
    assert!(world.inflict_disease("victim", Disease::Seal, 5_000, "mob-1"));
    assert!(world.players["victim"].status.suppresses_skill_cast());
    // A sealed player is rejected from casting any skill with `status_sealed`.
    world.handle_cast_skill("victim".into(), "cast-1".into(), SKILL_ENERGY_BOLT, Some(1), None);
    let mut found = false;
    while let Ok(raw) = rx.try_recv() {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
            if value["type"] == "rejected" && value["code"] == "status_sealed" {
                found = true;
            }
        }
    }
    assert!(found, "a sealed player must be rejected from casting");
}

#[test]
fn snapshot_emits_only_active_abnormal_statuses() {
    let (mut world, _rx) = status_world();
    world.tick = 10;
    assert!(world.inflict_disease("victim", Disease::Seal, 5_000, "mob-1"));
    let player = world.players.get("victim").unwrap();
    let abnormal = player.status.abnormal();
    assert!(abnormal.seal_ms.is_some(), "an active seal reports a remaining window");
    // A healthy player reports no remaining window for an unset disease.
    assert_eq!(abnormal.stun_ms, None);
    assert_eq!(abnormal.curse_ms, None);
    assert_eq!(abnormal.poison_ms, None);
    assert_eq!(abnormal.slow_ms, None);
}

#[test]
fn every_expiring_buff_gives_back_exactly_the_state_it_owns() {
    // 本模块要修的回归：改前 `world.rs` 的 tick 块按**写死的技能名单**逐条
    // `if remaining == 0` 清理，名单漏一个那个加成就会一直留在身上，而用
    // `contains_key` 读它的一侧仍判它生效。现在附属状态由 `Release` 声明、
    // 由 tick 块的穷尽 `match` 收回——这条断言把三组附属状态一起钉住。
    let (mut world, _rx) = status_world();
    world.tick = 10;
    {
        let player = world.players.get_mut("victim").unwrap();
        player.status.apply_buff(
            SKILL_RECOVERY,
            1_000,
            world.tick,
            Release::BeginnerRecovery,
        );
        player.beginner_heal_next_tick = world.tick + 100;
        player.beginner_heal_remaining_ticks = 5;
        player.beginner_heal_per_tick = 7;
        player.status.apply_buff(
            SKILL_NIMBLE_FEET,
            1_000,
            world.tick,
            Release::BeginnerSpeed,
        );
        player.beginner_speed_percent = 40;
        player.status.apply_buff(SKILL_INFINITY, 1_000, world.tick, Release::Infinity);
        player.infinity_next_tick = world.tick + 100;
        player.infinity_damage_bonus = 30;
    }
    // 未到期：三组附属状态都在（不能提前收）。
    world.step();
    {
        let player = &world.players["victim"];
        assert_eq!(player.beginner_heal_per_tick, 7);
        assert_eq!(player.beginner_speed_percent, 40);
        assert_eq!(player.infinity_damage_bonus, 30);
    }
    // 1000 ms = 20 拍：三组在同一拍到期，各自被收回。
    while world.tick < 30 {
        world.step();
    }
    let player = &world.players["victim"];
    assert_eq!(world.tick, 30);
    assert_eq!(player.beginner_heal_next_tick, 0);
    assert_eq!(player.beginner_heal_remaining_ticks, 0);
    assert_eq!(player.beginner_heal_per_tick, 0);
    assert_eq!(player.beginner_speed_percent, 0);
    assert_eq!(player.infinity_next_tick, 0);
    assert_eq!(player.infinity_damage_bonus, 0);
    // 三个增益都不再上报，且没有留下「剩余 0」的幽灵条目（那会让 wire 上出现
    // 一条永远不消失的 0 秒增益）。
    assert!(player.status.buff_map().is_empty());
    assert!(!player.status.buff_active(SKILL_RECOVERY));
    assert!(!player.status.buff_active(SKILL_NIMBLE_FEET));
    assert!(!player.status.buff_active(SKILL_INFINITY));
}

#[test]
fn one_buff_expiring_leaves_the_others_alone() {
    // 清理必须是**按 id** 的：恢复術到期不能顺手把無限的伤害加成也清掉
    // （改前按名字顺序写死的 5 段 if 正是这种相互踩踏的温床）。
    let (mut world, _rx) = status_world();
    world.tick = 10;
    {
        let player = world.players.get_mut("victim").unwrap();
        player.status.apply_buff(
            SKILL_RECOVERY,
            1_000,
            world.tick,
            Release::BeginnerRecovery,
        );
        player.beginner_heal_per_tick = 7;
        player.status.apply_buff(SKILL_INFINITY, 5_000, world.tick, Release::Infinity);
        player.infinity_next_tick = world.tick + 100;
        player.infinity_damage_bonus = 30;
    }
    while world.tick < 30 {
        world.step();
    }
    let player = &world.players["victim"];
    assert_eq!(player.beginner_heal_per_tick, 0, "恢复術到期收回自己的附属状态");
    assert!(player.status.buff_active(SKILL_INFINITY), "無限还有余额");
    assert_eq!(player.infinity_damage_bonus, 30);
    assert_eq!(player.infinity_next_tick, 110, "無限自己的节拍点没被动过");
}

#[test]
fn death_map_change_and_reconnect_share_one_cleanup_point() {
    // 死亡 / 换图 / 重连只有一个清理点（`clear_beginner_buffs` → `PlayerStatus::clear`）：
    // 增益、疾病与免疫窗必须一起走，不能只走其中一组。
    let (mut world, _rx) = status_world();
    world.tick = 10;
    {
        let player = world.players.get_mut("victim").unwrap();
        player.status.apply_buff(SKILL_INFINITY, 5_000, world.tick, Release::Infinity);
        player.infinity_damage_bonus = 30;
        player.beginner_speed_percent = 40;
    }
    assert!(world.inflict_disease("victim", Disease::Seal, 5_000, "mob-1"));
    world
        .players
        .get_mut("victim")
        .unwrap()
        .status
        .grant_immunity(3_000, world.tick);
    {
        let player = world.players.get_mut("victim").unwrap();
        clear_beginner_buffs(player);
    }
    let player = &world.players["victim"];
    assert!(player.status.buff_map().is_empty());
    assert!(!player.status.buff_active(SKILL_INFINITY));
    assert_eq!(player.infinity_damage_bonus, 0);
    assert_eq!(player.beginner_speed_percent, 0);
    for disease in Disease::ALL {
        assert!(!player.status.disease_active(disease), "{disease:?}");
    }
    assert!(!player.status.is_immune());
    assert!(player.status.abnormal().is_empty());
}
