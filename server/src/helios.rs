//! 赫爾奧斯塔電梯（LudiElevator）脚本门 P 级路由。
//!
//! 源事实（TMS273.7 WZ，2026-09-15 实测）：赫爾奧斯塔塔身用一部电梯连接
//! 99樓 `222020200` 与 2樓 `222020100`。两层各有一扇 `in00`（pt:7，脚本
//! `LudiElevator_in`）电梯门；原版把玩家送进轿厢图（`222020110`/`222020210`，
//! `tm: 999999999` 无静态目标），由脚本在轿厢与楼层之间传送。轿厢的出门
//! `under00..04`（pt:3）在源里位于可视区外（y≈725 > VRBottom 300），玩家
//! 无法步行抵达——轿厢图不装配，本模块按 `ellinel.rs`/`ship.rs` 的既有
//! 模式把电梯门直达对方楼层：
//!
//! - 99樓 `222020200.in00` → 2樓 `222020100.st00`：落点取自源轿厢
//!   `222020110.under00..04` 的 `tn` 指定（2樓电梯到站门）。
//! - 2樓 `222020100.in00` → 99樓 `222020200.st01`：落点取自源轿厢
//!   `222020210.under00..04` 的 `tn` 指定（99樓电梯到站门）。
//!
//! 边界：原版电梯按班次时间运行（等候 + 航行演出）；本路由不做时刻校验，
//! 即到即走（与时间门 `q36342s`、`inERShip` 等既有 P 级路由同一口径）。
//! 2樓以下原版通向的童話村 `222000000` 在 TMS273 WZ 中不存在，无源可装。

use super::*;

impl World {
    /// 赫爾奧斯塔电梯门钩子（`portals.rs::handle_portal` 在查表前调用）。
    /// 返回 `true` 表示本请求已处置（已回复或已传送），调用方直接返回。
    pub(crate) fn helios_portal_gate(
        &mut self,
        id: &str,
        request_id: &str,
        source_map: &str,
        portal_name: &str,
    ) -> bool {
        // 99樓 ⇄ 2樓：落点用源轿厢出门 `tn` 指定的到站门（都贴地，见
        // `helios_acceptance.rs` 的真实目录断言）。
        if source_map == "222020200" && portal_name == "in00" {
            return self.helios_warp(id, request_id, source_map, "222020100", "st00");
        }
        if source_map == "222020100" && portal_name == "in00" {
            return self.helios_warp(id, request_id, source_map, "222020200", "st01");
        }
        false
    }

    fn helios_warp(
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
