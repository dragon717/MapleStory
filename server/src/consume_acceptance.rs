// Directional acceptance for the consumable-recovery module.
//
// The original has two recovery forms — a flat amount (`hp`/`mp`) and a
// percentage of the character's own pool (`hpR`/`mpR`) — and an optional
// authored use cooldown (`spec.time`).  These checks pin the boundaries that
// decide correctness: that a percentage heal scales with max HP instead of a
// baked-in number, that a heal never overshoots the cap, that a cooldown
// blocks a second drink without spending the item, and that a cooldown does
// not survive the session events that clear every other temporary state.

use super::*;

/// A flat map so the fixture player can stand still while drinking.
fn consume_map() -> Map {
    Map {
        id: "consume-test".into(),
        bounds: Bounds { x_min: 0.0, x_max: 600.0, y_min: -100.0, y_max: 400.0 },
        spawn: Point { x: 100.0, y: 200.0 },
        footholds: vec![Foothold {
            id: 1, x1: 0.0, y1: 200.0, x2: 600.0, y2: 200.0,
            prev: 0, next: 0, forbid_fall_down: 0,
        }],
        ladders: Vec::new(),
        portals: Vec::new(),
        water: Vec::new(),
        reactors: Vec::new(),
    }
}

fn consume_world() -> (World, mpsc::Receiver<String>) {
    let mut world = World::new_with_gameplay(consume_map(), 600, Gameplay::default());
    let output = join_test_player(&mut world, "drinker");
    (world, output)
}

/// Place `quantity` of a fixture item in slot 1 of the Use tab (type 2).
fn stock(world: &mut World, item_id: &str, quantity: u32) {
    let player = world.players.get_mut("drinker").expect("fixture player");
    player.state.inventory.push(InventoryItem {
        slot: 1,
        item_id: item_id.to_owned(),
        quantity,
        stats: None,
        remaining_slots: None,
        upgrade_count: None,
    });
}

/// Wound the fixture player so a heal has something to restore.
fn wound(world: &mut World, hp: i64, mp: i64) {
    let player = world.players.get_mut("drinker").expect("fixture player");
    player.state.hp = hp;
    player.state.mp = mp;
}

fn drink(world: &mut World, item_id: &str, request: &str) {
    world.command(Command::Input {
        id: "drinker".into(),
        message: ClientMessage::UseItem {
            request_id: request.to_owned(),
            inventory_type: 2,
            source_slot: 1,
            item_id: item_id.to_owned(),
            target_slot: None,
            target_item_id: None,
        },
        connection: "drinker-connection".into(),
    });
}

fn quantity_of(world: &World, item_id: &str) -> u32 {
    world
        .players
        .get("drinker")
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

fn last_reject(output: &mut mpsc::Receiver<String>) -> Option<serde_json::Value> {
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

#[test]
fn flat_potion_restores_hp_and_is_consumed() {
    let (mut world, mut output) = consume_world();
    stock(&mut world, "2009001", 3);
    wound(&mut world, 10, 1);
    let max_hp = world.players.get("drinker").unwrap().state.max_hp;

    drink(&mut world, "2009001", "flat-1");
    let player = world.players.get("drinker").unwrap();
    assert_eq!(player.state.hp, (10 + 50).min(max_hp), "a hp=50 potion must restore 50");
    assert_eq!(quantity_of(&world, "2009001"), 2, "one unit must be consumed");
    assert!(last_reject(&mut output).is_none(), "a valid drink must not be rejected");
}

#[test]
fn percentage_potion_scales_with_the_character_max_pool() {
    let (mut world, _output) = consume_world();
    stock(&mut world, "2009002", 2);
    let (max_hp, max_mp) = {
        let player = world.players.get("drinker").unwrap();
        (player.state.max_hp, player.state.max_mp)
    };
    wound(&mut world, 1, 0);

    drink(&mut world, "2009002", "percent-1");
    let player = world.players.get("drinker").unwrap();
    // hpR=100 / mpR=100 is a full restore of the body's own pool.  The point
    // of the check is that the amount came from `max_hp`, not from a number
    // baked into the catalog.
    assert_eq!(player.state.hp, max_hp, "hpR=100 must restore the full pool");
    assert_eq!(player.state.mp, max_mp, "mpR=100 must restore the full pool");
    assert_eq!(quantity_of(&world, "2009002"), 1);
}

#[test]
fn recovery_never_overshoots_the_maximum_pool() {
    let (mut world, _output) = consume_world();
    stock(&mut world, "2009001", 5);
    let max_hp = world.players.get("drinker").unwrap().state.max_hp;
    // Already nearly full: the heal must clamp, not push past the cap.
    wound(&mut world, max_hp - 5, 0);

    drink(&mut world, "2009001", "clamp-1");
    let player = world.players.get("drinker").unwrap();
    assert_eq!(player.state.hp, max_hp, "a heal must clamp to max_hp");
    assert_eq!(quantity_of(&world, "2009001"), 4, "the item is still spent");
}

#[test]
fn use_effect_rejects_an_item_that_recovers_nothing() {
    // Arrows and other Use-tab items are consumed by the attack system, not by
    // drinking, so they must stay unusable rather than silently doing nothing.
    assert!(
        inventory::use_effect("2060000").is_err(),
        "an item with no recovery spec must not be drinkable"
    );
    assert!(
        inventory::use_effect("1102173").is_err(),
        "equipment must never be drinkable"
    );
}

#[test]
fn authored_cooldown_blocks_a_second_use_without_spending_the_item() {
    let (mut world, mut output) = consume_world();
    stock(&mut world, "2009003", 5);
    let max_hp = world.players.get("drinker").unwrap().state.max_hp;
    wound(&mut world, 1, 0);

    drink(&mut world, "2009003", "cd-1");
    assert_eq!(world.players.get("drinker").unwrap().state.hp, (1 + 50).min(max_hp));
    assert_eq!(quantity_of(&world, "2009003"), 4);

    // 30000ms at a 50ms tick is well inside the cooldown.
    for _ in 0..10 {
        world.step();
    }
    let hp_before = world.players.get("drinker").unwrap().state.hp;
    drink(&mut world, "2009003", "cd-2");

    let reject = last_reject(&mut output).expect("a cooling-down item must be rejected");
    assert_eq!(reject["code"], "potion_cooldown");
    let player = world.players.get("drinker").unwrap();
    assert_eq!(player.state.hp, hp_before, "a rejected use must not heal");
    assert_eq!(
        quantity_of(&world, "2009003"),
        4,
        "a rejected use must not consume the item"
    );
}

#[test]
fn cooldown_expires_and_the_item_becomes_usable_again() {
    let (mut world, mut output) = consume_world();
    stock(&mut world, "2009003", 5);
    let max_hp = world.players.get("drinker").unwrap().state.max_hp;
    wound(&mut world, 1, 0);

    drink(&mut world, "2009003", "cd-a");
    assert_eq!(quantity_of(&world, "2009003"), 4);

    // 30000ms / 50ms = 600 ticks; run past it so the cooldown is over.
    for _ in 0..610 {
        world.step();
    }
    while output.try_recv().is_ok() {}
    wound(&mut world, 1, 0);
    drink(&mut world, "2009003", "cd-b");

    assert!(
        last_reject(&mut output).is_none(),
        "the cooldown must have expired"
    );
    assert_eq!(
        quantity_of(&world, "2009003"),
        3,
        "the second drink must succeed once the cooldown is over"
    );
    assert_eq!(world.players.get("drinker").unwrap().state.hp, (1 + 50).min(max_hp));
}

#[test]
fn an_item_without_an_authored_cooldown_stays_spammable() {
    // The original only locks the items that author a cooldown.  A plain
    // 紅色藥水 must remain chainable, so no cooldown may be invented.
    let (mut world, mut output) = consume_world();
    stock(&mut world, "2009001", 10);
    for attempt in 0..3 {
        wound(&mut world, 1, 0);
        drink(&mut world, "2009001", &format!("spam-{attempt}"));
        world.step();
    }
    assert!(last_reject(&mut output).is_none(), "a plain potion has no cooldown");
    assert_eq!(quantity_of(&world, "2009001"), 7, "all three drinks must land");
}

#[test]
fn a_cooldown_is_cleared_by_death_and_revive() {
    // Temporary player state is session-scoped in this world; a potion lock
    // that survived a revive would leave the player unable to heal with no
    // visible cause.
    let (mut world, mut output) = consume_world();
    stock(&mut world, "2009003", 5);
    wound(&mut world, 1, 0);
    drink(&mut world, "2009003", "cd-clear-1");
    assert_eq!(quantity_of(&world, "2009003"), 4);

    let player = world.players.get_mut("drinker").unwrap();
    player.state.hp = 0;
    player.state.action = "dead";
    clear_beginner_buffs(player);

    assert!(
        world.players.get("drinker").unwrap().potion_cooldowns.is_empty(),
        "death must clear consumable cooldowns"
    );
    while output.try_recv().is_ok() {}
    wound(&mut world, 1, 0);
    drink(&mut world, "2009003", "cd-clear-2");
    assert!(
        last_reject(&mut output).is_none(),
        "the item must be usable again after the reset"
    );
    assert_eq!(quantity_of(&world, "2009003"), 3);
}

#[test]
fn percentage_rounding_always_restores_at_least_one_point() {
    // A low-level character with a small pool must still get something: a
    // percentage that floors to zero would silently waste the item.
    let effect = inventory::UseEffect { hp_percent: 10, ..Default::default() };
    let (hp, mp) = effect.resolve(5, 5);
    assert_eq!(hp, 1, "a positive percentage must floor to at least 1");
    assert_eq!(mp, 0, "mpR absent must contribute nothing");

    let both = inventory::UseEffect { hp: 50, hp_percent: 100, ..Default::default() };
    let (hp, _) = both.resolve(200, 100);
    assert_eq!(hp, 250, "flat and percentage parts must add");
}
