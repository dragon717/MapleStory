# TMS273 现状入口取证（HMR 计划 P0 交付物）

> 对应 `docs/plan/topics/MapleStory_TMS273_Web_Realtime_HMR_Repo_Reviewed_v2.md` §3。
> 取证日期：2026-09-12。**本文所有结论都来自真实仓库读取**，未读到的项标「未测」。
> 本轮未执行构建、未重启服务、未改任何业务源码。

## 1. 结论先说：为什么「改了源码，页面没变化」

浏览器（以及陪测 bot）访问的 `http://127.0.0.1:3010/` 由 **Rust 进程直接从磁盘读取 `client/dist-tms273`** 提供，
而日常修改的是 `client/src/**` 源码。`client/src` 只有在执行 `npm run build`（`tsc --noEmit && vite build`）之后
才会产出到 `client/dist-tms273`。

而 `启动3010.command` 的**唯一行为**就是「构建 + 起服务」：它每次运行都会先 `cargo build` 再 `npm run build`，
所以在一个已经运行的实例上改源码，浏览器读到的仍然是上一次构建的产物。**这不是缓存问题，是产物/源码两条链路的问题。**

## 2. 启动链

`启动3010.command`（zsh，根目录，双击即用）实际步骤：

1. 定位 `ROOT`，进入项目根；控制文件在 `runtime/3010-control/`（pid/log/凭据）。
2. 前置校验：`client/public-tms273/assets`、`shared/gameplay.json`、`shared/map.json`、`shared/maps.json` 必须存在。
3. 校验 Node ≥ 22；用 `node --experimental-strip-types` 读 `shared/protocol.ts` 的 `PROTOCOL_VERSION` / `CONTENT_VERSION`。
4. `node scripts/check_tms273_runtime.cjs <CONTENT_VERSION>` 校验运行资源已装配（44 图 / 50663 处源引用）。
5. `cargo build --manifest-path server/Cargo.toml` → 失败则**不停止**正在运行的服务。
6. `cd client && npm run build` → 失败同样不停止旧服务。
7. `zsh 关闭3010.command` 停旧实例，再起新实例（`server/target/debug/maplestory-server`）。
8. 就绪判定不是「端口打开」：轮询 `/api/health`，要求 `ok === true` 且 `protocolVersion`、`contentVersion` 与源码一致。
9. 陪测 bot：`node bots/run.mjs demo`，`SERVER_URL=http://127.0.0.1:3010`，同样做 PID 身份校验与连接确认。

已经符合计划要求的部分：**只停本项目自己管理的进程**（`is_server_pid` / `is_bot_pid` 校验命令与 cwd），
没有 `pkill node` / 按端口盲杀；**编译失败不停当前服务**；就绪检查含协议/资源版本。这些不必重做。

尚缺的部分：**没有 dev / build / preview / status / stop 的模式契约**（计划 §5.1 的目标接口），
默认行为是「构建 + 服务」而不是「源码开发」。

## 3. 服务端路由与静态服务（`server/src/main.rs`）

```
/api/register  /api/login  /api/lobby            → Rust 处理器
/api/health                                       → { ok, protocolVersion, contentVersion }
/ws                                               → get(upgrade)  游戏 WebSocket
/assets                                           → ServeDir(dist/assets)  fallback  ServeDir(ASSETS_DIR)
/（其余全部）                                      → ServeDir(CLIENT_DIST)  not_found_service(index.html)
```

环境变量（由启动脚本注入）：`BIND_ADDR=0.0.0.0:3010`、`ACCOUNT_DB=server/data/tms273.sqlite3`、
`CLIENT_DIST=client/dist-tms273`、`ASSETS_DIR=client/public-tms273/assets`、`GAMEPLAY_FILE`、`MAP_FILE`、`MAP_CATALOG`。

**已确认的隐患（对应计划 §12.4 B04）**：`not_found_service(index.html)` 是 SPA 兜底，
所以缺失的 JS / 图片 / shader 请求会**返回 HTML 而不是 404**。诊断「资源静默缺失」时这是首要误判源。
同源下 `/assets` 是 `ServeDir` 真实目录，缺失资源在 `/assets` 路径下会正确 404，但其它路径不会。

## 4. 前端源码入口与构建

| 项 | 实测值 |
| --- | --- |
| 源码根 | `client/`（`client/package.json`、`client/tsconfig.json`、`client/vite.config.ts`） |
| HTML 入口 | `client/index.html`，一行 module 脚本：`<script type="module" src="/src/app/main.ts">` |
| 构建 | `npm run build` = `tsc --noEmit && vite build` |
| 产物目录 | `dist-tms273`（`build.emptyOutDir: true`） |
| 静态资源根 | `publicDir: 'public-tms273'`（WZ 转换产物与 `manifest.json`） |
| 渲染库 | **Phaser 3.90.0**（计划文中的 Three.js 是未核实的假设；实际运行时是 Phaser） |
| 版本注入 | `vite define` 注入 `__RELEASE_VERSION__`（`v${package.json.version}`）与 `__RELEASE_TIME__`（**构建时刻**） |
| Service Worker | **不存在**（`client/src` 与 `index.html` 均无 `serviceWorker` 注册） |

`client/vite.config.ts` 当前内容要点：

```ts
publicDir: 'public-tms273',
build: { outDir: 'dist-tms273', emptyOutDir: true, chunkSizeWarningLimit: 1600 },
server: { host: '0.0.0.0', proxy: { '/api': 'http://127.0.0.1:3010',
                                     '/ws': { target: 'ws://127.0.0.1:3010', ws: true } } },
```

## 5. 开发模式现状：已具备能力，但没接进统一入口

`npm run dev` = `vite --host 0.0.0.0`，默认端口 5173，已配置 `/api` 与 `/ws` 代理到 Rust 的 3010。
也就是说**源码开发链路在技术上已经通了**，缺的是把它纳入统一脚本与身份标识：

| 缺口 | 实测证据 | 计划要求 |
| --- | --- | --- |
| 入口端口不统一 | dev 在 5173，构建产物在 3010 | §4.1「保留浏览器访问端口 3010」 |
| 端口不固定 | `vite.config.ts` 未设 `server.port` / `strictPort` | §4.1 固定端口 + `strictPort`，防止悄悄换端口 |
| 代理目标硬编码 | `/api`、`/ws` 直接写字面量 3010 | §4.1「前端不得到处硬编码后端端口」 |
| 无模式标识 | 无 DEV_SOURCE / BUILT_PREVIEW，无 build ID / 实例号 | §5.4 |
| 无 HMR 边界 | 全仓无 `import.meta.hot` | §8 |
| 生产缓存策略未实现 | Rust 直接 `ServeFile(index.html)`，无 `Cache-Control` | §11.2 |

## 6. 资源管线（与前端解耦，本轮不动）

```
WZ（TMS273.7）
  → scripts/export_tms273_<模块>.cjs        → resources/tms273-export/<模块>.json + PNG
  → scripts/assemble_tms273.cjs             → client/public-tms273/assets/manifest.json
                                            → client/dist-tms273/assets/manifest.json
                                            → shared/*.json（gameplay / maps / skill / items …）
  → scripts/check_tms273_runtime.cjs        → 装配契约校验（44 图 / 50663 处源引用）
```

注意 `manifest.json` 有**两份**（`public-tms273` 与 `dist-tms273`），改数据时必须同源重写两份并逐键 diff。

## 7. 本轮未做的验证（明确交待）

- 未启动 Vite dev 服务器，因此**没有**实测「改一处 UI 源码 → 浏览器自动变化」。
- 未执行 `vite build`，因此没有新的产物指纹。
- 未重启 3010，未触碰数据库与陪测 bot。

## 8. 进入 HMR 计划 P1 前需要你确认的一件事

计划 §5.1 规定「`./启动3010.command` 默认进入 dev」。这会**改变双击启动的默认行为**
（从「构建 + 服务」变成「Vite 源码开发 + 内部 Rust」），并且验收必须真跑一次（即重启 3010）。
按项目既有约定（不擅自重启在线服务），这一步留给你决定何时执行。
