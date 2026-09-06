#!/usr/bin/env python3
"""M1: 从本地 v83 Quest.wz/QuestInfo.img.xml 提取全量任务英文 scaffold。

产出 shared/quest-text.json（schemaVersion 1）与
evidence/quest-i18n/m1-english-scaffold-report.md（统计 + 抽查样本）。

幂等/合并语义：
  - en/raw/meta 永远以本地 WZ 为权威，重跑即刷新；
  - 若语料已存在，会保留每条的 zh 富化（name.zh/lines.zh/log/sources.zh）
    以及非 wz-v83 的内部条目（如 maple-road-training），不会被重跑冲掉。

设计要点（与 QUEST_I18N_ROADMAP.md 一致）:
  - 权威英文来自本地 WZ，不做联网。
  - lines(clean) 只去掉颜色标记(#b/#r/#g/#d/#k，整对删除)，保留 #p/#t/#c/#o/#s/#v
    等内容标记；raw 保留原文以便回溯。名词替换是 M2 术语表职责。

用法:
  python3 scripts/quest_i18n/extract_questinfo.py [--wz PATH] [--out PATH] [--report PATH]
"""
from __future__ import annotations

import argparse
import html
import json
import re
import sys
from collections import Counter
from pathlib import Path

# 颜色/排版单字符标记（仅剥离这些，不影响 #p/#t/#c 等内容标记）
COLOR_TAGS = frozenset("brgdk")
QUEST_BLOCK = re.compile(r'<imgdir name="(\d+)">(.*?)</imgdir>', re.S)
STRING_NODE = re.compile(r'<string name="([^"]+)" value="([^"]*)"\s*/>')
INT_NODE = re.compile(r'<int name="([^"]+)" value="([^"]*)"\s*/>')


def clean_colors(text: str) -> str:
    """删除 #b/#r/#g/#d/#k 颜色标记（含字母本身），保留其余 # 标记与文本原样。

    整对删除而非只删 '#'：文本形如 `#b#p12101##k`（内容标记收尾 '#' + 颜色结束
    '#k'），若只删 '#' 会留下孤立 b/k 字母，且二次清洗会误删内容标记的收尾 '#'。
    """
    return re.sub(r"#([brgdk])", "", text)


def parse_quest_body(body: str) -> dict:
    strings: dict[str, str] = {}
    for m in STRING_NODE.finditer(body):
        strings[m.group(1)] = html.unescape(m.group(2))
    ints: dict[str, int] = {}
    for m in INT_NODE.finditer(body):
        try:
            ints[m.group(1)] = int(m.group(2))
        except ValueError:
            pass
    numbered = {int(k): v for k, v in strings.items() if k.isdigit()}
    raw_lines = [numbered[i] for i in sorted(numbered)]
    return {
        "name": strings.get("name", ""),
        "parent": strings.get("parent"),
        "raw_lines": raw_lines,
        "cleaned_lines": [clean_colors(t) for t in raw_lines],
        "area": ints.get("area"),
        "order": ints.get("order"),
    }


def sort_key(qid: str):
    return (qid.isdigit() is False, int(qid) if qid.isdigit() else qid)


def main() -> int:
    ap = argparse.ArgumentParser()
    root = Path(__file__).resolve().parents[2]
    ap.add_argument("--wz", default=str(root / "参考/repos/P0nk__Cosmic/wz/Quest.wz/QuestInfo.img.xml"))
    ap.add_argument("--out", default=str(root / "shared/quest-text.json"))
    ap.add_argument("--report", default=str(root / "evidence/quest-i18n/m1-english-scaffold-report.md"))
    args = ap.parse_args()

    wz = Path(args.wz)
    if not wz.exists():
        print(f"Quest.wz XML 不存在: {wz}", file=sys.stderr)
        return 2
    xml = wz.read_text(encoding="utf-8")

    # 保留既有富化（zh/log/内部条目），避免重跑 extract 冲掉 apply_zh 的成果
    out = Path(args.out)
    old_quests = {}
    if out.exists():
        try:
            old_quests = json.loads(out.read_text(encoding="utf-8")).get("quests", {})
        except Exception:
            old_quests = {}
    internal_old = {
        qid: e
        for qid, e in old_quests.items()
        if e.get("sources", {}).get("en", {}).get("kind") != "wz-v83"
    }

    quests: dict[str, dict] = {}
    for m in QUEST_BLOCK.finditer(xml):
        qid = m.group(1)
        parsed = parse_quest_body(m.group(2))
        if not parsed["name"]:
            continue  # 无 name 的条目不构成"任务"，跳过（如部分 imgdir）
        old = old_quests.get(qid, {})
        entry = {
            "name": {"en": parsed["name"]},
            "lines": {"en": parsed["cleaned_lines"]},
            "raw": {"en": parsed["raw_lines"]},
            "meta": {
                k: parsed[k]
                for k in ("area", "order", "parent")
                if parsed.get(k) is not None
            },
            "sources": {
                "en": {"kind": "wz-v83", "file": f"Quest.wz/QuestInfo.img/{qid}"}
            },
        }
        # 保留既有富化（zh 名/zh 行/log/来源标记）
        if old.get("name", {}).get("zh"):
            entry["name"]["zh"] = old["name"]["zh"]
        if old.get("lines", {}).get("zh") is not None:
            entry["lines"]["zh"] = old["lines"]["zh"]
        if "log" in old:
            entry["log"] = old["log"]
        if old.get("sources", {}).get("zh"):
            entry["sources"]["zh"] = old["sources"]["zh"]
        quests[qid] = entry
    # 内部条目（如 maple-road-training）不在 WZ 里，保留
    quests.update(internal_old)

    corpus = {
        "schemaVersion": 1,
        "generatedFrom": {
            "file": str(wz.relative_to(root)),
            "locale": "en",
            "kind": "wz-v83",
            "date": "2026-09-06",
        },
        "quests": dict(sorted(quests.items(), key=lambda kv: sort_key(kv[0]))),
    }

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(
        json.dumps(corpus, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )

    # ---- 统计（写报告） ----
    wz_items = {qid: e for qid, e in quests.items() if "raw" in e}
    total = len(quests)
    total_raw_lines = sum(len(e["raw"]["en"]) for e in wz_items.values())
    total_cleaned_lines = sum(len(e["lines"]["en"]) for e in quests.values())
    words = sum(len(t.split()) for e in wz_items.values() for t in e["raw"]["en"])
    words_name = sum(len(e["name"]["en"].split()) for e in quests.values())
    no_lines = [qid for qid, e in quests.items() if not e.get("lines", {}).get("en")]
    area_cnt = Counter(
        e.get("meta", {}).get("area") for e in wz_items.values()
    )
    changed = sum(
        1
        for e in wz_items.values()
        for a, b in zip(e["raw"]["en"], e["lines"]["en"])
        if a != b
    )
    area20 = sorted(
        (qid for qid, e in wz_items.items() if e.get("meta", {}).get("area") == 20),
        key=int,
    )

    def sample(qid: str) -> str:
        e = quests[qid]
        rows = ["| 项 | 值 |", "|---|---|", f"| name | {e['name']['en']} |"]
        for i, (r, c) in enumerate(zip(e["raw"]["en"], e["lines"]["en"])):
            rows.append(f"| raw[{i}] | `{r}` |")
            if c != r:
                rows.append(f"| clean[{i}] | `{c}` |")
        return "\n".join(rows)

    report = f"""# M1 — v83 任务英文 scaffold 入库报告

> 产出：`shared/quest-text.json`（schemaVersion 1）；本报告供抽查。
> 生成：`scripts/quest_i18n/extract_questinfo.py`，2026-09-06。
> 数据源：`{corpus['generatedFrom']['file']}`（本地 v83 权威，未联网）。

## 1. 规模统计

| 指标 | 值 |
|---|---|
| 任务条目（有 name） | {total}（wz-v83={len(wz_items)}，内部={len(quests) - len(wz_items)}） |
| 编号描述行总数（raw） | {total_raw_lines} |
| 编号描述行总数（clean） | {total_cleaned_lines} |
| 描述文本词数（raw，不含 name） | {words} |
| name 词数 | {words_name} |
| 无编号行的任务数 | {len(no_lines)} |
| 含颜色标记被清洗的行数 | {changed} |

按 area 分布（前 8）：{'、'.join(f'area {k}:{v}' for k, v in sorted(area_cnt.items(), key=lambda x: str(x[0]))[:8])}

当前可玩范围 area=20 共 {len(area20)} 条：`{', '.join(area20)}`

## 2. 抽查样本

### 1021 Roger's Apple（当前已实现任务）

{sample('1021')}

### 1000 Borrowing Sera's Mirror（area 20 首条）

{sample('1000')}

### 10210（area 50 样本）

{sample('10210')}

## 3. 说明

- `lines.en` = raw 去掉颜色标记（#b/#r/#g/#d/#k）后的版本，保留 #p/#t/#c/#o/#s/#v 等内容标记与原文，供 M2 翻译与名词替换。
- `raw.en` = WZ 原文精确副本（实体解码后），可随时重新生成 clean，管线可回溯。
- zh 富化（name.zh/lines.zh/log/sources.zh）与内部条目会在重跑时被保留（apply_zh/gen_quest_log_map 产出）。
"""
    Path(args.report).parent.mkdir(parents=True, exist_ok=True)
    Path(args.report).write_text(report, encoding="utf-8")

    print(f"OK  quests={total}  lines(raw)={total_raw_lines}  area20={len(area20)}")
    print(f"    corpus -> {args.out}")
    print(f"    report -> {args.report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
