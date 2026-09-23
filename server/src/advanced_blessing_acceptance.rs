/// 進階祝福 `2321005`（主教四转队伍增益窗）的接线验收（2026-09-23）。
///
/// 经 `include!` 进入 `world_tests.rs` 的 `mod tests`；本文件助手一律 `ab_` 前缀
/// （`include!` 把全部验收塞进同一模块，裸名会与既有验收撞名）。
///
/// 要钉住的是**判据**，不是某个数字：
///
/// * **一条增益窗，一份判据**：接纳表 `ADVANCED_BLESSING_SKILLS` 是准入、施法臂、
///   动作时长与属性层三格留痕**唯一**的那张表，不写 `if skill_id == …`。
/// * **窗口时长从源 `time` 派生**，不写死 240 秒（门禁另有一条「不许出现 240_000」
///   的反向断言）。
/// * **数值随身带，不回表查**：这条是队伍增益，收到它的人未必学得这一本，所以
///   `x`/`y`/`z` 三格必须挂在玩家身上（施放时按**施法者那一本**算定），
///   而不是在属性聚合时按「学到了几级」回表——那会既查不到、又用错等级。
/// * **到期要收回**：`Release::AdvancedBlessing` 让 tick 块的清理 `match` 必须收回
///   那三格；不收回的话面板与战斗会一直带着一个已经看不见的增益。
const AB_ACTOR: &str = MECH_ACTOR;

fn ab_world() -> (World, mpsc::Receiver<String>) {
    mech_bundled_world(vec![])
}

/// 摆好主教四转当事人并学会進階祝福（含它的前置 天使祝福 `2301004` 10 级）。
fn ab_ready(world: &mut World, skills: &[(u32, u32)]) {
    mech_place_actor(world, 232, 120, 100.0, 100.0);
    mech_learn(world, skills);
    let player = world.players.get_mut(AB_ACTOR).unwrap();
    player.attack_until = 0;
    player.state.action = "stand";
}

fn ab_level(world: &World) -> MageLevel {
    mech_level(world, SKILL_ADVANCED_BLESSING)
}

fn ab_attributes(world: &World) -> PlayerAttributes {
    aggregate_attributes(AttributeInput::of(
        &world.gameplay,
        &world.mage_skills,
        world.players.get(AB_ACTOR).expect("joined actor"),
    ))
}

fn ab_drain(rx: &mut mpsc::Receiver<String>) -> Vec<serde_json::Value> {
    let mut values = Vec::new();
    while let Ok(message) = rx.try_recv() {
        values.push(serde_json::from_str::<serde_json::Value>(&message).unwrap());
    }
    values
}

/// 把世界推到 `ticks` 拍之后。清理发生在 tick 块里，所以「到期收回」必须真的走
/// 世界拍，不能直接调 `status.advance()`——那样测的是 `PlayerStatus` 自己。
fn ab_advance(world: &mut World, ticks: u64) {
    let target = world.tick + ticks;
    while world.tick < target {
        world.step();
    }
}

// ── ① 接纳表 + 端到端施放 + 窗口时长从源 `time` 派生 ─────────────────────────

#[test]
fn ab_advanced_blessing_opens_the_window_from_the_source_time() {
    assert_eq!(ADVANCED_BLESSING_SKILLS, [SKILL_ADVANCED_BLESSING]);
    assert_eq!(SKILL_ADVANCED_BLESSING, 2321005);

    let (mut world, mut rx) = ab_world();
    ab_ready(&mut world, &[(SKILL_ADVANCED_BLESSING, 1), (2301004, 10)]);
    let level = ab_level(&world);
    let source_time = level.time.expect("源 common 必须有 time");
    let source_x = level.x.expect("源 common 必须有 x");
    let source_y = level.y.expect("源 common 必须有 y");
    let source_z = level.z.expect("源 common 必须有 z");

    // 端到端：改前它落进 `_ => {}`（「该技能尚未开放施放」）。
    world.handle_cast_skill(
        AB_ACTOR.into(),
        "blessing-1".into(),
        SKILL_ADVANCED_BLESSING,
        Some(1),
        Some(0),
    );
    let events = ab_drain(&mut rx);
    assert!(
        !events.iter().any(|value| value["type"] == "rejected"),
        "進階祝福被拒了：{events:?}"
    );
    assert!(
        events
            .iter()
            .any(|value| value["type"] == "skillCast" && value["skillId"] == SKILL_ADVANCED_BLESSING),
        "進階祝福没有发出 skillCast：{events:?}"
    );

    let player = world.players.get(AB_ACTOR).expect("joined actor");
    assert!(
        player.status.buff_active(SKILL_ADVANCED_BLESSING),
        "增益窗没挂上"
    );
    // 时长 = 源 `time`（秒）× 1000，逐拍等价（与 `PlayerStatus` 的截止点口径同源）。
    let expected_ticks = (source_time as u64).saturating_mul(1_000).div_ceil(TICK_MS);
    let remaining = player
        .status
        .buff_remaining_ms(SKILL_ADVANCED_BLESSING)
        .expect("window remaining");
    assert_eq!(
        remaining,
        expected_ticks.saturating_mul(TICK_MS),
        "窗口时长不是从源 time 派生的"
    );
    // 三格加算**随身带**：不是回表查，是按施法者这一本算定后挂上去的。
    assert_eq!(
        player.advanced_blessing,
        Some(BlessingBonus {
            pad: source_x.max(0),
            mad: source_y.max(0),
            pdd: source_z.max(0),
        })
    );
}

// ── ② 三格真的进属性层，且到期被收回 ────────────────────────────────────────

#[test]
fn ab_window_feeds_the_attribute_layer_and_is_reclaimed_on_expiry() {
    let (mut world, _rx) = ab_world();
    ab_ready(&mut world, &[(SKILL_ADVANCED_BLESSING, 1)]);
    let level = ab_level(&world);
    let bonus = BlessingBonus {
        pad: level.x.unwrap_or(0).max(0),
        mad: level.y.unwrap_or(0).max(0),
        pdd: level.z.unwrap_or(0).max(0),
    };
    let idle = ab_attributes(&world);

    // 1 秒的窗口：观测「到期收回」不需要推 4800 拍。
    world.activate_advanced_blessing(
        AB_ACTOR,
        SKILL_ADVANCED_BLESSING,
        &MageLevel {
            time: Some(1),
            x: level.x,
            y: level.y,
            z: level.z,
            ..MageLevel::default()
        },
    );
    let blessed = ab_attributes(&world);
    assert_eq!(
        blessed.magic_attack,
        idle.magic_attack.saturating_add(bonus.mad),
        "窗口内的魔力（源 y）没有进魔法攻击"
    );
    assert_eq!(
        blessed.value_of(AttributeKey::WeaponAttack),
        idle.value_of(AttributeKey::WeaponAttack).saturating_add(bonus.pad),
        "窗口内的攻击力（源 x）没有进 weapon_watk"
    );
    assert_eq!(
        blessed.defense(),
        idle.defense().saturating_add(bonus.pdd),
        "窗口内的防御力（源 z）没有进 defense"
    );

    // 三格**各记各的**：留痕要能回答「这 30 点魔攻是谁给的」。
    for (field, key, value) in [
        ("x", AttributeKey::WeaponAttack, bonus.pad),
        ("y", AttributeKey::MagicAttack, bonus.mad),
        ("z", AttributeKey::WeaponDefense, bonus.pdd),
    ] {
        let trace = blessed
            .sources
            .iter()
            .find(|source| source.field == field && source.key == key);
        assert!(
            trace.is_some(),
            "進階祝福的 {field} 没有留痕（{key:?}）：{:?}",
            blessed.sources
        );
        let trace = trace.unwrap();
        assert_eq!(trace.layer, AttributeLayer::ActiveBuff);
        assert_eq!(trace.skill_id, Some(SKILL_ADVANCED_BLESSING));
        assert_eq!(trace.op, AttributeOp::Flat);
        assert_eq!(trace.value, value);
    }

    // 到期：走世界拍 —— `Release::AdvancedBlessing` 的清理只在 tick 块里。
    ab_advance(&mut world, 30);
    let player = world.players.get(AB_ACTOR).expect("joined actor");
    assert!(
        !player.status.buff_active(SKILL_ADVANCED_BLESSING),
        "窗口到期了却还判生效"
    );
    assert_eq!(
        player.advanced_blessing, None,
        "窗口到期没有收回那三格加算——面板与战斗会一直带着一个看不见的增益"
    );
    let after = ab_attributes(&world);
    assert_eq!(after.magic_attack, idle.magic_attack, "到期后魔力没退回");
    assert_eq!(
        after.value_of(AttributeKey::WeaponAttack),
        idle.value_of(AttributeKey::WeaponAttack),
        "到期后攻击力没退回"
    );
    assert_eq!(after.defense(), idle.defense(), "到期后防御力没退回");
}

// ── ③ 队伍分发：只给同图队友，外人拿不到 ────────────────────────────────────

#[test]
fn ab_window_reaches_the_party_on_the_map_and_nobody_else() {
    // `PartyRig` 是 `party_acceptance.rs` 的夹具（同一次 `include!` 进同一个模块）。
    let mut rig = PartyRig::new(&["a", "b", "c"], true);
    rig.pair_up("a", "b");
    // `c` 站在同一张图但不在队里：源 `info.massSpell=1` 说的是**队伍**，不是「同图所有人」。
    let map_id = rig.world.players["a"].map_id.clone();
    rig.world.players.get_mut("c").expect("outsider").map_id = map_id;

    let level = MageLevel {
        time: Some(240),
        x: Some(11),
        y: Some(11),
        z: Some(398),
        ..MageLevel::default()
    };
    rig.world
        .activate_advanced_blessing("a", SKILL_ADVANCED_BLESSING, &level);

    let expected = Some(BlessingBonus { pad: 11, mad: 11, pdd: 398 });
    assert_eq!(rig.world.players["a"].advanced_blessing, expected);
    assert_eq!(
        rig.world.players["b"].advanced_blessing,
        expected,
        "同图队友没拿到增益窗"
    );
    assert!(
        rig.world.players["b"].status.buff_active(SKILL_ADVANCED_BLESSING),
        "队友身上的窗口没挂上"
    );
    assert_eq!(
        rig.world.players["c"].advanced_blessing,
        None,
        "同图但不在队里的人不该拿到队伍增益"
    );
    // 队友**没有学**这一本也能生效 ⇒ 反证「加成不是按已学等级回表查出来的」。
    assert!(rig.world.players["b"]
        .state
        .skills
        .get(&SKILL_ADVANCED_BLESSING)
        .is_none());
}

// ── ④ 会话清理：换图 / 死亡 / 重连都要收掉 ──────────────────────────────────

#[test]
fn ab_window_is_cleared_by_the_session_reset() {
    let (mut world, _rx) = ab_world();
    ab_ready(&mut world, &[(SKILL_ADVANCED_BLESSING, 1)]);
    world.activate_advanced_blessing(
        AB_ACTOR,
        SKILL_ADVANCED_BLESSING,
        &MageLevel {
            time: Some(240),
            x: Some(11),
            y: Some(11),
            z: Some(398),
            ..MageLevel::default()
        },
    );
    let player = world.players.get_mut(AB_ACTOR).expect("joined actor");
    assert!(player.advanced_blessing.is_some());
    // `clear_beginner_buffs` 是死亡 / 换图 / 重连的唯一清理入口。
    clear_beginner_buffs(player);
    assert_eq!(
        player.advanced_blessing, None,
        "会话清理点没有收回進階祝福：换图后它会残留"
    );
}
