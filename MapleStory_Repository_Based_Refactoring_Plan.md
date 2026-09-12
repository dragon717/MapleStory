# MapleStory 超大文件治理与渐进式架构重构计划

> **版本：仓库复核版 v2.0**  
> 制定日期：2026-09-12  
> 仓库：<https://github.com/dragon717/MapleStory>  
> 源码复核基准：`1fefe97c2d27a928f3bf670b657d79f68d795fe9`  
> 适用技术栈：Rust / Axum / Tokio / rusqlite（SQLite）；Phaser 3.90 / TypeScript / Vite。  
> 交付性质：**已读取固定提交源码、文档和仓库审计记录后的实施计划；不是已完成重构或已通过测试的报告。**

## 0. 结论与本轮边界

**推荐路线：保留单进程权威世界和模块化单体；沿现有业务模块继续演进，把“共享整个 World 的物理拆分”逐步提升为“规则、事务协调、持久化、表现各有边界”。**

现在最需要的不是重新画一套 `controllers/services/repositories` 目录，也不是将每个玩法改成微服务，而是：

1. 让审计与测试结果可信，区分已有失败、新增失败，以及类型依赖和运行期依赖。
2. 从已经拆出的模块中抽取真正独立的纯规则，减少一次修改必须理解的世界状态。
3. 保持资产事务、幂等、内存回填、网络回执的既有一致性边界；不能为了缩短文件将它们拆散。
4. 前端优先治理背包窗口、资源类型依赖与生命周期，再收敛应用装配和地图场景。
5. 对移动、碰撞、Tick、技能结算和协议采用更严格的保护测试，后置处理。

本轮已经通过 GitHub 读取实际源码片段、模块声明、启动脚本、检查脚本及审计产物。没有在本地取得完整可构建检出，因此**没有重新计算当前全仓库行数、执行 Cargo/Node 检查、启动 3010、验证浏览器或测量性能**。仓库中记载的测试成绩会明确标注为“仓库记录”，不能视为本轮实测。

本文中：

- **已确认**：直接从本次固定提交的源码或文件读取所得。
- **审查判断**：根据已读代码推导的风险或改进方向，不等于已复现故障。
- **拟新增**：实施阶段才创建的文件、接口、命令参数或门禁，不能当成现有能力直接调用。
- **待完整审计**：需要在本地完整检出中检索全部调用点、错误分支、测试和最新尺寸。

---

## 1. 真实仓库情况：不能从上一版假设继续推进

### 1.1 已确认的技术栈与入口

| 事项 | 本次确认 | 对重构的影响 |
| --- | --- | --- |
| 前端框架 | `client/package.json` 固定 `phaser: 3.90.0`，TypeScript `~5.9.3`，Vite `^7.3.1` | 按 Phaser Scene、DOM 窗口和网络会话设计生命周期，不套 Three.js 资源释放方案 |
| 服务端依赖 | Rust 2021；Axum 0.8、Tokio、rusqlite 0.37、serde、Argon2 等 | 保留现有 crate 和 SQLite，不因文件大小换技术栈 |
| 前端应用入口 | `client/src/app/main.ts` 直接组装 `Connection`、输入、Phaser、多个窗口 | 这是装配点，不应把所有 import 多都判成设计错误；问题在于同时承载页面、状态和业务流程 |
| 前端地图入口 | `client/src/scenes/world.ts` 的 `World extends Phaser.Scene` | 已复用多个 feature view；后续只拆仍聚集的职责 |
| 前端网络入口 | 实际是 `client/src/network/session.ts` | 不继续沿用未经核实的 `runtime/network/session.ts` 路径 |
| 协议入口 | 前端实际 import `shared/protocol.ts`；后端文档标示 `server/src/protocol.rs` | 本轮不假设已存在统一 JSON Schema 生成链，不照旧计划手改所谓生成绑定 |
| 运行方式 | `启动3010.command` 先检查资源、构建后端和前端，成功后停止旧实例并启动 3010 | 集成验证必须沿用；`client/dist-tms273` 是构建产物，不是修改入口 |

依据：源码、包配置和启动脚本。[^S01][^S02][^S07][^S08][^S12][^S18][^S20][^S21]

### 1.2 已经做过的拆分：不要重复立项

`server/src/world.rs` 当前已通过 `#[path]` 挂载以下子模块：

```text
boss         messaging      inventory_ops   social
trade        quest          monsters        skills
elemental    dialogue       portals         growth
revive
```

这些不是待创建的目标目录，而是已经存在的模块。当前 `inventory_ops.rs`、`quest.rs` 的实际形式仍是：

```rust
use super::*;

impl World {
    // 从原 World 搬出的对应职责方法
}
```

所以问题不是“还没有 InventoryService / QuestService”，而是**这些方法仍然能够读取或修改整个 World 及其祖先模块私有项**。不能把同一批方法再次包装进无状态 `XxxService`、继续传整个世界，就声称完成解耦。[^S03][^S05][^S06]

`auth.rs` 也已经声明：

```text
auth/skills.rs   auth/quests.rs   auth/friends.rs
auth/loot.rs     auth/bag.rs      auth/schema.rs
auth/db.rs
```

同时，`auth.rs` 仍定义账号凭据、会话、`Store`、`Profile` 和多个业务结果类型。`Store` 持有 `Arc<Mutex<rusqlite::Connection>>`；`Profile` 包含位置、等级、经验、金币、背包、技能等游戏状态。**物理拆分已有进展，但认证职责与角色持久化职责仍共用一个大的外观。** 本文沿现有文件推进，不虚构 `auth/api.rs`、`auth/model.rs`、`auth/service.rs` 已经存在。[^S04]

### 1.3 文件大小：可引用报告，不能冒充当前重新扫描

仓库已有 `artifacts/refactor/large-files.json`。以下数字是**该已提交报告里的物理行数及提交触及次数**，不是本轮重新计算；报告扫描口径包含工作树文件，又未绑定源码提交，随着后续拆分可能失效。[^S16]

| 报告中的文件 | 报告物理行数 | 最近 100 次提交中的触及次数 | 本计划如何处理 |
| --- | ---: | ---: | --- |
| `server/src/world.rs` | 18,979 | 39 | 当前模块声明已显示继续拆分；先刷新尺寸，再按剩余职责排序 |
| `server/src/auth.rs` | 8,410 | 17 | 当前已挂载多个 auth 子模块；不能按旧体积重新从零拆分 |
| `client/src/features/inventory/view.ts` | 1,640 | 13 | 已读源码，确认同时拥有多个窗口、拖拽、提示、请求与监听；优先前端试点 |
| `server/src/inventory_ops.rs` | 1,484 | 1 | 保留事务协调入口，优先抽取安全的规则/转换，不拆散一次物品操作 |
| `server/src/quest.rs` | 1,455 | 0 | 已读源码，纯判定、文案、交互结算混合；优先服务端试点 |
| `server/src/inventory.rs` | 1,217 | 10 | 已有物品规则模块；必须复用，避免复制容量/堆叠规则 |
| `server/src/boss.rs` | 1,201 | 2 | 先完整审计复杂度和变更需求，不为数字达标再次切碎 |
| `server/src/lobby.rs` | 1,176 | 2 | 按角色生命周期与认证边界审查，后于低风险试点 |

例如报告中的 `references/tms273-data/maps.json` 超过百万物理行，但属于数据候选。治理这类文件要看生成链、加载成本和版本校验，不能与手写业务代码按同一标准拆文件。

**优先级依据：近期真实业务修改频度 × 理解成本 × 跨边界写入风险，再考虑测试保护和拆分可逆性。行数只负责提示，不直接决定实施顺序。** 机械拆分本身会增加文件的提交触及次数，不能把它等同于业务热点。

---

## 2. 先解决可信度：当前测试与审计并非全绿门禁

### 2.1 仓库记录的失败基线

`artifacts/refactor/baseline-metrics.json` 记录日期为 **2026-09-12**。它记载服务端一次运行结果为 **292 passed、6 failed**；前端 17 个检查逐项执行时为 **16 passed、1 failed**，类型检查记录通过。它还明确标注冷构建、Tick 分位数等未测量。以下只是转述该文件，并非本轮复跑。[^S15]

服务端记录的六个失败：

| 测试 | 仓库记录的现象 | 本计划的要求 |
| --- | --- | --- |
| `auth::tests::third_store_book_split_and_222_compatibility` | `Some(4)` 对 `Some(7)` | 对照实际 SP 规则和内容版本确认，不能直接改期望值 |
| `mage::tests::bundled_catalog_is_strict_and_has_energy_bolt_geometry` | 技能数 `56` 对 `43` | 分离“内容目录数量”与“规则校验”断言，确认新增来源 |
| `world::tests::config_drop_and_exp_are_authoritative_without_client_values` | gameplay 内容版本不兼容 | 先检查 fixture 与当前契约版本，不能绕过版本检查 |
| `world::tests::portal_command_changes_map_and_snapshot_scope` | 目标地图快照断言未满足 | 可能影响切图边界，未查清前不做切图流程语义重构 |
| `world::tests::reactor_area_herb_auto_triggers_once_per_entry_and_can_trigger_again_after_exit` | 状态 `Some(2)` 对 `Some(1)` | 复核进入/离开区域与重复触发语义 |
| `world::tests::third_sphere_and_adaptation_are_idempotent_and_bounded` | 数值 `204` 对 `612` | 复核 Boss 与普通怪增伤规则，不随拆分调整伤害公式 |

报告将这些失败归类为既有失败，但**分类仍需在本地基准提交复核**。不能把“仓库这样写”升级为“已独立证明它们一定是旧断言错误”。

前端记录的失败位于 `features/npc/dialogue.check.mjs`：用 `data:` URL 承载被测模块，无法解析相对 import。当前 `npm run check` 是 `&&` 串联，前一项失败会阻止后续项执行。[^S01][^S15]

处理办法：

- 优先修复测试装载方式：沿用项目已有 TS 转换能力，将被测模块放到可正确解析相对路径的位置，或使用明确支持该模块图的加载方式；不要以复制业务源码代替真实模块测试。
- 将多项检查改为一个**逐项执行、完整汇总、任一失败最终返回非零**的 runner；不要依靠“把新检查排在第 9 项前面”维持可见性。
- 修复 harness 与修改业务实现分开提交。
- 基线按“测试名称 + 错误特征 + 工具链 + 内容版本 + 源码提交”比较，不只比较失败数量。
- 与本次目标模块有关的行为测试必须通过；已批准的无关遗留失败可以短期登记，但不能让“旧失败”掩盖新失败。

### 2.2 现有审计脚本有用，但仍只是报告器

实际脚本为 **`scripts/refactor_audit.cjs`**，不是 `refactor-audit.mjs`。已支持无参数、`--sizes`、`--deps`。[^S17]

已确认的限制与改进：

| 当前实现 | 风险 | 应有改进 |
| --- | --- | --- |
| 正则抽取 import/export | 不覆盖动态 import、不能可靠理解全部语法 | 使用已安装 TypeScript 的 AST；无法解析的动态边单列，而不是当作不存在 |
| 类型导入与运行期导入混在一起 | 类型依赖环被误当作运行期初始化故障 | 分别输出 type、value、side-effect、dynamic 边和各自规则 |
| 打印 `block` / `violations` | `main()` 没有根据违规设置失败退出码 | 保留报告模式，**拟新增**明确的增量 `--check` 模式 |
| JSON、生成候选、测试候选整体豁免 | 大型手写配置、测试逻辑及错误分类可能逃过治理 | 区分来源、纯数据、可执行规则、测试代码、fixture；豁免需要有理由 |
| 文档沿用代码行数门槛 | 文档长不等于生产代码复杂 | 文档使用独立可读性/链接规则，不阻断代码重构 |
| 报告会扫描自身等产物 | 度量含生成噪声，容易出现自引用变化 | 排除审计输出目录，不把治理文档和报告纳入生产代码热点 |
| 缺少固定源码身份 | 不能证明尺寸与某个提交完全对应 | 增加 `sourceCommit`、`dirty`、扫描范围、工具版本、策略版本和源文件 hash |

本轮没有核验全部 CI 工作流，不能据此断言仓库完全没有 CI。实施时应先找到现有工作流并扩展，不另造重复流水线。

---

## 3. 采用哪些设计思想，以及不采用什么

### 3.1 业务模块优先，模块内部轻量分层

建议将任务、背包、技能、地图交互视为业务职责；在每个职责内部按需要区分：

```text
输入/协议适配 → 用例协调 → 纯规则与业务事实
                    ↓
               持久化/外部副作用
```

这里是**逻辑职责**，不要求每个 feature 都创建四个目录、四个 trait、四个 DTO。只有当某条边界能减少调用者需要知道的信息、限制状态写入、或提供独立测试价值时，才增加它。

例如，任务模块对调用者应隐藏如何处理前置任务 OR、职业条件和材料归一化；调用者不需要先后调用六个细碎 helper 才能判断是否可交任务。

### 3.2 保持单一世界状态所有者

保留当前单一权威模拟流程和有界输入投递方向。网络任务不直接并发修改角色、怪物、掉落；拆分文件也不引入多个互相竞争的世界写入者。后端文档已经明确这一方向。[^S18]

借鉴 Monolith First 的是“先在进程内建立可理解的模块边界”，不是宣称单体永远优于微服务；是否拆进程以后必须由真实扩展、隔离和部署需求决定。[^R01]

本轮**不做**：微服务化、全项目 ECS 改写、Kafka/Redis 消息总线、CQRS 全面重构、事件溯源、动态插件扫描、通用依赖注入容器、把所有调用改成异步事件。

### 3.3 纯规则内核，副作用在明确的外层

规则函数只接收它需要的事实和配置，不接收整个 `World`、`Store`、WebSocket 或 DOM。协调层可以知道多个模块，但只负责一个完整用例，不能成为新的全局工具箱。

适合优先独立的真实函数族包括 `quest_jobs_match`、`quest_prerequisites_match`、`quest_conditions_match`、`quest_consume_items`。它们目前位于 `impl World` 中；其中部分还读取完整 `Player`，可以逐步收窄输入。[^S06]

**不是所有 `&mut self` 都是坏设计。** 世界命令协调入口可以继续是 `impl World`；应消除的是纯判定和计算对整个世界的依赖，而不是为了指标让 World 无法协调一次完整操作。

### 3.4 渐进替换，而非整库重写

在已有入口后面先放入小的新实现，调用方逐步迁移，最后删除临时转发；这借鉴 Branch by Abstraction。适用于本项目的缝隙通常是既有方法/函数，不必引入全项目抽象框架。[^R02]

纯计算可在测试中用相同输入对比新旧输出。**会写数据库、发奖、消费道具或发消息的流程不能在生产环境双跑**，否则“影子验证”本身会制造重复副作用。

### 3.5 一次提交只解释一种变化

建议顺序为：保护测试 → 机械迁移 → 收窄依赖 → 删除旧路径。缺陷修复另列提交；纯移动允许较大的移动 diff，但必须能解释可见性、模块声明和调用路径变化。Google 的小变更实践也强调概念聚焦，并建议把大规模重构与功能/缺陷修改分开。[^R03]

---

## 4. 对仓库既有架构规范的保留与修订

`BACKEND_ARCHITECTURE.md` 已经总结了有价值的经验：一个 crate、渐进移动、完整扫描调用者、包含验收测试、运行检查器不能硬编码 `world.rs`、热路径后置。保留这些经验，但其中一些断言应从绝对规则改为可验证的工程约束。[^S18]

| 既有说法或做法 | 新计划的取舍 |
| --- | --- |
| `#[path]` + `impl World` 是低风险搬移办法 | **保留为过渡工具**；不把它当成最终业务隔离的证明 |
| 改成目录必然改变可见性 | **修订**：文件系统位置与 Rust 逻辑模块树不是一回事。保持逻辑模块树即可保留访问关系。本轮不搬目录是收益不足，而非语言限制 |
| 拆出函数统一 `pub(super)` | 保留确有外部调用的方法；仅内部辅助函数保持私有。新增业务边界仍要审查暴露范围 |
| 公开类型不能迁移 | 不做无收益迁移；必要时审查 re-export、公开路径与调用方，不能把“永远不能移”当语言事实 |
| 归一化后每行在新文件中存在即可证明纯移动 | **加强**：行集合不能证明顺序、重复次数、条件或调用位置不变。按函数块/语法结构比较，并验证相对语句顺序 |
| 编译通过且失败数没变即可接受 | **加强**：还要比对失败身份、消息形状、事务结果、测试是否真正执行 |
| 跨 `features → network/session` 一律违规 | 按实际导入能力判断；当前 EntryView 只导入 `authenticate`，应把认证 API 与实时连接生命周期分开，而不是笼统禁止 feature 使用任何网络能力 |

Rust 官方规则是：私有项可由当前模块及其后代访问。因此多个 `world` 子模块共享父模块私有状态是实际语言行为，不会因为文件变小自动消失。[^R04]

---

## 5. 目标架构：保持运行模型，只缩小修改影响面

### 5.1 服务端逻辑关系

```text
main.rs                            进程组装、配置、启动
   │
network.rs                         HTTP/WS 校验、认证、输入投递
   │ 已验证的游戏意图
   ▼
World                              当前权威世界、输入消费、固定步长调度
   │
   ├─ 业务用例协调                  world 子模块中的 handle_* 等入口
   │    ├─ 任务交互与领奖            quest.rs
   │    ├─ 拾取/使用/丢弃            inventory_ops.rs
   │    ├─ 商店/仓库                 trade.rs
   │    └─ 社交/聊天/切图/复活       沿用已拆模块
   │
   ├─ 规则与事实                    现有 inventory/combat/mage + 新抽取的纯规则
   │                               不持有 World、连接或 SQLite 句柄
   │
   └─ 明确的持久化事务入口           现有 auth::Store 外观
        └─ 现有 auth/* 实现         保留事务与幂等记录，逐步澄清职责
```

这是一张建议依赖图，不是声称当前所有箭头都已被编译器强制执行。`combat.rs` 在已读 `world.rs` 中通过 `crate::combat` 引用；文档表格中的 `world::combat` 路径需要与实际模块声明统一。[^S03][^S18]

### 5.2 状态与写入权限

| 状态 | 权威所有者/事实来源 | 对其他模块开放的能力 | 禁止的做法 |
| --- | --- | --- | --- |
| 玩家位置、怪物、当前地图实体 | World 模拟 | 查询快照、接收合法命令、受控迁移 | 网络连接任务直接改集合 |
| 金币、物品、角色长期进度 | 对应持久化事务与权威内存投影 | 完整用例入口、提交结果、必要回填 | 多个 helper 各自提交一半事务 |
| requestId 结果 | 现有内存窗口及适用的 SQLite 幂等记录 | 查询既有结果、返回一致回执 | 仅靠客户端禁用按钮防重 |
| 配置、技能目录、地图定义 | 启动时读取校验的内容 | 只读查询与版本身份 | 每次攻击重新读取原始资源 |
| 客户端人物状态 | 服务端消息的显示投影 | 显示、可撤销预测、意图构造 | UI 自行确认发奖或任务完成 |
| 窗口焦点、拖拽、提示 | 对应 UI 模块 | 交互状态和清理函数 | 混入服务端存档模型 |

“持久化事务和权威内存投影”不能变成两个可独立结算的事实来源。每个用例必须写清先后关系及持久化失败、回填失败和断线恢复策略。

### 5.3 前端目标关系

```text
app/main.ts                     应用启动和显式组装
  ├─ network/session.ts         实时连接、重连、收发
  ├─ network/auth-api.ts        [拟新增] 认证 HTTP 请求
  ├─ features/entry             登录/选角/创角界面
  ├─ scenes/world.ts            当前地图 Scene 组装、重启和视图调度
  │    └─ features/*/view        已有玩家/怪物/NPC/战斗/水体等表现
  └─ features/inventory         背包 UI 的门面、交互、渲染与提示

shared/protocol.ts              已有前端契约入口
assets 中的叶子类型/纯函数       不反向依赖 entry 的实现
```

保留现有 `app/i18n.ts` 等公共工具的实际用途，不能因为路径在 `app/` 就全盘禁止导入；规则应区分**组装入口**与**无启动副作用的工具**。

---

## 6. 服务端第一试点：将任务纯规则从 World 中真正分离

### 6.1 源文件、边界和拟新增文件

**已存在**：`server/src/quest.rs`、`server/src/world.rs`，以及 auth 已声明的 `auth/quests.rs`。  
**拟新增**：`server/src/quest_rules.rs`；只有任务文案职责仍足够复杂时，再新增 `server/src/quest_presenter.rs`。

第一步只抽取纯判定/归一化函数，不迁移奖励事务、经验入账、传送和 NPC 会话。

| 当前函数族 | 第一阶段落点 | 保护重点 |
| --- | --- | --- |
| `quest_jobs_match` | `quest_rules` 纯函数 | 空职业条件的含义保持不变 |
| `quest_prerequisites_match` | `quest_rules` 纯函数 | AND/OR、缺省状态、空前置集合的现有含义 |
| `quest_conditions_match` | `quest_rules` 纯函数 | 等级、背包材料、已穿装备分别判定 |
| `quest_consume_items` | `quest_rules` 归一化 | 数组、`false`、缺省以及解析失败的原有回退 |
| `quest_objective_*` / `quest_summary` | 先保留；后续区分查询和文案 | 多语言、未知 ID 兜底和完成状态 |
| `handle_quest_interact` / `apply_quest_effect_at` | 继续留在用例协调边界 | 不因抽规则改变事务及回执顺序 |

上述真实函数和分工可以在当前 `quest.rs` 中定位。[^S06]

### 6.2 输入只提供必要事实

以下是**接口草案，不是可直接粘贴进现有仓库的补丁**：

```rust
// 拟新增的只读输入；字段类型在实施时复用现有定义。
struct QuestFacts<'a> {
    level: u32,
    job: u32,
    quests: &'a QuestProgress,
    inventory: &'a [InventoryItem],
    equipped: &'a [InventoryItem],
}

fn conditions_match(facts: &QuestFacts<'_>, conditions: &QuestConditions) -> bool;
```

这里的 `QuestProgress` 等名称只是表示需要复用/定义的类型，不声称仓库已有同名结构。不要复制整个 `Player`，不要在这个事实视图里放 `World`、`Store` 或任意可变引用。

可以先保留原 `World::quest_*` 方法作为短期转发层，稳定现有调用和测试；迁移完成后删除无价值转发。规则模块不应再通过 `use super::*` 隐式拿到整个世界，应列出必要 import，并通过测试/检查禁止 `World`、`Store` 和网络依赖。

### 6.3 必须新增或复用的用例

覆盖前置任务 AND/OR、空条件、未接受任务、重复提交、材料刚好够/不足、已装备物品计数、消耗配置为 `false`、未知任务、配置解析回退，以及任务内容版本不一致。

测试应同时区分：**保持旧行为的特征测试**与**发现不符合产品规则的缺陷测试**。后者单独修复，不能夹在机械搬移中改变规则。

### 6.4 验收

纯规则测试不需要启动服务、构造 WebSocket 或打开 SQLite；所有已迁移函数对固定输入的新旧结果一致。任务协调入口仍负责完整结算，没有新增绕过背包容量或幂等检查的发奖路径。

---

## 7. 背包、任务奖励、商店：拆职责但不拆事务

### 7.1 当前已有的承重设计

`inventory_ops.rs` 的 `handle_pickup` 已包含：查询 `prior_pickup`、地图/归属/距离校验、容量处理、调用 `Store::pickup`、移除世界掉落、重新读取角色相关持久化状态、回填玩家等步骤。该模块文档也明确了 requestId 幂等与世界副作用。[^S05]

因此不是从零引入幂等或事务；本计划首先**保留和验证既有机制**。

### 7.2 建议的职责切分

```text
一次物品/任务意图
    ↓
协调入口验证会话、位置、阶段和已有请求结果
    ↓
纯规则生成可验证的方案（不执行副作用）
    ↓
现有 Store 事务：再次验证持久化事实、提交资产与幂等结果
    ↓
按既有约定回填世界状态/地面掉落/派生属性
    ↓
发送结果及必要快照
```

这张图描述目标职责，不授权在一次搬移中重排当前实现。实施前必须读完具体方法的成功、失败和恢复分支，再确定迁移边界。

特别是“事务已成功，但重新读取/内存回填失败”“事务已成功，但网络发送失败”“重连再次提交同 requestId”三个窗口，必须有明确定义。当前已读拾取片段中，持久化成功后的掉落移除和 profile 重读正是需要完整核对的区域；**这不是已经确认资产丢失的结论**。

### 7.3 实施规则

- 复用 `inventory.rs` 的堆叠、容量与装备实例规则，不在新模块复制一份。
- 协调入口可以操作世界，但规则 helper 只处理背包/装备/材料所需的数据。
- 纯计划不是永久有效的授权；提交时必须基于仍然有效的权威事实重新检查，或在同一受控执行边界内应用。
- `Store` 的一个业务事务不能被拆成多个各自提交的“repository 调用”。
- 原有 requestId 的角色范围、操作范围、过期方式和返回内容保持不变；若发现缺陷另开修复。
- 回执不能早于要求持久化成功的资产提交。输出缓冲失败不能导致重复发奖。
- 不用全局事件总线驱动同步事务；事务之后的提示与可重建展示可以使用明确的结果对象。
- 不默认增加 outbox、消息队列或统一事件溯源。仅在有可复现的持久化/投递需求时单独设计。

### 7.4 对 auth::Store 的渐进整理

先按现有 `auth/bag.rs`、`auth/loot.rs`、`auth/quests.rs` 等模块梳理方法与事务，不新建平行的 `InventoryStore`、`QuestStore` 各自管理 SQLite 连接。

`auth.rs` 的认证会话与游戏持久化可以逐步获得不同的公开能力入口；最初只限制调用范围，保持 `Store` 的既有调用签名和数据格式。待某组方法稳定、调用者收敛后，再评估是否将持久化命名从 `auth` 移出。**这不是第一轮必须完成的目录重命名工程。**

本轮不把同步 SQLite 调用直接改为 `tokio::spawn`。若测量显示 Store 阻塞模拟，再单独设计工作队列、同角色顺序、待提交状态和完成消息；仅把代码放进后台任务会引入新的重入与顺序问题。

---

## 8. 前端第一试点：背包 UI 从“大类”变成可维护的局部模块

### 8.1 当前代码与应保留的优点

`features/inventory/view.ts` 已经通过 `send: (ClientMessage) => boolean` 接收发送能力，而不是自己创建 `Connection`。这一点应保留。当前类同时持有背包/装备窗口、tooltip、拖拽、窗口位置、请求序号、pending scroll、容量投影和全局监听，适合从这里做前端职责拆分。[^S13]

特别注意：当前可视页签顺序不是 `inventoryType = tab + 1`。源码映射为 `1, 2, 4, 3, 5`，拆分时不能顺手“简化”。数量、冷却与容量继续由服务端决定，前端只是显示与意图。[^S13]

### 8.2 文件级拆分建议

下表新文件都为**拟新增**；实施前检查是否已被后续提交创建，已有则复用。

| 路径 | 职责 | 不拥有 |
| --- | --- | --- |
| `features/inventory/view.ts`（保留） | 对外 `InventoryView` 门面、组装、状态输入、统一销毁 | 具体 tooltip 模板和全部拖拽分支 |
| `features/inventory/view-model.ts` | 服务端投影到页签/格子/装备展示的纯转换 | DOM、连接、资产结算 |
| `features/inventory/drag-controller.ts` | 物品拖放与拖放取消，输出用户意图 | 服务端槽位真值、金币真值 |
| `features/inventory/tooltip-view.ts` | 提示显示、焦点/悬停状态、定时器 | 物品数据来源和发奖 |
| `features/inventory/equipment-view.ts` | 装备窗口 DOM 与受控交互 | 背包整体 requestId 生成器 |
| `features/inventory/intents.ts`（需要时） | 从交互构造有类型的协议意图 | 自己创建 WebSocket、绕过服务端校验 |

不要将所有私有字段原样搬进 `InventoryContext`，再把这个对象传给每个新文件；那只是换了名字的大类。每个子模块只取得必要的 state、DOM host 和少量 callback。

### 8.3 迁移顺序与退出条件

先抽纯展示转换，验证页签、槽位、堆叠与装备实例；再抽 tooltip；然后抽拖拽和装备窗口；最后让原类只保留组装与对外 API。

必须保持 WZ 提供的坐标、尺寸、origin、页签顺序和交互语义。不改布局风格，不重新设计装备属性，不在同一个提交重构 CSS。

验收覆盖：小/大背包、页签切换、槽位不足、使用道具、卷轴目标取消、拖出丢弃、装备与背包交换、金币确认、请求未完成时关闭窗口、销毁后重建、缺失资源导致初始化提前返回。最后一个场景要检查已注册的 document 监听是否仍能清理。

---

## 9. 两个具体依赖问题：精确解决，不扩大化

### 9.1 manifest ↔ appearance：是类型依赖环，不等于运行期循环故障

实际双向边：

```text
assets/manifest.ts
  └─ import type AppearanceCatalog from features/entry/appearance

features/entry/appearance.ts
  └─ import type Frame / Part / AvatarActionSet from assets/manifest
```

两条都是 `import type`。TypeScript 会擦除这类导入，因此单靠这个环不能推导出运行期初始化错误。它仍暴露了“资源类型定义反向依赖登录 feature 实现”的组织问题。[^S09][^S10][^R05]

建议新增一个小而明确的资源类型叶子模块，例如 `assets/avatar-types.ts`，放入相互关联的纸娃娃帧/部件/动作集/外观目录类型，让 `manifest.ts` 与 `appearance.ts` 都依赖它。

**不能只把 `AppearanceCatalog` 搬到新文件，再让新文件 import `manifest.ts`、而 `manifest.ts` 又 import 新文件；那只是把同一个环换了名字。** 必须检查完整依赖图，而不是仅看两行 import。

`manifest.ts` 还存在对 `features/player/animation.ts` 的运行期 `frameAt` 引用。实施时检查该函数和所有调用点；若确实是公共纯时序算法，可放入更低层的纯函数模块，由两个调用者使用。不要仅为“方向好看”复制算法。[^S09]

### 9.2 EntryView → session：真正耦合的是认证 helper 与实时连接同文件

`EntryView` 实际导入 `authenticate`；`network/session.ts` 同时定义认证 HTTP 函数和 `Connection`。不应把它描述为“EntryView 已经直接管理 WebSocket 生命周期”。[^S11][^S12]

建议将认证函数机械迁移到**拟新增** `network/auth-api.ts`，保留参数、错误和版本检查语义。EntryView 调用认证能力；应用装配继续拥有实时 Connection。无需为只有一个实现的函数增加一套 `IAuthRepository/IAuthService/IAuthGateway`。

顺带将依赖规则调整为：feature 不直接拥有/启动全局实时连接；可以通过明确 API 适配层执行本 feature 所需请求。

### 9.3 单独登记的可疑逻辑：不要夹带修复

已读 `Connection.connect()` 中先设置 `stopped = false`，随后调用会设置 `stopped = true` 的 `close()`；`scheduleReconnect()` 又以 `stopped` 决定是否重试。从已读代码看，这个顺序值得验证自动重连是否会被抑制。[^S12]

这是**静态审查发现，尚未浏览器复现**。在拆分认证 helper 前补充断线重试与主动关闭的测试；若证实缺陷，单独提交修复，不把行为改变藏在“移动文件”提交中。

---

## 10. 应用装配与 Phaser 生命周期：后续阶段的主要前端工程

### 10.1 不重做已有 feature

`scenes/world.ts` 已导入 PlayerView、MonsterView、NpcView、PortalView、ReactorView、WaterView、CombatView 等。无需再建一套平行的 player/mob/NPC 管理器。当前优先候选是尚集中在 Scene 内的资源收集、地图图层表现，以及地图切换时的清理协调。[^S08]

`app/main.ts` 已有 `generation`、`portalSequence`、`skillRequestSequence`、窗口引用、ResizeObserver、Escape router 清理函数等。先确认这些机制的所有调用点，再抽取，不能丢失已有防过期响应与销毁逻辑。[^S07]

### 10.2 生命周期表

| 作用域 | 例子 | 生命周期结束时 | 不应连带销毁 |
| --- | --- | --- | --- |
| 页面/App | 页面 shell、语言切换、全局消息区域 | 页面卸载/完整应用 teardown 时清理 | 不用每次切图重建整个页面 |
| 登录会话 | Connection、角色选择结果、待确认请求 | 登出、身份终止时处理 | 不因 Phaser Scene restart 关闭登录会话 |
| 地图激活周期 | 当前实体视图、地图订阅、BGM、图层实例 | 切图/Scene shutdown 时结束 | 不释放仍被其他用途共享的全局纹理 |
| 窗口实例 | tooltip、DOM 监听、拖拽、ResizeObserver | 窗口销毁；关闭是否保留按已有语义 | 不清空同一 host 下其他窗口 |
| 短时表现 | 浮字、投射物、临时提示 | 到期/取消/所属作用域结束 | 不修改服务端资产和任务状态 |

Phaser 的 `SHUTDOWN` 不等于永久 `DESTROY`；Scene 可以再次启动。清理设计必须支持反复进入与退出，不能只监听最终 destroy。[^R06]

### 10.3 建议拆分点

- **拟新增 `assets/preload-plan.ts`**：从 manifest 收集需要加载的资源，纯函数输出计划；Scene 执行 Phaser loader。第一轮保留现有全量预加载策略、顺序和去重语义，不同时改成懒加载。
- **拟新增 `app/page-shell.ts`**：现有页面结构、新闻弹窗和页面模式切换；保持现有 DOM ID、可访问性与布局。
- **拟新增 `app/game-session.ts`，仅在生命周期清楚后**：封装一次会话的组装和拆卸，返回明确的更新入口及 teardown；不把 main 的全部变量原样塞进另一个大文件。
- 地图图层和实体集合只有在职责仍过大时才抽取；复用当前 feature views。
- 使用已有 generation/revision 保护异步结果；需要取消的请求只取消当前作用域拥有的工作，不粗暴清空共享缓存。

### 10.4 HMR 与当前启动链分开看

现有 `启动3010.command` 运行的是构建后的 `client/dist-tms273`，不能假设通过它启动就启用了 Vite HMR。当前任务保留这条集成路径，不把接入新的开发端口或完整 HMR 系统列为重构前置。[^S20]

未来若引入 HMR，应使用 Vite 的 dispose 等生命周期入口清理模块副作用，并验证旧会话、监听和计时器是否残留；这属于单独的开发工作流变更。[^R07]

---

## 11. 真实分层之后，再处理 World 剩余类型与热路径

已读 `world.rs` 中还存在 Ladder、ReactorPlacement、ReactorInstance、WaterRect、Map 等定义及部分几何/加载逻辑。这说明剩余 World 不只是命令分发，还承载内容结构、几何计算和实体状态。[^S14]

### 11.1 优先候选：纯几何和数据校验

在规则试点成功后，可以评估**拟新增** `world_geometry.rs`：梯子端点、边界计算、水底插值、纯形状校验等。先保持类型公开路径或通过合适的 re-export 兼容；不在同一提交修改物理算法和浮点容差。

`Map::load` 同时涉及文件读取和校验时，应区分“读取字节/解析配置”和“校验结构”这两个可独立测试的步骤，但不立即改存储格式或资源组织。

### 11.2 最后处理的内容

移动与碰撞、Tick 调度、伤害结算、状态效果、跨地图切换，以及涉及长时间 away/residency 的行为，必须建立可重复输入与时间推进测试后再调整。

当前 `TICK_MS = 50`，源码同时有 600 秒完整保留和 3600 秒总离开界限等策略常量。它们是当前实现事实，不是本计划要更改的产品参数。[^S03]

重构不能把“计时器位置变了”变成“规则时钟变了”：保留 Tick、`Instant`、持久化时间和客户端展示剩余时间各自的用途。也不应在热路径抽取时改变随机数调用次数或集合遍历顺序。

性能验证记录相同内容、实体数、连接数和硬件条件下的 Tick 时长、排队延迟、Store 调用耗时和快照开销。先获得分布再设容差，不编造当前 p95/p99，也不承诺拆文件本身加速。

---

## 12. 分阶段实施与文件级任务

所有阶段以交付物和验收条件推进，不按未经估算的天数承诺。已经完成的子模块迁移不重新记为待办。

| 编号 | 工作 | 主要现有文件 | 拟新增/更新产物 | 依赖与退出条件 |
| --- | --- | --- | --- | --- |
| R0 | 固定基准、刷新文件/依赖/调用者清单 | `scripts/refactor_audit.cjs`、现有报告 | 带 commit/hash 的新报告、已完成迁移清单 | 完整检出可读；不编造缺失指标 |
| R1 | 复跑并分类已有失败，修复前端检查装载与汇总 | `client/package.json`、`dialogue.check.mjs`、相关验收测试 | 检查 runner、精确失败登记 | R0；所有检查都会执行，最终退出码可信 |
| R2 | 让报告区分类型/运行期依赖 | `refactor_audit.cjs` | AST 依赖分析、增量门禁设计 | R0；用已知 type-only 环等 fixture 自测 |
| R3 | 抽取任务纯规则 | `quest.rs`、必要的 `world.rs` 模块声明 | `quest_rules.rs` 与纯测试 | R1；相关测试全绿，无事务/协议变化 |
| R4 | 拆出背包展示转换与 tooltip | `features/inventory/view.ts`、现有检查 | `view-model.ts`、`tooltip-view.ts` | R1；原界面与消息一致，无额外监听 |
| R5 | 整理资源类型依赖与认证 helper | manifest、appearance、entry view、network session | `avatar-types.ts`、`auth-api.ts` | R1/R2；类型环真正消除，不改变连接行为 |
| R6 | 收窄一条物品/任务用例的规则输入 | `inventory_ops.rs`、`inventory.rs`、相关 auth 模块 | 窄输入/结果与事务时序说明 | R3；成功/失败/重放/回填失败均有保护 |
| R7 | 完成背包交互职责拆分 | inventory view 与 R4 新模块 | drag/equipment 等按需模块 | R4；一个对外门面，没有共享巨型 Context |
| R8 | 梳理 App/Session/Scene 作用域与资源计划 | `app/main.ts`、`scenes/world.ts` | page shell、preload plan 等 | R1/R4/R5；切图/重连/重建回归通过 |
| R9 | 试点纯几何与内容校验抽离 | `world.rs`、相关接受测试 | 按需 `world_geometry.rs` | R3/R6；几何与运动结果一致 |
| R10 | 规则落入 CI，更新架构导航与例外 | 审计脚本、实际 CI、前后端架构文档 | 新增 `--check`、例外登记、模块契约 | 试点完成；新增越界失败，历史债务不自动扩张 |
| R11 | 按当前业务热点继续治理 | 刷新后的排名与变化需求 | 下一批小任务 | 不继续使用本表旧行数；每次重新排序 |

### 12.1 每个任务的固定提交结构

```text
A. test:     为目标现有行为建立可运行的保护
B. refactor: 只移动代码或建立兼容转发，不改规则
C. refactor: 收窄依赖与状态访问，逐个迁移调用者
D. cleanup:  删除旧路径与临时包装，更新模块说明和门禁
```

任务很小时 A/B 可以合并，但缺陷修复不得伪装成纯移动。每个提交都应可构建、可解释；不能要求等一整串未合并提交齐全后才恢复工作。

### 12.2 首批最值得做的三个交付

**第一批：R0/R1，得到可信的失败基线与完整测试执行。**  
**第二批：R3，证明一个服务端规则模块不再依赖整个世界。**  
**第三批：R4，证明一个前端窗口职责可以拆分而不复制状态和监听。**

R5 可以在独立分支并行，但不要让多人同时改 `world.rs` 的模块声明或 `app/main.ts` 的装配逻辑。

---

## 13. 本地执行命令与验证纪律

### 13.1 开始前记录身份，不重置用户工作树

以下命令均从项目根目录运行。先查看本地变更，不自动 stash、reset、切分支或覆盖用户文件。

```bash
git status --short
git rev-parse HEAD
node --version
npm --version
cargo --version

# 现有审计命令：会写 artifacts/refactor/*.json，不修改业务源码。
node scripts/refactor_audit.cjs --sizes
node scripts/refactor_audit.cjs --deps
```

若本地 HEAD 已前进，不强行退回本文提交；记录新基准并重新核对已经迁移的文件。若历史不足 100 次提交，churn 必须附带实际覆盖范围。

### 13.2 已存在的前端检查入口

```bash
npm --prefix client run typecheck
npm --prefix client run check
npm --prefix client run check:inventory
```

这些命令在当前 `package.json` 中存在。`check:inventory` 的脚本是否需要服务或资产，实施前读其前置条件；不能从命令名推断为纯离线。`check` 目前会在已知失败处提前中断，R1 修复前不得声称后续检查都执行。[^S01]

### 13.3 服务端检查

```bash
# 沿用仓库基线记录的离线测试方式；若依赖未缓存，记录 blocked，
# 不把环境失败算成测试通过，也不擅自升级依赖。
cargo test --offline --manifest-path server/Cargo.toml

# 标准静态检查；先建立同命令的既有基线。
cargo check --offline --manifest-path server/Cargo.toml
cargo fmt --manifest-path server/Cargo.toml -- --check
```

不一开始对全库加入 `-D warnings`，导致遗留 warning 阻断所有低风险重构。先记录同一命令的警告，再对新增/迁移模块实行增量治理。

### 13.4 集成运行

```bash
./启动3010.command
```

该脚本会构建并重启服务，因此仅在需要集成验收时执行。它会使用现有 SQLite 数据库和可用的陪测 bot 凭据；不为重构测试删除数据库、重置账号或伪造新用户数据。隔离测试使用测试自有临时数据库，不污染真实账号。[^S20]

不得：手工改 `client/dist-tms273`、直接运行另一个长期 `cargo run` 服务、临时占用其他游戏端口绕过脚本，或把构建失败后的旧实例误认为新版成功。

**拟新增的 `--check`、全量检查 runner 等能力，只有实现并验证后才加入执行清单。**

---

## 14. 回归矩阵：保护冒险岛实际行为

| 领域 | 最低场景 | 要比较的结果 |
| --- | --- | --- |
| 认证与会话 | 注册/登录、选角、主动关闭、异常断线、被替代会话、重连 | 身份不串、连接数量、终止与重试区别、版本拒绝 |
| 背包与资产 | 满包、不同页签、装备实例、使用、拖动、丢弃、拾取、丢金币 | 实际库存、金币、实例属性、错误码、请求结果 |
| 幂等与持久化 | 同 ID 连续重放、重连重放、两个角色争抢掉落、Store 失败、提交后回填失败 | 不重复扣发、旧结果一致、失败不产生半份可见资产 |
| 任务 | AND/OR 前置、等级/职业、材料与装备条件、重复交付、奖励容量不足、传送效果 | 进度、扣除、奖励、经验、位置与回执一致 |
| 地图与移动 | 上下平台、斜坡、竖向阻挡、梯子/绳、下跳、水域、传送门 | 位置/速度/grounded/动作/落点；不改现有碰撞哲学 |
| 战斗与状态 | 攻击事件、技能等级、冷却、持续效果、死亡、复活、Boss 差异 | 伤害、资源消耗、随机调用与事件顺序、幂等 |
| 多人可见性 | 两个真实协议客户端同图、切图、掉落归属、聊天/组队 | 各自快照范围、实体身份、权限和消息扇出 |
| 生命周期 | 连续切图、窗口反复开关/销毁、资源加载失败、旧请求晚到 | 监听/计时器/视图数量不持续增长，旧结果不污染新作用域 |
| 后台保留 | 页面失焦、恢复、达到各保留阶段、断线后恢复 | 保留策略不因 UI/Scene 重构而变化 |
| 启动链 | 检查失败、构建失败、成功重启、health 版本 | 未构建成功不杀旧服务，新版本身份可确认 |

纯规则比较可使用固定时间和随机种子；最终权威行为测试通过正常请求进入世界，而不是直接修改服务器状态制造“通过”。

截图适合验证 UI 外观，但不能代替请求幂等、库存守恒、连接生命周期或数据库事务断言。反过来，类型检查和单元测试也不能证明页面没有重复监听或资源泄漏。

---

## 15. 门禁：让大文件不再长回去

### 15.1 沿用预算，改变应用方式

现有审计策略为 TS/JS 600 预警、1000 需解释、1500 阻断；Rust 800、1200、1500。这是项目预算，不是行业标准。建议暂时沿用数值，先修复“对谁生效、如何退出”的机制。[^S17]

| 对象 | 建议门禁 |
| --- | --- |
| 新生产文件 | 超预警提示，超解释阈值要求职责说明，超硬阈值必须有受审例外 |
| 已知超大文件 | 基于本次任务 merge-base 的版本，不允许无解释净增长；测试、必要错误处理和过渡转发可有小范围例外 |
| 真正生成文件 | 免业务代码行数门禁，但必须有来源/生成命令/版本，可检查再生成差异 |
| 纯数据/fixture | 单独治理解析、体积、加载和可追溯性；不以加空行或压缩 JSON 美化指标 |
| 测试代码 | 不与生产热点混排，但不永久豁免复杂度和维护成本 |
| 文档/报告 | 独立规则，不以生产代码行数阻断 |

不能为了减少生产文件行数将逻辑挪进 `utils.ts`、`common.rs` 或测试文件；也不能仅加 `@generated` 就逃避检查。

### 15.2 第一批依赖门禁

- 纯规则模块禁止依赖 `World`、SQLite、网络及平台 UI。
- feature 禁止导入 `app/main.ts` 或创建新的全局 Connection；允许明确的 API 函数与纯工具。
- 资源类型叶子模块不能反向依赖页面、Scene 和 feature 实现。
- 新增运行期依赖环阻断；类型环独立报告并按明确策略治理。
- 迁移后的领域内部实现不通过全库 `pub(crate)` 批量暴露。
- 测试依赖图和生产依赖图分别报告，`include!` 与 `#[path]` 必须纳入 Rust 审计口径。
- 源码字符串扫描只能作辅助，不能把测试里的同名字面量误当生产实现；长期用结构化检查与行为验证替代硬编码路径检查。

### 15.3 例外必须可退出

**拟新增** `artifacts/refactor/debt-register.json`，或复用仓库已有同等机制。每项记录范围、基准提交、理由、负责人/维护角色、退出条件和复查日期。不得通过自动更新基线来接受新的失败或无界增长。

首轮成功指标不是“所有文件小于 500 行”，而是：

```text
新增回归 = 0（按身份和错误特征验证）
目标规则模块不依赖整个 World
同一资产操作只有一条权威提交路径
前端作用域能明确销毁与重建
新增运行期依赖环 = 0
旧入口与临时转发有删除记录
```

---

## 16. 回滚与风险控制

机械迁移应保持协议、存档结构、配置 ID 和资产事务语义不变，以便按提交回滚。不要在这个阶段做数据库列删除、协议版本升级、消息字段重命名或大规模目录迁移。

| 风险 | 避免方式 | 触发暂停的信号 |
| --- | --- | --- |
| 看似拆文件，实际改变调用顺序 | 函数块/语句顺序比较，固定输入对照 | 相同输入产生不同状态、消息或随机数消耗 |
| 世界状态被复制为两份 | 写入权限表、单一提交路径 | 新旧模块各自持有可写库存/任务副本 |
| 数据库提交后内存不同步 | 错误窗口测试与恢复策略 | 回执成功但后续快照/重连资产不一致 |
| 为编译放宽大量可见性 | 限定 import 与审查公开面 | 大量新增 `pub(crate)`、全局 Context |
| 场景拆分造成资源泄漏 | 作用域销毁、重复进入退出测试 | 监听、计时器、连接或旧地图实例持续增长 |
| 测试实际上没执行 | 汇总 runner、退出码与用例数检查 | 首项失败后其余测试静默消失 |
| 重构与玩法开发互相覆盖 | 小提交、明确文件所有者、合并后重跑 | 多人并行修改同一 World/App 入口 |

回滚只回滚本任务可识别的提交，不自动回退真实数据库，不使用 `git reset --hard` 清理用户工作。若某次变更需要数据迁移，它必须有独立备份与前后兼容方案，不能沿用“纯代码回滚”的假设。

---

## 17. 给本地编码执行者的任务模板

```text
任务：实施 R<编号>，只完成该编号范围。

先读：
1. 当前 HEAD 与未提交变更。
2. 目标生产文件、全部调用点、相关 *_acceptance/check 文件。
3. 实际启动脚本和相关源检查器。
4. 已登记失败基线；本任务相关失败必须先说明。

交付：
- 当前职责、输入输出、状态读写和事务/生命周期边界。
- 一次只做一种变化的小提交。
- 新增/复用的测试及实际运行命令与结果。
- 迁移前后接口、消息、存档格式未改变的证据。
- 仍有风险、未执行项目和明确回滚点。

禁止：
- 按旧文档猜文件存在；已有同等模块必须复用。
- 只按行号切段、创建 WorldPart1/WorldPart2。
- 把 World/View 全部字段复制进万能 Context。
- 为通过检查删除测试、改弱断言或自动接纳新失败。
- 顺手改伤害、任务奖励、碰撞、协议或 SQL schema。
- 手改 dist-tms273；绕过启动3010.command 启动长期服务。

完成定义：
- 当前任务的行为测试通过；无新增未解释失败。
- 依赖或状态边界实质变小，而不只是文件行数下降。
- 文档反映已合并状态，未完成项保持明确标识。
```

若多人或 AI 并行，建议分工为“审计/测试”“任务纯规则”“背包 UI”；`world.rs` 模块挂载、`app/main.ts` 装配和共享契约由一个集成人串行合并。这里是实施组织建议，不表示本轮已经启动多个代理或修改仓库。

---

## 18. 最终完成定义与本轮验证记录

### 18.1 整体完成定义

当以下问题能以源码和测试回答，才算这轮架构重构取得实质收益：

- 修改一个任务条件，是否无需理解 World 的连接、掉落、全部技能和 SQLite 实现？
- 修改一个背包 tooltip，是否无需碰 requestId、拖拽和窗口创建流程？
- 一次拾取/任务领奖失败，是否知道哪一步已经持久化、哪一步可重试？
- 切图或重建 UI 时，是否知道谁负责清理、哪些资源仍然共享？
- 新增文件越界或新增依赖环，是否有真正返回失败的检查，而不是只打印一行日志？

**最终目标：减少每次变更需要同时理解的东西，同时保住权威规则、事务一致性与可回归性。文件变小是结果，不是唯一验收标准。**

### 18.2 本轮实际完成/未完成

| 项目 | 本轮状态 |
| --- | --- |
| 固定提交下的关键源码、模块声明、前后端包配置 | 已读取 |
| 已有审计脚本、报告、失败基线与启动脚本 | 已读取 |
| 外部工程实践与框架文档 | 已核对，见引用 |
| 全仓库逐函数审计与当前尺寸重算 | 未执行；R0 中完成 |
| Cargo / TypeScript / Node 检查 | 未在本轮运行 |
| 3010 启动、多人联机、浏览器与性能测试 | 未在本轮运行 |
| 修改仓库、创建 PR、改变账号或数据库 | 未执行 |
| 仓库复核版 Markdown 计划 | 本文 |

---

## 参考来源

### 仓库证据（均固定到同一提交）

[^S01]: [client/package.json](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/client/package.json)：Phaser/TS/Vite 版本和已有检查命令。
[^S02]: [server/Cargo.toml](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/server/Cargo.toml)：真实服务端依赖。
[^S03]: [server/src/world.rs，开头模块声明与常量](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/server/src/world.rs#L1-L155)：当前子模块、crate::combat 引用、Tick 与 away 策略。
[^S04]: [server/src/auth.rs，开头定义](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/server/src/auth.rs#L1-L160)：现有 auth 子模块、Store、Profile。
[^S05]: [server/src/inventory_ops.rs，模块说明与拾取流程](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/server/src/inventory_ops.rs#L1-L180)：impl World、幂等、Store 提交与回填。
[^S06]: [server/src/quest.rs，模块说明与规则](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/server/src/quest.rs#L1-L210)：真实任务规则、文案与协调职责。
[^S07]: [client/src/app/main.ts，入口和状态](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/client/src/app/main.ts#L1-L190)：窗口/Phaser/Connection 装配及生命周期相关变量。
[^S08]: [client/src/scenes/world.ts，Scene、切图和预加载](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/client/src/scenes/world.ts#L1-L190)：已有 feature views 和剩余职责。
[^S09]: [client/src/assets/manifest.ts](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/client/src/assets/manifest.ts#L1-L130)：类型反向依赖和 frameAt 引用。
[^S10]: [client/src/features/entry/appearance.ts](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/client/src/features/entry/appearance.ts)：import type 与外观目录定义。
[^S11]: [client/src/features/entry/view.ts](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/client/src/features/entry/view.ts#L1-L80)：实际导入 authenticate，而非自行持有 Connection。
[^S12]: [client/src/network/session.ts](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/client/src/network/session.ts)：认证与实时连接同文件；connect/close/reconnect 逻辑。
[^S13]: [client/src/features/inventory/view.ts](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/client/src/features/inventory/view.ts#L1-L155)：窗口/交互/监听字段和页签类型映射。
[^S14]: [server/src/world.rs，几何与地图定义片段](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/server/src/world.rs#L480-L720)：Ladder、Reactor、WaterRect、Map。
[^S15]: [artifacts/refactor/baseline-metrics.json](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/artifacts/refactor/baseline-metrics.json)：2026-09-12 仓库记录的命令、失败、未测项目和运行身份缺口。
[^S16]: [artifacts/refactor/large-files.json](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/artifacts/refactor/large-files.json)：已提交尺寸报告、扫描口径、数据分类与 churn。不是本轮重新扫描。
[^S17]: [scripts/refactor_audit.cjs](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/scripts/refactor_audit.cjs)：真实参数、预算、分类、正则依赖分析与报告输出行为。
[^S18]: [BACKEND_ARCHITECTURE.md](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/BACKEND_ARCHITECTURE.md)：单世界方向、现有模块清单及渐进拆分规范；个别路径/绝对表述需以源码与 Rust 规则修订。
[^S19]: [FRONTEND_ARCHITECTURE.md](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/FRONTEND_ARCHITECTURE.md)：Phaser/TS 前端方向、轻量 feature 组织与生命周期。
[^S20]: [启动3010.command](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/%E5%90%AF%E5%8A%A83010.command)：构建后重启、固定 3010、资源/数据库/health 和陪测 bot 行为。
[^S21]: [shared/protocol.ts](https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/shared/protocol.ts#L1-L80)：当前前端契约入口、版本号和权威状态展示字段。

### 外部工程实践（2026-09-12 核对）

[^R01]: Martin Fowler, [Monolith First](https://martinfowler.com/bliki/MonolithFirst.html)。借鉴先在单体内寻找边界；这是工程经验与取舍，不是所有系统必须采用单体的定律。
[^R02]: Martin Fowler, [Branch By Abstraction](https://martinfowler.com/bliki/BranchByAbstraction.html)。在稳定交互边界之后渐进替换实现，迁移完成再删除临时层。
[^R03]: Google Engineering Practices, [Small CLs](https://google.github.io/eng-practices/review/developer/small-cls.html)。小而自洽的变更、相关测试与重构/缺陷修复分离。
[^R04]: Rust Reference, [Visibility and privacy](https://doc.rust-lang.org/reference/visibility-and-privacy.html)。逻辑模块层级、后代对私有项的访问与受限可见性。
[^R05]: TypeScript 官方文档, [TypeScript 3.8 — Type-Only Imports and Export](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-8.html)。`import type`/`export type` 会从输出中擦除；据此区分类型图与运行期图。
[^R06]: Phaser 官方 API, [Scenes.Events](https://docs.phaser.io/api-documentation/event/scenes-events)。Scene 的 SHUTDOWN 与 DESTROY 生命周期不同，前者可能再次启动。
[^R07]: Vite 官方文档, [HMR API](https://vite.dev/guide/api-hmr)。dispose 等入口用于处理热更新副作用；不代表当前构建预览链已经启用 HMR。
