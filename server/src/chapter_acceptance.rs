fn chapter_actual_world(store: auth::Store) -> World {
    let map: Map = serde_json::from_str(include_str!("../../shared/map.json")).unwrap();
    let catalog: MapCatalog = serde_json::from_str(include_str!("../../shared/maps.json")).unwrap();
    let gameplay: Gameplay = serde_json::from_str(include_str!("../../shared/gameplay.json")).unwrap();
    let quest_text: crate::quest_text::QuestTextCorpus =
        serde_json::from_str(include_str!("../../shared/quest-text.json")).unwrap();
    World::new_with_store_and_catalog(map, 600, gameplay, store, catalog)
        .unwrap()
        .with_quest_text(quest_text)
}

fn chapter_join(world: &mut World, id: &str) -> mpsc::Receiver<String> {
    let (output, rx) = mpsc::channel(4096);
    let (reply, _) = oneshot::channel();
    world.command(Command::Join {
        identity: Identity {
            id: id.to_owned(),
            username: id.to_owned(),
        },
        connection: format!("{id}-connection"),
        output,
        reply,
        lang: "zh".to_owned(),
    });
    rx
}

fn chapter_drain(rx: &mut mpsc::Receiver<String>) -> Vec<serde_json::Value> {
    std::iter::from_fn(|| rx.try_recv().ok())
        .filter_map(|message| serde_json::from_str(&message).ok())
        .collect()
}

fn chapter_place(world: &mut World, id: &str, map_id: &str, x: f64, y: f64) {
    let player = world.players.get_mut(id).unwrap();
    player.map_id = map_id.to_owned();
    player.state.x = x;
    player.state.y = y;
    player.state.action = "stand";
    player.state.grounded = true;
    player.state.hp = player.state.max_hp;
}

fn chapter_add_item(world: &mut World, id: &str, item_id: &str, quantity: u32) {
    let player = world.players.get_mut(id).unwrap();
    let slot_limit = player
        .state.inventory_slots
        .get(&inventory::inventory_type(item_id).unwrap_or(1))
        .copied()
        .unwrap_or(inventory::SLOT_LIMIT);
    inventory::add_items(
        &mut player.state.inventory,
        item_id.to_owned(),
        quantity,
        slot_limit,
    )
    .unwrap();
}

fn chapter_count(world: &World, id: &str, item_id: &str) -> u32 {
    world.players[id]
        .state
        .inventory
        .iter()
        .filter(|item| item.item_id == item_id)
        .map(|item| item.quantity)
        .sum()
}

fn chapter_rejection(rx: &mut mpsc::Receiver<String>) -> String {
    chapter_drain(rx)
        .into_iter()
        .rev()
        .find_map(|message| message["code"].as_str().map(str::to_owned))
        .expect("rejection code")
}

fn chapter_talk_quest(
    world: &mut World,
    rx: &mut mpsc::Receiver<String>,
    account: &str,
    template_id: &str,
    quest_id: &str,
    action: &str,
) {
    let (npc_id, map_id, x, y) = world
        .npcs
        .values()
        .find(|npc| npc.template_id == template_id)
        .map(|npc| (npc.state.id.clone(), npc.map_id.clone(), npc.state.x, npc.state.y))
        .expect("chapter npc spawn");
    chapter_place(world, account, &map_id, x, y);
    world.handle_npc_talk(
        account.into(),
        format!("open-{quest_id}-{action}"),
        npc_id.clone(),
        None,
        None,
    );
    let menu = chapter_drain(rx)
        .into_iter()
        .find(|message| message["type"] == "npcResult" && message["dialog"].is_object())
        .expect("chapter quest menu");
    let prefix = match action {
        "start" => "接取：",
        "complete" => "交付：",
        _ => panic!("unsupported chapter quest action"),
    };
    let name = world.quest_text.name(quest_id, "zh");
    let expected = format!("{prefix}{name}");
    let selection = menu["dialog"]["options"]
        .as_array()
        .and_then(|options| {
            options.iter().find_map(|option| {
                (option["text"].as_str() == Some(expected.as_str()))
                    .then(|| option["index"].as_u64().and_then(|index| u32::try_from(index).ok()))
                    .flatten()
            })
        })
        .expect("chapter quest option");
    world.handle_npc_talk(
        account.into(),
        format!("select-{quest_id}-{action}"),
        npc_id,
        Some("select"),
        Some(selection),
    );
    chapter_drain(rx);
}

#[test]
fn tms273_chapter_first_six_acceptance() {
    let path = std::env::temp_dir().join(format!("maple-chapter-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).unwrap();
    let store = service.store.clone();
    let account = "chapter-acceptance";
    store.load_profile(account, &quest_profile()).unwrap();
    let mut world = chapter_actual_world(store.clone());
    let mut rx = chapter_join(&mut world, account);
    chapter_drain(&mut rx);

    chapter_talk_quest(&mut world, &mut rx, account, "1541000", "36301", "start");
    chapter_place(&mut world, account, "000010000", -432.0, 646.0);
    world.handle_quest_interact(account.into(), "hairpin".into(), "36301".into());
    chapter_drain(&mut rx);
    assert_eq!(chapter_count(&world, account, "4036846"), 1);
    chapter_talk_quest(&mut world, &mut rx, account, "1541000", "36301", "complete");

    chapter_talk_quest(&mut world, &mut rx, account, "1541001", "36302", "start");
    chapter_talk_quest(&mut world, &mut rx, account, "1541001", "36302", "complete");
    chapter_talk_quest(&mut world, &mut rx, account, "1541001", "36303", "start");
    chapter_add_item(&mut world, account, "4000019", 5);
    chapter_talk_quest(&mut world, &mut rx, account, "1541001", "36303", "complete");

    chapter_talk_quest(&mut world, &mut rx, account, "1541001", "36304", "start");
    chapter_add_item(&mut world, account, "4000019", 10);
    chapter_talk_quest(&mut world, &mut rx, account, "12100", "36304", "complete");
    assert_eq!(chapter_count(&world, account, "4033919"), 1);

    chapter_talk_quest(&mut world, &mut rx, account, "22000", "36306", "start");
    chapter_talk_quest(&mut world, &mut rx, account, "22000", "36306", "complete");
    assert_eq!(world.players[account].map_id, "104000000");
    assert_eq!(chapter_count(&world, account, "4033919"), 0);

    chapter_talk_quest(&mut world, &mut rx, account, "1541002", "36307", "start");
    chapter_talk_quest(&mut world, &mut rx, account, "1541002", "36307", "complete");
    let npc_id = "104000000-life-10";
    world.handle_npc_talk(account.into(), "return-open".into(), npc_id.into(), None, None);
    let menu = chapter_drain(&mut rx)
        .into_iter()
        .find(|message| message["type"] == "npcResult")
        .expect("return menu");
    assert!(menu["dialog"]["options"]
        .as_array()
        .is_some_and(|options| !options.is_empty()));
    world.handle_npc_talk(account.into(), "return-select".into(), npc_id.into(), Some("select"), Some(0));
    chapter_drain(&mut rx);
    assert_eq!(world.players[account].map_id, "001020000");

    world.command(Command::Leave { id: account.into(), connection: format!("{account}-connection") });
    let mut world = chapter_actual_world(store.clone());
    let mut rx = chapter_join(&mut world, account);
    chapter_drain(&mut rx);
    assert_eq!(world.players[account].map_id, "001020000");
    let exp_before = world.players[account].state.exp;
    assert!(!world.apply_quest_effect_at(
        account,
        npc::QuestEffect::Complete("36307".into()),
        quest::QuestOrigin::Npc("1541002"),
        None
    ));
    chapter_drain(&mut rx);
    assert_eq!(world.players[account].state.exp, exp_before);
    assert!(store.load_quests(account).unwrap().values().all(|status| status == "completed"));

    let guard = "chapter-guards";
    store.load_profile(guard, &quest_profile()).unwrap();
    let mut guard_world = chapter_actual_world(store.clone());
    let mut guard_rx = chapter_join(&mut guard_world, guard);
    chapter_drain(&mut guard_rx);
    chapter_place(&mut guard_world, guard, "000010000", -432.0, 646.0);
    guard_world.handle_quest_interact(guard.into(), "unaccepted".into(), "36301".into());
    assert_eq!(chapter_rejection(&mut guard_rx), "quest_interaction_unavailable");
    assert!(guard_world.apply_quest_effect_at(
        guard,
        npc::QuestEffect::Start("36301".into()),
        quest::QuestOrigin::Npc("1541000"),
        None
    ));
    chapter_drain(&mut guard_rx);
    chapter_place(&mut guard_world, guard, "000010000", -590.0, 245.0);
    guard_world.handle_npc_talk(guard.into(), "remote-open".into(), "000010000-life-1".into(), None, None);
    chapter_drain(&mut guard_rx);
    chapter_place(&mut guard_world, guard, "000010000", 900.0, -800.0);
    guard_world.handle_npc_talk(guard.into(), "remote-select".into(), "000010000-life-1".into(), Some("select"), Some(0));
    assert_eq!(chapter_rejection(&mut guard_rx), "npc_too_far");
    chapter_place(&mut guard_world, guard, "000010000", 0.0, 0.0);
    guard_world.handle_quest_interact(guard.into(), "too-far".into(), "36301".into());
    assert_eq!(chapter_rejection(&mut guard_rx), "quest_interaction_too_far");
    chapter_place(&mut guard_world, guard, "000010000", -432.0, 646.0);
    guard_world.players.get_mut(guard).unwrap().state.hp = 0;
    guard_world.handle_quest_interact(guard.into(), "dead".into(), "36301".into());
    assert_eq!(chapter_rejection(&mut guard_rx), "invalid_state");
}
