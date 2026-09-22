/// 传送类 NPC（計程車等）的源脚本验收（2026-09-17）。
///
/// 经 `include!` 进入 `world_tests.rs` 的 `mod tests`；本文件助手一律 `npt_` 前缀
/// （`include!` 把全部验收塞进同一模块，裸名会与既有验收撞名）。
///
/// 要修的病：**点了計程車，它说一句话，然后什么都不发生。**
///
/// 根因不在传送逻辑——`DialogueView::Warp`、`warp_player()`、客户端的 `message.warp`
/// 分支早就在，`DialogueNode::Act{kind:"warp"}` 也早就在。缺的是**内容**：
/// `scripts/generate_tms273_gameplay.py` 从设计上不转换 `info/script`（该文件的
/// `incomplete` 段明写 "NPC dialogue/script references are not converted"），
/// 于是即使源脚本实体就在包里（`script/npc/victoria_taxi.js`），模板里的 `script`
/// 仍然是 null。整张 198 图里**没有任何一条** warp 动作（实测 0 条）。
///
/// 现在 `shared/npc-scripts.json` 把源脚本按可证明的模式转成同一套 DSL，服务端在
/// **与 `template.script` 同一个槽位**消费它。本文件钉住四件事：
///
/// * 表确实被接进了那个槽位，且**只补空槽**（不遮蔽任何已authored的模板 DSL）；
/// * 菜单只列**已装配**的目的地，且**隐藏玩家脚下那张图**（源里的
///   `if (taxiMaps[i] != map.getId())`）；
/// * 确认「是」**真的换图**、确认「否」**不换图**；
/// * 产物里**每一个**传送目标都是服务端真正加载过的地图（`warp_player` 对目录外的
///   目标返回 `false`，玩家会收到一句与真实原因无关的「傳送未能保存」）。

/// 夹具地图 id：源計程車的目的地之一。把夹具图设成它，玩家一开局就站在計程車的
/// 服务范围内，且「隐藏当前地图」这条规则能被真实触发。
const NPT_TAXI_MAP: &str = "100000000";
/// 源計程車的另外三个已装配目的地。
const NPT_OTHER_TOWNS: [&str; 3] = ["101000000", "102000000", "104000000"];
/// 計程車模板 id（`維多利亞計程車`）。
const NPT_TAXI: &str = "1012000";
/// 夹具玩家 id。
///
/// **必须**复用 `npc_click_acceptance.rs` 的 `NPD_PLAYER`：那边的 `npd_click`/`npd_step`
/// 把玩家 id 写死成它，自己另起一个 id 会让点击落在「没加入的玩家」上——
/// `handle_npc_talk` 对未知玩家直接 `return`，表现为一片空白而不是失败。
const NPT_PLAYER: &str = NPD_PLAYER;

/// 真实源脚本表（`shared/npc-scripts.json`）。
///
/// 直接读发布内容：这里要验的是「服务端跑的是不是源脚本转出来的那一份」，自造一份
/// 等于自证。
fn npt_shipped_scripts() -> BTreeMap<String, npc::DialogueScript> {
    #[derive(serde::Deserialize)]
    struct NpcScriptsFile {
        npcs: BTreeMap<String, npc::DialogueScript>,
    }
    let shared = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared");
    serde_json::from_str::<NpcScriptsFile>(
        &std::fs::read_to_string(shared.join("npc-scripts.json"))
            .expect("shared/npc-scripts.json 必须存在（scripts/export_tms273_npc_scripts.cjs）"),
    )
    .expect("shared/npc-scripts.json 必须能解析")
    .npcs
}

/// 真实内容 + 把每个模板都装到 `NPT_TAXI_MAP` 上的合成出生点。
///
/// 用合成出生点而不是真实出生表：真实出生表会把計程車撒在 4 张图上，而玩家只能和
/// 自己所在那张图的 NPC 对话；这里要验的是菜单与换图，所以把所有人放在同一张图上。
/// （真实出生位置是「4 张图」这件事由 `check_tms273_npc_scripts.cjs` 从内容侧核。）
fn npt_gameplay() -> Gameplay {
    let shared = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared");
    let mut gameplay =
        Gameplay::load(&shared.join("gameplay.json")).expect("shared/gameplay.json must boot");
    gameplay.npc_spawns = gameplay
        .npcs
        .iter()
        .map(|template| NpcSpawn {
            id: format!("npt-{}", template.template_id),
            template_id: template.template_id.clone(),
            x: 100.0,
            y: 0.0,
            foothold_id: Some(1),
            map_id: NPT_TAXI_MAP.into(),
            facing: -1,
        })
        .collect();
    gameplay
}

/// 一份以 `id` 为名、几何照抄夹具图的合成地图。
fn npt_map(id: &str) -> Map {
    Map { id: id.to_owned(), ..map() }
}

/// 夹具世界：玩家与全部 NPC 都站在 `NPT_TAXI_MAP`，邻居三张目的地图也装进 `maps`
/// ——`warp_player` 只认 `self.maps` 里的目标，不装就永远换不过去。
fn npt_world() -> World {
    let mut world = World::build(npt_map(NPT_TAXI_MAP), 600, npt_gameplay(), None)
        .unwrap()
        .with_npc_dialogue(npd_shipped_dialogue())
        .with_npc_scripts(npt_shipped_scripts());
    for town in NPT_OTHER_TOWNS {
        world.maps.insert(town.to_owned(), npt_map(town));
    }
    world
        .spawn_configured_npcs()
        .expect("the synthetic npc spawns must attach");
    assert_eq!(world.map.id, NPT_TAXI_MAP);
    world
}

/// 带选择项地推进一步（菜单用 `select` + `selection`）。
fn npt_select(
    world: &mut World,
    rx: &mut mpsc::Receiver<String>,
    npc_id: &str,
    selection: u32,
) -> Vec<serde_json::Value> {
    let request_id = format!("npt-sel-{selection}-{}", world.tick);
    world.handle_npc_talk(
        NPT_PLAYER.into(),
        request_id,
        npc_id.into(),
        Some("select"),
        Some(selection),
    );
    npd_drain(rx)
}

/// 本次请求产出里的菜单项 `(index, text)` 列表。
fn npt_options(messages: &[serde_json::Value]) -> Vec<(u64, String)> {
    messages
        .iter()
        .find(|message| message["type"] == "npcResult" && message["dialog"].is_object())
        .and_then(|message| message["dialog"]["options"].as_array())
        .map(|options| {
            options
                .iter()
                .map(|option| {
                    (
                        option["index"].as_u64().expect("an option always carries an index"),
                        option["text"].as_str().unwrap_or_default().to_owned(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

fn npt_dialog_kind(messages: &[serde_json::Value]) -> String {
    messages
        .iter()
        .find(|message| message["type"] == "npcResult" && message["dialog"].is_object())
        .and_then(|message| message["dialog"]["kind"].as_str())
        .unwrap_or_default()
        .to_owned()
}

fn npt_warp_target(messages: &[serde_json::Value]) -> Option<String> {
    messages
        .iter()
        .find(|message| message["type"] == "npcResult" && message["warp"].is_object())
        .and_then(|message| message["warp"]["mapId"].as_str())
        .map(str::to_owned)
}

/// 打开計程車对话并走到菜单，返回 `(npc 实例 id, 菜单消息)`。
fn npt_open_taxi_menu(world: &mut World, rx: &mut mpsc::Receiver<String>) -> (String, Vec<serde_json::Value>) {
    let npc_id = format!("npt-{NPT_TAXI}");
    let greeting = npd_click(world, rx, &npc_id);
    assert_eq!(
        npt_dialog_kind(&greeting), "next",
        "計程車先说出场白，给「下一页」",
    );
    let menu = npd_step(world, rx, &npc_id, "next");
    (npc_id, menu)
}

#[test]
fn source_scripts_fill_only_empty_slots() {
    // 接线位置：源脚本表进的是 `World::npc_scripts`，而 `handle_npc_talk` 用
    // `template.script.or(source_script)` 取用 —— 先证明这个槽位真的被填上了。
    let world = npt_world();
    let scripts = &world.npc_scripts;
    assert!(
        scripts.contains_key(NPT_TAXI),
        "計程車的源脚本没有进 World：它仍然只会说一句话然后什么都不发生",
    );
    assert_eq!(
        scripts[NPT_TAXI].start, "greet",
        "計程車脚本的入口节点应当来自源脚本的出场白",
    );

    // 只补空槽：若某个模板已经带着 authoured 的 DSL，源脚本表里就**不该**再出现它
    // ——否则那份 DSL 会被静默忽略，而没人会注意到。
    for (template_id, _) in scripts.iter() {
        let template = npt_gameplay()
            .npcs
            .into_iter()
            .find(|template| &template.template_id == template_id)
            .expect("源脚本表里的 id 必须都是已摆放的模板");
        assert!(
            template.script.is_none(),
            "npc {template_id} 既带了 authoured DSL 又在源脚本表里：优先级会静默吃掉一边",
        );
    }
}

#[test]
fn taxi_menu_lists_rendered_towns_and_hides_the_current_one() {
    let mut world = npt_world();
    let mut rx = join_test_player(&mut world, NPT_PLAYER);
    while rx.try_recv().is_ok() {}
    let (npc_id, menu) = npt_open_taxi_menu(&mut world, &mut rx);

    assert_eq!(npt_dialog_kind(&menu), "simple", "菜单必须是可选列表");
    let options = npt_options(&menu);
    assert_eq!(
        options.len(), 3,
        "站在弓箭手村时計程車只能列出另外三个已装配村庄，实际：{options:?}",
    );
    let texts: Vec<&str> = options.iter().map(|(_, text)| text.as_str()).collect();
    assert_eq!(texts, vec!["魔法森林", "勇士之村", "維多利亞港"]);
    assert!(
        !texts.contains(&"弓箭手村"),
        "計程車不应当把玩家脚下这张图列成目的地（源里的 `taxiMaps[i] != map.getId()`）",
    );
    // 源用数组下标做标签，被过滤掉的 `103000000 墮落城市`（未装配）留下编号空档。
    assert_eq!(
        options.iter().map(|(index, _)| *index).collect::<Vec<_>>(),
        vec![1, 2, 4],
        "菜单下标应当沿用源数组下标（含被排除目的地的空档）",
    );
    // 被隐藏的那一项连「按 index 直接选」也要被拦住 —— 拦法是
    // `npc::advance` 返回 Err（"npc dialogue selection is not offered"），
    // `dialogue.rs` 把它翻成 `npc_step_invalid` 的 rejected 回执。
    let hidden = npt_select(&mut world, &mut rx, &npc_id, 0);
    assert_eq!(
        npd_outcome(&hidden).as_deref(),
        Some("rejected:npc_step_invalid"),
        "按 index 选中被隐藏的选项必须被拒绝，否则旧客户端能选到源里从未提供的目的地；实际：{:?}",
        npd_outcome(&hidden),
    );
    assert_eq!(
        npt_warp_target(&hidden), None,
        "被拒绝的那一次绝不能顺手把玩家传走",
    );
    assert_eq!(
        world.players[NPT_PLAYER].map_id, NPT_TAXI_MAP,
        "选了「弓箭手村」（= 玩家当前所在图）应当原地不动",
    );
}

#[test]
fn taxi_confirm_yes_warps_and_no_stays() {
    // 「否」分支：回到源里的拒绝句，且**不换图**。
    let mut world = npt_world();
    let mut rx = join_test_player(&mut world, NPT_PLAYER);
    while rx.try_recv().is_ok() {}
    let (npc_id, _menu) = npt_open_taxi_menu(&mut world, &mut rx);
    let confirm = npt_select(&mut world, &mut rx, &npc_id, 1);
    assert_eq!(npt_dialog_kind(&confirm), "yesNo", "选完目的地要问一次确认");
    assert!(
        npd_dialog_text(&confirm).contains("魔法森林"),
        "确认句里必须点名目的地（源里是把 `#m<id>#` 拼进句子中间的），实际：{}",
        npd_dialog_text(&confirm),
    );
    let declined = npd_step(&mut world, &mut rx, &npc_id, "no");
    assert_eq!(npt_warp_target(&declined), None, "选了「否」不该换图");
    assert_eq!(world.players[NPT_PLAYER].map_id, NPT_TAXI_MAP);

    // 「是」分支：真的换图 —— 这才是「点了計程車什么都不发生」的反面。
    let mut world = npt_world();
    let mut rx = join_test_player(&mut world, NPT_PLAYER);
    while rx.try_recv().is_ok() {}
    let (npc_id, _menu) = npt_open_taxi_menu(&mut world, &mut rx);
    npt_select(&mut world, &mut rx, &npc_id, 1);
    let warped = npd_step(&mut world, &mut rx, &npc_id, "yes");
    assert_eq!(
        npt_warp_target(&warped).as_deref(), Some("101000000"),
        "确认「是」必须换到源里那个目的地",
    );
    assert_eq!(
        world.players[NPT_PLAYER].map_id, "101000000",
        "玩家必须真的站到目的地图上",
    );
    // 换图落点必须在图的范围内（否则玩家一睁眼就在界外）。
    let landed = &world.maps[&world.players[NPT_PLAYER].map_id];
    let player = &world.players[NPT_PLAYER];
    assert!(
        (landed.bounds.x_min..=landed.bounds.x_max).contains(&player.state.x)
            && (landed.bounds.y_min..=landed.bounds.y_max).contains(&player.state.y),
        "换图落点 {} {} 不在 {} 的范围内",
        player.state.x, player.state.y, landed.id,
    );
}

#[test]
fn every_shipped_warp_target_is_a_loaded_map() {
    // 主干不变式：产物里任何地图引用都必须在**服务端真正加载的目录**里。
    // `portals.rs::warp_player` 对目录外的目标返回 false ⇒ 玩家会收到
    // 「傳送未能保存，請稍後重試。」——一句和真实原因（这张图没装配）无关的话。
    let catalog: MapCatalog =
        serde_json::from_str(include_str!("../../shared/maps.json")).expect("maps.json");
    let loaded: BTreeSet<&str> = catalog.maps.iter().map(|map| map.id.as_str()).collect();
    // 2026-09-21 勇士部落 13 图（火焰之地 4 张 `102030100/200/300/400` +
    // 遺跡發掘地 9 张 `102040100/200/300/301/400/401/500/501/600`）把
    // `102030000/east00` 与 `102040000/east00` 两条死门的目标簇装进目录，
    // 目录规模 198 → 211。
    assert_eq!(loaded.len(), 211, "目录规模变了，先确认这是有意为之");

    let scripts = npt_shipped_scripts();
    let mut checked = 0usize;
    let mut warps = 0usize;
    for (template_id, script) in &scripts {
        for (node_id, node) in &script.nodes {
            let references = match node {
                npc::DialogueNode::Act(act) => act.map_id.iter().cloned().collect::<Vec<_>>(),
                npc::DialogueNode::Menu(menu) => menu
                    .options
                    .iter()
                    .filter_map(|option| option.cond.as_ref()?.map_is_not.clone())
                    .collect(),
                _ => Vec::new(),
            };
            for map_id in references {
                checked += 1;
                assert!(
                    loaded.contains(map_id.as_str()),
                    "npc {template_id} 的节点 {node_id} 引用了 {map_id}：它没装配，玩家点下去只会收到一句「傳送未能保存」",
                );
            }
            if let npc::DialogueNode::Act(act) = node {
                assert_eq!(act.kind, "warp", "npc {template_id} 的节点 {node_id} 不是换图动作");
                warps += 1;
            }
        }
    }
    assert!(warps > 0, "源脚本表里一条换图动作都没有：根因并没有被修上");
    assert!(checked > warps, "菜单里的地图条件也应当被检查到（只查了 act 说明漏了一条路径）");
}

#[test]
fn unconverted_teleport_npcs_never_warp() {
    // 边界：`2010011 蕾雅`（`guild_move`）与 `9071003 怪物公園公車`（`mParkShuttle`）
    // 的源脚本实体在包里，但它们的**目的地没装配**（200000301 英雄公殿 / 951000000 怪物公園），
    // 所以导出拒绝转换并写明原因。这里钉住「拒绝」不是一句空话：这两个 NPC 绝不能
    // 凭空把人传到别的地方去。
    let mut world = npt_world();
    let mut rx = join_test_player(&mut world, NPT_PLAYER);
    while rx.try_recv().is_ok() {}
    for template_id in ["2010011", "9071003"] {
        assert!(
            !world.npc_scripts.contains_key(template_id),
            "npc {template_id} 的目的地没有装配，不该被转换出来",
        );
        let npc_id = format!("npt-{template_id}");
        assert!(
            world.npcs.contains_key(&npc_id),
            "夹具里没有 npc {npc_id}：这条断言会变成空转（点谁都只会回 npc_unknown）",
        );
        let mut messages = npd_click(&mut world, &mut rx, &npc_id);
        // 一路把对话推完（不管它有几页），绝不应当出现 warp。
        for _ in 0..6 {
            assert_eq!(npt_warp_target(&messages), None, "npc {template_id} 凭空换图了");
            if npt_dialog_kind(&messages) != "next" {
                break;
            }
            messages = npd_step(&mut world, &mut rx, &npc_id, "next");
        }
        assert_eq!(world.players[NPT_PLAYER].map_id, NPT_TAXI_MAP);
    }
}
