fn continuation_profile(level: u32, job: u32) -> Profile {
    let mut profile = quest_profile();
    profile.level = level;
    profile.exp_to_next = 100;
    profile.job = job;
    profile
}

fn continuation_open_menu(
    world: &mut World,
    rx: &mut mpsc::Receiver<String>,
    account: &str,
    template_id: &str,
    quest_id: &str,
    action: &str,
) -> (String, u32) {
    let (npc_id, map_id, x, y) = world
        .npcs
        .values()
        .find(|npc| npc.template_id == template_id)
        .map(|npc| (npc.state.id.clone(), npc.map_id.clone(), npc.state.x, npc.state.y))
        .expect("continuation NPC spawn");
    chapter_place(world, account, &map_id, x, y);
    world.handle_npc_talk(
        account.into(),
        format!("continuation-open-{quest_id}-{action}"),
        npc_id.clone(),
        None,
        None,
    );
    let menu = chapter_drain(rx)
        .into_iter()
        .find(|message| message["type"] == "npcResult" && message["dialog"].is_object())
        .expect("continuation quest menu");
    let prefix = match action {
        "start" => "接取：",
        "complete" => "交付：",
        "pending" => "查看：",
        "route_start" | "route_complete" | "return" => "前往",
        _ => panic!("unsupported continuation action"),
    };
    let name = world.quest_text.name(quest_id, "zh");
    let selection = menu["dialog"]["options"]
        .as_array()
        .and_then(|options| {
            options.iter().find_map(|option| {
                option["text"].as_str().and_then(|text| {
                    (text.starts_with(prefix) && text.contains(name.as_str()))
                        .then(|| option["index"].as_u64())
                        .flatten()
                        .and_then(|index| u32::try_from(index).ok())
                })
            })
        })
        .expect("continuation quest option");
    (npc_id, selection)
}

fn continuation_select_menu(
    world: &mut World,
    rx: &mut mpsc::Receiver<String>,
    account: &str,
    npc_id: String,
    quest_id: &str,
    action: &str,
    selection: u32,
) -> Vec<serde_json::Value> {
    world.handle_npc_talk(
        account.into(),
        format!("continuation-select-{quest_id}-{action}"),
        npc_id,
        Some("select"),
        Some(selection),
    );
    chapter_drain(rx)
}

fn continuation_talk(
    world: &mut World,
    rx: &mut mpsc::Receiver<String>,
    account: &str,
    template_id: &str,
    quest_id: &str,
    action: &str,
) -> Vec<serde_json::Value> {
    let (npc_id, selection) =
        continuation_open_menu(world, rx, account, template_id, quest_id, action);
    continuation_select_menu(world, rx, account, npc_id, quest_id, action, selection)
}

fn continuation_equip(
    world: &mut World,
    rx: &mut mpsc::Receiver<String>,
    account: &str,
    item_id: &str,
) {
    let slot = world.players[account]
        .state
        .inventory
        .iter()
        .find(|item| item.item_id == item_id)
        .map(|item| item.slot as i16)
        .expect("start item in inventory");
    world.handle_use_item(
        account.into(),
        format!("equip-{item_id}"),
        1,
        slot,
        item_id.to_owned(),
        None,
        None,
    );
    assert!(chapter_drain(rx).iter().any(|message| {
        message["type"] == "inventoryResult" && message["success"] == true
    }));
}

#[test]
fn continuation_story_1402_through_36314_uses_real_menus() {
    let path = std::env::temp_dir().join(format!("maple-continuation-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).unwrap();
    let account = "continuation-story";
    service.store.load_profile(account, &continuation_profile(10, 0)).unwrap();
    service.store.save_quest(account, "36307", "completed").unwrap();
    let mut world = chapter_actual_world(service.store.clone());
    let mut rx = chapter_join(&mut world, account);
    chapter_drain(&mut rx);

    continuation_talk(&mut world, &mut rx, account, "1032001", "1402", "start");
    continuation_talk(&mut world, &mut rx, account, "1032001", "1402", "complete");
    assert_eq!(world.players[account].state.job, 200);
    continuation_talk(&mut world, &mut rx, account, "1541009", "36337", "start");
    continuation_talk(&mut world, &mut rx, account, "1541009", "36337", "complete");
    continuation_talk(&mut world, &mut rx, account, "1541009", "36308", "start");
    continuation_talk(&mut world, &mut rx, account, "1012100", "36308", "complete");
    continuation_talk(&mut world, &mut rx, account, "1012100", "36309", "start");
    assert_eq!(world.players[account].map_id, "130000000");
    continuation_talk(&mut world, &mut rx, account, "1541003", "36309", "complete");
    continuation_talk(&mut world, &mut rx, account, "1012100", "36309", "route_start");
    assert_eq!(world.players[account].map_id, "130000000");
    continuation_talk(&mut world, &mut rx, account, "1101002", "36310", "start");
    assert_eq!(world.players[account].map_id, "100000201");
    assert!(!world.players[account].state.grounded);
    assert_eq!(world.players[account].state.x, world.maps["100000201"].spawn.x);
    assert_eq!(world.players[account].state.y, world.maps["100000201"].spawn.y);
    assert_eq!(chapter_count(&world, account, "4033888"), 1);

    world.command(Command::Leave {
        id: account.into(),
        connection: format!("{account}-connection"),
    });
    let mut world = chapter_actual_world(service.store.clone());
    let mut rx = chapter_join(&mut world, account);
    chapter_drain(&mut rx);
    assert_eq!(world.players[account].quests["36310"], "active");
    assert_eq!(chapter_count(&world, account, "4033888"), 1);
    continuation_talk(&mut world, &mut rx, account, "1012100", "36310", "complete");
    assert_eq!(chapter_count(&world, account, "4033888"), 0);
    continuation_talk(&mut world, &mut rx, account, "1012100", "36311", "start");
    continuation_talk(&mut world, &mut rx, account, "1012100", "36311", "complete");
    continuation_talk(&mut world, &mut rx, account, "1012100", "36312", "start");
    continuation_talk(&mut world, &mut rx, account, "1541004", "36312", "complete");
    continuation_talk(&mut world, &mut rx, account, "1541004", "36313", "start");
    assert_eq!(chapter_count(&world, account, "1003134"), 1);
    continuation_talk(&mut world, &mut rx, account, "1541004", "36313", "pending");
    assert_eq!(world.players[account].quests["36313"], "active");
    continuation_equip(&mut world, &mut rx, account, "1003134");
    assert!(world.players[account].state.equipped.iter().any(|item| item.item_id == "1003134"));
    continuation_talk(&mut world, &mut rx, account, "1541004", "36313", "complete");
    assert_eq!(world.players[account].map_id, "310050000");
    assert!(!world.players[account].state.grounded);
    assert_eq!(world.players[account].state.x, world.maps["310050000"].spawn.x);
    assert_eq!(world.players[account].state.y, world.maps["310050000"].spawn.y);
    continuation_talk(&mut world, &mut rx, account, "1541005", "36314", "start");
    assert_eq!(chapter_count(&world, account, "4033889"), 1);
    assert_eq!(chapter_count(&world, account, "4036847"), 1);
    continuation_talk(&mut world, &mut rx, account, "1012100", "36314", "complete");
    assert_eq!(chapter_count(&world, account, "4033889"), 0);
    assert_eq!(chapter_count(&world, account, "4036847"), 0);
    let exp = world.players[account].state.exp;
    assert!(!world.apply_quest_effect_at(
        account,
        npc::QuestEffect::Complete("36314".into()),
        Some("1012100"),
        None,
    ));
    assert_eq!(world.players[account].state.exp, exp);
}

#[test]
fn continuation_branch_36337_accepts_any_route_checkpoint() {
    let path = std::env::temp_dir().join(format!("maple-continuation-branch-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).unwrap();
    let account = "continuation-branch";
    // Source Check.QuestOrOption == 1: any one of the seven route checkpoints
    // unlocks 36337.  A non-mage checkpoint (1401) must open the quest without
    // requiring the mage checkpoint 1402.
    service.store.load_profile(account, &continuation_profile(10, 200)).unwrap();
    service.store.save_quest(account, "36307", "completed").unwrap();
    service.store.save_quest(account, "1401", "completed").unwrap();
    let mut world = chapter_actual_world(service.store.clone());
    let mut rx = chapter_join(&mut world, account);
    chapter_drain(&mut rx);

    continuation_talk(&mut world, &mut rx, account, "1541009", "36337", "start");
    continuation_talk(&mut world, &mut rx, account, "1541009", "36337", "complete");
    assert_eq!(world.players[account].quests["36337"], "completed");

    // A character with no route checkpoint must still be blocked: fixing the OR
    // semantics must not drop the branch prerequisite entirely.
    let blocked = "continuation-branch-blocked";
    service.store.load_profile(blocked, &continuation_profile(10, 200)).unwrap();
    service.store.save_quest(blocked, "36307", "completed").unwrap();
    let mut blocked_rx = chapter_join(&mut world, blocked);
    chapter_drain(&mut blocked_rx);
    let (npc_id, map_id, x, y) = world
        .npcs
        .values()
        .find(|npc| npc.template_id == "1541009")
        .map(|npc| (npc.state.id.clone(), npc.map_id.clone(), npc.state.x, npc.state.y))
        .expect("Dew spawn");
    chapter_place(&mut world, blocked, &map_id, x, y);
    world.handle_npc_talk(blocked.into(), "branch-blocked-open".into(), npc_id.clone(), None, None);
    let messages = chapter_drain(&mut blocked_rx);
    let offered = messages.iter().any(|message| {
        message["type"] == "npcResult"
            && message["dialog"]["options"]
                .as_array()
                .is_some_and(|options| {
                    options.iter().any(|option| {
                        option["text"].as_str().is_some_and(|text| text.starts_with("接取："))
                    })
                })
    });
    assert!(!offered);
}

#[test]
fn continuation_start_items_full_rolls_back_and_stale_menu_is_rejected() {
    let path = std::env::temp_dir().join(format!("maple-continuation-full-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).unwrap();
    let account = "continuation-full";
    service.store.load_profile(account, &continuation_profile(10, 200)).unwrap();
    service.store.save_quest(account, "36313", "completed").unwrap();
    let mut world = chapter_actual_world(service.store.clone());
    let mut rx = chapter_join(&mut world, account);
    chapter_drain(&mut rx);
    for item_id in [
        "4000000", "4000001", "4000003", "4000004", "4000005", "4000010", "4000011",
        "4000016", "4000018", "4000019", "4000047", "4000067", "4000195", "4000215",
        "4001344", "4001345", "4001347", "4001354", "4001356", "4001358", "4001360",
        "4001365", "4004001",
    ] {
        chapter_add_item(&mut world, account, item_id, 1);
    }
    assert_eq!(
        world.players[account]
            .state
            .inventory
            .iter()
            .filter(|item| inventory::inventory_type(&item.item_id) == Some(4))
            .count(),
        usize::from(inventory::SLOT_LIMIT - 1)
    );
    let before = world.players[account].state.inventory.clone();
    let (npc_id, selection) = continuation_open_menu(
        &mut world, &mut rx, account, "1541005", "36314", "start",
    );
    let messages = continuation_select_menu(
        &mut world, &mut rx, account, npc_id, "36314", "start", selection,
    );
    assert!(messages.iter().any(|message| message["code"] == "quest_start_inventory_full"));
    assert!(!world.players[account].quests.contains_key("36314"));
    assert_eq!(world.players[account].state.inventory, before);
    assert_eq!(chapter_count(&world, account, "4033889"), 0);
    let (npc_id, selection) = continuation_open_menu(
        &mut world, &mut rx, account, "1541005", "36314", "start",
    );
    world.players.get_mut(account).unwrap().quests.insert("36314".into(), "active".into());
    let messages = continuation_select_menu(
        &mut world, &mut rx, account, npc_id, "36314", "start", selection,
    );
    assert!(messages.iter().any(|message| message["code"] == "quest_option_unavailable"));
}

#[test]
fn continuation_legacy_job_and_warp_save_failure_keep_authoritative_state() {
    let path = std::env::temp_dir().join(format!("maple-continuation-legacy-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).unwrap();
    let account = "continuation-legacy";
    let mut profile = continuation_profile(10, 222);
    profile.skill_points = BTreeMap::from([(222, 7)]);
    service.store.load_profile(account, &profile).unwrap();
    service.store.save_profile(account, &profile).unwrap();
    service.store.save_quest(account, "36307", "completed").unwrap();
    let mut world = chapter_actual_world(service.store.clone());
    let mut rx = chapter_join(&mut world, account);
    chapter_drain(&mut rx);
    continuation_talk(&mut world, &mut rx, account, "1032001", "1402", "start");
    continuation_talk(&mut world, &mut rx, account, "1032001", "1402", "complete");
    assert_eq!(world.players[account].state.job, 222);
    assert_eq!(world.players[account].state.skill_points.get(&222), Some(&7));
    let warper = "continuation-save-failure";
    service.store.load_profile(warper, &continuation_profile(10, 200)).unwrap();
    let mut failure_rx = chapter_join(&mut world, warper);
    chapter_drain(&mut failure_rx);
    let old_map = world.players[warper].map_id.clone();
    let old_channel = "channel-stays".to_owned();
    let old_recovery = world.players[warper].natural_recovery_next_tick;
    let channel_until = world.tick + 100;
    {
        let player = world.players.get_mut(warper).unwrap();
        player.state.mesos = u64::MAX;
        player.channel_request_id = Some(old_channel.clone());
        player.channel_until = channel_until;
    }
    assert!(!world.warp_player(warper, "100000201".into()));
    assert_eq!(world.players[warper].map_id, old_map);
    assert_eq!(world.players[warper].channel_request_id.as_deref(), Some(old_channel.as_str()));
    assert_eq!(world.players[warper].natural_recovery_next_tick, old_recovery);
    world.players.get_mut(warper).unwrap().state.mesos = 0;
    assert!(world.warp_player(warper, "100000201".into()));
    assert_eq!(world.players[warper].map_id, "100000201");
}
