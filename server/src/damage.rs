//! 伤害修正管线：玩家侧伤害修正的**唯一求值点**与**唯一口径**。
//!
//! ## 为什么要有这个模块
//!
//! 改前「把百分比变成伤害数字」这件事在服务端手写了 **16 处**，散在四条路径上：
//! `attacks.rs` 的普通攻击（4 处）、`skills.rs::magic_damage_with_passives` 的魔法技能
//! （9 处）、两个技能施放点的前置修正（3 处）。有三件事没有任何一处说得清：
//!
//! 1. **哪些加算、哪些独立乘算**：源 `damR`（伤害率）与 `indieDamR`（独立伤害率）被写进
//!    同一个百分比、乘在同一步里（`skills.rs` 里 `passive_bonus.saturating_add(adventurer_bonus)`），
//!    而同一个 `indieDamR` 来源在普通攻击路径上又是自己单独乘一次
//!    ——**同一个增益，两条路径两种口径**。
//! 2. **取整在哪一层**：每一步都 `.floor().max(1.0)`，只有区域系数用 `i128` 截断除法。
//!    于是**结果与修正项的施加顺序有关**：`attacks.rs` 把魔力無限放在最前，
//!    `skills.rs` 把它放在最后，两边对同一份输入给出不同数字。
//! 3. **上限在哪一层**：`ignoreMobpdpR` 在调用点 clamp，`mdR` / `z` / `damR` 完全不 clamp，
//!    从代码里看不出「这个百分比到底有没有上限、上限是多少」。
//!
//! ## 口径（本模块的全部内容）
//!
//! - **分组只按源字段名的语义判定**，由 [`DamageSource::group`] **唯一**决定；
//!   调用点只说「这是谁」（[`DamageSource`] 的变体），不允许自己挑分组，
//!   因此不可能出现「同一个来源在 A 处当加算、在 B 处当独立」。
//!   - 源 `damR`（伤害率）→ [`ModifierGroup::AdditivePercent`]：同类先求和，整组只乘一次。
//!   - 源 `indieDamR`（独立伤害率）→ [`ModifierGroup::IndependentPercent`]：各自一次乘算。
//!   - 源 `criticaldamage`（暴击伤害）→ [`ModifierGroup::Critical`]：把基准 100 换成 200。
//!   - 源里**没有分组标记**的字段（`x` / `z` / `damage` / `mdR`）→ 独立乘算。
//!     **没有标记就不猜**：沿用改前语义，不擅自归组。
//! - **取整与下限只在两处**：(i) 目标侧减免这一处既有公式（逐字保留），(ii) 管线末端
//!   一次 `floor` + 一次 `max(1)`。玩家侧修正的每一项都不取整 ⇒ 除加算组求和外，
//!   **结果与修正项的施加顺序无关**（`damage_pipeline_acceptance.rs` 用乱序证明）。
//! - **上限只在声明处**（各字段自己的 `clamp(0, 100)`，如 `ignoreMobpdpR`）。管线不再二次
//!   设限，只有一条**防负数因子的守卫**（每条修正的百分比被夹到 ≥ −99）：源里没有任何把
//!   伤害乘成负数或零的技能，一旦触发说明数据出错，而不是某条游戏规则。
//! - **目标侧减免有两套模型，本模块不擅自统一**：魔法技能走 `mdRate` − 无视防御
//!   （本管线的 [`DamagePipeline::apply_target_mitigation`]），普通攻击走等级差 + PDD
//!   （`combat_rules.rs::attack_range_against` 的既有 P 适配，作用在区间上）。统一它们
//!   需要先核定 TMS273 的防御公式，源里没有 ⇒ 如实登记为边界，不猜。
//!
//! ## 不负责
//!
//! 基准伤害（技能倍率 × 魔法攻击、普通攻击区间）、命中与目标选择
//! （`attacks.rs::nearest_attack_target`）、以及**玩家受伤**侧
//! （`monsters.rs::commit_incoming_damage` 与护盾 / 魔心防禦抵偿是另一条通道，本轮未纳入）。
//!
//! ## 可解释输出
//!
//! [`DamageBreakdown::explain`] 一行说清一次命中的基准、目标侧减免、每个来源的百分比、
//! 它把伤害带到多少，以及最终值。设 `MAPLE_DAMAGE_TRACE=1` 时 [`DamagePipeline::resolve`]
//! 会把这一行打到 stderr ——**只往 stderr 写，不进协议、不进快照**，
//! 因此不向客户端开放任何权威写入（协议 24 未动）。

use super::*;
use std::sync::OnceLock;

/// 修正分组。**这就是本模块存在的理由**：哪些加算、哪些独立乘算。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ModifierGroup {
    /// 加算组：同类百分比先求和，整组只乘一次。
    AdditivePercent,
    /// 独立乘算组：各自一次乘算。
    IndependentPercent,
    /// 暴击组：把基准 100 换成 200，组内加算（当前只有一个来源）。
    Critical,
}

impl ModifierGroup {
    /// 该组在诊断串里的名字。
    pub(super) fn label(self) -> &'static str {
        match self {
            ModifierGroup::AdditivePercent => "加算",
            ModifierGroup::IndependentPercent => "独立",
            ModifierGroup::Critical => "暴击",
        }
    }

    /// 该组的基准百分比。暴击组的基准是 200：源 `criticaldamage` 的语义是
    /// 「在 200（= 双倍）之上再加」，不是「在 100 之上再加」。
    pub(super) fn base_percent(self) -> i64 {
        match self {
            ModifierGroup::Critical => 200,
            ModifierGroup::AdditivePercent | ModifierGroup::IndependentPercent => 100,
        }
    }
}

/// 伤害修正的一个来源。每个变体对应**源里的一类字段**，
/// 分组由 [`DamageSource::group`] 唯一决定——调用点不说分组。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum DamageSource {
    /// 源 `damR`（伤害率 / 总伤害）。
    DamageRate { skill_id: u32 },
    /// 源 `indieDamR`（独立伤害率）。
    IndependentDamageRate { skill_id: u32 },
    /// 源 `criticaldamage`（暴击伤害）。
    CriticalDamage { skill_id: u32 },
    /// 源里**没有分组标记**的字段（`x` / `z` / `damage` / `mdR`）。
    /// `field` 就是源的字段名，写进诊断串便于回源核对。
    UnmarkedField { skill_id: u32, field: &'static str },
    /// 命中本身携带的**冻结层**加成：被消耗掉的冻结层按层叠加（源 Ice Effect /
    /// Fourth Freeze 的 `x`/`y`，无分组标记）。`percent` 已是「每层 × 层数」后的合计。
    FreezeLayerBonus { skill_id: u32 },
    /// 区域系数（Boss 练习场地的物理 / 魔法护盾）。**不是玩家属性**，
    /// 也不来自技能表；`percent` 为负数表示减伤（如 −15 即 ×0.85）。
    RegionGuard,
}

impl DamageSource {
    /// 来源 → 分组。**这是两个方向唯一的定义处**：调用点只给来源，
    /// 分组由它派生 ⇒ 同一份源数据不可能被两条伤害路径算成两种口径。
    pub(super) fn group(self) -> ModifierGroup {
        match self {
            DamageSource::DamageRate { .. } => ModifierGroup::AdditivePercent,
            DamageSource::CriticalDamage { .. } => ModifierGroup::Critical,
            DamageSource::IndependentDamageRate { .. }
            | DamageSource::UnmarkedField { .. }
            | DamageSource::FreezeLayerBonus { .. }
            | DamageSource::RegionGuard => ModifierGroup::IndependentPercent,
        }
    }

    /// 诊断串里的名字（回源核对用）。
    pub(super) fn label(self) -> String {
        match self {
            DamageSource::DamageRate { skill_id } => format!("damR:{skill_id}"),
            DamageSource::IndependentDamageRate { skill_id } => format!("indieDamR:{skill_id}"),
            DamageSource::CriticalDamage { skill_id } => format!("crit:{skill_id}"),
            DamageSource::UnmarkedField { skill_id, field } => format!("{field}:{skill_id}"),
            DamageSource::FreezeLayerBonus { skill_id } => format!("freeze-layer:{skill_id}"),
            DamageSource::RegionGuard => "region-guard".to_owned(),
        }
    }
}

/// 防负数因子的守卫：任何一条修正的百分比都夹到 ≥ −99，
/// 即因子 ≥ 1/100。**这不是游戏数值上限**（上限在各字段自己的 `clamp` 里）。
const MODIFIER_FLOOR_PERCENT: i64 = -99;

/// 目标侧减免的留痕：原始减免率、无视防御的百分比、算出的有效减免率与结果值。
pub(super) struct MitigationStep {
    pub(super) rate_percent: f64,
    pub(super) ignored_percent: i64,
    pub(super) effective_percent: f64,
    pub(super) after: i64,
}

/// 乘算的一步。加算组 / 暴击组会把**全部来源合并成一条**（因为它们只乘一次）；
/// 独立组每个来源各一条。
///
/// `sources` 里带的是**每个来源自己的百分比**（加算组里它们加起来才等于 `percent`），
/// 这样诊断串与验收都能回答「这条修正到底是谁贡献了多少」。
pub(super) struct FactorStep {
    pub(super) group: ModifierGroup,
    pub(super) sources: Vec<(DamageSource, i64)>,
    /// 加算组 / 暴击组是**求和后**的百分比；独立组是本条的。
    pub(super) percent: i64,
    /// 走到这一步为止「若在此取整」的值。仅供诊断：权威取整只在管线末端一次。
    pub(super) projected_after: i64,
}

/// 一次命中的可解释输出。
pub(super) struct DamageBreakdown {
    pub(super) base: i64,
    pub(super) mitigation: Option<MitigationStep>,
    pub(super) factors: Vec<FactorStep>,
    pub(super) total: i64,
}

impl DamageBreakdown {
    /// 服务端实际用来扣血的数字。**唯一权威取值**。
    pub(super) fn total(&self) -> i64 {
        self.total
    }

    /// 某个来源**自己**在这次命中里的百分比。加算组里同组各来源各报各的，
    /// 不报组内合计（合计在 `factors[*].percent` 里）。
    /// 供验收断言「这次命中里确实用了谁、用了多少」，不参与结算；
    /// 只在测试里存在，免得生产构建里留一个没人读的旁路取值口。
    #[cfg(test)]
    pub(super) fn percent_of(&self, source: DamageSource) -> Option<i64> {
        self.factors
            .iter()
            .find_map(|factor| {
                factor
                    .sources
                    .iter()
                    .find(|(candidate, _)| *candidate == source)
                    .map(|(_, percent)| *percent)
            })
    }

    /// 开发态的一行解释：基准 → 目标减免 → 每个来源 → 合计。
    pub(super) fn explain(&self) -> String {
        let mut out = format!("base={}", self.base);
        if let Some(mitigation) = &self.mitigation {
            out.push_str(&format!(
                "; 目标减免 {:.2}% 无视 {}% → 有效 {:.2}% → {}",
                mitigation.rate_percent,
                mitigation.ignored_percent,
                mitigation.effective_percent,
                mitigation.after
            ));
        }
        for factor in &self.factors {
            let sources: Vec<String> = factor
                .sources
                .iter()
                .map(|(source, percent)| format!("{}{percent:+}", source.label()))
                .collect();
            out.push_str(&format!(
                "; ×({}{:+})/100 {}[{}] → {}",
                factor.group.base_percent(),
                factor.percent,
                factor.group.label(),
                sources.join("+"),
                factor.projected_after
            ));
        }
        out.push_str(&format!("; 合计 {}", self.total));
        out
    }
}

/// 累积一条伤害的修正来源，最后一次性求值。
pub(super) struct DamagePipeline {
    base: i64,
    mitigation: Option<MitigationStep>,
    /// 加算组 / 暴击组的原始项（求和后只乘一次，所以合成一条 [`FactorStep`]）。
    additive: Vec<(DamageSource, i64)>,
    critical: Vec<(DamageSource, i64)>,
    /// 独立乘算组的项，按加入顺序求值（顺序不影响结果，只为诊断稳定）。
    independent: Vec<(DamageSource, i64)>,
}

impl DamagePipeline {
    pub(super) fn new(base: i64) -> Self {
        Self {
            base: base.max(1),
            mitigation: None,
            additive: Vec::new(),
            critical: Vec::new(),
            independent: Vec::new(),
        }
    }

    /// 目标侧减免：先按「无视防御」的百分比把减免率打折，再削减基准。
    /// **公式与改前逐字相同**（含它自己那一次取整）——它作用在基准上，
    /// 结果随后作为管线的输入，所以是既有的第 0 层，不在末端那次取整里。
    pub(super) fn apply_target_mitigation(&mut self, rate_percent: f64, ignored_percent: i64) {
        let ignored = ignored_percent.clamp(0, 100);
        let effective_percent =
            (rate_percent * (100.0 - ignored as f64) / 100.0).clamp(0.0, 100.0);
        let after = (self.base as f64 * (100.0 - effective_percent) / 100.0)
            .floor()
            .max(1.0) as i64;
        self.mitigation = Some(MitigationStep {
            rate_percent,
            ignored_percent: ignored,
            effective_percent,
            after,
        });
    }

    /// 记一条修正。
    ///
    /// 「百分比 0 = 乘 1 = 恒等」只对基准 100 的组成立：暴击组的基准是 200，
    /// 所以 `criticaldamage = 0` 的一条**是**有效修正（×2.00），必须记下来。
    pub(super) fn add(&mut self, source: DamageSource, percent: i64) {
        let percent = percent.max(MODIFIER_FLOOR_PERCENT);
        let group = source.group();
        if percent == 0 && group.base_percent() == 100 {
            return;
        }
        match group {
            ModifierGroup::AdditivePercent => self.additive.push((source, percent)),
            ModifierGroup::Critical => self.critical.push((source, percent)),
            ModifierGroup::IndependentPercent => self.independent.push((source, percent)),
        }
    }

    /// 求值。玩家侧修正用**有理数**累乘（分子 / 分母都是 `i128`），
    /// 只在最后取整一次、下限一次 ⇒ 结果与修正项的施加顺序无关。
    pub(super) fn resolve(self) -> DamageBreakdown {
        let base = self.base;
        let mut num: i128 = i128::from(self.mitigation.as_ref().map_or(base, |m| m.after));
        let mut den: i128 = 1;
        let mut factors = Vec::new();
        let push = |num: &mut i128,
                    den: &mut i128,
                    group: ModifierGroup,
                    sources: Vec<(DamageSource, i64)>,
                    percent: i64,
                    factors: &mut Vec<FactorStep>| {
            *num = num.saturating_mul(i128::from(group.base_percent().saturating_add(percent)));
            *den = den.saturating_mul(100);
            factors.push(FactorStep {
                group,
                sources,
                percent,
                projected_after: (*num / *den).max(1) as i64,
            });
        };
        if !self.additive.is_empty() {
            let percent = self.additive.iter().map(|(_, percent)| *percent).sum::<i64>();
            push(
                &mut num,
                &mut den,
                ModifierGroup::AdditivePercent,
                self.additive,
                percent,
                &mut factors,
            );
        }
        if !self.critical.is_empty() {
            let percent = self.critical.iter().map(|(_, percent)| *percent).sum::<i64>();
            push(
                &mut num,
                &mut den,
                ModifierGroup::Critical,
                self.critical,
                percent,
                &mut factors,
            );
        }
        for (source, percent) in self.independent {
            push(
                &mut num,
                &mut den,
                ModifierGroup::IndependentPercent,
                vec![(source, percent)],
                percent,
                &mut factors,
            );
        }
        let total = (num / den).max(1) as i64;
        let breakdown = DamageBreakdown {
            base,
            mitigation: self.mitigation,
            factors,
            total,
        };
        if damage_trace_enabled() {
            eprintln!("[damage] {}", breakdown.explain());
        }
        breakdown
    }
}

/// `MAPLE_DAMAGE_TRACE=1` 打开开发态追踪。只读一次环境变量。
fn damage_trace_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var("MAPLE_DAMAGE_TRACE")
            .map(|value| value != "0" && !value.is_empty())
            .unwrap_or(false)
    })
}

/// 源 `indieDamR` 的一个来源（傳說冒險 2221053，`maxLevel = 1`）在**两条伤害路径上的同一个取值**。
///
/// 改前普通攻击路径取「已学等级」（再 clamp 到 0..100），魔法技能路径固定取 1 级且不 clamp：
/// 该技能 `maxLevel = 1`，所以今天两个口径的数值相同，但**形状不同** ⇒ 源码把 `maxLevel`
/// 调大时两条路径会静默分叉。收成一处，取值口径只有这一个定义。
pub(super) fn hyper_adventurer_damage_percent(mage_skills: &MageSkills, player: &Player) -> i64 {
    let level = player
        .state
        .skills
        .get(&SKILL_HYPER_ADVENTURER)
        .copied()
        .unwrap_or(1);
    mage_skills
        .level(SKILL_HYPER_ADVENTURER, level)
        .and_then(|level| level.indie_dam_r)
        .unwrap_or(10)
        .clamp(0, 100)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAMAGE_RATE: DamageSource = DamageSource::DamageRate { skill_id: 2210001 };
    const INDEPENDENT: DamageSource = DamageSource::IndependentDamageRate { skill_id: 2221053 };
    const CRITICAL: DamageSource = DamageSource::CriticalDamage { skill_id: 2210009 };
    const UNMARKED: DamageSource = DamageSource::UnmarkedField {
        skill_id: 2220010,
        field: "x",
    };

    #[test]
    fn every_source_has_exactly_one_group() {
        // 分组是来源的属性，不是调用点的选择。
        assert_eq!(DAMAGE_RATE.group(), ModifierGroup::AdditivePercent);
        assert_eq!(INDEPENDENT.group(), ModifierGroup::IndependentPercent);
        assert_eq!(UNMARKED.group(), ModifierGroup::IndependentPercent);
        assert_eq!(DamageSource::RegionGuard.group(), ModifierGroup::IndependentPercent);
        assert_eq!(CRITICAL.group(), ModifierGroup::Critical);
        assert_eq!(ModifierGroup::Critical.base_percent(), 200);
        assert_eq!(ModifierGroup::AdditivePercent.base_percent(), 100);
    }

    #[test]
    fn additive_sources_are_summed_then_multiplied_once() {
        let mut pipeline = DamagePipeline::new(100);
        pipeline.add(DAMAGE_RATE, 20);
        pipeline.add(DamageSource::DamageRate { skill_id: 2220046 }, 50);
        let breakdown = pipeline.resolve();
        // 一次 70%，不是「先 20% 再 50%」的两次取整。
        assert_eq!(breakdown.total(), 170);
        assert_eq!(breakdown.factors.len(), 1, "加算组合成一条");
        assert_eq!(breakdown.factors[0].percent, 70, "组内合计");
        assert_eq!(breakdown.percent_of(DAMAGE_RATE), Some(20), "各来源各报各的");
        assert_eq!(
            breakdown.percent_of(DamageSource::DamageRate { skill_id: 2220046 }),
            Some(50)
        );
    }

    #[test]
    fn result_does_not_depend_on_the_order_modifiers_were_added() {
        let build = |order: &[i64]| {
            let mut pipeline = DamagePipeline::new(9_973);
            for (index, percent) in order.iter().enumerate() {
                let source = DamageSource::UnmarkedField {
                    skill_id: 9_000 + index as u32,
                    field: "x",
                };
                pipeline.add(source, *percent);
            }
            pipeline.resolve().total()
        };
        let forward = build(&[13, 27, 5, 41, 9]);
        let backward = build(&[9, 41, 5, 27, 13]);
        assert_eq!(forward, backward, "末端只取整一次 ⇒ 顺序无关");
    }

    #[test]
    fn zero_modifiers_leave_the_base_untouched() {
        let mut pipeline = DamagePipeline::new(1_234);
        pipeline.add(DAMAGE_RATE, 0);
        pipeline.add(DamageSource::RegionGuard, 0);
        let breakdown = pipeline.resolve();
        assert_eq!(breakdown.total(), 1_234);
        assert!(breakdown.factors.is_empty(), "恒等项不留痕");
    }

    #[test]
    fn the_floor_and_the_guard_are_the_only_bounds() {
        // 防负数因子的守卫：−100 被夹到 −99（因子 1/100），而不是把伤害变成 0。
        let mut pipeline = DamagePipeline::new(1_000);
        pipeline.add(DamageSource::RegionGuard, -100);
        assert_eq!(pipeline.resolve().total(), 10);
        // 下限一次：任何组合都不会低于 1。
        let mut pipeline = DamagePipeline::new(1);
        pipeline.add(DAMAGE_RATE, -99);
        assert_eq!(pipeline.resolve().total(), 1);
    }

    #[test]
    fn target_mitigation_keeps_the_previous_formula() {
        let mut pipeline = DamagePipeline::new(1_000);
        pipeline.apply_target_mitigation(10.0, 40);
        // 10% 的减免被 40% 无视打成 6%，基准 → 940（与改前逐字相同）。
        let breakdown = pipeline.resolve();
        assert_eq!(breakdown.total(), 940);
        let mitigation = breakdown.mitigation.expect("留痕");
        assert_eq!(mitigation.ignored_percent, 40);
        assert!((mitigation.effective_percent - 6.0).abs() < 1e-9);
    }

    #[test]
    fn critical_replaces_the_hundred_percent_baseline() {
        let mut pipeline = DamagePipeline::new(100);
        pipeline.add(CRITICAL, 13);
        // 源 criticaldamage 是「在 200 之上再加」，不是 100。
        assert_eq!(pipeline.resolve().total(), 213);
    }

    #[test]
    fn a_zero_critical_still_doubles() {
        // 暴击组基准 200 ⇒ 没学 魔法爆擊（`criticaldamage = 0`）时暴击仍是 ×2，
        // 不能被「0% 是恒等」那条规则丢掉。
        let mut pipeline = DamagePipeline::new(100);
        pipeline.add(CRITICAL, 0);
        assert_eq!(pipeline.resolve().total(), 200);
    }

    #[test]
    fn the_ignored_percent_is_clamped_where_the_pipeline_reads_it() {
        // 无视防御的总和上限来自源里的字段定义，管线读它时再夹一次：
        // 夹到 100 ⇒ 有效减免 0 ⇒ 基准原样。
        let mut pipeline = DamagePipeline::new(1_000);
        pipeline.apply_target_mitigation(80.0, 500);
        let breakdown = pipeline.resolve();
        assert_eq!(
            breakdown.mitigation.as_ref().unwrap().ignored_percent,
            100
        );
        assert_eq!(breakdown.total(), 1_000);
    }

    #[test]
    fn the_breakdown_names_every_source_it_used() {
        let mut pipeline = DamagePipeline::new(500);
        pipeline.apply_target_mitigation(20.0, 0);
        pipeline.add(DAMAGE_RATE, 50);
        pipeline.add(CRITICAL, 13);
        pipeline.add(INDEPENDENT, 10);
        pipeline.add(DamageSource::RegionGuard, -15);
        let breakdown = pipeline.resolve();
        let text = breakdown.explain();
        for needle in [
            "base=500",
            "damR:2210001",
            "crit:2210009",
            "indieDamR:2221053",
            "region-guard",
            "合计",
        ] {
            assert!(text.contains(needle), "解释串缺 {needle}：{text}");
        }
        // 500 → 目标减免 20% → 400 → 加算 ×1.50 = 600 → 暴击 ×2.13 = 1278
        // → 独立 ×1.10 = 1405.8 → 独立 ×0.85 = 1194.93 ⇒ 1194
        assert_eq!(breakdown.total(), 1_194);
    }
}
