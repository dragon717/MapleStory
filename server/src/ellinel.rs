//! 艾靈森林章节（冒險家重製第二章「艾靈森林編年史」，36341-36367）的脚本门
//! P 级路由。
//!
//! 源事实（TMS273.7 WZ，2026-09-14 实测）：章节的时空穿越与两间首領房在原版
//! 都由任务/地图脚本传送（门只写脚本名或无目标），本地没有脚本体。这些门的
//! 两端在源里是显式配对的，因此按 `ship.rs` 的既有模式做 P 级路由：
//!
//! - 時間監控室 `222020400` 的 `in01`（pt:7）：过去侧小森林 `300000100` 的
//!   `out00` 是一条真实门，`tn` 明确写回 `222020400/in01` —— 这是源指定
//!   的穿越点配对，P 路由只补上缺失的前向方向，落到小森林的 `in00` 门位。
//! - 岩石山洞穴 `300010410` 的 `next00`（脚本 `in_chowBoss`）⇄ 洞穴深處
//!   `300010420` 的 `out00`（脚本 `out_elinCave`）：脚本名直接点名进/出碴烏
//!   洞穴，互为目标。
//! - 洞穴深處 `300010420` 与 洞窟的深處 `300020000` 的 `west00`（脚本
//!   `in_300010300`）：脚本名即目标图，回 洞窟的另一邊 `300010300`。
//! - 光明妖精森林 `300030300` 的 `in00`（脚本 `in_fairyBoss`）⇄ 女王的藏身處
//!   `300030310` 的 `out00`（脚本 `out_fairyBoss`）：同上，互为目标。
//!
//! 边界：原版在时间门前由 `q36342s` 等任务脚本把关；本路由不做任务状态校验
//! （与 `inERShip` 等既有 P 级路由同一口径）。营地的 `tp`×6、赫麗娜家
//! `cellar`/`enterWarehouse`、圖書館 `enterHRpt`/`downtown2015`、封印的森林
//! `elin_elluel` 等脚本门属未复刻场景（对应任务仍登记 `script-scene`），
//! 保持「走近提示一次」旧行为，不在本模块处置。

use super::*;

impl World {
    /// 艾靈森林章节脚本门钩子（`portals.rs::handle_portal` 在查表前调用）。
    /// 返回 `true` 表示本请求已处置（已回复或已传送），调用方直接返回。
    pub(crate) fn ellinel_portal_gate(
        &mut self,
        id: &str,
        request_id: &str,
        source_map: &str,
        portal_name: &str,
    ) -> bool {
        // 時間監控室 → 小森林（过去侧入口；源回程门 300000100.out00 →
        // 222020400/in01 与本路由互为镜像）。
        if source_map == "222020400" && portal_name == "in01" {
            return self.ellinel_warp(id, request_id, source_map, "300000100", "in00");
        }
        // 岩石山洞穴 ⇄ 洞穴深處（碴烏）。
        if source_map == "300010410" && portal_name == "next00" {
            return self.ellinel_warp(id, request_id, source_map, "300010420", "out00");
        }
        if source_map == "300010420" && portal_name == "out00" {
            return self.ellinel_warp(id, request_id, source_map, "300010410", "next00");
        }
        // 两个 `in_300010300` 脚本门都回 洞窟的另一邊。
        if (source_map == "300010420" || source_map == "300020000") && portal_name == "west00" {
            return self.ellinel_warp(id, request_id, source_map, "300010300", "east00");
        }
        // 光明妖精森林 ⇄ 女王的藏身處（艾畢奈亞）。
        if source_map == "300030300" && portal_name == "in00" {
            return self.ellinel_warp(id, request_id, source_map, "300030310", "out00");
        }
        if source_map == "300030310" && portal_name == "out00" {
            return self.ellinel_warp(id, request_id, source_map, "300030300", "in00");
        }
        false
    }

    fn ellinel_warp(
        &mut self,
        id: &str,
        request_id: &str,
        source_map: &str,
        target_map: &str,
        landing_portal: &str,
    ) -> bool {
        // 落点统一用目标图里的门位：章节图的原版 `sp` 多为演出位（离地
        // 38~122px，超出 24px 贴地窗），而门位都在可走地形上——与 ship 路由
        // 的 `come00`/`in00` 落点规则同一思路。
        let moved = self.warp_player_at(id, target_map.to_owned(), Some(landing_portal));
        let (success, code) = if moved { (true, "") } else { (false, "map_unavailable") };
        self.send_portal_result(id, request_id, success, code, source_map, Some(target_map));
        true
    }
}
