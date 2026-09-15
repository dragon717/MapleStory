// 冒险笔记事实层（NB-03）的定向持久化检查。
//
// 本文件被 `auth.rs` 的 `mod tests` 用 `include!` 塞进同一个模块，所以：
// - 取别名避免与其它验收文件的 `Connection`／`Arc`／`Mutex`／`Path` 撞名
// - 自己的 helper 一律 `nb_` 前缀，不和卖／买回／仓库验收的裸名重复
// - 类型写全路径，不用 `use` 把同模块里已存在的名字再引入一次

use rusqlite::Connection as NbConnection;
use std::{
    path::{Path as NbPath, PathBuf as NbPathBuf},
    sync::{Arc as NbArc, Mutex as NbMutex},
};

use super::notebook::{
    backfill_item_records_tx as nb_backfill_tx, catalog as nb_catalog,
    classify_item as nb_classify, record_item_acquisitions_tx as nb_record_tx,
    AcquisitionSource as NbSource, ItemAcquisition as NbGrant, ItemScope as NbScope,
    NotebookCatalog as NbCatalog, ITEM_BACKFILL_VERSION as NB_BACKFILL_VERSION,
    SCOPE_CHARACTER as NB_SCOPE_CHARACTER, TIME_QUALITY_EVENT as NB_TIME_EVENT,
    TIME_QUALITY_UNKNOWN as NB_TIME_UNKNOWN,
};

const NB_EVENT_TIME: i64 = 1_700_000_000_000;

fn nb_open(path: &NbPath) -> Store {
    let db = NbConnection::open(path).unwrap();
    Store::init(&db).unwrap();
    Store {
        db: NbArc::new(NbMutex::new(db)),
    }
}

fn nb_path(tag: &str) -> NbPathBuf {
    std::env::temp_dir().join(format!("maple-notebook-{tag}-{}.sqlite3", random_id()))
}

fn nb_cleanup(path: &NbPath) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
}

fn nb_exec(store: &Store, sql: &str, args: &[&dyn rusqlite::ToSql]) {
    store
        .with_db(|db| {
            db.execute(sql, args)
                .map_err(|_| "nb seed failed".to_owned())?;
            Ok(())
        })
        .unwrap();
}

fn nb_scalar(store: &Store, sql: &str, args: &[&dyn rusqlite::ToSql]) -> i64 {
    store
        .with_db(|db| {
            db.query_row(sql, args, |row| row.get::<_, i64>(0))
                .map_err(|_| "nb read failed".to_owned())
        })
        .unwrap()
}

fn nb_grant<'a>(item_id: &'a str, quantity: u32) -> NbGrant<'a> {
    NbGrant {
        item_id,
        quantity,
        source: NbSource::Pickup,
        source_ref: Some("nb-evidence"),
    }
}

fn nb_seed_character(store: &Store, character_id: &str, account_id: &str) {
    nb_exec(
        store,
        "INSERT OR IGNORE INTO accounts(id,username,password_hash) VALUES(?1,?1,'x')",
        &[&account_id],
    );
    nb_exec(
        store,
        "INSERT INTO characters(id,account_id,name,name_key,appearance_json,request_id,created_at,updated_at)
         VALUES(?1,?2,?3,?1,'{}',?1,0,0)",
        &[&character_id, &account_id, &format!("nb-name-{character_id}")],
    );
}

// ------------------------------------------------------- schema 与幂等事实 --

#[test]
fn notebook_schema_upgrade_adds_fact_tables_and_keeps_saved_rows() {
    let path = nb_path("upgrade");
    let db = NbConnection::open(&path).unwrap();
    Store::init(&db).unwrap();
    // 造一个"上一版建的库"：业务数据齐全、还没有图鉴那四张表。
    db.execute_batch(
        "INSERT INTO accounts(id,username,password_hash) VALUES('nb-legacy','nb-legacy','x');
         INSERT INTO player_stats(account_id,hp,max_hp,mp,max_mp,level,exp,exp_to_next)
           VALUES('nb-legacy',50,50,5,5,12,0,15);
         INSERT INTO inventory(account_id,inventory_type,slot,item_id,quantity)
           VALUES('nb-legacy',2,1,'2000000',3);
         INSERT INTO player_quests(account_id,quest_id,status)
           VALUES('nb-legacy','36301','completed');
         DROP TABLE notebook_item_records;
         DROP TABLE monster_collection_records;
         DROP TABLE notebook_revisions;
         DROP TABLE notebook_backfill_runs;",
    )
    .unwrap();
    Store::init(&db).unwrap();
    let store = Store {
        db: NbArc::new(NbMutex::new(db)),
    };

    // 升级本身不伪造任何历史事实：建完表、在跑任何业务之前，四张新表都是空的。
    // 这条必须在这里查——`load_profile` 会发放创角初始装备，而 NB-05 之后那是
    // 一次真实授予、会合法地写进 `notebook_item_records`（见下面的正向断言）。
    for table in [
        "notebook_item_records",
        "monster_collection_records",
        "notebook_revisions",
        "notebook_backfill_runs",
    ] {
        assert_eq!(
            nb_scalar(&store, &format!("SELECT COUNT(*) FROM {table}"), &[]),
            0,
            "{table} 必须由升级建出且为空"
        );
    }

    // 既有存档逐字保留：升级只加表，不动业务行。
    let defaults = nb_blank_profile();
    assert_eq!(store.load_profile("nb-legacy", &defaults).unwrap().level, 12);
    assert_eq!(
        nb_scalar(
            &store,
            "SELECT quantity FROM inventory WHERE account_id='nb-legacy' AND item_id='2000000'",
            &[]
        ),
        3
    );
    assert_eq!(
        nb_scalar(
            &store,
            "SELECT COUNT(*) FROM player_quests WHERE account_id='nb-legacy'",
            &[]
        ),
        1
    );
    // NB-05 正向：`load_profile` 发的创角初始装备是一次真实授予，逐件留档，
    // 且只有这一批（升级留下的旧存档里那瓶紅藥水不会被追认成"刚获得"）。
    let recorded = store.notebook_item_records("nb-legacy").unwrap();
    assert_eq!(
        recorded.iter().map(|row| row.item_id.as_str()).collect::<Vec<_>>(),
        vec!["1040002", "1302000"],
        "创角初始装备必须逐件留档（按 id 升序）、且不得多记"
    );
    assert!(
        recorded
            .iter()
            .all(|row| row.source_kind == "starter" && row.time_quality == "event"),
        "创角初始装备的来源必须记为 starter，时间依据必须是 event（不是补记）"
    );
    assert!(
        recorded.iter().all(|row| row.first_obtained_at_ms.is_some()),
        "实时授予必须带真实获得时间，不能写成未知"
    );
    assert!(
        !recorded.iter().any(|row| row.item_id == "2000000"),
        "升级前就存在的物品不得被当作本次获得"
    );
    assert_eq!(
        store
            .notebook_revision(NB_SCOPE_CHARACTER, "nb-legacy")
            .unwrap(),
        1,
        "初始授予只推进一次 revision"
    );
    drop(store);
    nb_cleanup(&path);
}

#[test]
fn notebook_acquisition_is_idempotent_and_bumps_the_revision_once_per_commit() {
    let path = nb_path("idempotent");
    let store = nb_open(&path);
    let catalog = nb_catalog();

    // 同一批里同一模板出现两次（§9.2 的多条正向授予）只算一条首次获得。
    let batch = [nb_grant("1042031", 1), nb_grant("01042031", 2)];
    let first = store
        .record_notebook_acquisitions("nb-char", &batch, NB_EVENT_TIME)
        .unwrap();
    assert_eq!(first.first_obtained, vec!["1042031".to_owned()]);
    assert!(first.recorded_anything());
    assert_eq!(first.revision, 1);

    // 重复获得走唯一键：不新增事实、不刷 revision、不覆盖首次时间。
    let again = store
        .record_notebook_acquisitions("nb-char", &[nb_grant("1042031", 5)], NB_EVENT_TIME + 60_000)
        .unwrap();
    assert!(again.first_obtained.is_empty());
    assert!(!again.recorded_anything());
    assert_eq!(again.revision, 1, "重复获得不得推进 revision");

    let records = store.notebook_item_records("nb-char").unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].item_id, "1042031");
    assert_eq!(records[0].first_obtained_at_ms, Some(NB_EVENT_TIME));
    assert_eq!(records[0].time_quality, NB_TIME_EVENT);
    assert_eq!(records[0].source_kind, "pickup");
    assert!(records[0].recorded_at_ms > 0);

    // 另一件物品是一次新的提交：revision 前进，且只前进一次。
    let second = store
        .record_notebook_acquisitions("nb-char", &[nb_grant("1302000", 1)], NB_EVENT_TIME)
        .unwrap();
    assert_eq!(second.first_obtained, vec!["1302000".to_owned()]);
    assert_eq!(second.revision, 2);

    // 读两次结果完全相同（幂等读），且按 id 升序。
    let read_once = store.notebook_item_records("nb-char").unwrap();
    let read_twice = store.notebook_item_records("nb-char").unwrap();
    assert_eq!(read_once, read_twice);
    assert_eq!(
        read_once.iter().map(|r| r.item_id.as_str()).collect::<Vec<_>>(),
        vec!["1042031", "1302000"]
    );

    // 归属隔离：别的角色看不到这份记录，也没有它自己的 revision。
    assert!(store.notebook_item_records("nb-other").unwrap().is_empty());
    assert_eq!(
        store
            .notebook_revision(NB_SCOPE_CHARACTER, "nb-other")
            .unwrap(),
        0
    );
    // 角色作用域与账号作用域互不影响。
    assert_eq!(store.notebook_revision("account", "nb-char").unwrap(), 0);
    assert_eq!(catalog.item_count(), 2584);

    drop(store);
    nb_cleanup(&path);
}

#[test]
fn notebook_owner_resolution_uses_characters_and_the_legacy_fallback() {
    let path = nb_path("owner");
    let store = nb_open(&path);
    nb_seed_character(&store, "nb-char", "nb-account");
    nb_seed_character(&store, "nb-char-2", "nb-account");

    let owner = store.notebook_owner("nb-char").unwrap().unwrap();
    assert_eq!(owner.character_id, "nb-char");
    assert_eq!(owner.account_id, "nb-account", "收藏归属必须由角色行解析");
    // 同账号的另一个角色：账号相同、角色不同——物品记录按角色分开。
    let sibling = store.notebook_owner("nb-char-2").unwrap().unwrap();
    assert_eq!(sibling.account_id, owner.account_id);
    assert_ne!(sibling.character_id, owner.character_id);
    // 不存在的角色解析不出来，而不是兜底成一个账号。
    assert!(store.notebook_owner("nb-missing").unwrap().is_none());
    assert!(store.notebook_owner("").unwrap().is_none());

    // 遗留账号：lobby 补的角色行 id 与账号 id 相同，两个 id 一致。
    nb_exec(
        &store,
        "INSERT INTO accounts(id,username,password_hash) VALUES('nb-legacy','nb-legacy','x')",
        &[],
    );
    nb_exec(
        &store,
        "INSERT INTO player_stats(account_id,hp,max_hp,mp,max_mp,level,exp,exp_to_next)
         VALUES('nb-legacy',50,50,5,5,1,0,15)",
        &[],
    );
    let legacy = store.notebook_owner("nb-legacy").unwrap().unwrap();
    assert_eq!(legacy.character_id, "nb-legacy");
    assert_eq!(legacy.account_id, "nb-legacy");

    // 只有账号、没有任何角色存档 ⇒ 不是角色，拒绝，不拿账号冒充归属。
    nb_exec(
        &store,
        "INSERT INTO accounts(id,username,password_hash) VALUES('nb-account-only','nb-account-only','x')",
        &[],
    );
    assert!(store.notebook_owner("nb-account-only").unwrap().is_none());

    drop(store);
    nb_cleanup(&path);
}

// --------------------------------------------------------------- 分类守卫 --

#[test]
fn notebook_classification_reads_the_catalog_and_never_guesses() {
    let catalog = nb_catalog();
    // 规范化只认十进制字符串去前导零：别名与更多一位前导零都落到同一个键。
    assert_eq!(
        nb_classify("01042031", catalog).unwrap(),
        NbScope::Recorded("1042031".to_owned())
    );
    assert_eq!(
        nb_classify("01302000", catalog).unwrap(),
        NbScope::Recorded("1302000".to_owned())
    );
    // 枫币（`item_id == "0"`）与拿不到物品索引的写法都不是常规物品：业务照常授予、
    // 不留档，而且每种排除都有自己的理由，不是一刀切的"未知"。
    assert_eq!(
        nb_classify("0", catalog).unwrap(),
        NbScope::NotAnItem("枫币不是物品（计划 §2.4.6）")
    );
    for rejected in ["", "   ", "abc", "1.3e6", "-1302000", "+1302000", "1302000.0"] {
        assert!(
            matches!(nb_classify(rejected, catalog).unwrap(), NbScope::NotAnItem(_)),
            "{rejected} 不得被当成物品 id"
        );
    }
    assert_eq!(
        nb_classify("99999999", catalog).unwrap(),
        NbScope::NotAnItem("不是常规物品（物品索引里没有定义）")
    );

    // 页签必须是目录的无重叠全覆盖分区：多了会漏记、重叠会算两次。
    let mut total = 0_usize;
    let mut seen = HashSet::new();
    for section in catalog.section_keys() {
        let ids = catalog.section_ids(section).unwrap();
        total += ids.len();
        for id in ids {
            assert!(seen.insert(id.clone()), "{id} 同时属于两个页签");
            assert_eq!(
                catalog.section_of(id),
                Some(section),
                "{id} 的反查页签与分区不一致"
            );
        }
    }
    assert_eq!(total, catalog.item_count(), "页签分区必须覆盖整份目录");
    assert!(catalog.section_of("99999999").is_none());
}

#[test]
fn notebook_catalog_defect_and_invalid_grant_fail_the_whole_transaction() {
    let path = nb_path("defect");
    let store = nb_open(&path);
    let catalog = nb_catalog();
    // 故意漏掉一件物品索引里真有定义的常规装备：这不是"排除"，是目录缺陷。
    let reduced = NbCatalog::for_test(&[("2000000", 2)], &[("use", &["2000000"])]);

    let outcome = store.with_db(|db| {
        let tx = db.transaction().map_err(|_| "nb tx failed".to_owned())?;
        // 先写一条合法事实，再让同一事务里的第二批撞上目录缺陷。
        let ok = nb_record_tx(&tx, "nb-char", &[nb_grant("2000000", 1)], NB_EVENT_TIME, &reduced)?;
        assert!(ok.recorded_anything());
        let refused = nb_record_tx(&tx, "nb-char", &[nb_grant("1302000", 1)], NB_EVENT_TIME, &reduced);
        assert!(
            refused.unwrap_err().contains("1302000"),
            "目录缺陷必须报出可定位的 id"
        );
        // 业务侧看到 Err 就不提交：事实、revision 一起回滚（§7.4）。
        drop(tx);
        Ok(())
    });
    assert!(outcome.is_ok());
    assert!(store.notebook_item_records("nb-char").unwrap().is_empty());
    assert_eq!(
        store
            .notebook_revision(NB_SCOPE_CHARACTER, "nb-char")
            .unwrap(),
        0
    );

    // 数量为 0 不是"这次真正授予的正数"：拒绝，别把空授予记成获得。
    store
        .with_db(|db| {
            let tx = db.transaction().map_err(|_| "nb tx failed".to_owned())?;
            assert!(nb_record_tx(&tx, "nb-char", &[nb_grant("1042031", 0)], NB_EVENT_TIME, catalog).is_err());
            drop(tx);
            Ok(())
        })
        .unwrap();
    assert!(store.notebook_item_records("nb-char").unwrap().is_empty());
    // 明确排除的 id 不会因为被授予就写事实，也不会让整笔失败。
    let skipped = store
        .record_notebook_acquisitions("nb-char", &[nb_grant("0", 1), nb_grant("abc", 1)], NB_EVENT_TIME)
        .unwrap();
    assert!(!skipped.recorded_anything());
    assert_eq!(skipped.revision, 0);

    drop(store);
    nb_cleanup(&path);
}

// --------------------------------------------------------------- 历史补记 --

/// 布置一份有历史但缺回执的存档：背包、穿戴、仓库、拾取回执、現金回执各一条，
/// 外加一条别名、一条枫币、一张旧卡片和一个已完成任务。
fn nb_seed_history(store: &Store) {
    nb_exec(
        store,
        "INSERT INTO inventory(account_id,inventory_type,slot,item_id,quantity)
         VALUES('nb-char',1,1,'1042031',1),('nb-char',1,2,'01042031',1)",
        &[],
    );
    nb_exec(
        store,
        "INSERT INTO equipped(account_id,slot,item_id,quantity) VALUES('nb-char',7,'1302000',1)",
        &[],
    );
    nb_exec(
        store,
        "INSERT INTO storage(account_id,slot,item_id,quantity) VALUES('nb-char',1,'1000000',1)",
        &[],
    );
    nb_exec(
        store,
        "INSERT INTO pickup_actions(account_id,request_id,drop_id,item_id,quantity,success,code)
         VALUES('nb-char','nb-pick-1','d1','2000000',1,1,''),
                ('nb-char','nb-pick-2','d2','0',500,1,'')",
        &[],
    );
    nb_exec(
        store,
        "INSERT INTO cash_actions(account_id,request_id,sn,item_id,quantity,cash_spent,cash_after,purchased_units,success,code)
         VALUES('nb-char','nb-cash-1','nb-sn','9101008',1,0,0,0,1,'')",
        &[],
    );
    nb_exec(
        store,
        "INSERT INTO monster_book_cards(account_id,item_id,quantity) VALUES('nb-char','2380000',1)",
        &[],
    );
    nb_exec(
        store,
        "INSERT INTO player_quests(account_id,quest_id,status) VALUES('nb-char','36301','completed')",
        &[],
    );
}

#[test]
fn notebook_history_backfill_proves_holdings_without_inventing_time() {
    let path = nb_path("backfill");
    let store = nb_open(&path);
    let catalog = nb_catalog();
    // 功能上线后已经真实获得过的条目：补记不得覆盖它的真实时间（§13.2）。
    store
        .record_notebook_acquisitions("nb-char", &[nb_grant("1302000", 1)], NB_EVENT_TIME)
        .unwrap();
    nb_seed_history(&store);

    let report = store
        .backfill_notebook_item_records("nb-char", NB_BACKFILL_VERSION)
        .unwrap();
    assert!(!report.already_completed);
    assert_eq!(
        report.proved,
        vec!["1000000", "1042031", "2000000", "9101008"]
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>(),
        "只补记能证明的、且还没留档的条目"
    );
    assert_eq!(report.deduped, 1, "别名 01042031 与 1042031 是同一条");
    assert_eq!(report.not_an_item, 1, "枫币不是常规物品");
    assert_eq!(report.insufficient, 1, "已完成任务没有逐次授予回执");
    assert_eq!(report.excluded, 1, "旧卡片与现代收藏隔离");
    assert_eq!(report.scanned.get("inventory"), Some(&2));
    assert_eq!(report.scanned.get("equipped"), Some(&1));
    assert_eq!(report.scanned.get("storage"), Some(&1));
    assert_eq!(report.scanned.get("pickupReceipt"), Some(&2));
    assert_eq!(report.scanned.get("cashReceipt"), Some(&1));
    assert_eq!(report.revision, 2, "真实获得 1 次 + 补记 1 次");

    let records = store.notebook_item_records("nb-char").unwrap();
    assert_eq!(records.len(), 5);
    let live = records.iter().find(|r| r.item_id == "1302000").unwrap();
    assert_eq!(live.first_obtained_at_ms, Some(NB_EVENT_TIME));
    assert_eq!(live.time_quality, NB_TIME_EVENT, "补记不得把真实时间改成未知");
    for record in records.iter().filter(|r| r.item_id != "1302000") {
        assert_eq!(record.first_obtained_at_ms, None, "库里没有原始时间就不伪造一个");
        assert_eq!(record.time_quality, NB_TIME_UNKNOWN);
        assert!(record.recorded_at_ms > 0, "补记时间仍然要记下来");
        assert!(!record.source_kind.is_empty(), "首次记录依据不能是空的");
    }
    // 补记不发收藏登记：旧卡片不产生现代收藏资格（§8.4）。
    assert!(store
        .notebook_collection_entries("nb-char")
        .unwrap()
        .is_empty());
    assert_eq!(catalog.section_of("9101008"), Some("cash"));

    // 第二遍：已有标记就不重扫、不新增、不刷 revision。
    let again = store
        .backfill_notebook_item_records("nb-char", NB_BACKFILL_VERSION)
        .unwrap();
    assert!(again.already_completed);
    assert!(again.proved.is_empty());
    assert_eq!(again.revision, report.revision);
    assert_eq!(store.notebook_item_records("nb-char").unwrap(), records);
    assert_eq!(
        nb_scalar(
            &store,
            "SELECT COUNT(*) FROM notebook_backfill_runs WHERE character_id='nb-char'",
            &[]
        ),
        1
    );
    // 换一个迁移版本才会重跑：新版本不重写已有行的首次时间。
    let next_version = store
        .backfill_notebook_item_records("nb-char", "notebook-item-backfill-2")
        .unwrap();
    assert!(!next_version.already_completed);
    assert!(next_version.proved.is_empty(), "已有事实不会被重复证明");
    assert_eq!(
        store
            .notebook_item_records("nb-char")
            .unwrap()
            .iter()
            .find(|r| r.item_id == "1302000")
            .unwrap()
            .first_obtained_at_ms,
        Some(NB_EVENT_TIME)
    );

    drop(store);
    nb_cleanup(&path);
}

#[test]
fn notebook_history_backfill_rolls_back_the_batch_and_writes_no_marker() {
    let path = nb_path("backfill-rollback");
    let store = nb_open(&path);
    nb_seed_history(&store);

    store
        .with_db(|db| {
            let tx = db.transaction().map_err(|_| "nb tx failed".to_owned())?;
            let report = nb_backfill_tx(&tx, "nb-char", NB_BACKFILL_VERSION, nb_catalog())?;
            assert_eq!(report.proved.len(), 5);
            // 同一笔提交里后续还有别的写入失败——事实、revision、标记必须一起回滚，
            // 绝不能留下"标记已写、事实没写"。
            assert!(tx
                .execute(
                    "INSERT INTO notebook_item_records(character_id,item_id,recorded_at_ms,time_quality)
                     VALUES('nb-char','1302000',1,'event')",
                    [],
                )
                .is_err());
            drop(tx);
            Ok(())
        })
        .unwrap();

    assert!(store.notebook_item_records("nb-char").unwrap().is_empty());
    assert_eq!(
        nb_scalar(
            &store,
            "SELECT COUNT(*) FROM notebook_backfill_runs WHERE character_id='nb-char'",
            &[]
        ),
        0,
        "失败的一批不得留下迁移标记"
    );
    assert_eq!(
        store
            .notebook_revision(NB_SCOPE_CHARACTER, "nb-char")
            .unwrap(),
        0
    );

    drop(store);
    nb_cleanup(&path);
}

/// `player_stats` 是 NOT NULL 一片，验收里造行时用同一份默认档案。
fn nb_blank_profile() -> Profile {
    Profile {
        hp: 50,
        max_hp: 50,
        mp: 5,
        max_mp: 5,
        level: 1,
        job: 0,
        exp: 0,
        exp_to_next: 15,
        mesos: 0,
        cash: 0,
        death_id: String::new(),
        map_id: String::new(),
        x: 0.0,
        y: 0.0,
        inventory: Vec::new(),
        skills: BTreeMap::new(),
        skill_points: BTreeMap::new(),
        ability_stats: AbilityStats::default(),
    }
}
