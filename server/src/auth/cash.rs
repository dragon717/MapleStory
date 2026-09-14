//! 現金商店购买的事务化落库（`CashBuy` 的持久半边）。
//!
//! 从 `auth.rs` 独立出来的一块职责：把「扣余额 + 发物品 + 限购增量 + 请求
//! 回执」收进**同一个 SQLite 事务**。余额与限购预算都在事务内从持久状态读取，
//! 提交成功后返回权威结果，由 `crate::cashshop` 才去更新 World 内存镜像。
//!
//! 之前的实现先改内存背包与余额、再分别 `write_inventory` / `save_profile`
//! 并忽略两者错误，且限购读取失败被当成「没买过」。那三条都在这里修掉：
//! - 读取失败向上返回错误，调用方据此拒绝，不按零继续；
//! - 写入失败事务整体回滚，不产生成功回执；
//! - `cash_actions` 记下 `sn`+`quantity` 指纹，同一 `requestId` 重放原结果，
//!   指纹不同则拒绝。
//!
//! ## 不负责
//! - 目录解析与售卖条件（在售/等级/人气/性别）——`crate::cashshop` 判完才进来；
//! - 背包堆叠与租赁期限戳（`crate::inventory::add_items_expiring`，调用方建好
//!   的候选背包作为事务的写入内容）；
//! - 余额授予（GM `/cash`，`crate::gm`）与表结构声明（`schema.rs`）。

use super::*;

/// 一次 `CashBuy` 的裁决结果。成功时字段是提交后的权威值；拒绝时
/// `cash`／`purchased_units` 仍是持久状态的真实读数，供调用方回正内存镜像。
#[derive(Clone, Debug)]
pub struct CashPurchaseOutcome {
    pub request_id: String,
    /// 请求指纹之一。
    pub sn: String,
    pub item_id: String,
    /// 请求指纹之一。
    pub quantity: u32,
    pub cash_spent: u64,
    /// 提交（或裁决）后的持久余额。
    pub cash: u64,
    /// 提交（或裁决）后该 SN 的累计已购次数。
    pub purchased_units: u64,
    pub success: bool,
    pub code: String,
}

impl CashPurchaseOutcome {
    /// 拒绝回执的构造器：不携带任何已发生的资产变化。
    fn refused(
        request_id: &str,
        sn: &str,
        quantity: u32,
        cash: u64,
        purchased_units: u64,
        code: &str,
    ) -> Self {
        Self {
            request_id: request_id.to_owned(),
            sn: sn.to_owned(),
            item_id: String::new(),
            quantity,
            cash_spent: 0,
            cash,
            purchased_units,
            success: false,
            code: code.to_owned(),
        }
    }
}

/// 读取一条持久请求回执。`None` 表示这个 `requestId` 还没被裁决过。
fn read_cash_action(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    request_id: &str,
) -> Result<Option<CashPurchaseOutcome>, String> {
    tx.query_row(
        "SELECT request_id,sn,item_id,quantity,cash_spent,cash_after,purchased_units,success,code
         FROM cash_actions WHERE account_id=?1 AND request_id=?2",
        params![account_id, request_id],
        |row| {
            Ok(CashPurchaseOutcome {
                request_id: row.get(0)?,
                sn: row.get(1)?,
                item_id: row.get(2)?,
                quantity: row.get::<_, i64>(3)?.max(0) as u32,
                cash_spent: row.get::<_, i64>(4)?.max(0) as u64,
                cash: row.get::<_, i64>(5)?.max(0) as u64,
                purchased_units: row.get::<_, i64>(6)?.max(0) as u64,
                success: row.get::<_, i64>(7)? != 0,
                code: row.get(8)?,
            })
        },
    )
    .optional()
    .map_err(|_| "account persistence failed".to_owned())
}

fn insert_cash_action(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    outcome: &CashPurchaseOutcome,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO cash_actions(account_id,request_id,sn,item_id,quantity,cash_spent,cash_after,purchased_units,success,code)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![
            account_id,
            outcome.request_id,
            outcome.sn,
            outcome.item_id,
            i64::from(outcome.quantity),
            i64::try_from(outcome.cash_spent).map_err(|_| "account persistence failed".to_owned())?,
            i64::try_from(outcome.cash).map_err(|_| "account persistence failed".to_owned())?,
            i64::try_from(outcome.purchased_units)
                .map_err(|_| "account persistence failed".to_owned())?,
            if outcome.success { 1 } else { 0 },
            outcome.code,
        ],
    )
    .map_err(|_| "account persistence failed".to_owned())?;
    Ok(())
}

/// 持久余额。`None` 表示该角色还没有 `player_stats` 行——此时不能假装余额
/// 是零再往下扣，必须拒绝。
fn read_cash_balance_tx(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
) -> Result<Option<u64>, String> {
    tx.query_row(
        "SELECT cash FROM player_stats WHERE account_id=?1",
        [account_id],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .map(|value| value.map(|cash| cash.max(0) as u64))
    .map_err(|_| "account persistence failed".to_owned())
}

/// 该 SN 的持久限购计数。读取失败返回 `Err`（绝不回退成 0）。
fn read_cash_purchased_tx(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    sn: &str,
) -> Result<u64, String> {
    tx.query_row(
        "SELECT units FROM cash_purchases WHERE account_id=?1 AND sn=?2",
        params![account_id, sn],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .map(|units| units.unwrap_or(0).max(0) as u64)
    .map_err(|_| "account persistence failed".to_owned())
}

impl Store {
    /// 現金商店购买的唯一权威事务。`inventory` 是调用方已按
    /// `inventory::add_items_expiring` 建好的候选背包（含堆叠与租赁期限戳），
    /// 只有本事务提交成功它才落库。
    ///
    /// 返回 `Err` 表示存储层不可用或写入失败：调用方**不得**更新内存、不得
    /// 回执成功。返回 `Ok` 时无论成功或拒绝，`outcome.cash` 都是持久余额。
    #[allow(clippy::too_many_arguments)]
    pub fn cash_purchase(
        &self,
        account_id: &str,
        request_id: &str,
        sn: &str,
        item_id: &str,
        quantity: u32,
        total: u64,
        limit: u32,
        inventory: &[InventoryItem],
    ) -> Result<CashPurchaseOutcome, String> {
        let mut db = self
            .db
            .lock()
            .map_err(|_| "account store unavailable".to_owned())?;
        let tx = db
            .transaction()
            .map_err(|_| "account persistence failed".to_owned())?;
        // 1) 持久回执优先：同一 requestId 重放原结果，绝不二次扣款/发货。
        if let Some(prior) = read_cash_action(&tx, account_id, request_id)? {
            tx.commit()
                .map_err(|_| "account persistence failed".to_owned())?;
            if prior.sn == sn && prior.quantity == quantity {
                return Ok(prior);
            }
            // requestId 一次性：换了 SN 或数量就是另一个请求，拒绝而不是
            // 以新参数重放。余额/限购读数照旧带回，供内存回正。
            return Ok(CashPurchaseOutcome::refused(
                request_id,
                sn,
                quantity,
                prior.cash,
                prior.purchased_units,
                "cash_request_conflict",
            ));
        }
        // 2) 余额与限购预算都读持久状态。读不到角色档案就拒绝；限购读取失败
        //    直接向上报错——把失败当「没买过」正是本次要修的缺陷。
        let Some(balance) = read_cash_balance_tx(&tx, account_id)? else {
            tx.commit()
                .map_err(|_| "account persistence failed".to_owned())?;
            return Ok(CashPurchaseOutcome::refused(
                request_id,
                sn,
                quantity,
                0,
                0,
                "profile_unavailable",
            ));
        };
        let purchased = read_cash_purchased_tx(&tx, account_id, sn)?;
        // 3) 裁决，然后在同一个事务里决定是否落账。
        let refusal = if limit > 0 && purchased + u64::from(quantity) > u64::from(limit) {
            Some("cash_limit")
        } else if balance < total {
            Some("cash_not_enough")
        } else {
            None
        };
        if let Some(code) = refusal {
            let outcome =
                CashPurchaseOutcome::refused(request_id, sn, quantity, balance, purchased, code);
            // 拒绝也记回执：同一个 requestId 重放要拿到同一个判决，而不是
            // 因为之后凑够钱就变成一次新购买。
            insert_cash_action(&tx, account_id, &outcome)?;
            tx.commit()
                .map_err(|_| "account persistence failed".to_owned())?;
            return Ok(outcome);
        }
        // 4) 提交：背包、余额、限购计数、请求回执四者共同落账。任一步失败都
        //    靠事务回滚，不会留下「扣了钱没发货」或「发了货没记账」。
        let cash_after = balance - total;
        let purchased_after = purchased + u64::from(quantity);
        write_inventory_tx(&tx, account_id, inventory)?;
        let updated = tx
            .execute(
                "UPDATE player_stats SET cash=?2 WHERE account_id=?1",
                params![
                    account_id,
                    i64::try_from(cash_after)
                        .map_err(|_| "account persistence failed".to_owned())?
                ],
            )
            .map_err(|_| "account persistence failed".to_owned())?;
        if updated != 1 {
            return Err("account persistence failed".to_owned());
        }
        tx.execute(
            "INSERT INTO cash_purchases(account_id,sn,units) VALUES(?1,?2,?3)
             ON CONFLICT(account_id,sn) DO UPDATE SET units=units+?3",
            params![account_id, sn, i64::from(quantity)],
        )
        .map_err(|_| "account persistence failed".to_owned())?;
        let outcome = CashPurchaseOutcome {
            request_id: request_id.to_owned(),
            sn: sn.to_owned(),
            item_id: item_id.to_owned(),
            quantity,
            cash_spent: total,
            cash: cash_after,
            purchased_units: purchased_after,
            success: true,
            code: String::new(),
        };
        insert_cash_action(&tx, account_id, &outcome)?;
        tx.commit()
            .map_err(|_| "account persistence failed".to_owned())?;
        Ok(outcome)
    }
}
