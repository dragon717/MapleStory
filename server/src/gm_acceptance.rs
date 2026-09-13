// GM 命令验收：`/add` 与未知命令。经 `include!` 进入 `world.rs` 的 `mod tests`，
// 复用 `map()` / `join_test_player` / `chat_drain` / `chat_take_kind` /
// `chat_world` / `chat_send`（定义在 `chat_acceptance.rs`）。

fn gm_take_kind(rx: &mut mpsc::Receiver<String>, kind: &str) -> Vec<Value> {
    let mut out = Vec::new();
    while let Ok(text) = rx.try_recv() {
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            if value["type"] == kind {
                out.push(value);
            }
        }
    }
    out
}

#[test]
fn gm_add_grants_items_into_the_sender_inventory_without_broadcast() {
    let mut world = chat_world();
    let mut alice = join_test_player(&mut world, "alice");
    let mut bob = join_test_player(&mut world, "bob");
    chat_drain(&mut alice);
    chat_drain(&mut bob);

    chat_send(&mut world, "alice", "gm-1", "/add 2000000 10");

    let results = gm_take_kind(&mut alice, "gmResult");
    assert_eq!(results.len(), 1, "exactly one gmResult goes to the sender");
    assert_eq!(results[0]["requestId"], "gm-1");
    assert_eq!(results[0]["success"], true);
    assert_eq!(results[0]["code"], "gm_add_ok");

    let stack = world
        .players
        .get("alice")
        .unwrap()
        .state
        .inventory
        .iter()
        .find(|item| item.item_id == "2000000")
        .cloned()
        .expect("the granted stack must be in the inventory");
    assert_eq!(stack.quantity, 10);

    // Commands never surface as map chat, and never reach other players.
    assert!(gm_take_kind(&mut alice, "chatMessage").is_empty());
    assert!(gm_take_kind(&mut bob, "chatMessage").is_empty());
    assert!(gm_take_kind(&mut bob, "gmResult").is_empty());
}

#[test]
fn gm_add_defaults_to_one_and_rejects_unknown_ids_and_quantities() {
    let mut world = chat_world();
    let mut alice = join_test_player(&mut world, "alice");
    chat_drain(&mut alice);

    // Missing quantity defaults to 1.
    chat_send(&mut world, "alice", "gm-def", "/add 2000001");
    let results = gm_take_kind(&mut alice, "gmResult");
    assert_eq!(results[0]["success"], true);

    // Unknown item id (not in catalog, not a pet, invalid fallback shape).
    chat_send(&mut world, "alice", "gm-unknown", "/add 9990000 1");
    let rejects = gm_take_kind(&mut alice, "gmResult");
    assert!(rejects.iter().any(|value| value["code"] == "gm_item_unknown"));

    // Quantity out of the 1-999 band.
    chat_send(&mut world, "alice", "gm-qty", "/add 2000000 0");
    chat_send(&mut world, "alice", "gm-qty2", "/add 2000000 1000");
    let rejects = gm_take_kind(&mut alice, "gmResult");
    assert_eq!(
        rejects.iter().filter(|value| value["code"] == "gm_quantity_invalid").count(),
        2
    );

    // Missing item id is a usage error.
    chat_send(&mut world, "alice", "gm-bare", "/add");
    let rejects = gm_take_kind(&mut alice, "gmResult");
    assert!(rejects.iter().any(|value| value["code"] == "gm_usage"));
}

#[test]
fn gm_unknown_commands_answer_the_sender_only() {
    let mut world = chat_world();
    let mut alice = join_test_player(&mut world, "alice");
    let mut bob = join_test_player(&mut world, "bob");
    chat_drain(&mut alice);
    chat_drain(&mut bob);

    chat_send(&mut world, "alice", "gm-x", "/killall");
    let results = gm_take_kind(&mut alice, "gmResult");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["success"], false);
    assert_eq!(results[0]["code"], "gm_unknown_command");
    assert!(gm_take_kind(&mut alice, "chatMessage").is_empty());
    assert!(gm_take_kind(&mut bob, "chatMessage").is_empty());
}

#[test]
fn gm_commands_bypass_the_chat_rate_limit_window() {
    let mut world = chat_world();
    let mut alice = join_test_player(&mut world, "alice");
    chat_drain(&mut alice);

    // Drain the chat bucket first: five sends burn the whole burst.
    for index in 0..5 {
        chat_send(&mut world, "alice", &format!("fill-{index}"), &format!("m{index}"));
    }
    assert_eq!(gm_take_kind(&mut alice, "chatMessage").len(), 5);

    // A GM command is intercepted before the token bucket, so it still runs.
    chat_send(&mut world, "alice", "gm-limited", "/add 2000002 3");
    let results = gm_take_kind(&mut alice, "gmResult");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["success"], true);
}

#[test]
fn gm_add_can_grant_a_pet_item_for_the_pet_flow() {
    let mut world = chat_world();
    let mut alice = join_test_player(&mut world, "alice");
    chat_drain(&mut alice);

    chat_send(&mut world, "alice", "gm-pet", "/add 5000000 1");
    let results = gm_take_kind(&mut alice, "gmResult");
    assert_eq!(results[0]["success"], true, "pets live in the runtime catalog");
    // Pets never stack: one row, quantity 1, cash tab slot.
    let rows: Vec<_> = world
        .players
        .get("alice")
        .unwrap()
        .state
        .inventory
        .iter()
        .filter(|item| item.item_id == "5000000")
        .collect();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].quantity, 1);
    assert_eq!(crate::inventory::inventory_type("5000000"), Some(5));
}
