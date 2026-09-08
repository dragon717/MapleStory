use rusqlite::Connection as ThirdConnection;
use std::{path::Path as ThirdPath, sync::{Arc as ThirdArc, Mutex as ThirdMutex}};

const THIRD_SKILL: u32 = 2_211_002;
const ADAPTATION: u32 = 2_211_012;
const HIDDEN_SUMMON: u32 = 2_211_015;

fn third_open_store(path: &ThirdPath) -> Store {
    let db = ThirdConnection::open(path).unwrap();
    Store::init(&db).unwrap();
    Store { db: ThirdArc::new(ThirdMutex::new(db)) }
}

fn third_profile(job: u32, level: u32, mp: i64, skills: BTreeMap<u32, u32>, points: BTreeMap<u32, u32>) -> Profile {
    Profile {
        hp: 50, max_hp: 50, mp, max_mp: mp, level, job, exp: 0, exp_to_next: 1,
        mesos: 0, death_id: String::new(), map_id: String::new(), x: 0.0, y: 0.0,
        inventory: Vec::new(), skills, skill_points: points, ability_stats: AbilityStats::default(),
    }
}

fn third_seed(store: &Store, id: &str, profile: &Profile) {
    store.load_profile(id, profile).unwrap();
    store.save_profile(id, profile).unwrap();
}

fn third_ready(store: &Store, id: &str, skill: u32) -> i64 {
    let db = store.db.lock().unwrap();
    db.query_row(
        "SELECT ready_at_ms FROM skill_cooldowns WHERE account_id=?1 AND skill_id=?2",
        params![id, i64::from(skill)],
        |row| row.get(0),
    ).unwrap()
}

fn third_cleanup(path: &ThirdPath) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
}

#[test]
fn third_store_transfer_gate_preserves_state_and_rejects_hidden() {
    let path = std::env::temp_dir().join(format!("third-store-{}.sqlite3", random_id()));
    let store = third_open_store(&path);
    let mut base = third_profile(220, 59, 50, BTreeMap::from([(2201008, 3)]), BTreeMap::from([(200, 7), (220, 4)]));
    base.ability_stats.available_ap = 17;
    base.map_id = "001020000".into(); base.x = 123.0; base.y = 456.0;
    third_seed(&store, "third", &base);
    assert!(!store.advance_job("third", 220, 221).unwrap());
    assert!(!store.advance_job("third", 220, 222).unwrap());
    assert!(!store.advance_job("third", 0, 221).unwrap());
    let mut eligible = store.load_profile("third", &base).unwrap();
    eligible.level = 60;
    store.save_profile("third", &eligible).unwrap();
    assert!(store.advance_job("third", 220, 221).unwrap());
    let promoted = store.load_profile("third", &base).unwrap();
    assert_eq!(promoted.job, 221);
    assert_eq!(promoted.ability_stats, base.ability_stats);
    assert_eq!((promoted.map_id, promoted.x, promoted.y), (base.map_id.clone(), base.x, base.y));
    assert_eq!(promoted.skill_points.get(&200), Some(&7));
    assert_eq!(promoted.skill_points.get(&220), Some(&4));
    assert_eq!(promoted.skill_points.get(&221), Some(&5));
    assert_eq!(promoted.skills.get(&2201008), Some(&3));
    assert!(!store.advance_job("third", 220, 221).unwrap());

    let old = third_profile(221, 60, 50, BTreeMap::new(), BTreeMap::from([(220, 4)]));
    third_seed(&store, "old-221", &old);
    assert!(!store.advance_job("old-221", 220, 221).unwrap());
    assert!(!store.load_profile("old-221", &old).unwrap().skill_points.contains_key(&221));
    let learned = store.learn_skill("third", "hidden-learn", HIDDEN_SUMMON, 221, 221, 1, &BTreeMap::new(), true).unwrap();
    assert!(!learned.success);
    assert_eq!(learned.code, "skill_hidden");
    let cast = store.cast_skill_with_cooldown("third", "hidden-cast", HIDDEN_SUMMON, 221, 221, 1, 1, 60_000).unwrap();
    assert!(!cast.success);
    assert_eq!(cast.code, "skill_hidden");
    assert_eq!(store.load_profile("third", &base).unwrap().mp, 50);
    drop(store);
    third_cleanup(&path);
}

#[test]
fn third_store_book_split_and_222_compatibility() {
    let mut third = third_profile(221, 60, 100, BTreeMap::new(), BTreeMap::from([(220, 4), (221, 5)]));
    add_exp(&mut third, 1, &vec![1; 64]);
    assert_eq!(third.level, 61);
    assert_eq!(third.skill_points.get(&221), Some(&8));
    assert_eq!(third.skill_points.get(&220), Some(&4));
    assert!(!third.skill_points.contains_key(&222));
    third.job = 222;
    third.level = 60;
    third.exp = 0;
    third.skill_points = BTreeMap::from([(220, 4), (221, 2)]);
    add_exp(&mut third, 1, &vec![1; 64]);
    assert_eq!(third.skill_points.get(&220), Some(&7));
    assert_eq!(third.skill_points.get(&221), Some(&2));
    assert!(!third.skill_points.contains_key(&222));

    let path = std::env::temp_dir().join(format!("third-book-{}.sqlite3", random_id()));
    let store = third_open_store(&path);
    third_seed(&store, "compat-222", &third);
    let learned = store.learn_skill("compat-222", "third-learn", THIRD_SKILL, 221, 221, 20, &BTreeMap::new(), false).unwrap();
    assert!(learned.success);
    assert_eq!(learned.remaining_sp, 1);
    let cast = store.cast_skill("compat-222", "third-cast", THIRD_SKILL, 221, 221, 20, 1).unwrap();
    assert!(cast.success);
    drop(store);
    third_cleanup(&path);
}

#[test]
fn third_store_cooldown_replays_and_survives_reopen() {
    let path = std::env::temp_dir().join(format!("third-cooldown-{}.sqlite3", random_id()));
    let store = third_open_store(&path);
    let profile = third_profile(221, 60, 100, BTreeMap::from([(ADAPTATION, 1)]), BTreeMap::from([(221, 5)]));
    third_seed(&store, "cool", &profile);
    let first = store.cast_skill_with_cooldown("cool", "cast-1", ADAPTATION, 221, 221, 20, 10, 60_000).unwrap();
    assert!(first.success);
    assert_eq!(first.mp, 90);
    let ready = third_ready(&store, "cool", ADAPTATION);
    let replay = store.cast_skill_with_cooldown("cool", "cast-1", ADAPTATION, 221, 221, 20, 99, 120_000).unwrap();
    assert!(replay.already_resolved);
    assert_eq!(replay.mp, 90);
    assert_eq!(third_ready(&store, "cool", ADAPTATION), ready);
    let blocked = store.cast_skill_with_cooldown("cool", "cast-2", ADAPTATION, 221, 221, 20, 10, 60_000).unwrap();
    assert!(!blocked.success);
    assert_eq!(blocked.code, "skill_cooldown");
    assert_eq!(store.load_profile("cool", &profile).unwrap().mp, 90);
    drop(store);
    let store = third_open_store(&path);
    assert!(store.skill_cooldown_remaining_ms("cool", ADAPTATION).unwrap() > 0);
    let replay = store.cast_skill_with_cooldown("cool", "cast-1", ADAPTATION, 221, 221, 20, 1, 1).unwrap();
    assert!(replay.already_resolved);
    assert_eq!(replay.mp, 90);
    drop(store);
    third_cleanup(&path);
}
