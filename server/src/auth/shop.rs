//! 商店赎回（买回）列表的持久化：卖出入表、买回删行、开商店读取。
//!
//! 从 `auth.rs` 机械搬出的一块完整职责（超大文件治理）。搬的是**代码位置**，
//! 不是数据布局：新表 `shop_rebuy` 与 `inventory` / `storage` 一样按账号行存放，
//! 事务语义不变。
//!
//! 负责：赎回行的读取（最新在前、带上限）、卖出入表（同 item 同价合并数量）、
//! 买回删行，以及随上限裁剪最老的行。
//! 不负责：买回的金额 / 背包容量规则与回执（`crate::trade`），表结构声明
//! （`crate::auth::schema`）。

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
                    params![account_id, next, item_id, i64::from(quantity), unit_price as i64],
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
        let list = read_shop_rebuy_db(&tx, account_id)?;
        tx.commit()
            .map_err(|_| "account persistence failed".to_owned())?;
        Ok(list)
    }

    /// Delete the row a buy-back just consumed.  Returns whether the row was
    /// really there: a `false` means the list changed underneath the request
    /// (for example a replayed intent), and the caller must refuse instead of
    /// handing out an item that is no longer for sale.
    pub fn take_shop_rebuy(
        &self,
        account_id: &str,
        item_id: &str,
        unit_price: u64,
    ) -> Result<bool, String> {
        let mut db = self
            .db
            .lock()
            .map_err(|_| "account store unavailable".to_owned())?;
        let tx = db
            .transaction()
            .map_err(|_| "account persistence failed".to_owned())?;
        let removed = tx
            .execute(
                "DELETE FROM shop_rebuy
                 WHERE account_id=?1 AND item_id=?2 AND unit_price=?3",
                params![account_id, item_id, unit_price as i64],
            )
            .map_err(|_| "account persistence failed".to_owned())?;
        tx.commit()
            .map_err(|_| "account persistence failed".to_owned())?;
        Ok(removed > 0)
    }
}
