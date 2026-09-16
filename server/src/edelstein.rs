//! 埃德爾斯坦城与耶雷弗簇的城内脚本门 P 级路由。
//!
//! 源事实（TMS273.7 WZ + `Map/Map/Graph.json` 全量核对，2026-09-16）：
//!
//! **埃德爾斯坦城 `310000000`** 的出向门共 **11 扇**，在本模块落地前它们
//! **全部指向本仓库未装配的图**（两扇 pt:2 静态门、一扇 pt:10 接触门只是走不
//! 出去，七扇 pt:7/8/11 脚本门的源 `tm` 一律 `999999999` ⇒ 目录里没有目标 ⇒
//! 玩家按 ↑ 发不出请求）。目标写在 `Graph.json` 的授权表里，逐条抄录如下
//! （`Graph.json` 的 `31/310000000/portal`，`portalNum` 是「门户下标」）：
//!
//! | 门 | pt | 源脚本 | `portalNum` | 授权目标 | 本仓库处置 |
//! | --- | --- | --- | --- | --- | --- |
//! | `west00` | 2 | — | 14 | `310020000 埃德爾斯坦公園1` | 静态门，图已装配 |
//! | `east00` | 2 | — | 15 | `310030000 散步路道1` | 静态门，图已装配 |
//! | `market00` | 7 | `market19` | 16 | `910000000 自由市場入口` | 未装配 ⇒ 客户端说明 |
//! | `in01` | 7 | `enterMansion` | 17 | `310000004 住宅` | **本模块路由** |
//! | `in02` | 7 | `enterSecJobResi` | 18 | `931000600 臨時機場` / `310000010 埃德爾斯坦臨時機場` | **本模块路由到后者**，前者如实拒绝 |
//! | `in03` | 7 | `enterDangerHair` | 19 | `310000003 埃德爾斯坦美髮店` | **本模块路由** |
//! | `in00` | 7 | `in_310000001` | 20 | `310000001 埃德爾斯坦議會` | **本模块路由** |
//! | `in05` | 8 | `enterResi_23120` | 21 | `999999999`（未授权） | 保持关闭 |
//! | `profession` | 8 | `profession09` | 22 | `910001000 專業技術村<梅斯特鎮>` | 未装配 ⇒ 客户端说明 |
//! | `pt_regionMove` | 8 | `pt_regionMove` | 23 | `999999999`（未授权） | 保持关闭 |
//! | `inXenonHouse` | 11 | `check_23637` | 24 | `931060000 空蕩蕩的房子` | 未装配 ⇒ 客户端说明 |
//! | `resi00` | 10 | — | 29 | `310010000 秘密廣場` | 接触门，图已装配 |
//!
//! 只有 `in00`/`in01`/`in02`/`in03` 四扇需要路由：它们的目标图随本片的
//! `ADDITIONAL_EDELSTEIN_MAP_IDS` 装配，且目标图的静态回门正对本门
//! （`310000001/out00 → 310000000.in00`、`310000004/out00 → .in01`、
//! `310000003/out00 → .in03`、`310000010/out00 → .in02`，源内配对），
//! 所以落点直接取对图的 `out00`，两端互为原样保留的源门。
//!
//! **`in02` 是双授权目标**：`Graph.json` 同时给出 `931000600`（埃德爾斯坦
//! 内另一张「臨時機場」，本仓库没有）与 `310000010`（`埃德爾斯坦臨時機場`，
//! 三期二期已随飞行船线装配）。这与 `ship.rs::station_in_exit` 的
//! 「授权表列多个目标、只装配了一部分」是同一种情形，处理口径也相同：
//! 命中已装配的那个，其余**如实拒绝**（不旁路到任何未授权的中间图）。
//!
//! 未装配/未授权的门**不接**、也**不暴露给客户端目录**（`shared/maps.json` 的
//! `targetMapId` 保持 `null`）：`in05`/`pt_regionMove` 在源里连授权目标都是
//! `999999999` 哨兵值，`market00`/`profession`/`inXenonHouse` 的目标是自由市場
//! /匠人街/Xenon 住宅这类**全局系统占位图**，本仓库没有对应玩法。前者的行为与
//! `ufo.rs` 里 `221030550.col00`（授权 `999999999`）完全一致：保持关闭。
//!
//! **耶雷弗簇**（同一片核定，结论是「无需新增路由」）：`130000000 耶雷弗` 本身
//! **没有脚本门**——它的两扇门（`west00 → 130000101 騎士之殿`、
//! `east00 → 130030006 小橋樑`）是源静态门且两张目标图都已装配，本期未改。
//! 簇内其余三扇脚本门的目标同样不在本仓库：
//! - `130030006.east00`（pt:7 `pt_01_130030006`）→ 授权 `130030005 離開遺忘的森林的路`；
//! - `130000200.in01`（pt:11 `cygnus_q20754`）→ 授权 `913060000`（隐藏图，无名字）；
//! - `130000200.pt_regionMove`（pt:8）→ 授权 `999999999`（未授权）。
//! 前两扇是「有授权、目标未装配」，第三扇是「源自己没给目标」⇒ 都不接。
//! `130000200.west00 → 130010000` 是源静态门，按既有规则由客户端说明未收录。
//!
//! 与 `ellinel.rs`/`helios.rs`/`ufo.rs` 同一口径：只做源已授权的位移，不加
//! 等级、任务或时刻校验，也不替原版补演出。

use super::*;

/// 城内四扇脚本门 → (目标图, 落点门)。每一条的目标都来自 `Graph.json` 的授权
/// 表，落点门都取目标图的源静态回门（正对本门，源内配对）。`in02` 用它的
/// 第二个授权目标（见模块头）。
pub(crate) const EDELSTEIN_CITY_GATES: &[(&str, &str, &str, &str)] = &[
    ("310000000", "in00", "310000001", "out00"),
    ("310000000", "in01", "310000004", "out00"),
    ("310000000", "in02", "310000010", "out00"),
    ("310000000", "in03", "310000003", "out00"),
];

/// 一条已核定的城内门路线（目标图与落点门）。返回 `None` 表示这门不由本模块
/// 处置，交回 `portals.rs` 的通用查表（那里对没有 `targetMapId` 的门回
/// `portal_unavailable`，即「此门不可用」）。
pub(crate) fn city_gate_target(
    source_map: &str,
    portal_name: &str,
) -> Option<(&'static str, &'static str)> {
    EDELSTEIN_CITY_GATES
        .iter()
        .find(|(from, name, _, _)| *from == source_map && *name == portal_name)
        .map(|(_, _, target, landing)| (*target, *landing))
}

impl World {
    /// 埃德爾斯坦城内脚本门钩子（`portals.rs::handle_portal` 在查表前调用）。
    /// 返回 `true` 表示本请求已处置（已回复或已传送），调用方直接返回。
    ///
    /// 目标图未装配时按 `map_unavailable` 拒回（`warp_player_at` 取不到图会
    /// 返回 `false`），不会静默吞掉——与 `ufo_warp`/`helios_warp` 同形。
    pub(crate) fn edelstein_portal_gate(
        &mut self,
        id: &str,
        request_id: &str,
        source_map: &str,
        portal_name: &str,
    ) -> bool {
        let Some((target_map, landing_portal)) = city_gate_target(source_map, portal_name) else {
            return false;
        };
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
