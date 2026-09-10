// Directional acceptance for the NPC shop sell-back (`ShopSell`).
//
// The shop loop was only half built: buying worked, selling did not exist.
// Everything here is about the boundaries that make selling safe — the client
// names a shop, a tab and a slot, so the server must re-derive which item is
// there, whether the source lets it be sold, and what it is worth.  A forged
// request must never be able to rename the item, claim a price, or sell from
// a merchant the player never walked to.

use super::*;
use crate::protocol::InventoryItem;

const SELL_SHOP_ID: &str = "shop-test";
const SELL_NPC_ID: &str = "shop-npc";
/// A plain consumable with a TMS273-authored catalog price (紅色藥水, 3 mesos).
const SELLABLE_ITEM: &str = "2000000";
/// An Etc monster drop priced by the original `ItemSellPriceStandard` (嫩寶殼).
const AUTO_PRICED_ITEM: &str = "4000019";

fn shop_map() -> Map {
    Map {
        id: "shop-sell-test".into(),
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

fn shop_gameplay() -> Gameplay {
    Gameplay {
        npcs: vec![NpcTemplate {
            template_id: "9000000".into(),
            name: "Merchant".into(),
            func: "shop".into(),
            shop_id: Some(SELL_SHOP_ID.into()),
            script: None,
            stand: Vec::new(),
        }],
        npc_spawns: vec![NpcSpawn {
            id: SELL_NPC_ID.into(),
            template_id: "9000000".into(),
            x: 120.0,
            y: 200.0,
            foothold_id: Some(1),
            map_id: "shop-sell-test".into(),
            facing: -1,
        }],
        shops: vec![npc::Shop {
            shop_id: SELL_SHOP_ID.into(),
            npc_id: "9000000".into(),
            items: vec![npc::ShopEntry { item_id: SELLABLE_ITEM.into(), price: 5, position: 0 }],
        }],
        ..Gameplay::default()
    }
}

fn shop_world() -> (World, mpsc::Receiver<String>) {
    // Configured NPC spawns are only placed by the store-backed constructor,
    // and the merchant has to exist on the map for the range check to pass.
    let path =
        std::env::temp_dir().join(format!("maple-shop-sell-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).expect("temp store");
    service
        .store
        .load_profile("seller", &quest_profile())
        .expect("seed profile");
    let mut world = World::new_with_store(shop_map(), 600, shop_gameplay(), service.store.clone())
        .expect("world with store");
    let mut output = join_test_player(&mut world, "seller");
    while output.try_recv().is_ok() {}
    for _ in 0..4 {
        world.step();
        while output.try_recv().is_ok() {}
    }
    (world, output)
}

/// Put `quantity` of `item_id` into slot 1 of the player's inventory.
fn give(world: &mut World, item_id: &str, quantity: u32) {
    let player = world.players.get_mut("seller").expect("seller joined");
    player.state.inventory.push(InventoryItem {
        slot: 1,
        item_id: item_id.to_owned(),
        quantity,
        ..InventoryItem::default()
    });
}

fn sell(world: &mut World, slot: i16, quantity: u32, request: &str) {
    world.command(Command::Input {
        id: "seller".into(),
        connection: "seller-connection".into(),
        message: ClientMessage::ShopSell {
            request_id: request.into(),
            shop_id: SELL_SHOP_ID.into(),
            // 2 is the Consume tab, matching the 1-based protocol category.
            inventory_type: 2,
            source_slot: slot,
            quantity,
        },
    });
}

/// The last `shopSold` message sent to the player.
fn last_sale(output: &mut mpsc::Receiver<String>) -> Option<serde_json::Value> {
    let mut last = None;
    while let Ok(message) = output.try_recv() {
        if message.contains("\"shopSold\"") {
            last = Some(serde_json::from_str::<serde_json::Value>(&message).ok()?);
        }
    }
    last
}

fn inventory_quantity(world: &World, item_id: &str) -> u32 {
    world
        .players
        .get("seller")
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
fn shop_sell_pays_mesos_and_takes_the_whole_stack() {
    let (mut world, mut output) = shop_world();
    give(&mut world, SELLABLE_ITEM, 10);
    let before = world.players.get("seller").unwrap().state.mesos;

    sell(&mut world, 1, 10, "sell-1");

    let sale = last_sale(&mut output).expect("shopSold result");
    assert_eq!(
        sale.get("success").and_then(|v| v.as_bool()),
        Some(true),
        "sale was refused with code {:?}",
        sale.get("code").and_then(|v| v.as_str())
    );
    // 紅色藥水 is worth 3 in the TMS273 catalog; the shop pays half of that.
    assert_eq!(sale.get("itemId").and_then(|v| v.as_str()), Some(SELLABLE_ITEM));
    let gained = sale.get("mesosGained").and_then(|v| v.as_u64()).expect("payout");
    assert_eq!(gained, 3 * SHOP_SELL_PRICE_PERCENT / SHOP_SELL_PRICE_DIVISOR * 10);
    // The result carries the fresh authoritative balance, not a client guess.
    assert_eq!(sale.get("mesos").and_then(|v| v.as_u64()), Some(before + gained));
    // The stack is gone and the mesos actually moved.
    assert_eq!(inventory_quantity(&world, SELLABLE_ITEM), 0);
    assert_eq!(world.players.get("seller").unwrap().state.mesos, before + gained);
}

#[test]
fn shop_sell_uses_the_source_auto_price_for_etc_drops() {
    let (mut world, mut output) = shop_world();
    // 嫩寶殼 has no authored `price`; the original prices it off
    // ItemSellPriceStandard by its `lv`, so it is still sellable.
    assert!(inventory::item_price(AUTO_PRICED_ITEM).is_some());
    give(&mut world, AUTO_PRICED_ITEM, 5);
    let before = world.players.get("seller").unwrap().state.mesos;

    world.players.get_mut("seller").unwrap().state.inventory.iter_mut()
        .find(|item| item.item_id == AUTO_PRICED_ITEM)
        .expect("seeded stack");
    world.command(Command::Input {
        id: "seller".into(),
        connection: "seller-connection".into(),
        // 4 is the Etc tab.
        message: ClientMessage::ShopSell {
            request_id: "sell-etc".into(),
            shop_id: SELL_SHOP_ID.into(),
            inventory_type: 4,
            source_slot: 1,
            quantity: 5,
        },
    });

    let sale = last_sale(&mut output).expect("shopSold result");
    assert_eq!(sale.get("success").and_then(|v| v.as_bool()), Some(true));
    let gained = sale.get("mesosGained").and_then(|v| v.as_u64()).expect("payout");
    assert!(gained > 0, "an auto-priced Etc drop must still be worth mesos");
    assert_eq!(inventory_quantity(&world, AUTO_PRICED_ITEM), 0);
    assert_eq!(world.players.get("seller").unwrap().state.mesos, before + gained);
}

#[test]
fn shop_sell_refuses_more_than_the_slot_holds() {
    let (mut world, mut output) = shop_world();
    give(&mut world, SELLABLE_ITEM, 2);
    let before = world.players.get("seller").unwrap().state.mesos;

    sell(&mut world, 1, 5, "sell-over");

    let sale = last_sale(&mut output).expect("shopSold result");
    assert_eq!(sale.get("success").and_then(|v| v.as_bool()), Some(false));
    assert_eq!(sale.get("code").and_then(|v| v.as_str()), Some("shop_quantity_invalid"));
    // Nothing moved: no mesos, no item.
    assert_eq!(sale.get("mesosGained").and_then(|v| v.as_u64()), Some(0));
    assert_eq!(inventory_quantity(&world, SELLABLE_ITEM), 2);
    assert_eq!(world.players.get("seller").unwrap().state.mesos, before);
}

#[test]
fn shop_sell_refuses_an_empty_or_wrong_tab_slot() {
    let (mut world, mut output) = shop_world();
    give(&mut world, SELLABLE_ITEM, 4);

    // Empty slot.
    sell(&mut world, 2, 1, "sell-empty");
    let sale = last_sale(&mut output).expect("shopSold result");
    assert_eq!(sale.get("success").and_then(|v| v.as_bool()), Some(false));
    assert_eq!(sale.get("code").and_then(|v| v.as_str()), Some("shop_slot_empty"));

    // Right slot, wrong tab: the item lives in Consume, not Equip.
    world.command(Command::Input {
        id: "seller".into(),
        connection: "seller-connection".into(),
        message: ClientMessage::ShopSell {
            request_id: "sell-wrongtab".into(),
            shop_id: SELL_SHOP_ID.into(),
            inventory_type: 1,
            source_slot: 1,
            quantity: 1,
        },
    });
    let sale = last_sale(&mut output).expect("shopSold result");
    assert_eq!(sale.get("success").and_then(|v| v.as_bool()), Some(false));
    assert_eq!(sale.get("code").and_then(|v| v.as_str()), Some("shop_slot_empty"));
    // A failed attempt must never consume the stack.
    assert_eq!(inventory_quantity(&world, SELLABLE_ITEM), 4);
}

#[test]
fn shop_sell_rejects_an_unknown_shop_and_a_distant_merchant() {
    let (mut world, mut output) = shop_world();
    give(&mut world, SELLABLE_ITEM, 3);

    // Unknown shop id: nothing is looked up, nothing is paid.
    world.command(Command::Input {
        id: "seller".into(),
        connection: "seller-connection".into(),
        message: ClientMessage::ShopSell {
            request_id: "sell-forged".into(),
            shop_id: "shop-does-not-exist".into(),
            inventory_type: 2,
            source_slot: 1,
            quantity: 1,
        },
    });
    let sale = last_sale(&mut output).expect("shopSold result");
    assert_eq!(sale.get("code").and_then(|v| v.as_str()), Some("shop_unknown"));
    assert_eq!(inventory_quantity(&world, SELLABLE_ITEM), 3);

    // Same shop, but the player has been moved out of talking range: the
    // merchant is at x=120 and TALK_RANGE_X is 800, so park them far away.
    world.players.get_mut("seller").unwrap().state.x = 100_000.0;
    sell(&mut world, 1, 1, "sell-far");
    let sale = last_sale(&mut output).expect("shopSold result");
    assert_eq!(sale.get("code").and_then(|v| v.as_str()), Some("shop_too_far"));
    assert_eq!(inventory_quantity(&world, SELLABLE_ITEM), 3);
}

#[test]
fn shop_sell_refuses_an_item_with_no_shop_value() {
    let (mut world, mut output) = shop_world();
    // A quest item the source marks tradeBlock: the original never lets it
    // leave the inventory, so no shop may pay mesos for it.
    let restricted = shared_restricted_item();
    give(&mut world, &restricted, 1);
    let before = world.players.get("seller").unwrap().state.mesos;

    world.command(Command::Input {
        id: "seller".into(),
        connection: "seller-connection".into(),
        // 4 is the Etc tab, which is where these quest items live.
        message: ClientMessage::ShopSell {
            request_id: "sell-restricted".into(),
            shop_id: SELL_SHOP_ID.into(),
            inventory_type: 4,
            source_slot: 1,
            quantity: 1,
        },
    });

    let sale = last_sale(&mut output).expect("shopSold result");
    assert_eq!(sale.get("success").and_then(|v| v.as_bool()), Some(false));
    assert_eq!(sale.get("code").and_then(|v| v.as_str()), Some("shop_item_unsellable"));
    assert_eq!(sale.get("mesosGained").and_then(|v| v.as_u64()), Some(0));
    assert_eq!(inventory_quantity(&world, &restricted), 1);
    assert_eq!(world.players.get("seller").unwrap().state.mesos, before);
}

/// Pick an item the catalog marks as unsellable, so the test does not depend
/// on one hard-coded id surviving a catalog refresh.
fn shared_restricted_item() -> String {
    // 403xxxx quest items have no catalog price at all, so no shop may pay
    // for them.  Pick whichever survives a catalog refresh.
    for candidate in ["4030000", "4030001", "4030009"] {
        if inventory::item_price(candidate).is_none() {
            return candidate.to_owned();
        }
    }
    panic!("the test catalog must contain at least one unpriced quest item");
}

#[test]
fn shop_sell_ignores_a_replayed_request_id() {
    let (mut world, mut output) = shop_world();
    give(&mut world, SELLABLE_ITEM, 6);
    let before = world.players.get("seller").unwrap().state.mesos;

    sell(&mut world, 1, 2, "sell-once");
    let first = last_sale(&mut output).expect("shopSold result");
    assert_eq!(first.get("success").and_then(|v| v.as_bool()), Some(true));
    let gained = first.get("mesosGained").and_then(|v| v.as_u64()).expect("payout");

    // Replaying the same request id must not pay out a second time: the
    // remembered outcome is re-sent and no mesos move.
    sell(&mut world, 1, 2, "sell-once");
    let replay = last_sale(&mut output).expect("replayed result is re-sent");
    assert_eq!(replay.get("mesosGained").and_then(|v| v.as_u64()), Some(gained));
    assert_eq!(
        world.players.get("seller").unwrap().state.mesos,
        before + gained,
        "a replayed shopSell must not credit mesos twice"
    );
    // The stack was only charged once.
    assert_eq!(inventory_quantity(&world, SELLABLE_ITEM), 4);
}
