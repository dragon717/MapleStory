//! 現金商店（TMS273 Commodity.img）：开窗余额回执与购买结算。
//!
//! 与 `trade.rs`（NPC 商店）平行的第五块交易职责。目录是静态装配数据
//! （`Gameplay.cash_shop`，Etc/Commodity.img 的 OnSale=1 子集）；客户端只能
//! 报「我要买哪个 SN、买几份」，商品、单价、堆数与每一条售卖条件都在这里
//! 解析。余额是 `Profile.cash`（SQLite），购买是先扣款再入包的原子事务，
//! 失败任一半段都不落账。
//!
//! ## 负责
//! - `CashOpen`：回执权威余额（`cashState`）。
//! - `CashBuy`：目录校验 → 条件校验（在售/等级/人气/性别/限购）→ 余额 →
//!   入包 → 落库 → 回执。`requestId` 幂等重放（与 party 相同的有界窗口）。
//! - 限购（`Limit`）：每角色购买预算，写入 `cash_purchases` 表跨重启累计。
//! - 租赁（`Period`）：非零行交付时打上 `_expiresAt` 截止时间，
//!   `step_rental_expiries` 定期收回过期堆并回执 `rentalNotice`。
//! - 目录查询辅助：`cash_commodity`（购买流程与测试共用）。
//!
//! ## 不负责
//! - 余额的授予：GM `/cash`（`gm.rs`）是当前唯一本地充值路径（P）。
//! - 持久化表结构（`crate::auth::schema`）与背包堆叠规则（`crate::inventory`）。
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
        if entry.limit > 0 {
            // Source `Limit` is a per-character purchase budget: every bought
            // quantity consumes one unit of it, persisted across restarts.
            let purchased = self.cash_purchased_units(&id, &sn);
            if purchased + u64::from(quantity) > u64::from(entry.limit) {
                fail(self, "cash_limit");
                return;
            }
        }
        if entry.gender != 2 && appearance_gender != Some(entry.gender) {
            fail(self, "cash_gender");
            return;
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
        if player.state.cash < total {
            fail(self, "cash_not_enough");
            return;
        }
        // Apply: deduct the wallet, add the stack(s).  Insertion is atomic
        // against a cloned inventory so a full-tab failure cancels the spend.
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
        let player = self.players.get_mut(&id).expect("player checked above");
        player.state.inventory = next_inventory;
        player.state.cash -= total;
        if let Some(store) = self.store.as_ref() {
            let _ = store.write_inventory(&id, &player.state.inventory);
            let _ = store.save_profile(
                &id,
                &profile_from_state(
                    &player.state,
                    &player.map_id,
                    &player.death_id,
                    player.base_max_mp,
                ),
            );
        }
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
        self.remember_cash_purchase(&id, &sn, quantity);
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
            player
                .state
                .inventory
                .retain(|item| !inventory::rental_expired(item, now));
            if let Some(store) = self.store.as_ref() {
                let _ = store.write_inventory(&id, &player.state.inventory);
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
