//! 椅子（第 31 项）：设置栏道具 → 坐姿会话状态 → 坐椅恢复。
//!
//! ## 边界
//! * **持有复用背包**：椅子一直是设置栏(3)里的普通物品，本模块**不**移动、不消耗它
//!   ——双击只是坐/起立（源里椅子用掉一次就没了的是「一次性椅子」脚本，本仓未接）。
//! * **坐姿是会话状态**：不落库；重连 / 换图 / 死亡 / 受击 / 任一移动输入 / 施法
//!   都会结束它（收口点见 `world.rs` 的 tick 与 `monsters.rs`）。
//! * **恢复量全部来自源**：`D/chairs.json` 的 `info.recoveryHP` / `recoveryMP`
//!   与 `String/Ins.json` 文案；本模块不估算、不设默认值。
//!
//! ## 间隔的诚实边界
//! 源 `info` **没有**间隔字段，只有描述文案里写「每N秒」。因此 `chairs.json` 只在
//! 文案确实写出时才给 `recoveryIntervalMs`；缺席（173 件有恢复字段但文案没写）时
//! 本模块**不恢复**，也不给倒计时——套一个默认 10 秒就是编规则。
//!
//! ## 取值口径
//! 恢复量只在源字段声明处取一次，上限只在 HP/MP 顶格处取一次；下一拍**从现在**往后
//! 推而不是追赶（`step_chairs` 注释里有理由）。

use super::*;

/// 坐姿会话。`next_recovery_at` 是**权威**的下一次恢复拍。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ChairRuntime {
    pub item_id: String,
    pub recovery_hp: i64,
    pub recovery_mp: i64,
    /// `None` ＝ 间隔未核定 ⇒ 只坐、不恢复、不给倒计时。
    pub recovery_interval_ticks: Option<u64>,
    pub next_recovery_at: Option<u64>,
}

/// 起立的**唯一出口**。收 `&mut Player` 的理由与 `mounts::dismount` 相同：调用点
/// 既有世界侧也有已握着 `player` 借用的一侧（死亡、受击、换图）。
pub(super) fn stand_up(player: &mut Player, tick: u64, rationale: &'static str) {
    if player.chair.take().is_some() {
        player.state.action_started_tick = tick;
        let _ = rationale;
    }
}

/// 每拍对账：死亡即起立。移动输入那条判据在 `world.rs` 的 tick 里（必须在
/// `step_player` **之前**，否则玩家的第一拍输入会被吞掉），这里只兜住「无输入也会
/// 结束」的那一种。
pub(super) fn reconcile(player: &mut Player, tick: u64) {
    if player.chair.is_none() {
        return;
    }
    if player.state.action == "dead" || player.state.hp <= 0 {
        stand_up(player, tick, "death");
    }
}

impl World {
    /// 世界侧起立的唯一入口：`&mut Player` 形态的薄包装，供已经握着 `player`
    /// 借用的调用点（`monsters.rs`、`world.rs` 的 tick）与世界侧调用点共用同一段实现。
    pub(super) fn stand_up(&mut self, id: &str, rationale: &'static str) {
        let tick = self.tick;
        if let Some(player) = self.players.get_mut(id) {
            stand_up(player, tick, rationale);
        }
    }

    /// 坐下／起立。与骑乘同一开关语义：**不**消耗物品、**不**改背包。
    /// 借用形状与 `mounts::mount_toggle` 相同：先判定，后落地。
    pub(super) fn chair_toggle(
        &mut self,
        id: &str,
        request_id: &str,
        inventory_type: u8,
        source_slot: i16,
        item_id: &str,
    ) {
        let tick = self.tick;
        enum Decision {
            Sit,
            Stand,
            Reject(&'static str),
        }
        let decision = {
            let Some(player) = self.players.get(id) else {
                return;
            };
            // 权威复核：设置栏**该槽位**上现在确实是这件椅子。客户端只说「我双击了
            // 设置栏第 N 格」，那一格现在是什么由服务端自己的快照决定。
            let authoritative = player
                .state
                .inventory
                .iter()
                .find(|item| {
                    item.slot == u16::try_from(source_slot).unwrap_or(0)
                        && inventory::inventory_type(&item.item_id) == Some(3)
                })
                .map(|item| item.item_id.clone());
            if authoritative.as_deref() != Some(item_id) {
                Decision::Reject("chair_mismatch")
            } else if !inventory::is_chair_item(item_id) {
                // 设置栏里也有非椅子的装饰品（旗帜、告示板…）：它们没有坐姿规则，
                // 因此回一个**具名**码，而不是落进末尾的 `InvalidInventoryType`
                // （设置栏是合法栏位，说它非法等于给了个错的原因）。
                Decision::Reject("not_a_chair")
            } else if player.chair.is_some() {
                // 起立永远允许：唯一一条不受状态限制的路径。
                Decision::Stand
            } else if player.state.hp <= 0 || player.state.action == "dead" {
                Decision::Reject("chair_dead")
            } else if player.mount.is_some() {
                Decision::Reject("chair_mounted")
            } else if player.state.climbing || player.swimming || !player.state.grounded {
                // 源里坐姿只有落地的形态；绳上/水中/空中的坐姿没有可依据的规则。
                Decision::Reject("chair_unsupported")
            } else {
                Decision::Sit
            }
        };
        let (success, code) = match decision {
            Decision::Reject(reject_code) => (false, reject_code.to_owned()),
            Decision::Stand => {
                let Some(player) = self.players.get_mut(id) else {
                    return;
                };
                player.chair = None;
                player.state.action = "stand";
                player.state.action_started_tick = tick;
                (true, "chair_stand".to_owned())
            }
            Decision::Sit => {
                let (recovery_hp, recovery_mp, interval_ms) =
                    inventory::chair_recovery(item_id).expect("is_chair_item 已证明存在");
                // 间隔未核定时两个字段都是 `None`：坐姿照常成立，只是不恢复、也不给
                // 倒计时（`snapshot_field` 因此不会写出那两个字段）。
                let interval_ticks = interval_ms
                    .filter(|ms| *ms > 0)
                    .map(|ms| ms as u64 / TICK_MS)
                    .filter(|ticks| *ticks > 0);
                let Some(player) = self.players.get_mut(id) else {
                    return;
                };
                player.chair = Some(ChairRuntime {
                    item_id: item_id.to_owned(),
                    recovery_hp,
                    recovery_mp,
                    recovery_interval_ticks: interval_ticks,
                    next_recovery_at: interval_ticks.map(|ticks| tick.saturating_add(ticks)),
                });
                player.state.action = "sit";
                player.state.action_started_tick = tick;
                (true, "chair_sit".to_owned())
            }
        };
        let outcome = chair_outcome(request_id, inventory_type, source_slot, item_id, success, &code);
        self.inventory_requests
            .insert((id.to_owned(), request_id.to_owned()), outcome.clone());
        self.send_inventory_outcome(id, &outcome);
        if success {
            self.send_snapshot(id);
        }
    }

    /// 每拍推进坐椅恢复。恢复量只在源字段声明处取；上限只在 HP/MP 顶格处一次。
    ///
    /// 落库顺序与 `skills.rs::step_natural_recovery` **逐字同序**（先算候选 → 落库
    /// → 再写内存；失败只把下一拍往后推）。理由是同一个：恢复是持久状态的改动，
    /// 不能出现「内存里回了血、库里没有」的一版；只有真的回了才写库，已经满血时
    /// 只消耗这一拍、不发 SQLite 写。
    ///
    /// 挂载点在既有的顺序 tick 上（`world.rs` 每拍一次、全部玩家一趟），不给椅子
    /// 另开 task，也不让每个玩家各自读时钟。
    pub(super) fn step_chairs(&mut self) {
        let ids: Vec<String> = self.players.keys().cloned().collect();
        for id in ids {
            let tick = self.tick;
            let Some(player) = self.players.get(&id) else {
                continue;
            };
            let Some(chair) = player.chair.as_ref() else {
                continue;
            };
            let (Some(interval), Some(due)) =
                (chair.recovery_interval_ticks, chair.next_recovery_at)
            else {
                continue;
            };
            if tick < due {
                continue;
            }
            // 一次只结算一拍，且下一拍**从现在**往后推：世界可能有很长的空档
            // （驻留角色、进程挂起、调试断点），用 `due + interval` 追赶会让一次停顿
            // 补出一叠恢复。这里宁可少给，也不给「离线也回血」的口子。
            let next_recovery_at = tick.saturating_add(interval);
            let (recovery_hp, recovery_mp) = (chair.recovery_hp.max(0), chair.recovery_mp.max(0));
            let hp = (player.state.hp + recovery_hp).min(player.state.max_hp);
            let mp = (player.state.mp + recovery_mp).min(player.state.max_mp);
            let changed = hp != player.state.hp || mp != player.state.mp;
            let (map_id, death_id, base_max_mp) = (
                player.map_id.clone(),
                player.death_id.clone(),
                player.base_max_mp,
            );
            if changed {
                let mut candidate = player.state.clone();
                candidate.hp = hp;
                candidate.mp = mp;
                if let Some(store) = self.store.as_ref() {
                    if store
                        .save_profile(
                            &id,
                            &profile_from_state(&candidate, &map_id, &death_id, base_max_mp),
                        )
                        .is_err()
                    {
                        if let Some(chair) = self
                            .players
                            .get_mut(&id)
                            .and_then(|player| player.chair.as_mut())
                        {
                            chair.next_recovery_at = Some(next_recovery_at);
                        }
                        continue;
                    }
                }
            }
            // 借用的作用域刻意收进块里：恢复跳字要在 `player` 的可变借用结束之后
            // 再借用 `self`，所以先把「实际加了多少」取出来。
            let recovered = {
                let Some(player) = self.players.get_mut(&id) else {
                    continue;
                };
                if let Some(chair) = player.chair.as_mut() {
                    chair.next_recovery_at = Some(next_recovery_at);
                }
                if changed {
                    let recovered = (hp - player.state.hp, mp - player.state.mp);
                    player.state.hp = hp;
                    player.state.mp = mp;
                    recovered
                } else {
                    (0, 0)
                }
            };
            self.emit_recovery_event(&id, recovered.0, recovered.1, "chair");
        }
    }
}

/// `chair` 快照行。只在坐姿中出现；**间隔未核定时不写那两个字段**——客户端因此
/// 不会显示一个来源不明的倒计时（`F/chairs/model.ts` 按字段缺席处理）。
pub(super) fn snapshot_field(player: &Player, tick: u64) -> Option<serde_json::Value> {
    let chair = player.chair.as_ref()?;
    let mut value = serde_json::json!({
        "itemId": chair.item_id,
        "recoveryHp": chair.recovery_hp,
        "recoveryMp": chair.recovery_mp,
    });
    if let (Some(interval), Some(due)) = (chair.recovery_interval_ticks, chair.next_recovery_at) {
        value["recoveryIntervalMs"] = serde_json::Value::from(interval.saturating_mul(TICK_MS));
        value["nextRecoveryInMs"] =
            serde_json::Value::from(due.saturating_sub(tick).saturating_mul(TICK_MS));
    }
    Some(value)
}

fn chair_outcome(
    request_id: &str,
    inventory_type: u8,
    source_slot: i16,
    item_id: &str,
    success: bool,
    code: &str,
) -> auth::InventoryOutcome {
    auth::InventoryOutcome {
        request_id: request_id.to_owned(),
        operation: "chair".to_owned(),
        inventory_type: Some(inventory_type),
        from_slot: source_slot,
        to_slot: None,
        item_id: item_id.to_owned(),
        quantity: 1,
        drop_id: None,
        success,
        code: code.to_owned(),
    }
}
