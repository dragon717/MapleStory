//! 初弦地 uses isolated 2D arc-distance rails so existing gameplay range checks
//! stay authoritative. Junctions join only spatially identical Blender nodes.
use super::*;
use std::sync::OnceLock;
#[derive(Deserialize)]
struct Node {
    x: f64,
    y: f64,
    position: [f64; 3],
}
#[derive(Deserialize)]
struct Route {
    start: f64,
    end: f64,
    #[serde(rename = "loop")]
    closed: bool,
    nodes: Vec<Node>,
}
#[derive(Deserialize)]
struct Entry {
    route: usize,
    x: f64,
    y: f64,
}
#[derive(Deserialize)]
struct Junction {
    entries: Vec<Entry>,
}
#[derive(Deserialize)]
struct Layout {
    routes: Vec<Route>,
    junctions: Vec<Junction>,
}
fn layout() -> &'static Layout {
    static DATA: OnceLock<Layout> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!("../../shared/chuxian-east.json"))
            .expect("east village authority")
    })
}
pub(super) fn active(map: &Map) -> bool {
    map.id == "100000000" && map.footholds.iter().any(|f| f.id == 920001)
}
fn route_at(x: f64) -> Option<usize> {
    layout()
        .routes
        .iter()
        .position(|r| x >= r.start && x <= r.end)
}
fn segment(r: &Route, x: f64) -> (&Node, &Node) {
    let i = r
        .nodes
        .iter()
        .skip(1)
        .position(|n| x <= n.x)
        .unwrap_or(r.nodes.len() - 2);
    (&r.nodes[i], &r.nodes[i + 1])
}
fn ground(r: &Route, x: f64) -> f64 {
    let (a, b) = segment(r, x);
    a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x)
}
fn tangent(a: &Node, b: &Node) -> [f64; 2] {
    let dx = b.position[0] - a.position[0];
    let dz = b.position[2] - a.position[2];
    let len = dx.hypot(dz);
    [dx / len, dz / len]
}
/// Only server input chooses a branch; no target, coordinates or route id arrive from the client.
struct Turn {
    route: usize,
    x: f64,
    y: f64,
    direction: i8,
    junction: usize,
}
fn turn(route: usize, x: f64, input: [f64; 2]) -> Option<Turn> {
    let mut best = None;
    let mut score = 0.25;
    for (junction, j) in layout().junctions.iter().enumerate() {
        if !j
            .entries
            .iter()
            .any(|e| e.route == route && (e.x - x).abs() <= 55.0)
        {
            continue;
        }
        for e in &j.entries {
            let r = &layout().routes[e.route];
            for (i, n) in r
                .nodes
                .iter()
                .enumerate()
                .filter(|(_, n)| (n.x - e.x).abs() < 0.01)
            {
                for side in [-1.0, 1.0] {
                    let neighbor = if side < 0.0 {
                        i.checked_sub(1).map(|k| &r.nodes[k])
                    } else {
                        r.nodes.get(i + 1)
                    };
                    let Some(other) = neighbor else { continue };
                    let t = tangent(n, other);
                    let s = t[0] * input[0] + t[1] * input[1];
                    if s > score + 0.001 {
                        score = s;
                        best = Some(Turn {
                            route: e.route,
                            x: e.x + side * 0.1,
                            y: e.y,
                            direction: side as i8,
                            junction,
                        });
                    }
                }
            }
        }
    }
    best.filter(|choice| choice.route != route)
}
fn vertical_direction(r: &Route, x: f64, vertical: i8) -> i8 {
    let (a, b) = segment(r, x);
    let depth = tangent(a, b)[1];
    if depth.abs() > 0.25 {
        (depth * vertical as f64).signum() as i8
    } else {
        -vertical
    }
}

pub(super) fn teleport(
    map: &Map,
    player: &Player,
    horizontal: f64,
    vertical_distance: f64,
    direction: i8,
    vertical: i8,
) -> Result<TeleportPlan, String> {
    let data = layout();
    let old_route = route_at(player.state.x).ok_or("teleport_blocked")?;
    let mut route = old_route;
    let mut x = player.state.x;
    let mut junction = player.east_junction;
    let mut sign = if direction != 0 {
        direction
    } else if player.east_vertical == vertical && player.east_walk != 0 {
        player.east_walk
    } else {
        vertical_direction(&data.routes[route], x, vertical)
    };
    if vertical != 0 && player.state.grounded {
        if let Some(choice) = turn(route, x, [0., vertical as f64])
            .filter(|c| player.east_vertical != vertical || Some(c.junction) != junction)
        {
            route = choice.route;
            x = choice.x;
            junction = Some(choice.junction);
            if direction == 0 {
                sign = choice.direction;
            }
        }
    }
    let r = &data.routes[route];
    let intended = x + sign as f64
        * if direction != 0 {
            horizontal
        } else {
            vertical_distance
        };
    let x = if r.closed {
        r.start + (intended - r.start).rem_euclid(r.end - r.start)
    } else {
        intended.clamp(r.start, r.end)
    };
    let hop = if player.state.grounded {
        0.
    } else {
        player.state.y - ground(&data.routes[old_route], player.state.x)
    };
    let y = ground(r, x) + hop;
    if (x - player.state.x).abs() < 0.001 && (y - player.state.y).abs() < 0.001 {
        return Err("teleport_blocked".into());
    }
    let foothold_id = map
        .footholds
        .iter()
        .find(|f| x >= f.x1 && x <= f.x2)
        .ok_or("teleport_blocked")?
        .id;
    Ok(TeleportPlan {
        colossus: None,
        east: Some((sign, vertical, junction)),
        map_id: map.id.clone(),
        x,
        y,
        grounded: player.state.grounded,
        foothold_id,
    })
}
pub(super) fn repair_position(map: &Map, x: f64, y: f64) -> (f64, f64) {
    if !active(map) {
        return (x, y);
    }
    if let Some(i) = route_at(x) {
        (x, ground(&layout().routes[i], x))
    } else {
        (map.spawn.x, map.spawn.y)
    }
}
pub(super) fn reset(player: &mut Player) {
    player.east_turn_until = 0;
    player.east_vertical = 0;
    player.east_walk = 0;
    player.east_junction = None;
}
pub(super) fn step(map: &Map, player: &mut Player, tick: u64) {
    let data = layout();
    let mut ri = route_at(player.state.x).unwrap_or(0);
    if route_at(player.state.x).is_none() {
        player.state.x = map.spawn.x;
        player.state.y = map.spawn.y;
        player.state.grounded = true;
    }
    if player.vertical != player.east_vertical {
        player.east_vertical = player.vertical;
        player.east_walk = 0;
        player.east_junction = None;
    }
    if let Some(junction) = player.east_junction {
        if !data.junctions[junction]
            .entries
            .iter()
            .any(|e| e.route == ri && (e.x - player.state.x).abs() <= 55.)
        {
            player.east_junction = None;
        }
    }
    // Left/right travel the arc; held up/down keep the arc direction chosen at entry through curves.
    let input = [0.0, player.vertical as f64];
    if player.vertical != 0
        && player.state.grounded
        && player.chair.is_none()
        && tick >= player.east_turn_until
        && tick >= player.knockback_until
    {
        if let Some(choice) =
            turn(ri, player.state.x, input).filter(|c| Some(c.junction) != player.east_junction)
        {
            ri = choice.route;
            player.state.x = choice.x;
            player.state.y = choice.y;
            player.east_walk = choice.direction;
            player.east_junction = Some(choice.junction);
            player.east_turn_until = tick + 6;
        }
    }
    let r = &data.routes[ri];
    let old_ground = ground(r, player.state.x);
    let (a, b) = segment(r, player.state.x);
    let t = tangent(a, b);
    if player.vertical != 0 && player.east_walk == 0 {
        player.east_walk = vertical_direction(r, player.state.x, player.vertical);
    }
    let sign = if player.direction != 0 {
        player.direction
    } else if player.vertical != 0 {
        player.east_walk
    } else {
        0
    } as f64;
    let slow = if player.status.slows_walk() { 0.5 } else { 1.0 };
    player.state.vx = if tick < player.knockback_until {
        player.knockback_vx
    } else if player.chair.is_some() {
        0.0
    } else {
        sign * mounts::walk_speed(player, player.move_speed) * slow
    };
    if player.state.vx != 0.0 {
        player.state.facing = if t[0] * player.state.vx < 0.0 { -1 } else { 1 };
    }
    if player.jump && player.state.grounded && player.chair.is_none() {
        player.state.vy = -mounts::jump_speed(player, JUMP_SPEED);
        player.state.grounded = false;
        player.drop_fh = 0;
    }
    player.jump = false;
    let intended = player.state.x + player.state.vx * TICK_MS as f64 / 1000.0;
    player.state.x = if r.closed {
        r.start + (intended - r.start).rem_euclid(r.end - r.start)
    } else {
        intended.clamp(r.start, r.end)
    };
    let new_ground = ground(r, player.state.x);
    // A hop retains its height above this road; parallel roads cannot catch it through their depth.
    if player.state.grounded {
        player.state.y = new_ground;
        player.state.vy = 0.0;
    } else {
        let cap = if tick < player.slow_fall_until {
            MAGIC_WAVE_SLOW_FALL_SPEED
        } else {
            FALL_SPEED
        };
        player.state.vy = (player.state.vy + GRAVITY * TICK_MS as f64 / 1000.0).min(cap);
        player.state.y += new_ground - old_ground + player.state.vy * TICK_MS as f64 / 1000.0;
        if player.state.vy >= 0.0 && player.state.y >= new_ground {
            player.state.y = new_ground;
            player.state.vy = 0.0;
            player.state.grounded = true;
        }
    }
    let fh = map
        .footholds
        .iter()
        .find(|f| player.state.x >= f.x1 && player.state.x <= f.x2)
        .expect("east route foothold");
    player.foothold_id = if player.state.grounded { fh.id } else { 0 };
    player.last_foothold_id = fh.id;
    player.state.climbing = false;
    player.state.ladder_id = None;
    player.swimming = false;
    player.fall_boundary_hold = false;
    if tick >= player.attack_until {
        player.state.action_id = None;
        let action = if player.chair.is_some() {
            "sit"
        } else if !player.state.grounded {
            "jump"
        } else if player.state.vx != 0.0 {
            "walk"
        } else {
            "stand"
        };
        if player.state.action != action {
            player.state.action_started_tick = tick;
        }
        player.state.action = action;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn east_junction_hint_parity() {
        let mut positions = vec![0.0, layout().routes[0].start];
        for junction in &layout().junctions {
            for entry in &junction.entries {
                for offset in [
                    -56.0, -55.0001, -55.0, -54.9999, -0.1, 0.0, 0.1, 54.9999, 55.0, 55.0001, 56.0,
                ] {
                    positions.push(entry.x + offset);
                }
            }
        }
        let samples: Vec<_> = positions
            .into_iter()
            .map(|x| {
                let choices: Vec<_> = [-1.0, 1.0]
                    .into_iter()
                    .filter_map(|vertical| {
                        route_at(x)
                            .and_then(|route| turn(route, x, [0.0, vertical]))
                            .map(|_| if vertical < 0.0 { "up" } else { "down" })
                    })
                    .collect();
                serde_json::json!({ "x": x, "choices": choices })
            })
            .collect();
        println!(
            "JUNCTION_CHOICES={}",
            serde_json::to_string(&samples).unwrap()
        );
    }
    #[test]
    fn east_routes_and_turns_are_authoritative() {
        let d = layout();
        assert_eq!(d.routes.len(), 16);
        for (i, r) in d.routes.iter().enumerate() {
            assert_eq!(route_at((r.start + r.end) / 2.0), Some(i));
            for n in &r.nodes {
                assert!((ground(r, n.x) - n.y).abs() < 1e-6);
            }
        }
        let mut reached = std::collections::BTreeSet::from([0]);
        loop {
            let before = reached.len();
            for j in &d.junctions {
                if j.entries.iter().any(|e| reached.contains(&e.route)) {
                    reached.extend(j.entries.iter().map(|e| e.route));
                }
            }
            if before == reached.len() {
                break;
            }
        }
        assert_eq!(reached.len(), 16, "all roads reachable from main street");
        let junction = d
            .junctions
            .iter()
            .find(|j| {
                j.entries.iter().any(|e| e.route == 0) && j.entries.iter().any(|e| e.route == 1)
            })
            .unwrap();
        let x = junction.entries.iter().find(|e| e.route == 0).unwrap().x;
        assert!(turn(0, x, [0.0, -1.0]).is_some());
        assert!(turn(0, x + 100.0, [0.0, -1.0]).is_none());
    }
}
