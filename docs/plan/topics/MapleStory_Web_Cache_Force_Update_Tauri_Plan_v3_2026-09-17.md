# 冒险岛 Web 实时开发、资源缓存、强制更新与 Tauri 桌面端
## 仓库审查与渐进式实施计划 v3

> 日期：2026-09-17。  
> 仓库：`dragon717/MapleStory`，分支 `main`。  
> 固定源码基线：`39c8bea8980b553a49acfab68fd44c4eda789d5d`。[R16]  
> 对照方案：`docs/plan/topics/MapleStory_TMS273_Web_Realtime_HMR_Repo_Reviewed_v2.md`，该文仍基于 2026-09-12 的 `1fefe97c…`。  
> 状态：**源码审查、官方文档调研与待实施计划；不是已经落地的代码或运行验收报告。**  
> 本次没有改动或推送仓库，没有启停 3010、机器人或数据库，没有构建安装包，也没有实测浏览器和 WebView。仓库源码可读不代表已获得用户本机被忽略的完整美术资源。下文性能目标均为拟议验收标准，不是测量结果。

## 0. 结论与本轮边界

保留现有 TS/JS Web 业务、Phaser 主世界、已存在的 Three.js 依赖和 Rust 权威服务器。把“开发时保存立即生效”“刷新复用资源”“手动更新”“桌面分发”拆为四项相互配合、可以独立回滚的能力，而不是借机重写整个客户端。

**推荐主线：Vite 源码开发 → 不可变资源与发布契约 → 浏览器原生 HTTP 缓存及更新入口 → 按地图加载 → Tauri 2 薄壳验证与签名分发。**

第一阶段不注册 Service Worker，不建设 IndexedDB 大资源仓库，不默认下载全世界资源，不把游戏规则搬到 Tauri Rust。缓存失败不能成为登录和进图失败的原因；真实的网络失败、资源缺失和版本不兼容仍须明确报错，不能用错误内容伪装成功。

Tauri 2 是优先验证方案，而非已经证明适配完成的最终选型。它支持复用 Vite 前端，但不同系统的 WebView、打包后独立的页面来源、资源和网络地址、安全策略必须实测。保留 Electron 为明确出现 WebView 兼容阻塞后的备选。[W07][W08][W13]

本计划中的新文件、接口、路由和命令均为**拟新增**。实施前先核对本地工作树和同名文件，复用现有实现，禁止照表直接覆盖。

## 1. 对旧方案的审查：方向保留，基线必须更新

| 审查项 | 当前源码事实 | 对旧方案的修订 |
| --- | --- | --- |
| 日常开发入口 | Vite 已存在，代理 `/api`、`/ws` 到 3010；启动主链仍围绕构建候选、轮替和启动服务器 | 保留 5173 源码开发方向，先给统一入口增加显式 dev 模式，不先破坏现有发布模式 |
| 构建目录 | Vite 输出 `build/tmp/client`；服务端默认读 `build/current/client` | 不再按 `client/dist-tms273` 设计新逻辑，也不再重新实现已经存在的候选隔离 |
| 美术与音频 | `publicDir` 仅在 serve 时启用；生产 `/assets` 先找构建 JS/CSS，再找外置 `ASSETS_DIR` | 保留资源与代码分离；不要恢复每次构建复制全量资源的旧路径 |
| 发布基础 | `scripts/build-release.cjs` 已有 current/previous/tmp、锁、校验与发布元数据 | 扩展既有发布链，不照旧文另建第二套客户端发布器 |
| 主渲染器 | `World extends Phaser.Scene`；依赖已包含 `three` | 删除“没有 Three.js 依赖”的旧判断；依赖存在不等于主世界已经迁移到 Three.js |
| 连接生命周期 | `connect()` 已调用不改变重连开关的 `closeSocket()`，`close()` 才主动停止 | 旧文 §5.2 缺陷已修，不重复修复或回退该实现 |
| 前端拆分 | 已有 `app/page-shell.ts`、`assets/preload-plan.ts`、`network/auth-api.ts` | 在这些接口接入，不再把新逻辑塞回巨大入口和场景 |
| 资源加载 | manifest/appearance 使用固定地址；入口页也单独请求相同清单 | 建立同一发布修订下的获取、验证和请求合并，避免入口与游戏各自看到不同版本 |
| 预加载 | `buildPreloadPlan` 明确遍历所有地图及大量角色、外观、怪物、技能、UI 和 BGM | 缓存不是唯一问题；按图加载要成为独立性能增量 |
| 缓存治理 | 所核对的 Axum 静态路由未显式给不同资源设置缓存分类 | 不能据此断言“浏览器完全没有缓存”；需测实际响应、代理配置和二次访问字节数 |

上述源码依据：[R01]–[R15]。旧文关于安全 HMR、资源一致性、状态归属和避免每次 URL 加时间戳的原则仍值得保留；其路径、已修缺陷和资源完整性验证方法需更新。[R00]

本次审查覆盖旧方案的启动、HMR、资源发布章节以及当前入口、网络、资源预加载、登录 UI、静态服务和发布脚本主链；并非全仓每个叶子模块的穷尽扫描。完整 URL 消费者清单、资源字节量与实际响应头列入 P0 取证，不能由源码片段推断完整运行结果。

### 1.1 当前最重要的两个问题

第一，**旧构建页不会因为保存源码而自动变成新版本**，这是开发反馈链的问题。

第二，**当前预加载接近“进入一张图，准备整个资源目录中的大量内容”**。即使 HTTP 缓存命中，新的页面仍要重新执行 JS、解析清单、按需解码图像、创建场景与 GPU 资源；缓存不能保存上一页正在运行的 Phaser 场景。[R08][R09]

因此应分别测量：下载花了多少、解析解码花了多少、渲染初始化花了多少、等待服务器首个快照花了多少。不能把加载条出现统一解释成“又把地图下载了一遍”。

## 2. 用户需求转成明确产品契约

| 场景 | 预期行为 |
| --- | --- |
| 第一次访问、第一次进入地图 | 正常联网取所需静态资源；缓存可用时由浏览器保存 |
| 同版本再次刷新 | 尽量复用已有资源字节；允许少量版本检查与条件请求；仍需重建运行时 |
| 开发者工具 Disable cache | 按浏览器的网络缓存设置正常联网加载，不用另一层隐蔽缓存抵消这个选择 |
| 禁用站点存储、无痕、缓存被驱逐 | 不把缓存初始化作为启动门槛；网络可用时继续运行 |
| 服务器发布新资源 | 获取完整发布描述，按新修订取资源；不混用新版清单与旧版图像 |
| 首页点击“强制更新” | 强制检查最新兼容发布，重新装载页面/清单；可在同一对话框选择重新下载所需资源 |
| 点击“下载桌面客户端” | 下载已经在 CI 或开发机上构建并发布的真实安装包，不在浏览器里编译 Rust |
| 桌面端发现新程序版本 | 使用独立签名更新流程，展示版本和操作结果；不能用网页刷新冒充安装升级 |
| 网络不可用 | 显示连接/更新失败；不承诺离线运行多人权威世界 |

“浏览器不允许保存数据”和“用户禁用 HTTP 缓存”不是同一开关。实现不应靠读写一次 localStorage 来猜测 DevTools 的 Disable cache 状态。Chrome 明确提供了浏览器缓存开关；Cache API 则由应用显式维护，且不会自动遵守 HTTP 缓存头。[W02][W03]

## 3. 最小架构：只把环境与资源交付从业务中抽开

保留现有入口、视图、场景、玩家、技能、背包、任务和协议处理。新增少数有真实调用者的模块即可，不先搭通用插件框架。

| 拟议模块 | 责任 | 不负责 |
| --- | --- | --- |
| `platform/runtime-config.ts` | 环境标识、API/WS/美术资源端点、发布修订 | 登录流程和游戏规则 |
| `network/endpoints.ts` | 受校验的 API URL 与 WebSocket URL | 改写协议、自动降级版本检查 |
| `assets/resource-client.ts` | 发布内资源索引、JSON 获取、请求合并、错误与加载策略 | 场景绘制、玩家状态持久化 |
| `assets/resource-url.ts` | 逻辑资源地址到实际传输地址的映射 | 随意改纹理 key、重写所有字符串 |
| `features/client-actions/view.ts` | 首页更新与下载控件、状态展示 | 直接调用文件系统或管理 WebSocket |
| `features/client-actions/update-service.ts` | 更新状态机、兼容性检查、页面切换协调 | 清空用户存档或服务端数据 |
| `platform/web.ts` / `platform/tauri.ts` | 平台特有的下载打开、程序更新等小接口 | 两份业务实现 |

网络地址配置先解决三个现有入口：`network/auth-api.ts` 的 `/api/login`/`register`，`features/entry/api.ts` 的 `/api/lobby`，`network/session.ts` 基于 `location.host` 拼出的 `/ws`。[R11][R12][R13]

Web 默认继续同源；开发继续借 Vite 代理。Tauri 发布包显式配置真实服务器的 HTTPS/WSS 地址和静态资源来源。配置错误时明确拒绝启动，不能悄悄连到 WebView 自己的来源，也不能默认所有玩家电脑上都有一个 3010 服务。

### 3.1 保留“纹理标识”与“下载地址”的区别

现有预加载图片的 `key` 和 `url` 都是原始 URL，其他视图也用这些字符串找纹理。[R08][R09]

迁移初期应保持：

```text
逻辑标识：/assets/tms273/某个现有文件.png       保留既有引用语义
下载地址：/assets/objects/sha256/<摘要>.png   可以被版本索引解析
```

在 Phaser 入队点执行相当于 `load.image(原逻辑key, 解析后的下载URL)` 的适配。不要只把 loader 的 key 改为哈希，导致视图仍用旧 key 找不到图像。

同一页面中切换资源修订也不能让旧 key 指向的旧 Texture 静默复用。第一版强制更新通过安全页面重载清除本页运行时；同页纹理热替换另行设计代数、引用计数和失效规则。

### 3.2 接入必须覆盖全部真实资源消费者

仅修改 `loadManifest()` 不足以完成缓存/桌面适配。至少覆盖：

- `EntryView.loadArt()` 的登录素材、主清单、创角目录和外观目录。
- Phaser 图片、音频、JSON loader；`World` 中单独拼接的 windbell 音效。
- `WindbellScene.preload()` 自行加载的 JSON、图片和动态入队帧。
- DOM 的图片 `src`、纸娃娃、背景图、CSS 中独立的美术 URL。
- 实际存在的外观懒加载、图鉴目录等运行时资源请求。

前三项已在当前源码中直接核对。[R07]–[R10][R15]。其他消费者由实施时的静态扫描与运行请求清单补全；扫描结果不能代替真实浏览器覆盖。

不要全局 monkey-patch `fetch`、Phaser prototype 或 `Image`。优先在已拆出的获取/入队边界适配。不要递归替换所有 JSON 字符串，地图 ID、NPC 台词、`source` 溯源路径都不是下载 URL。

## 4. 版本契约：代码、规则、资源分开标识，再一起验证

| 字段 | 含义 | 更新时机 |
| --- | --- | --- |
| `releaseId` | 一次经验证的发布组合 | 代码/内容组合发布时 |
| `frontendBuildId` | 前端代码与依赖的构建标识 | 前端构建变化 |
| `protocolVersion` | 现有通信契约 | 协议变化，沿用现有规则 |
| `contentVersion` | 现有游戏内容/规则兼容契约 | 沿用当前内容发布规则 |
| `assetRevision` | 该批静态资源和清单的不可变索引标识 | 资源索引变化 |
| 每文件 `sha256`、`bytes`、`mime` | 具体文件校验与预算依据 | 文件字节变化 |
| `desktopVersion` / 最低兼容桌面版本 | 原生包版本与升级门槛 | 桌面程序发布 |

发布元数据已有 `releaseId`、协议/内容等基础字段，优先扩展而不是新建互相矛盾的版本来源。[R03] 不将 `__RELEASE_TIME__` 的构建时间当作图片哈希，也不把 `CONTENT_VERSION` 当作每个资源的内容摘要。[R01][R07]

拟新增 `/api/client-release` 返回小型、无用户隐私的当前发布描述，响应 `Cache-Control: no-store`。字段包含兼容组合、不可变资源索引地址、前端构建身份、已发布桌面版本信息或独立分发描述地址。它不是整个巨大游戏 manifest。

会话启动时固定一组发布描述。入口页与游戏页从同一组不可变 manifest/appearance 获取数据。若当前后端已不兼容，则提示更新而不是绕过 `authenticate` 和 hello 的现有校验。

### 4.1 实体文件也必须不可变

只把可变路径加上 `?v=123`，服务器却始终返回最新磁盘文件，不能保证旧客户端与回滚版本一致。

建议建立内容寻址存储：首次为现有资源补摘要，以后仅为变化字节生成新对象；资源索引保留“旧逻辑 URL → 摘要对象”的映射。对象一旦发布不能原地覆盖，索引最后发布。

```text
源资源装配完成
  → 验证 manifest/appearance/图片/音频的引用闭包
  → 写候选不可变对象（只写缺失摘要）
  → 写不可变索引
  → 校验代码、协议、内容、资源组合
  → 发布当前 release 指针
```

索引的哈希计算不要包含它自己的最终哈希，避免自引用。路径必须限制在资源根目录，防止 `..`、意外符号链接或外部 URL进入可信对象库。

**禁止把可变 public 文件直接硬链接后，再把链接当作永远不变的快照。** 源文件原地写入会同时改变硬链接对象。应以复制/新对象写入并校验后原子替换的方式建立只读对象，或证明导出器严格采用新 inode 写入与替换。

代码构建只绑定已封存的 `assetRevision`，不在每次 CSS 保存或每次 Vite build 时重扫、重算全部美术摘要。资源发布阶段独立承担完整性校验成本。

### 4.2 不退回“每次打包复制全部美术资源”

保留 `publicDir: serve 时启用、build 时关闭` 的现状。当前代码注释称内容规模约 843MB/7 万文件，这是仓库注释中的规模说明，**不是本次测得的磁盘量或浏览器实际下载量**。[R01]

生产完整性应改成“代码包 + 已声明、可解析、可保留的资源修订”验证，而不是强制所有资源必须在同一个 dist 目录。旧文的严格预览要求应修订为：禁用未声明的可变 public 兜底，但允许读取该发布明确绑定的不可变资源库。

保留 active/previous 发布引用的资源。需要支持旧页面继续运行时，另设有界的客户端兼容和资源保留窗口；不能在发新版后立即删掉所有旧图像、旧 JS chunk。物理垃圾回收应在保留窗口之外执行，缓存清理不是发布事务的第一步。

## 5. Web 缓存方案：HTTP 原生优先

### 5.1 缓存分类表

以下头部是拟议策略，需由 Axum 静态交付模块或明确的反向代理实现，并以实际响应测试。不能假定当前 ServeDir 已生成我们想要的 ETag。

| 资源 | 拟议策略 | 理由 |
| --- | --- | --- |
| `/`、`index.html`、恢复入口 | `no-cache`；有效验证器 | 页面要及时发现新代码，允许存储后重新验证 |
| `/api/client-release`、当前下载目录 | `no-store` | 每次检查获取当前发布/可用安装包 |
| 带文件摘要的 JS/CSS、图片、音频等 | `public, max-age=31536000, immutable` | 地址不变则字节不变，长期复用 |
| 不可变 asset 索引、版本化 JSON | 同上，前提是真正不可变 | 保持同一发布内的清单一致 |
| 尚未迁移的固定名 manifest/美术文件 | `no-cache` + 可验证的 ETag/Last-Modified | 过渡期避免把可变旧文件锁住一年 |
| 登录、角色列表、其他私人 API | `private, no-store` | 不当作公开静态内容缓存 |
| 静态 404/5xx、更新失败描述 | `no-store` | 防止缺失资源或错误页成为长期缓存 |
| `/ws`、业务消息、Vite HMR | 不纳入资源缓存 | 实时通信与静态文件不是同一责任 |

`no-cache` 不等于“不允许保存”；它要求使用前验证。`no-store` 也不是“删除浏览器以前已经存下的所有副本”。长期 immutable 必须建立在真实不可变内容上。[W01]

同版本刷新后看到 304 或一条网络面板记录，并不等于图片正文重新传输。验收以传输字节数、响应来源、初始化耗时为准，不以“请求行数必须为零”为准。[W01][W03]

### 5.2 为什么先不使用 Service Worker/CacheStorage

原生 HTTP 缓存已经覆盖现有 fetch、图片、CSS 和音频请求，不要求把业务改成 Blob 存取。CacheStorage 是另一套应用管理的机制，不会自动遵循 HTTP 缓存头，更新、淘汰和失效都要自己负责。[W02]

在用户明确要求尊重“禁用缓存”的前提下，第一阶段再叠加 cache-first Service Worker，反而会增加“我明明禁用了缓存，为什么还是旧图”的排障难度。因此不作为默认交付。

将来只有明确需要地图预下载、可见的缓存管理或弱网恢复时，才评估应用级持久缓存。此时必须有明确的“仅联网”开关、实际能力检查、写失败回退、容量预算和版本清理。不得编造一个跨浏览器可靠读取 DevTools 复选框状态的网页 API。

### 5.3 降级边界

HTTP 缓存缺失或被禁用时，让普通请求自然联网。站点偏好存储失败时捕获异常，模式保存在本页内存；需要跨刷新传递的非敏感恢复标记可以通过 URL 保留。

若未来有 CacheStorage/IndexedDB，读写均应捕获权限、配额和被驱逐等情况；缓存写入失败不得让已经成功下载的资源被丢弃。请求合并只合并同一发布、同一资源、同一有效策略的请求；失败 Promise 不能永久留在表中，使重试永远失败。缓存预算按字节，不按“缓存了几张图”推算。[W04]

缓存静态表现资源，不缓存/回放登录 POST、角色事实、背包变化、任务结算和 WebSocket 消息。刷新后玩家恢复继续遵守现有服务端会话和快照机制。

## 6. 手动“强制更新”：定义清楚，避免破坏数据

### 6.1 页面位置与可恢复性

登录首页右下角增加同一个 DOM 操作区：`强制更新`、`下载桌面客户端`，旁边可展示当前前端/资源版本。默认仅登录首页显示；进入频道、创角、游戏后隐藏或明确退出后再执行，避免打断输入和业务提交。

优先由 `PageShell` 装配独立 `ClientActionsView`。它不能依赖巨大 manifest、角色外观和 Phaser 初始化成功，否则资源坏掉时恢复按钮也会一起消失。[R05][R10]

`EntryView.render()` 会重写自己的 DOM，不能把按钮直接追加到其内部后就假定一直存在。现有 PageShell 又会把 footer 等节点在欢迎页和消息窗之间搬动，新操作区不应被这段逻辑误搬进游戏消息窗。[R05][R10]

保留右下角现有版本/频道标识的位置，适配小窗、缩放和安全区；按钮用真实 `<button>`，支持 Tab/Enter/焦点返回和 `aria-live` 状态。不要用 Phaser 文本实现页面更新按钮。

### 6.2 按钮的两种明确行为

默认行为：**强制联网检查最新兼容发布，重新装载页面与资源清单；有变化的静态文件使用新地址，未变化的文件允许继续复用。** 这不是强制把所有地图下载一遍。

在同一更新对话框提供“同时重新下载所需资源”的修复选项，用于同版本本地资源异常。该选项只影响当前/后续实际用到的资源，不触发全世界预下载。不把“已经最新”误报成“重新下载全部完成”。

### 6.3 状态机与提交时机

```text
空闲
 → 检查更新（重复点击被合并）
 → 校验发布描述、代码/协议/内容兼容性
 → 校验必要的清单与登录启动资源
 → 待应用
 → Web 重载 / 桌面确认程序升级
 → 完成；失败则给出可重试原因
```

检查使用 `fetch(..., {cache: 'no-store'})`；需要绕过已有 HTTP 副本并更新同地址缓存的受控 fetch，可使用 `cache: 'reload'`。这两者不是 CacheStorage 的删除操作。[W05]

先检查再切换。检查失败时不清空现有缓存，不改当前发布选择，不清用户设置。提交后出现网络中断仍可能导致新页面加载失败，恢复入口要允许重试；不能承诺跨导航、断网情况下绝对无损回滚。旧版本只有在后端仍兼容且保留了资源时才能被选择，不能为了“回滚成功”放宽版本校验。

Web 导航到经校验的新发布入口，利用新 HTML 对应的新哈希代码地址更新应用。禁止把 `location.reload(true)` 当作跨浏览器强制更新实现；该参数不是通用标准能力。[W06]

### 6.4 同版本修复：别把 Date.now 填到每个正常请求

推荐先实现上述更新契约；修复选项随统一资源 URL 接入一起实现。

对于 JSON 可用 fetch 的缓存策略强制重取。对于现有 Phaser/XHR、DOM 图像等不便统一传 Request.cache 的消费者，可以采用**仅在用户确认修复时改变的 cacheEpoch**，在传输 URL 上加 `ce=<本次修复代数>`，逻辑 key 不变。

这个代数在普通刷新时保持不变；只有明确修复操作才改变。浏览器可把该代数的资源继续缓存，避免修复后的每次刷新都重新下载。服务端/CDN 必须明确处理该参数，修复变体可设置 private 缓存以免形成公共 CDN 的无界变体；旧 HTTP 副本由浏览器管理，不宣称网页已把它们全部删除。

偏好存储不可用时，用本页内存和非敏感 URL 参数携带代数。不能依赖写入 localStorage 成功才能修复。新用户无代数时继续走正常内容哈希地址；不将代数当作服务端内容版本。

第一版修复完成以重新进入目标页面所需资源加载成功为准，不声称未访问地图也已经重新下载。全局 CSS 中未经过 resolver 的游戏美术 URL 必须迁移或登记为尚未覆盖，不能漏掉后仍宣布修复覆盖全部资源。

### 6.5 严禁事项

不调用 `localStorage.clear()`，不清空整个 IndexedDB，不发送 `Clear-Site-Data: "*"`，不清 Cookie，不批量注销同来源所有 Service Worker，不动服务端 SQLite、玩家账号、键位和语言偏好。

若未来存在本应用注册的 Worker/缓存，只清理已确认归属本应用且不再使用的资源命名空间。多标签页只广播“有新发布”，不强制替其他正在游戏的页面卸载资源；清理放到发布保留窗口之外。

## 7. 按图加载：真正减少刷新和首次进图成本

这一阶段独立于缓存正确性。先保持既有 preload 语义验证缓存，再在功能开关下缩小集合，便于判断回归来自哪里。

| 资源组 | 触发时机 | 内容范围 |
| --- | --- | --- |
| 恢复/登录壳 | 页面打开 | 更新/下载控件、基本登录 UI、最小必要素材 |
| 角色选择 | 到达相应阶段 | 当前角色预览和所需外观层，不要求所有外观全解码 |
| 首个游戏场景 | 获得入场目标 | 当前地图图层、当前 BGM、基础玩家动作、必需 HUD 与碰撞显示数据 |
| 场景动态依赖 | 当前地图/快照/表现事件发现缺失 | 当前 NPC/怪物/反应物、他人外观、技能与掉落表现 |
| 相邻地图预取 | 空闲、网络允许 | 有界的下一地图静态字节，不在首屏阻塞等待 |
| 大图鉴/世界地图等 | 首次打开相应窗口 | 该窗口需要的目录与素材 |

不能只把 `maps = [当前图, ...全部地图]` 改成 `[当前图]` 就称为完成。当前其他玩家外观、技能、怪物与反应物也依赖全量预加载；缩小集合后必须有可靠的动态补齐路径、占位规则与错误反馈。[R08]

加载器区分“下载字节”与“解码/创建 GPU 纹理”。相邻图预取不应为了暖 HTTP 缓存，先把所有纹理创建进 GPU。Phaser 与 DOM 不需要的跨缓存预热重复下载，应通过观测后移除。

每次换图分配代数，旧地图晚到的异步结果不能覆盖新地图；可以取消不再需要的网络任务，但不能取消另一个共享消费者仍在使用的同一下载。共享图像与角色纹理的 GPU 释放需要引用归属或明确的保留集合，不能地图 shutdown 时清空整个 TextureManager。

玩家和服务器照常通信。地图资源慢时，保存最新可显示快照而不是积压、回放全部历史业务事件；不延迟服务器结算、不从缓存重发拾取或购买请求。

## 8. 开发实时生效与生产缓存互不干扰

继续使用统一入口、Rust 3010 和 Vite 5173。先新增显式 dev/status/stop-dev 分派并验证未知参数拒绝，再讨论把双击默认行为切到 dev。保留当前构建发布路径，避免悄悄改变用户“启动当前候选版本”的既有操作。

已有 `build-release.cjs` 的锁、候选校验、回滚、进程身份保护继续使用。dev 应复用兼容实例，不因一行 CSS 保存重启 Rust 或创建新机器人。[R02][R03]

Vite 固定端口、`strictPort: true`；明确本机模式与用户启用的局域网模式。不要为了跨平台打开全目录读取、宽泛 CORS 或 `allowedHosts: true`。当前 `dev` 脚本显式带 `--host 0.0.0.0`，修改配置默认值时也要核对 CLI 覆盖。[R01][R04]

开发模式不启用生产长期美术缓存或应用级资源持久缓存。只监听源码和完整资源装配完成标记；不要监视全部 WZ、Cargo target、数据库和日志，也不要每生成一张 PNG 就刷新一次。

CSS 原位更新；一般 TS 初期允许整页刷新；选定的 HUD/表现叶子完成 dispose 和状态投影后再接 HMR。不得给整个 `main.ts` 加空的 self-accept 伪装热替换。Vite 的 accept/dispose/invalidate 是工具接口，不会替游戏处理旧实例、事件监听和 GPU 释放。[W14]

页面身份应区分源码开发/生产 Web/桌面包，并显示真正的 buildId、assetRevision、协议/内容版本。开发配置求值时间不能冒充最后一次成功应用源码的时间。

## 9. 桌面方案对比与选择

| 方案 | 与“保持 Web 业务不变”的适配 | 主要代价 | 本项目建议 |
| --- | --- | --- | --- |
| PWA/浏览器安装 | Web 代码复用直接 | 安装/更新受浏览器机制控制；不是本需求中的独立签名安装包发布链 | 可另作可选入口，不替代桌面包 |
| Tauri 2 | 复用 Vite 静态前端；Rust 外壳只承担少量系统能力 | 系统 WebView 差异、跨来源、签名分发和权限需要验证 | **优先 POC** |
| Electron | 同样复用 Web 代码；随程序带 Chromium/Node.js | 需管理随包运行时与安全更新，实际体积与内存由成品测量 | WebKit 等成为实际阻塞时的备选 |
| 重写成独立原生/游戏引擎客户端 | 难以维持同一业务实现 | 两套表现/平台逻辑与长期同步成本 | 本轮不采用 |

Tauri Windows 使用 WebView2，macOS 使用 WKWebView，Linux 使用 WebKitGTK；它不是“给所有平台打包同一个 Chromium”。不要承诺一定比浏览器快，也不要把空壳体积当成整个游戏安装体积。[W08][W13]

### 9.1 推荐的包内容与运行模式

桌面端内置当前签名发布的 HTML/JS/CSS 和必要的小型启动素材；地图资源按兼容的 assetRevision 从资源服务按需获取。首轮继续使用 WebView 的 HTTP 资源加载，暂不加 Rust 文件缓存。

继续连接远端 Rust 权威世界。Tauri 自己的 Rust 只属于操作系统外壳，**不是第二份权威服务器**。不分发用户数据库、bot 凭据、原始 WZ 工作目录、Cargo target 或整套 `build/current`。

优先采用本地打包前端，而不是默认远程网页加高权限原生桥。这样普通 Web 与桌面复用业务源码，但桌面程序代码随签名包更新；内容资源可以在兼容契约内独立更新。

### 9.2 必须解决的环境差异

HTTP API 改为从 Endpoints 获取地址；浏览器原生 WebSocket 继续使用，不把所有网络逐字节搬进 Rust IPC。服务端对打包后的真实来源配置精确 CORS；WebSocket 的 Origin 校验单独核对，CORS 并不能替代它，token/hello 校验也不能删除。

游戏资源与 Vite 打包的 JS/CSS 分开解析：应用代码在桌面本地，远程 `assetBase` 只适用于游戏静态内容。不能把所有 `/assets` 一刀切重定向到 CDN，否则本地打包的入口 chunk 也会被错误迁走。

Tauri 插件导入限制在 `platform/tauri.ts` 等适配层，浏览器路径不执行原生 API。原有登录、选角、移动、技能和背包调用不分叉成两套业务。

中文输入法、全屏/窗口缩放、高 DPI、键盘焦点、音频解锁与编解码、WebGL 能力、纹理限制、失焦恢复和上下文丢失都纳入验收。尤其要测试仓库实际使用的音频格式，不能只测登录页和一个空画布。

### 9.3 开发模式成功不等于发布包成功

`tauri dev` 可能仍加载 Vite 的 5173 地址，API/WS 由 Vite 代理，因此会掩盖原生发布包的来源、CORS、绝对 URL 和资源路径问题。

验收必须包含真正构建并安装的包，且在没有本地 Vite、没有本机 3010、没有源码 public 目录的环境运行。Tauri 官方的 `frontendDist: ../dist` 是示例，不能直接套到本仓库。[W07]

### 9.4 原生权限边界

只启用已用到的窗口、更新、外部链接打开等能力；不打开通配 shell/文件系统权限，不给不可信远程页面原生命令权限。自定义 Rust commands 也应显式收窄暴露范围，不能以为加了一个 capabilities 文件就自动约束一切。[W09]

CSP 按资源来源配置 `connect-src`、`img-src`、`media-src` 等；不关闭 Web 安全检查来“修好跨域”。现有 DOM UI 有动态样式，应先盘点再配置可用的策略，而不是声称随手放一个最严格 CSP 就能直接运行。外部链接走系统浏览器并限制 scheme/目标范围。[W10]

## 10. 桌面下载安装包与程序更新分开实现

### 10.1 首页下载入口

按钮文案是“下载桌面客户端”。点击打开小型平台选择面板，列出实际已发布的 Windows/macOS 包、架构、版本、大小、发布日期与校验信息。根据浏览器信息推荐平台但允许手动选择，不能仅靠 UA 猜架构后强制下载。

Windows 可交付 NSIS `.exe`/MSI；macOS 交付 `.dmg`。Linux 在经过图形/音频验证后再公布，未测试的平台显示暂未提供，不伪造下载链接。实际格式、签名和平台要求以锁定的 Tauri 工具链为准。[W11]

使用普通下载链接/跳转获取安装包，让浏览器处理大文件下载；不要先 fetch 整个安装包进 JS 内存再做 Blob。下载响应按需支持 Content-Disposition 与 Range，链接采用不可变版本路径；下载目录本身不长期缓存。

在安装包真正发布前，按钮可以显示“桌面版准备中”或在面板列出未提供状态。不能把源码 ZIP、服务器程序或未签名临时构建标成正式客户端。

### 10.2 构建与发布流水线

拟在 `client/src-tauri/` 放薄壳；为桌面建立独立输出暂存区，例如 `build/desktop/<target>/<buildId>/frontend`。脚本生成/选择与该区一致的 `frontendDist`。桌面构建不写正在运行的 `build/current`，也不与现有 paired release 的 `build/tmp` 争用可清空目录。

Vite 配置用受控的构建目标参数选择输出位置，默认 Web 目标保持现状。统一启动入口和 Tauri hook 要明确谁拥有 Vite 进程，不能两边同时启动两份开发服务。

CI 流水线：源码与依赖锁定 → 前端/平台检查 → 目标系统构建 → 安装包内容审计 → 平台签名/公证 → 生成 updater 签名及摘要 → 上传不可变制品 → 验证可下载 → 最后发布下载目录与更新指针。[W12]

使用对应平台 runner，不假设在一台 Mac 上就能完整构建、签名、验收所有平台。不要为了本任务顺便升级 Vite/Phaser/Three 的主版本；当前 Tauri Vite 指南已按 Vite 8 书写，而项目依赖声明仍为 Vite 7，须对照锁定版本合并配置。[R04][W07]

### 10.3 “强制更新”在桌面里的含义

同一 UI 意图通过平台适配调用：Web 更新页面/资源；桌面同时检查“内容资源”和“程序安装包”，分别显示状态。桌面内可把第二个控件替换为“客户端版本/检查程序更新”，无需反复推荐下载自己所在的平台包；这种 UI 适配不应扩散到游戏业务。

Tauri updater 要求更新签名，不能关闭该校验。公钥随客户端，私钥仅放受控发布环境；更新签名与操作系统代码签名/公证是不同责任。[W17][W18]失败安装、签名不匹配、下载中断都应有明确结果，不以“已刷新”代替真正升级。[W15][W11]

程序更新在玩家确认并安全退出当前会话后应用。内容版本与协议仍采用当前严格兼容策略；不在这个改造中偷偷放宽。当前源码审查不能证明已具备公网域名、TLS、资源服务、平台签名身份和发布密钥；这些是正式分发前须落实的部署条件，而不是下载按钮自动提供的能力。服务端发布造成旧桌面包不兼容时，必须保证兼容的新安装包已可下载，或明确阻止登录并提供升级入口。

第一版不下载任意远程 JS 覆盖本地程序绕开签名链。需要类似启动器的独立前端代码热分发时，另设完整的签名、权限、回滚和兼容协议，不把它混进“美术缓存”。

## 11. 文件级实施清单

“修改”为本次已核对的现有文件；“拟新增”为建议位置，实施时仍需检查同名实现。

| 文件/范围 | 操作 | 交付内容 |
| --- | --- | --- |
| `启动3010.command` | 修改 | 显式模式分派、Vite 身份/生命周期、保留发布行为与原有保护 |
| `client/vite.config.ts` | 修改 | 固定开发端口、开发/生产资源策略、桌面独立输出参数 |
| `client/package.json` | 修改 | 必要模式脚本与 Tauri 依赖；保留锁文件与现有检查 |
| `scripts/build-release.cjs` | 修改 | 发布元数据绑定 assetRevision；复用既有事务和校验 |
| `server/src/main.rs` | 小改 | 挂载静态交付/发布描述路由，保持权威世界启动顺序 |
| `server/src/client_delivery.rs` | 拟新增 | 发布描述、资源路径、HTTP 缓存头、错误码与兼容校验 |
| `scripts/index_client_assets.cjs` | 拟新增 | 资源摘要、引用索引、不可变对象与候选校验 |
| `client/src/assets/resource-client.ts` | 拟新增 | 资源/清单获取、同修订请求合并、失败重试边界 |
| `client/src/assets/resource-url.ts` | 拟新增 | 逻辑资源映射、资源来源、手动修复代数 |
| `client/src/assets/manifest.ts` | 修改 | 消费发布固定的清单；保留现有版本与内容校验 |
| `client/src/assets/preload-plan.ts` | 修改，分两步 | 先只接 URL 解析保持全集；后增加按图与共享依赖计划 |
| `client/src/scenes/world.ts` | 小改 | 执行计划、代数取消、加载进度、windbell 音频适配 |
| `client/src/features/windbell/scene.ts` | 小改 | 动态 JSON/图片路径统一解析，不改变玩法和美术布局 |
| `client/src/app/page-shell.ts` | 小改 | 装配首页控件、显示/隐藏、对称清理，不直接写更新流程 |
| `client/src/features/entry/view.ts` | 小改 | 清单获取复用、首页阶段通知、保留账号/选角业务 |
| `client/src/network/auth-api.ts`、`session.ts` | 小改 | 使用 Endpoints，保留协议、终止码、重连语义 |
| `client/src/features/entry/api.ts` | 小改 | lobby 地址适配，保持 POST/鉴权行为 |
| `client/src/features/client-actions/*` | 拟新增 | 两按钮、更新状态机、下载平台面板、样式与定向测试 |
| `client/src/platform/*`、`network/endpoints.ts` | 拟新增 | 环境配置、Web/Tauri 小适配器与受校验端点 |
| `client/src-tauri/*` | 拟新增 | 本地前端薄壳、能力限制、程序更新与包配置 |
| `scripts/build-desktop.cjs` | 拟新增 | 独立桌面暂存区、内容白名单、生成配置与构建入口 |
| `.github/workflows/desktop-release.yml` | 拟新增 | 分平台构建、签名、上传与发布门禁 |
| `docs/plan/topics/...v3.md`、`docs/plan/PLAN.md` | 建议文档更新 | v3 决策细节；当前行动只在 PLAN 维护，不重复状态台账 |

## 12. 增量顺序、验收与回滚

| 阶段 | 最小可交付范围 | 必须验收 | 回滚方式 |
| --- | --- | --- | --- |
| P0 基线 | 固定源码/本地修改、旧方案修订、采集冷/热加载 | 确认请求来源、传输量、预加载集合；不以旧文当现状 | 只读，无运行改动 |
| P1 源码入口 | 统一入口的显式 dev、固定 5173、必要身份显示 | 改真实 CSS/TS 生效；复用 Rust；未知参数不触发重启 | 保留当前发布入口，不改变 DB |
| P2a 资源交付 | 不可变对象、发布描述、缓存分类、URL 适配 | 同版本刷新复用；禁用缓存联网；缺文件真 404；版本不混读 | 受控切回旧交付路径，旧路径 no-cache，不绕过版本校验 |
| P2b 首页控件 | 独立更新按钮、修复选项、下载面板 | 资源清单坏时仍能恢复；更新失败不清设置；未发布包不假链接 | 隐藏新控件，保留资源版本契约 |
| P3 按图加载 | 在开关下缩小计划，补齐动态依赖 | 冷进图集合缩小；别人技能/外观不缺；换图竞态正确 | 切回现有全量 planner；协议和角色事实不变 |
| D0 Tauri POC | 同一前端、本地打包、远端端点、最小权限 | 真安装包无 Vite/本地 3010 可连接；Windows/macOS 完整主循环 | 不发布桌面入口；Web 不回退 |
| D1 桌面分发 | 签名包、下载目录、程序升级 | 下载匹配平台；篡改签名被拒；升级保留设置；兼容门禁 | 撤下错误版本指针，保留已发布对象与可诊断恢复路径 |
| P4 可选增强 | HUD 局部 HMR、预取、按预算的应用/原生缓存 | 有真实测量收益，禁用与恢复契约不被破坏 | 各增强独立关闭 |

P2a 与 P2b 可以拆成更小 PR，但不可在资源仍可变时先启用一年缓存。D0 可在 P2 URL 与端点接口稳定后并行验证；D1 只发布真实通过验收的平台。渲染器替换不成为这些任务的前置条件。

## 13. 验收矩阵：不能只看“页面能打开”

| 编号 | 用例 | 通过标准 |
| --- | --- | --- |
| C01 | 新浏览器配置首次登录进图 | 所需资源正常下载，首个可交互画面与服务器快照一致 |
| C02 | 同发布、缓存未驱逐时刷新 | 已缓存的大型静态正文基本不重复传输；版本/条件请求单独统计 |
| C03 | DevTools Disable cache | 资源真实从网络加载，缓存缺失不报业务错误 |
| C04 | 阻止站点存储或模拟存储异常 | 更新控件、登录和地图仍可工作；不因偏好写失败中止 |
| C05 | 无痕/浏览器驱逐资源 | 缺项正常回源；不宣称资源永远保留 |
| C06 | 同发布损坏/缺失某个资源 | 显示具体阶段，可重试/修复；错误 HTML 不被当成 PNG/JSON |
| C07 | 仅一个资源变化 | 新摘要资源生效；未变化资源地址稳定，不因代码时间戳全失效 |
| C08 | 两个清单发布期间交错请求 | 入口与世界绑定同一修订；不出现新 manifest + 旧 appearance |
| U01 | 点击强制更新两次 | 单个有效更新任务，状态可解释，无并发清理 |
| U02 | 强制检查时断网/返回错误 | 不清当前配置、语言、键位、账号记录，不假报成功 |
| U03 | 同版本选择资源修复后再刷新 | 修复代数保持稳定，正常刷新重新获得复用效果 |
| U04 | 新版本与后端不兼容 | 停止进入世界并提供更新说明，不自动放宽校验 |
| U05 | 另一个标签页仍在游戏 | 不强制拆场景，不删掉其正在使用的资源 |
| L01 | 当前图第一次加载 | 不再等待所有地图/BGM；依赖集合可审计 |
| L02 | 其他玩家穿新外观/释放未见技能 | 动态补齐或明确占位后恢复，不出现永久缺图 |
| L03 | 连续快速换图 | 旧请求结果不覆盖当前图，待加载资源有界 |
| L04 | 多次换图再返回 | CPU/GPU 资源保留与释放可解释，不清共享纹理、不无限增长 |
| H01 | 连续 CSS HMR | 不重建业务连接，不重发 hello/购买/技能请求 |
| H02 | TS 修改和编译失败 | 成功修改真实可见；失败不显示伪“更新成功” |
| H03 | dev 与 build 并行 | 构建不清空当前服务目录；开发不读旧构建美术兜底 |
| D01 | 真安装包在干净机器启动 | 不依赖源码路径、Vite、localhost:3010 或开发资源目录 |
| D02 | Windows/macOS 主循环 | 登录/选角/切图/聊天/中文输入/音频/缩放/重连可用 |
| D03 | 桌面程序升级 | 使用正确平台包，签名错误被拒，失败不删除用户偏好 |
| D04 | 安装包内容检查 | 不含服务器数据库、bot 凭据、签名私钥和源素材工作目录 |
| D05 | 远端恶意 URL/配置 | 拒绝非法 scheme/越界路径/未授权原生操作 |
| D06 | 退出并重启桌面包、缓存被清理 | 可用缓存正常复用；缓存缺失正常联网；按各平台实测记录，不以浏览器结果替代 |

浏览器测试至少覆盖目标 Chrome/Edge 与 Safari；Tauri 另外覆盖真实 WebView，不以普通浏览器测试替代。精确最低系统版本、安装体积、冷启动/帧率和内存目标在 P0/D0 记录实测后确定，不能从空壳示例推导本游戏表现。

## 14. 观测、检查和交付记录

每次测试记录 `frontendBuildId / assetRevision / protocolVersion / contentVersion / platform`，以及入口可交互、manifest 就绪、资源下载、场景 ready、首个快照和进图总耗时。区分资源请求数、实际传输字节、缓存命中来源与解码/渲染时间。

资源诊断不记录密码、token 和私人 API 正文。跨来源 Performance Resource Timing 信息可能不完整，应以 DevTools/HAR 和服务端日志交叉验证，不仅凭 `transferSize === 0` 判定缓存命中。[W16]

本仓库已有类型检查、客户端检查脚本和 Rust 测试体系；实施者先记录当下基线，再跑新增定向测试与必要回归。不得复制历史文档中的“全绿/失败数”当作本轮结果，也不得为了测试通过清除用户实际数据库。

每个 PR 的交付记录至少包含：改动文件、保持不变的业务语义、测试命令与实际结果、未验证场景、回滚开关、是否影响发布/数据库/协议、用户可见变化。需要运行完整游戏资源的测试，应在具备资源的授权工作区中进行。

## 15. 给实施 Agent 的硬边界

1. 不以“实时渲染”为名改写背包、任务、战斗、服务器规则或网络协议。
2. 不回退 `build/tmp → current/previous` 的既有发布治理；不恢复构建时全量复制 public 的旧行为。
3. 不重复修已经修复的 `Connection.closeSocket()` 逻辑；新增环境适配只改地址来源与展示。
4. 不把缓存作为资源获取的唯一途径；不声称 HTTP 缓存可由网页统一枚举和清空。
5. 不在资源未不可变时设置 immutable；不对每个正常请求加当前时间。
6. 不把按图加载简化为删掉一个循环；补齐动态角色、技能和音频依赖后才能开默认。
7. 不在 Tauri 中启动第二个权威世界；不为了“不改前端”关闭安全检查或给远端页面宽权限。
8. 不把 Web 刷新、静态资源更新、桌面安装升级混为一种动作；各自有成功条件。
9. 不先自动启停 3010、机器人、清库或覆盖用户本地修改；运行类验收遵守当前工作区权限和既有保护。
10. 不把本计划当成已验收实现。先交最小增量，用数据证明刷新传输和进图成本确实下降。

**最终方向：同一份 Web 业务，通过明确的资源与环境边界，同时支持源码开发、浏览器交付和桌面交付。缓存负责少下载，按图加载负责少初始化，Tauri 负责系统外壳，Rust 服务器继续负责世界事实。**


## 16. 取证与参考资料

仓库链接全部固定到本次审查提交，避免 main 后续变化造成结论漂移。官方网页查阅日期为 2026-09-17；实施时按项目锁定版本核对 API，不照搬网页示例中的最新依赖版本。

### 16.1 仓库依据

| 编号 | 文件与用途 |
| --- | --- |
| [R00] | `docs/plan/topics/MapleStory_TMS273_Web_Realtime_HMR_Repo_Reviewed_v2.md` — 旧方案：启动、HMR、资源一致性与构建职责 |
| [R01] | `client/vite.config.ts` — 开发代理、publicDir 分离、build/tmp 输出 |
| [R02] | `启动3010.command` — 当前发布式启动、进程保护和资源路径 |
| [R03] | `scripts/build-release.cjs` — 候选目录、发布锁、metadata 与校验 |
| [R04] | `client/package.json` — 现有脚本与 Phaser/Three/Vite 依赖声明 |
| [R05] | `client/src/app/page-shell.ts` — 页面装配、footer 搬移与模式切换 |
| [R06] | `client/src/app/main.ts` — 现有主入口、Phaser 与前端对象装配 |
| [R07] | `client/src/assets/manifest.ts` — 资源清单获取、contentVersion 验证、appearance 获取 |
| [R08] | `client/src/assets/preload-plan.ts` — 全地图/全局资源预加载与 URL key |
| [R09] | `client/src/scenes/world.ts` — Phaser 场景、loader 入队、地图重启 |
| [R10] | `client/src/features/entry/view.ts` — 登录资源并行请求与 DOM 重建 |
| [R11] | `client/src/network/session.ts` — location.host 拼 WS、已修复 closeSocket 生命周期 |
| [R12] | `client/src/network/auth-api.ts` — 同源登录/注册与严格版本检查 |
| [R13] | `client/src/features/entry/api.ts` — lobby POST 与 token 行为 |
| [R14] | `server/src/main.rs` — 静态资源分层路由、API 和权威服务组装 |
| [R15] | `client/src/features/windbell/scene.ts` — 额外 JSON/图片加载与动态入队 |
| [R16] | 本次固定源码提交 |

### 16.2 官方技术资料

| 编号 | 资料 |
| --- | --- |
| [W01] | MDN：HTTP caching |
| [W02] | MDN：Cache API 与 HTTP 缓存头的区别 |
| [W03] | Chrome DevTools：Disable cache、请求与传输分析 |
| [W04] | MDN：存储配额、失败与驱逐 |
| [W05] | MDN：Request.cache 的 default/reload/no-store 语义 |
| [W06] | MDN：Location.reload 与非标准 forceGet 参数 |
| [W07] | Tauri 2：复用 Vite、devUrl、frontendDist；当前示例基于 Vite 8 |
| [W08] | Tauri 2：各平台 WebView |
| [W09] | Tauri 2：Capabilities、原生命令与远端访问边界 |
| [W10] | Tauri 2：Content Security Policy |
| [W11] | Tauri 2：安装包与平台分发 |
| [W12] | Tauri 2：GitHub 分平台构建与发布 |
| [W13] | Electron：随应用分发 Chromium 与 Node.js |
| [W14] | Vite 7：HMR API |
| [W15] | Tauri 2：签名更新、更新端点与平台制品 |
| [W16] | MDN：资源计时与跨来源信息限制 |
| [W17] | Tauri 2：macOS 签名与公证 |
| [W18] | Tauri 2：Windows 签名 |

---

[R00]: https://github.com/dragon717/MapleStory/blob/39c8bea8980b553a49acfab68fd44c4eda789d5d/docs/plan/topics/MapleStory_TMS273_Web_Realtime_HMR_Repo_Reviewed_v2.md "docs/plan/topics/MapleStory_TMS273_Web_Realtime_HMR_Repo_Reviewed_v2.md"
[R01]: https://github.com/dragon717/MapleStory/blob/39c8bea8980b553a49acfab68fd44c4eda789d5d/client/vite.config.ts "client/vite.config.ts"
[R02]: https://github.com/dragon717/MapleStory/blob/39c8bea8980b553a49acfab68fd44c4eda789d5d/%E5%90%AF%E5%8A%A83010.command "启动3010.command"
[R03]: https://github.com/dragon717/MapleStory/blob/39c8bea8980b553a49acfab68fd44c4eda789d5d/scripts/build-release.cjs "scripts/build-release.cjs"
[R04]: https://github.com/dragon717/MapleStory/blob/39c8bea8980b553a49acfab68fd44c4eda789d5d/client/package.json "client/package.json"
[R05]: https://github.com/dragon717/MapleStory/blob/39c8bea8980b553a49acfab68fd44c4eda789d5d/client/src/app/page-shell.ts "client/src/app/page-shell.ts"
[R06]: https://github.com/dragon717/MapleStory/blob/39c8bea8980b553a49acfab68fd44c4eda789d5d/client/src/app/main.ts "client/src/app/main.ts"
[R07]: https://github.com/dragon717/MapleStory/blob/39c8bea8980b553a49acfab68fd44c4eda789d5d/client/src/assets/manifest.ts "client/src/assets/manifest.ts"
[R08]: https://github.com/dragon717/MapleStory/blob/39c8bea8980b553a49acfab68fd44c4eda789d5d/client/src/assets/preload-plan.ts "client/src/assets/preload-plan.ts"
[R09]: https://github.com/dragon717/MapleStory/blob/39c8bea8980b553a49acfab68fd44c4eda789d5d/client/src/scenes/world.ts "client/src/scenes/world.ts"
[R10]: https://github.com/dragon717/MapleStory/blob/39c8bea8980b553a49acfab68fd44c4eda789d5d/client/src/features/entry/view.ts "client/src/features/entry/view.ts"
[R11]: https://github.com/dragon717/MapleStory/blob/39c8bea8980b553a49acfab68fd44c4eda789d5d/client/src/network/session.ts "client/src/network/session.ts"
[R12]: https://github.com/dragon717/MapleStory/blob/39c8bea8980b553a49acfab68fd44c4eda789d5d/client/src/network/auth-api.ts "client/src/network/auth-api.ts"
[R13]: https://github.com/dragon717/MapleStory/blob/39c8bea8980b553a49acfab68fd44c4eda789d5d/client/src/features/entry/api.ts "client/src/features/entry/api.ts"
[R14]: https://github.com/dragon717/MapleStory/blob/39c8bea8980b553a49acfab68fd44c4eda789d5d/server/src/main.rs "server/src/main.rs"
[R15]: https://github.com/dragon717/MapleStory/blob/39c8bea8980b553a49acfab68fd44c4eda789d5d/client/src/features/windbell/scene.ts "client/src/features/windbell/scene.ts"
[R16]: https://github.com/dragon717/MapleStory/commit/39c8bea8980b553a49acfab68fd44c4eda789d5d "本次固定提交"
[W01]: https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching "MDN：HTTP caching"
[W02]: https://developer.mozilla.org/en-US/docs/Web/API/Cache "MDN：Cache API 与 HTTP 缓存头的区别"
[W03]: https://developer.chrome.com/docs/devtools/network/reference/ "Chrome DevTools：Disable cache、请求与传输分析"
[W04]: https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria "MDN：存储配额、失败与驱逐"
[W05]: https://developer.mozilla.org/en-US/docs/Web/API/Request/cache "MDN：Request.cache 的 default/reload/no-store 语义"
[W06]: https://developer.mozilla.org/en-US/docs/Web/API/Location/reload "MDN：Location.reload 与非标准 forceGet 参数"
[W07]: https://v2.tauri.app/start/frontend/vite/ "Tauri 2：复用 Vite、devUrl、frontendDist；当前示例基于 Vite 8"
[W08]: https://v2.tauri.app/reference/webview-versions/ "Tauri 2：各平台 WebView"
[W09]: https://v2.tauri.app/security/capabilities/ "Tauri 2：Capabilities、原生命令与远端访问边界"
[W10]: https://v2.tauri.app/security/csp/ "Tauri 2：Content Security Policy"
[W11]: https://v2.tauri.app/distribute/ "Tauri 2：安装包与平台分发"
[W12]: https://v2.tauri.app/distribute/pipelines/github/ "Tauri 2：GitHub 分平台构建与发布"
[W13]: https://www.electronjs.org/docs/latest/ "Electron：随应用分发 Chromium 与 Node.js"
[W14]: https://v7.vite.dev/guide/api-hmr "Vite 7：HMR API"
[W15]: https://v2.tauri.app/plugin/updater/ "Tauri 2：签名更新、更新端点与平台制品"
[W16]: https://developer.mozilla.org/en-US/docs/Web/API/PerformanceResourceTiming "MDN：资源计时与跨来源信息限制"
[W17]: https://v2.tauri.app/distribute/sign/macos/ "Tauri 2：macOS 签名与公证"
[W18]: https://v2.tauri.app/distribute/sign/windows/ "Tauri 2：Windows 签名"
