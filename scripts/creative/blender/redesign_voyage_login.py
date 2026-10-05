"""Independent fairytale login-sign detail recipe for Sky Voyage.

The production login sign is already a child of ``SV2_Ship`` and is rotated
by the source asset.  The measured source plane is sign-local X/Z, with the
reader on local -Y.  This recipe keeps that transform and the existing
``SV3_LoginSurface`` anchor untouched.  It only adds prefixed detail nodes,
creates the three stable redesign materials, and hides the coarse legacy
corner caps while retaining them in the source hierarchy.

The recipe intentionally does not open, save, export, or pack a blend file.
The caller owns the production source and can inspect the returned audit
before saving the integrated asset.
"""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
from typing import Mapping, Sequence

import bpy
from mathutils import Matrix, Vector


ROOT = Path(__file__).resolve().parents[3]
REFERENCE = ROOT / "resources/scenes/sky-voyage-v3/prototypes/login-fairytale-redesign.png"
PREFIX = "SV3_LoginRedesign_"
ROOT_NAME = PREFIX + "Root"
LAMP_SOURCE_ROOT = "SV3_CabinLamp_0"
MAPLE_DECAL_MATERIAL = "SV3_MainSail_MapleDecal"
MAPLE_DECAL_IMAGE = "maple-crest.png"


def _descendant(obj: bpy.types.Object, ancestor: bpy.types.Object) -> bool:
    """Return whether ``obj`` is a child of ``ancestor`` at any depth."""

    current = obj.parent
    while current is not None:
        if current == ancestor:
            return True
        current = current.parent
    return False


def _source_mesh_fingerprint(scene: bpy.types.Scene, sign: bpy.types.Object) -> str:
    """Hash source sign mesh data without including recipe-generated nodes."""

    records = []
    for obj in sorted(scene.objects, key=lambda item: item.name):
        if obj.type != "MESH" or obj.name.startswith(PREFIX) or not _descendant(obj, sign):
            continue
        verts = tuple(
            tuple(round(float(value), 8) for value in vertex.co)
            for vertex in obj.data.vertices
        )
        polys = tuple(tuple(int(index) for index in polygon.vertices) for polygon in obj.data.polygons)
        matrix = tuple(round(float(value), 8) for row in obj.matrix_local for value in row)
        records.append((obj.name, obj.parent.name if obj.parent else None, matrix, verts, polys))
    payload = repr(tuple(records)).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _remove_previous_recipe(scene: bpy.types.Scene) -> None:
    """Delete only this recipe's prior generated hierarchy for idempotence."""

    # Archived legacy lamps deliberately keep the recipe prefix so their
    # provenance remains obvious in the exported source.  They are hidden and
    # skipped here; all live recipe nodes are safe to rebuild.
    generated = [
        obj
        for obj in scene.objects
        if obj.name.startswith(PREFIX) and not obj.get("SV3_LoginRedesign_archive", False)
    ]
    # Children first keeps Blender's parent pointers clean while deleting an
    # old root and makes a second call produce the same object names/counts.
    generated.sort(key=lambda obj: len(obj.children_recursive))
    for obj in generated:
        if obj.name in bpy.data.objects:
            bpy.data.objects.remove(obj, do_unlink=True)


def _ensure_pbr(
    name: str,
    color: Sequence[float],
    roughness: float,
    metallic: float = 0.0,
) -> bpy.types.Material:
    """Create or update a small, stable Principled material."""

    material = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    material.use_nodes = True
    material.diffuse_color = (*color, 1.0)
    material["recipe"] = "redesign_voyage_login"
    material["role"] = name.removeprefix(PREFIX)
    shader = next(
        (node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED"),
        None,
    )
    if shader is None:
        shader = material.node_tree.nodes.new("ShaderNodeBsdfPrincipled")
    shader.inputs["Base Color"].default_value = (*color, 1.0)
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metallic
    # These sockets exist in Blender 4/5 and are harmlessly optional for
    # older source files opened by the recipe.
    if shader.inputs.get("Coat Weight") is not None:
        shader.inputs["Coat Weight"].default_value = 0.12 if metallic else 0.04
    if shader.inputs.get("Coat Roughness") is not None:
        shader.inputs["Coat Roughness"].default_value = 0.22
    return material


def _existing_or_fallback(
    name: str,
    fallback_name: str,
    fallback_color: Sequence[float],
) -> bpy.types.Material:
    material = bpy.data.materials.get(name)
    if material is not None:
        return material
    return _ensure_pbr(fallback_name, fallback_color, 0.68, 0.04)


def _attach_local(obj: bpy.types.Object, parent: bpy.types.Object) -> None:
    """Attach an object while retaining its authored parent-local coordinates."""

    obj.parent = parent
    obj.matrix_parent_inverse = Matrix.Identity(4)
    obj.matrix_world = parent.matrix_world.copy()


def _bevel(obj: bpy.types.Object, amount: float, segments: int = 2) -> None:
    if amount <= 0.0:
        return
    modifier = obj.modifiers.new(name="Crafted edge bevel", type="BEVEL")
    modifier.width = amount
    modifier.segments = segments
    modifier.limit_method = "ANGLE"


def _mesh(
    scene: bpy.types.Scene,
    parent: bpy.types.Object,
    name: str,
    vertices: Sequence[Sequence[float]],
    faces: Sequence[Sequence[int]],
    material: bpy.types.Material,
    bevel: float = 0.0,
) -> bpy.types.Object:
    data = bpy.data.meshes.new(name + "_Mesh")
    data.from_pydata(vertices, [], faces)
    data.update()
    data.materials.append(material)
    obj = bpy.data.objects.new(name, data)
    scene.collection.objects.link(obj)
    _attach_local(obj, parent)
    _bevel(obj, bevel)
    return obj


def _box(
    scene: bpy.types.Scene,
    parent: bpy.types.Object,
    name: str,
    center: Sequence[float],
    size: Sequence[float],
    material: bpy.types.Material,
    bevel: float = 0.0,
) -> bpy.types.Object:
    cx, cy, cz = center
    sx, sy, sz = (value / 2.0 for value in size)
    vertices = [
        (cx + dx * sx, cy + dy * sy, cz + dz * sz)
        for dz in (-1.0, 1.0)
        for dy in (-1.0, 1.0)
        for dx in (-1.0, 1.0)
    ]
    faces = (
        (0, 2, 3, 1),
        (4, 5, 7, 6),
        (0, 1, 5, 4),
        (2, 6, 7, 3),
        (0, 4, 6, 2),
        (1, 3, 7, 5),
    )
    return _mesh(scene, parent, name, vertices, faces, material, bevel)


def _plate(
    scene: bpy.types.Scene,
    parent: bpy.types.Object,
    name: str,
    outline_xz: Sequence[Sequence[float]],
    front_y: float,
    thickness: float,
    material: bpy.types.Material,
    bevel: float = 0.0,
) -> bpy.types.Object:
    """Make an extruded X/Z plate, front-facing local -Y."""

    outline = [(float(point[0]), float(point[1])) for point in outline_xz]
    count = len(outline)
    vertices = [(x, front_y, z) for x, z in outline]
    vertices += [(x, front_y + thickness, z) for x, z in outline]
    faces = [tuple(range(count - 1, -1, -1)), tuple(range(count, count * 2))]
    faces.extend(
        (index, (index + 1) % count, (index + 1) % count + count, index + count)
        for index in range(count)
    )
    return _mesh(scene, parent, name, vertices, faces, material, bevel)


def _strip(
    scene: bpy.types.Scene,
    parent: bpy.types.Object,
    name: str,
    path_xz: Sequence[Sequence[float]],
    width: float,
    front_y: float,
    thickness: float,
    material: bpy.types.Material,
    bevel: float = 0.0,
) -> bpy.types.Object:
    """Make a flat ribbon following a path in local X/Z."""

    points = [(float(point[0]), float(point[1])) for point in path_xz]
    half = width / 2.0
    front = []
    for index, (x, z) in enumerate(points):
        previous = points[max(0, index - 1)]
        following = points[min(len(points) - 1, index + 1)]
        tangent_x = following[0] - previous[0]
        tangent_z = following[1] - previous[1]
        length = math.hypot(tangent_x, tangent_z) or 1.0
        normal_x = -tangent_z / length
        normal_z = tangent_x / length
        front.append((x + normal_x * half, front_y, z + normal_z * half))
        front.append((x - normal_x * half, front_y, z - normal_z * half))
    vertices = list(front) + [(x, y + thickness, z) for x, y, z in front]
    side_faces = []
    for index in range(len(points) - 1):
        left = index * 2
        right = left + 1
        next_left = left + 2
        next_right = left + 3
        side_faces.append((left, next_left, next_right, right))
        side_faces.append((left + len(front), right + len(front), next_right + len(front), next_left + len(front)))
        side_faces.append((left, right, right + len(front), left + len(front)))
        side_faces.append((next_left, next_left + len(front), next_right + len(front), next_right))
    side_faces.append((0, len(front), len(front) + 1, 1))
    last = len(front) - 2
    side_faces.append((last, last + 1, last + 1 + len(front), last + len(front)))
    return _mesh(scene, parent, name, vertices, side_faces, material, bevel)


def _tube(
    scene: bpy.types.Scene,
    parent: bpy.types.Object,
    name: str,
    path_xyz: Sequence[Sequence[float]],
    material: bpy.types.Material,
    radius: float = 0.045,
) -> bpy.types.Object:
    """Make a small rounded decorative cord with a local poly spline."""

    curve = bpy.data.curves.new(name + "_Curve", type="CURVE")
    curve.dimensions = "3D"
    curve.resolution_u = 2
    curve.bevel_depth = radius
    curve.bevel_resolution = 3
    curve.use_fill_caps = True
    spline = curve.splines.new("POLY")
    spline.points.add(max(0, len(path_xyz) - 1))
    for point, coordinate in zip(spline.points, path_xyz):
        point.co = (float(coordinate[0]), float(coordinate[1]), float(coordinate[2]), 1.0)
    obj = bpy.data.objects.new(name, curve)
    scene.collection.objects.link(obj)
    obj.data.materials.append(material)
    _attach_local(obj, parent)
    # The production exporter intentionally selects meshes and anchors only.
    # Bake this generated cord to a mesh so its scrollwork survives in GLB.
    bpy.context.view_layer.update()
    graph = bpy.context.evaluated_depsgraph_get()
    data = bpy.data.meshes.new_from_object(obj.evaluated_get(graph), depsgraph=graph)
    bpy.data.objects.remove(obj, do_unlink=True)
    bpy.data.curves.remove(curve)
    mesh = bpy.data.objects.new(name, data)
    scene.collection.objects.link(mesh)
    _attach_local(mesh, parent)
    return mesh


def _spiral_path(center_x: float, z_min: float, z_max: float, side: float) -> list[tuple[float, float, float]]:
    """A restrained double curl for the two side pillars."""

    points: list[tuple[float, float, float]] = []
    for index in range(25):
        t = index / 24.0
        z = z_min + (z_max - z_min) * t
        curl = math.sin(t * math.pi * 3.2) * 0.07
        points.append((center_x + side * curl, -0.53, z))
    return points


def _leaf_outline(center_x: float, center_z: float, scale: float = 1.0, side: float = 1.0) -> list[tuple[float, float]]:
    """Small pointed leaf used on teal insets and the lower corners."""

    points = [
        (0.0, 0.52),
        (-0.16, 0.18),
        (-0.44, 0.14),
        (-0.24, -0.06),
        (-0.32, -0.34),
        (0.0, -0.18),
        (0.32, -0.34),
        (0.24, -0.06),
        (0.44, 0.14),
        (0.16, 0.18),
    ]
    return [(center_x + side * x * scale, center_z + z * scale) for x, z in points]


def _find_surface(sign: bpy.types.Object) -> tuple[bpy.types.Object, dict[str, float]]:
    surface = bpy.data.objects.get("SV3_LoginSurface")
    if surface is None or not _descendant(surface, sign):
        raise ValueError("SV3_LoginSurface must remain a child of SV2_LoginSign")
    if surface.parent != sign:
        raise ValueError("SV3_LoginSurface must remain directly parented to SV2_LoginSign")
    if sum(abs(float(value)) for value in surface.rotation_euler) > 1e-6 or any(abs(value - 1.0) > 1e-6 for value in surface.scale):
        raise ValueError("SV3_LoginSurface source transform is not the measured identity plane")
    width = float(surface.get("width", 0.0))
    height = float(surface.get("height", 0.0))
    if width <= 0.0 or height <= 0.0:
        raise ValueError("SV3_LoginSurface must expose positive width and height metadata")
    center_x = float(surface.location.x)
    center_z = float(surface.location.z)
    return surface, {
        "center_x": center_x,
        "center_z": center_z,
        "width": width,
        "height": height,
        "min_x": center_x - width / 2.0,
        "max_x": center_x + width / 2.0,
        "min_z": center_z - height / 2.0,
        "max_z": center_z + height / 2.0,
    }


def _hide_legacy_caps(sign: bpy.types.Object) -> list[str]:
    """Hide only coarse legacy corner pieces, retaining them as source records."""

    hidden: list[str] = []
    for obj in sign.children_recursive:
        if obj.name == "SV3_Board_MapleCrest" or obj.name.startswith("SV3_Board_Strap_"):
            obj.hide_viewport = True
            obj.hide_render = True
            obj["SV3_LoginRedesign_legacy_preserved"] = True
            obj["SV3_LoginRedesign_replaced_by"] = "SV3_LoginRedesign_*"
            hidden.append(obj.name)
    return sorted(hidden)


def _archive_legacy_login_lamps(scene: bpy.types.Scene, sign: bpy.types.Object) -> list[str]:
    """Hide old login lamps while keeping their source objects for provenance.

    Two generations are present in production sources: the old ``SV3_Board``
    lamp assembly and the first redesign's six box/pennant meshes.  Both are
    archived in-place under the sign before the live recipe hierarchy is
    rebuilt.  Cabin lamps are never selected because they are outside the
    login-sign subtree.  The archive flag also makes a second recipe run
    idempotent: archived objects survive cleanup but are never archived again.
    """

    recipe_root = bpy.data.objects.get(ROOT_NAME)
    candidates: list[bpy.types.Object] = []
    for obj in scene.objects:
        if obj.get("SV3_LoginRedesign_archive", False):
            continue
        if not _descendant(obj, sign):
            continue
        is_board_lamp = obj.name.startswith("SV3_Board_Lantern")
        is_old_redesign = (
            recipe_root is not None
            and _descendant(obj, recipe_root)
            and obj.name.startswith(PREFIX)
            and ("_Lantern_" in obj.name or "_Pennant_" in obj.name)
            and not obj.get("SV3_LoginRedesign_source_lamp_clone", False)
        )
        if is_board_lamp or is_old_redesign:
            candidates.append(obj)

    candidate_set = set(candidates)
    roots = [obj for obj in candidates if obj.parent not in candidate_set]
    archived: list[str] = []

    def archive_tree(obj: bpy.types.Object, original_name: str | None = None) -> None:
        original = original_name or obj.name
        old_world = obj.matrix_world.copy()
        # Keep the prefix so an exported source makes the replacement clear;
        # _remove_previous_recipe skips the archive flag on future runs.
        base_name = PREFIX + "Archive_" + original.removeprefix(PREFIX)
        archive_name = base_name
        suffix = 1
        while archive_name in bpy.data.objects and bpy.data.objects.get(archive_name) != obj:
            suffix += 1
            archive_name = f"{base_name}_{suffix}"
        obj.name = archive_name
        obj.parent = sign
        obj.matrix_parent_inverse = Matrix.Identity(4)
        obj.matrix_world = old_world
        obj.hide_viewport = True
        obj.hide_render = True
        obj["SV3_LoginRedesign_archive"] = True
        obj["SV3_LoginRedesign_legacy_preserved"] = True
        obj["SV3_LoginRedesign_original_name"] = original
        obj["SV3_LoginRedesign_replaced_by"] = PREFIX + "Lantern_*"
        archived.append(obj.name)
        for child in list(obj.children):
            archive_tree(child, child.name)

    for obj in roots:
        archive_tree(obj)
    return sorted(archived)


def _surface_keepout_violations(
    root: bpy.types.Object,
    surface: bpy.types.Object,
    keepout: Mapping[str, float],
) -> list[str]:
    """Find front-facing generated relief that enters the DOM rectangle."""

    violations: list[str] = []
    for obj in root.children_recursive:
        if obj.name.endswith("IvoryPaperBacking") or obj.type not in {"MESH", "CURVE"}:
            continue
        corners = tuple(obj.bound_box)
        if not corners:
            continue
        min_x = min(float(corner[0]) for corner in corners)
        max_x = max(float(corner[0]) for corner in corners)
        min_y = min(float(corner[1]) for corner in corners)
        min_z = min(float(corner[2]) for corner in corners)
        max_z = max(float(corner[2]) for corner in corners)
        overlaps_x = min_x < keepout["max_x"] and max_x > keepout["min_x"]
        overlaps_z = min_z < keepout["max_z"] and max_z > keepout["min_z"]
        is_in_front = min_y <= float(surface.location.y) + 0.005
        if overlaps_x and overlaps_z and is_in_front:
            violations.append(obj.name)
    return sorted(violations)


def _local_bounds(obj: bpy.types.Object) -> dict[str, list[float]] | None:
    """Return an authored object's local bounds for the integration audit."""

    corners = tuple(obj.bound_box)
    if not corners:
        return None
    minimum = [min(float(corner[index]) for corner in corners) for index in range(3)]
    maximum = [max(float(corner[index]) for corner in corners) for index in range(3)]
    return {
        "min": [round(value, 4) for value in minimum],
        "max": [round(value, 4) for value in maximum],
        "dimensions": [round(maximum[index] - minimum[index], 4) for index in range(3)],
    }


def _find_maple_decal() -> tuple[bpy.types.Material, bpy.types.Image]:
    """Return the authored sail decal material and its exact source image."""

    material = bpy.data.materials.get(MAPLE_DECAL_MATERIAL)
    if material is None:
        raise ValueError(f"{MAPLE_DECAL_MATERIAL} is missing from the source blend")
    image = bpy.data.images.get(MAPLE_DECAL_IMAGE)
    if image is None:
        raise ValueError(f"{MAPLE_DECAL_IMAGE} is missing from the source blend")

    image_nodes = [
        node
        for node in material.node_tree.nodes
        if node.type == "TEX_IMAGE" and node.image is not None
    ]
    if not any(node.image == image for node in image_nodes):
        raise ValueError(
            f"{MAPLE_DECAL_MATERIAL} does not reference the exact {MAPLE_DECAL_IMAGE} image"
        )
    uv_maps = [
        node.uv_map
        for node in material.node_tree.nodes
        if node.type == "UVMAP" and node.uv_map
    ]
    if "Emblem" not in uv_maps:
        raise ValueError(f"{MAPLE_DECAL_MATERIAL} must sample the Emblem UV map")
    return material, image


def _add_emblem_uv(obj: bpy.types.Object) -> None:
    """Map a front-facing square's local X/Z into the authored Emblem UV."""

    if obj.type != "MESH":
        raise TypeError("Emblem UVs require a mesh object")
    mesh = obj.data
    uv_layer = mesh.uv_layers.get("Emblem") or mesh.uv_layers.new(name="Emblem")
    coordinates = [(float(vertex.co.x), float(vertex.co.z)) for vertex in mesh.vertices]
    min_x = min(point[0] for point in coordinates)
    max_x = max(point[0] for point in coordinates)
    min_z = min(point[1] for point in coordinates)
    max_z = max(point[1] for point in coordinates)
    width = max_x - min_x or 1.0
    height = max_z - min_z or 1.0
    for loop in mesh.loops:
        x, z = coordinates[loop.vertex_index]
        uv_layer.data[loop.index].uv = ((x - min_x) / width, (z - min_z) / height)
    mesh.update()
    obj["SV3_LoginRedesign_uv_role"] = "Emblem"
    obj["SV3_LoginRedesign_uv_projection"] = "local X/Z normalized 0..1"


def _clone_cabin_lamp(
    scene: bpy.types.Scene,
    parent: bpy.types.Object,
    side: float,
    target_z: float = 6.15,
) -> list[bpy.types.Object]:
    """Clone the complete authored cabin-lamp tree with shared data.

    The source root remains under ``SV3_CabinInterior``.  Only object shells
    are copied; mesh data, materials, and the lamp's exact 12-child geometry
    are shared with the production source so the login lamps cannot drift
    from the refined selection-cabin asset.
    """

    source = bpy.data.objects.get(LAMP_SOURCE_ROOT)
    if source is None or source.type != "EMPTY":
        raise ValueError(f"{LAMP_SOURCE_ROOT} must be an authored Empty in the source blend")
    source_children = [child for child in source.children]
    if len(source_children) != 12:
        raise ValueError(f"{LAMP_SOURCE_ROOT} expected 12 authored children, got {len(source_children)}")

    side_name = "L" if side < 0 else "R"
    clones: list[bpy.types.Object] = []

    def clone_tree(source_obj: bpy.types.Object, clone_parent: bpy.types.Object | None) -> bpy.types.Object:
        clone = source_obj.copy()
        # Object.copy() intentionally keeps the source mesh/material datablock;
        # do not call data.copy() here.
        scene.collection.objects.link(clone)
        source_suffix = (
            "Root"
            if source_obj == source
            else source_obj.name.removeprefix(LAMP_SOURCE_ROOT + "_")
        )
        clone.name = f"{PREFIX}Lantern_{side_name}_{source_suffix}"
        clone.parent = clone_parent
        clone.matrix_parent_inverse = Matrix.Identity(4)
        clone.matrix_local = source_obj.matrix_local.copy()
        clone["SV3_LoginRedesign_source_lamp_clone"] = True
        clone["SV3_LoginRedesign_source_lamp"] = LAMP_SOURCE_ROOT
        clones.append(clone)
        for child in source_obj.children:
            clone_tree(child, clone)
        return clone

    root_clone = clone_tree(source, parent)
    root_local = root_clone.matrix_local.copy()
    root_local.translation = Vector((side * 3.91, -0.30, target_z))
    root_clone.matrix_local = root_local
    root_clone["SV3_LoginRedesign_mount_local"] = "x=±3.91, y=-0.30, z=6.15"
    root_clone["SV3_LoginRedesign_shared_mesh_material"] = True
    root_clone["SV3_LoginRedesign_child_count"] = len(source_children)
    return clones


def _square_decal_plate(
    scene: bpy.types.Scene,
    parent: bpy.types.Object,
    name: str,
    center_x: float,
    center_z: float,
    side_length: float,
    front_y: float,
    thickness: float,
    material: bpy.types.Material,
) -> bpy.types.Object:
    """Create an unclipped square decal plate and author its Emblem UV."""

    half = side_length / 2.0
    plate = _mesh(
        scene,
        parent,
        name,
        [(center_x - half, front_y, center_z - half),
         (center_x + half, front_y, center_z - half),
         (center_x + half, front_y, center_z + half),
         (center_x - half, front_y, center_z + half)],
        [(0, 1, 2, 3)],
        material,
    )
    _add_emblem_uv(plate)
    plate["SV3_LoginRedesign_maple_image"] = MAPLE_DECAL_IMAGE
    plate["SV3_LoginRedesign_maple_material"] = MAPLE_DECAL_MATERIAL
    plate["SV3_LoginRedesign_square_decal"] = True
    return plate


def _make_lantern(
    scene: bpy.types.Scene,
    parent: bpy.types.Object,
    side: float,
    ivory: bpy.types.Material,
    brass: bpy.types.Material,
    teal: bpy.types.Material,
) -> list[bpy.types.Object]:
    """Reuse the complete refined selection-cabin lamp tree.

    The legacy material arguments remain in the signature so callers of older
    recipe revisions can keep their call shape; the authored lamp's shared
    mesh/material datablocks are the only visual source now.
    """

    del ivory, brass, teal
    return _clone_cabin_lamp(scene, parent, side, target_z=6.15)


def apply_login_redesign(
    scene: bpy.types.Scene,
    reference_path: str | Path | None = None,
) -> dict[str, object]:
    """Apply the fairytale login-sign detail recipe in memory.

    ``scene`` must contain the existing ``SV2_LoginSign`` and its
    ``SV3_LoginSurface`` anchor.  The function returns an audit report and
    leaves the caller responsible for the eventual source blend save/export.
    """

    if scene is None:
        raise ValueError("apply_login_redesign requires an explicit Blender scene")
    sign = bpy.data.objects.get("SV2_LoginSign")
    if sign is None:
        raise ValueError("SV2_LoginSign is missing from the source scene")

    surface, keepout = _find_surface(sign)
    reference = Path(reference_path) if reference_path is not None else REFERENCE
    if not reference.is_absolute():
        reference = ROOT / reference
    reference = reference.resolve()
    archived_legacy_lamps = _archive_legacy_login_lamps(scene, sign)
    _remove_previous_recipe(scene)
    source_before = _source_mesh_fingerprint(scene, sign)
    hidden_legacy = _hide_legacy_caps(sign)

    # Stable, intentionally warm materials requested by the runtime/UI recipe.
    ivory = _ensure_pbr("SV3_LoginRedesign_Ivory", (0.88, 0.76, 0.58), 0.64, 0.02)
    brass = _ensure_pbr("SV3_LoginRedesign_Brass", (0.83, 0.58, 0.22), 0.28, 0.78)
    teal = _ensure_pbr("SV3_LoginRedesign_Teal", (0.015, 0.19, 0.18), 0.42, 0.16)
    wood = _existing_or_fallback("SV3_LoginTimber", "SV3_LoginRedesign_Wood", (0.36, 0.16, 0.055))
    walnut = _existing_or_fallback("SV3_LoginWalnut", "SV3_LoginRedesign_Walnut", (0.12, 0.045, 0.018))
    maple_decal, maple_image = _find_maple_decal()

    root = bpy.data.objects.new(ROOT_NAME, None)
    scene.collection.objects.link(root)
    _attach_local(root, sign)
    root["recipe"] = "scripts/creative/blender/redesign_voyage_login.py"
    root["prototype_reference"] = str(reference)
    root["source_plane"] = "SV2_LoginSign local X/Z; reader normal local -Y"
    root["surface_anchor"] = surface.name
    root["surface_keepout_local_xz"] = json.dumps(keepout, ensure_ascii=False, sort_keys=True)
    root["surface_backing_role"] = "behind SV3_LoginSurface; does not occlude DOM"
    root["legacy_caps_hidden"] = json.dumps(hidden_legacy, ensure_ascii=False)
    root["legacy_lamps_archived"] = json.dumps(archived_legacy_lamps, ensure_ascii=False)
    root["external_mounts_preserved"] = True
    root["source_transform_preserved"] = True
    root["runtime_primary_button_material"] = "SV3_LoginRedesign_Teal"
    root["runtime_secondary_button_material"] = "SV3_LoginRedesign_Ivory"
    root["runtime_button_edge_material"] = "SV3_LoginRedesign_Brass"
    root["login_lamp_source_root"] = LAMP_SOURCE_ROOT
    root["login_lamp_child_count"] = 12
    root["login_lamp_mounts_local"] = json.dumps(
        {"left": [-3.91, -0.30, 6.15], "right": [3.91, -0.30, 6.15]},
        ensure_ascii=False,
        sort_keys=True,
    )
    root["login_lamp_shared_mesh_material"] = True
    root["maple_decal_material"] = MAPLE_DECAL_MATERIAL
    root["maple_decal_image"] = maple_image.name
    root["maple_decal_image_path"] = bpy.path.abspath(maple_image.filepath)
    root["maple_decal_uv_map"] = "Emblem"
    root["maple_decal_uv_projection"] = "square local X/Z normalized 0..1"

    created: list[bpy.types.Object] = []
    register = created.append

    # Quiet ivory paper backing sits behind the DOM projection.  The trim and
    # all relief are outside the keepout rectangle computed from the anchor.
    # Source planks reach local -Y ~= -0.18; placing the paper at -0.21 keeps
    # it in front of the wood while remaining behind the -0.26 DOM anchor.
    register(_box(scene, root, PREFIX + "IvoryPaperBacking", (0.0, -0.21, 4.20), (6.58, 0.08, 5.28), ivory, 0.045))
    register(_box(scene, root, PREFIX + "Frame_Left", (-3.45, -0.48, 4.20), (0.14, 0.12, 5.42), brass, 0.018))
    register(_box(scene, root, PREFIX + "Frame_Right", (3.45, -0.48, 4.20), (0.14, 0.12, 5.42), brass, 0.018))
    register(_box(scene, root, PREFIX + "Frame_Bottom", (0.0, -0.48, 1.37), (6.72, 0.12, 0.12), brass, 0.018))
    register(_box(scene, root, PREFIX + "Frame_Top", (0.0, -0.48, 7.02), (6.72, 0.12, 0.12), brass, 0.018))

    # The top silhouette follows the generated concept: a dark wood arch,
    # teal insets, brass curls, then a raised maple crown.
    arch_path = [
        (-3.43, 7.12),
        (-3.16, 7.36),
        (-2.48, 7.59),
        (-1.54, 7.73),
        (0.0, 7.79),
        (1.54, 7.73),
        (2.48, 7.59),
        (3.16, 7.36),
        (3.43, 7.12),
    ]
    register(_strip(scene, root, PREFIX + "TopWoodArch", arch_path, 0.25, -0.30, 0.17, walnut, 0.025))
    left_teal = [(-3.24, 7.14), (-2.62, 7.38), (-1.52, 7.56), (-1.14, 7.30), (-2.30, 7.16)]
    right_teal = [(-x, z) for x, z in reversed(left_teal)]
    register(_plate(scene, root, PREFIX + "TopTealInset_L", left_teal, -0.51, 0.08, teal, 0.018))
    register(_plate(scene, root, PREFIX + "TopTealInset_R", right_teal, -0.51, 0.08, teal, 0.018))
    register(_plate(scene, root, PREFIX + "TopLeaf_L", _leaf_outline(-2.27, 7.42, 0.20, -1.0), -0.61, 0.06, brass, 0.012))
    register(_plate(scene, root, PREFIX + "TopLeaf_R", _leaf_outline(2.27, 7.42, 0.20, 1.0), -0.61, 0.06, brass, 0.012))

    # The source sail decal already carries the illustrated maple leaf and
    # alpha. The invisible square supplies UVs; the visible silhouette is
    # exactly the same gilded red maple used by the sail.
    crest_center_z = 7.78
    crest_side = 1.36
    register(_square_decal_plate(scene, root, PREFIX + "MapleLeafCrest", 0.0, crest_center_z, crest_side, -0.62, 0.04, maple_decal))

    for side, side_name in ((-1.0, "L"), (1.0, "R")):
        curl_start = side * 1.72
        curl_points = []
        for index in range(19):
            t = index / 18.0
            angle = math.pi * 1.15 * t + (math.pi if side < 0 else 0.0)
            curl_points.append((curl_start + side * 0.44 * math.cos(angle) * (1.0 - 0.45 * t), -0.70, 7.24 + 0.27 * math.sin(angle) * (1.0 - 0.25 * t)))
        register(_tube(scene, root, PREFIX + f"TopScroll_{side_name}", curl_points, brass, 0.055))
        register(_tube(scene, root, PREFIX + f"PillarSpiral_{side_name}", _spiral_path(side * 3.50, 1.78, 6.48, side), brass, 0.045))
        register(_plate(scene, root, PREFIX + f"PillarLeaf_{side_name}", _leaf_outline(side * 3.46, 5.74, 0.22, side), -0.69, 0.06, brass, 0.014))
        register(_plate(scene, root, PREFIX + f"BottomCornerLeaf_{side_name}", _leaf_outline(side * 3.45, 1.52, 0.19, side), -0.69, 0.06, brass, 0.014))
        for object_ in _make_lantern(scene, root, side, ivory, brass, teal):
            register(object_)

    # Layered feet and a central lower flourish frame the bottom without
    # crossing the surface's lower edge at keepout min_z = 1.49.
    for side, side_name in ((-1.0, "L"), (1.0, "R")):
        foot_x = side * 2.86
        register(_box(scene, root, PREFIX + f"Foot_{side_name}_Wood", (foot_x, -0.20, 1.18), (1.18, 0.34, 0.24), walnut, 0.045))
        register(_box(scene, root, PREFIX + f"Foot_{side_name}_Brass", (foot_x, -0.48, 1.37), (0.82, 0.14, 0.16), brass, 0.035))
        register(_box(scene, root, PREFIX + f"Foot_{side_name}_Stud", (foot_x, -0.59, 1.39), (0.12, 0.055, 0.12), ivory, 0.025))

        bottom_path = [
            (side * 2.20, 1.37),
            (side * 1.88, 1.25),
            (side * 1.56, 1.20),
            (side * 1.28, 1.28),
            (side * 1.08, 1.41),
        ]
        register(_tube(scene, root, PREFIX + f"BottomScroll_{side_name}", [(x, -0.68, z) for x, z in bottom_path], brass, 0.055))

    bottom_leaf = [
        (-0.10, 1.43), (-0.18, 1.27), (-0.48, 1.20), (-0.26, 1.08),
        (0.0, 0.83), (0.26, 1.08), (0.48, 1.20), (0.18, 1.27), (0.10, 1.43),
    ]
    register(_plate(scene, root, PREFIX + "BottomMapleFlourish", bottom_leaf, -0.70, 0.10, brass, 0.03))
    register(_strip(scene, root, PREFIX + "BottomMapleFlourish_TealInset", [(0.0, 1.37), (0.0, 1.04)], 0.07, -0.82, 0.035, teal, 0.006))

    # Keep explicit audits on the generated root rather than mutating the
    # source anchor/sign properties.  The caller can serialize this report.
    bpy.context.view_layer.update()
    keepout_violations = _surface_keepout_violations(root, surface, keepout)
    generated_bounds = {}
    for obj in created:
        bounds = _local_bounds(obj)
        if bounds is not None:
            generated_bounds[obj.name] = bounds
    material_users = {
        material.name: sorted(
            obj.name
            for obj in scene.objects
            if obj.type == "MESH" and material.name in {slot.name for slot in obj.data.materials}
        )
        for material in (ivory, brass, teal, maple_decal)
    }
    if any(not users for users in material_users.values()):
        raise RuntimeError(f"Login redesign material is unreferenced: {material_users}")
    source_after = _source_mesh_fingerprint(scene, sign)
    source_mesh_count = sum(
        1
        for obj in scene.objects
        if obj.type == "MESH" and _descendant(obj, sign) and not obj.name.startswith(PREFIX)
    )
    created_names = [obj.name for obj in created]
    root["generated_object_count"] = len(created_names) + 1
    root["generated_objects"] = json.dumps(created_names, ensure_ascii=False)
    root["source_fingerprint_before"] = source_before
    root["source_fingerprint_after"] = source_after
    root["source_mesh_count"] = source_mesh_count
    root["surface_keepout_violations"] = json.dumps(keepout_violations, ensure_ascii=False)
    root["runtime_material_users"] = json.dumps(material_users, ensure_ascii=False, sort_keys=True)
    root["generated_bounds_local"] = json.dumps(generated_bounds, ensure_ascii=False, sort_keys=True)

    return {
        "recipe": "scripts/creative/blender/redesign_voyage_login.py",
        "reference": str(reference),
        "root": root.name,
        "created_objects": created_names,
        "created_object_count": len(created_names) + 1,
        "materials": [ivory.name, brass.name, teal.name],
        "runtime_material_roles": {
            "primary_button": teal.name,
            "secondary_buttons": ivory.name,
            "button_edges": brass.name,
        },
        "reused_materials": [wood.name, walnut.name, maple_decal.name],
        "maple_decal": {
            "material": maple_decal.name,
            "image": maple_image.name,
            "image_path": bpy.path.abspath(maple_image.filepath),
            "uv_map": "Emblem",
            "projection": "square local X/Z normalized 0..1",
        },
        "lamp_reuse": {
            "source_root": LAMP_SOURCE_ROOT,
            "child_count": 12,
            "mounts_local": {"left": [-3.91, -0.30, 6.15], "right": [3.91, -0.30, 6.15]},
            "shared_mesh_material": True,
        },
        "archived_legacy_lamps": archived_legacy_lamps,
        "hidden_legacy_objects": hidden_legacy,
        "surface_anchor": surface.name,
        "surface_keepout_local_xz": keepout,
        "surface_keepout_violations": keepout_violations,
        "generated_bounds_local": generated_bounds,
        "reader_normal_local": [0.0, -1.0, 0.0],
        "source_plane": "SV2_LoginSign local X/Z",
        "source_mesh_count": source_mesh_count,
        "source_fingerprint_before": source_before,
        "source_fingerprint_after": source_after,
        "source_fingerprint_preserved": source_before == source_after,
        "runtime_material_users": material_users,
        "external_mounts_preserved": True,
        "saved_or_exported": False,
    }


__all__ = ["apply_login_redesign"]
