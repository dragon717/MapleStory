//! 战斗机制纵深：**召唤物 / 持续伤害 / 投射物 / 二段命中** 四支柱的唯一权威。
//!
//! 从 `world.rs` / `skills.rs` 里分出来的第十三块职责。本模块只负责四件事：
//! ① 把源字段**派生**成一次施法的机制计划（[`AttackPlan`]），不写死技能名单；
//! ② 持有两类需要跨拍存活的状态：怪物侧 DoT（[`MonsterDot`]）与飞行中的投射物
//!    （[`Projectile`]），入口是 [`World::step_monster_dots`] / [`World::step_projectiles`]；
//! ③ 定义四支柱的**结算优先级**（见下）与它们之间的交互规则；
//! ④ 提供「玩家→怪」伤害的第二个提交点 [`World::commit_player_damage`]：持续伤害滴答
//!    走它，所以 DoT 的经验 / 掉落 / 任务计数与直接命中同源，不是第二套账。
//!
//! # 结算优先级（同一拍内，数值越小越先）
//!
//! | 序 | 阶段 | 触发条件 | 结算位置 |
//! |----|------|----------|----------|
//! | 1 | 触发骰 `roll` | 源 `prop`（缺省 100%），按 `(施法者, 请求, 目标, 机制名)` 确定性掷骰 | 命中瞬间 |
//! | 2 | 首段直接伤害 `first-hit` | 段延迟为 0 的段 | 施法拍内即时 |
//! | 3 | DoT 挂载 / 刷新 `dot-apply` | 第 1 段真的打出伤害 **且** 掷骰命中 | 首段命中之后 |
//! | 4 | 二段命中 `second-hit` | `lt2`∧`rb2` 齐备 **且** 首段链收尾时仍有真实命中 | 本施法最后一次结算的尾 |
//! | 5 | 召唤物脉冲 `summon-pulse` | 独立时间轴（`step_summons`） | 世界拍 |
//! | 6 | 投射物到达 `projectile-arrival` | `arrive_at <= tick` | 世界拍 |
//! | 7 | DoT 滴答 `dot-tick` | `next_tick <= tick` | 世界拍 |
//!
//! 世界拍里的顺序是 **召唤物 → 投射物 → DoT**，理由是同一条：越「已确定、越被动」的
//! 结算越靠后。召唤物是主人主动放出去的「小号」，先打；投射物是已经发射、正在飞的实体，
//! 随后落地；DoT 是挂在怪身上的残余，最后结算——于是它看到的血量已经被前两类削过，
//! **永远不会抢走投射物的击杀归属**。
//!
//! # 机制之间的交互（哪些会互相影响、哪些刻意不互相影响）
//!
//! - **投射物 × 其它**：延迟段落地时**重新做碰撞判定**（`area_targets_at` 以施法时冻结的
//!   原点重算），所以「发射后走进命中盒的怪会被打到、走出去的不会被追加打到」。同一段
//!   落地的怪物如果已被前一段打死，直接跳过（`settle_area_segments` 的存活判据）。
//! - **DoT × 击退**：DoT 跳伤**不触发击退**（`register_monster_knockback` 不调用）。
//!   源里的 `pushed` 是「单次伤害阈值」，用每跳的小额伤害去推怪会得到与直接命中完全
//!   不同的位移，那不是源语义。
//! - **DoT × 叠层**：同一 `(施法者, 技能, 目标)` 只有一个实例。重复命中**叠层 +1**
//!   （上限 [`DOT_MAX_STACKS`]）并把时长**取长者**，但**不重置下一次跳伤时刻**——
//!   连续点射因此是「越打越稳」而不是「越打越拖」。跳伤本身不刷新自己，不会自激。
//! - **DoT × 暴击 / 冰冻层**：都不参与。DoT 是已挂上的残余伤害，没有命中瞬间可掷骰。
//! - **二段命中 × 首段**：二段以 `lt2/rb2` **独立重选**目标（源里这对方框比主盒窄，
//!   `3111015 閃光幻象` 主盒 ±800 而第二盒只有身前一块），所以它是「伤害分配」：
//!   主盒吃 `damage%` × N 段，第二盒再吃一次 `damPlus%`。二段**要求首段链真的打到人**，
//!   空挥不会凭空多一段。
//! - **召唤物 × 主人**：脉冲复用主人**当拍**的属性快照（走同一条 `cast_elemental_area_at`），
//!   所以主人的增益、武器、等级差修正对召唤物同样生效；三件召唤（冰魔 / 冰鋒刃 / 三转球形
//!   闪电）共用 `Player::summons` 一条队列，容量判据收口在 [`World::summon_slots_available`]，
//!   脉冲周期收口在 [`summon_pulse_ms`]（2026-09-23 前球形闪电另走一个单槽，已并入），
//!   存活时长收口在 [`summon_lifetime_ms`]（同日收口：改前三处各写一份，其中冰鋒刃
//!   那处根本不读源）。

use super::*;

use crate::mage::MagePoint;

/// 同一条 DoT 的叠层上限。超过就只刷新时长，不再涨伤害。
pub(super) const DOT_MAX_STACKS: u32 = 5;
/// 一个投射物在空中最多待多久（毫秒）。源里的 `ballDelay*` 都是百毫秒级，这个值只是
/// 「施法者掉线 / 卡住时不会永久堆积」的兜底，不是源参数。
pub(super) const PROJECTILE_MAX_FLIGHT_MS: u64 = 10_000;
/// 共用召唤槽位（`Player::summons`）的容量预算，**唯一**的容量判据。
///
/// 2026-09-23（S5 召唤通用化）起它是完整答案：三转球形闪电原先走另一个单槽
/// `Player::summon`（「同技能重放即替换」），现已并入这条队列，所以不再有
/// 「队列 + 单槽」两套账。值取 3 = 合并前的「队列 2 + 单槽 1」，**零行为回归**。
pub(super) const SUMMON_BUDGET: usize = 3;
/// 召唤物脉冲周期的**契约兜底值**（毫秒）：源里既没有毫秒书写的 `attackDelay`、也没有
/// 毫秒书写的 `subTime` 时用它（见 [`World::summon_pulse_ms`]）。
pub(super) const SUMMON_PULSE_FALLBACK_MS: u64 = 1_080;
/// 召唤物**存活时长**的契约兜底值（毫秒）：源里没有 `time` 时用它
/// （见 [`summon_lifetime_ms`]）。
///
/// 它取代的是收口前**两处互相矛盾的静默默认**：`cast_demon_summon` 的
/// `unwrap_or(0)` 会算出 1 拍（≈ 立刻到期），而 `cast_thunder_sphere` 自己另写
/// 20 秒／60 秒。现在默认值只剩这一处。当前五本已接线的召唤书**逐级都带 `time`**，
/// 兜底分支在验收里被证明不可达（`mech_summon_lifetime_comes_from_one_source_derivation`）。
pub(super) const SUMMON_LIFETIME_FALLBACK_MS: u64 = 60_000;
/// 源 `time` 的**单位分界**：`>=` 本值 ⇒ 源里写的就是毫秒，否则按秒 ×1000。
///
/// 判据形状与 [`summon_pulse_ms`] 的 `subTime >= 一拍` 同源——都是「按量级认单位」，
/// 因为源里**没有任何结构字段**能定下 `time` 的单位（逐项核对过：`summon` 节点在不在
/// 都不成立——`1121055` 有 `summon` 节点却写 `time=10000`，`2100010` 没有 `summon`
/// 节点却写 `time=4+d(x/4)`；`attackDelay` 在场也不成立——`1301014` 带
/// `attackDelay=360` 却写 `time=5`）。
///
/// 量级判据的依据是全书 148 条带 `time` 的技能逐条核对的结果：按秒书写的召唤存活时长
/// 最大只到 `260`（冰魔／火魔 `110+5*x`、閃電球 `2211011` `60+3*x`、hidden `2211015`
/// `20+2*x`、主教召唤 `40+2*x`／`60+16*x`），而按毫秒书写的三条是 `3000`（`3111013 箭座`）／
/// `4000`（`2221012 冰鋒刃`）／`10000`（`1121055`）——中间**没有重叠区**。
pub(super) const SUMMON_LIFETIME_MS_THRESHOLD: i64 = 1_000;

/// 一次施法需要经过哪几层机制，以及每层的参数。**全部从源字段派生**：
/// 字段在不在、值是多少决定计划长什么样，没有按技能 id 写死的分支。
#[derive(Clone, Default)]
pub(super) struct AttackPlan {
    /// 每段的落点延迟（毫秒，相对施法拍）。长度 = 源 `attackCount`。
    /// 全 0 ⇒ 全部在本拍即时结算（本包 30 条既有技能的现状，行为逐字不变）。
    pub segment_delay_ms: Vec<u64>,
    pub dot: Option<DotPlan>,
    pub second: Option<SecondHitPlan>,
    /// 施放时给**施法者自己**开的自增益窗时长（毫秒，源自源 `time` 秒 × 1000）。
    ///
    /// 只有带 `time` 的**自增益**技能会消费它（S1 施放窗）；负面状态窗 / 召唤存活时长
    /// 是 `time` 的另外两种语义，由门禁单独挡在表外，不在这里消费。
    pub self_buff_window_ms: Option<u64>,
}

#[derive(Clone, Copy)]
pub(super) struct DotPlan {
    /// 挂载几率（源 `prop`，缺省 100）。
    pub prop: u32,
    /// 每层每跳的伤害%（源 `dot`）。
    pub per_tick_percent: i64,
    /// 跳伤间隔（拍，源 `dotInterval` 秒）。
    pub cadence_ticks: u64,
    /// 持续时间（拍，源 `dotTime` 秒）。**刻意不回落源 `time`**——理由见 `AttackPlan::of`。
    pub duration_ticks: u64,
}

#[derive(Clone, Copy)]
pub(super) struct SecondHitPlan {
    /// 第二命中盒（源 `lt2`/`rb2`，同样是**朝左**书写的坐标，由 `area_targets_at` 镜像）。
    pub lt: MagePoint,
    pub rb: MagePoint,
    /// 二段伤害%（源 `damPlus`；缺失时回落主 `damage`）。
    pub damage_percent: i64,
    pub prop: u32,
}

impl AttackPlan {
    /// 从源字段派生计划。**唯一入口**，施法链与投射物到达共用同一份派生。
    pub(super) fn of(level: &MageLevel) -> Self {
        let total = level.attack_count.unwrap_or(1).max(1);
        let delays = segment_delays(level, total);
        let dot = level
            .dot
            .filter(|percent| *percent > 0)
            .map(|per_tick_percent| {
                let cadence_ms = level
                    .dot_interval
                    .unwrap_or(1)
                    .max(0)
                    .saturating_mul(1_000)
                    .max(TICK_MS as i64);
                // 时长只认源 `dotTime`。不回落 `time`：`time` 在召唤 / 持续场那边是
                // 「脉冲周期」，同一字段被两条路径各读一次会让判据与行为一起分叉。
                let duration_seconds = level.dot_time.unwrap_or(0).max(0);
                DotPlan {
                    prop: level.prop.unwrap_or(100).clamp(0, 100) as u32,
                    per_tick_percent,
                    cadence_ticks: (cadence_ms as u64 / TICK_MS).max(1),
                    duration_ticks: ((duration_seconds as u64).saturating_mul(1_000) / TICK_MS).max(1),
                }
            });
        // 二段命中需要**独立的第二命中盒**：`lt2`/`rb2` 必须齐备。只有 `damPlus`
        // 却没有第二盒的技能（`3121052 波紋衝擊`）不接——源里给不出第二盒的位置，
        // 凭空拿主盒当第二盒会把「二段」退化成「同一段打两遍」。
        let second = match (level.lt2, level.rb2) {
            (Some(lt), Some(rb)) => Some(SecondHitPlan {
                lt,
                rb,
                damage_percent: level.dam_plus.or(level.damage).unwrap_or(0).max(0),
                prop: level.prop.unwrap_or(100).clamp(0, 100) as u32,
            }),
            _ => None,
        };
        // 自增益施放窗：源 `time`（秒）> 0 才派生。与既有自增益 buff 同一约定
        // （`activate_hyper_adventurer` 及 DoT 的 `dotTime` 都是秒 × 1000）。
        let self_buff_window_ms = level
            .time
            .filter(|seconds| *seconds > 0)
            .map(|seconds| (seconds as u64).saturating_mul(1_000));
        Self {
            segment_delay_ms: delays,
            dot,
            second,
            self_buff_window_ms,
        }
    }

    /// 需要在空中飞的段（延迟 > 0，1-based 段号）。空 ⇒ 本拍全结。
    pub(super) fn flying_segments(&self) -> Vec<(u32, u64)> {
        self.segment_delay_ms
            .iter()
            .enumerate()
            .filter(|(_, delay)| **delay > 0)
            .map(|(index, delay)| (index as u32 + 1, *delay))
            .collect()
    }

    pub(super) fn immediate_segments(&self) -> Vec<u32> {
        self.segment_delay_ms
            .iter()
            .enumerate()
            .filter(|(_, delay)| **delay == 0)
            .map(|(index, _)| index as u32 + 1)
            .collect()
    }
}

/// 逐段落点延迟（毫秒，**累计**值）。
///
/// 源约定：`ballDelay` 是第 1 段的间隔，`ballDelay1/2/3` 依次是其后各段。
/// 只写前几段是常态（`4221014 致命暗殺` 只写了 3 个间隔却有 6 段），此时后段
/// **优先用 `subTime`**（同技能同时带它时，它是「子窗口计时」的另一份书写），
/// 没有 `subTime` 才沿用最后一个已写明的 `ballDelay*`——两条都不许把后段当成 0，
/// 那会让第 4 段之后的伤害瞬移到脸上。
///
/// ⚠️ **`subTime` 单独出现时不参与段延迟**。它在召唤 / 持续场那一侧是「脉冲周期」
/// （`step_summons` 已经消费了它），拿它当首段落点会让召唤物的每一跳都变成飞行物
/// ——同一个字段被两条路径各消费一次，是必须避免的。所以这里只在**同时带
/// `ballDelay*`** 时读它（门禁的配对消费表 `PAIRED_CONSUMPTION` 记的就是这条）。
/// 两者都没有 ⇒ 全 0，行为与本轮之前逐字相同。
fn segment_delays(level: &MageLevel, total: u32) -> Vec<u64> {
    let slots = [level.ball_delay, level.ball_delay1, level.ball_delay2, level.ball_delay3];
    let authored = slots
        .iter()
        .map(|value| value.unwrap_or(0).max(0) as u64)
        .collect::<Vec<_>>();
    // **「写了 0」与「没写」是两件事**：`1101011 雙連斬` 的 `ballDelay: 0` 是「第 1 段
    // 本拍就到」（那正是它叫「雙連斬」的原因），当成「没写」会把首段推迟到第 2 段的间隔上。
    let present = slots.iter().map(Option::is_some).collect::<Vec<_>>();
    let has_ball_delay = present.iter().any(|value| *value);
    let sub_time = level.sub_time.unwrap_or(0).max(0) as u64;
    let mut accumulated = 0_u64;
    (0..total)
        .map(|index| {
            let step = if !has_ball_delay {
                0
            } else if present.get(index as usize).copied().unwrap_or(false) {
                authored[index as usize]
            } else if sub_time > 0 {
                // 源只写了前几段时，后面各段优先用 `subTime`（同技能同时带它时，
                // 它是「子窗口计时」的另一份书写）。
                sub_time
            } else {
                // 两条都没有 ⇒ 沿用最后一个**已写明**的间隔：把后面的段当成 0 会让
                // 第 4 段之后的伤害瞬移到脸上。
                (0..authored.len())
                    .rev()
                    .find(|slot| present[*slot] && authored[*slot] > 0)
                    .map(|slot| authored[slot])
                    .unwrap_or(0)
            };
            accumulated = accumulated.saturating_add(step);
            accumulated
        })
        .collect()
}

/// 召唤物**脉冲周期**（毫秒）的唯一派生点。原先这段判据散在两处：三转球形闪电在单槽
/// 分支里读自己的 `subTime`，四转冰魔 / 冰鋒刃在队列分支里按 `skill_id` 各写一个字面量
/// （`SKILL_ICE_DEMON => 1_080`、`SKILL_FROZEN_ORB => attack_delay`）。
///
/// 源里**没有**统一的「召唤物攻击间隔」字段，三件召唤各写在不同槽上（逐条核对
/// `shared/mage-skills.json`）：`attackDelay`（冰鋒刃 2221012 = 210）已经按毫秒书写；
/// `subTime` 也有按毫秒书写的（閃電球 2211011 / 2211015 = 1080）；而召喚冰魔 2221005 的
/// `subTime=8` 小于一拍、不是毫秒书写的间隔（既有注释已警告过别把它读成 8ms）。
///
/// ⇒ 判据是「**毫秒槽优先**」：`attackDelay` > `subTime`（仅当其不小于一拍）>
/// 契约值 [`SUMMON_PULSE_FALLBACK_MS`]。逐件复现合并前的现行为：210 / 1080 / 1080。
///
/// 取 `&MageSkills` 而不是 `&self`：调用点（`step_summons`）正同时持有 `player` 的
/// 可变借用，经 `self.方法()` 会被借用检查器挡下，直接借用 `self.mage_skills` 字段才行。
pub(super) fn summon_pulse_ms(skills: &MageSkills, skill_id: u32, level: u32) -> u64 {
    let Some(row) = skills.level(skill_id, level) else {
        return SUMMON_PULSE_FALLBACK_MS;
    };
    if let Some(delay) = row.attack_delay.filter(|value| *value > 0) {
        return delay as u64;
    }
    if let Some(sub) = row.sub_time.filter(|value| *value as u64 >= TICK_MS) {
        return sub as u64;
    }
    SUMMON_PULSE_FALLBACK_MS
}

/// 召唤物**存活时长**的唯一派生点（毫秒）。与 [`summon_pulse_ms`] 同形同责：
/// 一个 `&MageSkills` + 技能 id + 等级进、一个毫秒值出，中间没有技能名单。
///
/// 收口前这笔账写了**三处**，而且互相不一致：
///
/// * `elemental.rs::cast_demon_summon` 把 `time` 当秒（`× 1000`）；
/// * `skills.rs::cast_thunder_sphere` 也当秒，但**默认值另写** 20 秒／60 秒；
/// * `elemental.rs::cast_frozen_orb` **根本不读源**，直接写死 `4_000`——
///   源里 `2221012` 的 `time` 一旦改数，这条召唤的存活时长会静默漂移。
///
/// 现在三处都走这里，判据只剩「`time` 的量级认单位」一条：
///
/// * `time` 缺 → [`SUMMON_LIFETIME_FALLBACK_MS`]；
/// * `time >= ` [`SUMMON_LIFETIME_MS_THRESHOLD`] → 源里写的就是毫秒，原样返回；
/// * 否则按秒 ×1000。
///
/// **写明的 0 不等于没写**：`time = Some(0)` 走第三支得到 0，调用方照旧
/// `.max(1)` 收敛成「1 拍即到期」——与收口前 `cast_demon_summon` 的语义逐字相同，
/// 不许把它并进「缺失 ⇒ 兜底值」那一支。
pub(super) fn summon_lifetime_ms(skills: &MageSkills, skill_id: u32, level: u32) -> u64 {
    let Some(time) = skills.level(skill_id, level).and_then(|row| row.time) else {
        return SUMMON_LIFETIME_FALLBACK_MS;
    };
    if time >= SUMMON_LIFETIME_MS_THRESHOLD {
        time as u64
    } else {
        u64::try_from(time.max(0))
            .unwrap_or(0)
            .saturating_mul(1_000)
    }
}

/// 怪物侧持续伤害的一个实例。键是 `(施法者, 技能, 目标)`，所以它天然是
/// 「谁给谁挂的哪一跳」，而不是一张全局伤害表。
#[derive(Clone)]
pub(super) struct MonsterDot {
    pub caster_id: String,
    pub skill_id: u32,
    pub target_id: String,
    pub map_id: String,
    pub stacks: u32,
    /// 每层每跳的伤害（挂载时按施法者属性 × 目标模板算定，刷新时重算）。
    pub per_tick: i64,
    pub cadence_ticks: u64,
    pub next_tick: u64,
    pub expires_at: u64,
    pub pulse_index: u64,
}

/// 已经发射、正在飞的投射物段。
#[derive(Clone)]
pub(super) struct Projectile {
    pub caster_id: String,
    pub request_id: String,
    pub skill_id: u32,
    pub segment: u32,
    /// 施法时**冻结**的发射点与朝向。投射物不会跟着主人走——这就是「飞行轨迹」。
    pub origin: (f64, f64, i8),
    pub map_id: String,
    pub lightning: bool,
    pub level: MageLevel,
    pub excluded: Option<BTreeSet<String>>,
    pub arrive_at: u64,
    pub expires_at: u64,
    /// 本施法的最后一段：它落地时负责收尾（暴风雪追击 / 二段命中判定）。
    pub finalize: bool,
}

/// 四支柱里需要跨拍存活的两类状态。放在 `World` 上而不是 `Player` 上，
/// 因为「键」里既有施法者也有怪物（DoT 的目标、投射物的落点）。
#[derive(Default)]
pub(super) struct MechanicRegistry {
    dots: BTreeMap<String, MonsterDot>,
    projectiles: BTreeMap<String, Projectile>,
}

impl MechanicRegistry {
    pub(super) fn dot_key(caster_id: &str, skill_id: u32, target_id: &str) -> String {
        format!("{caster_id}|{skill_id}|{target_id}")
    }

    pub(super) fn projectile_key(caster_id: &str, request_id: &str, segment: u32) -> String {
        format!("{caster_id}|{request_id}|{segment}")
    }

    /// 诊断用：当前挂着的 DoT 条数（验收断言用，生产不读）。
    #[cfg(test)]
    pub(super) fn dot_count(&self) -> usize {
        self.dots.len()
    }

    #[cfg(test)]
    pub(super) fn projectile_count(&self) -> usize {
        self.projectiles.len()
    }

    #[cfg(test)]
    pub(super) fn dot(&self, caster_id: &str, skill_id: u32, target_id: &str) -> Option<&MonsterDot> {
        self.dots.get(&Self::dot_key(caster_id, skill_id, target_id))
    }
}

/// 一次「玩家→怪」伤害的提交是否**真的产生了伤害**。
///
/// 刻意不做成结构体：两个调用点要的都只是「这一份提交有没有落地」——
/// 带 `damage` / `killed` 字段的返回类型在本包内没有读取者，那是死重量。
pub(super) type DamageApplied = bool;

impl World {
    /// 共用召唤槽位的**唯一**容量判据。调用方先 `retain` 掉「同技能重放要替换的那一个」，
    /// 再问这里还装不装得下 —— 三个写入点（冰魔 / 冰鋒刃 / 球形闪电）都不许再写字面量。
    pub(super) fn summon_slots_available(player: &Player) -> bool {
        player.summons.len() < SUMMON_BUDGET
    }

    /// 登记一批需要飞行的段。**施法者仍在启动拍的那张图**是唯一约束；
    /// 落地时还会再查一次在场与存活（见 `step_projectiles`）。
    pub(super) fn launch_projectiles(
        &mut self,
        id: &str,
        request_id: &str,
        skill_id: u32,
        level: &MageLevel,
        lightning: bool,
        origin: (f64, f64, i8),
        excluded: Option<&BTreeSet<String>>,
        flying: &[(u32, u64)],
    ) {
        let Some(map_id) = self.players.get(id).map(|player| player.map_id.clone()) else {
            return;
        };
        let ceiling = (PROJECTILE_MAX_FLIGHT_MS / TICK_MS).max(1);
        let last_segment = flying.iter().map(|(segment, _)| *segment).max().unwrap_or(0);
        for (segment, delay_ms) in flying {
            let ticks = (delay_ms.div_ceil(TICK_MS)).max(1);
            let projectile = Projectile {
                caster_id: id.to_owned(),
                request_id: request_id.to_owned(),
                skill_id,
                segment: *segment,
                origin,
                map_id: map_id.clone(),
                lightning,
                level: level.clone(),
                excluded: excluded.cloned(),
                arrive_at: self.tick.saturating_add(ticks),
                expires_at: self.tick.saturating_add(ticks.max(ceiling)),
                finalize: *segment == last_segment,
            };
            self.mechanics.projectiles.insert(
                MechanicRegistry::projectile_key(id, request_id, *segment),
                projectile,
            );
        }
    }

    /// 支柱③落地：到期段重新做**碰撞判定**并按段结算。
    pub(super) fn step_projectiles(&mut self) {
        let due: Vec<String> = self
            .mechanics
            .projectiles
            .iter()
            .filter(|(_, projectile)| projectile.arrive_at <= self.tick)
            .map(|(key, _)| key.clone())
            .collect();
        for key in due {
            let Some(projectile) = self.mechanics.projectiles.remove(&key) else {
                continue;
            };
            // 施法者不在场（掉线 / 换图 / 死亡）⇒ 静默丢弃：不补发、不报错。
            // 与召唤物「到期/换图即收」是同一条在场判据。
            let airborne = self
                .players
                .get(&projectile.caster_id)
                .is_some_and(|player| {
                    player.state.action != "dead"
                        && player.state.hp > 0
                        && player.map_id == projectile.map_id
                });
            if !airborne || projectile.expires_at <= self.tick {
                continue;
            }
            let result = self.settle_area_segments(
                &projectile.caster_id,
                &projectile.request_id,
                projectile.skill_id,
                &projectile.level,
                projectile.lightning,
                Some(projectile.origin),
                projectile.excluded.as_ref(),
                &[projectile.segment],
                projectile.finalize,
            );
            if let Err(error) = result {
                self.handle_accepted_effect_error(
                    &projectile.caster_id,
                    &projectile.request_id,
                    &error,
                );
            }
        }
    }

    /// 支柱②挂载：首段真实命中之后按 `prop` 掷骰，命中则挂载或刷新。
    ///
    /// 刷新规则（三条，缺一条都会让节奏变味）：
    /// ① 时长**取长者**（不缩短已经挂上的 DoT）；
    /// ② 层数 +1、封顶 [`DOT_MAX_STACKS`]，每跳伤害按层数线性放大；
    /// ③ **不重置 `next_tick`**——连续点射不会把跳伤推后。
    pub(super) fn apply_dot_hit(
        &mut self,
        caster_id: &str,
        request_id: &str,
        skill_id: u32,
        target_id: &str,
        plan: &DotPlan,
        per_tick: i64,
    ) {
        if plan.prop == 0
            || deterministic_percent(&[caster_id, request_id, target_id, "dot-apply"]) >= plan.prop as u64
        {
            return;
        }
        let Some(map_id) = self.monsters.get(target_id).map(|monster| monster.map_id.clone()) else {
            return;
        };
        let key = MechanicRegistry::dot_key(caster_id, skill_id, target_id);
        let expiry = self
            .tick
            .saturating_add(plan.duration_ticks.max(1));
        if let Some(existing) = self.mechanics.dots.get_mut(&key) {
            existing.stacks = existing.stacks.saturating_add(1).min(DOT_MAX_STACKS);
            existing.expires_at = existing.expires_at.max(expiry);
            existing.per_tick = per_tick;
            return;
        }
        self.mechanics.dots.insert(
            key,
            MonsterDot {
                caster_id: caster_id.to_owned(),
                skill_id,
                target_id: target_id.to_owned(),
                map_id,
                stacks: 1,
                per_tick,
                cadence_ticks: plan.cadence_ticks.max(1),
                // 首次跳伤落在**下一拍**（与 `player_status::apply_disease` 同口径：
                // 不是「等一个间隔再开始」）。
                next_tick: self.tick.saturating_add(1),
                expires_at: expiry,
                pulse_index: 0,
            },
        );
    }

    /// 支柱②滴答：非即时链里最后结算的一层。
    pub(super) fn step_monster_dots(&mut self) {
        // 在场判据先收敛一次：不满足的直接拆掉，后面的循环只处理「该跳的」。
        let live_casters: BTreeSet<String> = self
            .players
            .iter()
            .filter(|(_, player)| player.state.hp > 0 && player.state.action != "dead")
            .map(|(id, _)| id.clone())
            .collect();
        let keys: Vec<String> = self.mechanics.dots.keys().cloned().collect();
        for key in keys {
            let Some(dot) = self.mechanics.dots.get(&key).cloned() else {
                continue;
            };
            let caster_present = live_casters.contains(&dot.caster_id);
            let target_alive = self.monsters.get(&dot.target_id).is_some_and(|monster| {
                monster.state.hp > 0 && monster.map_id == dot.map_id
            });
            if !caster_present || !target_alive || dot.expires_at <= self.tick {
                self.mechanics.dots.remove(&key);
                continue;
            }
            if dot.next_tick > self.tick {
                continue;
            }
            let damage = dot.per_tick.saturating_mul(i64::from(dot.stacks));
            let pulse = dot.pulse_index;
            let request_id = format!(
                "dot-{}-{}-{}-{pulse}",
                dot.caster_id, dot.skill_id, dot.target_id
            );
            if let Err(error) = self.commit_player_damage(
                &dot.caster_id,
                &request_id,
                dot.skill_id,
                &dot.target_id,
                damage,
                1,
                1,
                // 击退：DoT 刻意**不推怪**（理由见模块头）。
                false,
                serde_json::json!({ "dot": true, "dotStacks": dot.stacks, "dotPulse": pulse }),
            ) {
                self.handle_accepted_effect_error(&dot.caster_id, &request_id, &error);
                // 一个失败不是「重来」的理由：仍推进节奏，避免同一跳每拍重试。
            }
            if let Some(dot) = self.mechanics.dots.get_mut(&key) {
                dot.next_tick = self.tick.saturating_add(dot.cadence_ticks.max(1));
                dot.pulse_index = dot.pulse_index.saturating_add(1);
            }
        }
    }

    /// 支柱④二段命中：用 `lt2/rb2` 独立重选目标，再走一遍伤害管线。
    ///
    /// 与首段的区别只有两条，且都来自源：**目标集不同**（第二盒比主盒窄）、
    /// **倍率是 `damPlus`**（不是主 `damage`）。暴击与冰冻层一律不参与——
    /// 它不是一次新的「命中瞬间」，而是首段链的追加分配。
    pub(super) fn settle_second_hit(
        &mut self,
        id: &str,
        request_id: &str,
        skill_id: u32,
        plan: &SecondHitPlan,
        damage_basis: &SecondHitBasis,
    ) -> Result<bool, String> {
        if plan.prop == 0
            || deterministic_percent(&[id, request_id, "second-hit"]) >= plan.prop as u64
        {
            return Ok(false);
        }
        let mut box_level = damage_basis.level.clone();
        box_level.lt = Some(plan.lt);
        box_level.rb = Some(plan.rb);
        let (origin_x, origin_y, facing) = damage_basis.origin;
        let targets = self.area_targets_at(id, &box_level, origin_x, origin_y, facing);
        if targets.is_empty() {
            return Ok(false);
        }
        let mut landed = false;
        for target_id in targets {
            if self
                .monsters
                .get(&target_id)
                .is_none_or(|monster| monster.state.hp <= 0)
            {
                continue;
            }
            let Some(target_template) = self
                .monsters
                .get(&target_id)
                .map(|monster| monster.template.clone())
            else {
                continue;
            };
            let damage = match &damage_basis.basis {
                DamageBasis::Physical {
                    attributes,
                    player_level,
                } => {
                    let base = attributes.attack_damage_against(*player_level, &target_template);
                    ((base as f64) * plan.damage_percent as f64 / 100.0).floor().max(1.0) as i64
                }
                DamageBasis::Magic { magic_attack } => {
                    ((*magic_attack as f64) * plan.damage_percent as f64 / 100.0)
                        .floor()
                        .max(1.0) as i64
                }
            };
            let request = format!("{request_id}:second");
            // 二段的区域系数跟**伤害种类**走（物理取 `false`），与首段同一条口径：
            // 写成 `true` 会让二段去吃魔法护盾、同时无视物理护盾——两个方向都错。
            let damage = match &damage_basis.basis {
                DamageBasis::Physical { .. } => {
                    let map_id = self
                        .monsters
                        .get(&target_id)
                        .map(|monster| monster.map_id.clone())
                        .unwrap_or_default();
                    let mut pipeline = DamagePipeline::new(damage);
                    pipeline.add(
                        DamageSource::RegionGuard,
                        self.boss_damage_multiplier(&map_id, false) - 100,
                    );
                    pipeline.resolve().total()
                }
                DamageBasis::Magic { .. } => damage,
            };
            if self
                .commit_player_damage(
                    id,
                    &request,
                    skill_id,
                    &target_id,
                    damage,
                    2,
                    2,
                    true,
                    serde_json::json!({ "secondHit": true }),
                )? {
                    landed = true;
                }
        }
        Ok(landed)
    }

    /// 「玩家→怪」伤害的**统一提交点**（除既有直接命中循环之外的第二个提交者）。
    ///
    /// 认领 → 结算 → 落血量 → 播报 → 经验/档案 → 掉落 → 任务计数，与施法链里的那一段
    /// 同序同口径；`action_request` 沿用同一形状 `{请求}:s{段}:t{目标}`，
    /// 所以两类伤害的幂等键不会互相顶掉。
    /// 返回 `Ok(false)` 表示这次提交没有产生新伤害（目标已死 / 已认领过 / 被拒）。
    #[allow(clippy::too_many_arguments)]
    pub(super) fn commit_player_damage(
        &mut self,
        attacker_id: &str,
        request_id: &str,
        skill_id: u32,
        target_id: &str,
        damage: i64,
        segment: u32,
        total_segments: u32,
        knockback: bool,
        extra_event: serde_json::Value,
    ) -> Result<DamageApplied, String> {
        let Some((target_hp, target_max_hp, target_template, target_x, target_y, map_id, quests)) =
            self.monsters.get(target_id).map(|monster| {
                (
                    monster.state.hp,
                    monster.state.max_hp,
                    monster.template.clone(),
                    monster.state.x,
                    monster.state.y,
                    monster.map_id.clone(),
                    self.players
                        .get(attacker_id)
                        .map(|player| player.quests.clone())
                        .unwrap_or_default(),
                )
            })
        else {
            return Ok(false);
        };
        if target_hp <= 0 {
            return Ok(false);
        }
        let killed = damage >= target_hp;
        let applied_damage = damage.min(target_hp.max(0));
        let practice = auth::is_practice_map(&map_id);
        let drops = if killed && !practice {
            self.choose_drops(&target_template, target_x, target_y, attacker_id, &quests)
        } else {
            Vec::new()
        };
        let quest_kills = if killed && !practice {
            self.active_kill_objectives(attacker_id, &target_template.template_id)
        } else {
            Vec::new()
        };
        let action_request = format!("{request_id}:s{segment}:t{target_id}");
        let action_id = format!("skill-{request_id}-{segment}-{target_id}");
        let resolution = if let Some(store) = self.store.as_ref() {
            let claim = store.claim_attack(attacker_id, &map_id, &action_request, &action_id, "skill")?;
            if claim.resolved {
                return Ok(false);
            }
            store.resolve_attack_with_party(
                attacker_id,
                &map_id,
                &action_request,
                Some(target_id),
                applied_damage,
                killed,
                target_template.exp,
                target_max_hp,
                &drops,
                &self.gameplay.exp_table,
                &self.players.keys().cloned().collect::<Vec<_>>(),
                &self.party_exp_members(attacker_id),
                &quest_kills,
            )?
        } else {
            auth::AttackResolution {
                already_resolved: false,
                target_id: Some(target_id.to_owned()),
                damage: applied_damage,
                killed,
                exp_gain: if killed && !practice {
                    target_template.exp
                } else {
                    0
                },
                drop: drops.first().cloned(),
                drops,
                profile: None,
                profiles: Vec::new(),
            }
        };
        if resolution.already_resolved {
            return Ok(false);
        }
        let attacker_x = self.players.get(attacker_id).map(|player| player.state.x);
        if let Some(monster) = self.monsters.get_mut(target_id) {
            monster.state.hp = (monster.state.hp - resolution.damage).max(0);
            if knockback {
                register_monster_knockback(monster, resolution.damage, attacker_x);
            }
            monster.state.action = if monster.state.hp == 0 { "die" } else { "hit" };
            monster.state.action_started_tick = self.tick;
            if monster.state.hp == 0 {
                monster.freeze_until = 0;
                monster.state.freeze_stacks = None;
                monster.stun_until = 0;
                monster.death_until = Some(
                    self.tick
                        + monster
                            .template
                            .die_duration_ms
                            .unwrap_or(1)
                            .div_ceil(TICK_MS)
                            .max(1),
                );
                monster.respawn_at = respawn_deadline(
                    self.tick,
                    self.gameplay.monster_respawn_ms,
                    monster.spawn.mob_time,
                );
            }
        }
        if resolution.damage > 0 {
            let mut event = serde_json::json!({
                "type": "damageEvent",
                "eventId": format!("damage-event-{attacker_id}-{request_id}-{segment}-{target_id}"),
                "serverTick": self.tick,
                "attackerId": attacker_id,
                "targetId": target_id,
                "x": target_x,
                "y": target_y,
                "damage": resolution.damage,
                "killed": resolution.killed,
                "skillId": skill_id,
                "segment": segment,
                "targetCount": total_segments,
                "critical": false,
            });
            if let Some(extra) = extra_event.as_object() {
                for (key, value) in extra {
                    event[key] = value.clone();
                }
            }
            self.broadcast_to_map(&map_id, &event.to_string());
        }
        if !resolution.profiles.is_empty() {
            for (participant, profile) in resolution.profiles {
                if let Some(player) = self.players.get_mut(&participant) {
                    apply_profile_to_player(&self.gameplay, &self.mage_skills, player, profile);
                }
            }
        } else if let Some(profile) = resolution.profile {
            if let Some(player) = self.players.get_mut(attacker_id) {
                apply_profile_to_player(&self.gameplay, &self.mage_skills, player, profile);
            }
        } else if resolution.exp_gain > 0 && self.store.is_none() {
            if let Some(player) = self.players.get_mut(attacker_id) {
                Self::add_exp(
                    &mut player.state,
                    resolution.exp_gain,
                    &self.gameplay.exp_table,
                );
                refresh_player_derived(&self.gameplay, &self.mage_skills, player);
            }
        }
        for drop in resolution.drops {
            let drop_id = drop.id.clone();
            self.drops.insert(
                drop_id.clone(),
                DropState {
                    id: drop.id.clone(),
                    item_id: drop.item_id.clone(),
                    quantity: drop.quantity,
                    x: drop.x,
                    y: drop.y,
                },
            );
            self.drop_instances
                .insert(drop_id.clone(), DropInstance::from_record(&drop));
            self.drop_owners
                .insert(drop_id.clone(), (drop.owner_id, drop.protected_until_ms));
            self.drop_maps.insert(drop_id, map_id.clone());
        }
        if resolution.killed {
            self.apply_quest_kill_credit(attacker_id, &quest_kills);
        }
        Ok(true)
    }
}

/// 二段命中的伤害基准：与首段**同一份**属性快照，不是重新聚合一遍。
/// 重新聚合会在两段之间塞进一次属性变更（升级、增益到期），让「同一次攻击的两段」
/// 用两个不同的面板值。
pub(super) enum DamageBasis {
    Physical {
        attributes: PlayerAttributes,
        player_level: u32,
    },
    Magic {
        magic_attack: i64,
    },
}

/// 二段命中的入参：目标盒所在的坐标系 + 伤害基准。
pub(super) struct SecondHitBasis {
    pub origin: (f64, f64, i8),
    pub level: MageLevel,
    pub basis: DamageBasis,
}
