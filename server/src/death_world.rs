//! 原创扩展「死亡世界」第一期：墓碑留存 + 虚影演化。
//!
//! 审计代码图条目 06 的边界注记把「原创墓碑留存／虚影演化」列为另行立项的
//! 原创扩展（不计入原版缺口）；本模块就是那次立项的实现。它**不改变**任何
//! 原版死亡/复活语义：死亡判定与经验惩罚仍在 `monsters.rs::commit_incoming_damage`，
//! 复活落点与状态恢复仍在 `revive.rs::complete_revive`，本模块只做三件事：
//!
//! 1. **墓碑留存**：正式死亡在同图死亡落点留下一座墓碑；复活**不**销毁它，
//!    由绝对时钟（unix 毫秒）在 `TOMBSTONE_RETENTION_MS` 后统一收走——重启
//!    不刷新期限，掉线/换图不删世界状态。
//! 2. **虚影演化**：每座墓碑附着一个虚影，按「经过时间 + 悼念人数」在三个
//!    可观察阶段（潜伏 → 游荡 → 凝聚）间单向演化。阶段是 (now, mourners)
//!    的**纯函数**，像 `AwayMarker` 一样每次投影时重新推导，没有独立时钟，
//!    因此不存在「演出与权威分叉」的第二份状态。
//! 3. **悼念互动**：同图活着且在范围内的角色可以悼念一座墓碑；同一角色对
//!    同一座墓碑只计一次（去重集合），重复悼念重放同一结果。
//!
//! 不负责：死亡惩罚、复活、Boss 练习结算（各自模块）。练习图与风铃运行期
//! 实例图不落碑——私有遭遇不该在世界里留下公共痕迹。
//!
//! 持久化：`auth::death_world::Store` 方法 + `death_tombstones` 表
//! （`auth/schema.rs`）。墓碑是展示性原创内容：持久化失败只降级为「这一座
//! 碑不在了」，绝不反过来打断已经提交的死亡事实。

use super::*;

/// 墓碑留存时长。绝对时钟：`expires_unix_ms = created + 30min`，重启不刷新。
pub(super) const TOMBSTONE_RETENTION_MS: i64 = 30 * 60 * 1000;
/// 同图墓碑容量。超过后最早的先走——纪念是有界的，世界不被无限堆积。
pub(super) const TOMBSTONES_PER_MAP: usize = 8;
/// 悼念的互动距离（服务端权威校验；客户端提示只做参考）。
pub(super) const TOMBSTONE_RANGE_X: f64 = 120.0;
pub(super) const TOMBSTONE_RANGE_Y: f64 = 100.0;
/// 虚影演化阈值：死亡 5 分钟后「游荡」，15 分钟后（或集齐 3 位悼念者）「凝聚」。
pub(super) const ECHO_WANDER_AFTER_MS: i64 = 5 * 60 * 1000;
pub(super) const ECHO_CONVERGE_AFTER_MS: i64 = 15 * 60 * 1000;
pub(super) const ECHO_CONVERGE_MOURNERS: usize = 3;

/// 一座墓碑。`death_id` 是唯一性来源：重复致死只有一次事实，同一次死亡的
/// 墓碑也只会有一个（死亡去重逻辑复用既有 `death_id` 机制）。
#[derive(Clone, Debug)]
pub(super) struct Tombstone {
    pub id: String,
    pub death_id: String,
    pub character_name: String,
    pub map_id: String,
    pub x: f64,
    pub y: f64,
    pub epitaph: String,
    /// 死亡时刻的角色外观（纸娃娃）。虚影的样子 = 这份外观的灰色形态；
    /// 客户端拿它走现有 appearance 管线渲染，服务端不做任何像素工作。
    pub appearance: Option<crate::lobby::Appearance>,
    pub created_unix_ms: i64,
    pub expires_unix_ms: i64,
    /// 去重后的悼念者（角色 id）。集合语义 ⇒ 同一角色重复悼念只计一次。
    pub mourners: BTreeSet<String>,
}

impl Tombstone {
    /// 虚影阶段名（0..=2）。客户端只渲染这份权威标签，不自行命名。
    pub const STAGE_NAMES: [&'static str; 3] = ["潜伏", "游荡", "凝聚"];

    pub fn expired(&self, now_unix_ms: i64) -> bool {
        self.expires_unix_ms <= now_unix_ms
    }

    /// 虚影演化阶段：**纯函数**。时间推阶段，悼念可以把凝聚提前——
    /// 「后来者的关注让虚影成形」是这期原创玩法的因果，不是装饰。
    pub fn echo_stage(&self, now_unix_ms: i64) -> u8 {
        if self.mourners.len() >= ECHO_CONVERGE_MOURNERS
            || now_unix_ms - self.created_unix_ms >= ECHO_CONVERGE_AFTER_MS
        {
            return 2;
        }
        if now_unix_ms - self.created_unix_ms >= ECHO_WANDER_AFTER_MS {
            return 1;
        }
        0
    }
}

/// 原创碑文池（P：原创文案，无源出处）。按 `death_id` 稳定哈希选一条，
/// 同一座碑永远读同一句话——碑文是死亡事实的一部分，不能每次看都不一样。
const EPITAPHS: [&str; 5] = [
    "风把名字吹进草里，路还在。",
    "这里停下过一个人，和一整段没走完的路。",
    "灯熄了，火种还温着。",
    "别为我停太久，前面有怪。",
    "坠落的地方，也能是起点。",
];

fn epitaph_for(death_id: &str) -> &'static str {
    let mut hasher = DefaultHasher::new();
    death_id.hash(&mut hasher);
    EPITAPHS[(hasher.finish() as usize) % EPITAPHS.len()]
}

/// 世界侧 `Tombstone` → 持久行投影。世界模块自己完成转换，auth 持久层
/// 只见中立记录，不反向依赖世界私有类型。
fn tombstone_record(tombstone: &Tombstone) -> auth::death_world::TombstoneRecord {
    auth::death_world::TombstoneRecord {
        id: tombstone.id.clone(),
        death_id: tombstone.death_id.clone(),
        character_name: tombstone.character_name.clone(),
        map_id: tombstone.map_id.clone(),
        x: tombstone.x,
        y: tombstone.y,
        epitaph: tombstone.epitaph.clone(),
        appearance: tombstone
            .appearance
            .as_ref()
            .and_then(|appearance| serde_json::to_value(appearance).ok()),
        created_unix_ms: tombstone.created_unix_ms,
        expires_unix_ms: tombstone.expires_unix_ms,
        mourners: tombstone.mourners.iter().cloned().collect(),
    }
}

impl World {
    /// 正式死亡的收尾：在死亡落点留一座墓碑。由
    /// `monsters.rs::commit_incoming_damage` 的 killed 分支调用——**所有**
    /// 致死路径（接触伤害、Boss 攻击）都汇于那一处，所以这里天然只被
    /// 调用一次；`death_id` 去重是第二道防线。
    ///
    /// 失败降级：落点计算或持久化失败只意味着「这座碑不在」，绝不影响
    /// 已经提交的死亡事实（墓碑是原创展示内容，不是资产）。
    pub(super) fn spawn_death_tombstone(&mut self, id: &str, death_id: &str) {
        if death_id.is_empty() {
            return;
        }
        // 同一次死亡只落一座碑（幂等防线；正常路径一次死亡只会走到这里一次）。
        if self
            .death_tombstones
            .values()
            .any(|tombstone| tombstone.death_id == death_id)
        {
            return;
        }
        let Some(player) = self.players.get(id) else {
            return;
        };
        // 私有遭遇不留世界痕迹：Boss 练习图是每个角色的私人实例，风铃运行期
        // 实例图只存在于当次游玩。这与 `persist_player` 的边界同口径。
        if auth::is_practice_map(&player.map_id)
            || windbell::is_runtime_instance_map(&player.map_id)
        {
            return;
        }
        let map = self.map_for(&player.map_id).clone();
        // 落点贴地：死亡坐标夹进地图边界，再吸附到最近的脚点地面，
        // 墓碑不会悬空、不会卡进墙外。
        let x = player.state.x.clamp(map.bounds.x_min, map.bounds.x_max);
        let y = map
            .ground_near(x, player.state.y)
            .map(|(_, ground)| ground)
            .unwrap_or(player.state.y);
        let now = unix_now_ms();
        let tombstone = Tombstone {
            id: format!("tomb-{death_id}"),
            death_id: death_id.to_owned(),
            character_name: player.state.username.clone(),
            map_id: player.map_id.clone(),
            x,
            y,
            epitaph: epitaph_for(death_id).to_owned(),
            appearance: player.state.appearance.clone(),
            created_unix_ms: now,
            expires_unix_ms: now.saturating_add(TOMBSTONE_RETENTION_MS),
            mourners: BTreeSet::new(),
        };
        self.make_room_for_tombstone(&tombstone);
        if let Some(store) = self.store.as_ref() {
            if store.save_tombstone(&tombstone_record(&tombstone)).is_err() {
                // 降级：留档失败就不落碑。死亡事实已提交，此处只丢展示层。
                return;
            }
        }
        self.death_tombstones.insert(tombstone.id.clone(), tombstone);
    }

    /// 同图容量守恒：先清过期的，再在超容时挤掉同图最早的。
    /// 到期/被挤掉时同步删持久行——内存与库不留下两套事实。
    fn make_room_for_tombstone(&mut self, incoming: &Tombstone) {
        let now = unix_now_ms();
        let expired: Vec<String> = self
            .death_tombstones
            .iter()
            .filter(|(_, tombstone)| tombstone.expired(now))
            .map(|(id, _)| id.clone())
            .collect();
        for id in &expired {
            self.remove_tombstone(id);
        }
        let mut same_map: Vec<(String, i64)> = self
            .death_tombstones
            .iter()
            .filter(|(_, tombstone)| tombstone.map_id == incoming.map_id)
            .map(|(id, tombstone)| (id.clone(), tombstone.created_unix_ms))
            .collect();
        while same_map.len() + 1 > TOMBSTONES_PER_MAP {
            same_map.sort_by_key(|(_, created)| *created);
            let Some((oldest, _)) = same_map.first() else {
                break;
            };
            let oldest = oldest.clone();
            self.remove_tombstone(&oldest);
            same_map.remove(0);
        }
    }

    fn remove_tombstone(&mut self, id: &str) {
        self.death_tombstones.remove(id);
        if let Some(store) = self.store.as_ref() {
            let _ = store.remove_tombstone(id);
        }
    }

    /// 每拍清扫：把到期墓碑从世界收走（内存 + 持久行）。期限是绝对时钟，
    /// 这里只是执行已经注定的到期，不存在「重启刷新期限」的第二套时钟。
    pub(super) fn step_death_tombstones(&mut self) {
        let now = unix_now_ms();
        let expired: Vec<String> = self
            .death_tombstones
            .iter()
            .filter(|(_, tombstone)| tombstone.expired(now))
            .map(|(id, _)| id.clone())
            .collect();
        for id in expired {
            self.remove_tombstone(&id);
        }
    }

    /// 快照投影：观察者所在地图的墓碑列表。阶段在这里按当前时钟推导，
    /// 与 `AwayMarker` 同一模式——没有独立时钟，就没有分叉。
    pub(super) fn tombstones_for_snapshot(&self, map_id: &str) -> Vec<serde_json::Value> {
        let now = unix_now_ms();
        self.death_tombstones
            .values()
            .filter(|tombstone| tombstone.map_id == map_id && !tombstone.expired(now))
            .map(|tombstone| {
                let stage = tombstone.echo_stage(now) as usize;
                let mut value = serde_json::json!({
                    "id": tombstone.id,
                    "x": tombstone.x,
                    "y": tombstone.y,
                    "characterName": tombstone.character_name,
                    "epitaph": tombstone.epitaph,
                    "stage": stage,
                    "stageName": Tombstone::STAGE_NAMES[stage],
                    "mourners": tombstone.mourners.len(),
                    "expiresInMs": (tombstone.expires_unix_ms - now).max(0),
                });
                // 灰色虚影的原料：死亡时的外观。缺席（老快照/无外观）时客户端
                // 走抽象光点兜底，不影响其余字段。
                if let Some(appearance) = &tombstone.appearance {
                    value["appearance"] = serde_json::to_value(appearance).unwrap_or(serde_json::Value::Null);
                }
                value
            })
            .collect()
    }

    /// 悼念一次。客户端只命名墓碑；存在性、到期、同图、距离与死活全部由
    /// 服务器重新裁决。去重集合让重复悼念（无论换不换 requestId）都收敛到
    /// 同一份结果——悼念是心意，不该被刷成数值。
    pub(super) fn handle_tombstone_mourn(
        &mut self,
        id: String,
        request_id: String,
        tombstone_id: String,
    ) {
        let Some(player) = self.players.get(&id) else {
            return;
        };
        if player.state.action == "dead" || player.state.hp <= 0 {
            let _ = player.output.try_send(reject(
                "invalid_state",
                "死亡角色不能悼念。",
                Some(&request_id),
            ));
            return;
        }
        let Some(tombstone) = self.death_tombstones.get(&tombstone_id).cloned() else {
            let _ = player.output.try_send(reject(
                "tombstone_unknown",
                "这里没有这样一座墓碑。",
                Some(&request_id),
            ));
            return;
        };
        let now = unix_now_ms();
        if tombstone.expired(now) || tombstone.map_id != player.map_id {
            self.death_tombstones.remove(&tombstone_id);
            if let Some(store) = self.store.as_ref() {
                let _ = store.remove_tombstone(&tombstone_id);
            }
            let _ = player.output.try_send(reject(
                "tombstone_gone",
                "这座墓碑已经随风而去了。",
                Some(&request_id),
            ));
            return;
        }
        let dx = (tombstone.x - player.state.x).abs();
        let dy = (tombstone.y - player.state.y).abs();
        if dx > TOMBSTONE_RANGE_X || dy > TOMBSTONE_RANGE_Y {
            let _ = player.output.try_send(reject(
                "tombstone_out_of_range",
                "离墓碑近一点再悼念吧。",
                Some(&request_id),
            ));
            return;
        }
        let already_mourned = tombstone.mourners.contains(&id);
        if !already_mourned {
            if let Some(entry) = self.death_tombstones.get_mut(&tombstone_id) {
                entry.mourners.insert(id.clone());
                if let Some(store) = self.store.as_ref() {
                    let _ = store.save_tombstone(&tombstone_record(entry));
                }
            }
        }
        let Some(entry) = self.death_tombstones.get(&tombstone_id) else {
            return;
        };
        let stage = entry.echo_stage(now) as usize;
        let message = serde_json::json!({
            "type": "tombstoneResult",
            "requestId": request_id,
            "tombstoneId": entry.id,
            "characterName": entry.character_name,
            "epitaph": entry.epitaph,
            "stage": stage,
            "stageName": Tombstone::STAGE_NAMES[stage],
            "mourners": entry.mourners.len(),
            "alreadyMourned": already_mourned,
        })
        .to_string();
        if let Some(player) = self.players.get(&id) {
            let _ = player.output.try_send(message);
        }
    }
}
