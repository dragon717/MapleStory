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
        cash: 0,
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
    assert!(store.commit_quest("quest", QUEST, "active", &active, &[]).unwrap());

    let mut completed = active.clone();
    completed.map_id = "victoria".into();
    completed.x = 88.0;
    completed.y = 19.0;
    completed.exp = 123;
    completed.mesos = 456;
    completed.inventory = vec![item(1, "4000019", 5)];
    assert!(store.commit_quest("quest", QUEST, "completed", &completed, &[]).unwrap());

    let mut forged_retry = completed.clone();
    forged_retry.map_id = "forged-map".into();
    forged_retry.inventory = vec![item(1, "4033914", 1)];
    assert!(!store.commit_quest("quest", QUEST, "completed", &forged_retry, &[]).unwrap());
    let saved = store.load_profile("quest", &base).unwrap();
    assert_eq!((saved.map_id, saved.x, saved.y), ("victoria".into(), 88.0, 19.0));
    assert_eq!((saved.exp, saved.mesos), (123, 456));
    assert_eq!(saved.inventory, vec![item(1, "4000019", 5)]);
    assert_eq!(store.load_quests("quest").unwrap()[QUEST], "completed");

    store.load_profile("rollback", &base).unwrap();
    let mut rollback_active = base.clone();
    rollback_active.map_id = "active-map".into();
    assert!(store.commit_quest("rollback", "36302", "active", &rollback_active, &[]).unwrap());
    let mut unknown = rollback_active.clone();
    unknown.map_id = "must-rollback".into();
    unknown.exp = 999;
    unknown.mesos = 999;
    unknown.inventory = vec![item(1, "9999999", 1)];
    assert!(store.commit_quest("rollback", "36302", "completed", &unknown, &[]).is_err());
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
    assert!(store.commit_quest("recover", QUEST, "active", &active, &[]).unwrap());

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
    assert!(store.commit_quest("full", QUEST, "active", &full_active, &[]).unwrap());
    assert!(store.commit_quest_interaction("full", QUEST, HAIRPIN, 1, &full_active).is_err());
    assert_eq!(store.load_profile("full", &base).unwrap().inventory, full_active.inventory);

    let mut free = full_active.inventory.clone();
    free.pop();
    store.seed_inventory_for_test("full", &free).unwrap();
    let retry = store.load_profile("full", &base).unwrap();
    assert!(store.commit_quest_interaction("full", QUEST, HAIRPIN, 1, &retry).unwrap());
    let saved = store.load_profile("full", &base).unwrap();
    assert_eq!(saved.inventory.iter().filter(|i| i.item_id == HAIRPIN).count(), 1);
    assert_eq!(saved.inventory.len(), SLOT_LIMIT as usize);
    drop(store);
    cleanup(&path);
}

// NB-05：任务侧授予的图鉴留档（起始物品／完成奖励／任务交互）。
//
// `commit_quest` 与 `commit_quest_interaction` **不自行推断**「哪些算新发的」——它们
// 只把调用方给出的正向授予在**同一事务**里写进 `notebook_item_records`。所以这里要
// 钉住三件事：成功时留档、重放不重复留档、整笔失败时不留档。
#[test]
fn chapter_store_quest_grants_are_archived_with_the_transition() {
    use crate::auth::notebook::{
        AcquisitionSource as Src, ItemAcquisition as Grant, SCOPE_CHARACTER,
    };

    let path = std::env::temp_dir().join(format!("chapter-store-{}.sqlite3", random_id()));
    let store = open_store(&path);
    let base = defaults();
    // 只看本文件要检查的任务路径：`load_profile` 建号时会发放创角初始装备
    // （NB-05 之后同样留档），那不是任务授予，过滤掉免得给断言加噪声。
    let archived = |account: &str| {
        store
            .notebook_item_records(account)
            .unwrap()
            .into_iter()
            .filter(|row| row.source_kind != "starter")
            .map(|row| (row.item_id, row.source_kind, row.time_quality))
            .collect::<Vec<_>>()
    };
    let revision = |account: &str| store.notebook_revision(SCOPE_CHARACTER, account).unwrap();

    // 起始物品：与任务状态同事务落地，来源是任务奖励、时间依据是真实事件。
    store.load_profile("nb-quest", &base).unwrap();
    let quest_baseline = revision("nb-quest");
    let mut active = base.clone();
    active.map_id = "archive-map".into();
    let starter = [Grant {
        item_id: HAIRPIN,
        quantity: 1,
        source: Src::QuestReward,
        source_ref: Some(QUEST),
    }];
    assert!(store
        .commit_quest("nb-quest", QUEST, "active", &active, &starter)
        .unwrap());
    assert_eq!(
        archived("nb-quest"),
        vec![(
            HAIRPIN.to_owned(),
            "questReward".to_owned(),
            "event".to_owned()
        )]
    );
    assert_eq!(revision("nb-quest"), quest_baseline + 1);

    // 同一转场重放：`Ok(false)`，不写第二条事实、不刷 revision。
    assert!(!store
        .commit_quest("nb-quest", QUEST, "active", &active, &starter)
        .unwrap());
    assert_eq!(revision("nb-quest"), quest_baseline + 1);
    assert_eq!(archived("nb-quest").len(), 1);

    // 完成奖励是新的一笔提交：加一条事实、revision 前进一步（不是每件物品一步）。
    let mut completed = active.clone();
    completed.map_id = "archive-done".into();
    assert!(store
        .commit_quest(
            "nb-quest",
            QUEST,
            "completed",
            &completed,
            &[Grant {
                item_id: "4000019",
                quantity: 5,
                source: Src::QuestReward,
                source_ref: Some(QUEST),
            }],
        )
        .unwrap());
    assert_eq!(
        archived("nb-quest")
            .iter()
            .map(|row| row.0.as_str())
            .collect::<Vec<_>>(),
        vec!["4000019", HAIRPIN],
        "两条事实按 id 升序，且只推进一次 revision"
    );
    assert_eq!(revision("nb-quest"), quest_baseline + 2);

    // 整笔失败：任务转场 Err 时图鉴事实与 revision 一并回滚，不留
    // 「任务没推进、图鉴却记了获得」。
    store.load_profile("nb-quest-fail", &base).unwrap();
    let fail_baseline = revision("nb-quest-fail");
    let mut broken = base.clone();
    broken.map_id = "must-rollback".into();
    broken.inventory = vec![item(1, "9999999", 1)];
    assert!(store
        .commit_quest("nb-quest-fail", QUEST, "active", &broken, &starter)
        .is_err());
    assert!(archived("nb-quest-fail").is_empty());
    assert_eq!(revision("nb-quest-fail"), fail_baseline);

    // 任务交互：只有**本次真正补发**的数量留档；已经持有则 `Ok(false)` 且不刷。
    store.load_profile("nb-interact", &base).unwrap();
    let interact_baseline = revision("nb-interact");
    let mut interact = base.clone();
    interact.map_id = "interact-map".into();
    assert!(store
        .commit_quest("nb-interact", QUEST, "active", &interact, &[])
        .unwrap());
    assert_eq!(
        revision("nb-interact"),
        interact_baseline,
        "不发物品的转场不写事实、不刷 revision"
    );
    let snapshot = store.load_profile("nb-interact", &base).unwrap();
    assert!(store
        .commit_quest_interaction("nb-interact", QUEST, HAIRPIN, 1, &snapshot)
        .unwrap());
    assert_eq!(
        archived("nb-interact"),
        vec![(
            HAIRPIN.to_owned(),
            "questInteraction".to_owned(),
            "event".to_owned()
        )]
    );
    assert_eq!(revision("nb-interact"), interact_baseline + 1);
    let held = store.load_profile("nb-interact", &base).unwrap();
    assert!(!store
        .commit_quest_interaction("nb-interact", QUEST, HAIRPIN, 1, &held)
        .unwrap());
    assert_eq!(
        revision("nb-interact"),
        interact_baseline + 1,
        "重试不得把同一件物品记成两次获得"
    );

    drop(store);
    cleanup(&path);
}
