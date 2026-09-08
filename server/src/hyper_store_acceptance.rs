#[test]
fn hyper_store_two_pools_and_hidden_guard() {
    let path = std::env::temp_dir().join(format!("hyper-pools-{}.sqlite3", random_id()));
    let store = fourth_open(&path);
    let base = fourth_profile(
        222,
        190,
        BTreeMap::from([(FOURTH_FIXED_SKILL, 1)]),
        BTreeMap::from([(222, 8), (221, 4)]),
    );
    fourth_write_raw(&store, "pools", &base);
    for (request, skill) in [
        ("p1", 2_220_043),
        ("p2", 2_220_044),
        ("p3", 2_220_046),
        ("p4", 2_220_047),
        ("p5", 2_220_048),
    ] {
        let outcome = store
            .learn_skill("pools", request, skill, 222, 222, 99, &BTreeMap::new(), false)
            .unwrap();
        assert!(outcome.success, "{skill}: {outcome:?}");
    }
    let exhausted = store
        .learn_skill("pools", "p6", 2_220_051, 222, 222, 1, &BTreeMap::new(), false)
        .unwrap();
    assert_eq!(exhausted.code, "not_enough_hyper_points");
    let active = store
        .learn_skill("pools", "a1", 2_221_052, 222, 222, 1, &BTreeMap::new(), false)
        .unwrap();
    assert!(active.success);
    let active = store
        .learn_skill("pools", "a2", 2_221_053, 222, 222, 1, &BTreeMap::new(), false)
        .unwrap();
    assert!(active.success);
    let active = store
        .learn_skill("pools", "a3", 2_221_054, 222, 222, 1, &BTreeMap::new(), false)
        .unwrap();
    assert_eq!(active.remaining_sp, 0);
    let hidden = store
        .learn_skill("pools", "hidden", 2_221_055, 222, 222, 1, &BTreeMap::new(), true)
        .unwrap();
    assert_eq!(hidden.code, "skill_hidden");
    let hidden_cast = store
        .cast_skill("pools", "hidden-cast", 2_221_055, 222, 222, 1, 0)
        .unwrap();
    assert_eq!(hidden_cast.code, "skill_hidden");
    let saved = store.load_profile("pools", &base).unwrap();
    assert_eq!(hyper_points(saved.level, &saved.skills, 1), 0);
    assert_eq!(hyper_points(saved.level, &saved.skills, 2), 0);
    drop(store);
    fourth_cleanup(&path);
}

#[test]
fn hyper_store_mp_cooldown_pulse_replay_and_reopen() {
    let path = std::env::temp_dir().join(format!("hyper-cooldown-{}.sqlite3", random_id()));
    let store = fourth_open(&path);
    let base = fourth_profile(
        222,
        190,
        BTreeMap::from([(FOURTH_FIXED_SKILL, 1), (2_221_052, 1)]),
        BTreeMap::new(),
    );
    fourth_write_raw(&store, "combat", &base);
    let initial = store
        .cast_skill_with_cooldown("combat", "initial", 2_221_052, 222, 222, 1, 30, 60_000)
        .unwrap();
    assert!(initial.success);
    assert_eq!(initial.mp, 70);
    let replay = store
        .cast_skill_with_cooldown("combat", "initial", 2_221_052, 222, 222, 1, 99, 0)
        .unwrap();
    assert!(replay.already_resolved);
    assert_eq!(replay.mp, 70);
    let pulse = store
        .cast_skill_with_cooldown("combat", "pulse-1", 2_221_052, 222, 222, 1, 30, 0)
        .unwrap();
    assert!(pulse.success);
    assert_eq!(pulse.mp, 40);
    let pulse_replay = store
        .cast_skill_with_cooldown("combat", "pulse-1", 2_221_052, 222, 222, 1, 30, 0)
        .unwrap();
    assert!(pulse_replay.already_resolved);
    assert_eq!(pulse_replay.mp, 40);
    let blocked = store
        .cast_skill_with_cooldown("combat", "second-initial", 2_221_052, 222, 222, 1, 30, 60_000)
        .unwrap();
    assert_eq!(blocked.code, "skill_cooldown");
    assert!(store.skill_cooldown_remaining_ms("combat", 2_221_052).unwrap() > 0);
    drop(store);
    let reopened = fourth_open(&path);
    let after_reopen = reopened
        .cast_skill_with_cooldown("combat", "pulse-2", 2_221_052, 222, 222, 1, 30, 0)
        .unwrap();
    assert!(after_reopen.success);
    assert_eq!(reopened.load_profile("combat", &base).unwrap().mp, 10);
    drop(reopened);
    fourth_cleanup(&path);
}

#[test]
fn hyper_store_reset_replay_quote_tier_and_ordinary_state() {
    let path = std::env::temp_dir().join(format!("hyper-reset-{}.sqlite3", random_id()));
    let store = fourth_open(&path);
    let mut base = fourth_profile(
        222,
        190,
        BTreeMap::from([
            (FOURTH_FIXED_SKILL, 1),
            (2_220_043, 1),
            (2_221_052, 1),
            (2_221_004, 1),
        ]),
        BTreeMap::from([(222, 254), (221, 4)]),
    );
    base.mesos = 200_000;
    fourth_write_raw(&store, "reset", &base);
    let first = store.reset_hyper_skills("reset", "reset-1", 100_000).unwrap();
    assert!(first.success);
    let saved = store.load_profile("reset", &base).unwrap();
    assert_eq!(saved.mesos, 100_000);
    assert_eq!(saved.skill_points, base.skill_points);
    assert_eq!(saved.skills.get(&2_221_004), Some(&1));
    assert!(!saved.skills.contains_key(&2_220_043));
    assert_eq!(store.hyper_reset_count("reset").unwrap(), 1);
    let replay = store.reset_hyper_skills("reset", "reset-1", 100_000).unwrap();
    assert!(replay.already_resolved && replay.success);
    let conflict = store.reset_hyper_skills("reset", "reset-1", 1_000_000).unwrap();
    assert!(conflict.already_resolved);
    assert_eq!(conflict.code, "request_conflict");
    store.save_profile("reset", &saved).unwrap();
    assert_eq!(store.hyper_reset_count("reset").unwrap(), 1);
    drop(store);
    let reopened = fourth_open(&path);
    let restored = reopened.load_profile("reset", &base).unwrap();
    assert_eq!(reopened.hyper_reset_count("reset").unwrap(), 1);
    assert_eq!(restored.skill_points, base.skill_points);
    assert_eq!(restored.skills.get(&2_221_004), Some(&1));
    drop(reopened);
    fourth_cleanup(&path);
}
