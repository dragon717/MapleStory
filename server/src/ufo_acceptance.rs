/// 危險地帶／洛斯威爾草原／UFO 街验收（2026-09-15，审计 T06 下一片）。经
/// `include!` 进入 `world.rs` 的 `mod tests`，复用 `map()` / `join_test_player`
/// 等既有助手；本文件自己的助手一律加 `ufo_` 前缀（`include!` 把全部验收塞进
/// 同一模块，裸名会与既有验收撞名）。
///
/// 覆盖：呼叫器 NPC 进场（源 `Graph.json` 唯一的进场方式）、死亡角色被拒、
/// 同一模板在别处不构成门、三扇 pt:7 脚本门的 P 级路由、未授权门保持不处置，
/// 以及真实装配数据上的链路口径（本部 → 危險地帶 → 草原Ⅰ~Ⅳ、UFO 进出、
/// 落点贴地、回程图、未装配死端清单的反向断言）。
use super::*;

/// 草原Ⅳ：呼叫器 NPC 所在图（源 WZ 事实，见 `ufo.rs` 模块头）。
const UFO_PAGER_MAP_ID: &str = "221030400";
/// 源授权的进场目标图。
const UFO_ENTRY_MAP_ID: &str = "221030520";
/// 呼叫器模板（`String/Npc.json` 名 `UFO呼叫器`）。
const UFO_PAGER_TEMPLATE_ID: &str = "2052026";

/// 平地房间：一块地板 + `sp` 门。
fn ufo_room(id: &str, spawn_x: f64) -> Map {
    serde_json::from_str(&format!(
        r#"{{"id":"{id}","bounds":{{"xMin":-800,"xMax":800,"yMin":-1200,"yMax":600}},"spawn":{{"x":{spawn_x},"y":0}},"footholds":[{{"id":1,"x1":-800,"y1":100,"x2":800,"y2":100,"prev":0,"next":0}}],"ladders":[],"portals":[{{"name":"sp","type":0,"x":{spawn_x},"y":100}}]}}"#
    ))
    .unwrap()
}

/// 一张只有呼叫器 NPC 的图：`221030400` 里放 `2052026`，另一张图放同模板的
/// 第二个出生点，用来证明「同一模板在别处不构成门」。
fn ufo_pager_gameplay() -> Gameplay {
    Gameplay {
        npcs: vec![NpcTemplate {
            template_id: UFO_PAGER_TEMPLATE_ID.into(),
            name: "UFO呼叫器".into(),
            func: String::new(),
            shop_id: None,
            script: None,
            stand: Vec::new(),
        }],
        npc_spawns: vec![
            NpcSpawn {
                id: "ufo-pager-here".into(),
                template_id: UFO_PAGER_TEMPLATE_ID.into(),
                x: 0.0,
                y: 100.0,
                foothold_id: Some(1),
                map_id: UFO_PAGER_MAP_ID.into(),
                facing: -1,
            },
            NpcSpawn {
                id: "ufo-pager-elsewhere".into(),
                template_id: UFO_PAGER_TEMPLATE_ID.into(),
                x: 0.0,
                y: 100.0,
                foothold_id: Some(1),
                map_id: "221030100".into(),
                facing: -1,
            },
        ],
        ..Gameplay::default()
    }
}

fn ufo_world() -> World {
    let mut world =
        World::new_with_gameplay(ufo_room(UFO_PAGER_MAP_ID, 0.0), 600, ufo_pager_gameplay());
    for (id, x) in [
        (UFO_ENTRY_MAP_ID, -600.0),
        ("221030100", 600.0),
        ("221030540", 500.0),
        ("221030550", 400.0),
        ("221030551", 300.0),
        ("221030600", 200.0),
        ("221030700", 100.0),
    ] {
        world.maps.insert(id.to_owned(), ufo_room(id, x));
    }
    world.spawn_configured_npcs().expect("npcs placed");
    world
}

fn ufo_drain(rx: &mut mpsc::Receiver<String>) -> Vec<String> {
    let mut messages = Vec::new();
    while let Ok(message) = rx.try_recv() {
        messages.push(message);
    }
    messages
}

/// 加入角色并落在指定图的 `sp` 上。
fn ufo_join(world: &mut World, id: &str, map_id: &str) -> mpsc::Receiver<String> {
    let mut rx = join_test_player(world, id);
    ufo_drain(&mut rx);
    {
        let player = world.players.get_mut(id).expect("player joined");
        player.map_id = map_id.to_owned();
        player.state.x = 0.0;
        player.state.y = 100.0;
        player.state.grounded = true;
        player.state.action = "stand";
    }
    rx
}

/// 走到指定 NPC 出生点旁边并发起对话，返回这一轮收到的消息。
fn ufo_talk_to(
    world: &mut World,
    rx: &mut mpsc::Receiver<String>,
    id: &str,
    spawn_id: &str,
) -> Vec<String> {
    let (map_id, x, y) = world
        .npcs
        .get(spawn_id)
        .map(|npc| (npc.map_id.clone(), npc.state.x, npc.state.y))
        .expect("npc spawn");
    {
        let player = world.players.get_mut(id).expect("player joined");
        player.map_id = map_id;
        player.state.x = x;
        player.state.y = y;
        player.state.grounded = true;
        player.state.action = "stand";
    }
    world.handle_npc_talk(id.into(), "ufo-pager".into(), spawn_id.into(), None, None);
    ufo_drain(rx)
}

#[test]
fn ufo_pager_talk_is_the_only_way_into_the_ufo() {
    let mut world = ufo_world();
    let mut rx = ufo_join(&mut world, "flyer", UFO_PAGER_MAP_ID);
    ufo_talk_to(&mut world, &mut rx, "flyer", "ufo-pager-here");
    assert_eq!(
        world.players["flyer"].map_id, UFO_ENTRY_MAP_ID,
        "talking to the pager abducts the player into 走廊102"
    );
    // 落点必须是源配对的那扇舱门所在图（`ufo_room` 的 x 与门口区分开）。
    assert_eq!(world.players["flyer"].state.x, -600.0);
}

#[test]
fn ufo_pager_elsewhere_does_not_warp_anybody() {
    let mut world = ufo_world();
    let mut rx = ufo_join(&mut world, "wanderer", "221030100");
    ufo_talk_to(&mut world, &mut rx, "wanderer", "ufo-pager-elsewhere");
    assert_eq!(
        world.players["wanderer"].map_id, "221030100",
        "the same template outside 221030400 is not a gate"
    );
}

#[test]
fn ufo_pager_refuses_a_dead_character() {
    let mut world = ufo_world();
    let mut rx = ufo_join(&mut world, "ghost", UFO_PAGER_MAP_ID);
    world.players.get_mut("ghost").unwrap().state.hp = 0;
    let messages = ufo_talk_to(&mut world, &mut rx, "ghost", "ufo-pager-here");
    assert!(
        messages.iter().any(|message| message.contains("\"dead\"")),
        "a dead character must be told why: {messages:?}"
    );
    assert_eq!(
        world.players["ghost"].map_id, UFO_PAGER_MAP_ID,
        "a dead character must not be abducted"
    );
}

#[test]
fn ufo_script_gates_route_the_corridor_wings() {
    let mut world = ufo_world();
    for (from, portal, to) in [
        ("221030540", "pt00", "221030550"),
        ("221030550", "pt00", "221030551"),
        ("221030600", "up00", "221030700"),
    ] {
        let account = format!("corridor-{from}");
        let mut rx = ufo_join(&mut world, &account, from);
        world.handle_portal(account.clone(), "ufo-portal".into(), portal.into());
        let reply = ufo_drain(&mut rx).join("\n");
        assert!(reply.contains("\"success\":true"), "{from}/{portal}: {reply}");
        assert!(reply.contains(to), "{from}/{portal} must land in {to}: {reply}");
        assert_eq!(world.players[&account].map_id, to);
    }
}

#[test]
fn ufo_unauthorised_script_gates_stay_unhandled() {
    // `221030550.col00`（pt:9 `col_221030550`）在 Graph.json 的授权目标是
    // 999999999；`221030551.pt00` 的授权目标是它自己。两者都不构成可落地
    // 的门 ⇒ 必须落到普通查表并被拒，不能被本模块接管。
    let mut world = ufo_world();
    for (map_id, portal) in [("221030550", "col00"), ("221030551", "pt00")] {
        let account = format!("unrouted-{map_id}");
        let mut rx = ufo_join(&mut world, &account, map_id);
        world.handle_portal(account.clone(), "ufo-portal".into(), portal.into());
        let reply = ufo_drain(&mut rx).join("\n");
        assert!(reply.contains("\"success\":false"), "{map_id}/{portal}: {reply}");
        assert_eq!(world.players[&account].map_id, map_id, "{map_id}/{portal}");
    }
}

fn ufo_catalog() -> MapCatalog {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/maps.json");
    MapCatalog::load(&path).expect("generated TMS273 map catalog")
}

#[test]
fn ufo_real_catalog_pairs_the_full_walk_chain() {
    let catalog = ufo_catalog();
    let by_id = |id: &str| {
        catalog
            .maps
            .iter()
            .find(|map| map.id == id)
            .unwrap_or_else(|| panic!("map {id} must be assembled"))
    };
    let hop = |from: &str, name: &str, to: &str, to_portal: &str| {
        let portal = by_id(from)
            .portals
            .iter()
            .find(|portal| portal.name == name)
            .unwrap_or_else(|| panic!("map {from} needs portal {name}"))
            .clone();
        assert_eq!(portal.target_map_id.as_deref(), Some(to), "{from}/{name}");
        assert_eq!(
            portal.target_portal_name.as_deref(),
            Some(to_portal),
            "{from}/{name}"
        );
    };
    // 本部 ⇄ 危險地帶。
    hop("221000000", "west00", "221030000", "east00");
    hop("221030000", "east00", "221000000", "west00");
    // 草原链双向。
    hop("221030000", "west00", "221030100", "east00");
    hop("221030100", "west00", "221030200", "east00");
    hop("221030200", "west00", "221030300", "east00");
    hop("221030300", "west00", "221030400", "east00");
    for (from, to) in [
        ("221030100", "221030000"),
        ("221030200", "221030100"),
        ("221030300", "221030200"),
        ("221030400", "221030300"),
    ] {
        hop(from, "east00", to, "west00");
    }
    // UFO 进出：舱门是源静态门（520.pt00 ⇄ 400.pt00），进场由呼叫器 NPC 决定。
    hop(UFO_ENTRY_MAP_ID, "pt00", UFO_PAGER_MAP_ID, "pt00");
    hop("221030510", "west00", "221030500", "east00");
    hop("221030520", "west00", "221030510", "east00");
    hop("221030520", "east00", "221030530", "west00");
    hop("221030530", "up00", "221030630", "down00");
    hop("221030630", "down00", "221030530", "up00");
    hop("221030530", "east00", "221030540", "west00");
    hop("221030600", "east00", "221030610", "west00");
    hop("221030600", "west00", "221030640", "east00");
    hop("221030640", "west00", "221030650", "east00");
    hop("221030650", "west00", "221030660", "east00");
    hop("221030660", "east00", "221030650", "west00");
    hop("221030700", "east00", "221030710", "west00");
    hop("221030720", "east00", "221030730", "west00");
    // 三扇 pt:7 门的回程都是源静态门；装配器同时把服务端钩子已按同一目标
    // 处置的三扇门暴露进目录（`world.ts::tryPortal` 只受理带 `targetMapId`
    // 的门，否则路由收不到请求）。
    for (map_id, name, to, to_portal) in [
        ("221030550", "west00", "221030540", "pt00"),
        ("221030700", "west00", "221030600", "up00"),
        ("221030551", "west00", "221030540", "pt00"),
        ("221030540", "pt00", "221030550", "west00"),
        ("221030550", "pt00", "221030551", "pt00"),
        ("221030600", "up00", "221030700", "west00"),
    ] {
        hop(map_id, name, to, to_portal);
    }
    // 呼叫器所在的草原Ⅳ必须真的摆着那个 NPC（模板 + 源站位）。
    let gameplay_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/gameplay.json");
    let gameplay: Gameplay = serde_json::from_str(
        &std::fs::read_to_string(&gameplay_path).expect("generated gameplay data"),
    )
    .expect("gameplay parses");
    let pager = gameplay
        .npc_spawns
        .iter()
        .find(|spawn| spawn.template_id == UFO_PAGER_TEMPLATE_ID)
        .expect("the UFO pager must be placed");
    assert_eq!(pager.map_id, UFO_PAGER_MAP_ID);
    // 源 life 行：x=-1938, y=37, cy=116。装配器对 NPC 一律取 `cy`（面物台
    // 高度）作运行时 y，原始 y 另存 `sourceY` 只作来源留痕，所以这里钉 116。
    assert_eq!(pager.x, -1938.0, "source placement x");
    assert_eq!(pager.y, 116.0, "source foothold y (life.cy)");
}

#[test]
fn ufo_real_catalog_landings_are_grounded() {
    // 落点一律取目标图里的源门位（`sp` 离地 34~80px，超出既有 24px 贴地窗）。
    let catalog = ufo_catalog();
    for (map_id, portal_name) in [
        (UFO_ENTRY_MAP_ID, "pt00"),
        ("221030550", "west00"),
        ("221030551", "pt00"),
        ("221030700", "west00"),
    ] {
        let map = catalog
            .maps
            .iter()
            .find(|map| map.id == map_id)
            .unwrap_or_else(|| panic!("map {map_id} must be assembled"));
        let spot = map
            .portals
            .iter()
            .find(|portal| portal.name == portal_name)
            .unwrap_or_else(|| panic!("map {map_id} needs portal {portal_name}"));
        let ground = map.ground_near(spot.x, spot.y);
        let distance = ground.map_or(f64::INFINITY, |(_, y)| (y - spot.y).abs());
        assert!(distance <= 24.0, "{map_id}/{portal_name} lands {distance:?}px off the ground");
    }
}

#[test]
fn ufo_real_catalog_deaths_return_to_the_headquarters() {
    // 整个街区的 returnMap 都是地球防衛本部，只有 221030551（走廊105 另一段）
    // 按源指向 221030550。
    let catalog = ufo_catalog();
    for id in [
        "221030000", "221030100", "221030200", "221030300", "221030400",
        "221030500", "221030510", "221030520", "221030530", "221030540",
        "221030550", "221030551", "221030600", "221030610", "221030620",
        "221030630", "221030640", "221030650", "221030660", "221030700",
        "221030710", "221030720", "221030730",
    ] {
        let expected = if id == "221030551" { "221030550" } else { "221000000" };
        assert_eq!(
            catalog.return_maps.get(id).map(String::as_str),
            Some(expected),
            "{id} returnMap"
        );
    }
}

#[test]
fn ufo_real_catalog_leaves_script_only_dead_ends_out() {
    // 反向断言：源里没有任何授权入边的图（入口是原版腳本）不装配；本街区
    // 真正可达的图必须在册。名单过期或被误用都要失败。
    let catalog = ufo_catalog();
    let assembled: Vec<&str> = catalog.maps.iter().map(|map| map.id.as_str()).collect();
    for id in [
        // 操縱杆翼（Graph 授权只指向翼内与 221030730，没有任何图指向它们）
        "221030800", "221030810", "221030820", "221030821", "221030850",
        "221030801", "221030802", "221030803", "221030804", "221030805",
        "221030840",
        // 无名字（连 String/Map.json 都没有）或纯粹的事件房
        "221030890", "221030621", "221030731", "221030701", "221030541",
        "221030602",
        // BossCaoong 首領房（lvLimit 180），本仓库没有该首領
        "221030900", "221030910",
    ] {
        assert!(
            !assembled.contains(&id),
            "{id} has no authorised entrance and must stay unassembled"
        );
    }
    for id in [
        "221030000", "221030100", "221030200", "221030300", "221030400",
        "221030500", "221030510", "221030520", "221030530", "221030540",
        "221030550", "221030551", "221030600", "221030610", "221030620",
        "221030630", "221030640", "221030650", "221030660", "221030700",
        "221030710", "221030720", "221030730",
    ] {
        assert!(assembled.contains(&id), "{id} must be assembled");
    }
}
