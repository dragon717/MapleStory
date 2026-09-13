/// 飞行船航线验收（2026-09-14）。经 `include!` 进入 `world.rs` 的 `mod tests`，
/// 复用 `map()` / `join_test_player` / `drain` 等既有助手。
///
/// 一期规则（P 级时刻）：15 分钟班次槽（0..9 航行 / 10..14 检票），开船前
/// 1 分钟停止登船；检票成功落到甲板 `sp`，相位进入航行时仍在船上的乘客
/// 全员强制传送到对端站台 `sp`。
use super::*;
use super::ship::{
    route_index_for_announcer, route_index_for_inspector, route_index_for_map,
    ship_phase_of, ship_snapshot_field, ShipPhase, SHIP_BOARD_GRACE,
};

/// 甲板/站台通用：一块平地 + 一个 `sp` 出生点。
fn ship_room(id: &str, spawn_x: f64) -> Map {
    serde_json::from_str(&format!(
        r#"{{"id":"{id}","bounds":{{"xMin":-800,"xMax":800,"yMin":-1200,"yMax":600}},"spawn":{{"x":{spawn_x},"y":0}},"footholds":[{{"id":1,"x1":-800,"y1":100,"x2":800,"y2":100,"prev":0,"next":0}}],"ladders":[],"portals":[{{"name":"sp","type":0,"x":{spawn_x},"y":100}}]}}"#
    ))
    .unwrap()
}

fn ship_gameplay() -> Gameplay {
    Gameplay::default()
}

/// 内存分支世界：`test` 主图 + 一期两航线的检票站台/甲板/船舱/到站站台。
fn ship_world() -> World {
    let mut world = World::new_with_gameplay(map(), 600, ship_gameplay());
    for id in [
        "104020110", "200090010", "200090011", "200000100",
        "200090000", "200090001",
    ] {
        world.maps.insert(id.to_owned(), ship_room(id, -469.0));
    }
    world
}

/// 把已加入的角色直接安置到指定地图（绕过传送门管线）。
fn place(world: &mut World, id: &str, map_id: &str) {
    let player = world.players.get_mut(id).expect("player joined");
    player.map_id = map_id.to_owned();
    player.state.x = -469.0;
    player.state.y = 100.0;
    player.state.grounded = true;
    player.state.action = "stand";
}

/// 班次槽基准：对齐到 900s 边界的固定时刻，断言不依赖真实墙钟。
const SLOT_BASE: i64 = 1_000_000_000 - 1_000_000_000 % (15 * 60);

#[test]
fn ship_phase_boundaries_follow_the_p_level_slot_table() {
    // 0..9 分钟航行；10..14 检票；槽长恒 900s。
    assert_eq!(
        ship_phase_of(SLOT_BASE),
        ShipPhase::Sailing { left: 10 * 60 }
    );
    assert_eq!(ship_phase_of(SLOT_BASE + 10 * 60 - 1), ShipPhase::Sailing { left: 1 });
    assert_eq!(
        ship_phase_of(SLOT_BASE + 10 * 60),
        ShipPhase::Boarding { left: 5 * 60 }
    );
    assert_eq!(
        ship_phase_of(SLOT_BASE + 15 * 60 - 1),
        ShipPhase::Boarding { left: 1 }
    );
    // 回绕：下一槽重新开船。
    assert_eq!(
        ship_phase_of(SLOT_BASE + 15 * 60),
        ShipPhase::Sailing { left: 10 * 60 }
    );
    // 任意负数/远期时刻都稳定落在槽内（rem_euclid 稳健性）。
    assert_eq!(
        ship_phase_of(SLOT_BASE - 1),
        ShipPhase::Boarding { left: 1 }
    );
}

#[test]
fn ship_boarding_is_gated_by_phase_window_and_map() {
    let mut world = ship_world();
    let _rx = join_test_player(&mut world, "p1");
    place(&mut world, "p1", "104020110");

    // 航行中拒绝。
    assert_eq!(
        world.ship_board_at("p1", 0, SLOT_BASE).err(),
        Some("sailing")
    );
    // 检票窗最后一分钟（开船前 1 分钟停止登船）拒绝：left<=60 即 m>=840。
    assert_eq!(
        world.ship_board_at("p1", 0, SLOT_BASE + 15 * 60 - SHIP_BOARD_GRACE).err(),
        Some("grace")
    );
    assert_eq!(
        world.ship_board_at("p1", 0, SLOT_BASE + 15 * 60 - 1).err(),
        Some("grace")
    );
    // 检票窗内但站错了地图拒绝。
    place(&mut world, "p1", "200000100");
    assert_eq!(
        world.ship_board_at("p1", 0, SLOT_BASE + 10 * 60).err(),
        Some("wrong_map")
    );

    // 正常检票：落到甲板 sp，并登记为乘客。
    place(&mut world, "p1", "104020110");
    assert_eq!(world.ship_board_at("p1", 0, SLOT_BASE + 10 * 60), Ok(()));
    assert_eq!(world.players["p1"].map_id, "200090010");
    assert_eq!(world.ship_passengers[0], vec!["p1".to_owned()]);
    // 重复检票同图不成立（人已在甲板）⇒ wrong_map，名单不重复登记。
    assert_eq!(
        world.ship_board_at("p1", 0, SLOT_BASE + 10 * 60 + 1).err(),
        Some("wrong_map")
    );
    assert_eq!(world.ship_passengers[0].len(), 1);
}

#[test]
fn ship_arrival_warps_aboard_passengers_and_clears_the_manifest() {
    let mut world = ship_world();
    let _rx = join_test_player(&mut world, "p1");
    let _rx2 = join_test_player(&mut world, "p2");
    place(&mut world, "p1", "104020110");
    place(&mut world, "p2", "104020110");
    let boarding = SLOT_BASE + 10 * 60;
    assert_eq!(world.ship_board_at("p1", 0, boarding), Ok(()));
    assert_eq!(world.ship_board_at("p2", 0, boarding + 30), Ok(()));

    // 航行中到站：仍在甲板/船舱的乘客被强制送到对端站台 sp。
    world.step_ship_at(SLOT_BASE + 15 * 60);
    assert_eq!(world.players["p1"].map_id, "200000100");
    assert_eq!(world.players["p2"].map_id, "200000100");
    assert_eq!(
        world.players["p1"].state.x,
        world.maps["200000100"].spawn.x
    );
    assert!(world.ship_passengers[0].is_empty(), "到站后名单必须清空");

    // 反向航线同理：天空站台检票 → 甲板 200090000 → 到站維多利亞站台。
    place(&mut world, "p1", "200000100");
    assert_eq!(world.ship_board_at("p1", 1, boarding), Ok(()));
    assert_eq!(world.players["p1"].map_id, "200090000");
    world.step_ship_at(SLOT_BASE + 15 * 60 + 1);
    assert_eq!(world.players["p1"].map_id, "104020110");
    assert!(world.ship_passengers[1].is_empty());
}

#[test]
fn ship_arrival_skips_passengers_who_already_left_the_ship() {
    let mut world = ship_world();
    let _rx = join_test_player(&mut world, "p1");
    let _rx2 = join_test_player(&mut world, "p2");
    place(&mut world, "p1", "104020110");
    place(&mut world, "p2", "104020110");
    let boarding = SLOT_BASE + 10 * 60;
    assert_eq!(world.ship_board_at("p1", 0, boarding), Ok(()));
    assert_eq!(world.ship_board_at("p2", 0, boarding), Ok(()));

    // p1 死亡复活落回 returnMap（离船），p2 留在甲板；离船者不被到站传送。
    place(&mut world, "p1", "200000000");
    world.step_ship_at(SLOT_BASE + 15 * 60);
    assert_eq!(world.players["p1"].map_id, "200000000");
    assert_eq!(world.players["p2"].map_id, "200000100");
    assert!(world.ship_passengers[0].is_empty());

    // 名单里的失效 id（角色已离线）不阻塞到站传送，也不留残余。
    let _rx3 = join_test_player(&mut world, "p3");
    place(&mut world, "p3", "104020110");
    assert_eq!(world.ship_board_at("p3", 0, boarding), Ok(()));
    world.ship_passengers[0].push("ghost".to_owned());
    world.step_ship_at(SLOT_BASE + 2 * 15 * 60);
    assert_eq!(world.players["p3"].map_id, "200000100");
    assert!(world.ship_passengers[0].is_empty());
}

#[test]
fn ship_snapshot_field_rides_only_route_maps() {
    assert_eq!(route_index_for_map("104020110"), Some(0));
    assert_eq!(route_index_for_map("200090011"), Some(0));
    assert_eq!(route_index_for_map("200000100"), Some(1));
    assert_eq!(route_index_for_map("200090000"), Some(1));
    assert_eq!(route_index_for_map("100000000"), None);
    // 检票员/播报员与航线的绑定关系随断言钉死。
    assert_eq!(route_index_for_inspector("1032008"), Some(0));
    assert_eq!(route_index_for_inspector("2012000"), Some(1));
    assert_eq!(route_index_for_announcer("1032007"), Some(0));
    assert_eq!(route_index_for_announcer("2012000"), None);
    // 快照字段只含三个展示键。
    let field = ship_snapshot_field(0);
    assert_eq!(field["route"], "victoria-orbis");
    assert!(field["phase"].as_str().is_some());
    assert!(field["secondsLeft"].as_i64().is_some());
}
