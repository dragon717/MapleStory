"""Author the continuous exposed main deck from the shared walking footprint.

The retained ship/platform/rig remain untouched. Replace the former thin
captain arc with four joined deck regions around the sealed exterior cabin.
"""
import bpy, json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[3]
layout=json.loads((ROOT/'shared/voyage-deck.json').read_text(encoding='utf-8'))
scene=bpy.data.scenes['SV3_ProductionRig'];bpy.context.window.scene=scene;scene.frame_set(1)
ship=scene.objects['SV2_Ship'];parent=scene.objects['SV3_Exterior']
before={o.name:tuple(tuple(v.co) for v in o.data.vertices) for o in scene.objects if o.type=='MESH' and not o.name.startswith('SV3_CaptainArcWalkway_') and o.name!='SV3_MainDeck_Surface' and o.name!='SV3_CaptainPortal_Ring'}
for o in list(scene.objects):
    if o.name.startswith('SV3_CaptainArcWalkway') or o.name=='SV3_MainDeck_Surface':bpy.data.objects.remove(o,do_unlink=True)

def clip(poly,axis,bound,greater):
    result=[]
    for a,b in zip(poly,poly[1:]+poly[:1]):
        inside_a=a[axis]>=bound if greater else a[axis]<=bound
        inside_b=b[axis]>=bound if greater else b[axis]<=bound
        if inside_a:result.append(a)
        if inside_a!=inside_b:
            t=(bound-a[axis])/(b[axis]-a[axis]);result.append(tuple(a[k]+t*(b[k]-a[k]) for k in range(2)))
    return result

surface=layout['surface'];outline=[tuple(p) for p in surface['outline']];room=surface['sealedRoom']
x0=min(p[0] for p in outline);x1=max(p[0] for p in outline)
z0=min(p[1] for p in outline);z1=max(p[1] for p in outline)
rectangles=[(x0,x1,z0,room['zMin']),(x0,x1,room['zMax'],z1),(x0,room['xMin'],room['zMin'],room['zMax']),(room['xMax'],x1,room['zMin'],room['zMax'])]
vertices=[];faces=[];height=surface['height'];thickness=surface['thickness']
for left,right,front,back in rectangles:
    poly=outline
    for axis,bound,greater in [(0,left,True),(0,right,False),(1,front,True),(1,back,False)]:poly=clip(poly,axis,bound,greater)
    # Shared region edges meet exactly. Each region is a thin real timber slab.
    start=len(vertices);n=len(poly)
    vertices.extend((x,-z,y) for y in [height,height-thickness] for x,z in poly)
    faces.append(tuple(start+i for i in range(n-1,-1,-1)))
    faces.append(tuple(start+n+i for i in range(n)))
    faces.extend((start+i,start+(i+1)%n,start+(i+1)%n+n,start+i+n) for i in range(n))
data=bpy.data.meshes.new('SV3_MainDeck_Surface_Mesh');data.from_pydata(vertices,[],faces);data.update()
data.materials.append(bpy.data.materials['SV3_Prototype_DeckTeak'])
uv=data.uv_layers.new(name='MaterialUV')
for p in data.polygons:
    for i in p.loop_indices:
        v=data.vertices[data.loops[i].vertex_index].co
        uv.data[i].uv=(v.x/2.8,-v.y/2.8) if abs(p.normal.z)>.65 else (v.x/2.8+v.y/2.8,v.z/2.8)
obj=bpy.data.objects.new('SV3_MainDeck_Surface',data);scene.collection.objects.link(obj);obj.parent=parent
obj['structural_repair_child']=True;obj['lobby_walkable']=True;obj['walk_surface_source']='shared/voyage-deck.json surface';obj['walk_surface_height']=height
obj['walk_surface_contract']='continuous exposed main deck; cabin excluded; original hull/platform/rig retained'
# Keep the real original portal just above the new floor, with unchanged X/Z.
portal=scene.objects['SV3_CaptainPortal'];portal.location.z=height+.025
ring=scene.objects.get('SV3_CaptainPortal_Ring')
if ring:
    for v in ring.data.vertices:v.co.z=height+.04
for name,positions in before.items():assert positions==tuple(tuple(v.co) for v in scene.objects[name].data.vertices),name+' changed unrelated geometry'
scene['main_deck_walk_surface']=json.dumps(surface,ensure_ascii=False)
bpy.context.preferences.filepaths.save_version=0
for o in scene.objects:o.select_set(o.type in {'MESH','EMPTY'})
bpy.context.view_layer.objects.active=ship
bpy.ops.file.pack_all()
dest=ROOT/'resources/scenes/sky-voyage-v3/models'
bpy.ops.wm.save_as_mainfile(filepath=str(dest/'sky-voyage.blend'),compress=True)
bpy.ops.export_scene.gltf(filepath=str(dest/'sky-voyage.glb'),export_format='GLB',use_selection=True,use_active_scene=True,export_yup=True,export_extras=True,export_apply=False,export_animations=True)
print('MAIN_DECK_READY',json.dumps({'height':height,'outline':surface['outline'],'regions':len(rectangles),'unrelated_meshes_preserved':len(before)},ensure_ascii=False))
