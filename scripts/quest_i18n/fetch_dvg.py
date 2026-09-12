#!/usr/bin/env python3
"""联网抓取原版任务多语语料（主源：冒险岛小册子 mxd.dvg.cn）。

为什么是这个源（2026-09-06 实测，用户已放宽"不限版本/不限途径"）：
  - 详情页 `questsinfo.php?id=<questId>` **用同一个 questId** 并列给出四语官方名：
      国服(简体) / 台服(繁体) / 国际(en) / 韩服(ko)
    → 天然跨版本对照，无需自建 id 映射表。
  - 详情页「相关对话」按阶段给出**原版任务文本**（含 #b/#p2000##k 等 WZ 标记），
    与本地 v83 `Quest.wz/QuestInfo.img/<id>` 的编号行 0/1/2… 同构，可 1:1 对齐。
  - 「接取位置」给出 `/npcsinfo.php?id=<npcId>` 与 NPC 中文名 → 术语表 #p 词条来源。

纪律（沿用项目 source 留痕约定）：
  - 只抓"任务文本/名词"这类结构化字段，不搬运整站、不落图片/HTML 站点资源；
  - 每条落 `source` = {kind, url, fetchedAt}，供后续 reviewed 翻转与回溯；
  - 本地 HTML 原始页进 `evidence/2026-09-06/quest-i18n/cache/dvg/`，可离线复算（断点续传）。

用法:
  # 样本（默认抓 area=20 的 61 条 + 已上线内部任务）
  python3 scripts/quest_i18n/fetch_dvg.py --sample
  # 指定 id
  python3 scripts/quest_i18n/fetch_dvg.py --ids 1000,1021,2024
  # 全量（语料里全部数字型 v83 id）
  python3 scripts/quest_i18n/fetch_dvg.py --all --workers 6
  # 复用缓存重算（不联网）
  python3 scripts/quest_i18n/fetch_dvg.py --all --offline
"""
from __future__ import annotations

import argparse
import html
import json
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BASE = "https://mxd.dvg.cn/questsinfo.php?id={}"
ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "evidence/2026-09-06/quest-i18n/cache/dvg"
DEFAULT_OUT = ROOT / "evidence/2026-09-06/quest-i18n/dvg-raw.json"

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

RE_LANG_ROW = re.compile(r'class="td-hui">(国服|台服|国际|韩服)</td>\s*<td>(.*?)</td>', re.S)
RE_DIALOG = re.compile(
    r'<div class="xcz-dialog-lv">\s*(\d+)\s*</div>\s*<div class="xcz-dialog-bubble">(.*?)</div>',
    re.S,
)
RE_KV = re.compile(r'<div class="xcz-k">([^<]+)</div>\s*<div class="xcz-v">(.*?)</div>', re.S)
RE_NPC_LINK = re.compile(r'href="/npcsinfo\.php\?id=(\d+)"[^>]*>\s*([^<]*?)\s*</a>', re.S)
RE_TITLE = re.compile(r"<title>(.*?)</title>", re.S)


def strip_tags(s: str) -> str:
    return re.sub(r"<[^>]+>", "", s).strip()


def clean_text(s: str) -> str:
    return html.unescape(strip_tags(s)).replace("\u00a0", " ").strip()


def fetch(qid: str, delay: float, timeout: float, offline: bool) -> tuple[str, str | None, str]:
    """返回 (qid, html_or_None, status)。status: ok | cached | missing | error:<msg>"""
    cf = CACHE / f"{qid}.html"
    if cf.exists():
        return qid, cf.read_text(encoding="utf-8", errors="replace"), "cached"
    if offline:
        return qid, None, "missing"
    url = BASE.format(qid)
    req = urllib.request.Request(
        url, headers={"User-Agent": UA, "Accept-Encoding": "identity", "Accept-Language": "zh-CN"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            CACHE.mkdir(parents=True, exist_ok=True)
            cf.write_text("", encoding="utf-8")
            return qid, None, "missing"
        return qid, None, f"error:http{e.code}"
    except Exception as e:  # noqa: BLE001
        return qid, None, f"error:{type(e).__name__}"
    finally:
        if delay:
            time.sleep(delay)
    CACHE.mkdir(parents=True, exist_ok=True)
    cf.write_text(body, encoding="utf-8")
    return qid, body, "ok"


def parse(qid: str, body: str) -> dict:
    names = {k: clean_text(v) for k, v in RE_LANG_ROW.findall(body)}
    dialog = [(int(lv), clean_text(txt)) for lv, txt in RE_DIALOG.findall(body)]
    dialog.sort(key=lambda x: x[0])
    kv = {clean_text(k): clean_text(v) for k, v in RE_KV.findall(body)}
    npcs = {nid: clean_text(nm) for nid, nm in RE_NPC_LINK.findall(body) if clean_text(nm)}
    title = clean_text(RE_TITLE.search(body).group(1)) if RE_TITLE.search(body) else ""
    return {
        "id": qid,
        "names": names,  # 国服/台服/国际/韩服
        "lines": [t for _, t in dialog],
        "line_stages": [lv for lv, _ in dialog],
        "info": {k: kv.get(k) for k in ("任务分类", "接取等级", "接取位置", "相关怪物", "其他说明") if kv.get(k)},
        "npcs": npcs,
        "title": title,
        "url": BASE.format(qid),
        "fetchedAt": time.strftime("%Y-%m-%d"),
    }


def collect_ids(mode: str, ids_arg: str, corpus_path: Path) -> list[str]:
    if ids_arg:
        return [x.strip() for x in ids_arg.split(",") if x.strip()]
    corpus = json.loads(corpus_path.read_text(encoding="utf-8"))
    all_ids = [q for q in corpus.get("quests", {}) if q.isdigit()]
    if mode == "sample":
        area20 = [q for q in all_ids if corpus["quests"][q].get("meta", {}).get("area") == 20]
        return sorted(set(area20), key=int)
    return sorted(all_ids, key=int)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help="语料中全部 v83 数字 id")
    ap.add_argument("--sample", action="store_true", help="仅 area=20（彩虹岛可玩区）")
    ap.add_argument("--ids", default="", help="逗号分隔的 questId")
    ap.add_argument("--corpus", default=str(ROOT / "shared/quest-text.json"))
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--delay", type=float, default=0.15, help="每请求间延迟(秒)，礼貌抓取")
    ap.add_argument("--timeout", type=float, default=30.0)
    ap.add_argument("--offline", action="store_true", help="只用缓存重算，不联网")
    args = ap.parse_args()

    ids = collect_ids("all" if args.all else "sample", args.ids, Path(args.corpus))
    if not ids:
        print("没有待抓取的 id", file=sys.stderr)
        return 2
    print(f"待抓取 {len(ids)} 条 -> {args.out}")

    results: dict[str, dict] = {}
    stats: dict[str, int] = {}
    done = 0
    t0 = time.time()

    def work(qid: str):
        return fetch(qid, args.delay, args.timeout, args.offline)

    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        for qid, body, status in pool.map(work, ids):
            done += 1
            stats[status] = stats.get(status, 0) + 1
            if body is None:
                continue
            try:
                rec = parse(qid, body)
            except Exception as e:  # noqa: BLE001
                stats["parse_error"] = stats.get("parse_error", 0) + 1
                continue
            if rec["names"] or rec["lines"]:
                results[qid] = rec
            else:
                stats["empty"] = stats.get("empty", 0) + 1
            if done % 200 == 0:
                print(f"  ...{done}/{len(ids)}  ({time.time() - t0:.0f}s)")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schemaVersion": 1,
        "source": {
            "site": "mxd.dvg.cn 冒险岛小册子",
            "urlTemplate": BASE,
            "fetchedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
            "note": "只保留任务文本/名词结构化字段；原始 HTML 存 evidence/2026-09-06/quest-i18n/cache/dvg/",
        },
        "quests": dict(sorted(results.items(), key=lambda kv: int(kv[0]))),
    }
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    n_lines = sum(len(v["lines"]) for v in results.values())
    n_ko = sum(1 for v in results.values() if v["names"].get("韩服"))
    print(
        f"OK  抓取 {len(results)} 条有效 / {len(ids)} 请求；阶段行 {n_lines}；含韩服名 {n_ko}；"
        f"耗时 {time.time() - t0:.0f}s"
    )
    print(f"    状态分布: {stats}")
    print(f"    产出 -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
