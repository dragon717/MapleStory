// Whisper (密語) acceptance.  Included into `world.rs` tests so these share
// its fixtures (map(), Gameplay::default(), join_test_player) and can inspect
// private Player fields.
//
// A whisper is the second half of the chat module: map chat is addressed to a
// *room* the server derives from the sender's map, while a whisper is addressed
// to a *pair* resolved from a typed name.  Every rule below is therefore about
// the pair, and every one of them is decided server-side.
//
// The rig always attaches a real account store, because resolving a typed name
// is an *account* lookup first (exactly like a friend add or a party invite)
// with the live roster only as a fallback.

fn whisper_profile() -> Profile {
    Profile {
        hp: 50,
        max_hp: 50,
        mp: 5,
        max_mp: 5,
        level: 1,
        job: 0,
        exp: 0,
        exp_to_next: 1_000_000,
        mesos: 0,
        cash: 0,
        death_id: String::new(),
        map_id: "test".into(),
        x: 10.0,
        y: 100.0,
        inventory: Vec::new(),
        skills: BTreeMap::new(),
        skill_points: BTreeMap::new(),
        ability_stats: AbilityStats::default(),
    }
}

struct WhisperRig {
    world: World,
    inbox: BTreeMap<String, mpsc::Receiver<String>>,
}

impl WhisperRig {
    /// `joined` characters are in the world; `absent` characters only get an
    /// account row, which is the only way to prove "resolvable but offline" is
    /// a distinct outcome from "no such name".
    fn new(joined: &[&str], absent: &[&str]) -> Self {
        let path = std::env::temp_dir().join(format!("maple-whisper-{}.sqlite3", auth::random_id()));
        let service = auth::start(&path).expect("temp store");
        {
            let db = rusqlite::Connection::open(&path).expect("temp db");
            for id in joined.iter().chain(absent.iter()) {
                db.execute(
                    "INSERT OR IGNORE INTO accounts(id,username,password_hash) VALUES (?1,?1,'')",
                    rusqlite::params![id],
                )
                .expect("seed account");
            }
        }
        for id in joined.iter().chain(absent.iter()) {
            service
                .store
                .load_profile(id, &whisper_profile())
                .expect("seed profile");
        }
        let mut world =
            World::new_with_store(map(), 600, Gameplay::default(), service.store.clone())
                .expect("world with store");
        let mut inbox = BTreeMap::new();
        for id in joined {
            inbox.insert((*id).to_owned(), join_test_player(&mut world, id));
        }
        world.step();
        let mut rig = Self { world, inbox };
        for id in joined {
            rig.drain(id);
        }
        rig
    }

    fn drain(&mut self, id: &str) {
        if let Some(channel) = self.inbox.get_mut(id) {
            while channel.try_recv().is_ok() {}
        }
    }

    fn send(&mut self, id: &str, request_id: &str, target: &str, text: &str) {
        self.world.command(Command::Input {
            id: id.to_owned(),
            connection: format!("{id}-connection"),
            message: ClientMessage::WhisperSend {
                request_id: request_id.to_owned(),
                target_name: target.to_owned(),
                text: text.to_owned(),
            },
        });
    }

    /// Everything of `kind` currently queued for one character.  Snapshots and
    /// other world traffic are filtered out, so "nothing was delivered" can be
    /// asserted without racing the drain order.
    fn take(&mut self, id: &str, kind: &str) -> Vec<serde_json::Value> {
        let mut out = Vec::new();
        if let Some(channel) = self.inbox.get_mut(id) {
            while let Ok(raw) = channel.try_recv() {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
                    if value["type"] == kind {
                        out.push(value);
                    }
                }
            }
        }
        out
    }
}

#[test]
fn whisper_is_delivered_to_both_sides_and_to_nobody_else() {
    let mut rig = WhisperRig::new(&["alice", "bob", "carol"], &[]);
    rig.send("alice", "w-1", "bob", "  晚上一起打怪吗？  ");

    // Sender echo: carries the request id so its pending line can be merged.
    let sent = rig.take("alice", "whisperMessage");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["requestId"], "w-1");
    assert_eq!(sent[0]["fromId"], "alice");
    assert_eq!(sent[0]["toName"], "bob");
    assert_eq!(sent[0]["text"], "晚上一起打怪吗？");

    // Recipient copy: the same fact, without the sender's request id.
    let got = rig.take("bob", "whisperMessage");
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["fromName"], "alice");
    assert_eq!(got[0]["toId"], "bob");
    assert!(got[0].get("requestId").is_none());

    // A third character on the same map is not part of the pair, and a whisper
    // is never a map-chat broadcast.
    assert!(rig.take("carol", "whisperMessage").is_empty());
    assert!(rig.take("carol", "chatMessage").is_empty());
}

#[test]
fn whisper_reaches_a_character_on_another_map() {
    let mut rig = WhisperRig::new(&["alice", "bob"], &[]);
    // Unlike map chat — which is scoped to the room — a whisper follows the
    // character, the same way a party invitation or a friend row does.
    rig.world.players.get_mut("bob").unwrap().map_id = "other-test".to_owned();

    rig.send("alice", "w-2", "bob", "你在哪张图？");
    assert_eq!(rig.take("alice", "whisperMessage").len(), 1);
    assert_eq!(rig.take("bob", "whisperMessage").len(), 1);
}

#[test]
fn unknown_name_and_self_are_reported_not_delivered() {
    let mut rig = WhisperRig::new(&["alice", "bob"], &[]);

    rig.send("alice", "w-unknown", "nobody", "hi");
    assert!(
        rig.take("alice", "rejected")
            .iter()
            .any(|value| value["code"] == "whisper_unknown_player"),
        "an unknown name must be reported"
    );

    rig.send("alice", "w-self", "alice", "hi me");
    assert!(
        rig.take("alice", "rejected")
            .iter()
            .any(|value| value["code"] == "whisper_self"),
        "whispering yourself must be reported"
    );

    assert!(rig.take("bob", "whisperMessage").is_empty());
}

#[test]
fn whisper_to_a_character_without_a_session_is_reported_offline() {
    // The account row exists, so the name resolves; there is no session, so
    // the outcome is "offline" — never a queued message the server could not
    // deliver later.
    let mut rig = WhisperRig::new(&["alice"], &["ghost"]);
    rig.send("alice", "w-offline", "ghost", "还在吗");
    assert!(
        rig.take("alice", "rejected")
            .iter()
            .any(|value| value["code"] == "whisper_offline"),
        "a resolvable but absent character must be reported offline"
    );
    assert!(rig.take("alice", "whisperMessage").is_empty());
}

#[test]
fn blacklist_blocks_a_whisper_in_both_directions() {
    let mut rig = WhisperRig::new(&["alice", "bob", "carol"], &[]);

    // bob blocked alice: alice must not be able to reach him by switching to
    // a different chat surface.
    rig.world
        .players
        .get_mut("bob")
        .unwrap()
        .blocked
        .insert("alice".to_owned());
    rig.send("alice", "w-blocked", "bob", "听得到吗");
    assert!(
        rig.take("alice", "rejected")
            .iter()
            .any(|value| value["code"] == "whisper_blocked"),
        "a blocked sender must be refused"
    );
    assert!(rig.take("bob", "whisperMessage").is_empty());

    // The other direction: alice blocked carol, so alice cannot talk to her
    // either — the block is a statement about the pair, not about the channel.
    rig.world
        .players
        .get_mut("alice")
        .unwrap()
        .blocked
        .insert("carol".to_owned());
    rig.send("alice", "w-ignored", "carol", "hi");
    assert!(
        rig.take("alice", "rejected")
            .iter()
            .any(|value| value["code"] == "whisper_ignored"),
        "whispering somebody you blocked must be refused"
    );
    assert!(rig.take("carol", "whisperMessage").is_empty());
}

#[test]
fn replayed_whisper_re_echoes_to_the_sender_only_and_a_conflict_is_rejected() {
    let mut rig = WhisperRig::new(&["alice", "bob", "carol"], &[]);

    rig.send("alice", "dup-1", "bob", "同一句话");
    assert_eq!(rig.take("alice", "whisperMessage").len(), 1);
    assert_eq!(rig.take("bob", "whisperMessage").len(), 1);

    // Network retry with the same id: the sender's echo is re-sent so a pending
    // line can still be merged, but the recipient is never told twice.
    rig.send("alice", "dup-1", "bob", "同一句话");
    let replay = rig.take("alice", "whisperMessage");
    assert_eq!(replay.len(), 1, "the sender still gets its echo");
    assert_eq!(replay[0]["requestId"], "dup-1");
    assert_eq!(replay[0]["replay"], true);
    assert!(rig.take("bob", "whisperMessage").is_empty());

    // Same id, different body: a conflict, and nobody is told anything.
    rig.send("alice", "dup-1", "bob", "换个说法");
    assert!(
        rig.take("alice", "rejected")
            .iter()
            .any(|value| value["code"] == "idempotency_conflict")
    );
    assert!(rig.take("bob", "whisperMessage").is_empty());

    // Same id, different target: also a conflict — the id names one intent,
    // and carol must not receive it either.
    rig.send("alice", "dup-1", "carol", "同一句话");
    let rejects = rig.take("alice", "rejected");
    assert!(
        rejects
            .iter()
            .any(|value| value["code"] == "idempotency_conflict"),
        "a reused id cannot address a second character"
    );
    assert!(rig.take("carol", "whisperMessage").is_empty());
}

#[test]
fn whisper_shares_the_chat_token_bucket() {
    let mut rig = WhisperRig::new(&["alice", "bob"], &[]);

    for index in 0..5 {
        rig.send("alice", &format!("burst-{index}"), "bob", &format!("m{index}"));
    }
    assert_eq!(rig.take("alice", "whisperMessage").len(), 5);
    assert_eq!(rig.take("bob", "whisperMessage").len(), 5);

    // Whispering is not a way around the map-chat limit: the sixth send is
    // refused and the recipient sees nothing.
    rig.send("alice", "burst-5", "bob", "m5");
    assert!(
        rig.take("alice", "rejected")
            .iter()
            .any(|value| value["code"] == "chat_rate_limited")
    );
    assert!(rig.take("bob", "whisperMessage").is_empty());

    // One second later the bucket has refilled by exactly one token.
    rig.world.tick += 1_000 / TICK_MS;
    rig.send("alice", "burst-6", "bob", "m6");
    assert_eq!(rig.take("alice", "whisperMessage").len(), 1);
    assert_eq!(rig.take("bob", "whisperMessage").len(), 1);
}

#[test]
fn whisper_body_policy_matches_map_chat() {
    let mut rig = WhisperRig::new(&["alice", "bob"], &[]);

    for (request_id, text) in [
        ("w-ctl", "hi\u{7}bell".to_owned()),
        ("w-empty", "   ".to_owned()),
        ("w-long", "a".repeat(201)),
    ] {
        rig.send("alice", request_id, "bob", &text);
        assert!(
            rig.take("alice", "rejected").iter().any(|value| value["requestId"]
                == request_id
                && value["code"] == "invalid_chat_text"),
            "{request_id} must be refused by the shared body policy"
        );
        assert!(rig.take("bob", "whisperMessage").is_empty());
    }
}

#[test]
fn forged_whisper_envelopes_never_parse() {
    // The client may name a character; it may never name an identity, a room
    // or a time.  Every one of these is a deserialization failure, so the
    // handler does not even have to defend against them.
    for raw in [
        r#"{"type":"whisperSend","requestId":"w1","targetName":"bob","text":"hi","targetId":"bob"}"#,
        r#"{"type":"whisperSend","requestId":"w1","targetName":"bob","text":"hi","mapId":"999"}"#,
        r#"{"type":"whisperSend","requestId":"w1","targetName":"bob","text":"hi","fromName":"gm"}"#,
        r#"{"type":"whisperSend","requestId":"w1","targetName":"bob","text":"hi","occurredAtTick":9}"#,
    ] {
        assert!(
            serde_json::from_str::<ClientMessage>(raw).is_err(),
            "forged whisper envelope must not parse: {raw}"
        );
    }
    // An empty name is well-formed JSON, so it is the *validator* that has to
    // refuse it — this is the one case where the wire shape is fine and the
    // value is not.
    let empty: ClientMessage = serde_json::from_str(
        r#"{"type":"whisperSend","requestId":"w1","targetName":"","text":"hi"}"#,
    )
    .unwrap();
    assert!(!empty.valid(), "an empty target name must not validate");
    let parsed: ClientMessage = serde_json::from_str(
        r#"{"type":"whisperSend","requestId":"w1","targetName":"bob","text":"hi"}"#,
    )
    .unwrap();
    assert!(parsed.valid());
}

#[test]
fn whisper_idempotency_window_stays_bounded() {
    let mut rig = WhisperRig::new(&["alice", "bob"], &[]);
    let total = WHISPER_RECENT_WINDOW + 8;
    for index in 0..total {
        // Each send needs its own token, so advance far enough that the shared
        // bucket always has one — this test is about the window, not the rate.
        rig.world.tick += 1_000 / TICK_MS;
        rig.send("alice", &format!("w-{index}"), "bob", "hi");
        rig.take("alice", "whisperMessage");
        rig.take("alice", "rejected");
    }
    // A long session must not grow the window without bound: the oldest ids
    // fall out and the newest one is still remembered.
    assert_eq!(
        rig.world.players["alice"].whisper_recent.len(),
        WHISPER_RECENT_WINDOW
    );
    assert!(rig.world.players["alice"]
        .whisper_recent
        .iter()
        .any(|(id, _, _)| id == &format!("w-{}", total - 1)));
}
