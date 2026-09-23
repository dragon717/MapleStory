//! 玩家限时状态（技能增益 / 怪物疾病 / 异常状态免疫窗）的唯一权威。
//!
//! ## 为什么要收成一个模块
//!
//! 改前这批状态散在 `Player` 的八个裸字段上，并且**同一件事有两套表示**：
//! `skill_buffs` 存「剩余毫秒」并逐 tick 相减，而五个疾病与免疫窗存「世界 tick 截止点」。
//! 由此长出三套「是否生效」判据（`contains_key` / `remaining > 0` / `until > tick`），
//! 到期清理又按**写死的技能名单**逐条手写在 `world.rs` 的 tick 块里——名单漏一个，
//! 那个增益就永远停在 0，而用 `contains_key` 读它的一侧仍判它生效。
//!
//! 本模块把这批状态收成一处，五条纪律：
//!
//! 1. **一律用世界 tick 截止点表示**（`until`）。剩余毫秒是投影，不再逐 tick 相减，
//!    既不会漂移，也和疾病的表示统一。截止点公式与改前的相减语义逐拍等价：
//!    改前在 `t` 施加 `d` 毫秒的增益，会在 `t + ceil(d / TICK_MS)` 那拍被判为 0 并移除；
//!    现在 `until = t + ceil(d / TICK_MS)`，`until <= now` 即失效，同一拍。
//! 2. **本状态自带唯一时钟**（`now`）。它只由 `advance()` 与各 `apply_*` 两个入口盖章，
//!    读取侧不传 tick ⇒ 不可能有人拿一个过期的 tick 去读，也不可能两处读出不同的剩余。
//! 3. **「是否生效」只有 `*_active` 一族入口**。`contains_key` 一律不得再用作生效判据。
//! 4. **到期只由 `advance()` 判定**，返回穷尽的 [`Expiry`]。增益的附属状态由效果自带的
//!    [`Release`] 表达，`world.rs` 侧的清理 `match` 到全部变体——新增一种带附属状态的增益
//!    而不写清理，**编译不过**，不再是「名单漏一个就静默泄漏」。
//! 5. **死亡 / 换图 / 重连只有一个清理点**（[`PlayerStatus::clear`]）。
//!
//! ## 对外的形状没有变
//!
//! `derivedStats.skillBuffs`（技能 id → 剩余毫秒）与玩家行上的 `abnormalStatus`（五个疾病各自
//! 剩余毫秒）都由本模块投影出来，字段名、取值口径、`None` 语义与改前逐字相同，因此
//! **协议 24 未变、客户端零改动**。
//!
//! ## 怪物技能 id 的处置是数据，不是注释
//!
//! 改前 `world.rs` 顶部用一段注释列出 `MapleDisease` 的 id 表，然后说「只接子集」；
//! 从代码里查不出「哪些 id 真的会被放出来」「没接的那几个为什么没接」。现在它们是
//! [`mob_skill_effect`] 的表，并由 `scripts/check_tms273_player_status.cjs` 对着真实
//! `shared/gameplay.json` 逐 id 重算：内容里出现的 id 必须在表里有结论，表里声明
//! 「已建模」的 id 必须真的在内容里出现过（名单过期要失败）。

use super::*;
use crate::protocol::AbnormalStatus;

/// 中毒 / 詛咒的伤害脉冲间隔。两者共用同一节拍。
pub(super) const DISEASE_DOT_CADENCE_MS: u64 = 1_000;

/// 怪物施加给玩家的异常状态。枚举序即 `advance()` 的返回序与快照的字段序。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum Disease {
    Seal,
    Stun,
    Curse,
    Poison,
    Slow,
}

impl Disease {
    /// 全部变体，顺序固定。`advance()` / 快照 / 清理都按它遍历，保证确定性。
    pub(super) const ALL: [Disease; 5] = [
        Disease::Seal,
        Disease::Stun,
        Disease::Curse,
        Disease::Poison,
        Disease::Slow,
    ];

    /// 快照与诊断串里的键名（`abnormalStatus` 的字段名由 `AbnormalStatus` 自己决定，
    /// 这一份只给诊断、日志与门禁使用）。
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Disease::Seal => "seal",
            Disease::Stun => "stun",
            Disease::Curse => "curse",
            Disease::Poison => "poison",
            Disease::Slow => "slow",
        }
    }

    /// 疾病 → 源 MobSkill id。**这是两个方向唯一的定义处**：反查由它派生，
    /// 所以不可能出现「正向表说 120 是 Seal、反向表说 120 是 Curse」。
    pub(super) fn mob_skill_id(self) -> u32 {
        match self {
            Disease::Seal => MOB_SKILL_SEAL,
            Disease::Stun => MOB_SKILL_STUN,
            Disease::Curse => MOB_SKILL_CURSE,
            Disease::Poison => MOB_SKILL_POISON,
            Disease::Slow => MOB_SKILL_SLOW,
        }
    }

    /// 源 MobSkill id → 本仓库建模的疾病。由 [`Disease::mob_skill_id`] 单向派生
    /// （新增一种疾病只改上面那一处），并保证返回 `None` 的含义是「本仓库没把它
    /// 建模成疾病」，而不是「忘了写进反向表」。
    pub(super) fn from_mob_skill_id(id: u32) -> Option<Self> {
        Disease::ALL
            .into_iter()
            .find(|disease| disease.mob_skill_id() == id)
    }

    /// 该疾病在服务端会真的做什么。只用于登记与门禁，不参与判定。
    pub(super) fn runtime_effect(self) -> DiseaseEffect {
        match self {
            Disease::Seal => DiseaseEffect::BlocksSkillCast,
            Disease::Stun => DiseaseEffect::LocksControls,
            Disease::Curse | Disease::Poison => DiseaseEffect::PeriodicDrain,
            Disease::Slow => DiseaseEffect::ScalesWalkSpeed,
        }
    }

    /// 只有会做周期伤害的疾病需要脉冲节拍。
    pub(super) fn dot_cadence_ms(self) -> Option<u64> {
        match self.runtime_effect() {
            DiseaseEffect::PeriodicDrain => Some(DISEASE_DOT_CADENCE_MS),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum DiseaseEffect {
    BlocksSkillCast,
    LocksControls,
    PeriodicDrain,
    ScalesWalkSpeed,
}

/// 源 MobSkill id 的处置。改前这段知识只以注释形式存在，无法被检查。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SkillEffect {
    /// 本仓库已建模的玩家疾病。
    Disease(Disease),
    /// 源 id 属于 `MapleDisease` 表，但本仓库没有建模。字符串是原因与下一步。
    Unmodelled(&'static str),
    /// 源 id 不属于 `MapleDisease`（怪物自身的增益 / 召唤 / 治疗），不是玩家疾病。
    NotADisease,
}

/// 源 MobSkill id → 处置。
///
/// `MapleDisease` 的 id 表是跨区实现共有的结构（R 参考，非 TMS273 文本）；
/// 表里没建模的每一条都写明**为什么**，不写成「未知」。
///
/// 已建模的那五个 id 不再在这里各写一行——它们由 [`Disease::from_mob_skill_id`]
/// 决定，所以新增疾病不会漏改这张表。
pub(super) fn mob_skill_effect(id: u32) -> SkillEffect {
    if let Some(disease) = Disease::from_mob_skill_id(id) {
        return SkillEffect::Disease(disease);
    }
    match id {
        121 => SkillEffect::Unmodelled("黑暗：需要独立的视野遮挡渲染层，本仓库没有该通道。"),
        122 => SkillEffect::Unmodelled("虛弱：源语义是降低物理防御，需要独立的护甲结算通道。"),
        128 => SkillEffect::Unmodelled(
            "誘惑：源语义是强制玩家朝一个方向走，需要独立的强制移动通道；\
             本版内容里唯一带它的怪（5250007）没有可用的时长字段，先登记不实现。",
        ),
        133 => SkillEffect::Unmodelled("屍化：源语义是把治疗变成伤害，需要治疗结算通道。"),
        134 => SkillEffect::Unmodelled("禁藥：源语义是禁用消耗品，需要道具使用通道。"),
        137 => SkillEffect::Unmodelled("冰冻：需要与冰系冰封区分的独立控制通道。"),
        // 不属于 MapleDisease 的 id：怪物自身的增益 / 召唤 / 治疗类技能。
        112 | 113 | 114 | 170 | 200 => SkillEffect::NotADisease,
        _ => SkillEffect::NotADisease,
    }
}

/// 增益到期时必须收回的附属状态。
///
/// 改前这四件事是 `world.rs` tick 块里四段写死技能 id 的 `if remaining == 0`；
/// 现在是效果自带的数据，`world.rs` 侧 `match` 到全部变体 ⇒ 新增变体必然编译失败。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Release {
    /// 到期没有附属状态需要收回（绝大多数增益）。
    None,
    /// 恢复術：收回 `beginner_heal_next_tick` / `beginner_heal_remaining_ticks` / `beginner_heal_per_tick`。
    BeginnerRecovery,
    /// 迅捷腳步：收回 `beginner_speed_percent`。
    BeginnerSpeed,
    /// 無限：收回 `infinity_next_tick` 与 `infinity_damage_bonus`。
    Infinity,
    /// 楓葉淨化：收回異常狀態免疫窗（`immune_until`）。
    StatusImmunity,
    /// 進階祝福 `2321005`：收回 `advanced_blessing`（窗口内的攻击力 / 魔力 / 防御力
    /// 三格加算）。与 `Infinity` 同形——增益**随身带了数值**，到期不只是「不再生效」。
    AdvancedBlessing,
}

/// `advance()` 的返回项。穷尽 match 是清理不漏的前提。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Expiry {
    Buff { skill_id: u32, release: Release },
    Disease(Disease),
}

/// 一条限时记录。`until <= now` 即失效（本模块唯一的失效判据）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Timed {
    until: u64,
    /// 下一次伤害脉冲的世界 tick；0 表示该状态没有脉冲。
    next: u64,
}

/// 一条技能增益。附属状态与时长绑在一起，随记录一起被移除。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct TimedBuff {
    until: u64,
    release: Release,
}

/// 玩家的全部限时状态。`Player` 只持有这一个字段。
#[derive(Clone, Debug, Default)]
pub(super) struct PlayerStatus {
    /// 本状态自己的时钟：只由 [`PlayerStatus::advance`] 与各 `apply_*` 盖章。
    now: u64,
    /// 技能 id → 增益。键集闭于「真的会被施放的增益」，最多个位数。
    buffs: BTreeMap<u32, TimedBuff>,
    /// 疾病 → 记录。缺键即「未被该疾病影响」。
    diseases: BTreeMap<Disease, Timed>,
    /// 異常狀態免疫窗截止点（楓葉淨化）。0 表示无免疫。
    immune_until: u64,
}

impl PlayerStatus {
    /// 推进时钟并返回本拍失效的全部项，顺序确定
    /// （增益按技能 id 升序，疾病按 [`Disease::ALL`]）。
    ///
    /// 各增益的附属状态互不相干（见 [`Release`]），所以按 id 升序清理与改前的固定顺序等价。
    /// 没有失效项时不分配（空 `Vec` 不占堆）。
    pub(super) fn advance(&mut self, now: u64) -> Vec<Expiry> {
        self.now = now;
        let expired_buffs: Vec<(u32, Release)> = self
            .buffs
            .iter()
            .filter(|(_, buff)| buff.until <= now)
            .map(|(id, buff)| (*id, buff.release))
            .collect();
        for (id, _) in &expired_buffs {
            self.buffs.remove(id);
        }
        let expired_diseases: Vec<Disease> = Disease::ALL
            .into_iter()
            .filter(|disease| {
                self.diseases
                    .get(disease)
                    .is_some_and(|timed| timed.until <= now)
            })
            .collect();
        for disease in &expired_diseases {
            self.diseases.remove(disease);
        }
        expired_buffs
            .into_iter()
            .map(|(skill_id, release)| Expiry::Buff { skill_id, release })
            .chain(expired_diseases.into_iter().map(Expiry::Disease))
            .collect()
    }

    /// 施加（或刷新）一条增益。
    ///
    /// 刷新语义与改前 `insert` 一致：同一技能再次施放**覆盖**为新的截止点（不是取较长者）。
    /// 同一个技能 id 不允许对应两种 [`Release`]——那说明调用点写错了，`debug_assert` 直接炸。
    pub(super) fn apply_buff(
        &mut self,
        skill_id: u32,
        duration_ms: u64,
        now: u64,
        release: Release,
    ) {
        self.now = now;
        let until = now.saturating_add(duration_ms.div_ceil(TICK_MS));
        if let Some(existing) = self.buffs.get(&skill_id) {
            debug_assert_eq!(
                existing.release, release,
                "同一个增益 id 在不同调用点被声明了两种附属状态"
            );
        }
        self.buffs.insert(skill_id, TimedBuff { until, release });
    }

    /// 显式取消一条增益（不是到期，是「这次增益被收掉了」）。返回是否真的有这条记录。
    ///
    /// 只有冰龙吐息与雷霆通道这类**引导**会用：它们的宿主是引导状态机，
    /// 引导收尾时要连同增益一起收掉，理由与到期完全不同。
    pub(super) fn remove_buff(&mut self, skill_id: u32) -> bool {
        self.buffs.remove(&skill_id).is_some()
    }

    /// 该增益此刻是否生效。**这是唯一的生效判据**（改前的 `contains_key` 读法全部收敛到这里）。
    pub(super) fn buff_active(&self, skill_id: u32) -> bool {
        self.buffs
            .get(&skill_id)
            .is_some_and(|buff| buff.until > self.now)
    }

    /// 该增益的剩余毫秒；未生效时为 `None`。投影口径与改前逐字相同。
    pub(super) fn buff_remaining_ms(&self, skill_id: u32) -> Option<u64> {
        self.buffs
            .get(&skill_id)
            .filter(|buff| buff.until > self.now)
            .map(|buff| buff.until.saturating_sub(self.now).saturating_mul(TICK_MS))
    }

    /// 全部生效增益的「技能 id → 剩余毫秒」。空表即「没有增益」。
    pub(super) fn buff_map(&self) -> BTreeMap<u32, u64> {
        self.buffs
            .iter()
            .filter(|(_, buff)| buff.until > self.now)
            .map(|(id, buff)| {
                (
                    *id,
                    buff.until.saturating_sub(self.now).saturating_mul(TICK_MS),
                )
            })
            .collect()
    }

    /// 施加一种疾病。`duration_ms` 用**向下取整**到 tick（与改前的疾病截止点公式一致），
    /// 下界 1 拍，避免 0 时长被当成「已施加」。
    ///
    /// 第一条伤害脉冲落在**下一拍**，此后按 [`Disease::dot_cadence_ms`] 推进——
    /// 这与改前 `*_next_tick = tick + 1` 的初值相同，不是「等一个节拍再开始」。
    pub(super) fn apply_disease(&mut self, disease: Disease, duration_ms: u64, now: u64) {
        self.now = now;
        let until = now.saturating_add((duration_ms / TICK_MS).max(1));
        let next = if disease.dot_cadence_ms().is_some() {
            now.saturating_add(1)
        } else {
            0
        };
        self.diseases.insert(disease, Timed { until, next });
    }

    pub(super) fn disease_active(&self, disease: Disease) -> bool {
        self.diseases
            .get(&disease)
            .is_some_and(|timed| timed.until > self.now)
    }

    /// 疾病截止点（0 表示未受影响）。
    ///
    /// **只给验收用**：改前的验收直接断言 `player.seal_until` 之类的裸字段，这两个
    /// 访问器让那批断言能逐字对齐到同一口径。生产判定一律走 `*_active` 一族，
    /// 所以它们在非测试构建里不存在（也就不会腐烂成第二个判据）。
    #[cfg(test)]
    pub(super) fn disease_deadline(&self, disease: Disease) -> u64 {
        self.diseases.get(&disease).map_or(0, |timed| timed.until)
    }

    /// 疾病的下一次伤害脉冲（0 表示未受影响或该疾病没有脉冲）。**只给验收用。**
    #[cfg(test)]
    pub(super) fn disease_next_tick(&self, disease: Disease) -> u64 {
        self.diseases.get(&disease).map_or(0, |timed| timed.next)
    }

    /// 封印或眩晕：两者都让技能条失效，但只有眩晕同时锁操作。
    pub(super) fn suppresses_skill_cast(&self) -> bool {
        self.disease_active(Disease::Seal) || self.disease_active(Disease::Stun)
    }

    /// 眩晕：`movement.rs` 的权威步进据此锁住身体。
    pub(super) fn locks_controls(&self) -> bool {
        self.disease_active(Disease::Stun)
    }

    /// 緩速：行走速度缩放用的开关。
    pub(super) fn slows_walk(&self) -> bool {
        self.disease_active(Disease::Slow)
    }

    /// 免疫窗是否仍然生效（楓葉淨化）。
    pub(super) fn is_immune(&self) -> bool {
        self.immune_until > self.now
    }

    /// 重设免疫窗（截止点按拍取整，口径与改前 `status_immune_until` 相同）。
    pub(super) fn grant_immunity(&mut self, duration_ms: u64, now: u64) {
        self.now = now;
        self.immune_until = now.saturating_add((duration_ms / TICK_MS).max(1));
    }

    /// 本拍到期的伤害脉冲。会就地推进各家自己的 `next`，所以同一个脉冲只返回一次。
    ///
    /// 顺序按 [`Disease::ALL`]；只有 [`DiseaseEffect::PeriodicDrain`] 的疾病参与。
    pub(super) fn due_dots(&mut self) -> Vec<Disease> {
        let mut due = Vec::new();
        for disease in Disease::ALL {
            let Some(cadence_ms) = disease.dot_cadence_ms() else {
                continue;
            };
            let Some(timed) = self.diseases.get_mut(&disease) else {
                continue;
            };
            if timed.until > self.now && timed.next <= self.now {
                timed.next = self.now.saturating_add((cadence_ms / TICK_MS).max(1));
                due.push(disease);
            }
        }
        due
    }

    /// 解除全部疾病并重设免疫窗（楓葉淨化）。返回被清掉的疾病，供调用方决定要不要播报。
    pub(super) fn cleanse(&mut self, now: u64, immunity_ms: u64) -> Vec<Disease> {
        self.now = now;
        let cleared: Vec<Disease> = self.diseases.keys().copied().collect();
        self.diseases.clear();
        self.grant_immunity(immunity_ms, now);
        cleared
    }

    /// 死亡 / 换图 / 重连的唯一清理点。时钟保留（调用方随后会用当前 tick 继续推进）。
    pub(super) fn clear(&mut self) {
        self.buffs.clear();
        self.diseases.clear();
        self.immune_until = 0;
    }

    /// 快照投影：只报仍在生效的疾病。形状与改前逐字相同（字段名、`None` 语义、单位）。
    pub(super) fn abnormal(&self) -> AbnormalStatus {
        let remaining = |disease: Disease| {
            self.diseases
                .get(&disease)
                .filter(|timed| timed.until > self.now)
                .map(|timed| timed.until.saturating_sub(self.now).saturating_mul(TICK_MS))
        };
        AbnormalStatus {
            seal_ms: remaining(Disease::Seal),
            stun_ms: remaining(Disease::Stun),
            curse_ms: remaining(Disease::Curse),
            poison_ms: remaining(Disease::Poison),
            slow_ms: remaining(Disease::Slow),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 把时钟推到 `tick` 并丢掉本拍失效项——等价于「没有东西到期的一拍」。
    /// 测试一律走真实入口（`advance`），不直接改 `now` 字段。
    fn tick_to(status: &mut PlayerStatus, tick: u64) {
        let expired = status.advance(tick);
        assert!(
            expired.is_empty(),
            "tick_to({tick}) 意外报出失效项：{expired:?}"
        );
    }

    #[test]
    fn buff_deadline_matches_the_old_remaining_ms_countdown() {
        // 改前：t 施加 d 毫秒，随后每拍减 TICK_MS，第 ceil(d / TICK_MS) 拍判 0 并移除。
        for duration_ms in [50_u64, 1_000, 3_000, 3_390, 60_000] {
            let start = 7;
            let mut status = PlayerStatus::default();
            status.apply_buff(4_001, duration_ms, start, Release::None);
            let until = start + duration_ms.div_ceil(TICK_MS);
            for tick in start..until {
                tick_to(&mut status, tick);
                assert!(status.buff_active(4_001), "duration {duration_ms}");
                assert_eq!(
                    status.buff_remaining_ms(4_001),
                    Some((until - tick).saturating_mul(TICK_MS))
                );
            }
            tick_to(&mut status, until - 1);
            assert!(status.buff_active(4_001), "duration {duration_ms}");
            // 到期那一拍由 `advance()` 报出这一条（不是静默消失）。
            assert_eq!(
                status.advance(until),
                vec![Expiry::Buff {
                    skill_id: 4_001,
                    release: Release::None
                }],
                "duration {duration_ms}"
            );
            assert!(!status.buff_active(4_001), "duration {duration_ms}");
            assert_eq!(status.buff_remaining_ms(4_001), None);
        }
    }

    #[test]
    fn a_buff_refreshes_on_reapply_and_never_stacks() {
        let mut status = PlayerStatus::default();
        // 刷新：第二次施放覆盖截止点，不退化成取较长者，也不叠加两条。
        status.apply_buff(4_001, 3_000, 0, Release::None);
        status.apply_buff(4_001, 1_000, 10, Release::None);
        assert_eq!(status.buff_map(), BTreeMap::from([(4_001, 1_000)]));
        tick_to(&mut status, 29);
        assert!(status.buff_active(4_001));
        assert_eq!(
            status.advance(30),
            vec![Expiry::Buff {
                skill_id: 4_001,
                release: Release::None
            }]
        );
        assert!(!status.buff_active(4_001));
    }

    #[test]
    fn advance_reports_every_expiry_exactly_once_and_deterministically() {
        let mut status = PlayerStatus::default();
        status.apply_buff(300, 1_000, 0, Release::None);
        status.apply_buff(100, 1_000, 0, Release::Infinity);
        status.apply_disease(Disease::Poison, 1_000, 0);
        status.apply_disease(Disease::Seal, 2_000, 0);
        assert_eq!(status.advance(19), Vec::new());
        assert_eq!(
            status.advance(20),
            vec![
                Expiry::Buff {
                    skill_id: 100,
                    release: Release::Infinity
                },
                Expiry::Buff {
                    skill_id: 300,
                    release: Release::None
                },
                Expiry::Disease(Disease::Poison),
            ]
        );
        // 同一项不会被报第二次。
        assert_eq!(status.advance(20), Vec::new());
        assert_eq!(status.advance(40), vec![Expiry::Disease(Disease::Seal)]);
        assert_eq!(status.advance(40), Vec::new());
    }

    #[test]
    fn disease_expiry_also_stops_the_damage_pulse() {
        let mut status = PlayerStatus::default();
        status.apply_disease(Disease::Poison, 2_000, 0);
        // 施加当拍不脉冲，下一拍起每 1 秒一次（与改前 `*_next_tick = tick + 1` 同相）。
        assert_eq!(status.due_dots(), Vec::new());
        tick_to(&mut status, 1);
        assert_eq!(status.due_dots(), vec![Disease::Poison]);
        assert_eq!(status.due_dots(), Vec::new());
        tick_to(&mut status, 21);
        assert_eq!(status.due_dots(), vec![Disease::Poison]);
        // 到期拍上不再脉冲：疾病先被 advance 收掉，脉冲无从发生（与改前 else-if 分支同序）。
        assert_eq!(status.advance(40), vec![Expiry::Disease(Disease::Poison)]);
        assert_eq!(status.due_dots(), Vec::new());
        assert_eq!(status.disease_deadline(Disease::Poison), 0);
        assert_eq!(status.disease_next_tick(Disease::Poison), 0);
    }

    #[test]
    fn cleanse_clears_every_disease_and_arms_the_immunity_window() {
        let mut status = PlayerStatus::default();
        for disease in Disease::ALL {
            status.apply_disease(disease, 60_000, 0);
        }
        let cleared = status.cleanse(10, 3_000);
        assert_eq!(cleared.len(), Disease::ALL.len());
        for disease in Disease::ALL {
            assert!(!status.disease_active(disease), "{disease:?}");
            assert_eq!(status.disease_deadline(disease), 0);
            assert_eq!(status.disease_next_tick(disease), 0);
        }
        assert!(status.is_immune());
        tick_to(&mut status, 69);
        assert!(status.is_immune());
        tick_to(&mut status, 70);
        assert!(!status.is_immune());
    }

    #[test]
    fn clear_drops_buffs_diseases_and_immunity_together() {
        let mut status = PlayerStatus::default();
        status.apply_buff(4_001, 60_000, 0, Release::BeginnerRecovery);
        status.apply_disease(Disease::Stun, 60_000, 0);
        status.grant_immunity(3_000, 0);
        status.clear();
        assert!(!status.buff_active(4_001));
        assert!(!status.disease_active(Disease::Stun));
        assert!(!status.is_immune());
        assert_eq!(status.buff_map(), BTreeMap::new());
    }

    #[test]
    fn only_active_statuses_reach_the_snapshot() {
        let mut status = PlayerStatus::default();
        assert!(status.abnormal().is_empty());
        status.apply_disease(Disease::Seal, 5_000, 10);
        assert_eq!(status.abnormal().seal_ms, Some(5_000));
        assert_eq!(status.abnormal().stun_ms, None);
        // 到期后不再上报，且不会留下 0 值字段。
        status.advance(110);
        assert!(status.abnormal().is_empty());
    }

    #[test]
    fn every_modelled_disease_round_trips_through_its_source_id() {
        for disease in Disease::ALL {
            assert_eq!(
                Disease::from_mob_skill_id(disease.mob_skill_id()),
                Some(disease)
            );
            assert_eq!(
                mob_skill_effect(disease.mob_skill_id()),
                SkillEffect::Disease(disease)
            );
        }
        // 一个 id 不能被两种处置认领。
        let mut ids: Vec<u32> = Disease::ALL.iter().map(|d| d.mob_skill_id()).collect();
        ids.sort_unstable();
        assert_eq!(ids.windows(2).filter(|pair| pair[0] == pair[1]).count(), 0);
    }

    #[test]
    fn every_unmodelled_id_states_a_reason() {
        // 表里「没建模」的每一条都必须给出原因，不能写成空串或「未知」。
        for id in [121_u32, 122, 128, 133, 134, 137] {
            match mob_skill_effect(id) {
                SkillEffect::Unmodelled(reason) => {
                    assert!(reason.len() >= 12, "{id} 的原因太短：{reason}");
                    assert!(!reason.contains("未知"), "{id} 不许用「未知」搪塞");
                }
                other => panic!("{id} 应登记为未建模，实际 {other:?}"),
            }
        }
        for id in [112_u32, 113, 114, 170, 200] {
            assert_eq!(mob_skill_effect(id), SkillEffect::NotADisease);
        }
    }

    #[test]
    fn a_reason_string_is_not_a_second_switch() {
        // 未建模的 id 与已建模的 id 不能重叠：重叠意味着某个源技能既被登记为
        // 「没建模」又会真的施加一种疾病，运行时行为取决于谁先被读到。
        let modelled: Vec<u32> = Disease::ALL.iter().map(|d| d.mob_skill_id()).collect();
        for id in [121_u32, 122, 128, 133, 134, 137] {
            assert!(!modelled.contains(&id), "{id} 同时出现在两张表里");
        }
    }
}
