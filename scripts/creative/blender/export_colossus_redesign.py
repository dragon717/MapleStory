"""Blender MCP: export selected asset collections, verify height, save preview."""
import bpy,json
from mathutils import Vector
s=bpy.data.scenes['CR_Colossus_100km'];bpy.context.window.scene=s
root='/Users/muniao/Code/MapleStory/resources/scenes/colossus/redesign/'
assets=['body','hand','forearm','house','heart','temple','terrace']
# A grass blade must not become kilometres wide in the continental material.
for name in ['body','hand']:
 for o in bpy.data.collections['CR_'+name].objects:
  if o.type=='MESH' and o.data.materials[0].name in ['CR_grass','CR_leaf']:
   for uv in o.data.uv_layers.active.data:uv.uv*=256
s.camera.location=(145000,-265000,152000)
s.camera.rotation_euler=(Vector((-17000,0,50000))-s.camera.location).to_track_quat('-Z','Y').to_euler()
s.camera.data.ortho_scale=184000
s.view_settings.exposure=-.3
s.render.resolution_x=1600;s.render.resolution_y=1200
# Every export is one independently loadable GLB. Other scenes and assets are not included.
results={}
for name in assets:
 col=bpy.data.collections['CR_'+name]
 col.hide_viewport=False;col.hide_render=False
 bpy.ops.object.select_all(action='DESELECT')
 for o in col.objects:o.select_set(True)
 bpy.context.view_layer.objects.active=next(iter(col.objects))
 bpy.ops.export_scene.gltf(filepath=root+'models/'+name+'.glb',use_selection=True,export_apply=True,export_extras=True)
 col.hide_viewport=name!='body';col.hide_render=name!='body'
 results[name]=len(col.objects)
pts=[o.matrix_world @ Vector(v) for o in bpy.data.collections['CR_body'].objects if o.type=='MESH' for v in o.bound_box]
height=max(p.z for p in pts)-min(p.z for p in pts)
assert abs(height-100000)<.01
assert abs(bpy.data.objects['CR_Human_2m'].dimensions.z-2)<.0001
s['height_verified_metres']=height
bpy.ops.wm.save_as_mainfile(filepath=root+'models/colossus_100km.blend')
s.render.filepath=root+'previews/colossus-overview.png'
bpy.ops.render.render(write_still=True)
print(json.dumps({'exports':results,'height':height,'human':2,'ratio':height/2}))
