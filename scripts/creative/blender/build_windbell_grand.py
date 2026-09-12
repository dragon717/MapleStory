"""Concept -> reviewed engineering views -> saved whitebox -> image-textured 3D.
Executed only through official Blender MCP; STAGE is supplied by the client.
Blender and GLB deliberately use X right / Y up / Z toward camera.
"""
import bpy, bmesh, math, random, json
from mathutils import Vector
ROOT='/Users/muniao/Library/Mobile Documents/com~apple~CloudDocs/游戏/github/MapleStory'
OUT=ROOT+'/resources/blender/windbell'

random.seed(9313)
COLORS={'bark':(.27,.18,.095,1),'wood':(.5,.34,.16,1),'stone':(.38,.44,.44,1),'grass':(.32,.47,.15,1),'leaf':(.3,.46,.12,1),'leaflight':(.58,.65,.21,1),'leafdark':(.1,.25,.14,1),'gold':(.73,.46,.13,1),'water':(.23,.58,.69,1),'cloud':(.79,.86,.89,1),'roof':(.23,.40,.32,1),'glow':(1,.69,.23,1),'farstone':(.68,.78,.8,1)}
MATS={}
CTX={}
LAYERS={}
def mat(role):
    if role in MATS:return MATS[role]
    m=bpy.data.materials.new('Grand_'+role);m.diffuse_color=(.65,.67,.65,1);m.use_nodes=True
    m.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value=m.diffuse_color
    m.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value=.84
    m['role']=role;MATS[role]=m;return m

def objmesh(name,verts,faces,role,layer='middle',parent=None):
    me=bpy.data.meshes.new(name);me.from_pydata(verts,[],faces);me.update()
    bm=bmesh.new();bm.from_mesh(me);bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));bm.to_mesh(me);bm.free()
    ob=bpy.data.objects.new(name,me);CTX['scene'].collection.objects.link(ob);ob.data.materials.append(mat(role));ob['role']=role
    ob.parent=parent if parent else LAYERS[layer]
    return ob

def empty(name,loc=(0,0,0),layer='middle',motion=None):
    o=bpy.data.objects.new(name,None);CTX['scene'].collection.objects.link(o);o.location=loc;o.parent=LAYERS[layer]
    if motion:o['motion']=motion
    return o

def box(name,c,s,role,layer='middle',parent=None):
    x,y,z=c;a,b,h=[v/2 for v in s]
    return objmesh(name,[(x+i*a,y+j*b,z+k*h) for k in [-1,1] for j in [-1,1] for i in [-1,1]],[(0,1,3,2),(4,6,7,5),(0,4,5,1),(2,3,7,6),(0,2,6,4),(1,5,7,3)],role,layer,parent)

def tube(name,points,radii,role='bark',layer='middle',parent=None,sides=12):
    verts=[]
    for i,p in enumerate(points):
        tangent=Vector(points[min(i+1,len(points)-1)])-Vector(points[max(0,i-1)])
        tangent.normalize();u=tangent.cross(Vector((0,0,1)))
        if u.length<.1:u=tangent.cross(Vector((0,1,0)))
        u.normalize();v=tangent.cross(u).normalized()
        for j in range(sides):
            angle=j*math.tau/sides;radius=radii[i]*(1+.08*math.sin(j*5+i))
            verts.append(Vector(p)+radius*(math.cos(angle)*u+math.sin(angle)*v))
    faces=[tuple(range(sides-1,-1,-1))]
    for i in range(len(points)-1):
        for j in range(sides):a=i*sides+j;b=i*sides+(j+1)%sides;faces.append((a,b,b+sides,a+sides))
    faces.append(tuple(range((len(points)-1)*sides,len(points)*sides)))
    return objmesh(name,verts,faces,role,layer,parent)

def ellipsoid(name,c,s,role,layer='background',parent=None,segments=12,rings=7):
    verts=[]
    for i in range(rings+1):
        phi=math.pi*i/rings
        for j in range(segments):
            theta=math.tau*j/segments;verts.append((c[0]+s[0]*math.sin(phi)*math.cos(theta),c[1]+s[1]*math.cos(phi),c[2]+s[2]*math.sin(phi)*math.sin(theta)))
    faces=[]
    for i in range(rings):
        for j in range(segments):a=i*segments+j;b=i*segments+(j+1)%segments;faces.append((a,b,b+segments,a+segments))
    return objmesh(name,verts,faces,role,layer,parent)

def leaves(name,c,scale,layer='background',count=150):
    rig=empty(name,c,layer,'sway');verts=[];faces=[]
    for i in range(count):
        a=random.uniform(0,math.tau);r=math.sqrt(random.random());xx=math.cos(a)*r*scale[0];yy=math.sin(a)*r*scale[1];zz=random.uniform(-1,1)*scale[2]
        ang=random.uniform(-1,1);length=random.uniform(18,42)*(scale[0]/280)**.3;width=length*.43
        ux,uy=math.cos(ang)*length,math.sin(ang)*length;vx,vy=-math.sin(ang)*width,math.cos(ang)*width
        n=len(verts);verts.extend([(xx-ux,yy-uy,zz),(xx+vx,yy+vy,zz+8),(xx+ux,yy+uy,zz),(xx-vx,yy-vy,zz+8),(xx,yy,zz+14)]);faces.extend([(n,n+1,n+4),(n+1,n+2,n+4),(n+2,n+3,n+4),(n+3,n,n+4)])
    o=objmesh(name+'_leaves',verts,faces,'leaf',layer,rig)
    o.data.materials.append(mat('leaflight'));o.data.materials.append(mat('leafdark'))
    for p in o.data.polygons:p.material_index=random.choices([0,1,2],[5,2,2])[0]
    return rig

def cliff(name,x1,x2,y1,y2,thick,z=-90,depth=270,layer='middle'):
    # Serrated polygonal rock mass, with a continuous exact top line.
    n=max(5,int((x2-x1)/90));xs=[x1+(x2-x1)*i/n for i in range(n+1)];verts=[]
    for zz in [z-depth/2,z+depth/2]:
        for bottom in [False,True]:
            for i,x in enumerate(xs):
                top=y1+(y2-y1)*i/n;verts.append((x,top-(thick*random.uniform(.65,1.2) if bottom else 0),zz+random.uniform(-18,18)))
    m=n+1;faces=[]
    for i in range(n):faces.extend([(i,i+1,2*m+i+1,2*m+i),(i+m,i+m+1,3*m+i+1,3*m+i),(2*m+i,2*m+i+1,3*m+i+1,3*m+i),(i,m+i,m+i+1,i+1)])
    faces.extend([(0,2*m,3*m,m),(n,n+m,n+3*m,n+2*m)])
    o=objmesh(name,verts,faces,'stone',layer)
    for i in range(n):
        x=(xs[i]+xs[i+1])/2;top=y1+(y2-y1)*(i+.5)/n
        ellipsoid(name+f'_rock_{i}',(x,top-thick*.47,z+depth*.4),((x2-x1)/n*.64,thick*random.uniform(.28,.5),depth*.22),'stone',layer)
    return o

def deck(name,fh,parent=None,role='wood',width=220):
    x1,x2,y1,y2=fh['x1'],fh['x2'],-fh['y1'],-fh['y2'];t=28
    o=objmesh(name,[(x1,y1,-width/2),(x2,y2,-width/2),(x2,y2,width/2),(x1,y1,width/2),(x1,y1-t,-width/2),(x2,y2-t,-width/2),(x2,y2-t,width/2),(x1,y1-t,width/2)],[(0,3,2,1),(4,5,6,7),(0,1,5,4),(3,7,6,2),(0,4,7,3),(1,2,6,5)],role,'middle',parent)
    o['foothold_id']=fh['id'];o['footline']=[x1,y1,x2,y2];o['deck_width']=width
    return o

def bridgeparts(name,fh,parent):
    deck(name+'_Deck',fh,parent)
    x1,x2,y1,y2=fh['x1'],fh['x2'],-fh['y1'],-fh['y2'];n=max(2,int((x2-x1)/35))
    for i in range(n):
        a=x1+(x2-x1)*i/n;b=x1+(x2-x1)*(i+1)/n-2;ay=y1+(y2-y1)*i/n;by=y1+(y2-y1)*(i+1)/n
        deck(name+f'_Plank{i}',{'id':fh['id'],'x1':a,'x2':b,'y1':-ay+.5,'y2':-by+.5},parent,width=230)
    for z in [-100,105]:
        for i in range(5):
            x=x1+(x2-x1)*i/4;y=y1+(y2-y1)*i/4
            tube(name+f'_post_{z}_{i}',[(x,y,z),(x,y+110,z)],[9,7],'wood','middle',parent,8)
        tube(name+f'_rope_{z}',[(x1+(x2-x1)*i/12,y1+(y2-y1)*i/12+92-12*math.sin(math.pi*i/3),z) for i in range(13)],[4]*13,'wood','middle',parent,6)

def bell(name,x,y,z,size=1,layer='middle'):
    rig=empty(name,(x,y,z),layer,'sway')
    tube(name+'_chain',[(0,0,0),(0,-70*size,0)],[2*size]*2,'gold',layer,rig,6)
    tube(name+'_bell',[(0,-75*size,0),(0,-94*size,0),(0,-112*size,0)],[12*size,15*size,25*size],'gold',layer,rig,14)
    ellipsoid(name+'_clapper',(0,-118*size,0),(5*size,9*size,5*size),'gold',layer,rig)
    return rig

def giant_tree(x,base_y,z,flip=1):
    tube('AncientTree_Trunk',[(x,base_y,z),(x-60*flip,base_y+460,z-35),(x+40*flip,base_y+1040,z-50),(x+180*flip,base_y+1650,z-80),(x+410*flip,base_y+2380,z-100)],[330,290,240,190,75])
    for k in range(12):
        ang=k*math.tau/12
        tube('AncientTree_Root',[(x+30*math.cos(ang),base_y+150,z),(x+math.cos(ang)*340,base_y-70,z+math.sin(ang)*200),(x+math.cos(ang)*650,base_y-150,z+math.sin(ang)*320)],[95,66,16])
    for k in range(9):
        h=700+k*155;direction=1 if k%3 else -1;length=random.uniform(600,1100)
        pts=[(x+90,base_y+h,z-70),(x+direction*length*.5,base_y+h+160,z-120),(x+direction*length,base_y+h+400,z-150)]
        tube('AncientTree_Bough',pts,[115,65,22])
        leaves(f'TreeCanopy_{k}',pts[-1],(470,220,120),layer='middle',count=220)
        if k%2==0:bell('CanopyBell',pts[1][0],pts[1][1],z+30,2,'middle')
    # Fine bark ribs following the structural sweep.
    for k in range(16):
        offset=(k-7.5)*31
        tube('BarkFluting',[(x+offset,base_y-50,z+240),(x-60+offset*.86,base_y+450,z+230),(x+40+offset*.68,base_y+1040,z+160),(x+180+offset*.44,base_y+1600,z+100)],[13,17,11,4],'bark')

def hut(x,y,z):
    root=empty('TreehouseStation',(x,y,z),'middle')
    box('HutBackWall',(0,185,-100),(340,370,65),'wood','middle',root)
    for a in [-160,160]:tube('HutPillar',[(a,0,50),(a,360,50)],[15,12],'wood','middle',root)
    for a in [-95,-32,32,95]:box('HutPanel',(a,155,-58),(54,275,10),'bark','middle',root)
    objmesh('HutPitchedRoof',[(-230,330,-180),(230,330,-180),(230,330,150),(-230,330,150),(0,470,-180),(0,470,150)],[(0,4,5,3),(4,1,2,5),(0,1,4),(3,5,2)],'roof','middle',root)
    for a in range(-200,201,40):tube('RoofRafter',[(a,337-abs(a)*.05,150),(0,478,150)],[6,6],'wood','middle',root,6)
    box('GoldenDoor',(35,140,-17),(74,220,12),'glow','middle',root)
    tube('WindowArch',[(-65,180,-10),(-65,235,-10),(-35,264,-10),(-5,235,-10),(-5,180,-10)],[5]*5,'gold','middle',root,6)
    box('WindowLight',(-35,210,-14),(55,60,7),'glow','middle',root)
    box('WorkBench',(0,70,115),(310,15,60),'wood','middle',root)
    for a in [-120,120]:box('BenchLeg',(a,33,115),(12,65,12),'wood','middle',root)
    # Sloped fabric awning, a projecting deck and the concept's tall bell gantry.
    objmesh('StationCanvas',[(-230,310,110),(230,310,110),(245,262,285),(-245,262,285)],[(0,1,2,3)],'roof','middle',root)
    for a in [-220,220]:tube('CanopyPole',[(a,0,240),(a,290,240)],[8,7],'wood','middle',root,8)
    for a in [-290,300]:tube('HighBellMast',[(a,0,-20),(a,580,-20)],[12,9],'wood','middle',root,10)
    tube('HighBellCrossbar',[(-330,575,-20),(350,590,-20)],[10,9],'wood','middle',root,10)
    for a in [-290,0,300]:bell('HighStationBell',x+a,y+565,z-15,1.7,'middle')
    box('StationDeck',(0,-14,70),(540,28,350),'wood','middle',root)
    for a in [-190,190]:bell('StationBell',x+a,y+320,z+140,1.2,'middle')

def background(kind):
    # Huge geometry silhouettes plus a local original-art valley texture in final stage.
    plate=box('DistantValley',(1300,-400,-3300),(6400,4400,10),'valley','far')
    plate['source_kind']=kind
    if kind=='bridge':
        xs=[-2000,-1200,-400,350,750,1100,1400,1800,2400,3200,4500]
        ys=[100,-150,-250,-300,-650,-1050,-1000,-650,-300,-180,150]
        for offset in [0,-400]:
            verts=[(x,y+offset,-2450+offset) for x,y in zip(xs,ys)]+[(x,-2600,-2450+offset) for x in xs]
            objmesh('ContinuousValleyRidge',verts,[(i,i+1,i+1+len(xs),i+len(xs)) for i in range(len(xs)-1)],'farstone','far')
    for i in range(11):
        x=-1800+i*570;y=random.uniform(-900,0);z=-2300-random.uniform(0,350)
        if kind=='island':cliff('FarFloatingMass',x,x+random.uniform(130,260),y,y+random.uniform(-30,30),random.uniform(100,260),z,100,'far')
        for j in range(3):
            ellipsoid('FarTree',(x+j*55,y+35,z+40),(45,55,25),'farstone','far')
        rig=empty('FarWaterfall',(x+110,y-40,z+80),'far','water')
        box('Waterfall',(0,-330,0),(9,420,5),'water','far',rig)
    for i in range(12):
        layer='far' if i<7 else 'background';z=-1800 if i<7 else -950
        rig=empty(f'CloudBank_{i}',(-1800+i*540,-1150+random.uniform(-500,160),z),layer,'cloud')
        for j in range(4):ellipsoid('CloudVolume',(j*150,random.uniform(-25,25),0),(235,90,65),'cloud',layer,rig)

def build(kind):
    CTX['scene']=bpy.data.scenes.new('WindbellGrand_'+kind);bpy.context.window.scene=CTX['scene']
    LAYERS.clear()
    for layer in ['foreground','middle','background','far']:
        g=bpy.data.objects.new(layer.title(),None);CTX['scene'].collection.objects.link(g);g['render_layer']=layer;LAYERS[layer]=g
    CTX['scene'].world=bpy.data.worlds.new('Sky_'+kind);CTX['scene'].world.use_nodes=True;CTX['scene'].world.node_tree.nodes['Background'].inputs[0].default_value=(.7,.75,.8,1);CTX['scene'].world.node_tree.nodes['Background'].inputs[1].default_value=.65
    background(kind)
    giant_tree(-100,-1180 if kind=='island' else -700,-380)
    if kind=='bridge':giant_tree(2800,-710,-500,-1)
    else:
        tube('StationAncientTrunk',[(2410,-570,-460),(2530,-80,-500),(2470,500,-570),(2660,1150,-600)],[230,180,140,70])
        tube('StationArchBough',[(2510,350,-500),(2170,600,-460),(1840,700,-400)],[95,65,20])
        leaves('StationCrown',(2500,950,-450),(700,330,110),'middle',count=420)
        for xx in [2190,2630]:tube('StationGrownRoot',[(2470,10,-380),(xx,-450,-240),(xx+50,-610,-100)],[85,45,18])
    for fh in DATA['maps'][kind]['footholds']:
        y1,y2=-fh['y1'],-fh['y2'];x1,x2=fh['x1'],fh['x2'];deck(f'{kind}_Foothold{fh["id"]}',fh,role='grass' if kind=='island' else 'stone')
        if kind=='island' and fh['id']==2:
            for side in [-1,1]:tube('RootBridgeMain',[(x1,y1-55,side*70),(x1+280,y1+35,side*95),(x2-240,y2-165,side*65),(x2,y2-45,side*70)],[70,65,57,42],'bark','middle')
            cliff('LowerHeatIsland',x1,x1+260,y1-35,y1+95,250)
            cliff('UpperRootLanding',x2-200,x2,y2-128,y2-28,240)
        else:cliff('RootCliff' if kind=='island' else 'RiverBank',x1,x2,y1-28,y2-28,430 if kind=='island' else (520 if fh['id'] in [1,5] else 90))
        tube('TwistingRoot',[(x1,y1-50,100),((x1+x2)/2,(y1+y2)/2-100,140),(x2,y2-50,90)],[42,32,15],'bark','middle')
        for i in range(max(2,int((x2-x1)/125))):
            a=(i+.5)/max(2,int((x2-x1)/125));xx=x1+(x2-x1)*a;yy=y1+(y2-y1)*a
            leaves('PathFern',(xx,yy-8,-100),(70,18,16),'middle',24)
            leaves('HangingIvy',(xx,yy-80,175),(55,95,15),'middle',32)
            vine=empty('TrailingVine',(xx,yy-35,180),'middle','sway')
            tube('VineStem',[(0,0,0),(12,-90,0),(-8,-190,0),(4,-260,0)],[3,3,2,1],'grass','middle',vine,5)
        if kind=='island' and fh['id'] in [2,3]:
            for j in range(int((x2-x1)/42)):
                a=j*42/(x2-x1);b=min((j+1)*42/(x2-x1),1)
                deck('StoneTread',{'id':fh['id'],'x1':x1+(x2-x1)*a,'x2':x1+(x2-x1)*b-1,'y1':-(y1+(y2-y1)*a)+.3,'y2':-(y1+(y2-y1)*b)+.3},role='stone',width=210)
    hut(2350,-550 if kind=='island' else -700,-90)
    if kind=='island':
        tube('PivotSupportingBough',[(-120,-1070,-230),(180,-840,-180),(460,-690,-70),(650,-675,-40)],[130,95,70,38])
        for z in [-105,120]:
            tube('WinchSupport',[(565,-740,z),(565,-540,z)],[18,16],'wood','middle',sides=10)
            tube('WinchDisc',[(565,-585,z),(565,-585,z+18)],[43,43],'wood','middle',sides=20)
            tube('WinchHub',[(565,-585,z+18),(565,-585,z+26)],[18,18],'gold','middle',sides=16)
        for state,angle in [('Held',.63),('Falling',.32),('Landed',0)]:
            rig=empty('TreeBridge'+state,(650,-650,0));fh=dict(DATA['island']['treeBridge']['dynamicFoothold']);fh.update(x1=0,x2=900,y1=0,y2=-100);bridgeparts('TreeBridge'+state,fh,rig);rig.rotation_euler.z=angle;rig['state']=state.lower();rig['pivot']=[650,-650,0];rig['held_angle']=.63;rig['landed_angle']=0
        for x in [470,490]:tube('ClimbRope',[(x,-650,40),(x,-1200,40)],[4,4],'wood','middle',sides=6)
        for y in range(-1170,-650,45):tube('ClimbRung',[(470,y,40),(490,y,40)],[3,3],'wood','middle',sides=6)
        for i in range(9):
            a=i*math.tau/9;ellipsoid('HeatStone',(1060+math.cos(a)*60,-1090+math.sin(a)*20,30+math.sin(a)*35),(22,23,24),'stone','middle')
        flame=empty('HeatFire',(1060,-1070,20),'middle','fire')
        for i in range(7):ellipsoid('Flame',(random.uniform(-35,35),random.uniform(10,55),random.uniform(-10,10)),(12,35,8),'glow','middle',flame)
        wing=empty('Leafwing',(1100,-800,80),'middle','sway')
        for side in [-1,1]:objmesh('LeafWingSurface',[(0,0,0),(side*95,55,0),(side*130,20,0),(side*80,-10,8)],[(0,1,2,3)],'leaflight','middle',wing)
        dragon=empty('PatrolDragon',(450,180,-50),'background','cloud')
        box('DragonArtSurface',(0,0,0),(360,240,2),'dragon','background',dragon)
    else:
        broken=empty('BridgeBroken')
        for label,fh in [('Left',{'id':-1,'x1':800,'y1':700,'x2':940,'y2':760}),('Right',{'id':-2,'x1':1470,'y1':765,'x2':1600,'y2':700})]:bridgeparts('Broken'+label,fh,broken)
        for i,fh in enumerate(DATA['bridge']['segments']):bridgeparts(f'BridgeSegment{i+1}',fh,empty(f'BridgeSegment{i+1}'))
        cart=empty('Cart',(450,-700,0));box('CartBed',(0,62,0),(135,22,90),'wood','middle',cart)
        for x in [-50,50]:
            for z in [-50,50]:
                tube('CartWheel',[(x,28,z-5),(x,28,z+5)],[27,27],'wood','middle',cart,18)
                tube('WheelAxle',[(x-25,28,z+7),(x+25,28,z+7)],[3,3],'gold','middle',cart,6)
        for y in [85,105,125]:box('CartSlat',(0,y,48),(145,15,8),'wood','middle',cart)
        for i in range(3):ellipsoid('CartSack',(-40+i*40,115,-5),(23,35,25),'cloud','middle',cart)
        for i in range(5):box('Materials',(650,-680+i*13,0),(105,10,65),'wood')
        river=empty('RiverCurrent',(1300,-1130,180),'foreground','water')
        box('RiverSurface',(0,-130,-250),(1700,65,1200),'water','foreground',river)
    # Near foliage frames the open play space without a flat image mask.
    for i,(x,y) in enumerate([(-450,-1250),(2850,-1200),(-350,950),(2870,1150)]):
        leaves(f'ForegroundFraming_{i}',(x,y,380),(600,280,120),'foreground',280)
    for i in range(8):bell('HangingWindbell',-250+i*430,600+math.sin(i)*220,-50,1.6,'background')
    CTX['scene'].render.engine='CYCLES';CTX['scene'].cycles.samples=12;CTX['scene'].cycles.use_denoising=True
    CTX['scene'].render.resolution_x=1500;CTX['scene'].render.resolution_y=1000;CTX['scene'].render.resolution_percentage=100
    CTX['scene'].view_settings.view_transform='Standard';CTX['scene'].view_settings.look='None'
    ld=bpy.data.lights.new('Sun_'+kind,'AREA');lo=bpy.data.objects.new('Sun_'+kind,ld);CTX['scene'].collection.objects.link(lo);lo.location=(-1000,2400,3000);ld.energy=22000000;ld.size=2200;lo.rotation_euler=(Vector((1000,-500,0))-lo.location).to_track_quat('-Z','Y').to_euler()
    camd=bpy.data.cameras.new('Camera_'+kind);cam=bpy.data.objects.new('Camera_'+kind,camd);CTX['scene'].collection.objects.link(cam);cam.location=(1300,70,6500);target=Vector((1300,-650,0));cam.rotation_euler=(-math.atan(720/6500),0,0);camd.type='ORTHO';camd.ortho_scale=3700;camd.clip_end=15000;CTX['scene'].camera=cam
    sun=bpy.data.lights.new('KeySun_'+kind,'SUN');sun.energy=2;sun.angle=.15;so=bpy.data.objects.new('KeySun_'+kind,sun);CTX['scene'].collection.objects.link(so);so.rotation_euler=(.4,-.5,0)
    return CTX['scene']

def export_render(stage):
    target=OUT+'/whitebox' if stage=='whitebox' else OUT
    for kind in MAP_FILTER:
        sc=bpy.data.scenes['WindbellGrand_'+kind];bpy.context.window.scene=sc
        for o in sc.objects:
            if o.name.startswith(('TreeBridgeHeld','TreeBridgeFalling','Leafwing','LeafWingSurface','Broken')):o.hide_render=True
        # All state meshes are exported; runtime owns visibility.
        bpy.ops.export_scene.gltf(filepath=str(target+'/glb/'+kind+'.glb'),export_format='GLB',use_active_scene=True,export_yup=False,export_extras=True,export_cameras=False,export_lights=False)
        sc.render.filepath=str(target+'/renders/'+kind+'.png');bpy.ops.render.render(write_still=True)
        if kind=='island':
            for o in sc.objects:
                if o.name.startswith('TreeBridgeLanded'):o.hide_render=True
                if o.name.startswith('TreeBridgeHeld'):o.hide_render=False
            sc.render.filepath=target+'/renders/island-held.png';bpy.ops.render.render(write_still=True)
            for o in sc.objects:
                if o.name.startswith('TreeBridgeLanded'):o.hide_render=False
                if o.name.startswith('TreeBridgeHeld'):o.hide_render=True
        elif stage=='textured':
            for o in sc.objects:
                if o.name.startswith('BridgeSegment'):o.hide_render=True
                if o.name.startswith('Broken'):o.hide_render=False
            sc.render.filepath=target+'/renders/bridge-broken.png';bpy.ops.render.render(write_still=True)
            for o in sc.objects:
                if o.name.startswith('BridgeSegment'):o.hide_render=False
                if o.name.startswith('Broken'):o.hide_render=True

def texture():
    for im in bpy.data.images:
        if im.filepath.startswith(OUT+'/textures/'):
            im.reload();im.pack()
    for m in bpy.data.materials:
        if not m.name.startswith('Grand_'):continue
        role=m['role'];bs=m.node_tree.nodes.get('Principled BSDF');bs.inputs['Base Color'].default_value=COLORS.get(role,(.65,.75,.8,1));m.diffuse_color=COLORS.get(role,(.65,.75,.8,1))
        if role=='cloud':
            bs.inputs['Alpha'].default_value=.6;m.surface_render_method='DITHERED'
        if role=='glow':bs.inputs['Emission Color'].default_value=(1,.5,.1,1);bs.inputs['Emission Strength'].default_value=.7
    for kind in MAP_FILTER:
        sc=bpy.data.scenes['WindbellGrand_'+kind]
        for o in sc.objects:
            if o.name.startswith('TreehouseStation'):o.location.z=-90
            if o.type!='MESH':continue
            role=o.get('role')
            if role=='stone' and o.parent and o.parent.get('render_layer')=='far':
                o.data.materials.clear();o.data.materials.append(bpy.data.materials.get('Grand_farstone'));continue
            patch=OUT+'/textures/'+f'windbell_{kind}_{role}_patch.png'
            if role=='valley':patch=OUT+'/textures/'+kind+'-distant-valley.png'
            if role=='dragon':patch=ROOT+'/resources/scenes/windbell/images/clean/prop-dragon.png'
            if role not in ['bark','wood','stone','grass','water','valley','dragon']:continue
            mn=f'Textured_{kind}_{role}'
            m=bpy.data.materials.get(mn)
            if m is None:
                m=bpy.data.materials.new(mn);m.use_nodes=True;bs=m.node_tree.nodes.get('Principled BSDF');bs.inputs['Roughness'].default_value=.85
                tex=m.node_tree.nodes.new('ShaderNodeTexImage');tex.image=bpy.data.images.load(str(patch),check_existing=True);tex.image.pack();m.node_tree.links.new(tex.outputs['Color'],bs.inputs['Base Color'])
                if role=='dragon':
                    m.node_tree.links.new(tex.outputs['Alpha'],bs.inputs['Alpha']);m.surface_render_method='DITHERED'
                if role=='valley':m.node_tree.links.new(tex.outputs['Color'],bs.inputs['Emission Color']);bs.inputs['Emission Strength'].default_value=.55
                m['source']=patch[len(ROOT)+1:]
            o.data.materials.clear();o.data.materials.append(m)
            uv=o.data.uv_layers.new(name='ConceptUV') if not o.data.uv_layers else o.data.uv_layers[0]
            # World-unit tile scale prevents per-face stretching and bark/stone striping.
            for poly in o.data.polygons:
                axis=list(abs(v) for v in poly.normal).index(max(abs(v) for v in poly.normal));axes=[a for a in range(3) if a!=axis]
                coords=[o.data.vertices[o.data.loops[li].vertex_index].co for li in poly.loop_indices];mins=[min(c[a] for c in coords) for a in axes];maxs=[max(c[a] for c in coords) for a in axes]
                for li,c in zip(poly.loop_indices,coords):
                    if role in ['valley','dragon']:
                        uv.data[li].uv=[(c[a]-mnv)/max(mx-mnv,.001) for a,mnv,mx in zip(axes,mins,maxs)]
                    else:
                        if role=='bark':axes=[2,1] if axis==0 else [0,1]
                        period=320 if role in ['bark','stone'] else 200
                        uv.data[li].uv=[c[a]/period for a in axes]
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT+'/windbell_textured.blend'))
    export_render('textured')

if STAGE=='whitebox':
    # Preserve old project scene library; replace only this script's own generated scenes.
    for s in list(bpy.data.scenes):
        if s.name.startswith('WindbellGrand_'):
            for ob in list(s.objects):bpy.data.objects.remove(ob,do_unlink=True)
            bpy.data.scenes.remove(s)
    for o in list(bpy.data.objects):
        if o.users==0:bpy.data.objects.remove(o)
    for kind in MAP_FILTER:build(kind)
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT+'/whitebox/windbell_whitebox.blend'))
    export_render('whitebox')
    bpy.ops.wm.save_as_mainfile(filepath=OUT+'/whitebox/windbell_whitebox.blend')
else:texture()
print('WINDBELL_GRAND_'+STAGE.upper()+'_COMPLETE')
