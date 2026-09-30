//! 神聖之水 `2321015`（主教四转，2026-09-24 接执行链）的**纯规则**。
//!
//! 这个模块只回答数值问题，不持有 `World`／`Store`／连接、不产生副作用——
//! 与 `pickup_rules.rs`、`quest_rules.rs` 同一条口径。实体状态与副作用在
//! [`crate::world`] 里（`spawn_holy_waters` / `step_holy_waters` /
//! `handle_holy_water_absorb`），本模块**有意不使用** `use super::*`，所有依赖
//! 显式列出，将来谁把 `World` 引进来的改动都会在 review 里一眼可见。
//!
//! # 权威源
//!
//! `shared/mage-skills.json#2321015`（权威是 `WZ_JSON_TW/Skill/232.json#skill.2321015`
//! 与 `String/Skill.img` 的文案，`references/tms273-data/holy-fourth-job-source.json`
//! 只是二手参考——它连 `lt`/`rb` 都整类丢成 `{}`，见 `world.rs::SKILL_HOLY_WATER`）。
//!
//! `description`：
//! > `#c[慈愛]#` 每當天使之箭命中敵人時，皆可獲得能淨化敵人血液的聖水。使用技能時，
//! > 將在周圍召喚盛滿聖水的聖杯。隊員對聖杯按下「上」方向鍵時，可吸收聖水並恢復HP。
//!
//! `perLevelDescription`：
//! > `#c被動效果#`：天使之箭命中 `#u` 次時可獲得 1 瓶聖水，聖水最多可累積 `#w` 瓶
//! > `#c主動效果#`：消耗MP`#mpCon`，消耗所有累積的聖水(聖水最少需有1瓶)並在周圍形成聖水。
//! > 若空間不足則僅形成部分聖水
//! > 聖水持續時間:`#q`秒，智力每累積`#s2`個，聖水持續時間增加`#q2`秒
//! > 隊員在聖水按[上]方向鍵時，可恢復最大HP的`#u2`%，每`#dot`個智力，恢復量增加`#w2`%。恢復量可疊加
//! > 有剩餘持續時間但是聖水消滅時，獲得相當於消失的聖水個數的`#v2`%
//! > 冷卻時間：`#cooltime`秒
//!
//! # 逐字段消费表（源字段 → 本包的读点）
//!
//! | 源字段 | 值 | 本包读点 |
//! |---|---|---|
//! | `u` | 7 | [`HolyWaterRules::hits_per_bottle`]：天使之箭命中 7 次得 1 瓶 |
//! | `w` | 5 | [`HolyWaterRules::charges_cap`]：最多累积 5 瓶 |
//! | `q` / `s2` / `q2` | 5 / 2500 / 5 | [`HolyWaterRules::lifetime_ms`] |
//! | `u2` / `dot` / `w2` | 5 / 2500 / 5 | [`HolyWaterRules::heal_permille`] |
//! | `v2` | 50 | [`HolyWaterRules::burst_permille`]：非到期清除时每个的补偿 |
//! | `lt` / `rb` | (-40,-100) / (40,20) | [`HolyWaterRules::placement_box`]：**生成位置**的框 |
//! | `mpCon` | 100 | 既有 MP 管道（`skills.rs`） |
//! | `cooltime` | 10 | 既有四转书冷却分支（`skills.rs`，源里是**秒**） |
//! | `range` | 200 | **不消费**：它是「召喚範圍」的半径，而本包的位置判据已经由 `lt`/`rb` 框决定（见下）。 |
//!
//! # 两条必须写下来的裁决
//!
//! 1. **`lt`/`rb` 是「圣杯生成在哪」的框**，不是「谁能吸收」的框。源把交互写成
//!    「隊員對聖杯按下「上」方向鍵」——交互条件是**玩家自己站在圣杯旁按上键**，
//!    由客户端选最近的圣杯、服务端只做距离校验（与 `portals.rs` / reactor 同一条口径）。
//!    框在这个技能里唯一的用处就是「消耗所有累積的聖水並在周圍形成聖水」的**周围**。
//! 2. **「若空間不足則僅形成部分聖水」的判据是 foothold**：候选位置落在框内逐点取，
//!    只有脚下真有地面（`Map::ground_below` 命中）的位置才能站住一个圣杯，取不到的
//!    位置**不生成**——这正是源里那句「僅形成部分聖水」。这条判据让「空间不足」可测：
//!    在平台边缘施放时，悬空的那几个候选位置会自动落空。
//!
//! # 用户裁决（2026-09-24，本轮）
//!
//! - 谁能吸收＝**同队队员，含施法者自己**（源只写「隊員」，施法者自己通常也在队里）；
//! - 空间不足＝**按源框在 foothold 上逐点找位**（见上）；
//! - `v2` 那半**按最可能语义实现**：源文案的宾语缺失（没说恢复 HP 还是 MP 还是伤害），
//!   本包按**最大 HP 的 `v2`%** 读，结算给**施法者**，触发条件是**圣水在仍有剩余时长时被清除**
//!   （见 [`HolyWaterRules::burst_permille`] 与 `world.rs::step_holy_waters` 的两条清除点）；
//! - 圣水累积瓶数**落库持久化**（`player_stats.holy_water_charges` / `holy_water_hits`）。

use crate::mage::MageLevel;

/// 神聖之水 `2321015` 的运行期规则。全部字段都从源 `MageLevel` **派生**，
/// 不写死任何一个数值——源里的 `u`/`w`/`q`/`s2`/`q2`/`u2`/`dot`/`w2`/`v2` 改了值，
/// 这里跟着变，门禁也从源独立重算这几个数。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct HolyWaterRules {
    hits_per_bottle: u32,
    charges_cap: u32,
    base_lifetime_ms: u64,
    intelligence_per_lifetime_step: i64,
    lifetime_step_ms: u64,
    base_heal_permille: i64,
    intelligence_per_heal_step: i64,
    heal_step_permille: i64,
    burst_permille: i64,
}

impl HolyWaterRules {
    /// 从源等级行派生。**缺字段就返回 `None`**，不替源补默认值：
    /// 缺 `u` 就不知道几命中给一瓶，缺 `v2` 就不知道补偿多少，两种都必须
    /// 走「未接执行链」那条路，而不是凭一个兜底数字跑起来。
    pub(super) fn from_level(level: &MageLevel) -> Option<Self> {
        let positive = |value: Option<i64>| -> Option<u64> {
            u64::try_from(value?.max(0)).ok()
        };
        let hits_per_bottle = u32::try_from(level.u?.max(1)).ok()?;
        let charges_cap = u32::try_from(level.w?.max(1)).ok()?;
        Some(Self {
            hits_per_bottle,
            charges_cap,
            base_lifetime_ms: positive(level.q)?.saturating_mul(1_000),
            intelligence_per_lifetime_step: level.s2?,
            lifetime_step_ms: positive(level.q2)?.saturating_mul(1_000),
            base_heal_permille: level.u2?.max(0).saturating_mul(10),
            intelligence_per_heal_step: level.dot?,
            heal_step_permille: level.w2?.max(0).saturating_mul(10),
            burst_permille: level.v2?.max(0).saturating_mul(10),
        })
    }

    /// 天使之箭每命中这么多次，累积 1 瓶聖水（源 `u`，7）。
    pub(super) fn hits_per_bottle(self) -> u32 {
        self.hits_per_bottle
    }

    /// 最多累积多少瓶（源 `w`，5）。**到顶之后命中不再累积**——源写的是
    /// 「聖水最多可累積 `#w` 瓶」，到顶还继续攒的话，下一次施法放空之后会立刻
    /// 从「攒着的命中数」里补回几瓶，那不是源的意思。
    pub(super) fn charges_cap(self) -> u32 {
        self.charges_cap
    }

    /// 一瓶聖水的存活时长（毫秒）。源：「聖水持續時間:`#q`秒，智力每累積`#s2`個，
    /// 聖水持續時間增加`#q2`秒」⇒ 基础 `q` 秒，再按**整档**智力加 `q2` 秒。
    /// 智力非正时 `s2` 的除法会炸，所以先夹到正数。
    pub(super) fn lifetime_ms(self, intelligence: i64) -> u64 {
        let steps = self.lifetime_steps(intelligence);
        self.base_lifetime_ms
            .saturating_add(self.lifetime_step_ms.saturating_mul(steps))
    }

    /// 圣杯**生成位置**的框（源 `lt`/`rb`，以施法者为原点）。缺一即 `None`，
    /// **不替源补默认框**——补一个默认框会让「源里没有框」和「框是一片空」变成同一件事。
    pub(super) fn placement_box(level: &MageLevel) -> Option<((f64, f64), (f64, f64))> {
        let lt = level.lt.as_ref()?;
        let rb = level.rb.as_ref()?;
        Some(((lt.x, lt.y), (rb.x, rb.y)))
    }

    /// 吸收一次恢复最大 HP 的千分比（源 `u2`% ＋ 每 `dot` 智力再加 `w2`%）。
    /// 「恢復量可疊加」由调用方按吸收次数逐次结算实现，不在本函数里。
    pub(super) fn heal_permille(self, intelligence: i64) -> i64 {
        let steps = self.heal_steps(intelligence);
        self.base_heal_permille
            .saturating_add(self.heal_step_permille.saturating_mul(steps))
    }

    /// 聖水在**仍有剩余持续时间**时被清除，每个按最大 HP 的这么多千分比补偿（源 `v2`，50）。
    pub(super) fn burst_permille(self) -> i64 {
        self.burst_permille
    }

    fn lifetime_steps(self, intelligence: i64) -> u64 {
        if self.intelligence_per_lifetime_step <= 0 || intelligence <= 0 {
            return 0;
        }
        u64::try_from(intelligence / self.intelligence_per_lifetime_step).unwrap_or(0)
    }

    fn heal_steps(self, intelligence: i64) -> i64 {
        if self.intelligence_per_heal_step <= 0 || intelligence <= 0 {
            return 0;
        }
        intelligence / self.intelligence_per_heal_step
    }
}

/// 一个摆在地面上的聖杯。**会话态**：它是「此刻这张图上摆着几只杯子」这一事实，
/// 重启即失（与 reactor 的实时状态同一条口径）。源没有给它任何跨登录的语义。
#[derive(Clone, Debug, PartialEq)]
pub(super) struct HolyWater {
    pub(super) id: String,
    /// 施法者。`v2` 那半结算给他，**且只有他**能触发「非到期清除」。
    pub(super) owner_id: String,
    pub(super) map_id: String,
    /// 与 `ReactorPlacement.x/y` 同一套世界坐标（脚底）。
    pub(super) x: f64,
    pub(super) y: f64,
    /// 到期拍。到这一拍（含）自然消失，**不算「消灭」**——源那句 `v2` 的前提是
    /// 「有剩餘持續時間但是聖水消滅時」，自然到期不在其中。
    pub(super) expires_at: u64,
    /// 吸收这只杯子一次恢复最大 HP 的千分比（源 `u2`/`dot`/`w2`）。
    ///
    /// **在施放那一刻按施法者智力算定并随杯子存下来**，不是吸收时现算：
    /// ① 那句文案里的「智力」读的是施法者的（理由见 `world.rs::SKILL_HOLY_WATER`）；
    /// ② 存下来之后整批杯子同值，吸收量不会因为施法者中途换装备而在半途跳变。
    pub(super) heal_permille: i64,
    /// 这只杯子在**非到期被清除**时给施法者补的最大 HP 千分比（源 `v2`）。
    /// 同样在施放那一刻算定——`v2` 是「这只杯子活着的那段时间里的技能数值」。
    pub(super) burst_permille: i64,
}

impl HolyWater {
    /// 这一拍它是否还有剩余持续时间。`v2` 的结算条件就是它。
    pub(super) fn has_remaining_time(&self, tick: u64) -> bool {
        tick < self.expires_at
    }
}

/// 把「命中次数累计」推进一格：返回 `(新的命中余数, 新的瓶数)`。
///
/// `pending` 是「还没凑成一瓶的命中数」（0..`hits_per_bottle`），`charges` 是已有瓶数。
/// 瓶数到顶时**整条被动停摆**（不推进余数），理由见 [`HolyWaterRules::charges_cap`]。
pub(super) fn advance_charge(rules: HolyWaterRules, pending: u32, charges: u32) -> (u32, u32) {
    if charges >= rules.charges_cap() {
        return (pending, charges);
    }
    let next = pending.saturating_add(1);
    if next < rules.hits_per_bottle() {
        return (next, charges);
    }
    (0, charges.saturating_add(1))
}

/// 框内按 `count` 个位置**逐点**给出候选点（施法者局部坐标，x 从左到右）。
///
/// 取点规则：把 `count` 个位置均匀铺在框的 x 跨度上，y 一律取框底（聖杯是站着的，
/// 源 `rb.y = 20` 比角色脚底高 20px，那是"杯底贴着脚下这一点点上方"）。框宽小于
/// 需要的位置数时按 `count` 等分，允许重合——源没有写最小间距。
pub(super) fn candidate_offsets(
    lo: (f64, f64),
    hi: (f64, f64),
    count: u32,
    facing: i8,
) -> Vec<(f64, f64)> {
    if count == 0 {
        return Vec::new();
    }
    let (x0, x1) = if lo.0 <= hi.0 { (lo.0, hi.0) } else { (hi.0, lo.0) };
    let y = hi.1;
    // 源框与猎人的命中盒一样是**朝右书写**的，朝左时整框镜像（与 `area_targets_at` 同一口径）。
    let mirror = if facing < 0 { -1.0 } else { 1.0 };
    if count == 1 {
        return vec![(mirror * (x0 + x1) / 2.0, y)];
    }
    let step = (x1 - x0) / f64::from(count - 1);
    (0..count)
        .map(|index| {
            let x = x0 + step * f64::from(index);
            (mirror * x, y)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules() -> HolyWaterRules {
        HolyWaterRules {
            hits_per_bottle: 7,
            charges_cap: 5,
            base_lifetime_ms: 5_000,
            intelligence_per_lifetime_step: 2_500,
            lifetime_step_ms: 5_000,
            base_heal_permille: 50,
            intelligence_per_heal_step: 2_500,
            heal_step_permille: 50,
            burst_permille: 500,
        }
    }

    #[test]
    fn charge_accumulates_on_the_source_period_and_saturates_at_the_cap() {
        let mut pending = 0;
        let mut charges = 0;
        for _ in 0..6 {
            (pending, charges) = advance_charge(rules(), pending, charges);
        }
        assert_eq!((pending, charges), (6, 0), "第六次命中还差一次才成一瓶");
        (pending, charges) = advance_charge(rules(), pending, charges);
        assert_eq!((pending, charges), (0, 1), "第七次命中成一瓶，余数归零");
        // 攒满之后**余数不再动**：否则放空一次就会立刻回补。
        let (pending, charges) = (3, rules().charges_cap());
        assert_eq!(advance_charge(rules(), pending, charges), (3, 5));
    }

    #[test]
    fn lifetime_and_heal_step_on_whole_intelligence_brackets() {
        // 每满 `s2`(=2500) 一档、加 `q2`(=5s)：档数是**整除**得到的，差一点就少一档。
        assert_eq!(rules().lifetime_ms(0), 5_000);
        assert_eq!(rules().lifetime_ms(2_499), 5_000, "不满一档不加");
        assert_eq!(rules().lifetime_ms(2_500), 10_000, "刚好满第 1 档");
        assert_eq!(rules().lifetime_ms(7_499), 15_000, "整档按整除算：差 1 点就少一档");
        assert_eq!(rules().lifetime_ms(7_500), 20_000, "刚好满第 3 档");
        // 恢复量同一条整除口径：`u2`(=50‰) 起，每满 `dot`(=2500) 加 `w2`(=50‰)。
        assert_eq!(rules().heal_permille(0), 50);
        assert_eq!(rules().heal_permille(2_499), 50);
        assert_eq!(rules().heal_permille(2_500), 100, "刚好满第 1 档");
        assert_eq!(rules().heal_permille(7_499), 150);
        assert_eq!(rules().heal_permille(7_500), 200, "刚好满第 3 档");
    }

    #[test]
    fn negative_intelligence_never_panics_and_never_steps() {
        assert_eq!(rules().lifetime_ms(-9_999), 5_000);
        assert_eq!(rules().heal_permille(-9_999), 50);
    }

    #[test]
    fn candidates_spread_across_the_box_and_mirror_when_facing_left() {
        let lo = (-40.0, -100.0);
        let hi = (40.0, 20.0);
        let right = candidate_offsets(lo, hi, 5, 1);
        assert_eq!(right.len(), 5);
        assert_eq!(right[0], (-40.0, 20.0));
        assert_eq!(right[4], (40.0, 20.0));
        assert_eq!(right[2], (0.0, 20.0));
        let left = candidate_offsets(lo, hi, 5, -1);
        assert_eq!(left[0], (40.0, 20.0), "朝左时整框镜像");
        assert_eq!(candidate_offsets(lo, hi, 1, 1), vec![(0.0, 20.0)]);
        assert!(candidate_offsets(lo, hi, 0, 1).is_empty());
    }
}
