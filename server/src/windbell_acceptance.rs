use super::windbell::{WindbellArrivalPath, WindbellConfig};
use crate::protocol::{ClientMessage, WindbellAction};

fn windbell_config_for_test() -> WindbellConfig {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("shared")
        .join("windbell.json");
    let mut config = WindbellConfig::load(&path).expect("shared Windbell data should load");
    // Movement/transaction fixtures have no gameplay catalog; the content-boot
    // acceptance and archive encounter check exercise the real creature spawn.
    config.bridge.monster_spawns.clear();
    config
}

fn windbell_world_for_test() -> World {
    let mut world = World::new(life_map("windbell-test-home"), 600);
    world.gameplay.player.climb_speed = Some(125.0);
    world
        .with_windbell(windbell_config_for_test())
        .expect("Windbell data should attach")
}

fn windbell_input(world: &mut World, id: &str, seq: u64, direction: i8, vertical: i8, jump: bool) {
    world.command(Command::Input {
        id: id.to_owned(),
        connection: format!("{id}-connection"),
        message: ClientMessage::Input {
            seq,
            direction,
            vertical,
            jump,
        },
    });
}

fn windbell_action(
    world: &mut World,
    id: &str,
    request_id: &str,
    action: WindbellAction,
    instance_id: Option<String>,
) {
    let sequence = world
        .store
        .as_ref()
        .and_then(|store| store.load_windbell_action(id, request_id).ok().flatten())
        .and_then(|(_, json)| serde_json::from_str::<serde_json::Value>(&json).ok())
        .and_then(|json| json["sequence"].as_u64())
        .unwrap_or(world.players[id].windbell_progress.command_sequence + 1);
    world.command(Command::Input {
        id: id.to_owned(),
        connection: format!("{id}-connection"),
        message: ClientMessage::Windbell {
            request_id: request_id.to_owned(),
            sequence,
            action,
            instance_id,
        },
    });
}

fn drain_windbell_output(rx: &mut mpsc::Receiver<String>) -> Vec<serde_json::Value> {
    std::iter::from_fn(|| rx.try_recv().ok())
        .filter_map(|message| serde_json::from_str(&message).ok())
        .collect()
}

fn windbell_snapshot(world: &World, id: &str) -> serde_json::Value {
    serde_json::from_str::<serde_json::Value>(&world.snapshot(id)).expect("valid snapshot")
}

fn walk_windbell(
    world: &mut World,
    id: &str,
    rx: &mut mpsc::Receiver<String>,
    direction: i8,
    ticks: usize,
) {
    for tick in 0..ticks {
        if tick % 5 == 0 {
            windbell_input(world, id, world.tick.saturating_add(1), direction, 0, false);
        }
        world.step();
        if tick % 24 == 0 {
            let _ = drain_windbell_output(rx);
        }
    }
}

fn enter_windbell_island(world: &mut World, id: &str, rx: &mut mpsc::Receiver<String>) -> String {
    windbell_action(world, id, "enter-island", WindbellAction::EnterIsland, None);
    let _ = drain_windbell_output(rx);
    world.players[id].map_id.clone()
}

#[test]
fn windbell_loads_and_root_path_uses_real_authoritative_movement() {
    let mut world = windbell_world_for_test();
    let mut rx = join_test_player(&mut world, "windbell-root");
    let _ = drain_windbell_output(&mut rx);
    world.command(Command::Input {
        id: "windbell-root".to_owned(),
        connection: "windbell-root-connection".to_owned(),
        message: ClientMessage::Windbell {
            request_id: "root-enter".to_owned(),
            sequence: 1,
            action: WindbellAction::EnterIsland,
            instance_id: None,
        },
    });
    let _ = drain_windbell_output(&mut rx);
    assert!(world.players["windbell-root"]
        .map_id
        .starts_with("windbell:island:"));
    walk_windbell(&mut world, "windbell-root", &mut rx, 1, 500);
    let player = &world.players["windbell-root"];
    assert!(
        player.state.grounded,
        "root route should finish on a foothold"
    );
    assert!(
        player.state.x >= 2180.0,
        "root route must physically reach the island arrival zone"
    );
    assert_eq!(
        player.windbell_progress.arrival_path,
        Some(WindbellArrivalPath::Root)
    );
}

#[test]
fn windbell_tree_bridge_path_requires_landing_then_real_foothold_travel() {
    let mut world = windbell_world_for_test();
    let mut rx = join_test_player(&mut world, "windbell-bridge-route");
    let instance_id = enter_windbell_island(&mut world, "windbell-bridge-route", &mut rx);

    // Walk to the authored ladder, climb to foothold 5, and use the actual
    // interaction range for the support rope.  No test coordinate is injected
    // into the player state.
    walk_windbell(&mut world, "windbell-bridge-route", &mut rx, 1, 60);
    walk_windbell(&mut world, "windbell-bridge-route", &mut rx, -1, 16);
    for _ in 0..130 {
        let seq = world.tick + 1;
        windbell_input(&mut world, "windbell-bridge-route", seq, 0, -1, false);
        world.step();
    }
    assert_eq!(world.players["windbell-bridge-route"].foothold_id, 5);
    windbell_action(
        &mut world,
        "windbell-bridge-route",
        "cut-support",
        WindbellAction::CutSupport,
        Some(instance_id.clone()),
    );
    assert_eq!(
        windbell_snapshot(&world, "windbell-bridge-route")["windbell"]["treeBridge"],
        "falling"
    );
    for _ in 0..45 {
        world.step();
    }
    assert_eq!(
        windbell_snapshot(&world, "windbell-bridge-route")["windbell"]["treeBridge"],
        "landed"
    );
    let mut last_fh = world.players["windbell-bridge-route"].foothold_id;
    for tick in 0..420 {
        if tick % 5 == 0 {
            let seq = world.tick + 1;
            windbell_input(&mut world, "windbell-bridge-route", seq, 1, 0, false);
        }
        world.step();
        let player = &world.players["windbell-bridge-route"];
        if player.foothold_id != last_fh {
            last_fh = player.foothold_id;
        }
    }
    assert_eq!(
        world.players["windbell-bridge-route"]
            .windbell_progress
            .arrival_path,
        Some(WindbellArrivalPath::Bridge)
    );
}

#[test]
fn windbell_fire_path_is_bounded_and_requires_stable_arrival() {
    let mut world = windbell_world_for_test();
    let mut rx = join_test_player(&mut world, "windbell-fire-route");
    let instance_id = enter_windbell_island(&mut world, "windbell-fire-route", &mut rx);
    walk_windbell(&mut world, "windbell-fire-route", &mut rx, 1, 145);
    let branch_position = {
        let player = &world.players["windbell-fire-route"];
        (player.state.x, player.state.y)
    };
    assert!((980.0..=1160.0).contains(&branch_position.0));
    windbell_action(
        &mut world,
        "windbell-fire-route",
        "ignite-fire",
        WindbellAction::Ignite,
        Some(instance_id.clone()),
    );
    windbell_action(
        &mut world,
        "windbell-fire-route",
        "deploy-fire",
        WindbellAction::DeployLeafwing,
        Some(instance_id.clone()),
    );
    assert!(world.players["windbell-fire-route"].windbell_glide_until > world.tick);
    walk_windbell(&mut world, "windbell-fire-route", &mut rx, 1, 600);
    assert_eq!(
        world.players["windbell-fire-route"]
            .windbell_progress
            .arrival_path,
        Some(WindbellArrivalPath::Fire)
    );
    assert_eq!(
        windbell_snapshot(&world, "windbell-fire-route")["windbell"]["leafwing"],
        false
    );
}

#[test]
fn windbell_bridge_conserves_materials_and_rejects_fake_or_replayed_requests() {
    let mut world = windbell_world_for_test();
    let mut rx = join_test_player(&mut world, "windbell-public");
    let _ = drain_windbell_output(&mut rx);
    windbell_action(
        &mut world,
        "windbell-public",
        "enter-public",
        WindbellAction::EnterBridge,
        None,
    );
    let _ = drain_windbell_output(&mut rx);
    walk_windbell(&mut world, "windbell-public", &mut rx, 1, 60);
    windbell_action(
        &mut world,
        "windbell-public",
        "brace-public",
        WindbellAction::BraceCart,
        Some("shared:windbell-bridge".to_owned()),
    );
    windbell_action(
        &mut world,
        "windbell-public",
        "talk-after-brace",
        WindbellAction::Talk,
        Some("shared:windbell-bridge".to_owned()),
    );
    assert!(
        windbell_snapshot(&world, "windbell-public")["windbell"]["dialogue"][0]
            .as_str()
            .is_some_and(|line| line.contains("扶住车辕"))
    );
    walk_windbell(&mut world, "windbell-public", &mut rx, 1, 10);
    windbell_action(
        &mut world,
        "windbell-public",
        "deliver-one",
        WindbellAction::DeliverPlank,
        Some("shared:windbell-bridge".to_owned()),
    );
    walk_windbell(&mut world, "windbell-public", &mut rx, 1, 10);
    windbell_action(
        &mut world,
        "windbell-public",
        "talk-after-delivery",
        WindbellAction::Talk,
        Some("shared:windbell-bridge".to_owned()),
    );
    assert!(
        windbell_snapshot(&world, "windbell-public")["windbell"]["dialogue"][0]
            .as_str()
            .is_some_and(|line| line.contains("1块木板"))
    );
    let state = &world.windbell.as_ref().unwrap().bridge;
    assert_eq!(
        state.source_planks
            + state.site_planks
            + state
                .segments
                .iter()
                .filter(|installed| **installed)
                .count() as u32
                * 2,
        6
    );
    assert_eq!(
        state.source_ropes
            + state.site_ropes
            + state
                .segments
                .iter()
                .filter(|installed| **installed)
                .count() as u32,
        3
    );
    let revision = state.revision;
    windbell_action(
        &mut world,
        "windbell-public",
        "deliver-one",
        WindbellAction::DeliverPlank,
        Some("shared:windbell-bridge".to_owned()),
    );
    assert_eq!(world.windbell.as_ref().unwrap().bridge.revision, revision);

    let mut island_rx = join_test_player(&mut world, "windbell-fake");
    let island_id = enter_windbell_island(&mut world, "windbell-fake", &mut island_rx);
    let before_map = world.players["windbell-fake"].map_id.clone();
    windbell_action(
        &mut world,
        "windbell-fake",
        "fake-token",
        WindbellAction::CutSupport,
        Some("windbell:island:forged".to_owned()),
    );
    assert_eq!(world.players["windbell-fake"].map_id, before_map);
    windbell_action(
        &mut world,
        "windbell-fake",
        "enter-island",
        WindbellAction::EnterIsland,
        None,
    );
    assert_eq!(world.players["windbell-fake"].map_id, island_id);
    assert!(world.players["windbell-fake"].map_id == island_id);
}

#[test]
fn windbell_public_npc_waits_for_first_entry_and_uses_tick_ms_rhythm() {
    let mut world = windbell_world_for_test();
    let mut rx = join_test_player(&mut world, "windbell-pacing");
    let _ = drain_windbell_output(&mut rx);

    // Boot time alone cannot advance the public activity.  This also proves
    // the timer is anchored to the first public visit rather than server
    // construction.
    for tick in 0..1300 {
        world.step();
        if tick % 24 == 0 {
            let _ = drain_windbell_output(&mut rx);
        }
    }
    assert!(!world.windbell.as_ref().unwrap().bridge.cart_upright);
    assert_eq!(world.windbell.as_ref().unwrap().bridge.source_planks, 6);

    windbell_action(
        &mut world,
        "windbell-pacing",
        "enter-pacing",
        WindbellAction::EnterBridge,
        None,
    );
    let _ = drain_windbell_output(&mut rx);
    for tick in 0..1199 {
        world.step();
        if tick % 24 == 0 {
            let _ = drain_windbell_output(&mut rx);
        }
    }
    assert!(!world.windbell.as_ref().unwrap().bridge.cart_upright);
    world.step();
    assert!(world.windbell.as_ref().unwrap().bridge.cart_upright);
    assert_eq!(world.windbell.as_ref().unwrap().bridge.site_planks, 0);

    // The rescue wake does not also consume a supply.  The next wake is one
    // ten-second interval later and performs exactly one authored action.
    for tick in 0..200 {
        world.step();
        if tick % 24 == 0 {
            let _ = drain_windbell_output(&mut rx);
        }
    }
    let bridge = &world.windbell.as_ref().unwrap().bridge;
    assert_eq!(bridge.source_planks, 5);
    assert_eq!(bridge.site_planks, 1);
    for tick in 0..3000 {
        world.step();
        if tick % 24 == 0 {
            let _ = drain_windbell_output(&mut rx);
        }
    }
    assert_eq!(
        windbell_snapshot(&world, "windbell-pacing")["windbell"]["bridgeStage"],
        "inhabited"
    );
    assert_eq!(
        world.npcs["windbell-awei"].state.x,
        world.windbell.as_ref().unwrap().bridge.cart_x + 30.0
    );
    assert_eq!(
        world.npcs["windbell-awei"].state.facing, 1,
        "the traveler faces the actual outbound journey"
    );
    for _ in 0..100 {
        if world.players["windbell-pacing"].state.x >= world.npcs["windbell-awei"].state.x - 80.0 {
            break;
        }
        walk_windbell(&mut world, "windbell-pacing", &mut rx, 1, 5);
    }
    windbell_action(
        &mut world,
        "windbell-pacing",
        "talk-arrived",
        WindbellAction::Talk,
        Some("shared:windbell-bridge".to_owned()),
    );
    assert!(world.players["windbell-pacing"]
        .windbell_dialogue
        .join("")
        .contains("货已运过桥"));
}

#[test]
fn windbell_disconnect_returns_to_canonical_map_and_cleans_instance() {
    let mut world = windbell_world_for_test();
    let mut rx = join_test_player(&mut world, "windbell-disconnect");
    let instance_id = enter_windbell_island(&mut world, "windbell-disconnect", &mut rx);
    world.command(Command::Detach {
        id: "windbell-disconnect".to_owned(),
        connection: "windbell-disconnect-connection".to_owned(),
        reason: AwayReason::TransportLost,
    });
    assert_eq!(
        world.players["windbell-disconnect"].map_id,
        "windbell-test-home"
    );
    assert!(!world.maps.contains_key(&instance_id));
    assert!(!world.maps.contains_key(&instance_id));
}

#[test]
fn windbell_failed_leave_restores_landed_tree_bridge_geometry() {
    let path = std::env::temp_dir().join(format!(
        "maple-windbell-failed-leave-{}.sqlite3",
        auth::random_id()
    ));
    let service = auth::start(&path).expect("Windbell test store should start");
    let mut world = World::new_with_store(
        life_map("windbell-failed-leave-home"),
        600,
        Gameplay::default(),
        service.store.clone(),
    )
    .expect("store-backed Windbell world should build")
    .with_windbell(windbell_config_for_test())
    .expect("Windbell data should attach");
    world.gameplay.player.climb_speed = Some(125.0);
    let mut rx = join_test_player(&mut world, "windbell-failed-leave");
    let instance_id = enter_windbell_island(&mut world, "windbell-failed-leave", &mut rx);

    // Reach and drop the tree through the authored ladder, interaction range,
    // and schedule.  A later short walk leaves the player standing on the
    // dynamic bridge so the failed exit assertion covers both map geometry
    // and the player's current foothold.
    walk_windbell(&mut world, "windbell-failed-leave", &mut rx, 1, 60);
    walk_windbell(&mut world, "windbell-failed-leave", &mut rx, -1, 16);
    for _ in 0..130 {
        let seq = world.tick.saturating_add(1);
        windbell_input(&mut world, "windbell-failed-leave", seq, 0, -1, false);
        world.step();
    }
    assert_eq!(world.players["windbell-failed-leave"].foothold_id, 5);
    windbell_action(
        &mut world,
        "windbell-failed-leave",
        "failed-leave-cut",
        WindbellAction::CutSupport,
        Some(instance_id.clone()),
    );
    for _ in 0..45 {
        world.step();
    }
    assert_eq!(
        windbell_snapshot(&world, "windbell-failed-leave")["windbell"]["treeBridge"],
        "landed"
    );
    walk_windbell(&mut world, "windbell-failed-leave", &mut rx, 1, 80);
    assert_eq!(world.players["windbell-failed-leave"].foothold_id, 7);

    // Abort only the leave receipt.  The leave path has already returned the
    // in-memory player and removed the private map when this trigger fires;
    // execute_windbell_action must restore the complete prior instance.
    service
        .store
        .with_db(|db| {
            db.execute_batch(
                "CREATE TRIGGER windbell_fail_leave
                 BEFORE INSERT ON windbell_action_log
                 WHEN NEW.account_id='windbell-failed-leave'
                   AND NEW.request_id='failed-leave'
                 BEGIN SELECT RAISE(ABORT, 'windbell leave test failure'); END;",
            )
            .map_err(|_| "leave trigger setup failed".to_owned())
        })
        .unwrap();
    windbell_action(
        &mut world,
        "windbell-failed-leave",
        "failed-leave",
        WindbellAction::Leave,
        Some(instance_id.clone()),
    );

    let player = &world.players["windbell-failed-leave"];
    assert_eq!(player.map_id, instance_id);
    assert_eq!(
        player.foothold_id, 7,
        "failed leave must leave the player standing on the bridge"
    );
    let map = world
        .maps
        .get(&instance_id)
        .expect("failed leave restores island map");
    assert!(
        map.get(7).is_some(),
        "failed leave restores the landed bridge foothold"
    );
    assert_eq!(map.get(5).expect("shore foothold 5").next, 7);
    assert_eq!(map.get(6).expect("shore foothold 6").prev, 7);

    drop(world);
    drop(service);
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
}

#[test]
fn windbell_rest_commits_stock_health_and_receipt_together_and_survives_reopen() {
    let path = std::env::temp_dir().join(format!("windbell-life-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).unwrap();
    let make_world = |store| {
        World::new_with_store(
            life_map("windbell-life-home"),
            600,
            Gameplay::default(),
            store,
        )
        .unwrap()
        .with_windbell(windbell_config_for_test())
        .unwrap()
    };
    let mut world = make_world(service.store.clone());
    let mut rx = join_test_player(&mut world, "rest-guest");
    windbell_action(
        &mut world,
        "rest-guest",
        "enter-life",
        WindbellAction::EnterBridge,
        None,
    );
    // A legacy completed bridge, with no livelihood field in its saved JSON.
    let bridge = &mut world.windbell.as_mut().unwrap().bridge;
    bridge.source_planks = 0;
    bridge.source_ropes = 0;
    bridge.segments = [true; 3];
    bridge.cart_upright = true;
    bridge.cart_x = 1600.0;
    bridge.shipment = super::windbell::WindbellShipmentState::Arrived;
    let mut legacy = serde_json::to_value(&bridge).unwrap();
    legacy.as_object_mut().unwrap().remove("life");
    service
        .store
        .save_windbell_bridge_state("windbell", &legacy.to_string(), bridge.revision)
        .unwrap();
    drop(world);
    let mut world = make_world(service.store.clone());
    let mut rx2 = join_test_player(&mut world, "rest-guest");
    world.step_windbell_life_at(100_000);
    let player = world.players.get_mut("rest-guest").unwrap();
    player.map_id = "windbell-bridge".to_owned();
    player.state.x = 1600.0;
    player.state.y = 700.0;
    player.state.hp = 1;
    player.state.mp = 0;
    player.state.max_hp = 60;
    player.state.max_mp = 30;
    player.base_max_mp = 30;
    world.persist_player("rest-guest").unwrap();
    let before = service
        .store
        .load_windbell_bridge_state("windbell")
        .unwrap()
        .unwrap();
    service.store.with_db(|db| db.execute_batch(
        "CREATE TRIGGER reject_rest BEFORE UPDATE OF hp ON player_stats BEGIN SELECT RAISE(ABORT, 'rest failure'); END;"
    ).map_err(|e| e.to_string())).unwrap();
    let token = Some("shared:windbell-bridge".to_owned());
    windbell_action(
        &mut world,
        "rest-guest",
        "rest-once",
        WindbellAction::Rest,
        token.clone(),
    );
    assert_eq!(world.players["rest-guest"].state.hp, 1);
    assert_eq!(
        service
            .store
            .load_windbell_bridge_state("windbell")
            .unwrap()
            .unwrap(),
        before
    );
    assert!(service
        .store
        .load_windbell_action("rest-guest", "rest-once")
        .unwrap()
        .is_none());
    service
        .store
        .with_db(|db| {
            db.execute_batch("DROP TRIGGER reject_rest")
                .map_err(|e| e.to_string())
        })
        .unwrap();
    windbell_action(
        &mut world,
        "rest-guest",
        "rest-once",
        WindbellAction::Rest,
        token.clone(),
    );
    let hp = world.players["rest-guest"].state.hp;
    assert!(
        hp > 1,
        "rest response: {:?}",
        drain_windbell_output(&mut rx2)
    );
    assert_eq!(
        windbell_snapshot(&world, "rest-guest")["windbell"]["livelihood"]["shelter"],
        3
    );
    let committed = service
        .store
        .load_windbell_bridge_state("windbell")
        .unwrap()
        .unwrap();
    windbell_action(
        &mut world,
        "rest-guest",
        "rest-once",
        WindbellAction::Rest,
        token.clone(),
    );
    assert_eq!(world.players["rest-guest"].state.hp, hp);
    assert_eq!(
        service
            .store
            .load_windbell_bridge_state("windbell")
            .unwrap()
            .unwrap(),
        committed
    );
    // Background progress is also commit-first: failure must retain its due work.
    service.store.with_db(|db| db.execute_batch(
        "CREATE TRIGGER reject_life BEFORE INSERT ON windbell_bridge_state BEGIN SELECT RAISE(ABORT, 'life failure'); END;"
    ).map_err(|e| e.to_string())).unwrap();
    world.step_windbell_life_at(220_000);
    assert_eq!(
        service
            .store
            .load_windbell_bridge_state("windbell")
            .unwrap()
            .unwrap(),
        committed
    );
    assert_eq!(
        windbell_snapshot(&world, "rest-guest")["windbell"]["livelihood"]["shelter"],
        3
    );
    service
        .store
        .with_db(|db| {
            db.execute_batch("DROP TRIGGER reject_life")
                .map_err(|e| e.to_string())
        })
        .unwrap();
    world.step_windbell_life_at(220_000);
    assert_eq!(
        service
            .store
            .load_windbell_bridge_state("windbell")
            .unwrap()
            .unwrap(),
        committed,
        "storage failures back off instead of retrying every frame"
    );
    world.step_windbell_life_at(225_000);
    assert!(
        windbell_snapshot(&world, "rest-guest")["windbell"]["livelihood"]["deliveries"]
            .as_u64()
            .unwrap()
            > 1
    );
    drop(world);
    drop(service);
    let reopened = auth::start(&path).unwrap();
    let mut world = make_world(reopened.store.clone());
    let _rx3 = join_test_player(&mut world, "rest-guest");
    assert_eq!(world.players["rest-guest"].state.hp, hp);
    let saved = reopened
        .store
        .load_windbell_bridge_state("windbell")
        .unwrap()
        .unwrap();
    windbell_action(
        &mut world,
        "rest-guest",
        "rest-once",
        WindbellAction::Rest,
        token,
    );
    assert_eq!(world.players["rest-guest"].state.hp, hp);
    assert_eq!(
        reopened
            .store
            .load_windbell_bridge_state("windbell")
            .unwrap()
            .unwrap(),
        saved
    );
    // Forged tokens and dead actors cannot consume the public pantry.
    windbell_action(
        &mut world,
        "rest-guest",
        "rest-forged",
        WindbellAction::Rest,
        Some("forged".to_owned()),
    );
    world.players.get_mut("rest-guest").unwrap().state.hp = 0;
    windbell_action(
        &mut world,
        "rest-guest",
        "rest-dead",
        WindbellAction::Rest,
        Some("shared:windbell-bridge".to_owned()),
    );
    assert_eq!(
        reopened
            .store
            .load_windbell_bridge_state("windbell")
            .unwrap()
            .unwrap(),
        saved
    );
    let _ = drain_windbell_output(&mut rx);
    drop(world);
    drop(reopened);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn windbell_learned_leafwing_reuses_movement_on_both_maps_and_lanzhi_remembers_only_meetings() {
    let mut world = windbell_world_for_test();
    let mut rx = join_test_player(&mut world, "wing-traveler");
    let island = enter_windbell_island(&mut world, "wing-traveler", &mut rx);
    walk_windbell(&mut world, "wing-traveler", &mut rx, 1, 500);
    world.players.get_mut("wing-traveler").unwrap().state.x = 2300.0;
    assert!(
        !world.players["wing-traveler"]
            .windbell_progress
            .leafwing_learned
    );
    windbell_action(
        &mut world,
        "wing-traveler",
        "learn-wing",
        WindbellAction::Talk,
        Some(island.clone()),
    );
    assert!(
        world.players["wing-traveler"]
            .windbell_progress
            .leafwing_learned,
        "at {},{} {:?}",
        world.players["wing-traveler"].state.x,
        world.players["wing-traveler"].state.y,
        drain_windbell_output(&mut rx)
            .into_iter()
            .filter(|m| m["type"] == "rejected")
            .collect::<Vec<_>>()
    );
    assert!(world.players["wing-traveler"]
        .windbell_dialogue
        .join("")
        .contains("教你"));
    let progress_json =
        serde_json::to_string(&world.players["wing-traveler"].windbell_progress).unwrap();
    windbell_action(
        &mut world,
        "wing-traveler",
        "leave-first",
        WindbellAction::Leave,
        Some(island),
    );
    windbell_action(
        &mut world,
        "wing-traveler",
        "cross-bridge",
        WindbellAction::EnterBridge,
        None,
    );
    let player = world.players.get_mut("wing-traveler").unwrap();
    player.state.x = 950.0;
    player.state.y = 600.0;
    player.state.grounded = false;
    player.foothold_id = 0;
    player.state.vy = 300.0;
    windbell_action(
        &mut world,
        "wing-traveler",
        "open-bridge-wing",
        WindbellAction::DeployLeafwing,
        Some("shared:windbell-bridge".into()),
    );
    let deadline = world.players["wing-traveler"].windbell_glide_until;
    assert!(deadline > world.tick);
    world.step();
    assert!(world.players["wing-traveler"].state.vy <= 75.0);
    windbell_action(
        &mut world,
        "wing-traveler",
        "no-extra-wing",
        WindbellAction::DeployLeafwing,
        Some("shared:windbell-bridge".into()),
    );
    assert_eq!(
        world.players["wing-traveler"].windbell_glide_until,
        deadline
    );
    windbell_action(
        &mut world,
        "wing-traveler",
        "leave-bridge-wing",
        WindbellAction::Leave,
        Some("shared:windbell-bridge".into()),
    );
    windbell_action(
        &mut world,
        "wing-traveler",
        "island-return",
        WindbellAction::EnterIsland,
        None,
    );
    let second_island = world.players["wing-traveler"].map_id.clone();
    // Serialization keeps the learned method and the witness's actual memory.
    world
        .players
        .get_mut("wing-traveler")
        .unwrap()
        .windbell_progress = serde_json::from_str(&progress_json).unwrap();
    let player = world.players.get_mut("wing-traveler").unwrap();
    player.state.x = 520.0;
    player.state.y = 450.0;
    player.state.grounded = false;
    player.foothold_id = 0;
    windbell_action(
        &mut world,
        "wing-traveler",
        "open-old-island",
        WindbellAction::DeployLeafwing,
        Some(second_island.clone()),
    );
    assert!(world.players["wing-traveler"].windbell_glide_until > world.tick);
    assert_eq!(
        windbell_snapshot(&world, "wing-traveler")["windbell"]["heat"],
        "dry",
        "a glider cannot ignite dry branches"
    );
    // Reach the same witness again using the still-open root route.
    let player = world.players.get_mut("wing-traveler").unwrap();
    player.state.x = 2300.0;
    player.state.y = 550.0;
    player.state.grounded = true;
    player.foothold_id = 4;
    world.step_windbell_player("wing-traveler");
    windbell_action(
        &mut world,
        "wing-traveler",
        "meet-again",
        WindbellAction::Talk,
        Some(second_island),
    );
    assert!(world.players["wing-traveler"]
        .windbell_dialogue
        .join("")
        .contains("上回在这里交谈时，你走的是根道"));
}

#[test]
fn windbell_archive_combines_real_combat_supply_witnesses_and_durable_history() {
    let shared = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared");
    let shipped = Gameplay::load(&shared.join("gameplay.json")).unwrap();
    let mut gameplay = Gameplay::default();
    gameplay.player = shipped.player;
    gameplay.drop_chance_denominator = shipped.drop_chance_denominator;
    gameplay.monsters = shipped
        .monsters
        .into_iter()
        .filter(|m| m.template_id == "100100")
        .collect();
    let path = std::env::temp_dir().join(format!("windbell-archive-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).unwrap();
    let config = WindbellConfig::load(&shared.join("windbell.json")).unwrap();
    let make_world = |store| {
        World::new_with_store(
            life_map("windbell-archive-home"),
            600,
            gameplay.clone(),
            store,
        )
        .unwrap()
        .with_windbell(config.clone())
        .unwrap()
    };
    let mut world = make_world(service.store.clone());
    let mut rx = join_test_player(&mut world, "archive-guest");
    windbell_action(
        &mut world,
        "archive-guest",
        "enter-archive",
        WindbellAction::EnterBridge,
        None,
    );
    let bridge = &mut world.windbell.as_mut().unwrap().bridge;
    bridge.source_planks = 0;
    bridge.source_ropes = 0;
    bridge.segments = [true; 3];
    bridge.cart_upright = true;
    bridge.cart_x = 1600.0;
    bridge.shipment = super::windbell::WindbellShipmentState::Arrived;
    world.step_windbell_life_at(100_000);
    let player = world.players.get_mut("archive-guest").unwrap();
    player.state.x = 1160.0;
    player.state.y = 950.0;
    player.state.facing = 1;
    player.state.grounded = true;
    player.foothold_id = 3;
    let mob = world.monsters.keys().next().unwrap().clone();
    world.monsters.get_mut(&mob).unwrap().state.x = 1200.0;
    let token = Some("shared:windbell-bridge".to_owned());
    windbell_action(
        &mut world,
        "archive-guest",
        "unsafe-paper",
        WindbellAction::DryRecords,
        token.clone(),
    );
    assert_eq!(
        windbell_snapshot(&world, "archive-guest")["windbell"]["livelihood"]["paperMoisture"],
        3
    );
    let before_exp = world.players["archive-guest"].state.exp;
    for attempt in 0..30 {
        if world.monsters[&mob].state.hp == 0 {
            break;
        }
        world.handle_attack("archive-guest".into(), format!("archive-attack-{attempt}"));
        world.tick += 50;
        world.resolve_pending_attacks();
        let _ = drain_windbell_output(&mut rx);
    }
    assert_eq!(
        world.monsters[&mob].state.hp, 0,
        "ordinary combat must clear the real creature"
    );
    assert!(world.players["archive-guest"].state.exp > before_exp);
    // Transaction failure cannot consume fuel, credit the witness, or leave a receipt.
    service.store.with_db(|db| db.execute_batch("CREATE TRIGGER reject_archive BEFORE INSERT ON windbell_player_state BEGIN SELECT RAISE(ABORT, 'paper failure'); END;").map_err(|e| e.to_string())).unwrap();
    windbell_action(
        &mut world,
        "archive-guest",
        "paper-0",
        WindbellAction::DryRecords,
        token.clone(),
    );
    assert!(
        !world.players["archive-guest"]
            .windbell_progress
            .archive_helped
    );
    assert_eq!(
        windbell_snapshot(&world, "archive-guest")["windbell"]["livelihood"]["shelter"],
        4
    );
    service
        .store
        .with_db(|db| {
            db.execute_batch("DROP TRIGGER reject_archive")
                .map_err(|e| e.to_string())
        })
        .unwrap();
    for n in 0..3 {
        windbell_action(
            &mut world,
            "archive-guest",
            &format!("paper-{n}"),
            WindbellAction::DryRecords,
            token.clone(),
        );
    }
    let saved = service
        .store
        .load_windbell_bridge_state("windbell")
        .unwrap()
        .unwrap();
    windbell_action(
        &mut world,
        "archive-guest",
        "paper-0",
        WindbellAction::DryRecords,
        token.clone(),
    );
    windbell_action(
        &mut world,
        "archive-guest",
        "burn-paper",
        WindbellAction::DryRecords,
        token.clone(),
    );
    assert_eq!(
        service
            .store
            .load_windbell_bridge_state("windbell")
            .unwrap()
            .unwrap(),
        saved
    );
    windbell_action(
        &mut world,
        "archive-guest",
        "read-paper",
        WindbellAction::Talk,
        token.clone(),
    );
    assert!(
        world.players["archive-guest"]
            .windbell_progress
            .archive_read
    );
    assert!(world.players["archive-guest"]
        .windbell_dialogue
        .join("")
        .contains("托住湿纸的手"));
    let receipt = service
        .store
        .load_windbell_action("archive-guest", "paper-0")
        .unwrap()
        .unwrap()
        .1;
    let expired_sequence = serde_json::from_str::<serde_json::Value>(&receipt).unwrap()["sequence"]
        .as_u64()
        .unwrap();
    for n in 0..70 {
        windbell_action(
            &mut world,
            "archive-guest",
            &format!("reread-{n}"),
            WindbellAction::Talk,
            token.clone(),
        );
        let _ = drain_windbell_output(&mut rx);
    }
    let count: i64 = service
        .store
        .with_db(|db| {
            db.query_row(
                "SELECT COUNT(*) FROM windbell_action_log WHERE account_id='archive-guest'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())
        })
        .unwrap();
    assert_eq!(count, 64);
    assert!(service
        .store
        .load_windbell_action("archive-guest", "paper-0")
        .unwrap()
        .is_none());
    // A late visitor can read the same public result without acquiring another person's credit.
    let _late = join_test_player(&mut world, "archive-late");
    windbell_action(
        &mut world,
        "archive-late",
        "late-enter",
        WindbellAction::EnterBridge,
        None,
    );
    let late = world.players.get_mut("archive-late").unwrap();
    late.state.x = 1200.0;
    late.state.y = 950.0;
    windbell_action(
        &mut world,
        "archive-late",
        "late-read",
        WindbellAction::Talk,
        token.clone(),
    );
    assert!(world.players["archive-late"].windbell_progress.archive_read);
    assert!(
        !world.players["archive-late"]
            .windbell_progress
            .archive_helped
    );
    assert!(!world.players["archive-late"]
        .windbell_dialogue
        .join("")
        .contains("托住湿纸的手"));
    // Public-route failure uses the existing tombstone/revive contract; no duplicate death system.
    assert!(
        world
            .commit_incoming_damage("archive-guest", 100_000)
            .unwrap()
            .2
    );
    assert!(!world.death_tombstones.is_empty());
    windbell_action(
        &mut world,
        "archive-guest",
        "leave-while-dead",
        WindbellAction::Leave,
        token.clone(),
    );
    assert_eq!(
        world.players["archive-guest"].state.action, "dead",
        "returning must not disguise death as a living stand pose"
    );
    assert_eq!(world.players["archive-guest"].state.hp, 0);
    world.handle_revive("archive-guest".into(), "archive-revive".into());
    assert!(world.players["archive-guest"].state.hp > 0);
    assert!(!world.death_tombstones.is_empty());
    drop(world);
    let mut restored = make_world(service.store.clone());
    let mut returned = join_test_player(&mut restored, "archive-guest");
    assert!(
        restored.players["archive-guest"]
            .windbell_progress
            .archive_read
    );
    assert!(
        restored.players["archive-guest"]
            .windbell_progress
            .archive_helped
    );
    assert_eq!(
        service
            .store
            .load_windbell_bridge_state("windbell")
            .unwrap()
            .unwrap(),
        saved
    );
    assert!(!restored.death_tombstones.is_empty());
    restored.handle_windbell(
        "archive-guest".into(),
        "paper-0".into(),
        expired_sequence,
        WindbellAction::DryRecords,
        token,
    );
    assert!(
        drain_windbell_output(&mut returned)
            .iter()
            .any(|m| m["type"] == "rejected" && m["code"] == "windbell_sequence"),
        "pruned requests remain permanently spent after reopening"
    );
    drop(restored);
    drop(service);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}
