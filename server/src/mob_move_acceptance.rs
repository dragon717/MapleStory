// Directional acceptance for ground-monster movement (地面怪移动能力).
//
// The rule under test is a single source fact with a single default: a mob
// walks because it authored a `move` animation, and `Mob.wz/info/speed` is an
// optional offset on that walk, not the switch that turns it on.  The TMS273
// archive proves the default in bulk — 3111 of its 11614 mobs ship no `speed`
// node at all, 731 of those still author a `move`, and 541 others write the
// same value out as an explicit `0`.  The authored "stands still" form is the
// `-100` sentinel (城門/寶箱/訓練用木頭人/稻草人 all use exactly -100, and
// `Gameplay::validate` rejects anything below it).
//
// These checks exist because reading only `source_speed` froze 菇菇寶貝
// (1210102 — the 花蘑菇 of the bug report — plus its `info/link` twin 100004)
// in `stand` forever: both are placed on five maps, both own a three-frame
// `move`, and both omit `speed`.
//
//   * every monster actually deployed in the assembled catalog can move;
//   * the real 1210102 template walks in the world when it is not hit;
//   * a `-100` sentinel keeps its `move` animation but never walks;
//   * a template with neither a speed nor a move animation stays immobile, so
//     the new default is not "everything moves".

use super::*;

/// The shipped catalog, loaded the same way the server loads it at boot.
fn mushroom_gameplay() -> Gameplay {
    Gameplay::load(Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../shared/gameplay.json"
    )))
    .unwrap()
}

/// 菇菇寶貝 (1210102) with the movement fields the caller wants to exercise.
/// `drop` is cleared so the fixture is about walking, not loot.
fn mushroom_template(
    template_id: &str,
    speed: Option<f64>,
    move_duration_ms: Option<u64>,
) -> MonsterTemplate {
    let mut template = mushroom_gameplay()
        .monsters
        .into_iter()
        .find(|template| template.template_id == template_id)
        .expect("the 273 catalog must keep 菇菇寶貝");
    template.source_speed = speed;
    template.move_duration_ms = move_duration_ms;
    template.drop = None;
    template
}

/// The 菇菇寶貝 template placed on the shared two-segment test floor.
fn mushroom_world(template_id: &str, speed: Option<f64>, move_duration_ms: Option<u64>) -> World {
    let template = mushroom_template(template_id, speed, move_duration_ms);
    World::new_with_gameplay(
        map(),
        600,
        Gameplay {
            monsters: vec![template],
            spawns: vec![MonsterSpawn {
                id: "mushroom-1".into(),
                template_id: template_id.into(),
                x: 100.0,
                y: 100.0,
                foothold_id: Some(1),
                map_id: String::new(),
                facing: 1,
                mob_time: 0,
                rx0: None,
                rx1: None,
            }],
            ..Gameplay::default()
        },
    )
}

/// Park the fixture mob in `stand` at the middle of the first foothold so the
/// wander decision (not the spawn state) is what the test observes.
fn park_in_stand(world: &mut World) -> String {
    let id = world.monsters.keys().next().cloned().expect("fixture mob");
    let monster = world.monsters.get_mut(&id).unwrap();
    monster.state.action = "stand";
    monster.state.action_started_tick = 0;
    monster.state.x = 100.0;
    monster.state.facing = 1;
    monster.horizontal_speed = 0.0;
    monster.foothold_id = 1;
    id
}

fn advance(world: &mut World, from_tick: u64, ticks: u64) {
    for tick in from_tick..from_tick + ticks {
        world.tick = tick;
        world.step_monsters();
    }
}

/// The audit the bug report asked for: every template the assembled maps
/// actually place must be able to move.  The deployed surface is pinned so a
/// new map or mob forces this audit to be re-read instead of silently
/// inheriting an unverified assumption.
#[test]
fn every_deployed_monster_can_move() {
    let gameplay = mushroom_gameplay();
    let deployed: BTreeSet<&str> = gameplay
        .spawns
        .iter()
        .map(|spawn| spawn.template_id.as_str())
        .collect();
    assert_eq!(
        deployed.len(),
        17,
        "the deployed monster surface changed: {deployed:?}"
    );
    let mut immobile = Vec::new();
    for template_id in &deployed {
        let template = gameplay
            .monsters
            .iter()
            .find(|template| template.template_id == *template_id)
            .unwrap_or_else(|| panic!("spawn without template: {template_id}"));
        if !template.can_move() {
            immobile.push((*template_id).to_owned());
        }
    }
    assert!(
        immobile.is_empty(),
        "deployed monsters that cannot move: {immobile:?}"
    );
}

/// The regression itself: 1210102 and 100004 own a `move` animation but no
/// `info/speed`, so the absent node must resolve to the default offset
/// (`(0 + 100) * 0.001`) rather than to "no force at all".
#[test]
fn a_move_animation_without_a_speed_node_uses_the_default_offset() {
    let gameplay = mushroom_gameplay();
    for template_id in ["1210102", "100004"] {
        let template = gameplay
            .monsters
            .iter()
            .find(|template| template.template_id == template_id)
            .unwrap();
        assert!(
            template.source_speed.is_none(),
            "{template_id} must stay a no-`speed` source case"
        );
        assert!(template.move_duration_ms.is_some(), "{template_id} move anim");
        let force = template
            .movement_force()
            .unwrap_or_else(|| panic!("{template_id} cannot move"));
        assert!(
            (force - 0.1).abs() < 1e-12,
            "{template_id} must use the default 0 offset, got {force}"
        );
        assert!(template.can_move());
    }
}

/// Behaviour, not just arithmetic: the untouched 1210102 template leaves
/// `stand` at the authored decision boundary and actually displaces.
#[test]
fn a_mushroom_without_a_speed_node_walks() {
    let mut world = mushroom_world("1210102", None, Some(480));
    let id = park_in_stand(&mut world);
    // Just short of MOB_STAND_DECISION_MS (1700 ms): the mob must still be idle.
    advance(&mut world, 0, 34);
    assert_eq!(world.monsters[&id].state.action, "stand");
    assert_eq!(world.monsters[&id].state.x, 100.0);
    // Past the boundary it picks MOVE and integrates the default force.
    advance(&mut world, 34, 6);
    assert_eq!(world.monsters[&id].state.action, "move");
    let travelled = (world.monsters[&id].state.x - 100.0).abs();
    assert!(
        travelled > 1.0,
        "菇菇寶貝 must leave its spawn column, travelled {travelled}"
    );
}

/// The authored immobile form keeps its walk animation but never enters
/// `move`, and it never integrates a force either.
#[test]
fn a_sentinel_speed_monster_stays_where_it_stands() {
    let mut world = mushroom_world("1210102", Some(-100.0), Some(480));
    let id = park_in_stand(&mut world);
    assert!(
        !world.monsters[&id].template.can_move(),
        "speed -100 is the authored immobile form"
    );
    advance(&mut world, 0, 400);
    assert_eq!(world.monsters[&id].state.action, "stand");
    assert_eq!(world.monsters[&id].state.x, 100.0);
    assert_eq!(world.monsters[&id].horizontal_speed, 0.0);

    // Anything under the sentinel is rejected by `Gameplay::validate` before a
    // world ever sees it, so this pins the runtime's own guard: a negative
    // force used to integrate the mob backwards instead of leaving it alone.
    let below_floor = mushroom_template("1210102", Some(-120.0), Some(480));
    assert!(below_floor.movement_force().is_none());
    assert!(!below_floor.can_move());
}

/// The default is keyed on the `move` animation, not on "no speed": a template
/// with neither field stays immobile, and an authored speed still wins.
#[test]
fn no_move_animation_still_means_no_movement() {
    let mut world = mushroom_world("1210102", None, None);
    let id = park_in_stand(&mut world);
    assert!(!world.monsters[&id].template.can_move());
    advance(&mut world, 0, 400);
    assert_eq!(world.monsters[&id].state.action, "stand");
    assert_eq!(world.monsters[&id].state.x, 100.0);

    let mut walker = mushroom_world("1210102", Some(-65.0), Some(480));
    let id = park_in_stand(&mut walker);
    let force = walker.monsters[&id].template.movement_force().unwrap();
    assert!((force - 0.035).abs() < 1e-12, "authored speed must win");
    advance(&mut walker, 0, 40);
    assert_eq!(walker.monsters[&id].state.action, "move");
}
