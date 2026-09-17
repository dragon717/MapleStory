/// 伤害修正管线（`damage.rs`）的验收（2026-09-17）。
///
/// 经 `include!` 进入 `world_tests.rs` 的 `mod tests`；本文件助手一律 `dmg_` 前缀
/// （`include!` 把全部验收塞进同一模块，裸名会与既有验收撞名）。
///
/// 要钉住的是**口径**，不是某个数字：
///
/// * 分组由来源唯一决定：源 `damR` 加算、源 `indieDamR` 独立乘算、源 `criticaldamage`
///   把基准换成 200；同一份源数据不可能在两条伤害路径上被算成两种口径；
/// * 加算组**只乘一次**（组内各来源仍各报各的百分比）；
/// * **取整只在末端一次**：`total` 必须等于「从留痕里的每一个因子独立重算」的结果，
///   而不是任何逐步 floor 的链；
/// * **上限在声明处**：无视防御的总和只在管线读它的时候夹到 0..100；
/// * 恒等项（区域系数 100%）不留痕，但**暴击组的 0% 是有效修正**（×2）。
///
/// 顺带把「口径统一」带来的**唯一一处有意偏离**钉在这里：两个 `damR` 来源从「各自乘一次」
/// 改为「求和后乘一次」，见 `dmg_damage_rate_sources_add_up_and_reach_the_pinned_total`。
/// 这不是副产品，而是本模块要回答的那个问题；钉死它，静默改回就会失败。

/// 把技能学到指定等级。管线只读 `state.skills` 与技能表，不需要走加点流程。
fn dmg_learn(world: &mut World, account: &str, levels: &[(u32, u32)]) {
    let player = world.players.get_mut(account).expect("joined player");
    for (skill_id, level) in levels {
        player.state.skills.insert(*skill_id, *level);
    }
}

/// 从留痕**独立重算**一次命中：目标侧减免之后的基准 × 每个因子，**只在末端取整一次**。
///
/// 这是「取整在哪一层」的可执行定义：只要有人把取整塞回每一层，这个等式就会破。
fn dmg_recompute(breakdown: &DamageBreakdown) -> i64 {
    let mut num: i128 =
        i128::from(breakdown.mitigation.as_ref().map_or(breakdown.base, |m| m.after));
    let mut den: i128 = 1;
    for factor in &breakdown.factors {
        num = num.saturating_mul(i128::from(factor.group.base_percent() + factor.percent));
        den = den.saturating_mul(100);
    }
    (num / den).max(1) as i64
}

/// 一个来源是否出现在某一步里（`sources` 带的是各来源自己的百分比）。
fn dmg_has_source(factor: &FactorStep, source: DamageSource) -> bool {
    factor.sources.iter().any(|(candidate, _)| *candidate == source)
}

/// 真实内容 + 一个已站在目标怪身上的四转法师夹具。
///
/// **必须把接收端一起交出来**：`chapter_join` 把玩家的 `output` 接到这个通道上，
/// 接收端一旦被丢掉，下一次发送就失败，而发送失败在服务端等于断线
/// （玩家会从 `world.players` 里消失，断言会以「玩家不在场」的形式炸掉，
/// 看起来像内容缺陷）。调用方用 `_rx` 绑定把它保活到测试结束。
fn dmg_world(account: &str, skills: &[u32]) -> (World, mpsc::Receiver<String>, String) {
    let path = std::env::temp_dir().join(format!("maple-damage-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).expect("temp store");
    let (mut world, rx) = hyper_world(service.store.clone(), account, skills);
    let target_id = hyper_target(&mut world, account);
    (world, rx, target_id)
}

#[test]
fn dmg_magic_damage_recomputes_exactly_from_the_recorded_factors() {
    let (mut world, _rx, target_id) = dmg_world("dmg-recompute", &[SKILL_CHAIN_LIGHTNING]);
    dmg_learn(
        &mut world,
        "dmg-recompute",
        &[
            (SKILL_ELEMENT_AMP, 10),
            (SKILL_CHAIN_LIGHTNING, 1),
            (SKILL_MYSTIC_STRIKE, 30),
            (SKILL_MAGIC_CRITICAL, 10),
        ],
    );
    world
        .players
        .get_mut("dmg-recompute")
        .unwrap()
        .mystic_strike_stacks = 5;
    // 一个会真的参与减免的魔法防御，外加一个非整的基准 ⇒ 逐步取整必然与末端一次不同。
    world.monsters.get_mut(&target_id).unwrap().template.md_rate = Some(23.0);
    let breakdown = world.magic_damage_breakdown(
        "dmg-recompute",
        SKILL_CHAIN_LIGHTNING,
        &target_id,
        9_973,
        true,
        "dmg-recompute",
        1,
        &[],
    );
    assert_eq!(
        breakdown.total(),
        dmg_recompute(&breakdown),
        "取整只在末端一次：{}",
        breakdown.explain()
    );
    assert!(breakdown.mitigation.is_some(), "mdRate 必须产生目标减免留痕");
    assert_eq!(
        breakdown
            .factors
            .iter()
            .map(|factor| factor.group)
            .collect::<Vec<_>>(),
        vec![
            ModifierGroup::AdditivePercent,
            ModifierGroup::Critical,
            ModifierGroup::IndependentPercent
        ],
        "加算 → 暴击 → 独立，三类都要留痕：{}",
        breakdown.explain()
    );
}

#[test]
fn dmg_damage_rate_sources_add_up_and_reach_the_pinned_total() {
    let (mut world, _rx, target_id) = dmg_world("dmg-additive", &[SKILL_CHAIN_LIGHTNING]);
    dmg_learn(
        &mut world,
        "dmg-additive",
        &[
            (SKILL_ELEMENT_AMP, 10),
            (SKILL_CHAIN_LIGHTNING, 1),
            (SKILL_HYPER_CHAIN_DAMAGE, 1),
        ],
    );
    world.monsters.get_mut(&target_id).unwrap().template.md_rate = None;
    let breakdown = world.magic_damage_breakdown(
        "dmg-additive",
        SKILL_CHAIN_LIGHTNING,
        &target_id,
        1_000,
        false,
        "dmg-additive",
        1,
        &[],
    );
    // 魔力激發 lv10 = damR 50，閃電連擊-強化傷害 2220046 lv1 = damR 20。
    assert_eq!(
        breakdown.percent_of(DamageSource::DamageRate {
            skill_id: SKILL_ELEMENT_AMP
        }),
        Some(50)
    );
    assert_eq!(
        breakdown.percent_of(DamageSource::DamageRate {
            skill_id: SKILL_HYPER_CHAIN_DAMAGE
        }),
        Some(20)
    );
    let additive: Vec<_> = breakdown
        .factors
        .iter()
        .filter(|factor| factor.group == ModifierGroup::AdditivePercent)
        .collect();
    assert_eq!(additive.len(), 1, "加算组只乘一次：{}", breakdown.explain());
    assert_eq!(additive[0].percent, 70, "组内合计");
    assert_eq!(additive[0].sources.len(), 2, "两个来源各报各的");
    // **口径钉子（有意偏离）**：改前 2220046(20) 与 魔力激發(50) 各自乘一次，
    // base=1000 时 `floor(floor(1000*1.2)*1.5) = 1800`；
    // 现在两个 `damR` 求和后乘一次 ⇒ `floor(1000*1.7) = 1700`。
    assert_eq!(breakdown.total(), 1_700, "{}", breakdown.explain());
}

#[test]
fn dmg_independent_damage_rate_stays_its_own_factor_and_matches_the_shared_accessor() {
    let (mut world, _rx, target_id) = dmg_world("dmg-independent", &[SKILL_HYPER_ADVENTURER]);
    dmg_learn(
        &mut world,
        "dmg-independent",
        &[(SKILL_ELEMENT_AMP, 10), (SKILL_CHAIN_LIGHTNING, 1)],
    );
    world.monsters.get_mut(&target_id).unwrap().template.md_rate = None;
    world.handle_cast_skill(
        "dmg-independent".into(),
        "adventurer".into(),
        SKILL_HYPER_ADVENTURER,
        Some(1),
        Some(0),
    );
    assert!(
        world
            .players
            .get("dmg-independent")
            .unwrap_or_else(|| panic!(
                "玩家不在场：{:?}",
                world.players.keys().collect::<Vec<_>>()
            ))
            .status
            .buff_active(SKILL_HYPER_ADVENTURER),
        "傳說冒險 必须先真的挂上"
    );
    let breakdown = world.magic_damage_breakdown(
        "dmg-independent",
        SKILL_CHAIN_LIGHTNING,
        &target_id,
        1_000,
        false,
        "dmg-independent",
        1,
        &[],
    );
    let source = DamageSource::IndependentDamageRate {
        skill_id: SKILL_HYPER_ADVENTURER,
    };
    let percent = breakdown
        .percent_of(source)
        .expect("獨立傷害率的來源必须留痕");
    assert_eq!(percent, 10, "{}", breakdown.explain());
    // **同口径的唯一出处**：两条伤害路径都取这个访问器，验收里也只认它。
    // 普通攻击路径（`attacks.rs`）用的是同一个调用，由门禁
    // `scripts/check_tms273_damage_pipeline.cjs` 静态钉住。
    assert_eq!(
        percent,
        hyper_adventurer_damage_percent(&world.mage_skills, &world.players["dmg-independent"])
    );
    assert_eq!(source.group(), ModifierGroup::IndependentPercent);
    // 它必须是**自己一条**：与加算组不混（改前 1053 被并进 damR 那一步里）。
    let own: Vec<_> = breakdown
        .factors
        .iter()
        .filter(|factor| dmg_has_source(factor, source))
        .collect();
    assert_eq!(own.len(), 1);
    assert_eq!(own[0].sources.len(), 1);
    assert_eq!(own[0].group, ModifierGroup::IndependentPercent);
    // `floor(1000 * 1.5 * 1.1)`：单一 `damR` 来源时改前改后同值（乘积一样，且 1650 整）。
    assert_eq!(breakdown.total(), 1_650, "{}", breakdown.explain());
}

#[test]
fn dmg_ignore_defense_comes_from_the_source_fields_and_shapes_the_mitigation_step() {
    let (mut world, _rx, target_id) = dmg_world("dmg-ignore", &[SKILL_CHAIN_LIGHTNING]);
    dmg_learn(
        &mut world,
        "dmg-ignore",
        &[(SKILL_CHAIN_LIGHTNING, 1), (SKILL_MYSTIC_STRIKE, 30)],
    );
    let ignore = world
        .mage_skills
        .level(SKILL_MYSTIC_STRIKE, 30)
        .and_then(|level| level.ignore_mob_pdp_r)
        .expect("源里神秘狙擊带 ignoreMobpdpR");
    world.monsters.get_mut(&target_id).unwrap().template.md_rate = Some(80.0);
    let breakdown = world.magic_damage_breakdown(
        "dmg-ignore",
        SKILL_CHAIN_LIGHTNING,
        &target_id,
        1_000,
        false,
        "dmg-ignore",
        1,
        &[],
    );
    let mitigation = breakdown.mitigation.as_ref().expect("mdRate 留痕");
    assert_eq!(mitigation.rate_percent, 80.0);
    assert_eq!(
        mitigation.ignored_percent, ignore,
        "无视防御只来自源的 ignoreMobpdpR（层数上限在源里）"
    );
    assert!((mitigation.effective_percent - 80.0 * (100.0 - ignore as f64) / 100.0).abs() < 1e-9);
    // 该步的公式与改前逐字相同：`floor(基准 * (100 - 有效减免) / 100)`。
    assert_eq!(
        mitigation.after,
        (1_000.0 * (100.0 - mitigation.effective_percent) / 100.0).floor() as i64
    );
}

#[test]
fn dmg_zero_critical_damage_still_doubles() {
    let (mut world, _rx, target_id) = dmg_world("dmg-critical", &[SKILL_COLD_BEAM]);
    dmg_learn(&mut world, "dmg-critical", &[(SKILL_COLD_BEAM, 1)]);
    world.monsters.get_mut(&target_id).unwrap().template.md_rate = None;
    let breakdown = world.magic_damage_breakdown(
        "dmg-critical",
        SKILL_COLD_BEAM,
        &target_id,
        1_000,
        true,
        "dmg-critical",
        1,
        &[],
    );
    // 没学 魔法爆擊 ⇒ `criticaldamage = 0`，但暴击组的基准是 200 ⇒ ×2，不是恒等。
    assert_eq!(
        breakdown.percent_of(DamageSource::CriticalDamage {
            skill_id: SKILL_MAGIC_CRITICAL
        }),
        Some(0)
    );
    assert_eq!(breakdown.total(), 2_000, "{}", breakdown.explain());
}

#[test]
fn dmg_an_identity_region_coefficient_leaves_no_trace() {
    let (mut world, _rx, target_id) = dmg_world("dmg-region", &[SKILL_COLD_BEAM]);
    dmg_learn(&mut world, "dmg-region", &[(SKILL_COLD_BEAM, 1)]);
    world.monsters.get_mut(&target_id).unwrap().template.md_rate = None;
    let map_id = world.monsters[&target_id].map_id.clone();
    assert_eq!(
        world.boss_damage_multiplier(&map_id, true),
        100,
        "非 Boss 练习场地系数是恒等"
    );
    let breakdown = world.magic_damage_breakdown(
        "dmg-region",
        SKILL_COLD_BEAM,
        &target_id,
        900,
        false,
        "dmg-region",
        1,
        &[],
    );
    assert!(
        !breakdown
            .factors
            .iter()
            .any(|factor| dmg_has_source(factor, DamageSource::RegionGuard)),
        "恒等项不留痕：{}",
        breakdown.explain()
    );
    assert_eq!(breakdown.total(), 900);
}

#[test]
fn dmg_magic_damage_returns_the_base_when_the_target_is_gone() {
    let (mut world, _rx, _target_id) = dmg_world("dmg-vanished", &[SKILL_COLD_BEAM]);
    dmg_learn(&mut world, "dmg-vanished", &[(SKILL_ELEMENT_AMP, 10)]);
    // 目标不在（重放 / 换图竞态）：不做任何修正，如实返回基准，绝不凭空加成。
    let breakdown = world.magic_damage_breakdown(
        "dmg-vanished",
        SKILL_COLD_BEAM,
        "no-such-monster",
        777,
        true,
        "dmg-vanished",
        1,
        &[],
    );
    assert!(breakdown.factors.is_empty(), "{}", breakdown.explain());
    assert_eq!(breakdown.total(), 777);
}
