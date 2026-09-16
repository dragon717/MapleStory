//! 危險地帶／洛斯威爾草原／UFO 街（地球防衛總部街西段）的脚本门 P 级路由。
//!
//! 源事实（TMS273.7 WZ + `Map/Map/Graph.json` 全量核对，2026-09-15）：
//! 本部 `221000000.west00` 出去是純静态门的草原链
//! `221030000 危險地帶 ⇄ 100/200/300/400 洛斯威爾草原Ⅰ~Ⅳ`；草原Ⅳ
//! `221030400` 的 NPC `2052026 UFO呼叫器` 是原版唯一的进场方式，进去是
//! `221030500~221030730` 的 UFO 走廊/通風口链（同样以静态门为主）。
//!
//! `Graph.json` 按「门户下标」给出授权目标（`portalNum`），逐条核过后，
//! 本街区**只有四道门**需要 P 级路由，其余全是源静态门：
//!
//! 1. `221030400` 的 NPC `2052026`（`portalNum: 9999`、`scriptPortal: 2052026`、
//!    `targetMap: 221030520`）—— `9999` 是「不是门」的哨兵值，说明原版由
//!    NPC 脚本体传送。该图 `pt00`（pt:1，`tm: 999999999`）**没有**被授权，
//!    NPC 站位 x=-1938 与它重合，但进场必须走对话。
//! 2. `221030540.pt00`（pt:7，脚本 `pt_221030540`，portalNum 2）→ `221030550`
//!    `走廊105`。回程是源静态门 `221030550.west00 → 221030540.pt00`，
//!    所以这一对是源内配对，落点取 `west00`。
//! 3. `221030550.pt00`（pt:7，脚本 `pt_221030550`，portalNum 4）→ `221030551`
//!    `走廊105`（同一张图的另一段，portal 坐标与 550 逐字相同，落点用同名门 `pt00`）。
//!    同一份 Graph 里 `221030551.pt00` 的授权目标是 `221030551` **自身**，
//!    即原地无条件移动 ⇒ 不构成一扇可落地的门，本模块不接（保持未开放）。
//! 4. `221030600.up00`（pt:7，脚本 `pt_221030600`，portalNum 4）→ `221030700`
//!    `通風口 D-1`。回程同样是源静态门 `221030700.west00 → 221030600.up00`，
//!    落点取 `west00`。
//!
//! 边界：
//! - 原版 `221030550.col00`（pt:9，`col_221030550`）在 Graph 里的授权目标是
//!   `999999999`（未授权）⇒ 不接，走近仍是「此路线尚未开放」。
//! - 操縱杆翼 `221030800/810/820/821/850` 与 `221030801~805/840`、
//!   `221030541/602/621/701/731/890` 在 Graph 里没有任何图指向它们
//!   （入口是原版腳本），不装配。
//! - `221030900 主控室` / `221030910 通風口 D-77` 是 `BossCaoong` 首領房
//!   （`info.lvLimit` 180、`fieldScript BossCaoong`），本仓库没有该首領，不装配。
//! - 与 `ellinel.rs` / `helios.rs` 同一口径：只做源已授权的位移，不加等级、
//!   任务或时刻校验，也不替原版补演出。

use super::*;

/// `Graph.json` 把进场写在 `221030400` 的 NPC 脚本上，本仓库只认这个模板。
const UFO_PAGER_TEMPLATE: &str = "2052026";
/// 呼叫器所在的草原Ⅳ；同一模板在别处不构成门。
const UFO_PAGER_MAP: &str = "221030400";
/// 源授权的进场目标图（`221030520 走廊102`）。
const UFO_ENTRY_MAP: &str = "221030520";
/// 进场落点：`221030520.pt00` 是 `221030400.pt00` 的源静态配对门（UFO 舱门），
/// 且贴地；该图 `sp` 离地 34px，超出既有 24px 贴地窗。
const UFO_ENTRY_LANDING: &str = "pt00";

/// 呼叫器 NPC 是否就是源里那一个（模板 + 所在图都要对上）。
pub(crate) fn is_ufo_pager(template_id: &str, map_id: &str) -> bool {
    template_id == UFO_PAGER_TEMPLATE && map_id == UFO_PAGER_MAP
}

impl World {
    /// UFO 街脚本门钩子（`portals.rs::handle_portal` 在查表前调用）。
    /// 返回 `true` 表示本请求已处置（已回复或已传送），调用方直接返回。
    pub(crate) fn ufo_portal_gate(
        &mut self,
        id: &str,
        request_id: &str,
        source_map: &str,
        portal_name: &str,
    ) -> bool {
        let (target_map, landing_portal) = match (source_map, portal_name) {
            ("221030540", "pt00") => ("221030550", "west00"),
            ("221030550", "pt00") => ("221030551", "pt00"),
            ("221030600", "up00") => ("221030700", "west00"),
            _ => return false,
        };
        self.ufo_warp(id, request_id, source_map, target_map, landing_portal)
    }

    /// UFO 呼叫器对话（`dialogue.rs` 分发）。
    ///
    /// 与仓库管理员同一口径：这个 NPC 在本地数据里没有对话脚本体，原版的
    /// 「交谈」本身就是进场动作，所以不编对话树，说完就按源授权目标传送。
    /// 失败（目标图未装配）按 `portal_unavailable` 拒回，不静默吞掉。
    pub(crate) fn handle_ufo_pager(
        &mut self,
        id: &str,
        request_id: &str,
        npc_id: &str,
        name: &str,
        name_zh: Option<&str>,
        lang: &str,
        can_advance: bool,
    ) {
        self.end_conversation(id);
        if !can_advance {
            let (code, message) = if lang == crate::quest_text::LANG_EN {
                ("dead", "A dead character cannot use the UFO pager.")
            } else {
                ("dead", "死亡角色不能使用UFO呼叫器。")
            };
            self.send_reject(id, code, message, Some(request_id));
            return;
        }
        if !self.warp_player_at(id, UFO_ENTRY_MAP.to_owned(), Some(UFO_ENTRY_LANDING)) {
            let (code, message) = if lang == crate::quest_text::LANG_EN {
                ("portal_unavailable", "The UFO entrance is not available.")
            } else {
                ("portal_unavailable", "UFO 入口暂时无法进入。")
            };
            self.send_reject(id, code, message, Some(request_id));
            return;
        }
        let value = npc::DialogueView::End.to_json(request_id, npc_id, name, name_zh);
        self.send_npc_dialogue(id, value);
    }

    fn ufo_warp(
        &mut self,
        id: &str,
        request_id: &str,
        source_map: &str,
        target_map: &str,
        landing_portal: &str,
    ) -> bool {
        let moved = self.warp_player_at(id, target_map.to_owned(), Some(landing_portal));
        let (success, code) = if moved {
            (true, "")
        } else {
            (false, "map_unavailable")
        };
        self.send_portal_result(id, request_id, success, code, source_map, Some(target_map));
        true
    }
}
