// Chat_ops P1-C04 map public chat acceptance.  Included into `world.rs`
// tests so these share its fixtures (map(), Gameplay::default(),
// join_test_player) and can inspect private Player fields.

use serde_json::Value;

fn chat_drain(rx: &mut mpsc::Receiver<String>) {
    while rx.try_recv().is_ok() {}
}

fn chat_send(world: &mut World, id: &str, request_id: &str, text: &str) {
    world.command(Command::Input {
        id: id.to_owned(),
        connection: format!("{id}-connection"),
        message: ClientMessage::ChatSend {
            request_id: request_id.to_owned(),
            text: text.to_owned(),
        },
    });
}

/// Take every queued envelope of `kind` (drops unrelated system messages).
fn chat_take_kind(rx: &mut mpsc::Receiver<String>, kind: &str) -> Vec<Value> {
    let mut out = Vec::new();
    while let Ok(text) = rx.try_recv() {
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            if value["type"] == kind {
                out.push(value);
            }
        }
    }
    out
}

fn chat_world() -> World {
    World::new_with_gameplay(map(), 600, Gameplay::default())
}

#[test]
fn chat_forged_map_or_author_fields_are_rejected_at_the_protocol_edge() {
    for raw in [
        r#"{"type":"chatSend","requestId":"r1","text":"hi","mapId":"999999999"}"#,
        r#"{"type":"chatSend","requestId":"r1","text":"hi","authorId":"gm","authorName":"GM"}"#,
        r#"{"type":"chatSend","requestId":"r1","text":"hi","channelId":7}"#,
        r#"{"type":"system","text":"free items"}"#,
        r#"{"type":"chatSend","requestId":"r1","text":"ok","isGM":true}"#,
    ] {
        assert!(
            serde_json::from_str::<ClientMessage>(raw).is_err(),
            "forged chat envelope must not parse: {raw}"
        );
    }
    let valid: ClientMessage =
        serde_json::from_str(r#"{"type":"chatSend","requestId":"r1","text":"hi"}"#).unwrap();
    assert!(valid.valid());
    let mut world = chat_world();
    let mut alice = join_test_player(&mut world, "alice");
    chat_drain(&mut alice);
    // A map send can only be addressed to the sender's own current map; the
    // protocol layer already denied the extra field above, so even a direct
    // deserialize of the same object with a target cannot carry a room id.
    let parsed: ClientMessage = serde_json::from_str(r#"{"type":"chatSend","requestId":"r1","text":"hi"}"#).unwrap();
    let ClientMessage::ChatSend { request_id, text } = &parsed else {
        panic!("expected chatSend variant");
    };
    world.command(Command::Input {
        id: "alice".into(),
        connection: "alice-connection".into(),
        message: ClientMessage::ChatSend {
            request_id: request_id.clone(),
            text: text.clone(),
        },
    });
    let messages = chat_take_kind(&mut alice, "chatMessage");
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["authorId"], "alice");
    assert_eq!(messages[0]["mapId"], "test");
}

#[test]
fn invalid_or_oversized_chat_bodies_are_rejected_without_broadcast() {
    let mut world = chat_world();
    let mut alice = join_test_player(&mut world, "alice");
    let mut bob = join_test_player(&mut world, "bob");
    chat_drain(&mut alice);
    chat_drain(&mut bob);

    let cases: [(&str, String); 4] = [
        ("r-ctl", "hi\u{7}bell".to_owned()),
        ("r-empty", "   ".to_owned()),
        ("r-long", "a".repeat(201)),
        ("r-bytes", "啊".repeat(400)), // 1200 UTF-8 bytes, over the 1 KiB cap
    ];
    for (request_id, text) in cases {
        chat_send(&mut world, "alice", request_id, &text);
        let rejects = chat_take_kind(&mut alice, "rejected");
        assert!(
            rejects.iter().any(|value| value["requestId"] == request_id
                && value["code"] == "invalid_chat_text"),
            "{request_id} must be rejected as invalid text"
        );
        assert!(chat_take_kind(&mut bob, "chatMessage").is_empty());
    }
    assert!(chat_take_kind(&mut alice, "chatMessage").is_empty());
}

#[test]
fn map_room_scopes_chat_to_current_map_members_only() {
    let mut world = chat_world();
    let mut alice = join_test_player(&mut world, "alice");
    let mut eric = join_test_player(&mut world, "eric");
    let mut dave = join_test_player(&mut world, "dave");
    chat_drain(&mut alice);
    chat_drain(&mut eric);
    chat_drain(&mut dave);
    // dave is on another map instance (same template, different id).  Only the
    // authoritative Player.map_id matters; the client cannot declare a room.
    world.players.get_mut("dave").unwrap().map_id = "other-test".to_owned();

    chat_send(&mut world, "alice", "r-1", "  来二频道一起打怪吗？  ");

    let alice_echo = chat_take_kind(&mut alice, "chatMessage");
    assert_eq!(alice_echo.len(), 1);
    assert_eq!(alice_echo[0]["authorId"], "alice");
    assert_eq!(alice_echo[0]["requestId"], "r-1");
    assert_eq!(alice_echo[0]["text"], "来二频道一起打怪吗？");
    assert_eq!(alice_echo[0]["mapId"], "test");

    let eric_view = chat_take_kind(&mut eric, "chatMessage");
    assert_eq!(eric_view.len(), 1);
    assert_eq!(eric_view[0]["authorName"], "alice");
    assert!(eric_view[0].get("requestId").is_none(), "peers do not need the sender request id");

    assert!(chat_take_kind(&mut dave, "chatMessage").is_empty(), "another map instance must not receive the message");
}

#[test]
fn duplicate_chat_request_is_never_rebroadcast_and_conflicting_body_is_rejected() {
    let mut world = chat_world();
    let mut alice = join_test_player(&mut world, "alice");
    let mut bob = join_test_player(&mut world, "bob");
    chat_drain(&mut alice);
    chat_drain(&mut bob);

    chat_send(&mut world, "alice", "dup-1", "同一句话");
    assert_eq!(chat_take_kind(&mut alice, "chatMessage").len(), 1);
    assert_eq!(chat_take_kind(&mut bob, "chatMessage").len(), 1);

    // A network retry with the same request id and body: no second broadcast.
    chat_send(&mut world, "alice", "dup-1", "同一句话");
    assert!(chat_take_kind(&mut alice, "chatMessage").is_empty());
    assert!(chat_take_kind(&mut bob, "chatMessage").is_empty());

    // The same request id with a different body is a conflict.
    chat_send(&mut world, "alice", "dup-1", "换个说法");
    let rejects = chat_take_kind(&mut alice, "rejected");
    assert!(rejects.iter().any(|value| value["code"] == "idempotency_conflict"));
    assert!(chat_take_kind(&mut bob, "chatMessage").is_empty());

    // A fresh request id still works after the conflict.
    chat_send(&mut world, "alice", "fresh-1", "好了");
    assert_eq!(chat_take_kind(&mut alice, "chatMessage").len(), 1);
}

#[test]
fn chat_token_bucket_allows_burst_then_limits_and_recovers_over_time() {
    let mut world = chat_world();
    let mut alice = join_test_player(&mut world, "alice");
    let mut bob = join_test_player(&mut world, "bob");
    chat_drain(&mut alice);
    chat_drain(&mut bob);

    for index in 0..5 {
        chat_send(&mut world, "alice", &format!("burst-{index}"), &format!("m{index}"));
    }
    assert_eq!(chat_take_kind(&mut alice, "chatMessage").len(), 5);
    assert_eq!(chat_take_kind(&mut bob, "chatMessage").len(), 5);

    // Sixth send within the burst is rate-limited (bucket is empty).
    chat_send(&mut world, "alice", "burst-5", "m5");
    let rejects = chat_take_kind(&mut alice, "rejected");
    assert!(rejects.iter().any(|value| value["code"] == "chat_rate_limited"));
    assert!(chat_take_kind(&mut bob, "chatMessage").is_empty());

    // One second later one token has refilled and a single message passes.
    world.tick += 1_000 / TICK_MS;
    chat_send(&mut world, "alice", "burst-6", "m6");
    assert_eq!(chat_take_kind(&mut alice, "chatMessage").len(), 1);
    assert_eq!(chat_take_kind(&mut bob, "chatMessage").len(), 1);
    // The refilled token is now spent: the next immediate send is limited.
    chat_send(&mut world, "alice", "burst-7", "m7");
    let rejects = chat_take_kind(&mut alice, "rejected");
    assert!(rejects.iter().any(|value| value["code"] == "chat_rate_limited"));
}

#[test]
fn slow_reader_with_a_full_outbox_never_blocks_other_players() {
    let mut world = chat_world();
    let mut alice = join_test_player(&mut world, "alice");
    let mut bob = join_test_player(&mut world, "bob");
    let (slow_out, mut slow_rx) = mpsc::channel(2);
    let (reply, _) = oneshot::channel();
    world.command(Command::Join {
        identity: Identity {
            id: "slow".into(),
            username: "slow".into(),
        },
        connection: "slow-connection".into(),
        output: slow_out,
        reply,
        lang: "zh".into(),
    });
    chat_drain(&mut alice);
    chat_drain(&mut bob);
    chat_drain(&mut slow_rx);
    // Saturate the slow reader's bounded outbox so any chat fan-out is Full.
    let slow_sender = world.players["slow"].output.clone();
    while slow_sender.try_send("blocking-junk".into()).is_ok() {}

    chat_send(&mut world, "alice", "r-1", "hi everyone");
    assert_eq!(chat_take_kind(&mut alice, "chatMessage").len(), 1, "sender still gets its own echo");
    assert_eq!(chat_take_kind(&mut bob, "chatMessage").len(), 1, "healthy peer still receives the message");
    // The slow connection was neither removed nor waited on.
    assert!(world.players.contains_key("slow"));
    assert_eq!(world.players["slow"].map_id, "test");
    assert!(world.players["slow"].chat_tokens <= CHAT_TOKEN_BURST);
}

#[test]
fn text_policy_is_shared_by_the_wire_validator() {
    for good in ["hi", "中文消息，支持 CJK。", "  spaced  ", "a".repeat(200).as_str()] {
        assert!(crate::protocol::valid_chat_text(good), "{good:?} must pass");
    }
    for bad in ["", "   ", &"a".repeat(201), "tab\there", "new\nline", "ctrl\u{1}"] {
        assert!(!crate::protocol::valid_chat_text(bad), "{bad:?} must be rejected");
    }
}
