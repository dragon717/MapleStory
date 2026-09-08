fn attack_store_profile() -> Profile {
    Profile {
        hp: 50, max_hp: 50, mp: 5, max_mp: 5, level: 1, job: 0,
        exp: 0, exp_to_next: 1_000, mesos: 0, death_id: String::new(),
        map_id: String::new(), x: 0.0, y: 0.0, inventory: Vec::new(),
        skills: BTreeMap::new(), skill_points: BTreeMap::new(),
        ability_stats: AbilityStats::default(),
    }
}

fn attack_store_open(path: &std::path::Path) -> Store {
    let db = rusqlite::Connection::open(path).unwrap();
    Store::init(&db).unwrap();
    Store { db: std::sync::Arc::new(std::sync::Mutex::new(db)) }
}

fn attack_store_cleanup(path: &std::path::Path) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
}

#[test]
fn attack_store_schema_migration_and_map_binding_guards() {
    let path = std::env::temp_dir().join(format!("attack-store-schema-{}.sqlite3", random_id()));
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(
        "CREATE TABLE attack_actions(
           account_id TEXT NOT NULL, request_id TEXT NOT NULL, action_id TEXT NOT NULL,
           event TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0, target_id TEXT,
           damage INTEGER NOT NULL DEFAULT 0, killed INTEGER NOT NULL DEFAULT 0,
           exp_gain INTEGER NOT NULL DEFAULT 0, drop_id TEXT, drop_item_id TEXT,
           drop_quantity INTEGER, drop_x REAL, drop_y REAL,
           PRIMARY KEY(account_id,request_id), UNIQUE(account_id,action_id));
         CREATE TABLE monster_rewards(
           monster_id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
           request_id TEXT NOT NULL, exp_gain INTEGER NOT NULL, drop_id TEXT);",
    ).unwrap();
    Store::init(&db).unwrap();
    for (table, column) in [("attack_actions", "map_id"), ("monster_rewards", "practice")] {
        let found: String = db.query_row(
            &format!("SELECT name FROM pragma_table_info('{table}') WHERE name='{column}'"),
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(found, column);
    }
    db.execute(
        "INSERT INTO attack_actions(account_id,request_id,action_id,event)
         VALUES('legacy','old-request','old-action','old-event')", [],
    ).unwrap();
    let store = Store { db: std::sync::Arc::new(std::sync::Mutex::new(db)) };
    assert!(store.claim_attack("legacy", "formal-map", "old-request", "retry", "event").is_err());
    assert!(store.resolve_attack(
        "legacy", "practice:102020500:old", "old-request", Some("mob"), 1, true, 9, 1,
        &[], &[1], &["legacy".into()],
    ).is_err());

    let practice = "practice:102020500:enc-1";
    store.claim_attack("new", practice, "request", "action", "event").unwrap();
    drop(store);
    let store = attack_store_open(&path);
    assert_eq!(store.claim_attack("new", practice, "request", "retry", "event").unwrap().action_id, "action");
    assert!(store.claim_attack("new", "102020500", "request", "retry", "event").is_err());
    assert!(store.resolve_attack(
        "new", "102020500", "request", Some("mob"), 1, true, 9, 1,
        &[], &[1], &["new".into()],
    ).is_err());
    drop(store);
    attack_store_cleanup(&path);
}

#[test]
fn attack_store_practice_replay_and_formal_reward_are_separate() {
    let path = std::env::temp_dir().join(format!("attack-store-reward-{}.sqlite3", random_id()));
    let store = attack_store_open(&path);
    let base = attack_store_profile();
    store.load_profile("practice", &base).unwrap();
    store.load_profile("formal", &base).unwrap();
    let practice_map = "practice:102020500:enc-2";
    let practice_drop = DropRecord { id: "practice-drop".into(), item_id: "4000019".into(), quantity: 1, ..DropRecord::default() };
    store.claim_attack("practice", practice_map, "practice-request", "practice-action", "event").unwrap();
    let settled = store.resolve_attack(
        "practice", practice_map, "practice-request", Some("practice-mob"), 7, true, 99, 7,
        &[practice_drop.clone()], &[1_000], &["practice".into()],
    ).unwrap();
    assert_eq!((settled.exp_gain, settled.drops.len()), (0, 0));
    let db = store.db.lock().unwrap();
    let ledger: (i64, i64) = db.query_row(
        "SELECT practice,exp_gain FROM monster_rewards WHERE monster_id='practice-mob'", [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    assert_eq!(ledger, (1, 0));
    drop(db);
    drop(store);
    let store = attack_store_open(&path);
    let replay = store.resolve_attack(
        "practice", "102020500", "practice-request", Some("formal-mob"), 7, true, 999, 7,
        &[practice_drop], &[1_000], &["practice".into()],
    ).unwrap();
    assert!(replay.already_resolved);
    assert_eq!((replay.exp_gain, replay.drops.len()), (0, 0));
    assert!(store.claim_attack("practice", "102020500", "practice-request", "retry", "event").unwrap().resolved);
    assert_eq!(store.load_profile("practice", &base).unwrap().exp, 0);

    let formal_drop = DropRecord { id: "formal-drop".into(), item_id: "4000019".into(), quantity: 1, ..DropRecord::default() };
    store.claim_attack("formal", "102020500", "formal-request", "formal-action", "event").unwrap();
    let formal = store.resolve_attack(
        "formal", "102020500", "formal-request", Some("formal-mob"), 7, true, 17, 7,
        &[formal_drop], &[1_000], &["formal".into()],
    ).unwrap();
    assert_eq!((formal.exp_gain, formal.drops.len()), (17, 1));
    assert_eq!(store.load_profile("formal", &base).unwrap().exp, 17);
    let db = store.db.lock().unwrap();
    let practice: i64 = db.query_row(
        "SELECT practice FROM monster_rewards WHERE monster_id='formal-mob'", [], |row| row.get(0),
    ).unwrap();
    assert_eq!(practice, 0);
    drop(db);
    drop(store);
    attack_store_cleanup(&path);
}
