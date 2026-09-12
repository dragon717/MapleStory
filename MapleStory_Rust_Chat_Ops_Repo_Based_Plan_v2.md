# 冒险岛复刻：聊天、通知、审计与 GM 开发计划 v2

> **仓库实勘版｜2026-09-12｜计划，不是已实施补丁**  
> 仓库：`dragon717/MapleStory`；基线分支：`main`。  
> 固定提交：`1fefe97c2d27a928f3bf670b657d79f68d795fe9`。  
> 提交时间：2026-09-12 04:29:55 UTC / 13:29:55 Asia/Tokyo。  
> 当前协议：`PROTOCOL_VERSION = 13`；内容版本：`tms273-9`。  
> 推荐落库位置：确认采用后替换仓库根目录的 `MapleStory_Rust_Chat_Ops_Development_Plan.md`。本次没有提交 GitHub、修改源代码或修改数据库。

## 0. 结论与阅读约定

**不是重建一套聊天平台，而是把已经存在的聊天闭环修正确，再沿现有权威世界增加运营能力，最后建设真正的多频道和跨服通信。**

本次已经通过 GitHub 读取固定提交中的网络入口、世界状态、聊天处理器、认证与部分事务、前端聊天视图、协议、启动脚本和测试基线记录。没有在本次环境运行游戏、编译或执行测试；文中的缺陷分为“源码可直接定位的控制流问题”和“需要新增测试验证的风险”，不把静态审查写成运行时复现。

本文引用：`[Rxx]` 为固定提交的仓库证据，`[Sxx]` 为官方工程资料，完整索引在第 20 节。代码类型、表结构、参数和新文件均是**设计草案**，不是仓库中已经存在的实现。原有数值用“现状”标记；新增容量和门槛用“建议起点”标记。

实施主线：

```text
P0  当前聊天正确性、恢复与基线
 → P1 单进程消息投递、结构化系统消息、前端状态
 → P2 持久公告 / 跑马灯 / 禁言 / 审计 / 只读 GM
 → P2b 可恢复的资产类 GM 和付费喇叭
 → P3 真实多频道、跨频道聊天
 → P4 跨进程与跨区服通信
```

P3、P4 不作为当前地图聊天上线的前置条件；P2b 不在持久化一致性尚未解决时抢跑。

---

## 1. 真实工程架构：从这里改，不从通用模板改

### 1.1 当前调用链

```text
client/src/features/chat/view.ts
  └─ ChatViewHooks.send / sendWhisper
       └─ client/src/app/main.ts 的装配
            └─ client/src/network/session.ts / Connection.send
                 └─ WebSocket /ws
                      └─ server/src/network.rs
                           Hello → VerifyCharacter → 绑定 id + connection
                           ClientMessage 反序列化、形状校验、入站限制
                           → world::Command::Input
                                └─ World 唯一拥有运行时玩家状态
                                     └─ world::messaging
                                          handle_chat / handle_whisper / handle_emoticon
                                          → Player.output.try_send(String)
                                               └─ network.rs socket_loop
                                                    └─ 客户端消息分派与 DOM 展示
```

这是根据源码梳理的职责链，不代表本次做了端到端运行跟踪。[R01][R02][R03][R04][R11][R13][R14]

### 1.2 必须继承的工程选择

| 维度 | 已确认现状 | 本计划决定 |
|---|---|---|
| 后端 | 一个 Rust crate；Axum、Tokio、rusqlite、SQLite | 不先拆微服务，不换 SQLx/PostgreSQL，不引入完整 ECS |
| 世界状态 | `World` 内持有玩家、地图、怪物、掉落、组队等状态；`TICK_MS = 50` | 玩法与权限相关状态由所属权威循环写入 |
| 世界模块拆分 | `world.rs` 用 `#[path = "messaging.rs"] mod messaging;` 等挂载同目录子模块 | 新世界职责沿用此方式；不是给每个名词建 crate 或空目录 |
| 数据库模块拆分 | `auth.rs` 已有 `auth/schema.rs`、`auth/bag.rs`、`auth/friends.rs` 等 | 数据库新职责放入现有 `auth/` 体系；不能误称整个后端都是扁平文件 |
| 前端 | Phaser 3.90.0 + TypeScript + Vite，聊天为 DOM 组件 | 保留现有聊天 UI、原生输入框、焦点和资源；不改 Three.js/React |
| 协议 | Rust 与 `shared/protocol.ts` 双端声明；入站 `deny_unknown_fields` | 保留严格契约，新增消息同步双端和校验用例 |
| 启动 | `启动3010.command` 先检查资源、构建两端，成功后重启 | 日常启动和最终验收仍用此脚本；不另起一套 3000/3011 工作流 |
| 数据 | `server/data/tms273.sqlite3`，保留既有账号与角色 | 不删库重建；迁移先在备份副本验证 |

依赖版本来自 `Cargo.toml` / `package.json`，不冒充已检查 Cargo.lock 的精确解析版本。[R01][R03][R07][R15][R16][R17][R18]

### 1.3 九类需求的现状

| 需求 | 固定提交的证据 | 状态与正确下一步 |
|---|---|---|
| 私聊 | `WhisperSend`、`handle_whisper`、ChatView 密语模式 | **已实现基础闭环**；修复可达性、回执重放、满队列处理 |
| 公共聊天 | `ChatSend`、`handle_chat`，按玩家当前 `map_id` 扇出 | **已实现地图公共聊天**；先补稳定消息身份、失败结果和实例边界测试 |
| 跨频道聊天 | 大厅 `CHANNEL_ID = 1`；main 只装配一个 World | **不能算已实现**；先建设真实频道与权威路由，不能拿跨地图充数 |
| 跨服聊天 | 当前没有跨节点路由装配，也没有总线依赖 | **后续能力**；先完成区服命名空间、可信路由和接收者鉴权 |
| 跑马灯 | 已读通知目录只有 `away.ts`、`death.ts` | **没有读到统一跑马灯实现**；新增公告展示投影，复用现有通知容器 |
| 系统公告 | `app/main.ts` 有 news/status 展示，但不是持久公告控制面 | **已有界面基础，不等于公告服务**；补发布、修改、撤回、过期、登录补取 |
| 系统消息 | `rejected`、各业务回执、`appendSystem`、状态提示 | **分散存在**；统一描述和展示策略，不把游戏结算改成聊天字符串 |
| 操作日志 | SQLite 已有 `inventory_actions`、`storage_actions` 等 | **已有业务幂等/结果记录**；补审计上下文和查询投影，不另建第二份资产真相 |
| GM 命令 | 已读 `ClientMessage` / `Command` / main 路由没有管理入口，Identity 没有权限字段 | **需要建立受控入口**；先只读、禁言、公告，再开放资产修改 |

“没有读到”限定在本次核查的生产入口、协议、模块和目录，不以一次关键字搜索无结果代替全仓库证明。[R01]–[R17][R22][R23]

### 1.4 纠正文档与源码不一致

`server/README.md` 仍有“没有真实聊天业务”“连接断开 despawn”等旧描述；实际 `messaging.rs` 已有聊天，`network.rs` 已区分 Detach 与 Exit。因此本计划以固定提交代码优先，不能继续把旧 README 当实施状态。[R02][R04][R21]

`BACKEND_ARCHITECTURE.md` 的拆分规范可继承，但其模块表需要补上最新的 `dialogue`、`portals`、`growth`、`revive`，并准确描述现有 `auth/` 子模块。[R03][R07][R18]

---

## 2. 先修这些具体问题

### 2.1 风险登记

| 编号 | 已读代码中的问题 | 影响 | 优先级 / 验证方式 |
|---|---|---|---|
| F01 | `Connection.connect()` 先设 `stopped=false`，随后 `close()` 又设为 true；重试入口遇 true 就返回 | 自动重连逻辑存在被自身关闭状态阻止的控制流缺陷 | P0；用假 WebSocket + 假计时器做最小失败测试，再分离清理连接与主动停止 |
| F02 | `handle_whisper` 以目标存在于 `players` 判断在线；未判断 `detached` | 世界驻留的离线角色被当成可收信会话 | P0；Detach 后仍保留实体，密语应明确不可达 |
| F03 | 密语给目标 `try_send` 失败被忽略，仍向发送者回消息 | 发送者得到似成功反馈，接收方实际没入队 | P0；分别构造 Full / Closed |
| F04 | 公共聊天先插 `chat_recent` 再检查限流；重复请求直接 return | 限流拒绝后的重试没有原拒绝结果；成功回显丢失后也无法恢复确认 | P0；成功与拒绝都重放原结果 |
| F05 | `whisper_echo` 使用新的 replay messageId、当前 tick，并要求目标仍在 World | 同一请求的“原消息”身份变化；对方退出后无法重放结果 | P0；接收者退出、显示名变化后仍返回原结果 |
| F06 | 聊天/密语/表情序列在 World 构造时从 0 开始 | 进程重启后的事件去重不能只依赖旧格式 ID | P1；加入启动 epoch，重启回放测试 |
| F07 | 每连接一个容量 32 的字符串队列，共享各种出站消息 | 聊天与快照/关键回执争用容量；有界不等于业务优先级合理 | P1；先统一发送结果，再按证据分级 |
| F08 | 地图聊天扇出不排除 detached，和 Player 的“旧 output 不再写入”注释不一致 | 无意义向旧队列发消息、错误统计和接管边界混乱 | P0；统一可达性判断，不能因此删除驻留实体 |
| F09 | 前端 ChatMessageEnvelope / WhisperEnvelope 不含 messageId；系统 eventId Set 未在 clear 中清理 | 缺少统一事件去重；系统去重集合可持续增长且跨会话残留 | P1；新增纯状态 reducer、有界去重和角色会话清理 |
| F10 | `JSON.parse(...) as ServerMessage` 只是 TS 类型断言 | 新协议坏字段可能直接进入视图 | P1；给新增消息加运行时判别和字段校验，不要求一次重写全协议 |
| F11 | `Identity` 只有 id/username，但内部 Session 有 account_id | 直接用角色 ID 当 GM 账号主体会授权错对象 | P2 前置；从服务端 Session 提供可信 AccountId/CharacterId |
| F12 | Store 是 `Arc<Mutex<Connection>>`，公开方法同步取锁执行事务 | 不能宣称目前数据库已经完全离开世界执行路径；新增后台查询还可能争抢同锁 | P2b 前置；测量并建立有界持久化完成协议 |

F01–F10 是静态控制流/结构观察，仍须补测试复现；F11–F12 是新能力必须解决的结构风险。不是本次已经修复或压测确认的故障。[R02][R03][R04][R07][R09][R11][R13]

### 2.2 不要把正确代码一并推翻

应保留：服务端派生发送者与地图、拒绝客户端伪造字段、地图/密语共用预算、服务端黑名单、原生输入法、使用 `textContent` 展示玩家文本、旧 socket 回调身份检查、连接状态变化才触发 UI 更新。[R02][R04][R05][R11][R13]

`chat/scroll.ts` 已把 DOM 行数限制在 **40 行**，并保留“用户查看旧消息时不强行滚到底部”的行为。因此 F09 指的是 `systemEventIds` 等状态生命周期，不应误报为聊天 DOM 完全无限增长。[R12]

---

## 3. 目标边界：共享通信基础，不共享业务权力

```text
玩家聊天意图 ───────┐
业务已提交结果 ─────┼→ World 内的对应职责 → 有界投递 → 单一连接 writer → UI
管理请求 → 授权 ───┘           │
                              └→ Store 事务 → 审计 / outbox → 完成事件
```

| 模块 | 拥有的事实 | 不允许做的事 |
|---|---|---|
| `world::messaging` | 消息接受、成员资格、禁言判断、接收范围、短期结果重放 | 通过聊天字符串发物品；自己维护第二套角色在线真相 |
| `world::notifications`（拟新增） | 已提交业务事件到通知的映射、在线公告投影 | 把“显示领取成功”当成已发奖；在视图回调中改变游戏 |
| `world::admin_ops`（拟新增） | 经授权的管理意图在权威世界中执行、检查目标当前状态 | 绕过库存/任务/传送规则直接改若干 Player 字段 |
| `auth` 及子模块 | 持久结果、账号归属、授权记录、公告版本、审计、待发布事件 | 与 World 并行产生第二套临时玩家状态 |
| `network` / `outbound`（拟新增） | 会话绑定、限额、收发、Full/Closed、连接结束 | 根据消息内容自行判定 GM 权限；将断线直接解释为玩家退出 |
| 前端 `chat/state.ts` / view | 草稿、pending、过滤、去重、展示 | 决定消息身份、成员范围、资产是否到账 |

这里的“模块”首先是代码与状态边界，不意味着独立服务或每个模块都开一个 task。世界子模块继续用 `#[path]` + `impl World`；不要顺便引入全局事件总线、自动注册系统或依赖注入容器。[R03][R18]

---

## 4. 身份、空间与在线状态

### 4.1 明确六种身份

| 名称 | 定义 | 当前接入位置 |
|---|---|---|
| AccountId | 登录账号与管理权限主体 | auth 内部 Session，`characters.account_id` |
| CharacterId | 玩家扮演的角色 | VerifyCharacter 返回的角色身份、World 玩家键 |
| ConnectionId | 一次控制连接，不是永久玩家身份 | 当前已有 `connection: String` |
| RealmId | 逻辑区服 | 拟新增配置，单服阶段只有一个值 |
| ChannelId | 同区服中的游戏频道 | 大厅当前固定 1；后续须与实际 World 路由绑定 |
| RuntimeMapId | 当前地图实例，而非地图模板 | 当前 Player.map_id；Boss 练习场也有独立运行时地图 |

现有数据库有历史兼容：`characters` 区分 id 与 account_id；旧角色迁移可能让两者相等。**不能因为某个旧账号相等，就认为所有角色 ID 都等于账号 ID。** 新管理记录必须单独写 actor_account_id、actor_character_id、target_character_id。[R07][R08][R10]

首期不批量重命名所有历史 `account_id` 列。应写映射说明与归属测试；每个被扩展的事务确认该参数实际指账号还是角色，再接审计。

### 4.2 消息范围，不等于一个 `channel` 字符串

```text
Map       = (realm_id, channel_id, runtime_map_id)
Channel   = (realm_id, channel_id)
Realm     = realm_id                    // 本区服所有频道
Direct    = (target_realm_id, target_character_id)
Party     = (realm_id, party_id)        // 另有成员权限
Federated = 服务端许可的跨服房间         // 不是任意世界全局广播
```

首期 `ChatSend` 仍只表示地图聊天。需要发频道/世界聊天时，使用明确意图，由服务器选择发送者当前范围；客户端不得通过补一个 `mapId`/`realmId` 扩大现有 ChatSend 的权限。

当前同一个 World 内对另一地图角色发密语，叫**跨地图私聊**，不叫跨频道；复制一个逻辑频道字段而所有实体仍共用一张地图，也不是游戏频道实现。

### 4.3 “在世界里”“有连接”“有人看见”是三个事实

建议第一阶段直接从现有 Player 派生，不新增一个会漂移的 `online: bool`：

| 状态 | 实体驻留 | 可尝试在线消息入队 | 发送者应理解的结果 |
|---|---|---|---|
| 正常控制连接 | 是 | 是，但仍可能 Full/Closed | 入队成功，不等于已读 |
| 页面隐藏、仍有有效连接 | 是 | 可以 | 对方可能暂离；不承诺浏览器即时处理 |
| `detached = true` | 是 | 否 | 当前不可达；不会伪装离线信箱 |
| 已 Exit | 否 | 否 | 当前不可达 |
| 新连接接管旧角色 | 是 | 只对新连接 | 迟到的旧连接事件无权影响新控制器 |

短期 `chat_receivable` 判断至少检查 `!detached`，实际 `try_send` 结果为最终排队证据；仅检查 `is_closed()` 不能避免检查后关闭的竞态。当前 connection token 已能做连接隔离，先复用，不并排再造一个没有作用的 sessionEpoch。[R02][R03]

暂离/驻留仍按原世界规则，聊天失败不删除角色、不重置 10 分钟窗口、不豁免战斗。真正在跨 World 迁移时，才需要更高一层的 authority_epoch。

---

## 5. 统一“结果重放”，而不是统一成万能聊天消息

### 5.1 第一批协议新增：发送结果与消息事实分开

保留现有 `chatMessage`、`whisperMessage`、`emoticonMessage`，新增 `chatResult`。以下是新契约草案，不是现有协议：

```ts
type ChatResult = {
  type: 'chatResult';
  requestId: string;
  surface: 'map' | 'direct' | 'emoticon' | 'channel' | 'realm';
  outcome: 'accepted' | 'rejected';
  messageId?: string;       // accepted 时必有
  code?: string;            // rejected 时必有
  retryAfterMs?: number;    // 提示，不代表同一请求会改判
  directRoute?: 'enqueued'; // 只表示目标当前发送队列接收成功
};
```

实现时用判别联合表达 accepted/rejected，避免可选字段形成无效组合。`surface` 的 channel/realm 只有对应能力启用后才接受，不能只扩 TS 类型就宣称实现。

**契约规定：**

- 公共聊天 accepted：服务器已经接受并生成消息事实，进行尽力扇出；不表示所有玩家都收到。
- 在线密语 accepted + enqueued：目标有效连接的队列确实入队；不表示 socket 写成功或对方已读。
- 目标 detached/Closed/Full：首期拒绝当前投递，不记录离线信件。可以对外合并为 `recipient_unavailable`，内部保留具体原因；这属于明确的隐私/错误码变更，测试与版本一起更新。
- 发送者回执丢失：使用**同一 requestId、同一内容**重试，服务器只重放原结果/原消息回显，不再给其他人广播。
- 客户端 send 返回 true 只代表浏览器调用发送成功；UI 此时仍是 pending，不提前显示“已送达”。[R04][R13]

### 5.2 请求缓存保存原结果

拟将现有元组升级为有界结构；字段位置仍由 World/Player 拥有，只改聊天相关状态：

```rust
// 设计形状；不是可直接替换整个 Player 的完整代码。
struct ChatRequestRecord {
    request_id: String,
    surface: ChatSurface,
    canonical_intent: CanonicalChatIntent,
    outcome: ChatSendOutcome,
    original_message: Option<ChatMessageFact>,
}
```

`ChatMessageFact` 保存 message_id、原始发送者/接收者身份与显示名、原始正文、原始 tick/服务端时间、原始范围。缓存不得只保存 text。

处理顺序：

```text
验证包与发送者连接绑定
 → 规范化意图（保留语义，不擅自繁简转换正文）
 → 查询原 requestId
    ├─ 同内容：重放原 outcome；必要时只重放发送者原回显
    └─ 不同内容：idempotency_conflict，不覆盖旧记录
 → 新请求：解析目标、权限/禁言/范围/限额检查
 → 判定投递条件（密语必须先实际入目标队列，Full/Closed 得到拒绝）
 → 生成并保存最终 accepted 或 rejected 结果
 → 按约定完成公共扇出及发送者回执；已入队的密语不再二次投递
```

密语新请求需要解析名字；**重复请求应先用原始规范化意图对照已有记录**，不要先把同名新角色解析成新目标再改变旧请求含义。保存首次解析的 CharacterId；对方后来离线或改名不妨碍重放已发生的事实。

对在线密语，应先确认目标队列入队成功，再把结果记录为 accepted；Full/Closed 记录明确拒绝。世界单拥有者保证这段业务流程不被另一个聊天处理并发插入。入队后目标立刻断线仍可能丢包，因此结果不能叫 read/delivered。

**失败也幂等。** 例如第一次因限流拒绝，同 ID 重试仍返回原拒绝；玩家等到可发送后，应发起新的用户操作 ID。网络层连合法 requestId 都没有的坏包，不进入业务结果缓存。

### 5.3 重试窗口与内存边界

现有 map64、whisper32、emoticon32 是条数窗口，不是永久“只执行一次”保证。首期可保留容量，补每类独立窗口、缓存淘汰指标，以及明确的客户端最大重试期限。[R04]

建议后续增加服务器颁发的短期 `chatSessionId` 和单调 `clientSeq`：缓存范围内精确重放；低于已淘汰水位的旧请求返回 `retry_window_expired`，不能再次投递。序号可重试，禁止靠客户端时间判断可信新旧。新控制会话由服务器选择是否延续旧窗口，旧会话请求不能被当成新命令。

这项属于协议升级，不在修复 F04 的小补丁里同时大改。未实现前，文档必须诚实说明：旧请求在有限缓存外可能无法判定，UI 不进行无限自动重投。

### 5.4 消息 ID 与顺序

新增进程启动唯一标识 `bootEpoch`；复用项目现有随机 ID 生成机制或 rand，不为了这个需求强制引入新库。消息 ID 为有长度上限的、不透明的字符串；RealmId/ChannelId 单独为可信元数据。不得把账号 token 或隐私内容拼进 ID。

顺序只承诺到合适的范围：单地图/单频道由所属权威方分配 sequence；跨服不承诺全世界所有消息的全序。服务端 tick 用于本 World 事件关联，UTC 时间用于展示和检索，二者不能替代跨进程逻辑顺序。

去重键需要包含消息来源命名空间；重启不能复用上次 epoch。持久公告用 `announcementId + revision`，不能用临时 tick 或 bootEpoch 代替公告版本。

---

## 6. 有界投递：先看得到失败，再隔离拥塞

### 6.1 不要把 `try_send` 当成可靠性设计的全部

当前世界入队 1024、每连接出队 32、入站每秒 60 条、入站帧/消息 2048 字节、socket 写超时 2 秒是代码现状，不是经本次压测得出的合理容量。[R01][R02]

建议新增小型 `outbound.rs` 适配，不改世界的所有权：

```rust
enum EnqueueOutcome {
    Enqueued,
    Full,
    Closed,
}
```

第一步把聊天链路的 `let _ = try_send(...)` 改成显式处理，并计数；不要第一张 PR 就重构所有出站协议。第二步再接入业务回执、通知与快照。

Tokio 的有界队列提供容量边界与背压工具，但应用必须自己决定 Full、Closed、排空与停机语义。[S01]

### 6.2 分级策略

| 消息 | 队列满时 | 重连恢复来源 |
|---|---|---|
| 普通地图聊天/表情 | 允许丢弃给拥塞接收者的副本，记计数；不阻塞 World | 默认没有离线补聊 |
| 在线密语 | 未能入目标队列则返回不可达；不对发送者伪装成功 | 原请求短期结果重放，不凭空补历史 |
| 请求结果 | 有界重放缓存；不能直接当普通聊天静默丢弃 | requestId 查询/重试 |
| 当前状态快照 | 只有证明为完整自包含快照后，才可用“保留最新”策略 | 权威全量快照 |
| 公告变更/撤回 | 持久版本 + outbox；即时提示可丢，状态不能丢 | 登录/恢复重新拉取有效公告集合 |
| GM/经济结果 | 结果持久化；网络失败不能触发新执行 | operationId 查询 |
| 技术诊断 | 可以限量、采样、丢弃，但要计数 | 无关键业务保证 |

网络 writer 仍保持唯一 socket 写入者。可先用多种逻辑预算；确需多队列时，再采用控制回执、临时社交和快照队列的加权公平调度。不能无限偏爱控制消息，使其他消息永久饥饿。

**不要盲目把所有 snapshot 放进 watch。** 先核对其中是否隐含一次性事件、客户端是否依赖“事件前/后某次快照”的次序。需要时引入 appliedRevision/barrier；没有通过验证前，维持原队列语义。[R02][R06]

### 6.3 连接错误与世界离开分离

Closed/连续写超时只能触发带当前 connection 的 Detach 请求；由 World 核对绑定后处理。不能在聊天扇出中执行玩家 Exit，不能让一个旧连接的 Closed 把新接管连接清掉。[R02][R03]

退场控制命令仍需要可靠投递或重试，保留网络现有最终 `world.send(departure.command(...)).await` 的用意；不能为“所有地方统一 try_send”把它改成静默丢弃。

### 6.4 限流与公平性

保留地图/密语共用的 5 burst + 1/s 回填；表情沿用已载入的 EmoticonLimit，不把两者粗暴合成一个数。[R04]

再增加分层预算：连接入站保护、账号短期冷却、目标密语压力、房间广播预算和节点总扇出预算。连接层限制保护队列；业务层限制体现禁言与身份，二者不能相互替代。账号保护不要随显式登出/重选角色立刻重置；可先用有界 TTL 缓存，明确重启后的保证范围。

地图扇出现在扫描 World.players。在现有规模先保留清楚的实现并测量，不立刻新增十种订阅索引。达到瓶颈再维护 `members_by_runtime_map`，且必须在 Join/切图/Exit/接管处有一致性测试。不得让聊天同步遍历数量无上限的跨服用户。

---

## 7. 九类功能的业务规格

### 7.1 地图公共聊天

继续使用 `ChatSend` → `handle_chat`。范围使用发送时服务器的 RuntimeMapId，含频道与区服上下文。离开地图后仍可在自己的日志里看到原消息，但不得在新地图的其他角色头顶播放旧地图气泡。

Boss 练习场等私有实例必须按运行时实例隔离。持久化时用到的 sourceMapId/canonical map 不能拿来作为聊天房间键。[R03]

保留服务端黑名单扇出；用户正文不能指定 GM 名称、系统前缀、颜色、HTML、音效、跑马灯等级或收件人列表。频道标签与身份徽章由服务器事件类型决定，不解析玩家文本中的“系统：”来决定样式。

### 7.2 私聊

首期仍是**在线临时密语**，不自动加离线信箱。目标使用角色显示名输入，由既有名称解析规则解析；接收边界基于 CharacterId，不依赖显示名永久不变。

必须明确自聊、无目标、暂离但有连接、detached、双向黑名单、禁言、目标拥塞、发送者拥塞、断线重试等结果。已接受消息的结果查询允许返回原事实，但不能因此再次向已拉黑的对象发送内容。

跨服私聊进入 P4 后使用“区服 + 角色名”或服务器下发的可信角色引用，不能把不同区服同名角色当同一个人。回复功能保存角色引用，不从上一行显示文本重新解析身份。

若后续决定支持离线私聊，单独设计 inbox 容量、保留期、删除、反骚扰、拉黑后的可见性和读回权限，不改变现有 accepted 的含义来假装已经持久化。

### 7.3 频道公共聊天与本区服跨频道聊天

区分“当前频道所有地图”与“当前区服所有频道”，分别做 ChannelChatSend、RealmChatSend 或等价明确变体。现有 ChatSend 不接受任意客户端范围。

P1/P2 可在开发态展示能力占位或隐藏入口，但只要实际只开一个频道，就必须标记“单频道”；不能把不可测试的多频道能力放进验收通过项。

首次真正实现时至少启动两个**真实独立的频道 World**：同一地图在两个频道中的怪物/掉落/人物互不混入，频道公共聊天不串线，区服聊天按政策跨线。具体前置见第 11 节。

### 7.4 跨服聊天

跨服是逻辑区服之间的可信服务通信，不是客户端 WebSocket 连接到更多端口。由来源区服接受、记录消息身份，再投递到被许可的跨服房间；目标区服重新检查本地接收者规则与路由状态。

普通临时跨服聊天允许尽力投递，但发送结果要说明范围与失败；公告、付费喇叭、管理执行不能套用相同可靠性等级。总线只负责转运，不负责决定谁是 GM、谁拥有角色和能否扣费。

### 7.5 跑马灯

跑马灯是展示投影，输入应是服务端允许的公告或特定广播事件，而不是另一张“全服奖励表”。

建议字段：`eventId`、`announcementId?`、`revision?`、`presentation='marquee'`、`priority`、`startsAt`、`expiresAt`、允许的文字模板和参数。状态从同一个公告事实派生，聊天框与跑马灯不会各自产生两条不同公告。

前端只有一个播放器：有界待播队列，同事件去重；高优先级维护提示可替换低优先级滚动，但不无限打断；过期内容不补播。页面恢复后先刷新有效公告，不把后台十分钟积累的跑马灯从头播放。提供静态文本入口与减少动画偏好，不要求用户必须看完滚动才能知道维护信息。

普通玩家消息绝不因正文里包含特殊命令就变成跑马灯。付费喇叭在 P2b 单独提交扣费事务后才有资格产生此展示。

### 7.6 系统公告

公告应有生命周期：

```text
草稿 → 已发布（可未来生效） → 已过期
                    └────→ 已撤回
```

`announcementId` 不变，修改使用递增 revision 和 expectedRevision，避免两名管理员覆盖对方编辑。撤回是持久状态/墓碑，不能只是删掉正在运行的队列元素。

字段至少包含：标题、正文或模板、语言、受众、发布时间、生效/过期时间、优先级、展示位置、发布者和版本。受众只能使用有限枚举和可信对象，例如区服/频道/地图实例/全服；不能从管理页面提交任意 SQL 条件。

首次登录、重连、切服都拉取有效集合，并用版本同步撤回。消息提示与完整正文可分开；完整公告读取可使用有鉴权的分页 HTTP 接口，不为了长正文直接扩大所有游戏 WS 请求上限。

P2 支持每服本地持久公告；跨服同时发布在 P4 通过 outbox 传播。截止时间由服务端判断，前端剩余时间只是显示。

### 7.7 系统消息

系统消息分三种，不能全部通过 `appendSystem("...")` 代替业务契约：

| 类型 | 示例 | 权威来源 |
|---|---|---|
| 请求结果 | 背包满、操作成功、禁言中 | 对应 requestId 的业务结果 |
| 已发生业务事件的提示 | 获得物品、任务状态变化、好友通知 | 已提交结果/世界事实 |
| 世界服务信息 | 维护提示、连接恢复、功能不可用 | 服务状态或公告状态 |

建议新增 `SystemNotice`：`eventId`、`code`、`severity`、`templateKey`、受限参数、`relatedRequestId?`、`occurredAt`。初期服务器继续按已有 `lang` 渲染 zh/en 也可以，但保留 code，不能让客户端从中文句子猜业务含义。[R03][R05][R14]

现有背包、仓库、任务回执保留。先选一个完整事务结果映射成提示，再逐条接入，避免出现旧 status 和新通知同时弹两次。away/death 有专门状态机与模态优先级，不应被普通系统通知替换。[R14][R22]

### 7.8 操作日志

必须建立四层区别：

| 记录 | 用途 | 可靠性与查询边界 |
|---|---|---|
| 技术日志 | 网络错误、Full/Closed、性能、异常 | 可采样/限量；不记录密码、token 和默认完整私聊正文 |
| 玩家可见操作历史 | 装备成功、任务已完成、物品变动提示 | 是展示投影，不能作扣费/发奖依据 |
| 经济/业务记录 | inventory_actions、storage_actions 等 | 保留现有事务事实；关键扩展与同一事务提交 |
| GM/安全审计 | 谁以什么权限，对谁做了什么，结果是什么 | 必须有 operationId、主体、目标、原因、授权版本、结果、时间；查询本身也受控 |

可先做现有动作表的只读查询投影，不急着复制所有历史到一个巨表。新增重要操作采用统一 auditEventId/operationId 关联；不要把“有日志文件”当成幂等账本。

默认不把每条聊天正文长期持久化。举报留证、私聊调查、保留期与清理策略需要单独权限与用户规则；查询私聊证据不能沿用普通在线人数查询权限。[S03][S04]

### 7.9 GM 命令

第一批支持：查询自己权限、查询指定角色可公开的在线/驻留位置、查询操作状态、公告管理、禁言/解禁。资产发放、传送、强制退出在各自前置就绪后逐个开放；任意脚本执行、SQL、shell、直接编辑 Player 全字段不进入本计划。

聊天框可提供 `/gm ...` 的交互外壳，但只是把字符串解析成严格白名单的管理意图；真实权限由服务端验证。普通 `ChatSend` 的正文即使写 `/gm grant`，也不能触发管理执行。

---

## 8. GM 授权与执行模型

### 8.1 可信主体从认证服务获得

建议新增内部 `VerifiedCharacter` / `ActorContext`，而不是让客户端传 actorAccountId：

```rust
// 内部类型草案：由认证结果和世界绑定构建，不接受客户端原样提交。
struct ActorContext {
    account_id: AccountId,
    character_id: Option<CharacterId>,
    connection_id: Option<ConnectionId>,
    realm_id: RealmId,
    authorization_revision: u64,
}
```

`VerifyCharacter` 当前只返回 Identity；扩展时必须从内部 Session 的 account_id 以及角色归属验证获取主体。首期不让管理员通过切换角色扩大账号权限。[R07][R10]

权限采用有限能力 + 范围 + 环境，而非一个 is_gm：

| 能力例子 | 范围 | 附加要求 |
|---|---|---|
| `ops.read_presence` | 指定区服 | 只返回必要字段，查询有限页 |
| `chat.mute` | 指定区服/账号/角色 | 原因、截止时间、可撤销 |
| `notice.publish` | 指定区服与展示级别 | 预览、expectedRevision、受众校验 |
| `economy.grant_item` | 指定区服/目标角色 | 数量上限、事务幂等、原因、操作状态 |
| `world.teleport` | 指定区服 | 合法目的地、实例权限、持久化/状态同步 |
| `audit.read_sensitive` | 指定审计类别 | 查询也审计，不自动包含私人消息正文 |

初期用简单表/白名单配置表达能力即可，不引入通用 ABAC 表达式执行引擎。原则是默认拒绝、每次操作授权、最小范围；队列中的管理意图在执行前再次检查最新权限，不能沿用进队时无限有效的身份快照。[S04]

### 8.2 入口与启动安全

推荐在现有 Axum 服务中增加独立 `/api/admin/...` 路由和 `admin.rs`，默认不开启。也可后续支持游戏内管理意图，但两者共享能力校验和 typed command；不存在“控制台路径不需要审计”的后门。

脚本实际绑定 `0.0.0.0:3010`，不能把 main 默认的 127.0.0.1 当成安全边界。[R17]

管理功能启用必须满足：显式设置、可验证的管理员主体、请求限额、审计可写、敏感操作关闭或有额外确认。局域网 IP、名字叫 GM、第一个注册账号都不是授权依据。公网部署还需 WSS/TLS、明确 Origin 许可策略和会话撤销处理；Origin 校验是额外防护，不代替 token/权限校验。[S03]

权限引导配置不能含通用默认口令。管理员授权/撤销写入审计，凭据不进入 URL、错误字符串、日志或仓库。公告/审计查询使用自己的分页和长度限额，不能放开游戏全局 2048 字节限制。

### 8.3 执行状态与幂等

```text
Received → Authorized → Scheduled → Committed → Applied → Reported
    └───────────────→ Rejected / Failed
```

这是查询视图的状态，不要求为每个步骤都写一条数据库事务。必须区分：

- 未提交前失败：没有业务效果，可明确拒绝。
- 已提交但回复丢失：operationId 查询返回原结果，不再执行业务。
- 已提交但世界内存尚未应用：恢复应用或重读，不能当作“未执行”再发一次物品。
- 进程崩溃后：根据持久结果和待发布记录恢复，而非仅靠内存 requestId Set。

持久幂等键建议 `(actor_account_id, operation_id)`，并存 command_kind、规范化请求内容/摘要和目标。相同键不同参数必须冲突；不把裸 DefaultHasher 结果当稳定跨版本/跨进程协议指纹。首期可直接保存规范化 JSON 来比较，私密字段不进入指纹载荷。

高风险请求确认页必须显示准确目标、区服、数量、原因。预检结果不是授权承诺；提交时重查。大批量资产修改不在首版开放；后续再加双人审批与批次上限。

---

## 9. SQLite 持久化、审计与恢复

### 9.1 先复用已有事务，再补缺口

`auth/bag.rs::move_inventory` 已在一次 SQLite transaction 内完成读取、修改、记录 inventory_actions、commit。这个形态值得继承；但该记录的现有字段并不等于统一管理审计，也不能默认所有旧事务都具备参数指纹冲突检查。[R08][R09]

拟新增的表按阶段创建，名称可按仓库规范调整：

| 表 | 阶段 | 核心键/内容 |
|---|---|---|
| `ops_schema_migrations` | P2 | version、applied_at；只管理本能力的显式迁移，不偷改原有全库版本体系 |
| `admin_grants` | P2 | account_id、capability、scope、revision、revoked_at |
| `chat_mutes` | P2 | subject_kind/account或character、subject_id、scope、expires_at、revision、reason |
| `announcements` | P2 | id、revision、status、audience、content、starts_at、expires_at、updated_by |
| `admin_operations` | P2 | actor_account_id + operation_id 唯一、request_fingerprint、target、status、result |
| `audit_events` | P2 | event_id、operation_id、actor、target、action、reason、result、occurred_at |
| `ops_outbox` | P2 | event_id 唯一、aggregate_id、revision、kind、payload、status、next_attempt_at |
| `chat_paid_actions` | P2b | character_id + operation_id、消费来源、原消息事实、结果 |

`auth/schema.rs` 接入迁移，具体 SQL 放在 `auth/ops.rs` 的建表/事务辅助或专门 schema 子函数中。新表外键只引用明确的 `accounts.id`、`characters.id`，不要凭历史列名猜测。

查询索引围绕 operator/target/time/status/announcement_revision 建立；没有查询需求不预先造几十个索引。审计记录不能通过普通 GM 接口任意改写。数据库文件仍可被主机管理员修改，不能把本机审计表宣传成绝对防篡改存储；需要外部不可改审计时另列增强项。

### 9.2 资产修改的事务边界

GM 发物品和付费喇叭至少做到：

```text
同一个 SQLite transaction：
  检查 operationId 与原始参数
  校验最新授权/目标/消费资格
  执行业务资产变更
  写最终 operation result
  写必需审计
  写 outbox 事件
COMMIT
  → World 应用已提交的业务增量
  → 发布消息/通知
  → 回传或允许查询原结果
```

不能先调用一个已自行 commit 的 `Store::grant...`，再另开事务写审计/outbox，却声称三者原子。新增 `_tx` 辅助复用已有库存规则，让一个外层 transaction 组织整体操作；不要在持有 `Store.db` 锁时再次调用会取同锁的公开方法。[R07][R09]

付费喇叭的业务定义应是“扣费并创建一条可恢复发布的广播事实”，不是“所有在线玩家必然看过”。广播延迟/恢复不得重复扣费；完全无法接受发布时，在提交前拒绝，或通过独立幂等补偿操作退款，不在重试分支随意加回道具。

### 9.3 outbox 的边界

worker 领取待发布事件，发布成功后标记。发布成功但标记前崩溃会重发，因此接收端仍按 eventId/revision 去重。持久化发布成功不等于所有浏览器看到；公告登录补取读取当前状态，不依赖客户端无限保存 ACK。

公告发布和撤回乱序到达时，只接受较高 revision。eventId 不能每次重投都重新生成。死信/长期失败需要可查询状态、退避、告警和手动重放，不能无限高速重试。

第一阶段 outbox 可以向本进程 World 投递；只有 P4 才增加消息中间件适配。因此不需要为实现可靠公告先部署 Kafka/NATS。

### 9.4 不要用一个 `spawn_blocking` 掩盖整个持久化问题

当前 Store 克隆共享同一个 Mutex<Connection>；把某项查询放入后台并不意味着不会阻塞其他同步 Store 调用。SQLite WAL 允许更好的读写并发，但仍只有一个写事务同时进行。[R07][R09][S02]

本计划分两步：

**P2：** 不为普通聊天增加数据库热路径；名称与黑名单尽量使用既有可信缓存，禁止每个收件人查库。公告/审计的批量读取走有界后台工作，限制锁持有时间，测量它与既有世界事务的争用。尚未迁移的同步调用在风险列表中明确保留。

**P2b：** 新增有界持久化作业与完成回投，完成事件携带 operationId、目标角色、所属 World、authorityEpoch，以及必要的资源 revision。World 不等待磁盘完成来阻塞全服；事务工作线程不能拿一个可变 World 或复制的完整 Player 自己写回。

对资产操作建立**资源级待提交保护**：同一角色背包/货币的冲突写入按权威 owner 排队；拾取、任务发奖、商店、仓库等所有冲突入口都必须参与。移动或不相交的状态可以继续，但事务只更新相关字段，完成时应用增量或重读，不用旧完整 Profile 覆盖新 HP/位置。

这一步有真实改动面，不能当聊天文件搬家。若无法证明现有冲突入口全部受控，P2b 的资产类 GM 保持关闭，而不是冒险启用一个“后台修改数据库”的旁路。

### 9.5 禁言生效顺序

禁言是持久政策，判断使用 World 的可信缓存，不每条消息查 DB。禁言事务提交后，向相应 World 投递带 policyRevision 的变更；World 应用后才返回“已生效”。已提交未应用显示“提交成功，生效处理中”，不能提前声称全服生效。

P3/P4 后每个相关 owner 都要按 revision 应用；网络分区时不能宣传跨服禁言已立即一致。规则可选择暂时关闭该主体在失联区域的敏感发送，或显示部分生效结果，必须是显式策略。

---

## 10. 前端改造：保留外观，补齐消息状态

### 10.1 具体落点

| 文件 | 改动 |
|---|---|
| `client/src/network/session.ts` | 先修 connect/close 的 stopped 生命周期；保留旧 socket 身份隔离与连接状态去重；新增消息运行时校验 |
| `client/src/features/chat/state.ts`（新增） | 纯 TS 的消息合并、pending、结果重放、有限重试窗口、按作用域去重 |
| `client/src/features/chat/view.ts` | 接收完整 messageId 与结果；保留原 ChatViewHooks、原生输入、资源样式和聊天模式 |
| `client/src/features/chat/scroll.ts` | 保留已有 40 行上限和阅读旧消息时的滚动策略；更大历史单独设计 |
| `client/src/features/notice/marquee.ts`（新增） | 一个有界、按优先级和截止时间工作的跑马灯播放器 |
| `client/src/features/notice/announcements.ts`（新增） | 公告集合、修订和撤回展示；复用现有 news/status 容器合适部分 |
| `client/src/app/main.ts` | 仅装配新能力与事件分派；不要继续把全部业务 reducer 写进 main |
| `client/src/features/notice/away.ts` / `death.ts` | 保留独立生命周期；仅与新通知协调展示优先级 |

[R11][R12][R13][R14][R22]

### 10.2 消息状态与交互

建议 pending 状态：`editing → sending → accepted / rejected / unknown`。断线导致结果未知时标明“确认中/结果未知”，不能自动当失败再发一条新消息，也不能永远保持没有解释的转圈。

同一消息的原回显与 chatResult 可任意先到；纯状态层按 requestId/messageId 合并，不重复插入 DOM。重连后只查询/重试可确认的短期请求，不自动重播已过期草稿。

全局切角色时清空角色私有消息、pending、系统去重集合和密语对象；同角色重连是否保留最近消息是会话策略，不由 DOM 残留碰巧决定。持久公告状态按账号/角色可见范围重新载入。

必须保留中文/日文输入法组合期间 Enter 不发送，聊天输入不触发跳跃/技能，Escape 先处理输入与弹窗，不能被快照/连接 online 回调抢焦点。多语言只转换系统模板；玩家正文不强制繁简转换或重新翻译。

### 10.3 安全与长度

继续使用 textContent；需要物品链接时用服务端签发的结构化 item 引用和有限组件，不直接允许 HTML/Markdown。公告管理员文本也不因此获得脚本执行权。

现有服务端正文限制是 200 个 Unicode scalar、1024 UTF-8 字节、非空且不含 char::is_control；名字校验与 requestId 另有限制。前端的 UTF-16 length 不等价于 Rust chars().count()，测试必须覆盖 emoji/中日韩字符。首期保持这套明确规则，不把它误称为 200 个用户感知字符。[R05]

新增字段后测量**完整编码 JSON 的字节数**，包括引号/反斜杠转义，验证最坏包体仍符合入站 2048 字节限制。超限时明确提示，不截断正文后当原请求成功。[R02][R05]

### 10.4 检查脚本

现有 chat 目录有 whisper.check.mjs、emoticon.check.mjs、scroll.check.ts，但 `client/package.json` 的总 check 链未包含它们。新增独立 `check:chat`，并把新 state/connection/notice 检查纳入正式检查入口。[R16][R23]

不能把新增检查挂在一个已知失败的 `&&` 链末尾后声称运行过。可采用逐项执行、汇总失败的检查 runner；测试失败必须返回非零，不用 `|| true` 掩盖。

---

## 11. 真正的多频道与跨服：分两次建设

### 11.1 P3 选择：一个频道一个 World owner，同进程先验证

当前 World 已容纳一组地图与世界实体，最自然的后续演化是：main 装配多个频道 World，由一个小型区服路由所有者管理频道句柄与角色当前归属，而不是在每个聊天处理器里 if channel。[R01][R03][R10]

```text
同一 Rust 进程
  RealmDirectory（角色唯一归属、频道目录、路由 epoch）
    ├─ Channel 1 → World 1 → 其地图/怪物/掉落
    ├─ Channel 2 → World 2 → 其地图/怪物/掉落
    └─ RealmSocial（只在需要时持有跨频道关系/聊天协调）
```

P3 才新增这些实际对象；P0–P2 不先创建一堆空 registry/service。迁移时可先支持退出角色到大厅后选另一个频道，不把无缝热换线作为第一版门槛。

### 11.2 不能只把 main 中的 World 复制两遍

必须先完成这些修改：

| 前置 | 为什么必需 | 涉及位置 |
|---|---|---|
| 大厅频道表与选择校验 | 当前只固定频道 1；客户端不能选不存在的频道 | `lobby.rs`、entry 界面、共享登录/选择响应 |
| 认证结果绑定可信频道 | 不能让 WS 客户端伪造频道覆盖已选角色路由 | `auth.rs`、network Join、内部 VerifiedCharacter |
| 活跃角色唯一注册 | 同角色不得在两个 World 同时出现，detached 仍拥有归属 | main/路由协调、World Join/Exit/接管 |
| 地图实体/持久掉落隔离 | 当前 drop map 与加载围绕 map_id；两个 World 不能重复加载同一掉落 | `world.rs`、`auth/loot.rs`、相关 schema 和生成 ID |
| 生成 ID 的命名空间 | 怪物、掉落、Boss 实例、组队、临时消息不能跨 owner 碰撞 | 对应生成入口与持久记录 |
| 组队/好友状态归属 | 当前 parties、friend_roster 在 World；跨频道不能各维护相互矛盾的名录 | `social.rs` 与后续区服社交 owner |
| 实例与地图范围 | 私有 Boss 不能因 sourceMapId 相同串频道 | boss、portals、快照和消息路由 |
| 数据库迁移兼容 | 旧数据明确归属于默认区服/频道，不能复制成两份资产 | `auth/schema.rs`、加载/查询方法 |

这些是基于已读状态模型的前置清单；`auth/loot.rs` 等具体改动实施前仍要读其完整相关事务，不能仅凭表名进行全局替换。[R03][R08][R10]

### 11.3 跨频道通信策略

地图聊天留在本 World；频道聊天由本频道 World 广播；RealmChat 经区服协调器转发**已接受的消息事实**到频道，接收 World 按自身当前连接/拉黑政策投递。不要让一个 World 直接拿另一个 World 的 `&mut Player`。

跨频道密语：目录先定位角色 owner，再由目标 owner 确认当前 connection/authorityEpoch 后入队；结果回送来源 owner。来源发言校验与目标可接收校验都不能省略。

发送已开始后目标换线：旧 owner 返回 stale_route 或转交给受控路由；来源只在相同 messageId/operationId 下有限重试，不能重新生成另一条密语。接收侧按 messageId 去重，路由重试不意味着向旧新会话各发一遍。

### 11.4 换线与后台驻留

第一版可要求“明确退出当前角色 → 等待权威释放 → 大厅选择新频道”。detached 不等于释放，不能靠断网抢到第二个 owner。

无缝换线进入后续工单：冻结冲突命令、落盘/迁移需要的状态、获取目标票据、更新 authorityEpoch、目标确认、旧 owner 退出。失败回到明确原状态或可恢复迁移态，不凭超时猜测两边都没有人。

交易/仓库事务未完成、Boss 私有实例未释放、待持久化管理操作未结束时，先拒绝换线。暂离的原始起点、禁言和账号限流不因换线刷新。连接 token 用于本连接隔离，authorityEpoch 用于跨 World 归属隔离，两者不可互相替代。

### 11.5 P4 总线选择与区服联邦

**现在不引入中间件。** 到 P4 按实际部署条件选择：

| 方案 | 适用 | 明确限制 |
|---|---|---|
| 进程内有界通道 | P3 同进程跨频道 | 无跨主机能力，不伪装容灾 |
| NATS Core + 必要的 JetStream | 没有现成基础设施，且确需实时跨节点与持久事件 | Core 与 JetStream 保证不同；持久重投仍需业务去重 |
| Redis Pub/Sub + 必要的 Streams | 团队已有 Redis 且愿意复用 | Pub/Sub 非持久消息，断连可能丢；Streams 也不替代资产事务 |

仓库目前没有 NATS/Redis 依赖，因此不应把“复用已有 Redis”写成事实。[R15][S05][S06]

跨区服可先维持各自数据库，只共享有限聊天与公告事件；不需要为了跨服文字聊天先做跨区服角色迁移或跨库资产事务。不要让不同主机直接共用一个 SQLite 文件来冒充分布式数据库。

总线消息包含来源 realm/node/bootEpoch、eventId、scope、版本、有效期和必要的审计关联。使用受控节点凭据、TLS 与 topic/subject 权限；客户端永远不能直接向服务总线发布“我是系统/GM”的消息。目标区服不把来源文本解析成管理命令。

### 11.6 跨服故障契约

普通聊天总线故障：本服聊天继续；跨服请求明确失败/未知，不无限在 World 中等待。持久公告继续保留 outbox，恢复后按版本传播并去重。GM 跨服执行使用独立管理路由和目标区服再授权，不能复用玩家广播 subject。

首期不承诺跨服所有消息全序，不承诺浏览器恰好收到一次，也不承诺分区中的权限修改立即全局一致。可承诺的是：资产操作按业务 operationId 不重复提交；消息重投保持身份；公告按持久版本收敛。

---

## 12. 协议演进与兼容

### 12.1 当前协议不是任意加字段都兼容

Rust 的 ClientMessage 使用 deny_unknown_fields，hello 要求协议/内容版本匹配；共享 TS 当前为 13 / tms273-9。因此不能只改 TS 发送字段、等待服务器“忽略不认识的部分”。[R02][R05][R06]

建议按行为变更批次分配新的 PROTOCOL_VERSION；如果实施时基线仍为 13，可以由下一次统一契约变更升到 14，但不能忽略其他并行分支已经占用该版本的可能。纯代码搬移不升版本；仅聊天协议变更不随意修改 CONTENT_VERSION，只有内容资源/数据契约实际变化时才更新内容版本。

### 12.2 双端与工具一起更新

新增/修改一个消息时检查：

```text
server/src/protocol.rs
shared/protocol.ts
World::Command 与输入分派（若需要）
client/src/network/session.ts 的运行时判别
client/src/app/main.ts 分派
相关 feature reducer / view
bots/run.mjs 与相关验收客户端
scripts/check_tms273_runtime.cjs 和版本校验
启动3010.command 的健康检查兼容性
```

测试新字段缺失、非法枚举、重复或超长 ID、客户端伪造 sender/map/realm、旧协议 hello 拒绝、完整 JSON 长度。不得为“兼容 GM”去掉所有 ClientMessage 的 deny_unknown_fields。

建议把新增聊天/通知/管理结果使用小型可序列化 Rust 类型，减少手写 JSON 拼错字段。不是要求一次把所有 ServerMessage 重构成巨型 enum。管理服务内部命令与公开 ClientMessage 分开，客户端不能自行构造 ActorContext。

### 12.3 JSON 数值边界

跨端递增序号必须限制在 JS 安全整数内，或从一开始作为十进制/十六进制字符串传输。现有 input seq 已有限制，新增 roomSeq/authorityEpoch 也不能把任意 u64 原样当 JS number。[R05]

消息 ID 与公告 ID 使用字符串；时间明确毫秒和时区；不得把 world tick 当 UTC 毫秒。Duration/Instant 不序列化为跨进程的可信绝对时间，跨进程由所属权威方携带可验证的版本/截止策略。

---

## 13. 文件级改造清单

`现有` 表示已读到该文件；`新增` 是本计划的拟定落点；`后续核查` 表示路径/职责在架构中存在，但相关实现需要进入该工单后补读，不能按本表直接机械修改。

| 文件/范围 | 状态 | 改动边界 | 不做什么 |
|---|---|---|---|
| `server/src/messaging.rs` | 现有 | 三类消息的结果记录、可达性、稳定回显、发送结果处理、预算 | 不重写移动/技能/伤害 |
| `server/src/world.rs` | 现有 | 只增加所需状态、构造初始化、私有子模块挂载和命令分派 | 不借此再次做整份大文件拆分 |
| `server/src/outbound.rs` | 新增，P1 | 发送结果、预算与后续多类出站适配 | 不持有另一套玩家状态 |
| `server/src/notifications.rs` | 新增，P1/P2 | `world` 的私有子模块，通知映射与公告应用 | 不把 UI 提示变成奖励执行 |
| `server/src/admin_ops.rs` | 新增，P2 | `world` 的私有子模块，管理操作世界校验与应用 | 不执行任意 shell/SQL/Rust |
| `server/src/admin.rs` | 新增，P2 | 独立受控 HTTP 管理入口、授权与命令封装 | 不按聊天前缀赋权 |
| `server/src/auth.rs` | 现有 | 可信主体返回、内部模块装配、持久化工作接口 | 不顺手迁移所有旧 API/列名 |
| `server/src/auth/schema.rs` | 现有 | 新能力显式迁移入口 | 不清库、覆盖旧账号/存档 |
| `server/src/auth/ops.rs` | 新增，P2 | 公告、权限、禁言、审计与操作结果的具体事务；变大再按职责拆 | 不建万能 SQL 执行器 |
| `server/src/auth/bag.rs` 等资产事务 | 现有/按需补读 | P2b 抽事务内辅助、加入操作关联和资源串行保护 | 不先提交资产后补写关键审计 |
| `server/src/network.rs` | 现有 | 确认连接主体、发送结果、管理防护、后续频道路由 | 不复制 World 进行异步修改 |
| `server/src/main.rs` | 现有 | 配置、构造新组件、默认关闭的管理路由 | P0–P2 不装配多服基础设施 |
| `server/src/lobby.rs` | 现有 | P3 真实频道目录、选择和归属校验 | P0 不假造多个频道按钮 |
| `server/src/social.rs` | 后续核查 | 黑名单/好友/组队事实复用；P3 重新分配跨频道所有权 | 不新增与已有社交关系相矛盾的独立缓存 |
| `server/src/protocol.rs` + `shared/protocol.ts` | 现有 | 同批次更新协议与 fixture | 不只改一端 |
| `client/src/network/session.ts` | 现有 | F01、消息形状、有限恢复 | 不破坏状态变化才报 online 的焦点保护 |
| `client/src/features/chat/state.ts` | 新增 | 无 Phaser/DOM 依赖的消息状态 | 不负责网络连接与权限 |
| `client/src/features/chat/view.ts` / scroll.ts | 现有 | 状态展示和有界列表、IME/焦点 | 不换皮肤框架，不扩大 app 装配点 |
| `client/src/features/notice/*.ts` | 现有 + 新增 | 增量公告/跑马灯，保留死亡/暂离 | 不把所有 notice 合成同一种弹窗 |
| `client/src/app/main.ts` | 现有 | 新组件装配与事件桥接 | 不堆入新领域状态机 |
| `client/package.json` + chat 检查 | 现有 + 新增 | 独立 check:chat、汇总检查 | 不跳过既有失败而声称绿灯 |
| `server/src/*_acceptance.rs` | 现有风格 + 新增 | 明确行为回归，沿用 include! 测试组织 | 不改变旧测试断言来掩盖业务回归 |
| `scripts/check_tms273_runtime.cjs` | 已读启动引用，实施补读 | 保持递归生产源码扫描与新契约断言 | 不把检查重新硬编码到 world.rs |
| `启动3010.command` | 现有 | 仅在需要新配置/健康字段时增量修改 | 不绕过、不删除数据库、不管理3000 |
| 后端/前端/状态说明文档 | 现有 | 更新聊天实现状态、断线驻留和新的验收入口 | 不把规划表当已实施清单 |

新模块必须写“负责 / 不负责 / 状态归谁 / 依赖谁”。不要创建没有实际代码的对称目录。所有现有源码变化以实施时 HEAD 再核对，固定提交用于理解，不要求开发者回退正在进行的其他业务重构。

---

## 14. 分阶段工单与完成标准

### 14.1 P0：立即消除当前闭环的错误语义

| 工单 | 前置 | 工作内容 | 完成标准 |
|---|---|---|---|
| CHAT-00 | 无 | 记录当前 HEAD、协议、测试清单；核对与本文提交差异；建立聊天专项检查入口 | 有真实新基线；区分旧失败与新失败；不修改玩法 |
| CHAT-01 | 00 | 给 Connection.connect/close/stopped 加失败测试；区分清理旧 socket 与主动终止 | 异常断开会重试；主动退出不重试；旧 socket 回调不干扰新连接；不抢焦点 |
| CHAT-02 | 00 | 消息可达性统一、处理 Full/Closed、保护 detached 与旧 connection | 驻留角色不假收私聊；不因聊天满队列删角色；接管后只投新连接 |
| CHAT-03 | 02 | map/whisper/emoticon 的原结果记录与重放，修复拒绝记录和新 replay ID | 同请求同结果；不同内容冲突；目标退出后原结果仍能查询；不重复扇出 |

01 可与02由不同人员并行；03依赖投递结果语义，不能边写边猜 accepted 含义。

### 14.2 P1：单服可用、可观察的消息基础

| 工单 | 前置 | 工作内容 | 完成标准 |
|---|---|---|---|
| CHAT-04 | 03 | chatResult、完整消息身份、bootEpoch、双端协议 fixture | 重启不复用消息身份；字段/长度/版本用例通过；前端不把 socket.send 当成功 |
| CHAT-05 | 04 | ChatState、按 requestId/messageId 合并、限量去重、draft/unknown 清理 | 重复事件不重复显示；切角色不泄漏旧私聊；40行与滚动体验保留 |
| CHAT-06 | 02、04 | 出站适配和指标，评估分级队列/快照合并；连接/房间预算 | Full/Closed 可观测；聊天压力不无限积压；快照策略改动有因果顺序测试 |
| CHAT-07 | 04、05 | SystemNotice；先接一个已提交业务结果；统一优先级 | 失败不会显示成功；同操作只有一次适当提示；不影响死亡/暂离交互 |

### 14.3 P2：可靠运营，但不急着开放发物品

| 工单 | 前置 | 工作内容 | 完成标准 |
|---|---|---|---|
| OPS-01 | CHAT-00 | 账号/角色可信主体、权限模型、默认关闭的管理入口 | 普通账号/伪造ID/旧权限均拒绝；不依赖用户名或IP赋权 |
| OPS-02 | OPS-01 | 新能力迁移、admin_operations、audit_events、只读查询 | 在旧库副本重复迁移安全；查询分页受控；操作状态可查 |
| OPS-03 | OPS-02、CHAT-07 | announcements + outbox + 登录同步 + 撤回/版本 | 重启恢复；重复发布不重复公告；乱序撤回不复活旧正文 |
| OPS-04 | OPS-03、CHAT-05 | 跑马灯/公告前端投影 | 后台恢复不过期补播；高优先级不无限饥饿；同公告多展示面不重复记事实 |
| OPS-05 | OPS-02、CHAT-03 | 禁言/解禁持久政策，世界应用回执，发送统一拦截 | 重连/换角色按指定主体生效；已提交与已生效有区分；禁言记录可查 |

### 14.4 P2b：强事务管理操作

| 工单 | 前置 | 工作内容 | 完成标准 |
|---|---|---|---|
| OPS-06 | OPS-02、CHAT-06 | 有界持久化作业/完成回投；冲突资源保护；窄字段更新 | 后台完成不会覆盖玩家新状态；同资源冲突操作次序确定；慢 DB 风险有数据 |
| OPS-07 | OPS-06 | 一种受控资产 GM；资产+结果+审计+outbox 同事务 | 请求重试、断网、崩溃均不重复发物品；审计写失败不产生孤立资产修改 |
| OPS-08 | OPS-07、OPS-03 | 付费喇叭，服务器核定资格/道具，恢复发布 | 不重复扣费；没有伪造喇叭权限；发布延迟可查，不假称全员已读 |

不能在 OPS-06 尚未覆盖冲突入口时先打开 OPS-07；可继续交付只读 GM、公告和禁言，不把“先交付一部分”变成不安全旁路。

### 14.5 P3 / P4：按真实需求启用

| 工单 | 前置 | 工作内容 | 完成标准 |
|---|---|---|---|
| ROUTE-01 | CHAT-06、OPS-05 | 两个频道 World、频道选择、唯一角色路由、持久地图/掉落命名空间 | 同地图双频道实体与掉落隔离；detached 不能双登；旧存档有明确默认归属 |
| ROUTE-02 | ROUTE-01 | 频道/区服聊天和跨频道密语；跨频道社交边界 | 频道隔离、区服可达、黑名单无旁路、旧路由不误投 |
| ROUTE-03 | ROUTE-02 | 可恢复的无缝换线（按需），迁移 epoch 与冲突检查 | 目标已接管时旧 owner 失效；失败不产生双角色或资产回滚 |
| ROUTE-04 | ROUTE-02 | 跨服可信传输适配、跨服命名、分区与重投 | 至少两真实区服进程；同名角色正确区分；本服不被总线故障拖垮 |
| ROUTE-05 | ROUTE-04、OPS-03/07 | 跨服公告，必要时远程 GM 独立控制面 | 公告版本收敛；远程管理目标再授权；资产命令不可经玩家聊天广播 |

### 14.6 每张 PR 的约束

一张 PR 只改变一个可验证的行为边界。机械搬移与业务修复分开；公共协议变化与双端检查在同一交付单元。说明哪些消息可能丢失、哪些结果可重放、哪些状态由谁持有，不能只提交“支持聊天室”的截图。

---

## 15. 验收矩阵：测故障，不只测两人互发一句话

以下 46 项是拟新增或需要重跑的验收场景，不是本次已通过清单。测试尽量复用现有 world::tests 和聊天 acceptance 风格；网络/前端专项单独记录，不能混称 cargo test 覆盖全部链路。

### A. 当前正确性与恢复

| ID | 场景 | 应有结果 |
|---|---|---|
| A01 | 相同地图两个玩家，另一个地图第三人 | 地图消息仅本实例接收，身份由服务端决定 |
| A02 | 相同 sourceMapId 的两个私有实例 | 公共聊天/表情不串实例 |
| A03 | forged authorId/mapId/realmId/GM字段 | 严格反序列化拒绝，无副作用 |
| A04 | 地图消息同 requestId 重试 | 相同结果/消息ID，只广播一次 |
| A05 | 地图限流拒绝后同 ID 重试 | 返回同一拒绝，不静默、不突然接受 |
| A06 | 相同 ID 不同正文/目标/表情 | 冲突，不覆盖原记录 |
| A07 | 密语接收者退出后发送者重试 | 重放原结果与原消息元数据，不重新解析当前目标 |
| A08 | 密语目标改名/同名目标替换 | 旧请求不投给新身份，新请求按当前目录解析 |
| A09 | 目标 detached 但仍在地图驻留 | 不假称可达，角色仍按世界规则存在 |
| A10 | 目标有连接但页面隐藏 | 可以排队，仅提示暂离/未确认阅读 |
| A11 | 目标输出 Full | 原请求不可达/明确拒绝，不回伪成功 |
| A12 | 目标输出 Closed | 连接处理受 token 隔离，实体不被聊天代码删除 |
| A13 | 发送者回执队列 Full 后恢复 | 同 ID 查询/重试恢复结果，不重新投递目标 |
| A14 | 新连接接管，旧连接迟到 Input/Detach | 不影响新控制器，不发到旧连接 |
| A15 | 服务器重启后计数重新从0 | bootEpoch 变化，旧新 messageId 不冲突 |
| A16 | 自动重连与主动退出 | 异常可重连；主动退出不重连；旧 callback 无效 |

### B. 前端与通知

| ID | 场景 | 应有结果 |
|---|---|---|
| B01 | chatResult 和原回显交换到达次序 | 只有一条最终消息 |
| B02 | 重复 messageId / requestId | 有界去重，不重复插行 |
| B03 | 中文/日文 IME + Enter | 组合未结束不发送，不触发技能 |
| B04 | emoji、中日韩文本、转义字符极限 | 前后端长度约定一致，完整JSON符合包体限制 |
| B05 | `<script>`、伪系统文本、链接字符串 | 只按安全文本展示，不能获得系统/GM样式权限 |
| B06 | 查看旧消息时有新消息 | 不强行跳底，DOM仍有界 |
| B07 | 切换角色/注销 | 私聊对象、pending、去重集合和角色内容正确清理 |
| B08 | 系统结果失败/重复到达 | 不显示虚假成功，不重复弹出 |
| B09 | 后台超过公告有效期再回来 | 不补播过期跑马灯，重新同步有效公告 |
| B10 | 公告修改/撤回乱序、重启恢复 | 高revision胜出，旧版本不能复活 |

### C. 权限、经济与持久化

| ID | 场景 | 应有结果 |
|---|---|---|
| C01 | 普通账号写 `/gm` / 伪造actor | 无管理权限，不改世界 |
| C02 | 一个账号多个角色、旧ID相等兼容 | 权限按可信账号判定，审计同时记录角色 |
| C03 | 管理命令排队后权限撤销 | 执行前再授权并拒绝 |
| C04 | 禁言后重连、重选角色 | 按账号/角色范围正确生效，不靠连接重置逃逸 |
| C05 | 禁言已提交但 World 未应用 | 状态可见为处理中，不报“已全服生效” |
| C06 | 同 operationId 重试与不同参数 | 同参数原结果；不同参数冲突 |
| C07 | 资产事务提交前/提交后崩溃 | 未提交无资产；已提交可恢复且不重复 |
| C08 | 审计/outbox写入失败 | 与资产同事务回滚，不留下未记录资产修改 |
| C09 | 发布成功但outbox标记前崩溃 | 可重发相同eventId，消费去重 |
| C10 | GM后台资产操作与拾取/商店/任务并发 | 串行或明确拒绝冲突，旧Profile不覆盖新状态 |
| C11 | 数据库锁等待/工作队列满 | 有界拒绝/处理中，不无限堆积；延迟被记录 |
| C12 | 生产 Store 缺失、迁移失败、审计不可写 | 高风险功能关闭，不降级为假成功 |

### D. 多频道、跨服与压力

| ID | 场景 | 应有结果 |
|---|---|---|
| D01 | 两个真实频道中的同一地图 | 实体、掉落和地图聊天隔离 |
| D02 | 频道聊天与区服聊天 | 一个不跨线，一个按权限跨线 |
| D03 | 跨频道密语目标迁移 | 旧路由不误投，相同messageId有限重试 |
| D04 | 同角色重复加入另一频道 | 保持唯一权威归属，detached也占归属 |
| D05 | 两个区服存在同名角色 | 指定目标不混淆，来源徽章可信 |
| D06 | 总线重复/乱序/分区/重启 | 临时消息按约定降级，公告按版本恢复，本服继续 |
| D07 | 热点房间与慢读连接同时存在 | 队列和内存有界，控制/玩法不被无限挤占 |
| D08 | 总线伪造来源/普通客户端订阅管理路由 | ACL/身份验证拒绝，玩家消息不能执行GM |

---

## 16. 测试入口与基线纪律

### 16.1 仓库记录，不是本次测试结果

仓库 `artifacts/refactor/baseline-metrics.json` 在 2026-09-12 记录过：Rust 292 passed / 6 failed；TS 类型检查通过；前端逐项检查 16 passed / 1 failed。它没有提供 world tick 的 p50/p95/p99。[R20]

记录的 Rust 失败名：

```text
auth::tests::third_store_book_split_and_222_compatibility
mage::tests::bundled_catalog_is_strict_and_has_energy_bolt_geometry
world::tests::config_drop_and_exp_are_authoritative_without_client_values
world::tests::portal_command_changes_map_and_snapshot_scope
world::tests::reactor_area_herb_auto_triggers_once_per_entry_and_can_trigger_again_after_exit
world::tests::third_sphere_and_adaptation_are_idempotent_and_bounded
```

前端记录的失败是 `features/npc/dialogue.check.mjs` 中 data: URL 对相对导入的解析问题。实施时必须重新运行确认；不能把“曾被标记旧失败”当永久豁免。[R20]

### 16.2 建议执行命令

以下测试不启动另一套游戏服务；在项目根目录执行。`--offline` 适用于依赖已经缓存的环境，依赖未缓存时报清楚原因，不升级依赖来绕过。

```bash
git rev-parse HEAD
cargo test --offline --manifest-path server/Cargo.toml -- --list
cargo test --offline --manifest-path server/Cargo.toml
(cd client && npm run typecheck)

# 现有专项文件：逐条执行并记录退出码。
(cd client && node src/features/chat/whisper.check.mjs)
(cd client && node src/features/chat/emoticon.check.mjs)
(cd client && node --experimental-strip-types src/features/chat/scroll.check.ts)

# 新增 check:chat 后，再使用以下统一入口；当前 package.json 尚没有它。
# (cd client && npm run check:chat)

# 日常实际服务启动与最终功能验收，仍然使用唯一脚本。
zsh ./启动3010.command
```

Node 工具链遵从启动脚本的 Node 22+ 要求。上述命令是否通过由实际执行输出决定；本次没有执行它们。不要把已有检测脚本都当成浏览器 E2E，也不要把单元测试通过当成慢连接/跨服故障测试已覆盖。[R16][R17]

### 16.3 自动化与证据目录

建议创建：

```text
evidence/chat-ops/<commit-short>/
  baseline.json          # 版本、命令、退出码、已知差异
  protocol-cases.json    # 非法字段/长度/版本
  delivery-cases.json    # Full/Closed/Detach/Replay
  operations-cases.json  # 事务崩溃点、幂等、审计
  performance.json      # 带机器、构建方式、客户端数的实测
  browser-notes.md       # 输入法/焦点/跑马灯/切角色
```

这是拟新增证据组织，不是本次已生成验收记录。记录不得含 token、真实私聊正文或不必要账号隐私；测试用临时库与测试身份，绝不拿生产角色做资产压力测试。

---

## 17. 性能与容量：先测，再定门槛

50ms 是现有 tick 配置，不是“任何压力下均能50ms完成”的证明。容量 32/1024/256 同样是现状配置，不是承诺能稳定承载的玩家规模。[R01][R02][R03][R20]

### 17.1 最少指标

| 指标 | 意义 |
|---|---|
| world_step_duration_ms、input_queue_depth | 聊天是否影响模拟推进 |
| chat_accept/reject_total，按有限枚举 reason/surface 分组 | 限流、禁言、非法输入、不可达比例 |
| output_enqueue_total，结果 Enqueued/Full/Closed | 不再忽略出站失败 |
| chat_fanout_count / duration、serialized_bytes | 热点房间与重复序列化成本 |
| chat_result_replay/conflict/window_expired_total | 重试正确性与缓存压力 |
| detached_resident_count、active_connection_count | 驻留不等于在线可达 |
| store_lock_wait_ms、transaction_ms、ops_queue_depth | 同步数据库与后台工作的真实争用 |
| outbox_oldest_pending_age、attempts、dead_letter_count | 持久事件是否卡住 |
| gm_operation_latency / rejection / applied_pending | 已提交和已应用之间的延迟 |

指标标签不要包含每条 messageId、完整角色名或每个 operationId，避免高基数；这些放进受限结构化日志或可查询记录。当前未安装 tracing 依赖，可先有界计数/结构化输出，确需观测栈时单独评估，不为聊天先部署整套监控平台。

### 17.2 压力场景

先测正常游戏无聊天基线，再测相同玩家数与地图分布下的聊天压力。建议起点为 2、16、64 个连接，逐步逼近现有连接上限；这些是测试档位，不是容量承诺。

至少覆盖：多人同图、均匀分图、集中密语一个接收者、客户端停读、反复断线接管、数据库延迟、跨服总线失联。记录硬件、Debug/Release、地图实体数、消息速率和测量窗口，不能只报一个“并发数”。

建议发布门槛：无新增功能回归；内存/队列无持续增长；控制消息不饥饿；聊天导致的模拟额外开销有上界。具体 p95/p99 预算在 CHAT-00/06 的真实基线上确定，不能现在填一个虚构的毫秒值。

---

## 18. 上线、迁移和回滚

### 18.1 上线分层

建议配置开关：`chat_v2`、`system_notices`、`announcements`、`admin_read_only`、`admin_mutations`、`paid_broadcast`、`multi_channel`、`cross_realm_chat`。它们是拟新增逻辑开关，不是当前已支持的环境变量；实现时统一配置来源，避免主函数散落八份 env 解析。

顺序：测试环境 → 单服少量账号 → 单服全量 → 两频道测试 → 跨服测试。管理修改与付费广播默认关闭；只读诊断、普通聊天不必等高风险功能一起开放。

### 18.2 数据库迁移

先通过 SQLite 一致性备份机制创建可恢复副本，在副本验证版本迁移、约束、重复运行和旧角色读取。在线数据库不能只复制正在变化的主文件就当作完整可靠备份；可使用 SQLite Online Backup API 或官方支持的备份方式。[S07]

新增表与列采用可重入、可验证迁移。旧记录默认归属单区服/频道1时，要记录依据。不能直接把旧 drop 行复制到每个频道；那是复制资产。

回滚优先关闭功能、回退兼容代码，保留已经提交的 operation/audit/outbox。数据库恢复备份是灾难恢复，会丢失备份之后的新事实，不能把它当成普通代码回滚按钮。

### 18.3 协议发布与运行身份

两端协议一起构建、启动脚本健康检查通过后才开放入口；旧页面按现有版本规则要求刷新。建议 `/api/health` 增加非敏感 buildCommit、bootEpoch、enabledCapabilities，帮助确认正在测的是源码对应的构建，而不是旧 dist。不要公开内部 token、数据库路径或管理授权表。

新增字段保持既有 ok/protocolVersion/contentVersion 语义，避免破坏启动脚本。资源构建失败时保留原进程的现有行为，不让聊天改造破坏“先构建成功再停止”的安全顺序。[R01][R17]

### 18.4 停机与恢复

停机时停止接受新资产管理操作，允许已提交结果通过查询恢复；有界排空 outbox/工作队列，超过截止时间仍必须保留待处理记录。不能因为关机就把未发送 outbox 标记成功。临时普通聊天可以结束，不补造离线历史。

---

## 19. 第一张可直接交给开发代理的任务

### 任务：修复已实现聊天的投递与恢复语义，不新增跨服系统

**输入基线**：本文提交及实施时实际 HEAD。先输出两者差异，保留其他已完成重构。

**第一轮只做 CHAT-00、CHAT-01、CHAT-02，并为 CHAT-03 写失败测试。**

具体要求：

1. 阅读 `network.rs`、`messaging.rs`、Player/Command 的连接状态、`client/src/network/session.ts`、现有 chat/whisper acceptance；记录真实测试基线。
2. 为 `connect → close → stopped` 写最小测试，分离“清理旧连接”与“主动停止重试”，保留旧 socket 回调隔离和焦点保护。
3. 在聊天可达性上使用现有 detached 与 connection，给 Full/Closed 明确结果；不能把留在世界的角色删掉，也不能重置暂离起点。
4. 为地图拒绝后重试、密语原回显、目标退出后重放建立失败用例。下一张 PR 再升级结果记录和双端协议，不把所有变更揉进一次提交。
5. 不引入 NATS/Redis、ECS、新数据库、独立聊天微服务、任意 GM 命令；不修改技能/碰撞/掉落数值，不批量搬移 world.rs。
6. 所有服务运行统一用 `启动3010.command`。专项测试可使用临时库/假socket，但不能启动另一套日常服务或改写真实数据库。

**交付**：文件级 diff、真实运行的命令与输出摘要、失败集对比、新增测试说明、仍未解决的语义、下一张 PR 的明确输入。不能只写“已完成聊天系统”或“全部通过”而没有证据。

---

## 20. 证据索引与尚未验证事项

### 20.1 仓库证据

下面的永久链接固定到本次审查提交。行范围表示本次实际读取的范围或定位到的文件；“目录”用于核实文件存在，不代替读取内部实现。源码在后续提交中可能已经变化，实施前应重新定位符号。

| ID | 来源与读取范围 | 固定提交链接 |
|---|---|---|
| [R01] | `server/src/main.rs`；完整入口：World 装配、队列、数据库、路由、静态资源和健康检查 | `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/server/src/main.rs` |
| [R02] | `server/src/network.rs`；完整网络入口：Hello、VerifyCharacter、32条出队、限流、Detach/Exit、writer超时 | `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/server/src/network.rs` |
| [R03] | `server/src/world.rs`；已读1–280、1700–1870、2260–3130：模块、Command、Away、Player、World及构造 | `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/server/src/world.rs` |
| [R04] | `server/src/messaging.rs`；已读1–490：地图聊天、完整密语及回放、共享预算、表情入口；其余行为以完整模块核查为后续 | `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/server/src/messaging.rs` |
| [R05] | `server/src/protocol.rs`；已读1–750：版本、完整ClientMessage、valid与正文/名字/ID规则 | `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/server/src/protocol.rs` |
| [R06] | `shared/protocol.ts`；已读1–230：共享版本、Player/关系状态、已有客户端意图 | `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/shared/protocol.ts` |
| [R07] | `server/src/auth.rs`；已读1–230：Identity、Session、Store、auth子模块与相关状态形状 | `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/server/src/auth.rs` |
| [R08] | `server/src/auth/schema.rs`；已读1–180：建表、WAL、既有业务动作记录与资产表 | `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/server/src/auth/schema.rs` |
| [R09] | `server/src/auth/bag.rs`；已读1–145：prior_inventory、move_inventory的锁、事务、结果记录 | `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/server/src/auth/bag.rs` |
| [R10] | `server/src/lobby.rs`；已读1–200及230–420：固定频道、角色表与账号归属、旧角色迁移和大厅入口 | `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/server/src/lobby.rs` |
| [R11] | `client/src/features/chat/view.ts`；已读1–210：Hooks、Envelope、pending、系统去重、回显和clear | `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/client/src/features/chat/view.ts` |
| [R12] | `client/src/features/chat/scroll.ts`；完整文件：40行DOM上限、滚动位置保护 | `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/client/src/features/chat/scroll.ts` |
| [R13] | `client/src/network/session.ts`；完整文件：connect/close/stopped、重试、JSON解析、发送结果 | `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/client/src/network/session.ts` |
| [R14] | `client/src/app/main.ts`；已读1–170：真实Phaser/Chat/Notice装配、news/status展示、输入焦点基础 | `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/client/src/app/main.ts` |
| [R15] | `server/Cargo.toml`；完整文件：实际后端依赖约束，无NATS/Redis依赖 | `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/server/Cargo.toml` |
| [R16] | `client/package.json`；完整文件：Phaser/TS/Vite依赖、typecheck/build/check脚本 | `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/client/package.json` |
| [R17] | `启动3010.command`；完整脚本：资源检查、先构建后重启、0.0.0.0:3010、固定数据库与bot | `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/%E5%90%AF%E5%8A%A83010.command` |
| [R18] | `BACKEND_ARCHITECTURE.md`；已读前220行返回内容：世界兄弟子模块拆分规范；具体实现仍优先看源代码 | `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/BACKEND_ARCHITECTURE.md` |
| [R19] | `FRONTEND_ARCHITECTURE.md`；已读前125行返回内容：DOM/Phaser职责与装配原则；旧状态描述不直接当现状 | `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/FRONTEND_ARCHITECTURE.md` |
| [R20] | `artifacts/refactor/baseline-metrics.json`；完整记录：历史测试失败集、未测性能项；不是本次执行结果 | `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/artifacts/refactor/baseline-metrics.json` |
| [R21] | `server/README.md`；完整文件：启动说明与需要纠正的陈旧实现状态 | `https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/server/README.md` |
| [R22] | `client/src/features/notice`；完整目录树：away.ts、death.ts；非完整内部实现审计 | `https://github.com/dragon717/MapleStory/tree/1fefe97c2d27a928f3bf670b657d79f68d795fe9/client/src/features/notice` |
| [R23] | `client/src/features/chat`；完整目录树：view/scroll/emoticon及现有检查文件 | `https://github.com/dragon717/MapleStory/tree/1fefe97c2d27a928f3bf670b657d79f68d795fe9/client/src/features/chat` |

### 20.2 官方工程资料

下面资料只用于解释采用的工程语义，不作为“原版 TMS273 内部实现”的证据，也不代表建议将当前依赖升级到文档 latest 版本。

| ID | 官方来源 | 支持的结论 |
|---|---|---|
| [S01] | Tokio mpsc 官方文档：`https://docs.rs/tokio/latest/tokio/sync/mpsc/index.html` | 有界队列、关闭、背压与排空；不代表队列自动实现业务可靠投递 |
| [S02] | SQLite Isolation：`https://www.sqlite.org/isolation.html` | WAL隔离、读写关系与单写事务限制 |
| [S03] | OWASP WebSocket Security：`https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html` | Origin、会话与逐消息授权、防滥用、敏感日志边界 |
| [S04] | OWASP Authorization：`https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html` | 默认拒绝、最小权限、逐请求授权与权限测试 |
| [S05] | NATS JetStream 概念：`https://docs.nats.io/concepts/jetstream` | 持久流与确认/重投；不能替代业务资产事务和消费者去重 |
| [S06] | Redis Pub/Sub：`https://redis.io/docs/latest/develop/pubsub/` | 至多一次的发布订阅语义与持久Streams的区别 |
| [S07] | SQLite Backup API：`https://www.sqlite.org/backup.html` | 在线一致性备份与其他官方备份方法 |

### 20.3 本次没有声称完成的事

没有运行 Rust/前端测试，没有启动3010，没有进行浏览器输入法测试、慢连接压测、数据库崩溃注入或两服互联。仓库中“292通过/6失败”等记录属于已有证据，不是本次环境输出。

本次没有完整逐行审计所有 `auth/loot.rs`、social/party、World 广播与地图迁移路径；这些跨模块事务在对应工单中仍需补读。尤其多频道不能只依据本计划的数据表格进行全局字符串替换。

本次确认的是项目当前边界与具体代码落点，以及从这些边界推导的实施顺序。TMS273 原作各类喇叭道具价格、跨频道范围、公告样式和保存历史等未在本次另行取证；所有新增产品规则都是本项目建议，不能标为原作已证实数值。

**最终判断：现在最值得做的不是“先上一个跨服聊天服务”，而是让现有系统对每条消息说清楚：谁接受了它、要发给谁、是否排进了目标队列、重试得到什么、断线以后什么仍然存在。把这条链做可靠之后，再增加公告、GM 和跨服规模。**
