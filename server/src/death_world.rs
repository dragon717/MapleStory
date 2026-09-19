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
/// D06 试点遭遇：凝聚虚影的护路打击范围（相对碑位）与节流。
pub(super) const ECHO_STRIKE_RANGE_X: f64 = 200.0;
pub(super) const ECHO_STRIKE_RANGE_Y: f64 = 120.0;
/// 单击伤害 = 怪物最大 HP 的 15%（至少 1），过量部分按剩余 HP 截断。
/// 固定百分比、无随机数：D06 的判据要可独立复算，命中/未命中的可控随机
/// 留给 D07/D10 的注入缝。
pub(super) const ECHO_STRIKE_DAMAGE_PERCENT: i64 = 15;
/// 两次打击之间的最小间隔（unix ms）。这是 pacing 不是事实：重启归零
/// 只意味着「重启后可以立刻再试一次」，不产生任何结算分叉。
pub(super) const ECHO_STRIKE_INTERVAL_MS: i64 = 2500;

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
    /// 试点打击的节流阀（unix ms）。**运行时 pacing，不入库**：重启归零
    /// 只影响下一次尝试的早晚，不产生结算分叉（奖励认领按生命去重在库层）。
    pub next_strike_unix_ms: i64,
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
            next_strike_unix_ms: 0,
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
        self.step_echo_strikes(now);
    }

    /// D06 试点遭遇：凝聚阶段的虚影打击**没有玩家交战**的近身怪物——
    /// 「护路」的最小原型：虚影清的是无人认领的威胁，绝不抢普通战斗。
    ///
    /// 奖励路由：致死一击与玩家击杀共用 `monster_rewards` 的同一把主键
    /// （虚影行 `account_id=NULL, actor_kind='echo'`）。虚影伤害**不写**
    /// 伤害贡献表——玩家后续补刀的分成按纯玩家贡献计算，不被稀释。
    /// 虚影击杀无掉落、无玩家经验；怪物模板经验以冻结值留在奖励行里，
    /// 成为 D08 经验球的根预算。
    fn step_echo_strikes(&mut self, now: i64) {
        struct EchoStrike {
            tombstone_id: String,
            map_id: String,
            monster_id: String,
            x: f64,
            y: f64,
            damage: i64,
            killed: bool,
            exp: u64,
        }
        // 先收集、后应用：决策阶段全部只读，避免借用交错。
        let mut strikes: Vec<EchoStrike> = Vec::new();
        for tombstone in self.death_tombstones.values() {
            if tombstone.echo_stage(now) < 2 {
                continue;
            }
            if now < tombstone.next_strike_unix_ms {
                continue;
            }
            // 私有遭遇不参与试点（与落碑守卫同口径；正常情况下那里不会有碑）。
            if auth::is_practice_map(&tombstone.map_id)
                || windbell::is_runtime_instance_map(&tombstone.map_id)
            {
                continue;
            }
            let target = self
                .monsters
                .iter()
                .filter(|(_, monster)| {
                    if monster.map_id != tombstone.map_id || monster.state.hp <= 0 {
                        return false;
                    }
                    // 不抢普通已占据的战斗：仇恨还在玩家手里的怪不碰。
                    if monster.aggro_target.is_some() && self.tick <= monster.aggro_until {
                        return false;
                    }
                    (monster.state.x - tombstone.x).abs() <= ECHO_STRIKE_RANGE_X
                        && (monster.state.y - tombstone.y).abs() <= ECHO_STRIKE_RANGE_Y
                })
                .min_by(|(a_id, a), (b_id, b)| {
                    (a.state.x - tombstone.x)
                        .abs()
                        .total_cmp(&(b.state.x - tombstone.x).abs())
                        .then_with(|| a_id.cmp(b_id))
                });
            let Some((monster_id, monster)) = target else {
                continue;
            };
            let damage = ((monster.state.max_hp as i64) * ECHO_STRIKE_DAMAGE_PERCENT / 100)
                .max(1)
                .min(monster.state.hp);
            strikes.push(EchoStrike {
                tombstone_id: tombstone.id.clone(),
                map_id: tombstone.map_id.clone(),
                monster_id: monster_id.clone(),
                x: monster.state.x,
                y: monster.state.y,
                killed: damage >= monster.state.hp,
                damage,
                exp: monster.template.exp.max(0) as u64,
            });
        }
        for strike in strikes {
            // 唯一奖励主键：只有致死那一击才认领；认领失败（已被认领/
            // 持久化故障）就当这一击没发生过——绝不无凭据地弄死一只怪。
            let mut applied_killed = false;
            if strike.killed {
                let claimed = match self.store.as_ref() {
                    Some(store) => store
                        .claim_echo_kill(
                            &strike.monster_id,
                            &format!("{}-{}", strike.tombstone_id, strike.monster_id),
                            strike.exp,
                        )
                        .unwrap_or(false),
                    // 无持久层的测试世界：击杀事实只存在于运行时，无需认领。
                    None => true,
                };
                if !claimed {
                    continue;
                }
                applied_killed = true;
            }
            if let Some(monster) = self.monsters.get_mut(&strike.monster_id) {
                monster.state.hp = (monster.state.hp - strike.damage).max(0);
                monster.state.action = if monster.state.hp == 0 { "die" } else { "hit" };
                monster.state.action_started_tick = self.tick;
                if monster.state.hp == 0 {
                    monster.freeze_until = 0;
                    monster.state.freeze_stacks = None;
                    monster.stun_until = 0;
                    let die_ticks = monster
                        .template
                        .die_duration_ms
                        .unwrap_or(1)
                        .div_ceil(TICK_MS)
                        .max(1);
                    monster.death_until = Some(self.tick + die_ticks);
                    monster.respawn_at = respawn_deadline(
                        self.tick,
                        self.gameplay.monster_respawn_ms,
                        monster.spawn.mob_time,
                    );
                }
            }
            if let Some(tombstone) = self.death_tombstones.get_mut(&strike.tombstone_id) {
                tombstone.next_strike_unix_ms =
                    now.saturating_add(self.echo_strike_interval_ms);
            }
            let event = serde_json::json!({
                "type": "echoStrikeEvent",
                "tombstoneId": strike.tombstone_id,
                "monsterId": strike.monster_id,
                "x": strike.x,
                "y": strike.y,
                "damage": strike.damage,
                "killed": applied_killed,
            })
            .to_string();
            self.broadcast_to_map(&strike.map_id, &event);
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

    /// GM 指令 `/shadow <0..=2>`：在发起者脚下落一座指定演化阶段的碑。
    ///
    /// 阶段仍由那条纯函数推导：这里只把 `created_unix_ms` 拨回相应的过去
    /// （潜伏=现在、游荡=5 分钟前、凝聚=15 分钟前），不为 GM 另开第二套
    /// 阶段判据。碑本身是一座真碑——持久化、同图容量与到期全部走真实
    /// 路径；`death_id` 带 `gm-shadow-` 前缀并拼接随机后缀，每次调用都是
    /// 一座新碑（不会被死亡去重误伤），容量满了同样挤掉同图最早的。
    pub(super) fn gm_spawn_shadow(&mut self, id: &str, stage: u8) -> Result<String, String> {
        let Some(player) = self.players.get(id) else {
            return Err("你还没有进入世界。".into());
        };
        // 与真实落碑同一条边界：私有遭遇不在世界里留公共痕迹。
        if auth::is_practice_map(&player.map_id)
            || windbell::is_runtime_instance_map(&player.map_id)
        {
            return Err("练习图与风铃运行期实例图不留墓碑，换张普通图再试。".into());
        }
        let map = self.map_for(&player.map_id).clone();
        // 落点贴地，与 `spawn_death_tombstone` 同一套口径：不悬空、不出界。
        let x = player.state.x.clamp(map.bounds.x_min, map.bounds.x_max);
        let y = map
            .ground_near(x, player.state.y)
            .map(|(_, ground)| ground)
            .unwrap_or(player.state.y);
        let now = unix_now_ms();
        let created = now
            - match stage {
                2 => ECHO_CONVERGE_AFTER_MS,
                1 => ECHO_WANDER_AFTER_MS,
                _ => 0,
            };
        let death_id = format!("gm-shadow-{}-{}", now, auth::random_id());
        let tombstone = Tombstone {
            id: format!("tomb-{death_id}"),
            character_name: player.state.username.clone(),
            appearance: player.state.appearance.clone(),
            epitaph: epitaph_for(&death_id).to_owned(),
            death_id,
            map_id: player.map_id.clone(),
            x,
            y,
            created_unix_ms: created,
            expires_unix_ms: now.saturating_add(TOMBSTONE_RETENTION_MS),
            mourners: BTreeSet::new(),
            next_strike_unix_ms: 0,
        };
        self.make_room_for_tombstone(&tombstone);
        if let Some(store) = self.store.as_ref() {
            if store.save_tombstone(&tombstone_record(&tombstone)).is_err() {
                return Err("墓碑留档失败，这一座没有落成。".into());
            }
        }
        let name = tombstone.character_name.clone();
        self.death_tombstones
            .insert(tombstone.id.clone(), tombstone);
        Ok(format!(
            "已在脚下生成虚影「{}」（{name} 的碑）。走近可悼念，30 分钟后随风而逝。",
            Tombstone::STAGE_NAMES[stage as usize],
        ))
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
