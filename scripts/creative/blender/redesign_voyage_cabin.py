"""Recipe-only fairytale refit for the retained voyage selection cabin.

This module adds the small, readable interior details from the fairytale cabin
reference while leaving the production cabin, beds, stained glass, lamps and
route-owned meshes untouched.  It is intentionally a recipe rather than a
Blender job script:

* :func:`apply_cabin_redesign` does not open, save, pack or export a file;
* source bounds and transforms are sampled from ``SV3_CabinInterior``;
* only objects whose names start with ``SV3_CabinRedesign_`` are replaced on a
  repeated call; and
* all new nodes are children of the existing cabin root and use existing
  production materials.

The current cabin has already been rotated around its runtime Y pivot by +90
degrees.  The recipe therefore authors local Blender X/Y/Z detail geometry
under ``SV3_CabinInterior`` and never edits that parent transform.  Its local
floor, wall, window, bed and foot-anchor bounds are the layout authority.

The requested concept reference is kept as metadata at
``resources/scenes/sky-voyage-v3/prototypes/cabin-fairytale-redesign.png``.
``texture_path`` is optional input metadata for callers that have a temporary
or absolute copy of the same reference; it is not used to repaint production
materials.
"""

from __future__ import annotations

import array
import hashlib
import math
import os

import bpy
from mathutils import Matrix, Vector


DETAIL_PREFIX = "SV3_CabinRedesign_"
PARENT_NAME = "SV3_CabinInterior"
REFERENCE = "resources/scenes/sky-voyage-v3/prototypes/cabin-fairytale-redesign.png"
ROUTE_ANCHOR_FORWARD_OFFSET = 0.6
BODY_RADIUS = 0.32
BODY_HEIGHT = 1.80

_BOX_FACES = (
    (0, 3, 2, 1),
    (4, 5, 6, 7),
    (0, 1, 5, 4),
    (1, 2, 6, 5),
    (2, 3, 7, 6),
    (3, 0, 4, 7),
)


def _descends_from(obj, parent):
    current = obj.parent
    while current is not None:
        if current == parent:
            return True
        current = current.parent
    return False


def _source_objects(scene, parent):
    """Yield the cabin source tree while excluding this recipe's details."""

    for obj in scene.objects:
        if obj.name.startswith(DETAIL_PREFIX):
            continue
        if obj == parent or _descends_from(obj, parent):
            yield obj


def _matrix_tuple(matrix):
    return tuple(round(float(value), 9) for row in matrix for value in row)


def _mesh_fingerprint(obj):
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
    result = {}
    for obj in _source_objects(scene, parent):
        result[obj.name] = _mesh_fingerprint(obj) if obj.type == "MESH" else (
            obj.type,
            _matrix_tuple(obj.matrix_world),
        )
    return result


def _fingerprint_digest(fingerprint):
    return hashlib.sha256(repr(sorted(fingerprint.items())).encode("utf-8")).hexdigest()


def _inverse(matrix):
    try:
        return matrix.inverted()
    except Exception:
        return matrix.inverted_safe()


def _bound_points(root, parent):
    """Read all descendant bounds in the cabin parent's local space."""

    inverse = _inverse(parent.matrix_world)
    points = []
    for obj in (root, *root.children_recursive):
        if obj != root and obj.name.startswith(DETAIL_PREFIX):
            continue
        if obj.type == "MESH":
            transform = inverse @ obj.matrix_world
            points.extend(transform @ Vector(corner) for corner in obj.bound_box)
        elif obj.type in {"EMPTY", "LIGHT", "CAMERA"}:
            points.append(inverse @ obj.matrix_world.translation)
    if not points:
        raise ValueError(f"{root.name} has no readable bounds")
    return points


def _bounds(root, parent):
    points = _bound_points(root, parent)
    return tuple(
        (min(float(point[axis]) for point in points), max(float(point[axis]) for point in points))
        for axis in range(3)
    )


def _centre(bounds):
    return tuple((low + high) * 0.5 for low, high in bounds)


def _size(bounds):
    return tuple(high - low for low, high in bounds)


def _remove_previous_details(scene):
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


def _material(*names):
    for name in names:
        material = bpy.data.materials.get(name)
        if material is not None:
            return material
    raise KeyError("missing fairytale cabin material; tried: " + ", ".join(names))


def _materials():
    """Resolve only materials already present in the production blend."""

    return {
        "wood": _material("SV3_CabinWalnut", "SV3_Finish_Walnut", "SV3_Prototype_SternWalnut"),
        "ivory": _material("SV3_Finish_Ivory", "SV2_M_SilverEnamel.002", "SV3_Prototype_HullIvory"),
        "brass": _material("SV3_Finish_Brass", "SV2_M_PaleBrass.002", "SV3_Prototype_BrassTrim"),
        "teal": _material("SV3_Finish_Teal", "SV3_Prototype_TealRibbon", "SV3_Prototype_JadeGlass"),
        "floor": _material("SV3_Finish_Deck", "SV3_Prototype_DeckTeak", "SV3_M_Wood"),
    }


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


def _append_prism_xz(vertices, faces, material_indices, outline, y, depth, material_index):
    """Append a solid 2D outline lying in local X/Z."""

    if len(outline) < 3:
        return
    base = len(vertices)
    half_depth = float(depth) * 0.5
    vertices.extend((x, y - half_depth, z) for x, z in outline)
    vertices.extend((x, y + half_depth, z) for x, z in outline)
    count = len(outline)
    faces.append(tuple(base + index for index in range(count - 1, -1, -1)))
    faces.append(tuple(base + count + index for index in range(count)))
    for index in range(count):
        next_index = (index + 1) % count
        faces.append((base + index, base + next_index, base + count + next_index, base + count + index))
    material_indices.extend([int(material_index)] * (count + 2))


def _append_star_xz(vertices, faces, material_indices, center, radius, depth, material_index, points=8):
    cx, y, cz = (float(value) for value in center)
    outline = []
    inner = radius * 0.42
    for index in range(points * 2):
        angle = math.pi * 0.5 + math.tau * index / (points * 2)
        length = radius if index % 2 == 0 else inner
        outline.append((cx + math.cos(angle) * length, cz + math.sin(angle) * length))
    _append_prism_xz(vertices, faces, material_indices, outline, y, depth, material_index)


def _append_leaf_xz(vertices, faces, material_indices, center, width, height, depth, material_index, angle=0.0):
    cx, y, cz = (float(value) for value in center)
    points = []
    for ratio, side in ((0.0, 0.0), (0.38, 1.0), (1.0, 0.0), (0.38, -1.0)):
        along = (ratio - 0.5) * height
        across = side * width * math.sin(math.pi * ratio)
        points.append(
            (
                cx + across * math.cos(angle) - along * math.sin(angle),
                cz + across * math.sin(angle) + along * math.cos(angle),
            )
        )
    _append_prism_xz(vertices, faces, material_indices, points, y, depth, material_index)


def _append_arch_strip(vertices, faces, material_indices, x_min, x_max, y, shoulder, height, depth, thickness, material_index, samples=24):
    """Append a shallow solid ivory arch using a smooth sampled centre line."""

    count = max(8, int(samples)) + 1
    half = float(thickness) * 0.5
    half_depth = float(depth) * 0.5
    base = len(vertices)
    strips = []
    for index in range(count):
        ratio = index / (count - 1)
        x = x_min + (x_max - x_min) * ratio
        dzdx = height * math.pi / (x_max - x_min) * math.cos(math.pi * ratio)
        normal_length = math.hypot(-dzdx, 1.0)
        nx = -dzdx / normal_length
        nz = 1.0 / normal_length
        z = shoulder + height * math.sin(math.pi * ratio)
        strips.append(((x + nx * half, z + nz * half), (x - nx * half, z - nz * half)))
    for depth_sign in (-1.0, 1.0):
        for first, second in strips:
            vertices.extend(((first[0], y + depth_sign * half_depth, first[1]), (second[0], y + depth_sign * half_depth, second[1])))
    side_base = base
    side_stride = count * 2
    for side in range(2):
        offset = side_base + side * side_stride
        for index in range(count - 1):
            a = offset + index * 2
            b = a + 1
            c = offset + (index + 1) * 2 + 1
            d = offset + (index + 1) * 2
            faces.append((a, d, c, b) if side == 0 else (a, b, c, d))
            material_indices.append(int(material_index))
    for index in range(count - 1):
        front = side_base + index * 2
        next_front = side_base + (index + 1) * 2
        back = side_base + side_stride + index * 2
        next_back = side_base + side_stride + (index + 1) * 2
        faces.extend(
            (
                (front, back, next_back, next_front),
                (front + 1, next_front + 1, next_back + 1, back + 1),
            )
        )
        material_indices.extend([int(material_index), int(material_index)])
    faces.extend(
        (
            (side_base, side_base + 1, side_base + side_stride + 1, side_base + side_stride),
            (side_base + (count - 1) * 2, side_base + side_stride + (count - 1) * 2, side_base + side_stride + (count - 1) * 2 + 1, side_base + (count - 1) * 2 + 1),
        )
    )
    material_indices.extend([int(material_index), int(material_index)])


def _append_ring_z(vertices, faces, material_indices, center, radius, tube, material_index, segments=48, sides=6):
    cx, cy, cz = (float(value) for value in center)
    base = len(vertices)
    for segment in range(segments):
        theta = math.tau * segment / segments
        for side in range(sides):
            phi = math.tau * side / sides
            radial = radius + tube * math.cos(phi)
            vertices.append((cx + radial * math.cos(theta), cy + radial * math.sin(theta), cz + tube * math.sin(phi)))
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


def _append_star_xy(vertices, faces, material_indices, center, radius, thickness, material_index, points=8):
    cx, cy, z = (float(value) for value in center)
    outline = []
    inner = radius * 0.42
    for index in range(points * 2):
        angle = math.pi * 0.5 + math.tau * index / (points * 2)
        length = radius if index % 2 == 0 else inner
        outline.append((cx + math.cos(angle) * length, cy + math.sin(angle) * length))
    base = len(vertices)
    half = thickness * 0.5
    vertices.extend((x, y, z - half) for x, y in outline)
    vertices.extend((x, y, z + half) for x, y in outline)
    count = len(outline)
    faces.append(tuple(base + index for index in range(count - 1, -1, -1)))
    faces.append(tuple(base + count + index for index in range(count)))
    for index in range(count):
        next_index = (index + 1) % count
        faces.append((base + index, base + next_index, base + count + next_index, base + count + index))
    material_indices.extend([int(material_index)] * (count + 2))


def _create_mesh(scene, parent, name, vertices, faces, materials, material_indices, role, reference_input):
    if not vertices or not faces:
        return None
    mesh = bpy.data.meshes.new(name + "_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    for material in materials:
        mesh.materials.append(material)
    for polygon, index in zip(mesh.polygons, material_indices):
        polygon.material_index = int(index)
        polygon.use_smooth = False
    uv = mesh.uv_layers.new(name="MaterialUV")
    for loop in mesh.loops:
        co = mesh.vertices[loop.vertex_index].co
        uv.data[loop.index].uv = (float(co.x) * 0.25, float(co.y) * 0.25)
    uv.active_render = True
    obj = bpy.data.objects.new(name, mesh)
    collection = parent.users_collection[0] if parent.users_collection else scene.collection
    collection.objects.link(obj)
    obj.parent = parent
    obj.matrix_parent_inverse = Matrix.Identity(4)
    # Blender preserves the newly linked object's old world matrix when a
    # parent is assigned.  Clear that implicit inverse explicitly so authored
    # vertices remain in cabin-local space even when the cabin is translated
    # and already rotated +90 degrees.
    obj.matrix_world = parent.matrix_world.copy()
    obj["prototype_reference"] = REFERENCE
    obj["reference_input"] = reference_input
    obj["detail_recipe"] = "redesign_voyage_cabin.py"
    obj["parent_contract"] = PARENT_NAME
    obj["source_geometry_policy"] = "source bounds/transforms read-only"
    obj["route_geometry_policy"] = "decorative only; no floor roots, blockers or route anchors"
    obj["cabin_redesign_role"] = role
    return obj


def _bevel(obj, width, segments=2):
    modifier = obj.modifiers.new("Cabin redesign softened edge", "BEVEL")
    modifier.width = float(width)
    modifier.segments = int(segments)
    modifier.limit_method = "ANGLE"
    return modifier.name


def _make_arch_ribs(scene, parent, materials, floor_bounds, side_bounds, reference_input):
    # Keep the cutaway's foreground open. Two tall roof ribs sit toward the
    # window wall, while four pilaster arches frame the retained glass rather
    # than running low bars across its pictures.
    vertices, faces, material_indices = [], [], []
    x_min, x_max = floor_bounds[0][0] + .24, floor_bounds[0][1] - .24
    wall_top = side_bounds[2][1]
    for ratio in (.74, .94):
        y = floor_bounds[1][0] + (floor_bounds[1][1] - floor_bounds[1][0]) * ratio
        _append_arch_strip(vertices, faces, material_indices, x_min, x_max, y, wall_top - .08, 1.4, .18, .20, 0, samples=48)
    for _, _, bounds in _window_info(scene, parent):
        (xmin, xmax), (ymin, ymax), (zmin, zmax) = bounds
        left, right = xmin - .18, xmax + .18
        y = ymin - .13
        shoulder = zmin + (zmax - zmin) * .64
        _append_arch_strip(vertices, faces, material_indices, left, right, y, shoulder, zmax - shoulder + .25, .18, .14, 0, samples=40)
        for x in (left, right):
            _append_box(vertices, faces, material_indices, (x, y, (shoulder + .12) / 2), (.14, .18, shoulder - .12), 0)
            _append_box(vertices, faces, material_indices, (x, y, .16), (.29, .28, .22), 1)
            _append_box(vertices, faces, material_indices, (x, y, shoulder), (.24, .25, .14), 1)
    obj = _create_mesh(scene, parent, DETAIL_PREFIX + "IvoryArchRibs", vertices, faces, (materials["ivory"], materials["brass"]), material_indices, "high roof ribs and four fitted ivory window pilaster arches", reference_input)
    if obj is not None: _bevel(obj, .015, 3)
    return [obj] if obj is not None else []


def _make_arch_ornaments(scene, parent, materials, floor_bounds, side_bounds, reference_input):
    vertices, faces, material_indices = [], [], []
    for _, _, bounds in _window_info(scene, parent):
        (xmin, xmax), (ymin, _), (_, zmax) = bounds
        x_mid, y, crown = (xmin + xmax) / 2, ymin - .23, zmax + .29
        _append_star_xz(vertices, faces, material_indices, (x_mid, y, crown), .17, .07, 0)
        for sign in (-1, 1):
            _append_leaf_xz(vertices, faces, material_indices, (x_mid + sign * .32, y, crown - .09), .09, .28, .055, 0, angle=sign * math.radians(32))
    obj = _create_mesh(scene, parent, DETAIL_PREFIX + "BrassArchStarLeafwork", vertices, faces, (materials["brass"],), material_indices, "four brass star and leaf crowns above retained window art", reference_input)
    return [obj] if obj is not None else []


def _window_info(scene, parent):
    info = []
    for index in range(1, 5):
        root = scene.objects.get(f"SV2_CabinFrontWindow_{index:02d}")
        if root is None:
            raise KeyError(f"missing stained window root: {root}")
        bounds = _bounds(root, parent)
        info.append((index, root, bounds))
    info.sort(key=lambda item: _centre(item[2])[0])
    return info


def _make_window_banners(scene, parent, materials, windows, side_bounds, reference_input):
    wall_x_min, wall_x_max = side_bounds[0]
    wall_z_min, wall_z_max = side_bounds[2]
    vertices, faces, material_indices = [], [], []
    for position, (_index, _root, bounds) in enumerate(windows):
        (xmin, xmax), (ymin, ymax), (zmin, zmax) = bounds
        if position < len(windows) - 1:
            next_bounds = windows[position + 1][2]
            gap_min, gap_max = xmax, next_bounds[0][0]
        else:
            gap_min, gap_max = xmax, wall_x_max - 0.22
        if gap_max - gap_min < 0.30:
            gap_min, gap_max = wall_x_min + 0.22, xmin
        panel_width = min(0.56, max(0.28, (gap_max - gap_min) * 0.62))
        center_x = (gap_min + gap_max) * 0.5
        top = min(zmax - 0.16, wall_z_max - 0.42)
        bottom = max(zmin + 0.42, top - 1.18)
        outline = [
            (center_x - panel_width * 0.5, top),
            (center_x + panel_width * 0.5, top),
            (center_x + panel_width * 0.5, bottom + 0.22),
            (center_x, bottom),
            (center_x - panel_width * 0.5, bottom + 0.22),
        ]
        wall_y = min(ymin, ymax) - 0.09
        _append_prism_xz(vertices, faces, material_indices, outline, wall_y, 0.09, 0)
        _append_star_xz(vertices, faces, material_indices, (center_x, wall_y - 0.065, bottom + 0.53), min(0.13, panel_width * 0.30), 0.055, 1, points=8)
        _append_leaf_xz(vertices, faces, material_indices, (center_x, wall_y - 0.066, bottom + 0.18), min(0.07, panel_width * 0.18), 0.23, 0.045, 1)
    obj = _create_mesh(scene, parent, DETAIL_PREFIX + "WindowSideBanners", vertices, faces, (materials["teal"], materials["brass"]), material_indices, "four stained-window side flags and stars", reference_input)
    return [obj] if obj is not None else []


def _make_bed_textiles(scene, parent, materials, bed_quilts, reference_input):
    vertices, faces, material_indices = [], [], []
    for index, quilt in enumerate(bed_quilts):
        bounds = _bounds(quilt, parent)
        (xmin, xmax), (ymin, ymax), (_zmin, zmax) = bounds
        width = max(0.24, (xmax - xmin) * 0.88)
        depth = max(0.30, (ymax - ymin) * 0.70)
        center_x = (xmin + xmax) * 0.5
        center_y = ymin + (ymax - ymin) * 0.56
        top = zmax + 0.025
        _append_box(vertices, faces, material_indices, (center_x, center_y, top), (width, depth, 0.045), 0)
        trim_y = center_y + depth * 0.44
        _append_box(vertices, faces, material_indices, (center_x, trim_y, top + 0.026), (width * 0.84, 0.035, 0.018), 1)
        _append_star_xy(vertices, faces, material_indices, (center_x, center_y, top + 0.057), min(width, depth) * 0.13, 0.018, 1, points=8)
    obj = _create_mesh(scene, parent, DETAIL_PREFIX + "TealBedTextiles", vertices, faces, (materials["teal"], materials["brass"]), material_indices, "deep teal blankets and brass stars on twelve retained beds", reference_input)
    if obj is not None:
        _bevel(obj, 0.012, 2)
        return [obj]
    return []


def _make_floor_compass(scene, parent, materials, floor_bounds, route_y, reference_input):
    (xmin, xmax), (ymin, ymax), (_zmin, zmax) = floor_bounds
    radius = min(1.12, (xmax - xmin) * 0.085, (ymax - ymin) * 0.11)
    center_x = (xmin + xmax) * 0.5
    center_y = max(ymin + radius + 0.16, min(ymax - radius - 0.16, route_y))
    z = zmax + 0.025
    vertices, faces, material_indices = [], [], []
    _append_ring_z(vertices, faces, material_indices, (center_x, center_y, z), radius, 0.035, 0)
    _append_ring_z(vertices, faces, material_indices, (center_x, center_y, z + 0.012), radius * 0.63, 0.022, 1)
    _append_star_xy(vertices, faces, material_indices, (center_x, center_y, z + 0.035), radius * 0.72, 0.035, 0, points=8)
    for angle in (0.0, math.pi * 0.5, math.pi, math.pi * 1.5):
        marker_radius = radius * 0.15
        _append_star_xy(
            vertices,
            faces,
            material_indices,
            (center_x + math.cos(angle) * radius * 0.87, center_y + math.sin(angle) * radius * 0.87, z + 0.033),
            marker_radius,
            0.025,
            1,
            points=4,
        )
    obj = _create_mesh(scene, parent, DETAIL_PREFIX + "FloorCompassInlay", vertices, faces, (materials["brass"], materials["teal"]), material_indices, "flush brass and teal compass floor inlay", reference_input)
    if obj is not None:
        obj["floor_inlay"] = True
        obj["route_aisle_y"] = float(route_y)
        return [obj]
    return []


def _make_floor_edges(scene, parent, materials, floor_bounds, reference_input):
    (xmin, xmax), (ymin, ymax), (_zmin, zmax) = floor_bounds
    margin = min(0.50, (xmax - xmin) * 0.04, (ymax - ymin) * 0.07)
    edge_width = min(0.16, (xmax - xmin) * 0.012)
    z = zmax + 0.036
    boxes = [
        ((xmin + margin, (ymin + ymax) * 0.5, z), (edge_width, ymax - ymin - margin * 2, 0.032), 0),
        ((xmax - margin, (ymin + ymax) * 0.5, z), (edge_width, ymax - ymin - margin * 2, 0.032), 0),
        (((xmin + xmax) * 0.5, ymin + margin, z), (xmax - xmin - margin * 2, edge_width, 0.032), 1),
        (((xmin + xmax) * 0.5, ymax - margin, z), (xmax - xmin - margin * 2, edge_width, 0.032), 1),
    ]
    vertices, faces, material_indices = [], [], []
    # The final two entries above are intentionally expanded as explicit
    # tuples below; keeping the four edge centres data-driven avoids copying
    # stale cabin coordinates from an earlier unrotated version.
    edge_specs = [
        (boxes[0], boxes[1]),
        (boxes[2], boxes[3]),
    ]
    for group in edge_specs:
        for item in group:
            center, size, material_index = item
            _append_box(vertices, faces, material_indices, center, size, material_index)
    obj = _create_mesh(scene, parent, DETAIL_PREFIX + "FloorFineEdges", vertices, faces, (materials["teal"], materials["brass"]), material_indices, "thin floor perimeter inlay", reference_input)
    if obj is not None:
        obj["floor_inlay"] = True
        _bevel(obj, 0.008, 2)
        return [obj]
    return []


def _audit_clearance(objects, parent, route_y):
    risky = []
    for obj in objects:
        role = obj.get("cabin_redesign_role", "")
        if obj.get("floor_inlay"):
            continue
        bounds = _bounds(obj, parent)
        y_min, y_max = bounds[1]
        z_min = bounds[2][0]
        if y_min - BODY_RADIUS <= route_y <= y_max + BODY_RADIUS and z_min < BODY_HEIGHT:
            # A combined mesh can contain high roof ribs over the aisle and
            # low pilasters beside distant windows. Its union box is not a
            # physical wall: inspect face bounds before declaring an intrusion.
            transform = parent.matrix_world.inverted() @ obj.matrix_world
            intrudes = False
            for polygon in obj.data.polygons:
                points = [transform @ obj.data.vertices[i].co for i in polygon.vertices]
                low_y, high_y = min(p.y for p in points), max(p.y for p in points)
                low_z, high_z = min(p.z for p in points), max(p.z for p in points)
                if low_y - BODY_RADIUS - .02 <= route_y <= high_y + BODY_RADIUS + .02 and low_z < BODY_HEIGHT + .02 and high_z > .05:
                    intrudes = True
                    break
            if intrudes:
                risky.append((obj.name, tuple(round(value, 4) for pair in bounds for value in pair), role))
    if risky:
        names = ", ".join(item[0] for item in risky)
        raise AssertionError("fairytale cabin detail entered the body-clear aisle: " + names)
    return {
        "route_aisle_y": round(float(route_y), 6),
        "body_radius": BODY_RADIUS,
        "body_height": BODY_HEIGHT,
        "floor_inlays_flush_exempt": True,
        "risky_objects": tuple(),
    }


def apply_cabin_redesign(scene, texture_path=None):
    """Add the fairytale cabin detail layer without saving or exporting.

    ``texture_path`` is retained as UTF-8 metadata for the caller's generated
    reference copy.  Existing production materials are always reused; the
    function never creates a material or changes a source mesh.
    """

    if scene is None:
        raise ValueError("apply_cabin_redesign(scene, texture_path=None) requires a Blender scene")
    parent = scene.objects.get(PARENT_NAME)
    if parent is None:
        raise KeyError("missing cabin parent: " + PARENT_NAME)
    reference_input = os.fspath(texture_path) if texture_path is not None else REFERENCE
    source_before = _source_fingerprint(scene, parent)
    materials = _materials()
    windows = _window_info(scene, parent)
    beds = []
    for index in range(12):
        quilt = scene.objects.get(f"SV3_Berth_{index}_Quilt")
        if quilt is None:
            raise KeyError(f"missing retained quilt mesh: SV3_Berth_{index}_Quilt")
        beds.append(quilt)
    lamps = [scene.objects.get(f"SV3_CabinLamp_{index}") for index in range(4)]
    if any(lamp is None for lamp in lamps):
        raise KeyError("expected four retained SV3_CabinLamp_0..3 roots")
    floor = scene.objects.get("SV2_CabinFloor")
    side_walls = scene.objects.get("SV2_CabinSideWalls")
    if floor is None or side_walls is None:
        raise KeyError("missing retained cabin floor or side walls")

    floor_bounds = _bounds(floor, parent)
    side_bounds = _bounds(side_walls, parent)
    foot_anchors = [scene.objects.get(f"SV2_Bed_{index}_FootAnchor") for index in range(12)]
    if any(anchor is None for anchor in foot_anchors):
        raise KeyError("missing one or more retained bed foot anchors")
    removed = _remove_previous_details(scene)
    route_y = sum(_centre(_bounds(anchor, parent))[1] - ROUTE_ANCHOR_FORWARD_OFFSET for anchor in foot_anchors) / len(foot_anchors)

    created = []
    try:
        created.extend(_make_arch_ribs(scene, parent, materials, floor_bounds, side_bounds, reference_input))
        created.extend(_make_arch_ornaments(scene, parent, materials, floor_bounds, side_bounds, reference_input))
        created.extend(_make_window_banners(scene, parent, materials, windows, side_bounds, reference_input))
        created.extend(_make_bed_textiles(scene, parent, materials, beds, reference_input))
        created.extend(_make_floor_compass(scene, parent, materials, floor_bounds, route_y, reference_input))
        created.extend(_make_floor_edges(scene, parent, materials, floor_bounds, reference_input))
        clearance = _audit_clearance(created, parent, route_y)
        source_after = _source_fingerprint(scene, parent)
        if source_after != source_before:
            changed = sorted(name for name in set(source_before) | set(source_after) if source_before.get(name) != source_after.get(name))
            raise AssertionError("cabin source geometry or transform changed: " + ", ".join(changed))
    except Exception:
        _remove_previous_details(scene)
        raise

    scene["cabin_redesign_reference"] = REFERENCE
    scene["cabin_redesign_revision"] = "fairytale-v1"
    scene["cabin_redesign_source_policy"] = "12 beds, 4 windows, 4 lamps and current Y+90 orientation retained"
    names = tuple(obj.name for obj in created)
    return {
        "parent": PARENT_NAME,
        "reference": REFERENCE,
        "reference_input": reference_input,
        "created_roots": names,
        "created_count": len(names),
        "removed_previous": removed,
        "preserved_counts": {"beds": len(beds), "windows": len(windows), "lamps": len(lamps)},
        "source_object_count": len(source_before),
        "source_fingerprint_before": _fingerprint_digest(source_before),
        "source_fingerprint_after": _fingerprint_digest(source_after),
        "source_fingerprint_preserved": True,
        "bounds": {
            "floor": tuple(tuple(round(value, 6) for value in pair) for pair in floor_bounds),
            "side_walls": tuple(tuple(round(value, 6) for value in pair) for pair in side_bounds),
            "route_aisle_y": round(float(route_y), 6),
        },
        "clearance_audit": clearance,
        "save_export_policy": "caller owns Blender save/export lifecycle; recipe performs neither",
    }


__all__ = ["apply_cabin_redesign", "DETAIL_PREFIX", "REFERENCE"]
