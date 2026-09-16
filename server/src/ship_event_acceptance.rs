/// 飞行船三期「甲板刷地獄巴洛古」验收（2026-09-16）。经 `include!` 进入
/// `world.rs` 的 `mod tests`，复用 `ship_acceptance.rs` 的 `ship_room` /
/// `place` / `SLOT_BASE`，以及 `world_tests.rs` 的 `life_template` /
/// `life_spawn` / `join_test_player`。
///
/// 验收边界：只钉**调度规则**（P 级常量）与「撤怪只清自己刷的那一只」。
/// 怪物本体（模板、数值、掉落、帧）是源数据，由内容导出检查守，这里只要求
/// 模板 id 用的是源 id。
use super::ship::{SHIP_SAIL_SECONDS, SHIP_SLOT_SECONDS};
use super::ship_event::{
    ship_balrog_spawn_id, BALROG_ATTACK_MAX_SEC, BALROG_ATTACK_START_SEC, BALROG_HOVER_Y,
    BALROG_TEMPLATE_ID,
};

/// 袭击窗口在本班次槽内的起点/终点（槽内秒），与 `ship_event::attack_window`
/// 同一算式——测试自己算一遍，常量被改到越界时这里会先炸。
const WINDOW_OPEN: i64 = SHIP_SAIL_SECONDS + BALROG_ATTACK_START_SEC;
const WINDOW_CLOSE: i64 = WINDOW_OPEN + BALROG_ATTACK_MAX_SEC;

/// 8150000 的模板。机制验收不依赖真实数值（源数值由内容导出检查守），但模板
/// id 必须是源 id，否则 `spawn_monster_on_map` 找不到模板、事件根本刷不出来。
fn balrog_template() -> MonsterTemplate {
    MonsterTemplate {
        template_id: BALROG_TEMPLATE_ID.to_owned(),
        level: 100,
        max_hp: 100_000,
        pa_damage: Some(1318),
        ..life_template()
    }
}

/// 巴洛古 + 一只普通怪（后者用于验证「撤怪不碰地图自带的怪」）。
fn ship_event_gameplay() -> Gameplay {
    Gameplay {
        monsters: vec![balrog_template(), life_template()],
        ..Gameplay::default()
    }
}

/// 一期两航线的检票站台/甲板/船舱/到站站台，外加 8150000 模板。
fn ship_event_world() -> World {
    let mut world = World::new_with_gameplay(map(), 600, ship_event_gameplay());
    for id in [
        "104020110", "200090010", "200090011", "200000100", "200090000", "200090001",
    ] {
        world.maps.insert(id.to_owned(), ship_room(id, -469.0));
    }
    world
}

/// 场上属于某张图的袭击个体（按模板 id 认，不按内部 monster id）。
fn balrog_ids(world: &World, deck: &str) -> Vec<String> {
    world
        .monsters
        .iter()
        .filter(|(_, monster)| {
            monster.map_id == deck && monster.template.template_id == BALROG_TEMPLATE_ID
        })
        .map(|(id, _)| id.clone())
        .collect()
}

#[test]
fn ship_event_window_stays_inside_the_voyage() {
    // 窗口必须整体落在「乘客在甲板上」的那一段里：起点在检票窗开启之后，
    // 终点不晚于到站整单传送。常量被改坏时这条先失败。
    assert!(WINDOW_OPEN > SHIP_SAIL_SECONDS, "袭击不许在检票窗开启前就发生");
    assert!(
        WINDOW_CLOSE <= SHIP_SLOT_SECONDS,
        "袭击不许越过到站整单传送时刻"
    );
    assert_eq!(WINDOW_OPEN, 660);
    assert_eq!(WINDOW_CLOSE, 840);
}

#[test]
fn ship_event_starts_only_after_the_p_level_offset_on_an_occupied_deck() {
    let mut world = ship_event_world();
    let _rx = join_test_player(&mut world, "p1");
    place(&mut world, "p1", "200090010");

    // 甲板上有人，但窗口还没开：不起事件。
    world.step_ship_event_at(SLOT_BASE + WINDOW_OPEN - 1);
    assert!(world.ship_events[0].is_none());
    assert!(balrog_ids(&world, "200090010").is_empty());

    // 窗口开启：甲板上刷出一只。
    world.step_ship_event_at(SLOT_BASE + WINDOW_OPEN);
    assert!(world.ship_events[0].is_some());
    assert_eq!(balrog_ids(&world, "200090010").len(), 1);
    // 另一条航线的甲板上没人，不起事件。
    assert!(world.ship_events[1].is_none());
    assert!(balrog_ids(&world, "200090000").is_empty());
}

#[test]
fn ship_event_spawns_the_source_template_hovering_over_the_deck() {
    let mut world = ship_event_world();
    let _rx = join_test_player(&mut world, "p1");
    place(&mut world, "p1", "200090010");
    world.step_ship_event_at(SLOT_BASE + WINDOW_OPEN);

    let monster = world
        .monsters
        .values()
        .find(|monster| {
            monster.map_id == "200090010" && monster.spawn.id == ship_balrog_spawn_id(0)
        })
        .expect("袭击个体必须已刷出");
    assert_eq!(monster.template.template_id, BALROG_TEMPLATE_ID);
    // -1 = 一次性刷怪：不参与地图重生周期，撤事件即消失。
    assert_eq!(monster.spawn.mob_time, -1);
    assert_eq!(monster.state.action, "stand");
    assert_eq!(monster.horizontal_speed, 0.0);
    // 飞行系悬停在甲板上方：`ship_room` 的甲板面是 y=100。
    assert_eq!(monster.state.y, 100.0 - BALROG_HOVER_Y);
}

#[test]
fn ship_event_skips_empty_decks_and_never_enters_the_cabin() {
    let mut world = ship_event_world();
    let _rx = join_test_player(&mut world, "p1");

    // 甲板没人：整轮不起事件（空船不该被袭击，也不该白跑一轮 AI）。
    world.step_ship_event_at(SLOT_BASE + WINDOW_OPEN);
    assert!(world.ship_events.iter().all(|event| event.is_none()));
    assert!(world.monsters.is_empty());

    // 躲进船舱（源里的安全舱）：甲板仍然没人 ⇒ 依旧不刷。
    place(&mut world, "p1", "200090011");
    world.step_ship_event_at(SLOT_BASE + WINDOW_OPEN + 1);
    assert!(world.ship_events[0].is_none());
    assert!(balrog_ids(&world, "200090011").is_empty());

    // 走上甲板：下一拍起事件，且袭击只落在甲板上。
    place(&mut world, "p1", "200090010");
    world.step_ship_event_at(SLOT_BASE + WINDOW_OPEN + 2);
    assert!(world.ship_events[0].is_some());
    assert_eq!(balrog_ids(&world, "200090010").len(), 1);
    assert!(balrog_ids(&world, "200090011").is_empty());
}

#[test]
fn ship_event_fires_once_per_slot_then_resets_on_the_next_one() {
    let mut world = ship_event_world();
    let _rx = join_test_player(&mut world, "p1");
    place(&mut world, "p1", "200090010");
    world.step_ship_event_at(SLOT_BASE + WINDOW_OPEN);

    // 窗口内反复步进不重复刷。
    for offset in 1..60 {
        world.step_ship_event_at(SLOT_BASE + WINDOW_OPEN + offset);
    }
    assert_eq!(balrog_ids(&world, "200090010").len(), 1);

    // 窗口终点前仍在场上。
    world.step_ship_event_at(SLOT_BASE + WINDOW_CLOSE - 1);
    assert_eq!(balrog_ids(&world, "200090010").len(), 1);

    // 到窗口终点即撤离；本班次此后不再补刷——否则「撤离 ⇒ 甲板还有人 ⇒
    // 立刻重刷」会把一次袭击拉成无限循环。
    world.step_ship_event_at(SLOT_BASE + WINDOW_CLOSE);
    assert!(balrog_ids(&world, "200090010").is_empty());
    world.step_ship_event_at(SLOT_BASE + WINDOW_CLOSE + 1);
    assert!(
        balrog_ids(&world, "200090010").is_empty(),
        "一班只袭击一次"
    );

    // 下一班重新判定：甲板上还有人 ⇒ 新的一轮袭击。
    world.step_ship_event_at(SLOT_BASE + SHIP_SLOT_SECONDS + WINDOW_OPEN);
    assert_eq!(balrog_ids(&world, "200090010").len(), 1);
}

#[test]
fn ship_event_retreats_on_arrival_so_the_balrog_never_lands_with_the_passengers() {
    let mut world = ship_event_world();
    let _rx = join_test_player(&mut world, "p1");
    place(&mut world, "p1", "104020110");
    // 检票上船：登记进名单、落到甲板。
    assert_eq!(world.ship_board_at("p1", 0, SLOT_BASE + SHIP_SAIL_SECONDS), Ok(()));
    assert_eq!(world.players["p1"].map_id, "200090010");

    // 窗口开启 ⇒ 甲板有人，起袭击。
    world.step_ship_event_at(SLOT_BASE + WINDOW_OPEN);
    assert_eq!(balrog_ids(&world, "200090010").len(), 1);

    // 到站：先跑相位机（乘客被整单送到对岸站台），再跑事件步进——顺序与 tick
    // 一致（`step_ship` → `step_ship_event`）。
    world.step_ship_at(SLOT_BASE + SHIP_SLOT_SECONDS);
    world.step_ship_event_at(SLOT_BASE + SHIP_SLOT_SECONDS);
    assert_eq!(world.players["p1"].map_id, "200000100");
    assert!(world.ship_events[0].is_none());
    assert!(
        balrog_ids(&world, "200090010").is_empty(),
        "巴洛古不许跟着乘客上岸"
    );
    assert!(balrog_ids(&world, "200000100").is_empty());
}

#[test]
fn ship_event_removal_leaves_map_authored_monsters_alone() {
    let mut world = ship_event_world();
    let _rx = join_test_player(&mut world, "p1");
    place(&mut world, "p1", "200090010");
    // 甲板上另放一只普通怪，模拟地图自带 life。
    world
        .spawn_monster_on_map(
            "200090010".to_owned(),
            life_spawn("deck-snail", "200090010", -469.0, 1, 0),
        )
        .unwrap();
    assert_eq!(world.monsters.len(), 1);

    world.step_ship_event_at(SLOT_BASE + WINDOW_OPEN);
    assert_eq!(balrog_ids(&world, "200090010").len(), 1);
    assert_eq!(world.monsters.len(), 2);

    // 到窗口终点撤离：只清事件自己刷的那一只，地图自带的怪原样留下。
    world.step_ship_event_at(SLOT_BASE + WINDOW_CLOSE);
    assert!(balrog_ids(&world, "200090010").is_empty());
    assert_eq!(world.monsters.len(), 1, "地图自带的怪必须原样留下");
    assert!(world
        .monsters
        .values()
        .any(|monster| monster.spawn.id == "deck-snail"));
}

#[test]
fn ship_event_broadcasts_the_source_monster_name_to_the_deck() {
    let mut world = ship_event_world();
    let mut rx = join_test_player(&mut world, "p1");
    place(&mut world, "p1", "200090010");
    while rx.try_recv().is_ok() {}

    world.step_ship_event_at(SLOT_BASE + WINDOW_OPEN);
    let messages: Vec<serde_json::Value> = std::iter::from_fn(|| rx.try_recv().ok())
        .map(|message| serde_json::from_str(&message).unwrap())
        .collect();
    let attack = messages
        .iter()
        .find(|message| message["type"] == "shipEvent")
        .expect("必须播报袭击");
    assert_eq!(attack["event"], "balrog_attack");
    assert_eq!(attack["route"], "victoria-orbis");
    assert_eq!(attack["monsterId"], BALROG_TEMPLATE_ID);
    assert_eq!(attack["seconds"], BALROG_ATTACK_MAX_SEC);
    // 名字取自源名表（`String/Mob.json` → `shared/mob-names.json`），不是编的。
    assert_eq!(attack["monsterName"], "地獄巴洛古");
}

#[test]
fn ship_event_snapshot_field_rides_only_the_attacked_route() {
    let mut world = ship_event_world();
    let _rx = join_test_player(&mut world, "p1");
    place(&mut world, "p1", "200090010");
    world.step_ship_event_at(SLOT_BASE + WINDOW_OPEN);

    let field = world
        .ship_event_snapshot_field(0, SLOT_BASE + WINDOW_OPEN)
        .expect("航线 0 正在被袭击");
    assert_eq!(field["monsterId"], BALROG_TEMPLATE_ID);
    assert_eq!(field["secondsLeft"], BALROG_ATTACK_MAX_SEC);
    // 倒计时随槽内时间递减。
    assert_eq!(
        world.ship_event_snapshot_field(0, SLOT_BASE + WINDOW_OPEN + 30).unwrap()["secondsLeft"],
        BALROG_ATTACK_MAX_SEC - 30
    );
    // 没被袭击的航线不带 `event`，快照形态与之前完全一致。
    assert!(world
        .ship_event_snapshot_field(1, SLOT_BASE + WINDOW_OPEN)
        .is_none());
    // 到窗口终点即归零，不倒出负数。
    assert!(world
        .ship_event_snapshot_field(0, SLOT_BASE + WINDOW_CLOSE)
        .is_none());
}

#[test]
fn balrog_is_a_real_source_monster_and_ids_are_per_route() {
    // 模板 id 必须能在同版怪物名表里查到名字——本模块刷的是源怪，不是自造怪。
    assert_eq!(
        crate::auth::notebook::catalog().monster_label(BALROG_TEMPLATE_ID),
        Some("地獄巴洛古"),
    );
    assert_eq!(ship_balrog_spawn_id(0), "ship-balrog-0");
    // 耶雷弗线双向共用同一张甲板：两条航线的个体必须互不清理。
    assert_ne!(ship_balrog_spawn_id(2), ship_balrog_spawn_id(3));
}
