//! 飞行船航线系统（一期：維多利亞樹木站台 ⇄ 天空之城；二期 2026-09-14：
//! 耶雷弗线与埃德爾斯坦线）。
//!
//! 源事实（TMS273.7 WZ，2026-09-14 实测）：站台与候船室都没有静态登船门——
//! 登船由检票员 NPC 在检票窗口内执行，到站为系统强制传送。TMS273 不带
//! `station_in` 等脚本体，时刻与检票规则按既有授权走 P 级常量（联网多来源
//! 核对的经典乘船规则），集中在下面三个常量，后续有同版证据只改这里。
//!
//! 一期边界（与 `docs/plan/topics/飞行船航线系统实现方案.md` 对齐）：
//! - 检票 = 与站台上的检票员对话（`104020110` 的 `1032008`、`200000100` 的
//!   `2012000`）；候船室 `200000112`/船員 阿霖 `2012002` 已随目录装配但一期
//!   不承载机制。售票处 `east00` 的 `station_in` 脚本门一期保持关闭提示旧行为，
//!   三期起改由 `ship_portal_gate` 按源邻接 P 级路由进港口通道（见下）。
//! - 票务道具 ID 未核实，一期免费登船（P 级）。
//! - 航行中甲板刷蝙蝠魔属二期 Balrog 事件，不建模。
//!
//! 二期边界（2026-09-14）：
//! - 耶雷弗线：树顶 `104020120`（`1100007` 检票）⇄ 天空渡口 `130000210`
//!   （奇里盧 `1100003` 检票、奇盧 `1100004` 播报）。源只有一张耶雷弗船图
//!   `130090000`（无船舱、无静态开门），双向共用；大厅 `in01` 的 `inERShip`
//!   与渡口 `out00`（`pt_00_130000210`）脚本体缺失，按源邻接 P 级路由
//!   （`ship_portal_gate`）；渡口经前庭 `130000200` 连耶雷弗城 `130000000`。
//! - 埃德爾斯坦线：树顶 `104020130`（`2150010` 检票）⇄ 埃德爾斯坦码头
//!   `310000010`（`2150008` 检票），出 `out00` 进埃德爾斯坦城 `310000000`。
//!   甲板↔船舱经 `move_OrbEde`/`move_EdeOrb` 脚本门 P 级互切；埃德爾斯坦
//!   船的舱门（`out00..09`，源 tm 直指对端码头 `200000170`/`310000010`）
//!   仅检票相位放行，航行中保持关闭提示。`200000170` 天空之城码头随目录
//!   装配（west00 回 `200000100`），检票不在该侧。
//! - 蝙蝠魔事件、候船室机制、票务道具仍属后续。
//!
//! 三期（2026-09-15）：玩具城⇄天空之城线，把玩具城从「只能靠大地图跳转」
//! 变成有真实双向海上通道，并让天空之城第一次有城内可走。
//! - 玩具城侧登船在碼頭 `220000110`（剪票員 `2041000`），售票处
//!   `220000100` 的車掌 `2040000` 只报班次；两图由源静态 pt:2 门
//!   `east00`↔`west00` 相连，售票处 `out00` 回玩具城 `220000000.station00`。
//! - 天空之城侧登船在碼頭 `200000121`（剪票員 `2012013`），售票处
//!   `200000100.east00`（pt:7 `station_in`，脚本体缺失）走过去即上码头。
//!   **修正（2026-09-16）**：这一跳原先按「源邻接」旁路到港口通道
//!   `200000120`，但 `Graph.json` 的授权表给 `east00` 列的是**七个码头**
//!   （`200000111/121/131/141/151/161/170`），港口通道**不在其中**——它只是
//!   码头的另一条回程旁路（`200000120.east00 → 200000121.west00`），而
//!   `200000121.west00` 本就有静态门直接回售票处。现改为按授权表分流到已
//!   装配的码头（`200000121` 优先、`200000170` 次之），未装配的五个目标
//!   如实拒绝；推导与反向断言见 `station_in_exit`。
//! - 两张船图 `200090100 開往玩具城` / `200090110 開往天空之城` 在源里只有
//!   出生点，既无船舱也无舱门：登船即甲板，到站为服务端强制传送。因此
//!   `step_ship_recover` 补上方案 §3 约定的相位恢复——名单是进程内状态，
//!   服务重启即清空，而这两张船图没有任何门，不兜底就是玩家死端。

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
        ShipPhase::Sailing {
            left: SHIP_SAIL_SECONDS - minute,
        }
    } else {
        ShipPhase::Boarding {
            left: SHIP_SLOT_SECONDS - minute,
        }
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

/// 二期（2026-09-14）：耶雷弗线。维多利亚树顶 `104020120` 前往耶雷弗的站台
/// 由 `1100007` 检票；耶雷弗侧在天空渡口 `130000210` 由奇里盧 `1100003`
/// 检票、奇盧 `1100004` 播报。源里耶雷弗只有一张船图 `130090000`（无船舱，
/// `in00` 是任务脚本门不开放），双向共用：大厅 `in01` 的 `inERShip` 脚本门
/// P 级放行进站台（原脚本体缺失）。
pub(crate) static ROUTE_VICTORIA_EREV: ShipRoute = ShipRoute {
    id: "victoria-erev",
    board_map: "104020120",
    deck: "130090000",
    cabin: "",
    dest_station: "130000210",
    inspector: "1100007",
    announcers: &[],
};

pub(crate) static ROUTE_EREV_VICTORIA: ShipRoute = ShipRoute {
    id: "erev-victoria",
    board_map: "130000210",
    deck: "130090000",
    cabin: "",
    dest_station: "104020120",
    inspector: "1100003",
    announcers: &["1100004"],
};

/// 二期：埃德爾斯坦线。树顶 `104020130` 前往埃德爾斯坦站台由 `2150010`
/// 检票，到站埃德爾斯坦码头 `310000010`；返程由码头 `2150008` 检票。
/// 船图四张按源 returnMap 分侧：`200090600/601` 属维多利亚出发侧，
/// `200090610/611` 属埃德爾斯坦出发侧；甲板↔船舱经 `move_OrbEde` /
/// `move_EdeOrb` 脚本门（pt:9，P 级固定互切）。`200000170` 天空之城码头
/// 随目录装配（源 west00 回 `200000100`），检票不在该侧。
pub(crate) static ROUTE_VICTORIA_EDELSTEIN: ShipRoute = ShipRoute {
    id: "victoria-edelstein",
    board_map: "104020130",
    deck: "200090600",
    cabin: "200090601",
    dest_station: "310000010",
    inspector: "2150010",
    announcers: &[],
};

pub(crate) static ROUTE_EDELSTEIN_VICTORIA: ShipRoute = ShipRoute {
    id: "edelstein-victoria",
    board_map: "310000010",
    deck: "200090610",
    cabin: "200090611",
    dest_station: "104020130",
    inspector: "2150008",
    announcers: &[],
};

/// 三期（2026-09-15）：玩具城⇄天空之城线。两端的检票员都在**码头**上
/// （玩具城 `220000110` 的剪票員 `2041000`、天空之城 `200000121` 的剪票員
/// `2012013`），售票处只报班次；船图在源里没有船舱，`cabin` 为空串。
pub(crate) static ROUTE_TOYS_ORBIS: ShipRoute = ShipRoute {
    id: "toys-orbis",
    board_map: "220000110",
    deck: "200090110",
    cabin: "",
    dest_station: "200000121",
    inspector: "2041000",
    announcers: &["2040000"],
};

pub(crate) static ROUTE_ORBIS_TOYS: ShipRoute = ShipRoute {
    id: "orbis-toys",
    board_map: "200000121",
    deck: "200090100",
    cabin: "",
    dest_station: "220000110",
    inspector: "2012013",
    announcers: &[],
};

pub(crate) static SHIP_ROUTES: [&ShipRoute; 8] = [
    &ROUTE_VICTORIA_ORBIS,
    &ROUTE_ORBIS_VICTORIA,
    &ROUTE_VICTORIA_EREV,
    &ROUTE_EREV_VICTORIA,
    &ROUTE_VICTORIA_EDELSTEIN,
    &ROUTE_EDELSTEIN_VICTORIA,
    &ROUTE_TOYS_ORBIS,
    &ROUTE_ORBIS_TOYS,
];

/// 哪条航线与这张地图相关（快照 `ship` 字段只在船图/站台图携带）。
/// 共用船图 `130090000` 挂在去程航线上，快照归属按乘客名单二次判定
/// （`World::ship_snapshot_route_index`）。
pub(crate) fn route_index_for_map(map_id: &str) -> Option<usize> {
    match map_id {
        "104020110" | "200090010" | "200090011" => Some(0),
        "200000100" | "200000112" | "200090000" | "200090001" => Some(1),
        "104020120" | "130090000" => Some(2),
        "130000210" => Some(3),
        "104020130" | "200000170" | "200090600" | "200090601" => Some(4),
        "310000010" | "200090610" | "200090611" => Some(5),
        // 三期：售票处与港口通道也算站台侧——玩家在等船的这几张图上都能
        // 看到班次；船图只有甲板一张（源无船舱）。
        "220000100" | "220000110" | "200090110" => Some(6),
        "200000120" | "200000121" | "200090100" => Some(7),
        _ => None,
    }
}

/// 甲板↔船舱的 `move` 脚本门（pt:9）固定互切：源里甲板与船舱各有一组
/// `move00..03`（`move_OrbEde`/`move_EdeOrb`），脚本体缺失，按同船互切建模。
pub(crate) fn ship_move_door_target(source_map: &str) -> Option<&'static str> {
    match source_map {
        "200090600" => Some("200090601"),
        "200090601" => Some("200090600"),
        "200090610" => Some("200090611"),
        "200090611" => Some("200090610"),
        _ => None,
    }
}

/// 埃德爾斯坦船的舱门（`out00..out09`，pt:3）：源 tm 直接指向对端码头，
/// 返回目标码头（`200000170`/`310000010`）。原脚本只在靠港时开门——
/// 航行中保持关闭提示旧行为，检票相位由服务端接管传送。
/// 埃德爾斯坦船的舱门（`out00..out09`，pt:3）：返回本端检票站台。
/// 源 tm（`200000170`/`310000010`）反映原版船的物理停靠位；本实现登船在
/// 树顶站台/埃德爾斯坦码头，舱门在检票相位即「靠港下船」，落回登船端。
/// 原脚本只在靠港时开门——航行中保持关闭提示旧行为，检票相位由服务端
/// 接管传送。
pub(crate) fn ship_hatch_exit(source_map: &str) -> Option<&'static str> {
    match source_map {
        "200090600" | "200090601" => Some("104020130"),
        "200090610" | "200090611" => Some("310000010"),
        _ => None,
    }
}

/// 角色是否在任一航线的甲板/船舱上。在船期间大地图跳转与回家卷軸都被
/// 拒绝：登船/到站是服务端权威流程，不走玩家自选传送。
pub(crate) fn ship_is_on_board_map(map_id: &str) -> bool {
    SHIP_ROUTES
        .iter()
        .any(|route| route.deck == map_id || (!route.cabin.is_empty() && route.cabin == map_id))
}

/// 售票处 `200000100.east00`（pt:7 `station_in`，脚本体缺失）按 **`Graph.json`
/// 授权表**分流到的码头。返回 `None` 表示该目标尚未装配 ⇒ 保持「尚未开放」，
/// 让走近的玩家收到门提示而不是踩进空图或掉出地图边界。
///
/// `Graph.json`（`Map/Map/Graph.json` 的 `20/200000100/portal`）给这扇门授权了
/// **七个**目标：`200000111`/`200000121`/`200000131`/`200000141`/`200000151`/
/// `200000161`/`200000170`，`portalNum` 一律 `4`（＝授权落点是目标图的
/// `west00`；这七张码头的 `west00` 全部是静态门 `→ 200000100.east00`，
/// 原样保留即可）。本仓库只装配了其中两个：
/// - `200000121 碼頭<開往玩具城>` —— 三期登船码头（剪票員 `2012013`）；
/// - `200000170 碼頭<前往埃德爾斯坦>` —— 二期埃德爾斯坦线回程码头。
///
/// 取 `200000121` 优先：它是「有船可上」的那一张，也是玩家从城内最常去的
/// 方向；`200000170` 作为次选，使已交付的二期返程链路不被这扇门截断。
///
/// **刻意不接** `200000120 港口通道`：它虽是 `east00` 的源邻接（其 `west00`
/// 的 tm/tn 正是 `200000100.east00`），但它自己 `east00` 指向的 `200000121`
/// **本就有一扇 `west00` 静态门直接回售票处** ⇒ 那条通道是**冗余旁路**，
/// 接上反而会把登船相位门包过去。有反向断言钉住这条。
pub(crate) fn station_in_exit(target_map: &str) -> Option<&'static str> {
    match target_map {
        "200000121" => Some("west00"),
        "200000170" => Some("west00"),
        _ => None,
    }
}

/// 售票处这扇门在授权表里的**全部**目标（未装配的也在内）。运行时不用它，
/// 只供验收断言「未装配目标一律拒绝」与「授权表没被人凭印象改窄」——
/// 缺了 `cfg(test)` 会让非测试构建多一条 dead_code 告警（项目要求 0 告警）。
#[cfg(test)]
pub(crate) const STATION_IN_AUTHORIZED: &[&str] = &[
    "200000111",
    "200000121",
    "200000131",
    "200000141",
    "200000151",
    "200000161",
    "200000170",
];

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
                format!("飛行船正在航行中，約 {sail} 分鐘後到站；下一班約 {board} 分鐘後開始檢票。")
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
    pub(crate) fn ship_board(
        &mut self,
        player_id: &str,
        route_index: usize,
    ) -> Result<(), &'static str> {
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
                    .map(|player| {
                        player.map_id == route.deck
                            || (!route.cabin.is_empty() && player.map_id == route.cabin)
                    })
                    .unwrap_or(false);
                if aboard {
                    self.warp_player_at(&player_id, route.dest_station.to_owned(), Some("sp"));
                }
            }
        }
        self.step_ship_recover(now_unix);
    }

    /// 相位恢复（方案 §3「掉线重连落在船图则按当前相位恢复或到站释放」）。
    ///
    /// 乘客名单是进程内状态，服务重启即清空；而船图在源里都没有下船门
    /// （一期/二期的甲板只有舱门，三期两张船图连一扇门都没有），所以留在
    /// 船上却不在名单里的角色必须兜底，否则就是死端：
    ///
    /// - 航行相位 ⇒ 补登记进名单，随本班到站被送下船（「按当前相位恢复」）；
    /// - 靠港（检票）相位 ⇒ 直接放回本端登船站台的 `sp`（「到站释放」）。
    ///
    /// 只认甲板：船舱里要下船得先走脚本门到甲板，那条路仍在，不动它。
    fn step_ship_recover(&mut self, now_unix: i64) {
        if self.players.is_empty() {
            return;
        }
        let sailing = matches!(ship_phase_of(now_unix), ShipPhase::Sailing { .. });
        let mut adopt: Vec<(usize, String)> = Vec::new();
        let mut release: Vec<(String, &'static str)> = Vec::new();
        for (player_id, player) in self.players.iter() {
            let aboard = SHIP_ROUTES.iter().position(|route| {
                route.deck == player.map_id
                    || (!route.cabin.is_empty() && route.cabin == player.map_id)
            });
            let Some(index) = aboard else { continue };
            if self.ship_passengers[index].iter().any(|id| id == player_id) {
                continue;
            }
            if sailing {
                adopt.push((index, player_id.clone()));
            } else if player.map_id == SHIP_ROUTES[index].deck {
                release.push((player_id.clone(), SHIP_ROUTES[index].board_map));
            }
        }
        for (index, player_id) in adopt {
            self.ship_passengers[index].push(player_id);
        }
        for (player_id, target) in release {
            self.warp_player_at(&player_id, target.to_owned(), Some("sp"));
        }
    }

    /// 快照 `ship` 字段的航线索引：`130090000` 由耶雷弗双向航线共用，按
    /// 乘客名单归属；未登记的旁观者看去程航线。其余地图与
    /// `route_index_for_map` 一致。
    pub(crate) fn ship_snapshot_route_index(&self, map_id: &str, player_id: &str) -> Option<usize> {
        let index = route_index_for_map(map_id)?;
        if map_id != "130090000" {
            return Some(index);
        }
        if self.ship_passengers[3].iter().any(|id| id == player_id) {
            return Some(3);
        }
        Some(2)
    }

    /// 二期脚本门钩子（`portals.rs::handle_portal` 在查表前调用）。返回
    /// `true` 表示本请求已处置（已回复或已传送），调用方直接返回。
    pub(crate) fn ship_portal_gate(
        &mut self,
        id: &str,
        request_id: &str,
        source_map: &str,
        portal_name: &str,
    ) -> bool {
        self.ship_portal_gate_at(
            id,
            request_id,
            source_map,
            portal_name,
            unix_now_ms() / 1000,
        )
    }

    /// 脚本门钩子（验收入口）：时间可注入，断言才有决定性。
    pub(crate) fn ship_portal_gate_at(
        &mut self,
        id: &str,
        request_id: &str,
        source_map: &str,
        portal_name: &str,
        now_unix: i64,
    ) -> bool {
        // 大厅 `in01` 的 `inERShip` 脚本门（pt:7）：原脚本体缺失，P 级放行
        // 进耶雷弗站台（源门数据只指向脚本，无静态目标）。
        if source_map == "104020100" && portal_name == "in01" {
            let moved = self.warp_player_at(id, "104020120".to_owned(), Some("come00"));
            let (success, code) = if moved {
                (true, "")
            } else {
                (false, "map_unavailable")
            };
            self.send_portal_result(id, request_id, success, code, source_map, None);
            return true;
        }
        // 天空渡口 `out00`（pt:7 脚本门 `pt_00_130000210`）：原脚本缺失，
        // P 级按源邻接关系路由回耶雷弗前庭 `130000200`（其 `in00` 正对本渡口）。
        if source_map == "130000210" && portal_name == "out00" {
            let moved = self.warp_player_at(id, "130000200".to_owned(), Some("in00"));
            let (success, code) = if moved {
                (true, "")
            } else {
                (false, "map_unavailable")
            };
            self.send_portal_result(id, request_id, success, code, source_map, None);
            return true;
        }
        // 三期：天空之城售票处 `east00`（pt:7 `station_in`，脚本体缺失）是
        // 上船通道口。授权表（`Graph.json` 的 `20/200000100/portal`）给它列了
        // **七个**码头，本仓库只装配了两个 ⇒ 命中就按源授权落点传送，未装配
        // 的目标**如实拒绝**（走近收门提示），不再一律旁路到港口通道——那会让
        // 玩家穿进一张没有船票务/相位语义的中间图，还把登船相位门包过去。
        // 目标与落点的完整推导见 `station_in_exit` 的文档注释。
        if source_map == "200000100" && portal_name == "east00" {
            let target_map = "200000121";
            let landing = station_in_exit(target_map);
            let moved = landing.is_some_and(|landing| {
                self.warp_player_at(id, target_map.to_owned(), Some(landing))
            });
            let (success, code) = if moved {
                (true, "")
            } else {
                (false, "portal_unavailable")
            };
            self.send_portal_result(
                id,
                request_id,
                success,
                code,
                source_map,
                success.then_some(target_map),
            );
            return true;
        }
        // 耶雷弗船的舷侧门（west00/east00，pt:2）：源里只在停靠时开门；
        // 本实现到站/检票均为服务端 warp，门保持关闭提示旧行为。
        if source_map == "130090000" && (portal_name == "west00" || portal_name == "east00") {
            self.send_portal_result(
                id,
                request_id,
                false,
                "portal_unavailable",
                source_map,
                None,
            );
            return true;
        }
        // 甲板↔船舱 move 脚本门（pt:9）：固定互切，落点用对图的 `sp`。
        if let Some(target) = ship_move_door_target(source_map) {
            if portal_name.starts_with("move") {
                let moved = self.warp_player_at(id, target.to_owned(), Some("sp"));
                let (success, code) = if moved {
                    (true, "")
                } else {
                    (false, "map_unavailable")
                };
                self.send_portal_result(id, request_id, success, code, source_map, None);
                return true;
            }
        }
        // 舱门（pt:3 `out00..09`）：航行中不开门；检票相位由服务端接管，
        // 落回本端检票站台 `sp`（源 tm 200000170/310000010 反映原版船物理
        // 停靠位；本实现登船在树顶站台/埃德爾斯坦码头，舱门即「靠港下船」，
        // 落地交给 `warp_player_at` 的 ground_below 解析）。
        if portal_name.starts_with("out") {
            if let Some(target) = ship_hatch_exit(source_map) {
                if matches!(ship_phase_of(now_unix), ShipPhase::Sailing { .. }) {
                    self.send_portal_result(
                        id,
                        request_id,
                        false,
                        "portal_unavailable",
                        source_map,
                        None,
                    );
                    return true;
                }
                let moved = self.warp_player_at(id, target.to_owned(), Some("sp"));
                let (success, code) = if moved {
                    (true, "")
                } else {
                    (false, "map_unavailable")
                };
                self.send_portal_result(id, request_id, success, code, source_map, Some(target));
                return true;
            }
        }
        false
    }
}
