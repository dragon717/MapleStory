"""Separate the production ship from its independently editable map and set F12 cameras.
Run with Blender -b models/sky-voyage.blend --python this_file.
"""
import bpy, sys, json, hashlib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'scripts/creative/blender'))
from voyage_render_setup import setup_ship_render,setup_city_render
from refine_voyage_mast_connections import save_export
EVIDENCE=ROOT/'evidence/2026-10-04/voyage-split-opening';EVIDENCE.mkdir(parents=True,exist_ok=True)
scene=bpy.data.scenes['SV3_ProductionRig'];bpy.context.window.scene=scene;scene.frame_set(1)
ship=scene.objects['SV2_Ship'];owned={ship,*ship.children_recursive}
def fingerprint(objects):
 h=hashlib.sha256()
 for o in sorted(objects,key=lambda o:o.name):
  if o.type!='MESH':continue
  h.update(o.name.encode('utf-8'))
  h.update(repr([(tuple(v.co)) for v in o.data.vertices]).encode())
  h.update(repr([tuple(p.vertices) for p in o.data.polygons]).encode())
  h.update(repr(tuple(tuple(r) for r in o.matrix_local)).encode())
 return h.hexdigest()
before=fingerprint(owned)
city_objects=set()
for s in list(bpy.data.scenes):
 if s.name=='SC_SpatialPrototype':city_objects.update(s.objects);bpy.data.scenes.remove(s)
for o in bpy.data.objects:
 if o.name=='SV2_City':city_objects.update({o,*o.children_recursive})
removed=[]
for o in city_objects-owned:
 removed.append(o.name);bpy.data.objects.remove(o,do_unlink=True)
assert before==fingerprint(owned),'ship geometry or transforms changed while splitting'
report={'shipGeometrySha256':before,'removedCityObjects':len(removed),'shipScene':scene.name}
# Preserve both cameras: the recipe reuses its default camera, so copy the top
# view before restoring the default perspective camera and lighting setup.
report['top']=setup_ship_render(scene,[ship],view='top')
if 'SV3_Render_Top' in scene.objects:bpy.data.objects.remove(scene.objects['SV3_Render_Top'],do_unlink=True)
top=scene.camera.copy();top.data=scene.camera.data.copy();top.name='SV3_Render_Top';scene.collection.objects.link(top)
report['ship']=setup_ship_render(scene,[ship])
scene['independent_asset']='ship; map is sky-city-spatial-prototype.blend'
save_export(scene)
ship_path=bpy.data.filepath
city_path=ROOT/'resources/scenes/sky-voyage-v3/prototypes/sky-city-spatial-prototype.blend'
bpy.ops.wm.open_mainfile(filepath=str(city_path))
city_scene=bpy.data.scenes['SC_SpatialPrototype'];bpy.context.window.scene=city_scene
roots=[o for o in city_scene.objects if o.parent is None and o.type not in {'CAMERA','LIGHT'}]
city_before=fingerprint(city_scene.objects)
report['city']=setup_city_render(city_scene,roots)
assert fingerprint([o for o in city_scene.objects if o.type=='MESH'])==city_before,'city geometry changed'
city_scene['independent_asset']='city; ship is sky-voyage.blend'
bpy.context.preferences.filepaths.save_version=0
bpy.ops.file.pack_all();bpy.ops.wm.save_as_mainfile(filepath=str(city_path),compress=True)
# Render rig is deliberately excluded from the runtime GLB; lighting belongs
# to the runtime while F12 uses the scene's saved camera and lights.
for o in city_scene.objects:o.select_set(o.type in {'MESH','EMPTY'})
bpy.ops.export_scene.gltf(filepath=str(city_path.with_suffix('.glb')),export_format='GLB',use_selection=True,use_active_scene=True,export_yup=True,export_extras=True,export_apply=False,export_animations=True)
book_path=ROOT/'resources/scenes/sky-voyage-v3/models/voyage-book.blend'
bpy.ops.wm.open_mainfile(filepath=str(book_path))
book_scene=bpy.context.scene
book_roots=[o for o in book_scene.objects if o.parent is None and o.type not in {'CAMERA','LIGHT'}]
report['book']=setup_ship_render(book_scene,book_roots)
bpy.context.preferences.filepaths.save_version=0;bpy.ops.file.pack_all();bpy.ops.wm.save_as_mainfile(filepath=str(book_path),compress=True)
(EVIDENCE/'native-split-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print('SPLIT_READY',ship_path)
