#[test]
fn water_is_finite_enterable_and_swimmable_without_foothold_edges() {
    let bounds = Bounds {
        x_min: 0.0,
        x_max: 500.0,
        y_min: -100.0,
        y_max: 400.0,
    };
    let water = WaterRect {
        x_min: 0.0,
        x_max: 300.0,
        y_min: 224.0,
        y_max: 340.0,
        floor: Vec::new(),
    };
    assert!(water.valid(&bounds));
    assert!(!WaterRect {
        x_min: 0.0,
        x_max: f64::INFINITY,
        y_min: 224.0,
        y_max: 340.0,
        floor: Vec::new(),
    }
    .valid(&bounds));

    let map = Map {
        id: "water-test".into(),
        bounds,
        spawn: Point { x: 250.0, y: 200.0 },
        footholds: vec![Foothold {
            id: 1,
            x1: 0.0,
            y1: 200.0,
            x2: 500.0,
            y2: 200.0,
            prev: 0,
            next: 0,
            forbid_fall_down: 0,
        }],
        ladders: Vec::new(),
        portals: Vec::new(),
        water: vec![water],
    };
    assert!(map.validate().is_ok());
    assert!(map.water_below(1, 250.0));

    let mut world = World::new_with_gameplay(map.clone(), 600, Gameplay::default());
    let mut output = join_test_player(&mut world, "water");
    while output.try_recv().is_ok() {}
    world.step(); // Join starts airborne; settle before asking for a down-jump.
    world.command(Command::Input {
        id: "water".into(),
        connection: "water-connection".into(),
        message: ClientMessage::Input {
            seq: 1,
            direction: 0,
            vertical: 1,
            jump: true,
        },
    });
    for _ in 0..100 {
        world.step();
        if world.players["water"].swimming {
            break;
        }
    }
    assert!(world.players["water"].swimming);
    assert_eq!(world.players["water"].state.y, 224.0);
    assert_eq!(world.players["water"].state.action, "jump");

    let input = |world: &mut World, seq, direction, vertical, jump| {
        world.command(Command::Input {
            id: "water".into(),
            connection: "water-connection".into(),
            message: ClientMessage::Input {
                seq,
                direction,
                vertical,
                jump,
            },
        });
        world.step();
    };
    input(&mut world, 2, 1, 0, false);
    assert!(world.players["water"].state.x > 250.0);
    input(&mut world, 3, -1, 0, false);
    assert!(world.players["water"].state.x < 257.0);
    input(&mut world, 4, 0, -1, false);
    assert!(world.players["water"].state.y < 224.0 + 0.001);
    input(&mut world, 5, 0, 1, false);
    assert!(world.players["water"].state.y > 224.0);
    for seq in 6..40 {
        input(&mut world, seq, 0, 1, false);
    }
    assert_eq!(world.players["water"].state.y, 340.0);

    input(&mut world, 40, 1, 0, true);
    assert!(!world.players["water"].swimming);
    assert!(world.players["water"].state.vy < 0.0);
    assert_eq!(world.players["water"].state.action, "jump");

    // The pool edge is not an authored foothold wall. A descending body at
    // xMax still enters the rectangle and is held above fall recovery.
    {
        let player = world.players.get_mut("water").unwrap();
        player.state.x = 300.0;
        player.state.y = 201.0;
        player.state.vx = 0.0;
        player.state.vy = 200.0;
        player.state.grounded = false;
        player.state.action = "jump";
        player.foothold_id = 0;
        player.last_foothold_id = 0;
        player.swimming = false;
    }
    input(&mut world, 41, 0, 0, false);
    input(&mut world, 42, 0, 0, false);
    assert!(world.players["water"].swimming);
    assert_eq!(world.players["water"].state.x, 300.0);

    let shared_maps = Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/maps.json");
    let catalog = MapCatalog::load(&shared_maps).expect("shared map catalog with water");
    let split_road = catalog
        .maps
        .iter()
        .find(|map| map.id == "001020000")
        .expect("split road map");
    assert_eq!(split_road.water.len(), 1);
    assert_eq!(
        (
            split_road.water[0].x_min,
            split_road.water[0].x_max,
            split_road.water[0].y_min,
            split_road.water[0].y_max,
        ),
        (0.0, 580.0, 224.0, 340.0)
    );
    assert_eq!(split_road.get(15).map(|foothold| foothold.x1), Some(580.0));
    assert_eq!(split_road.get(15).map(|foothold| foothold.prev), Some(0));
    assert_eq!(split_road.get(57).map(|foothold| foothold.next), Some(0));
    assert!(split_road.get(59).is_some_and(|foothold| {
        foothold.x1 == 620.0 && foothold.x2 == 690.0 && foothold.y1 == 180.0
    }));
    // Real map: bank -> pool -> bank/step, then the two-hop wooden deck route.
    let player = world.players.get_mut("water").unwrap();
    let reset = |p: &mut Player, x, y, foothold, swimming| {
        p.state.x = x; p.state.y = y; p.state.vx = 0.0; p.state.vy = 0.0;
        p.state.grounded = foothold != 0; p.foothold_id = foothold;
        p.last_foothold_id = foothold; p.drop_fh = 0; p.swimming = swimming;
        p.state.action = "stand"; p.jump = false; p.vertical = 0;
        p.last_input = Instant::now(); p.move_speed = 125.0;
    };
    reset(player, 585.0, 215.0, 15, false);
    player.direction = -1;
    for tick in 100..140 {
        step_player(split_road, &Gameplay::default(), player, tick);
        if player.swimming { break; }
    }
    assert!(player.swimming && player.state.x < 580.0, "bank edge permits entry");
    reset(player, 575.0, 224.0, 0, true);
    player.direction = 1; player.jump = true;
    for tick in 140..180 {
        step_player(split_road, &Gameplay::default(), player, tick);
        if player.state.grounded { break; }
    }
    assert!(player.state.grounded && player.state.x >= 580.0, "jump exits onto shore");
    reset(player, 690.0, 215.0, 15, false);
    player.direction = -1; player.jump = true;
    for tick in 180..220 {
        step_player(split_road, &Gameplay::default(), player, tick);
        if player.state.grounded { break; }
    }
    assert_eq!(player.foothold_id, 59, "first hop lands on added plank");
    player.jump = true;
    for tick in 220..260 {
        step_player(split_road, &Gameplay::default(), player, tick);
        if player.state.grounded { break; }
    }
    assert_eq!(player.foothold_id, 57, "second hop lands on wooden deck");
    reset(player, 50.0, 280.0, 0, true);
    player.direction = -1; player.vertical = 1;
    for tick in 260..280 { step_player(split_road, &Gameplay::default(), player, tick); }
    assert!(player.swimming);
    assert!(player.state.y <= split_road.water[0].floor_at(player.state.x), "shallow rocks remain solid");

}

// P: user-authorized drop floating. Drops that land in a water zone are pinned
// just below the surface so a swimming player (pickup range |dx|,|dy| <= 32 at
// world.rs:8215) can reach them; drops on land, on the deck walkway, or on the
// right bank keep their authored y. Not an original TMS273 rule.
#[test]
fn water_drops_float_to_surface_but_not_onto_land() {
    let bounds = Bounds {
        x_min: 0.0,
        x_max: 1000.0,
        y_min: -100.0,
        y_max: 500.0,
    };
    // Floor has a shallow rock near x=560 (y=225) so the surface+draft anchor
    // (224+16=240) would sit below the rock there — a punch-through case.
    let water = WaterRect {
        x_min: 0.0,
        x_max: 580.0,
        y_min: 224.0,
        y_max: 340.0,
        floor: vec![
            Point { x: 0.0, y: 340.0 },
            Point { x: 560.0, y: 225.0 },
            Point { x: 580.0, y: 340.0 },
        ],
    };
    assert!(water.valid(&bounds));
    let map = Map {
        id: "float-test".into(),
        bounds,
        spawn: Point { x: 250.0, y: 200.0 },
        footholds: vec![Foothold {
            id: 1,
            x1: 0.0,
            y1: 200.0,
            x2: 1000.0,
            y2: 200.0,
            prev: 0,
            next: 0,
            forbid_fall_down: 0,
        }],
        ladders: Vec::new(),
        portals: Vec::new(),
        water: vec![water],
    };
    assert!(map.validate().is_ok());

    let draft = DROP_WATER_DRAFT;
    let surface = 224.0;
    let floated = surface + draft; // 240.0

    // 1. Pool interior: a drop resting on the floor, at the surface, or below
    //    the pool all float to surface + draft.
    assert_eq!(map.water_float_y(300.0, 330.0), floated);
    assert_eq!(map.water_float_y(10.0, 224.0), floated);
    assert_eq!(map.water_float_y(300.0, 400.0), floated);

    // 2. Wooden deck walkway above (y=145), right bank (x>=580) and land above
    //    the surface keep their authored y.
    assert_eq!(map.water_float_y(300.0, 145.0), 145.0);
    assert_eq!(map.water_float_y(600.0, 215.0), 215.0);
    assert_eq!(map.water_float_y(50.0, 100.0), 100.0);

    // 3. Idempotent: re-applying to an already-floated y is a no-op.
    let once = map.water_float_y(300.0, 330.0);
    assert_eq!(map.water_float_y(300.0, once), once);

    // 4. Never punches through floor_at(x): the shallow rock at x=560 has
    //    floor 225, below the 240 anchor, so it clamps down to the floor.
    let shallow_floor = map.water[0].floor_at(560.0);
    let floated_shallow = map.water_float_y(560.0, 330.0);
    assert!(floated_shallow >= surface, "still at/above the surface");
    assert!(
        floated_shallow <= shallow_floor,
        "shallow rock does not punch through"
    );

    // 5. Real map through the shared catalog: 001020000 pool floats, deck/bank
    //    drops stay put.
    let shared_maps = Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/maps.json");
    let catalog = MapCatalog::load(&shared_maps).expect("shared map catalog with water");
    let split_road = catalog
        .maps
        .iter()
        .find(|map| map.id == "001020000")
        .expect("split road map");
    assert_eq!(split_road.water.len(), 1);
    assert_eq!(
        split_road.water_float_y(300.0, 320.0),
        224.0 + DROP_WATER_DRAFT
    );
    assert_eq!(split_road.water_float_y(300.0, 145.0), 145.0);
    assert_eq!(split_road.water_float_y(585.0, 215.0), 215.0);
}

