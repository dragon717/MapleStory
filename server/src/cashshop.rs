//! 現金商店（TMS273 Commodity.img）：开窗余额回执与购买结算。
//!
//! 与 `trade.rs`（NPC 商店）平行的第五块交易职责。目录是静态装配数据
//! （`Gameplay.cash_shop`，Etc/Commodity.img 的 OnSale=1 子集）；客户端只能
//! 报「我要买哪个 SN、买几份」，商品、单价、堆数与每一条售卖条件都在这里
//! 解析。余额是 `Profile.cash`（SQLite）。
//!
//! 资产半边收在 `Store::cash_purchase`（`crate::auth::cash`）的一个事务里：
//! 余额、交付的背包、限购计数与请求回执共同提交，**提交成功后**本模块才更新
//! World 内存并发成功回执。存储层失败时内存不动、不回执成功。
//!
//! ## 负责
//! - `CashOpen`：回执权威余额（`cashState`）。
//! - `CashBuy`：目录校验 → 纯请求条件（在售/等级/人气/性别）→ 建候选背包 →
//!   交事务提交（余额/限购/请求指纹在其中裁决）→ 回执。
//! - `requestId` 幂等：内存窗口是本进程的快速路径，权威记录是持久表
//!   `cash_actions`（同 `requestId` 不同 SN/数量会被拒绝）。
//! - 限购（`Limit`）：每角色购买预算，事务内读写 `cash_purchases` 跨重启累计。
//! - 租赁（`Period`）：非零行交付时打上 `_expiresAt` 截止时间，
//!   `step_rental_expiries` 定期收回过期堆并回执 `rentalNotice`。
//! - 目录查询辅助：`cash_commodity`（购买流程与测试共用）。
//!
//! ## 不负责
//! - 购买事务本身与 `cash_actions` / `cash_purchases` 的表结构
//!   （`crate::auth::cash`、`crate::auth::schema`）。
//! - 余额的授予：GM `/cash`（`gm.rs`）是当前唯一本地充值路径（P）。
//! - 背包堆叠规则（`crate::inventory`）。
//! - 礼品赠送、愿望单、里程、优惠券、退款（`refundable`）：源系统存在但本
//!   阶段不实现（P）。

use super::*;

/// Bounded request-id idempotency window for cash intents: a retried buy
/// replays the recorded outcome instead of charging a second time.  Same
/// shape as the party request window in `social.rs`.
const CASH_REQUEST_WINDOW: usize = 64;

/// How often the rental sweep runs, in world ticks (10 s at 50 ms/tick).
const RENTAL_SWEEP_TICKS: u64 = 10_000 / TICK_MS;

/// One resolved cash purchase, recorded for replay.
#[derive(Clone, Debug)]
pub(super) struct CashOutcome {
    pub(super) success: bool,
    pub(super) code: String,
    /// Fields echoed back on replay so the client's pending row still clears.
    pub(super) sn: String,
    pub(super) item_id: String,
    pub(super) quantity: u32,
    pub(super) cash_spent: u64,
}

impl World {
    /// Authoritative balance for the 現金商店 window.
    pub(super) fn handle_cash_open(&mut self, id: String, request_id: String) {
        let Some(player) = self.players.get(&id) else {
            return;
        };
        self.send_cash_state(&id, &request_id, player.state.cash);
    }

    /// Buy one catalogue row `quantity` times.
    ///
    /// The asset half runs in one `Store::cash_purchase` transaction (balance,
    /// delivered bag, limit budget and the request receipt commit together).
    /// World memory is updated **only after** that commit returns, so a store
    /// failure can no longer leave a granted item behind a wallet that was
    /// never charged — nor a success receipt without a durable record.
    pub(super) fn handle_cash_buy(
        &mut self,
        id: String,
        request_id: String,
        sn: String,
        quantity: u32,
    ) {
        if !self.players.contains_key(&id) {
            return;
        }
        if let Some(outcome) = self.replayed_cash_request(&id, &request_id) {
            self.send_cash_buy_result(
                &id,
                &request_id,
                outcome.success,
                &outcome.code,
                &outcome.sn,
                &outcome.item_id,
                outcome.quantity,
                outcome.cash_spent,
            );
            return;
        }
        let fail = |world: &mut World, code: &str| {
            world.remember_cash_request(
                &id,
                &request_id,
                false,
                code,
                &sn,
                "",
                quantity,
                0,
            );
            world.send_cash_buy_result(&id, &request_id, false, code, &sn, "", quantity, 0);
        };
        let store = self.store.clone();
        // The catalogue is optional at the World level so unit-test worlds do
        // not need the export; a missing catalogue refuses every purchase.
        if self.gameplay.cash_shop.is_none() {
            fail(self, "cash_shop_unavailable");
            return;
        }
        let Some(entry) = self.cash_commodity(&sn) else {
            fail(self, "cash_sn_unknown");
            return;
        };
        // Source condition gates, checked in the order a player would notice.
        // These are pure functions of the request plus the catalogue, so they
        // need no durable receipt: replaying one yields the same refusal.
        if entry.price == 0 {
            // Price-0 rows are the source's coupon/exchange catalog; there is
            // no local redemption path, so they are never purchasable.
            fail(self, "cash_not_purchasable");
            return;
        }
        let (level, appearance_gender) = {
            let state = &self.players[&id].state;
            (state.level, state.appearance.as_ref().map(|a| a.gender))
        };
        if entry.req_level > 0 && level < entry.req_level {
            fail(self, "cash_req_level");
            return;
        }
        if entry.req_pop > 0 {
            // 人气度 is not implemented locally; a row that demands it cannot
            // be honestly sold, so it is refused instead of ignored.
            fail(self, "cash_req_pop");
            return;
        }
        if entry.gender != 2 && appearance_gender != Some(entry.gender) {
            fail(self, "cash_gender");
            return;
        }
        // A store-backed world re-checks the budget inside the purchase
        // transaction against `cash_purchases`; only a store-less world (unit
        // tests, no persistence) falls back to the in-memory mirror.
        if store.is_none() && entry.limit > 0 {
            let purchased = self.cash_purchased_units(&id, &sn);
            if purchased + u64::from(quantity) > u64::from(entry.limit) {
                fail(self, "cash_limit");
                return;
            }
        }
        let Some(player) = self.players.get_mut(&id) else {
            return;
        };
        let total = match entry.price.checked_mul(u64::from(quantity)) {
            Some(total) => total,
            None => {
                fail(self, "cash_quantity_invalid");
                return;
            }
        };
        if store.is_none() && player.state.cash < total {
            fail(self, "cash_not_enough");
            return;
        }
        // Build the candidate bag.  Insertion is atomic against a clone so a
        // full-tab failure cancels the spend before anything is persisted.
        let kind = inventory::inventory_type(&entry.item_id).unwrap_or(5);
        let slot_limit = player
            .state
            .inventory_slots
            .get(&kind)
            .copied()
            .unwrap_or(inventory::SLOT_LIMIT);
        let mut next_inventory = player.state.inventory.clone();
        // One commodity row delivers `count` units plus its `bonus` extra;
        // buying `quantity` deals multiplies through, and every unit lands in
        // the cash tab.
        let units = match u64::from(entry.count)
            .checked_add(entry.bonus)
            .and_then(|per_deal| per_deal.checked_mul(u64::from(quantity)))
        {
            Some(units) => u32::try_from(units).unwrap_or(u32::MAX),
            None => {
                fail(self, "cash_quantity_invalid");
                return;
            }
        };
        // Source `Period` rows are rentals: the delivery stamps an absolute
        // wall-clock deadline that `step_rental_expiries` enforces later.
        let expires_at = (entry.period > 0).then(|| {
            unix_now_ms() / 1000 + i64::from(entry.period) * inventory::RENTAL_DAY_SECONDS
        });
        if let Err(error) = inventory::add_items_expiring(
            &mut next_inventory,
            entry.item_id.clone(),
            units,
            slot_limit,
            expires_at,
        ) {
            let code = match error {
                inventory::InventoryError::InventoryFull => "cash_inventory_full",
                inventory::InventoryError::UnknownItem => "cash_item_unknown",
                _ => "cash_rejected",
            };
            fail(self, code);
            return;
        }
        let Some(store) = store else {
            // Store-less world: no durable half to commit, so the in-memory
            // apply stays as the single authority (unchanged legacy path).
            let player = self.players.get_mut(&id).expect("player checked above");
            player.state.inventory = next_inventory;
            player.state.cash -= total;
            self.remember_cash_purchase(&id, &sn, quantity);
            self.remember_cash_request(
                &id,
                &request_id,
                true,
                "",
                &sn,
                &entry.item_id,
                quantity,
                total,
            );
            self.send_cash_buy_result(
                &id,
                &request_id,
                true,
                "",
                &sn,
                &entry.item_id,
                quantity,
                total,
            );
            return;
        };
        let outcome = match store.cash_purchase(
            &id,
            &request_id,
            &sn,
            &entry.item_id,
            quantity,
            total,
            entry.limit,
            &next_inventory,
        ) {
            Ok(outcome) => outcome,
            Err(_) => {
                // The store refused the commit: nothing was charged and
                // nothing was delivered, so World memory must stay untouched.
                fail(self, "cash_store_unavailable");
                return;
            }
        };
        // Commit succeeded.  Adopt the persisted post-state and re-sync the
        // wallet even on a refusal, so the mirror can never drift from the
        // durable balance the transaction just read.
        if let Some(player) = self.players.get_mut(&id) {
            if outcome.success {
                player.state.inventory = next_inventory;
            }
            player.state.cash = outcome.cash;
        }
        self.cash_purchases
            .insert((id.clone(), sn.clone()), outcome.purchased_units);
        let delivered = if outcome.success { entry.item_id.as_str() } else { "" };
        self.remember_cash_request(
            &id,
            &request_id,
            outcome.success,
            &outcome.code,
            &sn,
            delivered,
            quantity,
            outcome.cash_spent,
        );
        self.send_cash_buy_result(
            &id,
            &request_id,
            outcome.success,
            &outcome.code,
            &sn,
            delivered,
            quantity,
            outcome.cash_spent,
        );
    }

    /// Catalogue lookup shared with the GM command surface.
    pub(super) fn cash_commodity(&self, sn: &str) -> Option<CashCommodity> {
        self.gameplay
            .cash_shop
            .as_ref()?
            .commodities
            .iter()
            .find(|entry| entry.sn == sn)
            .cloned()
    }

    fn remember_cash_request(
        &mut self,
        id: &str,
        request_id: &str,
        success: bool,
        code: &str,
        sn: &str,
        item_id: &str,
        quantity: u32,
        cash_spent: u64,
    ) {
        if self.cash_requests.len() >= CASH_REQUEST_WINDOW * self.players.len().max(1) {
            self.cash_requests
                .retain(|(player_id, _), _| self.players.contains_key(player_id));
        }
        self.cash_requests.insert(
            (id.to_owned(), request_id.to_owned()),
            CashOutcome {
                success,
                code: code.to_owned(),
                sn: sn.to_owned(),
                item_id: item_id.to_owned(),
                quantity,
                cash_spent,
            },
        );
    }

    /// The purchase counter for one (player, SN) pair.  Store-backed worlds
    /// read through to the persisted `cash_purchases` row on first touch;
    /// store-less test worlds start at zero.
    fn cash_purchased_units(&mut self, id: &str, sn: &str) -> u64 {
        let key = (id.to_owned(), sn.to_owned());
        if let Some(units) = self.cash_purchases.get(&key) {
            return *units;
        }
        let units = self
            .store
            .as_ref()
            .and_then(|store| store.cash_purchased_units(id, sn).ok())
            .unwrap_or(0);
        self.cash_purchases.insert(key, units);
        units
    }

    /// Consume `quantity` of the SN's purchase budget (write-through).
    fn remember_cash_purchase(&mut self, id: &str, sn: &str, quantity: u32) {
        let entry = self
            .cash_purchases
            .entry((id.to_owned(), sn.to_owned()))
            .or_insert(0);
        *entry += u64::from(quantity);
        if let Some(store) = self.store.as_ref() {
            let _ = store.record_cash_purchase(id, sn, u64::from(quantity));
        }
    }

    /// Remove every expired rental stack from every online character,
    /// persist the trimmed bag and tell the owner what was reclaimed.  Called
    /// once per world tick; the modulo gate makes the actual sweep a 10 s
    /// cadence, so an expired item survives at most one sweep interval.
    pub(crate) fn step_rental_expiries(&mut self) {
        if self.tick % RENTAL_SWEEP_TICKS != 0 {
            return;
        }
        let now = unix_now_ms() / 1000;
        let ids: Vec<String> = self.players.keys().cloned().collect();
        for id in ids {
            let Some(player) = self.players.get_mut(&id) else {
                continue;
            };
            let expired: Vec<String> = player
                .state
                .inventory
                .iter()
                .filter(|item| inventory::rental_expired(item, now))
                .map(|item| item.item_id.clone())
                .collect();
            if expired.is_empty() {
                continue;
            }
            // NB-04：先在克隆上算好收紧后的背包并落库，写库成功才改内存。
            // 之前是「先 retain 内存再 `let _ =` 写库」——持久化失败时内存
            // 已把过期品丢掉而存档还在，重连后物品复活。失败时跳过本角色，
            // 下一轮清扫（10s 节奏）自动重试。
            let next_inventory: Vec<crate::protocol::InventoryItem> = player
                .state
                .inventory
                .iter()
                .filter(|item| !inventory::rental_expired(item, now))
                .cloned()
                .collect();
            if let Some(store) = self.store.as_ref() {
                if store.write_inventory(&id, &next_inventory).is_err() {
                    continue;
                }
            }
            if let Some(player) = self.players.get_mut(&id) {
                player.state.inventory = next_inventory;
            }
            let mut item_ids = expired;
            item_ids.sort();
            item_ids.dedup();
            let payload = serde_json::json!({
                "type": "rentalNotice",
                "itemIds": item_ids,
            });
            if let Some(player) = self.players.get(&id) {
                let _ = player.output.try_send(payload.to_string());
            }
        }
    }

    fn replayed_cash_request(&self, id: &str, request_id: &str) -> Option<CashOutcome> {
        self.cash_requests
            .get(&(id.to_owned(), request_id.to_owned()))
            .cloned()
    }

    fn send_cash_state(&self, id: &str, request_id: &str, cash: u64) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let payload = serde_json::json!({
            "type": "cashState",
            "requestId": request_id,
            "cash": cash,
        });
        let _ = player.output.try_send(payload.to_string());
    }

    #[allow(clippy::too_many_arguments)]
    fn send_cash_buy_result(
        &self,
        id: &str,
        request_id: &str,
        success: bool,
        code: &str,
        sn: &str,
        item_id: &str,
        quantity: u32,
        cash_spent: u64,
    ) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let payload = serde_json::json!({
            "type": "cashBuyResult",
            "requestId": request_id,
            "success": success,
            "code": code,
            "sn": sn,
            "itemId": item_id,
            "quantity": quantity,
            "cashSpent": cash_spent,
            "cash": self.players.get(id).map(|p| p.state.cash).unwrap_or(0),
        });
        let _ = player.output.try_send(payload.to_string());
    }
}
