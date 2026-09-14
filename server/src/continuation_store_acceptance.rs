use rusqlite::Connection as ContinuationConnection;
use std::{
    path::Path as ContinuationPath,
    sync::{Arc as ContinuationArc, Mutex as ContinuationMutex},
};

fn continuation_open(path: &ContinuationPath) -> Store {
    let db = ContinuationConnection::open(path).unwrap();
    Store::init(&db).unwrap();
    Store { db: ContinuationArc::new(ContinuationMutex::new(db)) }
}

fn continuation_profile(job: u32, level: u32, mp: i64, max_mp: i64) -> Profile {
    let (skills, points) = if job == FOURTH_JOB {
        (BTreeMap::from([(FOURTH_FIXED_SKILL, 1)]), BTreeMap::from([(FOURTH_MAGE_BOOK, 3)]))
    } else {
        (BTreeMap::new(), BTreeMap::from([(job, 2)]))
    };
    Profile {
        hp: 50, max_hp: 50, mp, max_mp, level, job, exp: 0, exp_to_next: 15,
        mesos: 0, death_id: String::new(), map_id: "101000003".into(), x: 4.0, y: 8.0,
        cash: 0,
        inventory: Vec::new(), skills, skill_points: points,
        ability_stats: AbilityStats::default(),
    }
}

fn continuation_seed(store: &Store, id: &str, profile: &Profile, prerequisite: bool) {
    store.load_profile(id, profile).unwrap();
    store.save_profile(id, profile).unwrap();
    if prerequisite { store.save_quest(id, "36307", "completed").unwrap(); }
    store.save_quest(id, "1402", "active").unwrap();
}

fn continuation_cleanup(path: &ContinuationPath) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
}

#[test]
fn continuation_store_q1402_gate_transfer_replay_and_reopen() {
    let path = std::env::temp_dir().join(format!("continuation-q1402-{}.sqlite3", random_id()));
    let store = continuation_open(&path);
    let mut base = continuation_profile(0, 8, 5, 5);
    base.skills.insert(1001, 1);
    base.skill_points.insert(0, 5);
    continuation_seed(&store, "bad", &base, true);
    let mut bad = store.load_profile("bad", &base).unwrap();
    grant_first_mage(&mut bad);
    bad.skill_points.insert(MAGE_BOOK, 6);
    assert!(store.commit_quest("bad", "1402", "completed", &bad).is_err());
    assert_eq!(store.load_profile("bad", &base).unwrap().job, 0);
    assert_eq!(store.load_quests("bad").unwrap()["1402"], "active");

    let low = continuation_profile(0, 7, 5, 5);
    continuation_seed(&store, "low", &low, true);
    let mut low_candidate = store.load_profile("low", &low).unwrap();
    grant_first_mage(&mut low_candidate);
    assert!(store.commit_quest("low", "1402", "completed", &low_candidate).is_err());
    let missing = continuation_profile(0, 10, 5, 5);
    continuation_seed(&store, "missing", &missing, false);
    let mut missing_candidate = store.load_profile("missing", &missing).unwrap();
    grant_first_mage(&mut missing_candidate);
    assert!(store.commit_quest("missing", "1402", "completed", &missing_candidate).is_err());

    continuation_seed(&store, "mage", &base, true);
    let mut candidate = store.load_profile("mage", &base).unwrap();
    grant_first_mage(&mut candidate);
    assert!(store.commit_quest("mage", "1402", "completed", &candidate).unwrap());
    let promoted = store.load_profile("mage", &base).unwrap();
    assert_eq!((promoted.job, promoted.max_mp, promoted.mp), (200, 100, 100));
    assert_eq!(promoted.skills.get(&1001), Some(&1));
    assert_eq!(promoted.skill_points[&MAGE_BOOK], 5);
    assert!(store
        .cast_skill_with_cooldown("mage", "beginner-after-transfer", 1001, 0, 0, 3, 5, 0)
        .unwrap()
        .success);
    let marker: i64 = {
        let db = store.db.lock().unwrap();
        db.query_row("SELECT mage_support_granted FROM player_stats WHERE account_id='mage'", [], |row| row.get(0)).unwrap()
    };
    assert_eq!(marker, 1);
    let mut spent = promoted.clone();
    spent.mp = 17;
    store.save_profile("mage", &spent).unwrap();
    assert!(!store.ensure_mage_support("mage").unwrap());
    assert_eq!(store.load_profile("mage", &base).unwrap().mp, 17);
    drop(store);

    let reopened = continuation_open(&path);
    let mut forged = reopened.load_profile("mage", &base).unwrap();
    forged.skill_points.insert(MAGE_BOOK, 99);
    forged.mp = 100;
    assert!(!reopened.commit_quest("mage", "1402", "completed", &forged).unwrap());
    let saved = reopened.load_profile("mage", &base).unwrap();
    assert_eq!((saved.job, saved.skill_points[&MAGE_BOOK], saved.mp), (200, 5, 17));
    drop(reopened);
    continuation_cleanup(&path);
}

#[test]
fn continuation_store_story_recovery_preserves_existing_jobs() {
    let path = std::env::temp_dir().join(format!("continuation-recovery-{}.sqlite3", random_id()));
    let store = continuation_open(&path);
    for (job, mp, max_mp) in [(200, 17, 100), (220, 23, 120), (221, 31, 140), (222, 37, 160)] {
        let id = format!("recovery-{job}");
        let profile = continuation_profile(job, 100, mp, max_mp);
        continuation_seed(&store, &id, &profile, true);
        let candidate = store.load_profile(&id, &profile).unwrap();
        assert!(store.commit_quest(&id, "1402", "completed", &candidate).unwrap());
        let saved = store.load_profile(&id, &profile).unwrap();
        assert_eq!((saved.job, saved.mp, saved.max_mp), (job, mp, max_mp));
        assert_eq!(saved.skill_points, candidate.skill_points);
        assert_eq!(store.load_quests(&id).unwrap()["1402"], "completed");
    }
    drop(store);
    continuation_cleanup(&path);
}
