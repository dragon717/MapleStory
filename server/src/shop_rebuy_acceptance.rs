// Directional acceptance for the shop buy-back (`ShopRebuy`).
//
// Selling used to be a one-way door: the mesos were paid and the stack was
// gone.  The buy-back tab closes the loop — anything sold to any merchant can
// be taken back at exactly the price it was sold for — so everything here is
// about the boundaries that make that safe.  The client names an item and a
// price; the row, its quantity and its price have to come out of the
// character's persisted list, and a forged or replayed request must never buy
// an item the shop never bought or charge the character twice.

use super::*;

/// What the shop pays (and therefore charges) for one unit of `item_id`,
/// derived the same way the sale path derives it.
fn unit_payout(item_id: &str) -> u64 {
    inventory::item_price(item_id).expect("catalog price") * SHOP_SELL_PRICE_PERCENT
        / SHOP_SELL_PRICE_DIVISOR
}

/// Ask to buy one row back.
fn rebuy(world: &mut World, item_id: &str, price: u64, request: &str) {
    world.command(Command::Input {
        id: "seller".into(),
        connection: "seller-connection".into(),
        message: ClientMessage::ShopRebuy {
            request_id: request.into(),
            shop_id: SELL_SHOP_ID.into(),
            item_id: item_id.into(),
            unit_price: price,
        },
    });
}

/// Drain everything the player was sent since the last drain.
///
/// One shop action pushes several messages (its own result plus the refreshed
/// buy-back list), so a test reads one buffer instead of draining the channel
/// once per query — the first drain would swallow the rest.
fn drain_pushes(output: &mut mpsc::Receiver<String>) -> Vec<serde_json::Value> {
    let mut messages = Vec::new();
    while let Ok(message) = output.try_recv() {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&message) {
            messages.push(value);
        }
    }
    messages
}

/// The newest message of the given `type` in a drained buffer.
fn pushed<'a>(messages: &'a [serde_json::Value], kind: &str) -> Option<&'a serde_json::Value> {
    messages
        .iter()
        .rev()
        .find(|value| value.get("type").and_then(|v| v.as_str()) == Some(kind))
}

/// The character's persisted buy-back list, as (item, quantity, unit price).
fn rebuy_rows(world: &World) -> Vec<(String, u32, u64)> {
    world
        .store
        .as_ref()
        .expect("world store")
        .load_shop_rebuy("seller")
        .expect("buy-back list")
        .into_iter()
        .map(|row| (row.item_id, row.quantity, row.unit_price))
        .collect()
}

/// The `entries` array of one `shopRebuyState` push.
fn rebuy_entries(state: &serde_json::Value) -> &Vec<serde_json::Value> {
    state
        .get("entries")
        .and_then(|value| value.as_array())
        .expect("buy-back entries")
}

#[test]
fn shop_sell_records_a_buy_back_row_at_the_price_it_paid() {
    let (mut world, mut output) = shop_world();
    give(&mut world, SELLABLE_ITEM, 10);

    sell(&mut world, 1, 10, "sell-record");
    let pushes = drain_pushes(&mut output);

    let sale = pushed(&pushes, "shopSold").expect("shopSold result");
    assert_eq!(sale.get("success").and_then(|v| v.as_bool()), Some(true));
    // The shop remembers the stack and the money it paid, so the row can be
    // bought back for the same amount.
    let price = unit_payout(SELLABLE_ITEM);
    assert_eq!(rebuy_rows(&world), vec![(SELLABLE_ITEM.to_owned(), 10, price)]);
    // The list also travels to the client, which renders it but never owns it.
    let state = pushed(&pushes, "shopRebuyState").expect("the sale pushes a fresh buy-back list");
    let entries = rebuy_entries(state);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].get("itemId").and_then(|v| v.as_str()), Some(SELLABLE_ITEM));
    assert_eq!(entries[0].get("quantity").and_then(|v| v.as_u64()), Some(10));
    assert_eq!(entries[0].get("unitPrice").and_then(|v| v.as_u64()), Some(price));
}

#[test]
fn shop_rebuy_costs_exactly_what_the_sale_paid() {
    let (mut world, mut output) = shop_world();
    give(&mut world, SELLABLE_ITEM, 10);
    let before = world.players.get("seller").unwrap().state.mesos;

    sell(&mut world, 1, 10, "sell-then-rebuy");
    let pushes = drain_pushes(&mut output);
    let gained = pushed(&pushes, "shopSold")
        .and_then(|sale| sale.get("mesosGained"))
        .and_then(|v| v.as_u64())
        .expect("payout");
    assert_eq!(inventory_quantity(&world, SELLABLE_ITEM), 0);

    rebuy(&mut world, SELLABLE_ITEM, unit_payout(SELLABLE_ITEM), "rebuy-1");
    let pushes = drain_pushes(&mut output);

    let result = pushed(&pushes, "shopRebought").expect("shopRebought result");
    assert_eq!(
        result.get("success").and_then(|v| v.as_bool()),
        Some(true),
        "buy-back was refused with code {:?}",
        result.get("code").and_then(|v| v.as_str())
    );
    assert_eq!(result.get("mesosSpent").and_then(|v| v.as_u64()), Some(gained));
    assert_eq!(result.get("quantity").and_then(|v| v.as_u64()), Some(10));
    // The whole stack is back and the purse is where it started: buy-back is
    // the exact inverse of the sale, not a second discount.
    assert_eq!(inventory_quantity(&world, SELLABLE_ITEM), 10);
    assert_eq!(world.players.get("seller").unwrap().state.mesos, before);
    // The row was consumed, so it cannot be bought back again for free.
    assert!(rebuy_rows(&world).is_empty());
    let state = pushed(&pushes, "shopRebuyState").expect("the list is pushed empty again");
    assert!(rebuy_entries(state).is_empty());
}

#[test]
fn shop_rebuy_uses_the_recorded_price_not_the_one_the_client_claims() {
    let (mut world, mut output) = shop_world();
    give(&mut world, SELLABLE_ITEM, 4);
    sell(&mut world, 1, 4, "sell-price");
    let _ = drain_pushes(&mut output);
    let before = world.players.get("seller").unwrap().state.mesos;
    let recorded = unit_payout(SELLABLE_ITEM);

    // A price the shop never paid finds no row, even for an item that *is* on
    // the list: the row, not the request, decides what a buy-back costs.
    rebuy(&mut world, SELLABLE_ITEM, recorded + 1, "rebuy-cheap");
    let pushes = drain_pushes(&mut output);

    let result = pushed(&pushes, "shopRebought").expect("shopRebought result");
    assert_eq!(result.get("success").and_then(|v| v.as_bool()), Some(false));
    assert_eq!(result.get("code").and_then(|v| v.as_str()), Some("shop_rebuy_unknown"));
    assert_eq!(result.get("mesosSpent").and_then(|v| v.as_u64()), Some(0));
    // Nothing moved: same mesos, no item, and the row is still for sale.
    assert_eq!(world.players.get("seller").unwrap().state.mesos, before);
    assert_eq!(inventory_quantity(&world, SELLABLE_ITEM), 0);
    assert_eq!(rebuy_rows(&world), vec![(SELLABLE_ITEM.to_owned(), 4, recorded)]);
}

#[test]
fn shop_rebuy_refuses_an_item_that_was_never_sold_here() {
    let (mut world, mut output) = shop_world();
    give(&mut world, SELLABLE_ITEM, 2);
    // Never sold to this merchant, so there is no row to take back.
    rebuy(&mut world, SELLABLE_ITEM, unit_payout(SELLABLE_ITEM), "rebuy-never-sold");

    let pushes = drain_pushes(&mut output);
    let result = pushed(&pushes, "shopRebought").expect("shopRebought result");
    assert_eq!(result.get("success").and_then(|v| v.as_bool()), Some(false));
    assert_eq!(result.get("code").and_then(|v| v.as_str()), Some("shop_rebuy_unknown"));
    assert_eq!(inventory_quantity(&world, SELLABLE_ITEM), 2);
    assert!(rebuy_rows(&world).is_empty());
}

#[test]
fn shop_rebuy_refuses_without_enough_mesos() {
    let (mut world, mut output) = shop_world();
    give(&mut world, SELLABLE_ITEM, 6);
    sell(&mut world, 1, 6, "sell-poor");
    let _ = drain_pushes(&mut output);

    // Spend the purse on something else, then try to buy the stack back.
    world.players.get_mut("seller").unwrap().state.mesos = 0;
    rebuy(&mut world, SELLABLE_ITEM, unit_payout(SELLABLE_ITEM), "rebuy-poor");

    let pushes = drain_pushes(&mut output);
    let result = pushed(&pushes, "shopRebought").expect("shopRebought result");
    assert_eq!(result.get("success").and_then(|v| v.as_bool()), Some(false));
    assert_eq!(result.get("code").and_then(|v| v.as_str()), Some("shop_not_enough_mesos"));
    assert_eq!(inventory_quantity(&world, SELLABLE_ITEM), 0);
    // A refused buy-back must leave the row for sale.
    assert_eq!(rebuy_rows(&world).len(), 1);
}

#[test]
fn shop_rebuy_refuses_a_full_inventory_and_keeps_the_row() {
    let (mut world, mut output) = shop_world();
    give(&mut world, SELLABLE_ITEM, 3);
    sell(&mut world, 1, 3, "sell-full");
    let _ = drain_pushes(&mut output);
    // Give the purse room to pay, then fill the Consume tab to its last slot.
    world.players.get_mut("seller").unwrap().state.mesos = 1_000_000;
    {
        let player = world.players.get_mut("seller").unwrap();
        for slot in 1..=inventory::SLOT_LIMIT {
            player.state.inventory.push(InventoryItem {
                slot,
                item_id: "2000001".into(),
                quantity: 1,
                ..InventoryItem::default()
            });
        }
    }

    rebuy(&mut world, SELLABLE_ITEM, unit_payout(SELLABLE_ITEM), "rebuy-full");

    let pushes = drain_pushes(&mut output);
    let result = pushed(&pushes, "shopRebought").expect("shopRebought result");
    assert_eq!(result.get("success").and_then(|v| v.as_bool()), Some(false));
    assert_eq!(result.get("code").and_then(|v| v.as_str()), Some("shop_inventory_full"));
    // The row survives: the deal was refused before anything was consumed.
    assert_eq!(rebuy_rows(&world).len(), 1);
    assert_eq!(inventory_quantity(&world, SELLABLE_ITEM), 0);
}

#[test]
fn shop_rebuy_rejects_an_unknown_shop_and_a_distant_merchant() {
    let (mut world, mut output) = shop_world();
    give(&mut world, SELLABLE_ITEM, 2);
    sell(&mut world, 1, 2, "sell-range");
    let _ = drain_pushes(&mut output);
    let price = unit_payout(SELLABLE_ITEM);

    // Unknown shop id: nothing is looked up and nothing is charged.
    world.command(Command::Input {
        id: "seller".into(),
        connection: "seller-connection".into(),
        message: ClientMessage::ShopRebuy {
            request_id: "rebuy-forged".into(),
            shop_id: "shop-does-not-exist".into(),
            item_id: SELLABLE_ITEM.into(),
            unit_price: price,
        },
    });
    let pushes = drain_pushes(&mut output);
    let result = pushed(&pushes, "shopRebought").expect("shopRebought result");
    assert_eq!(result.get("code").and_then(|v| v.as_str()), Some("shop_unknown"));

    // Same shop, but the character walked away from the merchant.
    world.players.get_mut("seller").unwrap().state.x = 100_000.0;
    rebuy(&mut world, SELLABLE_ITEM, price, "rebuy-far");
    let pushes = drain_pushes(&mut output);
    let result = pushed(&pushes, "shopRebought").expect("shopRebought result");
    assert_eq!(result.get("code").and_then(|v| v.as_str()), Some("shop_too_far"));
    assert_eq!(inventory_quantity(&world, SELLABLE_ITEM), 0);
    assert_eq!(rebuy_rows(&world).len(), 1);
}

#[test]
fn shop_rebuy_ignores_a_replayed_request_id() {
    let (mut world, mut output) = shop_world();
    give(&mut world, SELLABLE_ITEM, 8);
    sell(&mut world, 1, 8, "sell-replay");
    let _ = drain_pushes(&mut output);
    let price = unit_payout(SELLABLE_ITEM);
    let purse = world.players.get("seller").unwrap().state.mesos;
    let cost = price * 8;

    rebuy(&mut world, SELLABLE_ITEM, price, "rebuy-once");
    let pushes = drain_pushes(&mut output);
    let first = pushed(&pushes, "shopRebought").expect("shopRebought result");
    assert_eq!(first.get("success").and_then(|v| v.as_bool()), Some(true));
    assert_eq!(world.players.get("seller").unwrap().state.mesos, purse - cost);

    // Replaying the same request id must not spend a second time: the
    // remembered outcome is re-sent and nothing moves.
    rebuy(&mut world, SELLABLE_ITEM, price, "rebuy-once");
    let pushes = drain_pushes(&mut output);
    let replay = pushed(&pushes, "shopRebought").expect("replayed result is re-sent");
    assert_eq!(replay.get("mesosSpent").and_then(|v| v.as_u64()), Some(cost));
    assert_eq!(inventory_quantity(&world, SELLABLE_ITEM), 8);
    assert_eq!(world.players.get("seller").unwrap().state.mesos, purse - cost);
}

/// Store-level boundary: the list merges repeat sales of the same stack at the
/// same price and keeps only the newest rows.
#[test]
fn shop_rebuy_list_merges_and_stays_capped() {
    let path = std::env::temp_dir().join(format!("maple-shop-rebuy-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).expect("temp store");
    let store = service.store.clone();

    // The same item at the same price is one deal, not two.
    store.push_shop_rebuy("seller", "2000000", 3, 7).expect("first push");
    let rows = store.push_shop_rebuy("seller", "2000000", 4, 7).expect("merged push");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].quantity, 7);
    // A different price is a different deal and gets its own row.
    let rows = store.push_shop_rebuy("seller", "2000000", 1, 9).expect("second price");
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].unit_price, 9, "newest row first");

    for index in 0..25 {
        store
            .push_shop_rebuy("seller", &format!("40000{index:02}"), 1, 5)
            .expect("push");
    }
    let rows = store.load_shop_rebuy("seller").expect("reload");
    assert_eq!(rows.len() as i64, auth::shop::SHOP_REBUY_LIMIT);
    assert_eq!(rows[0].item_id, "4000024", "the newest sale is kept");
    assert!(
        !rows.iter().any(|row| row.item_id == "2000000"),
        "the oldest rows are the ones dropped"
    );

    // Buying a row back takes it off the list, and taking it twice is a miss.
    assert!(store.take_shop_rebuy("seller", "4000024", 5).expect("take"));
    assert!(!store.take_shop_rebuy("seller", "4000024", 5).expect("take again"));
    assert_eq!(store.load_shop_rebuy("seller").expect("reload").len(), 19);
}
