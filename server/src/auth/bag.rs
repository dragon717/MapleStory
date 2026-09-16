//! 背包与物品持久化：装备/图鉴读取、移动/整理/压缩、用药（含 MP 上限变体）、
//! 丢金币/丢道具、单件掉落读取，以及拾取前的幂等查询。
//!
//! 从 `auth.rs` 机械搬出的第五块完整职责（超大文件治理）。搬的是**代码位置**，
//! 不是数据布局：inventory / monster_book 表结构与原子性语义均未改变。

use super::notebook::{granted_tx, AcquisitionSource, ItemAcquisition};
use super::*;

impl Store {
    pub fn prior_inventory(
        &self,
        account_id: &str,
        request_id: &str,
    ) -> Result<Option<InventoryOutcome>, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        db.query_row(
            "SELECT request_id,operation,inventory_type,from_slot,to_slot,item_id,quantity,drop_id,success,code
             FROM inventory_actions WHERE account_id=?1 AND request_id=?2",
            params![account_id, request_id],
            inventory_outcome_from_row,
        )
        .optional()
        .map_err(|_| "account persistence failed".into())
    }

    /// Toggle one cash-pet row inside the same transaction that records the
    /// request. Pet identity and active state live in the row's private stats
    /// map, so moving or compacting the inventory carries both with the row.
    pub fn toggle_pet(
        &self,
        account_id: &str,
        request_id: &str,
        source_slot: i16,
        item_id: &str,
    ) -> Result<InventoryOutcome, String> {
        let mut db = self
            .db
            .lock()
            .map_err(|_| "account store unavailable".to_owned())?;
        let tx = db
            .transaction()
            .map_err(|_| "account persistence failed".to_owned())?;
        normalize_inventory_tx(&tx)?;
        if let Some(prior) = read_inventory_action(&tx, account_id, request_id)? {
            tx.commit()
                .map_err(|_| "account persistence failed".to_owned())?;
            return Ok(prior);
        }
        let mut inventory = read_inventory_tx(&tx, account_id)?;
        let now_seconds = now_ms() / 1000;
        let (success, code) =
            match inventory::toggle_pet(&mut inventory, source_slot, item_id, now_seconds) {
                Ok(()) => {
                    write_inventory_tx(&tx, account_id, &inventory)?;
                    (true, "pet_toggled".to_owned())
                }
                Err(code) => (false, code),
            };
        let outcome = InventoryOutcome {
            request_id: request_id.to_owned(),
            // Keep this in the existing use-item result family. The world
            // handler already knows how to render and replay that operation.
            operation: "use".to_owned(),
            inventory_type: Some(5),
            from_slot: source_slot,
            to_slot: None,
            item_id: item_id.to_owned(),
            quantity: if success { 1 } else { 0 },
            drop_id: None,
            success,
            code,
        };
        insert_inventory_action(&tx, account_id, &outcome)?;
        tx.commit()
            .map_err(|_| "account persistence failed".to_owned())?;
        Ok(outcome)
    }

    /// Feed one pet food (`2120000` 寵物食品) to the lead summoned pet inside
    /// a single transaction: the consumed food and the pet's growth stats are
    /// written atomically with the idempotency record.  Rules: the source
    /// `incRepleteness`/`incTameness` values restore fullness (+30) and
    /// closeness (+1) while the pet is hungry; feeding a full pet is the
    /// classic overfeed (P: closeness -1, fullness unchanged, food still
    /// spent).  A replay returns its original outcome.
    pub fn feed_pet(
        &self,
        account_id: &str,
        request_id: &str,
        food_slot: i16,
        food_item_id: &str,
    ) -> Result<InventoryOutcome, String> {
        let mut db = self
            .db
            .lock()
            .map_err(|_| "account store unavailable".to_owned())?;
        let tx = db
            .transaction()
            .map_err(|_| "account persistence failed".to_owned())?;
        normalize_inventory_tx(&tx)?;
        if let Some(prior) = read_inventory_action(&tx, account_id, request_id)? {
            tx.commit()
                .map_err(|_| "account persistence failed".to_owned())?;
            return Ok(prior);
        }
        let mut inventory = read_inventory_tx(&tx, account_id)?;
        let now_seconds = now_ms() / 1000;
        let food_index = inventory.iter().position(|item| {
            item.slot == u16::try_from(food_slot).unwrap_or(0)
                && item.item_id == food_item_id
                && inventory::is_pet_food(&item.item_id)
                && inventory::inventory_type(&item.item_id) == Some(2)
        });
        let lead_pet_slot = inventory
            .iter()
            .filter(|item| inventory::pet_active(item))
            .map(|item| item.slot)
            .min();
        let (success, code) = match (food_index, lead_pet_slot) {
            (Some(food_index), Some(_)) => {
                // Lead pet = the lowest active cash slot, i.e. the first one
                // the player summoned into the follow order.  The slot match
                // must stay within the pet family: the use tab can occupy the
                // same local slot number as the cash tab.
                let pet_index = inventory
                    .iter()
                    .position(|item| {
                        item.slot == lead_pet_slot.unwrap() && inventory::pet_active(item)
                    })
                    .unwrap_or_default();
                let fullness = inventory::pet_fullness(&inventory[pet_index], now_seconds);
                let (delta_fullness, delta_closeness) = if fullness >= inventory::PET_FULLNESS_MAX {
                    // Overfeed: the pet refuses the extra food and loses a
                    // point of closeness instead.
                    (0, -1)
                } else {
                    (
                        inventory::pet_food_fullness(&food_item_id),
                        inventory::pet_food_closeness(&food_item_id),
                    )
                };
                inventory::set_pet_fullness(
                    &mut inventory[pet_index],
                    (fullness + delta_fullness).min(inventory::PET_FULLNESS_MAX),
                    now_seconds,
                );
                inventory::add_pet_closeness(&mut inventory[pet_index], delta_closeness);
                // Spend exactly one food; a depleted stack leaves the bag.
                let row = &mut inventory[food_index];
                row.quantity = row.quantity.saturating_sub(1);
                if row.quantity == 0 {
                    inventory.remove(food_index);
                }
                (true, "pet_fed".to_owned())
            }
            (Some(_), None) => (false, "pet_not_summoned".to_owned()),
            (None, _) => (false, "source_empty".to_owned()),
        };
        if success {
            write_inventory_tx(&tx, account_id, &inventory)?;
        }
        let outcome = InventoryOutcome {
            request_id: request_id.to_owned(),
            operation: "use".to_owned(),
            inventory_type: Some(2),
            from_slot: food_slot,
            to_slot: None,
            item_id: food_item_id.to_owned(),
            quantity: if success { 1 } else { 0 },
            drop_id: None,
            success,
            code,
        };
        insert_inventory_action(&tx, account_id, &outcome)?;
        tx.commit()
            .map_err(|_| "account persistence failed".to_owned())?;
        Ok(outcome)
    }

    /// Natural retirement of one summoned pet inside one transaction:
    /// hunger reaching zero returns the pet to the bag with a closeness
    /// penalty, and a lapsed lifespan reverts it to a dead doll that can no
    /// longer be summoned.  `World`'s growth sweep calls this once per pet
    /// with a deterministic request id, so replays stay harmless.
    pub fn retire_pet(
        &self,
        account_id: &str,
        request_id: &str,
        source_slot: i16,
        item_id: &str,
        dead: bool,
    ) -> Result<InventoryOutcome, String> {
        let mut db = self
            .db
            .lock()
            .map_err(|_| "account store unavailable".to_owned())?;
        let tx = db
            .transaction()
            .map_err(|_| "account persistence failed".to_owned())?;
        normalize_inventory_tx(&tx)?;
        if let Some(prior) = read_inventory_action(&tx, account_id, request_id)? {
            tx.commit()
                .map_err(|_| "account persistence failed".to_owned())?;
            return Ok(prior);
        }
        let mut inventory = read_inventory_tx(&tx, account_id)?;
        let now_seconds = now_ms() / 1000;
        let index = inventory.iter().position(|item| {
            item.slot == u16::try_from(source_slot).unwrap_or(0)
                && item.item_id == item_id
                && inventory::pet_active(item)
        });
        let (success, code) = match index {
            Some(index) => {
                let fullness = inventory::pet_fullness(&inventory[index], now_seconds);
                // Hunger retirement happens at exactly zero; rebasing there
                // keeps the checkpoint consistent for the next summon.
                inventory::set_pet_fullness(&mut inventory[index], fullness, now_seconds);
                if dead {
                    inventory::set_pet_stat(&mut inventory[index], inventory::PET_DEAD_KEY, 1);
                } else {
                    // Neglect penalty: the starving pet parts with one
                    // closeness point when it returns to the bag.
                    inventory::add_pet_closeness(&mut inventory[index], -1);
                }
                let stats = inventory[index].stats.get_or_insert_with(BTreeMap::new);
                stats.insert(inventory::PET_ACTIVE_KEY.to_owned(), 0);
                write_inventory_tx(&tx, account_id, &inventory)?;
                (
                    true,
                    if dead { "pet_expired" } else { "pet_starved" }.to_owned(),
                )
            }
            None => (false, "source_empty".to_owned()),
        };
        let outcome = InventoryOutcome {
            request_id: request_id.to_owned(),
            operation: "use".to_owned(),
            inventory_type: Some(5),
            from_slot: source_slot,
            to_slot: None,
            item_id: item_id.to_owned(),
            quantity: 0,
            drop_id: None,
            success,
            code,
        };
        insert_inventory_action(&tx, account_id, &outcome)?;
        tx.commit()
            .map_err(|_| "account persistence failed".to_owned())?;
        Ok(outcome)
    }

    /// Atomically grant an item for a server command such as `/add`. This is
    /// deliberately separate from `write_inventory`: it resolves capacity,
    /// assigns pet instance metadata, and records request-id idempotency in
    /// one transaction before the world updates its in-memory snapshot.
    pub fn grant_inventory_item(
        &self,
        account_id: &str,
        request_id: &str,
        item_id: &str,
        quantity: u32,
    ) -> Result<InventoryOutcome, String> {
        let mut db = self
            .db
            .lock()
            .map_err(|_| "account store unavailable".to_owned())?;
        let tx = db
            .transaction()
            .map_err(|_| "account persistence failed".to_owned())?;
        normalize_inventory_tx(&tx)?;
        if let Some(prior) = read_inventory_action(&tx, account_id, request_id)? {
            tx.commit()
                .map_err(|_| "account persistence failed".to_owned())?;
            if prior.operation == "gmAdd" && prior.item_id == item_id && prior.quantity == quantity
            {
                return Ok(prior);
            }
            // A request id is single-use even when the caller changes the
            // item or quantity. Return a normal failed outcome so the GM
            // layer cannot mistake a replay with new arguments for a grant.
            return Ok(InventoryOutcome {
                request_id: request_id.to_owned(),
                operation: "gmAdd".to_owned(),
                inventory_type: inventory::inventory_type(item_id),
                from_slot: 0,
                to_slot: None,
                item_id: item_id.to_owned(),
                quantity: 0,
                drop_id: None,
                success: false,
                code: "request_reused".to_owned(),
            });
        }
        let kind = inventory::inventory_type(item_id);
        let mut slot = 0_i16;
        let (success, code) = if quantity == 0 {
            (false, "invalid_quantity".to_owned())
        } else if kind.is_none() {
            (false, "unknown_item".to_owned())
        } else {
            match add_inventory_tx(&tx, account_id, item_id, quantity, None, None, None)? {
                Ok(placed) => {
                    slot = i16::try_from(placed).unwrap_or(0);
                    // NB-05：GM 授予与背包落位同一事务。
                    granted_tx(
                        &tx,
                        account_id,
                        &[ItemAcquisition {
                            item_id,
                            quantity,
                            source: AcquisitionSource::Gm,
                            source_ref: Some(request_id),
                        }],
                        now_ms(),
                    )?;
                    (true, String::new())
                }
                Err(code) => (false, code.to_owned()),
            }
        };
        let outcome = InventoryOutcome {
            request_id: request_id.to_owned(),
            operation: "gmAdd".to_owned(),
            inventory_type: kind,
            from_slot: slot,
            to_slot: None,
            item_id: item_id.to_owned(),
            // GM request quantity is part of the idempotency fingerprint,
            // including a refused grant. Inventory was not changed on a
            // refusal, but replaying the exact request must return that same
            // refusal rather than become a new request.
            quantity,
            drop_id: None,
            success,
            code,
        };
        insert_inventory_action(&tx, account_id, &outcome)?;
        tx.commit()
            .map_err(|_| "account persistence failed".to_owned())?;
        Ok(outcome)
    }

    pub fn load_equipped(&self, account_id: &str) -> Result<Vec<InventoryItem>, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        read_equipped_db(&db, account_id)
    }

    pub fn load_monster_book(&self, account_id: &str) -> Result<BTreeMap<String, u8>, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        let mut stmt = db
            .prepare(
                "SELECT item_id,quantity FROM monster_book_cards
                 WHERE account_id=?1 AND quantity>0 ORDER BY item_id",
            )
            .map_err(|_| "account persistence failed")?;
        let collected = {
            let result = stmt.query_map([account_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?.try_into().unwrap_or(0),
                ))
            });
            result
                .map_err(|_| "account persistence failed")?
                .collect::<Result<BTreeMap<_, _>, _>>()
                .map_err(|_| "account persistence failed".to_owned())?
        };
        Ok(collected)
    }

    pub fn move_inventory(
        &self,
        account_id: &str,
        request_id: &str,
        inventory_type: u8,
        from_slot: i16,
        to_slot: i16,
        quantity: u32,
        stats: EquipmentStats,
    ) -> Result<InventoryOutcome, String> {
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        normalize_inventory_tx(&tx)?;
        normalize_equipped_tx(&tx)?;
        if let Some(prior) = read_inventory_action(&tx, account_id, request_id)? {
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(prior);
        }
        let mut inventory = read_inventory_tx(&tx, account_id)?;
        let mut equipped = read_equipped_tx(&tx, account_id)?;
        let inventory_slots = read_inventory_slots_tx(&tx, account_id)
            .map_err(|_| "account persistence failed".to_owned())?;
        let slot_limit = inventory_slots
            .get(&inventory_type)
            .copied()
            .unwrap_or(inventory::SLOT_LIMIT);
        let item_id = if inventory_type == 1 && inventory::valid_equipment_slot(from_slot) {
            equipped
                .iter()
                .find(|item| item.slot == from_slot.unsigned_abs())
                .map(|item| item.item_id.clone())
        } else {
            inventory
                .iter()
                .find(|item| {
                    item.slot == u16::try_from(from_slot).unwrap_or(0)
                        && inventory::inventory_type(&item.item_id) == Some(inventory_type)
                })
                .map(|item| item.item_id.clone())
        }
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
        let mutation = if operation == "equip" {
            inventory::equip_items(
                &mut inventory,
                &mut equipped,
                stats,
                from_slot,
                to_slot,
                slot_limit,
            )
        } else if operation == "unequip" {
            inventory::unequip_items(
                &mut inventory,
                &mut equipped,
                from_slot,
                to_slot,
                slot_limit,
            )
        } else {
            inventory::move_items(&mut inventory, inventory_type, from_slot, to_slot, quantity)
                .map(|()| (item_id.clone(), quantity))
        };
        let (success, code, result_quantity) = match mutation {
            Ok((_id, amount)) => {
                write_inventory_tx(&tx, account_id, &inventory)?;
                write_equipped_tx(&tx, account_id, &equipped)?;
                (true, String::new(), amount)
            }
            Err(error) => (false, error.code().to_owned(), quantity),
        };
        let outcome = InventoryOutcome {
            request_id: request_id.to_owned(),
            operation: operation.to_owned(),
            inventory_type: Some(inventory_type),
            from_slot,
            to_slot: Some(to_slot),
            item_id,
            quantity: result_quantity,
            drop_id: None,
            success,
            code,
        };
        insert_inventory_action(&tx, account_id, &outcome)?;
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(outcome)
    }

    pub fn gather_inventory(
        &self,
        account_id: &str,
        request_id: &str,
        inventory_type: u8,
    ) -> Result<InventoryOutcome, String> {
        self.compact_inventory(account_id, request_id, inventory_type, false)
    }

    pub fn sort_inventory(
        &self,
        account_id: &str,
        request_id: &str,
        inventory_type: u8,
    ) -> Result<InventoryOutcome, String> {
        self.compact_inventory(account_id, request_id, inventory_type, true)
    }

    fn compact_inventory(
        &self,
        account_id: &str,
        request_id: &str,
        inventory_type: u8,
        sort: bool,
    ) -> Result<InventoryOutcome, String> {
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        normalize_inventory_tx(&tx)?;
        normalize_equipped_tx(&tx)?;
        if let Some(prior) = read_inventory_action(&tx, account_id, request_id)? {
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(prior);
        }
        let mut inventory = read_inventory_tx(&tx, account_id)?;
        let mutation = if sort {
            if inventory::valid_inventory_type(inventory_type) {
                inventory::sort_category(&mut inventory, inventory_type);
                Ok(())
            } else {
                Err(inventory::InventoryError::InvalidInventoryType)
            }
        } else {
            inventory::gather_items(&mut inventory, inventory_type)
        };
        let (success, code) = match mutation {
            Ok(()) => {
                write_inventory_tx(&tx, account_id, &inventory)?;
                (true, String::new())
            }
            Err(error) => (false, error.code().to_owned()),
        };
        let outcome = InventoryOutcome {
            request_id: request_id.to_owned(),
            operation: if sort { "sort" } else { "gather" }.to_owned(),
            inventory_type: Some(inventory_type),
            from_slot: 0,
            to_slot: None,
            item_id: String::new(),
            quantity: 0,
            drop_id: None,
            success,
            code,
        };
        insert_inventory_action(&tx, account_id, &outcome)?;
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(outcome)
    }

    #[cfg(test)]
    pub fn use_item(
        &self,
        account_id: &str,
        request_id: &str,
        inventory_type: u8,
        source_slot: i16,
        item_id: &str,
        target_slot: Option<i16>,
        target_item_id: Option<&str>,
        stats: EquipmentStats,
    ) -> Result<InventoryOutcome, String> {
        self.use_item_with_max_mp(
            account_id,
            request_id,
            inventory_type,
            source_slot,
            item_id,
            target_slot,
            target_item_id,
            stats,
            None,
        )
    }

    /// Inventory use with the world's derived MP cap.  `player_stats.max_mp`
    /// stores the unmodified baseline, while a Mage's snapshot cap includes
    /// equipment and Magic Boost; the optional cap keeps potion application
    /// atomic without persisting the derived value as a new baseline.
    pub fn use_item_with_max_mp(
        &self,
        account_id: &str,
        request_id: &str,
        inventory_type: u8,
        source_slot: i16,
        item_id: &str,
        target_slot: Option<i16>,
        target_item_id: Option<&str>,
        stats: EquipmentStats,
        max_mp_override: Option<i64>,
    ) -> Result<InventoryOutcome, String> {
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        normalize_inventory_tx(&tx)?;
        normalize_equipped_tx(&tx)?;
        if let Some(prior) = read_inventory_action(&tx, account_id, request_id)? {
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(prior);
        }
        let mut inventory = read_inventory_tx(&tx, account_id)?;
        let mut equipped = read_equipped_tx(&tx, account_id)?;
        let inventory_slots = read_inventory_slots_tx(&tx, account_id)
            .map_err(|_| "account persistence failed".to_owned())?;
        let equip_slot_limit = inventory_slots
            .get(&1)
            .copied()
            .unwrap_or(inventory::SLOT_LIMIT);
        let result_item = item_id.to_owned();
        let result_quantity = 1;
        let mut operation = "use".to_owned();
        let mut result_code = None;
        let mutation: Result<(), inventory::InventoryError> = if inventory_type == 1 {
            if inventory::valid_slot(source_slot) {
                if target_slot.is_some() || target_item_id.is_some() {
                    Err(inventory::InventoryError::InvalidEquipmentSlot)
                } else if inventory
                    .iter()
                    .position(|item| {
                        item.slot == u16::try_from(source_slot).unwrap_or(0)
                            && inventory::inventory_type(&item.item_id) == Some(1)
                            && item.item_id == item_id
                    })
                    .is_none()
                {
                    Err(inventory::InventoryError::SourceEmpty)
                } else if let Some(expected) = inventory::equipment_slot(item_id) {
                    operation = "equip".to_owned();
                    inventory::equip_items(
                        &mut inventory,
                        &mut equipped,
                        stats,
                        source_slot,
                        expected,
                        equip_slot_limit,
                    )
                    .map(|_| ())
                } else {
                    Err(inventory::InventoryError::UnknownItem)
                }
            } else if inventory::valid_equipment_slot(source_slot) {
                if target_slot.is_some() || target_item_id.is_some() {
                    Err(inventory::InventoryError::InvalidEquipmentSlot)
                } else if equipped
                    .iter()
                    .all(|item| item.slot != source_slot.unsigned_abs() || item.item_id != item_id)
                {
                    Err(inventory::InventoryError::SourceEmpty)
                } else {
                    let destination = (1..=equip_slot_limit as i16).find(|slot| {
                        inventory.iter().all(|item| {
                            !(item.slot == u16::try_from(*slot).unwrap_or(0)
                                && inventory::inventory_type(&item.item_id) == Some(1))
                        })
                    });
                    match destination {
                        Some(destination) => {
                            operation = "unequip".to_owned();
                            inventory::unequip_items(
                                &mut inventory,
                                &mut equipped,
                                source_slot,
                                destination,
                                equip_slot_limit,
                            )
                            .map(|_| ())
                        }
                        None => Err(inventory::InventoryError::InventoryFull),
                    }
                }
            } else {
                Err(inventory::InventoryError::InvalidEquipmentSlot)
            }
        } else if inventory_type == 2 && inventory::valid_slot(source_slot) {
            let source_exists = inventory.iter().any(|item| {
                item.slot == u16::try_from(source_slot).unwrap_or(0)
                    && inventory::inventory_type(&item.item_id) == Some(2)
                    && item.item_id == item_id
            });
            if !source_exists {
                Err(inventory::InventoryError::SourceEmpty)
            } else if let Some(target_tab) = inventory::slot_expand_target(item_id) {
                // A slot-expansion coupon grows one tab by `SLOT_EXPAND_STEP`
                // slots and is consumed on use.  The capacity is a durable
                // per-tab value, updated in the same transaction that spends
                // the coupon, so a rejected (already-at-cap) use spends nothing
                // and a replayed request never expands twice.
                let capacity = inventory_slots
                    .get(&target_tab)
                    .copied()
                    .unwrap_or(inventory::SLOT_LIMIT);
                let grown = capacity.saturating_add(inventory::SLOT_EXPAND_STEP);
                if grown > inventory::MAX_SLOT_LIMIT {
                    Err(inventory::InventoryError::SlotExpandMax)
                } else {
                    let mut slots = inventory_slots.clone();
                    slots.insert(target_tab, grown);
                    write_inventory_slots_tx(&tx, account_id, &slots)
                        .and_then(|_| inventory::remove_items(&mut inventory, 2, source_slot, 1))
                        .map(|_| {
                            result_code = Some("slot_expand");
                        })
                }
            } else if let Ok(effect) = inventory::use_effect(item_id) {
                // A percentage (`hpR`/`mpR`) potion heals a share of the
                // body's own pool, so the concrete amount has to be resolved
                // against the row's authored maxima inside the same
                // transaction that spends the item.  `max_mp_override` carries
                // the Mage's derived cap (equipment + Magic Boost) so the
                // potion heals what the player actually sees, without that
                // derived value ever being persisted as a new baseline.
                let (max_hp, base_max_mp): (i64, i64) = tx
                    .query_row(
                        "SELECT max_hp,max_mp FROM player_stats WHERE account_id=?1",
                        params![account_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .map_err(|_| "account persistence failed".to_owned())?;
                let (hp, mp) = effect.resolve(max_hp, max_mp_override.unwrap_or(base_max_mp));
                inventory::remove_items(&mut inventory, 2, source_slot, 1).and_then(|_| {
                    let changed = tx
                        .execute(
                            "UPDATE player_stats SET hp=MIN(max_hp,hp+?2),mp=MIN(COALESCE(?4,max_mp),mp+?3)
                                 WHERE account_id=?1",
                            params![account_id, hp, mp, max_mp_override],
                        )
                        .map_err(|_| inventory::InventoryError::QuantityOverflow)?;
                    (changed == 1)
                        .then_some(())
                        .ok_or(inventory::InventoryError::QuantityOverflow)
                })
            } else if inventory::scroll_effect(item_id).is_some() {
                let mut next_inventory = inventory.clone();
                match inventory::remove_items(&mut next_inventory, 2, source_slot, 1).and_then(
                    |_| apply_scroll_tx(&tx, account_id, item_id, target_slot, target_item_id),
                ) {
                    Ok(applied) => {
                        inventory = next_inventory;
                        result_code = Some(if applied {
                            "scroll_success"
                        } else {
                            "scroll_failed"
                        });
                        Ok(())
                    }
                    Err(error) => Err(error),
                }
            } else if inventory::move_target(item_id).is_some() {
                // A map-move consumable spends exactly one unit here, and only
                // here: *where* the body lands is the world's decision, and the
                // world has already proven the destination is reachable before
                // it asks for the item to be spent.  A scroll with nowhere to
                // go is therefore refused by the caller and never reaches this
                // branch — the item can never be paid for nothing.
                inventory::remove_items(&mut inventory, 2, source_slot, 1).map(|_| {
                    result_code = Some("map_move");
                })
            } else {
                Err(inventory::InventoryError::ItemNotUsable)
            }
        } else {
            Err(inventory::InventoryError::InvalidInventoryType)
        };
        let (success, code) = match mutation {
            Ok(()) => {
                write_inventory_tx(&tx, account_id, &inventory)?;
                if inventory_type == 1 {
                    write_equipped_tx(&tx, account_id, &equipped)?;
                }
                (true, result_code.unwrap_or_default().to_owned())
            }
            Err(error) => (false, error.code().to_owned()),
        };
        let outcome = InventoryOutcome {
            request_id: request_id.to_owned(),
            operation,
            inventory_type: Some(inventory_type),
            from_slot: source_slot,
            to_slot: target_slot,
            item_id: result_item,
            quantity: result_quantity,
            drop_id: None,
            success,
            code,
        };
        insert_inventory_action(&tx, account_id, &outcome)?;
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(outcome)
    }

    pub fn drop_mesos(
        &self,
        account_id: &str,
        map_id: &str,
        request_id: &str,
        quantity: u32,
        x: f64,
        y: f64,
    ) -> Result<InventoryOutcome, String> {
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        if let Some(prior) = read_inventory_action(&tx, account_id, request_id)? {
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(prior);
        }
        let mut drop_id = None;
        let (success, code) = if !(10..=50_000).contains(&quantity) {
            (false, "invalid_quantity".to_owned())
        } else if !x.is_finite() || !y.is_finite() {
            (false, "invalid_position".to_owned())
        } else {
            let changed = tx
                .execute(
                    "UPDATE player_stats SET mesos=mesos-?2
                     WHERE account_id=?1 AND mesos>=?2",
                    params![account_id, i64::from(quantity)],
                )
                .map_err(|_| "account persistence failed")?;
            if changed != 1 {
                (false, "mesos_insufficient".to_owned())
            } else {
                let id = random_id();
                tx.execute(
                    "INSERT INTO drops(id,map_id,item_id,quantity,x,y,owner_account_id,protected_until_ms,active)
                     VALUES (?1,?2,'0',?3,?4,?5,NULL,0,1)",
                    params![id, map_id, i64::from(quantity), x, y],
                )
                .map_err(|_| "account persistence failed")?;
                drop_id = Some(id);
                (true, String::new())
            }
        };
        let outcome = InventoryOutcome {
            request_id: request_id.to_owned(),
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
        insert_inventory_action(&tx, account_id, &outcome)?;
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(outcome)
    }

    pub fn drop_inventory(
        &self,
        account_id: &str,
        map_id: &str,
        request_id: &str,
        inventory_type: u8,
        from_slot: i16,
        quantity: u32,
        x: f64,
        y: f64,
    ) -> Result<InventoryOutcome, String> {
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        normalize_inventory_tx(&tx)?;
        normalize_equipped_tx(&tx)?;
        if let Some(prior) = read_inventory_action(&tx, account_id, request_id)? {
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(prior);
        }
        let mut inventory = read_inventory_tx(&tx, account_id)?;
        let source = inventory
            .iter()
            .find(|item| {
                item.slot == u16::try_from(from_slot).unwrap_or(0)
                    && inventory::inventory_type(&item.item_id) == Some(inventory_type)
            })
            .cloned();
        let source_item = source
            .as_ref()
            .map(|item| item.item_id.clone())
            .unwrap_or_default();
        let stored_quantity = source.as_ref().map(|item| item.quantity).unwrap_or(0);
        let mutation = if !inventory::valid_inventory_type(inventory_type)
            || !inventory::valid_slot(from_slot)
        {
            Err(inventory::InventoryError::InvalidSlot)
        } else if !x.is_finite() || !y.is_finite() {
            Err(inventory::InventoryError::InvalidSlot)
        } else {
            inventory::remove_items(&mut inventory, inventory_type, from_slot, quantity).map(|_| ())
        };
        let mut drop_id = None;
        let (success, code) = match mutation {
            Ok(()) => {
                write_inventory_tx(&tx, account_id, &inventory)?;
                if !inventory::is_drop_restricted(&source_item) {
                    let id = random_id();
                    let stats_json = serde_json::to_string(
                        &source
                            .as_ref()
                            .and_then(|item| item.stats.clone())
                            .unwrap_or_default(),
                    )
                    .map_err(|_| "account persistence failed")?;
                    let upgrade_count = source
                        .as_ref()
                        .and_then(|item| item.upgrade_count)
                        .unwrap_or(0);
                    let remaining_slots = source
                        .as_ref()
                        .and_then(|item| item.remaining_slots)
                        .unwrap_or(0);
                    tx.execute(
                        "INSERT INTO drops(id,map_id,item_id,quantity,x,y,owner_account_id,protected_until_ms,
                         stats_json,upgrade_count,remaining_slots,active)
                         VALUES (?1,?2,?3,?4,?5,?6,NULL,0,?7,?8,?9,1)",
                        params![
                            id,
                            map_id,
                            source_item,
                            i64::from(quantity),
                            x,
                            y,
                            stats_json,
                            i64::from(upgrade_count),
                            i64::from(remaining_slots),
                        ],
                    )
                    .map_err(|_| "account persistence failed")?;
                    drop_id = Some(id);
                }
                (true, String::new())
            }
            Err(error) => (false, error.code().to_owned()),
        };
        let outcome = InventoryOutcome {
            request_id: request_id.to_owned(),
            operation: "drop".to_owned(),
            inventory_type: Some(inventory_type),
            from_slot,
            to_slot: None,
            item_id: source_item,
            quantity: if success { quantity } else { stored_quantity },
            drop_id,
            success,
            code,
        };
        insert_inventory_action(&tx, account_id, &outcome)?;
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(outcome)
    }

    pub fn load_drop(&self, map_id: &str, drop_id: &str) -> Result<Option<DropRecord>, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        db.query_row(
            "SELECT id,item_id,quantity,x,y,owner_account_id,protected_until_ms,stats_json,upgrade_count,remaining_slots FROM drops
             WHERE id=?1 AND map_id=?2 AND active=1",
            params![drop_id, map_id],
            |row| {
                Ok(DropRecord {
                    id: row.get(0)?,
                    item_id: row.get(1)?,
                    quantity: row.get::<_, i64>(2)?.try_into().unwrap_or(0),
                    x: row.get(3)?,
                    y: row.get(4)?,
                    owner_id: row.get(5)?,
                    protected_until_ms: row.get(6)?,
                    stats: row
                        .get::<_, String>(7)
                        .ok()
                        .and_then(|json| serde_json::from_str(&json).ok()),
                    upgrade_count: row
                        .get::<_, i64>(8)
                        .ok()
                        .and_then(|value| u32::try_from(value.max(0)).ok()),
                    remaining_slots: row
                        .get::<_, i64>(9)
                        .ok()
                        .and_then(|value| u32::try_from(value.max(0)).ok()),
                })
            },
        )
        .optional()
        .map_err(|_| "account persistence failed".into())
    }
}
