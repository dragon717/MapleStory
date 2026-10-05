"""Bounded material refinement for the TMS273 sky voyage scene.

This module is intentionally callable-only.  Importing it does nothing.  The
one public operation, :func:`refine_materials`, changes material slots,
Principled inputs, and texture nodes in an already-loaded Blender scene.  It
does not create, delete, or edit mesh geometry and it never saves or exports.

The production repair pass temporarily flattened every kept ``SV3_Hull`` face
to ``SV3_HullPlanks``.  When the pre-repair archive is present, this helper
matches the repaired hull faces to ``BeforeRepair_SV3_Hull`` by their polygon
vertex topology and restores the source material region before applying the
prototype palette.  The repaired hull mesh and all post-repair child meshes
remain in place.
"""

from __future__ import annotations

from collections import defaultdict
import json
from pathlib import Path
from typing import Any, Iterable

import bpy


ROOT = Path(__file__).resolve().parents[3]
V3_ROOT = ROOT / "resources/scenes/sky-voyage-v3"
REFERENCE = ROOT / "resources/scenes/sky-voyage-v2/design/ship-orthographic-v1.png"
WOOD_TEXTURE = V3_ROOT / "textures/wood.png"
DECK_TEXTURE = V3_ROOT / "textures/deck-planks.png"


# These names are the material contract already emitted by the production
# scripts.  DeckTeak deliberately maps to the existing SV3_M_Wood material:
# fit_voyage_cabin.py uses that name for the cabin floor and polish_user_sky_ship.py
# swaps it to the lighter deck-planks texture.
MATERIAL_NAMES = {
    "HullPlanks": "SV3_HullPlanks",
    "HullIvory": "SV3_Prototype_HullIvory",
    "DeckTeak": "SV3_M_Wood",
    "SailLinen": "SV3_Prototype_SailLinen",
    "SparWood": "SV3_Prototype_SparWood",
    "SternWalnut": "SV3_Prototype_SternWalnut",
    "BrassTrim": "SV3_Prototype_BrassTrim",
    "NavyIron": "SV3_Prototype_NavyIron",
    "TealRibbon": "SV3_Prototype_TealRibbon",
    "JadeGlass": "SV3_Prototype_JadeGlass",
    "SapphireGlass": "SV3_Prototype_SapphireGlass",
    "AmberCrystal": "SV3_Prototype_AmberCrystal",
}


# The archive can contain either prototype names or the original SV3_M_* names,
# depending on which historical script produced the live scene.  Region names
# are kept separate from material datablock names so topology restoration does
# not depend on slot order.
MATERIAL_ALIASES = {
    "HullPlanks": "HullPlanks",
    "HullIvory": "HullIvory",
    "Enamel": "HullIvory",
    "DeckTeak": "DeckTeak",
    "Wood": "DeckTeak",
    "SailLinen": "SailLinen",
    "Linen": "SailLinen",
    "SparWood": "SparWood",
    "SternWalnut": "SternWalnut",
    "BrassTrim": "BrassTrim",
    "Brass": "BrassTrim",
    "NavyIron": "NavyIron",
    "Navy": "NavyIron",
    "TealRibbon": "TealRibbon",
    "JadeGlass": "JadeGlass",
    "Jade": "JadeGlass",
    "SapphireGlass": "SapphireGlass",
    "Sapphire": "SapphireGlass",
    "AmberCrystal": "AmberCrystal",
    "Amber": "AmberCrystal",
}


PROTOTYPE_STYLE = {
    "HullIvory": {"base_color": (0.79, 0.77, 0.69, 1.0), "roughness": 0.60, "metallic": 0.12},
    "SailLinen": {"base_color": (0.92, 0.89, 0.80, 1.0), "roughness": 0.97, "metallic": 0.0},
    "BrassTrim": {"base_color": (0.66, 0.40, 0.12, 1.0), "roughness": 0.38, "metallic": 0.70},
    "NavyIron": {"base_color": (0.018, 0.042, 0.078, 1.0), "roughness": 0.55, "metallic": 0.45},
    "TealRibbon": {"base_color": (0.015, 0.22, 0.18, 1.0), "roughness": 0.44, "metallic": 0.18},
    "JadeGlass": {"base_color": (0.38, 0.86, 0.60, 1.0), "roughness": 0.08, "metallic": 0.0},
    "SapphireGlass": {"base_color": (0.36, 0.65, 0.96, 1.0), "roughness": 0.08, "metallic": 0.0},
    # This is the final repair script's amber color, rather than the earlier
    # prototype draft value.  The transmission contract is the same for both.
    "AmberCrystal": {"base_color": (0.95, 0.20, 0.025, 1.0), "roughness": 0.075, "metallic": 0.0},
    "DeckTeak": {"roughness": 0.76, "metallic": 0.0},
    "SparWood": {"roughness": 0.72, "metallic": 0.0},
    "SternWalnut": {"roughness": 0.72, "metallic": 0.0},
    "HullPlanks": {"roughness": 0.72, "metallic": 0.0},
}


WOOD_TINTS = {
    "HullPlanks": (0.64, 0.42, 0.31, 1.0),
    "SparWood": (0.86, 0.64, 0.40, 1.0),
    "SternWalnut": (0.72, 0.48, 0.30, 1.0),
}


def _material_base_name(material: Any) -> str:
    """Return a stable suffix for an existing material datablock."""

    if material is None:
        return ""
    name = str(getattr(material, "name", material)).split(".", 1)[0].removesuffix("_superseded")
    for prefix in ("SV3_Prototype_", "SV3_M_", "SV3_"):
        if name.startswith(prefix):
            name = name[len(prefix) :]
            break
    return name


def _semantic_from_material(material: Any) -> str | None:
    return MATERIAL_ALIASES.get(_material_base_name(material))


def _find_principled(material: Any) -> Any | None:
    if not material or not getattr(material, "use_nodes", False):
        return None
    return next((node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED"), None)


def _set_input(shader: Any, names: Iterable[str], value: Any) -> bool:
    if shader is None:
        return False
    for name in names:
        socket = shader.inputs.get(name)
        if socket is not None:
            socket.default_value = value
            return True
    return False


def _ensure_material(semantic: str) -> Any:
    """Resolve the production material, creating only a material datablock if absent."""

    name = MATERIAL_NAMES[semantic]
    material = bpy.data.materials.get(name)
    if material is None:
        # A live production file normally has all prototype materials.  This
        # fallback keeps the helper callable in a partially assembled scene
        # without touching any mesh or rerunning an earlier construction pass.
        fallback_name = "SV3_M_Wood" if semantic in {"DeckTeak", "SparWood", "SternWalnut", "HullPlanks"} else "SV3_M_Enamel"
        fallback = bpy.data.materials.get(fallback_name)
        material = fallback.copy() if fallback is not None else bpy.data.materials.new(name)
        material.name = name
    material.use_nodes = True
    material["voyage_material_semantic"] = semantic
    material["prototype_reference"] = str(REFERENCE)
    return material


def _load_image(path: Path) -> Any | None:
    if not path.exists():
        return None
    try:
        image = bpy.data.images.load(str(path), check_existing=True)
    except (RuntimeError, OSError):
        return None
    try:
        image.colorspace_settings.name = "sRGB"
    except (AttributeError, TypeError):
        pass
    return image


def _image_node(material: Any, image: Any, label: str) -> Any | None:
    if material is None or image is None:
        return None
    nodes = material.node_tree.nodes
    node = next((n for n in nodes if n.type == "TEX_IMAGE" and n.image == image), None)
    if node is None:
        node = nodes.new("ShaderNodeTexImage")
        node.image = image
    node.label = label
    node.name = label
    return node


def _connect_tinted_texture(material: Any, image: Any, tint: tuple[float, float, float, float], label: str) -> bool:
    """Connect a real wood image through a small multiply tint, preserving UVs."""

    shader = _find_principled(material)
    if shader is None or image is None:
        return False
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    texture = _image_node(material, image, label + " Texture")
    mix = next((n for n in nodes if n.type == "MIX" and n.label == label), None)
    if mix is None:
        mix = nodes.new("ShaderNodeMix")
    mix.label = label
    mix.name = label
    mix.data_type = "RGBA"
    mix.blend_type = "MULTIPLY"
    mix.inputs[0].default_value = 1.0
    mix.inputs[7].default_value = tint
    for link in list(shader.inputs["Base Color"].links):
        links.remove(link)
    links.new(texture.outputs["Color"], mix.inputs[6])
    links.new(mix.outputs[2], shader.inputs["Base Color"])
    material["export_base_color_multiplier"] = list(tint)
    # Existing authored Normal/Normal Map links are respected.  If the
    # material has no normal input, a restrained wood bump uses the same grain
    # image without changing UV coordinates or mesh data.
    normal_socket = shader.inputs.get("Normal")
    if normal_socket is not None and not normal_socket.links:
        bump = next((n for n in nodes if n.type == "BUMP" and n.label == label + " Bump"), None)
        if bump is None:
            bump = nodes.new("ShaderNodeBump")
        bump.label = label + " Bump"
        bump.name = label + " Bump"
        bump.inputs["Strength"].default_value = 0.16
        bump.inputs["Distance"].default_value = 0.045
        links.new(texture.outputs["Color"], bump.inputs["Height"])
        links.new(bump.outputs["Normal"], normal_socket)
    return True


def refine_texture_multipliers(scene):
    """Migrate live legacy multiply nodes that the glTF exporter cannot read."""
    report = []
    materials = {m for o in scene.objects if o.type == "MESH" for m in o.data.materials if m}
    for material in materials:
        shader = _find_principled(material)
        if shader is None or not shader.inputs["Base Color"].links:
            continue
        old = shader.inputs["Base Color"].links[0].from_node
        if old.type != "MIX_RGB" or old.blend_type != "MULTIPLY":
            continue
        assert old.inputs[0].default_value == 1 and old.inputs[1].links and not old.inputs[2].links
        tint = list(old.inputs[2].default_value)
        source = old.inputs[1].links[0].from_socket
        mix = material.node_tree.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"; mix.blend_type = "MULTIPLY"
        mix.inputs[0].default_value = 1; mix.inputs[7].default_value = tint
        material.node_tree.links.new(source, mix.inputs[6])
        material.node_tree.links.new(mix.outputs[2], shader.inputs["Base Color"])
        material.node_tree.nodes.remove(old)
        material["export_base_color_multiplier"] = tint
        report.append({"material": material.name, "base_color_multiplier": tint})
    return report


def _configure_materials() -> dict[str, Any]:
    materials = {semantic: _ensure_material(semantic) for semantic in MATERIAL_NAMES}
    wood_image = _load_image(WOOD_TEXTURE)
    deck_image = _load_image(DECK_TEXTURE)

    for semantic, material in materials.items():
        shader = _find_principled(material)
        style = PROTOTYPE_STYLE.get(semantic, {})
        if shader is None:
            continue
        if "base_color" in style:
            _set_input(shader, ("Base Color",), style["base_color"])
            material.diffuse_color = style["base_color"]
        _set_input(shader, ("Roughness",), style.get("roughness", 0.72))
        _set_input(shader, ("Metallic",), style.get("metallic", 0.0))

    # The supplied wood.png visibly has long warm grain; its use is restricted
    # to structural timber and the dark outer hull.  The supplied deck-planks
    # image has explicit board seams and is kept for the slightly lighter deck.
    for semantic in ("HullPlanks", "SparWood", "SternWalnut"):
        _connect_tinted_texture(materials[semantic], wood_image, WOOD_TINTS[semantic], "Voyage " + semantic)
        materials[semantic]["texture_source"] = str(WOOD_TEXTURE)
        materials[semantic]["grain_direction"] = "along timber length"
    _connect_tinted_texture(materials["DeckTeak"], deck_image, (1.06, 1.03, 0.98, 1.0), "Voyage DeckTeak")
    materials["DeckTeak"]["texture_source"] = str(DECK_TEXTURE)
    materials["DeckTeak"]["tone"] = "slightly lighter than outer hull"

    for semantic in ("JadeGlass", "SapphireGlass", "AmberCrystal"):
        material = materials[semantic]
        shader = _find_principled(material)
        style = PROTOTYPE_STYLE[semantic]
        # The glass contract is a uniform Principled color.  Remove any stale
        # atlas link before setting it so a legacy texture cannot override the
        # transmission material's authored base color.
        base_color = shader.inputs.get("Base Color") if shader is not None else None
        if base_color is not None:
            for link in list(base_color.links):
                material.node_tree.links.remove(link)
        _set_input(shader, ("Base Color",), style["base_color"])
        _set_input(shader, ("Roughness",), style["roughness"])
        _set_input(shader, ("Metallic",), style["metallic"])
        _set_input(shader, ("Transmission Weight", "Transmission"), 0.94)
        _set_input(shader, ("IOR",), 1.46)
        _set_input(shader, ("Coat Weight", "Clearcoat"), 0.5)
        _set_input(shader, ("Coat Roughness", "Clearcoat Roughness"), 0.045)
        _set_input(shader, ("Alpha",), 1.0)
        # Deliberately do not set blend_method/surface_render_method/alphaMode:
        # these are transmission materials, not fake alpha cutouts.
        material["transmission_contract"] = json.dumps(
            {
                "weight": 0.94,
                "ior": 1.46,
                "coat_weight": 0.5,
                "coat_roughness": 0.045,
                "alpha": 1.0,
                "alpha_mode": "opaque; KHR_materials_transmission",
            },
            ensure_ascii=True,
            sort_keys=True,
        )

    return materials


def _face_key(poly: Any, *, sorted_vertices: bool = False) -> tuple[int, tuple[int, ...]]:
    vertices = tuple(int(index) for index in poly.vertices)
    if sorted_vertices:
        vertices = tuple(sorted(vertices))
    return len(vertices), vertices


def _archive_object() -> Any | None:
    direct = bpy.data.objects.get("BeforeRepair_SV3_Hull")
    if direct is not None:
        return direct
    for scene in bpy.data.scenes:
        candidate = scene.objects.get("BeforeRepair_SV3_Hull")
        if candidate is not None:
            return candidate
    return None


def _ensure_slot(mesh: Any, material: Any) -> int:
    for index, existing in enumerate(mesh.materials):
        if existing == material or (existing is not None and existing.name == material.name):
            return index
    mesh.materials.append(material)
    return len(mesh.materials) - 1


def _restore_hull_semantics(scene: Any, materials: dict[str, Any]) -> dict[str, int | str]:
    hull = scene.objects.get("SV3_Hull")
    archive = _archive_object()
    if hull is None or hull.type != "MESH":
        return {"restored_faces": 0, "unmatched_faces": 0, "archive": "missing SV3_Hull"}
    if hull.data.name.startswith("SV3_Hull_ExactOpenings"):
        # Clipping has already propagated each source face label. Its new
        # vertex IDs must never be compared with the original mesh's IDs.
        for polygon in hull.data.polygons:
            semantic = _semantic_from_material(hull.data.materials[polygon.material_index])
            if semantic in materials:
                polygon.material_index = _ensure_slot(hull.data, materials[semantic])
        hull["material_restore_source"] = "BeforeRepair_SV3_Hull"
        hull["material_restore_match"] = "source face label propagated through exact clipping"
        hull["material_restore_faces"] = len(hull.data.polygons)
        hull["material_restore_unmatched_faces"] = 0
        return {"restored_faces": len(hull.data.polygons), "unmatched_faces": 0, "archive": "exact source-label clipping"}
    if archive is None or archive.type != "MESH":
        return {"restored_faces": 0, "unmatched_faces": len(hull.data.polygons), "archive": "missing BeforeRepair_SV3_Hull"}

    exact: dict[tuple[int, tuple[int, ...]], list[str]] = defaultdict(list)
    unordered: dict[tuple[int, tuple[int, ...]], list[str]] = defaultdict(list)
    for polygon in archive.data.polygons:
        if polygon.material_index >= len(archive.data.materials):
            continue
        semantic = _semantic_from_material(archive.data.materials[polygon.material_index])
        if semantic in MATERIAL_NAMES and semantic != "SailLinen":
            exact[_face_key(polygon)].append(semantic)
            unordered[_face_key(polygon, sorted_vertices=True)].append(semantic)

    restored = 0
    unmatched = 0
    for polygon in hull.data.polygons:
        semantic = None
        candidates = exact.get(_face_key(polygon))
        if candidates:
            semantic = candidates.pop(0)
        else:
            candidates = unordered.get(_face_key(polygon, sorted_vertices=True))
            if candidates:
                semantic = candidates.pop(0)
        if semantic is None:
            unmatched += 1
            continue
        polygon.material_index = _ensure_slot(hull.data, materials[semantic])
        restored += 1

    hull["material_restore_source"] = "BeforeRepair_SV3_Hull"
    hull["material_restore_match"] = "polygon vertex topology; repaired geometry retained"
    hull["material_restore_faces"] = restored
    hull["material_restore_unmatched_faces"] = unmatched
    return {"restored_faces": restored, "unmatched_faces": unmatched, "archive": archive.name}


def _fallback_region(object_name: str, material_region: str = "") -> str | None:
    name = object_name.split(".", 1)[0]
    region = material_region.lower()
    if region == "cloth only" or name.endswith("_RepairedCloth"):
        return "SailLinen"
    if "Crystal" in name or "crystal" in region:
        return "AmberCrystal"
    if "JadeSetting" in name or "SapphireSetting" in name or "SternSetting" in name:
        return None  # preserve the existing brass/glass polygon slots
    if "BrassCollars" in name:
        return "BrassTrim"
    if "Nozzle" in name:
        return "NavyIron"
    if "Engine_" in name and "Collar" not in name:
        return "HullIvory"
    if "SternRoofDeck" in name:
        return "SternWalnut"
    if "EnergyCradle" in name or "TimberSpars" in name or "TimberSpokes" in name:
        return None  # existing slots distinguish wood, navy ferrules, and brass hubs
    if "WheelHullSockets" in name:
        return None  # existing slots distinguish SternWalnut and SparWood
    if any(token in name for token in ("MainFan", "AftFan", "BowVane", "AftVane", "Wheel_")):
        return "SailLinen"
    return None


def _refine_object_materials(scene: Any, materials: dict[str, Any]) -> int:
    changed = 0
    for obj in scene.objects:
        if obj.type != "MESH" or obj.name == "SV3_Hull":
            continue
        fallback = _fallback_region(obj.name, str(obj.get("material_region", "")))
        # Explicit cabin floor support keeps the inner deck on the lighter
        # deck-planks material without touching cabin wall or bed geometry.
        if obj.name in {"SV2_CabinFloor", "SV3_CabinFloor"}:
            fallback = "DeckTeak"
        for polygon in obj.data.polygons:
            semantic = None
            if polygon.material_index < len(obj.data.materials):
                semantic = _semantic_from_material(obj.data.materials[polygon.material_index])
            if semantic is None:
                semantic = fallback
            if semantic not in MATERIAL_NAMES:
                continue
            new_index = _ensure_slot(obj.data, materials[semantic])
            if polygon.material_index != new_index:
                polygon.material_index = new_index
                changed += 1
        obj["material_refinement"] = "prototype polygon semantics; no geometry changes"
    return changed


def refine_materials(scene: Any) -> dict[str, Any]:
    """Refine the supplied live Blender scene and return an audit summary.

    The caller owns Blender scene selection and lifecycle.  This function does
    not set the active scene, advance a frame, invoke any operator, save a blend
    file, export a GLB, or alter vertices/faces/shape keys.
    """

    if scene is None:
        raise ValueError("refine_materials(scene) requires a Blender scene")
    materials = _configure_materials()
    hull_report = _restore_hull_semantics(scene, materials)
    remapped_polygons = _refine_object_materials(scene, materials)
    scene["material_refinement_reference"] = str(REFERENCE)
    scene["material_refinement_revision"] = "prototype-polygon-semantics-v1"
    scene["material_refinement_geometry_contract"] = "no vertices/faces/shape keys changed"
    return {
        "scene": scene.name,
        "materials": sorted(materials),
        "hull": hull_report,
        "remapped_polygons": remapped_polygons,
        "geometry_changed": False,
        "saved_or_exported": False,
    }


__all__ = ["refine_materials"]
