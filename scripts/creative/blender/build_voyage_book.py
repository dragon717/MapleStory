"""Build the editable Blender magic book used by the sky-voyage departure transition.

This is a local P asset.  No TMS273 magic-book texture was found in the checked
asset tree; the blue/gold cover and ivory pages follow the preserved v2 concept
reference, while the actual book is authored as editable geometry here.

Blender axes: X = book width, Y = book depth, Z = book height.  glTF export is
Y-up, so the runtime sees X = width, Y = height, Z = depth.
Animation: one armature action, frames 1–63 at 30 fps (2.1 s).  Covers open,
segmented pages bend and flip, then the emissive rune grows from frame 48.
"""

import bpy
import math
import os
import shutil
from mathutils import Matrix


ROOT = "/Users/muniao/Code/MapleStory"
OUT = os.path.join(ROOT, "resources/scenes/sky-voyage-v3/models")
BLEND = os.path.join(OUT, "voyage-book.blend")
GLB = os.path.join(OUT, "voyage-book.glb")
PREVIEW = "/tmp/voyage-book-preview.png"
FPS = 30
# The Blender glTF exporter keeps the absolute frame time for this action;
# frame 63 therefore exports at 2.1 s and aligns with the runtime boundary.
END_FRAME = 63


def clear_owned_data():
    for obj in list(bpy.data.objects):
        if obj.name.startswith("SV3_Book") or obj.name.startswith("SV3_Departure"):
            bpy.data.objects.remove(obj, do_unlink=True)
    for arm in list(bpy.data.armatures):
        if arm.name.startswith("SV3_Book"):
            bpy.data.armatures.remove(arm)
    for mesh in list(bpy.data.meshes):
        if mesh.name.startswith("SV3_Book"):
            bpy.data.meshes.remove(mesh)
    for material in list(bpy.data.materials):
        if material.name.startswith("SV3_Book"):
            bpy.data.materials.remove(material)


def collection(name):
    old = bpy.data.collections.get(name)
    if old:
        for obj in list(old.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.collections.remove(old)
    result = bpy.data.collections.new(name)
    SCENE.collection.children.link(result)
    return result


def material(name, color, roughness=0.55, metallic=0.0, emission=None):
    result = bpy.data.materials.new("SV3_Book_Mat_" + name)
    result.diffuse_color = (*color, 1.0)
    result.use_nodes = True
    shader = next(node for node in result.node_tree.nodes if node.type == "BSDF_PRINCIPLED")
    shader.inputs["Base Color"].default_value = (*color, 1.0)
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metallic
    if emission:
        shader.inputs["Emission Color"].default_value = (*emission[0], 1.0)
        shader.inputs["Emission Strength"].default_value = emission[1]
    return result


def mesh_object(name, vertices, faces, mats, target=None, parent=None, parent_bone=None):
    target = BOOK if target is None else target
    mesh = bpy.data.meshes.new(name + "_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    material_list = mats if isinstance(mats, (list, tuple)) else [mats]
    for mat in material_list:
        mesh.materials.append(mat)
    for poly in mesh.polygons:
        poly.use_smooth = False
    mesh.uv_layers.new(name="UVMap")
    obj = bpy.data.objects.new(name, mesh)
    target.objects.link(obj)
    if parent is not None:
        obj.parent = parent
        if parent_bone:
            obj.parent_type = "BONE"
            obj.parent_bone = parent_bone
        obj.matrix_parent_inverse = Matrix.Identity(4)
    return obj


def box(name, center, size, mat, target=None, parent=None, parent_bone=None, bevel=0.0):
    cx, cy, cz = center
    sx, sy, sz = [v * 0.5 for v in size]
    vertices = [
        (cx - sx, cy - sy, cz - sz), (cx + sx, cy - sy, cz - sz),
        (cx + sx, cy + sy, cz - sz), (cx - sx, cy + sy, cz - sz),
        (cx - sx, cy - sy, cz + sz), (cx + sx, cy - sy, cz + sz),
        (cx + sx, cy + sy, cz + sz), (cx - sx, cy + sy, cz + sz),
    ]
    result = mesh_object(name, vertices, [
        (0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
        (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)
    ], mat, target, parent, parent_bone)
    if bevel:
        mod = result.modifiers.new("Softened book edge", "BEVEL")
        mod.width = bevel
        mod.segments = 2
    return result


def extruded_polygon(name, outline, depth, mat, target=None, parent=None, parent_bone=None):
    half = depth * 0.5
    vertices = [(x, -half, z) for x, z in outline] + [(x, half, z) for x, z in outline]
    n = len(outline)
    faces = [tuple(range(n)), tuple(reversed(range(n, 2 * n)))]
    faces += [(i, (i + 1) % n, (i + 1) % n + n, i + n) for i in range(n)]
    return mesh_object(name, vertices, faces, mat, target, parent, parent_bone)


def tube_polyline(name, points, radius, mat, target=None, parent=None, parent_bone=None, sides=8):
    # Small editable beveled tubes for the cover filigree.  The points lie in X/Z;
    # their Y coordinate is the cover-facing offset.
    verts = []
    for i, (x, y, z) in enumerate(points):
        if i == 0:
            tangent = (points[1][0] - x, points[1][1] - y, points[1][2] - z)
        elif i == len(points) - 1:
            tangent = (x - points[i - 1][0], y - points[i - 1][1], z - points[i - 1][2])
        else:
            tangent = (points[i + 1][0] - points[i - 1][0], points[i + 1][1] - points[i - 1][1], points[i + 1][2] - points[i - 1][2])
        length = math.sqrt(sum(v * v for v in tangent)) or 1.0
        tangent = tuple(v / length for v in tangent)
        # All filigree runs are nearly in the X/Z plane; use Y as the ring axis.
        u = (0.0, 1.0, 0.0)
        v = (tangent[1] * u[2] - tangent[2] * u[1], tangent[2] * u[0] - tangent[0] * u[2], tangent[0] * u[1] - tangent[1] * u[0])
        v_length = math.sqrt(sum(q * q for q in v)) or 1.0
        v = tuple(q / v_length for q in v)
        for j in range(sides):
            angle = math.tau * j / sides
            verts.append(tuple(points[i][k] + radius * (math.cos(angle) * u[k] + math.sin(angle) * v[k]) for k in range(3)))
    faces = []
    for i in range(len(points) - 1):
        for j in range(sides):
            faces.append((i * sides + j, i * sides + (j + 1) % sides, (i + 1) * sides + (j + 1) % sides, (i + 1) * sides + j))
    faces.append(tuple(reversed(range(sides))))
    faces.append(tuple((len(points) - 1) * sides + j for j in range(sides)))
    return mesh_object(name, verts, faces, mat, target, parent, parent_bone)


def page_strip(name, side, u0, u1, page_offset, mat, parent_bone):
    """Create one thick, subdivided page segment in local bone coordinates.

    The strips are authored as an 8-segment ribbon, while each strip now has
    enough height samples for the Blender cloth preview to bend instead of
    behaving like a card.  The runtime can replace these fallback strips with
    the higher-resolution fixed-step solver in voyage-book-pages.ts.
    """
    rows = 12
    half_h = 0.50
    # Local x starts at the segment's hinge bone.  Eight strips per page keep the
    # page genuinely editable/bendable instead of a single flat quad.
    vertices = []
    for top in (False, True):
        for row in range(rows + 1):
            z = -half_h + (2.0 * half_h) * row / rows
            for u in (u0, u1):
                # A shallow physical page bow exists in the authored geometry;
                # the segment bones add the animated page bend on top of it.
                x = side * (u - u0)
                across = (u - 0.065) / 0.61
                bow = page_offset + 0.055 * math.sin(math.pi * across) * (0.65 + 0.35 * abs(z / half_h))
                y = bow + (-0.008 if top else 0.008)
                vertices.append((x, y, z))
    cols = 2
    faces = []
    top_base = 0
    bottom_base = (rows + 1) * cols
    for row in range(rows):
        a = top_base + row * cols
        b = top_base + (row + 1) * cols
        c = bottom_base + (row + 1) * cols
        d = bottom_base + row * cols
        faces += [(a, a + 1, b + 1, b), (d, c, c + 1, d + 1)]
        faces += [(a, b, c, d), (a + 1, d + 1, c + 1, b + 1)]
    faces += [(0, 1, bottom_base + 1, bottom_base), (rows * cols, bottom_base + rows * cols, bottom_base + rows * cols + 1, rows * cols + 1)]
    result = mesh_object(name, vertices, faces, mat, BOOK, ARMATURE, parent_bone)
    result["page_segment"] = True
    result["page_segment_count"] = 8
    result["page_surface_rows"] = rows
    result["page_width_start"] = u0
    result["page_width_end"] = u1
    result["page_hinge_axis"] = "local Z / glTF Y; spine edge is held by SV3_Page_*_Bone"
    result["page_physics"] = "pinned Blender Cloth preview + runtime VoyageBookPageCloth"

    # Keep a real, editable cloth setup in the .blend.  The authored bone
    # animation remains the deterministic GLB fallback; the modifier is
    # hidden during export so its uncached solver cannot alter the published
    # vertex positions.  The runtime solver uses the same hinge/curvature
    # contract and supplies the live fold in Three.
    pin_group = result.vertex_groups.new(name="SV3_PageSpinePins")
    cols = 2
    bottom_base = (rows + 1) * cols
    pin_indices = []
    if abs(u0 - 0.065) < 1e-6:
        for row in range(rows + 1):
            pin_indices.extend((row * cols, bottom_base + row * cols))
    else:
        # Segment joins stay attached to their authored bone so the optional
        # cloth preview cannot detach the ribbon at a page seam.
        for row in range(rows + 1):
            pin_indices.extend((row * cols, bottom_base + row * cols))
    pin_group.add(pin_indices, 1.0, 'REPLACE')
    cloth = result.modifiers.new("SV3_PageCloth", "CLOTH")
    settings = cloth.settings
    for attribute, value in (
        ("quality", 6),
        ("mass", 0.035),
        ("air_damping", 6.0),
        ("tension_stiffness", 18.0),
        ("compression_stiffness", 16.0),
        ("shear_stiffness", 12.0),
        ("bending_stiffness", 0.28),
        ("pin_stiffness", 1.0),
    ):
        if hasattr(settings, attribute):
            setattr(settings, attribute, value)
    if hasattr(settings, "vertex_group_mass"):
        settings.vertex_group_mass = pin_group.name
    result["cloth_pin_group"] = pin_group.name
    result["cloth_pin_count"] = len(pin_indices)
    result["cloth_mass_kg"] = 0.035
    result["cloth_bending_stiffness"] = 0.28
    cloth.show_viewport = False
    cloth.show_render = False
    return result


def add_bone(name, head, parent=None):
    bone = ARMATURE_DATA.edit_bones.new(name)
    bone.head = head
    # Bone local Y follows the book-depth axis.  This keeps bone-parented mesh
    # objects in the authored X/Z book plane instead of Blender's default
    # bone-to-Z 90-degree rest rotation.
    bone.tail = (head[0], head[1] + 0.16, head[2])
    if parent:
        bone.parent = ARMATURE_DATA.edit_bones.get(parent)
        bone.use_connect = False
    return bone


def key_rotation(pose_bone, frame, angle):
    pose_bone.rotation_mode = "XYZ"
    pose_bone.rotation_euler[2] = angle
    pose_bone.keyframe_insert(data_path="rotation_euler", index=2, frame=frame)


def key_scale(pose_bone, frame, value):
    pose_bone.scale = (value, value, value)
    pose_bone.keyframe_insert(data_path="scale", frame=frame)


def leaf_emblem(name, side, y, mat, parent_bone):
    # A small angular maple/rune leaf built from editable geometry.  It carries
    # the same red/gold visual cue as the existing v2 concept, without claiming
    # that the concept image is a production texture.
    cx = side * 0.38
    outline = [(0.0, 0.18), (-0.07, 0.07), (-0.20, 0.10), (-0.13, -0.02), (-0.23, -0.10), (-0.08, -0.12), (0.0, -0.26), (0.08, -0.12), (0.23, -0.10), (0.13, -0.02), (0.20, 0.10), (0.07, 0.07)]
    outline_xz = [(cx + side * x * 1.15, z) for x, z in outline]
    result = extruded_polygon(name, outline_xz, 0.018, mat, BOOK, ARMATURE, parent_bone)
    result.location.y = y
    # A gold center stem makes the silhouette readable at the small runtime size.
    tube_polyline(name + "_Stem", [(cx, y - 0.013, -0.22), (cx, y - 0.013, 0.17)], 0.014, MATS["gold"], BOOK, ARMATURE, parent_bone, 6)
    return result


def cover(name, side, bone_name):
    width, height, bevel = 0.70, 1.08, 0.055
    x0, x1 = 0.035 * side, width * side
    lo, hi = sorted((x0, x1))
    outline = [(x0, -height * 0.5 + bevel), (x0, height * 0.5 - bevel), (x0 + (x1 - x0) * 0.15, height * 0.5), (x1 - side * bevel, height * 0.5), (x1, height * 0.5 - bevel), (x1, -height * 0.5 + bevel), (x1 - side * bevel, -height * 0.5), (x0 + (x1 - x0) * 0.15, -height * 0.5)]
    result = extruded_polygon(name, outline, 0.095, MATS["cover"], BOOK, ARMATURE, bone_name)
    result["role"] = "cover"
    result["hinge_axis"] = "local Z / glTF Y"
    result["editable_material_source"] = "P authored Principled material; no original TMS273 magic-book texture found"
    # A slightly inset blue panel and two gold rails make the cover legible.
    panel_w = 0.51
    panel = box(name + "_InsetPanel", (side * 0.39, -0.057, 0.0), (panel_w, 0.012, 0.82), MATS["cover_inner"], BOOK, ARMATURE, bone_name, 0.025)
    panel["role"] = "cover_inset"
    for z in (-0.43, 0.43):
        box(name + "_GoldRail", (side * 0.39, -0.070, z), (0.53, 0.020, 0.025), MATS["gold"], BOOK, ARMATURE, bone_name, 0.008)
    for u in (0.15, 0.63):
        box(name + "_GoldRail", (side * u, -0.070, 0.0), (0.025, 0.020, 0.86), MATS["gold"], BOOK, ARMATURE, bone_name, 0.008)
    leaf_emblem(name + "_RuneFront", side, -0.079, MATS["red"], bone_name)
    leaf_emblem(name + "_RuneBack", side, 0.079, MATS["red"], bone_name)
    return result


def setup_animation():
    action = bpy.data.actions.new("SV3_BookOpenFlipGlow")
    action.use_fake_user = True
    ARMATURE.animation_data_create()
    ARMATURE.animation_data.action = action

    # Covers open first.
    for side, bone_name in ((-1, "SV3_Cover_L_Bone"), (1, "SV3_Cover_R_Bone")):
        pb = ARMATURE.pose.bones[bone_name]
        # Both covers start folded over the inner paper stack, then swing
        # toward runtime -Z so the readable page face remains the frontmost
        # layer for a +Z viewer. The old left-pi/right-zero pose was asymmetric
        # and the old -side sign lifted the outer cover over the paper.
        closed = -side * 1.45
        for frame, amount in ((1, closed), (8, side * 0.12), (16, side * 0.65), (44, side * 0.65), (END_FRAME, side * 0.70)):
            key_rotation(pb, frame, amount)

    # Page roots release from the inner spine.  Each page keeps its authored
    # width throughout the turn and rotates around the local Z axis (glTF Y),
    # which is the spine hinge after export.  The positive angle magnitude
    # places both halves in the readable (+Z) depth; side only controls X.
    for side in (-1, 1):
        for page in range(6):
            pb = ARMATURE.pose.bones[f"SV3_Page_{'L' if side < 0 else 'R'}_{page:02d}_Bone"]
            closed_angle = -side * 1.45
            release_start = 12 + page * 3
            release_mid = release_start + 4
            release_end = release_start + 11
            # Inner pages leave the stack first.  The final key at frame 44
            # gives every free edge time to settle before the glow starts.
            for frame, amount in (
                (1, closed_angle),
                (release_start, closed_angle),
                (release_mid, closed_angle * 0.55),
                (release_end, 0.0),
                (44, 0.0),
                (END_FRAME, 0.0),
            ):
                key_rotation(pb, frame, amount)

            for segment in range(8):
                bend = ARMATURE.pose.bones[f"SV3_Page_{'L' if side < 0 else 'R'}_{page:02d}_Bone_S{segment:02d}_Bone"]
                fraction = segment / 7.0
                for frame, amount in (
                    (1, 0.0),
                    (release_start, 0.0),
                    (release_mid, 0.16),
                    (release_end, 0.075),
                    (END_FRAME, 0.035),
                ):
                    key_rotation(bend, frame, -side * amount * fraction)

    glow = ARMATURE.pose.bones["SV3_Glow_Bone"]
    for frame, scale in ((1, 0.05), (40, 0.05), (48, 0.42), (56, 1.0), (END_FRAME, 0.72)):
        key_scale(glow, frame, scale)

    # Blender 5.2 stores action channels in layered channel bags; default
    # Bezier interpolation is acceptable for this short local transition and
    # keeps the script compatible with both 4.x and 5.x background builds.
    action["duration_seconds"] = END_FRAME / FPS
    action["glow_start_frame"] = 48
    action["glow_start_seconds"] = 48 / FPS
    return action


def create_preview_camera():
    camera_data = bpy.data.cameras.new("SV3_BookPreviewCamera")
    camera = bpy.data.objects.new("SV3_BookPreviewCamera", camera_data)
    PREVIEW_COLLECTION.objects.link(camera)
    camera.location = (1.75, -2.7, 1.60)
    camera.data.lens = 56
    target = (0.0, 0.0, 0.0)
    direction = (target[0] - camera.location.x, target[1] - camera.location.y, target[2] - camera.location.z)
    camera.rotation_euler = direction_to_euler(direction)
    SCENE.camera = camera

    for name, location, color, energy, size in (
        ("SV3_BookKey", (0.8, -1.7, 2.3), (0.73, 0.88, 1.0), 700, 2.0),
        ("SV3_BookFill", (-1.4, 0.3, 1.0), (1.0, 0.60, 0.30), 460, 1.4),
    ):
        light_data = bpy.data.lights.new(name, "AREA")
        light_data.energy = energy
        light_data.color = color
        light_data.shape = "DISK"
        light_data.size = size
        light = bpy.data.objects.new(name, light_data)
        PREVIEW_COLLECTION.objects.link(light)
        light.location = location
        light.rotation_euler = direction_to_euler((-location[0], -location[1], -location[2]))

    ground = box("SV3_BookPreviewGround", (0.0, 0.0, -0.72), (4.5, 4.0, 0.08), MATS["ground"], PREVIEW_COLLECTION)
    ground["preview_only"] = True


def direction_to_euler(direction):
    from mathutils import Vector
    return Vector(direction).to_track_quat("-Z", "Y").to_euler()


def export_and_save():
    SCENE.frame_start = 1
    SCENE.frame_end = END_FRAME
    SCENE.render.fps = FPS
    SCENE.render.engine = "BLENDER_EEVEE"
    SCENE.render.resolution_x = 760
    SCENE.render.resolution_y = 620
    SCENE.render.resolution_percentage = 100
    SCENE.render.image_settings.file_format = "PNG"
    SCENE.render.filepath = PREVIEW
    if SCENE.world is None:
        SCENE.world = bpy.data.worlds.new("SV3_BookPreviewWorld")
    SCENE.world.color = (0.008, 0.014, 0.035)
    SCENE.frame_set(56)
    bpy.ops.render.render(write_still=True)

    # Export only the book and its armature.  Preview camera/lights/ground stay
    # in the editable .blend but never become runtime geometry.
    bpy.ops.object.select_all(action="DESELECT")
    for obj in BOOK.objects:
        obj.select_set(True)
    ARMATURE.select_set(True)
    bpy.context.view_layer.objects.active = ARMATURE
    bpy.ops.export_scene.gltf(
        filepath=GLB,
        export_format="GLB",
        use_selection=True,
        use_active_scene=True,
        export_yup=True,
        export_extras=True,
        export_apply=False,
        export_animations=True,
        export_anim_single_armature=True,
        export_lights=False,
    )
    # Keep the editable .blend ready for cloth preview after export.  The GLB
    # was written while these modifiers were disabled so the published asset
    # remains deterministic; reopening the source scene exposes the pinned
    # cloth setup for scrubbing and baking in Blender.
    for obj in BOOK.objects:
        cloth = obj.modifiers.get("SV3_PageCloth")
        if cloth:
            cloth.show_viewport = True
            cloth.show_render = False
    bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=BLEND, compress=True)
    print("VOYAGE_BOOK_EXPORT_OK", GLB, "objects", len(BOOK.objects), "frames", END_FRAME, "seconds", END_FRAME / FPS)


clear_owned_data()
SCENE = bpy.data.scenes.get("SV3_VoyageBook") or bpy.data.scenes.new("SV3_VoyageBook")
bpy.context.window.scene = SCENE
BOOK = collection("SV3_BookModel")
PREVIEW_COLLECTION = collection("SV3_BookPreview")

SCENE["voyage_book_contract"] = "SV3_DepartureBook root; glTF Y-up; local X width, Y height, Z depth; pages pinned on inner spine and turn within their own half; target size 1.48 x 1.08 x 0.22 m; play SV3_BookOpenFlipGlow once for 2.1 s; glow begins at 1.60 s / frame 48"
SCENE["book_geometry_source"] = "P authored editable geometry based on resources/login-prototypes/2026-10-01/v2/mid.png; no original TMS273 magic-book texture found in the checked TMS273 export tree"
SCENE["book_material_source"] = "P Principled materials: blue leather-like cover, gold metal trim, ivory paper, cyan emissive rune; no external texture claim"
SCENE["runtime_handoff"] = "Parent SV3_DepartureBook at player/bed anchor; retain root scale for runtime sizing; mixer clip SV3_BookOpenFlipGlow, LoopOnce, clampWhenFinished; optionally bind client/src/features/entry/voyage-book-pages.ts for live pinned-page cloth"

MATS = {
    "cover": material("CoverBlue", (0.035, 0.075, 0.23), 0.42, 0.10),
    "cover_inner": material("CoverInset", (0.018, 0.032, 0.11), 0.50, 0.12),
    "gold": material("GoldTrim", (0.92, 0.52, 0.10), 0.25, 0.72),
    "red": material("RuneRed", (0.62, 0.035, 0.025), 0.33, 0.18, ((0.62, 0.035, 0.025), 0.15)),
    "page": material("IvoryPaper", (0.88, 0.79, 0.61), 0.86),
    "page_alt": material("WarmPaper", (0.98, 0.90, 0.70), 0.88),
    "ink": material("PageInk", (0.20, 0.10, 0.045), 0.62),
    "rune": material("RuneGlow", (0.10, 0.68, 1.0), 0.23, 0.06, ((0.10, 0.68, 1.0), 4.3)),
    "ground": material("PreviewGround", (0.018, 0.026, 0.06), 0.92),
}

# Root empty is the stable runtime node.  The armature holds one combined
# animation so ThreeAnimationMixer can play all page/cover/glow controls as a
# single clip.
ROOT_EMPTY = bpy.data.objects.new("SV3_DepartureBook", None)
BOOK.objects.link(ROOT_EMPTY)
ROOT_EMPTY.empty_display_type = "CUBE"
ROOT_EMPTY.empty_display_size = 0.18
ROOT_EMPTY["role"] = "runtime_magic_book"
ROOT_EMPTY["axis_contract"] = "Blender X width / Y depth / Z height; glTF X width / Y height / Z depth"
ROOT_EMPTY["dimensions_m"] = [1.48, 1.08, 0.22]
ROOT_EMPTY["animation_clip"] = "SV3_BookOpenFlipGlow"
ROOT_EMPTY["animation_duration_seconds"] = END_FRAME / FPS
ROOT_EMPTY["animation_glow_start_seconds"] = 48 / FPS
ROOT_EMPTY["page_hinge_contract"] = "inner spine column fixed; six pages per half; no page root crosses the cover side"
ROOT_EMPTY["page_physics_contract"] = "pinned Blender Cloth authoring preview plus deterministic VoyageBookPageCloth runtime solver"
ROOT_EMPTY["page_turn_axis_contract"] = "Blender Z / glTF Y spine hinge; signed -side*1.45 rad closed angle to 0"
ROOT_EMPTY["page_closed_angle_radians"] = 1.45
ROOT_EMPTY["page_front_depth_runtime"] = 0.105
ROOT_EMPTY["cover_open_direction_runtime"] = "-Z away from readable page face"
ROOT_EMPTY["page_width_preserved"] = True

ARMATURE_DATA = bpy.data.armatures.new("SV3_BookRig")
ARMATURE = bpy.data.objects.new("SV3_BookRig", ARMATURE_DATA)
BOOK.objects.link(ARMATURE)
ARMATURE.parent = ROOT_EMPTY
ARMATURE_DATA.display_type = "BBONE"
ARMATURE["role"] = "book_animation_rig"
ARMATURE["clip_name"] = "SV3_BookOpenFlipGlow"

bpy.context.view_layer.objects.active = ARMATURE
ARMATURE.select_set(True)
bpy.ops.object.mode_set(mode="EDIT")
add_bone("SV3_BookRoot_Bone", (0.0, 0.0, 0.0))
for side, label in ((-1, "L"), (1, "R")):
    add_bone(f"SV3_Cover_{label}_Bone", (0.0, 0.0, 0.0), "SV3_BookRoot_Bone")
    for page in range(6):
        page_name = f"SV3_Page_{label}_{page:02d}_Bone"
        add_bone(page_name, (0.0, 0.0, 0.0), "SV3_BookRoot_Bone")
        for segment in range(8):
            add_bone(f"{page_name}_S{segment:02d}_Bone", (side * (0.065 + segment * 0.075), 0.0, 0.0), page_name)
add_bone("SV3_Glow_Bone", (0.0, 0.0, 0.0), "SV3_BookRoot_Bone")
bpy.ops.object.mode_set(mode="OBJECT")

cover("SV3_Cover_L", -1, "SV3_Cover_L_Bone")
cover("SV3_Cover_R", 1, "SV3_Cover_R_Bone")

# Spine, hinge caps and a central cyan stone are static root children.
box("SV3_Spine", (0.0, 0.0, 0.0), (0.14, 0.13, 1.08), MATS["cover_inner"], BOOK, ARMATURE, "SV3_BookRoot_Bone", 0.035)
box("SV3_SpineGold", (0.0, -0.074, 0.0), (0.045, 0.020, 0.86), MATS["gold"], BOOK, ARMATURE, "SV3_BookRoot_Bone", 0.012)

for side, label in ((-1, "L"), (1, "R")):
    for page in range(6):
        # Pages sit just above the inner cover surface toward the runtime
        # viewer (Blender -Y), so the open spread remains visible between the
        # two covers instead of being z-fought/occluded by them.
        base = -0.13 + page * 0.006
        for segment in range(8):
            u0 = 0.065 + segment * (0.61 / 8.0)
            u1 = 0.065 + (segment + 1) * (0.61 / 8.0)
            page_strip(f"SV3_Page_{label}_{page:02d}_S{segment:02d}", side, u0, u1, base, MATS["page_alt" if page % 2 else "page"], f"SV3_Page_{label}_{page:02d}_Bone_S{segment:02d}_Bone")
        # A few dark, raised page marks are kept as geometry so the open spread
        # remains readable without relying on a texture atlas.
        for line in range(3):
            z = 0.26 - line * 0.18
            length = 0.29 if line != 1 else 0.20
            x = side * (0.28 + (0.05 if line == 1 else 0.0))
            box(f"SV3_PageInk_{label}_{page:02d}_{line}", (x, base - 0.028, z), (length, 0.012, 0.014), MATS["ink"], BOOK, ARMATURE, f"SV3_Page_{label}_{page:02d}_Bone", 0.004)

# A compact emissive rune/halo is parented to a scale-controlled bone.  The
# geometry remains present in the GLB, and the armature scale makes its late
# glow timing mixer-friendly without requiring a runtime light implementation.
halo = box("SV3_DepartureGlow", (0.0, -0.092, 0.0), (0.12, 0.020, 0.12), MATS["rune"], BOOK, ARMATURE, "SV3_Glow_Bone", 0.04)
halo["glow_start_frame"] = 48
halo["glow_start_seconds"] = 48 / FPS
halo["role"] = "late_departure_glow"
for side in (-1, 1):
    tube_polyline(f"SV3_GlowRay_{side}", [(0.0, -0.105, 0.0), (side * 0.26, -0.105, 0.28), (side * 0.38, -0.105, 0.0)], 0.018, MATS["rune"], BOOK, ARMATURE, "SV3_Glow_Bone", 6)

setup_animation()
create_preview_camera()
export_and_save()
