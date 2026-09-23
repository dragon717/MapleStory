"""Visual revision after inspecting the full-village Blender draft render."""
import bpy, math, json
from pathlib import Path
from mathutils import Vector
ROOT=Path(__file__).resolve().parents[3];OUT=ROOT/'resources/scenes/henesys'
s=bpy.data.scenes['HN_Henesys'];bpy.context.window.scene=s
# Cap panels were authored centre-to-rim: reverse to outward-facing winding.
for o in s.objects:
 if o.type=='MESH' and 'Cap' in o.name and 'LampCap' not in o.name:
  if len(o.data.polygons)>100 and o.data.polygons[0].normal.z<0:
   import bmesh
   bm=bmesh.new();bm.from_mesh(o.data);bmesh.ops.reverse_faces(bm,faces=list(bm.faces));bm.to_mesh(o.data);bm.free()
# Native source trees retain their branching/crown layout; subdivide rounded leaf masses.
plant_data=set()
for o in s.objects:
 if o.type=='MESH' and o.get('source','').startswith('Kenney'):
  if o.data not in plant_data:
   plant_data.add(o.data)
   if o.data.has_custom_normals:o.data.normals_split_custom_set([(0,0,0)]*len(o.data.loops))
  if 'tree_' in o.name or 'bush' in o.name:
   mod=o.modifiers.new('Soft organic source silhouette','SUBSURF');mod.levels=2;mod.render_levels=2
# Leaf/grass maps should read as broad natural pigment, not a repeated checker.
colors={'leaf':(.26,.43,.115),'leafLight':(.39,.55,.16),'leafDeep':(.19,.34,.17),'grass':(.32,.44,.15),'path':(.55,.42,.24)}
for name,color in colors.items():
 m=bpy.data.materials['HN_'+name];p=next(n for n in m.node_tree.nodes if n.type=='BSDF_PRINCIPLED')
 for socket in ['Base Color','Normal']:
  for link in list(p.inputs[socket].links):m.node_tree.links.remove(link)
 p.inputs['Base Color'].default_value=(*color,1);p.inputs['Roughness'].default_value=.9;m.diffuse_color=(*color,1)
# Smooth meadow backdrop with rolling contours, no repetitive forest wall.
far=bpy.data.objects.get('HN_FarGround');far.hide_render=True;far.hide_set(True)
verts=[];faces=[];nx=90;ny=36
for j in range(ny):
 y=-100+j*11
 for i in range(nx):
  x=-480+i*11
  if y<18:z=-3.3
  else:
   rise=min(1,(y-18)/40)
   z=-3+rise*(7+5*math.sin(x*.019+y*.009)+4*math.sin(x*.047-y*.014))
  verts.append((x,y,z))
for j in range(ny-1):
 for i in range(nx-1):
  a=j*nx+i;faces.append((a,a+1,a+1+nx,a+nx))
mesh=bpy.data.meshes.new('HN_RollingMeadow');mesh.from_pydata(verts,[],faces);mesh.update();mesh.materials.append(bpy.data.materials['HN_grass'])
for p in mesh.polygons:p.use_smooth=True
ob=bpy.data.objects.new('HN_RollingMeadow',mesh);bpy.data.collections['HN_Terrain'].objects.link(ob)
# Reduce the picket-fence forest rhythm: individual depth, height and missing intervals.
for o in list(s.objects):
 if o.type=='MESH' and 'tree_default' in o.name and not o.hide_render:
  seed=sum(ord(c) for c in o.name)
  if seed%4==0:o.hide_render=True;o.hide_set(True)
  else:o.location.y+= (seed%5)*2.7;o.scale*=.75+(seed%7)*.035
# Warmer bright ambient sky and directional, soft afternoon light.
world=s.world;p=next(n for n in world.node_tree.nodes if n.type=='BACKGROUND')
p.inputs['Color'].default_value=(.53,.68,.76,1);p.inputs['Strength'].default_value=.8
bpy.data.lights['HN_WarmSun'].energy=3.2;bpy.data.lights['HN_WarmSun'].color=(1.0,.86,.67)
bpy.data.objects['HN_WarmSun'].rotation_euler=(math.radians(23),math.radians(-35),math.radians(-25))
s.view_settings.exposure=.3
# Broad rear mist volume creates depth, without filling the village with glow.
mat=bpy.data.materials.new('HN_DistantAir');mat.use_nodes=True;nodes=mat.node_tree.nodes;nodes.clear()
output=nodes.new('ShaderNodeOutputMaterial');volume=nodes.new('ShaderNodeVolumePrincipled')
volume.inputs['Density'].default_value=.007;volume.inputs['Color'].default_value=(.65,.79,.81,1)
mat.node_tree.links.new(volume.outputs['Volume'],output.inputs['Volume'])
bpy.ops.mesh.primitive_cube_add(size=1,location=(0,115,35));mist=bpy.context.object;mist.name='HN_DistantAtmosphere';mist.dimensions=(700,180,100);mist.data.materials.append(mat)
for c in list(mist.users_collection):c.objects.unlink(mist)
bpy.data.collections['HN_Set'].objects.link(mist)
# Main camera remains horizontal and low enough to recognise original landmarks.
cam=bpy.data.objects['HN_Overview'];cam.location=(0,-150,55);cam.rotation_euler=(Vector((0,3,7))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=145
s.camera=cam;s.render.resolution_percentage=50;s.cycles.samples=24
s.render.filepath=str(OUT/'previews/overview-refined.png')
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'models/henesys.blend'))
bpy.ops.render.render(write_still=True)
s.camera=bpy.data.objects['HN_CloseEast'];s.render.resolution_x=1600;s.render.resolution_y=1100;s.render.resolution_percentage=65
s.render.filepath=str(OUT/'previews/east-draft.png');bpy.ops.render.render(write_still=True)
s.camera=cam
(OUT/'logs/refine.json').write_text(json.dumps({'status':'refined','objects':len(s.objects)}),encoding='utf-8')
