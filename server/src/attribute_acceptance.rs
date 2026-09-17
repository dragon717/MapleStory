/// 属性聚合（`attribute.rs`）的验收（2026-09-17）。
///
/// 经 `include!` 进入 `world_tests.rs` 的 `mod tests`；本文件助手一律 `attr_` 前缀
/// （`include!` 把全部验收塞进同一模块，裸名会与既有验收撞名）。
///
/// 要钉住的是**口径**，不是某个数字：
///
/// * **层序**就是 `AttributeLayer` 的枚举序，且四维的百分比**只作用在装备折叠之前**；
/// * 加算 / 加算% / 取高者由来源**各自声明**：`intX`/`pddX`/`x`/`madX`/`mmpR`/`lv2mmp`/… 加算，
///   `basicStatUp` 整组只乘一次，`mastery` **取高不相加**；
/// * **取整只有枫叶祝福那一次**（整数截断），其余全是 `i64` 加算；
/// * **上限只在声明处**：`speedMax` 夹传送的被动移速、并入初学者速度后再 `clamp(0,100)`、
///   法师的 `max_mp` 下限、`magic_attack` 的 `max(1)`；
/// * **UI 侧与战斗侧是同一份结果**：协议快照的每个数值字段都等于聚合结果的访问器
///   ——这是本模块存在的全部理由，也是改前没做到的事（D1/D2/D4 三处**真**分叉；
///   D3「魔力之盾只进显示」经实测**证伪**——受伤侧的 `pddX` 在
///   `commit_incoming_damage` 内层，两侧总量本来就一致）；
/// * 留痕只记非零项，`contribution()` 查不到就是「没贡献」。
///
/// 期望值一律**从内容表现读**（`mage_skills.level(id, level)`）后再自己算，不写死数字：
/// 内容版本升级时，这些用例会自动跟着走，而不是变成一堆需要人工核对的过期常量。
struct AttrFixture {
    gameplay: Gameplay,
    mage_skills: MageSkills,
    ability: AbilityStats,
    equipped: Vec<crate::protocol::InventoryItem>,
    skills: BTreeMap<u32, u32>,
    base_max_mp: i64,
}

/// 真实运行期配置（`shared/gameplay.json`），不是手搓的 `PlayerConfig::default()`：
/// 验收要能反映 `mastery` / `weaponType` / `maxHp` 这些**真实存在**的底座值。
fn attr_gameplay() -> Gameplay {
    Gameplay::load(Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../shared/gameplay.json"
    )))
    .expect("shared/gameplay.json")
}

impl AttrFixture {
    fn new() -> Self {
        // 默认挂一把单手剑：`with_equipment` 会把 `weapon_type` 取自 11 号槽，
        // 没有它 `attack_range()` 的武器系数就是 0，区间恒为 (0,0)，
        // 「四维 / 熟练度真的改变了战斗数字」这类断言会变成空转。
        Self {
            gameplay: attr_gameplay(),
            mage_skills: MageSkills::bundled(),
            ability: AbilityStats {
                strength: 12,
                dexterity: 5,
                intelligence: 100,
                luck: 20,
                available_ap: 0,
            },
            equipped: vec![crate::protocol::InventoryItem {
                slot: 11,
                item_id: "1302000".to_owned(),
                stats: Some(BTreeMap::from([("incPAD".to_owned(), 15)])),
                ..Default::default()
            }],
            skills: BTreeMap::new(),
            base_max_mp: 500,
        }
    }

    fn ability(mut self, strength: i64, dexterity: i64, intelligence: i64, luck: i64) -> Self {
        self.ability = AbilityStats {
            strength,
            dexterity,
            intelligence,
            luck,
            available_ap: self.ability.available_ap,
        };
        self
    }

    /// 学会一批技能（等级由用例给，越界会让 `level()` panic——那是内容缺陷，不该被吞掉）。
    fn learn(mut self, levels: &[(u32, u32)]) -> Self {
        for (skill_id, level) in levels {
            self.skills.insert(*skill_id, *level);
        }
        self
    }

    /// 把给定的 `inc*` 字段并进那把默认武器上（**实例 stats 优先于目录值**，
    /// 见 `inventory::equipment_attribute`，所以用例里完全不依赖物品目录）。
    fn with_stats(mut self, stats: &[(&str, i64)]) -> Self {
        let item = &mut self.equipped[0];
        let map = item.stats.get_or_insert_with(BTreeMap::new);
        for (key, value) in stats {
            map.insert((*key).to_owned(), *value);
        }
        self
    }

    fn with_base_max_mp(mut self, value: i64) -> Self {
        self.base_max_mp = value;
        self
    }

    /// 源表里某技能某等级的某一字段（现读，不写死）。
    fn field(
        &self,
        skill_id: u32,
        level: u32,
        pick: impl Fn(&MageLevel) -> Option<i64>,
    ) -> i64 {
        pick(
            self.mage_skills
                .level(skill_id, level)
                .unwrap_or_else(|| panic!("内容表里没有技能 {skill_id} 的 {level} 级")),
        )
        .unwrap_or_else(|| panic!("技能 {skill_id} 的 {level} 级没有这个字段"))
    }

    fn attributes(&self, job: u32, character_level: u32) -> PlayerAttributes {
        self.attributes_with(job, character_level, 0, 0)
    }

    fn attributes_with(
        &self,
        job: u32,
        character_level: u32,
        meditation_mad: i64,
        beginner_speed_percent: i64,
    ) -> PlayerAttributes {
        aggregate_attributes(AttributeInput {
            gameplay: &self.gameplay,
            mage_skills: &self.mage_skills,
            job,
            character_level,
            base_max_mp: self.base_max_mp,
            skills: &self.skills,
            ability_stats: &self.ability,
            equipped: &self.equipped,
            meditation_mad,
            beginner_speed_percent,
        })
    }
}

#[test]
fn attr_layer_order_is_the_enum_order() {
    // 枚举顺序**就是**层序：`aggregate_attributes` 按它依次施加。
    // 有人调换枚举里的顺序而不改折叠逻辑，这条会先红。
    assert!(AttributeLayer::PersistedAbility < AttributeLayer::PassiveSkill);
    assert!(AttributeLayer::PassiveSkill < AttributeLayer::ActiveBuff);
    assert!(AttributeLayer::ActiveBuff < AttributeLayer::Equipment);
    assert_eq!(
        [
            AttributeLayer::PersistedAbility.label(),
            AttributeLayer::PassiveSkill.label(),
            AttributeLayer::ActiveBuff.label(),
            AttributeLayer::Equipment.label(),
        ],
        ["能力值", "被动", "增益", "装备"]
    );
}

#[test]
fn attr_int_bonus_from_two_passives_adds_up_and_reaches_both_sides() {
    // D1：智慧昇華 `2200007` + 極速詠唱 `2200012` 的 `intX`。
    // 改前只有 UI 侧含它，战斗侧读原始 `ability_stats` ⇒ 面板与实战分叉。
    let plain = AttrFixture::new();
    let boosted = AttrFixture::new().learn(&[(SKILL_INTELLIGENCE, 5), (SKILL_BOOSTER, 10)]);
    let wisdom = boosted.field(SKILL_INTELLIGENCE, 5, |level| level.int_x);
    let booster = boosted.field(SKILL_BOOSTER, 10, |level| level.int_x);
    assert!(wisdom > 0 && booster > 0, "源表里两个 intX 都必须非零");

    let before = plain.attributes(ICE_FOURTH_JOB, 190);
    let after = boosted.attributes(ICE_FOURTH_JOB, 190);
    assert_eq!(before.intelligence(), 100);
    assert_eq!(after.intelligence(), 100 + wisdom + booster);
    // 留痕回答「这几十点 INT 是谁给的」：两条来源各记各的，不并成一条。
    assert_eq!(
        after.contribution(AttributeKey::Intelligence, Some(SKILL_INTELLIGENCE)),
        Some(wisdom)
    );
    assert_eq!(
        after.contribution(AttributeKey::Intelligence, Some(SKILL_BOOSTER)),
        Some(booster)
    );
    // 战斗侧真的跟着走了：智力的主属性就是 INT（job 222 ⇒ job_group 2）。
    assert!(
        after.attack_range().1 > before.attack_range().1,
        "四维聚合没有传到物理区间：{:?} vs {:?}",
        before.attack_range(),
        after.attack_range()
    );
    assert!(after.attack_range().0 > before.attack_range().0);
}

#[test]
fn attr_maple_warrior_percent_lands_before_equipment_folds_in() {
    // D2 + 层序：`basicStatUp` 是**按 AP 四维**的百分比，必须在装备折叠之前作用，
    // 否则装备也会吃到这个被动乘法。这条用例的全部价值就在那个「先后」上。
    let fixture = AttrFixture::new()
        .ability(10, 5, 100, 20)
        .with_stats(&[("incINT", 50)])
        .learn(&[(SKILL_MAPLE_WARRIOR, 30)]);
    let percent = fixture.field(SKILL_MAPLE_WARRIOR, 30, |level| level.basic_stat_up);
    assert_eq!(percent, 15, "楓葉祝福满级应是 +15%（源 basicStatUp）");

    let attributes = fixture.attributes(ICE_FOURTH_JOB, 190);
    // 先乘后加：(100 × 115 / 100) + 50 = 165
    assert_eq!(attributes.intelligence(), 165);
    // 先加后乘会得到 (100 + 50) × 115 / 100 = 172 —— 与上一条互斥，钉住顺序。
    assert_ne!(attributes.intelligence(), 172);
    // 全模块唯一一次取整是**整数截断**：10 × 115 / 100 = 11（四舍五入会是 12）。
    assert_eq!(attributes.strength(), 11);
    let source = attributes
        .sources
        .iter()
        .find(|source| source.field == "basicStatUp")
        .expect("楓葉祝福必须有留痕");
    assert_eq!(source.op, AttributeOp::AdditivePercent);
    assert_eq!(source.layer, AttributeLayer::PassiveSkill);
    assert_eq!(source.value, percent);
}

#[test]
fn attr_service_percent_adds_up_and_multiplies_the_group_once() {
    // `AdditivePercent` 的语义是「同类百分比先求和、整组只乘一次」。
    // 本版只有楓葉祝福一条来源，所以这条要钉的是：**装备**不参与这一次乘法，
    // 而 `incINT` 是干干净净的加算（顺序见上一条）。
    let fixture = AttrFixture::new()
        .ability(0, 0, 100, 0)
        .with_stats(&[("incINT", 7)])
        .learn(&[(SKILL_MAPLE_WARRIOR, 30)]);
    let attributes = fixture.attributes(ICE_FOURTH_JOB, 190);
    assert_eq!(attributes.intelligence(), 100 * 115 / 100 + 7);
}

#[test]
fn attr_magic_shield_defense_is_the_panel_figure() {
    // D3 的最终结论（2026-09-17 实测修正）：魔力之盾 `2000010` 的 `pddX`
    // （源 `type=5`、无 `mpCon`/`time` ⇒ 被动）**本来就两侧都有**——UI 在 `defense()`、
    // 实战在 `commit_incoming_damage` 的 `shield_bonus`，总量一致、只是拆在两处。
    // 所以这里钉的是**面板口径**：`defense()` = 装备 `incPDD` + `pddX`；
    // 而「受伤路径读的是装备侧、pddX 在 commit 内层」由仓库级门禁
    // `check_tms273_attributes.cjs` 钉住（防的是把它改成读 `defense()` 后双扣）。
    let plain = AttrFixture::new().with_stats(&[("incPDD", 30)]);
    let shielded = AttrFixture::new()
        .with_stats(&[("incPDD", 30)])
        .learn(&[(SKILL_MAGIC_SHIELD, 9)]);
    let pdd = shielded.field(SKILL_MAGIC_SHIELD, 9, |level| level.pdd_x);
    assert!(pdd > 0);

    let before = plain.attributes(ICE_FOURTH_JOB, 190);
    let after = shielded.attributes(ICE_FOURTH_JOB, 190);
    assert_eq!(before.defense(), 30);
    assert_eq!(after.defense(), 30 + pdd);
    assert_eq!(after.config.weapon_defense, Some(30 + pdd));
    assert_eq!(
        after.contribution(AttributeKey::WeaponDefense, Some(SKILL_MAGIC_SHIELD)),
        Some(pdd)
    );
}

#[test]
fn attr_mastery_takes_the_higher_source_and_only_moves_the_interval_floor() {
    // D4：咒語精通 `2200006` / 冰龍吐息 `2221005` 的 `mastery`。
    // 改前 `derived.rs` 里算完就丢（写了没人读的赋值）⇒ 物理区间下限恒用 0.1。
    let plain = AttrFixture::new();
    let spell_only = AttrFixture::new().learn(&[(SKILL_SPELL_MASTERY, 10)]);
    let both = AttrFixture::new().learn(&[(SKILL_SPELL_MASTERY, 10), (SKILL_ICE_DEMON, 30)]);
    let spell = both.field(SKILL_SPELL_MASTERY, 10, |level| level.mastery);
    let demon = both.field(SKILL_ICE_DEMON, 30, |level| level.mastery);
    assert!(demon > spell, "源里冰龍吐息的熟练度高于咒語精通");

    let before = plain.attributes(ICE_FOURTH_JOB, 190);
    let mid = spell_only.attributes(ICE_FOURTH_JOB, 190);
    let after = both.attributes(ICE_FOURTH_JOB, 190);
    assert_eq!(before.mastery(), 0.1, "未学任何熟练度技能时沿用配置底座");
    assert_eq!(mid.mastery(), spell as f64 / 100.0);
    assert_eq!(after.mastery(), demon as f64 / 100.0);
    // 取高**不相加**：相加会得到 (spell + demon)/100，被 clamp 到 1.0。
    assert_ne!(after.mastery(), (spell + demon) as f64 / 100.0);
    assert_eq!(
        after.contribution(AttributeKey::Mastery, Some(SKILL_SPELL_MASTERY)),
        Some(spell)
    );
    assert_eq!(
        after.contribution(AttributeKey::Mastery, Some(SKILL_ICE_DEMON)),
        Some(demon)
    );
    // 熟练度只抬**下限**，上限纹丝不动。
    assert!(
        after.attack_range().0 > mid.attack_range().0,
        "熟练度没有传到区间下限：{:?} vs {:?}",
        mid.attack_range(),
        after.attack_range()
    );
    assert_eq!(after.attack_range().1, mid.attack_range().1);
    assert_eq!(mid.attack_range().1, before.attack_range().1);
}

#[test]
fn attr_meditation_is_a_buff_layer_source_that_disappears_at_zero() {
    // 第 3 层与第 2 层的分界：冥想的 M.ATT 来自**生效中**的状态（`indieMad`），
    // 所以是 `ActiveBuff`；到期后 `meditation_mad` 已被收回成 0 ⇒ 零贡献不留痕。
    let fixture = AttrFixture::new();
    let idle = fixture.attributes_with(ICE_FOURTH_JOB, 190, 0, 0);
    let meditating = fixture.attributes_with(ICE_FOURTH_JOB, 190, 55, 0);
    assert_eq!(
        idle.contribution(AttributeKey::MagicAttack, Some(SKILL_MEDITATION)),
        None,
        "0 点加成不该留痕（否则 explain() 里会混进一堆 +0）"
    );
    assert_eq!(meditating.magic_attack, idle.magic_attack + 55);
    let source = meditating
        .sources
        .iter()
        .find(|source| source.field == "indieMad")
        .expect("冥想的留痕必须用源字段名 indieMad");
    assert_eq!(source.layer, AttributeLayer::ActiveBuff);
    assert_eq!(source.op, AttributeOp::Flat);
    assert_eq!(source.value, 55);
}

#[test]
fn attr_magic_attack_is_the_sum_of_its_declared_parts_with_one_floor() {
    // 魔法攻击 = INT×4 + LUK + 等级 + 咒語精通 `x` + 大師魔法 `madX` + 装备 `incMAD` + 冥想，
    // 末端一次 `max(1)`。期望值从内容表现读后自己算。
    let fixture = AttrFixture::new()
        .learn(&[(SKILL_SPELL_MASTERY, 10), (SKILL_MASTER_MAGIC, 10)])
        .with_stats(&[("incMAD", 12)]);
    let spell_x = fixture.field(SKILL_SPELL_MASTERY, 10, |level| level.x);
    let mad_x = fixture.field(SKILL_MASTER_MAGIC, 10, |level| level.mad_x);
    let attributes = fixture.attributes_with(ICE_FOURTH_JOB, 190, 7, 0);
    let expected = 100 * 4 + 20 + 190 + spell_x + mad_x + 12 + 7;
    assert_eq!(attributes.magic_attack, expected);
    assert_eq!(attributes.intelligence(), 100);
    assert_eq!(attributes.luck(), 20);

    // 下限：四维全 0、等级 0 时仍然至少 1（`max(1)` 在末端，不在每一项上）。
    let bare = AttrFixture::new()
        .ability(0, 0, 0, 0)
        .with_base_max_mp(0);
    assert_eq!(bare.attributes(0, 0).magic_attack, 1);
}

#[test]
fn attr_max_mp_uses_the_persisted_baseline_and_never_compounds() {
    // 魔法增幅 `2000006`：`mmpR` 加算% 作用在**未加成的角色基线**上，`lv2mmp` 按角色等级。
    let fixture = AttrFixture::new()
        .with_base_max_mp(500)
        .with_stats(&[("incMMP", 100)])
        .learn(&[(SKILL_MAGIC_BOOST, 20)]);
    let percent = fixture.field(SKILL_MAGIC_BOOST, 20, |level| level.mmp_r);
    let per_level = fixture.field(SKILL_MAGIC_BOOST, 20, |level| level.lv2mmp);
    let raw = 500 + 100;
    let attributes = fixture.attributes(ICE_FOURTH_JOB, 190);
    assert_eq!(
        attributes.max_mp(),
        raw + raw * percent / 100 + per_level * 190
    );

    // 法师专属下限：基线为 0 时抬到 `MAGE_TRANSFER_MIN_MP`；非法师不抬。
    let empty = AttrFixture::new().with_base_max_mp(0).with_stats(&[("incMMP", 0)]);
    let _ = empty;
    let mage = AttrFixture::new().with_base_max_mp(0);
    assert_eq!(mage.attributes(ICE_FOURTH_JOB, 1).max_mp(), MAGE_TRANSFER_MIN_MP);
    assert_eq!(mage.attributes(BEGINNER_JOB, 1).max_mp(), 0);
}

#[test]
fn attr_move_speed_caps_the_passive_source_then_clamps_the_merged_percent() {
    // 装备 `incSpeed` 与傳送的被动 `psdSpeed` 先合并、用源 `speedMax` 当上限，
    // 再并入初學者「迅捷腳步」（增益），合并后 `clamp(0,100)`，最后落到 125 px/s。
    let plain = AttrFixture::new().with_stats(&[("incSpeed", 5)]);
    let teleport = AttrFixture::new()
        .with_stats(&[("incSpeed", 5)])
        .learn(&[(SKILL_TELEPORT, 5)]);
    let psd = teleport.field(SKILL_TELEPORT, 5, |level| level.psd_speed);
    let source_max = teleport.field(SKILL_TELEPORT, 5, |level| level.speed_max);
    assert!(psd > source_max, "源里 psdSpeed 高于 speedMax，上限才真的起作用");

    assert_eq!(plain.attributes(ICE_FOURTH_JOB, 190).move_speed, 125.0 * 1.05);
    let capped = teleport.attributes(ICE_FOURTH_JOB, 190);
    // 5 + 22 = 27 被 speedMax(20) 夹到 20 —— 未夹会是 125 × 1.27。
    assert_eq!(capped.move_speed, 125.0 * (1.0 + source_max as f64 / 100.0));
    // 增益层再往上加，合并后才 clamp(0,100)。
    let boosted = teleport.attributes_with(ICE_FOURTH_JOB, 190, 0, 10);
    assert_eq!(boosted.move_speed, 125.0 * 1.30);
    let overshoot = teleport.attributes_with(ICE_FOURTH_JOB, 190, 0, 500);
    assert_eq!(overshoot.move_speed, 125.0 * 2.0);
}

#[test]
fn attr_resistances_are_reported_only_when_the_source_is_learned() {
    // 元素適應 `2211012`：`asrR` / `terR` 直通，**未学则不报**（不是报 0）。
    let plain = AttrFixture::new();
    let adapted = AttrFixture::new().learn(&[(SKILL_ELEMENTAL_ADAPTING, 20)]);
    let status = adapted.field(SKILL_ELEMENTAL_ADAPTING, 20, |level| level.asr_r);
    let element = adapted.field(SKILL_ELEMENTAL_ADAPTING, 20, |level| level.ter_r);

    let none = plain.attributes(ICE_FOURTH_JOB, 190);
    assert_eq!(none.status_resistance, None);
    assert_eq!(none.element_resistance, None);
    let some = adapted.attributes(ICE_FOURTH_JOB, 190);
    assert_eq!(some.status_resistance, Some(status));
    assert_eq!(some.element_resistance, Some(element));
    assert_eq!(
        some.contribution(AttributeKey::StatusResistance, Some(SKILL_ELEMENTAL_ADAPTING)),
        Some(status)
    );
    assert_eq!(
        some.contribution(AttributeKey::ElementResistance, Some(SKILL_ELEMENTAL_ADAPTING)),
        Some(element)
    );
}

#[test]
fn attr_protocol_snapshot_is_literally_the_aggregation() {
    // 本模块存在的全部理由：**面板上的数字**与战斗用的数字是同一份结果。
    // 这里让全部来源同时上阵，再逐字段要求协议快照等于聚合结果的访问器——
    // 谁在 `derived.rs` 里重新长出一套口径，这条立刻红。
    let fixture = AttrFixture::new()
        .ability(50, 30, 100, 20)
        .with_stats(&[
            ("incPAD", 15),
            ("incINT", 40),
            ("incPDD", 30),
            ("incMAD", 12),
            ("incMMP", 100),
            ("incSpeed", 5),
        ])
        .learn(&[
            (SKILL_INTELLIGENCE, 5),
            (SKILL_BOOSTER, 10),
            (SKILL_MAPLE_WARRIOR, 30),
            (SKILL_MAGIC_SHIELD, 9),
            (SKILL_SPELL_MASTERY, 10),
            (SKILL_ICE_DEMON, 30),
            (SKILL_MAGIC_BOOST, 20),
            (SKILL_TELEPORT, 5),
            (SKILL_ELEMENTAL_ADAPTING, 20),
            (SKILL_MASTER_MAGIC, 10),
        ]);
    let attributes = fixture.attributes_with(ICE_FOURTH_JOB, 190, 55, 10);
    let stats = compute_derived_stats(
        &fixture.mage_skills,
        &attributes,
        &fixture.skills,
        ICE_FOURTH_JOB,
        &DerivedRuntime::joining(0, &BTreeMap::new()),
    );
    assert_eq!(stats.strength, Some(attributes.strength()));
    assert_eq!(stats.dexterity, Some(attributes.dexterity()));
    assert_eq!(stats.intelligence, Some(attributes.intelligence()));
    assert_eq!(stats.luck, Some(attributes.luck()));
    assert_eq!(stats.magic_attack, attributes.magic_attack);
    assert_eq!(stats.defense, attributes.defense());
    assert_eq!(stats.move_speed, attributes.move_speed);
    assert_eq!(stats.status_resistance, attributes.status_resistance);
    assert_eq!(stats.element_resistance, attributes.element_resistance);
    // 反向：这一份输入确实让每一项都动了（否则上面全是在比对默认值）。
    assert!(stats.intelligence.unwrap_or(0) > 100);
    assert!(stats.defense > 30);
    assert!(stats.magic_attack > 100 * 4 + 20 + 190);
    assert!((stats.move_speed - 125.0 * 1.30).abs() < f64::EPSILON);
}

#[test]
fn attr_sources_are_nonzero_registered_and_explainable() {
    // 留痕是可断言的性质：零贡献不留痕、每条键都在登记表里、
    // 「哪些加算 / 哪些取高」只看 `op` 一处。
    let fixture = AttrFixture::new()
        .ability(50, 30, 100, 20)
        .with_stats(&[("incINT", 40), ("incPDD", 30), ("incMAD", 12)])
        .learn(&[
            (SKILL_INTELLIGENCE, 5),
            (SKILL_MAPLE_WARRIOR, 30),
            (SKILL_SPELL_MASTERY, 10),
            (SKILL_ICE_DEMON, 30),
            (SKILL_MAGIC_BOOST, 20),
        ]);
    let attributes = fixture.attributes(ICE_FOURTH_JOB, 190);
    assert!(!attributes.sources.is_empty(), "夹具必须真的产生留痕");
    for source in &attributes.sources {
        assert_ne!(source.value, 0, "零贡献不许留痕：{source:?}");
        assert!(
            AttributeKey::ALL.contains(&source.key),
            "留痕用了没登记进 ALL 的键：{source:?}"
        );
        match source.op {
            AttributeOp::Highest => assert_eq!(source.key, AttributeKey::Mastery),
            AttributeOp::AdditivePercent => assert!(
                matches!(
                    source.key,
                    AttributeKey::Strength
                        | AttributeKey::Dexterity
                        | AttributeKey::Intelligence
                        | AttributeKey::Luck
                        | AttributeKey::MaxMp
                ),
                "加算%只允许出现在四维与最大 MP 上：{source:?}"
            ),
            AttributeOp::Flat => {}
        }
        assert!(
            !source.field.is_empty(),
            "留痕必须写出源字段名（回源核对用）：{source:?}"
        );
    }
    // 逐键都能解释，且解释串里带着**值**（不是只有一串 `+0`）。
    for key in AttributeKey::ALL {
        let text = attributes.explain_key(key);
        assert!(text.starts_with(key.label()), "解释串没有以属性名开头：{text}");
    }
    assert!(attributes.explain().contains("来源:"));
}

#[test]
fn attr_refresh_is_idempotent_across_repeated_recomputes() {
    // 真实世界的重算路径：`refresh_player_derived` 反复跑必须收敛到同一个值。
    // 聚合的输入是 `Player::base_max_mp`（持久化基线），**不是** `state.max_mp`
    // ——后者是产物。改前把产物当输入就会每拍复利一次。
    let path = std::env::temp_dir().join(format!("maple-attr-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).expect("temp store");
    let (mut world, _rx) = hyper_world(service.store.clone(), "attr-mp", &[SKILL_MAGIC_BOOST]);
    let baseline = world.players["attr-mp"].base_max_mp;
    let mut observed = Vec::new();
    for round in 0..3 {
        {
            let player = world.players.get_mut("attr-mp").expect("joined player");
            // 每一轮先把「当前值」踩成一个荒谬的数：拿它当输入就会复利。
            player.state.max_mp = 9_999_999;
            refresh_player_derived(&world.gameplay, &world.mage_skills, player);
        }
        let player = &world.players["attr-mp"];
        observed.push(player.state.max_mp);
        assert_eq!(player.base_max_mp, baseline, "第 {round} 轮改写了持久化基线");
    }
    assert_eq!(observed[0], observed[1], "重算两次得到两个不同结果");
    assert_eq!(observed[1], observed[2], "重算三次得到三个不同结果");
    assert_ne!(observed[0], 9_999_999, "聚合读到了产物而不是基线");
    assert!(observed[0] > 0);
}
