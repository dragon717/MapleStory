"""Add matching walk surfaces for four-arrow courtyard junctions; preserve approved scenery."""
import bpy,json,math
from pathlib import Path
ROOT=Path('/Users/muniao/Code/MapleStory');DEST=ROOT/'resources/scenes/chuxian-east-v1'
scene=bpy.context.scene
layout=json.loads((DEST/'source-layout.json').read_text(encoding='utf-8'))
for obj in list(scene.objects):
    if obj.name.startswith('CE_FourArrow'):bpy.data.objects.remove(obj,do_unlink=True)
materials={m.name:m for m in bpy.data.materials}
mat=next(m for m in bpy.data.materials if 'stone' in m.name.lower())
vertices=[];faces=[]
for road in layout['routes']:
    points=[layout['nodes'][name] for name in road['points']];width=road['width']/2
    for a,b in zip(points,points[1:]):
        dx=b[0]-a[0];dy=b[1]-a[1];length=math.hypot(dx,dy)
        if not length:continue
        px=-dy/length*width;py=dx/length*width;start=len(vertices)
        vertices.extend([(a[0]+px,a[1]+py,a[2]+.035),(a[0]-px,a[1]-py,a[2]+.035),(b[0]-px,b[1]-py,b[2]+.035),(b[0]+px,b[1]+py,b[2]+.035)])
        faces.append((start,start+1,start+2,start+3))
mesh=bpy.data.meshes.new('CE_FourArrowRoadSurfaces');mesh.from_pydata(vertices,[],faces);mesh.update();mesh.materials.append(mat)
obj=bpy.data.objects.new('CE_FourArrowRoadSurfaces',mesh);scene.collection.objects.link(obj);obj['layer']='roads';obj['walkable']=True
# Small arrival pads join the mitered strips, avoiding corner wedges.
for name,point in layout['nodes'].items():
    if '-J' not in name and name not in ['marketCross','gardenFront','stairsFoot']:continue
    bpy.ops.mesh.primitive_cylinder_add(vertices=24,radius=1.65,depth=.12,location=(point[0],point[1],point[2]-.02))
    pad=bpy.context.object;pad.name='CE_FourArrowPad_'+name;pad.data.materials.append(mat);pad['layer']='roads';pad['walkable']=True
scene['layout']=json.dumps(layout,ensure_ascii=False)
bpy.ops.wm.save_as_mainfile(filepath=str(DEST/'models/chuxian-east.blend'))
bpy.ops.export_scene.gltf(filepath=str(DEST/'models/chuxian-east.glb'),export_format='GLB',use_active_scene=True,export_extras=True,export_animations=False,export_lights=False,export_cameras=False)
print('CHUXIAN_FOUR_ARROW_SURFACES',len(layout['routes']))
