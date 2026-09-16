// 拾取去处的定向验收（审查文档 §7 增量 3）。
//
// 覆盖的是"一件已被认领的掉落物往哪里去"这三条支路的**行为等价性**：
// 金币进 profile、卡片饱和、背包会拒绝并把掉落放回地上。全部走真实
// `Store::pickup`（临时库），不直接调 `apply_pickup_sink_tx`——后者是 SQL
// 归属层的内部函数，缺了事务编排就测不到"拒绝后恢复"这条最关键的分支。
//
// 分类真值表与 `can_refuse()` 的类型级性质在 `auth/item_world.rs` 自带测试里
// （`PickupSink` 只对 `auth` 可见，不能搬到这里）。

use crate::auth::{self, Profile};
use rusqlite::Connection;
use std::collections::BTreeMap;

fn profile() -> Profile {
    Profile {
        hp: 10,
        max_hp: 50,
        mp: 1,
        max_mp: 5,
        level: 5,
        job: 0,
        exp: 0,
        exp_to_next: 15,
        mesos: 1_000,
        cash: 0,
        death_id: String::new(),
        map_id: String::new(),
        x: 0.0,
        y: 0.0,
        inventory: Vec::new(),
        skills: BTreeMap::new(),
        skill_points: BTreeMap::new(),
        ability_stats: crate::protocol::AbilityStats::default(),
    }
}

fn sink_world(label: &str) -> (std::path::PathBuf, auth::Store) {
    let path = std::env::temp_dir().join(format!(
        "maple-pickup-sink-{label}-{}.sqlite3",
        auth::random_id()
    ));
    let service = auth::start(&path).unwrap();
    let store = service.store.clone();
    store.load_profile("a", &profile()).unwrap();
    (path, store)
}

fn drop_on(path: &std::path::Path, id: &str, item_id: &str, quantity: i64) {
    let db = Connection::open(path).unwrap();
    db.execute(
        "INSERT INTO drops(id,map_id,item_id,quantity,x,y,active) VALUES (?1,'map',?2,?3,0,0,1)",
        rusqlite::params![id, item_id, quantity],
    )
    .unwrap();
}

fn notebook_rows(path: &std::path::Path) -> i64 {
    let db = Connection::open(path).unwrap();
    db.query_row("SELECT COUNT(*) FROM notebook_item_records", [], |row| row.get(0))
        .unwrap()
}

fn drop_active(path: &std::path::Path, id: &str) -> bool {
    let db = Connection::open(path).unwrap();
    db.query_row(
        "SELECT active FROM drops WHERE id=?1",
        [id],
        |row| row.get::<_, i64>(0),
    )
    .unwrap()
        == 1
}

#[test]
fn mesos_pickup_credits_the_profile_without_touching_inventory_or_notebook() {
    let (path, store) = sink_world("mesos");
    drop_on(&path, "meso", "0", 700);
    let before = notebook_rows(&path);

    let outcome = store.pickup("a", "map", "meso-1", "meso").unwrap();
    assert!(outcome.success, "{}", outcome.code);
    // 金币去处没有槽位概念：`slot` 必须是 None，客户端不能把它当背包格。
    assert_eq!(outcome.slot, None);

    let loaded = store.load_profile("a", &profile()).unwrap();
    assert_eq!(loaded.mesos, 1_700);
    // 金币不是物品（世界模型 §2.4.6）：不进背包，也不产生图鉴获得记录。
    assert!(loaded.inventory.is_empty());
    assert_eq!(
        notebook_rows(&path),
        before,
        "金币入账不得产生图鉴获得记录"
    );
    // 认领过就是认领过，重放同一 request 不会再加一次。
    let replay = store.pickup("a", "map", "meso-1", "meso").unwrap();
    assert!(replay.success);
    assert_eq!(store.load_profile("a", &profile()).unwrap().mesos, 1_700);
}

#[test]
fn monster_book_card_saturates_at_five_and_still_claims_the_drop() {
    let (path, store) = sink_world("card");
    {
        let db = Connection::open(&path).unwrap();
        // 先把这一张卡顶到上限，模拟"已经收满"。
        db.execute(
            "INSERT INTO monster_book_cards(account_id,item_id,quantity) VALUES ('a','2380000',5)",
            [],
        )
        .unwrap();
    }
    drop_on(&path, "card", "2380000", 3);

    let outcome = store.pickup("a", "map", "card-1", "card").unwrap();
    // 饱和不是拒绝：掉落照样被认领，玩家不会看到"拿不起来"。
    assert!(outcome.success, "{}", outcome.code);
    assert!(!drop_active(&path, "card"), "饱和的卡片也必须被认领掉");
    assert_eq!(
        store.load_monster_book("a").unwrap().get("2380000"),
        Some(&5),
        "持久化计数封顶在 5，不能被 3 张溢出顶穿"
    );
    // 卡片不进背包（`consumeOnPickup` 当场消耗）。
    assert!(store
        .load_profile("a", &profile())
        .unwrap()
        .inventory
        .is_empty());

    // 未饱和时正常累加：换一个角色（同一张卡、干净状态）收 2 张，计数应当是 2。
    // 复用同一张 2380000 而不是猜第二个卡片 id——卡片不在物品目录里，能确认
    // `consumeOnPickup` 的只有这一个已知样本。
    let (fresh_path, fresh_store) = sink_world("card-fresh");
    drop_on(&fresh_path, "card2", "2380000", 2);
    assert!(fresh_store
        .pickup("a", "map", "card-2", "card2")
        .unwrap()
        .success);
    assert_eq!(
        fresh_store.load_monster_book("a").unwrap().get("2380000"),
        Some(&2)
    );
}

#[test]
fn inventory_sink_refusal_restores_the_drop_and_a_later_pickup_succeeds() {
    let (path, store) = sink_world("full");
    {
        let db = Connection::open(&path).unwrap();
        // 占满消耗页签的每一格。填充物是**另一种**药水，所以它永远不可能靠合
        // 并吸收掉要拾取的那一瓶（与 `shop_buy_acceptance` 的满页签夹具同口径）。
        // 页签容量有下限（`read_inventory_slots_tx` 会把写入值 clamp 到
        // `SLOT_LIMIT`），所以不能靠改 `inventory_slots_json` 把页签缩小。
        let mut stmt = db
            .prepare(
                "INSERT INTO inventory(account_id,inventory_type,slot,item_id,quantity)
                 VALUES ('a',2,?1,'2000002',1)",
            )
            .unwrap();
        for slot in 1..=i64::from(crate::inventory::SLOT_LIMIT) {
            stmt.execute([slot]).unwrap();
        }
    }
    drop_on(&path, "full", "2000000", 1);

    let denied = store.pickup("a", "map", "full-1", "full").unwrap();
    assert!(!denied.success);
    assert_eq!(denied.code, "inventory_full");
    // 唯一的会拒绝的去处被拒时，掉落必须回到地上，否则物品凭空消失。
    assert!(drop_active(&path, "full"), "被拒绝的掉落必须仍然可拾取");

    // 腾出一格后换个 request id 就能拿起来（换 id 才代表一次新意图）。
    {
        let db = Connection::open(&path).unwrap();
        db.execute(
            "DELETE FROM inventory WHERE account_id='a' AND inventory_type=2 AND slot=1",
            [],
        )
        .unwrap();
    }
    let retry = store.pickup("a", "map", "full-2", "full").unwrap();
    assert!(retry.success, "{}", retry.code);
    assert!(retry.slot.is_some(), "进背包的拾取必须带回槽位");
    assert_eq!(
        store
            .load_profile("a", &profile())
            .unwrap()
            .inventory
            .iter()
            .find(|item| item.item_id == "2000000")
            .map(|item| item.quantity),
        Some(1)
    );
    // 同一 request 重放只回原结果，不会再加一瓶。
    assert!(store.pickup("a", "map", "full-2", "full").unwrap().success);
    assert_eq!(
        store
            .load_profile("a", &profile())
            .unwrap()
            .inventory
            .iter()
            .find(|item| item.item_id == "2000000")
            .map(|item| item.quantity),
        Some(1)
    );
}

#[test]
fn a_normal_item_pickup_leaves_a_notebook_record_the_mesos_path_does_not() {
    // 反向对照：上面的金币用例断言"没有记录"，这里证明"有记录"的那条路本来
    // 就是通的，否则"没有记录"可能只是因为留档整体没接上。
    let (path, store) = sink_world("record");
    drop_on(&path, "item", "2000000", 1);
    let before = notebook_rows(&path);
    assert!(store.pickup("a", "map", "item-1", "item").unwrap().success);
    assert_eq!(notebook_rows(&path), before + 1);
}
