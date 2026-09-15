// Directional acceptance for the NPC shop purchase (`ShopBuy`).
//
// The buy path was the only mesos-moving shop action with no directional
// coverage at all: sell-back and buy-back each had their own file, buying had
// none.  Everything here is about the boundaries that make a purchase safe.
// The client names a shop and an item; the server must re-derive which merchant
// is reachable, what the item costs *there*, and whether the tab can hold it.
// A refused purchase must leave the purse and the tab exactly as they were.
//
// The replay test is not decoration.  Writing these boundaries is what exposed
// that this path also lacked the `requestId` ledger its three sibling actions
// (`ShopSell`, `ShopRebuy`, cash purchase) all carry, so a retried packet used
// to deduct mesos and grant the stack a second time.  The fix and this test
// landed together.
//
// Every helper carries an `sb_` prefix: this file is `include!`d into the same
// module as the sell/rebuy acceptance files, so the plain names (`shop_world`,
// `give`, `buy`, `inventory_quantity`) are already taken.

use super::*;

const SB_SHOP_ID: &str = "shop-buy-test";
const SB_NPC_ID: &str = "shop-buy-npc";
/// A plain consumable with a TMS273-authored catalog price (紅色藥水).
const SB_ITEM: &str = "2000000";
/// Another consumable, only ever used to occupy the tab.
const SB_FILLER: &str = "2000001";
/// The merchant's own asking price.  Deliberately different from the catalog's
/// sell price, so a test cannot pass by reading the wrong source.
const SB_PRICE: u64 = 5;

fn sb_map() -> Map {
    Map {
        id: "shop-buy-test".into(),
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

fn sb_gameplay() -> Gameplay {
    Gameplay {
        npcs: vec![NpcTemplate {
            template_id: "9000000".into(),
            name: "Merchant".into(),
            func: "shop".into(),
            shop_id: Some(SB_SHOP_ID.into()),
            script: None,
            stand: Vec::new(),
        }],
        npc_spawns: vec![NpcSpawn {
            id: SB_NPC_ID.into(),
            template_id: "9000000".into(),
            x: 120.0,
            y: 200.0,
            foothold_id: Some(1),
            map_id: "shop-buy-test".into(),
            facing: -1,
        }],
        shops: vec![npc::Shop {
            shop_id: SB_SHOP_ID.into(),
            npc_id: "9000000".into(),
            items: vec![npc::ShopEntry {
                item_id: SB_ITEM.into(),
                price: SB_PRICE,
                position: 0,
            }],
        }],
        ..Gameplay::default()
    }
}

fn sb_world() -> (World, mpsc::Receiver<String>) {
    // Configured NPC spawns are only placed by the store-backed constructor,
    // and the merchant has to exist on the map for the range check to pass.
    let path = std::env::temp_dir().join(format!("maple-shop-buy-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).expect("temp store");
    service
        .store
        .load_profile("buyer", &quest_profile())
        .expect("seed profile");
    let mut world = World::new_with_store(sb_map(), 600, sb_gameplay(), service.store.clone())
        .expect("world with store");
    let mut output = join_test_player(&mut world, "buyer");
    while output.try_recv().is_ok() {}
    for _ in 0..4 {
        world.step();
        while output.try_recv().is_ok() {}
    }
    (world, output)
}

/// Give the character a purse to spend.  The seeded profile starts at zero, and
/// every test below is about what a purchase does to that balance.
fn sb_fund(world: &mut World, mesos: u64) {
    world.players.get_mut("buyer").expect("buyer joined").state.mesos = mesos;
}

fn sb_purse(world: &World) -> u64 {
    world.players.get("buyer").expect("buyer joined").state.mesos
}

/// Put `quantity` of `item_id` into slot 1 of the character's inventory.
fn sb_give(world: &mut World, item_id: &str, quantity: u32) {
    let player = world.players.get_mut("buyer").expect("buyer joined");
    player.state.inventory.push(crate::protocol::InventoryItem {
        slot: 1,
        item_id: item_id.to_owned(),
        quantity,
        ..crate::protocol::InventoryItem::default()
    });
}

fn sb_buy(world: &mut World, item_id: &str, quantity: u32, request: &str) {
    world.command(Command::Input {
        id: "buyer".into(),
        connection: "buyer-connection".into(),
        message: ClientMessage::ShopBuy {
            request_id: request.into(),
            shop_id: SB_SHOP_ID.into(),
            item_id: item_id.into(),
            quantity,
        },
    });
}

/// The last `shopResult` message sent to the character.
fn sb_last(output: &mut mpsc::Receiver<String>) -> Option<serde_json::Value> {
    let mut last = None;
    while let Ok(message) = output.try_recv() {
        if message.contains("\"shopResult\"") {
            last = Some(serde_json::from_str::<serde_json::Value>(&message).ok()?);
        }
    }
    last
}

fn sb_held(world: &World, item_id: &str) -> u32 {
    world
        .players
        .get("buyer")
        .map(|player| {
            player
                .state
                .inventory
                .iter()
                .filter(|item| item.item_id == item_id)
                .map(|item| item.quantity)
                .sum()
        })
        .unwrap_or(0)
}

/// How many inventory rows hold `item_id`.  A merge must not add a row.
fn sb_rows(world: &World, item_id: &str) -> usize {
    world
        .players
        .get("buyer")
        .map(|player| {
            player
                .state
                .inventory
                .iter()
                .filter(|item| item.item_id == item_id)
                .count()
        })
        .unwrap_or(0)
}

#[test]
fn shop_buy_spends_mesos_and_grants_the_stack() {
    let (mut world, mut output) = sb_world();
    sb_fund(&mut world, 1_000);

    sb_buy(&mut world, SB_ITEM, 10, "buy-1");

    let result = sb_last(&mut output).expect("shopResult");
    assert_eq!(
        result.get("success").and_then(|v| v.as_bool()),
        Some(true),
        "purchase was refused with code {:?}",
        result.get("code").and_then(|v| v.as_str())
    );
    assert_eq!(result.get("itemId").and_then(|v| v.as_str()), Some(SB_ITEM));
    assert_eq!(result.get("quantity").and_then(|v| v.as_u64()), Some(10));
    // The merchant's asking price, not the catalog's sell price, is what a
    // purchase costs.
    assert_eq!(
        result.get("mesosSpent").and_then(|v| v.as_u64()),
        Some(SB_PRICE * 10)
    );
    assert_eq!(sb_held(&world, SB_ITEM), 10);
    assert_eq!(sb_purse(&world), 1_000 - SB_PRICE * 10);
}

#[test]
fn shop_buy_merges_into_an_existing_stack_instead_of_taking_a_second_row() {
    let (mut world, mut output) = sb_world();
    sb_fund(&mut world, 1_000);
    sb_give(&mut world, SB_ITEM, 2);

    sb_buy(&mut world, SB_ITEM, 3, "buy-merge");

    let result = sb_last(&mut output).expect("shopResult");
    assert_eq!(
        result.get("success").and_then(|v| v.as_bool()),
        Some(true),
        "purchase was refused with code {:?}",
        result.get("code").and_then(|v| v.as_str())
    );
    assert_eq!(sb_held(&world, SB_ITEM), 5, "the two stacks became one");
    assert_eq!(
        sb_rows(&world, SB_ITEM),
        1,
        "a partial stack must be topped up in place, not shadowed by a second row"
    );
    assert_eq!(sb_purse(&world), 1_000 - SB_PRICE * 3);
}

#[test]
fn shop_buy_refuses_a_full_tab_without_spending_a_meso() {
    let (mut world, mut output) = sb_world();
    sb_fund(&mut world, 1_000_000);
    let kind = inventory::inventory_type(SB_ITEM).expect("catalog knows the tab");
    let limit = world
        .players
        .get("buyer")
        .and_then(|player| player.state.inventory_slots.get(&kind).copied())
        .unwrap_or(inventory::SLOT_LIMIT);
    {
        // Occupy every slot of the tab the purchase would land in.  The filler
        // is a different item, so it can never absorb the purchase by merging.
        let player = world.players.get_mut("buyer").expect("buyer joined");
        for slot in 1..=limit {
            player.state.inventory.push(crate::protocol::InventoryItem {
                slot,
                item_id: SB_FILLER.into(),
                quantity: 1,
                ..crate::protocol::InventoryItem::default()
            });
        }
    }

    sb_buy(&mut world, SB_ITEM, 1, "buy-full");

    let result = sb_last(&mut output).expect("shopResult");
    assert_eq!(result.get("success").and_then(|v| v.as_bool()), Some(false));
    assert_eq!(
        result.get("code").and_then(|v| v.as_str()),
        Some("shop_inventory_full")
    );
    // The whole point of validating against a cloned inventory: a full tab must
    // cancel the gold spend, never charge for nothing.
    assert_eq!(result.get("mesosSpent").and_then(|v| v.as_u64()), Some(0));
    assert_eq!(sb_purse(&world), 1_000_000, "a refused purchase must not charge");
    assert_eq!(sb_held(&world, SB_ITEM), 0, "nor grant the item");
}

#[test]
fn shop_buy_refuses_without_enough_mesos() {
    let (mut world, mut output) = sb_world();
    // One meso short of a single unit.
    sb_fund(&mut world, SB_PRICE - 1);

    sb_buy(&mut world, SB_ITEM, 1, "buy-poor");

    let result = sb_last(&mut output).expect("shopResult");
    assert_eq!(result.get("success").and_then(|v| v.as_bool()), Some(false));
    assert_eq!(
        result.get("code").and_then(|v| v.as_str()),
        Some("shop_not_enough_mesos")
    );
    assert_eq!(sb_purse(&world), SB_PRICE - 1, "the purse is untouched");
    assert_eq!(sb_held(&world, SB_ITEM), 0);
}

#[test]
fn shop_buy_refuses_a_zero_quantity() {
    let (mut world, mut output) = sb_world();
    sb_fund(&mut world, 1_000);

    sb_buy(&mut world, SB_ITEM, 0, "buy-zero");

    let result = sb_last(&mut output).expect("shopResult");
    assert_eq!(result.get("success").and_then(|v| v.as_bool()), Some(false));
    // The insertion rejects an empty stack before the purse is touched; the
    // buy path folds that into its generic refusal code.
    assert_eq!(result.get("code").and_then(|v| v.as_str()), Some("shop_rejected"));
    assert_eq!(result.get("mesosSpent").and_then(|v| v.as_u64()), Some(0));
    assert_eq!(sb_purse(&world), 1_000);
    assert_eq!(sb_held(&world, SB_ITEM), 0);
}

#[test]
fn shop_buy_rejects_an_unknown_shop_a_distant_merchant_and_an_unstocked_item() {
    let (mut world, mut output) = sb_world();
    sb_fund(&mut world, 1_000);

    // Unknown shop id: nothing is looked up and nothing is charged.
    world.command(Command::Input {
        id: "buyer".into(),
        connection: "buyer-connection".into(),
        message: ClientMessage::ShopBuy {
            request_id: "buy-forged".into(),
            shop_id: "shop-does-not-exist".into(),
            item_id: SB_ITEM.into(),
            quantity: 1,
        },
    });
    let result = sb_last(&mut output).expect("shopResult");
    assert_eq!(result.get("code").and_then(|v| v.as_str()), Some("shop_unknown"));

    // Same shop, but the character has been moved out of talking range: the
    // merchant is at x=120 and TALK_RANGE_X is 800, so park them far away.
    world.players.get_mut("buyer").unwrap().state.x = 100_000.0;
    sb_buy(&mut world, SB_ITEM, 1, "buy-far");
    let result = sb_last(&mut output).expect("shopResult");
    assert_eq!(result.get("code").and_then(|v| v.as_str()), Some("shop_too_far"));

    // Back in range, but asking for something this merchant does not stock.
    // A client cannot buy an item out of a shop it merely named.
    world.players.get_mut("buyer").unwrap().state.x = 100.0;
    sb_buy(&mut world, SB_FILLER, 1, "buy-unstocked");
    let result = sb_last(&mut output).expect("shopResult");
    assert_eq!(
        result.get("code").and_then(|v| v.as_str()),
        Some("shop_item_unknown")
    );

    assert_eq!(sb_purse(&world), 1_000, "no forged request may move mesos");
    assert_eq!(sb_held(&world, SB_ITEM), 0);
    assert_eq!(sb_held(&world, SB_FILLER), 0);
}

#[test]
fn shop_buy_ignores_a_replayed_request_id() {
    let (mut world, mut output) = sb_world();
    sb_fund(&mut world, 1_000);

    sb_buy(&mut world, SB_ITEM, 10, "buy-once");
    let first = sb_last(&mut output).expect("shopResult");
    assert_eq!(first.get("success").and_then(|v| v.as_bool()), Some(true));
    let spent = first.get("mesosSpent").and_then(|v| v.as_u64()).expect("charge");

    // Replaying the same request id must not charge or grant a second time: the
    // remembered outcome is re-sent and nothing moves.
    sb_buy(&mut world, SB_ITEM, 10, "buy-once");
    let replay = sb_last(&mut output).expect("replayed result is re-sent");
    assert_eq!(replay.get("mesosSpent").and_then(|v| v.as_u64()), Some(spent));
    assert_eq!(
        replay.get("success").and_then(|v| v.as_bool()),
        Some(true),
        "a replay re-sends the original outcome, not a fresh refusal"
    );
    assert_eq!(
        sb_purse(&world),
        1_000 - spent,
        "a replayed shopBuy must not deduct mesos twice"
    );
    assert_eq!(
        sb_held(&world, SB_ITEM),
        10,
        "a replayed shopBuy must not grant the stack twice"
    );

    // A genuinely new request still buys: the guard is keyed on the request id,
    // not on the item.
    sb_buy(&mut world, SB_ITEM, 1, "buy-second");
    let second = sb_last(&mut output).expect("shopResult");
    assert_eq!(second.get("success").and_then(|v| v.as_bool()), Some(true));
    assert_eq!(sb_held(&world, SB_ITEM), 11);
    assert_eq!(sb_purse(&world), 1_000 - spent - SB_PRICE);
}

#[test]
fn shop_buy_replays_a_refusal_instead_of_re_deciding_it() {
    let (mut world, mut output) = sb_world();
    sb_fund(&mut world, SB_PRICE - 1);

    sb_buy(&mut world, SB_ITEM, 1, "buy-poor-once");
    let first = sb_last(&mut output).expect("shopResult");
    assert_eq!(
        first.get("code").and_then(|v| v.as_str()),
        Some("shop_not_enough_mesos")
    );

    // Afford it now, but replay the *same* request id: the ledger remembers the
    // refusal, so the retry stays refused rather than silently charging for a
    // request the client never sent as a new one.
    sb_fund(&mut world, 1_000);
    sb_buy(&mut world, SB_ITEM, 1, "buy-poor-once");
    let replay = sb_last(&mut output).expect("replayed result is re-sent");
    assert_eq!(replay.get("success").and_then(|v| v.as_bool()), Some(false));
    assert_eq!(
        replay.get("code").and_then(|v| v.as_str()),
        Some("shop_not_enough_mesos")
    );
    assert_eq!(sb_purse(&world), 1_000, "a replayed refusal never charges");
    assert_eq!(sb_held(&world, SB_ITEM), 0);
}

/// NB-04：扣金币与授予行是一个事务。持久化失败（这里用「握住库锁」注入）
/// 时整笔回滚：内存分文未动、一物未授，且该 request 的重放记住的是这次
/// 拒绝——库恢复后也不会被偷偷重放成一次成交。
#[test]
fn shop_buy_refuses_and_keeps_memory_when_the_commit_fails() {
    let (mut world, mut output) = sb_world();
    sb_fund(&mut world, 1_000);

    {
        let _denial = Store::deny_persistence();
        sb_buy(&mut world, SB_ITEM, 10, "buy-db-down");
        let result = sb_last(&mut output).expect("shopResult");
        assert_eq!(result.get("success").and_then(|v| v.as_bool()), Some(false));
        assert_eq!(
            result.get("code").and_then(|v| v.as_str()),
            Some("persistence")
        );
    }
    assert_eq!(sb_purse(&world), 1_000, "a failed commit never charges");
    assert_eq!(sb_held(&world, SB_ITEM), 0, "nor grants the stack");

    // 同一 request 的重放重发同一次拒绝（幂等账本），库恢复后也不会成交。
    sb_buy(&mut world, SB_ITEM, 10, "buy-db-down");
    let replay = sb_last(&mut output).expect("replayed result is re-sent");
    assert_eq!(replay.get("success").and_then(|v| v.as_bool()), Some(false));
    assert_eq!(
        replay.get("code").and_then(|v| v.as_str()),
        Some("persistence")
    );
    assert_eq!(sb_purse(&world), 1_000);
    assert_eq!(sb_held(&world, SB_ITEM), 0);

    // 一个真正的新 request 在库恢复后照常成交。
    sb_buy(&mut world, SB_ITEM, 10, "buy-after-recovery");
    let retry = sb_last(&mut output).expect("shopResult");
    assert_eq!(
        retry.get("success").and_then(|v| v.as_bool()),
        Some(true),
        "purchase was refused with code {:?}",
        retry.get("code").and_then(|v| v.as_str())
    );
    assert_eq!(sb_purse(&world), 1_000 - SB_PRICE * 10);
    assert_eq!(sb_held(&world, SB_ITEM), 10);
}
