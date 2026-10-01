# UI 窗口系统规范与架构（TMS273 前端）

> 状态：规范（2026-09-12）。适用范围：`client/src/features/**` 里所有"面板式"界面。
> 样板：`features/inventory/view.ts`（物品栏 / 装备窗）—— 本项目当前唯一满足全部规范的自绘窗口。
> 本文只定规范与架构，不下达业务数值；数值一律回到 TMS273 WZ 与 `references/tms273_research_pack/`。

## 0. 一句话目标

让所有面板界面与物品栏**同一套手感**：能用鼠标把头拖走、按钮有悬停/按下反馈且点了真的做事、
多个窗口叠在一起时点到哪个哪个到最前、ESC 由内向外逐层关闭、没有任何"点了没反应"的入口。

## 1. 现状盘点（2026-09-12 只读核对）

| 界面 | 文件 | 拖拽 | 按钮态 | 点得动吗 | 素材来源 |
| --- | --- | --- | --- | --- | --- |
| 物品栏 / 装备（样板） | `features/inventory/view.ts` | ✅ | 3 态 + 源坐标命中区 | ✅ 全部 | `inventoryUi` / `inventoryLayout` / `equipmentUi` |
| 小地图 | `features/world/minimap-view.ts` | ❌ | 3 态 | ✅（含 WORLD/NPC） | `miniMap`（UIMap.img/MiniMap） |
| 技能 | `features/skills/view.ts` | ❌ | close 仅 1 态；底部 5 键无态且 4 键空绑定 | ⚠️ 部分 | `skillWindow`（UIWindow 系） |
| 任务日志 | `features/quest/log.ts` | ❌ | close 仅 1 态 | ✅ | `questUi`（Quest.img） |
| 快捷任务追踪 | `features/quest/log.ts` | ❌ | 纯 HTML | ✅ | 无源素材（纯 CSS） |
| 等级 / HP / MP 状态栏 | `features/hud/view.ts` | ❌（原版即固定） | 6 键 3 态 | ⚠️ 商城/活动未接入 | `hud`（StatusBar3.img） |
| 快捷技能栏 | `features/hud/view.ts` | ❌ | 折叠键为纯文本 `−`/`+` | ✅ | `hud`（StatusBar3.img/quickSlot） |
| buff 栏 | — | — | — | **整块缺失** | 未导出（源在 `StatusBar3.img/BuffSetting`） |
| 聊天 | `features/chat/view.ts` | ❌ | 3 态 | ✅ | `chatUi`（StatusBar3.img/chat） |
| ESC 菜单 | `features/menu/view.ts` | ❌ | close 3 态；类目 3 态 | ⚠️ 白名单外静默 | `totalMenuUi` |

**五个共同缺口**：① 只有物品栏能拖；② 按钮态不统一（1 态 / 3 态 / 4 态混用）；③ 没有 z 序置顶；
④ ESC 语义分散（每个 view 各装各的监听，且**没有任何地方能用 ESC 开菜单**）；⑤ buff 栏不存在。

### 1.1 本轮落地情况（2026-09-12 收尾）

| 界面 | 拖拽 | 按钮态 | 说明 |
| --- | --- | --- | --- |
| 小地图 | ✅ 新增 | 关闭键回 `normal`（修掉 pointerup 残留 mouseOver） | 三种模式标题栏高不同（76 / 36 / 0），由 `titleBarHeight()` 动态给出 |
| 技能 | ✅ 新增 | close 改四态 | 底部 5 键中 4 个空绑定改为明确"尚未接入"提示，不再静默 |
| 任务日志 | ✅ 新增 | close 改四态 | 源底图 21px；回退外观 32px；ESC 关闭 |
| 快捷任务追踪 | ✅ 新增 | — | 整块是 `button`，故 `allowOnButtons: true`，靠 3px 激活距离保证点击仍生效 |
| 等级 / HP / MP 状态栏 | 不拖（HUD 常驻） | 6 键 3 态 | 本轮未改，维持原版固定 |
| 快捷技能栏 | 不拖 | 折叠键改源素材四态 | `button:Extend`/`button:Fold`（13×71 / 12×71），缺素材时回退文本 |
| buff 栏 | 不拖 | — | **新建** `features/hud/buff-bar.ts` + `buff.css` + `export_tms273_buff.cjs` |
| 聊天 | ✅ 新增 | 3 态 | 标题条 27px 不抢输入框焦点；拖拽时解除 `bottom` 定位 |
| ESC 菜单 | ✅ 新增 | close 3 态 | 新增 `app/ui-router.ts`：**无面板打开时 ESC 开关菜单** |
| 角色信息 | ✅ 新增（2026-09-13） | close 4 态（沿用） | 错位修复：删除四个源 Font 文字层（与 HTML 标签重影）、attackBack `clip-path` 裁掉自带的戰鬥力头条（33px）、详情三组面板改对齐源灰板（mainStatBack y38..119 / attackBack 灰板 y123..300 / utilityBack y314..406）、主卡 HP/MP/EXP/AP 移入白区 y62 两列网格（底源灰槽 y124 起不再被压）；拖拽走 `installWindowDrag`（标题条 26px = 源框带），`--ui-window-z` 置顶，`destroy()` 对称注销 |

**R3（z 序置顶）状态：helper 就位、CSS 未接线。** `bringToFront()` 已实现并有断言覆盖，
但各面板现存一批静态 `z-index`（装备 6 / 任务 4 / 仓库 3 / 队伍 3 / 好友 3 / NPC 2 / HUD 3 …），
直接改成 `z-index: var(--ui-window-z, auto)` 需要先把这些静态值统一收进 `--ui-window-z` 起点，
否则会出现"拖过的窗口反而被没拖过的压住"。本轮不动，登记为后续项，避免一次性改动所有面板层级。

---

## 2. 规范（R1–R6，全部可被 check 断言）

### R1 窗口 = 标题栏 + 内容区 + 按钮组
- **标题栏**是可拖拽的唯一命中区，高度由源素材决定：物品栏 21px（源标题条）、
  小地图 MaxMap 67px / MinMap 27px / Min 20px（源 chrome 首片高）、技能与任务源底图取顶部条高。
  规范值一律**记录为常量**，写在各自 view 顶部，并在 check 里断言。
- 内容区（列表、格子、滚动区）**不参与拖拽**。

### R2 拖拽语义（照抄物品栏，抽成公共实现）
1. `pointerdown` 四道闸门：左键 → 窗口处于打开态 → 事件目标不在 `button` 上 → 指针落在标题栏内。
2. **惰性去居中**：窗口初始可能是 `left:50%;top:50%;transform:translate(-50%,-50%)`；
   首次拖拽时按当前 `getBoundingClientRect()` 换算成宿主内绝对 `left/top` 并 `transform:none`。
   之后所有位移只写 `left/top`，不再碰 transform。
3. **边界夹取**：`left/top` 夹在 `[0, 宿主宽高 − 窗口宽高]`，窗口不能被拖出可视区。
4. **指针捕获**：`setPointerCapture` / `releasePointerCapture` 成对，`pointercancel` 同路回收。
5. **注册/注销对称**：`destroy()` 必须解绑自己装的每一个监听器（物品栏是当前唯一做到的）。
6. `touch-action: none` 由 CSS 保证（触屏拖拽必需）。

### R3 叠放与置顶
- 同一宿主（`#ui-windows`）内所有面板共用一个 **z 序计数器**：任何窗口 `pointerdown` 时
  `bringToFront()`，把该窗口的值抬到计数器当前最大值 +1，其余不变。
- 实现用 CSS 变量 `--ui-window-z`（不用内联 `style.zIndex`，避免和既有静态层级打架）。
- 层级陷阱修正：`.tms273-skill-host{z-index:8}` 的父级 `#ui-windows{z-index:5}` 会生成层叠上下文，
  导致技能窗永远压不过 `#menus(6)`。规范改为**宿主只提供 `z-index:5`，窗口间排序靠 `--ui-window-z`**，
  view 内部不得再自建跨宿主层级。

### R4 按钮三/四态与"不许哑巴"
- 帧键形如 `<base>/<state>/0`，状态集合 `normal | mouseOver | pressed | disabled`。
- 切换方式：**保留 `<base>`，只替换尾两段**；某态缺失时回退 `normal`（物品栏 `createWindowButton` 已验证）。
- 交互映射统一为 `pointerenter→mouseOver`、`pointerleave→normal`、
  `pointerdown→pressed`、`pointerup→normal`（与物品栏一致；不回 `mouseOver`，避免触屏残留悬停）。
- **任何按钮都不得静默**：已实现的执行动作；未实现的必须 `status('…尚未接入')` 明确提示，
  且不得用"看起来能点"的素材伪装可用。

### R5 ESC 路由（新增，唯一入口）
- ESC 是**由内向外逐层关闭**：谁在最上层、谁先关。
- 分层注册：每个面板 `registerEscapeLayer(view, isOpen, close)`，压成一个全局栈；
  全局只装**一个** `keydown` 监听（`app/ui-router.ts`），按栈顶顺序询问。
- **没有面板打开时，ESC = 打开/关闭 ESC 菜单栏**（用户明确要求：用 ESC 呼出菜单栏）。
  菜单自己再按一次 ESC 关闭。聊天输入框聚焦时保持既有语义（先退悄悄话 → 再失焦），优先级最高。

### R6 素材边界
- 窗口所有可见部件必须来自 TMS273 WZ；无源素材的部分**必须在代码里显式标 P**，
  并在本文第 5 节登记，不得用自绘图形冒充原版。
- 拖拽产生的**位置**是运行时状态，不写回 WZ；是否跨登录持久化按各窗口单独决定（见第 5 节）。

---

## 3. 架构

### 3.1 新增模块 `features/ui/window-shell.ts`

把物品栏里那套已被验证的机制抽出来，供各 view 组合（不改成继承体系，保持现有 view 各自建 DOM 的风格）：

```
installWindowDrag(host, window, opts) -> dispose
    opts: { titleHeight: number | (() => number), isOpen: () => boolean, onActivate?: () => void }
    职责：R2 全部五条 + R3 置顶

bringToFront(host, window)
    维护宿主内 --ui-window-z 计数器

createAssetButton(opts) -> { button, setState, dispose }
    opts: { assets, base, kind, label, action, disabled? }
    职责：R4 帧路径尾段替换 + 四态 + 点击绑定

registerEscapeLayer(layer) -> dispose
    职责：R5 栈注册（由 app/ui-router.ts 统一分发）
```

### 3.2 新增模块 `app/ui-router.ts`
- 持有全局 ESC 栈与唯一 keydown 监听。
- 提供 `registerEscapeLayer`、`openEscapeMenu`/`closeEscapeMenu` 钩子（菜单模块注入）。
- `main.ts` 只接线：把 `menus.toggle('game')` 接进 router，不再各自装 ESC 监听。

### 3.3 各 view 的接入方式
每个 view 只做三件事，不改自身渲染逻辑：
1. 构造时 `installWindowDrag(host, window, {...})`，把返回的 dispose 存字段；
2. 按钮改走 `createAssetButton`（有源素材的），或保留自建但补齐四态；
3. `destroy()` 里调 dispose。

---

## 4. 交互矩阵（改后应有行为）

| 界面 | 拖拽 | 标题栏高 | 关闭方式 | z 序 | ESC |
| --- | --- | --- | --- | --- | --- |
| 物品栏 / 装备 | 已有 | 21 | X / I / E / ESC | ✅ 新增 | 关自己 |
| 现金商店 | 已接入（2026-09-13） | 31（源顶部条） | EXIT / ESC | 点击置顶 | 先关详情，再关商店 |
| 小地图 | 新增 | 源 chrome 片高 | 折叠键 / 拖后保持 | ✅ | 不参与（常驻 HUD） |
| 技能 | 新增 | 源顶部条 | X / K / ESC | ✅ | 关自己 |
| 任务日志 | 新增 | 源顶部条 | X / Q / ESC | ✅ | 关自己 |
| 快捷任务追踪 | 新增 | 自绘条（P） | 追踪按钮 | ✅ | 不参与 |
| 聊天 | 新增 | 面板顶条 | 折叠键 | ✅ | 输入框优先 |
| 角色信息 | 新增（2026-09-13） | 26（源框带） | X / C / ESC | ✅ | 关自己 |
| 菜单栏 | 新增 | 菜单头 | X / ESC / 点外部 | ✅ | **无面板时 ESC 开关** |
| buff 栏 | 不拖（HUD 常驻） | — | 随状态栏显隐 | — | 不参与 |

---

## 5. 素材与 P 边界登记

| 项 | 来源（T 类） | 边界 |
| --- | --- | --- |
| 小地图 chrome / 标记 | `UI/UIMap.img/MiniMap/*` | 已导出；`BtDungeonMap/BtFilter/BtTown/BtNavigation` 本轮仍不接 |
| 技能窗背景与按钮 | `UI/UIWindow*.img`（Skill 壳）+ `BtHyper` | 底部公会技能/骑宠/技能顺序/技能宏的**功能**未实装，按钮态按要求补齐但点击给明确提示 |
| 任务窗 | `UI/Quest.img` | 内容排版仍为项目适配（P），仅外壳走源素材 |
| 快捷任务追踪 | 无独立源素材 | **P**：文字追踪条，样式沿用现有 CSS，仅补可拖拽 |
| 快捷技能栏折叠键 | `UI/StatusBar3.img/mainBar/quickSlot/button:Extend | button:Fold` | 本轮从纯文本改为源素材 |
| buff 栏 | `UI/StatusBar3.img/BuffSetting/favoriteBuff`（九宫格）+ `spaceX=spaceY=5`（源间距）+ `minimizedIcon/{mySkill,othersSkill,commonSkill,itemSkill}` + `mainBar/status/gauge/number/*`（剩余秒数字体） | **T**：面板九宫格与间距是源值；**P**：栏位摆放位置与"不分组、单行"的呈现为项目适配；分组切换（minimizedIcon 四类）本轮只导出不接 |
| buff 数据 | 服务端快照 `derivedStats.skillBuffs`（skillId → 剩余 ms） | 权威数据，客户端只渲染 |
| 角色信息窗 | `UI/UICharacterInfo.img`（backgrnd / layer:stat / 三个 back 灰板 / close 与 lvUp 按钮四态） | **P**：四个源 Font 文字层（mainStatFont/attackFont/utilityFont/defenseFont）不渲染——它们是繁体标签，与 HTML 行重复且坐标不同会造成重影错位；attackBack 自带戰鬥力头条前 33px 被裁；所有数据行的排版为项目适配，仅外壳与按钮走源素材。源主卡底图自带的公会/联盟/人气度灰槽保留原样（未建模即留空） |

---

## 6. 验收

1. `client/src/features/ui/window-shell.check.mjs`（新增，挂在 `npm run check`）：
   用 DOM stub 驱动共享实现，断言
   - R2.1 四道闸门：非左键 / 窗口未打开 / 落在按钮上 / 落在标题栏外，都不产生拖拽；
   - R2.1 激活距离：2px 抖动仍是点击，不移动窗口；
   - R2.2 惰性去居中：首次真正移动时按当前屏幕位置换算 `left/top` 并 `transform:none`，不跳位；
   - R2.2 后续位移保持抓取偏移；R2.3 位移夹在宿主内；R2.4 `pointercancel` 同样收尾并释放捕获；
   - R2.5 disposer 摘掉全部四个监听器，之后拖拽彻底失效；
   - R3 `bringToFront()` 的宿主计数器递增；
   - R4 四态帧切换、缺失态回退 `normal`、disabled 不触发动作且 `preventDefault`、
     `normal` 帧缺失时返回 `undefined`（不产出哑巴按钮）。
2. `client/src/features/hud/buff.check.mjs`（新增）：`buffSeconds()` 边界（0 / 负 / NaN / 向上取整 /
   分秒切换）、九宫格 9 片全画出、按 skillId 复用行（tick 不重建节点）、过期移除、
   全部过期整条隐藏、`clear()` / `destroy()`、缺导出时降级不抛错。
3. `scripts/export_tms273_buff.cjs`（新增）：导出 BuffSetting 素材并断言九宫格尺寸（角片 5×5、
   中心 1×1）、折叠键尺寸（13×71 / 12×71）、`spaceX=spaceY=5`。
4. `tsc --noEmit` + `npm run build` + 既有 `npm run check` / `check:inventory` 子项不回归
   （`dialogue.check.mjs` 是**既有失败**，它阻断了 npm run check 的后续步骤，故本轮新增的两项
   刻意排在它之前）。
5. 实机手感（拖拽、遮挡、buff 栏位置、ESC 呼出菜单）交用户亲测，标待验。


### 现金商店接入补充（2026-09-13）

现金商店使用共享拖拽、置顶及边界夹取：标题栏 31px 来自现有 TMS273 源外壳；透明拖动命中层排除右侧 EXIT，`touch-action:none` 仅作用于标题层，商品区保留触屏滚动。内容、按钮不触发拖动，详情打开时不拖动底层商店。拖后保留绝对位置，宿主尺寸变化时先切换布局和尺寸、再夹取到可视区；窄布局不再用 `!important` 强制撑满，最大仍为 1024×768。重开恢复初始居中，不写入角色存档。

`bringToFront` 现在读取同宿主兄弟窗口的实际 z-index 作为计数器下限，避免首次置顶从 60 降为 1；尚未迁移的静态层级也计入。其它窗口的全局 ESC 栈和跨宿主治理仍以现有实施状态为准。


## 角色属性窗口最新适配（2026-10-01）

用户授权规整C键界面：保留源CHARACTER INFO标题/关闭/AP按钮，内容改为流式总览、能力加点、战斗移动和当前状态，移除空的公会/人气字段与旧绝对坐标灰板；此要求覆盖上表旧R6逐板坐标描述。宽窄屏重排，不缩整窗文字。`isOpen()`实际参与统一输入阻塞；当前速度来自服务端与实际行走共用的currentMoveSpeed快照，属性速度/骑乘百分比/缓速说明分别呈现。短按一次加点、长按三秒指针周围圆环后自动连续AP，单未决回执/120ms间隔与取消/失败/耗尽清理；详情见当日角色属性长按加点与场景开发skill历史记录。

## 本轮统一格式（2026-10-01，需求已记录，尚未实施）

本节是用户语音提出的后续目标，不覆盖上文已完成实现的历史事实。当前“先不做”仅允许整理；实施入口统一回到[当前计划](../plan/PLAN.md)。

| 部分 | 统一口径 | 后续核对条件 |
| --- | --- | --- |
| 窗口壳 | 延续原版标题、按钮态与纸面/深色板层级；标题可拖、内容区独立滚动、右上明确关闭 | 复用现有窗口拖拽/ESC路由；不同窗口点击置顶；关闭不留下输入拦截 |
| 图片与文字 | 原图按原比例显示；需要大内容区时扩展布局或使用已有九宫格，不整张硬拉伸 | 图标、ID和计时清晰；模糊只作用背景，贴图烧字不得与DOM文字重叠 |
| HUD血条 | 加宽，保留数值及状态可读性 | 具体宽度与MP同步方式后续对照实际窗口确定；不能仅拉大源图造成失真 |
| 宠物/坐骑 | 装备窗中两个并排入口，各自二级管理；骑乘/下马在坐骑窗 | 复用现有权威状态与操作；一级HUD不再铺大骑乘控制条；快捷键是否保留未定 |
| 状态栏 | 快捷栏上方，效果图标+秒数倒计时，显示上限999；白色框带背景高斯模糊 | 超过999仅限制显示，不截断服务端时长；当前BuffBar分秒格式需调整；无时限效果另定样式，不能虚构计时 |
| 属性窗口 | 保留基础属性、当前权威移动速度与临时速度来源说明；效果列表改由状态栏承载 | 改显示归属，不删除实际技能/骑乘/缓速状态或已有三秒长按加点能力 |
| 冒险笔记/图鉴 | 左侧索引/内容格架，右侧稳定详情区，未选中为空态；ID可复制，整窗关闭显眼 | 细则见[图鉴规范](NOTEBOOK_VISUAL_SPEC.md#本轮调整2026-10-01需求已记录尚未实施)；窄屏保持可操作，不靠缩小整窗压文字 |
| 控制光照 | “其他→控制光照”打开独立窗口，可拖拽、关闭；不随活动菜单收起而关闭，可留着操作地图 | 使用现有环境状态/保存逻辑；关闭窗口只关UI，不重置天气/太阳；地图变更沿既有生命周期处理 |

光照新入口是对当前“菜单→游戏设置/活动→初弦地→环境与光照”的后续调整要求。当前部署仍是旧入口，不能声称独立窗口已可用。支持的时段、太阳、天气、四季、湿度沿用已实现功能，不因收拢UI改变作用范围。界面常驻指用户打开后可留在场景中；默认开机弹出、位置跨会话保存并非本轮已确认需求。
