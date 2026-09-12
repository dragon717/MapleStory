# 冒险岛复刻：Rust 权威世界中的聊天、通知、审计与 GM 开发计划

> 版本：v1.0 · 研究日期：2026-09-09  
> 交付性质：公开资料调研 + 可执行的工程设计与开发工单；不是已完成的代码改造。  
> 覆盖：私聊、公共聊天、跨频道聊天、跨服聊天、跑马灯、系统公告、系统消息、操作日志、GM 命令。  
> 适用背景：现有 Rust 服务端的冒险岛复刻项目；客户端接入以现有实现为准，本文给出 Web/TypeScript 接入约定。  
> 启动约束：所有服务启动、集成验证与多节点测试统一经项目 `启动3010.command` 编排，不另写一套绕过它的启动入口。

---

## 0. 先看结论：做四个业务域，而不是九套广播接口

**建议路线：先在现有 Rust 进程中建立明确的模块边界与真实权限校验，完成“两个逻辑区服、不同频道”的正确性测试；确实拆进程时，再替换跨节点传输。**

四个业务域：

| 业务域 | 负责什么 | 绝不能顺手负责什么 |
|---|---|---|
| `Chat` | 玩家文本、私聊、房间成员资格、禁言与路由、聊天回执 | 直接加物品、改坐标、执行任意字符串命令 |
| `Notification` | 系统消息、公告生命周期、跑马灯等展示投影 | 把通知送达当成奖励到账；充当世界状态事实源 |
| `AdminCommand` | GM 身份与权限、参数解析、预检、调度权威命令、查询结果 | 在网关或数据库旁路改玩家内存；把登录视为管理员授权 |
| `Audit` | 记录已经提交的关键操作及管理行为，支持追责与检索 | 用 `println!` 或可能丢失的日志队列代替业务提交记录 |

共用少量基础设施：身份与会话、稳定 ID、限流器、错误码、出站队列、持久化事务、跨节点传输适配器。**共用基础设施不等于混成一个 `broadcast(kind, text)`。**

最重要的五条不变量：

1. 客户端只提交意图。发言人、所在区服/频道/地图实例、GM 权限、系统身份均由服务端决定。
2. 只有状态所属的权威执行者可以改变角色、地图、背包与处罚状态。聊天服务不能成为第二个世界写入口。
3. 普通聊天允许有限丢失并明确反馈；经济操作、付费喇叭、GM 修改与关键审计必须依赖持久化提交及业务幂等。
4. 慢连接、刷屏、数据库变慢和消息总线故障，都不能让世界 tick 等待网络或磁盘。
5. 广播范围、可靠性、展示位置、消息作者是不同维度，不能互相代替。

**第一版必须做完整的，是权限与失败语义；不是分布式组件数量。**

---

## 1. 调研依据与项目证据边界

### 1.1 本次已核对的项目背景

已检索到项目此前的 `references/tms273_research_pack/00_RESEARCH_AND_REMAKE_PLAN.md` 与相关 `README.md`。已有建议采用：

```text
Client UI/Input
  → Commands
  → World / Combat / Quest / Inventory / Progression
  → Committed Events
  → Views / Replication
```

相关资料明确倾向单进程模块化、小规模地图实例，而不是先拆微服务。本计划沿用这个方向。

**没有检索到可直接审查的当前 MapleStory 仓库代码。** 已连接 GitHub 的仓库搜索未返回匹配项目。因此本计划不声称已经确认 Tokio/Axum、数据库、WebSocket 库、目录结构、当前 `World` 所有权实现或聊天完成度。P0 应从实际世界主循环、协议枚举和连接写入器定位接入点；文中的类型名与路径示意不能当成已经读取过的定义。

本文所有新增目录、类型、容量、速率、保留期限和性能目标均为**本项目设计提案**，不是现有实现或冒险岛原厂参数。

### 1.2 外部资料带来的设计结论

| 证据 | 可确认的事实 | 本项目采用的设计 |
|---|---|---|
| MapleSEA 官方 UI 指南 [S01] | 聊天框承载好友、私聊、公会、喇叭，也显示服务公告、提示和任务提醒 | UI 可以聚合，后端事实仍分域 |
| 韩国冒险岛官方聊天指南 [S02] | 有聊天过滤、标签及一般/私聊/组队/公会/联盟/好友等命令 | 预留这些语义；不将 UI 的“全部”误作全服广播 |
| Tokio 官方教程与 API [S03–S05] | 消息传递可集中资源所有权；有界队列提供背压；广播接收者可能落后并丢旧消息 | 权威状态单写、有界入站/出站、不用 `broadcast` 承担可靠任务 |
| Nakama 官方聊天文档 [S06] | 区分房间、私聊、群组，以及持久化与非持久化消息 | 借鉴业务分类，不为了聊天替换现有游戏后端 |
| Redis 与 NATS 官方文档 [S07–S11] | Pub/Sub 与持久化流有不同投递语义；同组消费是分担而不是每节点各收一份 | 临时聊天与可靠业务事件选择不同传输；广播拓扑要单独验收 |
| AWS transactional outbox [S12] | 数据库修改与外部发消息存在双写不一致问题 | 关键业务把事实、审计及待发布事件一起提交 |
| OWASP [S13–S15] | WebSocket 仍需鉴权、逐请求授权、输入校验及安全日志 | 网关与业务层均有明确校验边界 |
| tracing-appender 文档 [S16] | 非阻塞日志可因队列满而丢弃，或选择施加背压 | 诊断日志与关键审计分离 |

版本边界：S01、S02 是跨地区/当前公开指南，**不能证明 TMS V273 的精确文字上限、聊天权限、喇叭消耗、屏蔽规则或颜色参数**。上述参数进入待实测清单；不混入 MapleStory N、手游或怀旧服规则。本文是在复刻项目内实现可靠系统，不声称复原原厂内部架构。

---

## 2. 先统一“服、频道、地图、房间”的含义

| 概念 | 本文含义 | 示例 |
|---|---|---|
| `RealmId` | 玩家看到的逻辑区服/世界，属于身份与业务隔离边界 | R1、R2 |
| `GameChannelId` | 同一区服下可切换的游戏频道 | R1 的 CH1、CH2 |
| `MapDefId` | 地图模板 ID，不代表唯一在线场景 | 同一个射手村模板 |
| `MapInstanceId` | 具体地图实例，普通地图与副本实例都必须可区分 | R1/CH1 的实例 A，与副本实例 B |
| `NodeId` | 部署进程/节点，不直接暴露为聊天权限 | 一个节点可托管多个频道 |
| `ChatRoomKey` | 聊天逻辑房间，具有明确成员规则 | 地图、频道、区服、队伍、私聊会话 |
| `CrossGroupId` | 允许互通的一组区服或跨服活动范围 | R1+R2 联通组，不默认包含所有区服 |
| `SessionEpoch` | 当前有效登录会话代次，用于拒绝旧连接 | 重登后递增 |
| `RouteEpoch` | 角色地图/频道路由代次，用于处理迁移期间的旧投递 | 换图、换线后递增 |

命名规则：代码中用 `GameChannelId` 表示游戏频道，避免与 Tokio channel、消息总线 subject、UI tab 同名混淆。

**跨频道不等于跨进程；跨进程也不等于跨服。** 一个进程托管 R1 的多个频道时，跨频道只是查询不同成员集合。同一区服的两个进程仍然是同服；两个逻辑区服在一个进程里也必须保持跨服权限隔离。

角色身份优先复用项目已有全局角色 ID。若现有 ID 只在区服内唯一，则使用 `(home_realm_id, local_character_id)`；显示名仅用于查找与展示，不能作为永久主键。跨服迁移/合服不得偷偷改变历史消息作者身份。

---

## 3. 功能矩阵：范围、权限、可靠性一次定清

表中的“首版”指完成 P0–P2 后的单进程版本；物理多节点是 P3。

| 功能 | 目标范围 | 服务端校验 | 首版交付与历史 | 后续能力 |
|---|---|---|---|---|
| 私聊 | 同服另一角色，允许跨游戏频道 | 目标解析、发送权限、屏蔽/隐私、在线或迁移状态 | 在线投递、明确回执、会话内记录；不默认为离线留言 | P4 可选离线私聊及历史 ACL |
| 地图公共聊天 | 同一 `MapInstanceId` 的玩家 | 当前实例成员资格、禁言、频率 | 最佳努力实时投递，短环形缓冲；气泡只对当前地图有效 | 可选基于距离/AOI 的近聊 |
| 当前频道聊天 | 同 `RealmId + GameChannelId` | 所在频道及该频道的开放策略 | 实时投递；没有设计需求时功能开关关闭 | 招募/交易频道策略 |
| 同服跨频道聊天 | 同一区服全部频道，或合法的队伍/公会/好友范围 | 发言资格、群组成员资格、冷却或消耗规则 | 先做区服房间与同服跨线私聊；不自动开放无限世界喊话 | 队伍、公会、联盟接入既有社交模块 |
| 跨服聊天 | 指定 `CrossGroupId` 或跨服活动房间 | 来源区服、跨服组成员、活动资格、目标权限 | 先做同进程两个区服隔离；P3 验证真实跨节点投递 | 跨服私聊需显式产品开关 |
| 跑马灯 | 可为地图、频道、区服、跨服组 | 来源身份、事件资格、展示策略 | 作为通知的展示投影；去重、优先级、过期、取消 | 玩家喇叭在事务能力就绪后接入 |
| 系统公告 | 指定范围内当前及后续登录玩家 | 管理员发布权限、范围、排期、版本 | 持久公告、登录快照、修改/撤回、有效期 | 重复排期、多语言、审批 |
| 系统消息 | 单人/队伍/地图等，通常来自业务提交 | 可信内部事件、目标关系、模板参数 | 错误提示、获得物品、任务变化等；无客户端资产副作用 | 通知中心、重要消息补查 |
| 操作日志 | 玩家关键操作、经济账本、GM 审计、诊断分别存放 | 服务端产生；查询也要授权 | 关键事实可追溯，技术日志结构化 | 归档、受限检索与导出 |
| GM 命令 | 指定角色/地图/区服 | 独立管理身份、能力、目标范围、风险策略 | 先查询/禁言；再受控传送、生成测试实体及经济命令 | 审批、批量任务、撤销/补偿工单 |

补充边界：

- “全部聊天”是 UI 对已获授权消息的聚合，不是服务端向全世界订阅的权限。
- 系统公告不等于系统消息。公告是有生命周期的运营内容；系统消息通常是一个业务结果的呈现。
- 重要通知补查不等于业务执行补做。客户端重放“获得物品”通知时，绝不能再发一次物品。
- 好友群发不是一个所有好友互相可见的永久公共房间；需要按发送者的好友关系计算接收人，不能误建共享聊天室。

---

## 4. 总体架构：权威世界保留单写，网络投递离开 tick

```text
玩家客户端                         受控管理入口 / 开发控制台
   │ ChatSend / GameplayCommand          │ AdminCommandRequest
   ▼                                     ▼
Gateway：认证、包限长、连接限流       AdminAuth：独立身份、能力、目标范围
   │ 服务端补齐 SessionContext           │ 预检 / 原因 / 风险确认
   ├──────────────────┐                  │
   ▼                  ▼                  ▼
ChatService       WorldCommandMailbox ← AdminCommandService
文本与社交策略       World / Character / Map 权威执行者
房间与成员校验       状态版本、规则、背包、处罚、地图实例
   │                  │
   │                  ├─ 必要的持久化事务 → 审计 / 账本 / outbox
   │                  └─ Committed Domain Events
   │                                  │
   └─ Accepted ChatEvent              ▼
                              NotificationService
                              模板、范围、展示投影
                 │                    │
                 └──────────┬─────────┘
                            ▼
                  DeliveryRouter / LocalTransport
                            │
                   有界 Session Outbox
                            │
                  每连接唯一 Socket Writer
                            ▼
                       玩家客户端

P3 扩展：LocalTransport 的跨节点路径 → NATS / JetStream 适配器
        不重写 ChatService / AdminCommand 的业务规则。
```

### 4.1 哪些事必须在权威执行者里

地图聊天发送时的当前实例判定、换图/换线状态更新、付费喇叭扣道具、GM 改属性/发物品/传送、处罚状态变更，以及系统消息所依赖的玩法事实。

处理方式不要求整个游戏一个大 Actor。**保留现有世界循环或状态所有权结构，在其边界上加入类型化命令与结果。** 当前已经是同步单线程世界循环时，优先新增 `handle_command` 和提交后的输出，不为接聊天重写成 Actor 框架。

### 4.2 哪些事不要放进世界 tick

逐连接 socket 写入、数据库查询/等待、远程消息发布、文本外部审核、公告长文本渲染、日志落盘、大范围逐人复制序列化。

权威执行者可以同步生成不可变的消息事实及接收范围，随后交给有界投递层。地图成员快照必须从一致的世界状态取得；不把 `&mut World` 或长期持有的世界锁传给网络任务。

持久化经济操作在磁盘确认前只进入 `PendingCommit`，通过完成消息继续执行；阻止同一角色相关状态并发越过未完成的版本，**不阻塞整个地图 tick**。具体提交机制见第 14 节。

### 4.3 Tokio 使用约束

Tokio 的 `mpsc`、`oneshot`、`watch` 和 `broadcast` 用途不同；官方教程明确强调有界排队与并发上限。[S03–S05]

| 原语/结构 | 本计划用途 | 禁止误用 |
|---|---|---|
| 有界 `mpsc` | 命令邮箱、I/O 工作队列、单连接出站队列 | 在世界 tick 中无限等 `send().await` |
| `oneshot` | 单次命令最终结果通知 | 接收端超时便假定业务已回滚 |
| `watch` | 最新配置、当前公告快照版本等“只关心最新值” | 传递每条 GM 操作或每条私聊 |
| `broadcast` | 可容忍丢失的内部观察者/诊断 | 可靠通知、经济审计、GM 执行唯一通道 |
| `Arc<ImmutableEvent>` | 同一已校验消息的共享只读正文 | 共享可变世界对象并跨 `.await` 持锁 |

`broadcast` 接收者落后可能收到 `Lagged` 并丢失旧值；返回了订阅者数量也不意味着客户端实际收到了消息。[S05] 任何用到它的地方都必须写清 `Lagged` 的处理策略。

---

## 5. 一条玩家发言的完整处理流程

```text
1. 已认证连接收到 ChatSend
2. 检查协议版本、消息大小、合法枚举、字符串上限
3. 用服务器会话取代任何客户端身份/地点声明
4. 做廉价连接与账号限流
5. 对 request_id 查幂等结果；相同 ID 不同参数必须拒绝
6. 将文本转换为 ValidatedText，校验链接引用与控制字符
7. 在对应权威边界核对：有效会话、禁言、房间成员、当前路线
8. 若有道具消耗，转到世界经济事务；没有消耗则继续
9. 由房间拥有者分配 message_id、stream_epoch、stream_seq
10. 生成不可变 ChatEvent，按该类型的可靠性接受/提交
11. 给发送者明确回执；向被授权接收者投递
12. 更新指标与受限的事件证据，不把私聊全文写进普通 tracing
```

校验顺序允许以测量结果优化，但不得绕过语义校验。重复请求仍受基础入口防滥用限制；业务幂等命中后不重复扣费、不重复扣发言额度。

需要远程审核时，使用有限并发与超时。审核通过后**重新验证**会话代次、禁言、房间/地图成员和道具条件。离开地图后才返回的审核结果，不能按旧成员快照重新发出地图发言。

---

## 6. 领域模型：拆开作者、受众、内容、展示与保证

以下 Rust 是**领域类型草案**，用于冻结边界，不是现有仓库补丁。业务 ID 复用项目定义，生产代码不以任意 `String` 替代所有类型。

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct RealmId(pub u32);
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct GameChannelId(pub u16);
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CharacterId(pub u64);
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct MapInstanceId(pub u64);
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct GroupId(pub u64);

// CharacterId 在整个部署域唯一；否则改为 home_realm + local_id 的组合。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ChatRoomKey {
    Map { realm: RealmId, channel: GameChannelId, instance: MapInstanceId },
    Channel { realm: RealmId, channel: GameChannelId },
    Realm { realm: RealmId },
    Direct { low: CharacterId, high: CharacterId }, // 由服务端排序归一化
    Party { realm: RealmId, party: GroupId },
    Guild { realm: RealmId, guild: GroupId },
    Alliance { realm: RealmId, alliance: GroupId },
    CrossGroup { group: GroupId },
}

// 客户端只有“我要向哪里说话”的意图，没有任意 Audience 权限。
#[derive(Debug, Clone)]
pub enum ChatIntent {
    Map,
    CurrentChannel,
    Realm,
    Whisper { target: CharacterId },
    Party,
    Guild,
    Alliance,
    CrossGroup { requested_group: GroupId },
}

// 只由受信业务代码构造；不能作为通用的客户端 Deserialize 入口。
#[derive(Debug, Clone)]
pub enum Audience {
    Character(CharacterId),
    Room(ChatRoomKey),
    Realm(RealmId),
    CrossGroup(GroupId),
}

#[derive(Debug, Clone)]
pub enum MessageAuthor {
    Player { character: CharacterId, display_name: String },
    System { producer: String },
    Operator { public_label: String }, // 真实操作者写受限审计，不直接泄露给玩家
}

#[derive(Debug, Clone, Copy)]
pub enum Presentation {
    ChatPanel,
    SpeechBubble,
    Toast,
    Marquee,
    NotificationCenter,
}

#[derive(Debug, Clone, Copy)]
pub enum DeliveryClass {
    Ephemeral,       // 临时：允许有界丢失，不提供离线补发承诺
    Recoverable,     // 有持久事实/历史源，可以按授权补查
    CriticalCommand, // 控制任务；不得和玩家聊天共用可丢队列
}
```

进一步约定：

- `ValidatedText` 构造器只接受通过规范化与限长的正文；对外 DTO 与可信内部事件分开。
- `ChatContent` 可扩展为 `TextSegment` 与 `ItemLinkRef`。装备链接由服务端生成展示快照或授权引用，不能信任客户端填的攻击力、潜能或任意 HTML。
- `SystemNotification` 使用 `template_key + template_version + typed_args`；接收端未知模板时使用服务端安全 fallback 文本。模板参数中金额、物品实例等仍为类型化值。
- `MessageId` 可复用项目全局 ID；没有现成方案时采用成熟 UUID 实现。UUID/时间戳不能替代业务顺序号。[S17]
- `Operator`、`System`、`CriticalCommand` 不进入普通客户端发言协议。尤其不能让玩家提交 `author_type=system`。

内部事件统一可追踪元信息，但不强求同一个巨型结构承载所有业务：

```text
event_id / message_id
request_id（客户端重试标识，不等于权限）
causation_id（原始命令或业务事件）
trace_id
schema_version
occurred_at_utc_ms
source_realm / source_node
room_key（适用时）
stream_epoch + stream_seq（适用时）
expires_at（适用时）
```

`session_epoch`、`route_epoch`、目标连接、内部操作者账号及敏感审计参数只在服务端路由信封中使用，不随普通广播泄露给其他玩家。

---

## 7. 协议草案与错误语义

### 7.1 复用现有连接和编解码

默认沿用项目现有的客户端/服务端消息枚举、认证流程与 socket writer；实际类型名称在 P0 核对。只有测量证明聊天造成严重队头阻塞后，才另评估独立聊天连接；第一版不增加第二套登录和心跳。

若当前采用 JSON，所有 `u64/u128` 业务 ID 和长序列号在线路上用十进制字符串，避免客户端数值转换破坏标识；服务端严格解析为对应新类型。时间戳使用可精确表示的毫秒值，并限制合法区间。JavaScript 的整数精度边界见 [S18]。

### 7.2 玩家请求示例

```json
{
  "type": "chat.send",
  "version": 1,
  "request_id": "req-client-00042",
  "target": { "kind": "whisper", "character_id": "720000018" },
  "content": { "kind": "text", "text": "来二频道一起打怪吗？" }
}
```

地图发言的 target 仅为 `{"kind":"map"}`，由服务端推导当前地图实例；不能要求客户端提供有权广播的实例 ID。

### 7.3 服务端回执与正式消息

```json
{
  "type": "chat.receipt",
  "request_id": "req-client-00042",
  "message_id": "msg-server-00088",
  "status": "accepted",
  "delivery_class": "ephemeral"
}
```

```json
{
  "type": "chat.message",
  "version": 1,
  "message_id": "msg-server-00088",
  "request_id": "req-client-00042",
  "room": { "kind": "direct", "conversation_id": "dm-opaque-17" },
  "stream_epoch": "epoch-opaque-1",
  "stream_seq": "27",
  "author": { "kind": "player", "character_id": "720000017", "display_name": "测试角色A" },
  "content": { "kind": "text", "text": "来二频道一起打怪吗？" },
  "occurred_at_utc_ms": 1788912000000,
  "replay": false
}
```

示例 ID 为占位字符串，不是 UUID 格式要求或原作协议。`request_id` 在发送者回显中保留用于合并 pending；转发给其他玩家时可省略。

### 7.4 不要把 Accepted 翻译成“对方已收到”

| 状态 | 准确定义 |
|---|---|
| `accepted` | 服务端接受了这次临时发言，并尝试投递；不承诺持久化或阅读 |
| `persisted` | 可恢复消息已持久化，后续可按权限重试/补查 |
| `queued` | 管理任务已持久入队，尚未完成 |
| `delivered_to_session` | 接收客户端在协议层确认接收；不是玩家已阅读 |
| `committed` | GM/经济业务事实已提交，已生成相应审计 |
| `rejected` | 确认没有接受/执行，返回明确原因 |
| `pending_or_unknown` | 请求可能已经提交，但当前结果尚不可确定；用原 request ID 查状态 |

临时私聊可实现会话级送达确认，但首版不做已读回执。客户端超时后不得自动创建新的经济操作 request ID。

### 7.5 错误码

```text
INVALID_MESSAGE / MESSAGE_TOO_LARGE / UNSUPPORTED_VERSION
UNAUTHENTICATED / SESSION_REPLACED / PERMISSION_DENIED
CHAT_MUTED / RATE_LIMITED（附 retry_after_ms）
NOT_ROOM_MEMBER / ROOM_UNAVAILABLE / CROSS_REALM_DISABLED
TARGET_UNAVAILABLE / TARGET_AMBIGUOUS / ROUTE_CHANGING
BACKPRESSURE / SERVICE_UNAVAILABLE
IDEMPOTENCY_CONFLICT / REQUEST_PENDING
INSUFFICIENT_ITEM / STATE_VERSION_CONFLICT
AUDIT_UNAVAILABLE / COMMAND_EXPIRED / APPROVAL_REQUIRED
```

对外 `TARGET_UNAVAILABLE` 可统一隐藏“离线、屏蔽、关闭陌生人私聊”等原因，防止反向枚举隐私。内部审计可以记录准确失败分类。多角色同名必须返回消歧结果，不能猜一个发过去。

---

## 8. 路由设计：从地图到跨服，避免整服遍历与串房间

### 8.1 单进程索引

```text
sessions_by_character: CharacterId → ActiveSession
members_by_map_instance: MapRoomKey → Set<CharacterId>
members_by_channel: (RealmId, GameChannelId) → Set<CharacterId>
members_by_realm: RealmId → Set<CharacterId>
members_by_cross_group: CrossGroupId → 合法区服/活动成员索引
name_directory: 名称查找键 → 候选 CharacterId 列表
```

成员索引随登录、离线、换图、换线、入队/退队事务一起维护；只有索引拥有者写。广播成本与接收人数相关，而不是每条地图聊天遍历全服务器所有角色。P0 必须检查现有世界索引能否复用，避免又养一套不一致的在线名单。

地图普通聊天首版定义为同一实例所有在线成员可见；是否进一步按距离或 AOI 限制是独立产品选项。不能把渲染裁剪范围未经确认地当作聊天权限。

### 8.2 私聊

```text
发送者
 → 解析并固定目标 CharacterId
 → 校验隐私、屏蔽、禁言及跨服策略
 → 查询 Active / Transferring / Offline
 → 当前目标节点与有效会话
 → 目标节点再次检查身份与投递资格
 → 当前会话的出站队列
```

同服跨频道私聊不需要先把发送者迁到目标频道。首版跨服私聊默认关闭；开启时名称输入必须能够带区服消歧，不能把跨服公共房间的权限等同于可私聊所有人。

`/w 名称 正文`、`/r 正文` 是玩家命令：解析后转换为普通 `ChatIntent::Whisper`。最近联系人记录稳定角色 ID，改名不能导致回复误投他人。

### 8.3 换图/换线时的竞争处理

首版默认一角色一个有效游戏会话；旧连接被替换后不可继续发言或执行游戏/GM 操作。

```text
Active(node=A, route_epoch=7)
 → Transferring(transfer_id=T, old=A, new=B, route_epoch=8)
 → Active(node=B, route_epoch=8)
```

规则：

- 新路线激活时，旧路线被 fencing。旧节点提交、旧 socket 发言和迟到的旧 disconnect 都必须携带代次并接受比较。
- 私聊在 `Transferring` 时可以有限暂存，例如最多 32 条、最多 5 秒；这些是配置初值，不是持久化承诺。超限或迁移失败返回可重试/不可达结果。
- 向旧节点投递收到 stale-route 后，重新查路由，用**同一个 message_id**有限重投；不无限重定向、不重新生成消息 ID。
- 目标节点按 `(message_id, target_character_id)` 去重，再按当前有效会话投递。旧断线清理只能删除与自身 session/route epoch 相符的记录。
- 地图/频道消息携带接收时所需的成员版本。在 writer 投递前成员已经离开，则允许丢弃该临时消息，不能为了“不丢”将旧地图消息补到新地图。
- 已在换图前真正收到的文本可以保留在客户端聊天记录；**历史消息与迟到气泡不同**。重放记录不得在新地图生成旧角色气泡。
- 本计划不承诺跨节点迁移期间临时聊天绝不丢失；要求的是不越权、不误投、无无限等待，并能显示合理状态。

P3 的在线目录需要一个明确权威拥有者及持久化 CAS/版本约束。TTL 缓存只用于发现疑似离线，不是防止双活的依据。未知旧节点是否仍有效时，不因“超时”直接允许两个节点共同成为权威；宁可短暂拒绝迁移或聊天。

### 8.4 群组成员资格

队伍/公会/联盟由现有社交模块决定成员，不由 ChatService 自建一份“差不多”的事实。成员变更增加版本号；发送校验、路由与历史查询都按明确策略处理。

首版不实现跨会话群组历史：退出群组后立即失去未来消息资格。未来开放历史时，必须记录加入/退出区间，明确“只允许查看曾在群期间产生的历史”或其他产品策略，不能凭知道 room ID 就读取。

---

## 9. 可靠性、幂等、顺序与历史

### 9.1 按业务分层，而不是全部保证 exactly-once

| 类型 | 接受依据 | 断线/重启后 | 去重机制 |
|---|---|---|---|
| 地图/频道临时聊天 | 有界队列接受 | 不保证补发；展示有限 gap 提示 | 会话内有界 message_id 集合 |
| 首版在线私聊 | 权限通过且进入投递流程 | 不默认为离线保存 | request_id + message_id；回执不冒充已读 |
| 持久公告 | 公告记录已提交 | 登录/重连拉当前有效快照 | announcement_id + version |
| 重要个人通知 | 业务记录或 notification inbox 已提交 | 按游标补查 | notification_id + projection |
| 付费喇叭 | 扣道具、消息事实、审计、outbox 同事务提交 | 原 ID 重试发布；过期依策略处置 | 持久操作幂等键 + 消息去重 |
| GM 修改 | 业务修改、结果记录及审计同事务提交 | 查询结果或恢复执行；不能盲重试 | operator_id + request_id，参数哈希 |

Redis Pub/Sub 是 at-most-once；NATS Core 同样不提供离线重放。JetStream 提供持久化、确认和重投基础，但消息流的投递保证并不自动覆盖外部数据库里的业务效果。[S07–S09]

**采用至少一次重投 + 幂等业务效果，而不是声称 socket 到玩家阅读之间端到端只发生一次。**

### 9.2 两层幂等

入口幂等键：`(principal_id, operation_kind, request_id)`。必须存参数哈希；同一键不同内容返回 `IDEMPOTENCY_CONFLICT`。

事件消费幂等键：`(consumer_name, event_id)`。可靠消费时，去重标记、业务修改和结果在同一事务中完成，之后才确认消息。不能“先记已处理、后改背包”。

临时聊天幂等缓存可有界且允许重启后失效，UI 不自动在重连时重发全部旧草稿。经济/GM 幂等记录必须持久，保留时间覆盖所有允许重试/恢复的窗口；已过期的旧请求拒绝执行，而不是作为新请求再扣款。账本中的唯一操作键不应因短期缓存清理而消失。

### 9.3 顺序

- 地图房间由地图拥有者分配顺序；同服公共房间由其 ChatRoom 拥有者串行分配顺序。
- 私聊需要稳定顺序时，由归一化会话房间的单写拥有者分配，不由双方各自打时间戳后猜顺序。
- 临时房间用 `(stream_epoch, stream_seq)`；房间重建后改变 epoch。持久会话使用持久序号，不能重启归零。
- 不承诺不同房间、不同区服所有聊天的全局总序。UI“全部”按本连接投递顺序聚合，并显示服务端时间。
- 多个节点同时往一个总线 subject 发布，不等于已经实现业务所需的房间顺序。P3 先用明确的房间拥有者；房间拥有者故障时短暂不可用，不做未验证的自动双主切换。
- 前端用 message_id 去重，用房间序号辅助排序；有限重排窗口超过上限就显示缺口，不能永久等待缺失序号。

### 9.4 历史和重连

地图聊天首版只保留有界现场缓冲，不对后来进入的玩家开放过去内容，避免改变隐私预期。私聊只保留当前客户端会话记录；P4 才启用服务端历史和离线收件箱。

持久历史采用 `before/after cursor + limit`，服务端校验会话参与者/群组权限、页大小与过期范围。游标不等于授权令牌，不能凭游标跨角色查询。

为避免“拉完历史到开始订阅之间漏消息”，可先建立订阅并暂存实时消息，取得授权历史的 high-watermark，再拉到该水位并合并去重。重放消息标记 `replay=true`，只进入历史列表，不再次触发气泡、声音、跑马灯或奖励逻辑。

---

## 10. 背压和容量：不能让一个刷屏者拖慢打怪

### 10.1 有界不是只有一个 channel 容量

同时限制连接数、每账号请求量、消息字节数、每房间广播速率、并发验证任务、收件箱条数与字节数、重投次数、临时房间数量、历史缓存和去重集合。

不要对每条消息、每个接收者都无限 `tokio::spawn`。固定或明确限制 worker 数，按批处理 fan-out。私聊房间和临时实例空闲后回收；攻击者不能通过不断创建目标会话耗尽内存。

### 10.2 单连接投递策略

逻辑上分开控制结果、重要通知、玩家聊天和世界快照，但最终复用**每连接唯一 writer**，避免同时写同一个 socket。

| 数据类别 | 队列满时 |
|---|---|
| 普通聊天 | 有限丢弃/拒绝，累计缺口后合并提示；不逐条刷错误 |
| 私聊 | 优先于普通世界聊天，但仍有上限；回执不伪报送达 |
| 世界快照 | 仅在现有协议支持时合并为较新快照；增量事件不能随意丢 |
| 重要通知 | 持久事实保留，标记需重同步；必要时断开慢连接 |
| GM 结果/交易结果 | 结果已持久化，可重查；不因响应丢失撤销已提交事实 |

调度采用有界的加权公平策略。普通聊天不能饿死游戏控制流；所谓高优先级公告也不能无限占用线路。写超时后关闭该慢会话并清理资源，绝不反向阻塞世界循环。

### 10.3 初始参数（仅作为压测起点）

| 参数 | 建议初值 |
|---|---|
| 单条玩家文本 | 最多 200 个扩展字素簇，同时 UTF-8 不超过 1 KiB |
| 单条 ChatSend 编码大小 | 不超过 4 KiB；不是现有游戏所有包的通用上限 |
| 每连接聊天出站 | 128 条且总计不超过 128 KiB，先触及者生效 |
| 每连接重要控制/通知队列 | 独立预算 32 条且不超过 64 KiB；满时降级/断开 |
| 普通聊天令牌桶 | 每秒恢复 1 条，突发容量 5 |
| 私聊 | 账号总体每秒 2 条、突发 5；另对目标和首次陌生人设置限额 |
| 世界/跨服发言 | 独立冷却与整个房间广播预算，初始每人 10 秒 1 条 |
| 房间现场缓存 | 地图 50 条；每类房间有数量/字节上限和空闲回收 |
| 网络写入超时 | 初始 5 秒；按现有心跳与弱网测试修正 |

按最大消息体估算，1000 个连接 × 128 条 × 1 KiB，仅聊天正文的最坏排队预算就约 125 MiB，尚未包含其他队列、对象及索引。这是容量算例，不是实际内存测量。共享不可变正文能减少复制，但每连接队列项和序列化开销仍要预算。

---

## 11. 系统消息、公告与跑马灯

### 11.1 系统消息来自已确认的业务事实

```text
InventoryTransactionCommitted
 → 生成“获得道具”通知
 → UI 展示获得物品

QuestProgressCommitted
 → 更新任务面板 + 生成任务提示

ActionRejected
 → 单人错误提示（不假冒已提交玩法事实）
```

系统消息只是投影，不作为再次执行玩法的命令。把常见高频消息聚合，例如短时间内的金币拾取，**只合并展示，不合并或改写经济账本**。

模板字段：`template_key`、`template_version`、`typed_args`、`audience`、`severity`、`presentations`、`expires_at`、`causation_id`。服务器决定哪些业务事件可以发布到全服，不允许击杀普通怪物的消息自然冒泡成全服广播。

### 11.2 系统公告有状态，不是一次 `send_to_all`

```text
Draft → Scheduled → Active → Expired
             └──────────────→ Cancelled
```

公告至少保存：ID、版本、标题/正文或模板、范围、发布时间、开始/结束时间、重要度、发布者、修改者及审计关联。

生命周期由持久字段和当前服务器时间推导，进程停机后重启仍能求出当前有效公告。登录、换区服、重连时发送**当前有效快照**，不依赖玩家恰好在线收过某次广播。

修改/撤回必须带版本；客户端收到旧版本不能覆盖新版本。排期采用 UTC 存储，并在运营界面明确业务时区；不继承开发电脑时区。重复公告的唯一键包括 `(announcement_id, version, scheduled_occurrence)`，停机跨过多次排期时默认跳过过期轮次，而不是一次补滚十次。

### 11.3 跑马灯是展示方式

同一条 `Notification` 可投影为 ChatPanel + Marquee + NotificationCenter。展示去重键：`(notification_id, version, presentation, occurrence)`；`occurrence` 只对明确的重复排期使用。

跑马灯队列必须有容量、优先级、过期与撤回逻辑。停留时长由受控 UI 策略决定，不能由玩家文本无限拉长。

| 类型 | 默认表现策略 |
|---|---|
| 紧急维护/关键状态 | 可抢占；聊天栏和可恢复通知中心保留；不依赖跑马灯唯一传达 |
| 普通运营公告 | 排队、去重；超时跳过过时轮次 |
| 玩家喇叭 | 独立配额，不抢占紧急公告；文本仍受禁言与内容规则限制 |
| 掉落/成就播报 | 按稀有度与范围筛选，可聚合或低优先级丢弃 |

用户过滤普通聊天不能意外关闭必须获知的维护状态；但重要标记只能由受信运营策略决定，不能让商业/玩家消息随便挂“紧急”。

### 11.4 玩家喇叭涉及消费，必须走经济事务

```text
UseMegaphone(request_id, item_instance_id, text, intent)
 → 校验文本/禁言/范围/冷却/道具数量
 → 同一持久事务：扣道具 + 消耗账本 + 固定消息事实 + 审计 + outbox
 → 返回 persisted
 → outbox 按同一 message_id 发布
 → 授权接收节点按 ID 去重并投影
```

玩家购买的是按规则完成的发布服务，不是“保证每个人读过”。总线超时时可能已发布，不得立刻重扣、改 ID 重发或自动退款。明确过期前从未尝试发布的任务可按唯一补偿键处理；已经尝试但结果不确定的任务，应查状态/幂等重试或人工核对，不能声称无人看到。

在 P0 没有证明持久事务边界前，付费喇叭及有经济价值的 GM 命令默认关闭。

---

## 12. 操作日志：四类分开，查询权限也分开

| 类别 | 记录内容 | 持久化与故障策略 |
|---|---|---|
| 玩家可见操作记录 | 获得/失去物品、任务结果、强化结果等摘要 | UI 投影，可分页；不泄露后台细节 |
| 经济/关键业务账本 | 物品与货币增减、交易、奖励领取、强化消耗、来源及版本 | 与业务事实原子提交；不能通过关闭日志等级停用 |
| 安全与 GM 审计 | 操作者、动作、目标、原因、权限、前后差异、执行结果 | 追加记录、受限读取；高风险操作无法持久审计时拒绝 |
| 技术诊断日志 | 超时、队列深度、路由错误、运行时异常、trace | `tracing` 等结构化日志，可采样/丢弃并告警 |

不记录所有移动帧作为持久业务审计。需要排查移动异常时，采用受控采样/短窗口追踪；攻击、技能等高频行为记录聚合或选择性证据，避免日志成为主负载。

### 12.1 关键审计字段

```text
audit_event_id
operation_id / request_id / causation_id / trace_id
operator_principal_id（GM 或可信系统身份）
actor_character_id / target_character_id / target_realm
command_name / command_version
validated_arguments（只保存必要、脱敏参数）
reason / ticket_reference
permission_snapshot_version / execution_environment
before_version / after_version
business_diff（物品、货币、属性等最小必要差异）
status / failure_code
accepted_at / committed_at
owner_node / session_epoch / route_epoch（按需要）
```

审计状态变化使用追加事件，或维护一张可变 `operation_receipt` 读模型加一张不可由普通业务更新的审计事件表。不要为了展示最新状态覆盖唯一的历史证据。

### 12.2 隐私与可检索性

普通日志默认不存私聊全文、凭证、Cookie、访问 token 或数据库连接串；不要对带正文/凭证的 request 直接 `Debug` 输出。私聊内容、举报证据与审计元信息分仓或至少分表、分权限。[S15]

举报按 message_id 指向服务端已接受的消息事实。首版只有短期内存证据时，必须明确跨重启/过期后不可核验；需要稳定处理举报再启用受限证据存储，不能假称已有完整历史。所有查看私聊证据的操作自身也要审计。

建议保留策略为配置，而不是硬编码：技术日志 7–14 天、聊天历史默认关闭、举报证据与关键审计按产品及部署要求确定。这里不是法律保留期限建议。删除计划需覆盖副本、导出及备份策略。

### 12.3 “追加写”不等于不可篡改

普通服务账号仅授予必要的追加与查询权限；禁止其更新/删除关键审计。后续可增加归档、受控不可变存储、审计哈希链和外部校验点，但哈希链本身不能阻止具有完整重写权限的人重算整条链。

tracing-appender 的非阻塞队列可能配置为丢日志或让调用者等待；它既不等于数据库事务，也不自动保证进程崩溃后关键业务证据完整。[S16] 因此诊断日志失败只影响可观测性并报警；关键审计失败阻止相应高风险修改，但不应一并关停正常战斗与无关地图聊天。

---

## 13. GM 命令：聊天框可以是入口，不能是执行器

### 13.1 将普通玩家命令与管理命令分离

```text
/w、/r、/p、/g、/help
 → 玩家命令解析
 → 普通聊天或已有社交业务授权

/gm ...（仅作为可选管理 UI 快捷入口）
 → 显式 AdminCommandRequest
 → AdminSession / capability 校验
 → 类型化管理命令
 → 状态所属权威执行者
```

普通发言中包含 `/gm` 字样、GM 名称或特殊颜色，不获得任何权限。非法/未知命令给调用者私有错误，不把输入广播到公共聊天。

开发控制台、管理面板和可选游戏内快捷入口都调用**同一个命令注册表与授权服务**。游戏登录 token 不自动成为管理凭证；角色等级、角色名、客户端 `is_gm`、前端隐藏按钮都不是权限源。

### 13.2 命令注册表

每条命令描述：

```text
name / aliases / version
argument_schema
required_capabilities
allowed_environments
scope_constraints
risk_level
supports_dry_run
requires_reason
approval_policy
idempotency_policy
execution_timeout / expiry
handler → TypedWorldCommand 或受控只读查询
```

使用受限参数解析器，校验参数个数、类型、上限与合法目标。禁止“任意 shell、任意 SQL、任意 Rust/Lua eval、任意反射调用”成为常规 GM 功能。命令列举和自动补全只返回调用者有权使用的命令；服务端执行时仍重新校验。[S14]

### 13.3 初始权限表

| 命令示意 | 能力 | 执行边界 | 默认限制 |
|---|---|---|---|
| `/gm who`、`inspect` | `player.read` | 只读投影/拥有者查询 | 输出字段脱敏，按区服限制 |
| `/gm mute`、`unmute` | `moderation.mute` | 处罚权威模块 | 必填原因、最长时长、持久审计 |
| `/gm notice preview/publish/cancel` | `notice.publish` | 公告服务 | 范围受限，广域发布需确认 |
| `/gm warp` | `world.teleport` | 当前角色/地图拥有者 | 使用正常迁移协议，禁止裸改坐标 |
| `/gm spawn`、`despawn` | `world.spawn` | 目标地图拥有者 | 首版仅测试实例；实体数量上限与清理标签 |
| `/gm item grant` | `economy.grant` | 角色经济事务 | 必填原因、金额/数量上限、预检和确认 |
| `/gm currency grant` | `economy.grant` | 角色经济事务 | 默认仅测试环境，生产显式开放 |
| `/gm quest set`、`level set` | `progression.override` | 正常成长/任务领域服务 | 默认仅测试世界，验证不变量与联动状态 |
| `/gm config reload` | `config.reload` | 配置服务 | 仅白名单配置、版本化、保留回滚版本 |

权限模型不是 `gm_level >= 3` 一条判断，而是 `能力 × 环境 × 区服/对象范围 × 风险约束`。初版可以用静态能力集合，不必引入完整策略引擎；但必须默认拒绝未授予动作，并在每次执行时验证。[S14]

生产高风险管理入口建议独立管理认证与加强验证，不对公网匿名开放。开发模式同时受编译特性/运行环境、绑定地址及明确授权身份约束；仅“localhost”不能替代全部授权检查。

### 13.4 执行状态机

```text
Received
 → Authorized
 → Validated / Previewed
 → Queued（持久任务记录；不是业务完成）
 → Executing（拥有者接收、重新校验权限与版本）
 → Committed / Rejected / Expired
```

超时是调用方观察状态，不是世界自动回滚指令。对不确定结果用原 operation_id 查询；同一个 request_id 必须得到同一已提交结果。

预检返回的确认凭证由服务器保存或认证，绑定：操作者、规范化命令、目标 ID、参数哈希、环境、权限版本、目标状态版本和过期时间。确认时重新核对；前端弹一个“确定吗”按钮不能充当服务端确认机制。

多人运营再启用独立审批者/双人批准；单人开发不伪造“双人审批”，而是限制在测试环境、保留预检和低额度约束。撤销通过新的补偿命令完成，保留原记录；物品可能已交易或消耗时不能盲目回滚旧快照。

### 13.5 权限撤销和跨服命令

管理会话有权限版本与有效期。撤销后让旧管理连接失效，排队中的命令在真正执行时重新授权；不得因为入队时有权限就永久获准执行。

跨服命令需要两道校验：管理入口验证目标范围，目标区服验证受信服务身份、命令版本及范围。任务按目标角色/地图拥有者路由，不能让所有节点收到广播后各执行一次。

批量操作生成父任务及每目标独立的子 operation_id，记录逐个成功/失败，不承诺跨区服全有或全无。重试只重试没有确定完成的目标，使用原子操作键。

---

## 14. 持久化与原子提交：先核对现有存档，再接入高风险能力

### 14.1 数据库选择

**优先复用项目现有事务数据库和存档层。** 不因为做聊天强制把整个项目切换到 PostgreSQL、MySQL 或新框架。

P0 必须确认：角色状态如何提交、能否做版本检查、背包/货币/奖励事实是否在同一事务边界、崩溃恢复从哪里读取。

若项目目前只定时保存内存快照或 JSON 文件，则“另建一个聊天 SQLite 库”并不能让背包与 GM 审计原子一致。此时先实现统一的持久化 Unit of Work；若确需 SQLite 作为本地过渡，相关角色事实、账本与 outbox 必须进入同一个提交机制，且检查单写竞争和迁移方案。完成前保留只读/纯测试命令，不承诺经济命令可恢复幂等。

### 14.2 最小逻辑表

下表是逻辑结构，具体 DDL 按 P0 确认的数据库生成。

| 表/集合 | 关键字段与索引 | 启用阶段 |
|---|---|---|
| `operation_receipt` | principal、operation_kind、request_id 唯一；payload_hash、status、result、期限 | P1 GM 查询/状态；P2 持久修改 |
| `audit_event` | event_id 主键；operation_id、actor、target、time、diff；按目标/操作/时间索引 | P1–P2 |
| 现有 `inventory_ledger` / `economy_ledger` | operation_id 与业务子项唯一；物品/货币变化及来源 | P2 复用或补齐 |
| `announcement` | id、version、scope、starts_at、ends_at、cancelled、payload；有效范围索引 | P2 |
| `outbox_event` | event_id 唯一；aggregate_id/version、payload、topic、status、attempts、next_attempt_at | P2 |
| `inbox_dedup` | consumer_name + event_id 唯一；处理结果/时间 | P3 可靠消费 |
| `moderation_state` | 账号/角色、范围、mute_until、policy_version、原因引用 | P1 |
| `block_relation` / `chat_preferences` | owner、blocked、隐私选项与版本 | P1，优先复用社交数据 |
| `presence_route` | character_id、session_epoch、route_epoch、owner、迁移状态、版本 | P3；本地版本可内存持有 |
| `chat_message` + `conversation` | conversation_id + seq 唯一；message_id、参与者、正文、TTL、权限信息 | P4 可选 |
| `notification_inbox` | recipient_id + notification_id 唯一；游标、过期、读状态 | P2 按需求/P4 完整化 |

不必给所有临时地图聊天落数据库。聊天历史、诊断日志与经济账本分开生命周期，避免一项保留策略误删另一项关键事实。

### 14.3 GM 发物品的正确事务边界

```text
网关收到请求
 → 管理认证 / 预检 / 持久任务受理
 → 找到角色权威拥有者
 → 拥有者验证角色 revision=v，构造合法变更计划
 → 标记该角色相关写入 PendingCommit，不开放第二个旁路 writer
 → 持久层同一事务：
     1. 校验/占有 operation_id，重复则读取原结果
     2. 校验角色 revision=v 与当前所有权 fencing token
     3. 写角色/背包/货币的合法变化，revision=v+1
     4. 写唯一经济账本及关键审计事件
     5. 更新操作结果为 committed
     6. 写通知/后续动作 outbox
 → 提交成功回到世界邮箱
 → 拥有者应用已提交 revision=v+1，释放该聚合写入屏障
 → 向 GM 返回 committed，向玩家发送状态/通知
```

所有可能修改相同背包/货币的正常玩法也要服从这个版本与提交机制；不能只有 GM 走事务、普通掉落继续直接改内存覆盖存档。

崩溃窗口处理：

| 崩溃点 | 处理 |
|---|---|
| 请求受理前 | 无记录，客户端可用原 ID 重试 |
| 已入队但未修改业务 | 恢复任务，重新校验权限、期限和状态 |
| 数据库提交前 | 事务未完成不视为成功，恢复后查 operation_id |
| 数据库已提交、内存未应用 | 从持久事实/已提交版本恢复；绝不再次发物品 |
| 内存已应用、回复丢失 | 查询 operation_id 返回原结果 |
| outbox 发布成功、标记前崩溃 | 同 event_id 重发；消费端幂等 |

这不是要求把整个游戏改成事件溯源。重点是关键提交的唯一事实源、原子边界和恢复路径。

### 14.4 outbox 与跨数据库边界

本地业务事实与其 outbox 在同一事务中写入；独立 relay 读取待发送记录，成功后标记，失败带退避重试。事件顺序按 aggregate/room 的版本或序号保证；多个 relay 不能随意颠倒同一聚合事件。[S12]

中央 GM 任务库与角色区服库若分属不同数据库，**不声称它们能自动同事务**。原子性放在目标区服的“业务效果 + 当地结果记录 + 当地审计 + outbox”中；中央控制台接收最终结果投影并允许暂时显示 pending。目标端的原始结果是判断是否执行过的依据。

重试、死信与容量也要治理：outbox 有失败次数、首次/最近失败时间、下一次重试、事件过期与人工处置状态；持久库接近容量预算时拒绝新的高风险任务，而不是无限堆积。

---

## 15. 跨进程传输：推荐 NATS 路线，但不让消息中间件成为首版前提

### 15.1 选型决策

| 方案 | 优势/边界 | 本项目结论 |
|---|---|---|
| 进程内直接调用 + 有界队列 | 无外部部署依赖，所有权容易验证；不跨进程 | P0–P2 默认 |
| Redis Pub/Sub | 已有 Redis 时接入成本较低；at-most-once，无离线重放 [S07] | 已有设施时用于临时聊天；不承载唯一关键事实 |
| Redis Streams | 有日志与消费组，可管理重投和独立组 [S08] | 项目已经稳定使用 Redis 时可选；仍需 inbox/outbox |
| NATS Core + JetStream | 实时 pub/sub 与持久化流分层 [S09–S11] | 无既有跨节点总线时，P3 首选调研/验证路线 |
| 专门引入 Kafka 或完整聊天平台 | 会增加独立系统/运维及集成边界 | 不是当前首版前提；只有已有设施或规模证据再立项 |

本轮没有跑基准测试，不宣称 NATS 在本项目一定比 Redis 更快。推荐依据是功能边界匹配，而不是未经测量的性能排名。

### 15.2 传输接口不要伪造统一可靠性

```text
send_ephemeral(event) → accepted / overload / unavailable
publish_recoverable(outbox_event) → broker_persisted / unknown / failed
submit_admin_task(command) → durable_job_id
```

三个接口可以共用连接池，但返回语义不同。一个 `send()` 返回 `Ok` 不能同时代表进入本地队列、总线持久化和 GM 已执行。

### 15.3 subject 设计示意

```text
ms.<env>.chat.realm.<realm>.channel.<channel>
ms.<env>.chat.realm.<realm>.world
ms.<env>.chat.cross.<cross_group>
ms.<env>.deliver.node.<node>
ms.<env>.notice.realm.<realm>
ms.<env>.admin.realm.<realm>.command
ms.<env>.audit.realm.<realm>.event
```

仅使用服务端构造并验证的 ID token；玩家文本和显示名不得拼接成 subject。私聊按目标节点/受限投递域路由，不将全文广播到所有区服再过滤。

生产、测试环境至少在认证/权限和 subject 上隔离；关键管理流使用更严格的连接凭证与 publish/subscribe 白名单。NATS 的授权以 subject 权限为基础，但**总线 ACL 不能替代业务层角色权限**。[S20]

### 15.4 广播与工作队列是不同拓扑

NATS 同 queue group 内一条消息只会交给一个成员，而不是所有成员各收到一份。[S10]

因此：

- 所有网关要展示的公告，不能让所有网关加入同一个竞争消费组后就宣称“全服广播”。
- NATS Core 实时广播使用普通独立订阅；每节点先收一份，再向本地授权成员分发。
- JetStream 可靠通知需要每个目标投递节点独立的逻辑 consumer/游标，或明确的区域扇出服务。采用适合多消费者的保留配置，不把工作队列保留策略误用于广播。
- GM 任务可以竞争消费，但接收 worker 必须将任务交给当前权威拥有者；一条任务不能在所有区服各执行一遍。
- 节点重建后，短期聊天不追赶过期历史；公告用当前有效快照恢复。持久消费者的身份、清理与保留上限必须有生命周期策略。

### 15.5 JetStream 消费规则

确认模式、确认等待、最大重投、pending 上限、流容量、事件 TTL、副本及磁盘策略都显式配置并做故障测试。需要持续可靠处理的消费者在业务结果/去重记录已提交后再 ack；慢 socket 不作为 ack 的无限等待条件，重要玩家通知先写可恢复收件箱。

`Nats-Msg-Id` 的去重受配置的窗口约束，不是永久业务幂等存储。[S11] 超过窗口的 GM 重试依然由 operation_id 和账本唯一键防止重复效果。

### 15.6 故障降级

| 故障 | 允许继续 | 必须降级/拒绝 |
|---|---|---|
| 跨节点总线断开 | 同节点地图聊天、正常战斗 | 跨服/远端私聊显示不可用，不回“送达” |
| 路由目录不可确定 | 已确认本地会话的受限功能 | 新的跨节点迁移和不可核验远端命令 |
| 聊天历史库不可用 | 临时地图聊天 | 新的持久私聊不得回 persisted |
| 关键事务/审计库不可用 | 不依赖它的只读与临时聊天 | 付费喇叭、经济 GM、不可审计高风险修改 |
| 目标节点死亡 | 其他区服运行 | 对该节点的请求进入明确 pending/失败；不盲选第二权威 |
| 文本审核服务不可用 | 按预先配置的范围策略 | 广域发言可 fail-closed；本地策略必须预先明确 |

处罚更新以各发言入口执行时核对的权威版本为准。若分布式实现只依赖短期缓存，必须公开其最大撤销延迟；需要立即全局禁言时，同服发言统一经过处罚/聊天拥有者或同步授权屏障。不能把“发出一条失效通知”冒充全局已经生效。

---

## 16. 安全、禁言、屏蔽与反滥用

### 16.1 WebSocket 与协议入口

采用现有已验证的认证机制，生产连接使用加密传输。浏览器 cookie 认证的 WebSocket 必须验证精确 Origin 白名单并处理跨站连接风险；Origin 不是独立身份凭证。连接建立后也要验证会话失效和逐消息授权。[S13]

限制握手、未认证连接生存时间、每账号连接数、帧/完整消息的字节数、解压后大小、JSON 深度及数组长度。这里的聊天包上限不能误伤现有合法游戏快照。关闭非必要压缩或先证明解压预算可控。

拒绝客户端伪造 system/GM 作者、任意收件范围、目标节点、频道成员、角色身份、权限和时间。服务间传输也要验证认证主体、来源区服与允许动作，不因来自内网就信任所有字段。

### 16.2 文本与物品链接

玩家文本以纯文本或明确的安全分段结构渲染，不进入 HTML/脚本执行路径。系统颜色、字体、徽章、跑马灯优先级只接受白名单枚举。

对显示文本采用明确且一致的 Unicode 策略；限长同时看字节与扩展字素簇，避免破坏中文、组合字符与 emoji。控制字符、双向显示控制、换行和零宽字符要分类处理，不能为过滤刷屏而一律删除合法 ZWJ/组合序列。用于反垃圾的规范化匹配结果与最终展示正文可分开，避免把显示名规范化成另一个角色身份。

首版不支持任意超链接预览或远程内容抓取。装备链接只允许服务端验证的物品实例/快照引用；点击后显示官方生成的属性，不能从客户端 JSON 读取任意“神装属性”。

### 16.3 禁言与屏蔽

禁言至少有 subject、scope、starts_at、expires_at、policy_version、reason、operator。自然到期由时间条件求值，不依赖某一个定时器必然触发。持久处罚重启不消失。

所有玩家可触达的文字入口复用处罚策略，包括公共/私聊/喇叭，未来还有队伍招募描述、公会公告和房间名。哪些入口被哪种禁言覆盖由 policy 定义，不能只封聊天按钮却允许从另一字段发广告。

屏蔽关系由接收者控制。UI 本地隐藏不是服务端屏蔽；服务端在发出或补查敏感消息前核对。玩家无法屏蔽必要系统维护状态，但系统身份不能用来绕过普通玩家私聊的屏蔽关系。

### 16.4 限流维度

连接用于最前面的廉价保护，账号/角色用于业务额度，目标用于私聊骚扰控制，房间用于限制放大广播。IP 只作辅助信号，不应让同一家庭/网吧被一个人简单连带封禁。

换线、重登不能重置账号发言额度。P3 分布式额度需要统一拥有者或原子共享计数，不能每节点各发一份完整额度。文本重复检测、举报和内容审核是补充手段，不取代硬上限与权限验证。

---

## 17. Web / TypeScript 客户端接入计划

### 17.1 状态与展示

维护独立 ChatStore、NotificationStore、AdminConsoleStore，复用现有连接事件。聊天列表变化不触发整个游戏世界重新构建，不另开一套渲染主循环。

```text
ChatStore
  messagesById
  roomMessageIds / activeTab
  pendingByRequestId
  lastWhisperTarget
  roomCursor / streamEpoch
  unreadCount / settings

NotificationStore
  activeAnnouncementsByIdAndVersion
  marqueeQueue
  inboxCursor
  seenProjectionKeys
```

所有历史、pending、去重集合、通知队列与 DOM 都有上限。聊天列表过长时分页/虚拟化，滚动查看历史时不强制跳到底，显示“新消息”按钮。

### 17.2 冒险岛体验保留项

- ChatPanel 按一般、私聊、组队、公会/联盟、系统等过滤；“全部”聚合不越权。
- 私聊支持角色右键入口、名称消歧、最近联系人回复；标明区服/频道信息时服从隐私设置。
- 地图聊天同时生成聊天栏记录与头顶气泡；气泡限长、限时、跟随当前实例角色，不从历史重放生成。
- 输入框清晰显示当前发送范围；跨服/世界喊话或消耗道具的发送模式有明显提示，不容易误发。
- 点击道具链接可查看服务端认可的装备快照；GM 私有执行结果不混到公共聊天。

原作 UI 分类有官方依据 [S01–S02]，但具体色值、尺寸、快捷键和 TMS273 外观应在项目素材/实测中确认。

### 17.3 输入与焦点

按 Enter 进入输入，Esc 退出/关闭补全面板，普通命令解析与 GM 入口分开。输入聚焦时屏蔽移动、攻击、技能热键，并正确清理已按住的游戏输入，避免角色持续跑动。

处理中文/日文 IME 的 `compositionstart`、`compositionend` 与 `isComposing`，候选词确认不能发送聊天；还要在实际 Safari/Chromium 目标版本上验证事件顺序，不能只依赖一个布尔字段。MDN 将 `isComposing` 定义为组合输入过程标志，并给出兼容性信息。[S19]

测试长按 Enter、粘贴、撤销、Cmd/Ctrl+C/V/A、失焦、窗口切换和重连。快捷键不能偷走正常文本编辑操作。

### 17.4 pending 合并与断线

发送后可显示灰色 pending 行，但只能标记本地待确认，不能伪造服务端成功。收到回执/正式回显按 request_id 合并，防止一条话显示两遍。已知拒绝允许编辑后重新发送；结果不确定先查询或按原 ID 重试。

断线保留草稿，显示不可用状态；不自动重发全部历史输入。重连先同步身份/权限与公告快照，再恢复合法房间；未获授权的旧房间不继续接收。

---

## 18. 观测、容量与性能验收

### 18.1 必须具备的指标

```text
chat_requests_total{kind,result}
chat_validation_latency_ms{kind}
chat_delivery_latency_ms{kind}
chat_fanout_recipients{kind}
chat_queue_depth / chat_queue_bytes
chat_dropped_total{reason}
chat_rate_limited_total{scope}
chat_stale_route_total / chat_route_retry_total
active_sessions / active_chat_rooms
notification_backlog / announcement_snapshot_version
outbox_pending / outbox_oldest_age_seconds
consumer_redelivery_total / consumer_dedup_total
admin_commands_total{command,result}
admin_pending_age_seconds / audit_write_failures_total
world_tick_duration_ms / world_command_queue_depth
```

指标标签使用有限枚举/低基数范围，不把 player_id、message_id 或正文当指标 label。定位单个操作使用 trace/request/operation ID 的日志与查询接口。

### 18.2 压测分层

| 层级 | 场景 | 验收目的 |
|---|---|---|
| 正确性基线 | 5 个客户端、2 逻辑区服、不同频道/地图实例 | 范围和权限正确 |
| 首版负载 | 100 会话、10 地图、总计 20 条普通发言/秒，混合移动/技能 | 新功能不拖慢基础玩法 |
| 热点与慢连接 | 大房间广播、10% 连接停读、少数账号持续超限请求 | 队列有界、正常玩家不被拖垮 |
| P3 容量探测 | 2 节点、1000 会话、多地图，总计 100 条地图消息/秒，加 5 条广域消息/秒 | 测量扩展瓶颈，不把此规模当已达到承诺 |
| 故障恢复 | 总线断线、节点强杀、事务延迟、时钟跳变、重复投递 | 恢复语义和幂等成立 |

所有机器规格、构建模式、消息大小、fan-out、持续时长与原有 tick 基线写入报告。不用“每秒输入 100 条”掩盖“每条发给 1000 人”的输出放大。

建议门槛（非已测数据）：受控同机测试普通聊天端到端 P95 不高于 100 ms；P3 同区域测试不高于 250 ms。聊天对 world tick 的额外 P99 开销不超过 P0 测得 tick 预算的 5%；若平台基线不适配，先修订并记录目标，再验收，不伪造达标。

内存应在持续压力和连接退出后趋于有界稳定；任务、房间、队列、去重表均可回收。付费/GM 业务不得出现重复资产效果；敏感范围越权投递数量必须为零。

---

## 19. 建议文件布局与依赖策略

下面是**待 P0 与仓库对齐的建议布局**。已有对应模块时扩展，不平行复制。小文件可以先合并，职责稳定后再拆，不为目录整齐创建空框架。

```text
server/src/
  chat/
    mod.rs             # 服务入口与公开领域类型
    policy.rs          # 文本、禁言、限流、发送资格
    router.rs          # 房间与接收目标计算
    delivery.rs        # 有界投递、回执、去重
  notification/
    mod.rs             # 业务事件 → 系统消息
    announcement.rs    # 生命周期、排期、快照、撤回
  admin/
    mod.rs             # 命令注册与调度
    permission.rs      # 能力、范围、环境、风险
    commands.rs        # 小规模初始命令集
  audit/
    mod.rs             # 关键审计端口与查询模型
  transport/
    local.rs           # 复用现有本地投递
    cluster.rs         # P3 才落地
  persistence/
    ...                # 优先复用现有事务与存档层
  world.rs / protocol* # 若现有项目确为此布局，只改必要接入点

client/<现有源码根>/
  chat/                # store、输入、过滤、私聊、气泡
  notification/        # 公告、系统提示、跑马灯队列
  admin/               # 受控 GM 调试界面

docs/
  chat_ops_protocol.md
  chat_ops_acceptance.md
  chat_ops_failure_semantics.md
  chat_ops_current_state.md
```

依赖原则：沿用现有 async runtime、网络库、serde/协议生成、数据库库与配置系统。Tokio、UUID、结构化日志等按缺口引入；跨进程 NATS 依赖只在 P3 启用。Cargo 版本在 P0 核对工具链/MSRV 和 `Cargo.lock` 后锁定，不在计划里拍定未经项目验证的“最新版本”。

统一协议由一个负责人维护，Rust 与 TS 使用现有类型生成方案或固定 golden fixtures 验证，避免两个分支各自修改消息字段后靠手工猜对齐。

---

## 20. 开发里程碑与可直接分配的工单

不提供未经代码盘点的人日承诺。按依赖和可验收结果推进；每张工单必须包含测试和失败处理，不能只提交空 trait 或 UI 截图。

### P0：代码盘点与契约冻结

| 工单 | 工作与交付物 | 完成标准 |
|---|---|---|
| C00 现状盘点 | 读取 `启动3010.command`、Cargo/客户端清单、协议、身份绑定、World 主循环、socket writer、存档层；记录真实路径和现有能力 | `chat_ops_current_state.md` 中每个结论可定位代码；无凭空假设 |
| C01 语义与协议 | 冻结 Realm/Channel/Instance、ChatIntent、错误码、回执、ID 编码和版本兼容 | Rust/TS fixtures 一致；不允许客户端构造系统或 GM 身份 |
| C02 提交边界检查 | 找出背包/货币/处罚所有 writer，确认事务与崩溃恢复 | 明确哪些命令可开放；没有经济原子边界就保持高风险开关关闭 |

**P0 出口：能说清“一条消息谁接受、一笔资产谁提交、一次重试如何识别”。**

### P1：单进程社交与安全闭环

| 工单 | 依赖 | 工作 | 验收 |
|---|---|---|---|
| C03 有界投递基础 | C00–C01 | 复用连接 writer，新增队列预算、会话代次、限流、回执与指标 | 停读一个客户端不拖慢另一个；退出后资源回收 |
| C04 地图公共聊天 | C03 | 实例成员校验、正式回显、聊天栏/气泡 | 同模板不同实例不串话；客户端伪造地图字段无效 |
| C05 私聊与逻辑跨频道 | C03 | 名称解析、隐私/屏蔽、同服跨线私聊、区服/频道房间策略 | 跨线可私聊；跨服默认拒绝；旧会话不能继续发送 |
| C06 系统消息投影 | C01、C02 | 接现有奖励/任务/失败事件，模板与单人提示 | 重连/重复展示不重复发奖；物品提示与真实状态一致 |
| C07 管理入口与最低审计 | C02–C03 | 独立授权、`who/inspect`、持久禁言/解除及原因记录 | 普通用户构造 GM 请求被拒；禁言重启不丢、各文字入口一致 |
| C08 聊天交互与 IME | C04–C06 | 标签、输入焦点、/w /r、pending 合并、有限历史 | 中文候选确认不发送；打字不触发技能；一条回显不变两条 |

**P1 演示：两个玩家不同频道私聊；同图聊天出气泡；GM 禁言后所有受限发言被拒；解除后恢复；打怪与移动不受聊天慢连接拖累。**

P1 的逻辑跨服测试只证明权限和索引隔离，不能标记“已完成物理跨服高可用”。

### P2：公告、经济一致性与受控管理

| 工单 | 依赖 | 工作 | 验收 |
|---|---|---|---|
| C09 公告与跑马灯 | C06–C07 | 持久公告、排期、登录快照、版本、撤回、展示队列 | 离线后登录能看有效公告；旧版本不复活；重复事件不反复滚动 |
| C10 统一经济提交与 outbox | C02 | 接好业务事实、操作结果、账本、审计、outbox 的原子边界 | 每个崩溃窗口强杀测试通过；无孤立“成功日志”或重复资产 |
| C11 付费喇叭与高风险 GM | C07、C09–C10 | 扣道具喇叭、受限 grant/warp/spawn、预检、确认、状态查询 | 重复请求只扣一次/发一次；执行超时能查询原结果 |
| C12 审计查询与保留 | C07、C10 | 按目标/操作者/操作 ID 查询，脱敏、访问审计与清理策略 | 能还原一次命令影响；无权限不能查私聊/敏感审计 |

**P2 出口：所有九项需求都具备清晰领域边界；单进程功能闭环完成，高风险修改能经受崩溃重试。**

### P3：真实跨进程与跨服

| 工单 | 依赖 | 工作 | 验收 |
|---|---|---|---|
| C13 多节点投递 | C03、C09–C10 | 确定总线；接 Local/Cluster 路径；subject ACL、广播 consumer 拓扑 | 两节点同服跨线与跨服组广播正确；第三个未授权区服收不到 |
| C14 权威路由与迁移 | C05、C13 | presence/route epoch、迁移状态、fencing、迟到清理保护 | 换线并发私聊不误投；旧断线不清掉新会话；不产生双权威 |
| C15 可靠消费与远程 GM | C10–C14 | inbox 幂等、目标区服结果、outbox 重试/死信、命令授权 | 重复总线投递不重复发物品；可靠公告各目标节点均收到；GM 只由目标权威拥有者执行 |
| C16 压测与演练 | C13–C15 | 热点、慢连接、断网、节点强杀、权限撤销、积压恢复 | 符合第 18、21 节；给出数据和剩余限制 |

**P3 的服务启动仍经 `启动3010.command`。需要多节点参数/测试模式时，先在该脚本增加明确配置；本文不假称现有脚本已经支持某个新参数。**

### P4：有明确产品需求再扩展

C17：离线私聊、持久会话历史、通知收件箱；前提是隐私 ACL、保留策略、未读游标和防骚扰配额已定。

C18：完整组队/公会/联盟/好友聊天接入、装备链接、跨服活动成员房间、举报运营工具。依赖现有社交事实，不在聊天项目中重建公会系统。

C19：高风险批量操作、多审批人、归档与恢复演练。容量证据充分后再拆 ChatService 独立部署或做房间拥有者高可用。

### 建议的协作边界

网络/协议负责人维护公共契约和 session writer；世界/持久化负责人维护业务命令及原子提交；客户端负责人维护输入与展示；测试/安全负责人独立验证权限和故障。可以由同一个人或多个 AI 承担，但公共协议与持久化边界只能有一个合并负责人，避免并行代理各写一套身份和事件模型。

---

## 21. 验收测试矩阵

### 21.1 固定拓扑

```text
A：R1 / CH1 / MapDef=M / Instance=M1
B：R1 / CH2 / MapDef=M / Instance=M2
C：R2 / CH1 / MapDef=M / Instance=M3
D：R1 / CH1 / MapDef=M / Instance=M4（独立副本）
E：R1 / CH1 / MapDef=M / Instance=M1（与 A 同实例）
跨服组 X：R1、R2；另加入不属于 X 的 R3 作为负向测试。
```

### 21.2 必过测试

| ID | 场景 | 期望结果 |
|---|---|---|
| T01 | A 发地图公共消息 | A/E 可见；B/C/D 不可见 |
| T02 | A 发当前频道消息，功能已启用 | A/D/E 可见；B/C 不可见 |
| T03 | A 发 R1 跨频道消息，策略允许 | A/B/D/E 可见；C 不可见 |
| T04 | A 私聊 B | 仅 A/B 的合法会话可见 |
| T05 | A 私聊 C，跨服私聊关闭 | 拒绝，不泄露跨服隐私状态 |
| T06 | X 跨服广播 | R1/R2 合法成员可见；R3 不可见 |
| T07 | 客户端伪造 sender、realm、GM/system 标记 | 忽略不可信身份或拒绝报文，无越权消息 |
| T08 | 私聊目标重名/改名 | 必须消歧或按稳定 ID 正确路由，不猜目标 |
| T09 | 屏蔽、关闭陌生人私聊、禁言 | 按策略拒绝，UI 与服务端一致 |
| T10 | 重复 ChatSend、同 ID 不同正文 | 同请求不重复正式显示；冲突请求拒绝 |
| T11 | 换图时旧地图聊天正在排队 | 不把旧气泡送到新实例；已收到历史仍可查看 |
| T12 | B 换线期间 A 连续私聊 | 有限缓存/重投，无无限等待、串人或不受控重复 |
| T13 | 新会话上线后旧连接断开 | 旧清理不删除新 presence；旧连接发言被拒 |
| T14 | 两个同时登录/迁移试图夺权 | 只有一个有效 epoch/权威拥有者 |
| T15 | 慢客户端停读、突发广播 | 队列不超预算；普通玩家 tick/消息仍正常 |
| T16 | 长文本、非法控制字符、HTML/脚本、伪造物品链接 | 合法文本正常渲染，危险结构拒绝，无脚本执行 |
| T17 | 付费喇叭同 request_id 连发/重投 | 只扣一次道具；相同消息按 ID 去重 |
| T18 | 喇叭事务已提交但发布断网 | 原事件可恢复，不重扣；状态不谎报所有人已收到 |
| T19 | 新登录玩家错过公告首次发布 | 收到当前有效快照，不补滚过期轮次 |
| T20 | 公告取消后收到旧发布事件 | 不复活已取消版本；跑马灯停止/跳过 |
| T21 | 重放“获得物品”通知 | 只展示，不改变背包或触发第二次奖励 |
| T22 | 普通玩家构造 AdminCommandRequest | 拒绝并留下适当安全事件，不执行 |
| T23 | GM 权限撤销但连接未断/任务已排队 | 执行前校验失败，不能继续修改 |
| T24 | GM 预检后目标版本/参数变化 | 确认无效，要求重新预检 |
| T25 | 经济 GM 在各事务窗口强杀 | 恢复后只有零次或一次业务效果，结果可确定 |
| T26 | GM 执行成功但客户端超时重试 | 原 operation_id 返回原结果，无重复效果 |
| T27 | 总线重复消息/确认丢失/超过去重窗口 | 数据库唯一业务键仍防重，不能只靠 broker 窗口 |
| T28 | 公告发送给两个订阅节点 | 两节点各收到；测试能捕获误用共享 queue group |
| T29 | 审计库/磁盘写入失败 | 高风险修改拒绝；正常无关玩法不整体卡死 |
| T30 | 非参与者猜会话 ID/历史 cursor | 无法读取历史或私聊证据 |
| T31 | 中文/日文 IME、长按 Enter、焦点变化 | 不误发送、不误施放技能、不持续移动 |
| T32 | 时钟前跳/回退与服务停机 | 公告/处罚到期按定义处理，限流不异常放大 |
| T33 | 1000 次连接/房间创建退出 | 任务、订阅、房间、去重表可回收，内存不单调泄漏 |
| T34 | 滚动发布中新旧协议版本共存 | 未知非关键显示字段可兼容；未知命令类型拒绝 |
| T35 | 节点/环境冒充另一区服发管理事件 | subject ACL 与业务授权均拒绝 |

### 21.3 测试层次

单元测试覆盖范围判断、文本与参数验证、限流、公告状态、去重和权限矩阵；属性测试覆盖随机加入/退出/换线后“非成员永不收到”的不变量；协议 golden fixtures 覆盖 Rust/TS 编码。

集成测试使用可控时钟、假路由/传输及真实持久库事务；P3 再加入真实总线与进程强杀。Mock 可以验证接口，不足以证明数据库崩溃原子性或跨节点广播拓扑。

---

## 22. 发布、回滚与启动约束

### 22.1 配置开关

```text
chat.map_enabled
chat.whisper_enabled
chat.channel_enabled
chat.realm_enabled
chat.cross_realm_enabled
chat.offline_whisper_enabled
chat.history_enabled
notification.marquee_enabled
admin.readonly_enabled
admin.moderation_enabled
admin.economy_enabled
admin.production_writes_enabled
```

开关只能限制能力，不能关闭授权/审计保护。管理开关关闭后 `/gm` 输入仍是私有拒绝，不能退回公共发言广播。

### 22.2 发布顺序

先兼容协议和增加表/索引，再上线受限服务端能力，再开放客户端交互。灰度先测试账号/测试世界，验证审计与错误，再开放普通地图/私聊；经济和跨服分别放行。

数据库采用向前兼容的增量迁移。回滚先关发送/修改入口，再处理已受理任务；不删除仍有 pending 操作的结果表、outbox 或幂等记录。公告不能因旧客户端不理解而变成无限重复弹出。

### 22.3 优雅退出

```text
停止受理新的管理修改/付费操作
 → 标记节点 draining，停止新的迁入
 → 停止新的普通发言或返回明确 unavailable
 → 在有界退出预算内完成/记录现有关键提交
 → 保留未完成 outbox/任务以供恢复
 → 关闭连接并按 epoch 条件清理 presence
 → 等待 I/O/日志任务退出，最后结束运行时
```

任务取消必须区分“尚未提交”与“已经提交但回复未发”；不能因一个 HTTP/WebSocket 请求被取消就抹掉已提交事实。Tokio 官方的取消通知与等待任务退出模式可作为实现参考。[S21]

### 22.4 验证命令与唯一启动入口

P0 确认实际 workspace 后，使用对应的格式检查、测试、clippy 与前端类型检查/构建命令。若实际仓库采用 `server/Cargo.toml` 布局，可采用：

```bash
cargo fmt --manifest-path server/Cargo.toml --all -- --check
cargo test --manifest-path server/Cargo.toml --locked
cargo clippy --manifest-path server/Cargo.toml --all-targets --locked -- -D warnings

# 服务启动、重启及多节点集成环境，统一经项目原脚本。
./启动3010.command
```

这些是待仓库核对的执行建议，本次没有在真实项目执行。不得为了聊天改造绕过脚本另起服务，不用全局 `allow(warnings)` 掩盖问题。新增多节点测试启动能力也由原脚本编排，并确保原单节点 3010 启动路径不回归。

---

## 23. 可交给编码代理的第一张任务说明

```text
任务：为 MapleStory 复刻建立聊天/通知/GM 的最小正确接入，先做 P0 和 P1-C03/C04。

先读取真实项目代码：启动3010.command、服务端/客户端依赖清单、网络协议、
认证与角色绑定、World 主循环、地图成员索引、socket writer、存档层。
先输出真实路径和当前调用链，再修改；不要根据计划虚构已有函数。

硬约束：
- 所有启动统一走启动3010.command。
- 不重写现有 World，不引入新的全局可变世界或第二个角色 writer。
- 不先接 NATS/Redis，不先做微服务，不先开放经济 GM。
- 复用现有网络连接与编码；客户端只提交 ChatIntent 和正文。
- 当前角色、区服、频道、地图实例与权限必须来自服务端有效会话。
- 不在 world tick 等待 socket、数据库或远程审核。
- 出站队列必须有条数、字节上限与慢连接处置；不无限 spawn。

本次最小闭环：
A 与 E 同地图实例，B 同服不同频道，D 同模板不同实例。
A 发言后 A/E 看到正式回显和气泡，B/D 看不到。
伪造地图、身份、系统消息或 GM 字段不能扩大广播范围。
一个客户端停止读取不影响其他客户端移动/攻击与聊天。

交付：
真实架构盘点、最小代码变更、Rust/TS 协议样例、自动化测试、
启动脚本下的集成验证结果、队列指标及剩余风险。
未执行的测试要明确写未执行，不把计划或 Mock 通过当成真实多节点通过。
```

---

## 24. 暂缓项与会改变方案的关键变量

| 变量 | 当前默认 | 改变后的影响 |
|---|---|---|
| 是否必须离线私聊 | 否，首版在线私聊 | 需要持久会话、收件箱、历史授权、保留与防骚扰策略 |
| 现有权威状态是否有事务存档 | 未确认，P0 查证 | 决定经济 GM/喇叭何时能开放，是最高风险技术变量 |
| 游戏频道是否真的已分进程 | 未确认，首版按逻辑边界实现 | 已分进程则提前 C13/C14，但不能跳过身份与迁移测试 |
| 是否已有 Redis/NATS 稳定运维 | 未确认 | 优先复用成熟设施，避免为了聊天重复运维 |
| 是否开放无限免费世界聊天 | 否，按独立产品策略开关 | 改变社交体验、反垃圾强度、广播容量与喇叭价值 |
| GM 是否将用于生产玩家资产 | 默认关闭生产经济写入 | 必须完成事务、授权、预检/确认、审计与恢复验证 |
| 是否要求严格 TMS273 体验 | 外部指南仅供结构参照 | 补录原版本颜色、长度、命令、隐私、喇叭与频道规则 |
| 最大在线数与广域消息热度 | 先测量，不凭空承诺 | 决定是否拆聊天服务、房间分片、网关扇出与存储容量 |

首版明确不做：端到端加密私聊、语音聊天、任意脚本 GM、跨区服强一致全局消息顺序、跨服资产分布式事务、聊天驱动游戏状态重放、自动智能封号、为所有移动帧保存永久审计。

**最终验收标准不是“九种消息都能显示出来”，而是：九种能力有正确的权限与事实边界，失败时不撒谎，重复时不多执行，规模增加时不拖垮权威世界。**

---

## 25. 来源索引与证据用途

以下均为本轮查阅的官方产品/项目文档或维护者文档。链接按 2026-09-09 调研时可访问路径记录；依赖 API 与产品页面后续可能变化，实现时以项目锁定版本复核。技术方案、参数、工单和验收阈值为本项目设计，不是来源里的原厂实现披露。

**P01｜此前项目资料：`references/tms273_research_pack/00_RESEARCH_AND_REMAKE_PLAN.md`。** 通过文件库检索核对了 Commands → 权威模块 → Committed Events → Views/Replication 的建议链路。该资料本身是设计计划，不是运行代码。

**P02｜此前项目资料：相关研究包 `README.md`。** 核对了公共契约草案、单进程模块化、小规模地图实例优先及公共定义统一合并的约定。

**S01｜MapleSEA 官方 User Interface。** 支持聊天框聚合玩家沟通、喇叭、公告、提示与任务提醒；不是 TMS273 精确参数证据。  
`https://www.maplesea.com/guide/user_interface/`

**S02｜韩国冒险岛官方聊天指南。** 支持聊天过滤/标签与多种聊天命令；不把地区差异视作同版本事实。  
`https://maplestory.nexon.com/Guide/N23GameInformation/Articles/378`

**S03｜Tokio：Channels。** 消息传递、资源拥有者、有界排队、mpsc/oneshot/watch/broadcast 区别。  
`https://tokio.rs/tokio/tutorial/channels`

**S04｜Tokio mpsc API。** 有界/无界通道及背压语义。  
`https://docs.rs/tokio/latest/tokio/sync/mpsc/index.html`

**S05｜Tokio broadcast API。** 慢接收者、Lagged 和发送数量不等于实际消费。  
`https://docs.rs/tokio/latest/tokio/sync/broadcast/index.html`  
`https://docs.rs/tokio/latest/tokio/sync/broadcast/struct.Sender.html`

**S06｜Heroic Labs：Nakama Real-time Chat。** 房间、私聊、群组、成员/会话与持久化能力的产品建模参考；不直接采用其整个架构。  
`https://heroiclabs.com/docs/nakama/concepts/chat/`

**S07｜Redis Pub/Sub。** at-most-once、断连消息丢失与普通发布订阅边界。  
`https://redis.io/docs/latest/develop/pubsub/`

**S08｜Redis Streams / streaming。** 流、消费组、重放和不同消费组独立读取。  
`https://redis.io/docs/latest/develop/data-types/streams/`  
`https://redis.io/docs/latest/develop/use-cases/streaming/`

**S09｜NATS：JetStream。** Core NATS 与持久化层、至少一次投递及重放的边界。  
`https://docs.nats.io/concepts/jetstream`

**S10｜NATS：Queue Groups。** 同一 queue group 的消息由一个成员消费，而不是所有成员广播接收。  
`https://docs.nats.io/concepts/queue-groups`

**S11｜NATS：Your first stream / Pull consumers in depth。** 去重窗口、持久流及消费者配置/确认处理。  
`https://docs.nats.io/learn/jetstream/your-first-stream`  
`https://docs.nats.io/learn/jetstream/pull-consumers`

**S12｜AWS Prescriptive Guidance：Transactional outbox pattern。** 数据库与消息系统双写风险、outbox 及幂等消费者。  
`https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html`

**S13｜OWASP WebSocket Security Cheat Sheet。** Origin、认证、会话生命周期、逐消息授权、限长和安全观测。  
`https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html`

**S14｜OWASP Authorization Cheat Sheet。** 默认拒绝、最小权限、每次请求授权。  
`https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html`

**S15｜OWASP Logging Cheat Sheet。** 敏感字段排除、日志注入防护、存取保护及保留生命周期。  
`https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html`

**S16｜tracing-appender：non_blocking / ErrorCounter。** 非阻塞队列、丢弃/背压与日志丢失计数。  
`https://docs.rs/tracing-appender/latest/tracing_appender/non_blocking/index.html`  
`https://docs.rs/tracing-appender/latest/tracing_appender/non_blocking/struct.ErrorCounter.html`

**S17｜uuid crate 文档。** UUID 标识与序列化能力；全局消息顺序仍由业务设计保证。  
`https://docs.rs/uuid`  
`https://docs.rs/uuid/latest/uuid/struct.Uuid.html`

**S18｜MDN：Number.MAX_SAFE_INTEGER。** JavaScript 整数精度边界，支持线路上把长 ID/序列号编码为字符串的决策。  
`https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number/MAX_SAFE_INTEGER`

**S19｜MDN：KeyboardEvent.isComposing。** 组合输入标识及浏览器兼容性；本项目仍需实机测试事件顺序。  
`https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/isComposing`

**S20｜NATS：Authorization。** 服务连接的 publish/subscribe subject 授权，不替代游戏业务权限。  
`https://docs.nats.io/learn/security/authorization`

**S21｜Tokio：Graceful Shutdown。** 取消通知与等待任务退出的实现思路。  
`https://tokio.rs/tokio/topics/shutdown`

---

### 本次交付状态

- 已完成：公开资料核对、既有项目计划检索、业务边界、协议草案、路由/失败语义、事务与审计设计、开发工单、35 项验收场景、启动与发布约束。
- 未执行：真实仓库代码审查、代码修改、真实服务启动、数据库故障测试、多节点压测与 TMS273 原版逐项实测。
- 下一步入口：P0 的 C00–C02，不要从安装消息中间件或添加更多聊天按钮开始。
