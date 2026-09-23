"""Export a compact evaluated GLB without destroying the editable scene."""
import bpy,json,time
from pathlib import Path
from mathutils import Vector
ROOT=Path(__file__).resolve().parents[3];OUT=ROOT/'resources/scenes/henesys'
s=bpy.data.scenes['HN_Henesys'];bpy.context.window.scene=s
# Snapshot evaluated objects before switching to the temporary export scene.
deps=bpy.context.evaluated_depsgraph_get();groups={};counts={}
for col in s.collection.children:
 if col.name=='HN_Set':continue
 entries=[]
 for o in col.objects:
  if o.hide_render or o.type not in {'MESH','CURVE','FONT'}:continue
  data=bpy.data.meshes.new_from_object(o.evaluated_get(deps),preserve_all_data_layers=True,depsgraph=deps)
  # Source instance material overrides belong to the object, not the shared mesh.
  for i,slot in enumerate(o.material_slots):
   if i<len(data.materials) and slot.material:data.materials[i]=slot.material
  entries.append((data,o.matrix_world.copy()))
 groups[col.name]=entries;counts[col.name]=len(entries)
export=bpy.data.scenes.new('HN_Export');bpy.context.window.scene=export
for name,entries in groups.items():
 bpy.ops.object.select_all(action='DESELECT');objects=[]
 for data,matrix in entries:
  o=bpy.data.objects.new('HN_ExportPart',data);export.collection.objects.link(o);o.matrix_world=matrix;o.select_set(True);objects.append(o)
 if not objects:continue
 bpy.context.view_layer.objects.active=objects[0];bpy.ops.object.join();o=bpy.context.object;o.name=name;o['role']='visual_only';o['source_map']='100000000'
 # Remove imported empty material slots while keeping the surface assignments.
 bpy.ops.object.material_slot_remove_unused()
path=OUT/'models/henesys.glb'
bpy.ops.export_scene.gltf(filepath=str(path),use_active_scene=True,export_apply=True,export_extras=True,export_animations=False,export_lights=False,export_cameras=False)
polygons=sum(len(o.data.polygons) for o in export.objects if o.type=='MESH')
assert path.stat().st_size>100_000 and len(export.objects)>=8
bpy.context.window.scene=s
# Remove only the disposable generated export scene and its temporary meshes.
for o in list(export.objects):
 data=o.data;bpy.data.objects.remove(o,do_unlink=True)
 if data.users==0:bpy.data.meshes.remove(data)
bpy.data.scenes.remove(export)
s.camera=bpy.data.objects['HN_Overview'];s.render.resolution_x=2400;s.render.resolution_y=1080;s.render.resolution_percentage=100;s.cycles.samples=40
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'models/henesys.blend'))
(OUT/'logs/export.json').write_text(json.dumps({'format':'glTF 2.0 binary','blender':bpy.app.version_string,'bytes':path.stat().st_size,'sourceObjects':counts,'polygons':polygons,'collisionExported':False,'coordinates':'metres; glTF Y-up; source x=(px-3285)/45,y=(450-py)/45,z=-BlenderY'},indent=2),encoding='utf-8')
print('HENESYS_EXPORT_DONE',path.stat().st_size)
