fn boss_profile(level: u32) -> Profile {
    let mut profile = quest_profile();
    profile.level = level;
    profile.hp = 500;
    profile.max_hp = 500;
    profile.mp = 500;
    profile.max_mp = 500;
    profile.map_id = "102020500".into();
    profile.x = 912.0;
    profile.y = 1854.0;
    profile
}

fn boss_world(store: auth::Store, account: &str) -> (World, mpsc::Receiver<String>) {
    store.load_profile(account, &boss_profile(25)).unwrap();
    let mut world = chapter_actual_world(store);
    world.gameplay.player.max_hp = Some(5_000);
    let rx = chapter_join(&mut world, account);
    let player = world.players.get_mut(account).unwrap();
    player.state.max_hp = 5_000;
    player.state.hp = 5_000;
    (world, rx)
}

fn boss_snapshot(world: &World, account: &str) -> serde_json::Value {
    serde_json::from_str(&world.snapshot(account)).unwrap()
}

fn boss_enter(world: &mut World, rx: &mut mpsc::Receiver<String>, account: &str, request: &str) -> String {
    world.handle_boss_practice(
        account.into(),
        request.into(),
        crate::protocol::BossPracticeAction::Enter,
        None,
    );
    assert!(chapter_drain(rx)
        .into_iter()
        .any(|message| message["type"] == "snapshot" && message["bossPractice"].is_object()));
    let snapshot = boss_snapshot(world, account);
    assert_eq!(snapshot["bossPractice"]["status"], "active");
    world.boss_practices[account].instance_map_id.clone()
}

#[test]
fn boss_practice_actual_map_qualification_isolated_and_idempotent() {
    let path = std::env::temp_dir().join(format!("maple-boss-qualification-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).unwrap();
    service.store.load_profile("low", &boss_profile(24)).unwrap();
    service.store.load_profile("boss", &boss_profile(25)).unwrap();
    let mut world = chapter_actual_world(service.store.clone());
    // 50 base maps + 21 portal-closure maps (2026-09-13): every map an
    // assembled map's portal names that the TMS273 WZ JSON ships.
    assert_eq!(world.maps.len(), 71);
    assert!(world.maps.contains_key("102020500"));
    // 維多利亞港三家商店必须随目录一起加载，否则原版店门会回 map_unavailable。
    for id in ["104000001", "104000002", "104000003"] {
        assert!(world.maps.contains_key(id), "missing shop map {id}");
    }
    // 魔法森林 101000000 的 in00/in01 同理指向目录内的 101000001/101000002。
    for id in ["101000001", "101000002"] {
        assert!(world.maps.contains_key(id), "missing shop map {id}");
    }

    let mut low_rx = chapter_join(&mut world, "low");
    chapter_drain(&mut low_rx);
    world.handle_boss_practice(
        "low".into(),
        "low-enter".into(),
        crate::protocol::BossPracticeAction::Enter,
        None,
    );
    assert_eq!(chapter_rejection(&mut low_rx), "boss_practice_level");
    world.command(Command::Leave {
        id: "low".into(),
        connection: "low-connection".into(),
    });

    let mut rx = chapter_join(&mut world, "boss");
    chapter_drain(&mut rx);
    let instance = boss_enter(&mut world, &mut rx, "boss", "enter-1");
    let practice = world.boss_practices["boss"].clone();
    let player = &world.players["boss"];
    let monster = &world.monsters[&practice.monster_id];
    assert_eq!(player.map_id, instance);
    assert_eq!(monster.map_id, instance);
    assert!((monster.state.x - player.state.x).abs() >= 150.0);
    assert!((monster.state.y - player.state.y).abs() < 1.0);
    assert!(world.maps[&instance].portals.is_empty());
    assert_eq!(
        world
            .monsters
            .values()
            .filter(|monster| monster.map_id == instance)
            .count(),
        1
    );

    world.handle_boss_practice(
        "boss".into(),
        "enter-1".into(),
        crate::protocol::BossPracticeAction::Enter,
        None,
    );
    chapter_drain(&mut rx);
    assert_eq!(world.boss_practices["boss"].instance_map_id, instance);

    world.handle_boss_practice(
        "boss".into(),
        "leave-1".into(),
        crate::protocol::BossPracticeAction::Leave,
        Some(instance.clone()),
    );
    assert_eq!(chapter_rejection(&mut rx), "boss_practice_left");
    let newer = boss_enter(&mut world, &mut rx, "boss", "enter-2");
    assert_ne!(newer, instance);
    world.handle_boss_practice(
        "boss".into(),
        "stale-leave".into(),
        crate::protocol::BossPracticeAction::Leave,
        Some(instance),
    );
    assert_eq!(chapter_rejection(&mut rx), "boss_practice_encounter");
    assert_eq!(world.boss_practices["boss"].instance_map_id, newer);
    assert!(!ClientMessage::BossPractice {
        request_id: "bad-encounter".into(),
        action: crate::protocol::BossPracticeAction::Leave,
        encounter_id: Some("102020500".into()),
    }
    .valid());
    service.store.load_profile("observer", &boss_profile(25)).unwrap();
    let _observer_rx = chapter_join(&mut world, "observer");
    let public_snapshot = boss_snapshot(&world, "observer");
    assert!(public_snapshot["players"].as_array().unwrap().iter().all(|player| player["id"] != "boss"));
    assert!(public_snapshot["monsters"].as_array().unwrap().iter().all(|mob| mob["templateId"] != "3220000"));
    world.command(Command::Leave { id: "boss".into(), connection: "boss-connection".into() });
    assert!(!world.maps.contains_key(&newer));
    assert!(!world.boss_practices.contains_key("boss"));
    assert_eq!(service.store.load_profile("boss", &boss_profile(25)).unwrap().map_id, "102020500");
}

#[test]
fn boss_practice_persistence_failure_death_animation_and_no_store_rewards() {
    let path = std::env::temp_dir().join(format!("maple-boss-lifecycle-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).unwrap();
    let (mut world, mut rx) = boss_world(service.store.clone(), "boss-life");
    chapter_drain(&mut rx);
    let instance = boss_enter(&mut world, &mut rx, "boss-life", "enter-life");

    world.players.get_mut("boss-life").unwrap().state.mesos = u64::MAX;
    let before = world.players["boss-life"].state.clone();
    assert!(world.commit_incoming_damage("boss-life", 20).is_none());
    assert_eq!((world.players["boss-life"].state.hp, world.players["boss-life"].state.mp), (before.hp, before.mp));
    chapter_drain(&mut rx);
    world.handle_boss_practice(
        "boss-life".into(),
        "leave-fail".into(),
        crate::protocol::BossPracticeAction::Leave,
        Some(instance.clone()),
    );
    assert_eq!(chapter_rejection(&mut rx), "persistence");
    assert!(world.boss_practices["boss-life"].status.is_none());
    assert!(world.maps.contains_key(&instance));
    assert!(!world
        .boss_requests
        .contains_key(&(String::from("boss-life"), String::from("leave-fail"))));
    world.players.get_mut("boss-life").unwrap().state.mesos = 0;
    world.handle_boss_practice(
        "boss-life".into(),
        "leave-fail".into(),
        crate::protocol::BossPracticeAction::Leave,
        Some(instance),
    );
    assert_eq!(chapter_rejection(&mut rx), "boss_practice_left");

    let instance = boss_enter(&mut world, &mut rx, "boss-life", "enter-death");
    let boss_id = world.boss_practices["boss-life"].monster_id.clone();
    let death_at = world.tick + 3;
    {
        let boss = world.monsters.get_mut(&boss_id).unwrap();
        boss.state.hp = 0;
        boss.state.action = "die";
        boss.death_until = Some(death_at);
    }
    world.step();
    world.step();
    assert!(world.boss_practices["boss-life"].status.is_none());
    assert!(world.maps.contains_key(&instance));
    world.step();
    assert_eq!(world.boss_practices["boss-life"].status, Some(boss::BossPracticeStatus::Cleared));
    assert_eq!(world.players["boss-life"].map_id, "102020500");
    assert!(!world.maps.contains_key(&instance));

    let settled = world.boss_practices["boss-life"].instance_map_id.clone();
    world.handle_boss_practice(
        "boss-life".into(),
        "close-cleared".into(),
        crate::protocol::BossPracticeAction::Leave,
        Some(settled),
    );
    chapter_drain(&mut rx);
    let instance = boss_enter(&mut world, &mut rx, "boss-life", "enter-no-store");
    world.store = None;
    world.drops.clear();
    let exp_before = world.players["boss-life"].state.exp;
    let boss_id = world.boss_practices["boss-life"].monster_id.clone();
    let (x, y) = {
        let boss = world.monsters.get_mut(&boss_id).unwrap();
        boss.state.hp = 1;
        (boss.state.x, boss.state.y)
    };
    {
        let player = world.players.get_mut("boss-life").unwrap();
        player.state.x = x - 30.0;
        player.state.y = y;
        player.state.facing = 1;
    }
    world.handle_attack("boss-life".into(), "actual-practice-kill".into());
    world.tick += world.combat.hit_after_ms.div_ceil(TICK_MS).max(1);
    world.resolve_pending_attacks();
    assert_eq!(world.monsters[&boss_id].state.hp, 0, "must exercise real attack settlement");
    assert_eq!(world.players["boss-life"].state.exp, exp_before);
    world.tick = world.monsters[&boss_id].death_until.unwrap();
    world.step();
    assert_eq!(world.players["boss-life"].state.exp, exp_before);
    assert_eq!(world.players["boss-life"].map_id, "102020500");
    assert!(world.drops.is_empty());
    assert!(!world.maps.contains_key(&instance));
}

#[test]
fn boss_practice_controls_orientation_guards_and_heal_boundaries() {
    let path = std::env::temp_dir().join(format!("maple-boss-actions-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).unwrap();
    let (mut world, mut rx) = boss_world(service.store, "boss-actions");
    chapter_drain(&mut rx);
    let instance = boss_enter(&mut world, &mut rx, "boss-actions", "enter-actions");
    let boss_id = world.boss_practices["boss-actions"].monster_id.clone();
    let source_x = world.monsters[&boss_id].state.x;
    assert_eq!(world.monsters[&boss_id].state.facing, 1);

    for _ in 0..20 {
        world.step();
    }
    let first = boss_snapshot(&world, "boss-actions");
    let telegraph = &first["bossPractice"]["telegraph"];
    assert_eq!(first["bossPractice"]["status"], "active");
    assert!((telegraph["x"].as_f64().unwrap() - (source_x - 255.0)).abs() < 0.1);

    world.monsters.get_mut(&boss_id).unwrap().bind_until = world.tick + 5;
    world.step();
    let cancelled = boss_snapshot(&world, "boss-actions");
    assert!(cancelled["bossPractice"]["telegraph"].is_null());
    world.monsters.get_mut(&boss_id).unwrap().state.hp = 6_000;
    for _ in 0..5 {
        world.step();
    }
    assert!(boss_snapshot(&world, "boss-actions")["bossPractice"]["telegraph"].is_object());

    for _ in 0..300 {
        world.step();
    }
    assert_eq!(world.boss_damage_multiplier(&instance, false), 85);
    assert_eq!(world.boss_damage_multiplier(&instance, true), 85);
    let boss = &world.monsters[&boss_id];
    assert_eq!(boss.state.hp, 6_700);
    assert_eq!(boss.mp, 1_980);
    let final_snapshot = boss_snapshot(&world, "boss-actions");
    let effects = final_snapshot["bossPractice"]["effects"]
        .as_array()
        .unwrap();
    for skill_id in [112, 113, 114] {
        assert!(effects.iter().any(|effect| effect["skillId"] == skill_id));
    }
}
