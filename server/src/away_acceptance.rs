// Acceptance matrix for Web background retention and away residency.
//
// Core invariant under test: a transport ending is not a character ending.
// The authoritative character keeps its world entity, map, and social
// identity; only the control binding is released.  A later connection takes
// over the same character instead of creating a second one.
//
// Time is never waited on.  Away stages are derived from `Instant`, so these
// tests drive them by rewriting the window's `started` field — the same field
// the production sweep reads — rather than by sleeping for ten minutes.

use super::*;

#[test]
fn a16_current_controller_can_resume_without_renewing_passive_absence() {
    let mut world = away_world();
    let mut output = join(&mut world, "resume", "old");
    world.command(Command::Detach {
        id: "resume".into(),
        connection: "old".into(),
        reason: AwayReason::TransportLost,
    });
    age_away(&mut world, "resume", 650);
    let mut rebound = join(&mut world, "resume", "new");
    let lifecycle = |connection: &str, away| Command::Input {
        id: "resume".into(),
        connection: connection.into(),
        message: ClientMessage::Lifecycle {
            hidden: false,
            away,
            client_now_ms: None,
        },
    };
    world.command(lifecycle("old", Some(false)));
    world.command(lifecycle("new", None));
    world.command(Command::Input {
        id: "resume".into(),
        connection: "new".into(),
        message: ClientMessage::Input {
            seq: 1,
            direction: 0,
            vertical: 0,
            jump: false,
        },
    });
    assert!(
        world.players["resume"].away.is_some(),
        "old connection, visibility and idle heartbeats cannot extend absence"
    );
    world.command(lifecycle("new", Some(false)));
    assert!(
        world.players["resume"].away.is_none(),
        "Continue Adventure must actually resume the resident"
    );
    world.command(Command::Input {
        id: "resume".into(),
        connection: "new".into(),
        message: ClientMessage::Lifecycle {
            hidden: true,
            away: None,
            client_now_ms: None,
        },
    });
    world.command(Command::Input {
        id: "resume".into(),
        connection: "new".into(),
        message: ClientMessage::Input {
            seq: 2,
            direction: 1,
            vertical: 0,
            jump: false,
        },
    });
    assert!(
        world.players["resume"].away.is_none(),
        "fresh movement ends a real return without waiting for a ten-minute notice"
    );
    world.command(Command::Input {
        id: "resume".into(),
        connection: "new".into(),
        message: ClientMessage::Lifecycle {
            hidden: true,
            away: None,
            client_now_ms: None,
        },
    });
    age_away(&mut world, "resume", 3700);
    world.command(lifecycle("new", Some(false)));
    assert!(
        !world.players.contains_key("resume"),
        "an expired resident cannot be revived by a late resume"
    );
    while output.try_recv().is_ok() {}
    while rebound.try_recv().is_ok() {}
}

fn away_world() -> World {
    World::new(map(), 600)
}

fn join(world: &mut World, id: &str, connection: &str) -> mpsc::Receiver<String> {
    let (output, rx) = mpsc::channel(128);
    let (reply, _) = oneshot::channel();
    world.command(Command::Join {
        identity: Identity {
            id: id.to_owned(),
            username: id.to_owned(),
        },
        connection: connection.to_owned(),
        output,
        reply,
        lang: "zh".to_owned(),
    });
    rx
}

/// Rewind an away window so the elapsed time equals `secs`, letting a stage
/// boundary be tested without waiting for it.
fn age_away(world: &mut World, id: &str, secs: u64) {
    let player = world.players.get_mut(id).expect("player exists");
    let away = player.away.as_mut().expect("away window open");
    away.started = Instant::now() - Duration::from_secs(secs);
}

fn snapshot_players(world: &World, viewer: &str) -> Vec<serde_json::Value> {
    let raw = world.snapshot(viewer);
    serde_json::from_str::<serde_json::Value>(&raw)
        .expect("snapshot is JSON")
        .get("players")
        .and_then(|players| players.as_array())
        .cloned()
        .unwrap_or_default()
}

fn row<'a>(players: &'a [serde_json::Value], id: &str) -> &'a serde_json::Value {
    players
        .iter()
        .find(|row| row["id"].as_str() == Some(id))
        .expect("character present in snapshot")
}

#[test]
fn a01_detach_keeps_the_character_in_the_world() {
    let mut world = away_world();
    let mut rx = join(&mut world, "a", "c1");
    world.step();
    // A silent or closed socket detaches the control link only.
    world.command(Command::Detach {
        id: "a".into(),
        connection: "c1".into(),
        reason: AwayReason::TransportLost,
    });
    assert!(world.players.contains_key("a"), "character must survive its transport");
    assert!(world.players["a"].detached);
    assert!(world.players["a"].away.is_some(), "a detach opens an away window");
    // The world keeps simulating it: gravity still applies.
    let before = world.players["a"].state.y;
    for _ in 0..10 {
        world.step();
    }
    assert!(world.players.contains_key("a"), "resident character must not be swept");
    assert_ne!(world.players["a"].state.y, before, "world rules keep running");
}

#[test]
fn a02_observer_still_sees_a_resident_character() {
    let mut world = away_world();
    let mut rx1 = join(&mut world, "a", "c1");
    let mut observer = join(&mut world, "b", "c2");
    world.step();
    world.command(Command::Detach {
        id: "a".into(),
        connection: "c1".into(),
        reason: AwayReason::Hidden,
    });
    age_away(&mut world, "a", 700);
    world.step();
    // Drain the observer's own snapshot traffic, then take a fresh look.
    let latest = snapshot_players(&world, "b");
    assert!(
        row(&latest, "a").get("away").is_some(),
        "residents stay visible with an away marker"
    );
    assert_eq!(row(&latest, "a")["away"]["residency"], true);
    while observer.try_recv().is_ok() {}
}

#[test]
fn a03_reconnect_takes_over_the_same_character() {
    let mut world = away_world();
    let mut rx2 = join(&mut world, "a", "c1");
    for _ in 0..20 {
        world.step();
    }
    let position = world.players["a"].state.x;
    world.command(Command::Detach {
        id: "a".into(),
        connection: "c1".into(),
        reason: AwayReason::TransportLost,
    });
    let mut taken_over = join(&mut world, "a", "c2");
    assert_eq!(world.players.len(), 1, "no duplicate character entity");
    assert_eq!(world.players["a"].connection, "c2");
    assert!(!world.players["a"].detached);
    assert_eq!(world.players["a"].state.x, position, "world facts are not rewound");
    assert!(
        taken_over.try_recv().is_ok(),
        "the new connection receives a snapshot on takeover"
    );
}

#[test]
fn a04_late_close_from_a_superseded_connection_is_ignored() {
    let mut world = away_world();
    let mut rx3 = join(&mut world, "a", "c1");
    world.step();
    let mut rx4 = join(&mut world, "a", "c2");
    assert_eq!(world.players["a"].connection, "c2");
    // The old socket finally notices it is closed, after the takeover.
    world.command(Command::Detach {
        id: "a".into(),
        connection: "c1".into(),
        reason: AwayReason::TransportLost,
    });
    assert_eq!(
        world.players["a"].connection, "c2",
        "a stale close must not evict the new controller"
    );
    assert!(!world.players["a"].detached);
}

#[test]
fn a05_repeated_away_reports_never_restart_the_window() {
    let mut world = away_world();
    let mut rx5 = join(&mut world, "a", "c1");
    world.step();
    world.command(Command::Input {
        id: "a".into(),
        connection: "c1".into(),
        message: ClientMessage::Lifecycle {
            hidden: true,
            away: None,
            client_now_ms: None,
        },
    });
    let first_id = world.players["a"].away.as_ref().expect("window opened").id;
    age_away(&mut world, "a", 500);
    // Re-hiding, reconnecting, or re-reporting must not buy more time.
    world.command(Command::Input {
        id: "a".into(),
        connection: "c1".into(),
        message: ClientMessage::Lifecycle {
            hidden: true,
            away: Some(true),
            client_now_ms: None,
        },
    });
    world.command(Command::Detach {
        id: "a".into(),
        connection: "c1".into(),
        reason: AwayReason::TransportLost,
    });
    assert_eq!(world.players["a"].away.as_ref().expect("window kept").id, first_id);
    assert_eq!(
        world.players["a"].away.as_ref().unwrap().elapsed(Instant::now()).as_secs(),
        500,
        "the original start is preserved"
    );
}

#[test]
fn a06_detach_clears_held_input_so_the_character_does_not_keep_acting() {
    let mut world = away_world();
    let mut rx6 = join(&mut world, "a", "c1");
    for _ in 0..20 {
        world.step();
    }
    world.command(Command::Input {
        id: "a".into(),
        connection: "c1".into(),
        message: ClientMessage::Input {
            seq: 1,
            direction: 1,
            vertical: 0,
            jump: false,
        },
    });
    assert_eq!(world.players["a"].direction, 1);
    world.command(Command::Detach {
        id: "a".into(),
        connection: "c1".into(),
        reason: AwayReason::Hidden,
    });
    assert_eq!(world.players["a"].direction, 0, "a held key must not survive leaving");
    assert_eq!(world.players["a"].vertical, 0);
    assert!(!world.players["a"].jump);
    let x = world.players["a"].state.x;
    for _ in 0..10 {
        world.step();
    }
    assert_eq!(world.players["a"].state.x, x, "no unauthorized walking while away");
}

#[test]
fn a07_grace_then_residency_then_exit_follow_one_window() {
    let mut world = away_world();
    let mut rx7 = join(&mut world, "a", "c1");
    world.step();
    world.command(Command::Detach {
        id: "a".into(),
        connection: "c1".into(),
        reason: AwayReason::Hidden,
    });
    // Under the threshold: still in grace, still present.
    age_away(&mut world, "a", AWAY_FULL_RETENTION.as_secs() - 1);
    world.step();
    assert!(world.players.contains_key("a"));
    assert_eq!(
        world.players["a"].away.as_ref().unwrap().phase(Instant::now()),
        AwayPhase::Grace
    );
    // Exactly at the threshold: basic residency, character stays.
    age_away(&mut world, "a", AWAY_FULL_RETENTION.as_secs());
    world.step();
    assert!(world.players.contains_key("a"), "residency keeps the character");
    assert_eq!(
        world.players["a"].away.as_ref().unwrap().phase(Instant::now()),
        AwayPhase::Idle
    );
    // At the hard bound: the normal exit path runs exactly once.
    age_away(&mut world, "a", AWAY_MAX_TOTAL.as_secs());
    world.step();
    assert!(!world.players.contains_key("a"), "residency must be reclaimed");
    world.step();
    assert!(!world.players.contains_key("a"), "exit is idempotent");
}

#[test]
fn a08_residency_recovery_does_not_pay_out_away_time() {
    let mut world = away_world();
    let mut rx8 = join(&mut world, "a", "c1");
    for _ in 0..20 {
        world.step();
    }
    {
        let player = world.players.get_mut("a").unwrap();
        player.state.hp = 1;
        player.natural_recovery_next_tick = world.tick;
    }
    world.command(Command::Detach {
        id: "a".into(),
        connection: "c1".into(),
        reason: AwayReason::Hidden,
    });
    age_away(&mut world, "a", 900);
    world.tick += 10_000;
    let mut rx9 = join(&mut world, "a", "c2");
    // The recovery boundary restarts from the takeover tick, so the time spent
    // away is not converted into free HP.
    assert!(
        world.players["a"].natural_recovery_next_tick > world.tick,
        "away time must not be credited as recovery"
    );
    assert_eq!(world.players["a"].state.hp, 1);
}

#[test]
fn a09_explicit_exit_removes_the_character_but_a_forged_id_does_not() {
    let mut world = away_world();
    let mut rx10 = join(&mut world, "a", "c1");
    world.step();
    // An exit from a connection that does not own the character is refused.
    world.command(Command::Exit {
        id: "a".into(),
        connection: Some("forged".into()),
    });
    assert!(world.players.contains_key("a"), "a forged exit must be ignored");
    // The owning connection can leave for real.
    world.command(Command::Exit {
        id: "a".into(),
        connection: Some("c1".into()),
    });
    assert!(!world.players.contains_key("a"));
}

#[test]
fn a10_full_output_queue_never_deletes_the_character() {
    let mut world = away_world();
    // A tiny channel fills immediately; the world must drop the snapshot,
    // not the player.
    let (output, mut rx) = mpsc::channel(1);
    let (reply, _) = oneshot::channel();
    world.command(Command::Join {
        identity: Identity {
            id: "a".into(),
            username: "alice".into(),
        },
        connection: "c1".into(),
        output,
        reply,
        lang: "zh".to_owned(),
    });
    for _ in 0..20 {
        world.step();
    }
    let _ = rx.try_recv();
    for _ in 0..50 {
        world.step();
    }
    assert!(
        world.players.contains_key("a"),
        "a slow or frozen client must not lose its character"
    );
    while rx.try_recv().is_ok() {}
}

#[test]
fn a11_away_policy_is_ordered_and_bounded() {
    assert!(
        AWAY_FULL_RETENTION > Duration::ZERO && AWAY_FULL_RETENTION < AWAY_MAX_TOTAL,
        "full retention must be a positive, strictly shorter window"
    );
    let window = AwayWindow::new(1, AwayReason::Hidden);
    let now = Instant::now();
    assert_eq!(window.phase(now), AwayPhase::Grace);
    assert_eq!(
        window.phase(now + AWAY_FULL_RETENTION),
        AwayPhase::Idle,
        "reaching the threshold enters residency"
    );
    assert_eq!(
        window.phase(now + AWAY_MAX_TOTAL),
        AwayPhase::ExitDue,
        "reaching the bound requests the normal exit"
    );
    assert!(
        window.remaining_until_exit_ms(now) <= AWAY_MAX_TOTAL.as_millis() as i64,
        "remaining time is bounded by the policy"
    );
}

#[test]
fn a12_stage_transitions_are_announced_once_per_window() {
    let mut world = away_world();
    let mut rx11 = join(&mut world, "a", "c1");
    world.step();
    world.command(Command::Detach {
        id: "a".into(),
        connection: "c1".into(),
        reason: AwayReason::Hidden,
    });
    age_away(&mut world, "a", AWAY_FULL_RETENTION.as_secs());
    // Many ticks past the boundary: the transition is not replayed and the
    // character is still the same one.
    for _ in 0..25 {
        world.step();
    }
    assert!(world.players.contains_key("a"));
    assert_eq!(
        world.players["a"].away.as_ref().unwrap().announced,
        AwayPhase::Idle,
        "the stage is recorded once, not re-run every tick"
    );
}


#[test]
fn a13_explicit_logout_removes_the_character_while_a_plain_close_does_not() {
    // Switching characters must not leave the previous one standing in the
    // world, but a tab switch or reload (a bare socket close) must.
    let mut world = away_world();
    let mut rx = join(&mut world, "a", "c1");
    world.step();
    world.command(Command::Input {
        id: "a".into(),
        connection: "c1".into(),
        message: ClientMessage::Logout,
    });
    assert!(
        !world.players.contains_key("a"),
        "an explicit logout removes the character"
    );
    while rx.try_recv().is_ok() {}

    // The same close without a logout keeps the character resident.
    let mut rx2 = join(&mut world, "b", "c2");
    world.step();
    world.command(Command::Detach {
        id: "b".into(),
        connection: "c2".into(),
        reason: AwayReason::TransportLost,
    });
    assert!(world.players.contains_key("b"), "a plain close keeps the character");
    while rx2.try_recv().is_ok() {}
}

#[test]
fn a14_takeover_resets_the_input_sequence_so_the_character_can_move_again() {
    // Regression: reusing the Player row kept the previous session's input
    // high-water mark, so every fresh packet from the new client looked stale
    // and was dropped — the character was frozen and could not move.
    let mut world = away_world();
    let mut rx1 = join(&mut world, "a", "c1");
    for _ in 0..20 {
        world.step();
    }
    for seq in 1..=50 {
        world.command(Command::Input {
            id: "a".into(),
            connection: "c1".into(),
            message: ClientMessage::Input { seq, direction: 1, vertical: 0, jump: false },
        });
    }
    assert_eq!(world.players["a"].state.last_input_seq, 50);
    world.command(Command::Detach {
        id: "a".into(),
        connection: "c1".into(),
        reason: AwayReason::TransportLost,
    });
    let mut rx2 = join(&mut world, "a", "c2");
    assert_eq!(
        world.players["a"].state.last_input_seq, 0,
        "the sequence resets so the new client's packets are accepted"
    );
    // The new client starts at 1 again; the very first packet must land.
    world.command(Command::Input {
        id: "a".into(),
        connection: "c2".into(),
        message: ClientMessage::Input { seq: 1, direction: 1, vertical: 0, jump: false },
    });
    assert_eq!(world.players["a"].direction, 1, "the character must be controllable again");
    while rx1.try_recv().is_ok() {}
    while rx2.try_recv().is_ok() {}
}

#[test]
fn a15_switching_characters_removes_the_old_one_and_the_new_one_moves() {
    // The exact reported flow: log in as A, log out, log in as B, then come
    // back to A.  A must not linger in the world, and once it returns it must
    // be controllable.
    let mut world = away_world();
    // Session 1: play A.
    let mut rx_a1 = join(&mut world, "A", "s1");
    for _ in 0..20 {
        world.step();
    }
    for seq in 1..=30 {
        world.command(Command::Input {
            id: "A".into(),
            connection: "s1".into(),
            message: ClientMessage::Input { seq, direction: 1, vertical: 0, jump: false },
        });
    }
    world.step();
    // Logout (not merely a socket close): A must leave the world.
    world.command(Command::Input {
        id: "A".into(),
        connection: "s1".into(),
        message: ClientMessage::Logout,
    });
    assert!(!world.players.contains_key("A"), "A must not linger after logout");
    while rx_a1.try_recv().is_ok() {}

    // Session 2: play B on the same account.  Only B is in the world.
    let mut rx_b = join(&mut world, "B", "s2");
    world.command(Command::Input {
        id: "B".into(),
        connection: "s2".into(),
        message: ClientMessage::Input { seq: 1, direction: 1, vertical: 0, jump: false },
    });
    world.step();
    assert_eq!(world.players.len(), 1, "only the selected character is in the world");
    assert_eq!(world.players["B"].direction, 1);
    world.command(Command::Input {
        id: "B".into(),
        connection: "s2".into(),
        message: ClientMessage::Logout,
    });
    while rx_b.try_recv().is_ok() {}

    // Session 3: come back to A.  It must be recreated and controllable.
    let mut rx_a2 = join(&mut world, "A", "s3");
    assert!(world.players.contains_key("A"), "A returns cleanly");
    assert_eq!(world.players.len(), 1);
    world.command(Command::Input {
        id: "A".into(),
        connection: "s3".into(),
        message: ClientMessage::Input { seq: 1, direction: 1, vertical: 0, jump: false },
    });
    assert_eq!(world.players["A"].direction, 1, "A can move after returning");
    let x_before = world.players["A"].state.x;
    for _ in 0..10 {
        world.step();
    }
    assert!(
        world.players["A"].state.x > x_before,
        "A actually walks, not just flags a direction"
    );
    while rx_a2.try_recv().is_ok() {}
}
