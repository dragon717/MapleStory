#[test]
fn windbell_action_commit_rolls_back_all_rows_and_replays_by_request_id() {
    let db = Connection::open_in_memory().unwrap();
    Store::init(&db).unwrap();
    let store = Store {
        db: std::sync::Arc::new(std::sync::Mutex::new(db)),
    };
    store
        .with_db(|db| {
            db.execute_batch(
                "CREATE TRIGGER windbell_fail_bridge
                 BEFORE INSERT ON windbell_bridge_state
                 BEGIN SELECT RAISE(ABORT, 'windbell test failure'); END;",
            )
            .map_err(|_| "trigger setup failed".to_owned())
        })
        .unwrap();

    let failed = store.commit_windbell_action(
        "a",
        "windbell-r1",
        "deliverPlank",
        "{\"action\":\"deliverPlank\"}",
        Some(("{\"sourcePlanks\":5}", 1)),
        Some("{\"deliveredPlanks\":1}"),
        None,
    );
    assert!(failed.is_err(), "the injected bridge failure must reject the transaction");
    assert!(store.load_windbell_action("a", "windbell-r1").unwrap().is_none());
    assert!(store.load_windbell_bridge_state("windbell").unwrap().is_none());
    assert!(store.load_windbell_player_state("a").unwrap().is_none());

    store
        .with_db(|db| {
            db.execute_batch("DROP TRIGGER windbell_fail_bridge")
                .map_err(|_| "trigger cleanup failed".to_owned())
        })
        .unwrap();
    assert!(store
        .commit_windbell_action(
            "a",
            "windbell-r1",
            "deliverPlank",
            "{\"action\":\"deliverPlank\"}",
            Some(("{\"sourcePlanks\":5}", 1)),
            Some("{\"deliveredPlanks\":1}"),
            None,
        )
        .unwrap());
    assert!(!store
        .commit_windbell_action(
            "a",
            "windbell-r1",
            "deliverPlank",
            "{\"action\":\"deliverPlank\",\"changed\":true}",
            Some(("{\"sourcePlanks\":4}", 2)),
            Some("{\"deliveredPlanks\":2}"),
            None,
        )
        .unwrap());
    assert_eq!(
        store
            .load_windbell_bridge_state("windbell")
            .unwrap()
            .unwrap()
            .0,
        "{\"sourcePlanks\":5}"
    );
    assert_eq!(
        store
            .load_windbell_player_state("a")
            .unwrap()
            .unwrap(),
        "{\"deliveredPlanks\":1}"
    );
}
