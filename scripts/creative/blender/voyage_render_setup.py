"""Reusable F12 render recipe for the voyage ship and sky-city scenes.

The module has no file I/O and does not render, save, export, or open a
Blender file.  The parent task supplies an already-loaded scene and one or
more mesh roots, then calls setup_voyage_render.  The function edits only the
scene's render settings, its camera assignment, a small owned three-point
light rig, and its world background, and returns a compact report.

Examples executed inside Blender:

    report = setup_voyage_render(scene, [ship_root], kind="ship")
    top_report = setup_voyage_render(scene, [ship_root], kind="ship", view="top")
    city_report = setup_voyage_render(scene, [city_root], kind="city")

The ship default is a perspective three-quarter view.  view="top" is an
orthographic overhead alternate.  The city default is an orthographic,
oblique distant view.  A second invocation reuses the owned camera and lights
instead of creating duplicates; unrelated existing lights are left in place.
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterable
from typing import Any

import bpy
from mathutils import Matrix, Vector


_OWNER_KEY = "voyage_render_setup_owner"
_ROLE_KEY = "voyage_render_setup_role"
_KIND_KEY = "voyage_render_setup_kind"


def _enum_identifiers(owner: Any, property_name: str) -> set[str]:
    """Read enum identifiers from Blender RNA instead of assuming a version."""

    try:
        prop = owner.bl_rna.properties.get(property_name)
        if prop is None:
            return set()
        return {item.identifier for item in prop.enum_items}
    except (AttributeError, TypeError, RuntimeError):
        return set()


def _set_enum(owner: Any, property_name: str, candidates: Iterable[str]) -> str | None:
    """Set the first available enum value and return the applied identifier."""

    candidates = tuple(candidates)
    available = _enum_identifiers(owner, property_name)
    ordered = [candidate for candidate in candidates if candidate in available]
    if not ordered and not available:
        # Some Blender test doubles and older RNA wrappers do not expose the
        # enum collection.  Try the same real identifiers with guarded
        # assignment so this remains harmless when a value is unavailable.
        ordered = list(candidates)
    for value in ordered:
        try:
            setattr(owner, property_name, value)
            return value
        except (AttributeError, TypeError, ValueError, RuntimeError):
            continue
    return None


def _safe_token(value: str) -> str:
    token = re.sub(r"[^0-9A-Za-z_]+", "_", str(value)).strip("_")
    return token or "Scene"


def _as_roots(target_mesh_roots: Any) -> list[Any]:
    if target_mesh_roots is None:
        raise ValueError("target_mesh_roots is required; pass the ship or city mesh root(s)")
    if isinstance(target_mesh_roots, (str, bytes)):
        values = [target_mesh_roots]
    elif isinstance(target_mesh_roots, Iterable) and not hasattr(target_mesh_roots, "type") and not hasattr(target_mesh_roots, "objects"):
        values = list(target_mesh_roots)
    else:
        values = [target_mesh_roots]
    if not values:
        raise ValueError("target_mesh_roots is empty")
    resolved = []
    for value in values:
        if isinstance(value, bytes):
            value = value.decode("utf-8")
        if isinstance(value, str):
            original = value
            value = bpy.data.objects.get(value) or bpy.data.collections.get(value)
            if value is None:
                raise ValueError(f"target root not found: {original!r}")
        resolved.append(value)
    return resolved


def _collection_objects(collection: Any) -> list[Any]:
    result = []
    stack = [collection]
    seen = set()
    while stack:
        current = stack.pop()
        marker = id(current)
        if marker in seen:
            continue
        seen.add(marker)
        try:
            result.extend(list(current.objects))
            stack.extend(list(current.children))
        except AttributeError:
            continue
    return result


def _root_objects(roots: list[Any]) -> list[Any]:
    result = []
    seen = set()

    def walk_object(obj: Any) -> None:
        marker = id(obj)
        if marker in seen:
            return
        seen.add(marker)
        result.append(obj)
        try:
            children = list(obj.children)
        except AttributeError:
            children = []
        for child in children:
            walk_object(child)

    for root in roots:
        if hasattr(root, "type"):
            walk_object(root)
        elif hasattr(root, "objects"):
            for obj in _collection_objects(root):
                walk_object(obj)
        else:
            raise TypeError(f"unsupported target root: {root!r}")
    return result


def _world_points(scene: Any, roots: list[Any]) -> list[Vector]:
    points = []
    depsgraph = None
    try:
        depsgraph = scene.evaluated_depsgraph_get()
    except (AttributeError, RuntimeError):
        pass
    for obj in _root_objects(roots):
        if getattr(obj, "hide_render", False):
            continue
        if getattr(obj, "type", None) not in {"MESH", "CURVE", "SURFACE", "FONT", "META"}:
            continue
        try:
            evaluated = obj.evaluated_get(depsgraph) if depsgraph is not None else obj
        except (AttributeError, RuntimeError):
            evaluated = obj
        try:
            corners = list(evaluated.bound_box)
            matrix = evaluated.matrix_world
        except (AttributeError, TypeError, RuntimeError):
            continue
        if not corners:
            continue
        for corner in corners:
            points.append(matrix @ Vector(corner))
    if not points:
        raise ValueError("target roots contain no visible mesh/curve bounds")
    return points


def _bounds(points: list[Vector]) -> tuple[Vector, Vector, Vector, float]:
    low = Vector((
        min(point.x for point in points),
        min(point.y for point in points),
        min(point.z for point in points),
    ))
    high = Vector((
        max(point.x for point in points),
        max(point.y for point in points),
        max(point.z for point in points),
    ))
    center = (low + high) * 0.5
    radius = max((point - center).length for point in points)
    return low, high, center, max(radius, 0.5)


def _basis(view_direction: Vector, up_hint: Vector) -> tuple[Vector, Vector, Vector]:
    """Return camera forward, right, and up for a target-to-camera direction."""

    view_direction = view_direction.normalized()
    forward = -view_direction
    right = forward.cross(up_hint)
    if right.length < 1.0e-5:
        right = forward.cross(Vector((0.0, 1.0, 0.0)))
    if right.length < 1.0e-5:
        right = forward.cross(Vector((1.0, 0.0, 0.0)))
    right.normalize()
    up = right.cross(forward).normalized()
    return forward, right, up


def _look_at(obj: Any, location: Vector, target: Vector, up_hint: Vector) -> None:
    forward = (target - location).normalized()
    right = forward.cross(up_hint)
    if right.length < 1.0e-5:
        right = forward.cross(Vector((0.0, 1.0, 0.0)))
    if right.length < 1.0e-5:
        right = forward.cross(Vector((1.0, 0.0, 0.0)))
    right.normalize()
    up = right.cross(forward).normalized()
    matrix = Matrix((right, up, -forward)).transposed().to_4x4()
    matrix.translation = location
    obj.matrix_world = matrix


def _bounds_in_basis(points: list[Vector], target: Vector, right: Vector, up: Vector, forward: Vector) -> dict[str, float]:
    horizontal = [(point - target).dot(right) for point in points]
    vertical = [(point - target).dot(up) for point in points]
    depth = [(point - target).dot(forward) for point in points]
    return {
        "horizontal": max(horizontal) - min(horizontal),
        "vertical": max(vertical) - min(vertical),
        "depth": max(depth) - min(depth),
        "depth_radius": max(abs(value) for value in depth),
    }


def _camera_fovs(camera_data: Any, aspect: float) -> tuple[float, float]:
    try:
        horizontal = float(camera_data.angle_x)
        vertical = float(camera_data.angle_y)
        if horizontal > 0.01 and vertical > 0.01:
            return horizontal, vertical
    except (AttributeError, TypeError, ValueError, RuntimeError):
        pass
    horizontal = math.radians(42.0)
    vertical = 2.0 * math.atan(math.tan(horizontal * 0.5) / max(aspect, 0.01))
    return horizontal, vertical


def _fit_camera(
    camera: Any,
    points: list[Vector],
    target: Vector,
    view_direction: Vector,
    up_hint: Vector,
    perspective: bool,
    aspect: float,
    padding: float,
) -> dict[str, float]:
    forward, right, up = _basis(view_direction, up_hint)
    extents = _bounds_in_basis(points, target, right, up, forward)
    if perspective:
        horizontal_fov, vertical_fov = _camera_fovs(camera.data, aspect)
        half_horizontal = extents["horizontal"] * 0.5 * padding
        half_vertical = extents["vertical"] * 0.5 * padding
        required = max(
            half_horizontal / max(math.tan(horizontal_fov * 0.5), 1.0e-4),
            half_vertical / max(math.tan(vertical_fov * 0.5), 1.0e-4),
        )
        distance = required + extents["depth_radius"] * padding + 0.5
        camera.data.type = "PERSP"
        camera.location = target + view_direction.normalized() * distance
        _look_at(camera, camera.location, target, up_hint)
        camera.data.clip_start = max(0.01, distance * 0.001)
        camera.data.clip_end = max(100.0, distance + extents["depth_radius"] * 3.0)
        return {
            "distance": float(distance),
            "horizontal_fov_degrees": math.degrees(horizontal_fov),
            "vertical_fov_degrees": math.degrees(vertical_fov),
            "fit_width": float(extents["horizontal"] * padding),
            "fit_height": float(extents["vertical"] * padding),
        }

    camera.data.type = "ORTHO"
    camera.data.ortho_scale = max(
        extents["horizontal"] * padding,
        extents["vertical"] * aspect * padding,
        1.0,
    )
    distance = max(extents["depth_radius"] * 3.0, 100.0)
    camera.location = target + view_direction.normalized() * distance
    _look_at(camera, camera.location, target, up_hint)
    camera.data.clip_start = max(0.01, distance * 0.001)
    camera.data.clip_end = max(100.0, distance + extents["depth_radius"] * 4.0)
    return {
        "distance": float(distance),
        "ortho_scale": float(camera.data.ortho_scale),
        "fit_width": float(extents["horizontal"] * padding),
        "fit_height": float(extents["vertical"] * padding),
    }


def _owned_object(scene: Any, role: str, object_type: str) -> Any | None:
    for obj in scene.objects:
        if (
            getattr(obj, "type", None) == object_type
            and obj.get(_OWNER_KEY) == scene.name
            and obj.get(_ROLE_KEY) == role
        ):
            return obj
    return None


def _unique_object_name(base: str) -> str:
    if bpy.data.objects.get(base) is None:
        return base
    index = 1
    while bpy.data.objects.get(f"{base}.{index:03d}") is not None:
        index += 1
    return f"{base}.{index:03d}"


def _link_to_scene(scene: Any, obj: Any) -> None:
    if not any(collection == scene.collection for collection in obj.users_collection):
        scene.collection.objects.link(obj)


def _ensure_camera(scene: Any, kind: str) -> Any:
    camera = _owned_object(scene, "camera", "CAMERA")
    if camera is None:
        base = f"VoyageRender_{_safe_token(scene.name)}_Camera"
        data = bpy.data.cameras.new(f"{base}_Data")
        camera = bpy.data.objects.new(_unique_object_name(base), data)
        scene.collection.objects.link(camera)
        camera[_OWNER_KEY] = scene.name
        camera[_ROLE_KEY] = "camera"
        camera[_KIND_KEY] = kind
    else:
        _link_to_scene(scene, camera)
    camera.hide_render = False
    camera.hide_viewport = False
    try:
        camera.data.dof.use_dof = False
    except (AttributeError, RuntimeError):
        pass
    scene.camera = camera
    return camera


def _ensure_area_light(scene: Any, role: str, kind: str) -> Any:
    light = _owned_object(scene, role, "LIGHT")
    if light is None:
        base = f"VoyageRender_{_safe_token(scene.name)}_{role.title()}"
        data = bpy.data.lights.new(f"{base}_Data", "AREA")
        light = bpy.data.objects.new(_unique_object_name(base), data)
        scene.collection.objects.link(light)
        light[_OWNER_KEY] = scene.name
        light[_ROLE_KEY] = role
        light[_KIND_KEY] = kind
    else:
        _link_to_scene(scene, light)
    light.hide_render = False
    light.hide_viewport = False
    try:
        light.data.type = "AREA"
    except (AttributeError, RuntimeError):
        pass
    return light


def _configure_three_point_lights(scene: Any, kind: str, target: Vector, radius: float) -> list[Any]:
    # Energy and area size scale with bounds so both the ship and the much
    # larger city remain readable without hard-coded scene dimensions.
    size = max(radius * (0.68 if kind == "ship" else 0.34), 2.0)
    scale = max(radius / 20.0, 0.5)
    base_energy = (12000.0 if kind == "ship" else 3600.0) * scale * scale
    definitions = (
        ("key", Vector((-0.95, -1.15, 1.45)), 1.00, (1.00, 0.86, 0.70), 1.00),
        ("fill", Vector((1.20, -0.35, 0.70)), 0.48, (0.67, 0.82, 1.00), 1.28),
        ("rim", Vector((0.35, 1.15, 1.20)), 0.72, (0.78, 0.88, 1.00), 0.92),
    )
    result = []
    for role, direction, energy_factor, color, distance_factor in definitions:
        light = _ensure_area_light(scene, role, kind)
        distance = max(radius * (2.2 if kind == "ship" else 2.8) * distance_factor, 8.0)
        location = target + direction.normalized() * distance
        _look_at(light, location, target, Vector((0.0, 0.0, 1.0)))
        data = light.data
        try:
            data.energy = base_energy * energy_factor
            data.color = color
            data.shape = "DISK"
            data.size = size
        except (AttributeError, TypeError, ValueError, RuntimeError):
            pass
        result.append(light)
    return result


def _configure_world(scene: Any, kind: str) -> Any:
    if scene.world is None:
        world_name = f"VoyageRender_{_safe_token(scene.name)}_World"
        scene.world = bpy.data.worlds.new(world_name)
    world = scene.world
    world.use_nodes = True
    background = next((node for node in world.node_tree.nodes if node.type == "BACKGROUND"), None)
    if background is not None:
        if kind == "city":
            color = (0.09, 0.15, 0.25, 1.0)
            strength = 0.48
        else:
            color = (0.055, 0.085, 0.14, 1.0)
            strength = 0.40
        background.inputs["Color"].default_value = color
        background.inputs["Strength"].default_value = strength
    return world


def _configure_render(scene: Any, kind: str, resolution: tuple[int, int] | None) -> tuple[int, int, str | None]:
    if resolution is None:
        resolution = (1600, 1000) if kind == "ship" else (1920, 1200)
    width, height = (max(int(resolution[0]), 1), max(int(resolution[1]), 1))
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    engine = _set_enum(scene.render, "engine", ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT", "CYCLES"))
    _set_enum(scene.render.image_settings, "file_format", ("PNG", "OPEN_EXR", "JPEG"))
    try:
        scene.render.film_transparent = False
    except (AttributeError, TypeError):
        pass
    try:
        scene.view_settings.exposure = 0.0
    except (AttributeError, TypeError):
        pass
    _set_enum(scene.view_settings, "view_transform", ("AgX", "Standard", "Filmic"))
    _set_enum(scene.view_settings, "look", ("AgX - Medium High Contrast", "Medium High Contrast", "None"))
    return width, height, engine


def setup_voyage_render(
    scene: Any,
    target_mesh_roots: Any,
    *,
    kind: str = "ship",
    view: str = "default",
    resolution: tuple[int, int] | None = None,
    padding: float = 1.16,
) -> dict[str, Any]:
    """Apply the repeatable voyage F12 recipe to an already-loaded scene.

    target_mesh_roots may contain Blender objects, object names, a collection,
    or collection names.  Bounds include visible mesh descendants of those
    roots.  kind is "ship" or "city".  For a ship, view="default" is a
    perspective three-quarter view and view="top" is an overhead alternate.
    A city uses the oblique orthographic distant view by default.
    """

    if kind not in {"ship", "city"}:
        raise ValueError(f"kind must be 'ship' or 'city', got {kind!r}")
    if view not in {"default", "top"}:
        raise ValueError(f"view must be 'default' or 'top', got {view!r}")
    if not 1.0 <= float(padding) <= 2.0:
        raise ValueError("padding must be between 1.0 and 2.0")

    roots = _as_roots(target_mesh_roots)
    points = _world_points(scene, roots)
    low, high, target, radius = _bounds(points)
    width, height, engine = _configure_render(scene, kind, resolution)
    camera = _ensure_camera(scene, kind)
    camera.data.lens = 52.0
    camera.data.sensor_width = 36.0
    aspect = width / max(height, 1)

    if kind == "ship" and view == "default":
        view_direction = Vector((1.18, -1.0, 0.62))
        up_hint = Vector((0.0, 0.0, 1.0))
        perspective = True
    elif view == "top":
        view_direction = Vector((0.035, -0.075, 1.0))
        up_hint = Vector((0.0, -1.0, 0.0))
        perspective = False
    else:
        # The city default is deliberately a distant, map-like oblique plate.
        view_direction = Vector((0.88, -1.0, 0.78))
        up_hint = Vector((0.0, 0.0, 1.0))
        perspective = False

    fit = _fit_camera(camera, points, target, view_direction, up_hint, perspective, aspect, float(padding))
    lights = _configure_three_point_lights(scene, kind, target, radius)
    world = _configure_world(scene, kind)

    report = {
        "scene": scene.name,
        "kind": kind,
        "view": view,
        "render_engine": scene.render.engine,
        "resolution": (width, height),
        "aspect": round(aspect, 5),
        "camera": camera.name,
        "camera_type": camera.data.type,
        "lights": [light.name for light in lights],
        "existing_lights_preserved": sum(1 for obj in scene.objects if obj.type == "LIGHT") - len(lights),
        "world": world.name,
        "bounds_min": tuple(round(float(value), 4) for value in low),
        "bounds_max": tuple(round(float(value), 4) for value in high),
        "target": tuple(round(float(value), 4) for value in target),
        "radius": round(float(radius), 4),
        "fit": {key: round(float(value), 4) for key, value in fit.items()},
    }
    return report


def setup_ship_render(scene: Any, target_mesh_roots: Any, **kwargs: Any) -> dict[str, Any]:
    """Convenience wrapper for the ship's default or overhead F12 recipe."""

    return setup_voyage_render(scene, target_mesh_roots, kind="ship", **kwargs)


def setup_city_render(scene: Any, target_mesh_roots: Any, **kwargs: Any) -> dict[str, Any]:
    """Convenience wrapper for the city's default oblique distant F12 recipe."""

    return setup_voyage_render(scene, target_mesh_roots, kind="city", **kwargs)
