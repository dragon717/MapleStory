"""Validate the textured Windbell handoff without opening Blender.

The GLB checks intentionally inspect the binary JSON chunk.  That proves the
three exported files contain embedded images, image backed materials and UV
attributes; a filename or a Blender-side material count alone would not prove
those handoff properties.
"""

from __future__ import annotations

import json
import struct
from pathlib import Path

from PIL import Image


PROJECT = Path(__file__).resolve().parents[3]
ROOT = PROJECT / "resources" / "blender" / "windbell" / "legacy"
IMAGE_ROOTS = (
    PROJECT / "resources" / "scenes" / "windbell" / "images" / "clean",
    PROJECT / "resources" / "characters" / "windbell" / "images" / "clean",
)
REPORT = ROOT / "logs" / "texture_export_validation.json"


def read_glb(path: Path) -> dict:
    payload = path.read_bytes()
    if len(payload) < 20:
        raise ValueError(f"GLB is too short: {path}")
    magic, version, declared_length = struct.unpack_from("<4sII", payload, 0)
    if magic != b"glTF" or version != 2 or declared_length != len(payload):
        raise ValueError(f"Invalid GLB header: {path}")
    json_length, json_type = struct.unpack_from("<II", payload, 12)
    if json_type != 0x4E4F534A:
        raise ValueError(f"GLB first chunk is not JSON: {path}")
    return json.loads(payload[20 : 20 + json_length].decode("utf-8"))


def node_present(names: set[str], pattern: str) -> bool:
    return any(name == pattern or name.startswith(pattern + "_") for name in names)


def texture_stats(gltf: dict) -> dict:
    materials = gltf.get("materials", [])
    textured_materials = []
    for material in materials:
        pbr = material.get("pbrMetallicRoughness", {})
        if pbr.get("baseColorTexture"):
            textured_materials.append(material.get("name"))
    texcoord_primitives = 0
    primitive_count = 0
    for mesh in gltf.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            primitive_count += 1
            if "TEXCOORD_0" in primitive.get("attributes", {}):
                texcoord_primitives += 1
    embedded_images = [image for image in gltf.get("images", []) if "bufferView" in image and "uri" not in image]
    return {
        "image_count": len(gltf.get("images", [])),
        "embedded_image_count": len(embedded_images),
        "texture_count": len(gltf.get("textures", [])),
        "base_color_texture_materials": len(textured_materials),
        "base_color_material_names": textured_materials,
        "primitive_count": primitive_count,
        "texcoord_0_primitives": texcoord_primitives,
    }


def main() -> None:
    blend = ROOT / "windbell_world_asset_library_textured.blend"
    glbs = {
        "windbell_bridge_broken_textured.glb": {
            "scene": "WindbellBridge_Broken",
            "required": ["WB_Bridge_LeftBroken_plank_0", "WB_TexCard_CargoCart_Broken"],
            "forbidden": ["WB_Bridge_Connected_RIG", "WB_Bridge_WorkingPartial_RIG", "WB_Bridge_AnimationStudy_RIG", "WB_TexCard_Waystation_Repaired"],
        },
        "windbell_bridge_repaired_textured.glb": {
            "scene": "WindbellBridge_Repaired",
            "required": ["WB_Bridge_Connected_plank_0", "WB_TexCard_CargoCart_Repaired", "WB_TexCard_Waystation_Repaired"],
            "forbidden": ["WB_Bridge_LeftBroken_RIG", "WB_Bridge_WorkingPartial_RIG", "WB_Bridge_AnimationStudy_RIG", "WB_TexCard_CargoCart_Broken"],
        },
        "windbell_island_exploration_textured.glb": {
            "scene": "WindbellIsland_Exploration",
            "required": ["IS_TreeBridge_plank_0", "IS_TexCard_Dragon", "IS_TexCard_NPC_Awei"],
            "forbidden": ["WB_Bridge_LeftBroken_RIG", "WB_Bridge_Connected_RIG", "IS_DryBranch_heated", "IS_DryBranch_burning", "IS_DryBranch_ember", "IS_WetWood_wet", "IS_WetWood_steaming", "WB_TexCard_CargoCart_Broken"],
        },
    }
    missing = [str(path) for path in [blend, *[ROOT / "glb" / name for name in glbs]] if not path.is_file() or path.stat().st_size == 0]
    if missing:
        raise SystemExit("Missing or empty textured artifacts:\n" + "\n".join(missing))

    reports = []
    for filename, rule in glbs.items():
        path = ROOT / "glb" / filename
        gltf = read_glb(path)
        scenes = gltf.get("scenes", [])
        if len(scenes) != 1 or scenes[0].get("name") != rule["scene"]:
            raise SystemExit(f"Unexpected scene scope in {filename}: {scenes}")
        names = {node.get("name") for node in gltf.get("nodes", []) if node.get("name")}
        missing_nodes = [pattern for pattern in rule["required"] if not node_present(names, pattern)]
        leaked_nodes = [pattern for pattern in rule["forbidden"] if node_present(names, pattern)]
        stats = texture_stats(gltf)
        if missing_nodes or leaked_nodes:
            raise SystemExit(f"Scope check failed for {filename}: missing={missing_nodes}, leaked={leaked_nodes}")
        if stats["embedded_image_count"] < 1 or stats["texture_count"] < 1 or stats["base_color_texture_materials"] < 1 or stats["texcoord_0_primitives"] < 1:
            raise SystemExit(f"Texture contract failed for {filename}: {stats}")
        reports.append({
            "file": str(path.relative_to(PROJECT)),
            "bytes": path.stat().st_size,
            "scene": scenes[0]["name"],
            "scene_count": len(scenes),
            "node_count": len(gltf.get("nodes", [])),
            "required_nodes_present": len(rule["required"]),
            "forbidden_nodes_present": len(leaked_nodes),
            "texture": stats,
        })

    clean_reports = []
    if any(not root.is_dir() for root in IMAGE_ROOTS):
        raise SystemExit("Missing validated clean image directory: " + ", ".join(str(root) for root in IMAGE_ROOTS))
    for path in sorted(path for root in IMAGE_ROOTS for path in root.glob("*.png")):
        with Image.open(path) as image:
            image.load()
            if "A" not in image.getbands():
                raise SystemExit(f"Clean image has no alpha: {path}")
            alpha_min, alpha_max = image.getchannel("A").getextrema()
            if alpha_min >= 255:
                raise SystemExit(f"Clean image is fully opaque: {path}")
            clean_reports.append({"file": str(path.relative_to(PROJECT)), "bytes": path.stat().st_size, "mode": image.mode, "size": [image.width, image.height], "alpha_min": alpha_min, "alpha_max": alpha_max})
    if len(clean_reports) < 9:
        raise SystemExit(f"Expected at least 9 clean PNGs, found {len(clean_reports)}")

    result = {
        "status": "ok",
        "blend_file": str(blend.relative_to(PROJECT)),
        "blend_bytes": blend.stat().st_size,
        "clean_pngs": clean_reports,
        "glb_reports": reports,
        "contract": "textured blend contains packed image datablocks; each GLB has one active scene, embedded images, baseColorTexture and TEXCOORD_0",
    }
    REPORT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
