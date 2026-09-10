/// Regression: the mage must be able to keep using the jump command in water.
///
/// Two independent faults made this impossible (beginners were unaffected
/// because their job never reaches the wave routing):
///
/// 1. `magic_wave_float_used` / `magic_wave_used` were only reset when the
///    player was `grounded`.  A swimming body is never grounded, so the flag
///    latched after the first cast and every later press was rejected with
///    `skill_cooldown`.
/// 2. The client routed Space to the air-float skill whenever `!grounded`,
///    which in water is always — so no normal jump was ever sent.
///
/// This covers the server half: repeated casts while swimming must all be
/// accepted, the snapshot must advertise `swimming` so the client can route the
/// key, and leaving the water must clear the flags again.

fn wave_pool() -> Map {
    serde_json::from_value(serde_json::json!({
        "id":"pool","bounds":{"xMin":0,"xMax":500,"yMin":-100,"yMax":600},
        "spawn":{"x":250,"y":200},
        "footholds":[{"id":1,"x1":0,"y1":200,"x2":500,"y2":200,"prev":0,"next":0}],
        "ladders":[],
        "water":[{"xMin":0,"xMax":500,"yMin":300,"yMax":400,"floor":[]}]
    }))
    .unwrap()
}

fn wave_world() -> (World, mpsc::Receiver<String>) {
    let mut world = World::new_with_gameplay(wave_pool(), 600, Gameplay::default())
        .with_mage_skills(crate::mage::MageSkills::bundled());
    let mut rx = join_test_player(&mut world, "p");
    while rx.try_recv().is_ok() {}
    for _ in 0..40 {
        world.step();
        while rx.try_recv().is_ok() {}
        if world.players["p"].state.grounded {
            break;
        }
    }
    {
        let p = world.players.get_mut("p").unwrap();
        p.state.y = 350.0;
        p.swimming = true;
        p.state.swimming = true;
        p.state.grounded = false;
        p.foothold_id = 0;
        p.state.vy = 0.0;
        p.state.job = MAGICIAN_JOB;
        p.state.mp = 5_000;
        p.state.max_mp = 5_000;
        p.state.skills.insert(SKILL_MAGIC_WAVE, 1);
        p.state.skills.insert(SKILL_MAGIC_WAVE_HIDDEN, 1);
    }
    (world, rx)
}

#[test]
fn swimming_resets_the_one_use_magic_wave_flags() {
    let (mut world, mut rx) = wave_world();

    // Repeated float casts while swimming must all be accepted.
    for attempt in 1..=3 {
        while rx.try_recv().is_ok() {}
        world.handle_cast_skill(
            "p".into(),
            format!("wave-{attempt}"),
            SKILL_MAGIC_WAVE_HIDDEN,
            Some(0),
            Some(1),
        );
        world.step();
        let mut success = false;
        let mut code = "(none)".to_string();
        while let Ok(raw) = rx.try_recv() {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
                if value["type"] == "skillResult" {
                    success = value["success"] == true;
                    if let Some(text) = value["code"].as_str() {
                        code = text.to_string();
                    }
                }
            }
        }
        assert!(
            success,
            "cast {attempt} while swimming must succeed, got code={code}"
        );
    }

    // The snapshot must advertise swimming so the client can route the key.
    assert!(
        world.players["p"].state.swimming,
        "snapshot must expose swimming=true while in water"
    );

    // Leaving the water must clear the flags again.
    {
        let p = world.players.get_mut("p").unwrap();
        p.swimming = false;
        p.state.y = 200.0;
        p.state.grounded = true;
    }
    world.step();
    while rx.try_recv().is_ok() {}
    assert!(
        !world.players["p"].magic_wave_float_used,
        "leaving the water must clear magic_wave_float_used"
    );
    assert!(
        !world.players["p"].magic_wave_used,
        "leaving the water must clear magic_wave_used"
    );
    assert!(!world.players["p"].state.swimming);
}
