//! 交易职责：NPC 商店（买 / 卖 / 赎回）与账号仓库（开仓、转账、金币存取）。
//!
//! 从 `world.rs` 机械搬出的第四块完整职责（超大文件治理 P2）。搬的是**代码位置**，
//! 不是数据布局：`Player` / `World` 的字段仍在原处，协议、存档与 Tick 次序均未改变。
//!
//! ## 负责
//! - 商店买入 / 卖出的**完整事务外观**：keeper 距离与在售校验、容量与金币重算、
//!   `requestId` 幂等重放、回执下发。客户端报的槽位 / 数量 / 价格只作意图，不作事实。
//! - 商店**赎回**（买回）：卖出时把该笔写进 `shop_rebuy`（`crate::auth`），买回时按
//!   表里的行与单价重算，行不在表里就拒绝；同样带 `requestId` 幂等重放。
//! - 账号仓库的开仓、物品转账（存 / 取）与金币存取：仓库行落在 `crate::auth`（SQLite），
//!   **事务成功后才**改内存并回执；转账会连带刷新角色身上随之变化的行
//!   （`reload_storage_side_effects`），避免"仓库扣了、身上没到账"的中间态被看见。
//! - 仓库 keeper 的**会话内距离复核**（`storage_keeper_in_range`）：
//!   开着的仓库窗在 NPC 换图 / 消失后必须失效，而不是凭缓存继续操作。
//!
//! ## 不负责
//! - 仓库、赎回表与商店的**落库 / 读取 / DTO**：`crate::auth`（`Store` /
//!   `StorageTransferOperation` / `ShopSellOutcome` / `ShopRebuyRow` 等）
//! - 商店窗口的**打开回执**（`send_shop_result`）：它长在 NPC 对话链路里，随对话一起走
//! - 物品堆叠 / 容量规则本身：`crate::inventory`

use super::*;
use crate::auth::notebook::{AcquisitionSource, ItemAcquisition};
use crate::auth::shop::ShopRebuyRow;

impl World {
    pub(super) fn handle_shop_buy(
        &mut self,
        id: String,
        request_id: String,
        shop_id: String,
        item_id: String,
        quantity: u32,
    ) {
        let Some(player) = self.players.get(&id) else {
            return;
        };
        // A purchase spends mesos and grants an item, so a replayed request must
        // not run twice.  Re-send the remembered result instead of charging
        // again — the same guard `ShopSell` and `ShopRebuy` already carry.
        if let Some(prior) = self
            .shop_buy_requests
            .get(&(id.clone(), request_id.clone()))
        {
            self.send_shop_result(
                &id,
                &request_id,
                prior.success,
                &prior.code,
                &prior.shop_id,
                &prior.item_id,
                prior.quantity,
                prior.mesos_spent,
            );
            return;
        }
        let shop = match self
            .gameplay
            .shops
            .iter()
            .find(|shop| shop.shop_id == shop_id)
            .cloned()
        {
            Some(shop) => shop,
            None => {
                self.send_shop_buy_result(
                    &id,
                    &request_id,
                    false,
                    "shop_unknown",
                    &shop_id,
                    &item_id,
                    quantity,
                    0,
                );
                return;
            }
        };
        let npc_in_range = self.npcs.values().any(|npc| {
            npc.map_id == player.map_id
                && npc.state.shop_id.as_deref() == Some(shop_id.as_str())
                && (player.state.x - npc.state.x).abs() <= npc::TALK_RANGE_X
                && (player.state.y - npc.state.y).abs() <= npc::TALK_RANGE_Y
        });
        if !npc_in_range {
            self.send_shop_buy_result(
                &id,
                &request_id,
                false,
                "shop_too_far",
                &shop_id,
                &item_id,
                quantity,
                0,
            );
            return;
        }
        let unit_price = match shop.price(&item_id) {
            Some(price) => price,
            None => {
                self.send_shop_buy_result(
                    &id,
                    &request_id,
                    false,
                    "shop_item_unknown",
                    &shop_id,
                    &item_id,
                    quantity,
                    0,
                );
                return;
            }
        };
        let total = match unit_price.checked_mul(u64::from(quantity)) {
            Some(total) => total,
            None => {
                self.send_shop_buy_result(
                    &id,
                    &request_id,
                    false,
                    "shop_quantity_invalid",
                    &shop_id,
                    &item_id,
                    quantity,
                    0,
                );
                return;
            }
        };
        if player.state.mesos < total {
            self.send_shop_buy_result(
                &id,
                &request_id,
                false,
                "shop_not_enough_mesos",
                &shop_id,
                &item_id,
                quantity,
                0,
            );
            return;
        }
        // Apply: deduct mesos, add items.  Insertion is atomic against a
        // cloned inventory so a full-tab failure cancels the gold spend.
        let mut next_inventory = player.state.inventory.clone();
        let kind = inventory::inventory_type(&item_id).unwrap_or(4);
        let slot_limit = player
            .state
            .inventory_slots
            .get(&kind)
            .copied()
            .unwrap_or(inventory::SLOT_LIMIT);
        if let Err(error) =
            inventory::add_items(&mut next_inventory, item_id.clone(), quantity, slot_limit)
        {
            self.send_shop_buy_result(
                &id,
                &request_id,
                false,
                match error {
                    inventory::InventoryError::InventoryFull => "shop_inventory_full",
                    inventory::InventoryError::UnknownItem => "shop_item_unknown",
                    _ => "shop_rejected",
                },
                &shop_id,
                &item_id,
                quantity,
                0,
            );
            return;
        }
        let new_mesos = player.state.mesos - total;
        // NB-04：扣金币 + 授予行是**一个事务**。先在克隆上算好结果并落库，
        // commit 成功后才改内存——持久化失败整笔回滚并按 `persistence` 拒绝，
        // 不再是「先改内存再 `let _ =` 写库」的静默吞错。
        let mut profile = profile_from_state(
            &player.state,
            &player.map_id,
            &player.death_id,
            player.base_max_mp,
        );
        profile.mesos = new_mesos;
        // NB-05：本次购买真正授予的物品＝商店这一笔的 item_id×quantity。只
        // 在 add_items 已确认成功之后构造，与资产同事务留档。
        let grants = [ItemAcquisition {
            item_id: item_id.as_str(),
            quantity,
            source: AcquisitionSource::ShopBuy,
            source_ref: Some(request_id.as_str()),
        }];
        if let Some(store) = self.store.as_ref() {
            if store
                .shop_buy_commit(&id, &profile, &next_inventory, &grants)
                .is_err()
            {
                self.send_shop_buy_result(
                    &id,
                    &request_id,
                    false,
                    "persistence",
                    &shop_id,
                    &item_id,
                    quantity,
                    0,
                );
                return;
            }
        }
        let player = match self.players.get_mut(&id) {
            Some(player) => player,
            None => return,
        };
        player.state.inventory = next_inventory;
        player.state.mesos = new_mesos;
        self.send_shop_buy_result(
            &id,
            &request_id,
            true,
            "",
            &shop_id,
            &item_id,
            quantity,
            total,
        );
    }

    /// Record one shop purchase outcome and send it.  Every exit of
    /// `handle_shop_buy` goes through here, so the ledger sees refusals as well:
    /// a request that was already refused stays refused, and a request that
    /// already paid is never charged twice.
    ///
    /// This is the buy-side counterpart of `send_shop_sell_result` /
    /// `send_shop_rebuy_result`.  It was the missing one: a retried `ShopBuy`
    /// packet used to deduct mesos and grant the stack again.
    fn send_shop_buy_result(
        &mut self,
        id: &str,
        request_id: &str,
        success: bool,
        code: &str,
        shop_id: &str,
        item_id: &str,
        quantity: u32,
        mesos_spent: u64,
    ) {
        self.shop_buy_requests.insert(
            (id.to_owned(), request_id.to_owned()),
            ShopBuyOutcome {
                success,
                code: code.to_owned(),
                shop_id: shop_id.to_owned(),
                item_id: item_id.to_owned(),
                quantity,
                mesos_spent,
            },
        );
        self.send_shop_result(
            id,
            request_id,
            success,
            code,
            shop_id,
            item_id,
            quantity,
            mesos_spent,
        );
    }

    /// Authoritative NPC shop sell-back (`ShopSell`), the other half of the
    /// shop loop.
    ///
    /// The client only names the shop, the tab and the slot.  Which item sits
    /// there, how many it holds, whether the source lets it be sold and how
    /// many mesos it is worth are all resolved here, so a tampered request can
    /// neither rename the item nor name its own price.
    ///
    /// The whole exchange is one atomic step: the stack is removed from a
    /// cloned inventory and only committed together with the mesos credit, so
    /// a failure can never pay out without taking the item (or vice versa).
    pub(super) fn handle_shop_sell(
        &mut self,
        id: String,
        request_id: String,
        shop_id: String,
        inventory_type: u8,
        source_slot: i16,
        quantity: u32,
    ) {
        let Some(player) = self.players.get(&id) else {
            return;
        };
        // A sell credits mesos, so a replayed request must not run twice.
        // Re-send the remembered result instead of touching the inventory.
        if let Some(prior) = self
            .shop_sell_requests
            .get(&(id.clone(), request_id.clone()))
        {
            let prior = prior.clone();
            self.send_shop_sell_outcome(&id, &request_id, &prior);
            return;
        }
        // The merchant must be on the player's own map and within talking
        // range, exactly as for a purchase; otherwise a client could trade
        // with a shop it never walked to.
        let shop_known = self
            .gameplay
            .shops
            .iter()
            .any(|shop| shop.shop_id == shop_id);
        if !shop_known {
            self.send_shop_sell_result(
                &id,
                &request_id,
                false,
                "shop_unknown",
                &shop_id,
                "",
                quantity,
                source_slot,
                0,
            );
            return;
        }
        let npc_in_range = self.npcs.values().any(|npc| {
            npc.map_id == player.map_id
                && npc.state.shop_id.as_deref() == Some(shop_id.as_str())
                && (player.state.x - npc.state.x).abs() <= npc::TALK_RANGE_X
                && (player.state.y - npc.state.y).abs() <= npc::TALK_RANGE_Y
        });
        if !npc_in_range {
            self.send_shop_sell_result(
                &id,
                &request_id,
                false,
                "shop_too_far",
                &shop_id,
                "",
                quantity,
                source_slot,
                0,
            );
            return;
        }
        // Resolve the stack server-side; the client's idea of what is in the
        // slot is never trusted.  Slot numbers are local per tab, so the tab
        // has to be part of the match itself: filtering the slot match first
        // would let an equip-tab item with the same local slot number shadow
        // the consumable the client is actually selling.
        let Some(stack) = player.state.inventory.iter().find(|item| {
            inventory::inventory_type(&item.item_id) == Some(inventory_type)
                && item.slot == source_slot as u16
        }) else {
            self.send_shop_sell_result(
                &id,
                &request_id,
                false,
                "shop_slot_empty",
                &shop_id,
                "",
                quantity,
                source_slot,
                0,
            );
            return;
        };
        let item_id = stack.item_id.clone();
        let available = stack.quantity;
        if available < quantity {
            self.send_shop_sell_result(
                &id,
                &request_id,
                false,
                "shop_quantity_invalid",
                &shop_id,
                &item_id,
                quantity,
                source_slot,
                0,
            );
            return;
        }
        // Source-authored restrictions: quest/cash/one-of-a-kind items carry
        // no shop value, so selling them is refused rather than paying mesos
        // for something the original never lets leave the inventory.
        if inventory::is_unsellable(&item_id) || inventory::is_cash_item(&item_id) {
            self.send_shop_sell_result(
                &id,
                &request_id,
                false,
                "shop_item_unsellable",
                &shop_id,
                &item_id,
                quantity,
                source_slot,
                0,
            );
            return;
        }
        // The arrow family (206xxxx) authors `price: 0` yet stays sellable at
        // a flat 1 meso apiece; everything else pays a fraction of the
        // catalog price (see SHOP_SELL_PRICE_PERCENT), floored at one meso —
        // a shop never pays zero for something the source gave a price tag,
        // which is what kept price-1 equipment (木棒/劍) unsellable.  Rounding
        // is down so a shop can never pay out more than the authored value
        // allows.
        let unit_payout = inventory::flat_sell_payout(&item_id).or_else(|| {
            inventory::item_price(&item_id).map(|unit_price| {
                (unit_price.saturating_mul(SHOP_SELL_PRICE_PERCENT) / SHOP_SELL_PRICE_DIVISOR)
                    .max(1)
            })
        });
        let Some(unit_payout) = unit_payout else {
            self.send_shop_sell_result(
                &id,
                &request_id,
                false,
                "shop_item_unsellable",
                &shop_id,
                &item_id,
                quantity,
                source_slot,
                0,
            );
            return;
        };
        if unit_payout == 0 {
            self.send_shop_sell_result(
                &id,
                &request_id,
                false,
                "shop_item_unsellable",
                &shop_id,
                &item_id,
                quantity,
                source_slot,
                0,
            );
            return;
        }
        let payout = match unit_payout.checked_mul(u64::from(quantity)) {
            Some(payout) => payout,
            None => {
                self.send_shop_sell_result(
                    &id,
                    &request_id,
                    false,
                    "shop_quantity_invalid",
                    &shop_id,
                    &item_id,
                    quantity,
                    source_slot,
                    0,
                );
                return;
            }
        };
        // Atomic against a clone: the removal must fully succeed before any
        // mesos move, so a partial state can never be persisted.
        let mut next_inventory = player.state.inventory.clone();
        if let Err(error) =
            inventory::remove_items(&mut next_inventory, inventory_type, source_slot, quantity)
        {
            self.send_shop_sell_result(
                &id,
                &request_id,
                false,
                match error {
                    inventory::InventoryError::InvalidInventoryType => "shop_rejected",
                    inventory::InventoryError::InvalidSlot => "shop_slot_empty",
                    inventory::InventoryError::SourceEmpty => "shop_slot_empty",
                    inventory::InventoryError::QuantityMissing => "shop_quantity_invalid",
                    _ => "shop_rejected",
                },
                &shop_id,
                &item_id,
                quantity,
                source_slot,
                0,
            );
            return;
        }
        let new_mesos = player.state.mesos.saturating_add(payout);
        // NB-04：移除背包行 + 入账金币 + 赎回行入表是**一个事务**。先在
        // 克隆上算好并落库，commit 成功后才改内存；持久化失败整笔回滚并
        // 按 `persistence` 拒绝（回执账本记住这次拒绝，重放不再重试）。
        let mut profile = profile_from_state(
            &player.state,
            &player.map_id,
            &player.death_id,
            player.base_max_mp,
        );
        profile.mesos = new_mesos;
        let rebuy_row = ShopRebuyRow {
            item_id: item_id.clone(),
            quantity,
            unit_price: unit_payout,
        };
        if let Some(store) = self.store.as_ref() {
            if store
                .shop_sell_commit(&id, &profile, &next_inventory, Some(rebuy_row))
                .is_err()
            {
                self.send_shop_sell_result(
                    &id,
                    &request_id,
                    false,
                    "persistence",
                    &shop_id,
                    &item_id,
                    quantity,
                    source_slot,
                    0,
                );
                return;
            }
        }
        let player = match self.players.get_mut(&id) {
            Some(player) => player,
            None => return,
        };
        player.state.inventory = next_inventory;
        player.state.mesos = new_mesos;
        self.send_shop_sell_result(
            &id,
            &request_id,
            true,
            "",
            &shop_id,
            &item_id,
            quantity,
            source_slot,
            payout,
        );
        // The buy-back row was written in the same commit as the sale, so the
        // list the client now sees can never show a deal the shop would refuse.
        self.send_shop_rebuy_state(&id);
    }

    /// Authoritative shop buy-back (`ShopRebuy`): take one stack back off the
    /// character's own list of sold goods at exactly the price the shop paid
    /// for it.
    ///
    /// The list is the shop's memory of what it bought, so it is the
    /// authority: the request names an item and a price, and the row has to
    /// exist in the character's persisted list before anything moves.  A
    /// tampered request can therefore neither invent an item nor name a price
    /// the shop never paid.
    pub(super) fn handle_shop_rebuy(
        &mut self,
        id: String,
        request_id: String,
        shop_id: String,
        item_id: String,
        unit_price: u64,
    ) {
        let Some(player) = self.players.get(&id) else {
            return;
        };
        // A buy-back spends mesos, so a replayed request must not run twice.
        if let Some(prior) = self
            .shop_rebuy_requests
            .get(&(id.clone(), request_id.clone()))
        {
            let prior = prior.clone();
            self.send_shop_rebuy_outcome(&id, &request_id, &prior);
            return;
        }
        // Buying back is still done at a merchant: the shop must exist and the
        // player must be standing at it, exactly as for a purchase or a sale.
        let shop_known = self
            .gameplay
            .shops
            .iter()
            .any(|shop| shop.shop_id == shop_id);
        if !shop_known {
            self.send_shop_rebuy_result(
                &id,
                &request_id,
                false,
                "shop_unknown",
                &shop_id,
                &item_id,
                0,
                unit_price,
                0,
            );
            return;
        }
        let npc_in_range = self.npcs.values().any(|npc| {
            npc.map_id == player.map_id
                && npc.state.shop_id.as_deref() == Some(shop_id.as_str())
                && (player.state.x - npc.state.x).abs() <= npc::TALK_RANGE_X
                && (player.state.y - npc.state.y).abs() <= npc::TALK_RANGE_Y
        });
        if !npc_in_range {
            self.send_shop_rebuy_result(
                &id,
                &request_id,
                false,
                "shop_too_far",
                &shop_id,
                &item_id,
                0,
                unit_price,
                0,
            );
            return;
        }
        let Some(store) = self.store.clone() else {
            self.send_shop_rebuy_result(
                &id,
                &request_id,
                false,
                "persistence",
                &shop_id,
                &item_id,
                0,
                unit_price,
                0,
            );
            return;
        };
        // Resolve the row server-side: the quantity and the price are the ones
        // the shop recorded when it bought the stack, never the client's.
        let rows = match store.load_shop_rebuy(&id) {
            Ok(rows) => rows,
            Err(_) => {
                self.send_shop_rebuy_result(
                    &id,
                    &request_id,
                    false,
                    "persistence",
                    &shop_id,
                    &item_id,
                    0,
                    unit_price,
                    0,
                );
                return;
            }
        };
        let Some(row) = rows
            .iter()
            .find(|row| row.item_id == item_id && row.unit_price == unit_price)
            .cloned()
        else {
            self.send_shop_rebuy_result(
                &id,
                &request_id,
                false,
                "shop_rebuy_unknown",
                &shop_id,
                &item_id,
                0,
                unit_price,
                0,
            );
            return;
        };
        let cost = match row.unit_price.checked_mul(u64::from(row.quantity)) {
            Some(cost) => cost,
            None => {
                self.send_shop_rebuy_result(
                    &id,
                    &request_id,
                    false,
                    "shop_rebuy_unknown",
                    &shop_id,
                    &item_id,
                    row.quantity,
                    unit_price,
                    0,
                );
                return;
            }
        };
        if player.state.mesos < cost {
            self.send_shop_rebuy_result(
                &id,
                &request_id,
                false,
                "shop_not_enough_mesos",
                &shop_id,
                &item_id,
                row.quantity,
                unit_price,
                0,
            );
            return;
        }
        // Capacity is validated on a clone first, so a full tab refuses the
        // deal before the row is consumed.
        let mut next_inventory = player.state.inventory.clone();
        let kind = inventory::inventory_type(&item_id).unwrap_or(4);
        let slot_limit = player
            .state
            .inventory_slots
            .get(&kind)
            .copied()
            .unwrap_or(inventory::SLOT_LIMIT);
        if let Err(error) = inventory::add_items(
            &mut next_inventory,
            item_id.clone(),
            row.quantity,
            slot_limit,
        ) {
            self.send_shop_rebuy_result(
                &id,
                &request_id,
                false,
                match error {
                    inventory::InventoryError::InventoryFull => "shop_inventory_full",
                    inventory::InventoryError::UnknownItem => "shop_item_unknown",
                    _ => "shop_rejected",
                },
                &shop_id,
                &item_id,
                row.quantity,
                unit_price,
                0,
            );
            return;
        }
        let new_mesos = player.state.mesos - cost;
        // NB-04：消费赎回行 + 扣金币 + 授予行是**一个事务**。行不存在时
        // `Ok(false)` 按 `shop_rebuy_unknown` 拒绝；写库失败整笔回滚、行保
        // 留，内存不动。之前行在校验后被单独删掉，若后续写库失败，行已丢
        // 而物品没到手，且错误被 `let _ =` 静默吞掉。
        let mut profile = profile_from_state(
            &player.state,
            &player.map_id,
            &player.death_id,
            player.base_max_mp,
        );
        profile.mesos = new_mesos;
        match store.shop_rebuy_commit(&id, &profile, &next_inventory, &item_id, unit_price) {
            Ok(true) => {}
            Ok(false) => {
                self.send_shop_rebuy_result(
                    &id,
                    &request_id,
                    false,
                    "shop_rebuy_unknown",
                    &shop_id,
                    &item_id,
                    row.quantity,
                    unit_price,
                    0,
                );
                return;
            }
            Err(_) => {
                self.send_shop_rebuy_result(
                    &id,
                    &request_id,
                    false,
                    "persistence",
                    &shop_id,
                    &item_id,
                    row.quantity,
                    unit_price,
                    0,
                );
                return;
            }
        }
        let player = match self.players.get_mut(&id) {
            Some(player) => player,
            None => return,
        };
        player.state.inventory = next_inventory;
        player.state.mesos = new_mesos;
        self.send_shop_rebuy_result(
            &id,
            &request_id,
            true,
            "",
            &shop_id,
            &item_id,
            row.quantity,
            unit_price,
            cost,
        );
        self.send_shop_rebuy_state(&id);
    }

    /// Record one buy-back outcome and send it.  Every path goes through here
    /// so the idempotency window sees refusals as well: a request that was
    /// already refused stays refused, and a request that already paid is never
    /// charged twice.
    fn send_shop_rebuy_result(
        &mut self,
        id: &str,
        request_id: &str,
        success: bool,
        code: &str,
        shop_id: &str,
        item_id: &str,
        quantity: u32,
        unit_price: u64,
        mesos_spent: u64,
    ) {
        let mesos = self
            .players
            .get(id)
            .map(|player| player.state.mesos)
            .unwrap_or(0);
        let outcome = ShopRebuyOutcome {
            success,
            code: code.to_owned(),
            shop_id: shop_id.to_owned(),
            item_id: item_id.to_owned(),
            quantity,
            unit_price,
            mesos_spent,
            mesos,
        };
        self.shop_rebuy_requests
            .insert((id.to_owned(), request_id.to_owned()), outcome.clone());
        self.send_shop_rebuy_outcome(id, request_id, &outcome);
    }

    /// Emit the `shopRebought` wire message for an already-decided outcome.
    fn send_shop_rebuy_outcome(&self, id: &str, request_id: &str, outcome: &ShopRebuyOutcome) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let message = serde_json::json!({
            "type":"shopRebought",
            "requestId":request_id,
            "success":outcome.success,
            "code":outcome.code,
            "shopId":outcome.shop_id,
            "itemId":outcome.item_id,
            "quantity":outcome.quantity,
            "unitPrice":outcome.unit_price,
            "mesosSpent":outcome.mesos_spent,
            "mesos":player.state.mesos,
        })
        .to_string();
        let _ = player.output.try_send(message);
    }

    /// Push the character's buy-back list.  Sent when a merchant window opens
    /// and again after every sale or buy-back, so the tab can never show a row
    /// the shop would refuse.
    pub(super) fn send_shop_rebuy_state(&self, id: &str) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let Some(store) = self.store.as_ref() else {
            return;
        };
        let entries = store
            .load_shop_rebuy(id)
            .unwrap_or_default()
            .into_iter()
            .map(|row| {
                serde_json::json!({
                    "itemId": row.item_id,
                    "quantity": row.quantity,
                    "unitPrice": row.unit_price,
                })
            })
            .collect::<Vec<_>>();
        let message = serde_json::json!({"type":"shopRebuyState","entries":entries}).to_string();
        let _ = player.output.try_send(message);
    }

    /// Record one sell-back outcome and send it.  Every path goes through here
    /// so the idempotency window sees refusals as well: a request that was
    /// already refused stays refused, and a request that already paid is never
    /// charged twice.
    fn send_shop_sell_result(
        &mut self,
        id: &str,
        request_id: &str,
        success: bool,
        code: &str,
        shop_id: &str,
        item_id: &str,
        quantity: u32,
        slot: i16,
        mesos_gained: u64,
    ) {
        let mesos = self
            .players
            .get(id)
            .map(|player| player.state.mesos)
            .unwrap_or(0);
        let outcome = ShopSellOutcome {
            success,
            code: code.to_owned(),
            shop_id: shop_id.to_owned(),
            item_id: item_id.to_owned(),
            quantity,
            slot,
            mesos_gained,
            mesos,
        };
        self.shop_sell_requests
            .insert((id.to_owned(), request_id.to_owned()), outcome.clone());
        self.send_shop_sell_outcome(id, request_id, &outcome);
    }

    /// Emit the `shopSold` wire message for an already-decided outcome.
    fn send_shop_sell_outcome(&self, id: &str, request_id: &str, outcome: &ShopSellOutcome) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let message = serde_json::json!({
            "type":"shopSold",
            "requestId":request_id,
            "success":outcome.success,
            "code":outcome.code,
            "shopId":outcome.shop_id,
            "itemId":outcome.item_id,
            "quantity":outcome.quantity,
            "slot":outcome.slot,
            "mesosGained":outcome.mesos_gained,
            "mesos":player.state.mesos,
        })
        .to_string();
        let _ = player.output.try_send(message);
    }

    /// Close the character's warehouse window, if one is open.  Called from
    /// `end_conversation`, so leaving the npc, changing map or dying all end
    /// the session through one path.
    pub(super) fn close_storage(&mut self, player_id: &str) {
        if self.open_storage.remove(player_id).is_some() {
            self.send_storage_state(player_id, None);
        }
    }

    /// Open the account warehouse at a placed storage keeper.
    ///
    /// The client names the npc; whether it is a storage keeper, whether the
    /// player is standing close enough and what the warehouse holds are all
    /// decided here.  Storage is account-wide, so two characters of the same
    /// account see the same rows.
    pub(super) fn handle_storage_open(&mut self, id: String, request_id: String, npc_id: String) {
        let Some(player) = self.players.get(&id) else {
            return;
        };
        let Some(npc) = self.npcs.get(&npc_id) else {
            self.send_storage_result(&id, &request_id, false, "storage_unknown", "0", 0, 0, 0);
            return;
        };
        // The keeper must be authored as one in Npc.wz *and* the player must
        // be on its map within talking range: a client cannot open the
        // warehouse from across the world.
        let template_id = npc.template_id.clone();
        let is_keeper = self
            .gameplay
            .npcs
            .iter()
            .find(|template| template.template_id == template_id)
            .is_some_and(|template| template.func.contains(STORAGE_KEEPER_FUNC));
        if !is_keeper {
            self.send_storage_result(&id, &request_id, false, "storage_not_keeper", "0", 0, 0, 0);
            return;
        }
        let in_range = npc.map_id == player.map_id
            && (player.state.x - npc.state.x).abs() <= npc::TALK_RANGE_X
            && (player.state.y - npc.state.y).abs() <= npc::TALK_RANGE_Y;
        if !in_range {
            self.send_storage_result(&id, &request_id, false, "storage_too_far", "0", 0, 0, 0);
            return;
        }
        if player.state.hp <= 0 || player.state.action == "dead" {
            self.send_storage_result(&id, &request_id, false, "dead", "0", 0, 0, 0);
            return;
        }
        self.open_storage.insert(id.clone(), npc_id.clone());
        self.send_storage_result(&id, &request_id, true, "", &npc_id, 0, 0, 0);
        self.send_storage_state(&id, Some(&npc_id));
    }

    /// Move one stack between the inventory and the warehouse.
    ///
    /// The window must already be open at a keeper in range — that is the
    /// authority that the player actually walked to a warehouse, and it is
    /// re-checked on every transfer so a client cannot bank items from the
    /// field.
    pub(super) fn handle_storage_transfer(
        &mut self,
        id: String,
        request_id: String,
        operation: StorageTransferOperation,
        inventory_type: u8,
        slot: i16,
        quantity: u32,
    ) {
        if !self.players.contains_key(&id) {
            return;
        }
        let Some(npc_id) = self.open_storage.get(&id).cloned() else {
            self.send_storage_result(
                &id,
                &request_id,
                false,
                "storage_closed",
                "0",
                inventory_type,
                slot,
                quantity,
            );
            return;
        };
        if !self.storage_keeper_in_range(&id, &npc_id) {
            self.close_storage(&id);
            self.send_storage_result(
                &id,
                &request_id,
                false,
                "storage_too_far",
                &npc_id,
                inventory_type,
                slot,
                quantity,
            );
            return;
        }
        let (operation, kind) = match operation {
            StorageTransferOperation::Deposit => (auth::StorageOperation::Deposit, inventory_type),
            StorageTransferOperation::Withdraw => {
                (auth::StorageOperation::Withdraw, inventory_type)
            }
        };
        let Some(store) = self.store.clone() else {
            self.send_storage_result(
                &id,
                &request_id,
                false,
                "persistence",
                &npc_id,
                inventory_type,
                slot,
                quantity,
            );
            return;
        };
        match store.storage_transfer(&id, &request_id, operation, kind, slot, quantity) {
            Ok(outcome) => {
                self.send_storage_transfer_result(&id, &request_id, &npc_id, &outcome);
                // Refresh the authoritative view from *inside the world* is
                // not needed for the warehouse (the DB just wrote it), but the
                // inventory side changed, so reload it to keep the snapshot
                // and the window consistent.
                self.reload_storage_side_effects(&id, &store);
                self.send_storage_state(&id, Some(&npc_id));
                if outcome.success {
                    self.send_quest_list(&id);
                }
            }
            Err(error) => {
                if let Some(player) = self.players.get(&id) {
                    let _ =
                        player
                            .output
                            .try_send(reject("persistence", &error, Some(&request_id)));
                }
            }
        }
    }

    /// Move mesos between the character purse and the warehouse.
    pub(super) fn handle_storage_mesos(
        &mut self,
        id: String,
        request_id: String,
        operation: StorageTransferOperation,
        quantity: u32,
    ) {
        let Some(npc_id) = self.open_storage.get(&id).cloned() else {
            self.send_storage_result(
                &id,
                &request_id,
                false,
                "storage_closed",
                "0",
                0,
                0,
                quantity,
            );
            return;
        };
        if !self.storage_keeper_in_range(&id, &npc_id) {
            self.close_storage(&id);
            self.send_storage_result(
                &id,
                &request_id,
                false,
                "storage_too_far",
                &npc_id,
                0,
                0,
                quantity,
            );
            return;
        }
        let operation = match operation {
            StorageTransferOperation::Deposit => auth::StorageOperation::Deposit,
            StorageTransferOperation::Withdraw => auth::StorageOperation::Withdraw,
        };
        let Some(store) = self.store.clone() else {
            self.send_storage_result(
                &id,
                &request_id,
                false,
                "persistence",
                &npc_id,
                0,
                0,
                quantity,
            );
            return;
        };
        match store.storage_mesos(&id, &request_id, operation, quantity) {
            Ok(outcome) => {
                // The purse lives in the profile, so mirror the new balance
                // into the in-memory state before the next snapshot.
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.mesos = outcome.mesos;
                }
                let message = serde_json::json!({
                    "type":"storageMesos",
                    "requestId":request_id,
                    "success":outcome.success,
                    "code":outcome.code,
                    "operation":outcome.operation.as_str(),
                    "quantity":outcome.quantity,
                    "mesos":outcome.mesos,
                    "storedMesos":outcome.stored_mesos,
                })
                .to_string();
                if let Some(player) = self.players.get(&id) {
                    let _ = player.output.try_send(message);
                }
                self.send_storage_state(&id, Some(&npc_id));
            }
            Err(error) => {
                if let Some(player) = self.players.get(&id) {
                    let _ =
                        player
                            .output
                            .try_send(reject("persistence", &error, Some(&request_id)));
                }
            }
        }
    }

    /// Re-verify that the open keeper is still on the player's map and close.
    fn storage_keeper_in_range(&self, id: &str, npc_id: &str) -> bool {
        let Some(player) = self.players.get(id) else {
            return false;
        };
        self.npcs.get(npc_id).is_some_and(|npc| {
            npc.map_id == player.map_id
                && (player.state.x - npc.state.x).abs() <= npc::TALK_RANGE_X
                && (player.state.y - npc.state.y).abs() <= npc::TALK_RANGE_Y
        })
    }

    /// Reload the character-owned rows a storage transfer can change.  Only
    /// the inventory moves here; the warehouse itself was just written.
    fn reload_storage_side_effects(&mut self, id: &str, store: &auth::Store) {
        let defaults = self.default_profile();
        let Ok(profile) = store.load_profile(id, &defaults) else {
            return;
        };
        if let Some(player) = self.players.get_mut(id) {
            player.state.inventory = profile.inventory;
        }
    }

    /// Record and send one transfer outcome.  Refusals are routed through the
    /// same path as successes so the client always gets a single, authoritative
    /// answer to the request it sent.
    fn send_storage_transfer_result(
        &mut self,
        id: &str,
        request_id: &str,
        npc_id: &str,
        outcome: &auth::StorageOutcome,
    ) {
        self.send_storage_result(
            id,
            request_id,
            outcome.success,
            &outcome.code,
            npc_id,
            outcome.inventory_type,
            outcome.slot,
            outcome.quantity,
        );
    }

    fn send_storage_result(
        &self,
        id: &str,
        request_id: &str,
        success: bool,
        code: &str,
        npc_id: &str,
        inventory_type: u8,
        slot: i16,
        quantity: u32,
    ) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let message = serde_json::json!({
            "type":"storageResult",
            "requestId":request_id,
            "success":success,
            "code":code,
            "npcId":npc_id,
            "inventoryType":inventory_type,
            "slot":slot,
            "quantity":quantity,
        })
        .to_string();
        let _ = player.output.try_send(message);
    }

    /// Push the owner a full warehouse view.  `npc_id` is `None` when the
    /// session just closed, which tells the client to dismiss the window.
    fn send_storage_state(&self, id: &str, npc_id: Option<&str>) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let Some(npc_id) = npc_id else {
            let _ = player
                .output
                .try_send(serde_json::json!({"type":"storageState","closed":true}).to_string());
            return;
        };
        let Some(store) = self.store.as_ref() else {
            return;
        };
        let state = StorageState {
            items: store.load_storage(id).unwrap_or_default(),
            mesos: store.storage_mesos_balance(id).unwrap_or(0),
            slot_limit: auth::STORAGE_SLOT_LIMIT,
            npc_id: npc_id.to_owned(),
        };
        let mut message = serde_json::to_value(&state).unwrap_or_default();
        if let Some(object) = message.as_object_mut() {
            object.insert("type".into(), serde_json::Value::from("storageState"));
        }
        let _ = player.output.try_send(message.to_string());
    }
}
