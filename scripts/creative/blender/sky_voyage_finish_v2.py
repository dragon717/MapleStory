# Primary-owned source verification, preview camera and safe GLB export.
import bpy
from mathutils import Vector
world = bpy.data.worlds.get('SV2_PreviewWorld') or bpy.data.worlds.new('SV2_PreviewWorld')
scene['sv_layout_json'] = json.dumps(LAYOUT,ensure_ascii=False)
world.use_nodes = True
background = next(node for node in world.node_tree.nodes if node.type == 'BACKGROUND')
background.inputs['Color'].default_value = (.42,.60,.72,1)
background.inputs['Strength'].default_value = .6
scene.world = world
sun_data = bpy.data.lights.get('SV2_PreviewSun_Data') or bpy.data.lights.new('SV2_PreviewSun_Data','SUN')
sun = bpy.data.objects.get('SV2_PreviewSun') or bpy.data.objects.new('SV2_PreviewSun',sun_data)
if sun.name not in PREVIEW.objects: PREVIEW.objects.link(sun)
sun.rotation_euler = (math.radians(27),math.radians(-25),math.radians(-33))
sun_data.energy = 2.5
camera_data = bpy.data.cameras.get('SV2_PreviewCamera_Data') or bpy.data.cameras.new('SV2_PreviewCamera_Data')
camera = bpy.data.objects.get('SV2_PreviewCamera') or bpy.data.objects.new('SV2_PreviewCamera',camera_data)
if camera.name not in PREVIEW.objects: PREVIEW.objects.link(camera)
pose = LAYOUT['runtimePresentation']['cameraPoses']['far']
camera.location = d_to_b(pose['eye'])
target = Vector(d_to_b(pose['aim']))
camera.rotation_euler = (target-Vector(camera.location)).to_track_quat('-Z','Y').to_euler()
camera_data.lens = 38
camera_data.clip_end = 20000
scene.camera = camera
scene.render.resolution_x = 1600
scene.render.resolution_y = 1000
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = OUT+'/models/sky-voyage-overview.png'
try:
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 24
except TypeError:
    pass
scene.render.film_transparent = False
expected = ['SV2_Ship','SV2_City','SV2_CabinRoof','SV2_CabinBackWall','SV2_CabinBackTrim','SV2_LoginSign']
expected += ['SV2_CabinFrontWindow_%02d'%i for i in range(1,5)]
expected += ['SV2_Bed_%d_%sAnchor'%(i,kind) for i in range(4) for kind in ['Sleep','Foot']]
for name in expected:
    assert len([obj for obj in scene.objects if obj.name == name]) == 1, 'missing/ambiguous '+name
assert not any('SailMapleGeometry' in obj.name for obj in scene.objects)
assert not any('FrontWindowGlass' in obj.name for obj in scene.objects)
assert tuple(round(value,3) for value in city.location) == tuple(d_to_b(LAYOUT['roots']['SV2_City']['gameWorld']))
for i,position in enumerate(LAYOUT['ship']['beds']['anchors']):
    bed = bpy.data.objects.get('SV2_Bed_%d'%i)
    assert tuple(round(v,3) for v in bed.location) == tuple(d_to_b(position))
bpy.ops.file.pack_all()
selection = [obj for obj in scene.objects if obj.name.startswith(('SV2_','SV2C2_')) and obj.type in {'MESH','EMPTY'}]
for obj in scene.objects:
    obj.select_set(False)
for obj in selection:
    obj.select_set(True)
bpy.context.view_layer.objects.active = ship
cloth_flags = [(mod,mod.show_viewport,mod.show_render) for obj in scene.objects for mod in obj.modifiers if mod.type == 'CLOTH']
for mod,viewport,render in cloth_flags:
    mod.show_viewport = False
    mod.show_render = False
try:
    try:
        bpy.ops.export_scene.gltf(filepath=GLB,export_format='GLB',use_selection=True,use_active_scene=True,export_yup=True,export_extras=True,export_apply=True)
    except TypeError:
        bpy.ops.export_scene.gltf(filepath=GLB,export_format='GLB',use_selection=True,use_active_scene=True,export_yup=True,export_extras=True)
finally:
    for mod,viewport,render in cloth_flags:
        mod.show_viewport = viewport
        mod.show_render = render
for obj in selection:
    obj.select_set(False)
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type == 'VIEW_3D':
            space = area.spaces.active
            space.region_3d.view_location = Vector(d_to_b((450,100,-1700)))
            space.region_3d.view_distance = 3500
            space.region_3d.view_rotation = (Vector(d_to_b((450,100,-1700)))-Vector(d_to_b((1500,1100,2000)))).to_track_quat('-Z','Y')
            space.region_3d.view_perspective = 'PERSP'
            space.clip_end = 20000
            space.overlay.show_relationship_lines = False
            space.shading.type = 'MATERIAL'
            space.shading.use_scene_lights = True
            space.shading.use_scene_world = True
bpy.ops.wm.save_as_mainfile(filepath=BLEND,compress=True)
print('SV2_BUILD_OK',scene.name,'objects',len(scene.objects),'GLB',GLB)
