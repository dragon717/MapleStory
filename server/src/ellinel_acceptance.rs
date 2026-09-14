/// 艾靈森林章节验收（2026-09-14，审计 T06）。经 `include!` 进入 `world.rs`
/// 的 `mod tests`，复用 `map()` / `join_test_player` 等既有助手。
///
/// 覆盖：脚本门 P 级路由的六条配对（时间门、碴烏洞穴进出、两个
/// `in_300010300` 回门、妖精首領房进出）、真实装配数据上的配对与落点贴地、
/// 以及未路由脚本门保持「不处置」的边界。
use super::*;

/// 平地房间：一块地板 + `sp` 门，用于内存分支的端到端路由断言。
fn ellinel_room(id: &str, spawn_x: f64) -> Map {
    serde_json::from_str(&format!(
        r#"{{"id":"{id}","bounds":{{"xMin":-800,"xMax":800,"yMin":-1200,"yMax":600}},"spawn":{{"x":{spawn_x},"y":0}},"footholds":[{{"id":1,"x1":-800,"y1":100,"x2":800,"y2":100,"prev":0,"next":0}}],"ladders":[],"portals":[{{"name":"sp","type":0,"x":{spawn_x},"y":100}}]}}"#
    ))
    .unwrap()
}

fn ellinel_world() -> World {
    let mut world = World::new_with_gameplay(map(), 600, Gameplay::default());
    for (id, x) in [
        ("222020400", -33.0),
        ("300000100", -200.0),
        ("300010410", -100.0),
        ("300010420", 100.0),
        ("300020000", -100.0),
        ("300010300", 100.0),
        ("300030300", -100.0),
        ("300030310", 100.0),
    ] {
        world.maps.insert(id.to_owned(), ellinel_room(id, x));
    }
    world
}

fn drain(rx: &mut mpsc::Receiver<String>) -> Vec<String> {
    let mut messages = Vec::new();
    while let Ok(message) = rx.try_recv() {
        messages.push(message);
    }
    messages
}

/// 加入角色 → 安置到指定地图的 `sp` 门上 → 发起传送意图 → 收回执。
fn place_and_enter_portal(
    world: &mut World,
    id: &str,
    map_id: &str,
    portal_name: &str,
) -> (Vec<String>, String) {
    let mut rx = join_test_player(world, id);
    drain(&mut rx);
    {
        let player = world.players.get_mut(id).expect("player joined");
        player.map_id = map_id.to_owned();
        player.state.x = 0.0;
        player.state.y = 100.0;
        player.state.grounded = true;
        player.state.action = "stand";
    }
    world.handle_portal(id.to_owned(), "req-1".to_owned(), portal_name.to_owned());
    let messages = drain(&mut rx);
    let map_id = world.players.get(id).expect("player kept").map_id.clone();
    (messages, map_id)
}

fn portal_result<'a>(messages: &'a [String]) -> &'a str {
    messages
        .iter()
        .find(|message| message.contains("portalResult"))
        .expect("portal result")
}

#[test]
fn ellinel_time_gate_routes_into_the_past() {
    let mut world = ellinel_world();
    let (messages, map_id) = place_and_enter_portal(&mut world, "p1", "222020400", "in01");
    let result = portal_result(&messages);
    assert!(result.contains("\"success\":true"), "{result}");
    assert!(result.contains("300000100"), "{result}");
    assert_eq!(map_id, "300000100");
}

#[test]
fn ellinel_boss_cave_and_fairy_gates_route_both_ways() {
    let mut world = ellinel_world();
    // 碴烏洞穴：岩石山洞穴 next00 进、洞穴深處 out00 出。
    let (messages, map_id) = place_and_enter_portal(&mut world, "p1", "300010410", "next00");
    assert!(portal_result(&messages).contains("300010420"), "{messages:?}");
    assert_eq!(map_id, "300010420");
    let (messages, map_id) = place_and_enter_portal(&mut world, "p1", "300010420", "out00");
    assert!(portal_result(&messages).contains("300010410"), "{messages:?}");
    assert_eq!(map_id, "300010410");

    // 洞窟的另一邊：两个 in_300010300 回门。
    for from in ["300010420", "300020000"] {
        let (messages, map_id) = place_and_enter_portal(&mut world, "p1", from, "west00");
        assert!(portal_result(&messages).contains("300010300"), "from {from}: {messages:?}");
        assert_eq!(map_id, "300010300");
    }

    // 妖精首領房：光明妖精森林 in00 进、女王的藏身處 out00 出。
    let (messages, map_id) = place_and_enter_portal(&mut world, "p1", "300030300", "in00");
    assert!(portal_result(&messages).contains("300030310"), "{messages:?}");
    assert_eq!(map_id, "300030310");
    let (messages, map_id) = place_and_enter_portal(&mut world, "p1", "300030310", "out00");
    assert!(portal_result(&messages).contains("300030300"), "{messages:?}");
    assert_eq!(map_id, "300030300");
}

#[test]
fn ellinel_unrouted_script_gates_stay_unhandled() {
    let mut world = ellinel_world();
    // 未路由的脚本门不归本模块处置：落到普通查表并因无静态目标而拒绝。
    let (messages, map_id) = place_and_enter_portal(&mut world, "p1", "300030310", "west00");
    let result = portal_result(&messages);
    assert!(result.contains("\"success\":false"), "{result}");
    assert_eq!(map_id, "300030310");
}

#[test]
fn ellinel_real_catalog_crossings_pair_with_the_source() {
    // 真实装配数据：六条 P 路由的两端地图与关键门都在目录里，且回程
    // （小森林 out00 → 時間監控室 in01）是源内静态门，tn 明确配对。
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/maps.json");
    let catalog = MapCatalog::load(&path).expect("generated TMS273 map catalog");
    let by_id = |id: &str| {
        catalog
            .maps
            .iter()
            .find(|map| map.id == id)
            .unwrap_or_else(|| panic!("map {id} must be assembled"))
    };
    fn portal<'a>(map: &'a Map, name: &str) -> &'a Portal {
        map.portals
            .iter()
            .find(|portal| portal.name == name)
            .unwrap_or_else(|| panic!("map {} needs portal {name}", map.id))
    }
    let forest = by_id("300000100");
    let back = portal(forest, "out00");
    assert_eq!(back.target_map_id.as_deref(), Some("222020400"));
    assert_eq!(back.target_portal_name.as_deref(), Some("in01"));
    let room = by_id("222020400");
    let gate = portal(room, "in01");
    assert!(gate.target_map_id.is_none(), "in01 is the source script gate");
    for id in [
        "300000000", "300000002", "300000010", "300000100", "300010000",
        "300010100", "300010200", "300010300", "300010400", "300010410",
        "300010420", "300020000", "300020200", "300020210", "300030000",
        "300030010", "300030200", "300030300", "300030310", "222020000",
    ] {
        by_id(id);
    }
}

#[test]
fn ellinel_real_catalog_landings_are_grounded() {
    // P 路由落点 = 目标图里我方选定的门位（章节图原版 `sp` 是演出位，离地
    // 38~122px）。门位必须全部贴地（真实目录数据）。
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/maps.json");
    let catalog = MapCatalog::load(&path).expect("generated TMS273 map catalog");
    let by_id = |id: &str| {
        catalog
            .maps
            .iter()
            .find(|map| map.id == id)
            .unwrap_or_else(|| panic!("map {id} must be assembled"))
    };
    fn portal<'a>(map: &'a Map, name: &str) -> &'a Portal {
        map.portals
            .iter()
            .find(|portal| portal.name == name)
            .unwrap_or_else(|| panic!("map {} needs portal {name}", map.id))
    }
    for (map_id, portal_name) in [
        ("300000100", "in00"),
        ("300010410", "next00"),
        ("300010420", "out00"),
        ("300010300", "east00"),
        ("300030300", "in00"),
        ("300030310", "out00"),
    ] {
        let map = by_id(map_id);
        let spot = portal(map, portal_name);
        let ground = map.ground_near(spot.x, spot.y);
        let distance = ground.map_or(f64::INFINITY, |(_, y)| (y - spot.y).abs());
        assert!(distance <= 24.0, "{map_id}/{portal_name} lands {distance:?}px off the ground");
    }
}
