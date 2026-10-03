"""Apply the exterior-only 2.5D lobby correction to the CURRENT authored ship.

Run with sky-voyage.blend loaded. Keep all accepted hull/sail/glass meshes;
remove only the obsolete walk-in floor, threshold and replace the doorway.
Runtime routes use shared/voyage-deck.json in ship-local glTF metres.
"""
import bpy, json, math
from pathlib import Path
from mathutils import Vector
ROOT = Path(__file__).resolve().parents[3]
DEST = ROOT / 'resources/scenes/sky-voyage-v3/models'
scene = bpy.data.scenes['SV3_ProductionRig']
bpy.context.window.scene = scene
scene.frame_set(1)
ship = bpy.data.objects['SV2_Ship']
room = bpy.data.objects['SV3_CaptainRoom']
bpy.context.preferences.filepaths.save_version = 0
# Conversion must operate on the new rail alone. The saved source may have
# every object selected, including the editable sail shape keys.
bpy.ops.object.select_all(action='DESELECT')
shape_keys_before = {obj.name: tuple(key.name for key in obj.data.shape_keys.key_blocks)
                     for obj in scene.objects if obj.type == 'MESH' and obj.data.shape_keys}

def remove_tree(obj):
    for child in list(obj.children): remove_tree(child)
    bpy.data.objects.remove(obj, do_unlink=True)

for name in ['SV3_CaptainFloor', 'SV3_CaptainDoorThreshold', 'SV3_CaptainDoorSeal', 'SV3_CaptainArcWalkway']:
    obj = bpy.data.objects.get(name)
    if obj: remove_tree(obj)
room['lobby_walkable'] = False
if 'interior_bounds' in room: del room['interior_bounds']
wall_material = bpy.data.materials['SV3_Prototype_SternWalnut']
wood_material = bpy.data.materials['SV3_M_Wood']

def mesh(name, vertices, faces, material, parent):
    data = bpy.data.meshes.new(name + '_Mesh')
    data.from_pydata(vertices, [], faces); data.materials.append(material); data.update()
    uv = data.uv_layers.new(name='MaterialUV')
    for face in data.polygons:
        axis = max(range(3), key=lambda i: abs(face.normal[i]))
        a, b = [(1,2), (0,2), (0,1)][axis]
        for i in face.loop_indices:
            co = data.vertices[data.loops[i].vertex_index].co
            uv.data[i].uv = (co[a] / 3, co[b] / 3)
    obj = bpy.data.objects.new(name, data); scene.collection.objects.link(obj); obj.parent = parent
    return obj

def box(name, center, size, material, parent):
    vertices = [tuple(center[i] + signs[i] * size[i] / 2 for i in range(3))
                for signs in [(x,y,z) for z in [-1,1] for y in [-1,1] for x in [-1,1]]]
    return mesh(name, vertices, [(0,2,3,1),(4,5,7,6),(0,1,5,4),(2,6,7,3),(0,4,6,2),(1,3,7,5)], material, parent)

box('SV3_CaptainDoorSeal', (4.8,-13.25,6.77), (.34,2.5,2.7), wall_material, room)
portal = bpy.data.objects['SV3_CaptainPortal']
portal.location = (5.65,-13.25,5.42)
portal['lobby_target'] = 'SV3_CabinInterior'; portal['interaction'] = 'Space only'
bpy.data.objects['SV3_CabinDeckPortal']['lobby_target'] = 'SV3_CaptainPortal'
sign = bpy.data.objects['SV2_LoginSign']; sign.parent = ship
sign.location = (10.3,0,5.4); sign.scale = (1,1,1); sign.rotation_euler = (0,0,math.pi/2)
adventure=bpy.data.objects['SV3_AdventureSign']; adventure.parent=ship; adventure.location=(5.05,-10.3,7); adventure.rotation_euler=(0,0,math.pi/2)

layout = json.loads((ROOT / 'shared/voyage-deck.json').read_text(encoding='utf-8'))
points = [Vector(p) for p in layout['walkways']['captainArc']['points']]
width = layout['walkways']['captainArc']['width']
walkway = bpy.data.objects.new('SV3_CaptainArcWalkway', None)
scene.collection.objects.link(walkway); walkway.parent = bpy.data.objects['SV3_Exterior']
vertices = []; paths = [[], []]
for i, point in enumerate(points):
    tangent = points[min(i+1,len(points)-1)] - points[max(i-1,0)]
    tangent.y = 0; tangent.normalize()
    side = Vector((-tangent.z,0,tangent.x)) * width / 2
    for index, sign_side in enumerate([-1,1]):
        p = point + side * sign_side
        vertices.append((p.x,-p.z,p.y))
        paths[index].append(Vector((p.x,-p.z,p.y+.5)))
faces = []
# Our left/right order is the reverse of the runtime ribbon's order.
for i in range(len(points)-1):
    b = i*2; faces += [(b,b+1,b+3),(b,b+3,b+2)]
surface = mesh('SV3_CaptainArcWalkway_Surface',vertices,faces,wood_material,walkway)
surface['lobby_route'] = 'captainArc; fixed centreline'
for side_index, path in enumerate(paths):
    curve = bpy.data.curves.new('CaptainRail', 'CURVE'); curve.dimensions='3D'; curve.bevel_depth=.08; curve.bevel_resolution=2
    spline = curve.splines.new('POLY'); spline.points.add(len(path)-1)
    for knot,p in zip(spline.points,path): knot.co=(*p,1)
    rail = bpy.data.objects.new('SV3_CaptainArcWalkway_Rail_'+str(side_index),curve)
    scene.collection.objects.link(rail); rail.parent=walkway; curve.materials.append(wall_material)
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active=rail; rail.select_set(True); bpy.ops.object.convert(target='MESH'); rail.select_set(False)
for i in range(1,len(points)-1,2):
    p=points[i]; box('SV3_CaptainArcWalkway_Pier_'+str(i),(p.x,-p.z,p.y-2.0),(.16,.16,4.0),wall_material,walkway)

# Targeted structural wood UV correction preserves the material islands and
# accepted cloth/emblem/gem data. No rerun of the old whole-ship polish.
for obj in scene.objects:
    if obj.type != 'MESH' or 'MaterialUV' not in obj.data.uv_layers: continue
    uv = obj.data.uv_layers['MaterialUV']
    for face in obj.data.polygons:
        material = obj.data.materials[face.material_index] if obj.data.materials else None
        if not material or material.get('voyage_material_semantic') not in ('SparWood','SternWalnut'): continue
        axis=max(range(3),key=lambda i:abs(face.normal[i])); a,b=[(1,2),(0,2),(1,0)][axis]
        for i in face.loop_indices:
            co=obj.data.vertices[obj.data.loops[i].vertex_index].co
            uv.data[i].uv=(co[a]/7,co[b]/7)

assert shape_keys_before == {obj.name: tuple(key.name for key in obj.data.shape_keys.key_blocks)
                             for obj in scene.objects if obj.type == 'MESH' and obj.data.shape_keys}, 'unrelated sail shape keys changed'
for obj in scene.objects: obj.select_set(obj.type in {'MESH','EMPTY'})
bpy.context.view_layer.objects.active=ship
bpy.ops.file.pack_all()
bpy.ops.wm.save_as_mainfile(filepath=str(DEST/'sky-voyage.blend'),compress=True)
bpy.ops.export_scene.gltf(filepath=str(DEST/'sky-voyage.glb'),export_format='GLB',use_selection=True,use_active_scene=True,export_yup=True,export_extras=True,export_apply=False,export_animations=True)
print('VOYAGE_25D_FINALIZED', json.dumps({'portal':[5.65,5.42,13.25], 'removed':['CaptainFloor','CaptainDoorThreshold'], 'route':layout['walkways']['captainArc']},ensure_ascii=False))
