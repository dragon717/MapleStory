// Directional acceptance for the TMS273 slot-expansion coupon module.
//
// The source (Item/Consume/0243 info.slotExpand) authors four coupons that
// each grow one ordinary tab by 8 slots up to 128.  The runtime models the
// direct double-click form: the coupon is consumed and the tab capacity grows
// by one step.  These checks pin the boundaries that decide correctness — the
// capacity is a per-tab durable value, the coupon is spent atomically with the
// growth, and a use at the source ceiling refuses without spending anything.

use super::*;

/// A flat map so the fixture player can stand still while using a coupon.
fn expand_map() -> Map {
    Map {
        id: "expand-test".into(),
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

fn expand_world() -> (World, mpsc::Receiver<String>) {
    let mut world = World::new_with_gameplay(expand_map(), 600, Gameplay::default());
    let output = join_test_player(&mut world, "expander");
    (world, output)
}

/// Place `quantity` of a coupon in slot 1 of the Use tab (type 2).
fn stock_coupon(world: &mut World, item_id: &str, quantity: u32) {
    let player = world.players.get_mut("expander").expect("fixture player");
    player.state.inventory.push(InventoryItem {
        slot: 1,
        item_id: item_id.to_owned(),
        quantity,
        stats: None,
        remaining_slots: None,
        upgrade_count: None,
    });
}

fn use_coupon(world: &mut World, item_id: &str, request: &str) {
    world.command(Command::Input {
        id: "expander".into(),
        message: ClientMessage::UseItem {
            request_id: request.to_owned(),
            inventory_type: 2,
            source_slot: 1,
            item_id: item_id.to_owned(),
            target_slot: None,
            target_item_id: None,
        },
        connection: "expander-connection".into(),
    });
}

fn tab_capacity(world: &World, tab: u8) -> u16 {
    world
        .players
        .get("expander")
        .and_then(|player| player.inventory_slots.get(&tab).copied())
        .unwrap_or(inventory::SLOT_LIMIT)
}

fn coupon_quantity(world: &World, item_id: &str) -> u32 {
    world
        .players
        .get("expander")
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

#[test]
fn equip_coupon_grows_the_equip_tab_by_one_step_and_is_consumed() {
    let (mut world, _output) = expand_world();
    stock_coupon(&mut world, "2430768", 2);
    assert_eq!(tab_capacity(&world, 1), 24, "fresh equip tab starts at 24");

    use_coupon(&mut world, "2430768", "expand-1");
    assert_eq!(tab_capacity(&world, 1), 32, "one coupon grows the equip tab by 8");
    assert_eq!(coupon_quantity(&world, "2430768"), 1, "the coupon is consumed");

    // A second coupon stacks the growth.
    use_coupon(&mut world, "2430768", "expand-2");
    assert_eq!(tab_capacity(&world, 1), 40);
    assert_eq!(coupon_quantity(&world, "2430768"), 0);
}

#[test]
fn each_coupon_targets_only_its_own_tab() {
    let (mut world, _output) = expand_world();
    stock_coupon(&mut world, "2430769", 1); // use tab

    use_coupon(&mut world, "2430769", "expand-use");
    assert_eq!(tab_capacity(&world, 2), 32, "use coupon grows the use tab");
    assert_eq!(tab_capacity(&world, 1), 24, "equip tab is untouched");
    assert_eq!(tab_capacity(&world, 3), 24, "setup tab is untouched");
    assert_eq!(tab_capacity(&world, 4), 24, "etc tab is untouched");
}

#[test]
fn coupon_use_refuses_at_the_source_ceiling_without_spending() {
    let (mut world, _output) = expand_world();
    stock_coupon(&mut world, "2430768", 1);

    // Force the equip tab to the ceiling minus one step, so one more step
    // would exceed 128.
    world
        .players
        .get_mut("expander")
        .unwrap()
        .inventory_slots
        .insert(1, inventory::MAX_SLOT_LIMIT - inventory::SLOT_EXPAND_STEP + 1);

    use_coupon(&mut world, "2430768", "expand-over");
    assert_eq!(
        tab_capacity(&world, 1),
        inventory::MAX_SLOT_LIMIT - inventory::SLOT_EXPAND_STEP + 1,
        "a refused use must not change the capacity",
    );
    assert_eq!(coupon_quantity(&world, "2430768"), 1, "a refused use must not spend the coupon");
}
