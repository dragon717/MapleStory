//! 商店赎回（买回）列表的持久化：卖出入表、买回删行、开商店读取，以及
//! 买 / 卖 / 买回三个动作的**单事务提交**。
//!
//! 从 `auth.rs` 机械搬出的一块完整职责（超大文件治理）。搬的是**代码位置**，
//! 不是数据布局：新表 `shop_rebuy` 与 `inventory` / `storage` 一样按账号行存放，
//! 事务语义不变。
//!
//! 负责：赎回行的读取（最新在前、带上限）、卖出入表（同 item 同价合并数量）、
//! 买回删行，随上限裁剪最老的行；以及 NB-04 的事务提交外观——
//! `shop_buy_commit` / `shop_sell_commit` / `shop_rebuy_commit` 把资产
//! （背包行 + 金币 profile）与回执事实（赎回行的进出）放进**同一个事务**，
//! 任何一步失败整笔回滚，调用方（`crate::trade`）只在 `Ok` 之后才改内存。
//! 不负责：买回的金额 / 背包容量规则与回执（`crate::trade`），表结构声明
//! （`crate::auth::schema`）。

use super::notebook::{granted_tx, AcquisitionSource, ItemAcquisition};
use super::*;

/// 赎回列表上限：只保留最近的若干行，超出的老行随写入淘汰。
/// 与协议文档里的"最近售出"一致，也让窗口一屏放得下。
pub const SHOP_REBUY_LIMIT: i64 = 20;

/// 赎回列表中的一行。`unit_price` 是卖出时商店实付的**单价**，也是买回的单价，
/// 所以一行"卖出去多少钱、买回来就多少钱"。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShopRebuyRow {
    pub item_id: String,
    pub quantity: u32,
    pub unit_price: u64,
}

/// Read one account's buy-back rows, newest first.  Shared by the public
/// wrapper and by the write path (which needs the post-write list inside its
/// own transaction).
fn read_shop_rebuy_db(db: &Connection, account_id: &str) -> Result<Vec<ShopRebuyRow>, String> {
    let mut statement = db
        .prepare(
            "SELECT item_id,quantity,unit_price FROM shop_rebuy
             WHERE account_id=?1 ORDER BY seq DESC LIMIT ?2",
        )
        .map_err(|_| "account persistence failed".to_owned())?;
    let rows = statement
        .query_map(params![account_id, SHOP_REBUY_LIMIT], |row| {
            Ok(ShopRebuyRow {
                item_id: row.get(0)?,
                quantity: row.get::<_, i64>(1)?.max(0) as u32,
                unit_price: row.get::<_, i64>(2)?.max(0) as u64,
            })
        })
        .map_err(|_| "account persistence failed".to_owned())?;
    let mut result = Vec::new();
    for row in rows {
        result.push(row.map_err(|_| "account persistence failed".to_owned())?);
    }
    Ok(result)
}

impl Store {
    /// Read the character's buy-back list (newest first, at most
    /// [`SHOP_REBUY_LIMIT`] rows).
    pub fn load_shop_rebuy(&self, account_id: &str) -> Result<Vec<ShopRebuyRow>, String> {
        let db = self
            .db
            .lock()
            .map_err(|_| "account store unavailable".to_owned())?;
        read_shop_rebuy_db(&db, account_id)
    }

    /// Record one sale in the buy-back list and return the whole list after the
    /// write.
    ///
    /// The same item sold again for the same unit price merges into the row
    /// that is already there: the price is what decides a buy-back, so two rows
    /// quoting the same price would only split the same deal in two.  Rows
    /// beyond [`SHOP_REBUY_LIMIT`] are dropped oldest-first in the same
    /// transaction, so the list can never grow past what the window shows.
    ///
    /// NB-04：生产路径不再有独立入表调用点——一笔出售的回赎行必须与移除
    /// 背包行、入账金币同一个事务提交（`shop_sell_commit`），所以这里只留给
    /// 验收测试直接构造列表，`#[cfg(test)]` 之外不可见。
    #[cfg(test)]
    pub fn push_shop_rebuy(
        &self,
        account_id: &str,
        item_id: &str,
        quantity: u32,
        unit_price: u64,
    ) -> Result<Vec<ShopRebuyRow>, String> {
        if item_id.is_empty() || quantity == 0 || unit_price == 0 {
            return self.load_shop_rebuy(account_id);
        }
        let mut db = self
            .db
            .lock()
            .map_err(|_| "account store unavailable".to_owned())?;
        let tx = db
            .transaction()
            .map_err(|_| "account persistence failed".to_owned())?;
        push_shop_rebuy_tx(&tx, account_id, item_id, quantity, unit_price)?;
        let list = read_shop_rebuy_db(&tx, account_id)?;
        tx.commit()
            .map_err(|_| "account persistence failed".to_owned())?;
        Ok(list)
    }

    /// NB-04 单事务提交的统一入口守卫：验收测试可用 `Store::deny_persistence`
    /// 打开失败注入，各 commit helper 都会走这里拒绝，调用方看到的行为与
    /// 真实 SQLite 写失败完全一致（整笔不落、内存不改）。非测试构建下
    /// `persistence_denied()` 恒为 `false`，编译期即被消除。
    /// （`pub(super)`：`auth/cash.rs` 的 `rental_sweep_commit` 同守卫。）
    #[inline]
    pub(super) fn refuse_if_persistence_denied(&self) -> Result<(), String> {
        if Self::persistence_denied() {
            return Err("account persistence failed".to_owned());
        }
        Ok(())
    }

    /// NB-04：普通商店**购买**的单事务提交——扣金币（profile）与授予背包
    /// 行在同一事务里落库，任何一步失败整笔回滚，调用方只在 `Ok` 后才改
    /// 内存与发回执。之前买路径是「先改内存再 `let _ =` 写库」，持久化
    /// 失败会被静默吞掉，内存与存档从此分叉。
    ///
    /// NB-05：`grants` 是本次购买真正新授予的物品（由调用方按业务已知事实
    /// 给出）；留档与资产在同一事务里落库，拒绝/回滚时不产生任何记录。
    pub fn shop_buy_commit(
        &self,
        account_id: &str,
        profile: &Profile,
        inventory: &[InventoryItem],
        grants: &[ItemAcquisition],
    ) -> Result<(), String> {
        self.refuse_if_persistence_denied()?;
        let mut db = self
            .db
            .lock()
            .map_err(|_| "account store unavailable".to_owned())?;
        let tx = db
            .transaction()
            .map_err(|_| "account persistence failed".to_owned())?;
        write_profile(&tx, account_id, profile)?;
        write_inventory_tx(&tx, account_id, inventory)?;
        granted_tx(&tx, account_id, grants, now_ms())?;
        tx.commit()
            .map_err(|_| "account persistence failed".to_owned())?;
        Ok(())
    }

    /// NB-04：普通商店**出售**的单事务提交——移除背包行、入账金币与把
    /// 该笔写进赎回表在同一事务里落库。之前是三段独立写回（两次
    /// `let _ =` + 一次赎回表追加），卖掉却没入账、或卖掉却丢赎回行都
    /// 可能发生；现在任何一步失败整笔回滚。
    pub fn shop_sell_commit(
        &self,
        account_id: &str,
        profile: &Profile,
        inventory: &[InventoryItem],
        rebuy: Option<ShopRebuyRow>,
    ) -> Result<(), String> {
        self.refuse_if_persistence_denied()?;
        let mut db = self
            .db
            .lock()
            .map_err(|_| "account store unavailable".to_owned())?;
        let tx = db
            .transaction()
            .map_err(|_| "account persistence failed".to_owned())?;
        write_profile(&tx, account_id, profile)?;
        write_inventory_tx(&tx, account_id, inventory)?;
        if let Some(row) = rebuy.as_ref() {
            push_shop_rebuy_tx(&tx, account_id, &row.item_id, row.quantity, row.unit_price)?;
        }
        tx.commit()
            .map_err(|_| "account persistence failed".to_owned())?;
        Ok(())
    }

    /// NB-04：普通商店**买回**的单事务提交——消费赎回行、扣金币与授予
    /// 背包行在同一事务里落库。之前 `take_shop_rebuy` 在校验之后、写库
    /// 之前就把行删了：若后续 `write_inventory` 失败，行已丢而物品没到
    /// 手，且整笔静默吞错。现在行不存在返回 `Ok(false)`（调用方按
    /// `shop_rebuy_unknown` 拒绝），任何写库失败整笔回滚、行保留。
    pub fn shop_rebuy_commit(
        &self,
        account_id: &str,
        profile: &Profile,
        inventory: &[InventoryItem],
        item_id: &str,
        unit_price: u64,
    ) -> Result<bool, String> {
        self.refuse_if_persistence_denied()?;
        let mut db = self
            .db
            .lock()
            .map_err(|_| "account store unavailable".to_owned())?;
        let tx = db
            .transaction()
            .map_err(|_| "account persistence failed".to_owned())?;
        // 数量必须在删除前读出来：买回是一次真实的获得，留档用的数量只能
        // 来自「这次消费掉的那一行」，不能由调用方另传（否则两处事实可能
        // 不一致）。行不存在即视为竞态/重放意图，事务随 drop 回滚。
        let quantity: Option<i64> = tx
            .query_row(
                "SELECT quantity FROM shop_rebuy
                 WHERE account_id=?1 AND item_id=?2 AND unit_price=?3",
                params![account_id, item_id, unit_price as i64],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "account persistence failed".to_owned())?;
        let Some(quantity) = quantity else {
            return Ok(false);
        };
        let removed = tx
            .execute(
                "DELETE FROM shop_rebuy
                 WHERE account_id=?1 AND item_id=?2 AND unit_price=?3",
                params![account_id, item_id, unit_price as i64],
            )
            .map_err(|_| "account persistence failed".to_owned())?;
        if removed == 0 {
            // 行已不在（竞态或重放意图）：事务随 drop 回滚，什么都没动。
            return Ok(false);
        }
        write_profile(&tx, account_id, profile)?;
        write_inventory_tx(&tx, account_id, inventory)?;
        // NB-05：买回是「物品回到手上」，与资产同事务留档。
        granted_tx(
            &tx,
            account_id,
            &[ItemAcquisition {
                item_id,
                quantity: u32::try_from(quantity).unwrap_or(0),
                source: AcquisitionSource::ShopRebuy,
                source_ref: None,
            }],
            now_ms(),
        )?;
        tx.commit()
            .map_err(|_| "account persistence failed".to_owned())?;
        Ok(true)
    }
}

/// 卖出入表的事务内实现：同 item 同价合并数量、随上限裁剪最老的行。
/// 供独立入表（`push_shop_rebuy`）与出售事务（`shop_sell_commit`）共用。
fn push_shop_rebuy_tx(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    item_id: &str,
    quantity: u32,
    unit_price: u64,
) -> Result<(), String> {
    if item_id.is_empty() || quantity == 0 || unit_price == 0 {
        return Ok(());
    }
    let existing: Option<i64> = tx
        .query_row(
            "SELECT seq FROM shop_rebuy
             WHERE account_id=?1 AND item_id=?2 AND unit_price=?3",
            params![account_id, item_id, unit_price as i64],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "account persistence failed".to_owned())?;
    match existing {
        Some(seq) => {
            tx.execute(
                "UPDATE shop_rebuy SET quantity=quantity+?1
                 WHERE account_id=?2 AND seq=?3",
                params![i64::from(quantity), account_id, seq],
            )
            .map_err(|_| "account persistence failed".to_owned())?;
        }
        None => {
            let next: i64 = tx
                .query_row(
                    "SELECT COALESCE(MAX(seq),0)+1 FROM shop_rebuy WHERE account_id=?1",
                    [account_id],
                    |row| row.get(0),
                )
                .map_err(|_| "account persistence failed".to_owned())?;
            tx.execute(
                "INSERT INTO shop_rebuy(account_id,seq,item_id,quantity,unit_price)
                 VALUES(?1,?2,?3,?4,?5)",
                params![
                    account_id,
                    next,
                    item_id,
                    i64::from(quantity),
                    unit_price as i64
                ],
            )
            .map_err(|_| "account persistence failed".to_owned())?;
        }
    }
    tx.execute(
        "DELETE FROM shop_rebuy WHERE account_id=?1 AND seq NOT IN
           (SELECT seq FROM shop_rebuy WHERE account_id=?1 ORDER BY seq DESC LIMIT ?2)",
        params![account_id, SHOP_REBUY_LIMIT],
    )
    .map_err(|_| "account persistence failed".to_owned())?;
    Ok(())
}
