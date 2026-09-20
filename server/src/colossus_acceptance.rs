#[test]
fn colossus_public_bridge_transaction_entry_leave_and_late_arrival() {
    use crate::protocol::ColossusAction;
    let path = std::env::temp_dir().join(format!("colossus-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).unwrap();
    let make = |store| {
        World::new_with_store(life_map("harbor-home"), 600, Gameplay::default(), store)
            .unwrap()
            .with_colossus()
            .unwrap()
    };
    let mut world = make(service.store.clone());
    let mut a = join_test_player(&mut world, "harbor-a");
    let mut b = join_test_player(&mut world, "harbor-b");
    let home = world.players["harbor-a"].map_id.clone();
    world.handle_colossus("harbor-a".into(), "enter".into(), 1, ColossusAction::Enter);
    world.handle_colossus(
        "harbor-b".into(),
        "enter-b".into(),
        1,
        ColossusAction::Enter,
    );
    assert_eq!(world.players["harbor-a"].map_id, super::colossus::MAP_ID);
    let r = world.colossus.as_ref().unwrap();
    let body = super::colossus::motion::Body::new(&r.config, "harbor", 46.0, &r.frame);
    world
        .players
        .get_mut("harbor-a")
        .unwrap()
        .colossus
        .as_mut()
        .unwrap()
        .body = body;
    service.store.with_db(|db|db.execute_batch("CREATE TRIGGER refuse_colossus BEFORE UPDATE ON colossus_world BEGIN SELECT RAISE(FAIL,'injected'); END;").map_err(|e|e.to_string())).unwrap();
    world.attack_colossus("harbor-a", "cut-failed");
    assert!(world
        .colossus
        .as_ref()
        .unwrap()
        .facts
        .bridge_opened_ms
        .is_none());
    service
        .store
        .with_db(|db| {
            db.execute_batch("DROP TRIGGER refuse_colossus")
                .map_err(|e| e.to_string())
        })
        .unwrap();
    world.attack_colossus("harbor-a", "cut");
    let saved = service.store.load_colossus().unwrap().unwrap();
    assert!(saved.contains("harbor-a"));
    world.attack_colossus("harbor-a", "cut");
    assert_eq!(saved, service.store.load_colossus().unwrap().unwrap());
    world.handle_colossus("harbor-b".into(), "skip".into(), 2, ColossusAction::Skip);
    let late = world.colossus_snapshot("harbor-b").unwrap();
    assert_eq!(late["helped"], false);
    assert_eq!(late["actors"].as_array().unwrap().len(), 2);
    let before = world.players["harbor-b"].colossus.as_ref().unwrap().body.s;
    world.handle_colossus("harbor-b".into(), "stale".into(), 1, ColossusAction::Leave);
    assert_eq!(
        before,
        world.players["harbor-b"].colossus.as_ref().unwrap().body.s
    );
    world.handle_colossus("harbor-a".into(), "leave".into(), 2, ColossusAction::Leave);
    assert_eq!(world.players["harbor-a"].map_id, home);
    let _ = drain_windbell_output(&mut a);
    let _ = drain_windbell_output(&mut b);
    drop(world);
    let recovered = make(service.store.clone());
    assert_eq!(recovered.colossus.as_ref().unwrap().bridge_age, Some(1.5));
    assert_eq!(
        recovered.colossus.unwrap().facts.opened_by.as_deref(),
        Some("harbor-a")
    );
    let unopened = super::colossus::Facts {
        started_ms: Some(unix_now_ms() - 180_000),
        ..Default::default()
    };
    service
        .store
        .save_colossus(&serde_json::to_string(&unopened).unwrap())
        .unwrap();
    let waiting = make(service.store.clone());
    assert!(waiting
        .colossus
        .unwrap()
        .people
        .iter()
        .take(6)
        .all(|p| p.s <= 44.0));
    let completed = super::colossus::Facts {
        started_ms: Some(unix_now_ms() + 180_000),
        bridge_opened_ms: Some(unix_now_ms() + 180_000),
        awakened: true,
        ..Default::default()
    };
    service
        .store
        .save_colossus(&serde_json::to_string(&completed).unwrap())
        .unwrap();
    let backwards = make(service.store.clone()).colossus.unwrap();
    assert_eq!(backwards.seconds, 65.0);
    assert_eq!(backwards.bridge_age, Some(1.5));
    drop(service);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn colossus_commands_reject_forgery_and_resume_one_resident() {
    use crate::protocol::ColossusAction;
    let mut world = World::new(life_map("home"), 600).with_colossus().unwrap();
    let mut rx = join_test_player(&mut world, "rider");
    let intent = |connection: &str, sequence, action| Command::Input {
        id: "rider".into(),
        connection: connection.into(),
        message: ClientMessage::Colossus {
            request_id: format!("action-{sequence}"),
            sequence,
            action,
        },
    };
    world.command(intent("forged", 1, ColossusAction::Enter));
    assert!(world.players["rider"].colossus.is_none());
    world.command(intent("rider-connection", 1, ColossusAction::Enter));
    world.command(intent("rider-connection", 2, ColossusAction::Board));
    assert_eq!(
        world.players["rider"].colossus.as_ref().unwrap().body.track,
        "harbor"
    );
    let input = |seq, direction| Command::Input {
        id: "rider".into(),
        connection: "rider-connection".into(),
        message: ClientMessage::Input {
            seq,
            direction,
            vertical: 0,
            jump: false,
        },
    };
    world.command(input(2, 1));
    world.command(input(1, -1));
    assert_eq!(world.players["rider"].direction, 1);
    world.command(intent("rider-connection", 3, ColossusAction::Skip));
    let before = world.players["rider"].colossus.as_ref().unwrap().body.s;
    let _ = drain_windbell_output(&mut rx);
    drop(rx);
    world.broadcast_to_map(super::colossus::MAP_ID, "closed-channel-probe");
    assert!(world.players["rider"].detached);
    let mut next = join_test_player(&mut world, "rider");
    assert_eq!(world.players.len(), 1);
    assert_eq!(world.players["rider"].direction, 0);
    assert_eq!(
        world.players["rider"].colossus.as_ref().unwrap().body.s,
        before
    );
    world.command(intent(
        "rider-connection",
        9_007_199_254_740_991,
        ColossusAction::Leave,
    ));
    assert!(world.players["rider"].colossus.is_some());
    let snapshot = world.colossus_snapshot("rider").unwrap();
    assert_eq!(snapshot["sequence"], 3);
    let _ = drain_windbell_output(&mut next);
    drop(next);
    world.step();
    assert!(world.players["rider"].detached);
    assert!(world.players["rider"].colossus.is_some());
    assert!(serde_json::from_str::<ClientMessage>(
        r#"{"type":"colossus","action":"enter","requestId":"x","sequence":1,"position":[0,0,0]}"#
    )
    .is_err());
}

#[test]
fn colossus_six_district_passages_preserve_control_and_spiral_height() {
    use super::colossus::motion::{Body, Frame};
    use crate::protocol::ColossusAction;
    let mut world = World::new(life_map("home"), 600).with_colossus().unwrap();
    let mut rx = join_test_player(&mut world, "walker");
    world.handle_colossus("walker".into(), "enter".into(), 1, ColossusAction::Enter);
    let config = world.colossus.as_ref().unwrap().config.clone();
    let frame = Frame::at(90.0, 1);
    world.colossus.as_mut().unwrap().seconds = 90.0;
    world.colossus.as_mut().unwrap().frame = frame.clone();
    // The passage graph, not a menu of arbitrary client destinations, connects all six gardens.
    let mut seen = std::collections::BTreeSet::from(["harbor".to_string()]);
    loop {
        let old = seen.len();
        for p in &config.passages {
            if seen.contains(&config.tracks[&p.track].region) {
                seen.insert(config.tracks[&p.to_track].region.clone());
            }
        }
        if seen.len() == old {
            break;
        }
    }
    assert_eq!(seen.len(), 6);
    assert!(config.regions.keys().all(|r| config
        .tracks
        .values()
        .filter(|t| &t.region == r)
        .map(|t| t.len())
        .sum::<f64>()
        > 600.0));
    // Remote use has no effect. Every authored gate can then be crossed and retains held motion.
    world.handle_colossus("walker".into(), "too-far".into(), 2, ColossusAction::Travel);
    assert_eq!(
        world.players["walker"]
            .colossus
            .as_ref()
            .unwrap()
            .body
            .track,
        "harbor"
    );
    let mut seq = 2;
    for gate in config
        .passages
        .iter()
        .filter(|g| !(g.track == "climb" && g.to_track == "harbor"))
    {
        let rider = world
            .players
            .get_mut("walker")
            .unwrap()
            .colossus
            .as_mut()
            .unwrap();
        rider.body = Body::new(&config, &gate.track, gate.s, &frame);
        rider.body.speed = 3.0;
        rider.passage_after = 0;
        world.players.get_mut("walker").unwrap().direction = 1;
        seq += 1;
        world.handle_colossus(
            "walker".into(),
            format!("gate-{seq}"),
            seq,
            ColossusAction::Travel,
        );
        let p = &world.players["walker"];
        let body = &p.colossus.as_ref().unwrap().body;
        assert_eq!(body.track, gate.to_track, "{}", gate.id);
        assert!((body.s - gate.to_s).abs() < 0.01);
        assert_eq!(body.speed, 3.0);
        assert_eq!(p.direction, 1);
        let _ = drain_windbell_output(&mut rx);
    }
    world
        .players
        .get_mut("walker")
        .unwrap()
        .colossus
        .as_mut()
        .unwrap()
        .body = Body::new(&config, "town", 100.0, &frame);
    world.handle_colossus(
        "walker".into(),
        "skip-away".into(),
        seq + 1,
        ColossusAction::Skip,
    );
    assert_eq!(
        world.players["walker"]
            .colossus
            .as_ref()
            .unwrap()
            .body
            .track,
        "town"
    );
    assert_eq!(
        world.players["walker"].colossus.as_ref().unwrap().body.s,
        100.0
    );
    let mut body = Body::new(
        &config,
        "heights",
        config.tracks["heights"].len() - 1.0,
        &frame,
    );
    let y = body.position[1];
    body.step(&config, &frame, &frame, true, 0, true, 0.05);
    for _ in 0..80 {
        body.step(&config, &frame, &frame, true, 0, false, 0.05);
    }
    assert!(body.grounded);
    assert!(
        (body.position[1] - y).abs() < 0.05,
        "upper spiral must not land on its lower turn"
    );
    assert!(serde_json::from_str::<ClientMessage>(r#"{"type":"colossus","requestId":"forged","sequence":99,"action":"travel","toTrack":"gardens"}"#).is_err());
}

#[test]
fn colossus_npc_uses_existing_dialogue_with_authoritative_proximity() {
    use crate::protocol::ColossusAction;
    let mut world = World::new(life_map("home"), 600).with_colossus().unwrap();
    let mut rx = join_test_player(&mut world, "speaker");
    world.handle_colossus("speaker".into(), "enter".into(), 1, ColossusAction::Enter);
    drain_windbell_output(&mut rx);
    world.talk_colossus("speaker", "forged", "10201", Some("start"));
    assert!(drain_windbell_output(&mut rx)
        .iter()
        .any(|m| m["type"] == "rejected"));
    world.talk_colossus("speaker", "remote", "colossus-person-6", Some("start"));
    assert!(drain_windbell_output(&mut rx)
        .iter()
        .any(|m| m["type"] == "rejected"));
    let npc = world.colossus.as_ref().unwrap().people[6].clone();
    world
        .players
        .get_mut("speaker")
        .unwrap()
        .colossus
        .as_mut()
        .unwrap()
        .body = npc;
    world.talk_colossus("speaker", "near", "colossus-person-6", Some("start"));
    let messages = drain_windbell_output(&mut rx);
    assert!(messages
        .iter()
        .any(|m| m["type"] == "npcResult" && m["dialog"]["kind"] == "ok"));
    world.talk_colossus("speaker", "selection", "colossus-person-6", Some("select"));
    assert!(drain_windbell_output(&mut rx)
        .iter()
        .any(|m| m["type"] == "rejected"));
    world
        .players
        .get_mut("speaker")
        .unwrap()
        .colossus
        .as_mut()
        .unwrap()
        .body
        .position[0] += 100.0;
    world.talk_colossus("speaker", "end", "colossus-person-6", Some("end"));
    assert!(drain_windbell_output(&mut rx)
        .iter()
        .any(|m| m["type"] == "npcResult" && m["ended"] == true));
    assert!(world.colossus.as_ref().unwrap().bridge_age.is_none());
}

#[test]
fn colossus_climbing_uses_vertical_input_and_bone_attachment() {
    use super::colossus::motion::{Body, Frame};
    use crate::protocol::ColossusAction;
    let mut world = World::new(life_map("home"), 600).with_colossus().unwrap();
    let _rx = join_test_player(&mut world, "climber");
    world.handle_colossus("climber".into(), "enter".into(), 1, ColossusAction::Enter);
    let runtime = world.colossus.as_mut().unwrap();
    runtime.seconds = 90.0;
    runtime.frame = Frame::at(90.0, 1);
    runtime.previous = Frame::at(89.95, 0);
    let c = runtime.config.clone();
    let f = runtime.frame.clone();
    world
        .players
        .get_mut("climber")
        .unwrap()
        .colossus
        .as_mut()
        .unwrap()
        .body = Body::new(&c, "harbor", c.tracks["harbor"].len(), &f);
    world.handle_colossus("climber".into(), "climb".into(), 2, ColossusAction::Board);
    assert_eq!(
        world.players["climber"]
            .colossus
            .as_ref()
            .unwrap()
            .body
            .track,
        "climb"
    );
    world.players.get_mut("climber").unwrap().vertical = -1;
    let y = world.players["climber"]
        .colossus
        .as_ref()
        .unwrap()
        .body
        .position[1];
    for _ in 0..20 {
        world.step_colossus_player("climber");
    }
    assert!(world.players["climber"].state.climbing);
    assert!(
        world.players["climber"]
            .colossus
            .as_ref()
            .unwrap()
            .body
            .position[1]
            > y + 3.0
    );
    world.players.get_mut("climber").unwrap().vertical = 0;
    for _ in 0..20 {
        world.step_colossus_player("climber");
    }
    let still = world.players["climber"].colossus.as_ref().unwrap().body.s;
    for _ in 0..20 {
        world.step_colossus_player("climber");
    }
    assert_eq!(
        world.players["climber"].colossus.as_ref().unwrap().body.s,
        still
    );
    world.players.get_mut("climber").unwrap().vertical = 1;
    for _ in 0..60 {
        world.step_colossus_player("climber");
    }
    assert_eq!(
        world.players["climber"]
            .colossus
            .as_ref()
            .unwrap()
            .body
            .track,
        "harbor"
    );
}
