"""Add depth-aware, open wheel hardware around the authored sail.

This is a headless integration module.  ``apply(scene)`` only creates objects
owned by the ``SV3_WheelDepth_`` prefix and parents every rotating addition to
the retained ``SV3_Wheel_{side}`` root.  Retained sail geometry, source wheel
geometry, shape keys, pivots, and fixed hull supports are never destructively
edited.  The active sail and source spoke mesh receive idempotent copies so
atlas materials and depth can be applied without changing their source caches.

The Blender scene uses X/Z for the wheel face and Y for wheel depth.  The glTF
exporter later presents that face as runtime X/Y and the Blender-Y depth as
runtime Z.  The four atlas quadrants use Blender's bottom-left UV origin:
wood is upper-left in the image, canvas upper-right, brass lower-left, and
navy lower-right.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import bpy
from mathutils import Matrix


ROOT = Path(__file__).resolve().parents[3]
ATLAS_PATH = ROOT / "resources/scenes/sky-voyage-v3/textures/wheel-material-atlas-v1.png"
PREFIX = "SV3_WheelDepth_"

# Image pixels are top-left-origin while Blender UVs are bottom-left-origin.
# Keep this mapping explicit so generated MaterialUV values cannot cross tiles.
ATLAS_METADATA = {
    "schema": "maple.sky-voyage.wheel-depth-atlas.v1",
    "image": "resources/scenes/sky-voyage-v3/textures/wheel-material-atlas-v1.png",
    "metadata": "resources/scenes/sky-voyage-v3/textures/wheel-material-atlas-v1.json",
    "uv_origin": "bottom-left",
    "image_origin": "top-left",
    "quadrants": {
        "wood": {"u": [0.0, 0.5], "v": [0.5, 1.0]},
        "canvas": {"u": [0.5, 1.0], "v": [0.5, 1.0]},
        "brass": {"u": [0.0, 0.5], "v": [0.0, 0.5]},
        "navy": {"u": [0.5, 1.0], "v": [0.0, 0.5]},
    },
    "scope": "new open hub depth geometry plus idempotent material/depth copies of retained sail and source spokes",
    "retained_sail_canvas": {
        "mesh_copy": "idempotent",
        "source_cache": "SV3_WheelDepth_OriginalSailMesh_{side}",
        "material_quad": "top-right",
        "source_uv": "preserved",
        "shape_keys": "preserved",
        "geometry": "unchanged",
    },
    "new_depth_geometry": {
        "outer_frame": False,
        "frame_connectors": False,
        "straight_spokes": False,
        "straight_back_supports": False,
        "source_spokes_depth_scale": 1.35,
        "source_spokes_depth_axis": "wheel-local Y",
        "open_brass_hub_ring": True,
        "navy_center_caps": True,
        "retained_asymmetric_sail_outline": True,
    },
    "canvas_uv": {
        "source": "SourceUV fractional repeat",
        "shader_nodes_added": False,
    },
}

_MATERIAL_SPECS = {
    "wood": {"roughness": 0.66, "metallic": 0.0, "color": (0.40, 0.21, 0.09, 1.0)},
    "canvas": {"roughness": 0.90, "metallic": 0.0, "color": (0.82, 0.77, 0.63, 1.0)},
    "brass": {"roughness": 0.30, "metallic": 0.82, "color": (0.68, 0.43, 0.10, 1.0)},
    "navy": {"roughness": 0.42, "metallic": 0.72, "color": (0.03, 0.08, 0.16, 1.0)},
}


def _iter_meshes(root):
    if root.type == "MESH":
        yield root
    for child in root.children_recursive:
        if child.type == "MESH":
            yield child


def _delete_owned_objects(scene):
    """Make repeated headless apply calls idempotent within our own prefix."""
    owned = [obj for obj in scene.objects if obj.name.startswith(PREFIX)]
    meshes = {obj.data for obj in owned if obj.type == "MESH" and obj.data}
    for obj in owned:
        bpy.data.objects.remove(obj, do_unlink=True)
    for mesh in meshes:
        if mesh.users == 0:
            bpy.data.meshes.remove(mesh)


def _material(name, atlas, semantic):
    material_name = f"{PREFIX}Material_{name}"
    material = bpy.data.materials.get(material_name) or bpy.data.materials.new(material_name)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    shader = nodes.new("ShaderNodeBsdfPrincipled")
    uv_node = nodes.new("ShaderNodeUVMap")
    uv_node.uv_map = "MaterialUV"
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = atlas
    texture.extension = "CLIP"
    texture.interpolation = "Linear"
    texture.image.colorspace_settings.name = "sRGB"
    spec = _MATERIAL_SPECS[semantic]
    shader.inputs["Base Color"].default_value = spec["color"]
    shader.inputs["Roughness"].default_value = spec["roughness"]
    shader.inputs["Metallic"].default_value = spec["metallic"]
    links.new(uv_node.outputs["UV"], texture.inputs["Vector"])
    links.new(texture.outputs["Color"], shader.inputs["Base Color"])
    links.new(shader.outputs["BSDF"], output.inputs["Surface"])
    material.diffuse_color = spec["color"]
    material["wheel_depth_atlas"] = ATLAS_METADATA["image"]
    material["wheel_depth_atlas_semantic"] = semantic
    material["wheel_depth_atlas_uv_origin"] = ATLAS_METADATA["uv_origin"]
    material["wheel_depth_material_uv"] = "MaterialUV"
    return material


def _quadrant(semantic):
    q = ATLAS_METADATA["quadrants"][semantic]
    return float(q["u"][0]), float(q["u"][1]), float(q["v"][0]), float(q["v"][1])


def _fraction(value):
    value = float(value)
    if not math.isfinite(value):
        return 0.5
    return value - math.floor(value)


def _atlas_uv(uv, semantic):
    """Map a source UV (including repeats) into one atlas quadrant."""
    u0, u1, v0, v1 = _quadrant(semantic)
    return (
        u0 + (u1 - u0) * _fraction(uv[0]),
        v0 + (v1 - v0) * _fraction(uv[1]),
    )


def _local_source_points(wheel, spokes):
    """Read spoke geometry in wheel-local Blender coordinates."""
    inverse = wheel.matrix_world.inverted_safe()
    points = []
    for obj in _iter_meshes(spokes):
        transform = inverse @ obj.matrix_world
        for vertex in obj.data.vertices:
            points.append(transform @ vertex.co)
    return points


def _refresh_wheel_matrices(wheel, spokes):
    """Flush post-rotation object matrices before sampling source directions."""
    try:
        bpy.context.view_layer.update()
    except (AttributeError, RuntimeError):
        # Headless callers may provide an already evaluated dependency graph;
        # the explicit object refresh below is still enough for those scenes.
        pass
    objects = [wheel, spokes]
    objects.extend(wheel.children_recursive)
    objects.extend(spokes.children_recursive)
    seen = set()
    for obj in objects:
        marker = obj.as_pointer() if hasattr(obj, "as_pointer") else id(obj)
        if marker in seen:
            continue
        seen.add(marker)
        try:
            obj.update_matrix_world(force=True)
        except (AttributeError, TypeError):
            obj.update_tag()


def _sail_mesh_cache(wheel, side):
    """Keep the first retained sail mesh as an idempotent, fake-user cache."""
    cache_name = f"{PREFIX}OriginalSailMesh_{side}"
    cache = bpy.data.meshes.get(cache_name)
    if cache is None:
        cache = wheel.data.copy()
        cache.name = cache_name
        cache.use_fake_user = True
        cache["wheel_depth_original_cache"] = True
        cache["wheel_depth_source_object"] = wheel.name
        cache["wheel_depth_source_shape_keys"] = json.dumps(
            [key.name for key in cache.shape_keys.key_blocks] if cache.shape_keys else [],
            ensure_ascii=False,
        )
    else:
        cache.use_fake_user = True
    return cache


def _mesh_topology(mesh):
    """Return the geometry identity that a material-only sail copy must keep."""
    return (
        len(mesh.vertices),
        len(mesh.edges),
        len(mesh.polygons),
        tuple(tuple(poly.vertices) for poly in mesh.polygons),
    )


def _apply_canvas_sail(wheel, side, canvas_material):
    """Rebind a geometry-identical sail copy to the atlas canvas quadrant.

    SourceUV and all shape-key data come from the retained cache.  MaterialUV
    uses fractional repeats of the retained SourceUV where available, so the
    cloth weave stays fine while every sample remains inside the atlas
    upper-right canvas tile.
    """
    cache = _sail_mesh_cache(wheel, side)
    old_data = wheel.data
    sail = cache.copy()
    sail.name = f"{PREFIX}CanvasSailMesh_{side}"
    sail.use_fake_user = False
    if _mesh_topology(sail) != _mesh_topology(cache):
        raise RuntimeError(f"wheel depth: copied sail topology changed for {side}")
    source_layer = sail.uv_layers.get("SourceUV")
    source_uv_preserved = source_layer is not None
    if source_layer is None:
        source_layer = sail.uv_layers.new(name="SourceUV")
        for loop_index, loop in enumerate(sail.loops):
            source_layer.data[loop_index].uv = _generic_source_uv(sail.vertices[loop.vertex_index].co, 10.5)
    material_layer = sail.uv_layers.get("MaterialUV") or sail.uv_layers.new(name="MaterialUV")
    sail_extent = max(
        (math.hypot(float(vertex.co.x), float(vertex.co.z)) for vertex in sail.vertices),
        default=1.0,
    )
    if source_uv_preserved and len(source_layer.data) != len(sail.loops):
        raise RuntimeError(f"wheel depth: source sail SourceUV length changed for {side}")
    use_source_repeat = source_uv_preserved and len(source_layer.data) == len(sail.loops)
    source_values = []
    for loop_index, loop in enumerate(sail.loops):
        if use_source_repeat:
            original_uv = source_layer.data[loop_index].uv
            source = (float(original_uv.x), float(original_uv.y))
            source_values.append(source)
        else:
            source = _generic_source_uv(sail.vertices[loop.vertex_index].co, sail_extent)
        material_layer.data[loop_index].uv = _atlas_uv(source, "canvas")
    material_layer.active = True
    sail.uv_layers.active = material_layer
    sail.materials.clear()
    sail.materials.append(canvas_material)
    for polygon in sail.polygons:
        polygon.material_index = 0
    cache_keys = [key.name for key in cache.shape_keys.key_blocks] if cache.shape_keys else []
    sail_keys = [key.name for key in sail.shape_keys.key_blocks] if sail.shape_keys else []
    if sail_keys != cache_keys:
        raise RuntimeError(f"wheel depth: copied sail shape keys changed for {side}: {cache_keys} -> {sail_keys}")
    wheel.data = sail
    wheel["wheel_depth_canvas_sail"] = True
    wheel["wheel_depth_canvas_quadrant"] = "top-right / MaterialUV u=.5..1 v=.5..1"
    wheel["wheel_depth_original_sail_cache"] = cache.name
    wheel["wheel_depth_sail_geometry_preserved"] = True
    wheel["wheel_depth_sail_shape_keys"] = json.dumps(sail_keys, ensure_ascii=False)
    if old_data is not cache and old_data.name.startswith(f"{PREFIX}CanvasSailMesh_") and old_data.users == 0:
        bpy.data.meshes.remove(old_data)
    return {
        "object": wheel.name,
        "mesh": sail.name,
        "original_cache": cache.name,
        "source_uv": "SourceUV",
        "material_uv": "MaterialUV",
        "atlas_semantic": "canvas",
        "atlas_quad": {"u": list(_quadrant("canvas")[:2]), "v": list(_quadrant("canvas")[2:])},
        "sail_radius_m": round(sail_extent, 6),
        "topology": {
            "vertices": len(sail.vertices),
            "edges": len(sail.edges),
            "polygons": len(sail.polygons),
        },
        "shape_keys": sail_keys,
        "geometry_rebound": False,
        "source_uv_preserved": source_uv_preserved,
        "material_uv_source": "SourceUV fractional repeat" if use_source_repeat else "local X/Z fallback",
        "source_uv_range": {
            "u": [round(min((uv[0] for uv in source_values), default=0.0), 6), round(max((uv[0] for uv in source_values), default=0.0), 6)],
            "v": [round(min((uv[1] for uv in source_values), default=0.0), 6), round(max((uv[1] for uv in source_values), default=0.0), 6)],
        },
    }


def _is_wood_material_name(name):
    normalized = str(name or "").lower()
    return any(token in normalized for token in ("spar", "timber", "walnut", "wood"))


def _spokes_mesh_cache(spokes, side):
    """Keep the unmodified source skeleton as a fake-user mesh cache."""
    cache_name = f"{PREFIX}OriginalSpokesMesh_{side}"
    cache = bpy.data.meshes.get(cache_name)
    if cache is None:
        cache = spokes.data.copy()
        cache.name = cache_name
        cache.use_fake_user = True
        cache["wheel_depth_original_spokes_cache"] = True
        cache["wheel_depth_source_object"] = spokes.name
        cache["wheel_depth_source_uv_layers"] = json.dumps(
            [layer.name for layer in cache.uv_layers], ensure_ascii=False
        )
        cache["wheel_depth_source_shape_keys"] = json.dumps(
            [key.name for key in cache.shape_keys.key_blocks] if cache.shape_keys else [],
            ensure_ascii=False,
        )
    else:
        cache.use_fake_user = True
    return cache


def _apply_spoke_depth(wheel, spokes, side, wood_material, depth_scale=1.35):
    """Thicken the authored swept spoke mesh along wheel-local Y only."""
    cache = _spokes_mesh_cache(spokes, side)
    old_data = spokes.data
    thick = cache.copy()
    thick.name = f"{PREFIX}ThickSpokesMesh_{side}"
    thick.use_fake_user = False
    if _mesh_topology(thick) != _mesh_topology(cache):
        raise RuntimeError(f"wheel depth: copied spoke topology changed for {side}")

    source_to_wheel = wheel.matrix_world.inverted_safe() @ spokes.matrix_world
    wheel_to_source = source_to_wheel.inverted_safe()
    source_points = [source_to_wheel @ vertex.co for vertex in thick.vertices]
    if not source_points:
        raise ValueError(f"wheel depth: source spoke mesh has no vertices for {side}")
    center_y = sum(point.y for point in source_points) / len(source_points)

    def deepen(co):
        point = source_to_wheel @ co
        point.y = center_y + (point.y - center_y) * depth_scale
        return wheel_to_source @ point

    before_depth = [float(point.y) for point in source_points]
    for vertex in thick.vertices:
        vertex.co = deepen(vertex.co)
    if thick.shape_keys:
        for key in thick.shape_keys.key_blocks:
            for vertex in key.data:
                vertex.co = deepen(vertex.co)
    thick.update()

    source_layer = thick.uv_layers.get("SourceUV")
    source_uv_preserved = source_layer is not None and len(source_layer.data) == len(thick.loops)
    if source_layer is not None and not source_uv_preserved:
        raise RuntimeError(f"wheel depth: source spoke SourceUV length changed for {side}")
    if source_layer is None:
        source_layer = thick.uv_layers.new(name="SourceUV")
        extent = max((math.hypot(float(vertex.co.x), float(vertex.co.z)) for vertex in thick.vertices), default=1.0)
        for loop_index, loop in enumerate(thick.loops):
            source_layer.data[loop_index].uv = _generic_source_uv(thick.vertices[loop.vertex_index].co, extent)
    material_layer = thick.uv_layers.get("MaterialUV") or thick.uv_layers.new(name="MaterialUV")

    wood_slot = next((index for index, material in enumerate(thick.materials) if material == wood_material), None)
    if wood_slot is None:
        thick.materials.append(wood_material)
        wood_slot = len(thick.materials) - 1
    wood_polygons = 0
    source_materials = [material.name if material else "" for material in cache.materials]
    for polygon in thick.polygons:
        source_index = polygon.material_index
        source_name = source_materials[source_index] if 0 <= source_index < len(source_materials) else ""
        if not _is_wood_material_name(source_name):
            continue
        polygon.material_index = wood_slot
        wood_polygons += 1
        for loop_index in polygon.loop_indices:
            source_uv = source_layer.data[loop_index].uv
            material_layer.data[loop_index].uv = _atlas_uv((source_uv.x, source_uv.y), "wood")
    if wood_polygons == 0:
        raise RuntimeError(f"wheel depth: no wood polygons found in source spoke mesh for {side}: {source_materials}")
    material_layer.active = True
    thick.uv_layers.active = material_layer

    spokes.data = thick
    spokes["wheel_depth_spoke_source_cache"] = cache.name
    spokes["wheel_depth_spoke_depth_scale"] = float(depth_scale)
    spokes["wheel_depth_spoke_depth_axis"] = "wheel-local Y"
    spokes["wheel_depth_spoke_face_geometry_preserved"] = True
    spokes["wheel_depth_spoke_source_uv_preserved"] = source_uv_preserved
    spokes["wheel_depth_spoke_wood_material"] = wood_material.name

    bevel_name = f"{PREFIX}{side}_OriginalSpokesBevel"
    bevel = spokes.modifiers.get(bevel_name) or spokes.modifiers.new(bevel_name, "BEVEL")
    bevel.width = 0.06
    bevel.segments = 2
    bevel.limit_method = "ANGLE"

    after_points = [source_to_wheel @ vertex.co for vertex in thick.vertices]
    after_depth = [float(point.y) for point in after_points]
    if old_data is not cache and old_data.name.startswith(f"{PREFIX}ThickSpokesMesh_") and old_data.users == 0:
        bpy.data.meshes.remove(old_data)
    return {
        "object": spokes.name,
        "mesh": thick.name,
        "original_cache": cache.name,
        "source_materials": source_materials,
        "wood_material": wood_material.name,
        "wood_polygons": wood_polygons,
        "source_uv": "SourceUV",
        "material_uv": "MaterialUV",
        "source_uv_preserved": source_uv_preserved,
        "depth_axis": "wheel-local Y",
        "depth_scale": depth_scale,
        "depth_before_m": [round(min(before_depth), 6), round(max(before_depth), 6)],
        "depth_after_m": [round(min(after_depth), 6), round(max(after_depth), 6)],
        "face_geometry_preserved": True,
        "topology": {
            "vertices": len(thick.vertices),
            "edges": len(thick.edges),
            "polygons": len(thick.polygons),
        },
        "shape_keys": [key.name for key in thick.shape_keys.key_blocks] if thick.shape_keys else [],
        "bevel": {"name": bevel.name, "width_m": bevel.width, "segments": bevel.segments},
    }


def _generic_source_uv(co, extent):
    extent = max(float(extent), 1.0e-6)
    return (
        max(0.0, min(1.0, 0.5 + float(co.x) / (2.0 * extent))),
        max(0.0, min(1.0, 0.5 + float(co.z) / (2.0 * extent))),
    )


def _atlas_uv_clamped(uv, semantic):
    """Map an already-unwrapped UV into an atlas tile without wrapping it."""
    u0, u1, v0, v1 = _quadrant(semantic)
    u = max(0.0, min(1.0, float(uv[0])))
    v = max(0.0, min(1.0, float(uv[1])))
    return (
        u0 + (u1 - u0) * u,
        v0 + (v1 - v0) * v,
    )


def _circumference_u(co):
    """Return a stable [0, 1] circular coordinate in the wheel X/Z face."""
    return (math.atan2(float(co.z), float(co.x)) % math.tau) / math.tau


def _hardware_material_uvs(mesh, extent, semantic):
    """Build per-loop UVs for new hub hardware.

    End caps retain the original X/Z projection.  Faces whose local normal is
    perpendicular to wheel-local Y are side walls, so they use circular U and
    wheel-depth V.  UVs are per-loop rather than per-vertex: this lets a seam
    at angle 0/2π open without changing vertices or geometry.
    """
    vertices = mesh.vertices
    y_min = min((float(vertex.co.y) for vertex in vertices), default=0.0)
    y_max = max((float(vertex.co.y) for vertex in vertices), default=1.0)
    y_span = y_max - y_min
    values = [None] * len(mesh.loops)

    for polygon in mesh.polygons:
        loop_indices = list(polygon.loop_indices)
        if abs(float(polygon.normal.y)) >= 0.9:
            for loop_index in loop_indices:
                co = vertices[mesh.loops[loop_index].vertex_index].co
                values[loop_index] = _atlas_uv(_generic_source_uv(co, extent), semantic)
            continue

        # Unwrap this face locally.  Only the final segment around the circle
        # crosses the seam; shifting its low-angle loops to 1 keeps every
        # sample inside the same atlas quadrant and avoids a full-tile stretch.
        raw_u = {
            loop_index: _circumference_u(vertices[mesh.loops[loop_index].vertex_index].co)
            for loop_index in loop_indices
        }
        if raw_u and max(raw_u.values()) - min(raw_u.values()) > 0.5:
            raw_u = {
                loop_index: (value + 1.0 if value < 0.5 else value)
                for loop_index, value in raw_u.items()
            }
        for loop_index in loop_indices:
            co = vertices[mesh.loops[loop_index].vertex_index].co
            depth_v = (float(co.y) - y_min) / y_span if abs(y_span) > 1.0e-8 else 0.5
            values[loop_index] = _atlas_uv_clamped((raw_u[loop_index], depth_v), semantic)

    if any(value is None for value in values):
        raise RuntimeError("wheel depth: hardware UV mapper left an unassigned loop")
    return values


def _write_hardware_material_uv(mesh, extent, semantic):
    """Write only MaterialUV using the shared cap/side mapper."""
    material_layer = mesh.uv_layers.get("MaterialUV") or mesh.uv_layers.new(name="MaterialUV")
    values = _hardware_material_uvs(mesh, extent, semantic)
    for loop_index, value in enumerate(values):
        material_layer.data[loop_index].uv = value
    material_layer.active = True
    mesh.uv_layers.active = material_layer
    return material_layer


def _uv_mesh_signature(mesh):
    """Capture geometry identity for a read-only-before/after UV audit."""
    return (
        tuple(tuple(round(float(value), 8) for value in vertex.co) for vertex in mesh.vertices),
        tuple(tuple(int(index) for index in polygon.vertices) for polygon in mesh.polygons),
    )


def _uv_layer_signature(layer):
    if layer is None:
        return None
    return tuple(
        (round(float(item.uv.x), 8), round(float(item.uv.y), 8))
        for item in layer.data
    )


def _material_uv_stats(obj):
    """Report side/cap triangle UV density using the same check threshold."""
    mesh = obj.data
    layer = mesh.uv_layers.get("MaterialUV")
    if layer is None:
        return {"triangles": 0, "side_triangles": 0, "cap_triangles": 0, "side_degenerate": 0, "cap_degenerate": 0}
    mesh.calc_loop_triangles()
    result = {
        "triangles": 0,
        "side_triangles": 0,
        "cap_triangles": 0,
        "side_degenerate": 0,
        "cap_degenerate": 0,
    }
    for triangle in mesh.loop_triangles:
        positions = [mesh.vertices[index].co for index in triangle.vertices]
        edge_a = positions[1] - positions[0]
        edge_b = positions[2] - positions[0]
        area = edge_a.cross(edge_b).length
        if area < 1.0e-4:
            continue
        uvs = [layer.data[index].uv for index in triangle.loops]
        delta_a = uvs[1] - uvs[0]
        delta_b = uvs[2] - uvs[0]
        uv_area = abs(float(delta_a.x * delta_b.y - delta_a.y * delta_b.x))
        polygon = mesh.polygons[triangle.polygon_index]
        side = abs(float(polygon.normal.y)) < 0.9
        result["triangles"] += 1
        result["side_triangles" if side else "cap_triangles"] += 1
        if uv_area / area <= 1.0e-7:
            result["side_degenerate" if side else "cap_degenerate"] += 1
    return result


def refine_hardware_material_uv(scene):
    """Repair only MaterialUV on owned hub hardware, in memory.

    ``SourceUV``, vertex positions, polygon topology, wheel roots, retained
    sails, and source spokes are intentionally untouched.  The function is
    safe to call after loading an already-exported production blend and
    returns a serialisable audit; it never saves or exports.
    """
    if scene is None:
        raise ValueError("wheel depth: refine_hardware_material_uv requires a scene")
    targets = sorted(
        (
            obj
            for obj in scene.objects
            if obj.type == "MESH" and obj.name.startswith(PREFIX) and obj.get("wheel_depth_owned")
        ),
        key=lambda obj: obj.name,
    )
    reports = []
    for obj in targets:
        mesh = obj.data
        material = next((item for item in mesh.materials if item), None)
        semantic = str(obj.get("atlas_semantic") or "").lower()
        if semantic not in ATLAS_METADATA["quadrants"] and material is not None:
            semantic = str(material.name.rsplit("_", 1)[-1]).lower()
        if semantic not in ATLAS_METADATA["quadrants"]:
            reports.append({"object": obj.name, "skipped": True, "reason": "unknown atlas semantic"})
            continue
        extent = max(
            (math.hypot(float(vertex.co.x), float(vertex.co.z)) for vertex in mesh.vertices),
            default=1.0,
        )
        geometry_before = _uv_mesh_signature(mesh)
        source_before = _uv_layer_signature(mesh.uv_layers.get("SourceUV"))
        material_before = _uv_layer_signature(mesh.uv_layers.get("MaterialUV"))
        stats_before = _material_uv_stats(obj)
        _write_hardware_material_uv(mesh, extent, semantic)
        geometry_after = _uv_mesh_signature(mesh)
        source_after = _uv_layer_signature(mesh.uv_layers.get("SourceUV"))
        material_after = _uv_layer_signature(mesh.uv_layers.get("MaterialUV"))
        stats_after = _material_uv_stats(obj)
        geometry_preserved = geometry_before == geometry_after
        source_uv_preserved = source_before == source_after
        if not geometry_preserved or not source_uv_preserved:
            raise RuntimeError(f"wheel depth: hardware UV pass changed source data for {obj.name}")
        reports.append({
            "object": obj.name,
            "semantic": semantic,
            "material": material.name if material is not None else None,
            "geometry_preserved": geometry_preserved,
            "source_uv_preserved": source_uv_preserved,
            "material_uv_changed": material_before != material_after,
            "before": stats_before,
            "after": stats_after,
        })
    return {
        "schema": "maple.sky-voyage.wheel-depth-hardware-uv-report.v1",
        "target_count": len(targets),
        "reports": reports,
        "geometry_changed": False,
        "source_uv_changed": False,
        "export_performed": False,
    }


def _mesh_object(scene, wheel, name, vertices, faces, material, extent, bevel=0.0, source_uv=None):
    mesh = bpy.data.meshes.new(name + "_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    mesh.materials.append(material)
    source_layer = mesh.uv_layers.new(name="SourceUV")
    material_layer = mesh.uv_layers.new(name="MaterialUV")
    for loop_index, loop in enumerate(mesh.loops):
        co = mesh.vertices[loop.vertex_index].co
        source = source_uv[loop_index] if source_uv else _generic_source_uv(co, extent)
        source_layer.data[loop_index].uv = source
    semantic = material.name.rsplit("_", 1)[-1].lower()
    _write_hardware_material_uv(mesh, extent, semantic)
    collection = next(iter(wheel.users_collection), scene.collection)
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    obj.parent = wheel
    obj.matrix_parent_inverse = Matrix.Identity(4)
    obj.location = (0.0, 0.0, 0.0)
    obj["wheel_depth_owned"] = True
    obj["wheel_depth_parent"] = wheel.name
    obj["wheel_face_axes"] = "Blender X/Z; runtime X/Y"
    obj["wheel_depth_axis"] = "Blender Y; runtime Z"
    obj["source_uv_layer"] = "SourceUV"
    obj["material_uv_layer"] = "MaterialUV"
    obj["atlas_semantic"] = material.name.rsplit("_", 1)[-1].lower()
    if bevel:
        modifier = obj.modifiers.new("Wheel depth softened edges", "BEVEL")
        modifier.width = bevel
        modifier.segments = 2
        modifier.limit_method = "ANGLE"
    return obj


def _annulus(vertices, faces, inner, outer, y_min, y_max, segments=48):
    start = len(vertices)
    for y in (y_min, y_max):
        for radius in (inner, outer):
            for index in range(segments):
                angle = math.tau * index / segments
                vertices.append((radius * math.cos(angle), y, radius * math.sin(angle)))
    # Layer order: front-inner, front-outer, back-inner, back-outer.
    fi, fo, bi, bo = [start + layer * segments for layer in range(4)]
    for index in range(segments):
        nxt = (index + 1) % segments
        faces.extend([
            (fi + index, fo + index, fo + nxt, fi + nxt),
            (bi + nxt, bo + nxt, bo + index, bi + index),
            (fo + index, bo + index, bo + nxt, fo + nxt),
            (bi + nxt, fi + nxt, fi + index, bi + index),
        ])


def _cylinder_y(vertices, faces, radius, y_min, y_max, segments=32):
    start = len(vertices)
    for y in (y_min, y_max):
        for index in range(segments):
            angle = math.tau * index / segments
            vertices.append((radius * math.cos(angle), y, radius * math.sin(angle)))
    faces.append(tuple(start + index for index in reversed(range(segments))))
    faces.append(tuple(start + segments + index for index in range(segments)))
    for index in range(segments):
        nxt = (index + 1) % segments
        faces.append((start + index, start + nxt, start + segments + nxt, start + segments + index))


def _add_wheel(scene, side, materials):
    wheel = scene.objects.get(f"SV3_Wheel_{side}")
    spokes = scene.objects.get(f"SV3_Wheel_{side}_TimberSpokesAndHub")
    if wheel is None or spokes is None:
        raise KeyError(f"wheel depth: missing retained wheel or spoke root for {side}")
    _refresh_wheel_matrices(wheel, spokes)
    canvas_report = _apply_canvas_sail(wheel, side, materials["canvas"])
    spoke_report = _apply_spoke_depth(wheel, spokes, side, materials["wood"])
    points = _local_source_points(wheel, spokes)
    source_spoke_radius = max(
        (math.hypot(float(point.x), float(point.z)) for point in points),
        default=1.0,
    )
    source_sail_radius = max(
        (math.hypot(float(vertex.co.x), float(vertex.co.z)) for vertex in wheel.data.vertices),
        default=1.0,
    )
    wheel_radius = max(source_spoke_radius, source_sail_radius)
    uv_extent = max(wheel_radius, 1.0)
    report = {
        "side": side,
        "wheel": wheel.name,
        "parent": wheel.name,
        "source_radius_m": round(source_spoke_radius, 6),
        "source_spoke_envelope_radius_m": round(source_spoke_radius, 6),
        "source_sail_radius_m": round(source_sail_radius, 6),
        "source_shape_keys": [key.name for key in wheel.data.shape_keys.key_blocks] if wheel.type == "MESH" and wheel.data.shape_keys else [],
        "canvas_sail": canvas_report,
        "source_spokes": spoke_report,
        "added_meshes": [],
    }

    def add(name, vertices, faces, material, bevel=0.0):
        obj = _mesh_object(scene, wheel, f"{PREFIX}{side}_{name}", vertices, faces, material, uv_extent, bevel)
        report["added_meshes"].append(obj.name)
        return obj

    # Keep the hub readable as layered hardware.  The brass pieces are open
    # annuli; smaller navy caps protrude through their openings, so no solid
    # gold disk hides the authored sail or the eight source-directed bars.
    hub_ring_inner = 1.82
    hub_ring_outer = 2.58
    for label, center_y in (("HubBrassRingFront", -0.50), ("HubBrassRingRear", 0.50)):
        vertices, faces = [], []
        _annulus(vertices, faces, hub_ring_inner, hub_ring_outer, center_y - 0.16, center_y + 0.16)
        add(label, vertices, faces, materials["brass"], bevel=0.055)
    for label, y_min, y_max in (("HubNavyCapFront", -0.88, -0.56), ("HubNavyCapRear", 0.56, 0.88)):
        vertices, faces = [], []
        _cylinder_y(vertices, faces, 1.58, y_min, y_max)
        add(label, vertices, faces, materials["navy"], bevel=0.075)
    vertices, faces = [], []
    _cylinder_y(vertices, faces, 0.78, -0.96, 0.96)
    add("HubAxleSleeve", vertices, faces, materials["navy"], bevel=0.075)

    # The source TimberSpokesAndHub already contains the authored swept blade
    # directions.  Its depth was widened in-place above; adding another set of
    # straight bars or straight rear braces would create the visible 16-spoke
    # artifact, so no radial replacement geometry is generated here.
    report["hub_ring_inner_radius_m"] = hub_ring_inner
    report["hub_ring_outer_radius_m"] = hub_ring_outer
    report["outer_frame_removed"] = True
    report["frame_connectors_removed"] = True
    report["straight_spokes_generated"] = False
    report["straight_back_supports_generated"] = False
    report["depth_min_m"] = -0.96
    report["depth_max_m"] = 0.96
    report["overall_depth_m"] = 1.92
    report["added_mesh_count"] = len(report["added_meshes"])
    report["source_direction_method"] = "retained TimberSpokesAndHub geometry"
    report["retained_sail_geometry_unchanged"] = True
    report["retained_sail_material_rebound"] = True
    return report


def apply(scene):
    """Create the wheel depth pass and return a serialisable audit report."""
    if not ATLAS_PATH.exists():
        raise FileNotFoundError(ATLAS_PATH)
    try:
        bpy.context.view_layer.update()
    except (AttributeError, RuntimeError):
        pass
    _delete_owned_objects(scene)
    atlas = bpy.data.images.load(str(ATLAS_PATH), check_existing=True)
    atlas.colorspace_settings.name = "sRGB"
    materials = {name: _material(name.title(), atlas, name) for name in _MATERIAL_SPECS}
    reports = [_add_wheel(scene, side, materials) for side in ("Port", "Starboard")]
    hardware_uv_report = refine_hardware_material_uv(scene)
    report = {
        "schema": "maple.sky-voyage.wheel-depth-report.v1",
        "prefix": PREFIX,
        "atlas": ATLAS_METADATA,
        "face_axes": "Blender X/Z; runtime X/Y",
        "depth_axis": "Blender Y; runtime Z",
        "wheels": reports,
        "original_wheels_modified": False,
        "original_sail_geometry_modified": False,
        "original_sail_source_uv_modified": False,
        "original_sail_shape_keys_modified": False,
        "canvas_sail_material_bound": True,
        "original_spokes_source_geometry_modified": False,
        "active_spokes_depth_copy": True,
        "original_supports_modified": False,
        "hardware_material_uv": hardware_uv_report,
        "export_performed": False,
    }
    scene["wheel_depth_revision"] = "2026-10-05: retained swept spokes thickened on wheel-local Y, layered hub, canvas SourceUV repeat"
    scene["wheel_depth_atlas_metadata"] = json.dumps(ATLAS_METADATA, ensure_ascii=False, sort_keys=True)
    scene["wheel_depth_report"] = json.dumps(report, ensure_ascii=False, sort_keys=True)
    return report
