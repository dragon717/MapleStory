# R5 依赖债务清偿：新增 `assets/avatar-types.ts`（零导入类型叶：Point/Part/Frame/AvatarActionSet），

> 状态：已完成（原 PLAN 勾选）；未上线或待用户实玩范围按正文保留。
> 状态：已完成（待验收）

> 来源：PLAN.md 原第 56 行起的已完成条目；原勾选状态保留。

- **R5 依赖债务清偿**：新增 `assets/avatar-types.ts`（零导入类型叶：Point/Part/Frame/AvatarActionSet），
  `manifest.ts` 删除原定义改 `import type` + `export type` re-export，`entry/appearance.ts` 改引 avatar-types——
  manifest↔appearance 类型环消除；新增 `network/auth-api.ts`（`authenticate()` 机械搬出，语义逐行一致），
  `entry/view.ts` 改引 auth-api——entry→session 违规清零；**附带实证并修复 §9.3 缺陷**：
  `session.ts` 原先 `connect()` 调 `close()` 会把 `stopped` 置 true 导致重连被永久抑制，
  改为新增 `closeSocket()`（只清定时器+关 socket）、`connect()` 走 `closeSocket()`、`close()` 保留置 stopped；
  新增 `network/session.check.mjs`（重连调度区间、终端码、主动关闲语义）；
  `debt-register.json` 两笔债务结清（items 清空 + `_history` 记录）。


