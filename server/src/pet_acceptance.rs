// 宠物运行时验收：召唤 / 收回 / 跟随。经 `include!` 进入 `world.rs` 的
// `mod tests`，复用 `map()` / `chat_world()` / `join_test_player` /
// `chat_drain` / `chat_send` / `gm_take_kind`（定义在前面的验收文件里）。

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
    world.command(Command::Input {
        id: id.to_owned(),
        connection: format!("{id}-connection"),
        message: ClientMessage::ChatSend {
            request_id: format!("give-{id}-{item_id}"),
            text: format!("/add {item_id} 1"),
        },
    });
}

fn pet_in_snapshot(world: &World, observer: &str) -> Option<Value> {
    let snapshot: Value = serde_json::from_str(&world.snapshot(observer)).ok()?;
    snapshot["players"]
        .as_array()?
        .iter()
        .find_map(|row| row["pet"].as_object().map(|_| row["pet"].clone()))
}

#[test]
fn pet_use_summons_and_second_use_recalls() {
    let mut world = chat_world();
    let mut alice = join_test_player(&mut world, "alice");
    chat_drain(&mut alice);
    pet_give(&mut world, "alice", "5000000");
    assert_eq!(gm_take_kind(&mut alice, "gmResult").len(), 1);

    // First double-click: summon.  The item is not consumed.
    pet_use_item(&mut world, "alice", "pet-1", 1, "5000000");
    let results: Vec<Value> = {
        let mut out = Vec::new();
        while let Ok(text) = alice.try_recv() {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                if value["type"] == "inventoryResult" {
                    out.push(value);
                }
            }
        }
        out
    };
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["success"], true);
    assert_eq!(results[0]["operation"], "use");
    let row = world.players.get("alice").unwrap();
    assert!(
        row.state.inventory.iter().any(|item| item.item_id == "5000000"),
        "the pet item stays in the inventory"
    );
    let pet = pet_in_snapshot(&world, "alice").expect("the summoned pet rides the snapshot");
    assert_eq!(pet["itemId"], "5000000");
    assert_eq!(pet["name"], "褐色小貓");
    assert_eq!(pet["action"], "stand");

    // Second double-click: recall.
    pet_use_item(&mut world, "alice", "pet-2", 1, "5000000");
    assert!(pet_in_snapshot(&world, "alice").is_none(), "recall clears the pet");
    assert!(world
        .players
        .get("alice")
        .unwrap()
        .state
        .inventory
        .iter()
        .any(|item| item.item_id == "5000000"));
}

#[test]
fn pet_follows_the_owner_and_reports_move() {
    let mut world = chat_world();
    let mut alice = join_test_player(&mut world, "alice");
    chat_drain(&mut alice);
    pet_give(&mut world, "alice", "5000000");
    gm_take_kind(&mut alice, "gmResult");
    pet_use_item(&mut world, "alice", "pet-1", 1, "5000000");
    gm_take_kind(&mut alice, "inventoryResult");

    // Walk the owner far to the right; the pet must chase and then settle.
    world.players.get_mut("alice").unwrap().state.x = 400.0;
    world.step();
    let moving = pet_in_snapshot(&world, "alice").expect("pet still out while chasing");
    assert_eq!(moving["action"], "move");
    assert_eq!(moving["facing"], 1);

    // Enough ticks for the pet to arrive at the trailing offset.
    for _ in 0..120 {
        world.step();
    }
    let settled = pet_in_snapshot(&world, "alice").expect("pet still out after arrival");
    assert_eq!(settled["action"], "stand");
    let owner_x = world.players.get("alice").unwrap().state.x;
    let pet_x = settled["x"].as_f64().unwrap();
    assert!(
        (owner_x - pets::PET_SPAWN_OFFSET - pet_x).abs() < 12.0,
        "pet settles at the trailing offset (owner {owner_x}, pet {pet_x})"
    );
}

#[test]
fn pet_use_rejects_a_forged_cell_and_unknown_pet_ids() {
    let mut world = chat_world();
    let mut alice = join_test_player(&mut world, "alice");
    chat_drain(&mut alice);

    // No such inventory cell at all.
    pet_use_item(&mut world, "alice", "pet-bad", 1, "5000000");
    let rejects: Vec<Value> = {
        let mut out = Vec::new();
        while let Ok(text) = alice.try_recv() {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                if value["type"] == "rejected" {
                    out.push(value);
                }
            }
        }
        out
    };
    assert!(rejects.iter().any(|value| value["code"] == "item_not_usable"));
    assert!(pet_in_snapshot(&world, "alice").is_none());

    // A real pet id with no matching cash-tab cell is refused at the gate:
    // the pet identity is re-resolved from the authoritative inventory, so a
    // forged slot/item pair never summons anything.
    pet_use_item(&mut world, "alice", "pet-bad2", 1, "5000000");
    let rejects: Vec<Value> = {
        let mut out = Vec::new();
        while let Ok(text) = alice.try_recv() {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                if value["type"] == "rejected" {
                    out.push(value);
                }
            }
        }
        out
    };
    assert!(rejects.iter().any(|value| value["code"] == "item_not_usable"));

    // An id outside the pet catalog never enters the pet branch at all: the
    // ordinary useItem flow answers it (inventoryResult here, empty cell), and
    // no pet state can appear from it.
    pet_use_item(&mut world, "alice", "pet-notpet", 1, "5999999");
    let results: Vec<Value> = {
        let mut out = Vec::new();
        while let Ok(text) = alice.try_recv() {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                if value["type"] == "inventoryResult" {
                    out.push(value);
                }
            }
        }
        out
    };
    assert!(
        !results.iter().any(|value| value["code"] == "pet_toggled"),
        "ids outside the pet catalog never summon"
    );
    assert!(pet_in_snapshot(&world, "alice").is_none());
}

#[test]
fn pet_auto_picks_up_drops_within_reach_for_its_owner() {
    let mut world = chat_world();
    let mut alice = join_test_player(&mut world, "alice");
    chat_drain(&mut alice);
    pet_give(&mut world, "alice", "5000000");
    gm_take_kind(&mut alice, "gmResult");
    pet_use_item(&mut world, "alice", "pet-1", 1, "5000000");
    gm_take_kind(&mut alice, "inventoryResult");

    // A drop lands right under the pet (the pet trails 18px behind spawn).
    let (pet_x, pet_y) = {
        let pet = world.players.get("alice").unwrap().pet.as_ref().unwrap();
        (pet.x, pet.y)
    };
    world.drops.insert(
        "drop-near".into(),
        DropState {
            id: "drop-near".into(),
            item_id: "2000000".into(),
            quantity: 3,
            x: pet_x,
            y: pet_y,
        },
    );
    world.drops.insert(
        "drop-far".into(),
        DropState {
            id: "drop-far".into(),
            item_id: "2000001".into(),
            quantity: 1,
            x: pet_x + 500.0,
            y: pet_y,
        },
    );
    world.step();

    let alice_state = &world.players.get("alice").unwrap().state;
    assert!(
        alice_state
            .inventory
            .iter()
            .any(|item| item.item_id == "2000000" && item.quantity >= 3),
        "宠物必须把近处掉落代拾入包"
    );
    assert!(!world.drops.contains_key("drop-near"), "被拾取的掉落必须移除");
    assert!(world.drops.contains_key("drop-far"), "远处掉落宠物不碰");
}

#[test]
fn pet_is_recalled_when_the_owner_transfers_maps() {
    let mut world = chat_world();
    let mut alice = join_test_player(&mut world, "alice");
    chat_drain(&mut alice);
    pet_give(&mut world, "alice", "5000000");
    gm_take_kind(&mut alice, "gmResult");
    pet_use_item(&mut world, "alice", "pet-1", 1, "5000000");
    gm_take_kind(&mut alice, "inventoryResult");
    assert!(pet_in_snapshot(&world, "alice").is_some());

    // Wire one portal out of the test map and assemble the arrival map, then
    // walk the real portal command.  The Player row survives the transfer, so
    // without the recall the pet would ride the next snapshot carrying the
    // previous map's coordinates (2026-09-13 传送后显示错误 regression).
    let portal = Portal {
        name: "out00".into(),
        portal_type: 0,
        x: world.players.get("alice").unwrap().state.x,
        y: world.players.get("alice").unwrap().state.y,
        target_map_id: Some("arrival".into()),
        target_portal_name: None,
    };
    if let Some(source) = world.maps.get_mut("test") {
        source.portals.push(portal.clone());
    }
    world.map.portals.push(portal);
    world.maps.insert("arrival".into(), life_map("arrival"));
    world.command(Command::Input {
        id: "alice".into(),
        connection: "alice-connection".into(),
        message: ClientMessage::Portal {
            request_id: "pt-1".into(),
            portal_name: "out00".into(),
        },
    });
    assert_eq!(world.players.get("alice").unwrap().map_id, "arrival");
    assert!(
        pet_in_snapshot(&world, "alice").is_none(),
        "跨图后宠物必须被收回，不能携带旧地图坐标"
    );
}

#[test]
fn pet_summon_switches_to_a_newer_pet_instead_of_stacking() {
    let mut world = chat_world();
    let mut alice = join_test_player(&mut world, "alice");
    chat_drain(&mut alice);
    pet_give(&mut world, "alice", "5000000");
    pet_give(&mut world, "alice", "5000021");
    gm_take_kind(&mut alice, "gmResult");
    pet_use_item(&mut world, "alice", "pet-a", 1, "5000000");
    gm_take_kind(&mut alice, "inventoryResult");

    // Summoning another pet replaces the current one (one-pet-out rule).
    let cash_slot = world
        .players
        .get("alice")
        .unwrap()
        .state
        .inventory
        .iter()
        .find(|item| item.item_id == "5000021")
        .map(|item| item.slot)
        .expect("the second pet item was granted");
    pet_use_item(&mut world, "alice", "pet-b", cash_slot as i16, "5000021");
    gm_take_kind(&mut alice, "inventoryResult");

    let pet = pet_in_snapshot(&world, "alice").expect("a pet is still out");
    assert_eq!(pet["itemId"], "5000021");
    assert_eq!(pet["name"], "猴子");
}
