# Run through Blender MCP after inspecting the existing CR_Rigged_100km scene.
import bpy,json
from mathutils import Vector
src=bpy.data.scenes['CR_Rigged_100km']
if bpy.data.scenes.get('CG_ColossusTerrain'):raise RuntimeError('Inspect the existing terrain revision before repeating')
s=bpy.data.scenes.new('CG_ColossusTerrain');bpy.context.window.scene=s
armSrc=next(o for o in src.objects if o.type=='ARMATURE');meshSrc=next(o for o in src.objects if o.type=='MESH')
arm=armSrc.copy();arm.data=armSrc.data.copy();s.collection.objects.link(arm)
obj=meshSrc.copy();obj.data=meshSrc.data.copy();s.collection.objects.link(obj);obj.parent=arm
for mod in obj.modifiers:
    if mod.type=='ARMATURE':mod.object=arm
points=set()
for p in obj.data.polygons:
    if obj.data.materials[p.material_index].name not in ['CR_grass','CR_leaf','CR_shade']:continue
    for vi in p.vertices:
        v=obj.data.vertices[vi]
        if any(obj.vertex_groups[g.group].name in ['shin.L','shin.R'] and g.weight>.5 for g in v.groups):points.add(vi)
inv=obj.matrix_world.inverted()
for vi in points:
    v=obj.data.vertices[vi];p=obj.matrix_world@v.co
    # Separate inland knee gardens, not a 15 km green wall at the harbor lip.
    center=-14500 if p.x<0 else 14500;target=-19600 if p.x<0 else 19600
    p.x=target+(p.x-center)*.19;p.y*=.32
    v.co=inv@p
obj.data.update()
s.world=src.world
bpy.ops.object.select_all(action='DESELECT');arm.select_set(True);obj.select_set(True);bpy.context.view_layer.objects.active=arm
root='/Users/muniao/.codex/worktrees/7c6b/MapleStory/resources/scenes/colossus/redesign/'
bpy.ops.export_scene.gltf(filepath=root+'models/colossus-rigged.glb',use_selection=True,use_active_scene=True,export_extras=True,export_apply=False)
bpy.ops.wm.save_as_mainfile(filepath=root+'models/colossus_terrain_refined.blend')
bpy.context.window.scene=bpy.data.scenes['CH_HandpaintedHarbor']
print(json.dumps({'edited_knee_garden_vertices':len(points),'bones':len(arm.data.bones),'hand_geometry':'unchanged','units':'metres'}))
