"""Run the Windbell texture handoff through the live official Blender MCP.

The client deliberately uses the already running project Blender instance.  It
validates the final transparent PNGs before starting MCP, then asks
``execute_blender_code`` to add image backed UV materials and 2.5D cards to the
existing editable library.  No Blender process is started or stopped here.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path

from PIL import Image

from mcp_build_client import MCPClient


PROJECT = Path(__file__).resolve().parents[3]
TEXTURE_SCRIPT = PROJECT / "scripts" / "creative" / "blender" / "build_windbell_textured_assets.py"
CLEAN_ROOTS = (
    PROJECT / "resources" / "scenes" / "windbell" / "images" / "clean",
    PROJECT / "resources" / "characters" / "windbell" / "images" / "clean",
)
PATCH_MANIFEST = PROJECT / "resources" / "blender" / "windbell" / "textures" / "source-patches.json"
EVIDENCE = PROJECT / "resources" / "blender" / "windbell" / "logs" / "mcp_texture_evidence.json"
MANIFEST = PROJECT / "resources" / "blender" / "windbell" / "manifest.json"

ROLE_PATTERNS = {
    "cart": ("cart", "wagon", "cargo"),
    "bell": ("bell",),
    "materials": ("materials", "material", "supply", "plank"),
    "waystation": ("waystation", "way_station", "station", "hut"),
    "dragon": ("dragon",),
    "leafwing": ("leafwing", "leaf_wing", "leaf-wing"),
    "npc_awei": ("awei",),
    "npc_lanzhi": ("lanzhi",),
    "npc_mucen": ("mucen",),
}

PATCH_ROLES = (
    "bridge_wood", "bridge_grass", "bridge_bark", "bridge_stone", "bridge_water",
    "island_wood", "island_grass", "island_bark", "island_stone", "island_water",
)


def normalize(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")


def inspect_clean_inputs() -> tuple[dict[str, Path], dict[str, dict]]:
    missing_roots = [root for root in CLEAN_ROOTS if not root.is_dir()]
    if missing_roots:
        raise FileNotFoundError("validated clean image directory is not present: " + ", ".join(str(root) for root in missing_roots))
    files = sorted(path for root in CLEAN_ROOTS for path in root.glob("*.png"))
    if len(files) < len(ROLE_PATTERNS):
        raise RuntimeError(f"expected at least {len(ROLE_PATTERNS)} clean PNGs, found {len(files)}")

    candidates: dict[str, list[Path]] = {role: [] for role in ROLE_PATTERNS}
    for path in files:
        stem = normalize(path.stem)
        for role, patterns in ROLE_PATTERNS.items():
            if any(normalize(pattern) in stem for pattern in patterns):
                candidates[role].append(path)

    missing = [role for role, paths in candidates.items() if not paths]
    if missing:
        raise RuntimeError("clean PNGs missing required roles: " + ", ".join(missing))

    chosen: dict[str, Path] = {}
    metadata: dict[str, dict] = {}
    for role, paths in candidates.items():
        # Prefer an explicitly final/transparent/clean filename if a producer
        # left more than one revision in the clean directory.
        ranked = sorted(
            paths,
            key=lambda p: (
                not any(token in normalize(p.stem) for token in ("final", "clean", "transparent", "cutout")),
                p.name,
            ),
        )
        chosen_path = ranked[0]
        with Image.open(chosen_path) as image:
            image.load()
            if "A" not in image.getbands():
                raise RuntimeError(f"{chosen_path.name} has no alpha channel")
            alpha = image.getchannel("A")
            alpha_min, alpha_max = alpha.getextrema()
            if alpha_min >= 255:
                raise RuntimeError(f"{chosen_path.name} is fully opaque; expected transparent clean art")
            if image.width < 2 or image.height < 2:
                raise RuntimeError(f"{chosen_path.name} is too small to be an art asset")
            metadata[role] = {
                "path": str(chosen_path),
                "file_size": chosen_path.stat().st_size,
                "mode": image.mode,
                "width": image.width,
                "height": image.height,
                "alpha_min": alpha_min,
                "alpha_max": alpha_max,
                "candidate_files": [str(p) for p in paths],
            }
        chosen[role] = chosen_path
    return chosen, metadata


def inspect_texture_patches() -> tuple[dict[str, Path], dict[str, dict]]:
    if not PATCH_MANIFEST.is_file():
        raise FileNotFoundError(f"texture patch manifest is not present: {PATCH_MANIFEST}")
    manifest = json.loads(PATCH_MANIFEST.read_text(encoding="utf-8"))
    entries = manifest.get("patches")
    if not isinstance(entries, dict):
        raise RuntimeError(f"texture patch manifest has no patches mapping: {PATCH_MANIFEST}")
    missing_roles = [role for role in PATCH_ROLES if role not in entries]
    if missing_roles:
        raise RuntimeError("texture patch manifest missing required roles: " + ", ".join(missing_roles))

    chosen: dict[str, Path] = {}
    metadata: dict[str, dict] = {}
    for role in PATCH_ROLES:
        spec = entries[role]
        output = Path(spec.get("output", ""))
        path = output if output.is_absolute() else PROJECT / output
        if not path.is_file():
            raise FileNotFoundError(f"texture patch is not present: {path}")
        with Image.open(path) as image:
            image.load()
            if image.width < 2 or image.height < 2:
                raise RuntimeError(f"texture patch is too small: {path}")
            metadata[role] = {
                "path": str(path),
                "output": str(path.relative_to(PROJECT)),
                "source": spec.get("source", ""),
                "crop_xyxy_pixels": spec.get("crop_xyxy_pixels", []),
                "surface": spec.get("surface", ""),
                "file_size": path.stat().st_size,
                "mode": image.mode,
                "width": image.width,
                "height": image.height,
            }
        chosen[role] = path
    return chosen, metadata


def call_and_record(client: MCPClient, evidence: dict, tool: str, arguments: dict):
    response = client.call_tool(tool, arguments)
    evidence["calls"].append({"tool": tool, "response": response})
    if response.get("error"):
        raise RuntimeError(f"{tool} JSON-RPC error: {response['error']}")
    result = response.get("result")
    if isinstance(result, dict) and result.get("isError"):
        raise RuntimeError(f"{tool} returned isError: {result}")
    texts = []
    if isinstance(result, dict):
        texts.extend(block.get("text", "") for block in result.get("content", []) if isinstance(block, dict))
    if tool == "execute_blender_code":
        if not any("Code executed successfully" in text for text in texts):
            raise RuntimeError(f"{tool} did not report successful execution: {' | '.join(texts)[:3000]}")
    elif tool == "get_object_info" and any(text.startswith(("Error getting", "Communication error")) for text in texts):
        raise RuntimeError(f"{tool} failed: {' | '.join(texts)[:3000]}")
    return response


def response_text(response: dict) -> str:
    result = response.get("result", {})
    if not isinstance(result, dict):
        return ""
    return "\n".join(block.get("text", "") for block in result.get("content", []) if isinstance(block, dict))


def update_manifest(clean_metadata: dict[str, dict], patch_metadata: dict[str, dict]) -> None:
    """Record the concrete textured handoff after MCP has completed."""
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    relative = lambda path: str(Path(path).relative_to(PROJECT))
    manifest.setdefault("artifacts", {})["textured_blend"] = "resources/blender/windbell/legacy/windbell_world_asset_library_textured.blend"
    manifest["artifacts"]["textured_renders"] = [
        "resources/blender/windbell/legacy/renders/windbell_bridge_broken_textured.png",
        "resources/blender/windbell/legacy/renders/windbell_bridge_repaired_textured.png",
        "resources/blender/windbell/legacy/renders/windbell_island_exploration_textured.png",
    ]
    manifest["artifacts"]["textured_glb"] = [
        "resources/blender/windbell/legacy/glb/windbell_bridge_broken_textured.glb",
        "resources/blender/windbell/legacy/glb/windbell_bridge_repaired_textured.glb",
        "resources/blender/windbell/legacy/glb/windbell_island_exploration_textured.glb",
    ]
    manifest["textured_delivery"] = {
        "status": "mcp_built_and_exported",
        "blend": manifest["artifacts"]["textured_blend"],
        "renders": manifest["artifacts"]["textured_renders"],
        "glb": manifest["artifacts"]["textured_glb"],
        "source_images": {
            "bridge_keyart": "resources/scenes/windbell/images/bridge-restored.png",
            "island_keyart": "resources/scenes/windbell/images/island-keyart.png",
            "clean_roles": {role: relative(info["path"]) for role, info in clean_metadata.items()},
        },
        "material_patches": {
            role: {
                "output": info["output"],
                "source": info["source"],
                "crop_xyxy_pixels": info["crop_xyxy_pixels"],
                "surface": info["surface"],
                "uv_region": [0.0, 0.0, 1.0, 1.0],
            }
            for role, info in patch_metadata.items()
        },
        "core_texture_regions": {
            "bridge_patches": {role[len("bridge_"):]: [0.0, 0.0, 1.0, 1.0] for role in PATCH_ROLES if role.startswith("bridge_")},
            "island_patches": {role[len("island_"):]: [0.0, 0.0, 1.0, 1.0] for role in PATCH_ROLES if role.startswith("island_")},
        },
        "card_collections": ["WB_Textured_Cards_Broken", "WB_Textured_Cards_Repaired", "IS_Textured_Cards_Island"],
        "card_contract": "transparent clean PNG on UVMap plane with 0.06 Blender-unit Solidify thickness; X horizontal / Z up / Y depth",
        "integration_status": "asset_only; game runtime is not connected",
        "mcp_evidence": "resources/blender/windbell/logs/mcp_texture_evidence.json",
        "validation": "resources/blender/windbell/logs/texture_export_validation.json",
    }
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    clean_inputs, clean_metadata = inspect_clean_inputs()
    patch_inputs, patch_metadata = inspect_texture_patches()
    clean_mapping = {role: str(path) for role, path in clean_inputs.items()}
    patch_mapping = {role: str(path) for role, path in patch_inputs.items()}
    evidence = {
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "server": "ahujasid/blender-mcp",
        "command": ["/Users/muniao/.local/bin/uvx", "--python", "3.11", "blender-mcp"],
        "env": {"BLENDER_HOST": "localhost", "BLENDER_PORT": "9987", "BLENDER_MCP_SAFE_MODE": "1", "DISABLE_TELEMETRY": "1"},
        "clean_inputs": clean_metadata,
        "texture_patches": patch_metadata,
        "calls": [],
        "execution_mode": "augment existing live Blender scene; no Blender restart",
    }
    client = MCPClient()
    try:
        initialize = client.request("initialize", {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "maple-windbell-texture-client", "version": "1.0"},
        })
        evidence["initialize"] = initialize
        client.notify("notifications/initialized")
        listed = client.request("tools/list", {})
        evidence["tools_list"] = {
            "response": listed,
            "names": [tool.get("name") for tool in listed.get("result", {}).get("tools", [])],
        }
        call_and_record(client, evidence, "get_addon_status", {"user_prompt": "Verify the live independent Blender MCP before texture handoff."})
        before = call_and_record(client, evidence, "get_scene_info", {"user_prompt": "Read the existing editable Windbell scenes before adding image textures."})

        # Check the actual scene contract immediately before mutation.  This
        # avoids turning an unexpectedly empty MCP session into a new build.
        scene_check = """import bpy
required = ['WindbellBridge_Broken', 'WindbellBridge_Repaired', 'WindbellIsland_Exploration']
missing = [name for name in required if bpy.data.scenes.get(name) is None]
print({'required_scenes': required, 'missing': missing, 'scene_count': len(bpy.data.scenes), 'windbell_objects': len([o for o in bpy.data.objects if o.name.startswith(('WB_', 'IS_'))])})
if missing:
    raise RuntimeError('texture handoff requires the existing Windbell scene library: ' + ', '.join(missing))
"""
        check = call_and_record(client, evidence, "execute_blender_code", {"code": scene_check, "user_prompt": "Confirm the current MCP session contains the completed Windbell scene library before augmentation."})

        texture_source = TEXTURE_SCRIPT.read_text(encoding="utf-8")
        # repr is Python source escaping, so the UTF-8 project path is passed as
        # data to Blender and never interpolated into a shell command.
        injected = "CLEAN_INPUTS = " + repr(clean_mapping) + "\nTEXTURE_PATCHES = " + repr(patch_mapping) + "\n"
        code = injected + texture_source
        evidence["texture_script"] = str(TEXTURE_SCRIPT)
        evidence["texture_script_bytes"] = len(code.encode("utf-8"))
        build = call_and_record(client, evidence, "execute_blender_code", {
            "code": code,
            "user_prompt": "Add packed image textures, UV materials and thick transparent 2.5D cards to the existing Windbell scenes, then render and export the three textured handoff GLBs.",
        })
        if "WINDBELL_TEXTURE_BUILD_COMPLETE" not in response_text(build):
            raise RuntimeError("texture build returned without WINDBELL_TEXTURE_BUILD_COMPLETE")

        after = call_and_record(client, evidence, "get_scene_info", {"user_prompt": "Read textured Windbell scenes after MCP augmentation."})
        screenshot = call_and_record(client, evidence, "get_viewport_screenshot", {"max_size": 1400, "user_prompt": "Capture the textured Windbell viewport for visual evidence."})
        verify_code = """import bpy
main = ['WindbellBridge_Broken', 'WindbellBridge_Repaired', 'WindbellIsland_Exploration']
texture_images = [i for i in bpy.data.images if i.name.startswith('WB_TEX_IMG_')]
packed_images = [i.name for i in texture_images if i.packed_file]
texture_materials = [m for m in bpy.data.materials if m.name.startswith('WB_TEX_MAT_')]
cards = [o for o in bpy.data.objects if o.name.startswith(('WB_TexCard_', 'IS_TexCard_'))]
uv_meshes = [o.name for o in bpy.data.objects if o.get('texture_material') and o.type == 'MESH' and o.data.uv_layers]
material_nodes = {}
for m in texture_materials:
    image_nodes = [n.image.name for n in m.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image]
    material_nodes[m.name] = {'images': image_nodes, 'has_base_color_link': any(l.to_node.type == 'BSDF_PRINCIPLED' and l.to_socket.name == 'Base Color' for l in m.node_tree.links)}
scene_children = {s.name: sorted(c.name for c in s.collection.children if c.name.startswith(('WB_', 'IS_'))) for s in bpy.data.scenes if s.name in main}
print({'artifact_blend': bpy.data.filepath, 'main_scenes': main, 'texture_images': [i.name for i in texture_images], 'packed_images': packed_images, 'texture_material_count': len(texture_materials), 'material_nodes': material_nodes, 'card_count': len(cards), 'cards': [{'name': o.name, 'role': o.get('card_role'), 'source': o.get('texture_source'), 'uv': o.get('uv_map_name'), 'thickness': o.get('card_thickness')} for o in cards], 'uv_mesh_count': len(uv_meshes), 'uv_mesh_sample': uv_meshes[:20], 'scene_children': scene_children})
"""
        verify = call_and_record(client, evidence, "execute_blender_code", {"code": verify_code, "user_prompt": "Independently verify packed images, image-backed Base Color nodes, UV layers, card thickness and main scene isolation."})
        verify_text = response_text(verify)
        if not all(token in verify_text for token in ("packed_images", "texture_material_count", "card_count", "uv_mesh_count")):
            raise RuntimeError("texture verification response is incomplete: " + verify_text[:3000])
        for object_name in ["WB_Bridge_LeftBroken_plank_0", "WB_TexCard_CargoCart_Broken", "IS_TexCard_Dragon"]:
            call_and_record(client, evidence, "get_object_info", {"object_name": object_name, "user_prompt": "Inspect a representative textured Windbell mesh or 2.5D card."})
        update_manifest(clean_metadata, patch_metadata)
        evidence["manifest"] = str(MANIFEST)
        evidence["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        EVIDENCE.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"status": "ok", "evidence": str(EVIDENCE), "clean_roles": sorted(clean_mapping), "before": bool(before), "after": bool(after), "build": bool(build), "verify": bool(verify)}, ensure_ascii=False))
        return 0
    except Exception as exc:
        evidence["error"] = repr(exc)
        evidence["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        EVIDENCE.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"status": "error", "error": repr(exc), "evidence": str(EVIDENCE)}, ensure_ascii=False))
        return 1
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(main())
