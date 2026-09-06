#!/usr/bin/env python3
"""候选批次（英文名与 v83 不一致）的人工复核落地工具。

背景：`build_official_batch.py` 把英文名与本地 v83 不一致的第三方条目隔离到
`shared/quest-zh-official-candidates.json`（2026-09-06：665 条）。绝大多数是
"同一任务、版本差异"（如 quest 2024 v83=收集100个诅咒娃娃 / CMS=50个），
但必须人工确认后才允许合入，防 id 错配。

子命令:
  review            → 生成 evidence/quest-i18n/candidates-review.tsv
                      启发式标签: count-drift(数字漂移,疑似同一任务) / likely-same(高相似)
                      / needs-review(差异大)
  promote           → 把确认无误的候选条目并入正式批次 shared/quest-zh-official.json
                      （随后照常 apply_zh.py 合入语料）

用法:
  python3 scripts/quest_i18n/review_candidates.py review
  python3 scripts/quest_i18n/review_candidates.py promote --ids 2024,2025,2001
  python3 scripts/quest_i18n/review_candidates.py promote --tag count-drift
  # promote 后:
  python3 scripts/quest_i18n/apply_zh.py shared/quest-zh-official.json
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from difflib import SequenceMatcher
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]", " ", (s or "").lower())


def digit_set(s: str) -> set[str]:
    return set(re.findall(r"\d+", s or ""))


def classify(local_en: str, remote_en: str) -> tuple[str, float]:
    a, b = norm(local_en), norm(remote_en)
    sim = SequenceMatcher(None, a, b).ratio()
    la, lb = digit_set(local_en), digit_set(remote_en)
    # 名称主体一致、仅数量/数字不同 → 版本差异而非不同任务
    if la and lb and la != lb:
        body_a = re.sub(r"\d+", "", a)
        body_b = re.sub(r"\d+", "", b)
        if SequenceMatcher(None, body_a.strip(), body_b.strip()).ratio() >= 0.55:
            return "count-drift", sim
    if sim >= 0.6:
        return "likely-same", sim
    return "needs-review", sim


def main() -> int:
    ap = argparse.ArgumentParser()
    root = ROOT
    ap.add_argument("cmd", choices=["review", "promote"])
    ap.add_argument("--ids", default="", help="promote: 逗号分隔候选 id")
    ap.add_argument("--tag", default="", help="promote: 按标签批量提拔（count-drift/likely-same）")
    ap.add_argument("--candidates", default=str(root / "shared/quest-zh-official-candidates.json"))
    ap.add_argument("--official", default=str(root / "shared/quest-zh-official.json"))
    ap.add_argument("--corpus", default=str(root / "shared/quest-text.json"))
    ap.add_argument("--out", default=str(root / "evidence/quest-i18n/candidates-review.tsv"))
    args = ap.parse_args()

    cand = json.loads(Path(args.candidates).read_text(encoding="utf-8"))
    corpus = json.loads(Path(args.corpus).read_text(encoding="utf-8")).get("quests", {})
    cq = cand.get("quests", {})

    if args.cmd == "review":
        rows = []
        for qid, patch in sorted(cq.items(), key=lambda kv: int(kv[0])):
            src = patch.get("source", {})
            local_en = (corpus.get(qid) or {}).get("name", {}).get("en", "")
            remote_en = src.get("remoteEn", "")
            remote_zh = patch.get("name", {}).get("zh", "")
            tag, sim = classify(local_en, remote_en)
            rows.append((qid, tag, f"{sim:.2f}", local_en, remote_en, remote_zh))
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        with Path(args.out).open("w", encoding="utf-8") as f:
            f.write("questId\ttag\tsim\tlocal_v83_en\tremote_en\tremote_zh\n")
            for r in rows:
                f.write("\t".join(r) + "\n")
        from collections import Counter

        print(f"OK  {len(rows)} 条候选已分类 -> {args.out}")
        print("    ", dict(Counter(r[1] for r in rows)))
        return 0

    # promote
    selected: list[str] = []
    if args.ids:
        selected = [x.strip() for x in args.ids.split(",") if x.strip()]
    elif args.tag:
        for qid, patch in cq.items():
            src = patch.get("source", {})
            local_en = (corpus.get(qid) or {}).get("name", {}).get("en", "")
            tag, _ = classify(local_en, src.get("remoteEn", ""))
            if tag == args.tag:
                selected.append(qid)
    else:
        print("promote 需要 --ids 或 --tag", file=sys.stderr)
        return 2
    if not selected:
        print("没有选中的候选", file=sys.stderr)
        return 1

    official = json.loads(Path(args.official).read_text(encoding="utf-8"))
    moved = 0
    for qid in selected:
        if qid not in cq:
            print(f" 跳过（不在候选文件中）: {qid}", file=sys.stderr)
            continue
        if qid in official.get("quests", {}):
            print(f" 跳过（已在正式批次）: {qid}")
            continue
        official.setdefault("quests", {})[qid] = cq[qid]
        moved += 1
    Path(args.official).write_text(
        json.dumps(official, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )
    print(f"OK  已把 {moved} 条候选并入正式批次 -> {args.official}")
    print("    下一步: python3 scripts/quest_i18n/apply_zh.py shared/quest-zh-official.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
