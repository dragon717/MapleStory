#!/usr/bin/env python3
"""从本地 String.wz 解析语料中出现的内容标记(#p/#t/#o)对应的英文名目录。

产物:
  - evidence/2026-09-06/quest-i18n/name-catalog.json
    { "p": {"<npcId>": "<name>", ...}, "o": {...}, "t": { "<intId>": {"cat":"Consume","name":...} } }
  - evidence/2026-09-06/quest-i18n/token-name-report.md （area=20 用到的 id → 名称，供翻译/校对）

说明:
  - 源文件: String.wz/{Npc,Mob,Consume,Etc,Cash,Ins,Pet,Eqp}.img.xml
  - 映射键做去前导零归一化（token 的 #t02010007# 与文件键 2010007 视作同一 id）。
  - #m(地图) 名在 Map.wz/各地图信息中，本工具暂不解析，报告里标为待办。
用法:
  python3 scripts/quest_i18n/resolve_names.py [--string-wz PATH] [--corpus PATH] ...
"""
from __future__ import annotations

import argparse
import html
import json
import re
from pathlib import Path

IMG = re.compile(r'<imgdir name="([^"]+)">')
NAME = re.compile(r'<string name="(?:name|mapName|streetName)" value="([^"]*)"\s*/>')


IMG_BLOCK = re.compile(r'<imgdir name="(\d+)">(.*?)</imgdir>', re.S)


def parse_numeric_names(path: Path) -> dict[int, dict[str, str]]:
    """收集 xml 中所有『数值 imgdir 叶块 → name』；可处理 Etc/Eqp 的多级嵌套。"""
    text = path.read_text(encoding="utf-8")
    results: dict[int, dict[str, str]] = {}
    for m in IMG_BLOCK.finditer(text):
        key = int(m.group(1))
        nm = NAME.search(m.group(2))
        if not nm:
            continue  # 无名称字段的数值节点（如纯 desc/内部结构），跳过
        name = html.unescape(nm.group(1))
        if key not in results:
            results[key] = {"name": name}
        elif results[key].get("name") == "NO-NAME" and name != "NO-NAME":
            results[key]["name"] = name
    return results


def main() -> int:
    ap = argparse.ArgumentParser()
    root = Path(__file__).resolve().parents[2]
    wz = root / "参考/repos/P0nk__Cosmic/wz/String.wz"
    ap.add_argument("--string-wz", default=str(wz))
    ap.add_argument("--out-json", default=str(root / "evidence/2026-09-06/quest-i18n/name-catalog.json"))
    ap.add_argument("--out-md", default=str(root / "evidence/2026-09-06/quest-i18n/token-name-report.md"))
    args = ap.parse_args()
    wz = Path(args.string_wz)

    npc = parse_numeric_names(wz / "Npc.img.xml")
    mob = parse_numeric_names(wz / "Mob.img.xml")
    items: dict[int, dict[str, str]] = {}
    for cat in ("Consume", "Etc", "Cash", "Ins", "Pet", "Eqp"):
        f = wz / f"{cat}.img.xml"
        if not f.exists():
            continue
        got = parse_numeric_names(f)
        for k, v in got.items():
            if k not in items:
                items[k] = {"cat": cat, "name": v.get("name", "")}
            elif items[k].get("name") == "NO-NAME" or not items[k].get("name"):
                items[k] = {"cat": cat, "name": v.get("name", "")}

    catalog = {
        "p": {str(k): v["name"] for k, v in sorted(npc.items())},
        "o": {str(k): v["name"] for k, v in sorted(mob.items())},
        "t": {
            str(k): {"cat": v["cat"], "name": v.get("name", "")}
            for k, v in sorted(items.items())
        },
    }
    Path(args.out_json).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out_json).write_text(
        json.dumps(catalog, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )

    # 语料 token 覆盖率统计 + area20 名称表
    corpus_path = root / "shared/quest-text.json"
    token = re.compile(r"#([ptom])(\d+)#")
    used = {"p": {}, "o": {}, "t": {}, "m": {}}
    area20_used = {"p": {}, "o": {}, "t": {}, "m": {}}
    if corpus_path.exists():
        corpus = json.loads(corpus_path.read_text(encoding="utf-8"))
        for qid, e in corpus["quests"].items():
            area = e.get("meta", {}).get("area")
            for ln in e.get("lines", {}).get("en", []):
                for m in token.finditer(ln):
                    k, i = m.group(1), m.group(2)
                    bucket = area20_used if area == 20 else None
                    if bucket is not None:
                        bucket[k].setdefault(i, 0)
                        bucket[k][i] += 1
                    used[k].setdefault(i, 0)
                    used[k][i] += 1

    rows = ["# 内容标记 → 英文名 解析报告", ""]
    rows += ["| 类型 | 语料内出现 id 数 | 本地可解析 |", "|---|---|---|"]
    for k in ("p", "o", "t", "m"):
        total = len(used.get(k, {}))
        resolved = sum(1 for i in used.get(k, {}) if str(int(i)) in catalog.get(k, {}) or i in catalog.get(k, {}))
        rows.append(f"| {k} | {total} | {resolved} |")
    rows += ["", "## area=20 用到的标记 id 与名称", ""]
    for k in ("p", "o", "t"):
        rows.append(f"### {k}")
        for i in sorted(area20_used.get(k, {}), key=lambda x: int(x)):
            ent = catalog.get(k, {}).get(str(int(i))) or catalog.get(k, {}).get(i)
            label = ""
            if k == "t":
                label = f"{ent['name']} [{ent['cat']}]" if ent else "（未解析）"
            else:
                label = ent if ent else "（未解析）"
            rows.append(f"- `{i}` ×{area20_used[k][i]} → {label}")
    Path(args.out_md).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out_md).write_text("\n".join(rows) + "\n", encoding="utf-8")
    print(f"OK  目录 -> {args.out_json}")
    print(f"    报告 -> {args.out_md}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
