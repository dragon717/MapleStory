# 证据索引

表中链接相对本索引，来源路径相对仓库根目录。`YYYY-MM-DD` 是归档分桶日期，按源文件修改日期或文件名选择；它不代表验收日期。任务目录内保留源目录的相对结构。

| 归档目录 | 任务 | 来源 | 文件数 |
| --- | --- | --- | ---: |
| [`2026-09-14/keybindings/`](2026-09-14/keybindings/) | 自定义键盘与快捷栏离线组件检查 | `scripts/check_keybindings_ui.mjs`；四尺寸、HP/MP 留空避让与配套构建日志 | 5 |
| [`2026-09-05/bot-selftest/`](2026-09-05/bot-selftest/) | bot-selftest | `evidence/bot-selftest.json` | 1 |
| [`2026-09-05/mvp-acceptance/`](2026-09-05/mvp-acceptance/) | mvp-acceptance | `evidence/MVP_ACCEPTANCE.md` | 1 |
| [`2026-09-05/qa/`](2026-09-05/qa/) | qa | `evidence/qa/`（文件日期 2026-09-05—06） | 79 |
| [`2026-09-05/mushroom-village-reference/`](2026-09-05/mushroom-village-reference/) | mushroom-village-reference | `evidence/reference/` | 2 |
| [`2026-09-05/reference-evidence/`](2026-09-05/reference-evidence/) | reference-evidence | `references/evidence/` | 31 |
| [`2026-09-06/quest-i18n/`](2026-09-06/quest-i18n/) | quest-i18n | `evidence/quest-i18n/` | 2,829 |
| [`2026-09-07/energy-bolt/`](2026-09-07/energy-bolt/) | energy-bolt | `output/energy-bolt-before.json` | 1 |
| [`2026-09-07/skills-source-index/`](2026-09-07/skills-source-index/) | skills-source-index | `output/research-source-index-skills.png` | 1 |
| [`2026-09-07/wcr2-research/`](2026-09-07/wcr2-research/) | wcr2-research | `output/wcr2-tree.json` | 1 |
| [`2026-09-07/skill-window-source/`](2026-09-07/skill-window-source/) | skill-window-source | `output/skill-window-source/` | 7 |
| [`2026-09-07/tooltip-source/`](2026-09-07/tooltip-source/) | tooltip-source | `output/tooltip-source/` | 3 |
| [`2026-09-08/entry-ui/`](2026-09-08/entry-ui/) | entry-ui | `evidence/entry-ui/` | 15 |
| [`2026-09-08/mage-character-ui/`](2026-09-08/mage-character-ui/) | mage-character-ui | `output/mage-character-ui/` | 3 |
| [`2026-09-08/skills-check/`](2026-09-08/skills-check/) | skills-check | `output/skills-check/` | 4 |
| [`2026-09-09/client-validation/`](2026-09-09/client-validation/) | client-validation | `client/evidence/VALIDATION.md` | 1 |
| [`2026-09-10/sidewall-fix/`](2026-09-10/sidewall-fix/) | sidewall-fix | `bugfix/sidewall_fix.patch`、`bugfix/world.rs.sidewall-*` | 3 |
| [`2026-09-11/inventory-check/`](2026-09-11/inventory-check/) | inventory-check | `output/inventory-check/`（保留旧 `assets` 符号链接） | 9 |
| [`2026-09-11/playwright/`](2026-09-11/playwright/) | playwright | `output/playwright/{chat-focus,loading-flow,viewport,worldmap}/` | 49 |
| [`2026-09-12/magic-guard-review/`](2026-09-12/magic-guard-review/) | magic-guard-review | `output/magic-guard-review/` | 1 |
| [`2026-09-12/minimap-check/`](2026-09-12/minimap-check/) | minimap-check | `output/minimap-check/`（保留旧 `assets` 符号链接） | 5 |
| [`2026-09-12/minimap-fix/`](2026-09-12/minimap-fix/) | minimap-fix | `output/minimap-fix/` | 5 |
| [`2026-09-12/playwright/`](2026-09-12/playwright/) | playwright | `output/playwright/{minimap-buttons,minimap-header}/` | 7 |
| [`2026-09-12/directory-migration/`](2026-09-12/directory-migration/) | directory-migration | 主代理本轮生成 | 1 |
| [`2026-09-12/refactor-recovery/`](2026-09-12/refactor-recovery/) | refactor-recovery | 主代理整理 | 1 |
| [`2026-09-12/runtime-snapshots/`](2026-09-12/runtime-snapshots/) | runtime-snapshots | 主代理从 `runtime/` 整理 | 3 |
| [`2026-09-12/runtime-recovery/`](2026-09-12/runtime-recovery/) | runtime-recovery | 主代理从 `3010-control/` 整理 | 8 |
| [2026-09-12/retired-runtime/](2026-09-12/retired-runtime/) | 已退出服务的历史日志与 PID | 原 output/ | 4 |
| [2026-09-12/refactor-recovery/](2026-09-12/refactor-recovery/) | 一次性重构脚本恢复证据 | 原 artifacts/refactor/ | 1 |
| [`2026-09-19/notebook-ui/`](2026-09-19/notebook-ui/) | notebook-ui 冒险笔记六页签（骑宠页、椅子页，以及骑宠页下的**鞍具子页**）与配置 ID 标签的离线样张与对比度/命中测试 | `scripts/check_tms273_notebook_ui.mjs`；四尺寸样张含 `mount-1440x900.png`、`saddle-1440x900.png`、`chair-1440x900.png` | 14 |

本批共归档 3,058 个证据文件；`output/wcr2-Calculator.cs` 与 `output/wcr2-SummaryParser.cs` 是纯源码研究工具，已移至 `scripts/research/`，见迁移映射 [directory-migration/moves.json](2026-09-12/directory-migration/moves.json)。残余旧日志/PID 归入 `2026-09-12/retired-runtime/`，夹具资产链接已按新目录重建；无运行引用的旧研究构建已清理，`output/` 已移除。本批未处理 `bugfix/*.md`，其归档由文档代理负责。运行态与恢复快照由主代理处理，数据库快照未删除。
