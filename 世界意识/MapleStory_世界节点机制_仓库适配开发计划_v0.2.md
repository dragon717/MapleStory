# 冒险岛复刻｜世界节点机制
## 《风铃桥》仓库适配设计与开发计划 v0.2

> 编制日期：2026-09-12  
> 仓库：`dragon717/MapleStory`，核查分支 `main`  
> 固定源码基线：`1fefe97c2d27a928f3bf670b657d79f68d795fe9`  
> 内容性质：**P——用户授权的原创玩法提案**；不是 TMS273.7 原作任务或机制。  
> 交付范围：只读源码核查、设计决策、文件级实施规格与验收方案。**本轮未修改仓库、未编译项目、未运行游戏、未重启 3010、未变更数据库或陪测机器人。**  
> 文档定位：本文件是世界节点的专题规格，不是第四份执行台账。当前任务登记仍在 `PLAN.md`；完成证据仍进入 `IMPLEMENTATION_STATUS.md`。

---

## 0. 决策摘要：先让这条路真实地活过来

保留上一版的目标：**玩家帮助了一个具体的地方，这个地方发生持久变化，后来的人也能使用成果；亲历这件事的人记得玩家，但世界不会因此欠玩家一座奖杯。**

本次不把原计划直接翻译成一套新框架，而是接入现有工程：

```text
现有 WebSocket 意图
  → 已认证的 Command::Input
  → 现有 World 单一权威顺序处理
  → 世界节点规则计算
  → 现有 auth::Store / SQLite 原子提交
  → World 应用已提交结果
  → 现有地图 snapshot + 私有交互回执
  → 现有 Phaser Scene 中的节点表现
```

首个完整闭环：

```text
路边有限材料 → 玩家交接 / NPC 慢慢搬运 → 工匠分段安装
                                      ↓
断桥捷径恢复通行 ← 服务端启用真实地面
          ↓
同一辆已扶正的货车过桥 → 同一批货抵达 → 棚下出现停留者
          ↓
玩家再来：桥仍然能走，遇见的人记得实际发生过的帮助
```

本版的六项决定：

| 决定 | 本仓库的落法 |
|---|---|
| 不增加世界权威服务 | 沿用 `World`、现有命令队列与 50 ms 模拟步长；不引入 Actor 框架、ECS、微服务或消息中间件 |
| 不换渲染器 | 使用 **Phaser 3.90.0 + TypeScript + Vite**；本功能不引入 Three.js 或第二套角色物理 |
| 不把永久桥梁做成普通 Reactor | Reactor 的交互与美术可作参考，节点事实另行持久化；普通 Reactor 的重生规则保持不变 |
| 不另建数据库 | 节点、操作回执、公共历史和人物记忆写入现有 `auth::Store` 所连接的 SQLite |
| 不先做跨服 | 首版公共范围是同一权威 World 与其持久化世界；跨频道、跨进程聚合另立后续决策 |
| 不靠完整供给经济证明体验 | 先做现场材料交接、扶车、施工、通行、一次运输与重逢；背包捐赠和其他玩法逐项后接 |

以上技术选择来自实际入口、依赖、状态与存储代码，而不是旧架构草案。[R02][R03][R04][R05][R06]

---

## 1. 核查边界与证据规则

### 1.1 已核查什么

已读取仓库工作规范与当前计划，并核查启动组装、`World` 状态与初始化、网络认证和命令投递、SQLite Store 与建表入口、背包事务、NPC 对话、共享协议、Phaser 场景和 NPC 呈现、客户端连接、启动脚本、资源校验脚本以及仓库保存的历史检查记录。具体路径和代码范围见第 20 节。

核查过程中已固定提交 SHA；下文“现有”均指该提交。若实施时 `main` 前进，应先比对相关文件，不把本文行号当作永久 API。

### 1.2 没有验证什么

没有访问用户正在运行的程序，没有执行构建或测试，没有亲自查看地图美术、节点素材、碰撞实机表现，也没有证明任意地图已经适合摆放风铃桥。远程代码搜索出现错误，未据此把“搜不到”写成“全仓库不存在”。关于尚未实现能力的判断限定在已读的入口、协议和模块范围内。

特别注意：`artifacts/refactor/baseline-metrics.json` 是**仓库内他次执行的记录**，不构成本轮通过证据；旧文档中的模块目录和版本标签不优先于当前源码。[R01][R16]

### 1.3 文件标记

后文明确区分：

- **现有文件**：已通过仓库内容或已读取的规范确认的路径。
- **拟新增文件 / 类型 / 函数**：实施方案中的命名，不声称仓库已有。
- **待核定内容**：地图落点、资源地址、工作姿态、数值等，必须在对应阶段取得证据，不填成原作事实。

本次修改了实现方式，没有修改玩家价值：**公共成果真实、个人记忆准确、选择自由、允许离开。**

---

## 2. 源码结论：上一版需要怎样修正

| 已核实的工程事实 | 对世界节点计划的影响 | 证据 |
|---|---|---|
| `main.rs` 建立 `mpsc::channel(1024)`，组装一个 World，并启动 `world::run` | 新节点命令进入同一队列；不再创建第二个写世界的循环 | R02 |
| `World` 有 `map`、`maps`、玩家、怪物、NPC、Reactor、Store 等字段 | 新增一个节点状态集合，不能另外复制玩家 / 背包 / 地图权威 | R03 |
| `World.map` 和 `World.maps` 的初始化涉及地图克隆 | 动态桥梁必须审核所有有效几何读取路径，不能只改其中一份 Map | R03 |
| 地面逻辑读取 foothold 的 `prev/next`、边界及邻接连续性 | “桥好了”必须更新完整有效地面关系，不能只贴一张桥图 | R07 |
| Reactor 明确是会话级事实，重启可以重置 | 公共桥梁不能继承 Reactor 的存储与重生语义 | R03 |
| Boss 练习图是每角色的运行时实例 | 不能用练习实例冒充跨玩家、跨重启的公共设施 | R03 |
| `Store` 是 `Arc<Mutex<Connection>>`；`auth/schema.rs` 是建表入口；已拆出 `auth/bag.rs` 等 | 新持久化逻辑放在已有 `auth/` 下，同库同事务；不新建 PostgreSQL / MySQL / 世界数据库 | R05、R06 |
| `ClientMessage` 和 `snapshot` 已包含地图、NPC、Reactor 等 | 首版扩展既有协议与快照，不先建立独立订阅平台 | R08 |
| `client/package.json` 的运行时是 Phaser 3.90.0 | 沿用已有视图类和 Scene 生命周期；不能按 Three.js 项目安排工单 | R04、R09 |
| `NpcView` 当前只播放 `stand` | 坐标同步能复用，但走路、扶车、施工动作并非现成能力 | R10 |
| `handle_npc_talk` 校验地图、距离，并调用 `quest_npc_visible` | 节点 NPC 要保持公共可见，不把设施阶段接到个人任务可见性 | R11 |
| 网络断开通常投递 `Detach`，角色可以继续驻留 | “角色仍在地图上”不等于“玩家仍在施工”；协作要单独终止 | R12 |
| 启动脚本先构建，随后关闭并重启 3010 | 脚本不是无副作用检查命令；不能为本计划擅自运行 | R13 |
| 资源校验固定核对 44 张地图，并依赖本地 273 原始数据 | 首版优先现有地图上的 P 覆盖层，不随意新增第 45 张图或改掉断言 | R14 |

**与旧版相比，取消“先上完整 Outbox / 事件总线”的首版硬前置。** 本阶段采用“持久事实 + 持久操作回执 + 当前全量快照恢复”。一次性画面演出可以漏掉，但桥的现实、贡献记录和 NPC 记忆不能漏掉。未来确有跨服务必达副作用时，再设计 Outbox 与消费者幂等。

---

## 3. 体验范围：一张图，一个节点，一次真正的恢复

### 3.1 节点、设施、人物与事件

“节点”是区域中一组关联能力的恢复单元；“桥”是第一项设施；“货车侧倾”是独立但相关的实际阻碍；“修桥匠”和“送货者”是有稳定身份的人。不要将它们压成 `nodeLevel = 3`。

灯塔、古树、圣泉以后可以复用提交、记忆与展示管线，但恢复的能力不同：辨路、遮蔽、水源、通行。**共享技术边界，不强求共享一条贡献经验公式。**

### 3.2 第一张图的选择

首选在**已装配地图的非主线必经局部**放置原创设施覆盖层，保留原有绕行路、传送、任务 NPC 和练级空间。已读取的地图目录含 `104010000`，可列为候选；本轮仅确认 ID 在目录中，**未确认它的视觉布局适合断桥，也不指定未经验证的坐标**。[R15]

P0 必须交付 `placement` 记录：最终 `mapId`、可达绕行线、施工交互点、桥两端 foothold、捷径几何、货车起终点、图层遮挡和素材来源。若候选没有安全摆放空间，改选同目录地图；不得为坚持名字而切断原始主线。新测试地图只有在另行核准地图目录与装配变更后才采用。

### 3.3 三幕世界变化

| 阶段 | 玩家看到的事 | 背后的真实事实 |
|---|---|---|
| 恢复前 | 桥缺段，材料在岸边，工匠整理工具，货车侧倾；仍可绕行 | 捷径未启用；现场材料有限；车未恢复；送货目的地存在 |
| 恢复中 | 材料被交到施工点，工匠安装一段；玩家帮忙扶起货车 | 材料从来源转到施工库存，再进入安装作业；车辆状态单次改变 |
| 恢复后 | 桥能走，同一辆车驶过并卸货，棚下有人停留 | 地面已启用；运输实体抵达；货物交付后满足停留条件 |

部分桥板安装首先表现施工进度；**首版不开放逐块桥板攀跳**，完整安全验收后才启用整条捷径。这是范围控制，不把没有碰撞的施工板伪装成已经可走的地面。

### 3.4 首版的玩家动作

必做两个入口：**交接现场材料**、**扶正货车**。均是可读、可取消、短时的主动交互，由服务端完成判定。

材料入口首版使用岸边有限材料箱与相邻交接位。玩家完成一次交接后，来源库存减少、施工库存增加。先不做跨图负重、背包生产或完整手持运输物理；只有正式实现“取走—携带—交付”后，才能在文案里称为长距离搬运。

原型可从交接约 2 秒、扶车约 3 秒、安装每段约 8 秒起测。这些是 **P 类游戏参数建议**，不是已测最优值，不是开发工期。可取消不扣稀缺背包物品；已完成的交接不因随后离开而失效。

### 3.5 自由与公共性

甲先交一份材料便离开；乙后来继续施工；丙从未贡献，直接走过修好的桥。甲的贡献保留，乙不会被说成独自完成全桥，丙不被追收劳动或通行资格。

不设首次建成贡献榜、贡献门票、强制职业组合、每日维护打卡、无人上线自动塌桥。一个人也能慢慢推进；多人能够接续，而不是必须凑足若干账号。

无人帮助时，工匠与送货者按已知资源和既定计划缓慢自救。玩家缩短等待、解决具体问题，并被知情者记住；不是世界唯一能办事的人。基础桥梁建成后不需要无限重建来“给后来者发任务”。

---

## 4. “我的世界”与“我们的世界”的工程边界

### 4.1 一份公共现实，多个个人经历

| 对象 | 首版所有者 / 作用域 | 是否可以因玩家不同 |
|---|---|---|
| 桥是否能走、材料还剩多少、货车在哪里 | `World` 中该公共地图的节点状态 | 不可以 |
| 同一公共 NPC 是否存在、怪物是否阻路 | 当前地图的权威实体与能力条件 | 不可以 |
| NPC 是否认识我、感谢哪件事 | 该 NPC 对该角色的持久记忆 | 可以 |
| 我是否见过修桥前的样子 | 个人见闻，首版可不单独开发日志 UI | 可以 |
| 公共浓雾 / 光照造成的游戏规则 | 公共事实 | 不可以 |
| 个人探索迷雾 / 尚未读过的故事 | 私有认知 | 可以 |

现有个人任务 NPC 逻辑不自动成为本节点的实现方式。新增节点 NPC 走公共存在判定；记忆仅影响与本人交谈时的表达，不影响另一位玩家的桥或可交互实体。[R11]

用户描述的“只有我修好的一座桥、只有我看到的一群可战斗怪物”属于**显式的个人 / 小队实例**。该方向保留，但不与首版公共图叠在相同物理坐标上。已有 Boss 练习实例仅可研究其隔离方式，不能直接继承其重启回收语义。[R03]

### 4.2 公共范围的首版定义

首版：**一个权威 World + 一份绑定的持久化世界 + 该世界中的目标地图。** 当前已读入口没有可据此宣称“多个频道服务共享节点进度”的聚合实现。[R02][R03]

新增持久 `worldScopeId`，在现有数据库首次启用节点时创建并保存；正常重启不能重新生成。节点使用稳定 `nodeId` 和绑定的 `mapId`。不同服务进程不得同时把各自内存当成同一节点的权威；复制数据库建立测试世界时，不连接生产玩家或广播域。

后续真正跨频道须先回答：节点只有一个写入者吗、更新怎样抵达各频道、换频道怎样读取版本、关闭某频道是否影响施工。不能仅把 `channelId` 加进表，就声称实现了全服协作。

### 4.3 两种时间身份

拟新增 `worldEpoch`：每次进程启动生成，用来识别快照所属运行实例，避免比较已经重置的 `serverTick`。

拟新增 `nodeEpoch`：节点历史代际，持久化保存，正常重启不变。只有明确授权的新历史才创建新代际；首版不提供玩家或普通 GM 的一键重置入口。

`revision` 只表示节点已提交事实的版本。不能把登录次数、动画帧数或 `serverTick` 当作永久版本。

---

## 5. 最小模块边界与具体落点

### 5.1 总体结构

```text
main.rs                                      [现有：组装]
  ├─ node_model.rs                            [拟新增：定义、事实、纯规则]
  ├─ auth.rs / auth::Store                    [现有：持久化所有者]
  │    ├─ auth/schema.rs                      [现有：追加节点建表入口]
  │    └─ auth/world_nodes.rs                 [拟新增：节点事务与恢复]
  └─ world.rs                                 [现有：唯一模拟拥有者]
       ├─ world_nodes.rs                     [拟新增：节点意图、作业、快照投影]
       └─ node_geometry.rs                   [P2 拟新增：有效地面组合]

shared/protocol.ts + server/src/protocol.rs   [现有：共同契约]
client/src/app/main.ts                       [现有：输入、网络与场景接线]
client/src/scenes/world.ts                   [现有：挂载、快照、更新、清理]
client/src/features/world/
  ├─ node-model.ts                           [拟新增：解码、版本与视图数据]
  ├─ node-view.ts                            [拟新增：Phaser 节点表现]
  └─ node.check.ts                           [拟新增：无浏览器状态检查]
```

`world_nodes.rs`、`node_geometry.rs` 按当前工程使用 `#[path = "..."] mod ...;` 作为 `world` 的子模块；不是新的世界服务。`auth/world_nodes.rs` 则沿用已经存在的 `auth/` 拆分方式。不要按旧草图再建 `server/src/world/`、`persistence/`、`content/` 空目录。[R17][R05]

### 5.2 状态与依赖

`node_model.rs` 只放可被 `world` 与 `auth` 共同使用的数据和纯函数，不导入 `World`、网络或数据库。可以定义 `NodeDefinition`、`NodeFacts`、`NodeActionKind`、`NodeCommit`。这些均是拟新增名称。

`World` 增加节点目录和运行时集合；短动作占用与当前连接令牌由 World 持有。`Store` 持有已提交事实、操作回执、历史、记忆。客户端只持有视图数据和待确认请求，不持有公共进度权威。

`world_nodes.rs` 负责“当前能不能做、把什么交给事务、提交后怎样进入世界”；`auth/world_nodes.rs` 负责“怎样在一个事务里不重扣、不丢事实”；`node_geometry.rs` 负责“已提交通行能力怎样成为现有 Map 使用的几何”。不把 SQL、动画或所有 NPC 行为塞进一个模块。

### 5.3 文件级改动矩阵

| 文件 | 类型 | 本功能具体改动 | 明确不做 |
|---|---|---|---|
| `server/src/main.rs` | 现有 | 显式加载并校验节点配置，绑定 Store，World 启动前恢复节点 | 第二个世界 task、改默认端口 |
| `server/src/world.rs` | 现有 | 注册子模块、增加状态、输入分派、到期作业调用、快照字段、生命周期钩子 | 再内联几千行节点规则；全项目重构 |
| `server/src/node_model.rs` | 拟新增 | 静态定义、事实、守恒与阶段推导 | IO、计费、NPC 大脑框架 |
| `server/src/world_nodes.rs` | 拟新增 | 意图处理、短动作、施工 / 运输推进、公共投影 | 私有世界替换公共碰撞 |
| `server/src/node_geometry.rs` | P2 拟新增 | 从基础 Map 与节点事实构造有效地面 | 第二套角色物理、修改原始 WZ |
| `server/src/auth.rs` | 现有 | 注册 `auth/world_nodes.rs`，按需导出最小 DTO | 搬迁整份 Store、另开节点数据库 |
| `server/src/auth/schema.rs` | 现有 | 调用节点建表 / 版本迁移 | 清库、重建玩家存档 |
| `server/src/auth/world_nodes.rs` | 拟新增 | 加载、幂等、节点提交、记忆读取、未完成动作恢复 | 每 50 ms 全量落库 |
| `server/src/dialogue.rs` | 现有 | 在已验证 NPC / 地图 / 距离后接入节点记忆回复 | 改原任务、转职、商店意义 |
| `server/src/protocol.rs`、`shared/protocol.ts` | 现有 | 同步新增消息与字段、严格校验、版本协调 | 只改 TS 类型、不改 Rust 反序列化 |
| `client/src/app/main.ts` | 现有 | 按现有回调方式连接节点意图、回执、场景 | 全局网络单例渗入视图 |
| `client/src/scenes/world.ts` | 现有 | 挂载与清理 NodeView，分发快照和交互 | 在 Scene 内结算施工或资源 |
| `client/src/features/world/node-*.ts` | 拟新增 | 状态检查、版本处理、Phaser 表现 | 引入 Three.js 或替换 Phaser |
| `client/src/assets/manifest.ts` | 现有 | 必要的节点美术描述类型和运行时验证 | 声称已有走路 / 施工资源 |
| `shared/world-nodes.json` | 拟新增 | P 节点目录、位置、配方、路段与规则 | 在此保存玩家进度 |
| `scripts/check_world_nodes.cjs` | 拟新增 | 配置、资源、几何引用及协议接线的定向校验 | 用测试文件字面量证明生产实现 |
| `scripts/assemble_world_nodes.cjs` | 按实际装配需要新增 | 把已核定覆盖层装入客户端资源输出 | 手改生成后的原作目录冒充来源 |
| `bots/run.mjs` | 现有 | 如有契约依赖则同步；保持 demo 行为 | 擅自重启现有 bot、自动贡献材料 |

节点事务与场景文件由不同实施者负责可以并行；`world.rs`、协议、`main.ts` 和 manifest 由一个整合负责人协调修改。依赖未定前不制造空模块或平行提交冲突。

---

## 6. 保存事实，而不是保存一个万能进度条

### 6.1 最小事实

| 事实 | 建议字段意义 |
|---|---|
| 来源材料 | 各来源箱中剩余木料 / 绳索等，单位明确、数量非负 |
| 施工材料 | 已交接可用量、当前作业预留量 |
| 已安装部件 | 稳定部件 ID 集合；每件使用的配方版本固定 |
| 桥梁通行 | 未启用 / 待安全启用 / 已启用，附有效几何版本 |
| 货车 | 稳定实体 ID、侧倾或直立、货物是否固定 |
| 货单 | 稳定货单与货物批次 ID、起终点、待发 / 在途 / 已到货 |
| 工匠计划 | 当前作业 ID、类型、开始与到期时间、下一行动 |
| 停留条件 | 已到货 / 棚架可用等真实条件，不存“玩家完成庆典” |

`broken / working / connected / inhabited` 等阶段是表达标签，由这些事实推导。可以随快照发送阶段，但不让阶段和事实成为两个分别可写的权威。

### 6.2 一个原型配方

建议原型共有 4 份木料、2 份绳索，分两次安装；每次实际使用 2 份木料和 1 份绳索。施工时从可用库存转为预留，完成后转成已安装部件。这只是方便检查的 P 配方。

对每种材料验算：

```text
初始总量 + 已提交的外部投入
  = 来源箱剩余 + 施工可用 + 作业预留 + 已安装材料当量
```

取消玩家交接：未完成不移交；取消已启动施工：首版不提供玩家取消按钮；内部失败保留预留与作业身份，不能重复领料。建成后来源箱或库存仍有剩余就真实留下，不为了画面整洁吞掉，也不继续接受没有用途的捐赠。

### 6.3 行为、工作、记忆各是什么

玩家操作回答“谁尝试做什么”；作业回答“谁正在用哪些条件完成什么”；贡献回答“哪次已提交变化由谁促成”；记忆回答“哪个 NPC 通过什么来源知道了这件事”。四者不要混成一个好感值。

只记录真实效力。两个人同时扶同一辆车时，只能发生一次 `tilted → upright`；未成立的人得到“车已经扶稳了”，不获得虚构扶车贡献。后续需要多人合力时，再建有明确分工与归因的共同作业。

---
## 7. 持久化：沿用同一个 Store，建立最小原子边界

### 7.1 存在哪里

使用当前 `ACCOUNT_DB` 所绑定的 Store；默认是 `server/data/tms273.sqlite3`。节点表通过现有 `auth/schema.rs::Store::init` 接入。新增操作方法放到拟新增的 `auth/world_nodes.rs`。[R02][R05][R06]

当前 Store 使用同步 `Mutex<Connection>`，不能把本文写成“现有异步存储队列已经解决所有阻塞”。首版采取小事务、低频里程碑写入和明确的动作频控；测量写入耗时后再决定是否有必要演进存储调度。不要在节点动作中阻塞等动画，也不要持锁跨 `.await`。

### 7.2 首版五类记录

| 表名（拟新增） | 主体和关键字段 | 用途 |
|---|---|---|
| `world_node_meta` | 固定 `world_scope_id`、节点存储 schema 版本 | 正常启动恢复同一公共世界 |
| `world_node_state` | scope、node、nodeEpoch、mapId、definitionVersion、revision、factsJson、updatedAtMs | 当前事实；施工 / 运输计划包含在有版本的事实中 |
| `world_node_actions` | scope、node、nodeEpoch、actorKey、requestId、payloadFingerprint、status、outcomeJson | 玩家动作的持久幂等与回执恢复 |
| `world_node_events` | eventId、节点身份、revision、kind、actorKey、事实差异、发生时间 | 已提交变化的来源与公共历史，不承担每帧消息队列职责 |
| `world_node_memories` | NPC 稳定实例 ID、角色 ID、来源 eventId、memoryKind、factsJson | 准确的个人回应，不广播给全部玩家 |

`actorKey` 由服务端生成，例如 `character:<verified-id>` 或 `system:<stable-job-id>`。客户端不提交行为人。现有 SQL 的 `account_id` 命名与角色归属需要沿认证代码核对；新记忆直接使用明确的 `character_id`，不要仅凭旧列名错误地把一个账号的所有角色混成同一个人。

### 7.3 建表规格示例

下面是拟新增表的约束示例，用于说明持久边界；不是声称已经合入的 migration。完整初始化、升级与 Rust 数据反序列化仍由实施工单完成。

```sql
CREATE TABLE IF NOT EXISTS world_node_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS world_node_state (
  world_scope_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  node_epoch TEXT NOT NULL,
  map_id TEXT NOT NULL,
  definition_version INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991),
  facts_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(world_scope_id, node_id),
  UNIQUE(world_scope_id, node_id, node_epoch)
);

CREATE TABLE IF NOT EXISTS world_node_actions (
  world_scope_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  node_epoch TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  request_id TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','succeeded','refused','interrupted')),
  outcome_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(world_scope_id, node_id, node_epoch, actor_key, request_id),
  FOREIGN KEY(world_scope_id, node_id, node_epoch)
    REFERENCES world_node_state(world_scope_id, node_id, node_epoch)
);

CREATE TABLE IF NOT EXISTS world_node_events (
  event_id TEXT PRIMARY KEY,
  world_scope_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  node_epoch TEXT NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  facts_delta_json TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  UNIQUE(world_scope_id, node_id, node_epoch, revision),
  FOREIGN KEY(world_scope_id, node_id, node_epoch)
    REFERENCES world_node_state(world_scope_id, node_id, node_epoch)
);

CREATE TABLE IF NOT EXISTS world_node_memories (
  event_id TEXT NOT NULL,
  npc_instance_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  memory_kind TEXT NOT NULL,
  facts_json TEXT NOT NULL,
  PRIMARY KEY(event_id, npc_instance_id, character_id, memory_kind),
  FOREIGN KEY(event_id) REFERENCES world_node_events(event_id)
);
```

每次事实提交生成一个包含必要差异的事件，故单节点单 revision 唯一；一次变化对应多条 NPC 记忆是合法的。首版不提供节点换代重置，因此保留现有节点行及引用；未来若要同时保存多代历史，需要显式迁移，不靠 `DELETE` 或 `INSERT OR REPLACE` 绕过约束。

### 7.4 一次提交必须同时成立

```text
节点事实变化
+ 对应 revision / 来源事件
+ 该动作终态回执
+ 直接知情 NPC 的记忆
= 一次 SQLite 事务
```

外部背包捐赠若在后续加入，则该事务再包含背包扣除与结果重读。SQLite 的事务支持一个数据库内的原子变更，但不允许把普通 `BEGIN` 任意嵌套；复用 Store 时应传递同一 transaction 内的辅助操作，而非再次调用一个会独立锁库、独立提交的公开方法。[E01]

提交时在同一事务内复核持久 revision，并以预期版本更新节点行；不匹配时拒绝覆盖、重载已提交事实，不能盲目重试旧差异。单一 World 顺序处理减少了竞争来源，但不是省略存储一致性检查的理由。

**禁止路径：先调用 `move_inventory` / 类似接口完成扣料，再调用另一个接口加节点进度。** 两次各自成功的事务不能构成这次玩法的一次原子提交；持锁再进入同一 Store 方法还可能形成重入锁问题。

### 7.5 提交后如何应用内存

事务返回 `NodeCommit`，包含已提交的新事实、版本、回执和必要的角色资源结果。World 在发送成功之前应用结果。公共通行投影也必须由这份结果导出，不用过期的预计算对象覆盖新事实。

若提交已经成功、随后内存投影失败：暂停该节点新动作，重载同一条已提交事实并恢复投影；不能把 SQLite “改回旧状态”当作默认补偿，也不能再次执行原操作。恢复无法完成时保留持久记录并报告故障，不静默展示为完好或未修复。

### 7.6 历史不是帧日志

只持久化交接、安装开始 / 完成、扶正、通行启用、出发 / 到货等改变意义的离散事实。人物移动中间帧、粒子和动画游标不每帧写库。

首版终态操作记录保持可重放；将来裁剪需定义请求有效期与过期拒绝，不能删掉幂等记录后让老包重新扣资源。角色删除不能级联抹掉公共桥梁；是否保留显示名另设隐私策略，公共历史可展示“某位旅人”。

---

## 8. 意图、短动作、幂等和故障恢复

### 8.1 拟新增的服务端入口

以下为建议名称，不是现有 API：

```text
World::handle_world_node_action(...)
World::step_world_nodes(...)
World::interrupt_world_node_action(...)
World::world_node_snapshot_for(...)

Store::load_world_nodes(...)
Store::prior_world_node_action(...)
Store::begin_world_node_action(...)
Store::commit_world_node_transition(...)
Store::interrupt_pending_world_node_actions(...)
```

节点命令仍由 `network.rs` 验证并投递。`world.rs` 当前的 `Command::Input` 会先校验认证角色与连接令牌；新分支必须放在这道边界内，不能另外接受客户端传来的角色 ID。[R12]

### 8.2 开始动作的顺序

1. 完成会话、连接令牌及消息结构检查；取服务器绑定的 scope 和角色。
2. 根据稳定节点身份查询该角色该 `requestId` 的持久记录。
3. 若存在且负载一致，返回原来的 pending / 终态回执；若同 ID 改了 action、target 等语义，拒绝 `request_conflict`。
4. 若是新动作，再检查功能是否开放、目标是否属于当前地图、角色存活与可交互状态、距离、资源、占用、频控。
5. 记录 pending；建立绑定当前 connection 的短动作占用，给出预计动作时长，但尚不宣布贡献成立。

重复请求先查回执，再做“现在是否仍站在原地”的新动作条件。否则一个成功后走开的玩家会在重试时被误报“距离太远”。查询只能返回该已认证角色自己的操作结果。

### 8.3 短动作完成

短动作不依赖浏览器动画回调。World 到期复核当前角色、连接、位置、存活、目标状态和资源；成立后在同一事务中做事实迁移与归因。

初版每角色只允许一个节点短动作，每个独占交接位 / 扶车点只允许一个占用。占用不是无限预留物资：未完成不扣库存；最终事务再次检查数量。到期失败则给确定终态，不循环扣料重试。

网络断开被服务端识别、显式退出、切图、死亡或控制权被替换后，结束相关占用。已完成贡献保持；未完成动作不在下次登录自动补成成功。一个玩家主动发起的有限短动作不等于可以无限续时的挂机劳动。

### 8.4 处理已有暂离机制

对现有 `Detach`、`Exit`、`Leave`、`Logout`、`Lifecycle` 和角色接管路径增加最小释放钩子，并检查 portal / warp 与死亡路径。不要只在 WebSocket close 回调里处理。[R12]

首版采用保守规则：识别为隐藏、暂离或连接脱离后，不再维持需要主动参与的节点动作；已提交的 NPC 自主施工继续。角色仍被别人看见，不等于还能持续贡献。也不能通过重复上报“回来了”绕过现有暂离接管逻辑。

### 8.5 四个必须覆盖的崩溃位置

| 故障位置 | 重启后应发生什么 |
|---|---|
| 已收到意图，但 pending 尚未提交 | 没有事实变化；重发可作为新尝试处理 |
| pending 已提交，动作未完成 | 终结为 interrupted；释放运行时占用，不补记劳动 |
| 完成事务已提交，尚未应用内存 / 发送回执 | 从数据库恢复新事实；同请求返回原成功结果，不再次改变世界 |
| 成功已被客户端看到，随后重启 | 节点状态、历史、NPC 记忆均保持；不重新断桥或翻车 |

Store 暂不可用、磁盘满等基础设施错误不能伪装为“玩家操作失败但世界已偷偷成功”。无法确定是否提交时，先按同 requestId 查询已持久结果，再决定后续响应。

---

## 9. 节点协议与快照：先复用，不先另造同步系统

### 9.1 当前版本与接线范围

已核查基线是 `PROTOCOL_VERSION = 13`、`CONTENT_VERSION = 'tms273-9'`。[R08]

下一个版本号由整合时分配，不把“必然就是 14”写死。Rust 枚举 / `valid()`、TS 联合类型、浏览器处理、必要的机器人契约和启动健康检查同步变更。节点资源目录的结构版本与全局 contentVersion 也须协调，不能只改一侧字符串。

### 9.2 消息形状建议

以下代码是协议设计片段，字段名均为拟新增；不是完整可直接替换的 `shared/protocol.ts`。

```ts
type WorldNodeAction = {
  type: 'worldNodeAction';
  requestId: string;
  nodeId: string;
  nodeEpoch: string; // 已收到的历史身份，只作匹配检查
  targetId: string;
  action: 'handoffMaterial' | 'rightCart';
};

type WorldNodeActionResult = {
  type: 'worldNodeActionResult';
  requestId: string;
  nodeId: string;
  nodeEpoch: string;
  status: 'pending' | 'succeeded' | 'refused' | 'interrupted';
  code: string;
  committedRevision?: number;
  eventId?: string;
  durationMs?: number;
};

type WorldNodeState = {
  nodeId: string;
  nodeEpoch: string;
  revision: number;
  stage: 'broken' | 'working' | 'connected' | 'inhabited';
  installedPartIds: string[];
  bridgePassable: boolean;
  geometryVersion: string;
  materialView: { sourceId: string; available: number }[];
  cart: {
    entityId: string;
    pose: 'tilted' | 'upright';
    phase: 'waiting' | 'inTransit' | 'arrived';
    x: number;
    y: number;
  };
  availableActions: {
    targetId: string;
    action: WorldNodeAction['action'];
    label: string;
  }[];
};
// 在现有 snapshot 添加 worldScopeId、worldEpoch 与本地图的 worldNodes。
// worldScopeId 由服务端给出；客户端不得用它选择另一个世界进行写入。
```

`availableActions` 是提示，不是授权；最终始终重新校验。`geometryVersion` 是节点有效几何的内容身份，状态 `revision` 则反映已提交的世界变化，两者不能混用。

如果角色要取消，新增独立 `worldNodeCancel`，携带原动作 ID 并检查当前连接；取消不能撤回已经提交的结果。回执恢复可直接重发原意图，或增加只读状态查询。首版协议冻结时二选一，默认采用**带相同 ID 与相同参数重发原意图**，不再增加一个通用 RPC 层。

### 9.3 输入防护

所有字符串都有字节上限；ID 格式与目录一致；枚举只接受声明值；数组有上限；数值有限且范围合法。客户端不传世界坐标、贡献数量、材料成本、桥完成比例、角色身份、NPC 记忆或到货结果。

重发不能生成新 requestId；同请求更换参数必须拒绝。网络现有入站包大小和每秒消息预算继续生效，并增加节点动作的独立小预算。**现有 2048 字节限制是入站 WebSocket 配置，不能误称为所有出站快照的总上限。**[R12]

### 9.4 当前快照与一次性演出分离

现有 `snapshot` 已包含地图及实体，并由客户端用于恢复连接状态。[R08][R18] 首版将本地图的紧凑 `worldNodes` 加入其中；节点不变时复用公共投影，货车坐标仍由服务器给出。

不把贡献全表、完整 NPC 记忆、所有地图节点或历史事件塞进每个 50 ms 快照。个人对话仍走私有 `npcResult`；历史查阅若以后需要，再提供分页只读入口。

初次进图或重连拿到的完整快照只建立当前现实，不播放“我刚刚完成了修桥”的庆祝。在线玩家观察到版本变化时可以播放相称演出；演出遗漏后靠当前状态恢复，不因补播把整辆车重新从起点开一遍。

### 9.5 版本规则

同一 `worldEpoch / mapId / nodeId / nodeEpoch` 下按安全整数 revision 处理，拒绝倒退。不同 worldEpoch 的首个合法快照建立新的运行基线；不能继续拿上次进程的 serverTick 比较。

重要：货车位置是连续呈现，同一个节点 revision 下也可能变化。**相同 revision 不代表整条快照可以丢弃**；结构事实依 revision 更新，运动数据依当前连接与 serverTick 更新。客户端不得仅用节点 revision 冻住行驶中的车。

离图清空旧图节点视图与未完成交互；连接已有的旧 socket 排除逻辑继续保留。未知结构、非有限坐标或不匹配的几何版本应禁用该节点交互并报告资源 / 协议错误，不默默画出一个可用的桥。[R18]

### 9.6 为什么首版不必先做消息必达平台

事实正确性由数据库与重连快照保证，操作结果由持久 requestId 回执保证；它们不要求每一个建桥粒子事件都可靠投递。输出队列满时不在 tick 中无限等待，也不声称客户端“已经收到”。必要时沿现有脱离 / 重连机制恢复。

若后续到货要影响另一个进程的商店库存，那是新的跨边界必达需求，届时加入 Outbox、消费者去重与对账；不能把首版“快照恢复状态”误当成已经解决跨服务事务。

---

## 10. 桥梁地面：这个功能最容易被低估的接入点

### 10.1 不在客户端制造第二份物理事实

现有角色坐标由 Rust 决定，Phaser 读取快照表现。桥梁通行必须进入 Rust 当前使用的 Map 地面逻辑；客户端显示修好的桥、服务端仍让玩家落下，不能算完成。[R07][R09]

### 10.2 基础地图与有效地图

保留原始 TMS 地图数据作为不可变来源。P 节点覆盖层描述额外桥段与必要的端点邻接；在加载和里程碑变化时构造**有效 Map**，而不是每 tick 重解析整张地图。

```text
已核定的基础 Map
  + 此地图已提交的节点能力 / 几何覆盖
  → 经过校验的有效 Map
  → 既有落地、水平移动、上下跳、梯绳、掉落与 NPC 路线读取
```

实施前逐一定位 `World.map`、`World.maps` 及初始化时地图克隆的读取者，确认目标图所有相关查询得到同一有效结果。首版允许在一个有明确入口的方法内一致更新已有缓存；不要求为这一张图全仓库更换 Map 类型。但**不能只更新集合中的 Map 而忘记出生图别名或已经派生的路线数据**。[R03]

### 10.3 几何校验

必须验证新增 foothold ID 与原图不冲突、`prev/next` 存在且端点合法、桥面接岸连续、原有墙链不被接错、出生点 / 梯子 / 传送点不落在不可达空间。`contiguous_neighbor` 和 `chain_wall_on_sweep` 等现有逻辑依赖这些条件，不是两个端点坐标正确就够了。[R07]

桥上不新增强制怪物刷点；原有怪物不能因错误链路穿墙。桥下保留安全落点或既有退路；向下跳与水域若相邻，必须增加对应测试。

### 10.4 激活时机

施工完成不立即等于几何已激活：先得到待启用状态，计算候选有效 Map，确认内容版本和安全条件，再原子提交通行状态并在同一世界处理边界应用几何，随后发送新快照。

新增地面应尽量通过关卡设计避免穿过玩家身体或占用已有落点。检测到占位风险时保持施工围挡 / 待启用状态，公开说明原因并重试；不要无提示把玩家弹飞。若摆放必然允许恶意长期卡住启用，P0 选址不合格，应改布局或另行定义明确可见的安全迁移规则，不能把无限等待交给线上玩家承担。

首版只增加一条可选捷径，不删除既有地面。关闭交互开关也不能把已建成桥面撤掉；节点卸载、最后一人离图或角色下线都不改变公共设施。

### 10.5 资源与地面一致

几何已启用但对应美术加载失败时，客户端显示明确加载错误并抑制新节点交互，不伪装成空气桥。发布前把目标节点所需素材包含在可验证资源集中；旧内容版本客户端不能继续参与新节点世界。

无需等待所有玩家回传“动画播放完”才启用服务端地面；客户端确认不能成为权威条件。需要同步的是内容兼容与事实版本，不是每个人的播放进度。

---

## 11. 工匠、货车和停留者：有实际条件，不先造 NPC 平台

### 11.1 一条固定路径足够验证

首版使用同图内固定、可验证的地面路径和起终点，不引入全地图寻路、全球物流或通用行为树。桥梁不可通行时，车等待或执行已定义的自救；桥可通行、车直立、货物固定后才出发。

货车、货单、货物批次、送货者各有稳定 ID。玩家离开后不重新生成一组同名对象。货车不借用可拾取掉落物的销毁语义，也不把同一批货同时计为在途和已到货。

### 11.2 在途与持久化

出发提交时保存路线版本、起点、目的地、开始时间、预计到达时间、货单状态；活跃运行期间由服务端推导当前路段与坐标。首版没有途中劫掠或货损，因此可用确定性的固定路线重建位置；如以后增加中途阻碍，需要新增真实停止与恢复事实，而不是继续按原倒计时穿过去。

到达是一次稳定系统作业，使用稳定 jobId 去重。到货、货单终态、目的地物资变化和来源事件一次提交。一次运输抵达后，再满足棚架修整 / 停留者进入的条件；不凭空刷新一队无来由的商人。

### 11.3 NPC 身份与表现

送货者优先通过现有 `World.npcs` 和 `NpcState` 维持公共身份与交谈能力；节点规则更新其权威位置。货车和施工道具由节点视图绘制。不要在 `NpcView` 与 `NodeView` 各画一遍同一个人。

当前 `NpcView` 只播放 `stand`。P0 需核定走路、扶车、施工 / 休息的实际可用资源；缺失时可制作明确标记为 P 的少量动作覆盖，或对 NPC 资源类型做最小扩展。移动一个站姿精灵只算占位，不算“商队自然过桥”通过。[R10]

复用某个 TMS NPC 外观，不等于盗用原剧情人物身份。新实例 ID、名字、对话和所属节点均应明确，并且不带原作 NPC 的任务 / 转职 / 商店能力。

### 11.4 无玩家时推进

NPC 的主动搬运、安装、车辆自救、运输和卸货都基于有限材料与已存计划。玩家帮助会解除相应缺口，NPC 下一步读取新事实，不再重复原本已完成的工作。

无人地图不新增完整高频物理模拟任务；节点规则只处理到期作业，当前 World 的其他模拟策略不在本次改动范围。服务器重启先中断未完成玩家动作，再按时间顺序、资源与依赖条件处理已到期 NPC 作业。

补算按**语义步骤**而非逐帧循环，并设置每次处理的步数预算；例如原型每轮最多 16 次状态迁移，未处理完下轮继续。具体预算需实测，不宣称既有性能。使用原计划到期时间推导后续计划，不能把一个已经有时间顺序的过程全部改为“启动时刚开始”。

持久时间采用服务端时间戳；运行中的短时计时使用单调时间。系统时间大幅跳变时记录异常、限制单次补算并保留待处理状态；不因浏览器传来的时间补发材料，也不在重启时伪造某玩家离线施工。

---

## 12. 个人回应：真实记忆，不是全知 NPC

### 12.1 来源规则

第一版只允许直接参与 / 目击形成记忆。修桥匠知道某人交过材料；送货者知道某人扶过自己的车。服务端知道两件事，不代表所有 NPC 都知道。

记忆引用已提交 eventId，并保存具体数量或作用对象。使用稳定 NPC 实例 ID，而非 templateId：两位同外观商人不能共用一个记忆库。

### 12.2 在现有对话上最小接入

沿用 `dialogue.rs::handle_npc_talk` 的身份、地图、存在性与距离检查，在确认目标是本节点 NPC 后读取允许表达的记忆，生成已有 `npcResult` 对话。原任务、转职、商店入口保持既有行为。[R11]

节点 NPC 的公共存在不读取个人任务进度。无关任务 NPC 不因为玩家修桥而改变可见性。首次重逢可以一句话，之后低频点头即可；没有必要每次重播完整感谢。

### 12.3 文案的精度不能超过事实

| 已知事实 | 合理表达 | 不合理表达 |
|---|---|---|
| 玩家交过一份木料 | “那块板材用上了。” | “这座桥全靠你才建成。” |
| 玩家扶正车辆 | “上次搭的那把手，我记着。” | “你护送我们走遍了大陆。” |
| NPC 只看见桥已通 | “这边终于能走车了。” | 点名感谢自己没有目击的贡献者 |
| 玩家没帮过忙 | 普通招呼、允许使用桥 | 冷落、道德惩罚、强制补做任务 |

首版不接入 LLM、人格标签、好感经验条或全村传闻传播。历史碑记可作为后续只读功能，不作为当前闭环的必要 UI。

---

## 13. Phaser 前端接入与生命周期

### 13.1 Scene 只做装配

`client/src/scenes/world.ts` 已有玩家、怪物、NPC、Portal、Reactor、Water 等视图集合，以及 `switchMap → clear → scene.restart` 的加载流程。新节点沿用该生命周期。[R09]

拟新增 NodeView 提供清晰的 `applySnapshot`、`update`、`destroy` 入口；具体函数签名在协议冻结后确定。Scene 只负责创建、转发和清理；库存、施工完成、通路状态都不得在 View 中计算为权威。

### 13.2 表现优先级

先做到交互对象可辨认、材料前后变化明显、车扶正后轮廓不同、安装阶段读得懂、桥与脚点吻合、货车身份和轨迹连续；然后才做光、风铃声、尘土、旅行者闲聊。大特效不能替代一次真实通行。

无强制任务不等于无提示。靠近时保留简短动作说明、键盘入口、必要的字幕与可读对比；不能将玩家找不到操作误判成玩家不愿意帮助。

### 13.3 私有回执与离线状态

视图可立即播放抬手等尝试动作，但最终成功表现等服务端终态。发送失败不生成假 pending 成功；暂存的重试必须保留原 ID 和原参数。切图关闭局部交互 UI，后续回执仍按 requestId 归档，不在新地图播放旧图动画。

旧请求若已完成，重连查询得到原回执；不会因为本地 pending 被清理而要求玩家再次付出。局部 UI 不另建一条与既有 Connection 竞争的 WebSocket。[R18]

### 13.4 释放边界

Scene shutdown、地图切换和重新加载时清理节点显示对象、交互监听、局部计时器、音效句柄、pending 视觉状态。不要每次 snapshot 注册监听器，也不要销毁其他视图共享的纹理。

Phaser 3.90.0 的 shutdown 事件不等于 Scene 永久销毁；同一 Scene 可能重新启动，因此 cleanup 必须可重复执行，重启后可重新挂载。此处采用对应版本源代码，而不是把最新大版本文档当作本项目接口。[E03]

---
## 14. 资源装配、配置与启动政策

### 14.1 P 覆盖层与原作资源分开

拟新增 `shared/world-nodes.json` 保存节点定义，包含 schemaVersion、P 来源声明、节点 ID、绑定地图、来源材料、配方、交互点、几何覆盖、路线及美术引用。节点配置不是任意脚本执行器。

原作地图、NPC、任务数据保持来源准确；新增覆盖层的坐标和行为明确归类 P。配置中的资源引用应能追到实际 273 提取物或明确的原创素材，不把替换标签当成已核实兼容。

未完成落点核定时，仅提交合法的关闭配置，例如：

```json
{
  "schemaVersion": 1,
  "sourceClass": "P",
  "enabled": false,
  "nodes": []
}
```

这不是已可玩的节点定义。打开功能前，真实地图、素材与几何必须完成校验；禁止用虚构 URL 或占位坐标让启动“假通过”。

### 14.2 装配检查

实施前追踪现有 manifest 的生成入口，决定节点资源是否追加一个独立 section / 文件；如需要，使用拟新增 `scripts/assemble_world_nodes.cjs`。不要在不同路径各手改一份状态素材表。

`check_world_nodes.cjs` 至少校验：节点 ID 唯一、目标图存在、定义版本、动作白名单、材料单位与配方守恒、foothold 引用和 ID 冲突、路径端点与桥能力匹配、NPC 模板 / 动作资源可用、客户端与服务端覆盖层版本一致。

既有 `check_tms273_runtime.cjs` 的 44 图与原始资源检查保留。新增覆盖层不应假冒第 45 张原作地图；真需要新增地图时，同步更新来源与装配规则，而非只把数字改为 45。[R14]

### 14.3 启动前恢复顺序

```text
加载现有地图与玩法数据
→ 初始化现有 Store 与节点 schema
→ 校验节点配置及内容版本
→ 读取 worldScopeId 与已提交节点事实
→ 将旧进程 pending 玩家动作标记为 interrupted
→ 有预算地推进到期 NPC 作业
→ 构造有效地面、节点 NPC 与货车当前投影
→ 验证地图 / 实体 / 存档一致
→ 再开始接受玩家进入世界
```

当前 `main.rs` 的 World 构造与 spawn 次序需要配合此顺序审核；可在组装链中增加返回 `Result` 的节点恢复步骤，确保新玩家首个快照不是恢复前的假断桥。[R02][R03]

配置校验失败不能静默忽略已有持久节点。无已有节点时可以保持功能关闭；已有已建成设施时必须恢复其事实或明确阻止该不兼容版本进入正式运行。

### 14.4 不与 HMR 计划抢范围

当前默认仍由 `启动3010.command` 构建后重启，`PLAN.md` 中的 HMR 默认行为变更仍待用户决定。世界节点不借机切换默认开发服务器、不改端口，不把修改源码当作已加载到 `dist-tms273`。[R01][R13]

必要编译和纯数据检查可单独执行；真正启动 / 更新游戏只沿用 `启动3010.command`，由用户选择时机。文档编写与静态核查不触发该脚本。

---

## 15. 分阶段实施：每一步都交付可观察结果

### 15.1 阶段与依赖

| 阶段 | 本阶段交付 | 进入下一阶段的条件 |
|---|---|---|
| P0：工程与场地核定 | 确定一处合法摆放、真实素材清单、文件所有权、消息与存储边界 | 不阻塞原主线；不依赖虚构资源；知道哪些现有缓存要更新 |
| P1：一件帮助真的留下 | 一个材料交接动作；公共库存改变；NPC 准确回应；重连 / 重启保持 | 两个观察者看见同一变化，重复包不能重复资源转移 |
| P2：桥真的通行 | NPC 分段安装、有效几何、公共捷径、未贡献者可用 | 原地面不退化；节点关闭 / 离图 / 重启不拆桥 |
| P3：生活开始出现 | 扶车、同车同货过桥、一次到货、停留者与自然重逢 | 身份连续；到货不重复；无人时会合理推进 |
| P4：验证后扩展 | 逐条接入确有价值的已有玩法，或第二种文化外观节点 | 先解释新内容改善哪项已观察到的体验，不因模块写好就自动铺满所有图 |

P1 可以先用明确的开发占位视觉检查权威链路，但用户体验验收必须使用可读的实际场景；占位通过不代表“情绪成立”。P1/P2/P3 都属于同一张图的小闭环，不是三个新系统。

### 15.2 可执行开发卡

以下是专题工作包，不维护实际进行中状态；实施时将当前一张卡及其依赖登记到 `PLAN.md`。

| 卡片 | 输入与依赖 | 修改落点 | 输出与完成条件 |
|---|---|---|---|
| WN-00 场地与接线核定 | 固定源码基线、目标候选图 | 读取地图 / manifest / World；产出配置说明 | 实际图、坐标、绕行、桥端、路线、美术来源齐全；标明未有动作素材 |
| WN-01 单动作事实与 Store | WN-00 的稳定 ID / 资源定义 | `node_model.rs`、`auth/world_nodes.rs`、`auth/schema.rs`、`auth.rs` | 交接事实、pending / 终态、事件、记忆同库实现；提交 / 回滚 / 重发有定向测试 |
| WN-02 World 与协议接入 | WN-01、冻结消息形状 | `main.rs`、`world.rs`、两侧 `protocol` | 认证角色发起交接，其他玩家读到公共结果；不能伪造数量或跨图目标 |
| WN-03 前端交接与回应 | WN-02、真实交互资源 | `node-model.ts`、`node-view.ts`、Scene、app 接线、`dialogue.rs` | 玩家看见材料移动，工匠只感谢实际帮助；切图 / 重连不重复表现 |
| WN-04 施工与地面 | WN-01～03、桥端几何核定 | `world_nodes.rs`、`node_geometry.rs`、World 地图投影 | 预留用料、分段安装、一次安全启用；丙无需贡献也能过桥 |
| WN-05 扶车与运输 | WN-04、货车 / 人物姿态资源 | `world_nodes.rs`、节点定义、相关 View | 车只扶正一次；同一货单出发和抵达；无临时换人或重复到货 |
| WN-06 无人推进与重逢 | WN-05、NPC 稳定身份 | 节点作业、Store 恢复、`dialogue.rs` | 玩家不帮世界仍推进；玩家回来被准确认出；不假造离线贡献 |
| WN-07 内容门禁与发布保护 | 已完成切片 | 新检查脚本、manifest 接线、配置开关、必要版本更新 | 打包资源一致；已有节点只读恢复可用；启动仍走统一脚本 |
| WN-08 定向回归与体验交付 | WN-07 | 新验收文件及当前计划记录 | 只报告实际执行结果；未测实机项交用户；不另启独立 QA 或 live bot |

建议首个可审查提交只覆盖 WN-01 和必要接线：**交接一次有限材料 → 数据库保存 → 第二个观察者看到 → 重试不重复。** 不先提交一堆空接口，随后几周才出现第一个可玩的动作。

### 15.3 共享文件所有权

后端规则与存储可以拆成独立实现任务，前端可在冻结的协议样例上工作；但 `world.rs` / `main.rs`、两侧协议、`main.ts` 与资源装配分别指定唯一整合写入者。每张卡提交说明“新增业务行为”还是“机械搬移”，不能以重构名义夹带变更。

本计划没有启动子代理，也没有修改 `PLAN.md`。实际执行时按仓库治理记录负责人和验证证据，不虚构已派发任务。[R01]

---

## 16. 定向验收：先证明事实可信，再判断温度

### 16.1 拟新增检查文件

服务端世界行为：`server/src/world_node_acceptance.rs`，按仓库当前测试组织方式挂入相应测试模块。Store 事务测试可放在 `auth/world_nodes.rs` 的测试模块；涉及文件恢复时使用临时数据库，不碰正式数据库。

客户端：`client/src/features/world/node.check.ts`，测试解码、版本、同 revision 的运动更新、首次快照基线和清理后的状态；不让纯状态测试依赖完整 Phaser / 浏览器环境。另有必要的前端 typecheck / build。

资源：`scripts/check_world_nodes.cjs`，使用真实定义和可控坏样本，验证检查确实能拒绝错误。不要只验证“源文件中出现过某个字符串”。

### 16.2 必测用例

下表是验收规格，**本轮没有执行**。

| ID | 用例 | 必须成立 |
|---|---|---|
| T01 | 新库关闭功能 | 不生成可交互节点，不改变原始主线 |
| T02 | 同一节点正常重启 | scope、nodeEpoch、事实和记忆保持 |
| T03 | 一个玩家成功交接 | 来源减少、施工增加，贡献数量与库存变化一致 |
| T04 | 同 ID 同参数重发 | 返回原结果，不重复转移或追加记忆 |
| T05 | 同 ID 换目标 / 换 action | `request_conflict`，无副作用 |
| T06 | 成功后走远再重发 | 返回原成功回执，而非再扣料或误作新动作 |
| T07 | 非法角色字段 / 坐标 / 数量 | 严格拒绝；只能操作认证角色 |
| T08 | 跨图目标、错误 nodeEpoch | 拒绝新动作，不泄漏他人私有回执 |
| T09 | 两人抢最后一份材料 | 最多一次真实转移；库存不负数 |
| T10 | 两人同时扶同一辆车 | 只发生一次扶正；归因不虚构 |
| T11 | pending 时移动、死亡、切图 | 合理中断，资源未转移，占用释放 |
| T12 | pending 时 Detach / Logout / takeover | 旧控制权不再产生劳动，新连接不继承无限工作 |
| T13 | 玩家后台驻留 | 角色可见，但不自动累计施工贡献 |
| T14 | pending 后进程中止 | 启动将动作终结为 interrupted，不补成成功 |
| T15 | 事务中途失败 | 事实、回执、事件、记忆原子回滚 |
| T16 | commit 后、广播前中止 | 重启恢复新事实；同 ID 可取得原结果 |
| T17 | 施工任务重复处理 | 预留 / 消耗各一次，不重复安装 |
| T18 | 施工资源不足 | 不能靠等待、刷怪或客户端完成标记凭空补齐 |
| T19 | 到期补算处理预算耗尽 | 保留待处理计划，不逐帧补算卡死 World |
| T20 | 全程没有玩家帮助 | NPC 按有限材料和计划推进，主线不受惩罚 |
| T21 | 桥启用前后移动 | 前后地面与图像一致；绕行、上下跳、端墙不退化 |
| T22 | 桥面启用时有人占位 | 不夹人、不无提示弹飞；执行明确安全策略 |
| T23 | 出生图 / 非出生图节点投影 | `World.map` / `maps` 等读取不产生几何分歧 |
| T24 | 两位玩家同时观察 | 同一节点状态和通行结果；私有感谢可以不同 |
| T25 | 晚到且没有贡献 | 看见当前桥，直接使用，不重做个人修桥任务 |
| T26 | 切图 / 重连 / 首快照 | 只恢复当前状态，不重复建设庆祝或运输起点 |
| T27 | 同 revision 的货车运动 | 新 serverTick 坐标正常更新，不因 revision 相同冻结 |
| T28 | 世界重启后 tick 重置 | worldEpoch 切换能建立新快照基线 |
| T29 | 同货单到货重试 / 重启 | 到货和目的地物资变化只提交一次 |
| T30 | 同外观不同 NPC | 记忆按实例区分，不互相冒领见闻 |
| T31 | 没目击帮助的 NPC | 不点名、不复述未经传播的贡献 |
| T32 | 节点 NPC 与原任务共存 | 节点公共可见；原任务 / 转职 / 商店不被改写 |
| T33 | 场景多次 shutdown / restart | 无重复监听、对象残留、旧图提示和局部定时器 |
| T34 | 坏配置 / 缺素材 / 版本不符 | 明确失败，不显示可用空气桥或跳过持久设施 |
| T35 | 已建成后关闭交互 | 保留桥面和当前现实，不因开关回退拆桥 |
| T36 | 原 Reactor 与原地图回归 | 普通 Reactor 仍按原规则重生；原传送与地面不受污染 |

如果本阶段未涉及某些后续行为，只执行当前改动相关用例，不为了“全绿”重跑无关模块。引入新行为后必须补上其失败边界，不能以用户取消独立 QA 为由省略必要定向验证。[R01]

### 16.3 建议执行命令

下列命令用于**后续实施者**；本轮未执行。新增检查文件必须真实存在后再调用：

```bash
# 在仓库根目录：现有离线工具链能满足依赖时使用。
# cargo test 过滤名由新增测试实际命名对应；不启动游戏服务。
cargo test --offline --manifest-path server/Cargo.toml world_node

# 在 client/，只做实际改动需要的检查。
npm run typecheck
node --experimental-strip-types src/features/world/node.check.ts
# 改动资源或运行装配后按需：
npm run build

# 回到仓库根目录，新增配置检查完成后：
node scripts/check_world_nodes.cjs
```

不得把缺少离线依赖造成的失败写成代码错误，也不得跳过失败假称通过。无需为一份计划运行整套游戏验收。

### 16.4 既有检查记录如何使用

仓库保存的一次记录是 Rust `292 passed / 6 failed`；前端检查链中有 `dialogue.check.mjs` 通过 `data:` URL 导入相对模块失败的记录。这些只是当时结果，本轮没有复跑，也不保证实施时仍然一致。[R16]

新节点检查应能单独运行，不被已知的前端长链前置失败遮住。改动范围命中的旧失败要重新区分原因；不宣称修好了与节点无关的技能或任务问题，不通过删掉断言换取全绿。

### 16.5 情绪验收剧本

甲：第一次路过，只交一份材料便离开。乙：继续帮助，让桥最终通行。丙：没有贡献，直接使用桥。甲后来回来，遇到实际目击过自己交材料的工匠。

验收时观察并询问三个具体问题：“这里发生了什么变化？”“你做的哪件事影响了它？”“你认识这里的谁？”不诱导用户回答“感动”“温暖”或“有归属感”。

如果玩家只记得奖励数量，优先检查世界变化是否可辨认；如果记不住人物，检查是否同一身份、是否在自然路径重逢；如果感到被强迫，检查主线门槛与追债式提示。小样本体验只能帮助迭代，不能据此宣称提高留存或证明所有玩家偏好。

---

## 17. 发布、回退与观测

### 17.1 两类开关，不做破坏式关闭

建议区分“是否允许新动作 / 新施工”和“是否加载已有节点事实与设施”。初次发布默认不开放写入，内容与存储恢复验证后再开放。

已有节点事实时，只关闭动作入口，仍恢复有效桥面、当前 NPC 与货车状态。若当前代码或资源无法解释存档版本，应拒绝这次不兼容部署；不能静默退回原始断桥地图。

数据库迁移采用追加兼容方式，缺省值明确，正常启动不清理历史。回退到完全不认识节点存档的旧二进制并不自动安全；正式回退必须保留节点读取投影能力，或采取用户明确批准的维护与恢复方案。

### 17.2 不误用启动脚本

`启动3010.command` 实际会构建后调用关闭脚本，并重新管理 3010 与既有陪测机器人。因此，代码就绪后交用户选择更新时机；不在本任务中调用它。[R13]

启动规范仍只保留这个入口。不另建偷偷占端口的脚本，不擅自改变 HMR 默认模式，不重建账号或复制 live bot 凭据。

### 17.3 一致备份

对正在使用 WAL 的数据库，不把“只复制主 `.sqlite3` 文件”当作一致备份；使用经核定的 SQLite 备份方式或受控停机备份流程。WAL 是持久状态的一部分，不能在清理磁盘时当缓存删除。[E02]

上线核对实际链接的 SQLite 版本与备份工具兼容性。本轮没有读取运行时 SQLite 版本，因此不声称已满足某个版本条件，也不借此自动升级项目依赖。

### 17.4 只观察有用的指标

新增动作成功 / 拒绝 / 冲突次数、Store 提交耗时、作业积压、快照中节点部分的大小、节点恢复失败、未完成动作中断原因、场景对象计数。记录 scope / node / event / request 的可关联标识，但不记录密码、token 或完整私人对话。

当前 tick 性能没有本轮实测。初期观察节点写入是否挤占 50 ms 世界步长；出现问题时先减少重复读取、全量序列化与每帧落库，再考虑有证据的调度重构。不能靠一个队列容量声称支持多少人同时在线。

---

## 18. 后续玩法接入：解决真实缺口，不兑换统一分数

| 玩法 | 可以接入的事实 | 首版后怎样接 | 禁止替代 |
|---|---|---|---|
| 战斗 | 一个实际阻碍运输 / 施工的威胁被解除 | 复用服务端已确认的死亡 / 结算来源，在有该阻碍时解除条件 | 杀任意怪直接变出绳索 |
| 探索 | 找到一处可达材料来源或可用支路 | 由权威位置与真实对象确认发现，记录可被使用的信息 | 上传“我已探索”就加建设值 |
| 采集 | 某材料来源真实产出并转移 | 复用已有产出 / 背包机制；确认来源、数量和重复请求 | 点击无限材料点直到条满 |
| 制作 | 原料转成桥梁适用部件 | 一个事务处理原料、成品与接收；配方有实际用途 | 捐任何物品换一种万能积分 |
| 护送 | 同一货物批次从起点抵达目的地 | 扩展已实现的货单和路线事实 | 站在车旁够时长就假定到货 |
| 社交 | 明确分工让一项现有工作完成 | 有任务占用、主动接手与退出的共同操作 | 聊天条数、好友数、点赞数直接计贡献 |

背包捐赠是后续独立开发卡：在现有 Store 同一事务内解析角色当前槽位、物品身份、数量与剩余需求；过量不吞，重复不扣，提交后刷新 Player 的权威背包缓存。不能用客户端 itemId 代替数据库中的实际物品实例。[R19][R20]

完成这张图之后，第二个节点优先只换一个明确能力：例如灯塔改善辨路与停靠。只有两个不同节点确实出现重复职责，才提炼公共小接口；不要在第一座桥前设计支持所有文化、所有气候和所有文明的节点编辑器。

个人 / 小队私有设施、真正的跨频道公共工程、商店供给经济、自由文本碑记、LLM NPC 均不是本闭环的隐藏前置。

---

## 19. 与当前计划的衔接与本轮交付状态

建议实施时在 `PLAN.md` 只登记一条活动入口，示例如下；负责人等执行信息由实际实施过程填写：

```markdown
- [ ] 世界节点《风铃桥》P0 / 当前开发卡 WN-00
  - 规格：MapleStory_世界节点机制_仓库适配开发计划_v0.2.md
  - 基线：main@1fefe97c2d27a928f3bf670b657d79f68d795fe9，开工时复核变化
  - 范围：一张既有地图的 P 覆盖层；不改原主线，不另建世界服务
  - 所有权：协议与 World 接线统一整合；存储 / 表现按文件分工
  - 依赖：真实落点、素材、地图几何读取者核查
  - 验收：有限材料交接 → 持久事实 → 公共快照 → 准确回应
  - 禁止：擅自重启 3010、重置新库、启动额外 live bot / 独立 QA
```

本轮状态：已完成远程源码核查并据此重写专题计划；没有向仓库写入文件或创建 PR。本文的 SQL、类型和函数名都是实施规格，不能作为已完成代码交付。后续报告仅填写实际运行过的定向检查和用户待验项。

文档自检已执行：UTF-8 读取、代码围栏配对、章节与引用编号检查；第 7 节 SQL 示例在独立内存 SQLite 中完成建表、重复建表、复合提交、重复请求唯一约束与回滚、孤立记忆外键拒绝、revision 安全整数边界检查。这些仅验证文档示例，**不等于仓库 Store 已实现或通过集成测试**。

**最终完成标准：甲交过的材料不会消失，乙可以接着做，丙可以直接过桥；甲回来时，知情的人认得他，桥和生活都不为他的登录而重置。**

---

## 20. 源码证据索引与外部依据

所有 R 编号都固定到同一提交；链接中的行号为核查定位，实施时以当前文件和符号为准。这里只列支持本设计的主要证据，不复制完整源码。

| 编号 | 证据与支持范围 |
|---|---|
| R01 | [AGENTS.md](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/AGENTS.md)、[BUSINESS_DEVELOPMENT.md](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/BUSINESS_DEVELOPMENT.md)、[PLAN.md](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/PLAN.md)：现行治理、版本边界、原作与 P 提案、启动 / 验收约束 |
| R02 | [server/src/main.rs](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/server/src/main.rs#L1-L160)：配置、同一 Store、World 组装、命令队列、静态资源与健康接口 |
| R03 | [server/src/world.rs：状态和初始化](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/server/src/world.rs#L2860-L3200)：World 字段、地图克隆、Reactor 会话语义、Boss 私有运行实例、目录挂载 |
| R04 | [client/package.json](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/client/package.json)：Phaser 3.90.0、TS / Vite 与实际命令 |
| R05 | [server/src/auth.rs](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/server/src/auth.rs#L1-L200)：Store 的 Connection / Mutex、实际 auth 子模块、身份与 Profile |
| R06 | [server/src/auth/schema.rs](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/server/src/auth/schema.rs#L1-L155)：建表入口、WAL、现有操作记录表 |
| R07 | [server/src/world.rs：地面方法](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/server/src/world.rs#L900-L1110)：梯子、下跳、墙链、连续邻接与水域查询 |
| R08 | [shared/protocol.ts](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/shared/protocol.ts#L1-L305)：版本、现有意图、snapshot、NPC / Reactor 与私有回复 |
| R09 | [client/src/scenes/world.ts](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/client/src/scenes/world.ts#L1-L160)；[同文件更新逻辑](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/client/src/scenes/world.ts#L380-L555)：Phaser View 集合、换图重启、权威坐标与逐帧表现 |
| R10 | [client/src/features/npc/view.ts](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/client/src/features/npc/view.ts#L1-L125)：只播放 stand、实例坐标、朝向与显示对象清理 |
| R11 | [server/src/dialogue.rs](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/server/src/dialogue.rs#L1-L125)：NPC 对话入口、地图 / 可见性 / 距离与私有回复 |
| R12 | [server/src/network.rs](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/server/src/network.rs#L145-L324)；[world.rs 的连接与意图分派](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/server/src/world.rs#L4320-L4500)：角色认证、连接绑定、入站约束、Detach / Exit / Lifecycle |
| R13 | [启动3010.command](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/%E5%90%AF%E5%8A%A83010.command#L1-L130)：默认资源、版本检查、构建后关闭并重启 3010、既有 bot 管理 |
| R14 | [scripts/check_tms273_runtime.cjs](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/scripts/check_tms273_runtime.cjs#L1-L135)：44 图、原始来源、生产源码扫描排除 acceptance |
| R15 | [shared/maps.json](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/shared/maps.json)：已装配地图 ID 与出生图；本轮不据此声称完成场地美术核验 |
| R16 | [artifacts/refactor/baseline-metrics.json](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/artifacts/refactor/baseline-metrics.json)：他次真实检查记录与未测性能声明，不是本轮测试 |
| R17 | [BACKEND_ARCHITECTURE.md](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/BACKEND_ARCHITECTURE.md)：现行 world 子模块拆分规范；实际 auth 目录仍以 R05 为准 |
| R18 | [client/src/network/session.ts](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/client/src/network/session.ts#L1-L130)：连接、快照确认、旧 socket 排除、重连、send 返回语义 |
| R19 | [server/src/auth/bag.rs](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/server/src/auth/bag.rs#L1-L130)：持久 prior 查询、Store 事务内读取与变更背包 |
| R20 | [server/src/inventory_ops.rs](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/server/src/inventory_ops.rs#L1-L145)：World 背包缓存、地图 / 距离检查与 Store 事务外观 |
| R21 | [bots/run.mjs](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/bots/run.mjs#L1-L70)：机器人握手取登录版本；版本匹配不等于验证新节点业务 |

外部依据只用于具体工程性质，不证明本玩法的体验效果：

| 编号 | 官方依据 | 在本计划中的使用 |
|---|---|---|
| E01 | [SQLite：Transaction](https://www.sqlite.org/lang_transaction.html) | 同库事务、并发写限制、普通 BEGIN 不可嵌套；不要求新增数据库 |
| E02 | [SQLite：Write-Ahead Logging](https://www.sqlite.org/wal.html) | WAL 与持久状态 / 一致备份边界；不把 WAL 当缓存删除 |
| E03 | [Phaser v3.90.0：SHUTDOWN_EVENT.js](https://github.com/phaserjs/phaser/blob/v3.90.0/src/scene/events/SHUTDOWN_EVENT.js) | shutdown 时释放 Scene 资源，但 Scene 仍可再次启动 |
| E04 | [Tokio：Channels](https://tokio.rs/tokio/tutorial/channels) | 单一资源拥有者与命令传递的技术参照；本仓库已有该入口，不因参考文档另造框架 |

本文与上一版的关系：保留《风铃桥》体验、公共现实与个人记忆边界；用当前仓库的真实职责、存储和运行方式替换旧版未绑定工程的抽象实现建议。本文不要求以重写原作主线来证明原创世界机制。
