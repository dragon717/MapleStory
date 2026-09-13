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
//! - `CashBuy`：目录校验 → 条件校验（在售/等级/人气/性别）→ 余额 → 入包 →
//!   落库 → 回执。`requestId` 幂等重放（与 party 相同的有界窗口）。
//! - 目录查询辅助：`cash_commodity`。
//!
//! ## 不负责
//! - 余额的授予：GM `/cash`（`gm.rs`）是当前唯一本地充值路径（P）。
//! - 持久化表结构（`crate::auth::schema`）与背包堆叠规则（`crate::inventory`）。
//! - 礼品赠送、愿望单、里程、优惠券：源系统存在但本阶段不实现（P）。

use super::*;

/// Bounded request-id idempotency window for cash intents: a retried buy
/// replays the recorded outcome instead of charging a second time.  Same
/// shape as the party request window in `social.rs`.
const CASH_REQUEST_WINDOW: usize = 64;

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
        let Some(catalogue) = self.gameplay.cash_shop.as_ref() else {
            fail(self, "cash_shop_unavailable");
            return;
        };
        let Some(entry) = catalogue
            .commodities
            .iter()
            .find(|entry| entry.sn == sn)
            .cloned()
        else {
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
        let player_state = &self.players[&id].state;
        if entry.req_level > 0 && player_state.level < entry.req_level {
            fail(self, "cash_req_level");
            return;
        }
        if entry.req_pop > 0 {
            // 人气度 is not implemented locally; a row that demands it cannot
            // be honestly sold, so it is refused instead of ignored.
            fail(self, "cash_req_pop");
            return;
        }
        if entry.gender != 2 {
            let appearance_gender = player_state.appearance.as_ref().map(|a| a.gender);
            if appearance_gender != Some(entry.gender) {
                fail(self, "cash_gender");
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
        // One commodity row delivers `count` units; buying `quantity` deals
        // multiplies through, and every unit lands in the cash tab.
        let units = match u64::from(entry.count).checked_mul(u64::from(quantity)) {
            Some(units) => u32::try_from(units).unwrap_or(u32::MAX),
            None => {
                fail(self, "cash_quantity_invalid");
                return;
            }
        };
        if let Err(error) =
            inventory::add_items(&mut next_inventory, entry.item_id.clone(), units, slot_limit)
        {
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
