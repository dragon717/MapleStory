/// 增量 4（审查 §33/§34）：`write_inventory_tx` 从「DELETE 整表 + 重插」改成
/// **按差异持久化**之后的等价性钉子。
///
/// 旧形状把修改权整个交给调用方的内存 Vec，一次调用 = 该账号全部背包行
/// 拆掉重插。新形状对差集做最小写入（键 `(inventory_type, slot)` 消失 ⇒
/// DELETE，键在内容变 ⇒ 按 rowid UPDATE，新键 ⇒ INSERT），**终点状态与
/// 整表重写逐行等价**。这里用 SQLite `total_changes()` 的行级增量把这个
/// 差异钉住：任何人把整表重写改回来，`..._touches_no_rows` 这类断言会
/// 立刻失败（旧行为下哪怕原样重写也会产生 2N 行变更）。
///
/// 全部走 [`auth::Store::seed_inventory_for_test`]（测试专用种子入口，内部
/// 就是 `write_inventory_tx`）驱动，不绕过生产写入路径。读回一律用裸 SQL，
/// 不经 `load_profile`——那条会顺带发放创角初始装备，污染行数计数。

use super::*;

/// 一叠普通消耗品（不含装备实例字段，避免无关归一化干扰行数计数）。
fn stack(slot: u16, item_id: &str, quantity: u32) -> InventoryItem {
    InventoryItem {
        slot,
        item_id: item_id.into(),
        quantity,
        ..InventoryItem::default()
    }
}

fn temp_store(tag: &str) -> (std::path::PathBuf, auth::AuthService) {
    let path =
        std::env::temp_dir().join(format!("maple-inv-diff-{tag}-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).expect("temp store");
    (path, service)
}

/// 连接自快照以来的累计行变更数（INSERT/UPDATE/DELETE 都计一行）。
fn total_changes(store: &auth::Store) -> usize {
    store
        .with_db(|db| Ok(db.total_changes() as usize))
        .expect("store available")
}

fn seed(store: &auth::Store, account_id: &str, bag: &[InventoryItem]) {
    store
        .seed_inventory_for_test(account_id, bag)
        .expect("seed commits");
}

/// 裸 SQL 读回 `(slot, quantity)`，绕开 `load_profile` 的建号发放副作用。
fn stored_slots(store: &auth::Store, account_id: &str) -> Vec<(i64, i64)> {
    store
        .with_db(|db| {
            let mut stmt = db
                .prepare(
                    "SELECT slot,quantity FROM inventory
                     WHERE account_id=?1 AND quantity>0 ORDER BY slot",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([account_id], |row| Ok((row.get(0)?, row.get(1)?)))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            Ok(rows)
        })
        .expect("read back")
}

#[test]
fn rewriting_the_same_inventory_table_touches_no_rows() {
    let (path, service) = temp_store("idempotent");
    let store = &service.store;
    let bag = vec![
        stack(1, "5062001", 5),
        stack(2, "5062001", 2),
        stack(3, "5062001", 40),
    ];
    seed(store, "acc", &bag);
    let before = total_changes(store);
    seed(store, "acc", &bag);
    assert_eq!(
        total_changes(store) - before,
        0,
        "an unchanged table must persist as zero row changes"
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn changing_one_stack_updates_exactly_one_row() {
    let (path, service) = temp_store("update");
    let store = &service.store;
    seed(store, "acc", &vec![stack(1, "5062001", 5), stack(2, "5062001", 2)]);
    let before = total_changes(store);
    seed(store, "acc", &vec![stack(1, "5062001", 3), stack(2, "5062001", 2)]);
    assert_eq!(
        total_changes(store) - before,
        1,
        "one changed quantity must persist as a single row update"
    );
    assert_eq!(stored_slots(store, "acc"), vec![(1, 3), (2, 2)]);
    let _ = std::fs::remove_file(path);
}

#[test]
fn adding_and_removing_a_stack_is_one_row_each() {
    let (path, service) = temp_store("insert-delete");
    let store = &service.store;
    let base = vec![stack(1, "5062001", 5), stack(2, "5062001", 2)];
    seed(store, "acc", &base);

    let with_more = vec![
        stack(1, "5062001", 5),
        stack(2, "5062001", 2),
        stack(3, "5062001", 7),
    ];
    let before = total_changes(store);
    seed(store, "acc", &with_more);
    assert_eq!(total_changes(store) - before, 1, "a new stack is one INSERT");

    let before = total_changes(store);
    seed(store, "acc", &base);
    assert_eq!(
        total_changes(store) - before,
        1,
        "a removed stack is one DELETE"
    );
    let _ = std::fs::remove_file(path);
}

/// 等价性细节：旧版 `DELETE-all` 会把显示窗口外的垃圾行一并带走
/// （`read_inventory_tx` 只读 kind 1..5、slot 1..MAX、quantity>0 的行）。
/// 差异化写入必须读**未过滤**的现状，否则窗口外垃圾行会开始残留。
#[test]
fn out_of_window_rows_are_swept_like_the_old_full_rewrite() {
    let (path, service) = temp_store("junk");
    let store = &service.store;
    let bag = vec![stack(1, "5062001", 5)];
    seed(store, "acc", &bag);
    // 手工塞一行窗口外垃圾（kind=0 不在任何页签里）。
    store
        .with_db(|db| {
            db.execute(
                "INSERT INTO inventory(account_id,inventory_type,slot,item_id,quantity)
                 VALUES ('acc',0,3,'5062001',9)",
                [],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
        })
        .expect("junk row inserted");
    let before = total_changes(store);
    seed(store, "acc", &bag);
    assert_eq!(
        total_changes(store) - before,
        1,
        "the junk row must be deleted exactly once"
    );
    let junk_left: i64 = store
        .with_db(|db| {
            db.query_row(
                "SELECT COUNT(*) FROM inventory WHERE account_id='acc' AND inventory_type=0",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())
        })
        .expect("count junk");
    assert_eq!(junk_left, 0, "the junk row must be gone after the rewrite");
    let _ = std::fs::remove_file(path);
}

/// §34 的另一半：调用方给键重复（同 kind 同 slot）的表必须被拒绝——
/// 整表重写时代这条以 PRIMARY KEY 冲突失败，现在提前拒绝、事务照旧终止。
#[test]
fn duplicate_slot_keys_are_rejected_before_any_write() {
    let (path, service) = temp_store("duplicate");
    let store = &service.store;
    let duplicated = vec![stack(1, "5062001", 5), stack(1, "5062001", 7)];
    assert!(
        store
            .seed_inventory_for_test("acc", &duplicated)
            .is_err(),
        "a table with a duplicated (kind, slot) key must be refused"
    );
    // 拒绝时什么都没写。
    assert_eq!(stored_slots(store, "acc"), Vec::new());
    let _ = std::fs::remove_file(path);
}
