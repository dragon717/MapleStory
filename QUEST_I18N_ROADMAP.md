# 任务多语言（Quest i18n）执行手册

> 状态：**v2，2026-09-06（已执行落地）**。原「路线 + M1–M4 里程碑」已合并为本手册——以下全部为**可直接执行的命令流程**，原里程碑段落已删除（执行记录见 §4）。
> 当前交付：v83 全量中英双语语料已就绪并入库（**zh 任务名 2008 条 / zh 阶段行文本 1382 条 / 日志摘要 2 条**）；服务端权威多语下发已在 3010 运行（protocol 6 / `gms83-quest-2`），双语 questList e2e 探针 en/zh PASS（含官方语料断言 quest 1000=借来莎丽的镜子）。证据与报告见 `evidence/quest-i18n/`。

---

## 0. 一句话现状

- **英文已全量权威**：本地 `参考/repos/P0nk__Cosmic/wz/Quest.wz/QuestInfo.img.xml` 即完整 GMS v83（2818 条有名称任务、8004 行阶段文本、~23 万词）。
- **中文已全量联网补齐**（用户放宽"不限版本/不限途径、只要全"）：主源 **mxd.dvg.cn 冒险岛小册子**用同一 questId 提供**国服官方简体译名 + 原版阶段文本**（2026-09-06 实测 2817/2818 条可达）；已交叉校验后导入 **2004 条官方译名 + 1369 条官方阶段文本**（其中 189 条为复核同类候选），另有 **476 条候选**待人工复核。
- **多语言**：服务端 `questList/questUpdate` 按玩家 `lang`（zh/en，缺省 zh）下发权威文本；客户端零翻译表。

---

## 1. 语料源与版本策略

| 用途 | 主源 | 评估（2026-09-06 实测） |
|---|---|---|
| 英文（权威底） | 本地 v83 WZ `Quest.wz/QuestInfo.img.xml` | 全量、离线、精确一致，**永远以此为准** |
| 中文译名+阶段文本（主） | **mxd.dvg.cn** `questsinfo.php?id=<questId>` | 同 id 给 国服/台服/国际/韩服四语名 + 分阶段原版文本（含 WZ 标记）；2817/2818 可达，抓全量 ~2 分钟 |
| 中文（备/交叉） | wanmxd.com / mxdzlk.com `quest/<id>/` | 中英名+等级/NPC/奖励列表页 1289 条；可作第二手参考 |
| 中文（抽查） | maplestory.io `/api/...` | 半下线（列表/明细超时、cms 不可达），仅抽查名词用，不当主源 |

**版本策略（防"版本串味"）**：本地 v83 英文是唯一裁判。所有第三方中文在合入前必须通过 **英文名一致性交叉校验**（`build_official_batch.py`）——英文名一致才进正式批次；不一致（如 quest 2024 v83 是 100 个诅咒娃娃、国服是 50 个）**只进候选文件，不自动合入**。

---

## 2. 数据模型（`shared/quest-text.json`，schemaVersion 1）

```jsonc
{
  "quests": {
    "1000": {
      "name":  { "en": "Borrowing Sera's Mirror", "zh": "借来莎丽的镜子" },
      "lines": { "en": [...], "zh": ["去找希娜。", "..."] },  // 阶段行，行数与 en 一致
      "raw":   { "en": [...] },               // v83 WZ 原文（可回溯）
      "meta":  { "area": 20, "order": 1, "parent": "..." },
      "sources": {
        "en": { "kind": "wz-v83", "file": "Quest.wz/QuestInfo.img/1000" },
        "zh": { "kind": "official-cn", "site": "mxd.dvg.cn ...", "url": "...",  // 官方源留痕
                "reviewed": false, "note": "..." }
      }
    },
    "1021": {  // 已上线任务：sources.zh.pinned = true
      ...
    }
  }
}
```

要点：
- **语料键 = questId**（字符串），兼容 `1021` 与内部任务 `maple-road-training`。
- `sources.zh` 三态来源：`official-cn`（联网官方语料）/ `ai`（AI 草稿）/ `pinned`（已上线、e2e 依赖，**后续批次默认不覆盖**，除非 `--force`）。
- 中文文本**整句落地**、名词经术语表直译；`#p/#t` 已知词条已替换为中文，无法解析的内容标记整行不导入（防半残文本）。
- `reviewed:false` 为默认，校对后翻 `true`。

---

## 3. 直接执行手册（SOP）

> 管线脚本都在 `scripts/quest_i18n/`；中文批次文件在 `shared/quest-zh-*.json`；原始缓存 `evidence/quest-i18n/cache/dvg/*.html`（断点续传、可离线重算）。

### 3.0 一条命令全量重做（幂等，可随时重跑审计）

```bash
# ① 联网抓全量（默认取语料全部 v83 id；~2-3 分钟，断点续传，重复跑只补缺口）
python3 scripts/quest_i18n/fetch_dvg.py --all --workers 6 --delay 0.12
#    离线重算：加 --offline（只用缓存）

# ② 交叉校验 + 生成批次（en 一致进 quest-zh-official.json；不一致进 quest-zh-official-candidates.json；回填 NPC 术语表加 --update-glossary）
python3 scripts/quest_i18n/build_official_batch.py --update-glossary

# ③ 锁定已上线文案（防止被机器覆盖；已执行过，幂等）
python3 scripts/quest_i18n/apply_zh.py --pin 1021,maple-road-training

# ④ 合入官方批次
python3 scripts/quest_i18n/apply_zh.py shared/quest-zh-official.json

# ⑤ 质量门（零错误才算过）
python3 scripts/quest_i18n/verify_quest_corpus.py
```

### 3.1 日常：新任务进入 `shared/gameplay.json` 时补中文

```bash
# 看"该翻谁"（默认 follow gameplay 上线顺序，不做全库盲译）
python3 scripts/quest_i18n/zh_todo.py
# 拿到待翻 id 后：先试官方源（免费、权威、0 成本）
python3 scripts/quest_i18n/fetch_dvg.py --ids 1021,2024
python3 scripts/quest_i18n/build_official_batch.py
python3 scripts/quest_i18n/apply_zh.py shared/quest-zh-official.json
# 官方没有/行文本对不齐的，再走 AI 批次流程（quest-zh-*.json → apply_zh.py，同前）
```

### 3.2 人工复核候选批次（版本差异，当前 ~476 条）

```bash
# ① 生成初审清单（启发式分类：count-drift 数字漂移 / likely-same 高相似 / needs-review）
python3 scripts/quest_i18n/review_candidates.py review     # -> evidence/quest-i18n/candidates-review.tsv

# ② 逐条核对 TSV 后，把确认是同一任务的候选并入正式批次（可 --ids 或按标签批量）
python3 scripts/quest_i18n/review_candidates.py promote --ids 2024,2025
python3 scripts/quest_i18n/review_candidates.py promote --tag count-drift
python3 scripts/quest_i18n/apply_zh.py shared/quest-zh-official.json
python3 scripts/quest_i18n/verify_quest_corpus.py
```
> 已在 2026-09-06 落地：自动提拔 189 条「去版本前缀后英文名与 v83 完全一致」的确定同类（`[Party Quest] xxx` 等）；余下需人眼确认的任务链归属。

### 3.3 发布 / 上线（改语料后）

```bash
# 服务端是唯一文本源，改 quest-text.json 只需重启 3010（不用重建客户端 dist）：
#   cargo test --manifest-path server/Cargo.toml          # 0 失败
#   ~/.cargo/bin/cargo build --manifest-path server/Cargo.toml   # 重编后重启 3010
# 重启后验证双语下发：
node qa/quest_i18n_probe.mjs      # en/zh questList PASS
node qa/quest_smoke_probe.mjs     # 含 questUpdate 推送断言
```
> 注意：如改动涉及 `contentVersion`（`gms83-*`）则需同步 `shared/gameplay.json`、`evidence/runtime/gameplay-round2.json`、`client/public-gameplay/assets/manifest.json` 并重建 dist（M3 发布窗口同款纪律）。

### 3.4 校对（reviewed 翻转）

```bash
# 导待校对清单（按 area/批次），人工改 shared/quest-text.json 的 reviewed:false→true
python3 scripts/quest_i18n/zh_todo.py --survey   # 全库盘点
```
- 已上线 2 任务（1021 / maple-road-training）文案为人工认可版并 pinned；官方译名差异见报告 §2，是否跟随官方由你拍板（`apply_zh.py --force` 可覆盖）。

### 3.5 术语表维护

- `shared/quest-glossary.json` 已回填 **486 个 NPC 官方中文名**（src=official-cn，源自任务页接取/完成 NPC，`/npcsinfo.php?id=N` 可扩抓）。
- `#o`（怪物）/`#t`（道具）仍为彩虹岛 draft；缺词清单在抓取报告的 §4（未被替换的内容标记 Top N），新区域上线时按 `scan_tokens.py` 扩容。

### 3.6 扩展语言（备选，当前只做中英）

mxd.dvg.cn 同 id 还提供 台服/韩服 官方名；若将来要繁体/韩文，在 `fetch_dvg.py` 解析与 `quest-text.json` 加 locale 键即可（服务端 `name/log` 是 locale→文本 map，天然支持）。

---

## 4. 已完成执行记录（2026-09-06，替代原 M1–M4 拆分）

| 项 | 结果 | 证据 |
|---|---|---|
| 英文 scaffold 全量入库 | 2818 条 wz-v83 + 1 internal；verify PASS | `evidence/quest-i18n/m1-english-scaffold-report.md` |
| AI 中文草稿（彩虹岛可玩区） | area=20 名称 61/61、行文本、日志摘要 2 条 | `shared/quest-zh-{a,b,c}.json` |
| **联网全量官方中文抓取** | mxd.dvg.cn 2817/2818 条、7207 阶段行、487 NPC 中文名 | `evidence/quest-i18n/dvg-raw.json`（HTML 缓存 cache/dvg/） |
| 交叉校验导入 | 官方 zh 名 **2004**（含 189 条复核同类提拔）+行文本 1369；候选 476 待复核 | `shared/quest-zh-official.json`、`official-zh-report.md`、`candidates-review.tsv` |
| 术语表权威化 | NPC #p 回填 486 条（src=official-cn） | `shared/quest-glossary.json` |
| 语料终态 | quests=2819，**zh name 2008 / zh lines 1382 / log 2**，verify PASS | `shared/quest-text.json` |
| 服务端多语下发（M3，已上线） | protocol 6 / `gms83-quest-2`；questList/questUpdate 按 lang 下发 | `qa/quest_i18n_probe.mjs` en/zh PASS（含 1000 官方名断言） |
| 质量门 | cargo test 66/66、quest_smoke 8/8、verify 零错误 | — |

---

## 5. 校验与质量门（每次合入必须零错误）

```bash
python3 scripts/quest_i18n/verify_quest_corpus.py
# PASS  quests=2819 (wz-v83=2818, internal=1), zh: name=2008 lines=1382 log=2
```
检查项：wz 键集一致、raw/lines 对齐、clean 幂等、zh 行数与 en 一致、**zh 行不发明 en 没有的内容标记**、sources.zh 有 reviewed 标记。

---

## 6. 保持关闭的 Gate（按需再开，不提前做）

1. **整站爬取第三方资料站**：只抓任务文本/名词等结构化字段（源站留痕），不做整站镜像。
2. **候选批次（英文名不一致）自动合入**：必须人工复核，防版本串味。
3. **全库盲译**：新任务一律 follow `shared/gameplay.json` 上线顺序（`zh_todo.py`），不预翻 2757 条永不展示内容。
4. **非中英语言（繁体/韩文等）UI**：数据层已可扩展，UI/协议层不做不承诺。
