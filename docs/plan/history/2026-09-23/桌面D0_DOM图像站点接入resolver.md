# 桌面 D0：22 个 DOM 图像站点接入 `resolveAssetUrl`

- 日期：2026-09-23
- 来源计划：`docs/plan/PLAN.md` §1③「交付形态」的 **D0 真实阻塞（最硬的一条）**
- 用户指令：按 `plan.md` 阅读已规划待办／目标／约束，按优先级与顺序实现未完成部分，遵循既有技术栈、
  代码风格与目录结构，完成后说明进展、改动与剩余事项
- 状态：**已交付（零内容改动：`shared/**` 零字节 ⇒ 不升内容版本、不重跑装配器、不重启服务）**

---

## 1. 为什么取这一条

`PLAN.md` §1 的三件事按优先级是 ① 统一加载实玩（**只有用户本人能做**，本机沙箱读不到 macOS
进程表）、② 战斗机制纵深（三处缺口 A/B/C 已收口，剩下的 8 条法师技能在计划里写明是
**「口径内刻意保持」**——每一条都要**新增机制**或先做源语义裁决，属于「改计划」而不是「实现计划」）、
③ 交付形态。

⇒ ① 结构性阻塞，② 的计划内工作已完成、剩余项需扩口径，所以本轮取 ③ 里唯一**无前置阻塞、
且被计划明确标注为「需要一次机械迁移」**的 D0。

D0 的原文判据（`PLAN.md` §1③）：

> 桌面 `frontendDist` 只含应用代码、内容走远端 `assetBase`，而门禁
> `check_tms273_client_actions.cjs` 的 `UNCOVERED` 名单里**还有 22 个 DOM `<img>.src=frame.url`
> 站点**未接 `resolveAssetUrl`（HUD／背包／聊天／图鉴／小地图／世界地图／组队／好友／角色／宠物／
> NPC 头像／仓库／商城）。Web 下它们只是不参与强缓存，**桌面下会 404** ⇒ 需要一次**机械迁移**；
> 名单已在门禁里，新增会自动失败。

为什么「桌面下会 404」：`resolveAssetUrl` 是**唯一**会做两件事的地方——① 把逻辑地址换成内容寻址
对象地址、② 在桌面包里补上 `assetBase` 前缀（`/assets/**` 才补，前端自身 JS/CSS 必须留本地）。
裸 `<img>.src = frame.url` 绕过了这两步，于是桌面包里它会去请求**包内不存在的相对路径**。

## 2. 改了什么

### 2.1 源码：22 个文件、74 处 `<img>.src = …url`

一律只做**行级包装**，不做语义改写：

```diff
-    image.src = frame.url;
+    image.src = resolveAssetUrl(frame.url);
```

并补上缺失的 import（`import { resolveAssetUrl } from '../../assets/resource-url';`；三个文件
`cashshop/view.ts`／`npc/dialogue.ts`／`world/storage-view.ts` 早已导入，不重复加）。

| 文件 | 处数 | 文件 | 处数 |
| --- | --- | --- | --- |
| `features/hud/view.ts` | 7 | `features/world/minimap-view.ts` | 6 |
| `features/inventory/view.ts` | 6 | `features/notebook/view.ts` | 5 |
| `features/skills/view.ts` | 5 | `features/world/party-view.ts` | 5 |
| `features/chat/emoticon-view.ts` | 8 | `features/character/view.ts` | 3 |
| `features/notebook/item-section.ts` | 3 | `features/notebook/monster-section.ts` | 3 |
| `features/world/friend-view.ts` | 3 | `features/world/storage-view.ts` | 3 |
| `features/hud/buff-bar.ts` | 2 | `features/chat/view.ts` | 2 |
| `features/menu/view.ts` | 2 | `features/ui/window-shell.ts` | 2 |
| `features/notice/death.ts` | 2 | `features/keybindings/view.ts` | 2 |
| `features/npc/dialogue.ts` | 2 | `features/cashshop/view.ts` | 1 |
| `features/pet/panel.ts` | 1 | `features/world/worldmap-view.ts` | 1 |

### 2.2 三处「值没变就不碰 DOM」的守卫（必须一起改，否则守卫静默失效）

这些站点原本先比较再赋值，比较用的是**逻辑地址**：

```ts
if (image.getAttribute('src') !== frame.url) image.src = frame.url;
```

`<img>.src` 存的是**传输地址**（`resolveAssetUrl` 之后的值），拿逻辑地址去比**永远不相等**，
于是每次都重写一次属性——守卫等于没了。三处改为比较解析后的值：

- `features/world/minimap-view.ts`：小地图底图（`paintMap`）与角标（`paintMark`）
- `features/pet/panel.ts`：宠物槽位页签（`renderTabs`）

**同时发现一处门禁正则覆盖不到的站点**：`features/pet/panel.ts::setArt` 用的是
`element.setAttribute('src', frame.url)`——门禁的判据是 `/\.src\s*=\s*[^;]*[uU]rl\b/`，
`setAttribute` 不在其中。它是**同一件事**（都写传输地址），一并迁移；这是本轮唯一一处
超出门禁名单的改动，登记在 §5。

### 2.3 14 个离线检查的恒等桩

这些检查用「`ts.transpileModule` 转译 → 剥掉全部 import → `data:` URL 装载」的方式跑被测模块，
新增的具名导入**会变成未定义全局**（同类坑已在本仓出现过两次）。按仓库既有约定注入恒等桩
（`dialogue.check.mjs` / `ride-scene.check.mjs` 先例）：

```js
.replace(/import \{[^}]*\} from '\.\.\/\.\.\/assets\/resource-url';/, 'const resolveAssetUrl = url => url;')
```

**必须在剥 import 之前替换**；其中 3 个检查（`hud/buff.check.mjs`、`ui/window-shell.check.mjs`、
`cashshop/view.check.mjs` 的 `shellJs` 段）**不剥 import**，所以必须**替换**而不能靠注入全局——
留着相对说明符会让 `data:` 模块直接装载失败。3 个用模板串拼 `runnable` 的检查
（`character/view.check.mjs`、`skills/view.check.mjs`、`skills/points.check.mjs`）改成在
前缀里加 `const resolveAssetUrl = url => url;`。`notebook/view.check.mjs` 另有一条反向断言
（「所有相对导入必须被打桩」），所以那里也只能替换。

共 14 个检查文件：`cashshop/view.check.mjs`、`character/view.check.mjs`、`chat/emoticon.check.mjs`、
`chat/whisper.check.mjs`、`hud/buff.check.mjs`、`notebook/view.check.mjs`、`skills/points.check.mjs`、
`skills/view.check.mjs`、`ui/window-shell.check.mjs`、`world/friend.check.mjs`、
`world/minimap.check.mjs`、`world/party.check.mjs`、`world/storage.check.mjs`、
`world/worldmap.check.mjs`（`npc/dialogue.check.mjs` 早有同一桩，未动）。

### 2.4 门禁 `scripts/check_tms273_client_actions.cjs`

- `UNCOVERED`：**22 条 → 空**（`Object.freeze({})`），并把「22 个站点已全部迁移」写进注释。
  **判据没有取消**：下面 `offenders` 那段仍是「不在名单里的裸赋值一律失败」，所以新增一个未接入的
  DOM 图像站点照样当场红，只是现在没有任何豁免名额。另加一条显式断言
  `assert.deepEqual(Object.keys(UNCOVERED), [], …)`，把「名单非空」本身变成红灯。
- `RESOLVER_CONSUMERS`：**11 → 30 条**（新增 19 个；`cashshop/view.ts`、`npc/dialogue.ts`、
  `world/storage-view.ts` 早已在列，不重复）。这一段要求每个文件 `source.includes('resolveAssetUrl')`。
- 文件头 §4 的说明同步改写（不再声称「还有未接入站点」）。

## 3. 验收

| 项 | 结果 |
| --- | --- |
| `node scripts/check_tms273_client_actions.cjs` | **10 组断言全部通过**；自报「30 个真实消费者已接入 resolver」「DOM 图像站点 0 个未接入（22 个站点 74 处赋值全部走 resolver）」 |
| `npm run typecheck`（`tsc --noEmit`） | **0 错误** |
| `npm run check`（`client/scripts/run-checks.mjs`） | **63 项 / 56 过 / 7 红**，7 红与既有基线**逐项相同**：`layer-animation.check.ts`、`features/hud/gauge.check.ts`（两处无扩展名导入）、`check_repository_layout.cjs`、`check_inventory_surface.cjs`、`check_tms273_player_status.cjs`、`check_tms273_desktop_package.cjs`（缺 `icons/32x32.png`）、`build-release.check.cjs`（沙箱无 `ps`）。**本轮改过的 14 个检查全部 PASS**（含 `ui/window-shell`、`hud/buff`、`world/minimap`、`world/worldmap`、`world/party`、`world/friend`、`world/storage`、`character/view`、`skills/view`、`notebook/view`、`chat/emoticon`、`chat/whisper`、`npc/dialogue`、`cashshop/view`） |
| 反向扫描（本轮新增） | 全客户端 `backgroundImage` / `new Audio(` / `.src =` / `setAttribute('src'` / `createElement('img'` 里，**含 `/assets/` 却不经 resolver 的行 = 0** |

## 4. 刻意保持的边界

- **不动内容版本、不重跑装配器、不重启在线服务**：本轮零 `shared/**` 字节，纯客户端代码。
  `PLAN.md` §0 那条「升版与重建必须同窗口」的告警因此不适用。
- **不动行为**：`resolveAssetUrl` 在「无对象索引映射 ∧ 代数 0 ∧ 非桌面」时是恒等函数，所以 Web
  默认路径逐字节不变；变的只是「桌面下不再 404」「修复代数与强缓存现在覆盖这 22 个站点」。
- **不扩到别的资源通道**：Phaser 纹理、音频、CSS `background-image`、JSON 目录早已接入
  （`RESOLVER_CONSUMERS` 原有 11 条），本轮只补 DOM `<img>` 这一类。

## 5. 偏离登记（如实报备）

1. **`features/pet/panel.ts::setArt` 的 `setAttribute('src', …)` 是本轮唯一超出 D0 名单的改动**
   （门禁正则只看 `.src =`）。它是同一类缺陷（桌面下同样 404），一并迁移；顺带把它的比较值
   改成解析后的值。
2. **`artifacts/refactor/frontend-deps.json` 被 `refactor_audit.cjs --deps` 重算**（156 节点 /
   **372 → 391 边**，多出的 19 条 value 边正是本轮新增的 `→ client/src/assets/resource-url.ts`）。
   该制品由门禁每次运行重新生成，本轮改动的依赖图是真实变化，所以按生成结果保留。
3. **`UNCOVERED` 从「22 条带理由的登记」变成空表**：这是 D0 的目标态，不是删判据；空表本身也被
   一条显式断言钉住（§2.4）。

## 6. 遗留（本轮之后 `PLAN.md` §1③ 仍未完成的部分）

- **D0 的另一半验收项**：`tauri build` 的完整原生打包 + 真安装包在干净机器（无 Vite、无本机 3010）
  启动 —— **未验**（需用户侧执行，且缺签名/发布凭据）。
- **V3-P3**：「按图加载」仍只做了「按需装载」，没做「分块/分级」；`buildPreloadPlan` 仍是全量全集。
- **V3-D1**：分平台构建与代码签名/公证 —— 缺 runner 与凭据，阻塞。
- **V2-R1/R2/R3（Three.js）**：`three@^0.186` 在依赖里但未接入，R1 未开始。
- **服务端 CORS**：桌面来源（`tauri://localhost` / `http://tauri.localhost`）的精确 CORS 与
  WebSocket Origin 校验，需真实域名后落实。
- **② 剩下的 8 条法师 212／232 技能**（`2121052`／`2321052`／`2121054`／`2321054`／`2321003`／
  `2321005`／`2321006`／`2321015`）**本轮未动**，理由见 §1：它们需要**新增机制**或源语义裁决，
  属于扩口径，不在本轮范围。
- 未重启在线服务、未提交（用户未要求提交）。
