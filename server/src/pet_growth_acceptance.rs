// Pet growth checks: fullness decay, feeding, starvation retirement, lifespan
// expiry and the level table.  The world-side tests run the in-memory branch;
// the transaction layer (feed_pet/retire_pet/toggle persistence) runs against
// a temporary SQLite store like the other *_store_acceptance suites.
fn pet_growth_use_item(
    world: &mut World,
    id: &str,
    request_id: &str,
    inventory_type: u8,
    slot: i16,
    item_id: &str,
) {
    world.command(Command::Input {
        id: id.to_owned(),
        connection: format!("{id}-connection"),
        message: ClientMessage::UseItem {
            request_id: request_id.to_owned(),
            inventory_type,
            source_slot: slot,
            item_id: item_id.to_owned(),
            target_slot: None,
            target_item_id: None,
        },
    });
}

fn pet_backdate_fullness(world: &mut World, id: &str, item_id: &str, elapsed_seconds: i64) {
    let now_seconds = auth::now_ms() / 1000;
    let player = world.players.get_mut(id).unwrap();
    let row = player
        .state
        .inventory
        .iter_mut()
        .find(|item| item.item_id == item_id && inventory::pet_active(item))
        .unwrap();
    inventory::set_pet_stat(
        row,
        inventory::PET_FULLNESS_AT_KEY,
        now_seconds - elapsed_seconds,
    );
}

fn pet_row_stats(world: &World, id: &str, item_id: &str) -> BTreeMap<String, i64> {
    world.players[id]
        .state
        .inventory
        .iter()
        .find(|item| item.item_id == item_id)
        .unwrap()
        .stats
        .clone()
        .unwrap_or_default()
}

fn pet_food_quantity(world: &World, id: &str) -> u32 {
    world.players[id]
        .state
        .inventory
        .iter()
        .find(|item| inventory::is_pet_food(&item.item_id))
        .map(|item| item.quantity)
        .unwrap_or(0)
}

#[test]
fn pet_growth_snapshot_derives_fullness_weakness_and_lifespan() {
    let mut world = World::new_with_gameplay(life_map("test"), 600, Gameplay::default());
    let _alice = join_test_player(&mut world, "alice");
    pet_give(&mut world, "alice", "5000000");
    pet_use_item(&mut world, "alice", "pet-1", 1, "5000000");
    world.step_pet_growth("alice");
    let pet = pet_in_snapshot(&world, "alice").unwrap();
    assert_eq!(pet["level"], 1);
    assert_eq!(pet["fullness"], 100);
    assert_eq!(pet["closeness"], 0);
    assert_eq!(pet["closenessToNext"], 1);
    assert_eq!(pet["weak"], false);
    assert!(pet["lifeRemainingMs"].as_i64().unwrap() > 86_000_000 * 89);
    // A brand-new pet starts its 90-day source lifespan on the first summon.
    // Backdate the fullness checkpoint past the source pace (5000000 has
    // hungry=2 minutes per point): 95 elapsed points leave fullness 5, which
    // is below the weak threshold and switches the hungry display on.
    pet_backdate_fullness(&mut world, "alice", "5000000", 95 * 2 * 60);
    world.step_pet_growth("alice");
    let pet = pet_in_snapshot(&world, "alice").unwrap();
    assert_eq!(pet["fullness"], 5);
    assert_eq!(pet["weak"], true);
    assert_eq!(pet["level"], 1);
}

#[test]
fn pet_feeding_restores_fullness_and_grants_source_closeness() {
    let mut world = World::new_with_gameplay(life_map("test"), 600, Gameplay::default());
    let mut alice = join_test_player(&mut world, "alice");
    chat_send(&mut world, "alice", "give-food", "/add 2120000 5");
    pet_give(&mut world, "alice", "5000000");
    pet_use_item(&mut world, "alice", "pet-1", 1, "5000000");
    pet_backdate_fullness(&mut world, "alice", "5000000", 40 * 2 * 60);
    world.step_pet_growth("alice");
    assert_eq!(pet_in_snapshot(&world, "alice").unwrap()["fullness"], 60);
    let food_slot = world.players["alice"]
        .state
        .inventory
        .iter()
        .find(|item| inventory::is_pet_food(&item.item_id))
        .unwrap()
        .slot as i16;
    pet_growth_use_item(
        &mut world,
        "alice",
        "feed-1",
        2,
        food_slot,
        "2120000",
    );
    let results = gm_take_kind(&mut alice, "inventoryResult");
    let fed = results
        .iter()
        .find(|value| value["code"] == "pet_fed")
        .expect("feeding must succeed");
    assert_eq!(fed["success"], true);
    assert_eq!(fed["quantity"], 1);
    // Source restore: +30 fullness (60 -> 90) and +1 closeness; exactly one
    // food leaves the stack.
    let pet = pet_in_snapshot(&world, "alice").unwrap();
    assert_eq!(pet["fullness"], 90);
    assert_eq!(pet["closeness"], 1);
    assert_eq!(pet["level"], 2);
    assert_eq!(pet_food_quantity(&world, "alice"), 4);
    // Replaying the same request must neither feed twice nor spend again.
    pet_growth_use_item(&mut world, "alice", "feed-1", 2, food_slot, "2120000");
    assert_eq!(pet_food_quantity(&world, "alice"), 4);
    let pet = pet_in_snapshot(&world, "alice").unwrap();
    assert_eq!(pet["closeness"], 1);
    // Feeding without a summoned pet spends nothing and is rejected.
    pet_use_item(&mut world, "alice", "recall-all", 1, "5000000");
    assert_eq!(pets_in_snapshot(&world, "alice").len(), 0);
    pet_growth_use_item(&mut world, "alice", "feed-no-pet", 2, food_slot, "2120000");
    assert_eq!(pet_food_quantity(&world, "alice"), 4);
    assert!(gm_take_kind(&mut alice, "rejected")
        .iter()
        .any(|value| value["code"] == "pet_not_summoned"));
}

#[test]
fn pet_overfeed_costs_closeness_at_full_fullness() {
    let mut world = World::new_with_gameplay(life_map("test"), 600, Gameplay::default());
    let mut alice = join_test_player(&mut world, "alice");
    chat_send(&mut world, "alice", "give-food", "/add 2120000 3");
    pet_give(&mut world, "alice", "5000000");
    pet_use_item(&mut world, "alice", "pet-1", 1, "5000000");
    // A freshly summoned pet sits at fullness 100 with closeness 0; feeding
    // it is the classic overfeed: closeness -1, fullness unchanged.
    let food_slot = world.players["alice"]
        .state
        .inventory
        .iter()
        .find(|item| inventory::is_pet_food(&item.item_id))
        .unwrap()
        .slot as i16;
    pet_growth_use_item(&mut world, "alice", "feed-full", 2, food_slot, "2120000");
    let pet = pet_in_snapshot(&world, "alice").unwrap();
    assert_eq!(pet["fullness"], 100);
    assert_eq!(pet["closeness"], 0);
    assert_eq!(pet_food_quantity(&world, "alice"), 2);
    assert!(gm_take_kind(&mut alice, "inventoryResult")
        .iter()
        .any(|value| value["code"] == "pet_fed"));
}

#[test]
fn pet_starvation_returns_the_pet_to_the_bag_with_penalty() {
    let mut world = World::new_with_gameplay(life_map("test"), 600, Gameplay::default());
    let _alice = join_test_player(&mut world, "alice");
    pet_give(&mut world, "alice", "5000000");
    pet_use_item(&mut world, "alice", "pet-1", 1, "5000000");
    world.step_pet("alice");
    // Drive the pet across the starvation boundary for real: a stored
    // checkpoint of 2 with two paces elapsed (5000000 = 2 minutes per point)
    // displays 0, and the sweep must retire the pet (active bit off) and
    // take one point of closeness.  A pet whose stored checkpoint is already
    // 0 never retires — it stays summoned and hungry until fed (covered by
    // the zero-checkpoint test below).
    let player = world.players.get_mut("alice").unwrap();
    let row = player
        .state
        .inventory
        .iter_mut()
        .find(|item| item.item_id == "5000000")
        .unwrap();
    inventory::set_pet_fullness(row, 2, auth::now_ms() / 1000 - 2 * 120);
    inventory::add_pet_closeness(row, 3);
    world.step_pet_growth("alice");
    assert!(pet_in_snapshot(&world, "alice").is_none());
    let stats = pet_row_stats(&world, "alice", "5000000");
    assert_eq!(stats.get(inventory::PET_ACTIVE_KEY), Some(&0));
    assert_eq!(stats.get(inventory::PET_CLOSENESS_KEY), Some(&2));
    // The bagged pet keeps its identity and can be summoned again.
    pet_use_item(&mut world, "alice", "pet-1-again", 1, "5000000");
    assert_eq!(pets_in_snapshot(&world, "alice").len(), 1);
}

#[test]
fn pet_lifespan_expiry_reverts_the_pet_to_a_dead_doll() {
    let mut world = World::new_with_gameplay(life_map("test"), 600, Gameplay::default());
    let mut alice = join_test_player(&mut world, "alice");
    pet_give(&mut world, "alice", "5000000");
    pet_use_item(&mut world, "alice", "pet-1", 1, "5000000");
    let player = world.players.get_mut("alice").unwrap();
    let row = player
        .state
        .inventory
        .iter_mut()
        .find(|item| item.item_id == "5000000")
        .unwrap();
    inventory::set_pet_stat(
        row,
        inventory::PET_LIFESPAN_END_KEY,
        auth::now_ms() / 1000 - 5,
    );
    world.step_pet_growth("alice");
    assert!(pet_in_snapshot(&world, "alice").is_none());
    let stats = pet_row_stats(&world, "alice", "5000000");
    assert_eq!(stats.get(inventory::PET_DEAD_KEY), Some(&1));
    assert_eq!(stats.get(inventory::PET_ACTIVE_KEY), Some(&0));
    // A dead doll cannot be summoned again; 生命水 revival is a later module.
    pet_use_item(&mut world, "alice", "pet-dead-summon", 1, "5000000");
    assert_eq!(pets_in_snapshot(&world, "alice").len(), 0);
    let results = gm_take_kind(&mut alice, "inventoryResult");
    assert!(results
        .iter()
        .any(|value| value["success"] == false && value["code"] == "pet_dead"));
}

#[test]
fn pet_level_table_matches_the_source_boundaries() {
    // P: cross-version cumulative closeness table; the boundaries below are
    // the pinned levels 1/2/3/10/11/29/30 of the 52pk pet handbook.
    assert_eq!(inventory::pet_level(0), 1);
    assert_eq!(inventory::pet_level(1), 2);
    assert_eq!(inventory::pet_level(2), 2);
    assert_eq!(inventory::pet_level(3), 3);
    assert_eq!(inventory::pet_level(286), 9);
    assert_eq!(inventory::pet_level(287), 10);
    assert_eq!(inventory::pet_level(433), 10);
    assert_eq!(inventory::pet_level(434), 11);
    assert_eq!(inventory::pet_level(631), 11);
    assert_eq!(inventory::pet_level(26099), 28);
    assert_eq!(inventory::pet_level(26100), 29);
    assert_eq!(inventory::pet_level(29999), 29);
    assert_eq!(inventory::pet_level(30000), 30);
    assert_eq!(inventory::pet_closeness_to_next(0), 1);
    assert_eq!(inventory::pet_closeness_to_next(631), 1);
    assert_eq!(inventory::pet_closeness_to_next(30000), 0);
    // Closeness accrual is clamped to the level-30 ceiling.
    let mut world = World::new_with_gameplay(life_map("test"), 600, Gameplay::default());
    let _alice = join_test_player(&mut world, "alice");
    pet_give(&mut world, "alice", "5000000");
    let player = world.players.get_mut("alice").unwrap();
    let row = player
        .state
        .inventory
        .iter_mut()
        .find(|item| item.item_id == "5000000")
        .unwrap();
    inventory::add_pet_closeness(row, 99_999);
    assert_eq!(inventory::pet_closeness(row), 30_000);
}

#[test]
fn pet_hunger_freezes_while_the_pet_waits_in_the_bag() {
    let mut world = World::new_with_gameplay(life_map("test"), 600, Gameplay::default());
    let _alice = join_test_player(&mut world, "alice");
    pet_give(&mut world, "alice", "5000000");
    // Summon and burn 40 points of fullness (hungry=2 minutes per point).
    pet_use_item(&mut world, "alice", "pet-1", 1, "5000000");
    pet_backdate_fullness(&mut world, "alice", "5000000", 40 * 2 * 60);
    world.step_pet_growth("alice");
    assert_eq!(pet_in_snapshot(&world, "alice").unwrap()["fullness"], 60);
    // Recall, then let a long bag period pass on the checkpoint clock.
    pet_use_item(&mut world, "alice", "recall-1", 1, "5000000");
    assert_eq!(pets_in_snapshot(&world, "alice").len(), 0);
    let player = world.players.get_mut("alice").unwrap();
    let row = player
        .state
        .inventory
        .iter_mut()
        .find(|item| item.item_id == "5000000")
        .unwrap();
    inventory::set_pet_stat(
        row,
        inventory::PET_FULLNESS_AT_KEY,
        auth::now_ms() / 1000 - 90 * 60,
    );
    // Re-summoning must resume from the frozen bag value (60), never from a
    // derived value that charged the bag time as hunger.
    pet_use_item(&mut world, "alice", "pet-1-again", 1, "5000000");
    world.step_pet_growth("alice");
    assert_eq!(pet_in_snapshot(&world, "alice").unwrap()["fullness"], 60);
    let stats = pet_row_stats(&world, "alice", "5000000");
    assert_eq!(stats.get(inventory::PET_ACTIVE_KEY), Some(&1));
}

#[test]
fn pet_growth_store_feed_retire_and_dead_gate_persist() {
    fn growth_defaults() -> Profile {
        Profile {
            hp: 50, max_hp: 50, mp: 5, max_mp: 5, level: 1, job: 0,
            exp: 0, exp_to_next: 15, mesos: 0, death_id: String::new(),
            cash: 0,
            map_id: String::new(), x: 0.0, y: 0.0, inventory: Vec::new(),
            skills: BTreeMap::new(), skill_points: BTreeMap::new(),
            ability_stats: AbilityStats::default(),
        }
    }
    let path =
        std::env::temp_dir().join(format!("pet-growth-store-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).unwrap();
    let store = service.store.clone();
    let defaults = growth_defaults();
    // The account row must exist before any inventory transaction lands.
    store.load_profile("pg", &defaults).unwrap();
    assert!(store
        .grant_inventory_item("pg", "grant-pet", "5000000", 1)
        .unwrap()
        .success);
    assert!(store
        .grant_inventory_item("pg", "grant-food", "2120000", 5)
        .unwrap()
        .success);
    let inventory = store.load_profile("pg", &defaults).unwrap().inventory;
    let pet = inventory
        .iter()
        .find(|item| item.item_id == "5000000")
        .unwrap()
        .clone();
    let food = inventory
        .iter()
        .find(|item| inventory::is_pet_food(&item.item_id))
        .unwrap()
        .clone();
    // Feeding without a summoned pet spends nothing.
    let refused = store.feed_pet("pg", "feed-refused", food.slot as i16, "2120000").unwrap();
    assert!(!refused.success);
    assert_eq!(refused.code, "pet_not_summoned");
    assert_eq!(
        store.load_profile("pg", &defaults).unwrap().inventory
            .iter()
            .find(|item| inventory::is_pet_food(&item.item_id))
            .unwrap()
            .quantity,
        5
    );
    // Summon through the store, then feed: the overfeed branch costs one
    // closeness (the fresh pet starts full) and one food, durably.
    assert!(store
        .toggle_pet("pg", "summon-1", pet.slot as i16, "5000000")
        .unwrap()
        .success);
    let fed = store
        .feed_pet("pg", "feed-1", food.slot as i16, "2120000")
        .unwrap();
    assert!(fed.success);
    assert_eq!(fed.code, "pet_fed");
    let replay = store
        .feed_pet("pg", "feed-1", food.slot as i16, "2120000")
        .unwrap();
    assert_eq!(replay.quantity, 1);
    let inventory = store.load_profile("pg", &defaults).unwrap().inventory;
    let pet_row = inventory
        .iter()
        .find(|item| item.item_id == "5000000")
        .unwrap();
    assert_eq!(inventory::pet_closeness(pet_row), 0);
    assert_eq!(inventory::pet_fullness(pet_row, auth::now_ms() / 1000), 100);
    assert_eq!(
        inventory
            .iter()
            .find(|item| inventory::is_pet_food(&item.item_id))
            .unwrap()
            .quantity,
        4
    );
    // Hunger retirement persists the active bit and the closeness penalty.
    let retired = store
        .retire_pet("pg", "retire-1", pet.slot as i16, "5000000", false)
        .unwrap();
    assert!(retired.success);
    assert_eq!(retired.code, "pet_starved");
    let inventory = store.load_profile("pg", &defaults).unwrap().inventory;
    let pet_row = inventory
        .iter()
        .find(|item| item.item_id == "5000000")
        .unwrap();
    assert!(!inventory::pet_active(pet_row));
    // Expiry marks the doll dead; the store then refuses every summon.
    assert!(store
        .toggle_pet("pg", "summon-2", pet.slot as i16, "5000000")
        .unwrap()
        .success);
    let expired = store
        .retire_pet("pg", "retire-2", pet.slot as i16, "5000000", true)
        .unwrap();
    assert_eq!(expired.code, "pet_expired");
    let dead = store
        .toggle_pet("pg", "summon-dead", pet.slot as i16, "5000000")
        .unwrap();
    assert!(!dead.success);
    assert_eq!(dead.code, "pet_dead");
    drop(store);
    drop(service);
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
}

#[test]
fn pet_summoned_at_zero_checkpoint_stays_summoned_and_hungry() {
    let mut world = World::new_with_gameplay(life_map("test"), 600, Gameplay::default());
    let _alice = join_test_player(&mut world, "alice");
    pet_give(&mut world, "alice", "5000000");
    pet_use_item(&mut world, "alice", "pet-1", 1, "5000000");
    // A pet saved with an empty stored checkpoint (starved while its owner
    // was away, then frozen by the departure/logout freeze) must summon and
    // stay summoned: every tick used to bounce it straight back into the
    // bag with a closeness penalty, so the summon status never held.
    let player = world.players.get_mut("alice").unwrap();
    let row = player
        .state
        .inventory
        .iter_mut()
        .find(|item| item.item_id == "5000000")
        .unwrap();
    inventory::set_pet_fullness(row, 0, auth::now_ms() / 1000 - 600);
    world.step_pet_growth("alice");
    world.step_pet_growth("alice");
    let pet = pet_in_snapshot(&world, "alice").unwrap();
    assert_eq!(pet["fullness"], 0);
    assert_eq!(pet["weak"], true);
    let stats = pet_row_stats(&world, "alice", "5000000");
    assert_eq!(stats.get(inventory::PET_ACTIVE_KEY), Some(&1));
    let player = world.players.get("alice").unwrap();
    let row = player
        .state
        .inventory
        .iter()
        .find(|item| item.item_id == "5000000")
        .unwrap();
    assert_eq!(inventory::pet_closeness(row), 0);
}

#[test]
fn pet_summon_status_and_fullness_survive_logout_login_cycle() {
    fn cycle_defaults() -> Profile {
        Profile {
            hp: 50, max_hp: 50, mp: 5, max_mp: 5, level: 1, job: 0,
            exp: 0, exp_to_next: 15, mesos: 0, death_id: String::new(),
            cash: 0,
            map_id: String::new(), x: 0.0, y: 0.0, inventory: Vec::new(),
            skills: BTreeMap::new(), skill_points: BTreeMap::new(),
            ability_stats: AbilityStats::default(),
        }
    }
    let path = std::env::temp_dir()
        .join(format!("pet-growth-logout-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).unwrap();
    let mut world = World::new_with_store(
        life_map("test"),
        600,
        Gameplay::default(),
        service.store.clone(),
    )
    .unwrap();
    let _alice = join_test_player(&mut world, "alice");
    pet_give(&mut world, "alice", "5000000");
    pet_use_item(&mut world, "alice", "pet-1", 1, "5000000");
    let pet_anchor = |service: &auth::AuthService| -> (i64, i64, bool) {
        let defaults = cycle_defaults();
        let row = service
            .store
            .load_profile("alice", &defaults)
            .unwrap()
            .inventory
            .into_iter()
            .find(|item| item.item_id == "5000000")
            .unwrap();
        let at = row
            .stats
            .as_ref()
            .and_then(|stats| stats.get(inventory::PET_FULLNESS_AT_KEY))
            .copied()
            .unwrap_or(0);
        (at, inventory::pet_stored_fullness(&row), inventory::pet_active(&row))
    };
    let anchor_after_summon = pet_anchor(&service);

    // Two seconds of wall clock: enough to move the unix-second hunger
    // anchor so the departure freeze is observable, far too little to burn
    // a fullness point (5000000 = 2 minutes per point).
    std::thread::sleep(std::time::Duration::from_secs(2));

    // Explicit logout: the summon status freezes into the checkpoint on the
    // way out — the stored anchor must move past the summon-time anchor.
    world.command(Command::Input {
        id: "alice".to_owned(),
        connection: "alice-connection".to_owned(),
        message: ClientMessage::Logout,
    });
    assert!(world.players.get("alice").is_none());
    let (frozen_at, frozen_stored, frozen_active) = pet_anchor(&service);
    assert!(frozen_at > anchor_after_summon.0);
    assert_eq!(frozen_stored, 100);
    assert!(frozen_active);

    // Logging back in: the anchor rebases to now, so the offline gap is
    // exempt and the pet returns summoned at exactly the frozen fullness.
    let _alice_again = join_test_player(&mut world, "alice");
    let pet = pet_in_snapshot(&world, "alice").unwrap();
    assert_eq!(pet["fullness"], 100);
    assert_eq!(pet["weak"], false);
    let stats = pet_row_stats(&world, "alice", "5000000");
    assert_eq!(stats.get(inventory::PET_ACTIVE_KEY), Some(&1));

    drop(world);
    drop(service);
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
}
