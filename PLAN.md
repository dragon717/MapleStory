# 当前工作计划

> 本文件只保留**仍需行动或确认**的事项，作为当前目标的唯一入口（对齐 `AGENTS.md`）。
> 已完成条目的完整记录逐字归档到 `docs/history/plan/`，索引见 [`docs/history/plan/INDEX.md`](docs/history/plan/INDEX.md)。
> 拆分依据 `MapleStory_Large_File_Refactoring_Plan.md`（用户要求 md 与代码同一口径）。

## 待你确认或操作

- [ ] **重启 3010 使本轮改动生效**。本轮动了 `server/src/world.rs` 的模块结构（拆出 `messaging.rs` / `inventory_ops.rs`）
  与 `scripts/check_tms273_runtime.cjs`（改为扫描全部生产 `.rs`，不再只盯 `world.rs`）。
  上次双击启动失败的原因就是这个检查脚本的硬编码路径，**已修复并通过**；需要你重跑一次确认整体链路正常。
- [ ] **HMR 计划 P1（是否改双击默认行为）**。把统一脚本改造成 dev/build/preview/status/stop 模式后，
  双击启动会从"构建+服务"变成"Vite 源码开发 + 内部 Rust"。取证结论：dev 链路技术上已通
  （`npm run dev` + 已配置的 `/api`、`/ws` 代理），缺统一入口、`strictPort`、模式/实例标识与 HMR 边界。
  改变默认行为 + 验收必须真跑一次（即重启 3010）⇒ 按既有约定不擅自重启，等你说时机。
- [ ] **删除 3 个 iCloud 冲突副本**（已被 git 跟踪，非本轮产生）：
  `client/src/features/loading/` 下的 `style 2.css` / `view 2.ts` / `view.check 2.mjs`。
  判据：原文件时间戳更新 ⇒ 副本是陈旧重复物。**属于删除已跟踪文件，等你确认后再删**。
- [x] **防回潮门禁接线（R10 完成，2026-09-12）**。`scripts/refactor_audit.cjs --deps --check` 已挂进
  `client/scripts/run-checks.mjs`（仓库级末项），`npm run check` 25/25 全绿 = 门禁通过；
  例外登记在 `artifacts/refactor/debt-register.json`（当前 0 项债务）。
  本仓库无远程 CI——将来接入 CI 时执行同一条命令即可：`node scripts/refactor_audit.cjs --deps --check`。
  新增越界（新巨型文件/跨域深层导入/依赖环）会令 `npm run check` 失败；历史债务不自动扩张。

## 仓库重构计划（MapleStory_Repository_Based_Refactoring_Plan.md）进度

> 2026-09-12 按 R0→R11 阶段表推进；本节记录已完成与未完成。改动**未提交**，回滚点 = 当前工作树 `git diff`。

### 已完成（R0–R8）

- [x] **R0 基准固化**：HEAD `99b7cbf`；cargo test 292过/6失败（失败集与计划 §2.1 逐名一致）；
  尺寸报告刷新（world.rs 8,554 / auth.rs 3,570）；依赖审计复现 §9 两个已知问题。
- [x] **R1 前端检查修复**：`dialogue.check.mjs` 装载方式修复（依赖模块 transpile + `items.json` 经
  data URL JSON 模块加载）；新增 `client/scripts/run-checks.mjs` 逐项 runner（17 项全执行、汇总、任一失败非零）。
  `npm run check` **17/17**（修复前第 9 项失败会静默阻断后 7 项）。
- [x] **R2 审计脚本升级**：TS AST 区分 type/value/side-effect/dynamic 依赖边，runtime/type 环分开报告；
  新增 `--check` 增量门禁与 `--self-test` fixture 自测；报告带 sourceCommit/dirty；新增
  `artifacts/refactor/debt-register.json`（两笔已知债务，R5 退出）。
- [x] **R3 任务纯规则抽离**（服务端试点）：新增 `server/src/quest_rules.rs`——全仓库唯一不用
  `use super::*` 的 world 子模块，判定经 `QuestFacts` 窄视图，不接 World/Store/网络；
  quest.rs 19 处调用点迁移、7 个原静态函数删除、事务与回执留在 quest.rs 不动；新增 5 个纯规则测试。
- [x] **验证**：cargo test **297过/6失败**（失败集不变，+5 新测试）；警告 40 = HEAD 40（零增量）；
  tsc --noEmit 通过；check_tms273_runtime 通过；audit `--check` OK。
- [x] 文档同步：`BACKEND_ARCHITECTURE.md` 模块表已加 `world::quest_rules` 条目。
- [x] **R4 背包拆分第一批**：新增 `features/inventory/view-model.ts`（纯转换：页签映射、slotsDataset/
  slotsSignature/itemAtSlot/comparisonTarget/cooldownSeconds 等，页签 1,2,4,3,5 顺序原样保留）与
  `features/inventory/tooltip-view.ts`（TooltipController：showForItem/refresh/hide/reposition/scheduleHide/destroy，
  数据经构造回调注入，不导入 names/manifest）；`view.ts` 17 处替换为委托，对外 `InventoryView` 门面与
  update/requestId 流程不变；新增 `view-model.check.mjs` + `tooltip-view.check.mjs` 三件套测试；
  `scripts/check_inventory.mjs` 的 TAB_* 钉扎目标同步改指 view-model.ts。
- [x] **R5 依赖债务清偿**：新增 `assets/avatar-types.ts`（零导入类型叶：Point/Part/Frame/AvatarActionSet），
  `manifest.ts` 删除原定义改 `import type` + `export type` re-export，`entry/appearance.ts` 改引 avatar-types——
  manifest↔appearance 类型环消除；新增 `network/auth-api.ts`（`authenticate()` 机械搬出，语义逐行一致），
  `entry/view.ts` 改引 auth-api——entry→session 违规清零；**附带实证并修复 §9.3 缺陷**：
  `session.ts` 原先 `connect()` 调 `close()` 会把 `stopped` 置 true 导致重连被永久抑制，
  改为新增 `closeSocket()`（只清定时器+关 socket）、`connect()` 走 `closeSocket()`、`close()` 保留置 stopped；
  新增 `network/session.check.mjs`（重连调度区间、终端码、主动关闲语义）；
  `debt-register.json` 两笔债务结清（items 清空 + `_history` 记录）。
- [x] **R5 验证（全绿）**：tsc --noEmit 通过；`npm run check` **20/20**；`npm run check:inventory` 通过；
  `refactor_audit.cjs --deps --check` → runtime_cycles=0 / type_cycles=0 / violations=0 / known-debt=0；
  `--self-test` 通过；cargo 基线未受本轮影响（297过/6失败、警告 40）。

- [x] **R6 拾取用例规则输入收窄 + 事务时序成文**：新增 `server/src/pickup_rules.rs`（quest_rules 同款纪律：
  不用 `use super::*`、窄输入 `PickupFacts`/`PickupVerdict`、不接 World/Store/网络）——掉落可得性判定
  （地图/归属保护/距离/内存容量预检）与图鉴饱和入账从 `handle_pickup` 纯搬出，拒绝码与文案逐字保留；
  `handle_pickup` 保留幂等查询、Store 提交、世界回填与回执顺序（未动事务）。先补齐四个窗口的保护测试
  再搬移：新增 `pickup_store_windows_replay_prior_failure_and_side_effect_free_reject`（成功/重放/持久化失败）
  与 `pickup_backfill_failure_after_commit_keeps_persisted_truth`（事务成功+回填失败：资产以持久化为准）
  两个 world 层测试 + pickup_rules 5 个纯规则单测。事务时序与失败窗口说明成文于
  `BACKEND_ARCHITECTURE.md` §6.1，模块表加 `world::pickup_rules` 条目。
  验证：cargo test **304过/6失败**（失败集与基线逐名一致，+7 新测试）；新代码零警告；
  audit `--deps --check` OK（0 环 0 违规 0 债务）；`check_tms273_runtime` OK。

- [x] **R7 背包交互职责拆完**：新增 `features/inventory/drag-controller.ts`（DragController：拖拽来源状态、
  背包/装备槽拖拽绑定、document 级拖出丢弃；只**输出意图回调** moveItem/dropItem/unequip/
  useScrollOnEquipment/useItem，不拥有槽位/金币真值与 requestId）与 `equipment-view.ts`
  （EquipmentView：装备窗口 DOM、开合状态、槽位渲染与点击/双击/右键交互；数据经 `equippedItemAt`/
  `itemFrame` 窄回调只读）；`view.ts` 1512→1244 行，保留门面 API、组装、requestId 生成、窗口拖动、
  键盘与布局（intents.ts 未建——意图构造+发送留在门面，符合 §8.2"需要时"措辞，未复制状态）。
  每个子模块只收窄回调（DragHost 12 个 / EquipmentHost 14 个），无共享巨型 Context。
  新增 `drag-controller.check.mjs`（意图路由、卷轴闸门、document drop-out、destroy 清理监听）与
  `equipment-view.check.mjs`（缺资源提前返回、开合同步、渲染状态、槽位点击分支、close 请求），
  runner 增至 **22/22 全过**；tsc 通过；`check:inventory` 通过；audit `--deps --check` OK
  （0 环 0 违规 0 债）。页签顺序 1,2,4,3,5 与全部交互语义未动。

- [x] **R8 App/Session/Scene 作用域与资源计划**：新增 `assets/preload-plan.ts`
  （`buildPreloadPlan` 纯函数：world.ts preload 收集段逐行搬出，全量策略/顺序/去重语义不变，
  BGM 的 cache 短路以 `skipIfCached` 标记留在 Scene 执行）与 `app/page-shell.ts`
  （PageShell：页面模板/语言切换/新闻弹窗/game-mode 布局搬移，DOM ID 与可访问性逐行保留，
  status() 的提示定时器仍归 main）；`scenes/world.ts` 780→705、`app/main.ts` 685→650。
  新增 `preload-plan.check.mjs` + `page-shell.check.mjs`，runner 增至 **24/24 全过**；
  生命周期确认（§10.2 对照表，含 game-session.ts 暂不拆的理由）成文于
  `FRONTEND_ARCHITECTURE.md` §6.1。切图/重连/重建的静态回归由 tsc + 24 项 check 覆盖；
  实玩复验仍按既有流程待重启 3010 后进行。

- [x] **R9 几何与内容校验核对 + 内嵌测试钉扎**：核对 `server/src/geometry.rs`（622 行，R0 前已抽离）
  已覆盖计划 §11.1 全部候选——Foothold 插值/墙阻挡/接触时刻判定、Ladder 列窗口/uf 顶端语义、
  WaterRect 水底插值/形状校验、ReactorPlacement hitbox 归一化与 `TYPE_AREA` 触发——
  **确认不重复立项 `world_geometry.rs`**。补齐原缺失的内嵌纯函数测试 5 个
  （foothold 插值内外、wall blocks/防隧穿接触时刻、ladder 容差与探测窗口、water 插值与校验、
  reactor hitbox 归一化），把 `blocks_at_crossing` "接触时刻判定而非端点判定"这一防隧穿语义首次钉进测试。
  验证：cargo test **309过/6失败**（失败集与基线逐名一致，+5 新测试）；警告 39 与基线一致。

- [x] **R10 门禁接线 + 例外登记 + 架构导航与模块契约更新**：
  `refactor_audit.cjs --deps --check`（R2 就绪）挂进 `client/scripts/run-checks.mjs` 仓库级末项，
  `npm run check` **25/25 全过** = 门禁通过；例外登记 `artifacts/refactor/debt-register.json`（当前 0 项）。
  **拦截实证**：临时制造 `features/player → app/main.ts` 运行时导入 → 门禁报
  `entry-app-not-imported-by-features` 且 exit 1，删除后复位 exit 0——"新增越界失败、历史债务不自动扩张"
  的退出条件验证闭环。架构导航：`FRONTEND_ARCHITECTURE.md` 新增 §5.1 检查与防回潮门禁
  （含 CI 接入命令）；`BACKEND_ARCHITECTURE.md` 模块表补 `world::geometry` 契约条目（R9）。
  本仓库无远程 CI；接入时执行 `node scripts/refactor_audit.cjs --deps --check` 即可。

### R11 第一批（2026-09-12 完成）

- [x] **R11 排名刷新 + 第一批热点治理（world.rs 测试搬出）**：按计划"不用旧行数、每次重新排序"
  重跑 `refactor_audit.cjs --sizes`，识别出 churn 最高的 `world.rs`（8,821 行 = 生产 3,436 + 内嵌测试 5,385）
  的最大零风险削减项——把内嵌 `#[cfg(test)] mod tests` **机械搬出**为 `#[path = "world_tests.rs"]`
  外置测试模块（含 20+ 个 `include!("*_acceptance.rs")`，相对路径要求平铺 `src/` 根）；
  一次性脚本按内容边界切除 + 重组逐字节自校验。`check_tms273_runtime.cjs` 生产源码扫描同步排除
  `world_tests.rs`（与 `*_acceptance.rs` 同理：测试文本不是生产实现）。
  验证：cargo test **309过/6失败**（失败集逐名一致）、警告 39、`check_tms273_runtime` OK、
  audit `--deps --check` OK。**world.rs 8,821 → 3,437 行（-61%）**；测试组织与原 mod 语义完全一致。
- 刷新后剩余超预算候选（下一批按需立项，不自动扩张）：
  `auth.rs` 3,569（≈2,100 行 tests，继续拆收益低）、`skills.rs` 2,977（churn=1 纯静态）、
  `inventory_ops.rs` 1,456、`quest.rs` 1,397、`elemental.rs` 1,377、
  `features/inventory/view.ts` 1,245（churn=14，intents.ts"需要时"候选）。

### R5 遗留登记

- [ ] `frameAt` 从 `assets/manifest.ts` 搬出到独立纯函数模块：搬移会破坏多个经 data URL 装载
  `animation.ts` 的既有 check，本轮判断不做；后续做 R7/R8 时机再评估。

### 未完成（R11 后续批次，开放登记）
- [ ] **R10** 门禁挂 CI + 例外登记 + 架构导航更新（对齐上面"防回潮门禁接线"待办）。
- [ ] **R11** 按新基准的业务热点继续治理（不用本表旧行数，每次重新排序）。

### 待确认的可疑语义（R3 遗留）

- [ ] `quest_prerequisites_match` 的 **OR + 空前置清单返回 false**（原实现 `any` 空迭代器语义，特征测试已按原行为钉住）。
  是否为缺陷需产品口径确认；确认后单独开修复，不夹在机械搬移里。

## 待统一加载 3010 后实玩（最近一批）

- [ ] 超大文件治理第一、二步落地（`messaging.rs` 542 行 / `inventory_ops.rs` 1,444 行搬出）：本批**零行为改动**，
  实玩时重点是**聊天、密语、表情、拾取、背包整理/移动/丢弃、用道具、丢金币**这些被搬走的路径没退化。
- [ ] 魔心防禦（2001002）改为「99% 转 MP × 逐级抵偿率 100→80，差额由护盾消解」：看 1 级与 2 级起的差异是否如你指定。
- [ ] 花蘑菇（菇菇寶貝 1210102）无法移动：确认已会走动。
- [ ] 魔力波動二段简化（下+跳 → 跳）：确认起跳条件已放宽。
- [ ] 道具背包五页签复刻 + 背包扩展券：确认页签、扩展券购买与容量生效。
- [ ] 传送类消耗品（回城卷軸 / 定点城镇卷軸）：确认使用后落点正确。
- [ ] 聊天表情（表情貼圖）与悄悄話（私聊）：确认发送、频控提示与头顶气泡表现。
- [ ] 怪物追击 / 仇恨系统：确认怪会主动追人、脱战会回归。
- [ ] 大地图（World Map）：地图 ID 补零缺陷修复 + 打开落在所在区域页。
- [ ] 好友与黑名单：确认增删、在线状态与黑名单屏蔽。
- [ ] 修复小地图 MaxMap 切片几何（源像素实测重排）：确认小地图拼接无错位/空白。
- [ ] 維多利亞港三家商店传送修复（装配目录 41→44 图）：确认三家店都能进。
