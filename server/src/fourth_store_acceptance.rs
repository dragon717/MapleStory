use rusqlite::Connection as FourthConnection;
use std::{path::Path as FourthPath, sync::{Arc as FourthArc, Mutex as FourthMutex}};

const FOURTH_TEST_BOOK: u32 = 222;
const FOURTH_TEST_FIXED: u32 = 2_220_015;

fn fourth_open(path: &FourthPath) -> Store {
    let db = FourthConnection::open(path).unwrap();
    Store::init(&db).unwrap();
    Store { db: FourthArc::new(FourthMutex::new(db)) }
}

fn fourth_profile(job: u32, level: u32, skills: BTreeMap<u32, u32>, points: BTreeMap<u32, u32>) -> Profile {
    Profile {
        hp: 50, max_hp: 50, mp: 100, max_mp: 100, level, job, exp: 0,
        exp_to_next: 1, mesos: 0, death_id: String::new(), map_id: String::new(),
        cash: 0,
        x: 0.0, y: 0.0, inventory: Vec::new(), skills, skill_points: points,
        ability_stats: AbilityStats::default(),
    }
}

fn fourth_write_raw(store: &Store, id: &str, profile: &Profile) {
    let base = fourth_profile(0, 1, BTreeMap::new(), BTreeMap::new());
    store.load_profile(id, &base).unwrap();
    store.save_profile(id, profile).unwrap();
}

fn fourth_cleanup(path: &FourthPath) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
}

#[test]
fn fourth_store_transfer_is_gated_cas_and_atomic() {
    let path = std::env::temp_dir().join(format!("fourth-transfer-{}.sqlite3", random_id()));
    let store = fourth_open(&path);
    let old = fourth_profile(221, 99, BTreeMap::new(), BTreeMap::from([(221, 7), (222, 0)]));
    fourth_write_raw(&store, "transfer", &old);
    assert!(!store.advance_job("transfer", 221, 222).unwrap());
    assert_eq!(store.load_profile("transfer", &old).unwrap().job, 221);

    let mut eligible = old.clone();
    eligible.level = 100;
    eligible.skills.insert(2_221_004, 1);
    store.save_profile("transfer", &eligible).unwrap();
    assert!(store.advance_job("transfer", 221, 222).unwrap());
    let promoted = store.load_profile("transfer", &old).unwrap();
    assert_eq!(promoted.job, 222);
    assert_eq!(promoted.skills.get(&FOURTH_TEST_FIXED), Some(&1));
    assert_eq!(promoted.skill_points.get(&FOURTH_TEST_BOOK), Some(&2));
    assert_eq!(promoted.skill_points.get(&221), Some(&7));
    assert!(!store.advance_job("transfer", 221, 222).unwrap());
    assert_eq!(store.load_profile("transfer", &old).unwrap().skill_points, promoted.skill_points);
    drop(store);
    fourth_cleanup(&path);
}

#[test]
fn fourth_store_legacy_repair_is_bounded_and_idempotent() {
    let path = std::env::temp_dir().join(format!("fourth-repair-{}.sqlite3", random_id()));
    let store = fourth_open(&path);
    let legacy = fourth_profile(
        222, 140,
        BTreeMap::from([(FOURTH_TEST_FIXED, 0), (2_221_004, 7)]),
        BTreeMap::from([(FOURTH_TEST_BOOK, 10), (220, 4)]),
    );
    fourth_write_raw(&store, "legacy", &legacy);
    let repaired = store.load_profile("legacy", &legacy).unwrap();
    assert_eq!(repaired.skills.get(&FOURTH_TEST_FIXED), Some(&1));
    assert_eq!(repaired.skill_points.get(&FOURTH_TEST_BOOK), Some(&248));
    assert_eq!(repaired.skill_points.get(&220), Some(&4));
    assert_eq!(store.load_profile("legacy", &legacy).unwrap().skill_points, repaired.skill_points);

    let low = fourth_profile(222, 99, BTreeMap::from([(FOURTH_TEST_FIXED, 0)]), BTreeMap::new());
    fourth_write_raw(&store, "low", &low);
    let low_loaded = store.load_profile("low", &low).unwrap();
    assert_eq!(low_loaded.skills.get(&FOURTH_TEST_FIXED), Some(&1));
    assert!(!low_loaded.skill_points.contains_key(&FOURTH_TEST_BOOK));
    drop(store);
    fourth_cleanup(&path);
}

#[test]
fn fourth_store_sp_schedule_caps_and_skill_guards() {
    let mut profile = fourth_profile(222, 100, BTreeMap::new(), BTreeMap::from([(FOURTH_TEST_BOOK, 3)]));
    let exp_table = vec![1; 180];
    add_exp(&mut profile, 10, &exp_table);
    assert_eq!((profile.level, profile.skill_points[&FOURTH_TEST_BOOK]), (110, 45));
    add_exp(&mut profile, 10, &exp_table);
    assert_eq!((profile.level, profile.skill_points[&FOURTH_TEST_BOOK]), (120, 101));
    add_exp(&mut profile, 10, &exp_table);
    assert_eq!((profile.level, profile.skill_points[&FOURTH_TEST_BOOK]), (130, 171));
    add_exp(&mut profile, 10, &exp_table);
    assert_eq!((profile.level, profile.skill_points[&FOURTH_TEST_BOOK]), (140, 255));
    add_exp(&mut profile, 1, &exp_table);
    assert_eq!((profile.level, profile.skill_points[&FOURTH_TEST_BOOK]), (141, 255));

    let path = std::env::temp_dir().join(format!("fourth-guards-{}.sqlite3", random_id()));
    let store = fourth_open(&path);
    let guarded = fourth_profile(222, 100, BTreeMap::from([(FOURTH_TEST_FIXED, 1)]), BTreeMap::from([(222, 1)]));
    fourth_write_raw(&store, "guards", &guarded);
    let prereq = store.learn_skill("guards", "pre", 2_221_005, 222, 222, 30, &BTreeMap::from([(2_200_006, 10)]), false).unwrap();
    assert_eq!(prereq.code, "prerequisite");
    let hidden = store.learn_skill("guards", "hidden", 2_220_014, 222, 222, 1, &BTreeMap::new(), false).unwrap();
    assert_eq!(hidden.code, "skill_hidden");
    let fixed = store.learn_skill("guards", "fixed", FOURTH_TEST_FIXED, 222, 222, 1, &BTreeMap::new(), false).unwrap();
    assert_eq!(fixed.code, "skill_fixed_level");
    let passive = store.cast_skill("guards", "passive", 2_220_010, 222, 222, 30, 0).unwrap();
    assert_eq!(passive.code, "skill_passive");
    drop(store);
    fourth_cleanup(&path);
}

#[test]
fn fourth_store_cast_replay_and_cooldown_survive_reopen() {
    let path = std::env::temp_dir().join(format!("fourth-cast-{}.sqlite3", random_id()));
    let store = fourth_open(&path);
    let base = fourth_profile(222, 100, BTreeMap::from([(2_221_004, 1)]), BTreeMap::new());
    fourth_write_raw(&store, "caster", &base);
    let first = store.cast_skill_with_cooldown("caster", "infinity", 2_221_004, 222, 222, 30, 45, 180_000).unwrap();
    assert!(first.success);
    assert_eq!(first.mp, 55);
    drop(store);
    let store = fourth_open(&path);
    assert!(store.cast_skill_with_cooldown("caster", "infinity", 2_221_004, 222, 222, 30, 45, 180_000).unwrap().already_resolved);
    assert_eq!(store.cast_skill_with_cooldown("caster", "again", 2_221_004, 222, 222, 30, 45, 180_000).unwrap().code, "skill_cooldown");
    assert_eq!(store.load_profile("caster", &base).unwrap().mp, 55);
    drop(store);
    fourth_cleanup(&path);
}
