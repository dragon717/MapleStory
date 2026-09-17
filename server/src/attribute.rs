//! 玩家属性聚合权威模块：**唯一**的属性聚合入口与**唯一**的口径。
//!
//! ## 为什么要有这个模块
//!
//! 改前「玩家最终属性是多少」有两个入口，各自算一套，结果**不一致**：
//!
//! - **UI 侧**（`derived.rs::compute_derived_stats` → 协议字段 `derivedStats`，
//!   客户端角色面板读它显示 STR/DEX/INT/LUK 与魔法攻击）在折叠装备**之前**先改了基础属性：
//!   加上被动 `intX`、乘上楓葉祝福的 `basicStatUp`；防御还额外加了魔力之盾的 `pddX`。
//! - **战斗侧**（`attacks.rs` 普通攻击基准、`monsters.rs` / `boss.rs` 的受伤减免）
//!   直接 `with_ability_stats(&player.state.ability_stats, …)` —— **原始**能力值，
//!   于是上面三项**一项都不含**。
//!
//! 实测到的分叉（源数据可查，见交付记录）——注意 **D3 后来被证伪**了：
//!
//! | # | 项 | UI | 战斗（改前） | 结论 |
//! | --- | --- | --- | --- | --- |
//! | D1 | 智慧昇華 `2200007` + 極速詠唱 `2200012` 的 `intX`（合计最多 **+60 INT**） | 含 | 不含 | **真分叉**，已统一（四维进聚合） |
//! | D2 | 楓葉祝福 `2221000` 的 `basicStatUp`（最多 ~15% 四维） | 含 | 不含 | **真分叉**，已统一（同上） |
//! | D3 | 魔力之盾 `2000010` 的 `pddX`（最多 **+90**） | 进 `defense()` | 进（在 `commit_incoming_damage` 内层的 `shield_bonus`） | **误诊**：两侧拆在两处、总量一致。本模块的 `defense()` 保持面板口径（含 pddX），**受伤路径不许读它**（会双扣），见下 |
//! | D4 | 咒語精通 `2200006` / 冰龍吐息 `2221005` 的 `mastery` | 算出即丢（原 `derived.rs` 里是**写了没人读**的赋值） | 物理区间下限恒用 `0.1` | **真分叉**，已统一（mastery 进聚合） |
//!
//! ### 受伤路径的边界（读这条再碰 `defense()`）
//!
//! `monsters.rs::apply_contact_damage` / `boss.rs::apply_boss_player_damage` 的外层减伤
//! 读的是**装备侧** `weapon_defense`（`incPDD`，经 `with_ability_stats`），魔力之盾的
//! `pddX` 由 `monsters.rs::commit_incoming_damage` 的 `shield_bonus` **在内部再减一次**。
//! 两处相加才等于本模块的 `defense()`——所以战斗受伤侧**禁止**改成读 `defense()`，
//! 否则同一击扣两次 `pddX`（2026-09-17 实测：`mage_skill_runtime…` 用例当场抓出）。
//!
//! ## 层序（顺序即口径）
//!
//! 1. **持久化能力值**（`ability_stats`，AP 分配）
//! 2. **被动技能**（取值只由「已学等级」决定，**不依赖增益是否在手** ⇒ 学得即生效）
//! 3. **施放类增益**（必须 `*_active` / 附属字段非零才算生效）
//! 4. **装备实例**（`inc*` 字段加算）
//!
//! 第 2 层与第 3 层的分界**不是**「源里有没有 `mpCon`」——`2221000`（楓葉祝福）就有 `mpCon`。
//! 分界只有一条：**这个属性的取值会不会随「增益是否在手」变化**。
//! `intX` / `basicStatUp` / `pddX` / `madX` / `x` / `mmpR` / `lv2mmp` / `psdSpeed` /
//! `asrR` / `terR` 都是「按已学等级查表」得到的定值 ⇒ 第 2 层；冥想的 `indieMad` 与初學者
//! 「迅捷腳步」的 `speed` 是从**生效中的状态**读出来的 ⇒ 第 3 层。
//!
//! 源侧唯一一种需要人做决定的形状是「`common` 里带 `time` 的技能也提供了第 2 层字段」。
//! 本版只有 `2221005`（冰龍吐息）的 `mastery`——那是**技能自身的武器熟练度**（随等级固定、
//! 不随窗口变化），因此仍在第 2 层。这张名单是 [`INTRINSIC_DURATION_SKILLS`]，
//! 门禁对着源表独立重算：源里多一个 / 少一个都失败，逼人来重新分类。
//!
//! 四维的顺序是 `1 → 2 → 4`：楓葉祝福是按 **AP 四维**的百分比，必须在装备折叠**之前**作用，
//! 否则装备会吃到这个被动乘法（改前的注释已声明这条，本模块逐字保留）。
//!
//! ## 口径（本模块的全部内容）
//!
//! - **加算 / 独立乘算 / 取高者**三选一，由 [`AttributeOp`] 表达，**每个来源各自声明**：
//!   - [`AttributeOp::Flat`]：平坦加算（四维、装备的每一项、魔法攻击的各分量、防御的各分量）。
//!   - [`AttributeOp::AdditivePercent`]：同类百分比**先求和、整组只乘一次**。
//!     目前只有楓葉祝福的 `basicStatUp` 一条（`value = 求和后的百分点`）。
//!   - [`AttributeOp::Highest`]：**取较高者替换、不相加**。目前只有 `mastery`
//!     （咒語精通 / 冰龍吐息；改前的注释写明「冰龍吐息替换较低的咒語精通，不叠加成两条带」）。
//! - **取整只在一步**：`basic_stat_up` 那一次整数截断（`v * (100+p) / 100`）。
//!   其余全是 `i64` 加算，**没有第二处 `/100`**；`move_speed` 是 `f64`、不取整。
//! - **上限只在声明处**：`basic_stat_up` 的 `clamp(0,100)`、`mastery` 的 `clamp(0.0,1.0)`、
//!   移动速度的两个 `clamp`（装备+被动那一段用**源字段 `speedMax`** 当上限，合并初學者速度后再
//!   `clamp(0,100)`）、`int_x` / `pdd_x` / `mad_x` / `x` 各自的 `max(0)`。
//!   额外的下限只有两条：`magic_attack` 的 `max(1)`、`max_hp` 的 `max(1)`、
//!   以及法师专属的 `max_mp` 下限 `MAGE_TRANSFER_MIN_MP`。
//!
//! ## 有意偏离（改前 UI 与战斗不一致，统一后**必有一侧变化**）
//!
//! 本模块选择**以 UI 侧口径为准**（它是完整的那一侧，且与源数据一致），把它推广到战斗侧：
//!
//! - **普通攻击（`attacks.rs`）**：四维改为聚合值（D1/D2 生效）⇒ 攻击区间**上升**；
//!   `mastery` 改为聚合值（D4 生效）⇒ 区间**下限上升**。
//! - **受伤减免（`monsters.rs` / `boss.rs`）不在偏离范围内、一行未动**：外层仍是装备侧
//!   `weapon_defense`、`pddX` 留在 `commit_incoming_damage`（见上面「受伤路径的边界」）。
//! - **UI（`derivedStats`）的取值逐字不变**（本模块就是照它写的）——
//!   这是可断言的性质，由 `attribute_acceptance.rs` 钉住。
//!
//! ## 不负责
//!
//! 伤害的百分比修正（`damage.rs` 的管线）、HP/MP 的自然恢复节奏、命中与目标选择、
//! 以及**玩家受伤的抵偿通道**（护盾 / 魔心防禦，`monsters.rs::commit_incoming_damage`）。
//! 本模块只回答「玩家当前的属性是多少」。
//!
//! ## 可解释输出
//!
//! [`PlayerAttributes::explain`] / [`explain_key`] 逐来源列出「这一项是谁贡献了多少」。
//! 留痕（[`PlayerAttributes::sources`]）在**生产构建里不保留**——属性聚合是
//! **每拍 × 每玩家**调用，按环境变量打印会淹掉日志（伤害管线可以打印是因为它只在命中时跑）。
//! 因此这里改成：留痕与解释入口带 `#[cfg_attr(not(test), allow(dead_code))]`，
//! 由验收与仓库级门禁 `scripts/check_tms273_attributes.cjs` 消费。协议零改动。

use super::*;

// `combat_rules` 模块内的 `use` 名不会被 `world` 的 glob 二次透传，这里显式引入
// 唯一的装备折叠实现（留痕与真正折叠必须共用同一个纯函数，见模块头）。
use super::combat_rules::equipment_field_sum;

/// 聚合层。**枚举顺序即层序**，`aggregate_attributes` 按它依次施加。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum AttributeLayer {
    /// 持久化的能力值（`abilityStats`，AP 分配的结果）。
    PersistedAbility,
    /// 被动技能：取值只由「已学等级」决定，**不依赖增益是否在手** ⇒ 学得即生效。
    PassiveSkill,
    /// 施放类增益：必须生效中才算（附属字段在失效时已被收回成 0）。
    ActiveBuff,
    /// 装备实例。
    Equipment,
}

impl AttributeLayer {
    #[cfg_attr(not(test), allow(dead_code))] // 验收与 explain() 用
    pub(super) fn label(self) -> &'static str {
        match self {
            AttributeLayer::PersistedAbility => "能力值",
            AttributeLayer::PassiveSkill => "被动",
            AttributeLayer::ActiveBuff => "增益",
            AttributeLayer::Equipment => "装备",
        }
    }
}

/// 一条来源对一个属性的作用方式。**这就是本模块存在的理由**：哪些加算、哪些取高者。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum AttributeOp {
    /// 平坦加算。
    Flat,
    /// 同类百分比**先求和、整组只乘一次**。
    AdditivePercent,
    /// **取较高者替换**，不相加（`mastery`）。
    Highest,
}

impl AttributeOp {
    pub(super) fn label(self) -> &'static str {
        match self {
            AttributeOp::Flat => "加算",
            AttributeOp::AdditivePercent => "加算%",
            AttributeOp::Highest => "取高",
        }
    }
}

/// 被聚合的属性。**只类型化当前技能/装备真正使用的那些**。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum AttributeKey {
    Strength,
    Dexterity,
    Intelligence,
    Luck,
    MagicAttack,
    WeaponAttack,
    WeaponDefense,
    Mastery,
    MaxHp,
    MaxMp,
    MoveSpeed,
    StatusResistance,
    ElementResistance,
}

impl AttributeKey {
    pub(super) fn label(self) -> &'static str {
        match self {
            AttributeKey::Strength => "STR",
            AttributeKey::Dexterity => "DEX",
            AttributeKey::Intelligence => "INT",
            AttributeKey::Luck => "LUK",
            AttributeKey::MagicAttack => "魔法攻击",
            AttributeKey::WeaponAttack => "物理攻击",
            AttributeKey::WeaponDefense => "防御",
            AttributeKey::Mastery => "熟练度",
            AttributeKey::MaxHp => "最大HP",
            AttributeKey::MaxMp => "最大MP",
            AttributeKey::MoveSpeed => "移动速度",
            AttributeKey::StatusResistance => "状态抗性",
            AttributeKey::ElementResistance => "元素抗性",
        }
    }

    /// 供门禁与验收遍历的**全部**键（新增键而不登记会让门禁失败）。
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) const ALL: [AttributeKey; 13] = [
        AttributeKey::Strength,
        AttributeKey::Dexterity,
        AttributeKey::Intelligence,
        AttributeKey::Luck,
        AttributeKey::MagicAttack,
        AttributeKey::WeaponAttack,
        AttributeKey::WeaponDefense,
        AttributeKey::Mastery,
        AttributeKey::MaxHp,
        AttributeKey::MaxMp,
        AttributeKey::MoveSpeed,
        AttributeKey::StatusResistance,
        AttributeKey::ElementResistance,
    ];
}

/// 一条属性来源的留痕。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct AttributeSource {
    pub(super) layer: AttributeLayer,
    /// 被动 / 增益来源的技能 id；装备与能力值没有。
    pub(super) skill_id: Option<u32>,
    /// 源里的字段名（回源核对用；不是技能字段时写来源名，如 `abilityStats` / `incMAD`）。
    pub(super) field: &'static str,
    pub(super) key: AttributeKey,
    pub(super) op: AttributeOp,
    /// 该来源**自己**的贡献量（它怎么参与合并由 `op` 说明；`Highest` 下两个来源
    /// 各记各的那一档，被采纳的是较大的那个）。
    pub(super) value: i64,
}

/// 聚合结果：**内含已折叠的 `PlayerConfig`**，所以战斗公式可以直接用它，
/// 不必也不允许再由调用点自己拼一份配置。
pub(super) struct PlayerAttributes {
    /// 已按层序折叠：四维（含被动/百分比/装备）、`weapon_watk`、`weapon_defense`、
    /// `mastery`、`max_hp`、`max_mp`、`weapon_type`、`job` 都在里面。
    pub(super) config: PlayerConfig,
    pub(super) magic_attack: i64,
    pub(super) move_speed: f64,
    pub(super) status_resistance: Option<i64>,
    pub(super) element_resistance: Option<i64>,
    pub(super) sources: Vec<AttributeSource>,
}

impl PlayerAttributes {
    pub(super) fn strength(&self) -> i64 {
        self.config.base_str.unwrap_or(0).max(0)
    }

    pub(super) fn dexterity(&self) -> i64 {
        self.config.base_dex.unwrap_or(0).max(0)
    }

    pub(super) fn intelligence(&self) -> i64 {
        self.config.base_int.unwrap_or(0).max(0)
    }

    pub(super) fn luck(&self) -> i64 {
        self.config.base_luk.unwrap_or(0).max(0)
    }

    /// **面板口径**的防御：装备 `incPDD` + 魔力之盾 `pddX`。供 UI 快照与验收比对。
    ///
    /// ⚠️ **受伤路径不许读它**：`monsters.rs::apply_contact_damage` /
    /// `boss.rs::apply_boss_player_damage` 的外层减伤读**装备侧** `weapon_defense`，
    /// `pddX` 由 `commit_incoming_damage` 的 `shield_bonus` 在内部再减一次——
    /// 这里读 `defense()` 等于把 `pddX` 扣两次。见模块头「受伤路径的边界」。
    pub(super) fn defense(&self) -> i64 {
        self.config.weapon_defense.unwrap_or(0).max(0)
    }

    pub(super) fn mastery(&self) -> f64 {
        self.config.mastery.unwrap_or(0.1).clamp(0.0, 1.0)
    }

    pub(super) fn max_hp(&self) -> i64 {
        self.config.max_hp.unwrap_or(1).max(1)
    }

    pub(super) fn max_mp(&self) -> i64 {
        self.config.max_mp.unwrap_or(0).max(0)
    }

    /// 普通攻击的区间（已含四维聚合与熟练度）。转发折叠后的配置。
    /// 战斗路径走的是 `attack_damage_against`（内含目标侧修正），这个入口只给验收比对用。
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn attack_range(&self) -> (i64, i64) {
        self.config.attack_range()
    }

    /// 普通攻击对某个怪物的伤害（区间 + 等级差 + PDD 的既有 P 适配保留在 `combat_rules.rs`）。
    pub(super) fn attack_damage_against(
        &self,
        player_level: u32,
        monster: &MonsterTemplate,
    ) -> i64 {
        self.config.attack_damage_against(player_level, monster)
    }

    /// 某个属性上，某个来源自己的贡献量。留痕只记非零项，故找不到即「没贡献」。
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn contribution(
        &self,
        key: AttributeKey,
        skill_id: Option<u32>,
    ) -> Option<i64> {
        self.sources
            .iter()
            .find(|source| source.key == key && source.skill_id == skill_id)
            .map(|source| source.value)
    }

    /// 逐来源列出**某一个属性**的构成。开发态的诊断入口（见模块头「可解释输出」）。
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn explain_key(&self, key: AttributeKey) -> String {
        let mut parts: Vec<String> = self
            .sources
            .iter()
            .filter(|source| source.key == key)
            .map(|source| {
                let who = match source.skill_id {
                    Some(skill_id) => format!("{}:{skill_id}", source.field),
                    None => source.field.to_owned(),
                };
                format!("{}({}){:+}", who, source.op.label(), source.value)
            })
            .collect();
        if parts.is_empty() {
            parts.push("无来源".to_owned());
        }
        format!("{} = {}\n  {}", key.label(), parts.join(" + "), self.value_of(key))
    }

    /// 一行汇总：四维 / 魔法攻击 / 防御 / 熟练度 / 移速 / 最大 HP·MP + 各层来源条数。
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn explain(&self) -> String {
        let count = |layer: AttributeLayer| {
            self.sources.iter().filter(|source| source.layer == layer).count()
        };
        format!(
            "STR/DEX/INT/LUK={}/{}/{}/{}; 魔法攻击={}; 防御={}; 熟练度={:.2}; 移速={:.2}; HP/MP={}/{} | 来源: 能力值 {} + 被动 {} + 增益 {} + 装备 {}",
            self.strength(),
            self.dexterity(),
            self.intelligence(),
            self.luck(),
            self.magic_attack,
            self.defense(),
            self.mastery(),
            self.move_speed,
            self.max_hp(),
            self.max_mp(),
            count(AttributeLayer::PersistedAbility),
            count(AttributeLayer::PassiveSkill),
            count(AttributeLayer::ActiveBuff),
            count(AttributeLayer::Equipment),
        )
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn value_of(&self, key: AttributeKey) -> i64 {
        match key {
            AttributeKey::Strength => self.strength(),
            AttributeKey::Dexterity => self.dexterity(),
            AttributeKey::Intelligence => self.intelligence(),
            AttributeKey::Luck => self.luck(),
            AttributeKey::MagicAttack => self.magic_attack,
            AttributeKey::WeaponAttack => self.config.weapon_watk.unwrap_or(0).max(0),
            AttributeKey::WeaponDefense => self.defense(),
            AttributeKey::Mastery => (self.mastery() * 100.0).round() as i64,
            AttributeKey::MaxHp => self.max_hp(),
            AttributeKey::MaxMp => self.max_mp(),
            AttributeKey::MoveSpeed => self.move_speed.round() as i64,
            AttributeKey::StatusResistance => self.status_resistance.unwrap_or(0),
            AttributeKey::ElementResistance => self.element_resistance.unwrap_or(0),
        }
    }
}

/// 留痕收集器。`note_nonzero` 让「零贡献不留痕」成为一条可断言的性质——
/// 否则 `explain()` 里会混进一堆 `+0`，并且「恒等项不留痕」无法测试。
#[derive(Default)]
struct Recorder {
    sources: Vec<AttributeSource>,
}

impl Recorder {
    fn note(
        &mut self,
        layer: AttributeLayer,
        skill_id: Option<u32>,
        field: &'static str,
        key: AttributeKey,
        op: AttributeOp,
        value: i64,
    ) {
        self.sources.push(AttributeSource {
            layer,
            skill_id,
            field,
            key,
            op,
            value,
        });
    }

    fn note_nonzero(
        &mut self,
        layer: AttributeLayer,
        skill_id: Option<u32>,
        field: &'static str,
        key: AttributeKey,
        op: AttributeOp,
        value: i64,
    ) {
        if value != 0 {
            self.note(layer, skill_id, field, key, op, value);
        }
    }
}

/// 聚合的输入。**为什么不直接收 `&Player`**：加入路径（`commands.rs` 的 join）
/// 在构造出 `Player` **之前**就要算出快照，它手里只有 profile 的几个字段。
/// 收成结构之后两条路径用同一个入口，位置参数写错顺序这类错误也从签名上消失了
/// （改前 `compute_derived_stats` 有 16 个位置参数）。
pub(super) struct AttributeInput<'a> {
    pub(super) gameplay: &'a Gameplay,
    pub(super) mage_skills: &'a MageSkills,
    pub(super) job: u32,
    pub(super) character_level: u32,
    /// 持久化的「未加成」MP 基线（`Player::base_max_mp`）。
    pub(super) base_max_mp: i64,
    pub(super) skills: &'a BTreeMap<u32, u32>,
    pub(super) ability_stats: &'a AbilityStats,
    pub(super) equipped: &'a [crate::protocol::InventoryItem],
    /// 冥想生效中的 M.ATT 加成。**失效时已被收回成 0**（到期 / 死亡 / 换图 / 重连），
    /// 所以「非零即生效」本身就是那条门。
    pub(super) meditation_mad: i64,
    /// 迅捷腳步生效中的移速百分比。同上，失效时已被收回成 0。
    pub(super) beginner_speed_percent: i64,
}

impl<'a> AttributeInput<'a> {
    /// 世界的 tick / 重算路径：玩家已经在世界里有实体，所有来源都能直接读。
    pub(super) fn of(
        gameplay: &'a Gameplay,
        mage_skills: &'a MageSkills,
        player: &'a Player,
    ) -> Self {
        Self {
            gameplay,
            mage_skills,
            job: player.state.job,
            character_level: player.state.level,
            base_max_mp: player.base_max_mp,
            skills: &player.state.skills,
            ability_stats: &player.state.ability_stats,
            equipped: &player.state.equipped,
            meditation_mad: player.meditation_mad,
            beginner_speed_percent: player.beginner_speed_percent,
        }
    }

    /// 加入路径（`commands.rs` 的 join）：此刻还没有 `Player`，只有存档里的 `profile`
    /// 与刚解析出的 `equipped`。所有**施放类增益都还不可能生效**，所以两个「生效中」
    /// 输入恒为 0（这不是「补默认值凑数」，而是这条路线上唯一的真值）。
    pub(super) fn joining(
        gameplay: &'a Gameplay,
        mage_skills: &'a MageSkills,
        profile: &'a Profile,
        equipped: &'a [crate::protocol::InventoryItem],
    ) -> Self {
        Self {
            gameplay,
            mage_skills,
            job: profile.job,
            character_level: profile.level,
            base_max_mp: profile.max_mp,
            skills: &profile.skills,
            ability_stats: &profile.ability_stats,
            equipped,
            meditation_mad: 0,
            beginner_speed_percent: 0,
        }
    }
}

/// 取某个技能「已学等级对应的那一行」。**学得即生效**的那一层用它，所以它不看增益是否在手。
fn learned_level(
    mage_skills: &MageSkills,
    skills: &BTreeMap<u32, u32>,
    skill_id: u32,
) -> Option<MageLevel> {
    skills
        .get(&skill_id)
        .copied()
        .and_then(|level| mage_skills.level(skill_id, level))
        .cloned()
}

/// 源里该技能的 `common` 节点**是否带时长**。
///
/// 这是**门禁的辅助判据**，不是分层规则本身（分层规则见模块头「层序」）：带时长的技能
/// **可能**把某个字段做成「施放才生效」，所以凡是从这类技能身上读了第 2 层字段的，
/// 都必须有人显式登记进 [`INTRINSIC_DURATION_SKILLS`]。本函数由门禁对着
/// `参考/273/…/WZ_JSON_TW/Skill/*.json` 独立重算比对。
#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn source_has_duration(common: &serde_json::Value) -> bool {
    common.get("time").is_some()
}

/// 「源 `common` 带时长、但字段取值仍只由已学等级决定」的技能（技能**固有值**）。
///
/// 本版只有 冰龍吐息 `2221005`：它的 `mastery` 是这把技能自己的武器熟练度，随等级固定、
/// 不随施放窗口变化，所以留在 [`AttributeLayer::PassiveSkill`]。门禁对着源表独立重算
/// 这张名单——源里新增一个「带时长却提供第 2 层字段」的技能而没人登记，门禁就会红。
#[cfg_attr(not(test), allow(dead_code))]
pub(super) const INTRINSIC_DURATION_SKILLS: [u32; 1] = [SKILL_ICE_DEMON];

/// 属性聚合的**唯一入口**。
pub(super) fn aggregate_attributes(input: AttributeInput<'_>) -> PlayerAttributes {
    let AttributeInput {
        gameplay,
        mage_skills,
        job,
        character_level,
        base_max_mp,
        skills,
        ability_stats: ability,
        equipped,
        meditation_mad,
        beginner_speed_percent,
    } = input;
    let mut rec = Recorder::default();

    // ---- 第 1 层：持久化能力值 ----
    let mut vals = [
        ability.strength,
        ability.dexterity,
        ability.intelligence,
        ability.luck,
    ];
    const KEYS: [AttributeKey; 4] = [
        AttributeKey::Strength,
        AttributeKey::Dexterity,
        AttributeKey::Intelligence,
        AttributeKey::Luck,
    ];
    for (index, key) in KEYS.into_iter().enumerate() {
        rec.note(
            AttributeLayer::PersistedAbility,
            None,
            "abilityStats",
            key,
            AttributeOp::Flat,
            vals[index],
        );
    }

    // ---- 第 2 层：被动技能 ----
    // 智慧昇華 / 極速詠唱：源 `intX`，两者都无 `mpCon`/`time` ⇒ 被动。**各记各的**再求和，
    // 于是留痕能回答「这 60 点 INT 是谁给的」。
    let mut int_bonus = 0i64;
    for skill_id in [SKILL_INTELLIGENCE, SKILL_BOOSTER] {
        let contribution = learned_level(mage_skills, skills, skill_id)
            .and_then(|level| level.int_x)
            .unwrap_or(0);
        rec.note_nonzero(
            AttributeLayer::PassiveSkill,
            Some(skill_id),
            "intX",
            AttributeKey::Intelligence,
            AttributeOp::Flat,
            contribution,
        );
        int_bonus = int_bonus.saturating_add(contribution);
    }
    vals[2] = vals[2].saturating_add(int_bonus);

    // 楓葉祝福：源 `basicStatUp` 是**按 AP 四维**的百分比，必须在装备折叠之前作用，
    // 否则装备也会吃到这个被动乘法。**这一条只对四维生效，与其他加算分开**。
    //
    // 归类说明（如实登记）：源 `Skill/222.img/skill/2221000` 的 `common` 只有
    // `mpCon` / `maxLevel` / `basicStatUp`，**没有 `time`** ⇒ 本版源里它无法构成一个
    // 有效增益窗（`apply_buff` 收到 0 时长会立即失效）。改前的代码选择「学得即生效」并
    // 写进了注释；本模块**沿用该既有决策**（而不是发明一条时长），并且**两个方向都照此执行**——
    // 改前只有 UI 侧照此执行。门禁里钉着「源里仍无 `time`」这条事实：源一旦补上时长，
    // 门禁失败，要求把它改归 `ActiveBuff` 层。
    let basic_stat_up = learned_level(mage_skills, skills, SKILL_MAPLE_WARRIOR)
        .and_then(|level| level.basic_stat_up)
        .unwrap_or(0)
        .clamp(0, 100);
    if basic_stat_up > 0 {
        for value in &mut vals {
            // **全模块唯一一次取整**：整数截断。作用在装备折叠之前。
            *value = value.saturating_mul(100 + basic_stat_up) / 100;
        }
        for key in KEYS {
            rec.note(
                AttributeLayer::PassiveSkill,
                Some(SKILL_MAPLE_WARRIOR),
                "basicStatUp",
                key,
                AttributeOp::AdditivePercent,
                basic_stat_up,
            );
        }
    }

    // ---- 第 4 层：装备实例（一次折叠；四维 + incPAD/incPDD/incMAD/incMHP/incMMP/incSpeed）----
    // `PlayerConfig::with_equipment` 把 `maxMp` 当作**未加成的角色基线**，
    // 所以先把持久化基线写进去，避免魔法增幅与装备互相复利。
    let mut config = gameplay.player.clone();
    config.max_mp = Some(base_max_mp.max(0));
    let merged_ability = AbilityStats {
        strength: vals[0],
        dexterity: vals[1],
        intelligence: vals[2],
        luck: vals[3],
        available_ap: ability.available_ap,
    };
    let mut config = config.with_ability_stats(&merged_ability, equipped, job);
    for (field, key) in [
        ("incSTR", AttributeKey::Strength),
        ("incDEX", AttributeKey::Dexterity),
        ("incINT", AttributeKey::Intelligence),
        ("incLUK", AttributeKey::Luck),
    ] {
        rec.note_nonzero(
            AttributeLayer::Equipment,
            None,
            field,
            key,
            AttributeOp::Flat,
            equipment_field_sum(equipped, field),
        );
    }
    rec.note_nonzero(
        AttributeLayer::Equipment,
        None,
        "incPAD",
        AttributeKey::WeaponAttack,
        AttributeOp::Flat,
        equipment_field_sum(equipped, "incPAD"),
    );
    rec.note_nonzero(
        AttributeLayer::Equipment,
        None,
        "incPDD",
        AttributeKey::WeaponDefense,
        AttributeOp::Flat,
        equipment_field_sum(equipped, "incPDD"),
    );
    rec.note_nonzero(
        AttributeLayer::Equipment,
        None,
        "incMHP",
        AttributeKey::MaxHp,
        AttributeOp::Flat,
        equipment_field_sum(equipped, "incMHP"),
    );
    rec.note_nonzero(
        AttributeLayer::Equipment,
        None,
        "incMMP",
        AttributeKey::MaxMp,
        AttributeOp::Flat,
        equipment_field_sum(equipped, "incMMP"),
    );
    let equipment_mad = equipment_field_sum(equipped, "incMAD");
    rec.note_nonzero(
        AttributeLayer::Equipment,
        None,
        "incMAD",
        AttributeKey::MagicAttack,
        AttributeOp::Flat,
        equipment_mad,
    );

    // ---- 被动层：魔法攻击的分量 ----
    // 咒語精通 `x`（Passive）与 大師魔法 `madX`（Passive）；冥想是**增益**，单列一层。
    let spell_mastery = learned_level(mage_skills, skills, SKILL_SPELL_MASTERY);
    let spell_x = spell_mastery
        .as_ref()
        .and_then(|level| level.x)
        .unwrap_or(0)
        .max(0);
    rec.note_nonzero(
        AttributeLayer::PassiveSkill,
        Some(SKILL_SPELL_MASTERY),
        "x",
        AttributeKey::MagicAttack,
        AttributeOp::Flat,
        spell_x,
    );
    let master_magic_mad = learned_level(mage_skills, skills, SKILL_MASTER_MAGIC)
        .and_then(|level| level.mad_x)
        .unwrap_or(0)
        .max(0);
    rec.note_nonzero(
        AttributeLayer::PassiveSkill,
        Some(SKILL_MASTER_MAGIC),
        "madX",
        AttributeKey::MagicAttack,
        AttributeOp::Flat,
        master_magic_mad,
    );
    // 冥想：`meditation_mad` 在到期 / 死亡 / 换图 / 重连时已被收回成 0，
    // 所以「非零即生效中」本身就是那条门（不需要再查一次 buff_active）。
    // 留痕字段写**源字段名** `indieMad`（不是本仓库的内部名 `meditation_mad`）。
    let meditation_mad = meditation_mad.max(0);
    rec.note_nonzero(
        AttributeLayer::ActiveBuff,
        Some(SKILL_MEDITATION),
        "indieMad",
        AttributeKey::MagicAttack,
        AttributeOp::Flat,
        meditation_mad,
    );

    // ---- 魔法攻击：四维派生 + 各分量，末端一次 `max(1)` ----
    let int = config.base_int.unwrap_or(0).max(0);
    let luk = config.base_luk.unwrap_or(0).max(0);
    let magic_attack = int
        .saturating_mul(4)
        .saturating_add(luk)
        .saturating_add(i64::from(character_level.max(1)))
        .saturating_add(spell_x)
        .saturating_add(meditation_mad)
        .saturating_add(master_magic_mad)
        .saturating_add(equipment_mad)
        .max(1);

    // ---- 防御：装备 `incPDD` + 魔力之盾 `pddX`（被动，**改前只进了显示**）----
    let shield_bonus = learned_level(mage_skills, skills, SKILL_MAGIC_SHIELD)
        .and_then(|level| level.pdd_x)
        .unwrap_or(0)
        .max(0);
    rec.note_nonzero(
        AttributeLayer::PassiveSkill,
        Some(SKILL_MAGIC_SHIELD),
        "pddX",
        AttributeKey::WeaponDefense,
        AttributeOp::Flat,
        shield_bonus,
    );
    let defense = config
        .weapon_defense
        .unwrap_or(0)
        .max(0)
        .saturating_add(shield_bonus);
    config.weapon_defense = Some(defense);

    // ---- 熟练度：取高者（咒語精通 / 冰龍吐息），底座是配置里的值（默认 0.1）----
    // 改前这段算完就丢（`derived.rs` 里一次写了没人读的赋值）⇒ 物理区间下限恒用 0.1。
    let base_mastery = config.mastery.unwrap_or(0.1).clamp(0.0, 1.0);
    let spell_mastery_percent = spell_mastery
        .as_ref()
        .and_then(|level| level.mastery)
        .map(|value| value.clamp(0, 100))
        .unwrap_or((base_mastery * 100.0).round() as i64);
    let demon_mastery_percent = learned_level(mage_skills, skills, SKILL_ICE_DEMON)
        .and_then(|level| level.mastery)
        .map(|value| value.clamp(0, 100))
        .unwrap_or(0);
    // 冰龍吐息的源熟练度是「永久覆盖值」：它**替换**较低的咒語精通，不叠加成第二条带。
    let mastery_percent = spell_mastery_percent.max(demon_mastery_percent);
    rec.note_nonzero(
        AttributeLayer::PassiveSkill,
        Some(SKILL_ICE_DEMON),
        "mastery",
        AttributeKey::Mastery,
        AttributeOp::Highest,
        demon_mastery_percent,
    );
    rec.note_nonzero(
        AttributeLayer::PassiveSkill,
        Some(SKILL_SPELL_MASTERY),
        "mastery",
        AttributeKey::Mastery,
        AttributeOp::Highest,
        spell_mastery_percent,
    );
    config.mastery = Some((mastery_percent as f64 / 100.0).clamp(0.0, 1.0));

    // ---- 最大 MP：基线 + 装备 + 魔法增幅（被动：`mmpR` 加算% + `lv2mmp` × 等级）----
    let raw_mp = config.max_mp.unwrap_or(0).max(0);
    let boost = learned_level(mage_skills, skills, SKILL_MAGIC_BOOST);
    let boost_percent = boost.as_ref().and_then(|level| level.mmp_r).unwrap_or(0).max(0);
    let boost_flat = boost
        .as_ref()
        .and_then(|level| level.lv2mmp)
        .unwrap_or(0)
        .max(0);
    rec.note_nonzero(
        AttributeLayer::PassiveSkill,
        Some(SKILL_MAGIC_BOOST),
        "mmpR",
        AttributeKey::MaxMp,
        AttributeOp::AdditivePercent,
        boost_percent,
    );
    let boost_level_bonus =
        boost_flat.saturating_mul(i64::from(character_level.max(1)));
    rec.note_nonzero(
        AttributeLayer::PassiveSkill,
        Some(SKILL_MAGIC_BOOST),
        "lv2mmp",
        AttributeKey::MaxMp,
        AttributeOp::Flat,
        boost_level_bonus,
    );
    let derived_max_mp = raw_mp
        .saturating_add(raw_mp.saturating_mul(boost_percent) / 100)
        // P: `String.h` 说 `lv2mmp` 是「每角色等级」，所以每次重算都用当前等级，
        // 重连 / 换装备都不会复利。
        .saturating_add(boost_level_bonus)
        .max(if mage_job_allowed(job) {
            MAGE_TRANSFER_MIN_MP
        } else {
            0
        });
    config.max_mp = Some(derived_max_mp);
    let max_hp = config.max_hp.unwrap_or(1).max(1);
    config.max_hp = Some(max_hp);

    // ---- 移动速度：装备 `incSpeed` + 傳送的被动 `psdSpeed`（上限取源 `speedMax`），
    //      再并入初學者「迅捷腳步」（增益），合并后 `clamp(0,100)`，最后落到 125 px/s 上 ----
    let teleport = learned_level(mage_skills, skills, SKILL_TELEPORT);
    let teleport_speed = teleport
        .as_ref()
        .and_then(|level| level.psd_speed)
        .unwrap_or(0)
        .max(0);
    let teleport_speed_max = teleport
        .as_ref()
        .and_then(|level| level.speed_max)
        .unwrap_or(0)
        .max(0);
    let equipment_speed = equipment_field_sum(equipped, "incSpeed");
    rec.note_nonzero(
        AttributeLayer::Equipment,
        None,
        "incSpeed",
        AttributeKey::MoveSpeed,
        AttributeOp::Flat,
        equipment_speed,
    );
    rec.note_nonzero(
        AttributeLayer::PassiveSkill,
        Some(SKILL_TELEPORT),
        "psdSpeed",
        AttributeKey::MoveSpeed,
        AttributeOp::Flat,
        teleport_speed,
    );
    // P: `psdSpeed` 是被动百分比，`speedMax` 当作它的源上限。
    let source_speed_percent = equipment_speed
        .saturating_add(teleport_speed)
        .clamp(
            0,
            if teleport_speed_max > 0 {
                teleport_speed_max.min(100)
            } else {
                100
            },
        );
    let beginner_speed = beginner_speed_percent.max(0);
    rec.note_nonzero(
        AttributeLayer::ActiveBuff,
        Some(SKILL_NIMBLE_FEET),
        "speed",
        AttributeKey::MoveSpeed,
        AttributeOp::Flat,
        beginner_speed,
    );
    let speed_percent = source_speed_percent
        .saturating_add(beginner_speed)
        .clamp(0, 100);
    let move_speed = WALK_SPEED * (1.0 + speed_percent as f64 / 100.0);

    // ---- 状态抗性 / 元素抗性：元素適應（被动）的直通字段；未学则不报 ----
    // 抗性是**直通**：源里的值本来就是百分点，不再经过任何合并（`Flat` 只是表述「原样带入」）。
    let adaptation = learned_level(mage_skills, skills, SKILL_ELEMENTAL_ADAPTING);
    let status_resistance = adaptation.as_ref().and_then(|level| level.asr_r);
    let element_resistance = adaptation.as_ref().and_then(|level| level.ter_r);
    for (value, field, key) in [
        (status_resistance, "asrR", AttributeKey::StatusResistance),
        (element_resistance, "terR", AttributeKey::ElementResistance),
    ] {
        if let Some(value) = value {
            rec.note_nonzero(
                AttributeLayer::PassiveSkill,
                Some(SKILL_ELEMENTAL_ADAPTING),
                field,
                key,
                AttributeOp::Flat,
                value,
            );
        }
    }

    PlayerAttributes {
        config,
        magic_attack,
        move_speed,
        status_resistance,
        element_resistance,
        sources: rec.sources,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_attribute_key_is_reachable_from_all() {
        // `ALL` 是门禁遍历用的登记表；漏一个键会让门禁的「逐键独立重算」少查一项。
        assert_eq!(AttributeKey::ALL.len(), 13);
        let labelled: Vec<&str> = AttributeKey::ALL.iter().map(|key| key.label()).collect();
        let mut unique = labelled.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), labelled.len(), "两个属性键用了同一个名字");
    }

    #[test]
    fn a_duration_bearing_skill_must_be_registered_before_it_is_read_as_passive() {
        // 时长只看 `time`：`2221000`（楓葉祝福）**有** `mpCon` 但没有 `time`，
        // 它在源里构不成一个增益窗口 ⇒ 只能是「学得即生效」，不是「施放才生效」。
        assert!(source_has_duration(&serde_json::json!({ "time": 300 })));
        assert!(!source_has_duration(&serde_json::json!({ "mpCon": 10 })));
        assert!(!source_has_duration(&serde_json::json!({})));
        // 名单是**登记**而不是豁免：必须非空（否则第 2 层就没被这条判据约束住）。
        assert_eq!(INTRINSIC_DURATION_SKILLS, [SKILL_ICE_DEMON]);
        for id in [
            SKILL_MAPLE_WARRIOR,
            SKILL_INTELLIGENCE,
            SKILL_BOOSTER,
            SKILL_MAGIC_SHIELD,
        ] {
            assert!(
                !INTRINSIC_DURATION_SKILLS.contains(&id),
                "{id} 的源节点没有 time，不该出现在「带时长」名单里"
            );
        }
    }
}
