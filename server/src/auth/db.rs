//! `Store` 的 SQLite 读写辅助层（自由函数）。
//!
//! 负责：storage / inventory / profile 的行读写、事务内归一化与既有数据迁移
//! （`read_profile` / `write_profile` / `normalize_inventory_tx` / 堆叠取放等）。
//! 不负责：事务编排与业务判定（由 `auth.rs` 的 `impl Store` 方法与
//! `auth/bag.rs`、`auth/loot.rs`、`auth/quests.rs` 等调用方负责）；
//! 建表与 schema 建立在 `auth/schema.rs`。

use super::*;

pub(super) fn read_storage_db(db: &Connection, account_id: &str) -> Result<Vec<InventoryItem>, String> {
    let mut stmt = db
        .prepare(
            "SELECT slot,item_id,quantity,stats_json,upgrade_count,remaining_slots FROM storage
             WHERE account_id=?1 AND quantity>0 ORDER BY slot",
        )
        .map_err(|_| "account persistence failed")?;
    let collected = {
        let result = stmt.query_map([account_id], |row| {
            let mut item = InventoryItem {
                slot: row.get::<_, i64>(0)?.try_into().unwrap_or(0),
                item_id: row.get(1)?,
                quantity: row.get::<_, i64>(2)?.try_into().unwrap_or(0),
                stats: row
                    .get::<_, String>(3)
                    .ok()
                    .and_then(|json| serde_json::from_str(&json).ok()),
                upgrade_count: row
                    .get::<_, i64>(4)
                    .ok()
                    .and_then(|value| u32::try_from(value.max(0)).ok()),
                remaining_slots: row
                    .get::<_, i64>(5)
                    .ok()
                    .and_then(|value| u32::try_from(value.max(0)).ok()),
            };
            // A deposited weapon keeps the exact instance stats it was created
            // with, so round-tripping through the warehouse must not reset a
            // scroll's upgrades.
            inventory::ensure_equipment_instance(&mut item);
            inventory::ensure_pet_instance(&mut item);
            Ok(item)
        });
        result
            .map_err(|_| "account persistence failed")?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "account persistence failed".to_owned())?
    };
    Ok(collected)
}

/// One stack read out of either side of a transfer, with the instance fields
/// that must survive the trip unchanged.
pub(super) struct StorageStack {
    pub(super) item_id: String,
    pub(super) quantity: u32,
    pub(super) stats: Option<BTreeMap<String, i64>>,
    pub(super) upgrade_count: Option<u32>,
    pub(super) remaining_slots: Option<u32>,
}

/// Read one inventory stack and check it can supply `quantity`.  Nothing is
/// mutated, so a refusal later in the same transaction costs nothing.
///
/// The refusal channel is a typed `MoveRefusal`, not a player-visible code:
/// which words the player eventually sees is the *business action's* choice
/// (see `auth/item_world.rs`).
pub(super) fn peek_inventory_stack(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    inventory_type: u8,
    slot: i16,
    quantity: u32,
) -> Result<Result<StorageStack, item_world::MoveRefusal>, String> {
    if !inventory::valid_slot(slot) {
        return Ok(Err(item_world::MoveRefusal::InvalidSlot));
    }
    if quantity == 0 {
        return Ok(Err(item_world::MoveRefusal::InvalidQuantity));
    }
    let row: Option<(String, i64, String, i64, i64)> = tx
        .query_row(
            "SELECT item_id,quantity,stats_json,upgrade_count,remaining_slots FROM inventory
             WHERE account_id=?1 AND inventory_type=?2 AND slot=?3",
            params![account_id, inventory_type, slot],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()
        .map_err(|_| "account persistence failed")?;
    let Some((item_id, available, stats_json, upgrade, remaining)) = row else {
        return Ok(Err(item_world::MoveRefusal::SourceEmpty));
    };
    let available = u32::try_from(available.max(0)).unwrap_or(0);
    if available < quantity {
        return Ok(Err(item_world::MoveRefusal::InvalidQuantity));
    }
    Ok(Ok(StorageStack {
        item_id,
        quantity,
        stats: serde_json::from_str::<BTreeMap<String, i64>>(&stats_json).ok(),
        upgrade_count: u32::try_from(upgrade.max(0)).ok(),
        remaining_slots: u32::try_from(remaining.max(0)).ok(),
    }))
}

/// Mirror of `peek_inventory_stack` for the warehouse side.
pub(super) fn peek_storage_stack(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    slot: i16,
    quantity: u32,
) -> Result<Result<StorageStack, item_world::MoveRefusal>, String> {
    if !valid_storage_slot(slot) {
        return Ok(Err(item_world::MoveRefusal::InvalidSlot));
    }
    if quantity == 0 {
        return Ok(Err(item_world::MoveRefusal::InvalidQuantity));
    }
    let row: Option<(String, i64, String, i64, i64)> = tx
        .query_row(
            "SELECT item_id,quantity,stats_json,upgrade_count,remaining_slots FROM storage
             WHERE account_id=?1 AND slot=?2",
            params![account_id, slot],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()
        .map_err(|_| "account persistence failed")?;
    let Some((item_id, available, stats_json, upgrade, remaining)) = row else {
        return Ok(Err(item_world::MoveRefusal::SourceEmpty));
    };
    let available = u32::try_from(available.max(0)).unwrap_or(0);
    if available < quantity {
        return Ok(Err(item_world::MoveRefusal::InvalidQuantity));
    }
    Ok(Ok(StorageStack {
        item_id,
        quantity,
        stats: serde_json::from_str::<BTreeMap<String, i64>>(&stats_json).ok(),
        upgrade_count: u32::try_from(upgrade.max(0)).ok(),
        remaining_slots: u32::try_from(remaining.max(0)).ok(),
    }))
}

/// Remove `quantity` from one inventory stack.  The row is deleted when the
/// stack empties, which is what lets a later deposit reuse the slot.
pub(super) fn take_inventory_stack(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    inventory_type: u8,
    slot: i16,
    quantity: u32,
) -> Result<(), String> {
    let remaining: i64 = tx
        .query_row(
            "SELECT quantity FROM inventory
             WHERE account_id=?1 AND inventory_type=?2 AND slot=?3",
            params![account_id, inventory_type, slot],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "account persistence failed")?
        .unwrap_or(0);
    if remaining <= i64::from(quantity) {
        tx.execute(
            "DELETE FROM inventory WHERE account_id=?1 AND inventory_type=?2 AND slot=?3",
            params![account_id, inventory_type, slot],
        )
        .map_err(|_| "account persistence failed")?;
    } else {
        tx.execute(
            "UPDATE inventory SET quantity=quantity-?4
             WHERE account_id=?1 AND inventory_type=?2 AND slot=?3",
            params![account_id, inventory_type, slot, i64::from(quantity)],
        )
        .map_err(|_| "account persistence failed")?;
    }
    Ok(())
}

/// Mirror of `take_inventory_stack` for the warehouse side.
pub(super) fn take_storage_stack(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    slot: i16,
    quantity: u32,
) -> Result<(), String> {
    let remaining: i64 = tx
        .query_row(
            "SELECT quantity FROM storage WHERE account_id=?1 AND slot=?2",
            params![account_id, slot],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "account persistence failed")?
        .unwrap_or(0);
    if remaining <= i64::from(quantity) {
        tx.execute(
            "DELETE FROM storage WHERE account_id=?1 AND slot=?2",
            params![account_id, slot],
        )
        .map_err(|_| "account persistence failed")?;
    } else {
        tx.execute(
            "UPDATE storage SET quantity=quantity-?3 WHERE account_id=?1 AND slot=?2",
            params![account_id, slot, i64::from(quantity)],
        )
        .map_err(|_| "account persistence failed")?;
    }
    Ok(())
}

/// Decide whether a deposit can fit, and if so where the row(s) would go.
/// Checked before any mutation so a full warehouse refuses cleanly instead of
/// destroying the stack.
///
/// Two error layers, deliberately separated (world model §32): `Ok(Err(_))` is
/// a business refusal ("the warehouse cannot take this stack"), while `Err(_)`
/// is a persistence failure that must abort the surrounding transaction.
/// Before this was typed, the two shared one `String` channel, so a failed
/// `query_row` was recorded in the idempotency receipt *as if the warehouse
/// were full* and the transaction committed. That mislabelling is the one
/// behaviour this refactor intentionally corrects; it is only reachable when
/// SQLite itself fails, which no test or live path exercises.
pub(super) fn reserve_storage_slot(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    item_id: &str,
    quantity: u32,
) -> Result<Result<(), item_world::MoveRefusal>, String> {
    let mut need = i64::from(quantity);
    // Equipment instances never merge: two identical-looking weapons with a
    // different scroll history are different items.
    if !inventory::is_equipment(item_id) {
        let slot_max = i64::from(inventory::item_slot_max(item_id));
        let mergeable: i64 = tx
            .query_row(
                "SELECT COALESCE(SUM(?3-quantity),0) FROM storage
                 WHERE account_id=?1 AND item_id=?2 AND quantity>0 AND quantity<?3",
                params![account_id, item_id, slot_max],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "account persistence failed")?
            .unwrap_or(0);
        need = (need - mergeable.max(0)).max(0);
    }
    if need <= 0 {
        return Ok(Ok(()));
    }
    let free: i64 = tx
        .query_row(
            "SELECT ?2 - COUNT(*) FROM storage WHERE account_id=?1",
            params![account_id, i64::from(STORAGE_SLOT_LIMIT)],
            |row| row.get(0),
        )
        .map_err(|_| "account persistence failed")?;
    if free <= 0 {
        return Ok(Err(item_world::MoveRefusal::DestinationFull));
    }
    // A single slot can hold at most `slotMax`; more than one new row is only
    // needed when the amount exceeds a fresh stack.  Equipment needs exactly
    // one row and always fits in a free slot.
    let per_row = i64::from(inventory::item_slot_max(item_id)).max(1);
    let rows_needed = (need + per_row - 1) / per_row;
    if rows_needed > free {
        return Ok(Err(item_world::MoveRefusal::DestinationFull));
    }
    Ok(Ok(()))
}

/// Put a prepared stack into the warehouse, merging into an identical stack
/// when the item is stackable and there is room.
pub(super) fn insert_storage_stack(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    stack: &StorageStack,
) -> Result<(), String> {
    let stats_json = serde_json::to_string(stack.stats.as_ref().unwrap_or(&BTreeMap::new()))
        .unwrap_or_else(|_| "{}".to_owned());
    let upgrade = i64::from(stack.upgrade_count.unwrap_or(0));
    let remaining = i64::from(stack.remaining_slots.unwrap_or(0));
    let mut left = i64::from(stack.quantity);
    if !inventory::is_equipment(&stack.item_id) {
        let slot_max = i64::from(inventory::item_slot_max(&stack.item_id));
        while left > 0 {
            let target: Option<(i64, i64)> = tx
                .query_row(
                    "SELECT slot,quantity FROM storage
                     WHERE account_id=?1 AND item_id=?2 AND quantity>0 AND quantity<?3
                     ORDER BY slot LIMIT 1",
                    params![account_id, stack.item_id, slot_max],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|_| "account persistence failed")?;
            let Some((slot, existing)) = target else {
                break;
            };
            let added = left.min((slot_max - existing).max(0));
            if added <= 0 {
                break;
            }
            tx.execute(
                "UPDATE storage SET quantity=quantity+?3 WHERE account_id=?1 AND slot=?2",
                params![account_id, slot, added],
            )
            .map_err(|_| "account persistence failed")?;
            left -= added;
        }
    }
    while left > 0 {
        let slot: i64 = (1..=i64::from(STORAGE_SLOT_LIMIT))
            .find(|candidate| {
                tx.query_row(
                    "SELECT 1 FROM storage WHERE account_id=?1 AND slot=?2",
                    params![account_id, candidate],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .unwrap_or(None)
                .is_none()
            })
            .ok_or_else(|| "storage_full".to_owned())?;
        let in_row = if inventory::is_equipment(&stack.item_id) {
            left
        } else {
            left.min(i64::from(inventory::item_slot_max(&stack.item_id)).max(1))
        };
        tx.execute(
            "INSERT INTO storage(account_id,slot,item_id,quantity,stats_json,upgrade_count,remaining_slots)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                account_id,
                slot,
                stack.item_id,
                in_row,
                stats_json,
                upgrade,
                remaining
            ],
        )
        .map_err(|_| "account persistence failed")?;
        left -= in_row;
    }
    Ok(())
}

/// Whether the character's inventory can accept a withdrawal.  Only decides
/// yes/no; the authoritative insert is `add_inventory_tx`.
pub(super) fn inventory_has_room(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    stack: &StorageStack,
) -> Result<bool, String> {
    let kind = match inventory::inventory_type(&stack.item_id) {
        Some(kind) => kind,
        None => return Ok(false),
    };
    let mut need = i64::from(stack.quantity);
    if !inventory::is_equipment(&stack.item_id) {
        let slot_max = i64::from(inventory::item_slot_max(&stack.item_id));
        let mergeable: i64 = tx
            .query_row(
                "SELECT COALESCE(SUM(?4-quantity),0) FROM inventory
                 WHERE account_id=?1 AND inventory_type=?2 AND item_id=?3
                   AND quantity>0 AND quantity<?4",
                params![account_id, kind, stack.item_id, slot_max],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "account persistence failed")?
            .unwrap_or(0);
        need = (need - mergeable.max(0)).max(0);
    }
    if need <= 0 {
        return Ok(true);
    }
    let capacity = read_inventory_slots_tx(tx, account_id)
        .map_err(|_| "account persistence failed")?
        .get(&kind)
        .copied()
        .unwrap_or(inventory::SLOT_LIMIT);
    let free: i64 = tx
        .query_row(
            "SELECT ?3 - COUNT(*) FROM inventory WHERE account_id=?1 AND inventory_type=?2",
            params![account_id, kind, i64::from(capacity)],
            |row| row.get(0),
        )
        .map_err(|_| "account persistence failed")?;
    if free <= 0 {
        return Ok(false);
    }
    if inventory::is_equipment(&stack.item_id) {
        return Ok(true);
    }
    let per_row = i64::from(inventory::item_slot_max(&stack.item_id)).max(1);
    Ok((need + per_row - 1) / per_row <= free)
}

pub fn valid_storage_slot(slot: i16) -> bool {
    (1..=STORAGE_SLOT_LIMIT as i16).contains(&slot)
}

pub(super) fn read_storage_action(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    request_id: &str,
) -> Result<Option<StorageOutcome>, String> {
    let row: Option<(String, i64, i64, String, i64, i64, String)> = tx
        .query_row(
            "SELECT operation,inventory_type,slot,item_id,quantity,success,code FROM storage_actions
             WHERE account_id=?1 AND request_id=?2",
            params![account_id, request_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .optional()
        .map_err(|_| "account persistence failed")?;
    let Some((operation, inventory_type, slot, item_id, quantity, success, code)) = row else {
        return Ok(None);
    };
    let operation = if operation == "storageWithdraw" {
        StorageOperation::Withdraw
    } else {
        StorageOperation::Deposit
    };
    Ok(Some(StorageOutcome {
        request_id: request_id.to_owned(),
        operation,
        inventory_type: u8::try_from(inventory_type).unwrap_or(0),
        slot: i16::try_from(slot).unwrap_or(0),
        item_id,
        quantity: u32::try_from(quantity.max(0)).unwrap_or(0),
        success: success != 0,
        code,
    }))
}

pub(super) fn insert_storage_action(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    outcome: &StorageOutcome,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO storage_actions(account_id,request_id,operation,inventory_type,item_id,quantity,slot,success,code)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            account_id,
            outcome.request_id,
            outcome.operation.as_str(),
            i64::from(outcome.inventory_type),
            outcome.item_id,
            i64::from(outcome.quantity),
            outcome.slot,
            if outcome.success { 1 } else { 0 },
            outcome.code
        ],
    )
    .map_err(|_| "account persistence failed")?;
    Ok(())
}

pub(super) fn read_storage_mesos_action(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    request_id: &str,
) -> Result<Option<StorageMesosOutcome>, String> {
    let row: Option<(String, i64, i64, String, i64, i64)> = tx
        .query_row(
            "SELECT operation,quantity,success,code,mesos,stored_mesos FROM storage_mesos_actions
             WHERE account_id=?1 AND request_id=?2",
            params![account_id, request_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()
        .map_err(|_| "account persistence failed")?;
    let Some((operation, quantity, success, code, mesos, stored)) = row else {
        return Ok(None);
    };
    let operation = if operation == "storageWithdraw" {
        StorageOperation::Withdraw
    } else {
        StorageOperation::Deposit
    };
    Ok(Some(StorageMesosOutcome {
        request_id: request_id.to_owned(),
        operation,
        quantity: u32::try_from(quantity.max(0)).unwrap_or(0),
        success: success != 0,
        code,
        mesos: u64::try_from(mesos.max(0)).unwrap_or(0),
        stored_mesos: u64::try_from(stored.max(0)).unwrap_or(0),
    }))
}

pub(super) fn insert_storage_mesos_action(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    outcome: &StorageMesosOutcome,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO storage_mesos_actions(account_id,request_id,operation,quantity,success,code,mesos,stored_mesos)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            account_id,
            outcome.request_id,
            outcome.operation.as_str(),
            i64::from(outcome.quantity),
            if outcome.success { 1 } else { 0 },
            outcome.code,
            i64::try_from(outcome.mesos).unwrap_or(i64::MAX),
            i64::try_from(outcome.stored_mesos).unwrap_or(i64::MAX),
        ],
    )
    .map_err(|_| "account persistence failed")?;
    Ok(())
}

pub(super) fn read_mesos_tx(tx: &rusqlite::Transaction<'_>, account_id: &str) -> Result<u64, String> {
    let mesos: i64 = tx
        .query_row(
            "SELECT mesos FROM player_stats WHERE account_id=?1",
            [account_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "account persistence failed")?
        .unwrap_or(0);
    Ok(u64::try_from(mesos.max(0)).unwrap_or(0))
}

pub(super) fn read_storage_mesos_tx(tx: &rusqlite::Transaction<'_>, account_id: &str) -> Result<u64, String> {
    let mesos: i64 = tx
        .query_row(
            "SELECT mesos FROM storage_mesos WHERE account_id=?1",
            [account_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "account persistence failed")?
        .unwrap_or(0);
    Ok(u64::try_from(mesos.max(0)).unwrap_or(0))
}

pub(super) fn read_storage_mesos_db(db: &Connection, account_id: &str) -> Result<u64, String> {
    let mesos: i64 = db
        .query_row(
            "SELECT mesos FROM storage_mesos WHERE account_id=?1",
            [account_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "account persistence failed")?
        .unwrap_or(0);
    Ok(u64::try_from(mesos.max(0)).unwrap_or(0))
}

pub(super) fn migrate_inventory_schema(
    db: &Connection,
    had_slot: bool,
    had_stats: bool,
    had_upgrade_count: bool,
    had_remaining_slots: bool,
) -> rusqlite::Result<()> {
    db.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| {
        db.execute_batch(
            "ALTER TABLE inventory RENAME TO inventory_legacy;
             CREATE TABLE inventory(
               account_id TEXT NOT NULL,
               inventory_type INTEGER NOT NULL DEFAULT 0,
               slot INTEGER NOT NULL,
               item_id TEXT NOT NULL,
               quantity INTEGER NOT NULL,
               stats_json TEXT NOT NULL DEFAULT '{}',
               upgrade_count INTEGER NOT NULL DEFAULT 0,
               remaining_slots INTEGER NOT NULL DEFAULT 0,
               PRIMARY KEY(account_id,inventory_type,slot)
             );",
        )?;
        let stats_column = if had_stats { "stats_json" } else { "'{}'" };
        let upgrade_column = if had_upgrade_count {
            "upgrade_count"
        } else {
            "0"
        };
        let remaining_column = if had_remaining_slots {
            "remaining_slots"
        } else {
            "0"
        };
        let query = if had_slot {
            format!(
                "SELECT account_id,slot,item_id,quantity,{stats_column},{upgrade_column},{remaining_column}
                 FROM inventory_legacy WHERE quantity>0 ORDER BY account_id,slot,item_id"
            )
        } else {
            format!(
                "SELECT account_id,NULL,item_id,quantity,{stats_column},{upgrade_column},{remaining_column}
                 FROM inventory_legacy WHERE quantity>0 ORDER BY account_id,item_id"
            )
        };
        let rows = {
            let mut stmt = db.prepare(&query)?;
            let result = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            })?;
            result.collect::<Result<Vec<_>, _>>()?
        };
        let mut used: BTreeMap<(String, u8), Vec<u16>> = BTreeMap::new();
        for (
            account_id,
            preferred_slot,
            item_id,
            quantity,
            stats_json,
            upgrade_count,
            remaining_slots,
        ) in rows
        {
            let kind = inventory::inventory_type(&item_id).ok_or_else(|| {
                rusqlite::Error::InvalidParameterName(format!(
                    "inventory migration: unknown item {item_id}"
                ))
            })?;
            let max = inventory::item_slot_max(&item_id);
            if inventory::is_equipment(&item_id) && quantity != 1 {
                return Err(rusqlite::Error::InvalidParameterName(format!(
                    "inventory migration: invalid equipment quantity for {item_id}"
                )));
            }
            let key = (account_id.clone(), kind);
            let slots = used.entry(key).or_default();
            let mut remaining = u32::try_from(quantity).map_err(|_| {
                rusqlite::Error::InvalidParameterName(format!(
                    "inventory migration: invalid quantity for {item_id}"
                ))
            })?;
            let mut preferred = preferred_slot.and_then(|slot| u16::try_from(slot).ok());
            while remaining > 0 {
                let slot = preferred
                    .take()
                    .filter(|slot| inventory::valid_slot(*slot as i16) && !slots.contains(slot))
                    .or_else(|| (1..=MAX_SLOT_LIMIT).find(|slot| !slots.contains(slot)))
                    .ok_or_else(|| {
                        rusqlite::Error::InvalidParameterName(format!(
                            "inventory migration: no free slot for {item_id}"
                        ))
                    })?;
                slots.push(slot);
                let amount = remaining.min(max);
                db.execute(
                    "INSERT INTO inventory(account_id,inventory_type,slot,item_id,quantity,stats_json,upgrade_count,remaining_slots)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                    params![
                        account_id,
                        i64::from(kind),
                        i64::from(slot),
                        item_id,
                        i64::from(amount),
                        stats_json,
                        upgrade_count,
                        remaining_slots,
                    ],
                )?;
                remaining -= amount;
            }
        }
        db.execute_batch("DROP TABLE inventory_legacy;")?;
        Ok(())
    })();
    match result {
        Ok(()) => {
            db.execute_batch("COMMIT")?;
            Ok(())
        }
        Err(error) => {
            let _ = db.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

pub(super) fn read_inventory_action(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    request_id: &str,
) -> Result<Option<InventoryOutcome>, String> {
    tx.query_row(
        "SELECT request_id,operation,inventory_type,from_slot,to_slot,item_id,quantity,drop_id,success,code
         FROM inventory_actions WHERE account_id=?1 AND request_id=?2",
        params![account_id, request_id],
        inventory_outcome_from_row,
    )
    .optional()
    .map_err(|_| "account persistence failed".to_owned())
}

pub(super) fn read_pickup_action(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    request_id: &str,
) -> Result<Option<PickupOutcome>, String> {
    tx.query_row(
        "SELECT drop_id,item_id,quantity,slot,success,code FROM pickup_actions
         WHERE account_id=?1 AND request_id=?2",
        params![account_id, request_id],
        |row| {
            Ok(PickupOutcome {
                drop_id: row.get(0)?,
                item_id: row.get(1)?,
                quantity: row.get::<_, i64>(2)?.try_into().unwrap_or(0),
                slot: row
                    .get::<_, Option<i64>>(3)?
                    .and_then(|slot| slot.try_into().ok()),
                success: row.get::<_, i64>(4)? != 0,
                code: row.get(5)?,
            })
        },
    )
    .optional()
    .map_err(|_| "account persistence failed".to_owned())
}

pub(super) fn normalize_inventory_tx(tx: &rusqlite::Transaction<'_>) -> Result<(), String> {
    let mut stmt = tx
        .prepare(
            "SELECT rowid,account_id,inventory_type,slot,item_id,quantity,
                    stats_json,upgrade_count,remaining_slots
             FROM inventory ORDER BY account_id,rowid",
        )
        .map_err(|_| "account persistence failed")?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, i64>(8)?,
            ))
        })
        .map_err(|_| "account persistence failed")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "account persistence failed")?;
    drop(stmt);
    let mut pet_accounts = HashSet::new();
    for (
        rowid,
        account_id,
        _old_kind,
        old_slot,
        item_id,
        quantity,
        old_stats_json,
        old_upgrade_count,
        old_remaining_slots,
    ) in rows
    {
        if quantity <= 0 {
            tx.execute("DELETE FROM inventory WHERE rowid=?1", [rowid])
                .map_err(|_| "account persistence failed")?;
            continue;
        }
        let kind = inventory::inventory_type(&item_id)
            .ok_or_else(|| format!("unknown inventory item {item_id}"))?;
        let is_pet = inventory::is_pet(&item_id);
        if is_pet {
            pet_accounts.insert(account_id.clone());
        }
        let quantity = u32::try_from(quantity)
            .map_err(|_| format!("invalid inventory quantity for {item_id}"))?;
        if inventory::is_equipment(&item_id) && quantity != 1 {
            return Err(format!("invalid equipment quantity for {item_id}"));
        }
        let mut stats_json = old_stats_json;
        let upgrade_count = u32::try_from(old_upgrade_count.max(0)).unwrap_or(0);
        let mut remaining_slots = u32::try_from(old_remaining_slots.max(0)).unwrap_or(0);
        if inventory::is_equipment(&item_id) || is_pet {
            let parsed = serde_json::from_str::<BTreeMap<String, i64>>(&stats_json).ok();
            if inventory::is_equipment(&item_id)
                && parsed.as_ref().is_none_or(BTreeMap::is_empty)
                && upgrade_count == 0
                && remaining_slots == 0
            {
                stats_json = serde_json::to_string(&inventory::equipment_attributes(&item_id))
                    .map_err(|_| "account persistence failed")?;
                remaining_slots = inventory::equipment_upgrade_slots(&item_id);
            }
            if is_pet {
                let mut pet = InventoryItem {
                    slot: u16::try_from(old_slot).unwrap_or(0),
                    item_id: item_id.clone(),
                    quantity,
                    stats: parsed,
                    ..InventoryItem::default()
                };
                inventory::ensure_pet_instance(&mut pet);
                stats_json = serde_json::to_string(&pet.stats.unwrap_or_default())
                    .map_err(|_| "account persistence failed")?;
            }
        }
        let max = inventory::item_slot_max(&item_id);
        let mut quantity_remaining = quantity;
        let mut preferred = u16::try_from(old_slot).ok();
        // The source row is deliberately excluded from the SQL occupied
        // query so its legacy slot can be reused on the first pass.  Track
        // every slot allocated for this row as we split it, otherwise the
        // second pass can select that same slot and hit the composite PK.
        let mut allocated_slots = Vec::new();
        while quantity_remaining > 0 {
            let occupied: Vec<u16> = {
                let mut occupied_stmt = tx
                    .prepare(
                        "SELECT slot FROM inventory
                     WHERE account_id=?1 AND inventory_type=?2 AND rowid<>?3",
                    )
                    .map_err(|_| "account persistence failed")?;
                let occupied = {
                    let result = occupied_stmt.query_map(
                        params![account_id, i64::from(kind), rowid],
                        |row| {
                            row.get::<_, i64>(0)
                                .map(|slot| slot.try_into().unwrap_or(0))
                        },
                    );
                    result
                        .map_err(|_| "account persistence failed")?
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|_| "account persistence failed")?
                };
                occupied
            };
            let slot = preferred
                .take()
                .filter(|slot| {
                    inventory::valid_slot(*slot as i16)
                        && !occupied.contains(slot)
                        && !allocated_slots.contains(slot)
                })
                .or_else(|| {
                    (1..=MAX_SLOT_LIMIT)
                        .find(|slot| !occupied.contains(slot) && !allocated_slots.contains(slot))
                })
                .ok_or_else(|| format!("no free inventory slot for {item_id}"))?;
            allocated_slots.push(slot);
            let amount = quantity_remaining.min(max);
            if quantity_remaining == quantity {
                tx.execute(
                    "UPDATE inventory SET inventory_type=?2,slot=?3,quantity=?4,stats_json=?5,
                     upgrade_count=?6,remaining_slots=?7 WHERE rowid=?1",
                    params![
                        rowid,
                        i64::from(kind),
                        i64::from(slot),
                        i64::from(amount),
                        stats_json,
                        i64::from(upgrade_count),
                        i64::from(remaining_slots),
                    ],
                )
                .map_err(|_| "account persistence failed")?;
            } else {
                tx.execute(
                    "INSERT INTO inventory(account_id,inventory_type,slot,item_id,quantity,
                     stats_json,upgrade_count,remaining_slots)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                    params![
                        account_id,
                        i64::from(kind),
                        i64::from(slot),
                        item_id,
                        i64::from(amount),
                        stats_json,
                        i64::from(upgrade_count),
                        i64::from(remaining_slots),
                    ],
                )
                .map_err(|_| "account persistence failed")?;
            }
            quantity_remaining -= amount;
        }
    }

    // The old fallback allowed a same-species pet row to carry quantity > 1.
    // `item_slot_max` now splits it into physical rows, while this second
    // pass persists the de-duplicated ids assigned by the in-memory repair.
    // Without writing these repaired stats back, every reconnect would assign
    // a different id to the later rows of the migrated stack.
    for account_id in pet_accounts {
        let normalized = read_inventory_tx(tx, &account_id)?;
        for item in normalized
            .iter()
            .filter(|item| inventory::is_pet(&item.item_id))
        {
            let kind = inventory::inventory_type(&item.item_id)
                .ok_or_else(|| format!("unknown inventory item {}", item.item_id))?;
            let stats_json = serde_json::to_string(&item.stats.clone().unwrap_or_default())
                .map_err(|_| "account persistence failed")?;
            tx.execute(
                "UPDATE inventory SET stats_json=?4
                 WHERE account_id=?1 AND inventory_type=?2 AND slot=?3
                   AND stats_json<>?4",
                params![
                    &account_id,
                    i64::from(kind),
                    i64::from(item.slot),
                    &stats_json,
                ],
            )
            .map_err(|_| "account persistence failed")?;
        }
    }
    Ok(())
}

pub(super) fn read_inventory_tx(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
) -> Result<Vec<InventoryItem>, String> {
    let mut stmt = tx
        .prepare(
            "SELECT inventory_type,slot,item_id,quantity,stats_json,upgrade_count,remaining_slots FROM inventory
             WHERE account_id=?1 AND inventory_type BETWEEN 1 AND 5 AND slot BETWEEN 1 AND ?2 AND quantity>0
             ORDER BY inventory_type,slot",
        )
        .map_err(|_| "account persistence failed")?;
    let rows = stmt
        .query_map(params![account_id, i64::from(MAX_SLOT_LIMIT)], |row| {
            let item_id: String = row.get(2)?;
            let is_equipment = inventory::is_equipment(&item_id);
            let is_pet = inventory::is_pet(&item_id);
            Ok(InventoryItem {
                slot: row.get::<_, i64>(1)?.try_into().unwrap_or(0),
                item_id,
                quantity: row.get::<_, i64>(3)?.try_into().unwrap_or(0),
                stats: if is_equipment || is_pet {
                    row.get::<_, String>(4)
                        .ok()
                        .and_then(|json| serde_json::from_str(&json).ok())
                } else {
                    None
                },
                remaining_slots: if is_equipment {
                    row.get::<_, i64>(6)
                        .ok()
                        .and_then(|value| u32::try_from(value.max(0)).ok())
                } else {
                    None
                },
                upgrade_count: if is_equipment {
                    row.get::<_, i64>(5)
                        .ok()
                        .and_then(|value| u32::try_from(value.max(0)).ok())
                } else {
                    None
                },
            })
        })
        .map_err(|_| "account persistence failed")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "account persistence failed")?;
    let mut rows = rows;
    for item in &mut rows {
        inventory::ensure_equipment_instance(item);
        inventory::ensure_pet_instance(item);
    }
    inventory::normalize_pet_instances(&mut rows);
    Ok(rows)
}

pub(super) fn read_equipped_tx(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
) -> Result<Vec<InventoryItem>, String> {
    let mut stmt = tx
        .prepare(
            "SELECT slot,item_id,quantity,stats_json,upgrade_count,remaining_slots FROM equipped
             WHERE account_id=?1 AND slot BETWEEN -50 AND -1 AND quantity>0 ORDER BY slot",
        )
        .map_err(|_| "account persistence failed")?;
    let collected = {
        let result = stmt.query_map([account_id], |row| {
            let slot: i64 = row.get(0)?;
            let mut item = InventoryItem {
                slot: slot.unsigned_abs().try_into().unwrap_or(0),
                item_id: row.get(1)?,
                quantity: row.get::<_, i64>(2)?.try_into().unwrap_or(0),
                stats: row
                    .get::<_, String>(3)
                    .ok()
                    .and_then(|json| serde_json::from_str(&json).ok()),
                upgrade_count: row
                    .get::<_, i64>(4)
                    .ok()
                    .and_then(|value| u32::try_from(value.max(0)).ok()),
                remaining_slots: row
                    .get::<_, i64>(5)
                    .ok()
                    .and_then(|value| u32::try_from(value.max(0)).ok()),
            };
            inventory::ensure_equipment_instance(&mut item);
            Ok(item)
        });
        result
            .map_err(|_| "account persistence failed")?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "account persistence failed".to_owned())?
    };
    Ok(collected)
}

pub(crate) fn read_equipped_db(db: &Connection, account_id: &str) -> Result<Vec<InventoryItem>, String> {
    let mut stmt = db
        .prepare(
            "SELECT slot,item_id,quantity,stats_json,upgrade_count,remaining_slots FROM equipped
             WHERE account_id=?1 AND slot BETWEEN -50 AND -1 AND quantity>0 ORDER BY slot",
        )
        .map_err(|_| "account persistence failed")?;
    let collected = {
        let result = stmt.query_map([account_id], |row| {
            let slot: i64 = row.get(0)?;
            let mut item = InventoryItem {
                slot: slot.unsigned_abs().try_into().unwrap_or(0),
                item_id: row.get(1)?,
                quantity: row.get::<_, i64>(2)?.try_into().unwrap_or(0),
                stats: row
                    .get::<_, String>(3)
                    .ok()
                    .and_then(|json| serde_json::from_str(&json).ok()),
                upgrade_count: row
                    .get::<_, i64>(4)
                    .ok()
                    .and_then(|value| u32::try_from(value.max(0)).ok()),
                remaining_slots: row
                    .get::<_, i64>(5)
                    .ok()
                    .and_then(|value| u32::try_from(value.max(0)).ok()),
            };
            inventory::ensure_equipment_instance(&mut item);
            Ok(item)
        });
        result
            .map_err(|_| "account persistence failed")?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "account persistence failed".to_owned())?
    };
    Ok(collected)
}

pub(super) fn write_inventory_tx(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    inventory_items: &[InventoryItem],
) -> Result<(), String> {
    tx.execute("DELETE FROM inventory WHERE account_id=?1", [account_id])
        .map_err(|_| "account persistence failed")?;
    let mut inventory_items = inventory_items.to_vec();
    inventory::normalize_pet_instances(&mut inventory_items);
    for item in &inventory_items {
        let kind = inventory::inventory_type(&item.item_id)
            .ok_or_else(|| format!("unknown inventory item {}", item.item_id))?;
        if !inventory::valid_slot(item.slot as i16) {
            return Err(format!("invalid inventory slot for {}", item.item_id));
        }
        if item.quantity == 0 {
            return Err(format!("invalid inventory quantity for {}", item.item_id));
        }
        if inventory::is_equipment(&item.item_id) && item.quantity != 1 {
            return Err(format!("invalid equipment quantity for {}", item.item_id));
        }
        let mut item = item.clone();
        inventory::ensure_equipment_instance(&mut item);
        inventory::ensure_pet_instance(&mut item);
        let stats_json = serde_json::to_string(&item.stats.clone().unwrap_or_default())
            .map_err(|_| "account persistence failed")?;
        tx.execute(
            "INSERT INTO inventory(account_id,inventory_type,slot,item_id,quantity,stats_json,upgrade_count,remaining_slots)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                account_id,
                i64::from(kind),
                i64::from(item.slot),
                item.item_id,
                i64::from(item.quantity),
                stats_json,
                i64::from(item.upgrade_count.unwrap_or(0)),
                i64::from(item.remaining_slots.unwrap_or(0)),
            ],
        )
        .map_err(|_| "account persistence failed")?;
    }
    Ok(())
}

pub(super) fn write_equipped_tx(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    equipped_items: &[InventoryItem],
) -> Result<(), String> {
    tx.execute("DELETE FROM equipped WHERE account_id=?1", [account_id])
        .map_err(|_| "account persistence failed")?;
    for item in equipped_items {
        if !inventory::is_equipment(&item.item_id) {
            return Err(format!("invalid equipped item {}", item.item_id));
        }
        if !(1..=50).contains(&item.slot) {
            return Err(format!("invalid equipped slot for {}", item.item_id));
        }
        if item.quantity != 1 {
            return Err(format!("invalid equipped quantity for {}", item.item_id));
        }
        if inventory::equipment_slot(&item.item_id) != Some(-(item.slot as i16)) {
            return Err(format!("equipment slot mismatch for {}", item.item_id));
        }
        let mut item = item.clone();
        inventory::ensure_equipment_instance(&mut item);
        let stats_json = serde_json::to_string(&item.stats.clone().unwrap_or_default())
            .map_err(|_| "account persistence failed")?;
        tx.execute(
            "INSERT INTO equipped(account_id,slot,item_id,quantity,stats_json,upgrade_count,remaining_slots)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                account_id,
                -i64::from(item.slot),
                item.item_id,
                i64::from(item.quantity),
                stats_json,
                i64::from(item.upgrade_count.unwrap_or(0)),
                i64::from(item.remaining_slots.unwrap_or(0)),
            ],
        )
        .map_err(|_| "account persistence failed")?;
    }
    Ok(())
}

/// Read the durable per-tab slot capacities inside a transaction.  An empty
/// JSON (older rows) means every tab is at the default 24.
pub(super) fn read_inventory_slots_tx(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
) -> Result<BTreeMap<u8, u16>, inventory::InventoryError> {
    let raw: String = tx
        .query_row(
            "SELECT inventory_slots_json FROM player_stats WHERE account_id=?1",
            [account_id],
            |row| row.get(0),
        )
        .map_err(|_| inventory::InventoryError::QuantityOverflow)?;
    if raw.is_empty() {
        return Ok(inventory::default_inventory_slots());
    }
    let parsed: BTreeMap<u8, u16> = serde_json::from_str(&raw)
        .map_err(|_| inventory::InventoryError::QuantityOverflow)?;
    let mut slots = inventory::default_inventory_slots();
    for (kind, capacity) in parsed {
        if inventory::valid_inventory_type(kind) {
            slots.insert(kind, capacity.clamp(inventory::SLOT_LIMIT, inventory::MAX_SLOT_LIMIT));
        }
    }
    Ok(slots)
}

pub(super) fn write_inventory_slots_tx(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    slots: &BTreeMap<u8, u16>,
) -> Result<(), inventory::InventoryError> {
    let json = serde_json::to_string(slots).map_err(|_| inventory::InventoryError::QuantityOverflow)?;
    tx.execute(
        "UPDATE player_stats SET inventory_slots_json=?2 WHERE account_id=?1",
        params![account_id, json],
    )
    .map_err(|_| inventory::InventoryError::QuantityOverflow)?;
    Ok(())
}

pub(super) fn apply_scroll_tx(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    item_id: &str,
    target_slot: Option<i16>,
    target_item_id: Option<&str>,
) -> Result<bool, inventory::InventoryError> {
    let Some(target_slot) = target_slot else {
        return Err(inventory::InventoryError::InvalidEquipmentSlot);
    };
    if inventory::valid_slot(target_slot) {
        return Err(inventory::InventoryError::LegendarySpiritRequired);
    }
    if !inventory::valid_equipment_slot(target_slot) {
        return Err(inventory::InventoryError::InvalidEquipmentSlot);
    }
    let Some(target_item_id) = target_item_id else {
        return Err(inventory::InventoryError::UnknownItem);
    };
    let target: Option<(String, String, i64, i64)> = tx
        .query_row(
            "SELECT item_id,stats_json,upgrade_count,remaining_slots FROM equipped
             WHERE account_id=?1 AND slot=?2 AND quantity>0",
            params![account_id, i64::from(target_slot)],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|_| inventory::InventoryError::QuantityOverflow)?;
    let Some((equipped_item_id, stats_json, upgrades, remaining)) = target else {
        return Err(inventory::InventoryError::SourceEmpty);
    };
    if equipped_item_id != target_item_id || remaining <= 0 {
        return Err(inventory::InventoryError::RequirementsNotMet);
    }
    if !inventory::scroll_applies_to_item(item_id, &equipped_item_id) {
        return Err(inventory::InventoryError::RequirementsNotMet);
    }
    let Some(effects) = inventory::scroll_effect(item_id) else {
        return Err(inventory::InventoryError::ItemNotUsable);
    };
    let mut attributes: BTreeMap<String, i64> =
        serde_json::from_str(&stats_json).unwrap_or_default();
    if attributes.is_empty() {
        attributes = inventory::equipment_attributes(&equipped_item_id);
    }
    let success_rate = inventory::item_success_rate(item_id).unwrap_or(0);
    let success = rand::thread_rng().gen_range(0..100) < success_rate;
    if success {
        for (key, value) in effects {
            *attributes.entry(key).or_insert(0) += value;
        }
    }
    let serialized = serde_json::to_string(&attributes)
        .map_err(|_| inventory::InventoryError::QuantityOverflow)?;
    tx.execute(
        "UPDATE equipped SET stats_json=?3,upgrade_count=?4,remaining_slots=?5
         WHERE account_id=?1 AND slot=?2",
        params![
            account_id,
            i64::from(target_slot),
            serialized,
            upgrades.saturating_add(i64::from(success)),
            remaining.saturating_sub(1)
        ],
    )
    .map_err(|_| inventory::InventoryError::QuantityOverflow)?;
    Ok(success)
}

pub(super) fn inventory_outcome_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<InventoryOutcome> {
    Ok(InventoryOutcome {
        request_id: row.get(0)?,
        operation: row.get(1)?,
        inventory_type: row
            .get::<_, i64>(2)?
            .try_into()
            .ok()
            .filter(|kind| inventory::valid_inventory_type(*kind)),
        from_slot: row.get::<_, i64>(3)?.try_into().unwrap_or(0),
        to_slot: row
            .get::<_, Option<i64>>(4)?
            .and_then(|slot| slot.try_into().ok()),
        item_id: row.get(5)?,
        quantity: row.get::<_, i64>(6)?.try_into().unwrap_or(0),
        drop_id: row.get(7)?,
        success: row.get::<_, i64>(8)? != 0,
        code: row.get(9)?,
    })
}

pub(super) fn insert_inventory_action(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    outcome: &InventoryOutcome,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO inventory_actions(account_id,request_id,operation,inventory_type,from_slot,to_slot,item_id,quantity,drop_id,success,code)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        params![
            account_id,
            outcome.request_id,
            outcome.operation,
            outcome.inventory_type.map(i64::from).unwrap_or(0),
            i64::from(outcome.from_slot),
            outcome.to_slot.map(i64::from),
            outcome.item_id,
            i64::from(outcome.quantity),
            outcome.drop_id,
            if outcome.success { 1 } else { 0 },
            outcome.code,
        ],
    )
    .map_err(|_| String::from("account persistence failed"))?;
    Ok(())
}

/// Add a normal item to the first matching stack, or the first empty regular
/// inventory slot.  The caller owns the surrounding transaction so a failed
/// full/overflow result leaves both the item and its source drop untouched.
pub(super) fn add_inventory_tx(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    item_id: &str,
    quantity: u32,
    instance_stats: Option<&BTreeMap<String, i64>>,
    instance_remaining_slots: Option<u32>,
    instance_upgrade_count: Option<u32>,
) -> Result<Result<u16, &'static str>, String> {
    if inventory::is_only(item_id) {
        let exists: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM inventory WHERE account_id=?1 AND item_id=?2 AND quantity>0
                 UNION ALL SELECT 1 FROM equipped WHERE account_id=?1 AND item_id=?2 AND quantity>0
                 UNION ALL SELECT 1 FROM monster_book_cards WHERE account_id=?1 AND item_id=?2 AND quantity>0
                 LIMIT 1",
                params![account_id, item_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "account persistence failed")?;
        if exists.is_some() {
            return Ok(Err("item_unavailable"));
        }
    }
    let Some(kind) = inventory::inventory_type(item_id) else {
        return Ok(Err("unknown_item"));
    };
    if kind == 1 && quantity != 1 {
        return Ok(Err("quantity_mismatch"));
    }
    let mut inventory_items = read_inventory_tx(tx, account_id)?;
    let slots = read_inventory_slots_tx(tx, account_id)
        .map_err(|_| "account persistence failed")?;
    let slot_limit = slots.get(&kind).copied().unwrap_or(inventory::SLOT_LIMIT);
    match inventory::add_items(&mut inventory_items, item_id.to_owned(), quantity, slot_limit) {
        Ok(slot) => {
            if kind == 1 || inventory::is_pet(item_id) {
                if let Some(item) = inventory_items.iter_mut().find(|item| {
                    item.slot == slot
                        && inventory::inventory_type(&item.item_id) == Some(kind)
                        && item.item_id == item_id
                }) {
                    if let Some(stats) = instance_stats {
                        item.stats = Some(stats.clone());
                    }
                    if inventory::is_pet(item_id) {
                        inventory::ensure_pet_instance(item);
                    }
                    if let Some(remaining) = instance_remaining_slots {
                        if kind == 1 {
                            item.remaining_slots = Some(remaining);
                        }
                    }
                    if let Some(upgrade_count) = instance_upgrade_count {
                        if kind == 1 {
                            item.upgrade_count = Some(upgrade_count);
                        }
                    }
                    inventory::ensure_equipment_instance(item);
                }
            }
            write_inventory_tx(tx, account_id, &inventory_items)?;
            Ok(Ok(slot))
        }
        Err(error) => Ok(Err(error.code())),
    }
}

pub(super) fn ensure_starter_equipment_tx(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
) -> Result<(), String> {
    let seeded: i64 = tx
        .query_row(
            "SELECT starter_equipment_seeded FROM player_stats WHERE account_id=?1",
            [account_id],
            |row| row.get(0),
        )
        .map_err(|_| "account persistence failed")?;
    if seeded != 0 {
        return Ok(());
    }
    let equipped_count: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM equipped WHERE account_id=?1 AND quantity>0",
            [account_id],
            |row| row.get(0),
        )
        .map_err(|_| "account persistence failed")?;
    if equipped_count == 0 {
        for item in inventory::starter_equipment() {
            let stats = item.stats.clone().unwrap_or_default();
            let stats_json =
                serde_json::to_string(&stats).map_err(|_| "account persistence failed")?;
            tx.execute(
                "INSERT INTO equipped(account_id,slot,item_id,quantity,stats_json,upgrade_count,remaining_slots)
                 VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![
                    account_id,
                    -i64::from(item.slot),
                    item.item_id,
                    i64::from(item.quantity),
                    stats_json,
                    i64::from(item.upgrade_count.unwrap_or(0)),
                    i64::from(item.remaining_slots.unwrap_or(0)),
                ],
            )
            .map_err(|_| "account persistence failed")?;
        }
    }
    tx.execute(
        "UPDATE player_stats SET starter_equipment_seeded=1 WHERE account_id=?1",
        [account_id],
    )
    .map_err(|_| "account persistence failed")?;
    Ok(())
}

pub(super) fn normalize_equipped_tx(tx: &rusqlite::Transaction<'_>) -> Result<(), String> {
    let mut stmt = tx
        .prepare(
            "SELECT rowid,account_id,slot,item_id,quantity,stats_json,upgrade_count,remaining_slots
             FROM equipped ORDER BY account_id,rowid",
        )
        .map_err(|_| "account persistence failed")?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
            ))
        })
        .map_err(|_| "account persistence failed")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "account persistence failed")?;
    drop(stmt);
    for (
        rowid,
        account_id,
        old_slot,
        item_id,
        quantity,
        old_stats_json,
        old_upgrade_count,
        old_remaining_slots,
    ) in rows
    {
        if !inventory::is_equipment(&item_id) {
            return Err(format!("invalid equipped item {item_id}"));
        }
        if quantity != 1 {
            return Err(format!("invalid equipped quantity for {item_id}"));
        }
        let slot = if inventory::valid_equipment_slot(old_slot as i16) {
            old_slot as i16
        } else if inventory::valid_slot(old_slot as i16) {
            // A short-lived development schema stored the absolute slot.
            // Convert it once, preserving the instance rather than silently
            // dropping the row.
            -(old_slot as i16)
        } else {
            return Err(format!("invalid equipped slot for {item_id}"));
        };
        if inventory::equipment_slot(&item_id) != Some(slot) {
            return Err(format!("equipment slot mismatch for {item_id}"));
        }
        let occupied: Option<i64> = tx
            .query_row(
                "SELECT rowid FROM equipped WHERE account_id=?1 AND slot=?2 AND rowid<>?3",
                params![account_id, i64::from(slot), rowid],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "account persistence failed")?;
        if occupied.is_some() {
            return Err(format!("duplicate equipped slot for {item_id}"));
        }
        let mut stats_json = old_stats_json;
        let upgrade_count = u32::try_from(old_upgrade_count.max(0)).unwrap_or(0);
        let mut remaining_slots = u32::try_from(old_remaining_slots.max(0)).unwrap_or(0);
        let parsed = serde_json::from_str::<BTreeMap<String, i64>>(&stats_json).ok();
        if parsed.as_ref().is_none_or(BTreeMap::is_empty)
            && upgrade_count == 0
            && remaining_slots == 0
        {
            stats_json = serde_json::to_string(&inventory::equipment_attributes(&item_id))
                .map_err(|_| "account persistence failed")?;
            remaining_slots = inventory::equipment_upgrade_slots(&item_id);
        }
        tx.execute(
            "UPDATE equipped SET slot=?2,stats_json=?3,upgrade_count=?4,remaining_slots=?5
             WHERE rowid=?1",
            params![
                rowid,
                i64::from(slot),
                stats_json,
                i64::from(upgrade_count),
                i64::from(remaining_slots),
            ],
        )
        .map_err(|_| "account persistence failed")?;
    }
    Ok(())
}

pub(super) fn read_profile(tx: &rusqlite::Transaction<'_>, account_id: &str) -> Result<Profile, String> {
    normalize_inventory_tx(tx)?;
    let (
        hp,
        max_hp,
        mp,
        max_mp,
        level,
        job,
        exp,
        exp_to_next,
        mesos,
        death_id,
        map_id,
        x,
        y,
        skills_json,
        skill_points_json,
        cash,
    ): (
        i64,
        i64,
        i64,
        i64,
        i64,
        i64,
        i64,
        i64,
        i64,
        String,
        String,
        f64,
        f64,
        String,
        String,
        i64,
    ) = tx
            .query_row(
                "SELECT hp,max_hp,mp,max_mp,level,job,exp,exp_to_next,mesos,death_id,map_id,x,y,skills_json,skill_points_json,cash FROM player_stats WHERE account_id=?1",
                [account_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                        row.get(9)?,
                        row.get(10)?,
                        row.get(11)?,
                        row.get(12)?,
                        row.get(13)?,
                        row.get(14)?,
                        row.get(15)?,
                    ))
                },
            )
            .map_err(|_| "account persistence failed")?;
    let skills = parse_skill_map(&skills_json)?;
    let skill_points = parse_skill_map(&skill_points_json)?;
    let inventory = read_inventory_tx(tx, account_id)?;
    let ability_json: String = tx
        .query_row(
            "SELECT ability_stats_json FROM player_stats WHERE account_id=?1",
            [account_id],
            |row| row.get(0),
        )
        .map_err(|_| "account persistence failed")?;
    let ability_stats =
        serde_json::from_str(&ability_json).map_err(|_| "invalid saved ability stats")?;
    Ok(Profile {
        hp: hp.max(0),
        max_hp: max_hp.max(1),
        mp: mp.max(0),
        max_mp: max_mp.max(0),
        level: level.max(1) as u32,
        job: u32::try_from(job).map_err(|_| "account persistence failed")?,
        exp: exp.max(0) as u64,
        exp_to_next: exp_to_next.max(0) as u64,
        mesos: mesos.max(0) as u64,
        cash: cash.max(0) as u64,
        death_id,
        map_id,
        x: if x.is_finite() { x } else { 0.0 },
        y: if y.is_finite() { y } else { 0.0 },
        inventory,
        skills,
        skill_points,
        ability_stats,
    })
}

pub(super) fn parse_skill_map(json: &str) -> Result<BTreeMap<u32, u32>, String> {
    serde_json::from_str(json).map_err(|_| "account persistence failed".to_owned())
}

pub(super) fn serialize_skill_map(map: &BTreeMap<u32, u32>) -> Result<String, String> {
    serde_json::to_string(map).map_err(|_| "account persistence failed".to_owned())
}

pub(super) fn write_profile(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    profile: &Profile,
) -> Result<(), String> {
    let skills_json = serialize_skill_map(&profile.skills)?;
    let skill_points_json = serialize_skill_map(&profile.skill_points)?;
    tx.execute(
        "UPDATE player_stats SET hp=?2,max_hp=?3,mp=?4,max_mp=?5,level=?6,job=?7,exp=?8,exp_to_next=?9,mesos=?10,death_id=?11,skills_json=?12,skill_points_json=?13,ability_stats_json=?14,map_id=?15,x=?16,y=?17
         WHERE account_id=?1",
        params![
            account_id,
            profile.hp,
            profile.max_hp,
            profile.mp,
            profile.max_mp,
            profile.level,
            profile.job,
            profile.exp,
            profile.exp_to_next,
            i64::try_from(profile.mesos).map_err(|_| "account persistence failed")?,
            profile.death_id,
            skills_json,
            skill_points_json,
            serde_json::to_string(&profile.ability_stats).map_err(|_| "account persistence failed")?,
            profile.map_id,
            profile.x,
            profile.y,
        ],
    )
    .map_err(|_| "account persistence failed")?;
    Ok(())
}

/// P: beginner levels 2..=7 grant 1 SP (R: historical cross-region rule,
/// https://en.wikibooks.org/wiki/MapleStory/Beginner_Guide/Skills; not a 273 script).
/// supported Mage books keep the project's existing 3-SP-per-level rule.
/// Call only after a real level increase, inside the reward transaction.
pub(crate) fn grant_level_sp(job: u32, level: u32, points: &mut BTreeMap<u32, u32>) {
    let (book, amount) = match job {
        0 if (2..=7).contains(&level) => (0, 1),
        THIRD_JOB => (THIRD_MAGE_BOOK, 3),
        220 => (220, 3),
        FOURTH_JOB => {
            let amount = fourth_sp_for_level(level);
            if amount == 0 {
                return;
            }
            (FOURTH_MAGE_BOOK, amount)
        }
        job if mage_job_allowed(job) => (MAGE_BOOK, 3),
        _ => return,
    };
    let available = points.entry(book).or_default();
    *available = available.saturating_add(amount);
}

pub(crate) fn add_exp(profile: &mut Profile, amount: u64, exp_table: &[u64]) {
    profile.exp = profile.exp.saturating_add(amount);
    while let Some(&threshold) = exp_table.get(profile.level.saturating_sub(1) as usize) {
        if threshold == 0 || profile.exp < threshold {
            profile.exp_to_next = threshold;
            break;
        }
        profile.exp -= threshold;
        profile.level = profile.level.saturating_add(1);
        profile.ability_stats.available_ap = profile.ability_stats.available_ap.saturating_add(5);
        grant_level_sp(profile.job, profile.level, &mut profile.skill_points);
        profile.exp_to_next = exp_table
            .get(profile.level.saturating_sub(1) as usize)
            .copied()
            .unwrap_or(0);
        if profile.exp_to_next == 0 {
            break;
        }
    }
    profile.exp_to_next = exp_table
        .get(profile.level.saturating_sub(1) as usize)
        .copied()
        .unwrap_or(0);
}
