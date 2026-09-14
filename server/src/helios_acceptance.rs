/// 玩具城與赫爾奧斯塔塔步行链路验收（2026-09-15，审计 T06 下一片）。经
/// `include!` 进入 `world.rs` 的 `mod tests`，复用 `map()` / `join_test_player`
/// 等既有助手。
///
/// 覆盖：电梯脚本门的 P 级路由（99樓 ⇄ 2樓，即到即走）、真实装配数据上的
/// 步行链路配对（玩具城 → 赫爾奧斯塔入口 → 100樓 → 99樓 → 2樓 → 圖書館，
/// 100樓 → 時間監控室）、电梯到站门贴地、塔层死亡回程落玩具城，以及
/// 未路由脚本门保持「不处置」的边界。
use super::*;

/// 平地房间：一块地板 + `sp` 门，用于内存分支的端到端路由断言。
fn helios_room(id: &str, spawn_x: f64) -> Map {
    serde_json::from_str(&format!(
        r#"{{"id":"{id}","bounds":{{"xMin":-800,"xMax":800,"yMin":-1200,"yMax":600}},"spawn":{{"x":{spawn_x},"y":0}},"footholds":[{{"id":1,"x1":-800,"y1":100,"x2":800,"y2":100,"prev":0,"next":0}}],"ladders":[],"portals":[{{"name":"sp","type":0,"x":{spawn_x},"y":100}}]}}"#
    ))
    .unwrap()
}

fn helios_world() -> World {
    let mut world = World::new_with_gameplay(map(), 600, Gameplay::default());
    for (id, x) in [("222020200", -100.0), ("222020100", 100.0)] {
        world.maps.insert(id.to_owned(), helios_room(id, x));
    }
    world
}

fn helios_drain(rx: &mut mpsc::Receiver<String>) -> Vec<String> {
    let mut messages = Vec::new();
    while let Ok(message) = rx.try_recv() {
        messages.push(message);
    }
    messages
}

/// 加入角色 → 安置到指定地图的 `sp` 门上 → 发起传送意图 → 收回执。
fn helios_place_and_enter_portal(
    world: &mut World,
    id: &str,
    map_id: &str,
    portal_name: &str,
) -> (Vec<String>, String) {
    let mut rx = join_test_player(world, id);
    helios_drain(&mut rx);
    {
        let player = world.players.get_mut(id).expect("player joined");
        player.map_id = map_id.to_owned();
        player.state.x = 0.0;
        player.state.y = 100.0;
        player.state.grounded = true;
        player.state.action = "stand";
    }
    world.handle_portal(id.to_owned(), "req-1".to_owned(), portal_name.to_owned());
    let messages = helios_drain(&mut rx);
    let map_id = world.players.get(id).expect("player kept").map_id.clone();
    (messages, map_id)
}

fn helios_portal_result<'a>(messages: &'a [String]) -> &'a str {
    messages
        .iter()
        .find(|message| message.contains("portalResult"))
        .expect("portal result")
}

#[test]
fn helios_elevator_routes_between_floors_both_ways() {
    let mut world = helios_world();
    // 99樓 in00（LudiElevator_in）→ 2樓 st00（源轿厢 222020110 到站门）。
    let (messages, map_id) = helios_place_and_enter_portal(&mut world, "p1", "222020200", "in00");
    let result = helios_portal_result(&messages);
    assert!(result.contains("\"success\":true"), "{result}");
    assert!(result.contains("222020100"), "{result}");
    assert_eq!(map_id, "222020100");
    // 2樓 in00 → 99樓 st01（源轿厢 222020210 到站门）。
    let (messages, map_id) = helios_place_and_enter_portal(&mut world, "p1", "222020100", "in00");
    let result = helios_portal_result(&messages);
    assert!(result.contains("\"success\":true"), "{result}");
    assert!(result.contains("222020200"), "{result}");
    assert_eq!(map_id, "222020200");
}

#[test]
fn helios_unrouted_script_gates_stay_unhandled() {
    let mut world = helios_world();
    // 99樓只剩 st00/st01/sp；用 2樓的一个非电梯门名验证未路由门不归本模块
    // 处置：落到普通查表并因无静态目标而拒绝。
    let (messages, map_id) = helios_place_and_enter_portal(&mut world, "p1", "222020100", "in01");
    let result = helios_portal_result(&messages);
    assert!(result.contains("\"success\":false"), "{result}");
    assert_eq!(map_id, "222020100");
}

#[test]
fn helios_real_catalog_pairs_the_full_walk_chain() {
    // 真实装配数据：步行链路每一跳的两端地图与关键门都在目录里，且源内
    // 静态门（pt:2/pt:3）的 tm/tn 明确配对。
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
    // 玩具城 ⇄ 赫爾奧斯塔入口。
    let town = by_id("220000000");
    let east = portal(town, "east00");
    assert_eq!(east.target_map_id.as_deref(), Some("220000500"));
    assert_eq!(east.target_portal_name.as_deref(), Some("west00"));
    // 入口 ⇄ 100樓。
    let entrance = by_id("220000500");
    let tower = portal(entrance, "tower00");
    assert_eq!(tower.target_map_id.as_deref(), Some("222020300"));
    assert_eq!(tower.target_portal_name.as_deref(), Some("top00"));
    // 100樓 ⇄ 99樓（pt:3 接触门）与 100樓 → 時間監控室。
    let floor100 = by_id("222020300");
    let under = portal(floor100, "under00");
    assert_eq!(under.target_map_id.as_deref(), Some("222020200"));
    assert_eq!(under.target_portal_name.as_deref(), Some("st00"));
    let monitor_gate = portal(floor100, "in00");
    assert_eq!(monitor_gate.target_map_id.as_deref(), Some("222020400"));
    assert_eq!(monitor_gate.target_portal_name.as_deref(), Some("out00"));
    // 2樓 → 圖書館（圖書館 out00 → 2樓 in01 是源内静态门，2026-09-14 已装）。
    let floor2 = by_id("222020100");
    let library_gate = portal(floor2, "in01");
    assert_eq!(library_gate.target_map_id.as_deref(), Some("222020000"));
    assert_eq!(library_gate.target_portal_name.as_deref(), Some("out00"));
    // 电梯门保持源样：无静态目标，由 helios.rs 处置。
    let elevator99 = portal(by_id("222020200"), "in00");
    assert!(elevator99.target_map_id.is_none());
    let elevator2 = portal(floor2, "in00");
    assert!(elevator2.target_map_id.is_none());
    // 两间商店内殿与雜貨店 NPC 模板在目录里。
    for id in [
        "220000000", "220000001", "220000002", "220000500",
        "222020300", "222020200", "222020100",
    ] {
        by_id(id);
    }
}

#[test]
fn helios_real_catalog_elevator_landings_are_grounded() {
    // P 路由落点 = 源轿厢出门 tn 指定的到站门（真实目录数据必须贴地）。
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/maps.json");
    let catalog = MapCatalog::load(&path).expect("generated TMS273 map catalog");
    let by_id = |id: &str| {
        catalog
            .maps
            .iter()
            .find(|map| map.id == id)
            .unwrap_or_else(|| panic!("map {id} must be assembled"))
    };
    for (map_id, portal_name) in [("222020100", "st00"), ("222020200", "st01")] {
        let map = by_id(map_id);
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
fn helios_real_catalog_tower_deaths_return_to_ludibrium() {
    // 塔层与入口的源 returnMap 都是 220000000；本模块装配后，章节入口房
    // （圖書館/時間監控室）与塔内死亡第一次有了真实回程城镇。
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/maps.json");
    let catalog = MapCatalog::load(&path).expect("generated TMS273 map catalog");
    for id in [
        "220000500", "222020300", "222020200", "222020100",
        "222020000", "222020400",
    ] {
        assert_eq!(
            catalog.return_maps.get(id).map(String::as_str),
            Some("220000000"),
            "{id} returnMap"
        );
    }
}
