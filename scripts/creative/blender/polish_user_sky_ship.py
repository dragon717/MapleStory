# Execute through live Blender MCP. Keep the source rig and every animation vertex.
import bpy
import math
from collections import defaultdict
from mathutils import Vector

OUT='/Users/muniao/Code/MapleStory/resources/scenes/sky-voyage-v3/models'
scene=bpy.data.scenes['SV3_ProductionRig']
bpy.context.window.scene=scene
scene.frame_set(1)
parts=[o for o in scene.objects if o.type=='MESH' and o.get('source_triangles')]
assert sum(len(o.data.polygons) for o in parts)==285840

# Remove small colour islands caused by baked atlas lighting, preserving broad trim/gems.
for obj in parts:
    mesh=obj.data
    if not obj.get('finish_revision'):
        neighbours=defaultdict(list)
        for p in mesh.polygons:
            for v in p.vertices: neighbours[v].append(p.index)
        visited=set()
        changes={}
        for p in mesh.polygons:
            if p.index in visited: continue
            group=[]; queue=[p.index]; visited.add(p.index); border=defaultdict(float)
            while queue:
                i=queue.pop(); face=mesh.polygons[i]; group.append(i)
                for v in face.vertices:
                    for j in neighbours[v]:
                        other=mesh.polygons[j]
                        if other.material_index==p.material_index:
                            if j not in visited: visited.add(j); queue.append(j)
                        else: border[other.material_index]+=other.area
            name=mesh.materials[p.material_index].name
            threshold=8 if name.endswith(('Navy','Jade','Sapphire')) else .8
            if border and sum(mesh.polygons[i].area for i in group)<threshold:
                replacement=max(border,key=border.get)
                for i in group: changes[i]=replacement
        for i,material in changes.items(): mesh.polygons[i].material_index=material
        obj['finish_revision']=1
    # The original RGB classifier mistook baked shadows/reflections for blue/green paint.
    # Preserve that classification as evidence, then constrain it by the actual rig component.
    source=mesh.attributes.get('SV3_SourceMaterial')
    if source is None:
        source=mesh.attributes.new('SV3_SourceMaterial','INT','FACE')
        for p in mesh.polygons: source.data[p.index].value=p.material_index
    slots={m.name.removeprefix('SV3_M_'):i for i,m in enumerate(mesh.materials)}
    for p in mesh.polygons:
        old=mesh.materials[source.data[p.index].value].name.removeprefix('SV3_M_')
        co=p.center+obj.location
        chosen=old
        if 'Fan_' in obj.name or 'Vane_' in obj.name:
            chosen='Brass' if old=='Brass' else 'Linen'
        elif 'Wheel_' in obj.name or 'Engine_' in obj.name:
            chosen='Brass' if old=='Brass' else 'Enamel'
        elif 'Nozzle_' in obj.name:
            chosen='Sapphire' if old=='Sapphire' else 'Brass' if old=='Brass' else 'Navy'
        elif obj.name=='SV3_Hull':
            timber=(-4<co.z<9 and abs(co.y)<66) or (abs(co.x)<1.6 and abs(co.y+10.5)<3 and co.z>8)
            if old in {'Navy','Sapphire','Jade','Linen','Amber'}:
                chosen='Wood' if timber else 'Enamel'
            if co.z<-10:chosen='Navy' if co.z<-14 else 'Enamel'
        if chosen not in slots:
            mesh.materials.append(bpy.data.materials['SV3_M_'+chosen]);slots[chosen]=len(mesh.materials)-1
        p.material_index=slots[chosen]
    # Smooth isolated labels by shared edges (not vertices); keep large structural borders.
    edge_faces=defaultdict(list)
    for p in mesh.polygons:
        for edge in p.edge_keys:edge_faces[edge].append(p.index)
    adjacent=defaultdict(set)
    for group in edge_faces.values():
        for i in group:adjacent[i].update(j for j in group if j!=i)
    visited=set();changes={}
    for p in mesh.polygons:
        if p.index in visited:continue
        region=[];queue=[p.index];visited.add(p.index);border=defaultdict(float)
        while queue:
            i=queue.pop();face=mesh.polygons[i];region.append(i)
            for j in adjacent[i]:
                other=mesh.polygons[j]
                if other.material_index==p.material_index:
                    if j not in visited:visited.add(j);queue.append(j)
                else:border[other.material_index]+=other.area
        if border and sum(mesh.polygons[i].area for i in region)<24:
            replacement=max(border,key=border.get)
            for i in region:changes[i]=replacement
    for i,index in changes.items():mesh.polygons[i].material_index=index
    obj['material_revision']='structure-v2; source RGB labels retained in SV3_SourceMaterial'
    uv=mesh.uv_layers['MaterialUV']
    for p in mesh.polygons:
        name=mesh.materials[p.material_index].name
        # All three dominant axes must have two independent UV coordinates.
        magnitudes=[abs(v) for v in p.normal]
        axis=magnitudes.index(max(magnitudes))
        pair=[(1,2),(0,2),(1,0)][axis]
        # The outer hull is a long continuous surface.  A 3 m projection made
        # the same knot repeat as obvious vertical blocks on the curved side;
        # keep the deck plank scale separate and give structural wood a longer
        # 7 m grain span while retaining the source face-direction mapping.
        scale=.7 if name.endswith('Linen') else 7 if name.endswith('Wood') else 2
        for i in p.loop_indices:
            co=mesh.vertices[mesh.loops[i].vertex_index].co+obj.location
            uv.data[i].uv=(co[pair[0]]/scale,co[pair[1]]/scale)
    mesh.uv_layers.active=uv; uv.active_render=True

mat=bpy.data.materials['SV3_M_Wood']
for node in mat.node_tree.nodes:
    if node.type=='TEX_IMAGE' and node.image and node.image.name=='wood.png':
        node.image=bpy.data.images.load('/Users/muniao/Code/MapleStory/resources/scenes/sky-voyage-v3/textures/deck-planks.png',check_existing=True)

for name,rough,metal in [('Enamel',.62,.04),('Brass',.48,.7),('Wood',.76,0),('Linen',.98,0),('Navy',.55,.35)]:
    mat=bpy.data.materials['SV3_M_'+name]
    shader=next(n for n in mat.node_tree.nodes if n.type=='BSDF_PRINCIPLED')
    shader.inputs['Roughness'].default_value=rough
    shader.inputs['Metallic'].default_value=metal
    for node in mat.node_tree.nodes:
        if node.type=='NORMAL_MAP': node.inputs['Strength'].default_value=.09
    if name=='Enamel':
        for link in list(shader.inputs['Base Color'].links): mat.node_tree.links.remove(link)
        shader.inputs['Base Color'].default_value=(.72,.69,.58,1)

# Ship-local cabin-side board. Blender Y forward; rotate the front toward starboard +X.
ship=bpy.data.objects['SV2_Ship']
old=bpy.data.objects.get('SV2_LoginSign')
if old:
    for o in list(old.children_recursive): bpy.data.objects.remove(o,do_unlink=True)
    bpy.data.objects.remove(old,do_unlink=True)
board=bpy.data.objects.new('SV2_LoginSign',None);scene.collection.objects.link(board)
board.parent=ship;board.location=(10.3,0,5.4);board.rotation_euler.z=math.pi/2
board['role']='starboard cabin-wall noticeboard; native form stays on the board from the first frame'

def material(name,color,rough=.75,metal=0):
    m=bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes=True
    sh=next(n for n in m.node_tree.nodes if n.type=='BSDF_PRINCIPLED')
    sh.inputs['Base Color'].default_value=(*color,1)
    sh.inputs['Roughness'].default_value=rough;sh.inputs['Metallic'].default_value=metal
    return m
wood=material('SV3_Board_Walnut',(.16,.087,.042),.66)
brass=material('SV3_Board_Brass',(.45,.27,.085),.45,.65)
paper=material('SV3_Board_Paper',(.82,.76,.59))
teal=material('SV3_Board_Teal',(.035,.12,.14),.55,.15)

def box(name,location,size,mat,bevel=.04):
    bpy.ops.mesh.primitive_cube_add(size=1)
    o=bpy.context.object;o.name='SV3_Board_'+name
    o.parent=board;o.location=location;o.scale=size
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    o.data.materials.append(mat)
    if bevel:
        mod=o.modifiers.new('soft crafted edge','BEVEL');mod.width=bevel;mod.segments=3
        bpy.context.view_layer.objects.active=o;bpy.ops.object.modifier_apply(modifier=mod.name)
    return o
# Surface at cabin-wall height, tied into the measured side geometry by mounting cleats.
box('Back',(0,0,4.2),(7.4,.30,6.2),wood,.09)
box('Paper',(0,-.18,4.2),(6.84,.055,5.66),paper,.025)
for x in [-3.55,3.55]:box('Stile',(x,-.23,4.2),(.28,.22,6.3),wood)
for z in [1.15,7.25]:box('Rail',(0,-.23,z),(7.5,.25,.26),wood)
for x in [-3.56,3.56]:
    for z in [1.17,7.23]:box('Corner',(x,-.37,z),(.4,.045,.35),brass,.015)
for x in [-2.65,2.65]:
    box('WallCleat',(x,.45,4.2),(.38,.65,6.5),wood)
    for z in [2,6.3]:box('WallBracket',(x,1.1,z),(.5,1.2,.3),brass)
    box('PaperClip',(x,-.25,6.88),(.44,.13,.42),brass,.025)
box('CrestPlate',(0,-.25,7.47),(2.4,.19,.56),teal,.06)
# Brass compass inset, readable without a text or icon texture.
for angle in [0,math.pi/2,math.pi/4,-math.pi/4]:
    needle=box('Compass',(0,-.365,7.48),(.055,.035,.39 if abs(angle)>1 else .43),brass,.008)
    needle.rotation_euler.y=angle
anchor=bpy.data.objects.new('SV3_LoginSurface',None);scene.collection.objects.link(anchor)
anchor.parent=board;anchor.location=(0,-.218,4.2);anchor.rotation_euler.x=0
anchor['width']=6.65;anchor['height']=5.42
assert len([o for o in board.children if o.name.startswith('SV3_Board_')])>=20
assert sum(len(o.data.polygons) for o in parts)==285840
# Export the production scene only; preserve all other city/source scenes in the live file.
bpy.ops.export_scene.gltf(filepath=OUT+'/sky-voyage.glb',export_format='GLB',use_active_scene=True,export_yup=True,export_extras=True,export_apply=False,export_animations=True)
bpy.ops.file.pack_all()
bpy.ops.wm.save_as_mainfile(filepath=OUT+'/sky-voyage-polished.blend',compress=True)
bpy.ops.wm.save_as_mainfile(filepath=OUT+'/sky-voyage.blend',compress=True)
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type=='VIEW_3D':
            space=area.spaces.active;space.region_3d.view_location=Vector((10.3,0,9.6));space.region_3d.view_distance=30
            space.region_3d.view_rotation=(Vector((10.3,0,9.6))-Vector((25,-11,14))).to_track_quat('-Z','Y')
            space.region_3d.view_perspective='PERSP';space.shading.type='MATERIAL';space.overlay.show_overlays=False
print('SV3_FINISH_OK',len(parts),'parts; board',len(board.children),'objects; triangles',sum(len(o.data.polygons) for o in parts))
