"""Bounded cabin fittings and restoration of the existing captain porthole.
Run last against the current editable production source. Preserve the original
hull/platform/rig; only the existing circular window receives its missing void.
Blender axes: X lateral, -Y depth, Z up.
"""
import bpy, math, json, hashlib, array, importlib.util
from pathlib import Path
from mathutils import Vector
ROOT=Path(__file__).resolve().parents[3]
DEST=ROOT/'resources/scenes/sky-voyage-v3/models'
scene=bpy.data.scenes['SV3_ProductionRig'];bpy.context.window.scene=scene;scene.frame_set(1)
beds_layout=json.loads((ROOT/'resources/scenes/sky-voyage-v3/source-layout.json').read_text(encoding='utf-8'))['ship']['beds']
assert beds_layout['visualCount']==len(beds_layout['anchors'])==12
ship=scene.objects['SV2_Ship'];cabin=scene.objects['SV3_CabinInterior'];room=scene.objects['SV3_CaptainRoom']
def fingerprint(obj):
    coords=array.array('f',[0.0])*(len(obj.data.vertices)*3);obj.data.vertices.foreach_get('co',coords)
    return (len(obj.data.polygons),hashlib.sha256(coords.tobytes()).hexdigest())
before={o.name:fingerprint(o) for o in scene.objects if o.type=='MESH' and not o.name.startswith(('SV3_CabinLamp','SV3_CaptainDoorDetail','SV3_CaptainPorthole')) and o.name not in {'SV3_Hull','SV3_CabinDeckPortal_Ring'}}
for obj in list(scene.objects):
    if obj.name.startswith(('SV3_CabinLamp','SV3_CaptainDoorDetail')):bpy.data.objects.remove(obj,do_unlink=True)

def empty(name,parent,location=(0,0,0)):
    o=bpy.data.objects.new(name,None);scene.collection.objects.link(o);o.parent=parent;o.location=location;return o

def finish(o,name,parent,material):
    o.name=name;o.parent=parent;o.data.materials.clear();o.data.materials.append(material)
    for p in o.data.polygons:p.use_smooth=True
    return o

def bevel(o,width=.025):
    m=o.modifiers.new('Fine rounded edge','BEVEL');m.width=width;m.segments=3
    bpy.context.view_layer.objects.active=o;bpy.ops.object.modifier_apply(modifier=m.name)
    return o

def cylinder(name,parent,centre,radius,depth,material,rotation=(0,0,0)):
    bpy.ops.mesh.primitive_cylinder_add(vertices=32,radius=radius,depth=depth,location=centre,rotation=rotation)
    return bevel(finish(bpy.context.object,name,parent,material),min(.018,depth/4))

def box(name,parent,centre,size,material):
    bpy.ops.mesh.primitive_cube_add(size=1,location=centre);o=bpy.context.object;o.scale=size
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    return bevel(finish(o,name,parent,material),min(.025,min(size)/4))

brass=bpy.data.materials['SV3_Prototype_BrassTrim'];wood=bpy.data.materials['SV3_Prototype_SternWalnut']
glass=bpy.data.materials.get('SV3_CabinLampGlass');shader=next(n for n in glass.node_tree.nodes if n.type=='BSDF_PRINCIPLED')
shader.inputs['Base Color'].default_value=(.65,.36,.11,1);shader.inputs['Roughness'].default_value=.28
shader.inputs['Emission Color'].default_value=(1,.42,.09,1);shader.inputs['Emission Strength'].default_value=1.3
for i,x in enumerate([-11.7,-3.6,4.5,11.7]):
    lamp=empty('SV3_CabinLamp_'+str(i),cabin,(x,-42.6,2.2));lamp['fitting_revision']='brass cage, crown, base, suspended glass, hanging loop'
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32,ring_count=16,radius=.17,location=(0,0,0));o=finish(bpy.context.object,lamp.name+'_Glass',lamp,glass);o.scale=(1,1,1.75)
    for name,z,r,h in [('Base',-.32,.21,.09),('Crown',.32,.21,.09),('Finial',.42,.09,.12)]:cylinder(lamp.name+'_'+name,lamp,(0,0,z),r,h,brass)
    for j in range(6):
        a=j*math.tau/6;box(lamp.name+'_Cage_'+str(j),lamp,(.185*math.cos(a),.185*math.sin(a),0),(.025,.025,.59),brass)
    bpy.ops.mesh.primitive_torus_add(major_segments=32,minor_segments=8,location=(0,0,.55),rotation=(math.pi/2,0,0),major_radius=.085,minor_radius=.014)
    finish(bpy.context.object,lamp.name+'_HangingLoop',lamp,brass)
    cylinder(lamp.name+'_Stem',lamp,(0,0,.74),.018,.27,brass)

# Slightly clear the centre interaction group, without rebuilding any bed mesh.
for index,(x,y,z) in enumerate(beds_layout['anchors']):
    bed=scene.objects['SV2_Bed_'+str(index)];bed.location=(x,-z,y)
px,py,pz=beds_layout['returnPortal']
portal=scene.objects['SV3_CabinDeckPortal'];portal.location=(px,-pz,py);portal['trigger_radius']=1.0
portal['layout']='on the horizontal bed aisle; no vertical walking spur'
ring=scene.objects.get('SV3_CabinDeckPortal_Ring')
if ring and not ring.get('aligned_aisle'):
    for v in ring.data.vertices:v.co.y+=1.7
    ring['aligned_aisle']=True

# Restore the missing circular opening only where the retained shell covers
# the previously authored porthole. Split boundary vertices interpolate UVs/normals.
hull=scene.objects['SV3_Hull']
if hull.get('circular_porthole_restored') != 2:
    old_revision=hull.get('circular_porthole_restored',False)
    spec=importlib.util.spec_from_file_location('clip_voyage_hull',Path(__file__).with_name('clip_voyage_hull.py'));clip=importlib.util.module_from_spec(spec);spec.loader.exec_module(clip)
    old=hull.data;old.calc_loop_triangles();normals=old.corner_normals;polys=[];removed=0
    planes=[(Vector((1,0,0)),4.4),(Vector((-1,0,0)),-5.8)]
    for i in range(64):
        a=i*math.tau/64;cy,sz=math.cos(a),math.sin(a)
        planes.append((Vector((0,-cy,-sz)),-(1.12-3.3*cy+7*sz)))
    for p in old.polygons:
        poly=[(old.vertices[old.loops[k].vertex_index].co.copy(),[layer.data[k].uv.copy() for layer in old.uv_layers],normals[k].vector.copy()) for k in p.loop_indices]
        pts=[v[0] for v in poly]
        if any(max(v[a] for v in pts)<lo or min(v[a] for v in pts)>hi for a,lo,hi in [(0,4.4,5.8),(1,-4.43,-2.17),(2,5.87,8.13)]):outside=[poly]
        else:
            inside,outside=clip.partition(poly,planes)
            if inside:removed+=1
        polys.extend((part,p.material_index,p.use_smooth) for part in outside)
    hull.data=clip.build('SV3_Hull_PortholeRestored',polys,old);hull['circular_porthole_restored']=2;hull['porthole_source_faces_clipped']=hull.get('porthole_source_faces_clipped',0)+removed
    for name in ['SV3_CaptainPorthole_Frame','SV3_CaptainPorthole_Glass']:
        obj=scene.objects[name]
        if not old_revision:
            for v in obj.data.vertices:v.co.x+=.34
    hull['porthole_repair']='existing YZ circle (-3.3,7), radius 1.12; source UV/normals retained, rim outset .34'

# The sealed door keeps its existing collision/footprint; fine fittings are
# separate editable children rather than another replacement cabin shell.
door=empty('SV3_CaptainDoorDetail',room);door['source']='fittings on the existing sealed captain door'
for j in range(7):
    y=-13.25+(j-3)*.30
    box('SV3_CaptainDoorDetail_Plank_'+str(j),door,(5.0,y,6.78),(.12,.286,2.36),wood)
for z in [5.56,7.99]:box('SV3_CaptainDoorDetail_Trim_'+str(z),door,(5.075,-13.25,z),(.075,2.26,.075),brass)
for z in [5.91,7.62]:
    box('SV3_CaptainDoorDetail_Hinge_'+str(z),door,(5.08,-14.18,z),(.075,.34,.10),brass)
    cylinder('SV3_CaptainDoorDetail_Pin_'+str(z),door,(5.15,-14.26,z),.045,.23,brass)
cylinder('SV3_CaptainDoorDetail_HandlePlate',door,(5.12,-12.51,6.72),.13,.04,brass,(0,math.pi/2,0))
bpy.ops.mesh.primitive_torus_add(major_segments=32,minor_segments=8,location=(5.17,-12.51,6.64),rotation=(0,math.pi/2,0),major_radius=.105,minor_radius=.019)
finish(bpy.context.object,'SV3_CaptainDoorDetail_HandleRing',door,brass)
for name,fp in before.items():assert fingerprint(scene.objects[name])==fp,name+' unrelated mesh changed'
scene['cabin_details_revision']='2026-10-04: lamps, horizontal return portal, small bed offsets and restored round porthole'
for o in scene.objects:o.select_set(o.type in {'MESH','EMPTY'})
bpy.context.view_layer.objects.active=ship;bpy.context.preferences.filepaths.save_version=0
bpy.ops.file.pack_all();bpy.ops.wm.save_as_mainfile(filepath=str(DEST/'sky-voyage.blend'),compress=True)
bpy.ops.export_scene.gltf(filepath=str(DEST/'sky-voyage.glb'),export_format='GLB',use_selection=True,use_active_scene=True,export_yup=True,export_extras=True,export_apply=False,export_animations=True)
print('CABIN_DETAILS_READY',json.dumps({'preserved_meshes':len(before),'porthole_source_faces':hull.get('porthole_source_faces_clipped'),'portal':list(portal.location),'beds':12},ensure_ascii=False))
