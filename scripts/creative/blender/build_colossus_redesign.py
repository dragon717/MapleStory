"""Run inside the live Blender instance through execute_blender_code.
Metres, Z up; export converts to glTF Y up. Only owns CR_ scenes/objects.
"""
import bpy, math, json, random
from mathutils import Vector
RNG = random.Random(260920)
if bpy.data.scenes.get('CR_Colossus_100km'):
    raise RuntimeError('Owned design already exists; inspect it before rebuilding.')
SCENE = bpy.data.scenes.new('CR_Colossus_100km')
bpy.context.window.scene = SCENE
SCENE.unit_settings.system = 'METRIC'
SCENE.unit_settings.scale_length = 1
SCENE['human_height_metres'] = 2
SCENE['colossus_height_metres'] = 100000
SCENE['height_ratio'] = 50000
SCENE['reference_note'] = 'Full-body flora means landscape/forest cover; individual houses and trees belong only to local district assets.'
MATS = {}
colors = {'stone':(0.78,.74,.60,1),'light':(.94,.87,.69,1),'shade':(.43,.52,.48,1),'teal':(.20,.46,.49,1),'gold':(.94,.60,.17,1),'dark':(.055,.105,.115,1),'grass':(.28,.53,.12,1),'leaf':(.40,.66,.20,1),'wood':(.42,.24,.115,1),'white':(.99,.94,.75,1),'water':(.15,.68,.72,1)}
for name,color in colors.items():
    mat=bpy.data.materials.new('CR_'+name);mat.use_nodes=True;mat.diffuse_color=color
    shader=next(n for n in mat.node_tree.nodes if n.type=='BSDF_PRINCIPLED')
    shader.inputs['Base Color'].default_value=color
    shader.inputs['Roughness'].default_value=.95
    if name=='gold':
        shader.inputs['Emission Color'].default_value=color
        shader.inputs['Emission Strength'].default_value=.4
    MATS[name]=mat
ASSETS={}
def asset(name):
    c=bpy.data.collections.new('CR_'+name);SCENE.collection.children.link(c);ASSETS[name]=c;return c

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

body=asset('body')
for sign in [-1,1]:
    x=sign*14500
    box('boot',(x,-4000,6000),(20000,28500,12000),'stone',body)
    box('bootTrim',(x,-4200,10000),(20500,28600,1500),'teal',body)
    for i in range(3):box('toe',(x-6500+i*6500,-17000,2500),(6100,6500,5000),'light',body)
    box('shin',(x,0,20500),(16500,18500,19000),'stone',body)
    box('kneePlate',(x,-10500,30200),(15000,4500,9000),'light',body)
    sphere('hipJoint',(x,0,35400),5500,'shade',body)
    box('thigh',(x,800,36600),(15500,16800,11000),'stone',body)
    meadow('kneeGarden',(x,0,30500),(15000,16000),body)
box('pelvis',(0,2000,44000),(31500,19500,13000),'shade',body)
box('belly',(0,0,53500),(33000,23500,19500),'stone',body)
box('chest',(0,0,68500),(47000,26500,19000),'stone',body)
box('chestLowerTrim',(0,-13700,60000),(42000,1500,2000),'teal',body)
for sign in [-1,1]:
    box('breastPanel',(sign*12600,-14400,71000),(22000,4400,15500),'light',body)
    box('shoulder',(sign*34200,600,74800),(23800,25400,22400),'stone',body)
    box('shoulderBorder',(sign*34200,-12700,74600),(19400,800,18400),'teal',body)
    box('shoulderFace',(sign*34200,-13400,74600),(16200,900,14800),'light',body)
    spiral('shoulderSpiral',(sign*34200,-14100,74600),10300,body)
    sphere('armJoint',(sign*34700,1200,57500),7000,'shade',body)
    box('upperArm',(sign*35000,800,58000),(17500,18200,18000),'stone',body)
    meadow('shoulderCountry',(sign*33000,1000,86500),(24000,24200),body)
# Right forearm and hand hang; left forearm and hand are separately articulated at runtime.
box('rightForearm',(36500,-2500,38200),(19700,20600,21000),'stone',body)
box('rightCuff',(36500,-2700,30900),(20400,21100,2500),'teal',body)
box('rightPalm',(36500,-4000,24400),(17000,17700,10000),'stone',body)
for i in range(4):box('rightFinger',(30000+i*4500,-8000,17600),(4100,8500,7200),'light',body)
box('visor',(0,-700,88300),(25500,17500,10000),'dark',body)
box('headRoof',(0,0,95200),(28200,20500,4800),'stone',body)
for x in [-9600,0,9600]:box('jaw',(x,-4400,83500),(9200,16500,5000),'light',body)
for x in [-6500,0,6500]:
    box('eyeH',(x,-9560,89500),(2550,400,680),'gold',body,.12)
    box('eyeV',(x,-9600,89500),(680,400,2550),'gold',body,.12)
meadow('crownCountry',(0,0,98600),(27800,20000),body)
# Exact dimensional crown cap: sole 0 m to 100000 m, excluding no foliage/ornament.
box('crownRidge',(0,2500,99600),(7800,4800,800),'grass',body,.1)
for i in range(3):
    z=67200+i*7600;y=9700+i*1800
    box('backTerrace',(0,y,z),(41000-i*7500,12000,4200),'stone',body)
    meadow('backCountry',(0,y,z+2250),(40000-i*7300,11800),body)

hand=asset('hand')
# Local tip top is 0: this is the SAME hand whose small shore edge is seen at the harbor.
box('palm',(19000,0,-3000),(16500,20000,6000),'stone',hand)
for i in range(4):
    y=-7200+i*4800
    box('fingerDistal',(3500,y,-2200),(7000,4200,4400),'light',hand)
    box('fingerMiddle',(9200,y,-2100),(4200,4300,4200),'stone',hand)
    box('knuckle',(12200,y,-2200),(2300,4500,4500),'light',hand)
box('thumb',(19000,13700,-2700),(7000,8200,5000),'stone',hand,rot=(0,0,-.35))
box('palmTrim',(22800,0,-1300),(1900,20100,950),'teal',hand)
meadow('palmCountry',(19000,0,280),(11500,15700),hand)
# Continental silhouette and metre-scale route detail are separate assets.
arm=asset('forearm')
box('forearm',(0,0,0),(12000,12000,1),'stone',arm,0)
# Unit Z length is stretched between authoritative visual anchor points by the client.

house=asset('house')
box('houseBase',(0,0,.18),(7.2,6.2,.36),'stone',house)
box('house',(0,0,2.6),(6.4,5.4,5.0),'light',house)
for sign in [-1,1]:
    box('roofSlope',(sign*1.7,0,5.8),(4.2,6.4,.45),'teal',house,rot=(0,sign*.56,0))
    box('window',(sign*1.65,-2.74,2.8),(1.15,.14,1.55),'dark',house)
    box('windowBar',(sign*1.65,-2.86,2.8),(1.2,.12,.10),'wood',house)
box('door',(0,-2.76,1.65),(1.25,.16,2.8),'wood',house)
box('lintel',(0,-2.87,3.13),(1.6,.2,.26),'teal',house)
for x in [-3.0,3.0]:box('pillar',(x,-2.72,2.6),(.26,.27,5.1),'teal',house)
box('chimney',(1.7,1.5,6.8),(.7,.8,1.7),'light',house)

# Vegetation uses licensed existing 3D assets, never procedural trees/flowers.

heart=asset('heart')
sphere('livingHeart',(0,0,16),5,'gold',heart)
for i in range(8):
    a=i*math.tau/8
    box('heartPlate',(math.cos(a)*8,0,16+math.sin(a)*8),(5,5,7),'light',heart,rot=(0,-a,0))
for z,w in [(0,30),(2,23),(4,15)]:box('heartBase',(0,0,z),(w,20,.7),'stone',heart)
for x in [-17,17]:
    box('heartPillar',(x,2,12),(3,4,24),'stone',heart)
    box('heartPillarTop',(x,2,24),(5,6,1),'teal',heart)
bar('heartConduit',(0,0,3),(0,0,9),.3,.3,'gold',heart)

temple=asset('temple')
for x in [-22,-11,0,11,22]:
    box('templeFloor',(x,0,-1),(10.6,30,2),'stone',temple)
    if x:
        for y in [-11,11]:
            box('templeColumn',(x,y,13),(3,3,26),'light',temple)
            box('templeCapital',(x,y,26),(5,5,2),'teal',temple)
for y in [-11,11]:box('templeBeam',(0,y,28),(49,4,4),'stone',temple)
for i in range(7):box('templeStep',(0,-8+i*1.2,i*.55),(13-i*.65,1.3,.6),'light',temple)
box('templeAltar',(0,3,4.6),(10,8,2),'teal',temple)
sphere('templeLight',(0,3,7),1.2,'gold',temple)
box('templeInnerVisor',(0,14,23),(21,2,5),'dark',temple)
for x in [-5,0,5]:
    box('templeEyeH',(x,12.8,23),(1.7,.2,.45),'gold',temple)
    box('templeEyeV',(x,12.7,23),(.45,.2,1.7),'gold',temple)

# Hide local asset library from the continental inspection scene; it remains editable/exportable.
for name,col in ASSETS.items():
    if name!='body':col.hide_render=True;col.hide_viewport=True
# Inspectable two-metre size witness, no visible fake giant/human comparison image.
witness=asset('scaleWitness');box('Human_2m',(60000,0,1),(.5,.4,2),'teal',witness,0)
witness.hide_render=True;witness.hide_viewport=True
SCENE.world=bpy.data.worlds.new('CR_Sky');SCENE.world.color=(.65,.78,.80)
bpy.ops.object.camera_add(location=(150000,-245000,142000))
cam=bpy.context.object;cam.name='CR_OverviewCamera';cam.rotation_euler=(Vector((0,0,50000))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.type='ORTHO';cam.data.ortho_scale=140000;cam.data.clip_start=100;cam.data.clip_end=1000000;SCENE.camera=cam
bpy.ops.object.light_add(type='SUN',location=(0,0,150000));sun=bpy.context.object;sun.name='CR_Sun';sun.rotation_euler=(.45,-.45,-.45);sun.data.energy=2
SCENE.render.resolution_x=1500;SCENE.render.resolution_y=1200;SCENE.render.resolution_percentage=100
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type=='VIEW_3D':
            area.spaces.active.clip_start=100
            area.spaces.active.clip_end=1000000
            area.spaces.active.region_3d.view_distance=180000
            area.spaces.active.region_3d.view_location=(0,0,50000)
            area.spaces.active.shading.color_type='MATERIAL'
            area.spaces.active.region_3d.view_rotation=cam.rotation_euler.to_quaternion()
print(json.dumps({'scene':SCENE.name,'assets':{n:len(c.objects) for n,c in ASSETS.items()},'scale':[2,100000,50000]},ensure_ascii=False))
