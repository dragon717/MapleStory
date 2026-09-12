"""Build the editable Windbell Bridge / Windbell Island asset library.

This file is intentionally pure bpy code so it can be sent through the
official blender-mcp ``execute_blender_code`` tool.  It does not read project
files or contact any asset service.  All geometry is procedural and remains
editable in the resulting .blend.

Coordinate convention: X is horizontal, Z is up, Y is depth.  Materials,
state collections and object custom properties are the hand-off contract to
the Phaser/2.5D renderer; this asset pack is not wired into the game.
"""

import bpy
import math
from mathutils import Vector


ROOT = "/Users/muniao/Library/Mobile Documents/com~apple~CloudDocs/游戏/github/MapleStory/resources/creative/windbell/blender"
RENDER_ROOT = ROOT + "/renders/"
GLB_ROOT = ROOT + "/glb/"
BLEND_PATH = ROOT + "/windbell_world_asset_library.blend"


PALETTE = {
    "sky": ((0.28, 0.56, 0.78, 1.0), 0.95, 0.0),
    "cloud": ((0.92, 0.94, 0.88, 1.0), 0.9, 0.0),
    "mountain": ((0.27, 0.45, 0.54, 1.0), 0.96, 0.0),
    "grass": ((0.30, 0.52, 0.16, 1.0), 0.92, 0.0),
    "grass_light": ((0.52, 0.70, 0.24, 1.0), 0.9, 0.0),
    "moss": ((0.17, 0.36, 0.13, 1.0), 0.95, 0.0),
    "soil": ((0.25, 0.15, 0.09, 1.0), 0.98, 0.0),
    "rock": ((0.39, 0.43, 0.41, 1.0), 0.96, 0.0),
    "rock_light": ((0.60, 0.61, 0.51, 1.0), 0.88, 0.0),
    "water": ((0.05, 0.36, 0.61, 1.0), 0.25, 0.0),
    "wood": ((0.38, 0.19, 0.08, 1.0), 0.82, 0.0),
    "wood_light": ((0.68, 0.39, 0.16, 1.0), 0.78, 0.0),
    "wood_dark": ((0.19, 0.09, 0.045, 1.0), 0.9, 0.0),
    "rope": ((0.29, 0.16, 0.07, 1.0), 0.88, 0.0),
    "rope_worn": ((0.50, 0.29, 0.11, 1.0), 0.88, 0.0),
    "rope_char": ((0.045, 0.025, 0.015, 1.0), 0.98, 0.0),
    "dry": ((0.72, 0.48, 0.19, 1.0), 0.86, 0.0),
    "ember": ((0.90, 0.15, 0.025, 1.0), 0.55, 0.0),
    "wet": ((0.12, 0.30, 0.28, 1.0), 0.4, 0.0),
    "leaf": ((0.23, 0.53, 0.16, 1.0), 0.86, 0.0),
    "leaf_dark": ((0.09, 0.29, 0.12, 1.0), 0.91, 0.0),
    "leaf_yellow": ((0.72, 0.78, 0.18, 1.0), 0.85, 0.0),
    "copper": ((0.71, 0.33, 0.08, 1.0), 0.35, 0.72),
    "gold": ((0.90, 0.59, 0.15, 1.0), 0.3, 0.72),
    "lantern": ((1.0, 0.28, 0.035, 1.0), 0.28, 0.0),
    "cloth": ((0.52, 0.12, 0.10, 1.0), 0.82, 0.0),
    "cloth_teal": ((0.09, 0.33, 0.35, 1.0), 0.8, 0.0),
    "wing": ((0.30, 0.68, 0.36, 1.0), 0.52, 0.0),
    "fire": ((1.0, 0.17, 0.018, 1.0), 0.32, 0.0),
    "steam": ((0.64, 0.83, 0.82, 1.0), 0.4, 0.0),
}

MATS = {}


def material(name, color, roughness=0.8, metallic=0.0, emission=None):
    if name in MATS:
        return MATS[name]
    m = bpy.data.materials.new(name)
    m.diffuse_color = color
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs.get("Base Color").default_value = color
        bsdf.inputs.get("Roughness").default_value = roughness
        bsdf.inputs.get("Metallic").default_value = metallic
        if emission:
            e = bsdf.inputs.get("Emission Color") or bsdf.inputs.get("Emission")
            if e:
                e.default_value = emission
            strength = bsdf.inputs.get("Emission Strength")
            if strength:
                strength.default_value = 4.0
    MATS[name] = m
    return m


def make_materials():
    for name, (color, rough, metal) in PALETTE.items():
        emission = color if name in ("lantern", "fire", "ember", "steam") else None
        material("WB_MAT_" + name, color, rough, metal, emission)


def mat(name):
    return MATS["WB_MAT_" + name]


def new_collection(name, parent=None):
    c = bpy.data.collections.new(name)
    (parent or bpy.context.scene.collection).children.link(c)
    return c


def link_to(obj, collection):
    for old in list(obj.users_collection):
        old.objects.unlink(obj)
    collection.objects.link(obj)
    return obj


def set_meta(obj, kind, state="shared", layer="interactive", anchor=None):
    obj["asset_kind"] = kind
    obj["world_state"] = state
    obj["render_layer"] = layer
    obj["axis_convention"] = "X horizontal / Z up / Y depth"
    if anchor:
        obj["anchor"] = anchor
    return obj


def bevel(obj, width=0.12, segments=2):
    if width <= 0:
        return obj
    mod = obj.modifiers.new("soft_edge", "BEVEL")
    mod.width = width
    mod.segments = segments
    return obj


def cube(name, loc, size, collection, material_name, rotation=(0, 0, 0), bevel_width=0.1, kind="prop", state="shared"):
    bpy.ops.mesh.primitive_cube_add(location=loc)
    o = bpy.context.object
    o.name = name
    o.dimensions = size
    o.rotation_euler = rotation
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    o.data.materials.append(mat(material_name))
    bevel(o, bevel_width)
    link_to(o, collection)
    return set_meta(o, kind, state)


def sphere(name, loc, scale, collection, material_name, kind="prop", state="shared"):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=1, location=loc)
    o = bpy.context.object
    o.name = name
    o.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    o.data.materials.append(mat(material_name))
    link_to(o, collection)
    return set_meta(o, kind, state)


def cone(name, loc, radius, depth, collection, material_name, vertices=8, pointed=False, kind="prop", state="shared"):
    bpy.ops.mesh.primitive_cone_add(vertices=vertices, radius1=radius, radius2=0.0 if pointed else radius * 0.78, depth=depth, location=loc)
    o = bpy.context.object
    o.name = name
    o.data.materials.append(mat(material_name))
    link_to(o, collection)
    bevel(o, 0.04, 1)
    return set_meta(o, kind, state)


def cylinder_between(name, a, b, radius, collection, material_name, kind="prop", state="shared"):
    va, vb = Vector(a), Vector(b)
    direction = vb - va
    bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=radius, depth=direction.length, location=(va + vb) / 2)
    o = bpy.context.object
    o.name = name
    o.rotation_mode = "QUATERNION"
    o.rotation_quaternion = direction.to_track_quat("Z", "Y")
    o.rotation_mode = "XYZ"
    o.data.materials.append(mat(material_name))
    link_to(o, collection)
    bevel(o, min(radius * 0.32, 0.08), 2)
    return set_meta(o, kind, state)


def torus(name, loc, major, minor, collection, material_name, rotation=(0, 0, 0), kind="prop", state="shared"):
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, major_segments=16, minor_segments=6, location=loc, rotation=rotation)
    o = bpy.context.object
    o.name = name
    o.data.materials.append(mat(material_name))
    link_to(o, collection)
    return set_meta(o, kind, state)


def curve(name, points, collection, material_name, radius=0.07, kind="prop", state="shared"):
    data = bpy.data.curves.new(name + "_curve", "CURVE")
    data.dimensions = "3D"
    data.resolution_u = 2
    data.bevel_depth = radius
    data.bevel_resolution = 3
    spline = data.splines.new("BEZIER")
    spline.bezier_points.add(len(points) - 1)
    for p, co in zip(spline.bezier_points, points):
        p.co = co
        p.handle_left_type = "AUTO"
        p.handle_right_type = "AUTO"
    o = bpy.data.objects.new(name, data)
    collection.objects.link(o)
    o.data.materials.append(mat(material_name))
    return set_meta(o, kind, state)


def parent_keep_world(obj, parent):
    obj.parent = parent
    obj.matrix_parent_inverse = parent.matrix_world.inverted()


def empty(name, loc, collection, kind="rig", state="shared"):
    o = bpy.data.objects.new(name, None)
    o.empty_display_type = "CUBE"
    o.empty_display_size = 0.45
    o.location = loc
    collection.objects.link(o)
    return set_meta(o, kind, state)


def camera(scene, name, loc, target, ortho):
    data = bpy.data.cameras.new(name + "_data")
    data.type = "ORTHO"
    data.ortho_scale = ortho
    o = bpy.data.objects.new(name, data)
    scene.collection.objects.link(o)
    o.location = loc
    o.rotation_euler = (Vector(target) - o.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera = o
    return o


def light(scene, name, loc, energy, color, size=5.0, kind="AREA"):
    data = bpy.data.lights.new(name + "_data", kind)
    data.energy = energy
    data.color = color
    if kind == "AREA":
        data.shape = "DISK"
        data.size = size
    o = bpy.data.objects.new(name, data)
    scene.collection.objects.link(o)
    o.location = loc
    o.rotation_euler = (Vector((0, 0, 5)) - o.location).to_track_quat("-Z", "Y").to_euler()
    return o


def setup_scene(scene, title, resolution=(1280, 720), transparent=False):
    try:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    except Exception:
        scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = resolution
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = transparent
    scene.render.filepath = RENDER_ROOT + title + ".png"
    if scene.world is None:
        scene.world = bpy.data.worlds.new(title + "_World")
    # A readable MapleStory-like daylight wash keeps the forest silhouettes and
    # grass banks legible when the scene is viewed as a 2.5D orthographic plate.
    scene.world.color = (0.22, 0.43, 0.62)
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes.get("Background")
    if background:
        background.inputs["Color"].default_value = (0.22, 0.43, 0.62, 1.0)
        background.inputs["Strength"].default_value = 0.55
    try:
        scene.view_settings.look = "AgX - Medium High Contrast"
    except Exception:
        pass
    return scene


def terrain_patch(collection, name, x, z, width, depth=5, height=1.5):
    cube(name + "_soil", (x, 1.4, z), (width, depth, height), collection, "soil", bevel_width=0.28, kind="terrain")
    cube(name + "_grass_cap", (x, 1.35, z + height / 2 + 0.12), (width * 0.98, depth * 0.98, 0.26), collection, "grass", bevel_width=0.12, kind="terrain")
    for i in range(3):
        sphere(name + "_moss_" + str(i), (x - width * 0.32 + i * width * 0.3, 0.2, z + height / 2 + 0.31), (0.7, 0.45, 0.18), collection, "grass_light", kind="foliage")


def rock_cluster(collection, name, x, z, count=5, y=0.8):
    for i in range(count):
        angle = i * 1.77
        rx = 0.45 + (i % 3) * 0.22
        rz = 0.36 + ((i + 1) % 3) * 0.18
        sphere(name + "_rock_" + str(i), (x + math.cos(angle) * (0.8 + i * 0.18), y - (i % 2) * 0.5, z + math.sin(angle) * 0.55), (rx, 0.55, rz), collection, "rock_light" if i % 2 else "rock", kind="terrain")


def tree(collection, name, x, z, scale=1.0):
    cylinder_between(name + "_trunk", (x, 3.4, z - 3.4 * scale), (x - 1.1 * scale, 3.8, z + 5.3 * scale), 1.2 * scale, collection, "wood_dark", kind="tree")
    cylinder_between(name + "_branch_a", (x - 0.3, 3.4, z + 2.4 * scale), (x - 4.5 * scale, 3.7, z + 5.4 * scale), 0.48 * scale, collection, "wood", kind="tree")
    cylinder_between(name + "_branch_b", (x - 0.8, 3.5, z + 3.5 * scale), (x + 3.4 * scale, 3.5, z + 6.4 * scale), 0.42 * scale, collection, "wood", kind="tree")
    for i in range(8):
        a = i * 0.77
        sphere(name + "_canopy_" + str(i), (x - 1.4 * scale + math.cos(a) * 3.8 * scale, 3.2 + math.sin(a) * 0.5, z + 5.4 * scale + math.sin(a * 1.6) * 1.8 * scale), (2.1 * scale, 1.25 * scale, 1.7 * scale), collection, "leaf" if i % 3 else "leaf_yellow", kind="foliage")


def river(collection, name, x, z, width=25):
    cube(name + "_water", (x, 2.0, z), (width, 7.0, 0.22), collection, "water", bevel_width=0.08, kind="water")
    for i in range(8):
        x2 = x - width * 0.44 + i * width * 0.12
        curve(name + "_wave_" + str(i), [(x2, -1.7, z + 0.06), (x2 + 0.7, -1.72, z + 0.12), (x2 + 1.5, -1.69, z + 0.03)], collection, "cloud", radius=0.035, kind="water_fx")
    for i in range(10):
        rock_cluster(collection, name + "_island_" + str(i), x - width * 0.44 + i * 2.3, z + 0.2 + (i % 2) * 0.7, count=3, y=0.1)


def bell(collection, name, loc, scale=1.0):
    x, y, z = loc
    cylinder_between(name + "_rope", (x, y, z + 1.1 * scale), (x, y, z + 0.3 * scale), 0.035 * scale, collection, "rope", kind="bell")
    torus(name + "_bell", (x, y, z), 0.38 * scale, 0.12 * scale, collection, "copper", kind="bell")
    sphere(name + "_clapper", (x, y, z - 0.15 * scale), (0.12 * scale, 0.12 * scale, 0.16 * scale), collection, "gold", kind="bell")


def lantern(collection, name, loc, scale=1.0):
    cube(name + "_frame", loc, (0.55 * scale, 0.45 * scale, 0.68 * scale), collection, "wood_dark", bevel_width=0.08, kind="lantern")
    cube(name + "_glow", (loc[0], loc[1] - 0.03, loc[2]), (0.32 * scale, 0.12 * scale, 0.4 * scale), collection, "lantern", bevel_width=0.04, kind="lantern")


def bridge_segment(collection, name, start_x, end_x, z, y, broken=False, state="broken"):
    rig = empty(name + "_RIG", (start_x, y, z), collection, kind="bridge_rig", state=state)
    rig["hinge_axis"] = "Y"
    rig["state_transition"] = "broken -> working -> connected -> inhabited"
    angle = math.radians(22 if broken else 0)
    rig.rotation_euler[1] = angle
    rig.keyframe_insert(data_path="rotation_euler", index=1, frame=1)
    rig.rotation_euler[1] = math.radians(7 if broken else 0)
    rig.keyframe_insert(data_path="rotation_euler", index=1, frame=20)
    rig.rotation_euler[1] = 0
    rig.keyframe_insert(data_path="rotation_euler", index=1, frame=40)
    count = max(2, int((end_x - start_x) / 1.05))
    for i in range(count + 1):
        px = start_x + (end_x - start_x) * i / count
        pl = cube(name + "_plank_" + str(i), (px, y, z), (1.0, 1.9, 0.28), collection, "wood_light", bevel_width=0.11, kind="bridge_plank", state=state)
        parent_keep_world(pl, rig)
        cube(name + "_nail_" + str(i), (px, y - 0.92, z + 0.2), (0.11, 0.08, 0.08), collection, "copper", bevel_width=0.03, kind="bridge_detail", state=state)
    cylinder_between(name + "_beam_front", (start_x - 0.4, y - 0.65, z - 0.48), (end_x + 0.4, y - 0.65, z - 0.48), 0.22, collection, "wood_dark", kind="bridge_beam", state=state)
    cylinder_between(name + "_beam_back", (start_x - 0.4, y + 0.65, z - 0.48), (end_x + 0.4, y + 0.65, z - 0.48), 0.22, collection, "wood_dark", kind="bridge_beam", state=state)
    return rig


def bridge_rope(collection, name, points, rope_material, state):
    o = curve(name, points, collection, rope_material, radius=0.105, kind="rope", state=state)
    o["state_variants"] = "complete / worn / severed / charred"
    return o


def bridge_support(collection, name, x, z, state):
    cylinder_between(name + "_post", (x, 0.3, z - 2.3), (x, 0.3, z + 0.5), 0.26, collection, "wood_dark", kind="bridge_support", state=state)
    cylinder_between(name + "_brace_a", (x, 0.3, z - 1.8), (x + 1.4, 0.3, z - 0.4), 0.15, collection, "wood", kind="bridge_support", state=state)
    cylinder_between(name + "_brace_b", (x, 0.3, z - 1.8), (x - 1.4, 0.3, z - 0.4), 0.15, collection, "wood", kind="bridge_support", state=state)


def cart(collection, name, x, z, upright=True, state="broken"):
    angle = math.radians(-5 if upright else -18)
    body = cube(name + "_body", (x, -0.3, z), (3.2, 1.9, 1.35), collection, "wood", rotation=(0, angle, 0), bevel_width=0.17, kind="cart", state=state)
    cube(name + "_rim", (x - 0.2, -0.3, z + 0.72), (2.6, 1.6, 0.2), collection, "wood_light", rotation=(0, angle, 0), bevel_width=0.07, kind="cart", state=state)
    for side in (-1, 1):
        wheel_x = x - 1.0 + side * 0.25
        torus(name + "_wheel_" + str(side), (wheel_x, -1.4, z - 0.95), 0.95, 0.15, collection, "wood_dark", rotation=(math.radians(90), 0, 0), kind="cart_wheel", state=state)
        for i in range(6):
            a = i * math.pi / 3
            cylinder_between(name + "_spoke_" + str(side) + "_" + str(i), (wheel_x, -1.43, z - 0.95), (wheel_x + math.cos(a) * 0.76, -1.43, z - 0.95 + math.sin(a) * 0.76), 0.065, collection, "wood_light", kind="cart_wheel", state=state)
    for i in range(4):
        cube(name + "_crate_" + str(i), (x - 0.8 + (i % 2) * 0.95, -0.3, z + 1.1 + (i // 2) * 0.62), (0.8, 1.3, 0.5), collection, "wood_light", rotation=(0, angle, 0), bevel_width=0.08, kind="cargo", state=state)
    return body


def shelter(collection, name, x, z, state="shared"):
    for side in (-1, 1):
        cylinder_between(name + "_post_" + str(side), (x + side * 2.0, 0.6, z - 2.3), (x + side * 2.0, 0.6, z + 2.4), 0.24, collection, "wood_dark", kind="shelter", state=state)
    cube(name + "_bench", (x, -0.05, z - 1.2), (3.2, 1.0, 0.35), collection, "wood_light", bevel_width=0.08, kind="shelter", state=state)
    cube(name + "_beam", (x, 0.6, z + 2.25), (4.8, 1.1, 0.35), collection, "wood", bevel_width=0.08, kind="shelter", state=state)
    cube(name + "_roof", (x, 0.5, z + 3.15), (5.6, 2.8, 0.34), collection, "wood_light", rotation=(0, math.radians(-8), 0), bevel_width=0.16, kind="shelter_roof", state=state)
    for i in range(5):
        cube(name + "_roof_tile_" + str(i), (x - 2.15 + i * 1.1, -0.3, z + 3.38), (0.95, 2.6, 0.11), collection, "cloth_teal" if i % 2 else "wood_dark", rotation=(0, math.radians(-8), 0), bevel_width=0.04, kind="shelter_roof", state=state)
    cube(name + "_warm_window", (x, -0.28, z + 0.55), (1.4, 0.18, 1.1), collection, "lantern", bevel_width=0.1, kind="shelter_window", state=state)
    lantern(collection, name + "_lantern", (x - 1.45, -0.25, z + 0.2), 0.8)
    bell(collection, name + "_bell", (x + 1.55, -0.45, z + 0.3), 1.0)
    return set_meta(bpy.data.objects[name + "_beam"], "shelter", state)


def leaf(collection, name, loc, scale, material_name="leaf", rotation=(0, 0, 0), state="shared", kind="foliage"):
    o = sphere(name, loc, scale, collection, material_name, kind=kind, state=state)
    o.rotation_euler = rotation
    return o


def dry_branch(collection, name, x, z, state="dry"):
    pts = [(x - 1.8, -1.0, z), (x - 0.7, -1.1, z + 0.5), (x + 0.2, -1.0, z - 0.1), (x + 1.5, -1.05, z + 0.62)]
    o = curve(name, pts, collection, "dry" if state in ("dry", "heated") else "ember", radius=0.18, kind="dry_branch", state=state)
    o["state_variants"] = "dry / heated / burning / ember"
    if state in ("burning", "ember"):
        for i in range(3):
            sphere(name + "_ember_" + str(i), (x - 0.8 + i * 0.7, -1.0, z + 0.5), (0.18, 0.12, 0.28), collection, "fire" if state == "burning" else "ember", kind="heat_fx", state=state)
    return o


def wet_wood(collection, name, x, z, state="wet"):
    o = cylinder_between(name, (x - 1.3, -0.8, z), (x + 1.4, -0.8, z + 0.35), 0.28, collection, "wet" if state == "wet" else "wood_light", kind="wet_wood", state=state)
    o["state_variants"] = "wet / steaming / dry"
    if state == "steaming":
        for i in range(3):
            sphere(name + "_steam_" + str(i), (x - 0.7 + i * 0.7, -0.7, z + 0.65 + (i % 2) * 0.25), (0.22, 0.18, 0.38), collection, "steam", kind="steam_fx", state=state)
    return o


def leaf_wing(collection, name, x, z, state="closed"):
    root = empty(name + "_ROOT", (x, -1.3, z), collection, kind="leaf_wing_rig", state=state)
    root["state_variants"] = "closed / open / wind / folded"
    root["attach_point"] = "player.back"
    for side in (-1, 1):
        w = leaf(collection, name + ("_L" if side < 0 else "_R"), (x + side * 0.75, -1.2, z + 0.5), (1.45, 0.16, 2.45), "wing", rotation=(0, math.radians(side * 12), math.radians(side * -15)), state=state, kind="leaf_wing")
        parent_keep_world(w, root)
    root.rotation_euler[1] = math.radians(-8 if state == "closed" else 5)
    root.scale = (0.62, 0.62, 0.62) if state == "closed" else (1.0, 1.0, 1.0)
    root.keyframe_insert(data_path="rotation_euler", index=1, frame=1)
    root.keyframe_insert(data_path="scale", frame=1)
    root.rotation_euler[1] = math.radians(4)
    root.scale = (1.0, 1.0, 1.0)
    root.keyframe_insert(data_path="rotation_euler", index=1, frame=20)
    root.keyframe_insert(data_path="scale", frame=20)
    root.rotation_euler[1] = math.radians(-13)
    root.keyframe_insert(data_path="rotation_euler", index=1, frame=34)
    root.rotation_euler[1] = math.radians(2)
    root.keyframe_insert(data_path="rotation_euler", index=1, frame=52)
    root.scale = (0.62, 0.62, 0.62)
    root.keyframe_insert(data_path="scale", frame=70)
    return root


def dragon(collection, name, x, z):
    root = empty(name + "_ROOT", (x, 2.2, z), collection, kind="dragon_rig", state="shared")
    root["animation_states"] = "glide / wingbeat / rest"
    body = sphere(name + "_body", (x, 2.2, z), (2.2, 0.75, 0.75), collection, "leaf_dark", kind="dragon")
    head = sphere(name + "_head", (x + 1.9, 2.1, z + 0.45), (0.9, 0.6, 0.6), collection, "leaf", kind="dragon")
    parent_keep_world(body, root)
    parent_keep_world(head, root)
    for side in (-1, 1):
        wing = leaf(collection, name + "_wing_" + str(side), (x - 0.3, 2.0, z + side * 1.1), (2.8, 0.15, 1.25), "leaf_yellow", rotation=(math.radians(side * 15), 0, math.radians(side * 20)), kind="dragon_wing")
        parent_keep_world(wing, root)
    # Small silhouette cues keep the low-poly patrol rig readable at scene scale:
    # a near-side eye and pupil, paired pointed horns/ears, a tall pointed wing,
    # and a thin curved tail.  They inherit the existing root animation.
    eye = sphere(name + "_eye", (x + 2.35, 1.48, z + 0.72), (0.28, 0.12, 0.30), collection, "cloud", kind="dragon_eye")
    parent_keep_world(eye, root)
    pupil = sphere(name + "_pupil", (x + 2.47, 1.37, z + 0.74), (0.11, 0.06, 0.14), collection, "wood_dark", kind="dragon_eye")
    parent_keep_world(pupil, root)
    for i, y in enumerate((1.78, 2.30)):
        horn = cone(name + "_horn_" + str(i), (x + 1.65, y, z + 1.28), 0.24, 1.15, collection, "dry", vertices=6, pointed=True, kind="dragon_horn")
        horn.rotation_euler = (0, math.radians(-24), 0)
        parent_keep_world(horn, root)
    for i, y in enumerate((1.62, 2.42)):
        ear = cone(name + "_ear_" + str(i), (x + 1.45, y, z + 0.95), 0.28, 0.72, collection, "wing", vertices=5, pointed=True, kind="dragon_ear")
        ear.rotation_euler = (0, math.radians(18 if i == 0 else -18), 0)
        parent_keep_world(ear, root)
    wing_tip = cone(name + "_wing_tip", (x - 0.55, 1.92, z + 1.85), 0.95, 3.5, collection, "wing", vertices=6, pointed=True, kind="dragon_wing")
    wing_tip.rotation_euler = (0, math.radians(-18), math.radians(-5))
    parent_keep_world(wing_tip, root)
    tail = curve(name + "_tail", [(x - 1.5, 2.18, z - 0.10), (x - 3.0, 2.15, z - 0.75), (x - 4.8, 2.12, z - 0.55), (x - 6.1, 2.10, z + 0.30), (x - 6.8, 2.08, z + 1.25)], collection, "leaf_dark", radius=0.20, kind="dragon_tail")
    parent_keep_world(tail, root)
    tail_tip = cone(name + "_tail_tip", (x - 6.8, 2.08, z + 1.45), 0.42, 1.15, collection, "leaf_yellow", vertices=5, pointed=True, kind="dragon_tail")
    tail_tip.rotation_euler = (0, math.radians(-18), 0)
    parent_keep_world(tail_tip, root)
    root.location.x = x - 12
    root.keyframe_insert(data_path="location", frame=1)
    root.location.x = x + 11
    root.keyframe_insert(data_path="location", frame=120)
    root.location.x = x - 12
    root.keyframe_insert(data_path="location", frame=240)
    for frame, tilt in ((1, 0.05), (15, -0.12), (30, 0.04), (45, -0.1), (60, 0.03), (120, 0.0)):
        root.rotation_euler[1] = tilt
        root.keyframe_insert(data_path="rotation_euler", index=1, frame=frame)
    return root


def backdrop_bridge(common):
    for i in range(6):
        cone("WB_Mountain_" + str(i), (-12 + i * 5.2, 7.0, 8.0 + (i % 2) * 1.6), 3.0, 8.5, common, "rock", vertices=5, kind="backdrop")
    terrain_patch(common, "WB_LeftBank", -10, 1.0, 9.0, depth=5.8, height=2.3)
    terrain_patch(common, "WB_RightBank", 10.0, 1.0, 8.0, depth=5.8, height=2.3)
    river(common, "WB_River", 0, -1.4, width=26)
    # A readable ground-level bypass makes the bridge's alternate route explicit
    # in the wide plate instead of leaving the river as an empty hole.
    for i in range(7):
        sphere("WB_BypassStep_" + str(i), (-4.8 + i * 1.6, -2.2, 0.05 + (i % 2) * 0.08), (0.95, 0.62, 0.34), common, "rock_light", kind="bypass_step")
    tree(common, "WB_GiantTree", -12, 7.0, scale=1.2)
    rock_cluster(common, "WB_LeftRocks", -6, 2.0, 7)
    rock_cluster(common, "WB_RightRocks", 7, 2.0, 7)
    shelter(common, "WB_Shelter", 10.5, 4.6)


def build_bridge_asset():
    root = new_collection("WB_BridgeRoot")
    common = new_collection("WB_Bridge_Common", root)
    broken = new_collection("WB_Bridge_State_Broken", root)
    working = new_collection("WB_Bridge_State_Working", root)
    connected = new_collection("WB_Bridge_State_Connected", root)
    inhabited = new_collection("WB_Bridge_State_Inhabited", root)
    animation = new_collection("WB_Bridge_State_AnimationStudy", root)
    backdrop_bridge(common)

    bridge_support(broken, "WB_Broken_LeftSupport", -5.0, 2.9, "broken")
    bridge_support(broken, "WB_Broken_RightSupport", 5.0, 2.9, "broken")
    bridge_segment(broken, "WB_Bridge_LeftBroken", -5.0, -0.9, 2.9, -0.2, broken=True, state="broken")
    bridge_segment(broken, "WB_Bridge_RightBroken", 2.3, 5.0, 2.9, -0.2, broken=True, state="broken")
    bridge_rope(broken, "WB_Rope_Left_Complete", [(-5.0, -1.3, 3.9), (-2.8, -1.3, 4.35), (-0.9, -1.3, 4.0)], "rope", "complete")
    bridge_rope(broken, "WB_Rope_Right_Worn", [(2.2, -1.3, 3.95), (3.4, -1.3, 4.32), (5.0, -1.3, 4.0)], "rope_worn", "worn")
    bridge_rope(broken, "WB_Rope_Center_Severed", [(-0.5, -1.3, 4.1), (0.25, -1.3, 3.9)], "rope_char", "severed")
    cart(broken, "WB_CargoCart_Tilted", -10.2, 3.4, upright=False, state="broken")
    for i in range(3):
        cube("WB_MaterialStack_" + str(i), (-6.8 + i * 0.8, -0.5, 3.0), (0.7, 1.4, 0.45), broken, "wood_light", bevel_width=0.08, kind="material_stock", state="broken")
    cube("WB_BrokenGapMarker", (0.7, -1.7, 2.8), (2.1, 0.14, 0.12), broken, "ember", bevel_width=0.02, kind="state_marker", state="broken")

    bridge_support(working, "WB_Working_LeftSupport", -5.0, 2.9, "working")
    bridge_support(working, "WB_Working_RightSupport", 5.0, 2.9, "working")
    bridge_segment(working, "WB_Bridge_WorkingPartial", -5.0, 1.0, 2.9, -0.2, broken=False, state="working")
    for i in range(4):
        cube("WB_WorkingScaffold_" + str(i), (-1.4 + i * 0.9, -0.15, 1.75), (0.55, 1.8, 0.24), working, "wood_light", bevel_width=0.08, kind="scaffold", state="working")
    bridge_rope(working, "WB_Rope_Working", [(-5.0, -1.3, 3.9), (0.0, -1.3, 4.3), (5.0, -1.3, 4.0)], "rope_worn", "worn")

    bridge_support(connected, "WB_Connected_LeftSupport", -5.0, 2.9, "connected")
    bridge_support(connected, "WB_Connected_RightSupport", 5.0, 2.9, "connected")
    bridge_segment(connected, "WB_Bridge_Connected", -5.0, 5.0, 2.9, -0.2, broken=False, state="connected")
    bridge_rope(connected, "WB_Rope_Connected", [(-5.0, -1.3, 3.9), (0.0, -1.3, 4.4), (5.0, -1.3, 3.9)], "rope", "complete")
    for x in (-5.0, 5.0):
        torus("WB_Hinge_" + str(x), (x, -0.2, 2.65), 0.32, 0.12, connected, "copper", rotation=(math.radians(90), 0, 0), kind="hinge", state="connected")
        cube("WB_Stopper_" + str(x), (x, -0.2, 2.4), (0.65, 1.1, 0.3), connected, "wood_dark", bevel_width=0.08, kind="stopper", state="connected")

    cart(inhabited, "WB_CargoCart_Upright", 7.4, 3.4, upright=True, state="inhabited")
    shelter(inhabited, "WB_LifeShelter", 10.5, 4.6, state="inhabited")
    bell(inhabited, "WB_LifeBell", (12.9, -0.6, 7.5), 1.3)
    for i in range(3):
        sphere("WB_LifePlant_" + str(i), (8.4 + i * 1.3, -1.0, 2.0), (0.45, 0.45, 0.6), inhabited, "leaf", kind="life", state="inhabited")
    cube("WB_StageMarker_Inhabited", (0, -1.6, 3.7), (2.4, 0.12, 0.12), inhabited, "gold", bevel_width=0.02, kind="state_marker", state="inhabited")

    rig = bridge_segment(animation, "WB_Bridge_AnimationStudy", -4.8, 4.8, 3.2, 3.0, broken=True, state="animation")
    rig["animation_note"] = "frame 1 broken, 20 working, 40 connected"
    animation["state_contract"] = "broken / working / connected / inhabited"
    root["scene_role"] = "public shared bridge; state is world fact"
    root["map_projection"] = "2.5D orthographic, X horizontal, Z up, Y depth"
    return root, common, broken, working, connected, inhabited, animation


def island_common(collection):
    for i in range(6):
        cone("IS_Mountain_" + str(i), (-12 + i * 5.0, 6.5, 8.0 + (i % 2) * 1.1), 3.5, 8.5, collection, "mountain", vertices=5, kind="backdrop")
    terrain_patch(collection, "IS_LowerGround", -4.5, 1.0, 18.0, depth=5.5, height=2.1)
    tree(collection, "IS_GiantRootTree", -12.0, 7.0, scale=1.25)
    rock_cluster(collection, "IS_RockField", 0, 2.2, 9)


def root_path(collection):
    pts = [(-11.0, 1.0, 2.0), (-8.4, 0.8, 2.8), (-6.0, 0.4, 3.7), (-3.2, 0.3, 4.8), (-0.4, 0.2, 5.6), (2.5, 0.4, 6.6), (5.1, 0.6, 7.6), (8.0, 0.8, 9.4)]
    for i in range(len(pts) - 1):
        cylinder_between("IS_RootRoad_Module_" + str(i), pts[i], pts[i + 1], 0.8, collection, "wood_dark", kind="root_road", state="shared")
        sphere("IS_RootRoad_Node_" + str(i), pts[i], (1.0, 0.75, 0.5), collection, "wood", kind="root_road", state="shared")
        sphere("IS_Moss_" + str(i), (pts[i][0], pts[i][1] - 0.35, pts[i][2] + 0.55), (0.65, 0.45, 0.16), collection, "moss", kind="root_moss", state="shared")


def station(collection):
    cube("IS_Station_Platform", (8.2, 0.5, 10.2), (7.0, 3.4, 0.8), collection, "rock", bevel_width=0.28, kind="station", state="shared")
    cube("IS_Station_Hut", (8.4, 0.3, 12.0), (4.6, 2.4, 2.7), collection, "wood", bevel_width=0.18, kind="station", state="shared")
    cube("IS_Station_Roof", (8.4, 0.1, 13.7), (5.5, 3.0, 0.4), collection, "wood_light", rotation=(0, math.radians(-7), 0), bevel_width=0.17, kind="station", state="shared")
    cube("IS_Station_Window", (8.4, -0.98, 12.0), (1.8, 0.16, 1.2), collection, "lantern", bevel_width=0.08, kind="station_window", state="shared")
    bell(collection, "IS_Station_Bell", (10.9, -0.8, 12.1), 1.1)
    lantern(collection, "IS_Station_Lantern", (6.5, -1.0, 11.8), 0.9)
    for i in range(3):
        cube("IS_Station_Tool_" + str(i), (6.5 + i * 0.5, -1.4, 10.9), (0.25, 0.22, 0.8), collection, "copper", bevel_width=0.04, kind="station_tool", state="shared")


def build_island_asset():
    root = new_collection("IS_WindbellIslandRoot")
    common = new_collection("IS_Common", root)
    path = new_collection("IS_RootPath_6_to_8_Modules", root)
    bridge = new_collection("IS_TreeBridge", root)
    ropes = new_collection("IS_Rope_StateVariants", root)
    fire = new_collection("IS_StoneTrough_Dry_Heat_Burn_Ember", root)
    wet = new_collection("IS_WetWood_Wet_Steam_Dry", root)
    wings = new_collection("IS_LeafWing_Closed_Open_Wind_Folded", root)
    station_col = new_collection("IS_Station", root)
    dragon_col = new_collection("IS_Dragon_Glide_Wingbeat_Rest", root)
    common["scene_role"] = "personal exploration island; state is per-instance"
    common["map_projection"] = "2.5D orthographic, X horizontal, Z up, Y depth"
    island_common(common)
    root_path(path)
    bridge_support(bridge, "IS_Bridge_LeftSupport", 0.0, 7.1, "shared")
    bridge_support(bridge, "IS_Bridge_RightSupport", 5.0, 8.4, "shared")
    bridge_segment(bridge, "IS_TreeBridge", 0.0, 5.0, 7.7, -0.7, broken=False, state="connected")
    torus("IS_Bridge_Hinge", (0.0, -0.7, 7.35), 0.34, 0.12, bridge, "copper", rotation=(math.radians(90), 0, 0), kind="hinge")
    cube("IS_Bridge_Stopper", (5.0, -0.7, 7.2), (0.7, 1.2, 0.3), bridge, "wood_dark", bevel_width=0.08, kind="stopper")

    bridge_rope(ropes, "IS_Rope_Complete", [(0.0, -1.8, 8.7), (2.5, -1.8, 9.1), (5.0, -1.8, 8.9)], "rope", "complete")
    bridge_rope(ropes, "IS_Rope_Worn", [(0.0, -1.2, 8.4), (2.4, -1.2, 8.85), (4.8, -1.2, 8.3)], "rope_worn", "worn")
    bridge_rope(ropes, "IS_Rope_Severed", [(0.0, -0.6, 8.3), (1.1, -0.6, 8.6)], "rope_char", "severed")
    bridge_rope(ropes, "IS_Rope_Charred", [(4.1, -0.6, 8.5), (5.0, -0.6, 8.7)], "rope_char", "charred")
    for i, state in enumerate(("dry", "heated", "burning", "ember")):
        dry_branch(fire, "IS_DryBranch_" + state, 2.0 + i * 0.9, 3.5 + (i % 2) * 0.6, state)
    cube("IS_StoneTrough", (2.2, -0.9, 3.0), (4.1, 2.1, 0.42), fire, "rock", bevel_width=0.2, kind="stone_trough", state="dry")
    for i in range(5):
        sphere("IS_TroughStone_" + str(i), (0.6 + i * 0.7, -1.1, 3.35), (0.25, 0.25, 0.2), fire, "rock_light", kind="stone_trough", state="dry")
    for i, state in enumerate(("wet", "steaming", "dry")):
        wet_wood(wet, "IS_WetWood_" + state, -2.5 + i * 1.5, 3.7 + (i % 2) * 0.5, state)
    leaf_wing(wings, "IS_LeafWing", -6.4, 4.0, "closed")
    station(station_col)
    # Keep the patrol dragon above the canopy at the hero frame so the authored
    # glide path remains legible in the island plate.
    dragon(dragon_col, "IS_PatrolDragon", 5.0, 18.0)
    for i in range(5):
        leaf(common, "IS_Leaf_" + str(i), (-1.0 + i * 2.0, -2.0, 8.0 + (i % 2) * 1.3), (0.65, 0.12, 0.95), "leaf_yellow", rotation=(0, 0, i * 0.4), kind="wind_leaf")
    return root, common, path, bridge, ropes, fire, wet, wings, station_col, dragon_col


def add_camera_and_lights(scene, target=(0, 0, 6.0), ortho=18.0):
    camera(scene, scene.name + "_Camera", (0, -34, 10.0), target, ortho)
    light(scene, scene.name + "_Key", (-7, -15, 22), 2200, (1.0, 0.86, 0.68), 10.0)
    light(scene, scene.name + "_Fill", (15, -4, 10), 1100, (0.52, 0.75, 1.0), 8.0)
    light(scene, scene.name + "_Rim", (0, 10, 17), 1400, (0.55, 0.82, 1.0), 7.0)


def fit_scene_camera(scene, padding=1.15):
    """Fit every renderable scene object with a 10%+ safety margin.

    Blender's ``ortho_scale`` is the camera-frame width.  The vertical extent is
    therefore converted to a width using the output aspect ratio.  This keeps the
    full playable composition in frame on a landscape plate, including the
    bypass route and the island patrol dragon.
    """
    points = []
    if bpy.context.window:
        bpy.context.window.scene = scene
    scene.frame_set(scene.frame_current)
    bpy.context.view_layer.update()
    for obj in scene.objects:
        if obj.type not in {"MESH", "CURVE", "SURFACE", "FONT"}:
            continue
        if not obj.bound_box:
            continue
        for corner in obj.bound_box:
            points.append(obj.matrix_world @ Vector(corner))
    if not points or scene.camera is None:
        return
    low = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    high = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    center = (low + high) / 2
    span_x = max(high.x - low.x, 2.0)
    span_z = max(high.z - low.z, 2.0)
    aspect = max(scene.render.resolution_x / max(scene.render.resolution_y, 1), 1.0)
    ortho = max(span_x, span_z * aspect) * padding
    scene.camera.data.type = "ORTHO"
    scene.camera.data.ortho_scale = ortho
    scene.camera.location = (center.x, -34.0, center.z)
    scene.camera.rotation_euler = (Vector((center.x, 0.0, center.z)) - scene.camera.location).to_track_quat("-Z", "Y").to_euler()
    scene["camera_fit_bbox_min"] = tuple(round(v, 3) for v in low)
    scene["camera_fit_bbox_max"] = tuple(round(v, 3) for v in high)
    scene["camera_fit_ortho"] = round(ortho, 3)


def child_layer(layer_collection, name):
    if layer_collection.name == name:
        return layer_collection
    for child in layer_collection.children:
        found = child_layer(child, name)
        if found:
            return found
    return None


def exclude(scene, names):
    # Blender 5.2 can invalidate a LayerCollection RNA proxy immediately after
    # toggling ``exclude``.  Collect every target first, then mutate in one pass.
    targets = []
    wanted = set(names)
    def collect(layer_collection):
        if layer_collection is None:
            return
        layer_name = getattr(layer_collection, "name", None)
        if layer_name in wanted:
            targets.append(layer_collection)
        for child in list(layer_collection.children):
            collect(child)
    collect(scene.view_layers[0].layer_collection)
    for layer in targets:
        layer.exclude = True


def link_scene_collections(scene, collections):
    """Link only the requested library collections into a scene.

    The library root intentionally contains every authored state.  Render and
    GLB scenes use direct links to the common collection plus their target state
    collections so Blender view-layer refresh cannot accidentally mix states.
    """
    for collection in collections:
        scene.collection.children.link(collection)


def state_pack(scene, source_collection, name, allowed_states):
    """Create a scene-local object-link pack for one current island state."""
    pack = bpy.data.collections.new(name)
    scene.collection.children.link(pack)
    wanted = set(allowed_states)
    for obj in source_collection.objects:
        if obj.get("world_state", "shared") in wanted:
            pack.objects.link(obj)
    pack["source_collection"] = source_collection.name
    pack["active_states"] = " / ".join(allowed_states)
    return pack


def make_bridge_scenes(root, common, broken, working, connected, inhabited, animation):
    def mark(label):
        # Keep the last boundary on the default scene so an MCP timeout/error is diagnosable.
        bpy.context.scene["WB_BUILD_STAGE"] = "bridge_scenes:" + label

    mark("broken_new")
    broken_scene = bpy.data.scenes.new("WindbellBridge_Broken")
    mark("broken_link")
    link_scene_collections(broken_scene, [common, broken])
    mark("broken_setup")
    setup_scene(broken_scene, "windbell_bridge_broken", (1280, 720), False)
    mark("broken_lights")
    add_camera_and_lights(broken_scene, (0, 0, 3.5), 25.0)
    mark("broken_frame")
    broken_scene.frame_set(1)
    fit_scene_camera(broken_scene)

    mark("repaired_new")
    repaired_scene = bpy.data.scenes.new("WindbellBridge_Repaired")
    mark("repaired_link")
    link_scene_collections(repaired_scene, [common, connected, inhabited])
    mark("repaired_setup")
    setup_scene(repaired_scene, "windbell_bridge_repaired", (1280, 720), False)
    mark("repaired_lights")
    add_camera_and_lights(repaired_scene, (0, 0, 3.5), 25.0)
    mark("repaired_frame")
    repaired_scene.frame_set(1)
    fit_scene_camera(repaired_scene)
    mark("done")
    return broken_scene, repaired_scene


def make_island_scene(root):
    scene = bpy.data.scenes.new("WindbellIsland_Exploration")
    setup_scene(scene, "windbell_island_exploration", (1280, 720), False)
    # The island scene presents one calm current state while the source
    # collections retain every authored variant for gameplay and previews.
    common = bpy.data.collections.get("IS_Common")
    path = bpy.data.collections.get("IS_RootPath_6_to_8_Modules")
    bridge = bpy.data.collections.get("IS_TreeBridge")
    station_col = bpy.data.collections.get("IS_Station")
    dragon_col = bpy.data.collections.get("IS_Dragon_Glide_Wingbeat_Rest")
    ropes = bpy.data.collections.get("IS_Rope_StateVariants")
    fire = bpy.data.collections.get("IS_StoneTrough_Dry_Heat_Burn_Ember")
    wet = bpy.data.collections.get("IS_WetWood_Wet_Steam_Dry")
    wings = bpy.data.collections.get("IS_LeafWing_Closed_Open_Wind_Folded")
    link_scene_collections(scene, [common, path, bridge, station_col, dragon_col])
    state_pack(scene, ropes, "IS_Scene_Current_Rope_Complete", ["complete"])
    state_pack(scene, fire, "IS_Scene_Current_Fire_Dry", ["dry"])
    state_pack(scene, wet, "IS_Scene_Current_WetWood_Dry", ["dry"])
    state_pack(scene, wings, "IS_Scene_Current_LeafWing_Closed", ["closed"])
    scene.frame_set(60)
    add_camera_and_lights(scene, (0, 0, 8.0), 28.0)
    fit_scene_camera(scene)
    return scene


def bounds(collection):
    points = []
    for o in collection.objects:
        if not hasattr(o, "bound_box") or not o.bound_box:
            continue
        for p in o.bound_box:
            points.append(o.matrix_world @ Vector(p))
    if not points:
        return Vector((0, 0, 0)), Vector((2, 2, 2))
    low = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    high = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    return (low + high) / 2, high - low


def render_collection_preview(collection, slug):
    scene = bpy.data.scenes.new("Preview_" + slug)
    scene.collection.children.link(collection)
    setup_scene(scene, slug, (768, 768), True)
    # Set the animated collection's preview frame before measuring its bounds;
    # otherwise a moving rig (notably the巡风龙) is framed at a stale position.
    bpy.context.window.scene = scene
    scene.frame_set(20)
    bpy.context.view_layer.update()
    center, size = bounds(collection)
    scale = max(size.x, size.z, 2.0) * 1.35
    add_camera_and_lights(scene, (center.x, center.y, center.z), scale)
    scene.camera.location = (center.x, center.y - 32, center.z)
    scene.camera.rotation_euler = (Vector((center.x, center.y, center.z)) - scene.camera.location).to_track_quat("-Z", "Y").to_euler()
    bpy.ops.render.render(write_still=True)
    return scene


def remove_previous():
    for scene in list(bpy.data.scenes):
        if scene.name.startswith(("WindbellBridge_", "WindbellIsland_", "Preview_")):
            bpy.data.scenes.remove(scene)
    for collection in list(bpy.data.collections):
        if collection.name.startswith(("WB_", "IS_")):
            bpy.data.collections.remove(collection)
    for obj in list(bpy.data.objects):
        if obj.name.startswith(("WB_", "IS_")):
            bpy.data.objects.remove(obj, do_unlink=True)


def export_scene(scene, path):
    bpy.context.window.scene = scene
    try:
        # Blender's glTF exporter defaults to every scene in the .blend.  The
        # explicit active-scene flag keeps each handoff GLB scoped to its scene.
        bpy.ops.export_scene.gltf(
            filepath=path,
            export_format="GLB",
            use_selection=False,
            use_active_scene=True,
            export_apply=True,
        )
    except Exception as exc:
        scene["glb_export_error"] = str(exc)


def build():
    bpy.context.scene["WB_BUILD_STAGE"] = "materials"
    make_materials()
    bpy.context.scene["WB_BUILD_STAGE"] = "cleanup"
    remove_previous()
    bpy.context.scene["WB_BUILD_STAGE"] = "bridge_asset"
    bridge_data = build_bridge_asset()
    bpy.context.scene["WB_BUILD_STAGE"] = "island_asset"
    island_data = build_island_asset()
    bridge_root, common, broken, working, connected, inhabited, animation = bridge_data
    island_root, island_common_col, path, island_bridge, ropes, fire, wet, wings, station_col, dragon_col = island_data
    bpy.context.scene["WB_BUILD_STAGE"] = "bridge_scenes"
    broken_scene, repaired_scene = make_bridge_scenes(bridge_root, common, broken, working, connected, inhabited, animation)
    bpy.context.scene["WB_BUILD_STAGE"] = "island_scene"
    island_scene = make_island_scene(island_root)

    # Persist the editable library before any render/export work.  A preview/export
    # failure must not erase the recoverable modeled scenes on the next retry.
    bpy.context.scene["WB_BUILD_STAGE"] = "checkpoint_save"
    bpy.context.window.scene = island_scene
    bpy.ops.wm.save_as_mainfile(filepath=BLEND_PATH)

    preview_targets = [
        (broken, "windbell_bridge_state_broken"),
        (connected, "windbell_bridge_state_connected"),
        (ropes, "windbell_rope_states"),
        (fire, "windbell_stone_trough_states"),
        (wet, "windbell_wetwood_states"),
        (wings, "windbell_leafwing_states"),
        (station_col, "windbell_station"),
        (dragon_col, "windbell_dragon"),
    ]
    bpy.context.scene["WB_BUILD_STAGE"] = "collection_previews"
    for collection, slug in preview_targets:
        render_collection_preview(collection, slug)

    bpy.context.scene["WB_BUILD_STAGE"] = "scene_exports"
    bpy.context.window.scene = broken_scene
    broken_scene.frame_set(1)
    bpy.ops.render.render(write_still=True)
    export_scene(broken_scene, GLB_ROOT + "windbell_bridge_broken.glb")
    bpy.context.window.scene = repaired_scene
    repaired_scene.frame_set(1)
    bpy.ops.render.render(write_still=True)
    export_scene(repaired_scene, GLB_ROOT + "windbell_bridge_repaired.glb")
    bpy.context.window.scene = island_scene
    island_scene.frame_set(60)
    bpy.ops.render.render(write_still=True)
    export_scene(island_scene, GLB_ROOT + "windbell_island_exploration.glb")

    bpy.context.window.scene = island_scene
    bpy.ops.wm.save_as_mainfile(filepath=BLEND_PATH)
    print("WINDBELL_BUILD_COMPLETE", BLEND_PATH)
    return {"blend": BLEND_PATH, "scenes": [broken_scene.name, repaired_scene.name, island_scene.name], "previews": len(preview_targets), "glb": 3}


try:
    build()
except Exception as exc:
    bpy.context.scene["WB_BUILD_ERROR"] = str(exc)
    print("WINDBELL_BUILD_ERROR", bpy.context.scene.get("WB_BUILD_STAGE"), str(exc))
    raise
