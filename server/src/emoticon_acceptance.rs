// Chat emoticon (表情貼圖) acceptance.  Included into `world.rs` tests so these
// share its fixtures (`map()`, `join_test_player`) and can build a world that
// carries an exported catalogue.
//
// An emoticon is the third chat surface.  Map chat is addressed to a *room*, a
// whisper to a *pair*; an emoticon goes to a room as well, but it is the only
// one whose payload is not free text — it is a single catalogue id.  Every rule
// below is therefore about three questions:
//
//   * is the id real?  (the catalogue is an export fact, so only the server
//     can answer it, and a modified client cannot invent a sticker)
//   * has the source send budget been respected?  (`ChatLimit` is a sliding
//     window over send times, not a refilling bucket)
//   * are the room, the author identity and the tick server-derived?  (none of
//     them is on the wire, so a sticker cannot be shown as somebody else or
//     into a map its author is not standing in)

/// Ids in the shape the exporter publishes: `<groupId>:<sourceName>`.  The
/// third one exists only to prove an id can be syntactically fine and still be
/// absent from the catalogue (it is never registered below).
const EMOTICON_TEST_IDS: [&str; 3] = ["1000:10000001", "1000:10000002", "1043:10360001"];

/// The shipped export authors 4 stickers per 5000 ms.  The rig shrinks that to
/// 2 per 1000 ms so the sliding-window arithmetic is exercised in 20 ticks
/// instead of 100; `scripts/check_tms273_runtime.cjs` asserts the shipped
/// values against `shared/gameplay.json`.
fn emoticon_world() -> World {
    let gameplay = Gameplay {
        emoticons: Some(EmoticonCatalogue {
            ids: EMOTICON_TEST_IDS.iter().map(|id| (*id).to_owned()).collect(),
            limit: EmoticonLimit {
                count: 2,
                time_ms: 1_000,
            },
            source: Some("test".to_owned()),
        }),
        ..Gameplay::default()
    };
    World::new_with_gameplay(map(), 600, gameplay)
}

fn emoticon_send(world: &mut World, id: &str, request_id: &str, emoticon_id: &str) {
    world.command(Command::Input {
        id: id.to_owned(),
        connection: format!("{id}-connection"),
        message: ClientMessage::EmoticonSend {
            request_id: request_id.to_owned(),
            emoticon_id: emoticon_id.to_owned(),
        },
    });
}

/// Every queued `emoticonMessage` (the chat helper is kind-agnostic).
fn emoticon_take(rx: &mut mpsc::Receiver<String>) -> Vec<Value> {
    chat_take_kind(rx, "emoticonMessage")
}

#[test]
fn emoticon_forged_author_room_and_extra_fields_are_rejected_at_the_protocol_edge() {
    // Every field an emoticon does *not* carry is denied by the parser, so a
    // forged one never reaches `handle_emoticon` and can never be echoed.
    for raw in [
        r#"{"type":"emoticonSend","requestId":"r1","emoticonId":"1000:10000001","authorId":"gm"}"#,
        r#"{"type":"emoticonSend","requestId":"r1","emoticonId":"1000:10000001","authorName":"GM"}"#,
        r#"{"type":"emoticonSend","requestId":"r1","emoticonId":"1000:10000001","mapId":"999999999"}"#,
        r#"{"type":"emoticonSend","requestId":"r1","emoticonId":"1000:10000001","text":"hi"}"#,
        r#"{"type":"emoticonSend","requestId":"r1","emoticonId":"1000:10000001","occurredAtTick":7}"#,
        r#"{"type":"emoticonSend","requestId":"r1","emoticonId":"1000:10000001","messageId":"x"}"#,
    ] {
        assert!(
            serde_json::from_str::<ClientMessage>(raw).is_err(),
            "forged emoticon envelope must not parse: {raw}"
        );
    }

    let valid: ClientMessage =
        serde_json::from_str(r#"{"type":"emoticonSend","requestId":"r1","emoticonId":"1000:10000001"}"#)
            .unwrap();
    assert!(valid.valid());

    // Shape policy only.  A well-formed id that is not in the export still
    // passes the wire validator, because the catalogue is a *world* fact: it is
    // the authoritative world that refuses it (next test), not the parser.
    let unknown: ClientMessage =
        serde_json::from_str(r#"{"type":"emoticonSend","requestId":"r1","emoticonId":"9999:99999999"}"#)
            .unwrap();
    assert!(unknown.valid());

    for bad in [
        // empty / oversized / control-bearing ids fail the shared id policy
        r#"{"type":"emoticonSend","requestId":"","emoticonId":"1000:10000001"}"#,
        r#"{"type":"emoticonSend","requestId":"r1","emoticonId":""}"#,
        r#"{"type":"emoticonSend","requestId":"r1","emoticonId":"1000 10000001"}"#,
        r#"{"type":"emoticonSend","requestId":"r1","emoticonId":"1036:10360001\n"}"#,
    ] {
        let parsed: ClientMessage = serde_json::from_str(bad).unwrap();
        assert!(!parsed.valid(), "{bad} must fail the shared id policy");
    }
}

#[test]
fn an_unknown_sticker_id_is_refused_without_any_broadcast() {
    let mut world = emoticon_world();
    let mut alice = join_test_player(&mut world, "alice");
    let mut bob = join_test_player(&mut world, "bob");
    chat_drain(&mut alice);
    chat_drain(&mut bob);

    // `1043:10360006` is well formed but not registered: group 1043 exists, the
    // sticker under it does not.  Nothing may reach any renderer.
    emoticon_send(&mut world, "alice", "r-unknown", "1043:10360006");
    let rejects = chat_take_kind(&mut alice, "rejected");
    assert!(rejects
        .iter()
        .any(|value| value["requestId"] == "r-unknown" && value["code"] == "emoticon_unknown"));
    assert!(emoticon_take(&mut alice).is_empty());
    assert!(emoticon_take(&mut bob).is_empty());
}

#[test]
fn an_emoticon_reaches_the_authors_map_room_only_and_honours_the_blacklist() {
    let mut world = emoticon_world();
    let mut alice = join_test_player(&mut world, "alice");
    let mut bob = join_test_player(&mut world, "bob");
    let mut eric = join_test_player(&mut world, "eric");
    let mut dave = join_test_player(&mut world, "dave");
    for rx in [&mut alice, &mut bob, &mut eric, &mut dave] {
        chat_drain(rx);
    }
    // Dave stands on another map instance; Bob has Alice on his blacklist.
    world.players.get_mut("dave").unwrap().map_id = "other-test".to_owned();
    world
        .players
        .get_mut("bob")
        .unwrap()
        .blocked
        .insert("alice".to_owned());

    emoticon_send(&mut world, "alice", "r-1", "1000:10000002");

    let echo = emoticon_take(&mut alice);
    assert_eq!(echo.len(), 1);
    assert_eq!(echo[0]["authorId"], "alice");
    assert_eq!(echo[0]["authorName"], "alice");
    assert_eq!(echo[0]["mapId"], "test");
    assert_eq!(echo[0]["emoticonId"], "1000:10000002");
    assert_eq!(echo[0]["requestId"], "r-1");
    assert_eq!(echo[0]["occurredAtTick"], world.tick);
    assert!(
        echo[0]["messageId"]
            .as_str()
            .is_some_and(|id| id.starts_with("emoticon-")),
        "the server is the only author of the message id"
    );

    let peer = emoticon_take(&mut eric);
    assert_eq!(peer.len(), 1);
    assert_eq!(peer[0]["authorName"], "alice");
    assert_eq!(peer[0]["emoticonId"], "1000:10000002");
    assert!(
        peer[0].get("requestId").is_none(),
        "peers do not need the sender request id"
    );

    assert!(
        emoticon_take(&mut bob).is_empty(),
        "a blocked author's sticker must not reach the blocker"
    );
    assert!(
        emoticon_take(&mut dave).is_empty(),
        "another map instance must not receive the sticker"
    );
}

#[test]
fn a_replayed_emoticon_request_is_never_shown_twice_and_a_conflicting_sticker_is_rejected() {
    let mut world = emoticon_world();
    let mut alice = join_test_player(&mut world, "alice");
    let mut bob = join_test_player(&mut world, "bob");
    chat_drain(&mut alice);
    chat_drain(&mut bob);

    emoticon_send(&mut world, "alice", "dup-1", "1000:10000001");
    assert_eq!(emoticon_take(&mut alice).len(), 1);
    assert_eq!(emoticon_take(&mut bob).len(), 1);

    // A network retry with the same request id and sticker: the head animation
    // must not play a second time for anybody.
    emoticon_send(&mut world, "alice", "dup-1", "1000:10000001");
    assert!(emoticon_take(&mut alice).is_empty());
    assert!(emoticon_take(&mut bob).is_empty());

    // The same request id pointing at a different sticker is a conflict.
    emoticon_send(&mut world, "alice", "dup-1", "1000:10000002");
    let rejects = chat_take_kind(&mut alice, "rejected");
    assert!(rejects
        .iter()
        .any(|value| value["code"] == "idempotency_conflict"));
    assert!(emoticon_take(&mut bob).is_empty());

    // A fresh request id still works after the conflict.
    emoticon_send(&mut world, "alice", "fresh-1", "1000:10000001");
    assert_eq!(emoticon_take(&mut alice).len(), 1);
}

#[test]
fn the_source_send_budget_is_a_sliding_window_and_is_not_the_map_chat_bucket() {
    let mut world = emoticon_world();
    let mut alice = join_test_player(&mut world, "alice");
    let mut bob = join_test_player(&mut world, "bob");
    chat_drain(&mut alice);
    chat_drain(&mut bob);

    // 2 per 1000 ms: the first two pass, the third inside the same window does
    // not, and a shared token bucket would have refilled by now.
    emoticon_send(&mut world, "alice", "e-1", "1000:10000001");
    emoticon_send(&mut world, "alice", "e-2", "1000:10000002");
    assert_eq!(emoticon_take(&mut alice).len(), 2);
    assert_eq!(emoticon_take(&mut bob).len(), 2);
    emoticon_send(&mut world, "alice", "e-3", "1000:10000001");
    let rejects = chat_take_kind(&mut alice, "rejected");
    assert!(rejects
        .iter()
        .any(|value| value["code"] == "emoticon_rate_limited"));
    assert!(emoticon_take(&mut bob).is_empty());

    // Half a window later the *oldest* send is still inside the window, so the
    // budget has not freed a slot yet.
    world.tick += 500 / TICK_MS;
    emoticon_send(&mut world, "alice", "e-4", "1000:10000002");
    let rejects = chat_take_kind(&mut alice, "rejected");
    assert!(rejects
        .iter()
        .any(|value| value["code"] == "emoticon_rate_limited"));
    assert!(emoticon_take(&mut bob).is_empty());

    // Once the whole window has elapsed both older sends have aged out.
    world.tick += 500 / TICK_MS;
    emoticon_send(&mut world, "alice", "e-5", "1000:10000001");
    emoticon_send(&mut world, "alice", "e-6", "1000:10000002");
    assert_eq!(emoticon_take(&mut alice).len(), 2);
    assert_eq!(emoticon_take(&mut bob).len(), 2);

    // The sticker budget is its own limit, deliberately *not* the map-chat
    // token bucket: exhausting the stickers must not mute the player.
    emoticon_send(&mut world, "alice", "e-7", "1000:10000001");
    let rejects = chat_take_kind(&mut alice, "rejected");
    assert!(rejects
        .iter()
        .any(|value| value["code"] == "emoticon_rate_limited"));
    chat_send(&mut world, "alice", "c-1", "贴图用完了还能说话");
    assert_eq!(chat_take_kind(&mut alice, "chatMessage").len(), 1);
    assert_eq!(chat_take_kind(&mut bob, "chatMessage").len(), 1);
}
