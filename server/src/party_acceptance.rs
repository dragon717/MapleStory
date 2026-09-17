// Directional acceptance for the party module (`PartyInvite` / `PartyRespond`
// / `PartyLeave` / `PartyKick` / `PartyLeader`).
//
// A party is the one part of the original game that turns "several characters
// on one map" into a system: it has a leader, a bounded roster, an invitation
// handshake, EXP that reaches members who never landed a hit, and buffs that
// reach the neighbours instead of only the caster.
//
// Everything here is about the boundaries that keep that safe.  The client
// only ever names a character to invite, or answers an invitation with
// yes/no — so the server must re-derive who exists, whether a party has to be
// created, whether it has room, who leads it, who is actually on the same map
// for sharing, and whether a retried intent already happened.  A forged or
// replayed request must never add a stranger to a party, exceed the roster,
// steal leadership, or pay an EXP bonus twice.

use super::*;

const PARTY_MAP_ID: &str = "party-test";
/// A monster a level-1 character always kills in one hit, with a round EXP
/// value so the bonus arithmetic is exact.
const PARTY_MONSTER_ID: &str = "party-mob";
const PARTY_MONSTER_EXP: u64 = 100;

fn party_map() -> Map {
    Map {
        id: PARTY_MAP_ID.into(),
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

fn party_template() -> MonsterTemplate {
    MonsterTemplate {
        template_id: "100100".into(),
        level: 1,
        max_hp: 1,
        max_mp: 0,
        boss: false,
        pa_damage: Some(0),
        pd_damage: Some(0),
        pd_rate: None,
        md_rate: None,
        exp: PARTY_MONSTER_EXP,
        body_attack: false,
        move_speed: None,
        source_speed: None,
        hitbox_width: Some(40.0),
        hitbox_height: Some(40.0),
        hitbox_lt: None,
        hitbox_rb: None,
        die_duration_ms: Some(50),
        stand_delay_ms: None,
        move_duration_ms: None,
        drop: None,
        skills: Vec::new(),
        body_disease: None,
        body_disease_level: None,
    }
}

/// The real attack silhouette from `shared/gameplay.json`.  The default
/// `PlayerConfig` leaves `attackLt`/`attackRb` empty, which makes
/// `attack_bounds` return `None`, so no attack would ever find a target and
/// every kill assertion here would silently read as "no reward".
fn party_player_config() -> PlayerConfig {
    #[derive(serde::Deserialize)]
    struct PlayerOnly {
        player: PlayerConfig,
    }
    serde_json::from_str::<PlayerOnly>(include_str!("../../shared/gameplay.json"))
        .expect("shared gameplay player")
        .player
}

/// A wide EXP table so a test's EXP stays an exact number: nothing levels up.
fn party_gameplay(with_monster: bool) -> Gameplay {
    Gameplay {
        player: party_player_config(),
        monsters: if with_monster { vec![party_template()] } else { Vec::new() },
        spawns: if with_monster {
            vec![MonsterSpawn {
                id: PARTY_MONSTER_ID.into(),
                template_id: "100100".into(),
                x: 140.0,
                y: 100.0,
                foothold_id: Some(1),
                map_id: PARTY_MAP_ID.into(),
                facing: 1,
                // One-shot spawn: no respawn can feed a second kill into a
                // test that is asserting on a single settled reward.
                mob_time: -1,
                rx0: None,
                rx1: None,
            }]
        } else {
            Vec::new()
        },
        exp_table: vec![1_000_000],
        monster_respawn_ms: Some(600_000),
        ..Gameplay::default()
    }
}

fn party_profile() -> Profile {
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
        map_id: PARTY_MAP_ID.into(),
        x: 100.0,
        y: 100.0,
        inventory: Vec::new(),
        skills: BTreeMap::new(),
        skill_points: BTreeMap::new(),
        ability_stats: AbilityStats::default(),
    }
}

struct PartyRig {
    world: World,
    inbox: BTreeMap<String, mpsc::Receiver<String>>,
    /// Rolling tap of everything each character has been sent, so a test can
    /// look for a message after later traffic without racing the drain order.
    seen: BTreeMap<String, Vec<serde_json::Value>>,
}

impl PartyRig {
    fn new(ids: &[&str], with_monster: bool) -> Self {
        let path = std::env::temp_dir().join(format!("maple-party-{}.sqlite3", auth::random_id()));
        let service = auth::start(&path).expect("temp store");
        for id in ids {
            service
                .store
                .load_profile(id, &party_profile())
                .expect("seed profile");
        }
        let mut world = World::new_with_store(
            party_map(),
            600,
            party_gameplay(with_monster),
            service.store.clone(),
        )
        .expect("world with store");
        let mut inbox = BTreeMap::new();
        for id in ids {
            let channel = join_test_player(&mut world, id);
            inbox.insert((*id).to_owned(), channel);
        }
        world.step();
        let mut rig = Self { world, inbox, seen: BTreeMap::new() };
        for id in ids {
            rig.pump(id);
        }
        rig
    }

    fn send(&mut self, id: &str, message: ClientMessage) {
        self.world.command(Command::Input {
            id: id.to_owned(),
            connection: format!("{id}-connection"),
            message,
        });
    }

    /// Pull everything new since the last call and return how many messages
    /// arrived.  Snapshots are skipped: they are world traffic, not party
    /// traffic, and counting them would make "nothing was sent" unprovable.
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

    fn last(&mut self, id: &str, kind: &str) -> Option<serde_json::Value> {
        self.pump(id);
        self.seen
            .get(id)?
            .iter()
            .rev()
            .find(|message| message["type"] == kind)
            .cloned()
    }

    /// Every message of `kind` seen so far, oldest first.
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

    fn invite(&mut self, from: &str, to: &str, request_id: &str) {
        self.send(
            from,
            ClientMessage::PartyInvite {
                request_id: request_id.into(),
                player_name: to.into(),
            },
        );
    }

    fn respond(&mut self, id: &str, accept: bool, request_id: &str) {
        self.send(
            id,
            ClientMessage::PartyRespond {
                request_id: request_id.into(),
                accept,
            },
        );
    }

    /// Walk the invite/target pair into one party and return the roster view
    /// the last member was sent.
    fn pair_up(&mut self, a: &str, b: &str) -> serde_json::Value {
        self.invite(a, b, "invite-1");
        self.respond(b, true, "respond-1");
        self.last(b, "partyState")
            .expect("join broadcasts a party view")
    }

    fn exp(&self, id: &str) -> u64 {
        self.world.players[id].state.exp
    }

    fn hit_the_monster(&mut self, id: &str, request_id: &str) {
        self.send(
            id,
            ClientMessage::Attack {
                request_id: request_id.into(),
            },
        );
        // The hit lands on a later tick (attack_after_ms); step past it.
        for _ in 0..16 {
            self.world.step();
        }
    }
}

fn members(view: &serde_json::Value) -> Vec<String> {
    view["members"]
        .as_array()
        .expect("member list")
        .iter()
        .map(|member| member["name"].as_str().expect("member name").to_owned())
        .collect()
}

// p01 --------------------------------------------------------------------

#[test]
fn p01_the_first_invitation_creates_the_party_and_the_answer_joins_it() {
    let mut rig = PartyRig::new(&["a", "b"], false);
    rig.invite("a", "b", "invite-1");

    let result = rig.last("a", "partyResult").expect("inviter gets a result");
    assert_eq!(result["success"], true);

    // The invited character is told, and only that character.
    let invite = rig.last("b", "partyInvite").expect("invitee gets the invitation");
    assert_eq!(invite["fromName"], "a");
    assert!(invite["invitationId"].as_str().is_some_and(|id| !id.is_empty()));

    rig.respond("b", true, "respond-1");
    let view = rig.last("b", "partyState").expect("roster arrives on join");
    assert_eq!(members(&view).len(), 2);
    assert_eq!(view["leaderId"], "a");
    let leader_flag = view["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|member| member["name"] == "a")
        .map(|member| member["leader"].clone())
        .expect("leader row");
    assert_eq!(leader_flag, serde_json::json!(true));
    // The inviter sees the same roster without asking again.
    let inviter_view = rig.last("a", "partyState").expect("inviter roster");
    assert_eq!(members(&inviter_view), members(&view));
}

// p02 --------------------------------------------------------------------

#[test]
fn p02_invitations_reject_strangers_self_duplicates_and_busy_targets() {
    let mut rig = PartyRig::new(&["a", "b", "c"], false);

    rig.invite("a", "nobody", "invite-missing");
    assert_eq!(
        rig.last("a", "partyResult").expect("result")["code"],
        "party_unknown_player"
    );

    rig.invite("a", "a", "invite-self");
    assert_eq!(rig.last("a", "partyResult").expect("result")["code"], "party_self");

    // The first invitation to `b` is pending, so a second one is refused
    // instead of overwriting the window `b` is looking at.
    rig.invite("a", "b", "invite-b-1");
    assert_eq!(rig.last("a", "partyResult").expect("result")["success"], true);
    rig.invite("a", "b", "invite-b-2");
    assert_eq!(rig.last("a", "partyResult").expect("result")["code"], "party_busy");

    // `c` is already grouped with `a`, so it cannot be invited into the same
    // party twice — and the roster never grows a duplicate row.
    rig.respond("b", true, "respond-b");
    rig.pump("a");
    rig.pump("b");
    rig.invite("a", "c", "invite-c-1");
    rig.pump("a");
    rig.respond("c", true, "respond-c");
    rig.pump("a");
    rig.pump("c");
    rig.invite("a", "c", "invite-c-2");
    assert_eq!(rig.last("a", "partyResult").expect("result")["code"], "party_already");

    // And a character that already has a party cannot be pulled into another.
    let mut rig = PartyRig::new(&["x", "y", "z"], false);
    rig.invite("x", "y", "invite-xy");
    rig.pump("x");
    rig.pump("y");
    rig.respond("y", true, "respond-xy");
    rig.pump("x");
    rig.pump("y");
    rig.invite("z", "y", "invite-zy");
    assert_eq!(rig.last("z", "partyResult").expect("result")["code"], "party_already");
}

// p03 --------------------------------------------------------------------

#[test]
fn p03_the_roster_is_capped_and_a_full_party_refuses_the_next_invite() {
    let ids = ["a", "b", "c", "d", "e", "f", "g"];
    let mut rig = PartyRig::new(&ids, false);
    for (index, id) in ids.iter().skip(1).enumerate() {
        rig.invite("a", id, &format!("invite-{index}"));
        if index + 2 > PARTY_MAX_MEMBERS {
            break;
        }
        rig.pump("a");
        rig.respond(id, true, &format!("respond-{index}"));
        rig.pump("a");
        rig.pump(id);
    }
    let view = rig.last("a", "partyState").expect("roster");
    assert_eq!(members(&view).len(), PARTY_MAX_MEMBERS);

    rig.invite("a", "g", "invite-overflow");
    assert_eq!(rig.last("a", "partyResult").expect("result")["code"], "party_full");
}

// p04 --------------------------------------------------------------------

#[test]
fn p04_only_the_leader_may_invite_kick_or_hand_over_leadership() {
    let mut rig = PartyRig::new(&["a", "b", "c"], false);
    rig.pair_up("a", "b");

    // `b` is a member, not the leader: inviting is refused outright.
    rig.invite("b", "c", "invite-by-member");
    let result = rig.last("b", "partyResult").expect("result");
    assert_eq!(result["success"], false);
    assert_eq!(result["code"], "party_not_leader");

    rig.send(
        "b",
        ClientMessage::PartyKick {
            request_id: "kick-by-member".into(),
            player_id: "a".into(),
        },
    );
    let result = rig.last("b", "partyResult").expect("result");
    assert_eq!(result["code"], "party_not_leader");
    assert!(rig.world.parties.values().any(|party| party.members.len() == 2));

    // A leader cannot kick itself, and a foreign id is not a member.
    rig.send(
        "a",
        ClientMessage::PartyKick {
            request_id: "kick-self".into(),
            player_id: "a".into(),
        },
    );
    assert_eq!(rig.last("a", "partyResult").expect("result")["code"], "party_self");
    rig.send(
        "a",
        ClientMessage::PartyKick {
            request_id: "kick-stranger".into(),
            player_id: "c".into(),
        },
    );
    assert_eq!(
        rig.last("a", "partyResult").expect("result")["code"],
        "party_not_party_member"
    );
}

// p05 --------------------------------------------------------------------

#[test]
fn p05_a_kick_removes_one_member_and_leaves_the_leader_in_charge() {
    let mut rig = PartyRig::new(&["a", "b", "c"], false);
    rig.pair_up("a", "b");
    rig.invite("a", "c", "invite-c");
    rig.pump("a");
    rig.pump("c");
    rig.respond("c", true, "respond-c");
    rig.pump("a");
    rig.pump("c");

    rig.send(
        "a",
        ClientMessage::PartyKick {
            request_id: "kick-c".into(),
            player_id: "c".into(),
        },
    );
    assert_eq!(rig.last("a", "partyResult").expect("result")["success"], true);
    let view = rig.last("a", "partyState").expect("roster");
    assert_eq!(members(&view), vec!["a".to_owned(), "b".to_owned()]);
    assert_eq!(view["leaderId"], "a");

    // The removed member's window closes and it is told why.
    assert_eq!(rig.last("c", "partyState").expect("closed view")["closed"], true);
    let notice = rig.last("c", "partyNotice").expect("kick notice");
    assert_eq!(notice["code"], "party_kicked");
    assert_eq!(notice["playerName"], "a");
    assert!(rig.world.party_id_of("c").is_none());
}

// p06 --------------------------------------------------------------------

#[test]
fn p06_leaving_hands_leadership_over_and_an_empty_roster_disbands() {
    let mut rig = PartyRig::new(&["a", "b", "c"], false);
    rig.pair_up("a", "b");
    rig.invite("a", "c", "invite-c");
    rig.pump("a");
    rig.pump("c");
    rig.respond("c", true, "respond-c");
    rig.pump("a");
    rig.pump("b");
    rig.pump("c");

    rig.send("a", ClientMessage::PartyLeave { request_id: "leave-a".into() });
    assert_eq!(rig.last("a", "partyResult").expect("result")["success"], true);
    // The leader left, so the surviving members carry on with a new leader.
    let view = rig.last("b", "partyState").expect("roster");
    assert_eq!(members(&view), vec!["b".to_owned(), "c".to_owned()]);
    assert_eq!(view["leaderId"], "b");
    assert!(rig.world.party_id_of("a").is_none());

    // Dropping to a single member ends the party — one member is not a party,
    // and there is no disband command that a lone member could use instead.
    rig.send("c", ClientMessage::PartyLeave { request_id: "leave-c".into() });
    assert_eq!(rig.last("b", "partyState").expect("closed")["closed"], true);
    assert!(rig.world.parties.is_empty());
    assert!(rig.world.party_invites.is_empty());
}

// p07 --------------------------------------------------------------------

#[test]
fn p07_declining_tells_both_sides_and_leaves_nobody_grouped() {
    let mut rig = PartyRig::new(&["a", "b"], false);
    rig.invite("a", "b", "invite-1");
    rig.pump("a");
    rig.pump("b");

    rig.respond("b", false, "respond-1");
    assert_eq!(
        rig.last("b", "partyResult").expect("result")["code"],
        "party_declined"
    );
    let notice = rig.last("a", "partyNotice").expect("inviter is told");
    assert_eq!(notice["code"], "party_declined");
    assert_eq!(notice["playerName"], "b");
    assert!(rig.world.party_id_of("a").is_none());
    assert!(rig.world.party_id_of("b").is_none());
}

// p08 --------------------------------------------------------------------

#[test]
fn p08_answering_without_an_invitation_and_leaving_without_a_party_are_refused() {
    let mut rig = PartyRig::new(&["a", "b"], false);

    rig.respond("b", true, "respond-none");
    assert_eq!(
        rig.last("b", "partyResult").expect("result")["code"],
        "party_no_invite"
    );

    rig.send("b", ClientMessage::PartyLeave { request_id: "leave-none".into() });
    assert_eq!(
        rig.last("b", "partyResult").expect("result")["code"],
        "party_not_member"
    );

    // An invitation for somebody else cannot be answered by naming a party.
    rig.invite("a", "b", "invite-1");
    rig.pump("a");
    rig.pump("b");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while rig.world.party_id_of("a").is_none() && std::time::Instant::now() < deadline {
        rig.world.step();
    }
    // The invitation stays pending: answering it is still possible later, and
    // the party it would join was not silently dissolved in the meantime.
    assert_eq!(rig.world.party_invites.len(), 1);
    rig.respond("b", true, "respond-late");
    assert_eq!(rig.last("b", "partyResult").expect("result")["success"], true);
    assert_eq!(rig.world.party_id_of("b").as_deref(), rig.world.party_id_of("a").as_deref());
}

// p09 --------------------------------------------------------------------

#[test]
fn p09_a_replayed_invitation_is_answered_from_the_recorded_outcome() {
    let mut rig = PartyRig::new(&["a", "b"], false);

    rig.invite("a", "b", "invite-1");
    assert_eq!(rig.last("a", "partyResult").expect("result")["success"], true);
    assert_eq!(rig.last("b", "partyInvite").expect("one invitation")["fromName"], "a");
    assert_eq!(rig.pump("b"), 0, "a replay must not invite twice");

    // Same request id again: the original result is re-sent, no new pending
    // invitation is created and the target sees nothing.
    rig.invite("a", "b", "invite-1");
    assert_eq!(rig.last("a", "partyResult").expect("replayed result")["success"], true);
    assert_eq!(rig.pump("b"), 0);
    assert_eq!(rig.world.party_invites.len(), 1);

    // A refused intent is replayed as a refusal, not re-evaluated.
    rig.invite("a", "nobody", "invite-missing");
    assert_eq!(
        rig.last("a", "partyResult").expect("result")["code"],
        "party_unknown_player"
    );
    rig.invite("a", "nobody", "invite-missing");
    assert_eq!(
        rig.last("a", "partyResult").expect("replayed refusal")["code"],
        "party_unknown_player"
    );

    // A replayed kick also only kicks once.
    rig.respond("b", true, "respond-1");
    rig.pump("a");
    rig.pump("b");
    rig.send(
        "a",
        ClientMessage::PartyKick {
            request_id: "kick-b".into(),
            player_id: "b".into(),
        },
    );
    assert_eq!(rig.last("a", "partyResult").expect("result")["success"], true);
    let kicked_notices = rig.pump("b");
    assert!(kicked_notices > 0, "the kicked member is told once");
    rig.send(
        "a",
        ClientMessage::PartyKick {
            request_id: "kick-b".into(),
            player_id: "b".into(),
        },
    );
    assert_eq!(rig.last("a", "partyResult").expect("replay")["success"], true);
    assert_eq!(rig.pump("b"), 0, "a replay must not kick twice");
}

// p10 --------------------------------------------------------------------

#[test]
fn p10_leaving_the_world_prunes_the_member_and_broadcasts_the_new_roster() {
    let mut rig = PartyRig::new(&["a", "b", "c"], false);
    rig.pair_up("a", "b");
    rig.invite("a", "c", "invite-c");
    rig.pump("a");
    rig.pump("c");
    rig.respond("c", true, "respond-c");
    rig.pump("a");
    rig.pump("c");

    // A plain logout removes the character; the tick then prunes the roster.
    rig.send("b", ClientMessage::Logout);
    rig.world.step();
    rig.world.step();

    let view = rig.last("a", "partyState").expect("pruned roster");
    assert_eq!(members(&view), vec!["a".to_owned(), "c".to_owned()]);
    assert!(rig.world.party_id_of("b").is_none());

    // Losing everybody but one dissolves the party, and the survivor's window
    // closes instead of showing a phantom roster.
    rig.send("c", ClientMessage::Logout);
    rig.world.step();
    rig.world.step();
    assert_eq!(rig.last("a", "partyState").expect("closed")["closed"], true);
    assert!(rig.world.parties.is_empty());
}

// p11 --------------------------------------------------------------------

#[test]
fn p11_a_kill_pays_a_party_bonus_to_every_member_on_the_map() {
    let mut rig = PartyRig::new(&["a", "b"], true);
    rig.pair_up("a", "b");

    rig.hit_the_monster("a", "attack-1");

    // Base share: the killer alone dealt all the damage, so it keeps the
    // monster's authored EXP.  Bonus pool: 5% of 100 for the second member,
    // split by level between the two level-1 characters (2 each).
    assert_eq!(rig.exp("a"), PARTY_MONSTER_EXP + 2);
    assert_eq!(rig.exp("b"), 2, "a member that never hit still shares the bonus");
}

// p12 --------------------------------------------------------------------

#[test]
fn p12_a_solo_kill_is_unchanged_by_the_party_rule() {
    let mut rig = PartyRig::new(&["a"], true);
    rig.hit_the_monster("a", "attack-1");
    assert_eq!(rig.exp("a"), PARTY_MONSTER_EXP, "no party means no bonus pool");
}

// p13 --------------------------------------------------------------------

#[test]
fn p13_only_members_on_the_killers_map_share_the_bonus() {
    let mut rig = PartyRig::new(&["a", "b"], true);
    rig.pair_up("a", "b");
    assert_eq!(rig.world.party_exp_members("a").len(), 2);

    // A member that is grouped but elsewhere is not part of the group play.
    // Moving the character is the same authoritative fact a portal change
    // would produce; only the map differs.
    rig.world.players.get_mut("b").expect("member").map_id = "party-test-elsewhere".into();
    assert_eq!(rig.world.party_members_on_map("a"), vec!["a".to_owned()]);
    assert!(rig.world.party_exp_members("a").is_empty());

    rig.hit_the_monster("a", "attack-1");
    assert_eq!(rig.exp("a"), PARTY_MONSTER_EXP);
    assert_eq!(rig.exp("b"), 0, "a member on another map earns nothing");
}

// p14 --------------------------------------------------------------------

#[test]
fn p14_party_buffs_reach_the_members_on_the_map_and_nobody_else() {
    let mut rig = PartyRig::new(&["a", "b", "c"], true);
    rig.pair_up("a", "b");
    rig.world.players.get_mut("c").expect("outsider").map_id = PARTY_MAP_ID.into();
    // `c` is on the map but not in the party: it must not receive the aura.

    let meditation = MageLevel {
        time: Some(60),
        indie_mad: Some(30),
        ..MageLevel::default()
    };
    rig.world.apply_meditation("a", &meditation);
    assert!(rig.world.players["a"].meditation_until > rig.world.tick);
    assert_eq!(rig.world.players["a"].meditation_mad, 30);
    assert!(rig.world.players["b"].meditation_until > rig.world.tick);
    assert_eq!(rig.world.players["b"].meditation_mad, 30);
    assert_eq!(rig.world.players["c"].meditation_until, 0);

    // A member that stepped out of range keeps nothing new.
    rig.world.players.get_mut("b").expect("member").meditation_until = 0;
    rig.world.players.get_mut("b").expect("member").meditation_mad = 0;
    rig.world.players.get_mut("b").expect("member").map_id = "party-test-elsewhere".into();
    rig.world.apply_meditation("a", &meditation);
    assert_eq!(rig.world.players["b"].meditation_until, 0);

    // The adventurer-wide damage buff follows the same rule.
    rig.world.players.get_mut("b").expect("member").map_id = PARTY_MAP_ID.into();
    rig.world
        .activate_hyper_adventurer("a", &MageLevel {
            time: Some(60),
            ..MageLevel::default()
        });
    assert!(rig.world.players["a"].status.buff_active(SKILL_HYPER_ADVENTURER));
    assert!(rig.world.players["b"].status.buff_active(SKILL_HYPER_ADVENTURER));
    assert!(!rig.world.players["c"].status.buff_active(SKILL_HYPER_ADVENTURER));
}

// p15 --------------------------------------------------------------------

#[test]
fn p15_leadership_can_be_handed_over_without_changing_the_roster() {
    let mut rig = PartyRig::new(&["a", "b", "c"], false);
    rig.pair_up("a", "b");
    rig.invite("a", "c", "invite-c");
    rig.pump("a");
    rig.pump("c");
    rig.respond("c", true, "respond-c");
    rig.pump("a");
    rig.pump("c");

    rig.send(
        "a",
        ClientMessage::PartyLeader {
            request_id: "leader-b".into(),
            player_id: "b".into(),
        },
    );
    assert_eq!(rig.last("a", "partyResult").expect("result")["success"], true);
    let view = rig.last("b", "partyState").expect("roster");
    assert_eq!(view["leaderId"], "b");
    assert_eq!(members(&view), vec!["a".to_owned(), "b".to_owned(), "c".to_owned()]);

    // The old leader can no longer kick, and the new one can.
    rig.send(
        "a",
        ClientMessage::PartyKick {
            request_id: "kick-after".into(),
            player_id: "b".into(),
        },
    );
    assert_eq!(
        rig.last("a", "partyResult").expect("result")["code"],
        "party_not_leader"
    );
    rig.send(
        "b",
        ClientMessage::PartyKick {
            request_id: "kick-a".into(),
            player_id: "a".into(),
        },
    );
    assert_eq!(rig.last("b", "partyResult").expect("result")["success"], true);
    let view = rig.last("b", "partyState").expect("roster");
    assert_eq!(view["leaderId"], "b");
    assert_eq!(members(&view), vec!["b".to_owned(), "c".to_owned()]);
}
