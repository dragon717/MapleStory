// 審計 T05：一段续章走到尽头时，玩家必须知道**为什么**停下，而不是对着一条
// 空任务日志以为冒险结束了。
//
// 背景（本轮实测）：36315「奧莉維亞的特別修練」与 36316「調查時間神殿」在
// 当前装配世界里都是真实可走的（T03 已把击杀目标落到可达地图），但 36316 之后
// 的 36317「再次前往現在的門」被源边界挡住（Check/1 只含 order 与
// exVariable=dummy 的计数器，适配器记为 `script-counter`）。服务端在此之前
// 只把「可执行」的任务写进日志，于是玩家交完 36316 后日志里什么都不会新增 ——
// 不可执行与不存在在界面上长得一模一样。
//
// 之后一轮把 `infoex` 的语义核定完了（`exVariable` 是计数器名字、`value` 是
// 目标数；见 §2 的 1090:5 交叉验证），于是停下的理由可以按**计数器种类**说准：
// `dummy` 是剧情场景的布尔位，`talk` 是对话步骤。种类只是把理由说准，不放行
// 任何一条任务 —— 见 `a_script_counter_is_named_from_the_source_and_still_opens_nothing`。
//
// 这里钉住的是"可解释的停止"而不是"把 36317 打开"：源里没有的剧情不伪造，
// 但停下这件事必须说清楚、指得出真实地图与 NPC，并且绝不给出按下去必被拒的
// 接取按钮。

const ROUTE_PREV: [&str; 3] = ["36314", "36315", "36316"];
const ROUTE_STOP: &str = "36317";
const ROUTE_AFTER: &str = "36318";
const HEROINE_NPC: &str = "1012100";
const HEROINE_MAP: &str = "100000201";
const HUNT_QUEST: &str = "36315";
const HUNT_MOB: &str = "8645261";
const HUNT_MAP: &str = "001010000";
const OTHER_JOB_QUEST: &str = "1401";

fn route_profile() -> Profile {
    let mut profile = quest_profile();
    profile.hp = 5_000;
    profile.max_hp = 5_000;
    profile.level = 20;
    profile.job = 200;
    profile
}

fn route_world(account: &str, completed: &[&str]) -> (World, mpsc::Receiver<String>) {
    let path = std::env::temp_dir().join(format!("maple-route-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).unwrap();
    service.store.load_profile(account, &route_profile()).unwrap();
    for quest_id in completed {
        service.store.save_quest(account, quest_id, "completed").unwrap();
    }
    let mut world = chapter_actual_world(service.store.clone());
    let rx = chapter_join(&mut world, account);
    (world, rx)
}

fn route_entry(world: &World, account: &str, quest_id: &str) -> Option<serde_json::Value> {
    world
        .quest_log_entries(account)
        .into_iter()
        .find(|entry| entry["questId"] == quest_id)
}

#[test]
fn the_stop_after_the_hand_in_says_why_instead_of_disappearing() {
    let account = "route-stop";
    let (world, mut rx) = route_world(account, &ROUTE_PREV);
    chapter_drain(&mut rx);

    // 交完 36316 之后 36317 的每个前置都成立，它必须出现在日志里 —— 这才是
    // "续章还有下一段"的唯一证据。
    let stop = route_entry(&world, account, ROUTE_STOP)
        .unwrap_or_else(|| panic!("{ROUTE_STOP} 已解锁，日志里不能没有它"));
    assert_eq!(stop["status"], "blocked");

    // 说人话，不是把装配标签直接贴给玩家看。计数器种类按源 `infoex` 说出来：
    // 36317 的是 `dummy`，即剧情场景的布尔位，不再是笼统的"有计数器没复刻"。
    let reason = stop["blockReason"].as_str().expect("blockReason 必须有");
    assert!(reason.starts_with("尚未開放："), "阻塞原因要人话：{reason}");
    assert!(reason.contains("劇情場景"), "阻塞原因要说出计数器种类：{reason}");
    assert!(
        !reason.contains("原版腳本計數器尚未復刻"),
        "已核定种类就不该再退回笼统措辞：{reason}"
    );
    assert!(!reason.contains("script-counter"), "装配标签不能原样露给玩家：{reason}");

    // 指向真实存在的地图与 NPC，并明说它还没开放：只给坐标不给状态会让人白跑，
    // 只给状态不给地点会让人以为是自己没找到。
    let next = stop["nextAction"].as_str().expect("blocked 行也要有下一步说明");
    assert!(next.contains("尚未開放"), "nextAction 必须说明未开放：{next}");
    assert!(next.contains("赫麗娜") || next.contains(HEROINE_NPC), "nextAction 要指出真实NPC：{next}");
    assert_eq!(
        stop["targetMapId"].as_str(),
        Some(HEROINE_MAP),
        "接取NPC真的在弓箭手培訓中心"
    );
    assert_eq!(stop["targetNpcId"].as_str(), Some(HEROINE_NPC));

    // 这一行不能给按钮：源没标自助，_blocked_ 也不该让客户端以为可以接。
    assert!(stop.get("selfStart").is_none(), "blocked 行不得带自助接取");
    assert!(stop.get("selfComplete").is_none(), "blocked 行不得带自助交付");

    // 再往后的 36318 前置还没成立，不能提前冒出来把日志搅乱。
    assert!(
        route_entry(&world, account, ROUTE_AFTER).is_none(),
        "前置未满足的后续不该出现"
    );
}

#[test]
fn a_blocked_row_never_offers_a_control_the_server_would_refuse() {
    // 36319 是源标了 selfStart 的 blocked 任务。若哪天它的前置变成可达，
    // 这条用例保证它不会因为那个标志而在日志里长出一个按下去必被拒的按钮。
    let account = "route-no-control";
    let (world, mut rx) = route_world(account, &ROUTE_PREV);
    chapter_drain(&mut rx);
    for entry in world.quest_log_entries(account) {
        if entry["status"] != "blocked" {
            continue;
        }
        assert!(
            entry.get("selfStart").is_none() && entry.get("selfComplete").is_none(),
            "blocked 行不得带自助标志：{entry}"
        );
        // 指路也不能指到没有装配的地图上。
        if let Some(map_id) = entry["targetMapId"].as_str() {
            assert!(world.maps.contains_key(map_id), "targetMapId 必须是已装配地图：{map_id}");
        }
    }
}

#[test]
fn the_hunt_names_the_map_the_target_actually_lives_on() {
    let account = "route-hunt";
    let (mut world, mut rx) = route_world(account, &["36314"]);
    chapter_drain(&mut rx);

    world.handle_quest_service(
        account.into(),
        "route-hunt-start".into(),
        HUNT_QUEST.into(),
        "start".into(),
    );
    chapter_drain(&mut rx);
    assert_eq!(world.players[account].quests[HUNT_QUEST], "active");

    let hunt = route_entry(&world, account, HUNT_QUEST).expect("接取后 36315 必须在日志里");
    assert_eq!(hunt["status"], "active");
    let next = hunt["nextAction"].as_str().expect("进行中的狩猎要说出地图");
    assert!(next.contains("冒險者修練場入口"), "nextAction 要给出真实地图名：{next}");
    assert!(next.contains("藍色蘑菇王"), "nextAction 要说出目标：{next}");
    assert_eq!(
        hunt["targetMapId"].as_str(),
        Some(HUNT_MAP),
        "猎物所在图要能被客户端用来指路"
    );

    // 打完之后这条狩猎提示就该消失：它只描述还没完成的目标。
    world.players.get_mut(account).unwrap().quest_kills.insert(
        HUNT_QUEST.to_owned(),
        [(HUNT_MOB.to_owned(), 1u32)].into_iter().collect(),
    );
    let done = route_entry(&world, account, HUNT_QUEST).expect("36315 仍在日志里");
    assert_ne!(done["status"], "active", "目标达成后不再是进行中");
    assert!(
        done["nextAction"]
            .as_str()
            .is_none_or(|next| !next.contains("冒險者修練場入口")),
        "完成后不该再让人去找已经打完的目标"
    );
}

#[test]
fn another_jobs_chapter_stays_out_of_this_players_log() {
    // 1401「劍士之路」的前置对法师同样成立，但它是别的职业路线。把它当成
    // "本职业的下一站"只会让人以为自己卡住了。
    let account = "route-other-job";
    let (world, mut rx) = route_world(account, &["36307"]);
    chapter_drain(&mut rx);
    assert!(
        route_entry(&world, account, OTHER_JOB_QUEST).is_none(),
        "非本职业路线的阻塞章节不该出现在日志里"
    );
}

#[test]
fn an_unknown_block_tag_stays_honest_and_executable_quests_are_never_blocked() {
    let account = "route-tag-text";
    let (world, mut rx) = route_world(account, &[]);
    chapter_drain(&mut rx);

    // 没见过的标签：说"还有环节没复刻"，把代码留作诊断，不冒充剧情。
    let mystery = QuestSpec {
        executable: Some(false),
        blocked_by: vec!["brand-new-tag".to_owned()],
        ..QuestSpec::default()
    };
    let text = world
        .quest_blocked_reason(&mystery)
        .expect("未知标签也要给出解释");
    assert!(text.starts_with("尚未開放："), "{text}");
    assert!(text.contains("brand-new-tag"), "未知标签保留为诊断信息：{text}");
    assert!(text.contains("尚未復刻的環節"), "{text}");

    // 可执行任务永远不会被判成 blocked：那会把"能接"变成"不能接"。
    let runnable = QuestSpec {
        executable: Some(true),
        blocked_by: vec!["script-scene".to_owned()],
        ..QuestSpec::default()
    };
    assert!(world.quest_blocked_reason(&runnable).is_none());
}

/// 真装配数据里某一条任务的规格，与 `chapter_actual_world` 反序列化的是同一份
/// `shared/gameplay.json`。
fn route_spec<'a>(world: &'a World, quest_id: &str) -> &'a QuestSpec {
    world
        .gameplay
        .quests
        .iter()
        .find(|spec| spec.quest_id == quest_id)
        .unwrap_or_else(|| panic!("装配数据里必须有 {quest_id}"))
}

#[test]
fn a_script_counter_is_named_from_the_source_and_still_opens_nothing() {
    // 计数器语义已核定（`exVariable` 是名字、`value` 是目标数，见 36317 交付
    // 记录 §2），所以能说出"这一步是什么"的理由就该说出来；说不出来的时候
    // 保持原文案，不发明类别。
    let account = "route-counter-kind";
    let (world, mut rx) = route_world(account, &ROUTE_PREV);
    chapter_drain(&mut rx);

    assert_eq!(
        world.quest_blocked_reason(route_spec(&world, ROUTE_STOP)),
        Some("尚未開放：原版此步驟由劇情場景推進，腳本未隨源提供".to_owned()),
        "36317 的 dummy 是剧情场景的布尔位"
    );

    // `talk` 是对话步骤：36350 自己的需求串就是「和#questorder1##r#p2132001##k對話」。
    for quest_id in ["36329", "36333", "36350"] {
        let reason = world
            .quest_blocked_reason(route_spec(&world, quest_id))
            .unwrap_or_else(|| panic!("{quest_id} 必须给出停止理由"));
        assert!(reason.contains("對話腳本"), "{quest_id}: {reason}");
    }

    // 说不出种类的仍用原文案，只把源里的 token 当括号内的诊断后缀，不当句子。
    for (quest_id, kind) in [("36328", "kill"), ("36365", "dir3")] {
        let reason = world
            .quest_blocked_reason(route_spec(&world, quest_id))
            .unwrap_or_else(|| panic!("{quest_id} 必须给出停止理由"));
        assert!(reason.contains("原版腳本計數器尚未復刻"), "{quest_id}: {reason}");
        assert!(reason.contains(&format!("（{kind}）")), "{quest_id}: {reason}");
    }

    // 源只写了数量、没写名字（`1401` 一族）时不许编一个种类出来。
    let unnamed = QuestSpec {
        executable: Some(false),
        blocked_by: vec!["script-counter".to_owned()],
        source_infoex: vec![QuestInfoex {
            value: "3".to_owned(),
            ex_variable: String::new(),
        }],
        ..QuestSpec::default()
    };
    assert_eq!(
        world.quest_blocked_reason(&unnamed),
        Some("尚未開放：原版腳本計數器尚未復刻".to_owned()),
        "没有名字可用时保持原文案"
    );

    // 命名种类只是把话说准，一条都不许因此放行：这十条的完成条件仍然绑在
    // 未复刻的脚本计数器上。
    for quest_id in [
        "1401", "1403", "1404", "1405", "36317", "36328", "36329", "36333", "36350", "36365",
    ] {
        let spec = route_spec(&world, quest_id);
        assert!(!spec.executable(), "{quest_id} 不得因命名种类而被放行");
        assert!(
            spec.blocked_by.iter().any(|code| code == "script-counter"),
            "{quest_id} 必须仍带着 script-counter 边界"
        );
    }
}
