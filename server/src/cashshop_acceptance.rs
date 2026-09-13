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
        limit: 0,
    }
}

fn cash_gameplay(commodities: Vec<CashCommodity>) -> Gameplay {
    Gameplay {
        cash_shop: Some(CashShopCatalogue { commodities }),
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
fn cash_buy_period_row_stamps_a_rental_deadline() {
    let mut deal = cash_commodity("120000001", "5062001", 1, 300);
    deal.period = 7;
    let (mut world, mut output) = cash_world(vec![deal]);
    set_cash(&mut world, 1_000);
    buy(&mut world, "buy-period", "120000001", 1);
    let result = newest(&mut output, "cashBuyResult");
    assert_eq!(result["success"], true, "{result}");
    let item = world.players["buyer"]
        .state
        .inventory
        .iter()
        .find(|item| item.item_id == "5062001")
        .expect("rental delivered");
    let deadline = inventory::item_expires_at(item).expect("rental deadline stamped");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    assert!(deadline > now, "deadline {deadline} must be in the future");
    assert!(
        deadline <= now + 7 * inventory::RENTAL_DAY_SECONDS,
        "deadline {deadline} must be within seven days"
    );
}

#[test]
fn cash_buy_permanent_row_has_no_rental_deadline() {
    let (mut world, mut output) = cash_world(vec![cash_commodity("120000001", "5062001", 1, 300)]);
    set_cash(&mut world, 1_000);
    buy(&mut world, "buy-permanent", "120000001", 1);
    let result = newest(&mut output, "cashBuyResult");
    assert_eq!(result["success"], true, "{result}");
    let item = world.players["buyer"]
        .state
        .inventory
        .iter()
        .find(|item| item.item_id == "5062001")
        .expect("purchase delivered");
    assert_eq!(inventory::item_expires_at(item), None);
}

#[test]
fn cash_buy_delivers_the_bonus_units() {
    let mut deal = cash_commodity("120000001", "5062001", 1, 100);
    deal.bonus = 1;
    let (mut world, mut output) = cash_world(vec![deal]);
    set_cash(&mut world, 1_000);
    buy(&mut world, "buy-bonus", "120000001", 2);
    let result = newest(&mut output, "cashBuyResult");
    assert_eq!(result["success"], true, "{result}");
    // Two deals of (count 1 + bonus 1) deliver four units for 200 cash.
    assert_eq!(cash_inventory_quantity(&world, "5062001"), 4);
    assert_eq!(result["cashSpent"], 200);
}

#[test]
fn cash_buy_limit_blocks_purchases_past_the_budget() {
    let mut deal = cash_commodity("120000001", "5062001", 1, 100);
    deal.limit = 2;
    let (mut world, mut output) = cash_world(vec![deal]);
    set_cash(&mut world, 1_000);
    buy(&mut world, "limit-1", "120000001", 2);
    let ok = newest(&mut output, "cashBuyResult");
    assert_eq!(ok["success"], true, "{ok}");
    assert_eq!(world.players["buyer"].state.cash, 800);
    buy(&mut world, "limit-2", "120000001", 1);
    let refused = newest(&mut output, "cashBuyResult");
    assert_eq!(refused["success"], false);
    assert_eq!(refused["code"], "cash_limit");
    // The refused attempt charged nothing and delivered nothing.
    assert_eq!(world.players["buyer"].state.cash, 800);
    assert_eq!(cash_inventory_quantity(&world, "5062001"), 2);
}

#[test]
fn cash_purchase_budget_survives_a_store_reopen() {
    let path = std::env::temp_dir().join(format!("maple-cash-limit-{}.sqlite3", auth::random_id()));
    {
        let service = auth::start(&path).expect("temp store");
        service.store.record_cash_purchase("acc", "120000001", 2).unwrap();
        service.store.record_cash_purchase("acc", "120000001", 1).unwrap();
    }
    let service = auth::start(&path).expect("reopen");
    assert_eq!(
        service.store.cash_purchased_units("acc", "120000001").unwrap(),
        3
    );
    assert_eq!(service.store.cash_purchased_units("acc", "999999999").unwrap(), 0);
    let _ = std::fs::remove_file(path);
}

#[test]
fn the_rental_sweep_reclaims_expired_rows_and_notifies() {
    let (mut world, mut output) = cash_world(vec![cash_commodity("120000001", "5062001", 1, 300)]);
    // Seed one permanent stack (3 units) and one already-expired rental
    // stack (2 units) side by side in the same bag.
    let mut bag = world.players["buyer"].state.inventory.clone();
    inventory::add_items(&mut bag, "5062001".into(), 3, 24).expect("permanent stack");
    let mut expired = InventoryItem {
        slot: 9,
        item_id: "5062001".into(),
        quantity: 2,
        ..InventoryItem::default()
    };
    expired.stats = Some(BTreeMap::from([(
        inventory::EXPIRES_AT_KEY.to_owned(),
        1,
    )]));
    bag.push(expired);
    world.players.get_mut("buyer").unwrap().state.inventory = bag;
    // Align the tick with a sweep boundary, then run the cadence gate.
    world.tick = 10_000 / TICK_MS;
    world.step_rental_expiries();
    // The permanent stack survives; the expired rental row is reclaimed.
    assert_eq!(cash_inventory_quantity(&world, "5062001"), 3);
    assert!(world.players["buyer"]
        .state
        .inventory
        .iter()
        .all(|item| inventory::item_expires_at(item).is_none()));
    let notice = newest(&mut output, "rentalNotice");
    assert_eq!(notice["itemIds"][0], "5062001");
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

#[test]
fn cash_equipment_and_pets_keep_source_identity_after_store_reopen() {
    // These are real on-sale WZ items, not entries in test-fixtures/items.json.
    let weapon = "01702087";
    let pet = "05000000";
    assert_eq!(inventory::equipment_slot(weapon), Some(-11));
    assert_eq!(inventory::equipment_slot("1702087"), Some(-11));
    assert!(inventory::is_pet(pet));
    assert_eq!(inventory::pet_name(pet), inventory::pet_name("5000000"));
    let path = std::env::temp_dir().join(format!("maple-cash-binding-{}.sqlite3", auth::random_id()));
    let (world, _) = cash_world(Vec::new());
    let defaults = world.default_profile();
    {
        let service = auth::start(&path).unwrap();
        let store = &service.store;
        store.load_profile("binding", &defaults).unwrap();
        let mut bag = Vec::new();
        inventory::add_items(&mut bag, weapon.into(), 1, 24).unwrap();
        inventory::add_items(&mut bag, pet.into(), 1, 24).unwrap();
        store.write_inventory("binding", &bag).unwrap();
        let stats = inventory::EquipmentStats { level: 200, ..Default::default() };
        let wrong = store.move_inventory("binding", "wrong", 1, 1, -5, 1, stats).unwrap();
        assert!(!wrong.success, "a cash weapon cannot bind to the coat slot");
        let equipped = store.move_inventory("binding", "equip", 1, 1, -11, 1, stats).unwrap();
        assert!(equipped.success, "{}", equipped.code);
        assert!(store.toggle_pet("binding", "summon", 1, pet).unwrap().success);
    }
    {
        let service = auth::start(&path).unwrap();
        let equipped = service.store.load_equipped("binding").unwrap();
        assert!(equipped.iter().any(|item| item.item_id == weapon && item.slot == 11));
        let profile = service.store.load_profile("binding", &defaults).unwrap();
        assert!(profile.inventory.iter().any(|item| item.item_id == pet && inventory::pet_active(item)));
    }
    let _ = std::fs::remove_file(path);
}
