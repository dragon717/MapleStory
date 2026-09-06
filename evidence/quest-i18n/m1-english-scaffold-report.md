# M1 — v83 任务英文 scaffold 入库报告

> 产出：`shared/quest-text.json`（schemaVersion 1）；本报告供抽查。
> 生成：`scripts/quest_i18n/extract_questinfo.py`，2026-09-06。
> 数据源：`参考/repos/P0nk__Cosmic/wz/Quest.wz/QuestInfo.img.xml`（本地 v83 权威，未联网）。

## 1. 规模统计

| 指标 | 值 |
|---|---|
| 任务条目（有 name） | 2819（wz-v83=2818，内部=1） |
| 编号描述行总数（raw） | 8001 |
| 编号描述行总数（clean） | 8001 |
| 描述文本词数（raw，不含 name） | 216467 |
| name 词数 | 10538 |
| 无编号行的任务数 | 2 |
| 含颜色标记被清洗的行数 | 4389 |

按 area 分布（前 8）：area 10:337、area 15:126、area 20:61、area 30:430、area 33:120、area 37:168、area 40:4、area 41:49

当前可玩范围 area=20 共 61 条：`1000, 1001, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014, 1015, 1016, 1017, 1018, 1019, 1020, 1021, 1022, 1023, 1024, 1025, 1026, 1027, 1028, 1029, 1030, 1031, 1032, 1033, 1034, 1035, 1036, 1037, 1038, 1039, 1040, 1041, 1042, 1043, 1044, 1045, 1046, 1048, 1049, 1050, 1051, 1052, 1053, 8000, 8020, 8021, 8022, 8023, 8024, 8025, 8031, 8142`

## 2. 抽查样本

### 1021 Roger's Apple（当前已实现任务）

| 项 | 值 |
|---|---|
| name | Roger's Apple |
| raw[0] | `Let's talk to #b#p2000##k.` |
| clean[0] | `Let's talk to #p2000#.` |
| raw[1] | `By pressing the hotkey I, I can consume #b#t02010007##k in consumption window. Let's talk to #b#p2000##k..` |
| clean[1] | `By pressing the hotkey I, I can consume #t02010007# in consumption window. Let's talk to #p2000#..` |
| raw[2] | `I learned how to use items! This will make life much easier!` |

### 1000 Borrowing Sera's Mirror（area 20 首条）

| 项 | 值 |
|---|---|
| name | Borrowing Sera's Mirror |
| raw[0] | `Let's go to Heena.` |
| raw[1] | `I ran into Heena who was worrying about her face getting irritated by the strong sunlight. I have to get a mirror for Heena from her sister, Sarah.` |
| raw[2] | `Heena asked me to go to her sister and get a mirror for her. I walked my way to Sarah.` |

### 10210（area 50 样本）

| 项 | 值 |
|---|---|
| name | Gaga's Analysis |
| raw[0] | `Gather up some #t4001237#s and hand them over to Gaga.` |
| raw[1] | `Gather up some #t4001237#s and hand them over to Gaga.` |

## 3. 说明

- `lines.en` = raw 去掉颜色标记（#b/#r/#g/#d/#k）后的版本，保留 #p/#t/#c/#o/#s/#v 等内容标记与原文，供 M2 翻译与名词替换。
- `raw.en` = WZ 原文精确副本（实体解码后），可随时重新生成 clean，管线可回溯。
- zh 富化（name.zh/lines.zh/log/sources.zh）与内部条目会在重跑时被保留（apply_zh/gen_quest_log_map 产出）。
