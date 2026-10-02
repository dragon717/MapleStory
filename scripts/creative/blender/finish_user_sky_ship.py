# Live Blender MCP: export the rig, then reuse the existing city/cabin interfaces.
import bpy
from mathutils import Vector

SV3_OUT='/Users/muniao/Code/MapleStory/resources/scenes/sky-voyage-v3'
scene=bpy.data.scenes['SV3_ProductionRig']
bpy.context.window.scene=scene
scene.frame_set(1)
exterior=bpy.data.objects.new('SV3_Exterior',None)
scene.collection.objects.link(exterior)
exterior['rig_version']=1
exterior['geometry_source']='user model main connected component, 285840 original triangles'
for obj in list(scene.objects):
    if obj!=exterior and obj.parent is None:
        obj.parent=exterior
bpy.ops.export_scene.gltf(filepath=SV3_OUT+'/models/user-ship-rig.glb',export_format='GLB',use_active_scene=True,export_yup=True,export_extras=True,export_apply=False,export_animations=True)
before=set(scene.objects)
bpy.ops.import_scene.gltf(filepath='/Users/muniao/Code/MapleStory/resources/scenes/sky-voyage-v2/models/sky-voyage.glb')
imported=set(scene.objects)-before
ship=bpy.data.objects.get('SV2_Ship')
assert ship in imported
cabin=bpy.data.objects.new('SV3_CabinInterior',None)
scene.collection.objects.link(cabin)
cabin.parent=ship
descendants=[]
for obj in imported:
    ancestor=obj.parent
    owned=False
    while ancestor:
        if ancestor==ship:
            owned=True
            break
        ancestor=ancestor.parent
    if owned:
        descendants.append(obj)
for obj in descendants:
    if obj.name.startswith(('SV2_Cabin','SV2_Bed','SV2_LoginSign','SV2_DeckAvatar')):
        if obj.parent==ship:
            obj.parent=cabin
    else:
        bpy.data.objects.remove(obj,do_unlink=True)
exterior.parent=ship
ship['rig_version']=1
ship['navigation']='P local entry preview; no multiplayer authority'
scene['geometry_source']='user sky ship; original imported source in SV3_ShipRig'
scene['runtime_contract']='rig_kind/fold_angle/fold_morph/wind_morph; glTF Y-up'
assert sum(int(obj.get('source_triangles',0)) for obj in scene.objects)==285840
assert not any(obj.name.startswith('SV2_Sail_') for obj in scene.objects)
assert all('SV2_CabinFrontWindow_%02d'%i in scene.objects for i in range(1,5))
for obj in scene.objects:
    obj.select_set(False)
for obj in scene.objects:
    if obj.type in {'MESH','EMPTY'}:
        obj.select_set(True)
bpy.context.view_layer.objects.active=ship
bpy.ops.export_scene.gltf(filepath=SV3_OUT+'/models/sky-voyage.glb',export_format='GLB',use_selection=True,use_active_scene=True,export_yup=True,export_extras=True,export_apply=False,export_animations=True)
bpy.ops.file.pack_all()
bpy.ops.wm.save_as_mainfile(filepath=SV3_OUT+'/models/sky-voyage.blend',compress=True)
print('SV3_EXPORT_OK',len(scene.objects),'triangles',sum(int(obj.get('source_triangles',0)) for obj in scene.objects))
