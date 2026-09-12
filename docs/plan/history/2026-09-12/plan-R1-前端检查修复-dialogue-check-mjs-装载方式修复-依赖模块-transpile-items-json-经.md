# R1 前端检查修复：`dialogue.check.mjs` 装载方式修复（依赖模块 transpile + `items.json` 经

> 状态：已完成（原 PLAN 勾选）；未上线或待用户实玩范围按正文保留。

> 来源：PLAN.md 原第 38 行起的已完成条目；原勾选状态保留。

- **R1 前端检查修复**：`dialogue.check.mjs` 装载方式修复（依赖模块 transpile + `items.json` 经
  data URL JSON 模块加载）；新增 `client/scripts/run-checks.mjs` 逐项 runner（17 项全执行、汇总、任一失败非零）。
  `npm run check` **17/17**（修复前第 9 项失败会静默阻断后 7 项）。


