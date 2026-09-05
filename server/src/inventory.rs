use crate::protocol::InventoryItem;

/// Cosmic's Character constructor gives the five regular inventory tabs 24
/// slots each.  This server currently has one general tab, and the browser
/// view is the same 4x6 (24-slot) Item window.  The source does not provide an
/// item-specific slotMax table in the current content manifest, so stack
/// merging is checked for integer overflow and otherwise follows the source
/// move semantics.
pub const SLOT_LIMIT: u16 = 24;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InventoryError {
    InvalidSlot,
    SourceEmpty,
    QuantityMissing,
    QuantityMismatch,
    QuantityOverflow,
    InventoryFull,
}

impl InventoryError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidSlot => "invalid_slot",
            Self::SourceEmpty => "source_empty",
            Self::QuantityMissing => "invalid_quantity",
            Self::QuantityMismatch => "quantity_mismatch",
            Self::QuantityOverflow => "quantity_overflow",
            Self::InventoryFull => "inventory_full",
        }
    }
}

pub fn valid_slot(slot: u16) -> bool {
    (1..=SLOT_LIMIT).contains(&slot)
}

/// Apply the regular-item branch of Cosmic Inventory.move: an empty target
/// receives the source, equal non-rechargeable IDs merge, and another item is
/// swapped.  The source packet includes quantity, but the v83 handler passes
/// it only to drop; a move transfers the complete source stack.  Requiring the
/// current quantity here makes stale or forged packets fail closed.
pub fn move_items(
    items: &mut Vec<InventoryItem>,
    from_slot: u16,
    to_slot: u16,
    quantity: u32,
) -> Result<(), InventoryError> {
    if !valid_slot(from_slot) || !valid_slot(to_slot) {
        return Err(InventoryError::InvalidSlot);
    }
    let Some(source_index) = items.iter().position(|item| item.slot == from_slot) else {
        return Err(InventoryError::SourceEmpty);
    };
    let source_quantity = items[source_index].quantity;
    if source_quantity == 0 {
        return Err(InventoryError::SourceEmpty);
    }
    if quantity == 0 {
        return Err(InventoryError::QuantityMissing);
    }
    if quantity != source_quantity {
        return Err(InventoryError::QuantityMismatch);
    }
    if from_slot == to_slot {
        return Ok(());
    }

    let target_index = items.iter().position(|item| item.slot == to_slot);
    match target_index {
        None => items[source_index].slot = to_slot,
        Some(target_index) if items[target_index].item_id == items[source_index].item_id => {
            let merged = items[target_index]
                .quantity
                .checked_add(source_quantity)
                .ok_or(InventoryError::QuantityOverflow)?;
            items[target_index].quantity = merged;
            items.remove(source_index);
        }
        Some(target_index) => {
            items[source_index].slot = to_slot;
            items[target_index].slot = from_slot;
        }
    }
    sort_items(items);
    Ok(())
}

pub fn remove_items(
    items: &mut Vec<InventoryItem>,
    slot: u16,
    quantity: u32,
) -> Result<(String, u32), InventoryError> {
    if !valid_slot(slot) {
        return Err(InventoryError::InvalidSlot);
    }
    if quantity == 0 {
        return Err(InventoryError::QuantityMissing);
    }
    let Some(index) = items.iter().position(|item| item.slot == slot) else {
        return Err(InventoryError::SourceEmpty);
    };
    let item = &items[index];
    if item.quantity == 0 {
        return Err(InventoryError::SourceEmpty);
    }
    if quantity > item.quantity {
        return Err(InventoryError::QuantityMismatch);
    }
    let item_id = item.item_id.clone();
    if quantity == item.quantity {
        items.remove(index);
    } else {
        items[index].quantity -= quantity;
    }
    sort_items(items);
    Ok((item_id, quantity))
}

/// Add a picked-up or otherwise server-created stack.  Existing same-ID
/// stacks merge because the current content has no item-specific `slotMax`;
/// otherwise the first free source slot is used, matching Inventory.getNextFreeSlot.
pub fn add_items(
    items: &mut Vec<InventoryItem>,
    item_id: String,
    quantity: u32,
) -> Result<u16, InventoryError> {
    if item_id.is_empty() || quantity == 0 {
        return Err(InventoryError::QuantityMissing);
    }
    if let Some(item) = items.iter_mut().find(|item| item.item_id == item_id) {
        item.quantity = item
            .quantity
            .checked_add(quantity)
            .ok_or(InventoryError::QuantityOverflow)?;
        let slot = item.slot;
        sort_items(items);
        return Ok(slot);
    }
    let slot = (1..=SLOT_LIMIT)
        .find(|slot| items.iter().all(|item| item.slot != *slot))
        .ok_or(InventoryError::InventoryFull)?;
    items.push(InventoryItem {
        slot,
        item_id,
        quantity,
    });
    sort_items(items);
    Ok(slot)
}

pub fn sort_items(items: &mut Vec<InventoryItem>) {
    items.sort_by_key(|item| item.slot);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(slot: u16, item_id: &str, quantity: u32) -> InventoryItem {
        InventoryItem {
            slot,
            item_id: item_id.into(),
            quantity,
        }
    }

    #[test]
    fn move_empty_target_and_swap_preserve_quantities() {
        let mut items = vec![item(1, "a", 3), item(3, "b", 2)];
        move_items(&mut items, 1, 2, 3).unwrap();
        assert_eq!(items, vec![item(2, "a", 3), item(3, "b", 2)]);
        move_items(&mut items, 2, 3, 3).unwrap();
        assert_eq!(items, vec![item(2, "b", 2), item(3, "a", 3)]);
    }

    #[test]
    fn equal_items_merge_and_drop_is_quantity_checked() {
        let mut items = vec![item(1, "a", 3), item(2, "a", 4)];
        move_items(&mut items, 1, 2, 3).unwrap();
        assert_eq!(items, vec![item(2, "a", 7)]);
        assert_eq!(remove_items(&mut items, 2, 2).unwrap(), ("a".into(), 2));
        assert_eq!(items, vec![item(2, "a", 5)]);
        assert_eq!(
            remove_items(&mut items, 2, 6),
            Err(InventoryError::QuantityMismatch)
        );
    }

    #[test]
    fn forged_partial_move_is_rejected_without_mutation() {
        let mut items = vec![item(1, "a", 3)];
        assert_eq!(
            move_items(&mut items, 1, 2, 1),
            Err(InventoryError::QuantityMismatch)
        );
        assert_eq!(items, vec![item(1, "a", 3)]);
    }
}
