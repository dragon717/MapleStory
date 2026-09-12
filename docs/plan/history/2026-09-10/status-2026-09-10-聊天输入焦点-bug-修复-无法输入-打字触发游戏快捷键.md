# 2026-09-10 聊天输入焦点 bug 修复（无法输入/打字触发游戏快捷键）
> 状态：已完成

> 来源：迁移前 IMPLEMENTATION_STATUS.md 原第 9–18 行；原条目状态保留，不因迁移改判。


- 现象：聊天栏打字"无法输入"，按键触发游戏系统快捷键（移动/技能等）。
- 排查方法：纸面梳理 PlayerInput/ChatView 焦点与键盘守卫后，用离线 Playwright 复现脚本（`client/src/app/chat-focus.check.mjs`，esbuild 打包真实 app + mock Connection，复用 viewport.check 骨架）做逐键断言；证明"焦点真正落输入框时零泄漏"（方向/空格/Z/X/数字/A/D 全不穿透），按住方向键开聊的 HELD 场景在 focusin→reset 时发 direction:0 立即停止。
- 根因一：聊天面板折叠后 `input.disabled=true`，ChatView `onGlobalKeyDown` 的 Enter 分支因 `this.input?.disabled` 直接 return——不展开面板、不聚焦输入框，玩家按 Enter 无反应，后续按键全部落到游戏快捷键。
- 根因二：273 皮肤可见"输入框底图"大于真实 input（`chat273-input` 绝对定位仅 15px 高），点击底图空白处焦点落在页面 body（非 input 控件），PlayerInput.blocked() 不生效 → 打字触发游戏键。
- 修复（`client/src/features/chat/view.ts`）：① Enter 分支守卫由 `this.input?.disabled` 改为 `!this.available`，先 `setOpen(true)`（`updateInputState` 解除 disabled）再 `focus()`，折叠态 Enter 可重开并聚焦；② 新增 `onRootPointerDown`：点击面板非控件/非日志区域（排除 input/textarea/select/button/contenteditable/.chat273-log/.chat-log）→ preventDefault + setOpen(true) + 聚焦输入框，日志保留原生滚动，`destroy()` 同步移除。`input.ts` 仅注释说明"blocked 时不得 re-add held"的既有不变式（无逻辑改动）。
- 验证：chat-focus.check.mjs 9 场景全过（Enter 聚焦、打字/逐键隔离、提交、Esc 回游戏、按住移动键开聊立即停止、折叠 Enter 重开聚焦、点击面板空白聚焦输入框）；`tsc --noEmit` 通过。复现脚本保留为回归测试。
- 未上线：在线服务仍跑旧前端；待 `启动3010.command` 统一构建（protocol 11）后实玩验证。

