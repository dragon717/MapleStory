// Directional acceptance for the map-reactor module.
//
// A reactor is authoritative world state, so these checks focus on the
// failure boundaries that decide it: a forged or stale id, a second hit while
// the first is still animating, a prop on another map, and the authored
// respawn timer.  Everything the client could lie about (range, state, map)
// is re-decided server-side.

use super::*;

/// A flat map with one attack-triggered reactor (no authored box → the
/// afterimage reach applies) and one area-triggered reactor (authored box).
fn reactor_map() -> Map {
    Map {
        id: "reactor-test".into(),
        bounds: Bounds { x_min: 0.0, x_max: 600.0, y_min: -100.0, y_max: 400.0 },
        spawn: Point { x: 100.0, y: 200.0 },
        footholds: vec![Foothold {
            id: 1, x1: 0.0, y1: 200.0, x2: 600.0, y2: 200.0,
            prev: 0, next: 0, forbid_fall_down: 0,
        }],
        ladders: Vec::new(),
        portals: Vec::new(),
        water: Vec::new(),
        reactors: vec![
            ReactorPlacement {
                id: "swing-flower".into(),
                template_id: "1012000".into(),
                x: 150.0,
                y: 200.0,
                flip: false,
                reactor_time: 2,
                // Five authored states: 0..3 interactable, 4 is the empty form.
                state_count: 5,
                hit_type: 0,
                hitbox_lt: None,
                hitbox_rb: None,
            },
            ReactorPlacement {
                id: "area-herb".into(),
                template_id: "1022003".into(),
                x: 400.0,
                y: 200.0,
                flip: false,
                reactor_time: 0,
                // Two states: 0 interactable, 1 empty — and it never returns.
                state_count: 2,
                hit_type: 9,
                hitbox_lt: Some(Point { x: -25.0, y: -25.0 }),
                hitbox_rb: Some(Point { x: 32.0, y: 26.0 }),
            },
        ],
    }
}

fn reactor_world() -> (World, mpsc::Receiver<String>) {
    let mut world = World::new_with_gameplay(reactor_map(), 600, Gameplay::default());
    let mut output = join_test_player(&mut world, "reactor");
    while output.try_recv().is_ok() {}
    // Let the spawn drop settle so the player is standing on the foothold.
    for _ in 0..4 {
        world.step();
        while output.try_recv().is_ok() {}
    }
    (world, output)
}

fn hit(world: &mut World, reactor_id: &str, request: &str) {
    world.command(Command::Input {
        id: "reactor".into(),
        connection: "reactor-connection".into(),
        message: ClientMessage::ReactorHit {
            request_id: request.into(),
            reactor_id: reactor_id.into(),
        },
    });
}

fn last_rejection(output: &mut mpsc::Receiver<String>) -> Option<String> {
    let mut last = None;
    while let Ok(message) = output.try_recv() {
        if message.contains("\"rejected\"") {
            last = Some(
                serde_json::from_str::<serde_json::Value>(&message)
                    .ok()?
                    .get("code")?
                    .as_str()?
                    .to_owned(),
            );
        }
    }
    last
}

fn snapshot_reactor(world: &mut World, id: &str) -> serde_json::Value {
    let snapshot = world.snapshot("reactor");
    let value: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
    value
        .get("reactors")
        .and_then(|reactors| reactors.as_array())
        .and_then(|reactors| reactors.iter().find(|entry| entry.get("id").and_then(|v| v.as_str()) == Some(id)))
        .cloned()
        .unwrap_or_else(|| panic!("reactor {id} missing from snapshot"))
}

#[test]
fn reactor_hit_advances_state_and_broadcasts_to_the_map() {
    let (mut world, mut output) = reactor_world();
    // Spawn is x=100 facing right; the swing reactor sits at x=150, well
    // inside the 88px authored attack reach.
    assert_eq!(snapshot_reactor(&mut world, "swing-flower").get("state").and_then(|v| v.as_u64()), Some(0));

    hit(&mut world, "swing-flower", "r1");
    assert_eq!(snapshot_reactor(&mut world, "swing-flower").get("state").and_then(|v| v.as_u64()), Some(1));
    assert!(snapshot_reactor(&mut world, "swing-flower").get("hitting").and_then(|v| v.as_bool()) == Some(true));

    // The authoritative result is broadcast, so every observer sees it.
    let event = output.try_recv().expect("reactorState broadcast");
    let value: serde_json::Value = serde_json::from_str(&event).unwrap();
    assert_eq!(value.get("type").and_then(|v| v.as_str()), Some("reactorState"));
    assert_eq!(value.get("reactorId").and_then(|v| v.as_str()), Some("swing-flower"));
    assert_eq!(value.get("state").and_then(|v| v.as_u64()), Some(1));
    assert_eq!(value.get("spent").and_then(|v| v.as_bool()), Some(false));
    assert_eq!(value.get("playerId").and_then(|v| v.as_str()), Some("reactor"));
}

#[test]
fn reactor_rejects_a_second_hit_while_the_first_is_animating() {
    let (mut world, mut output) = reactor_world();
    hit(&mut world, "swing-flower", "r1");
    while output.try_recv().is_ok() {}
    // Same tick: the lock window is still open, so this must not advance.
    hit(&mut world, "swing-flower", "r2");
    assert_eq!(last_rejection(&mut output), Some("reactor_busy".into()));
    assert_eq!(snapshot_reactor(&mut world, "swing-flower").get("state").and_then(|v| v.as_u64()), Some(1));

    // After the lock expires the next hit is accepted again.
    for _ in 0..REACTOR_HIT_LOCK_MS.div_ceil(TICK_MS) {
        world.step();
        while output.try_recv().is_ok() {}
    }
    hit(&mut world, "swing-flower", "r3");
    assert_eq!(snapshot_reactor(&mut world, "swing-flower").get("state").and_then(|v| v.as_u64()), Some(2));
}

#[test]
fn reactor_rejects_unknown_and_out_of_range_hits() {
    let (mut world, mut output) = reactor_world();
    hit(&mut world, "no-such-reactor", "r1");
    assert_eq!(last_rejection(&mut output), Some("reactor_unknown".into()));

    // The area herb is at x=400 with a ±25..32 box; the player spawns at 100.
    hit(&mut world, "area-herb", "r2");
    assert_eq!(last_rejection(&mut output), Some("reactor_out_of_range".into()));
    assert_eq!(snapshot_reactor(&mut world, "area-herb").get("state").and_then(|v| v.as_u64()), Some(0));
}

#[test]
fn reactor_uses_up_then_returns_on_the_authored_timer() {
    let (mut world, mut output) = reactor_world();
    // Four authored interactable states (0..3) before the empty form.
    for index in 0..4u64 {
        hit(&mut world, "swing-flower", &format!("r{index}"));
        while output.try_recv().is_ok() {}
        assert_eq!(
            snapshot_reactor(&mut world, "swing-flower").get("state").and_then(|v| v.as_u64()),
            Some(index + 1)
        );
        for _ in 0..REACTOR_HIT_LOCK_MS.div_ceil(TICK_MS) + 1 {
            world.step();
            while output.try_recv().is_ok() {}
        }
    }
    // State 4 is the last one: spent, and no longer interactable.
    assert_eq!(snapshot_reactor(&mut world, "swing-flower").get("spent").and_then(|v| v.as_bool()), Some(true));
    hit(&mut world, "swing-flower", "spent");
    assert_eq!(last_rejection(&mut output), Some("reactor_spent".into()));

    // reactor_time is 2 source seconds; step past it and the prop returns.
    for _ in 0..(2_000 / TICK_MS) + 2 {
        world.step();
        while output.try_recv().is_ok() {}
    }
    assert_eq!(snapshot_reactor(&mut world, "swing-flower").get("state").and_then(|v| v.as_u64()), Some(0));
    assert_eq!(snapshot_reactor(&mut world, "swing-flower").get("spent").and_then(|v| v.as_bool()), Some(false));
}

#[test]
fn reactor_without_a_respawn_timer_stays_spent() {
    let (mut world, mut output) = reactor_world();
    // Walk next to the area herb so the authored box contains the player.
    world.players.get_mut("reactor").unwrap().state.x = 400.0;
    world.players.get_mut("reactor").unwrap().state.y = 200.0;
    world.players.get_mut("reactor").unwrap().foothold_id = 1;

    hit(&mut world, "area-herb", "r1");
    while output.try_recv().is_ok() {}
    assert_eq!(snapshot_reactor(&mut world, "area-herb").get("spent").and_then(|v| v.as_bool()), Some(true));

    // reactor_time 0 means one-shot: long past any plausible cycle it is gone.
    for _ in 0..(10_000 / TICK_MS) {
        world.step();
        while output.try_recv().is_ok() {}
    }
    assert_eq!(snapshot_reactor(&mut world, "area-herb").get("state").and_then(|v| v.as_u64()), Some(1));
    assert_eq!(snapshot_reactor(&mut world, "area-herb").get("spent").and_then(|v| v.as_bool()), Some(true));
}

#[test]
fn reactor_hit_is_rejected_for_a_dead_or_busy_player() {
    let (mut world, mut output) = reactor_world();
    world.players.get_mut("reactor").unwrap().state.hp = 0;
    world.players.get_mut("reactor").unwrap().state.action = "dead";
    hit(&mut world, "swing-flower", "r1");
    assert_eq!(last_rejection(&mut output), Some("invalid_state".into()));
    assert_eq!(snapshot_reactor(&mut world, "swing-flower").get("state").and_then(|v| v.as_u64()), Some(0));
}

#[test]
fn reactor_on_another_map_is_never_reachable() {
    let mut world = World::new_with_gameplay(reactor_map(), 600, Gameplay::default());
    let mut output = join_test_player(&mut world, "reactor");
    while output.try_recv().is_ok() {}
    // A second map with its own reactor; the player is not on it.
    let other = Map {
        id: "elsewhere".into(),
        bounds: Bounds { x_min: 0.0, x_max: 600.0, y_min: -100.0, y_max: 400.0 },
        spawn: Point { x: 100.0, y: 200.0 },
        footholds: vec![Foothold {
            id: 1, x1: 0.0, y1: 200.0, x2: 600.0, y2: 200.0,
            prev: 0, next: 0, forbid_fall_down: 0,
        }],
        ladders: Vec::new(),
        portals: Vec::new(),
        water: Vec::new(),
        reactors: vec![ReactorPlacement {
            id: "other-map-reactor".into(),
            template_id: "1012000".into(),
            x: 100.0,
            y: 200.0,
            flip: false,
            reactor_time: 0,
            state_count: 5,
            hit_type: 0,
            hitbox_lt: None,
            hitbox_rb: None,
        }],
    };
    world.maps.insert("elsewhere".into(), other);
    world.rebuild_reactors();

    hit(&mut world, "other-map-reactor", "r1");
    assert_eq!(last_rejection(&mut output), Some("reactor_unknown".into()));
}

#[test]
fn reactor_placement_is_validated_with_the_map() {
    let mut map = reactor_map();
    assert!(map.validate().is_ok());
    // Out of bounds.
    map.reactors[0].x = 10_000.0;
    assert!(map.validate().is_err());
    // Empty id.
    let mut map = reactor_map();
    map.reactors[0].id = String::new();
    assert!(map.validate().is_err());
    // No states at all would make every state "spent".
    let mut map = reactor_map();
    map.reactors[0].state_count = 0;
    assert!(map.validate().is_err());
}

#[test]
fn reactor_hit_request_is_rejected_at_the_wire_for_a_bad_id() {
    // The protocol layer refuses an oversized or malformed id before the world
    // ever sees it, so a hostile client cannot even name a reactor freely.
    let long = "x".repeat(65);
    let message = serde_json::json!({
        "type": "reactorHit",
        "requestId": "r1",
        "reactorId": long,
    });
    let parsed: ClientMessage = serde_json::from_value(message).unwrap();
    assert!(!parsed.valid());

    let empty = serde_json::json!({"type": "reactorHit", "requestId": "r1", "reactorId": ""});
    let parsed: ClientMessage = serde_json::from_value(empty).unwrap();
    assert!(!parsed.valid());

    let good = serde_json::json!({"type": "reactorHit", "requestId": "r1", "reactorId": "101010000-reactor-0"});
    let parsed: ClientMessage = serde_json::from_value(good).unwrap();
    assert!(parsed.valid());
}
