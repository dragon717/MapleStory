#!/usr/bin/env python3
"""把翻译批次(shared/quest-zh-*.json)合并进 shared/quest-text.json。

批次文件格式:
  { "schemaVersion": 1,
    "source": {...},                                  # 可选，顶层来源留痕（联网批次用）
    "quests": { "<questId>": {
        "name": {"zh": "..."},                        # 可选
        "lines": {"zh": ["..", ..]},                  # 可选，长度须与 en 一致
        "log": {"zh": "...", "en": "..."},            # 可选，日志卡片摘要，zh+en 成对
        "source": {"kind": "official-cn", ...}        # 可选，条目级来源留痕
  } } }

优先级（避免"已上线文案被机器覆盖"）:
  - corpus 中 sources.zh.pinned == true 的条目（已发布到 3010、e2e 断言依赖的
    1021 / maple-road-training）默认跳过，除非显式 --force；
  - 其余条目：批次覆盖 name.zh / lines.zh，并写入 sources.zh；
  - 批次未给 lines 时不清除既有 zh（只补不删）。

幂等：重复执行只覆盖对应语言字段；不改 en/raw/meta/sources.en。
用法:
  python3 scripts/quest_i18n/apply_zh.py shared/quest-zh-official.json
  python3 scripts/quest_i18n/apply_zh.py shared/quest-zh-a.json --dry-run
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

DEFAULT_SOURCE = {"kind": "ai", "reviewed": False, "note": "M2 草稿，待术语表/人工校对"}


def main() -> int:
    ap = argparse.ArgumentParser()
    root = Path(__file__).resolve().parents[2]
    ap.add_argument("batch", nargs="*", help="一个或多个 shared/quest-zh-*.json")
    ap.add_argument("--corpus", default=str(root / "shared/quest-text.json"))
    ap.add_argument("--force", action="store_true", help="连 pinned 条目一起覆盖")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument(
        "--pin",
        default="",
        help="逗号分隔的 questId：把其 sources.zh 标为 pinned（已上线文案，后续批次默认不覆盖）",
    )
    args = ap.parse_args()

    corpus = json.loads(Path(args.corpus).read_text(encoding="utf-8"))

    if args.pin:
        for qid in [x.strip() for x in args.pin.split(",") if x.strip()]:
            e = corpus["quests"].get(qid)
            if e is None:
                print(f"pin 失败：语料中无 {qid}", file=sys.stderr)
                return 1
            e.setdefault("sources", {}).setdefault("zh", {}).update(
                {"pinned": True, "note": "已发布到 3010 / e2e 断言依赖，改动需人工确认"}
            )
        if not args.batch:
            Path(args.corpus).write_text(
                json.dumps(corpus, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
            )
            print(f"OK  已锁定 {args.pin} -> {args.corpus}")
            return 0
    errors: list[str] = []
    touched = 0
    skipped_pinned: list[str] = []

    for bpath in args.batch:
        batch = json.loads(Path(bpath).read_text(encoding="utf-8"))
        top_source = batch.get("source", {})
        for qid, patch in batch.get("quests", {}).items():
            entry = corpus["quests"].get(qid)
            if entry is None:
                # 内部任务（无 v83 QuestInfo 条目，如 maple-road-training）
                en_name = patch.get("name", {}).get("en")
                if not en_name:
                    errors.append(f"{qid}: 语料中不存在且未提供 name.en，无法新建内部条目")
                    continue
                entry = {
                    "name": {"en": en_name},
                    "lines": {"en": []},
                    "meta": {},
                    "sources": {
                        "en": {
                            "kind": "internal",
                            "note": "非 v83 QuestInfo 的机制验证任务，纳入统一语料",
                        }
                    },
                }
                corpus["quests"][qid] = entry

            src_zh = entry.get("sources", {}).get("zh", {})
            if src_zh.get("pinned") and not args.force:
                skipped_pinned.append(qid)
                continue

            n_en = len(entry.get("lines", {}).get("en", []))
            if "lines" in patch:
                zh = patch["lines"].get("zh", [])
                if len(zh) != n_en:
                    errors.append(f"{qid}: lines.zh({len(zh)}) 与 lines.en({n_en}) 行数不一致")
                    continue
                entry.setdefault("lines", {})["zh"] = zh
            if "name" in patch and patch["name"].get("zh"):
                entry.setdefault("name", {})["zh"] = patch["name"]["zh"]
            if "log" in patch:
                lg = patch["log"]
                if not lg.get("zh") or not lg.get("en"):
                    errors.append(f"{qid}: log 必须同时含 zh/en")
                    continue
                entry["log"] = {"zh": lg["zh"], "en": lg["en"]}

            if patch.get("source"):
                src = dict(patch["source"])
            elif top_source:
                src = {
                    "kind": "official-cn",
                    "site": top_source.get("site", ""),
                    "url": top_source.get("urlTemplate", "").replace("{id}", qid),
                    "fetchedAt": top_source.get("fetchedAt", ""),
                    "reviewed": False,
                    "note": "第三方官方语料（国服译名/原版阶段文本），待抽审",
                }
            else:
                src = dict(DEFAULT_SOURCE)
            src.setdefault("reviewed", False)
            entry.setdefault("sources", {})["zh"] = src
            touched += 1

    if errors:
        print("FAIL")
        for e in errors:
            print(" -", e)
        return 1

    if not args.dry_run:
        Path(args.corpus).write_text(
            json.dumps(corpus, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
        )
    tail = ""
    if skipped_pinned:
        tail += f"（跳过 pinned {len(skipped_pinned)} 条: {','.join(skipped_pinned[:8])}）"
    if args.dry_run:
        tail += "  [dry-run 未落盘]"
    print(f"OK  已合并 {touched} 条 -> {args.corpus}{tail}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
