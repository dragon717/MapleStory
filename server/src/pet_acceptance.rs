// Companion integration checks: authoritative inventory -> summon -> map -> pickup.
fn pet_use_item(world: &mut World, id: &str, request_id: &str, slot: i16, item_id: &str) {
    world.command(Command::Input {
        id: id.to_owned(),
        connection: format!("{id}-connection"),
        message: ClientMessage::UseItem {
            request_id: request_id.to_owned(),
            inventory_type: 5,
            source_slot: slot,
            item_id: item_id.to_owned(),
            target_slot: None,
            target_item_id: None,
        },
    });
}

fn pet_give(world: &mut World, id: &str, item_id: &str) {
    chat_send(
        world,
        id,
        &format!("give-{}", auth::random_id()),
        &format!("/add {item_id} 1"),
    );
}

fn pets_in_snapshot(world: &World, observer: &str) -> Vec<Value> {
    let snapshot: Value = serde_json::from_str(&world.snapshot(observer)).unwrap();
    snapshot["players"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == observer)
        .unwrap()["pets"]
        .as_array()
        .unwrap()
        .clone()
}

fn pet_in_snapshot(world: &World, observer: &str) -> Option<Value> {
    pets_in_snapshot(world, observer).into_iter().next()
}

#[test]
fn pet_same_species_instances_limit_replay_recall_and_forgery() {
    let mut world = World::new_with_gameplay(life_map("test"), 600, Gameplay::default());
    let mut alice = join_test_player(&mut world, "alice");
    chat_drain(&mut alice);
    chat_send(&mut world, "alice", "give-four", "/add 5000000 4");
    for slot in 1..=3 {
        pet_use_item(
            &mut world,
            "alice",
            &format!("summon-{slot}"),
            slot,
            "5000000",
        );
    }
    let pets = pets_in_snapshot(&world, "alice");
    assert_eq!(pets.len(), 3);
    assert_eq!(
        pets.iter()
            .map(|pet| pet["id"].as_str().unwrap())
            .collect::<BTreeSet<_>>()
            .len(),
        3
    );
    pet_use_item(&mut world, "alice", "summon-four", 4, "5000000");
    assert_eq!(pets_in_snapshot(&world, "alice").len(), 3);
    let results = gm_take_kind(&mut alice, "inventoryResult");
    assert!(results.iter().any(|value| value["code"] == "pet_limit"));
    // Same request must not toggle a second time.
    pet_use_item(&mut world, "alice", "summon-1", 1, "5000000");
    assert_eq!(pets_in_snapshot(&world, "alice").len(), 3);
    pet_use_item(&mut world, "alice", "forged", 1, "5000021");
    assert_eq!(pets_in_snapshot(&world, "alice").len(), 3);
    assert!(gm_take_kind(&mut alice, "inventoryResult")
        .iter()
        .any(|value| value["success"] == false));
    pet_use_item(&mut world, "alice", "recall-1", 1, "5000000");
    assert_eq!(pets_in_snapshot(&world, "alice").len(), 2);
    pet_use_item(&mut world, "alice", "summon-four-retry", 4, "5000000");
    assert_eq!(pets_in_snapshot(&world, "alice").len(), 3);
    assert_eq!(
        world.players["alice"]
            .state
            .inventory
            .iter()
            .filter(|item| item.item_id == "5000000")
            .count(),
        4
    );
}

#[test]
fn pet_follows_independently_and_recovers_beyond_leash() {
    let mut world = World::new_with_gameplay(life_map("test"), 600, Gameplay::default());
    let _alice = join_test_player(&mut world, "alice");
    world.players.get_mut("alice").unwrap().state.x = 60.0;
    pet_give(&mut world, "alice", "5000000");
    pet_use_item(&mut world, "alice", "pet-1", 1, "5000000");
    world.step_pet("alice");
    let start = pet_in_snapshot(&world, "alice").unwrap();
    world.players.get_mut("alice").unwrap().state.x += 200.0;
    world.step_pet("alice");
    let moving = pet_in_snapshot(&world, "alice").unwrap();
    assert_eq!(moving["action"], "move");
    assert!(moving["x"].as_f64().unwrap() > start["x"].as_f64().unwrap());
    assert!(moving["x"].as_f64().unwrap() < world.players["alice"].state.x - 100.0);
    world.players.get_mut("alice").unwrap().state.x += 1100.0;
    world.step_pet("alice");
    let returned = pet_in_snapshot(&world, "alice").unwrap();
    assert!((returned["x"].as_f64().unwrap() - world.players["alice"].state.x).abs() < 100.0);
}

#[test]
fn pet_seeks_distant_drop_and_uses_pet_position_for_pickup() {
    let mut world = World::new_with_gameplay(life_map("test"), 600, Gameplay::default());
    let _alice = join_test_player(&mut world, "alice");
    world.players.get_mut("alice").unwrap().state.x = 60.0;
    pet_give(&mut world, "alice", "5000000");
    pet_use_item(&mut world, "alice", "pet-1", 1, "5000000");
    let player = &world.players["alice"].state;
    let (x, y) = (player.x + 240.0, player.y);
    for (id, dx) in [
        ("near", 0.0),
        ("outside", 1500.0),
        ("protected", -200.0),
        ("other-map", -190.0),
    ] {
        world.drops.insert(
            id.into(),
            DropState {
                id: id.into(),
                item_id: "2000000".into(),
                quantity: 3,
                x: x + dx,
                y,
            },
        );
    }
    world.drop_owners.insert(
        "protected".into(),
        (Some("bob".into()), auth::now_ms() + 60_000),
    );
    world
        .drop_maps
        .insert("other-map".into(), "elsewhere".into());
    world.step_pet("alice");
    assert_eq!(pet_in_snapshot(&world, "alice").unwrap()["mode"], "loot");
    for _ in 0..240 {
        world.tick += 1;
        world.step_pet("alice");
        world.step_pet_pickups();
        if !world.drops.contains_key("near") {
            break;
        }
    }
    assert!(
        !world.drops.contains_key("near"),
        "pet must walk to and collect the distant item"
    );
    assert!(
        (world.players["alice"].state.x - x).abs() > 32.0,
        "owner remained outside pickup range"
    );
    assert!(world.players["alice"]
        .state
        .inventory
        .iter()
        .any(|item| item.item_id == "2000000" && item.quantity == 3));
    for id in ["outside", "protected", "other-map"] {
        assert!(world.drops.contains_key(id));
    }
}

#[test]
fn pet_returns_to_the_owner_from_a_stacked_platform_and_ignores_other_level_drops() {
    let mut map = life_map("test");
    // 上层平台 y=20（x 60..240）：与下层 y=100 相差 80，超过宠物一次跳跃（约 64）。
    map.footholds.push(Foothold {
        id: 2,
        x1: 60.0,
        y1: 20.0,
        x2: 240.0,
        y2: 20.0,
        prev: 0,
        next: 0,
        forbid_fall_down: 0,
    });
    let mut world = World::new_with_gameplay(map, 600, Gameplay::default());
    let _alice = join_test_player(&mut world, "alice");
    {
        let player = world.players.get_mut("alice").unwrap();
        player.state.x = 120.0;
        player.state.y = 100.0;
        player.state.vx = 0.0;
        player.state.vy = 0.0;
        player.state.grounded = true;
        player.foothold_id = 1;
    }
    pet_give(&mut world, "alice", "5000000");
    pet_use_item(&mut world, "alice", "pet-1", 1, "5000000");
    // 宠物先在同层地面上跟住主人（垂直 leash 不参与）。
    for _ in 0..4 {
        world.tick += 1;
        world.step_pet("alice");
    }
    let settled = pet_in_snapshot(&world, "alice").unwrap();
    assert!((settled["y"].as_f64().unwrap() - 100.0).abs() < 0.01);
    assert_ne!(settled["mode"], "loot");

    // 上层平台上的掉落不是目标：宠物不会为它离开主人这一层。
    world.drops.insert(
        "upstairs".into(),
        DropState {
            id: "upstairs".into(),
            item_id: "2000000".into(),
            quantity: 1,
            x: 120.0,
            y: 20.0,
        },
    );
    world.step_pet("alice");
    assert_ne!(pet_in_snapshot(&world, "alice").unwrap()["mode"], "loot");

    // 主人站到上层平台：一层之隔超过一次跳跃，宠物瞬移回主人身边。
    {
        let player = world.players.get_mut("alice").unwrap();
        player.state.y = 20.0;
        player.state.grounded = true;
        player.foothold_id = 2;
    }
    world.step_pet("alice");
    let returned = pet_in_snapshot(&world, "alice").unwrap();
    assert!((returned["x"].as_f64().unwrap() - 120.0).abs() < 0.01);
    assert!((returned["y"].as_f64().unwrap() - 20.0).abs() < 0.01);
    assert_eq!(returned["mode"], "follow");
    assert!(world.drops.contains_key("upstairs"));
}

#[test]
fn pet_remains_summoned_across_portal_and_inventory_reordering() {
    let mut world = World::new_with_gameplay(life_map("test"), 600, Gameplay::default());
    let _alice = join_test_player(&mut world, "alice");
    world.players.get_mut("alice").unwrap().state.x = 60.0;
    pet_give(&mut world, "alice", "5000000");
    pet_use_item(&mut world, "alice", "pet-1", 1, "5000000");
    world.step_pet("alice");
    let before = pet_in_snapshot(&world, "alice").unwrap();
    let portal = Portal {
        name: "out00".into(),
        portal_type: 0,
        x: world.players["alice"].state.x,
        y: world.players["alice"].state.y,
        target_map_id: Some("arrival".into()),
        target_portal_name: None,
    };
    world
        .maps
        .get_mut("test")
        .unwrap()
        .portals
        .push(portal.clone());
    world.map.portals.push(portal);
    let mut arrival = life_map("arrival");
    arrival.spawn.x = 200.0;
    world.maps.insert("arrival".into(), arrival);
    world.command(Command::Input {
        id: "alice".into(),
        connection: "alice-connection".into(),
        message: ClientMessage::Portal {
            request_id: "pt-1".into(),
            portal_name: "out00".into(),
        },
    });
    assert_eq!(world.players["alice"].map_id, "arrival");
    let after = pet_in_snapshot(&world, "alice").unwrap();
    assert_eq!(after["id"], before["id"]);
    assert!((after["x"].as_f64().unwrap() - world.players["alice"].state.x).abs() <= 54.0);
    inventory::move_items(
        &mut world.players.get_mut("alice").unwrap().state.inventory,
        5,
        1,
        5,
        1,
    )
    .unwrap();
    world.step_pet("alice");
    let moved = pet_in_snapshot(&world, "alice").unwrap();
    assert_eq!(moved["id"], before["id"]);
    assert_eq!(moved["inventorySlot"], 5);
}
