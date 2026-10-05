"""Recipe-only cabin finish pass for the retained voyage interior.

The recipe adds a small amount of readable trim around the existing berth
cabin without rebuilding the room.  It deliberately treats the current
source objects as read-only: their bounds and transforms are sampled, detail
vertices are authored in ``SV3_CabinInterior`` local space, and a before/after
fingerprint fails if any pre-existing cabin object changes.

The caller owns Blender's scene selection, frame, bevel application, save and
export lifecycle.  This module does not use operators, drivers, file IO or
the save/export APIs.  ``apply_cabin_finish(scene, materials)`` is safe to
call repeatedly; only objects using ``SV3_CabinFinish_`` are replaced.

The expected material mapping is supplied by the caller so this recipe never
creates or repaints production materials::

    {
        "Walnut": existing wood material,
        "Brass": existing trim material,
        "Ivory": existing light wall material,
        "Navy": existing dark inset material,
        "Teal": existing jade/teal accent material,
    }

Current cabin axes are Blender X lateral, Y depth and Z up.  All positions
still come from source bounds/transforms; the axis names are used only for
the existing aligned cabin architecture, not as a second set of layout
coordinates.
"""

from __future__ import annotations

import array
import hashlib
import math
from collections.abc import Mapping

import bpy
from mathutils import Matrix, Vector


DETAIL_PREFIX = "SV3_CabinFinish_"
PARENT_NAME = "SV3_CabinInterior"
REFERENCE = "resources/scenes/sky-voyage-v2/design/ship-interior-plan-v1.png"
REFERENCE_REVISION = "v1"
MATERIAL_KEYS = ("Walnut", "Brass", "Ivory", "Navy", "Teal")

_BOX_FACES = (
    (0, 3, 2, 1),
    (4, 5, 6, 7),
    (0, 1, 5, 4),
    (1, 2, 6, 5),
    (2, 3, 7, 6),
    (3, 0, 4, 7),
)


def _descends_from(obj, parent):
    """Return whether ``obj`` belongs to ``parent`` without changing scene state."""

    current = obj.parent
    while current is not None:
        if current == parent:
            return True
        current = current.parent
    return False


def _parent_objects(scene, parent):
    """Yield the parent and its existing descendants, excluding recipe nodes."""

    for obj in scene.objects:
        if obj.name.startswith(DETAIL_PREFIX):
            continue
        if obj == parent or _descends_from(obj, parent):
            yield obj


def _matrix_tuple(matrix):
    return tuple(round(float(value), 9) for row in matrix for value in row)


def _mesh_fingerprint(obj):
    """Fingerprint base coordinates/topology and object transforms only."""

    mesh = obj.data
    coordinates = array.array("f", [0.0]) * (len(mesh.vertices) * 3)
    mesh.vertices.foreach_get("co", coordinates)
    topology = tuple(
        (tuple(poly.vertices), int(poly.material_index), bool(poly.use_smooth))
        for poly in mesh.polygons
    )
    payload = coordinates.tobytes() + repr(topology).encode("utf-8")
    return (
        obj.type,
        len(mesh.vertices),
        len(mesh.polygons),
        hashlib.sha256(payload).hexdigest(),
        _matrix_tuple(obj.matrix_world),
    )


def _source_fingerprint(scene, parent):
    """Return a stable named fingerprint for all pre-existing cabin objects."""

    result = {}
    for obj in _parent_objects(scene, parent):
        if obj.type == "MESH":
            geometry = _mesh_fingerprint(obj)
        else:
            geometry = (obj.type, _matrix_tuple(obj.matrix_world))
        result[obj.name] = geometry
    return result


def _fingerprint_digest(fingerprint):
    payload = repr(sorted(fingerprint.items())).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _safe_inverse(matrix):
    try:
        return matrix.inverted()
    except Exception:
        return matrix.inverted_safe()


def _iter_bounds_objects(root):
    """Yield a source root and its descendants, excluding our own detail nodes."""

    if not root.name.startswith(DETAIL_PREFIX):
        yield root
    for child in root.children_recursive:
        if not child.name.startswith(DETAIL_PREFIX):
            yield child


def _parent_local_points(root, parent):
    """Read source bounding-box corners in parent-local coordinates."""

    inverse = _safe_inverse(parent.matrix_world)
    points = []
    for obj in _iter_bounds_objects(root):
        if obj.type == "MESH":
            transform = inverse @ obj.matrix_world
            points.extend(transform @ Vector(corner) for corner in obj.bound_box)
        elif obj.type == "EMPTY":
            points.append(inverse @ obj.matrix_world.translation)
    return points


def _bounds(points):
    if not points:
        raise ValueError("source object has no readable bounds")
    return tuple(
        (
            min(float(point[axis]) for point in points),
            max(float(point[axis]) for point in points),
        )
        for axis in range(3)
    )


def _find(scene, *names):
    for name in names:
        obj = scene.objects.get(name)
        if obj is not None:
            return obj
    return None


def _require_materials(materials):
    if not isinstance(materials, Mapping):
        raise TypeError("materials must be a mapping with Walnut/Brass/Ivory/Navy/Teal")
    missing = [key for key in MATERIAL_KEYS if key not in materials or materials[key] is None]
    if missing:
        raise KeyError("missing cabin finish materials: " + ", ".join(missing))
    return {key: materials[key] for key in MATERIAL_KEYS}


def _remove_previous_details(scene):
    """Remove only this recipe's nodes and orphaned generated mesh data."""

    removed = []
    for obj in list(scene.objects):
        if not obj.name.startswith(DETAIL_PREFIX):
            continue
        mesh = obj.data if obj.type == "MESH" else None
        removed.append(obj.name)
        bpy.data.objects.remove(obj, do_unlink=True)
        if mesh is not None and mesh.users == 0:
            bpy.data.meshes.remove(mesh)
    return tuple(removed)


def _append_box(vertices, faces, material_indices, center, size, material_index):
    cx, cy, cz = (float(value) for value in center)
    sx, sy, sz = (float(value) * 0.5 for value in size)
    base = len(vertices)
    vertices.extend(
        (
            (cx - sx, cy - sy, cz - sz),
            (cx + sx, cy - sy, cz - sz),
            (cx + sx, cy + sy, cz - sz),
            (cx - sx, cy + sy, cz - sz),
            (cx - sx, cy - sy, cz + sz),
            (cx + sx, cy - sy, cz + sz),
            (cx + sx, cy + sy, cz + sz),
            (cx - sx, cy + sy, cz + sz),
        )
    )
    faces.extend(tuple(base + index for index in face) for face in _BOX_FACES)
    material_indices.extend([int(material_index)] * len(_BOX_FACES))


def _append_torus_z(vertices, faces, material_indices, center, major_radius,
                    minor_radius, material_index, segments=20, sides=6):
    """Append a small horizontal torus, used only for the four lamp hangers."""

    cx, cy, cz = (float(value) for value in center)
    base = len(vertices)
    for segment in range(segments):
        theta = math.tau * segment / segments
        for side in range(sides):
            phi = math.tau * side / sides
            radius = major_radius + minor_radius * math.cos(phi)
            vertices.append(
                (
                    cx + radius * math.cos(theta),
                    cy + radius * math.sin(theta),
                    cz + minor_radius * math.sin(phi),
                )
            )
    for segment in range(segments):
        next_segment = (segment + 1) % segments
        for side in range(sides):
            next_side = (side + 1) % sides
            a = base + segment * sides + side
            b = base + segment * sides + next_side
            c = base + next_segment * sides + next_side
            d = base + next_segment * sides + side
            faces.append((a, b, c, d))
            material_indices.append(int(material_index))


def _create_detail(scene, parent, name, vertices, faces, material_slots,
                   material_indices, bevel_width=0.0, smooth=False, role="trim"):
    if not vertices or not faces:
        return None
    mesh = bpy.data.meshes.new(name + "_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    for material in material_slots:
        mesh.materials.append(material)
    for polygon, material_index in zip(mesh.polygons, material_indices):
        polygon.material_index = int(material_index)
        polygon.use_smooth = bool(smooth)

    # Details are small but still receive a deterministic UV layer so the
    # caller can apply existing material textures without another mesh pass.
    uv_layer = mesh.uv_layers.new(name="CabinFinishUV")
    for loop in mesh.loops:
        coordinate = mesh.vertices[loop.vertex_index].co
        uv_layer.data[loop.index].uv = (
            float(coordinate.x) * 0.25,
            float(coordinate.y) * 0.25,
        )

    obj = bpy.data.objects.new(name, mesh)
    collection = parent.users_collection[0] if parent.users_collection else scene.collection
    collection.objects.link(obj)
    obj.parent = parent
    obj.matrix_parent_inverse = Matrix.Identity(4)
    obj.location = (0.0, 0.0, 0.0)
    obj.rotation_euler = (0.0, 0.0, 0.0)
    obj.scale = (1.0, 1.0, 1.0)

    obj["structural_repair_child"] = True
    obj["prototype_reference"] = REFERENCE
    obj["prototype_reference_revision"] = REFERENCE_REVISION
    obj["detail_recipe"] = "refine_voyage_cabin_finish.py"
    obj["parent_contract"] = PARENT_NAME
    obj["source_geometry_policy"] = "source bounds/transforms read-only"
    obj["animation_policy"] = "no drivers or keyframes"
    obj["cabin_finish_role"] = role

    modifier_name = None
    if bevel_width > 0.0:
        modifier = obj.modifiers.new("Cabin finish soft edge", "BEVEL")
        modifier.width = float(bevel_width)
        modifier.segments = 2
        modifier.limit_method = "ANGLE"
        modifier_name = modifier.name
    return obj, modifier_name


def _create_box_detail(scene, parent, name, boxes, slots, bevel_width, role):
    vertices = []
    faces = []
    material_indices = []
    for center, size, material_index in boxes:
        _append_box(vertices, faces, material_indices, center, size, material_index)
    return _create_detail(
        scene,
        parent,
        name,
        vertices,
        faces,
        slots,
        material_indices,
        bevel_width=bevel_width,
        role=role,
    )


def _axis_group(points, axis, sign):
    """Split a two-sided source mesh into its negative/positive side bounds."""

    values = [float(point[axis]) for point in points]
    midpoint = (min(values) + max(values)) * 0.5
    selected = [point for point in points if (point[axis] <= midpoint if sign < 0 else point[axis] >= midpoint)]
    return selected or points


def _make_wall_trims(scene, parent, materials, source):
    points = _parent_local_points(source, parent)
    if not points:
        return None
    groups = []
    for sign in (-1, 1):
        group = _axis_group(points, 0, sign)
        if group:
            groups.append(_bounds(group))
    if len(groups) != 2:
        return None
    boxes_base = []
    boxes_crown = []
    for side_index, ((xmin, xmax), (ymin, ymax), (zmin, zmax)) in enumerate(groups):
        del side_index
        x = (xmin + xmax) * 0.5
        y = (ymin + ymax) * 0.5
        length = max(0.4, ymax - ymin + 0.10)
        wall_thickness = max(0.06, xmax - xmin)
        inward = 1.0 if x < 0.0 else -1.0
        # Timber foot, narrow navy reveal and ivory crown all stay inside the
        # measured wall envelope so they never widen the walkable room.
        boxes_base.extend(
            (
                ((x, y, zmin + 0.12), (wall_thickness + 0.04, length, 0.14), 0),
                ((x + inward * (wall_thickness * 0.5 + 0.012), y, zmin + 0.215),
                 (0.025, length, 0.035), 2),
            )
        )
        boxes_crown.extend(
            (
                ((x, y, zmax - 0.12), (wall_thickness + 0.04, length, 0.14), 0),
                ((x, y, zmax - 0.215), (wall_thickness + 0.065, length, 0.035), 1),
            )
        )
    created = []
    base = _create_box_detail(
        scene,
        parent,
        DETAIL_PREFIX + "WallBaseRails",
        boxes_base,
        (materials["Walnut"], materials["Brass"], materials["Navy"]),
        0.018,
        "wall skirting and inset reveal",
    )
    crown = _create_box_detail(
        scene,
        parent,
        DETAIL_PREFIX + "WallCrownRails",
        boxes_crown,
        (materials["Walnut"], materials["Brass"]),
        0.018,
        "wall crown and compression trim",
    )
    for result in (base, crown):
        if result is not None:
            created.append(result)
    return created


def _make_back_trims(scene, parent, materials, source):
    bounds = _bounds(_parent_local_points(source, parent))
    (xmin, xmax), (ymin, ymax), (zmin, zmax) = bounds
    x_length = max(0.4, xmax - xmin + 0.10)
    depth = max(0.06, ymax - ymin)
    # The interior-facing side is the side toward the cabin centre.  The
    # current rear wall is at negative Y, so its inside is +Y; using the
    # measured sign keeps this attached if the parent is transformed.
    wall_centre_y = (ymin + ymax) * 0.5
    y = ymax + 0.055 if wall_centre_y < 0.0 else ymin - 0.055
    boxes = [
        ((0.5 * (xmin + xmax), y, zmin + 0.13), (x_length, depth + 0.06, 0.14), 0),
        ((0.5 * (xmin + xmax), y, zmax - 0.13), (x_length, depth + 0.06, 0.14), 1),
    ]
    result = _create_box_detail(
        scene,
        parent,
        DETAIL_PREFIX + "RearWallTrim",
        boxes,
        (materials["Walnut"], materials["Brass"]),
        0.018,
        "rear wall base and crown",
    )
    if result is not None:
        result[0]['runtime_hide_group'] = 'SV2_CabinBackWall'
        return [result]
    return []


def _make_ceiling_crown(scene, parent, materials, eaves, ridge):
    boxes = []
    for eave in eaves:
        (xmin, xmax), (ymin, ymax), (zmin, zmax) = _bounds(_parent_local_points(eave, parent))
        x = (xmin + xmax) * 0.5
        side = -1.0 if x < 0.0 else 1.0
        inner_x = x - side * 0.09
        length = max(0.4, ymax - ymin + 0.10)
        boxes.extend(
            (
                ((inner_x, (ymin + ymax) * 0.5, zmin + 0.055),
                 (0.075, length, 0.09), 0),
                ((inner_x - side * 0.032, (ymin + ymax) * 0.5, zmin + 0.105),
                 (0.025, length, 0.035), 1),
            )
        )
    if ridge is not None:
        (xmin, xmax), (ymin, ymax), (zmin, zmax) = _bounds(_parent_local_points(ridge, parent))
        boxes.append(
            ((0.5 * (xmin + xmax), 0.5 * (ymin + ymax), zmin + 0.025),
             (max(0.06, xmax - xmin + 0.06), max(0.4, ymax - ymin + 0.10), 0.06), 0)
        )
    result = _create_box_detail(
        scene,
        parent,
        DETAIL_PREFIX + "CeilingCrown",
        boxes,
        (materials["Ivory"], materials["Brass"]),
        0.012,
        "ceiling eave and ridge compression trim",
    )
    if result is not None:
        obj = result[0]
        obj["runtime_hide_group"] = "SV2_CabinRoof"
        obj["runtime_hide_toggle"] = True
        return [result]
    return []


def _window_bounds(root, parent):
    points = _parent_local_points(root, parent)
    bounds = _bounds(points)
    (xmin, xmax), (ymin, ymax), (zmin, zmax) = bounds
    if xmax - xmin < 0.5 or zmax - zmin < 0.5:
        raise ValueError(f"{root.name} has no usable stained-window bounds: {bounds}")
    return bounds


def _make_window_trim(scene, parent, materials, root, index):
    (xmin, xmax), (ymin, ymax), (zmin, zmax) = _window_bounds(root, parent)
    width = xmax - xmin
    height = zmax - zmin
    margin = min(0.075, width * 0.025, height * 0.025)
    depth = max(0.045, min(0.08, (ymax - ymin) * 0.20))
    front_y = ymin - depth * 0.55
    bar = max(0.045, min(0.075, width * 0.018))
    x = (xmin + xmax) * 0.5
    z = (zmin + zmax) * 0.5
    boxes = [
        ((xmin - margin, front_y, z), (bar, depth, height + margin * 2.0), 0),
        ((xmax + margin, front_y, z), (bar, depth, height + margin * 2.0), 0),
        ((x, front_y, zmin - margin), (width + margin * 2.0, depth, bar), 0),
        ((x, front_y, zmax + margin), (width + margin * 2.0, depth, bar), 0),
    ]
    # Four tiny jade corner keys give each profession window a controlled
    # teal accent while leaving its image and opening unobstructed.
    key = max(0.07, min(0.13, width * 0.035))
    for corner_x in (xmin - margin, xmax + margin):
        for corner_z in (zmin - margin, zmax + margin):
            boxes.append(((corner_x, front_y - 0.006, corner_z), (key, depth + 0.012, key), 1))
    result = _create_box_detail(
        scene,
        parent,
        DETAIL_PREFIX + "WindowTrim_%02d" % index,
        boxes,
        (materials["Brass"], materials["Teal"]),
        0.010,
        "stained-glass perimeter compression strip",
    )
    if result is not None:
        obj = result[0]
        obj["window_source"] = root.name
        obj["window_opening_preserved"] = True
        return [result]
    return []


def _make_lamp_hangers(scene, parent, materials, lamps):
    vertices = []
    faces = []
    material_indices = []
    sources = []
    for lamp in lamps:
        points = _parent_local_points(lamp, parent)
        if not points:
            continue
        (xmin, xmax), (ymin, ymax), (zmin, zmax) = _bounds(points)
        if xmax - xmin > 2.0 or ymax - ymin > 2.0 or zmax - zmin > 2.5:
            raise ValueError(f"unexpected lamp bounds for {lamp.name}: {_bounds(points)}")
        centre = ((xmin + xmax) * 0.5, (ymin + ymax) * 0.5, zmax + 0.095)
        _append_torus_z(
            vertices,
            faces,
            material_indices,
            centre,
            0.105,
            0.016,
            0,
            segments=18,
            sides=6,
        )
        _append_box(
            vertices,
            faces,
            material_indices,
            (centre[0], centre[1], centre[2] + 0.105),
            (0.034, 0.034, 0.21),
            0,
        )
        sources.append(lamp.name)
    result = _create_detail(
        scene,
        parent,
        DETAIL_PREFIX + "LampHangers",
        vertices,
        faces,
        (materials["Brass"],),
        material_indices,
        bevel_width=0.006,
        smooth=True,
        role="small suspended lamp fittings",
    )
    if result is not None:
        result[0]["lamp_sources"] = tuple(sources)
        return [result]
    return []


def apply_cabin_finish(scene, materials):
    """Add bounded cabin trim while asserting all retained source geometry stays unchanged.

    Parameters
    ----------
    scene:
        The Blender scene containing ``SV3_CabinInterior``.
    materials:
        Mapping with the five keys ``Walnut``, ``Brass``, ``Ivory``, ``Navy``
        and ``Teal``.  Values are existing ``bpy.types.Material`` instances.

    Returns
    -------
    dict
        Audit report with exact created roots, removed recipe roots, source
        fingerprint digests and caller-side bevel/save/export instructions.
    """

    if scene is None:
        raise ValueError("apply_cabin_finish(scene, materials) requires a scene")
    parent = scene.objects.get(PARENT_NAME)
    if parent is None:
        raise KeyError("missing cabin parent: " + PARENT_NAME)
    resolved_materials = _require_materials(materials)

    windows = [scene.objects.get("SV2_CabinFrontWindow_%02d" % index) for index in range(1, 5)]
    missing_windows = ["SV2_CabinFrontWindow_%02d" % index for index, root in enumerate(windows, start=1) if root is None]
    if missing_windows:
        raise KeyError("missing four stained-window roots: " + ", ".join(missing_windows))

    side_walls = _find(scene, "SV2_CabinSideWalls")
    rear_wall = _find(scene, "SV2_CabinBackWall")
    eaves = [
        root for root in (
            _find(scene, "SV2_CabinRoofEave_Port"),
            _find(scene, "SV2_CabinRoofEave_Starboard"),
        ) if root is not None
    ]
    ridge = _find(scene, "SV2_CabinRoofRidge")
    lamps = [
        root for root in (scene.objects.get("SV3_CabinLamp_%d" % index) for index in range(4))
        if root is not None
    ]

    before = _source_fingerprint(scene, parent)
    before_digest = _fingerprint_digest(before)
    removed = _remove_previous_details(scene)
    created = []
    bevels = []
    skipped = []
    try:
        if side_walls is not None:
            created.extend(_make_wall_trims(scene, parent, resolved_materials, side_walls) or ())
        else:
            skipped.append("wall rails: SV2_CabinSideWalls missing")

        if rear_wall is not None:
            created.extend(_make_back_trims(scene, parent, resolved_materials, rear_wall))
        else:
            skipped.append("rear wall trim: SV2_CabinBackWall missing")

        if eaves or ridge is not None:
            created.extend(_make_ceiling_crown(scene, parent, resolved_materials, eaves, ridge))
        else:
            skipped.append("ceiling crown: roof eaves/ridge missing")

        for index, root in enumerate(windows, start=1):
            created.extend(_make_window_trim(scene, parent, resolved_materials, root, index))

        if len(lamps) == 4:
            created.extend(_make_lamp_hangers(scene, parent, resolved_materials, lamps))
        else:
            skipped.append("lamp hangers: expected four SV3_CabinLamp_0..3 roots")

        for result in created:
            obj, modifier_name = result
            if modifier_name is not None:
                bevels.append((obj.name, modifier_name))

        after = _source_fingerprint(scene, parent)
        after_digest = _fingerprint_digest(after)
        if after != before:
            changed = sorted(name for name in set(before) | set(after) if before.get(name) != after.get(name))
            raise AssertionError(
                "cabin source geometry or transform changed while adding finish: "
                + ", ".join(changed)
            )
    except Exception:
        _remove_previous_details(scene)
        raise

    created_names = tuple(obj.name for obj, _ in created)
    return {
        "parent": PARENT_NAME,
        "created_roots": created_names,
        "created_count": len(created_names),
        "removed_previous": removed,
        "source_object_count": len(before),
        "source_fingerprint_before": before_digest,
        "source_fingerprint_after": after_digest,
        "source_fingerprint_preserved": True,
        "window_trim_count": sum(1 for name in created_names if name.startswith(DETAIL_PREFIX + "WindowTrim_")),
        "lamp_hanger_count": sum(1 for name in created_names if name == DETAIL_PREFIX + "LampHangers"),
        "bevel_modifiers": tuple(bevels),
        "skipped": tuple(skipped),
        "prototype_reference": REFERENCE,
        "caller_actions": (
            "Optionally apply the returned bevel modifiers in the caller after visual review.",
            "Run the existing cabin/source/runtime checks from the caller.",
            "Save and export from the caller; this recipe performs no file IO.",
        ),
    }


__all__ = ["apply_cabin_finish"]
