fn hyper_profile(skills: &[u32]) -> Profile {
    let mut profile = quest_profile();
    profile.level = 190;
    profile.job = ICE_FOURTH_JOB;
    profile.hp = 5_000;
    profile.max_hp = 5_000;
    profile.mp = 5_000;
    profile.max_mp = 5_000;
    profile.mesos = 10_000_000;
    profile.skills = skills.iter().copied().map(|skill| (skill, 1)).collect();
    profile.skill_points = BTreeMap::from([(FOURTH_BOOK, 100)]);
    profile
}

fn hyper_world(
    store: auth::Store,
    account: &str,
    skills: &[u32],
) -> (World, mpsc::Receiver<String>) {
    store.load_profile(account, &hyper_profile(skills)).unwrap();
    store.save_profile(account, &hyper_profile(skills)).unwrap();
    let mut world = chapter_actual_world(store).with_mage_skills(MageSkills::bundled());
    let mut rx = chapter_join(&mut world, account);
    chapter_drain(&mut rx);
    (world, rx)
}

fn hyper_target(world: &mut World, account: &str) -> String {
    let (target_id, map_id) = world
        .monsters
        .values()
        .find(|monster| monster.state.hp > 0)
        .map(|monster| (monster.state.id.clone(), monster.map_id.clone()))
        .expect("shared gameplay target");
    let (x, y) = world
        .monsters
        .get(&target_id)
        .map(|monster| (monster.state.x, monster.state.y))
        .unwrap();
    chapter_place(world, account, &map_id, x, y);
    let (x, y) = {
        let player = &world.players[account];
        (player.state.x, player.state.y)
    };
    let target = world.monsters.get_mut(&target_id).unwrap();
    target.state.x = x;
    target.state.y = y;
    target.state.hp = 1_000_000;
    target.state.max_hp = 1_000_000;
    target.state.action = "stand";
    target_id
}

fn hyper_set_persisted_mp(store: &auth::Store, account: &str, mp: i64) {
    let mut profile = store.load_profile(account, &hyper_profile(&[])).unwrap();
    profile.mp = mp;
    store.save_profile(account, &profile).unwrap();
}

#[test]
fn hyper_thunder_prepaid_release_and_damage_guard() {
    let path = std::env::temp_dir().join(format!("maple-hyper-release-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).unwrap();
    let (mut world, mut rx) = hyper_world(service.store.clone(), "hyper-release", &[SKILL_HYPER_THUNDER]);
    let _target = hyper_target(&mut world, "hyper-release");
    world.handle_cast_skill("hyper-release".into(), "thunder".into(), SKILL_HYPER_THUNDER, Some(1), Some(0));
    let cast = chapter_drain(&mut rx);
    assert!(cast.iter().any(|m| m["type"] == "skillResult" && m["success"] == true), "cast rejected: {cast:?}");
    assert_eq!(world.players["hyper-release"].state.mp, 4_970);
    let channel_until = world.players["hyper-release"].channel_until;
    let hp_before = world.players["hyper-release"].state.hp;
    let attack_before = world.players["hyper-release"].attack_until;
    let (hp_damage, _, killed) = world.commit_incoming_damage("hyper-release", 100).unwrap();
    assert_eq!((hp_damage, killed), (50, false));
    assert_eq!(world.players["hyper-release"].state.hp, hp_before - 50);
    assert_eq!(world.players["hyper-release"].attack_until, attack_before);
    assert_eq!(world.players["hyper-release"].knockback_vx, 0.0);

    world.handle_release_skill("hyper-release".into(), "thunder".into());
    let release = chapter_drain(&mut rx);
    assert_eq!(release.iter().filter(|message| message["phase"] == "final").count(), 1);
    assert!(world.players["hyper-release"].channel_skill_id.is_none());
    assert!(world.players["hyper-release"].skill_cooldowns.contains_key(&SKILL_HYPER_THUNDER));
    assert!(channel_until > world.tick);
    world.handle_release_skill("hyper-release".into(), "thunder".into());
    assert!(!chapter_drain(&mut rx).iter().any(|message| message["phase"] == "final"));
}

#[test]
fn hyper_thunder_pulses_keep_source_segments_and_stop_without_free_final() {
    let path = std::env::temp_dir().join(format!("maple-hyper-pulse-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).unwrap();
    let (mut world, mut rx) = hyper_world(service.store.clone(), "hyper-pulse", &[SKILL_HYPER_THUNDER]);
    let target_id = hyper_target(&mut world, "hyper-pulse");
    world.handle_cast_skill("hyper-pulse".into(), "thunder".into(), SKILL_HYPER_THUNDER, Some(1), Some(0));
    chapter_drain(&mut rx);
    let initial_mp = world.players["hyper-pulse"].state.mp;
    world.tick = world.players["hyper-pulse"].hyper_channel_prepare_until;
    world.step_hyper_channels();
    let first = chapter_drain(&mut rx);
    let hits: Vec<_> = first.iter().filter(|m| m["type"] == "damageEvent" && m["targetId"] == target_id).collect();
    assert_eq!(hits.len(), 15, "source attackCount=15: {first:?}");
    assert_eq!(1_000_000 - world.monsters[&target_id].state.hp, hits.iter().map(|m| m["damage"].as_i64().unwrap()).sum::<i64>());
    assert_eq!(world.players["hyper-pulse"].state.mp, initial_mp, "first pulse is prepaid");
    world.tick = world.players["hyper-pulse"].hyper_channel_next_pulse;
    world.step_hyper_channels();
    assert_eq!(world.players["hyper-pulse"].state.mp, initial_mp - 30);

    hyper_set_persisted_mp(&service.store, "hyper-pulse", 0);
    world.players.get_mut("hyper-pulse").unwrap().state.mp = 0;
    world.tick = world.players["hyper-pulse"].hyper_channel_next_pulse;
    world.step_hyper_channels();
    assert!(world.players["hyper-pulse"].channel_skill_id.is_none());
    let stopped = chapter_drain(&mut rx);
    assert!(stopped.iter().any(|message| message["code"] == "hyper_pulse_stopped"));
    assert!(!stopped.iter().any(|message| message["phase"] == "final"));
}

#[test]
fn hyper_adventurer_vortex_scope_upkeep_and_reset_lifecycle() {
    let path = std::env::temp_dir().join(format!("maple-hyper-effects-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).unwrap();
    let (mut world, mut rx) = hyper_world(
        service.store.clone(),
        "hyper-effects",
        &[SKILL_HYPER_ADVENTURER, SKILL_HYPER_VORTEX],
    );
    let target_id = hyper_target(&mut world, "hyper-effects");
    let base = world.magic_damage_with_passives("hyper-effects", SKILL_COLD_BEAM, &target_id, 100, false, "base", 1);
    assert!(!world.players["hyper-effects"].state.skills.contains_key(&SKILL_MYSTIC_STRIKE));
    world.handle_cast_skill("hyper-effects".into(), "adventurer".into(), SKILL_HYPER_ADVENTURER, Some(1), Some(0));
    chapter_drain(&mut rx);
    let boosted = world.magic_damage_with_passives("hyper-effects", SKILL_COLD_BEAM, &target_id, 100, false, "boosted", 1);
    assert!(boosted > base, "1053 must apply without Mystic Strike: {base} -> {boosted}");

    world.handle_cast_skill("hyper-effects".into(), "barrier".into(), SKILL_HYPER_VORTEX, Some(1), Some(0));
    chapter_drain(&mut rx);
    hyper_set_persisted_mp(&service.store, "hyper-effects", 0);
    world.players.get_mut("hyper-effects").unwrap().state.mp = 0;
    let tick = world.tick;
    {
        let player = world.players.get_mut("hyper-effects").unwrap();
        player.hyper_barrier_next_mp = tick;
        player.hyper_barrier_next_pulse = tick;
    }
    world.step_hyper_effects();
    assert!(!world.players["hyper-effects"].hyper_barrier_enabled);
    assert!(world.monsters[&target_id].state.freeze_stacks.is_none(), "failed upkeep cannot freeze");

    hyper_set_persisted_mp(&service.store, "hyper-effects", 5_000);
    world.players.get_mut("hyper-effects").unwrap().state.mp = 5_000;
    world.handle_cast_skill("hyper-effects".into(), "vortex".into(), SKILL_HYPER_VORTEX, Some(1), Some(1));
    assert!(chapter_drain(&mut rx).iter().any(|message| message["success"] == true));
    let vortex = world.players["hyper-effects"].hyper_vortex.clone().unwrap();
    let cooldown = world.players["hyper-effects"].skill_cooldowns[&SKILL_HYPER_VORTEX_HIDDEN];
    world.tick = vortex.next_pulse_at;
    world.step_hyper_effects();
    assert!(world.monsters[&target_id].state.freeze_stacks.is_some());
    assert_eq!(world.monsters[&target_id].state.hp, 1_000_000, "hidden vortex has no damage");
    world.monsters.get_mut(&target_id).unwrap().state.freeze_stacks = None;
    world.monsters.get_mut(&target_id).unwrap().state.x = vortex.x + 400.0;
    world.tick = world.players["hyper-effects"].hyper_vortex.as_ref().unwrap().next_pulse_at;
    world.step_hyper_effects();
    assert!(world.monsters[&target_id].state.freeze_stacks.is_none(), "vortex range is authoritative");
    world.handle_cast_skill("hyper-effects".into(), "vortex-again".into(), SKILL_HYPER_VORTEX, Some(1), Some(1));
    assert_eq!(chapter_rejection(&mut rx), "skill_cooldown");

    world.handle_reset_hyper("hyper-effects".into(), "reset".into(), 100_000);
    assert!(chapter_drain(&mut rx).iter().any(|message| message["success"] == true));
    let player = &world.players["hyper-effects"];
    assert!(player.hyper_vortex.is_none());
    assert!(!player.hyper_barrier_enabled);
    assert_eq!(player.skill_cooldowns.get(&SKILL_HYPER_VORTEX_HIDDEN), Some(&cooldown));
    assert!(player.state.skills.get(&SKILL_HYPER_VORTEX).is_none());
}
