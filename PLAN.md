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
- [ ] **防回潮门禁是否接线**。CI 拦截"新增巨型文件 / 跨域深层导入 / 依赖环"的检查脚本已可运行
  （`scripts/refactor_audit.cjs`），但**尚未挂到 CI**，本轮只提供工具。
  2026-09-12 更新：脚本已支持 `--check` 增量门禁（未登记违规 exit 1）与 `--self-test` 自测，
  债务登记在 `artifacts/refactor/debt-register.json`；接线仍是待办。

## 仓库重构计划（MapleStory_Repository_Based_Refactoring_Plan.md）进度

> 2026-09-12 按 R0→R11 阶段表推进；本节记录已完成与未完成。改动**未提交**，回滚点 = 当前工作树 `git diff`。

### 已完成（R0–R5）

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

### R5 遗留登记

- [ ] `frameAt` 从 `assets/manifest.ts` 搬出到独立纯函数模块：搬移会破坏多个经 data URL 装载
  `animation.ts` 的既有 check，本轮判断不做；后续做 R7/R8 时机再评估。

### 未完成（R6–R11，按计划顺序）
- [ ] **R6** 收窄一条物品/任务用例的规则输入（inventory_ops/inventory + auth 模块），事务时序说明成文。
- [ ] **R7** 背包交互职责拆完（drag-controller / equipment-view 等，一个对外门面）。
- [ ] **R8** App/Session/Scene 作用域与资源计划（`app/main.ts`、`scenes/world.ts`）。
- [ ] **R9** 纯几何与内容校验抽离（拟新增 `world_geometry.rs`；注意 geometry.rs 已存在——实施前先核对 §11.1 与现状差异，不重复立项）。
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
