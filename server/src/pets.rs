//! 宠物运行时：召唤 / 收回 / 跟随移动。
//!
//! 数据来源：`shared/pets.json`（`Item/Pet` + `String/Pet.json` 导出），
//! 图形帧由装配清单 `manifest.pets` 提供。宠物是**会话状态**：挂在
//! `Player` 运行时上，随入图创建、随离图销毁，不参与存档。
//!
//! ## 负责
//! - 双击宠物道具（`useItem` 前置分支，见 `inventory_ops.rs`）切换召唤/收回
//! - 每 tick 的跟随移动：横向以固定速度逼近主人，纵向贴住主人脚底
//! - 快照行注入：`players[].pet`（`world.rs::snapshot`），纯出站、纯展示
//!
//! ## 不负责
//! - 宠物道具的库存归属（`crate::inventory::is_pet` 是唯一身份闸门）
//! - 持久化：`useItem` 走的存档事务被宠物分支短路，道具不消耗
//! - 饥饿/拾取/成长：源数据已保留 `life`/`hungry`，运行时后续立项
//!
//! ## 状态所有者
//! `Player.pet: Option<PetRuntime>`（`world.rs` 定义、`commands.rs` 构造为
//! `None`）。本模块是它的唯一写入路径。

use super::*;

/// One summoned pet.  The owner's world membership owns the lifetime: the
/// `Player` row survives map transfers, so every authoritative map change
/// (portal gate, scroll return, quest warp) recalls the pet explicitly via
/// `player.pet = None`; a disconnect removes the whole `Player` — exactly
/// like the source's "宠物不跨地图跟随" MVP scope.
#[derive(Clone)]
pub(super) struct PetRuntime {
    pub(super) item_id: String,
    pub(super) name: String,
    pub(super) x: f64,
    pub(super) y: f64,
    pub(super) facing: i8,
    /// `"stand"` or `"move"`; the client only animates these two loops.
    pub(super) action: &'static str,
}

/// The pet starts trailing this far behind the owner's facing side.
pub(super) const PET_SPAWN_OFFSET: f64 = 18.0;
/// Horizontal gap at which the pet stops walking (px).
pub(super) const PET_FOLLOW_GAP: f64 = 8.0;
/// Pet walk speed in px/ms (slower than a character's ~0.2+, matching the
/// source's "pet trots behind" feel without ever losing the owner).
pub(super) const PET_SPEED_PX_PER_MS: f64 = 0.18;

impl World {
    /// Toggle the pet named by a `useItem` intent.  The client names tab and
    /// slot only; the pet identity is re-resolved from the authoritative
    /// inventory cell (tab + slot must match together — slot numbers are
    /// tab-local, see the 2026-09-13 弹丸拒售 lesson in trade).
    pub(super) fn pet_toggle(
        &mut self,
        id: &str,
        request_id: &str,
        inventory_type: u8,
        source_slot: i16,
        item_id: &str,
    ) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        // The cell must be the pet the client named: same tab-local slot and
        // the resolved cash tab (5).  A forged slot/item pair is refused
        // before any state changes.
        let cell_ok = inventory_type == 5
            && u16::try_from(source_slot).is_ok_and(|slot| {
                player.state.inventory.iter().any(|item| {
                    item.slot == slot
                        && item.item_id == item_id
                        && crate::inventory::inventory_type(&item.item_id) == Some(5)
                })
            });
        let Some(name) = (cell_ok && crate::inventory::is_pet(item_id))
            .then(|| crate::inventory::pet_name(item_id).unwrap_or_default().to_owned())
        else {
            let _ = player.output.try_send(reject(
                "item_not_usable",
                "该道具不是可召唤的宠物。",
                Some(request_id),
            ));
            return;
        };
        let Some(player) = self.players.get_mut(id) else {
            return;
        };
        let already_summoned = player
            .pet
            .as_ref()
            .map(|pet| pet.item_id == item_id)
            .unwrap_or(false);
        if already_summoned {
            // Double-click the active pet's item again: recall it.  The item
            // itself stays in the inventory (no consumption, no persistence).
            player.pet = None;
        } else {
            // Summon (or switch): the previous pet is replaced, matching the
            // source's one-pet-out rule.
            let (x, y, facing) = {
                let state = &player.state;
                (
                    state.x - f64::from(state.facing) * PET_SPAWN_OFFSET,
                    state.y,
                    state.facing,
                )
            };
            player.pet = Some(PetRuntime {
                item_id: item_id.to_owned(),
                name,
                x,
                y,
                facing,
                action: "stand",
            });
        }
        let outcome = serde_json::json!({
            "type": "inventoryResult",
            "requestId": request_id,
            "operation": "use",
            "success": true,
            "code": "pet_toggled",
            "sourceSlot": source_slot,
            "itemId": item_id,
            "quantity": 1,
            "inventoryType": 5,
        });
        let _ = player.output.try_send(outcome.to_string());
        self.send_snapshot(id);
    }

    /// Per-tick follow: walk toward the owner when the gap exceeds the stop
    /// distance, otherwise stand and mirror the owner's facing.  Snapshots
    /// are pushed every tick by `World::step`, so this never needs its own
    /// fan-out.
    pub(super) fn step_pet(&mut self, id: &str) {
        let Some(player) = self.players.get_mut(id) else {
            return;
        };
        let Some(pet) = player.pet.as_mut() else {
            return;
        };
        let target_x = player.state.x - f64::from(player.state.facing) * PET_SPAWN_OFFSET;
        let dx = target_x - pet.x;
        if dx.abs() > PET_FOLLOW_GAP {
            let step = PET_SPEED_PX_PER_MS * TICK_MS as f64;
            let moved = step.min(dx.abs());
            pet.x += dx.signum() * moved;
            pet.facing = if dx > 0.0 { 1 } else { -1 };
            pet.action = "move";
        } else {
            pet.facing = player.state.facing;
            pet.action = "stand";
        }
        pet.y = player.state.y;
    }
}
