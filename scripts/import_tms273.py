#!/usr/bin/env python3
"""Build small, source-backed TMS273 metadata files from typed WZ JSON.

The importer deliberately keeps the JSON emitted by the WZ converter under
``raw``.  The decoded fields in the same records are conveniences for the
runtime and are never treated as an executable interpretation of WZ data.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
from pathlib import Path
from typing import Any, Iterable

from map_catalog import map_id as catalog_map_id


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_WZ_ROOT = (
    ROOT
    / "参考"
    / "273"
    / "TMS273少爷一键端"
    / "TMS273"
    / "WZ_JSON_TW"
)
DEFAULT_MAPS_JSON = ROOT / "shared" / "maps.json"
DEFAULT_OUTPUT = ROOT / "references" / "tms273-data"

_INT_TYPES = {"byte", "short", "int", "long", "ubyte", "ushort", "uint", "ulong"}
_FLOAT_TYPES = {"float", "double"}
_STRING_TYPES = {"string", "wstring", "stringPool"}

# The shared catalog is intentionally the base selection.  These are the
# source-backed maps needed to follow the original 273 adventurer opening:
# 22000 is on the South Perry dock, 002010000 is the ship/travel staging map
# (its source info has onUserEnter=goLith and returnMap=104000000), and 1541002
# is on Victoria Harbor.  002010000 has no direct portal target in the source;
# keeping its metadata does not synthesize one.
ADDITIONAL_STORY_MAP_IDS = (
    "002000100", "002010000", "104000000",
    "101010100", "101010000", "101000000", "101000003",
    "100010100", "100010000", "100000000", "100000201",
    "130000000", "310040200", "310050000",
)
# TMS273 portal-linked route from Lith Harbor to the Perion field Boss area.
# Selection adds source geometry only; it does not unlock blocked quest records.
ADDITIONAL_REGION_MAP_IDS = (
    "104010000", "104010100", "104010200", "104020000", "102010100",
    "102010000", "102000000", "102020000", "102020100", "102020200",
    "102020300", "102020400", "102020500",
)
STORY_QUEST_PREFIX = "363"
# Original Magician advancement is a real prerequisite of 36337, outside the prefix.
STORY_PREREQUISITE_QUEST_IDS = ("1402",)


def read_json(path: Path) -> Any:
    """Read one source file explicitly as UTF-8."""

    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def decode(value: Any) -> Any:
    """Decode common WZ scalar wrappers while retaining UOL markers.

    ``raw`` is always emitted beside decoded data.  UOL is intentionally left
    as a marker object because resolving it would change source semantics.
    """

    if isinstance(value, list):
        return [decode(item) for item in value]
    if not isinstance(value, dict):
        return value

    kind = value.get("_dirType")
    if kind in _INT_TYPES:
        try:
            return int(str(value.get("_value")))
        except (TypeError, ValueError):
            raise ValueError(f"invalid typed WZ integer: {value!r}") from None
    if kind in _FLOAT_TYPES:
        try:
            parsed = float(str(value.get("_value")))
        except (TypeError, ValueError):
            raise ValueError(f"invalid typed WZ float: {value!r}") from None
        if not math.isfinite(parsed):
            raise ValueError(f"non-finite typed WZ float: {value!r}")
        return parsed
    if kind in _STRING_TYPES:
        return str(value.get("_value", ""))
    if kind == "bool":
        raw = value.get("_value")
        if isinstance(raw, bool):
            return raw
        return str(raw).lower() in {"1", "true", "yes"}
    if kind == "uol":
        return {"_dirType": "uol", "_value": value.get("_value", "")}
    if kind == "null":
        return None

    if kind in (None, "sub"):
        return {
            key: decode(child)
            for key, child in value.items()
            if key != "_dirType"
        }

    # Keep unknown wrappers and their marker rather than silently flattening
    # a future WZ type into an untyped dictionary.
    return {
        key: decode(child) if key != "_dirType" else child
        for key, child in value.items()
    }


def direct_children(node: Any) -> Iterable[tuple[str, dict[str, Any]]]:
    if not isinstance(node, dict):
        return ()
    return (
        (key, child)
        for key, child in node.items()
        if not key.startswith("_") and isinstance(child, dict)
    )


def raw_record(raw: dict[str, Any], **extra: Any) -> dict[str, Any]:
    result = dict(extra)
    decoded = decode(raw)
    if isinstance(decoded, dict):
        result.update(decoded)
    result["raw"] = raw
    return result


def source_json_path(map_id_value: str) -> str:
    return f"Map/Map/Map{map_id_value[0]}/{map_id_value}.json"


def source_img_path(map_id_value: str) -> str:
    return f"Map.wz/Map/Map{map_id_value[0]}/{map_id_value}.img"


def number(value: Any) -> int | float | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError(f"non-finite number: {value!r}")
        return int(value) if value.is_integer() else value
    text = str(value)
    try:
        if re.fullmatch(r"[+-]?\d+", text):
            return int(text)
        parsed = float(text)
    except (TypeError, ValueError):
        raise ValueError(f"invalid number: {value!r}") from None
    if not math.isfinite(parsed):
        raise ValueError(f"non-finite number: {value!r}")
    return int(parsed) if parsed.is_integer() else parsed


def source_map_names(wz_root: Path) -> dict[str, tuple[dict[str, Any], str]]:
    """Index numeric String/Map keys without walking any graphics JSON."""

    path = wz_root / "String" / "Map.json"
    if not path.is_file():
        return {}
    tree = read_json(path)
    result: dict[str, tuple[dict[str, Any], str]] = {}

    def visit(node: Any, path_parts: list[str]) -> None:
        if not isinstance(node, dict):
            if isinstance(node, list):
                for index, child in enumerate(node):
                    visit(child, path_parts + [str(index)])
            return
        for key, child in node.items():
            if key.startswith("_"):
                continue
            child_path = path_parts + [key]
            if key.isdigit() and isinstance(child, dict):
                # Keep the first exact key.  String.wz categories do not
                # intentionally duplicate a map ID, but preserving first
                # source order is safer than merging unlike records.
                result.setdefault(key.zfill(9), (child, "/".join(child_path)))
            visit(child, child_path)

    visit(tree, [])
    return result


def field(decoded: dict[str, Any], key: str, default: Any = None) -> Any:
    return decoded.get(key, default)


def map_names_for(
    map_id_value: str,
    names: dict[str, tuple[dict[str, Any], str]],
) -> tuple[str, str, str, dict[str, Any] | None]:
    raw_name, path = names.get(map_id_value, ({}, ""))
    decoded_name = decode(raw_name)
    if not isinstance(decoded_name, dict):
        decoded_name = {}
    name = str(decoded_name.get("mapName") or map_id_value)
    street_name = str(decoded_name.get("streetName") or "")
    source = f"String.wz/Map.img/{path}" if path else "String/Map.json"
    return name, street_name, source, raw_name or None


def flatten_footholds(root: Any) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []

    def visit(node: Any, path_parts: list[str]) -> None:
        if not isinstance(node, dict):
            return
        for key, child in node.items():
            if key.startswith("_") or not isinstance(child, dict):
                continue
            child_path = path_parts + [key]
            decoded = decode(child)
            if isinstance(decoded, dict) and all(
                required in decoded for required in ("x1", "y1", "x2", "y2")
            ):
                records.append(
                    raw_record(
                        child,
                        id=number(key),
                        path="/".join(child_path),
                    )
                )
            else:
                visit(child, child_path)

    visit(root, ["foothold"])
    return records


def flatten_ladders(root: Any) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []

    def visit(node: Any, path_parts: list[str]) -> None:
        if not isinstance(node, dict):
            return
        for key, child in node.items():
            if key.startswith("_") or not isinstance(child, dict):
                continue
            child_path = path_parts + [key]
            decoded = decode(child)
            if isinstance(decoded, dict) and all(
                required in decoded for required in ("x", "y1", "y2")
            ):
                records.append(
                    raw_record(
                        child,
                        id=number(key),
                        path="/".join(child_path),
                    )
                )
            else:
                visit(child, child_path)

    visit(root, ["ladderRope"])
    return records


def portal_record(key: str, raw: dict[str, Any]) -> dict[str, Any]:
    decoded = decode(raw)
    if not isinstance(decoded, dict):
        decoded = {}
    target = decoded.get("tm")
    target_map = None if target in (None, "", 999999999, "999999999") else catalog_map_id(target)
    portal: dict[str, Any] = {
        "name": str(decoded.get("pn") or ""),
        "type": number(decoded.get("pt", 0)),
        "x": number(decoded.get("x", 0)),
        "y": number(decoded.get("y", 0)),
        "targetMapId": target_map,
        "targetPortalName": decoded.get("tn") or None,
    }
    for name, value in decoded.items():
        if name in {"pn", "pt", "x", "y", "tm", "tn"}:
            continue
        # Keep source portal flags in the familiar shared-map shape.  Other
        # fields are copied as decoded values rather than discarded.
        if name == "onlyOnce" and str(value) in {"0", "1"}:
            portal[name] = str(value) == "1"
        else:
            portal[name] = value
    portal["id"] = number(key)
    portal["path"] = f"portal/{key}"
    portal["raw"] = raw
    return portal


def life_record(
    map_id_value: str, key: str, raw: dict[str, Any]
) -> dict[str, Any]:
    decoded = decode(raw)
    if not isinstance(decoded, dict):
        decoded = {}
    hidden = str(decoded.get("hide", 0)) in {"1", "true", "True"}
    record = raw_record(
        raw,
        id=number(key),
        path=f"life/{key}",
        source=f"{source_img_path(map_id_value)}/life/{key}",
    )
    record["hidden"] = hidden
    record["visible"] = not hidden
    return record


def background_record(key: str, raw: dict[str, Any]) -> dict[str, Any]:
    decoded = decode(raw)
    if not isinstance(decoded, dict):
        decoded = {}
    image = decoded.get("bS")
    image_no = decoded.get("no", key)
    source = (
        f"Map.wz/Back/{image}.img/back/{image_no}"
        if image not in (None, "")
        else f"Map.wz/Map/back/{key}"
    )
    return raw_record(
        raw,
        id=number(key),
        key=f"back-{key}",
        path=f"back/{key}",
        source=source,
    )


def asset_source(prefix: str, fields: dict[str, Any], fallback: str) -> str:
    if prefix == "Tile":
        image, unit, no = fields.get("tS"), fields.get("u"), fields.get("no")
        if image not in (None, "") and unit not in (None, "") and no is not None:
            return f"Map.wz/Tile/{image}.img/{unit}/{no}"
    if prefix == "Obj":
        image = fields.get("oS")
        path = [fields.get(name) for name in ("l0", "l1", "l2")]
        if image not in (None, "") and all(item not in (None, "") for item in path):
            return f"Map.wz/Obj/{image}.img/" + "/".join(str(item) for item in path)
    return fallback


def layer_record(map_id_value: str, key: str, raw: dict[str, Any]) -> dict[str, Any]:
    decoded = decode(raw)
    if not isinstance(decoded, dict):
        decoded = {}
    layer_source = f"{source_img_path(map_id_value)}/{key}"
    layer: dict[str, Any] = {
        "id": number(key),
        "key": f"layer-{key}",
        "path": key,
        "source": layer_source,
        "info": decode(raw.get("info", {})),
        "tiles": [],
        "objects": [],
        "raw": raw,
    }
    for tile_key, tile_raw in direct_children(raw.get("tile", {})):
        tile_decoded = decode(tile_raw)
        if not isinstance(tile_decoded, dict):
            tile_decoded = {}
        layer["tiles"].append(
            raw_record(
                tile_raw,
                id=number(tile_key),
                key=f"tile-{key}-{tile_key}",
                path=f"{key}/tile/{tile_key}",
                source=asset_source(
                    "Tile", tile_decoded, f"{layer_source}/tile/{tile_key}"
                ),
            )
        )
    for object_key, object_raw in direct_children(raw.get("obj", {})):
        object_decoded = decode(object_raw)
        if not isinstance(object_decoded, dict):
            object_decoded = {}
        layer["objects"].append(
            raw_record(
                object_raw,
                id=number(object_key),
                key=f"object-{key}-{object_key}",
                path=f"{key}/obj/{object_key}",
                source=asset_source(
                    "Obj", object_decoded, f"{layer_source}/obj/{object_key}"
                ),
            )
        )
    return layer


def build_map_record(
    map_id_value: str,
    raw: dict[str, Any],
    names: dict[str, tuple[dict[str, Any], str]],
    server_root: Path,
) -> dict[str, Any]:
    info_raw = raw.get("info", {})
    info = decode(info_raw)
    if not isinstance(info, dict):
        info = {}
    name, street_name, name_source, name_raw = map_names_for(map_id_value, names)

    portal_values = [
        portal_record(key, child)
        for key, child in direct_children(raw.get("portal", {}))
    ]
    portal_script_refs = []
    for portal in portal_values:
        script = portal.get("script")
        if not script:
            continue
        relative = f"script/portal/{script}.js"
        candidate = server_root / relative
        portal_script_refs.append(
            {
                "name": str(script),
                "kind": "portal",
                "source": relative if candidate.is_file() else None,
                "available": candidate.is_file(),
                "path": portal["path"],
            }
        )
    spawns = [
        {
            "id": f"sp-{index}",
            "x": item["x"],
            "y": item["y"],
            "portalName": item["name"],
            "portalId": item["id"],
            "path": item["path"],
        }
        for index, item in enumerate(portal_values)
        if item.get("name") == "sp"
    ]
    first_spawn = (
        {"x": spawns[0]["x"], "y": spawns[0]["y"]} if spawns else None
    )

    life = [
        life_record(map_id_value, key, child)
        for key, child in direct_children(raw.get("life", {}))
    ]
    visible_life = [item for item in life if item.get("visible")]
    visible_npcs = [
        item for item in visible_life if str(item.get("type", "")) == "n"
    ]
    visible_mobs = [
        item for item in visible_life if str(item.get("type", "")) == "m"
    ]
    backgrounds = [
        background_record(key, child)
        for key, child in direct_children(raw.get("back", {}))
    ]
    layers = [
        layer_record(map_id_value, key, child)
        for key, child in raw.items()
        if key.isdigit() and isinstance(child, dict)
    ]
    layers.sort(key=lambda item: (item["id"] is None, item["id"]))

    bounds = {
        "xMin": number(info.get("VRLeft")),
        "xMax": number(info.get("VRRight")),
        "yMin": number(info.get("VRTop")),
        "yMax": number(info.get("VRBottom")),
    }
    bounds_source = "info.VRLeft/VRRight/VRTop/VRBottom"
    if any(value is None for value in bounds.values()):
        mini_map = decode(raw.get("miniMap", {}))
        if isinstance(mini_map, dict) and all(
            mini_map.get(key) is not None
            for key in ("width", "height", "centerX", "centerY")
        ):
            width = number(mini_map["width"])
            height = number(mini_map["height"])
            center_x = number(mini_map["centerX"])
            center_y = number(mini_map["centerY"])
            bounds = {
                "xMin": -center_x,
                "xMax": width - center_x,
                "yMin": -center_y,
                "yMax": height - center_y,
            }
            bounds_source = "miniMap.width/height/centerX/centerY"
    entry_scripts = {
        key: info.get(source_key)
        for key, source_key in (
            ("onFirstUserEnter", "onFirstUserEnter"),
            ("onUserEnter", "onUserEnter"),
            ("fieldScript", "fieldScript"),
        )
        if source_key in info
    }
    entry_script_refs = []
    for kind, script in entry_scripts.items():
        if not script:
            continue
        relative = f"script/map/{kind}/{script}.js"
        candidate = server_root / relative
        entry_script_refs.append(
            {
                "name": str(script),
                "kind": kind,
                "source": relative if candidate.is_file() else None,
                "available": candidate.is_file(),
                "path": f"info/{kind}",
            }
        )
    record: dict[str, Any] = {
        "id": map_id_value,
        "name": name,
        "streetName": street_name,
        "nameSource": name_source,
        "source": source_img_path(map_id_value),
        "sourceJson": source_json_path(map_id_value),
        "assetStatus": "metadata",
        "bounds": bounds,
        "boundsSource": bounds_source,
        "spawn": first_spawn,
        "spawns": spawns,
        "footholds": flatten_footholds(raw.get("foothold", {})),
        "ladders": flatten_ladders(raw.get("ladderRope", {})),
        "portals": portal_values,
        "portalScriptRefs": portal_script_refs,
        "life": life,
        "visibleLife": visible_life,
        "visibleNpcLife": visible_npcs,
        "visibleMobLife": visible_mobs,
        "backgrounds": backgrounds,
        "layers": layers,
        "info": info,
        "entryScripts": entry_scripts,
        "entryScriptRefs": entry_script_refs,
        "bgm": info.get("bgm"),
        "returnMap": catalog_map_id(info.get("returnMap"))
        if info.get("returnMap") not in (None, "")
        else None,
        "raw": raw,
    }
    if name_raw is not None:
        record["nameRaw"] = name_raw
    return record


def requested_map_ids(maps_path: Path) -> list[str]:
    data = read_json(maps_path)
    records = data.get("maps", []) if isinstance(data, dict) else data
    return [str(item["id"]).zfill(9) for item in records if isinstance(item, dict) and item.get("id")]


def build_maps(
    wz_root: Path, maps_path: Path, server_root: Path | None = None
) -> dict[str, Any]:
    server_root = server_root or wz_root.parent
    catalog_ids = requested_map_ids(maps_path)
    requested = list(dict.fromkeys([*catalog_ids, *ADDITIONAL_STORY_MAP_IDS, *ADDITIONAL_REGION_MAP_IDS]))
    names = source_map_names(wz_root)
    imported: list[dict[str, Any]] = []
    missing: list[str] = []
    for map_id_value in requested:
        path = wz_root / source_json_path(map_id_value)
        if not path.is_file():
            missing.append(map_id_value)
            continue
        imported.append(
            build_map_record(map_id_value, read_json(path), names, server_root)
        )
    uol_count = 0
    scalar_count = 0

    def count_types(node: Any) -> None:
        nonlocal uol_count, scalar_count
        if isinstance(node, dict):
            kind = node.get("_dirType")
            if kind:
                scalar_count += 1
                if kind == "uol":
                    uol_count += 1
            for child in node.values():
                count_types(child)
        elif isinstance(node, list):
            for child in node:
                count_types(child)

    for item in imported:
        count_types(item["raw"])
    return {
        "schemaVersion": 1,
        "source": "Map.wz/Map/Map{first-id-digit}/*.img",
        "sourceJson": "Map/Map/Map{first-id-digit}/{id}.json",
        "sourceRoot": os.path.relpath(wz_root, ROOT),
        "encoding": "UTF-8",
        "gameVersion": 273,
        "region": "TW",
        "birthMapId": "000010000",
        "storyMapIds": list(ADDITIONAL_STORY_MAP_IDS),
        "regionMapIds": list(ADDITIONAL_REGION_MAP_IDS),
        "requestedMapIds": requested,
        "importedMapIds": [item["id"] for item in imported],
        "missingMapIds": missing,
        "typed": {
            "rawPreserved": True,
            "scalarCount": scalar_count,
            "uolCount": uol_count,
            "uolPolicy": "keep {_dirType:uol,_value} marker; do not resolve",
        },
        "maps": imported,
    }


def quest_id_from_file(path: Path) -> str | None:
    if path.stem not in STORY_PREREQUISITE_QUEST_IDS and not re.fullmatch(r"363\d{2}", path.stem):
        return None
    return path.stem


def flatten_strings(node: Any, path: str = "") -> dict[str, str]:
    values: dict[str, str] = {}
    if isinstance(node, dict):
        kind = node.get("_dirType")
        if kind in _STRING_TYPES:
            values[path or "/"] = str(node.get("_value", ""))
            return values
        for key, child in node.items():
            if key == "_dirType":
                continue
            child_path = f"{path}/{key}" if path else key
            values.update(flatten_strings(child, child_path))
    elif isinstance(node, list):
        for index, child in enumerate(node):
            values.update(flatten_strings(child, f"{path}/{index}"))
    return values


def quest_name(raw: dict[str, Any]) -> str:
    info = decode(raw.get("QuestInfo", {}))
    if isinstance(info, dict):
        for key in ("name", "questName", "title"):
            if info.get(key):
                return str(info[key])
        strings = info.get("strings")
        if isinstance(strings, dict):
            for value in strings.values():
                if value:
                    return str(value)
    return ""


def quest_script_refs(raw: dict[str, Any], server_root: Path) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    def visit(node: Any, path: str = "") -> None:
        if isinstance(node, dict):
            decoded = decode(node)
            if isinstance(decoded, dict):
                for key, value in decoded.items():
                    if key.lower() in {
                        "startscript",
                        "endscript",
                        "resignscript",
                        "script",
                    } and value:
                        script = str(value)
                        if (key, script) in seen:
                            continue
                        seen.add((key, script))
                        candidate = server_root / "script" / "quest" / f"{script}.js"
                        refs.append(
                            {
                                "name": script,
                                "kind": key,
                                "source": f"script/quest/{script}.js"
                                if candidate.is_file()
                                else None,
                                "available": candidate.is_file(),
                                "path": path,
                            }
                        )
            for key, child in node.items():
                if key != "_dirType":
                    visit(child, f"{path}/{key}" if path else key)
        elif isinstance(node, list):
            for index, child in enumerate(node):
                visit(child, f"{path}/{index}")

    visit(raw)
    return refs


def build_quests(wz_root: Path, server_root: Path) -> dict[str, Any]:
    quest_root = wz_root / "Quest" / "QuestData"
    records: list[dict[str, Any]] = []
    paths = set(quest_root.glob(f"{STORY_QUEST_PREFIX}*.json"))
    paths.update(quest_root / f"{quest_id}.json" for quest_id in STORY_PREREQUISITE_QUEST_IDS)
    for path in sorted(path for path in paths if path.is_file()):
        quest_id = quest_id_from_file(path)
        if quest_id is None:
            continue
        raw = read_json(path)
        info_decoded = decode(raw.get("QuestInfo", {}))
        area = info_decoded.get("area") if isinstance(info_decoded, dict) else None
        strings = flatten_strings(raw)
        quest_info_strings = flatten_strings(raw.get("QuestInfo", {}), "QuestInfo")
        say_strings = flatten_strings(raw.get("Say", {}), "Say")
        record = {
            "id": quest_id,
            "questId": number(quest_id),
            "source": f"Quest.wz/QuestData/{quest_id}.img",
            "sourceJson": f"Quest/QuestData/{quest_id}.json",
            "name": quest_name(raw),
            "display": {
                "name": quest_name(raw),
                "strings": strings,
                "questInfoStrings": quest_info_strings,
                "dialogueStrings": say_strings,
                "encoding": "UTF-8",
            },
            "area": number(area),
            "executable": False,
            "unsupportedMechanisms": [
                "raw WZ Check/Act/Say/QuestInfo retained; no quest VM or script execution"
            ],
            # Keep the four source sections directly addressable for consumers.
            "QuestInfo": raw.get("QuestInfo"),
            "Check": raw.get("Check"),
            "Act": raw.get("Act"),
            "Say": raw.get("Say"),
            "scriptRefs": quest_script_refs(raw, server_root),
            "raw": raw,
        }
        records.append(record)

    requested_ids = [*STORY_PREREQUISITE_QUEST_IDS, *[f"{STORY_QUEST_PREFIX}{index:02d}" for index in range(100)]]
    imported_ids = [record["id"] for record in records]

    return {
        "schemaVersion": 1,
        "source": "Quest.wz/QuestData/{id}.img",
        "sourceJson": "Quest/QuestData/{id}.json",
        "sourceRoot": os.path.relpath(wz_root, ROOT),
        "encoding": "UTF-8",
        "gameVersion": 273,
        "region": "TW",
        "coverage": {
            "family": "冒險家原版出生地劇情",
            "area": 77,
            "idPattern": "36300-36399",
            "prerequisiteQuestIds": list(STORY_PREREQUISITE_QUEST_IDS),
            "requestedCount": len(requested_ids),
            "count": len(records),
            "missingIds": [item for item in requested_ids if item not in imported_ids],
            "executable": False,
        },
        "quests": records,
    }


def custom_story_evidence(server_root: Path) -> dict[str, Any]:
    relative = "script/expand/menu/萌新專區/主線任務.js"
    path = server_root / relative
    if not path.is_file():
        return {
            "id": "xinyugu-main-line",
            "name": "星語谷-主線任務",
            "source": relative,
            "available": False,
            "executable": False,
            "rawUtf8": None,
        }
    return {
        "id": "xinyugu-main-line",
        "name": "星語谷-主線任務",
        "source": relative,
        "available": True,
        "executable": False,
        "rawUtf8": path.read_text(encoding="utf-8"),
        "sha256": sha256_file(path),
        "note": "仅保留服务端脚本证据；本离线导入不执行其数据库、传送或奖励机制。",
    }


def build_manifest(
    maps: dict[str, Any], quests: dict[str, Any] | None, server_root: Path
) -> dict[str, Any]:
    manifest: dict[str, Any] = {
        "schemaVersion": 1,
        "format": "tms273-typed-wz-json-offline",
        "encoding": "UTF-8",
        "gameVersion": 273,
        "region": "TW",
        "source": {
            "root": maps["sourceRoot"],
            "serverRoot": os.path.relpath(server_root, ROOT),
            "mapJson": "Map/Map/{first-id-digit}/{id}.json",
            "questJson": "Quest/QuestData/{id}.json",
        },
        "maps": {
            "requested": maps["requestedMapIds"],
            "imported": maps["importedMapIds"],
            "missing": maps["missingMapIds"],
            "file": "maps.json",
        },
        "quests": {
            "file": "quests.json" if quests is not None else None,
            "coverage": quests.get("coverage") if quests is not None else None,
        },
        "customStoryEvidence": custom_story_evidence(server_root),
        "limitations": [
            "离线元数据；不修改 shared/ 或后端。",
            "WZ 原始 typed tree 保留在各记录 raw；UOL 只保留引用标记，不解析。",
            "传送门只按 273 源文件逐项抄录，不推测反向传送门。",
            "Quest Check/Act/Say/QuestInfo 与服务端脚本只作为原始证据，不声称可执行。",
        ],
    }
    return manifest


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wz-root", type=Path, default=DEFAULT_WZ_ROOT)
    parser.add_argument("--maps-json", type=Path, default=DEFAULT_MAPS_JSON)
    parser.add_argument("--server-root", type=Path, default=None)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--maps-only",
        action="store_true",
        help="只生成 maps.json；适合先给地图纹理导出工具使用。",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    wz_root = args.wz_root.resolve()
    server_root = (
        args.server_root.resolve()
        if args.server_root is not None
        else wz_root.parent
    )
    maps = build_maps(wz_root, args.maps_json.resolve(), server_root)
    quests = None if args.maps_only else build_quests(wz_root, server_root)
    output = args.out.resolve()
    write_json(output / "maps.json", maps)
    if quests is not None:
        write_json(output / "quests.json", quests)
    write_json(output / "manifest.json", build_manifest(maps, quests, server_root))
    print(
        f"tms273: imported {len(maps['maps'])}/{len(maps['requestedMapIds'])} maps "
        f"({len(maps['missingMapIds'])} missing)"
    )
    if quests is not None:
        print(f"tms273: imported {len(quests['quests'])} quests")
    print(f"tms273: wrote {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
