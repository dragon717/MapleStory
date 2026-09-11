// Directional acceptance for the friend & blacklist module (`FriendOpen` /
// `FriendAdd` / `FriendRemove` / `FriendBlock` / `FriendUnblock`).
//
// This module is the mirror of the party module, and the tests here are about
// the one difference that matters: a party is a *session* fact that dies with
// the world, while a friend row is an *account* fact that has to survive a
// restart.  That single split is what forces the design — the client types a
// name, the server resolves it, writes the relation in both directions inside
// one SQLite transaction, and only then re-derives the live half (is the
// character in the world, and where) on every push.
//
// So the boundaries under test are: a typed name can never be turned into an
// id by the client; a friendship is symmetric and cannot be forced across an
// explicit block; a block actually silences map chat; the online flag is
// recomputed from the live roster and an offline row never invents a location;
// and a replayed request id re-sends the original outcome instead of writing
// twice.

use super::*;

const FRIEND_MAP_ID: &str = "friend-test";

fn friend_map() -> Map {
    Map {
        id: FRIEND_MAP_ID.into(),
        bounds: Bounds { x_min: 0.0, x_max: 600.0, y_min: -100.0, y_max: 400.0 },
        spawn: Point { x: 100.0, y: 100.0 },
        footholds: vec![Foothold {
            id: 1, x1: 0.0, y1: 100.0, x2: 600.0, y2: 100.0,
            prev: 0, next: 0, forbid_fall_down: 0,
        }],
        ladders: Vec::new(),
        portals: Vec::new(),
        water: Vec::new(),
        reactors: Vec::new(),
    }
}

fn friend_gameplay() -> Gameplay {
    Gameplay {
        exp_table: vec![1_000_000],
        ..Gameplay::default()
    }
}

fn friend_profile() -> Profile {
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
        death_id: String::new(),
        map_id: FRIEND_MAP_ID.into(),
        x: 100.0,
        y: 100.0,
        inventory: Vec::new(),
        skills: BTreeMap::new(),
        skill_points: BTreeMap::new(),
        ability_stats: AbilityStats::default(),
    }
}

struct FriendRig {
    world: World,
    inbox: BTreeMap<String, mpsc::Receiver<String>>,
    /// Rolling tap of everything each character was sent, so a test can look
    /// for a message after later traffic without racing the drain order.
    seen: BTreeMap<String, Vec<serde_json::Value>>,
}

impl FriendRig {
    /// `ids` are joined immediately; `names` are only given an account row so
    /// they can be *added by name* while still being offline — which is the
    /// only way to prove the online flag is derived and not stored.
    fn new(joined: &[&str], offline_names: &[&str]) -> Self {
        let path = std::env::temp_dir().join(format!("maple-friend-{}.sqlite3", auth::random_id()));
        let service = auth::start(&path).expect("temp store");
        {
            // `find_character_by_name` and the friend-list read both join
            // `accounts`, so a character the window can name or list must have
            // a real account row.  Registration is the only writer in
            // production; the fixture writes the same shape directly, after
            // `auth::start` has created the schema.
            let db = rusqlite::Connection::open(&path).expect("temp db");
            for id in joined.iter().chain(offline_names.iter()) {
                db.execute(
                    "INSERT OR IGNORE INTO accounts(id,username,password_hash) VALUES (?1,?1,'')",
                    rusqlite::params![id],
                )
                .expect("seed account");
            }
        }
        for id in joined.iter().chain(offline_names.iter()) {
            service
                .store
                .load_profile(id, &friend_profile())
                .expect("seed profile");
        }
        let mut world =
            World::new_with_store(friend_map(), 600, friend_gameplay(), service.store.clone())
                .expect("world with store");
        let mut inbox = BTreeMap::new();
        for id in joined {
            let channel = join_test_player(&mut world, id);
            inbox.insert((*id).to_owned(), channel);
        }
        world.step();
        let mut rig = Self { world, inbox, seen: BTreeMap::new() };
        for id in joined {
            rig.pump(id);
        }
        rig
    }

    fn join(&mut self, id: &str) {
        let channel = join_test_player(&mut self.world, id);
        self.inbox.insert(id.to_owned(), channel);
        self.world.step();
        self.pump(id);
    }

    fn leave(&mut self, id: &str) {
        self.world.command(Command::Input {
            id: id.to_owned(),
            connection: format!("{id}-connection"),
            message: ClientMessage::Logout,
        });
        self.world.step();
        self.inbox.remove(id);
    }

    fn send(&mut self, id: &str, message: ClientMessage) {
        self.world.command(Command::Input {
            id: id.to_owned(),
            connection: format!("{id}-connection"),
            message,
        });
    }

    /// Drain everything new, skipping snapshots: snapshots are world traffic,
    /// not friend traffic, and counting them would make "nothing was sent"
    /// impossible to assert.
    fn pump(&mut self, id: &str) -> usize {
        let mut fresh = Vec::new();
        if let Some(channel) = self.inbox.get_mut(id) {
            while let Ok(raw) = channel.try_recv() {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
                    if value["type"] != "snapshot" {
                        fresh.push(value);
                    }
                }
            }
        }
        let arrived = fresh.len();
        self.seen.entry(id.to_owned()).or_default().extend(fresh);
        arrived
    }

    fn pump_all(&mut self) {
        let ids: Vec<String> = self.inbox.keys().cloned().collect();
        for id in ids {
            self.pump(&id);
        }
    }

    fn last(&mut self, id: &str, kind: &str) -> Option<serde_json::Value> {
        self.pump(id);
        self.seen
            .get(id)?
            .iter()
            .rev()
            .find(|message| message["type"] == kind)
            .cloned()
    }

    fn all(&mut self, id: &str, kind: &str) -> Vec<serde_json::Value> {
        self.pump(id);
        self.seen
            .get(id)
            .map(|messages| {
                messages
                    .iter()
                    .filter(|message| message["type"] == kind)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    fn open(&mut self, id: &str, request_id: &str) {
        self.send(
            id,
            ClientMessage::FriendOpen { request_id: request_id.into() },
        );
    }

    fn add(&mut self, id: &str, name: &str, request_id: &str) {
        self.send(
            id,
            ClientMessage::FriendAdd { request_id: request_id.into(), player_name: name.into() },
        );
    }

    fn remove(&mut self, id: &str, target: &str, request_id: &str) {
        self.send(
            id,
            ClientMessage::FriendRemove { request_id: request_id.into(), player_id: target.into() },
        );
    }

    fn block(&mut self, id: &str, name: &str, request_id: &str) {
        self.send(
            id,
            ClientMessage::FriendBlock { request_id: request_id.into(), player_name: name.into() },
        );
    }

    fn unblock(&mut self, id: &str, target: &str, request_id: &str) {
        self.send(
            id,
            ClientMessage::FriendUnblock { request_id: request_id.into(), player_id: target.into() },
        );
    }

    fn result(&mut self, id: &str) -> serde_json::Value {
        self.last(id, "friendResult").expect("friend result")
    }

    fn state(&mut self, id: &str) -> serde_json::Value {
        self.last(id, "friendState").expect("friend state")
    }

    fn chat(&mut self, id: &str, text: &str, request_id: &str) {
        self.send(
            id,
            ClientMessage::ChatSend { request_id: request_id.into(), text: text.into() },
        );
    }
}

/// The names in one list, in the order the server sent them.
fn friend_names(view: &serde_json::Value, key: &str) -> Vec<String> {
    view[key]
        .as_array()
        .expect("friend list")
        .iter()
        .map(|row| row["name"].as_str().expect("row name").to_owned())
        .collect()
}

fn friend_row<'a>(view: &'a serde_json::Value, key: &str, name: &str) -> Option<&'a serde_json::Value> {
    view[key].as_array()?.iter().find(|entry| entry["name"] == name)
}

// f01 --------------------------------------------------------------------

#[test]
fn f01_opening_the_window_returns_both_lists_and_nothing_else() {
    let mut rig = FriendRig::new(&["a"], &[]);
    rig.open("a", "open-1");

    let result = rig.result("a");
    assert_eq!(result["success"], true);
    assert_eq!(result["code"], "");

    let view = rig.state("a");
    // Both lists always arrive together: a block also dissolves a friendship,
    // so a half-window would let a client show a row the account lacks.
    assert_eq!(friend_names(&view, "friends"), Vec::<String>::new());
    assert_eq!(friend_names(&view, "blocked"), Vec::<String>::new());
}

// f02 --------------------------------------------------------------------

#[test]
fn f02_adding_a_friend_writes_the_relation_in_both_directions() {
    let mut rig = FriendRig::new(&["a", "b"], &[]);
    rig.add("a", "b", "add-1");
    assert_eq!(rig.result("a")["success"], true);

    // The actor's own window is refreshed...
    let a_view = rig.state("a");
    assert_eq!(friend_names(&a_view, "friends"), vec!["b".to_owned()]);

    // ...and so is the target's, without the target asking.  This is the whole
    // point of writing the pair: a friend row is symmetric in the original.
    let b_view = rig.state("b");
    assert_eq!(friend_names(&b_view, "friends"), vec!["a".to_owned()]);
}

// f03 --------------------------------------------------------------------

#[test]
fn f03_adding_rejects_self_strangers_and_duplicates() {
    let mut rig = FriendRig::new(&["a", "b"], &[]);

    rig.add("a", "nobody", "add-missing");
    assert_eq!(rig.result("a")["code"], "friend_unknown_player");

    rig.add("a", "a", "add-self");
    assert_eq!(rig.result("a")["code"], "friend_self");

    rig.add("a", "b", "add-b-1");
    assert_eq!(rig.result("a")["success"], true);
    rig.add("a", "b", "add-b-2");
    assert_eq!(rig.result("a")["code"], "friend_already");

    // And the duplicate never produced a second row.
    rig.open("a", "open-2");
    assert_eq!(friend_names(&rig.state("a"), "friends"), vec!["b".to_owned()]);
}

// f04 --------------------------------------------------------------------

#[test]
fn f04_removing_a_friend_clears_both_directions_and_refuses_strangers() {
    let mut rig = FriendRig::new(&["a", "b"], &[]);
    rig.add("a", "b", "add-1");
    rig.pump_all();

    rig.remove("a", "b", "remove-1");
    assert_eq!(rig.result("a")["success"], true);

    let a_view = rig.state("a");
    assert_eq!(friend_names(&a_view, "friends"), Vec::<String>::new());
    let b_view = rig.state("b");
    assert_eq!(friend_names(&b_view, "friends"), Vec::<String>::new());

    // Removing somebody who was never a friend is refused, not silently
    // accepted — otherwise a client could probe the list by removal.
    rig.remove("a", "b", "remove-2");
    assert_eq!(rig.result("a")["code"], "friend_not_friend");
}

// f05 --------------------------------------------------------------------

#[test]
fn f05_blocking_dissolves_a_live_friendship_in_both_directions() {
    let mut rig = FriendRig::new(&["a", "b"], &[]);
    rig.add("a", "b", "add-1");
    rig.pump_all();

    rig.block("a", "b", "block-1");
    assert_eq!(rig.result("a")["success"], true);

    let a_view = rig.state("a");
    assert_eq!(friend_names(&a_view, "blocked"), vec!["b".to_owned()]);
    // The friendship is gone on the blocker's side...
    assert_eq!(friend_names(&a_view, "friends"), Vec::<String>::new());
    // ...and on the blocked character's side, which never asked for any of it.
    let b_view = rig.state("b");
    assert_eq!(friend_names(&b_view, "friends"), Vec::<String>::new());
    // A block is one-way: the blocked character's own blacklist is untouched.
    assert_eq!(friend_names(&b_view, "blocked"), Vec::<String>::new());
}

// f06 --------------------------------------------------------------------

#[test]
fn f06_unblocking_removes_the_row_and_refuses_rows_that_are_not_there() {
    let mut rig = FriendRig::new(&["a", "b"], &[]);
    rig.block("a", "b", "block-1");
    rig.pump_all();

    rig.unblock("a", "b", "unblock-1");
    assert_eq!(rig.result("a")["success"], true);
    assert_eq!(friend_names(&rig.state("a"), "blocked"), Vec::<String>::new());

    rig.unblock("a", "b", "unblock-2");
    assert_eq!(rig.result("a")["code"], "friend_not_blocked");
}

// f07 --------------------------------------------------------------------

#[test]
fn f07_a_friendship_cannot_be_forced_across_an_earlier_block() {
    let mut rig = FriendRig::new(&["a", "b"], &[]);
    // `b` blocks `a` first.
    rig.block("b", "a", "block-1");
    assert_eq!(rig.result("b")["success"], true);

    // Now `a` tries to add `b`.  The relation already carries an explicit
    // refusal, so the add is declined instead of half-restoring the pair.
    rig.add("a", "b", "add-1");
    assert_eq!(rig.result("a")["code"], "friend_declined");
    rig.open("a", "open-1");
    assert_eq!(friend_names(&rig.state("a"), "friends"), Vec::<String>::new());
}

// f08 --------------------------------------------------------------------

#[test]
fn f08_a_replayed_request_id_replays_the_original_outcome_without_writing_twice() {
    let mut rig = FriendRig::new(&["a", "b"], &[]);
    rig.add("a", "b", "same-request");
    let first = rig.result("a");
    assert_eq!(first["success"], true);

    // Replay the exact same request id, this time naming somebody else.  A
    // server that re-ran the intent would now add `c` as well.
    rig.add("a", "c", "same-request");
    let replay = rig.result("a");
    assert_eq!(replay["success"], first["success"]);
    assert_eq!(replay["code"], first["code"]);

    rig.open("a", "open-1");
    assert_eq!(friend_names(&rig.state("a"), "friends"), vec!["b".to_owned()]);
}

// f09 --------------------------------------------------------------------

#[test]
fn f09_the_online_flag_and_location_follow_the_live_world_and_are_never_cached() {
    // `b` has an account but is not in the world yet.
    let mut rig = FriendRig::new(&["a"], &["b"]);
    rig.add("a", "b", "add-1");
    rig.open("a", "open-1");

    let offline = rig.state("a");
    let entry = friend_row(&offline, "friends", "b").expect("offline friend row");
    assert_eq!(entry["online"], false);
    // An offline character has no location at all — an empty string, not a
    // stale map id left over from the last time it was seen.
    assert_eq!(entry["mapId"], "");

    // `b` logs in: the roster changed, so the watching window is refreshed.
    rig.join("b");
    let online = rig.state("a");
    let entry = friend_row(&online, "friends", "b").expect("online friend row");
    assert_eq!(entry["online"], true);
    assert_eq!(entry["mapId"], FRIEND_MAP_ID);

    // And logging out flips it back without the client asking.
    rig.leave("b");
    let gone = rig.state("a");
    let entry = friend_row(&gone, "friends", "b").expect("friend row after logout");
    assert_eq!(entry["online"], false);
    assert_eq!(entry["mapId"], "");
}

// f10 --------------------------------------------------------------------

#[test]
fn f10_a_blacklisted_character_s_map_chat_never_reaches_the_blocker() {
    let mut rig = FriendRig::new(&["a", "b", "c"], &[]);
    rig.block("a", "b", "block-1");
    rig.pump_all();

    rig.chat("b", "hello", "chat-1");
    rig.pump_all();

    // The blocker is silent.
    assert!(rig.all("a", "chatMessage").is_empty(), "a blocked b, so a must not hear b");
    // The sender still hears itself — a block is not a mute.
    assert_eq!(rig.all("b", "chatMessage").len(), 1);
    // And an unblocked bystander is unaffected.
    assert_eq!(rig.all("c", "chatMessage").len(), 1);

    // Removing the block restores the channel: the silence was a consequence
    // of the row, not of a separate mute list.
    rig.unblock("a", "b", "unblock-1");
    rig.pump_all();
    rig.chat("b", "hello again", "chat-2");
    rig.pump_all();
    assert_eq!(rig.all("a", "chatMessage").len(), 1);
}

// f11 --------------------------------------------------------------------

#[test]
fn f11_the_friend_list_cap_is_enforced_by_the_server_not_the_client() {
    // One real character plus a full list of offline names: the cap has to be
    // reached before the refusing add, and every name needs an account row.
    let crowd: Vec<String> = (0..60).map(|index| format!("crowd{index:02}")).collect();
    let crowd_refs: Vec<&str> = crowd.iter().map(|name| name.as_str()).collect();
    let mut rig = FriendRig::new(&["a"], &crowd_refs);

    let mut added = 0;
    for name in &crowd {
        rig.add("a", name, &format!("add-{name}"));
        if rig.result("a")["success"] == true {
            added += 1;
        } else {
            break;
        }
    }
    // `FRIEND_LIMIT` is 50, so the 51st add is the one that must be refused.
    assert_eq!(added, 50, "the cap should stop the list at 50");
    assert_eq!(rig.result("a")["code"], "friend_full");

    // The window still reports exactly the capped rows.
    rig.open("a", "open-1");
    assert_eq!(friend_names(&rig.state("a"), "friends").len(), 50);
}

// f12 --------------------------------------------------------------------

#[test]
fn f12_a_refused_intent_is_remembered_so_the_same_id_cannot_be_retried_into_another_answer() {
    let mut rig = FriendRig::new(&["a", "b"], &[]);
    rig.add("a", "nobody", "bad-request");
    assert_eq!(rig.result("a")["code"], "friend_unknown_player");

    // Retry the same id with a name that *does* resolve.  The recorded refusal
    // wins, so a client cannot wear a server down by retrying.
    rig.add("a", "b", "bad-request");
    let replay = rig.result("a");
    assert_eq!(replay["success"], false);
    assert_eq!(replay["code"], "friend_unknown_player");

    rig.open("a", "open-1");
    assert_eq!(friend_names(&rig.state("a"), "friends"), Vec::<String>::new());
}
