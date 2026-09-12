"""Offline validation for the files produced by the Blender MCP build.

This deliberately reads only the manifest, PNG headers and GLB JSON chunks. It
does not open Blender or infer game integration from an export file.
"""

from __future__ import annotations

import json
import struct
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[3]
ROOT = PROJECT / "resources" / "creative" / "windbell" / "blender"
MANIFEST = ROOT / "manifest.json"


def read_glb(path: Path) -> dict:
    payload = path.read_bytes()
    if len(payload) < 20:
        raise ValueError(f"GLB is too short: {path}")
    magic, version, declared_length = struct.unpack_from("<4sII", payload, 0)
    if magic != b"glTF" or version != 2 or declared_length != len(payload):
        raise ValueError(f"Invalid GLB header: {path}")
    json_length, json_type = struct.unpack_from("<II", payload, 12)
    if json_type != 0x4E4F534A:  # ASCII JSON
        raise ValueError(f"GLB first chunk is not JSON: {path}")
    return json.loads(payload[20 : 20 + json_length].decode("utf-8"))


def listed_paths(manifest: dict, key: str) -> list[Path]:
    return [PROJECT / Path(item) for item in manifest["artifacts"][key]]


def main() -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    blend = PROJECT / Path(manifest["artifacts"]["blend"])
    pngs = listed_paths(manifest, "renders")
    glbs = listed_paths(manifest, "glb")
    files = [blend, *pngs, *glbs]
    missing = [str(path) for path in files if not path.is_file() or path.stat().st_size == 0]
    if missing:
        raise SystemExit("Missing or empty artifacts:\n" + "\n".join(missing))

    expected = {
        "windbell_bridge_broken.glb": {
            "scene": "WindbellBridge_Broken",
            "required": ["WB_Bridge_LeftBroken_RIG", "WB_CargoCart_Tilted"],
            "forbidden": ["WB_Bridge_Connected_RIG", "WB_Bridge_WorkingPartial_RIG", "WB_Bridge_AnimationStudy_RIG"],
        },
        "windbell_bridge_repaired.glb": {
            "scene": "WindbellBridge_Repaired",
            "required": ["WB_Bridge_Connected_RIG", "WB_CargoCart_Upright", "WB_LifeShelter"],
            "forbidden": ["WB_Bridge_LeftBroken_RIG", "WB_Bridge_WorkingPartial_RIG", "WB_Bridge_AnimationStudy_RIG"],
        },
        "windbell_island_exploration.glb": {
            "scene": "WindbellIsland_Exploration",
            "required": ["IS_RootRoad_Module_0", "IS_TreeBridge_RIG", "IS_Station_Hut", "IS_PatrolDragon_ROOT"],
            "forbidden": ["WB_Bridge_LeftBroken_RIG", "WB_Bridge_Connected_RIG", "IS_DryBranch_heated", "IS_DryBranch_burning", "IS_DryBranch_ember", "IS_WetWood_wet", "IS_WetWood_steaming"],
        },
    }
    reports = []
    for path in glbs:
        gltf = read_glb(path)
        names = {node.get("name") for node in gltf.get("nodes", [])}
        scenes = gltf.get("scenes", [])
        rule = expected[path.name]
        if len(scenes) != 1 or scenes[0].get("name") != rule["scene"]:
            raise SystemExit(f"Unexpected scene scope in {path.name}: {scenes}")
        def present(pattern: str) -> bool:
            return any(name == pattern or name.startswith(pattern + "_") for name in names if name)

        missing_nodes = [pattern for pattern in rule["required"] if not present(pattern)]
        leaked_nodes = [pattern for pattern in rule["forbidden"] if present(pattern)]
        if missing_nodes or leaked_nodes:
            raise SystemExit(f"Scope check failed for {path.name}: missing={missing_nodes}, leaked={leaked_nodes}")
        reports.append({
            "file": str(path.relative_to(PROJECT)),
            "bytes": path.stat().st_size,
            "scene": scenes[0]["name"],
            "scene_count": len(scenes),
            "node_count": len(gltf.get("nodes", [])),
            "required_nodes_present": len(rule["required"]),
            "forbidden_nodes_present": len(leaked_nodes),
        })
    print(json.dumps({
        "status": "ok",
        "blend_bytes": blend.stat().st_size,
        "png_count": len(pngs),
        "glb_reports": reports,
        "scope_contract": "each GLB has one active scene and only its intended state collections",
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
