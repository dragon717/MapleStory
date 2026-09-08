fn third_profile(job: u32) -> Profile {
    let mut profile = quest_profile();
    profile.job = job;
    profile.level = 60;
    profile.hp = 500;
    profile.max_hp = 500;
    profile.mp = 500;
    profile.max_mp = 500;
    profile.skills = BTreeMap::from([
        (SKILL_ICE_STORM, 1),
        (SKILL_GLACIAL_WALL, 1),
        (SKILL_THUNDER_SPHERE, 1),
        (SKILL_ELEMENTAL_ADAPTING, 1),
    ]);
    profile
}

fn third_active_player(world: &mut World, id: &str) {
    let player = world.players.get_mut(id).unwrap();
    player.state.job = ICE_THIRD_JOB;
    player.state.level = 60;
    player.state.hp = 500;
    player.state.max_hp = 500;
    player.state.mp = 500;
    player.state.max_mp = 500;
    player.base_max_mp = 500;
    player.state.x = 100.0;
    player.state.y = 100.0;
    player.state.grounded = true;
    player.state.action = "stand";
    player.foothold_id = 1;
    player.last_foothold_id = 1;
    player.state.skills = BTreeMap::from([
        (SKILL_EXTREME_MAGIC, 1),
        (SKILL_ELEMENT_AMP, 1),
        (SKILL_FROZEN_BREAK, 1),
        (SKILL_ELEMENTAL_RESET, 1),
        (SKILL_ICE_STORM, 1),
        (SKILL_GLACIAL_WALL, 1),
        (SKILL_THUNDER_SPHERE, 1),
        (SKILL_ELEMENTAL_ADAPTING, 1),
    ]);
    refresh_player_derived(&world.gameplay, &world.mage_skills, player);
}

#[test]
fn third_job_npc_requires_catalog_and_persists_transfer() {
    let path = std::env::temp_dir().join(format!("maple-third-transfer-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).unwrap();
    service.store.load_profile("third", &third_profile(ICE_MAGE_JOB)).unwrap();
    service.store.load_profile("stale", &third_profile(ICE_MAGE_JOB)).unwrap();
    let mut world = World::new_with_store(mage_map(), 600, mage_gameplay(), service.store.clone())
        .unwrap()
        .with_mage_skills(MageSkills::bundled());
    let mut rx = chapter_join(&mut world, "third");
    chapter_drain(&mut rx);

    world.handle_npc_talk(
        "third".into(),
        "third-open".into(),
        MAGE_ADVANCE_NPC_ID.into(),
        None,
        None,
    );
    let menu = chapter_drain(&mut rx)
        .into_iter()
        .find(|message| message["type"] == "npcResult")
        .expect("third job menu");
    assert!(menu["dialog"]["options"]
        .as_array()
        .is_some_and(|options| options.iter().any(|option| option["index"] == 3)));
    world.handle_npc_talk(
        "third".into(),
        "third-select".into(),
        MAGE_ADVANCE_NPC_ID.into(),
        Some("select"),
        Some(3),
    );
    let result = chapter_drain(&mut rx)
        .into_iter()
        .find(|message| message["type"] == "npcResult")
        .expect("third job result");
    assert_eq!(result["trainingResult"]["job"], ICE_THIRD_JOB);
    assert_eq!(world.players["third"].state.job, ICE_THIRD_JOB);
    let persisted = service.store.load_profile("third", &quest_profile()).unwrap();
    assert_eq!(persisted.job, ICE_THIRD_JOB);
    assert_eq!(persisted.skill_points.get(&THIRD_BOOK), Some(&5));

    // Removing the authored entry models an old 8/17-node runtime: the same
    // level/job must not advertise a transfer whose skill catalog is absent.
    world.mage_skills.skills.remove(&SKILL_ICE_STORM.to_string());
    let mut stale_rx = chapter_join(&mut world, "stale");
    chapter_drain(&mut stale_rx);
    world.handle_npc_talk(
        "stale".into(),
        "stale-open".into(),
        MAGE_ADVANCE_NPC_ID.into(),
        None,
        None,
    );
    let stale_menu = chapter_drain(&mut stale_rx)
        .into_iter()
        .find(|message| message["type"] == "npcResult")
        .expect("stale job menu");
    assert!(!stale_menu["dialog"]["options"]
        .as_array()
        .is_some_and(|options| options.iter().any(|option| option["index"] == 3)));
}

#[test]
fn third_sphere_and_adaptation_are_idempotent_and_bounded() {
    let path = std::env::temp_dir().join(format!("maple-third-skill-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).unwrap();
    service.store.load_profile("third", &third_profile(ICE_THIRD_JOB)).unwrap();
    service.store.save_profile("third", &third_profile(ICE_THIRD_JOB)).unwrap();
    let gameplay = life_gameplay(vec![life_spawn("sphere-target", "test", 100.0, 1, -1)]);
    let mut world = World::new_with_store(map(), 600, gameplay, service.store.clone())
        .unwrap()
        .with_mage_skills(MageSkills::bundled());
    let mut rx = chapter_join(&mut world, "third");
    chapter_drain(&mut rx);

    world.handle_cast_skill("third".into(), "sphere".into(), SKILL_THUNDER_SPHERE, Some(1), Some(0));
    let first = chapter_drain(&mut rx);
    assert!(first.iter().any(|message| message["type"] == "skillResult" && message["success"] == true));
    let moving = world.players["third"].summon.clone().expect("moving sphere");
    let target_id = world.monsters.keys().next().unwrap().clone();
    { let target = world.monsters.get_mut(&target_id).unwrap();
      target.state.hp = 100_000; target.state.max_hp = 100_000;
      target.state.x = moving.x; target.state.y = moving.y; }
    world.step_summons();
    assert!(world.monsters[&target_id].state.hp < 100_000, "sphere actually deals damage");
    let hp_after_pulse = world.monsters[&target_id].state.hp;
    let magic_attack = world.players["third"].state.derived_stats.magic_attack;
    assert_eq!(100_000 - hp_after_pulse, 3 * (magic_attack * 331 / 100).max(1), "level1 normal mob: (256+75)% x3");
    world.step_summons();
    assert_eq!(world.monsters[&target_id].state.hp, hp_after_pulse, "same tick cannot pulse twice");
    let moving = world.players["third"].summon.clone().unwrap();
    let mp_after_first = world.players["third"].state.mp;
    world.handle_cast_skill("third".into(), "sphere".into(), SKILL_THUNDER_SPHERE, Some(1), Some(0));
    let replay = chapter_drain(&mut rx);
    assert!(replay.iter().any(|message| message["type"] == "skillResult" && message["success"] == true));
    assert_eq!(world.players["third"].state.mp, mp_after_first);
    assert_eq!(world.players["third"].summon.as_ref().unwrap().summon_id, moving.summon_id);

    world.players.get_mut("third").unwrap().attack_until = 0;
    world.handle_cast_skill("third".into(), "anchor".into(), SKILL_THUNDER_SPHERE, Some(1), Some(1));
    chapter_drain(&mut rx);
    let anchored = world.players["third"].summon.clone().expect("anchored sphere");
    assert_eq!(anchored.skill_id, SKILL_THUNDER_SPHERE_HIDDEN);
    assert!(anchored.anchored);
    assert_eq!(anchored.next_hit_at, moving.next_hit_at);
    let snapshot: serde_json::Value = serde_json::from_str(&world.snapshot("third")).unwrap();
    assert_eq!(snapshot["summons"][0]["skillId"], SKILL_THUNDER_SPHERE_HIDDEN);
    assert_eq!(snapshot["summons"][0]["stationary"], true);
    world.players.get_mut("third").unwrap().state.x += 700.0;
    let owner_x = world.players["third"].state.x;
    world.tick = anchored.next_hit_at;
    world.step_summons();
    assert_eq!(world.players["third"].state.x, owner_x, "fixed sphere never relocates its owner");
    assert!(world.monsters[&target_id].state.hp < hp_after_pulse, "fixed sphere attacks from its own origin");
    world.monsters.get_mut(&target_id).unwrap().template.boss = true;
    let boss_hp = world.monsters[&target_id].state.hp;
    world.tick = world.players["third"].summon.as_ref().unwrap().next_hit_at;
    world.step_summons();
    assert_eq!(boss_hp - world.monsters[&target_id].state.hp, 3 * (magic_attack * 256 / 100).max(1), "boss does not receive normal-mob bonus");
    world.tick = anchored.expires_at;
    world.step_summons();
    assert!(world.players["third"].summon.is_none());

    world.handle_cast_skill("third".into(), "adapt".into(), SKILL_ELEMENTAL_ADAPTING, Some(0), Some(0));
    let activated = chapter_drain(&mut rx);
    assert!(activated.iter().any(|message| message["type"] == "skillResult" && message["success"] == true));
    assert!(world.players["third"].adaptation_active);
    assert!(world.players["third"].adaptation_charges > 0);
    assert!(world.players["third"].adaptation_cooldown_ms > 0);
    let mp_after_adapt = world.players["third"].state.mp;
    world.handle_cast_skill("third".into(), "adapt-again".into(), SKILL_ELEMENTAL_ADAPTING, Some(0), Some(0));
    let rejected = chapter_drain(&mut rx);
    assert!(rejected.iter().any(|message| message["code"] == "skill_cooldown"));
    assert_eq!(world.players["third"].state.mp, mp_after_adapt);
}

#[test]
fn third_active_passives_and_failed_freeze_resolution() {
    let mut world = contact_hit_world(0.0).with_mage_skills(MageSkills::bundled());
    let mut joined = chapter_join(&mut world, "a");
    chapter_drain(&mut joined);
    third_active_player(&mut world, "a");
    assert_eq!(world.players["a"].adaptation_charges, 0);
    assert_eq!(world.players["a"].state.derived_stats.status_resistance, Some(1));
    assert_eq!(world.players["a"].state.derived_stats.element_resistance, Some(1));
    let monster_id = world.monsters.keys().next().cloned().unwrap();
    {
        let monster = world.monsters.get_mut(&monster_id).unwrap();
        monster.state.hp = 100_000;
        monster.state.max_hp = 100_000;
    }
    let (output, mut rx) = mpsc::channel(256);
    if let Some(player) = world.players.get_mut("a") {
        player.output = output;
    }
    world.handle_cast_skill("a".into(), "storm".into(), SKILL_ICE_STORM, Some(1), Some(0));
    let storm = chapter_drain(&mut rx);
    assert!(storm.iter().any(|message| message["type"] == "skillResult" && message["success"] == true));
    assert!(world.monsters[&monster_id].state.freeze_stacks.unwrap_or(0) > 0);
    world.players.get_mut("a").unwrap().attack_until = 0;
    world.handle_cast_skill("a".into(), "wall".into(), SKILL_GLACIAL_WALL, Some(1), Some(0));
    let wall = chapter_drain(&mut rx);
    assert!(wall.iter().any(|message| message["type"] == "skillResult" && message["success"] == true));

    {
        let monster = world.monsters.get_mut(&monster_id).unwrap();
        monster.template.md_rate = Some(10.0);
        monster.state.freeze_stacks = Some(5);
        monster.freeze_until = world.tick + 100;
        monster.stun_until = world.tick + 100;
    }
    let boosted = world.magic_damage_with_passives(
        "a", SKILL_ICE_STORM, &monster_id, 100, false, "passive", 1,
    );
    assert!(boosted > 100, "third passives should affect magic damage: {boosted}");

    // A missing auth profile makes resolve_attack fail after claim_attack.  A
    // failed/duplicate resolution must not leave a new freeze layer behind.
    let path = std::env::temp_dir().join(format!("maple-third-freeze-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).unwrap();
    let target = world.monsters.get_mut(&monster_id).unwrap();
    target.state.hp = 1;
    target.state.max_hp = 1;
    target.state.freeze_stacks = None;
    target.freeze_until = 0;
    let failed_level = MageLevel {
        damage: Some(100),
        mob_count: Some(1),
        attack_count: Some(1),
        lt: Some(crate::mage::MagePoint { x: -100.0, y: -100.0 }),
        rb: Some(crate::mage::MagePoint { x: 100.0, y: 100.0 }),
        ..MageLevel::default()
    };
    world.store = Some(service.store);
    let failed = world.cast_elemental_area_at(
        "a", "missing-profile", SKILL_ICE_STORM, &failed_level, false, Some((100.0, 100.0, 1)),
    );
    assert!(failed.is_err());
    assert_eq!(world.monsters[&monster_id].state.freeze_stacks, None);
}
