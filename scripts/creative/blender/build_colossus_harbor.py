"""Authored harbor replacement, executed in Blender MCP. Metres; no gameplay changes.
Only owns the CH_ scene. Keeps the old colossus and user's other scenes intact.
"""
import bpy, math, json, random, os
from mathutils import Vector
from mathutils.geometry import tessellate_polygon
ROOT=os.path.abspath('/Users/muniao/.codex/worktrees/7c6b/MapleStory')
OUT=ROOT+'/resources/scenes/colossus/redesign'
CFG=json.load(open(ROOT+'/shared/colossus.json',encoding='utf-8'))
R=random.Random(260921)
if bpy.data.scenes.get('CH_HandpaintedHarbor'):
    raise RuntimeError('Inspect the existing CH_HandpaintedHarbor before rebuilding')
S=bpy.data.scenes.new('CH_HandpaintedHarbor');bpy.context.window.scene=S
S.unit_settings.system='METRIC';S.unit_settings.scale_length=1
COLS={};M={}
def collection(n):
    c=bpy.data.collections.new('CH_'+n);S.collection.children.link(c);COLS[n]=c;return c

def material(n,color,texture=None,scale=1):
    m=bpy.data.materials.new('CH_'+n);m.use_nodes=True;m.diffuse_color=(*color,1)
    shader=next(n for n in m.node_tree.nodes if n.type=='BSDF_PRINCIPLED')
    shader.inputs['Base Color'].default_value=(*color,1);shader.inputs['Roughness'].default_value=.9
    if texture:
        tex=m.node_tree.nodes.new('ShaderNodeTexImage');tex.image=bpy.data.images.load(ROOT+'/client/public-tms273/assets/colossus/'+texture+'.png',check_existing=True);tex.image.pack()
        m.node_tree.links.new(tex.outputs['Color'],shader.inputs['Base Color'])
    M[n]=m;return m
for n,c,t in [('stone',(.73,.68,.53),'redesign/limestone-painted'),('plaster',(.89,.79,.59),'handpainted-plaster'),('roof',(.64,.25,.13),'handpainted-roof'),('wood',(.36,.21,.10),'handpainted-timber'),('paving',(.76,.73,.60),None),('edge',(.87,.83,.67),None),('rockshade',(.43,.47,.39),None),('teal',(.16,.36,.39),None),('blue',(.12,.39,.63),None),('dark',(.09,.14,.14),None),('gold',(.83,.60,.22),None),('moss',(.33,.43,.15),None),('cream',(.95,.87,.64),None)]:material(n,c,t)

def xyz(p):return Vector((p[0],-p[2],p[1]))
def mesh(n,vs,fs,mat,col,uvscale=3):
    data=bpy.data.meshes.new('CH_'+n);data.from_pydata(vs,[],fs);data.update()
    o=bpy.data.objects.new('CH_'+n,data);col.objects.link(o);data.materials.append(M[mat])
    uv=data.uv_layers.new(name='PaintUV')
    for poly in data.polygons:
        normal=poly.normal;axis=list(map(abs,normal)).index(max(map(abs,normal)));axes=[k for k in range(3) if k!=axis]
        for li in poly.loop_indices:
            p=data.vertices[data.loops[li].vertex_index].co;uv.data[li].uv=(p[axes[0]]/uvscale,p[axes[1]]/uvscale)
    return o

def box(n,p,size,mat,col,bevel=.05,yaw=0,tilt=0):
    x,z,y=[s/2 for s in size]
    vs=[(-x,-y,-z),(x,-y,-z),(x,y,-z),(-x,y,-z),(-x,-y,z),(x,-y,z),(x,y,z),(-x,y,z)]
    o=mesh(n,vs,[(0,3,2,1),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7),(4,5,6,7)],mat,col)
    o.location=xyz(p);o.rotation_euler=(0,tilt,-yaw)
    if bevel:
        m=o.modifiers.new('Painted stone arris','BEVEL');m.width=min(min(size)*.2,bevel);m.segments=1
    return o

def beam(n,a,b,w,mat,col):
    a,b=xyz(a),xyz(b);o=box(n,(0,0,0),(w,(b-a).length,w),mat,col,.02)
    o.location=(a+b)/2;o.rotation_euler=(b-a).to_track_quat('Z','Y').to_euler();return o

def rock(n,p,size,col):
    o=box(n,p,size,'stone',col,min(size)*.13,yaw=R.uniform(-.22,.22))
    # Keep broad stone planes, break the exact cube outline and silhouette.
    for v in o.data.vertices:
        v.co.x+=R.uniform(-.08,.08)*size[0];v.co.y+=R.uniform(-.06,.06)*size[2];v.co.z+=R.uniform(-.04,.04)*size[1]
    return o

def polygon(n,points,top,bottom,mat,col):
    # Actual irregular shore surface, not a grid of grass caps.
    vs=[(x,-z,bottom) for x,z in points]+[(x,-z,top) for x,z in points];N=len(points)
    tris=tessellate_polygon([[Vector(p) for p in vs[N:]]])
    lookup={tuple(p):i+N for i,p in enumerate(vs[N:])}
    faces=[tuple(v+N if isinstance(v,int) else lookup[tuple(v)] for v in tri) for tri in tris]
    faces += [(i,(i+1)%N,(i+1)%N+N,i+N) for i in range(N)]
    return mesh(n,vs,faces,mat,col)

def house(col,c=(0,0,0),scale=1,yaw=0,variant=0):
    before=set(col.objects);x,h,z=c;w=7.0;d=5.4;wall=5.7 if variant%3==1 else 4.8
    box('houseFoot',(0,.2,0),(7.6,.4,6),'stone',col,.08)
    box('housePlaster',(0,wall/2+.4,0),(w,wall,d),'plaster',col,.1)
    for sx in [-1,1]:
        for k in range(int(wall/.8)):
            box('cornerQuoin',(sx*3.46,.8+k*.8,2.69),(.48,.55,.32),'edge',col,.05)
        for y in [1.3,3.45]:
            if y>wall-.4:continue
            wx=sx*2.08
            box('windowRecess',(wx,y+.55,2.75),(1.1,1.4,.18),'dark',col,.07)
            box('windowSill',(wx,y-.2,2.94),(1.5,.18,.52),'edge',col,.025)
            for ss in [-1,1]:
                box('paintedShutter',(wx+ss*.72,y+.54,2.88),(.37,1.4,.15),'teal',col,.03,yaw=ss*.15)
                for j in range(4):box('shutterSlat',(wx+ss*.72,y+.11+j*.28,2.99),(.35,.07,.07),'wood',col,.01)
            box('mullion',(wx,y+.55,2.91),(.07,1.35,.05),'wood',col,.01)
            box('mullion',(wx,y+.55,2.92),(1.0,.07,.05),'wood',col,.01)
    box('oakDoor',(0,1.55,2.79),(1.4,2.9,.16),'wood',col,.06)
    for sx in [-1,1]:box('doorSurround',(sx*.89,1.7,2.84),(.29,3.2,.28),'edge',col,.04)
    box('doorLintel',(0,3.36,2.84),(2.0,.35,.34),'edge',col,.04)
    box('doorStep',(0,.23,3.28),(2.3,.32,1.0),'stone',col,.08)
    box('handle',(.42,1.35,2.9),(.09,.25,.1),'gold',col,.02)
    # Solid gable, generous orange tile eaves and visible ridge caps.
    for zz in [-d/2,d/2]:
        mesh('gable',[(-w/2,-zz,wall+.4),(w/2,-zz,wall+.4),(0,-zz,wall+2.7)],[(0,1,2)],'plaster',col)
    for sx in [-1,1]:
        box('terracottaRoof',(sx*1.92,wall+1.55,0),(4.55,.25,6.5),'roof',col,.035,tilt=sx*.56)
        for j in range(9):
            beam('tileRib',(sx*.1,wall+2.72,-3.1+j*.77),(sx*3.81,wall+.34,-3.1+j*.77),.10,'roof',col)
    for j in range(10):box('ridgeCap',(0,wall+2.81,-3.0+j*.66),(.36,.22,.7),'roof',col,.09)
    box('chimney',(1.7,wall+2.3,-1.25),(.82,2.7,.85),'stone',col,.06)
    box('chimneyRim',(1.7,wall+3.65,-1.25),(1.08,.28,1.05),'edge',col,.03)
    box('chimneyHole',(1.7,wall+3.82,-1.25),(.63,.04,.60),'dark',col,0)
    if variant%2:
        for sx in [-1,1]:box('awningPost',(sx*2.1,1.55,4.8),(.14,3.1,.14),'wood',col,.025)
        for j in range(6):box('canvasAwning',(-1.84+j*.74,3.37,3.9),(.74,.12,2.6),'cream' if j%2 else 'gold',col,.02,tilt=0)
        box('marketCounter',(0,1.0,4.65),(3.8,1.1,.85),'wood',col,.04)
    for o in set(col.objects)-before:
        p=o.location.copy()*scale;o.location=(math.cos(yaw)*p.x-math.sin(yaw)*p.y,math.sin(yaw)*p.x+math.cos(yaw)*p.y,p.z)
        o.location+=xyz(c);o.rotation_euler.z+=yaw;o.scale*=scale

# Reusable varied building replaces the previous single box/teal roof everywhere.
lib=collection('house');house(lib,variant=1)
harbor=collection('harbor')
# Curving old quay behind the story pier; the sea approach stays completely open.
polygon('quayIsland',[(-4,7),(-40,29),(-91,38),(-153,19),(-207,-22),(-234,-76),(-212,-120),(-153,-138),(-86,-126),(-22,-85),(16,-43)],-1.0,-17,'stone',harbor)
# The illustration's stepped village climbs behind the route, leaving its walkable centre open.
for n,points,top in [
 ('fisherTerrace',[(8,-5),(16,-8),(28,-5),(39,-9),(43,-27),(26,-37),(9,-24)],.65),
 ('marketTerrace',[(26,-6),(41,-3),(48,-9),(52,-29),(33,-40),(23,-29)],5.15),
 ('lighthouseTerrace',[(54,-5),(72,-6),(84,-14),(80,-33),(66,-42),(53,-29)],12),
 ('upperVillage',[(78,-13),(92,-11),(112,-6),(125,-17),(115,-36),(97,-43),(83,-32)],15.65)]:
    polygon(n,points,top,-14,'stone',harbor)
    # Separate warm paving, thin edging; no continuous green cap.
    polygon(n+'Paving',[(x*.99,z*.99) for x,z in points],top+.035,top-.12,'paving',harbor)
    for i,(a,b) in enumerate(zip(points,points[1:]+points[:1])):
        d=math.hypot(b[0]-a[0],b[1]-a[1]);steps=max(1,int(d/3))
        for j in range(steps):
            f=(j+.5)/steps;px=a[0]+(b[0]-a[0])*f;pz=a[1]+(b[1]-a[1])*f
            if pz>-8:continue
            box('terraceCoping',(px,top+.22,pz),(d/steps-.09,.42,.85),'edge',harbor,.09,yaw=math.atan2(b[1]-a[1],b[0]-a[0]))
        for j in range(max(1,int(d/6))):
            f=(j+.5)/max(1,int(d/6));px=a[0]+(b[0]-a[0])*f;pz=a[1]+(b[1]-a[1])*f
            rock('cliffButtress',(px,-4,pz),(4.8,18,5.5),harbor)
for c,sz,variant,rot in [((18,.75,-16),1,0,.10),((34,5.25,-17),1.1,1,-.08),((60,12.1,-20),.88,0,.22),((86,15.8,-23),1.05,2,-.24),((106,15.8,-18),.94,1,.18),((-13,0,-22),1.1,0,.2),((-49,1,-3),1.25,1,.1),((-100,4,10),1,2,0),((-143,5,-3),1.2,1,-.2),((-182,4,-36),1.1,0,-.9),((-194,1,-85),1,2,-1.5),((-143,2,-112),1.3,1,2.8),((-80,1,-98),1.1,0,2.8)]:house(harbor,c,sz,rot,variant)
# Narrow illustrated blue-flag lighthouse: square masonry base, tiered gallery, lantern.
lx,ly,lz=72,12.1,-23
for y,w,h,mat in [(1.1,5.2,2.2,'stone'),(5.8,3.8,7.2,'plaster'),(9.4,4.3,.5,'teal'),(11.2,3.05,3.1,'plaster'),(13.0,4.4,.35,'edge'),(14.2,2.4,2.2,'dark'),(15.5,3.9,.45,'roof')]:box('lighthouse',(lx,ly+y,lz),(w,h,w),'{}'.format(mat),harbor,.09)
for xx in [-1.2,1.2]:
    for zz in [-1.2,1.2]:box('lanternFrame',(lx+xx,ly+14.25,lz+zz),(.14,2.2,.14),'gold',harbor,.02)
for y in [3.0,6.0,10.8]:box('towerWindow',(lx,ly+y,lz+1.94),(.65,1.3,.12),'dark',harbor,.08)
for xx in [-2.05,2.05]:
    for zz in [-2.05,2.05]:box('galleryPost',(lx+xx,ly+13.7,lz+zz),(.14,1.25,.14),'wood',harbor,.02)
for zz in [-2.05,2.05]:box('galleryRail',(lx,ly+14.0,lz+zz),(4.2,.12,.12),'wood',harbor,.02)
for xx in [-2.05,2.05]:box('galleryRail',(lx+xx,ly+14.0,lz),(.12,.12,4.2),'wood',harbor,.02)
box('flagPole',(lx,ly+18,lz),(.15,5,.15),'wood',harbor,.025)
flag=mesh('blueFlag',[(lx,-lz,ly+20.3),(lx+3,-lz+.2,ly+20),(lx+2.5,-lz-.1,ly+18.8),(lx,-lz,ly+19.0)],[(0,1,2,3)],'blue',harbor);flag.data.materials[0].surface_render_method=flag.data.materials[0].surface_render_method
# A working timber pier: transverse planks, piles, rope and a lower fishing platform.
for i in range(30):box('dockPlank',(i*.52,-.17,0),(.49,.32,4.7),'wood',harbor,.025)
for x in [0,4,8,12,15]:
    for z in [-2.42,2.42]:
        box('dockPile',(x,-2.3,z),(.43,6.6,.43),'wood',harbor,.045)
        box('pileCap',(x,1.06,z),(.62,.15,.62),'edge',harbor,.04)
        for y in [.32,.44,.56]:box('ropeBinding',(x,y,z),(.5,.065,.5),'cream',harbor,.025)
for z in [-2.42,2.42]:
    for x in [0,4,8,12]:
        a=(x,1,z);mid=(x+2,.55,z);b=(x+4,1,z);beam('dockRope',a,mid,.065,'cream',harbor);beam('dockRope',mid,b,.065,'cream',harbor)
for i in range(14):box('fishingDock',(-10+i*.55,-.4,6),(.52,.3,4),'wood',harbor,.025)
for x in [-10,-6,-3]:
    for z in [4,8]:box('fishingPile',(x,-2.7,z),(.35,6,.35),'wood',harbor,.03)
# Cargo, net drying frames, coiled rope and fish-market tables are readable at player scale.
for x,y,z in [(7,0,-1.6),(9,0,-1.7),(11,0,-1.7),(-8,0,5),(27,5.3,-8),(89,15.8,-14)]:
    box('cargoCrate',(x,y+.48,z),(.95,.96,.9),'wood',harbor,.03)
    for off in [-.32,.32]:box('crateBinding',(x+off,y+.49,z+.46),(.065,.94,.035),'edge',harbor,.01)
    beam('crateDiagonal',(x-.4,y+.08,z+.48),(x+.4,y+.87,z+.48),.07,'wood',harbor)
for x,y,z in [(20,.8,-8),(-20,0,9),(-77,3,15)]:
    for xx in [-2,2]:box('netPost',(x+xx,y+1.7,z),(.15,3.4,.15),'wood',harbor,.02)
    beam('netTop',(x-2,y+3.3,z),(x+2,y+3.3,z),.11,'wood',harbor)
    for j in range(9):beam('fishingNet',(x-2+j*.5,y+3.15,z),(x-2+j*.5,y+.8+abs(j-4)*.07,z+.15),.018,'cream',harbor)
    for j in range(6):beam('fishingNet',(x-2,y+1+j*.4,z),(x+2,y+1+j*.4,z),.018,'cream',harbor)
# Coastal boulders are composed in small asymmetrical groups, not spread over a square grid.
for x,z in [(16,9),(-20,28),(-63,45),(-113,46),(-166,28),(-226,-30),(-245,-77),(123,6),(103,18),(78,12),(50,14)]:
    for j in range(3):rock('tidalRock',(x+R.uniform(-3,3),-5.5+R.random()*2,z+R.uniform(-3,3)),(4+R.random()*4,7+R.random()*6,3+R.random()*4),harbor)
# Ground foliage comes from the existing licensed library, never procedural plant meshes.
VEG={}
for n in ['tree','bush','grass','flowers']:
    bpy.ops.object.select_all(action='DESELECT');bpy.ops.import_scene.gltf(filepath=OUT+'/models/'+n+'.glb')
    objects=list(bpy.context.selected_objects)
    VEG[n]=[o for o in objects if o.type=='MESH']
    for o in objects:
        for c in list(o.users_collection):c.objects.unlink(o)

def plant(n,p,scale,col):
    for src in VEG[n]:
        o=src.copy();o.data=src.data;col.objects.link(o);o.location=xyz(p)+src.location*scale;o.scale=src.scale*scale;o.rotation_euler.z+=R.random()*6.28
        o['source']='Kenney Nature Kit CC0, original mesh';o['plant_group']=n
# Deliberately clustered olives/oaks and low scrub between masonry, never across the rail.
for x,y,z,scale in [(13,1,-26,1.1),(39,5.2,-31,1.05),(54,12,-30,1.25),(78,12,-32,1.05),(98,15.8,-33,1.2),(118,15.8,-27,1.1),(-24,0,-21,1.25),(-71,2,-7,1.4),(-127,4,-10,1.4),(-183,3,-55,1.2),(-179,1,-105,1.4),(-78,0,-83,1.5)]:
    plant('tree',(x,y,z),scale,harbor)
    for j in range(5):plant('bush',(x+R.uniform(-5,5),y,z+R.uniform(-3,3)),R.uniform(.8,1.5),harbor)
    for j in range(4):plant('flowers',(x+R.uniform(-4,4),y+.1,z+R.uniform(-3,3)),R.uniform(.8,1.3),harbor)
for x,y,z in [(11,.7,-7),(27,5.2,-7),(57,12,-6),(85,15.7,-13),(111,15.7,-9)]:
    for j in range(6):plant('bush',(x+j*.7,y,z),.55+R.random()*.3,harbor)
# Other districts: cliff ribbons with changing silhouettes support the existing rails.
# They replace repeated grass tiles while keeping authority and route junctions unchanged.
for name,region in CFG['regions'].items():
    if name=='harbor':continue
    col=collection(name)
    tracks=[(n,t) for n,t in CFG['tracks'].items() if t['region']==name and n!='climb']
    for key,t in tracks:
        pts=t['points'];acc=0
        for i,(a,b) in enumerate(zip(pts,pts[1:])):
            a,b=Vector(a),Vector(b);delta=b-a;length=delta.length;side=Vector((-delta.z,0,delta.x)).normalized()
            cuts=max(1,int(length/10))
            for j in range(cuts):
                f=(j+.5)/cuts;p=a.lerp(b,f);w=R.uniform(12,18);deep=R.uniform(10,18)
                rock('bodyCliff',(p.x,p.y-deep/2-.7,p.z),(length/cuts+2,deep,w),col).rotation_euler.z=-math.atan2(delta.z,delta.x)
                if j%2==0:
                    q=p+side*(w*.42);plant('bush',(q.x,p.y-.55,q.z),R.uniform(.8,1.6),col)
                    plant('flowers',(q.x+1,p.y-.3,q.z),1.1,col)
                if (i*3+j)%7==0:
                    q=p-side*6;plant('tree',(q.x,p.y-.65,q.z),R.uniform(.9,1.2),col)
            acc+=length
    if name=='town':
        pts=CFG['tracks'][region['home']]['points']
        for i,p in enumerate(pts[::2]):house(col,(p[0],p[1],p[2]-10),1.1,i*.25,i)
# Keep material/UV use traceable; all source images packed in editable .blend.
S['visual_reference']='colossus-map-stage-3/4-colossus-revealed-v4; actual scene overhaul 2026-09-21'
S['source_note']='Existing generated hand-painted textures; unchanged Kenney Nature Kit CC0 vegetation; authored stone/architecture'
S.world=bpy.data.worlds.new('CH_Sky');S.world.use_nodes=True
bg=next(n for n in S.world.node_tree.nodes if n.type=='BACKGROUND');bg.inputs['Color'].default_value=(.65,.78,.79,1);bg.inputs['Strength'].default_value=.8
bpy.ops.object.camera_add(location=(80,-125,72));cam=bpy.context.object;cam.name='CH_HarborCamera';cam.rotation_euler=(xyz((47,8,-8))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.type='ORTHO';cam.data.ortho_scale=143;cam.data.clip_end=2000;S.camera=cam
bpy.ops.object.light_add(type='SUN',location=(0,-50,150));sun=bpy.context.object;sun.name='CH_Sun';sun.rotation_euler=(.45,-.45,-.4);sun.data.energy=2.0;sun.data.angle=.08
for n,c in COLS.items():c.hide_render=n!='harbor';c.hide_viewport=n!='harbor'
S.render.resolution_x=1600;S.render.resolution_y=1000;S.render.resolution_percentage=100
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type=='VIEW_3D':
            space=area.spaces.active;space.clip_start=.1;space.clip_end=4000;space.region_3d.view_distance=150;space.region_3d.view_location=xyz((42,8,-8));space.region_3d.view_rotation=cam.rotation_euler.to_quaternion();space.shading.color_type='MATERIAL'
os.makedirs(OUT+'/previews',exist_ok=True)
print(json.dumps({'scene':S.name,'collections':{n:len(c.objects) for n,c in COLS.items()},'mesh_count':sum(o.type=='MESH' for o in S.objects)},ensure_ascii=False))

# Detail pass, also usable independently on the authored CH_ scene.
col=COLS['harbor']
# Warm, restrained paint: explicit multiplication instead of whitening under the sun.
for name,tint in [('stone',(.72,.66,.53,1)),('plaster',(.92,.81,.62,1)),('wood',(.62,.44,.27,1)),('roof',(.72,.52,.39,1))]:
    mat=M[name];nodes=mat.node_tree.nodes;bs=next(n for n in nodes if n.type=='BSDF_PRINCIPLED')
    source=bs.inputs['Base Color'].links[0].from_socket
    mix=nodes.new('ShaderNodeMixRGB');mix.blend_type=next(i.identifier for i in mix.bl_rna.properties['blend_type'].enum_items if i.identifier=='MULTIPLY')
    mix.inputs[0].default_value=1;mix.inputs[2].default_value=tint
    mat.node_tree.links.new(source,mix.inputs[1]);mat.node_tree.links.new(mix.outputs[0],bs.inputs['Base Color'])
# Ground-cover islands have organic contours and leave the stone street exposed.
for x,h,z,w,d in [(16,.71,-24,15,12),(36,5.21,-27,13,9),(63,12.07,-30,21,12),(99,15.72,-31,25,13),(-55,-.93,-9,30,14),(-135,-.93,-26,48,17),(-171,-.93,-67,36,32),(-80,-.93,-78,60,30)]:
    points=[]
    for j in range(13):
        a=j*math.tau/13;r=R.uniform(.75,1)
        points.append((x+math.cos(a)*w*.5*r,z+math.sin(a)*d*.5*r))
    polygon('irregularMeadow',points,h,h-.08,'moss',col)
# Horizontal broken masonry courses give retaining walls real scale and shadows.
for x,h,z,width in [(15,.7,-6,11),(34,5.2,-7,16),(67,12,-6,18),(99,15.7,-12,25)]:
    for row in range(3):
        for j in range(int(width/1.8)):
            px=x-width/2+j*1.8+(row%2)*.4
            box('wallCourse',(px,h-.6-row*.95,z), (1.7,.82,.55),'edge' if (row+j)%4 else 'stone',col,.09)
# Stair treads use the same route and open gaps as the authoritative movement.
pts=CFG['tracks']['harbor']['points'];distance=0.
for aa,bb in zip(pts,pts[1:]):
    a,b=Vector(aa),Vector(bb);delta=b-a;length=delta.length
    cuts=sorted(set([0.,length]+[max(0.,min(length,s-distance)) for gap in CFG['gaps'] for s in gap]+[max(0.,min(length,15.-distance))]))
    for lo,hi in zip(cuts,cuts[1:]):
        mid=distance+(lo+hi)*.5
        if hi-lo<.01 or mid<15. or any(g[0]<mid<g[1] for g in CFG['gaps']):continue
        count=max(1,int((hi-lo)/.65))
        for j in range(count):
            along=lo+(j+.5)*(hi-lo)/count;p=a.lerp(b,along/length)
            box('pierStoneStair',p-Vector((0,.095,0)),((hi-lo)/count-.015,.19,4.1),'edge',col,.025,yaw=math.atan2(delta.z,delta.x))
    distance+=length
# A warmer cliff foot avoids unbroken white slabs at the shoreline.
for o in list(col.objects):
    if o.name.startswith('CH_cliffButtress'):
        o.location.z+=R.uniform(-1.1,1.1)
        if R.random()<.28:o.data.materials[0]=M['rockshade']
# Dense existing bush meshes form ivy and low scrub, with separate flower heads.
sources={}
for o in col.objects:
    n=o.get('plant_group')
    if n and n not in sources:sources[n]=o
for x,h,z in [(17,.8,-5),(36,5.2,-7),(58,12,-5),(76,12,-10),(94,15.8,-11),(115,15.8,-9)]:
    for j in range(10):
        src=sources['bush'];o=src.copy();o.data=src.data;col.objects.link(o);o.location=xyz((x+R.uniform(-3,3),h-j*.25,z+R.uniform(-.3,.3)));o.scale=(.6,.6,.6)
# House flower boxes, working-yard benches and tidy lamps, all clear of the rail.
for x,h,z in [(18,.8,-16),(34,5.3,-17),(86,15.8,-23),(106,15.8,-18)]:
    box('windowPlanter',(x-2,h+1.0,z+3.3),(1.65,.38,.5),'wood',col,.035)
    for j in range(3):
        src=sources['flowers'];o=src.copy();o.data=src.data;col.objects.link(o);o.location=xyz((x-2.5+j*.45,h+1.2,z+3.3));o.scale=(.85,.85,.85)
for x,h,z in [(22,1,-3.0),(40,7,-3.0),(72,12,-6.0),(99,16,-7.0)]:
    box('streetPost',(x,h+2,z),(.13,4,.13),'wood',col,.03)
    box('lantern',(x,h+3.8,z),(.52,.72,.52),'gold',col,.03)
    box('lanternCap',(x,h+4.22,z),(.72,.16,.72),'teal',col,.04)
for o in col.objects:
    if o.type=='MESH':
        for p in o.data.polygons:
            if o.name.startswith('CH_irregularMeadow') and p.normal.z<-.9:p.flip()
        o.data.update()
print('Added masonry courses, fitted stairs, warm paint, ground-cover shapes, ivy, flowers and lamps')

# Local climb face shares the shin anchor used by the route.
col=bpy.data.collections.new('CH_climb-rock');S.collection.children.link(col)
rock('kneeCliff',(-21388,30094,-10),(25,52,15),col)
for row in range(8):
    for j in range(4):
        rock('kneeMasonry',(-21401+j*7+(row%2)*1.2,30076+row*5.0,-3.2),(6.7,4.8,2.0),col)
for j in range(6):rock('ledge',(-21405+j*5,30111,-1),(5.1,3.0,5.0),col)
src=next(o for o in bpy.data.collections['CH_harbor'].objects if o.get('plant_group')=='bush')
for j in range(24):
    o=src.copy();o.data=src.data;col.objects.link(o);o.location=xyz((-21403+(j%8)*3.2,30112-(j//8)*2.0,-2.5));o.scale=(.8,.8,.8)
bpy.ops.object.select_all(action='DESELECT')
for o in col.objects:o.select_set(True)
bpy.context.view_layer.objects.active=next(iter(col.objects))
bpy.ops.export_scene.gltf(filepath='/Users/muniao/.codex/worktrees/7c6b/MapleStory/resources/scenes/colossus/redesign/models/climb-rock.glb',use_selection=True,use_active_scene=True,export_extras=True,export_apply=True)
col.hide_viewport=col.hide_render=True
bpy.ops.wm.save_as_mainfile(filepath='/Users/muniao/.codex/worktrees/7c6b/MapleStory/resources/scenes/colossus/redesign/models/handpainted_harbor.blend')
print('Climb face and upper ledge exported')

# The town is a volume: a back street, a roof circuit and seaward floating gardens.
col=bpy.data.collections['CH_harbor']
if S.get('vertical_town_complete'):raise RuntimeError('Vertical town already exists; inspect it before editing')
for name in ['harbor-street','harbor-roofs','harbor-skywalk']:
    pts=CFG['tracks'][name]['points']
    floating=name!='harbor-street'
    for i,p in enumerate(pts[1:-1]):
        x,h,z=p;w=8.5 if floating else 7.0;d=7.0
        outline=[(x-w*.5,z-d*.35),(x-w*.3,z-d*.55),(x+w*.4,z-d*.48),(x+w*.55,z),(x+w*.35,z+d*.48),(x-w*.4,z+d*.5)]
        polygon(name+'Platform',outline,h-.06,h-(2.2 if floating else 3.5),'stone',col)
        polygon(name+'Paving',outline,h-.025,h-.1,'paving',col)
        # Chipped hanging ledges, not vertical pillars extending to the sea.
        for j in [-1,1]:rock('floatingStone',(x+j*w*.22,h-1.7,z-1.0),(w*.47,2.4,d*.72),col)
        if floating:
            for j in [-1,1]:
                box('platformCoping',(x+j*3.7,h+.16,z),( .48,.36,4.2),'edge',col,.08)
            box('hangingTrim',(x,h-.7,z+3.45),(5.8,.25,.24),'teal',col,.04)
    for i,(a,b) in enumerate(zip(pts,pts[1:])):
        a,b=Vector(a),Vector(b);delta=b-a;length=delta.length;N=max(1,int(length/.62));theta=math.atan2(delta.z,delta.x);side=Vector((-delta.z,0,delta.x)).normalized()
        for j in range(N):
            p=a.lerp(b,(j+.5)/N)
            plank=box('suspendedPlank' if floating else 'streetPaving',p-Vector((0,.10,0)),(length/N-.035,.22,3.7),'wood' if floating else 'edge',col,.025,yaw=theta)
        if floating:
            # Fitted structural beams and rope rails explain how each level connects.
            for sign in [-1,1]:
                aa=a+side*1.5-Vector((0,.4,0));bb=b+side*1.5-Vector((0,.4,0));beam('bridgeStringer',aa,bb,.24,'wood',col)
                posts=max(2,int(length/3.8))
                for j in range(posts+1):
                    p=a.lerp(b,j/posts)+side*1.7;box('bridgePost',p+Vector((0,.6,0)),(.13,1.35,.13),'wood',col,.025)
                    if j:
                        q=a.lerp(b,(j-1)/posts)+side*1.7
                        beam('handRope',q+Vector((0,1.05,0)),p+Vector((0,1.05,0)),.055,'cream',col)
# More intimate street corners and a small workshop between existing homes.
house(col,(44,7.25,-17.6),.84,.12,1)
house(col,(92,26.0,-40.5),.6,-.18,0)
# Canopy terraces have real front/back offsets and places to pause, not a staircase in a single plane.
sources={}
for o in col.objects:
    n=o.get('plant_group')
    if n and n not in sources:sources[n]=o
for x,h,z in [(43,16,-29),(57,21,-35),(74,24,-39),(92,26,-35),(73,20,17),(62,24,27),(45,22,24),(29,16,17)]:
    # A small flower garden and tree stand aside from the walkable centre.
    for j in range(4):
        src=sources['bush'];o=src.copy();o.data=src.data;col.objects.link(o);o.location=xyz((x-2.8+j*.65,h,z-2.5));o.scale=(.72,.72,.72)
        src=sources['flowers'];o=src.copy();o.data=src.data;col.objects.link(o);o.location=xyz((x-2.7+j*.65,h+.08,z-2.0));o.scale=(.9,.9,.9)
    if x in [57,74,62,29]:
        src=sources['tree'];o=src.copy();o.data=src.data;col.objects.link(o);o.location=xyz((x+2.5,h,z-2.2));o.scale=(.72,.72,.72)
    box('terraceBench',(x,h+.55,z-2.6),(2.5,.18,.65),'wood',col,.035)
    for xx in [-.9,.9]:box('benchLeg',(x+xx,h+.25,z-2.6),(.18,.5,.4),'wood',col,.02)
    box('wayLamp',(x-3.1,h+1.65,z+1.5),(.12,3.3,.12),'wood',col,.03)
    box('wayLantern',(x-3.1,h+3.3,z+1.5),(.5,.6,.5),'gold',col,.04)
for o in col.objects:
    if o.type=='MESH' and ('Platform' in o.name or 'Paving' in o.name):
        for p in o.data.polygons:
            if p.normal.z<-.9:p.flip()
        o.data.update()
S['vertical_town_complete']=True
print('Three traversable town circuits: back street, roof promenade, seaward suspended gardens')

# Final canopy paint and runtime exports.
import bpy,json
s=bpy.data.scenes['CH_HandpaintedHarbor'];bpy.context.window.scene=s
root='/Users/muniao/.codex/worktrees/7c6b/MapleStory/resources/scenes/colossus/redesign/'
mat=bpy.data.materials.new('CH_FoliageCanopy');mat.use_nodes=True
bs=next(n for n in mat.node_tree.nodes if n.type=='BSDF_PRINCIPLED');bs.inputs['Roughness'].default_value=.95
tex=mat.node_tree.nodes.new('ShaderNodeTexImage');tex.image=bpy.data.images.load(root+'textures/foliage-canopy-painted.png',check_existing=True);tex.image.pack()
mat.node_tree.links.new(tex.outputs['Color'],bs.inputs['Base Color'])
for o in s.objects:
    if o.type=='MESH' and o.get('plant_group'):
        for i,m in enumerate(o.data.materials):
            if m and m.name.startswith('CR_grass'):o.data.materials[i]=mat
# Export sources contain separate editable objects; the client already batches static meshes.
results={}
for n in ['house','harbor','town','coast','heights','shoulder','gardens','climb-rock']:
    col=bpy.data.collections['CH_'+n];col.hide_viewport=False
    bpy.ops.object.select_all(action='DESELECT')
    for o in col.objects:o.select_set(True)
    bpy.context.view_layer.objects.active=next(iter(col.objects))
    filename='harbor-house' if n=='house' else n if n=='climb-rock' else 'landscape-'+n
    bpy.ops.export_scene.gltf(filepath=root+'models/'+filename+'.glb',use_selection=True,use_active_scene=True,export_extras=True,export_apply=True)
    col.hide_viewport=n!='harbor';results[n]=len(col.objects)
bpy.ops.wm.save_as_mainfile(filepath=root+'models/handpainted_harbor.blend')
print(json.dumps(results))
