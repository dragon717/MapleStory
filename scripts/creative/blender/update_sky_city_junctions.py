"""Patch authored roads and courtyard loops in the existing editable city, preserving scenery."""
import bpy, json, math, ast
from pathlib import Path
from mathutils import Vector
ROOT=Path('/Users/muniao/Code/MapleStory')
DEST=ROOT/'resources/scenes/sky-voyage-v3/prototypes'
scene=bpy.data.scenes['SC_SpatialPrototype'];bpy.context.window.scene=scene
LAYOUT=json.loads((DEST/'sky-city-spatial-layout.json').read_text(encoding='utf-8'))
previous=json.loads(scene['spatial_layout']);old={e['id']:e for e in previous['edges']}
# Reuse the production road builder, including stair top faces and backing.
source=(ROOT/'scripts/creative/blender/build_sky_city_prototype.py').read_text(encoding='utf-8')
tree=ast.parse(source)
for definition in tree.body:
    if isinstance(definition,ast.FunctionDef) and definition.name in ('native','pad','road_object','road_mesh'):
        exec(compile(ast.Module(body=[definition],type_ignores=[]),str(ROOT/'scripts/creative/blender/build_sky_city_prototype.py'),'exec'))
neutral=bpy.data.materials['SC_Ivory'];wood=bpy.data.materials['SC_CraftWood']
rainbow=[bpy.data.materials['SC_Rainbow_'+str(i)] for i in range(7)]
changed=[]
for edge in LAYOUT['edges']:
    if edge==old.get(edge['id']):continue
    for obj in list(scene.objects):
        if obj.get('edge_id')==edge['id']:bpy.data.objects.remove(obj,do_unlink=True)
    road_mesh(edge);changed.append(edge['id'])
existing={o.get('node_id') for o in scene.objects}
for n in LAYOUT['nodes']:
    if n['id'] in existing:continue
    obj=pad(n['id']+'_Landing',n['position'],2.1,neutral)
    obj['node_id']=n['id'];obj['motion_node']=n['id'];obj['zone']=n['zone'];obj['flat_landing']=True
# Interior corridor landings are smaller than their new ring: extend the real floor.
for n in LAYOUT['nodes']:
    if not any(e['id'].startswith('J-'+n['id']+'-') for e in LAYOUT['edges']):continue
    landing=next((p for p in LAYOUT['landings'] if p['node']==n['id']),None)
    needed=max(math.hypot(p[0]-n['position'][0],p[2]-n['position'][2])+e['width']/2 for e in LAYOUT['edges'] if e['id'].startswith('J-'+n['id']+'-') for p in e['points'])
    if landing and landing['radius']>=needed:continue
    name='SC_'+n['id']+'_FourArrowCourtyard'
    oldpad=bpy.data.objects.get(name)
    if oldpad:bpy.data.objects.remove(oldpad,do_unlink=True)
    p=list(n['position']);p[1]-=.04
    obj=pad(n['id']+'_FourArrowCourtyard',p,needed,neutral)
    obj['motion_node']=n['id'];obj['walk_surface']='backed courtyard floor';obj['zone']=n['zone']
scene['spatial_layout']=json.dumps(LAYOUT,ensure_ascii=False)
bpy.ops.wm.save_as_mainfile(filepath=str(DEST/'sky-city-spatial-prototype.blend'))
bpy.ops.export_scene.gltf(filepath=str(DEST/'sky-city-spatial-prototype.glb'),export_format='GLB',use_active_scene=True,export_animations=False,export_extras=True,export_cameras=False,export_lights=False)
print('FOUR_WAY_CITY',len(changed),'changed roads',len(LAYOUT['edges']),'total')
