//! GM 命令系统：聊天框以 `/` 开头的文本在服务端截获并执行。
//!
//! 客户端零特殊处理：`/add ...` 作为普通 `chatSend` 发出，`handle_chat` 在
//! 进入文本策略/幂等/限流之前把 `/` 前缀文本路由到这里，命令文本**永远不会**
//! 被当作地图聊天广播。执行结果以专用 `gmResult` 消息**只发给命令发起者**。
//!
//! ## 负责
//! - `/add <itemId> <count>`：向发起者背包新增道具（走 `crate::inventory::add_items`）
//! - 未知命令回执：`gm_unknown_command`（不广播、不中断聊天限流状态）
//!
//! ## 不负责
//! - 聊天限流与幂等窗口（GM 命令在它们之前截获，不受令牌桶约束）
//! - 宠物道具的召唤语义（宠物走 `useItem` 分支，见 `pets.rs`）
//! - 权限体系：当前阶段所有角色都可用（单机复刻用途），后续接入 GM 账号表时
//!   只需在本模块入口加一道身份闸门
//!
//! ## 状态所有者
//! 无自有状态：道具落在 `Player.state.inventory`，反馈走 `Player.output`。
//!
//! ## 测试入口
//! `gm_acceptance.rs` 经 `include!` 进入 `world.rs` 的 `mod tests`。

use super::*;

/// GM feedback for one command invocation.  Only the sender receives it; the
/// server is the only author of every field, so a modified client cannot
/// fake a system notice for somebody else.
fn gm_result(world: &mut World, id: &str, request_id: &str, success: bool, code: &str, message: &str) {
    if let Some(player) = world.players.get(id) {
        let payload = serde_json::json!({
            "type": "gmResult",
            "requestId": request_id,
            "success": success,
            "code": code,
            "message": message,
        });
        let _ = player.output.try_send(payload.to_string());
    }
}

impl World {
    /// Entry point from `handle_chat`: `text` is known to start with `/`
    /// after trimming.  Never broadcasts to the map room.
    pub(super) fn handle_gm_command(&mut self, id: String, request_id: String, text: String) {
        let trimmed = text.trim();
        let mut parts = trimmed.split_whitespace();
        let command = parts.next().unwrap_or("").to_ascii_lowercase();
        let args: Vec<&str> = parts.collect();
        match command.as_str() {
            "/add" => self.gm_add(&id, &request_id, &args),
            _ => {
                gm_result(
                    self,
                    &id,
                    &request_id,
                    false,
                    "gm_unknown_command",
                    "未知的 GM 命令。可用：/add <道具id> <数量>",
                );
            }
        }
    }

    /// `/add <itemId> <count>` — grant items to the sender's inventory.
    ///
    /// The item id is resolved against the same rules the rest of the world
    /// uses (catalog + pet catalog + million-group fallback), so `/add` can
    /// hand out pets (`5000000+`) as well as ordinary items.  Stacks fill to
    /// slotMax first; equipment and pets take one slot each.
    fn gm_add(&mut self, id: &str, request_id: &str, args: &[&str]) {
        if args.is_empty() || args.len() > 2 {
            gm_result(
                self,
                id,
                request_id,
                false,
                "gm_usage",
                "用法：/add <道具id> <数量>，例如 /add 2000000 10",
            );
            return;
        }
        let item_id = args[0].to_owned();
        let quantity: u32 = match (args.get(1).copied(), args.len()) {
            (None, 1) => 1,
            (Some(raw), _) => match raw.parse::<u32>() {
                Ok(value) if value > 0 && value <= 999 => value,
                _ => {
                    gm_result(
                        self,
                        id,
                        request_id,
                        false,
                        "gm_quantity_invalid",
                        "数量必须是 1-999 的整数。",
                    );
                    return;
                }
            },
            (None, _) => {
                gm_result(self, id, request_id, false, "gm_usage", "用法：/add <道具id> <数量>");
                return;
            }
        };
        // Identity: the item must exist in the runtime item catalog, the pet
        // catalog, or resolve through the source million-group fallback.
        let known = crate::inventory::inventory_type(&item_id).is_some()
            && (catalog_has(&item_id) || crate::inventory::is_pet(&item_id));
        if !known {
            gm_result(
                self,
                id,
                request_id,
                false,
                "gm_item_unknown",
                &format!("未知的道具 id：{item_id}。索引表见 shared/items.json（道具）与 shared/pets.json（宠物）。"),
            );
            return;
        }
        let kind = crate::inventory::inventory_type(&item_id).unwrap_or(5);
        let slot_limit = {
            let Some(player) = self.players.get(id) else {
                return;
            };
            player
                .inventory_slots
                .get(&kind)
                .copied()
                .unwrap_or(crate::inventory::SLOT_LIMIT)
        };
        let Some(player) = self.players.get_mut(id) else {
            return;
        };
        match crate::inventory::add_items(&mut player.state.inventory, item_id.clone(), quantity, slot_limit) {
            Ok(slot) => {
                let display = crate::inventory::pet_name(&item_id).map(str::to_owned);
                gm_result(
                    self,
                    id,
                    request_id,
                    true,
                    "gm_add_ok",
                    &format!(
                        "已获得 {}（{}）×{quantity}，放入 {} 号页签 {} 格。",
                        display.unwrap_or_else(|| item_id.clone()),
                        item_id,
                        match kind {
                            1 => "装备",
                            2 => "消耗",
                            3 => "设置",
                            4 => "其他",
                            _ => "现金",
                        },
                        slot,
                    ),
                );
                self.send_snapshot(id);
            }
            Err(error) => {
                gm_result(
                    self,
                    id,
                    request_id,
                    false,
                    error.code(),
                    match error.code() {
                        "inventory_full" => "背包页签已满，没有空位。",
                        _ => "道具发放失败。",
                    },
                );
            }
        }
    }
}

/// Whether the compile-time item catalog itself carries the id (as opposed to
/// the million-group fallback, which accepts source-shaped ids without a
/// catalog row).
fn catalog_has(item_id: &str) -> bool {
    crate::inventory::catalog_contains(item_id)
}
