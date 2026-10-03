"""Replace only the login plaque, using the approved v4 close reference.
Run against the current sky-voyage.blend. Keep hull, routes and cloth intact.
Blender coordinates: X lateral, -Y depth, Z up; board front is local -Y.
"""
import bpy, math, json, importlib.util, os
from pathlib import Path
from mathutils import Vector
ROOT = Path(__file__).resolve().parents[3]
DEST = ROOT / 'resources/scenes/sky-voyage-v3/models'
scene = bpy.data.scenes['SV3_ProductionRig']
bpy.context.window.scene = scene
scene.frame_set(1)
bpy.context.preferences.filepaths.save_version = 0
ship = bpy.data.objects['SV2_Ship']
sign = bpy.data.objects['SV2_LoginSign']
restore_recipe=Path(__file__).with_name('restore_voyage_retained_structure.py')
spec=importlib.util.spec_from_file_location('retained_structure',restore_recipe);restore=importlib.util.module_from_spec(spec);spec.loader.exec_module(restore)
restore.restore_retained_structure(scene)
geometry_recipe=Path(__file__).with_name('separate_voyage_original_parts.py')
spec=importlib.util.spec_from_file_location('original_parts',geometry_recipe);geometry=importlib.util.module_from_spec(spec);spec.loader.exec_module(geometry)
geometry.apply_original_parts(scene)
crest_recipe=Path(__file__).with_name('place_single_voyage_crest.py')
spec=importlib.util.spec_from_file_location('single_crest',crest_recipe);crest=importlib.util.module_from_spec(spec);spec.loader.exec_module(crest)
crest.place_single_crest(scene)
wheel_recipe=Path(__file__).with_name('refine_voyage_wheel_contour.py')
spec=importlib.util.spec_from_file_location('wheel_contour',wheel_recipe);wheel=importlib.util.module_from_spec(spec);spec.loader.exec_module(wheel)
wheel.refine_wheel_contour(scene)
unrelated = {o.name: (len(o.data.vertices), len(o.data.polygons), tuple(tuple(v.co) for v in o.data.vertices)) for o in scene.objects if o.type == 'MESH' and not o.name.startswith('SV3_Board_') and o not in sign.children_recursive}
for obj in list(sign.children_recursive): bpy.data.objects.remove(obj, do_unlink=True)
sign['reference'] = 'resources/login-prototypes/2026-10-01/v4/close.png'
sign['role'] = 'joined timber plaques; brass corner straps; maple crest; hanging lantern'
sign.location = (10.3,0,5.4); sign.rotation_euler = (0,0,math.pi/2); sign.scale = (1,1,1)

def material(name, color, rough=.75, metal=0, texture=None):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    sh = next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    for link in list(sh.inputs['Base Color'].links): mat.node_tree.links.remove(link)
    sh.inputs['Base Color'].default_value = (*color,1)
    sh.inputs['Roughness'].default_value = rough; sh.inputs['Metallic'].default_value = metal
    if texture:
        node = mat.node_tree.nodes.new('ShaderNodeTexImage'); node.image = bpy.data.images.load(str(texture),check_existing=True)
        mat.node_tree.links.new(node.outputs['Color'],sh.inputs['Base Color'])
    return mat
tex = ROOT / 'resources/scenes/sky-voyage-v3/textures'
wood = material('SV3_LoginTimber',(.55,.32,.14),texture=tex/'deck-planks.png')
dark = material('SV3_LoginWalnut',(.12,.065,.028),texture=tex/'wood.png')
brass = bpy.data.materials['SV3_Prototype_BrassTrim']
iron = bpy.data.materials['SV3_Prototype_NavyIron']
glow = material('SV3_LoginLanternGlass',(1,.62,.16),.18)
sh = next(n for n in glow.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
sh.inputs['Emission Color'].default_value = (1,.40,.055,1); sh.inputs['Emission Strength'].default_value = 2

def mesh(name, verts, faces, mat, bevel=0):
    data = bpy.data.meshes.new(name+'_Mesh'); data.from_pydata(verts,[],faces); data.update(); data.materials.append(mat)
    uv=data.uv_layers.new(name='MaterialUV')
    for face in data.polygons:
        axis=max(range(3),key=lambda i:abs(face.normal[i])); a,b=[(1,2),(0,2),(0,1)][axis]
        for i in face.loop_indices:
            p=data.vertices[data.loops[i].vertex_index].co;uv.data[i].uv=(p[a]/2.8,p[b]/2.8)
    obj=bpy.data.objects.new(name,data);scene.collection.objects.link(obj);obj.parent=sign
    if bevel:
        bpy.context.view_layer.objects.active=obj
        mod=obj.modifiers.new('Crafted timber edges','BEVEL');mod.width=bevel;mod.segments=3;bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj

def box(name,center,size,mat,bevel=.035):
    v=[tuple(center[i]+s[i]*size[i]/2 for i in range(3)) for s in [(x,y,z) for z in [-1,1] for y in [-1,1] for x in [-1,1]]]
    return mesh('SV3_Board_'+name,v,[(0,2,3,1),(4,5,7,6),(0,1,5,4),(2,6,7,3),(0,4,6,2),(1,3,7,5)],mat,bevel)

def plate(name,outline,front,thickness,mat):
    n=len(outline); v=[(x,y,z) for y in [front,front+thickness] for x,z in outline]
    return mesh('SV3_Board_'+name,v,[tuple(range(n-1,-1,-1)),tuple(range(n,2*n))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)],mat,.035)

# A title plaque and separate planks carry the native form instead of a paper sheet.
box('Back',(0,.15,4.2),(7.15,.36,5.85),dark,.10)
for i,(low,high) in enumerate([(1.45,2.40),(2.43,3.38),(3.41,4.35),(4.38,5.32),(5.35,5.74)]):
    plate('Plank_'+str(i),[(-3.38,low+.02),(-3.42,low+.16),(-3.39,high-.08),(-3.22,high),(3.28,high-.03),(3.43,high-.16),(3.38,low)],-.18,.22,wood)
plate('TitleArch',[(-3.39,5.77),(-3.39,6.98),(-2.25,7.32),(0,7.65),(2.25,7.32),(3.39,6.98),(3.39,5.77)],-.18,.28,wood)
for x in [-3.53,3.53]:
    box('Upright_'+str(x),(x,-.23,4.23),(.23,.25,5.84),dark)
    for z in [1.42,5.78,6.94]:
        box('Strap_'+str(x)+'_'+str(z),(x,-.41,z),(.45,.11,.40),brass)
        for dz in [-.105,.105]:
            bpy.ops.mesh.primitive_uv_sphere_add(segments=10,ring_count=6,radius=.049)
            o=bpy.context.object;o.name='SV3_Board_Rivet';o.parent=sign;o.location=(x,-.48,z+dz);o.data.materials.append(iron)
for x in [-2.9,2.9]:
    box('Mount_'+str(x),(x,.64,4.25),(.24,1.18,5.8),dark)
    for z in [1.6,6.8]:box('MountBand_'+str(x)+'_'+str(z),(x,.1,z),(.40,.13,.20),brass)
# A sculpted maple leaf replaces the compass, following the close-reference crest.
leaf=[(-.10,7.09),(-.13,7.47),(-.55,7.55),(-.36,7.78),(-.52,8.03),(-.19,7.97),(0,8.35),(.19,7.97),(.52,8.03),(.36,7.78),(.55,7.55),(.13,7.47),(.10,7.09)]
plate('MapleCrest',leaf,-.43,.10,brass)
# Visible steel/brass lantern and bent support; no billboard decoration.
box('LanternBracket',(-4.1,.08,6.15),(1.30,.16,.16),iron)
box('LanternHook',(-4.72,.08,5.91),(.14,.16,.55),iron)
box('LanternGlass',(-4.72,-.04,5.25),(.55,.48,.86),glow,.10)
for z in [4.73,5.79]:box('LanternCap_'+str(z),(-4.72,-.04,z),(.78,.65,.16),brass,.06)
for x in [-5.06,-4.38]:
    for y in [-.31,.23]:box('LanternBar_'+str(x)+'_'+str(y),(x,y,5.25),(.065,.065,.95),iron,.015)
anchor=bpy.data.objects.new('SV3_LoginSurface',None);scene.collection.objects.link(anchor);anchor.parent=sign;anchor.location=(0,-.26,4.2)
anchor['width']=6.65;anchor['height']=5.42
# Preserve the restored per-face material assignments. Recolouring follows the
# separately editable original parts; never repaint the ship with a height mask.
# Only the intended plaque geometry changed; cloth and all supporting hull faces survive.
for name,(nv,nf,coords) in unrelated.items():
    o=bpy.data.objects[name];assert len(o.data.vertices)==nv and len(o.data.polygons)==nf and tuple(tuple(v.co) for v in o.data.vertices)==coords,name
scene['login_reference']=sign['reference']
for obj in scene.objects:
    if obj.get('prototype_reference'): obj['prototype_reference']='resources/scenes/sky-voyage-v2/design/ship-orthographic-v1.png'
bpy.ops.file.pack_all()
bpy.ops.wm.save_as_mainfile(filepath=str(DEST/'sky-voyage.blend'),compress=True)
bpy.ops.export_scene.gltf(filepath=str(DEST/'sky-voyage.glb'),export_format='GLB',use_active_scene=True,export_yup=True,export_extras=True,export_apply=False,export_animations=True)
print('LOGIN_REFERENCE_READY',json.dumps({'source':sign['reference'],'surfaces':len(sign.children),'unrelated_meshes_preserved':len(unrelated)},ensure_ascii=False))
