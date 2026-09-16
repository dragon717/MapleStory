# 飞行船三期：航行中「地獄巴洛古」袭击事件（2026-09-16）

> 任务单来源：`docs/plan/PLAN.md` §飞行船航线系统 三期条目（「航行中蝙蝠魔 Balrog 事件」），
> 以及审计 `MapleStory_TMS273_功能落地审计与Agent复刻计划_2026-09-14.md` 的 C11（「飞船中的 Balrog 事件」）。
> 方案依据：[`topics/飞行船航线系统实现方案.md`](../../topics/飞行船航线系统实现方案.md) §1。

## 1. 范围与结论

兑现 `server/src/ship.rs` 模块头第 15 行留的缺口——「航行中甲板刷蝙蝠魔属二期 Balrog
事件，不建模」。本次只做 **Balrog 事件**这一片；三期条目里的候船室 `station_in` /
阿霖机制、票务道具核实、耶雷弗城与埃德爾斯坦城内 NPC 职能仍**未做**。

新增 `server/src/ship_event.rs`（约 290 行）与 `server/src/ship_event_acceptance.rs`（9 条验收）。
不改相位机、不改到站传送、不改一期/二期任何既有行为。

**协议 24 未变**（新增的是 `type` 字段式的展示广播与快照展示字段，没有新的 serde 结构体，
不需要升协议）；**内容 `tms273-29` → `tms273-30`**——本次把 `8150000` 的模板/帧/名表纳入
装配，`shared/gameplay.json` 怪物模板 63 → 64，四处内容版本常量同步（`assemble_tms273.cjs`、
`shared/protocol.ts`、`server/src/protocol.rs`、`scripts/check_tms273_runtime.cjs`）。

## 2. 源事实与 P 级常量

**怪物本体是源数据，不是自造**（2026-09-16 实测 TMS273.7 WZ）：

| 源位置 | 内容 |
| --- | --- |
| `Mob/8150000.json` | lv100 / maxHP 100000 / PADamage 1318 / 技能 112+113+114 / 动作 `fly, stand, attack1, attack2, hit1, die1` |
| `data/MobReward/8150000.json` | 掉落表 |
| `String/Mob.json` | 名字「地獄巴洛古」（→ `shared/mob-names.json`，键 `"8150000"` 不补零） |
| `Mob/Canvas/8150000.img` | 动画帧 |

**只有「什么时候、在哪张图上刷」这一条规则缺失**：八张源船图
`200090000/001/010/011/100/110/600/610` 的 `life` 节点全是空的（`{"_dirType":"sub"}`）——
原版把调度写在客户端脚下脚本里，而 TMS273 新手包不带脚本体（与 `ship.rs` 记录的同一条缺体
事实同源）。因此**只把调度规则定为 P 级常量**，全部集中在 `ship_event.rs` 顶部：

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `BALROG_ATTACK_START_SEC` | 60 | 检票窗开启后多久刷怪 |
| `BALROG_ATTACK_MAX_SEC` | 180 | 袭击时长上限；实际撤离取「上限到点」与「到站传送」较早者 |
| `BALROG_TEMPLATE_ID` | `"8150000"` | 源模板 id |
| `BALROG_HOVER_Y` | 200.0 | 飞行系悬停高度（源碰撞盒 `lt.y=-311`） |

后续若拿到同版证据（脚本体或同版实测），**只改这四个常量，不动机制**。

## 3. 关键设计决定：袭击窗口取「乘客实际在甲板上」的那一段

这一条必须写明，因为它与 `ship.rs` 模块头的相位命名**不一致**，是本次唯一的判断性取舍。

`ship.rs` 把槽内 `0..SHIP_SAIL_SECONDS`(0..9min) 叫「航行」、`SHIP_SAIL_SECONDS..SHIP_SLOT_SECONDS`
(10..14min) 叫「本端靠港检票」。但一期实现的实际行为是：

- `ship_board_at` 只在**检票窗**（槽内 600..839）放行，并**立刻把乘客放到甲板**；
- `step_ship_at` 只在**航行相位**传送，且是「整单到站传送并清空」（`ship_passengers` 字段注释原话）；
- 因此乘客在甲板上的时间是槽内 **600..899**，到下一槽 `minute 0`（= 航行相位第一拍）被送到对岸。

也就是说：**玩家真正待在船上的时间，是槽内后半段**；航行相位里甲板是空的（乘客已在上一拍上岸）。

若把袭击窗口挂在航行相位上，甲板上永远没人，事件就是死代码。所以本模块按**槽内分钟**表达窗口：

```
open  = SHIP_SAIL_SECONDS + BALROG_ATTACK_START_SEC   // 660
close = min(open + BALROG_ATTACK_MAX_SEC, SHIP_SLOT_SECONDS)  // 840
```

`ship_event_acceptance.rs::ship_event_window_stays_inside_the_voyage` 把这个不变量钉住
（`open > SHIP_SAIL_SECONDS`、`close <= SHIP_SLOT_SECONDS`，且断言当前常量下 open=660 / close=840），
常量被改到越界时该条先失败。

**若将来一期的到站时刻被改到航行相位末尾**（让航行真的被模拟），本模块只需改
`attack_window()` 这一个函数，机制不动。

## 4. 实现要点

- **顺序模拟，追加式**：`step_ship_event()` 插在 `World` 顺序 tick 的 `step_ship()` 之后、
  `step_boss_practice()`/`step_monsters()` 之前（`world.rs`）。到站传送先落位，本拍刚被传上岸的
  乘客不再算「甲板上有人」，靠港那拍只会撤怪、不会补刷。没有第二条世界线，没有独立线程。
- **走既有刷怪通道**：与 `boss.rs` 练习场共用 `spawn_monster_on_map` / `monsters` / 掉落/经验通道。
  `mob_time: -1` ＝一次性刷怪，不参与地图重生周期。
- **刷怪锚点**：取源地图 `sp` 传送门落点，拿不到退回地图出生点；两者都拿不到就**放弃本次事件**
  （不猜坐标硬塞），也不播报。
- **悬停回填**：`spawn_monster_on_map` 会用落脚点重算 `y`（它要把怪钉在地面上），所以传入的 `y`
  只用于选落脚点，悬停高度在刷出后回填到 `state.y`。出生表现显式钉 `action="stand"` +
  `action_started_tick`，让首帧快照从完整第一帧动画开始。
- **撤怪只删自己刷的那一只**：按 spawn id（`ship-balrog-{航线索引}`）认领，不碰地图原有 `life`、
  不碰掉落/经验通道。未结算攻击不用手工清理——`attacks.rs::resolve_pending_attacks` 在命中时刻才按
  `nearest_attack_target` 重新选目标，怪物已不在就自然落空。
- **一班只袭击一次**：撤离后记录保留到槽末（`BalrogEvent.spawned = false`），否则
  「撤离 ⇒ 甲板还有人 ⇒ 立刻补刷」会把一次袭击拉成无限循环。
- **三条有意边界**：只刷甲板不刷船舱（船舱是源里的安全舱）；没人的船不刷；
  撤怪只清事件自己刷的那一只。
- **播报与展示**：`shipEvent` 广播（`balrog_attack` / `balrog_over`）只发给该甲板上的观察者，
  名字取自同版名表，拿不到退回模板 id（不凭空编名字）。快照 `ship.event` 字段带上
  `{monsterId, secondsLeft}`；两条都是**展示字段**，服务器不据此判定任何事。
  客户端 `main.ts` 只在状态行提示，巴洛古本身按普通怪物走 `monsters[]` 快照，无需客户端改动即可显示与攻击。

## 5. 验收

| 项 | 结果 |
| --- | --- |
| `cargo build`（非测试） | **0 告警 0 错误** |
| `cargo test` 全量 | **476 过 / 0 失败**（基线 455 + 本次 9 条 + 其他已落地条目） |
| `ship_event` 定向 9 条 | 全过：窗口不变量 / 到点才刷 / 源模板与悬停 / 空船与船舱不刷 / 一班一次并在下一班重置 / 到站撤怪不随乘客上岸 / 撤怪不动地图自带的怪 / 播报名与源名表一致 / 快照字段只挂被袭击的航线 |
| 客户端 `tsc --noEmit` | 0 错误 |
| `client/scripts/run-checks.mjs` | 33/35，2 项失败＝**既有**的 `layer-animation.check.ts` 与本机沙箱拒 `ps` 的 `build-release.check.cjs`，与本模块无关 |

### 顺带修掉的两处过期断言/注释（内容重建的必然结果）

内容重建后 `shared/notebook-catalog.json` 的 `items` 由 2584 → **2588**
（equipment 1738→1741、etc 86→87），两处硬编码随之过期，已按实测值更新：

- `server/src/notebook_store_acceptance.rs:237` `catalog.item_count()` 2584 → 2588；
- `server/src/auth/notebook.rs:67` 分区注释 2584 → 2588（并同步 equipment/etc 两个分项）。

这是「名单过期要失败」类守卫的正常跟进，不是放宽断言。

## 6. 未验证项（须用户在 Terminal 实玩）

- 完整启动链（`启动3010.command` 统一加载，协议 24 + 内容 `tms273-30` 前后端必须一起换）。
- 实玩：检票上船后甲板出现巴洛古、全甲板看到袭击提示、打死掉落正常、到站时巴洛古不跟乘客上岸、
  下一班重新出现；躲进船舱（埃德爾斯坦线 `200090601` / 维多利亚线 `200090011`）确实不被袭击。
- 耶雷弗线双向共用甲板 `130090000` 上两条航线个体互不清理（已由 `ship_balrog_spawn_id` 的
  per-route 断言覆盖，但未在真机同时触发两条航线验证）。

## 7. 本片未做（三期剩余）

候船室 `station_in` 脚本门 / 阿霖机制、票务道具核实接入、耶雷弗城与埃德爾斯坦城内 NPC
职能与脚本门。
