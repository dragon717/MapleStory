// Acceptance matrix for the platform sidewall collision contract
// (bugfix/MapleStory_Platform_Sidewall_Collision_Plan.md).
//
// Core invariant under test: for an authored solid sidewall belonging to a
// connected low/high platform contour, the body must never cross the wall's
// blocking side while its vertical extent still overlaps the wall, and
// switching between walk / ascend / descend must not change that wall's
// validity.
//
// The environment collision model is the existing foot-point proxy with the
// authored 50px body height used by `Foothold::blocks`.

const WALL_X: f64 = 200.0;
const LOW_Y: f64 = 200.0;
const HIGH_Y: f64 = 140.0;
const BODY_HEIGHT: f64 = 50.0;

/// Low platform y=200 joined by an authored vertical wall at x=200
/// (y=140..200) to the high platform y=140.  A deep floor keeps scenarios
/// deterministic when a body falls past the right edge.
fn step_map() -> Map {
    serde_json::from_str(
        r#"{"id":"step","bounds":{"xMin":0,"xMax":600,"yMin":-400,"yMax":600},"spawn":{"x":120,"y":200},"footholds":[
            {"id":1,"x1":0,"y1":200,"x2":200,"y2":200,"prev":0,"next":2},
            {"id":2,"x1":200,"y1":200,"x2":200,"y2":140,"prev":1,"next":3},
            {"id":3,"x1":200,"y1":140,"x2":400,"y2":140,"prev":2,"next":0},
            {"id":4,"x1":0,"y1":500,"x2":600,"y2":500,"prev":0,"next":0}
        ],"ladders":[]}"#,
    )
    .unwrap()
}

/// An unjumpable 500px wall at x=200 (y=100..600).  A body may only reach the
/// right side by entering above y=100.
fn tall_wall_map(spawn_x: f64, spawn_y: f64) -> Map {
    serde_json::from_value(serde_json::json!({
        "id": "tall",
        "bounds": {"xMin": -600, "xMax": 900, "yMin": -900, "yMax": 900},
        "spawn": {"x": spawn_x, "y": spawn_y},
        "footholds": [
            {"id": 1, "x1": 0, "y1": 600, "x2": 200, "y2": 600, "prev": 0, "next": 2},
            {"id": 2, "x1": 200, "y1": 600, "x2": 200, "y2": 100, "prev": 1, "next": 3},
            {"id": 3, "x1": 200, "y1": 100, "x2": 500, "y2": 100, "prev": 2, "next": 0},
            {"id": 4, "x1": -600, "y1": 800, "x2": 900, "y2": 800, "prev": 0, "next": 0}
        ],
        "ladders": []
    }))
    .unwrap()
}

/// The same tall wall, plus a ledge at y=50 that runs across it.  A body
/// walking that ledge is entirely above the wall top and must not be blocked.
fn over_wall_map() -> Map {
    serde_json::from_value(serde_json::json!({
        "id": "over",
        "bounds": {"xMin": -600, "xMax": 900, "yMin": -900, "yMax": 900},
        "spawn": {"x": 160, "y": 50},
        "footholds": [
            {"id": 1, "x1": 0, "y1": 600, "x2": 200, "y2": 600, "prev": 0, "next": 2},
            {"id": 2, "x1": 200, "y1": 600, "x2": 200, "y2": 100, "prev": 1, "next": 3},
            {"id": 3, "x1": 200, "y1": 100, "x2": 500, "y2": 100, "prev": 2, "next": 0},
            {"id": 4, "x1": -600, "y1": 800, "x2": 900, "y2": 800, "prev": 0, "next": 0},
            {"id": 5, "x1": 0, "y1": 50, "x2": 500, "y2": 50, "prev": 0, "next": 0}
        ],
        "ladders": []
    }))
    .unwrap()
}

/// Two platforms that overlap only in their x-projection and share no authored
/// topology.  No wall may be synthesised between them.
fn stacked_map() -> Map {
    serde_json::from_str(
        r#"{"id":"stacked","bounds":{"xMin":0,"xMax":600,"yMin":-400,"yMax":600},"spawn":{"x":100,"y":300},"footholds":[
            {"id":1,"x1":0,"y1":300,"x2":300,"y2":300,"prev":0,"next":0},
            {"id":2,"x1":100,"y1":180,"x2":500,"y2":180,"prev":0,"next":0},
            {"id":3,"x1":0,"y1":520,"x2":600,"y2":520,"prev":0,"next":0}
        ],"ladders":[]}"#,
    )
    .unwrap()
}

struct Harness {
    world: World,
    seq: u64,
    /// Snapshot broadcast channel.  It must be drained every tick: the world
    /// treats a full output queue as a dead peer and drops the player.
    rx: mpsc::Receiver<String>,
}

impl Harness {
    fn new(map: Map) -> Self {
        let mut world = World::new_with_gameplay(map, 600, Gameplay::default());
        let rx = join_test_player(&mut world, "p");
        Harness { world, seq: 0, rx }
    }

    fn drain(&mut self) {
        while self.rx.try_recv().is_ok() {}
    }

    /// Join starts the body airborne; let it settle on its spawn platform.
    fn settle(&mut self) {
        for _ in 0..60 {
            self.tick(0, 0, false);
            if self.world.players["p"].state.grounded {
                break;
            }
        }
    }

    fn tick(&mut self, direction: i8, vertical: i8, jump: bool) -> (f64, f64) {
        self.seq += 1;
        let seq = self.seq;
        self.world.command(Command::Input {
            id: "p".into(),
            connection: "p-connection".into(),
            message: ClientMessage::Input {
                seq,
                direction,
                vertical,
                jump,
            },
        });
        self.world.step();
        self.drain();
        let p = &self.world.players["p"];
        (p.state.x, p.state.y)
    }

    /// Hold a constant input, returning the (x, y) trace of every tick.
    fn hold(&mut self, direction: i8, jump_on_first: bool, ticks: u64) -> Vec<(f64, f64)> {
        let mut trace = Vec::new();
        for i in 0..ticks {
            let jumped = jump_on_first && i == 0;
            trace.push(self.tick(direction, 0, jumped));
        }
        trace
    }

    fn pos(&self) -> (f64, f64) {
        let p = &self.world.players["p"];
        (p.state.x, p.state.y)
    }
}

/// Assert the core invariant along a trace: the body never crossed `wall_x`
/// while its vertical extent overlapped the wall at the moment of contact.
///
/// The overlap is evaluated at the interpolated contact time, not at the tick
/// boundary — a body falling fast can drop past a wall top inside one tick,
/// and a solver that only looks at the tick-start position misses it.
/// Stopping exactly *at* the wall plane is correct blocking, not a crossing.
fn assert_no_tunneling(
    label: &str,
    start: (f64, f64),
    trace: &[(f64, f64)],
    wall_x: f64,
    top: f64,
    bottom: f64,
) {
    const CROSS_EPSILON: f64 = 1e-6;
    let mut prev = start;
    for (i, &(x, y)) in trace.iter().enumerate() {
        let lo = prev.0.min(x);
        let hi = prev.0.max(x);
        let crossed = lo <= wall_x && hi > wall_x + CROSS_EPSILON;
        if crossed && (x - prev.0).abs() > CROSS_EPSILON {
            let t = ((wall_x - prev.0) / (x - prev.0)).clamp(0.0, 1.0);
            let contact_y = prev.1 + (y - prev.1) * t;
            let body_top = contact_y - BODY_HEIGHT;
            let body_bottom = contact_y - 1.0;
            let overlaps = body_bottom >= top && body_top <= bottom;
            assert!(
                !overlaps,
                "{label}: body tunneled through the wall at x={wall_x} on tick {i}: \
                 ({:.2},{:.2}) -> ({:.2},{:.2}); at contact y={:.2} body [{:.2},{:.2}] \
                 overlaps wall [{top},{bottom}]",
                prev.0, prev.1, x, y, contact_y, body_top, body_bottom
            );
        }
        prev = (x, y);
    }
}

#[test]
fn t01_grounded_walk_still_blocked_by_the_same_wall() {
    let mut h = Harness::new(step_map());
    h.settle();
    let start = h.pos();
    let trace = h.hold(1, false, 40);
    assert_no_tunneling("T01 walk", start, &trace, WALL_X, HIGH_Y, LOW_Y);
    let (x, y) = h.pos();
    assert!(x <= WALL_X + 0.5, "walker must stop at the wall, got x={x}");
    assert!((y - LOW_Y).abs() < 1.0, "walker must stay on the low platform, y={y}");
    assert!(h.world.players["p"].state.grounded);
}

#[test]
fn t02_ascending_into_the_wall_keeps_rising_but_stops_horizontally() {
    let mut h = Harness::new(step_map());
    h.settle();
    h.hold(1, false, 40);
    let start = h.pos();
    let start_y = start.1;
    let trace = h.hold(1, true, 12);
    assert_no_tunneling("T02 ascend", start, &trace, WALL_X, HIGH_Y, LOW_Y);
    let min_y = trace.iter().map(|(_, y)| *y).fold(f64::MAX, f64::min);
    assert!(
        min_y < start_y - 20.0,
        "vertical rise must continue while the wall blocks horizontally: {start_y} -> {min_y}"
    );
}

#[test]
fn t03_descending_into_the_wall_keeps_falling_but_stops_horizontally() {
    // Spawn in mid-air beside the tall wall, below its top, then hold right.
    // The wall must stop the horizontal drift while the fall continues.
    let mut h = Harness::new(tall_wall_map(WALL_X - 12.0, 300.0));
    let start = h.pos();
    let start_y = start.1;
    let trace = h.hold(1, false, 40);
    assert_no_tunneling("T03 descend", start, &trace, WALL_X, 100.0, 600.0);
    let (x, y) = h.pos();
    assert!(
        x <= WALL_X + 0.5,
        "a descending body must be stopped by the wall, reached x={x}"
    );
    assert!(
        y > start_y + 100.0,
        "the fall must continue while the wall blocks horizontally: {start_y} -> {y}"
    );
}

#[test]
fn t05_body_fully_above_the_wall_top_can_pass() {
    // Walk a ledge at y=50 that crosses the tall wall (top y=100).  The body
    // is entirely above the wall, so nothing may stop it.
    let mut h = Harness::new(over_wall_map());
    h.settle();
    let (_, start_y) = h.pos();
    assert!(
        start_y < 100.0,
        "precondition: walker must be above the wall top, y={start_y}"
    );
    let start = h.pos();
    let trace = h.hold(1, false, 12);
    assert_no_tunneling("T05 clear the top", start, &trace, WALL_X, 100.0, 600.0);
    let max_x = trace.iter().map(|(x, _)| *x).fold(f64::MIN, f64::max);
    assert!(
        max_x > WALL_X + 1.0,
        "a body above the wall top must be allowed over it, reached x={max_x}"
    );
}

#[test]
fn t06_holding_toward_the_wall_does_not_stick_or_launch() {
    let mut h = Harness::new(step_map());
    h.settle();
    h.hold(1, false, 40);
    let mut start = h.pos();
    for _ in 0..6 {
        let trace = h.hold(1, true, 30);
        assert_no_tunneling("T06 repeated jumps", start, &trace, WALL_X, HIGH_Y, LOW_Y);
        start = h.pos();
    }
}

#[test]
fn t07_moving_away_from_the_wall_is_immediate() {
    let mut h = Harness::new(step_map());
    h.settle();
    h.hold(1, false, 40);
    let pinned = h.pos().0;
    let trace = h.hold(-1, false, 10);
    let (x, _) = h.pos();
    let _ = trace;
    assert!(
        x < pinned - 10.0,
        "leaving the wall must not be absorbed by tolerance: {pinned} -> {x}"
    );
}

#[test]
fn t09_fast_descent_past_the_wall_top_does_not_tunnel() {
    // Sweep the spawn offset so the body reaches the wall plane at every phase
    // of a fast fall.  A single-tick vertical step is up to ~33px, so a solver
    // that judges the wall's vertical overlap only at the tick start can miss a
    // contact that happens mid-step.
    for offset in 60..=140 {
        let mut h = Harness::new(tall_wall_map(WALL_X - offset as f64, -400.0));
        let start = h.pos();
        let trace = h.hold(1, false, 60);
        assert_no_tunneling(
            &format!("T09 descent offset={offset}"),
            start,
            &trace,
            WALL_X,
            100.0,
            600.0,
        );
    }
}

#[test]
fn t11_overlapping_platforms_without_topology_generate_no_wall() {
    let mut h = Harness::new(stacked_map());
    h.settle();
    let trace = h.hold(1, false, 60);
    let max_x = trace.iter().map(|(x, _)| *x).fold(f64::MIN, f64::max);
    assert!(
        max_x > 300.0,
        "no synthesised wall may stop a walker under an unconnected platform, stopped at x={max_x}"
    );
}

#[test]
fn t13_wall_chain_geometry_is_resolved_from_authored_neighbours() {
    let map = step_map();
    assert_eq!(map.wall_for(1, false, LOW_Y), WALL_X);
    assert_eq!(map.chain_wall_for(1, false, LOW_Y), Some(WALL_X));
    assert_eq!(map.chain_wall_for(1, false, 170.0), Some(WALL_X));
    // Once the body is entirely above the wall top it must not be blocked.
    assert_eq!(map.chain_wall_for(1, false, HIGH_Y - 1.0), None);
}
