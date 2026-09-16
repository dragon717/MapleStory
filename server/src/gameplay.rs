//! 数据驱动定义的加载与规则校验。
//!
//! 负责：`Gameplay` 配置的加载与全套校验（`load` / `validate` / 延迟掉落应用 /
//! 刷怪与任务地图交叉校验），以及任务定义 `QuestSpec` 的规则判定
//! （`valid_reward` / `executable` / `valid_execution`）。
//! 不负责：任务运行时进度与效果结算（`quest.rs`）、怪物/掉落的运行时行为
//! （`monsters.rs` / 运行时 drops）、配置类型定义（struct 留在 `world.rs`）。
//! 方法可见性：pub 保持 pub（`main` 直接调用 `Gameplay::load`/`validate`），
//! 私有改 pub(super) 可达范围不变；全为方法调用、无需 glob。

use super::*;

impl QuestSpec {
    pub(super) fn valid_reward(&self) -> bool {
        self.reward
            .items
            .iter()
            .all(|item| !item.item_id.is_empty() && item.quantity > 0)
    }

    pub(super) fn executable(&self) -> bool {
        self.executable.unwrap_or(false)
    }

    pub(super) fn valid_execution(&self) -> bool {
        if !self.executable() {
            return true;
        }
        let valid_conditions = |conditions: &QuestConditions| {
            conditions
                .items
                .iter()
                .all(|item| !item.item_id.is_empty() && item.quantity > 0)
                && conditions
                    .equipped_items
                    .iter()
                    .all(|item_id| !item_id.trim().is_empty())
                && conditions
                    .quests
                    .iter()
                    .all(|quest| !quest.quest_id.is_empty())
        };
        let valid_consume = match &self.complete.consume_items {
            serde_json::Value::Array(items) => items.iter().all(|item| {
                item.get("itemId")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|item_id| !item_id.is_empty())
                    && item
                        .get("quantity")
                        .and_then(serde_json::Value::as_u64)
                        .is_some_and(|quantity| quantity > 0)
            }),
            serde_json::Value::Bool(_) | serde_json::Value::Null => true,
            _ => false,
        };
        valid_conditions(&self.start.conditions)
            && valid_conditions(&self.complete.conditions)
            && valid_consume
            && self
                .start_items
                .iter()
                .all(|item| !item.item_id.is_empty() && item.quantity > 0)
            && self.objectives.iter().all(|objective| {
                // A kill objective names a monster template instead of an
                // item; both shapes must be complete before the spec runs.
                objective.required > 0
                    && if objective._kind == "kill" {
                        !objective.mob_id.trim().is_empty()
                    } else {
                        !objective.item_id.is_empty()
                    }
            })
            && self.interaction.as_ref().is_none_or(|interaction| {
                !interaction.map_id.is_empty()
                    && !interaction.item_id.is_empty()
                    && interaction.quantity > 0
                    && interaction.range.is_finite()
                    && interaction.range > 0.0
                    && interaction.x.is_finite()
                    && interaction.y.is_finite()
            })
    }
}

impl Gameplay {
    pub fn load(path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let mut gameplay: Self = serde_json::from_str(&std::fs::read_to_string(path)?)?;
        gameplay.apply_deferred_quest_drops()?;
        gameplay.validate()?;
        Ok(gameplay)
    }

    pub fn validate(&self) -> Result<(), Box<dyn std::error::Error>> {
        if self
            .content_version
            .as_deref()
            .is_some_and(|version| version != crate::protocol::CONTENT_VERSION)
        {
            return Err("incompatible gameplay content version".into());
        }
        if self.monsters.iter().any(|template| {
            template.template_id.is_empty()
                || template.level == 0
                || template.max_hp < 1
                || template.max_mp < 0
                || template
                    .move_speed
                    .is_some_and(|speed| !speed.is_finite() || speed < 0.0)
                || template
                    .source_speed
                    .is_some_and(|speed| !speed.is_finite() || speed < -100.0)
                || template.pd_damage.is_some_and(|damage| damage < 0)
                || template
                    .pd_rate
                    .is_some_and(|rate| !rate.is_finite() || rate < 0.0)
                || template
                    .md_rate
                    .is_some_and(|rate| !rate.is_finite() || !(0.0..=100.0).contains(&rate))
                || template.stand_delay_ms.is_some_and(|delay| delay == 0)
                || template
                    .move_duration_ms
                    .is_some_and(|duration| duration == 0)
                || template
                    .hitbox_width
                    .is_some_and(|width| !width.is_finite() || width <= 0.0)
                || template
                    .hitbox_height
                    .is_some_and(|height| !height.is_finite() || height <= 0.0)
                || match (&template.hitbox_lt, &template.hitbox_rb) {
                    (Some(lt), Some(rb)) => {
                        ![lt.x, lt.y, rb.x, rb.y]
                            .iter()
                            .all(|value| value.is_finite())
                            || lt.x >= rb.x
                            || lt.y >= rb.y
                    }
                    (None, None) => false,
                    _ => true,
                }
                || template.drops().iter().any(|drop| {
                    drop.item_id.is_empty()
                        || drop.quantity == 0
                        || drop.quantity_max.is_some_and(|max| max < drop.quantity)
                        || drop.quest_id.as_deref().is_some_and(str::is_empty)
                        || drop.chance.is_some_and(|chance| {
                            self.drop_chance_denominator
                                .is_none_or(|denominator| denominator == 0 || chance > denominator)
                        })
                })
        }) {
            return Err("invalid gameplay monster template".into());
        }
        if self.spawns.iter().any(|spawn| {
            spawn.id.is_empty()
                || spawn.template_id.is_empty()
                || ![spawn.x, spawn.y].iter().all(|x| x.is_finite())
                || (!spawn.map_id.is_empty() && spawn.map_id.trim().is_empty())
                || ![-1, 1].contains(&spawn.facing)
                || spawn.mob_time < -1
                || match (spawn.rx0, spawn.rx1) {
                    (Some(rx0), Some(rx1)) => !rx0.is_finite() || !rx1.is_finite() || rx0 > rx1,
                    (None, None) => false,
                    _ => true,
                }
        }) {
            return Err("invalid gameplay monster spawn".into());
        }
        if self.spawns.iter().enumerate().any(|(index, spawn)| {
            self.spawns[..index]
                .iter()
                .any(|prior| prior.id == spawn.id)
        }) {
            return Err("duplicate gameplay monster spawn id".into());
        }
        if self.monsters.iter().enumerate().any(|(index, template)| {
            self.monsters[..index]
                .iter()
                .any(|prior| prior.template_id == template.template_id)
        }) {
            return Err("duplicate gameplay monster template id".into());
        }
        if self
            .player
            .attack_reach
            .is_some_and(|reach| !reach.is_finite() || reach <= 0.0)
            || self
                .player
                .attack_height
                .is_some_and(|height| !height.is_finite() || height <= 0.0)
            || self
                .player
                .climb_speed
                .is_some_and(|speed| !speed.is_finite() || speed <= 0.0)
            || self
                .player
                .mastery
                .is_some_and(|mastery| !mastery.is_finite() || !(0.0..=1.0).contains(&mastery))
            || self
                .player
                .damage_percent
                .is_some_and(|percent| !percent.is_finite() || percent < 0.0)
            || self.player.weapon_watk.is_some_and(|watk| watk < 0)
            || self.player.base_str.is_some_and(|value| value < 0)
            || self.player.base_dex.is_some_and(|value| value < 0)
            || self.player.base_int.is_some_and(|value| value < 0)
            || self.player.base_luk.is_some_and(|value| value < 0)
            || self.player.weapon_defense.is_some_and(|value| value < 0)
            || match (&self.player.attack_lt, &self.player.attack_rb) {
                (Some(lt), Some(rb)) => {
                    ![lt.x, lt.y, rb.x, rb.y]
                        .iter()
                        .all(|value| value.is_finite())
                        || lt.x >= rb.x
                        || lt.y >= rb.y
                }
                (None, None) => false,
                _ => true,
            }
        {
            return Err("invalid gameplay player combat/movement values".into());
        }
        if self
            .drop_chance_denominator
            .is_some_and(|denominator| denominator == 0)
        {
            return Err("invalid gameplay drop chance denominator".into());
        }
        if self
            .monster_respawn_ms
            .is_some_and(|interval| interval == 0)
        {
            return Err("invalid gameplay monster respawn interval".into());
        }
        if self
            .npcs
            .iter()
            .any(|template| template.template_id.is_empty() || template.name.is_empty())
        {
            return Err("invalid gameplay npc template".into());
        }
        if self.npcs.iter().enumerate().any(|(index, template)| {
            self.npcs[..index]
                .iter()
                .any(|prior| prior.template_id == template.template_id)
        }) {
            return Err("duplicate gameplay npc template id".into());
        }
        if self.npc_spawns.iter().any(|spawn| {
            spawn.id.is_empty()
                || spawn.template_id.is_empty()
                || ![spawn.x, spawn.y].iter().all(|value| value.is_finite())
                || ![-1, 1].contains(&spawn.facing)
        }) {
            return Err("invalid gameplay npc spawn".into());
        }
        if self.npc_spawns.iter().enumerate().any(|(index, spawn)| {
            self.npc_spawns[..index]
                .iter()
                .any(|prior| prior.id == spawn.id)
        }) {
            return Err("duplicate gameplay npc spawn id".into());
        }
        let template_ids: BTreeSet<&str> = self
            .npcs
            .iter()
            .map(|template| template.template_id.as_str())
            .collect();
        if self
            .npc_spawns
            .iter()
            .any(|spawn| !template_ids.contains(spawn.template_id.as_str()))
        {
            return Err("npc spawn references unknown npc template".into());
        }
        for template in &self.npcs {
            if let Some(script) = &template.script {
                script
                    .validate(&template.template_id)
                    .map_err(|error| format!("invalid npc dialogue: {error}"))?;
            }
        }
        for shop in &self.shops {
            if shop.shop_id.is_empty()
                || shop.npc_id.is_empty()
                || shop.items.is_empty()
                || shop
                    .items
                    .iter()
                    .any(|entry| entry.item_id.is_empty() || entry.price == 0)
            {
                return Err("invalid gameplay shop".into());
            }
            if shop.items.iter().enumerate().any(|(index, entry)| {
                shop.items[..index]
                    .iter()
                    .any(|prior| prior.item_id == entry.item_id)
            }) {
                return Err("duplicate gameplay shop item".into());
            }
            if !template_ids.contains(shop.npc_id.as_str()) {
                return Err("shop references unknown npc template".into());
            }
        }
        for quest in &self.quests {
            if quest.quest_id.trim().is_empty() || !quest.valid_reward() || !quest.valid_execution()
            {
                return Err("invalid gameplay quest".into());
            }
        }
        for index in 0..self.quests.len() {
            let quest = &self.quests[index].quest_id;
            if self.quests[..index]
                .iter()
                .any(|prior| prior.quest_id == *quest)
            {
                return Err("duplicate gameplay quest id".into());
            }
        }
        let quest_ids: BTreeSet<&str> = self
            .quests
            .iter()
            .map(|quest| quest.quest_id.as_str())
            .collect();
        for quest in self.quests.iter().filter(|quest| quest.executable()) {
            // 源 `Check/0/npc` / `Check/1/npc` 缺失的相位在装配里是空模板 id，
            // 表示"这一侧没有 NPC"（自服务任务），不是"引用了不存在的 NPC"。
            // 服务端其余部位已经按这个口径读（`quest.rs` 的 targetNpcId 先
            // `.filter(|id| !id.is_empty())`），这条加载校验此前漏了同一处理：
            // 一旦某条自服务任务转为可执行（例如 36315），它会把空串当成未知
            // NPC 直接拒绝加载整个 gameplay.json，服务端起不来。空串按"无 NPC"
            // 处理；只有**非空**却查不到的 id 才是错误。
            let unknown_npc = |phase: &QuestPhase| {
                phase
                    .npc_id
                    .as_deref()
                    .filter(|npc_id| !npc_id.is_empty())
                    .is_some_and(|npc_id| !template_ids.contains(npc_id))
            };
            if unknown_npc(&quest.start)
                || unknown_npc(&quest.complete)
                || quest
                    .start
                    .conditions
                    .quests
                    .iter()
                    .chain(quest.complete.conditions.quests.iter())
                    .any(|requirement| !quest_ids.contains(requirement.quest_id.as_str()))
            {
                return Err("quest references unknown npc or prerequisite".into());
            }
        }
        // An export that lost its sticker ids or authored a nonsensical send
        // budget would silently turn every emoticon intent into a rejection, so
        // it is a load error rather than a runtime surprise.
        if let Some(emoticons) = &self.emoticons {
            let ids: BTreeSet<&str> = emoticons.ids.iter().map(String::as_str).collect();
            if emoticons.ids.is_empty()
                || ids.len() != emoticons.ids.len()
                || emoticons.limit.count == 0
                || emoticons.limit.time_ms == 0
            {
                return Err("emoticon catalogue is malformed".into());
            }
        }
        Ok(())
    }

    pub(super) fn apply_deferred_quest_drops(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        for drop in &self.sources.drops.deferred_quest_drops {
            let template = self
                .monsters
                .iter_mut()
                .find(|template| template.template_id == drop.template_id)
                .ok_or_else(|| {
                    format!(
                        "deferred quest drop references unknown monster template {}",
                        drop.template_id
                    )
                })?;

            let mut drops = template.drops();
            drops.push(DropSpec {
                item_id: drop.item_id.clone(),
                quantity: drop.minimum,
                quantity_max: drop.maximum,
                chance: drop.chance,
                quest_id: Some(drop.quest_id.clone()),
            });
            template.drop = Some(DropInput::Many(drops));
        }
        Ok(())
    }

    pub(super) fn validate_spawns_against_maps(
        &self,
        maps: &BTreeMap<String, Map>,
        birth_map_id: &str,
    ) -> Result<(), String> {
        for spawn in &self.spawns {
            let map_id = if spawn.map_id.is_empty() {
                birth_map_id
            } else {
                spawn.map_id.as_str()
            };
            let map = maps.get(map_id).ok_or_else(|| {
                format!(
                    "monster spawn {} references unknown map {}",
                    spawn.id, map_id
                )
            })?;
            if !(map.bounds.x_min..=map.bounds.x_max).contains(&spawn.x)
                || !(map.bounds.y_min..=map.bounds.y_max).contains(&spawn.y)
            {
                return Err(format!(
                    "monster spawn {} is outside map {} bounds",
                    spawn.id, map_id
                ));
            }
            if let Some(foothold_id) = spawn.foothold_id {
                let foothold = map.get(foothold_id).ok_or_else(|| {
                    format!(
                        "monster spawn {} references unknown foothold {} on map {}",
                        spawn.id, foothold_id, map_id
                    )
                })?;
                if foothold.is_wall() || !foothold.contains_x(spawn.x) {
                    return Err(format!(
                        "monster spawn {} is off foothold {} on map {}",
                        spawn.id, foothold_id, map_id
                    ));
                }
            } else if map.ground_near(spawn.x, spawn.y).is_none() {
                return Err(format!(
                    "monster spawn {} has no foothold on map {}",
                    spawn.id, map_id
                ));
            }
        }
        Ok(())
    }

    pub(super) fn validate_quest_maps(&self, maps: &BTreeMap<String, Map>) -> Result<(), String> {
        for quest in self.quests.iter().filter(|quest| quest.executable()) {
            if let Some(interaction) = quest.interaction.as_ref() {
                if !maps.contains_key(&interaction.map_id) {
                    return Err(format!(
                        "quest {} interaction references unknown map {}",
                        quest.quest_id, interaction.map_id
                    ));
                }
            }
            for map_id in [
                quest.start.warp_map_id.as_ref(),
                quest.complete.warp_map_id.as_ref(),
            ]
            .into_iter()
            .flatten()
            {
                if !maps.contains_key(map_id) {
                    return Err(format!(
                        "quest {} warp references unknown map {}",
                        quest.quest_id, map_id
                    ));
                }
            }
            if let Some(map_id) = quest.return_map_id.as_ref() {
                if !maps.contains_key(map_id) {
                    return Err(format!(
                        "quest {} return references unknown map {}",
                        quest.quest_id, map_id
                    ));
                }
            }
        }
        Ok(())
    }
}
