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
            "/cash" => self.gm_cash(&id, &request_id, &args),
            _ => {
                gm_result(
                    self,
                    &id,
                    &request_id,
                    false,
                    "gm_unknown_command",
                    "未知的 GM 命令。可用：/add <道具id> <数量>；/cash <楓點数>",
                );
            }
        }
    }

    /// `/cash <amount>` — grant 現金商店 balance to the sender.
    ///
    /// P: the local wallet has no real charging path, so this command is the
    /// only grant; it exists so the purchase flow is actually usable.  The
    /// amount clamps to a sane 1..=1_000_000_000 window and persists through
    /// the same save_profile path a purchase uses.
    fn gm_cash(&mut self, id: &str, request_id: &str, args: &[&str]) {
        let parsed = args
            .first()
            .and_then(|raw| raw.parse::<i64>().ok())
            .unwrap_or(0);
        if args.len() != 1 || parsed <= 0 || parsed > 1_000_000_000 {
            gm_result(
                self,
                id,
                request_id,
                false,
                "gm_usage",
                "用法：/cash <楓點数>（1..=1000000000）",
            );
            return;
        }
        let Some(player) = self.players.get_mut(id) else {
            return;
        };
        player.state.cash = player.state.cash.saturating_add(parsed as u64);
        let balance = player.state.cash;
        if let (Some(store), Some(player)) = (self.store.as_ref(), self.players.get(id)) {
            let _ = store.save_profile(
                id,
                &profile_from_state(&player.state, &player.map_id, &player.death_id, player.base_max_mp),
            );
        }
        gm_result(
            self,
            id,
            request_id,
            true,
            "",
            &format!("已发放 {parsed} 楓點，当前余额 {balance}。"),
        );
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
        if let Some(store) = self.store.clone() {
            let outcome = match store.grant_inventory_item(id, request_id, &item_id, quantity) {
                Ok(outcome) => outcome,
                Err(error) => {
                    gm_result(self, id, request_id, false, "persistence", &error);
                    return;
                }
            };
            if !outcome.success {
                gm_result(
                    self,
                    id,
                    request_id,
                    false,
                    &outcome.code,
                    match outcome.code.as_str() {
                        "inventory_full" => "背包页签已满，没有空位。",
                        "request_reused" => "请求编号已用于其他道具操作。",
                        _ => "道具发放失败。",
                    },
                );
                return;
            }
            let profile = match store.load_profile(id, &self.default_profile()) {
                Ok(profile) => profile,
                Err(error) => {
                    gm_result(self, id, request_id, false, "persistence", &error);
                    return;
                }
            };
            if let Some(player) = self.players.get_mut(id) {
                player.state.inventory = profile.inventory;
            }
            let display = crate::inventory::pet_name(&item_id)
                .map(str::to_owned)
                .unwrap_or_else(|| item_id.clone());
            gm_result(
                self,
                id,
                request_id,
                true,
                "gm_add_ok",
                &format!(
                    "已获得 {}（{}）×{quantity}，放入 {} 号页签 {} 格。",
                    display,
                    item_id,
                    match kind_for_item(&item_id) {
                        1 => "装备",
                        2 => "消耗",
                        3 => "设置",
                        4 => "其他",
                        _ => "现金",
                    },
                    outcome.from_slot,
                ),
            );
            self.send_snapshot(id);
            return;
        }
        let kind = crate::inventory::inventory_type(&item_id).unwrap_or(5);
        let slot_limit = {
            let Some(player) = self.players.get(id) else {
                return;
            };
            player
                .state.inventory_slots
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

fn kind_for_item(item_id: &str) -> u8 {
    crate::inventory::inventory_type(item_id).unwrap_or(5)
}

/// Whether the compile-time item catalog itself carries the id (as opposed to
/// the million-group fallback, which accepts source-shaped ids without a
/// catalog row).
fn catalog_has(item_id: &str) -> bool {
    crate::inventory::catalog_contains(item_id)
}
