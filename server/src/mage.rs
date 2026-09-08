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
    #[serde(default)]
    pub prerequisites: BTreeMap<String, u32>,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub fixed_level: bool,
    #[serde(default)]
    pub booster_action_speed: Option<i64>,
    pub levels: Vec<MageLevel>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MageLevel {
    pub mp_con: Option<i64>,
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
        const FIRST_JOB_IDS: [u32; 8] = [
            2_000_006, 2_000_007, 2_000_010, 2_001_002, 2_001_008, 2_001_009, 2_001_011, 2_001_012,
        ];
        const SECOND_JOB_IDS: [u32; 9] = [
            2_200_000, 2_200_006, 2_200_007, 2_200_011, 2_200_012, 2_201_001, 2_201_005, 2_201_008,
            2_201_009,
        ];
        if self.source_version != "TMS273.7"
            || !matches!(self.skills.len(), 8 | 17)
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
            } else {
                0
            };
            if expected_book == 0
                || skill.book_id != expected_book
                || skill.max_level == 0
                || skill.max_level > 100
                || skill.levels.len() != skill.max_level as usize
                || skill.name.is_empty()
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
                        || level.mob_count.is_some_and(|value| value == 0)
                        || level.attack_count.is_some_and(|value| value == 0)
                        || level.range.is_some_and(|value| value < 0)
                        || level.mob_count.is_some_and(|value| value > 6)
                        || level.attack_count.is_some_and(|value| value > 4)
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
        assert_eq!(catalog.skills.len(), 17);
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
    }
}
