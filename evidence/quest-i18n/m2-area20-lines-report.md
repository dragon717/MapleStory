# M2 — area=20 行文本 lines.zh 补齐报告（批 B/C）

> 日期：2026-09-06。目标：让彩虹岛(area=20)所有任务都有完整中文进度描述行。

## 1. 交付

| 项目 | 值 |
|---|---|
| 本批新增 lines.zh 任务 | 60（1000–1046 除 1021 + 1048–1053 + 8000/802x/8031/8142；1021 已在批 A） |
| area=20 lines.zh 覆盖 | **61/61**（全部有行文本的任务；area=20 中 61 条里有行文本的即这些） |
| 中文任务名覆盖 | 62（含内部任务） |
| 语料总量 | 2819（wz-v83=2818 + internal=1） |
| verify | PASS（含新增『zh 行不得含 en 没有的内容标记』子集检查） |

## 2. 翻译名词依据

- 名词内联依据 `scripts/quest_i18n/resolve_names.py` 解析本地 `String.wz` 生成的
  `evidence/quest-i18n/name-catalog.json`（p 344/345、o 301/303、t 1126/1128 可解析；#m 地图名另议）。
- 例句：`p12000→卢卡斯`、`p12100→梅`、`p12101→雷恩`、`p20001→巴里`、`p20002→比格斯`、
  `p20100→尤娜`、`p22000→香克斯`、`p1002101→奥拉夫`；`o100100→蜗牛`、`o0130100→木妖`、
  `o1210100→野猪`、`o1210102→花蘑菇`；`t4000003→树枝`、`t4000011→蘑菇孢子` 等。
- 约定标注（reviewed=false，待校对）：Maple Island→彩虹岛、Victoria Island→金银岛(老大陆译)、
  Southperry→南港、Amherst→阿姆赫斯特、Lith Harbor→明珠港、Shroom→蘑菇仔、Stump→木妖、
  Jr.Sentinel→见习哨兵、Tutorial Leatty/Drumming Rabbit→教学莱提/教学打鼓兔（草稿）。
- 保留原样：未知或暂不译的 `#m…/p…` 标记、图标/数量行（`#o/#t/#c/#a/#i/#y/#u` 组合）。

## 3. 使用方式（后续批次照抄）

1. 写 `shared/quest-zh-<batch>.json`（questId → lines.zh，长度与 en 对齐）；
2. `python3 scripts/quest_i18n/apply_zh.py shared/quest-zh-b.json …`（幂等，可一次多个文件）；
3. `python3 scripts/quest_i18n/verify_quest_corpus.py` 必须 PASS；
4. 需要更新任务日志显示时再跑 `gen_quest_log_map.py`（行文本暂不参与日志展示，仅入库）。

## 4. 待办

- 全量 2757+ 条 name.zh/lines.zh（分批续做，批次文件即续传点）。
- #m 地图名解析（Map.wz 各地图 info/mapName）并入术语库。
- M3 服务端权威多语下发；校对 reviewed 翻转。
