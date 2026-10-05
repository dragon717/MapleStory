"""Author cabin-to-stern/deck access only; retain the original central shell.

Source meshes/UV remain editable. The main deck stays independent; cabin17
transfers to the separately authored bow slope and tapered platform.
Runtime (x,y,z) corresponds to Blender (x,-z,y).
"""

from __future__ import annotations

import json
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[3]
DEST = ROOT / "resources/scenes/sky-voyage-v3/models"
SCENE_NAME = "SV3_ProductionRig"
SHIP_NAME = "SV2_Ship"
STRUCTURE_ROOT = "SV3_VoyageRouteStructure"
INTERIOR_ROOT = "SV3_CabinInterior"
EXTERIOR_ROOT = "SV3_Exterior"
OWNED_PREFIX = "SV3_Route_"


def runtime_to_blender(point):
    """Convert a runtime metre point to Blender's source axes."""

    x, y, z = (float(value) for value in point)
    return Vector((x, -z, y))


def _remove_tree(obj):
    for child in list(obj.children):
        _remove_tree(child)
    if obj.type == "MESH" and obj.data and obj.data.users == 1:
        bpy.data.meshes.remove(obj.data)
    try:
        bpy.data.objects.remove(obj, do_unlink=True)
    except ReferenceError:
        # A child can already have been unlinked when Blender removes a
        # duplicated collection link during the recursive walk.
        pass


def _archive_old_bridges(scene, ship):
    """Delete replaced bridge/platform assets from the editable source.

    The fused route is now the only supported implementation.  Earlier
    revisions copied the retired meshes into an archive scene, which kept a
    second platform solution in the .blend and made source inspection
    ambiguous.  Git/dated source snapshots are the recovery mechanism; the
    active blend must contain zero retired bridge, pier, rail or roof objects.
    """

    moved = []
    prefixes = (
        "SV2_CabinAftWalk_",
        "SV2_CabinAftWalkRail_",
        "SV2_CabinAftWalkPosts_",
        "SV2_CabinAftWalkSupportPiers",
        # These finish layers were authored around the rejected bridge
        # piers.  Keeping them in the production scene would leave a second
        # platform visually present even after the source bridge is removed.
        "SV3_CabinPierDetail_",
        "SV3_Repaired_SternRoofDeck",
        "Legacy_SV2_CabinAftWalk_",
        "Legacy_SV2_CabinAftWalkRail_",
        "Legacy_SV2_CabinAftWalkPosts_",
        "Legacy_SV2_CabinAftWalkSupportPiers",
        "Legacy_SV3_CabinPierDetail_",
        "Legacy_SV3_Repaired_SternRoofDeck",
        # The former continuous front wall is replaced by the real 17 door
        # opening; remove both its production names and old archive copies.
        "SV3_GlassWall_Pier_End",
        "SV3_GlassWall_Base",
        "SV3_GlassWall_Crown",
        "Legacy_SV3_GlassWall_Pier_End",
        "Legacy_SV3_GlassWall_Base",
        "Legacy_SV3_GlassWall_Crown",
    )
    # Iterate all data blocks, including objects linked only to a previous
    # archive scene.  Name-prefix matching is intentionally narrow so valid
    # cabin windows, floor and hull members stay untouched.
    for obj in list(bpy.data.objects):
        if not obj.name.startswith(prefixes):
            continue
        moved.append(obj.name)
        _remove_tree(obj)
    # Remove empty/retired archive scenes left by earlier authoring passes.
    for archive_name in ("SV3_LegacyCabinBridgeArchive", "SV3_LegacyCabinDoorWallArchive"):
        archive = bpy.data.scenes.get(archive_name)
        if archive is not None:
            bpy.data.scenes.remove(archive)
    return moved


def _remove_owned(scene):
    root = scene.objects.get(STRUCTURE_ROOT)
    if root is not None:
        _remove_tree(root)
        # Every owned route mesh is a descendant of the structure root.  Do
        # not walk the stale snapshot again after Blender has unlinked it.
        return
    for obj in list(scene.objects):
        if obj.name.startswith(OWNED_PREFIX):
            _remove_tree(obj)


def _materials():
    def required(name):
        material = bpy.data.materials.get(name)
        if material is None:
            raise KeyError(f"required voyage material missing: {name}")
        return material

    return {
        "deck": required("SV3_Prototype_DeckTeak"),
        "wood": required("SV3_Prototype_SparWood"),
        "brass": required("SV3_Prototype_BrassTrim"),
        "iron": required("SV3_Prototype_NavyIron"),
    }


def _box_mesh(name, center, size, material, parent):
    """Create a UV'd, positive-up rectangular solid in Blender axes."""

    cx, cy, cz = (float(value) for value in center)
    sx, sy, sz = (float(value) * 0.5 for value in size)
    vertices = [
        (cx - sx, cy - sy, cz - sz),
        (cx + sx, cy - sy, cz - sz),
        (cx + sx, cy + sy, cz - sz),
        (cx - sx, cy + sy, cz - sz),
        (cx - sx, cy - sy, cz + sz),
        (cx + sx, cy - sy, cz + sz),
        (cx + sx, cy + sy, cz + sz),
        (cx - sx, cy + sy, cz + sz),
    ]
    # Bottom is clockwise when viewed from above; top is counter-clockwise.
    faces = [
        (0, 1, 2, 3),
        (4, 7, 6, 5),
        (0, 4, 5, 1),
        (1, 5, 6, 2),
        (2, 6, 7, 3),
        (3, 7, 4, 0),
    ]
    mesh = bpy.data.meshes.new(name + "_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    mesh.materials.append(material)
    source_uv = mesh.uv_layers.new(name="SourceUV")
    material_uv = mesh.uv_layers.new(name="MaterialUV")
    for polygon in mesh.polygons:
        for loop_index in polygon.loop_indices:
            co = mesh.vertices[mesh.loops[loop_index].vertex_index].co
            uv = (co.x / 2.5, co.y / 2.5) if abs(polygon.normal.z) > 0.5 else (co.x / 2.5, co.z / 2.5)
            source_uv.data[loop_index].uv = uv
            material_uv.data[loop_index].uv = uv
        polygon.use_smooth = False
    material_uv.active = True
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.parent = parent
    obj["walk_surface"] = True
    obj["source_axes"] = "runtime(x,y,z) -> Blender(x,-z,y)"
    obj["structural_route_revision"] = "2026-10-05"
    return obj


def _empty(name, runtime_point, parent, **props):
    obj = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(obj)
    obj.parent = parent
    obj.location = runtime_to_blender(runtime_point)
    for key, value in props.items():
        obj[key] = value
    return obj


def _runtime_box(name, center, size, material, parent, **props):
    """A source-axis box specified in the runtime x/y/z convention."""

    # Blender stores runtime (x, y, z) as (x, -z, y).  The box helper takes
    # native Blender dimensions, so swap the vertical/depth components too.
    obj = _box_mesh(name, runtime_to_blender(center), (size[0], size[2], size[1]), material, parent)
    for key, value in props.items():
        obj[key] = value
    return obj


def _restore_window_wall(scene, cabin, materials):
    for obj in list(scene.objects):
        if obj.name.startswith("SV3_WindowWallRestored_"):
            _remove_tree(obj)
    # Close the retired window-side door, preserving all four glass openings.
    for label, center, size in (
        ("Base", (0,.5,31.78), (27,1,.42)),
        ("Crown", (0,5.85,31.78), (27,.3,.42)),
        ("EndPier", (11.65,3,31.78), (3.7,6,.42)),
    ):
        _runtime_box("SV3_WindowWallRestored_"+label, center, size, materials["wood"], cabin)


def _open_cabin_ends(scene, cabin, opening):
    from clip_voyage_hull import partition, box, build
    names = ["SV2_CabinSideWalls", "SV2_CabinSideBaseTrim_Port", "SV2_CabinSideBaseTrim_Starboard",
             "SV2_CabinSideCrown_Port", "SV2_CabinSideCrown_Starboard",
             "SV3_CabinFinish_WallBaseRails", "SV3_CabinFinish_WallCrownRails"]
    z = opening["sourceAisleZ"]; half = opening["width"]*.5
    cuts = [box((x-1,-z-half,-.2),(x+1,-z+half,opening["height"])) for x in opening["sourceX"]]
    report = []
    for name in names:
        obj = scene.objects.get(name)
        if obj is None: continue
        source_name = name+"_BeforeEndOpenings"
        old = bpy.data.meshes.get(source_name)
        if old is None:
            old = obj.data.copy(); old.name = source_name; old.use_fake_user = True
        matrix = cabin.matrix_world.inverted() @ obj.matrix_world
        inverse = matrix.inverted()
        kept = []
        for polygon in old.polygons:
            parts = [[(matrix @ old.vertices[old.loops[i].vertex_index].co,
                       [layer.data[i].uv.copy() for layer in old.uv_layers], old.corner_normals[i].vector.copy()) for i in polygon.loop_indices]]
            for cut in cuts:
                parts = [piece for part in parts for piece in partition(part, cut)[1]]
            for part in parts:
                kept.append(([(inverse @ co, uv, normal) for co,uv,normal in part],polygon.material_index,polygon.use_smooth))
        obj.data = build(name+"_EndOpenings", kept, old)
        obj["side_opening_contract"] = "both end walls open at the bed aisle; no exterior corridor"
        report.append(name)
    return {"objects": report, "source_aisle_z": z, "width": opening["width"], "height": opening["height"]}


def author(scene):
    """Only connect the longitudinal cabin to the original stern/deck."""
    layout = json.loads((ROOT / "shared/voyage-deck.json").read_text(encoding="utf-8"))
    ship = scene.objects[SHIP_NAME]
    cabin = scene.objects[INTERIOR_ROOT]
    materials = _materials()
    moved = _archive_old_bridges(scene, ship)
    _remove_owned(scene)
    for obj in list(scene.objects):
        if obj.name.startswith("SV3_CabinDoor17_"):
            _remove_tree(obj)
    frame = layout["cabinFrame"]
    pivot = runtime_to_blender(frame["pivot"])
    from mathutils import Matrix
    rotation = Matrix.Rotation(frame["rotationYRadians"], 4, "Z")
    cabin.matrix_basis = Matrix.Translation(runtime_to_blender(frame.get("translation", (0,0,0)))) @ Matrix.Translation(pivot) @ rotation @ Matrix.Translation(-pivot)
    cabin["orientation_contract"] = frame["contract"]
    cabin["rotation_y_runtime"] = frame["rotationYRadians"]
    structure = bpy.data.objects.new(STRUCTURE_ROOT, None)
    scene.collection.objects.link(structure); structure.parent = ship
    structure["route_contract"] = layout["cabinRoute"]["contract"]
    interior = bpy.data.objects.new("SV3_RouteInteriorStructure", None)
    scene.collection.objects.link(interior); interior.parent = structure
    exterior = bpy.data.objects.new("SV3_RouteExteriorStructure", None)
    scene.collection.objects.link(exterior); exterior.parent = structure
    _restore_window_wall(scene, cabin, materials)
    wall_report = _open_cabin_ends(scene, cabin, layout["cabinRoute"]["sideOpenings"])
    nodes = layout["cabinRoute"]["nodes"]
    for section, point in nodes.items():
        x,z,y=point
        _empty("SV3_RouteAnchor_"+section, (x,y,z), interior, route_section=section, fixed_curve_node=True)
    _empty("SV3_CabinEntryDoor_17", (nodes["17"][0],nodes["17"][2],nodes["17"][1]), interior, interaction="door-landing")
    target = layout["cabinRoute"]["deckExit"]["target"]
    _empty("SV3_CabinToDeckLanding", (target[0],target[2],target[1]), structure, interaction="bow-slope-landing")
    transfer = nodes["18"]
    _empty("SV3_RouteTransfer_18", (transfer[0],transfer[2],transfer[1]), interior, interaction="transfer-landing")
    return {"removed_external_objects":moved,"cabin_rotation_runtime":frame["rotationYRadians"],"route":layout["cabinRoute"]["route"],"central_shell_preserved":True,"main_deck_bow_path_removed":True,"side_openings":wall_report,"extra_corridor_meshes":0}

def save_export(scene):
    ship = scene.objects[SHIP_NAME]
    bpy.context.window.scene = scene
    scene.frame_set(1)
    bpy.context.view_layer.update()
    owned = {ship, *ship.children_recursive}
    for obj in scene.objects:
        obj.select_set(obj in owned and obj.type in {"MESH", "EMPTY"})
    bpy.context.view_layer.objects.active = ship
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.file.pack_all()
    blend_path = DEST / "sky-voyage.blend"
    glb_path = DEST / "sky-voyage.glb"
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path), compress=True)
    bpy.ops.export_scene.gltf(
        filepath=str(glb_path), export_format="GLB", use_selection=True,
        use_active_scene=True, export_yup=True, export_extras=True,
        export_apply=False, export_animations=True,
    )


if __name__ == "__main__":
    scene = bpy.data.scenes[SCENE_NAME]
    bpy.context.window.scene = scene
    report = author(scene)
    save_export(scene)
    evidence = ROOT / "evidence/2026-10-05/voyage-structural-routes"
    evidence.mkdir(parents=True, exist_ok=True)
    (evidence / "native-route-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("VOYAGE_STRUCTURAL_ROUTES_READY", json.dumps(report, ensure_ascii=False))
