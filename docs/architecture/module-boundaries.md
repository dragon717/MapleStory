# 模块边界：允许与禁止的依赖方向

> 对应 `MapleStory_Large_File_Refactoring_Plan.md` §5.4、§14.2、§14.3。
> 记录日期：2026-09-12。规则**映射到本仓库的真实目录**，不是计划文里的示意目录。
> 检查方式：`scripts/refactor_audit.cjs --deps`（只读，产物 `artifacts/refactor/frontend-deps.json`）。

## 1. 真实目录（P0 实测，不是建议结构）

```
server/src/                          # 单一 crate，单进程
├── main.rs                          # axum 装配、静态资源服务、BIND_ADDR
├── network.rs                       # 网络适配（register/login/lobby/ws upgrade）
├── protocol.rs                      # Wire DTO + valid() 形状校验（契约面，churn 21/100）
├── world.rs            (23,992 行)  # 权威世界 + Tick 调度 + 全部玩法规则   ← 头号热点
│      └── #[path = "boss.rs"] mod boss;    # 既有先例：同目录兄弟模块 + impl World
├── auth.rs             (8,409 行)   # SQLite Store + 会话 + 四转/超技 SP 规则 + DTO
├── inventory.rs / npc.rs / mage.rs / combat.rs / lobby.rs / quest_text.rs / realmaps.rs
└── *_acceptance.rs                  # 经 include! 进入 world.rs 的 mod tests

client/src/
├── app/        main.ts(686) i18n.ts ui-router.ts style.css      # 装配与生命周期
├── network/    session.ts                                       # 连接与协议
├── assets/     manifest.ts(637)                                 # 资源索引与 URL 映射
├── scenes/     world.ts(781) layer-animation.* portal.check.*    # Phaser 场景层
└── features/   entry character chat combat hud inventory loading
                menu mob notice npc player quest skills ui world
                （每个 feature = view.ts + 可选 check.mjs + style.css）
```

## 2. 服务端边界

| 位置 | 可以依赖 | 不应依赖 / 不应执行 | 现状 |
| --- | --- | --- | --- |
| 纯规则（技能数值、任务判定、掉落表） | 领域值类型、显式配置、显式时间/随机输入 | `World`、网络、数据库、系统时钟、隐藏随机源 | **部分未达成**：技能公式与判定目前内联在 `impl World` 里 |
| 业务规则模块（`inventory.rs` / `mage.rs`） | 自身规则 + 稳定公共类型 | 其它业务的私有字段、具体复制协议 | 基本达成 |
| `world.rs`（运行时） | 用例、业务公开能力、调度与复制 | 数千行内联玩法分支 | **未达成**：这正是本轮重构对象 |
| `network.rs` / `main.rs`（适配与装配） | 内侧接口、DTO、具体 I/O | 绕过用例直接改权威资产与任务状态 | 达成（网络只投递 `Command`） |
| `protocol.rs` | 无（契约面） | — | 保持单文件，**不拆**（拆开会让 Rust ↔ `shared/protocol.ts` 同步成本上升） |

**Rust 子模块可见性说明**：本仓库既有先例 `#[path = "boss.rs"] mod boss;` 里第一个 `use super::*;`
就能访问 `world` 的私有项——因为 Rust 允许子模块访问祖先模块的私有项。
这**有利于过渡，但不构成业务隔离**（计划 §6.1）。因此搬迁后必须继续收窄参数与写权限，不能停在「导航改善」。

## 3. 客户端边界（实测）

`scripts/refactor_audit.cjs --deps` 当前结果：**81 节点 / 154 边 / 0 未解析 / 1 处循环 / 1 处越界**。

### 3.1 违规（1 处）

| 规则 | 边 | 为什么是问题 |
| --- | --- | --- |
| `network-session-not-imported-by-features` | `client/src/features/entry/view.ts` → `client/src/network/session.ts` | 功能面板直接依赖连接实现，则「表现层可独立销毁/重建」不成立；失败模式正是计划 §14「每次修改都重登」 |

### 3.2 循环（1 处）

```
client/src/assets/manifest.ts -> client/src/features/entry/appearance.ts -> client/src/assets/manifest.ts
```

`manifest.ts`（资源索引）反向依赖 `features/entry/appearance.ts`。资源层不应知道任何玩法/入口细节。
这是**既有循环**，登记在此；按计划 §14.2，不能因为一处旧循环就豁免整块目录的新循环。

### 3.3 规则清单（从现状推导，用于防回潮）

| 规则 | 含义 |
| --- | --- |
| `entry-app-not-imported-by-features` | `features/**` 不得 import `app/main.ts`（装配点） |
| `network-session-not-imported-by-features` | `features/**` 不得 import `network/session.ts`（当前 1 处违规） |
| `asset-manifest-not-imported-by-network` | `network/**` 不得 import `assets/**` |
| `scene-layer-not-imported-by-features` | `features/**` 不得 import `scenes/**` |

### 3.4 检查能力的诚实声明（计划 §14.2）

- 静态正则抽取 `import` / `export … from`；**动态 `import()` 与字符串拼接路径未覆盖**。
- **仅类型导入与运行期导入未区分**（计划要求分别报告）——这是当前工具的已知盲区。
- 解析只覆盖本仓库实际使用的**无别名相对导入**（0 处未解析，说明与现状吻合）。
- 运行期循环未测；本轮报告的是静态图循环。

## 4. 维护方式

```bash
node scripts/refactor_audit.cjs            # 两个产物一起
node scripts/refactor_audit.cjs --sizes    # 只看行数治理
node scripts/refactor_audit.cjs --deps     # 只看依赖与违规
```

新增依赖违规应当**能拦住**（计划 §14.4 的 P1 退出条件）。当前脚本已能列出违规，
尚未接入 CI 门禁——这是 P6 的待办，本轮不假装已完成。
