use super::windbell::{WindbellArrivalPath, WindbellConfig};
use crate::protocol::{ClientMessage, WindbellAction};

fn windbell_config_for_test() -> WindbellConfig {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("shared")
        .join("windbell.json");
    WindbellConfig::load(&path).expect("shared Windbell data should load")
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
    world.command(Command::Input {
        id: id.to_owned(),
        connection: format!("{id}-connection"),
        message: ClientMessage::Windbell {
            request_id: request_id.to_owned(),
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
