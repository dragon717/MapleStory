//! Character companions: inventory owns durable identity and summon status;
//! Player holds only an instance index. This module attaches/detaches motion,
//! follows map membership and delegates pickup to the existing transaction.
use super::*;
use crate::protocol::InventoryItem;

const SEARCH_RANGE: f64 = 1000.0;

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
                serde_json::json!({
                    "id": id.to_string(), "itemId": item.item_id,
                    "name": inventory::pet_name(&item.item_id).unwrap_or_default(),
                    "inventorySlot": item.slot, "x": motion.x, "y": motion.y,
                    "facing": motion.facing, "action": motion.action,
                    "baseSpeed": motion.base_speed, "moveSpeed": motion.move_speed,
                    "mode": motion.mode,
                })
            })
            .collect(),
    )
}

impl World {
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
            let result = inventory::toggle_pet(&mut items, source_slot, item_id);
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
                                        .inventory_slots
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
