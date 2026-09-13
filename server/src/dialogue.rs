//! NPC 对话状态机与转职结算。
//!
//! 负责：NPC 对话请求的校验与推进（`handle_npc_talk`，距离/菜单绑定/selection 状态）、
//! 对话与商店回执下发（`send_npc_dialogue` / `send_shop_result`）、对话生命周期
//! （`end_conversation`）、NPC 菜单触发的转职效果（`apply_job_advance`）与
//! 法师一转补课（`ensure_mage_support`，Hans 的一次性兼容补发）。
//! 不负责：NPC 摆放/商店目录与对话脚本数据（`crate::npc`），转职后的等级/SP 规则
//! （`auth` 的 Store 事务）。
//!
//! 注意：子模块不能叫 `npc`——world.rs 顶部 `use crate::npc::{self, …}` 已占用该名字（E0255）。

use super::*;

impl World {
    pub(super) fn send_npc_dialogue(&self, id: &str, value: serde_json::Value) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let _ = player.output.try_send(value.to_string());
    }

    pub(super) fn send_shop_result(
        &self,
        id: &str,
        request_id: &str,
        success: bool,
        code: &str,
        shop_id: &str,
        item_id: &str,
        quantity: u32,
        mesos_spent: u64,
    ) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let message = serde_json::json!({
            "type":"shopResult",
            "requestId":request_id,
            "success":success,
            "code":code,
            "shopId":shop_id,
            "itemId":item_id,
            "quantity":quantity,
            "mesosSpent":mesos_spent,
        })
        .to_string();
        let _ = player.output.try_send(message);
    }

    pub(super) fn handle_npc_talk(
        &mut self,
        id: String,
        request_id: String,
        npc_id: String,
        step: Option<&str>,
        selection: Option<u32>,
    ) {
        let player_state = match self.players.get(&id) {
            Some(player) => (
                player.map_id.clone(),
                player.state.x,
                player.state.y,
                player.state.level,
                player.state.job,
                player.state.hp > 0 && player.state.action != "dead",
                player.state.mesos,
                player.state.inventory.clone(),
                player.lang,
            ),
            None => return,
        };
        let (map_id, px, py, level, job, can_advance, mesos, inventory, lang) = player_state;
        // Locate the npc and its template.
        let npc_view = {
            let Some(npc) = self.npcs.get(&npc_id) else {
                let (code, message) = if lang == crate::quest_text::LANG_EN {
                    ("npc_unknown", "That NPC is not on this map.")
                } else {
                    ("npc_unknown", "找不到该 NPC。")
                };
                self.send_reject(&id, code, message, Some(&request_id));
                return;
            };
            if npc.map_id != map_id {
                self.end_conversation(&id);
                let (code, message) = if lang == crate::quest_text::LANG_EN {
                    ("npc_too_far", "That NPC is on another map.")
                } else {
                    ("npc_too_far", "该 NPC 不在当前地图。")
                };
                self.send_reject(&id, code, message, Some(&request_id));
                return;
            }
            if !self.quest_npc_visible(&id, npc) {
                self.end_conversation(&id);
                let (code, message) = if lang == crate::quest_text::LANG_EN {
                    (
                        "npc_unavailable",
                        "That NPC cannot help you at this quest stage.",
                    )
                } else {
                    ("npc_unavailable", "该 NPC 当前无法与你对话。")
                };
                self.send_reject(&id, code, message, Some(&request_id));
                return;
            }
            (
                npc.template_id.clone(),
                npc.state.x,
                npc.state.y,
                npc.state.name.clone(),
                npc.state.name_zh.clone(),
            )
        };
        let (template_id, nx, ny, name, name_zh) = npc_view;
        let mage_entry = is_mage_advance_npc(&map_id, &npc_id, &template_id);
        // The 选择岔道 magician instructor deliberately has no talk range: the
        // player opens Hans from the map shortcut, so a distance rule would
        // only reject a request the client intentionally offers.  Every other
        // npc keeps the shared talk range below.
        if !mage_entry
            && ((px - nx).abs() > npc::TALK_RANGE_X || (py - ny).abs() > npc::TALK_RANGE_Y)
        {
            self.end_conversation(&id);
            let (code, message) = if lang == crate::quest_text::LANG_EN {
                ("npc_too_far", "Please stand closer to the NPC to talk.")
            } else {
                ("npc_too_far", "请靠近 NPC 后再与其对话。")
            };
            self.send_reject(&id, code, message, Some(&request_id));
            return;
        }
        let Some(template) = self
            .gameplay
            .npcs
            .iter()
            .find(|template| template.template_id == template_id)
            .cloned()
        else {
            let (code, message) = if lang == crate::quest_text::LANG_EN {
                ("npc_unknown", "NPC data is missing.")
            } else {
                ("npc_unknown", "该 NPC 资料缺失，暂时无法对话。")
            };
            self.send_reject(&id, code, message, Some(&request_id));
            return;
        };
        // 飞行船检票/播报（2026-09-14）：源站台没有静态登船门，检票员对话
        // 即检票动作。分发在仓库管理员之前，船务 NPC 不携带任何其他职能。
        if let Some(route_index) = super::ship::route_index_for_inspector(&template_id) {
            self.handle_ship_npc_talk(
                &id,
                &request_id,
                &npc_id,
                &name,
                name_zh.as_deref(),
                &lang,
                route_index,
                can_advance,
                true,
            );
            return;
        }
        if let Some(route_index) = super::ship::route_index_for_announcer(&template_id) {
            self.handle_ship_npc_talk(
                &id,
                &request_id,
                &npc_id,
                &name,
                name_zh.as_deref(),
                &lang,
                route_index,
                can_advance,
                false,
            );
            return;
        }
        // A warehouse keeper has no authored dialogue script: talking to one
        // *is* the "open my storage" action in the original.  Answering with
        // the shared `openStorage` marker keeps the same one-marker pattern as
        // `openSkills`, so the client opens the window without a bespoke
        // conversation tree per keeper.
        if template.func.contains(STORAGE_KEEPER_FUNC) {
            self.end_conversation(&id);
            if !can_advance {
                self.send_reject(&id, "dead", "死亡角色不能使用仓库。", Some(&request_id));
                return;
            }
            let mut value =
                npc::DialogueView::End.to_json(&request_id, &npc_id, &name, name_zh.as_deref());
            value["openStorage"] = serde_json::Value::Bool(true);
            self.send_npc_dialogue(&id, value);
            return;
        }
        if self.handle_quest_npc_menu(
            &id,
            &request_id,
            &npc_id,
            &template_id,
            &name,
            name_zh.as_deref(),
            lang,
            step,
            selection,
        ) {
            return;
        }
        let opening = step.is_none_or(|step| step == "start");
        if mage_entry && opening {
            match job {
                MAGICIAN_JOB | ICE_MAGE_JOB | 221 | 222 => {
                    if !can_advance {
                        self.end_conversation(&id);
                        self.send_reject(
                            &id,
                            "job_advance_unavailable",
                            "死亡角色不能使用法师训练。",
                            Some(&request_id),
                        );
                        return;
                    }
                    // The training conversation is only an offer.  Its
                    // one-time compatibility grant is committed after the
                    // player selects a supported action below, so merely
                    // opening Hans cannot mutate a live character.
                    let text = if lang == crate::quest_text::LANG_EN {
                        "Choose a Magician training action."
                    } else {
                        "请选择法师训练操作。"
                    };
                    if let Some(npc) = self.npcs.get_mut(&npc_id) {
                        npc.conversation
                            .insert(id.clone(), MAGE_TRAINING_NODE.to_owned());
                    }
                    let mut options = vec![
                        (
                            0,
                            if lang == crate::quest_text::LANG_EN {
                                "Open Magician skills"
                            } else {
                                "打开法师技能"
                            }
                            .to_owned(),
                        ),
                        (
                            1,
                            if lang == crate::quest_text::LANG_EN {
                                "Restore MP"
                            } else {
                                "恢复魔力"
                            }
                            .to_owned(),
                        ),
                    ];
                    if job == MAGICIAN_JOB && level >= 30 {
                        options.push((
                            2,
                            if lang == crate::quest_text::LANG_EN {
                                "Advance to Ice/Lightning Magician"
                            } else {
                                "转职为冰雷法师"
                            }
                            .to_owned(),
                        ));
                    }
                    if job == ICE_MAGE_JOB
                        && level >= 60
                        && self.mage_skills.get(SKILL_ICE_STORM).is_some()
                    {
                        options.push((
                            3,
                            if lang == crate::quest_text::LANG_EN {
                                "Advance to Ice/Lightning Arch Magician"
                            } else {
                                "转职为冰雷大魔导士"
                            }
                            .to_owned(),
                        ));
                    }
                    let mut value = npc::DialogueView::Say {
                        text: text.to_owned(),
                        kind: "simple".to_owned(),
                        options,
                    }
                    .to_json(&request_id, &npc_id, &name, name_zh.as_deref());
                    value["openSkills"] = serde_json::Value::Bool(false);
                    self.send_npc_dialogue(&id, value);
                    return;
                }
                BEGINNER_JOB if can_advance => {}
                BEGINNER_JOB => {
                    self.end_conversation(&id);
                    self.send_reject(
                        &id,
                        "job_advance_unavailable",
                        "死亡角色不能转职。",
                        Some(&request_id),
                    );
                    return;
                }
                _ => {
                    self.end_conversation(&id);
                    self.send_reject(
                        &id,
                        "job_advance_unavailable",
                        "只有新手可以在汉斯处转职为法师。",
                        Some(&request_id),
                    );
                    return;
                }
            }
        }
        let current_node = self
            .npcs
            .get(&npc_id)
            .and_then(|npc| npc.conversation.get(&id).cloned());
        if mage_entry && current_node.as_deref() == Some(MAGE_TRAINING_NODE) {
            if !can_advance {
                self.end_conversation(&id);
                self.send_reject(
                    &id,
                    "job_advance_unavailable",
                    "死亡角色不能使用法师训练。",
                    Some(&request_id),
                );
                return;
            }
            match (step, selection) {
                (Some("select"), Some(0)) => {
                    if job == MAGICIAN_JOB {
                        if let Err(error) = self.ensure_mage_support(&id) {
                            self.end_conversation(&id);
                            self.send_reject(&id, "persistence", &error, Some(&request_id));
                            return;
                        }
                    }
                    let mut value = npc::DialogueView::End.to_json(
                        &request_id,
                        &npc_id,
                        &name,
                        name_zh.as_deref(),
                    );
                    value["openSkills"] = serde_json::Value::Bool(true);
                    self.end_conversation(&id);
                    self.send_npc_dialogue(&id, value);
                }
                (Some("select"), Some(1)) => {
                    if job == MAGICIAN_JOB {
                        if let Err(error) = self.ensure_mage_support(&id) {
                            self.end_conversation(&id);
                            self.send_reject(&id, "persistence", &error, Some(&request_id));
                            return;
                        }
                    }
                    let old_mp = self
                        .players
                        .get(&id)
                        .map(|player| player.state.mp)
                        .unwrap_or(0);
                    let mut new_mp = old_mp;
                    let mut max_mp = 0;
                    if let Some(player) = self.players.get_mut(&id) {
                        refresh_player_derived(&self.gameplay, &self.mage_skills, player);
                        max_mp = player.state.max_mp;
                        new_mp = max_mp;
                        player.state.mp = max_mp;
                    }
                    if let Some(store) = self.store.as_ref() {
                        let persisted = self.players.get(&id).map(|player| {
                            profile_from_state(
                                &player.state,
                                &player.map_id,
                                &player.death_id,
                                player.base_max_mp,
                            )
                        });
                        if let Some(profile) = persisted {
                            if let Err(error) = store.save_profile(&id, &profile) {
                                if let Some(player) = self.players.get_mut(&id) {
                                    player.state.mp = old_mp;
                                }
                                self.send_reject(&id, "persistence", &error, Some(&request_id));
                                return;
                            }
                        }
                    }
                    let mut value = npc::DialogueView::End.to_json(
                        &request_id,
                        &npc_id,
                        &name,
                        name_zh.as_deref(),
                    );
                    value["trainingResult"] = serde_json::json!({
                        "kind": "restoreMp",
                        "mp": new_mp,
                        "maxMp": max_mp,
                        "temporary": true,
                    });
                    self.end_conversation(&id);
                    self.send_npc_dialogue(&id, value);
                }
                (Some("select"), Some(2)) if job == MAGICIAN_JOB && level >= 30 => {
                    match self.apply_job_advance(
                        &id,
                        &map_id,
                        &npc_id,
                        &template_id,
                        MAGICIAN_JOB,
                        ICE_MAGE_JOB,
                    ) {
                        Ok(true) => {
                            let mut value = npc::DialogueView::End.to_json(
                                &request_id,
                                &npc_id,
                                &name,
                                name_zh.as_deref(),
                            );
                            value["openSkills"] = serde_json::Value::Bool(true);
                            value["trainingResult"] = serde_json::json!({
                                "kind": "jobAdvance",
                                "job": ICE_MAGE_JOB,
                            });
                            self.end_conversation(&id);
                            self.send_npc_dialogue(&id, value);
                        }
                        Ok(false) => {
                            self.end_conversation(&id);
                            self.send_reject(
                                &id,
                                "job_advance_unavailable",
                                "冰雷转职条件不满足。",
                                Some(&request_id),
                            );
                        }
                        Err(error) => {
                            self.end_conversation(&id);
                            self.send_reject(&id, "persistence", &error, Some(&request_id));
                        }
                    }
                }
                (Some("select"), Some(3))
                    if job == ICE_MAGE_JOB
                        && level >= 60
                        && self.mage_skills.get(SKILL_ICE_STORM).is_some() =>
                {
                    match self.apply_job_advance(
                        &id,
                        &map_id,
                        &npc_id,
                        &template_id,
                        ICE_MAGE_JOB,
                        ICE_THIRD_JOB,
                    ) {
                        Ok(true) => {
                            let mut value = npc::DialogueView::End.to_json(
                                &request_id,
                                &npc_id,
                                &name,
                                name_zh.as_deref(),
                            );
                            value["openSkills"] = serde_json::Value::Bool(true);
                            value["trainingResult"] = serde_json::json!({
                                "kind": "jobAdvance",
                                "job": ICE_THIRD_JOB,
                            });
                            self.end_conversation(&id);
                            self.send_npc_dialogue(&id, value);
                        }
                        Ok(false) => {
                            self.end_conversation(&id);
                            self.send_reject(
                                &id,
                                "job_advance_unavailable",
                                "冰雷三转条件不满足。",
                                Some(&request_id),
                            );
                        }
                        Err(error) => {
                            self.end_conversation(&id);
                            self.send_reject(&id, "persistence", &error, Some(&request_id));
                        }
                    }
                }
                (Some("end"), _) => {
                    self.end_conversation(&id);
                    self.send_npc_dialogue(
                        &id,
                        npc::DialogueView::End.to_json(
                            &request_id,
                            &npc_id,
                            &name,
                            name_zh.as_deref(),
                        ),
                    );
                }
                _ => {
                    self.end_conversation(&id);
                    let (code, message) = if lang == crate::quest_text::LANG_EN {
                        (
                            "npc_step_invalid",
                            "This conversation option is no longer available.",
                        )
                    } else {
                        ("npc_step_invalid", "该对话选项已失效，请重新与 NPC 交谈。")
                    };
                    self.send_reject(&id, code, message, Some(&request_id));
                }
            }
            return;
        }
        let Some(script) = template.script.clone() else {
            self.send_npc_dialogue(
                &id,
                npc::DialogueView::End.to_json(&request_id, &npc_id, &name, name_zh.as_deref()),
            );
            self.end_conversation(&id);
            return;
        };
        let current_node = self
            .npcs
            .get(&npc_id)
            .and_then(|npc| npc.conversation.get(&id).cloned());
        if current_node.as_deref() == Some(ALREADY_MAGICIAN_NODE) {
            if step == Some("end") {
                self.end_conversation(&id);
                self.send_npc_dialogue(
                    &id,
                    npc::DialogueView::End.to_json(&request_id, &npc_id, &name, name_zh.as_deref()),
                );
            } else {
                self.end_conversation(&id);
                let (code, message) = if lang == crate::quest_text::LANG_EN {
                    (
                        "npc_step_invalid",
                        "This conversation option is no longer available.",
                    )
                } else {
                    ("npc_step_invalid", "该对话选项已失效，请重新与 NPC 交谈。")
                };
                self.send_reject(&id, code, message, Some(&request_id));
            }
            return;
        }
        let quests = self
            .players
            .get(&id)
            .map(|player| player.quests.clone())
            .unwrap_or_default();
        let hp = self
            .players
            .get(&id)
            .map(|player| u32::try_from(player.state.hp.max(0)).unwrap_or(0))
            .unwrap_or(0);
        let context = DialogueContext {
            hp,
            level,
            mesos,
            inventory: &inventory,
            quests: &quests,
            lang,
        };
        match npc::advance(&script, current_node.as_deref(), step, selection, &context) {
            Ok((next_node, view, effect)) => {
                let mut quest_effect = None;
                let mut job_advanced = false;
                if let Some(effect) = effect {
                    match effect {
                        npc::QuestEffect::JobAdvance { from_job, job } => {
                            match self.apply_job_advance(
                                &id,
                                &map_id,
                                &npc_id,
                                &template_id,
                                from_job,
                                job,
                            ) {
                                Ok(true) => job_advanced = true,
                                Ok(false) => {
                                    self.end_conversation(&id);
                                    // A beginner reaching this branch cleared
                                    // the "is a beginner" gate and failed the
                                    // level one — the original first transfer
                                    // is a level-10 step (1402 lvmin).
                                    let message = if job == BEGINNER_JOB {
                                        "轉職需要達到10級。"
                                    } else {
                                        "只有新手可以在汉斯处转职为法师。"
                                    };
                                    self.send_reject(
                                        &id,
                                        "job_advance_unavailable",
                                        message,
                                        Some(&request_id),
                                    );
                                    return;
                                }
                                Err(error) => {
                                    self.end_conversation(&id);
                                    self.send_reject(&id, "persistence", &error, Some(&request_id));
                                    return;
                                }
                            }
                        }
                        effect => quest_effect = Some(effect),
                    }
                }
                let mut value = view.to_json(&request_id, &npc_id, &name, name_zh.as_deref());
                if job_advanced {
                    value["openSkills"] = serde_json::Value::Bool(true);
                }
                if let Some(npc) = self.npcs.get_mut(&npc_id) {
                    if let npc::DialogueView::End = &view {
                        npc.conversation.remove(&id);
                    } else {
                        npc.conversation.insert(id.clone(), next_node);
                    }
                }
                // Warp immediately when the dialogue resolves to one.
                if let npc::DialogueView::Warp { map_id: warp_to } = &view {
                    let target = warp_to.clone();
                    if !self.warp_player(&id, target) {
                        self.end_conversation(&id);
                        self.send_reject(
                            &id,
                            "persistence",
                            "傳送未能保存，請稍後重試。",
                            Some(&request_id),
                        );
                        return;
                    }
                }
                self.send_npc_dialogue(&id, value);
                // A merchant window owns a buy-back tab, so the list of what
                // this character has sold to any shop travels with the window
                // that shows it.
                if matches!(&view, npc::DialogueView::OpenShop { .. }) {
                    self.send_shop_rebuy_state(&id);
                }
                // Apply the one-shot quest effect after the client has been
                // told the conversation ended.
                if let Some(effect) = quest_effect {
                    self.apply_quest_effect(&id, effect);
                }
            }
            Err(error) => {
                self.end_conversation(&id);
                self.send_reject(&id, "npc_step_invalid", &error, Some(&request_id));
            }
        }
    }

    pub(super) fn end_conversation(&mut self, player_id: &str) {
        for npc in self.npcs.values_mut() {
            npc.conversation.remove(player_id);
        }
        // Closing the conversation also closes the warehouse window: the two
        // are the same interaction with the same npc, so a player who walks
        // away must not keep a live storage session behind.
        self.close_storage(player_id);
    }

    pub(super) fn apply_job_advance(
        &mut self,
        id: &str,
        map_id: &str,
        npc_id: &str,
        template_id: &str,
        from_job: u32,
        job: u32,
    ) -> Result<bool, String> {
        let first_transfer = from_job == BEGINNER_JOB && job == MAGICIAN_JOB;
        let second_transfer = from_job == MAGICIAN_JOB && job == ICE_MAGE_JOB;
        let third_transfer = from_job == ICE_MAGE_JOB && job == ICE_THIRD_JOB;
        if !is_mage_advance_npc(map_id, npc_id, template_id)
            || (!first_transfer && !second_transfer && !third_transfer)
        {
            return Ok(false);
        }
        let Some(player) = self.players.get(id) else {
            return Ok(false);
        };
        if player.state.job != from_job
            || player.state.hp <= 0
            || player.state.action == "dead"
            || (second_transfer && player.state.level < 30)
            || (third_transfer
                && (player.state.level < 60 || self.mage_skills.get(SKILL_ICE_STORM).is_none()))
        {
            return Ok(false);
        }
        if let Some(store) = self.store.as_ref() {
            if !store.advance_job(id, from_job, job)? {
                return Ok(false);
            }
        }
        let loaded_profile = if self.store.is_some() {
            let defaults = self.default_profile();
            Some(
                self.store
                    .as_ref()
                    .ok_or_else(|| "account store unavailable".to_owned())?
                    .load_profile(id, &defaults)?,
            )
        } else {
            None
        };
        if let Some(player) = self.players.get_mut(id) {
            player.state.job = job;
            if self.store.is_none() {
                if first_transfer {
                    player.base_max_mp = player.base_max_mp.max(MAGE_TRANSFER_MIN_MP);
                    player.state.skill_points.entry(MAGE_BOOK).or_insert(5);
                    player
                        .state
                        .skills
                        .entry(SKILL_ELEMENTAL_WEAKEN)
                        .or_insert(1);
                    player
                        .state
                        .skills
                        .entry(SKILL_MAGIC_WAVE_HIDDEN)
                        .or_insert(1);
                    player.state.max_mp = player.base_max_mp;
                    player.state.mp = player.state.max_mp;
                } else if second_transfer {
                    player.state.skill_points.entry(ICE_BOOK).or_insert(5);
                    player.state.skills.entry(SKILL_ICE_EFFECT).or_insert(1);
                }
                if third_transfer {
                    player.state.skill_points.entry(THIRD_BOOK).or_insert(5);
                }
                refresh_player_derived(&self.gameplay, &self.mage_skills, player);
            } else {
                if let Some(profile) = loaded_profile {
                    player.base_max_mp = profile.max_mp.max(0);
                    apply_profile_to_player(&self.gameplay, &self.mage_skills, player, profile);
                }
            }
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Hans' one-time compatibility grant for rows that were already job 200
    /// before the first-job runtime existed.  The Store transaction owns the
    /// idempotence bit; the no-Store world mirrors the same or-insert behavior
    /// for unit tests without inventing a second reset path.
    pub(super) fn ensure_mage_support(&mut self, id: &str) -> Result<bool, String> {
        let Some(player) = self.players.get(id) else {
            return Ok(false);
        };
        if player.state.job != MAGICIAN_JOB {
            return Ok(false);
        }
        if let Some(store) = self.store.as_ref() {
            let granted = store.ensure_mage_support(id)?;
            if granted {
                let profile = store.load_profile(id, &self.default_profile())?;
                if let Some(player) = self.players.get_mut(id) {
                    apply_profile_to_player(&self.gameplay, &self.mage_skills, player, profile);
                }
            }
            Ok(granted)
        } else {
            let Some(player) = self.players.get_mut(id) else {
                return Ok(false);
            };
            let changed = player.state.skill_points.get(&MAGE_BOOK).is_none()
                || !player.state.skills.contains_key(&SKILL_ELEMENTAL_WEAKEN)
                || !player.state.skills.contains_key(&SKILL_MAGIC_WAVE_HIDDEN)
                || player.base_max_mp < MAGE_TRANSFER_MIN_MP;
            if changed {
                player.base_max_mp = player.base_max_mp.max(MAGE_TRANSFER_MIN_MP);
                player.state.skill_points.entry(MAGE_BOOK).or_insert(5);
                player
                    .state
                    .skills
                    .entry(SKILL_ELEMENTAL_WEAKEN)
                    .or_insert(1);
                player
                    .state
                    .skills
                    .entry(SKILL_MAGIC_WAVE_HIDDEN)
                    .or_insert(1);
                refresh_player_derived(&self.gameplay, &self.mage_skills, player);
            }
            Ok(changed)
        }
    }
}
