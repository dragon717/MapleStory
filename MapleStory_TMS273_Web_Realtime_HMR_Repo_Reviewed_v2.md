# 冒险岛 TMS273：源码开发、实时渲染与热更新改造计划 v2

> 编写日期：2026-09-12  
> 仓库：`dragon717/MapleStory`，默认分支 `main`。  
> 本次源码基线：`1fefe97c2d27a928f3bf670b657d79f68d795fe9`；提交时间 `2026-09-12T04:29:55Z`。  
> 当前已核实技术栈：TypeScript / JavaScript、Vite 7、Phaser 3.90.0、原生 DOM / CSS、Rust / Axum / WebSocket。  
> 目标：先建立可靠的源码开发反馈链，再实现选择性 HMR，并分阶段接入 Three.js。  
> 统一操作入口：保留根目录 `启动3010.command`；不建立第二套独立启动体系。  
> 状态：**基于仓库源码和官方文档的实施计划，不是已完成的改造或运行验收报告。** [R00]

## 0. 执行摘要

**当前问题不是“游戏还不能实时渲染”，而是“正在访问上一次构建的客户端，没有使用已经存在的源码开发入口”。**

源码证据已经足够明确：`client/index.html` 加载 `/src/app/main.ts`；入口创建 `Phaser.Game`；Vite 已配置 `public-tms273` 和 `/api`、`/ws` 代理；但 `启动3010.command` 每次都构建客户端，然后让 Rust 从 `client/dist-tms273` 提供页面。因此，已经启动后再改源码，不会自动修改正在提供的构建产物。[R01][R02][R03][R04][R05][R18]

本计划选择：

| 决策 | 本次方案 | 不采用的做法 |
| --- | --- | --- |
| 日常开发 | 统一脚本管理 Vite，浏览器访问固定 `5173` 源码页 | 一直打开 `3010` 的旧构建页验证源码 |
| Rust 与机器人 | 首阶段保留现有 `3010`，优先识别并复用兼容实例 | 为开启 HMR 先迁移端口、重启世界和机器人 |
| 自动更新 | CSS 局部更新；普通 TS 先允许整页刷新；高频表现逐步保状态替换 | 承诺所有改动都不断线、无损更新 |
| Three.js | 作为真实的后续渲染接入任务，有可切换适配器和验收门槛 | 把现有 Phaser 代码改个名字就称为 Three.js，或一次性重写全部玩法 |
| 资源来源 | 开发直接读 `public-tms273`；构建产物是一次生成的快照 | 开发 `/assets` 代理到优先读旧 dist 的 Rust；手工长期维护两份 manifest |
| 验证政策 | 必要的编译、离线定向检查；运行表现交用户验收 | 自动启动独立 QA、清库、反复重启用户服务 |

**第一轮只交付 P1：双击统一脚本进入正确源码页，改一处真实 UI 后自动生效，不执行前端全量构建，不重启已经兼容的 Rust。**

Three.js 属于明确安排的后续阶段，不是第一轮热更新的前置条件；也不因此从目标中删除。

### 0.1 一个必须先说明的操作风险

**本文中的 `dev`、`status`、`stop dev`、`build`、`preview` 等都是待实现的脚本接口，不是当前可用命令。**

当前 `启动3010.command` 没有参数分派。现在执行 `./启动3010.command status`，并不会只查状态，仍会沿旧逻辑构建和重启。实施者必须先加入参数解析与未知参数拒绝，再接入各模式；不能在旧脚本上试跑本文的拟议子命令。[R01]

### 0.2 本计划的边界

已完成：远程源码核对、与仓库已有 P0 取证对照、官方资料核验、文件级任务设计。

未完成：修改仓库代码、安装项目依赖、成功构建项目、启动 Vite、实测浏览器 HMR、验证用户本机运行状态。没有提交或推送本计划到仓库，没有重启服务或操作数据库、机器人。

仓库忽略了 `client/public-tms273/`、`client/dist-tms273/`、`resources/`、`参考/`、运行数据库和凭据。**能读到源码不等于已经取得完整可运行资源包。** 后续在用户现有完整工作区验证，不把缺失资源的源码副本当作完整环境。[R15]

---

## 1. 仓库现状：以实现为准，而不是沿用首版假设

### 1.1 已核实文件与事实

| 文件 / 位置 | 核实结果 | 对改造的影响 |
| --- | --- | --- |
| `client/package.json` | `dev` 是 Vite；`build` 已含 `tsc --noEmit`；依赖 Phaser `3.90.0`，没有 Three.js | 不新建空项目，不重复补一个已经存在的类型检查命令 |
| `client/package-lock.json` | npm 锁文件；Vite 在 package 声明中为 `^7.3.1` | 使用现有锁文件；范围声明不能冒充实际安装版本 |
| `client/index.html` | `/src/app/main.ts` 是真实入口 | 不是 `client/src/main.ts`，也不是实验客户端 |
| `client/vite.config.ts` | `publicDir: 'public-tms273'`；`outDir: 'dist-tms273'`；已有 API / WS 代理 | 主要补启动治理、固定端口、来源标识 |
| `client/src/app/main.ts` | 组装 DOM UI、创建 `Phaser.Game`、创建连接、管理退出与页面生命周期 | 不能直接给整个入口加无条件 self-accept |
| `client/src/scenes/world.ts` | `World extends Phaser.Scene`；持有快照、角色与怪物表现、地图切换和水面 | 场景热替换要处理状态和生命周期，不能只调用 `scene.restart()` |
| `client/src/network/session.ts` | WS 使用 `location.host`；含退避重连与终止码 | 保留同源代理；先修连接生命周期缺陷 |
| `client/src/assets/manifest.ts` | 运行时 fetch manifest，再 fetch appearance | JSON 和纹理是运行时资源，不是普通 TS 模块 HMR |
| `server/src/main.rs` | Rust 磁盘静态服务 + API / WS；配置在启动时加载 | 前端源码改动不要求 Rust 重编译；权威配置改动另行处理 |
| `启动3010.command` / `关闭3010.command` | 管理 Rust、bot、数据库路径和 3010 身份 | 不能把迁端口当作无影响的小改动 |
| `scripts/assemble_tms273.cjs` | 从导出资源装配到 public，并写 shared 数据 | 当前这份装配脚本没有直接写 dist |
| `docs/dev/current-entry-audit.md` | 已有静态 P0 取证，并明确未启动验证 | 更新该文件中的过时判断，不新建重复台账 |

来源：[R01]–[R16]。源码快照与本机已启动二进制的版本可能不同；本表不证明在线实例已经包含这些代码。

### 1.2 当前实际链路

```text
双击 启动3010.command
  ├─ 校验 Node、配置、资源
  ├─ check_tms273_runtime.cjs
  ├─ cargo build
  ├─ client: tsc --noEmit && vite build
  ├─ 关闭旧 Rust / bot
  └─ 启动 Rust 3010，连接陪测 bot
          │
          ├─ /api/...  → Rust
          ├─ /ws      → 权威世界
          ├─ /assets  → dist-tms273/assets 优先，public 兜底
          └─ 页面      → client/dist-tms273/index.html

另一个已经存在、但未纳入统一脚本的能力：
  client 中的 Vite dev → 源码 HTML / TS / CSS
                     → /api、/ws 代理到 Rust 3010
```

以上来自启动脚本、Vite 配置和 Rust 路由，而不是浏览器运行实测。[R01][R03][R04]

### 1.3 相对首版与现有 P0 的修正

**修正 A：当前主渲染器是 Phaser，而非 Three.js。** 水面文件的注释也明确说明，原设计示例涉及 Three.js / Rapier，但本仓库只移植了表现模拟核心，实际通过 Phaser 绘制。[R02][R11]

**修正 B：开启源码开发不必先移动 Rust。** 现有代理已指向 3010；脚本和机器人也强绑定 3010。首轮保留后端端口、使用 5173 源码入口，比把 Vite 放到 3010 再搬走 Rust 的修改面更小。这是基于现状作出的工程选择，不是 Vite 对端口的强制要求。[R01][R03][R08]

**修正 C：不能把两份 manifest 都当编辑源。** 当前 `assemble_tms273.cjs` 的实际写入目标是 `public-tms273` 和 `shared`，没有向 dist 写入。dist 中的资源由 Vite 构建复制形成。应修正 P0 文档中“装配同时写两份、必须同源重写两份”的表述；若其他历史脚本仍直接写 dist，再单独定位迁移，不凭空删除当前装配器不存在的代码。[R12][R13][W04]

**修正 D：服务进程没停止，不代表页面资源没被影响。** 当前脚本在停止旧服务之前执行 build，而 `emptyOutDir: true` 会作用于正在提供的 dist。未来需要隔离构建输出；不能仅保留“构建失败不杀旧进程”，就宣称整个旧版本完全不受影响。[R01][R03]

---

## 2. “实时”拆成四项能力

| 能力 | 成功标准 | 本项目处理方式 |
| --- | --- | --- |
| 源码自动生效 | 保存源码后，浏览器运行新代码 | 复用 Vite 开发服务器 |
| 局部 HMR | 改 UI / 视觉实现，尽量保留会话与状态 | 应用自己建立接收边界与资源释放规则 |
| 游戏实时渲染 | 人物、地图、特效按帧连续更新 | 保留 Phaser 现状，逐步加入 Three.js 渲染适配器 |
| 权威世界同步 | 服务器事实持续更新并能恢复连接 | 继续 Rust 权威模拟与现有 WS 协议 |

静态构建交付与游戏运行时持续渲染并不矛盾。Vite 本身就区分开发服务和生产静态资源构建；因此，本任务不需要 SSR、后端模板引擎或“动态 HTML”改造。[W01]

### 2.1 常见方案比较

| 方案 | 用途 | 本项目决定 |
| --- | --- | --- |
| 手动 build + 浏览器刷新 | 发布验收 | 保留，不作为开发主路径 |
| build watch + 自动刷新 | 不能使用源码服务器的旧工程过渡 | 不选；已有 Vite 开发链，无需继续反复生成 dist |
| Vite 源码服务 + 必要时整页刷新 | 尽快让修改真实可见 | P1 默认路线 |
| Vite + 选择性状态保留 HMR | 高频 UI、视觉模块 | P2 逐个接入 |
| Rust 转发整个前端和 HMR | 必须维持浏览器端口不变时 | 条件方案，不在首轮增加 Rust 代理复杂度 |
| Three.js 替代或补充 Phaser | 有明确渲染目标时 | R1–R3 独立推进，不冒充热更新必需品 |

---

## 3. 目标拓扑：一个启动入口，不强求所有职责共用一个端口

### 3.1 首阶段采用的开发拓扑

```text
                 启动3010.command（统一管理）
                         │
              ┌──────────┴───────────┐
              │                      │
      Vite：127.0.0.1:5173      Rust：现有 3010
      开发浏览器的唯一入口        保留权威世界、DB、bot
              │                      ▲
              ├─ /api/... ───────────┤
              ├─ /ws ────────────────┘
              ├─ /@vite/client → Vite HMR
              ├─ /src/...      → client 源码
              └─ /assets/...   → public-tms273/assets

      3010 原有构建页仍是构建页，不再用于验收刚改的源码。
```

Vite 提供严格端口和 HTTP / WebSocket 代理能力；本项目在已有代理上补固定端口即可。浏览器中的业务请求继续同源，不把 `http://127.0.0.1:3010` 散落进各个 UI 模块。[W02][R03][R07]

### 3.2 路由边界

| 请求 | 开发时来源 | 必须防止的问题 |
| --- | --- | --- |
| `/` | `client/index.html` 经 Vite 处理 | 打开旧 Rust 构建页 |
| `/src/...`、`/@vite/client` | Vite | 返回构建版 HTML 冒充 JS |
| `/api/...` | 代理到 Rust 3010 | SPA fallback 吃掉 API 错误 |
| `/ws` | 代理到 Rust 3010 | 业务 WS 和 HMR WS 混为一谈 |
| `/assets/manifest.json` | 当前 public 资源 | 被 dist 同名旧文件覆盖 |
| `/assets/entry/appearance.json` | 当前 public 资源 | 与 manifest 来自不同资源修订 |
| 图片、音频等 | 当前 public 资源 | 只改磁盘但客户端缓存仍持有旧纹理 |

**开发配置不要增加 `/assets → Rust` 代理。** 当前 Rust 的目录优先级会让它优先返回 dist 中同名资源，正好重新引入本次要消除的旧产物问题。[R04]

### 3.3 什么时候才考虑浏览器也必须是 3010

只有出现明确的端口硬约束，才评估下面其中一种方案：Vite 占用 3010、Rust 使用内部端口；或者 Rust 保留 3010 并完整代理 Vite。

届时必须一起更新 server / bot 的 PID 校验、健康地址、WS 转发、来源限制、日志与回滚步骤。不能只改 `vite.config.ts` 的端口。本计划没有把这个选择作为 P1 的必做项。

### 3.4 首次切换入口的会话说明

3010 与 5173 是不同 origin，`localStorage` 等本地存储不会因为后端相同就自动共用。[W10] 第一次进入源码页可能需要重新登录 / 选择角色；这不意味着服务器账号数据丢失。本次没有验证现有入口的自动会话恢复，不承诺无感跨端口迁移，也不新增跨 origin 自动复制 token 的机制。

同一角色从旧构建页和新源码页同时连接，可能触发现有会话替换策略。切换时避免让两个页面争用同一角色；多客户端验收使用用户明确允许的不同账号。不要通过删除 `session_replaced` 终止保护解决这个问题。[R07]

---

## 4. P1：让源码开发成为统一脚本的正常路径

### 4.1 先落地模式契约，再改变默认行为

下表是**拟实现接口**。在模式解析完成之前，不运行这些示例。

| 接口 | 改造后的行为 | 是否允许影响现有 Rust / bot |
| --- | --- | --- |
| 无参数 / `dev` | 检查并复用兼容 Rust；管理 Vite；打开 5173 源码页 | 不自动重启已有实例 |
| `status` | 输出模式、端口、实例身份、资源与版本状态 | 只读，不构建，不启停 |
| `stop dev` | 仅停止本入口管理的 Vite | 不停止附着的 Rust / bot |
| `build` | 类型检查并构建到隔离的候选目录 | 不覆盖正在服务的目录，不启停 |
| `preview` | 查看已选择的构建版本；不隐式重新构建 | 默认复用兼容后端；需要切换实例时先报告 |
| `restart server` | 明确要求重建 / 切换 Rust 的操作 | 仅在用户明确执行该操作时发生 |
| `stop all` | 停本入口确认拥有的 Vite、Rust、bot | 是；这是显式停止操作 |
| 未知命令 | 用法说明、非零退出 | 不能落入旧的默认重启分支 |

`关闭3010.command` 保留为显式“关闭本项目整套实例”的兼容入口；内部复用同一套身份判断，不复制一份容易漂移的判断规则。

P1 可以先实现 dev / status / stop 的必要子集。尚未实现的 build、preview 或 restart 分支必须明确返回“未实现”，不能转入旧的构建重启逻辑。P3 补齐候选构建与严格预览后再开放对应接口。

双击变为 dev 是本计划建议的新默认值，实施时同步文档和提示；**本次只制定计划，没有替用户执行默认切换或服务重启。**

### 4.2 `dev` 的启动流程

1. 解析参数，确认仓库根目录；路径按 UTF-8 处理，并始终正确引用包含空格的中文路径。
2. 检查对应模式需要的 Node、依赖和最小资源。`status` 不依赖 Cargo；复用后端的 dev 不先无条件 cargo build。
3. 检查 3010 的进程身份及必要健康信息。兼容本项目实例可附着；陌生进程、无法确认身份或版本不兼容时，停止后续启动并报告，不自动杀进程。
4. 若没有后端实例，只有在确认不存在同库的其他权威实例后，才启动一份。缺资源时明确报错，不清库、不生成假内容绕过校验。
5. 检查 5173 是否是本项目已管理的 Vite。正确实例复用；外部占用直接失败，不换成 5174，更不按端口盲杀。
6. 启动 Vite，等待开发身份信息与源码入口就绪。不能仅判断“端口能连接”。
7. 输出并打开 5173；打印 3010 是后端 / 旧构建入口的区别。
8. 复用已有 bot。前端代码保存、Vite 重连和重复启动 dev 均不重复创建 bot 或账号。

已有脚本的 PID、命令、cwd 检查和凭据缺失时不新建账号的保护应保留。[R01][R08]

### 4.3 进程所有权与故障处理

继续使用 `evidence/runtime/3010-control/`，在现有 server / bot 信息之外增加 `vite.pid`、`vite.log` 和实例描述；这些运行态文件继续不入 Git。[R01][R15]

实例描述至少区分：`owned`（本次启动拥有）与 `attached`（仅附着已有实例），并记录角色、PID、进程启动时间、工作区标识、监听地址、启动模式。PID 被复用时不能只凭 PID 文件操作进程。

启动失败只撤销本次新建且确认属于本次的子进程；不停止附着的服务。并发双击需有启动锁或等价互斥；退出失败时保留诊断信息，不能删除控制记录后假报停止成功。沿用有界等待、温和退出、不默认强杀。

### 4.4 Vite 的最小配置修改

保留现有 `define`、`publicDir`、`build`，仅调整开发部分。下面是需要合并进现有配置的示意，**不是已经验证的完整替换文件**：

```ts
// client/vite.config.ts 中的 server 配置片段。
// 同时把 package.json 的 dev 从 "vite --host 0.0.0.0" 改为 "vite"，
// 否则 CLI 的 host 参数仍会覆盖这里的本地默认设置。
server: {
  host: '127.0.0.1',
  port: 5173,
  strictPort: true,
  proxy: {
    '/api': { target: 'http://127.0.0.1:3010' },
    '/ws': { target: 'ws://127.0.0.1:3010', ws: true },
  },
},
```

本地固定端口是首轮默认值，避免一开始引入大量环境变量。如果后续需要可配置端口，由启动入口统一解析、验证并传入 Vite；前端业务仍使用相对 URL。

依赖 `../shared` 的导入需要验证可访问范围。必要时 `server.fs.allow` 仅明确允许 `client` 和实际需要的 `shared`，不要为解决一次导入错误而开放整个用户目录或关闭 `fs.strict`。开发服务默认仅本机访问；局域网模式显式开启，不设置 `allowedHosts: true` 或宽泛 CORS。[W02]

新增 `client/src/vite-env.d.ts` 声明 Vite 客户端类型，供后续 `import.meta.env` / `import.meta.hot` 使用。保留现有 `tsconfig.json` 的严格检查和对冲突副本的既有处理，不借机删除文件。[R16][W03]

### 4.5 Node 与依赖版本

仓库目前只检查 Node 主版本不小于 22；这不能排除不满足 Vite 7 要求的早期 Node 22。Vite 7 官方给出的 Node 兼容下限包含 22.12。[R01][W01]

实施时记录实际可用的 Node 完整版本，使用兼容且维护中的版本，不能把“22.12 是兼容下限”理解成必须安装该旧补丁。与现有实验性 TS 执行参数一并定向核对。依赖使用 npm 锁文件，不在 HMR 改造中顺便升级 Vite、Phaser 和 TypeScript 的大版本。[R02]

### 4.6 页面与日志必须显示“到底运行哪份代码”

复用已有 release badge；不要再造一套挡住游戏的调试 UI。拟增加：

| 字段 | 含义 | 不允许的替代 |
| --- | --- | --- |
| `codeMode` | `DEV_SOURCE` / `BUILT_PACKAGE` | 用端口号猜模式 |
| `frontendInstanceId` | 本次 Vite 启动或静态宿主实例 | 用页面加载时间冒充构建版本 |
| `buildId` | 构建时固定的代码 / 依赖 / 配置指纹 | 只写 package 版本号 |
| `sourceRevision` | 开发源码修订标识，区分未提交修改 | 只写 Git HEAD 就声称最新源码已应用 |
| `lastAppliedUpdate` | 已成功应用的 HMR 更新序号 / 时刻 | 文件刚保存但编译失败也显示成功 |
| `assetRevision` | 本次已装载的资源修订 | 把 contentVersion 当作每张图片的内容哈希 |
| 后端状态 | 协议 / 内容版本；未来增加真实构建标识 | 用当前源码 SHA 冒充正在运行的二进制 SHA |

现有 `__RELEASE_TIME__` 是配置求值时生成的时间，开发运行中不能证明每次源码变动已生效。现有健康接口也只有 `ok`、协议和内容版本，旧实例的构建身份应显示“未提供”，而不是猜测。[R03][R04]

---

## 5. P2：从自动刷新升级到可控 HMR

### 5.1 先固定更新等级

| 修改类型 | 初期行为 | 后续可升级能力 |
| --- | --- | --- |
| CSS | 原位更新 | 保留，不重建游戏 |
| 一般 TS / JS | 没有安全接收边界时整页刷新 | 逐个模块建立边界 |
| HUD 等 DOM 表现 | 首先允许刷新 | 只重建目标 UI，保留会话与权威镜像 |
| 水面视觉参数 / 纯表现计算 | 首先允许刷新 | 校验后换配置或重建局部表现 |
| Phaser `World` 类 | 安全刷新 | 完成状态投影与销毁边界后再替换场景实例 |
| 协议 / 连接核心 / 不兼容状态结构 | 明确刷新、必要时重新登录 | 不承诺无损 HMR |
| 权威地图几何、奖励、任务条件 | 提示后端数据需更新 | 不靠前端 HMR 更改服务器规则 |

Vite HMR 提供模块接受、清理和失效 API，但不会替应用自动修复旧实例或旧闭包。手写游戏客户端必须自行建立这些边界。[W03]

### 5.2 先修已发现的连接生命周期缺陷

`client/src/network/session.ts` 当前逻辑：

```ts
connect() {
  this.stopped = false;
  this.close(); // close() 会把 stopped 再设为 true
  // 创建 WebSocket……
}

private scheduleReconnect(...) {
  if (this.stopped) return;
  // 安排自动重试……
}
```

**静态分析结论：正常执行 connect 后，自动重试分支可能一直被 stopped 拦截。** 页面重新可见时的手动 connect 可能掩盖这一问题。本次没有运行浏览器复现，不能写成“实测断线已修复”。[R07]

修复建议：将“关闭旧传输”与“主动停止会话”分开。`connect()` 只清理旧 socket / timeout / retry，然后将会话置为可重连；用户退出才进入终止状态。若采用最小调整顺序，也必须用测试证明所有终止和竞态路径正确。

新增离线定向检查 `client/src/network/session.check.ts`，使用可控 WebSocket 与计时器替身，至少覆盖：断线后重试、主动 close 后不重试、旧 socket 回调不影响新 socket、终止码不形成互踢循环、连续 connect 只留下一个传输实例。不得通过放宽版本校验或绕过 hello 修复重连。

### 5.3 为什么不能直接热替换整个 main.ts

当前入口在模块顶层写入 DOM、注册 document / window 事件，进入游戏时创建网络、输入、Phaser、各类 UI；退出函数还会关闭连接、销毁游戏和 UI。[R05]

因此下面两种改法均不可作为交付：

```ts
// 错误方向：接受了更新，却没有更新现有对象。
if (import.meta.hot) import.meta.hot.accept();

// 错误方向：把退出游戏当作每次改 HUD 的清理动作。
// leaveGame(); enterGame(...);
```

前者可能仍显示旧实现；后者会让纯视觉修改触发会话级拆除。对没有安全边界的入口修改，整页刷新比伪装无损 HMR 更可靠。

### 5.4 最小职责拆分：稳定会话、可替换表现

仅为接入已选择的模块拆分，不先建设通用插件框架。

```text
app/main.ts
  负责页面入口、登录选择、明确退出和装配
        │
        ├─ session-runtime.ts          [拟新增，P2]
        │    Connection、会话状态、最新权威快照、消息序号
        │    不导入可热替换的具体 UI 类
        │
        └─ presentation-host.ts        [拟新增，P2]
             对目标 UI / 表现槽位做准备、切换、清理
             持有“当前实现”引用，不自行结算游戏规则
                    │
                    ├─ 现有 HUD / DOM views
                    └─ 现有 Phaser World（初期不热替换整场景）
```

第一件试点选择 HUD 的一个独立区域，而不是所有窗口一起迁移。先明确它现有的创建、数据更新、用户操作回调和 destroy 入口，再补最小适配层。没有第二个真实使用者之前，不抽象大而全的“前端引擎”。

**状态所有权：**角色属性、背包、任务进度属于服务器事实；客户端只保留恢复显示所需的最新投影。窗口位置、展开状态、滚动位置和聊天草稿是局部 UI 状态。短暂粒子可丢弃，不能为了完整还原粒子而回放奖励、消耗、技能请求。

消息订阅回调经稳定分发器访问当前槽位，不闭包捕获被替换的旧视图。解绑必须对称；不能让第二份旧 UI 继续接收快照。

### 5.5 替换协议：准备成功后再切换

建议每个试点遵守以下顺序：

```text
收到目标模块更新
  → 为该槽位分配更新 generation，取消过时的准备工作
  → 在不占用交互、不发送业务命令的状态下准备候选实现
  → 校验依赖与所需资源
  → 用最新权威投影及兼容的局部 UI 状态初始化候选
  → 提交前确认 generation、sessionId、mapId 仍有效
  → 同步切换“当前实现”引用和挂载关系
  → 释放旧实例独占资源

候选失败：释放候选，保留旧实例，显示错误。
```

被热替换的叶子模块应尽量无顶层副作用。由稳定宿主接受依赖更新并控制实例销毁；不要在叶子模块的自动 dispose 中先销毁当前可用界面，再承诺“候选失败还能无损回滚”。模块卸载与实例切换需要分清。

HMR 接收示意：

```ts
// 示意：必须放在已建立生命周期的宿主中，不直接粘贴到当前 main.ts。
if (import.meta.hot) {
  import.meta.hot.accept('../features/hud/view', next => {
    if (!next) return; // 加载失败不拆掉现有 HUD。
    // replaceHud 内部串行处理候选、验证、提交与清理，并处理自身错误。
    void presentationHost.replaceHud(next.HudView);
  });
}
```

路径必须与实际导入及构建解析一致。`replaceHud` 是待实现接口；示例不是对仓库现有 API 的描述。对于宿主本身或状态结构不兼容的变化，允许失效并刷新。[W03]

### 5.6 Phaser 场景边界

当前 `World.switchMap()` 调用 `this.scene.restart()`；这解决的是已有场景实例的重启，不等于为旧实例换上新模块中的类实现。[R06]

后续真正替换 World 时，需要显式移除 / 销毁旧实例，注册新类实例，等待加载就绪，再接上最新快照。不能把同名场景无限 add，也不能假定 `game.destroy(true)` 已在当前同步调用栈立即完成所有释放。

Phaser 区分场景 shutdown 和 destroy。清理应覆盖自己的事件、定时器、声音、输入和表现对象；共享 TextureManager 中仍被其他对象使用的纹理不能随场景关闭一律删除。[W06]

World 当前还拥有动作去重记录、待处理技能表现和快照。建立场景替换前，应明确哪些记录保留、哪些效果不重放；不要把历史技能事件重播成新的施法。首轮 HUD HMR 不必先解决整个 World 的迁移。

### 5.7 不变量

- 同一玩家客户端只有一个业务 Connection；允许另有一条 Vite HMR WebSocket，不能把两者误判为双业务连接。
- CSS / UI HMR 不发送 logout、hello、技能、拾取、购买或其他结算请求。
- 每个表现对象只有一个生命周期拥有者；dispose 可重复调用且无副作用。
- 异步加载必须携带会话 / 地图 / 更新代数校验；晚到的旧结果不能覆盖新状态。
- 明确退出才走会话级清理；热换视图只清理该视图。

---

## 6. P3：资源、构建与运行身份分离

### 6.1 资源链的唯一来源

```text
参考/273 中的 WZ / 同版导出依据
  → scripts/export_tms273_*.cjs
  → resources/tms273-export
  → scripts/assemble_tms273.cjs
       ├─ client/public-tms273/assets       开发客户端资源
       └─ shared/*.json                    服务端权威配置

client 源码 + public-tms273
  → Vite build
  → 独立构建快照（保留 dist-tms273 这一产物概念）
```

装配器当前确实会写 shared 数据，因此“重新装配资源”不一定只是前端操作。涉及地图几何、技能规则、任务数据时，需要与已启动后端的内容修订一致，不能让新 manifest 与旧内存规则静默混用。[R12]

### 6.2 不同修改的生效规则

| 修改 | 是否需要 WZ 导出 / 装配 | 浏览器动作 | 后端动作 |
| --- | --- | --- | --- |
| CSS、布局 TS | 否 | HMR 或刷新 | 无 |
| 纯视觉参数 | 通常否 | 校验并应用 / 重建表现 | 无，前提是不改规则 |
| 已导出 PNG | 按资源流程更新修订 | 重新装载对应纹理，或先安全刷新 | 通常无 |
| manifest / appearance | 需要形成一致的装配结果 | 校验完整资源修订再切换 | 若牵涉规则则需要同步处理 |
| 原始 WZ | 是，不会因 Vite 存在而自动转换 | 装配完成后再加载 | 按生成数据决定 |
| shared 权威配置 / Rust | 不是浏览器 HMR 问题 | 提示内容 / 协议不一致 | 明确重载机制或用户执行重启 |

`loadManifest()` 当前分两次 fetch 读取 manifest 和 appearance。若资源批量更新在中途被观察到，就可能读到不一致的组合。因此资源发布应有完成标记或修订索引，不能对每个 PNG 的写入事件立即强制刷新页面。[R09]

### 6.3 资源热更新的最小可靠方案

P1 不承诺资源无损热替换，允许在一次完整装配完成后刷新页面。P3 再增加 `assetRevision`：

1. 装配输出候选资源，完成引用、文件存在性和格式校验。
2. 同一修订内的 manifest、appearance 和图片保持一致；发布完成标记最后写入。
3. 浏览器收到“新修订可用”信号后先准备候选，不立即破坏旧纹理。
4. 准备成功后切换；失败保留旧版本并报出缺失资源。
5. 同内容版本下的纯表现变化用资源修订区分；协议 / 规则不兼容仍按原有版本契约阻断。

`assetRevision` 是拟新增的工程字段；目前并不存在完整的资源事务发布机制。单纯给 URL 加 `Date.now()` 既不保证资源一致，也会破坏缓存复用，不作为正式方案。

浏览器 HTTP 缓存、已 fetch 的 JS 对象、Phaser 纹理缓存是不同层次。只设置 `Cache-Control: no-store` 不能让已经创建的 Texture 对象自动变成新图。

### 6.4 监听范围与检查成本

默认只关注客户端源码、实际参与导入的 shared 文件，以及资源装配完成标记；不监听原始 WZ 全树、数据库、日志、dist、Cargo target 和 node_modules。资源导出过程可合并多次变化，只在一致结果完成后通知浏览器。

`scripts/check_tms273_runtime.cjs` 当前混合了运行资源校验、原始 WZ 对照和代码约束，还会读取被 Git 忽略的 `参考/273/.../Mob` 数据。它不适合在每次 CSS 保存时执行。[R14]

建议保留该完整检查，另外抽出可复用的轻量运行资源检查用于 dev 启动。内容变更仍跑必要的来源与语义检查；缺 WZ 时明确标为“来源核对未执行”，而不是吞掉断言当作通过。保持已实现的递归扫描生产 `.rs` 逻辑，不再退回只扫描一个 `world.rs`。[R14]

### 6.5 构建与发布不能写坏正在使用的目录

目标分成两步：**build 生成候选，publish / 显式切换选择候选。**

拟新增 `scripts/build_client.mjs`，由统一入口调用：先执行现有类型检查，再调用 Vite 向独立候选目录构建，成功后写入包含 buildId、协议 / 内容版本、资源修订和依赖指纹的构建信息。失败只废弃候选，不清空当前服务目录。

部署 / 预览实例的 `CLIENT_DIST` 指向具体已验证目录，不在请求处理中混用新旧文件。目录切换需考虑文件系统语义；不能把“两次 rename”笼统写成无窗口原子操作。第一版可以在用户明确安排的切换时机重启绑定新目录，不承诺无缝线上热发布。

现有 `dist-tms273` 名称保留为构建交付约定；可以引入带 buildId 的候选 / 版本目录，但不要把构建路径变化扩散到业务模块。后续如要支持旧页面跨版本持续运行，另行设计版本化资源 URL、保留旧资源和兼容策略。 新候选 / 版本输出目录同步加入 `.gitignore`，避免资源包和构建产物被误提交。

### 6.6 预览必须验证完整产物，而不是依赖开发目录补漏

当前 Rust 的 `/assets` 会用 public 兜底。这对已有本地开发可能有便利，但不能据此证明一个构建包是完整的。[R04]

新增显式的严格预览配置：资源只从所选构建目录读取，不回退 public。该模式尚未实现。缺失 JS、CSS、图片应得到正确错误，不返回 HTML 假装成功；已有 `/assets` 独立路由和其余 SPA fallback 要分开检查，不能把所有路径都一概说成返回 HTML。

本地静态预览工具不等于生产服务器；Vite 官方也把 preview 定位于本地检查构建结果。[W05]

静态响应策略建议：HTML 与版本索引要求重新验证；只有内容寻址、可长期保留的不可变资源才使用长期 immutable。当前 public 中的固定名字资源不应在没有修订策略时全部设置一年缓存。

---

## 7. Three.js 接入路线：落实目标，但不以重写阻塞反馈链

### 7.1 当前基础与目标必须同时保留

已核实：Phaser 承担主世界与实体绘制；大量 UI 已经是 DOM；`water.ts` 的 WaterSurface 等表现模拟可以作为后续复用对象，但当前文件仍与 Phaser 在一起。[R05][R06][R11]

目标：形成 TS / JS 业务与 Three.js 表现可协作的 Web 客户端。**Three.js 是拟接入的渲染实现，不接管服务端权威模拟。** 不为了安装 Three.js 同时更换网络、任务、背包、碰撞规则或 WZ 资源格式。

### 7.2 三种接法及选择

| 接法 | 优势 | 代价 / 风险 | 结论 |
| --- | --- | --- | --- |
| 保留 Phaser，Three.js 用于独立预览或明确独立的效果层 | 影响小，容易验证依赖、资源、销毁 | 两画布不能任意交错同一场景深度 | R1 起步方案 |
| 同一客户端入口，在 Phaser / Three 两个主渲染适配器间切换 | 复用会话、DOM UI 和资产，能做同数据对照 | 需逐项迁移地图、角色、技能和交互表现 | R2 主线 |
| 一次性删除 Phaser 并重建全部世界 | 终态单一 | 同时扩大图层、动画、音频、交互、加载等风险 | 不采用 |

如果最后只完成了独立 Three.js 预览，交付应明确称“局部接入”，不能称“主世界已迁移到 Three.js”。

### 7.3 R1：真实接入，但不碰核心玩法

待办：为经过兼容核验的 Three.js 版本建立依赖锁定；按该版本核对类型依赖；新增一个可关闭、按需加载的独立表现模块。默认关闭时不产生额外渲染循环或不必要的初始化成本。

建议用同版地图片段 / 角色外观的独立预览验证资源契约，随后再选择明确位于最前或最后的效果层。输入取自只读资源和状态投影，不额外创建第二个业务 Connection，不向服务器上报客户端物理结算。

R1 验收包括：真实 Three.js 调用链、资源锚点正确、尺寸变化可用、关闭后释放本模块资源，以及不会改变 Phaser 主世界。未达到这些条件，不进入 R2。

### 7.4 R2：主世界可切换适配器

只有 R1 验证后，才新增最小的渲染接口和第二个实现；初期选择渲染器可以在进入地图前决定，允许重新进入场景，不要求运行中无损切换引擎。

```ts
// 拟议契约示意；Snapshot / MapRenderData 对接现有真实类型，
// 不新造第二套网络协议或权威状态。
interface WorldPresentation {
  prepare(map: MapRenderData, signal: AbortSignal): Promise<void>;
  applySnapshot(snapshot: Readonly<Snapshot>): void;
  resize(width: number, height: number, pixelRatio: number): void;
  dispose(): void;
}
```

每帧驱动通过宿主的内部契约连接，不让两个实现各自推进同一个模拟。Phaser 作为主引擎时沿用其循环；Three.js 成为主表现时由宿主拥有唯一循环。不能在 Phaser 已在驱动帧的同时，又为相同世界另开独立 RAF。

新适配器先覆盖一张真实地图，再覆盖玩家与 NPC，最后扩到地图切换、怪物、掉落、技能、Portal / Reactor 交互与音频表现。DOM 的背包、聊天、任务等继续复用，不因主渲染器变化而改用 Canvas 重写 UI。

### 7.5 渲染一致性清单

| 维度 | 要求 |
| --- | --- |
| 坐标 | 延续服务器 x / y 与脚点语义，明确处理 y 向下；采用 Three y 向上时集中做 `x → x, y → -y` 转换，不能各模块各翻一次 |
| 相机 | 起步用正交视图保持 2D 体验；视口、缩放、滚动由同一状态决定 |
| 图像锚点 | 复用 manifest 中的 origin、x/y、named anchors，分清部件偏移与地图帧坐标，不重复减 origin |
| 图层 | 复用 map depth、前后景和人物部件 z 顺序；不假设所有透明图片靠 Three 默认排序即可一致 |
| 翻转 | 角色整体以统一锚点翻转，不让每张图绕各自中心翻转 |
| 时间轴 | 保留原始 delay，行为动作与技能事件读取服务器事实，不靠客户端帧数结算 |
| 像素与色彩 | 明确纹理过滤、透明度、颜色空间与缩放策略，逐图对照；不能因引擎切换自动改变原版视觉 |
| 输入 | 屏幕到世界坐标转换与相机一致；不会出现双层 Canvas 同时抢鼠标 / 键盘 |
| 声音与事件 | 同一动作不会因双实现比较而播放两次声音或发送两次请求 |

源资源契约来自项目规范、manifest 辅助函数和现有世界实现，不以 Three.js 默认值替代。[R09][R10][R06]

### 7.6 水面与双引擎的特殊边界

现有 WaterSurface 使用高度场和固定步长，角色与掉落的权威锚点仍由服务器拥有。[R11]

当水面确实需要 Three.js 表现时，再从现有文件抽出与 Phaser 无关的模拟核心，令两种渲染适配器读取同一表面状态。不要为了换渲染器再造一套水位、漂浮偏移和入水判断。

**两个 Canvas 不能让“Phaser 后景 → Three 水体 → Phaser 人物 → Three 水花”天然任意交错。** 简单叠层只适用于可明确分离的前 / 后景。需要精确遮挡时，应选择同一主渲染器、受控的合成通道或更晚评估的共享上下文方案，而不是靠 CSS z-index 假装解决场景深度。

Three.js 提供共享上下文相关的状态重置能力，但一个 `resetState()` 不等于两个引擎已经完成纹理、帧缓冲、混合状态和生命周期集成；本计划不把共享 WebGL 上下文作为第一阶段捷径。[W07]

### 7.7 Three.js 资源与循环治理

每个适配器明确记录自己拥有的几何体、材质、纹理、渲染目标和监听器。纹理释放使用相应 dispose API；共享资源通过租约 / 引用计数或明确唯一拥有者管理。释放对象引用与释放 GPU 资源不是同一件事。[W08]

全局 renderer、会话和主循环不随每次改材质重建。需要销毁整个 Three renderer 时才执行对应清理；只换某个效果时只释放该效果拥有的资源。Three.js 主渲染循环可使用官方 `setAnimationLoop`，但其拥有权仍归宿主，不给每个特效各建一套循环。[W07]

不预设 Three.js 一定比 Phaser 快。必须比较相同地图、实体数量、分辨率和设备下的帧耗时、内存与资源量；有明确收益或目标能力后再扩大替换范围。

### 7.8 R3：主渲染器切换门槛

只有地图、纸娃娃、主要交互、技能、掉落、音频、窗口适配与资源释放达到已约定的对照标准，才考虑让 Three.js 成为默认主渲染器。保留 Phaser 回退一段验证周期；无证据前不删除原实现。

若 Three 路线遇到表现缺口，P1/P2 的源码开发和 HMR 仍应独立交付，不一起回滚到旧 dist 开发方式。

---

## 8. 文件级任务清单与依赖

### 8.1 分阶段安排

| 阶段 | 范围 | 主要文件 | 完成门槛 |
| --- | --- | --- | --- |
| P0 修订 | 纠正已有取证与首版假设 | 已有 HMR 专题计划、`docs/dev/current-entry-audit.md`、`PLAN.md` | 现状 / 建议 / 未测分开；不重做无关历史 |
| P1a | 模式解析、端口与进程安全 | `启动3010.command`、`关闭3010.command`、`client/vite.config.ts`、`client/package.json` | status 真只读，dev 不重启兼容后端，不重复 bot |
| P1b | 开发身份与自动生效 | `client/src/app/main.ts`、拟新增 `client/src/vite-env.d.ts`、开发身份模块 | 正确源码入口可识别；真实 UI 修改自动可见 |
| P2a | 连接生命周期修复 | `client/src/network/session.ts`、拟新增 `session.check.ts` | 离线重连 / 终止 / 竞态检查通过 |
| P2b | 一个 UI 的状态保留热替换 | `main.ts`、拟新增 `app/session-runtime.ts`、`app/presentation-host.ts`、目标 HUD 视图 | 改目标 UI 不重连，不累积监听器 |
| P3a | 资源检查与修订 | `scripts/assemble_tms273.cjs`、`scripts/check_tms273_runtime.cjs`、`client/src/assets/manifest.ts` | 资源一致、检查分层、失败不半更新 |
| P3b | 隔离构建与严格预览 | 拟新增 `scripts/build_client.mjs`、Vite 配置、`server/src/main.rs`、启动脚本 | 构建失败不改变当前产物，缺资源不靠 public 补漏 |
| R1 | Three.js 局部接入 | package / lock、拟新增独立 Three 表现模块 | 可关闭、同资源、无权威改动、生命周期正确 |
| R2 | 两个主渲染适配器 | `scenes/world.ts`、实际需要时新增的 render 契约 / 适配目录 | 同一入口、协议、资源和 DOM UI；真实地图对照 |
| R3 | 默认切换评估 | 渲染器装配与用户验收记录 | 达到功能 / 视觉 / 性能门槛，保留回退 |

所有“拟新增”都是未来任务，不能在报告中标为仓库已存在。具体命名可在实现前小幅调整，但不能留下两套功能相同的宿主或重复启动器。

### 8.2 依赖与改动所有权

P1 不依赖 Three.js，也不依赖整个 main.ts 重构。P2a 可以与 P1 的离线代码工作分开，但真正的状态保留 HMR 验收依赖 P1。R1 可以在入口稳定后开展；R2 依赖已经明确的会话、状态与表现边界。

`main.ts`、Vite 配置、启动脚本和共享协议各设唯一改动负责人。UI、资源工具和 Three 实现只有在边界清晰时并行；不让多个实现者同时改入口装配。此计划不要求改协议；确需改变协议时依仓库规范同步 Rust、TS 和 bot，不单边提交。[R10]

### 8.3 文档整合

将本计划作为现有 `MapleStory_TMS273_Web_Realtime_HMR_Development_Plan.md` 的新版本内容，或由该文件明确链接到本版；不要保留两份互相冲突的“当前推荐”。

`PLAN.md` 只记录正在实施的阶段、依赖、待用户验收项。更新现有 P0 文档的端口选择和资源链错误，保留其“当时没有运行实测”的边界。已完成结果按原规范记录到 `IMPLEMENTATION_STATUS.md`，不新增第四份重复状态台账。[R10][R13][R17]

---

## 9. 验证与验收：每项都说明验证层次

### 9.1 必要的开发者检查

只执行实际改动相关的检查，不默认重跑整个项目 QA：

| 改动 | 定向检查 |
| --- | --- |
| zsh 模式解析 / 进程治理 | shell 语法检查；用替身命令覆盖分派、陌生 PID、并发启动和失败清理；不调用用户在线服务的真实 stop |
| Vite 配置 / TS | 现有 `typecheck`；必要的隔离构建；核对真实 Node / npm 锁定版本 |
| Connection | 新增可控计时器与 WebSocket 替身测试 |
| 一个 UI HMR 槽位 | 原模块定向检查 + 创建 / 销毁 / 重复替换的生命周期检查 |
| 水面拆分 | 复用现有 `water.check.mjs` 并补适配边界，不把另一套物理算法当重构 |
| 装配 / manifest | 完整候选校验、缺文件 / 混修订 / 不匹配失败路径；原始来源检查按改动需要执行 |
| Rust 静态模式 | 编译与路由定向检查；不为此擅自重启用户实例 |

仓库已有 build 包含类型检查，应继续保留。浏览器页面能打开不等于类型正确；Vite 的 TS 转译本身不承担完整类型检查。[R02][W09]

### 9.2 用户运行验收矩阵

以下均为**待实施后验证**，不是本次已通过项。

| 编号 | 操作 / 情况 | 预期结果 |
| --- | --- | --- |
| D01 | 从统一入口启动 dev | 打开固定 5173，显示 DEV_SOURCE，不误入 3010 构建页 |
| D02 | 检查页面源码请求 | 有 Vite 客户端和真实 `/src/app/main.ts` 模块响应，不是 HTML 伪响应 |
| D03 | 修改一处 HUD CSS | 原页面更新；不触发前端 build，不重启 Rust / bot |
| D04 | 修改尚未建立 HMR 边界的 TS | 自动刷新后显示新实现；允许重新进入游戏，不冒称会话无损 |
| D05 | 5173 被其他进程占用 | 明确失败，不自动换端口，不停止占用者 |
| D06 | 连续两次启动 dev | 复用本项目 Vite / Rust / bot，无第二份权威世界 |
| D07 | 执行已实现的 status | 无构建、无启停、无数据库写入 |
| D08 | 执行 stop dev | 仅关闭所属 Vite；后端与陪测 bot 仍在 |
| H01 | 更新已接入的 UI 槽位 | 业务 WS 身份不变，局部状态按约定保留，无 logout / 重复动作 |
| H02 | 区分连接 | 一条业务 WS；另有 Vite HMR WS 属正常情况 |
| H03 | 连续替换目标 UI 20 次 | 活跃 Canvas、监听器、订阅、计时器不持续增长；资源使用在预热后稳定 |
| H04 | 候选模块语法或初始化失败 | 报错；已运行服务不动；可保留时保留旧 UI；不能假报已应用 |
| H05 | 快速保存、切图、退出交错 | 旧异步加载不挂回新地图，不恢复已退出会话 |
| N01 | 非主动断线 | 按策略重试；新权威快照到达后才恢复可操作状态 |
| N02 | 主动退出 / session_replaced | 不再自动重试、不出现两页互踢 |
| A01 | 完整更新纯视觉资源修订 | 新资源可见，不被 dist 或旧纹理缓存盖住 |
| A02 | manifest / appearance / 图片缺失 | 清晰报错，不在半套资源上恢复输入 |
| A03 | 修改 shared 权威配置 | 明确提示需同步后端，不把视觉更新当规则已生效 |
| B01 | 候选构建失败 | 当前服务进程和已发布资源目录都不受候选清理影响 |
| B02 | 严格构建预览 | 不访问 Vite，不靠 public fallback；所选 buildId 正确 |
| B03 | 缺失静态文件与未知 API | 返回正确错误，不被无差别 index.html 兜底掩盖 |
| T01 | Three 模块关闭 | 无额外业务连接、无闲置循环持续运行 |
| T02 | Phaser / Three 对照 | 相同资源与状态下，坐标、脚点、层级、帧时序一致 |
| T03 | 尺寸与性能 | 宽屏、横屏、窄竖屏、动态尺寸可用；记录真实帧耗时与资源指标 |

20 次替换是建议的局部压力检查样本，不是证明永不泄漏的充分条件。内存检查关注稳定趋势、资源所有权和可解释缓存，不要求 JS heap 每次立即回到精确相同字节数。

### 9.3 性能记录，不虚构收益

每次关键验收记录：设备 / 浏览器、分辨率 / DPR、地图、实体数量、代码模式、buildId 或源码修订、资源修订、场景加载时间、稳态帧耗时分布和重复替换后的资源数量。

冷启动、依赖预打包和资源已缓存后的热修改分开记录。尚无本项目测量基线，不写“已达到 60 FPS”“HMR 提升十倍”或“Three.js 必然更快”。性能门槛在相同条件的基线基础上确定，不以引入新框架代替测量。

---

## 10. 回滚和禁止事项

### 10.1 回滚单位

P1 的脚本 / Vite 配置可以独立回滚；停止所属 Vite 不影响仍在运行的 Rust。P2 的单个 HMR 槽位可撤销接收边界并退回整页刷新。P3 的候选资源 / 构建失败时不发布，继续使用上一完整版本。Three.js 通过装配开关退回 Phaser，不回滚任务、账号或数据库。

回滚源码不等于回滚已经启动的二进制与内容数据，报告中分别说明。未实现自动回滚前，不声称一次脚本调用可以恢复所有运行态。

### 10.2 明确不做

不新建替代主项目的空 Vite / Three.js 模板；不把源码 HMR 和商业热发布混为一谈；不自动清理 iCloud 冲突副本；不删除原资源、数据库或 bot 凭据；不改 port 3000 的其他服务；不使用 `pkill node` 或按端口盲杀。

不为了本任务引入 React / Vue 重写已有 DOM、微前端、SSR、ECS、分布式客户端状态或通用插件引擎。已有大型文件治理按独立计划推进，只在本任务必须的边界处配合拆分。

不要把 `server.fs.allow` 扩到整个用户目录；不要把数据库、账号凭据或原始私有素材放进 public；不要把 Vite 开发服务当正式服务器。项目规范对运行环境的保护优先于“自动化看起来完整”。[R10][W02][W05]

---

## 11. 第一张实施任务单

**任务名称：统一入口启用 TMS273 源码开发，不迁移 Rust 3010。**

输入：本计划、当前实际工作区、`BUSINESS_DEVELOPMENT.md` 与 `PLAN.md`。

修改范围：启动 / 关闭脚本的模式与 Vite 进程治理，`client/vite.config.ts`、`client/package.json`、最小开发模式标识与类型声明；必要文档同步。

必须保留：真实 `client/src/app/main.ts`、Phaser 主世界、public 资源目录、Rust 3010、现有数据库、现有 bot、原协议与来源校验。

完成定义：

> 在没有重启兼容后端、没有重新构建 dist 的情况下，统一入口打开明确标识的源码页；修改一处真实 UI，浏览器自动反映变化。新 `status` 确实只读，重复 dev 不启动第二份实例，外部端口占用不会导致换端口或杀进程。

允许的阶段性限制：普通 TS 修改可整页刷新；未接入的模块不承诺保状态；WZ 更新仍走导出 / 装配；后端逻辑仍需明确构建与用户安排的重启。

不包含：Three.js 全面迁移、整个 main.ts 重构、所有 UI 的 HMR、任务系统或战斗规则修改、独立 QA 服务和完整线上发布系统。

**结论：先保证“修改确实进入当前运行页面”，再保证“更新不破坏当前会话”，最后把 Three.js 作为可验证、可回退的渲染演进。三者互相配合，但不绑成一次大重写。**

---

## 12. 证据与资料索引

### 仓库证据

所有 R 引用固定到本次审阅提交，便于实施者对照；不以移动中的 main 证明未来文件内容。较大文件只核对了与启动、会话、渲染和资源相关的部分；本文不声称完成全仓安全或功能审计。

- [R00] 审阅基线提交。
- [R01] `启动3010.command`：构建 / 重启顺序、PID 判断、DB / bot / 端口配置。
- [R02] `client/package.json`：依赖和已有开发 / 构建 / 检查命令；锁文件见同目录 `package-lock.json`。
- [R03] `client/vite.config.ts`：public、dist、代理、版本标签。
- [R04] `server/src/main.rs`：配置加载、路由与静态目录优先级。
- [R05] `client/src/app/main.ts`：入口副作用、Phaser / Connection 装配与退出清理。
- [R06] `client/src/scenes/world.ts`：Scene、快照、preload、switchMap。
- [R07] `client/src/network/session.ts`：同源 WS、connect / close / scheduleReconnect。
- [R08] `关闭3010.command`：身份校验与停止规则。
- [R09] `client/src/assets/manifest.ts`：资源类型、帧坐标辅助函数、loadManifest。
- [R10] `BUSINESS_DEVELOPMENT.md`：权威、资源、开发验证与文档治理规范。
- [R11] `client/src/features/world/water.ts`：Phaser 水面与独立表现模拟边界。
- [R12] `scripts/assemble_tms273.cjs`：实际资源写入目标、shared 输出。
- [R13] `docs/dev/current-entry-audit.md`：已有 P0 取证及需修正的描述。
- [R14] `scripts/check_tms273_runtime.cjs`：原始来源依赖、资源检查与生产源码扫描。
- [R15] `.gitignore`：未包含在 Git 中的资源、构建和运行态。
- [R16] `client/tsconfig.json`：现有类型检查范围与配置。
- [R17] `PLAN.md`：当前 HMR 待办、未完成运行验收与其他待确认事项。
- [R18] `client/index.html`：真实源码入口。

### 官方技术资料

查阅日期：2026-09-12。Vite 特意使用与项目 7.x 对应的官方版本文档，不把最新版主版本的配置语义直接套入现有项目。Three.js 接入时再按最终锁定版本核对 API。

- [W01] Vite 7 Getting Started：源码开发、静态构建、Node 兼容要求。
- [W02] Vite 7 Server Options：端口、代理、HMR 连接、文件访问与安全选项。
- [W03] Vite 7 HMR API：依赖接受、失效、清理与客户端类型。
- [W04] Vite 7 Static Asset Handling：public 目录和构建复制语义。
- [W05] Vite 7 Static Deploy：本地 preview 的定位。
- [W06] Phaser Scenes Events：shutdown / destroy 生命周期。
- [W07] Three.js WebGLRenderer：循环、销毁、上下文状态相关接口。
- [W08] Three.js Texture：纹理生命周期与 dispose。
- [W09] Vite 7 Features：TypeScript 转译与类型检查边界。
- [W10] MDN 同源策略：origin 的端口维度与本地存储隔离。

[R00]: https://github.com/dragon717/MapleStory/commit/1fefe97c2d27a928f3bf670b657d79f68d795fe9
[R01]: https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/%E5%90%AF%E5%8A%A83010.command
[R02]: https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/client/package.json
[R03]: https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/client/vite.config.ts
[R04]: https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/server/src/main.rs
[R05]: https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/client/src/app/main.ts
[R06]: https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/client/src/scenes/world.ts
[R07]: https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/client/src/network/session.ts
[R08]: https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/%E5%85%B3%E9%97%AD3010.command
[R09]: https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/client/src/assets/manifest.ts
[R10]: https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/BUSINESS_DEVELOPMENT.md
[R11]: https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/client/src/features/world/water.ts
[R12]: https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/scripts/assemble_tms273.cjs
[R13]: https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/docs/dev/current-entry-audit.md
[R14]: https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/scripts/check_tms273_runtime.cjs
[R15]: https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/.gitignore
[R16]: https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/client/tsconfig.json
[R17]: https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/PLAN.md
[R18]: https://github.com/dragon717/MapleStory/blob/1fefe97c2d27a928f3bf670b657d79f68d795fe9/client/index.html
[W01]: https://v7.vite.dev/guide/
[W02]: https://v7.vite.dev/config/server-options
[W03]: https://v7.vite.dev/guide/api-hmr
[W04]: https://v7.vite.dev/guide/assets
[W05]: https://v7.vite.dev/guide/static-deploy
[W06]: https://docs.phaser.io/api-documentation/event/scenes-events
[W07]: https://threejs.org/docs/pages/WebGLRenderer.html
[W08]: https://threejs.org/docs/pages/Texture.html
[W09]: https://v7.vite.dev/guide/features
[W10]: https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy
