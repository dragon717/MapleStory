# Apply through live Blender MCP after polish_user_sky_ship.py.
# Colour authority: sky-voyage-v2/design/ship-orthographic-v2.png (reviewed P concept).
# Regions are explicit ship-space geometry masks. Source atlas RGB never decides a material.
import bpy, math, json
from collections import defaultdict
from mathutils import Vector

BASE='/Users/muniao/Code/MapleStory/resources/scenes/sky-voyage-v3/'
scene=bpy.data.scenes['SV3_ProductionRig'];bpy.context.window.scene=scene;scene.frame_set(1)
REFERENCE='resources/scenes/sky-voyage-v2/design/ship-orthographic-v2.png'
specs={
    'HullIvory':('Enamel',(.79,.77,.69),.6,.12,'upper/lower painted shell; cream ivory in SIDE/FRONT'),
    'DeckTeak':('Wood',None,.82,0,'exposed deck and central timber coaming; warm brown in TOP'),
    'SailLinen':('Linen',None,.97,0,'continuous ivory cloth between the spars in SIDE/FRONT'),
    'SparWood':('Wood',None,.72,0,'wood mast, complete radial spars, rails and energy cradle; user red-box correction'),
    'SternWalnut':('Wood',None,.65,0,'wood stern gallery walls, posts and curved railings; user red-box correction'),
    'BrassTrim':('Brass',(.66,.40,.12),.38,.7,'narrow gold rims, ferrules, engine hoops; SIDE/FRONT'),
    'NavyIron':('Navy',(.018,.042,.078),.55,.45,'dark blue hub, mast fasteners and nozzle end caps'),
    'TealRibbon':('Jade',(.015,.22,.18),.44,.18,'continuous teal stern-gallery inlay in SIDE/TOP'),
    'JadeGlass':('Jade',(.012,.42,.22),.21,.25,'small green jewel at the shoulder; SIDE/FRONT'),
    'SapphireGlass':('Sapphire',(.012,.17,.48),.2,.25,'small blue jewels at the bow and shoulder; SIDE/FRONT'),
    'AmberCrystal':('Amber',(.95,.44,.07),.075,0,'transmitting amber crystal inside the wooden energy cradle; SIDE/FRONT'),
}
materials={}
for key,(source,color,rough,metal,note) in specs.items():
    name='SV3_Prototype_'+key
    old=bpy.data.materials.get(name)
    if old:old.name=name+'_superseded'
    mat=bpy.data.materials['SV3_M_'+source].copy();mat.name=name
    shader=next(n for n in mat.node_tree.nodes if n.type=='BSDF_PRINCIPLED')
    shader.inputs['Roughness'].default_value=rough;shader.inputs['Metallic'].default_value=metal
    if color:
        for link in list(shader.inputs['Base Color'].links):mat.node_tree.links.remove(link)
        shader.inputs['Base Color'].default_value=(*color,1)
    # The input reconstruction normal atlas contains baked wrinkles crossing material boundaries.
    for link in list(shader.inputs['Normal'].links):mat.node_tree.links.remove(link)
    if key.endswith('Glass') or key=='AmberCrystal':
        shader.inputs['Transmission Weight'].default_value=.94
        shader.inputs['IOR'].default_value=1.46
        shader.inputs['Coat Weight'].default_value=.5
        shader.inputs['Coat Roughness'].default_value=.045
        shader.inputs['Emission Strength'].default_value=0
    mat['prototype_reference']=REFERENCE;mat['prototype_region']=note
    materials[key]=mat

def distance_to_ray(y,z,angle):
    a=math.radians(angle)
    return abs(y*math.sin(a)-z*math.cos(a)) if y*math.cos(a)+z*math.sin(a)>0 else math.hypot(y,z)

# Traced from the actual rest-pose ribs, in ship Y/Z metres. The original reconstruction
# contains curved/misaligned rods, so ideal radial angles cut through the cloth.
SPARS={
    'MainFan':[
        [(25.4,29.1),(13.1,30.6),(-.1,33.6),(-15.6,37.1),(-25.1,39.4),(-39.6,43.0)],
        [(25.4,29.1),(12.5,27.8),(-11.2,28.1),(-25.5,28.2),(-36.5,28.5)],
        [(25.4,29.1),(12.6,25.7),(-2,20.3),(-24.8,18.1),(-35.5,15.3)],
        [(25.4,29.1),(9.3,21.0),(-1.2,18.4),(-12.4,14),(-25.1,8.2)],
        [(-39.6,35.5),(-39.3,27.7),(-39.0,19.3),(-40.6,9.0)],
    ],
    'AftFan':[
        [(-38.5,13.6),(-45.4,22),(-50.0,29.1),(-53.6,36.2)],
        [(-47.5,14.2),(-56.6,21.8),(-63.1,33.5)],
        [(-50.5,13.6),(-63.9,21.9),(-73.0,29.0)],
        [(-49.0,14.0),(-65,16),(-74,17.2)],
        [(-38.5,13.6),(-39.0,25.0),(-39.3,36.3)],
    ],
    'BowVane':[
        [(55,-5.8),(49,-18.5),(44.8,-27.9)],
        [(55,-5.8),(42.2,-16.9),(35.9,-24.5)],
        [(55,-5.8),(36.9,-13.4),(27.4,-20)],
        [(55,-5.8),(32.1,-9.5),(20.2,-14)],
        [(49,-18.5),(42.2,-16.9),(36.9,-13.4),(32.1,-9.5)],
    ],
    'AftVane':[
        [(-32.7,-8.5),(-34.5,-20),(-36.6,-27.4)],
        [(-32.7,-8.5),(-42,-19.5),(-49.1,-25.1)],
        [(-32.7,-8.5),(-47,-12),(-58,-15)],
        [(-37,-8.5),(-47,-9),(-64,-8.5)],
    ],
}

def spar_distance(y,z,paths):
    best=1e6
    for path in paths:
        for (ay,az),(by,bz) in zip(path,path[1:]):
            dy,dz=by-ay,bz-az
            t=max(0,min(1,((y-ay)*dy+(z-az)*dz)/(dy*dy+dz*dz)))
            best=min(best,math.hypot(y-ay-t*dy,z-az-t*dz))
    return best

def sail_region(y,z,kind):
    d=spar_distance(y,z,SPARS[kind])
    if kind=='MainFan':
        # All rigging above the upper spar is wood; there is no cloth above this edge.
        if z>29.1+(25.4-y)*.214-.65:return 'SparWood'
    return 'SparWood' if d<.83 else 'SailLinen'

def hull_region(p):
    x,y,z=p;ax=abs(x)
    # Main mast and its four authored clamp levels.
    if ax<2.0 and abs(y+10.5)<2.5 and z>8:
        if min(abs(z-k) for k in [11.5,20,32,44])<.48:return 'NavyIron'
        return 'SparWood'
    if z>17:
        if y<-36:return sail_region(y,z,'AftFan')
        if z<44 and y<27:return sail_region(y,z,'MainFan')
        return 'SparWood'
    # Localised jewel domes, with a narrow gold setting around each.
    for cy,cz,ry,rz,kind in [(-30,8,2.4,2.3,'SapphireGlass'),(21,8,2.8,2.6,'SapphireGlass'),(12,3.5,2.1,2.0,'JadeGlass')]:
        radius=((y-cy)/ry)**2+((z-cz)/rz)**2
        if ax>7.8 and radius<1.26:return kind if radius<.82 else 'BrassTrim'
    # User explicitly requested the curved stern structure in wood. Keep the original
    # carved geometry; do not stripe through its curved fascias with horizontal masks.
    if y<-39:return 'SternWalnut'
    # Exposed deck / central wooden coaming, bounded in height, not the entire hull.
    if -38<y<33 and .4<z<7.8:return 'DeckTeak'
    # The long bow walkway and its rail stay brown; its shell remains ivory.
    if y>43 and z>-3.5:return 'SparWood'
    if y>19 and z<-4.5 and spar_distance(y,z,SPARS['BowVane'])<.95:return 'SparWood'
    if y<-29 and z<-7 and spar_distance(y,z,SPARS['AftVane'])<.95:return 'SparWood'
    return 'HullIvory'

parts=[o for o in scene.objects if o.type=='MESH' and o.get('source_triangles')]
for obj in parts:
    mesh=obj.data;slots={m.name:i for i,m in enumerate(mesh.materials)}
    for key,mat in materials.items():
        if mat.name not in slots:mesh.materials.append(mat);slots[mat.name]=len(mesh.materials)-1
    attribute=mesh.attributes.get('PrototypeMaterialRegion') or mesh.attributes.new('PrototypeMaterialRegion','INT','FACE')
    totals=defaultdict(float)
    for face in mesh.polygons:
        local=face.center;co=local+obj.location;name=obj.name
        if 'MainFan_' in name:region=sail_region(co.y,co.z,'MainFan')
        elif 'AftFan_' in name:region=sail_region(co.y,co.z,'AftFan')
        elif 'AftVane_' in name:region=sail_region(co.y,co.z,'AftVane')
        elif 'BowVane_' in name:region=sail_region(co.y,co.z,'BowVane')
        elif 'Wheel_' in name:
            r=math.hypot(local.y,local.z);beam=min(distance_to_ray(local.y,local.z,a) for a in range(0,360,45))
            region='NavyIron' if r<2.1 else 'BrassTrim' if r<2.7 else 'SparWood' if beam<.66 else 'SailLinen'
        elif 'Engine_' in name:
            region='NavyIron' if co.y<-31 else 'BrassTrim' if -19<co.y<-16 or -4<co.y<-2.4 else 'HullIvory'
        elif 'Nozzle_' in name:region='BrassTrim' if -1.8<co.y<-.6 or 4.9<co.y<5.5 else 'NavyIron'
        elif name=='SV3_Crystal':
            radius=math.hypot(co.x,co.y+8.5)
            crystal=co.z<-25.2 or (-22.3<co.z<-14 and radius<max(.2,(-co.z-13.5)*.48))
            region='AmberCrystal' if crystal else 'SparWood'
        else:region=hull_region(co)
        face.material_index=slots[materials[region].name];attribute.data[face.index].value=list(specs).index(region)
        totals[region]+=face.area
    obj['prototype_reference']=REFERENCE
    obj['material_revision']='prototype-regions-v3; explicit geometry masks, no atlas RGB classification'
    obj['prototype_material_regions']=json.dumps(dict(totals))
    # Wind pressure is continuous across neighboring cloth vertices. Pins follow the
    # real spars, not old atlas colors, so a wooden spar can no longer buckle in steps.
    kind=next((k for k in SPARS if k in obj.name),None)
    if kind and mesh.shape_keys and mesh.shape_keys.key_blocks.get('WindPressure'):
        pressure=mesh.shape_keys.key_blocks['WindPressure'];basis=mesh.shape_keys.key_blocks['Basis']
        pins=obj.vertex_groups.get('FramePins') or obj.vertex_groups.new(name='FramePins')
        pins.remove(list(range(len(mesh.vertices))))
        for i,v in enumerate(basis.data):
            co=v.co+obj.location;d=spar_distance(co.y,co.z,SPARS[kind])
            t=max(0,min(1,(d-1.0)/3));weight=t*t*(3-2*t)
            if sail_region(co.y,co.z,kind)=='SparWood':weight=0
            pressure.data[i].co=v.co+Vector(((-1 if co.x<0 else 1)*weight*.75,0,0))
            if weight==0:pins.add([i],1,'REPLACE')
        obj['wind_pin_source']='authored spar polylines; continuous 3m cloth falloff'
    uv=mesh.uv_layers['MaterialUV']
    for p in mesh.polygons:
        magnitudes=[abs(v) for v in p.normal];axis=magnitudes.index(max(magnitudes));pair=[(1,2),(0,2),(1,0)][axis]
        key=mesh.materials[p.material_index].name
        scale=.7 if key.endswith('SailLinen') else 3 if key.endswith('DeckTeak') else 2
        for i in p.loop_indices:
            co=mesh.vertices[mesh.loops[i].vertex_index].co+obj.location;uv.data[i].uv=(co[pair[0]]/scale,co[pair[1]]/scale)
    mesh.uv_layers.active=uv;uv.active_render=True

assert sum(len(o.data.polygons) for o in parts)==285840
scene['ship_material_reference']=REFERENCE
scene['ship_material_region_names']=json.dumps(list(specs))
bpy.ops.export_scene.gltf(filepath=BASE+'models/sky-voyage.glb',export_format='GLB',use_active_scene=True,export_yup=True,export_extras=True,export_apply=False,export_animations=True)
bpy.ops.file.pack_all();bpy.ops.wm.save_as_mainfile(filepath=BASE+'models/sky-voyage.blend',compress=True)
print('PROTOTYPE_MATERIALS_OK',len(parts),'parts, ten named structural material regions, 285840 original triangles')
