/// 四支柱战斗机制纵深（`mechanics.rs`）的验收（2026-09-22 第十三轮）。
///
/// 经 `include!` 进入 `world_tests.rs` 的 `mod tests`；本文件助手一律 `mech_` 前缀
/// （`include!` 把全部验收塞进同一模块，裸名会与既有验收撞名）。
///
/// 要钉住的是**判据**，不是某个数字：
///
/// * **计划从源字段派生**：段间隔、DoT 参数、第二命中盒三件事都由「字段在不在 +
///   值是多少」决定，没有按技能 id 写死的分支。所以第一条用例直接拿真实目录里
///   五条新接的技能当判据，并显式钉住两条最容易写反的语义：
///   `ballDelay: 0` 是「写明的 0」（首段本拍就到），不是「没写」；
///   `subTime` **单独出现时不参与段延迟**（它在召唤 / 持续场那边已被消费过一次）。
/// * **投射物在落地时重做碰撞判定**：发射后走进盒子的怪会被打到、走出去的不会；
///   主人换图或倒地时到期段被**静默丢弃**（不补发、不报错）。
/// * **DoT 叠层不重置节奏、不推怪**：连续点射越打越稳；源 `pushed` 那条「单次伤害
///   阈值」只属于直接命中，用每跳的小额伤害去推怪不是源语义。
/// * **二段命中只做分配、不新增**：`lt2`/`rb2` 比主盒窄，空挥不会凭空多一段。
/// * **结算优先级**：同一拍里 召唤物 → 投射物 → DoT，所以击杀归属不会被 DoT 从
///   投射物手里抢走。把 `world.rs` 里那三行的顺序换掉，本文件的优先级用例必红。
const MECH_ACTOR: &str = "mech-actor";
const MECH_MAP: &str = "mech-map";
const MECH_ELSEWHERE: &str = "mech-elsewhere";

/// 合成目录：三条机制形状清晰的技能。真实内容的间隔是百毫秒级的，观测窗口太窄，
/// 所以「跳伤节奏」「同拍优先级」这类**时间语义**要用合成长度来钉。
const MECH_DOT_SKILL: u32 = 2_001_998;
const MECH_BALL_SKILL: u32 = 2_001_997;
const MECH_MIX_SKILL: u32 = 2_001_996;

const MECH_CATALOG: &str = r#"{
  "sourceVersion": "mech-synthetic",
  "bookId": 200,
  "skills": {
    "2001998": {
      "name": "mech-dot",
      "maxLevel": 1,
      "bookId": 200,
      "levels": [{
        "attackCount": 1, "mobCount": 3, "damage": 100,
        "dot": 200, "dotTime": 6, "dotInterval": 1, "prop": 100,
        "lt": { "x": -800.0, "y": -200.0 }, "rb": { "x": 800.0, "y": 200.0 }
      }]
    },
    "2001997": {
      "name": "mech-ball",
      "maxLevel": 1,
      "bookId": 200,
      "levels": [{
        "attackCount": 3, "mobCount": 3, "damage": 100,
        "ballDelay": 0, "ballDelay1": 400, "ballDelay2": 400,
        "lt": { "x": -800.0, "y": -200.0 }, "rb": { "x": 800.0, "y": 200.0 }
      }]
    },
    "2001996": {
      "name": "mech-mix",
      "maxLevel": 1,
      "bookId": 200,
      "levels": [{
        "attackCount": 2, "mobCount": 1, "damage": 100,
        "ballDelay": 0, "ballDelay1": 1050,
        "dot": 100, "dotTime": 6, "dotInterval": 1, "prop": 100,
        "lt": { "x": -800.0, "y": -200.0 }, "rb": { "x": 800.0, "y": 200.0 }
      }]
    }
  }
}"#;

fn mech_catalog() -> MageSkills {
    serde_json::from_str(MECH_CATALOG).expect("synthetic mech catalog")
}

fn mech_template() -> MonsterTemplate {
    MonsterTemplate {
        max_hp: 1_000_000,
        exp: 0,
        // 击退阈值设成 1：任何 >0 的一次伤害都推得动它 ⇒「DoT 跳伤不推怪」那条断言
        // 才有对照（否则 0 位移可能只是阈值没过，判据是空的）。
        pushed: Some(1),
        ..life_template()
    }
}

fn mech_spawn(id: &str, x: f64) -> MonsterSpawn {
    life_spawn(id, MECH_MAP, x, -1, 0)
}

fn mech_world_with(
    catalog: MageSkills,
    spawns: Vec<MonsterSpawn>,
) -> (World, mpsc::Receiver<String>) {
    let gameplay = Gameplay {
        monsters: vec![mech_template()],
        spawns,
        monster_respawn_ms: Some(500),
        ..Gameplay::default()
    };
    let mut world = World::new_with_gameplay(life_map(MECH_MAP), 600, gameplay)
        .with_mage_skills(catalog);
    let mut rx = join_test_player(&mut world, MECH_ACTOR);
    while rx.try_recv().is_ok() {}
    (world, rx)
}

/// 合成目录的夹具：机制语义用。
fn mech_world(spawns: Vec<MonsterSpawn>) -> (World, mpsc::Receiver<String>) {
    mech_world_with(mech_catalog(), spawns)
}

/// 真实目录的夹具：**接线**用（新接的 31 条分支技能必须真的打得到人）。
fn mech_bundled_world(spawns: Vec<MonsterSpawn>) -> (World, mpsc::Receiver<String>) {
    mech_world_with(MageSkills::bundled(), spawns)
}

fn mech_learn(world: &mut World, levels: &[(u32, u32)]) {
    let player = world.players.get_mut(MECH_ACTOR).expect("joined actor");
    for (skill_id, level) in levels {
        player.state.skills.insert(*skill_id, *level);
    }
}

/// 把当事人摆到 `(x, y)`、面朝右、站在 1 号踏板上。
///
/// `max_mp` 由 `refresh_player_derived` 从 `base_max_mp` 派生（见 `derived.rs:172`），
/// 所以 MP 池必须先写 `base_max_mp` 再刷新，否则真实内容的高 MP 消耗技能会被判
/// 「MP 不足」——那会以「施法被拒」的形式炸掉，看起来像机制缺陷。
fn mech_place_actor(world: &mut World, job: u32, level: u32, x: f64, y: f64) {
    {
        let player = world.players.get_mut(MECH_ACTOR).expect("joined actor");
        player.state.job = job;
        player.state.level = level;
        player.state.x = x;
        player.state.y = y;
        player.state.facing = 1;
        player.state.grounded = true;
        player.state.action = "stand";
        player.base_max_mp = 99_999;
        player.state.mp = 99_999;
        player.foothold_id = 1;
        player.last_foothold_id = 1;
    }
    refresh_player_derived(
        &world.gameplay,
        &world.mage_skills,
        world.players.get_mut(MECH_ACTOR).unwrap(),
    );
    let player = world.players.get_mut(MECH_ACTOR).unwrap();
    player.state.max_hp = 99_999;
    player.state.hp = 99_999;
    player.state.mp = player.state.max_mp;
}

fn mech_level(world: &World, skill_id: u32) -> MageLevel {
    world
        .mage_skills
        .level(skill_id, 1)
        .cloned()
        .unwrap_or_else(|| panic!("level 1 for {skill_id}"))
}

fn mech_hp(world: &World, target_id: &str) -> i64 {
    world.monsters[target_id].state.hp
}

/// 摆位 id ≠ 运行期怪物 id：`spawn_monster_on_map` 会用 `monster-{n}-{随机}` 当键，
/// 摆位 id 只留在 `monster.spawn.id` 上。判据一律先把摆位 id 解析成运行期 id，
/// 否则断言会以「no entry found for key」的形式炸掉，看起来像机制没生效。
fn mech_monster(world: &World, spawn_id: &str) -> String {
    world
        .monsters
        .values()
        .find(|monster| monster.spawn.id == spawn_id)
        .map(|monster| monster.state.id.clone())
        .unwrap_or_else(|| panic!("no live monster for spawn {spawn_id}"))
}

/// 本次结算里 `targetId` 的播报条数。`second` 为真只数二段命中，为假只数首段链。
fn mech_count_events(events: &[serde_json::Value], target_id: &str, second: bool) -> usize {
    events
        .iter()
        .filter(|message| {
            message["type"] == "damageEvent"
                && message["targetId"] == target_id
                && (message["secondHit"] == true) == second
        })
        .count()
}

// ── ① 计划从源字段派生，不是按技能 id 写死 ────────────────────────────────────

#[test]
fn mech_plan_is_derived_from_source_fields_not_from_skill_ids() {
    let plan = |skill_id: u32| super::mechanics::AttackPlan::of(&mech_level_bundled(skill_id));

    // ① `1101011 雙連斬`：源只写了 ballDelay=0 与 ballDelay1=420。
    //    **写明的 0 与「没写」是两件事** —— 把 0 当成「没写」会把首段推到第 2 段的
    //    间隔上，於是「雙連斬」的第 1 段不再本拍就到。
    let double_slash = plan(1_101_011);
    assert_eq!(double_slash.segment_delay_ms, vec![0, 420]);
    assert_eq!(double_slash.immediate_segments(), vec![1]);
    assert_eq!(double_slash.flying_segments(), vec![(2, 420)]);
    assert!(double_slash.dot.is_none() && double_slash.second.is_none());

    // ② `4221014 致命暗殺`：源只写了 3 个间隔却有 6 段。后段必须沿用最后一个
    //    **已写明**的间隔，不是 0（当成 0 会让第 4 段之后的伤害瞬移到脸上）。
    let assassinate = plan(4_221_014);
    assert_eq!(assassinate.segment_delay_ms, vec![180, 360, 540, 720, 900, 1_080]);
    assert_eq!(assassinate.flying_segments().len(), 6);
    assert!(assassinate.immediate_segments().is_empty());

    // ③ `3111015 閃光幻象`：四个间隔齐备 ⇒ 四段全在飞；`damPlus` + `lt2`/`rb2`
    //    派生出一段「二段命中」，而**第二盒比主盒窄**（源里就是身前一块）。
    let illusion = plan(3_111_015);
    assert_eq!(illusion.segment_delay_ms, vec![480, 960, 1_440, 1_920]);
    assert_eq!(illusion.flying_segments().len(), 4);
    let second = illusion.second.expect("lt2/rb2 齐备 ⇒ 必须有二段计划");
    assert_eq!(second.damage_percent, 51, "源 damPlus=51，不回落主 damage");
    assert_eq!(
        (second.lt.x, second.lt.y, second.rb.x, second.rb.y),
        (-425.0, -180.0, 0.0, 40.0)
    );
    let main = mech_level_bundled(3_111_015);
    let (main_lt, main_rb) = (main.lt.unwrap(), main.rb.unwrap());
    assert!(
        main_rb.x > second.rb.x && main_lt.x < second.lt.x,
        "第二盒必须在主盒之内：主盒 {}..{} vs 第二盒 {}..{}",
        main_lt.x,
        main_rb.x,
        second.lt.x,
        second.rb.x
    );

    // ④ `4221010 穢土轉生`：没有 `ballDelay*` ⇒ 七段全在本拍即时结算（行为与本轮
    //    之前逐字相同），而 `dot`/`dotTime`/`dotInterval` 派生出一条 DoT。
    let rebirth = plan(4_221_010);
    assert_eq!(rebirth.segment_delay_ms, vec![0; 7]);
    assert!(rebirth.flying_segments().is_empty());
    let dot = rebirth.dot.expect("源 dot=94 ⇒ 必须有 DoT 计划");
    assert_eq!(dot.per_tick_percent, 94);
    assert_eq!(dot.cadence_ticks, 20, "dotInterval 1 秒 = 20 拍");
    assert_eq!(dot.duration_ticks, 100, "dotTime 5 秒 = 100 拍");
    assert_eq!(dot.prop, 100);
    assert!(rebirth.second.is_none(), "没有第二命中盒");

    // ⑤ `4221052 暗影霧殺`：带 `subTime` 但**没有** `ballDelay*`。`subTime` 单独出现
    //    时不许参与段延迟——它在召唤 / 持续场那边是脉冲周期（`step_summons` 已经
    //    消费过它），同一字段被两条路径各读一次会让召唤物的每一跳都变成飞行物。
    let mist = plan(4_221_052);
    assert_eq!(mist.segment_delay_ms, vec![0]);
    assert!(
        mist.flying_segments().is_empty(),
        "孤立的 subTime 不是投射物间隔"
    );

    // ⑥ `1221009 騎士衝擊波`：带 `prop` 但**没有** `dot` ⇒ 不挂 DoT。
    //    「有取值 ≠ 有消费点」：`prop` 只是「挂载几率」，没有可挂的东西时它是死参数。
    let shock = plan(1_221_009);
    assert!(shock.dot.is_none());
    assert!(shock.second.is_none());
    assert!(shock.flying_segments().is_empty());
}

fn mech_level_bundled(skill_id: u32) -> MageLevel {
    MageSkills::bundled()
        .level(skill_id, 1)
        .cloned()
        .unwrap_or_else(|| panic!("bundled level 1 for {skill_id}"))
}

// ── ② DoT：叠层、节奏、不推怪 ────────────────────────────────────────────────

#[test]
fn mech_dot_stacks_caps_without_rescheduling_and_never_knocks_back() {
    let (mut world, _rx) = mech_world(vec![mech_spawn("mob-a", 150.0)]);
    mech_place_actor(&mut world, 200, 30, 100.0, 100.0);
    let target = mech_monster(&world, "mob-a");
    let level = mech_level(&world, MECH_DOT_SKILL);

    let hp_before = mech_hp(&world, &target);
    world
        .cast_elemental_area(MECH_ACTOR, "dot-1", MECH_DOT_SKILL, &level, false)
        .unwrap();

    // 支柱①「首段直接伤害」：没有段间隔 ⇒ 本拍结算。
    assert!(mech_hp(&world, &target) < hp_before, "首段必须即时结算");
    // 支柱②「DoT 挂载」：首段真的命中之后。
    let first = world
        .mechanics
        .dot(MECH_ACTOR, MECH_DOT_SKILL, &target)
        .cloned()
        .expect("首段命中后必须挂上 DoT");
    assert_eq!(first.stacks, 1);
    assert_eq!(first.cadence_ticks, 20);
    assert_eq!(
        first.next_tick,
        world.tick + 1,
        "首次跳伤落在下一拍，不是「等一个间隔再开始」"
    );
    assert!(first.per_tick > 0);
    // 直接命中登记了击退（阈值是 1，任何 >0 的伤害都推得动）。
    assert_ne!(
        world.monsters[&target].knockback_pixels, 0.0,
        "对照：直接命中在 pushed=1 时必须登记击退"
    );

    // DoT 跳伤：`per_tick × stacks`，且**不推怪**。
    world.monsters.get_mut(&target).unwrap().knockback_pixels = 0.0;
    let dot = world
        .mechanics
        .dot(MECH_ACTOR, MECH_DOT_SKILL, &target)
        .cloned()
        .unwrap();
    let hp_before_pulse = mech_hp(&world, &target);
    world.tick = dot.next_tick;
    world.step_monster_dots();
    assert_eq!(
        mech_hp(&world, &target),
        hp_before_pulse - dot.per_tick * i64::from(dot.stacks),
        "一跳 = per_tick × stacks"
    );
    assert_eq!(
        world.monsters[&target].knockback_pixels, 0.0,
        "DoT 跳伤不推怪：pushed 是「单次伤害阈值」，用每跳的小额伤害去推不是源语义"
    );
    assert_eq!(
        world
            .mechanics
            .dot(MECH_ACTOR, MECH_DOT_SKILL, &target)
            .unwrap()
            .pulse_index,
        1,
        "跳伤本身不刷新自己（不会自激）"
    );

    // 叠层：重复命中 +1，且**不重置**下一次跳伤时刻。
    let before = world
        .mechanics
        .dot(MECH_ACTOR, MECH_DOT_SKILL, &target)
        .cloned()
        .unwrap();
    world
        .cast_elemental_area(MECH_ACTOR, "dot-2", MECH_DOT_SKILL, &level, false)
        .unwrap();
    let after = world
        .mechanics
        .dot(MECH_ACTOR, MECH_DOT_SKILL, &target)
        .cloned()
        .unwrap();
    assert_eq!(after.stacks, before.stacks + 1, "重复命中叠层 +1");
    assert_eq!(
        after.next_tick, before.next_tick,
        "叠层不许把跳伤推后：连续点射是「越打越稳」不是「越打越拖」"
    );
    assert_eq!(world.mechanics.dot_count(), 1, "同一个 (施法者, 技能, 目标) 只有一个实例");

    // 叠层封顶：第 6 次命中只刷新时长，不再涨伤害。
    for index in 0..8 {
        world
            .cast_elemental_area(
                MECH_ACTOR,
                &format!("dot-cap-{index}"),
                MECH_DOT_SKILL,
                &level,
                false,
            )
            .unwrap();
    }
    assert_eq!(
        world
            .mechanics
            .dot(MECH_ACTOR, MECH_DOT_SKILL, &target)
            .unwrap()
            .stacks,
        super::mechanics::DOT_MAX_STACKS
    );

    // 施法者离场 ⇒ DoT 立刻被拆掉（与投射物、召唤物同一条在场判据）。
    world.players.get_mut(MECH_ACTOR).unwrap().state.hp = 0;
    world.players.get_mut(MECH_ACTOR).unwrap().state.action = "dead";
    world.step_monster_dots();
    assert_eq!(world.mechanics.dot_count(), 0, "施法者倒地 ⇒ 残余伤害随之作废");
}

// ── ③ 投射物：发射、飞行、落地重做碰撞判定 ────────────────────────────────────

#[test]
fn mech_projectile_rechecks_collision_when_it_lands() {
    let (mut world, _rx) = mech_world(vec![
        mech_spawn("mob-in", 150.0),
        mech_spawn("mob-out", 250.0),
    ]);
    mech_place_actor(&mut world, 200, 30, 100.0, 100.0);
    let level = mech_level(&world, MECH_BALL_SKILL);
    let inside = mech_monster(&world, "mob-in");
    let outside = mech_monster(&world, "mob-out");
    // 装配期会把摆位夹回地图（`life_map` 只有 0..300），所以「盒外的怪」要在建好
    // 世界之后**直接改坐标**摆出去 —— 这同时说明判据是运行期的，不是摆位期的。
    world.monsters.get_mut(&outside).unwrap().state.x = 1_500.0;

    let out_before = mech_hp(&world, &outside);
    world
        .cast_elemental_area(MECH_ACTOR, "ball-1", MECH_BALL_SKILL, &level, false)
        .unwrap();
    let cast_tick = world.tick;
    // 第 1 段延迟 0 ⇒ 本拍即时，第 2/3 段登记为飞行物。
    assert_eq!(world.mechanics.projectile_count(), 2);
    assert!(mech_hp(&world, &inside) < 1_000_000, "第 1 段即时落地");
    assert_eq!(
        mech_hp(&world, &outside),
        out_before,
        "发射瞬间不在 ±800 盒里的怪不吃第 1 段"
    );

    // 发射后走进盒子 ⇒ 到达时**重新判定**，应该被打到。
    world.monsters.get_mut(&outside).unwrap().state.x = 150.0;
    world.tick = cast_tick + 8; // 400ms = 8 拍
    world.step_projectiles();
    assert_eq!(world.mechanics.projectile_count(), 1);
    assert!(
        mech_hp(&world, &outside) < out_before,
        "发射后走进命中盒的怪必须被落地段打到"
    );
    let out_after_two = mech_hp(&world, &outside);

    // 走出去的怪**不会**被落地段追加打到。
    let in_after_two = mech_hp(&world, &inside);
    world.monsters.get_mut(&inside).unwrap().state.x = 1_500.0;
    world.tick = cast_tick + 16; // 800ms = 16 拍
    world.step_projectiles();
    assert_eq!(world.mechanics.projectile_count(), 0);
    assert_eq!(
        mech_hp(&world, &inside),
        in_after_two,
        "走出去的怪不会被落地段追加打到"
    );
    assert!(
        mech_hp(&world, &outside) < out_after_two,
        "还在盒子里的怪继续吃第 3 段"
    );
}

#[test]
fn mech_projectile_is_dropped_silently_when_the_caster_leaves_or_dies() {
    let (mut world, _rx) = mech_world(vec![mech_spawn("mob-a", 150.0)]);
    mech_place_actor(&mut world, 200, 30, 100.0, 100.0);
    let level = mech_level(&world, MECH_BALL_SKILL);
    let target = mech_monster(&world, "mob-a");

    // 换图：投射物**不跟着主人走**（发射点是施法拍冻结的），到期那一段被静默丢弃。
    world
        .cast_elemental_area(MECH_ACTOR, "ball-leave", MECH_BALL_SKILL, &level, false)
        .unwrap();
    let cast_tick = world.tick;
    assert_eq!(world.mechanics.projectile_count(), 2);
    // 基准血量取在**施法之后**：第 1 段延迟 0、本拍就已落地，拿施法前的血量当基准
    // 会把那一段算到「被丢弃的段」头上。
    let hp_after_immediate = mech_hp(&world, &target);
    world.players.get_mut(MECH_ACTOR).unwrap().map_id = MECH_ELSEWHERE.to_owned();
    world.tick = cast_tick + 8;
    world.step_projectiles();
    assert_eq!(
        world.mechanics.projectile_count(),
        1,
        "到期段被丢弃，另一半还在飞"
    );
    assert_eq!(
        mech_hp(&world, &target),
        hp_after_immediate,
        "被丢弃的段不产生伤害"
    );

    // 回到同一张图：剩下那一段照常见掉 —— 丢弃是「那一段」的事，不是整次施法的事。
    world.players.get_mut(MECH_ACTOR).unwrap().map_id = MECH_MAP.to_owned();
    world.tick = cast_tick + 16;
    let hp_before = mech_hp(&world, &target);
    world.step_projectiles();
    assert_eq!(world.mechanics.projectile_count(), 0);
    assert!(
        mech_hp(&world, &target) < hp_before,
        "回到同一张图后剩余段正常落地"
    );

    // 倒地：飞行中的段全部作废。
    world
        .cast_elemental_area(MECH_ACTOR, "ball-dead", MECH_BALL_SKILL, &level, false)
        .unwrap();
    assert_eq!(world.mechanics.projectile_count(), 2);
    {
        let player = world.players.get_mut(MECH_ACTOR).unwrap();
        player.state.hp = 0;
        player.state.action = "dead";
    }
    world.tick += 16;
    world.step_projectiles();
    assert_eq!(
        world.mechanics.projectile_count(),
        0,
        "倒地的主人发出去的段全部作废"
    );
}

// ── ④ 二段命中：`lt2/rb2` 独立重选，空挥不加段（真实内容，走 `handle_cast_skill`）──

#[test]
fn mech_second_hit_uses_the_narrow_box_and_needs_a_real_first_hit() {
    let (mut world, mut rx) = mech_bundled_world(vec![
        mech_spawn("mob-front", 150.0),
        mech_spawn("mob-back", 50.0),
    ]);
    mech_learn(&mut world, &[(SKILL_PHANTOM_ILLUSION, 1)]);
    mech_place_actor(&mut world, 311, 120, 100.0, 100.0);
    let front = mech_monster(&world, "mob-front");
    let back = mech_monster(&world, "mob-back");

    // 真实施法入口：证明这条技能在 `castable` 里**并且**真的接上了结算链。
    let hp_before = (mech_hp(&world, &front), mech_hp(&world, &back));
    world.handle_cast_skill(
        MECH_ACTOR.into(),
        "phantom-1".into(),
        SKILL_PHANTOM_ILLUSION,
        Some(1),
        Some(0),
    );
    let cast = chapter_drain(&mut rx);
    assert!(
        cast.iter()
            .any(|message| message["type"] == "skillResult" && message["success"] == true),
        "施法被拒：{cast:?}"
    );
    assert_eq!(
        hp_before,
        (mech_hp(&world, &front), mech_hp(&world, &back)),
        "四段全在飞 ⇒ 施法拍本身不该立刻掉血"
    );
    assert_eq!(world.mechanics.projectile_count(), 4);

    // 一路推到第四段落地（1920ms ⇒ 39 拍）：最后一段负责收尾，二段在那里追加。
    let cast_tick = world.tick;
    world.tick = cast_tick + 39;
    world.step_projectiles();
    assert_eq!(world.mechanics.projectile_count(), 0);
    let events = chapter_drain(&mut rx);
    assert_eq!(
        mech_count_events(&events, &front, false),
        4,
        "主盒里每段各一条：{events:?}"
    );
    assert_eq!(mech_count_events(&events, &back, false), 4);
    assert_eq!(
        mech_count_events(&events, &front, true),
        1,
        "二段命中必须落在 `lt2/rb2`（身前一块）里的目标上"
    );
    assert_eq!(
        mech_count_events(&events, &back, true),
        0,
        "身后的怪在第二盒之外 ⇒ 只吃主盒的四段"
    );

    // 空挥不加段：目标全在盒外 ⇒ 主盒一段都没打到，二段也不许凭空出现。
    world.monsters.get_mut(&front).unwrap().state.x = 3_000.0;
    world.monsters.get_mut(&back).unwrap().state.x = 3_000.0;
    world.players.get_mut(MECH_ACTOR).unwrap().skill_cooldowns.clear();
    world
        .players
        .get_mut(MECH_ACTOR)
        .unwrap()
        .state
        .mp = 99_999;
    world.handle_cast_skill(
        MECH_ACTOR.into(),
        "phantom-2".into(),
        SKILL_PHANTOM_ILLUSION,
        Some(1),
        Some(0),
    );
    let empty_tick = world.tick;
    world.tick = empty_tick + 39;
    world.step_projectiles();
    let empty = chapter_drain(&mut rx);
    assert_eq!(
        empty
            .iter()
            .filter(|message| message["type"] == "damageEvent")
            .count(),
        0,
        "空挥不该产生任何伤害：{empty:?}"
    );
    assert_eq!(
        empty
            .iter()
            .filter(|message| message["secondHit"] == true)
            .count(),
        0,
        "二段要求首段链真的打到人"
    );
}

// ── ⑤ 结算优先级：同一拍里 投射物 先于 DoT，击杀归属不会被抢 ──────────────────

#[test]
fn mech_world_tick_settles_summon_then_projectile_then_dot() {
    let (mut world, mut rx) = mech_world(vec![mech_spawn("mob-a", 150.0)]);
    mech_place_actor(&mut world, 200, 30, 100.0, 100.0);
    let target = mech_monster(&world, "mob-a");
    let level = mech_level(&world, MECH_MIX_SKILL);

    // 这条技能同时带 `ballDelay1: 1050` 与 `dotInterval: 1`：
    //   第 2 段到达 = 21 拍；DoT 首跳在 1 拍、之后每 20 拍 ⇒ **第 21 拍两者同拍**。
    world
        .cast_elemental_area(MECH_ACTOR, "mix-1", MECH_MIX_SKILL, &level, false)
        .unwrap();
    let cast_tick = world.tick;
    let dot = world
        .mechanics
        .dot(MECH_ACTOR, MECH_MIX_SKILL, &target)
        .cloned()
        .expect("第 1 段即时命中 ⇒ DoT 已挂上");
    assert_eq!(dot.next_tick, cast_tick + 1);
    assert_eq!(dot.next_tick + dot.cadence_ticks, cast_tick + 21);
    assert_eq!(world.mechanics.projectile_count(), 1);

    for _ in 0..20 {
        world.step();
    }
    assert_eq!(world.tick, cast_tick + 20);
    assert_eq!(
        world.mechanics.projectile_count(),
        1,
        "第 2 段还没到（21 拍）"
    );

    // 把血量压到「下一击必杀」，让同拍的两者竞争同一个击杀归属。
    world.monsters.get_mut(&target).unwrap().state.hp = 1;
    while rx.try_recv().is_ok() {}
    world.step();
    let kill_tick = world.tick;
    assert_eq!(kill_tick, cast_tick + 21);

    let events = chapter_drain(&mut rx);
    let at_kill = events
        .iter()
        .filter(|message| {
            message["type"] == "damageEvent" && message["serverTick"].as_u64() == Some(kill_tick)
        })
        .collect::<Vec<_>>();
    assert_eq!(
        at_kill.len(),
        1,
        "同一拍只应有一条致命播报（投射物先结算，DoT 随后发现目标已死）：{events:?}"
    );
    assert_eq!(at_kill[0]["killed"], true);
    assert_eq!(at_kill[0]["segment"], 2, "击杀必须来自投射物那一段");
    assert!(
        at_kill[0].get("dot").is_none(),
        "击杀归属被 DoT 抢走了：世界拍的顺序必须是 召唤物 → 投射物 → DoT"
    );
    assert_eq!(
        world.mechanics.dot_count(),
        0,
        "目标死亡后 DoT 立刻被拆掉"
    );
}

// ── ⑥ S1 施放窗（窄口径·自增益）───────────────────────────────
// 施放 `1221052 神之滅擊` → 施法者身上开出一段自增益窗（源 `time=10` ⇒ 10 000 ms =
// 200 拍到点），到期由 `world.step()` 里 `player.status.advance()` 的既有清理点精确收回，
// 不留尾巴。
//
// 反面承接门禁的**窄口径**：`time` 还有「负面状态窗 / 召唤存活」两种语义，仍被挡在
// `PHYSICAL_AREA_ATTACKS` 外。这里用 `1121015 烈焰翔斬`（`time` 是 burn 负面状态窗）
// 当伪造请求——它既不许被施放成自增益窗，运行时拒绝语义必须与门禁静态挡一致。

#[test]
fn mech_self_buff_window_opens_and_expires_exactly() {
    let (mut world, mut rx) = mech_bundled_world(vec![mech_spawn("mob-g", 100.0)]);
    mech_learn(&mut world, &[(SKILL_GODS_ANNIHILATION, 1)]);
    // `1221052` 是 Hyper 主动技能（源 requiredLevel=160）：等级必须 ≥ 160 才能施放。
    mech_place_actor(&mut world, 122, 200, 100.0, 100.0);

    // 真实施法入口：证明这条技能在 `castable` 里且真的接上了物理范围管线。
    world.handle_cast_skill(
        MECH_ACTOR.into(),
        "annihilate-1".into(),
        SKILL_GODS_ANNIHILATION,
        Some(1),
        Some(0),
    );
    let cast = chapter_drain(&mut rx);
    assert!(
        cast.iter()
            .any(|m| m["type"] == "skillResult" && m["success"] == true),
        "施法被拒：{cast:?}"
    );

    // ① 自增益窗在施放拍就地出现，且 tick 语义到位：time=10 ⇒ 整 10 000 ms、
    //    `until = now + 200 拍`，剩余毫秒在施放拍就是整 10 000（不是少 1 拍）。
    let cast_tick = world.tick;
    assert!(
        world
            .players
            .get(MECH_ACTOR)
            .unwrap()
            .status
            .buff_active(SKILL_GODS_ANNIHILATION),
        "神之滅擊 施放后应立即出现自增益窗"
    );
    assert_eq!(
        world
            .players
            .get(MECH_ACTOR)
            .unwrap()
            .status
            .buff_remaining_ms(SKILL_GODS_ANNIHILATION),
        Some(10_000),
        "time=10（秒）×1000 ⇒ 窗 10 000 ms，且在施放拍整到位"
    );

    // ② 推进 200 拍到截止点：既有清理点精确收回，不泄漏。
    for _ in 0..200 {
        world.step();
    }
    assert_eq!(world.tick, cast_tick + 200);
    let player = world.players.get(MECH_ACTOR).expect("joined actor");
    assert!(
        !player.status.buff_active(SKILL_GODS_ANNIHILATION),
        "到点必须收回，不能由逐相减的裸字段停在 0"
    );
    assert!(
        player.status.buff_map().is_empty(),
        "收回后不留任何增益尾巴（唯一时钟不泄漏）"
    );
}

#[test]
fn mech_recast_refreshes_without_stacking_and_gated_negative_time_opens_no_window() {
    // ③ 甲：重复施放 = 刷新，不叠加。清掉冷却再放，仍是**单条**窗口、剩余整 10 s。
    let (mut world, mut rx) = mech_bundled_world(vec![mech_spawn("mob-g", 100.0)]);
    mech_learn(&mut world, &[(SKILL_GODS_ANNIHILATION, 1)]);
    mech_place_actor(&mut world, 122, 200, 100.0, 100.0);
    world.handle_cast_skill(
        MECH_ACTOR.into(),
        "annihilate-1".into(),
        SKILL_GODS_ANNIHILATION,
        Some(1),
        Some(0),
    );
    while rx.try_recv().is_ok() {}
    {
        let player = world.players.get_mut(MECH_ACTOR).unwrap();
        player.skill_cooldowns.clear();
    }
    world.handle_cast_skill(
        MECH_ACTOR.into(),
        "annihilate-2".into(),
        SKILL_GODS_ANNIHILATION,
        Some(1),
        Some(0),
    );
    while rx.try_recv().is_ok() {}
    let buff_map = world.players.get(MECH_ACTOR).unwrap().status.buff_map();
    assert_eq!(
        buff_map.len(),
        1,
        "重复施放不得叠加：同一技能只能有一条窗口"
    );
    assert_eq!(
        buff_map.get(&SKILL_GODS_ANNIHILATION).copied(),
        Some(10_000),
        "刷新让它回到整 10 s，而不是在剩余时间上相加（去重，不延长）"
    );

    // ③ 乙：伪造请求——`1121015 烈焰翔斬` 的 `time` 是 burn 负面状态窗（未接线）。
    // 施放它不许冒出任何自增益窗；运行时拒绝语义与门禁静态挡在表外一致。
    let (mut w2, mut rx2) = mech_bundled_world(vec![]);
    mech_learn(&mut w2, &[(1_121_015, 1)]);
    mech_place_actor(&mut w2, 112, 120, 100.0, 100.0);
    w2.handle_cast_skill(MECH_ACTOR.into(), "flame-1".into(), 1_121_015, Some(1), Some(0));
    let out = chapter_drain(&mut rx2);
    let player = w2.players.get(MECH_ACTOR).expect("joined actor");
    assert!(
        !player.status.buff_active(1_121_015),
        "负面状态窗的 `time` 不许被误接成自增益窗"
    );
    assert!(
        player.status.buff_map().is_empty(),
        "伪造的负面窗请求被挡：不得冒出任何自增益窗口：{out:?}"
    );
}

// ── ⑦ S5 召唤通用化（一条队列服务三件召唤）──────────────────────
// 收口前的账是「队列 `summons` 限 2（冰魔 / 冰鋒刃）+ 单槽 `summon` 1（三转球形闪电）」，
// 于是同一份「到期 / 换图收回 + 周期打击」判据写了两遍、位移形态按 `skill_id` 分支。
// 现在三件共用一条队列、容量判据只剩 `SUMMON_BUDGET = 3`（= 合并前的 2 + 1），
// 且**脉冲周期**只剩一个源字段派生点 `summon_pulse_ms`。
//
// 这条用例钉的就是「收口没有改动行为」：三件共存、各自的位移形态、以及三件的周期
// 逐件等于收口前硬编码的值（冰魔 1080 / 冰鋒刃 210 / 閃電球 1080）。
#[test]
fn mech_summon_slots_are_one_queue_and_pulse_period_comes_from_source() {
    let (mut world, _rx) = mech_bundled_world(vec![mech_spawn("mob-s", 100.0)]);
    mech_learn(
        &mut world,
        &[
            (SKILL_ICE_DEMON, 1),
            (SKILL_FROZEN_ORB, 1),
            (SKILL_THUNDER_SPHERE, 1),
        ],
    );
    mech_place_actor(&mut world, 222, 120, 100.0, 100.0);

    let demon = world.mage_skills.level(SKILL_ICE_DEMON, 1).cloned().unwrap();
    let orb = world.mage_skills.level(SKILL_FROZEN_ORB, 1).cloned().unwrap();
    let sphere = world
        .mage_skills
        .level(SKILL_THUNDER_SPHERE, 1)
        .cloned()
        .unwrap();
    world.cast_demon_summon(MECH_ACTOR, "demon-1", SKILL_ICE_DEMON, &demon).unwrap();
    world.cast_frozen_orb(MECH_ACTOR, "orb-1", &orb).unwrap();
    world
        .cast_thunder_sphere(MECH_ACTOR, "sphere-1", &sphere, 0)
        .unwrap();

    // ① 三件共存于同一条队列：这正是收口前「队列 2 + 单槽 1」的等价形态。
    let player = world.players.get(MECH_ACTOR).unwrap();
    let ids = player
        .summons
        .iter()
        .map(|summon| summon.skill_id)
        .collect::<Vec<_>>();
    assert_eq!(
        ids.len(),
        3,
        "冰魔 / 冰鋒刃 / 球形闪电必须能同时在场：{ids:?}"
    );
    for skill_id in [SKILL_ICE_DEMON, SKILL_FROZEN_ORB, SKILL_THUNDER_SPHERE] {
        assert!(ids.contains(&skill_id), "缺了 {skill_id}：{ids:?}");
    }

    // ② 容量判据就这么一条：3 槽用满即「装不下」，收口前那两套账（`2` 与单槽）已不存在。
    assert!(
        !World::summon_slots_available(world.players.get(MECH_ACTOR).unwrap()),
        "三件都在场时必须报「装不下」，否则上限已悄悄抬高"
    );

    // ③ 位移形态在施放时定下，`step_summons` 不再按 `skill_id` 分支：
    //    冰魔钉在施放点、冰鋒刃沿朝向自行前进、球形闪电跟着主人走。
    let owner_before = world.players[MECH_ACTOR].state.x;
    {
        let player = world.players.get_mut(MECH_ACTOR).unwrap();
        player.state.x = owner_before + 300.0;
    }
    let before: Vec<(u32, f64)> = world.players[MECH_ACTOR]
        .summons
        .iter()
        .map(|summon| (summon.skill_id, summon.x))
        .collect();
    world.step_summons();
    let owner_now = world.players[MECH_ACTOR].state.x;
    let after = |skill_id: u32| {
        world.players[MECH_ACTOR]
            .summons
            .iter()
            .find(|summon| summon.skill_id == skill_id)
            .map(|summon| summon.x)
            .unwrap()
    };
    let x_before = |skill_id: u32| {
        before
            .iter()
            .find(|(id, _)| *id == skill_id)
            .map(|(_, x)| *x)
            .unwrap()
    };
    assert_eq!(
        after(SKILL_ICE_DEMON),
        x_before(SKILL_ICE_DEMON),
        "冰魔锚定在施放点，不跟主人走"
    );
    assert_eq!(
        after(SKILL_THUNDER_SPHERE),
        owner_now,
        "球形闪电的移动形态跟主人走"
    );
    assert!(
        after(SKILL_FROZEN_ORB) > x_before(SKILL_FROZEN_ORB),
        "冰鋒刃沿朝向自行前进（既有的 P 运动学，收口不该把它变成跟随）"
    );

    // ④ 脉冲周期是源字段派生，且**逐件等于收口前的硬编码值**（零行为漂移）。
    assert_eq!(
        summon_pulse_ms(&world.mage_skills, SKILL_FROZEN_ORB, 1),
        210,
        "冰鋒刃：源 `attackDelay = 210`（毫秒槽）"
    );
    assert_eq!(
        summon_pulse_ms(&world.mage_skills, SKILL_THUNDER_SPHERE, 1),
        1_080,
        "閃電球：源 `subTime = 1080`（本身就是毫秒）"
    );
    assert_eq!(
        summon_pulse_ms(&world.mage_skills, SKILL_ICE_DEMON, 1),
        1_080,
        "召喚冰魔：源 `subTime = 8` 小于一拍、不是毫秒 ⇒ 回落契约值 1080"
    );

    // ⑤ 派生值真的被消费：脉冲后 `next_hit_at` 恰好推进「周期 ÷ 一拍」向上取整。
    let pulse_tick = world.tick;
    {
        let player = world.players.get_mut(MECH_ACTOR).unwrap();
        for summon in player.summons.iter_mut() {
            summon.next_hit_at = pulse_tick;
        }
    }
    world.step_summons();
    for summon in world.players[MECH_ACTOR].summons.iter() {
        let expected = summon_pulse_ms(&world.mage_skills, summon.skill_id, summon.level)
            .div_ceil(TICK_MS);
        assert_eq!(
            summon.next_hit_at - pulse_tick,
            expected,
            "{} 的下一跳没有按派生周期推进",
            summon.skill_id
        );
    }
}

// ── ⑧ 召唤存活时长：收口成一个源字段派生点（2026-09-23）────────────────────────
// 收口前的账是**三处各写一份、而且互相不一致**：`cast_demon_summon` 把源 `time` 当秒
// （`× 1000`）、`cast_thunder_sphere` 也当秒但默认值另写 20／60 秒、
// `cast_frozen_orb` **根本不读源**（写死 `4_000`，源改数就静默漂移）。
// 现在三处都走 `mechanics.rs::summon_lifetime_ms`，单位判据与默认值都只剩那一处。
//
// 这条用例钉四件事：① 五本已接线召唤书的派生值逐件等于源值（含全书**唯一**那条按毫秒
// 书写的 `2221012 冰鋒刃`）；② 兜底分支不可达（五本**逐级**都带 `time`）；
// ③ 派生值真的被消费到到期时刻上；④ 单位判据本身是「按量级认单位」，跨过 1000 就换
// 单位，且「写明的 0」不许被并进「缺失 ⇒ 兜底值」那一支。
//
// ④ 用合成目录钉，理由与 ② 的合成目录同：真实内容的 `time` 是源给的定值，**扰动不了**，
// 而这条判据最容易写错的地方恰恰是分界两侧。
const MECH_LIFETIME_CATALOG: &str = r#"{
  "sourceVersion": "mech-synthetic",
  "bookId": 200,
  "skills": {
    "2001995": { "name": "mech-seconds", "maxLevel": 1, "levels": [{ "time": 999 }] },
    "2001994": { "name": "mech-millis", "maxLevel": 1, "levels": [{ "time": 1000 }] },
    "2001993": { "name": "mech-zero", "maxLevel": 1, "levels": [{ "time": 0 }] },
    "2001992": { "name": "mech-missing", "maxLevel": 1, "levels": [{ "damage": 1 }] }
  }
}"#;

#[test]
fn mech_summon_lifetime_comes_from_one_source_derivation() {
    // ① 逐件等于源值。源 `shared/mage-skills.json` 等级 1：
    //    冰魔／火魔 `time=115`（**秒**）、冰鋒刃 `time=4000`（**毫秒**）、
    //    閃電球 `2211011` `time=63`（秒）、hidden 的 `2211015` `time=22`（秒）。
    let skills = MageSkills::bundled();
    let wired: [(u32, u64); 5] = [
        (SKILL_ICE_DEMON, 115_000),
        (SKILL_FIRE_DEMON, 115_000),
        (SKILL_FROZEN_ORB, 4_000),
        (SKILL_THUNDER_SPHERE, 63_000),
        (SKILL_THUNDER_SPHERE_HIDDEN, 22_000),
    ];
    for (skill_id, want) in wired {
        assert_eq!(
            summon_lifetime_ms(&skills, skill_id, 1),
            want,
            "{skill_id} 的存活时长没有按源 `time` 派生"
        );
    }
    // 反向断言：唯一按毫秒书写的那本**不许**被当成秒。改前 `cast_frozen_orb` 写死
    // 4000 恰好是对的，所以这里钉的不是「数值变了」而是「数值的来源变了」——
    // 谁把分界判据去掉、一律 ×1000，本条当场红。
    assert_ne!(
        summon_lifetime_ms(&skills, SKILL_FROZEN_ORB, 1),
        4_000_000,
        "冰鋒刃的 `time=4000` 本身就是毫秒，再 ×1000 会把 4 秒变成 66 分钟"
    );

    // ② 兜底不可达：五本**逐级**都带 `time`，所以 `SUMMON_LIFETIME_FALLBACK_MS` 在
    //    已接线的召唤上永远走不到。谁把某一级的 `time` 删了，这里先红——那时到期时刻
    //    会静默从「源值」变成「契约值」，实玩上表现为召唤物活得比源里短或长。
    for (skill_id, _) in wired {
        let max_level = skills.get(skill_id).expect("wired summon book").max_level;
        for level in 1..=max_level {
            assert!(
                skills
                    .level(skill_id, level)
                    .and_then(|row| row.time)
                    .is_some(),
                "{skill_id} 的 {level} 级没有 `time` ⇒ 存活时长会落到契约兜底值"
            );
        }
    }

    // ③ 派生值真被消费：三件召唤各放一次，到期时刻恰好是「派生值 ÷ 一拍向上取整」。
    let (mut world, _rx) = mech_bundled_world(vec![mech_spawn("mob-l", 100.0)]);
    mech_learn(
        &mut world,
        &[
            (SKILL_ICE_DEMON, 1),
            (SKILL_FROZEN_ORB, 1),
            (SKILL_THUNDER_SPHERE, 1),
        ],
    );
    mech_place_actor(&mut world, 222, 120, 100.0, 100.0);
    let demon = world.mage_skills.level(SKILL_ICE_DEMON, 1).cloned().unwrap();
    let orb = world.mage_skills.level(SKILL_FROZEN_ORB, 1).cloned().unwrap();
    let sphere = world
        .mage_skills
        .level(SKILL_THUNDER_SPHERE, 1)
        .cloned()
        .unwrap();
    let cast_tick = world.tick;
    world
        .cast_demon_summon(MECH_ACTOR, "demon-l", SKILL_ICE_DEMON, &demon)
        .unwrap();
    world.cast_frozen_orb(MECH_ACTOR, "orb-l", &orb).unwrap();
    world
        .cast_thunder_sphere(MECH_ACTOR, "sphere-l", &sphere, 0)
        .unwrap();
    assert_eq!(
        world.players[MECH_ACTOR].summons.len(),
        3,
        "三件召唤都该在场，否则下面只验到了一部分"
    );
    for summon in world.players[MECH_ACTOR].summons.iter() {
        let expected_ticks = summon_lifetime_ms(&world.mage_skills, summon.skill_id, summon.level)
            .div_ceil(TICK_MS)
            .max(1);
        assert_eq!(
            summon.expires_at - cast_tick,
            expected_ticks,
            "{} 的到期时刻没有按派生时长设置",
            summon.skill_id
        );
    }

    // ④ 单位判据的扰动验证：三本合成技能同形，只差 `time` 一个字段。
    let synthetic: MageSkills =
        serde_json::from_str(MECH_LIFETIME_CATALOG).expect("synthetic lifetime catalog");
    assert_eq!(
        summon_lifetime_ms(&synthetic, 2_001_995, 1),
        999_000,
        "999 在分界下方 ⇒ 按秒 ×1000"
    );
    assert_eq!(
        summon_lifetime_ms(&synthetic, 2_001_994, 1),
        1_000,
        "1000 落在分界上 ⇒ 源里写的就是毫秒，不再 ×1000"
    );
    assert_eq!(
        summon_lifetime_ms(&synthetic, 2_001_993, 1),
        0,
        "写明的 0 是「写明的 0」，不许并进「缺失 ⇒ 兜底值」那一支"
    );
    assert_eq!(
        summon_lifetime_ms(&synthetic, 2_001_992, 1),
        SUMMON_LIFETIME_FALLBACK_MS,
        "只有 `time` 真的缺失才落到契约兜底值"
    );
}
