# Live Blender MCP. Downloaded CC0 antique bed, adapted by dimensions; source scene stays intact.
import bpy, math, bmesh
from mathutils import Vector

BASE='/Users/muniao/Code/MapleStory/resources/scenes/sky-voyage-v3/'
scene=bpy.data.scenes['SV3_ProductionRig']
bpy.context.window.scene=scene
cabin=bpy.data.objects['SV3_CabinInterior']
if not cabin.get('single_berth_revision'):
    for o in cabin.children:
        if o.name.startswith('SV2_Cabin'):
            o.location.x*=1.5;o.scale.x*=1.5
cabin['single_berth_revision']=1
cabin['layout']='12 single berths, three lateral groups of four; four real window openings; P interior set'
for o in list(scene.objects):
    if o.name.startswith(('SV2_Bed','SV3_Berth','SV3_CabinLamp')):bpy.data.objects.remove(o,do_unlink=True)

def empty(name,parent,location):
    o=bpy.data.objects.new(name,None);scene.collection.objects.link(o);o.parent=parent;o.location=location
    return o

def bed_material(label):
    mat=bpy.data.materials.get('SV3_AntiqueBed_'+label) or bpy.data.materials.new('SV3_AntiqueBed_'+label)
    mat.use_nodes=True;nodes=mat.node_tree.nodes;nodes.clear()
    shader=nodes.new('ShaderNodeBsdfPrincipled');shader.inputs['Roughness'].default_value=.78
    output=nodes.new('ShaderNodeOutputMaterial');mat.node_tree.links.new(shader.outputs['BSDF'],output.inputs['Surface'])
    for suffix,target in [('D','Base Color'),('N','Normal')]:
        filename=label+'_'+(suffix if label=='Bed' else suffix.lower())+'.tga'
        image=bpy.data.images.load(BASE+'vendor/bed/opengameart-victorian-bed/original/Bed/'+filename,check_existing=True)
        if suffix=='N':image.colorspace_settings.name='Non-Color'
        node=nodes.new('ShaderNodeTexImage');node.image=image
        if suffix=='N':
            normal=nodes.new('ShaderNodeNormalMap');normal.inputs['Strength'].default_value=.35
            mat.node_tree.links.new(node.outputs['Color'],normal.inputs['Color']);mat.node_tree.links.new(normal.outputs['Normal'],shader.inputs['Normal'])
        else:mat.node_tree.links.new(node.outputs['Color'],shader.inputs[target])
    return mat

meshes={}
for label in ['Bed','Frame']:
    source=bpy.data.objects['SV3_Downloaded_'+label]
    mesh=source.data.copy();mesh.name='SV3_SingleAntique_'+label
    for v in mesh.vertices:
        x=v.co.y
        # Preserve the turned posts at full thickness; shorten only the inner span.
        width=x*.52 if abs(x)<.84 else math.copysign(.4368+abs(x)-.84,x)
        v.co=(width,-v.co.x,v.co.z+.006)
    mesh.materials.clear();mesh.materials.append(bed_material(label))
    for p in mesh.polygons:p.material_index=0
    meshes[label]=mesh
# Reuse the downloaded quilt surface as a real lower-body cover, preserving its UV and folds.
quilt=meshes['Bed'].copy();quilt.name='SV3_SingleAntique_Quilt'
bm=bmesh.new();bm.from_mesh(quilt)
remove=[f for f in bm.faces if f.calc_center_median().y>.23 or f.calc_center_median().z<.5]
bmesh.ops.delete(bm,geom=remove,context='FACES')
for v in bm.verts:v.co.z+=.105
bm.to_mesh(quilt);bm.free();meshes['Quilt']=quilt
for index in range(12):
    page=index//4;local=index%4;x=(page-1)*8.1+(local-1.5)*1.8
    bed=empty('SV2_Bed_'+str(index),cabin,(x,-43,0))
    bed['source']='Bed by Colorado Stark, OpenGameArt, CC0; Victorian/antique source, adapted classic single berth'
    bed['single_bed_width_m']=1.26;bed['group']=page
    for label,mesh in meshes.items():
        o=bpy.data.objects.new('SV3_Berth_'+str(index)+'_'+label,mesh);scene.collection.objects.link(o);o.parent=bed
    empty('SV2_Bed_'+str(index)+'_SleepAnchor',bed,(0,0,.635))
    empty('SV2_Bed_'+str(index)+'_FootAnchor',bed,(0,-1.6,0))

# Floor and wall texture follows timber grain rather than the old untextured room blocks.
floor=bpy.data.objects['SV2_CabinFloor'];floor.data.materials.clear();floor.data.materials.append(bpy.data.materials['SV3_M_Wood'])
uv=floor.data.uv_layers.get('MaterialUV') or floor.data.uv_layers.new(name='MaterialUV')
for poly in floor.data.polygons:
    for loop in poly.loop_indices:
        co=floor.data.vertices[floor.data.loops[loop].vertex_index].co
        uv.data[loop].uv=(co.x/3,co.y/3)
wall=bpy.data.materials.get('SV3_CabinWalnut') or bpy.data.materials.new('SV3_CabinWalnut')
wall.diffuse_color=(.12,.074,.043,1);wall.use_nodes=True
sh=next(n for n in wall.node_tree.nodes if n.type=='BSDF_PRINCIPLED');sh.inputs['Base Color'].default_value=(.12,.074,.043,1);sh.inputs['Roughness'].default_value=.8
for o in cabin.children:
    if o.type=='MESH' and ('Wall' in o.name):o.data.materials.clear();o.data.materials.append(wall)

# Visible lamp bodies match the warm runtime point lights.
glass=bpy.data.materials.get('SV3_CabinLampGlass') or bpy.data.materials.new('SV3_CabinLampGlass')
glass.use_nodes=True;sh=next(n for n in glass.node_tree.nodes if n.type=='BSDF_PRINCIPLED')
sh.inputs['Base Color'].default_value=(1,.61,.22,1);sh.inputs['Emission Color'].default_value=(1,.34,.055,1);sh.inputs['Emission Strength'].default_value=1.5
for index,x in enumerate([-11.7,-3.6,4.5,11.7]):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=12,ring_count=8,radius=.17)
    lamp=bpy.context.object;lamp.name='SV3_CabinLamp_'+str(index);lamp.parent=cabin;lamp.location=(x,-42.6,2.2);lamp.scale=(1,1,1.4);lamp.data.materials.append(glass)
    bpy.ops.mesh.primitive_cylinder_add(vertices=12,radius=.20,depth=.07)
    cap=bpy.context.object;cap.name='SV3_CabinLamp_Cap_'+str(index);cap.parent=cabin;cap.location=(x,-42.6,2.48);cap.data.materials.append(bpy.data.materials['SV3_Board_Brass'])

assert len([o for o in scene.objects if o.name.startswith('SV2_Bed_') and o.name.endswith('SleepAnchor')])==12
assert len([o for o in scene.objects if o.name.startswith('SV2_CabinFrontWindow_')])==4
bpy.ops.export_scene.gltf(filepath=BASE+'models/sky-voyage.glb',export_format='GLB',use_active_scene=True,export_yup=True,export_extras=True,export_apply=False,export_animations=True)
bpy.ops.file.pack_all();bpy.ops.wm.save_as_mainfile(filepath=BASE+'models/sky-voyage.blend',compress=True)
print('CABIN_READY: 12 downloaded/adapted single berths, 4 windows, original source scene retained')
