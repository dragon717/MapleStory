// NB-04：普通商店买 / 卖 / 买回**单事务提交**的定向持久化检查。
//
// 本文件被 `auth.rs` 的 `mod tests` 用 `include!` 塞进同一个模块，所以：
// - helper 一律 `sc_` 前缀，不和 `nb_`（图鉴）等其它验收文件撞名
// - 类型写全路径，不用 `use` 把同模块里已存在的名字再引入一次
//
// 三条提交 helper（`shop_buy_commit` / `shop_sell_commit` / `shop_rebuy_commit`）
// 的共同契约：资产（背包行 + 金币 profile）与回执事实（赎回行的进出）在
// **同一个事务**里落库，任何一步失败整笔回滚、库里什么都没变；调用方
// （`crate::trade`）只在 `Ok` 之后才改内存。失败注入方式 = `Store::deny_persistence()`
// 作用域守卫，让 commit helper 走与真实写失败完全一致的拒绝路径。

use crate::auth::shop::ShopRebuyRow;

const SC_ITEM: &str = "2000000"; // 紅色藥水：普通消耗品，可卖可赎回

fn sc_profile(mesos: u64) -> Profile {
    Profile {
        hp: 50,
        max_hp: 50,
        mp: 5,
        max_mp: 5,
        level: 1,
        job: 0,
        exp: 0,
        exp_to_next: 15,
        mesos,
        cash: 0,
        death_id: String::new(),
        map_id: String::new(),
        x: 0.0,
        y: 0.0,
        inventory: Vec::new(),
        skills: std::collections::BTreeMap::new(),
        skill_points: std::collections::BTreeMap::new(),
        ability_stats: AbilityStats::default(),
    }
}

fn sc_stack(quantity: u32) -> Vec<InventoryItem> {
    vec![InventoryItem {
        slot: 1,
        item_id: SC_ITEM.to_owned(),
        quantity,
        ..InventoryItem::default()
    }]
}

/// NB-05：本次购买真正授予的物品（与 `sc_stack` 同一件，数量取自购买量）。
fn sc_grant(quantity: u32) -> crate::auth::notebook::ItemAcquisition<'static> {
    crate::auth::notebook::ItemAcquisition {
        item_id: SC_ITEM,
        quantity,
        source: crate::auth::notebook::AcquisitionSource::ShopBuy,
        source_ref: Some("sc-shop-buy"),
    }
}

fn sc_db_mesos(store: &Store, account_id: &str) -> i64 {
    store
        .with_db(|db| {
            db.query_row(
                "SELECT mesos FROM player_stats WHERE account_id=?1",
                [account_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|_| "sc read failed".to_owned())
        })
        .unwrap()
}

fn sc_db_inventory(store: &Store, account_id: &str) -> Vec<InventoryItem> {
    store
        .with_db(|db| {
            let tx = db
                .transaction()
                .map_err(|_| "sc read failed".to_owned())?;
            read_inventory_tx(&tx, account_id)
        })
        .unwrap()
}

fn sc_db_rebuy(store: &Store, account_id: &str) -> Vec<ShopRebuyRow> {
    store
        .with_db(|db| {
            let mut statement = db
                .prepare(
                    "SELECT item_id,quantity,unit_price FROM shop_rebuy
                     WHERE account_id=?1 ORDER BY seq DESC",
                )
                .map_err(|_| "sc read failed".to_owned())?;
            let rows = statement
                .query_map([account_id], |row| {
                    Ok(ShopRebuyRow {
                        item_id: row.get(0)?,
                        quantity: row.get::<_, i64>(1)?.max(0) as u32,
                        unit_price: row.get::<_, i64>(2)?.max(0) as u64,
                    })
                })
                .map_err(|_| "sc read failed".to_owned())?;
            let mut result = Vec::new();
            for row in rows {
                result.push(row.map_err(|_| "sc read failed".to_owned())?);
            }
            Ok(result)
        })
        .unwrap()
}

/// NB-05：图鉴留档的当前行，`(item_id, source_kind, time_quality)` 按 id 升序。
///
/// 过滤掉 `starter`：`load_profile` 建号时会发放创角初始装备（NB-05 之后那也是一次
/// 真实授予、会留档），但它不是本文件要检查的商店路径，留着只会给每条断言加噪声。
/// 创角初始装备本身的留档断言在 `notebook_store_acceptance`。
fn sc_db_grants(store: &Store, character_id: &str) -> Vec<(String, String, String)> {
    store
        .notebook_item_records(character_id)
        .unwrap()
        .into_iter()
        .filter(|row| row.source_kind != "starter")
        .map(|row| (row.item_id, row.source_kind, row.time_quality))
        .collect()
}

/// NB-05：留档的图鉴 revision。建号本身会推进一次，所以断言一律比「相对基线的
/// 增量」，而不是写死的绝对值。
fn sc_db_revision(store: &Store, character_id: &str) -> u64 {
    store
        .notebook_revision(crate::auth::notebook::SCOPE_CHARACTER, character_id)
        .unwrap()
}

#[test]
fn sc_shop_buy_commit_writes_mesos_and_inventory_in_one_commit() {
    let path = nb_path("shop-buy-commit");
    let store = nb_open(&path);
    let account = "sc-buyer";
    store.load_profile(account, &sc_profile(0)).unwrap();
    let baseline = sc_db_revision(&store, account);

    let mut profile = sc_profile(0);
    profile.mesos = 97; // 100 - 3：买 3 瓶紅藥水后的余额
    let inventory = sc_stack(3);
    let grants = [sc_grant(3)];
    store
        .shop_buy_commit(account, &profile, &inventory, &grants)
        .unwrap();

    assert_eq!(sc_db_mesos(&store, account), 97);
    assert_eq!(sc_db_inventory(&store, account).len(), 1);
    assert_eq!(sc_db_inventory(&store, account)[0].quantity, 3);
    // NB-05：图鉴留档与资产在同一笔提交里落地，来源是商店购买（不是拾取），
    // 时间依据是真实事件（不是补记），且只推进一次 revision。
    assert_eq!(
        sc_db_grants(&store, account),
        vec![(
            SC_ITEM.to_owned(),
            "shopBuy".to_owned(),
            "event".to_owned()
        )]
    );
    assert_eq!(sc_db_revision(&store, account), baseline + 1);
    // 内存权威未被 helper 碰过：profile 仍是调用前那份（0 金币）——
    // 改内存是 `crate::trade` 在 commit 成功后自己的事。
    assert_eq!(profile.mesos, 97);
    nb_cleanup(&path);
}

#[test]
fn sc_shop_buy_commit_failure_rolls_everything_back() {
    let path = nb_path("shop-buy-fail");
    let store = nb_open(&path);
    let account = "sc-buyer-fail";
    store.load_profile(account, &sc_profile(0)).unwrap();
    let baseline = sc_db_revision(&store, account);

    let mut profile = sc_profile(0);
    profile.mesos = 97;
    let inventory = sc_stack(3);
    {
        // 失败注入：作用域结束（含 panic 展开）即自动恢复。
        let _denial = Store::deny_persistence();
        assert!(store
            .shop_buy_commit(account, &profile, &inventory, &[sc_grant(3)])
            .is_err());
    }
    // 整笔回滚：金币没扣、背包没多、库里和提交前完全一样。
    assert_eq!(sc_db_mesos(&store, account), 0);
    assert!(sc_db_inventory(&store, account).is_empty());
    // NB-05：失败的购买不登记——图鉴事实与 revision 一起回滚，不留「物品没到、
    // 图鉴却记了获得」的假事实。
    assert!(sc_db_grants(&store, account).is_empty());
    assert_eq!(sc_db_revision(&store, account), baseline);
    nb_cleanup(&path);
}

#[test]
fn sc_shop_sell_commit_writes_rebuy_row_with_the_assets() {
    let path = nb_path("shop-sell-commit");
    let store = nb_open(&path);
    let account = "sc-seller";
    store.load_profile(account, &sc_profile(0)).unwrap();
    let baseline = sc_db_revision(&store, account);

    let mut profile = sc_profile(0);
    profile.mesos = 15; // 卖 5 瓶 × 单价 3 的入账
    let inventory = Vec::new(); // 背包里这 5 瓶已经拿走
    let rebuy = ShopRebuyRow {
        item_id: SC_ITEM.to_owned(),
        quantity: 5,
        unit_price: 3,
    };
    store
        .shop_sell_commit(account, &profile, &inventory, Some(rebuy))
        .unwrap();

    assert_eq!(sc_db_mesos(&store, account), 15);
    assert!(sc_db_inventory(&store, account).is_empty());
    assert_eq!(
        sc_db_rebuy(&store, account),
        vec![ShopRebuyRow {
            item_id: SC_ITEM.to_owned(),
            quantity: 5,
            unit_price: 3,
        }]
    );
    // NB-05：出售是**消耗／移除**，不是获得——赎回权益的写入不得顺带在图鉴里
    // 记一条「获得」。反证：如果出售被误当授予，下面这条会失败。
    assert!(sc_db_grants(&store, account).is_empty());
    assert_eq!(sc_db_revision(&store, account), baseline);
    nb_cleanup(&path);
}

#[test]
fn sc_shop_rebuy_commit_consumes_row_and_moves_assets_together() {
    let path = nb_path("shop-rebuy-commit");
    let store = nb_open(&path);
    let account = "sc-rebuyer";
    store.load_profile(account, &sc_profile(0)).unwrap();
    let baseline = sc_db_revision(&store, account);
    // 先卖一笔，把赎回行放进库里。
    let mut sold = sc_profile(0);
    sold.mesos = 15;
    store
        .shop_sell_commit(
            account,
            &sold,
            &Vec::new(),
            Some(ShopRebuyRow {
                item_id: SC_ITEM.to_owned(),
                quantity: 5,
                unit_price: 3,
            }),
        )
        .unwrap();

    // 买回：行被消费、扣金币、授予背包，一次提交全部落地。
    let mut profile = sc_profile(0);
    profile.mesos = 0; // 15 - 15
    assert_eq!(
        store
            .shop_rebuy_commit(account, &profile, &sc_stack(5), SC_ITEM, 3)
            .unwrap(),
        true
    );
    assert_eq!(sc_db_mesos(&store, account), 0);
    assert_eq!(sc_db_inventory(&store, account).len(), 1);
    assert!(sc_db_rebuy(&store, account).is_empty());
    // NB-05：买回是物品回到手上，按赎回来源留档，数量取自**被消费掉的那一行**。
    assert_eq!(
        sc_db_grants(&store, account),
        vec![(
            SC_ITEM.to_owned(),
            "shopRebuy".to_owned(),
            "event".to_owned()
        )]
    );
    assert_eq!(sc_db_revision(&store, account), baseline + 1);

    // 行已不在：第二次买回同一行必须 Ok(false)，且金币 / 背包分文未动。
    assert_eq!(
        store
            .shop_rebuy_commit(account, &profile, &sc_stack(5), SC_ITEM, 3)
            .unwrap(),
        false
    );
    assert_eq!(sc_db_mesos(&store, account), 0);
    assert_eq!(sc_db_inventory(&store, account).len(), 1);
    // 被拒绝的买回同样不登记、不刷 revision（行不存在 ⇒ 整笔无写入）。
    assert_eq!(sc_db_revision(&store, account), baseline + 1);
    nb_cleanup(&path);
}

#[test]
fn sc_shop_rebuy_commit_failure_keeps_the_row_and_the_assets() {
    let path = nb_path("shop-rebuy-fail");
    let store = nb_open(&path);
    let account = "sc-rebuyer-fail";
    store.load_profile(account, &sc_profile(0)).unwrap();
    let baseline = sc_db_revision(&store, account);
    let mut sold = sc_profile(0);
    sold.mesos = 15;
    store
        .shop_sell_commit(
            account,
            &sold,
            &Vec::new(),
            Some(ShopRebuyRow {
                item_id: SC_ITEM.to_owned(),
                quantity: 5,
                unit_price: 3,
            }),
        )
        .unwrap();

    {
        let _denial = Store::deny_persistence();
        let mut profile = sc_profile(0);
        profile.mesos = 0;
        // 提交失败：赎回行**必须还在**（旧行为是先删行再写库，行会丢），
        // 金币和背包也分文未动。
        assert!(store
            .shop_rebuy_commit(account, &profile, &sc_stack(5), SC_ITEM, 3)
            .is_err());
    }
    assert_eq!(
        sc_db_rebuy(&store, account),
        vec![ShopRebuyRow {
            item_id: SC_ITEM.to_owned(),
            quantity: 5,
            unit_price: 3,
        }]
    );
    assert_eq!(sc_db_mesos(&store, account), 15);
    assert!(sc_db_inventory(&store, account).is_empty());
    // NB-05：失败的买回不登记。
    assert!(sc_db_grants(&store, account).is_empty());
    assert_eq!(sc_db_revision(&store, account), baseline);
    nb_cleanup(&path);
}
