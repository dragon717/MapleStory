//! Character companions: inventory owns durable identity and summon status;
//! Player holds only an instance index. This module attaches/detaches motion,
//! follows map membership and delegates pickup to the existing transaction.
use super::*;
use crate::protocol::InventoryItem;

const SEARCH_RANGE: f64 = 1000.0;

/// Tick backoff between natural-retirement attempts after a persistence
/// failure.  Successful retirement reloads the inventory, which removes the
/// pet from `active_items` and ends the sweep for that instance.
const PET_GROWTH_RETRY_TICKS: u64 = 60;

#[derive(Clone)]
pub(super) struct PetRuntime {
    map_id: String,
    motion: pet_motion::PetMotion,
    target_drop: Option<String>,
}

fn active_items(player: &Player) -> impl Iterator<Item = (&InventoryItem, i64)> {
    player
        .state
        .inventory
        .iter()
        .filter_map(|item| {
            inventory::pet_active(item)
                .then(|| inventory::pet_instance_id(item).map(|id| (item, id)))
                .flatten()
        })
        .take(inventory::MAX_ACTIVE_PETS)
}

// ponytail: source-name breed heuristic; replace with catalog movement traits
// when unnamed or ambiguous dog-like pets need explicit behavior.
fn is_dog(item: &InventoryItem) -> bool {
    inventory::pet_name(&item.item_id).is_some_and(|name| {
        ["狗", "犬", "狼", "哈士奇", "柯基"]
            .iter()
            .any(|word| name.contains(word))
    })
}

fn new_runtime(player: &Player, id: i64) -> PetRuntime {
    // P: the TMS273 pet info examined has no movement-speed field. Each
    // durable instance gets a stable 120..180 pace; dog-like names lead.
    let base_speed = 120.0 + id.rem_euclid(61) as f64;
    PetRuntime {
        map_id: player.map_id.clone(),
        target_drop: None,
        motion: pet_motion::PetMotion::new(
            player.state.x,
            player.state.y,
            player.state.facing,
            base_speed,
            id as u64,
        ),
    }
}

/// Derive the display from current inventory even before the next simulation
/// tick. A map transfer never exposes a previous map's pet coordinates.
pub(super) fn snapshots(player: &Player) -> serde_json::Value {
    let now_seconds = auth::now_ms() / 1000;
    serde_json::Value::Array(
        active_items(player)
            .map(|(item, id)| {
                let fallback;
                let runtime = match player
                    .pets
                    .get(&id)
                    .filter(|pet| pet.map_id == player.map_id)
                {
                    Some(pet) => pet,
                    None => {
                        fallback = new_runtime(player, id);
                        &fallback
                    }
                };
                let motion = &runtime.motion;
                let fullness = inventory::pet_fullness(item, now_seconds);
                let closeness = inventory::pet_closeness(item);
                let life_remaining_ms = inventory::pet_lifespan_end(item)
                    .map(|end| (end - now_seconds).max(0) * 1000);
                serde_json::json!({
                    "id": id.to_string(), "itemId": item.item_id,
                    "name": inventory::pet_name(&item.item_id).unwrap_or_default(),
                    "inventorySlot": item.slot, "x": motion.x, "y": motion.y,
                    "facing": motion.facing, "action": motion.action,
                    "baseSpeed": motion.base_speed, "moveSpeed": motion.move_speed,
                    "mode": motion.mode,
                    "level": inventory::pet_level(closeness),
                    "fullness": fullness,
                    "closeness": closeness,
                    "closenessToNext": inventory::pet_closeness_to_next(closeness),
                    "weak": fullness <= inventory::PET_WEAK_FULLNESS,
                    "lifeRemainingMs": life_remaining_ms,
                })
            })
            .collect(),
    )
}

impl World {
    /// Feed one pet food (`2120000`) to the lead summoned pet.  The food and
    /// the pet's growth stats move in the same durable transaction; feeding
    /// without a summoned pet spends nothing and answers with a rejection.
    pub(super) fn feed_pet(
        &mut self,
        id: &str,
        request_id: &str,
        inventory_type: u8,
        source_slot: i16,
        item_id: &str,
    ) {
        if inventory_type != 2 || !inventory::is_pet_food(item_id) {
            return;
        }
        let Some(player) = self.players.get(id) else {
            return;
        };
        if active_items(player).next().is_none() {
            let _ = player.output.try_send(reject(
                "pet_not_summoned",
                pet_feed_reject_message("pet_not_summoned", player.lang),
                Some(request_id),
            ));
            return;
        }
        let outcome = if let Some(store) = self.store.clone() {
            match store.feed_pet(id, request_id, source_slot, item_id) {
                Ok(outcome) => {
                    if outcome.success {
                        match store.load_profile(id, &self.default_profile()) {
                            Ok(profile) => {
                                if let Some(player) = self.players.get_mut(id) {
                                    player.state.inventory = profile.inventory;
                                }
                            }
                            Err(error) => {
                                self.send_reject(id, "persistence", &error, Some(request_id));
                                return;
                            }
                        }
                    }
                    outcome
                }
                Err(error) => {
                    self.send_reject(id, "persistence", &error, Some(request_id));
                    return;
                }
            }
        } else {
            let key = (id.to_owned(), request_id.to_owned());
            if let Some(prior) = self.inventory_requests.get(&key) {
                if prior.operation == "use"
                    && prior.inventory_type == Some(2)
                    && prior.item_id == item_id
                    && prior.from_slot == source_slot
                {
                    self.send_inventory_outcome(id, prior);
                } else {
                    self.send_inventory_conflict(id, request_id);
                }
                return;
            }
            let now_seconds = auth::now_ms() / 1000;
            let mut items = player.state.inventory.clone();
            let food_index = items.iter().position(|row| {
                row.slot == u16::try_from(source_slot).unwrap_or(0)
                    && row.item_id == item_id
                    && inventory::inventory_type(&row.item_id) == Some(2)
            });
            let lead_pet_slot = items
                .iter()
                .filter(|row| inventory::pet_active(row))
                .map(|row| row.slot)
                .min();
            let (success, code) = match (food_index, lead_pet_slot) {
                (Some(food_index), Some(_)) => {
                    // The pet lookup is gated on the active bit so a use-tab
                    // row sharing the slot number can never be mistaken for
                    // the companion (same rule as the store branch).
                    let pet_index = items
                        .iter()
                        .position(|row| {
                            row.slot == lead_pet_slot.unwrap() && inventory::pet_active(row)
                        })
                        .unwrap_or_default();
                    let fullness = inventory::pet_fullness(&items[pet_index], now_seconds);
                    let (delta_fullness, delta_closeness) =
                        if fullness >= inventory::PET_FULLNESS_MAX {
                            (0, -1)
                        } else {
                            (
                                inventory::pet_food_fullness(item_id),
                                inventory::pet_food_closeness(item_id),
                            )
                        };
                    inventory::set_pet_fullness(
                        &mut items[pet_index],
                        (fullness + delta_fullness).min(inventory::PET_FULLNESS_MAX),
                        now_seconds,
                    );
                    inventory::add_pet_closeness(&mut items[pet_index], delta_closeness);
                    let row = &mut items[food_index];
                    row.quantity = row.quantity.saturating_sub(1);
                    if row.quantity == 0 {
                        items.remove(food_index);
                    }
                    (true, "pet_fed".to_owned())
                }
                (Some(_), None) => (false, "pet_not_summoned".to_owned()),
                (None, _) => (false, "source_empty".to_owned()),
            };
            let outcome = auth::InventoryOutcome {
                request_id: request_id.to_owned(),
                operation: "use".to_owned(),
                inventory_type: Some(2),
                from_slot: source_slot,
                to_slot: None,
                item_id: item_id.to_owned(),
                quantity: if success { 1 } else { 0 },
                drop_id: None,
                success,
                code,
            };
            if outcome.success {
                self.players.get_mut(id).unwrap().state.inventory = items;
            }
            self.inventory_requests.insert(key, outcome.clone());
            outcome
        };
        self.send_inventory_outcome(id, &outcome);
        if outcome.success {
            self.send_snapshot(id);
        }
    }

    pub(super) fn pet_toggle(
        &mut self,
        id: &str,
        request_id: &str,
        inventory_type: u8,
        source_slot: i16,
        item_id: &str,
    ) {
        if inventory_type != 5 {
            return;
        }
        let Some(player) = self.players.get(id) else {
            return;
        };
        let outcome = if let Some(store) = self.store.clone() {
            match store.toggle_pet(id, request_id, source_slot, item_id) {
                Ok(outcome) => {
                    // Reload after the transaction, including a replay. Do not
                    // mutate the live companion before the durable commit.
                    match store.load_profile(id, &self.default_profile()) {
                        Ok(profile) => {
                            if let Some(player) = self.players.get_mut(id) {
                                player.state.inventory = profile.inventory;
                            }
                        }
                        Err(error) => {
                            self.send_reject(id, "persistence", &error, Some(request_id));
                            return;
                        }
                    }
                    outcome
                }
                Err(error) => {
                    self.send_reject(id, "persistence", &error, Some(request_id));
                    return;
                }
            }
        } else {
            let key = (id.to_owned(), request_id.to_owned());
            if let Some(prior) = self.inventory_requests.get(&key) {
                if prior.operation == "use"
                    && prior.inventory_type == Some(5)
                    && prior.item_id == item_id
                    && prior.from_slot == source_slot
                {
                    self.send_inventory_outcome(id, prior);
                } else {
                    self.send_inventory_conflict(id, request_id);
                }
                return;
            }
            let mut items = player.state.inventory.clone();
            let result = inventory::toggle_pet(
                &mut items,
                source_slot,
                item_id,
                auth::now_ms() / 1000,
            );
            let outcome = auth::InventoryOutcome {
                request_id: request_id.to_owned(),
                operation: "use".to_owned(),
                inventory_type: Some(5),
                from_slot: source_slot,
                to_slot: None,
                item_id: item_id.to_owned(),
                quantity: 1,
                drop_id: None,
                success: result.is_ok(),
                code: result
                    .map(|()| "pet_toggled".to_owned())
                    .unwrap_or_else(|error| error.to_string()),
            };
            if outcome.success {
                self.players.get_mut(id).unwrap().state.inventory = items;
            }
            self.inventory_requests.insert(key, outcome.clone());
            outcome
        };
        if outcome.operation != "use"
            || outcome.inventory_type != Some(5)
            || outcome.item_id != item_id
            || outcome.from_slot != source_slot
        {
            self.send_inventory_conflict(id, request_id);
            return;
        }
        self.send_inventory_outcome(id, &outcome);
        self.send_snapshot(id);
    }

    pub(super) fn step_pet(&mut self, id: &str) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let Some(map) = self.maps.get(&player.map_id) else {
            return;
        };
        let desired: Vec<_> = active_items(player)
            .map(|(item, id)| (item.clone(), id))
            .collect();
        let now = auth::now_ms();
        let mut targets = BTreeMap::new();
        let mut reserved = BTreeSet::new();
        if player.state.hp > 0 {
            for (_, pet_id) in &desired {
                let fallback = new_runtime(player, *pet_id);
                let runtime = player
                    .pets
                    .get(pet_id)
                    .filter(|pet| pet.map_id == player.map_id)
                    .unwrap_or(&fallback);
                let motion = &runtime.motion;
                // ponytail: at most 3 linear drop scans per owner; add a spatial
                // index only if measured drop counts make this tick expensive.
                let target = self
                    .drops
                    .iter()
                    .filter(|(drop_id, drop)| {
                        if reserved.contains(*drop_id)
                            || (drop.x - motion.x).hypot(drop.y - motion.y) > SEARCH_RANGE
                            || (drop.x - player.state.x).hypot(drop.y - player.state.y)
                                > SEARCH_RANGE
                        {
                            return false;
                        }
                        let kind = inventory::inventory_type(&drop.item_id).unwrap_or(4);
                        // Search checks the same availability/capacity rules, at
                        // the prospective destination. Actual pickup rechecks range.
                        matches!(
                            pickup_rules::evaluate_pickup(&pickup_rules::PickupFacts {
                                player_id: id,
                                player_x: drop.x,
                                player_y: drop.y,
                                now_ms: now,
                                map_id: &player.map_id,
                                drop: pickup_rules::PickupDropView {
                                    item_id: &drop.item_id,
                                    quantity: drop.quantity,
                                    x: drop.x,
                                    y: drop.y
                                },
                                drop_map: self.drop_maps.get(*drop_id).map(String::as_str),
                                drop_owner: self.drop_owners.get(*drop_id),
                                memory_capacity: Some(pickup_rules::CapacityProbe {
                                    inventory: &player.state.inventory,
                                    slot_limit: player
                                        .state.inventory_slots
                                        .get(&kind)
                                        .copied()
                                        .unwrap_or(inventory::SLOT_LIMIT),
                                    stats: self
                                        .drop_instances
                                        .get(*drop_id)
                                        .and_then(|v| v.stats.as_ref()),
                                    remaining_slots: self
                                        .drop_instances
                                        .get(*drop_id)
                                        .and_then(|v| v.remaining_slots),
                                    upgrade_count: self
                                        .drop_instances
                                        .get(*drop_id)
                                        .and_then(|v| v.upgrade_count),
                                }),
                            }),
                            pickup_rules::PickupVerdict::Allowed
                        )
                    })
                    .min_by(|(_, a), (_, b)| {
                        (a.x - motion.x)
                            .hypot(a.y - motion.y)
                            .total_cmp(&(b.x - motion.x).hypot(b.y - motion.y))
                    });
                if let Some((drop_id, drop)) = target {
                    reserved.insert(drop_id.clone());
                    targets.insert(*pet_id, (drop_id.clone(), drop.x, drop.y));
                }
            }
        }
        let new_pets: Vec<_> = desired
            .iter()
            .map(|(_, pet_id)| (*pet_id, new_runtime(player, *pet_id)))
            .collect();
        let player = self.players.get_mut(id).unwrap();
        player
            .pets
            .retain(|pet_id, _| desired.iter().any(|(_, id)| id == pet_id));
        for (index, ((item, pet_id), (_, fallback))) in desired.iter().zip(new_pets).enumerate() {
            let runtime = player
                .pets
                .entry(*pet_id)
                .or_insert_with(|| fallback.clone());
            if runtime.map_id != player.map_id {
                *runtime = fallback;
            }
            runtime.target_drop = targets.get(pet_id).map(|(id, _, _)| id.clone());
            runtime.motion.step(
                map,
                player.state.x,
                player.state.y,
                player.state.facing,
                player.state.vx.abs() > 0.1,
                is_dog(item),
                index,
                targets.get(pet_id).map(|(_, x, y)| (*x, *y)),
                self.tick,
            );
        }
    }

    /// Natural growth sweep: hunger reaching zero returns the pet to the bag
    /// with a closeness penalty (GMS: it "loses closeness and returns to the
    /// inventory on its own"), and a lapsed source lifespan reverts it to a
    /// dead doll.  Displayed fullness is derived per snapshot, so this only
    /// runs when a pet actually crosses a retirement boundary; a failed
    /// persistence backs off instead of retrying on every tick.
    pub(super) fn step_pet_growth(&mut self, id: &str) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        if self.tick < player.pet_growth_next_tick {
            return;
        }
        let now_seconds = auth::now_ms() / 1000;
        let retiring: Vec<(i64, u16, String, bool)> = active_items(player)
            .filter_map(|(item, instance)| {
                let expired = inventory::pet_lifespan_end(item)
                    .is_some_and(|end| end <= now_seconds);
                let starved = inventory::pet_fullness(item, now_seconds) <= 0;
                (expired || starved)
                    .then(|| (instance, item.slot, item.item_id.clone(), expired))
            })
            .collect();
        if retiring.is_empty() {
            return;
        }
        let player = self.players.get_mut(id).unwrap();
        player.pet_growth_next_tick = self.tick.saturating_add(PET_GROWTH_RETRY_TICKS);
        for (instance, slot, item_id, expired) in retiring {
            let request_id = format!(
                "pet-growth-{instance}-{}-{}",
                if expired { "expired" } else { "starved" },
                now_seconds / 3600
            );
            if let Some(store) = self.store.clone() {
                match store.retire_pet(
                    id,
                    &request_id,
                    i16::try_from(slot).unwrap_or(0),
                    &item_id,
                    expired,
                ) {
                    Ok(outcome) if outcome.success => {
                        match store.load_profile(id, &self.default_profile()) {
                            Ok(profile) => {
                                if let Some(player) = self.players.get_mut(id) {
                                    player.state.inventory = profile.inventory;
                                }
                            }
                            Err(error) => {
                                self.send_reject(id, "persistence", &error, None);
                                return;
                            }
                        }
                        self.send_snapshot(id);
                    }
                    Ok(_) => {} // retry after the backoff boundary
                    Err(error) => {
                        self.send_reject(id, "persistence", &error, None);
                        return;
                    }
                }
            } else {
                // In-memory branch (acceptance/worlds without a store).
                let Some(player) = self.players.get_mut(id) else {
                    return;
                };
                let Some(index) = player.state.inventory.iter().position(|item| {
                    item.slot == slot
                        && item.item_id == item_id
                        && inventory::pet_active(item)
                }) else {
                    continue;
                };
                let fullness =
                    inventory::pet_fullness(&player.state.inventory[index], now_seconds);
                inventory::set_pet_fullness(
                    &mut player.state.inventory[index],
                    fullness,
                    now_seconds,
                );
                if expired {
                    inventory::set_pet_stat(
                        &mut player.state.inventory[index],
                        inventory::PET_DEAD_KEY,
                        1,
                    );
                } else {
                    inventory::add_pet_closeness(&mut player.state.inventory[index], -1);
                }
                let stats = player.state.inventory[index]
                    .stats
                    .get_or_insert_with(BTreeMap::new);
                stats.insert(inventory::PET_ACTIVE_KEY.to_owned(), 0);
                self.send_snapshot(id);
            }
        }
    }

    pub(super) fn step_pet_pickups(&mut self) {
        let mut claims = Vec::new();
        for (id, player) in &self.players {
            if player.state.hp <= 0 {
                continue;
            }
            for runtime in player
                .pets
                .values()
                .filter(|pet| pet.map_id == player.map_id)
            {
                let pet = &runtime.motion;
                if pet.mode != "loot" {
                    continue;
                }
                if let Some((drop_id, drop)) = runtime
                    .target_drop
                    .as_ref()
                    .and_then(|drop_id| self.drops.get(drop_id).map(|drop| (drop_id, drop)))
                {
                    if (drop.x - pet.x).abs() <= pickup_rules::PICKUP_RANGE
                        && (drop.y - pet.y).abs() <= pickup_rules::PICKUP_RANGE
                    {
                        claims.push((id.clone(), drop_id.clone(), pet.x, pet.y));
                    }
                }
            }
        }
        for (index, (id, drop_id, x, y)) in claims.into_iter().enumerate() {
            let request_id = format!("petpickup-{drop_id}-{}-{index}", self.tick);
            self.handle_pet_pickup(id, request_id, drop_id, x, y);
        }
    }
}

/// Localized rejection text for the feeding flow.  The food is never spent on
/// a rejected use, so every message states that the pet must be out first.
fn pet_feed_reject_message(code: &str, lang: &'static str) -> &'static str {
    let (zh, en) = match code {
        "pet_not_summoned" => (
            "请先召唤一只宠物，寵物食品未被消耗。",
            "Summon a pet first; the pet food was not consumed.",
        ),
        _ => (
            "无法使用寵物食品。",
            "The pet food could not be used.",
        ),
    };
    if lang == crate::quest_text::LANG_EN {
        en
    } else {
        zh
    }
}
