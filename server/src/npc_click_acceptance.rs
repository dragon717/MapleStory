/// 地图 NPC 点击对话（阶段一，2026-09-17）验收。
///
/// 经 `include!` 进入 `world_tests.rs` 的 `mod tests`；本文件助手一律 `npd_`
/// 前缀（`include!` 把全部验收塞进同一模块，裸名会与既有验收撞名）。
///
/// 阶段一的目标是「地图上任何 NPC 被点击后玩家都能看到响应」。真正的缺口不在
/// 客户端的命中测试（它本来就能点到全部模板），而在服务端：已摆放的 265 个模板
/// 里只有 30 个带 `script`，其余全部落在「无脚本」分支，那一条此前只回一个
/// `ended`，客户端把窗口关掉，玩家看到的是「点了没反应」。
///
/// 覆盖：
/// * **内容背书的全量不变式**——对真实 `shared/gameplay.json` 的每一个模板点一次，
///   断言绝不出现「只回 ended」的静默结果；
/// * **占位标记不越界**——占位只能落在没有原版脚本的模板上，带脚本的模板不允许
///   被占位顶掉；
/// * 任务阶段隐藏的 NPC 只允许用一句「当前无法对话」说明代替对话（名单写死并断言
///   相等，否则这条豁免会悄悄吞掉真的静默缺陷）；
/// * 最小夹具上的边界：占位只在「开启」这一步有内容（`end` 必须结束，否则窗口关
///   不掉）、未知 NPC 仍被拒、仓库与脚本模板不带占位标记、`en` 走英文文案。
///
/// 注意：`std::path::Path` 已由 `content_boot_acceptance.rs` 在同一模块里 `use`
/// 过，这里只能走全路径——`include!` 把全部验收塞进同一个模块。

/// 夹具图 id。合成出生点全部落在这张图上，玩家的出生图也是它。
const NPD_TEST_MAP: &str = "test";
/// 夹具玩家 id。
const NPD_PLAYER: &str = "npd-player";

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

/// 夹具世界：没有 Store（全部规则都在内存里，本模块不碰持久化）。
fn npd_world(gameplay: Gameplay) -> World {
    let mut world = World::build(map(), 600, gameplay, None).unwrap();
    world
        .spawn_configured_npcs()
        .expect("the synthetic npc spawns must attach");
    assert_eq!(world.map.id, NPD_TEST_MAP);
    world
}

/// 点一次 NPC 并取回这次请求产生的全部消息。
fn npd_click(world: &mut World, rx: &mut mpsc::Receiver<String>, npc_id: &str) -> Vec<serde_json::Value> {
    world.handle_npc_talk(
        NPD_PLAYER.into(),
        format!("npd-req-{npc_id}"),
        npc_id.into(),
        Some("start"),
        None,
    );
    let mut messages = Vec::new();
    while let Ok(message) = rx.try_recv() {
        messages.push(serde_json::from_str(&message).expect("server messages are JSON"));
    }
    messages
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

#[test]
fn every_placed_npc_template_answers_a_click() {
    let templates = npd_shipped_gameplay().npcs;
    let mut world = npd_world(npd_shipped_gameplay());
    let mut rx = join_test_player(&mut world, NPD_PLAYER);
    while rx.try_recv().is_ok() {}

    let mut placeholders = 0usize;
    let mut scripted = 0usize;
    let mut unavailable: Vec<String> = Vec::new();
    for template in &templates {
        let npc_id = format!("npd-{}", template.template_id);
        let outcome = npd_outcome(&npd_click(&mut world, &mut rx, &npc_id)).unwrap_or_else(|| {
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
        if outcome == "rejected:npc_unavailable" {
            unavailable.push(template.template_id.clone());
        } else {
            assert!(
                !outcome.starts_with("rejected:"),
                "npc {} ({}) 点击被拒绝（{}），但点击不应该产生任何其他拒绝",
                template.template_id,
                template.name,
                outcome
            );
        }
        if outcome == "placeholder" {
            assert!(
                template.script.is_none(),
                "带原版脚本的 npc {} ({}) 被回成了占位：真实内容被占位顶掉了",
                template.template_id,
                template.name
            );
            placeholders += 1;
        }
        if template.script.is_some() {
            scripted += 1;
        }
    }

    // 反向断言：占位分支必须真的在服务模板，否则它已经是死代码（内容补齐后应当
    // 连同 `npc::placeholder_view` 与协议里的 `dialog.source` 一起删掉）。
    assert!(
        placeholders > 0,
        "265 个模板没有一个落到占位分支：占位分支已成死代码，应当删除"
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
fn placeholder_is_the_scriptless_fallback_and_never_masks_a_script() {
    let mut world = npd_world(npd_minimal_gameplay());
    let mut rx = join_test_player(&mut world, NPD_PLAYER);
    while rx.try_recv().is_ok() {}

    // 1) 无脚本 → 占位：有对白、`ok` 收尾、带来源标记、不是 ended。
    let plain = npd_click(&mut world, &mut rx, "npd-npd-plain");
    assert_eq!(npd_outcome(&plain).as_deref(), Some("placeholder"));
    let result = plain
        .iter()
        .find(|message| message["type"] == "npcResult")
        .expect("a click answers with npcResult");
    assert_eq!(result["dialog"]["kind"], "ok");
    assert_eq!(result["dialog"]["source"], npc::PLACEHOLDER_DIALOGUE);
    assert_eq!(result["dialog"]["text"], "这个 NPC 的对话内容尚未实装。");
    assert_ne!(result["ended"], true);
    assert_eq!(result["name"], "没有脚本的人");

    // 2) 占位只有「开启」这一步有内容：任何后续步骤都必须结束。否则关闭动作会被
    //    当成新一轮开启，窗口关不掉。
    world.handle_npc_talk(
        NPD_PLAYER.into(),
        "npd-req-plain-end".into(),
        "npd-npd-plain".into(),
        Some("end"),
        None,
    );
    let closing: Vec<serde_json::Value> = std::iter::from_fn(|| rx.try_recv().ok())
        .map(|message| serde_json::from_str(&message).unwrap())
        .collect();
    assert_eq!(npd_outcome(&closing).as_deref(), Some("ended"));
    assert!(
        closing.iter().all(|message| message["dialog"].is_null()),
        "占位的后续步骤不允许再吐一次占位对白"
    );

    // 3) 有脚本 → 真实对白，且不带占位标记（占位不能顶掉已接入的内容）。
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
    assert_eq!(zh["dialog"]["text"], "这个 NPC 的对话内容尚未实装。");
    assert_eq!(zh["dialog"]["source"], npc::PLACEHOLDER_DIALOGUE);
    assert_eq!(zh["dialog"]["kind"], "ok");
    let en = npc::placeholder_view("r", "n", "Name", None, "en");
    assert_eq!(
        en["dialog"]["text"],
        "This NPC's dialogue has not been implemented yet."
    );
    // 未知语言回落到产品默认（简体），与 `LocalizedText::pick` 的口径一致。
    let fr = npc::placeholder_view("r", "n", "Nom", None, "fr");
    assert_eq!(fr["dialog"]["text"], "这个 NPC 的对话内容尚未实装。");
}
