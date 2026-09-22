/// 地图 NPC 点击对话（阶段一 2026-09-17 / 阶段二 2026-09-17）验收。
///
/// 经 `include!` 进入 `world_tests.rs` 的 `mod tests`；本文件助手一律 `npd_`
/// 前缀（`include!` 把全部验收塞进同一模块，裸名会与既有验收撞名）。
///
/// 阶段一解决的是「点了没反应」：真正的缺口不在客户端命中测试（它本来就能点到
/// 全部模板），而在服务端——已摆放的 265 个模板里只有 30 个带 `script`，其余全部
/// 落在「无脚本」分支，那一条此前只回一个 `ended`，客户端把窗口关掉。
///
/// 阶段二解决的是「说什么」：源里真的没有说话脚本（`Npc.wz` 的 `info/script` 声明了
/// 121 个脚本名，只有 8 个能在随附服务端脚本里找到实体），但**源里有台词**——
/// `Npc.wz/<id>.img/info/speak` 声明这个 NPC 说哪几句、按什么顺序，
/// `String/Npc.json` 给出文本。这一层被导出成 `shared/npc-dialogue.json`
/// （`scripts/export_tms273_npc_dialogue.cjs`），由服务端在点击时逐页说出来。
///
/// 覆盖：
/// * **内容背书的全量不变式**——对真实 `shared/gameplay.json` 的每一个模板点一次，
///   断言绝不出现「什么都没回」或「只回 ended」；
/// * **台词必须来自源**——无脚本、又不被职能分发的模板，第一页必须**逐字**等于
///   `shared/npc-dialogue.json` 里该模板的第 1 句；
/// * **占位不越界（双向）**——有源台词的模板绝不许回占位；占位只允许落在
///   `info/speak` 与 `String` 表都没有台词的模板上；
/// * **台词 → 任务菜单**——有任务可做的 NPC 先逐页把源台词说完，菜单在台词之后
///   出现，不会抢在前面；
/// * 台词页推进与关闭的边界（末页给确认、中途关闭不再吐台词）；
/// * 节点编解码与页面 `kind` 规则（纯函数）。
///
/// 注意：`std::path::Path` 已由 `content_boot_acceptance.rs` 在同一模块里 `use`
/// 过，这里只能走全路径——`include!` 把全部验收塞进同一个模块。

/// 夹具图 id。合成出生点全部落在这张图上，玩家的出生图也是它。
const NPD_TEST_MAP: &str = "test";
/// 夹具玩家 id。
const NPD_PLAYER: &str = "npd-player";

/// 真实台词表（`shared/npc-dialogue.json`）。
///
/// 与 `gameplay.json` 一样直接读发布内容：这里要验的是「服务端说的和源里写的是不是
/// 同一句」，所以不能自造一份台词表来自证。
fn npd_shipped_dialogue() -> BTreeMap<String, npc::NpcDialogue> {
    #[derive(serde::Deserialize)]
    struct NpcDialogueFile {
        npcs: BTreeMap<String, npc::NpcDialogue>,
    }
    let shared = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared");
    serde_json::from_str::<NpcDialogueFile>(
        &std::fs::read_to_string(shared.join("npc-dialogue.json"))
            .expect("shared/npc-dialogue.json 必须存在（scripts/export_tms273_npc_dialogue.cjs）"),
    )
    .expect("shared/npc-dialogue.json 必须能解析")
    .npcs
}

/// 真实内容 + 把每个模板都装到测试图上的合成出生点。
///
/// 用合成出生点而不是真实出生表：这里要验的是**分发**（谁被谁接走），真实出生表
/// 会把 NPC 撒在 198 张图上，而玩家只能和自己所在那张图的 NPC 对话。
fn npd_shipped_gameplay() -> Gameplay {
    let shared = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared");
    let mut gameplay =
        Gameplay::load(&shared.join("gameplay.json")).expect("shared/gameplay.json must boot");
    gameplay.npc_spawns = gameplay
        .npcs
        .iter()
        .map(|template| NpcSpawn {
            id: format!("npd-{}", template.template_id),
            template_id: template.template_id.clone(),
            x: 100.0,
            y: 0.0,
            foothold_id: Some(1),
            map_id: NPD_TEST_MAP.into(),
            facing: -1,
        })
        .collect();
    gameplay
}

/// 夹具世界：没有 Store（全部规则都在内存里，本模块不碰持久化），注入真实台词表。
fn npd_world(gameplay: Gameplay) -> World {
    npd_world_with(gameplay, npd_shipped_dialogue())
}

fn npd_world_with(gameplay: Gameplay, dialogue: BTreeMap<String, npc::NpcDialogue>) -> World {
    let mut world = World::build(map(), 600, gameplay, None)
        .unwrap()
        .with_npc_dialogue(dialogue);
    world
        .spawn_configured_npcs()
        .expect("the synthetic npc spawns must attach");
    assert_eq!(world.map.id, NPD_TEST_MAP);
    world
}

/// 点一次 NPC（发 `start`）并取回这次请求产生的全部消息。
fn npd_click(
    world: &mut World,
    rx: &mut mpsc::Receiver<String>,
    npc_id: &str,
) -> Vec<serde_json::Value> {
    world.handle_npc_talk(
        NPD_PLAYER.into(),
        format!("npd-req-{npc_id}"),
        npc_id.into(),
        Some("start"),
        None,
    );
    npd_drain(rx)
}

/// 推进一次对话（`next` / `end`）并取回消息。
fn npd_step(
    world: &mut World,
    rx: &mut mpsc::Receiver<String>,
    npc_id: &str,
    step: &str,
) -> Vec<serde_json::Value> {
    let request_id = format!("npd-req-{npc_id}-{step}-{}", world.tick);
    world.handle_npc_talk(NPD_PLAYER.into(), request_id, npc_id.into(), Some(step), None);
    npd_drain(rx)
}

fn npd_drain(rx: &mut mpsc::Receiver<String>) -> Vec<serde_json::Value> {
    std::iter::from_fn(|| rx.try_recv().ok())
        .map(|message| serde_json::from_str(&message).expect("server messages are JSON"))
        .collect()
}

/// 本次请求里那一条 `npcResult` 的 `dialog` 文本（没有则空串）。
fn npd_dialog_text(messages: &[serde_json::Value]) -> String {
    messages
        .iter()
        .find(|message| message["type"] == "npcResult" && message["dialog"].is_object())
        .and_then(|message| message["dialog"]["text"].as_str())
        .unwrap_or_default()
        .to_owned()
}

/// 本次请求里那一条 `npcResult` 的页面类型（`next` / `ok` / `simple`…）。
fn npd_dialog_kind(messages: &[serde_json::Value]) -> String {
    messages
        .iter()
        .find(|message| message["type"] == "npcResult" && message["dialog"].is_object())
        .and_then(|message| message["dialog"]["kind"].as_str())
        .unwrap_or_default()
        .to_owned()
}

/// 把一次点击的结果归成玩家能看见的东西。
///
/// `None`＝什么都没回；`Some("ended")`＝只回了一个结束标记，客户端会把窗口关掉，
/// 玩家看到的就是「点了没反应」——阶段一要消灭的正是这两种。
fn npd_outcome(messages: &[serde_json::Value]) -> Option<String> {
    for message in messages {
        match message["type"].as_str() {
            Some("rejected") => {
                return Some(format!(
                    "rejected:{}",
                    message["code"].as_str().unwrap_or_default()
                ))
            }
            Some("npcResult") => {}
            _ => continue,
        }
        if message["dialog"].is_object() {
            return Some(
                if message["dialog"]["source"] == npc::PLACEHOLDER_DIALOGUE {
                    "placeholder"
                } else {
                    "dialog"
                }
                .to_owned(),
            );
        }
        for (key, label) in [
            ("shop", "shop"),
            ("warp", "warp"),
            ("openStorage", "storage"),
            ("openSkills", "skills"),
        ] {
            if message[key] == true || message[key].is_object() {
                return Some(label.to_owned());
            }
        }
        if message["ended"] == true {
            return Some("ended".to_owned());
        }
    }
    None
}

/// 这次对话是否被「职能分发」抢在源台词之前接走。
///
/// 这些分发在 `handle_npc_talk` 里排在源台词分支之前（船务检票/播报、仓库管理员、
/// 法师训练），它们有自己的对白，源台词不参与；判据直接调用服务端那几个判定函数，
/// 免得在测试里另写一份会漂移的名单。
fn npd_bypasses_scriptless_dialogue(
    template: &NpcTemplate,
    npc_id: &str,
    map_id: &str,
) -> bool {
    super::ship::route_index_for_inspector(&template.template_id).is_some()
        || super::ship::route_index_for_announcer(&template.template_id).is_some()
        || template.func.contains(STORAGE_KEEPER_FUNC)
        || is_crossroad_advance_npc(map_id, npc_id, &template.template_id)
}

#[test]
fn every_placed_npc_template_answers_a_click_with_source_dialogue() {
    let templates = npd_shipped_gameplay().npcs;
    let dialogue = npd_shipped_dialogue();
    let mut world = npd_world_with(npd_shipped_gameplay(), dialogue.clone());
    let mut rx = join_test_player(&mut world, NPD_PLAYER);
    while rx.try_recv().is_ok() {}

    let mut placeholders = 0usize;
    let mut scripted = 0usize;
    let mut spoke = 0usize;
    let mut unavailable: Vec<String> = Vec::new();
    for template in &templates {
        let npc_id = format!("npd-{}", template.template_id);
        let messages = npd_click(&mut world, &mut rx, &npc_id);
        let outcome = npd_outcome(&messages).unwrap_or_else(|| {
            panic!(
                "npc {} ({}) 点击后服务端什么都没回：玩家看到「点了没反应」",
                template.template_id, template.name
            )
        });
        assert_ne!(
            outcome, "ended",
            "npc {} ({}) 点击后只回了一个 ended：客户端会把窗口关掉，玩家看不到任何响应",
            template.template_id, template.name
        );
        let lines = dialogue
            .get(&template.template_id)
            .map(|entry| entry.lines.clone())
            .unwrap_or_default();
        assert_eq!(
            lines.is_empty(),
            !dialogue.contains_key(&template.template_id),
            "npc {} 的台词条目不为空就必须真的在表里（导出不允许补空条目）",
            template.template_id
        );
        if outcome == "rejected:npc_unavailable" {
            unavailable.push(template.template_id.clone());
            continue;
        }
        assert!(
            !outcome.starts_with("rejected:"),
            "npc {} ({}) 点击被拒绝（{}），但点击不应该产生任何其他拒绝",
            template.template_id,
            template.name,
            outcome
        );
        if outcome == "placeholder" {
            assert!(
                template.script.is_none(),
                "带原版脚本的 npc {} ({}) 被回成了占位：真实内容被占位顶掉了",
                template.template_id,
                template.name
            );
            // 阶段二的核心不变式：占位只允许落在**源里就没有台词**的模板上。
            assert!(
                lines.is_empty(),
                "npc {} ({}) 在 shared/npc-dialogue.json 里有 {} 句源台词，却被回成了占位：\
                 台词表被绕过了",
                template.template_id,
                template.name,
                lines.len()
            );
            placeholders += 1;
        }
        if template.script.is_none()
            && !lines.is_empty()
            && !npd_bypasses_scriptless_dialogue(template, &npc_id, NPD_TEST_MAP)
        {
            // 无脚本、有源台词、没被职能接走：第一页必须**逐字**是源里的第一句。
            // 有任务可做时也一样——菜单排在台词之后（见下一条用例）。
            assert_eq!(
                npd_dialog_text(&messages),
                lines[0],
                "npc {} ({}) 的第一页不是源台词的第一句",
                template.template_id,
                template.name
            );
            spoke += 1;
        }
        if template.script.is_some() {
            scripted += 1;
        }
    }

    // 反向断言：占位分支必须真的在服务「源里没有说话内容」的那批模板，否则它已经
    // 是死代码。
    assert!(
        placeholders > 0,
        "265 个模板没有一个落到占位分支：占位分支已成死代码，应当删除"
    );
    // 反向断言：源台词路径必须真的在服务绝大多数模板——这一条同时钉住「导出脚本没
    // 跑/表被读空」这类整体失效（那时 spoke 会塌成 0，而占位断言仍然全绿）。
    assert!(
        spoke > 0,
        "没有任何模板说出源台词：shared/npc-dialogue.json 没被读到或台词全部落空"
    );
    assert!(
        spoke + placeholders + scripted <= templates.len(),
        "统计口径出错：三类之和不能超过模板总数"
    );
    // 反向断言：占位没有吃掉带脚本的模板（否则上面的 per-template 断言会先失败，
    // 这一条兜住「脚本集体消失」这种更早的失效）。
    assert!(
        scripted > 0,
        "没有任何模板带原版脚本：脚本路径已成死代码，占位断言失去意义"
    );
    assert!(
        placeholders < templates.len(),
        "全部模板都落到占位分支：脚本/职能分发整体失效"
    );

    // 唯一允许「用一句说明代替对话」的是任务阶段隐藏的 NPC。名单写死：这条豁免
    // 一旦放宽，静默缺陷就会藏在里面。
    let mut expected = vec![
        QUEST_HIDDEN_NPC_2.to_owned(),
        QUEST_HIDDEN_NPC_3.to_owned(),
        QUEST_OLIVIA_NPC.to_owned(),
    ];
    expected.sort();
    unavailable.sort();
    assert_eq!(
        unavailable, expected,
        "只有任务阶段隐藏的 NPC 允许以「当前无法对话」代替对话"
    );
    // 这三条常量必须真的是随内容发布的模板，否则上面的名单等于空豁免。
    for id in &expected {
        assert!(
            templates.iter().any(|template| &template.template_id == id),
            "隐藏 NPC {id} 不在已摆放的模板里：豁免名单失效"
        );
    }
}

/// 阶段二的主链路：**先说完源台词，再给任务选项**。
///
/// 这一条对真实内容断言，所以它同时钉住三件事：导出表里确实有成批「有台词 + 有任务」
/// 的 NPC、台词页确实排在菜单前面、菜单确实在最后一句之后才出现。
#[test]
fn quest_npc_speaks_source_lines_before_the_menu() {
    let dialogue = npd_shipped_dialogue();
    let mut world = npd_world_with(npd_shipped_gameplay(), dialogue.clone());
    let mut rx = join_test_player(&mut world, NPD_PLAYER);
    while rx.try_recv().is_ok() {}

    // 真实内容里同时「无脚本 + 至少两句源台词 + 有任务可做」的模板。
    //
    // 「有任务可做」是**当前玩家状态**下算出来的（`quest_menu_choices` 要过等级、
    // 职业、前置与已完成判定），而夹具玩家是 1 级新手，所以这里只要求「至少有一个」
    // 真实实例被覆盖：这一条要钉的是「台词排在菜单前面」这个顺序，不是候选数量。
    // 无脚本 + 有台词 + 在任务表里有登记（与玩家状态无关）的模板实测有 26 个。
    let candidates: Vec<NpcTemplate> = world
        .gameplay
        .npcs
        .iter()
        .filter(|template| {
            template.script.is_none()
                && dialogue
                    .get(&template.template_id)
                    .is_some_and(|entry| entry.lines.len() >= 2)
                && !world
                    .quest_menu_choices(NPD_PLAYER, &template.template_id)
                    .is_empty()
                && !npd_bypasses_scriptless_dialogue(
                    template,
                    &format!("npd-{}", template.template_id),
                    NPD_TEST_MAP,
                )
        })
        .cloned()
        .collect();
    assert!(
        !candidates.is_empty(),
        "内容里找不到任何「有源台词又能给任务」的 NPC：台词→菜单这条链路没有被真实内容覆盖"
    );

    let template = candidates
        .iter()
        .max_by_key(|template| dialogue[&template.template_id].lines.len())
        .unwrap();
    let lines = dialogue[&template.template_id].lines.clone();
    let npc_id = format!("npd-{}", template.template_id);

    let first = npd_click(&mut world, &mut rx, &npc_id);
    assert_eq!(
        npd_dialog_text(&first),
        lines[0],
        "npc {} ({}) 应当先说出源台词的第一句",
        template.template_id,
        template.name
    );
    assert_eq!(
        npd_dialog_kind(&first),
        "next",
        "台词后面还挂着任务菜单，所以第一页必须是「下一页」而不是确认"
    );
    let result = first
        .iter()
        .find(|message| message["type"] == "npcResult")
        .unwrap();
    assert!(
        result["dialog"]["source"].is_null(),
        "源台词是 NPC 本人的话，不许带占位标记"
    );

    // 一路点下去：每一页都必须是源台词，菜单只能出现在台词播完之后。
    let mut index = 1usize;
    loop {
        let messages = npd_step(&mut world, &mut rx, &npc_id, "next");
        let result = messages
            .iter()
            .find(|message| message["type"] == "npcResult")
            .cloned()
            .expect("推进台词必须回 npcResult");
        let options = result["dialog"]["options"]
            .as_array()
            .map(|options| options.len())
            .unwrap_or(0);
        if options > 0 {
            break;
        }
        assert!(
            index < lines.len(),
            "npc {} ({}) 的台词已经播完却没有出现任务菜单",
            template.template_id,
            template.name
        );
        assert_eq!(
            npd_dialog_text(&messages),
            lines[index],
            "npc {} ({}) 的第 {} 页不是源台词",
            template.template_id,
            template.name,
            index + 1
        );
        index += 1;
    }
    assert_eq!(
        index,
        lines.len(),
        "任务菜单在源台词播完之前就出现了：{} 句只播了 {} 句",
        lines.len(),
        index
    );
}

/// 台词页的推进边界：末页给确认、再推一次结束、中途关闭不再吐台词。
#[test]
fn source_lines_page_one_at_a_time_and_stop_at_the_end() {
    let mut dialogue = BTreeMap::new();
    dialogue.insert(
        "npd-plain".to_owned(),
        npc::NpcDialogue {
            lines: vec!["第一句".to_owned(), "第二句".to_owned(), "第三句".to_owned()],
        },
    );
    let mut world = npd_world_with(npd_minimal_gameplay(), dialogue);
    let mut rx = join_test_player(&mut world, NPD_PLAYER);
    while rx.try_recv().is_ok() {}

    let first = npd_click(&mut world, &mut rx, "npd-npd-plain");
    assert_eq!(npd_dialog_text(&first), "第一句");
    assert_eq!(npd_dialog_kind(&first), "next");
    assert_eq!(npd_outcome(&first).as_deref(), Some("dialog"));

    let second = npd_step(&mut world, &mut rx, "npd-npd-plain", "next");
    assert_eq!(npd_dialog_text(&second), "第二句");
    assert_eq!(npd_dialog_kind(&second), "next");

    let third = npd_step(&mut world, &mut rx, "npd-npd-plain", "next");
    assert_eq!(npd_dialog_text(&third), "第三句");
    assert_eq!(
        npd_dialog_kind(&third),
        "ok",
        "最后一页必须是「确认」而不是「下一页」"
    );

    let past_end = npd_step(&mut world, &mut rx, "npd-npd-plain", "next");
    assert_eq!(npd_outcome(&past_end).as_deref(), Some("ended"));
    assert!(
        past_end.iter().all(|message| message["dialog"].is_null()),
        "台词播完后再推一次不允许再吐一页台词"
    );

    // 中途关闭（Escape / 关闭按钮）：直接结束，且不再吐台词。
    let reopened = npd_click(&mut world, &mut rx, "npd-npd-plain");
    assert_eq!(npd_dialog_text(&reopened), "第一句", "重开会话应当回到第一句");
    let closing = npd_step(&mut world, &mut rx, "npd-npd-plain", "end");
    assert_eq!(npd_outcome(&closing).as_deref(), Some("ended"));
    assert!(
        closing.iter().all(|message| message["dialog"].is_null()),
        "关闭动作不允许再吐一页台词"
    );
}

/// 一个既不说话也没有任务的模板，只关心它的台词表条目必须真的被用上。
#[test]
fn source_dialogue_is_reachable_without_any_quest() {
    let mut dialogue = BTreeMap::new();
    dialogue.insert(
        "npd-plain".to_owned(),
        npc::NpcDialogue {
            lines: vec!["只有一句话。".to_owned()],
        },
    );
    let mut world = npd_world_with(npd_minimal_gameplay(), dialogue);
    let mut rx = join_test_player(&mut world, NPD_PLAYER);
    while rx.try_recv().is_ok() {}

    let messages = npd_click(&mut world, &mut rx, "npd-npd-plain");
    assert_eq!(npd_outcome(&messages).as_deref(), Some("dialog"));
    assert_eq!(npd_dialog_text(&messages), "只有一句话。");
    // 单句台词没有下一页：直接确认收尾。
    assert_eq!(npd_dialog_kind(&messages), "ok");
    let result = messages
        .iter()
        .find(|message| message["type"] == "npcResult")
        .unwrap();
    assert!(
        result["dialog"]["source"].is_null(),
        "真实台词不允许带占位标记"
    );
}

/// 只带三个模板的最小夹具：无脚本 / 有脚本 / 仓库管理员。真实内容的重分发顺序
/// （船务、呼叫器、任务菜单、转职）在上一组用例里已由全量遍历覆盖，这里固定边界。
fn npd_minimal_gameplay() -> Gameplay {
    let script: npc::DialogueScript = serde_json::from_str(
        r#"{"start":"hi","nodes":{"hi":{"say":{"text":{"zh":"你好。","en":"Hello."},"kind":"ok"}}}}"#,
    )
    .unwrap();
    let template = |template_id: &str, name: &str, func: &str, script: Option<npc::DialogueScript>| {
        NpcTemplate {
            template_id: template_id.into(),
            name: name.into(),
            func: func.into(),
            shop_id: None,
            script,
            stand: Vec::new(),
        }
    };
    let spawn = |template_id: &str, index: f64| NpcSpawn {
        id: format!("npd-{template_id}"),
        template_id: template_id.into(),
        x: 100.0 + index * 40.0,
        y: 0.0,
        foothold_id: Some(1),
        map_id: NPD_TEST_MAP.into(),
        facing: -1,
    };
    Gameplay {
        npcs: vec![
            template("npd-plain", "没有脚本的人", "", None),
            template("npd-scripted", "有脚本的人", "", Some(script)),
            template("npd-keeper", "仓库老板", STORAGE_KEEPER_FUNC, None),
        ],
        npc_spawns: vec![
            spawn("npd-plain", 0.0),
            spawn("npd-scripted", 1.0),
            spawn("npd-keeper", 2.0),
        ],
        ..Gameplay::default()
    }
}

#[test]
fn placeholder_is_the_source_less_fallback_and_never_masks_a_script() {
    let mut world = npd_world(npd_minimal_gameplay());
    let mut rx = join_test_player(&mut world, NPD_PLAYER);
    while rx.try_recv().is_ok() {}

    // 1) 没有脚本、也没进最小夹具的台词表 → 占位：有对白、`ok` 收尾、带来源标记。
    let plain = npd_click(&mut world, &mut rx, "npd-npd-plain");
    assert_eq!(npd_outcome(&plain).as_deref(), Some("placeholder"));
    let result = plain
        .iter()
        .find(|message| message["type"] == "npcResult")
        .expect("a click answers with npcResult");
    assert_eq!(result["dialog"]["kind"], "ok");
    assert_eq!(result["dialog"]["source"], npc::PLACEHOLDER_DIALOGUE);
    assert_eq!(result["dialog"]["text"], "这个 NPC 在原文中没有对话内容。");
    assert_ne!(result["ended"], true);
    assert_eq!(result["name"], "没有脚本的人");

    // 2) 占位只有「开启」这一步有内容：任何后续步骤都必须结束。否则关闭动作会被
    //    当成新一轮开启，窗口关不掉。
    let closing = npd_step(&mut world, &mut rx, "npd-npd-plain", "end");
    assert_eq!(npd_outcome(&closing).as_deref(), Some("ended"));
    assert!(
        closing.iter().all(|message| message["dialog"].is_null()),
        "占位的后续步骤不允许再吐一次占位对白"
    );

    // 3) 有脚本 → 走脚本对白（脚本是权威，源台词表不参与），且不带占位标记。
    let scripted = npd_click(&mut world, &mut rx, "npd-npd-scripted");
    assert_eq!(npd_outcome(&scripted).as_deref(), Some("dialog"));
    let result = scripted
        .iter()
        .find(|message| message["type"] == "npcResult")
        .unwrap();
    assert_eq!(result["dialog"]["text"], "你好。");
    assert!(result["dialog"]["source"].is_null());

    // 4) 仓库管理员走的是职能分发，不是占位。
    let keeper = npd_click(&mut world, &mut rx, "npd-npd-keeper");
    assert_eq!(npd_outcome(&keeper).as_deref(), Some("storage"));
    assert!(keeper
        .iter()
        .all(|message| message["dialog"]["source"].is_null()));

    // 5) 未知 / 别图 NPC 仍然是拒绝，占位兜底不许把它们放行。
    world.handle_npc_talk(
        NPD_PLAYER.into(),
        "npd-req-ghost".into(),
        "npd-does-not-exist".into(),
        Some("start"),
        None,
    );
    let ghost: serde_json::Value =
        serde_json::from_str(&rx.try_recv().expect("unknown npc still answers")).unwrap();
    assert_eq!(ghost["type"], "rejected");
    assert_eq!(ghost["code"], "npc_unknown");
}

#[test]
fn placeholder_view_is_bilingual_and_marked() {
    let zh = npc::placeholder_view("r", "n", "名字", None, "zh");
    assert_eq!(zh["dialog"]["text"], "这个 NPC 在原文中没有对话内容。");
    assert_eq!(zh["dialog"]["source"], npc::PLACEHOLDER_DIALOGUE);
    assert_eq!(zh["dialog"]["kind"], "ok");
    let en = npc::placeholder_view("r", "n", "Name", None, "en");
    assert_eq!(en["dialog"]["text"], "This NPC has no dialogue in the source data.");
    // 未知语言回落到产品默认（简体），与 `LocalizedText::pick` 的口径一致。
    let fr = npc::placeholder_view("r", "n", "Nom", None, "fr");
    assert_eq!(fr["dialog"]["text"], "这个 NPC 在原文中没有对话内容。");
}

/// 台词页节点的编解码与页面类型规则（纯函数，不碰世界）。
#[test]
fn line_node_round_trips_and_only_line_nodes_parse() {
    assert_eq!(npc::line_node(0, false), "npc-line:0");
    assert_eq!(npc::line_node(3, true), "npc-line:3:menu");
    assert_eq!(npc::parse_line_node("npc-line:0"), Some((0, false)));
    assert_eq!(npc::parse_line_node("npc-line:3:menu"), Some((3, true)));
    assert_eq!(npc::parse_line_node("npc-line:12"), Some((12, false)));
    // 别的状态机（脚本节点、法师训练节点、任务菜单缓存）不许被误认成台词页。
    assert_eq!(npc::parse_line_node("__mage_training__"), None);
    assert_eq!(npc::parse_line_node("quest-menu:[]"), None);
    assert_eq!(npc::parse_line_node("npc-line:"), None);
    assert_eq!(npc::parse_line_node("npc-line:x"), None);

    // `more` 决定给「下一页」还是「确认」；两者都不带占位标记。
    let more = npc::line_view("r", "n", "名字", None, "还有下一页", true);
    assert_eq!(more["dialog"]["kind"], "next");
    assert!(more["dialog"]["source"].is_null());
    let last = npc::line_view("r", "n", "名字", None, "最后一句", false);
    assert_eq!(last["dialog"]["kind"], "ok");
    assert!(last["dialog"]["source"].is_null());
}
