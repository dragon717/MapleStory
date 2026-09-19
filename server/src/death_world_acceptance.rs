// 原创扩展「死亡世界」（墓碑留存 + 虚影演化）的定向验收。
//
// 边界：这里只验证本扩展自身的因果——死亡落碑、复活不撤碑、绝对时钟到期、
// 虚影演化是纯函数、悼念去重与拒绝路径、私有遭遇不落碑、同图容量与持久化。
// 原版死亡/复活语义的回归由既有用例承担；这些用例不重复跑那条链。

fn death_world_map() -> Map {
    map()
}

/// 杀死 `p` 并返回是否真的致死。伤害远超任何初始 HP，且无护盾可减免。
fn kill(world: &mut World) -> bool {
    world
        .commit_incoming_damage("p", 100_000)
        .map(|(_, _, killed)| killed)
        .unwrap_or(false)
}

fn snapshot_tombstones(world: &World, id: &str) -> Vec<serde_json::Value> {
    let snapshot: serde_json::Value = serde_json::from_str(&world.snapshot(id)).unwrap();
    snapshot
        .get("tombstones")
        .and_then(|tombstones| tombstones.as_array())
        .cloned()
        .unwrap_or_default()
}

fn mourn(world: &mut World, request: &str, tombstone_id: &str) {
    world.command(Command::Input {
        id: "p".into(),
        connection: "p-connection".into(),
        message: ClientMessage::TombstoneMourn {
            request_id: request.into(),
            tombstone_id: tombstone_id.into(),
        },
    });
}

fn tombstone_result(output: &mut mpsc::Receiver<String>, request: &str) -> serde_json::Value {
    while let Ok(message) = output.try_recv() {
        let value: serde_json::Value = serde_json::from_str(&message).unwrap_or_default();
        if value.get("type").and_then(|v| v.as_str()) == Some("tombstoneResult")
            && value.get("requestId").and_then(|v| v.as_str()) == Some(request)
        {
            return value;
        }
    }
    panic!("tombstoneResult for {request} never arrived");
}

fn tombstone_rejection(output: &mut mpsc::Receiver<String>, request: &str) -> String {
    let mut last = None;
    while let Ok(message) = output.try_recv() {
        let value: serde_json::Value = serde_json::from_str(&message).unwrap_or_default();
        if value.get("type").and_then(|v| v.as_str()) == Some("rejected")
            && value.get("requestId").and_then(|v| v.as_str()) == Some(request)
        {
            last = Some(
                value
                    .get("code")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_owned(),
            );
        }
    }
    last.unwrap_or_else(|| panic!("rejection for {request} never arrived"))
}

#[test]
fn death_leaves_a_tombstone_that_survives_revive() {
    let mut world = World::new(death_world_map(), 600);
    let mut output = join_test_player(&mut world, "p");
    while output.try_recv().is_ok() {}
    // 灰色虚影的原料：死亡时刻的外观原样进碑。
    world.players.get_mut("p").unwrap().state.appearance = Some(crate::lobby::Appearance {
        gender: 0, face: 20000, hair: 30000, skin: 0,
        coat: 1040002, pants: 1060002, shoes: 1070001, weapon: 1302000,
    });
    assert!(kill(&mut world), "the hit must be lethal");

    let tombstones = snapshot_tombstones(&world, "p");
    assert_eq!(tombstones.len(), 1, "a formal death leaves exactly one tombstone");
    let tombstone = &tombstones[0];
    assert_eq!(tombstone.get("characterName").and_then(|v| v.as_str()), Some("p"));
    assert_eq!(tombstone.get("stage").and_then(|v| v.as_u64()), Some(0));
    assert_eq!(tombstone.get("stageName").and_then(|v| v.as_str()), Some("潜伏"));
    assert_eq!(tombstone.get("mourners").and_then(|v| v.as_u64()), Some(0));
    assert!(tombstone.get("expiresInMs").and_then(|v| v.as_f64()).unwrap_or(0.0) > 0.0);
    // 碑文非空：碑文是死亡事实的一部分，不能是空串。
    assert!(!tombstone
        .get("epitaph")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .is_empty());
    // 复活撤不掉墓碑：碑独立于复活事实存在，直到绝对期限。
    world.handle_revive("p".into(), "r1".into());
    assert_eq!(world.players["p"].state.action, "stand");
    assert_eq!(snapshot_tombstones(&world, "p").len(), 1, "revive must not remove the tombstone");
    let tombstones = snapshot_tombstones(&world, "p");
    assert_eq!(
        tombstones[0].pointer("/appearance/coat").and_then(|v| v.as_i64()),
        Some(1040002),
        "the death-time look rides the snapshot for the gray ghost"
    );
}

#[test]
fn one_death_yields_exactly_one_tombstone() {
    let mut world = World::new(death_world_map(), 600);
    let mut output = join_test_player(&mut world, "p");
    while output.try_recv().is_ok() {}
    assert!(kill(&mut world));
    let death_id = world.players["p"].death_id.clone();
    assert!(!death_id.is_empty());

    // 同一次死亡的重复收尾（幂等防线）不得落第二座碑。
    world.spawn_death_tombstone("p", &death_id);
    assert_eq!(snapshot_tombstones(&world, "p").len(), 1);

    // 新的一次死亡（新 death_id）是另一座碑——事实以 death_id 区分。
    world.handle_revive("p".into(), "r1".into());
    assert!(kill(&mut world));
    assert_eq!(snapshot_tombstones(&world, "p").len(), 2);
}

#[test]
fn mourn_counts_once_per_character_and_replays_the_same_state() {
    let mut world = World::new(death_world_map(), 600);
    let mut output = join_test_player(&mut world, "p");
    while output.try_recv().is_ok() {}
    assert!(kill(&mut world));
    let tombstone_id = world.death_tombstones.keys().next().unwrap().clone();
    world.handle_revive("p".into(), "r1".into());

    mourn(&mut world, "m1", &tombstone_id);
    let result = tombstone_result(&mut output, "m1");
    assert_eq!(result.get("mourners").and_then(|v| v.as_u64()), Some(1));
    assert_eq!(result.get("alreadyMourned").and_then(|v| v.as_bool()), Some(false));
    assert_eq!(result.get("tombstoneId").and_then(|v| v.as_str()), Some(tombstone_id.as_str()));
    assert!(result.get("epitaph").and_then(|v| v.as_str()).is_some_and(|epitaph| !epitaph.is_empty()));

    // 同一角色换 requestId 再悼念：不重复计数，状态原样重放。
    mourn(&mut world, "m2", &tombstone_id);
    let result = tombstone_result(&mut output, "m2");
    assert_eq!(result.get("mourners").and_then(|v| v.as_u64()), Some(1));
    assert_eq!(result.get("alreadyMourned").and_then(|v| v.as_bool()), Some(true));

    // 悼念确实推进了虚影：3 位悼念者把凝聚提前（纯函数阈值，见演化用例）。
    let now = unix_now_ms();
    let entry = world.death_tombstones.get(&tombstone_id).unwrap();
    assert_eq!(entry.echo_stage(now), 0, "one mourner alone does not converge");
    assert_eq!(entry.mourners.len(), 1);
}

#[test]
fn mourn_rejects_unknown_gone_out_of_range_and_dead() {
    let mut world = World::new(death_world_map(), 600);
    let mut output = join_test_player(&mut world, "p");
    while output.try_recv().is_ok() {}

    // 不存在的墓碑。
    mourn(&mut world, "m-unknown", "tomb-no-such");
    assert_eq!(tombstone_rejection(&mut output, "m-unknown"), "tombstone_unknown");

    assert!(kill(&mut world));
    let tombstone_id = world.death_tombstones.keys().next().unwrap().clone();
    world.handle_revive("p".into(), "r1".into());

    // 距离外悼念。
    world.players.get_mut("p").unwrap().state.x += death_world::TOMBSTONE_RANGE_X + 10.0;
    mourn(&mut world, "m-far", &tombstone_id);
    assert_eq!(tombstone_rejection(&mut output, "m-far"), "tombstone_out_of_range");

    // 死亡角色不能悼念。
    world.players.get_mut("p").unwrap().state.x -= death_world::TOMBSTONE_RANGE_X + 10.0;
    world.players.get_mut("p").unwrap().state.hp = 0;
    world.players.get_mut("p").unwrap().state.action = "dead";
    mourn(&mut world, "m-dead", &tombstone_id);
    assert_eq!(tombstone_rejection(&mut output, "m-dead"), "invalid_state");

    // 复活回来，再让碑到期：按「gone」拒绝并被收走，而不是再收一次悼念。
    world.players.get_mut("p").unwrap().state.hp = 50;
    world.players.get_mut("p").unwrap().state.action = "stand";
    let now = unix_now_ms();
    world
        .death_tombstones
        .get_mut(&tombstone_id)
        .unwrap()
        .expires_unix_ms = now - 1;
    mourn(&mut world, "m-gone", &tombstone_id);
    assert_eq!(tombstone_rejection(&mut output, "m-gone"), "tombstone_gone");
    assert!(world.death_tombstones.is_empty());
}

#[test]
fn echo_evolution_is_a_pure_function_of_time_and_mourners() {
    let mut tombstone = death_world::Tombstone {
        id: "tomb-t".into(),
        death_id: "t".into(),
        character_name: "p".into(),
        map_id: "test".into(),
        x: 0.0,
        y: 0.0,
        epitaph: "碑文".into(),
        appearance: None,
        created_unix_ms: 1_000_000,
        expires_unix_ms: 1_000_000 + death_world::TOMBSTONE_RETENTION_MS,
        mourners: BTreeSet::new(),
    };
    let created = tombstone.created_unix_ms;
    assert_eq!(tombstone.echo_stage(created + 1), 0, "刚落碑是潜伏");
    assert_eq!(
        tombstone.echo_stage(created + death_world::ECHO_WANDER_AFTER_MS),
        1,
        "5 分钟后游荡"
    );
    assert_eq!(
        tombstone.echo_stage(created + death_world::ECHO_CONVERGE_AFTER_MS),
        2,
        "15 分钟后凝聚"
    );
    // 演化是单向的：悼念只能提前凝聚，不能把凝聚的虚影退回去。
    for name in ["a", "b"] {
        tombstone.mourners.insert(name.into());
    }
    assert_eq!(tombstone.echo_stage(created + 1), 0, "两位悼念者还不够凝聚");
    tombstone.mourners.insert("c".into());
    assert_eq!(
        tombstone.echo_stage(created + 1),
        2,
        "三位悼念者把凝聚提前"
    );
    tombstone.mourners.remove("a");
    tombstone.mourners.remove("b");
    tombstone.mourners.remove("c");
    // 时间推入的阶段不依赖悼念者：无人悼念的碑也会随时间凝聚。
    assert_eq!(
        tombstone.echo_stage(tombstone.created_unix_ms + death_world::ECHO_CONVERGE_AFTER_MS),
        2,
        "时间自己就能推到凝聚，悼念只是提前"
    );
    // 真实世界里悼念集合只增不减、时钟只进不退，所以可观察演化不会回退；
    // 这里不构造「回退」场景，因为纯函数没有为不存在的输入定义行为。
}

#[test]
fn tombstones_expire_on_the_absolute_deadline() {
    let mut world = World::new(death_world_map(), 600);
    let mut output = join_test_player(&mut world, "p");
    while output.try_recv().is_ok() {}
    assert!(kill(&mut world));
    assert_eq!(snapshot_tombstones(&world, "p").len(), 1);

    // 把期限拨到过去（等价于时间流逝），下一拍清扫收走。
    let now = unix_now_ms();
    let id = world.death_tombstones.keys().next().unwrap().clone();
    world.death_tombstones.get_mut(&id).unwrap().expires_unix_ms = now - 1;
    world.step();
    while output.try_recv().is_ok() {}
    assert!(world.death_tombstones.is_empty(), "expired tombstones leave the world");
    assert!(snapshot_tombstones(&world, "p").is_empty());
}

#[test]
fn practice_and_windbell_instance_maps_leave_no_tombstone() {
    let mut world = World::new(death_world_map(), 600);
    let mut output = join_test_player(&mut world, "p");
    while output.try_recv().is_ok() {}
    assert!(auth::is_practice_map("practice:100000001:encounter"));

    world.players.get_mut("p").unwrap().map_id = "practice:100000001:encounter".into();
    world.spawn_death_tombstone("p", "death-practice");
    assert!(world.death_tombstones.is_empty(), "practice maps leave no tombstone");

    world.players.get_mut("p").unwrap().map_id = "windbell:island:x".into();
    world.spawn_death_tombstone("p", "death-windbell");
    assert!(world.death_tombstones.is_empty(), "windbell instance maps leave no tombstone");
}

#[test]
fn tombstones_are_capped_per_map_and_the_oldest_leaves_first() {
    let mut world = World::new(death_world_map(), 600);
    let mut output = join_test_player(&mut world, "p");
    while output.try_recv().is_ok() {}
    for index in 0..10 {
        world.spawn_death_tombstone("p", &format!("death-{index}"));
    }
    assert_eq!(
        world.death_tombstones.len(),
        death_world::TOMBSTONES_PER_MAP,
        "per-map capacity is enforced"
    );
    assert!(!world.death_tombstones.contains_key("tomb-death-0"), "the oldest leaves first");
    assert!(!world.death_tombstones.contains_key("tomb-death-1"));
    assert!(world.death_tombstones.contains_key("tomb-death-9"), "the newest stays");
}

#[test]
fn tombstones_persist_and_survive_a_world_rebuild() {
    let path = std::env::temp_dir().join(format!(
        "maple-death-world-{}.sqlite3",
        auth::random_id()
    ));
    let service = auth::start(&path).unwrap();
    let store = service.store.clone();

    {
        let mut world = World::new_with_store(death_world_map(), 600, Gameplay::default(), store.clone())
            .unwrap();
        let mut output = join_test_player(&mut world, "p");
        while output.try_recv().is_ok() {}
        world.players.get_mut("p").unwrap().state.appearance = Some(crate::lobby::Appearance {
            gender: 1, face: 20001, hair: 30016, skin: 0,
            coat: 1040046, pants: 1060038, shoes: 1070005, weapon: 1302000,
        });
        assert!(kill(&mut world));
        let tombstone_id = world.death_tombstones.keys().next().unwrap().clone();
        world.handle_revive("p".into(), "r1".into());
        mourn(&mut world, "m1", &tombstone_id);
        let result = tombstone_result(&mut output, "m1");
        assert_eq!(result.get("mourners").and_then(|v| v.as_u64()), Some(1));
    }

    // 世界重建（进程重启的替身）：碑还在，悼念人数也在，灰色虚影的外观
    // 也在。期限不刷新——created/expires 是绝对时钟原样读回。
    let world = World::new_with_store(death_world_map(), 600, Gameplay::default(), store.clone())
        .unwrap();
    let tombstones = snapshot_tombstones(&world, "p");
    assert_eq!(tombstones.len(), 1, "a rebuilt world still shows the tombstone");
    assert_eq!(tombstones[0].get("mourners").and_then(|v| v.as_u64()), Some(1));
    assert_eq!(
        tombstones[0].pointer("/appearance/hair").and_then(|v| v.as_i64()),
        Some(30016),
        "the death-time look survives a restart"
    );
    let now = unix_now_ms();
    let record = store.load_tombstones().unwrap().pop().unwrap();
    assert!(record.expires_unix_ms > now, "the absolute deadline is preserved, not refreshed");

    let _ = std::fs::remove_file(&path);
}
