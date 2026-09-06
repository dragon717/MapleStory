# M2 — 中文批 A 落地报告（area=20 任务名 + 两条现行任务深文本）

> 状态：语料已合并并 PASS 自检；客户端日志已改从语料生成的映射读取（代码未发布，随下次受控更新生效）。
> 日期：2026-09-06。管线：`apply_zh.py` → `verify_quest_corpus.py` → `gen_quest_log_map.py`。

## 1. 本批内容

| 项目 | 数量/说明 |
|---|---|
| `name.zh` | **62** 条：area=20 全部 61 条 + 内部任务 `maple-road-training` |
| `lines.zh` | 1021（3 行，与 en 行数对齐）——其余 area20 的行文本留待术语库扩充后分批翻译 |
| `log`（日志卡片摘要 zh/en） | 2 条：1021 与 `maple-road-training`（与既有展示文案一致，避免观感回退） |
| `sources.zh` | 全部标记 `kind=ai, reviewed=false, note=…`（校对位预留） |

语料现状：`shared/quest-text.json` 共 **2819** 条（wz-v83=2818 + internal=1）；verify PASS。

## 2. 落库样例

### 1021 Roger's Apple / 罗杰的苹果（当前已实现任务，完整深文本）

| 行 | en（权威，clean） | zh（批 A 草稿） |
|---|---|---|
| name | Roger's Apple | 罗杰的苹果 |
| 0 | Let's talk to #p2000#. | 去找罗杰谈谈吧。 |
| 1 | By pressing the hotkey I, I can consume #t02010007# … | 在消耗栏里按 I 键，双击「罗杰的苹果」就能使用。之后回去找罗杰谈谈吧。 |
| 2 | I learned how to use items! This will make life much easier! | 我学会使用道具了！以后会方便很多！ |
| log | Talk to Roger on Maple Road. … | 前往冒险岛路与罗杰对话，使用他给你的罗杰的苹果恢复 HP 到满值。 |

### 1007 / 1008（名称抽样）
- Bigg's Collection of Items → 比格斯的收藏品
- Pio's Collecting Recycled Goods → 皮奥回收旧物

## 3. 名词约定（待校对清单，录入批 A notes 与语料 sources.zh）

沿用代码库已有：Sera=赛拉、Heena=希娜、Roger=罗杰、Mai=梅。
音译草稿（reviewed=false）：Rain→雷恩、Shanks→香克斯、Yoona→尤娜、Bari→巴里、Biggs→比格斯、
Pio→皮奥、Robin→罗宾、Todd→托德、Lucas→卢卡斯、Maria→玛丽亚、Nina→妮娜、Sen→森、Sarah→萨拉、
Amherst→阿姆赫斯特、Lith Harbor→明珠港、Victoria Island→金银岛(老大陆译法)。

## 4. 客户端接入

- 生成 `client/src/features/quest/quest-text.generated.ts`（62 条，勿手改，由 `gen_quest_log_map.py` 重新生成）。
- `client/src/features/quest/log.ts` 删除硬编码 `QUEST_TEXTS`，`localize()` 改查 `questTextMap`；摘要缺失时回退服务端下发的 en 原文，保证不空文本。TS typecheck PASS（未重新构建 dist，发布随下次受控更新）。

## 5. 待办（后续批次）

1. **术语库扩容**：依据 `evidence/quest-i18n/token-report.json`（#p 4648 次/约 300+ 不同 NPC、#t 道具、#o 怪物、#m 地图）先补齐 area=20 所需 id 的中英名词，来源尽量用大陆服老资料站抽核。
2. **area20 行文本 lines.zh 补齐**（61 条），完成后 1021 之外的条目也有完整进度描述。
3. **全量（2757+ 条）name.zh 与 lines.zh**：分批生成 + 断点续传；`apply_zh.py` 已支持追加批次文件。
4. **M3 服务端权威多语源**：questList/questUpdate 按语言下发，客户端彻底去掉回退逻辑（协议 bump，单独发布窗口）。
5. **校对**：批量把 `reviewed=false` 翻为已校对（关键词见 §3 清单）。
