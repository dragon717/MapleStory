/// 技能轉換 `2321054 復仇天使`（主教四转 Hyper 主动）的接线验收（2026-09-24）。
///
/// 经 `include!` 进入 `world_tests.rs` 的 `mod tests`；本文件助手一律 `xform_` 前缀
/// （`include!` 把全部验收塞进同一模块，裸名会与既有验收撞名）。
///
/// 要钉住的是**判据**，不是某个数字：
///
/// * **转换态不新增状态位**：它从「技能表里有没有復仇那一侧」派生（`transform_done`），
///   于是随技能存档持久，也让「转换只需发生一次」天然幂等。
/// * **准入按形态反转，两个方向都要测**：「转换前復仇侧被 `skill_hidden` 拒」与
///   「转换后慈愛侧被 `skill_transformed` 拒」是两条**独立**的断言 ——
///   只测一侧的话，把整条闸门删掉也能通过。
/// * **授予等级＝慈愛那一侧的已学等级**：不是 1 级、也不是最大等级；没学的不凭空给。
/// * **`[被動效果]` 三项按「学得即生效」消费**：`madX` 进属性层、`mdR` 与
///   `ignoreMobpdpR` 进伤害管线；三处都要真的出现留痕，而不是「表里有这个 id」。
const XFORM_ACTOR: &str = "xform-actor";
const XFORM_BISHOP_JOB: u32 = 232;

/// 一名站在目标怪身上的主教四转当事人 + 一个真实 `Store`。
///
/// 必须是 store-backed：`activate_skill_transform` 的唯一写路径
/// （`Store::commit_skill_transform`）只在有 store 时才走，用内存支路测不到它的 CAS。
fn xform_world(skills: &[(u32, u32)]) -> (World, mpsc::Receiver<String>, auth::Store) {
    let path = std::env::temp_dir().join(format!("maple-xform-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).expect("temp store");
    let store = service.store.clone();
    let mut profile = quest_profile();
    profile.level = 190;
    profile.job = XFORM_BISHOP_JOB;
    profile.hp = 50_000;
    profile.max_hp = 50_000;
    profile.mp = 50_000;
    profile.max_mp = 50_000;
    profile.mesos = 10_000_000;
    profile.skills = skills.iter().copied().collect();
    store.load_profile(XFORM_ACTOR, &profile).unwrap();
    store.save_profile(XFORM_ACTOR, &profile).unwrap();
    let mut world = chapter_actual_world(store.clone()).with_mage_skills(MageSkills::bundled());
    let mut rx = chapter_join(&mut world, XFORM_ACTOR);
    chapter_drain(&mut rx);
    // 站到一只真怪身上：准入反转要靠「天使之觸真的施放得出去」来证，不是看闸门源码。
    hyper_target(&mut world, XFORM_ACTOR);
    let player = world.players.get_mut(XFORM_ACTOR).unwrap();
    player.state.action = "stand";
    player.attack_until = 0;
    (world, rx, store)
}

fn xform_drain(rx: &mut mpsc::Receiver<String>) -> Vec<serde_json::Value> {
    chapter_drain(rx)
}

/// 本次施放里出现过的拒绝码（按出现顺序）。
fn xform_codes(events: &[serde_json::Value]) -> Vec<String> {
    events
        .iter()
        .filter(|value| value["type"] == "rejected")
        .map(|value| value["code"].as_str().unwrap_or_default().to_owned())
        .collect()
}

/// 把世界推到 `ticks` 拍之后。跨段的 `request_id` 幂等键必须真的推进 tick，
/// 否则第二次施放会被当成**重放**回放上一次的结果（假绿）。
fn xform_advance(world: &mut World, ticks: u64) {
    let target = world.tick + ticks;
    while world.tick < target {
        world.step();
    }
}

// ── ① 接纳表与源侧配对 ──────────────────────────────────────────────────────

#[test]
fn xform_acceptance_table_covers_the_four_source_pairs() {
    assert_eq!(TRANSFORM_SKILLS, [SKILL_AVENGING_ANGEL]);
    assert_eq!(SKILL_AVENGING_ANGEL, 2321054);
    // 配对与**顺序**都取自源帮助文本那句
    // 「消耗MP #mpCon，群體治癒、淨化、神聖之泉、神聖之水各別轉換成天使之觸、勝利之羽、
    //   天使之泉、神聖之血」。门禁 `check_tms273_damage_pipeline.cjs` 的「技能轉換」段
    // 从导出树独立重算同一张表并双向断言。
    assert_eq!(
        TRANSFORM_PAIRS,
        [
            (2301002, 2301010),
            (2311001, 2311015),
            (2311011, 2311014),
            (2321015, 2321016),
        ],
    );
    for (love, avenge) in TRANSFORM_PAIRS {
        assert_eq!(transform_form(love), Some(TransformForm::Love));
        assert_eq!(transform_form(avenge), Some(TransformForm::Avenge));
    }
    // 施放者本身不属于任何一侧：若它被判成某一侧，准入反转会把自己也拒掉。
    assert_eq!(transform_form(SKILL_AVENGING_ANGEL), None);
    // `2321006 復甦之光` 是**另一条机制**（队伍复活，2026-09-24 接执行链），不是转换
    // 出来的復仇副本 ⇒ 不该落进这张配对表。它自己的接纳表由 `revival_light_acceptance.rs`
    // 与门禁 §3j 钉住。
    assert_eq!(transform_form(2321006), None, "復甦之光不是转换表的成员");
}

// ── ② 施放＝执行转换：按慈愛一侧的等级授予四本復仇副本，并落持久层 ─────────────

#[test]
fn xform_cast_grants_the_avenge_copies_at_the_love_levels() {
    let (mut world, mut rx, store) = xform_world(&[
        (SKILL_AVENGING_ANGEL, 1),
        (2301002, 7),
        (2311011, 3),
    ]);
    let before = world.players[XFORM_ACTOR].state.mp;
    let level = mech_level(&world, SKILL_AVENGING_ANGEL);
    assert_eq!(
        level.mp_con, Some(100),
        "源 common 的 mpCon 必须是转换的价格"
    );

    world.handle_cast_skill(
        XFORM_ACTOR.into(),
        "xform-grant".into(),
        SKILL_AVENGING_ANGEL,
        Some(1),
        Some(0),
    );
    let events = xform_drain(&mut rx);
    assert_eq!(xform_codes(&events), Vec::<String>::new(), "转换被拒了：{events:?}");
    assert!(
        events.iter().any(|value| value["type"] == "skillCast"
            && value["skillId"] == SKILL_AVENGING_ANGEL),
        "没有发出 skillCast：{events:?}"
    );
    assert_eq!(
        world.players[XFORM_ACTOR].state.mp,
        before - 100,
        "转换没有按源 mpCon 收费"
    );
    // 源 `common` 用的是 `cooltimeMS: 500`（全目录只有这一条用这个字段名），而帮助文本写的是
    // 「冷卻時間 #cooltimeMS秒」—— 那个 500 是**秒**。`MageLevel` 投影不出这个字段名，
    // 所以冷却按调用点字面量写；这条断言就是它的落点。
    assert_eq!(
        world
            .players
            .get(XFORM_ACTOR)
            .and_then(|player| player.skill_cooldowns.get(&SKILL_AVENGING_ANGEL).copied()),
        Some(500_000),
        "转换的冷却没有按源 `cooltimeMS` 落地（500 秒）"
    );

    let skills = &world.players[XFORM_ACTOR].state.skills;
    assert_eq!(
        skills.get(&2301010),
        Some(&7),
        "天使之觸 的等级应当＝慈愛侧 群體治癒 的已学等级"
    );
    assert_eq!(
        skills.get(&2311014),
        Some(&3),
        "天使之泉 的等级应当＝慈愛侧 神聖之泉 的已学等级"
    );
    assert!(
        skills.get(&2311015).is_none(),
        "没学 淨化 就不该凭空授予 勝利之羽"
    );
    assert!(
        skills.get(&2321016).is_none(),
        "没学 神聖之水 就不该凭空授予 神聖之血"
    );
    assert!(transform_done(&world.players[XFORM_ACTOR]));

    // 持久层写的是同一份 —— `Store::commit_skill_transform` 是唯一写路径。
    let durable = store.load_profile(XFORM_ACTOR, &quest_profile()).unwrap();
    assert_eq!(durable.skills.get(&2301010), Some(&7));
    assert_eq!(durable.skills.get(&2311014), Some(&3));
}

// ── ③ 准入按形态反转（两条方向都测） ────────────────────────────────────────

#[test]
fn xform_admission_flips_with_the_form() {
    let (mut world, mut rx, _store) = xform_world(&[(SKILL_AVENGING_ANGEL, 1), (2301002, 5)]);

    // 转换**之前**：復仇侧在源里 `invisible: 1`（玩家点不到），未转换的玩家点它必须被
    // `skill_hidden` 拒 —— 这是源里那条 `invisible` 的运行期对应物。
    world.handle_cast_skill(
        XFORM_ACTOR.into(),
        "xform-before".into(),
        2301010,
        Some(1),
        Some(0),
    );
    let before = xform_drain(&mut rx);
    assert_eq!(
        xform_codes(&before),
        vec!["skill_hidden".to_owned()],
        "转换之前 天使之觸 不该可施放：{before:?}"
    );

    // 执行转换。
    world.handle_cast_skill(
        XFORM_ACTOR.into(),
        "xform-transform".into(),
        SKILL_AVENGING_ANGEL,
        Some(1),
        Some(0),
    );
    let transformed = xform_drain(&mut rx);
    assert_eq!(xform_codes(&transformed), Vec::<String>::new(), "{transformed:?}");

    xform_advance(&mut world, 40);

    // 转换**之后**：復仇侧放行（它现在真的在技能表里），并且要真的施放得出去。
    world.handle_cast_skill(
        XFORM_ACTOR.into(),
        "xform-after".into(),
        2301010,
        Some(1),
        Some(0),
    );
    let after = xform_drain(&mut rx);
    assert_eq!(
        xform_codes(&after),
        Vec::<String>::new(),
        "转换之后 天使之觸 仍被拒：{after:?}"
    );
    assert!(
        after.iter().any(|value| value["type"] == "skillCast" && value["skillId"] == 2301010),
        "转换之后 天使之觸 没有真的施放：{after:?}"
    );

    xform_advance(&mut world, 40);

    // 反方向：慈愛侧在转换后不再可施放（源「各別轉換成」）。少了这一条，
    // 「把闸门整个删掉」也能过上一半断言。
    world.handle_cast_skill(
        XFORM_ACTOR.into(),
        "xform-love".into(),
        2301002,
        Some(1),
        Some(0),
    );
    let love = xform_drain(&mut rx);
    assert_eq!(
        xform_codes(&love),
        vec!["skill_transformed".to_owned()],
        "转换之后 群體治癒 仍可施放：{love:?}"
    );
}

// ── ④ `[被動效果]` 三项真的进属性层与伤害管线 ────────────────────────────────

#[test]
fn xform_passive_effects_reach_the_attribute_and_damage_layers() {
    let (mut world, _rx, _store) = xform_world(&[]);
    let account = XFORM_ACTOR;
    let attributes = |world: &World| {
        aggregate_attributes(AttributeInput::of(
            &world.gameplay,
            &world.mage_skills,
            world.players.get(account).expect("joined actor"),
        ))
    };
    let level = mech_level(&world, SKILL_AVENGING_ANGEL);
    let mad_x = level.mad_x.expect("源 common 必须有 madX");
    let md_r = level.md_r.expect("源 common 必须有 mdR");
    let ignore = level.ignore_mob_pdp_r.expect("源 common 必须有 ignoreMobpdpR");

    // 伤害侧：`mdR` 独立乘算 + `ignoreMobpdpR` 进目标侧减免的「无视」那一格。
    // **必须在学会这本之前先取一次基线** —— 否则「未学也有 20% 无视」这种
    // 「其实什么都没测」的形状会被当成通过。
    let target_id = world
        .monsters
        .values()
        .find(|monster| monster.state.hp > 0)
        .map(|monster| monster.state.id.clone())
        .expect("shared gameplay target");
    world.monsters.get_mut(&target_id).unwrap().template.md_rate = Some(30.0);
    let bare = world.magic_damage_breakdown(
        account,
        SKILL_AVENGING_ANGEL,
        &target_id,
        1_000,
        false,
        "xform-bare",
        1,
        &[],
    );
    assert_eq!(
        bare.mitigation.as_ref().map(|step| step.ignored_percent),
        Some(0),
        "还没学这本时不该有无视防御"
    );

    let idle = attributes(&world);
    world
        .players
        .get_mut(account)
        .unwrap()
        .state
        .skills
        .insert(SKILL_AVENGING_ANGEL, 1);
    let learned = attributes(&world);
    assert_eq!(
        learned.magic_attack,
        idle.magic_attack.saturating_add(mad_x),
        "`madX` 没进魔法攻击 —— 源把它标成 `#c[被動效果]#`，按学得即生效读"
    );
    let trace = learned
        .sources
        .iter()
        .find(|source| source.skill_id == Some(SKILL_AVENGING_ANGEL))
        .expect("`madX` 没有留痕：留痕要能回答「这几十点魔攻是谁给的」");
    assert_eq!(trace.field, "madX");
    assert_eq!(trace.layer, AttributeLayer::PassiveSkill);
    assert_eq!(trace.op, AttributeOp::Flat);
    assert_eq!(trace.value, mad_x);

    let armed = world.magic_damage_breakdown(account, SKILL_AVENGING_ANGEL, &target_id, 1_000, false, "xform-armed", 1, &[]);
    assert_eq!(
        armed.mitigation.as_ref().map(|step| step.ignored_percent),
        Some(ignore.clamp(0, 100)),
        "`ignoreMobpdpR` 没有累加进无视防御那一格"
    );
    let seen: Vec<String> = armed
        .factors
        .iter()
        .flat_map(|factor| {
            factor
                .sources
                .iter()
                .map(|(source, percent)| format!("{}={percent}", source.label()))
        })
        .collect();
    assert!(
        armed.factors.iter().any(|factor| factor
            .sources
            .iter()
            .any(|(source, percent)| matches!(
                source,
                DamageSource::UnmarkedField { skill_id, field }
                    if *skill_id == SKILL_AVENGING_ANGEL && *field == "mdR"
            ) && *percent == md_r)),
        "`mdR` 没有作为独立乘算的来源出现：{seen:?}",
    );
}

// ── ⑤ 幂等：转换只发生一次，且**不覆盖**玩家自己加过的等级 ────────────────────

#[test]
fn xform_is_idempotent_and_never_overwrites_later_levels() {
    let (mut world, mut rx, store) = xform_world(&[(SKILL_AVENGING_ANGEL, 1), (2301002, 5)]);
    world.handle_cast_skill(
        XFORM_ACTOR.into(),
        "xform-first".into(),
        SKILL_AVENGING_ANGEL,
        Some(1),
        Some(0),
    );
    xform_drain(&mut rx);
    assert_eq!(world.players[XFORM_ACTOR].state.skills.get(&2301010), Some(&5));

    // 玩家随后用 SP 把转换出来的那一本加到 8（源里它是可加点的）。
    world
        .players
        .get_mut(XFORM_ACTOR)
        .unwrap()
        .state
        .skills
        .insert(2301010, 8);
    let _ = &store;

    // 跨段必须推进 tick：否则第二条 `request_id` 会被当成重放，回放上一次的结果（假绿）。
    xform_advance(&mut world, 60);
    // 冷却＝源 `cooltimeMS` 的 500 秒（上一条测试已钉住）。这里要测的是**幂等**，
    // 不是冷却，所以直接清掉 —— 推 10 000 拍只会让测试变慢，并不会多证明什么。
    world
        .players
        .get_mut(XFORM_ACTOR)
        .unwrap()
        .skill_cooldowns
        .clear();
    world.handle_cast_skill(
        XFORM_ACTOR.into(),
        "xform-second".into(),
        SKILL_AVENGING_ANGEL,
        Some(1),
        Some(0),
    );
    let second = xform_drain(&mut rx);
    assert_eq!(
        xform_codes(&second),
        Vec::<String>::new(),
        "重复施放报错了：{second:?}"
    );
    assert_eq!(
        world.players[XFORM_ACTOR].state.skills.get(&2301010),
        Some(&8),
        "重复施放把玩家自己加过的等级盖回去了 —— 转换只补不覆盖"
    );
}
