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

/// 推进「源台词」阶段的结果（阶段二）。
pub(super) enum LineStep {
    /// 当前会话节点不是台词页：调用方按自己的状态机处理。
    NotALine,
    /// 已经产出并下发了一个视图，本次请求到此为止。
    Answered,
    /// 台词播完，且这次对话后面还挂着任务菜单：控制权交回调用方。
    ContinueToMenu,
}

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
        let crossroad_entry = is_crossroad_advance_npc(&map_id, &npc_id, &template_id);
        // The 选择岔道 magician instructor deliberately has no talk range: the
        // player opens Hans from the map shortcut, so a distance rule would
        // only reject a request the client intentionally offers.  Every other
        // npc keeps the shared talk range below.
        if !crossroad_entry
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
        // 危險地帶的 UFO 呼叫器（2026-09-15）：源 `Graph.json` 把草原Ⅳ
        // `221030400` 的进场写成 NPC 脚本（`portalNum: 9999`），该图没有
        // 任何授权这跳的静态门 ⇒ 对话即进场动作。分发在仓库管理员之前，
        // 呼叫器不携带任何其他职能。
        if super::ufo::is_ufo_pager(&template_id, &map_id) {
            self.handle_ufo_pager(
                &id,
                &request_id,
                &npc_id,
                &name,
                name_zh.as_deref(),
                &lang,
                can_advance,
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
        // 转职任务（2026-09-21）：原版转職官漢斯（模板 1032001 / 地圖 101000003）
        // 的完整任务流程——等级与前置校验、收集与击杀目标、进度落盘、交付即转职。
        //
        // 分发位置刻意在通用任务菜单**之前**：命中的判据是「当前职业 == fromJob 且
        // 站对了 NPC」，所以新手（job 0）在这里不命中，照旧由 `handle_quest_npc_menu`
        // 接去走源 1402 的一转任务；已转职的角色也不会被快捷菜单挡住。
        // 「選擇岔道」漢斯（10201）不在这条链上，那是有自己判据的用户指定快捷入口。
        if self.handle_job_advance_talk(
            &id,
            &request_id,
            &npc_id,
            &template_id,
            &map_id,
            &name,
            name_zh.as_deref(),
            &lang,
            step,
            selection,
        ) {
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
        if crossroad_entry && opening {
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
                        // 「選擇岔道」是**一转**入口（四条探险家线），不是给已转职
                        // 角色办事的地方；法师另有自己的训练菜单（上面那条臂）。
                        "只有新手可以在这里转职（剑士/法师/弓箭手/飞侠）。",
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
        if crossroad_entry && current_node.as_deref() == Some(MAGE_TRAINING_NODE) {
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
        // 阶段二（2026-09-17）：无原版脚本的模板由**源台词表**说话。
        //
        // 走到这里说明该模板既没有原版脚本，也不属于船务／呼叫器／仓库／任务菜单／
        // 转职任何一条已接入的分发。阶段一在这一支只回占位提示（当时的口径是
        // 「还没有内容」）；阶段二把 `shared/npc-dialogue.json`（源 `Npc.wz`
        // `info/speak` 声明的顺序 + `String/Npc.json` 的文本）接进来后，绝大多数
        // 模板能说出源里真实说过的话，占位收窄为「源里确实没有说话内容」的那批
        // 物件型条目（`傳送門`／`警告牌`／`繳納箱`…）。详见 `npc::NpcDialogue`。
        // 根因修复（2026-09-17）：**源 NPC 脚本的接线槽位就在这里**。
        //
        // `scripts/generate_tms273_gameplay.py` 从设计上不转换 `info/script`（该文件
        // 的 `incomplete` 段明写 "NPC dialogue/script references are not converted"），
        // 所以即使源脚本实体就在包里（`script/npc/victoria_taxi.js`），模板里的
        // `script` 仍然是 null ⇒ 計程車这类**传送类** NPC 只能「说一句、然后什么都不
        // 发生」。`shared/npc-scripts.json` 把源脚本按可证明的模式转成同一套 DSL，
        // 在这一槽位补上；**模板自带的 DSL 优先**（那是本项目已核定的内容，且
        // `validate()` 已在加载时校验过它）。
        let source_script = self.npc_scripts.get(&template_id).cloned();
        let Some(script) = template.script.clone().or(source_script) else {
            self.handle_scriptless_npc_talk(
                &id,
                &request_id,
                &npc_id,
                &template_id,
                &name,
                name_zh.as_deref(),
                step,
                opening,
                lang,
            );
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
        // The map the player is on right now.  Menu options may gate on it
        // (`Condition::map_is_not`) — 維多利亞計程車 lists the four towns it is
        // placed in and hides whichever one you are standing in.
        let player_map = self
            .players
            .get(&id)
            .map(|player| player.map_id.clone())
            .unwrap_or_default();
        let context = DialogueContext {
            hp,
            level,
            mesos,
            inventory: &inventory,
            quests: &quests,
            map_id: &player_map,
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
                                    // 新手过了「是新手」那道闸、却没过等级门槛：一转的
                                    // 等级按线取（法师 8 级例外，物理三线同源 10 级）。
                                    let message = if from_job == BEGINNER_JOB {
                                        if job == MAGICIAN_JOB {
                                            "法師一轉需要達到8級。"
                                        } else {
                                            "轉職需要達到10級。"
                                        }
                                    } else {
                                        "只有新手可以在这里转职（剑士/法师/弓箭手/飞侠）。"
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

    /// 无原版脚本、也不属于任何已接入职能分发的模板：用源台词表说话。
    ///
    /// 阶段二的主路径。`opening` 为真（客户端刚点开）时开台词阶段；否则推进一页。
    /// 源里的确没有说话内容的模板回占位提示（`npc::PLACEHOLDER_DIALOGUE`）——
    /// 那不是「还没接」，是「源里就没有」。
    fn handle_scriptless_npc_talk(
        &mut self,
        id: &str,
        request_id: &str,
        npc_id: &str,
        template_id: &str,
        name: &str,
        name_zh: Option<&str>,
        step: Option<&str>,
        opening: bool,
        lang: &str,
    ) {
        match self.advance_npc_lines(id, request_id, npc_id, template_id, name, name_zh, step) {
            LineStep::Answered => return,
            // 这一支后面不挂任务菜单（有任务可做的模板在 `handle_quest_npc_menu` 就被
            // 接走了，那里会自己出「台词 → 菜单」的序列），所以 `ContinueToMenu`
            // 到不了这里；真到了也只能按结束处理。
            LineStep::ContinueToMenu | LineStep::NotALine => {}
        }
        if opening && self.open_npc_lines(id, request_id, npc_id, template_id, name, name_zh, false) {
            return;
        }
        self.end_conversation(id);
        let value = if opening {
            npc::placeholder_view(request_id, npc_id, name, name_zh, lang)
        } else {
            npc::DialogueView::End.to_json(request_id, npc_id, name, name_zh)
        };
        self.send_npc_dialogue(id, value);
    }

    /// 当前会话节点是不是台词页；是则给出 `(页号, 之后是否接任务菜单)`。
    fn line_node(&self, id: &str, npc_id: &str) -> Option<(usize, bool)> {
        self.npcs
            .get(npc_id)
            .and_then(|npc| npc.conversation.get(id))
            .and_then(|node| npc::parse_line_node(node))
    }

    fn set_line_node(&mut self, id: &str, npc_id: &str, index: usize, menu: bool) {
        if let Some(npc) = self.npcs.get_mut(npc_id) {
            npc.conversation
                .insert(id.to_owned(), npc::line_node(index, menu));
        }
    }

    /// 开启台词阶段：出第 0 页并把会话节点置为台词页。
    ///
    /// 返回 `false` ＝这个模板在源里没有说话内容，调用方自己决定退路（占位提示）。
    /// `menu_after` 为真时最后一页仍然给「下一页」，好把玩家送进后面的任务菜单。
    pub(super) fn open_npc_lines(
        &mut self,
        id: &str,
        request_id: &str,
        npc_id: &str,
        template_id: &str,
        name: &str,
        name_zh: Option<&str>,
        menu_after: bool,
    ) -> bool {
        let Some(lines) = self.npc_dialogue.get(template_id).map(|entry| entry.lines.clone())
        else {
            return false;
        };
        let Some(first) = lines.first().cloned() else {
            return false;
        };
        self.set_line_node(id, npc_id, 0, menu_after);
        let more = lines.len() > 1 || menu_after;
        self.send_npc_dialogue(
            id,
            npc::line_view(request_id, npc_id, name, name_zh, &first, more),
        );
        true
    }

    /// 推进台词页。演出与原版一致：一页一句，末页给「确认」。
    ///
    /// 只有当前节点确实编码着台词页时才会接手；否则回 `NotALine`，让调用方按自己的
    /// 状态机处理（脚本节点、任务菜单缓存节点、法师训练节点都走那条路）。
    pub(super) fn advance_npc_lines(
        &mut self,
        id: &str,
        request_id: &str,
        npc_id: &str,
        template_id: &str,
        name: &str,
        name_zh: Option<&str>,
        step: Option<&str>,
    ) -> LineStep {
        let Some((index, menu)) = self.line_node(id, npc_id) else {
            return LineStep::NotALine;
        };
        let lines = self
            .npc_dialogue
            .get(template_id)
            .map(|entry| entry.lines.clone())
            .unwrap_or_default();
        let next = index + 1;
        if step == Some("end") {
            // 玩家按了关闭：直接把这次对话收掉，不要因为「后面还挂着菜单」而把菜单
            // 弹出来——那等于关不掉窗口。
            self.end_conversation(id);
            self.send_npc_dialogue(
                id,
                npc::DialogueView::End.to_json(request_id, npc_id, name, name_zh),
            );
            return LineStep::Answered;
        }
        if step == Some("next") && next < lines.len() {
            self.set_line_node(id, npc_id, next, menu);
            let more = next + 1 < lines.len() || menu;
            self.send_npc_dialogue(
                id,
                npc::line_view(request_id, npc_id, name, name_zh, &lines[next], more),
            );
            return LineStep::Answered;
        }
        if menu {
            // 台词播完、后面还有任务菜单：清掉台词节点，把控制权交回菜单分支
            // （它会写自己的 `QUEST_MENU_NODE…` 状态）。
            if let Some(npc) = self.npcs.get_mut(npc_id) {
                npc.conversation.remove(id);
            }
            return LineStep::ContinueToMenu;
        }
        self.end_conversation(id);
        self.send_npc_dialogue(
            id,
            npc::DialogueView::End.to_json(request_id, npc_id, name, name_zh),
        );
        LineStep::Answered
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
        // 一转（`0 → 100/200/300/400`）：四条探险家线共用「選擇岔道」漢斯这一个入口，
        // 菜单由 `scripts/assemble_tms273.cjs::FIRST_JOBS` 生成。二/三/四转是法师专属
        // 快捷线（原版转职官的任务流程在 `world::job_advance`，不走这里）。
        let first_transfer = from_job == BEGINNER_JOB && crate::mage::is_first_job(job);
        let second_transfer = from_job == MAGICIAN_JOB && job == ICE_MAGE_JOB;
        let third_transfer = from_job == ICE_MAGE_JOB && job == ICE_THIRD_JOB;
        if !is_crossroad_advance_npc(map_id, npc_id, template_id)
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
            || (first_transfer && player.state.level < auth::first_job_level(job))
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
                    // 与事务路径共用**同一份**发放实现（`auth::grant_first_job_fields`）：
                    // 测试里发的和线上发的必须一样，不在两处各写一遍。
                    let mut max_mp = player.base_max_mp;
                    let mut mp = player.base_max_mp;
                    let mut skills = std::mem::take(&mut player.state.skills);
                    let mut points = std::mem::take(&mut player.state.skill_points);
                    auth::grant_first_job_fields(job, &mut max_mp, &mut mp, &mut skills, &mut points);
                    player.base_max_mp = max_mp;
                    player.state.skills = skills;
                    player.state.skill_points = points;
                    player.state.max_mp = max_mp;
                    player.state.mp = max_mp;
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
