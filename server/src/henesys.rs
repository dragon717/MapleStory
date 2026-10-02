//! 初弦地 uses isolated 2D arc-distance rails so existing gameplay range checks
//! stay authoritative. Junctions join only spatially identical Blender nodes.
use super::*;
use std::sync::OnceLock;
#[derive(Deserialize)]
struct Node {
    name: String,
    x: f64,
    y: f64,
    position: [f64; 3],
}
#[derive(Deserialize)]
struct Route {
    name: String,
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
    name: String,
    entries: Vec<Entry>,
}
#[derive(Deserialize)]
struct Layout {
    #[serde(rename = "pixelsPerMetre")]
    pixels_per_metre: f64,
    #[serde(default, rename="directionSlots")]
    direction_slots: bool,
    routes: Vec<Route>,
    junctions: Vec<Junction>,
}
pub(super) fn pixels_per_metre() -> f64 { layout().pixels_per_metre }
fn layout() -> &'static Layout {
    static DATA: OnceLock<Layout> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!("../../shared/chuxian-east.json"))
            .expect("east village authority")
    })
}
fn layout_for(map: &Map) -> &'static Layout {
    if map.id != "200000000" { return layout(); }
    static CITY: OnceLock<Layout> = OnceLock::new();
    CITY.get_or_init(|| serde_json::from_str(include_str!("../../shared/sky-city.json")).expect("sky city authority"))
}
pub(super) fn active(map: &Map) -> bool {
    (map.id == "100000000" && map.footholds.iter().any(|f| f.id == 920001))
        || (map.id == "200000000" && map.footholds.iter().any(|f| f.id == 930001))
}
fn route_in(data: &Layout, x: f64) -> Option<usize> {
    data.routes.iter().position(|r| x >= r.start && x <= r.end)
}
#[cfg(test)]
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
fn turn(
    data: &Layout,
    route: usize,
    x: f64,
    input: [f64; 2],
    view: Option<crate::protocol::MovementView>,
) -> Option<Turn> {
    if data.direction_slots {
        for (junction, j) in data.junctions.iter().enumerate() {
            if !j.entries.iter().any(|e|e.route==route && (e.x-x).abs()<=55.) { continue; }
            let directions=[[0.,-1.],[0.,1.],[-1.,0.],[1.,0.],[-1.,-1.],[1.,-1.],[-1.,1.],[1.,1.]];
            let mut exits=Vec::new();
            for e in &j.entries {
                let r=&data.routes[e.route];
                for (i,n) in r.nodes.iter().enumerate().filter(|(_,n)|(n.x-e.x).abs()<0.01) {
                    for side in [-1i8,1] {
                        let other=if side<0 {i.checked_sub(1).map(|k|&r.nodes[k])} else {r.nodes.get(i+1)};
                        if let Some(other)=other { exits.push((e,side,screen_tangent(n,other,view))); }
                    }
                }
            }
            // Crowded courtyards can have seven exits within one screen quadrant.
            // Give every authored exit a distinct displayed key direction; no road is silently lost.
            let mut scores=Vec::new();
            for (i,(_,_,t)) in exits.iter().enumerate() {for (d,v) in directions.iter().enumerate(){scores.push((((t[0]*v[0]+t[1]*v[1])/f64::hypot(v[0],v[1])*1e9).round() as i64,i,d));}}
            scores.sort_by(|a,b|b.0.cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
            let mut assigned=vec![false;exits.len()];let mut used=[false;8];
            for (_,i,d) in scores {if assigned[i]||used[d]{continue;}assigned[i]=true;used[d]=true;
                if directions[d]==input {let (e,side,_)=exits[i];return Some(Turn{route:e.route,x:e.x+side as f64*0.1,y:e.y,direction:side,junction});}
            }
        }
        return None;
    }
    let mut best = None;
    let mut score = 0.25;
    for (junction, j) in data.junctions.iter().enumerate() {
        if !j
            .entries
            .iter()
            .any(|e| e.route == route && (e.x - x).abs() <= 55.0)
        {
            continue;
        }
        for e in &j.entries {
            let r = &data.routes[e.route];
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
                    let t = screen_tangent(n, other, view);
                    let s = t[0] * input[0] + t[1] * input[1];
                    if s > score + 0.001 || (best.as_ref().is_some_and(|choice: &Turn| choice.route == route) && e.route != route && s >= score - 0.001) {
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
fn screen_tangent(a: &Node, b: &Node, view: Option<crate::protocol::MovementView>) -> [f64; 2] {
    let Some(view) = view else {
        return tangent(a, b);
    };
    let dx = b.position[0] - a.position[0];
    let dy = b.position[1] - a.position[1];
    let dz = b.position[2] - a.position[2];
    let right = dx * view.yaw.cos() - dz * view.yaw.sin();
    let down =
        (dx * view.yaw.sin() + dz * view.yaw.cos()) * view.pitch.sin() - dy * view.pitch.cos();
    let len = right.hypot(down).max(1e-9);
    [right / len, down / len]
}
fn walk_direction(
    r: &Route,
    x: f64,
    horizontal: i8,
    vertical: i8,
    view: Option<crate::protocol::MovementView>,
) -> i8 {
    if horizontal == 0 && vertical == 0 {
        return 0;
    }
    let (a, b) = segment(r, x);
    if view.is_none() {
        if horizontal != 0 {
            return horizontal;
        }
        let depth = tangent(a, b)[1];
        return if depth.abs() > 0.25 {
            (depth * vertical as f64).signum() as i8
        } else {
            -vertical
        };
    }
    let t = screen_tangent(a, b, view);
    // Near a screen-vertical/horizontal road, the other axis still walks along it.
    let score = if vertical == 0 && t[0].abs() < 0.15 {
        t[1] * horizontal as f64
    } else if horizontal == 0 && t[1].abs() < 0.15 {
        -t[0] * vertical as f64
    } else {
        t[0] * horizontal as f64 + t[1] * vertical as f64
    };
    if score.abs() > 1e-9 {
        score.signum() as i8
    } else {
        if horizontal != 0 {
            horizontal
        } else {
            -vertical
        }
    }
}

/// Run before accepting players; check actual directional exits, not just declared links.
pub(super) fn validate_paths() -> Result<(), String> {
    validate_layout(layout())?;
    let city: Layout = serde_json::from_str(include_str!("../../shared/sky-city.json")).map_err(|e|e.to_string())?;
    validate_layout(&city)
}
fn validate_layout(data: &Layout) -> Result<(), String> {
    use std::collections::{BTreeMap, BTreeSet};
    let fail = |detail: String| format!("初弦地路径错误：{detail}");
    if data.routes.is_empty() {
        return Err(fail("道路为空".into()));
    }
    let mut named: BTreeMap<&str, ([f64; 3], BTreeSet<usize>)> = BTreeMap::new();
    for (ri, r) in data.routes.iter().enumerate() {
        if r.nodes.len() < 2 || !r.start.is_finite() || !r.end.is_finite() || r.start >= r.end {
            return Err(fail(format!("{} 的道路范围无效", r.name)));
        }
        if r.start != r.nodes[0].x || r.end != r.nodes.last().unwrap().x {
            return Err(fail(format!("{} 的端点与道路范围不一致", r.name)));
        }
        for n in &r.nodes {
            if !n.x.is_finite() || !n.y.is_finite() || n.position.iter().any(|v| !v.is_finite()) {
                return Err(fail(format!("{} / {} 的坐标无效", r.name, n.name)));
            }
            let (position, routes) = named
                .entry(&n.name)
                .or_insert((n.position, BTreeSet::new()));
            if *position != n.position {
                return Err(fail(format!("{} 同名路口位置不一致", n.name)));
            }
            routes.insert(ri);
        }
        for pair in r.nodes.windows(2) {
            if pair[0].x >= pair[1].x
                || (pair[1].position[0] - pair[0].position[0])
                    .hypot(pair[1].position[2] - pair[0].position[2])
                    <= 1e-6
            {
                return Err(fail(format!("{} 有零长或倒序路段", r.name)));
            }
        }
        if ri > 0 && r.start <= data.routes[ri - 1].end {
            return Err(fail(format!("{} 的权威坐标范围重叠", r.name)));
        }
        if r.closed && r.nodes[0].position != r.nodes.last().unwrap().position {
            return Err(fail(format!("{} 环路首尾未闭合", r.name)));
        }
    }
    let mut junction_names = BTreeSet::new();
    for j in &data.junctions {
        if !junction_names.insert(j.name.as_str()) {
            return Err(fail(format!("{} 重复声明路口", j.name)));
        }
        let Some((_, expected)) = named.get(j.name.as_str()) else {
            return Err(fail(format!("{} 缺少道路节点", j.name)));
        };
        let mut actual = BTreeSet::new();
        for e in &j.entries {
            let Some(r) = data.routes.get(e.route) else {
                return Err(fail(format!("{} 引用了不存在的道路", j.name)));
            };
            if !r
                .nodes
                .iter()
                .any(|n| n.name == j.name && n.x == e.x && n.y == e.y)
            {
                return Err(fail(format!("{} 与 {} 的连接坐标不一致", j.name, r.name)));
            }
            actual.insert(e.route);
        }
        if actual.len() < 2 || &actual != expected {
            return Err(fail(format!("{} 的道路连接缺失", j.name)));
        }
    }
    for (name, (_, roads)) in &named {
        if roads.len() > 1 && !junction_names.contains(name) {
            return Err(fail(format!("{name} 看似相连却未声明路口")));
        }
    }
    // Check the same selector in 2D and at the supported 3D view limits.
    let views = std::iter::once(None).chain([-0.45, 0.0, 0.45].into_iter().flat_map(|yaw| {
        [0.08, 0.4, 0.6, 1.4]
            .into_iter()
            .map(move |pitch| Some(crate::protocol::MovementView { yaw, pitch }))
    }));
    for view in views {
        let mut edges = vec![BTreeSet::new(); data.routes.len()];
        for j in &data.junctions {
            for e in &j.entries {
                for input in [
                    [-1., 0.],
                    [1., 0.],
                    [0., -1.],
                    [0., 1.],
                    [-1., -1.],
                    [1., -1.],
                    [-1., 1.],
                    [1., 1.],
                ] {
                    if let Some(choice) = turn(data, e.route, e.x, input, view) {
                        edges[e.route].insert(choice.route);
                    }
                }
            }
        }
        // A legitimate building loop is fine; a one-way component with no way back is not.
        for origin in 0..data.routes.len() {
            let mut reached = BTreeSet::from([origin]);
            let mut pending = vec![origin];
            while let Some(ri) = pending.pop() {
                for next in &edges[ri] {
                    if reached.insert(*next) {
                        pending.push(*next);
                    }
                }
            }
            if let Some(missing) = (0..data.routes.len()).find(|ri| !reached.contains(ri)) {
                return Err(fail(format!(
                    "{} 无法到达或返回 {}，存在断路或无法退出的环 (视角 {:?})",
                    data.routes[origin].name, data.routes[missing].name, view
                )));
            }
        }
    }
    Ok(())
}

pub(super) fn teleport(
    map: &Map,
    player: &Player,
    horizontal: f64,
    vertical_distance: f64,
    direction: i8,
    vertical: i8,
) -> Result<TeleportPlan, String> {
    let data = layout_for(map);
    let old_route = route_in(data, player.state.x).ok_or("teleport_blocked")?;
    let mut route = old_route;
    let mut x = player.state.x;
    let mut junction = player.east_junction;
    let mut sign = if player.east_horizontal == direction
        && player.east_vertical == vertical
        && player.east_walk != 0
    {
        player.east_walk
    } else {
        walk_direction(
            &data.routes[route],
            x,
            direction,
            vertical,
            player.east_view,
        )
    };
    if (direction != 0 || vertical != 0) && player.state.grounded {
        if let Some(choice) = turn(
            data,
            route,
            x,
            [direction as f64, vertical as f64],
            player.east_view,
        )
        .filter(|c| {
            player.east_horizontal != direction
                || player.east_vertical != vertical
                || Some(c.junction) != junction
        }) {
            route = choice.route;
            x = choice.x;
            junction = Some(choice.junction);
            sign = choice.direction;
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
        east: Some((sign, direction, vertical, junction)),
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
    if let Some(i) = route_in(layout_for(map), x) {
        (x, ground(&layout_for(map).routes[i], x))
    } else {
        (map.spawn.x, map.spawn.y)
    }
}
pub(super) fn reset(player: &mut Player) {
    player.east_view = None;
    player.east_turn_until = 0;
    player.east_horizontal = 0;
    player.east_vertical = 0;
    player.east_walk = 0;
    player.east_junction = None;
}
pub(super) fn step(map: &Map, player: &mut Player, tick: u64) {
    let data = layout_for(map);
    let mut ri = route_in(data, player.state.x).unwrap_or(0);
    if route_in(data, player.state.x).is_none() {
        player.state.x = map.spawn.x;
        player.state.y = map.spawn.y;
        player.state.grounded = true;
    }
    let input_changed =
        player.direction != player.east_horizontal || player.vertical != player.east_vertical;
    if input_changed {
        player.east_horizontal = player.direction;
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
    // Four direction keys choose spatial exits; held input keeps the chosen arc sign through curves.
    let input = [player.direction as f64, player.vertical as f64];
    if (player.direction != 0 || player.vertical != 0)
        && player.state.grounded
        && player.chair.is_none()
        && (input_changed || tick >= player.east_turn_until)
        && tick >= player.knockback_until
    {
        if let Some(choice) = turn(data, ri, player.state.x, input, player.east_view)
            .filter(|c| Some(c.junction) != player.east_junction)
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
    if player.east_walk == 0 {
        player.east_walk = walk_direction(
            r,
            player.state.x,
            player.direction,
            player.vertical,
            player.east_view,
        );
    }
    let sign = player.east_walk as f64;
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
    fn sky_city_routes_and_turns() {
        let data: Layout = serde_json::from_str(include_str!("../../shared/sky-city.json")).unwrap();
        validate_layout(&data).unwrap();
        assert!(data.direction_slots);
        let directions=[("up",[0.,-1.]),("down",[0.,1.]),("left",[-1.,0.]),("right",[1.,0.]),("upLeft",[-1.,-1.]),("upRight",[1.,-1.]),("downLeft",[-1.,1.]),("downRight",[1.,1.])];
        let views=[None,Some(crate::protocol::MovementView{yaw:0.,pitch:0.24}),Some(crate::protocol::MovementView{yaw:-0.45,pitch:0.08}),Some(crate::protocol::MovementView{yaw:0.45,pitch:0.46})];
        let mut samples=Vec::new();
        for j in &data.junctions {for e in &j.entries {for delta in [-55.0001,-55.,0.,55.,55.0001] {for view in views {
            let x=e.x+delta;
            let choices:Vec<_>=directions.iter().filter_map(|(key,input)|route_in(&data,x).and_then(|r|turn(&data,r,x,*input,view)).filter(|c|Some(c.route)!=route_in(&data,x)).map(|_|*key)).collect();
            samples.push(serde_json::json!({"x":x,"view":view.map(|v|serde_json::json!({"yaw":v.yaw,"pitch":v.pitch})),"choices":choices}));
        }}}}
        println!("CITY_JUNCTION_CHOICES={}",serde_json::to_string(&samples).unwrap());
    }
    #[test]
    fn east_startup_rejects_broken_paths_and_accepts_real_loops() {
        validate_paths().unwrap();
        let load = || {
            serde_json::from_str::<Layout>(include_str!("../../shared/chuxian-east.json")).unwrap()
        };
        let mut broken = load();
        broken.junctions[0].entries[0].route = broken.routes.len();
        assert!(validate_layout(&broken)
            .unwrap_err()
            .contains("不存在的道路"));
        let mut broken = load();
        broken.junctions.remove(0);
        assert!(validate_layout(&broken).unwrap_err().contains("未声明路口"));
        let mut broken = load();
        broken.routes[0].nodes[1].x = broken.routes[0].nodes[0].x;
        assert!(validate_layout(&broken).unwrap_err().contains("零长或倒序"));
        // Break a ring while keeping its nonzero segments and endpoint ranges valid.
        let mut broken = load();
        let ring = broken.routes.iter_mut().find(|r| r.closed).unwrap();
        ring.nodes.last_mut().unwrap().name = "broken-ring-end".into();
        ring.nodes.last_mut().unwrap().position[0] += 1.;
        assert!(validate_layout(&broken).unwrap_err().contains("首尾未闭合"));
        // Keep a disconnected road internally valid, but remove all of its shared nodes.
        let mut broken = load();
        let isolated = broken.routes.len() - 1;
        for n in &mut broken.routes[isolated].nodes {
            n.name = format!("isolated-{}", n.name);
        }
        for j in &mut broken.junctions {
            j.entries.retain(|e| e.route != isolated);
        }
        broken.junctions.retain(|j| {
            j.entries
                .iter()
                .map(|e| e.route)
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                > 1
        });
        assert!(validate_layout(&broken)
            .unwrap_err()
            .contains("无法到达或返回"));
    }
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
        let views = [
            None,
            Some(crate::protocol::MovementView {
                yaw: 0.,
                pitch: 0.4,
            }),
            Some(crate::protocol::MovementView {
                yaw: -0.45,
                pitch: 0.08,
            }),
            Some(crate::protocol::MovementView {
                yaw: 0.45,
                pitch: 1.4,
            }),
        ];
        let samples: Vec<_> = positions
            .into_iter()
            .flat_map(|x| views.into_iter().map(move |view| {
                let mut hinted = std::collections::BTreeSet::new();
                let choices: Vec<_> = [
                    ("up", [0., -1.]),
                    ("down", [0., 1.]),
                    ("left", [-1., 0.]),
                    ("right", [1., 0.]),
                    ("upLeft", [-1., -1.]),
                    ("upRight", [1., -1.]),
                    ("downLeft", [-1., 1.]),
                    ("downRight", [1., 1.]),
                ]
                .into_iter()
                .filter_map(|(key, input)| {
                    route_at(x)
                        .and_then(|route| turn(layout(), route, x, input, view))
                        .and_then(|choice| {
                            let fresh = hinted.insert(choice.route);
                            (key.len() <= 5 || fresh).then_some(key)
                        })
                })
                .collect();
                serde_json::json!({ "x": x, "view": view.map(|v| serde_json::json!({"yaw": v.yaw, "pitch": v.pitch})), "choices": choices })
            }))
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
        assert!(turn(d, 0, x, [0.0, -1.0], None).is_some());
        assert!(turn(d, 0, x + 100.0, [0.0, -1.0], None).is_none());
    }
}
