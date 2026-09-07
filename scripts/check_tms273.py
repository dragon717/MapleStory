#!/usr/bin/env python3
"""Minimal offline checks for the files emitted by import_tms273.py."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from import_tms273 import decode, read_json


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "references" / "tms273-data"
DEFAULT_WZ_ROOT = (
    ROOT
    / "参考"
    / "273"
    / "TMS273少爷一键端"
    / "手工服务端"
    / "tms273"
    / "WZ_JSON_TW"
)


def find_typed(node: Any, kind: str) -> dict[str, Any] | None:
    if isinstance(node, dict):
        if node.get("_dirType") == kind:
            return node
        for child in node.values():
            found = find_typed(child, kind)
            if found is not None:
                return found
    elif isinstance(node, list):
        for child in node:
            found = find_typed(child, kind)
            if found is not None:
                return found
    return None


def assert_relative(value: Any, label: str) -> None:
    if not isinstance(value, str) or value.startswith("/") or ".." in Path(value).parts:
        raise AssertionError(f"{label} escaped the relative source namespace: {value!r}")


def check_paths(maps: dict[str, Any]) -> None:
    for record in maps["maps"]:
        assert_relative(record["source"], f"map {record['id']} source")
        assert_relative(record["sourceJson"], f"map {record['id']} sourceJson")
        for item in record["life"]:
            assert_relative(item["source"], f"map {record['id']} life")
        for item in record["backgrounds"]:
            assert_relative(item["source"], f"map {record['id']} background")
        for layer in record["layers"]:
            assert_relative(layer["source"], f"map {record['id']} layer")
            for item in layer["tiles"] + layer["objects"]:
                assert_relative(item["source"], f"map {record['id']} layer item")


def check_maps(maps: dict[str, Any]) -> None:
    assert maps["schemaVersion"] == 1
    assert maps["encoding"] == "UTF-8"
    assert maps["importedMapIds"] == [record["id"] for record in maps["maps"]]
    assert len(maps["maps"]) == 17, maps["importedMapIds"]
    assert maps["storyMapIds"] == ["002000100", "002010000", "104000000"]
    assert maps["importedMapIds"][-3:] == [
        "002000100",
        "002010000",
        "104000000",
    ]
    birth = next(record for record in maps["maps"] if record["id"] == "000010000")
    assert birth["bounds"] == {
        "xMin": -1310,
        "xMax": 960,
        "yMin": -892,
        "yMax": 915,
    }, birth["bounds"]
    for map_id, expected in {
        "000030001": {"xMin": -768, "xMax": 707, "yMin": -409, "yMax": 554},
        "001000002": {"xMin": -858, "xMax": 678, "yMin": -409, "yMax": 555},
    }.items():
        record = next(item for item in maps["maps"] if item["id"] == map_id)
        assert record["bounds"] == expected
        assert record["boundsSource"] == "miniMap.width/height/centerX/centerY"
    assert len(birth["spawns"]) == 3
    assert birth["spawn"] == {"x": -381, "y": 187}

    # The source's typed scalar wrapper must remain byte-for-byte addressable
    # in raw.  Decode is only a convenience view.
    typed_version = birth["raw"]["info"]["version"]
    assert typed_version == {"_dirType": "int", "_value": "10"}
    assert decode(typed_version) == 10

    hidden = [item for item in birth["life"] if item.get("hidden")]
    assert hidden and hidden[0]["raw"]["hide"] == {
        "_dirType": "int",
        "_value": "1",
    }
    assert hidden[0]["id"] not in {item["id"] for item in birth["visibleNpcLife"]}
    assert all(item.get("visible") for item in birth["visibleNpcLife"])

    # Portals are a direct transcription: no reverse edge is synthesized.
    assert len(birth["portals"]) == 4
    assert birth["portals"][-1]["raw"]["script"]["_value"] == ""
    entry_refs = {
        (item["kind"], item["name"]): item for item in birth["entryScriptRefs"]
    }
    assert entry_refs[("onFirstUserEnter", "enter_maple")]["available"] is False
    next_refs = next(
        item for item in maps["maps"] if item["id"] == "000020000"
    )["entryScriptRefs"]
    assert any(
        item["name"] == "enter_20000" and item["available"] is False
        for item in next_refs
    )
    dock = next(item for item in maps["maps"] if item["id"] == "002000100")
    assert any(
        item["name"] == "southperryPt2" and item["available"] is False
        for item in dock["portalScriptRefs"]
    )
    check_paths(maps)


def check_uol_source(wz_root: Path) -> None:
    long_fixture = {"_dirType": "long", "_value": str(2**63 - 1)}
    assert decode(long_fixture) == 2**63 - 1
    unknown_fixture = {"_dirType": "futureScalar", "_value": "opaque"}
    assert decode(unknown_fixture) == unknown_fixture
    try:
        decode({"_dirType": "float", "_value": "NaN"})
    except ValueError:
        pass
    else:
        raise AssertionError("non-finite typed float was accepted")

    # This is a targeted known UOL-bearing map, outside the selected shared
    # map intersection; it avoids scanning the graphics corpus.
    sample = wz_root / "Map/Map/Map9/993001200.json"
    if not sample.is_file():
        raise AssertionError(f"known UOL sample missing: {sample}")
    raw = read_json(sample)
    uol = find_typed(raw, "uol")
    assert uol and isinstance(uol.get("_value"), str)
    assert decode(uol) == {"_dirType": "uol", "_value": uol["_value"]}


def check_quests(output: Path) -> None:
    path = output / "quests.json"
    assert path.is_file(), "full import must emit quests.json"
    quests = json.loads(path.read_text(encoding="utf-8"))
    assert quests["encoding"] == "UTF-8"
    assert quests["coverage"]["family"] == "冒險家原版出生地劇情"
    assert quests["coverage"]["idPattern"] == "36300-36399"
    assert quests["coverage"]["count"] == 63
    by_id = {item["id"]: item for item in quests["quests"]}
    assert {"36301", "36302", "36303", "36304", "36306", "36307"} <= by_id.keys()
    for key in ("QuestInfo", "Check", "Act", "Say"):
        assert isinstance(by_id["36301"][key], dict)
        assert by_id["36301"][key] == by_id["36301"]["raw"][key]
    assert "楓之谷世界的冒險家" in by_id["36301"]["name"]
    refs = {
        (item["kind"], item["name"]): item
        for quest_id in ("36301", "36302", "36303", "36304", "36306", "36307")
        for item in by_id[quest_id]["scriptRefs"]
    }
    assert refs[("startscript", "q36301s")]["available"] is False
    assert refs[("endscript", "q36301e")]["available"] is False
    assert refs[("resignScript", "q36301x")]["available"] is False
    assert refs[("startscript", "q36306s")]["available"] is False


def check_manifest(output: Path) -> None:
    manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["encoding"] == "UTF-8"
    assert manifest["customStoryEvidence"]["executable"] is False
    assert manifest["customStoryEvidence"]["available"] is True
    assert "星語谷" in manifest["customStoryEvidence"]["rawUtf8"]
    assert any("可执行" in item for item in manifest["limitations"])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--wz-root", type=Path, default=DEFAULT_WZ_ROOT)
    parser.add_argument("--skip-quests", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    output = args.out.resolve()
    maps = json.loads((output / "maps.json").read_text(encoding="utf-8"))
    check_maps(maps)
    check_uol_source(args.wz_root.resolve())
    if not args.skip_quests:
        check_quests(output)
        check_manifest(output)
    print(
        f"tms273 check: ok ({len(maps['maps'])} maps, "
        f"{len(maps['missingMapIds'])} missing source maps)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
