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
        // 100020000 芽孢山丘（2026-09-13 收录）的源 foothold 止于 x=1440，而图
        // 右缘到 1511——持续右走会走出台缘进入坠落，属源侧真实地形。服务端
        // `recover_at_fall_boundary` 会把越界坠落夹回最后一个 foothold，因此
        // 审计口径是「停止输入后必须回到地面」，而不是「采样瞬间必在地面上」：
        // 停止行走让坠落走完回收流程，任何不可回收的破图在这里都会超时失败。
        world.command(Command::Input {
            id: "p".into(), connection: "p-connection".into(),
            message: ClientMessage::Input { seq: seq + 1, direction: 0, vertical: 0, jump: false },
        });
        let mut grounded_again = false;
        for _ in 0..600 {
            world.step();
            while rx.try_recv().is_ok() {}
            if world.players["p"].state.grounded { grounded_again = true; break; }
        }
        let p = &world.players["p"];
        assert!(p.state.x.is_finite() && p.state.y.is_finite(), "map {} non-finite", m.id);
        assert!(grounded_again, "map {}: walker never recovered to ground at ({:.1},{:.1})", m.id, p.state.x, p.state.y);
        total += 1;
    }
    println!("REAL MAPS OK: {}", total);
}
