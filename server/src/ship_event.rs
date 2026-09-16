//! 飞行船三期：航行中「地獄巴洛古」袭击事件。
//!
//! 源事实（TMS273.7 WZ，2026-09-16 实测）：怪物模板 `8150000 地獄巴洛古` 是
//! 真实源数据——`Mob/8150000.json`（lv100 / maxHP 100000 / PADamage 1318 /
//! 技能 112+113+114 / 动作 `fly, stand, attack1, attack2, hit1, die1`）、
//! `data/MobReward/8150000.json`（掉落表）、`String/Mob.json`（名字）、
//! `Mob/Canvas/8150000.img`（帧）四处都在。**只有「什么时候、在哪张图上刷」
//! 这一条规则缺失**：八张源船图 `200090000/001/010/011/100/110/600/610`
//! 的 `life` 节点全是空的（`{"_dirType":"sub"}`），原版把这套调度写在客户端
//! 脚下脚本里，而 TMS273 新手包不带脚本体（`ship.rs` 模块头已记录同一条
//! 缺体事实）。所以：
//!
//! - **怪物本体是源数据**——模板、数值、掉落、动画帧一律来自 WZ，不是自造；
//! - **只把调度规则定为 P 级常量**，全部集中在下面四个常量里，后续若拿到
//!   同版证据只改这里，不动机制。
//!
//! 设计依据：`docs/plan/topics/飞行船航线系统实现方案.md` §1 的多来源一致
//! 结论——「15 分钟一班、开船后 10 分钟到达、开船前约 5 分钟开始检票、
//! 开船前 1 分钟停止登船；**甲板会刷蝙蝠魔，船舱内安全**」。本模块兑现的
//! 就是这一句，以及 `ship.rs` 模块头第 15 行「航行中甲板刷蝙蝠魔……不建模」
//! 留下的缺口。
//!
//! ## 袭击窗口取「乘客实际在甲板上」的那一段
//!
//! 这里有一个必须写明的既有事实：`ship.rs` 的相位命名把槽内 `0..SHIP_SAIL_SECONDS`
//! 叫「航行」、`SHIP_SAIL_SECONDS..SHIP_SLOT_SECONDS` 叫「本端靠港检票」，但
//! **一期实现是在检票窗里把乘客放上甲板、并在下一槽开船那一拍整单送到对岸**
//! （`ship.rs::step_ship_at` 只在航行相位传送，`ship_passengers` 字段注释
//! 「相位进入航行时整单到站传送并清空」）。也就是说：**玩家真正待在船上的
//! 时间，是槽内后半段**；航行相位里甲板是空的（乘客已经在上一拍上岸了）。
//!
//! 所以本模块的袭击窗口按「槽内分钟」表达，起点是检票窗开启后
//! `BALROG_ATTACK_START_SEC` 秒，终点取「时长上限」与「到站整单传送」中较早
//! 的一个。这样做的理由是它**唯一能让事件真正发生**：把窗口挂在航行相位上，
//! 甲板上永远没人，事件就是死代码。若将来一期的到站时刻被改到航行相位末尾
//! （让航行真的被模拟），本模块只需改 `attack_window()` 这一个函数，机制不动。
//!
//! 与 `boss.rs` 的练习场共用同一套 `spawn_monster_on_map` / `monsters` /
//! 掉落通道：没有第二条世界线，也没有独立线程，只是在 `World` 的顺序 tick
//! 里加一段**追加式**的刷怪/撤怪步进。
//!
//! ## 事件形态
//! 1. 窗口开启且**甲板上有人**时，在该航线的甲板上刷出 `8150000`，全图播报
//!    一句袭击提示；
//! 2. 到窗口终点，刷出的巴洛古被撤走，全图播报一句「已平息」。玩家打死的
//!    个体走正常死亡路径，撤怪只清事件自己刷的那一只；
//! 3. 到站（整单传送到对岸站台）⇒ 立即撤怪，绝不让巴洛古跟着乘客上岸。
//!
//! ## 三条有意为之的边界
//! - **只刷甲板，不刷船舱**：船舱在源里是安全舱（原版袭击时乘客躲进舱内），
//!   所以 `cabin` 为空串的三期两张船图不设安全区，这本身也是源事实；
//! - **没人的船不刷**：整条航线甲板上没有玩家时不起事件，避免上线即被空船
//!   上的巴洛古追着打，也避免无人地图上白跑一轮 AI；
//! - **一班只袭击一次**：撤离后本班次记录保留到槽末，否则「撤离 ⇒ 甲板还有
//!   人 ⇒ 立刻补刷」会把一次袭击拉成无限循环。
//!
//! 撤怪只删事件自己刷的那一只：不碰地图原有 `life`（源船图本来也没有）、
//! 不碰掉落/经验通道。

use super::*;

/// 袭击开始：检票窗（槽内 `SHIP_SAIL_SECONDS` 起）开启后多久刷怪（秒）。
pub(crate) const BALROG_ATTACK_START_SEC: i64 = 60;
/// 袭击时长上限（秒）。实际撤离时刻取「上限到点」与「到站整单传送」中较早的
/// 一个——到站时乘客会被送到对岸站台，巴洛古绝不能跟着上岸。
pub(crate) const BALROG_ATTACK_MAX_SEC: i64 = 180;
/// 袭击主体模板 id（源 `Mob/8150000.json`）。
pub(crate) const BALROG_TEMPLATE_ID: &str = "8150000";
/// 巴洛古停在甲板上的高度偏移（像素）。源里它是飞行系（动作只有 `fly`），
/// 因此不骑在甲板面上，而是抬到玩家头顶一侧——与 8150000 的 WZ 碰撞盒
/// `lt.y=-311`（高大体型）相称。
pub(crate) const BALROG_HOVER_Y: f64 = 200.0;

/// 袭击窗口在本班次槽内的范围（槽内秒）。起点＝检票窗开启后 `START` 秒；
/// 终点＝时长上限与到站传送时刻中较早者。到站传送发生在槽末，所以只要
/// `START + MAX` 不超过 `SHIP_SLOT_SECONDS - SHIP_SAIL_SECONDS`，终点就是
/// 时长上限；写成 `min` 是为了常量被调整后仍然不会把巴洛古带过站。
fn attack_window() -> (i64, i64) {
    let open = ship::SHIP_SAIL_SECONDS + BALROG_ATTACK_START_SEC;
    let close = (open + BALROG_ATTACK_MAX_SEC).min(ship::SHIP_SLOT_SECONDS);
    (open, close)
}

/// 一条航线上本班次的袭击记录。
///
/// 相位是 unix 时间的纯函数，所以「这一班」由班次槽起点唯一标识；进程内
/// 记录，服务重启即清空——与 `ship_passengers` 同一档内存状态边界。
#[derive(Clone, Copy)]
pub(crate) struct BalrogEvent {
    /// 本班次槽起点的绝对时刻（unix 秒）——「这一班」的唯一身份。
    slot_start: i64,
    /// 撤离时刻（槽内秒）。
    end_sec: i64,
    /// 事件个体是否还在场上。到期后置 `false`，但记录留到本班次结束，
    /// 这样同一班次不会被「撤离 ⇒ 甲板还有人 ⇒ 立刻补刷」拉成无限循环。
    spawned: bool,
}

impl World {
    /// 顺序模拟 tick（在 `step_ship` 之后、`step_monsters` 之前调用）。
    pub(crate) fn step_ship_event(&mut self) {
        self.step_ship_event_at(unix_now_ms() / 1000);
    }

    /// 事件步进（验收入口）：时间可注入，断言才有决定性。
    pub(crate) fn step_ship_event_at(&mut self, now_unix: i64) {
        // 槽内偏移就是本班次已经过的秒数；槽起点由它反推，用作「这一班」的
        // 身份。这里与 `ship::ship_phase_of` 用同一个取模，两处不会各算各的。
        let elapsed = now_unix.rem_euclid(ship::SHIP_SLOT_SECONDS);
        let slot_start = now_unix - elapsed;
        for index in 0..ship::SHIP_ROUTES.len() {
            self.step_one_ship_event(index, slot_start, elapsed);
        }
    }

    fn step_one_ship_event(&mut self, index: usize, slot_start: i64, elapsed: i64) {
        let route = ship::SHIP_ROUTES[index];
        let (open, close) = attack_window();

        if let Some(event) = self.ship_events[index] {
            if event.slot_start != slot_start {
                // 换班次 ⇒ 撤怪并清记录，然后继续按新班次判定，不白等一拍。
                self.despawn_ship_balrog(index, route.deck);
                self.ship_events[index] = None;
            } else if event.spawned && elapsed >= event.end_sec {
                // 本班次到期：撤怪 + 播报平息，记录留到槽末以免补刷。
                self.despawn_ship_balrog(index, route.deck);
                self.ship_events[index] = Some(BalrogEvent {
                    spawned: false,
                    ..event
                });
                self.announce_ship_balrog(index, route.deck, ShipBalrogLine::Over);
                return;
            } else {
                // 本班次已经袭击过（存活中或已平息）⇒ 一律不再补刷。
                return;
            }
        }

        // 走到这里说明本班次还没有袭击记录。窗口内 + 甲板有人 才起事件：
        // 任一不满足就跳过本轮，下一拍继续判定——所以玩家中途上船仍然会被
        // 袭击，只是晚一点。
        if elapsed < open || elapsed >= close || !self.ship_deck_occupied(route.deck) {
            return;
        }
        if !self.spawn_ship_balrog(index, route.deck) {
            // 刷不出来（地图缺、锚点无落脚）就不记事件、不播报——绝不播一句
            // 「巴洛古来了」而场上没有它。
            return;
        }
        self.ship_events[index] = Some(BalrogEvent {
            slot_start,
            end_sec: close,
            spawned: true,
        });
        self.announce_ship_balrog(index, route.deck, ShipBalrogLine::Attack);
    }

    /// 船上有人的判定：甲板上至少有一名真实（非滞留）角色。
    fn ship_deck_occupied(&self, deck: &str) -> bool {
        self.players
            .values()
            .any(|player| player.map_id == deck && !player.detached)
    }

    /// 在甲板上刷出袭击主体。返回是否真的刷出来了。
    ///
    /// 定位取源地图的 `portals`：优先用同图的 `sp` 传送门落点（源数据自带），
    /// 拿不到再退回地图出生点；两条路都走不通就放弃本次事件——不猜一个坐标
    /// 硬塞。
    fn spawn_ship_balrog(&mut self, index: usize, deck: &str) -> bool {
        let Some(map) = self.maps.get(deck).cloned() else {
            return false;
        };
        let anchor = map
            .portals
            .iter()
            .find(|portal| portal.name == "sp")
            .map(|portal| (portal.x, portal.y))
            .unwrap_or((map.spawn.x, map.spawn.y));
        let Some((foothold_id, ground)) = map.ground_near(anchor.0, anchor.1) else {
            return false;
        };
        let spawn = MonsterSpawn {
            id: ship_balrog_spawn_id(index),
            template_id: BALROG_TEMPLATE_ID.to_owned(),
            x: anchor.0,
            // 注意：`spawn_monster_on_map` 会用落脚点重新算 y（它要把怪钉在
            // 地面上），所以这里传的 y 只用于选落脚点，悬停高度在下面回填。
            y: ground,
            foothold_id: Some(foothold_id),
            map_id: deck.to_owned(),
            facing: -1,
            // -1 = 一次性刷怪：这只巴洛古不参与地图重生周期，撤事件即消失。
            mob_time: -1,
            rx0: None,
            rx1: None,
        };
        if self
            .spawn_monster_on_map(deck.to_owned(), spawn.clone())
            .is_err()
        {
            return false;
        }
        // 回填出生表现：飞行系模板 `can_move()` 为假（8150000 的 `fly` 是 0 帧
        // 导出的移动通道），出生动作默认就是 `stand`；这里显式钉一次起始 tick，
        // 让首帧快照从完整的第一帧动画开始，而不是半路切进来。
        let Some(monster_id) = self
            .monsters
            .values()
            .find(|monster| monster.map_id == deck && monster.spawn.id == spawn.id)
            .map(|monster| monster.state.id.clone())
        else {
            return false;
        };
        if let Some(monster) = self.monsters.get_mut(&monster_id) {
            monster.state.action = "stand";
            monster.state.action_started_tick = self.tick;
            monster.state.y = ground - BALROG_HOVER_Y;
            monster.horizontal_speed = 0.0;
        }
        true
    }

    /// 撤掉事件主体。只删本事件刷出的那一只（按 spawn id 认领），地图原有
    /// 怪物、掉落与经验通道一律不动。
    fn despawn_ship_balrog(&mut self, index: usize, deck: &str) {
        let spawn_id = ship_balrog_spawn_id(index);
        let doomed: Vec<String> = self
            .monsters
            .iter()
            .filter(|(_, monster)| monster.map_id == deck && monster.spawn.id == spawn_id)
            .map(|(id, _)| id.clone())
            .collect();
        // 未结算攻击不用手工清理：`attacks.rs::resolve_pending_attacks` 在命中
        // 时刻才按 `nearest_attack_target` 重新选目标，怪物已不在就自然落空，
        // 不存在「结算到一个已删除的个体上」的路径。
        for monster_id in doomed {
            self.monsters.remove(&monster_id);
        }
    }

    /// 全图播报。文案是服务端权威事实，客户端只做展示。
    ///
    /// 名字来自同版怪物名表（`shared/mob-names.json`，唯一给怪物命名的源表就是
    /// `String/Mob.json`），拿不到时退回模板 id——绝不凭空编一个名字。
    fn announce_ship_balrog(&mut self, index: usize, deck: &str, line: ShipBalrogLine) {
        let name = crate::auth::notebook::catalog()
            .monster_label(BALROG_TEMPLATE_ID)
            .unwrap_or(BALROG_TEMPLATE_ID);
        let event = serde_json::json!({
            "type": "shipEvent",
            "route": ship::SHIP_ROUTES[index].id,
            "event": line.as_str(),
            "monsterId": BALROG_TEMPLATE_ID,
            "monsterName": name,
            "seconds": match line {
                ShipBalrogLine::Attack => BALROG_ATTACK_MAX_SEC,
                ShipBalrogLine::Over => 0,
            },
        })
        .to_string();
        self.broadcast_to_map(deck, &event);
    }

    /// 快照 `ship.event` 字段：客户端据此在班次面板上显示「袭击中」的秒数。
    /// 与 `ship::ship_snapshot_field` 同一档展示字段，服务器不据此判定任何事，
    /// 因此这里按航线索引取值，不参与任何玩法逻辑。
    pub(crate) fn ship_event_snapshot_field(
        &self,
        route_index: usize,
        now_unix: i64,
    ) -> Option<serde_json::Value> {
        let event = self.ship_events.get(route_index).copied().flatten()?;
        if !event.spawned {
            return None;
        }
        let elapsed = now_unix.rem_euclid(ship::SHIP_SLOT_SECONDS);
        let left = event.end_sec - elapsed;
        (left > 0).then(|| {
            serde_json::json!({
                "monsterId": BALROG_TEMPLATE_ID,
                "secondsLeft": left,
            })
        })
    }
}

/// 事件播报的两种语气，与客户端文案一一对应。
#[derive(Clone, Copy)]
enum ShipBalrogLine {
    Attack,
    Over,
}

impl ShipBalrogLine {
    fn as_str(self) -> &'static str {
        match self {
            Self::Attack => "balrog_attack",
            Self::Over => "balrog_over",
        }
    }
}

/// 事件主体的 spawn id。加上航线索引，所以同一张共用甲板（耶雷弗线双向共用
/// `130090000`）上两条航线的个体互不清理。
pub(crate) fn ship_balrog_spawn_id(route_index: usize) -> String {
    format!("ship-balrog-{route_index}")
}
