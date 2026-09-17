# 死亡后果系统：Agent 技术实施规格
## Rust 单一权威世界 · 墓碑／虚影／经验球／演化／觉醒 v0.1

> 日期：2026-09-17。  
> 固定核查提交：`dragon717/MapleStory@db3497168e5a6a17a73ab702a1151bdb77418763`。  
> 已核对的协议基线：`PROTOCOL_VERSION = 24`；内容：`tms273-31`。[R12]  
> 本文是待实现规格，不是补丁、已通过测试报告或可直接粘贴的完整实现。所有“新增”路径、类型、表与协议均为提案。  
> 产品规则：[玩法设计](MapleStory_Death_Design_v0.1.md)；执行次序：[开发计划](MapleStory_Death_Implementation_Plan_v0.1.md)。

---

## 0. 阅读入口与必须遵守的边界

实施前首先读取仓库 `AGENTS.md`、`docs/technical/BUSINESS_DEVELOPMENT.md` 与最新 `docs/plan/PLAN.md`；随后按计划列出的相关文件定向阅读。本文不能覆盖工作区的新修改、用户最新指令或已有受保护的定制规则。[R01][R02][R03]

新功能仍由当前 `World` 单一逻辑拥有者推进，网络只提交意图，Store 只提交服务器已构造的事务计划。禁止每个虚影启动一个模拟 task，禁止第二套世界锁，禁止借本任务重建 ECS、微服务、通用事件溯源框架或迁移渲染器。

当前主世界使用 Phaser Scene，同时包内已包含 Three.js；应在已有主世界表现通道接入，不把“存在 Three 依赖”理解成所有场景已经完成 Three 重构。[R13][R14]

所有数值默认值以玩法设计 §11.3 为唯一入口。本文另外给出的性能、缓存和数据库限制是工程预算提案，不是实测结论。

---

## 1. 源码核查：已存在什么，不能假设什么

### 1.1 已验证接入点

| 文件／符号 | 本次实际读到的内容 | 本任务的接入要求 |
|---|---|---|
| `world.rs`、`TICK_MS` | `#[path]` 平铺世界子模块；Tick 为 50 ms | 延续注册方式，不另造 `world/ecs` 目录与驱动循环。[R04] |
| `monsters.rs::commit_incoming_damage` | 候选 HP/MP、致死生成 `death_id`；调用 Store 保存后才更新内存 | 把致死事实、墓碑与稀有判定并入同一提交；不能提交后再尽力创建墓碑。[R05] |
| `revive.rs::handle_revive` | 查询原回执，并比较这次／上次 `death_id`；不同死亡拒绝旧请求 | 保留死亡代次隔离；复活不删除世界痕迹。[R06] |
| `revive.rs::complete_revive` | 还原角色、清 `death_id` 和 Buff；尾部忽略 `persist_player` 返回值 | 这是需要定向核查的提交边界风险，不能未经测试宣称已复现数据损坏。[R06] |
| `combat.rs::Combat::attack` | 攻击认领和回执，不是死亡结算器 | 不因旧模块注释而把死亡业务加进这里。[R07] |
| `auth/loot.rs::resolve_attack_with_party` | 玩家伤害贡献、一次怪物奖励认领、直接经验、队伍奖励和任务计数 | 虚影不得冒充原账号；同一个怪物必须共用唯一奖励认领。[R08] |
| `auth/schema.rs::Store::init` | SQLite WAL、外键启用、既有迁移入口 | 新表增量迁移；严禁清空玩家库。[R09] |
| `auth.rs`／`auth/db.rs` 导出 | `add_exp`、`grant_level_sp` 等能力，以及持久化失败注入设施 | 球经验使用同一升级口径；新增事务内部 helper，不能嵌套 Store 公共事务。[R10] |
| `auth/item_world.rs` | Owner/Location/State 分离；背包仓库搬运与掉落拾取有不同契约 | 经验球不实现物品容器，不借 `item_id = "0"` 冒充枫币。[R11] |
| `shared/protocol.ts` | 玩家、NPC、掉落、召唤物分别建模；ID 是字符串 | 新增独立死亡世界视图，不塞进 `SummonState.playerId`。[R12] |
| `client/src/scenes/world.ts` | Phaser、输入回调、快照插值、切图 clear/restart | 新 View 必须加入创建、更新、销毁与重连恢复。[R13] |
| `windbell.rs` | 有限状态机、有限自主节奏、公共／私人范围区分 | 借鉴明确状态，不声称已有通用 NPC 世界意识。[R15] |
| 天命专题 v0.2 | 历史主体、表现 ID、模板分离；事实和有来源记忆 | 作为设计依赖；未证明完整天命、席位竞争已实现。[R16] |

### 1.2 实施前必须补完的定向核查

本次未逐行审计整个仓库。以下不是让 Agent 重新做全仓调研，而是冻结契约前必须查清的窄问题：

1. 搜索所有写入玩家致死状态、调用 `commit_incoming_damage`、`save_profile` 和复活 Store 方法的路径；覆盖 Boss、异常状态、跌落／地图边界、脚本与 GM。将哪些路径会产生正式死亡明确列为表，不推测它们都已统一。
2. 搜索全部怪物 HP 扣减、`resolve_attack_with_party`、`monster_rewards` 和经验写入点；尤其技能、召唤与持续伤害，不能只改普攻。
3. 确认大厅的真实账号 → 角色映射。旧表 `account_id` 在部分上下文实际承载角色身份，不能据列名直接实现“同账号排除”。[R16]
4. 确认世界连续体／实例 ID 是否已有落地实现；优先复用，确无实现才增加一个持久连续体标识，不能使用进程 ID、Tick 或内容版本代替。
5. 确认当前 NPC 历史身份、记忆、天命候选和席位存储的真实实现位置；找不到实现时记录依赖阻塞，而不是照历史文档创建同名空服务。
6. 从本地已装配内容选择真实 map、spawn、template、foothold 和资源。未入库 WZ／运行产物本次未核查，不编造落点、贴图或地图规模。

### 1.3 本任务不自动修复的历史问题

纯玩家旧奖励公式、所有地图持久模拟、原版死亡惩罚考证、全仓大文件拆分不包含在 P1。为了新事务必须抽取的小 helper 可以做，但要与玩法变化分开审查。遇见未覆盖的致死路径，先决定纳入或明确排除，不用默认行为吞掉不确定性。

---

## 2. 不变量清单

这些编号同时用于任务卡、测试和审查，不以“看起来运行正常”代替验证。

| 编号 | 必须始终成立 |
|---|---|
| INV-01 | 一次被提交的正式死亡，只有一个 `death_id`；至多一个对应墓碑、一次稀有判定和一个根虚影 |
| INV-02 | 玩家致死状态、死亡记录、墓碑和稀有判定在同一数据库事务提交；对外先看到结果时，持久事实已成立 |
| INV-03 | 角色复活、断线、切图、删除当前表现，不删除独立世界痕迹；回执不能复活不同代次死亡 |
| INV-04 | Echo/NPC 的来源角色不是操作者或默认奖励接收者；源账号信息不由客户端提交 |
| INV-05 | 一只怪物的一次生命，只被一个公共奖励认领成功；玩家与虚影路径不能分别发一次 |
| INV-06 | 有效贡献只计实际 HP 损失；基础经验分配、球物化和耗散可对账，队伍额外预算单独记录 |
| INV-07 | 一个球最终只可能为可领取、已领取、已到期之一；认领、角色升级和回执原子提交 |
| INV-08 | 融合／吞噬的输入状态与输出状态原子变更；同一输入版本不能参加两次成功演化 |
| INV-09 | 根来源集合准确保留；预算不复制，寿命不因重启重算，吞噬不洗掉源账号排除 |
| INV-10 | 同一虚影最多产生一个觉醒历史主体；觉醒不复制玩家资产或原玩家天命 |
| INV-11 | 公共交互状态按世界连续体＋真实实例隔离；个人对白不能改变公共物理事实 |
| INV-12 | 未实现的系统适配器不能返回“已记忆／已参选／已广播”；只登记真实事实或明确延后 |
| INV-13 | 浏览器从不决定死亡、生成、伤害、奖励、融合或觉醒；本地缓存不成为存档 |
| INV-14 | 整个机制可限制范围和停止新作用，但关闭开关不销毁已提交的账本与必要来源 |

---

## 3. 模块职责与建议目录

### 3.1 渐进式目录

下列全部是**拟新增**；按阶段创建，不预建只有 TODO 的未来模块。

```text
server/src/
  death_domain.rs             P1：纯数据、纯判定、原因与ID类型；crate级共享
  death_world.rs              P1：World协调；致死计划、投影、墓碑到期
  echo_world.rs               P2：目标选择、动作调度、有限AI、干涉
  echo_rules.rs               P2/P3：纯行为与演化判定；确有规模才从domain拆出
  experience_orbs.rs          P2：World拾取验证、物化与对外视图
  death_world_acceptance.rs   P1起：定向世界测试，按已有测试注册方式接入
  auth/
    death_world.rs            P1：死亡、墓碑、种子、回执、恢复事务
    echo_rewards.rs           P2：类型化遭遇、单一奖励认领、经验球事务
    echo_evolution.rs          P3起：吞噬／融合／觉醒事务，按实需建立
client/src/features/death-world/
  state.ts                   客户端只读归并、epoch/revision与事件去重
  view.ts                    墓碑、虚影、球的表现与资源复用
  epitaph.ts                  受控碑文、轻量交互与无障碍信息
  view.check.mjs             或匹配当前TS运行方式的定向检查
shared/
  death-world.json            原创P配置；不覆盖WZ导出事实
scripts/
  check_death_world.cjs       配置、引用、版本与容量约束检查
```

涉及既有文件：`main.rs` 组装配置与 crate 模块；`world.rs` 私有运行态／子模块注册／Tick 接线；`monsters.rs` 受伤桥接；`revive.rs` 墓碑独立性与提交边界；`auth.rs` 注册子模块；`auth/schema.rs` 迁移；奖励调用点路由；Rust 与 TS 协议、机器人、前端 `app/main.ts` 和 `scenes/world.ts`。

主模块不可命名为 `npc` 去遮蔽现有 `crate::npc`。`world.rs` 只增加持有、路由与步骤调用，不继续内联 SQL、所有纯规则和绘制数据拼装。[R16]

### 3.2 所有权与调用边界

```text
网络：认证与字段校验 → 已绑定角色的有限意图
World：范围／距离／当前版本校验 → 构造提交计划
纯规则：有限事实输入 → 决策或拒绝原因
Store：同一事务验证持久前置 → 提交并返回 CommittedDelta
World：应用已提交投影 → 快照／回执／有依据的领域事实
前端：读取 → 表现 → 提交下一个合法意图
```

`CommittedDelta` 是本模块返回值的概念，不代表仓库已有通用持久事件总线。普通世界移动仍沿既有过程，不全量事件溯源。

---

## 4. 类型：角色来源、历史主体和当前实体必须分开

### 4.1 ID 与状态字段

| 概念 | 含义与约束 |
|---|---|
| `CharacterId` | 认证角色，不是名字；用于复活、角色经验和个人记忆 |
| `AccountId` | 真实账号；只在服务端生成根来源排除关系 |
| `ContinuityId` | 持久世界连续体，重启不变；复制成新世界需明确分叉 |
| `MapInstanceId` | 实际交互范围；不能只比较素材地图 ID |
| `DeathId` | 一次致死结果，服务端产生且持久唯一 |
| `EchoId` | 当前独立虚影实体；融合生成新 ID，吞噬可保留胜者 ID并升级revision |
| `ActorId` | 觉醒后的历史主体 ID，独立于当前NPC表现实例 |
| `PresentationId` | 当前可点击／渲染实例，不能作为人生历史主键 |
| `TemplateId` | WZ／原创内容的外观定义，不能证明两个实例是同一个人 |
| `MonsterLifeId` | 一次怪物生命，重生必须新 ID；相同生命重试不得换 ID |
| `OperationId` | 内部幂等操作或客户端requestId的命名空间化表达 |

`death_id` 已存在于玩家与复活流程；新模块沿用该次死亡标识，不另造与其无关的“灵魂死亡计数”。[R05][R06]

### 4.2 Rust 核心数据示意

下列是纯数据骨架，字段需要与实施基线整合；未附 Serde/DB 适配，不声称可直接作为仓库补丁。ID 在生产中宜封装为经验证的新类型，示例用 String 减少初学者阅读负担。`DeathFact`是服务端领域对象，不可直接序列化为公共快照；`source_account_id`只能用于内部归因与资格验证。

```rust
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorldScope {
    pub continuity_id: String,
    pub map_instance_id: String,
    pub map_template_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ActorRef {
    Character(String),
    Echo(String),
    StoryNpc(String),
}

#[derive(Clone, Debug)]
pub enum DeathCause {
    Monster { monster_life_id: String },
    Environment { source_id: String },
    EchoInterference { echo_id: String },
    Scripted { event_id: String },
    Administrative,
}

#[derive(Clone, Debug)]
pub enum EchoBirthDecision {
    Suppressed { reason: String },
    NotSelected { policy_version: String },
    Selected {
        echo_id: String,
        archetype_id: String,
        activates_at_ms: i64,
        expires_at_ms: i64,
    },
}

#[derive(Clone, Debug)]
pub struct DeathFact {
    pub death_id: String,
    pub subject_character_id: String,
    pub source_account_id: String, // 死亡时解析并冻结，仅服务端使用
    pub scope: WorldScope,
    pub died_at_ms: i64,
    pub cause: DeathCause,
    pub world_x: f64,
    pub world_y: f64,
    pub evidence_fact_ids: Vec<String>, // 有界、服务器已有事实
    pub birth: EchoBirthDecision,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OrbStatus {
    Available,
    Claimed { character_id: String, receipt_id: String },
    Expired,
}

#[derive(Clone, Debug)]
pub struct ExperienceOrb {
    pub id: String,
    pub scope: WorldScope,
    pub settlement_id: String,
    pub amount: u64,
    pub expires_at_ms: i64,
    pub revision: u64,
    pub status: OrbStatus,
}
```

在 Rust 中，`enum` 的每个分支自带需要的字段，因此“已领取却没有领取人”不能由上面的类型表达。`&T` 是只读借用，`&mut T` 是独占可变借用；不要为了绕开借用错误给整个世界加 `Arc<Mutex<_>>`。先从只读快照构造候选，再在原有单一 World 中按顺序应用已提交结果。

### 4.3 Go 对照：帮助理解，不新增第二套后端

Go 通常需要判别字段与校验器表达同样限制；以下只用于和上面的 Rust 核心概念对照。生产实现仍为 Rust，不创建 Go 运行服务。

```go
package deathmodel

import "fmt"

type WorldScope struct {
    ContinuityID, MapInstanceID, MapTemplateID string
}

type ActorKind uint8
const (
    Character ActorKind = iota + 1
    Echo
    StoryNPC
)

type ActorRef struct { Kind ActorKind; ID string }
func (a ActorRef) Validate() error {
    if a.ID == "" || a.Kind < Character || a.Kind > StoryNPC {
        return fmt.Errorf("invalid actor")
    }
    return nil
}

type DeathCause struct {
    Kind string // monster / environment / echoInterference / scripted / administrative
    SourceID string // 非administrative时必须有效
}

type EchoBirthDecision struct {
    Kind string // suppressed / notSelected / selected
    Reason, PolicyVersion, EchoID, ArchetypeID string
    ActivatesAtMS, ExpiresAtMS int64
}

type DeathFact struct {
    DeathID, SubjectCharacterID string
    SourceAccountID string // 死亡时冻结，禁止发送到公共视图
    Scope WorldScope
    DiedAtMS int64
    Cause DeathCause
    WorldX, WorldY float64
    EvidenceFactIDs []string
    Birth EchoBirthDecision
}

type OrbStatus struct {
    Kind string // available / claimed / expired
    CharacterID, ReceiptID string
}

type ExperienceOrb struct {
    ID, SettlementID string
    Scope WorldScope
    Amount, Revision uint64
    ExpiresAtMS int64
    Status OrbStatus
}
```

Go 版仍需补完整组合校验；Rust 版也仍需校验空 ID、NaN 坐标、数值上下界和跨范围引用。编译期类型安全不等于业务输入校验。

---

## 5. 持久模型与迁移

### 5.1 新表职责，不把世界塞进角色存档

表名为建议；如果实施时已存在相同职责的表，复用并升级，不再建立平行真相。

| 阶段／建议表 | 主键或唯一约束 | 关键事实 |
|---|---|---|
| P1 `death_records` | PK `death_id` | subject_character_id、死亡时冻结的source_account_id、scope、时间、真实死亡点、原因、规则版本、出生判定、证据引用 |
| P1 `death_traces` | PK `trace_id`；UNIQUE `death_id` | 展示点、脚点、墓志铭模板、脱敏显示名、外观引用、截止时间、revision |
| P1 `death_spawn_windows` | PK continuity/account/region | 下次允许抽取时间；任何合格抽取成功提交后推进，不只中奖才推进 |
| P1 `death_world_actions` | UNIQUE actor_kind/actor_id/operation/request_id | 规范化请求指纹、结果、结果引用、策略版本、时间；不能只有进程缓存 |
| P2 `echoes` | PK `echo_id`；根虚影的 `birth_death_id` UNIQUE | scope、阶段、姿态、偏向、凝聚／失衡、计划、位置、revision、激活／截止时间 |
| P2 `echo_sources` | PK echo_id/root_death_id | 精确的根来源集合，最多16；源账号由root事实解析，永不交客户端 |
| P2 `echo_root_budgets` | PK root_death_id | 已授权总量、已物化经验量；根预算不随融合复制 |
| P2 `echo_encounters` | PK monster_life_id | 被试点策略标记的一次怪物生命、scope、模板、HP、状态、策略版本、重生截止 |
| P2 `encounter_damage` | PK monster_life_id/actor_kind/actor_id | 试点遭遇唯一的类型化有效伤害累计；不同时把另一张贡献表当权威 |
| P2 `experience_orbs` | PK orb_id；UNIQUE settlement_id/ordinal | 正数经验、scope、位置、来源虚影、出生／截止时间、状态、领取人、revision |
| P2 `experience_orb_sources` | PK orb_id/root_death_id | 生成时冻结的根来源；后续吞噬改写虚影谱系不改变旧球资格 |
| P2 `echo_region_budgets` | PK continuity/region/window_id | 10分钟窗的已物化经验；窗口策略版本固定、边界不允许客户端指定 |
| P3 `echo_evolutions` | PK evolution_id；UNIQUE operation_key | 输入ID和版本、类型、输出ID、来源集合、预算变化、结算结果 |
| P4 既有历史人物表或 `emergent_actors` | PK actor_id；UNIQUE source_echo_id | 稳定历史身份、有限记忆、目标与立场、当前位置、生命阶段 |
| P4 既有事实／记忆表 | source fact唯一消费约束 | 目击来源、主体、知情方式；不能把NPC对话游标当记忆 |

普通完整碑文／证据摘要建议30天后压缩，关键 death_id、不可重放凭证、活跃演化根和觉醒来源按引用保留。删除策略须证明不会重新授权生成、重领或洗掉排除关系；不能通过定时清表制造“过了30天又能重放一次”。

### 5.2 P1 核心 DDL 示例

以下是便于评审的**部分 DDL**，不是完整迁移文件。完整状态检查、索引、迁移版本、账号外键和回执表由实施任务生成；生产不得只执行此片段便宣布完成。

```sql
CREATE TABLE death_records (
  death_id TEXT PRIMARY KEY,
  subject_character_id TEXT NOT NULL,
  source_account_id TEXT NOT NULL,
  continuity_id TEXT NOT NULL,
  map_instance_id TEXT NOT NULL,
  map_template_id TEXT NOT NULL,
  died_at_ms INTEGER NOT NULL,
  world_x REAL NOT NULL,
  world_y REAL NOT NULL,
  cause_json TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  birth_decision_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL
);

CREATE TABLE death_traces (
  trace_id TEXT PRIMARY KEY,
  death_id TEXT NOT NULL UNIQUE REFERENCES death_records(death_id),
  placed_x REAL NOT NULL,
  placed_y REAL NOT NULL,
  foothold_id INTEGER NOT NULL,
  epitaph_template_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  appearance_ref TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('visible','archived')),
  revision INTEGER NOT NULL CHECK(revision >= 1)
);

CREATE INDEX death_records_scope_time
  ON death_records(continuity_id, map_instance_id, died_at_ms);
CREATE INDEX death_traces_expiry ON death_traces(status, expires_at_ms);
```

REAL 列并不能阻止所有非法坐标；World 与配置加载器仍拒绝非有限数、越界与非法脚点。`appearance_ref` 是可验证的外观定义引用，不是可交易的装备实例。

### 5.3 必须复用一只怪物的一次奖励认领

当前 `monster_rewards` 以 `monster_id` 为主键，`account_id` 与 `request_id` 均是 NOT NULL，语义偏向玩家击杀。[R09] 不能传入 `"echo-123"` 伪装一个不存在的账号，也不能另造只管虚影的奖励表而保留两条互不排斥的付款路径。

P2 的推荐增量方案是：**保留 `monster_rewards.monster_id` 这一唯一认领点，扩展为兼容世界行动者的结算记录**。

- 加入明确的 `settlement_id`、`settler_kind`、`settler_id`、策略版本与对账字段。
- 旧的玩家所有者／请求列在世界分支允许 NULL，新增 CHECK 约束区分合法组合；旧玩家行保留原值。
- 对历史行无法反推的新金额字段保留“未知／legacy”，不能把 0 当成历史上真的耗散了全部经验。
- SQLite 改变列约束通常需要受控建新表、复制、校验、切换；在迁移事务内进行，按实际外键与索引制定脚本，不直接向在线数据库运行文档 SQL。
- 首先发布能读新旧行的兼容代码，再启用世界分支；回滚到该兼容基线，而不是任意旧二进制。旧读取把 NULL 当 String 的风险必须有测试。

这不是要求重写全部旧奖励。怪物在出生时就冻结 `reward_policy`：`legacy_player_only` 或 `death_echo_v1`。未启用试点的怪物继续旧路径；试点怪物的**所有**伤害来源从第一击起都走类型化遭遇记录。不能等虚影最后一击才临时切换，因为此前贡献可能已经按另一套口径写入。

### 5.4 事务内 helper 约束

调用者先取得一个 Store 数据库连接和事务，内部 helper 接受该事务；不要在事务中调用另一个会获取同一把锁并启动新事务的 Store 公共函数。SQLite 的 BEGIN 事务不支持嵌套，同一时刻只有一个写事务；必要的局部回滚使用 SAVEPOINT，而不是再开一个连接绕过世界所有权。[E01]

提交成功只证明 SQLite 内相关写入完成，不代表网络消息必达或内存投影已经更新。状态快照、幂等回执与恢复逻辑共同补足这些边界；不能宣传跨 SQLite、内存与网络的天然 exactly-once。[E02]

---

## 6. P1：死亡、墓碑与复活事务

### 6.1 致命原因必须从上游传入

当前 `commit_incoming_damage` 只接收角色ID和伤害值，不能完整表达“谁／哪条规则造成死亡”。[R05] 增加服务端构造的 typed source 参数或窄包装，沿实际调用链传入怪物生命、环境事件、脚本或虚影干涉来源。

保留现有防御、护盾、魔心防御和无敌状态计算。新功能读取最终致死判定，而不是在各个技能分支再写一份 HP0 检查。管理命令造成的死亡明确标记 Administrative，不生成经济价值。

### 6.2 正常提交次序

```text
读取当前玩家、范围、伤害来源与策略版本
  → 计算候选HP/MP，判断是否从活着进入死亡
  → 构造DeathPlan：death_id、真实点、展示点、证据、判定与期限
  → Store单事务：
       验证角色仍为预期死亡代次／状态
       写入与旧流程一致的角色候选存档
       INSERT death_records、death_traces
       固定出生判定与账号区域抽取窗口
       P2开启时插入潜伏echo与根预算；P1记feature_disabled
       写本次操作结果
  → COMMIT
  → World应用角色死亡与世界痕迹投影
  → 广播死亡表现事件；快照承担可恢复的最终状态
```

P1 没有虚影能力时，出生决定明确为 `suppressed(feature_disabled)`。升级到 P2 不回头对 P1 的墓碑补抽稀有结果。

### 6.3 稀有判定与稳定性

所有条件均读取已提交／同事务可验证的事实。合格抽取无论命中与否都占用30分钟账号区域窗口。出生决策、规则版本和抽取结果与死亡同时落库；恢复时读取结果，不重跑当前概率。

`feature_disabled`、范围禁止、证据不足等前置排除不是一次合格抽取，不推进抽取窗口。只有已经进入稀有判定并成功提交的合格抽取才消耗窗口。

随机数可使用现有安全可用随机源后保存结果，或使用版本固定且非客户端可预测的抽样方案；**禁止依赖 Rust `DefaultHasher` 的跨版本稳定性来承诺永远同一结果**。不需要保存可以预测全服未来抽样的秘密种子给客户端。

未提交事务失败时没有成功死亡事实可供玩家利用；重试不得发布不同候选动画。如果进程已提交后崩溃，重启必须按该 death_id 的既存结果恢复。

### 6.4 失败处理

保存失败：沿既有语义不应用候选 HP/MP，不生成墓碑、不发出生事件，返回受控持久化失败；重试有界，不在一个 Tick 内无限循环。磁盘故障期间不得一边允许奖励产生、一边关闭账本检查。

提交后内存尚未应用时崩溃：重启装载死亡状态与对应痕迹。恢复绝不能把“数据库已经死了，但内存还没显示”当作第二次死亡。

死亡点无法放墓碑：优先选择同一真实实例内配置认可的最近合法脚点；仍不存在时记录死亡并提供非碰撞纪念入口，出生决策为 `no_safe_anchor`。不能为了满足视觉而把虚影刷到城镇复活点。

### 6.5 复活

保留 `prior_revive` 的回执和 death_id 匹配规则。对当前 Store 复活和 `complete_revive` 的完整提交链进行定向审查：需要持久的最终复活 HP、位置、death_id 清理必须有明确提交结果；不能忽略可能失败的末尾持久化并仍报告所有状态可靠。[R06]

可以把复活收束为“生成最终复活候选 → Store同时提交角色最终状态和回执 → 应用内存”；具体沿用或抽取现有 Store 方法，先读实现再改。它不涉及更新 `death_traces`、`echoes` 或根预算。

新协议可增加绑定当前死亡的 `expectedDeathId`，但必须两端一起更新；它不是来源真实性证明，服务端仍以认证身份和当前死亡代次为准。是否增加由协议协调任务决定，不能把当前协议已有该字段当作事实。

---

## 7. World 步进、时钟与持久恢复

### 7.1 插入步骤，不重排旧世界

实施时先定位真实 Tick 方法并记录现有顺序；本节是新步骤的**依赖关系**，不是声称当前源码已有下列完整流水线。

```text
现有输入与世界步骤保留其相对顺序
  → 在既有受伤提交点产生DeathPlan
  → 新激活的echo本Tick不攻击
  → echo有限决策产出动作候选，不直接改目标HP
  → 进入现有顺序结算区，经策略路由处理攻击
  → 干涉与拾取做服务端校验及原子提交
  → 演化消费本轮稳定输入，结果下轮才可继续动作
  → 到期转移与快照
```

同一对象有消散／吞噬／觉醒等竞争时，先使用版本前置；同一轮已有成功终态的对象不再处理其它动作。对同优先级候选使用稳定排序与轮转调度，避免每次只让最小ID抢占预算。

### 7.2 两类时间

- **模拟时间**：沿当前50ms Tick，处理动作前摇、技能冷却与AI步骤。不得把重启后的 tick0 当作旧的 tick0。
- **持久期限**：服务端 UTC 毫秒，保存墓碑、虚影和经验球绝对截止时间。`remainingMs` 只是视图，客户端不判断领取资格。

进程内将墙钟期限映射为单调时间差，防止系统时间小幅回拨延长已观察到的有效期；跨重启保存并检查时钟高水位。检测到严重回拨时，暂停有收益的生成／领取并报错，不能悄悄把期限全部重设。具体容忍量进入运维配置与测试，而不是写死为“时钟永远准确”。

### 7.3 空地图与离线

没有真实活人观察者的地图不做新战斗、拾取、演化或觉醒推进。仅按截止时间进行懒到期／批量清理，低成本保留状态。普通“玩家连接存在”与可以作为有效观察者的存活／驻留状态需按既有失焦政策核查，不能靠挂机角色维持刷经验。

重新入图先装载有效对象和快照，再启用干涉保护窗口。任何已生成但过期的球直接终结，不因无人观看而暂停30秒寿命。[R19]

### 7.4 恢复顺序

读取配置与迁移版本 → 读取世界连续体 → 检查所有来源与范围 → 标记已到期对象 → 装载有效墓碑／虚影／球 → 恢复试点遭遇生命 → 恢复NPC历史身份与表现绑定 → 完成快照后接收新作用。

异常记录隔离并报警；不把未知模板、缺失地图、断裂来源或超大数值自动修成一个更强虚影。地图升级导致旧位置无效时，使用有记录的重新锚定规则；若无合法位置，只保留历史并停止交互。

位置可按有界周期检查点和重要行为持久化，不要求每50ms写SQLite。恢复可能回到最近位置检查点，但已发经验、已消费预算、死亡／融合／觉醒终态绝不能随位置回退。首次恢复给予预警和保护，不在旧位置快照恢复瞬间伤人。

---

## 8. P2：虚影行动与可预警干涉

### 8.1 最小 AI，不是玩家镜像

首个原型只有：徘徊、观察威胁、接近合法目标、前摇、攻击、让路、耗尽／消散。它使用区域模板的运动与攻击参数，不读取来源玩家的实时输入、装备或技能冷却。

AI 的事实输入是同一实例内可观察的实体、威胁和障碍。目标输出为类型化 ActorRef 或怪物生命ID；候选动作由 World 验证后才执行。怪物仇恨目前偏向角色 ID，新攻击来源需要明确的类型化目标适配，不能把虚影挂入 `players` 以复用整套玩家行为。

只允许已登记的试点怪物与虚影互相作用。怪物能否打到虚影、追击距离与回归边界均明确配置；无对应仇恨／受击支持时，先交付非战斗表现，不把“怪物不会还手的虚影刷怪器”当作完成。

### 8.2 目标与空间约束

目标必须同scope、存活、处于允许的战斗策略、在攻击范围与可成立的空间关系中。不能只比较 x 距离忽略上下层平台；继续使用当前几何／脚点约定，不假定 Three 画面坐标是服务器碰撞坐标。

首版不追击已经由玩家发起的普通战斗，不攻击任务关键、Boss练习、多阶段或治疗怪物。玩家介入后，清理未落地的非必要追击，已经合法落地的伤害不能倒流取消，因此混合结算仍然必须实现。

### 8.3 阴阳干涉是独立作用来源

干涉输入包括：虚影失衡状态、生者距离、遮挡／层级关系、地图保护区、首次入图／复活保护、前摇完成与周期冷却。生者不是虚影敌人；这段伤害不需要伪造敌对攻击意图。

最终效果仍经过现有防御和状态管线。P2 的非致命限制施加于最终 HP 扣减：最多扣到1；MP按共同规则处理。不得通过先提交死亡再复活来模拟非致命，否则会错误地产生墓碑、计数与回执。护盾、持续技能免疫、异常状态的相容性必须在定向测试中冻结。

服务器对外提供“干涉将开始”“范围”“剩余预警”和真实伤害来源。浏览器只能提前展示，不能自行结算或关闭伤害。重连时过期的前摇不能瞬间伤害新来者；服务器先重建保护窗口。

---

## 9. P2：战斗贡献、唯一结算与经验预算

### 9.1 试点遭遇的完整路由

出生时冻结 `death_echo_v1` 策略与配置版本。普攻、技能、持续伤害、玩家召唤、虚影攻击都必须使用同一有效贡献入口。玩家召唤物的有效角色归因沿已核定的现有规则，虚影绝不能冒充玩家召唤物。

试点范围只接受无治疗、无变身复活的普通怪物，因而一生实际总 HP 损失可与基础 HP 对齐。若模板不满足此条件，启动校验拒绝启用，而不是运行时继续套用错误分母。

一次伤害的有效贡献为：

```text
effective_damage = min(max(resolved_damage, 0), hp_before)
hp_after = hp_before - effective_damage
```

无敌、闪避、已经死亡、不同实例和事务失败贡献均为0。持续伤害不能在目标已死后继续增加贡献。恢复试点遭遇时保留 MonsterLifeId、HP和死亡／重生期限；不能重启就把同一个未到重生时间的击杀目标变成新ID重新付费。

### 9.2 基础经验的确定性分区

设 E 为该策略冻结的怪物基础经验，H 为基础HP，D_h 为全部生者有效贡献，D_e 为全部虚影有效贡献。在本版允许的遭遇中，死亡时 `D_h + D_e = H`；若存在未分类伤害，必须增加显式耗散来源或拒绝此策略，不能把它自动算给最后攻击者。

```text
human_pool = floor(E * D_h / H)
echo_pool  = floor(E * D_e / H)
rounding_dissipation = E - human_pool - echo_pool
orb_candidate = floor(echo_pool * 2500 / 10000)
```

人类池按有效贡献做整数比例分配，余数按最大余数法、稳定角色ID打破平局；不合资格领取者的份额耗散，不自动转给最后一击。多个虚影的球候选先按各自有效贡献拆分，再分别受各来源预算限制，不能把所有球归给最后出现的虚影。

各虚影候选以最大余数法确定性拆分；某个虚影因预算不足而无法物化的部分直接耗散，不转给其它虚影或生者，避免混合攻击洗掉来源归属。

实际物化球金额由候选值、可用根预算、当前区域剩余额度、实例空间／球容量共同限制。所有舍弃都进入耗散金额，不能悄悄消失在审计字段之外。

```text
E = actual_human_base_awarded + actual_orb_minted + total_dissipated
party_bonus_awarded = 独立记录的既有额外预算（只依据生者部分）
```

此式不要求虚影拿走或返还来源玩家死亡损失；两者不是同一笔钱。所有乘法使用足够宽的整数中间值，最终显式范围检查；不以溢出后的饱和值制造经验。

### 9.3 队伍、掉落与任务

生者队伍额外经验仅以生者份额为基数，沿已核定的在场与资格规则分配；纯虚影击杀、经验球拾取均不发第二次队伍加成。

试点混合普通掉落门槛为 D_h/H≥50%。到达门槛后仍通过现有掉落内容与生者所有权规则，不能新复制一份drop；低于门槛则候选普通掉落为空。纯虚影击杀没有物品／枫币／任务道具／怪物卡奖励。

任务击杀沿真实落地者的现有授权规则处理：落地者为虚影时，不给来源角色或其队伍加任务进度。冒险笔记“见闻”是独立目击事实，不能伪装为物品获得事件或击杀计数。[R08][R11]

### 9.4 奖励提交事务

```text
验证本次攻击动作未结算，目标生命与HP版本正确
  → 提交有效伤害及试点遭遇候选HP
  → 若致死：INSERT唯一monster_rewards认领（同一个monster_id主键）
  → 仅认领成功者：
       计算生者份额／队伍额外池／掉落候选／各虚影球候选
       验证并扣减根预算与区域预算
       更新生者角色经验和升级结果
       写普通掉落（若有）与experience_orbs
       写基础经验、额外经验、耗散、规则版本对账字段
  → 写攻击回执与怪物终态／重生期限
  → COMMIT
  → World应用所有受影响角色、怪物、虚影与球的投影
```

碰到已有认领时返回既存结果，不再跑随机掉落、不再扣预算、也不创建另一组球。原始攻击请求重放与同怪物另一致死请求均受唯一约束保护。

### 9.5 根预算是权威，虚影上的剩余额只是投影

根死亡预算在第一次生成时授权，之后不可补发。`echo_root_budgets` 是唯一已花额度记录；融合结果只引用这些根，并不把“剩余100”复制进一个全新的充值账户。

同一次球物化按稳定根顺序分摊扣费，记录实际金额。与此同时，把该虚影生成时的完整根集合写入不可变的`experience_orb_sources`，并记录来源虚影revision；领取不查询虚影的“最新根集合”。旧球在产生之后不因胜者吞噬新来源而改变资格。根事实中的source_account_id在死亡时冻结，因此角色改名、删除或后续身份映射变化不会丢失原排除依据。根预算与区域预算都在结算事务中更新。球生成后无人领取而到期，预算不返还；否则可以靠不捡球恢复无限产量。

经验球容量不足不把已经分配的生者经验重算成更少。超出的球候选耗散。每个试点击杀最多4个正数球，且金额之和等于实际物化量；不生成0经验占位球。

---

## 10. P2：经验球领取事务与协议

### 10.1 客户端可提交的意图

以下为协议提案示例，不是当前协议已有消息。实体内容及生命状态从服务器会话读取。

```json
{
  "type": "deathWorldAction",
  "requestId": "client-generated-id",
  "action": "pickupOrb",
  "targetId": "orb-server-id"
}
```

允许动作按阶段开放：P1 `inspectGrave`，P2 `pickupOrb`，未来安抚若实际实现再注册。客户端不能发送 characterId/accountId、经验数、world坐标、deathCause、生成概率、倾向、fusionResult 或 awakenedActorId。

新增消息需与现有入站大小、频率、长度与未知字段政策相容；实际限制由 D00 读取当前 `ClientMessage::valid` 与网络层确定，不照历史计划硬抄。

### 10.2 领取的判定顺序

1. 由连接绑定角色，验证操作与字段；按 `(actor, operation, requestId)` 查回执。
2. 已有回执且指纹匹配：原样返回，无论球后来到期与否；不重复修改经验。相同 requestId 换目标／动作则拒绝。
3. 读取当前World：角色活着、同连续体与真实实例、合法距离／高度／空间、非受限驻留状态，目标是经验球。
4. Store单事务复核球仍可领取且未到期、来源账号排除与角色持久状态；以条件更新认领，受影响行数必须为1。
5. 使用事务内版本的经验与升级逻辑更新角色，写入回执，然后提交。
6. 提交成功才移除World球、刷新角色经验与播放吸收效果；提交失败不造成球丢失。

示意性条件更新如下；完整事务还包含身份、期限、指纹与经验更新，不可只粘贴这句SQL：

```sql
UPDATE experience_orbs
SET status = 'claimed', claimed_by_character_id = ?1, revision = revision + 1
WHERE orb_id = ?2
  AND status = 'available'
  AND expires_at_ms > ?3
  AND revision = ?4;
```

相同Tick两人拾取，由World接收与处理顺序决定，第一个成功提交者领取。为减少网络延迟优势可以后续加明确规则，但不能首版随机“双赢”。

### 10.3 错误与回执

| 错误 | 语义 | 对外提示方向 |
|---|---|---|
| `death_world_disabled` | 当前范围／阶段未开放 | 此处暂不允许该互动 |
| `target_missing` | 不存在或已离开该实例 | 痕迹已经不在这里 |
| `orb_expired` | 已到截止时间 | 这点余烬已经消散 |
| `orb_claimed` | 他人已成功领取 | 已被另一位冒险者拾取 |
| `orb_source_excluded` | 真实来源账号不合资格 | 这段残响留给了后来者 |
| `too_far` | 距离或空间关系不成立 | 请靠近可交互的位置 |
| `actor_dead` | 死亡角色尝试领取 | 复活后才能与它互动 |
| `request_conflict` | 相同请求号用于不同意图 | 本次操作标识已被使用 |
| `persistence` | 未完成持久提交 | 暂未保存，请稍后重试 |

永久裁决拒绝可记录回执；暂态数据库失败不记录为“已终结成功”。同一请求号的重试语义必须与既有客户端生成方式相容，修正目标要换新requestId。

---

## 11. P3：吞噬／融合的原子状态转移

### 11.1 输入计划

演化计划包含：内部operationId、类型、输入EchoId与预期revision、共同scope、触发证据、候选根集合、输出ID、输出状态与期限。服务器生成，客户端没有“让A吃B”的生产接口。

World先根据空间、前摇、偏向、凝聚度与区域预算判断；Store再验证关键持久前置，不能只相信构造计划时看到的旧版本。

### 11.2 原子提交

```text
查已存在operation回执 → 有则返回原结果
验证A、B仍有效、未过期、同scope、版本匹配且不是同一个对象
验证根来源不重复绕圈，合并后≤16
更新输入：
  吞噬：B进入consumed；A升级revision与状态
  融合：A、B进入fused；新C写入同一个事务
保留精确根引用；根预算不得复制或重置
写演化事实、输入版本、输出与回执
COMMIT → 删除旧投影／更新胜者／加入新投影
```

任何一个前置失败，所有写入回滚。数据库里不能同时保留“A已被吞噬”和“另一个流程又成功吞噬A”的两条有效终态。

### 11.3 守恒公式

```text
new_cohesion ≤ floor((cohesion_A + cohesion_B) * 8000 / 10000)
new_available_exp = 不同根预算的实际剩余之和（不新授权）
remaining_A = max(0, expires_A - now)
remaining_B = max(0, expires_B - now)
new_expiry = min(
  earliest_root_death + 6小时,
  now + floor((remaining_A + remaining_B) * 8000 / 10000)
)
```

非正寿命或无合法输出位置时不产生可行动新实体。刚产生的结果最早下一Tick参与动作，不能在同一Tick递归演化。吞噬也遵守相同根和寿命限制，不因为保留胜者ID而跳过预算限制。

记忆摘要可以挑选有限片段，来源图必须保留所有根关系。若输入本已共享根，应按异常状态拒绝并审计，不能把同一笔根预算加两次。

---

## 12. P4：觉醒历史人物与有限自主行为

### 12.1 先接真实历史主体，再做表现

实施时重新核对天命／NPC记忆相关模块是否已经落地。已存在则复用其 `story_actor_id`、事实与记忆事务；不存在时只实现本阶段必要的稳定身份、有限记忆与计划，不另写一个与天命未来身份冲突的NPC账号体系。[R16]

觉醒事务同时完成：验证虚影资格与版本 → 原虚影终态 `awakened` → 创建／绑定唯一历史主体 → 保存来源与有限记忆 → 保存名字、立场、初始位置与内容版本 → 写觉醒事实／回执。`source_echo_id` 必须唯一。

人物出现的网络实例可以在提交后重建；若提交后崩溃，恢复同一个 ActorId，而不是生成另一个相同名字的NPC。

### 12.2 记忆有知情边界

一条记忆至少能回答：哪个历史主体知道、记得谁、来自哪条事实、通过何种方式知道、是否属于可公开内容。原始来源经历与觉醒之后的亲身经历分开。

不能自动继承所有来源玩家的全部记忆，也不能把服务器能查询到的数据当作NPC知道的事实。新的立场由实际历史和有限规则改变，不让聊天文本直接修改阵营或天命资格。

### 12.3 有限自主性实现

首个NPC只需完成“持续目标 → 检查世界条件 → 选择有限动作 → 有合法结果 → 更新自己的记忆／计划”。例如旧路已经不需守护，则去已开放的新路见到同一旅人。无法导航时先做原地目标变化，不伪造跨地图旅行已完成。

大模型不是必须依赖。未来用于文本变体时，输入为授权摘要，输出只能选择审核过的表达；不得决定奖励、危险、迁移、物品、阵营或席位，模型服务不可成为50ms Tick的一部分。

### 12.4 觉醒不能成为经济洗白

觉醒不刷新根经验预算，不移除根账号排除，不把刚刚耗尽的虚影变成无限产经验的NPC。新增NPC战斗若以后需要独立经济规则，必须另有明确场景预算和原子结算；默认仍受本条谱系预算约束。

重要人物脱离普通虚影TTL，但进入明确的持久人物生命周期与容量约束。所有地图上无限常驻不是“永久历史”的必要条件。

---

## 13. P5：世界节点、记忆、天命与其它系统接口

### 13.1 事实而非模块相互乱调用

建议事实名称是本模块的设计词汇，不代表已存在的消息总线：`DeathRecorded`、`EchoProtectedPassage`、`EchoInterferenceObserved`、`EchoMerged`、`EchoAwakened`。每条都有稳定factId、scope、主体、客体、时刻、来源证据和策略版本。

已实现的适配器按明确事务边界消费；需要保证最终不漏处理时，使用本专题的小范围持久投递／消费记录，或直接与消费者同事务，不为了一个系统提前改造全世界消息平台。没有消费者时保留事实并标记“未接入”，不把它写成已产生NPC记忆。

### 13.2 适配契约

| 接口方向 | 输入 | 输出与必须保持的边界 |
|---|---|---|
| 世界节点 → 虚影 | 已生效的安全／通路／环境条件及版本 | 改变行为条件，不直接给无依据的善恶分数 |
| 虚影 → 节点事件 | 有来源的威胁拦截／通行事实 | 是否影响设施由节点自己的规则裁决，不能越权写桥完成状态 |
| 世界事实 → NPC记忆 | factId、合法观察者／转述链 | 消费一次；不广播私人关系 |
| 觉醒 → 天命候选 | ActorId、已提交事实引用、当前承担与边界 | 使用同一个候选模型；不能直接写正式席位 |
| 正式天命 → 主体能力 | 已裁决的资格／承担／退出 | 角色与NPC均受同套正式规则，无“来源玩家自动拥有” |
| 目击 → 冒险笔记 | 真实见闻，不是物品获得 | 单独原创见闻类型；不强行刷原版收集计数 |
| 重要世界事实 → 消息层 | 已提交、可公开、必要级别 | 普通死亡不全服广播，重复消费不重复跑马灯 |

### 13.3 正式竞争需要的事务

此项以**真正存在的天命核心**为前提。独占位置采用既有唯一键（世界连续体＋位置ID）和版本前置；资格检查、已公开挑战阶段、正式任命／移交、主体承诺、事实与回执必须处于同一可恢复裁决。

首版只争空缺或未正式承诺位置；挑战正式持有人另开任务，必须明确响应窗口、离线处理、失格依据与历史保留。NPC计时器不得绕过玩家可见阶段，在凌晨直接夺位。

天命尚未实现时，P4可以完成“独立NPC”，P5保持条件阻塞；不能为了交付表上打勾给NPC发一个名字带“天命”的Buff。

---

## 14. 前后端协议、表现、缓存与资源

### 14.1 快照提案

在既有快照中新增独立 `deathWorld` 区块，包含精简的墓碑、虚影、球状态。以下是字段契约表，不是现有类型。

| 视图 | 字段方向 | 不发送什么 |
|---|---|---|
| 公共包装 | worldEpoch、mapInstanceId、revision、serverTick | 数据库主键分布、账号信息 |
| 墓碑摘要 | id、x/y、appearanceRef、expiresInMs、epitaphAvailable | 完整原始行为流水、私聊 |
| 碑文详情 | 请求目标、模板参数、允许显示的角色名 | 登录名、源账号、隐藏概率、其它角色资料 |
| 虚影 | id、x/y、facing、动作／起始Tick、原型、阶段、可见风险、revision | 原玩家全套装备、技能、输入或账号关联 |
| 经验球 | id、x/y、正数amount、expiresInMs、可解释的可领取状态 | 根账号集合、内部反滥用规则 |
| 觉醒NPC | 沿NPC表现接入；历史身份关联只按需要授权公开 | 全部NPC私人记忆库 |

不能因为某人不合领取资格就为他制造一份不存在的球：同一个球是否存在和是否已领取是公共事实，“你不能拾取”的权限提示可以不同。

球经验、revision、Tick等数字跨Rust／SQLite／TypeScript边界时必须有显式上限，不能把u64默认当成JavaScript可无损表示的number。金额受SQLite整数与JS安全整数范围共同约束；确需超过时改成明确的十进制字符串协议，不静默截断或四舍五入。

快照结构会影响两端消息解析、机器人与版本握手。实现时以实际HEAD分配新协议／内容版本，不在任务卡永久写死“下一版一定是25”。本次唯一已证实的起点为协议24、内容tms273-31。[R12]

### 14.2 事件与快照各自负责什么

墓碑落下、吸收、融合等一次性演出使用eventId去重；事件漏收时，下一份快照仍能恢复当前事实，不要求重播已经发生十分钟前的落碑动画。

P1采用有界全量区块最容易正确：区块缺省／禁用表示明确清空，正常空数组表示当前没有对象。若以后增量推送，必须增加基线revision、删除记录与重新请求全量的规则；不能只加“created”消息而永远不删除实体。

重连／切图换epoch或实例时，清旧状态与事件去重窗口；缓存旧事件不能阻止新世界同一字符串ID正确显示。相同epoch内不接受回退revision，按现有连接握手与快照生命周期整合。

### 14.3 Phaser 接入

`client/src/scenes/world.ts` 只做死亡世界View的创建、快照投递、逐帧表现和clear/destroy；有限意图通过现有callback模式回到应用网络装配，不让View私自创建WS。[R13]

运动复用当前 `MotionInterpolator` 的约束；传送、融合换ID、消散、地图变更重置插值。伤害和拾取资格不以插值后图像位置作为权威。

短暂幽魂与长期虚影使用不同实例键和表现容器，不复用同一个 `PlayerView` 生死开关。测试必须包含“原玩家已复活，但墓碑与虚影仍在”和“原玩家离线后后来者首次入图”。

### 14.4 资源、缓存与降级

只缓存素材和内容定义；实时死亡状态与收益不写入浏览器长期存档。素材通过当前统一资源URL解析与发布内容版本加载，不自行添加绕开强制更新机制的缓存桶。[R13]

纹理按资源URL共享、帧按原时间轴处理。缺少非核心特效时可降级为明确的静态轮廓与危险边界；正式原作风格验收仍需真实素材来源，不能把开发占位图算作已完成美术。

危险轮廓与可交互提示必须在素材失败时仍然可知；否则宁可让服务器关闭该实例中的干涉作用，也不保留“看不见但能伤人”的实体。关闭作用应由明确的客户端就绪／服务器安全策略协调，不能让恶意客户端声称贴图失败获得永久免疫。

这一安全策略可先采用更简单的范围门禁：试点资源未验证可用前不启用有害交互，进入时固定安全宽限，传送／重连期间沿现有非交互状态处理；不新增可滥用的“我没加载好所以不受伤”开关。

---

## 15. 反滥用、隐私与容量

### 15.1 必须防守的路径

| 路径 | 防守 |
|---|---|
| 连续自杀抽稀有 | 同death只判一次；真实账号／区域窗口；有效经历；出生预算 |
| 换角色领取自己收益 | 后端解析真实账号归属，不把旧account_id列名当语义 |
| 融合洗来源 | 完整根集合≤16，精确保留与查询；超限拒绝，不截断 |
| 重启刷新虚影和预算 | 持久deadline与根预算；恢复读既存判定；试点生命保持ID |
| 小号／朋友协作刷 | 有限根预算、区域预算、无自动控制、普通掉落门槛；记录但不宣称彻底杜绝 |
| 虚影死亡链扩散 | P2不致命；未来虚影干涉致死仍默认不产生战斗虚影 |
| 幽魂远程侦察／拾取 | 死亡表现实例不可移动、无交互资格 |
| 碑文注入 | 模板白名单、长度限制、纯文本渲染、脱敏，不用innerHTML |
| 大量墓碑撑爆网络 | 展示聚合与详情分页；世界死亡主键不合并 |
| GM刷新刷收益 | 明确Administrative来源；调试创建默认无收益，不混入正式历史 |

不要首版为了反滥用新增设备指纹或广泛IP关联封禁。共享网络不是共享账号；未证实的作弊概率不得转成对玩家人格的判决。

### 15.2 初始复杂度与预算

设活跃试点地图数为 A，每图玩家 P、虚影 E≤8、可参与怪物 M、经验球 O≤64、墓碑展示组 G≤64。以地图内简单扫描实现，AI搜索约为 `O(A·E·(P+M))`；两两演化候选约为 `O(A·E²)`，每图最多28个无序虚影对；状态投影空间约为 `O(A·(E+O+G))`，另加数据库历史与在线角色。

这些上限**不限制玩家和怪物本身规模**，不能据此声称成本常数或必然满足50ms。先按既有地图分组和距离裁剪；出现实际瓶颈再引空间索引，不先造通用物理引擎。

AI决策目标频率建议5Hz，移动与动作仍按现有Tick；每图每次决策最多一个新演化事务。任何吞噬结果下Tick才继续活动，确保没有局部无限循环。

新增SQLite事务耗时、等待锁时间、Tick耗时及快照字节必须测量。既有Store是同步短事务模型；克隆Store后spawn任务仍可能竞争同一连接锁，不能把它当作已完成无阻塞优化。[R10][R16]

### 15.3 最小指标

`death_commits`、`death_commit_failures`、`echo_birth_decisions{reason}`、`echo_active`、`orb_minted_exp`、`orb_claimed_exp`、`orb_expired_exp`、`reward_dissipated_exp`、`reward_claim_conflicts`、`root_budget_remaining`、`evolution_conflicts`、`awakening_count`、`db_commit_ms`、`tick_ms`、`death_snapshot_bytes`。

指标标签使用有限原因枚举，不把角色ID、碑文或每个EchoId作为长期指标标签。个体追溯用受控结构化日志及数据库记录。

---

## 16. 验证矩阵

测试ID供任务卡引用；测试需要开发阶段真实实现后执行。本次没有运行仓库测试，也没有得到任何功能通过结论。

| ID | 场景 | 必须断言 |
|---|---|---|
| T01 | 同一致死候选重放 | 只一个death、trace、出生决定 |
| T02 | 致死事务任一点失败 | 无半个死亡、半个墓碑或已推进抽取窗口 |
| T03 | 提交后投影前崩溃 | 重启恢复既有事实，不再抽取 |
| T04 | 旧revive请求用于下一次死亡 | 返回stale，不复活新死亡 |
| T05 | 正常复活、离线、切图 | 墓碑与独立虚影仍按期限存在 |
| T06 | 复活最终存档失败 | 不虚报完整成功；无内存/存档分叉 |
| T07 | 悬崖／水／绳索／边界死亡 | 真实点与展示点分离，落点合法且不侵入保护区 |
| T08 | GM／练习／不允许地图死亡 | 不生成可收益虚影，原流程不退化 |
| T09 | 同账号换角色连续死亡 | 不能绕过抽取窗口 |
| T10 | 未允许的客户端字段／伪造目标 | 被边界校验拒绝，无越权操作 |
| T11 | 同一球两人竞争 | 仅一个经验提交，另一方明确失败 |
| T12 | 球领取请求重放／换目标 | 重放原结果；改指纹拒绝 |
| T13 | 死亡／远距／不同实例／源账号领取 | 均不增经验、不消耗球 |
| T14 | 领取事务失败与崩溃恢复 | 认领、升级、回执全有或全无 |
| T15 | 球到期／重启／成功后过期重放 | 不重生；成功回执可重放但不再付款 |
| T16 | 纯虚影击杀 | 无源玩家／队伍／物品收益，球预算准确 |
| T17 | 混合、过量伤害、多人余数 | 有效HP贡献和基础预算恒等式成立 |
| T18 | 技能／持续伤害／召唤最后一击 | 同生命只一次奖励，不能绕过路由 |
| T19 | 队伍／任务／图鉴 | 无虚影来源代领，未影响旧纯玩家分支 |
| T20 | 怪物已死后另一攻击重放／重启 | 不重复结算，重生期限和生命ID正确 |
| T21 | 根／区域预算、球容量耗尽 | 不超发，耗散有记录，没有0经验球 |
| T22 | 阴阳干涉防御／护盾／复活保护 | 共用伤害规则；P2非致命，不生成假死亡 |
| T23 | 隔层／隔墙／新入图干涉 | 空间合法、先预警、不加载即受伤 |
| T24 | 无活人地图与失焦驻留 | 不自动刷怪、产球或推进觉醒 |
| T25 | A同时与B/C演化 | A的同一版本最多成功一次 |
| T26 | 融合事务失败／提交后崩溃 | 不复制、不丢半个来源；恢复唯一输出 |
| T27 | 凝聚、预算、TTL、根数 | 守恒、上限、禁止同根重计 |
| T28 | 融合后来源玩家换角色拾取 | 仍被来源排除 |
| T29 | 同Echo重复觉醒 | 只有一个历史ActorId |
| T30 | 原玩家改名／换装／删角 | NPC不复制资产，隐私处理不破坏关键来源 |
| T31 | 无知情来源的NPC | 不凭空获得记忆 |
| T32 | 两个主体争同一正式位置 | 仅一个任命；未完成阶段不能越级夺位 |
| T33 | 场景clear／restart／重连／强制更新 | 无重复精灵、幽灵监听器和复活过期球 |
| T34 | 特效缺失／小屏／鼠标与触控入口 | 危险和必要交互仍可识别，不挡复活 |
| T35 | 旧库迁移／重复迁移／兼容回滚 | 资产及旧回执不变，世界行可读，不清库 |
| T36 | UTC回拨与策略热更新 | 不刷新期限、不重抽；严重异常停止有收益作用 |
| T37 | 有界高密度死亡 | 事实各自存在，显示分页聚合，内存网络受控 |
| T38 | 同一伤害来源ID跨实例伪造 | 不跨实例扣血／领奖／生成 |
| T39 | 先产球，后吞噬／融合／删角 | 旧球按生成时来源快照判资格；新球使用新谱系；根账号依据不丢失 |

推荐对 T17/T27 做纯函数性质测试：随机合法输入均满足守恒、不溢出、无负数；对 T02/T14/T26 使用临时数据库和真实失败注入，不能只检查mock被调用了几次。

---

## 17. 开关、上线、退场与回滚

### 17.1 阶段开关

配置至少区分 `enabled`、`scopeAllowlist`、`echoSpawn`、`echoCombat`、`orbRewards`、`evolution`、`awakening`、`destinyParticipation`。默认总开关关闭、范围空；只有在真实地图／资源引用通过校验后才能启用试点。

禁止组合例如：有害交互开但没有安全配置；正式天命开但没有真实裁决器；战斗有收益但持久Store缺席；在非试点怪物策略中开启虚影伤害。测试用无Store分支不得当生产落地路径。

### 17.2 关闭不是删除

关闭生成不影响已有墓碑按期存在；关闭战斗须取消未落地的虚影攻击与干涉；关闭奖励停止新球物化，但允许已有、合法、未到期球依原政策结算，或进入明确全范围维护状态而非悄悄吞掉它们。

关闭演化不逆转已经完成的吞噬。关闭天命参与不抹掉既有正式身份，已任命主体的处置遵循天命本身的退出／移交规则。

### 17.3 发布与验收边界

开发阶段只做实际改动需要的编译与定向自检，保留结果。用户在线服务、账户数据库、陪测机器人不因写文档或跑测试而重置；`启动3010.command` 属于会影响运行环境的操作，必须由实际发布流程授权执行。[R01][R02]

不把未运行的测试写成通过，不以旧报告代替这次改动的结果，不启动用户已取消的独立QA。本专题交付应列明代码已实现、离线已验证、用户实玩待验三个不同状态。

---

## 18. 给实现 Agent 的最终约束

先交付可验证的事务边界，再添加表现；先让一个虚影在一个合法区域做成一件事，再扩倾向；先保证一份经验不重复，再做更炫的球；先拥有稳定的NPC历史身份，再接天命。

不要删除用户核心需求以换取编译通过，也不要把未实现的远景伪装为已接入能力。完整路线保留到P5，但每一阶段都必须有自己的真实结果和明确未完成范围。

## 外部技术依据

- **[E01]** [SQLite Transaction](https://sqlite.org/lang_transaction.html)：事务、写入互斥、BEGIN与SAVEPOINT边界；本文据此约束同事务helper，不据此声称系统永不阻塞。
- **[E02]** [Atomic Commit In SQLite](https://sqlite.org/atomiccommit.html)：数据库原子提交的边界；网络交付与World内存恢复仍由本系统另外处理。

## 参考与证据

代码链接均固定在上述提交；历史设计文档只证明设计意图，不证明功能已落地。行号用于本次定位，实施时以符号与最新源码为准。

- **[R01]** [仓库工作入口](https://github.com/dragon717/MapleStory/blob/db3497168e5a6a17a73ab702a1151bdb77418763/AGENTS.md)：`AGENTS.md`。
- **[R02]** [长期业务规范](https://github.com/dragon717/MapleStory/blob/db3497168e5a6a17a73ab702a1151bdb77418763/docs/technical/BUSINESS_DEVELOPMENT.md)：`docs/technical/BUSINESS_DEVELOPMENT.md`。
- **[R03]** [当前唯一执行台账](https://github.com/dragon717/MapleStory/blob/db3497168e5a6a17a73ab702a1151bdb77418763/docs/plan/PLAN.md)：`docs/plan/PLAN.md`。
- **[R04]** [世界模块注册、50 ms Tick](https://github.com/dragon717/MapleStory/blob/db3497168e5a6a17a73ab702a1151bdb77418763/server/src/world.rs#L1-L160)：`server/src/world.rs`。
- **[R05]** [实际受伤与死亡提交入口](https://github.com/dragon717/MapleStory/blob/db3497168e5a6a17a73ab702a1151bdb77418763/server/src/monsters.rs#L689-L855)：`server/src/monsters.rs`。
- **[R06]** [复活请求与死亡代次绑定](https://github.com/dragon717/MapleStory/blob/db3497168e5a6a17a73ab702a1151bdb77418763/server/src/revive.rs)：`server/src/revive.rs`。
- **[R07]** [攻击认领；不是死亡规则模块](https://github.com/dragon717/MapleStory/blob/db3497168e5a6a17a73ab702a1151bdb77418763/server/src/combat.rs)：`server/src/combat.rs`。
- **[R08]** [击杀奖励、伤害贡献、队伍经验事务](https://github.com/dragon717/MapleStory/blob/db3497168e5a6a17a73ab702a1151bdb77418763/server/src/auth/loot.rs#L1-L245)：`server/src/auth/loot.rs`。
- **[R09]** [现有数据表与迁移入口](https://github.com/dragon717/MapleStory/blob/db3497168e5a6a17a73ab702a1151bdb77418763/server/src/auth/schema.rs#L1-L230)：`server/src/auth/schema.rs`。
- **[R10]** [Store 子模块、经验函数导出、失败注入](https://github.com/dragon717/MapleStory/blob/db3497168e5a6a17a73ab702a1151bdb77418763/server/src/auth.rs#L1-L150)：`server/src/auth.rs`。
- **[R11]** [物品世界与拾取去处，地面掉落不等于容器](https://github.com/dragon717/MapleStory/blob/db3497168e5a6a17a73ab702a1151bdb77418763/server/src/auth/item_world.rs#L1-L145)：`server/src/auth/item_world.rs`。
- **[R12]** [现行协议 24、内容 tms273-31 与状态类型](https://github.com/dragon717/MapleStory/blob/db3497168e5a6a17a73ab702a1151bdb77418763/shared/protocol.ts#L1-L200)：`shared/protocol.ts`。
- **[R13]** [Phaser 主世界、快照插值、切图生命周期](https://github.com/dragon717/MapleStory/blob/db3497168e5a6a17a73ab702a1151bdb77418763/client/src/scenes/world.ts#L1-L180)：`client/src/scenes/world.ts`。
- **[R14]** [当前前端依赖及检查命令](https://github.com/dragon717/MapleStory/blob/db3497168e5a6a17a73ab702a1151bdb77418763/client/package.json)：`client/package.json`。
- **[R15]** [已存在的风铃桥有限状态机](https://github.com/dragon717/MapleStory/blob/db3497168e5a6a17a73ab702a1151bdb77418763/server/src/windbell.rs#L1-L210)：`server/src/windbell.rs`。
- **[R16]** [天命历史专题方案：定义与状态，非实现证明](https://github.com/dragon717/MapleStory/blob/db3497168e5a6a17a73ab702a1151bdb77418763/docs/plan/topics/world-awareness/MapleStory_Destiny_Repository_Implementation_Plan_v0.2.md#L1-L285)：`docs/plan/topics/world-awareness/MapleStory_Destiny_Repository_Implementation_Plan_v0.2.md`。
- **[R17]** [风铃桥：公共事实、个人记忆与真实流动](https://github.com/dragon717/MapleStory/blob/db3497168e5a6a17a73ab702a1151bdb77418763/docs/plan/topics/world-awareness/%E4%B8%96%E7%95%8C%E8%8A%82%E7%82%B9%E6%9C%BA%E5%88%B6_%E9%A3%8E%E9%93%83%E6%A1%A5%E6%9C%80%E5%B0%8F%E9%97%AD%E7%8E%AF%E5%BC%80%E5%8F%91%E8%AE%A1%E5%88%92.md#L1-L110)：`docs/plan/topics/world-awareness/世界节点机制_风铃桥最小闭环开发计划.md`。
- **[R18]** [权威世界建模原则](https://github.com/dragon717/MapleStory/blob/db3497168e5a6a17a73ab702a1151bdb77418763/docs/technical/rust_authoritative_world_model.md#L1-L120)：`docs/technical/rust_authoritative_world_model.md`。
- **[R19]** [空地图的怪物重生处理](https://github.com/dragon717/MapleStory/blob/db3497168e5a6a17a73ab702a1151bdb77418763/server/src/monsters.rs#L1060-L1115)：`server/src/monsters.rs`。
