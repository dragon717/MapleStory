# 冒险岛复刻｜维多利亚港后主线修复与后续章节补齐计划

> 制定日期：2026-09-12  
> 仓库：`dragon717/MapleStory`  
> 分析提交：`1fefe97c2d27a928f3bf670b657d79f68d795fe9`，简称 `1fefe97`  
> 目标原版：**TMS273.7**，不是任意地区的“273”，也不是网上当前 TMS 数据库。  
> 交付性质：基于实际仓库读取的技术方案；**本轮没有修改仓库、重启服务、访问玩家数据库或运行项目测试。**  
> 取代范围：取代上一版“尚未读到源码”的任务修复方案。实施时先与本地 HEAD、未提交修改及运行实例核对；不得强制切换、覆盖工作区。

## 0. 决策摘要

**不要从零重写任务系统，也不要简单追加几个任务编号。先修复现有主线的“可发现、可达、可执行、可恢复”闭环，再补原版后续章节。**

本次沿 `启动3010.command → main.rs → World → quest.rs → Store` 读取后，确认：

1. 港口之后并非没有任何实现。`scripts/tms273_chapter.cjs::applyContinuation` 已装配法师路线 `1402 → 36337 → 36308 → 36309 → 36310 → 36311 → 36312 → 36313 → 36314`，并明确标为 **P：项目执行适配**。原始 q1402/q363 脚本、部分剧情演出和精确奖励仍未取得。[R03]
2. OR 前置、1402 一转、已有法师补剧情而不重复发转职权益、任务与角色数据事务提交，都已有实现。应保留并定向回归，不列为“待从零开发”。[R04][R05]
3. 已找到一个有源码依据的等级断档场景：开场六项任务合计 **450 EXP**；当前临时曲线是 `15 × 当前等级²`。以 **1 级、0 经验、只领取这些奖励** 的计算模型，完成后仅到 5 级；1402 要求 10 级。同时，服务端会省略未满足接取条件的任务，客户端在没有未完成条目时隐藏追踪器。[R03][R04][R06][R07]
4. 续章测试虽然经过真实 NPC 菜单，但会直接把角色放到目标 NPC 坐标，并预置 `10级 / 36307已完成`。它不证明正常玩家从港口出发、不用测试传送就能找到、到达并衔接后续主线。[R08]
5. 本轮确认的 `applyContinuation` 适配范围止于 **36314**。不能据此声称全仓库没有其他任务，也不能把原始任务记录的存在当成运行时已经实现。后续必须按 273.7 原始数据、装配结果与执行入口逐项盘点。[R03]

**目前不能断言上述哪一项就是用户当前角色的唯一根因。** 当前角色等级、职业、任务状态、运行中的数据文件和构建指纹尚未读取。P0 的目标是把这个不确定性缩到一条明确的断链，而不是继续猜。

### 本次范围

| 范围 | 决策 |
|---|---|
| 港口落地、36307、1402、36337，以及到 36314 的已有法师路线 | 本次必须修成完整可玩闭环 |
| 36314 后的冒险家原版章节 | 本次制定并执行数据盘点与分批补齐；具体任务集合由 273.7 原始关系确认 |
| 其他职业路线 | 保留原始分支信息与兼容语义，不借机开放其他职业玩法 |
| 原版数值与脚本还原 | 同版可证实的规则优先；项目临时规则必须继续显式标记 |
| 新通用脚本语言、工作流平台、ECS、微服务 | 不作为修复前提 |
| 用户在线服务、当前 273 数据库、陪测机器人 | 不因研究、测试、补任务而重置或中断 |

---

## 1. 本次真实代码证据与修改落点

行号对应分析提交；后续重构发生后以**函数与 blob**重新定位，不把行号当永久接口。

| 文件 / 符号 | 本轮读到的事实 | 本次处理 |
|---|---|---|
| `启动3010.command` | 使用 `shared/gameplay.json`、`shared/maps.json`、`client/dist-tms273`、`server/data/tms273.sqlite3`；先检查资源，再构建 Rust 与客户端，构建成功后才重启；健康检查仅比协议与内容版本 | 复用入口；补构建/装配指纹，不另起服务 |
| `server/src/main.rs` | 从环境变量或固定路径加载 gameplay、地图目录、任务文字、NPC 名字；启动 `world::run` | 记录实际加载内容摘要；不把测试 `include_str!` 当成线上加载方式 |
| `scripts/assemble_tms273.cjs`，约 150—180、230—末尾 | 设置临时经验曲线、保留岔道汉斯快捷转职；调用 `applyChapter`；写服务端与客户端派生产物 | 修装配源，不手改压缩后的 JSON |
| `scripts/tms273_chapter.cjs::applyChapter` | 开场名单 `36301/36302/36303/36304/36306/36307`；36306 完成去港口；36307 有返回岔道配置 | 校验到港与后继提示；返回入口不得冒充下一章 |
| `scripts/tms273_chapter.cjs::applyContinuation` | 9 个节点到 36314；显式 NPC 接取/交付、剧情转场和起始道具；保留 `sourceCheck` | 保留已有内容，逐项核对 273.7 与 P 适配差异 |
| `server/src/quest.rs::quest_prerequisites_match`，约 43—66 | 已支持 `quest_or_option`，根据原始 `QuestOrOption` 判断 any/all | 不重复修 OR；补不适用分支、无前置及未知条件的定向用例 |
| `server/src/quest.rs::quest_entry`，约 442—580 | 未接取且不满足条件时返回 `None`；已接取任务的 `objectivesComplete` 判断未同时检查全部 complete conditions | 分离章节引导与可执行任务；统一可交付判定 |
| `server/src/quest.rs::quest_npc_map`，约 225—237 | 按模板查找 NPC，首个匹配用于目标地图，另有 Olivia 特例 | 核对同模板多放置与剧情可见性；目标需绑定当前阶段合法实例 |
| `server/src/quest.rs::apply_quest_effect_at`，约 864—1265 | 校验当前状态、条件、NPC；1402 要求原汉斯与图书馆；准备奖励、转职和转场，调用 `commit_quest`；成功后发送 update/list/snapshot | 复用事务路径，修前置/显示而不是另写结算；原有成功后刷新不要重复建设 |
| `server/src/auth/quests.rs::commit_quest` | SQLite 事务保存任务、角色与背包；1402 检查持久化等级、前置与转职候选；旧法师只补剧情 | 保留业务幂等；仅在原版确需 quest record 时小范围扩展 |
| `client/src/features/quest/log.ts::render`，约 189—244 | 按状态及名称排序，追踪第一个非 completed；无目标就隐藏；已会渲染 `blockReason` | 改为消费服务端主线推荐与等待原因，不让支线/名称排序决定主线 |
| `server/src/continuation_acceptance.rs` | 真实菜单测试存在，但 helper 会 `chapter_place`；主用例预置 10 级和完成 36307 | 保留为交互/事务测试，新增真正覆盖港口接续的定向场景 |
| `references/tms273-data/adventurer-continuation-source.json` | 声明 TMS273.7，记录逐任务原始路径与 SHA-256；1402 含 `autoStart / fieldEnter / infoNumber / infoex`，36337 含 `selfStart` | 作为本次同版规则核对主入口；文件中的旧实现状态不是当前运行验收结果 |

### 1.1 已有能力不能误报为缺失

以下不是本次“新开发成果”：

- 36337 的 OR 前置判断。
- 1402 完成时的法师转职与旧法师剧情恢复。
- 任务起始物品、奖励、扣物、角色数据与任务状态的事务提交。
- 36309—36314 的局部剧情转场、帽子装备目标和重复提交防护。
- 任务成功后的任务列表与场景快照刷新。

本计划的新增价值是定位并修复真实接续断点、暴露等待原因、验证普通路线可达性、补齐后续原版内容，而不是改名复制已有代码。[R03][R04][R05]

### 1.2 版本与读取口径

本版修改入口以固定提交的实际源码为准：`World / QuestSpec / QuestConditions / Store`。旧计划或历史文档中的路径、类型和“已完成”描述，必须与该提交及本地实际运行版本核对后再采用。

对几处核心文件保存校验锚点：

| 文件 | 本轮读取 blob |
|---|---|
| `scripts/tms273_chapter.cjs` | `32ff7847accd66eab91c7b2bf4da9c5ee112e53e` |
| `scripts/assemble_tms273.cjs` | `861cd6bef994c3249fb72f7fa1b52135e83ce627` |
| `server/src/quest.rs` | `dd582b0ee3da7cf925b01a36864b55c84e3d0771` |
| `server/src/auth/quests.rs` | `605a93248eec4c437fc017dfbd448e18db53b352` |
| `server/src/continuation_acceptance.rs` | `98e49f050f25c70275d5cc76e818b9843c4405fd` |
| `client/src/features/quest/log.ts` | `1eee1dcb2385a37970b843d2bf2b90b776b3597e` |

---

## 2. 主线断在哪里：先建立一条诊断链

### 2.1 先看实际角色，不按位置推断任务

P0 只读采样须记录：

```text
codeCommit / dirtyWorktree / serverBuildId / clientBuildId
protocolVersion / contentVersion / gameplayDigest / mapCatalogDigest
角色：level / exp / expToNext / job / mapId / 当前实例
任务：36306 / 36307 / 1402 / 36337 / 36308…36314 的持久化状态
任务目录：是否存在 / executable / ruleVersion / start条件 / complete条件
消息：最近一次 questList / questUpdate / NPC菜单 / reject
目标：NpcTemplateId / 实体Id / mapId / 可见性 / 路线是否存在
```

不要记录密码、token、完整账号身份或无关背包数据。报告用脱敏角色标识。针对用户角色的读取在现有授权工具/诊断入口内进行，不添加匿名可查任意玩家的公共接口。

### 2.2 诊断分支

| 观察结果 | 可得结论 | 修复方向 |
|---|---|---|
| 在港口，但 36306 未完成 | 位置与剧情事实不一致，不能视为合法到港完成 | 查正常船票提交/转场；识别旧适配异常，不全局补完成 |
| 36306 完成，36307 未接，后端有 available、界面没有 | 下发/客户端筛选/旧构建问题 | 对比消息与 `QuestLogView`；不修改任务前置 |
| 36307 完成、等级不足 10 | 1402 业务条件确实不满足 | 显示“下一章：法师之路，需10级”；核对原版成长衔接 |
| 等级足够、1402 available，但找不到汉斯/走不到图书馆 | 可发现或可达性断链 | 核对 `1032001 / 101000003` 与完整地图路径 |
| 已是法师，但 1402 未完成 | 快捷转职和剧情事实是两回事 | 走已有旧法师补剧情分支，不能用 job 自动补完成 |
| 1402 完成，但 36337 不出现 | 条件、执行开关、NPC 放置或内容装配有问题 | 打印逐条件判定，核验 `QuestOrOption` 与目标实例 |
| 后端与前端均有任务，但普通角色无法继续 | 地图、NPC、阶段动作或材料执行问题 | 复现实际交互，修数据与业务边界 |
| 当前修复数据存在，但运行实例摘要不同 | 新装配/源码没有被当前运行实例使用 | 由统一入口在批准时机重新加载，保留数据库 |
| 已完成 36314，后面没有可玩内容 | 确認此角色到达现行适配范围边界 | 启动后续章节盘点；显示内容边界，不伪装“全部主线完成” |

### 2.3 最有价值的源码推导：等级门槛被隐藏

开场奖励来自 `applyChapter`：

```text
15 + 30 + 45 + 90 + 120 + 150 = 450 EXP
```

当前装配使用临时经验公式：

```text
1→2：15
2→3：60
3→4：135
4→5：240
合计：450

1→10：15 × (1² + 2² + … + 9²) = 4,275 EXP
```

所以，**从1级0经验出发，仅领取这六项奖励的模型**停在5级，距离10级累计还差3,825经验。玩家若额外打怪、使用其他奖励或已有存档，实际结果当然不同；本计算不是对用户当前等级的断言。[R03][R06]

当前链条是：

```text
36307完成
  → 1402需要10级
  → quest_entry 不输出未达条件的未接任务
  → 客户端没有可追踪的未完成条目时隐藏追踪器
  → 玩家看到“主线没了”，却看不到“为什么、接下来怎么做”
```

**修复不能只是把1402最低等级改为5、直接升到10级，或者扩大旧档补偿。**

先从273.7核对真正的开场奖励、成长节奏、转职门槛与引导。可确认的数据按原版补齐；原脚本奖励未确认时，保留并标注当前 P 曲线，同时给出真实的等级等待和已存在内容的练级引导。不能把未经确认的新奖励称为原版修复。

---

## 3. TMS273.7 原版事实与当前适配必须分开

### 3.1 来源顺序

采用仓库现有 T/R/P/U/X 分级，不另建一套互相冲突的分类：[R02]

| 类别 | 本次用法 |
|---|---|
| T：台服同期 | 273.7 原始 QuestData、NPC、Map、String、Act 等记录及可追溯导出 |
| R：跨区结构参考 | 只辅助理解流程与交互；不得覆盖同版任务号、NPC、等级、奖励 |
| P：项目适配 | 现有显式 NPC 菜单、临时 EXP、缺失演出替代方式；必须保留标注 |
| U：未知 | 未取得脚本正文、运行触发顺序、原版精确奖励等 |
| X：时代外 | 旧83路线、其他地区同名不同编号、未经核定的当前版本数据，排除出正式内容输入 |

网页公共数据库在上一版只能作为定位线索。**现在仓库内已有带原始路径、哈希的273.7记录，应以这些记录为主，不能继续让网上当前任务数据反向改写本地273.7。**

本轮重新打开仓库引用的 MapleSEA v217 官方补丁页，页面日期是2022-09-21；它仍只属于 R 结构参考，不是TMS273.7脚本正文。[W01]

### 3.2 已读到的具体原版字段

`adventurer-continuation-source.json` 中的1402记录包含：[R09]

```text
任务：法师之路
开始NPC：1032001
最低等级：10
开始职业：0
前置：36307完成
fieldEnter：101000003
QuestInfo.autoStart：1
startscript：q1402s
endscript：q1402e
完成记录条件：infoNumber=1406，infoex.value="2"
```

36337 的记录中还能看到 `selfStart=1`。这些字段说明原版触发方式不只是“所有任务都找一个NPC点接取”。

处理原则：

- `autoStart`、`selfStart`、`fieldEnter`、NPC接取、脚本接取不能混成同一布尔值。
- `selfStart` 不能直接解释为无条件自动完成；具体客户端入口与脚本行为仍须核验。
- `sourceCheck` 保留下来了，不等于运行时已执行其全部语义。
- `info1406` 是本路线的重要候选事实；先确认原版语义和当前兼容需求，再增加最小持久化支持，不能照其他版本盲写。
- 当前旧法师放宽职业限制是已有 P 兼容行为；重建原版新手路线时不能误伤旧角色。

### 3.3 每个待补节点的最小证据卡

```text
questId / sourceVersion / sourcePath / sourceSha256
原版名称、章节、是否本版启用
start与complete各自的：NPC、地图、职业、等级、任务状态、记录变量、物品
autoStart / selfStart / fieldEnter / QuestOrOption / subJobFlags
原始脚本名、脚本正文取得情况、演出/副本/转场依赖
奖励、扣物、起始物品、重复/放弃/恢复规则
项目采用的执行方式：T已核定 / P替代 / U阻塞
现有导出→装配→运行时→前端可达路径
```

这是一份技术证据清单，不取代 `PLAN.md` 的当前任务状态台账。

---

## 4. 正确的修复对象：当前法师适配链

下面是**本提交的项目适配链**，不是宣称已验证原版全部执行细节：[R03]

```text
36306：提交船票并到维多利亚港
  ↓
36307：冒险的开始
  ↓ 条件与引导必须清楚；不能把返回岔道当成续章本身
1402：法师之路（10级；图书馆101000003，NPC1032001）
  ↓ 新手执行一转；旧法师只恢复剧情
36337：德斯的帮忙（当前适配NPC1541009，原始分支OR）
  ↓
36308 → 36309 → 36310 → 36311 → 36312 → 36313 → 36314
  ↓
按273.7原始关系核验的后续章节，而非“编号+1”
```

### 4.1 当前续章数据核对表

这里列出的NPC与转场是**项目当前配置事实**。只有与同版原始字段吻合的部分才能标 T，临时放置和菜单安排仍是 P。

| 任务 | 当前接取NPC → 交付NPC | 当前重要效果 | 修复重点 |
|---|---|---|---|
| 1402 | `1032001 → 1032001` | 0职业完成时转200；旧法师不重发权益 | 到港后的10级等待、真实图书馆路线、原始记录条件 |
| 36337 | `1541009 → 1541009` | 原始分支任务满足任一个才解锁 | 原版selfStart与当前NPC入口的差异；NPC阶段可见、可达 |
| 36308 | `1541009 → 1012100` | 与前后剧情衔接 | 不引用其他版本NPC把同名角色全局替换 |
| 36309 | `1012100 → 1541003` | 开始转到130000000；Olivia使用明确P放置 | 剧情阶段可见性、可恢复路线、原始演出差距 |
| 36310 | `1101002 → 1012100` | 开始给4033888并去100000201，交付扣物 | 给信、背包满回滚、开始不等于完成 |
| 36311 | `1012100 → 1012100` | 当前显式对话适配 | 保留开始/交付事实；核对原脚本执行差距 |
| 36312 | `1012100 → 1541004` | 开始去310040200 | 真正可达与返回，不靠测试摆放证明 |
| 36313 | `1541004 → 1541004` | 给1003134，要求穿戴，不消耗帽子；完成去310050000 | 背包与已穿戴均计数，不重发、不可跳过装备目标 |
| 36314 | `1541005 → 1012100` | 起始给4033889/4036847，去100000201，交付扣物 | 当前取得方式是P；补后续章节入口，不伪称原版潜入演出完成 |

### 4.2 不按编号顺接

36337 插在1402与36308之间就是直接反例。后续流程应从原始条件建立有向关系，并包含职业分支、等级等待、进入地图、记录变量和脚本触发。

“下一任务”是条件求值后的结果，不应变成 `questId + 1`，也不能用一个无条件 `nextQuest` 字段覆盖所有分支。

---

## 5. 最小架构调整：任务事实不变，补上章节引导

### 5.1 分清三层状态

```text
持久化事实
  player_quests中的active/completed、角色等级/职业/背包、必要的原版记录
       ↓
规则判断
  当前是否可接、可交、缺什么、目标在哪里、目标是否可执行
       ↓
显示投影
  当前主线、下一章、等级等待、内容未装配、下一步操作
```

**不要为了显示“未解锁”，把未来所有主线写进玩家任务存档。** 也不要把UI的可交付状态当成客户端可上传的完成事实。

### 5.2 复用已有任务条目，独立表达主线等待

当前客户端已有 `blockReason` 显示槽，但没有拿到“下一章节被什么挡住”的稳定信息。[R07]

建议在现有任务列表协议旁增加一个轻量、服务端计算的章节引导视图，命名实施时与项目规范统一：

```ts
// 建议的新类型，不是声称仓库已经定义。
type StoryGuidance = {
  chapterId: string;
  questId?: string;
  phase:
    | 'actionable'
    | 'waitingLevel'
    | 'waitingPrerequisite'
    | 'contentUnavailable'
    | 'chapterComplete';
  title: string;
  nextAction: string;
  blockReason?: string;
  requiredLevel?: number;
  targetMapId?: string;
  targetNpcId?: string;
};
```

原则：

- 原来的任务持久化状态和四种展示状态不必为此整体迁移。
- `waitingLevel` 显示本角色接下来的节点及真实等级条件，不把所有高等级任务刷进列表。
- `contentUnavailable` 与“角色条件未满足”分开，避免把缺脚本伪装成玩家没操作对。
- `chapterComplete` 必须指一个已核定章节结束，不等于开发内容恰好写到头。
- 新字段由 Rust/TS/接收方共同维护；兼容与版本变更由共享协议唯一负责人完成。
- 若将来需要原版灯泡/自动接取入口，作为明确的触发方式接入，不挪用普通地图点击意图。

### 5.3 修正“可交付”的同源判断

`quest_entry` 当前可在目标数量满足时直接标 `objectivesComplete`，实际交付还会检查 complete conditions。[R04]

建议提取一个纯的完成业务条件判断供以下路径共用：

```text
任务条目状态
NPC菜单“交付/查看”
实际Complete命令验证
```

NPC距离、当前会话有效性等交互约束仍在交互入口校验；不能要求角色站到NPC旁边才在任务日志显示“目标已完成”。

### 5.4 刷新触发与权威边界

已有任务提交成功后的 `questUpdate → questList → snapshot` 继续复用，不另造消息总线。[R04]

对新增引导投影，核查并补齐真正影响条件的事件：登录恢复、等级变化、职业变化、任务提交、进入相关地图，以及确有需要的物品/记录变化。优先在当前 World 顺序处理点更新，或使用轻量 dirty 标记；不要每个玩家每Tick遍历全部原版任务库。

网络层只接意图，客户端只显示。接取、扣物、转职、奖励、完成与转场仍由 World 和 Store 决定。

---

## 6. 实施工单与依赖

本文件是专题设计交付。正式采用后，在 `PLAN.md` 登记当前范围、负责人、依赖与验收；完成证据进入 `IMPLEMENTATION_STATUS.md`，不复制第四份进度台账。[R01][R02]

| 工单 | 优先级 | 主要所有权 | 输入与输出 | 完成条件 |
|---|---|---|---|---|
| Q00 当前断点与版本核验 | P0 | 统筹、启动/内容入口 | 当前角色只读事实、源码/装配/运行版本 → 明确根因分支 | 给出第一条失败的状态/条件/消息链；不用猜 |
| Q01 同版链条与覆盖清单 | P0 | 内容导出负责人 | 273.7记录、现有适配 → 已实现/待补/未知矩阵 | 每个当前节点能回溯原始条件；列清P差异 |
| Q02 港口到1402衔接 | P1 | 后端任务 + 前端任务 | Q00/Q01 → 等级等待、下一目标、合法入口 | 低等级不空白，高等级能找到并到达原汉斯 |
| Q03 当前续章可达性 | P1 | 地图/NPC内容 + 后端任务 | 真实地图图谱、阶段实体 → 可走通路径 | 1402到36314无需测试坐标摆放或GM传送 |
| Q04 后续章节补齐 | P2 | 内容/后端任务 | 同版原始后继关系 → 按章节增量实现 | 每批有终点、完整依赖、独立恢复点，不只补任务名 |
| Q05 旧档与记录兼容 | P1/P2 | Store唯一负责人 | 已识别异常类型 → 窄范围恢复或可重试交互 | 不重发转职权益、奖励；不补造历史完成事实 |
| Q06 诊断/内容一致性 | P1 | 装配/启动/协议负责人 | 源记录摘要、产物摘要 → 构建指纹与预检查 | 能分辨旧数据、旧客户端、旧二进制；不擅自重启 |
| Q07 定向验证与用户实玩清单 | 随改动 | 各实现负责人 | 实際修改 → 必要检查及待用户验收项 | 区分静态检查、菜单/事务测试与用户实玩结果 |

并行仅适用于正交文件。`shared/protocol.ts`、Rust协议与 `scripts/tms273_chapter.cjs` 必须明确唯一写入人，不能让多个代理交叉追加分支。

### Q02：港口到1402必须交付的行为

**36307尚未完成：** 指向当前章节合法入口，展示具体NPC与地图，不用任意传送修复。

**36307完成但不足10级：** 显示“下一章：法师之路，达到10级后前往魔法森林图书馆与汉斯交谈”；同时按现有已装配、可到达内容给出成长方向。若没有可用成长内容，应明确列为内容依赖，不能随口给地图名。

**达到10级：** 无需退出重进，主线引导由等待变为可进行；提示和NPC菜单使用同一组条件。是否自动接取，按273.7原始触发与本轮实现证据决定。

**已经是法师：** 允许原有剧情恢复入口，不降低职业、不洗技能、不重复补SP/MP；不要自动把1402标完成。

**返回岔道：** 保留已有用户授权的快捷转职能力；它是可选回访/训练入口，不作为默认后继主线覆盖图书馆目标。

### Q03：现有续章的可达性验证

对每条“任务阶段→目标NPC/地图”都核查：

```text
服务端已装配目标地图
  → 角色当前阶段可走的地图边 / 经核实的剧情转场
  → 门户脚本与落点有效
  → 目标NPC正确放置且对该角色可见
  → 客户端资源存在且点击命中正确实体
  → 正常距离与会话约束下出现正确菜单
  → 提交后任务、背包、地图与推荐同步更新
```

禁止用 `continuation_open_menu` 内的 `chapter_place` 作为路线通过证据。该 helper 保留用于菜单测试，不承担可达性验收职责。

`quest_npc_map` 的首个模板匹配只适用于单一放置；同模板多地图/剧情实例需按当前阶段解析。可以给明确任务阶段配置目标约束，不为此建大型寻路平台或全世界NPC硬编码坐标表。

### Q04：36314之后怎样补，而不是再留一个断点

第一批工作是盘点 **36315—36321及其真实依赖**，但这些编号仅是检索候选，不是已核实的启用名单、等级或线性顺序。

实施步骤：

1. 从273.7原始 `QuestData` 读取候选节点及所有入边、出边、脚本、记录变量。扩展前置不限定363xx，也不把同名旧节点全部启用。
2. 区分职业主线、转职、剧情分支、主题副本、活动、废弃记录与章节结束。建立“本版有效+本路线适用”的集合。
3. 对每个拟开放章节列齐地图、NPC、怪物/演出、物品、转场、等级与持久化依赖。缺任何关键执行依赖时，不能只设 `executable=true`。
4. 先实现一个完整章节切片，包含入口、可执行目标、结算、掉线恢复与后继提示；再扩下一章。
5. 保留原版标题与关键剧情，不用“进图自动全部完成”代替战斗/选择/演出。未取得原脚本时仅采用明确记录的最小P执行适配，列出尚未还原部分。
6. 章节若存在等级间隔，使用同一等待投影；若下一章尚未装配，使用内容未开放提示，不能回到新手通用空白文案。

阶段出口不是“任务数量增加”，而是：**从当前已完成节点，普通角色能明确理解并执行下一段原版内容，或理解真实的等待条件。**

### Q05：旧档恢复

当前 `Store::commit_quest` 已对1402做持久化等级、前置和职业检查，新修复不得绕开。[R05]

| 旧档状态 | 策略 |
|---|---|
| 港口已有36306完成，36307未完成 | 显示并恢复36307合法入口 |
| 36307完成、未满10级 | 补引导，不补经验、不写1402完成 |
| 快捷转职后已有法师职业、1402未完成 | 复用现有剧情恢复分支；保留职业与技能资产 |
| 1402完成、36337不可见 | 修条件/装配/目标，不重复结算1402 |
| 后续任务active且已取得起始道具 | 恢复任务与转场入口，不重复发材料 |
| 异常旧任务行已不在当前目录 | 保留现有显示兼容；经证据确认后才做定向映射 |
| 未来新增原版record但旧档没有 | 仅从可信现有事实可唯一推导时迁移；否则用显式恢复交互，不猜选择 |

纯UI/配置修复不应产生数据库迁移。确实需要数据修复时，提供 dry-run、精确命中条件、迁移版本、审计前后值与幂等策略。不能全量补票、补经验、完成所有363xx或删除玩家数据。

---

## 7. 内容装配与运行一致性

### 7.1 修改真正的数据源

现有路径是：[R06][R10]

```text
273.7 WZ/QuestData 与 references/tms273-data
  → 现有导出器
  → resources/tms273-export/*
  → scripts/assemble_tms273.cjs
      → tms273_chapter.cjs 的显式章节适配
  → shared/gameplay.json / shared/maps.json / shared/quest-text.json / shared/npc-names.json
  → client/public-tms273/assets 的对应内容与manifest
  → 客户端构建与服务端加载
```

`resources/` 与原始参考包可能在本地而未随仓库发布。缺少实际源包时列为构建输入缺失；不要重新下载同包或编造资源。

不允许只编辑压缩后的 `shared/gameplay.json`：重新装配会覆盖，而且前后端派生内容可能失配。内容改动应能从现有源与适配器再生。

### 7.2 版本号之外增加内容指纹

目前协议常量可读为 `protocolVersion=13`、`contentVersion=tms273-9`，但这两个标签不是某次构建的唯一摘要。[R11]

建议记录：

```text
sourceGameVersion = TMS273.7
sourceQuestDigest
chapterAdapterDigest
gameplayDigest / mapCatalogDigest
serverBuildId / clientBuildId
ruleVersion
```

优先写本地启动日志/构建信息；若扩展health，返回不可逆摘要及公开版本即可，不能暴露用户目录、数据库路径、账号信息。新增检查须与现有启动检查整合，失败时保持原有在线实例不动。

**本轮仅写计划，不触发重启。** 实施后的运行加载按现有 `PLAN.md` 约定，待用户批准时机再使用统一入口。HMR/开发模式统一入口是另一个已有任务，不绑成本修复的前置重构。[R01][R10]

---

## 8. 定向验证与用户实玩

遵守当前项目政策：实现者只运行与实际变更有关的编译和必要定向自检；不恢复独立QA、不反复全量验收、不为测试中断用户在线实例。以下是覆盖矩阵，**不是要求每次重跑全部场景**。[R02]

### 8.1 最小新增失败场景

优先增加能够在修复前失败、修复后通过的检查：

| 编号 | 场景 | 预期 |
|---|---|---|
| G01 | 36307完成、5级、没有可进行支线 | 服务端给等待10级的下一章引导；追踪区域不消失 |
| G02 | 9级升10级，角色没有重新登录 | 1402从等待变为可进行；任务与NPC菜单条件一致 |
| G03 | 10级新手从港口继续 | 引导指向原汉斯及真实可达路径，不指回快捷转职替代主线 |
| G04 | 已有法师职业但1402未完成 | 可以补剧情，职业/SP/技能/MP权益不被重发或重置 |
| G05 | 1402前置缺失，或不在原汉斯图书馆 | 实际结算拒绝，状态和资产不变 |
| G06 | 36337只完成一个合法分支；再测一个也没完成 | 前者按OR通过，后者仍拒绝 |
| G07 | 背包数量满足但complete条件未满足 | 任务标签、菜单和实际提交一致，不显示假“可交付” |
| G08 | 同模板NPC存在多个放置/有阶段隐藏 | 推荐目标是当前合法实例，不指向不可见副本 |
| G09 | 下一任务定义存在但executable关闭/地图缺失 | 显示内容不可用；不先发奖、扣物或假完成 |
| G10 | 主线与多条可交付支线同时存在 | 主线推荐稳定，不由名称字典序抢占；支线仍可访问 |
| G11 | 36310发信时背包满；重试成功后再重复请求 | 首次完全回滚，成功后不重复发信 |
| G12 | 36313帽子在背包/已穿戴/缺失 | 只有已穿戴满足目标；已有帽子不重发 |
| G13 | 完成36314后 | 显示已核定后继或内容边界，不宣称全主线结束 |
| G14 | 提交成功但回执丢失、随后重连 | 加载同一已提交事实；不重复奖励/转职 |
| G15 | 前后端内容指纹不同 | 明确诊断版本不一致，不误判为NPC缺失 |
| G16 | 原有港口商店、快捷转职、旧支线 | 本次相关改动不回退这些已有行为 |

### 8.2 现有测试的正确用途

`continuation_story_1402_through_36314_uses_real_menus` 可继续验证当前法师适配的菜单、材料、转职与提交；`continuation_branch_36337_accepts_any_route_checkpoint` 可验证OR语义。[R08]

它们预置状态并直接放置角色，因此新增覆盖要明确补两种不同证据：

- **开发者定向测试：** 对真实 `World::quest_entry / quest_log_entries` 与新增章节投影，验证5级等待、升10级刷新、目标选择和条件一致性。小型离线地图关系检查验证目标依赖，不能把静态图可达等同于用户已实玩通过。
- **用户实玩：** 从现有角色或经用户同意的新角色，经统一服务正常到港，按照界面提示完成下一步；不使用GM传送、测试坐标摆放或预写完成任务。

### 8.3 已确认存在的命令

以下是实施阶段按改动选择的命令；**本轮没有执行**：

```bash
# 工作区只读核对
 git rev-parse HEAD
 git status --short

# 后端只执行与实际修改相关的定向测试
 cargo test --manifest-path server/Cargo.toml --locked \
   continuation_story_1402_through_36314_uses_real_menus

 cargo test --manifest-path server/Cargo.toml --locked \
   continuation_branch_36337_accepts_any_route_checkpoint

# 客户端真实脚本名
 npm --prefix client run typecheck
 npm --prefix client run build

# 仅在批准的运行加载时机使用；不是本轮研究操作
 ./启动3010.command
```

测试源码依赖真实资源目录时，先确认输入齐全。执行结果记录“通过/失败/因输入缺失未执行”，不把没有跑到的测试列为通过。已经通过且本次未触及的检查不无差别重跑。

启动入口内部已有 `scripts/check_tms273_runtime.cjs`，不要另加一套独立在线探针；内容侧新增断言整合到现有检查，或按专题单次运行。

---

## 9. 可直接使用的只读盘点脚本

在真实仓库根目录执行。只读取源码派生产物，向标准输出打印；不连接3010、不读写用户数据库、不装配资源。

```bash
node <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`无法读取 ${file}: ${error.message}`);
  }
}
function digest(file) {
  return crypto.createHash('sha256')
    .update(fs.readFileSync(file)).digest('hex');
}

try {
  const file = 'shared/gameplay.json';
  const game = readJson(file);
  if (!Array.isArray(game.quests)) throw new Error('gameplay.quests不是数组');
  const byId = new Map();
  for (const q of game.quests) {
    const id = String(q.questId);
    if (byId.has(id)) throw new Error(`任务主键重复: ${id}`);
    byId.set(id, q);
  }
  const chain = ['36306','36307','1402','36337',
    '36308','36309','36310','36311','36312','36313','36314'];
  const inspect = id => {
    const q = byId.get(id);
    if (!q) return { questId: id, present: false };
    return {
      questId: id,
      present: true,
      name: q.name,
      executableField: q.executable ?? null,
      ruleVersion: q.ruleVersion ?? null,
      start: q.start ?? null,
      complete: q.complete ?? null,
      returnMapId: q.returnMapId ?? null,
      startItems: q.startItems ?? [],
      reward: q.reward ?? null,
      executionEvidence: q.executionEvidence ?? null,
    };
  };
  const opening = ['36301','36302','36303','36304','36306','36307'];
  let openingExp = 0;
  for (const id of opening) {
    const q = byId.get(id);
    if (!q) throw new Error(`开场任务缺失: ${id}`);
    const exp = q.reward?.exp;
    if (!Number.isSafeInteger(exp) || exp < 0) {
      throw new Error(`任务经验字段无效: ${id}`);
    }
    openingExp += exp;
  }
  // 仅演示“1级0经验，只取得这些奖励”的模型，不代表实际角色。
  const table = game.expTable;
  if (!Array.isArray(table) || table.length < 10) {
    throw new Error('经验表缺失或不足10级');
  }
  let modelLevel = 1;
  let remaining = openingExp;
  while (modelLevel < table.length) {
    const need = table[modelLevel - 1];
    if (!Number.isSafeInteger(need) || need <= 0) break;
    if (remaining < need) break;
    remaining -= need;
    modelLevel += 1;
  }
  console.log(JSON.stringify({
    sourceContentVersion: game.sourceContentVersion ?? null,
    contentVersion: game.contentVersion ?? null,
    gameplaySha256: digest(file),
    questCount: game.quests.length,
    chain: chain.map(inspect),
    // 仅列存在性，不能从存在推断本版可接取或真实顺序。
    laterCandidates: ['36315','36316','36317','36318',
      '36319','36320','36321'].map(inspect),
    openingModel: {
      assumption: '从1级0经验，仅领取上述六项奖励；没有额外战斗/道具经验',
      rewardExp: openingExp,
      resultingLevel: modelLevel,
      remainingExp: remaining,
      quest1402MinimumLevel: byId.get('1402')?.start?.conditions?.levelAtLeast,
    },
  }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
NODE
```

注意：`executableField` 是原字段，不代替 Rust `QuestSpec::executable()` 的完整判断。后续诊断必须沿实际运行规则求值，不能让脚本产生第二套任务真相。

---

## 10. 最终完成定义

### 港口接续修复完成

- 现有用户角色的真实断点已通过状态、条件、目标与构建信息定位。
- 36307后不再因等级等待而让主线提示消失；达到条件后能及时出现可执行入口。
- 新手按原版方向到图书馆完成1402，已有法师能补剧情且不重复获得转职权益。
- 36337至36314不是只在测试函数里成立，普通路线、NPC可见与点击、任务菜单和恢复均可说明并实玩。
- 当前UI的“可交付”与服务端业务校验一致；缺内容与缺角色条件可区分。
- 修改后的派生内容与运行实例能核对一致，用户旧档、在线服务和机器人未被研究/测试破坏。

### 后续章节补齐完成

- 按273.7有效关系确认章节范围，没有用编号连续性或其他版本攻略替代。
- 每个开放节点都有合法触发、目标依赖、结算、恢复、后继或章节结束提示。
- 同版事实、跨区参考、项目适配、未核定内容分别标记；不能将“可点完菜单”称为“原版演出1:1”。
- 交付分别列出已读取、已修改、实际检查通过、未测与用户待验，附可复现证据。

**一句话验收：玩家离开维多利亚港后，始终知道当前主线的下一步是什么；能做时真的做得了，不能做时知道真实原因，掉线和旧档也能继续。**

---

## 11. 给项目内开发代理的执行指令

```text
任务：修复TMS273.7冒险家法师路线在维多利亚港之后的主线接续，
并按同版原始数据分批补齐当前36314适配范围之后的内容。

先读AGENTS.md、BUSINESS_DEVELOPMENT.md、PLAN.md。
保留未提交修改、现有273数据库、在线3010与陪测机器人。
先在PLAN.md登记范围/所有权/依赖/验收，不重复建立新进度台账。
本方案基于1fefe97；先核对本地HEAD与相关文件，禁止reset覆盖。

首先只读取证：用户角色level/job/map/36306/36307/1402/36337状态，
运行内容与构建指纹，以及最近questList和NPC菜单。
不要假定当前角色与测试夹具一样已10级且36307完成。

当前已有scripts/tms273_chapter.cjs::applyContinuation、
World::quest_prerequisites_match、apply_quest_effect_at、
Store::commit_quest及1402一转/旧法师恢复，不从零重复开发。

重点复现：
1. 开场六任务450EXP与临时15*level^2曲线、1402十级门槛之间的断档；
2. quest_entry过滤未满足条件任务、客户端无候选时隐藏追踪器；
3. 36307返回岔道入口与真正图书馆后继的区分；
4. 目标NPC可见、可达与真实门户路线，而不是测试chapter_place；
5. sourceCheck字段保留但未完全执行的触发/record差异；
6. 同模板不同地图目标选错与旧构建/旧装配风险。

先补轻量服务端主线引导投影，不伪造任务active/completed。
低等级显示下一章与真实等待条件；内容缺失另列原因。
不要擅自降1402等级、给所有人升级、补完所有363xx或自动发奖。
保留已有用户授权快捷转职，但不拿它代替原版剧情事实。

新增内容以references/tms273-data中的273.7原始QuestData为主，
核对原始路径/哈希/QuestOrOption/autoStart/selfStart/fieldEnter/
infoNumber/infoex/脚本/地图/物品/奖励。网页当前版本只作线索。
修改导出/装配源后再生成产物，不手改压缩JSON掩盖问题。
不要用缺失脚本即成功、编号+1、任意传送补齐主线。

36314之后先核验36315—36321及真实依赖，不预设全部启用或线性顺序。
按完整章节切片实施：入口→目标→结算→恢复→下一章/等级等待。
保留T/R/P/U/X标注，不冒称原版脚本或数值已全部还原。

只执行本次改动必要的编译和定向自检，不恢复独立QA、
不为测试重启用户服务；运行加载在批准时机仅用启动3010.command。
区分现有菜单测试、离线路线检查和用户实玩，不虚构通过。
最终交付具体文件/函数、断点证据、变更、真实检查结果及未完成范围。
```

---

## 12. 来源索引

所有仓库链接固定到分析提交；源码是实现证据，文件中的历史“已完成”文字不替代本轮运行验收。

- **[R01] 工作规则与当前计划**：`AGENTS.md`、`PLAN.md`。  
  `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/AGENTS.md`  
  `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/PLAN.md`
- **[R02] 长期业务与验收规范**：`BUSINESS_DEVELOPMENT.md`。  
  `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/BUSINESS_DEVELOPMENT.md`
- **[R03] 实际开场和续章装配**：`scripts/tms273_chapter.cjs`，约14—57、110—215行。  
  `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/scripts/tms273_chapter.cjs`
- **[R04] 运行时任务判断、展示与提交**：`server/src/quest.rs`，约43—84、225—237、442—608、864—1265行。  
  `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/server/src/quest.rs`
- **[R05] 实际任务事务与转职守卫**：`server/src/auth/quests.rs`，约43—161行。  
  `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/server/src/auth/quests.rs`
- **[R06] 经验、快捷转职与派生产物装配**：`scripts/assemble_tms273.cjs`。  
  `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/scripts/assemble_tms273.cjs`
- **[R07] 客户端任务列表与追踪器**：`client/src/features/quest/log.ts`，约189—260行。  
  `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/client/src/features/quest/log.ts`
- **[R08] 续章菜单测试及其夹具边界**：`server/src/continuation_acceptance.rs`，约1—58、125—197、199—237行。  
  `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/server/src/continuation_acceptance.rs`
- **[R09] 同版原始任务记录与哈希**：`references/tms273-data/adventurer-continuation-source.json`，本轮直接读取开头200行，含1402和36337开头；后续范围实施时继续读取完整记录。  
  `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/references/tms273-data/adventurer-continuation-source.json`
- **[R10] 实际启动与加载**：`启动3010.command`、`server/src/main.rs`、`scripts/check_tms273_runtime.cjs`。  
  `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/启动3010.command`  
  `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/server/src/main.rs`  
  `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/scripts/check_tms273_runtime.cjs`
- **[R11] 协议版本与真实客户端命令**：`server/src/protocol.rs`、`client/package.json`。  
  `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/server/src/protocol.rs`  
  `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/client/package.json`
- **[W01] 仓库已引用的跨区官方结构参考**：MapleSEA，Ascend v217，2022-09-21。仅属R，不提供TMS273.7脚本。  
  `https://www.maplesea.com/updates/view/v217_Patch_Notes_3/`

### 本轮验证边界

已完成：读取仓库与上述核心源码、装配器、同版记录片段、当前规范及测试代码；对比线上加载路径；计算并提出可复现的等级断档场景；制定具体修复与后续章节计划。

未完成：读取用户实际角色存档、复现用户3010实例、完整解析全部273.7任务库、执行Rust/前端测试、修改代码、装配素材、验证原版脚本演出。这些均未在本文件中计为“已修复”或“已通过”。
