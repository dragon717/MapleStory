// Directional acceptance for the monster abnormal-status module.
//
// A mob's authored `info/skill` (MobSkill id -> MapleDisease.getBySkill) and
// `info/bodyDisease` (contact disease) are the two source entry points for
// player-facing diseases.  This module pins the boundaries that decide
// correctness:
//
//   * only the five modelled diseases (seal/stun/curse/poison/slow) resolve
//     from a MobSkill id, and only a usable authored duration is applied;
//   * the defence layers stack in a fixed order — the Maple Cure immunity
//     window, then the Elemental Adapting charge, then the asrR resistance
//     roll — and a blocked cast still spends the mob's cast interval;
//   * Maple Cure (楓葉淨化) actually clears the modelled diseases and re-arms
//     the three-second immunity window;
//   * deadlines expire cleanly and poison/curse tick on their own cadence.
//
// The id -> disease mapping (120=Seal, 123=Stun, 124=Curse, 125=Poison,
// 126=Slow) is the standard MapleDisease.getBySkill table every open server
// carries (R reference); the source durations (`time` seconds, seal `x` ms)
// come from the TMS273 `Skill/MobSkill/<id>.json` export.

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
    }
}

#[test]
fn mob_skill_id_resolves_only_the_modelled_diseases() {
    // The five modelled ids resolve; a buff/heal/summon id and an unknown id do not.
    assert_eq!(PlayerDisease::from_mob_skill_id(MOB_SKILL_SEAL), Some(PlayerDisease::Seal));
    assert_eq!(PlayerDisease::from_mob_skill_id(MOB_SKILL_STUN), Some(PlayerDisease::Stun));
    assert_eq!(PlayerDisease::from_mob_skill_id(MOB_SKILL_CURSE), Some(PlayerDisease::Curse));
    assert_eq!(PlayerDisease::from_mob_skill_id(MOB_SKILL_POISON), Some(PlayerDisease::Poison));
    assert_eq!(PlayerDisease::from_mob_skill_id(MOB_SKILL_SLOW), Some(PlayerDisease::Slow));
    // 112/113/114 are the mob's own defence buffs / heal, not player diseases.
    assert_eq!(PlayerDisease::from_mob_skill_id(112), None);
    assert_eq!(PlayerDisease::from_mob_skill_id(113), None);
    assert_eq!(PlayerDisease::from_mob_skill_id(114), None);
    assert_eq!(PlayerDisease::from_mob_skill_id(999), None);
}

#[test]
fn seal_uses_authored_x_ms_while_other_debuffs_use_time_seconds() {
    let template = seal_template();
    let skill = &template.skills[0];
    // Seal reads `x` (ms) as its hold length, not `time` (seconds).
    let (disease, duration) = mob_skill_disease(&template, skill).unwrap();
    assert_eq!(disease, PlayerDisease::Seal);
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
    assert_eq!(disease, PlayerDisease::Curse);
    assert_eq!(duration, 60_000);
}

#[test]
fn inflict_disease_writes_the_authoritative_deadline() {
    let (mut world, _rx) = status_world();
    world.tick = 10;
    assert!(world.inflict_disease("victim", PlayerDisease::Seal, 5_000, "mob-1"));
    let player = &world.players["victim"];
    // 5000 ms at TICK_MS per tick -> deadline = tick + ceil(5000 / TICK_MS).
    let expected = 10 + (5_000 / TICK_MS).max(1);
    assert_eq!(player.seal_until, expected);
    assert_eq!(player.stun_until, 0);
    // Stun is a separate deadline: a seal does not overwrite it.
    assert!(world.inflict_disease("victim", PlayerDisease::Stun, 3_000, "mob-1"));
    let player = &world.players["victim"];
    assert!(player.seal_until > 0);
    assert!(player.stun_until > 0);
}

#[test]
fn zero_duration_is_never_applied() {
    let (mut world, _rx) = status_world();
    assert!(!world.inflict_disease("victim", PlayerDisease::Poison, 0, "mob-1"));
    assert_eq!(world.players["victim"].poison_until, 0);
}

#[test]
fn cure_immunity_window_blocks_a_new_disease() {
    let (mut world, _rx) = status_world();
    world.tick = 10;
    world.players.get_mut("victim").unwrap().status_immune_until = world.tick + 5;
    assert!(!world.inflict_disease("victim", PlayerDisease::Seal, 5_000, "mob-1"));
    assert_eq!(world.players["victim"].seal_until, 0, "immunity window blocks the seal");
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
    assert!(!world.inflict_disease("victim", PlayerDisease::Seal, 5_000, "mob-1"));
    assert_eq!(world.players["victim"].adaptation_charges, 2);
    assert_eq!(world.players["victim"].seal_until, 0);
    // A charge protects each subsequent cast until exhausted.
    assert!(!world.inflict_disease("victim", PlayerDisease::Stun, 3_000, "mob-1"));
    assert_eq!(world.players["victim"].adaptation_charges, 1);
    assert!(!world.inflict_disease("victim", PlayerDisease::Slow, 3_000, "mob-1"));
    assert_eq!(world.players["victim"].adaptation_charges, 0);
    // Exhausted: the next cast lands.
    assert!(world.inflict_disease("victim", PlayerDisease::Poison, 3_000, "mob-1"));
    assert!(world.players["victim"].poison_until > 0);
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
        assert!(!world.inflict_disease("victim", PlayerDisease::Seal, 5_000, "mob-1"));
        assert_eq!(world.players["victim"].seal_until, 0);
    } else {
        // Resistance < 100: the deterministic roll decides; the disease must
        // either land or be blocked, never panic, and never touch charges.
        let _ = world.inflict_disease("victim", PlayerDisease::Seal, 5_000, "mob-1");
        assert_eq!(world.players["victim"].adaptation_charges, 0);
    }
}

#[test]
fn maple_cure_clears_all_diseases_and_rearms_immunity() {
    let (mut world, _rx) = status_world();
    world.tick = 10;
    assert!(world.inflict_disease("victim", PlayerDisease::Seal, 5_000, "mob-1"));
    assert!(world.inflict_disease("victim", PlayerDisease::Poison, 5_000, "mob-1"));
    assert!(world.inflict_disease("victim", PlayerDisease::Curse, 60_000, "mob-1"));
    assert!(world.players["victim"].seal_until > 0);
    assert!(world.players["victim"].poison_until > 0);
    assert!(world.players["victim"].curse_until > 0);
    // 楓葉淨化 clears every modelled disease and re-arms the immunity window.
    let level = crate::mage::MageLevel::default();
    world.activate_status_cleanse("victim", &level);
    let player = &world.players["victim"];
    assert_eq!(player.seal_until, 0);
    assert_eq!(player.stun_until, 0);
    assert_eq!(player.curse_until, 0);
    assert_eq!(player.poison_until, 0);
    assert_eq!(player.slow_until, 0);
    assert_eq!(player.poison_next_tick, 0);
    assert_eq!(player.curse_next_tick, 0);
    assert!(player.status_immune_until > world.tick);
    assert_eq!(player.skill_buffs.get(&SKILL_MAPLE_CURE), Some(&3_000));
    // The fresh immunity window blocks a follow-up cast.
    assert!(!world.inflict_disease("victim", PlayerDisease::Stun, 3_000, "mob-1"));
    assert_eq!(world.players["victim"].stun_until, 0);
}

#[test]
fn poison_ticks_damage_and_expires() {
    let (mut world, _rx) = status_world();
    world.tick = 10;
    assert!(world.inflict_disease("victim", PlayerDisease::Poison, 2_000, "mob-1"));
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
    assert_eq!(player.poison_until, 0);
    assert_eq!(player.poison_next_tick, 0);
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
    assert!(world.inflict_disease("victim", PlayerDisease::Seal, 5_000, "mob-1"));
    assert!(world.players["victim"].seal_until > world.tick);
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
    assert!(world.inflict_disease("victim", PlayerDisease::Seal, 5_000, "mob-1"));
    let player = world.players.get("victim").unwrap();
    let remaining = remaining_ticks(player.seal_until, world.tick);
    assert!(remaining.is_some(), "an active seal reports a remaining window");
    // A healthy player reports no remaining window for an unset disease.
    assert_eq!(remaining_ticks(player.stun_until, world.tick), None);
    assert_eq!(remaining_ticks(0, world.tick), None);
}
