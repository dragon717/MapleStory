use crate::protocol::InventoryItem;
use rand::Rng;
use serde::Deserialize;
use serde_json::Value;
use std::{collections::BTreeMap, iter::once, sync::OnceLock};

/// Every regular MapleStory inventory tab has 24 local slots.
pub const SLOT_LIMIT: u16 = 24;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItemDefinition {
    inventory_type: u8,
    slot_max: u32,
    #[serde(default)]
    info: BTreeMap<String, Value>,
    #[serde(default)]
    spec: BTreeMap<String, Value>,
}

fn catalog() -> &'static BTreeMap<String, ItemDefinition> {
    static CATALOG: OnceLock<BTreeMap<String, ItemDefinition>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let catalog: BTreeMap<String, ItemDefinition> = serde_json::from_str(include_str!(
            concat!(env!("CARGO_MANIFEST_DIR"), "/../shared/items.json")
        ))
        .expect("shared/items.json must be valid");
        // These entries exercise the inventory engine against source data that
        // is intentionally outside the small runtime catalog.  They are
        // compiled into tests only and never affect the server binary.
        #[cfg(test)]
        let catalog = {
            let mut catalog = catalog;
            let fixture: BTreeMap<String, ItemDefinition> = serde_json::from_str(include_str!(
                concat!(env!("CARGO_MANIFEST_DIR"), "/test-fixtures/items.json")
            ))
            .expect("test item fixture must be valid");
            catalog.extend(fixture);
            catalog
        };
        catalog
    })
}

fn item_definition(item_id: &str) -> Option<&'static ItemDefinition> {
    catalog().get(item_id)
}

/// Resolve an item tab from the WZ/catalog identifier.  Development saves can
/// contain IDs not yet present in the small catalog, so retain the source's
/// million-group fallback for those rows.
pub fn inventory_type(item_id: &str) -> Option<u8> {
    if let Some(definition) = item_definition(item_id) {
        return Some(definition.inventory_type);
    }
    let group = item_id.parse::<u32>().ok()?.checked_div(1_000_000)? as u8;
    valid_inventory_type(group).then_some(group)
}

pub fn valid_inventory_type(inventory_type: u8) -> bool {
    (1..=5).contains(&inventory_type)
}

pub fn valid_slot(slot: i16) -> bool {
    (1..=SLOT_LIMIT as i16).contains(&slot)
}

pub fn valid_equipment_slot(slot: i16) -> bool {
    (-50..=-1).contains(&slot)
}

fn value_i64(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_i64).or_else(|| {
        value
            .and_then(Value::as_u64)
            .and_then(|v| i64::try_from(v).ok())
    })
}

fn info_i64(item_id: &str, key: &str) -> Option<i64> {
    item_definition(item_id).and_then(|item| value_i64(item.info.get(key)))
}

pub fn equipment_upgrade_slots(item_id: &str) -> u32 {
    info_i64(item_id, "tuc").unwrap_or(0).max(0) as u32
}

/// The catalog `price` of one item, i.e. the same WZ field the NPC shop
/// entries are authored in.  `None` means the item has no recorded value and
/// therefore cannot be sold back to a shop for mesos.
pub fn item_price(item_id: &str) -> Option<u64> {
    info_i64(item_id, "price")
        .and_then(|price| u64::try_from(price.max(0)).ok())
        .filter(|price| *price > 0)
}

/// Whether an item may be handed to an NPC shop.  Source `tradeBlock` /
/// `dropBlock` mark quest and cash items the original never lets a player
/// move out of the inventory, so those stay unsellable.
pub fn is_unsellable(item_id: &str) -> bool {
    is_drop_restricted(item_id) || is_only(item_id)
}

/// Cash items carry no shop value in the original: they are bought with NX,
/// not mesos, so a shop must never pay mesos out for one.
pub fn is_cash_item(item_id: &str) -> bool {
    info_i64(item_id, "cash").unwrap_or(0) != 0
}

/// Return the absolute WZ attributes for a freshly-created equipment
/// instance.  Persisting these values on the instance lets a scroll update
/// survive an equip/unequip or a server restart without re-applying the
/// catalog values on every read.
pub fn equipment_attributes(item_id: &str) -> BTreeMap<String, i64> {
    let Some(definition) = item_definition(item_id) else {
        return BTreeMap::new();
    };
    let mut attributes = BTreeMap::new();
    for key in [
        "incPAD", "incPDD", "incMAD", "incMDD", "incACC", "incEVA", "incHP", "incMP", "incMHP",
        "incMMP", "incSTR", "incDEX", "incINT", "incLUK", "incJump", "incSpeed",
    ] {
        if let Some(value) = value_i64(definition.info.get(key)) {
            attributes.insert(key.to_owned(), value);
        }
    }
    attributes
}

/// Read one final equipment attribute.  Instance stats are authoritative;
/// catalog values are only the fallback for legacy instances.
pub fn equipment_attribute(item: &InventoryItem, key: &str) -> i64 {
    item.stats
        .as_ref()
        .and_then(|stats| stats.get(key).copied())
        .or_else(|| info_i64(&item.item_id, key))
        .unwrap_or(0)
}

/// Fill instance metadata for equipment loaded from a legacy row or created
/// by a reward.  Existing values always win so this helper is safe for
/// already-scrolled equipment.
pub fn ensure_equipment_instance(item: &mut InventoryItem) {
    if !is_equipment(&item.item_id) {
        return;
    }
    let legacy_defaults = item.stats.as_ref().is_none_or(BTreeMap::is_empty)
        && item.upgrade_count.unwrap_or(0) == 0
        && item.remaining_slots.unwrap_or(0) == 0;
    if item.stats.is_none() || legacy_defaults {
        item.stats = Some(equipment_attributes(&item.item_id));
    }
    if item.remaining_slots.is_none() || legacy_defaults {
        item.remaining_slots = Some(equipment_upgrade_slots(&item.item_id));
    }
    if item.upgrade_count.is_none() {
        item.upgrade_count = Some(0);
    }
}

/// The starter items used by the reference beginner profile.  Callers use
/// this only during first-account initialization; unequipping later removes
/// the persisted rows and must never call this helper again.
pub fn starter_equipment() -> Vec<InventoryItem> {
    [(-11_i16, "1302000"), (-5_i16, "1040002")]
        .into_iter()
        .map(|(slot, item_id)| {
            let mut item = InventoryItem {
                slot: slot.unsigned_abs(),
                item_id: item_id.to_owned(),
                quantity: 1,
                ..InventoryItem::default()
            };
            ensure_equipment_instance(&mut item);
            item
        })
        .collect()
}

pub fn item_success_rate(item_id: &str) -> Option<u32> {
    info_i64(item_id, "success").and_then(|value| u32::try_from(value.max(0)).ok())
}

fn spec_i64(item_id: &str, key: &str) -> Option<i64> {
    item_definition(item_id).and_then(|item| value_i64(item.spec.get(key)))
}

pub fn item_slot_max(item_id: &str) -> u32 {
    item_definition(item_id)
        .map(|item| item.slot_max)
        .unwrap_or_else(|| if is_equipment(item_id) { 1 } else { 100 })
        .max(1)
}

pub fn is_equipment(item_id: &str) -> bool {
    inventory_type(item_id) == Some(1)
}

pub fn is_rechargeable(item_id: &str) -> bool {
    item_id
        .parse::<u32>()
        .ok()
        .map(|id| {
            let group = id / 10_000;
            group == 207 || group == 233
        })
        .unwrap_or(false)
}

pub fn is_drop_restricted(item_id: &str) -> bool {
    info_i64(item_id, "tradeBlock").unwrap_or(0) != 0
        || info_i64(item_id, "dropBlock").unwrap_or(0) != 0
}

pub fn consume_on_pickup(item_id: &str) -> bool {
    spec_i64(item_id, "consumeOnPickup").unwrap_or(0) != 0
}

pub fn is_only(item_id: &str) -> bool {
    info_i64(item_id, "only").unwrap_or(0) != 0
}

/// The source's `EquipSlot` values, kept as the negative slots used by the
/// inventory protocol for an equipped item.
pub fn equipment_slot(item_id: &str) -> Option<i16> {
    let slot = item_definition(item_id)
        .and_then(|item| item.info.get("islot"))
        .and_then(Value::as_str)?;
    let slot = match slot {
        "Cp" | "HrCp" => -1,
        "Af" => -2,
        "Ay" => -3,
        "Ae" => -4,
        "Ma" | "MaPn" => -5,
        "Pn" => -6,
        "So" => -7,
        "GlGw" | "Gv" => -8,
        "Sr" => -9,
        "Si" => -10,
        "Wp" | "WpSi" | "WpSp" => -11,
        "Ri" => -12,
        "Ri2" => -13,
        "Ri3" => -15,
        "Ri4" => -16,
        "Pe" => -17,
        "Tm" => -18,
        "Sd" => -19,
        "Me" => -49,
        "Be" => -50,
        _ => return None,
    };
    Some(slot)
}

fn is_longcoat(item_id: &str) -> bool {
    item_definition(item_id)
        .and_then(|item| item.info.get("islot"))
        .and_then(Value::as_str)
        == Some("MaPn")
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EquipmentStats {
    pub level: u32,
    pub job: u32,
    pub strength: i64,
    pub dexterity: i64,
    pub intelligence: i64,
    pub luck: i64,
}

fn meets_requirements(item_id: &str, stats: EquipmentStats) -> bool {
    let req_job = info_i64(item_id, "reqJob").unwrap_or(0).max(0) as u32;
    let req_level = info_i64(item_id, "reqLevel").unwrap_or(0).max(0) as u32;
    let req_strength = info_i64(item_id, "reqSTR").unwrap_or(0).max(0);
    let req_dexterity = info_i64(item_id, "reqDEX").unwrap_or(0).max(0);
    let req_intelligence = info_i64(item_id, "reqINT").unwrap_or(0).max(0);
    let req_luck = info_i64(item_id, "reqLUK").unwrap_or(0).max(0);
    (req_job == 0
        || (stats.job != 0
            && ((stats.job / 100) % 10) >= 1
            && (req_job & (1 << (((stats.job / 100) % 10) - 1))) != 0))
        && stats.level >= req_level
        && stats.strength >= req_strength
        && stats.dexterity >= req_dexterity
        && stats.intelligence >= req_intelligence
        && stats.luck >= req_luck
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InventoryError {
    InvalidInventoryType,
    InvalidSlot,
    InvalidEquipmentSlot,
    SourceEmpty,
    QuantityMissing,
    QuantityMismatch,
    QuantityOverflow,
    InventoryFull,
    UnknownItem,
    ItemNotUsable,
    RequirementsNotMet,
    LegendarySpiritRequired,
}

impl InventoryError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidInventoryType => "invalid_inventory_type",
            Self::InvalidSlot => "invalid_slot",
            Self::InvalidEquipmentSlot => "invalid_equipment_slot",
            Self::SourceEmpty => "source_empty",
            Self::QuantityMissing => "invalid_quantity",
            Self::QuantityMismatch => "quantity_mismatch",
            Self::QuantityOverflow => "quantity_overflow",
            Self::InventoryFull => "inventory_full",
            Self::UnknownItem => "unknown_item",
            Self::ItemNotUsable => "item_not_usable",
            Self::RequirementsNotMet => "requirements_not_met",
            Self::LegendarySpiritRequired => "legendary_spirit_required",
        }
    }
}

fn item_index(items: &[InventoryItem], kind: u8, slot: i16) -> Option<usize> {
    items.iter().position(|item| {
        item.slot == u16::try_from(slot).unwrap_or(0) && inventory_type(&item.item_id) == Some(kind)
    })
}

fn occupied(items: &[InventoryItem], kind: u8, slot: u16) -> bool {
    items
        .iter()
        .any(|item| item.slot == slot && inventory_type(&item.item_id) == Some(kind))
}

fn stackable(kind: u8, item_id: &str) -> bool {
    kind != 1 && kind != 5 && !is_rechargeable(item_id)
}

/// Move one complete source stack.  For a regular tab, equal stackable IDs
/// merge up to the catalog slotMax; overflow remains in the source slot.  The
/// equip transition is handled by `equip_items`/`unequip_items` below.
pub fn move_items(
    items: &mut Vec<InventoryItem>,
    kind: u8,
    from_slot: i16,
    to_slot: i16,
    quantity: u32,
) -> Result<(), InventoryError> {
    if !valid_inventory_type(kind) {
        return Err(InventoryError::InvalidInventoryType);
    }
    if !valid_slot(from_slot) || !valid_slot(to_slot) {
        return Err(InventoryError::InvalidSlot);
    }
    let Some(source_index) = item_index(items, kind, from_slot) else {
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

    let target_index = item_index(items, kind, to_slot);
    match target_index {
        None => items[source_index].slot = u16::try_from(to_slot).unwrap_or(0),
        Some(target_index)
            if items[target_index].item_id == items[source_index].item_id
                && stackable(kind, &items[source_index].item_id) =>
        {
            let target_quantity = items[target_index].quantity;
            let max = item_slot_max(&items[source_index].item_id);
            let room = max.saturating_sub(target_quantity);
            let moved = room.min(source_quantity);
            if moved == 0 {
                return Ok(());
            }
            items[target_index].quantity = target_quantity
                .checked_add(moved)
                .ok_or(InventoryError::QuantityOverflow)?;
            if moved == source_quantity {
                items.remove(source_index);
            } else {
                items[source_index].quantity -= moved;
            }
        }
        Some(target_index) => {
            items[source_index].slot = u16::try_from(to_slot).unwrap_or(0);
            items[target_index].slot = u16::try_from(from_slot).unwrap_or(0);
        }
    }
    sort_items(items);
    Ok(())
}

pub fn remove_items(
    items: &mut Vec<InventoryItem>,
    kind: u8,
    slot: i16,
    quantity: u32,
) -> Result<(String, u32), InventoryError> {
    if !valid_inventory_type(kind) {
        return Err(InventoryError::InvalidInventoryType);
    }
    if !valid_slot(slot) {
        return Err(InventoryError::InvalidSlot);
    }
    if quantity == 0 {
        return Err(InventoryError::QuantityMissing);
    }
    let Some(index) = item_index(items, kind, slot) else {
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

/// Add a server-authoritative reward/drop.  Existing stacks are filled to
/// slotMax, then additional stacks are allocated in the first free local
/// slots.  The clone makes a full-tab failure atomic for the caller.
pub fn add_items(
    items: &mut Vec<InventoryItem>,
    item_id: String,
    quantity: u32,
) -> Result<u16, InventoryError> {
    if item_id.is_empty() || quantity == 0 {
        return Err(InventoryError::QuantityMissing);
    }
    let kind = inventory_type(&item_id).ok_or(InventoryError::UnknownItem)?;
    if item_id == "0" {
        return Err(InventoryError::UnknownItem);
    }
    let mut next = items.clone();
    let mut remaining = quantity;
    let mut first_slot = None;
    let can_stack = stackable(kind, &item_id);
    if can_stack {
        let max = item_slot_max(&item_id);
        for item in next.iter_mut().filter(|item| item.item_id == item_id) {
            if remaining == 0 {
                break;
            }
            let moved = max.saturating_sub(item.quantity).min(remaining);
            if moved > 0 {
                item.quantity = item
                    .quantity
                    .checked_add(moved)
                    .ok_or(InventoryError::QuantityOverflow)?;
                remaining -= moved;
                first_slot.get_or_insert(item.slot);
            }
        }
    }
    let max = if can_stack {
        item_slot_max(&item_id)
    } else {
        1
    };
    while remaining > 0 {
        let slot = (1..=SLOT_LIMIT)
            .find(|slot| !occupied(&next, kind, *slot))
            .ok_or(InventoryError::InventoryFull)?;
        let amount = remaining.min(max);
        let mut added = InventoryItem {
            slot,
            item_id: item_id.clone(),
            quantity: amount,
            ..InventoryItem::default()
        };
        ensure_equipment_instance(&mut added);
        next.push(added);
        first_slot.get_or_insert(slot);
        remaining -= amount;
    }
    sort_items(&mut next);
    *items = next;
    first_slot.ok_or(InventoryError::InventoryFull)
}

/// Add a reward while retaining metadata belonging to one equipment
/// instance.  Ordinary stackable items deliberately ignore the metadata;
/// equipment uses it for final attributes and remaining scroll slots.
pub fn add_item_instance(
    items: &mut Vec<InventoryItem>,
    item_id: String,
    quantity: u32,
    stats: Option<&BTreeMap<String, i64>>,
    remaining_slots: Option<u32>,
    upgrade_count: Option<u32>,
) -> Result<u16, InventoryError> {
    let slot = add_items(items, item_id.clone(), quantity)?;
    if is_equipment(&item_id) {
        if let Some(item) = items
            .iter_mut()
            .find(|item| item.slot == slot && inventory_type(&item.item_id) == Some(1))
        {
            if let Some(stats) = stats {
                item.stats = Some(stats.clone());
            }
            if let Some(remaining_slots) = remaining_slots {
                item.remaining_slots = Some(remaining_slots);
            }
            if let Some(upgrade_count) = upgrade_count {
                item.upgrade_count = Some(upgrade_count);
            }
            ensure_equipment_instance(item);
        }
    }
    Ok(slot)
}

/// Gather merges compatible stacks and compacts only one local inventory tab.
pub fn gather_items(items: &mut Vec<InventoryItem>, kind: u8) -> Result<(), InventoryError> {
    if !valid_inventory_type(kind) {
        return Err(InventoryError::InvalidInventoryType);
    }
    let mut next = items.clone();
    sort_category(&mut next, kind);
    let mut index = 0;
    while index < next.len() {
        if inventory_type(&next[index].item_id) != Some(kind)
            || !stackable(kind, &next[index].item_id)
        {
            index += 1;
            continue;
        }
        let item_id = next[index].item_id.clone();
        let max = item_slot_max(&item_id);
        let mut other = index + 1;
        while other < next.len() {
            if next[other].item_id == item_id {
                let room = max.saturating_sub(next[index].quantity);
                let moved = room.min(next[other].quantity);
                next[index].quantity += moved;
                next[other].quantity -= moved;
                if next[other].quantity == 0 {
                    next.remove(other);
                    continue;
                }
            }
            other += 1;
        }
        index += 1;
    }
    compact_category(&mut next, kind);
    *items = next;
    Ok(())
}

/// Sort one tab by numeric item ID, retaining stable slot order for equal IDs.
pub fn sort_category(items: &mut Vec<InventoryItem>, kind: u8) {
    let positions: Vec<usize> = items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| (inventory_type(&item.item_id) == Some(kind)).then_some(index))
        .collect();
    let mut category: Vec<InventoryItem> = positions
        .iter()
        .map(|&index| items[index].clone())
        .collect();
    category.sort_by(|a, b| {
        a.item_id
            .parse::<u32>()
            .unwrap_or(u32::MAX)
            .cmp(&b.item_id.parse::<u32>().unwrap_or(u32::MAX))
            .then_with(|| a.slot.cmp(&b.slot))
    });
    for (slot, item) in category.iter_mut().enumerate() {
        item.slot = u16::try_from(slot + 1).unwrap_or(SLOT_LIMIT);
    }
    for (position, item) in positions.into_iter().zip(category) {
        items[position] = item;
    }
    sort_items(items);
}

fn compact_category(items: &mut Vec<InventoryItem>, kind: u8) {
    let mut slot = 1u16;
    for item in items
        .iter_mut()
        .filter(|item| inventory_type(&item.item_id) == Some(kind))
    {
        item.slot = slot;
        slot += 1;
    }
    sort_items(items);
}

/// Sort all tabs while retaining each category's local slot numbers.
pub fn sort_items(items: &mut Vec<InventoryItem>) {
    items.sort_by_key(|item| (inventory_type(&item.item_id).unwrap_or(0), item.slot));
}

/// One authored consumable-recovery effect.
///
/// The original has two independent recovery forms and an item may use either
/// or both at once (T, read from the TMS273.7 `Item/Consume` `spec` node):
///   * **flat**  — `spec.hp` / `spec.mp`, an absolute amount (紅色藥水 hp=50);
///   * **rate**  — `spec.hpR` / `spec.mpR`, a percentage of the character's
///     own maximum pool (超級藥水 hpR=100).  A percentage heal is why the
///     same potion is worth using at level 1 and at level 200, and it is also
///     why the original puts those specific items behind a cooldown.
///
/// Percentages are resolved against the caller's maximum pool rather than
/// being baked into the catalog, so equipment and skill bonuses that raise
/// max HP/MP are honoured without re-exporting any item data.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct UseEffect {
    /// Flat HP restored, always >= 0.
    pub hp: i64,
    /// Flat MP restored, always >= 0.
    pub mp: i64,
    /// HP restored as a whole-percent share of max HP (`hpR` = 100 → full).
    pub hp_percent: i64,
    /// MP restored as a whole-percent share of max MP.
    pub mp_percent: i64,
    /// Authored use cooldown in milliseconds; `None` means the item has none.
    pub cooldown_ms: Option<u64>,
}

impl UseEffect {
    /// Resolve the effect into concrete amounts for one body.
    ///
    /// `rounding` is deliberately floor-with-a-minimum-of-1 for the percentage
    /// part: a positive percentage must always restore at least 1 point, so a
    /// low-level character is never handed a potion that silently does
    /// nothing.  Flat and percentage parts are added, and the caller clamps
    /// the total to the maximum pool.
    pub fn resolve(&self, max_hp: i64, max_mp: i64) -> (i64, i64) {
        let percent_hp = if self.hp_percent > 0 {
            (max_hp.max(0) * self.hp_percent / 100).max(1)
        } else {
            0
        };
        let percent_mp = if self.mp_percent > 0 {
            (max_mp.max(0) * self.mp_percent / 100).max(1)
        } else {
            0
        };
        (self.hp + percent_hp, self.mp + percent_mp)
    }

    /// True when the item restores anything at all.
    pub fn recovers(&self) -> bool {
        self.hp > 0 || self.mp > 0 || self.hp_percent > 0 || self.mp_percent > 0
    }
}

/// Read the authored recovery effect of a consumable.
///
/// Returns `ItemNotUsable` when the item restores nothing — that is the
/// original's behaviour for arrows, bullets, and other Use-tab items that
/// are consumed by the attack system rather than by a drink.
pub fn use_effect(item_id: &str) -> Result<UseEffect, InventoryError> {
    if inventory_type(item_id) != Some(2) {
        return Err(InventoryError::ItemNotUsable);
    }
    let effect = UseEffect {
        hp: spec_i64(item_id, "hp").unwrap_or(0).max(0),
        mp: spec_i64(item_id, "mp").unwrap_or(0).max(0),
        hp_percent: spec_i64(item_id, "hpR").unwrap_or(0).max(0),
        mp_percent: spec_i64(item_id, "mpR").unwrap_or(0).max(0),
        cooldown_ms: spec_i64(item_id, "time")
            .and_then(|value| u64::try_from(value.max(0)).ok())
            .filter(|value| *value > 0),
    };
    if !effect.recovers() {
        return Err(InventoryError::ItemNotUsable);
    }
    Ok(effect)
}

pub fn scroll_effect(item_id: &str) -> Option<BTreeMap<String, i64>> {
    if inventory_type(item_id) != Some(2) {
        return None;
    }
    let definition = item_definition(item_id)?;
    let mut effects = BTreeMap::new();
    for key in [
        "incPAD", "incPDD", "incMAD", "incMDD", "incACC", "incEVA", "incHP", "incMP", "incMHP",
        "incMMP", "incSTR", "incDEX", "incINT", "incLUK", "incJump", "incSpeed",
    ] {
        if let Some(value) = value_i64(definition.info.get(key)) {
            effects.insert(key.to_owned(), value);
        }
    }
    (!effects.is_empty()).then_some(effects)
}

/// Return the equipment family encoded in an ordinary scroll ID.  GMS83
/// stores the target family in `(scrollId / 100) % 100 + 100` (for example,
/// 2040002 targets category 100 headwear).
pub fn scroll_target_category(scroll_id: &str) -> Option<u32> {
    let id = scroll_id.parse::<u32>().ok()?;
    Some((id / 100) % 100 + 100)
}

pub fn scroll_applies_to_item(scroll_id: &str, item_id: &str) -> bool {
    let Some(target_category) = scroll_target_category(scroll_id) else {
        return false;
    };
    item_id
        .parse::<u32>()
        .map(|id| id / 10_000 == target_category)
        .unwrap_or(false)
}

/// Apply one scroll to an equipped item in memory.  This mirrors the
/// persistent `Store::use_item` path so worlds that run without SQLite keep
/// the same target validation, Legendary Spirit rule, success/failure result,
/// and instance metadata updates.
pub fn apply_scroll(
    equipped: &mut Vec<InventoryItem>,
    scroll_id: &str,
    target_slot: Option<i16>,
    target_item_id: Option<&str>,
) -> Result<bool, InventoryError> {
    let Some(target_slot) = target_slot else {
        return Err(InventoryError::InvalidEquipmentSlot);
    };
    if valid_slot(target_slot) {
        return Err(InventoryError::LegendarySpiritRequired);
    }
    if !valid_equipment_slot(target_slot) {
        return Err(InventoryError::InvalidEquipmentSlot);
    }
    let Some(target_item_id) = target_item_id else {
        return Err(InventoryError::UnknownItem);
    };
    let Some(target_index) = equipped_index(equipped, target_slot) else {
        return Err(InventoryError::SourceEmpty);
    };
    if equipped[target_index].item_id != target_item_id {
        return Err(InventoryError::RequirementsNotMet);
    }
    if !scroll_applies_to_item(scroll_id, target_item_id) {
        return Err(InventoryError::RequirementsNotMet);
    }
    let Some(effects) = scroll_effect(scroll_id) else {
        return Err(InventoryError::ItemNotUsable);
    };

    let mut target = equipped[target_index].clone();
    ensure_equipment_instance(&mut target);
    let remaining = target.remaining_slots.unwrap_or(0);
    if remaining == 0 {
        return Err(InventoryError::RequirementsNotMet);
    }
    let success_rate = item_success_rate(scroll_id).unwrap_or(0);
    let success = rand::thread_rng().gen_range(0..100) < success_rate;
    if success {
        let attributes = target.stats.get_or_insert_with(BTreeMap::new);
        for (key, value) in effects {
            *attributes.entry(key).or_insert(0) += value;
        }
        target.upgrade_count = Some(target.upgrade_count.unwrap_or(0).saturating_add(1));
    }
    target.remaining_slots = Some(remaining.saturating_sub(1));
    equipped[target_index] = target;
    Ok(success)
}

fn equipped_index(equipped: &[InventoryItem], slot: i16) -> Option<usize> {
    equipped
        .iter()
        .position(|item| item.slot == slot.unsigned_abs())
}

pub fn equip_items(
    inventory: &mut Vec<InventoryItem>,
    equipped: &mut Vec<InventoryItem>,
    stats: EquipmentStats,
    from_slot: i16,
    to_slot: i16,
) -> Result<(String, u32), InventoryError> {
    if !valid_slot(from_slot) {
        return Err(InventoryError::InvalidSlot);
    }
    if !valid_equipment_slot(to_slot) {
        return Err(InventoryError::InvalidEquipmentSlot);
    }
    let Some(source_index) = inventory.iter().position(|item| {
        item.slot == u16::try_from(from_slot).unwrap_or(0) && is_equipment(&item.item_id)
    }) else {
        return Err(InventoryError::SourceEmpty);
    };
    let source = inventory[source_index].clone();
    if source.quantity != 1 {
        return Err(InventoryError::QuantityMismatch);
    }
    let expected_slot = equipment_slot(&source.item_id).ok_or(InventoryError::UnknownItem)?;
    if expected_slot != to_slot {
        return Err(InventoryError::InvalidEquipmentSlot);
    }
    if !meets_requirements(&source.item_id, stats) {
        return Err(InventoryError::RequirementsNotMet);
    }
    let mut next_inventory = inventory.clone();
    let mut next_equipped = equipped.clone();
    next_inventory.remove(source_index);
    let extra_slot = if is_longcoat(&source.item_id) {
        Some(-6)
    } else if to_slot == -6 {
        equipped_index(&next_equipped, -5)
            .filter(|&index| is_longcoat(&next_equipped[index].item_id))
            .map(|_| -5)
    } else {
        None
    };
    // P interaction adapter: return conflicts to the source/free slots atomically.
    for slot in once(to_slot).chain(extra_slot) {
        if let Some(index) = equipped_index(&next_equipped, slot) {
            let mut displaced = next_equipped.remove(index);
            let destination = once(u16::try_from(from_slot).unwrap_or(0))
                .chain(1..=SLOT_LIMIT)
                .find(|slot| !occupied(&next_inventory, 1, *slot))
                .ok_or(InventoryError::InventoryFull)?;
            displaced.slot = destination;
            next_inventory.push(displaced);
        }
    }
    let mut equipped_source = source.clone();
    ensure_equipment_instance(&mut equipped_source);
    equipped_source.slot = to_slot.unsigned_abs();
    equipped_source.quantity = 1;
    next_equipped.push(equipped_source);
    sort_items(&mut next_inventory);
    next_equipped.sort_by_key(|item| item.slot);
    *inventory = next_inventory;
    *equipped = next_equipped;
    Ok((source.item_id, 1))
}

pub fn unequip_items(
    inventory: &mut Vec<InventoryItem>,
    equipped: &mut Vec<InventoryItem>,
    from_slot: i16,
    to_slot: i16,
) -> Result<(String, u32), InventoryError> {
    if !valid_equipment_slot(from_slot) {
        return Err(InventoryError::InvalidEquipmentSlot);
    }
    if !valid_slot(to_slot) {
        return Err(InventoryError::InvalidSlot);
    }
    let Some(source_index) = equipped_index(equipped, from_slot) else {
        return Err(InventoryError::SourceEmpty);
    };
    let source = equipped[source_index].clone();
    let mut next_inventory = inventory.clone();
    let mut next_equipped = equipped.clone();
    next_equipped.remove(source_index);
    if item_index(&next_inventory, 1, to_slot).is_some() {
        return Err(InventoryError::InventoryFull);
    }
    let mut inventory_source = source.clone();
    inventory_source.slot = u16::try_from(to_slot).unwrap_or(0);
    inventory_source.quantity = 1;
    next_inventory.push(inventory_source);
    sort_items(&mut next_inventory);
    next_equipped.sort_by_key(|item| item.slot);
    *inventory = next_inventory;
    *equipped = next_equipped;
    Ok((source.item_id, 1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn item(slot: u16, item_id: &str, quantity: u32) -> InventoryItem {
        InventoryItem {
            slot,
            item_id: item_id.into(),
            quantity,
            ..InventoryItem::default()
        }
    }

    #[test]
    fn category_local_move_does_not_cross_tabs() {
        let mut items = vec![item(1, "4000019", 3), item(1, "2000000", 4)];
        move_items(&mut items, 4, 1, 2, 3).unwrap();
        assert!(items
            .iter()
            .any(|item| item.item_id == "4000019" && item.slot == 2));
        assert!(items
            .iter()
            .any(|item| item.item_id == "2000000" && item.slot == 1));
    }

    #[test]
    fn move_respects_catalog_stack_max_and_add_splits() {
        let mut items = vec![item(1, "4000019", 190), item(2, "4000019", 10)];
        move_items(&mut items, 4, 1, 2, 190).unwrap();
        assert_eq!(items.iter().find(|i| i.slot == 2).unwrap().quantity, 200);
        assert!(items.iter().all(|i| i.slot != 1));

        let mut items = vec![item(1, "2041006", 90)];
        let slot = add_items(&mut items, "2041006".into(), 25).unwrap();
        assert_eq!(slot, 1);
        assert_eq!(items.iter().find(|i| i.slot == 1).unwrap().quantity, 100);
        assert_eq!(items.iter().find(|i| i.slot == 2).unwrap().quantity, 15);
    }

    #[test]
    fn gather_and_sort_compact_only_requested_tab() {
        let mut items = vec![
            item(1, "4000019", 100),
            item(4, "4000019", 100),
            item(1, "2000000", 3),
        ];
        gather_items(&mut items, 4).unwrap();
        assert_eq!(
            items
                .iter()
                .filter(|i| inventory_type(&i.item_id) == Some(4))
                .count(),
            1
        );
        assert_eq!(
            items.iter().find(|i| i.item_id == "4000019").unwrap().slot,
            1
        );
        assert_eq!(
            items.iter().find(|i| i.item_id == "2000000").unwrap().slot,
            1
        );
        items.push(item(7, "4000011", 1));
        sort_category(&mut items, 4);
        assert_eq!(
            items.iter().find(|i| i.item_id == "4000011").unwrap().slot,
            1
        );
        assert_eq!(
            items.iter().find(|i| i.item_id == "4000019").unwrap().slot,
            2
        );
    }

    #[test]
    fn potion_effect_and_equip_requirements() {
        // 紅色藥水 authors a flat 50 HP recovery in the TMS273 `spec` node.
        // Before the spec backfill this returned ItemNotUsable for every
        // potion in the catalog, so this assertion pins the data contract.
        let red = use_effect("2000000").expect("紅色藥水 must be drinkable");
        assert_eq!(red.hp, 50);
        assert_eq!(red.mp, 0);
        assert_eq!(red.cooldown_ms, None, "a plain potion has no cooldown");
        assert_eq!(use_effect("2041006"), Err(InventoryError::ItemNotUsable));

        let mut inventory = vec![item(1, "1002067", 1)];
        let mut equipped = Vec::new();
        assert_eq!(
            equip_items(
                &mut inventory,
                &mut equipped,
                EquipmentStats::default(),
                1,
                -1
            ),
            Err(InventoryError::RequirementsNotMet)
        );
        let stats = EquipmentStats {
            level: 5,
            ..EquipmentStats::default()
        };
        equip_items(&mut inventory, &mut equipped, stats, 1, -1).unwrap();
        assert!(inventory.is_empty());
        assert_eq!(
            equipped,
            vec![InventoryItem {
                slot: 1,
                item_id: "1002067".into(),
                quantity: 1,
                stats: Some(equipment_attributes("1002067")),
                remaining_slots: Some(8),
                upgrade_count: Some(0),
            }]
        );
        let expected = equipped[0].clone();
        unequip_items(&mut inventory, &mut equipped, -1, 1).unwrap();
        assert_eq!(inventory, vec![expected]);
        assert_eq!(inventory[0].slot, 1);
        assert!(equipped.is_empty());
    }

    #[test]
    fn longcoat_and_pants_share_body_slots_atomically() {
        let stats = EquipmentStats {
            level: 10,
            job: 500,
            ..EquipmentStats::default()
        };
        let instance =
            |slot: u16, item_id: &str, pdd: i64, remaining_slots: u32, upgrade_count: u32| {
                InventoryItem {
                    slot,
                    item_id: item_id.into(),
                    quantity: 1,
                    stats: Some(BTreeMap::from([(String::from("incPDD"), pdd)])),
                    remaining_slots: Some(remaining_slots),
                    upgrade_count: Some(upgrade_count),
                }
            };

        let longcoat = instance(1, "1052095", 31, 2, 4);
        let coat = instance(5, "1040002", 7, 4, 1);
        let pants = instance(6, "1060002", 9, 5, 2);
        let mut inventory = vec![longcoat.clone()];
        let mut equipped = vec![coat.clone(), pants.clone()];
        equip_items(&mut inventory, &mut equipped, stats, 1, -5).unwrap();

        assert_eq!(
            equipped
                .iter()
                .map(|item| item.item_id.as_str())
                .collect::<Vec<_>>(),
            vec!["1052095"]
        );
        assert_eq!(
            inventory.iter().find(|item| item.item_id == "1040002"),
            Some(&InventoryItem {
                slot: 1,
                ..coat.clone()
            })
        );
        assert_eq!(
            inventory.iter().find(|item| item.item_id == "1060002"),
            Some(&InventoryItem {
                slot: 2,
                ..pants.clone()
            })
        );
        assert_eq!(equipped[0].stats, longcoat.stats);

        let pants_slot = inventory
            .iter()
            .find(|item| item.item_id == "1060002")
            .unwrap()
            .slot;
        equip_items(&mut inventory, &mut equipped, stats, pants_slot as i16, -6).unwrap();
        assert_eq!(
            inventory.iter().find(|item| item.item_id == "1052095"),
            Some(&InventoryItem {
                slot: pants_slot,
                ..longcoat.clone()
            })
        );
        assert_eq!(equipped[0].item_id, "1060002");
        assert_eq!(equipped[0].stats, pants.stats);

        let mut full_inventory = vec![instance(1, "1052095", 31, 2, 4)];
        full_inventory.extend((2..=SLOT_LIMIT).map(|slot| instance(slot, "1040002", 7, 4, 1)));
        let mut full_equipped = vec![coat.clone(), pants.clone()];
        let original_inventory = full_inventory.clone();
        let original_equipped = full_equipped.clone();
        assert_eq!(
            equip_items(&mut full_inventory, &mut full_equipped, stats, 1, -5),
            Err(InventoryError::InventoryFull)
        );
        assert_eq!(full_inventory, original_inventory);
        assert_eq!(full_equipped, original_equipped);
    }
}
