# R10 门禁接线 + 例外登记 + 架构导航与模块契约更新：

> 状态：已完成（原 PLAN 勾选）；未上线或待用户实玩范围按正文保留。
> 状态：已完成（待验收）

> 来源：PLAN.md 原第 109 行起的已完成条目；原勾选状态保留。

- **R10 门禁接线 + 例外登记 + 架构导航与模块契约更新**：
  `refactor_audit.cjs --deps --check`（R2 就绪）挂进 `client/scripts/run-checks.mjs` 仓库级末项，
  `npm run check` **25/25 全过** = 门禁通过；例外登记 `artifacts/refactor/debt-register.json`（当前 0 项）。
  **拦截实证**：临时制造 `features/player → app/main.ts` 运行时导入 → 门禁报
  `entry-app-not-imported-by-features` 且 exit 1，删除后复位 exit 0——"新增越界失败、历史债务不自动扩张"
  的退出条件验证闭环。架构导航：`FRONTEND_ARCHITECTURE.md` 新增 §5.1 检查与防回潮门禁
  （含 CI 接入命令）；`BACKEND_ARCHITECTURE.md` 模块表补 `world::geometry` 契约条目（R9）。
  本仓库无远程 CI；接入时执行 `node scripts/refactor_audit.cjs --deps --check` 即可。



