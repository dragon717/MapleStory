#!/usr/bin/env python3
"""把姊妹抽取里、权威参考树缺失的 WZ_JSON_TW 文件补进去。

语义严格是「只补洞」：目标已存在的文件一律不动（不覆盖、不删除）。
补入清单落盘到 /tmp，便于回退。
"""
import os
import shutil
import sys

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..",
                    "参考/273/TMS273少爷一键端")
DEP = os.path.join(BASE, "TMS273/WZ_JSON_TW")
TMP = os.path.join(BASE, ".TheUnarchiverTemp0/tms273/WZ_JSON_TW")
MANIFEST = "/tmp/wz_json_gap_fill_manifest.txt"


def main() -> int:
    if not os.path.isdir(TMP):
        print("姊妹抽取目录不存在:", TMP)
        return 2
    added, skipped, existing = 0, 0, 0
    lines = []
    for dirpath, _, filenames in os.walk(TMP):
        for name in filenames:
            src = os.path.join(dirpath, name)
            rel = os.path.relpath(src, TMP)
            dst = os.path.join(DEP, rel)
            if os.path.exists(dst):
                existing += 1
                continue
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
            # 复核：补入内容必须与来源逐字节一致
            with open(src, "rb") as a, open(dst, "rb") as b:
                if a.read() != b.read():
                    print("补入后校验失败，已中断:", rel)
                    return 3
            added += 1
            lines.append(rel)
    with open(MANIFEST, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"补入 {added} 个 / 原有 {existing} 个未动 (跳过 {skipped})")
    print("清单:", MANIFEST)
    return 0


if __name__ == "__main__":
    sys.exit(main())
