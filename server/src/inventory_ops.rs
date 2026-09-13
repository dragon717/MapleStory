//! 背包/物品操作职责：拾取、拖动、丢弃、整理、使用、丢金币，以及它们的回执。
//!
//! 从 `world.rs` 机械搬出的第二块完整职责（超大文件治理 P2）。搬的是**代码位置**，
//! 不是数据布局：`Player` / `World` 的字段仍在原处，协议、存档与 Tick 次序均未改变。
//!
//! ## 负责
//! - 一次物品意图的**完整事务外观**：容量校验、幂等（同 requestId 重放回原结果）、
//!   权威重算（客户端提交的槽位/数量只作意图，不作事实）、回执下发
//! - 物品出包的**世界副作用**：在地面生成掉落物并登记归属（`ensure_inventory_drop*`）
//! - 消耗品的效果分派：回复、卷轴、装备栏扩增、回城/传送卷轴（`handle_use_item`）
//!
//! ## 不负责
//! - 物品目录与堆叠/容量规则本身：那是 `crate::inventory`（模块名与 `inventory.rs` 区分）
//! - 持久化事务：`auth::Store` 里的 SQL 属于 `auth.rs`
//! - 快照生成、技能结算、地图传送的落地规则（`handle_revive` / `handle_portal` 等仍在 `world.rs`）
//!
//! ## 公开面
//! 新区块外被调用的入口是 `pub(super)`（`world.rs` 的命令分派与 `*_acceptance.rs` 会直接调用它们）；
//! 只在区块内部使用的辅助函数保持私有。`pub(super)` 定义在 `world` 的子模块里，可达范围
//! 与原来 `world` 内的私有 `fn` **完全一致**，因此没有放宽任何权限。
//!
//! ## 状态所有者
//! 仍是 `World`（`drops` / `drop_instances` / `drop_owners` / `drop_maps` 与
//! `inventory_requests` 幂等缓存）与 `Player`（`state.inventory` / `state.mesos`）。
//! 本模块只是这些状态的写入路径之一。
//!
//! ## 依赖方向
//! 只依赖祖先模块 `world`（`use super::*`）、`crate::auth`、`crate::inventory` 与 `serde_json`。
//! 拾取的世界侧可得性判定（地图/归属/距离/内存容量预检）自 R6 起委托给
//! 纯规则子模块 `super::pickup_rules`（窄输入 `PickupFacts` / 结果
//! `PickupVerdict`）；本模块保留幂等查询、Store 提交、世界回填与回执顺序。
//! 不直接执行 SQL，也不读文件。
//!
//! ## 测试入口
//! `inventory_acceptance.rs` / `consume_acceptance.rs` / `scroll_acceptance.rs` /
//! `slot_expand_acceptance.rs` / `shop_sell_acceptance.rs` / `storage_acceptance.rs` /
//! `continuation_acceptance.rs` 与 `world.rs` 内的测试，经 `include!` 进入 `world.rs` 的 `mod tests`。

use super::*;

impl World {
    pub(super) fn handle_pickup(&mut self, id: String, request_id: String, drop_id: String) {
        self.apply_pickup(id, request_id, drop_id, None);
    }

    /// Pet auto-pickup (pets.rs): every rule is unchanged, but the pet's
    /// position substitutes for the owner's in the range gate and the fly-to
    /// animation coordinates.  Rule rejections are silent — the pet simply
    /// keeps walking — while persistence failures still surface.
    pub(super) fn handle_pet_pickup(
        &mut self,
        id: String,
        request_id: String,
        drop_id: String,
        pet_x: f64,
        pet_y: f64,
    ) {
        self.apply_pickup(id, request_id, drop_id, Some((pet_x, pet_y)));
    }

    fn apply_pickup(
        &mut self,
        id: String,
        request_id: String,
        drop_id: String,
        pet_pos: Option<(f64, f64)>,
    ) {
        let silent = pet_pos.is_some();
        let Some(player) = self.players.get(&id) else {
            return;
        };
        let map_id = player.map_id.clone();
        let (pickup_x, pickup_y) = match pet_pos {
            Some((x, y)) => (x, y),
            None => (player.state.x, player.state.y),
        };
        if let Some(store) = self.store.as_ref() {
            match store.prior_pickup(&id, &request_id) {
                Ok(Some(prior)) => {
                    self.send_pickup_outcome(&id, &request_id, prior);
                    return;
                }
                Ok(None) => {}
                Err(error) => {
                    let _ =
                        player
                            .output
                            .try_send(reject("persistence", &error, Some(&request_id)));
                    return;
                }
            }
        }
        let Some(drop) = self.drops.get(&drop_id) else {
            if silent {
                return;
            }
            let _ = player.output.try_send(reject(
                "drop_unavailable",
                "Drop is unavailable",
                Some(&request_id),
            ));
            return;
        };
        // R6 收窄：世界侧可得性判定（地图/归属/距离/内存容量预检）整体
        // 委托给 pickup_rules 纯规则；拒绝码与文案由此处原样下发。
        let verdict = {
            let kind = inventory::inventory_type(&drop.item_id).unwrap_or(4);
            let facts = pickup_rules::PickupFacts {
                player_id: id.as_str(),
                player_x: pickup_x,
                player_y: pickup_y,
                now_ms: auth::now_ms(),
                map_id: map_id.as_str(),
                drop: pickup_rules::PickupDropView {
                    item_id: drop.item_id.as_str(),
                    quantity: drop.quantity,
                    x: drop.x,
                    y: drop.y,
                },
                drop_map: self.drop_maps.get(&drop_id).map(String::as_str),
                drop_owner: self.drop_owners.get(&drop_id),
                memory_capacity: if self.store.is_none() && drop.item_id != "0" {
                    Some(pickup_rules::CapacityProbe {
                        inventory: &player.state.inventory,
                        slot_limit: player
                            .state.inventory_slots
                            .get(&kind)
                            .copied()
                            .unwrap_or(inventory::SLOT_LIMIT),
                        stats: self.drop_instances.get(&drop_id).and_then(|v| v.stats.as_ref()),
                        remaining_slots: self
                            .drop_instances
                            .get(&drop_id)
                            .and_then(|v| v.remaining_slots),
                        upgrade_count: self
                            .drop_instances
                            .get(&drop_id)
                            .and_then(|v| v.upgrade_count),
                    })
                } else {
                    None
                },
            };
            pickup_rules::evaluate_pickup(&facts)
        };
        if let pickup_rules::PickupVerdict::Reject { code, message } = verdict {
            if silent {
                return;
            }
            let _ = player.output.try_send(reject(code, message, Some(&request_id)));
            return;
        }
        let outcome = match self.store.as_ref() {
            Some(store) => store.pickup(&id, &map_id, &request_id, &drop_id),
            None => Ok(auth::PickupOutcome {
                drop_id: drop_id.clone(),
                item_id: drop.item_id.clone(),
                quantity: drop.quantity,
                slot: None,
                success: true,
                code: String::new(),
            }),
        };
        match outcome {
            Ok(mut outcome) if outcome.success => {
                self.drops.remove(&drop_id);
                let drop_instance = self.drop_instances.remove(&drop_id);
                self.drop_owners.remove(&drop_id);
                self.drop_maps.remove(&drop_id);
                if let Some(store) = self.store.clone() {
                    // The SQLite transaction may have consumed a card into
                    // monster_book_cards or persisted equipment instance
                    // metadata that is not represented by DropState.  Reload
                    // every authoritative profile component after every
                    // successful pickup instead of replaying a lossy add in
                    // memory.
                    let defaults = self.default_profile();
                    let loaded_profile = store.load_profile(&id, &defaults);
                    let loaded_equipped = store.load_equipped(&id);
                    let loaded_monster_book = store.load_monster_book(&id);
                    match (loaded_profile, loaded_equipped, loaded_monster_book) {
                        (Ok(profile), Ok(equipped), Ok(monster_book)) => {
                            if let Some(player) = self.players.get_mut(&id) {
                                apply_profile_to_player(
                                    &self.gameplay,
                                    &self.mage_skills,
                                    player,
                                    profile,
                                );
                                player.state.equipped = equipped;
                                player.state.monster_book = monster_book;
                            }
                        }
                        (Err(error), _, _) | (_, Err(error), _) | (_, _, Err(error)) => {
                            if let Some(player) = self.players.get(&id) {
                                let _ = player.output.try_send(reject(
                                    "persistence",
                                    &error,
                                    Some(&request_id),
                                ));
                            }
                            return;
                        }
                    }
                } else if let Some(player) = self.players.get_mut(&id) {
                    if outcome.item_id == "0" {
                        player.state.mesos =
                            player.state.mesos.saturating_add(outcome.quantity as u64);
                    } else if inventory::consume_on_pickup(&outcome.item_id) {
                        pickup_rules::saturate_monster_book(
                            &mut player.state.monster_book,
                            &outcome.item_id,
                            outcome.quantity,
                        );
                    } else {
                        let kind = inventory::inventory_type(&outcome.item_id).unwrap_or(4);
                        let slot_limit = player
                            .state.inventory_slots
                            .get(&kind)
                            .copied()
                            .unwrap_or(inventory::SLOT_LIMIT);
                        outcome.slot = inventory::add_item_instance(
                            &mut player.state.inventory,
                            outcome.item_id.clone(),
                            outcome.quantity,
                            slot_limit,
                            drop_instance
                                .as_ref()
                                .and_then(|value| value.stats.as_ref()),
                            drop_instance
                                .as_ref()
                                .and_then(|value| value.remaining_slots),
                            drop_instance.as_ref().and_then(|value| value.upgrade_count),
                        )
                        .ok();
                    }
                }
                let event = serde_json::json!({
                    "type": "dropPickedUp",
                    "mapId": map_id.as_str(),
                    "dropId": outcome.drop_id.as_str(),
                    "playerId": id.as_str(),
                    "x": pickup_x,
                    "y": pickup_y,
                })
                .to_string();
                self.broadcast_to_map(&map_id, &event);
                self.send_pickup_outcome(&id, &request_id, outcome);
                self.send_quest_list(&id);
            }
            Ok(outcome) => {
                self.send_pickup_outcome(&id, &request_id, outcome);
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

    pub(super) fn handle_inventory_move(
        &mut self,
        id: String,
        request_id: String,
        inventory_type: u8,
        from_slot: i16,
        to_slot: i16,
        quantity: u32,
    ) {
        let Some(player) = self.players.get(&id) else {
            return;
        };
        if let Some(store) = self.store.clone() {
            match store.prior_inventory(&id, &request_id) {
                Ok(Some(prior)) => {
                    if ["move", "equip", "unequip"].contains(&prior.operation.as_str()) {
                        self.send_inventory_outcome(&id, &prior);
                    } else {
                        self.send_inventory_conflict(&id, &request_id);
                    }
                    return;
                }
                Ok(None) => {}
                Err(error) => {
                    let _ =
                        player
                            .output
                            .try_send(reject("persistence", &error, Some(&request_id)));
                    return;
                }
            }
            let equipment_stats = self.equipment_stats(&id);
            match store.move_inventory(
                &id,
                &request_id,
                inventory_type,
                from_slot,
                to_slot,
                quantity,
                equipment_stats,
            ) {
                Ok(outcome) => {
                    if outcome.success {
                        let kind = inventory_type;
                        let applied = self
                            .players
                            .get_mut(&id)
                            .map(|player| {
                                let slot_limit = player
                                    .state.inventory_slots
                                    .get(&kind)
                                    .copied()
                                    .unwrap_or(inventory::SLOT_LIMIT);
                                if kind == 1
                                    && inventory::valid_slot(from_slot)
                                    && inventory::valid_equipment_slot(to_slot)
                                {
                                    inventory::equip_items(
                                        &mut player.state.inventory,
                                        &mut player.state.equipped,
                                        equipment_stats,
                                        from_slot,
                                        to_slot,
                                        slot_limit,
                                    )
                                    .is_ok()
                                } else if kind == 1
                                    && inventory::valid_equipment_slot(from_slot)
                                    && inventory::valid_slot(to_slot)
                                {
                                    inventory::unequip_items(
                                        &mut player.state.inventory,
                                        &mut player.state.equipped,
                                        from_slot,
                                        to_slot,
                                        slot_limit,
                                    )
                                    .is_ok()
                                } else {
                                    inventory::move_items(
                                        &mut player.state.inventory,
                                        kind,
                                        from_slot,
                                        to_slot,
                                        quantity,
                                    )
                                    .is_ok()
                                }
                            })
                            .unwrap_or(false);
                        if !applied {
                            // The SQLite transaction is authoritative.  A
                            // mismatch means the in-memory profile was stale;
                            // reload it before the next snapshot so a client
                            // cannot observe or repeat a partial mutation.
                            let defaults = self.default_profile();
                            if let Ok(profile) = store.load_profile(&id, &defaults) {
                                if let Some(player) = self.players.get_mut(&id) {
                                    apply_profile_to_player(
                                        &self.gameplay,
                                        &self.mage_skills,
                                        player,
                                        profile,
                                    );
                                    if let Ok(equipped) = store.load_equipped(&id) {
                                        player.state.equipped = equipped;
                                    }
                                    if let Ok(monster_book) = store.load_monster_book(&id) {
                                        player.state.monster_book = monster_book;
                                    }
                                }
                            }
                        }
                    }
                    self.send_inventory_outcome(&id, &outcome);
                    if outcome.success {
                        self.send_quest_list(&id);
                    }
                }
                Err(error) => {
                    if let Some(player) = self.players.get(&id) {
                        let _ = player.output.try_send(reject(
                            "persistence",
                            &error,
                            Some(&request_id),
                        ));
                    }
                }
            }
            return;
        }

        if let Some(prior) = self
            .inventory_requests
            .get(&(id.clone(), request_id.clone()))
            .cloned()
        {
            if ["move", "equip", "unequip"].contains(&prior.operation.as_str()) {
                self.send_inventory_outcome(&id, &prior);
            } else {
                self.send_inventory_conflict(&id, &request_id);
            }
            return;
        }
        let mut next_inventory = player.state.inventory.clone();
        let mut next_equipped = player.state.equipped.clone();
        let slot_limit = player
            .state.inventory_slots
            .get(&inventory_type)
            .copied()
            .unwrap_or(inventory::SLOT_LIMIT);
        let item_id = next_inventory
            .iter()
            .find(|item| {
                item.slot == u16::try_from(from_slot).unwrap_or(0)
                    && inventory::inventory_type(&item.item_id) == Some(inventory_type)
            })
            .map(|item| item.item_id.clone())
            .or_else(|| {
                next_equipped
                    .iter()
                    .find(|item| {
                        inventory_type == 1
                            && inventory::valid_equipment_slot(from_slot)
                            && item.slot == from_slot.unsigned_abs()
                    })
                    .map(|item| item.item_id.clone())
            })
            .unwrap_or_default();
        let operation = if inventory_type == 1
            && inventory::valid_slot(from_slot)
            && inventory::valid_equipment_slot(to_slot)
        {
            "equip"
        } else if inventory_type == 1
            && inventory::valid_equipment_slot(from_slot)
            && inventory::valid_slot(to_slot)
        {
            "unequip"
        } else {
            "move"
        };
        let result = if operation == "equip" {
            let target = inventory::equipment_slot(&item_id).unwrap_or(to_slot);
            inventory::equip_items(
                &mut next_inventory,
                &mut next_equipped,
                self.equipment_stats(&id),
                from_slot,
                target,
                slot_limit,
            )
            .map(|_| ())
        } else if operation == "unequip" {
            inventory::unequip_items(&mut next_inventory, &mut next_equipped, from_slot, to_slot, slot_limit)
                .map(|_| ())
        } else {
            inventory::move_items(
                &mut next_inventory,
                inventory_type,
                from_slot,
                to_slot,
                quantity,
            )
        };
        let (success, code) = match result {
            Ok(()) => {
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.inventory = next_inventory;
                    player.state.equipped = next_equipped;
                }
                (true, String::new())
            }
            Err(error) => (false, error.code().to_owned()),
        };
        let outcome = auth::InventoryOutcome {
            request_id: request_id.clone(),
            operation: operation.to_owned(),
            inventory_type: Some(inventory_type),
            from_slot,
            to_slot: Some(to_slot),
            item_id,
            quantity,
            drop_id: None,
            success,
            code,
        };
        self.inventory_requests
            .insert((id.clone(), request_id), outcome.clone());
        self.send_inventory_outcome(&id, &outcome);
        if outcome.success {
            self.send_quest_list(&id);
        }
    }

    pub(super) fn handle_inventory_drop(
        &mut self,
        id: String,
        request_id: String,
        inventory_type: u8,
        from_slot: i16,
        quantity: u32,
    ) {
        let Some(player) = self.players.get(&id) else {
            return;
        };
        let map_id = player.map_id.clone();
        let drop_x = player.state.x;
        let drop_y = player.state.y;
        if auth::is_practice_map(&map_id) {
            self.send_reject(
                &id,
                "practice_inventory_locked",
                "练习中不能丢弃物品。",
                Some(&request_id),
            );
            return;
        }
        if let Some(store) = self.store.clone() {
            match store.prior_inventory(&id, &request_id) {
                Ok(Some(prior)) => {
                    if prior.operation == "drop" {
                        self.ensure_inventory_drop(&prior, &map_id);
                        self.send_inventory_outcome(&id, &prior);
                    } else {
                        self.send_inventory_conflict(&id, &request_id);
                    }
                    return;
                }
                Ok(None) => {}
                Err(error) => {
                    let _ =
                        player
                            .output
                            .try_send(reject("persistence", &error, Some(&request_id)));
                    return;
                }
            }
            match store.drop_inventory(
                &id,
                &map_id,
                &request_id,
                inventory_type,
                from_slot,
                quantity,
                drop_x,
                drop_y,
            ) {
                Ok(outcome) => {
                    if outcome.success {
                        let applied = self
                            .players
                            .get_mut(&id)
                            .map(|player| {
                                inventory::remove_items(
                                    &mut player.state.inventory,
                                    inventory_type,
                                    from_slot,
                                    quantity,
                                )
                                .is_ok()
                            })
                            .unwrap_or(false);
                        if !applied {
                            let defaults = self.default_profile();
                            if let Ok(profile) = store.load_profile(&id, &defaults) {
                                if let Some(player) = self.players.get_mut(&id) {
                                    apply_profile_to_player(
                                        &self.gameplay,
                                        &self.mage_skills,
                                        player,
                                        profile,
                                    );
                                    if let Ok(equipped) = store.load_equipped(&id) {
                                        player.state.equipped = equipped;
                                    }
                                    if let Ok(monster_book) = store.load_monster_book(&id) {
                                        player.state.monster_book = monster_book;
                                    }
                                }
                            }
                        }
                        self.ensure_inventory_drop_at(&outcome, drop_x, drop_y, &map_id);
                    }
                    self.send_inventory_outcome(&id, &outcome);
                    if outcome.success {
                        self.send_quest_list(&id);
                    }
                }
                Err(error) => {
                    if let Some(player) = self.players.get(&id) {
                        let _ = player.output.try_send(reject(
                            "persistence",
                            &error,
                            Some(&request_id),
                        ));
                    }
                }
            }
            return;
        }

        if let Some(prior) = self
            .inventory_requests
            .get(&(id.clone(), request_id.clone()))
            .cloned()
        {
            if prior.operation == "drop" {
                self.send_inventory_outcome(&id, &prior);
            } else {
                self.send_inventory_conflict(&id, &request_id);
            }
            return;
        }
        let mut next_inventory = player.state.inventory.clone();
        let item_id = next_inventory
            .iter()
            .find(|item| {
                item.slot == u16::try_from(from_slot).unwrap_or(0)
                    && inventory::inventory_type(&item.item_id) == Some(inventory_type)
            })
            .map(|item| item.item_id.clone())
            .unwrap_or_default();
        let instance = next_inventory
            .iter()
            .find(|item| {
                item.slot == u16::try_from(from_slot).unwrap_or(0)
                    && inventory::inventory_type(&item.item_id) == Some(inventory_type)
            })
            .map(DropInstance::from_item);
        let result =
            inventory::remove_items(&mut next_inventory, inventory_type, from_slot, quantity);
        let (success, code, drop_id) = match result {
            Ok((item_id, dropped_quantity)) => {
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.inventory = next_inventory;
                }
                if inventory::is_drop_restricted(&item_id) {
                    (true, String::new(), None)
                } else {
                    let drop_id = auth::random_id();
                    // P: user-authorized drop floating — pin to surface if the
                    // player dropped the item while swimming.
                    let drop_y = self.map.water_float_y(drop_x, drop_y);
                    self.drops.insert(
                        drop_id.clone(),
                        DropState {
                            id: drop_id.clone(),
                            item_id,
                            quantity: dropped_quantity,
                            x: drop_x,
                            y: drop_y,
                        },
                    );
                    self.drop_instances
                        .insert(drop_id.clone(), instance.unwrap_or_default());
                    self.drop_owners.insert(drop_id.clone(), (None, 0));
                    self.drop_maps.insert(drop_id.clone(), map_id.clone());
                    (true, String::new(), Some(drop_id))
                }
            }
            Err(error) => (false, error.code().to_owned(), None),
        };
        let outcome = auth::InventoryOutcome {
            request_id: request_id.clone(),
            operation: "drop".to_owned(),
            inventory_type: Some(inventory_type),
            from_slot,
            to_slot: None,
            item_id,
            quantity,
            drop_id,
            success,
            code,
        };
        self.inventory_requests
            .insert((id.clone(), request_id), outcome.clone());
        self.send_inventory_outcome(&id, &outcome);
        if outcome.success {
            self.send_quest_list(&id);
        }
    }

    pub(super) fn equipment_stats(&self, id: &str) -> inventory::EquipmentStats {
        let (level, job, ability) = self
            .players
            .get(id)
            .map(|player| {
                (
                    player.state.level,
                    player.state.job,
                    player.state.ability_stats.clone(),
                )
            })
            .unwrap_or((1, 0, AbilityStats::default()));
        inventory::EquipmentStats {
            level,
            job,
            strength: ability.strength.max(0),
            dexterity: ability.dexterity.max(0),
            intelligence: ability.intelligence.max(0),
            luck: ability.luck.max(0),
        }
    }

    pub(super) fn handle_inventory_gather(&mut self, id: String, request_id: String, inventory_type: u8) {
        self.handle_inventory_compact(id, request_id, inventory_type, false);
    }

    pub(super) fn handle_inventory_sort(&mut self, id: String, request_id: String, inventory_type: u8) {
        self.handle_inventory_compact(id, request_id, inventory_type, true);
    }

    fn handle_inventory_compact(
        &mut self,
        id: String,
        request_id: String,
        inventory_type: u8,
        sort: bool,
    ) {
        let Some(player) = self.players.get(&id) else {
            return;
        };
        let operation = if sort { "sort" } else { "gather" };
        if let Some(store) = self.store.clone() {
            match store.prior_inventory(&id, &request_id) {
                Ok(Some(prior)) => {
                    if prior.operation == operation {
                        self.send_inventory_outcome(&id, &prior);
                    } else {
                        self.send_inventory_conflict(&id, &request_id);
                    }
                    return;
                }
                Ok(None) => {}
                Err(error) => {
                    let _ =
                        player
                            .output
                            .try_send(reject("persistence", &error, Some(&request_id)));
                    return;
                }
            }
            let result = if sort {
                store.sort_inventory(&id, &request_id, inventory_type)
            } else {
                store.gather_inventory(&id, &request_id, inventory_type)
            };
            match result {
                Ok(outcome) => {
                    if outcome.success {
                        let applied = self
                            .players
                            .get_mut(&id)
                            .map(|player| {
                                if sort {
                                    inventory::sort_category(
                                        &mut player.state.inventory,
                                        inventory_type,
                                    );
                                    true
                                } else {
                                    inventory::gather_items(
                                        &mut player.state.inventory,
                                        inventory_type,
                                    )
                                    .is_ok()
                                }
                            })
                            .unwrap_or(false);
                        if !applied {
                            let defaults = self.default_profile();
                            if let Ok(profile) = store.load_profile(&id, &defaults) {
                                if let Some(player) = self.players.get_mut(&id) {
                                    apply_profile_to_player(
                                        &self.gameplay,
                                        &self.mage_skills,
                                        player,
                                        profile,
                                    );
                                }
                            }
                        }
                    }
                    self.send_inventory_outcome(&id, &outcome);
                }
                Err(error) => {
                    if let Some(player) = self.players.get(&id) {
                        let _ = player.output.try_send(reject(
                            "persistence",
                            &error,
                            Some(&request_id),
                        ));
                    }
                }
            }
            return;
        }
        if let Some(prior) = self
            .inventory_requests
            .get(&(id.clone(), request_id.clone()))
            .cloned()
        {
            if prior.operation == operation {
                self.send_inventory_outcome(&id, &prior);
            } else {
                self.send_inventory_conflict(&id, &request_id);
            }
            return;
        }
        let mut items = player.state.inventory.clone();
        let result = if sort {
            if inventory::valid_inventory_type(inventory_type) {
                inventory::sort_category(&mut items, inventory_type);
                Ok(())
            } else {
                Err(inventory::InventoryError::InvalidInventoryType)
            }
        } else {
            inventory::gather_items(&mut items, inventory_type)
        };
        let (success, code) = match result {
            Ok(()) => {
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.inventory = items;
                }
                (true, String::new())
            }
            Err(error) => (false, error.code().to_owned()),
        };
        let outcome = auth::InventoryOutcome {
            request_id: request_id.clone(),
            operation: operation.to_owned(),
            inventory_type: Some(inventory_type),
            from_slot: 0,
            to_slot: None,
            item_id: String::new(),
            quantity: 0,
            drop_id: None,
            success,
            code,
        };
        self.inventory_requests
            .insert((id.clone(), request_id), outcome.clone());
        self.send_inventory_outcome(&id, &outcome);
    }

    /// Resolve where a map-move consumable (`spec.moveTo`) would send this
    /// character, or refuse it.
    ///
    /// The item side is source data, but the *destination* is a world fact:
    /// 回家卷軸 asks for the current map's authored `returnMap`, a fixed scroll
    /// names its town outright.  Resolving here — before either persistence
    /// path — is what makes "a scroll with nowhere to go is never spent" true
    /// by construction, because the item is only ever paid for after this has
    /// returned a reachable map.  `Ok(None)` means the item is not a map-move
    /// consumable at all, i.e. the ordinary potion/scroll paths keep working.
    fn plan_map_move(&self, id: &str, item_id: &str) -> Result<Option<String>, &'static str> {
        let Some(target) = inventory::move_target(item_id) else {
            return Ok(None);
        };
        let Some(player) = self.players.get(id) else {
            return Err("item_unavailable");
        };
        if player.state.action == "dead" || player.state.hp <= 0 {
            return Err("dead");
        }
        // A Boss practice instance is not part of the map catalog, so the
        // character's `returnMap` would resolve against the wrong map — and
        // leaving a practice encounter is the practice window's own decision,
        // never a scroll's.  Mirrors the practice guards on the other
        // escape-like intents (dropping mesos, leaving the map).
        if auth::is_practice_map(&player.map_id) {
            return Err("scroll_blocked");
        }
        // A private Windbell island has a runtime-only map and a return
        // record that must be consumed by the activity's own leave path.
        // Refuse a scroll here rather than moving the profile behind the
        // instance and leaking its map/NPCs; the explicit Windbell `leave`
        // intent performs the canonical return and teardown transaction.
        if windbell::is_runtime_instance_map(&player.map_id) {
            return Err("scroll_blocked");
        }
        let current_map_id = player.map_id.as_str();
        let destination = match target {
            inventory::MapMoveTarget::ReturnMap => match self.return_maps.get(current_map_id) {
                Some(town_id) => town_id.clone(),
                None => return Err("scroll_no_target"),
            },
            inventory::MapMoveTarget::Map(town_id) => town_id,
        };
        if !self.maps.contains_key(&destination) {
            return Err("scroll_unavailable");
        }
        if destination == windbell::WIND_BELL_ISLAND_MAP_ID
            || destination == windbell::WIND_BELL_BRIDGE_MAP_ID
        {
            return Err("scroll_blocked");
        }
        Ok(Some(destination))
    }

    /// Land one character on a town the scroll named, after that scroll has
    /// actually been spent.
    ///
    /// A scroll names a *map*, never a gate, so the body arrives on that map's
    /// authored `sp` spawn point — the same landing a fresh join uses, re-grounded
    /// through the shared foothold lookup.  Every scene-scoped field the portal
    /// path clears is cleared here too; otherwise a scroll and a gate would
    /// leave different residue behind (a live summon or an ice field floating in
    /// a town the caster is no longer in).
    fn land_player_on_return_map(&mut self, id: &str, target_map_id: &str) {
        let Some(target_map) = self.maps.get(target_map_id).cloned() else {
            return;
        };
        self.end_conversation(id);
        let Some(player) = self.players.get_mut(id) else {
            return;
        };
        player.map_id = target_map_id.to_owned();
        player.natural_recovery_next_tick =
            self.tick.saturating_add(NATURAL_RECOVERY_INTERVAL_TICKS);
        reset_player_to_spawn(&target_map, player, self.tick);
        player.attack_until = 0;
        player.meditation_until = 0;
        player.meditation_mad = 0;
        clear_beginner_buffs(player);
        player.ice_teleport_enabled = false;
        player.ice_fields.clear();
        player.teleport_mastery_enabled = false;
        player.teleport_boost_enabled = false;
        player.adaptation_active = false;
        player.adaptation_charges = 0;
        player.summon = None;
        player.state.action_id = None;
        refresh_player_derived(&self.gameplay, &self.mage_skills, player);
        self.send_snapshot(id);
    }

    pub(super) fn handle_use_item(
        &mut self,
        id: String,
        request_id: String,
        inventory_type: u8,
        source_slot: i16,
        item_id: String,
        target_slot: Option<i16>,
        target_item_id: Option<String>,
    ) {
        let Some(player) = self.players.get(&id) else {
            return;
        };
        // Consumable cooldown gate.  Only items that author a `spec.time`
        // cooldown are ever in this map; an ordinary potion has no entry and
        // can be drunk as fast as the player can click, which is the
        // original's behaviour.  The check runs before any persistence so a
        // rejected use never spends an item.
        if let Some(ready_tick) = player.potion_cooldowns.get(&item_id).copied() {
            if self.tick < ready_tick {
                let remaining_ms = ready_tick.saturating_sub(self.tick) * TICK_MS;
                self.send_reject(
                    &id,
                    "potion_cooldown",
                    &format_potion_cooldown(remaining_ms, player.lang),
                    Some(&request_id),
                );
                return;
            }
        }
        // Companion activation has its own idempotent inventory transaction;
        // the cash item stays in the bag instead of entering consumption.
        if inventory_type == 5 && crate::inventory::is_pet(&item_id) {
            self.pet_toggle(&id, &request_id, inventory_type, source_slot, &item_id);
            return;
        }
        // Pet food targets the lead summoned pet; the consumption and the
        // pet's growth stats share one transaction (or one in-memory pass).
        if inventory_type == 2 && crate::inventory::is_pet_food(&item_id) {
            self.feed_pet(&id, &request_id, inventory_type, source_slot, &item_id);
            return;
        }
        if let Some(store) = self.store.clone() {
            let derived_max_mp = player.state.max_mp;
            match store.prior_inventory(&id, &request_id) {
                Ok(Some(prior)) => {
                    if ["use", "equip", "unequip"].contains(&prior.operation.as_str()) {
                        self.send_inventory_outcome(&id, &prior);
                    } else {
                        self.send_inventory_conflict(&id, &request_id);
                    }
                    return;
                }
                Ok(None) => {}
                Err(error) => {
                    let _ =
                        player
                            .output
                            .try_send(reject("persistence", &error, Some(&request_id)));
                    return;
                }
            }
            // Resolve a map-move destination only for a *fresh* request: the
            // idempotency peek above has already answered a replay with its
            // original result, so a retried scroll can never move the body a
            // second time.  An unusable scroll is refused here, before the
            // transaction, and therefore spends nothing.
            let move_destination = match self.plan_map_move(&id, &item_id) {
                Ok(destination) => destination,
                Err(code) => {
                    self.send_reject(
                        &id,
                        code,
                        map_move_reject_message(code, player.lang),
                        Some(&request_id),
                    );
                    return;
                }
            };
            let stats = self.equipment_stats(&id);
            let recovery = inventory::use_effect(&item_id).ok();
            match store.use_item_with_max_mp(
                &id,
                &request_id,
                inventory_type,
                source_slot,
                &item_id,
                target_slot,
                target_item_id.as_deref(),
                stats,
                Some(derived_max_mp),
            ) {
                Ok(outcome) => {
                    if outcome.success {
                        self.arm_potion_cooldown(&id, &item_id, recovery);
                        let defaults = self.default_profile();
                        if let Ok(profile) = store.load_profile(&id, &defaults) {
                            if let Some(player) = self.players.get_mut(&id) {
                                apply_profile_to_player(
                                    &self.gameplay,
                                    &self.mage_skills,
                                    player,
                                    profile,
                                );
                                if let Ok(equipped) = store.load_equipped(&id) {
                                    player.state.equipped = equipped;
                                    refresh_player_derived(
                                        &self.gameplay,
                                        &self.mage_skills,
                                        player,
                                    );
                                }
                                if let Ok(monster_book) = store.load_monster_book(&id) {
                                    player.state.monster_book = monster_book;
                                }
                                // Slot capacity is a single source of truth
                                // (`PlayerState.inventory_slots`, the wire
                                // copy every snapshot serializes).  Per-tab
                                // capacity lives outside Profile (a separate
                                // column), so a successful use must reload it
                                // explicitly: a slot-expand coupon grows the
                                // tab in the same transaction that spent it,
                                // and the resident character never rebuilds
                                // its state until the process restarts.
                                if let Ok(slots) = store.load_inventory_slots(&id) {
                                    player.state.inventory_slots = slots;
                                }
                            }
                        }
                    }
                    if outcome.success {
                        if let Some(destination) = move_destination.as_deref() {
                            // The scroll is persisted and the unit is already
                            // gone; only now does the body travel.  Nothing can
                            // fail here — the destination was proven to be an
                            // assembled map before the transaction ran.
                            self.land_player_on_return_map(&id, destination);
                        }
                    }
                    self.send_inventory_outcome(&id, &outcome);
                    if outcome.success && matches!(outcome.operation.as_str(), "equip" | "unequip")
                    {
                        self.send_quest_list(&id);
                        self.send_snapshot(&id);
                    } else if outcome.success && outcome.code == "slot_expand" {
                        // The grown capacity is in-memory now; push a snapshot
                        // so the client's per-tab slot counts update without a
                        // re-login.
                        self.send_snapshot(&id);
                    }
                }
                Err(error) => {
                    if let Some(player) = self.players.get(&id) {
                        let _ = player.output.try_send(reject(
                            "persistence",
                            &error,
                            Some(&request_id),
                        ));
                    }
                }
            }
            return;
        }
        if let Some(prior) = self
            .inventory_requests
            .get(&(id.clone(), request_id.clone()))
            .cloned()
        {
            if ["use", "equip", "unequip"].contains(&prior.operation.as_str()) {
                self.send_inventory_outcome(&id, &prior);
            } else {
                self.send_inventory_conflict(&id, &request_id);
            }
            return;
        }
        // Mirrors the store branch: only a fresh request resolves a destination,
        // so the idempotency peek above stays the single answer for a retry.
        let move_destination = match self.plan_map_move(&id, &item_id) {
            Ok(destination) => destination,
            Err(code) => {
                self.send_reject(
                    &id,
                    code,
                    map_move_reject_message(code, player.lang),
                    Some(&request_id),
                );
                return;
            }
        };
        let mut inventory_items = player.state.inventory.clone();
        let mut equipped_items = player.state.equipped.clone();
        let slot_limit = player
            .state.inventory_slots
            .get(&inventory_type)
            .copied()
            .unwrap_or(inventory::SLOT_LIMIT);
        let stats = self.equipment_stats(&id);
        let mut operation = "use".to_owned();
        let mut result_code = String::new();
        let result = if inventory_type == 1 && inventory::valid_slot(source_slot) {
            if target_slot.is_some() || target_item_id.is_some() {
                Err(inventory::InventoryError::InvalidEquipmentSlot)
            } else if let Some(expected) = inventory::equipment_slot(&item_id) {
                operation = "equip".to_owned();
                inventory::equip_items(
                    &mut inventory_items,
                    &mut equipped_items,
                    stats,
                    source_slot,
                    expected,
                    slot_limit,
                )
                .map(|_| ())
            } else {
                Err(inventory::InventoryError::UnknownItem)
            }
        } else if inventory_type == 1 && inventory::valid_equipment_slot(source_slot) {
            if target_slot.is_some() || target_item_id.is_some() {
                Err(inventory::InventoryError::InvalidEquipmentSlot)
            } else {
                let destination = (1..=slot_limit as i16).find(|slot| {
                    inventory_items.iter().all(|item| {
                        !(item.slot == u16::try_from(*slot).unwrap_or(0)
                            && inventory::inventory_type(&item.item_id) == Some(1))
                    })
                });
                match destination {
                    Some(destination) => {
                        operation = "unequip".to_owned();
                        inventory::unequip_items(
                            &mut inventory_items,
                            &mut equipped_items,
                            source_slot,
                            destination,
                            slot_limit,
                        )
                        .map(|_| ())
                    }
                    None => Err(inventory::InventoryError::InventoryFull),
                }
            }
        } else if inventory_type == 2 && inventory::valid_slot(source_slot) {
            let item_matches = inventory_items.iter().any(|item| {
                item.slot == u16::try_from(source_slot).unwrap_or(0)
                    && inventory::inventory_type(&item.item_id) == Some(2)
                    && item.item_id == item_id
            });
            if !item_matches {
                Err(inventory::InventoryError::SourceEmpty)
            } else if let Some(target_tab) = inventory::slot_expand_target(&item_id) {
                // In-memory slot expansion mirrors the store branch: grow the
                // tab by one step and consume the coupon, atomically.
                let capacity = player
                    .state.inventory_slots
                    .get(&target_tab)
                    .copied()
                    .unwrap_or(inventory::SLOT_LIMIT);
                let grown = capacity.saturating_add(inventory::SLOT_EXPAND_STEP);
                if grown > inventory::MAX_SLOT_LIMIT {
                    Err(inventory::InventoryError::SlotExpandMax)
                } else {
                    let mut slots = player.state.inventory_slots.clone();
                    slots.insert(target_tab, grown);
                    inventory::remove_items(&mut inventory_items, 2, source_slot, 1)
                        .map(|_| {
                            if let Some(player) = self.players.get_mut(&id) {
                                // Single wire copy: the snapshot picks the new
                                // capacity up without any extra syncing.
                                player.state.inventory_slots = slots;
                            }
                            result_code = "slot_expand".to_owned();
                        })
                }
            } else if let Ok(effect) = inventory::use_effect(&item_id) {
                // Percentage recovery (`hpR`/`mpR`) is resolved against this
                // body's own maxima, so the same potion scales with the
                // character instead of carrying a baked-in amount.
                if let Some(player) = self.players.get_mut(&id) {
                    let (hp, mp) = effect.resolve(player.state.max_hp, player.state.max_mp);
                    player.state.hp = (player.state.hp + hp).min(player.state.max_hp);
                    player.state.mp = (player.state.mp + mp).min(player.state.max_mp);
                }
                inventory::remove_items(&mut inventory_items, 2, source_slot, 1).map(|_| ())
            } else if inventory::scroll_effect(&item_id).is_some() {
                // Work on clones until both source consumption and target
                // validation succeed.  Failed target/category checks must
                // not consume the scroll, while a valid target consumes one
                // slot even when the random scroll roll fails.
                let mut next_inventory = inventory_items.clone();
                let mut next_equipped = equipped_items.clone();
                match inventory::remove_items(&mut next_inventory, 2, source_slot, 1).and_then(
                    |_| {
                        inventory::apply_scroll(
                            &mut next_equipped,
                            &item_id,
                            target_slot,
                            target_item_id.as_deref(),
                        )
                    },
                ) {
                    Ok(applied) => {
                        inventory_items = next_inventory;
                        equipped_items = next_equipped;
                        result_code = if applied {
                            "scroll_success".to_owned()
                        } else {
                            "scroll_failed".to_owned()
                        };
                        Ok(())
                    }
                    Err(error) => Err(error),
                }
            } else if inventory::move_target(&item_id).is_some() {
                // Mirrors the store branch: `plan_map_move` already proved the
                // destination is an assembled map, so this only has to spend a
                // unit.  The body itself travels after the state commit below,
                // which keeps "paid for" and "moved" in that order.
                inventory::remove_items(&mut inventory_items, 2, source_slot, 1)
                    .map(|_| result_code = "map_move".to_owned())
            } else {
                Err(inventory::InventoryError::ItemNotUsable)
            }
        } else {
            Err(inventory::InventoryError::InvalidInventoryType)
        };
        let (success, code) = match result {
            Ok(()) => {
                if operation == "use" {
                    self.arm_potion_cooldown(&id, &item_id, inventory::use_effect(&item_id).ok());
                }
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.inventory = inventory_items;
                    player.state.equipped = equipped_items;
                    refresh_player_derived(&self.gameplay, &self.mage_skills, player);
                }
                (true, result_code)
            }
            Err(error) => (false, error.code().to_owned()),
        };
        if success {
            if let Some(destination) = move_destination.as_deref() {
                // Persisted-then-travel, same order as the store branch: the
                // unit is already gone from the committed inventory, so the
                // landing can never leave an unpaid scroll behind.
                self.land_player_on_return_map(&id, destination);
            }
        }
        let outcome = auth::InventoryOutcome {
            request_id: request_id.clone(),
            operation,
            inventory_type: Some(inventory_type),
            from_slot: source_slot,
            to_slot: target_slot,
            item_id,
            quantity: 1,
            drop_id: None,
            success,
            code,
        };
        self.inventory_requests
            .insert((id.clone(), request_id), outcome.clone());
        self.send_inventory_outcome(&id, &outcome);
        if outcome.success && matches!(outcome.operation.as_str(), "equip" | "unequip") {
            self.send_quest_list(&id);
            self.send_snapshot(&id);
        }
    }

    pub(super) fn handle_drop_mesos(&mut self, id: String, request_id: String, quantity: u32) {
        let Some(player) = self.players.get(&id) else {
            return;
        };
        let map_id = player.map_id.clone();
        let x = player.state.x;
        let y = player.state.y;
        if auth::is_practice_map(&map_id) {
            self.send_reject(
                &id,
                "practice_inventory_locked",
                "练习中不能丢弃枫币。",
                Some(&request_id),
            );
            return;
        }
        if let Some(store) = self.store.clone() {
            match store.prior_inventory(&id, &request_id) {
                Ok(Some(prior)) => {
                    if prior.operation == "dropMesos" {
                        self.ensure_inventory_drop(&prior, &map_id);
                        self.send_inventory_outcome(&id, &prior);
                    } else {
                        self.send_inventory_conflict(&id, &request_id);
                    }
                    return;
                }
                Ok(None) => {}
                Err(error) => {
                    let _ =
                        player
                            .output
                            .try_send(reject("persistence", &error, Some(&request_id)));
                    return;
                }
            }
            match store.drop_mesos(&id, &map_id, &request_id, quantity, x, y) {
                Ok(outcome) => {
                    if outcome.success {
                        if let Some(player) = self.players.get_mut(&id) {
                            player.state.mesos = player.state.mesos.saturating_sub(quantity as u64);
                        }
                        self.ensure_inventory_drop_at(&outcome, x, y, &map_id);
                    }
                    self.send_inventory_outcome(&id, &outcome);
                }
                Err(error) => {
                    if let Some(player) = self.players.get(&id) {
                        let _ = player.output.try_send(reject(
                            "persistence",
                            &error,
                            Some(&request_id),
                        ));
                    }
                }
            }
            return;
        }
        if let Some(prior) = self
            .inventory_requests
            .get(&(id.clone(), request_id.clone()))
            .cloned()
        {
            if prior.operation == "dropMesos" {
                self.ensure_inventory_drop_at(&prior, x, y, &map_id);
                self.send_inventory_outcome(&id, &prior);
            } else {
                self.send_inventory_conflict(&id, &request_id);
            }
            return;
        }
        let (success, code, drop_id) = if !(10..=50_000).contains(&quantity) {
            (false, "invalid_quantity".to_owned(), None)
        } else if player.state.mesos < quantity as u64 {
            (false, "mesos_insufficient".to_owned(), None)
        } else {
            let drop_id = auth::random_id();
            if let Some(player) = self.players.get_mut(&id) {
                player.state.mesos -= quantity as u64;
            }
            self.drops.insert(
                drop_id.clone(),
                crate::protocol::DropState {
                    id: drop_id.clone(),
                    item_id: "0".to_owned(),
                    quantity,
                    x,
                    // P: user-authorized drop floating — mesos dropped while
                    // swimming pin to just below the surface.
                    y: self.map.water_float_y(x, y),
                },
            );
            self.drop_instances
                .insert(drop_id.clone(), DropInstance::default());
            self.drop_owners.insert(drop_id.clone(), (None, 0));
            self.drop_maps.insert(drop_id.clone(), map_id.clone());
            (true, String::new(), Some(drop_id))
        };
        let outcome = auth::InventoryOutcome {
            request_id: request_id.clone(),
            operation: "dropMesos".to_owned(),
            inventory_type: None,
            from_slot: 0,
            to_slot: None,
            item_id: "0".to_owned(),
            quantity,
            drop_id,
            success,
            code,
        };
        self.inventory_requests
            .insert((id.clone(), request_id), outcome.clone());
        self.send_inventory_outcome(&id, &outcome);
    }

    pub(super) fn send_inventory_conflict(&self, id: &str, request_id: &str) {
        if let Some(player) = self.players.get(id) {
            let _ = player.output.try_send(reject(
                "request_reused",
                "Request ID was used for another inventory operation",
                Some(request_id),
            ));
        }
    }

    pub(super) fn send_inventory_outcome(&self, id: &str, outcome: &auth::InventoryOutcome) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let message_type = if outcome.operation == "drop" {
            "inventoryDropResult"
        } else {
            "inventoryResult"
        };
        let mut message = serde_json::json!({
            "type": message_type,
            "requestId": outcome.request_id,
            "operation": outcome.operation,
            "success": outcome.success,
            "code": outcome.code,
            "sourceSlot": outcome.from_slot,
            "itemId": outcome.item_id,
            "quantity": outcome.quantity,
        });
        if let Some(inventory_type) = outcome.inventory_type {
            message["inventoryType"] = inventory_type.into();
        }
        if let Some(target_slot) = outcome.to_slot {
            message["targetSlot"] = target_slot.into();
        }
        if let Some(drop_id) = outcome.drop_id.as_deref() {
            message["dropId"] = drop_id.into();
        }
        let message = message.to_string();
        let _ = player.output.try_send(message);
    }

    fn ensure_inventory_drop(&mut self, outcome: &auth::InventoryOutcome, map_id: &str) {
        let Some(drop_id) = outcome.drop_id.as_deref() else {
            return;
        };
        if self.drops.contains_key(drop_id) {
            return;
        }
        let Some(store) = self.store.as_ref() else {
            return;
        };
        if let Ok(Some(drop)) = store.load_drop(map_id, drop_id) {
            // P: user-authorized drop floating.
            let (load_x, load_y) = (drop.x, self.map.water_float_y(drop.x, drop.y));
            self.drops.insert(
                drop_id.to_owned(),
                DropState {
                    id: drop.id.clone(),
                    item_id: drop.item_id.clone(),
                    quantity: drop.quantity,
                    x: load_x,
                    y: load_y,
                },
            );
            self.drop_instances
                .insert(drop_id.to_owned(), DropInstance::from_record(&drop));
            self.drop_owners
                .insert(drop_id.to_owned(), (drop.owner_id, drop.protected_until_ms));
            self.drop_maps.insert(drop_id.to_owned(), map_id.to_owned());
        }
    }

    fn ensure_inventory_drop_at(
        &mut self,
        outcome: &auth::InventoryOutcome,
        x: f64,
        y: f64,
        map_id: &str,
    ) {
        let Some(drop_id) = outcome.drop_id.as_deref() else {
            return;
        };
        // P: user-authorized drop floating — pin to surface if dropped in water.
        let float_y = self.map.water_float_y(x, y);
        self.drops.insert(
            drop_id.to_owned(),
            DropState {
                id: drop_id.to_owned(),
                item_id: outcome.item_id.clone(),
                quantity: outcome.quantity,
                x,
                y: float_y,
            },
        );
        let instance = self
            .store
            .clone()
            .and_then(|store| store.load_drop(map_id, drop_id).ok().flatten())
            .map(|drop| DropInstance::from_record(&drop))
            .unwrap_or_default();
        self.drop_instances.insert(drop_id.to_owned(), instance);
        self.drop_owners.insert(drop_id.to_owned(), (None, 0));
        self.drop_maps.insert(drop_id.to_owned(), map_id.to_owned());
    }

}
