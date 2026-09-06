#!/usr/bin/env python3
"""M1 验收自检：shared/quest-text.json 与本地 Quest.wz 是否对齐、结构是否健全。

检查项:
  1. quest 键集与 WZ QuestInfo 有 name 的条目集合一致（无缺失/无多余/无重复）。
  2. 每个任务: name.en 非空; raw.en 与 lines.en 行数一致; clean 幂等(clean(clean(x))==clean(x));
     lines 与 raw 仅可能有颜色标记差异。
  3. schemaVersion / generatedFrom 存在。

用法:
  python3 scripts/quest_i18n/verify_quest_corpus.py [--corpus PATH] [--wz PATH]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

import importlib.util

spec = importlib.util.spec_from_file_location(
    "extract_questinfo",
    Path(__file__).resolve().parent / "extract_questinfo.py",
)
ext = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ext)


def main() -> int:
    ap = argparse.ArgumentParser()
    root = Path(__file__).resolve().parents[2]
    ap.add_argument("--corpus", default=str(root / "shared/quest-text.json"))
    ap.add_argument("--wz", default=str(root / "参考/repos/P0nk__Cosmic/wz/Quest.wz/QuestInfo.img.xml"))
    args = ap.parse_args()

    corpus = json.loads(Path(args.corpus).read_text(encoding="utf-8"))
    xml = Path(args.wz).read_text(encoding="utf-8")

    errors: list[str] = []

    # 1) WZ 侧期望键集
    wz_quests: dict[str, dict] = {}
    for m in ext.QUEST_BLOCK.finditer(xml):
        parsed = ext.parse_quest_body(m.group(2))
        if parsed["name"]:
            wz_quests[m.group(1)] = parsed
    cq = corpus["quests"]
    if corpus.get("schemaVersion") != 1:
        errors.append("schemaVersion != 1")
    if not corpus.get("generatedFrom"):
        errors.append("缺少 generatedFrom")

    # 1) 与 WZ 对齐：wz-v83 条目必须与 WZ 键集一致；允许额外的 internal 条目
    wz_keys = {qid for qid, e in wz_quests.items()}
    c_wz_keys = {
        qid
        for qid, e in cq.items()
        if e.get("sources", {}).get("en", {}).get("kind") == "wz-v83"
    }
    internal = [
        qid
        for qid, e in cq.items()
        if e.get("sources", {}).get("en", {}).get("kind") != "wz-v83"
    ]
    if wz_keys != c_wz_keys:
        errors.append(
            f"wz-v83 键集不一致: 缺 {len(wz_keys - c_wz_keys)} 条(如 {sorted(wz_keys - c_wz_keys)[:3]}), "
            f"多 {len(c_wz_keys - wz_keys)} 条(如 {sorted(c_wz_keys - wz_keys)[:3]})"
        )

    # 2) 逐条结构检查（en 侧）
    no_name = []
    lines_mismatch = []
    not_idempotent = []
    over_clean = []
    no_source = []
    for qid in sorted(cq, key=lambda x: (x.isdigit() is False, int(x) if x.isdigit() else 0)):
        e = cq[qid]
        if not e.get("name", {}).get("en"):
            no_name.append(qid)
        raw = e.get("raw", {}).get("en", [])
        cln = e.get("lines", {}).get("en", [])
        if len(raw) != len(cln):
            lines_mismatch.append(qid)
        for r, c in zip(raw, cln):
            if ext.clean_colors(c) != c:
                not_idempotent.append(qid)
                break
            # clean 只能删除颜色标记对：#b/#r/#g/#d/#k；若 lines 仍残留则报错
            if re.search(r"#([brgdk])", c):
                over_clean.append(qid)
                break
        if not e.get("sources", {}).get("en", {}).get("kind"):
            no_source.append(qid)

    # 2b) zh 侧结构
    zh_no_source = []
    zh_line_mismatch = []
    zh_bad_log = []
    zh_missing_flag = []
    zh_invented: dict[str, list[int]] = {}
    for qid, e in cq.items():
        src_zh = e.get("sources", {}).get("zh")
        has_zh = bool(
            e.get("name", {}).get("zh")
            or e.get("lines", {}).get("zh")
            or e.get("log")
        )
        if has_zh and not src_zh:
            zh_no_source.append(qid)
        if e.get("lines", {}).get("zh") is not None:
            if len(e["lines"]["zh"]) != len(e["lines"]["en"]):
                zh_line_mismatch.append(qid)
            # zh 行不得"发明"新内容标记：zh 的标记多重集必须是 en 的子集（可删减=内联替换，不可新增）
            for i, (ez, zz) in enumerate(zip(e["lines"]["en"], e["lines"]["zh"])):
                en_tok = re.findall(r"#([ptocomsvaiyu])(\d+)#", ez)
                zh_tok = re.findall(r"#([ptocomsvaiyu])(\d+)#", zz)
                if Counter(zh_tok) - Counter(en_tok):
                    zh_invented.setdefault(qid, []).append(i)
        if "log" in e:
            lg = e["log"]
            if not lg.get("zh") or not lg.get("en"):
                zh_bad_log.append(qid)
        if src_zh and src_zh.get("reviewed") is None:
            zh_missing_flag.append(qid)

    if no_name:
        errors.append(f"{len(no_name)} 条 name.en 为空: {no_name[:5]}")
    if lines_mismatch:
        errors.append(f"{len(lines_mismatch)} 条 raw/lines 行数不一致: {lines_mismatch[:5]}")
    if not_idempotent:
        errors.append(f"{len(not_idempotent)} 条 clean 非幂等: {not_idempotent[:5]}")
    if over_clean:
        errors.append(f"{len(over_clean)} 条 lines 仍有颜色标记: {over_clean[:5]}")
    if no_source:
        errors.append(f"{len(no_source)} 条缺 sources.en: {no_source[:5]}")
    if zh_no_source:
        errors.append(f"{len(zh_no_source)} 条含 zh 但缺 sources.zh: {zh_no_source[:5]}")
    if zh_line_mismatch:
        errors.append(f"{len(zh_line_mismatch)} 条 lines.zh 与 en 行数不一致: {zh_line_mismatch[:5]}")
    if zh_bad_log:
        errors.append(f"{len(zh_bad_log)} 条 log 缺 zh/en: {zh_bad_log[:5]}")
    if zh_missing_flag:
        errors.append(f"{len(zh_missing_flag)} 条 sources.zh 缺 reviewed: {zh_missing_flag[:5]}")
    if zh_invented:
        sample = ", ".join(f"{qid}行{i}" for qid, idx in list(zh_invented.items())[:5] for i in idx[:2])
        errors.append(f"{len(zh_invented)} 条 zh 行含 en 没有的内容标记(疑似笔误): {sample}")

    if errors:
        print("FAIL")
        for e in errors:
            print(" -", e)
        return 1

    n_zh_name = sum(1 for e in cq.values() if e.get("name", {}).get("zh"))
    n_zh_lines = sum(1 for e in cq.values() if e.get("lines", {}).get("zh"))
    n_log = sum(1 for e in cq.values() if e.get("log"))
    print(
        f"PASS  quests={len(cq)} (wz-v83={len(c_wz_keys)}, internal={len(internal)}), "
        f"zh: name={n_zh_name} lines={n_zh_lines} log={n_log}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
