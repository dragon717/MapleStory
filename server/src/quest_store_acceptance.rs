use rusqlite::Connection;
use std::{path::Path, sync::{Arc, Mutex}};

const QUEST: &str = "36301";
const HAIRPIN: &str = "4036846";

fn open_store(path: &Path) -> Store {
    let db = Connection::open(path).unwrap();
    Store::init(&db).unwrap();
    Store { db: Arc::new(Mutex::new(db)) }
}

fn defaults() -> Profile {
    Profile {
        hp: 50, max_hp: 50, mp: 5, max_mp: 5, level: 1, job: 0,
        exp: 0, exp_to_next: 15, mesos: 0, death_id: String::new(),
        map_id: String::new(), x: 0.0, y: 0.0, inventory: Vec::new(),
        skills: BTreeMap::new(), skill_points: BTreeMap::new(),
        ability_stats: AbilityStats::default(),
    }
}

fn item(slot: u16, item_id: &str, quantity: u32) -> InventoryItem {
    InventoryItem { slot, item_id: item_id.into(), quantity, ..InventoryItem::default() }
}

fn cleanup(path: &Path) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
}

#[test]
fn chapter_store_quest_commit_replay_reward_and_position() {
    let path = std::env::temp_dir().join(format!("chapter-store-{}.sqlite3", random_id()));
    let store = open_store(&path);
    let base = defaults();
    store.load_profile("quest", &base).unwrap();

    let mut active = base.clone();
    active.map_id = "maple-island".into();
    active.x = 12.5;
    active.y = 34.0;
    assert!(store.commit_quest("quest", QUEST, "active", &active).unwrap());

    let mut completed = active.clone();
    completed.map_id = "victoria".into();
    completed.x = 88.0;
    completed.y = 19.0;
    completed.exp = 123;
    completed.mesos = 456;
    completed.inventory = vec![item(1, "4000019", 5)];
    assert!(store.commit_quest("quest", QUEST, "completed", &completed).unwrap());

    let mut forged_retry = completed.clone();
    forged_retry.map_id = "forged-map".into();
    forged_retry.inventory = vec![item(1, "4033914", 1)];
    assert!(!store.commit_quest("quest", QUEST, "completed", &forged_retry).unwrap());
    let saved = store.load_profile("quest", &base).unwrap();
    assert_eq!((saved.map_id, saved.x, saved.y), ("victoria".into(), 88.0, 19.0));
    assert_eq!((saved.exp, saved.mesos), (123, 456));
    assert_eq!(saved.inventory, vec![item(1, "4000019", 5)]);
    assert_eq!(store.load_quests("quest").unwrap()[QUEST], "completed");

    store.load_profile("rollback", &base).unwrap();
    let mut rollback_active = base.clone();
    rollback_active.map_id = "active-map".into();
    assert!(store.commit_quest("rollback", "36302", "active", &rollback_active).unwrap());
    let mut unknown = rollback_active.clone();
    unknown.map_id = "must-rollback".into();
    unknown.exp = 999;
    unknown.mesos = 999;
    unknown.inventory = vec![item(1, "9999999", 1)];
    assert!(store.commit_quest("rollback", "36302", "completed", &unknown).is_err());
    let preserved = store.load_profile("rollback", &base).unwrap();
    assert_eq!((preserved.map_id, preserved.exp, preserved.mesos), ("active-map".into(), 0, 0));
    assert_eq!(store.load_quests("rollback").unwrap()["36302"], "active");
    drop(store);
    cleanup(&path);
}

#[test]
fn chapter_store_interaction_recovery_replay_and_full_bag_retry() {
    let path = std::env::temp_dir().join(format!("chapter-store-{}.sqlite3", random_id()));
    let store = open_store(&path);
    let base = defaults();
    store.load_profile("recover", &base).unwrap();
    let mut active = base.clone();
    active.map_id = "recover-map".into();
    active.x = 7.0;
    active.y = 9.0;
    assert!(store.commit_quest("recover", QUEST, "active", &active).unwrap());

    // The caller snapshot falsely claims possession; the transaction uses DB
    // inventory and repairs the missing item exactly once.
    let mut stale = active.clone();
    stale.inventory = vec![item(1, HAIRPIN, 1)];
    assert!(store.commit_quest_interaction("recover", QUEST, HAIRPIN, 1, &stale).unwrap());
    assert_eq!(store.load_profile("recover", &base).unwrap().inventory, vec![item(1, HAIRPIN, 1)]);
    drop(store);

    let store = open_store(&path);
    let reopened = store.load_profile("recover", &base).unwrap();
    assert!(!store.commit_quest_interaction("recover", QUEST, HAIRPIN, 1, &reopened).unwrap());
    assert_eq!(store.load_profile("recover", &base).unwrap().inventory, vec![item(1, HAIRPIN, 1)]);

    let mut full_active = base.clone();
    full_active.map_id = "full-map".into();
    full_active.inventory = (1..=SLOT_LIMIT).map(|slot| item(slot, "4000019", 1)).collect();
    store.load_profile("full", &base).unwrap();
    assert!(store.commit_quest("full", QUEST, "active", &full_active).unwrap());
    assert!(store.commit_quest_interaction("full", QUEST, HAIRPIN, 1, &full_active).is_err());
    assert_eq!(store.load_profile("full", &base).unwrap().inventory, full_active.inventory);

    let mut free = full_active.inventory.clone();
    free.pop();
    store.write_inventory("full", &free).unwrap();
    let retry = store.load_profile("full", &base).unwrap();
    assert!(store.commit_quest_interaction("full", QUEST, HAIRPIN, 1, &retry).unwrap());
    let saved = store.load_profile("full", &base).unwrap();
    assert_eq!(saved.inventory.iter().filter(|i| i.item_id == HAIRPIN).count(), 1);
    assert_eq!(saved.inventory.len(), SLOT_LIMIT as usize);
    drop(store);
    cleanup(&path);
}
