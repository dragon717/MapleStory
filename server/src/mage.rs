use serde::Deserialize;
use std::{collections::BTreeMap, path::Path};

fn default_book_id() -> u32 {
    200
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MageSkills {
    #[serde(default)]
    pub source_version: String,
    #[serde(default)]
    pub book_id: u32,
    #[serde(default)]
    pub skills: BTreeMap<String, MageSkill>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MageSkill {
    pub name: String,
    pub max_level: u32,
    #[serde(default = "default_book_id")]
    pub book_id: u32,
    /// TMS273 Skill/221 carries the elemental marker on the skill node rather
    /// than on every level.  Keep it optional because the older 200/220
    /// catalog does not export it.
    #[serde(default, rename = "elemAttr")]
    pub elem_attr: Option<String>,
    #[serde(default)]
    pub prerequisites: BTreeMap<String, u32>,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub fixed_level: bool,
    /// TMS273 Hyper pool: 0 ordinary, 1 passive pool, 2 active pool.
    /// Hidden 2221055 is retained in the catalog as a source node but is
    /// never exposed as a learnable skill by World.
    #[serde(default)]
    pub hyper: u32,
    #[serde(default, rename = "requiredLevel")]
    pub required_level: u32,
    #[serde(default)]
    pub booster_action_speed: Option<i64>,
    pub levels: Vec<MageLevel>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MageLevel {
    pub mp_con: Option<i64>,
    pub z: Option<i64>,
    #[serde(rename = "costmpR")]
    pub costmp_r: Option<i64>,
    #[serde(rename = "damR")]
    pub dam_r: Option<i64>,
    #[serde(rename = "criticaldamage")]
    pub critical_damage: Option<i64>,
    #[serde(rename = "subProp")]
    pub sub_prop: Option<i64>,
    #[serde(rename = "mdR")]
    pub md_r: Option<i64>,
    pub cooltime: Option<i64>,
    /// 用户指定规则字段（2026-09-10，**非 TMS273 源字段**）：等級冷卻，单位毫秒。
    /// 目前只有 2001009 瞬移使用；由 `scripts/tms273_skill_manifest.cjs` 的
    /// USER_SPECIFIED_SKILL_RULES 写入（原版瞬移没有 cooltime，数值为 P）。
    pub cooldown_ms: Option<i64>,
    /// 用户指定规则字段（2026-09-12，**非 TMS273 源字段**）：魔心防禦 2001002 的
    /// 逐级「MP 抵偿率」(%)，1 级 100、每级 -2、10 级正好 80。受伤的
    /// `world::MAGIC_GUARD_COVERED_PERCENT`% 由护罩接下、转由 MP 承受，其中本值 % 能被化去，
    /// 化不去的差额由护盾消解（不扣 HP、不扣 MP）；未被接下的那 1% 才落回 HP。
    /// 由 `scripts/tms273_skill_manifest.cjs` 的 USER_SPECIFIED_SKILL_RULES 写入；
    /// 原版 `x`（15+7*x = 22→85，「以 MP 代替的伤害百分比」）继续留在 `x`/`rawCommon`。
    pub mp_substitute_percent: Option<i64>,
    #[serde(rename = "asrR")]
    pub asr_r: Option<i64>,
    #[serde(rename = "terR")]
    pub ter_r: Option<i64>,
    #[serde(rename = "stanceProp")]
    pub stance_prop: Option<i64>,
    #[serde(rename = "madX")]
    pub mad_x: Option<i64>,
    #[serde(rename = "bufftimeR")]
    pub buff_time_r: Option<i64>,
    #[serde(rename = "basicStatUp")]
    pub basic_stat_up: Option<i64>,
    #[serde(rename = "attackDelay")]
    pub attack_delay: Option<i64>,
    #[serde(rename = "ignoreMobpdpR")]
    pub ignore_mob_pdp_r: Option<i64>,
    #[serde(rename = "hcHp")]
    pub hc_hp: Option<i64>,
    pub speed: Option<i64>,
    pub q: Option<i64>,
    pub q2: Option<i64>,
    #[serde(rename = "indieDamR")]
    pub indie_dam_r: Option<i64>,
    #[serde(rename = "targetPlus")]
    pub target_plus: Option<u32>,
    pub w2: Option<i64>,
    pub u2: Option<i64>,
    #[serde(rename = "mmpR")]
    pub mmp_r: Option<i64>,
    pub lv2mmp: Option<i64>,
    pub action_speed: Option<i64>,
    pub mastery: Option<i64>,
    pub cr: Option<i64>,
    pub int_x: Option<i64>,
    pub indie_mad: Option<i64>,
    pub sub_time: Option<i64>,
    #[allow(dead_code)] // Parsed source field; movement semantics remain a P adapter.
    pub s: Option<i64>,
    pub pdd_x: Option<i64>,
    pub x: Option<i64>,
    pub y: Option<i64>,
    pub prop: Option<i64>,
    #[serde(rename = "fixdamage")]
    pub fixdamage: Option<i64>,
    pub time: Option<i64>,
    pub v: Option<i64>,
    pub w: Option<i64>,
    pub u: Option<i64>,
    pub psd_speed: Option<i64>,
    pub speed_max: Option<i64>,
    pub range: Option<i64>,
    pub mob_count: Option<u32>,
    pub damage: Option<i64>,
    pub attack_count: Option<u32>,
    pub max_use_count_in_one_jump: Option<u32>,
    #[serde(default)]
    pub lt: Option<MagePoint>,
    #[serde(default)]
    pub rb: Option<MagePoint>,
}

#[derive(Clone, Copy, Deserialize)]
pub struct MagePoint {
    pub x: f64,
    pub y: f64,
}

impl MageSkills {
    pub fn load(path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let skills: Self = serde_json::from_str(&std::fs::read_to_string(path)?)?;
        skills.validate()?;
        Ok(skills)
    }

    #[cfg(test)]
    pub fn bundled() -> Self {
        let skills: Self = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../shared/mage-skills.json"
        )))
        .expect("shared/mage-skills.json must be valid");
        skills
            .validate()
            .expect("bundled mage skills must be valid");
        skills
    }

    pub fn validate(&self) -> Result<(), Box<dyn std::error::Error>> {
        const BEGINNER_IDS: [u32; 3] = [1_000, 1_001, 1_002];
        const FIRST_JOB_IDS: [u32; 8] = [
            2_000_006, 2_000_007, 2_000_010, 2_001_002, 2_001_008, 2_001_009, 2_001_011, 2_001_012,
        ];
        const SECOND_JOB_IDS: [u32; 9] = [
            2_200_000, 2_200_006, 2_200_007, 2_200_011, 2_200_012, 2_201_001, 2_201_005, 2_201_008,
            2_201_009,
        ];
        const THIRD_JOB_IDS: [u32; 12] = [
            2_210_000, 2_210_001, 2_210_009, 2_210_013, 2_210_016, 2_211_002, 2_211_007, 2_211_011,
            2_211_012, 2_211_014, 2_211_015, 2_211_017,
        ];
        const FOURTH_JOB_IDS: [u32; 11] = [
            2_220_010, 2_220_013, 2_220_015, 2_221_000, 2_221_004, 2_221_005, 2_221_006, 2_221_007,
            2_221_008, 2_221_011, 2_221_012,
        ];
        const HYPER_IDS: [u32; 13] = [
            2_220_043, 2_220_044, 2_221_045, 2_220_046, 2_220_047, 2_220_048, 2_220_049, 2_220_050,
            2_220_051, 2_221_052, 2_221_053, 2_221_054, 2_221_055,
        ];
        if self.source_version != "TMS273.7"
            || !matches!(self.skills.len(), 8 | 17 | 29 | 32 | 43 | 56)
            || self.skills.len() == 8 && self.book_id != 200
        {
            return Err("invalid TMS273 mage skill catalog".into());
        }
        for (id, skill) in &self.skills {
            let skill_id: u32 = id.parse().map_err(|_| "invalid mage skill id")?;
            let expected_book = if FIRST_JOB_IDS.contains(&skill_id) {
                200
            } else if SECOND_JOB_IDS.contains(&skill_id) {
                220
            } else if THIRD_JOB_IDS.contains(&skill_id) {
                221
            } else if FOURTH_JOB_IDS.contains(&skill_id) {
                222
            } else if HYPER_IDS.contains(&skill_id) {
                222
            } else if BEGINNER_IDS.contains(&skill_id) {
                0
            } else {
                0
            };
            if !BEGINNER_IDS.contains(&skill_id) && expected_book == 0
                || skill.book_id != expected_book
                || skill.max_level == 0
                || skill.max_level > 100
                || skill.levels.len() != skill.max_level as usize
                || skill.name.is_empty()
                || skill.hyper > 2
                || (skill.hyper == 0 && skill.required_level != 0)
                || (skill.hyper > 0 && (skill.book_id != 222 || skill.max_level != 1))
                || (skill.hyper > 0 && skill.required_level < 140)
                || skill
                    .elem_attr
                    .as_deref()
                    .is_some_and(|value| !matches!(value, "i" | "l"))
                || skill.levels.iter().any(|level| {
                    level.mp_con.is_some_and(|value| value < 0)
                        || level.damage.is_some_and(|value| value < 0)
                        || level
                            .mastery
                            .is_some_and(|value| !(0..=100).contains(&value))
                        || level.cr.is_some_and(|value| !(0..=100).contains(&value))
                        || level.int_x.is_some_and(|value| value < 0)
                        || level.indie_mad.is_some_and(|value| value < 0)
                        || level.sub_time.is_some_and(|value| value < 0)
                        || level.z.is_some_and(|value| value < 0)
                        || level.costmp_r.is_some_and(|value| value < 0)
                        || level.dam_r.is_some_and(|value| value < 0)
                        || level.critical_damage.is_some_and(|value| value < 0)
                        || level
                            .sub_prop
                            .is_some_and(|value| !(0..=100).contains(&value))
                        || level.md_r.is_some_and(|value| value < 0)
                        || level.cooltime.is_some_and(|value| value < 0)
                        || level.cooldown_ms.is_some_and(|value| value < 0)
                        || level.mp_substitute_percent.is_some_and(|value| !(0..=100).contains(&value))
                        || level.asr_r.is_some_and(|value| !(0..=100).contains(&value))
                        || level.ter_r.is_some_and(|value| !(0..=100).contains(&value))
                        || level.stance_prop.is_some_and(|value| value < 0)
                        || level.mad_x.is_some_and(|value| value < 0)
                        || level.buff_time_r.is_some_and(|value| value < 0)
                        || level.basic_stat_up.is_some_and(|value| value < 0)
                        || level.attack_delay.is_some_and(|value| value < 0)
                        || level
                            .ignore_mob_pdp_r
                            .is_some_and(|value| !(0..=100).contains(&value))
                        || level.hc_hp.is_some_and(|value| value < 0)
                        || level.speed.is_some_and(|value| value < 0)
                        || level.fixdamage.is_some_and(|value| value < 0)
                        || level.q.is_some_and(|value| value <= 0)
                        || level.q2.is_some_and(|value| value < 0)
                        || level.w2.is_some_and(|value| value < 0)
                        || level.u2.is_some_and(|value| value < 0)
                        || level.mob_count.is_some_and(|value| value == 0)
                        || level.attack_count.is_some_and(|value| value == 0)
                        || level.range.is_some_and(|value| value < 0)
                        || level.mob_count.is_some_and(|value| {
                            value
                                > if FOURTH_JOB_IDS.contains(&skill_id) || skill.hyper > 0 {
                                    15
                                } else {
                                    8
                                }
                        })
                        || level.attack_count.is_some_and(|value| {
                            value
                                > if FOURTH_JOB_IDS.contains(&skill_id) || skill.hyper > 0 {
                                    15
                                } else {
                                    4
                                }
                        })
                        || level
                            .lt
                            .is_some_and(|point| !point.x.is_finite() || !point.y.is_finite())
                        || level
                            .rb
                            .is_some_and(|point| !point.x.is_finite() || !point.y.is_finite())
                        || level
                            .lt
                            .zip(level.rb)
                            .is_some_and(|(lt, rb)| lt.x > rb.x || lt.y > rb.y)
                })
            {
                return Err(format!("invalid mage skill {skill_id}").into());
            }
            for (prerequisite, required_level) in &skill.prerequisites {
                let prerequisite_id: u32 = prerequisite
                    .parse()
                    .map_err(|_| format!("invalid mage prerequisite {skill_id}"))?;
                let Some(prerequisite_skill) = self.get(prerequisite_id) else {
                    return Err(format!("unknown mage prerequisite {prerequisite_id}").into());
                };
                if *required_level == 0 || *required_level > prerequisite_skill.max_level {
                    return Err(format!("invalid mage prerequisite level {skill_id}").into());
                }
            }
            let required = |present: bool, field: &str| {
                present
                    .then_some(())
                    .ok_or_else(|| format!("mage skill {skill_id} is missing {field}"))
            };
            for level in &skill.levels {
                match skill_id {
                    1_000 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.fixdamage.is_some(), "fixdamage")?;
                    }
                    1_001 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.time.is_some(), "time")?;
                        required(level.x.is_some(), "x")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                    }
                    1_002 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.time.is_some(), "time")?;
                        required(level.speed.is_some(), "speed")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                    }
                    2_000_006 => {
                        required(level.mmp_r.is_some(), "mmpR")?;
                        required(level.lv2mmp.is_some(), "lv2mmp")?;
                    }
                    2_000_007 => {
                        required(level.x.is_some(), "x")?;
                        required(level.prop.is_some(), "prop")?;
                        required(level.time.is_some(), "time")?;
                    }
                    2_000_010 => required(level.pdd_x.is_some(), "pddX")?,
                    2_001_002 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.x.is_some(), "x")?;
                        // 用户指定规则：结算不再用源 x，改用抵偿率阶梯。
                        required(level.mp_substitute_percent.is_some(), "mpSubstitutePercent")?;
                    }
                    2_001_008 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                        required(level.range.is_some(), "range")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                    }
                    2_001_009 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                        required(level.psd_speed.is_some(), "psdSpeed")?;
                        required(level.speed_max.is_some(), "speedMax")?;
                    }
                    2_001_011 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                    }
                    2_001_012 => {
                        required(level.time.is_some(), "time")?;
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.x.is_some(), "x")?;
                        required(level.v.is_some(), "v")?;
                        required(level.w.is_some(), "w")?;
                        required(level.u.is_some(), "u")?;
                        required(
                            level.max_use_count_in_one_jump.is_some(),
                            "maxUseCountInOneJump",
                        )?;
                    }
                    2_200_000 => {
                        required(level.prop.is_some(), "prop")?;
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                    }
                    2_200_006 => {
                        required(level.mastery.is_some(), "mastery")?;
                        required(level.x.is_some(), "x")?;
                        required(level.cr.is_some(), "cr")?;
                    }
                    2_200_007 | 2_200_012 => required(level.int_x.is_some(), "intX")?,
                    2_200_011 => {
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                    }
                    2_201_001 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.time.is_some(), "time")?;
                        required(level.indie_mad.is_some(), "indieMad")?;
                    }
                    2_201_005 | 2_201_008 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                    }
                    2_201_009 => {
                        required(level.damage.is_some(), "damage")?;
                        required(level.sub_time.is_some(), "subTime")?;
                        required(level.time.is_some(), "time")?;
                        required(level.prop.is_some(), "prop")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                    }
                    2_210_000 => required(level.z.is_some(), "z")?,
                    2_210_001 => {
                        required(level.costmp_r.is_some(), "costmpR")?;
                        required(level.dam_r.is_some(), "damR")?;
                    }
                    2_210_009 => {
                        required(level.cr.is_some(), "cr")?;
                        required(level.critical_damage.is_some(), "criticaldamage")?;
                    }
                    2_210_013 => {
                        required(level.prop.is_some(), "prop")?;
                        required(level.sub_prop.is_some(), "subProp")?;
                    }
                    2_210_016 => {
                        required(level.u.is_some(), "u")?;
                        required(level.md_r.is_some(), "mdR")?;
                    }
                    2_211_002 | 2_211_014 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.time.is_some(), "time")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                    }
                    2_211_007 => {
                        required(level.damage.is_some(), "damage")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.prop.is_some(), "prop")?;
                        required(level.sub_prop.is_some(), "subProp")?;
                        required(level.time.is_some(), "time")?;
                        required(level.y.is_some(), "y")?;
                        required(level.stance_prop.is_some(), "stanceProp")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                    }
                    2_211_011 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.time.is_some(), "time")?;
                        required(level.sub_time.is_some(), "subTime")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.s.is_some(), "s")?;
                        required(level.w.is_some(), "w")?;
                        required(level.q.is_some(), "q")?;
                        required(level.u2.is_some(), "u2")?;
                    }
                    2_211_012 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                        required(level.prop.is_some(), "prop")?;
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                        required(level.asr_r.is_some(), "asrR")?;
                        required(level.ter_r.is_some(), "terR")?;
                    }
                    2_211_015 => {
                        required(level.damage.is_some(), "damage")?;
                        required(level.time.is_some(), "time")?;
                        required(level.sub_time.is_some(), "subTime")?;
                        required(level.u2.is_some(), "u2")?;
                    }
                    2_211_017 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                    }
                    2_220_010 => {
                        required(level.ignore_mob_pdp_r.is_some(), "ignoreMobpdpR")?;
                        required(level.prop.is_some(), "prop")?;
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                        required(level.time.is_some(), "time")?;
                    }
                    2_220_013 => {
                        required(level.mad_x.is_some(), "madX")?;
                        required(level.buff_time_r.is_some(), "bufftimeR")?;
                        required(level.stance_prop.is_some(), "stanceProp")?;
                    }
                    2_220_015 => {
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                    }
                    2_221_000 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.basic_stat_up.is_some(), "basicStatUp")?;
                    }
                    2_221_004 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.time.is_some(), "time")?;
                        required(level.q.is_some(), "q")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.w.is_some(), "w")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                    }
                    2_221_005 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.time.is_some(), "time")?;
                        required(level.sub_time.is_some(), "subTime")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.mastery.is_some(), "mastery")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                    }
                    2_221_006 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.prop.is_some(), "prop")?;
                        required(level.time.is_some(), "time")?;
                        required(level.range.is_some(), "range")?;
                        required(level.cr.is_some(), "cr")?;
                    }
                    2_221_007 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.prop.is_some(), "prop")?;
                        required(level.time.is_some(), "time")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                        required(level.x.is_some(), "x")?;
                    }
                    2_221_008 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                        required(level.time.is_some(), "time")?;
                    }
                    2_221_011 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.time.is_some(), "time")?;
                        required(level.q.is_some(), "q")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                    }
                    2_221_012 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.time.is_some(), "time")?;
                        required(level.attack_delay.is_some(), "attackDelay")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                    }
                    2_220_043 | 2_220_046 | 2_220_049 => {
                        required(level.dam_r.is_some(), "damR")?;
                    }
                    2_220_044 | 2_220_047 | 2_220_050 => {
                        required(level.target_plus.is_some(), "targetPlus")?;
                    }
                    2_221_045 => required(level.x.is_some(), "x")?,
                    2_220_048 => required(level.attack_count.is_some(), "attackCount")?,
                    2_220_051 => required(level.cr.is_some(), "cr")?,
                    2_221_052 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                        required(level.q.is_some(), "q")?;
                        required(level.x.is_some(), "x")?;
                        required(level.w.is_some(), "w")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                        required(level.s.is_some(), "s")?;
                    }
                    2_221_053 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.time.is_some(), "time")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                        required(level.indie_dam_r.is_some(), "indieDamR")?;
                    }
                    2_221_054 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.y.is_some(), "y")?;
                        required(level.z.is_some(), "z")?;
                        required(level.w.is_some(), "w")?;
                        required(level.time.is_some(), "time")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.u.is_some(), "u")?;
                        required(level.q.is_some(), "q")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                    }
                    2_221_055 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.y.is_some(), "y")?;
                        required(level.z.is_some(), "z")?;
                        required(level.w.is_some(), "w")?;
                        required(level.time.is_some(), "time")?;
                        required(level.sub_time.is_some(), "subTime")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.u.is_some(), "u")?;
                        required(level.u2.is_some(), "u2")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                    }
                    _ => unreachable!(),
                }
            }
        }
        Ok(())
    }

    pub fn get(&self, skill_id: u32) -> Option<&MageSkill> {
        self.skills.get(&skill_id.to_string())
    }

    pub fn level(&self, skill_id: u32, level: u32) -> Option<&MageLevel> {
        level.checked_sub(1).and_then(|index| {
            self.get(skill_id)
                .and_then(|skill| skill.levels.get(index as usize))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_catalog_is_strict_and_has_energy_bolt_geometry() {
        let catalog = MageSkills::bundled();
        assert_eq!(catalog.skills.len(), 43);
        let bolt = catalog.get(2_001_008).expect("energy bolt catalog row");
        assert_eq!(bolt.max_level, 20);
        let level = catalog.level(2_001_008, 1).expect("energy bolt level 1");
        assert_eq!(level.mob_count, Some(4));
        assert_eq!(level.attack_count, Some(4));
        assert_eq!(level.range, Some(340));
        assert!(level.lt.is_some_and(|point| point.x <= point.y));
        assert!(catalog.get(2_000_007).is_some_and(|skill| skill.hidden));
        assert!(catalog.get(2_001_012).is_some_and(|skill| skill.hidden));
        let cold = catalog.get(2_201_008).expect("cold beam catalog row");
        assert_eq!(cold.book_id, 220);
        assert_eq!(
            catalog
                .level(2_201_008, 1)
                .and_then(|level| level.mob_count),
            Some(6)
        );
        assert!(catalog
            .get(2_200_011)
            .is_some_and(|skill| skill.fixed_level));
        let throw = catalog.level(1_000, 3).expect("beginner throw level 3");
        assert_eq!(throw.mp_con, Some(7));
        assert_eq!(throw.fixdamage, Some(40));
        assert_eq!(catalog.level(1_001, 3).and_then(|level| level.x), Some(12));
        assert_eq!(
            catalog.level(1_002, 3).and_then(|level| level.speed),
            Some(20)
        );
        assert!(catalog.get(2_211_015).is_some_and(|skill| skill.hidden));
    }
}
