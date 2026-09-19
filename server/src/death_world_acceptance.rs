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
        next_strike_unix_ms: 0,
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

// ---------------------------------------------------------------------------
// D06 试点遭遇：类型化行动者与单一奖励路由。
// ---------------------------------------------------------------------------

/// 一只默认模板怪（exp=1）。测试用它驱动虚影打击与玩家击杀的路由判据。
fn echo_gameplay() -> Gameplay {
    let mut gameplay = Gameplay::default();
    gameplay.monsters = vec![life_template()];
    gameplay.spawns = vec![life_spawn("s1", "test", 100.0, 1, 0)];
    gameplay
}

/// 把世界里的碑拨到「凝聚」并挪到怪物旁边，节流阀清零。
fn converge_echo_next_to_monster(world: &mut World, tombstone_id: &str) -> String {
    let monster_id = world.monsters.keys().next().unwrap().clone();
    let (mx, my) = {
        let monster = &world.monsters[&monster_id];
        (monster.state.x, monster.state.y)
    };
    let tombstone = world.death_tombstones.get_mut(tombstone_id).unwrap();
    tombstone.created_unix_ms =
        unix_now_ms() - death_world::ECHO_CONVERGE_AFTER_MS - 1;
    tombstone.x = mx;
    tombstone.y = my;
    tombstone.next_strike_unix_ms = 0;
    world.echo_strike_interval_ms = 0;
    monster_id
}

fn drain_events(output: &mut mpsc::Receiver<String>) -> Vec<serde_json::Value> {
    let mut events = Vec::new();
    while let Ok(message) = output.try_recv() {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&message) {
            events.push(value);
        }
    }
    events
}

#[test]
fn converged_echo_strikes_unengaged_monsters_and_claims_one_reward() {
    let path = std::env::temp_dir().join(format!(
        "maple-echo-strike-{}.sqlite3",
        auth::random_id()
    ));
    let service = auth::start(&path).unwrap();
    let store = service.store.clone();

    let mut world =
        World::new_with_store(life_map("test"), 600, echo_gameplay(), store.clone()).unwrap();
    let mut output = join_test_player(&mut world, "p");
    while output.try_recv().is_ok() {}
    assert!(kill(&mut world), "the hit must be lethal");
    let tombstone_id = world.death_tombstones.keys().next().unwrap().clone();
    world.handle_revive("p".into(), "r1".into());

    let monster_id = converge_echo_next_to_monster(&mut world, &tombstone_id);
    let exp_template = world.monsters[&monster_id].template.exp;

    // 推进到怪死：虚影单击 15% max_hp，过量截断；节流阀为 0 ⇒ 连拍可尽。
    let mut strike_events = Vec::new();
    for _ in 0..40 {
        world.step();
        strike_events.extend(
            drain_events(&mut output)
                .into_iter()
                .filter(|value| value.get("type").and_then(|v| v.as_str()) == Some("echoStrikeEvent")),
        );
        if world.monsters[&monster_id].state.hp == 0 {
            break;
        }
    }
    assert_eq!(
        world.monsters[&monster_id].state.hp, 0,
        "the converged echo dispatches the unengaged monster"
    );
    assert_eq!(
        world.monsters[&monster_id].state.action, "die",
        "the monster dies through the same runtime death path as a player kill"
    );
    assert!(
        strike_events.iter().any(|event| event.get("killed").and_then(|v| v.as_bool()) == Some(true)),
        "the lethal strike is announced with a typed echoStrikeEvent"
    );

    // 库层：恰好一行奖励，虚影形状（NULL 账号 + actor_kind='echo'），
    // 经验 = 怪物模板经验（D08 经验球的根预算，冻结值可对账）。
    let conn = rusqlite::Connection::open(&path).unwrap();
    let row: (Option<String>, Option<String>, i64) = conn
        .query_row(
            "SELECT account_id,actor_kind,exp_gain FROM monster_rewards WHERE monster_id=?1",
            [&monster_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(row.0, None, "an echo kill never mints an account-shaped row");
    assert_eq!(row.1, Some("echo".into()), "the reward row carries its actor kind");
    assert_eq!(row.2, exp_template as i64, "the frozen exp is the monster's authored exp");
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM monster_rewards", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 1, "exactly one reward claim for this life");

    // 世界重建（重启替身）：碑与奖励各归各位——碑还在（期限未到），
    // 同一条命不补认领、不重复。
    drop(world);
    let rebuilt =
        World::new_with_store(life_map("test"), 600, echo_gameplay(), store.clone()).unwrap();
    assert_eq!(
        rebuilt.death_tombstones.len(),
        1,
        "the surviving tombstone persists across a rebuild"
    );
    let count: i64 = rusqlite::Connection::open(&path)
        .unwrap()
        .query_row("SELECT COUNT(*) FROM monster_rewards", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 1, "a rebuild never duplicates the reward claim");

    let _ = std::fs::remove_file(&path);
}

#[test]
fn echo_spares_lower_stages_engaged_monsters_and_distant_threats() {
    let path = std::env::temp_dir().join(format!(
        "maple-echo-spare-{}.sqlite3",
        auth::random_id()
    ));
    let service = auth::start(&path).unwrap();

    let mut world = World::new_with_store(
        life_map("test"),
        600,
        echo_gameplay(),
        service.store.clone(),
    )
    .unwrap();
    let mut output = join_test_player(&mut world, "p");
    while output.try_recv().is_ok() {}
    assert!(kill(&mut world));
    let tombstone_id = world.death_tombstones.keys().next().unwrap().clone();
    world.handle_revive("p".into(), "r1".into());
    let monster_id = converge_echo_next_to_monster(&mut world, &tombstone_id);

    // 1) 潜伏阶段：虚影不动手。
    world
        .death_tombstones
        .get_mut(&tombstone_id)
        .unwrap()
        .created_unix_ms = unix_now_ms();
    for _ in 0..6 {
        world.step();
    }
    drain_events(&mut output);
    assert!(
        world.monsters[&monster_id].state.hp > 0,
        "a latent (stage 0) echo never strikes"
    );

    // 2) 凝聚但被玩家交战：仇恨窗口内不碰；窗口过后才接手。
    {
        let tick = world.tick;
        let monster = world.monsters.get_mut(&monster_id).unwrap();
        mark_monster_hit_aggro(monster, "p", tick);
    }
    // part 1 把 created 拨回了「现在」——接手判定前重新拨到凝聚。
    world
        .death_tombstones
        .get_mut(&tombstone_id)
        .unwrap()
        .created_unix_ms = unix_now_ms() - death_world::ECHO_CONVERGE_AFTER_MS - 1;
    for _ in 0..4 {
        world.step();
    }
    drain_events(&mut output);
    let engaged_hp = world.monsters[&monster_id].state.hp;
    assert!(
        engaged_hp == world.monsters[&monster_id].state.max_hp,
        "an engaged monster is never intercepted"
    );
    // 玩家停手（仇恨过期）后，虚影才接手这个无人认领的威胁。
    world.monsters.get_mut(&monster_id).unwrap().aggro_until = 0;
    for _ in 0..40 {
        world.step();
        if world.monsters[&monster_id].state.hp == 0 {
            break;
        }
    }
    assert_eq!(
        world.monsters[&monster_id].state.hp, 0,
        "once the player disengages, the echo takes over the unclaimed threat"
    );
    drain_events(&mut output);

    // 3) 凝聚但太远：范围外不打击（用 y 拉开距离——怪不可移动，位置确定）。
    assert!(kill(&mut world), "second death for a fresh tombstone");
    let tombstone_id = world
        .death_tombstones
        .values()
        .find(|tombstone| tombstone.death_id == world.players["p"].death_id)
        .map(|tombstone| tombstone.id.clone())
        .unwrap();
    // 收走旧碑（part 2 那座仍凝聚着、贴在怪旁），只留待测的这座远碑。
    for id in world
        .death_tombstones
        .keys()
        .cloned()
        .collect::<Vec<String>>()
    {
        if id != tombstone_id {
            world.death_tombstones.remove(&id);
            let _ = service.store.remove_tombstone(&id);
        }
    }
    {
        let tombstone = world.death_tombstones.get_mut(&tombstone_id).unwrap();
        tombstone.created_unix_ms = unix_now_ms() - death_world::ECHO_CONVERGE_AFTER_MS - 1;
        tombstone.x = 0.0;
        tombstone.y = 400.0; // 距怪物 y（≈100）远超 ECHO_STRIKE_RANGE_Y
        tombstone.next_strike_unix_ms = 0;
    }
    // part 2 的怪已死且默认玩法不重生——满血复位，用「一滴不掉」证明没被打。
    {
        let monster = world.monsters.get_mut(&monster_id).unwrap();
        monster.state.hp = monster.state.max_hp;
        monster.state.action = "stand";
        monster.death_until = None;
        monster.respawn_at = None;
    }
    for _ in 0..6 {
        world.step();
    }
    drain_events(&mut output);
    assert_eq!(
        world.monsters[&monster_id].state.hp,
        world.monsters[&monster_id].state.max_hp,
        "a distant monster is out of the pilot's reach"
    );

    let _ = std::fs::remove_file(&path);
}

#[test]
fn echo_damage_does_not_dilute_the_player_split_or_mint_accounts() {
    let path = std::env::temp_dir().join(format!(
        "maple-echo-route-{}.sqlite3",
        auth::random_id()
    ));
    let service = auth::start(&path).unwrap();

    let mut world = World::new_with_store(
        life_map("test"),
        600,
        echo_gameplay(),
        service.store.clone(),
    )
    .unwrap();
    let mut output = join_test_player(&mut world, "p");
    while output.try_recv().is_ok() {}
    assert!(kill(&mut world));
    let tombstone_id = world.death_tombstones.keys().next().unwrap().clone();
    world.handle_revive("p".into(), "r1".into());
    let monster_id = converge_echo_next_to_monster(&mut world, &tombstone_id);

    // 高血量怪：虚影单击非致命（1000 * 15% = 150）。
    {
        let monster = world.monsters.get_mut(&monster_id).unwrap();
        monster.state.max_hp = 1000;
        monster.state.hp = 1000;
    }
    world.step();
    let events = drain_events(&mut output);
    let strike = events
        .iter()
        .find(|value| value.get("type").and_then(|v| v.as_str()) == Some("echoStrikeEvent"))
        .expect("the non-lethal strike is announced");
    assert_eq!(strike.get("damage").and_then(|v| v.as_i64()), Some(150));
    assert_eq!(strike.get("killed").and_then(|v| v.as_bool()), Some(false));
    assert_eq!(world.monsters[&monster_id].state.hp, 850);

    // 虚影伤害不写贡献表 ⇒ 玩家补刀的分成按纯玩家贡献算，不被稀释。
    let conn = rusqlite::Connection::open(&path).unwrap();
    let contributions: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM monster_damage WHERE monster_id=?1",
            [&monster_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(contributions, 0, "echo damage never enters the contribution ledger");

    // 玩家补刀走既有结算：唯一认领归玩家，经验按 850/1000 份额入账。
    // （先走既有 claim_attack 登记，结算入口要求先有攻击请求行。）
    let _ = service
        .store
        .claim_attack("p", "test", "req-finish", "action-finish", "attack")
        .unwrap();
    let resolution = service
        .store
        .resolve_attack_with_party(
            "p",
            "test",
            "req-finish",
            Some(&monster_id),
            850,
            true,
            100,
            1000,
            &[],
            &[],
            &["p".to_owned()],
            &[],
            &[],
        )
        .unwrap();
    assert_eq!(resolution.exp_gain, 85, "the player share uses only player damage");
    let row: (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT account_id,actor_kind FROM monster_rewards WHERE monster_id=?1",
            [&monster_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(row.0, Some("p".into()), "the finishing player claims the single reward");
    assert_eq!(row.1, None, "a player claim keeps the legacy actor shape");

    let _ = std::fs::remove_file(&path);
}

#[test]
fn monster_rewards_rebuild_preserves_legacy_rows_and_allows_echo_actor() {
    let path = std::env::temp_dir().join(format!(
        "maple-echo-schema-{}.sqlite3",
        auth::random_id()
    ));
    // 旧形状的表（account_id NOT NULL、无 actor_kind）+ 一行旧行。
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE monster_rewards(
               monster_id TEXT PRIMARY KEY,
               account_id TEXT NOT NULL,
               request_id TEXT NOT NULL,
               exp_gain INTEGER NOT NULL,
               drop_id TEXT,
               practice INTEGER NOT NULL DEFAULT 0
             );
             INSERT INTO monster_rewards VALUES('mob-legacy','acc-1','req-1',42,NULL,0);",
        )
        .unwrap();
    }
    let service = auth::start(&path).unwrap();

    // 旧行原样保留：兼容读不变，actor_kind 为 NULL（= 玩家）。
    let conn = rusqlite::Connection::open(&path).unwrap();
    let legacy: (String, Option<String>, i64) = conn
        .query_row(
            "SELECT account_id,actor_kind,exp_gain FROM monster_rewards WHERE monster_id='mob-legacy'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(legacy.0, "acc-1");
    assert_eq!(legacy.1, None, "legacy rows read as player claims");
    assert_eq!(legacy.2, 42);

    // account_id 现在可空：虚影行与旧行共存于同一把主键体系。
    assert!(service.store.claim_echo_kill("mob-echo", "req-echo", 7).unwrap());
    assert!(
        !service
            .store
            .claim_echo_kill("mob-echo", "req-echo-replay", 7)
            .unwrap(),
        "the same life never claims twice"
    );
    let echo_row: (Option<String>, Option<String>, i64) = conn
        .query_row(
            "SELECT account_id,actor_kind,exp_gain FROM monster_rewards WHERE monster_id='mob-echo'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(echo_row.0, None);
    assert_eq!(echo_row.1, Some("echo".into()));
    assert_eq!(echo_row.2, 7);

    let _ = std::fs::remove_file(&path);
}
