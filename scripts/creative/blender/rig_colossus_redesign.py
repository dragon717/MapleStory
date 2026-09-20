"""Blender MCP: rigid stone skeleton, including every finger segment.
Uses the authored nested stone blocks and textures; vegetation is imported separately.
"""
import bpy,math,json,random
from mathutils import Vector,Quaternion
ROOT='/Users/muniao/Code/MapleStory/resources/scenes/colossus/redesign/'
if bpy.data.scenes.get('CR_Rigged_100km'):raise RuntimeError('Rig already exists; inspect before rebuild.')
SCENE=bpy.data.scenes.new('CR_Rigged_100km');bpy.context.window.scene=SCENE
SCENE.unit_settings.system='METRIC';SCENE.unit_settings.scale_length=1
SCENE['human_height_metres']=2;SCENE['colossus_height_metres']=100000
MATS={m.name.removeprefix('CR_'):m for m in bpy.data.materials if m.name.startswith('CR_')}
RNG=random.Random(260920)
col=bpy.data.collections.new('CR_RigGeometry');SCENE.collection.children.link(col)
objects=[]
def move(obj,col):
    for c in list(obj.users_collection):c.objects.unlink(obj)
    col.objects.link(obj)

def box(name,p,size,mat,col,bevel=.055,rot=None):
    bpy.ops.mesh.primitive_cube_add(size=1,location=p)
    o=bpy.context.object;o.name='CR_'+name;o.dimensions=size
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    move(o,col);o.data.materials.append(MATS[mat]);o['primitive']='cube'
    if bevel:
        m=o.modifiers.new('Soft hand-painted edge','BEVEL');m.width=min(size)*bevel;m.segments=2
    if rot:o.rotation_euler=rot
    return o

def sphere(name,p,r,mat,col):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=12,ring_count=8,radius=r,location=p)
    o=bpy.context.object;o.name='CR_'+name;move(o,col);o.data.materials.append(MATS[mat]);o['primitive']='sphere';return o

def bar(name,a,b,width,depth,mat,col):
    a,b=Vector(a),Vector(b);o=box(name,(a+b)/2,(width,depth,(b-a).length),mat,col)
    o.rotation_euler=(b-a).to_track_quat('Z','Y').to_euler();return o

def spiral(name,c,width,col):
    # Square spiral inlaid into the front face, kept geometric and readable.
    x,y,z=c;s=width/6
    points=[(-3,3),(3,3),(3,-3),(-3,-3),(-3,1),(1,1),(1,-1),(-1,-1)]
    for i,(a,b) in enumerate(zip(points,points[1:])):
        bar(name+str(i),(x+a[0]*s,y,z+a[1]*s),(x+b[0]*s,y,z+b[1]*s),width*.055,width*.04,'gold',col)

def meadow(name,c,size,col):
    x,y,z=c;w,d=size
    box(name+'soil',(x,y,z-.018*w),(w,d,.036*w),'shade',col)
    box(name+'grass',(x,y,z),(w*.99,d*.98,.028*w),'grass',col)
    for i in range(7):
        # These patches depict wooded watersheds at continental scale, not giant individual trees.
        px=x+(RNG.random()-.5)*w*.75;py=y+(RNG.random()-.5)*d*.7
        box(name+'watershed'+str(i),(px,py,z+.014*w),(w*(.10+RNG.random()*.14),d*.14,w*.014),'leaf' if i%2 else 'grass',col,.18)


def attach(obj,bone):
 obj['bone']=bone;objects.append(obj)
# Copy only the owned source geometry. Discard the fixed hands and make articulated hands below.
for old in bpy.data.collections['CR_body'].objects:
 if old.name.startswith(('CR_rightForearm','CR_rightCuff','CR_rightPalm','CR_rightFinger')):continue
 o=old.copy();o.data=old.data.copy();o.name='RG_'+old.name;col.objects.link(o)
 name=old.name.split('.')[0].removeprefix('CR_');side='L' if o.location.x<0 else 'R'
 if name.startswith(('boot','toe')):bone='foot.'+side
 elif name.startswith(('shin','kneePlate','kneeGarden')):bone='shin.'+side
 elif name.startswith(('thigh','hipJoint')):bone='thigh.'+side
 elif name.startswith(('upperArm','armMasonry','armJoint')):bone='upper_arm.'+side
 elif name.startswith(('shoulder',)):bone='clavicle.'+side
 elif name.startswith(('visor','headRoof','jaw','eye','crown')):bone='head'
 elif name.startswith(('belly','pelvis')):bone='pelvis'
 else:bone='chest'
 attach(o,bone)
# Bone heads/tails in the same metre-scale Z-up coordinates as the mesh.
bones={}
def bone(name,head,tail,parent=None):bones[name]=(head,tail,parent)
bone('root',(0,0,0),(0,0,5000))
bone('pelvis',(0,0,40000),(0,0,55000),'root')
bone('chest',(0,0,55000),(0,0,80000),'pelvis')
bone('head',(0,0,80000),(0,0,99000),'chest')
for sign,side in [(-1,'L'),(1,'R')]:
 bone('clavicle.'+side,(sign*10000,0,75000),(sign*34700,1200,66000),'chest')
 bone('upper_arm.'+side,(sign*34700,1200,66000),(sign*36500,-2500,48700),'clavicle.'+side)
 bone('forearm.'+side,(sign*36500,-2500,48700),(sign*36500,-4000,27700),'upper_arm.'+side)
 bone('hand.'+side,(sign*36500,-4000,27700),(sign*36500,-7000,22400),'forearm.'+side)
 bone('thigh.'+side,(sign*14500,0,40000),(sign*14500,0,30000),'pelvis')
 bone('shin.'+side,(sign*14500,0,30000),(sign*14500,-4000,10000),'thigh.'+side)
 bone('foot.'+side,(sign*14500,-4000,10000),(sign*14500,-18000,2500),'shin.'+side)
 attach(box('forearm_'+side,(sign*36500,-2500,38200),(19700,20600,21000),'stone',col),'forearm.'+side)
 attach(box('cuff_'+side,(sign*36500,-2700,30500),(20400,21100,2200),'teal',col),'forearm.'+side)
 attach(box('palm_'+side,(sign*36500,-4000,24900),(17000,17700,8300),'stone',col),'hand.'+side)
 for i in range(5):
  attach(box('handPlate_'+side,(sign*(29800+i*3300),-13300,25200),(3000,1000,5800),'light',col),'hand.'+side)
 for i,label in enumerate(['index','middle','ring','little']):
  x=sign*(30000+i*4500);length_factor=[1,.95,.89,.77][i]
  points=[(x,-7500,22400),(x,-8500,22400-3500*length_factor),(x,-9700,22400-6100*length_factor),(x,-10000,22400-8100*length_factor)]
  for j in range(3):
   name=label+'.'+str(j+1)+'.'+side;parent='hand.'+side if j==0 else label+'.'+str(j)+'.'+side
   bone(name,points[j],points[j+1],parent)
   a,b=Vector(points[j]),Vector(points[j+1]);mid=(a+b)/2
   obj=box('finger_'+name,mid,(3900,4300,(b-a).length*.91),'light' if j%2==0 else 'stone',col,.11)
   obj.rotation_euler=(b-a).to_track_quat('Z','Y').to_euler();attach(obj,name)
   plate=box('fingerInset_'+name,mid+Vector((0,-2250,0)),(2650,400,(b-a).length*.6),'light',col,.12)
   plate.rotation_euler=obj.rotation_euler;attach(plate,name)
 # Thumb opposes the fingers and has three independently programmable segments.
 points=[(sign*28500,-3500,26200),(sign*24800,-5500,23800),(sign*24300,-8000,21100),(sign*25900,-9900,19400)]
 for j in range(3):
  name='thumb.'+str(j+1)+'.'+side;bone(name,points[j],points[j+1],'hand.'+side if j==0 else 'thumb.'+str(j)+'.'+side)
  attach(bar('finger_'+name,points[j],points[j+1],4100,4500,'light',col),name)
# Armature is real skinning, with one rigid weight per stone; nothing stretches across joints.
data=bpy.data.armatures.new('CR_StoneSkeleton');rig=bpy.data.objects.new('CR_ColossusRig',data);SCENE.collection.objects.link(rig)
bpy.context.view_layer.objects.active=rig;rig.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
for name,(head,tail,parent) in bones.items():
 eb=data.edit_bones.new(name);eb.head=head;eb.tail=tail
 if parent:eb.parent=data.edit_bones[parent]
bpy.ops.object.mode_set(mode='OBJECT')
for obj in objects:
 bpy.context.view_layer.objects.active=obj
 # Apply only the bevel before weighting. Armature stays live in the exported glTF skin.
 for mod in list(obj.modifiers):bpy.ops.object.modifier_apply(modifier=mod.name)
 group=obj.vertex_groups.new(name=obj['bone']);group.add(list(range(len(obj.data.vertices))),1,'REPLACE')
 mod=obj.modifiers.new('Rigid stone skin','ARMATURE');mod.object=rig
 obj.parent=rig
bpy.ops.object.select_all(action='DESELECT')
for obj in objects:obj.select_set(True)
bpy.context.view_layer.objects.active=objects[0]
bpy.ops.object.join();mesh=bpy.context.object;mesh.name='CR_RiggedStoneMesh'
# Explicit limits for the program. These are rest-relative radians, not a gameplay physics engine.
for name,pb in rig.pose.bones.items():
 pb.rotation_mode='QUATERNION'
 if name.startswith(('index','middle','ring','little','thumb')):limit=[-.95,.12]
 elif name.startswith('forearm'):limit=[-1.12,.08]
 elif name.startswith('hand'):limit=[-.35,.35]
 elif name=='head':limit=[-.22,.22]
 elif name.startswith('upper_arm'):limit=[-.45,.65]
 else:limit=[-.16,.16]
 pb.bone['flex_min']=limit[0];pb.bone['flex_max']=limit[1]
# Save neutral pose, then inspect a limited flex pose and restore it after rendering.
old_scene=bpy.data.scenes['CR_Colossus_100km']
SCENE.world=old_scene.world
cam=old_scene.camera.copy();cam.data=cam.data.copy();cam.name='CR_RigCamera';SCENE.collection.objects.link(cam);SCENE.camera=cam
cam.location=(150000,-245000,145000);cam.rotation_euler=(Vector((0,0,50000))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=145000;cam.data.clip_start=100
sun=bpy.data.objects['CR_Sun'].copy();sun.data=sun.data.copy();SCENE.collection.objects.link(sun)
SCENE.render.resolution_x=1300;SCENE.render.resolution_y=1200;SCENE.render.resolution_percentage=100
bpy.ops.object.select_all(action='DESELECT');rig.select_set(True);mesh.select_set(True);bpy.context.view_layer.objects.active=rig
bpy.ops.export_scene.gltf(filepath=ROOT+'models/colossus-rigged.glb',use_selection=True,use_active_scene=True,export_extras=True)
pts=[mesh.matrix_world @ Vector(v) for v in mesh.bound_box];height=max(p.z for p in pts)-min(p.z for p in pts)
assert abs(height-100000)<.05
assert len(data.bones)==48
assert all(len(v.groups)==1 and abs(v.groups[0].weight-1)<1e-6 for v in mesh.data.vertices)
SCENE['rig_bone_count']=len(data.bones);SCENE['height_verified_metres']=height
bpy.ops.wm.save_as_mainfile(filepath=ROOT+'models/colossus_rigged_100km.blend')
SCENE.render.filepath=ROOT+'previews/rig-neutral.png';bpy.ops.render.render(write_still=True)
for name,angle in [('head',.16),('upper_arm.R',-.15),('forearm.R',-.65),('hand.R',-.14),('forearm.L',-.15)]:rig.pose.bones[name].rotation_quaternion=Quaternion((1,0,0),angle)
for side in ['L','R']:
 for finger in ['index','middle','ring','little','thumb']:
  for segment in [1,2,3]:rig.pose.bones[finger+'.'+str(segment)+'.'+side].rotation_quaternion=Quaternion((1,0,0),-.24 if side=='L' else -.48)
SCENE.render.filepath=ROOT+'previews/rig-flex.png';bpy.ops.render.render(write_still=True)
for pb in rig.pose.bones:pb.rotation_quaternion=Quaternion()
print(json.dumps({'scene':SCENE.name,'bones':len(data.bones),'fingers':30,'height':height,'mesh':mesh.name,'vertices':len(mesh.data.vertices)}))
