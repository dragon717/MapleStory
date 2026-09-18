//! 坐骑（第 30 项）：装备层基础之上的**骑乘切换 / 骑乘状态 / 移动 / 表现**。
//!
//! ## 边界（与既有模块的分工）
//! * **持有与穿脱仍归既有路径**：`inventory::equip_items` / `unequip_items` 与
//!   `auth::Store` 一行未改，本模块**不**移动任何物品——骑乘开关不消耗道具、
//!   不改背包，这一点与源里「双击坐骑＝上下马，装备不动」一致。
//! * **骑行数值来自源档**：`TamingMob/<id>.json/info` 经 `inventory::ride_stats`
//!   读出，本模块不估算、不设默认值；没有已核定数值的那一件**不能骑**。
//! * **骑乘是会话状态**：不落库（`Player.mount` 在 `PlayerState` 之外，快照拼装处
//!   单独投影），重连/死亡/换图/上绳/入水/卸下骑宠都会收掉。
//!
//! ## 源的硬约束
//! 探针直读 `Character/TamingMob/01902000.img`：骑宠的动作集合是
//! `stand1 stand2 walk1 walk2 jump tired prone ladder rope fly`——**没有任何
//! `swing*` / `shoot*` 帧**。因此骑乘中不能发动普攻与技能，这是源数据支持的事实，
//! 不是数值平衡取舍（`world.rs::handle_attack` 与 `skills.rs::handle_cast_skill`
//! 各自按这个判据早退）。
//!
//! ## 未核定（P 级，逐条注明依据，不冒充官方规则）
//! * **骑乘的开关条件**（等级 / 地图 / 疲劳）：源包没有可执行规则。本实现的判据是
//!   「装备栏里确实有该骑宠 + 骑行数值已核定 + 不在空中/绳上/水中/坐姿/死亡/引导中」。
//! * **`fatigue` 的消耗节奏**：源只给初始值（`TamingMob/0001.json` 为 `5`），没有
//!   衰减公式 ⇒ 只上快照、**不扣减**。
//! * **`ladder` / `rope` / `fly` 帧**虽存在，但「骑乘中能否上下绳、能否飞」源里
//!   没有规则 ⇒ 一律按「上绳、入水即下马」收口（见 `reconcile`）。
//! * **`speed` / `jump` 的口径**：源里 24 个坐骑档的 `swim` 全部是 `100`、`speed`
//!   取值 80..190 且以 100 为中枢 ⇒ 按「百分比，100 = 常规」解释（`walk_speed` /
//!   `jump_speed` 是像素换算的唯一落点）。

use super::*;

/// 骑宠的身体槽（**正数**，与 `PlayerState.equipped[].slot` 同一口径：
/// `equip_items` 写入的是 `to_slot.unsigned_abs()`）。
pub(super) const MOUNT_BODY_SLOTS: [u16; 2] = [18, 19];

/// 一次骑乘会话的权威状态。**只**由 `Player.state.equipped` 里的实物重建，
/// 因此「卸下坐骑」这类外部改动不需要额外的失效通知：每拍 `reconcile` 都对账。
#[derive(Clone, Debug, PartialEq)]
pub(super) struct MountRuntime {
    pub item_id: String,
    pub taming_mob: i64,
    pub ride: inventory::RideStats,
}

/// 从权威装备解析骑宠。**任一** −18/−19 槽上是带 `tamingMob` 的装备行即成骑宠；
/// 骑行数值未核定的那一件（源里引用了不存在的坐骑档）**不算**，因为它没有速度可依。
///
/// 现行源包里 `Sd`（−19）槽 26 件**全不带** `tamingMob`，所以这一支实际永不命中；
/// 留着它是防御，不是第二条规则。`Tm`（−18）槽里另有 21 件非坐骑（现金件），
/// 它们被 `inventory::is_mount_item` 挡在门外——按 `islot` 判会把这 21 件与機械師
/// 整套装备一起误认成坐骑。
pub(super) fn resolve_mount(
    equipped: &[crate::protocol::InventoryItem],
) -> Option<MountRuntime> {
    MOUNT_BODY_SLOTS.iter().find_map(|slot| {
        let item = equipped.iter().find(|item| item.slot == *slot)?;
        let ride = inventory::ride_stats(&item.item_id)?;
        let taming_mob = inventory::mount_taming_mob(&item.item_id)?;
        Some(MountRuntime {
            item_id: item.item_id.clone(),
            taming_mob,
            ride,
        })
    })
}

/// 坐骑**在位但骑不了**时，`resolve_mount` 也返回 `None`。此时说
/// 「没有装备坐骑」是假话（槽上确实有那件），所以分开点名：
/// 源里 `tamingMob` 指向缺席坐骑档的那一件（`1932057` 指向 `16`）过得了
/// `is_mount_item`，却没有可依的速度 ⇒ 骑乘请求会走到这里。
fn no_mount_reject_code(equipped: &[crate::protocol::InventoryItem]) -> &'static str {
    let broken = equipped.iter().any(|item| {
        MOUNT_BODY_SLOTS.contains(&item.slot)
            && inventory::is_mount_item(&item.item_id)
            && inventory::ride_stats(&item.item_id).is_none()
    });
    if broken {
        "mount_no_ride_stats"
    } else {
        "no_mount_equipped"
    }
}

/// 结束骑乘的**唯一出口**。收 `&mut Player` 而不是 `(&mut self, id)`：调用点既有
/// 世界侧（`world.rs` 的 tick）也有已经握着 `player` 借用的一侧（`monsters.rs` 的
/// 死亡与受击），两种形状共用同一段实现，因此不存在「某一处忘了收」的第二条路。
/// `rationale` 只用于诊断，不改变行为。
pub(super) fn dismount(player: &mut Player, tick: u64, rationale: &'static str) {
    if player.mount.take().is_some() {
        // 姿态必然改变：起始拍换掉，否则客户端会沿用上一个姿态的已播帧。
        player.state.action_started_tick = tick;
        let _ = rationale;
    }
}

/// 每拍对账：装备里的骑宠没了（卸下/换装/交易/掉落）就下马，并收掉那些
/// 「源里没有规则可依」的姿态（上绳、入水、死亡）。
///
/// 这一条是**唯一**能让骑乘在无输入情况下结束的路径，所以写成对账而不是事件——
/// 任何能在别处移动装备的代码路径都自动被覆盖。
pub(super) fn reconcile(player: &mut Player, tick: u64) {
    if player.mount.is_none() {
        return;
    }
    if player.state.action == "dead" || player.state.hp <= 0 {
        dismount(player, tick, "death");
        return;
    }
    if player.state.climbing || player.swimming {
        dismount(player, tick, "climb_or_swim");
        return;
    }
    match resolve_mount(&player.state.equipped) {
        Some(current) => {
            if player.mount.as_ref() != Some(&current) {
                player.mount = Some(current);
            }
        }
        None => dismount(player, tick, "unequipped"),
    }
}

impl World {
    /// 骑上／下马。纯开关：**不**消耗物品、**不**改装备。
    ///
    /// 拒绝沿用本仓既有的拒绝通道（`send_inventory_outcome` 的 `success:false`
    /// + code）——双击反馈本来就走那条路，不新造拒绝消息。
    ///
    /// 借用形状：判据只在**不可变**借用里算完，落地在借用结束之后。`Player` 与
    /// `World` 同在 `self` 里，同时借用会撞借用检查器；「先判定、后落地」同时让这段
    /// 逻辑没有中间态。
    pub(super) fn mount_toggle(
        &mut self,
        id: &str,
        request_id: &str,
        inventory_type: u8,
        source_slot: i16,
        item_id: &str,
    ) {
        let tick = self.tick;
        enum Decision {
            On,
            Off,
            Reject(&'static str),
        }
        let decision = {
            let Some(player) = self.players.get(id) else {
                return;
            };
            match resolve_mount(&player.state.equipped) {
                None => Decision::Reject(no_mount_reject_code(&player.state.equipped)),
                Some(mounted) => {
                    // ① 身份复核：请求里的槽与 id 必须与**权威装备**逐字对上。
                    //    客户端只说「我双击了 −18 槽上的这件」，那一槽现在是什么
                    //    由服务端自己决定，因此伪造一个 id 只会拿到 `mount_mismatch`。
                    let actual_slot = player
                        .state
                        .equipped
                        .iter()
                        .find(|item| item.item_id == mounted.item_id)
                        .map_or(0, |item| item.slot);
                    let claimed_slot = u16::try_from(source_slot.unsigned_abs()).unwrap_or(0);
                    if mounted.item_id != item_id || claimed_slot != actual_slot {
                        Decision::Reject("mount_mismatch")
                    } else if player.mount.is_some() {
                        // 下马**永远允许**：唯一一条不受状态限制的路径，否则一旦
                        // 骑乘状态卡住（比如换图收口的某一拍恰好没跑到）就出不来了。
                        Decision::Off
                    } else if player.state.hp <= 0 || player.state.action == "dead" {
                        Decision::Reject("mount_dead")
                    } else if player.state.climbing {
                        Decision::Reject("mount_climbing")
                    } else if !player.state.grounded {
                        Decision::Reject("mount_airborne")
                    } else if player.swimming {
                        Decision::Reject("mount_swimming")
                    } else if player.chair.is_some() {
                        Decision::Reject("mount_seated")
                    } else if player.channel_until > tick {
                        Decision::Reject("mount_busy")
                    } else {
                        Decision::On
                    }
                }
            }
        };
        let (success, code) = match decision {
            Decision::Reject(reject_code) => (false, reject_code.to_owned()),
            Decision::Off => {
                let Some(player) = self.players.get_mut(id) else {
                    return;
                };
                player.mount = None;
                player.state.action_started_tick = tick;
                (true, "mount_off".to_owned())
            }
            Decision::On => {
                let Some(player) = self.players.get_mut(id) else {
                    return;
                };
                // 再解析一次：只读借用已经结束，而 `mount` 只能从权威装备派生，
                // 不存在「客户端说骑哪只就骑哪只」。
                player.mount = resolve_mount(&player.state.equipped);
                player.state.action_started_tick = tick;
                (true, "mount_on".to_owned())
            }
        };
        let outcome = mount_outcome(request_id, inventory_type, source_slot, item_id, success, &code);
        self.inventory_requests
            .insert((id.to_owned(), request_id.to_owned()), outcome.clone());
        self.send_inventory_outcome(id, &outcome);
        if success {
            self.send_snapshot(id);
        }
    }
}

/// `mount` 快照行。**只在骑乘中出现**，因此未骑乘的玩家行不变形（与
/// `away` / `abnormalStatus` / `pets` 同一段拼装处、同一种「缺席即无此事」语义）。
pub(super) fn snapshot_field(player: &Player) -> Option<serde_json::Value> {
    let mount = player.mount.as_ref()?;
    Some(serde_json::json!({
        "itemId": mount.item_id,
        "tamingMob": mount.taming_mob,
        "speed": mount.ride.speed,
        "jump": mount.ride.jump,
        "fs": mount.ride.fs,
        "fatigue": mount.ride.fatigue,
    }))
}

/// 骑乘对移动的作用（像素换算的**唯一**落点）。
///
/// 源 `speed` / `jump` 是百分比口径（100 = 常规），角色的基础位移常量保持不变，
/// 倍率只在这里出现一次；取整只在末端一次，不在中间步骤各自 round。
pub(super) fn walk_speed(player: &Player, base: f64) -> f64 {
    match player.mount.as_ref() {
        Some(mount) => base * (mount.ride.speed as f64 / 100.0),
        None => base,
    }
}

pub(super) fn jump_speed(player: &Player, base: f64) -> f64 {
    match player.mount.as_ref() {
        Some(mount) => base * (mount.ride.jump as f64 / 100.0),
        None => base,
    }
}

fn mount_outcome(
    request_id: &str,
    inventory_type: u8,
    source_slot: i16,
    item_id: &str,
    success: bool,
    code: &str,
) -> auth::InventoryOutcome {
    auth::InventoryOutcome {
        request_id: request_id.to_owned(),
        // 具名操作：既有的 `["use","equip","unequip"]` 重放白名单不含它，
        // 因此重放走的是**本请求自己的台账**，不可能被误当成一次 `use`。
        operation: "mount".to_owned(),
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
