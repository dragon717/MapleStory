//! 转职任务的持久化事务。
//!
//! 从 `auth.rs` 分出的独立职责：**唯一**把「职业切换 + 奖励发放 + 状态置 completed」
//! 做成一次原子写的地方。世界侧（`world::job_advance`）只负责算候选与回执，
//! 真正算数的是这里落下去的那一行。
//!
//! ## 幂等
//!
//! 两道闸，任何一道不满足都回滚并返回 `Ok(false)`（**不是错误**，是「已经做过了 /
//! 不该做」）：
//! 1. **任务状态**：`player_quests` 里这一行必须是 `active`，转场到 `completed`
//!    只可能发生一次；重放请求在状态读到 `completed` 时直接回滚。
//! 2. **职业 CAS**：持久职业必须仍是 `from_job`。转职一旦成功，`from_job` 就不成立，
//!    所以即使有人绕过对话直接重放，第二道闸也会挡下。
//!
//! ## 契约
//!
//! [`JobAdvancePlan`] 是 auth 侧自己拥有的扁平结构，**不依赖配置 schema**：
//! 改 `shared/job-advance.json` 的字段形状不会牵动持久化层。

use super::notebook::{granted_tx, ItemAcquisition};
use super::*;

/// 一次转职要落库的全部内容。由 `world::job_advance` 从配置装配。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct JobAdvancePlan {
    pub(crate) quest_id: String,
    pub(crate) from_job: u32,
    pub(crate) to_job: u32,
    /// 交付时的等级下限；未达标直接拒绝（世界侧判过了，这里是第二道）。
    pub(crate) level_at_least: u32,
    /// `(技能书 id, 发放点数)`。只加不减。
    pub(crate) skill_points: Vec<(u32, u32)>,
    /// `(技能 id, 等级)`。只补不覆盖。
    pub(crate) skills: Vec<(u32, u32)>,
    /// MP 下限。0 表示不动。
    pub(crate) max_mp_floor: i64,
}

/// 把转职奖励写进权威档案。**只加不覆盖**：历史 SP / 已学技能一概保留，
/// 只有职业字段是赋值（它正是这次转职要改变的东西）。
///
/// 纯函数（不碰 World / Store），因此事务路径、世界候选路径与单测共用同一份实现，
/// 不存在「测试里发的和线上发的不一样」。
pub(crate) fn apply_job_advance_grant(profile: &mut Profile, plan: &JobAdvancePlan) {
    profile.job = plan.to_job;
    for (book, amount) in &plan.skill_points {
        if *amount == 0 {
            continue;
        }
        let slot = profile.skill_points.entry(*book).or_insert(0);
        *slot = slot.saturating_add(*amount);
    }
    for (skill_id, level) in &plan.skills {
        if *level == 0 {
            continue;
        }
        profile.skills.entry(*skill_id).or_insert(*level);
    }
    if plan.max_mp_floor > 0 && profile.max_mp < plan.max_mp_floor {
        profile.max_mp = plan.max_mp_floor;
        // 转职补的 MP 直接给满，与一转补發同源（`grant_first_mage`）。
        profile.mp = profile.max_mp;
    }
}

impl Store {
    /// 提交一次转职：职业切换、奖励、任务状态与图鉴留档同一事务。
    ///
    /// 返回 `Ok(false)` 表示这次提交**不该发生**（未接取 / 已转过 / 职业已变），
    /// 调用方按幂等重放处理——不报错、不重复发奖励。
    pub fn commit_job_advance(
        &self,
        account_id: &str,
        plan: &JobAdvancePlan,
        profile: &Profile,
        grants: &[ItemAcquisition],
    ) -> Result<bool, String> {
        if plan.quest_id.trim().is_empty() {
            return Err("invalid job advance quest id".to_owned());
        }
        if plan.from_job == plan.to_job {
            return Err("job advance does not change the job".to_owned());
        }
        if profile.job != plan.to_job {
            return Err("invalid job advance candidate".to_owned());
        }

        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;

        // 权威档案是判据来源；世界给的 `profile` 只是候选。
        let durable = read_profile(&tx, account_id)?;
        if durable.job != plan.from_job || durable.level < plan.level_at_least {
            tx.rollback().map_err(|_| "account persistence failed")?;
            return Ok(false);
        }
        let status: Option<String> = tx
            .query_row(
                "SELECT status FROM player_quests WHERE account_id=?1 AND quest_id=?2",
                params![account_id, plan.quest_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "account persistence failed")?;
        if status.as_deref() != Some("active") {
            // 未接取就交付，或者已经交付过：都不写。
            tx.rollback().map_err(|_| "account persistence failed")?;
            return Ok(false);
        }

        // 只比对本次转职拥有的那几个字段，位置 / 背包 / 经验等仍以世界候选为准。
        // 这样「存档里早就有的 SP」不会被抹，也不会有人拿旧档覆盖新职业。
        let mut expected = durable.clone();
        apply_job_advance_grant(&mut expected, plan);
        if profile.job != expected.job
            || profile.max_mp != expected.max_mp
            || profile.skills != expected.skills
            || profile.skill_points != expected.skill_points
        {
            return Err("invalid job advance candidate".to_owned());
        }

        write_profile(&tx, account_id, profile)?;
        write_inventory_tx(&tx, account_id, &profile.inventory)?;
        let changed = tx
            .execute(
                "UPDATE player_quests SET status='completed'
                 WHERE account_id=?1 AND quest_id=?2 AND status='active'",
                params![account_id, plan.quest_id],
            )
            .map_err(|_| "account persistence failed")?;
        if changed != 1 {
            return Err("account persistence failed".to_owned());
        }
        granted_tx(&tx, account_id, grants, now_ms())?;
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan() -> JobAdvancePlan {
        JobAdvancePlan {
            quest_id: "job-220".to_owned(),
            from_job: 200,
            to_job: 220,
            level_at_least: 30,
            skill_points: vec![(220, 5)],
            skills: vec![(2200011, 1)],
            max_mp_floor: 100,
        }
    }

    #[test]
    fn grant_only_adds_and_never_resets_progress() {
        let mut profile = Profile {
            job: 200,
            max_mp: 250,
            mp: 7,
            skill_points: BTreeMap::from([(200_u32, 3_u32), (220_u32, 12_u32)]),
            skills: BTreeMap::from([(2200011_u32, 7_u32)]),
            ..blank_profile()
        };
        apply_job_advance_grant(&mut profile, &plan());
        assert_eq!(profile.job, 220);
        // 已有的 12 点不被抹成 5，也不被覆盖成 5。
        assert_eq!(profile.skill_points[&220], 17);
        assert_eq!(profile.skill_points[&200], 3);
        // 已学到 7 级的技能不会被打回 1 级。
        assert_eq!(profile.skills[&2200011], 7);
        // 已有 250 > 下限 100，MP 不动。
        assert_eq!(profile.max_mp, 250);
        assert_eq!(profile.mp, 7);
    }

    #[test]
    fn grant_raises_mp_to_the_floor_when_lower() {
        let mut profile = Profile {
            job: 200,
            max_mp: 20,
            mp: 5,
            ..blank_profile()
        };
        apply_job_advance_grant(&mut profile, &plan());
        assert_eq!(profile.max_mp, 100);
        assert_eq!(profile.mp, 100);
    }

    /// 构造一个字段全空的档案，避免测试依赖某个具体构造函数。
    fn blank_profile() -> Profile {
        Profile {
            hp: 0,
            max_hp: 0,
            mp: 0,
            max_mp: 0,
            level: 0,
            job: 0,
            exp: 0,
            exp_to_next: 0,
            mesos: 0,
            cash: 0,
            death_id: String::new(),
            map_id: String::new(),
            x: 0.0,
            y: 0.0,
            inventory: Vec::new(),
            skills: BTreeMap::new(),
            skill_points: BTreeMap::new(),
            ability_stats: AbilityStats::default(),
        }
    }

    #[test]
    fn grant_is_idempotent_for_skills_but_adds_points_once() {
        let mut profile = Profile {
            job: 200,
            ..blank_profile()
        };
        apply_job_advance_grant(&mut profile, &plan());
        let after_first = profile.clone();
        apply_job_advance_grant(&mut profile, &plan());
        // 职业与技能是幂等的；SP 会再加一次，所以**事务必须保证只成功一次**
        // （`commit_job_advance` 用 `status='active'` 的 CAS 守着这一点）。
        assert_eq!(profile.job, after_first.job);
        assert_eq!(profile.skills, after_first.skills);
        assert_eq!(profile.skill_points[&220], 10);
    }
}
