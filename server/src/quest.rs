//! 任务职责：任务列表 / 详情 / NPC 菜单 / 交互与效果结算。
//!
//! 从 `world.rs` 机械搬出的第五块完整职责（超大文件治理 P2）。搬的是**代码位置**，
//! 不是数据布局：`Player` / `World` 的字段仍在原处，协议、存档与 Tick 次序均未改变。
//!
//! ## 负责
//! - **交互与结算的完整事务外观**：`handle_quest_interact` / `handle_quest_npc_menu`，
//!   以及 `apply_quest_effect_at`——在同一事务里推进状态、扣材料、发奖励，成功后才回执。
//! - NPC 侧的**任务表现**：菜单选项、目标文案与行、条目与日志。玩家语言的多语言文案
//!   来自 `crate::quest_text`，这里只负责取用与兜底（未知 id 退化为 id 本身，不出空白行）。
//! - 经验入账 `add_exp`：升级判定与进度归一化（`normalize_profile_progress`）都走这里。
//! - 任务**纯判定**（前置、条件、职业、阶段、消耗与奖励物品的形状归一化）已按
//!   计划 §6 抽到 `super::quest_rules`：那里不依赖整个 `World`，本模块通过
//!   `quest_facts` 把玩家收窄成最小事实集再调用。
//!
//! ## 不负责
//! - 任务**进度的事件来源**（击杀 / 拾取 / 到图）：那些 handler 留在 `world.rs` 与
//!   `super::inventory_ops`，它们调用这里的判定；"我已完成"永远不是事实来源
//! - 传送落点（`warp_player*` 留在 `world.rs`；路线目标只算出地图 id）
//! - 任务文本目录本身：`crate::quest_text`

use super::*;
use super::quest_rules;

/// 把完整 `Player` 收窄成任务判定所需的最小事实集（计划 §6.2）。
/// 判定函数不接收 `World`，只接收这份只读视图。
fn quest_facts(player: &Player) -> super::quest_rules::QuestFacts<'_> {
    super::quest_rules::QuestFacts {
        level: player.state.level,
        job: player.state.job,
        quests: &player.quests,
        inventory: &player.state.inventory,
        equipped: &player.state.equipped,
    }
}

impl World {
    fn quest_phase_matches_npc(phase: &QuestPhase, template_id: &str) -> bool {
        phase
            .npc_id
            .as_deref()
            .is_some_and(|npc_id| npc_id == template_id)
    }

    fn quest_objective_text(
        &self,
        value: &serde_json::Value,
        lang: &'static str,
    ) -> Option<String> {
        if let Some(text) = value.as_str().filter(|text| !text.is_empty()) {
            return Some(text.to_owned());
        }
        value
            .as_object()
            .and_then(|object| {
                object
                    .get(lang)
                    .or_else(|| object.get(crate::quest_text::LANG_ZH))
                    .or_else(|| object.get(crate::quest_text::LANG_EN))
            })
            .and_then(serde_json::Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    }

    fn quest_objective_rows(
        &self,
        spec: &QuestSpec,
        player: &Player,
        lang: &'static str,
    ) -> Vec<serde_json::Value> {
        let fallback = self.quest_summary(spec, "active", lang);
        if spec.objectives.is_empty() {
            return quest_rules::complete_items(spec)
                .into_iter()
                .map(|requirement| {
                    let current =
                        quest_rules::item_count(&player.state.inventory, &requirement.item_id);
                    serde_json::json!({
                        "text": fallback,
                        "current": current,
                        "required": requirement.quantity,
                    })
                })
                .collect();
        }
        spec.objectives
            .iter()
            .map(|objective| {
                let current = self.quest_objective_count(objective, player);
                let text = self
                    .quest_objective_text(&objective.text, lang)
                    .unwrap_or_else(|| fallback.clone());
                serde_json::json!({
                    "text": text,
                    "current": current,
                    "required": objective.required,
                })
            })
            .collect()
    }

    fn quest_objective_count(&self, objective: &QuestObjective, player: &Player) -> u32 {
        if objective.item_id.is_empty() {
            return 0;
        }
        if objective._kind == "equip" {
            quest_rules::equipped_item_count(&player.state.equipped, &objective.item_id)
        } else {
            quest_rules::item_count(&player.state.inventory, &objective.item_id)
        }
    }

    fn quest_objectives_complete(&self, spec: &QuestSpec, player: &Player) -> bool {
        let objectives_ok = spec.objectives.iter().all(|objective| {
            objective.required > 0
                && !objective.item_id.is_empty()
                && self.quest_objective_count(objective, player) >= objective.required
        });
        let complete_items_ok = quest_rules::complete_items(spec).iter().all(|requirement| {
            requirement.quantity > 0
                && !requirement.item_id.is_empty()
                && quest_rules::item_count(&player.state.inventory, &requirement.item_id)
                    >= requirement.quantity
        });
        objectives_ok && complete_items_ok
    }

    fn quest_status_for<'a>(player: &'a Player, quest_id: &str) -> Option<&'a str> {
        player.quests.get(quest_id).map(String::as_str)
    }

    fn quest_summary(&self, spec: &QuestSpec, status: &str, lang: &'static str) -> String {
        if lang == crate::quest_text::LANG_ZH {
            let phase = match status {
                "available" => "available",
                "active" | "objectivesComplete" => "active",
                "completed" => "completed",
                _ => "active",
            };
            if let Some(summary) = spec.summaries.get(phase).filter(|text| !text.is_empty()) {
                return summary.clone();
            }
        }
        self.quest_text.summary(&spec.quest_id, lang)
    }

    /// Localized name of a map id for player-facing quest routing text.  The
    /// authored names live in `shared/maps.json`; the runtime `Map` struct does
    /// not carry them, so the ids a quest can actually route through are spelled
    /// out here.  A miss falls back to the raw id, which is why every map a
    /// reachable quest can mention must be listed — "前往101000003" tells the
    /// player nothing.
    fn quest_map_label(&self, map_id: &str) -> String {
        match map_id {
            "000010000" => "楓葉山丘".to_owned(),
            "000020000" => "嫩寶村".to_owned(),
            "001010000" => "冒險者修練場入口".to_owned(),
            "001020000" => "選擇岔道".to_owned(),
            "002000000" => "楓之港".to_owned(),
            "002000100" => "碼頭".to_owned(),
            "101000003" => "魔法森林圖書館".to_owned(),
            "101010100" => "森林的起始點".to_owned(),
            "104000000" => "維多利亞港".to_owned(),
            "100000201" => "弓箭手培訓中心".to_owned(),
            "130000000" => "耶雷弗".to_owned(),
            "310040200" => "礦山入口".to_owned(),
            "310050000" => "發電廠大廳".to_owned(),
            _ => map_id.to_owned(),
        }
    }

    /// Transfer-office key of an NPC ("法師轉職官" …), compared
    /// whitespace-insensitively so the short `弓箭手 轉職官` spelling still
    /// pairs with its twin.  The same office is staffed in several maps; only
    /// one of those NPCs authors each job-route quest, so the key is what lets
    /// the others point the player at the right colleague instead of silently
    /// offering nothing.
    fn npc_office(&self, template_id: &str) -> Option<String> {
        let func = self
            .gameplay
            .npcs
            .iter()
            .find(|npc| npc.template_id == template_id)?
            .func
            .clone();
        let normalized: String = func.chars().filter(|c| !c.is_whitespace()).collect();
        normalized.contains("轉職官").then_some(normalized)
    }

    fn quest_npc_map(&self, template_id: Option<&str>) -> Option<String> {
        let template_id = template_id?;
        self.npcs
            .values()
            .find(|npc| {
                npc.template_id == template_id
                    && (template_id != QUEST_OLIVIA_NPC || npc.map_id == "130000000")
            })
            .map(|npc| npc.map_id.clone())
    }

    fn quest_npc_label(&self, template_id: Option<&str>) -> String {
        let Some(template_id) = template_id else {
            return "任務目標".to_owned();
        };
        self.npc_names_zh
            .get(template_id)
            .cloned()
            .or_else(|| {
                self.gameplay
                    .npcs
                    .iter()
                    .find(|npc| npc.template_id == template_id)
                    .map(|npc| npc.name.clone())
            })
            .unwrap_or_else(|| template_id.to_owned())
    }

    pub(super) fn quest_menu_choices(&self, id: &str, template_id: &str) -> Vec<(String, String)> {
        let Some(player) = self.players.get(id) else {
            return Vec::new();
        };
        let office = self.npc_office(template_id);
        let mut choices = Vec::new();
        for spec in self.gameplay.quests.iter().filter(|spec| spec.executable()) {
            let status = Self::quest_status_for(player, &spec.quest_id);
            match status {
                None => {
                    if Self::quest_phase_matches_npc(&spec.start, template_id) {
                        if quest_rules::conditions_match(
                            &quest_facts(player),
                            &spec.start.conditions,
                        ) {
                            choices.push((spec.quest_id.clone(), "start".to_owned()));
                        }
                    } else if let Some(office) = office.as_deref() {
                        // Same office, another map.  Only one of the twin NPCs
                        // authors each job-route quest; the other would
                        // otherwise offer nothing while the quest log still
                        // reports the quest as acceptable, which reads as
                        // "cannot accept".  Point the player at the colleague
                        // instead — the quest itself is still accepted there.
                        let start_npc = spec.start.npc_id.as_deref().unwrap_or_default();
                        let same_office = self.npc_office(start_npc).as_deref() == Some(office);
                        let authored_elsewhere = self
                            .quest_npc_map(spec.start.npc_id.as_deref())
                            .is_some_and(|map_id| map_id != player.map_id);
                        if same_office
                            && authored_elsewhere
                            && quest_rules::conditions_match(
                                &quest_facts(player),
                                &spec.start.conditions,
                            )
                        {
                            choices.push((spec.quest_id.clone(), "route_guide".to_owned()));
                        }
                    }
                }
                Some("active") => {
                    // A phase warp is also a resumable route while the quest is
                    // active.  The same tuple is re-derived on selection, so a
                    // stale menu cannot move a player after the quest changes.
                    if Self::quest_phase_matches_npc(&spec.start, template_id)
                        && spec
                            .start
                            .warp_map_id
                            .as_ref()
                            .is_some_and(|map_id| self.maps.contains_key(map_id))
                    {
                        choices.push((spec.quest_id.clone(), "route_start".to_owned()));
                    }
                    if Self::quest_phase_matches_npc(&spec.complete, template_id) {
                        if quest_rules::conditions_match(
                            &quest_facts(player),
                            &spec.complete.conditions,
                        ) && self.quest_objectives_complete(spec, player)
                        {
                            choices.push((spec.quest_id.clone(), "complete".to_owned()));
                        } else {
                            choices.push((spec.quest_id.clone(), "pending".to_owned()));
                        }
                    }
                }
                Some("completed") => {
                    if Self::quest_phase_matches_npc(&spec.start, template_id)
                        && spec
                            .start
                            .warp_map_id
                            .as_ref()
                            .is_some_and(|map_id| self.maps.contains_key(map_id))
                    {
                        choices.push((spec.quest_id.clone(), "route_start".to_owned()));
                    }
                    if Self::quest_phase_matches_npc(&spec.complete, template_id) {
                        if spec
                            .complete
                            .warp_map_id
                            .as_ref()
                            .is_some_and(|map_id| self.maps.contains_key(map_id))
                        {
                            choices.push((spec.quest_id.clone(), "route_complete".to_owned()));
                        }
                        if spec
                            .return_map_id
                            .as_ref()
                            .is_some_and(|map_id| self.maps.contains_key(map_id))
                        {
                            choices.push((spec.quest_id.clone(), "return".to_owned()));
                        }
                    }
                }
                _ => {}
            }
        }
        choices
    }

    fn quest_route_map_id<'a>(spec: &'a QuestSpec, action: &str) -> Option<&'a str> {
        match action {
            "route_start" => spec.start.warp_map_id.as_deref(),
            "route_complete" => spec.complete.warp_map_id.as_deref(),
            "return" => spec.return_map_id.as_deref(),
            _ => None,
        }
    }

    fn quest_route_target(
        &self,
        id: &str,
        quest_id: &str,
        template_id: &str,
        action: &str,
    ) -> Option<(String, Option<String>)> {
        let player = self.players.get(id)?;
        let spec = self
            .gameplay
            .quests
            .iter()
            .find(|spec| spec.quest_id == quest_id)?;
        let status = Self::quest_status_for(player, quest_id);
        // A guide walks the player to the colleague who authors a job-route
        // quest they can already accept.  It is re-derived on selection, so a
        // quest accepted in the meantime can no longer move anyone.
        if action == "route_guide" {
            if status.is_some()
                || !quest_rules::conditions_match(&quest_facts(player), &spec.start.conditions)
            {
                return None;
            }
            let office = self.npc_office(template_id)?;
            let start_npc = spec.start.npc_id.as_deref()?;
            if self.npc_office(start_npc).as_deref() != Some(office.as_str()) {
                return None;
            }
            let map_id = self.quest_npc_map(Some(start_npc))?;
            if map_id == player.map_id {
                return None;
            }
            return self.maps.contains_key(&map_id).then_some((map_id, None));
        }
        let phase = match action {
            "route_start" if matches!(status, Some("active") | Some("completed")) => &spec.start,
            "route_complete" | "return" if status == Some("completed") => &spec.complete,
            _ => return None,
        };
        let recheck_active_start = action == "route_start" && status == Some("active");
        if !Self::quest_phase_matches_npc(phase, template_id)
            || (recheck_active_start
                && !quest_rules::conditions_match(&quest_facts(player), &phase.conditions))
        {
            return None;
        }
        let map_id = Self::quest_route_map_id(spec, action)?;
        self.maps.contains_key(map_id).then(|| {
            (
                map_id.to_owned(),
                match action {
                    "route_start" => spec.start.warp_portal_name.clone(),
                    "route_complete" => spec.complete.warp_portal_name.clone(),
                    _ => None,
                },
            )
        })
    }

    pub(super) fn quest_npc_visible(&self, id: &str, npc: &NpcInstance) -> bool {
        let Some(player) = self.players.get(id) else {
            return !matches!(
                npc.template_id.as_str(),
                QUEST_HIDDEN_NPC_1 | QUEST_HIDDEN_NPC_2 | QUEST_HIDDEN_NPC_3 | QUEST_OLIVIA_NPC
            );
        };
        match npc.template_id.as_str() {
            QUEST_HIDDEN_NPC_1 => {
                !matches!(Self::quest_status_for(player, "36301"), Some("completed"))
            }
            QUEST_HIDDEN_NPC_2 => {
                Self::quest_status_for(player, "36301") == Some("completed")
                    && !matches!(Self::quest_status_for(player, "36304"), Some("completed"))
            }
            QUEST_HIDDEN_NPC_3 => Self::quest_status_for(player, "36306") == Some("completed"),
            QUEST_OLIVIA_NPC => {
                npc.map_id == "130000000"
                    && Self::quest_status_for(player, "36309") == Some("active")
            }
            _ => true,
        }
    }

    pub(super) fn quest_interactions_for(&self, id: &str, map_id: &str) -> Vec<serde_json::Value> {
        let Some(player) = self.players.get(id) else {
            return Vec::new();
        };
        if player.state.hp <= 0 || player.state.action == "dead" {
            return Vec::new();
        }
        self.gameplay
            .quests
            .iter()
            .filter(|spec| spec.executable())
            .filter_map(|spec| {
                let interaction = spec.interaction.as_ref()?;
                if Self::quest_status_for(player, &spec.quest_id) != Some("active")
                    || interaction.map_id != map_id
                    || interaction.item_id.is_empty()
                    || interaction.quantity == 0
                    || quest_rules::item_count(
                        &player.state.inventory,
                        &interaction.item_id,
                    ) >= interaction.quantity
                {
                    return None;
                }
                let range = if interaction.range > 0.0 {
                    interaction.range
                } else {
                    64.0
                };
                let label = self
                    .quest_objective_text(&interaction.label, player.lang)
                    .unwrap_or_else(|| self.quest_text.summary(&spec.quest_id, player.lang));
                Some(serde_json::json!({
                    "questId": spec.quest_id,
                    "mapId": interaction.map_id,
                    "mapLayerKey": interaction.map_layer_key,
                    "x": interaction.x,
                    "y": interaction.y,
                    "range": range,
                    "label": label,
                }))
            })
            .collect()
    }

    pub(super) fn quest_entry(
        &self,
        id: &str,
        spec: &QuestSpec,
        persisted: Option<&str>,
    ) -> Option<serde_json::Value> {
        let player = self.players.get(id)?;
        let status = match persisted {
            Some("completed") => "completed",
            Some("active") if self.quest_objectives_complete(spec, player) => "objectivesComplete",
            Some("active") => "active",
            Some(_) => return None,
            None if spec.executable()
                && quest_rules::conditions_match(&quest_facts(player), &spec.start.conditions) =>
            {
                "available"
            }
            None => return None,
        };
        let objective_rows = self.quest_objective_rows(spec, player, player.lang);
        let (target_map_id, target_npc_id, next_action) = match status {
            "available" => (
                self.quest_npc_map(spec.start.npc_id.as_deref()),
                spec.start.npc_id.clone(),
                spec.start.npc_id.as_deref().and_then(|npc_id| {
                    self.quest_npc_map(Some(npc_id)).map(|map_id| {
                        format!(
                            "前往{}，與{}交談接取任務",
                            self.quest_map_label(&map_id),
                            self.quest_npc_label(Some(npc_id))
                        )
                    })
                }),
            ),
            "active" => {
                let interaction = spec.interaction.as_ref();
                let target_map_id = interaction
                    .map(|interaction| interaction.map_id.clone())
                    .or_else(|| self.quest_npc_map(spec.complete.npc_id.as_deref()));
                let target_npc_id = if interaction.is_some() {
                    None
                } else {
                    spec.complete.npc_id.clone()
                };
                let next_action = if let Some(interaction) = interaction {
                    let label = self
                        .quest_objective_text(&interaction.label, player.lang)
                        .unwrap_or_else(|| self.quest_summary(spec, "active", player.lang));
                    Some(format!(
                        "前往{}，点击{}",
                        self.quest_map_label(&interaction.map_id),
                        label
                    ))
                } else {
                    spec.complete.npc_id.as_deref().and_then(|npc_id| {
                        self.quest_npc_map(Some(npc_id)).map(|map_id| {
                            let delivery = format!(
                                "前往{}，與{}交談交付任務",
                                self.quest_map_label(&map_id),
                                self.quest_npc_label(Some(npc_id))
                            );
                            let has_equipment_goal = spec
                                .objectives
                                .iter()
                                .any(|objective| objective._kind == "equip");
                            let has_collect_goal = !quest_rules::complete_items(spec).is_empty()
                                || spec
                                    .objectives
                                    .iter()
                                    .any(|objective| objective._kind != "equip");
                            if has_equipment_goal && !has_collect_goal {
                                format!("先完成裝備目標；完成後{}", delivery)
                            } else if has_collect_goal {
                                format!("先收集任務目標；完成後{}", delivery)
                            } else {
                                delivery
                            }
                        })
                    })
                };
                (target_map_id, target_npc_id, next_action)
            }
            "objectivesComplete" => (
                self.quest_npc_map(spec.complete.npc_id.as_deref()),
                spec.complete.npc_id.clone(),
                spec.complete.npc_id.as_deref().and_then(|npc_id| {
                    self.quest_npc_map(Some(npc_id)).map(|map_id| {
                        format!(
                            "前往{}，與{}交談交付任務",
                            self.quest_map_label(&map_id),
                            self.quest_npc_label(Some(npc_id))
                        )
                    })
                }),
            ),
            "completed" => (
                spec.return_map_id.clone(),
                None,
                spec.return_map_id
                    .as_deref()
                    .map(|map_id| format!("返回{}", self.quest_map_label(map_id))),
            ),
            _ => (None, None, None),
        };
        let mut entry = serde_json::json!({
            "questId": spec.quest_id,
            "name": self.quest_text.name(&spec.quest_id, player.lang),
            "status": status,
            "summary": self.quest_summary(spec, status, player.lang),
        });
        if !objective_rows.is_empty() {
            entry["objectives"] = serde_json::Value::Array(objective_rows);
        }
        if let Some(target_map_id) = target_map_id.filter(|value| !value.is_empty()) {
            entry["targetMapId"] = target_map_id.into();
        }
        if let Some(target_npc_id) = target_npc_id.filter(|value| !value.is_empty()) {
            entry["targetNpcId"] = target_npc_id.into();
        }
        if let Some(next_action) = next_action {
            entry["nextAction"] = next_action.into();
        }
        Some(entry)
    }

    pub(super) fn quest_log_entries(&self, id: &str) -> Vec<serde_json::Value> {
        let Some(player) = self.players.get(id) else {
            return Vec::new();
        };
        let mut entries = Vec::new();
        let catalog_ids: BTreeSet<&str> = self
            .gameplay
            .quests
            .iter()
            .map(|spec| spec.quest_id.as_str())
            .collect();
        for spec in &self.gameplay.quests {
            if let Some(entry) = self.quest_entry(
                id,
                spec,
                player.quests.get(&spec.quest_id).map(String::as_str),
            ) {
                entries.push(entry);
            }
        }
        // Preserve old save rows even when their content definition is no
        // longer present in the current catalog. They remain display-only;
        // execution still requires an executable catalog entry.
        for (quest_id, status) in &player.quests {
            if !catalog_ids.contains(quest_id.as_str()) {
                entries.push(serde_json::json!({
                    "questId": quest_id,
                    "name": self.quest_text.name(quest_id, player.lang),
                    "status": status,
                    "summary": self.quest_text.summary(quest_id, player.lang),
                }));
            }
        }
        entries
    }

    pub(super) fn handle_quest_npc_menu(
        &mut self,
        id: &str,
        request_id: &str,
        npc_id: &str,
        template_id: &str,
        name: &str,
        name_zh: Option<&str>,
        lang: &'static str,
        step: Option<&str>,
        selection: Option<u32>,
    ) -> bool {
        let current_node = self
            .npcs
            .get(npc_id)
            .and_then(|npc| npc.conversation.get(id).cloned());
        let opening = step.is_none_or(|value| value == "start");
        let cached_choices = current_node
            .as_deref()
            .and_then(|node| node.strip_prefix(QUEST_MENU_NODE))
            .and_then(|json| serde_json::from_str::<Vec<(String, String)>>(json).ok());
        if cached_choices.is_none() && opening {
            let choices = self.quest_menu_choices(id, template_id);
            if choices.is_empty() {
                return false;
            }
            let options = choices
                .iter()
                .enumerate()
                .map(|(index, (quest_id, action))| {
                    let name = self.quest_text.name(quest_id, lang);
                    let route_map = self
                        .gameplay
                        .quests
                        .iter()
                        .find(|spec| spec.quest_id == quest_id.as_str())
                        .and_then(|spec| {
                            if action == "route_guide" {
                                // A guide points at the colleague who authors
                                // the quest, which is runtime placement rather
                                // than an authored warp field.
                                self.quest_npc_map(spec.start.npc_id.as_deref())
                            } else {
                                Self::quest_route_map_id(spec, action).map(str::to_owned)
                            }
                        })
                        .map(|map_id| self.quest_map_label(&map_id));
                    let text = match action.as_str() {
                        "start" if lang == crate::quest_text::LANG_EN => format!("Accept: {name}"),
                        "complete" if lang == crate::quest_text::LANG_EN => {
                            format!("Turn in: {name}")
                        }
                        "pending" if lang == crate::quest_text::LANG_EN => format!("View: {name}"),
                        "route_start" if lang == crate::quest_text::LANG_EN => format!(
                            "Go to {}: {name}",
                            route_map.as_deref().unwrap_or("the next area")
                        ),
                        "route_complete" if lang == crate::quest_text::LANG_EN => format!(
                            "Go to {}: {name}",
                            route_map.as_deref().unwrap_or("the destination")
                        ),
                        "return" if lang == crate::quest_text::LANG_EN => format!(
                            "Return: {}",
                            route_map.as_deref().unwrap_or("the return route")
                        ),
                        "route_guide" if lang == crate::quest_text::LANG_EN => format!(
                            "Accept at {}: {name}",
                            route_map.as_deref().unwrap_or("the quest NPC")
                        ),
                        "start" => format!("接取：{name}"),
                        "complete" => format!("交付：{name}"),
                        "pending" => format!("查看：{name}"),
                        "route_start" => format!(
                            "前往{}繼續：{name}",
                            route_map.as_deref().unwrap_or("下一站")
                        ),
                        "route_complete" => format!(
                            "前往{}：{name}",
                            route_map.as_deref().unwrap_or("任務目的地")
                        ),
                        "return" => format!("返回{}", route_map.as_deref().unwrap_or("選擇岔道")),
                        "route_guide" => format!(
                            "前往{}接取：{name}",
                            route_map.as_deref().unwrap_or("任務NPC所在地")
                        ),
                        _ => format!("返回選擇岔道：{name}"),
                    };
                    (u32::try_from(index).unwrap_or(u32::MAX), text)
                })
                .collect();
            if let Some(npc) = self.npcs.get_mut(npc_id) {
                let encoded = serde_json::to_string(&choices).unwrap_or_else(|_| "[]".to_owned());
                npc.conversation
                    .insert(id.to_owned(), format!("{QUEST_MENU_NODE}{encoded}"));
            }
            let text = choices
                .first()
                .map(|(quest_id, _)| self.quest_text.summary(quest_id, lang))
                .unwrap_or_default();
            self.send_npc_dialogue(
                id,
                npc::DialogueView::Say {
                    text,
                    kind: "simple".to_owned(),
                    options,
                }
                .to_json(request_id, npc_id, name, name_zh),
            );
            return true;
        }
        let Some(cached_choices) = cached_choices else {
            return false;
        };
        match (step, selection) {
            (Some("select"), Some(index)) => {
                let Some((quest_id, action)) = cached_choices.get(index as usize).cloned() else {
                    self.end_conversation(id);
                    self.send_reject(
                        id,
                        "quest_step_invalid",
                        "quest option is not offered",
                        Some(request_id),
                    );
                    return true;
                };
                let still_offered = self
                    .quest_menu_choices(id, template_id)
                    .iter()
                    .any(|choice| choice == &(quest_id.clone(), action.clone()));
                if !still_offered {
                    self.end_conversation(id);
                    self.send_reject(
                        id,
                        "quest_option_unavailable",
                        "任務選項已更新，請重新開啟NPC對話。",
                        Some(request_id),
                    );
                    return true;
                }
                self.end_conversation(id);
                if matches!(
                    action.as_str(),
                    "route_start" | "route_complete" | "return" | "route_guide"
                ) {
                    let Some((route_map_id, route_portal_name)) =
                        self.quest_route_target(id, &quest_id, template_id, &action)
                    else {
                        self.send_reject(
                            id,
                            "quest_return_unavailable",
                            "任務路線已更新，請重新開啟NPC對話。",
                            Some(request_id),
                        );
                        return true;
                    };
                    if !self.warp_player_at(id, route_map_id, route_portal_name.as_deref()) {
                        self.send_reject(
                            id,
                            "persistence",
                            "傳送未能保存，請稍後重試。",
                            Some(request_id),
                        );
                        return true;
                    }
                    self.send_npc_dialogue(
                        id,
                        npc::DialogueView::End.to_json(request_id, npc_id, name, name_zh),
                    );
                    return true;
                }
                if action == "pending" {
                    let text = self
                        .gameplay
                        .quests
                        .iter()
                        .find(|spec| spec.quest_id == quest_id)
                        .map(|spec| self.quest_summary(spec, "active", lang))
                        .unwrap_or_default();
                    self.send_npc_dialogue(
                        id,
                        npc::DialogueView::Say {
                            text,
                            kind: "ok".to_owned(),
                            options: Vec::new(),
                        }
                        .to_json(request_id, npc_id, name, name_zh),
                    );
                    return true;
                }
                let effect = if action == "start" {
                    npc::QuestEffect::Start(quest_id)
                } else {
                    npc::QuestEffect::Complete(quest_id)
                };
                if self.apply_quest_effect_at(id, effect, Some(template_id), Some(request_id)) {
                    self.send_npc_dialogue(
                        id,
                        npc::DialogueView::End.to_json(request_id, npc_id, name, name_zh),
                    );
                }
                true
            }
            (Some("end"), _) => {
                self.end_conversation(id);
                self.send_npc_dialogue(
                    id,
                    npc::DialogueView::End.to_json(request_id, npc_id, name, name_zh),
                );
                true
            }
            _ => {
                self.end_conversation(id);
                self.send_reject(
                    id,
                    "quest_step_invalid",
                    "quest conversation step is not offered",
                    Some(request_id),
                );
                true
            }
        }
    }

    fn quest_reward(&self, quest_id: &str) -> QuestReward {
        self.gameplay
            .quests
            .iter()
            .find(|quest| quest.quest_id == quest_id)
            .map(|quest| quest.reward.clone())
            .unwrap_or_default()
    }

    pub(super) fn add_exp(state: &mut PlayerState, amount: u64, exp_table: &[u64]) {
        state.exp = state.exp.saturating_add(amount);
        while let Some(&threshold) = exp_table.get(state.level.saturating_sub(1) as usize) {
            if threshold == 0 || state.exp < threshold {
                state.exp_to_next = threshold;
                break;
            }
            state.exp -= threshold;
            let next_level = state.level.saturating_add(1);
            if next_level == state.level {
                state.exp_to_next = 0;
                break;
            }
            state.level = next_level;
            state.ability_stats.available_ap = state.ability_stats.available_ap.saturating_add(5);
            auth::grant_level_sp(state.job, state.level, &mut state.skill_points);
            state.exp_to_next = exp_table
                .get(state.level.saturating_sub(1) as usize)
                .copied()
                .unwrap_or(0);
            if state.exp_to_next == 0 {
                break;
            }
        }
        if exp_table
            .get(state.level.saturating_sub(1) as usize)
            .copied()
            .unwrap_or(0)
            == 0
        {
            state.exp_to_next = 0;
        }
    }

    pub(super) fn normalize_profile_progress(profile: &mut Profile, exp_table: &[u64]) {
        // Reuse auth's profile-level advancement path so reconnect catch-up
        // and persisted combat/quest rewards award the same AP/SP exactly
        // once.  Zero experience is a normalization pass because auth also
        // refreshes exp_to_next at the current level.
        auth::add_exp(profile, 0, exp_table);
    }

    pub(super) fn apply_quest_effect(&mut self, id: &str, effect: npc::QuestEffect) {
        let _ = self.apply_quest_effect_at(id, effect, None, None);
    }

    /// Settle a quest transition after all authored gates have been checked.
    /// `npc_template` is supplied by the dynamic chapter menu; scripted legacy
    /// effects keep the old call path and therefore omit the NPC gate.
    pub(super) fn apply_quest_effect_at(
        &mut self,
        id: &str,
        effect: npc::QuestEffect,
        npc_template: Option<&str>,
        request_id: Option<&str>,
    ) -> bool {
        let (quest_id, wanted) = match effect {
            npc::QuestEffect::Start(quest_id) => (quest_id, "active"),
            npc::QuestEffect::Complete(quest_id) => (quest_id, "completed"),
            npc::QuestEffect::JobAdvance { .. } => return false,
        };
        let Some(spec) = self
            .gameplay
            .quests
            .iter()
            .find(|quest| quest.quest_id == quest_id)
            .cloned()
        else {
            self.send_reject(
                id,
                "quest_unknown",
                "此任務不在目前的任務目錄中。",
                request_id,
            );
            return false;
        };
        if !spec.executable() {
            self.send_reject(
                id,
                "quest_script_unavailable",
                "此任務的原版劇情腳本尚未接入。",
                request_id,
            );
            return false;
        }
        let phase = if wanted == "active" {
            &spec.start
        } else {
            &spec.complete
        };
        let Some(player_snapshot) = self.players.get(id).cloned() else {
            return false;
        };
        if player_snapshot.state.hp <= 0 || player_snapshot.state.action == "dead" {
            self.send_reject(id, "invalid_state", "死亡角色不能處理任務。", request_id);
            return false;
        }
        if npc_template.is_some_and(|template| !Self::quest_phase_matches_npc(phase, template)) {
            self.send_reject(
                id,
                "quest_npc_unavailable",
                "此任務NPC目前無法處理任務。",
                request_id,
            );
            return false;
        }
        if quest_id == "1402"
            && (npc_template != Some("1032001") || player_snapshot.map_id != "101000003")
        {
            self.send_reject(
                id,
                "quest_npc_unavailable",
                "請前往魔法森林圖書館與漢斯交談。",
                request_id,
            );
            return false;
        }
        let transition_ok = match player_snapshot.quests.get(&quest_id).map(String::as_str) {
            None => wanted == "active",
            Some("active") => wanted == "completed",
            Some("completed") => false,
            Some(_) => false,
        };
        if !transition_ok {
            self.send_reject(
                id,
                "quest_transition_invalid",
                "任務狀態已更新。",
                request_id,
            );
            return false;
        }
        if !quest_rules::conditions_match(&quest_facts(&player_snapshot), &phase.conditions)
            || (wanted == "completed" && !self.quest_objectives_complete(&spec, &player_snapshot))
        {
            self.send_reject(
                id,
                "quest_requirements_missing",
                "任務條件尚未完成。",
                request_id,
            );
            return false;
        }

        let mut next_state = player_snapshot.state.clone();
        let mut next_quests = player_snapshot.quests.clone();
        let reward = if wanted == "completed" {
            self.quest_reward(&quest_id)
        } else {
            QuestReward::default()
        };
        if wanted == "active" {
            // Start items are part of the same profile/quest transaction as
            // the status transition.  Count equipped copies too so a
            // reconnect or an already-worn quest hat cannot mint a second
            // copy; only the missing quantity is provisioned.
            for item in &spec.start_items {
                let held = quest_rules::item_count(&next_state.inventory, &item.item_id)
                    .saturating_add(quest_rules::equipped_item_count(
                        &player_snapshot.state.equipped,
                        &item.item_id,
                    ));
                let missing = item.quantity.saturating_sub(held);
                if missing == 0 {
                    continue;
                }
                let kind = inventory::inventory_type(&item.item_id).unwrap_or(4);
                let slot_limit = player_snapshot
                    .inventory_slots
                    .get(&kind)
                    .copied()
                    .unwrap_or(inventory::SLOT_LIMIT);
                if let Err(error) =
                    inventory::add_items(&mut next_state.inventory, item.item_id.clone(), missing, slot_limit)
                {
                    let code = match error {
                        inventory::InventoryError::InventoryFull => "quest_start_inventory_full",
                        inventory::InventoryError::UnknownItem => "quest_start_unknown_item",
                        _ => "quest_start_rejected",
                    };
                    let message = if code == "quest_start_inventory_full" {
                        "背包空間不足，任務尚未接取。請整理背包後再次與NPC交談。"
                    } else {
                        "任務起始物品暫時無法取得，任務尚未接取。"
                    };
                    self.send_reject(id, code, message, request_id);
                    return false;
                }
            }
        }
        if wanted == "completed" {
            for requirement in quest_rules::consume_items(&spec) {
                if requirement.item_id.is_empty() || requirement.quantity == 0 {
                    continue;
                }
                let mut remaining = requirement.quantity;
                let slots: Vec<i16> = next_state
                    .inventory
                    .iter()
                    .filter(|item| item.item_id == requirement.item_id)
                    .filter_map(|item| i16::try_from(item.slot).ok())
                    .collect();
                for slot in slots {
                    if remaining == 0 {
                        break;
                    }
                    let available = next_state
                        .inventory
                        .iter()
                        .find(|item| {
                            item.slot == u16::try_from(slot).unwrap_or(0)
                                && item.item_id == requirement.item_id
                        })
                        .map(|item| item.quantity)
                        .unwrap_or(0);
                    let removed = remaining.min(available);
                    if removed > 0 {
                        let Some(kind) = inventory::inventory_type(&requirement.item_id) else {
                            self.send_reject(
                                id,
                                "quest_requirements_missing",
                                "任務物品無效。",
                                request_id,
                            );
                            return false;
                        };
                        match inventory::remove_items(
                            &mut next_state.inventory,
                            kind,
                            slot,
                            removed,
                        ) {
                            Ok((removed_item, actual)) if removed_item == requirement.item_id => {
                                remaining = remaining.saturating_sub(actual);
                            }
                            Ok(_) | Err(_) => {
                                self.send_reject(
                                    id,
                                    "quest_requirements_missing",
                                    "任務物品無法扣除。",
                                    request_id,
                                );
                                return false;
                            }
                        }
                    }
                }
                if remaining > 0 {
                    self.send_reject(
                        id,
                        "quest_requirements_missing",
                        "任務物品數量不足。",
                        request_id,
                    );
                    return false;
                }
            }
            next_state.mesos = next_state.mesos.saturating_add(reward.mesos);
            if reward.exp > 0 {
                Self::add_exp(&mut next_state, reward.exp, &self.gameplay.exp_table);
            }
            for item in reward.items.iter() {
                let kind = inventory::inventory_type(&item.item_id).unwrap_or(4);
                let slot_limit = player_snapshot
                    .inventory_slots
                    .get(&kind)
                    .copied()
                    .unwrap_or(inventory::SLOT_LIMIT);
                if let Err(error) = inventory::add_items(
                    &mut next_state.inventory,
                    item.item_id.clone(),
                    item.quantity,
                    slot_limit,
                ) {
                    let code = match error {
                        inventory::InventoryError::InventoryFull => "quest_reward_inventory_full",
                        inventory::InventoryError::UnknownItem => "quest_reward_unknown_item",
                        _ => "quest_reward_rejected",
                    };
                    let message = if code == "quest_reward_inventory_full" {
                        "背包空間不足。請整理背包後再次與任務NPC交談，獎勵尚未領取。"
                    } else {
                        "任務獎勵暫時無法領取，進度已保留。請稍後重試。"
                    };
                    self.send_reject(id, code, message, request_id);
                    return false;
                }
            }
        }

        let mut next_map_id = player_snapshot.map_id.clone();
        let mut warp = None;
        if let Some(target_map_id) = phase.warp_map_id.clone() {
            let Some(target_map) = self.maps.get(&target_map_id).cloned() else {
                self.send_reject(
                    id,
                    "map_unavailable",
                    "任務目的地目前無法使用。",
                    request_id,
                );
                return false;
            };
            let spawn = (target_map.spawn.x, target_map.spawn.y);
            let preferred = phase
                .warp_portal_name
                .as_deref()
                .and_then(|name| target_map.portals.iter().find(|portal| portal.name == name))
                .map(|portal| (portal.x, portal.y))
                .unwrap_or(spawn);
            let resolve_spawn = |(x, y): (f64, f64)| {
                if !x.is_finite()
                    || !y.is_finite()
                    || !(target_map.bounds.x_min..=target_map.bounds.x_max).contains(&x)
                    || !(target_map.bounds.y_min..=target_map.bounds.y_max).contains(&y)
                {
                    return None;
                }
                // Authored map spawns may be airborne above their first
                // foothold. Preserve that source point and let normal
                // gravity land the player instead of inventing a corner
                // position or selecting an unrelated upper platform.
                let (foothold_id, ground) = target_map.ground_below(x, y)?;
                if (ground - y).abs() <= 24.0 {
                    Some((x, ground, foothold_id, true))
                } else {
                    Some((x, y, 0, false))
                }
            };
            let Some((x, y, foothold_id, grounded)) =
                resolve_spawn(preferred).or_else(|| resolve_spawn(spawn))
            else {
                self.send_reject(
                    id,
                    "map_unavailable",
                    "任務目的地沒有可用出生點。",
                    request_id,
                );
                return false;
            };
            next_map_id = target_map_id;
            next_state.x = x;
            next_state.y = y;
            next_state.vx = 0.0;
            next_state.vy = 0.0;
            next_state.grounded = grounded;
            next_state.action = if grounded { "stand" } else { "jump" };
            warp = Some(foothold_id);
        }
        next_quests.insert(quest_id.clone(), wanted.to_owned());
        let did_warp = warp.is_some();
        let warp_foothold = warp.unwrap_or(0);

        let mut profile = profile_from_state(
            &next_state,
            &next_map_id,
            &player_snapshot.death_id,
            player_snapshot.base_max_mp,
        );
        // P: the original q1402 scripts are absent. Explicit completion at
        // Hans uses the same first-job grant as the authorized shortcut.
        // Existing mage jobs recover only the story; they receive no grant.
        let first_mage_transfer = quest_id == "1402" && wanted == "completed" && profile.job == 0;
        if first_mage_transfer {
            if profile.level < 10
                || player_snapshot.quests.get("36307").map(String::as_str) != Some("completed")
            {
                self.send_reject(
                    id,
                    "quest_requirements_missing",
                    "請先完成前置劇情並達到10級。",
                    request_id,
                );
                return false;
            }
            auth::grant_first_mage(&mut profile);
            apply_profile(&mut next_state, profile.clone());
        }
        if let Some(store) = self.store.as_ref() {
            match store.commit_quest(id, &quest_id, wanted, &profile) {
                Ok(true) => {}
                Ok(false) => {
                    let restored = store
                        .load_profile(id, &profile)
                        .and_then(|profile| store.load_quests(id).map(|quests| (profile, quests)));
                    match restored {
                        Ok((profile, quests)) => {
                            if let Some(player) = self.players.get_mut(id) {
                                apply_profile_to_player(
                                    &self.gameplay,
                                    &self.mage_skills,
                                    player,
                                    profile,
                                );
                                player.quests = quests;
                            }
                            self.send_quest_list(id);
                        }
                        Err(error) => self.send_reject(id, "persistence", &error, request_id),
                    }
                    return false;
                }
                Err(error) => {
                    self.send_reject(id, "persistence", &error, request_id);
                    return false;
                }
            }
        }
        if let Some(player) = self.players.get_mut(id) {
            player.map_id = next_map_id;
            // Quest warps follow the same map-local rule as portals: the pet
            // is recalled instead of carrying stale coordinates across maps.
            player.pet = None;
            player.state = next_state;
            player.quests = next_quests;
            if first_mage_transfer {
                player.base_max_mp = profile.max_mp;
            }
            if did_warp {
                player.natural_recovery_next_tick =
                    self.tick.saturating_add(NATURAL_RECOVERY_INTERVAL_TICKS);
                player.state.facing = 1;
                player.state.climbing = false;
                player.state.ladder_id = None;
                player.state.action_id = None;
                player.state.action_started_tick = self.tick;
                player.direction = 0;
                player.vertical = 0;
                player.jump = false;
                player.foothold_id = warp_foothold;
                player.last_foothold_id = player.foothold_id;
                player.fall_boundary_hold = false;
                player.meditation_until = 0;
                player.meditation_mad = 0;
                clear_beginner_buffs(player);
                player.ice_teleport_enabled = false;
                player.ice_fields.clear();
                player.teleport_mastery_enabled = false;
                player.teleport_boost_enabled = false;
                player.adaptation_active = false;
                player.adaptation_charges = 0;
                player.summon = None;
            }
            refresh_player_derived(&self.gameplay, &self.mage_skills, player);
        }
        self.send_quest_update(id, &quest_id, wanted, reward);
        self.send_quest_list(id);
        // Quest phase changes also alter hidden chapter NPCs and interaction
        // markers, so refresh the snapshot even when the reward did not warp.
        self.send_snapshot(id);
        true
    }

    pub(super) fn handle_quest_interact(&mut self, id: String, request_id: String, quest_id: String) {
        let Some(spec) = self
            .gameplay
            .quests
            .iter()
            .find(|spec| spec.quest_id == quest_id)
            .cloned()
        else {
            self.send_reject(
                &id,
                "quest_unknown",
                "此任務不在目前的任務目錄中。",
                Some(&request_id),
            );
            return;
        };
        if !spec.executable() {
            self.send_reject(
                &id,
                "quest_script_unavailable",
                "此任務的原版劇情腳本尚未接入。",
                Some(&request_id),
            );
            return;
        }
        let Some(interaction) = spec.interaction.clone() else {
            self.send_reject(
                &id,
                "quest_interaction_unavailable",
                "此任務目前沒有可互動目標。",
                Some(&request_id),
            );
            return;
        };
        let Some(player_snapshot) = self.players.get(&id).cloned() else {
            return;
        };
        if Self::quest_status_for(&player_snapshot, &quest_id) != Some("active") {
            self.send_reject(
                &id,
                "quest_interaction_unavailable",
                "此任務尚未進入互動階段。",
                Some(&request_id),
            );
            return;
        }
        if player_snapshot.state.hp <= 0 || player_snapshot.state.action == "dead" {
            self.send_reject(
                &id,
                "invalid_state",
                "死亡角色不能進行任務互動。",
                Some(&request_id),
            );
            return;
        }
        let range = if interaction.range > 0.0 {
            interaction.range
        } else {
            64.0
        };
        if player_snapshot.map_id != interaction.map_id
            || (player_snapshot.state.x - interaction.x)
                .hypot(player_snapshot.state.y - interaction.y)
                > range
        {
            self.send_reject(
                &id,
                "quest_interaction_too_far",
                "請靠近任務互動目標。",
                Some(&request_id),
            );
            return;
        }
        if interaction.item_id.is_empty() || interaction.quantity == 0 {
            self.send_reject(
                &id,
                "quest_interaction_done",
                "任務互動已完成。",
                Some(&request_id),
            );
            return;
        }
        let mut next_state = player_snapshot.state.clone();
        if self.store.is_none() {
            let held =
                quest_rules::item_count(&player_snapshot.state.inventory, &interaction.item_id);
            if held >= interaction.quantity {
                self.send_reject(
                    &id,
                    "quest_interaction_done",
                    "任務互動已完成。",
                    Some(&request_id),
                );
                return;
            }
            let missing = interaction.quantity.saturating_sub(held);
            let kind = inventory::inventory_type(&interaction.item_id).unwrap_or(4);
            let slot_limit = player_snapshot
                .inventory_slots
                .get(&kind)
                .copied()
                .unwrap_or(inventory::SLOT_LIMIT);
            if let Err(error) = inventory::add_items(
                &mut next_state.inventory,
                interaction.item_id.clone(),
                missing,
                slot_limit,
            ) {
                let code = match error {
                    inventory::InventoryError::InventoryFull => "quest_interaction_inventory_full",
                    inventory::InventoryError::UnknownItem => "quest_interaction_unknown_item",
                    _ => "quest_interaction_rejected",
                };
                self.send_reject(
                    &id,
                    code,
                    "背包空間不足或互動物品無法取得。",
                    Some(&request_id),
                );
                return;
            }
        }

        let mut authoritative_profile = None;
        if let Some(store) = self.store.as_ref() {
            let profile = profile_from_state(
                &next_state,
                &player_snapshot.map_id,
                &player_snapshot.death_id,
                player_snapshot.base_max_mp,
            );
            match store.commit_quest_interaction(
                &id,
                &quest_id,
                &interaction.item_id,
                interaction.quantity,
                &profile,
            ) {
                Ok(true) => match store.load_profile(&id, &profile) {
                    Ok(profile) => authoritative_profile = Some(profile),
                    Err(error) => {
                        self.send_reject(&id, "persistence", &error, Some(&request_id));
                        self.players.remove(&id);
                        self.end_conversation(&id);
                        self.pending_attacks
                            .retain(|_, attack| attack.player_id != id);
                        return;
                    }
                },
                Ok(false) => {
                    let restored = store
                        .load_profile(&id, &profile)
                        .and_then(|profile| store.load_quests(&id).map(|quests| (profile, quests)));
                    match restored {
                        Ok((profile, quests)) => {
                            if let Some(player) = self.players.get_mut(&id) {
                                apply_profile_to_player(
                                    &self.gameplay,
                                    &self.mage_skills,
                                    player,
                                    profile,
                                );
                                player.quests = quests;
                            }
                            self.send_quest_list(&id);
                            self.send_snapshot(&id);
                        }
                        Err(error) => {
                            self.send_reject(&id, "persistence", &error, Some(&request_id))
                        }
                    }
                    return;
                }
                Err(error) => {
                    self.send_reject(&id, "persistence", &error, Some(&request_id));
                    return;
                }
            }
        }
        if let Some(profile) = authoritative_profile {
            apply_profile(&mut next_state, profile);
        }
        if let Some(player) = self.players.get_mut(&id) {
            player.state = next_state;
            refresh_player_derived(&self.gameplay, &self.mage_skills, player);
        }
        self.send_quest_update(&id, &quest_id, "active", QuestReward::default());
        self.send_quest_list(&id);
        self.send_snapshot(&id);
    }
}
