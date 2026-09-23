use super::*;
include!("windbell_acceptance.rs");
include!("colossus_acceptance.rs");
include!("death_world_acceptance.rs");
// 通讯职责已搬到 `messaging`（超大文件治理 P2）：其策略常量是 `pub(super)`，
// 在这里显式 glob 进来，使既有 `*_acceptance.rs` 里的裸名引用继续成立。
use super::elemental::*;
use super::messaging::*;
use super::monsters::*;
use super::skills::*;

fn map() -> Map {
    serde_json::from_str(
            r#"{"id":"test","bounds":{"xMin":0,"xMax":500,"yMin":-500,"yMax":500},"spawn":{"x":10,"y":0},"footholds":[{"id":1,"x1":0,"y1":100,"x2":200,"y2":100,"prev":0,"next":2},{"id":2,"x1":200,"y1":100,"x2":500,"y2":200,"prev":1,"next":0}],"ladders":[]}"#,
        )
        .unwrap()
}

fn life_map(id: &str) -> Map {
    Map {
        id: id.to_owned(),
        bounds: Bounds {
            x_min: 0.0,
            x_max: 300.0,
            y_min: -100.0,
            y_max: 300.0,
        },
        spawn: Point { x: 10.0, y: 100.0 },
        footholds: vec![Foothold {
            id: 1,
            x1: 0.0,
            y1: 100.0,
            x2: 300.0,
            y2: 100.0,
            prev: 0,
            next: 0,
            forbid_fall_down: 0,
        }],
        ladders: Vec::new(),
        portals: Vec::new(),
        water: Vec::new(),
        reactors: Vec::new(),
    }
}

fn life_template() -> MonsterTemplate {
    MonsterTemplate {
        template_id: "100100".into(),
        level: 1,
        max_hp: 8,
        max_mp: 0,
        boss: false,
        pa_damage: Some(3),
        pd_damage: Some(0),
        pd_rate: None,
        md_rate: None,
        exp: 1,
        body_attack: false,
        move_speed: None,
        source_speed: None,
        hitbox_width: Some(20.0),
        hitbox_height: Some(20.0),
        hitbox_lt: None,
        hitbox_rb: None,
        die_duration_ms: Some(50),
        stand_delay_ms: None,
        move_duration_ms: None,
        drop: None,
        skills: Vec::new(),
        body_disease: None,
        body_disease_level: None,
        pushed: None,
    }
}

fn life_spawn(id: &str, map_id: &str, x: f64, facing: i8, mob_time: i64) -> MonsterSpawn {
    MonsterSpawn {
        id: id.into(),
        template_id: "100100".into(),
        x,
        y: 80.0,
        foothold_id: Some(1),
        map_id: map_id.into(),
        facing,
        mob_time,
        rx0: None,
        rx1: None,
    }
}

fn life_gameplay(spawns: Vec<MonsterSpawn>) -> Gameplay {
    Gameplay {
        monsters: vec![life_template()],
        spawns,
        monster_respawn_ms: Some(500),
        ..Gameplay::default()
    }
}

fn join_test_player(world: &mut World, id: &str) -> mpsc::Receiver<String> {
    let (output, rx) = mpsc::channel(128);
    let (reply, _) = oneshot::channel();
    world.command(Command::Join {
        identity: Identity {
            id: id.to_owned(),
            username: id.to_owned(),
        },
        connection: format!("{id}-connection"),
        output,
        reply,
        lang: "zh".to_owned(),
    });
    rx
}

/// 属性聚合后的协议快照，供只关心**非属性字段**的用例使用：空装备、默认能力值、
/// 无任何增益，只有 `job` / `level` / `skills` 三个输入有差别。
fn derived_for(job: u32, level: u32, skills: &BTreeMap<u32, u32>) -> DerivedStats {
    let gameplay = Gameplay::default();
    let mage_skills = MageSkills::default();
    let ability = AbilityStats::default();
    let equipped: Vec<crate::protocol::InventoryItem> = Vec::new();
    let attributes = aggregate_attributes(AttributeInput {
        gameplay: &gameplay,
        mage_skills: &mage_skills,
        job,
        character_level: level,
        base_max_mp: 5,
        skills,
        ability_stats: &ability,
        equipped: &equipped,
        meditation_mad: 0,
        beginner_speed_percent: 0,
    });
    compute_derived_stats(
        &mage_skills,
        &attributes,
        skills,
        job,
        &DerivedRuntime::joining(0, &BTreeMap::new()),
    )
}

#[test]
fn natural_recovery_passives_follow_job_without_skill_stacking() {
    let empty = BTreeMap::new();
    let beginner = derived_for(BEGINNER_JOB, 1, &empty);
    assert_eq!(
        beginner.regeneration_passives,
        vec![RegenerationPassive {
            id: "beginner-recovery",
            book_id: 0,
            hp_per_second: 1,
            mp_per_second: 1,
        }]
    );
    let forged_skills = BTreeMap::from([(SKILL_RECOVERY, 30), (1000003, 30), (1000009, 30)]);
    let magician = derived_for(ICE_MAGE_JOB, 30, &forged_skills);
    assert_eq!(
        magician.regeneration_passives,
        vec![
            RegenerationPassive {
                id: "beginner-recovery",
                book_id: 0,
                hp_per_second: 1,
                mp_per_second: 1,
            },
            RegenerationPassive {
                id: "magician-recovery",
                book_id: 200,
                hp_per_second: 0,
                mp_per_second: 1,
            },
        ]
    );
    let warrior = derived_for(100, 30, &forged_skills);
    assert_eq!(
        warrior.regeneration_passives,
        vec![
            RegenerationPassive {
                id: "beginner-recovery",
                book_id: 0,
                hp_per_second: 1,
                mp_per_second: 1,
            },
            RegenerationPassive {
                id: "warrior-recovery",
                book_id: 100,
                hp_per_second: 2,
                mp_per_second: 0,
            },
        ]
    );
    for job in [112, 132] {
        assert_eq!(
            regeneration_passives_for_job(job),
            warrior.regeneration_passives
        );
    }
    for job in [222, 232] {
        assert_eq!(
            regeneration_passives_for_job(job),
            magician.regeneration_passives
        );
    }
    assert_eq!(
        regeneration_passives_for_job(300),
        beginner.regeneration_passives
    );
}

#[test]
fn natural_recovery_waits_a_second_caps_and_resets_after_death() {
    let gameplay = Gameplay {
        player: PlayerConfig {
            max_hp: Some(3),
            max_mp: Some(4),
            ..PlayerConfig::default()
        },
        ..Gameplay::default()
    };
    let mut world = World::new_with_gameplay(life_map("test"), 600, gameplay);
    let mut rx = join_test_player(&mut world, "natural");
    while rx.try_recv().is_ok() {}
    {
        let player = world.players.get_mut("natural").unwrap();
        player.state.hp = 1;
        player.state.mp = 1;
    }
    for _ in 0..19 {
        world.step();
    }
    assert_eq!(
        (
            world.players["natural"].state.hp,
            world.players["natural"].state.mp
        ),
        (1, 1)
    );
    world.step();
    assert_eq!(
        (
            world.players["natural"].state.hp,
            world.players["natural"].state.mp
        ),
        (2, 2)
    );
    for _ in 0..40 {
        world.step();
    }
    assert_eq!(
        (
            world.players["natural"].state.hp,
            world.players["natural"].state.mp
        ),
        (3, 4)
    );
    let full_tick = world.tick;
    world.players.get_mut("natural").unwrap().state.hp = 1;
    for _ in 0..19 {
        world.step();
    }
    assert_eq!(world.players["natural"].state.hp, 1);
    world.step();
    assert_eq!(world.players["natural"].state.hp, 2);
    assert!(world.tick > full_tick);
    {
        let player = world.players.get_mut("natural").unwrap();
        player.state.hp = 0;
        player.state.action = "dead";
    }
    for _ in 0..40 {
        world.step();
    }
    assert_eq!(world.players["natural"].state.hp, 0);
    assert_eq!(world.players["natural"].state.action, "dead");
    world.players.get_mut("natural").unwrap().death_id = "natural-death".into();
    world.complete_revive("natural", "natural-death");
    assert_eq!(world.players["natural"].state.action, "stand");
    world.players.get_mut("natural").unwrap().state.hp = 1;
    for _ in 0..19 {
        world.step();
    }
    assert_eq!(world.players["natural"].state.hp, 1);
    world.step();
    assert_eq!(world.players["natural"].state.hp, 2);
}

#[test]
fn natural_recovery_does_not_restore_offline_time_or_update_on_failed_save() {
    let path = std::env::temp_dir().join(format!(
        "maple-natural-recovery-{}.sqlite3",
        auth::random_id()
    ));
    let service = auth::start(&path).unwrap();
    let store = service.store.clone();
    let gameplay = Gameplay {
        player: PlayerConfig {
            max_hp: Some(3),
            max_mp: Some(4),
            ..PlayerConfig::default()
        },
        ..Gameplay::default()
    };
    let mut world = World::new_with_store(life_map("test"), 600, gameplay, store.clone()).unwrap();
    let mut rx = join_test_player(&mut world, "natural-store");
    while rx.try_recv().is_ok() {}
    {
        let player = world.players.get_mut("natural-store").unwrap();
        player.state.hp = 1;
        player.state.mp = 1;
        store
            .save_profile(
                "natural-store",
                &profile_from_state(
                    &player.state,
                    &player.map_id,
                    &player.death_id,
                    player.base_max_mp,
                ),
            )
            .unwrap();
    }
    world.tick = 200;
    let mut reconnect_rx = join_test_player(&mut world, "natural-store");
    while reconnect_rx.try_recv().is_ok() {}
    assert_eq!(
        (
            world.players["natural-store"].state.hp,
            world.players["natural-store"].state.mp
        ),
        (1, 1)
    );
    assert_eq!(
        world.players["natural-store"].natural_recovery_next_tick,
        world.tick + NATURAL_RECOVERY_INTERVAL_TICKS
    );
    world.tick = world.players["natural-store"].natural_recovery_next_tick;
    world.step_natural_recovery("natural-store");
    assert_eq!(
        (
            world.players["natural-store"].state.hp,
            world.players["natural-store"].state.mp
        ),
        (2, 2)
    );
    let saved = store
        .load_profile("natural-store", &world.default_profile())
        .unwrap();
    assert_eq!((saved.hp, saved.mp), (2, 2));
    {
        let player = world.players.get_mut("natural-store").unwrap();
        player.state.hp = 1;
        player.state.mp = 1;
    }
    world.tick = world.players["natural-store"].natural_recovery_next_tick;
    store
        .with_db(|db| {
            db.execute("DROP TABLE player_stats", [])
                .map(|_| ())
                .map_err(|_| "drop player_stats failed".to_owned())
        })
        .unwrap();
    world.step_natural_recovery("natural-store");
    assert_eq!(
        (
            world.players["natural-store"].state.hp,
            world.players["natural-store"].state.mp
        ),
        (1, 1)
    );
    let retry_tick = world.players["natural-store"].natural_recovery_next_tick;
    assert_eq!(retry_tick, world.tick + NATURAL_RECOVERY_INTERVAL_TICKS);
    world.tick += 1;
    world.step_natural_recovery("natural-store");
    assert_eq!(
        (
            world.players["natural-store"].state.hp,
            world.players["natural-store"].state.mp
        ),
        (1, 1)
    );
    drop(world);
    drop(service);
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
}

fn beginner_skills_fixture() -> MageSkills {
    serde_json::from_str(
            r#"{"sourceVersion":"TMS273.7","bookId":200,"skills":{
                "1000":{"name":"嫩寶丟擲術","maxLevel":3,"bookId":0,"levels":[{"mpCon":3,"fixdamage":10},{"mpCon":5,"fixdamage":25},{"mpCon":7,"fixdamage":40}]},
                "1001":{"name":"治癒","maxLevel":3,"bookId":0,"levels":[{"mpCon":5,"time":30,"x":4,"cooltime":120},{"mpCon":10,"time":30,"x":8,"cooltime":120},{"mpCon":15,"time":30,"x":12,"cooltime":120}]},
                "1002":{"name":"疾風之步","maxLevel":3,"bookId":0,"levels":[{"mpCon":4,"time":4,"speed":10,"cooltime":60},{"mpCon":7,"time":8,"speed":15,"cooltime":60},{"mpCon":10,"time":12,"speed":20,"cooltime":60}]
            }}}"#,
        )
        .unwrap()
}

#[test]
fn beginner_skill_runtime_locks_fixed_damage_and_timed_buffs() {
    let mut gameplay = life_gameplay(vec![life_spawn("beginner-mob", "test", 300.0, 1, -1)]);
    gameplay.player.max_hp = Some(35);
    gameplay.player.max_mp = Some(50);
    gameplay.player.attack_reach = Some(88.0);
    gameplay.monsters[0].max_hp = 50;
    let mut world = World::new_with_gameplay(life_map("test"), 600, gameplay)
        .with_mage_skills(beginner_skills_fixture());
    let (output, mut rx) = mpsc::channel(4096);
    let (reply, _) = oneshot::channel();
    world.command(Command::Join {
        identity: Identity {
            id: "beginner-runtime".into(),
            username: "beginner-runtime".into(),
        },
        connection: "beginner-runtime-connection".into(),
        output,
        reply,
        lang: "zh".into(),
    });
    while rx.try_recv().is_ok() {}
    {
        let player = world.players.get_mut("beginner-runtime").unwrap();
        player.state.x = 10.0;
        player.state.y = 100.0;
        player.state.grounded = true;
        player.state.action = "stand";
        player.state.skills = BTreeMap::from([
            (SKILL_THREE_SNAILS, 1),
            (SKILL_RECOVERY, 1),
            (SKILL_NIMBLE_FEET, 1),
        ]);
        player.state.mp = 50;
        player.state.hp = 12;
        player.foothold_id = 1;
        player.last_foothold_id = 1;
        refresh_player_derived(&world.gameplay, &world.mage_skills, player);
    }
    let monster_id = world.monsters.keys().next().cloned().unwrap();
    let drain = |rx: &mut mpsc::Receiver<String>| {
        let mut values = Vec::new();
        while let Ok(message) = rx.try_recv() {
            values.push(serde_json::from_str::<serde_json::Value>(&message).unwrap());
        }
        values
    };

    world.handle_cast_skill(
        "beginner-runtime".into(),
        "snails-1".into(),
        SKILL_THREE_SNAILS,
        Some(1),
        Some(0),
    );
    let first_cast = drain(&mut rx);
    let cast_event = first_cast
        .iter()
        .find(|value| value["type"] == "skillCast")
        .expect("beginner skillCast");
    assert_eq!(cast_event["skillId"], SKILL_THREE_SNAILS);
    assert_eq!(cast_event["skillLevel"], 1);
    assert_eq!(cast_event["targetId"], monster_id);
    let damage_event = first_cast
        .iter()
        .find(|value| value["type"] == "damageEvent")
        .expect("beginner damageEvent");
    assert_eq!(damage_event["damage"], 10);
    assert_eq!(damage_event["skillLevel"], 1);
    assert_eq!(world.monsters[&monster_id].state.hp, 40);
    assert_eq!(world.players["beginner-runtime"].state.mp, 47);
    assert!(world.players["beginner-runtime"].attack_until > world.tick);

    // The cast animation lock is authoritative, while the same request is
    // a replay and returns without spending MP or applying damage again.
    world.handle_cast_skill(
        "beginner-runtime".into(),
        "snails-2".into(),
        SKILL_THREE_SNAILS,
        Some(1),
        Some(0),
    );
    let busy = drain(&mut rx);
    assert!(busy
        .iter()
        .any(|value| { value["type"] == "rejected" && value["code"] == "skill_busy" }));
    assert_eq!(world.players["beginner-runtime"].state.mp, 47);
    world.handle_cast_skill(
        "beginner-runtime".into(),
        "snails-1".into(),
        SKILL_THREE_SNAILS,
        Some(1),
        Some(0),
    );
    let replay = drain(&mut rx);
    assert_eq!(replay.len(), 1);
    assert_eq!(replay[0]["type"], "skillResult");
    assert_eq!(world.monsters[&monster_id].state.hp, 40);
    assert_eq!(world.players["beginner-runtime"].state.mp, 47);

    world.handle_cast_skill(
        "beginner-runtime".into(),
        "recovery-1".into(),
        SKILL_RECOVERY,
        Some(0),
        Some(0),
    );
    let recovery = drain(&mut rx);
    assert!(recovery
        .iter()
        .any(|value| { value["type"] == "skillResult" && value["success"] == true }));
    assert_eq!(world.players["beginner-runtime"].state.mp, 42);
    assert_eq!(
        world.players["beginner-runtime"]
            .state
            .derived_stats
            .skill_buffs
            .as_ref()
            .and_then(|buffs| buffs.get(&SKILL_RECOVERY)),
        Some(&30_000)
    );
    assert_eq!(
        world.players["beginner-runtime"]
            .state
            .derived_stats
            .skill_cooldowns
            .as_ref()
            .and_then(|cooldowns| cooldowns.get(&SKILL_RECOVERY)),
        Some(&120_000)
    );
    world.handle_cast_skill(
        "beginner-runtime".into(),
        "recovery-2".into(),
        SKILL_RECOVERY,
        Some(0),
        Some(0),
    );
    let cooldown = drain(&mut rx);
    assert!(cooldown
        .iter()
        .any(|value| { value["type"] == "rejected" && value["code"] == "skill_cooldown" }));
    assert_eq!(world.players["beginner-runtime"].state.mp, 42);
    assert_eq!(world.tick, 0);
    assert_eq!(world.players["beginner-runtime"].state.max_hp, 35);
    assert_eq!(
        world.players["beginner-runtime"].beginner_heal_next_tick,
        100
    );
    assert_eq!(
        world.players["beginner-runtime"].beginner_heal_remaining_ticks,
        6
    );
    assert_eq!(world.players["beginner-runtime"].beginner_heal_per_tick, 4);
    for _ in 0..99 {
        world.step();
    }
    assert_eq!(world.tick, 99);
    assert_eq!(
        world.players["beginner-runtime"].beginner_heal_next_tick,
        100
    );
    assert_eq!(
        world.players["beginner-runtime"].beginner_heal_remaining_ticks,
        6
    );
    assert!(world.players["beginner-runtime"]
        .status
        .buff_active(SKILL_RECOVERY));
    assert_eq!(world.players["beginner-runtime"].state.hp, 16);
    world.step();
    // Tick 100 applies the active 4 HP heal and the permanent +1 HP/s
    // beginner passive after four earlier natural intervals.
    assert_eq!(world.players["beginner-runtime"].state.hp, 21);
    for _ in 0..500 {
        world.step();
    }
    assert_eq!(world.players["beginner-runtime"].state.hp, 35);
    assert!(world.players["beginner-runtime"]
        .state
        .derived_stats
        .skill_buffs
        .is_none());
    assert_eq!(
        world.players["beginner-runtime"]
            .skill_cooldowns
            .get(&SKILL_RECOVERY),
        Some(&90_000)
    );
    assert_eq!(
        world.players["beginner-runtime"]
            .state
            .derived_stats
            .skill_cooldowns
            .as_ref()
            .and_then(|cooldowns| cooldowns.get(&SKILL_RECOVERY)),
        Some(&90_000)
    );

    world.handle_cast_skill(
        "beginner-runtime".into(),
        "nimble-1".into(),
        SKILL_NIMBLE_FEET,
        Some(1),
        Some(0),
    );
    let nimble = drain(&mut rx);
    assert!(nimble
        .iter()
        .any(|value| { value["type"] == "skillResult" && value["success"] == true }));
    // Natural MP recovery reaches the 50 MP cap during the long buff
    // window, so Nimble Feet's 4 MP cost leaves 46.
    assert_eq!(world.players["beginner-runtime"].state.mp, 46);
    assert_eq!(
        world.players["beginner-runtime"]
            .state
            .derived_stats
            .move_speed,
        137.5
    );
    world.players.get_mut("beginner-runtime").unwrap().state.hp = 1;
    world.players.get_mut("beginner-runtime").unwrap().state.x = 300.0;
    world
        .monsters
        .get_mut(&monster_id)
        .unwrap()
        .template
        .body_attack = true;
    world
        .monsters
        .get_mut(&monster_id)
        .unwrap()
        .template
        .pa_damage = Some(2);
    world.apply_contact_damage();
    assert_eq!(world.players["beginner-runtime"].state.hp, 0);
    assert!(world.players["beginner-runtime"]
        .status
        .buff_map()
        .is_empty());
    assert_eq!(world.players["beginner-runtime"].beginner_speed_percent, 0);
    assert!(world.players["beginner-runtime"]
        .state
        .derived_stats
        .skill_buffs
        .is_none());
}

#[test]
fn authority_movement_dedup_and_disconnect() {
    let mut w = World::new(map(), 600);
    let (output, mut rx) = mpsc::channel(128);
    let (reply, _) = oneshot::channel();
    w.command(Command::Join {
        identity: Identity {
            id: "a".into(),
            username: "alice".into(),
        },
        connection: "c".into(),
        output,
        reply,
        lang: "zh".to_owned(),
    });
    for _ in 0..20 {
        w.step();
    }
    assert!(w.players["a"].state.grounded);
    assert_eq!(w.players["a"].state.y, 100.);
    w.command(Command::Input {
        id: "a".into(),
        connection: "forged".into(),
        message: ClientMessage::Input {
            seq: 1,
            direction: 1,
            vertical: 0,
            jump: false,
        },
    });
    assert_eq!(w.players["a"].direction, 0);
    w.command(Command::Input {
        id: "a".into(),
        connection: "c".into(),
        message: ClientMessage::Input {
            seq: 1,
            direction: 1,
            vertical: 0,
            jump: true,
        },
    });
    w.step();
    assert!(w.players["a"].state.y < 100.);
    for _ in 0..35 {
        w.step();
    }
    assert!(w.players["a"].state.grounded);
    assert!(w.players["a"].state.y > 100.);
    for _ in 0..2 {
        w.command(Command::Input {
            id: "a".into(),
            connection: "c".into(),
            message: ClientMessage::Attack {
                request_id: "once".into(),
            },
        });
    }
    assert_eq!(w.combat.next_action, 1);
    while rx.try_recv().is_ok() {}
    w.command(Command::Leave {
        id: "a".into(),
        connection: "c".into(),
    });
    assert!(w.players.is_empty());
    assert!(serde_json::from_str::<ClientMessage>(
        r#"{"type":"input","seq":1,"direction":1,"vertical":0,"jump":false,"playerId":"other"}"#,
    )
    .is_err());
    assert!(serde_json::from_str::<ClientMessage>(
        r#"{"type":"attack","requestId":"a","damage":999}"#,
    )
    .is_err());
}

#[test]
fn pickup_protection_expires_and_inventory_drops_are_public() {
    let mut world = World::new(map(), 600);
    let (output, mut rx) = mpsc::channel(128);
    let (reply, _) = oneshot::channel();
    world.command(Command::Join {
        identity: Identity {
            id: "a".into(),
            username: "alice".into(),
        },
        connection: "c".into(),
        output,
        reply,
        lang: "zh".to_owned(),
    });
    let x = world.players["a"].state.x;
    let y = world.players["a"].state.y;
    world.drops.insert(
        "monster".into(),
        DropState {
            id: "monster".into(),
            item_id: "0".into(),
            quantity: 5,
            x,
            y,
        },
    );
    world.drop_owners.insert(
        "monster".into(),
        (Some("b".into()), auth::now_ms() + auth::DROP_PROTECTION_MS),
    );
    world.drop_maps.insert("monster".into(), "test".into());
    world.handle_pickup("a".into(), "protected".into(), "monster".into());
    assert!(world.drops.contains_key("monster"));
    let mut messages = Vec::new();
    while let Ok(message) = rx.try_recv() {
        messages.push(message);
    }
    assert!(messages
        .iter()
        .any(|message| message.contains("drop_owned") && message.contains("该物品暂时不可拾取")));
    let mesos = world.players["a"].state.mesos;
    world.drop_owners.get_mut("monster").unwrap().1 = auth::now_ms();
    world.handle_pickup("a".into(), "expired".into(), "monster".into());
    assert!(!world.drops.contains_key("monster"));
    assert_eq!(world.players["a"].state.mesos, mesos + 5);

    world.players.get_mut("a").unwrap().state.inventory = vec![crate::protocol::InventoryItem {
        slot: 1,
        item_id: "4000019".into(),
        quantity: 1,
        ..crate::protocol::InventoryItem::default()
    }];
    world.handle_inventory_drop("a".into(), "discard".into(), 4, 1, 1);
    let drop_id = world.drops.keys().next().unwrap().clone();
    assert_eq!(world.drop_owners[&drop_id], (None, 0));
    let (output, _other_rx) = mpsc::channel(128);
    let (reply, _) = oneshot::channel();
    world.command(Command::Join {
        identity: Identity {
            id: "b".into(),
            username: "bob".into(),
        },
        connection: "d".into(),
        output,
        reply,
        lang: "zh".to_owned(),
    });
    world.handle_pickup("b".into(), "public".into(), drop_id.clone());
    assert!(!world.drops.contains_key(&drop_id));
    assert!(world.players["b"]
        .state
        .inventory
        .iter()
        .any(|item| item.item_id == "4000019" && item.quantity == 1));
}

#[test]
fn memory_pickup_cards_saturate_and_scroll_preserves_instance_state() {
    let mut world = World::new(map(), 600);
    let (output, mut rx) = mpsc::channel(128);
    let (reply, _) = oneshot::channel();
    world.command(Command::Join {
        identity: Identity {
            id: "a".into(),
            username: "alice".into(),
        },
        connection: "c".into(),
        output,
        reply,
        lang: "zh".to_owned(),
    });
    while rx.try_recv().is_ok() {}
    let x = world.players["a"].state.x;
    let y = world.players["a"].state.y;

    world.drops.insert(
        "card-five".into(),
        DropState {
            id: "card-five".into(),
            item_id: "2380000".into(),
            quantity: 5,
            x,
            y,
        },
    );
    world.drop_owners.insert("card-five".into(), (None, 0));
    world.drop_maps.insert("card-five".into(), "test".into());
    world.handle_pickup("a".into(), "card-five-pickup".into(), "card-five".into());
    assert!(!world.drops.contains_key("card-five"));
    assert_eq!(
        world.players["a"].state.monster_book.get("2380000"),
        Some(&5)
    );
    assert!(world.players["a"]
        .state
        .inventory
        .iter()
        .all(|item| item.item_id != "2380000"));

    // A sixth card is consumed and removed even though the book count is
    // already capped.
    world.drops.insert(
        "card-six".into(),
        DropState {
            id: "card-six".into(),
            item_id: "2380000".into(),
            quantity: 1,
            x,
            y,
        },
    );
    world.drop_owners.insert("card-six".into(), (None, 0));
    world.drop_maps.insert("card-six".into(), "test".into());
    world.handle_pickup("a".into(), "card-six-pickup".into(), "card-six".into());
    assert!(!world.drops.contains_key("card-six"));
    assert_eq!(
        world.players["a"].state.monster_book.get("2380000"),
        Some(&5)
    );

    let mut helmet = crate::protocol::InventoryItem {
        slot: 9,
        item_id: "1102173".into(),
        quantity: 1,
        ..crate::protocol::InventoryItem::default()
    };
    inventory::ensure_equipment_instance(&mut helmet);
    world.players.get_mut("a").unwrap().state.inventory = vec![crate::protocol::InventoryItem {
        slot: 1,
        item_id: "2041006".into(),
        quantity: 2,
        ..crate::protocol::InventoryItem::default()
    }];
    world.players.get_mut("a").unwrap().state.equipped = vec![helmet];

    world.handle_use_item(
        "a".into(),
        "memory-scroll-wrong-target".into(),
        2,
        1,
        "2041006".into(),
        Some(-9),
        Some("1040002".into()),
    );
    assert_eq!(world.players["a"].state.inventory[0].quantity, 2);
    assert_eq!(
        world.players["a"].state.equipped[0].remaining_slots,
        Some(6)
    );

    world.handle_use_item(
        "a".into(),
        "memory-scroll-valid".into(),
        2,
        1,
        "2041006".into(),
        Some(-9),
        Some("1102173".into()),
    );
    assert_eq!(world.players["a"].state.inventory[0].quantity, 1);
    let helmet = &world.players["a"].state.equipped[0];
    assert_eq!(helmet.remaining_slots, Some(5));
    assert_eq!(
        helmet.stats.as_ref().and_then(|stats| stats.get("incMHP")),
        Some(&20)
    );

    let strengthened = crate::protocol::InventoryItem {
        slot: 1,
        item_id: "1002067".into(),
        quantity: 1,
        stats: Some(BTreeMap::from([(String::from("incPDD"), 12)])),
        remaining_slots: Some(6),
        upgrade_count: Some(1),
    };
    world.players.get_mut("a").unwrap().state.inventory = vec![strengthened];
    world.handle_inventory_drop("a".into(), "memory-drop-equip".into(), 1, 1, 1);
    let drop_id = world
        .inventory_requests
        .get(&(String::from("a"), String::from("memory-drop-equip")))
        .and_then(|outcome| outcome.drop_id.clone())
        .expect("equipment drop id");
    world.handle_pickup("a".into(), "memory-pickup-equip".into(), drop_id);
    let picked = world.players["a"]
        .state
        .inventory
        .iter()
        .find(|item| item.item_id == "1002067")
        .expect("strengthened equipment returned to inventory");
    assert_eq!(
        picked.stats,
        Some(BTreeMap::from([(String::from("incPDD"), 12)]))
    );
    assert_eq!(picked.remaining_slots, Some(6));
    assert_eq!(picked.upgrade_count, Some(1));
}

#[test]
fn store_pickup_refreshes_equipment_metadata_and_monster_book_in_world_state() {
    let path = std::env::temp_dir().join(format!(
        "maple-world-store-pickup-{}.sqlite3",
        auth::random_id()
    ));
    let service = auth::start(&path).unwrap();
    let store = service.store.clone();
    let defaults = Profile {
        hp: 50,
        max_hp: 50,
        mp: 5,
        max_mp: 5,
        level: 5,
        job: 0,
        exp: 0,
        exp_to_next: 15,
        mesos: 0,
        cash: 0,
        death_id: String::new(),
        map_id: String::new(),
        x: 0.0,
        y: 0.0,
        inventory: Vec::new(),
        skills: BTreeMap::new(),
        skill_points: BTreeMap::new(),
        ability_stats: AbilityStats::default(),
    };
    store.load_profile("a", &defaults).unwrap();
    let stats = BTreeMap::from([(String::from("incPDD"), 12_i64)]);
    store
        .claim_attack("a", "test", "world-reward", "world-action", "attack")
        .unwrap();
    store
        .resolve_attack(
            "a",
            "test",
            "world-reward",
            Some("world-monster"),
            1,
            true,
            0,
            1,
            &[
                auth::DropRecord {
                    id: "world-equipment".into(),
                    item_id: "1002067".into(),
                    quantity: 1,
                    x: 10.0,
                    y: 0.0,
                    stats: Some(stats.clone()),
                    remaining_slots: Some(6),
                    upgrade_count: Some(1),
                    ..auth::DropRecord::default()
                },
                auth::DropRecord {
                    id: "world-card".into(),
                    item_id: "2380000".into(),
                    quantity: 1,
                    x: 10.0,
                    y: 0.0,
                    ..auth::DropRecord::default()
                },
            ],
            &[],
            &["a".into()],
        )
        .unwrap();
    let mut world = World::new_with_store(map(), 600, Gameplay::default(), store).unwrap();
    let (output, mut rx) = mpsc::channel(128);
    let (reply, _) = oneshot::channel();
    world.command(Command::Join {
        identity: Identity {
            id: "a".into(),
            username: "alice".into(),
        },
        connection: "c".into(),
        output,
        reply,
        lang: "zh".to_owned(),
    });
    while rx.try_recv().is_ok() {}
    world.handle_pickup("a".into(), "world-card-pickup".into(), "world-card".into());
    assert_eq!(
        world.players["a"].state.monster_book.get("2380000"),
        Some(&1)
    );
    assert!(world.players["a"]
        .state
        .inventory
        .iter()
        .all(|item| item.item_id != "2380000"));

    world.handle_pickup(
        "a".into(),
        "world-equipment-pickup".into(),
        "world-equipment".into(),
    );
    let picked = world.players["a"]
        .state
        .inventory
        .iter()
        .find(|item| item.item_id == "1002067")
        .expect("store pickup is reflected in the world profile");
    assert_eq!(picked.stats, Some(stats));
    assert_eq!(picked.remaining_slots, Some(6));
    assert_eq!(picked.upgrade_count, Some(1));
    drop(service);
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
}

#[test]
fn pickup_store_windows_replay_prior_failure_and_side_effect_free_reject() {
    let path = std::env::temp_dir().join(format!(
        "maple-world-pickup-replay-{}.sqlite3",
        auth::random_id()
    ));
    let service = auth::start(&path).unwrap();
    let store = service.store.clone();
    let defaults = Profile {
        hp: 50,
        max_hp: 50,
        mp: 5,
        max_mp: 5,
        level: 5,
        job: 0,
        exp: 0,
        exp_to_next: 15,
        mesos: 0,
        cash: 0,
        death_id: String::new(),
        map_id: String::new(),
        x: 0.0,
        y: 0.0,
        inventory: Vec::new(),
        skills: BTreeMap::new(),
        skill_points: BTreeMap::new(),
        ability_stats: AbilityStats::default(),
    };
    store.load_profile("a", &defaults).unwrap();
    store
        .with_db(|db| {
            db.execute(
                "INSERT INTO drops(id,map_id,item_id,quantity,x,y,active) VALUES
                     ('replay-drop','test','4000019',10,0,0,1),
                     ('persist-fail-drop','test','4000019',7,0,0,1)",
                [],
            )
            .map_err(|_| "drop insert failed".to_owned())?;
            Ok(())
        })
        .unwrap();
    let mut world = World::new_with_store(map(), 600, Gameplay::default(), store.clone()).unwrap();
    let (output, mut rx) = mpsc::channel(128);
    let (reply, _) = oneshot::channel();
    world.command(Command::Join {
        identity: Identity {
            id: "a".into(),
            username: "alice".into(),
        },
        connection: "c".into(),
        output,
        reply,
        lang: "zh".to_owned(),
    });
    while rx.try_recv().is_ok() {}
    let player_x = world.players["a"].state.x;
    let player_y = world.players["a"].state.y;
    // 建号基线：创角初始装备（`load_profile` 发）与首次入场的初始背包券
    // （`seed_starter_backpack` 发）各留档一次、各推进一次 revision——是**两**次，
    // 不是一次。下面所有 revision 断言都相对这条基线，只量拾取路径的增量。
    let notebook_revision = |store: &auth::Store| {
        store
            .notebook_revision(crate::auth::notebook::SCOPE_CHARACTER, "a")
            .unwrap()
    };
    let baseline = notebook_revision(&store);
    assert_eq!(baseline, 2, "建号应留档两次：初始装备 + 初始背包券");
    for drop_id in ["replay-drop", "persist-fail-drop"] {
        world.drops.insert(
            drop_id.into(),
            DropState {
                id: drop_id.into(),
                item_id: "4000019".into(),
                quantity: 1,
                x: player_x,
                y: player_y,
            },
        );
        world.drop_maps.insert(drop_id.into(), "test".into());
    }

    // 成功窗口：世界移除 + 回填入包。
    world.handle_pickup("a".into(), "replay-req".into(), "replay-drop".into());
    assert!(!world.drops.contains_key("replay-drop"));
    assert_eq!(
        world.players["a"]
            .state
            .inventory
            .iter()
            .find(|item| item.item_id == "4000019")
            .map(|item| item.quantity),
        Some(10)
    );
    let mut messages = Vec::new();
    while let Ok(message) = rx.try_recv() {
        messages.push(message);
    }
    assert!(messages
        .iter()
        .any(|message| message.contains("pickupResult")));

    // NB-05：成功的拾取在图鉴里留一条 `pickup` 事实（与掉落认领、入包同事务）。
    // 过滤 `starter`：建号时的创角初始装备同样留档，但那是 `load_profile`
    // 发的，不是这条拾取路径（它自己的断言在 `notebook_store_acceptance`）。
    let grants = || {
        store
            .notebook_item_records("a")
            .unwrap()
            .into_iter()
            .filter(|row| row.source_kind != "starter")
            .map(|row| (row.item_id, row.source_kind, row.time_quality))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        grants(),
        vec![(
            "4000019".to_owned(),
            "pickup".to_owned(),
            "event".to_owned()
        )]
    );
    // 建号基线之上只多了拾取这一次。
    assert_eq!(
        notebook_revision(&store),
        baseline + 1,
        "拾取应恰好推进一次 revision"
    );
    // 重放窗口：同 requestId 再次提交回放原结果，不二次发奖、不再广播。
    world.handle_pickup("a".into(), "replay-req".into(), "replay-drop".into());
    assert_eq!(
        world.players["a"]
            .state
            .inventory
            .iter()
            .find(|item| item.item_id == "4000019")
            .map(|item| item.quantity),
        Some(10)
    );
    let mut messages = Vec::new();
    while let Ok(message) = rx.try_recv() {
        messages.push(message);
    }
    assert!(
        messages
            .iter()
            .any(|message| message.contains("pickupResult") && message.contains("replay-req")),
        "replayed pickup outcome expected: {messages:?}"
    );
    assert!(
        !messages
            .iter()
            .any(|message| message.contains("dropPickedUp")),
        "replay must not broadcast a second dropPickedUp: {messages:?}"
    );
    // NB-05：重放读回执、不再走事务，所以图鉴事实与 revision 都不动。
    assert_eq!(grants().len(), 1);
    assert_eq!(
        notebook_revision(&store),
        baseline + 1,
        "revision 停在拾取那一次"
    );

    // 失败窗口：prior_pickup 持久化故障 → persistence 拒绝且世界无副作用。
    store
        .with_db(|db| {
            db.execute("DROP TABLE pickup_actions", [])
                .map_err(|_| "drop table failed".to_owned())?;
            Ok(())
        })
        .unwrap();
    world.handle_pickup("a".into(), "broken-req".into(), "persist-fail-drop".into());
    assert!(
        world.drops.contains_key("persist-fail-drop"),
        "a persistence failure must not consume the world drop"
    );
    let mut messages = Vec::new();
    while let Ok(message) = rx.try_recv() {
        messages.push(message);
    }
    assert!(
        messages
            .iter()
            .any(|message| message.contains("persistence") && message.contains("broken-req")),
        "persistence reject expected: {messages:?}"
    );
    assert!(!messages
        .iter()
        .any(|message| message.contains("pickupResult")));
    // NB-05：失败的拾取整笔回滚——图鉴事实与 revision 都不能留下痕迹，
    // 否则会出现「掉落还在、图鉴却记了获得」。
    assert_eq!(grants().len(), 1);
    assert_eq!(
        notebook_revision(&store),
        baseline + 1,
        "revision 停在拾取那一次"
    );

    drop(service);
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
}

#[test]
fn pickup_backfill_failure_after_commit_keeps_persisted_truth() {
    let path = std::env::temp_dir().join(format!(
        "maple-world-pickup-backfill-{}.sqlite3",
        auth::random_id()
    ));
    let service = auth::start(&path).unwrap();
    let store = service.store.clone();
    let defaults = Profile {
        hp: 50,
        max_hp: 50,
        mp: 5,
        max_mp: 5,
        level: 5,
        job: 0,
        exp: 0,
        exp_to_next: 15,
        mesos: 0,
        cash: 0,
        death_id: String::new(),
        map_id: String::new(),
        x: 0.0,
        y: 0.0,
        inventory: Vec::new(),
        skills: BTreeMap::new(),
        skill_points: BTreeMap::new(),
        ability_stats: AbilityStats::default(),
    };
    store.load_profile("a", &defaults).unwrap();
    store
        .with_db(|db| {
            db.execute(
                "INSERT INTO drops(id,map_id,item_id,quantity,x,y,active)
                     VALUES ('backfill-drop','test','4000019',10,0,0,1)",
                [],
            )
            .map_err(|_| "drop insert failed".to_owned())?;
            Ok(())
        })
        .unwrap();
    let mut world = World::new_with_store(map(), 600, Gameplay::default(), store.clone()).unwrap();
    let (output, mut rx) = mpsc::channel(128);
    let (reply, _) = oneshot::channel();
    world.command(Command::Join {
        identity: Identity {
            id: "a".into(),
            username: "alice".into(),
        },
        connection: "c".into(),
        output,
        reply,
        lang: "zh".to_owned(),
    });
    while rx.try_recv().is_ok() {}
    world.drops.insert(
        "backfill-drop".into(),
        DropState {
            id: "backfill-drop".into(),
            item_id: "4000019".into(),
            quantity: 10,
            x: world.players["a"].state.x,
            y: world.players["a"].state.y,
        },
    );
    world
        .drop_maps
        .insert("backfill-drop".into(), "test".into());

    // 破坏回填读取路径：load_profile 解码 skills_json 必然失败，
    // 而 store.pickup 的事务不读该列，仍能成功提交。
    store
        .with_db(|db| {
            db.execute(
                "UPDATE player_stats SET skills_json='not-json' WHERE account_id='a'",
                [],
            )
            .map_err(|_| "corrupt skills_json failed".to_owned())?;
            Ok(())
        })
        .unwrap();
    world.handle_pickup("a".into(), "backfill-req".into(), "backfill-drop".into());

    // 客户端只收到 persistence 拒绝，没有 pickupResult。
    let mut messages = Vec::new();
    while let Ok(message) = rx.try_recv() {
        messages.push(message);
    }
    assert_eq!(messages.len(), 1, "{messages:?}");
    assert!(
        messages[0].contains("persistence") && messages[0].contains("backfill-req"),
        "{messages:?}"
    );
    // 世界与已提交事务一致：掉落已移除，但内存背包未回填。
    assert!(!world.drops.contains_key("backfill-drop"));
    assert!(world.players["a"]
        .state
        .inventory
        .iter()
        .all(|item| item.item_id != "4000019"));
    // 持久化真相：资产已提交，以持久化为准（重读/重连恢复）。
    let persisted: i64 = store
        .with_db(|db| {
            db.query_row(
                "SELECT quantity FROM inventory WHERE account_id='a' AND item_id='4000019'",
                [],
                |row| row.get(0),
            )
            .map_err(|_| "inventory query failed".to_owned())
        })
        .unwrap();
    assert_eq!(persisted, 10);
    // NB-05：图鉴事实与资产在同一笔**已提交**事务里，所以它也必须已经落地——
    // 内存回填失败不影响已提交事实（持久化为准，重连恢复）。
    assert_eq!(
        store
            .notebook_item_records("a")
            .unwrap()
            .iter()
            .filter(|row| row.source_kind != "starter")
            .map(|row| (row.item_id.as_str(), row.source_kind.as_str()))
            .collect::<Vec<_>>(),
        vec![("4000019", "pickup")]
    );

    drop(service);
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
}

/// NB-05 定向：宠物拾取与「自动消耗拾取物」在图鉴里的去留。
///
/// 两者都复用同一个拾取事务，规则不能被宠物动画或「卡片不进背包」这类结构
/// 细节改写：宠物拾取与本人拾取**完全同款**地留档；`consumeOnPickup` 的旧
/// MonsterBook 卡片由**分类**决定去留（不在出厂物品索引里 ⇒ 不留档），且不得
/// 变成现代收藏登记。
#[test]
fn store_pickup_archives_pet_loot_and_leaves_legacy_cards_to_the_classifier() {
    let path = std::env::temp_dir().join(format!(
        "maple-world-pickup-notebook-{}.sqlite3",
        auth::random_id()
    ));
    let service = auth::start(&path).unwrap();
    let store = service.store.clone();
    let defaults = Profile {
        hp: 50,
        max_hp: 50,
        mp: 5,
        max_mp: 5,
        level: 1,
        job: 0,
        exp: 0,
        exp_to_next: 15,
        mesos: 0,
        cash: 0,
        death_id: String::new(),
        map_id: String::new(),
        x: 0.0,
        y: 0.0,
        inventory: Vec::new(),
        skills: BTreeMap::new(),
        skill_points: BTreeMap::new(),
        ability_stats: AbilityStats::default(),
    };
    store.load_profile("a", &defaults).unwrap();
    store
        .with_db(|db| {
            db.execute(
                "INSERT INTO drops(id,map_id,item_id,quantity,x,y,active) VALUES
                     ('pet-drop','test','4000019',1,0,0,1),
                     ('card-drop','test','2380000',1,0,0,1)",
                [],
            )
            .map_err(|_| "drop insert failed".to_owned())?;
            Ok(())
        })
        .unwrap();
    let mut world = World::new_with_store(map(), 600, Gameplay::default(), store.clone()).unwrap();
    let (output, mut rx) = mpsc::channel(128);
    let (reply, _) = oneshot::channel();
    world.command(Command::Join {
        identity: Identity {
            id: "a".into(),
            username: "alice".into(),
        },
        connection: "c".into(),
        output,
        reply,
        lang: "zh".to_owned(),
    });
    while rx.try_recv().is_ok() {}
    let x = world.players["a"].state.x;
    let y = world.players["a"].state.y;
    // 建号基线（初始装备 + 初始背包券各一次），下面只看拾取路径的增量。
    let baseline = store
        .notebook_revision(crate::auth::notebook::SCOPE_CHARACTER, "a")
        .unwrap();
    assert_eq!(baseline, 2, "建号应留档两次：初始装备 + 初始背包券");
    for drop_id in ["pet-drop", "card-drop"] {
        world.drops.insert(
            drop_id.into(),
            DropState {
                id: drop_id.into(),
                item_id: if drop_id == "pet-drop" {
                    "4000019".into()
                } else {
                    "2380000".into()
                },
                quantity: 1,
                x,
                y,
            },
        );
        world.drop_maps.insert(drop_id.into(), "test".into());
    }

    // 宠物拾取（`handle_pet_pickup`）：与本人拾取同一条事务、同一种留档。
    world.handle_pet_pickup(
        "a".into(),
        "petpickup-pet-drop".into(),
        "pet-drop".into(),
        x,
        y,
    );
    assert!(!world.drops.contains_key("pet-drop"));
    assert_eq!(
        store
            .notebook_item_records("a")
            .unwrap()
            .iter()
            .filter(|row| row.source_kind != "starter")
            .map(|row| (row.item_id.as_str(), row.source_kind.as_str()))
            .collect::<Vec<_>>(),
        vec![("4000019", "pickup")],
        "宠物拾取必须与本人拾取同款留档"
    );

    // 自动消耗的旧 MonsterBook 卡片：进 `monster_book_cards`、不进背包，
    // 分类为「不是常规物品」⇒ 不留档，也不产生现代收藏条目。
    world.handle_pickup("a".into(), "card-pickup".into(), "card-drop".into());
    assert!(!world.drops.contains_key("card-drop"));
    assert_eq!(
        world.players["a"].state.monster_book.get("2380000"),
        Some(&1),
        "卡片照旧饱和入账，拾取本身必须成功"
    );
    assert_eq!(
        store
            .notebook_item_records("a")
            .unwrap()
            .iter()
            .filter(|row| row.source_kind != "starter")
            .map(|row| row.item_id.as_str())
            .collect::<Vec<_>>(),
        vec!["4000019"],
        "旧卡片不属于常规物品，不得混进物品图鉴"
    );
    assert!(
        store.notebook_collection_entries("a").unwrap().is_empty(),
        "拾取卡片不得变成现代收藏登记（§8.4）"
    );
    assert_eq!(
        store
            .notebook_revision(crate::auth::notebook::SCOPE_CHARACTER, "a")
            .unwrap(),
        baseline + 1,
        "卡片不留档 ⇒ 不推进 revision（宠物拾取那一次是唯一增量）"
    );

    drop(service);
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
}

#[test]
fn join_snapshot_includes_persisted_character_appearance() {
    let path = std::env::temp_dir().join(format!(
        "maple-world-appearance-{}.sqlite3",
        auth::random_id()
    ));
    let service = auth::start(&path).unwrap();
    let store = service.store.clone();
    store
        .with_db(|db| {
            db.execute(
                "INSERT INTO accounts(id,username,password_hash)
                     VALUES ('appearance-account','appearance-user','')",
                [],
            )
            .map_err(|_| "test account insert failed".to_owned())?;
            Ok(())
        })
        .unwrap();
    let appearance = crate::lobby::Appearance {
        gender: 0,
        face: 20_100,
        hair: 30_000,
        skin: 0,
        coat: 1_050_286,
        pants: 0,
        shoes: 1_072_833,
        weapon: 1_302_000,
    };
    let character = match crate::lobby::handle(
        &store,
        "appearance-account",
        crate::lobby::Action::Create {
            request_id: "appearance-test".into(),
            name: "Appearance".into(),
            appearance: appearance.clone(),
        },
    )
    .unwrap()
    {
        crate::lobby::Response::Created { character } => character,
        _ => panic!("unexpected character response"),
    };
    // NB-05：创角时穿上的外观装备是**真实授予**，与角色行、`equipped` 行同一
    // 事务留档。`pants: 0` 表示该槽为空，不产生事实。此刻还没有 `load_profile`，
    // 所以 `ensure_starter_equipment_tx` 的固定初始套装尚未发放——图鉴里只有
    // 这三件，且只推进一次 revision（同一笔提交）。
    assert_eq!(
        store
            .notebook_item_records(&character.id)
            .unwrap()
            .iter()
            .map(|row| (
                row.item_id.as_str(),
                row.source_kind.as_str(),
                row.time_quality.as_str()
            ))
            .collect::<Vec<_>>(),
        vec![
            ("1050286", "starter", "event"),
            ("1072833", "starter", "event"),
            ("1302000", "starter", "event"),
        ],
        "创角外观装备必须按 starter 留档（空槽位不产生事实）"
    );
    assert_eq!(
        store
            .notebook_revision(crate::auth::notebook::SCOPE_CHARACTER, &character.id)
            .unwrap(),
        1,
        "创角这一笔只推进一次 revision"
    );
    let mut world = World::new_with_store(map(), 600, Gameplay::default(), store).unwrap();
    let (output, mut rx) = mpsc::channel(128);
    let (reply, _) = oneshot::channel();
    world.command(Command::Join {
        identity: Identity {
            id: character.id.clone(),
            username: character.name,
        },
        connection: "appearance-connection".into(),
        output,
        reply,
        lang: "zh".to_owned(),
    });
    let snapshot: serde_json::Value =
        serde_json::from_str(&rx.try_recv().expect("join snapshot")).unwrap();
    let player = snapshot["players"]
        .as_array()
        .and_then(|players| {
            players
                .iter()
                .find(|player| player["id"].as_str() == Some(character.id.as_str()))
        })
        .expect("joined character in snapshot");
    assert_eq!(
        player["appearance"],
        serde_json::to_value(&appearance).expect("appearance serializes")
    );
    drop(service);
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
}

#[test]
fn pickup_broadcasts_animation_event_once_to_the_same_map() {
    let mut world = World::new(map(), 600);
    let (a_output, mut a_rx) = mpsc::channel(128);
    let (b_output, mut b_rx) = mpsc::channel(128);
    let (c_output, mut c_rx) = mpsc::channel(128);
    for (id, username, connection, output) in [
        ("a", "alice", "a-connection", a_output),
        ("b", "bob", "b-connection", b_output),
        ("c", "charlie", "c-connection", c_output),
    ] {
        let (reply, _) = oneshot::channel();
        world.command(Command::Join {
            identity: Identity {
                id: id.into(),
                username: username.into(),
            },
            connection: connection.into(),
            output,
            reply,
            lang: "zh".to_owned(),
        });
    }
    while a_rx.try_recv().is_ok() {}
    while b_rx.try_recv().is_ok() {}
    while c_rx.try_recv().is_ok() {}
    world.players.get_mut("c").unwrap().map_id = "other".into();

    let pickup_x = world.players["a"].state.x;
    let pickup_y = world.players["a"].state.y;
    world.drops.insert(
        "animation-drop".into(),
        DropState {
            id: "animation-drop".into(),
            item_id: "0".into(),
            quantity: 5,
            x: pickup_x,
            y: pickup_y,
        },
    );
    world.drop_owners.insert("animation-drop".into(), (None, 0));
    world
        .drop_maps
        .insert("animation-drop".into(), "test".into());

    world.handle_pickup(
        "a".into(),
        "animation-pickup".into(),
        "animation-drop".into(),
    );

    let a_messages: Vec<_> = std::iter::from_fn(|| a_rx.try_recv().ok()).collect();
    let b_messages: Vec<_> = std::iter::from_fn(|| b_rx.try_recv().ok()).collect();
    let c_messages: Vec<_> = std::iter::from_fn(|| c_rx.try_recv().ok()).collect();
    let event = a_messages
        .iter()
        .find(|message| message.contains("\"type\":\"dropPickedUp\""))
        .map(|message| serde_json::from_str::<serde_json::Value>(message).unwrap())
        .expect("picker receives pickup animation event");
    assert_eq!(event["mapId"], "test");
    assert_eq!(event["dropId"], "animation-drop");
    assert_eq!(event["playerId"], "a");
    assert_eq!(event["x"].as_f64(), Some(pickup_x));
    assert_eq!(event["y"].as_f64(), Some(pickup_y));
    assert_eq!(
        b_messages
            .iter()
            .filter(|message| message.contains("\"type\":\"dropPickedUp\""))
            .count(),
        1
    );
    assert_eq!(
        c_messages
            .iter()
            .filter(|message| message.contains("\"type\":\"dropPickedUp\""))
            .count(),
        0
    );

    world.handle_pickup(
        "a".into(),
        "animation-pickup".into(),
        "animation-drop".into(),
    );
    let replay_messages: Vec<_> = std::iter::from_fn(|| a_rx.try_recv().ok()).collect();
    assert_eq!(
        replay_messages
            .iter()
            .filter(|message| message.contains("\"type\":\"dropPickedUp\""))
            .count(),
        0
    );
}

#[test]
fn inventory_commands_swap_drop_and_replay_without_duplication() {
    let mut world = World::new(map(), 600);
    let (output, mut rx) = mpsc::channel(128);
    let (reply, _) = oneshot::channel();
    world.command(Command::Join {
        identity: Identity {
            id: "a".into(),
            username: "alice".into(),
        },
        connection: "c".into(),
        output,
        reply,
        lang: "zh".to_owned(),
    });
    let _ = rx.try_recv();
    world.players.get_mut("a").unwrap().state.inventory = vec![
        crate::protocol::InventoryItem {
            slot: 1,
            item_id: "4000019".into(),
            quantity: 3,
            ..crate::protocol::InventoryItem::default()
        },
        crate::protocol::InventoryItem {
            slot: 2,
            item_id: "2000000".into(),
            quantity: 1,
            ..crate::protocol::InventoryItem::default()
        },
    ];
    world.command(Command::Input {
        id: "a".into(),
        connection: "c".into(),
        message: ClientMessage::InventoryMove {
            request_id: "move-once".into(),
            inventory_type: 4,
            source_slot: 1,
            target_slot: 2,
            quantity: 3,
        },
    });
    let use_item = world.players["a"]
        .state
        .inventory
        .iter()
        .find(|item| item.item_id == "2000000")
        .unwrap();
    assert_eq!(use_item.slot, 2);
    let etc_item = world.players["a"]
        .state
        .inventory
        .iter()
        .find(|item| item.item_id == "4000019")
        .unwrap();
    assert_eq!(etc_item.slot, 2);
    world.command(Command::Input {
        id: "a".into(),
        connection: "c".into(),
        message: ClientMessage::InventoryMove {
            request_id: "move-once".into(),
            inventory_type: 4,
            source_slot: 1,
            target_slot: 2,
            quantity: 3,
        },
    });
    assert_eq!(
        world.players["a"]
            .state
            .inventory
            .iter()
            .find(|item| item.item_id == "4000019")
            .unwrap()
            .quantity,
        3
    );

    world.command(Command::Input {
        id: "a".into(),
        connection: "c".into(),
        message: ClientMessage::DropItem {
            request_id: "drop-once".into(),
            inventory_type: 4,
            source_slot: 2,
            quantity: 1,
        },
    });
    assert_eq!(world.drops.len(), 1);
    assert_eq!(world.players["a"].state.inventory[1].quantity, 2);
    world.command(Command::Input {
        id: "a".into(),
        connection: "c".into(),
        message: ClientMessage::DropItem {
            request_id: "drop-once".into(),
            inventory_type: 4,
            source_slot: 2,
            quantity: 1,
        },
    });
    assert_eq!(world.drops.len(), 1);
    assert_eq!(world.players["a"].state.inventory[1].quantity, 2);
    let responses: Vec<_> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
    assert!(responses
        .iter()
        .any(|message| message.contains("inventoryResult")));
    assert!(responses
        .iter()
        .any(|message| message.contains("inventoryDropResult")));
    let move_response = responses
        .iter()
        .find(|message| message.contains("\"type\":\"inventoryResult\""))
        .expect("move response");
    assert!(move_response.contains("\"sourceSlot\":1"));
    assert!(move_response.contains("\"targetSlot\":2"));
    let drop_response = responses
        .iter()
        .find(|message| message.contains("\"type\":\"inventoryDropResult\""))
        .expect("drop response");
    assert!(drop_response.contains("\"sourceSlot\":2"));
}

#[test]
fn portal_command_changes_map_and_snapshot_scope() {
    let mut birth = map();
    birth.portals.push(Portal {
        name: "out00".into(),
        portal_type: 2,
        x: 10.0,
        y: 0.0,
        target_map_id: Some("target".into()),
        target_portal_name: Some("in00".into()),
    });
    let target: Map = serde_json::from_str(
            r#"{"id":"target","bounds":{"xMin":0,"xMax":500,"yMin":-500,"yMax":500},"spawn":{"x":40,"y":100},"footholds":[{"id":1,"x1":0,"y1":100,"x2":500,"y2":100}],"ladders":[],"portals":[{"name":"in00","type":2,"x":40,"y":100}]}"#,
        )
        .unwrap();
    let mut world = World::new(birth.clone(), 600);
    world
        .attach_catalog(MapCatalog {
            birth_map_id: "test".into(),
            return_maps: BTreeMap::new(),
            maps: vec![birth, target],
        })
        .unwrap();
    let (output, mut rx) = mpsc::channel(128);
    let (reply, _) = oneshot::channel();
    world.command(Command::Join {
        identity: Identity {
            id: "a".into(),
            username: "alice".into(),
        },
        connection: "c".into(),
        output,
        reply,
        lang: "zh".to_owned(),
    });
    while rx.try_recv().is_ok() {}
    world.command(Command::Input {
        id: "a".into(),
        connection: "c".into(),
        message: ClientMessage::Portal {
            request_id: "portal-once".into(),
            portal_name: "out00".into(),
        },
    });
    assert_eq!(world.players["a"].map_id, "target");
    let result = rx.try_recv().expect("portal result");
    assert!(result.contains("\"type\":\"portalResult\""));
    world.step();
    // The tick opens with unrelated pushes (friend state, ...), so pick
    // the snapshot out of the burst instead of assuming its position.
    let mut snapshot = None;
    while let Ok(message) = rx.try_recv() {
        if message.contains("\"type\":\"snapshot\"") {
            snapshot = Some(message);
        }
    }
    let snapshot = snapshot.expect("target snapshot");
    assert!(snapshot.contains("\"mapId\":\"target\""));
}

#[test]
fn generated_map_catalog_loads_all_rendered_maps() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/maps.json");
    let catalog = MapCatalog::load(&path).expect("generated map catalog");
    assert_eq!(catalog.birth_map_id, "000010000");
    for id in [
        "000010000",
        "001000000",
        "001010000",
        "001020000",
        "002000000",
        "002000001",
    ] {
        assert!(
            catalog.maps.iter().any(|map| map.id == id),
            "missing starter map {id}"
        );
    }
    assert!(catalog.maps.iter().all(|map| !map.footholds.is_empty()));
    assert!(catalog
        .maps
        .iter()
        .flat_map(|map| map.portals.iter())
        .any(|portal| portal.target_map_id.as_deref() == Some("000020000")));
}

#[test]
fn tms273_catalog_preserves_authored_portals_without_v83_rewrites() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/maps.json");
    let catalog = MapCatalog::load(&path).expect("generated TMS273 map catalog");
    let map = |id: &str| catalog.maps.iter().find(|map| map.id == id).unwrap();
    let portal = |id: &str, name: &str| {
        map(id)
            .portals
            .iter()
            .find(|portal| portal.name == name)
            .unwrap()
    };
    let exit = portal("000020000", "out00");
    assert_eq!(exit.target_map_id.as_deref(), Some("001000000"));
    assert_eq!(exit.target_portal_name.as_deref(), Some("west00"));
    // The source arrival marker is not an outgoing return gate.
    let arrival = portal("000030000", "in00");
    assert!(arrival.target_map_id.is_none());
    assert!(arrival.target_portal_name.is_none());
    assert!(!map("000020000").portals.iter().any(|p| p.name == "in01"));
    assert_eq!(
        portal("000040000", "in00").target_map_id.as_deref(),
        Some("000020000")
    );
}

/// A warp must land on the floor.  The arrival resolution in
/// `handle_portal` only snaps to ground within 24 px, so a landing whose
/// nearest foothold is farther than that leaves the player airborne until
/// gravity pulls them down — visible as "landed in the wrong place".
/// The bug was routing several scripted gates to the destination's default
/// spawn (`sp`), which marks the authored spawn point rather than a floor.
#[test]
fn tms273_warp_landings_are_grounded() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/maps.json");
    let catalog = MapCatalog::load(&path).expect("generated TMS273 map catalog");
    let ids: BTreeSet<&str> = catalog.maps.iter().map(|map| map.id.as_str()).collect();
    let map = |id: &str| catalog.maps.iter().find(|map| map.id == id).unwrap();
    let gate = |id: &str, name: &str| {
        map(id)
            .portals
            .iter()
            .find(|portal| portal.name == name)
            .unwrap()
    };
    for source in &catalog.maps {
        for portal in &source.portals {
            let Some(target_id) = portal.target_map_id.as_deref() else {
                continue;
            };
            if target_id == source.id || !ids.contains(target_id) {
                continue;
            }
            // 埃德爾斯坦船的舱门（out00..09）由 `ship.rs` 接管：检票相位
            // warp 回本端检票站台 `sp`，航行中不开门——静态 tn 落点（源
            // st00 悬空 170px）不参与贴地审计。
            if matches!(
                source.id.as_str(),
                "200090600" | "200090601" | "200090610" | "200090611"
            ) && portal.name.starts_with("out")
            {
                continue;
            }
            // 愛奧斯塔 32樓/66樓（2026-09-15）：源 `tn` 指定的落点本身是隐形
            // 锚——`221021200/st00` y=644 而该 x 只有 y=705 的地板（Δ61px）、
            // `221021700/top00` Δ41px。原版落在锚点上也自然下坠一小段，落点
            // 来自源，不能为了贴地把锚点搬下来。同样的 6 条边在
            // `scripts/check_tms273_runtime.cjs` 里也带反向断言钉着。
            if matches!(
                (source.id.as_str(), portal.name.as_str()),
                ("221021300", "under00")
                    | ("221021300", "under01")
                    | ("221021300", "under02")
                    | ("221021300", "under03")
                    | ("221021300", "under04")
                    | ("221021800", "under00")
            ) {
                continue;
            }
            // 埃德爾斯坦散步路道4 → 去礦山的路1（310030300.east00 →
            // 310040000.west00，2026-09-16）：源 `west00` 落在 y=-129，而该列的
            // 最近地板是 `foothold/5/0/47`（x -391..40）y=-99，Δ30px。这不是
            // 导入丢地板——源图与目录**逐条**都是 116 条 foothold，该列上方的确
            // 没有任何平台；原版落上去同样是自然下坠一小段。与 愛奧斯塔 两条
            // 同性质：落点来自源，不为贴地把门搬下来。
            if matches!(
                (source.id.as_str(), portal.name.as_str()),
                ("310030300", "east00")
            ) {
                continue;
            }
            let target = map(target_id);
            let landing = portal
                .target_portal_name
                .as_deref()
                .and_then(|name| target.portals.iter().find(|p| p.name == name))
                .map(|p| (p.x, p.y))
                .unwrap_or((target.spawn.x, target.spawn.y));
            let ground = target.ground_near(landing.0, landing.1);
            let distance = ground.map_or(f64::INFINITY, |(_, y)| (y - landing.1).abs());
            assert!(
                distance <= 24.0,
                "{} / {} -> {} / {} lands {:?}px off the ground",
                source.id,
                portal.name,
                target_id,
                portal.target_portal_name.as_deref().unwrap_or("spawn"),
                distance
            );
        }
    }
    // The pier ferry both ways, per `Map/Map/Graph.json`.
    let pier = gate("002000000", "east00");
    assert_eq!(pier.target_map_id.as_deref(), Some("002000100"));
    assert_eq!(pier.target_portal_name.as_deref(), Some("west00"));
    let back = gate("002000100", "west00");
    assert_eq!(back.target_map_id.as_deref(), Some("002000000"));
    assert_eq!(back.target_portal_name.as_deref(), Some("in00"));
    // 維多利亞港三家商店：原版 273 的三个 type-2 店门，以及店内的返回门。
    // 目标图不在目录里时 `handle_portal` 会回 `map_unavailable`，所以这里
    // 同时断言配对与目录归属，而上面的循环断言落点贴地。
    for (town, name, shop, exit_name) in [
        ("104000000", "in00", "104000001", "out00"),
        ("104000000", "in01", "104000002", "out01"),
        ("104000000", "in02", "104000003", "out00"),
    ] {
        assert!(
            ids.contains(shop),
            "{shop} must be part of the assembled catalog"
        );
        let enter = gate(town, name);
        assert_eq!(enter.target_map_id.as_deref(), Some(shop));
        assert_eq!(enter.target_portal_name.as_deref(), Some(exit_name));
        let exit = gate(shop, exit_name);
        assert_eq!(exit.target_map_id.as_deref(), Some(town));
        assert_eq!(exit.target_portal_name.as_deref(), Some(name));
    }
}

#[test]
fn authored_life_loads_on_each_map_and_respawns_from_its_source() {
    let birth = life_map("birth");
    let target = life_map("target");
    let gameplay = life_gameplay(vec![
        life_spawn("birth-life", "birth", 100.0, -1, -1),
        life_spawn("target-life", "target", 200.0, 1, 1),
    ]);
    let mut world = World::build(birth.clone(), 600, gameplay, None).unwrap();
    world
        .attach_catalog(MapCatalog {
            birth_map_id: "birth".into(),
            return_maps: BTreeMap::new(),
            maps: vec![birth, target],
        })
        .unwrap();
    assert_eq!(world.monsters.len(), 2);
    assert_eq!(
        world
            .monsters
            .values()
            .filter(|monster| monster.map_id == "birth")
            .count(),
        1
    );
    assert_eq!(
        world
            .monsters
            .values()
            .find(|monster| monster.map_id == "target")
            .unwrap()
            .state
            .facing,
        1
    );

    let (birth_output, _birth_rx) = mpsc::channel(16);
    let (birth_reply, _birth_reply_rx) = oneshot::channel();
    world.command(Command::Join {
        identity: Identity {
            id: "birth-player".into(),
            username: "birth-player".into(),
        },
        connection: "birth-connection".into(),
        output: birth_output,
        reply: birth_reply,
        lang: "zh".to_owned(),
    });
    let (target_output, _target_rx) = mpsc::channel(16);
    let (target_reply, _target_reply_rx) = oneshot::channel();
    world.command(Command::Join {
        identity: Identity {
            id: "target-player".into(),
            username: "target-player".into(),
        },
        connection: "target-connection".into(),
        output: target_output,
        reply: target_reply,
        lang: "zh".to_owned(),
    });
    world.players.get_mut("target-player").unwrap().map_id = "birth".into();

    let birth_id = world
        .monsters
        .iter()
        .find(|(_, monster)| monster.spawn.id == "birth-life")
        .map(|(id, _)| id.clone())
        .unwrap();
    let target_id = world
        .monsters
        .iter()
        .find(|(_, monster)| monster.spawn.id == "target-life")
        .map(|(id, _)| id.clone())
        .unwrap();
    {
        let monster = world.monsters.get_mut(&birth_id).unwrap();
        monster.state.hp = 0;
        monster.state.action = "die";
        monster.death_until = Some(1);
        monster.respawn_at = None;
    }
    {
        let monster = world.monsters.get_mut(&target_id).unwrap();
        monster.state.hp = 0;
        monster.state.action = "die";
        monster.death_until = Some(1);
        monster.respawn_at = Some(20);
    }
    world.tick = 20;
    world.respawn_monsters();
    assert!(!world
        .monsters
        .values()
        .any(|monster| monster.spawn.id == "birth-life"));
    assert!(world.monsters.contains_key(&target_id));

    world.players.get_mut("target-player").unwrap().map_id = "target".into();
    world.respawn_monsters();
    let respawned = world
        .monsters
        .values()
        .find(|monster| monster.spawn.id == "target-life")
        .unwrap();
    assert_ne!(respawned.state.id, target_id);
    assert_eq!(respawned.map_id, "target");
    assert_eq!(respawned.state.x, 200.0);
    assert_eq!(respawned.state.y, 100.0);
    assert_eq!(respawned.state.facing, 1);
    assert_eq!(respawned.spawn.mob_time, 1);
}

#[test]
fn authored_life_rejects_unknown_map_foothold_and_template() {
    let catalog = || MapCatalog {
        birth_map_id: "birth".into(),
        return_maps: BTreeMap::new(),
        maps: vec![life_map("birth"), life_map("target")],
    };
    let cases = [
        (
            life_spawn("unknown-map", "missing", 100.0, 1, 0),
            "unknown map",
        ),
        ({
            let mut spawn = life_spawn("unknown-foothold", "birth", 100.0, 1, 0);
            spawn.foothold_id = Some(99);
            (spawn, "unknown foothold")
        }),
        ({
            let mut spawn = life_spawn("unknown-template", "birth", 100.0, 1, 0);
            spawn.template_id = "missing".into();
            (spawn, "unknown template")
        }),
    ];
    for (spawn, expected) in cases {
        let gameplay = life_gameplay(vec![spawn]);
        let result = World::build(life_map("birth"), 600, gameplay, None)
            .and_then(|mut world| world.attach_catalog(catalog()));
        let error = match result {
            Ok(_) => panic!("invalid authored life was accepted: {expected}"),
            Err(error) => error,
        };
        assert!(error.contains(expected), "{error}");
    }
}

#[test]
fn tms273_percentage_defense_is_not_absolute_pdd() {
    let config = PlayerConfig {
        base_str: Some(100),
        base_dex: Some(20),
        weapon_type: Some(130),
        weapon_watk: Some(100),
        ..PlayerConfig::default()
    };
    let mut monster = life_template();
    monster.pd_rate = Some(10.0);
    monster.pd_damage = Some(9999);
    let (min, max) = config.attack_range();
    assert_eq!(
        config.attack_range_against(1, &monster),
        (min as f64 * 0.9, max as f64 * 0.9)
    );
    monster.pd_rate = Some(300.0);
    assert_eq!(config.attack_range_against(1, &monster), (1.0, 1.0));
    let mut gameplay = life_gameplay(Vec::new());
    gameplay.monsters[0].pd_rate = Some(f64::NAN);
    assert!(gameplay.validate().is_err());
}

#[test]
fn source_pdd_applies_to_damage_interval_and_keeps_one_damage_floor() {
    let config = PlayerConfig {
        base_str: Some(4),
        base_dex: Some(4),
        weapon_type: Some(130),
        weapon_watk: Some(10),
        ..PlayerConfig::default()
    };
    let mut red_snail = life_template();
    red_snail.pd_damage = Some(3);
    let mut slime = life_template();
    slime.pd_damage = Some(5);
    let no_defense = life_template();
    assert_eq!(config.attack_range_against(1, &red_snail), (1.0, 1.0));
    assert_eq!(config.attack_range_against(1, &slime), (1.0, 1.0));
    assert_eq!(config.attack_range_against(1, &no_defense), (1.0, 2.0));
    let mut high_defense = life_template();
    high_defense.pd_damage = Some(1000);
    assert_eq!(config.attack_range_against(1, &high_defense), (1.0, 1.0));
    assert!(config.attack_damage_against(1, &high_defense) >= 1);
}

#[test]
fn map_cycle_mob_time_zero_respawns_even_without_configured_interval() {
    // mobTime 0 means "follow the map respawn cycle"; when the assembled
    // gameplay leaves the map cycle empty the fallback 10 s cycle must
    // still return a deadline, otherwise the mob is removed forever and
    // every map empties over time.
    let interval_ticks = DEFAULT_MONSTER_RESPAWN_MS.div_ceil(TICK_MS);
    assert!(respawn_deadline(10_000, None, 0).is_some());
    assert_eq!(
        respawn_deadline(0, None, 0),
        Some(interval_ticks),
        "cycle-aligned deadline must land on the next interval boundary"
    );
    assert_eq!(
        respawn_deadline(10_000, Some(500), 0),
        Some(10_010),
        "explicit map cycle is preferred over the default"
    );
    assert_eq!(
        respawn_deadline(0, Some(500), 0),
        Some(10),
        "500 ms -> 10 ticks"
    );
    assert_eq!(
        respawn_deadline(0, None, -1),
        None,
        "mobTime -1 never respawns"
    );
    assert_eq!(
        respawn_deadline(1_000, None, 5),
        Some(1_000 + 5_000 / TICK_MS),
        "positive source mobTime is a death-relative second delay"
    );
}

#[test]
fn full_snapshot_queue_keeps_player_connected() {
    let mut world = World::new(map(), 600);
    let (output, mut rx) = mpsc::channel(1);
    let (reply, _) = oneshot::channel();
    world.command(Command::Join {
        identity: Identity {
            id: "a".into(),
            username: "alice".into(),
        },
        connection: "c".into(),
        output,
        reply,
        lang: "zh".to_owned(),
    });
    assert!(rx.try_recv().is_ok());
    world.step();
    assert!(world.players.contains_key("a"));
}

#[test]
fn wall_only_blocks_when_chain_vertical_foothold_reaches_body() {
    let map: Map = serde_json::from_str(
            r#"{"id":"walls","bounds":{"xMin":0,"xMax":300,"yMin":-100,"yMax":500},"spawn":{"x":100,"y":100},"footholds":[{"id":1,"x1":0,"y1":100,"x2":100,"y2":100,"prev":0,"next":2},{"id":2,"x1":100,"y1":100,"x2":100,"y2":180,"prev":1,"next":3},{"id":3,"x1":100,"y1":180,"x2":200,"y2":180,"prev":2,"next":0}],"ladders":[]}"#,
        )
        .unwrap();
    assert_eq!(map.wall_for(3, true, 180.0), 100.0);
    assert_eq!(map.wall_for(3, true, 100.0), 25.0);
    assert_eq!(map.wall_for(1, false, 180.0), 100.0);
    assert_eq!(map.wall_for(1, false, 100.0), 175.0);

    let two_hop: Map = serde_json::from_str(
            r#"{"id":"two-hop-walls","bounds":{"xMin":0,"xMax":400,"yMin":-100,"yMax":500},"spawn":{"x":50,"y":100},"footholds":[{"id":1,"x1":0,"y1":100,"x2":100,"y2":100,"prev":0,"next":2},{"id":2,"x1":100,"y1":100,"x2":200,"y2":100,"prev":1,"next":3},{"id":3,"x1":200,"y1":100,"x2":200,"y2":180,"prev":2,"next":4},{"id":4,"x1":200,"y1":180,"x2":300,"y2":180,"prev":3,"next":0}],"ladders":[]}"#,
        )
        .unwrap();
    assert_eq!(two_hop.wall_for(1, false, 180.0), 200.0);
}

#[test]
fn jump_stops_at_chain_wall_but_outer_wall_does_not_pin_takeoff() {
    // Walking the chain already halts at the wall; jumping must hit the
    // same physical barrier instead of tunneling past it and landing on
    // the upper platform. The FootholdTree `outer_wall` must not pin the
    // body at the take-off point when the chain has no vertical wall
    // neighbour — the next falling sweep intentionally leaves the
    // authored edge to recover on the last foothold.
    let map: Map = serde_json::from_str(
            r#"{"id":"step","bounds":{"xMin":0,"xMax":500,"yMin":-200,"yMax":500},"spawn":{"x":50,"y":100},"footholds":[{"id":1,"x1":0,"y1":100,"x2":100,"y2":100,"prev":0,"next":2},{"id":2,"x1":100,"y1":50,"x2":100,"y2":150,"prev":1,"next":3},{"id":3,"x1":100,"y1":100,"x2":200,"y2":100,"prev":2,"next":0},{"id":4,"x1":0,"y1":250,"x2":500,"y2":250,"prev":0,"next":0}],"ladders":[]}"#,
        )
        .unwrap();
    assert_eq!(
        map.chain_wall_for(1, false, 100.0),
        Some(100.0),
        "chain wall must report the rising step edge"
    );
    // Walking's wall_for coincides here because the chain produces the
    // vertical step at the take-off height.
    assert_eq!(map.wall_for(1, false, 100.0), 100.0);
    // And it must NOT pin the body once the player has cleared the
    // authored area on a recover-jump out of the map.
    let recovery: Map = serde_json::from_str(
            r#"{"id":"recovery","bounds":{"xMin":0,"xMax":300,"yMin":-200,"yMax":300},"spawn":{"x":25,"y":0},"footholds":[{"id":1,"x1":0,"y1":0,"x2":50,"y2":0}],"ladders":[]}"#,
        )
        .unwrap();
    assert_eq!(
        recovery.chain_wall_for(1, false, 0.0),
        None,
        "no chain wall: the airborne jumper must keep rolling past the FootholdTree outer wall"
    );

    let mut w = World::new(map, 600);
    let (output, _rx) = mpsc::channel(128);
    let (reply, _) = oneshot::channel();
    w.command(Command::Join {
        identity: Identity {
            id: "a".into(),
            username: "alice".into(),
        },
        connection: "c".into(),
        reply,
        lang: "zh".to_owned(),
        output,
    });
    w.step();

    // Anchor the player on foothold 1 (range 0..100, y=100), then jump
    // toward the rising step at x=100. The body must stop at the wall
    // edge and stay grounded near y=100 instead of landing on the upper
    // platform (foothold 3, y=100).
    w.command(Command::Input {
        id: "a".into(),
        connection: "c".into(),
        message: ClientMessage::Input {
            seq: 1,
            direction: 1,
            vertical: 0,
            jump: true,
        },
    });
    for _ in 0..60 {
        w.step();
        let player = &w.players["a"];
        if !player.jump && player.state.grounded {
            break;
        }
    }
    let player = &w.players["a"];
    // The block at x=100 must hold the body near the take-off edge;
    // either it returns to the original segment (foothold 1, y=100,
    // x≤100) or — if the wall genuinely pins it — it falls onto the
    // lower world floor (foothold 4, y=250). It must never climb past
    // the wall onto the raised step (foothold 3, x>100).
    assert!(
        player.state.x <= 100.0 + 0.5,
        "jump must not tunnel across the chain wall, got x={}",
        player.state.x
    );
    assert!(
        player.state.grounded,
        "body should land near the take-off platform"
    );
    assert!(
        (player.state.y - 100.0).abs() < 1.0 || player.state.y > 200.0,
        "body must end near take-off platform or on lower world floor, got y={}",
        player.state.y
    );
}

#[test]
fn ladder_follows_original_probe_and_detaches_at_end() {
    let map: Map = serde_json::from_str(
            r#"{"id":"ladder","bounds":{"xMin":0,"xMax":300,"yMin":-100,"yMax":500},"spawn":{"x":100,"y":200},"footholds":[{"id":1,"x1":0,"y1":200,"x2":300,"y2":200}],"ladders":[{"id":1,"x":100,"y1":50,"y2":200,"l":1,"uf":1}]}"#,
        )
        .unwrap();
    let mut w = World::new_with_gameplay(
        map,
        600,
        Gameplay {
            player: PlayerConfig {
                climb_speed: Some(100.0),
                ..PlayerConfig::default()
            },
            ..Gameplay::default()
        },
    );
    let (output, _rx) = mpsc::channel(128);
    let (reply, _) = oneshot::channel();
    w.command(Command::Join {
        identity: Identity {
            id: "a".into(),
            username: "alice".into(),
        },
        connection: "c".into(),
        output,
        reply,
        lang: "zh".to_owned(),
    });
    w.command(Command::Input {
        id: "a".into(),
        connection: "c".into(),
        message: ClientMessage::Input {
            seq: 1,
            direction: 0,
            vertical: -1,
            jump: false,
        },
    });
    w.step();
    assert!(w.players["a"].state.climbing);
    assert_eq!(w.players["a"].state.ladder_id, Some(1));
    assert_eq!(w.players["a"].state.action, "ladder");

    let rope_map: Map = serde_json::from_str(
            r#"{"id":"rope","bounds":{"xMin":0,"xMax":300,"yMin":-100,"yMax":500},"spawn":{"x":100,"y":200},"footholds":[{"id":1,"x1":0,"y1":200,"x2":300,"y2":200}],"ladders":[{"id":1,"x":100,"y1":50,"y2":200,"l":0,"uf":0}]}"#,
        )
        .unwrap();
    let mut rope_world = World::new_with_gameplay(
        rope_map,
        600,
        Gameplay {
            player: PlayerConfig {
                climb_speed: Some(100.0),
                ..PlayerConfig::default()
            },
            ..Gameplay::default()
        },
    );
    let (output, _rx) = mpsc::channel(128);
    let (reply, _) = oneshot::channel();
    rope_world.command(Command::Join {
        identity: Identity {
            id: "a".into(),
            username: "alice".into(),
        },
        connection: "c".into(),
        output,
        reply,
        lang: "zh".to_owned(),
    });
    rope_world.command(Command::Input {
        id: "a".into(),
        connection: "c".into(),
        message: ClientMessage::Input {
            seq: 1,
            direction: 0,
            vertical: -1,
            jump: false,
        },
    });
    for _ in 0..40 {
        rope_world.step();
    }
    assert!(rope_world.players["a"].state.climbing);
    assert_eq!(rope_world.players["a"].state.action, "rope");
    assert_eq!(rope_world.players["a"].state.y, 50.0);
}

#[test]
fn allowed_ladder_top_lands_on_authored_foothold_and_stays_grounded() {
    let map: Map = serde_json::from_str(
            r#"{"id":"ladder-top","bounds":{"xMin":0,"xMax":300,"yMin":-100,"yMax":500},"spawn":{"x":100,"y":200},"footholds":[{"id":1,"x1":0,"y1":200,"x2":200,"y2":200},{"id":2,"x1":0,"y1":95,"x2":200,"y2":95}],"ladders":[{"id":1,"x":100,"y1":100,"y2":200,"l":1,"uf":1}]}"#,
        )
        .unwrap();
    let mut world = World::new_with_gameplay(
        map,
        600,
        Gameplay {
            player: PlayerConfig {
                climb_speed: Some(125.0),
                ..PlayerConfig::default()
            },
            ..Gameplay::default()
        },
    );
    let (output, _rx) = mpsc::channel(128);
    let (reply, _) = oneshot::channel();
    world.command(Command::Join {
        identity: Identity {
            id: "a".into(),
            username: "alice".into(),
        },
        connection: "c".into(),
        output,
        reply,
        lang: "zh".to_owned(),
    });
    world.step();
    world.command(Command::Input {
        id: "a".into(),
        connection: "c".into(),
        message: ClientMessage::Input {
            seq: 1,
            direction: 0,
            vertical: -1,
            jump: false,
        },
    });
    world.step();
    assert!(world.players["a"].state.climbing);

    // Keep Up held until the climb crosses the WZ top endpoint.  The
    // authored support is two pixels above that endpoint, as in the live
    // map, so the transition must select foothold 2 and zero vertical
    // velocity in the same authoritative tick.
    for _ in 0..20 {
        world.step();
    }
    let player = &world.players["a"];
    assert!(!player.state.climbing);
    assert!(player.state.grounded);
    assert_eq!(player.state.ladder_id, None);
    assert_eq!(player.foothold_id, 2);
    assert_eq!(player.state.y, 95.0);
    assert_eq!(player.state.vy, 0.0);

    // Releasing Up must leave the grounded state intact; the following
    // horizontal input must walk on the selected foothold instead of
    // re-entering the ladder or falling through its endpoint.
    world.command(Command::Input {
        id: "a".into(),
        connection: "c".into(),
        message: ClientMessage::Input {
            seq: 2,
            direction: 0,
            vertical: 0,
            jump: false,
        },
    });
    world.step();
    assert!(world.players["a"].state.grounded);
    assert_eq!(world.players["a"].state.y, 95.0);
    world.command(Command::Input {
        id: "a".into(),
        connection: "c".into(),
        message: ClientMessage::Input {
            seq: 3,
            direction: 1,
            vertical: 0,
            jump: false,
        },
    });
    world.step();
    assert!(world.players["a"].state.grounded);
    assert_eq!(world.players["a"].foothold_id, 2);
    assert!(world.players["a"].state.x > 100.0);
    assert_eq!(world.players["a"].state.y, 95.0);
}

#[test]
fn forbidden_ladder_top_holds_at_endpoint() {
    let map: Map = serde_json::from_str(
            r#"{"id":"forbidden-ladder-top","bounds":{"xMin":0,"xMax":300,"yMin":-100,"yMax":500},"spawn":{"x":100,"y":200},"footholds":[{"id":1,"x1":0,"y1":200,"x2":200,"y2":200},{"id":2,"x1":0,"y1":95,"x2":200,"y2":95}],"ladders":[{"id":1,"x":100,"y1":100,"y2":200,"l":1,"uf":0}]}"#,
        )
        .unwrap();
    let mut world = World::new_with_gameplay(
        map,
        600,
        Gameplay {
            player: PlayerConfig {
                climb_speed: Some(125.0),
                ..PlayerConfig::default()
            },
            ..Gameplay::default()
        },
    );
    let (output, _rx) = mpsc::channel(128);
    let (reply, _) = oneshot::channel();
    world.command(Command::Join {
        identity: Identity {
            id: "a".into(),
            username: "alice".into(),
        },
        connection: "c".into(),
        output,
        reply,
        lang: "zh".to_owned(),
    });
    world.step();
    world.command(Command::Input {
        id: "a".into(),
        connection: "c".into(),
        message: ClientMessage::Input {
            seq: 1,
            direction: 0,
            vertical: -1,
            jump: false,
        },
    });
    world.step();
    for _ in 0..20 {
        world.step();
    }
    assert!(world.players["a"].state.climbing);
    assert!(!world.players["a"].state.grounded);
    assert_eq!(world.players["a"].state.y, 100.0);
    assert_eq!(world.players["a"].state.ladder_id, Some(1));

    // Horizontal input at a forbidden top cannot turn the endpoint into
    // an exit and cannot make the player pass through the platform.
    world.command(Command::Input {
        id: "a".into(),
        connection: "c".into(),
        message: ClientMessage::Input {
            seq: 2,
            direction: 1,
            vertical: 0,
            jump: false,
        },
    });
    world.step();
    assert!(world.players["a"].state.climbing);
    assert!(!world.players["a"].state.grounded);
    assert_eq!(world.players["a"].state.y, 100.0);
    assert_eq!(world.players["a"].state.ladder_id, Some(1));
}

#[test]
fn config_drop_and_exp_are_authoritative_without_client_values() {
    // The literal version below is stale on purpose: the fixture is about
    // drop/exp authority, so pin it to whatever the build ships instead of
    // re-breaking on every content bump.
    let mut raw: serde_json::Value = serde_json::from_str(
            r#"{"contentVersion":"tms273-3","player":{"baseStr":4,"baseDex":4,"baseInt":4,"baseLuk":4,"weaponType":130,"weaponWatk":10,"attackReach":80,"attackHeight":40,"attackAfterMs":300,"maxHp":30},"monsterTemplates":[{"templateId":"0100130","level":1,"maxHp":8,"PADamage":12,"exp":1,"bodyAttack":true,"moveSpeed":10,"hitboxWidth":39,"hitboxHeight":29,"drop":{"itemId":"2000000","quantity":1,"guaranteed":true}}],"monsterSpawns":[{"id":"s1","templateId":"0100130","x":100,"y":100,"footholdId":1}],"expTable":[15]}"#,
        )
        .unwrap();
    raw["contentVersion"] = serde_json::json!(crate::protocol::CONTENT_VERSION);
    let gameplay: Gameplay = serde_json::from_value(raw).unwrap();
    gameplay.validate().unwrap();
    assert_eq!(gameplay.monsters[0].pa_damage, Some(12));
    assert_eq!(gameplay.monsters[0].drops()[0].item_id, "2000000");
}

#[test]
fn downjump_requires_allowed_source_foothold_and_skips_it_until_lower_landing() {
    let map: Map = serde_json::from_str(
            r#"{"id":"downjump","bounds":{"xMin":0,"xMax":300,"yMin":-500,"yMax":500},"spawn":{"x":100,"y":0},"footholds":[{"id":1,"x1":0,"y1":0,"x2":300,"y2":0,"prev":0,"next":0,"forbidFallDown":0},{"id":2,"x1":0,"y1":100,"x2":300,"y2":100,"prev":0,"next":0,"forbidFallDown":1}],"ladders":[]}"#,
        )
        .unwrap();
    let mut w = World::new(map, 600);
    let (output, _rx) = mpsc::channel(128);
    let (reply, _) = oneshot::channel();
    w.command(Command::Join {
        identity: Identity {
            id: "a".into(),
            username: "alice".into(),
        },
        connection: "c".into(),
        output,
        reply,
        lang: "zh".to_owned(),
    });
    w.step();
    assert!(w.players["a"].state.grounded);
    w.command(Command::Input {
        id: "a".into(),
        connection: "c".into(),
        message: ClientMessage::Input {
            seq: 1,
            direction: 0,
            vertical: 1,
            jump: true,
        },
    });
    w.step();
    assert!(!w.players["a"].state.grounded);
    assert!(w.players["a"].state.y < 0.0);
    for _ in 0..40 {
        w.step();
    }
    assert!(w.players["a"].state.grounded);
    assert_eq!(w.players["a"].state.y, 100.0);

    let forbidden: Map = serde_json::from_str(
            r#"{"id":"forbidden","bounds":{"xMin":0,"xMax":300,"yMin":-500,"yMax":500},"spawn":{"x":100,"y":0},"footholds":[{"id":1,"x1":0,"y1":0,"x2":300,"y2":0,"prev":0,"next":0,"forbidFallDown":1},{"id":2,"x1":0,"y1":100,"x2":300,"y2":100,"prev":0,"next":0,"forbidFallDown":0}],"ladders":[]}"#,
        )
        .unwrap();
    let mut w = World::new(forbidden, 600);
    let (output, _rx) = mpsc::channel(128);
    let (reply, _) = oneshot::channel();
    w.command(Command::Join {
        identity: Identity {
            id: "a".into(),
            username: "alice".into(),
        },
        connection: "c".into(),
        output,
        reply,
        lang: "zh".to_owned(),
    });
    w.step();
    w.command(Command::Input {
        id: "a".into(),
        connection: "c".into(),
        message: ClientMessage::Input {
            seq: 1,
            direction: 0,
            vertical: 1,
            jump: true,
        },
    });
    w.step();
    assert!(w.players["a"].state.grounded);
    assert_eq!(w.players["a"].state.y, 0.0);
    w.command(Command::Input {
        id: "a".into(),
        connection: "c".into(),
        message: ClientMessage::Input {
            seq: 2,
            direction: 1,
            vertical: 1,
            jump: true,
        },
    });
    w.step();
    assert!(w.players["a"].state.grounded);
    assert_eq!(w.players["a"].state.y, 0.0);
    assert_eq!(w.players["a"].state.vy, 0.0);
}

#[test]
fn jump_returns_to_the_lowest_authored_foothold() {
    let map: Map = serde_json::from_str(
            r#"{"id":"lowest","bounds":{"xMin":0,"xMax":300,"yMin":-200,"yMax":300},"spawn":{"x":100,"y":200},"footholds":[{"id":1,"x1":0,"y1":200,"x2":300,"y2":200}],"ladders":[]}"#,
        )
        .unwrap();
    let mut world = World::new(map, 600);
    let (output, _rx) = mpsc::channel(128);
    let (reply, _) = oneshot::channel();
    world.command(Command::Join {
        identity: Identity {
            id: "a".into(),
            username: "alice".into(),
        },
        connection: "c".into(),
        output,
        reply,
        lang: "zh".to_owned(),
    });
    world.step();
    world.command(Command::Input {
        id: "a".into(),
        connection: "c".into(),
        message: ClientMessage::Input {
            seq: 1,
            direction: 0,
            vertical: 0,
            jump: true,
        },
    });
    world.step();
    assert!(!world.players["a"].state.grounded);
    for _ in 0..30 {
        world.step();
    }
    let player = &world.players["a"];
    assert!(player.state.grounded);
    assert_eq!(player.state.y, 200.0);
    assert_eq!(player.foothold_id, 1);
    assert_eq!(player.state.vy, 0.0);
    assert_eq!(player.drop_fh, 0);
}

#[test]
fn falling_sweeps_across_edge_to_narrow_authored_foothold() {
    let map: Map = serde_json::from_str(
            r#"{"id":"sweep","bounds":{"xMin":0,"xMax":300,"yMin":-200,"yMax":300},"spawn":{"x":50,"y":0},"footholds":[{"id":1,"x1":0,"y1":0,"x2":100,"y2":0,"prev":0,"next":0},{"id":2,"x1":122,"y1":47,"x2":124,"y2":47,"prev":0,"next":0},{"id":3,"x1":0,"y1":200,"x2":300,"y2":200,"prev":0,"next":0}],"ladders":[]}"#,
        )
        .unwrap();
    let mut world = World::new(map, 600);
    let (output, _rx) = mpsc::channel(128);
    let (reply, _) = oneshot::channel();
    world.command(Command::Join {
        identity: Identity {
            id: "a".into(),
            username: "alice".into(),
        },
        connection: "c".into(),
        output,
        reply,
        lang: "zh".to_owned(),
    });
    world.step();
    world.command(Command::Input {
        id: "a".into(),
        connection: "c".into(),
        message: ClientMessage::Input {
            seq: 1,
            direction: 1,
            vertical: 0,
            jump: true,
        },
    });
    world.step();
    for _ in 0..20 {
        world.step();
        if world.players["a"].state.grounded {
            break;
        }
    }
    let player = &world.players["a"];
    assert!(player.state.grounded);
    assert_eq!(player.foothold_id, 2);
    assert_eq!(player.state.y, 47.0);
    assert!(player.state.x >= 122.0 && player.state.x <= 124.0);
}

#[test]
fn walking_off_foothold_edge_does_not_reland_at_sweep_start() {
    let map: Map = serde_json::from_str(
            r#"{"id":"edge-fall","bounds":{"xMin":0,"xMax":300,"yMin":-200,"yMax":300},"spawn":{"x":99,"y":0},"footholds":[{"id":1,"x1":0,"y1":0,"x2":100,"y2":0,"prev":0,"next":0},{"id":2,"x1":0,"y1":100,"x2":300,"y2":100,"prev":0,"next":0}],"ladders":[]}"#,
        )
        .unwrap();
    let mut world = World::new(map, 600);
    let (output, _rx) = mpsc::channel(128);
    let (reply, _) = oneshot::channel();
    world.command(Command::Join {
        identity: Identity {
            id: "a".into(),
            username: "alice".into(),
        },
        connection: "c".into(),
        output,
        reply,
        lang: "zh".to_owned(),
    });
    world.step();
    world.command(Command::Input {
        id: "a".into(),
        connection: "c".into(),
        message: ClientMessage::Input {
            seq: 1,
            direction: 1,
            vertical: 0,
            jump: false,
        },
    });
    world.step();
    assert!(!world.players["a"].state.grounded);
    assert_eq!(world.players["a"].foothold_id, 0);
    assert!(world.players["a"].state.x > 100.0);
    for _ in 0..20 {
        world.step();
        if world.players["a"].state.grounded {
            break;
        }
    }
    let player = &world.players["a"];
    assert!(player.state.grounded);
    assert_eq!(player.foothold_id, 2);
    assert_eq!(player.state.y, 100.0);
}

#[test]
fn falling_beyond_map_recovers_on_last_authored_foothold_and_stays_stable() {
    let map: Map = serde_json::from_str(
            r#"{"id":"recovery","bounds":{"xMin":0,"xMax":300,"yMin":-200,"yMax":300},"spawn":{"x":25,"y":0},"footholds":[{"id":1,"x1":0,"y1":0,"x2":50,"y2":0}],"ladders":[]}"#,
        )
        .unwrap();
    let mut world = World::new(map, 600);
    let (output, _rx) = mpsc::channel(128);
    let (reply, _) = oneshot::channel();
    world.command(Command::Join {
        identity: Identity {
            id: "a".into(),
            username: "alice".into(),
        },
        connection: "c".into(),
        output,
        reply,
        lang: "zh".to_owned(),
    });
    world.step();
    world.command(Command::Input {
        id: "a".into(),
        connection: "c".into(),
        message: ClientMessage::Input {
            seq: 1,
            direction: 1,
            vertical: 0,
            jump: true,
        },
    });
    world.step();
    for _ in 0..30 {
        world.step();
        if world.players["a"].state.grounded && world.players["a"].state.x == 50.0 {
            break;
        }
    }
    {
        let player = &world.players["a"];
        assert!(player.state.grounded);
        assert_eq!(player.state.x, 50.0);
        assert_eq!(player.state.y, 0.0);
        assert_eq!(player.state.vx, 0.0);
        assert_eq!(player.state.vy, 0.0);
        assert_eq!(player.foothold_id, 1);
        assert!(!player.state.climbing);
        assert_eq!(player.state.ladder_id, None);
        assert_eq!(player.drop_fh, 0);
        assert_eq!(player.direction, 0);
        assert_eq!(player.vertical, 0);
        assert!(!player.jump);
    }
    world.step();
    let player = &world.players["a"];
    assert!(player.state.grounded);
    assert_eq!(player.state.x, 50.0);
    assert_eq!(player.state.y, 0.0);
    assert_eq!(player.state.vy, 0.0);
    world.command(Command::Input {
        id: "a".into(),
        connection: "c".into(),
        message: ClientMessage::Input {
            seq: 2,
            direction: 1,
            vertical: 0,
            jump: false,
        },
    });
    world.step();
    let player = &world.players["a"];
    assert!(player.state.grounded);
    assert_eq!(player.state.x, 50.0);
    assert_eq!(player.state.y, 0.0);
    assert_eq!(player.state.vx, 0.0);
    assert_eq!(player.state.vy, 0.0);
}

#[test]
fn falling_without_last_authored_foothold_uses_spawn_support() {
    let map: Map = serde_json::from_str(
            r#"{"id":"spawn-recovery","bounds":{"xMin":0,"xMax":300,"yMin":-200,"yMax":300},"spawn":{"x":25,"y":0},"footholds":[{"id":1,"x1":0,"y1":0,"x2":50,"y2":0}],"ladders":[]}"#,
        )
        .unwrap();
    let mut world = World::new(map, 600);
    let (output, _rx) = mpsc::channel(128);
    let (reply, _) = oneshot::channel();
    world.command(Command::Join {
        identity: Identity {
            id: "a".into(),
            username: "alice".into(),
        },
        connection: "c".into(),
        output,
        reply,
        lang: "zh".to_owned(),
    });
    world.step();
    {
        let player = world.players.get_mut("a").unwrap();
        player.foothold_id = 0;
        player.last_foothold_id = 0;
    }
    world.command(Command::Input {
        id: "a".into(),
        connection: "c".into(),
        message: ClientMessage::Input {
            seq: 1,
            direction: 1,
            vertical: 0,
            jump: true,
        },
    });
    world.step();
    for _ in 0..30 {
        world.step();
        if world.players["a"].state.grounded && world.players["a"].state.x == 25.0 {
            break;
        }
    }
    let player = &world.players["a"];
    assert!(player.state.grounded);
    assert_eq!(player.state.x, 25.0);
    assert_eq!(player.state.y, 0.0);
    assert_eq!(player.foothold_id, 1);
    assert_eq!(player.last_foothold_id, 1);
    assert_eq!(player.state.vx, 0.0);
    assert_eq!(player.state.vy, 0.0);
}

#[test]
fn monster_respawn_waits_for_cycle_and_death_animation() {
    let map: Map = serde_json::from_str(
            r#"{"id":"respawn","bounds":{"xMin":0,"xMax":300,"yMin":-100,"yMax":300},"spawn":{"x":100,"y":100},"footholds":[{"id":1,"x1":0,"y1":100,"x2":300,"y2":100}],"ladders":[]}"#,
        )
        .unwrap();
    let mut w = World::new_with_gameplay(
        map,
        600,
        Gameplay {
            monster_respawn_ms: Some(100),
            monsters: vec![MonsterTemplate {
                template_id: "100100".into(),
                level: 1,
                max_hp: 8,
                max_mp: 0,
                boss: false,
                pa_damage: Some(12),
                pd_damage: None,
                pd_rate: None,
                md_rate: None,
                exp: 3,
                body_attack: true,
                move_speed: None,
                source_speed: None,
                hitbox_width: None,
                hitbox_height: None,
                hitbox_lt: Some(Point { x: -18.0, y: -26.0 }),
                hitbox_rb: Some(Point { x: 19.0, y: 0.0 }),
                die_duration_ms: Some(250),
                stand_delay_ms: None,
                move_duration_ms: None,
                drop: None,
                skills: Vec::new(),
                body_disease: None,
                body_disease_level: None,
                pushed: None,
            }],
            spawns: vec![MonsterSpawn {
                id: "s1".into(),
                template_id: "100100".into(),
                x: 100.0,
                y: 100.0,
                foothold_id: Some(1),
                map_id: String::new(),
                facing: 1,
                mob_time: 0,
                rx0: None,
                rx1: None,
            }],
            ..Gameplay::default()
        },
    );
    let (output, _rx) = mpsc::channel(128);
    let (reply, _) = oneshot::channel();
    w.command(Command::Join {
        identity: Identity {
            id: "a".into(),
            username: "alice".into(),
        },
        connection: "c".into(),
        output,
        reply,
        lang: "zh".to_owned(),
    });
    let old_id = w.monsters.keys().next().cloned().unwrap();
    let monster = w.monsters.get_mut(&old_id).unwrap();
    monster.state.hp = 0;
    monster.state.action = "die";
    monster.death_until = Some(6);
    monster.respawn_at = Some(2);

    for _ in 0..5 {
        w.step();
        assert!(w.monsters.contains_key(&old_id));
    }
    w.step();
    assert!(!w.monsters.contains_key(&old_id));
    assert_eq!(w.monsters.len(), 1);
    assert_ne!(w.monsters.keys().next().unwrap(), &old_id);
}

#[test]
fn revive_replay_is_success_when_alive_but_stale_after_new_death() {
    let mut w = World::new(map(), 600);
    let (output, mut rx) = mpsc::channel(128);
    let (reply, _) = oneshot::channel();
    w.command(Command::Join {
        identity: Identity {
            id: "a".into(),
            username: "alice".into(),
        },
        connection: "c".into(),
        output,
        reply,
        lang: "zh".to_owned(),
    });
    while rx.try_recv().is_ok() {}
    {
        let player = w.players.get_mut("a").unwrap();
        player.state.action = "dead";
        player.state.hp = 0;
        player.death_id = "death-1".into();
    }
    w.handle_revive("a".into(), "revive-1".into());
    let first: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
    assert_eq!(first["success"], true);

    // The original request is idempotent after its state transition.
    w.handle_revive("a".into(), "revive-1".into());
    let replay: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
    assert_eq!(replay["success"], true);
    assert_eq!(replay["code"], "");

    // A request from the previous death cannot revive a later one.
    {
        let player = w.players.get_mut("a").unwrap();
        player.state.action = "dead";
        player.state.hp = 0;
        player.death_id = "death-2".into();
    }
    w.handle_revive("a".into(), "revive-1".into());
    let stale: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
    assert_eq!(stale["success"], false);
    assert_eq!(stale["code"], "revive_stale");
    assert_eq!(w.players["a"].state.action, "dead");
}

#[test]
fn dead_profile_reconnects_dead_and_can_use_revive() {
    let path =
        std::env::temp_dir().join(format!("maple-world-revive-{}.sqlite3", auth::random_id()));
    let auth = auth::start(&path).unwrap();
    let defaults = Profile {
        hp: 50,
        max_hp: 50,
        mp: 5,
        max_mp: 5,
        level: 1,
        job: 200,
        exp: 0,
        exp_to_next: 15,
        mesos: 0,
        cash: 0,
        death_id: String::new(),
        map_id: String::new(),
        x: 0.0,
        y: 0.0,
        inventory: Vec::new(),
        skills: BTreeMap::new(),
        skill_points: BTreeMap::new(),
        ability_stats: AbilityStats::default(),
    };
    auth.store.load_profile("a", &defaults).unwrap();
    let mut dead = defaults;
    dead.hp = 0;
    dead.death_id = "death-after-restart".into();
    auth.store.save_profile("a", &dead).unwrap();

    let mut w = World::new_with_store(map(), 600, Gameplay::default(), auth.store.clone()).unwrap();
    let (output, mut rx) = mpsc::channel(128);
    let (reply, _) = oneshot::channel();
    w.command(Command::Join {
        identity: Identity {
            id: "a".into(),
            username: "alice".into(),
        },
        connection: "c".into(),
        output,
        reply,
        lang: "zh".to_owned(),
    });
    assert_eq!(w.players["a"].state.job, 200);
    let persisted = profile_from_state(
        &w.players["a"].state,
        &w.players["a"].map_id,
        &w.players["a"].death_id,
        w.players["a"].base_max_mp,
    );
    let mut restored = w.players["a"].state.clone();
    restored.job = 0;
    apply_profile(&mut restored, persisted);
    assert_eq!(restored.job, 200);
    assert_eq!(w.players["a"].state.action, "dead");
    assert_eq!(w.players["a"].death_id, "death-after-restart");
    while rx.try_recv().is_ok() {}
    w.handle_revive("a".into(), "revive-after-restart".into());
    assert_eq!(w.players["a"].state.action, "stand");
    assert_eq!(w.players["a"].state.hp, 50);
    drop(w);
    drop(auth);
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
}

#[test]
fn monster_hit_state_uses_source_counter_window() {
    let mut w = World::new_with_gameplay(
        map(),
        600,
        Gameplay {
            monsters: vec![MonsterTemplate {
                template_id: "100100".into(),
                level: 1,
                max_hp: 8,
                max_mp: 0,
                boss: false,
                pa_damage: Some(12),
                pd_damage: None,
                pd_rate: None,
                md_rate: None,
                exp: 3,
                body_attack: true,
                move_speed: None,
                source_speed: Some(-65.0),
                hitbox_width: None,
                hitbox_height: None,
                hitbox_lt: Some(Point { x: -18.0, y: -26.0 }),
                hitbox_rb: Some(Point { x: 19.0, y: 0.0 }),
                die_duration_ms: Some(1260),
                stand_delay_ms: None,
                move_duration_ms: None,
                drop: None,
                skills: Vec::new(),
                body_disease: None,
                body_disease_level: None,
                pushed: None,
            }],
            spawns: vec![MonsterSpawn {
                id: "s1".into(),
                template_id: "100100".into(),
                x: 100.0,
                y: 100.0,
                foothold_id: Some(1),
                map_id: String::new(),
                facing: 1,
                mob_time: 0,
                rx0: None,
                rx1: None,
            }],
            ..Gameplay::default()
        },
    );
    let id = w.monsters.keys().next().cloned().unwrap();
    let monster = w.monsters.get_mut(&id).unwrap();
    monster.state.action = "hit";
    monster.state.action_started_tick = 10;

    w.tick = 14;
    w.step_monsters();
    assert_eq!(w.monsters[&id].state.action, "hit");
    w.tick = 15;
    w.step_monsters();
    assert_eq!(w.monsters[&id].state.action, "move");
}

#[test]
fn snail_ai_uses_source_stand_and_move_windows() {
    let mut w = World::new_with_gameplay(
        map(),
        600,
        Gameplay {
            monsters: vec![MonsterTemplate {
                template_id: "100100".into(),
                level: 1,
                max_hp: 8,
                max_mp: 0,
                boss: false,
                pa_damage: Some(12),
                pd_damage: None,
                pd_rate: None,
                md_rate: None,
                exp: 3,
                body_attack: true,
                move_speed: None,
                source_speed: Some(-65.0),
                hitbox_width: None,
                hitbox_height: None,
                hitbox_lt: Some(Point { x: -18.0, y: -26.0 }),
                hitbox_rb: Some(Point { x: 19.0, y: 0.0 }),
                die_duration_ms: Some(1260),
                stand_delay_ms: Some(100),
                move_duration_ms: Some(900),
                drop: None,
                skills: Vec::new(),
                body_disease: None,
                body_disease_level: None,
                pushed: None,
            }],
            spawns: vec![MonsterSpawn {
                id: "s1".into(),
                template_id: "100100".into(),
                x: 100.0,
                y: 100.0,
                foothold_id: Some(1),
                map_id: String::new(),
                facing: 1,
                mob_time: 0,
                rx0: None,
                rx1: None,
            }],
            ..Gameplay::default()
        },
    );
    let id = w.monsters.keys().next().cloned().unwrap();
    {
        let monster = w.monsters.get_mut(&id).unwrap();
        monster.state.action = "stand";
        monster.state.action_started_tick = 0;
        monster.horizontal_speed = 0.0;
    }
    w.tick = 33;
    w.step_monsters();
    assert_eq!(w.monsters[&id].state.action, "stand");
    w.tick = 34;
    w.step_monsters();
    assert_eq!(w.monsters[&id].state.action, "move");
    assert_eq!(w.monsters[&id].state.action_started_tick, 34);

    {
        let monster = w.monsters.get_mut(&id).unwrap();
        monster.state.action = "move";
        monster.state.action_started_tick = 0;
        monster.horizontal_speed = 0.0;
    }
    w.tick = 35;
    w.step_monsters();
    assert_eq!(w.monsters[&id].state.action, "move");
    w.tick = 36;
    w.step_monsters();
    assert!(matches!(w.monsters[&id].state.action, "stand" | "move"));
    assert_eq!(w.monsters[&id].state.action_started_tick, 36);
}

#[test]
fn monster_crosses_contiguous_footholds_and_turns_at_chain_end() {
    let mut w = World::new_with_gameplay(
        map(),
        600,
        Gameplay {
            monsters: vec![MonsterTemplate {
                template_id: "100100".into(),
                level: 1,
                max_hp: 8,
                max_mp: 0,
                boss: false,
                pa_damage: Some(12),
                pd_damage: None,
                pd_rate: None,
                md_rate: None,
                exp: 3,
                body_attack: true,
                move_speed: None,
                source_speed: Some(-65.0),
                hitbox_width: None,
                hitbox_height: None,
                hitbox_lt: Some(Point { x: -18.0, y: -26.0 }),
                hitbox_rb: Some(Point { x: 19.0, y: 0.0 }),
                die_duration_ms: Some(1260),
                stand_delay_ms: Some(100),
                move_duration_ms: Some(900),
                drop: None,
                skills: Vec::new(),
                body_disease: None,
                body_disease_level: None,
                pushed: None,
            }],
            spawns: vec![MonsterSpawn {
                id: "s1".into(),
                template_id: "100100".into(),
                x: 100.0,
                y: 100.0,
                foothold_id: Some(1),
                map_id: String::new(),
                facing: 1,
                mob_time: 0,
                rx0: None,
                rx1: None,
            }],
            ..Gameplay::default()
        },
    );
    let id = w.monsters.keys().next().cloned().unwrap();
    let monster = w.monsters.get_mut(&id).unwrap();
    monster.state.action = "move";
    monster.state.x = 199.9;
    monster.state.y = 100.0;
    monster.state.facing = 1;
    monster.foothold_id = 1;
    monster.horizontal_speed = 1.0;
    step_monster_with_force(&w.map, monster, 0.035);
    assert_eq!(monster.foothold_id, 2);
    assert!(monster.state.x > 200.0);
    assert!(monster.state.y > 100.0);

    monster.state.x = 474.9;
    monster.state.y = w.map.get(2).unwrap().at(474.9).unwrap();
    monster.state.facing = 1;
    monster.horizontal_speed = 1.0;
    step_monster_with_force(&w.map, monster, 0.035);
    assert_eq!(monster.state.x, 475.0);
    assert_eq!(monster.state.facing, -1);
    assert_eq!(monster.horizontal_speed, 0.0);
}

/// A deterministic boss/world-independent grid mob: step-based movement
/// (`move_speed` 100 -> 5 px / world tick) so pursuit distance is linear
/// and easy to assert.  Home/spawn point is `spawn_x` on the `map()` test
/// floor.
fn aggro_mob_gameplay(spawn_x: f64) -> Gameplay {
    Gameplay {
        monsters: vec![MonsterTemplate {
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
            move_speed: Some(100.0),
            source_speed: None,
            hitbox_width: None,
            hitbox_height: None,
            hitbox_lt: None,
            hitbox_rb: None,
            die_duration_ms: Some(50),
            stand_delay_ms: None,
            move_duration_ms: None,
            drop: None,
            skills: Vec::new(),
            body_disease: None,
            body_disease_level: None,
            pushed: None,
        }],
        spawns: vec![MonsterSpawn {
            id: "sa".into(),
            template_id: "100100".into(),
            x: spawn_x,
            y: 100.0,
            foothold_id: Some(1),
            map_id: String::new(),
            facing: 1,
            mob_time: 0,
            rx0: None,
            rx1: None,
        }],
        monster_respawn_ms: Some(500),
        ..Gameplay::default()
    }
}

#[test]
fn monster_pursues_the_character_that_hit_it() {
    let mut w = World::new_with_gameplay(map(), 600, aggro_mob_gameplay(100.0));
    let _rx = join_test_player(&mut w, "a");
    let monster_id = w.monsters.keys().next().cloned().unwrap();
    {
        let player = w.players.get_mut("a").unwrap();
        player.map_id = "test".into();
        player.state.x = 300.0;
        player.state.y = 100.0;
        player.state.action = "stand";
    }
    {
        let mob = w.monsters.get_mut(&monster_id).unwrap();
        mob.state.x = 100.0;
        mob.state.y = 100.0;
        mob.state.action = "stand";
        mob.state.action_started_tick = 0;
        // Take a hit from "a": both remember the attacker and refresh the
        // hold window so the chase does not drop out mid-assertion.
        mark_monster_hit_aggro(mob, "a", w.tick);
        assert_eq!(mob.aggro_target.as_deref(), Some("a"));
        assert!(!mob.returning_home);
    }
    let start_x = w.monsters[&monster_id].state.x;
    // 10 ticks x 5 px keeps the mob closing on the (rightward) target while
    // staying left of the x=200 foothold seam, so facing is stable at 1.
    for _ in 0..10 {
        w.tick += 1;
        w.step_monsters();
    }
    let mob = &w.monsters[&monster_id];
    // The mob leaves idle stand, faces the target and closes ground each
    // step instead of drifting at random.
    assert_eq!(mob.state.action, "move");
    assert_eq!(mob.state.facing, 1);
    assert!(
        mob.state.x > start_x + 30.0,
        "mob should close on the target, moved to {}",
        mob.state.x
    );
}

#[test]
fn monster_drops_aggro_and_walks_home() {
    let mut w = World::new_with_gameplay(map(), 600, aggro_mob_gameplay(100.0));
    let _rx = join_test_player(&mut w, "a");
    let monster_id = w.monsters.keys().next().cloned().unwrap();
    {
        let player = w.players.get_mut("a").unwrap();
        player.map_id = "test".into();
        player.state.x = 300.0;
        player.state.y = 100.0;
    }
    {
        let mob = w.monsters.get_mut(&monster_id).unwrap();
        // The mob pursued deep right (x=300); home is the spawn at x=100.
        mob.state.x = 300.0;
        mob.state.y = 100.0;
        mob.foothold_id = 2; // x=300 sits on foothold 2 (200-500), not 1
        mob.state.action = "move";
        mob.state.action_started_tick = 0;
        mob.aggro_target = Some("a".into());
        // The last hit happened long ago: the hold window already closed,
        // which is the "interest expires" (脱离) case.
        mob.aggro_until = 0;
        mob.returning_home = false;
    }
    w.tick = 5;
    w.step_monsters();
    {
        let mob = &w.monsters[&monster_id];
        assert!(
            mob.aggro_target.is_none(),
            "expired aggro must be forgotten"
        );
        assert!(mob.returning_home, "mob must start walking home");
        assert_eq!(mob.state.facing, -1, "walking back toward the spawn");
    }
    let start_x = w.monsters[&monster_id].state.x;
    for _ in 0..30 {
        w.tick += 1;
        w.step_monsters();
    }
    let mob = &w.monsters[&monster_id];
    assert!(
        mob.state.x < start_x - 40.0,
        "mob should walk back toward home ({} -> {})",
        start_x,
        mob.state.x
    );
    assert!(
        mob.returning_home || (mob.state.x - 100.0).abs() <= MOB_HOME_RADIUS + 5.0,
        "still returning or already home"
    );
}

#[test]
fn monster_forgets_a_dead_or_departed_target() {
    let mut w = World::new_with_gameplay(map(), 600, aggro_mob_gameplay(100.0));
    let _rx = join_test_player(&mut w, "a");
    let monster_id = w.monsters.keys().next().cloned().unwrap();
    {
        let player = w.players.get_mut("a").unwrap();
        player.map_id = "test".into();
        player.state.x = 300.0;
        player.state.y = 100.0;
    }
    // A valid aggro window, but the target's body is dead: the mob must
    // treat it as gone immediately (no waiting out the hold window).
    {
        let mob = w.monsters.get_mut(&monster_id).unwrap();
        // Park the mob away from its spawn so the walk-home assert is real.
        mob.state.x = 200.0;
        mob.state.y = 100.0;
        mob.state.action = "move";
        mark_monster_hit_aggro(mob, "a", w.tick);
    }
    w.players.get_mut("a").unwrap().state.action = "dead";
    w.tick = 10;
    w.step_monsters();
    {
        let mob = &w.monsters[&monster_id];
        assert!(mob.aggro_target.is_none());
        assert!(mob.returning_home);
    }
    // Same window, but the target left the map: also forgotten.
    let monster_id2 = w.monsters.keys().next().cloned().unwrap();
    {
        let mob = w.monsters.get_mut(&monster_id2).unwrap();
        mob.state.x = 200.0;
        mob.state.action = "move";
        mark_monster_hit_aggro(mob, "a", w.tick);
        assert!(mob.aggro_target.is_some());
    }
    w.players.get_mut("a").unwrap().map_id = "another-map".into();
    w.players.get_mut("a").unwrap().state.action = "stand";
    w.tick = 11;
    w.step_monsters();
    let mob = &w.monsters[&monster_id2];
    assert!(mob.aggro_target.is_none(), "off-map target is not pursued");
    assert!(mob.returning_home);
}

#[test]
fn monster_gives_up_when_target_flees_beyond_the_leash() {
    let mut w = World::new_with_gameplay(map(), 600, aggro_mob_gameplay(100.0));
    let _rx = join_test_player(&mut w, "a");
    let monster_id = w.monsters.keys().next().cloned().unwrap();
    {
        let player = w.players.get_mut("a").unwrap();
        player.map_id = "test".into();
        player.state.x = 300.0;
        player.state.y = 100.0;
    }
    {
        let mob = w.monsters.get_mut(&monster_id).unwrap();
        mob.state.x = 200.0;
        mob.state.y = 100.0;
        mob.state.action = "move";
        mob.state.action_started_tick = 0;
        mark_monster_hit_aggro(mob, "a", w.tick);
    }
    // The player runs off past the leash radius (spawn 100 + leash 900).
    w.players.get_mut("a").unwrap().state.x = 1100.0;
    w.tick = 3;
    w.step_monsters();
    {
        let mob = &w.monsters[&monster_id];
        assert!(mob.aggro_target.is_none(), "out-of-leash target is dropped");
        assert!(mob.returning_home);
        assert_eq!(mob.state.facing, -1);
    }
}

#[test]
fn player_damage_range_uses_source_stat_and_weapon_formula() {
    let config: PlayerConfig = serde_json::from_str(
            r#"{"job":0,"baseStr":4,"baseDex":4,"baseInt":4,"baseLuk":4,"weaponType":130,"weaponWatk":10}"#,
        )
        .unwrap();
    assert_eq!(config.attack_range(), (0, 2));
    assert!((0..=2).contains(&config.attack_damage()));
}

#[test]
fn attack_and_body_rectangles_mirror_and_overlap_like_wz() {
    let player: PlayerConfig =
        serde_json::from_str(r#"{"attackLt":{"x":-88,"y":-62},"attackRb":{"x":-18,"y":-6}}"#)
            .unwrap();
    assert_eq!(player.attack_bounds(-1), Some((-88.0, -18.0, -62.0, -6.0)));
    assert_eq!(player.attack_bounds(1), Some((18.0, 88.0, -62.0, -6.0)));

    let monster: MonsterTemplate = serde_json::from_str(
            r#"{"templateId":"100100","level":1,"maxHp":8,"PADamage":12,"exp":3,"bodyAttack":true,"hitboxLt":{"x":-18,"y":-26},"hitboxRb":{"x":19,"y":0}}"#,
        )
        .unwrap();
    assert_eq!(
        monster.body_bounds(100.0, 200.0),
        Some((82.0, 119.0, 174.0, 200.0))
    );
    let damage = PlayerConfig {
        base_str: Some(12),
        base_dex: Some(5),
        base_int: Some(4),
        base_luk: Some(4),
        weapon_defense: Some(3),
        ..PlayerConfig::default()
    }
    .contact_damage(&monster);
    assert_eq!(damage, Some(9));
    assert_eq!(PlayerConfig::default().contact_damage(&monster), Some(12));
    assert_eq!(
        PlayerConfig {
            weapon_defense: Some(100),
            ..PlayerConfig::default()
        }
        .contact_damage(&monster),
        Some(1)
    );
    let mut harmless = monster.clone();
    harmless.body_attack = false;
    assert_eq!(player.contact_damage(&harmless), None);
    harmless.body_attack = true;
    harmless.pa_damage = None;
    assert_eq!(player.contact_damage(&harmless), None);
}

#[test]
fn equipment_replaces_starter_stats_and_never_accumulates() {
    use crate::protocol::InventoryItem;
    let config = PlayerConfig {
        base_str: Some(4),
        base_dex: Some(4),
        weapon_type: Some(130),
        weapon_watk: Some(15),
        weapon_defense: Some(2),
        max_hp: Some(50),
        max_mp: Some(5),
        ..PlayerConfig::default()
    };
    let equipped = vec![
        InventoryItem {
            slot: 11,
            item_id: "1302000".into(),
            quantity: 1,
            ..InventoryItem::default()
        },
        InventoryItem {
            slot: 5,
            item_id: "1040002".into(),
            quantity: 1,
            ..InventoryItem::default()
        },
    ];
    let derived = config.with_equipment(&equipped, config.job.unwrap_or(0));
    assert_eq!(derived.weapon_watk, Some(15));
    assert_eq!(derived.weapon_defense, Some(2));
    assert_eq!(derived.attack_range(), config.attack_range());
    // The runtime role is authoritative even if the startup config still
    // describes another role (or no role at all).
    assert_eq!(config.with_equipment(&equipped, 200).job, Some(200));
    let mut upgraded = equipped.clone();
    upgraded[1].stats = Some(BTreeMap::from([
        ("incPDD".into(), 8),
        ("incMHP".into(), 10),
    ]));
    let upgraded_stats = config.with_equipment(&upgraded, config.job.unwrap_or(0));
    assert_eq!(upgraded_stats.weapon_defense, Some(8));
    assert_eq!(upgraded_stats.max_hp, Some(60));
    assert_eq!(
        config
            .with_equipment(&upgraded, config.job.unwrap_or(0))
            .max_hp,
        Some(60)
    );
    assert_eq!(
        config
            .with_equipment(&[], config.job.unwrap_or(0))
            .weapon_watk,
        Some(0)
    );
    assert_eq!(
        config.with_equipment(&[], config.job.unwrap_or(0)).max_hp,
        Some(50)
    );
}

/// A snail (contact box 82..119 at x=100) that body-attacks, with the given
/// player tenacity, on the shared test map.
fn contact_hit_world(tenacity: f64) -> World {
    // Use the real 273 player config: no weaponDefense or standardPdd.
    let mut gameplay = Gameplay::load(Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../shared/gameplay.json"
    )))
    .unwrap();
    gameplay.player.tenacity = Some(tenacity);
    let mut snail = gameplay
        .monsters
        .iter()
        .find(|mob| mob.template_id == "100000")
        .unwrap()
        .clone();
    snail.move_speed = Some(0.0);
    snail.drop = None; // This fixture exercises contact, not the drop table.
    World::new_with_gameplay(
        map(),
        600,
        Gameplay {
            player: gameplay.player,
            monsters: vec![snail],
            spawns: vec![MonsterSpawn {
                id: "s1".into(),
                template_id: "100000".into(),
                x: 100.0,
                y: 100.0,
                foothold_id: Some(1),
                map_id: String::new(),
                facing: 1,
                mob_time: 0,
                rx0: None,
                rx1: None,
            }],
            ..Gameplay::default()
        },
    )
}

#[test]
fn contact_hit_knocks_player_back_and_broadcasts_damage_event() {
    let mut w = contact_hit_world(0.0);
    let (output, mut rx) = mpsc::channel(128);
    let (reply, _) = oneshot::channel();
    w.command(Command::Join {
        identity: Identity {
            id: "a".into(),
            username: "alice".into(),
        },
        connection: "c".into(),
        output,
        reply,
        lang: "zh".to_owned(),
    });
    while rx.try_recv().is_ok() {}
    // Stand the player inside the snail's contact box (x 82..119 around a
    // monster centred at x=100), to the monster's right side.
    {
        let player = w.players.get_mut("a").unwrap();
        player.state.x = 118.0;
        player.state.y = 100.0;
        player.state.grounded = true;
        player.state.hp = 50;
        player.state.action = "stand";
        player.foothold_id = 1;
        player.last_foothold_id = 1;
        player.contact_invulnerable_until = 0;
    }
    {
        let monster = w.monsters.values_mut().next().unwrap();
        monster.state.x = 100.0;
        monster.state.y = 100.0;
        monster.state.action = "stand";
        monster.horizontal_speed = 0.0;
    }
    let map_id = w.players["a"].map_id.clone();
    w.monsters.values_mut().next().unwrap().map_id = "other-map".into();
    w.apply_contact_damage();
    assert_eq!(
        w.players["a"].state.hp, 50,
        "another map cannot cause contact damage"
    );
    w.monsters.values_mut().next().unwrap().map_id = map_id;
    w.pending_attacks.insert(
        "interrupted".into(),
        PendingAttack {
            player_id: "a".into(),
            request_id: "attack-before-hit".into(),
            action_id: "interrupted".into(),
            hit_tick: w.tick + 10,
        },
    );
    let start_x = w.players["a"].state.x;
    let start_tick = w.tick;
    w.step();
    let p = &w.players["a"];
    assert_eq!(p.state.hp, 49, "contact damage applies once");
    assert!(
        w.pending_attacks.is_empty(),
        "hit cancels unresolved attacks"
    );
    assert_eq!(p.knockback_until, start_tick + 1 + KNOCKBACK_TICKS);
    // The hit starts a short hop: the body leaves the foothold with the
    // tenacity-0 impulse and shows the jump pose while airborne.
    assert_eq!(
        p.knockback_vx, KNOCKBACK_SPEED,
        "pushed away from the monster"
    );
    assert_eq!(p.state.vy, -KNOCKBACK_JUMP);
    assert_eq!(p.state.action, "jump");
    assert!(!p.state.grounded);
    let mut saw_damage_event = false;
    let monster_id = w.monsters.keys().next().cloned().unwrap();
    while let Ok(line) = rx.try_recv() {
        let message: serde_json::Value = serde_json::from_str(&line).unwrap();
        if message["type"] == "damageEvent" && message["targetId"] == "a" {
            saw_damage_event = true;
            assert_eq!(message["damage"], 1);
            assert_eq!(message["killed"], false);
            assert_eq!(message["attackerId"].as_str(), Some(monster_id.as_str()));
        }
    }
    assert!(
        saw_damage_event,
        "player damage is broadcast for the hurt flash"
    );
    w.apply_contact_damage();
    assert_eq!(
        w.players["a"].state.hp, 49,
        "same-tick contact cannot charge twice"
    );
    assert!(
        rx.try_recv().is_err(),
        "invulnerable contact emits no duplicate event"
    );
    // The hop lands a short distance away and stands again: no long ground
    // slide, and no repeated contact damage while invulnerable.
    for _ in 0..12 {
        w.step();
    }
    let travelled = w.players["a"].state.x - start_x;
    assert!(
        travelled > 5.0 && travelled < 90.0,
        "hop travelled a short controlled distance: {travelled}"
    );
    assert!(w.players["a"].state.grounded);
    assert_eq!(w.players["a"].state.hp, 49);
    assert_eq!(w.players["a"].state.action, "stand");
    // At the exact invulnerability deadline a new collision can kill.
    w.tick = w.players["a"].contact_invulnerable_until;
    let player = w.players.get_mut("a").unwrap();
    player.state.x = 118.0;
    player.state.y = 100.0;
    player.state.hp = 1;
    w.apply_contact_damage();
    assert_eq!(w.players["a"].state.hp, 0);
    assert_eq!(w.players["a"].state.action, "dead");
    assert_eq!(w.players["a"].knockback_vx, 0.0);
}

#[test]
fn tenacity_scales_down_the_knockback_hop() {
    let mut w = contact_hit_world(0.5);
    let (output, mut rx) = mpsc::channel(128);
    let (reply, _) = oneshot::channel();
    w.command(Command::Join {
        identity: Identity {
            id: "a".into(),
            username: "alice".into(),
        },
        connection: "c".into(),
        output,
        reply,
        lang: "zh".to_owned(),
    });
    while rx.try_recv().is_ok() {}
    {
        let player = w.players.get_mut("a").unwrap();
        player.state.x = 118.0;
        player.state.y = 100.0;
        player.state.grounded = true;
        player.state.hp = 50;
        player.state.action = "stand";
        player.foothold_id = 1;
        player.last_foothold_id = 1;
        player.contact_invulnerable_until = 0;
    }
    {
        let monster = w.monsters.values_mut().next().unwrap();
        monster.state.x = 100.0;
        monster.state.y = 100.0;
        monster.state.action = "stand";
        monster.horizontal_speed = 0.0;
    }
    let start_x = w.players["a"].state.x;
    w.step();
    let p = &w.players["a"];
    // Tenacity 0.5 halves both the horizontal push and the hop height/time
    // (LoL-style reduction), so the same hit barely budges the player.
    assert_eq!(p.knockback_vx, KNOCKBACK_SPEED * 0.5);
    assert_eq!(p.state.vy, -(KNOCKBACK_JUMP * 0.5));
    for _ in 0..12 {
        w.step();
    }
    let travelled = w.players["a"].state.x - start_x;
    assert!(
        travelled < 45.0,
        "high tenacity keeps the hop short: {travelled}"
    );
    assert_eq!(w.players["a"].state.hp, 49);
    assert_eq!(w.players["a"].state.action, "stand");
}

#[test]
fn quest_consume_items_accepts_array_and_boolean_forms() {
    let mut spec = QuestSpec::default();
    spec.complete.conditions.items = vec![QuestItemRequirement {
        item_id: "4000000".into(),
        quantity: 2,
    }];
    spec.complete.consume_items = serde_json::json!([{"itemId":"4000001","quantity":3}]);
    let items = quest_rules::consume_items(&spec);
    assert_eq!(items.len(), 1);
    assert_eq!((&*items[0].item_id, items[0].quantity), ("4000001", 3));
    for empty in [serde_json::json!([]), serde_json::json!(false)] {
        spec.complete.consume_items = empty;
        assert!(quest_rules::consume_items(&spec).is_empty());
    }
    for fallback in [serde_json::json!(true), serde_json::Value::Null] {
        spec.complete.consume_items = fallback;
        let items = quest_rules::consume_items(&spec);
        assert_eq!((&*items[0].item_id, items[0].quantity), ("4000000", 2));
    }
}

// Localization/transition unit fixtures are independent of the active content edition.
fn quest_test_text() -> crate::quest_text::QuestTextCorpus {
    serde_json::from_str(r#"{"quests": {"1021": {"name": {"en": "Roger's Apple", "zh": "罗杰的苹果"}, "log": {"zh": "前往冒险岛路与罗杰对话，使用他给你的罗杰的苹果恢复 HP 到满值。", "en": "Talk to Roger on Maple Road. Use the Roger's Apple he hands you and recover your HP to full."}}, "maple-road-training": {"name": {"en": "Training Camp Check", "zh": "训练营任务确认"}, "log": {"zh": "赛拉让你在离开营地前，先让希娜确认你的训练记录。", "en": "Sera asked you to let Heena confirm your training record before you leave the camp."}}}}"#).unwrap()
}

fn quest_profile() -> Profile {
    Profile {
        hp: 50,
        max_hp: 50,
        mp: 5,
        max_mp: 5,
        level: 1,
        job: 0,
        exp: 0,
        exp_to_next: 15,
        mesos: 0,
        cash: 0,
        death_id: String::new(),
        map_id: String::new(),
        x: 0.0,
        y: 0.0,
        inventory: Vec::new(),
        skills: BTreeMap::new(),
        skill_points: BTreeMap::new(),
        ability_stats: AbilityStats::default(),
    }
}

/// Join a fresh player against a store-backed world and return the parsed
/// messages the world pushed (snapshot + questList, in that order).
fn join_for_quests(
    store: auth::Store,
    account: &str,
    lang: &str,
    quests: &[(&str, &str)],
) -> (World, mpsc::Receiver<String>) {
    join_for_quests_with_gameplay(store, account, lang, quests, Gameplay::default())
}

fn join_for_quests_with_gameplay(
    store: auth::Store,
    account: &str,
    lang: &str,
    quests: &[(&str, &str)],
    gameplay: Gameplay,
) -> (World, mpsc::Receiver<String>) {
    store.load_profile(account, &quest_profile()).unwrap();
    for (quest_id, status) in quests {
        store.save_quest(account, quest_id, status).unwrap();
    }
    let mut world = World::new_with_store(map(), 600, gameplay, store)
        .unwrap()
        .with_quest_text(quest_test_text());
    let (output, rx) = mpsc::channel(128);
    let (reply, _) = oneshot::channel();
    world.command(Command::Join {
        identity: Identity {
            id: account.into(),
            username: "alice".into(),
        },
        connection: "c".into(),
        output,
        reply,
        lang: lang.to_owned(),
    });
    (world, rx)
}

fn quest_reward_gameplay() -> Gameplay {
    let mut gameplay = Gameplay::default();
    gameplay.exp_table = vec![15];
    gameplay.quests = vec![
        QuestSpec {
            quest_id: "maple-road-training".into(),
            executable: Some(true),
            reward: QuestReward {
                mesos: 300,
                exp: 0,
                items: vec![],
            },
            ..QuestSpec::default()
        },
        QuestSpec {
            quest_id: "1021".into(),
            executable: Some(true),
            reward: QuestReward {
                mesos: 0,
                exp: 10,
                items: vec![
                    QuestRewardItem {
                        item_id: "2010000".into(),
                        quantity: 3,
                    },
                    QuestRewardItem {
                        item_id: "2010009".into(),
                        quantity: 3,
                    },
                ],
            },
            ..QuestSpec::default()
        },
    ];
    gameplay
}

include!("chapter_acceptance.rs");
include!("continuation_acceptance.rs");
include!("quest_service_acceptance.rs");
include!("chapter_route_acceptance.rs");
include!("combat_feedback_acceptance.rs");
include!("content_boot_acceptance.rs");
include!("third_acceptance.rs");
include!("boss_acceptance.rs");
include!("hyper_acceptance.rs");
include!("water_acceptance.rs");
include!("chat_acceptance.rs");
include!("sidewall_acceptance.rs");
include!("wave_acceptance.rs");
include!("realmaps.rs");
include!("away_acceptance.rs");
include!("reactor_acceptance.rs");
include!("shop_buy_acceptance.rs");
include!("shop_sell_acceptance.rs");
include!("shop_rebuy_acceptance.rs");
include!("consume_acceptance.rs");
include!("scroll_acceptance.rs");
include!("storage_acceptance.rs");
include!("party_acceptance.rs");
include!("friend_acceptance.rs");
include!("whisper_acceptance.rs");
include!("emoticon_acceptance.rs");
include!("monster_status_acceptance.rs");
include!("slot_expand_acceptance.rs");
include!("mob_move_acceptance.rs");
include!("gm_acceptance.rs");
include!("pet_acceptance.rs");
include!("pet_growth_acceptance.rs");
include!("cashshop_acceptance.rs");
include!("ship_acceptance.rs");
include!("ship_event_acceptance.rs");
include!("ellinel_acceptance.rs");
include!("helios_acceptance.rs");
include!("ufo_acceptance.rs");
include!("edelstein_acceptance.rs");
include!("inventory_persistence_acceptance.rs");
include!("pickup_sink_acceptance.rs");
include!("npc_click_acceptance.rs");
include!("npc_teleport_acceptance.rs");
include!("damage_pipeline_acceptance.rs");
include!("attribute_acceptance.rs");
// 转职任务（2026-09-21）：事务层（真实 SQLite）＋ 对话层（store-less World）。
include!("job_advance_acceptance.rs");
// 战斗机制纵深（2026-09-22 第十三轮）：召唤物 / DoT / 投射物 / 二段命中，
// 以及四者在世界拍里的**结算优先级**。
include!("mechanics_acceptance.rs");
// 火毒／主教四转「同一格副本」接线（2026-09-23）：楓葉祝福 / 魔力無限 / 楓葉淨化 /
// 召喚火魔 与冰雷那几条同机制，收口成表之后副本也必须真的能放出来。
include!("mage_branch_copy_acceptance.rs");

#[test]
fn quest_list_on_join_is_localized_to_player_language() {
    let path = std::env::temp_dir().join(format!("maple-quest-i18n-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).unwrap();
    let (world, mut rx) = join_for_quests(
        service.store.clone(),
        "a",
        "en",
        &[("1021", "active"), ("maple-road-training", "completed")],
    );
    assert_eq!(world.players["a"].lang, "en");

    let snapshot: serde_json::Value =
        serde_json::from_str(&rx.try_recv().expect("join snapshot")).unwrap();
    assert_eq!(snapshot["type"], "snapshot");
    let list: serde_json::Value =
        serde_json::from_str(&rx.try_recv().expect("quest list after join")).unwrap();
    assert_eq!(list["type"], "questList");
    let quests = list["quests"].as_array().expect("quests array");
    assert_eq!(quests.len(), 2);
    let by_id = |id: &str| {
        quests
            .iter()
            .find(|entry| entry["questId"] == id)
            .expect(id)
            .clone()
    };
    // English locale: English text straight from the corpus.
    let apple = by_id("1021");
    assert_eq!(apple["name"], "Roger's Apple");
    assert_eq!(apple["status"], "active");
    assert_eq!(
            apple["summary"],
            "Talk to Roger on Maple Road. Use the Roger's Apple he hands you and recover your HP to full."
        );
    let training = by_id("maple-road-training");
    assert_eq!(training["name"], "Training Camp Check");
    assert_eq!(training["status"], "completed");
}

#[test]
fn quest_list_defaults_to_zh_when_locale_absent_or_unknown() {
    let path = std::env::temp_dir().join(format!("maple-quest-zh-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).unwrap();
    let (_, mut rx) = join_for_quests(service.store.clone(), "a", "zh", &[("1021", "active")]);
    let _: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
    let list: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
    assert_eq!(list["type"], "questList");
    let entry = &list["quests"][0];
    assert_eq!(entry["questId"], "1021");
    assert_eq!(entry["name"], "罗杰的苹果");
    assert_eq!(
        entry["summary"],
        "前往冒险岛路与罗杰对话，使用他给你的罗杰的苹果恢复 HP 到满值。"
    );
}

#[test]
fn tms273_missing_script_cannot_change_quest_state() {
    let path = std::env::temp_dir().join(format!(
        "maple-quest-disabled-{}.sqlite3",
        auth::random_id()
    ));
    let service = auth::start(&path).unwrap();
    let mut gameplay = Gameplay::default();
    gameplay.quests.push(QuestSpec {
        quest_id: "36301".into(),
        executable: Some(false),
        ..QuestSpec::default()
    });
    let (mut world, mut rx) =
        join_for_quests_with_gameplay(service.store.clone(), "a", "zh", &[], gameplay);
    while rx.try_recv().is_ok() {}
    world.apply_quest_effect("a", npc::QuestEffect::Start("36301".into()));
    let result: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
    assert_eq!(result["code"], "quest_script_unavailable");
    assert!(!world.players["a"].quests.contains_key("36301"));
    assert!(!service
        .store
        .load_quests("a")
        .unwrap()
        .contains_key("36301"));
}

#[test]
fn quest_transitions_push_localized_quest_update_with_settled_reward() {
    let path =
        std::env::temp_dir().join(format!("maple-quest-update-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).unwrap();
    let (world, mut rx) = join_for_quests_with_gameplay(
        service.store.clone(),
        "a",
        "zh",
        &[],
        quest_reward_gameplay(),
    );
    // Drain the join snapshot + empty questList.
    while rx.try_recv().is_ok() {}

    let mut world = world;
    world.apply_quest_effect("a", npc::QuestEffect::Start("maple-road-training".into()));
    let accepted: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
    assert_eq!(accepted["type"], "questUpdate");
    assert_eq!(accepted["questId"], "maple-road-training");
    assert_eq!(accepted["status"], "objectivesComplete");
    assert_eq!(accepted["name"], "训练营任务确认");
    assert_eq!(
        accepted["summary"],
        "赛拉让你在离开营地前，先让希娜确认你的训练记录。"
    );
    assert_eq!(accepted["reward"]["mesos"], 0);
    while rx.try_recv().is_ok() {} // Full log/snapshot follow the transition.

    world.apply_quest_effect(
        "a",
        npc::QuestEffect::Complete("maple-road-training".into()),
    );
    let completed: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
    assert_eq!(completed["type"], "questUpdate");
    assert_eq!(completed["questId"], "maple-road-training");
    assert_eq!(completed["status"], "completed");
    assert_eq!(completed["name"], "训练营任务确认");
    // Reward reflects exactly what the server settled (300 mesos).
    assert_eq!(completed["reward"]["mesos"], 300);
    assert_eq!(world.players["a"].state.mesos, 300);
}

#[test]
fn quest_completion_grants_configured_exp_and_items() {
    let path = std::env::temp_dir().join(format!(
        "maple-quest-complete-{}.sqlite3",
        auth::random_id()
    ));
    let service = auth::start(&path).unwrap();
    let (world, mut rx) = join_for_quests_with_gameplay(
        service.store.clone(),
        "a",
        "zh",
        &[],
        quest_reward_gameplay(),
    );
    // Drain the join snapshot + empty questList.
    while rx.try_recv().is_ok() {}

    let mut world = world;
    world.apply_quest_effect("a", npc::QuestEffect::Start("1021".into()));
    let accepted: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
    assert_eq!(accepted["status"], "objectivesComplete");
    while rx.try_recv().is_ok() {}

    world.apply_quest_effect("a", npc::QuestEffect::Complete("1021".into()));
    let completed: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
    assert_eq!(completed["status"], "completed");
    assert_eq!(completed["reward"]["exp"], 10);
    assert_eq!(completed["reward"]["mesos"], 0);
    let reward_items = completed["reward"]["items"]
        .as_array()
        .expect("reward items");
    assert_eq!(reward_items.len(), 2);
    let mut rewards = reward_items
        .iter()
        .map(|item| {
            (
                item["itemId"].as_str().expect("item id"),
                item["quantity"].as_u64().expect("item qty"),
            )
        })
        .collect::<Vec<_>>();
    rewards.sort_by(|a, b| a.0.cmp(b.0));
    assert_eq!(rewards[0], ("2010000", 3));
    assert_eq!(rewards[1], ("2010009", 3));
    assert_eq!(world.players["a"].state.exp, 10);
    assert_eq!(world.players["a"].state.exp_to_next, 15);
    let item_total = |id| {
        world.players["a"]
            .state
            .inventory
            .iter()
            .find(|item| item.item_id == id)
            .map(|item| item.quantity)
            .unwrap_or_default()
    };
    assert_eq!(item_total("2010000"), 3);
    assert_eq!(item_total("2010009"), 3);
}

fn mage_gameplay() -> Gameplay {
    let script: npc::DialogueScript = serde_json::from_str(
            r#"{"start":"choose","nodes":{
                "choose":{"menu":{"text":{"zh":"请选择职业。","en":"Choose a job."},"options":[{"index":0,"text":{"zh":"法师","en":"Magician"},"next":"advance"}]}},
                "advance":{"act":{"kind":"jobAdvance","fromJob":0,"job":200,"next":"advanced"}},
                "advanced":{"say":{"text":{"zh":"转职成功！你现在是一名法师了。","en":"Job advancement complete!"},"kind":"ok"}}}}"#,
        )
        .unwrap();
    Gameplay {
        npcs: vec![NpcTemplate {
            template_id: CROSSROAD_ADVANCE_TEMPLATE_ID.into(),
            name: "Grendel".into(),
            func: "Magician instructor".into(),
            shop_id: None,
            script: Some(script),
            stand: Vec::new(),
        }],
        npc_spawns: vec![NpcSpawn {
            id: CROSSROAD_ADVANCE_NPC_ID.into(),
            template_id: CROSSROAD_ADVANCE_TEMPLATE_ID.into(),
            x: 100.0,
            y: 0.0,
            foothold_id: Some(1),
            map_id: CROSSROAD_ADVANCE_MAP_ID.into(),
            facing: -1,
        }],
        ..Gameplay::default()
    }
}

fn mage_map() -> Map {
    let mut map = map();
    map.id = CROSSROAD_ADVANCE_MAP_ID.into();
    map.spawn = Point { x: 100.0, y: 0.0 };
    map
}

#[test]
fn mage_job_advance_is_menu_bound_authorized_and_persisted() {
    let path =
        std::env::temp_dir().join(format!("maple-mage-transfer-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).unwrap();
    let mut beginner = quest_profile();
    beginner.hp = 37;
    beginner.mp = 4;
    beginner.skills.insert(SKILL_RECOVERY, 1);
    beginner.skill_points.insert(BEGINNER_BOOK, 5);
    beginner.level = 8;
    service.store.load_profile("beginner", &beginner).unwrap();
    service.store.save_profile("beginner", &beginner).unwrap();
    let mut magician = quest_profile();
    magician.job = MAGICIAN_JOB;
    service.store.load_profile("magician", &magician).unwrap();
    let mut other = quest_profile();
    other.job = 220;
    service.store.load_profile("other", &other).unwrap();
    service
        .store
        .load_profile(
            "beginner2",
            &Profile {
                level: 7,
                ..quest_profile()
            },
        )
        .unwrap();

    let mut world =
        World::new_with_store(mage_map(), 600, mage_gameplay(), service.store.clone()).unwrap();
    let join = |world: &mut World, account: &str, connection: &str| {
        let (output, rx) = mpsc::channel(128);
        let (reply, _) = oneshot::channel();
        world.command(Command::Join {
            identity: Identity {
                id: account.into(),
                username: account.into(),
            },
            connection: connection.into(),
            output,
            reply,
            lang: "zh".into(),
        });
        rx
    };
    let mut beginner_rx = join(&mut world, "beginner", "beginner-1");
    let mut beginner2_rx = join(&mut world, "beginner2", "beginner2-1");
    let mut magician_rx = join(&mut world, "magician", "magician-1");
    let mut other_rx = join(&mut world, "other", "other-1");
    while beginner_rx.try_recv().is_ok() {}
    while beginner2_rx.try_recv().is_ok() {}
    while magician_rx.try_recv().is_ok() {}
    while other_rx.try_recv().is_ok() {}

    let marker = |snapshot: &str| {
        let value: serde_json::Value = serde_json::from_str(snapshot).unwrap();
        value["npcs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|npc| npc["id"] == CROSSROAD_ADVANCE_NPC_ID)
            .unwrap()
            .get("jobAdvancementAvailable")
            .cloned()
    };
    assert_eq!(
        marker(&world.snapshot("beginner")),
        Some(serde_json::Value::Bool(true))
    );
    assert_eq!(marker(&world.snapshot("beginner2")), None);
    assert_eq!(
        marker(&world.snapshot("magician")),
        Some(serde_json::Value::Bool(true))
    );
    assert_eq!(
        marker(&world.snapshot("other")),
        Some(serde_json::Value::Bool(true))
    );

    // The 选择岔道 magician instructor has no talk range: a beginner far
    // away still gets the menu, and only the death guard can refuse.
    world.players.get_mut("beginner").unwrap().state.x = 250.0;
    world.handle_npc_talk(
        "beginner".into(),
        "far".into(),
        CROSSROAD_ADVANCE_NPC_ID.into(),
        Some("start"),
        None,
    );
    let far: serde_json::Value = serde_json::from_str(&beginner_rx.try_recv().unwrap()).unwrap();
    assert_eq!(far["type"], "npcResult");
    assert_eq!(far["dialog"]["kind"], "simple");
    assert_eq!(world.players["beginner"].state.job, BEGINNER_JOB);
    world.end_conversation("beginner");

    world.players.get_mut("beginner").unwrap().state.x = 100.0;
    world.handle_npc_talk(
        "beginner".into(),
        "no-session".into(),
        CROSSROAD_ADVANCE_NPC_ID.into(),
        Some("select"),
        Some(0),
    );
    let no_session: serde_json::Value =
        serde_json::from_str(&beginner_rx.try_recv().unwrap()).unwrap();
    assert_eq!(no_session["code"], "npc_step_invalid");
    assert_eq!(world.players["beginner"].state.job, BEGINNER_JOB);

    world.players.get_mut("beginner").unwrap().state.hp = 0;
    world.players.get_mut("beginner").unwrap().state.action = "dead";
    assert_eq!(marker(&world.snapshot("beginner")), None);
    world.handle_npc_talk(
        "beginner".into(),
        "dead".into(),
        CROSSROAD_ADVANCE_NPC_ID.into(),
        Some("start"),
        None,
    );
    let dead: serde_json::Value = serde_json::from_str(&beginner_rx.try_recv().unwrap()).unwrap();
    assert_eq!(dead["code"], "job_advance_unavailable");
    world.players.get_mut("beginner").unwrap().state.hp = 37;
    world.players.get_mut("beginner").unwrap().state.action = "stand";

    world.handle_npc_talk(
        "beginner".into(),
        "open".into(),
        CROSSROAD_ADVANCE_NPC_ID.into(),
        Some("start"),
        None,
    );
    let menu: serde_json::Value = serde_json::from_str(&beginner_rx.try_recv().unwrap()).unwrap();
    assert_eq!(menu["dialog"]["kind"], "simple");
    assert_eq!(menu["dialog"]["options"][0]["text"], "法师");

    // A second beginner cannot continue the first player's menu session.
    world.handle_npc_talk(
        "beginner2".into(),
        "cross-player".into(),
        CROSSROAD_ADVANCE_NPC_ID.into(),
        Some("select"),
        Some(0),
    );
    let cross_player: serde_json::Value =
        serde_json::from_str(&beginner2_rx.try_recv().unwrap()).unwrap();
    assert_eq!(cross_player["code"], "npc_step_invalid");
    assert_eq!(world.players["beginner2"].state.job, BEGINNER_JOB);

    world.handle_npc_talk(
        "beginner".into(),
        "choose".into(),
        CROSSROAD_ADVANCE_NPC_ID.into(),
        Some("select"),
        Some(0),
    );
    let success: serde_json::Value =
        serde_json::from_str(&beginner_rx.try_recv().unwrap()).unwrap();
    assert_eq!(success["dialog"]["kind"], "ok");
    assert_eq!(success["dialog"]["text"], "转职成功！你现在是一名法师了。");
    assert_eq!(world.players["beginner"].state.job, MAGICIAN_JOB);
    let persisted = service
        .store
        .load_profile("beginner", &quest_profile())
        .unwrap();
    assert_eq!(persisted.job, MAGICIAN_JOB);
    assert_eq!(persisted.hp, 37);
    assert_eq!(persisted.mp, 100);
    assert_eq!(persisted.level, 8);
    assert_eq!(persisted.skills.get(&SKILL_RECOVERY), Some(&1));

    // A transferred magician receives a separate, idempotent training
    // menu.  The restore option only refills MP and never grants another
    // SP/hidden-skill bundle.
    world.handle_npc_talk(
        "beginner".into(),
        "training".into(),
        CROSSROAD_ADVANCE_NPC_ID.into(),
        Some("start"),
        None,
    );
    let training: serde_json::Value =
        serde_json::from_str(&beginner_rx.try_recv().unwrap()).unwrap();
    assert_eq!(training["dialog"]["options"][1]["text"], "恢复魔力");
    let sp_before_restore = service
        .store
        .load_profile("beginner", &quest_profile())
        .unwrap()
        .skill_points
        .get(&MAGE_BOOK)
        .copied();
    world.players.get_mut("beginner").unwrap().state.mp = 1;
    world.handle_npc_talk(
        "beginner".into(),
        "restore".into(),
        CROSSROAD_ADVANCE_NPC_ID.into(),
        Some("select"),
        Some(1),
    );
    let restore: serde_json::Value =
        serde_json::from_str(&beginner_rx.try_recv().unwrap()).unwrap();
    assert_eq!(restore["trainingResult"]["mp"], 100);
    assert_eq!(
        service
            .store
            .load_profile("beginner", &quest_profile())
            .unwrap()
            .job,
        MAGICIAN_JOB
    );
    assert_eq!(
        service
            .store
            .load_profile("beginner", &quest_profile())
            .unwrap()
            .skill_points
            .get(&MAGE_BOOK)
            .copied(),
        sp_before_restore
    );

    world.handle_npc_talk(
        "magician".into(),
        "already".into(),
        CROSSROAD_ADVANCE_NPC_ID.into(),
        Some("start"),
        None,
    );
    let already: serde_json::Value =
        serde_json::from_str(&magician_rx.try_recv().unwrap()).unwrap();
    assert_eq!(already["dialog"]["kind"], "simple");
    assert_eq!(already["dialog"]["options"][0]["text"], "打开法师技能");
    assert!(service
        .store
        .load_profile("magician", &quest_profile())
        .unwrap()
        .skill_points
        .get(&MAGE_BOOK)
        .is_none());
    world.handle_npc_talk(
        "magician".into(),
        "already-select".into(),
        CROSSROAD_ADVANCE_NPC_ID.into(),
        Some("select"),
        Some(0),
    );
    let already_selected: serde_json::Value =
        serde_json::from_str(&magician_rx.try_recv().unwrap()).unwrap();
    assert_eq!(already_selected["openSkills"], true);
    let supported = service
        .store
        .load_profile("magician", &quest_profile())
        .unwrap();
    assert_eq!(supported.skill_points.get(&MAGE_BOOK), Some(&5));
    assert_eq!(supported.skills.get(&SKILL_ELEMENTAL_WEAKEN), Some(&1));

    world.handle_npc_talk(
        "other".into(),
        "wrong-job".into(),
        CROSSROAD_ADVANCE_NPC_ID.into(),
        Some("start"),
        None,
    );
    let wrong_job: serde_json::Value = serde_json::from_str(&other_rx.try_recv().unwrap()).unwrap();
    assert_eq!(wrong_job["dialog"]["kind"], "simple");
    assert_eq!(wrong_job["dialog"]["options"][0]["text"], "打开法师技能");
    assert_eq!(world.players["other"].state.job, 220);

    world.command(Command::Leave {
        id: "beginner".into(),
        connection: "beginner-1".into(),
    });
    let beginner_rx = join(&mut world, "beginner", "beginner-2");
    let mut beginner_rx = beginner_rx;
    let reconnected: serde_json::Value =
        serde_json::from_str(&beginner_rx.try_recv().unwrap()).unwrap();
    assert_eq!(world.players["beginner"].state.job, MAGICIAN_JOB);
    assert_eq!(
        marker(&reconnected.to_string()),
        Some(serde_json::Value::Bool(true))
    );
}

/// 「選擇岔道」漢斯菜单的夹具，与 `scripts/assemble_tms273.cjs::FIRST_JOBS` 同形：
/// 一个 `choose` 节点带四个选项，各自指向 `advance-<job>`（一转的四个职业）。
fn first_job_gameplay() -> Gameplay {
    let mut nodes = serde_json::Map::new();
    let mut options = Vec::new();
    for (index, job) in crate::mage::FIRST_JOBS.iter().enumerate() {
        options.push(serde_json::json!({
            "index": index,
            "text": { "zh": job.to_string(), "en": job.to_string() },
            "next": format!("advance-{job}"),
        }));
        nodes.insert(
            format!("advance-{job}"),
            serde_json::json!({
                "act": {
                    "kind": "jobAdvance",
                    "fromJob": BEGINNER_JOB,
                    "job": job,
                    "next": format!("advanced-{job}"),
                },
            }),
        );
        nodes.insert(
            format!("advanced-{job}"),
            serde_json::json!({
                "say": {
                    "text": { "zh": format!("job-{job}"), "en": format!("job-{job}") },
                    "kind": "ok",
                },
            }),
        );
    }
    nodes.insert(
        "choose".to_owned(),
        serde_json::json!({
            "menu": {
                "text": { "zh": "choose", "en": "choose" },
                "options": options,
            },
        }),
    );
    let script: npc::DialogueScript = serde_json::from_value(serde_json::json!({
        "start": "choose",
        "nodes": nodes,
    }))
    .unwrap();
    Gameplay {
        npcs: vec![NpcTemplate {
            template_id: CROSSROAD_ADVANCE_TEMPLATE_ID.into(),
            name: "Hans".into(),
            func: "Explorer instructor".into(),
            shop_id: None,
            script: Some(script),
            stand: Vec::new(),
        }],
        npc_spawns: vec![NpcSpawn {
            id: CROSSROAD_ADVANCE_NPC_ID.into(),
            template_id: CROSSROAD_ADVANCE_TEMPLATE_ID.into(),
            x: 100.0,
            y: 0.0,
            foothold_id: Some(1),
            map_id: CROSSROAD_ADVANCE_MAP_ID.into(),
            facing: -1,
        }],
        ..Gameplay::default()
    }
}

/// 一转：四条探险家线共用「選擇岔道」漢斯这一个入口。
///
/// 三条物理线**只有**这一条通道（源 1401/1403/1404 在本包 `executable:false`，
/// 永远做不完），所以逐线跑一遍：门槛按线取（法师 8 级例外、物理三线 10 级），
/// 选谁就是谁，发的是**本线**那本书的起手点，且不凭空补法师专属的 MP 下限与
/// 隐藏伴随技能（见 `auth::grant_first_job_fields`）。
#[test]
fn crossroad_menu_grants_every_explorer_first_job_at_its_own_level() {
    for (index, job) in crate::mage::FIRST_JOBS.iter().copied().enumerate() {
        let is_mage = job == MAGICIAN_JOB;
        let floor = auth::first_job_level(job);
        assert_eq!(floor, if is_mage { 8 } else { 10 }, "一转门槛按线派生");

        for (suffix, level, granted) in [
            ("low", floor - 1, false),
            ("ok", floor, true),
        ] {
            let path = std::env::temp_dir().join(format!(
                "maple-first-job-{job}-{suffix}-{}.sqlite3",
                auth::random_id()
            ));
            let service = auth::start(&path).unwrap();
            let account = format!("first-job-{job}-{suffix}");
            let base = Profile {
                hp: 37,
                mp: 4,
                max_mp: 20,
                level,
                ..quest_profile()
            };
            service.store.load_profile(&account, &base).unwrap();
            service.store.save_profile(&account, &base).unwrap();

            let mut world = World::new_with_store(
                mage_map(),
                600,
                first_job_gameplay(),
                service.store.clone(),
            )
            .unwrap();
            let (output, mut rx) = mpsc::channel(128);
            let (reply, _) = oneshot::channel();
            world.command(Command::Join {
                identity: Identity {
                    id: account.clone(),
                    username: account.clone(),
                },
                connection: format!("{account}-1"),
                output,
                reply,
                lang: "zh".into(),
            });
            while rx.try_recv().is_ok() {}

            world.handle_npc_talk(
                account.clone(),
                "open".into(),
                CROSSROAD_ADVANCE_NPC_ID.into(),
                Some("start"),
                None,
            );
            let menu: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
            assert_eq!(
                menu["dialog"]["options"].as_array().unwrap().len(),
                crate::mage::FIRST_JOBS.len(),
                "菜单必须一次给出四条线"
            );

            world.handle_npc_talk(
                account.clone(),
                "pick".into(),
                CROSSROAD_ADVANCE_NPC_ID.into(),
                Some("select"),
                Some(index as u32),
            );
            let reply: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();

            let persisted = service.store.load_profile(&account, &base).unwrap();
            if !granted {
                assert_eq!(
                    reply["code"], "job_advance_unavailable",
                    "{job} 在 {level} 级不得转职"
                );
                assert_eq!(persisted.job, BEGINNER_JOB, "{job} 未达门槛却转了职");
                continue;
            }
            assert_eq!(reply["dialog"]["kind"], "ok", "{job} 应当转职成功");
            assert_eq!(persisted.job, job, "转职必须落到选中的那条线");
            assert_eq!(world.players[&account].state.job, job, "世界侧同步职业");
            // 起手点发在**本线的一转书**上（书号 == 职业号）。
            assert_eq!(
                persisted.skill_points.get(&job).copied(),
                Some(5),
                "{job} 应拿到本线一转发起手点"
            );
            if is_mage {
                assert_eq!(persisted.mp, 100, "法师保留 100 MP 下限");
                assert_eq!(persisted.skills.get(&2_000_007), Some(&1));
                assert_eq!(persisted.skills.get(&2_001_012), Some(&1));
            } else {
                // 物理线不补法师专属的两项：MP 不动，也没有凭空多出来的技能。
                assert_eq!(persisted.mp, 4, "物理线不设 MP 下限");
                assert_eq!(persisted.max_mp, 20, "物理线不设 MP 上限");
                assert!(persisted.skills.is_empty(), "物理线不补伴随技能");
            }
        }
    }
}

#[test]
fn mage_skill_runtime_covers_learning_targets_replay_guard_teleport_and_wave() {
    let mut gameplay = life_gameplay(vec![
        life_spawn("mage-m1", "test", 140.0, 1, -1),
        life_spawn("mage-m2", "test", 160.0, 1, -1),
        life_spawn("mage-m3", "test", 180.0, 1, -1),
        life_spawn("mage-m4", "test", 200.0, 1, -1),
    ]);
    for template in &mut gameplay.monsters {
        template.max_hp = 1_000;
    }
    gameplay.player.base_int = Some(4);
    gameplay.player.base_luk = Some(1);
    gameplay.player.max_mp = Some(5);
    let mut world = World::new_with_gameplay(map(), 600, gameplay)
        .with_mage_skills(crate::mage::MageSkills::bundled());
    let (output, mut rx) = mpsc::channel(256);
    let (reply, _) = oneshot::channel();
    world.command(Command::Join {
        identity: Identity {
            id: "mage-runtime".into(),
            username: "mage-runtime".into(),
        },
        connection: "mage-runtime-connection".into(),
        output,
        reply,
        lang: "zh".into(),
    });
    while rx.try_recv().is_ok() {}
    let drain = |rx: &mut mpsc::Receiver<String>| {
        let mut values = Vec::new();
        while let Ok(message) = rx.try_recv() {
            values.push(serde_json::from_str::<serde_json::Value>(&message).unwrap());
        }
        values
    };

    {
        let player = world.players.get_mut("mage-runtime").unwrap();
        player.state.job = MAGICIAN_JOB;
        player.base_max_mp = 100;
        player.state.level = 1;
        player.state.hp = 50;
        player.state.max_hp = 50;
        player.state.mp = 100;
        player.state.skills = BTreeMap::from([
            (SKILL_MAGIC_BOOST, 1),
            (SKILL_ELEMENTAL_WEAKEN, 1),
            (SKILL_MAGIC_SHIELD, 1),
            (SKILL_MAGIC_WAVE_HIDDEN, 1),
        ]);
        player.state.skill_points = BTreeMap::from([(MAGE_BOOK, 5)]);
        player.state.x = 100.0;
        player.state.y = 100.0;
        player.state.grounded = true;
        player.state.action = "stand";
        player.foothold_id = 1;
        player.last_foothold_id = 1;
        refresh_player_derived(&world.gameplay, &world.mage_skills, player);
    }
    let initial_magic_attack = world.players["mage-runtime"]
        .state
        .derived_stats
        .magic_attack;
    let initial_max_mp = world.players["mage-runtime"].state.max_mp;
    let initial_mp = world.players["mage-runtime"].state.mp;
    assert!(initial_magic_attack > 0);
    assert_eq!(
        world.players["mage-runtime"].state.derived_stats.strength,
        Some(12)
    );
    assert_eq!(
        world.players["mage-runtime"]
            .state
            .derived_stats
            .intelligence,
        Some(4)
    );
    assert_eq!(
        world.players["mage-runtime"].state.derived_stats.luck,
        Some(4)
    );
    assert!(initial_max_mp >= 126);

    let learn = |world: &mut World, rx: &mut mpsc::Receiver<String>, request_id: &str, skill_id| {
        world.handle_learn_skill("mage-runtime".into(), request_id.into(), skill_id);
        let value: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(value["type"], "skillResult");
        assert_eq!(value["success"], true);
    };
    learn(&mut world, &mut rx, "learn-energy", SKILL_ENERGY_BOLT);
    learn(&mut world, &mut rx, "learn-guard", SKILL_MAGIC_GUARD);
    learn(&mut world, &mut rx, "learn-teleport", SKILL_TELEPORT);
    learn(&mut world, &mut rx, "learn-wave", SKILL_MAGIC_WAVE);
    assert_eq!(
        world.players["mage-runtime"].state.skill_points[&MAGE_BOOK],
        1
    );

    world.handle_cast_skill(
        "mage-runtime".into(),
        "bolt-1".into(),
        SKILL_ENERGY_BOLT,
        Some(1),
        Some(0),
    );
    let first_cast = drain(&mut rx);
    let skill_cast = first_cast
        .iter()
        .find(|value| value["type"] == "skillCast")
        .expect("energy skillCast");
    assert_eq!(skill_cast["playerId"], "mage-runtime");
    assert_eq!(skill_cast["targetId"].as_str().is_some(), true);
    assert!(skill_cast["targetX"].is_number());
    assert!(skill_cast["targetY"].is_number());
    let damage_events = first_cast
        .iter()
        .filter(|value| value["type"] == "damageEvent")
        .collect::<Vec<_>>();
    assert_eq!(
        damage_events.len(),
        16,
        "four targets and four source segments"
    );
    assert!(damage_events.iter().all(|event| {
        event["skillId"] == SKILL_ENERGY_BOLT
            && event["targetCount"] == 4
            && event["segment"]
                .as_u64()
                .is_some_and(|segment| (1..=4).contains(&segment))
    }));
    let mp_after_first_cast = world.players["mage-runtime"].state.mp;
    assert_eq!(mp_after_first_cast, initial_mp - 16);

    world.handle_cast_skill(
        "mage-runtime".into(),
        "bolt-1".into(),
        SKILL_ENERGY_BOLT,
        Some(1),
        Some(0),
    );
    let replay = drain(&mut rx);
    assert_eq!(
        replay.len(),
        1,
        "a resolved cast replay only returns its result"
    );
    assert_eq!(replay[0]["success"], true);
    assert_eq!(world.players["mage-runtime"].state.mp, mp_after_first_cast);

    let equipped_wand = crate::protocol::InventoryItem {
        slot: 11,
        item_id: "1372000".into(),
        quantity: 1,
        stats: Some(BTreeMap::from([
            ("incINT".into(), 5),
            ("incMMP".into(), 10),
        ])),
        ..crate::protocol::InventoryItem::default()
    };
    {
        let player = world.players.get_mut("mage-runtime").unwrap();
        player.state.equipped = vec![equipped_wand];
        refresh_player_derived(&world.gameplay, &world.mage_skills, player);
    }
    // 1372000 现在有 TMS273 源定义（魔法森林武器店 1031000 售卖），派生魔力攻击
    // 由两部分构成：装备实例上的卷轴 inline 加成（incINT 5 → INT*4 = +20）和该
    // 武器自身的源 `incMAD`（公式见 `derived.rs` 的 `bonus("incMAD")`）。
    let wand_mad = inventory::equipment_attributes("1372000")
        .get("incMAD")
        .copied()
        .unwrap_or(0);
    assert_eq!(
        world.players["mage-runtime"]
            .state
            .derived_stats
            .magic_attack,
        initial_magic_attack + 20 + wand_mad
    );
    assert_eq!(
        world.players["mage-runtime"].state.max_mp,
        initial_max_mp + 10
    );
    assert!(world.players["mage-runtime"].move_speed > WALK_SPEED);
    {
        let player = world.players.get_mut("mage-runtime").unwrap();
        player.state.equipped.clear();
        refresh_player_derived(&world.gameplay, &world.mage_skills, player);
    }

    world.handle_cast_skill(
        "mage-runtime".into(),
        "guard-on".into(),
        SKILL_MAGIC_GUARD,
        Some(0),
        Some(0),
    );
    let guard_result = drain(&mut rx)
        .into_iter()
        .find(|value| value["type"] == "skillResult")
        .expect("guard result");
    assert_eq!(guard_result["success"], true);
    assert!(world.players["mage-runtime"].magic_guard);
    assert!(
        world.players["mage-runtime"]
            .state
            .derived_stats
            .magic_guard
    );
    let mp_before_contact = world.players["mage-runtime"].state.mp;
    {
        let monster = world.monsters.values_mut().next().unwrap();
        monster.template.body_attack = true;
        monster.template.pa_damage = Some(20);
    }
    {
        let monster_x = world.monsters.values().next().unwrap().state.x;
        let player = world.players.get_mut("mage-runtime").unwrap();
        player.state.x = monster_x;
        player.state.y = 100.0;
        player.state.grounded = true;
        player.state.action = "stand";
        player.foothold_id = 1;
        player.contact_invulnerable_until = 0;
    }
    let hp_before_contact = world.players["mage-runtime"].state.hp;
    // 源护盾 1 级给 10 PDD（pddX = 10*x），所以减伤后是 20 - 10 = 10。
    // 用户指定规则（2026-09-12）：1 级抵偿率 100%。护罩先接下受伤的 99%：
    // floor(10 * 99%) = 9 点接给 MP，floor(9 * 100%) = 9 点真由魔力化去（护盾无差额）；
    // 未被接下的那 1%（floor(10 * 1%) = 0）才落回 HP——所以 HP 一点不掉。
    let expected_mp_damage = 9.min(mp_before_contact);
    world.apply_contact_damage();
    assert_eq!(world.players["mage-runtime"].state.hp, hp_before_contact);
    assert_eq!(
        world.players["mage-runtime"].state.mp,
        mp_before_contact - expected_mp_damage
    );
    // 这一击 HP 一点不掉，但事件**仍然要广播**，而且蓝字那一份必须在里面。
    // 客户端曾经因为「`damage <= 0` 就整条丢弃」而一根数字都不画（2026-09-19 实玩：
    // MP 在掉、没有跳字）。判据因此钉在**广播出来的事件**上，而不是「HP 没掉就没事」
    // ——原来的写法 `while rx.try_recv().is_ok() {}` 把这条契约直接丢掉了。
    let contact = drain(&mut rx);
    let contact_event = contact
        .iter()
        .find(|message| message["type"] == "damageEvent" && message["targetId"] == "mage-runtime")
        .expect("护罩承伤必须广播 damageEvent（HP 那一份为 0 也不例外）");
    assert_eq!(contact_event["damage"], 0, "未被接下的 1% 向下取整为 0");
    assert_eq!(
        contact_event["mpDamage"], expected_mp_damage,
        "MP 那一份必须随事件发出去，客户端才有蓝字可画"
    );

    // 满级（10 级）抵偿率 80%：同一击接下 9 点，只化去 floor(9 * 80%) = 7 点，
    // 差额 2 点由护盾消解——既不扣 HP 也不扣 MP。HP 仍只承担那 1%（此处为 0）。
    {
        let player = world.players.get_mut("mage-runtime").unwrap();
        player.state.skills.insert(SKILL_MAGIC_GUARD, 10);
        player.contact_invulnerable_until = 0;
    }
    let hp_before_max_guard = world.players["mage-runtime"].state.hp;
    let mp_before_max_guard = world.players["mage-runtime"].state.mp;
    world.apply_contact_damage();
    assert_eq!(world.players["mage-runtime"].state.hp, hp_before_max_guard);
    assert_eq!(
        world.players["mage-runtime"].state.mp,
        mp_before_max_guard - 7
    );
    // 满级抵偿率 80% 的同一击：HP 那 1% 同样是 0，蓝字那一份是 7 点。
    let max_guard_contact = drain(&mut rx);
    let max_guard_event = max_guard_contact
        .iter()
        .find(|message| message["type"] == "damageEvent" && message["targetId"] == "mage-runtime")
        .expect("护罩承伤必须广播 damageEvent");
    assert_eq!(max_guard_event["damage"], 0);
    assert_eq!(max_guard_event["mpDamage"], 7);
    {
        let player = world.players.get_mut("mage-runtime").unwrap();
        player.state.skills.insert(SKILL_MAGIC_GUARD, 1);
    }

    world.handle_cast_skill(
        "mage-runtime".into(),
        "guard-off".into(),
        SKILL_MAGIC_GUARD,
        Some(0),
        Some(0),
    );
    let guard_off = drain(&mut rx)
        .into_iter()
        .find(|value| value["type"] == "skillResult")
        .expect("guard-off result");
    assert_eq!(guard_off["success"], true);
    assert!(
        !world.players["mage-runtime"]
            .state
            .derived_stats
            .magic_guard
    );

    {
        let player = world.players.get_mut("mage-runtime").unwrap();
        player.state.x = 100.0;
        player.state.y = 100.0;
        player.state.grounded = true;
        player.state.action = "stand";
        player.foothold_id = 1;
    }
    let mp_before_teleport = world.players["mage-runtime"].state.mp;
    world.handle_cast_skill(
        "mage-runtime".into(),
        "teleport-right".into(),
        SKILL_TELEPORT,
        Some(1),
        Some(0),
    );
    let teleport = drain(&mut rx)
        .into_iter()
        .find(|value| value["type"] == "skillResult")
        .expect("teleport result");
    assert_eq!(teleport["success"], true);
    assert!(world.players["mage-runtime"].state.x > 100.0);
    // 用户指定规则：瞬移全等级扣 10 MP（原版为 28→20）。
    assert_eq!(
        world.players["mage-runtime"].state.mp,
        mp_before_teleport - 10
    );
    // 冷却内不允许再次瞬移，且被拒时不扣 MP。
    world.handle_cast_skill(
        "mage-runtime".into(),
        "teleport-cooldown".into(),
        SKILL_TELEPORT,
        Some(1),
        Some(0),
    );
    let cooling = drain(&mut rx).into_iter().next().expect("cooldown result");
    assert_eq!(cooling["type"], "rejected");
    assert_eq!(cooling["code"], "skill_cooldown");
    assert_eq!(
        world.players["mage-runtime"].state.mp,
        mp_before_teleport - 10
    );
    assert_eq!(
        world.players["mage-runtime"]
            .skill_cooldowns
            .get(&SKILL_TELEPORT)
            .copied(),
        Some(800)
    );
    // 等级越高冷却越短：5 级为 50ms（P 值，见覆盖表）。
    {
        let player = world.players.get_mut("mage-runtime").unwrap();
        player.skill_cooldowns.remove(&SKILL_TELEPORT);
        player.state.skills.insert(SKILL_TELEPORT, 5);
    }
    let mp_before_level_five = world.players["mage-runtime"].state.mp;
    world.handle_cast_skill(
        "mage-runtime".into(),
        "teleport-level-five".into(),
        SKILL_TELEPORT,
        Some(1),
        Some(0),
    );
    let level_five = drain(&mut rx)
        .into_iter()
        .find(|value| value["type"] == "skillResult")
        .expect("level five teleport result");
    assert_eq!(level_five["success"], true);
    assert_eq!(
        world.players["mage-runtime"].state.mp,
        mp_before_level_five - 10
    );
    assert_eq!(
        world.players["mage-runtime"]
            .skill_cooldowns
            .get(&SKILL_TELEPORT)
            .copied(),
        Some(50)
    );
    {
        let player = world.players.get_mut("mage-runtime").unwrap();
        player.skill_cooldowns.remove(&SKILL_TELEPORT);
        player.state.skills.insert(SKILL_TELEPORT, 1);
    }
    {
        let player = world.players.get_mut("mage-runtime").unwrap();
        player.state.x = 475.0;
        player.state.y = 191.6666666667;
        player.state.grounded = true;
        player.state.action = "stand";
        player.foothold_id = 2;
    }
    let mp_before_blocked_teleport = world.players["mage-runtime"].state.mp;
    world.handle_cast_skill(
        "mage-runtime".into(),
        "teleport-blocked".into(),
        SKILL_TELEPORT,
        Some(1),
        Some(0),
    );
    let blocked = drain(&mut rx).into_iter().next().expect("blocked result");
    assert_eq!(blocked["type"], "rejected");
    assert_eq!(blocked["code"], "teleport_blocked");
    assert_eq!(
        world.players["mage-runtime"].state.mp,
        mp_before_blocked_teleport
    );

    {
        let player = world.players.get_mut("mage-runtime").unwrap();
        player.state.x = 100.0;
        player.state.y = 100.0;
        player.state.grounded = true;
        player.state.action = "stand";
        player.foothold_id = 1;
    }
    world.handle_cast_skill(
        "mage-runtime".into(),
        "wave-up".into(),
        SKILL_MAGIC_WAVE,
        Some(0),
        Some(-1),
    );
    let wave_up = drain(&mut rx)
        .into_iter()
        .find(|value| value["type"] == "skillResult")
        .expect("wave-up result");
    assert_eq!(wave_up["success"], true);
    assert!(world.players["mage-runtime"].magic_wave_used);
    assert!(!world.players["mage-runtime"].magic_wave_float_used);
    // The casted wave must climb 1.5x a normal jump and keep floating.
    let wave_launch = world.players["mage-runtime"].state.vy;
    assert!(
        (wave_launch.abs() - JUMP_SPEED * MAGIC_WAVE_LAUNCH_HEIGHT_RATIO.sqrt()).abs() < 1.0,
        "魔力波動 should launch at 1.5x the normal jump displacement"
    );
    assert!(world.players["mage-runtime"].slow_fall_until > world.tick);
    world.handle_cast_skill(
        "mage-runtime".into(),
        "wave-float".into(),
        SKILL_MAGIC_WAVE_HIDDEN,
        Some(0),
        Some(1),
    );
    let wave_messages = drain(&mut rx);
    let wave_float = wave_messages
        .iter()
        .find(|value| value["type"] == "skillResult")
        .expect("wave-float result");
    let wave_event = wave_messages
        .iter()
        .find(|value| value["type"] == "skillCast")
        .expect("wave-float event");
    assert_eq!(wave_float["success"], true);
    assert_eq!(wave_event["durationMs"], 5_000);
    assert!(world.players["mage-runtime"].magic_wave_float_used);
    assert!(world.players["mage-runtime"].slow_fall_until > world.tick);
    assert_eq!(world.players["mage-runtime"].state.action, "jump");
}

#[test]
fn world_growth_and_allocate_ap_are_personal_and_idempotent() {
    let mut world = World::new(map(), 600);
    let (output, mut rx) = mpsc::channel(128);
    let (reply, _) = oneshot::channel();
    world.command(Command::Join {
        identity: Identity {
            id: "growth".into(),
            username: "growth".into(),
        },
        connection: "growth-connection".into(),
        output,
        reply,
        lang: "zh".into(),
    });
    while rx.try_recv().is_ok() {}
    {
        let player = world.players.get_mut("growth").unwrap();
        player.state.job = ICE_MAGE_JOB;
        player.state.level = 1;
        player.state.exp = 79;
        player.state.exp_to_next = 80;
        player.state.skill_points.clear();
        player.state.ability_stats.available_ap = 0;
    }
    World::add_exp(
        &mut world.players.get_mut("growth").unwrap().state,
        1,
        &[80, 160, 0],
    );
    assert_eq!(world.players["growth"].state.level, 2);
    assert_eq!(world.players["growth"].state.ability_stats.available_ap, 5);
    assert_eq!(world.players["growth"].state.skill_points[&ICE_BOOK], 3);
    assert_eq!(world.players["growth"].state.exp_to_next, 160);
    World::add_exp(
        &mut world.players.get_mut("growth").unwrap().state,
        160,
        &[80, 160, 0],
    );
    assert_eq!(world.players["growth"].state.level, 3);
    assert_eq!(world.players["growth"].state.ability_stats.available_ap, 10);
    assert_eq!(world.players["growth"].state.exp_to_next, 0);

    world.command(Command::Input {
        id: "growth".into(),
        connection: "growth-connection".into(),
        message: ClientMessage::AllocateAp {
            request_id: "ap-1".into(),
            stat: AbilityStat::Intelligence,
        },
    });
    let first: Vec<serde_json::Value> = std::iter::from_fn(|| rx.try_recv().ok())
        .map(|message| serde_json::from_str(&message).unwrap())
        .collect();
    let result = first
        .iter()
        .find(|value| value["type"] == "abilityResult")
        .expect("ability result");
    assert_eq!(result["success"], true);
    assert_eq!(world.players["growth"].state.ability_stats.intelligence, 5);
    assert_eq!(world.players["growth"].state.ability_stats.available_ap, 9);
    assert_eq!(world.equipment_stats("growth").intelligence, 5);

    world.command(Command::Input {
        id: "growth".into(),
        connection: "growth-connection".into(),
        message: ClientMessage::AllocateAp {
            request_id: "ap-1".into(),
            stat: AbilityStat::Intelligence,
        },
    });
    let replay: Vec<serde_json::Value> = std::iter::from_fn(|| rx.try_recv().ok())
        .map(|message| serde_json::from_str(&message).unwrap())
        .collect();
    assert_eq!(
        replay
            .iter()
            .find(|value| value["type"] == "abilityResult")
            .expect("replay result")["abilityStats"]["availableAp"],
        9
    );
    assert_eq!(world.players["growth"].state.ability_stats.intelligence, 5);

    world.command(Command::Input {
        id: "growth".into(),
        connection: "growth-connection".into(),
        message: ClientMessage::AllocateAp {
            request_id: "ap-1".into(),
            stat: AbilityStat::Luck,
        },
    });
    let conflict: Vec<serde_json::Value> = std::iter::from_fn(|| rx.try_recv().ok())
        .map(|message| serde_json::from_str(&message).unwrap())
        .collect();
    assert_eq!(
        conflict
            .iter()
            .find(|value| value["type"] == "abilityResult")
            .expect("conflict result")["code"],
        "request_conflict"
    );
    assert_eq!(world.players["growth"].state.ability_stats.luck, 4);
}

#[test]
fn ice_mage_second_job_skills_damage_freeze_consume_and_path() {
    let mut gameplay = life_gameplay(vec![
        life_spawn("ice-m1", "test", 165.0, 1, -1),
        life_spawn("ice-m2", "test", 175.0, 1, -1),
        life_spawn("ice-m3", "test", 185.0, 1, -1),
        life_spawn("ice-m4", "test", 195.0, 1, -1),
    ]);
    for template in &mut gameplay.monsters {
        template.max_hp = 100_000;
        template.max_mp = 100;
    }
    gameplay.player.max_mp = Some(500);
    let mut world =
        World::new_with_gameplay(map(), 600, gameplay).with_mage_skills(MageSkills::bundled());
    let (output, mut rx) = mpsc::channel(512);
    let (reply, _) = oneshot::channel();
    world.command(Command::Join {
        identity: Identity {
            id: "ice-mage".into(),
            username: "ice-mage".into(),
        },
        connection: "ice-connection".into(),
        output,
        reply,
        lang: "zh".into(),
    });
    while rx.try_recv().is_ok() {}
    let drain = |rx: &mut mpsc::Receiver<String>| {
        std::iter::from_fn(|| rx.try_recv().ok())
            .map(|message| serde_json::from_str::<serde_json::Value>(&message).unwrap())
            .collect::<Vec<_>>()
    };

    world.players.get_mut("ice-mage").unwrap().state.job = MAGICIAN_JOB;
    world
        .players
        .get_mut("ice-mage")
        .unwrap()
        .state
        .skill_points = BTreeMap::from([(MAGE_BOOK, 5)]);
    world.handle_learn_skill("ice-mage".into(), "wrong-book".into(), SKILL_COLD_BEAM);
    let wrong_job: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
    assert_eq!(wrong_job["type"], "rejected");
    assert_eq!(wrong_job["code"], "wrong_job");

    {
        let player = world.players.get_mut("ice-mage").unwrap();
        player.state.job = ICE_MAGE_JOB;
        player.state.level = 30;
        player.state.mp = 500;
        player.state.max_mp = 500;
        player.state.skills = BTreeMap::from([
            (SKILL_MAGIC_BOOST, 1),
            (SKILL_MANA_ABSORB, 9),
            (SKILL_SPELL_MASTERY, 10),
            (SKILL_INTELLIGENCE, 5),
            (SKILL_ICE_EFFECT, 1),
            (SKILL_BOOSTER, 10),
            (SKILL_MEDITATION, 1),
            (SKILL_THUNDER_BOLT, 1),
            (SKILL_COLD_BEAM, 1),
            (SKILL_ICE_TELEPORT, 10),
            (SKILL_TELEPORT, 5),
        ]);
        player.state.skill_points = BTreeMap::from([(ICE_BOOK, 0)]);
        player.state.x = 100.0;
        player.state.y = 100.0;
        player.state.grounded = true;
        player.state.action = "stand";
        player.foothold_id = 1;
        player.last_foothold_id = 1;
        refresh_player_derived(&world.gameplay, &world.mage_skills, player);
        assert_eq!(player.state.derived_stats.intelligence, Some(64));
    }
    assert_eq!(world.action_speed_bonus(&world.players["ice-mage"]), -3);

    world.handle_cast_skill(
        "ice-mage".into(),
        "meditation".into(),
        SKILL_MEDITATION,
        Some(1),
        Some(0),
    );
    let meditation_messages = drain(&mut rx);
    let meditation = meditation_messages
        .iter()
        .find(|value| value["type"] == "skillResult")
        .expect("meditation result");
    assert_eq!(meditation["success"], true);
    assert!(world.players["ice-mage"].meditation_mad > 0);
    world.step();
    assert!(world.players["ice-mage"]
        .state
        .derived_stats
        .meditation_remaining_ms
        .is_some());

    world.handle_cast_skill(
        "ice-mage".into(),
        "cold-1".into(),
        SKILL_COLD_BEAM,
        Some(1),
        Some(0),
    );
    let cold_messages: Vec<serde_json::Value> = std::iter::from_fn(|| rx.try_recv().ok())
        .map(|message| serde_json::from_str(&message).unwrap())
        .collect();
    assert!(cold_messages
        .iter()
        .any(|value| value["type"] == "skillCast"));
    assert_eq!(
        cold_messages
            .iter()
            .filter(|value| value["type"] == "damageEvent")
            .count(),
        12
    );
    let first_monster = world.monsters.keys().next().cloned().unwrap();
    assert_eq!(world.monsters[&first_monster].state.freeze_stacks, Some(1));
    assert!(world.monsters[&first_monster].freeze_until > world.tick);

    world.tick += 20;
    if let Some(player) = world.players.get_mut("ice-mage") {
        player.attack_until = world.tick;
        player.state.action = "stand";
    }
    world.handle_cast_skill(
        "ice-mage".into(),
        "thunder-1".into(),
        SKILL_THUNDER_BOLT,
        Some(1),
        Some(0),
    );
    let thunder_messages: Vec<serde_json::Value> = std::iter::from_fn(|| rx.try_recv().ok())
        .map(|message| serde_json::from_str(&message).unwrap())
        .collect();
    assert_eq!(
        thunder_messages
            .iter()
            .filter(|value| value["type"] == "damageEvent")
            .count(),
        12
    );
    assert_eq!(world.monsters[&first_monster].state.freeze_stacks, None);

    world.handle_cast_skill(
        "ice-mage".into(),
        "ice-toggle".into(),
        SKILL_ICE_TELEPORT,
        Some(1),
        Some(0),
    );
    let toggle_messages = drain(&mut rx);
    let toggle = toggle_messages
        .iter()
        .find(|value| value["type"] == "skillResult")
        .expect("ice teleport result");
    assert_eq!(toggle["success"], true);
    assert_eq!(world.players["ice-mage"].ice_teleport_enabled, true);
    assert_eq!(
        world.players["ice-mage"].state.derived_stats.ice_teleport,
        Some(true)
    );

    // The exported path probability is random.  Repeating the authored
    // source transition keeps this check deterministic enough while still
    // exercising the enabled guard, 6 second lifetime and 1200 ms tick.
    for _ in 0..100 {
        if !world.players["ice-mage"].ice_fields.is_empty() {
            break;
        }
        if let Some(player) = world.players.get_mut("ice-mage") {
            player.state.x = 290.0;
            player.state.y = 130.0;
        }
        world.maybe_create_ice_field("ice-mage", 100.0, 100.0);
    }
    assert!(!world.players["ice-mage"].ice_fields.is_empty());
    let field_event = drain(&mut rx)
        .into_iter()
        .find(|value| {
            value["type"] == "skillCast"
                && value["skillId"] == SKILL_ICE_TELEPORT
                && value["targetX"].is_number()
                && value["targetY"].is_number()
        })
        .expect("ice field skillCast");
    assert_eq!(field_event["x"], 100.0);
    assert_eq!(field_event["y"], 100.0);
    assert_eq!(field_event["requestId"], field_event["eventId"]);
    assert_eq!(field_event["facing"], 1);
    assert_eq!(field_event["durationMs"], 6_000);
    let mp_before_absorb = world.players["ice-mage"].state.mp;
    for _ in 0..1000 {
        if world.monsters[&first_monster].mp == 0 {
            break;
        }
        world.maybe_absorb_monster_mp("ice-mage", &first_monster);
    }
    assert!(world.monsters[&first_monster].mp < 100);
    assert!(world.players["ice-mage"].state.mp >= mp_before_absorb);
    world.step_ice_fields();
    assert!(world.monsters[&first_monster].state.freeze_stacks.is_some());
}

#[test]
fn fourth_job_core_channel_bind_summon_infinity_and_blizzard() {
    let mut gameplay = life_gameplay(vec![
        life_spawn("fourth-m1", "test", 140.0, 1, -1),
        life_spawn("fourth-m2", "test", 165.0, 1, -1),
    ]);
    gameplay.player.max_hp = Some(1_000);
    gameplay.player.max_mp = Some(1_000);
    for template in &mut gameplay.monsters {
        template.max_hp = 1_000_000;
        template.md_rate = Some(50.0);
        template.pd_rate = Some(50.0);
    }
    let mut world = World::new_with_gameplay(life_map("test"), 600, gameplay)
        .with_mage_skills(MageSkills::bundled());
    let (output, mut rx) = mpsc::channel(4_096);
    let (reply, _) = oneshot::channel();
    world.command(Command::Join {
        identity: Identity {
            id: "fourth-runtime".into(),
            username: "fourth-runtime".into(),
        },
        connection: "fourth-runtime-connection".into(),
        output,
        reply,
        lang: "zh".into(),
    });
    while rx.try_recv().is_ok() {}
    {
        let player = world.players.get_mut("fourth-runtime").unwrap();
        player.state.job = ICE_FOURTH_JOB;
        player.state.level = 100;
        player.base_max_mp = 1_000;
        player.state.hp = 1_000;
        player.state.mp = 1_000;
        player.state.skills = BTreeMap::from([
            (SKILL_MASTER_MAGIC, 1),
            (SKILL_ICE_DRAGON_BREATH, 1),
            (SKILL_ICE_DEMON, 1),
            (SKILL_FROZEN_ORB, 1),
            (SKILL_INFINITY, 1),
            (SKILL_BLIZZARD, 1),
            (SKILL_COLD_BEAM, 1),
            (SKILL_CHAIN_LIGHTNING, 1),
        ]);
        player.state.x = 100.0;
        player.state.y = 100.0;
        player.state.grounded = true;
        player.state.action = "stand";
        player.foothold_id = 1;
        player.last_foothold_id = 1;
        refresh_player_derived(&world.gameplay, &world.mage_skills, player);
    }
    let drain = |rx: &mut mpsc::Receiver<String>| {
        std::iter::from_fn(|| rx.try_recv().ok())
            .map(|message| serde_json::from_str::<serde_json::Value>(&message).unwrap())
            .collect::<Vec<_>>()
    };
    let target_id = world.monsters.keys().next().cloned().unwrap();
    let damage_without_bind = world.magic_damage_with_passives(
        "fourth-runtime",
        SKILL_COLD_BEAM,
        &target_id,
        100,
        false,
        "before-bind",
        1,
    );

    // channel_until == 0 is an inactive state; it must not reset an
    // ordinary attack on the next simulation tick.
    {
        let player = world.players.get_mut("fourth-runtime").unwrap();
        player.state.action = "attack";
        player.attack_until = player.channel_until.saturating_add(10);
    }
    world.step();
    assert_eq!(world.players["fourth-runtime"].channel_until, 0);
    assert_eq!(world.players["fourth-runtime"].state.action, "attack");
    world
        .players
        .get_mut("fourth-runtime")
        .unwrap()
        .attack_until = world.tick;

    world.handle_cast_skill(
        "fourth-runtime".into(),
        "dragon-1".into(),
        SKILL_ICE_DRAGON_BREATH,
        Some(1),
        Some(0),
    );
    let dragon_messages = drain(&mut rx);
    let dragon_event = dragon_messages
        .iter()
        .find(|value| value["type"] == "skillCast" && value["skillId"] == SKILL_ICE_DRAGON_BREATH)
        .expect("dragon cast event");
    assert_eq!(dragon_event["durationMs"], 7_000);
    let dragon_until = world.players["fourth-runtime"].channel_until;
    assert_eq!(dragon_until - world.tick, 140);
    assert!(world.monsters[&target_id].bind_until > world.tick);
    assert!(world.monsters[&target_id].bind_immune_until > world.tick);
    assert_eq!(world.monsters[&target_id].bind_pd_rate_reduction, 10);
    assert_eq!(world.monsters[&target_id].bind_md_rate_reduction, 20);
    let damage_with_bind = world.magic_damage_with_passives(
        "fourth-runtime",
        SKILL_COLD_BEAM,
        &target_id,
        100,
        false,
        "before-bind",
        1,
    );
    assert!(damage_with_bind > damage_without_bind);

    // A release after the q window is a silent idempotent no-op.
    world.tick = dragon_until;
    world.step();
    assert!(world.players["fourth-runtime"].channel_request_id.is_none());
    world.handle_release_skill("fourth-runtime".into(), "dragon-1".into());
    assert!(drain(&mut rx)
        .iter()
        .all(|value| { value["type"] != "skillCast" || value["requestId"] != "dragon-1" }));

    // The ninety-second immunity is independent from bind duration and
    // rejects a second Dragon cast without changing either mob's HP.
    let hp_before_immune = world
        .monsters
        .iter()
        .map(|(id, monster)| (id.clone(), monster.state.hp))
        .collect::<BTreeMap<_, _>>();
    {
        let player = world.players.get_mut("fourth-runtime").unwrap();
        player.skill_cooldowns.remove(&SKILL_ICE_DRAGON_BREATH);
        player.attack_until = player.channel_until;
    }
    world.handle_cast_skill(
        "fourth-runtime".into(),
        "dragon-2".into(),
        SKILL_ICE_DRAGON_BREATH,
        Some(1),
        Some(0),
    );
    let _ = drain(&mut rx);
    assert!(world
        .monsters
        .iter()
        .all(|(id, monster)| monster.state.hp == hp_before_immune[id]));

    let player_x = world.players["fourth-runtime"].state.x;
    let demon = world
        .mage_skills
        .level(SKILL_ICE_DEMON, 1)
        .cloned()
        .unwrap();
    let orb = world
        .mage_skills
        .level(SKILL_FROZEN_ORB, 1)
        .cloned()
        .unwrap();
    {
        let player = world.players.get_mut("fourth-runtime").unwrap();
        player.channel_request_id = None;
        player.channel_skill_id = None;
        player.channel_until = 0;
        player.attack_until = 0;
    }
    world
        .cast_summon("fourth-runtime", "demon-1", SKILL_ICE_DEMON, &demon)
        .unwrap();
    world
        .cast_frozen_orb("fourth-runtime", "orb-1", &orb)
        .unwrap();
    assert_eq!(world.players["fourth-runtime"].summons.len(), 2);
    assert!(world.players["fourth-runtime"]
        .summons
        .iter()
        .any(|summon| summon.skill_id == SKILL_ICE_DEMON));
    assert!(world.players["fourth-runtime"]
        .summons
        .iter()
        .any(|summon| summon.skill_id == SKILL_FROZEN_ORB));
    world.step_summons();
    assert_eq!(world.players["fourth-runtime"].state.x, player_x);

    {
        let player = world.players.get_mut("fourth-runtime").unwrap();
        player.base_max_mp = 100;
        player.state.mp = 0;
        refresh_player_derived(&world.gameplay, &world.mage_skills, player);
    }
    let infinity = world.mage_skills.level(SKILL_INFINITY, 1).cloned().unwrap();
    world
        .activate_infinity("fourth-runtime", SKILL_INFINITY, &infinity)
        .unwrap();
    {
        let player = world.players.get_mut("fourth-runtime").unwrap();
        player.state.mp = 0;
        player.infinity_next_tick = world.tick;
    }
    world.step_infinity_tick("fourth-runtime");
    assert_eq!(world.players["fourth-runtime"].state.mp, 1);
    {
        let player = world.players.get_mut("fourth-runtime").unwrap();
        // 把無限压进「强化窗」（源语义：剩余时间低于阈值时加成生效），
        // 走与施法同一条入口，而不是往内部表里塞一个剩余毫秒。
        player
            .status
            .apply_buff(SKILL_INFINITY, 1_000, world.tick, Release::Infinity);
        refresh_player_derived(&world.gameplay, &world.mage_skills, player);
    }
    assert!(
        world.players["fourth-runtime"]
            .state
            .derived_stats
            .infinity_enhanced
    );

    // Blizzard's hidden proc is selected from the actual successful
    // direct targets and is excluded from its own direct-skill chain.
    let cold = world
        .mage_skills
        .level(SKILL_COLD_BEAM, 1)
        .cloned()
        .unwrap();
    let mut found_follow_up = false;
    for index in 0..300 {
        let request_id = format!("cold-follow-{index}");
        world
            .cast_elemental_area("fourth-runtime", &request_id, SKILL_COLD_BEAM, &cold, false)
            .unwrap();
        let messages = drain(&mut rx);
        let main_targets = messages
            .iter()
            .filter(|value| value["type"] == "damageEvent" && value["skillId"] == SKILL_COLD_BEAM)
            .filter_map(|value| value["targetId"].as_str())
            .collect::<BTreeSet<_>>();
        let follow_ups = messages
            .iter()
            .filter(|value| {
                value["type"] == "damageEvent" && value["skillId"] == SKILL_BLIZZARD_HIDDEN
            })
            .collect::<Vec<_>>();
        if !follow_ups.is_empty() {
            assert_eq!(follow_ups.len(), 1);
            let target = follow_ups[0]["targetId"].as_str().unwrap();
            assert!(main_targets.contains(target));
            found_follow_up = true;
            break;
        }
    }
    assert!(found_follow_up, "deterministic Blizzard proc did not occur");
}
