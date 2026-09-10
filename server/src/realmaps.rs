#[test]
fn all_authored_maps_keep_the_walker_grounded() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("shared/maps.json");
    let catalog: MapCatalog = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let mut total = 0;
    for m in &catalog.maps {
        let mut world = World::new_with_gameplay(m.clone(), 600, Gameplay::default());
        let mut rx = join_test_player(&mut world, "p");
        while rx.try_recv().is_ok() {}
        for _ in 0..60 { world.step(); while rx.try_recv().is_ok() {} if world.players["p"].state.grounded {break;} }
        let mut seq = 0u64;
        for _ in 0..300 {
            seq += 1;
            world.command(Command::Input {
                id: "p".into(), connection: "p-connection".into(),
                message: ClientMessage::Input { seq, direction: 1, vertical: 0, jump: false },
            });
            world.step();
            while rx.try_recv().is_ok() {}
        }
        let p = &world.players["p"];
        assert!(p.state.x.is_finite() && p.state.y.is_finite(), "map {} non-finite", m.id);
        assert!(p.state.grounded, "map {}: walker ended airborne at ({:.1},{:.1})", m.id, p.state.x, p.state.y);
        total += 1;
    }
    println!("REAL MAPS OK: {}", total);
}
