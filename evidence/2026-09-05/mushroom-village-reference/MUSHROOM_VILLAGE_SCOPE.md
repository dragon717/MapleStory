# 新手村参考范围清单

生成日期：2026-09-05。证据源：`参考/repos/P0nk__Cosmic/wz/Map.wz/Map/Map0/*.img.xml + String.wz/Map.img.xml + String.wz/Npc.img.xml`。

当前运行出生点固定为 `000010000` Mushroom Town。Maple Island/area 20 的可证实范围如下；原始 NPC 脚本、任务状态和商店经济本轮只登记证据，未虚构成已实现。

## 地图与传送

| 地图 | 名称 | 门点/生命证据 | 状态 |
| --- | --- | --- | --- |
| `000010000` | Mushroom Town | `out00` → `000020000`/in00；`tuto00` `tutoChatNPC`；`tuto01` `infoMinimap`；`glBmsg0` `glTutoMsg0`；`glBmsg1` `glTutoMsg0`；n:0002007 × 1, n:0002100 × 1, n:0002101 × 1 | 出生地图 |
| `000020000` | Snail Garden | `out00` → `000030000`/in00；`glBmsg0` `glTutoMsg0`；n:0002000 × 1 | 已证实范围 |
| `000020001` | Mushroom Town Townstreet | `out00` → `000020000`/in01；n:0002001 × 1 | 已证实范围 |
| `000030000` | Snail Field of Flowers | `in01` → `000030001`/out00；`out00` → `000040000`/in00；`glBmsg0` `glTutoMsg0`；n:0002102 × 1 | 已证实范围 |
| `000030001` | Mushroom Town Townstreet | `out00` → `000030000`/in01；n:0002001 × 1 | 已证实范围 |
| `000040000` | In a Small Forest | `out00` → `000050000`/in00；`tuto00` `infoAttack`；`tuto01` `infoPickup`；`tuto02` `infoSkill`；m:9300018 × 3, n:0002002 × 1, n:0002004 × 1 | 已证实范围 |
| `000040001` | Snail Hunting Ground II | `west00` → `000040000`/east00；`east00` → `000040002`/west00；`adviceMap00` `adviceMap`；`adviceMap01` `adviceMap`；m:0100100 × 23, m:0100101 × 4 | 已证实范围 |
| `000040002` | Snail Hunting Ground III | `east00` → `000050000`/west00；`west00` → `000040001`/east00；`advcieMap00` `adviceMap`；`adviceMap01` `adviceMap`；m:0100100 × 15, m:0100101 × 4 | 已证实范围 |
| `000050000` | Dangerous Forest | `east00` → `001000000`/west00；`tuto00` `infoWorldmap`；m:0100100 × 17, n:0002003 × 1, n:0002005 × 1 | 已证实范围 |
| `000050001` | The Field West of Southperry | `west00` → `000050000`/east01；`east00` → `000060000`/west00；`in00` → `001000001`/out00；`in01` → `001000002`/out00；`adviceMap00` `adviceMap`；`adviceMap01` `adviceMap`；m:0100101 × 1, m:0130100 × 3, m:0130101 × 7, m:1210102 × 3, n:0020001 × 1 | 已证实范围 |
| `000060000` | Southperry | `west00` → `000050001`/east00；`in00` → `000060001`/out00；`ev00` → `000060000`/ev99；`ev01` → `000060000`/ev99；`ev02` → `000060000`/ev99；`ev03` → `000060000`/ev99；`ev04` → `000060000`/ev99；`ev05` → `000060000`/ev99；`ev06` → `000060000`/ev99；`adviceMap00` `adviceMap`；`adviceMap01` `adviceMap`；n:0020002 × 1, n:0022000 × 1, n:9000000 × 1, n:9010000 × 1 | 已证实范围 |
| `000060001` | Southperry Armor Store | `out00` → `000060000`/in00；n:0021000 × 1 | 已证实范围 |
| `001000000` | Amherst | `west00` → `000050000`/east00；`in00` → `001000001`/out00；`in02` → `001000003`/out00；`east00` → `001010000`/west00；`tuto00` `infoReactor`；`tuto01` `infoReactor`；n:0002103 × 1, n:0010000 × 1, n:0012000 × 1, n:0012101 × 1 | 已证实范围 |
| `001000001` | Amherst Weapon Store | `out00` → `001000000`/in00；n:0011000 × 1 | 已证实范围 |
| `001000002` | Amherst Townstreet | `out00` → `001000000`/in01；无 | 已证实范围 |
| `001000003` | Amherst Department Store | `out00` → `001000000`/in02；n:0011100 × 1 | 已证实范围 |
| `001000004` | Snail Garden | `out00` → `001000000`/in01；m:0100100 × 9, m:0100101 × 12, m:0130101 × 3 | 已证实范围 |
| `001000005` | Hunting Ground Middle of the Forest I | `out00` → `001020000`/in01；m:0100101 × 5, m:0130101 × 8, m:0210100 × 12 | 已证实范围 |
| `001000006` | Hunting Ground Middle of the Forest II | `out00` → `001020000`/in02；m:0100101 × 2, m:0120100 × 3, m:0130101 × 5, m:1210102 × 15 | 已证实范围 |
| `001010000` | Entrance to Adventurer Training Center | `west00` → `001000000`/east00；`east00` → `001020000`/west00；`in00` `entertraining`；m:0100101 × 6, m:0120100 × 6, m:1210102 × 2；n:0012100、0020100、0020001 | 已证实相邻区域 |
| `001020000` | Split Road of Destiny | `west00` → `001010000`/east00；`east00` → `002000000`/west00；`top00`/`bottom00` 为同图隐藏门；n:0010200–0010204 | 已证实相邻区域 |
| `002000000` | Southperry | `west00` → `001020000`/east00；`in00` → `002000001`/out00；n:0020002、0022000、9010000 | 已证实同岛南港分支 |
| `002000001` | Southperry Armor Store | `out00` → `002000000`/in00；n:0021000 | 已证实同岛南港分支 |

## 任务证据

QuestInfo area 20 共记录 46 个条目：`1000–1001`、`1003–1046`（含 NPC 教学、收集、Maple Quiz、Mai 训练、离岛前引导）。本轮不把 XML 文本当作已实现的服务端任务状态；后续接入必须逐条读取 Check/Act/Say 与脚本。

## 键位教学修订

- 参考 `Npc.img.xml` NPC `2101` 的原文写的是 Alt 跳跃；本项目真实输入是 `Space`，地图内提示统一显示 `Space`。
- 下跳提示显示 `↓ + Space`，并与输入处理的组合优先级一致。
- 移动：方向键或 A/D；攀爬：↑/↓；普攻：X/Ctrl；拾取：Z；背包：I。

## 边界

- **确认**：地图名、Map.wz portal 的目标地图/目标门、portal 教学脚本、life 的 NPC/怪物 ID 与坐标、NPC 名称、area 20 任务条目。
- **缺失**：Cosmic/脚本化 NPC 对话执行、任务 Check/Act/Say 的权威状态、完整商店/经济、party/white EXP、所有事件/非 starter 分支。
- **不纳入**：列出的 Maple Road/Southperry/Amherst starter branch 之外的地图；`000000000–000000003` 仅保留为 intro reference，因为当前出生点没有直接链路。
