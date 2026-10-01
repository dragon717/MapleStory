# Git忽略规则与文件归属整理

2026-10-01，已完成。承接用户的Git整理与提交授权，主代理决定边界并操作Git；两名GPT-5.6 Luna / max辅助只读核对源码遗漏和生成物消费者。未重启3010、修改数据库、推送或改写历史。

## 补入误忽略文件

`evidence/*` 之前把手写发现与脚本一并屏蔽。现保留目录及Markdown、复现脚本、补丁，自动截图、日志、JSON和打包页面继续忽略。本次补入：

- `evidence/2026-09-20/colossus-six-gardens/README.md`：手写实证说明；旧计划把整目录列为本地证据，本次依据用途仅将说明纳入Git，其余生成物仍留本地。
- `evidence/2026-09-21/perion-boar-triage/`：根因核对、落地修复两份Markdown。
- `evidence/2026-09-21/perion-portal-links/`：根因核对及两个`repro/*.cjs`。文档中的账号标识已省略；保留历史条件，不把旧结论当作当前验收结果。

桌面配置引用的`client/src-tauri/icons/*.png`已放开忽略；当前磁盘上三个PNG缺失，本次未生成或提交不存在的图标。`icon-source.png`仍是忽略的中间输出，已入库的ICO/ICNS保留。

## 停止跟踪44个生成物

使用`git rm --cached`保留本地文件；提交只改变后续版本归属，旧Git对象未清理。

| 类别 | 数量 | 依据 |
| --- | ---: | --- |
| `artifacts/henesys/`、`artifacts/windbell/` | 25 | 原型、渲染及启动检查的JSON/日志，脚本可重建 |
| `artifacts/refactor/{frontend-deps,large-files}.json` | 2 | `scripts/refactor_audit.cjs`覆盖生成 |
| `artifacts/portal-*.json` | 3 | 闭包与边界检查报告，手写Python检查源码保留 |
| TMS源卷审计、当前装配缺口报告 | 2 | 自动重算；修复前先跑`assemble_tms273.cjs`生成当前缺口 |
| `evidence/2026-09-17/notebook-ui/` | 6 | 检查脚本生成的harness、页面、数据、打包JS/CSS与资源链接 |
| 浏览器检查/导出摘要、头像导出摘要 | 3 | 输出摘要不被业务读取；manifest/map夹具保留 |
| `references/tms273-data/{quests,manifest}.json` | 2 | 与已忽略的maps.json同属`import_tms273.py`导出，完整重建入口`build_tms273.cjs` |
| `scripts/_probe_skill_outlinks.json` | 1 | 探针输出，源脚本保留 |

不以扩展名判定全部JSON：保留`debt-register.json`门禁输入、人工`baseline-metrics.json`、追加式`tms273_export_gap_repair.json`修复历史、`tms273_item_definition_backfill.json`门禁来源、`_probe_canvas_volumes.json`下游探针输入、`*-source.json`核定来源和完整研究包。README职责及旧的「frontend-deps提交前还原」说明已同步。

## 必要验证

- `node scripts/check_gitignore.cjs`：17个源码/输入路径应可入库、20个生成/私有路径应忽略，且没有被忽略却仍跟踪的文件，通过。
- 44个停止跟踪文件逐个对照SHA-256或符号链接目标，本地保留且内容未变。
- 新复现脚本仅作语法检查，未执行历史WZ/数据库取证，也未启动独立QA；本次不涉及运行代码。
- 提交前执行暂存区空白检查及仓库既有体积/iCloud副本守卫。
