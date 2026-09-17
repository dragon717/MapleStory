//! 战斗数值公式（`PlayerConfig` 的派生方法）。
//!
//! 负责：玩家攻击数值与范围的来源公式（`attack_damage` / `attack_range_against` /
//! `attack_damage_against` / `attack_range` / `attack_bounds`）、怪物接触伤害
//! （`contact_damage`，含 tenacity 击退折减口径）与装备派生
//! （`with_ability_stats` / `with_equipment`）。
//! 不负责：攻击结算流程（`attacks.rs`）、移动（`movement.rs`）、
//! 怪物模板数据（`MonsterTemplate` 定义留在 `world.rs`）。
//! 方法可见性 pub(super) 与原 private 可达范围相同；全为方法调用、无需 glob。

use super::*;

/// 装备实例对**一个源字段**的合计（`incSTR` / `incPAD` / `incPDD` / `incMAD` / `incMHP` /
/// `incMMP` / `incSpeed` …）。**这是唯一的装备折叠实现**：`with_equipment` 与
/// `attribute.rs` 的属性留痕都调它 ⇒「记下来的装备贡献」与「真正折进配置的值」
/// 不可能不一致（同一个纯函数、同一份 `equipped`）。
pub(super) fn equipment_field_sum(equipped: &[crate::protocol::InventoryItem], key: &str) -> i64 {
    equipped.iter().fold(0i64, |total, item| {
        total.saturating_add(inventory::equipment_attribute(item, key))
    })
}

impl PlayerConfig {
    pub(super) fn with_ability_stats(
        &self,
        ability_stats: &AbilityStats,
        equipped: &[crate::protocol::InventoryItem],
        job: u32,
    ) -> Self {
        let mut config = self.clone();
        config.base_str = Some(ability_stats.strength);
        config.base_dex = Some(ability_stats.dexterity);
        config.base_int = Some(ability_stats.intelligence);
        config.base_luk = Some(ability_stats.luck);
        config.with_equipment(equipped, job)
    }

    pub(super) fn with_equipment(
        &self,
        equipped: &[crate::protocol::InventoryItem],
        job: u32,
    ) -> Self {
        let bonus = |key: &str| equipment_field_sum(equipped, key);
        let mut derived = self.clone();
        derived.job = Some(job);
        derived.base_str = Some(self.base_str.unwrap_or(0).saturating_add(bonus("incSTR")));
        derived.base_dex = Some(self.base_dex.unwrap_or(0).saturating_add(bonus("incDEX")));
        derived.base_int = Some(self.base_int.unwrap_or(0).saturating_add(bonus("incINT")));
        derived.base_luk = Some(self.base_luk.unwrap_or(0).saturating_add(bonus("incLUK")));
        // The old fixed 17 PAD / 3 PDD describe the starter sword and shirt.
        // Equipped items replace those values, so reconnects cannot add them twice.
        derived.weapon_watk = Some(bonus("incPAD").max(0));
        derived.weapon_defense = Some(bonus("incPDD").max(0));
        derived.weapon_type = Some(
            equipped
                .iter()
                .find(|item| item.slot == 11)
                .and_then(|item| item.item_id.parse::<i64>().ok())
                .unwrap_or(0)
                / 10_000,
        );
        derived.max_hp = Some(
            self.max_hp
                .unwrap_or(1)
                .saturating_add(bonus("incMHP"))
                .max(1),
        );
        derived.max_mp = Some(
            self.max_mp
                .unwrap_or(0)
                .saturating_add(bonus("incMMP"))
                .max(0),
        );
        derived
    }

    /// Reproduces the regular physical damage interval used by the local
    /// Mapleweb reference (`CharStats.cpp`, lines 80-85 and 95-142).
    #[allow(dead_code)] // kept for the Mapleweb reference damage model; combat uses skill paths.
    pub(super) fn attack_damage(&self) -> i64 {
        let (min, max) = self.attack_range();
        if max <= min {
            min
        } else {
            rand::thread_rng().gen_range(min..=max)
        }
    }

    /// HeavenClient/Mob.cpp applies level difference and PDD to the raw
    /// interval, then samples a float and truncates it to an integer.
    pub(super) fn attack_range_against(
        &self,
        player_level: u32,
        monster: &MonsterTemplate,
    ) -> (f64, f64) {
        let (min, max) = self.attack_range();
        if let Some(rate) = monster.pd_rate {
            let factor = (1.0 - rate / 100.0).max(0.0);
            return (
                (min as f64 * factor).max(1.0),
                (max as f64 * factor).max(1.0),
            );
        }
        let level_delta = monster.level.saturating_sub(player_level) as f64;
        let factor = 1.0 - 0.01 * level_delta;
        let pdd = monster.pd_damage.unwrap_or(0).max(0) as f64;
        (
            (min as f64 * factor - pdd * 0.6).max(1.0),
            (max as f64 * factor - pdd * 0.5).max(1.0),
        )
    }

    pub(super) fn attack_damage_against(
        &self,
        player_level: u32,
        monster: &MonsterTemplate,
    ) -> i64 {
        let (min, max) = self.attack_range_against(player_level, monster);
        let damage = if max <= min {
            min
        } else {
            rand::thread_rng().gen_range(min..max)
        };
        damage.floor().max(1.0) as i64
    }

    pub(super) fn attack_range(&self) -> (i64, i64) {
        let str = self.base_str.unwrap_or(0).max(0) as f64;
        let dex = self.base_dex.unwrap_or(0).max(0) as f64;
        let int = self.base_int.unwrap_or(0).max(0) as f64;
        let luk = self.base_luk.unwrap_or(0).max(0) as f64;
        let weapon = self.weapon_type.unwrap_or(0);
        let job_group = self.job.unwrap_or(0) / 100;
        let (primary, secondary) = match job_group {
            2 => (int, luk),
            3 => (dex, str),
            4 => {
                let secondary = if weapon == 133 || weapon == 147 {
                    dex + str
                } else {
                    dex
                };
                (luk, secondary)
            }
            5 if weapon == 149 => (dex, str),
            5 => (str, dex),
            _ => (str, dex),
        };
        let weapon_multiplier = match weapon {
            130 => 4.0,
            131 | 132 | 137 | 138 => 4.4,
            133 | 145 | 146 | 147 | 149 => 3.6,
            140 => 4.6,
            141 | 142 | 148 => 4.8,
            143 | 144 => 5.0,
            _ => 0.0,
        };
        let watk = self.weapon_watk.unwrap_or(0).max(0) as f64;
        let multiplier = self.damage_percent.unwrap_or(0.0).max(0.0) + watk / 100.0;
        let mastery = self.mastery.unwrap_or(0.1).clamp(0.0, 1.0);
        let primary = primary * weapon_multiplier;
        let min = ((primary * 0.9 * mastery) + secondary) * multiplier;
        let max = (primary + secondary) * multiplier;
        let min = min.max(0.0).floor() as i64;
        let max = max.max(min as f64).floor() as i64;
        (min, max)
    }

    pub(super) fn attack_bounds(&self, facing: i8) -> Option<(f64, f64, f64, f64)> {
        let lt = self.attack_lt.as_ref()?;
        let rb = self.attack_rb.as_ref()?;
        let (left, right) = if facing < 0 {
            (lt.x, rb.x)
        } else {
            (-rb.x, -lt.x)
        };
        Some((left, right, lt.y, rb.y))
    }

    /// P adapter: source Mob.PADamage minus equipment PDD, minimum one.
    /// ponytail: flat defense only; replace when verified TMS273 received-damage
    /// rules are available. Do not restore the pre-BB standard-PDD table.
    ///
    /// Reference formula pinned for the acceptance suite; the live contact
    /// path (`monsters.rs::apply_contact_damage`) keeps its own inline rule.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn contact_damage(&self, monster: &MonsterTemplate) -> Option<i64> {
        if !monster.body_attack {
            return None;
        }
        Some(
            monster
                .pa_damage?
                .max(0)
                .saturating_sub(self.weapon_defense.unwrap_or(0).max(0))
                .max(1),
        )
    }
}
