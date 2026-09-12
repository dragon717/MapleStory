# R8 App/Session/Scene 作用域与资源计划：新增 `assets/preload-plan.ts`

> 状态：已完成（原 PLAN 勾选）；未上线或待用户实玩范围按正文保留。
> 状态：已完成（待验收）

> 来源：PLAN.md 原第 91 行起的已完成条目；原勾选状态保留。

- **R8 App/Session/Scene 作用域与资源计划**：新增 `assets/preload-plan.ts`
  （`buildPreloadPlan` 纯函数：world.ts preload 收集段逐行搬出，全量策略/顺序/去重语义不变，
  BGM 的 cache 短路以 `skipIfCached` 标记留在 Scene 执行）与 `app/page-shell.ts`
  （PageShell：页面模板/语言切换/新闻弹窗/game-mode 布局搬移，DOM ID 与可访问性逐行保留，
  status() 的提示定时器仍归 main）；`scenes/world.ts` 780→705、`app/main.ts` 685→650。
  新增 `preload-plan.check.mjs` + `page-shell.check.mjs`，runner 增至 **24/24 全过**；
  生命周期确认（§10.2 对照表，含 game-session.ts 暂不拆的理由）成文于
  `FRONTEND_ARCHITECTURE.md` §6.1。切图/重连/重建的静态回归由 tsc + 24 项 check 覆盖；
  实玩复验仍按既有流程待重启 3010 后进行。



