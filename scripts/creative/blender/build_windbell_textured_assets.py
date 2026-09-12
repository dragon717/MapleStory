"""Add real 2D image textures and 2.5D cards to the Windbell asset library.

This file is sent after ``build_windbell_assets.py`` in one official Blender MCP
``execute_blender_code`` call.  The base scene remains procedural/editable; this
increment assigns image-backed materials to selected mesh regions and adds
small, thick cards for independent props and NPCs.  It never maps a full key art
image over an entire scene.

The MCP client injects ``CLEAN_INPUTS`` immediately before this file.  Each clean
input is validated with Pillow outside Blender and is packed into the textured
blend by Blender's image datablock API.
"""

import bpy
import math
from mathutils import Vector


TEXTURED_ROOT = "/Users/muniao/Library/Mobile Documents/com~apple~CloudDocs/游戏/github/MapleStory/resources/blender/windbell/legacy"
IMAGE_ROOT = "/Users/muniao/Library/Mobile Documents/com~apple~CloudDocs/游戏/github/MapleStory/resources/scenes/windbell/images"
TEXTURED_RENDER_ROOT = TEXTURED_ROOT + "/renders/"
TEXTURED_GLB_ROOT = TEXTURED_ROOT + "/glb/"
TEXTURED_BLEND_PATH = TEXTURED_ROOT + "/windbell_world_asset_library_textured.blend"

# The MCP client injects this mapping immediately before this file.  Keep the
# reference name here without introspecting the module namespace; Blender MCP
# safe mode intentionally rejects ``globals()`` and similar namespace access.


def restore_procedural_foliage_materials():
    """Restore foliage slots cleared by an earlier textured build attempt."""
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        name = obj.name.lower()
        material_name = None
        if "canopy_" in name:
            try:
                index = int(name.rsplit("_", 1)[1])
            except ValueError:
                continue
            material_name = "leaf_yellow" if index % 3 == 0 else "leaf"
        elif name.startswith("is_leaf_"):
            material_name = "leaf_yellow"
        if material_name:
            material_data = bpy.data.materials.get("WB_MAT_" + material_name)
            if material_data:
                obj.data.materials.clear()
                obj.data.materials.append(material_data)


def remove_textured_previous():
    for scene in bpy.data.scenes:
        for child in list(scene.collection.children):
            if child.name.startswith(("WB_Textured_", "IS_Textured_")):
                scene.collection.children.unlink(child)
    for collection in list(bpy.data.collections):
        if collection.name.startswith(("WB_Textured_", "IS_Textured_")):
            bpy.data.collections.remove(collection)
    for obj in list(bpy.data.objects):
        if obj.name.startswith(("WB_TexCard_", "IS_TexCard_")):
            bpy.data.objects.remove(obj, do_unlink=True)
    for material_data in list(bpy.data.materials):
        if material_data.name.startswith("WB_TEX_MAT_"):
            bpy.data.materials.remove(material_data)


def load_packed_image(role, path):
    name = "WB_TEX_IMG_" + role
    image = bpy.data.images.get(name)
    if image is None:
        image = bpy.data.images.load(filepath=path, check_existing=True)
        image.name = name
    try:
        image.pack()
    except Exception:
        pass
    image["texture_role"] = role
    image["source_path"] = path
    image["packed_for_windbell"] = bool(image.packed_file)
    return image


def texture_material(role, image, region, alpha=False):
    name = "WB_TEX_MAT_" + role
    material_data = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    material_data.use_nodes = True
    nodes = material_data.node_tree.nodes
    links = material_data.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    output.name = "WB_TEX_Output"
    shader = nodes.new("ShaderNodeBsdfPrincipled")
    shader.name = "WB_TEX_Principled"
    shader.inputs["Roughness"].default_value = 0.78
    if alpha:
        shader.inputs["Alpha"].default_value = 1.0
        try:
            material_data.surface_render_method = "DITHERED"
        except Exception:
            try:
                material_data.blend_method = "BLEND"
            except Exception:
                pass
    uv = nodes.new("ShaderNodeTexCoord")
    uv.name = "WB_TEX_UV"
    mapping = nodes.new("ShaderNodeMapping")
    mapping.name = "WB_TEX_RegionMapping"
    mapping.vector_type = "POINT"
    mapping.inputs["Location"].default_value = (region[0], region[1], 0.0)
    mapping.inputs["Scale"].default_value = (region[2] - region[0], region[3] - region[1], 1.0)
    image_node = nodes.new("ShaderNodeTexImage")
    image_node.name = "WB_TEX_Image_" + role
    image_node.image = image
    image_node.extension = "CLIP"
    links.new(uv.outputs["UV"], mapping.inputs["Vector"])
    links.new(mapping.outputs["Vector"], image_node.inputs["Vector"])
    links.new(image_node.outputs["Color"], shader.inputs["Base Color"])
    if alpha:
        links.new(image_node.outputs["Alpha"], shader.inputs["Alpha"])
    links.new(shader.outputs["BSDF"], output.inputs["Surface"])
    material_data.diffuse_color = (1.0, 1.0, 1.0, 1.0)
    material_data["texture_source"] = image.name
    material_data["texture_source_path"] = image.get("source_path", "")
    material_data["texture_role"] = role
    material_data["uv_region"] = tuple(region)
    material_data["uv_contract"] = "UVMap -> Mapping region -> Image Texture -> Principled Base Color"
    return material_data


def ensure_uv(obj):
    if obj.type != "MESH":
        return False
    if not obj.data.uv_layers:
        layer = obj.data.uv_layers.new(name="UVMap")
        for loop in layer.data:
            loop.uv = (0.5, 0.5)
    obj.data.uv_layers.active_index = 0
    obj["uv_map_name"] = obj.data.uv_layers[0].name
    return True


def assign_texture(obj, material_data, role, region):
    if not ensure_uv(obj):
        return False
    obj.data.materials.clear()
    obj.data.materials.append(material_data)
    obj["texture_role"] = role
    obj["texture_material"] = material_data.name
    obj["texture_uv_region"] = tuple(region)
    obj["texture_mapping"] = "UVMap + region mapping"
    return True


def create_collection(name, parent=None, scene=None):
    collection = bpy.data.collections.new(name)
    if parent:
        parent.children.link(collection)
    if scene:
        scene.collection.children.link(collection)
    return collection


def image_card(collection, name, image, role, loc, size, scene_tag):
    width, height = size
    mesh = bpy.data.meshes.new(name + "_mesh")
    mesh.from_pydata(
        [(-width / 2, 0.0, -height / 2), (width / 2, 0.0, -height / 2), (width / 2, 0.0, height / 2), (-width / 2, 0.0, height / 2)],
        [],
        [(0, 1, 2, 3)],
    )
    mesh.update()
    uv_layer = mesh.uv_layers.new(name="UVMap")
    uv_coords = ((0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0))
    for loop in mesh.loops:
        uv_layer.data[loop.index].uv = uv_coords[loop.vertex_index]
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    obj.location = loc
    solidify = obj.modifiers.new("card_thickness", "SOLIDIFY")
    solidify.thickness = 0.06
    mat_data = texture_material("card_" + role + "_" + scene_tag, image, (0.0, 0.0, 1.0, 1.0), alpha=True)
    obj.data.materials.append(mat_data)
    obj["asset_kind"] = "2.5D_image_card"
    obj["card_role"] = role
    obj["texture_source"] = image.name
    obj["uv_map_name"] = "UVMap"
    obj["card_thickness"] = 0.06
    obj["axis_convention"] = "X horizontal / Z up / Y depth"
    obj["scene_tag"] = scene_tag
    return obj


def build_image_library():
    # Keep this absolute so Blender can pack the image datablocks even when the
    # MCP process has a different cwd.
    image_root = IMAGE_ROOT
    bridge_image = load_packed_image("bridge_keyart", image_root + "/bridge-restored.png")
    island_image = load_packed_image("island_keyart", image_root + "/island-keyart.png")
    clean_images = {role: load_packed_image("clean_" + role, path) for role, path in CLEAN_INPUTS.items()}
    patch_images = {role: load_packed_image("patch_" + role, path) for role, path in TEXTURE_PATCHES.items()}
    return bridge_image, island_image, clean_images, patch_images


def assign_core_textures(bridge_image, island_image, patch_images):
    # Each material samples a small Pillow-generated swatch.  The key art stays
    # packed as source reference, but no core mesh samples it anymore.
    del bridge_image, island_image
    regions = {role: (0.0, 0.0, 1.0, 1.0) for role in ("wood", "grass", "bark", "stone", "water")}
    bridge_materials = {
        role: texture_material("bridge_" + role, patch_images["bridge_" + role], regions[role])
        for role in regions
    }
    island_materials = {
        role: texture_material("island_" + role, patch_images["island_" + role], regions[role])
        for role in regions
    }
    counts = {"bridge": {}, "island": {}}
    for obj in bpy.data.objects:
        name = obj.name.lower()
        if not (obj.name.startswith("WB_") or obj.name.startswith("IS_")) or obj.type != "MESH":
            continue
        # Character and wing meshes keep their authored procedural materials;
        # their clean 2D art is represented by the explicitly placed cards.
        # This prevents a dragon body/eye from accidentally sampling a wood
        # region merely because its object name contains ``body``.
        if any(token in name for token in ("dragon", "leafwing", "patroldragon", "wind_leaf", "eye", "pupil", "horn", "ear", "tail")):
            continue
        role = None
        if any(token in name for token in ("plank", "beam", "post", "brace", "roof", "tile", "bench", "body", "rim", "crate", "spoke", "wheel", "scaffold", "stopper", "hinge", "rootroad", "platform", "hut", "tool")):
            role = "wood"
        elif any(token in name for token in ("trunk", "branch")) and "drybranch" not in name:
            role = "bark"
        elif any(token in name for token in ("soil", "grass_cap", "moss", "plant", "wind_leaf")):
            role = "grass"
        elif any(token in name for token in ("rock", "stone", "trough", "bypassstep", "river_island")):
            role = "stone"
        elif any(token in name for token in ("water", "wave")):
            role = "water"
        if role is None:
            continue
        library = bridge_materials if obj.name.startswith("WB_") else island_materials
        region = regions[role]
        if assign_texture(obj, library[role], ("bridge_" if obj.name.startswith("WB_") else "island_") + role, region):
            group = "bridge" if obj.name.startswith("WB_") else "island"
            counts[group][role] = counts[group].get(role, 0) + 1
    return counts


def create_cards(clean_images):
    required = ["cart", "bell", "materials", "waystation", "dragon", "leafwing", "npc_awei", "npc_lanzhi", "npc_mucen"]
    missing = [role for role in required if role not in clean_images]
    if missing:
        raise RuntimeError("missing validated clean image roles: " + ", ".join(missing))
    bridge_root = bpy.data.collections.get("WB_BridgeRoot")
    island_root = bpy.data.collections.get("IS_WindbellIslandRoot")
    broken_scene = bpy.data.scenes.get("WindbellBridge_Broken")
    repaired_scene = bpy.data.scenes.get("WindbellBridge_Repaired")
    island_scene = bpy.data.scenes.get("WindbellIsland_Exploration")
    broken_cards = create_collection("WB_Textured_Cards_Broken", bridge_root)
    repaired_cards = create_collection("WB_Textured_Cards_Repaired", bridge_root)
    island_cards = create_collection("IS_Textured_Cards_Island", island_root)
    broken_scene.collection.children.link(broken_cards)
    repaired_scene.collection.children.link(repaired_cards)
    island_scene.collection.children.link(island_cards)
    # The authored low-poly dragon remains in the source asset collection with
    # its glide/wingbeat/rest keys.  The textured island plate uses the clean
    # dragon card as its visible character so the procedural silhouette does
    # not double up as a green blob behind the illustration.  The root library
    # scene still retains the original rig for editing and runtime selection.
    dragon_collection = bpy.data.collections.get("IS_Dragon_Glide_Wingbeat_Rest")
    if dragon_collection and dragon_collection.name in {child.name for child in island_scene.collection.children}:
        island_scene.collection.children.unlink(dragon_collection)
    current_leafwing = bpy.data.collections.get("IS_Scene_Current_LeafWing_Closed")
    if current_leafwing and current_leafwing.name in {child.name for child in island_scene.collection.children}:
        # The clean wing card is the visible current-state representation in
        # this textured plate; retain the complete closed/open/wind/folded
        # source collection in the library for editing and runtime selection.
        island_scene.collection.children.unlink(current_leafwing)
    island_scene["textured_dragon_representation"] = "IS_TexCard_Dragon; source rig retained in IS_Dragon_Glide_Wingbeat_Rest"
    island_scene["textured_leafwing_representation"] = "IS_TexCard_LeafWing; source state collection retained in IS_LeafWing_Closed_Open_Wind_Folded"
    cards = []
    cards.append(image_card(broken_cards, "WB_TexCard_CargoCart_Broken", clean_images["cart"], "cart", (-10.4, -3.1, 3.25), (4.4, 2.95), "bridge_broken"))
    cards.append(image_card(broken_cards, "WB_TexCard_Materials_Broken", clean_images["materials"], "materials", (-7.1, -3.05, 3.45), (3.7, 2.45), "bridge_broken"))
    cards.append(image_card(broken_cards, "WB_TexCard_Bell_Broken", clean_images["bell"], "bell", (11.2, -3.0, 5.9), (2.1, 3.15), "bridge_broken"))
    cards.append(image_card(repaired_cards, "WB_TexCard_CargoCart_Repaired", clean_images["cart"], "cart", (7.0, -3.1, 3.3), (4.2, 2.8), "bridge_repaired"))
    cards.append(image_card(repaired_cards, "WB_TexCard_Bell_Repaired", clean_images["bell"], "bell", (11.2, -3.0, 5.9), (2.1, 3.15), "bridge_repaired"))
    cards.append(image_card(repaired_cards, "WB_TexCard_Waystation_Repaired", clean_images["waystation"], "waystation", (10.0, -3.0, 6.0), (3.8, 2.55), "bridge_repaired"))
    cards.append(image_card(island_cards, "IS_TexCard_Dragon", clean_images["dragon"], "dragon", (4.5, -3.35, 18.0), (5.0, 3.35), "island"))
    cards.append(image_card(island_cards, "IS_TexCard_LeafWing", clean_images["leafwing"], "leafwing", (-5.0, -3.2, 9.0), (3.8, 2.55), "island"))
    cards.append(image_card(island_cards, "IS_TexCard_Waystation", clean_images["waystation"], "waystation", (10.0, -3.15, 12.0), (3.8, 2.55), "island"))
    cards.append(image_card(island_cards, "IS_TexCard_NPC_Awei", clean_images["npc_awei"], "npc_awei", (-7.0, -3.3, 5.2), (1.35, 2.05), "island"))
    cards.append(image_card(island_cards, "IS_TexCard_NPC_Lanzhi", clean_images["npc_lanzhi"], "npc_lanzhi", (0.0, -3.3, 7.0), (1.35, 2.05), "island"))
    cards.append(image_card(island_cards, "IS_TexCard_NPC_Mucen", clean_images["npc_mucen"], "npc_mucen", (7.0, -3.3, 9.5), (1.35, 2.05), "island"))
    return cards


def fit_scene_camera(scene, padding=1.15):
    """Fit the active textured scene without relying on a previous MCP call."""
    points = []
    if bpy.context.window:
        bpy.context.window.scene = scene
    scene.frame_set(scene.frame_current)
    bpy.context.view_layer.update()
    for obj in scene.objects:
        if obj.type not in {"MESH", "CURVE", "SURFACE", "FONT"} or not obj.bound_box:
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
    scene["texture_camera_fit_bbox_min"] = tuple(round(v, 3) for v in low)
    scene["texture_camera_fit_bbox_max"] = tuple(round(v, 3) for v in high)
    scene["texture_camera_fit_ortho"] = round(ortho, 3)


def render_textured_scene(scene, slug, frame):
    scene.frame_set(frame)
    bpy.context.window.scene = scene
    bpy.context.view_layer.update()
    fit_scene_camera(scene, padding=1.15)
    scene.render.filepath = TEXTURED_RENDER_ROOT + slug + "_textured.png"
    bpy.ops.render.render(write_still=True)
    bpy.context.window.scene = scene
    bpy.ops.export_scene.gltf(filepath=TEXTURED_GLB_ROOT + slug + "_textured.glb", export_format="GLB", use_selection=False, use_active_scene=True, export_apply=True)


def build_textured():
    restore_procedural_foliage_materials()
    remove_textured_previous()
    bridge_image, island_image, clean_images, patch_images = build_image_library()
    core_counts = assign_core_textures(bridge_image, island_image, patch_images)
    cards = create_cards(clean_images)
    broken_scene = bpy.data.scenes.get("WindbellBridge_Broken")
    repaired_scene = bpy.data.scenes.get("WindbellBridge_Repaired")
    island_scene = bpy.data.scenes.get("WindbellIsland_Exploration")
    for scene in (broken_scene, repaired_scene, island_scene):
        scene["texture_delivery"] = "image-backed UV materials + packed 2.5D cards"
        scene["texture_integration"] = "asset handoff only"
    render_textured_scene(broken_scene, "windbell_bridge_broken", 1)
    render_textured_scene(repaired_scene, "windbell_bridge_repaired", 1)
    render_textured_scene(island_scene, "windbell_island_exploration", 60)
    bpy.context.window.scene = island_scene
    bpy.ops.wm.save_as_mainfile(filepath=TEXTURED_BLEND_PATH)
    print("WINDBELL_TEXTURE_BUILD_COMPLETE", {"blend": TEXTURED_BLEND_PATH, "core_counts": core_counts, "cards": len(cards), "packed_images": len([i for i in bpy.data.images if i.name.startswith("WB_TEX_IMG_") and i.packed_file]), "patch_images": sorted(patch_images), "scenes": [broken_scene.name, repaired_scene.name, island_scene.name]})


try:
    build_textured()
except Exception as exc:
    if bpy.context.scene:
        bpy.context.scene["WB_TEXTURE_BUILD_ERROR"] = str(exc)
    print("WINDBELL_TEXTURE_BUILD_ERROR", str(exc))
    raise
