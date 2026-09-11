# 可变状态的所有权

> 对应 `MapleStory_Large_File_Refactoring_Plan.md` §4.3、§7.3、§8.1。
> 记录日期：2026-09-12。来源：真实源码读取，不是设计意图。
> **拆业务职责 ≠ 拆开本来必须一起提交的状态。** 本表用于在搬迁代码时判断「谁能写」。

## 1. 服务端：权威状态

| 状态 | 所有者（唯一写入者） | 位置 | 性质 |
| --- | --- | --- | --- |
| 权威世界状态 | `World`（`&mut self` 方法链，由 Tick 与命令分派串行驱动） | `server/src/world.rs` | 内存中的**权威事实**：`players`/`monsters`/`drops*`/`parties`/`reactors`/`boss_practices` 等 40+ 个 `BTreeMap` |
| 每个角色的会话事实 | 同上，写在 `Player` 上 | `World.players: BTreeMap<String, Player>` | 位置、HP/MP、背包镜像、`blocked`、以及**幂等窗口与速率桶**（`chat_recent`、`chat_tokens`、`chat_bucket_tick`、`whisper_recent`、`emoticon_recent`、`emoticon_sends`） |
| 消息序号 | 同上，写在 `World` 上 | `chat_sequence` / `whisper_sequence` / `emoticon_sequence` | 单调、进程内不重置；保证重连后消息 id 仍唯一 |
| 表情目录 | 同上，构造期展平一次 | `World.emoticon_ids: BTreeSet<String>`（来源 `Gameplay.emoticons`） | 只读事实，房间热路径不扫目录 |
| 规则输入（不可变） | 构造期装配，运行期只读 | `World.gameplay: Gameplay`、`World.mage_skills`、`World.combat`、`World.map`/`maps` | 内容配置与规则表 |
| 持久化 | `auth::Store`（SQLite） | `server/src/auth.rs` | 权威**记录**；`World.store: Option<Store>` |
| 网络会话 | `server/src/network.rs` + `auth::AuthService` | — | 连接与认证，不持有玩法状态 |

### 1.1 单写者现状（保守陈述）

`World` 的玩法方法都是 `&mut self`，因此在一个世界实例内是**串行**的。
本轮**没有做线程模型审计**：是否存在绕过 `World` 的并发写入、`Store` 是否在多个世界实例间共享连接，均标「未测」。
按计划 §4.3，在查清之前**不宣称**已经具备单写者保证，也不据此新增 `Arc<Mutex<World>>`。

### 1.2 「内存已应用」与「持久化已提交」是两个不同的词

| 词 | 含义 | 现状 |
| --- | --- | --- |
| AppliedEffects | 内存中的权威状态已改变，客户端可见 | 大多数即时操作（聊天/密语/表情/移动）到此为止 |
| DurableCommitted | 已写入 SQLite 并且事务提交 | 角色存档、背包、仓库、好友、任务等经 `Store` 的操作 |

注意 `Store::save_profile` **不是 upsert**，也不写背包（只 `UPDATE player_stats`）。
经济类操作沿用既有持久化边界，本轮不统一事件模型、不升级事务粒度（计划 §7.3）。

## 2. 客户端：四类状态必须分开（计划 §8.1）

| 状态 | 写入负责人 | 本项目实现位置 | 硬约束 |
| --- | --- | --- | --- |
| 服务器权威状态的客户端投影 | 网络状态应用入口 | `client/src/network/session.ts` → `client/src/scenes/world.ts::receive` | UI 与渲染器不得任意改写 |
| 本地预测 / 待确认输入 | 输入子模块 | `client/src/features/player/input.ts` | 与服务器确认状态分离，支持纠正 |
| 纯 UI 状态 | 各自功能面板 | `client/src/features/*/view.ts`（如 `InventoryView`） | 不伪装成服务器事实 |
| 表现与资源状态 | 视图/渲染生命周期负责人 | `client/src/scenes/world.ts`（Phaser 场景）+ `client/src/assets/manifest.ts` | 不作为判断伤害与发奖的权威依据 |

**实测偏差**：`client/src/features/entry/view.ts` 直接 import `client/src/network/session.ts`（见
`module-boundaries.md`），即一个功能面板伸手拿到了连接实现，属于第一类与第三类状态的边界模糊。

## 3. 从本表推出的搬迁规则

1. 搬代码时**不动数据布局**：`Player` 上的字段留在 `Player`，`World` 上的字段留在 `World`。
   （这正是 `world.rs` 通讯职责能被安全搬走的原因：搬的是方法，不是状态。）
2. 需要「哪些改变要一起成立」的协调责任，属于**用例**，不属于任何一个业务模块
   （计划 §7.2 的领奖例子：任务判定归任务模块、容量归背包模块、原子性归用例）。
3. 表现层热更新保留连接时，不得重复订阅或重复发送命令；快照只保存可安全恢复的本地表现信息，
   **不得写回服务器当作真值**（计划 §8.2）。
