# 超大文件审计（P0）

> 对应 `MapleStory_Large_File_Refactoring_Plan.md` §3。
> 审计日期：2026-09-12。数据来自 `scripts/refactor_audit.cjs` 的**真实扫描**
> （产物：`artifacts/refactor/large-files.json`、`frontend-deps.json`、`baseline-metrics.json`）。
> 本文不含估算数字；未测量的项明确写「未测」。

## 1. 口径与限制（先说清楚，避免被误引）

- 扫描范围：Git 已跟踪 + 未忽略的未跟踪文件，扩展名 `.rs .ts .tsx .js .jsx .mjs .cjs .md .json .css .scss .glsl .wgsl .html`。
- 排除目录：`node_modules` / `target` / `dist*` / `参考` / `resources` / `output` / `evidence` / `public-tms273` / `.git` 等。
- `physical_lines`、`nonblank_lines` **不是 SLOC**，未剔除注释。行数只是「预警与讨论入口」，不是业务边界判据。
- `churn_last_100_commits` = 最近 100 次提交中触及该文件的提交数。本仓库**总共只有 52 次提交**，
  因此这个窗口实际覆盖了绝大部分历史；机械变更（清理副本、格式化）与业务变更未分离，只作为辅助信号。
- 行数预算沿用计划 §14.1 的建议值（TS/JS 600/1000/1500；Rust 800/1200/1500）。
  计划没有给 md 定预算，本项目对文档沿用同一口径，**这是本项目决定，不是计划原文**。

## 2. 分类实况（计划 §3.1 的六类，实测计数）

| 分类 | 文件数 | 合计行数 | 判定分布 |
| --- | --- | --- | --- |
| 手写业务代码/未分类 | 212 | 89,047 | block 3 / needs-justification 6 / warn 21 / ok 182 |
| 数据或配置（`.json`） | 46 | 2,142,631 | 全部豁免（数据文件，按数据治理，不按行数拆） |
| 测试与样本 | 65 | 14,194 | 全部豁免（`*_acceptance.rs`、`*.check.mjs`） |
| 生成物候选（含 `@generated` 类标记） | 0 | — | 本仓库未发现带生成标记的手写文件 |
| 构建产物 | — | — | 按设计排除（`dist*`），未纳入行数治理 |
| 第三方代码 | — | — | 按设计排除（`node_modules`、`参考/`） |

**总扫描 326 个文件，0 条读取警告。**

### 2.1 iCloud 冲突副本（卫生问题，非行数问题）

扫描发现 3 个「已跟踪、被 iCloud 同步分裂出的带空格副本」，且原文件时间戳更新（副本是陈旧重复物）：

```
client/src/features/loading/style 2.css        （原文件 style.css      更新）
client/src/features/loading/view 2.ts          （原文件 view.ts        更新）
client/src/features/loading/view.check 2.mjs   （原文件 view.check.mjs 更新）
```

它们都在 `tsc` 的扫描范围内（类型检查仍通过，因为每个 `.ts` 是独立模块），不被任何 import 引用。
仓库已有一笔同类清理提交（`chore: 清理历史遗留的带空格后缀副本文件`）。**本轮未删除**（删除已跟踪文件需你确认）。

## 3. 热点清单

按计划 §3.3 的「高频修改、跨职责牵连、可测试切口」综合排序：

| 真实路径 | 类别 / 行数 | 修改热点证据 | 混合职责 | 写状态范围 | 首个提取点 | 验证方式 | 优先级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `server/src/world.rs` | 手写 / 23,992（block）→ 治理后 **18,978** | **churn 36/100**，全仓第 1 | 拆出 5 块后仍剩：权威状态持有 + Tick 调度 + 技能施法（≈4,400）、怪物与掉落（≈2,000），`impl World` 仍单块 | 整个世界：`players`、`monsters`、`drops*`、`parties`、`reactors`、`boss_practices`… 共 40+ 个 `BTreeMap` | 通讯（§4.1）→ 背包物品（§4.2）→ 社交（§4.3）→ 交易（§4.4）→ 任务（§4.5）已完成 | 24 个既有 `*_acceptance.rs` | **P1（进行中）** |
| `server/src/auth.rs` | 手写 / **8,410**（block） | churn 17/100，第 3 | 持久化（SQLite `Store`）+ 会话/身份 + **领域规则**（四转/超技 SP 计算、技能书、组队经验加成、仓库）+ 30 余个 DTO | `Store` 连接与事务，以及各 `*Outcome` | 四转/超技 SP 规则（纯计算） | `third_store_acceptance.rs` 等（当前有既有失败） | P2 |
| `client/src/features/inventory/view.ts` | 手写 / **1,640**（block） | churn 13/100，客户端第 1 | 单个 `InventoryView` 类同时管页签、网格、拖拽、提示、金币、渲染与出站消息 | DOM 树 + 拖拽 payload + 请求序号 | 页签/分类映射与网格渲染 | `scripts/check_inventory.mjs` | P2 |
| `server/src/protocol.rs` | 手写 / 1,032（warn） | churn **21/100**，第 2 | Wire DTO + 解析/校验 + `valid()` 形状校验 | 无状态（纯类型与校验） | 不建议拆：它是协议契约面，拆开反而增加同步成本 | — | P3（保持单文件） |
| `client/src/scenes/world.ts` | 手写 / 781（warn） | churn **22/100** | Phaser 场景装配 + 快照驱动视图分发 + 输入接线 | Phaser 场景与子系统 | 先做依赖收窄，不先搬文件 | `portal.check.mjs` | P2 |
| `client/src/app/main.ts` | 手写 / 686（warn） | churn **24/100**，客户端第 1 热点 | 组合装配 + 生命周期 + 结果分发 | 全局装配关系 | 装配点收敛（计划 §8.3） | `viewport.check.mjs`、`chat-focus.check.mjs` | P2 |
| `client/src/features/skills/view.ts` | 手写 / 1,034（需解释） | churn 4/100 | 技能窗渲染 | DOM | 暂不拆（职责已单一，仅偏大） | `skills/view.check.mjs` | P3 |
| `server/src/inventory.rs` | 手写 / 1,217（需解释） | churn 10/100 | 物品目录读取 + 槽位/堆叠规则 + 扩容 | 无自有状态（规则 + 目录） | 推荐作为 `auth.rs` 的规则出口参照 | `inventory_acceptance.rs` | P2 |
| `server/src/boss.rs` | 手写 / 1,201（需解释） | churn 2/100 | 已拆出的 Boss 试炼（**既有的成功先例**） | 通过 `impl World` 访问世界 | 已拆完 | `boss_acceptance.rs` | 已完成 |

### 3.1 前三个候选为什么值得拆

1. **`world.rs`**：24k 行、`impl World` 单块 20,900 行、churn 第 1。改任务条件、改技能数值、改聊天规则、
   改背包协议全落在同一个文件里——正是计划要消灭的「一次修改要理解整个世界」。
   它同时是**当前功能仍在高速发展**的文件（最近 15 次提交里 12 次含 `feat`/`fix`）。
2. **`auth.rs`**：它把「持久化」和「领域规则」混在一起。四转 SP 表、技能书分组、超技前置属于**可以纯计算、无需数据库**的规则，
   却和 `rusqlite` 连接、事务、会话放在同一文件。拆开能让规则脱离 SQLite 测试。
3. **`client/features/inventory/view.ts`**：单类 1,640 行且 churn 客户端第 1，是典型的「一个类承担一个面板的全部」。

### 3.2 为什么不从这些地方先动

- `protocol.rs`（churn 21）：它是**契约面**。拆开会让 Rust 与 `shared/protocol.ts` 的同步成本上升，收益为负。
- `client/app/main.ts`、`client/scenes/world.ts`（churn 22–24）：它们是**装配点**，先做依赖收窄（见 `module-boundaries.md`），
  不先搬文件。
- 战斗 Tick 与跨图迁移：计划 §3.3 明确建议不从这里动刀，且失败代价最高。`world.rs` 内部它们排最后。

## 4. 本轮确定的第一个试点：`world.rs` 的通讯职责

**范围**：`handle_chat` / `handle_whisper` / `whisper_echo` / `whisper_reject` / `chat_reject` /
`chat_consume_token` / `handle_emoticon` / `emoticon_consume_budget`，以及 `EmoticonCatalogue` /
`EmoticonLimit` 两个源数据结构和 5 个通讯策略常量（约 600 行）。

**为什么是它**（逐条对应计划判据）：

| 判据 | 本试点的实况 |
| --- | --- |
| 计划点名的低回归路径 | 计划 §3.3 举例就是「聊天格式转换」 |
| 职责完整、边界清楚 | 三个聊天面（地图聊天 = 房间事实、密语 = 点对点事实、表情 = 目录 id 事实）共用同一套速率与幂等规则 |
| 有既有行为测试 | `chat_acceptance.rs`(6) + `whisper_acceptance.rs`(10) + `emoticon_acceptance.rs`(6) = **22 项**，全部会在拆分前先跑绿 |
| 不碰热路径 | 不涉及 Tick 伤害结算、移动、存档写入 |
| 不碰协议/存档 | 零协议变体、零持久化字段变化（计划硬约束 §1.2） |
| 有现成机制可循 | `world.rs` 已有 `#[path = "boss.rs"] mod boss;` + `use super::*;` + `impl World` 的成功先例 |

**状态所有者不变**：`chat_tokens` / `chat_bucket_tick` / `chat_recent` / `whisper_recent` /
`emoticon_recent` / `emoticon_sends` 仍留在 `Player` 上，`chat_sequence` / `whisper_sequence` /
`emoticon_sequence` / `emoticon_ids` 仍留在 `World` 上。拆分只搬代码位置，不动数据布局（计划 §6.1）。

### 4.1 执行结果（已完成）

| 项 | 结果 |
| --- | --- |
| 新模块 | `server/src/messaging.rs`，挂载方式沿用既有先例 `#[path = "messaging.rs"] mod messaging;` |
| 搬移内容 | 8 个方法 + 5 个策略常量，共 **542 行** |
| 搬移保真度 | 与移除区段做逐行 `diff`：**542 行完全一致**，唯一差异是截取范围末尾的一个空行 |
| 可见性变化（必要的路径变化） | 3 个入口 `handle_chat` / `handle_whisper` / `handle_emoticon` 由私有 `fn` 改为 `pub(super) fn`（`world.rs` 的命令分派需要调用，与 `boss.rs` 先例一致）；5 个常量改为 `pub(super) const` |
| 兼容处理 | `world.rs` 的 `chat_tokens: CHAT_TOKEN_BURST` 改为 `messaging::CHAT_TOKEN_BURST`；`mod tests` 加一行 `use super::messaging::*;` 使既有 `*_acceptance.rs` 的裸名引用继续成立 |
| 有意**不搬**的东西 | `EmoticonCatalogue` / `EmoticonLimit` 留在 `world.rs`：它们是 `Gameplay.emoticons`（公开字段）的类型，搬进私有子模块会让公开接口引用更窄可见的类型（E0446），绕开它只能是净损失 |
| `world.rs` 行数 | 23,992 → **23,436**（仍远超 1500 阻断线，`impl World` 仍是单块，**记为过渡状态**，不是治理完成） |
| 定向验证 | chat / whisper / emoticon 三个职责全部通过 |
| 全量回归 | `cargo test --offline` **292 过 / 6 失败**，失败集与基线**逐条一致，零回归** |
| 编译警告 | 改动前 43 → 改动后 **43**，零新增 |
| 前端 | 未改任何 `client/**` 源码；`tsc --noEmit` 仍为 exit 0 |

### 4.2 第二个机械拆分（背包与物品职责，已完成）

选它是因为 §4 的判据逐条仍然成立，且它正是 §4.1 末尾列出的头号候选（≈1,350 行）。

| 项 | 结果 |
| --- | --- |
| 新模块 | `server/src/inventory_ops.rs`，挂载 `#[path = "inventory_ops.rs"] mod inventory_ops;`（紧随 messaging 之后） |
| 搬移内容 | 8 个 `pub(super)` 入口方法（`handle_pickup` / `handle_inventory_move` / `handle_inventory_drop` / `equipment_stats` / `handle_inventory_gather` / `handle_inventory_sort` / `handle_use_item` / `handle_drop_mesos`）+ 6 个仅模块内私有的辅助函数（`plan_map_move` / `land_player_on_return_map` / `send_inventory_conflict` / `send_inventory_outcome` / `ensure_inventory_drop` / `ensure_inventory_drop_at`），共 **1,444 行** |
| 搬移保真度 | 与移除区段（原 `world.rs` 9947–11389）做逐行 `diff`：**1,444 行完全一致** |
| 可见性变化 | 仅 8 个入口由私有 `fn` 改 `pub(super) fn`（`world.rs` 的命令分派要调用）。`handle_inventory_compact` 一度被放宽，grep 证实它只被本模块内的 gather/sort 调用，**已回退为私有 `fn`**——没有外部调用者，就不放宽 |
| 状态与协议 | `Player` 的背包/装备/金币字段全部原地不动；零协议变体、零存档字段变化、零客户端改动 |
| `world.rs` 行数 | 23,436 → **21,992**（本轮两步合计 23,992 → 21,992，**-2,000 行**；仍在 1500 阻断线之上，`impl World` 仍是单块 ⇒ 继续记为过渡状态） |
| 定向验证 | 背包/拾取/装备/整理/用道具/丢金币相关用例全通过 |
| 全量回归 | `cargo test --offline` **292 过 / 6 失败**，失败集与基线逐条一致，零回归 |
| 编译警告 | 43 → **43**，零新增 |

**连带修复（启动阻断）**：拆分后用户双击 `启动3010.command` 报
`AssertionError: server never sends emoticon_unknown`（`scripts/check_tms273_runtime.cjs:447`）。
根因是校验脚本硬编码只读 `server/src/world.rs`，而被检查的字面量已随拆分搬进 `messaging.rs`。
已改为递归读取 `server/src/**/*.rs` 中**全部生产代码**（显式排除 `*_acceptance.rs`，因为它们同样含这些字面量、
会让断言假通过），三处断言点统一走该来源。反向验证：若把 `*_acceptance.rs` 纳入，则 `"emoticon_unknown"`
在测试文件中也能命中、断言失去意义——排除是**承重**的，不是顺手优化。

### 4.3 第三个机械拆分（社交职责，已完成）

选它的理由：§4 判据逐条成立，且组队与好友/黑名单共用"关系事实 + requestId 幂等重放"这一套模式，
边界完整（13209–14010 行的连续区段），且既有 `party_acceptance.rs`（party）与 `friend_acceptance.rs`（friend）两套行为测试。

| 项 | 结果 |
| --- | --- |
| 新模块 | `server/src/social.rs`，挂载 `#[path = "social.rs"] mod social;`（紧随 inventory_ops 之后） |
| 搬移内容 | **36 个方法 + 2 段职责横幅注释**（组队 14 + 好友/黑名单 22），共 **812 行**，外补 `impl World { … }` 外壳后 842 行 |
| 搬移保真度 | 归一化逐行断言：**775 个有效行零丢失**；唯一允许差异是入口的 `pub(super)` 前缀 |
| 可见性 | 入口集合由**脚本自动推导**（区段内函数名在全部 `server/src/**/*.rs` 的词边界匹配），不是手列——最终 **16 个** `pub(super) fn`，20 个保持私有 |
| 为什么必须自动推导 | 手列清单只扫 `world.rs` 会漏两类真实调用：`party_acceptance.rs` 直调 `world.party_id_of(...)`（8 处）、`messaging.rs` 调 `resolve_friend_name`（密语按好友名找人）。手列 14 个、实际需要 **16 个**，差的 2 个就是这么漏的 |
| 状态与协议 | `World.parties` / `friend_links` / `friend_roster` 与 `Player.blocked` 等全部原地不动；零协议变体、零存档字段变化、零客户端改动 |
| `world.rs` 行数 | 21,993 → **21,182**（三次拆分合计 23,993 → 21,182，**-2,811 行**） |
| 全量回归 | `cargo test --offline` **292 过 / 6 失败**，失败集与基线逐条一致，零回归 |
| 编译警告 | 同一命令前后对比：`cargo build` **10 → 10**、`cargo test` **44 → 44**，零新增 |
| 模块文档 | 8 行头部注明负责 / 不负责，并点明 `messaging` 的扇出过滤 ↔ 本模块 `reload_blocked` 的分工 |

**教训（已写进 `BACKEND_ARCHITECTURE.md` §2.2 第 3、8 条）**：
"外部引用探测"的范围必须覆盖**全部** `server/src/**/*.rs`——`*_acceptance.rs` 是 `include!` 进
`world::tests` 的，它们对 `world.` 方法名的直调同样是外部调用点。这与 `check_tms273_runtime.cjs`
硬编码文件名是**同一类错误**：只看主文件、不看测试文件与其他子模块。

### 4.4 第四个机械拆分（交易职责，已完成）

选它的理由：§4 判据成立，商店与账号仓库共用"与 NPC 的钱物交换 + 事务先行 + requestId 幂等"这一套模式，
且既有 `shop_sell_acceptance.rs` 与 `storage_acceptance.rs` 两套行为测试兜底。
社交拆走后，商店/仓库区段与仓库收尾 helper 在文件里**恰好相邻**，因此仍是一个连续区段。

| 项 | 结果 |
| --- | --- |
| 新模块 | `server/src/trade.rs`，挂载 `#[path = "trade.rs"] mod trade;`（紧随 social 之后） |
| 搬移内容 | **13 个方法**：商店买入 / 卖出（含 4 个卖出回执 helper）、仓库开仓 / 转账 / 金币（含 4 个回执 helper、keeper 距离复核、转账副作用重读），共 **776 行**，外补 `impl World { … }` 外壳后 800 行 |
| 搬移保真度 | 归一化逐行断言：**764 个有效行零丢失**；唯一允许差异是入口的 `pub(super)` 前缀 |
| 可见性 | 自动推导出 **6 个** `pub(super) fn`（全部是命令分派入口：`handle_shop_buy` / `handle_shop_sell` / `close_storage` / `handle_storage_open` / `handle_storage_transfer` / `handle_storage_mesos`），其余 7 个保持私有 |
| 独立复核 | 编译前用第二次全仓 grep 复核：7 个 send/reload helper 确实**只在模块内部**被调用，6 个入口的推导没有漏 |
| 状态与协议 | `Player` / `World` 字段原地不动；零协议变体、零存档字段变化、零客户端改动 |
| `world.rs` 行数 | 21,182 → **20,407**（四次拆分合计 23,993 → 20,407，**-3,586 行**） |
| 全量回归 | `cargo test --offline` **292 过 / 6 失败**，失败集与基线逐条一致，零回归 |
| 编译警告 | 同命令前后对比：`cargo build` **10 → 10**、`cargo test` **44 → 44**，零新增 |

### 4.5 第五个机械拆分（任务职责，已完成）

选它的理由：§4 判据成立，任务是最大的"非每帧行为"职责（≈1,430 行），且有
`chapter_acceptance.rs` / `continuation_acceptance.rs` / `quest_store_acceptance.rs` 兜底。
它与击杀/拾取进度的耦合被证实是**单向的**：事件 handler 留在 `world.rs` / `inventory_ops`，调用任务侧的纯判定函数。

| 项 | 结果 |
| --- | --- |
| 新模块 | `server/src/quest.rs`，挂载 `#[path = "quest.rs"] mod quest;`（紧随 trade 之后） |
| 搬移内容 | **29 个函数**：任务规则纯判定（`quest_*` 静态函数）、NPC 菜单 / 条目 / 日志、`handle_quest_interact` / `handle_quest_npc_menu` / `apply_quest_effect_at`，以及经验入账 `add_exp`，共 **1,430 行**，外补 `impl World { … }` 外壳后 1,454 行 |
| 搬移保真度 | 归一化逐行断言：**1,396 个有效行零丢失** |
| 可见性 | 自动推导 **12 个** `pub(super) fn`；其余 17 个保持私有 |
| 推导再次立功 | `add_exp` 在 **`auth.rs`（7 处）与 `third/fourth_store_acceptance.rs`** 也有引用——只扫 `world.rs` 必漏。核实后确认那是 `auth.rs:5974` 的**同名不同签名**函数（吃 `Profile`，crate 级；world 版吃 `PlayerState`），属于无害的误报放宽；`pub(super)` 本就不改变可达范围 |
| 自由函数不失联的原因 | world.rs 对这些静态函数的调用全部写成 `Self::add_exp(...)` / `World::quest_consume_items(...)` —— 关联函数走**类型解析**，与定义所在模块无关；只有裸名调用才会因搬移失联 |
| `world.rs` 行数 | 20,407 → **18,978**（五次拆分合计 23,993 → 18,978，**-5,015 行**） |
| 全量回归 | `cargo test --offline` **292 过 / 6 失败**，失败集与基线逐条一致，零回归 |
| 编译警告 | 同命令前后对比：`cargo build` **10 → 10**、`cargo test` **44 → 44**，零新增 |

**下一步（候选，尚未开始）**：怪物与掉落（≈2,000 行，含 `respawn_monsters` ≈1,300 行的巨型函数，需先拆函数再拆模块）；
技能施法（≈4,400 行，热路径，最后拆）；`auth.rs` 8,410 行是下一个超大文件；
客户端 `features/inventory/view.ts` 单类拆分；客户端既有的 1 处循环与 1 处越界依赖（见 `module-boundaries.md`）。

## 5. 已知缺陷与既有失败（与重构分开记录）

服务端 `cargo test --offline`：**292 过 / 6 失败**，失败集与项目既有基线逐条一致（详见 `baseline-metrics.json`）。

前端 `npm run check`：**16 过 / 1 失败**——`features/npc/dialogue.check.mjs` 的 data: URL 载体无法解析
`../inventory/names` 相对导入。这是 **harness 限制，不是被测代码错**。新增的 check 必须排在这一步之前。

这些失败是**基线**，不是本轮回归，也不在本轮顺手修（计划 §1.2：业务修复与结构迁移分开提交）。

## 6. 文档（md）也按同一口径治理

用户要求「无论 Rust / JS / TS / Three.js 代码还是 md 文件都按这个规则」。本项目未给 md 定过预算，
沿用 TS/JS 口径（600 / 1000 / 1500）后，实测超出预警线的文档：

| 文档 | 行数 | churn | 性质 | 处置建议 |
| --- | --- | --- | --- | --- |
| `PLAN.md` | 1,193 → **已拆** | **29/100** | 按时间倒序的**完成记录台账**，每完成一件事追加一节 | **已完成**（见 §6.1）。拆成 `PLAN.md`（只放当前目标与待办，36 行）+ `docs/history/plan/NN-<日期>-<主题>.md`（66 篇，逐字保留原文）+ `docs/history/plan/INDEX.md`（归档索引） |
| `IMPLEMENTATION_STATUS.md` | 738（预警） | 16/100 | 历史台账 | 同上，与 PLAN.md 一起处理，避免造出第三份台账 |
| `MapleStory_Rust_Chat_Ops_Development_Plan.md` | 1,379（需解释） | 1/100 | 一次性开发方案（已完成使命） | 可整体移入 `docs/history/` 归档 |
| `世界意识/*.md`（3 篇） | 890–1,095 | 0/100 | 设计文档 | 设计类文档天然偏长，**按内容分节**即可，不按行数机械拆 |
| `bugfix/*.md` | 311–963 | 0–1/100 | 已修复问题的方案与记录 | 修完后归档到 `docs/history/` |

**本轮已按同一口径产出**：`docs/architecture/`（3 篇，每篇只讲一件事）、`docs/dev/current-entry-audit.md`、
`server/src/messaging.rs` / `server/src/inventory_ops.rs` / `server/src/social.rs` / `server/src/trade.rs` 的模块文档
（即计划 §16 要求的「迁移模块短 README」）、`BACKEND_ARCHITECTURE.md` §2（真实模块清单 + 拆分规范）。

### 6.1 PLAN.md 拆分结果（已完成）

用户要求 md 也按同一规则，故对 PLAN.md 执行了与代码同构的拆分：**不改写任何已完成条目、只搬位置**。

| 项 | 结果 |
| --- | --- |
| 拆分前 | 1,193 行 / 66 个 `##` 小节（每节 = 一次完成的开发批次，倒序累积） |
| 拆分后 `PLAN.md` | **36 行**：只留「待你确认或操作」「待统一加载 3010 后实玩（最近一批）」两节 + 索引指针 |
| 归档 | `docs/history/plan/` 下 **66 篇**，文件名 `NN-<日期>-<主题>.md`，前缀沿用 PLAN.md 原有倒序号（01 = 最近完成） |
| 保真度 | 每篇 = 原标题 + 原有正文逐字 + 3 行来源标注（归档自 PLAN.md / 归档位置 / 归档顺序），**正文零改写**（合计 1,192 行原文） |
| 索引 | `docs/history/plan/INDEX.md`（75 行）：保留 `# / 日期 / 主题 / 归档` 四列表格，链接改为同目录相对路径 |
| 链接校验 | 脚本对 66 条链接逐条 `fs.existsSync` 断言，**缺失 0** |
| 为什么留索引在独立文件 | 66 行表格留在 PLAN.md 会让「当前目标」文档重新膨胀；索引是导航不是目标，独立成篇 |

**与代码拆分的同构点**：都是「机械搬移 + 保留原文 + 用脚本自断言保证零丢失」，都先跑基线再动、结束后
用可运行的检查证明结果（代码侧 = `cargo test` 失败集不变，文档侧 = 66 条链接全部命中）。

## 7. 未测项（明确标记，不以 0 代替）

- 服务端 Tick 的 p50/p95/p99、命令队列长度、CPU/内存：**未测**。
- 客户端帧时、首屏/切图时间、活动连接数：**未测**。
- 冷构建耗时、增量构建耗时：**未测**。
- `vite build` 产物大小与分包情况：**未测**。
- 运行期真实循环依赖（本轮只做静态正则图）：**部分测**，见 `frontend-deps.json` 的 limitations。
