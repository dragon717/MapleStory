/// 艾靈森林章节验收（2026-09-14，审计 T06）。经 `include!` 进入 `world.rs`
/// 的 `mod tests`，复用 `map()` / `join_test_player` / `drain` 等既有助手。
///
/// 覆盖：脚本门 P 级路由的六条配对（时间门、碴烏洞穴进出、两个
/// `in_300010300` 回门、妖精首領房进出）、真实装配数据上的落点贴地、
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

/// 把已加入的角色安置到指定地图（绕过传送门管线），站在 `sp` 门上。
fn place_at(world: &mut World, id: &str, map_id: &str, x: f64) {
    let player = world.players.get_mut(id).expect("player joined");
    player.map_id = map_id.to_owned();
    player.state.x = x;
    player.state.y = 100.0;
    player.state.grounded = true;
    player.state.action = "stand";
}

fn portal_intent(world: &mut World, id: &str, portal_name: &str) -> Vec<String> {
    let rx = join_test_player(world, id);
    // Join 快照先排掉，再发起传送意图。
    drain(&rx);
    world.handle_portal(id.to_owned(), "req-1".to_owned(), portal_name.to_owned());
    drain(&rx)
}

#[test]
fn ellinel_time_gate_routes_into_the_past_and_back_via_the_real_portal() {
    let mut world = ellinel_world();
    let messages = {
        let mut w = &mut world;
        place_at(&mut w, "p1", "222020400", -33.0);
        let rx = join_test_player(&mut w, "p1");
        drain(&rx);
        w.handle_portal("p1".to_owned(), "req-1".to_owned(), "in01".to_owned());
        drain(&rx)
    };
    let result = messages
        .iter()
        .find(|message| message.contains("portalResult"))
        .expect("portal result");
    assert!(result.contains("\"success\":true"), "{result}");
    assert!(result.contains("300000100"), "{result}");
    assert_eq!(world.players["p1"].map_id, "300000100");
    // 回程是源内真实门（300000100.out00 → 222020400/in01），不走 P 路由；
    // 这里只断言目录装配后的静态配对（真实数据在下一个用例验证）。
}

#[test]
fn ellinel_boss_cave_and_fairy_gates_route_both_ways() {
    let mut world = ellinel_world();
    // 碴烏洞穴：岩石山洞穴 next00 进、洞穴深處 out00 出。
    place_at(&mut world, "p1", "300010410", -100.0);
    let messages = portal_intent(&mut world, "p1", "next00");
    assert!(
        messages
            .iter()
            .any(|message| message.contains("portalResult") && message.contains("300010420")),
        "{messages:?}"
    );
    assert_eq!(world.players["p1"].map_id, "300010420");
    let messages = portal_intent(&mut world, "p1", "out00");
    assert!(
        messages
            .iter()
            .any(|message| message.contains("portalResult") && message.contains("300010410")),
        "{messages:?}"
    );
    assert_eq!(world.players["p1"].map_id, "300010410");

    // 洞窟的另一邊：两个 in_300010300 回门。
    for (from, x) in [("300010420", 100.0), ("300020000", -100.0)] {
        place_at(&mut world, "p1", from, x);
        let messages = portal_intent(&mut world, "p1", "west00");
        assert!(
            messages
                .iter()
                .any(|message| message.contains("portalResult") && message.contains("300010300")),
            "from {from}: {messages:?}"
        );
        assert_eq!(world.players["p1"].map_id, "300010300");
    }

    // 妖精首領房：光明妖精森林 in00 进、女王的藏身處 out00 出。
    place_at(&mut world, "p1", "300030300", -100.0);
    let messages = portal_intent(&mut world, "p1", "in00");
    assert!(
        messages
            .iter()
            .any(|message| message.contains("portalResult") && message.contains("300030310")),
        "{messages:?}"
    );
    assert_eq!(world.players["p1"].map_id, "300030310");
    let messages = portal_intent(&mut world, "p1", "out00");
    assert!(
        messages
            .iter()
            .any(|message| message.contains("portalResult") && message.contains("300030300")),
        "{messages:?}"
    );
    assert_eq!(world.players["p1"].map_id, "300030300");
}

#[test]
fn ellinel_unrouted_script_gates_stay_unhandled() {
    let mut world = ellinel_world();
    // 营地 `tp`×6、封印的森林 `east00` 等未复刻场景门不归本模块处置：
    // 钩子必须返回 false（这里用一张没有对应路由的门名验证"未处置"路径
    // 会落到普通查表并因无目标而拒绝）。
    place_at(&mut world, "p1", "300030310", 100.0);
    let messages = portal_intent(&mut world, "p1", "east00");
    let result = messages
        .iter()
        .find(|message| message.contains("portalResult"))
        .expect("portal result");
    assert!(result.contains("\"success\":false"), "{result}");
    assert_eq!(world.players["p1"].map_id, "300030310");
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
    let portal = |map: &Map, name: &str| {
        map.portals
            .iter()
            .find(|portal| portal.name == name)
            .unwrap_or_else(|| panic!("map {} needs portal {name}", map.id))
    };
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
    // P 路由落点 = 目标图 `sp`：sp 必须贴地（真实目录数据）。
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/maps.json");
    let catalog = MapCatalog::load(&path).expect("generated TMS273 map catalog");
    for id in [
        "300000100", "300010410", "300010420", "300010300", "300030300",
        "300030310",
    ] {
        let map = catalog
            .maps
            .iter()
            .find(|map| map.id == id)
            .unwrap_or_else(|| panic!("map {id} must be assembled"));
        let ground = map.ground_near(map.spawn.x, map.spawn.y);
        let distance = ground.map_or(f64::INFINITY, |(_, y)| (y - map.spawn.y).abs());
        assert!(distance <= 24.0, "{id} sp lands {distance:?}px off the ground");
    }
}
