"""Second Blender MCP step: nested box detail, generated textures and export.
Run after build_colossus_redesign.py. Does not touch scenes outside CR_.
"""
import bpy, math, json, random
from mathutils import Vector
SCENE=bpy.data.scenes['CR_Colossus_100km']
bpy.context.window.scene=SCENE
RNG=random.Random(260920)
ROOT='/Users/muniao/Code/MapleStory/resources/scenes/colossus/redesign/'
MATS={m.name.removeprefix('CR_'):m for m in bpy.data.materials if m.name.startswith('CR_')}
ASSETS={n:bpy.data.collections['CR_'+n] for n in ['body','hand','forearm','house','heart','temple']}
if SCENE.get('nested_detail_complete'):raise RuntimeError('Detail already applied; inspect before rerunning.')
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
        box(name+'forest'+str(i),(px,py,z+.014*w),(w*(.10+RNG.random()*.14),d*.14,w*.014),'leaf' if i%2 else 'grass',col,.18)


# Remove only this task's superseded vegetation prototypes.
for name in ['CR_tree','CR_flowers']:
    col=bpy.data.collections.get(name)
    if col:
        for obj in list(col.objects):bpy.data.objects.remove(obj,do_unlink=True)
        bpy.data.collections.remove(col)
# Generated raster texture supplies the fine paint detail; geometry supplies the silhouette.
for names,filename in [(['stone','light','shade'],'limestone-painted.png'),(['grass','leaf'],'grass-painted.png')]:
    image=bpy.data.images.load(ROOT+'textures/'+filename,check_existing=True)
    image.pack()
    for name in names:
        mat=MATS[name];nodes=mat.node_tree.nodes
        tex=nodes.new('ShaderNodeTexImage');tex.image=image
        shader=next(n for n in nodes if n.type=='BSDF_PRINCIPLED')
        mat.node_tree.links.new(tex.outputs['Color'],shader.inputs['Base Color'])
# Smaller masonry plates sit on large structural blocks, rather than drawing fake bumps.
body=ASSETS['body']
for sign in [-1,1]:
    for row in range(3):
        for col in range(3):
            x=sign*12600+(col-1)*6750;z=65500+row*5400
            box('breastMasonry',(x,-16800-(row%2)*130,z),(6510,1000,5120),'light' if (row+col)%3 else 'stone',body,.06)
    for z in [15500,22100,27700]:
        for i in range(3):box('shinMasonry',(sign*14500+(i-1)*5050,-10100,z),(4800,900,5200),'light',body,.08)
    for z in [52000,57700,63600]:
        box('armMasonry',(sign*35000,-9200,z),(16000,1300,5100),'light',body)
    # Geographic steps around the shoulder; no individual giant trees or giant houses.
    for i in range(8):
        x=sign*34200-10300+i*2900;y=-9500+(i%3)*850
        box('shoulderLedge',(x,y,85700+(i%2)*230),(3900,5300,1700),'stone',body,.08)
        box('shoulderLedgeGreen',(x,y,86600+(i%2)*230),(3600,5200,270),'grass',body,.12)
    for i in range(6):
        box('bootMasonry',(sign*14500-7700+i*3100,-17700,6900+(i%2)*130),(2800,1300,5300),'light',body,.08)
# A thousand-metre relief is made of successively smaller stone blocks.
for i in range(14):
    x=-12500+i*1900
    box('crownCourse',(x,-9900,95400+(i%3)*100),(1750,1800,2100),'light',body,.08)
for sign in [-1,1]:
    for i in range(5):box('jawCourse',(sign*(1500+i*2200),-12800,82800),(2100,2500,2000),'light',body,.07)
# Correctly put a distal finger below the near-port route, not the gap between fingers.
for obj in ASSETS['hand'].objects:
    obj.location.y-=2400
    if obj.name.startswith('CR_fingerDistal'):
        for mod in obj.modifiers:
            if mod.type=='BEVEL':mod.width=4
for i in range(8):
    box('palmMasonry',(15500+i%4*3300,-7600+i//4*9900,-400),(3050,4300,600),'light',ASSETS['hand'],.03)
# Editable full-body inspection pose uses linked geometry from the separately exported hand.
pose=bpy.data.collections.new('CR_InspectionPose');SCENE.collection.children.link(pose)
for obj in ASSETS['hand'].objects:
    copy=obj.copy();copy.data=obj.data;copy.name='CR_pose_'+obj.name;pose.objects.link(copy)
    copy.location+=Vector((-75205,-8060,44978))
bar('poseForearm',(-35000,800,57500),(-47955,-8060,41978),12000,12000,'stone',pose)
# Close-range library: smaller blocks and repeated trim carry depth at two-metre player scale.
for sign in [-1,1]:
    for i in range(5):box('houseQuoin',(sign*3.16,-2.72,.7+i*.86),(.48,.40,.7),'stone',ASSETS['house'],.1)
for i in range(8):
    a=i*math.tau/8;cx=math.cos(a)*8;cz=16+math.sin(a)*8
    box('heartInset',(cx,-2.65,cz),(3,.35,3),'teal',ASSETS['heart'],.1,rot=(0,-a,0))
    spiral('heartGlyph',(cx,-2.9,cz),2,ASSETS['heart'])
for x in [-22,-11,11,22]:
    for y in [-11,11]:
        for z in [1.8,7,13,19,24.5]:
            box('templeCourse',(x,y,z),(3.5,3.5,.65),'teal' if z==7 or z==19 else 'stone',ASSETS['temple'])
        for z in [5,10.5,16.5,22]:
            box('templeFace',(x,y-1.7,z),(2.5,.45,3.8),'light',ASSETS['temple'])
        spiral('templeGlyph',(x,y-1.97,12.5),1.5,ASSETS['temple'])
# Reusable raised terrace: authored in Blender from large body and smaller courses.
terrace=bpy.data.collections.new('CR_terrace');SCENE.collection.children.link(terrace);ASSETS['terrace']=terrace
box('terraceBody',(0,0,-3),(12,10,6),'stone',terrace)
for i in range(4):
    for row in range(2):
        box('terraceFace',(-4.5+i*3,-5.1,-1.3-row*2.7),(2.85,.5,2.5),'light',terrace,.09)
box('terraceCap',(0,0,-.12),(12.3,10.3,.3),'grass',terrace,.12)
for i in range(6):box('terraceLip',(-5+i*2,-4.8,.05),(1.8,.9,.5),'grass',terrace,.13)
SCENE['nested_detail_complete']=True
SCENE.camera.data.clip_start=100
SCENE.world.use_nodes=True
worldShader=next(n for n in SCENE.world.node_tree.nodes if n.type=='BACKGROUND')
worldShader.inputs['Color'].default_value=(.72,.83,.86,1)
worldShader.inputs['Strength'].default_value=.8
for name,col in ASSETS.items():
    col.hide_render=name!='body';col.hide_viewport=name!='body'
bpy.ops.wm.save_as_mainfile(filepath=ROOT+'models/colossus_100km.blend')
SCENE.render.filepath=ROOT+'previews/colossus-overview.png'
SCENE.render.image_settings.file_format='PNG'
SCENE.render.resolution_x=1400;SCENE.render.resolution_y=1200
bpy.ops.render.render(write_still=True)
print(json.dumps({'assets':{n:len(c.objects) for n,c in ASSETS.items()},'saved':bpy.data.filepath}))
