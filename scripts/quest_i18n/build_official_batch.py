#!/usr/bin/env python3
"""把联网抓取的原版多语语料（dvg-raw.json）交叉校验后生成可合入批次。

主源字段（mxd.dvg.cn/questsinfo.php?id=N）:
  - names.国服 / 台服 / 国际 / 韩服：同一 questId 的四语官方任务名 → 跨版本对照天然成立
  - lines + line_stages：分阶段原版任务文本（含 #b/#p2000##k 等 WZ 标记）
  - npcs: {npcId: 中文名} → 术语表 #p 词条权威来源

交叉校验（本地 v83 为裁判，避免"版本串味"）:
  1. 英文名 vs 本地 QuestInfo name 归一化比对：一致=high，不一致=conflict
  2. 阶段行数 vs lines.en 行数：相等→按位置对齐；不等→按 stage 下标对齐；再不行→只导 name
  3. 清洗：去颜色标记(#b/#r/#g/#d/#k)、字面 \\n、[地区] 前缀
  4. 名词替换：#p/#o/#t 按术语表换成中文；无法替换的保留原标记（verify 子集规则允许）

产出:
  - shared/quest-zh-official.json      可 apply_zh 的批次（仅 high 置信）
  - evidence/2026-09-06/quest-i18n/official-zh-report.md   覆盖/冲突/差异报告
  - evidence/2026-09-06/quest-i18n/npc-zh-catalog.json     NPC 中文名目录（回填术语表用）

用法:
  python3 scripts/quest_i18n/build_official_batch.py
  python3 scripts/quest_i18n/build_official_batch.py --include-conflict
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COLOR = re.compile(r"#([brgdk])")
TOKEN = re.compile(r"#([pot])(\d+)#")
HANGUL = re.compile(r"[\uac00-\ud7af\u1100-\u11ff]")
# verify 用的内容标记集合（#p/#t/#c/#o/#m/#s/#v/#a/#i/#y/#u）
CONTENT_TOKEN = re.compile(r"#([ptocomsvaiyu])(\d+)#")


def tok_multiset(line: str) -> Counter:
    return Counter(CONTENT_TOKEN.findall(line))


def clean(t: str) -> str:
    t = t.replace("\\n", " ").replace("\\r", " ")
    t = COLOR.sub("", t)
    return re.sub(r"\s{2,}", " ", t).strip()


def strip_area_prefix(name: str) -> str:
    """'[冒险岛] 借来莎丽的镜子' -> '借来莎丽的镜子'"""
    return re.sub(r"^\[[^\]]*\]\s*", "", (name or "").strip())


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def load_glossary() -> dict[str, dict[str, str]]:
    g = json.loads((ROOT / "shared/quest-glossary.json").read_text(encoding="utf-8"))
    return {k: {i: v.get("zh", "") for i, v in v.items() if v.get("zh")} for k, v in g.get("terms", {}).items()}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", default=str(ROOT / "evidence/2026-09-06/quest-i18n/dvg-raw.json"))
    ap.add_argument("--corpus", default=str(ROOT / "shared/quest-text.json"))
    ap.add_argument("--out", default=str(ROOT / "shared/quest-zh-official.json"))
    ap.add_argument("--report", default=str(ROOT / "evidence/2026-09-06/quest-i18n/official-zh-report.md"))
    ap.add_argument("--npc-out", default=str(ROOT / "evidence/2026-09-06/quest-i18n/npc-zh-catalog.json"))
    ap.add_argument("--include-conflict", action="store_true", help="英文名不一致也入批次（默认只进报告）")
    ap.add_argument("--update-glossary", action="store_true", help="用抓取到的 NPC 中文名回填 shared/quest-glossary.json")
    args = ap.parse_args()

    raw_p = Path(args.raw)
    if not raw_p.exists():
        print(f"缺少抓取产物 {raw_p}，先跑 fetch_dvg.py", file=sys.stderr)
        return 2
    raw = json.loads(raw_p.read_text(encoding="utf-8"))
    corpus = json.loads(Path(args.corpus).read_text(encoding="utf-8"))
    cq = corpus["quests"]
    glos = load_glossary()

    # NPC 中文名目录（跨任务投票）
    npc_votes: dict[str, Counter] = {}
    for rec in raw["quests"].values():
        for nid, zh in rec.get("npcs", {}).items():
            if zh and not zh.startswith("#"):
                npc_votes.setdefault(nid, Counter())[zh] += 1
    npc_zh = {nid: c.most_common(1)[0][0] for nid, c in npc_votes.items()}

    def sub_tokens(zh: str, en_line: str) -> tuple[str, list[str]]:
        missing: list[str] = []

        def rep(m: re.Match) -> str:
            kind, idx = m.group(1), m.group(2)
            # WZ 里 #t02010007# 带前导零，术语表键是 2010007 → 去零后再查
            key = idx.lstrip("0") or idx
            if kind == "p":
                name = npc_zh.get(idx) or npc_zh.get(key) or glos.get("p", {}).get(key)
            else:
                name = glos.get(kind, {}).get(key) or glos.get(kind, {}).get(idx)
            if name:
                return name
            missing.append(m.group(0))
            return m.group(0)

        return TOKEN.sub(rep, zh), missing

    batch: dict[str, dict] = {}
    conflicts: list[dict] = []
    line_skips: list[str] = []
    name_bad: list[str] = []
    missing_tokens: Counter = Counter()
    n_name = n_lines = 0

    for qid, rec in sorted(raw["quests"].items(), key=lambda kv: int(kv[0])):
        entry = cq.get(qid)
        if entry is None:
            continue
        en_name_local = entry.get("name", {}).get("en", "")
        en_name_remote = rec.get("names", {}).get("国际", "")
        zh_name = strip_area_prefix(rec.get("names", {}).get("国服", ""))
        if not zh_name or HANGUL.search(zh_name):
            # 国服译名缺失/韩文残留（源站数据缺口），不拿繁体或韩文冒充简体
            name_bad.append(qid)
            continue
        match = bool(en_name_remote) and norm(en_name_remote) == norm(en_name_local)
        if not match and not args.include_conflict:
            conflicts.append(
                {
                    "id": qid,
                    "local_en": en_name_local,
                    "remote_en": en_name_remote,
                    "remote_zh": zh_name,
                    "remote_ko": rec.get("names", {}).get("韩服", ""),
                }
            )
            continue

        patch: dict = {"name": {"zh": zh_name}}
        en_lines = entry.get("lines", {}).get("en", [])
        rlines = [clean(t) for t in rec.get("lines", [])]
        zh_lines: list[str] | None = None
        if en_lines and rlines:
            if len(rlines) == len(en_lines):
                cand = rlines
            else:
                cand = None
                tmp = [""] * len(en_lines)
                ok = True
                for st, txt in zip(rec.get("line_stages", []), rlines):
                    if 0 <= st < len(en_lines):
                        tmp[st] = txt
                    else:
                        ok = False
                cand = tmp if ok else None
            if cand is not None and all(cand):
                out_lines = []
                clean_ok = True
                for z, e in zip(cand, en_lines):
                    z2, miss = sub_tokens(z, e)
                    missing_tokens.update(miss)
                    # zh 行不得携带 en 行没有的内容标记（官方行可能来自相邻版本，
                    # 掺入 #m/#a/#c 等会破坏"整句落地"，且过不了 verify 子集规则）→ 整条行放弃
                    if tok_multiset(z2) - tok_multiset(e):
                        clean_ok = False
                        break
                    out_lines.append(z2)
                if clean_ok:
                    zh_lines = out_lines
        if zh_lines is None and en_lines:
            line_skips.append(qid)
        elif zh_lines:
            patch["lines"] = {"zh": zh_lines}
            n_lines += 1
        n_name += 1
        batch[qid] = patch

    # 英文名不一致的条目：任务多半是同一个（版本差异导致计数/措辞不同），
    # 但无法自动确认 → 单独存候选文件，人工/AI 复核后再决定是否合入。
    candidates: dict[str, dict] = {}
    for c in conflicts:
        rec = raw["quests"][c["id"]]
        zh_lines = cq[c["id"]].get("lines", {}).get("en")
        patch: dict = {
            "name": {"zh": c["remote_zh"]},
            "source": {
                "kind": "official-cn",
                "match": "en-mismatch",
                "localEn": c["local_en"],
                "remoteEn": c["remote_en"],
                "reviewed": False,
                "note": "英文名与本地 v83 不一致（疑似版本差异），需复核后再合入",
            },
        }
        candidates[c["id"]] = patch
    cand_path = Path(args.out).with_name("quest-zh-official-candidates.json")
    cand_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "source": raw.get("source", {}),
                "note": "英文名与本地 v83 不一致的候选（版本差异），未合入；复核后改名再 apply。",
                "quests": dict(sorted(candidates.items(), key=lambda kv: int(kv[0]))),
            },
            ensure_ascii=False,
            indent=1,
        )
        + "\n",
        encoding="utf-8",
    )

    out = Path(args.out)
    payload = {
        "schemaVersion": 1,
        "source": raw.get("source", {}),
        "note": "官方中文(CMS/国服)译名与原版阶段文本；仅收录英文名与本地 v83 一致的条目。",
        "quests": dict(sorted(batch.items(), key=lambda kv: int(kv[0]))),
    }
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    npc_out = Path(args.npc_out)
    npc_out.parent.mkdir(parents=True, exist_ok=True)
    npc_out.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "source": "mxd.dvg.cn questsinfo 接取位置 /npcsinfo.php?id=N",
                "fetchedAt": raw.get("source", {}).get("fetchedAt", ""),
                "npcs": dict(sorted(npc_zh.items(), key=lambda kv: int(kv[0]))),
            },
            ensure_ascii=False,
            indent=1,
        )
        + "\n",
        encoding="utf-8",
    )

    # ---- 术语表回填：NPC 中文名（#p）权威化 ----
    n_glos = 0
    if args.update_glossary:
        gp = ROOT / "shared/quest-glossary.json"
        g = json.loads(gp.read_text(encoding="utf-8"))
        terms = g.setdefault("terms", {}).setdefault("p", {})
        for nid, zh in npc_zh.items():
            cur = terms.get(nid)
            if cur and cur.get("src") == "official-cn":
                continue
            if cur and cur.get("src") == "codebase" and cur.get("zh"):
                continue  # 代码库既有约定优先（如 2000 罗杰）
            if cur and cur.get("src") == "official-cn":
                continue
            terms[nid] = {
                "en": json.loads((ROOT / "evidence/2026-09-06/quest-i18n/name-catalog.json").read_text(encoding="utf-8"))
                .get("p", {})
                .get(nid, ""),
                "zh": zh,
                "src": "official-cn",
            }
            n_glos += 1
        g["notes"] = (
            g.get("notes", "")
            + " #p 词条已用 mxd.dvg.cn 官方中文名回填（src=official-cn），2026-09-06。"
        )
        gp.write_text(json.dumps(g, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    # 现网已上线文案 vs 官方译名差异（供人工决策，不自动覆盖）
    pinned = {
        qid: {"online": cq[qid]["name"].get("zh"), "official": strip_area_prefix(rec.get("names", {}).get("国服", ""))}
        for qid, rec in raw["quests"].items()
        if qid in cq
        and cq[qid].get("name", {}).get("zh")
        and strip_area_prefix(rec.get("names", {}).get("国服", ""))
        and cq[qid]["name"].get("zh") != strip_area_prefix(rec.get("names", {}).get("国服", ""))
    }

    total_corpus = len([q for q in cq if q.isdigit()])
    rep = [
        "# 官方中文语料导入报告（mxd.dvg.cn）",
        "",
        f"> 抓取源：`{raw.get('source', {}).get('urlTemplate', '')}`　抓取时间：{raw.get('source', {}).get('fetchedAt', '')}",
        f"> 生成：`scripts/quest_i18n/build_official_batch.py`",
        "",
        "## 1. 覆盖统计",
        "",
        "| 指标 | 值 |",
        "|---|---|",
        f"| 语料 v83 任务数 | {total_corpus} |",
        f"| 线上有数据（抓到） | {len(raw['quests'])} |",
        f"| 英文名一致（可入批次） | {len(batch)} |",
        f"| 其中含阶段行文本 | {n_lines} |",
        f"| 英文名不一致（冲突，仅报告） | {len(conflicts)} |",
        f"| 国服译名缺失/韩文残留（跳过） | {len(name_bad)} |",
        f"| 行文本无法对齐（只导名称） | {len(line_skips)} |",
        f"|  harvested NPC 中文名 | {len(npc_zh)} |",
        "",
        "## 2. 现网文案 vs 官方译名差异（不自动覆盖，需人工决策）",
        "",
        "| questId | 现网 zh | 官方 zh |",
        "|---|---|---|",
    ]
    for qid, d in sorted(pinned.items(), key=lambda kv: int(kv[0]))[:60]:
        rep.append(f"| {qid} | {d['online']} | {d['official']} |")
    if not pinned:
        rep.append("| — | — | — |")
    rep += ["", "## 3. 英文名冲突样例（前 40）", "", "| questId | 本地 v83 en | 线上 en | 线上 zh |", "|---|---|---|---|"]
    for c in conflicts[:40]:
        rep.append(f"| {c['id']} | {c['local_en']} | {c['remote_en']} | {c['remote_zh']} |")
    if not conflicts:
        rep.append("| — | — | — | — |")
    rep += ["", "## 4. 未替换的内容标记（术语表缺词 Top 30）", ""]
    if missing_tokens:
        rep += ["| 标记 | 出现次数 |", "|---|---|"]
        rep += [f"| `{k}` | {v} |" for k, v in missing_tokens.most_common(30)]
    else:
        rep.append("无。")
    Path(args.report).write_text("\n".join(rep) + "\n", encoding="utf-8")

    print(
        f"OK  批次 {len(batch)} 条（含行文本 {n_lines}）　候选 {len(candidates)}　"
        f"韩文残留跳过 {len(name_bad)}　行跳过 {len(line_skips)}　NPC 中文名 {len(npc_zh)}"
        + (f"　术语表回填 {n_glos}" if args.update_glossary else "")
    )
    print(f"    batch -> {out}")
    print(f"    report-> {args.report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
