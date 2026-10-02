# Live Blender MCP, after map_ship_prototype_materials.py.
# Repair the supplied reconstruction's fused cloth/rods, broken boundaries and energy cradle.
# The unmodified meshes and shape keys remain in SV3_BeforeStructureRepair.
import bpy, math, json
from mathutils import Vector, Matrix

BASE='/Users/muniao/Code/MapleStory/resources/scenes/sky-voyage-v3/'
scene=bpy.data.scenes['SV3_ProductionRig'];bpy.context.window.scene=scene;scene.frame_set(1)
archive=bpy.data.scenes.get('SV3_BeforeStructureRepair') or bpy.data.scenes.new('SV3_BeforeStructureRepair')
M={key:bpy.data.materials['SV3_Prototype_'+key] for key in ['SparWood','SailLinen','BrassTrim','NavyIron','AmberCrystal','HullIvory','SternWalnut']}
for o in list(scene.objects):
    if o.get('structural_repair_child'):bpy.data.objects.remove(o,do_unlink=True)

def preserve(obj):
    name='BeforeRepair_'+obj.name
    old=bpy.data.objects.get(name)
    if not old:
        old=obj.copy();old.data=obj.data.copy();old.name=name;archive.collection.objects.link(old)
        old.parent=None;old.matrix_world=obj.matrix_world;old.animation_data_clear()
    return old

def make_mesh(name,verts,faces,slots,uvs=None):
    mesh=bpy.data.meshes.new(name);mesh.from_pydata(verts,[],[f[0] for f in faces]);mesh.update()
    for mat in slots:mesh.materials.append(mat)
    source=mesh.uv_layers.new(name='SourceUV');uv=mesh.uv_layers.new(name='MaterialUV')
    for poly,(_,slot) in zip(mesh.polygons,faces):
        poly.material_index=slot;poly.use_smooth=True
        axes=[abs(v) for v in poly.normal];axis=axes.index(max(axes));pair_axes=[(1,2),(0,2),(1,0)][axis]
        projected=not uvs
        if uvs and len(poly.vertices)>2:
            a,b,c=[uvs[i] for i in list(poly.vertices)[:3]]
            projected=abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))<1e-8
        for loop in poly.loop_indices:
            i=mesh.loops[loop].vertex_index;co=mesh.vertices[i].co
            pair=(co[pair_axes[0]]/3,co[pair_axes[1]]/3) if projected else uvs[i]
            source.data[loop].uv=pair;uv.data[loop].uv=pair
    mesh.uv_layers.active=uv;uv.active_render=True
    return mesh

def morph(obj,folded=None,pressure=None):
    if folded is None and pressure is None:return
    obj.shape_key_add(name='Basis')
    for name,coords in [('DeployFold',folded),('WindPressure',pressure)]:
        if coords is None:continue
        key=obj.shape_key_add(name=name)
        for v,co in zip(key.data,coords):v.co=co
        for frame,value in [(1,0),(40,1 if name=='DeployFold' else 0),(65,0),(95,0),(120,0)]:
            key.value=value;key.keyframe_insert(data_path='value',frame=frame)
        key.value=0

def child(name,parent,verts,faces,slots,folded=None,uvs=None):
    obj=bpy.data.objects.new(name,make_mesh(name,verts,faces,slots,uvs));scene.collection.objects.link(obj);obj.parent=parent
    obj['structural_repair_child']=True;obj['material_region']=name
    morph(obj,folded);return obj

def tube(verts,faces,a,b,r,slot=0,segments=10,uvs=None,folded=None,rotation=None,origin=None):
    a,b=Vector(a),Vector(b);axis=(b-a).normalized();u=axis.cross(Vector((1,0,0)))
    if u.length<.01:u=axis.cross(Vector((0,1,0)))
    u.normalize();v=axis.cross(u);start=len(verts)
    for end,p in enumerate([a,b]):
        for i in range(segments):
            angle=i*math.tau/segments;co=p+r*(u*math.cos(angle)+v*math.sin(angle));verts.append(co)
            if uvs is not None:uvs.append(((b-a).length*end/8,i/segments*.22))
            if folded is not None:folded.append(origin+rotation@(co-origin))
    for i in range(segments):
        j=(i+1)%segments;faces.append(((start+i,start+j,start+segments+j,start+segments+i),slot))
    faces.append((tuple(start+i for i in range(segments-1,-1,-1)),slot));faces.append((tuple(start+segments+i for i in range(segments)),slot))

def repair_fan(name,origin,edges,sector,sides,kind):
    obj=bpy.data.objects[name];preserve(obj);obj.location=origin;obj.rotation_euler=(0,0,0)
    verts=[];faces=[];uv=[];folded=[];wind=[];rods=[];rod_faces=[];rod_uv=[];rod_fold=[]
    pivot=Vector(origin);median=math.pi if kind=='Main' else math.radians(132)
    for side in sides:
        endpoints=[Vector((side*e[0],e[1],e[2])) for e in edges]
        a,b=endpoints[sector],endpoints[sector+1]
        rotations=[]
        for p in [a,b]:
            angle=math.atan2(p.z-pivot.z,p.y-pivot.y)%(math.tau)
            rotations.append(Matrix.Rotation((median-angle)*.68,3,'X') if kind in ['Main','Aft'] else Matrix.Identity(3))
        start=len(verts);nu,nv=32,12
        for i in range(nu+1):
            t=.035+.965*i/nu
            for j in range(nv+1):
                s=j/nv;radial=t*(1-.13*math.sin(s*math.pi))
                pa=pivot+(a-pivot)*radial;pb=pivot+(b-pivot)*radial
                billow=side*.65*math.sin(math.pi*t)*math.sin(math.pi*s)
                co=pa.lerp(pb,s)+Vector((billow,0,0));verts.append(co-pivot)
                fa=rotations[0]@(pa-pivot);fb=rotations[1]@(pb-pivot)
                folded.append(fa.lerp(fb,s)+Vector((billow*.2,0,0)))
                wind.append(co-pivot+Vector((side*.8*math.sin(math.pi*t)*math.sin(math.pi*s),0,0)))
                uv.append((radial*(a-pivot).length/.7,s*(a-b).length/.7))
        for i in range(nu):
            for j in range(nv):
                q=start+i*(nv+1)+j;faces.append(((q,q+1,q+nv+2,q+nv+1),0))
        # Each shared rib has one owner. Rod and ferrules have rigid folding only, no wind key.
        for index in ([0,1] if sector==0 else [1]):
            end=[a,b][index]-pivot;rot=rotations[index]
            tube(rods,rod_faces,(0,0,0),end,.43 if kind in ['Main','Aft'] else .32,0,12,rod_uv,rod_fold,rot,Vector((0,0,0)))
            for t in [.22,.57,.84]:
                tube(rods,rod_faces,end*(t-.009),end*(t+.009),.49 if kind in ['Main','Aft'] else .37,1,12,rod_uv,rod_fold,rot,Vector((0,0,0)))
    obj.data=make_mesh(name+'_RepairedCloth',verts,faces,[M['SailLinen']],uv)
    morph(obj,folded if kind in ['Main','Aft'] else None,wind)
    obj['structural_repair']='continuous retopologized cloth; original fused mesh retained in archive'
    obj['material_region']='cloth only';obj['wind_pin_source']='zero pressure at four patch edges'
    obj['repair_source_scene']=archive.name
    if kind not in ['Main','Aft'] and 'fold_morph' in obj:del obj['fold_morph']
    rod=child(name+'_TimberSpars',obj,rods,rod_faces,[M['SparWood'],M['NavyIron']],rod_fold if kind in ['Main','Aft'] else None,rod_uv)
    rod['rigid_wind_pins']=True;rod['repair_spar_count']=4 if sector==0 else 2

main=[(10,-40,43),(13,-37,29),(11,-36,15),(8,-25,8)]
aft=[(8,-53.6,36.2),(10,-63.1,33.5),(10,-73,29),(8,-75,17.2)]
for i in range(3):
    repair_fan('SV3_MainFan_'+str(i),(0,25.56,29.23),main,i,[-1,1],'Main')
    repair_fan('SV3_AftFan_'+str(i),(0,-39,14),aft,i,[-1,1],'Aft')

# Each rudder root still uses its approved pivot and runtime turning/folding quaternion.
for prefix,origin,edges in [
    ('BowVane',(9.6835,53.7336,-5.8101),[(10,20.2,-14),(10,27.4,-20),(9,35.9,-24.5),(6,44.8,-28)]),
    ('AftVane',(9.6835,-36.0588,-8.451),[(12,-64,-8.8),(16,-58,-15),(19,-49.1,-25.1),(18,-36.6,-27.4)])]:
    for suffix,side in [('Port',-1),('Starboard',1)]:
        name='SV3_'+prefix+'_'+suffix;root=bpy.data.objects[name];preserve(root)
        # Build three patches temporarily then combine, retaining one rig node per rudder.
        patch_objects=[]
        for i in range(3):
            part=root if i==0 else root.copy()
            if i:
                part.data=root.data.copy();part.name=name+'_Patch_'+str(i);scene.collection.objects.link(part)
                part['structural_repair_child']=True
                for key in ['rig_kind','source_triangles','wind_morph','fold_angle']:
                    if key in part:del part[key]
            repair_fan(part.name,(side*origin[0],origin[1],origin[2]),edges,i,[side],'Rudder')
            if i:
                part.parent=root;part.location=(0,0,0)
            patch_objects.append(part)

# Remove fused remnants above the cabin/mast. The original Hull data and morphs are archived.
hull=bpy.data.objects['SV3_Hull'];source=preserve(hull);old=source.data
kept=[]
for p in old.polygons:
    c=p.center
    if 'SailLinen' in old.materials[p.material_index].name:continue
    if c.z>19 and not (c.z>46 and abs(c.x)<6 and -17<c.y<-5):continue
    if c.y<-39 and c.z>15.3:continue
    if 6<c.z<46 and abs(c.x)<4 and -14<c.y<-6:continue
    jewel=((c.y+30)/3.6)**2+((c.z-8)/3.2)**2<1 and abs(c.x)>7.5
    if -42<c.y<-22 and c.z>8 and not jewel:continue
    if c.y>18 and c.z<-4.8 and abs(c.x)>4:continue
    if c.y<-25 and c.z<-8.5:continue
    if abs(c.x)<8.5 and -18<c.y<-1 and c.z<-10:continue
    if abs(c.x)>4 and math.hypot(c.y-29.79,c.z)<10.7:continue
    kept.append(p)
mesh=make_mesh('SV3_Hull_Repaired', [v.co.copy() for v in old.vertices],[(tuple(p.vertices),p.material_index) for p in kept],list(old.materials))
for layer in ['SourceUV','MaterialUV']:
    for dst,src in zip(mesh.polygons,kept):
        for dl,sl in zip(dst.loop_indices,src.loop_indices):mesh.uv_layers[layer].data[dl].uv=old.uv_layers[layer].data[sl].uv
hull.data=mesh
stern=next(i for i,m in enumerate(mesh.materials) if m==M['SternWalnut'])
for p in mesh.polygons:
    if p.center.y<-24 and not any(k in mesh.materials[p.material_index].name for k in ['Glass','BrassTrim']):p.material_index=stern
if 'fold_morph' in hull:del hull['fold_morph']
hull['structural_repair']='removed fused torn sail/rigging remnants above 19m; retained crow nest, hull and galleries'
hull['repair_source_scene']=archive.name
v=[];f=[];u=[]
tube(v,f,(0,-10.5,5.4),(0,-10.5,47.5),1.35,0,16,u)
for z in [12,24,36,45]:tube(v,f,(0,-10.5,z-.32),(0,-10.5,z+.32),1.42,1,16,u)
for end in [(0,25.56,29.23),(-10,-40,43),(10,-40,43),(0,-39,14)]:tube(v,f,(0,-10.5,46.8),end,.16,0,8,u)
child('SV3_Repaired_MainMastAndStays',hull,v,f,[M['SparWood'],M['NavyIron']],uvs=u)
v=[];f=[];u=[]
for side in [-1,1]:
    tube(v,f,(side*4.3,29.79,0),(side*4.6,29.79,0),10.7,0,48,u)
    tube(v,f,(side*4.6,29.79,0),(side*9.68,29.79,0),1.3,1,16,u)
child('SV3_Repaired_WheelHullSockets',hull,v,f,[M['SternWalnut'],M['SparWood']],uvs=u)
# Close the damaged upper gallery at a real deck plane and give the fan roots a solid seat.
v=[(0,-55,15.25)]+[(12*math.cos(i*math.tau/48),-55+17*math.sin(i*math.tau/48),15.25) for i in range(48)]
f=[((0,i+1,(i+1)%48+1),0) for i in range(48)]
child('SV3_Repaired_SternRoofDeck',hull,v,f,[M['SternWalnut']])

# Cloth wheels have separate continuous wooden spokes, instead of per-triangle color slices.
for suffix in ['Port','Starboard']:
    obj=bpy.data.objects['SV3_Wheel_'+suffix];preserve(obj);v=[];f=[];uv=[];rv=[];rf=[];ru=[]
    for i in range(8):
        a=i*math.tau/8;b=(i+1)*math.tau/8;start=len(v)
        for row in range(8):
            t=row/7
            for column in range(7):
                s=column/6;angle=a+(b-a)*s;r=2.4+t*(6.8-2*math.sin(math.pi*s))
                v.append((.4*math.sin(math.pi*s)*math.sin(math.pi*t),r*math.cos(angle),r*math.sin(angle)));uv.append((r/.7,s*5))
        for row in range(7):
            for column in range(6):
                q=start+row*7+column;f.append(((q,q+1,q+8,q+7),0))
        tube(rv,rf,(0,2.1*math.cos(a),2.1*math.sin(a)),(0,9.3*math.cos(a),9.3*math.sin(a)),.28,0,10,ru)
    obj.data=make_mesh(obj.name+'_RepairedCloth',v,f,[M['SailLinen']],uv)
    obj['structural_repair']='eight cloth panels and independent wooden spokes';obj['repair_source_scene']=archive.name
    tube(rv,rf,(-.5,0,0),(.5,0,0),2.35,1,24,ru)
    tube(rv,rf,(-.62,0,0),(.62,0,0),1.95,2,24,ru)
    child(obj.name+'_TimberSpokesAndHub',obj,rv,rf,[M['SparWood'],M['BrassTrim'],M['NavyIron']],uvs=ru)

# Energy crystal and its wooden load-bearing cradle are now separate editable meshes.
crystal=bpy.data.objects['SV3_Crystal'];preserve(crystal);crystal.location=(0,-8.9,-23)
v=[(0,0,9),(0,0,-10)]+[(4.15*math.cos(i*math.tau/8),4.15*math.sin(i*math.tau/8),0) for i in range(8)]
f=[]
for i in range(8):j=(i+1)%8;f.extend([((0,i+2,j+2),0),((1,j+2,i+2),0)])
crystal.data=make_mesh('SV3_EnergyCrystal_Faceted',v,f,[M['AmberCrystal']])
for p in crystal.data.polygons:p.use_smooth=False
crystal['structural_repair']='separated faceted amber crystal; wood cradle is independent';crystal['repair_source_scene']=archive.name
v=[];f=[];u=[]
for x,y in [(-1,-1),(-1,1),(1,-1),(1,1)]:tube(v,f,(x*5.0,y*5.0,11.7),(x*3.8,y*3.8,.1),.40,0,10,u)
for z,radius in [(11.7,5.0),(.1,3.8)]:
    for a,b in [((-1,-1),(1,-1)),((1,-1),(1,1)),((1,1),(-1,1)),((-1,1),(-1,-1))]:
        tube(v,f,(a[0]*radius,a[1]*radius,z),(b[0]*radius,b[1]*radius,z),.48,0,12,u)
child('SV3_EnergyCradle_Timber',crystal,v,f,[M['SparWood']],uvs=u)
crystal['energy_crystal_separate']=True

# Uniform engine shell with real, continuous collar geometry; no jagged painted face bands.
for suffix in ['Port','Starboard']:
    obj=bpy.data.objects['SV3_Engine_'+suffix];preserve(obj)
    obj.data.materials.clear();obj.data.materials.append(M['HullIvory'])
    for p in obj.data.polygons:p.material_index=0
    obj['structural_repair']='engine shell kept; collar boundaries are geometry'
    v=[];f=[];u=[]
    side=-1 if suffix=='Port' else 1
    tube(v,f,(side*1.2,-18-obj.location.y-.55,-.7),(side*1.2,-18-obj.location.y+.55,-.7),5.8,0,32,u)
    child(obj.name+'_BrassCollars',obj,v,f,[M['BrassTrim']],uvs=u)
    nozzle=bpy.data.objects['SV3_Nozzle_'+suffix];preserve(nozzle)
    nozzle.data.materials.clear();nozzle.data.materials.append(M['NavyIron'])
    for p in nozzle.data.polygons:p.material_index=0

shader=next(n for n in M['AmberCrystal'].node_tree.nodes if n.type=='BSDF_PRINCIPLED')
shader.inputs['Base Color'].default_value=(.95,.20,.025,1)

# Current user correction: the hull, prow and all structural timber need visible wood grain.
# A 150m vessel cannot use the cabin's 3m tile: its planks collapsed into a flat ochre average.
planks=bpy.data.materials.get('SV3_HullPlanks') or M['SternWalnut'].copy();planks.name='SV3_HullPlanks'
grain=bpy.data.images.load(BASE+'textures/wood.png',check_existing=True)
for mat in [M['SparWood'],M['SternWalnut'],planks]:
    sh=next(n for n in mat.node_tree.nodes if n.type=='BSDF_PRINCIPLED')
    tex=next(n for n in mat.node_tree.nodes if n.type=='TEX_IMAGE' and n.image and n.image.name!='texture_pbr_20250901_normal.png')
    if mat==M['SparWood']:tex.image=grain
    uv=next((n for n in mat.node_tree.nodes if n.type=='UVMAP' and n.uv_map=='MaterialUV'),None) or mat.node_tree.nodes.new('ShaderNodeUVMap');uv.uv_map='MaterialUV'
    mat.node_tree.links.new(uv.outputs['UV'],tex.inputs['Vector'])
    tint=next((n for n in mat.node_tree.nodes if n.type=='MIX'),None) or mat.node_tree.nodes.new('ShaderNodeMix')
    tint.data_type='RGBA';tint.blend_type='MULTIPLY';tint.inputs[0].default_value=1;tint.inputs[7].default_value=(.64,.42,.31,1)
    mat.node_tree.links.new(tex.outputs['Color'],tint.inputs[6]);mat.node_tree.links.new(tint.outputs[2],sh.inputs['Base Color'])
    sh.inputs['Roughness'].default_value=.72;sh.inputs['Metallic'].default_value=0
    bump=next((n for n in mat.node_tree.nodes if n.type=='BUMP'),None) or mat.node_tree.nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value=.22;bump.inputs['Distance'].default_value=.05
    mat.node_tree.links.new(tex.outputs['Color'],bump.inputs['Height']);mat.node_tree.links.new(bump.outputs['Normal'],sh.inputs['Normal'])
    mat['wood_bump_from_basecolor']=.05
    mat['wood_grain_direction']='along timber length; hull planks 10-16m texture span'
slot=len(hull.data.materials);hull.data.materials.append(planks)
for p in hull.data.polygons:
    p.material_index=slot
    magnitudes=[abs(c) for c in p.normal];axis=magnitudes.index(max(magnitudes))
    pair=[(1,2),(0,2),(1,0)][axis];scales=(16,10) if axis<2 else (12,12)
    for loop in p.loop_indices:
        co=hull.data.vertices[hull.data.loops[loop].vertex_index].co
        hull.data.uv_layers['MaterialUV'].data[loop].uv=(co[pair[0]]/scales[0],co[pair[1]]/scales[1])
hull['material_region']='wood planking over hull and prow, independent brass settings and glass gems'

# The source's fused jewel rims had jagged material cuts. Seat complete cabochons over them.
for side in [-1,1]:
    for label,y,z,radius,glass in [('Jade',12,3.5,2.25,'JadeGlass'),('Sapphire',21.2,8.15,3.0,'SapphireGlass'),('Stern',-30,8,2.9,'SapphireGlass')]:
        v=[];f=[];segments=48
        rings=[(10.35,radius),(10.75,radius),(10.95,radius*.86),(11.10,radius*.82),(11.55,radius*.60),(11.78,radius*.24),(11.82,.001)]
        for x,r in rings:
            for i in range(segments):
                a=i*math.tau/segments;v.append((side*x,y+r*math.cos(a),z+r*math.sin(a)))
        for row in range(len(rings)-1):
            for i in range(segments):
                q=row*segments+i;j=row*segments+(i+1)%segments
                face=(q,j,j+segments,q+segments)
                f.append((face if side==1 else tuple(reversed(face)),0 if row<2 else 1))
        f.append((tuple(range(segments-1,-1,-1)),0))
        child('SV3_Repaired_'+label+'Setting_'+str(side),hull,v,f,[M['BrassTrim'],bpy.data.materials['SV3_Prototype_'+glass]])

parts=[o for o in scene.objects if o.get('source_triangles')]
assert len(parts)==18
assert all(not c.data.shape_keys or not c.data.shape_keys.key_blocks.get('WindPressure') for o in parts for c in o.children if c.type=='MESH' and c.get('rigid_wind_pins'))
scene['structural_repair_revision']='2026-10-02: semantic cloth/wood/crystal separation; original meshes and morphs retained'
scene['structural_repair_archive']=archive.name
bpy.data.objects['SV3_Exterior']['geometry_source']='user hull and rig; repaired fused sails, timber structure and crystal, source retained'
for o in scene.objects:o.hide_set(False)
scene.frame_set(1)
bpy.ops.export_scene.gltf(filepath=BASE+'models/sky-voyage.glb',export_format='GLB',use_active_scene=True,export_yup=True,export_extras=True,export_apply=False,export_animations=True)
bpy.ops.file.pack_all();bpy.ops.wm.save_as_mainfile(filepath=BASE+'models/sky-voyage.blend',compress=True)
print('STRUCTURE_REPAIR_OK',len(parts),'original rig nodes retained;',len(archive.objects),'source objects archived')
