#!/usr/bin/env python3
"""翻译批次"该做谁"的决策工具：只针对"已实现/即将实现"的任务，而不是全库盲翻。

设计动机：QuestInfo 的 area 字段并不等于地域（同一 area 混有新手/技能书/高级内容/
韩文残留），而本项目任务是否展示由 shared/gameplay.json 的 quests[] 与客户端日志驱动。
因此中文翻译应该 follow 功能上线顺序：每当有新任务进入 gameplay.json（或手工指定
questId 列表）但语料缺 zh 时，本工具列出待翻译清单与原文，避免翻译永不展示的内容。

用法:
  # 面向功能：看 gameplay.json quests[] 里还有谁缺 zh（默认）
  python3 scripts/quest_i18n/zh_todo.py
  # 手工指定一批 questId（例如刚实现的任务 1007,1008）
  python3 scripts/quest_i18n/zh_todo.py --ids 1007,1008
  # 全库盘点（仅统计，不用于翻译决策）
  python3 scripts/quest_i18n/zh_todo.py --survey
  # 输出 markdown
  python3 scripts/quest_i18n/zh_todo.py --out evidence/quest-i18n/zh-todo.md
"""
from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path

TOKEN = re.compile(r"#([ptocomsvaiyu])(\d+)#")


def sort_key(qid: str):
    return (qid.isdigit() is False, int(qid) if qid.isdigit() else qid)


def main() -> int:
    ap = argparse.ArgumentParser()
    root = Path(__file__).resolve().parents[2]
    ap.add_argument("--corpus", default=str(root / "shared/quest-text.json"))
    ap.add_argument("--gameplay", default=str(root / "shared/gameplay.json"))
    ap.add_argument("--ids", default="", help="逗号分隔，手工指定一批 questId")
    ap.add_argument("--survey", action="store_true", help="全库盘点模式")
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    corpus = json.loads(Path(args.corpus).read_text(encoding="utf-8"))["quests"]

    if args.survey:
        stats: dict[int, dict[str, int]] = {}
        for qid, e in corpus.items():
            area = e.get("meta", {}).get("area", -1)
            s = stats.setdefault(area, {"n": 0, "zh_name": 0, "zh_lines": 0, "words": 0, "toks": 0})
            s["n"] += 1
            if e.get("name", {}).get("zh"):
                s["zh_name"] += 1
            if e.get("lines", {}).get("zh"):
                s["zh_lines"] += 1
            s["words"] += sum(len(t.split()) for t in e.get("lines", {}).get("en", []))
            s["toks"] += sum(len(TOKEN.findall(t)) for t in e.get("lines", {}).get("en", []))
        rows = ["| area | 任务数 | name.zh | lines.zh | 行词数 | 行标记数 |", "|---|---|---|---|---|---|"]
        for a in sorted(stats, key=lambda x: (x < 0, x)):
            s = stats[a]
            rows.append(f"| {a} | {s['n']} | {s['zh_name']} | {s['zh_lines']} | {s['words']} | {s['toks']} |")
        text = "# 全库 zh 覆盖盘点（仅参考；翻译决策应走 gameplay 模式）\n\n" + "\n".join(rows)
    else:
        if args.ids:
            wanted = [x.strip() for x in args.ids.split(",") if x.strip()]
        else:
            gp = json.loads(Path(args.gameplay).read_text(encoding="utf-8"))
            wanted = [q.get("questId") for q in gp.get("quests", []) if q.get("questId")]
        todo: list[tuple[str, dict]] = []
        done = 0
        not_in_corpus: list[str] = []
        for qid in wanted:
            if qid not in corpus:
                not_in_corpus.append(qid)
                continue
            e = corpus[qid]
            has_log = bool(e.get("log"))
            has_lines_zh = bool(e.get("lines", {}).get("zh"))
            has_name_zh = bool(e.get("name", {}).get("zh"))
            full = has_log and has_name_zh and (has_lines_zh or not e.get("lines", {}).get("en"))
            if full:
                done += 1
            else:
                todo.append((qid, e))
        lines = [
            "# 翻译批次决策（zh_todo）",
            "",
            f"> 依据：{args.gameplay if not args.ids else '手工 ids'}。",
            f"> 目标任务 {len(wanted)} 条；已完成 zh {done} 条；待翻译 {len(todo)} 条。",
            "",
        ]
        if not_in_corpus:
            lines.append(f"> ⚠️ 以下任务不在 quest-text 语料中（新/内部任务需先建档）：{', '.join(not_in_corpus)}")
            lines.append("")
        if not todo:
            lines += ["**当前已实现任务全部有中文，无需翻译批次。** 等新任务进入 gameplay.json 后再跑本工具即可。"]
        for qid, e in todo:
            nm_en = e.get("name", {}).get("en", "")
            nm_zh = e.get("name", {}).get("zh")
            ln = e.get("lines", {}).get("en", [])
            toks = Counter(TOKEN.findall(" ".join(ln)))
            lines += [
                f"### {qid} — {nm_en}" + (f"（zh 已有：{nm_zh}）" if nm_zh else ""),
                f"- 缺失：{('name.zh ' if not nm_zh else '')}{('lines.zh ' if ln and not e.get('lines',{}).get('zh') else '')}{('log ' if not e.get('log') else '')}",
                f"- lines.en：{len(ln)} 行 / {sum(len(x.split()) for x in ln)} 词",
            ]
            if toks:
                lines.append("- 涉及标记：" + "、".join(f"#{k}{i}#×{n}" for (k, i), n in sorted(toks.items(), key=lambda x: -x[1])[:8]))
            lines += ["```"] + ln + ["```", ""]
        text = "\n".join(lines)

    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"OK  报告 -> {args.out}")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
