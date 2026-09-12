# 防回潮门禁接线（R10 完成，2026-09-12）。`scripts/refactor_audit.cjs --deps --check` 已挂进

> 状态：已完成（原 PLAN 勾选）；未上线或待用户实玩范围按正文保留。

> 来源：PLAN.md 原第 24 行起的已完成条目；原勾选状态保留。

- **防回潮门禁接线（R10 完成，2026-09-12）**。`scripts/refactor_audit.cjs --deps --check` 已挂进
  `client/scripts/run-checks.mjs`（仓库级末项），`npm run check` 25/25 全绿 = 门禁通过；
  例外登记在 `artifacts/refactor/debt-register.json`（当前 0 项债务）。
  本仓库无远程 CI——将来接入 CI 时执行同一条命令即可：`node scripts/refactor_audit.cjs --deps --check`。
  新增越界（新巨型文件/跨域深层导入/依赖环）会令 `npm run check` 失败；历史债务不自动扩张。



