/// Directional acceptance for the 現金商店 (`CashOpen` / `CashBuy`).
///
/// The window itself is static data; the server owns the only three facts
/// that matter: the balance, the deal (one SN = one source commodity row) and
/// the atomic spend.  Every case here guards one boundary a modified client
/// could push on: an SN that is not for sale, a thin wallet, an unknown
/// item family, and the replayed request that must not charge twice.

use super::*;

/// One commodity row shaped like the assembled export (`gameplay.cashShop`).
fn cash_commodity(sn: &str, item_id: &str, count: u32, price: u64) -> CashCommodity {
    CashCommodity {
        sn: sn.into(),
        item_id: item_id.into(),
        count,
        price,
        bonus: 0,
        period: 0,
        gender: 2,
        req_level: 0,
        req_pop: 0,
        priority: 1,
        limit: 0,
        refundable: true,
        tab: "game".into(),
    }
}

fn cash_gameplay(commodities: Vec<CashCommodity>) -> Gameplay {
    Gameplay {
        cash_shop: Some(CashShopCatalogue {
            categories: vec![CashCategory {
                id: "game".into(),
                label: "遊戲".into(),
            }],
            commodities,
        }),
        ..Gameplay::default()
    }
}

/// A store-backed world whose catalogue carries one purchasable 506xxxx deal.
fn cash_world(commodities: Vec<CashCommodity>) -> (World, mpsc::Receiver<String>) {
    let path = std::env::temp_dir().join(format!("maple-cash-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).expect("temp store");
    let mut world = World::new_with_store(
        map(),
        600,
        cash_gameplay(commodities),
        service.store.clone(),
    )
    .expect("world with store");
    let output = join_test_player(&mut world, "buyer");
    (world, output)
}

fn set_cash(world: &mut World, cash: u64) {
    world.players.get_mut("buyer").expect("buyer joined").state.cash = cash;
}

fn buy(world: &mut World, request: &str, sn: &str, quantity: u32) {
    world.command(Command::Input {
        id: "buyer".into(),
        connection: "buyer-connection".into(),
        message: ClientMessage::CashBuy {
            request_id: request.into(),
            sn: sn.into(),
            quantity,
        },
    });
}

/// The newest message of the given `type` in the player's stream.
fn newest(output: &mut mpsc::Receiver<String>, kind: &str) -> serde_json::Value {
    let mut found = None;
    while let Ok(message) = output.try_recv() {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&message) {
            if value.get("type").and_then(|v| v.as_str()) == Some(kind) {
                found = Some(value);
            }
        }
    }
    found.unwrap_or_else(|| panic!("no {kind} pushed"))
}

fn cash_inventory_quantity(world: &World, item_id: &str) -> u32 {
    world
        .players
        .get("buyer")
        .expect("buyer joined")
        .state
        .inventory
        .iter()
        .filter(|item| item.item_id == item_id)
        .map(|item| item.quantity)
        .sum()
}

#[test]
fn cash_open_reports_the_authoritative_balance() {
    let (mut world, mut output) = cash_world(vec![cash_commodity("120000001", "5062001", 1, 300)]);
    set_cash(&mut world, 1_000);
    world.command(Command::Input {
        id: "buyer".into(),
        connection: "buyer-connection".into(),
        message: ClientMessage::CashOpen {
            request_id: "open-1".into(),
        },
    });
    let state = newest(&mut output, "cashState");
    assert_eq!(state["cash"], 1_000);
}

#[test]
fn cash_buy_happy_path_spends_and_persists() {
    let (mut world, mut output) = cash_world(vec![cash_commodity("120000001", "5062001", 1, 300)]);
    set_cash(&mut world, 1_000);
    buy(&mut world, "buy-1", "120000001", 2);
    let result = newest(&mut output, "cashBuyResult");
    assert_eq!(result["success"], true, "{result}");
    assert_eq!(result["itemId"], "5062001");
    assert_eq!(result["cashSpent"], 600);
    assert_eq!(result["cash"], 400);
    assert_eq!(cash_inventory_quantity(&world, "5062001"), 2);
    assert_eq!(world.players["buyer"].state.cash, 400);
}

#[test]
fn cash_buy_unknown_sn_is_refused_without_charging() {
    let (mut world, mut output) = cash_world(vec![cash_commodity("120000001", "5062001", 1, 300)]);
    set_cash(&mut world, 1_000);
    buy(&mut world, "buy-2", "999999999", 1);
    let result = newest(&mut output, "cashBuyResult");
    assert_eq!(result["success"], false);
    assert_eq!(result["code"], "cash_sn_unknown");
    assert_eq!(world.players["buyer"].state.cash, 1_000);
    assert_eq!(cash_inventory_quantity(&world, "5062001"), 0);
}

#[test]
fn cash_buy_with_a_thin_wallet_is_refused() {
    let (mut world, mut output) = cash_world(vec![cash_commodity("120000001", "5062001", 1, 300)]);
    set_cash(&mut world, 299);
    buy(&mut world, "buy-3", "120000001", 1);
    let result = newest(&mut output, "cashBuyResult");
    assert_eq!(result["code"], "cash_not_enough");
    assert_eq!(world.players["buyer"].state.cash, 299);
    assert_eq!(cash_inventory_quantity(&world, "5062001"), 0);
}

#[test]
fn cash_buy_replay_returns_the_recorded_outcome_without_charging_twice() {
    let (mut world, mut output) = cash_world(vec![cash_commodity("120000001", "5062001", 1, 300)]);
    set_cash(&mut world, 1_000);
    buy(&mut world, "same-request", "120000001", 1);
    let first = newest(&mut output, "cashBuyResult");
    assert_eq!(first["success"], true);
    assert_eq!(world.players["buyer"].state.cash, 700);
    buy(&mut world, "same-request", "120000001", 1);
    let replay = newest(&mut output, "cashBuyResult");
    assert_eq!(replay["success"], true);
    assert_eq!(replay["cashSpent"], 300);
    // The replay must not have moved the wallet or doubled the stack.
    assert_eq!(world.players["buyer"].state.cash, 700);
    assert_eq!(cash_inventory_quantity(&world, "5062001"), 1);
}

#[test]
fn cash_buy_without_a_catalogue_is_refused() {
    let path = std::env::temp_dir().join(format!("maple-cash-empty-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).expect("temp store");
    let mut world = World::new_with_store(map(), 600, Gameplay::default(), service.store.clone())
        .expect("world with store");
    let mut output = join_test_player(&mut world, "buyer");
    set_cash(&mut world, 5_000);
    buy(&mut world, "buy-4", "120000001", 1);
    let result = newest(&mut output, "cashBuyResult");
    assert_eq!(result["code"], "cash_shop_unavailable");
    assert_eq!(world.players["buyer"].state.cash, 5_000);
}

#[test]
fn cash_wallet_survives_a_profile_round_trip() {
    let path = std::env::temp_dir().join(format!("maple-cash-wallet-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).expect("temp store");
    let (probe, _output) = cash_world(Vec::new());
    let defaults = probe.default_profile();
    let mut profile = service
        .store
        .load_profile("wallet", &defaults)
        .expect("seed profile");
    profile.cash = 12_345;
    service.store.save_profile("wallet", &profile).unwrap();
    let mut wiped = profile.clone();
    wiped.cash = 0;
    let loaded = service.store.load_profile("wallet", &wiped).unwrap();
    assert_eq!(loaded.cash, 12_345);
}
