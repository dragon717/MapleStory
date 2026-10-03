"""Read-only, neutral-lit orthographic evidence; no saves or exports."""
import bpy, math, json, sys
from pathlib import Path
from mathutils import Vector, Matrix

ROOT=Path(__file__).resolve().parents[3]
args=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
BLEND=args[0] if args else str(ROOT/'resources/scenes/sky-voyage-v3/models/sky-voyage.blend')
PREFIX=args[1] if len(args)>1 else 'after'
OUT=ROOT/'evidence/2026-10-03/voyage-reference-repair'
OUT.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=BLEND, load_ui=False)
scene=bpy.data.scenes['SV3_ProductionRig']
ship=bpy.data.objects['SV2_Ship']
city=bpy.data.objects.get('SV2_City')
cabin=bpy.data.objects.get('SV3_CabinInterior')

def is_descendant(obj, root):
    p=obj
    while p is not None:
        if p==root: return True
        p=p.parent
    return False

# Evidence pass shows the exterior ship hierarchy only.  City, cabin white-box
# geometry, and any previous cameras/lights are hidden in memory and never saved.
for obj in scene.objects:
    obj.hide_render = not is_descendant(obj, ship)
if city is not None: city.hide_render=True
if cabin is not None:
    for obj in scene.objects:
        if is_descendant(obj, cabin): obj.hide_render=True

# Use a controlled neutral/world-light setup for material readability.
# Blender 5.2 in this project exposes the Eevee engine under this enum.
scene.render.engine='BLENDER_EEVEE'
scene.render.resolution_x=1280
scene.render.resolution_y=720
scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'
scene.render.image_settings.color_mode='RGBA'
scene.render.film_transparent=False
scene.render.use_file_extension=True
scene.render.filepath=str(OUT/f'{PREFIX}-side.png')
scene.world.use_nodes=True
world_bg=next((n for n in scene.world.node_tree.nodes if n.type=='BACKGROUND'),None)
if world_bg is not None:
    world_bg.inputs['Color'].default_value=(0.62,0.68,0.76,1.0)
    world_bg.inputs['Strength'].default_value=0.65
try:
    scene.view_settings.view_transform='AgX'
except Exception: pass
try:
    scene.view_settings.look='AgX - Medium High Contrast'
except Exception: pass
scene.view_settings.exposure=0.35
scene.view_settings.gamma=1.0

def look_matrix(location, target, world_up):
    location=Vector(location); target=Vector(target); world_up=Vector(world_up)
    forward=(target-location).normalized()
    right=forward.cross(world_up).normalized()
    up=right.cross(forward).normalized()
    matrix=Matrix((right,up,-forward)).transposed().to_4x4()
    matrix.translation=location
    return matrix

def add_area(name, location, target, energy, size, color):
    data=bpy.data.lights.new(name, 'AREA'); data.energy=energy; data.shape='DISK'; data.size=size; data.color=color
    obj=bpy.data.objects.new(name,data); scene.collection.objects.link(obj)
    obj.matrix_world=look_matrix(location,target,(0,0,1))
    return obj

# Bounding box of the actual visible ship mesh objects, in world coordinates.
points=[]
for obj in scene.objects:
    if obj.type!='MESH' or not is_descendant(obj,ship) or obj.hide_render: continue
    for corner in obj.bound_box:
        points.append(obj.matrix_world @ Vector(corner))
if not points: raise RuntimeError('no visible ship mesh bounds')
lo=Vector((min(p.x for p in points),min(p.y for p in points),min(p.z for p in points)))
hi=Vector((max(p.x for p in points),max(p.y for p in points),max(p.z for p in points)))
target=(lo+hi)*0.5

views={
    # camera forward is camera->target; up gives the desired orthographic roll
    'side': ((-1,0,0),(0,0,1),'Y','Z'),
    'top': ((0,0,-1),(-1,0,0),'Y','X'),
    'stern': ((0,1,0),(0,0,1),'X','Z'),
}
area=scene.render.resolution_x/scene.render.resolution_y
cam_data=bpy.data.cameras.new('Evidence_OrthographicCamera'); cam=bpy.data.objects.new('Evidence_OrthographicCamera',cam_data); scene.collection.objects.link(cam)
cam_data.type='ORTHO'; cam_data.lens=55; cam_data.clip_start=0.01; cam_data.clip_end=10000.0; cam_data.dof.use_dof=False
scene.camera=cam
# Large, soft, warm key and cool fill make the existing material boundaries legible.
add_area('Evidence_WarmKey',(150,-190,150),target,220000.0,115.0,(1.0,0.95,0.88))
add_area('Evidence_CoolFill',(-170,-20,95),target,180000.0,145.0,(0.85,0.92,1.0))
add_area('Evidence_Rim',(40,190,135),target,190000.0,120.0,(1.0,0.95,0.88))

for name,(forward,up,width_axis,height_axis) in views.items():
    forward=Vector(forward).normalized(); up=Vector(up).normalized(); right=forward.cross(up).normalized(); true_up=right.cross(forward).normalized()
    vals_w=[(p-target).dot(right) for p in points]; vals_h=[(p-target).dot(true_up) for p in points]
    span_w=max(vals_w)-min(vals_w); span_h=max(vals_h)-min(vals_h)
    cam_data.ortho_scale=max(span_w,span_h*area)*1.10
    distance=max((hi-lo).length*2.0,100.0)
    cam.location=target-forward*distance
    cam.matrix_world=look_matrix(cam.location,target,up)
    scene.render.filepath=str(OUT/f'{PREFIX}-{name}.png')
    scene.render.resolution_percentage=100
    bpy.ops.render.render(write_still=True)
    print(json.dumps({'view':name,'output':str(OUT/f'{PREFIX}-{name}.png'),'bbox_min':list(lo),'bbox_max':list(hi),'target':list(target),'span_width':span_w,'span_height':span_h,'aspect':area,'ortho_scale':cam_data.ortho_scale},ensure_ascii=False))
