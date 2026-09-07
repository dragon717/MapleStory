# 后端技术方案（审查草案）

更新：2026-09-05。**已确认 Rust 后端、一台主机服务、多台局域网设备不同账号联机，先运行后优化。** 首版已实施 axum、rusqlite/SQLite、Argon2id，实际模块见 server/src 与 server/README.md。下列技能/任务目录仍为后续边界。跨端协议与内容版本以《前后端通用技术方案》为准，本文件不另造一份消息规范。

## 1. 一个服务进程起步

建议使用一个 Rust 程序提供静态网页、资源、认证 API 和 WebSocket；主机显式监听局域网可访问地址，设备通过同一主机 URL 访问。开发环境可使用前端开发服务器代理 API / WS；正式使用时无需每台设备安装游戏服务端。

[axum WebSocket](https://docs.rs/axum/latest/axum/extract/ws/) 是网络候选。玩法逻辑用普通 Rust 模块及明确的数据结构起步；[bevy_ecs](https://docs.rs/bevy_ecs/latest/bevy_ecs/) 可以独立用于组件与系统，若选用 [Bevy App 插件注册](https://docs.rs/bevy_app/latest/bevy_app/struct.App.html) 才需要 bevy_app。不为“模块化”引入完整 Bevy 图形引擎、动态库加载或微服务。

## 2. 职责草案与实现导航

下列目录树保留早期职责划分，不是当前文件清单。已实现模块以 `server/src/` 和 `BUSINESS_DEVELOPMENT.md` 的状态拥有者表为准；不要仅为匹配草案创建空目录或重组现有模块。当前版本范围以 `PLAN.md` 为准。

```text
server/src/
  main.rs              读取配置、组装模块、启动服务
  auth/                账号、会话、角色归属
  network/             HTTP/WS入口、输入校验、消息队列
  world/               地图实例、实体状态、模拟时序、移动/碰撞
  combat/              动作阶段、目标判定、效果、冷却与死亡
  quests/              条件、目标进度、奖励、对话请求验证
  inventory/           物品归属、容量、拾取与消耗
  content/             载入并校验静态定义、版本和交叉引用
  persistence/         存档、事务、必要的迁移
```

先一个 crate，不因目录数量就拆多个 crate。业务状态由 world / 对应业务模块拥有；网络处理器只把经过验证的请求投递进模拟流程，不从多个连接任务直接并发修改同一角色、怪物或掉落。

## 3. 权威模拟与组件组合

用户已确认单一模拟循环拥有当前世界，可用有界通道接收连接输入；系统按明确顺序处理输入、移动、动作、效果、死亡 / 掉落、任务进度并发布结果。固定步长与网络发送频率以后实测再选，文档不设臆造指标。

实体是运行时 ID 加已有数据组件，例如位置 / 运动、生命、外观模板引用、当前动作、冷却、持续效果；角色、怪物、投射物组合所需字段，不铺设深层继承树。普通结构体和集合已足够时先用它们；查询和系统依赖真的复杂后再用 ECS。

临时效果作为有 owner、开始/结束时刻和取消原因的实例。到期、死亡、切图或断线如何处理要由效果规则明确；不能依赖浏览器动画回调告诉后端效果结束。地图更换只能通过服务端验证的 portal / 规则变更。

单循环只负责轻量模拟。数据库写入和文件加载不在每 tick 阻塞整个世界：内容启动时加载；持久化可以排队，但需要保证事务成功后再向客户端确认关键奖励与物品变更。MVP 队列须有界，失败显式返回，不默默丢存档。

## 4. 认证、网络与断线

| 边界 | 要做的最小处理 |
| --- | --- |
| 认证 | 使用经维护的密码哈希实现，不存明文；服务端签发并验证会话，失败有明确响应 |
| 角色归属 | 每次角色选择核验 accountId ↔ characterId；不能仅相信消息里的 ID |
| WebSocket | 限制包体、字段大小、允许消息类型、请求频率和队列容量，拒绝 NaN / 无效枚举 / 非法内容 ID |
| 会话隔离 | 玩家只能提交自己角色的意图；跨地图实体、过期 actionInstanceId、无权限对象不能操作 |
| 慢连接 | 积压超过界限时停止接受或断开并重连取快照；不能无界缓存每帧消息 |
| 重复请求 | 关键离散动作按 requestId 去重，结算也核验当前业务状态；输入序号与奖励去重不能混用 |
| 断线 | 清掉持续输入，释放连接拥有的资源；重连重新认证并给权威快照；角色保留策略待选 |

当前实现拒绝同一角色的新连接，旧连接保持。LAN 场景仍不信任客户端字段。局域网是否按可信网络部署、是否需要 HTTPS/WSS 是部署决定；账号与敏感信息不放 URL 或普通日志。若提供 Cookie 会话，WebSocket 升级与跨站请求按允许的来源验证。

## 5. 技能与动作的结算流程

`useSkill 意图 → 身份/状态/技能条件检查 → 建立动作实例 → 到时执行目标判定与效果 → 广播结果 → 清理实例`。

- 条件检查包括技能已学会、等级、资源消耗、冷却、动作是否允许、地图限制等；具体字段从选定版本确认。
- 伤害、命中、目标数量、投射物生灭、MP 消耗与冷却由 Rust 计算。客户端位置或目标只可作经过验证的提示，最终结算不接受客户端报出的 damage。
- 技能数据引用通用目标选择、动作步骤与效果：直接伤害、投射物、位移、持续状态等。现有机制的新技能主要改配置；新机制才新增一个行为处理函数并显式注册。
- 发布动作开始 / 投射物生成事件支持前端及时表现，命中事件包含权威结果；关键实例有服务端 ID 和时序，取消与结束均可对应。
- 随机结果由服务端生成；同一命中或怪物死亡只结算一次。掉落实体有独立运行时 ID、归属与拾取状态。

组合式组件与数据驱动不表示任意代码执行：配置只允许已注册类型和校验过的参数。没有需求时不引入脚本 VM、可视化节点编辑器或动态插件系统。

## 6. 任务与背包事务

任务定义分为接取条件、进行目标、提交条件和奖励动作。玩家进度来自服务端击杀、拾取、到达地图等已确认事件，不接受“我已完成”作为事实。

通用流程：验证任务当前状态 / NPC / 距离 / 条件 → 校验容量与消耗 → 在同一事务里更新任务状态、扣除材料、发放奖励 → 成功后发布新状态。任务重复提交、两次拾取同一掉落、同时消耗同一物品都必须只成功一次。

账号持久化已采用 rusqlite / SQLite。账号、角色归属、背包、技能学习、任务进度是候选持久化对象；HP、坐标及未完成动作如何跨重启恢复，需要在内容与体验确定后明确。内存快照不能替代成功事务，不先保存“已完成”再异步尝试发奖。

Cosmic 的 JS 任务 / NPC 脚本用于读懂流程，不原封不动加载到 Rust 执行。每迁移一条任务记下原始文件、内容版本、条件、奖励和未覆盖分支。特殊任务只扩展已需要的服务端动作，不先设计通用脚本语言。

## 7. 内容加载与版本

content 从离线导出的同版数据读取 map、mob、item、skill、quest 等定义，启动时校验 ID 引用、单位、范围及资源版本。后端主要使用地图碰撞、出生点、技能规则等数据，不需要在 tick 内解码 PNG / MP3。

WZ 并不包含所有服务端业务：掉落规则、部分公式和任务脚本需从所选参考版本核对。Cosmic 是修改过的 v83 数据，不能把其配置和原版 83.zip 无说明混在一起；差异作为有来源的显式覆盖记录，或保持原版，不静默替换。

修改内容包时前后端共享 contentVersion；客户端版本不匹配就明确要求刷新 / 重新加载。MVP 无热更新承诺，启动时载入一套已校验定义即可。

## 8. 从源码学什么

| 调用链 / 文件 | 参考价值 | 新工程取舍 |
| --- | --- | --- |
| Cosmic `QuestActionHandler` → `Quest` → requirements / actions | NPC 接近性、任务状态、条件和奖励分层 | Rust 采用清晰配置和处理函数，不照搬 Java 的大继承树 |
| Cosmic `Quest.java` 读取 QuestInfo / Act / Check | 文本、条件、动作三类数据的关系 | 以选定底包与脚本核对后的定义为准，不能假定一套 WZ 已含全部业务 |
| Cosmic `SkillFactory.loadAllSkills` → `loadFromData` → `StatEffect.loadSkillEffectFromData` | 技能等级数据、效果和特殊例外 | 整理成可组合规则，避免每技能一个类或巨大 ID 分支表 |
| Cosmic `AbstractDealDamageHandler.parseDamage` | 可查旧技能公式和限制 | 旧流程读取客户端伤害再检查；新服务端自行算伤害 |
| Maplewright `crates/physics/src/foothold.rs` | 坡道与落地几何参考 | 验证真实地图规则；不把矩形碰撞 demo 当成原版运动 |
| Maplewright `crates/wsproxy/src/main.rs` | 原浏览器客户端如何桥接旧 TCP | 自建 Rust + TS 两端省去旧协议加密、端口迁移及代理 |

这是有范围的源码审核，不是对所有仓库全部功能或安全性的全面认证。

## 9. 已确认首版后端验收

首版为一张地图、两个及多个独立账号、局域网联机、移动和普攻。身份、移动和动作状态由同一 Rust 规则处理，不硬编码两个账号为特例。

开发自测接入两个程序化机器人客户端，走实际认证 / 输入 / 普攻消息链路；交付用户验收时提供可登录进入的服务和一个自动运行的机器人。机器人不直接改世界，也不依赖 AI 动态发动作。

核验角色归属、同图互见、移动与普攻同步、伪造字段不影响权威状态、断线清理输入与重入快照。普攻如包含命中与扣血，仍由服务端判定；具体受击对象尚未选定，不自行追加 PVP 或怪物掉落需求。

第 5、6 节的技能、任务、背包与奖励事务是后续模块设计，不作为首版通过条件；相关行为实现时再按验收标准验证。账号认证所需的数据仍按首版实现，尚未定案的其它存档策略不能冒充已承诺行为。

文档导航：[计划](</Users/muniao/Library/Mobile Documents/com~apple~CloudDocs/游戏/github/MapleStory/PLAN.md>) · [共同契约](</Users/muniao/Library/Mobile Documents/com~apple~CloudDocs/游戏/github/MapleStory/SHARED_ARCHITECTURE.md>) · [前端](</Users/muniao/Library/Mobile Documents/com~apple~CloudDocs/游戏/github/MapleStory/FRONTEND_ARCHITECTURE.md>) · [验收标准](</Users/muniao/Library/Mobile Documents/com~apple~CloudDocs/游戏/github/MapleStory/ARCHITECTURE_ACCEPTANCE.md>) · [参考项目分级](</Users/muniao/Library/Mobile Documents/com~apple~CloudDocs/游戏/github/MapleStory/REFERENCE_PROJECTS.md>)

## 本地审核证据

- [任务入口](</Users/muniao/Library/Mobile Documents/com~apple~CloudDocs/游戏/github/MapleStory/参考/repos/P0nk__Cosmic/src/main/java/net/server/channel/handlers/QuestActionHandler.java>)
- [任务定义与条件/奖励](</Users/muniao/Library/Mobile Documents/com~apple~CloudDocs/游戏/github/MapleStory/参考/repos/P0nk__Cosmic/src/main/java/server/quest/Quest.java>)
- [技能加载](</Users/muniao/Library/Mobile Documents/com~apple~CloudDocs/游戏/github/MapleStory/参考/repos/P0nk__Cosmic/src/main/java/client/SkillFactory.java>)
- [旧攻击解析](</Users/muniao/Library/Mobile Documents/com~apple~CloudDocs/游戏/github/MapleStory/参考/repos/P0nk__Cosmic/src/main/java/net/server/channel/handlers/AbstractDealDamageHandler.java>)
- [foothold参考](</Users/muniao/Library/Mobile Documents/com~apple~CloudDocs/游戏/github/MapleStory/参考/repos/Sheilem__maplewright/crates/physics/src/foothold.rs>)
- [旧TCP代理](</Users/muniao/Library/Mobile Documents/com~apple~CloudDocs/游戏/github/MapleStory/参考/repos/Sheilem__maplewright/crates/wsproxy/src/main.rs>)
