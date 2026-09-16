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
    assert_eq!(route_index_for_map("104020120"), Some(2));
    assert_eq!(route_index_for_map("130000210"), Some(3));
    assert_eq!(route_index_for_map("104020130"), Some(4));
    assert_eq!(route_index_for_map("200000170"), Some(4));
    assert_eq!(route_index_for_map("200090601"), Some(4));
    assert_eq!(route_index_for_map("310000010"), Some(5));
    assert_eq!(route_index_for_map("200090611"), Some(5));
    assert_eq!(route_index_for_map("220000100"), Some(6));
    assert_eq!(route_index_for_map("220000110"), Some(6));
    assert_eq!(route_index_for_map("200090110"), Some(6));
    assert_eq!(route_index_for_map("200000120"), Some(7));
    assert_eq!(route_index_for_map("200000121"), Some(7));
    assert_eq!(route_index_for_map("200090100"), Some(7));
    assert_eq!(route_index_for_map("100000000"), None);
    // 检票员/播报员与航线的绑定关系随断言钉死（含二期四名检票员与三期两名）。
    assert_eq!(route_index_for_inspector("1032008"), Some(0));
    assert_eq!(route_index_for_inspector("2012000"), Some(1));
    assert_eq!(route_index_for_inspector("1100007"), Some(2));
    assert_eq!(route_index_for_inspector("1100003"), Some(3));
    assert_eq!(route_index_for_inspector("2150010"), Some(4));
    assert_eq!(route_index_for_inspector("2150008"), Some(5));
    // 三期：检票员都站在碼頭上（不是售票处），两边各一名，不许互串。
    assert_eq!(route_index_for_inspector("2041000"), Some(6));
    assert_eq!(route_index_for_inspector("2012013"), Some(7));
    assert_eq!(route_index_for_inspector("2040000"), None);
    assert_eq!(route_index_for_announcer("1032007"), Some(0));
    assert_eq!(route_index_for_announcer("1100004"), Some(3));
    assert_eq!(route_index_for_announcer("2040000"), Some(6));
    assert_eq!(route_index_for_announcer("2012000"), None);
    // 快照字段只含三个展示键。
    let field = ship_snapshot_field(0);
    assert_eq!(field["route"], "victoria-orbis");
    assert!(field["phase"].as_str().is_some());
    assert!(field["secondsLeft"].as_i64().is_some());
    assert_eq!(ship_snapshot_field(2)["route"], "victoria-erev");
    assert_eq!(ship_snapshot_field(3)["route"], "erev-victoria");
    assert_eq!(ship_snapshot_field(4)["route"], "victoria-edelstein");
    assert_eq!(ship_snapshot_field(5)["route"], "edelstein-victoria");
    assert_eq!(ship_snapshot_field(6)["route"], "toys-orbis");
    assert_eq!(ship_snapshot_field(7)["route"], "orbis-toys");
}

/// 二期世界：内存分支地图覆盖耶雷弗/埃德爾斯坦两线的站台/码头/甲板/船舱。
fn ship_world2() -> World {
    let mut world = World::new_with_gameplay(map(), 600, ship_gameplay());
    for id in [
        "104020110", "200090010", "200090011", "200000100",
        "200090000", "200090001",
        "104020120", "104020130",
        "130000200", "130000210", "130090000",
        "130000000", "130000101", "130030006",
        "200000170",
        "200090600", "200090601", "200090610", "200090611",
        "310000000", "310000010",
    ] {
        world.maps.insert(id.to_owned(), ship_room(id, -469.0));
    }
    world
}

#[test]
fn phase2_erev_line_boards_and_arrives_on_the_shared_deck() {
    let mut world = ship_world2();
    let _rx = join_test_player(&mut world, "p1");
    let _rx2 = join_test_player(&mut world, "p2");
    let boarding = SLOT_BASE + 10 * 60;

    // 去程：树顶耶雷弗站台检票 → 共用甲板 130090000。
    place(&mut world, "p1", "104020120");
    assert_eq!(world.ship_board_at("p1", 2, boarding), Ok(()));
    assert_eq!(world.players["p1"].map_id, "130090000");
    // 耶雷弗船无船舱：cabin 为空串，到站 aboard 判定只认甲板。
    assert_eq!(super::ship::SHIP_ROUTES[2].cabin, "");

    // 返程：天空渡口检票 → 同一张甲板，双向乘客共存（P 级：源唯一耶雷弗船图）。
    place(&mut world, "p2", "130000210");
    assert_eq!(world.ship_board_at("p2", 3, boarding + 30), Ok(()));
    assert_eq!(world.players["p2"].map_id, "130090000");
    assert_eq!(world.ship_passengers[2], vec!["p1".to_owned()]);
    assert_eq!(world.ship_passengers[3], vec!["p2".to_owned()]);

    // 到站：去程落天空渡口、返程落树顶站台，名单各自清空。
    world.step_ship_at(SLOT_BASE + 15 * 60);
    assert_eq!(world.players["p1"].map_id, "130000210");
    assert_eq!(world.players["p2"].map_id, "104020120");
    assert!(world.ship_passengers[2].is_empty());
    assert!(world.ship_passengers[3].is_empty());
}

#[test]
fn phase2_shared_deck_snapshot_route_follows_the_manifest() {
    let mut world = ship_world2();
    let _rx = join_test_player(&mut world, "p1");
    let _rx2 = join_test_player(&mut world, "p2");
    let boarding = SLOT_BASE + 10 * 60;
    place(&mut world, "p1", "104020120");
    place(&mut world, "p2", "130000210");
    assert_eq!(world.ship_board_at("p1", 2, boarding), Ok(()));
    assert_eq!(world.ship_board_at("p2", 3, boarding), Ok(()));
    // 同一张共用甲板：去程乘客看去程航线，返程乘客看返程航线。
    assert_eq!(world.ship_snapshot_route_index("130090000", "p1"), Some(2));
    assert_eq!(world.ship_snapshot_route_index("130090000", "p2"), Some(3));
    // 未登记的旁观者看去程航线；到站清空名单后回落同一条。
    let _rx3 = join_test_player(&mut world, "p3");
    place(&mut world, "p3", "130090000");
    assert_eq!(world.ship_snapshot_route_index("130090000", "p3"), Some(2));
    // 非共用图照旧走静态表。
    assert_eq!(world.ship_snapshot_route_index("104020120", "p3"), Some(2));
}

#[test]
fn phase2_edelstein_line_boards_arrives_and_counts_the_cabin() {
    let mut world = ship_world2();
    let _rx = join_test_player(&mut world, "p1");
    let _rx2 = join_test_player(&mut world, "p2");
    let boarding = SLOT_BASE + 10 * 60;

    // 去程：树顶埃德爾斯坦站台 → 甲板 200090600；乘客挪进船舱 200090601。
    place(&mut world, "p1", "104020130");
    assert_eq!(world.ship_board_at("p1", 4, boarding), Ok(()));
    assert_eq!(world.players["p1"].map_id, "200090600");
    place(&mut world, "p1", "200090601");
    // 返程：埃德爾斯坦码头 → 甲板 200090610（p2 留在甲板）。
    place(&mut world, "p2", "310000010");
    assert_eq!(world.ship_board_at("p2", 5, boarding), Ok(()));
    assert_eq!(world.players["p2"].map_id, "200090610");

    // 到站：船舱里的乘客同样必须被送到对端站台（aboard 判定含船舱）。
    world.step_ship_at(SLOT_BASE + 15 * 60);
    assert_eq!(world.players["p1"].map_id, "310000010");
    assert_eq!(world.players["p2"].map_id, "104020130");
    assert!(world.ship_passengers[4].is_empty());
    assert!(world.ship_passengers[5].is_empty());
}

#[test]
fn phase2_portal_gate_moves_hatches_and_blocks_sailing_exits() {
    let mut world = ship_world2();
    let _rx = join_test_player(&mut world, "p1");
    // 甲板 → 船舱的 move 脚本门（pt:9）：固定互切，落点在对图 sp。
    place(&mut world, "p1", "200090600");
    assert!(world.ship_portal_gate("p1", "req-move", "200090600", "move00"));
    assert_eq!(world.players["p1"].map_id, "200090601");
    // 船舱 → 甲板同理。
    assert!(world.ship_portal_gate("p1", "req-move-back", "200090601", "move01"));
    assert_eq!(world.players["p1"].map_id, "200090600");
    // 航行中舱门（out00..09）不开门：钩子处置并拒绝，正常门流程不放行。
    let sailing = SLOT_BASE; // 槽首 = 航行相位
    assert_eq!(
        super::ship::ship_phase_of(sailing),
        super::ship::ShipPhase::Sailing { left: 10 * 60 }
    );
    assert!(world.ship_portal_gate_at("p1", "req-hatch", "200090600", "out00", sailing));
    assert_eq!(world.players["p1"].map_id, "200090600", "航行中舱门不放行");
    // 检票相位走舱门 = 靠港下船：落回本端检票站台 sp（D3 修复的落点契约）。
    let boarding = SLOT_BASE + 10 * 60;
    assert!(world.ship_portal_gate_at("p1", "req-hatch-dock", "200090600", "out05", boarding));
    assert_eq!(world.players["p1"].map_id, "104020130");
    assert!(world.ship_portal_gate_at("p1", "req-hatch-back", "200090610", "out00", boarding));
    assert_eq!(world.players["p1"].map_id, "310000010");
    // 耶雷弗船的舷侧门保持关闭：任何相位都由钩子处置。
    place(&mut world, "p1", "130090000");
    assert!(world.ship_portal_gate("p1", "req-west", "130090000", "west00"));
    // 非船务门不接管（返回 false，走正常门流程）。
    place(&mut world, "p1", "104020110");
    assert!(!world.ship_portal_gate("p1", "req-other", "104020110", "out00"));
}

#[test]
fn aboard_players_cannot_escape_via_world_map_or_scroll_target_rules() {
    // D1/D2 拒绝面：甲板/船舱期间大地图跳转与回家卷軸同被拒绝。
    assert!(super::ship::ship_is_on_board_map("130090000"));
    assert!(super::ship::ship_is_on_board_map("200090601"));
    assert!(super::ship::ship_is_on_board_map("200090010"));
    assert!(!super::ship::ship_is_on_board_map("104020130"));
    assert!(!super::ship::ship_is_on_board_map("200000170"));
    // 站台不拒卷軸（玩家可自行回城），船图拒。
    let mut world = ship_world2();
    let _rx = join_test_player(&mut world, "p1");
    place(&mut world, "p1", "130090000");
    assert!(super::ship::ship_is_on_board_map(&world.players["p1"].map_id));
}

#[test]
fn phase2_in01_and_dock_out00_route_per_source_adjacency() {
    let mut world = ship_world2();
    let _rx = join_test_player(&mut world, "p1");
    // 大厅 in01 的 inERShip 脚本门 → 耶雷弗站台 come00。
    place(&mut world, "p1", "104020100");
    assert!(world.ship_portal_gate("p1", "req-in01", "104020100", "in01"));
    assert_eq!(world.players["p1"].map_id, "104020120");
    // 天空渡口 out00（pt_00_130000210 脚本门）→ 耶雷弗前庭 in00。
    place(&mut world, "p1", "130000210");
    assert!(world.ship_portal_gate("p1", "req-out00", "130000210", "out00"));
    assert_eq!(world.players["p1"].map_id, "130000200");
}

/// 三期世界：玩具城⇄天空之城两线的码头/售票处/港口通道/甲板，外加天空之城城内。
fn ship_world3() -> World {
    let mut world = World::new_with_gameplay(map(), 600, ship_gameplay());
    for id in [
        "200000100",
        "220000100", "220000110", "200090110",
        "200000120", "200000121", "200090100",
        "200000000", "200000001", "200000002",
    ] {
        world.maps.insert(id.to_owned(), ship_room(id, -469.0));
    }
    world
}

#[test]
fn phase3_toys_line_boards_at_the_dock_and_arrives_across() {
    let mut world = ship_world3();
    let _rx = join_test_player(&mut world, "p1");
    let _rx2 = join_test_player(&mut world, "p2");
    let boarding = SLOT_BASE + 10 * 60;

    // 源里两张船图都没有船舱：cabin 必须是空串，到站判定只认甲板。
    assert_eq!(super::ship::SHIP_ROUTES[6].cabin, "");
    assert_eq!(super::ship::SHIP_ROUTES[7].cabin, "");

    // 去程：玩具城碼頭 220000110 检票 → 甲板 200090110 → 到站天空之城碼頭。
    place(&mut world, "p1", "220000110");
    assert_eq!(world.ship_board_at("p1", 6, boarding), Ok(()));
    assert_eq!(world.players["p1"].map_id, "200090110");
    assert_eq!(world.ship_passengers[6], vec!["p1".to_owned()]);

    // 返程：天空之城碼頭 200000121 检票 → 甲板 200090100 → 到站玩具城碼頭。
    place(&mut world, "p2", "200000121");
    assert_eq!(world.ship_board_at("p2", 7, boarding + 30), Ok(()));
    assert_eq!(world.players["p2"].map_id, "200090100");

    world.step_ship_at(SLOT_BASE + 15 * 60);
    assert_eq!(world.players["p1"].map_id, "200000121");
    assert_eq!(world.players["p2"].map_id, "220000110");
    assert!(world.ship_passengers[6].is_empty());
    assert!(world.ship_passengers[7].is_empty());

    // 落点就是源里的到站碼頭，不是随手挑的图：下一班仍从同一张图检票。
    assert_eq!(world.maps["200000121"].spawn.x, world.players["p1"].state.x);
    assert_eq!(world.maps["220000110"].spawn.x, world.players["p2"].state.x);
}

#[test]
fn phase3_station_in_gate_follows_the_graph_authorization_table() {
    let mut world = ship_world3();
    let _rx = join_test_player(&mut world, "p1");
    // 售票处 east00 在源里是 pt:7 `station_in` 脚本门（无静态目标）。权威依据
    // 是 `Graph.json` 的 `20/200000100/portal`：它给这扇门授权了七个码头
    // （111/121/131/141/151/161/170），`portalNum` 一律 4。本仓库只装配了
    // 121 与 170 ⇒ 门按授权落到码头，**不旁路到港口通道 200000120**（它不在
    // 授权表里，只是码头的另一条回程旁路）。
    place(&mut world, "p1", "200000100");
    assert!(world.ship_portal_gate("p1", "req-station-in", "200000100", "east00"));
    assert_eq!(world.players["p1"].map_id, "200000121");
    assert_eq!(world.players["p1"].state.x, world.maps["200000121"].spawn.x);
    // 反向断言：港口通道**不得**再被这扇门选中——接上它会把登船相位门包
    // 过去（200000120.east00 → 200000121.west00 与 121.west00 静态门撞车）。
    assert_ne!(
        world.players["p1"].map_id, "200000120",
        "station_in 不得旁路到港口通道：它不在 Graph 授权表里，且是冗余旁路"
    );
    // 非本模块的门不接管。
    assert!(!world.ship_portal_gate("p1", "req-other", "200000100", "west00"));
    // 玩具城售票处没有脚本门（源里是静态 pt:2），钩子同样不接管。
    assert!(!world.ship_portal_gate("p1", "req-toys", "220000100", "east00"));
}

#[test]
fn phase3_station_in_authorization_table_is_pinned() {
    // 授权表本身要钉住：七个目标是源事实，少一个就说明有人凭印象改窄了门。
    assert_eq!(
        super::ship::STATION_IN_AUTHORIZED,
        &[
            "200000111", "200000121", "200000131", "200000141", "200000151", "200000161",
            "200000170",
        ]
    );
    // 已装配的两个按源落点（两图 west00 都是回售票处的静态门）可落地。
    assert_eq!(super::ship::station_in_exit("200000121"), Some("west00"));
    assert_eq!(super::ship::station_in_exit("200000170"), Some("west00"));
    // 未装配的五个、以及港口通道，都必须如实返回 None（走近收门提示），
    // 不能凭空给一个落点把玩家送进空图。
    for target in super::ship::STATION_IN_AUTHORIZED {
        let expected = matches!(*target, "200000121" | "200000170").then_some("west00");
        assert_eq!(
            super::ship::station_in_exit(target),
            expected,
            "{target} 的落点判定与装配状态不符"
        );
    }
    assert_eq!(super::ship::station_in_exit("200000120"), None);
}

#[test]
fn phase3_station_in_lands_on_an_assembled_map() {
    // 已装配性不由本表保证（表是源授权），但**已装配的**目标必须真在目录里，
    // 否则 station_in_exit 就是死代码。这里读**真图目录**交叉核对：夹具
    // `ship_room()` 只有 `sp`，量它等于量夹具，量不出源事实。
    // 路径走 `CARGO_MANIFEST_DIR`（测试的 cwd 是 `server/`，不是仓库根）。
    let source = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/maps.json"),
    )
    .expect("shared/maps.json");
    let catalog: serde_json::Value = serde_json::from_str(&source).expect("maps.json parses");
    // `maps` 是数组（每项自带 `id`），不是以 id 为键的对象。
    let rooms = catalog["maps"].as_array().expect("maps array");
    let find = |map_id: &str| rooms.iter().find(|room| room["id"] == map_id);

    let assembled: Vec<&str> = super::ship::STATION_IN_AUTHORIZED
        .iter()
        .copied()
        .filter(|target| find(target).is_some())
        .collect();
    // 授权七个、装配两个；两者的差就是「走近收门提示」的那五个。
    assert_eq!(assembled, vec!["200000121", "200000170"]);
    // 装配状态与落点判定必须**逐一对应**：装了就要有落点，没装就必须没有。
    for target in super::ship::STATION_IN_AUTHORIZED {
        assert_eq!(
            super::ship::station_in_exit(target).is_some(),
            find(target).is_some(),
            "{target} 的落点判定与真图目录的装配状态不符"
        );
    }
    // 港口通道刻意不接：它确实装配了，但落点仍是 None（不在授权表里）。
    assert!(find("200000120").is_some());
    assert_eq!(super::ship::station_in_exit("200000120"), None);
    // 两个已装配目标必须有 west00 回程门，否则落地就会掉出地图边界。
    for target in assembled {
        let portals = find(target).expect("assembled")["portals"]
            .as_array()
            .expect("portals");
        assert!(
            portals.iter().any(|portal| portal["name"] == "west00"),
            "{target} 必须有 west00 回程门"
        );
    }
}

#[test]
fn phase3_stranded_passengers_are_recovered_by_phase() {
    let mut world = ship_world3();
    let _rx = join_test_player(&mut world, "p1");
    let _rx2 = join_test_player(&mut world, "p2");

    // 检票窗内已登记的乘客不许被相位恢复踢下船（否则登完船就被送回去）。
    place(&mut world, "p1", "200000121");
    let boarding = SLOT_BASE + 10 * 60;
    assert_eq!(world.ship_board_at("p1", 7, boarding), Ok(()));
    world.step_ship_at(boarding + 30);
    assert_eq!(
        world.players["p1"].map_id, "200090100",
        "已登记的乘客必须留在船上"
    );

    // 靠港相位落在船图却不在名单里（服务重启/重连）⇒ 放回本端登船站台：
    // 这两张船图在源里连一扇门都没有，不兜底就是死端。
    place(&mut world, "p2", "200090110");
    world.step_ship_at(boarding + 60);
    assert_eq!(world.players["p2"].map_id, "220000110");
    assert_eq!(world.players["p2"].state.x, world.maps["220000110"].spawn.x);

    // 航行相位落在船图却不在名单里 ⇒ 补登记，随本班到站被送下船。
    place(&mut world, "p2", "200090100");
    world.step_ship_at(SLOT_BASE);
    assert_eq!(world.ship_passengers[7], vec!["p2".to_owned()]);
    assert_eq!(world.players["p2"].map_id, "200090100", "登记不等于立刻传送");
    world.step_ship_at(SLOT_BASE + 15 * 60);
    assert_eq!(world.players["p2"].map_id, "220000110");

    // 恢复不碰站台与城内：站在碼頭/售票处的角色原地不动。
    place(&mut world, "p2", "220000110");
    world.step_ship_at(SLOT_BASE + 15 * 60 + 1);
    assert_eq!(world.players["p2"].map_id, "220000110");
    // 船图仍是「船上」：大地图跳转与回家卷軸照旧被拒。
    for deck in ["200090100", "200090110"] {
        assert!(super::ship::ship_is_on_board_map(deck));
    }
    assert!(!super::ship::ship_is_on_board_map("200000121"));
}
