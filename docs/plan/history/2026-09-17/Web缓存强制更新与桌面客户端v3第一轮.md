# Web 实时开发、资源缓存、强制更新与桌面客户端（v3）第一轮增量

> 日期：2026-09-17。主计划：`docs/plan/topics/MapleStory_Web_Cache_Force_Update_Tauri_Plan_v3_2026-09-17.md`；
> 旧实时/HMR 方案：`docs/plan/topics/MapleStory_TMS273_Web_Realtime_HMR_Repo_Reviewed_v2.md`（目标保留，路径按 v3 修订）。
> 范围：V3-P0 / P1 / P2a / P2b。**V3-P3 与 V3-D0/D1、V2-HMR、V2-R1~R3 本轮未做**，不写成已完成。

## 1. 接续前的真实起点（不是从零开始）

工作树里已经存在一批未提交改动（`git status`）：`启动3010.command` 的 dev/status/stop dev 分派、
`vite.config.ts` 的固定 5173 + `strictPort` + `__CODE_MODE__`、`client/src/network/endpoints.ts`、
`client/src/assets/resource-url.ts`、`client/src/platform/runtime-config.ts`，以及 9 个消费者的
`resolveAssetUrl` 接线。本轮**继续**这些，不重做，也不另起一套。

## 2. 实际改动

### 服务端（V3-P2a）

| 文件 | 改动 |
| --- | --- |
| `server/src/client_delivery.rs`（新增） | 发布描述、`classify()` 缓存分类、缓存头中间件、`ReleaseDescriptor` |
| `server/src/main.rs` | `mod client_delivery;`、挂载 `/api/client-release`、挂 `from_fn(apply_cache_headers)` 中间件 |

- **发布描述**：`/api/client-release`（`no-store`）。`releaseId` 取 `build/current/metadata.json`
  （复用既有发布元数据，不新建版本来源），读不到时如实为 `unversioned`；
  `assetRevision` 只在配置了 `ASSET_REVISION` 时才有值，否则 `null`；
  `desktop` 只在 `DESKTOP_RELEASE_FILE` 指向非空数组时才有值，否则 `null`。
- **缓存分类**：指纹产物（`index-<hash>.js/css`）与 `/assets/objects/<算法>/<摘要>.<ext>` →
  `public, max-age=31536000, immutable`；**过渡期固定名内容资源一律 `no-cache`**（源目录可被装配
  管线原地改写，不允许锁一年）；`/`、`*.html` → `no-cache`；`/api/*` → `no-store`；`/ws` 不分类。
- **中间件只在响应没有自带 `Cache-Control` 时写入**，不覆盖业务路由的显式策略。

### 客户端（V3-P2b）

| 文件 | 改动 |
| --- | --- |
| `client/src/features/client-actions/update-service.ts`（新增） | 更新状态机：合并点击、兼容性校验、入口 URL |
| `client/src/features/client-actions/desktop-downloads.ts`（新增） | 下载目录：形状校验、http(s) 白名单、平台推荐 |
| `client/src/features/client-actions/view.ts` + `style.css`（新增） | 首页右下角两枚按钮、确认框、下载面板 |
| `client/src/app/i18n.ts` | 新增 `CLIENT_ACTION_TEXT` 并接入 `uiText` 回退链 |
| `client/src/app/main.ts` | 构造 `ClientActionsView` 挂到 `#app`，`entry.onStageChange` 控制显隐 |
| `client/src/features/entry/view.ts` | 新增只读 `onStageChange` 通知（不改任何流程） |
| `client/src/assets/resource-url.ts` | 代数可由 URL 参数 `ce` 携带（偏好存储不可用时仍可修复） |
| `client/src/features/loading/view.ts`、`features/windbell/activities.ts` | 两处裸 URL 改走 resolver |
| `client/src/app/page-shell.check.mjs` | 补 `__CODE_MODE__` stub（新代码会读它） |

- **挂载位置**：`#app` 的直接子节点 —— 与 `PageShell` 会在游戏模式下搬进消息窗的
  header / `.world-toolbar` / `#message` / footer 是**兄弟**关系，不会被搬走；
  `body.game-mode` 时由 CSS 隐藏；`EntryView.onStageChange` 在频道/角色/创角阶段隐藏。
- **不依赖资源**：只向 `/api/client-release` 要描述，不导入 `assets/manifest`、不引用 Phaser。

### 门禁与检查

| 文件 | 内容 |
| --- | --- |
| `scripts/check_tms273_client_actions.cjs`（新增，已入 `run-checks.mjs`） | 8 组断言 |
| `client/src/features/client-actions/update-service.check.ts`（新增） | 6 组断言 |
| `client/src/features/client-actions/desktop-downloads.check.ts`（新增） | 4 组断言 |

## 3. 检查命令与结果

- `cargo test --manifest-path server/Cargo.toml client_delivery::` → **8 过 / 0 失败**；
  新文件 **0 告警**（测试构建仍 49 条，与基线同数；`CARGO_TARGET_DIR=/tmp/attr-target`）。
- `node scripts/check_tms273_client_actions.cjs` → **8 组断言通过**。
- `node --experimental-strip-types src/features/client-actions/update-service.check.ts` → **6 组通过**。
- `node --experimental-strip-types src/features/client-actions/desktop-downloads.check.ts` → **4 组通过**。
- **修掉三处被本轮/前一轮接线弄红的既有检查**（它们把模块内联进 data URL，
  新增的 `endpoints` / `resource-url` 导入解析不到）：
  `network/session.check.mjs`、`features/windbell/runtime.check.mjs`、`features/npc/dialogue.check.mjs`
  —— 三处都换成**恒等/同形**的本地桩，不动 Connection 与场景的语义断言。
- 手工跑过并 PASS：`app/page-shell.check.mjs`（补 `__CODE_MODE__` stub）、`app/i18n.check.ts`、
  `assets/preload-plan.check.mjs`、`features/notebook/view.check.mjs`、`features/ui/window-shell.check.mjs`、
  `features/hud/buff.check.mjs`。
- **类型检查**：`tsc --noEmit`（只含新模块的定向 tsconfig）**0 错误**。
- **未跑完**：`npm run check` 全量与全仓 `tsc --noEmit` 在本机 iCloud 卷上单次超过 30 分钟（实测
  启动 32 分钟仍在执行，已终止），本轮以定向方式核对；全量结果以用户机器为准。

## 4. 保持不变

- 协议 **24** / 内容 **`tms273-31`** / **198 图**零改动；服务端世界、战斗、背包、任务、碰撞一行未动。
- 无参数双击 `启动3010.command` 仍是原来的构建 + 轮替 + 启动流程（只加了显式子命令）。
- 生产构建仍不复制 843MB 内容数据；不恢复「每次构建复制全量美术」。
- 已修的 `Connection.closeSocket()` 生命周期未回退；未注册 Service Worker；未给正常请求加时间戳。

## 5. 未验证 / 待用户实跑

- `./启动3010.command dev|status|stop dev`（需已有 3010 在跑；本机沙箱读不到进程表）。
- 浏览器实测：同版本刷新的**传输字节**（不看请求行数）、Disable cache 时正常联网、
  `/api/client-release` 为 `no-store`、构建 JS/CSS 为一年 immutable、内容资源为 `no-cache`。
- 首页：连点两次「强制更新」只检查一次；断网时报错但账号记忆/语言/键位不变；
  勾选「重新下载所需资源」后刷新，资源重下且后续刷新恢复复用；未发布桌面包时无假链接。

## 6. 真实阻塞

- **V3-D1 分平台构建与签名**：缺目标系统 runner（不能在一台 Mac 上签 Windows 包）、
  代码签名/公证身份、发布域名与 TLS、updater 私钥 ⇒ **不提供下载地址、不伪造签名结果**。
- **V3-D0 真实安装包验证**：`client/src-tauri/` 尚未创建；且按 v3 §9.3，
  `tauri dev` 不能替代「无 Vite、无本机 3010 环境下真安装包可跑」的验收。
- **V3-P3**：必须先有可靠的动态补齐、换图代数与资源释放，不能只把全量循环删掉。
- **V2-R1~R3**：`three@^0.186` 已在依赖里，**安装不等于接入**；未过门槛不删除 Phaser。

## 7. 回退

- 服务端：`git revert` 或直接删掉 `client_delivery.rs` 与 `main.rs` 的两处挂载（其余行为不变）。
- 客户端：删掉 `features/client-actions/` 与 `main.ts` 的两行装配；`resource-url.ts` 在代数为 0 时
  是恒等函数，单独保留也不会改变任何请求。
- 门禁：`run-checks.mjs` 里去掉 `check_tms273_client_actions.cjs` 与两个 check 条目即可。
