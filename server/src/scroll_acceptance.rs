// Directional acceptance for the map-move consumable module (传送卷軸).
//
// 273 ships two shapes of teleport scroll and they resolve their destination in
// two different places.  維多利亞港卷軸 (2030001) names its town outright in
// `spec.moveTo`, but 回家卷軸 (2030000) authors only the sentinel 999999999 —
// "send me to this map's own `returnMap`" — so its destination can only come
// from the map the body is standing on.  These checks pin the boundaries that
// decide correctness:
//
//   * the destination is a world fact, never something the client sends;
//   * a scroll that resolves to nothing (no `returnMap`, an unassembled town,
//     a practice instance, a corpse) is refused *before* anything is spent;
//   * a replayed request travels once, not twice;
//   * landing on a town scrubs the scene state a gate would scrub, so a live
//     summon or an ice field cannot follow the caster into a town;
//   * the ordinary potion path is untouched — the map-move gate must answer
//     "not my family" for every other Use-tab item.

use super::*;

/// 回家卷軸: `spec.moveTo = 999999999`, i.e. "the current map's `returnMap`".
const SCROLL_HOME: &str = "2030000";
/// 維多利亞港卷軸: `spec.moveTo = 104000000`, a town it names itself.
const SCROLL_VICTORIA: &str = "2030001";
const TOWN_VICTORIA: &str = "104000000";
/// The assembled birth map in the generated catalog.
const MAP_BIRTH: &str = "000010000";
/// The town `MAP_BIRTH` authors as its `returnMap`.
const MAP_HEARTH: &str = "001000000";
/// A third town so a two-hop check can prove the table is read per map.
const MAP_SLEEPY: &str = "001020000";

/// A flat, empty map: the fixture body only has to stand still and be moved.
fn scroll_map(id: &str, spawn_x: f64) -> Map {
    Map {
        id: id.to_owned(),
        bounds: Bounds {
            x_min: 0.0,
            x_max: 600.0,
            y_min: -400.0,
            y_max: 400.0,
        },
        spawn: Point {
            x: spawn_x,
            y: 100.0,
        },
        footholds: vec![Foothold {
            id: 1,
            x1: 0.0,
            y1: 100.0,
            x2: 600.0,
            y2: 100.0,
            prev: 0,
            next: 0,
            forbid_fall_down: 0,
        }],
        ladders: Vec::new(),
        portals: Vec::new(),
        water: Vec::new(),
        reactors: Vec::new(),
    }
}

/// Build a world whose birth map is `maps[0]` and whose return table is
/// `returns`.  Attaching a catalog is what carries the return table into the
/// world, so every check goes through the same door production does.
fn scroll_world(maps: Vec<Map>, returns: &[(&str, &str)]) -> (World, mpsc::Receiver<String>) {
    let mut maps = maps;
    let birth = maps.remove(0);
    let mut world = World::new(birth.clone(), 600);
    let mut all = vec![birth];
    all.extend(maps);
    world
        .attach_catalog(MapCatalog {
            birth_map_id: MAP_BIRTH.to_owned(),
            return_maps: returns
                .iter()
                .map(|(from, to)| ((*from).to_owned(), (*to).to_owned()))
                .collect(),
            maps: all,
        })
        .expect("fixture catalog");
    let output = join_test_player(&mut world, "traveler");
    (world, output)
}

/// The three-map world most checks use: birth -> hearth -> sleepy.
fn scroll_chain() -> (World, mpsc::Receiver<String>) {
    scroll_world(
        vec![
            scroll_map(MAP_BIRTH, 100.0),
            scroll_map(MAP_HEARTH, 220.0),
            scroll_map(MAP_SLEEPY, 340.0),
        ],
        &[
            (MAP_BIRTH, MAP_HEARTH),
            (MAP_HEARTH, MAP_SLEEPY),
            (MAP_SLEEPY, MAP_HEARTH),
        ],
    )
}

/// Put `quantity` of an item in slot 1 of the fixture body's Use tab.
fn scroll_stock(world: &mut World, item_id: &str, quantity: u32) {
    let player = world.players.get_mut("traveler").expect("fixture player");
    player.state.inventory.push(InventoryItem {
        slot: 1,
        item_id: item_id.to_owned(),
        quantity,
        stats: None,
        remaining_slots: None,
        upgrade_count: None,
    });
}

/// Send a `useItem` intent for the fixture body.
///
/// The message deliberately carries no destination: the protocol has no field
/// that could name a map, which is what makes "the client cannot pick where it
/// lands" structural rather than a validation rule.
fn scroll_use(world: &mut World, item_id: &str, request: &str) {
    world.command(Command::Input {
        id: "traveler".into(),
        message: ClientMessage::UseItem {
            request_id: request.to_owned(),
            inventory_type: 2,
            source_slot: 1,
            item_id: item_id.to_owned(),
            target_slot: None,
            target_item_id: None,
        },
        connection: "traveler-connection".into(),
    });
}

fn scroll_quantity(world: &World, item_id: &str) -> u32 {
    world
        .players
        .get("traveler")
        .and_then(|player| {
            player
                .state
                .inventory
                .iter()
                .find(|item| item.item_id == item_id)
        })
        .map(|item| item.quantity)
        .unwrap_or(0)
}

fn scroll_map_of(world: &World) -> String {
    world
        .players
        .get("traveler")
        .expect("fixture player")
        .map_id
        .clone()
}

/// Drop the fixture body onto `map_id` at that map's own spawn without using a
/// scroll, so a check can set up the "where was I standing" half deliberately.
fn scroll_stand(world: &mut World, map_id: &str) {
    let map = world.maps.get(map_id).cloned().expect("fixture map");
    let tick = world.tick;
    let player = world.players.get_mut("traveler").expect("fixture player");
    player.map_id = map_id.to_owned();
    reset_player_to_spawn(&map, player, tick);
}

fn scroll_last_reject(output: &mut mpsc::Receiver<String>) -> Option<serde_json::Value> {
    let mut found = None;
    while let Ok(message) = output.try_recv() {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&message) {
            if value["type"] == "rejected" {
                found = Some(value);
            }
        }
    }
    found
}

/// Drain the channel so a later `scroll_last_reject` only sees new output.
fn scroll_drain(output: &mut mpsc::Receiver<String>) {
    while output.try_recv().is_ok() {}
}

#[test]
fn home_scroll_lands_the_body_on_the_maps_return_town() {
    let (mut world, mut output) = scroll_chain();
    scroll_stock(&mut world, SCROLL_HOME, 2);

    scroll_use(&mut world, SCROLL_HOME, "home-1");

    assert_eq!(scroll_map_of(&world), MAP_HEARTH, "the scroll must move the body");
    assert_eq!(scroll_quantity(&world, SCROLL_HOME), 1, "exactly one unit is spent");
    assert!(
        scroll_last_reject(&mut output).is_none(),
        "a resolved scroll must not be rejected"
    );
    // The body arrives grounded on the destination's own spawn, rather than
    // left in the air over a map it is no longer on.
    let player = world.players.get("traveler").expect("fixture player");
    assert_eq!(player.state.x, 220.0, "the landing is the town's spawn");
    assert_eq!(player.state.y, 100.0, "the landing is grounded on the town's foothold");
    assert_eq!(player.state.action, "stand");
    assert!(player.state.grounded);
}

#[test]
fn home_scroll_resolves_against_the_map_the_body_stands_on() {
    // The same item, used twice from two different maps, must land in two
    // different towns.  A destination baked into the item would fail this.
    let (mut world, _output) = scroll_chain();
    scroll_stock(&mut world, SCROLL_HOME, 2);

    scroll_use(&mut world, SCROLL_HOME, "hop-1");
    assert_eq!(scroll_map_of(&world), MAP_HEARTH);

    scroll_use(&mut world, SCROLL_HOME, "hop-2");
    assert_eq!(
        scroll_map_of(&world),
        MAP_SLEEPY,
        "the second hop must read the new map's own returnMap"
    );
    assert_eq!(scroll_quantity(&world, SCROLL_HOME), 0);
}

#[test]
fn a_fixed_town_scroll_uses_the_town_it_names_without_a_return_entry() {
    // 維多利亞港卷軸 carries its own destination, so it must work even where
    // the map authors no `returnMap` at all.
    let (mut world, mut output) = scroll_world(
        vec![scroll_map(MAP_BIRTH, 100.0), scroll_map(TOWN_VICTORIA, 260.0)],
        &[],
    );
    scroll_stock(&mut world, SCROLL_VICTORIA, 1);

    scroll_use(&mut world, SCROLL_VICTORIA, "victoria-1");

    assert_eq!(scroll_map_of(&world), TOWN_VICTORIA);
    assert_eq!(scroll_quantity(&world, SCROLL_VICTORIA), 0);
    assert!(scroll_last_reject(&mut output).is_none());
}

#[test]
fn a_scroll_with_no_return_town_is_refused_without_spending_it() {
    // A map the archive authors no return for has nowhere to send the body.
    // The contract is that the player learns this *and keeps the scroll*.
    let (mut world, mut output) = scroll_world(vec![scroll_map(MAP_BIRTH, 100.0)], &[]);
    scroll_stock(&mut world, SCROLL_HOME, 1);

    scroll_use(&mut world, SCROLL_HOME, "no-target-1");

    let reject = scroll_last_reject(&mut output).expect("a targetless scroll must be rejected");
    assert_eq!(reject["code"], "scroll_no_target");
    assert_eq!(
        scroll_quantity(&world, SCROLL_HOME),
        1,
        "an unusable scroll is not spent"
    );
    assert_eq!(scroll_map_of(&world), MAP_BIRTH, "the body must not move");
}

#[test]
fn a_scroll_to_an_unassembled_town_is_refused_without_spending_it() {
    // The archive authors return towns for maps this build does not ship
    // (310040200/310050000 both point at 310000000).  That is legal source
    // data, and the refusal has to happen at use time — not by inventing the
    // missing town during export.
    let (mut world, mut output) = scroll_world(
        vec![scroll_map(MAP_BIRTH, 100.0), scroll_map(MAP_HEARTH, 220.0)],
        &[(MAP_BIRTH, "310000000"), (MAP_HEARTH, MAP_HEARTH)],
    );
    scroll_stock(&mut world, SCROLL_HOME, 3);

    scroll_use(&mut world, SCROLL_HOME, "unassembled-1");

    let reject = scroll_last_reject(&mut output).expect("an unloaded town must be rejected");
    assert_eq!(reject["code"], "scroll_unavailable");
    assert_eq!(scroll_quantity(&world, SCROLL_HOME), 3, "nothing may be spent");
    assert_eq!(scroll_map_of(&world), MAP_BIRTH);

    // A town that *is* assembled still resolves, so the refusal is about
    // catalog membership and not about the item.
    scroll_drain(&mut output);
    scroll_stand(&mut world, MAP_HEARTH);
    scroll_use(&mut world, SCROLL_HOME, "unassembled-2");
    assert!(
        scroll_last_reject(&mut output).is_none(),
        "an assembled town must still resolve"
    );
    assert_eq!(scroll_map_of(&world), MAP_HEARTH);
    assert_eq!(scroll_quantity(&world, SCROLL_HOME), 2);
}

#[test]
fn a_scroll_is_refused_on_a_practice_instance() {
    // Leaving a practice encounter is the practice window's decision.  The
    // practice map id is not in the catalog, so resolving `returnMap` there
    // would silently answer with the *source* map's town.
    let (mut world, mut output) = scroll_chain();
    scroll_stock(&mut world, SCROLL_HOME, 1);
    {
        let player = world.players.get_mut("traveler").expect("fixture player");
        player.map_id = "practice:000010000:boss".to_owned();
    }

    scroll_use(&mut world, SCROLL_HOME, "practice-1");

    let reject = scroll_last_reject(&mut output).expect("a practice instance must be refused");
    assert_eq!(reject["code"], "scroll_blocked");
    assert_eq!(scroll_quantity(&world, SCROLL_HOME), 1, "nothing may be spent");
}

#[test]
fn a_dead_character_cannot_use_a_scroll() {
    let (mut world, mut output) = scroll_chain();
    scroll_stock(&mut world, SCROLL_HOME, 1);
    {
        let player = world.players.get_mut("traveler").expect("fixture player");
        player.state.hp = 0;
        player.state.action = "dead";
    }

    scroll_use(&mut world, SCROLL_HOME, "dead-1");

    let reject = scroll_last_reject(&mut output).expect("a corpse must be refused");
    assert_eq!(reject["code"], "dead");
    assert_eq!(scroll_quantity(&world, SCROLL_HOME), 1, "nothing may be spent");
    assert_eq!(scroll_map_of(&world), MAP_BIRTH);
}

#[test]
fn a_replayed_scroll_request_never_travels_twice() {
    // Idempotency is not just "the item is spent once": a replayed command
    // must not send the body anywhere a second time either.
    let (mut world, _output) = scroll_chain();
    scroll_stock(&mut world, SCROLL_HOME, 1);

    scroll_use(&mut world, SCROLL_HOME, "replay-1");
    assert_eq!(scroll_map_of(&world), MAP_HEARTH);
    assert_eq!(scroll_quantity(&world, SCROLL_HOME), 0);

    // Put the body back on the birth map without a scroll, then replay the
    // exact same request.  The cached outcome must answer it, not the world.
    scroll_stand(&mut world, MAP_BIRTH);
    scroll_use(&mut world, SCROLL_HOME, "replay-1");

    assert_eq!(
        scroll_map_of(&world),
        MAP_BIRTH,
        "a replay must not move the body"
    );
    assert_eq!(
        scroll_quantity(&world, SCROLL_HOME),
        0,
        "a replay must not spend again"
    );
}

#[test]
fn a_forged_target_field_cannot_steer_the_destination() {
    // The client has no way to name a map.  The upgrade-scroll target fields
    // are the only slots it can fill in, so filling them with nonsense must
    // still land the body on the map's authored town.
    let (mut world, mut output) = scroll_chain();
    scroll_stock(&mut world, SCROLL_HOME, 1);

    world.command(Command::Input {
        id: "traveler".into(),
        message: ClientMessage::UseItem {
            request_id: "forged-1".to_owned(),
            inventory_type: 2,
            source_slot: 1,
            item_id: SCROLL_HOME.to_owned(),
            target_slot: Some(9),
            target_item_id: Some(TOWN_VICTORIA.to_owned()),
        },
        connection: "traveler-connection".into(),
    });

    assert_eq!(
        scroll_map_of(&world),
        MAP_HEARTH,
        "a client-named town must be ignored"
    );
    assert!(scroll_last_reject(&mut output).is_none());
}

#[test]
fn a_plain_potion_is_not_caught_by_the_map_move_gate() {
    // `plan_map_move` runs on every `useItem`, so it must answer "not my
    // family" for a potion — especially on a map with no return town, where a
    // sloppy gate would start refusing ordinary drinks.
    let (mut world, mut output) = scroll_world(vec![scroll_map(MAP_BIRTH, 100.0)], &[]);
    scroll_stock(&mut world, "2009001", 2);
    let max_hp = {
        let player = world.players.get_mut("traveler").expect("fixture player");
        player.state.hp = 1;
        player.state.max_hp
    };
    let before = scroll_map_of(&world);

    scroll_use(&mut world, "2009001", "potion-1");

    assert!(
        scroll_last_reject(&mut output).is_none(),
        "a potion must never be refused by the map-move gate"
    );
    let player = world.players.get("traveler").expect("fixture player");
    assert_eq!(
        player.state.hp,
        (1 + 50).min(max_hp),
        "the potion must still heal"
    );
    assert_eq!(
        scroll_quantity(&world, "2009001"),
        1,
        "the potion must still be spent"
    );
    assert_eq!(scroll_map_of(&world), before, "a potion must not move the body");
}

#[test]
fn landing_clears_the_scene_state_the_gate_path_clears() {
    // A scroll is an escape, so it has to scrub the same scene-scoped state a
    // gate does — otherwise a summon or an ice field is left running on a map
    // the caster has already left.
    let (mut world, _output) = scroll_chain();
    scroll_stock(&mut world, SCROLL_HOME, 1);
    {
        let player = world.players.get_mut("traveler").expect("fixture player");
        player.ice_teleport_enabled = true;
        player.teleport_mastery_enabled = true;
        player.teleport_boost_enabled = true;
        player.adaptation_active = true;
        player.adaptation_charges = 3;
        player.ice_fields.push(IceField {
            field_id: "ice-1".to_owned(),
            map_id: MAP_BIRTH.to_owned(),
            start_x: 0.0,
            start_y: 0.0,
            end_x: 100.0,
            end_y: 0.0,
            lt: (0.0, 0.0),
            rb: (100.0, 0.0),
            damage_percent: 10,
            expires_at: u64::MAX,
            next_hit_at: 0,
            sub_time_ms: 0,
        });
    }

    scroll_use(&mut world, SCROLL_HOME, "scene-1");

    let player = world.players.get("traveler").expect("fixture player");
    assert_eq!(player.map_id, MAP_HEARTH);
    assert!(!player.ice_teleport_enabled, "ice teleport is map-scoped");
    assert!(!player.teleport_mastery_enabled, "teleport mastery is map-scoped");
    assert!(!player.teleport_boost_enabled, "teleport boost is map-scoped");
    assert!(!player.adaptation_active, "adaptation is encounter-scoped");
    assert_eq!(player.adaptation_charges, 0);
    assert!(
        player.ice_fields.is_empty(),
        "an ice field must not follow the caster"
    );
    assert!(player.summon.is_none());
}

#[test]
fn every_map_move_rejection_has_text_in_both_languages() {
    // The refusal codes are the player-visible half of the contract, and the
    // fallback arm would happily ship an empty string if a new code were added
    // without text.  Pin both languages for every code the module can produce,
    // plus the unknown-code fallback.
    for code in [
        "dead",
        "scroll_blocked",
        "scroll_no_target",
        "scroll_unavailable",
        "item_unavailable",
        "a-code-that-does-not-exist-yet",
    ] {
        let zh = map_move_reject_message(code, crate::quest_text::LANG_ZH);
        let en = map_move_reject_message(code, crate::quest_text::LANG_EN);
        assert!(!zh.is_empty(), "{code} must have a Chinese message");
        assert!(!en.is_empty(), "{code} must have an English message");
        assert_ne!(zh, en, "{code} must actually be translated");
    }
}

#[test]
fn attach_catalog_rejects_a_return_table_that_contradicts_the_catalog() {
    // A return table is only usable if its keys are maps this world loaded and
    // its targets are at least shaped like map ids.  Both mistakes are export
    // bugs, so they must fail at startup rather than at scroll time.
    let mut unloaded = World::new(scroll_map(MAP_BIRTH, 100.0), 600);
    let error = unloaded
        .attach_catalog(MapCatalog {
            birth_map_id: MAP_BIRTH.to_owned(),
            return_maps: BTreeMap::from([("000020000".to_owned(), MAP_HEARTH.to_owned())]),
            maps: vec![scroll_map(MAP_BIRTH, 100.0)],
        })
        .expect_err("a return key outside the catalog must be refused");
    assert!(error.contains("unloaded map"), "unexpected error: {error}");

    let mut malformed = World::new(scroll_map(MAP_BIRTH, 100.0), 600);
    let error = malformed
        .attach_catalog(MapCatalog {
            birth_map_id: MAP_BIRTH.to_owned(),
            return_maps: BTreeMap::from([(MAP_BIRTH.to_owned(), "1000000".to_owned())]),
            maps: vec![scroll_map(MAP_BIRTH, 100.0)],
        })
        .expect_err("a 7-digit return target must be refused");
    assert!(error.contains("9-digit"), "unexpected error: {error}");

    // A *target* outside the catalog is legal data — the archive ships maps
    // this build does not — so it must load, and be refused only at use time.
    let mut legal = World::new(scroll_map(MAP_BIRTH, 100.0), 600);
    legal
        .attach_catalog(MapCatalog {
            birth_map_id: MAP_BIRTH.to_owned(),
            return_maps: BTreeMap::from([(MAP_BIRTH.to_owned(), "310000000".to_owned())]),
            maps: vec![scroll_map(MAP_BIRTH, 100.0)],
        })
        .expect("an unassembled town is legal source data");
    assert_eq!(
        legal.return_maps.get(MAP_BIRTH).map(String::as_str),
        Some("310000000")
    );
}

#[test]
fn the_generated_catalog_carries_a_return_town_for_every_loaded_map() {
    // The authored table is the whole destination space for 回家卷軸, so a
    // single missing row is a silently dead scroll on a live map.
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/maps.json");
    let catalog = MapCatalog::load(&path).expect("generated TMS273 map catalog");
    assert_eq!(
        catalog.return_maps.len(),
        catalog.maps.len(),
        "every assembled map must author a return town"
    );
    let loaded: BTreeSet<&str> = catalog.maps.iter().map(|map| map.id.as_str()).collect();
    for (map_id, town_id) in &catalog.return_maps {
        assert!(loaded.contains(map_id.as_str()), "{map_id} is not assembled");
        assert_eq!(town_id.len(), 9, "{map_id} -> {town_id} is not a map id");
    }
    let town = |id: &str| catalog.return_maps.get(id).map(String::as_str);
    assert_eq!(town(MAP_BIRTH), Some(MAP_HEARTH));
    assert_eq!(
        town(TOWN_VICTORIA),
        Some(TOWN_VICTORIA),
        "the harbour returns to itself"
    );
    // 埃德爾斯坦城 310000000 arrived with the 2026-09-14 phase-2 flight line,
    // so the former 310040200/310050000 orphans now have their town loaded.
    assert!(loaded.contains("310000000"), "埃德爾斯坦城 must be assembled with the phase-2 line");
    assert_eq!(town("310040200"), Some("310000000"));
    assert_eq!(town("310050000"), Some("310000000"));
    // 天空之城城内 200000000 arrived with the 2026-09-15 玩具城⇄天空之城
    // flight line, so the two Orbis-side maps that used to be orphans now name a
    // loaded town and their 回家卷軸 is no longer refused at use time.
    for map in ["200000100", "200000170"] {
        assert_eq!(town(map), Some("200000000"));
        assert!(
            loaded.contains("200000000"),
            "天空之城城内 must be assembled with the phase-3 flight line"
        );
    }
    // 維多利亞港卷軸 names 104000000 outright, so that town has to exist or the
    // fixed-destination scroll is dead on arrival.
    assert!(
        loaded.contains(TOWN_VICTORIA),
        "the fixed scroll's town must be assembled"
    );
}

// ---- Persistence path ----------------------------------------------------
//
// The store branch has its own control flow (idempotency peek, transaction,
// then landing).  These two checks hold it to the same contract as the
// in-memory branch: a refused scroll is never written away, and a spent one
// really does move the body.
//
// Inventory is a table of its own, and `Store::save_profile` only updates
// `player_stats` — so the fixture stock is inserted directly, the same way the
// other store-backed acceptance files seed it.  That also makes the read-back
// assertion meaningful: it observes the row the transaction actually wrote.

/// The account row the store-backed checks start from.
fn scroll_store_profile(map_id: &str) -> Profile {
    Profile {
        hp: 50,
        max_hp: 50,
        mp: 5,
        max_mp: 5,
        level: 1,
        job: 0,
        exp: 0,
        exp_to_next: 15,
        mesos: 0,
        cash: 0,
        death_id: String::new(),
        map_id: map_id.to_owned(),
        x: 0.0,
        y: 0.0,
        inventory: Vec::new(),
        skills: BTreeMap::new(),
        skill_points: BTreeMap::new(),
        ability_stats: AbilityStats::default(),
    }
}

/// Put a Use-tab stack straight into the table the server reads.
fn scroll_grant(path: &Path, item_id: &str, quantity: u32) {
    let db = rusqlite::Connection::open(path).expect("fixture database");
    db.execute(
        "INSERT INTO inventory(account_id,inventory_type,slot,item_id,quantity) VALUES ('traveler',2,1,?1,?2)",
        rusqlite::params![item_id, quantity],
    )
    .expect("seed inventory");
}

fn scroll_stored_quantity(store: &Store, defaults: &Profile, item_id: &str) -> u32 {
    store
        .load_profile("traveler", defaults)
        .expect("seeded profile")
        .inventory
        .iter()
        .find(|item| item.item_id == item_id)
        .map(|item| item.quantity)
        .unwrap_or(0)
}

fn scroll_store_world(
    store: &Store,
    maps: Vec<Map>,
    returns: &[(&str, &str)],
) -> (World, mpsc::Receiver<String>) {
    let mut world = World::new_with_store(
        scroll_map(MAP_BIRTH, 100.0),
        600,
        Gameplay::default(),
        store.clone(),
    )
    .expect("store world");
    world
        .attach_catalog(MapCatalog {
            birth_map_id: MAP_BIRTH.to_owned(),
            return_maps: returns
                .iter()
                .map(|(from, to)| ((*from).to_owned(), (*to).to_owned()))
                .collect(),
            maps,
        })
        .expect("fixture catalog");
    let output = join_test_player(&mut world, "traveler");
    (world, output)
}

/// Open a throwaway store whose account already holds `quantity` of `item_id`.
fn scroll_store_fixture(label: &str, item_id: &str, quantity: u32) -> (Store, Profile) {
    let path = std::env::temp_dir().join(format!(
        "maple-scroll-{label}-{}.sqlite3",
        auth::random_id()
    ));
    let service = auth::start(&path).expect("fixture store");
    let defaults = scroll_store_profile(MAP_BIRTH);
    service
        .store
        .load_profile("traveler", &defaults)
        .expect("seed account");
    scroll_grant(&path, item_id, quantity);
    (service.store, defaults)
}

#[test]
fn the_store_path_spends_the_scroll_and_lands_the_body() {
    let (store, defaults) = scroll_store_fixture("store", SCROLL_HOME, 2);
    let (mut world, mut output) = scroll_store_world(
        &store,
        vec![scroll_map(MAP_BIRTH, 100.0), scroll_map(MAP_HEARTH, 220.0)],
        &[(MAP_BIRTH, MAP_HEARTH)],
    );

    scroll_use(&mut world, SCROLL_HOME, "store-1");

    assert_eq!(
        scroll_map_of(&world),
        MAP_HEARTH,
        "a persisted scroll must still move the body"
    );
    assert!(
        scroll_last_reject(&mut output).is_none(),
        "a resolved scroll must not be rejected"
    );
    assert_eq!(
        scroll_stored_quantity(&store, &defaults, SCROLL_HOME),
        1,
        "the transaction must have removed exactly one unit"
    );
}

#[test]
fn the_store_path_refuses_an_unusable_scroll_without_spending_it() {
    let (store, defaults) = scroll_store_fixture("store-refuse", SCROLL_HOME, 2);
    let (mut world, mut output) =
        scroll_store_world(&store, vec![scroll_map(MAP_BIRTH, 100.0)], &[]);

    scroll_use(&mut world, SCROLL_HOME, "store-refuse-1");

    let reject = scroll_last_reject(&mut output).expect("a targetless scroll must be rejected");
    assert_eq!(reject["code"], "scroll_no_target");
    assert_eq!(scroll_map_of(&world), MAP_BIRTH, "the body must not move");
    assert_eq!(
        scroll_stored_quantity(&store, &defaults, SCROLL_HOME),
        2,
        "a refused scroll must never reach the transaction"
    );

    // The refusal must not have been cached as an inventory outcome either:
    // replaying the request has to resolve afresh and fail the same way.
    scroll_drain(&mut output);
    scroll_use(&mut world, SCROLL_HOME, "store-refuse-1");
    assert!(
        scroll_last_reject(&mut output).is_some(),
        "a refused request must not be cached as a success"
    );
    assert_eq!(scroll_stored_quantity(&store, &defaults, SCROLL_HOME), 2);
}
