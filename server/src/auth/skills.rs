//! 技能动作持久化：施法/施法+冷却/漩涡施法、超技能重置、冷却余量查询，
//! 以及请求幂等回执（prior_skill_action）与技能动作的事务落库（skill_action，
//! 内含 hyper 分支 hyper_skill_action）。
//!
//! 从 `auth.rs` 机械搬出的第一块完整职责（超大文件治理）。搬的是**代码位置**，
//! 不是数据布局：表结构、请求幂等窗口与回执语义均未改变。
//! 调用方在 `auth` 之外（world/skills/elemental），方法保持原有 `pub` 可见性。

use super::*;

/// 一次技能轉換（`2321054 復仇天使`）要落库的全部内容。
///
/// 与 [`JobAdvancePlan`] 同形：auth 侧自己拥有的扁平结构，**不依赖世界侧的表形状**
/// （改 `world.rs::TRANSFORM_PAIRS` 的配对写法不会牵动持久化层）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SkillTransformPlan {
    /// `(復仇技能 id, 等级)`。**只补不覆盖** —— 与 `JobAdvancePlan::skills` 同一条纪律。
    pub(crate) grants: Vec<(u32, u32)>,
}

/// 把转换写进权威档案。纯函数（不碰 World / Store），所以事务路径、世界候选路径
/// 与单测共用同一份实现 —— 不存在「测试里发的和线上发的不一样」。
///
/// 等级来自**慈愛那一侧的已学等级**（源 perLevel：「…各別轉換成…」＝同一个槽位换内容），
/// 由世界侧算好放进 `grants`；本函数只负责落进档案。
pub(crate) fn apply_skill_transform_grant(profile: &mut Profile, plan: &SkillTransformPlan) {
    for (skill_id, level) in &plan.grants {
        if *level == 0 {
            continue;
        }
        profile.skills.entry(*skill_id).or_insert(*level);
    }
}

impl Store {
    /// 提交一次技能轉換：把四本復仇技能按慈愛那一侧的已学等级写进权威档案。
    ///
    /// 返回 `Ok(false)` 表示这次提交**不该发生**（本次要授予的技能里已经有一本在
    /// 档案里了 ⇒ 转换早已执行过），调用方按幂等重放处理——不报错、不重复写。
    ///
    /// 转换是**不可逆的一次性动作**（源里既没有 `time`、也没有「再次使用即中斷」
    /// 那类文案），所以幂等闸取「本次 grants 的每一本在权威档案里都还没有值」；
    /// 它同时是 CAS：世界侧给的那份 `profile` 必须恰好等于「档案 + 本次授予」。
    pub fn commit_skill_transform(
        &self,
        account_id: &str,
        plan: &SkillTransformPlan,
        profile: &Profile,
    ) -> Result<bool, String> {
        if plan.grants.is_empty() {
            return Err("empty skill transform".to_owned());
        }
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        // 权威档案是判据来源；世界给的 `profile` 只是候选。
        let durable = read_profile(&tx, account_id)?;
        if plan
            .grants
            .iter()
            .any(|(skill_id, _)| durable.skills.contains_key(skill_id))
        {
            tx.rollback().map_err(|_| "account persistence failed")?;
            return Ok(false);
        }
        let mut expected = durable.clone();
        apply_skill_transform_grant(&mut expected, plan);
        if profile.skills != expected.skills {
            return Err("invalid skill transform candidate".to_owned());
        }
        write_profile(&tx, account_id, profile)?;
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(true)
    }

    pub fn cast_skill(
        &self,
        account_id: &str,
        request_id: &str,
        skill_id: u32,
        expected_job: u32,
        book_id: u32,
        max_level: u32,
        mp_cost: i64,
    ) -> Result<SkillActionOutcome, String> {
        self.cast_skill_with_cooldown(
            account_id,
            request_id,
            skill_id,
            expected_job,
            book_id,
            max_level,
            mp_cost,
            0,
        )
    }

    /// Atomically spend MP and start a server-authored skill cooldown.
    /// `cooldown_ms` is supplied by the server's skill definition; callers
    /// must never forward a client timestamp or client duration.
    pub fn cast_skill_with_cooldown(
        &self,
        account_id: &str,
        request_id: &str,
        skill_id: u32,
        expected_job: u32,
        book_id: u32,
        max_level: u32,
        mp_cost: i64,
        cooldown_ms: i64,
    ) -> Result<SkillActionOutcome, String> {
        self.skill_action(
            account_id,
            request_id,
            "cast",
            skill_id,
            expected_job,
            book_id,
            max_level,
            &BTreeMap::new(),
            false,
            mp_cost,
            cooldown_ms,
            skill_id,
        )
    }

    /// Cast the public Hyper vortex (2221054).  Its cooldown is keyed to the
    /// hidden server-only 2221055 variant so changing the visible skill id
    /// cannot bypass the shared cooldown.
    pub fn cast_hyper_vortex(
        &self,
        account_id: &str,
        request_id: &str,
        mp_cost: i64,
        cooldown_ms: i64,
    ) -> Result<SkillActionOutcome, String> {
        self.skill_action(
            account_id,
            request_id,
            "cast",
            HYPER_VORTEX_SKILL,
            FOURTH_JOB,
            FOURTH_MAGE_BOOK,
            1,
            &BTreeMap::new(),
            false,
            mp_cost,
            cooldown_ms,
            HYPER_HIDDEN_SKILL,
        )
    }

    /// Atomically clear all visible Hyper investments and charge the
    /// server-authored reset price.  The durable request ledger is checked
    /// before current state so a replay returns the original result verbatim.
    pub fn reset_hyper_skills(
        &self,
        account_id: &str,
        request_id: &str,
        expected_cost: u64,
    ) -> Result<SkillActionOutcome, String> {
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        if let Some((mut outcome, quoted_cost)) = tx
            .query_row(
                "SELECT operation,skill_id,success,code,skill_level,remaining_sp,mp,quoted_cost FROM skill_actions WHERE account_id=?1 AND request_id=?2",
                params![account_id, request_id],
                |row| {
                    Ok((
                        SkillActionOutcome {
                            operation: row.get(0)?,
                            skill_id: row.get::<_, i64>(1)?.try_into().unwrap_or(0),
                            success: row.get::<_, i64>(2)? != 0,
                            code: row.get(3)?,
                            level: row.get::<_, i64>(4)?.try_into().unwrap_or(0),
                            remaining_sp: row.get::<_, i64>(5)?.try_into().unwrap_or(0),
                            mp: row.get(6)?,
                            already_resolved: true,
                        },
                        row.get::<_, i64>(7)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| "account persistence failed")?
        {
            let expected_cost_i64 = i64::try_from(expected_cost).ok();
            if outcome.operation != "hyper_reset"
                || outcome.skill_id != 0
                || expected_cost_i64 != Some(quoted_cost)
            {
                outcome.success = false;
                outcome.code = "request_conflict".to_owned();
            }
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(outcome);
        }
        let (job, level, mesos, current_mp, skills_json, reset_count):
            (i64, i64, i64, i64, String, i64) = tx
            .query_row(
                "SELECT job,level,mesos,mp,skills_json,hyper_reset_count FROM player_stats WHERE account_id=?1",
                [account_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
            )
            .map_err(|_| "account persistence failed")?;
        let current_level = u32::try_from(level.max(0)).unwrap_or(0);
        let reset_count = u8::try_from(reset_count.clamp(0, 4)).unwrap_or(0);
        let cost = hyper_reset_cost(reset_count);
        let mut skills = parse_skill_map(&skills_json)?;
        let has_investment = HYPER_VISIBLE_SKILLS
            .iter()
            .any(|skill_id| skills.get(skill_id).copied().unwrap_or(0) > 0);
        let mut success = true;
        let mut code = String::new();
        if job != i64::from(FOURTH_JOB) {
            success = false;
            code = "wrong_job".to_owned();
        } else if current_level < 140 {
            success = false;
            code = "level_requirement".to_owned();
        } else if !has_investment {
            success = false;
            code = "hyper_no_investment".to_owned();
        } else if expected_cost != cost {
            success = false;
            code = "cost_changed".to_owned();
        } else if mesos < i64::try_from(cost).unwrap_or(i64::MAX) {
            success = false;
            code = "not_enough_mesos".to_owned();
        } else {
            for skill_id in HYPER_VISIBLE_SKILLS {
                skills.remove(&skill_id);
            }
        }
        let remaining_sp = 0_i64;
        let ledger_cost =
            i64::try_from(if success { cost } else { expected_cost }).unwrap_or(i64::MAX);
        tx.execute(
            "INSERT INTO skill_actions(account_id,request_id,operation,skill_id,success,code,skill_level,remaining_sp,mp,quoted_cost) VALUES(?1,?2,'hyper_reset',0,?3,?4,0,?5,?6,?7)",
            params![
                account_id,
                request_id,
                if success { 1 } else { 0 },
                code.clone(),
                remaining_sp,
                current_mp.max(0),
                ledger_cost,
            ],
        )
        .map_err(|_| "account persistence failed")?;
        if success {
            let new_mesos = mesos - i64::try_from(cost).unwrap_or(i64::MAX);
            let next_reset_count = i64::from(reset_count.min(4).saturating_add(1).min(4));
            let changed = tx
                .execute(
                    "UPDATE player_stats SET mesos=?2,skills_json=?3,hyper_reset_count=?4
                     WHERE account_id=?1 AND job=?5 AND level>=140 AND hyper_reset_count=?6",
                    params![
                        account_id,
                        new_mesos,
                        serialize_skill_map(&skills)?,
                        next_reset_count,
                        FOURTH_JOB,
                        i64::from(reset_count),
                    ],
                )
                .map_err(|_| "account persistence failed")?;
            if changed != 1 {
                return Err("account persistence failed".to_owned());
            }
        }
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(SkillActionOutcome {
            operation: "hyper_reset".to_owned(),
            skill_id: 0,
            success,
            code,
            level: 0,
            remaining_sp: u32::try_from(remaining_sp).unwrap_or(0),
            mp: current_mp.max(0),
            already_resolved: false,
        })
    }

    /// Return the durable server-side cooldown remaining for a skill.
    /// A missing or expired row is reported as zero.
    pub fn skill_cooldown_remaining_ms(
        &self,
        account_id: &str,
        skill_id: u32,
    ) -> Result<u64, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        let ready_at: Option<i64> = db
            .query_row(
                "SELECT ready_at_ms FROM skill_cooldowns WHERE account_id=?1 AND skill_id=?2",
                params![account_id, i64::from(skill_id)],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "account persistence failed")?;
        Ok(ready_at
            .map(|value| value.saturating_sub(now_ms()).try_into().unwrap_or(0))
            .unwrap_or(0))
    }

    /// Read an already settled skill request before any world-side validation
    /// (collision, action lock, or current MP).  A retry must replay the exact
    /// transaction outcome even after teleporting or changing state.
    pub fn prior_skill_action(
        &self,
        account_id: &str,
        request_id: &str,
        operation: &str,
        skill_id: u32,
    ) -> Result<Option<SkillActionOutcome>, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        let mut outcome = db
            .query_row(
                "SELECT operation,skill_id,success,code,skill_level,remaining_sp,mp FROM skill_actions WHERE account_id=?1 AND request_id=?2",
                params![account_id, request_id],
                |row| {
                    Ok(SkillActionOutcome {
                        operation: row.get(0)?,
                        skill_id: row.get::<_, i64>(1)?.try_into().unwrap_or(0),
                        success: row.get::<_, i64>(2)? != 0,
                        code: row.get(3)?,
                        level: row.get::<_, i64>(4)?.try_into().unwrap_or(0),
                        remaining_sp: row.get::<_, i64>(5)?.try_into().unwrap_or(0),
                        mp: row.get(6)?,
                        already_resolved: true,
                    })
                },
            )
            .optional()
            .map_err(|_| "account persistence failed")?;
        if let Some(value) = outcome.as_mut() {
            if value.operation != operation || value.skill_id != skill_id {
                value.success = false;
                value.code = "request_conflict".to_owned();
            }
        }
        Ok(outcome)
    }

    fn hyper_skill_action(
        &self,
        account_id: &str,
        request_id: &str,
        operation: &str,
        skill_id: u32,
        expected_job: u32,
        book_id: u32,
        _max_level: u32,
        _prerequisites: &BTreeMap<u32, u32>,
        _hidden: bool,
        mp_cost: i64,
        cooldown_ms: i64,
        cooldown_skill_id: u32,
    ) -> Result<SkillActionOutcome, String> {
        let (kind, required_level) =
            hyper_skill_info(skill_id).ok_or_else(|| "unknown Hyper skill".to_owned())?;
        let cooldown_key = if cooldown_skill_id == 0 {
            skill_id
        } else {
            cooldown_skill_id
        };
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        if let Some(mut outcome) = tx
            .query_row(
                "SELECT operation,skill_id,success,code,skill_level,remaining_sp,mp FROM skill_actions WHERE account_id=?1 AND request_id=?2",
                params![account_id, request_id],
                |row| {
                    Ok(SkillActionOutcome {
                        operation: row.get(0)?,
                        skill_id: row.get::<_, i64>(1)?.try_into().unwrap_or(0),
                        success: row.get::<_, i64>(2)? != 0,
                        code: row.get(3)?,
                        level: row.get::<_, i64>(4)?.try_into().unwrap_or(0),
                        remaining_sp: row.get::<_, i64>(5)?.try_into().unwrap_or(0),
                        mp: row.get(6)?,
                        already_resolved: true,
                    })
                },
            )
            .optional()
            .map_err(|_| "account persistence failed")?
        {
            if outcome.operation != operation || outcome.skill_id != skill_id {
                outcome.success = false;
                outcome.code = "request_conflict".to_owned();
            }
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(outcome);
        }
        if cooldown_ms < 0 {
            return Err("invalid skill cooldown".to_owned());
        }
        let (job, level, current_mp, skills_json): (i64, i64, i64, String) = tx
            .query_row(
                "SELECT job,level,mp,skills_json FROM player_stats WHERE account_id=?1",
                [account_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(|_| "account persistence failed")?;
        let current_level = u32::try_from(level.max(0)).unwrap_or(0);
        let mut skills = parse_skill_map(&skills_json)?;
        let current_skill_level = skills.get(&skill_id).copied().unwrap_or(0).min(1);
        let mut next_skill_level = current_skill_level;
        let mut next_mp = current_mp.max(0);
        let mut success = true;
        let mut code = String::new();
        if job != i64::from(FOURTH_JOB) || expected_job != FOURTH_JOB || book_id != FOURTH_MAGE_BOOK
        {
            success = false;
            code = "wrong_job".to_owned();
        } else if hyper_skill_hidden(skill_id) {
            success = false;
            code = "skill_hidden".to_owned();
        } else if current_level < required_level {
            success = false;
            code = "level_requirement".to_owned();
        } else if !matches!(operation, "learn" | "cast") {
            success = false;
            code = "invalid_operation".to_owned();
        } else if operation == "learn" {
            if current_skill_level >= 1 {
                success = false;
                code = "max_level".to_owned();
            } else if hyper_skill_prerequisites(skill_id)
                .iter()
                .any(|(prerequisite, required)| {
                    skills.get(prerequisite).copied().unwrap_or(0) < *required
                })
            {
                success = false;
                code = "prerequisite".to_owned();
            } else if hyper_points(current_level, &skills, kind) == 0 {
                success = false;
                code = "not_enough_hyper_points".to_owned();
            } else {
                next_skill_level = 1;
                skills.insert(skill_id, next_skill_level);
            }
        } else if current_skill_level == 0 {
            success = false;
            code = "not_learned".to_owned();
        } else if kind == 1 && skill_id != 2_221_045 {
            success = false;
            code = "skill_passive".to_owned();
        } else if mp_cost < 0 || current_mp < mp_cost {
            success = false;
            code = "not_enough_mp".to_owned();
        } else {
            // World emits each authorized 2221052 channel pulse as a fresh
            // request with the fixed 30 MP charge and cooldown_ms=0.  The
            // initial cast owns the durable 60-second cooldown; pulses must
            // charge MP without being mistaken for a second initial cast.
            let authorized_hyper_pulse =
                skill_id == HYPER_THUNDER_SKILL && cooldown_ms == 0 && mp_cost == 30;
            if !authorized_hyper_pulse {
                let now = now_ms();
                let ready_at: Option<i64> = tx
                    .query_row(
                        "SELECT ready_at_ms FROM skill_cooldowns WHERE account_id=?1 AND skill_id=?2",
                        params![account_id, i64::from(cooldown_key)],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|_| "account persistence failed")?;
                if ready_at.is_some_and(|value| value > now) {
                    success = false;
                    code = "skill_cooldown".to_owned();
                }
            }
            if success {
                next_mp = current_mp - mp_cost;
            }
        }
        let remaining_sp = hyper_points(current_level, &skills, kind);
        tx.execute(
            "INSERT INTO skill_actions(account_id,request_id,operation,skill_id,success,code,skill_level,remaining_sp,mp,quoted_cost) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,0)",
            params![
                account_id,
                request_id,
                operation,
                i64::from(skill_id),
                if success { 1 } else { 0 },
                code.clone(),
                i64::from(next_skill_level),
                i64::from(remaining_sp),
                next_mp,
            ],
        )
        .map_err(|_| "account persistence failed")?;
        if success {
            let changed = tx
                .execute(
                    "UPDATE player_stats SET skills_json=?2,mp=?3 WHERE account_id=?1",
                    params![account_id, serialize_skill_map(&skills)?, next_mp],
                )
                .map_err(|_| "account persistence failed")?;
            if changed != 1 {
                return Err("account persistence failed".to_owned());
            }
            if operation == "cast" && cooldown_ms > 0 {
                let ready_at = now_ms().saturating_add(cooldown_ms);
                tx.execute(
                    "INSERT INTO skill_cooldowns(account_id,skill_id,ready_at_ms) VALUES(?1,?2,?3)
                     ON CONFLICT(account_id,skill_id) DO UPDATE SET ready_at_ms=excluded.ready_at_ms",
                    params![account_id, i64::from(cooldown_key), ready_at],
                )
                .map_err(|_| "account persistence failed")?;
            }
        }
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(SkillActionOutcome {
            operation: operation.to_owned(),
            skill_id,
            success,
            code,
            level: next_skill_level,
            remaining_sp,
            mp: next_mp,
            already_resolved: false,
        })
    }

    pub(super) fn skill_action(
        &self,
        account_id: &str,
        request_id: &str,
        operation: &str,
        skill_id: u32,
        expected_job: u32,
        book_id: u32,
        max_level: u32,
        prerequisites: &BTreeMap<u32, u32>,
        hidden: bool,
        mp_cost: i64,
        cooldown_ms: i64,
        cooldown_skill_id: u32,
    ) -> Result<SkillActionOutcome, String> {
        if hyper_skill_info(skill_id).is_some() {
            return self.hyper_skill_action(
                account_id,
                request_id,
                operation,
                skill_id,
                expected_job,
                book_id,
                max_level,
                prerequisites,
                hidden,
                mp_cost,
                cooldown_ms,
                cooldown_skill_id,
            );
        }
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        if let Some(mut outcome) = tx
            .query_row(
                "SELECT operation,skill_id,success,code,skill_level,remaining_sp,mp FROM skill_actions WHERE account_id=?1 AND request_id=?2",
                params![account_id, request_id],
                |row| {
                    Ok(SkillActionOutcome {
                        operation: row.get(0)?,
                        skill_id: row.get::<_, i64>(1)?.try_into().unwrap_or(0),
                        success: row.get::<_, i64>(2)? != 0,
                        code: row.get(3)?,
                        level: row.get::<_, i64>(4)?.try_into().unwrap_or(0),
                        remaining_sp: row.get::<_, i64>(5)?.try_into().unwrap_or(0),
                        mp: row.get(6)?,
                        already_resolved: true,
                    })
                },
            )
            .optional()
            .map_err(|_| "account persistence failed")?
        {
            if outcome.operation != operation || outcome.skill_id != skill_id {
                outcome.success = false;
                outcome.code = "request_conflict".to_owned();
            }
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(outcome);
        }
        if cooldown_ms < 0 {
            return Err("invalid skill cooldown".to_owned());
        }
        let (job, current_mp, skills_json, skill_points_json): (i64, i64, String, String) = tx
            .query_row(
                "SELECT job,mp,skills_json,skill_points_json FROM player_stats WHERE account_id=?1",
                [account_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(|_| "account persistence failed")?;
        let mut skills = parse_skill_map(&skills_json)?;
        let mut skill_points = parse_skill_map(&skill_points_json)?;
        let mut success = true;
        let mut code = String::new();
        // 职业准入只有一份判据：`mage::book_jobs`（书的编号就是职业号，按分支与转职层级派生）。
        // 改前这里写着一串 `expected_job == ...` 的臂，只认 0/200/220/221/222 五本书
        // ⇒ 火毒与主教分支**在落库这一层就被拒**（世界侧改好了也学不成）。
        let job_allowed = u32::try_from(job)
            .ok()
            .is_some_and(|job| crate::mage::skill_job_allowed(job, book_id));
        let current_level = skills.get(&skill_id).copied().unwrap_or(0);
        let mut next_level = current_level;
        let mut next_mp = current_mp.max(0);
        if !job_allowed
            || !crate::mage::BOOKS.contains(&book_id)
            || skill_id / 10_000 != book_id
            || expected_job != book_id
        {
            success = false;
            code = "wrong_job".to_owned();
        } else if book_id == 0
            && (!(1000..=1002).contains(&skill_id) || !(1..=3).contains(&max_level) || hidden)
        {
            success = false;
            code = "skill_unknown".to_owned();
        } else if skill_id == THIRD_HIDDEN_SKILL || FOURTH_HIDDEN_SKILLS.contains(&skill_id) {
            // 2211015 and the fourth-job hidden nodes are authored internal
            // effects.  They are never client-learnable or client-cast,
            // even if a caller tries to use the internal `hidden` bypass.
            success = false;
            code = "skill_hidden".to_owned();
        } else if skill_id == FOURTH_FIXED_SKILL {
            // The fixed level is granted by the transfer transaction only.
            success = false;
            code = "skill_fixed_level".to_owned();
        } else if operation == "cast" && FOURTH_PASSIVE_SKILLS.contains(&skill_id) {
            success = false;
            code = "skill_passive".to_owned();
        } else if operation == "learn" {
            if current_level >= max_level {
                success = false;
                code = "max_level".to_owned();
            } else if !hidden
                && prerequisites
                    .iter()
                    .any(|(id, required)| skills.get(id).copied().unwrap_or(0) < *required)
            {
                success = false;
                code = "prerequisite".to_owned();
            } else if !hidden && skill_points.get(&book_id).copied().unwrap_or(0) == 0 {
                success = false;
                code = "not_enough_sp".to_owned();
            } else {
                next_level = current_level + 1;
                skills.insert(skill_id, next_level);
                if !hidden {
                    let points = skill_points.entry(book_id).or_default();
                    *points -= 1;
                }
            }
        } else if current_level == 0 {
            success = false;
            code = "not_learned".to_owned();
        } else if mp_cost < 0 || current_mp < mp_cost {
            success = false;
            code = "not_enough_mp".to_owned();
        } else {
            next_mp = current_mp - mp_cost;
        }
        if success && operation == "cast" {
            let now = now_ms();
            let ready_at: Option<i64> = tx
                .query_row(
                    "SELECT ready_at_ms FROM skill_cooldowns WHERE account_id=?1 AND skill_id=?2",
                    params![account_id, i64::from(cooldown_skill_id)],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|_| "account persistence failed")?;
            if ready_at.is_some_and(|value| value > now) {
                success = false;
                code = "skill_cooldown".to_owned();
                next_mp = current_mp.max(0);
            }
        }
        let remaining_sp = skill_points.get(&book_id).copied().unwrap_or(0);
        tx.execute(
            "INSERT INTO skill_actions(account_id,request_id,operation,skill_id,success,code,skill_level,remaining_sp,mp) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                account_id,
                request_id,
                operation,
                i64::from(skill_id),
                if success { 1 } else { 0 },
                code.clone(),
                i64::from(next_level),
                i64::from(remaining_sp),
                next_mp,
            ],
        )
        .map_err(|_| "account persistence failed")?;
        if success {
            tx.execute(
                "UPDATE player_stats SET skills_json=?2,skill_points_json=?3,mp=?4 WHERE account_id=?1",
                params![
                    account_id,
                    serialize_skill_map(&skills)?,
                    serialize_skill_map(&skill_points)?,
                    next_mp,
                ],
            )
            .map_err(|_| "account persistence failed")?;
            if operation == "cast" && cooldown_ms > 0 {
                let ready_at = now_ms().saturating_add(cooldown_ms);
                tx.execute(
                    "INSERT INTO skill_cooldowns(account_id,skill_id,ready_at_ms) VALUES(?1,?2,?3)
                     ON CONFLICT(account_id,skill_id) DO UPDATE SET ready_at_ms=excluded.ready_at_ms",
                    params![account_id, i64::from(cooldown_skill_id), ready_at],
                )
                .map_err(|_| "account persistence failed")?;
            }
        }
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(SkillActionOutcome {
            operation: operation.to_owned(),
            skill_id,
            success,
            code,
            level: next_level,
            remaining_sp,
            mp: next_mp,
            already_resolved: false,
        })
    }
}
