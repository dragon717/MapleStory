/// 火毒／主教四转「同一格副本」接线验收（2026-09-23）。
///
/// 经 `include!` 进入 `world_tests.rs` 的 `mod tests`；本文件助手一律 `mbc_` 前缀
/// （`include!` 把全部验收塞进同一模块，裸名会与既有验收撞名）。
///
/// 要钉住的是**判据**，不是某个数字：
///
/// * **一份判据一张表**：三条分支的四转书在技能窗里共用同一批槽位，副本（212/232）
///   与冰雷那本同机制 ⇒ 收进 `INFINITY_SKILLS` / `MAPLE_CURE_SKILLS` /
///   `SUMMON_SKILLS`（楓葉祝福复用早已存在的 `MAPLE_WARRIOR_SKILLS`；召唤那张表
///   2026-09-23 从 `DEMON_SUMMON_SKILLS` 扩成 `SUMMON_SKILLS`，多了召喚聖龍），
///   施法臂改读表。第一条用例直接钉表的内容，并逐条端到端施放一次——改前这七条
///   回的是「该技能尚未开放施放」。
/// * **副本各记各的账**：增益是按技能 id 记剩余时长的，所以「挂哪一本」与
///   「读哪一本」必须是同一份判据（`active_infinity_skill`）。改前 `activate_infinity`
///   与三处读取点都写死 `2221004`／`2221008` ⇒ 火毒／主教玩家放了技能之后，MP 免费、
///   5 秒跳段、免疫窗的剩余时长全都读不到。
/// * **召唤仍是同一条队列**：火魔与冰魔共存于 `Player::summons`，容量判据只有
///   `summon_slots_available` 一处，脉冲周期仍从源字段派生（`summon_pulse_ms`）。
const MBC_ACTOR: &str = MECH_ACTOR;

fn mbc_world() -> (World, mpsc::Receiver<String>) {
    mech_bundled_world(vec![mech_spawn("mob-copy", 300.0)])
}

fn mbc_drain(rx: &mut mpsc::Receiver<String>) -> Vec<serde_json::Value> {
    let mut values = Vec::new();
    while let Ok(message) = rx.try_recv() {
        values.push(serde_json::from_str::<serde_json::Value>(&message).unwrap());
    }
    values
}

/// 摆好当事人并学会技能；顺带清掉上一次施法留下的动作锁——`attack_until` 是
/// 权威的，不清会让下一条断言以 `skill_busy` 的形式炸掉，看起来像技能没接线。
fn mbc_ready(world: &mut World, job: u32, skills: &[(u32, u32)]) {
    mech_place_actor(world, job, 120, 100.0, 100.0);
    mech_learn(world, skills);
    let player = world.players.get_mut(MBC_ACTOR).unwrap();
    player.attack_until = 0;
    player.state.action = "stand";
}

fn mbc_unlock(world: &mut World) {
    let player = world.players.get_mut(MBC_ACTOR).unwrap();
    player.attack_until = 0;
    player.state.action = "stand";
}

/// 傳說冒險是 **190 级**的 Hyper 主动（源 `reqLev`），而 `mbc_ready` 摆的是 120 级
/// ——直接复用会被 `level_requirement` 挡下，看起来像技能没接线。这里按源等级摆位，
/// 其余（清动作锁）与 `mbc_ready` 同。
fn mbc_ready_hyper(world: &mut World, job: u32, skills: &[(u32, u32)]) {
    mech_place_actor(world, job, 190, 100.0, 100.0);
    mech_learn(world, skills);
    mbc_unlock(world);
}

#[test]
fn mbc_sibling_copies_share_one_table_and_every_one_is_castable() {
    // ① 判据本身：三条分支的同一格副本在**同一张表**里，不是各写一遍 `if`。
    assert_eq!(
        INFINITY_SKILLS,
        [SKILL_INFINITY, SKILL_INFINITY_FP, SKILL_INFINITY_CLERIC]
    );
    assert_eq!(
        MAPLE_CURE_SKILLS,
        [SKILL_MAPLE_CURE, SKILL_MAPLE_CURE_FP, SKILL_MAPLE_CURE_CLERIC]
    );
    assert_eq!(DEMON_SUMMON_SKILLS, [SKILL_ICE_DEMON, SKILL_FIRE_DEMON]);
    // 召唤的**接纳名单**在 2026-09-23 扩成 `SUMMON_SKILLS`（多了召喚聖龍 2321003）：
    // 上面那两本是「同一格副本」这层内容关系，接纳名单是「由召唤实体承担」这层机制关系。
    // 副本那两本必须仍在接纳名单里，否则扩表时会漏掉它们。
    for skill_id in DEMON_SUMMON_SKILLS {
        assert!(
            SUMMON_SKILLS.contains(&skill_id),
            "召唤接纳名单漏掉了同格副本 {skill_id}"
        );
    }
    assert!(
        SUMMON_SKILLS.contains(&SKILL_HOLY_DRAGON),
        "召喚聖龍不在召唤接纳名单里"
    );
    for skill_id in [
        SKILL_MAPLE_WARRIOR,
        SKILL_MAPLE_WARRIOR_FP,
        SKILL_MAPLE_WARRIOR_CLERIC,
    ] {
        assert!(
            MAPLE_WARRIOR_SKILLS.contains(&skill_id),
            "楓葉祝福 {skill_id} 不在数组消费表里"
        );
    }
    // 副本的源形状与冰雷那本同形：三本都**没有** `time`（楓葉祝福的 `basicStatUp`
    // 是「学得即生效」，不是「施放才生效」的增益窗）。
    let catalog = MageSkills::bundled();
    for skill_id in [
        SKILL_MAPLE_WARRIOR,
        SKILL_MAPLE_WARRIOR_FP,
        SKILL_MAPLE_WARRIOR_CLERIC,
    ] {
        let level = catalog.level(skill_id, 1).expect("楓葉祝福 level 1");
        assert!(
            level.time.is_none(),
            "楓葉祝福 {skill_id} 的源里不该有 time"
        );
        assert!(
            level.basic_stat_up.is_some(),
            "楓葉祝福 {skill_id} 的 basicStatUp 必须在"
        );
    }

    // ② 端到端：每一条副本都真的能施放（改前它们回「该技能尚未开放施放」）。
    for (job, skill_id) in [
        (212, SKILL_MAPLE_WARRIOR_FP),
        (232, SKILL_MAPLE_WARRIOR_CLERIC),
        (212, SKILL_INFINITY_FP),
        (232, SKILL_INFINITY_CLERIC),
        (212, SKILL_MAPLE_CURE_FP),
        (232, SKILL_MAPLE_CURE_CLERIC),
        (212, SKILL_FIRE_DEMON),
    ] {
        let (mut world, mut rx) = mbc_world();
        mbc_ready(&mut world, job, &[(skill_id, 1)]);
        world.handle_cast_skill(
            MBC_ACTOR.into(),
            format!("copy-{skill_id}"),
            skill_id,
            Some(1),
            Some(0),
        );
        let events = mbc_drain(&mut rx);
        assert!(
            !events
                .iter()
                .any(|value| value["type"] == "rejected" && value["code"] == "skill_unimplemented"),
            "{skill_id} 仍被判「该技能尚未开放施放」：{events:?}"
        );
        assert!(
            events
                .iter()
                .any(|value| value["type"] == "skillCast" && value["skillId"] == skill_id),
            "{skill_id} 没有发出 skillCast：{events:?}"
        );
    }
}

#[test]
fn mbc_fire_demon_reuses_the_generic_slot_and_the_derived_pulse() {
    let (mut world, _rx) = mbc_world();
    mbc_ready(
        &mut world,
        212,
        &[(SKILL_ICE_DEMON, 1), (SKILL_FIRE_DEMON, 1)],
    );
    let ice = mech_level(&world, SKILL_ICE_DEMON);
    let fire = mech_level(&world, SKILL_FIRE_DEMON);

    world
        .cast_summon(MBC_ACTOR, "ice-1", SKILL_ICE_DEMON, &ice)
        .unwrap();
    world
        .cast_summon(MBC_ACTOR, "fire-1", SKILL_FIRE_DEMON, &fire)
        .unwrap();

    let ids = world.players[MBC_ACTOR]
        .summons
        .iter()
        .map(|summon| summon.skill_id)
        .collect::<Vec<_>>();
    assert_eq!(
        ids,
        vec![SKILL_ICE_DEMON, SKILL_FIRE_DEMON],
        "火魔必须与冰魔共存于同一条队列"
    );

    // 脉冲周期仍只有一个派生点，且火魔取契约兜底值（源里既没有毫秒书写的
    // `attackDelay`，`subTime` 也不足一拍）。
    assert_eq!(
        summon_pulse_ms(&world.mage_skills, SKILL_FIRE_DEMON, 1),
        summon_pulse_ms(&world.mage_skills, SKILL_ICE_DEMON, 1)
    );
    assert_eq!(
        summon_pulse_ms(&world.mage_skills, SKILL_FIRE_DEMON, 1),
        SUMMON_PULSE_FALLBACK_MS
    );

    // 存活时长来自源 `time`（秒），不是照抄冰魔那一本的字面量。
    let expected_ticks = (fire.time.unwrap() as u64)
        .saturating_mul(1_000)
        .div_ceil(TICK_MS)
        .max(1);
    let fire_summon = world.players[MBC_ACTOR]
        .summons
        .iter()
        .find(|summon| summon.skill_id == SKILL_FIRE_DEMON)
        .unwrap();
    assert_eq!(fire_summon.expires_at, world.tick + expected_ticks);

    // 同技能重放即替换：只有火魔被换掉，冰魔仍在队列里。
    world
        .cast_summon(MBC_ACTOR, "fire-2", SKILL_FIRE_DEMON, &fire)
        .unwrap();
    let after = world.players[MBC_ACTOR]
        .summons
        .iter()
        .map(|summon| summon.skill_id)
        .collect::<Vec<_>>();
    assert_eq!(after, vec![SKILL_ICE_DEMON, SKILL_FIRE_DEMON]);
}

#[test]
fn mbc_infinity_copy_grants_free_mp_and_its_own_five_second_tick() {
    let (mut world, _rx) = mbc_world();
    mbc_ready(&mut world, 212, &[(SKILL_INFINITY_FP, 1)]);
    let level = mech_level(&world, SKILL_INFINITY_FP);
    world
        .activate_infinity(MBC_ACTOR, SKILL_INFINITY_FP, &level)
        .unwrap();

    // 「哪一本在计时」是唯一判据：副本在册，冰雷那本读不到。
    assert_eq!(
        active_infinity_skill(&world.players[MBC_ACTOR]),
        Some(SKILL_INFINITY_FP)
    );
    assert!(
        world.players[MBC_ACTOR]
            .status
            .buff_remaining_ms(SKILL_INFINITY)
            .is_none(),
        "窗口挂在施放的那一本上，不该在冰雷那本里出现"
    );

    // MP 免费：改前这条判据写死 `skill_id != SKILL_INFINITY`，副本施放者照扣。
    mbc_unlock(&mut world);
    let hellfire = mech_level(&world, SKILL_HELLFIRE);
    assert_eq!(
        world.skill_mp_cost(MBC_ACTOR, SKILL_HELLFIRE, &hellfire, 0),
        0,
        "無限生效期间其它技能应免 MP"
    );

    // 5 秒跳段：按源 `y`% 恢复 HP/MP，并把伤害加成推到源 `w` 上限。
    // `step_infinity_tick` 对 `hp <= 0` 直接返回（倒地的角色不跳段），所以这里把
    // HP 压到 1 而不是 0 —— 那是它的判据，不是本轮的缺口。
    {
        let player = world.players.get_mut(MBC_ACTOR).unwrap();
        player.base_max_mp = 1_000;
        player.state.hp = 1;
        player.state.mp = 0;
        refresh_player_derived(&world.gameplay, &world.mage_skills, player);
        let player = world.players.get_mut(MBC_ACTOR).unwrap();
        player.state.hp = 1;
        player.state.mp = 0;
        player.infinity_next_tick = world.tick;
    }
    world.step_infinity_tick(MBC_ACTOR);
    let percent = level.y.unwrap_or(0).clamp(0, 100);
    let (max_hp, max_mp, hp, mp, bonus) = {
        let player = &world.players[MBC_ACTOR];
        (
            player.state.max_hp,
            player.state.max_mp,
            player.state.hp,
            player.state.mp,
            player.infinity_damage_bonus,
        )
    };
    assert_eq!(hp, (1 + max_hp * percent / 100).min(max_hp), "HP 按源 y% 恢复");
    assert_eq!(mp, (max_mp * percent / 100).min(max_mp), "MP 按源 y% 恢复");
    assert!(mp > 0, "5 秒跳段应恢复 MP");
    assert!(bonus > 0, "伤害加成应随跳段推进");

    // 属性快照要认这本副本：改前 `derived.rs` 只查 `2221004`，
    // 火毒／主教玩家的 `infinityEnhanced` 永远是 false。
    {
        let player = world.players.get_mut(MBC_ACTOR).unwrap();
        player
            .status
            .apply_buff(SKILL_INFINITY_FP, 1_000, world.tick, Release::Infinity);
        refresh_player_derived(&world.gameplay, &world.mage_skills, player);
    }
    let buffs = world.players[MBC_ACTOR]
        .state
        .derived_stats
        .skill_buffs
        .clone()
        .unwrap_or_default();
    assert!(
        buffs.contains_key(&SKILL_INFINITY_FP),
        "副本的增益必须进属性快照：{buffs:?}"
    );
    assert!(
        !buffs.contains_key(&SKILL_INFINITY),
        "冰雷那一本没被施放，不该出现在快照里：{buffs:?}"
    );
}

#[test]
fn mbc_cleanse_copy_clears_disease_and_owns_its_own_immunity_window() {
    let (mut world, _rx) = mbc_world();
    world.tick = 10;
    mbc_ready(&mut world, 212, &[(SKILL_MAPLE_CURE_FP, 1)]);
    assert!(world.inflict_disease(MBC_ACTOR, Disease::Seal, 5_000, "mob-copy"));
    assert!(world.inflict_disease(MBC_ACTOR, Disease::Curse, 60_000, "mob-copy"));

    let level = mech_level(&world, SKILL_MAPLE_CURE_FP);
    world.activate_status_cleanse(MBC_ACTOR, SKILL_MAPLE_CURE_FP, &level);

    let player = &world.players[MBC_ACTOR];
    for disease in [Disease::Seal, Disease::Curse] {
        assert!(
            !player.status.disease_active(disease),
            "{disease:?} 应已被副本净化解除"
        );
    }
    assert!(player.status.is_immune());
    // 窗口挂在**施放的那一本**上（改前写死 2221008）。
    assert_eq!(
        player.status.buff_remaining_ms(SKILL_MAPLE_CURE_FP),
        Some(3_000)
    );
    assert!(player
        .status
        .buff_remaining_ms(SKILL_MAPLE_CURE)
        .is_none());
}

/// 傳說冒險（Hyper 主动，`indieDamR` 窗口）的三本副本：表、可施放、窗口归属、取值口径。
///
/// 这一条是本轮最后接的一批（2026-09-23）：三本的源 `common` 逐字段同形
/// （`mpCon/time/cooltime/indieDamR/lt/rb`，`maxLevel = 1`），美术组也逐组同帧，
/// 所以复用同一条机制——**只是原先三处都写死了冰雷那本的书号**。
///
/// 改前状态：副本落在 `handle_cast_skill` 的 `_ => {}`（回「该技能尚未开放施放」），
/// 而且 `NOT_CONSUMED.indieDamR` 里逐条登记着它们（登记表的反向断言要求
/// 「world.rs 里没有常量」——接上执行链的那一刻就会红，逼着把消费一起补上）。
#[test]
fn mbc_adventurer_copies_share_one_table_and_each_opens_its_own_window() {
    // ① 判据本身：三本在同一张表里，成员逐本登记（分支互斥，但每本都要能独立留痕）。
    assert_eq!(
        HYPER_ADVENTURER_SKILLS,
        [
            SKILL_HYPER_ADVENTURER,
            SKILL_HYPER_ADVENTURER_FP,
            SKILL_HYPER_ADVENTURER_CLERIC
        ]
    );

    // ② 源形状同形：三本都有 `indieDamR`（独立乘算的来源）、`time`（窗口时长）、
    //    `cooltime`，且源 `maxLevel` 都是 1 —— 「同一格」的判据在源数据上。
    let catalog = MageSkills::bundled();
    for skill_id in HYPER_ADVENTURER_SKILLS {
        let skill = catalog
            .get(skill_id)
            .unwrap_or_else(|| panic!("{skill_id} 不在技能表里"));
        assert_eq!(skill.max_level, 1, "{skill_id} 的源 maxLevel 应当是 1");
        let level = catalog
            .level(skill_id, 1)
            .unwrap_or_else(|| panic!("{skill_id} 没有 level 1"));
        assert!(level.indie_dam_r.is_some(), "{skill_id} 源里必须有 indieDamR");
        assert!(level.time.is_some(), "{skill_id} 源里必须有 time");
        assert!(level.cooltime.is_some(), "{skill_id} 源里必须有 cooltime");
    }

    // ③ 端到端：三条分支各放自己那一本（改前 212/232 回「该技能尚未开放施放」）。
    for (job, skill_id) in [
        (222, SKILL_HYPER_ADVENTURER),
        (212, SKILL_HYPER_ADVENTURER_FP),
        (232, SKILL_HYPER_ADVENTURER_CLERIC),
    ] {
        let (mut world, mut rx) = mbc_world();
        mbc_ready_hyper(&mut world, job, &[(skill_id, 1)]);
        world.handle_cast_skill(
            MBC_ACTOR.into(),
            format!("adventurer-{skill_id}"),
            skill_id,
            Some(1),
            Some(0),
        );
        let events = mbc_drain(&mut rx);
        assert!(
            !events
                .iter()
                .any(|value| value["type"] == "rejected" && value["code"] == "skill_unimplemented"),
            "{skill_id} 仍被判「该技能尚未开放施放」：{events:?}"
        );
        assert!(
            events
                .iter()
                .any(|value| value["type"] == "skillCast" && value["skillId"] == skill_id),
            "{skill_id} 没有发出 skillCast：{events:?}"
        );

        // ④ 「挂哪一本」＝「读哪一本」：窗口挂在**施放的那一本**上，另两本读不到。
        //    这正是 `active_adventurer_skill` 存在的理由（改前三处都写死 2221053）。
        let player = &world.players[MBC_ACTOR];
        assert_eq!(
            active_adventurer_skill(player),
            Some(skill_id),
            "{skill_id} 施放后，访问器没有认出在计时的是它"
        );
        for other in HYPER_ADVENTURER_SKILLS {
            assert_eq!(
                player.status.buff_active(other),
                other == skill_id,
                "{skill_id} 施放后，{other} 的在册状态不对"
            );
        }

        // ⑤ 取值口径读的是**施放的那一本**的源等级（level 1 的 `indieDamR` 是 10），
        //    不是冰雷那本——改前这里读 `SKILL_HYPER_ADVENTURER` 的等级。
        assert_eq!(
            hyper_adventurer_damage_percent(&world.mage_skills, player, skill_id),
            10,
            "{skill_id} 的 level 1 indieDamR 取值口径不对"
        );
    }
}

/// 傳說冒險副本的**伤害留痕必须指认真正在计时的那一本**。
///
/// 改前两条伤害路径都写死 `SKILL_HYPER_ADVENTURER`（2221053）：火毒／主教玩家放了
/// 副本之后，窗口挂在自己的书号上、加成却读冰雷那本 ⇒ 副本只有视觉、没有数值；
/// 而且留痕里记的是**别人书的 id**，排错时把人指向错误的方向。
#[test]
fn mbc_adventurer_window_names_the_book_that_is_ticking_in_the_trace() {
    let (mut world, _rx) = mbc_world();
    mbc_ready(
        &mut world,
        212,
        &[(SKILL_HYPER_ADVENTURER_FP, 1), (SKILL_HELLFIRE, 1)],
    );
    let target = mech_monster(&world, "mob-copy");
    let level = mech_level(&world, SKILL_HYPER_ADVENTURER_FP);
    world.activate_hyper_adventurer(MBC_ACTOR, SKILL_HYPER_ADVENTURER_FP, &level);

    let own = DamageSource::IndependentDamageRate {
        skill_id: SKILL_HYPER_ADVENTURER_FP,
    };
    let ice = DamageSource::IndependentDamageRate {
        skill_id: SKILL_HYPER_ADVENTURER,
    };
    let breakdown = world.magic_damage_breakdown(
        MBC_ACTOR,
        SKILL_HELLFIRE,
        &target,
        1_000,
        false,
        "adventurer-trace",
        1,
        &[],
    );
    assert_eq!(
        breakdown.percent_of(own),
        Some(10),
        "副本的窗口必须以**副本自己的书号**进留痕：{}",
        breakdown.explain()
    );
    assert!(
        breakdown.percent_of(ice).is_none(),
        "冰雷那一本没被施放，不该出现在留痕里：{}",
        breakdown.explain()
    );

    // 窗口关掉之后留痕里不再有它：判据读的是**增益在不在册**，不是技能表里有没有这本。
    world
        .players
        .get_mut(MBC_ACTOR)
        .unwrap()
        .status
        .remove_buff(SKILL_HYPER_ADVENTURER_FP);
    let after = world.magic_damage_breakdown(
        MBC_ACTOR,
        SKILL_HELLFIRE,
        &target,
        1_000,
        false,
        "adventurer-trace-2",
        1,
        &[],
    );
    assert!(
        after.percent_of(own).is_none(),
        "窗口已关，留痕里不该还有独立乘算来源：{}",
        after.explain()
    );
}
