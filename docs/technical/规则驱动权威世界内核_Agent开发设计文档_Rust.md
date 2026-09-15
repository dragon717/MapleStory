# 规则驱动权威世界内核：Agent 开发设计文档（Rust）

> 目标：把“世界先于玩家、事实驱动、规则驱动、低控制耦合、可涌现”的设计哲学，落实为可维护、可扩展、可调试的 Rust 权威世界架构。
>
> 本文面向开发 Agent。实现时优先遵守这里的边界、数据流和不变量，不要为了局部方便把规则重新写回“系统互调 / 实体互调 / 大业务函数”。

---

# 1. 核心目标

我们不希望世界逻辑最终变成：

```text
FireSystem
  -> GrassSystem
      -> AirSystem
          -> PlayerMovementSystem
```

也不希望出现：

```rust
fn handle_hill_fire_and_player_fly(...) {
    // 点火
    // 烧草
    // 降湿度
    // 加热空气
    // 创建上升气流
    // 检查玩家装备
    // 让玩家飞起来
}
```

这种实现会迅速产生：

- 系统之间强控制耦合。
- 新增实体时需要给大量旧系统补特殊交互。
- 规则两两组合导致 `O(W²)` 级别的组合爆炸。
- Rule/Func 之间互相调用造成顺序依赖。
- 正反馈、回路和局部死循环难以控制。
- 单个业务函数不断膨胀。
- 世界只能按照程序员预先写好的路线运行，难以产生涌现。

我们要构建的世界模型是：

```text
Entity / Action
      ↓
Fact Change
      ↓
Rule Evaluation
      ↓
Delta
      ↓
Commit
      ↓
New Facts
      ↓
下一轮规则继续观察
```

核心原则：

> **实体不直接调用实体的业务逻辑。**

> **行为不直接调用后续行为。**

> **规则不直接调用规则。**

> **模块之间允许事实依赖，不允许控制依赖。**

---

# 2. 总体哲学

世界的因果链：

```text
世界事实 Facts
    ↓
世界规则 Rules
    ↓
实体状态 Entities
    ↓
系统运行 Systems
    ↓
交互 Interactions
    ↓
新事实 New Facts
    ↓
世界历史 History
    ↓
玩家体验 Experience
```

最重要的设计视角：

> 世界不是“Entity + Behavior”的集合。

而是：

> **Entity + Fact + Relation + Rule 构成的因果网络。**

行为只是实体对这个因果网络施加的一次扰动。

---

# 3. 不要按“Word × Word”写交互

错误模型：

```text
Fire × Grass  -> burn()
Fire × Water  -> evaporate()
Fire × Ice    -> melt()
Fire × Player -> damage()
Fire × Oil    -> ignite()
...
```

假设有 `W` 种 World Word，最坏交互数接近：

```text
W * (W - 1) / 2
```

复杂度接近：

```text
O(W²)
```

新增一个 Word，往往就要重新考虑它和所有旧 Word 的交互。

这条路不可扩展。

---

# 4. 正确模型：Word 只是事实的载体

世界规则不要直接认识：

- 草
- 木箱
- 布
- 稻草人
- 火球
- 龙息

规则认识的是更稳定的基础属性：

- Temperature
- Moisture
- Combustibility
- Fuel
- Oxygen
- Mass
- Velocity
- Conductivity
- CatchWindArea
- AirDensity
- VerticalAirVelocity
- Ownership
- Knowledge
- Trust

例如草：

```rust
pub struct CombustibleState {
    pub temperature: f32,
    pub moisture: f32,
    pub combustibility: f32,
    pub fuel: f32,
    pub ignition_temperature: f32,
}
```

木箱也可以使用同一组事实。

新加一个“稻草人”时，不需要增加：

```text
Fire × StrawMan
Water × StrawMan
Wind × StrawMan
...
```

只需要给它声明事实：

```rust
pub struct StrawManConfig {
    pub combustibility: f32,
    pub moisture: f32,
    pub mass: f32,
    pub catch_wind_area: f32,
}
```

已有规则自然生效。

---

# 5. 事实、行为、规则、Delta 的职责边界

## 5.1 Fact

Fact 表示：

> 世界现在是什么。

例如：

```rust
pub struct ThermalState {
    pub temperature: f32,
}

pub struct MoistureState {
    pub moisture: f32,
}

pub struct BurningState {
    pub intensity: f32,
}

pub struct AirState {
    pub temperature: f32,
    pub density: f32,
    pub vertical_velocity: f32,
}
```

## 5.2 Action

Action 表示：

> 某个实体试图对世界施加什么变化。

例如火球：

```rust
pub struct ApplyHeatAction {
    pub source: EntityId,
    pub target: EntityId,
    pub heat: f32,
}
```

Action 不应该自己判断：

- 目标是不是草。
- 草能不能燃烧。
- 有没有氧气。
- 会不会产生上升气流。
- 玩家是否能借风飞行。

它只表达：

> “这里输入了热量。”

## 5.3 Rule

Rule 表示：

> 当前事实意味着什么。

例如燃烧规则：

```rust
pub struct CombustionInput {
    pub temperature: f32,
    pub moisture: f32,
    pub combustibility: f32,
    pub fuel: f32,
    pub oxygen: f32,
    pub ignition_temperature: f32,
}

pub struct CombustionDelta {
    pub burning_delta: f32,
    pub heat_produced: f32,
    pub fuel_consumed: f32,
}

pub fn resolve_combustion(
    input: &CombustionInput,
    dt: f32,
) -> CombustionDelta {
    if input.fuel <= 0.0
        || input.combustibility <= 0.0
        || input.temperature < input.ignition_temperature
        || input.moisture >= 1.0
        || input.oxygen <= 0.0
    {
        return CombustionDelta {
            burning_delta: 0.0,
            heat_produced: 0.0,
            fuel_consumed: 0.0,
        };
    }

    let dryness = (1.0 - input.moisture).clamp(0.0, 1.0);
    let oxygen_factor = input.oxygen.clamp(0.0, 1.0);
    let burn_rate = input.combustibility * dryness * oxygen_factor;

    CombustionDelta {
        burning_delta: burn_rate * dt,
        heat_produced: burn_rate * 100.0 * dt,
        fuel_consumed: burn_rate * 0.1 * dt,
    }
}
```

注意：

`resolve_combustion()`：

- 只读输入。
- 不改世界。
- 不调用空气系统。
- 不调用玩家移动。
- 不调用其他 Rule。

## 5.4 Delta

Delta 表示：

> 这一轮规则计算后，世界应该发生哪些变化。

例如：

```rust
#[derive(Debug, Clone)]
pub enum WorldDelta {
    AddTemperature {
        entity: EntityId,
        amount: f32,
    },
    AddMoisture {
        entity: EntityId,
        amount: f32,
    },
    AddBurningIntensity {
        entity: EntityId,
        amount: f32,
    },
    AddFuel {
        entity: EntityId,
        amount: f32,
    },
    AddVerticalAirVelocity {
        field: FieldId,
        amount: f32,
    },
    AddForce {
        entity: EntityId,
        force: Vec3,
    },
}
```

规则只产生 `WorldDelta`。

真正修改世界，由统一的 Commit 阶段负责。

---

# 6. 为什么 Rule 不直接改世界

错误：

```rust
fn burn(world: &mut World, entity: EntityId) {
    world.temperature[entity] += 100.0;
    world.moisture[entity] -= 0.1;

    evaporate(world, entity);
    update_air(world, entity);
}
```

问题：

- 规则执行顺序影响结果。
- A Rule 调 B Rule，B Rule 又可能触发 A Rule。
- 很容易递归。
- 很难重放、回滚和测试。
- 多线程并行非常困难。

正确模型：

```text
World(t)
   ↓
Rule 统一读取当前快照
   ↓
生成 Delta
   ↓
DeltaBuffer
   ↓
统一 Commit
   ↓
World(t+1)
```

---

# 7. World Snapshot

规则应该尽量读取同一个逻辑时刻的世界状态。

```rust
pub struct WorldSnapshot<'a> {
    pub thermal: &'a ThermalStore,
    pub moisture: &'a MoistureStore,
    pub burning: &'a BurningStore,
    pub air: &'a AirFieldStore,
    pub material: &'a MaterialStore,
}
```

Rule 不应该拿到完整 `&mut World`。

原则：

> **规则可以观察世界，但不能在计算过程中随意修改世界。**

---

# 8. Delta Buffer

```rust
#[derive(Default)]
pub struct WorldDeltaBuffer {
    pub deltas: Vec<WorldDelta>,
}

impl WorldDeltaBuffer {
    pub fn push(&mut self, delta: WorldDelta) {
        self.deltas.push(delta);
    }

    pub fn clear(&mut self) {
        self.deltas.clear();
    }
}
```

后续可以升级：

- 按 Entity 分桶。
- 按 FactType 分桶。
- 合并同类 Delta。
- 冲突检测。
- 调试记录。
- 可回放日志。

---

# 9. Commit 阶段

```rust
pub fn commit_world_deltas(
    world: &mut World,
    buffer: &WorldDeltaBuffer,
) {
    for delta in &buffer.deltas {
        match *delta {
            WorldDelta::AddTemperature { entity, amount } => {
                world.thermal.add(entity, amount);
            }
            WorldDelta::AddMoisture { entity, amount } => {
                world.moisture.add(entity, amount);
            }
            WorldDelta::AddBurningIntensity { entity, amount } => {
                world.burning.add(entity, amount);
            }
            WorldDelta::AddFuel { entity, amount } => {
                world.fuel.add(entity, amount);
            }
            WorldDelta::AddVerticalAirVelocity { field, amount } => {
                world.air.add_vertical_velocity(field, amount);
            }
            WorldDelta::AddForce { entity, force } => {
                world.physics.add_force(entity, force);
            }
        }
    }
}
```

Commit 必须是受控边界。

不要允许业务 Rule 绕过 Commit 直接修改其他领域状态。

---

# 10. 山坡燃烧完整因果链

我们希望支持多种点火来源：

```text
火球
雷击
火把
熔岩
爆炸
自然雷暴
NPC 纵火
另一场山火蔓延
```

它们都不需要认识 Grass。

统一产生：

```text
Heat / ThermalEnergy
```

之后：

```text
Heat
 ↓
Temperature ↑
 ↓
达到燃点
 ↓
Burning ↑
 ↓
HeatOutput ↑
 ↓
Moisture ↓
 ↓
燃烧继续增强
 ↓
AirTemperature ↑
 ↓
AirDensity ↓
 ↓
VerticalAirVelocity ↑
 ↓
Updraft
 ↓
CatchWind + Updraft
 ↓
LiftForce
 ↓
玩家升空
```

---

# 11. Rust 示例：热量输入

```rust
pub struct HeatInput {
    pub target: EntityId,
    pub heat: f32,
}

pub fn resolve_heat_input(
    input: &HeatInput,
    buffer: &mut WorldDeltaBuffer,
) {
    buffer.push(WorldDelta::AddTemperature {
        entity: input.target,
        amount: input.heat,
    });
}
```

火球、雷击、熔岩都可以复用。

---

# 12. Rust 示例：蒸发规则

```rust
pub struct EvaporationInput {
    pub temperature: f32,
    pub moisture: f32,
}

pub struct EvaporationDelta {
    pub moisture_delta: f32,
}

pub fn resolve_evaporation(
    input: &EvaporationInput,
    dt: f32,
) -> EvaporationDelta {
    if input.temperature <= 30.0 || input.moisture <= 0.0 {
        return EvaporationDelta {
            moisture_delta: 0.0,
        };
    }

    let rate = ((input.temperature - 30.0) * 0.001).max(0.0);

    EvaporationDelta {
        moisture_delta: -(rate * dt).min(input.moisture),
    }
}
```

---

# 13. Rust 示例：空气升流规则

权威服务器不要做真实 CFD。

使用近似场：

```rust
pub struct AirField {
    pub center: Vec3,
    pub radius: f32,
    pub temperature: f32,
    pub density: f32,
    pub vertical_velocity: f32,
}
```

空气规则：

```rust
pub struct UpdraftInput {
    pub air_temperature: f32,
    pub ambient_temperature: f32,
    pub current_vertical_velocity: f32,
}

pub struct UpdraftDelta {
    pub vertical_velocity_delta: f32,
}

pub fn resolve_updraft(
    input: &UpdraftInput,
    dt: f32,
) -> UpdraftDelta {
    let temperature_diff =
        (input.air_temperature - input.ambient_temperature).max(0.0);

    let acceleration = temperature_diff * 0.02;

    UpdraftDelta {
        vertical_velocity_delta: acceleration * dt,
    }
}
```

---

# 14. Rust 示例：兜风 / 升力

玩家不需要知道：

> “这里曾经发生过山火。”

只需要满足：

```text
CatchWindArea > 0
AND
VerticalAirVelocity > 0
```

例如：

```rust
pub struct WindCatchState {
    pub catch_area: f32,
    pub lift_coefficient: f32,
    pub mass: f32,
}

pub struct LiftInput {
    pub vertical_air_velocity: f32,
    pub air_density: f32,
    pub catch: WindCatchState,
}

pub fn resolve_lift(input: &LiftInput) -> Vec3 {
    if input.catch.catch_area <= 0.0
        || input.vertical_air_velocity <= 0.0
    {
        return Vec3::ZERO;
    }

    let lift =
        0.5
        * input.air_density
        * input.vertical_air_velocity.powi(2)
        * input.catch.catch_area
        * input.catch.lift_coefficient;

    Vec3::new(0.0, lift, 0.0)
}
```

于是：

- 滑翔翼可以兜风。
- 风斗篷可以兜风。
- 风系法术可以制造类似效果。
- 热气球可以利用同一套规则。
- 龙扇翅膀产生上升气流时也能飞。
- 火山喷发产生气流时也能飞。

“飞行”不需要认识“山火”。

---

# 15. 关系模型

实体之间的关联不要只依赖函数调用。

建议至少支持以下关系：

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RelationType {
    Owns,
    Contains,
    BelongsTo,
    Near,
    ConnectedTo,
    TravelsOn,
    Knows,
    Trusts,
    HostileTo,
    Supplies,
    DependsOn,
}
```

关系：

```rust
pub struct Relation {
    pub from: EntityId,
    pub to: EntityId,
    pub relation_type: RelationType,
    pub strength: Option<f32>,
}
```

后续可用于：

- 所有权。
- 背包 / 仓库 / 邮件。
- NPC 知识传播。
- 商队路线。
- 村庄供给。
- 阵营关系。
- 信任与仇恨。
- 世界历史传播。

---

# 16. 世界交互词汇表

不要无限扩展 Word。

维护一套相对稳定的底层作用语言：

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FactType {
    Temperature,
    Moisture,
    Fuel,
    Oxygen,
    BurningIntensity,
    ElectricCharge,
    Light,
    Sound,
    Force,
    Velocity,
    Ownership,
    Visibility,
    Knowledge,
    Trust,
    ResourceAmount,
}
```

目标：

> 新增实体时，尽量只是给它增加已有 Fact，而不是增加几十个新交互函数。

---

# 17. Rule Index

规则总数可能很多。

错误：

```text
每个 Dirty Entity
×
扫描全部 Rule
```

假设：

```text
R = 1000
```

每次 FactChanged 都遍历 1000 条规则不可接受。

应该建立：

```text
FactType -> Rules
```

Rust 示例：

```rust
use std::collections::HashMap;

pub type RuleId = u32;

pub struct RuleIndex {
    by_fact: HashMap<FactType, Vec<RuleId>>,
}

impl RuleIndex {
    pub fn rules_for(
        &self,
        fact: FactType,
    ) -> &[RuleId] {
        self.by_fact
            .get(&fact)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }
}
```

例如：

```text
Temperature changed
  ↓
只找：
- CombustionRule
- EvaporationRule
- FreezeRule
- AirDensityRule
```

不是扫描所有规则。

---

# 18. Dirty Fact Queue

只计算发生变化的地方。

```rust
use std::collections::VecDeque;

pub struct DirtyFact {
    pub entity: EntityId,
    pub fact_type: FactType,
}

pub struct DirtyFactQueue {
    queue: VecDeque<DirtyFact>,
}
```

只有真正变化才入队。

关键约束：

```text
old_value == new_value
```

则不产生 `FactChanged`。

---

# 19. 处理死循环

必须区分：

## 19.1 合法反馈环

例如：

```text
Burning ↑
→ Heat ↑
→ Moisture ↓
→ Burning ↑
```

这是世界过程，不是 Bug。

正确方式：

> 让它跨 Tick 发生。

不要在单次函数调用中递归求解。

例如：

```text
Tick 1:
Burning = 0.30

Tick 2:
Burning = 0.37

Tick 3:
Burning = 0.45
```

## 19.2 非法程序循环

例如：

```text
A=true -> B=true
B=true -> A=true
```

如果 `A=true -> A=true` 仍继续产生事件，就会死循环。

必须实现以下约束：

1. **只有值真正变化才发 FactChanged。**
2. 同一轮中对 `Entity + FactType + Value` 去重。
3. 支持 `cause_id` / `chain_id`。
4. 设置单 Tick 最大传播轮数。
5. 连续量使用 epsilon。
6. 正反馈必须有时间、资源上限、阻尼或耗散。

---

# 20. 传播轮数

```rust
pub const MAX_PROPAGATION_ROUNDS: usize = 8;
```

主循环：

```rust
pub fn propagate_world(
    world: &mut World,
    rules: &RuleEngine,
) {
    for round in 0..MAX_PROPAGATION_ROUNDS {
        if world.dirty_facts.is_empty() {
            break;
        }

        let snapshot = world.snapshot();
        let mut delta_buffer = WorldDeltaBuffer::default();

        rules.evaluate(
            &snapshot,
            &mut world.dirty_facts,
            &mut delta_buffer,
        );

        if delta_buffer.deltas.is_empty() {
            break;
        }

        commit_world_deltas(world, &delta_buffer);

        if round + 1 == MAX_PROPAGATION_ROUNDS {
            tracing::warn!(
                "world propagation reached max rounds"
            );
        }
    }
}
```

注意：

合法持续过程优先跨 Tick。

单 Tick 多轮传播只用于有限、快速收敛的事实链。

---

# 21. Cause / Chain Tracking

建议：

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CauseId(pub u64);

#[derive(Debug, Clone)]
pub struct FactChange {
    pub entity: EntityId,
    pub fact_type: FactType,
    pub cause_id: CauseId,
}
```

用途：

- 调试“是谁点燃了这片森林”。
- 排查循环。
- 记录历史。
- 任务与成就归因。
- 战斗伤害归因。
- 玩家行为追踪。
- 未来重放。

---

# 22. 空间复杂度与时间复杂度

定义：

```text
N = 世界实体总数
A = 活跃实体数
B = 正在燃烧实体数
P = 附近玩家数
R = 规则总数
k = 一个 Fact 实际关联的规则数
d = 单实体平均局部邻居数
```

错误实现：

```text
O(N²R)
```

或者：

```text
O(AR)
```

目标：

通过：

- Spatial Index
- Active Set
- Dirty Fact Queue
- Rule Index

把 Tick 成本逼近：

```text
O(A * k)
```

`k` 应该是小常数。

近似：

```text
O(A)
```

世界越大，不应该线性增加每 Tick 的全部计算。

真正决定成本的是：

> 当前有多少事情正在发生。

---

# 23. 空间索引

局部物理与环境影响必须使用空间索引。

不要：

```rust
for a in all_entities {
    for b in all_entities {
        ...
    }
}
```

建议：

```rust
pub trait SpatialIndex {
    fn query_radius(
        &self,
        center: Vec3,
        radius: f32,
    ) -> Vec<EntityId>;
}
```

底层可以是：

- Uniform Grid
- Spatial Hash
- Quadtree
- BVH

第一阶段优先：

> Spatial Hash / Uniform Grid。

简单、稳定、适合 2D / 2.5D / Three.js 场景。

---

# 24. Active / Sleeping 分层

不要所有实体每 Tick 更新。

建议四档：

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SimulationTier {
    Static,
    Sleeping,
    Active,
    HighFrequency,
}
```

例如：

```text
Static:
- 石头
- 已稳定建筑

Sleeping:
- 远处 NPC
- 未变化植物

Active:
- 正在燃烧
- 正在移动
- 正在战斗
- 玩家附近生态

HighFrequency:
- 玩家
- 投射物
- 战斗碰撞
```

世界规模和模拟频率解耦。

---

# 25. 职责如何拆

不是：

```text
FireSystem
GrassSystem
PlayerSystem
```

而是按：

> **事实所有权 + 业务不变量**

拆。

例如：

```text
CombustionSolver
```

共同维护：

- Temperature
- Moisture
- Oxygen
- Fuel
- BurningIntensity

如果这些状态为了稳定性必须共同求解，可以放在同一个 Solver。

不要机械拆成：

```text
TemperatureRule
MoistureRule
OxygenRule
FuelRule
...
```

拆分原则：

> 哪些状态共同维护同一个不变量，就应该处于同一职责边界。

---

# 26. 因果链可以连接，代码职责必须分开

非常重要：

> **因果链不能为了“解耦”而切断。**

但：

> **代码模块必须避免控制耦合。**

允许：

```text
Combustion
→ Heat Fact

Air Solver
→ 观察 Heat Fact

Lift Solver
→ 观察 Updraft Fact
```

禁止：

```text
CombustionSystem
  -> call AirSystem
      -> call PlayerMovementSystem
```

---

# 27. 推荐模块结构

```text
server/
└── world/
    ├── entity/
    │   ├── mod.rs
    │   └── id.rs
    │
    ├── fact/
    │   ├── mod.rs
    │   ├── fact_type.rs
    │   ├── thermal.rs
    │   ├── moisture.rs
    │   ├── air.rs
    │   └── relation.rs
    │
    ├── action/
    │   ├── mod.rs
    │   ├── heat.rs
    │   └── force.rs
    │
    ├── rule/
    │   ├── mod.rs
    │   ├── combustion.rs
    │   ├── evaporation.rs
    │   ├── air.rs
    │   └── lift.rs
    │
    ├── solver/
    │   ├── mod.rs
    │   ├── combustion_solver.rs
    │   └── air_solver.rs
    │
    ├── delta/
    │   ├── mod.rs
    │   ├── world_delta.rs
    │   └── buffer.rs
    │
    ├── scheduler/
    │   ├── mod.rs
    │   └── world_scheduler.rs
    │
    ├── spatial/
    │   ├── mod.rs
    │   └── spatial_hash.rs
    │
    ├── history/
    │   ├── mod.rs
    │   └── cause.rs
    │
    └── world.rs
```

不要一次性全部实现。

按后面的阶段开发。

---

# 28. 第一阶段最小实现

只实现以下闭环：

```text
ApplyHeat
→ Temperature
→ Combustion
→ Burning
→ HeatOutput
```

验收：

1. 火球和雷击都能通过统一 Heat Action 点燃同一目标。
2. Combustion 不知道火球/雷击。
3. Rule 不直接改 World。
4. Rule 不互调。
5. 所有变化通过 Delta Commit。
6. 可测试。

---

# 29. 第二阶段

加入：

```text
Temperature
→ Evaporation
→ Moisture ↓
→ CombustionIntensity ↑
```

重点验证：

- 正反馈不会同 Tick 无限递归。
- 反馈跨 Tick 演化。
- 可以观测每 Tick 的状态变化。

---

# 30. 第三阶段

加入：

```text
Burning
→ Heat Field
→ AirTemperature
→ Updraft
```

不要 CFD。

使用局部场近似。

---

# 31. 第四阶段

加入：

```text
Updraft
+
CatchWind
→ Lift
```

至少支持两种不同来源：

```text
滑翔翼
风斗篷
```

保证 LiftRule 不认识山火。

---

# 32. 第五阶段

增加第二种上升气流来源：

```text
龙扇翅膀
或
风系法术
```

验收：

> 玩家不修改任何飞行逻辑，也能利用新的 Updraft 来源升空。

这一阶段是验证“涌现式复用”是否真正成立的关键。

---

# 33. Agent 实现禁令

Agent 不得为了快速完成功能写：

```rust
if fireball_hits_grass {
    grass.burn();
}
```

不得写：

```rust
combustion_system.update_air_system(...)
```

不得让：

```rust
RuleA::resolve()
```

调用：

```rust
RuleB::resolve()
```

不得在 Rule 内直接：

```rust
world.xxx = ...
```

不得把完整游戏世界塞进：

```rust
fn resolve(world: &mut World)
```

然后随意访问所有状态。

不得因为暂时方便把：

- 点火
- 燃烧
- 蒸发
- 空气
- 飞行

写进一个大函数。

---

# 34. Rule API 建议

第一版不要过度抽象。

可以先显式函数：

```rust
pub fn resolve_combustion(
    input: &CombustionInput,
    dt: f32,
) -> CombustionDelta;
```

而不是一开始就设计超通用动态规则语言。

等稳定以后再考虑：

```rust
pub trait Rule {
    type Input;
    type Output;

    fn resolve(
        &self,
        input: &Self::Input,
        dt: f32,
    ) -> Self::Output;
}
```

第一阶段原则：

> 可读性 > 抽象程度。

---

# 35. 可测试性

每条 Rule 必须能脱离 World 单测。

例如：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dry_hot_material_should_burn() {
        let input = CombustionInput {
            temperature: 300.0,
            moisture: 0.1,
            combustibility: 0.9,
            fuel: 10.0,
            oxygen: 1.0,
            ignition_temperature: 200.0,
        };

        let delta = resolve_combustion(&input, 0.1);

        assert!(delta.burning_delta > 0.0);
        assert!(delta.heat_produced > 0.0);
        assert!(delta.fuel_consumed > 0.0);
    }

    #[test]
    fn wet_material_should_not_burn() {
        let input = CombustionInput {
            temperature: 300.0,
            moisture: 1.0,
            combustibility: 0.9,
            fuel: 10.0,
            oxygen: 1.0,
            ignition_temperature: 200.0,
        };

        let delta = resolve_combustion(&input, 0.1);

        assert_eq!(delta.burning_delta, 0.0);
    }
}
```

---

# 36. 调试能力

规则世界一旦复杂，必须从第一天保留因果链。

至少能输出：

```text
Player#17
  ↓ Cast Fireball

HeatAction#981
  ↓ +300 Temperature

Entity#Grass1024
  ↓ Temperature 40 -> 340

CombustionRule
  ↓ Burning 0 -> 0.63

HeatOutput
  ↓ AirField#33 Temperature +18

UpdraftRule
  ↓ VerticalVelocity +2.4

LiftRule
  ↓ Player#17 ForceY +160
```

未来建议支持：

```rust
pub struct CausalTrace {
    pub cause_id: CauseId,
    pub parent: Option<CauseId>,
    pub source: TraceSource,
    pub description: String,
}
```

没有这种能力，后期世界规则调试会非常困难。

---

# 37. 世界历史

当规则运行足够久后：

```text
Rule
→ Event
→ History
→ Memory
→ Culture
```

第一阶段不要求实现完整历史系统。

但 `CauseId / EventLog` 的设计不要堵死未来：

- 谁造成火灾。
- 火灾持续多久。
- 哪些区域被烧毁。
- 哪些玩家参与救火。
- 哪条贸易路线被影响。

未来都可能成为：

- NPC 对话。
- 世界公告。
- 成就。
- 任务生成。
- 经济变化。
- 地区历史。

---

# 38. 最终原则

开发过程中始终检查：

### 1. 这是 Fact 还是 Func？

优先把持续状态表达为 Fact。

### 2. 这个 Rule 是否知道了不该知道的对象？

例如燃烧规则不应知道：

- 火球。
- 玩家。
- 滑翔翼。
- 任务。

### 3. 这个模块是在“产生事实”，还是在“控制下一个模块”？

如果在控制下一个模块，通常说明耦合过重。

### 4. 新增一个实体时，需要修改多少旧代码？

理想状态：

> 大多数时候只声明新的事实/属性组合。

### 5. 一个新规则是否能自然作用于已有实体？

如果可以，说明世界语言在复用。

### 6. 一个新实体是否能自然被已有规则作用？

如果可以，说明模型是开放的。

---

# 39. 一句话总纲

> **实体不与实体直接写业务交互；实体通过事实影响世界。行为改变事实，规则读取事实并产生 Delta，Delta 统一 Commit 成为新事实。规则之间不直接调用，让因果通过世界状态自然传播。**

进一步：

> **世界在设计上高度关联，在代码上保持低控制耦合。**

最终目标不是实现一个“山坡燃烧后玩家飞起来”的功能。

而是构建一套世界，使得：

```text
只要存在足够强的上升气流
+
玩家拥有能够兜住气流的装备或法术
```

玩家就自然能够飞起来。

至于这个气流来自：

- 山火
- 火山
- 龙翼
- 风魔法
- 地热
- 特殊机械

世界不需要提前知道。

这才是规则驱动权威世界的意义。
