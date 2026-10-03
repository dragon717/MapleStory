"""Repair the retained ship shell and author its walkable captain-room entrance.

Run against a staged sky-voyage.blend; the original source and source scenes remain.
Blender axes are X lateral, -Y ship depth and Z height. No account/game authority.
"""
import bpy, math, sys, json, importlib.util
from pathlib import Path
from mathutils import Vector
ROOT=Path(__file__).resolve().parents[3]
DEST=ROOT/'resources/scenes/sky-voyage-v3/models'
scene=bpy.data.scenes['SV3_ProductionRig'];bpy.context.window.scene=scene;scene.frame_set(1)
ship=bpy.data.objects['SV2_Ship'];hull=bpy.data.objects['SV3_Hull']
archive=bpy.data.scenes.get('SV3_BeforeCaptainRepair') or bpy.data.scenes.new('SV3_BeforeCaptainRepair')
original=bpy.data.objects.get('BeforeCaptainRepair_Hull')
if original is None:
    original=hull.copy();original.data=hull.data.copy();original.name='BeforeCaptainRepair_Hull';original.parent=None;archive.collection.objects.link(original)
else:hull.data=original.data.copy()
# Keep the native login board when rerunning this source refinement.
sign=bpy.data.objects.get('SV2_LoginSign')
if sign:sign.parent=ship

def remove_tree(obj):
    for child in list(obj.children):remove_tree(child)
    bpy.data.objects.remove(obj,do_unlink=True)
for name in ['SV3_CaptainRoom','SV3_AdventureSign']:
    obj=bpy.data.objects.get(name)
    if obj:remove_tree(obj)
def empty(name,parent,position=(0,0,0)):
    obj=bpy.data.objects.new(name,None);scene.collection.objects.link(obj);obj.parent=parent;obj.location=position;return obj
def mesh(name,vertices,faces,material,parent):
    data=bpy.data.meshes.new(name+'_Mesh');data.from_pydata(vertices,[],faces);data.materials.append(material);data.update()
    uv=data.uv_layers.new(name='MaterialUV')
    for p in data.polygons:
        axes=[abs(x) for x in p.normal];axis=axes.index(max(axes));pair=[(1,2),(0,2),(0,1)][axis]
        for i in p.loop_indices:
            co=data.vertices[data.loops[i].vertex_index].co;uv.data[i].uv=(co[pair[0]]/3,co[pair[1]]/3)
    o=bpy.data.objects.new(name,data);scene.collection.objects.link(o);o.parent=parent;return o
def box(name,c,size,mat,parent,bevel=0):
    v=[(c[0]+sx*size[0]/2,c[1]+sy*size[1]/2,c[2]+sz*size[2]/2) for sz in [-1,1] for sy in [-1,1] for sx in [-1,1]]
    o=mesh(name,v,[(0,2,3,1),(4,5,7,6),(0,1,5,4),(2,6,7,3),(0,4,6,2),(1,3,7,5)],mat,parent)
    if bevel:
        mod=o.modifiers.new('Rounded wood edge','BEVEL');mod.width=bevel;mod.segments=3
    return o
wood=bpy.data.materials['SV3_M_Wood'];walnut=bpy.data.materials['SV3_Prototype_SternWalnut'];brass=bpy.data.materials['SV3_Prototype_BrassTrim'];glass=bpy.data.materials['SV3_Prototype_SapphireGlass']
# Locate fragments by welded connectivity, not by arbitrary high vertices or cloth removal.
m=hull.data;keys={};vkeys=[]
for v in m.vertices:
    k=tuple(round(x,4) for x in v.co);vkeys.append(keys.setdefault(k,len(keys)))
parents=list(range(len(keys)))
def find(i):
    while parents[i]!=i:parents[i]=parents[parents[i]];i=parents[i]
    return i
for p in m.polygons:
    vs=[vkeys[v] for v in p.vertices];a=find(vs[0])
    for v in vs[1:]:parents[find(v)]=a
components={}
for p in m.polygons:components.setdefault(find(vkeys[p.vertices[0]]),[]).append(p.index)
fragments=set()
for ids in components.values():
    if len(ids)>8:continue
    pts=[m.vertices[i].co for j in ids for i in m.polygons[j].vertices]
    if min(v.z for v in pts)>15 and max(v.z for v in pts)<20:fragments.update(ids)
# Preserve the source curved roof, UVs and interpolated normals; clip real voids.
spec=importlib.util.spec_from_file_location('clip_voyage_hull',ROOT/'scripts/creative/blender/clip_voyage_hull.py');clip=importlib.util.module_from_spec(spec);spec.loader.exec_module(clip)
spec=importlib.util.spec_from_file_location('repair_voyage_cut_boundaries',ROOT/'scripts/creative/blender/repair_voyage_cut_boundaries.py');boundary=importlib.util.module_from_spec(spec);spec.loader.exec_module(boundary)
# Fragment indices and material labels refer to the unsplit archived topology.
repaired,restored_parts=boundary.repair(m,bpy.data.objects['BeforeRepair_SV3_Hull'].data,clip,fragments)
hull.data,roof_data=clip.refine_hull(repaired,set())
hull['captain_room_repair']='exact room/jewel openings; continuous paint boundaries; retained source UV and normals'
removed_room=len(m.polygons)-len(hull.data.polygons)
room=empty('SV3_CaptainRoom',bpy.data.objects['SV3_Exterior'])
roof=bpy.data.objects.new('SV3_CaptainRoof',roof_data);scene.collection.objects.link(roof);roof.parent=room
roof['cutaway_rooms']=room.name
room['lobby_walkable']=False
# Exterior shell only: no walk-in room floor or threshold.
box('SV3_CaptainDoorSeal',(4.8,-13.25,6.77),(.34,2.5,2.7),walnut,room)
# Explicit side wall sections leave a genuine 2.5m doorway.
for name,z0,z1 in [('Forward',0,12),('Aft',14.5,18)]:
    box('SV3_CaptainWall_'+name,(4.75,-(z0+z1)/2,6.86),(.24,z1-z0,2.88),walnut,room)
box('SV3_CaptainDoorLintel',(4.75,-13.25,8.23),(.30,2.7,.24),brass,room,.035)
box('SV3_CaptainWall_Port',(-4.75,-9,6.86),(.24,18,2.88),walnut,room)
for z in [0,18]:box('SV3_CaptainWall_End_'+str(z),(0,-z,6.86),(9.5,.24,2.88),walnut,room)
door=empty('SV3_CaptainDoorOpening',room,(4.8,-13.25,5.42));door['width']=2.5;door['height']=2.7;door['lobby_target']='SV3_CabinInterior';door['trigger_radius']=1.15
# The original vertical 2D portal stands outside the sealed shell.
portal=empty('SV3_CaptainPortal',room,(5.65,-13.25,5.42));portal['lobby_target']='SV3_CabinInterior'
verts=[];faces=[]
for r in [ .69,.84 ]:
    for i in range(64):a=i*math.tau/64;verts.append((5.65+r*math.cos(a),-13.25+r*math.sin(a),5.46))
for i in range(64):j=(i+1)%64;faces.append((i,j,j+64,i+64))
mesh('SV3_CaptainPortal_Ring',verts,faces,brass,room)
# The captain window is a real opening in the new side wall, with a transmissive jewel pane.
wall=bpy.data.objects['SV3_CaptainWall_Forward']
# Replace rectangular wall section with a perimeter around the visible rounded porthole.
remove_tree(wall)
for name,z0,z1 in [('Bow',0,2.2),('Middle',4.4,12)]:box('SV3_CaptainWall_'+name,(4.75,-(z0+z1)/2,6.86),(.24,z1-z0,2.88),walnut,room)
for y,height in [(5.65,.46),(8.09,.22)]:box('SV3_CaptainWindow_'+str(y),(4.75,-3.3,y),(.24,2.2,height),walnut,room)
verts=[];faces=[]
for x,r in [(4.65,1.06),(4.92,1.06),(4.93,.89),(4.65,.89)]:
    for i in range(64):a=i*math.tau/64;verts.append((x,-3.3+r*math.cos(a),7+r*math.sin(a)))
for k in range(3):
    for i in range(64):j=(i+1)%64;faces.append((k*64+i,k*64+j,(k+1)*64+j,(k+1)*64+i))
mesh('SV3_CaptainPorthole_Frame',verts,faces,brass,room)
verts=[(4.79,-3.3,7)]+[(4.79,-3.3+.88*math.cos(i*math.tau/64),7+.88*math.sin(i*math.tau/64)) for i in range(64)]
mesh('SV3_CaptainPorthole_Glass',verts,[(0,i+1,(i+1)%64+1) for i in range(64)],glass,room)
# Login remains a physical readable board, mounted on the starboard exterior.
# Blender uses X lateral / -Y ship depth / Z up; the exported glTF position is
# therefore (10.3, 5.4, 0) with its face looking out through +X.  Keeping the
# sign on the ship root makes it visible from the exterior login camera and
# prevents it from being hidden with the berth-room cutaway.
ship=bpy.data.objects['SV2_Ship']
sign=bpy.data.objects['SV2_LoginSign'];sign.parent=ship;sign.location=(10.3,0,5.4);sign.scale=(1,1,1);sign.rotation_euler=(0,0,math.pi/2)
# A separate small irregular beveled adventure sign sits between door and window.
adventure=empty('SV3_AdventureSign',room,(4.50,-10.3,7.0));adventure.rotation_euler=(0,0,-math.pi/2)
outline=[(-.95,-.34),(-.76,-.39),(.71,-.35),(.91,-.21),(.86,.28),(.66,.37),(-.75,.32),(-.97,.16)]
verts=[(x,y,z) for y in [-.10,.10] for x,z in outline];n=len(outline)
faces=[tuple(range(n-1,-1,-1)),tuple(range(n,n*2))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
board=mesh('SV3_AdventureBoard',verts,faces,wood,adventure);mod=board.modifiers.new('Convex timber bevel','BEVEL');mod.width=.055;mod.segments=3
bpy.context.view_layer.objects.active=board;bpy.ops.object.modifier_apply(modifier=mod.name)
surface=empty('SV3_AdventureSurface',adventure,(0,-.135,0));surface['width']=1.55;surface['height']=.50
# The retained bed set has its own visible, authored local return portal.
cabin=bpy.data.objects['SV3_CabinInterior']
for name in ['SV3_CabinDeckPortal','SV3_CabinDeckPortal_Ring']:
    old=bpy.data.objects.get(name)
    if old:remove_tree(old)
back=empty('SV3_CabinDeckPortal',cabin,(0,-47.1,.03));back['lobby_target']='SV3_CaptainPortal';back['trigger_radius']=.7
verts=[];faces=[]
for r in [.70,.82]:
    for i in range(64):a=i*math.tau/64;verts.append((r*math.cos(a),-47.1+r*math.sin(a),.03))
for i in range(64):j=(i+1)%64;faces.append((i,j,j+64,i+64))
mesh('SV3_CabinDeckPortal_Ring',verts,faces,brass,cabin)
# Only enclosing room walls/roof use full room cutaway; rails keep normal partial occlusion.
for o in room.children:
    if o.name in ['SV3_CaptainWall_Port','SV3_CaptainWall_End_0']:o['cutaway_rooms']=room.name
# Remove each opaque backing cap on the real gem settings; transmissive material remains opaque-pass physical glass.
for o in scene.objects:
    if o.type!='MESH' or not o.name.startswith('SV3_Repaired_') or 'Setting_' not in o.name:continue
    old=o.data;polys=[p for p in old.polygons if len(p.vertices)<40]
    if len(polys)==len(old.polygons):continue
    new=bpy.data.meshes.new(o.name+'_OpenBack');new.from_pydata([v.co for v in old.vertices],[],[tuple(p.vertices) for p in polys]);new.update()
    for mat in old.materials:new.materials.append(mat)
    for p,q in zip(new.polygons,polys):p.material_index=q.material_index
    o.data=new;o['jewel_backing']='opaque brass cap removed; open transmissive cabochon'
# Cover the precisely cut source boundary with a continuous open jewel collar.
# Original fused brass/glass fragments cannot remain behind the new cabochon.
for o in list(scene.objects):
    if o.name.startswith('SV3_JewelCollar_'):remove_tree(o)
for side in [-1,1]:
    for label,y,z,r in [('Jade',12,3.5,2.25),('Sapphire',21.2,8.15,3),('Stern',-30,8,2.9)]:
        rings=[(7.45,r*.82),(10.37,r*.82),(10.37,r*1.18),(9.6,r*1.18)]
        verts=[];faces=[];count=96
        for x,radius in rings:
            for i in range(count):
                a=i*math.tau/count;verts.append((side*x,y+radius*math.cos(a),z+radius*math.sin(a)))
        for k in range(len(rings)-1):
            for i in range(count):
                j=(i+1)%count;f=(k*count+i,k*count+j,(k+1)*count+j,(k+1)*count+i)
                faces.append(f if side==1 else tuple(reversed(f)))
        collar=mesh('SV3_JewelCollar_'+label+'_'+str(side),verts,faces,brass,hull)
        for p in collar.data.polygons:p.use_smooth=True
        collar['jewel_open_collar']=True
# Apply the independently reviewed material helper without touching geometry.
spec=importlib.util.spec_from_file_location('voyage_material_refinement',ROOT/'scripts/creative/blender/voyage_material_refinement.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);module.refine_materials(scene)
# Move and invert the same continuous image in global gore coordinates, never per-piece repetitions.
for i in range(3):
    o=bpy.data.objects[f'SV3_MainSail_Crest_{i}'];u0,u1=o['emblem_u_range']
    for loop in o.data.loops:
        k=loop.vertex_index%429;u=k%13/12;v=k//13/32;gu=u0+(u1-u0)*u
        # Facing starboard, the larger forward/left span is the lower global-U area.
        o.data.uv_layers['Emblem'].data[loop.index].uv=((v-.30)/.40,1-gu-.12)
    o['emblem_rotation_degrees']=270;o['emblem_shift_global_u']=-.12
for o in scene.objects:o.select_set(o.type in {'MESH','EMPTY'})
bpy.context.view_layer.objects.active=ship
bpy.ops.file.pack_all();bpy.ops.wm.save_as_mainfile(filepath=str(DEST/'sky-voyage.blend'),compress=True)
bpy.ops.export_scene.gltf(filepath=str(DEST/'sky-voyage.glb'),export_format='GLB',use_selection=True,use_active_scene=True,export_yup=True,export_extras=True,export_apply=False,export_animations=True)
print('CAPTAIN_ROOM_REPAIR',json.dumps({'static_fragment_faces':len(fragments),'source_hull_faces':len(m.polygons),'clipped_hull_faces':len(hull.data.polygons),'door':[4.8,5.42,13.25],'adventure':[5.01,7,10.3]},ensure_ascii=False))
