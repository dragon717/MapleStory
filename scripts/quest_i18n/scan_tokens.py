#!/usr/bin/env python3
"""扫描 quest-text.json 中的内容标记（#p#NPC/#t#道具/#o#怪物/#m#地图/#c#数量…），
产出统计与"按 area 需要的标记 id 清单"，供术语表(glossary)与后续翻译批次使用。

用法:
  python3 scripts/quest_i18n/scan_tokens.py [--corpus PATH] [--out-json PATH] [--out-md PATH]
"""
from __future__ import annotations

import argparse
import collections
import json
import re
from pathlib import Path

TOKEN = re.compile(r"#([ptocomsv])(\d+)#")
TYPE_NAME = {
    "p": "NPC",
    "t": "道具",
    "o": "怪物",
    "m": "地图",
    "c": "数量/条件",
    "s": "技能",
    "v": "变量",
}


def main() -> int:
    ap = argparse.ArgumentParser()
    root = Path(__file__).resolve().parents[2]
    ap.add_argument("--corpus", default=str(root / "shared/quest-text.json"))
    ap.add_argument("--out-json", default=str(root / "evidence/quest-i18n/token-report.json"))
    ap.add_argument("--out-md", default=str(root / "evidence/quest-i18n/token-report.md"))
    args = ap.parse_args()

    corpus = json.loads(Path(args.corpus).read_text(encoding="utf-8"))
    by_type: dict[str, dict[str, int]] = collections.defaultdict(lambda: collections.defaultdict(int))
    by_type_quest: dict[str, dict[str, set]] = collections.defaultdict(lambda: collections.defaultdict(set))
    per_area: dict[int, dict[str, dict[str, int]]] = collections.defaultdict(
        lambda: collections.defaultdict(collections.Counter)
    )

    for qid, e in corpus["quests"].items():
        area = e.get("meta", {}).get("area")
        for ln in e.get("lines", {}).get("en", []):
            for m in TOKEN.finditer(ln):
                kind, tid = m.group(1), m.group(2)
                key = f"{kind}:{tid}"
                by_type[kind][tid] += 1
                by_type_quest[kind][tid].add(qid)
                if area is not None:
                    per_area[area][kind][tid] += 1

    json_out = {
        "totals": {
            k: {"count": sum(v.values()), "distinct": len(v), "label": TYPE_NAME.get(k, k)}
            for k, v in by_type.items()
        },
        "distinct_ids": {k: sorted(v) for k, v in by_type.items()},
        "per_area": {
            str(a): {
                k: dict(sorted(v.items(), key=lambda kv: -kv[1]))
                for k, v in kinds.items()
            }
            for a, kinds in sorted(per_area.items(), key=lambda kv: int(kv[0]))
        },
    }
    Path(args.out_json).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out_json).write_text(json.dumps(json_out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    lines = [
        "# 任务语料内容标记扫描报告",
        "",
        f"> 语料：`{corpus['generatedFrom']['file']}`；本报告供术语表与后续翻译批次使用。",
        "",
        "## 总量",
        "",
        "| 类型 | 出现次数 | 不同 id |",
        "|---|---|---|",
    ]
    for k in sorted(json_out["totals"], key=lambda x: -json_out["totals"][x]["count"]):
        t = json_out["totals"][k]
        lines.append(f"| {t['label']}(#{k}) | {t['count']} | {t['distinct']} |")
    lines += ["", "## area=20（当前可玩区）需要的标记 id", ""]
    a20 = json_out["per_area"].get("20", {})
    for k in sorted(a20, key=lambda x: -sum(a20[x].values())):
        items = a20[k]
        sample = "、".join(f"`{kid}`×{n}" for kid, n in list(items.items())[:20])
        lines.append(f"- #{k}（{TYPE_NAME.get(k, k)}，{len(items)} 个不同 id）：{sample}")
    Path(args.out_md).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"OK  输出 -> {args.out_json} / {args.out_md}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
