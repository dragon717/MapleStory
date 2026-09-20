"""Import unchanged Kenney CC0 mesh geometry; unify paint materials, scale and UVs."""
import bpy,json
from mathutils import Vector
root='/Users/muniao/Code/MapleStory/resources/scenes/colossus/redesign/'
s=bpy.data.scenes.new('CR_VegetationLibrary');bpy.context.window.scene=s
s.unit_settings.system='METRIC';s.unit_settings.scale_length=1
wood=bpy.data.materials['CR_wood'].copy();wood.name='CR_PaintedBark'
tex=wood.node_tree.nodes.new('ShaderNodeTexImage')
tex.image=bpy.data.images.load('/Users/muniao/Code/MapleStory/client/public-tms273/assets/colossus/handpainted-timber.png',check_existing=True);tex.image.pack()
shader=next(n for n in wood.node_tree.nodes if n.type=='BSDF_PRINCIPLED');wood.node_tree.links.new(tex.outputs['Color'],shader.inputs['Base Color'])
results={}
for name,source,height in [('tree','tree_oak',7),('bush','plant_bushDetailed',1.4),('grass','grass',.65),('flowers','flower_yellowA',.65)]:
 bpy.ops.object.select_all(action='DESELECT')
 bpy.ops.wm.obj_import(filepath=root+'vegetation/kenney-nature-kit/Models/OBJ format/'+source+'.obj',forward_axis='NEGATIVE_Z',up_axis='Y')
 objects=list(bpy.context.selected_objects)
 points=[o.matrix_world@Vector(c) for o in objects for c in o.bound_box]
 low=min(p.z for p in points);high=max(p.z for p in points);scale=height/(high-low)
 for o in objects:
  o.location.z-=low;o.location*=scale;o.scale*=scale
  o['source']='Kenney Nature Kit';o['license']='CC0-1.0';o['original_mesh']=source
  for i,m in enumerate(o.data.materials):
   if 'leaf' in m.name.lower() or 'grass' in m.name.lower() or 'stem' in m.name.lower():o.data.materials[i]=bpy.data.materials['CR_grass']
   elif 'bark' in m.name.lower() or 'wood' in m.name.lower():o.data.materials[i]=wood
  bpy.context.view_layer.objects.active=o
  bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
  bpy.ops.object.mode_set(mode='EDIT');bpy.ops.mesh.select_all(action='SELECT');bpy.ops.uv.smart_project();bpy.ops.object.mode_set(mode='OBJECT')
 bpy.ops.export_scene.gltf(filepath=root+'models/'+name+'.glb',use_selection=True,use_active_scene=True,export_extras=True)
 results[name]={'height':height,'objects':len(objects)}
 # Separate source instances for the library preview only, after writing each neutral GLB.
 for o in objects:o.location.x+=len(results)*10
s.world=bpy.data.scenes['CR_Rigged_100km'].world
# Stone handholds are authored cubes, distinct from the unchanged vegetation meshes.
bpy.ops.object.select_all(action='DESELECT')
grips=[]
for location,size in [((0,0,0),(3.2,.95,.48)),((0,.3,.12),(2.6,.38,.5))]:
 bpy.ops.mesh.primitive_cube_add(size=1,location=location)
 o=bpy.context.object;o.name='CR_ClimbGrip';o.dimensions=size
 bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
 o.data.materials.append(bpy.data.materials['CR_light'])
 bevel=o.modifiers.new('Stone edges','BEVEL');bevel.width=.08;bevel.segments=2
 grips.append(o)
bpy.ops.object.select_all(action='DESELECT')
for o in grips:o.select_set(True)
bpy.ops.export_scene.gltf(filepath=root+'models/grip.glb',use_selection=True,use_active_scene=True,export_extras=True)
for o in grips:o.hide_set(True)
bpy.ops.wm.save_as_mainfile(filepath=root+'models/vegetation_library.blend')
print(json.dumps(results))
