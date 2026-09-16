//! 传送命令与地图跳转。
//!
//! 负责：传送门口令的处理（`handle_portal`，门存在性/可达坐标校验）、回执下发
//! （`send_portal_result`）、世界地图跳转（`handle_world_map_move`）与程序性跳转入口
//! （`warp_player` / `warp_player_at`，供脚本传送与复活落点复用）。
//! 不负责：门的摆放数据（`Map` 的 portal 定义）、切图后的快照广播节奏（`world.rs` 的 switchMap 流程）。

use super::*;

impl World {
    pub(super) fn handle_portal(&mut self, id: String, request_id: String, portal_name: String) {
        let Some(player) = self.players.get(&id) else {
            return;
        };
        let source_map_id = player.map_id.clone();
        let source_x = player.state.x;
        let source_y = player.state.y;
        // 飞行船脚本门（`ship.rs`）：`inERShip`/`move_OrbEde` 等源脚本体缺失
        // 的门与舱门相位闸，由 ship 模块按 P 级规则处置；已处置即返回。
        if self.ship_portal_gate(&id, &request_id, &source_map_id, &portal_name) {
            return;
        }
        // 艾靈森林章节脚本门（`ellinel.rs`）：时间门与两间首領房的 P 级路由；
        // 已处置即返回。
        if self.ellinel_portal_gate(&id, &request_id, &source_map_id, &portal_name) {
            return;
        }
        // 赫爾奧斯塔电梯门（`helios.rs`）：99樓 ⇄ 2樓的 P 级路由；已处置即返回。
        if self.helios_portal_gate(&id, &request_id, &source_map_id, &portal_name) {
            return;
        }
        // 危險地帶/UFO 街脚本门（`ufo.rs`）：走廊 104/105 与 走道 201 通往
        // 通風口的三扇 pt:7 门；已处置即返回。
        if self.ufo_portal_gate(&id, &request_id, &source_map_id, &portal_name) {
            return;
        }
        // 埃德爾斯坦城/耶雷弗簇城内脚本门（`edelstein.rs`）：埃德爾斯坦城
        // `310000000` 的四扇 pt:7 门（議會/住宅/臨時機場/美髮店）；已处置即返回。
        if self.edelstein_portal_gate(&id, &request_id, &source_map_id, &portal_name) {
            return;
        }
        let source_map = self.map_for(&source_map_id).clone();
        let Some(portal) = source_map
            .portals
            .iter()
            .find(|portal| portal.name == portal_name && portal.target_map_id.is_some())
            .cloned()
        else {
            self.send_portal_result(
                &id,
                &request_id,
                false,
                "portal_unavailable",
                &source_map_id,
                None,
            );
            return;
        };
        if (source_x - portal.x).abs() > 48.0 || (source_y - portal.y).abs() > 64.0 {
            self.send_portal_result(
                &id,
                &request_id,
                false,
                "out_of_range",
                &source_map_id,
                None,
            );
            return;
        }
        let Some(target_map_id) = portal.target_map_id.clone() else {
            self.send_portal_result(
                &id,
                &request_id,
                false,
                "portal_unavailable",
                &source_map_id,
                None,
            );
            return;
        };
        let Some(target_map) = self.maps.get(&target_map_id).cloned() else {
            self.send_portal_result(
                &id,
                &request_id,
                false,
                "map_unavailable",
                &source_map_id,
                None,
            );
            return;
        };
        let destination = portal
            .target_portal_name
            .as_deref()
            .and_then(|name| {
                target_map
                    .portals
                    .iter()
                    .find(|candidate| candidate.name == name)
            })
            .map(|portal| (portal.x, portal.y))
            .unwrap_or((target_map.spawn.x, target_map.spawn.y));
        let grounded = target_map
            .ground_near(destination.0, destination.1)
            .filter(|(_, ground)| (ground - destination.1).abs() <= 24.0);
        let (target_x, target_y, foothold_id, grounded) = grounded.map_or(
            (destination.0, destination.1, 0, false),
            |(foothold_id, ground)| (destination.0, ground, foothold_id, true),
        );
        self.end_conversation(&id);
        let Some(player) = self.players.get_mut(&id) else {
            return;
        };
        player.map_id = target_map_id.clone();
        player.natural_recovery_next_tick =
            self.tick.saturating_add(NATURAL_RECOVERY_INTERVAL_TICKS);
        player.state.x = target_x;
        player.state.y = target_y;
        player.state.vx = 0.0;
        player.state.vy = 0.0;
        player.state.facing = 1;
        player.state.grounded = grounded;
        player.state.climbing = false;
        player.state.ladder_id = None;
        player.state.action_id = None;
        player.state.action = if grounded { "stand" } else { "jump" };
        player.state.action_started_tick = self.tick;
        player.swimming = false;
        player.direction = 0;
        player.vertical = 0;
        player.jump = false;
        player.foothold_id = foothold_id;
        player.last_foothold_id = foothold_id;
        player.fall_boundary_hold = false;
        player.drop_fh = 0;
        player.attack_until = 0;
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
        refresh_player_derived(&self.gameplay, &self.mage_skills, player);
        self.send_portal_result(
            &id,
            &request_id,
            true,
            "",
            &source_map_id,
            Some(&target_map_id),
        );
    }

    /// World map (大地图) jump.  The client only names the clicked spot's map
    /// id; everything that matters is re-derived here: the map must be an
    /// assembled catalog map, and the body lands on that map's authored `sp`
    /// spawn — the same landing rule a portal arrival uses.  A jump to the
    /// character's own map is a successful no-op so clicking the spot you
    /// stand on never teleports you across the map.
    pub(super) fn handle_world_map_move(&mut self, id: String, request_id: String, map_id: String) {
        let Some(player) = self.players.get(&id) else {
            return;
        };
        let source_map_id = player.map_id.clone();
        if map_id == source_map_id {
            self.send_world_map_move_result(&id, &request_id, true, "", &map_id);
            return;
        }
        // 飞行船航行中不从大地图跳走：登船/到站是服务端权威流程，甲板与
        // 船舱期间的一切自选传送（大地图、卷軸）都拒绝。
        if ship::ship_is_on_board_map(&source_map_id) {
            self.send_world_map_move_result(
                &id,
                &request_id,
                false,
                "map_unavailable",
                &source_map_id,
            );
            return;
        }
        if self.maps.get(&map_id).is_none() {
            self.send_world_map_move_result(
                &id,
                &request_id,
                false,
                "map_unavailable",
                &source_map_id,
            );
            return;
        }
        // `warp_player_at` resolves the named portal's coordinates, or the
        // authored spawn when the map has no `sp` slot, then re-grounds the
        // body and persists the profile — exactly the scroll/script arrival.
        let moved = self.warp_player_at(&id, map_id.clone(), Some("sp"));
        if moved {
            self.send_world_map_move_result(&id, &request_id, true, "", &map_id);
        } else {
            self.send_world_map_move_result(
                &id,
                &request_id,
                false,
                "map_unavailable",
                &source_map_id,
            );
        }
    }

    pub(super) fn send_world_map_move_result(
        &self,
        id: &str,
        request_id: &str,
        success: bool,
        code: &str,
        map_id: &str,
    ) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let message = serde_json::json!({
            "type": "worldMapMoveResult",
            "requestId": request_id,
            "success": success,
            "code": code,
            "mapId": map_id,
        });
        let _ = player.output.try_send(message.to_string());
    }

    pub(super) fn send_portal_result(
        &self,
        id: &str,
        request_id: &str,
        success: bool,
        code: &str,
        source_map_id: &str,
        target_map_id: Option<&str>,
    ) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let mut message = serde_json::json!({
            "type": "portalResult",
            "requestId": request_id,
            "success": success,
            "code": code,
            "sourceMapId": source_map_id,
        });
        if let Some(target_map_id) = target_map_id {
            message["targetMapId"] = target_map_id.into();
        }
        let _ = player.output.try_send(message.to_string());
    }

    pub(super) fn warp_player(&mut self, player_id: &str, map_id: String) -> bool {
        self.warp_player_at(player_id, map_id, None)
    }

    pub(super) fn warp_player_at(
        &mut self,
        player_id: &str,
        map_id: String,
        portal_name: Option<&str>,
    ) -> bool {
        let Some(map) = self.maps.get(&map_id).cloned() else {
            return false;
        };
        let spawn = (map.spawn.x, map.spawn.y);
        let preferred = map
            .portals
            .iter()
            .find(|portal| portal_name.is_some_and(|name| portal.name == name))
            .or_else(|| map.portals.first())
            .map(|portal| (portal.x, portal.y))
            .unwrap_or(spawn);
        let resolve_spawn = |(x, y): (f64, f64)| {
            if !x.is_finite()
                || !y.is_finite()
                || !(map.bounds.x_min..=map.bounds.x_max).contains(&x)
                || !(map.bounds.y_min..=map.bounds.y_max).contains(&y)
            {
                return None;
            }
            let (foothold_id, ground) = map.ground_below(x, y)?;
            if (ground - y).abs() <= 24.0 {
                Some((x, ground, foothold_id, true))
            } else {
                Some((x, y, 0, false))
            }
        };
        let Some((x, y, foothold_id, grounded)) =
            resolve_spawn(preferred).or_else(|| resolve_spawn(spawn))
        else {
            return false;
        };
        let Some(mut candidate) = self.players.get(player_id).cloned() else {
            return false;
        };
        candidate.map_id = map_id.clone();
        candidate.natural_recovery_next_tick =
            self.tick.saturating_add(NATURAL_RECOVERY_INTERVAL_TICKS);
        candidate.state.x = x;
        candidate.state.y = y;
        candidate.state.vx = 0.0;
        candidate.state.vy = 0.0;
        candidate.state.facing = 1;
        candidate.state.grounded = grounded;
        candidate.state.climbing = false;
        candidate.state.ladder_id = None;
        candidate.state.action = if grounded { "stand" } else { "jump" };
        candidate.state.action_id = None;
        candidate.state.action_started_tick = self.tick;
        candidate.direction = 0;
        candidate.vertical = 0;
        candidate.jump = false;
        candidate.foothold_id = foothold_id;
        candidate.last_foothold_id = foothold_id;
        candidate.drop_fh = 0;
        candidate.fall_boundary_hold = false;
        candidate.attack_until = 0;
        candidate.contact_invulnerable_until = 0;
        candidate.knockback_vx = 0.0;
        candidate.knockback_until = 0;
        candidate.meditation_until = 0;
        candidate.meditation_mad = 0;
        clear_beginner_buffs(&mut candidate);
        candidate.ice_teleport_enabled = false;
        candidate.ice_fields.clear();
        candidate.teleport_mastery_enabled = false;
        candidate.teleport_boost_enabled = false;
        candidate.adaptation_active = false;
        candidate.adaptation_charges = 0;
        candidate.summon = None;
        refresh_player_derived(&self.gameplay, &self.mage_skills, &mut candidate);

        let profile = profile_from_state(
            &candidate.state,
            &candidate.map_id,
            &candidate.death_id,
            candidate.base_max_mp,
        );
        if let Some(store) = self.store.as_ref() {
            if store.save_profile(player_id, &profile).is_err() {
                return false;
            }
        }
        self.end_conversation(player_id);
        let Some(player) = self.players.get_mut(player_id) else {
            return false;
        };
        *player = candidate;
        // Drops for the destination map arrive via the next snapshot.
        self.send_snapshot(player_id);
        true
    }
}
