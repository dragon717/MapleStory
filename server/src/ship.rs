//! 飞行船航线系统（一期：維多利亞樹木站台 ⇄ 天空之城）。
//!
//! 源事实（TMS273.7 WZ，2026-09-14 实测）：站台与候船室都没有静态登船门——
//! 登船由检票员 NPC 在检票窗口内执行，到站为系统强制传送。TMS273 不带
//! `station_in` 等脚本体，时刻与检票规则按既有授权走 P 级常量（联网多来源
//! 核对的经典乘船规则），集中在下面三个常量，后续有同版证据只改这里。
//!
//! 一期边界（与 `docs/plan/topics/飞行船航线系统实现方案.md` 对齐）：
//! - 检票 = 与站台上的检票员对话（`104020110` 的 `1032008`、`200000100` 的
//!   `2012000`）；候船室 `200000112`/船員 阿霖 `2012002` 已随目录装配但一期
//!   不承载机制（`east00` 的 `station_in` 脚本门保持关闭提示旧行为）。
//! - 票务道具 ID 未核实，一期免费登船（P 级）。
//! - 航行中甲板刷蝙蝠魔属二期 Balrog 事件，不建模。

use super::*;

/// 班次槽：每 15 分钟一班（槽内 0..9 分钟航行、10..14 分钟本端靠港检票）。
pub(crate) const SHIP_SLOT_SECONDS: i64 = 15 * 60;
/// 航行时长：开船后 10 分钟到达。
pub(crate) const SHIP_SAIL_SECONDS: i64 = 10 * 60;
/// 开船前 1 分钟停止登船（检票窗口最后一分钟只出不进）。
pub(crate) const SHIP_BOARD_GRACE: i64 = 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ShipPhase {
    Sailing { left: i64 },
    Boarding { left: i64 },
}

/// 相位是 unix 时间的纯函数：服务重启不会丢失或漂移。
pub(crate) fn ship_phase_of(now_unix: i64) -> ShipPhase {
    let minute = now_unix.rem_euclid(SHIP_SLOT_SECONDS);
    if minute < SHIP_SAIL_SECONDS {
        ShipPhase::Sailing { left: SHIP_SAIL_SECONDS - minute }
    } else {
        ShipPhase::Boarding { left: SHIP_SLOT_SECONDS - minute }
    }
}

/// 一条航线：检票地图（检票员所在）、甲板、船舱与到站站台。
/// 检票地图即登船地图——源站台没有静态登船门，对话即检票。
pub(crate) struct ShipRoute {
    /// 快照 `ship.route` 标识（协议只认这一个字符串）。
    pub id: &'static str,
    pub board_map: &'static str,
    pub deck: &'static str,
    pub cabin: &'static str,
    pub dest_station: &'static str,
    /// 在 `board_map` 上执行检票的 NPC 模板 id。
    pub inspector: &'static str,
    /// 只播报时刻、不检票的 NPC 模板 id（可为空切片）。
    pub announcers: &'static [&'static str],
}

pub(crate) static ROUTE_VICTORIA_ORBIS: ShipRoute = ShipRoute {
    id: "victoria-orbis",
    board_map: "104020110",
    deck: "200090010",
    cabin: "200090011",
    dest_station: "200000100",
    inspector: "1032008",
    announcers: &["1032007"],
};

pub(crate) static ROUTE_ORBIS_VICTORIA: ShipRoute = ShipRoute {
    id: "orbis-victoria",
    board_map: "200000100",
    deck: "200090000",
    cabin: "200090001",
    dest_station: "104020110",
    inspector: "2012000",
    // 候船室的船員 阿霖一期不承载机制（不路由进候船室）。
    announcers: &[],
};

pub(crate) static SHIP_ROUTES: [&ShipRoute; 2] =
    [&ROUTE_VICTORIA_ORBIS, &ROUTE_ORBIS_VICTORIA];

/// 哪条航线与这张地图相关（快照 `ship` 字段只在船图/站台图携带）。
pub(crate) fn route_index_for_map(map_id: &str) -> Option<usize> {
    match map_id {
        "104020110" | "200090010" | "200090011" => Some(0),
        "200000100" | "200000112" | "200090000" | "200090001" => Some(1),
        _ => None,
    }
}

/// 检票员 → 航线索引（对话分发用）。
pub(crate) fn route_index_for_inspector(template_id: &str) -> Option<usize> {
    SHIP_ROUTES
        .iter()
        .position(|route| route.inspector == template_id)
}

/// 播报员 → 航线索引（对话分发用）。
pub(crate) fn route_index_for_announcer(template_id: &str) -> Option<usize> {
    SHIP_ROUTES
        .iter()
        .position(|route| route.announcers.contains(&template_id))
}

/// 快照注入：只带三个展示字段；客户端据此显示班次状态，永不据此判定。
pub(crate) fn ship_snapshot_field(route_index: usize) -> serde_json::Value {
    let route = SHIP_ROUTES[route_index];
    match ship_phase_of(unix_now_ms() / 1000) {
        ShipPhase::Sailing { left } => serde_json::json!({
            "route": route.id, "phase": "sailing", "secondsLeft": left,
        }),
        ShipPhase::Boarding { left } => serde_json::json!({
            "route": route.id, "phase": "boarding", "secondsLeft": left,
        }),
    }
}

/// 面向玩家的中文/英文班次播报（检票失败与售票员共用同一份事实）。
pub(crate) fn ship_schedule_text(_route_index: usize, lang: &str) -> String {
    let en = lang == crate::quest_text::LANG_EN;
    match ship_phase_of(unix_now_ms() / 1000) {
        ShipPhase::Sailing { left } => {
            let sail = (left + 59) / 60;
            let board = (left + SHIP_SLOT_SECONDS - SHIP_SAIL_SECONDS + 59) / 60;
            if en {
                format!(
                    "The airship is sailing. It arrives in about {sail} min; the next boarding opens in about {board} min."
                )
            } else {
                format!(
                    "飛行船正在航行中，約 {sail} 分鐘後到站；下一班約 {board} 分鐘後開始檢票。"
                )
            }
        }
        ShipPhase::Boarding { left } => {
            let left_min = (left + 59) / 60;
            if en {
                format!("Boarding is open. The airship departs in about {left_min} min.")
            } else {
                format!("檢票進行中，飛行船約 {left_min} 分鐘後啟航。")
            }
        }
    }
}

/// 检票失败文案键（`ship_board` 的错误在这里翻译成人话）。
enum ShipBoardRefusal {
    Sailing,
    Grace,
    Other,
}

impl World {
    /// 船务 NPC 对话（`dialogue.rs` 分发）：检票员执行登船，播报员只报班次。
    /// 检票成功先回一条 `ended` 关掉客户端对话窗，再由 `warp_player_at`
    /// 发出的快照完成切图；失败以班次播报文本呈现，不是协议错误码。
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn handle_ship_npc_talk(
        &mut self,
        id: &str,
        request_id: &str,
        npc_id: &str,
        name: &str,
        name_zh: Option<&str>,
        lang: &str,
        route_index: usize,
        can_board: bool,
        is_inspector: bool,
    ) {
        self.end_conversation(id);
        let schedule = ship_schedule_text(route_index, lang);
        if !is_inspector {
            let value = npc::DialogueView::Say {
                text: schedule,
                kind: "simple".to_owned(),
                options: Vec::new(),
            }
            .to_json(request_id, npc_id, name, name_zh);
            self.send_npc_dialogue(id, value);
            return;
        }
        if !can_board {
            self.send_reject(id, "dead", "死亡角色不能登船。", Some(request_id));
            return;
        }
        if self.ship_board(id, route_index).is_err() {
            let en = lang == crate::quest_text::LANG_EN;
            let text = match self.ship_board_reason(route_index) {
                ShipBoardRefusal::Sailing => {
                    if en {
                        format!("{schedule} Please wait for the next boarding.")
                    } else {
                        format!("{schedule} 請等候下一班檢票。")
                    }
                }
                ShipBoardRefusal::Grace => {
                    if en {
                        "Boarding closes one minute before departure. Please wait for the next boarding.".to_owned()
                    } else {
                        "開船前 1 分鐘停止登船，請等候下一班檢票。".to_owned()
                    }
                }
                ShipBoardRefusal::Other => {
                    if en {
                        "Boarding is unavailable right now.".to_owned()
                    } else {
                        "現在無法登船，請稍後再試。".to_owned()
                    }
                }
            };
            let value = npc::DialogueView::Say {
                text,
                kind: "simple".to_owned(),
                options: Vec::new(),
            }
            .to_json(request_id, npc_id, name, name_zh);
            self.send_npc_dialogue(id, value);
            return;
        }
        let value = npc::DialogueView::End.to_json(request_id, npc_id, name, name_zh);
        self.send_npc_dialogue(id, value);
    }

    /// 供文案层区分检票失败原因；与 `ship_board` 的判定同源。
    fn ship_board_reason(&self, _route_index: usize) -> ShipBoardRefusal {
        match ship_phase_of(unix_now_ms() / 1000) {
            ShipPhase::Sailing { .. } => ShipBoardRefusal::Sailing,
            ShipPhase::Boarding { left } if left <= SHIP_BOARD_GRACE => ShipBoardRefusal::Grace,
            _ => ShipBoardRefusal::Other,
        }
    }

    /// 检票登船（生产入口）：以当前 unix 时间判定相位。
    pub(crate) fn ship_board(&mut self, player_id: &str, route_index: usize) -> Result<(), &'static str> {
        self.ship_board_at(player_id, route_index, unix_now_ms() / 1000)
    }

    /// 检票登船（验收入口）：时间可注入，断言才有决定性。
    pub(crate) fn ship_board_at(
        &mut self,
        player_id: &str,
        route_index: usize,
        now_unix: i64,
    ) -> Result<(), &'static str> {
        let route = SHIP_ROUTES[route_index];
        match ship_phase_of(now_unix) {
            ShipPhase::Sailing { .. } => return Err("sailing"),
            ShipPhase::Boarding { left } if left <= SHIP_BOARD_GRACE => return Err("grace"),
            ShipPhase::Boarding { .. } => {}
        }
        let Some(player) = self.players.get(player_id) else {
            return Err("unknown_player");
        };
        if player.map_id != route.board_map {
            return Err("wrong_map");
        }
        if self.warp_player_at(player_id, route.deck.to_owned(), Some("sp")) {
            let passengers = &mut self.ship_passengers[route_index];
            if !passengers.iter().any(|id| id == player_id) {
                passengers.push(player_id.to_owned());
            }
            Ok(())
        } else {
            Err("deck_unavailable")
        }
    }

    /// 顺序模拟 tick 尾部调用：相位进入航行且名单非空 ⇒ 到站传送。
    /// 只传送仍在甲板/船舱的乘客；死亡回到 returnMap 的角色保留自己的权威
    /// 落点。名单为进程内状态，服务重启即清空——到站只是 warp，权威落点
    /// 在快照与存档，符合「内存状态可丢」边界。
    pub(crate) fn step_ship(&mut self) {
        self.step_ship_at(unix_now_ms() / 1000);
    }

    /// 到站步进（验收入口）：时间可注入。
    pub(crate) fn step_ship_at(&mut self, now_unix: i64) {
        let now = now_unix;
        for (index, route) in SHIP_ROUTES.iter().enumerate() {
            if !matches!(ship_phase_of(now), ShipPhase::Sailing { .. }) {
                continue;
            }
            let passengers = std::mem::take(&mut self.ship_passengers[index]);
            for player_id in passengers {
                let aboard = self
                    .players
                    .get(&player_id)
                    .map(|player| player.map_id == route.deck || player.map_id == route.cabin)
                    .unwrap_or(false);
                if aboard {
                    self.warp_player_at(&player_id, route.dest_station.to_owned(), Some("sp"));
                }
            }
        }
    }
}
