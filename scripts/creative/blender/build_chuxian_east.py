"""Blender MCP source for the independent east-village spatial prototype.
Authored metres, Z-up; navigation is preview-only, not a replacement for game authority.
Keeps other scenes and reuses Quaternius CC0 vegetation and existing mushroom helpers.
"""
import bpy, math, random, json
from mathutils import Vector
rng=random.Random(9030)
OUT='/Users/muniao/Code/MapleStory/resources/scenes/chuxian-east-v1'
VENDOR='/Users/muniao/Code/MapleStory/resources/scenes/henesys/rail-v1/vendor/nature/Stylized Nature MegaKit[Standard]/glTF/'
for old in list(bpy.data.scenes):
    if old.name=='CE_EastVillage':
        for o in list(old.objects):bpy.data.objects.remove(o,do_unlink=True)
        bpy.data.scenes.remove(old)
scene=bpy.data.scenes.new('CE_EastVillage');bpy.context.window.scene=scene
C={name:scene.collection for name in ['East','West','Market','Park','Hall']}
M={}
colors={'wall':(.87,.76,.55),'stoneLight':(.66,.64,.51),'wood':(.28,.16,.085),'darkwood':(.11,.07,.04),'honeywood':(.52,.33,.16),'red':(.63,.18,.095),'orange':(.86,.38,.11),'yellow':(.91,.60,.16),'green':(.28,.42,.16),'cream':(.96,.87,.66),'roofSpot':(.97,.80,.44),'shadow':(.04,.055,.05),'iron':(.13,.19,.16),'gold':(.76,.48,.12),'window':(.98,.61,.18),'slate':(.16,.27,.30),'grass':(.30,.43,.22),'earth':(.39,.36,.29),'road':(.73,.67,.54),'water':(.20,.48,.50),'far':(.20,.34,.33)}
for name,color in colors.items():
    m=bpy.data.materials.new('CE_'+name);m.use_nodes=True;m.diffuse_color=(*color,1)
    bsdf=next(n for n in m.node_tree.nodes if n.type=='BSDF_PRINCIPLED');bsdf.inputs['Base Color'].default_value=(*color,1);bsdf.inputs['Roughness'].default_value=.8
    if name=='window':bsdf.inputs['Emission Color'].default_value=(*color,1);bsdf.inputs['Emission Strength'].default_value=.3
    M[name]=m
def mesh(name, verts, faces, material, group, uv=None, smooth=False):
    data = bpy.data.meshes.new('CE_'+name); data.from_pydata(verts,[],faces); data.update()
    obj = bpy.data.objects.new('CE_'+name,data); C[group].objects.link(obj)
    data.materials.append(M[material]); layer = data.uv_layers.new(name='UVMap')
    for poly in data.polygons:
        poly.use_smooth = smooth
        normal = poly.normal
        def normal_axis(i): return abs(normal[i])
        dominant = max(range(3), key=normal_axis)
        axes = [i for i in range(3) if i != dominant]
        for li in poly.loop_indices:
            vi = data.loops[li].vertex_index; p = data.vertices[vi].co
            layer.data[li].uv = uv[vi] if uv else (p[axes[0]]*.4, p[axes[1]]*.4)
    obj['role'] = 'visual_only'; return obj

def box(name, p, dims, material, group, bevel=.055, yaw=0):
    x,y,z = [a/2 for a in dims]
    o = mesh(name,[(-x,-y,-z),(x,-y,-z),(x,y,-z),(-x,y,-z),(-x,-y,z),(x,-y,z),(x,y,z),(-x,y,z)],
        [(0,3,2,1),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7),(4,5,6,7)],material,group)
    o.location = p; o.rotation_euler.z = yaw
    if bevel:
        mod = o.modifiers.new('Soft worked edges','BEVEL'); mod.width = min(bevel,min(dims)*.2); mod.segments = 1
    return o

def beam(name, a, b, width, material, group):
    a,b = Vector(a),Vector(b); o=box(name,(a+b)/2,(width,width,(b-a).length),material,group,.025)
    o.rotation_euler=(b-a).to_track_quat('Z','Y').to_euler(); return o

def tube(name, points, radius, material, group, sides=8):
    vs=[]; uvs=[]
    for i,p in enumerate(points):
        tangent = Vector(points[min(i+1,len(points)-1)])-Vector(points[max(0,i-1)])
        tangent.normalize(); ref=Vector((0,1,0)) if abs(tangent.y)<.9 else Vector((1,0,0))
        u=tangent.cross(ref).normalized(); v=tangent.cross(u).normalized()
        for j in range(sides):
            t=2*math.pi*j/sides; vs.append(Vector(p)+radius*(math.cos(t)*u+math.sin(t)*v)); uvs.append((j/sides,i/4))
    fs=[(i*sides+j,i*sides+(j+1)%sides,(i+1)*sides+(j+1)%sides,(i+1)*sides+j) for i in range(len(points)-1) for j in range(sides)]
    fs += [tuple(reversed(range(sides))),tuple((len(points)-1)*sides+j for j in range(sides))]
    return mesh(name,vs,fs,material,group,uvs,True)

def ringform(name, center, rings, material, group, sides=48, irregular=0):
    x,y,z=center; vs=[]; uv=[]
    for k,(r,h) in enumerate(rings):
        for j in range(sides):
            t=2*math.pi*j/sides; f=1+irregular*(.5*math.sin(3*t+.4)+.3*math.cos(5*t))
            vs.append((x+r*math.cos(t)*f,y+r*math.sin(t)*f,z+h)); uv.append((j/sides*3,h/2))
    fs=[(k*sides+j,k*sides+(j+1)%sides,(k+1)*sides+(j+1)%sides,(k+1)*sides+j) for k in range(len(rings)-1) for j in range(sides)]
    fs.extend([tuple(reversed(range(sides))),tuple((len(rings)-1)*sides+j for j in range(sides))])
    return mesh(name,vs,fs,material,group,uv,True)

def cap(name, center, radius, height, color, group, spots=True):
    x,y,z=center; sides=64; levels=18
    def surface(r,t,offset=0):
        wobble=1+.045*math.sin(3*t+.6)+.02*math.cos(5*t)
        return Vector((x+radius*r*math.cos(t)*wobble,y+radius*r*math.sin(t)*wobble,
                       z+height*(max(0,1-r*r)**.63)+.08*radius*r*r*math.sin(2*t+.4)+offset))
    verts=[]; uv=[]
    for k in range(levels+1):
        r=.001+k/levels*.999
        for j in range(sides):
            t=2*math.pi*j/sides; verts.append(surface(r,t)); uv.append((.5+r*math.cos(t)*.5,.5+r*math.sin(t)*.5))
    faces=[(k*sides+j,k*sides+(j+1)%sides,(k+1)*sides+(j+1)%sides,(k+1)*sides+j) for k in range(levels) for j in range(sides)]
    mesh(name+'Cap',verts,faces,color,group,uv,True)
    edge=[surface(1,j*2*math.pi/sides) for j in range(sides+1)]
    tube(name+'RolledLip',edge,.12,'orange' if color=='red' else color,group)
    ringform(name+'IvoryUnderside',center,[(radius,.0),(radius*.96,-.18),(radius*.48,-.38),(radius*.25,-.35)],'cream',group,64,.025)
    for j in range(32):
        t=2*math.pi*j/32
        tube(name+'Gill',[(x+radius*r*math.cos(t),y+radius*r*math.sin(t),z-.21-.22*(1-r)) for r in [.32,.55,.76,.95]],.018,'honeywood',group,5)
    if spots:
        for i,(r,t,size) in enumerate([(.50,-1.75,.13),(.76,-.83,.115),(.76,-2.65,.11),(.29,.15,.11),(.70,.67,.10),(.55,2.5,.14),(.91,.05,.06)]):
            cx,cy=r*math.cos(t),r*math.sin(t); v=[surface(r,t,.024)]
            for j in range(25):
                a=2*math.pi*j/24; xx=cx+size*math.cos(a); yy=cy+size*math.sin(a)
                v.append(surface(math.hypot(xx,yy),math.atan2(yy,xx),.025))
            mesh(name+'Spot'+str(i),v,[(0,j+1,j+2) for j in range(24)],'roofSpot',group,smooth=True)

def arch(name,x,y,z,w,h,material,group):
    r=w/2; spring=h-r
    points=[(x-r,y,z),(x-r,y,z+spring)]+[(x+math.cos(t)*r,y,z+spring+math.sin(t)*r) for t in [math.pi-i*math.pi/16 for i in range(17)]]+[(x+r,y,z)]
    mesh(name+'Infill',points,[tuple(range(len(points)))],material,group)
    tube(name+'Frame',points,.105,'darkwood',group)
    return points

def window(name,x,y,z,w,h,group):
    arch(name,x,y,z,w,h,'shadow',group)
    arch(name+'Glass',x,y-.02,z+.10,w-.25,h-.24,'window',group)
    beam(name+'Mullion',(x,y-.08,z+.15),(x,y-.08,z+h-.14),.07,'honeywood',group)
    beam(name+'Cross',(x-w*.39,y-.08,z+h*.43),(x+w*.39,y-.08,z+h*.43),.07,'honeywood',group)
    box(name+'Sill',(x,y-.17,z-.05),(w+.35,.48,.16),'honeywood',group)

def door(name,x,y,z,w,h,group):
    arch(name,x,y,z,w,h,'wood',group)
    for d in [-.32,-.10,.12,.34]:
        beam(name+'PlankSeam',(x+d*w,y-.025,z+.12),(x+d*w,y-.025,z+h-w/2),.018,'darkwood',group)
    for zz in [.4,h*.65]:box(name+'Hinge',(x-w*.31,y-.09,z+zz),(.4,.08,.085),'iron',group,.01)
    ringform(name+'Knob',(0,0,0),[(.07,-.04),(.07,.04)],'gold',group,12).location=(x+w*.28,y-.12,z+h*.43)
    for side in [-1,1]:beam(name+'Post',(x+side*(w/2+.12),y-.02,z),(x+side*(w/2+.12),y-.02,z+h-w/2),.22,'honeywood',group)
    box(name+'Step',(x,y-.43,z+.04),(w+.7,1,.18),'stoneLight',group,.08)

def lantern(x,y,z,group):
    beam('LampBracket',(x,y+.45,z+.2),(x,y,z+.2),.09,'iron',group)
    box('LampGlow',(x,y,z-.2),(.30,.30,.47),'window',group,.05)
    for zz in [z+.06,z-.47]:box('LampCap',(x,y,zz),(.45,.43,.12),'iron',group,.04)
    for dx in [-.17,.17]:
        for dy in [-.17,.17]:beam('LampBars',(x+dx,y+dy,z-.45),(x+dx,y+dy,z+.03),.035,'iron',group)

def fence(x0,x1,y,z,group,color='cream'):
    count=max(2,int((x1-x0)/.7))
    for i in range(count+1):
        x=x0+(x1-x0)*i/count
        box('Picket',(x,y,z+.55),(.16,.16,1.08),color,group,.045)
    for h in [.32,.76]:beam('FenceRail',(x0,y+.08,z+h),(x1,y+.08,z+h),.105,'honeywood',group)

def house(name,x,y,z,r=2.8,h=3.2,color='red',group='East',spots=True,balcony=False):
    ringform(name+'StoneFoot',(x,y,z),[(r*1.04,0),(r*1.04,.25),(r,.38)],'stoneLight',group)
    ringform(name+'Stem',(x,y,z),[(r,.3),(r*.94,1.0),(r*.83,h*.76),(r*.90,h)],'wall',group,48,.015)
    for t in [-2.4,-.75,.2,1.2,2.4]:
        a=(x+r*.96*math.cos(t),y+r*.96*math.sin(t),z+.4)
        b=(x+r*.86*math.cos(t),y+r*.86*math.sin(t),z+h)
        beam(name+'TimberStud',a,b,.18,'wood',group)
    cap(name,(x,y,z+h),r*1.32,h*.63,color,group,spots)
    fy=y-r*.94
    door(name+'Door',x,fy-.11,z+.23,1.25,min(2.5,h-.2),group)
    for sign in [-1,1]:
        window(name+'Window',x+sign*r*.64,y-r*.78-.10,z+1.05,.85,1.24,group)
    # Curved porch roof and substantial brackets.
    cap(name+'Porch',(x,fy-.25,z+2.75),1.15,.48,color,group,False)
    for dx in [-.91,.91]:beam(name+'PorchStrut',(x+dx,fy,z+1.90),(x+dx,fy-.66,z+2.6),.11,'wood',group)
    lantern(x+1.03,fy-.22,z+2.1,group)
    # An arched dormer maintains the original mushroom silhouette.
    window(name+'Dormer',x-.3,y-r*.64,z+h+.45,1.0,1.2,group)
    tube(name+'DormerEave',[(x-.97,y-r*.65,z+h+.55),(x-.91,y-r*.65,z+h+1.28),(x-.3,y-r*.65,z+h+1.76),(x+.32,y-r*.65,z+h+1.25),(x+.39,y-r*.65,z+h+.55)],.13,color,group)
    if balcony:
        box(name+'Balcony',(x,fy-.36,z+2.9),(r*1.65,1.2,.21),'wood',group)
        fence(x-r*.8,x+r*.8,fy-.87,z+3.01,group)
    return fy

def tower(name,x,y,z,r,h,color,group):
    ringform(name+'Base',(x,y,z),[(r*1.06,0),(r*1.06,.38),(r,.48),(r*.83,h*.65),(r*.87,h)],'wall',group,48,.02)
    for hh in [.5,h*.54,h*.7]:ringform(name+'Belt',(x,y,z),[(r*.93,hh),(r*.96,hh+.12),(r*.91,hh+.28)],'wood',group)
    cap(name,(x,y,z+h),r*1.35,r*.95,color,group,True)
    door(name+'Door',x,y-r*.94-.05,z+.24,1.12,2.25,group)
    window(name+'Upper',x,y-r*.88-.06,z+h-2,1.1,1.45,group)
    lantern(x+1.0,y-r*.87,z+2.25,group)

# Local textures keep individual surfaces editable; the panorama is never used as a ground plane.
for name in ['road','wood','earth','grass','slate']:
    im=bpy.data.images.new('CE_Texture_'+name,width=128,height=128);pixels=[]
    for yy in range(128):
        for xx in range(128):
            v=.9+rng.random()*.1
            if name=='road':
                row=yy//16;edge=(xx+(row%2)*16)%32<2 or yy%16<2;v=.66 if edge else .9+rng.random()*.1
            elif name=='wood':v=.82+.13*math.sin(xx*.52+math.sin(yy*.09))+.04*rng.random()
            elif name=='slate':v=.67 if yy%12<1 or (xx+(yy//12%2)*8)%16<1 else .9+rng.random()*.1
            pixels.extend([min(1,c*v) for c in colors[name]]+[1])
    im.pixels.foreach_set(pixels);im.pack();n=M[name].node_tree.nodes.new('ShaderNodeTexImage');n.image=im;M[name].node_tree.links.new(n.outputs['Color'],next(n for n in M[name].node_tree.nodes if n.type=='BSDF_PRINCIPLED').inputs['Base Color'])

def category(obj,layer):obj['layer']=layer;return obj

def solid(name,p,dims,mat,layer='terrain',bevel=.0):return category(box(name,p,dims,mat,'East',bevel),layer)

def join_new(before,name,layer):
    objects=[o for o in scene.objects if o not in before and o.type=='MESH'];bpy.ops.object.select_all(action='DESELECT')
    for o in objects:
        o.select_set(True);bpy.context.view_layer.objects.active=o
        for mod in list(o.modifiers):bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.context.view_layer.objects.active=objects[0];bpy.ops.object.join();obj=bpy.context.object;obj.name='CE_'+name;obj['layer']=layer;return obj

# Road-shaped ground is generated after navigation; retain separate distant scenery.
solid('HorizonMeadow',(0,40,-1.2),(1100,1100,1),'far')
solid('FrontBank',(0,-80,1),(212,30,2),'grass')
# Distant low faceted ridges (separate geometry, no scenery billboard).
vs=[];fs=[];cols=41
for j in range(13):
    for i in range(cols):
        x=-180+i*9;y=61+j*12;z=6+j*2.8+12*math.sin(x*.035+j*.47)**2+10*math.cos(x*.04-j*.13)**2;vs.append((x,y,z))
for j in range(12):
    for i in range(cols-1):a=j*cols+i;fs.append((a,a+1,a+1+cols,a+cols))
category(mesh('DistantRidges',vs,fs,'far','East'),'terrain')
water=solid('River',(0,-54,.65),(232,25,.16),'water','water')

nodes={}
routes=[]
def node(key,p):nodes[key]=list(p);return key
def route(name,points,width=4.5,kind='main'):
    keys=[]
    for key,p in points:node(key,p);keys.append(key)
    routes.append({'name':name,'points':keys,'width':width,'kind':kind})
main=[('west',(-88,-18,3)),('westCross',(-60,-19,4.4)),('marketCross',(-34,-20,5)),('marketFront',(-15,-24,5.8)),('central',(5,-25,8)),('gardenFront',(28,-27,9.2)),('eastCross',(50,-29,8.6)),('stairsFoot',(70,-30,5.5)),('eastGate',(88,-25,4.2))]
route('晨光大道',main,7)
route('集市环路',[main[2],('marketW',(-37,-8,6.2)),('marketNW',(-31,5,8.4)),('marketN',(-18,12,10)),('marketNE',(-5,6,10.5)),('marketE',(1,-7,9.4)),('marketSE',(-4,-18,7)),main[3],main[2]],4.7,'loop')
route('上山曲线道',[('marketN',(-18,12,10)),('hill1',(-21,20,14)),('hill2',(-14,28,19)),('hillTop',(-1,26,24)),('hallW',(11,27,24))],4.5,'slope')
ring=[('hallW',(11,27,24)),('hallSW',(14,17,24)),('hallFrontW',(30,13,24)),('hallFrontE',(50,14,25)),('hallSE',(65,23,24)),('hallE',(70,35,24)),('hallNE',(63,48,26)),('hallN',(42,54,27)),('hallNW',(21,47,25)),('hallWest',(10,37,24)),('hallW',(11,27,24))]
route('弓手大厅环路',ring,5.2,'loop')
route('东坡石阶',[ring[4],('stairsTop',(80,15,24)),('stairs1',(83,4,19)),('stairs2',(80,-8,13)),('stairsLanding',(70,-19,7)),main[7]],4.2,'stairs')
route('花坡背巷',[main[4],('gardenW',(12,-14,8.8)),('gardenNW',(18,0,8.4)),('gardenN',(41,5,8.8)),('gardenNE',(61,1,9.4)),('gardenE',(66,-16,7)),main[7],main[6],main[5],main[4]],3.7,'loop')
river=[('riverW',(-70,-36,1.8)),('bridgehead',(-35,-36,2)),('riverCross',(-10,-36,1.9)),('dockHead',(12,-36,1.8)),('riverE',(43,-38,2.1)),('riverGate',(74,-37,2.4))]
route('沿溪小径',river,3.8)
route('桥头支巷',[main[2],river[1]],3.5,'branch')
route('花店支巷',[main[5],river[4]],3.5,'branch')
route('东村支巷',[main[7],river[5]],3.5,'branch')
route('石桥',[river[1],('bridgeMiddle',(-35,-50,3.2)),('bridgeEnd',(-35,-68,3)),('frontForest',(-63,-75,3))],5,'bridge')
route('东溪码头',[river[3],('dock',(12,-43,1.8)),('pier',(12,-51,1.8))],3.3,'dock')
route('树荫高街',[('hillTop',(-1,26,24)),('groveEast',(-20,31,20)),('groveCross',(-36,37,17)),('groveMid',(-52,31,17)),('groveW',(-71,30,17)),('groveEnd',(-81,22,16))],3.8,'branch')
route('林根小径',[('groveCross',(-36,37,17)),('rootEntry',(-41,46,14)),('rootHollow',(-56,49,11.5)),('rootBend',(-72,45,12.4)),('groveW',(-71,30,17))],3.2,'branch')
# Narrow mouths line up with the fixed camera once approached, while diagonal views retain the banks.
route('花坡门道',[main[5],('flowerMouth',(41,-20,9.4)),('flowerGate',(41,-8,10.2)),('gardenN',(41,5,8.8))],3.3,'branch')
route('林坡短阶',[('groveMid',(-52,31,17)),('rootHollow',(-56,49,11.5))],3.0,'stairs')
# Curve the authored lanes while keeping shared junction IDs for navigation.
for ri,r in enumerate(routes):
    if r['kind'] not in ['loop','slope']:continue
    source=list(r['points']);closed=source[0]==source[-1];out=[source[0]]
    for i in range(len(source)-1):
        p1=Vector(nodes[source[i]]);p2=Vector(nodes[source[i+1]])
        p0=Vector(nodes[source[i-1] if i else source[-2] if closed else source[0]])
        p3=Vector(nodes[source[i+2] if i+2<len(source) else source[1] if closed else source[-1]])
        for k in range(1,7):
            if k==6:out.append(source[i+1]);continue
            t=k/6;p=.5*((2*p1)+(-p0+p2)*t+(2*p0-5*p1+4*p2-p3)*t*t+(-p0+3*p1-3*p2+p3)*t*t*t)
            # Height follows the authored grade, preventing spline overshoot into the ground.
            p.z=p1.z+(p2.z-p1.z)*t;key='curve_'+str(ri)+'_'+str(i)+'_'+str(k);nodes[key]=list(p);out.append(key)
    r['points']=out
# A continuous solid terrain follows road grades, rather than putting ribbons above a flat slab.
ground_segments=[]
for r in routes:
    for a,b in zip(r['points'],r['points'][1:]):ground_segments.append((nodes[a],nodes[b],r['width']/2))
def smooth(a,b,v):
    t=max(0,min(1,(v-a)/(b-a)));return t*t*(3-2*t)
def mound(x,y,cx,cy,rx,ry,h,edge=.75):
    return h*(1-smooth(edge,1.12,math.hypot((x-cx)/rx,(y-cy)/ry)))
def ground_raw(x,y):
    base=2.55+mound(x,y,5,-19,88,33,5.2,.30)
    base=max(base,2.55+mound(x,y,42,34,49,32,21.3,.89),2.55+mound(x,y,-53,31,37,26,14.2,.86))
    # This foreground knoll hides the lower flower lane; entrances stay on either shoulder.
    base=max(base,2.55+mound(x,y,38,-9,24,12,11,.73),2.55+mound(x,y,-18,-2,23,17,7,.50))
    best=1000;grade=base
    for a,b,half in ground_segments:
        dx=b[0]-a[0];dy=b[1]-a[1];t=max(0,min(1,((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy)))
        d=math.hypot(x-a[0]-dx*t,y-a[1]-dy*t)-half
        if d<best:best=d;grade=a[2]+(b[2]-a[2])*t-.16
    return grade+(base-grade)*smooth(.7,5.2,best)
sites=[('Market',-18,-2,6.5,6.5,'orange'),('CottageRose',27,-10,4.7,5.5,'red'),('CottageHoney',48,-10,4.9,5.8,'yellow'),('EastShop',76,-4,3.8,6,'orange'),('WestHome',-53,-4,4.7,5.5,'red'),('SouthTea',48,-44,3.5,4.5,'yellow'),('WestTower',-66,16,3.5,7,'orange'),('GroveHome',-51,44,3.7,5.3,'orange'),('GroveTea',-32,25,3.0,4.2,'yellow'),('HillCottage',73,46,3.1,4.5,'red')]
# Level each building footprint into the hillside, without changing independent road heights.
pads=[(x,y,r*1.08,ground_raw(x,y)) for _,x,y,r,_,_ in sites]
def ground_height(x,y):
    h=ground_raw(x,y)
    for cx,cy,r,level in pads:
        d=math.hypot(x-cx,y-cy)
        if d<r+2:h=level+(h-level)*smooth(r,r+2,d)
    # A foundation may level the slope beside a lane, but must never fill its walking corridor.
    corridor=[]
    for a,b,half in ground_segments:
        dx=b[0]-a[0];dy=b[1]-a[1];t=max(0,min(1,((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy)))
        if math.hypot(x-a[0]-dx*t,y-a[1]-dy*t)<half+1.25:corridor.append(a[2]+(b[2]-a[2])*t-.45)
    return min(corridor) if corridor else h
# Two metre grid, filled underside and earthen skirt; height is also used by plants and foundations.
vs=[];fs=[];nx=107;ny=57
for j in range(ny):
    y=-43+j*2
    for i in range(nx):x=-106+i*2;vs.append((x,y,ground_height(x,y)))
for j in range(ny-1):
    for i in range(nx-1):a=j*nx+i;fs.extend([(a,a+1,a+nx+1),(a,a+nx+1,a+nx)])
top_count=len(fs)
boundary=list(range(nx))+[j*nx+nx-1 for j in range(1,ny)]+list(range((ny-1)*nx+nx-2,(ny-1)*nx-1,-1))+[j*nx for j in range(ny-2,0,-1)]
for i,a in enumerate(boundary):
    b=boundary[(i+1)%len(boundary)];k=len(vs);vs.extend([(vs[a][0],vs[a][1],.35),(vs[b][0],vs[b][1],.35)]);fs.append((a,k,k+1,b))
fs.append(tuple(range(len(vs)-2, nx*ny-1,-2)))
o=category(mesh('RollingVillageGround',vs,fs,'grass','East'),'terrain');o.data.materials.append(M['earth'])
for f in o.data.polygons:
    if f.index>=top_count:f.material_index=1
# Exposed ledges show the upper route as a destination from the low game camera.
for i in range(26):
    t=math.pi*1.16+i*math.pi*.69/25;x=42+48*math.cos(t);y=34+31*math.sin(t);top=ground_height(x,y)
    solid('Cliff_'+str(i),(x,y,(top+2.5)/2),(2.8,2.1,max(.4,top-2.5)),'earth',bevel=.2)
seen=set()
for ri,r in enumerate(routes):
    for a,b in zip(r['points'],r['points'][1:]):
        sid=tuple(sorted((a,b)))
        if sid in seen:continue
        seen.add(sid);aa=Vector(nodes[a]);bb=Vector(nodes[b]);d=bb-aa;normal=Vector((-d.y,d.x,0)).normalized()*r['width']/2
        verts=[aa+normal,aa-normal,bb-normal,bb+normal];o=category(mesh('Road_'+str(ri)+'_'+a,verts,[(0,1,2,3)],'wood' if r['kind']=='dock' else 'road','East'),'roads');o['route']=r['name'];o['walkable']=True;mod=o.modifiers.new('Road thickness','SOLIDIFY');mod.thickness=.45;mod.offset=-1
        # Slope support is separate from walking surface; stairs are modelled step by step.
        if r['kind']=='stairs' and abs(d.z)>.5:
            count=max(1,int(abs(d.z)/.28))
            for j in range(count):
                p=aa.lerp(bb,(j+.5)/count);step=solid('Step',Vector((p.x,p.y,p.z-.23)),(r['width'],max(.35,d.xy.length/count),.46),'stoneLight','roads');step.rotation_euler.z=math.atan2(-d.x,d.y)
        for side in [-1,1]:
            n=normal*side
            if r['kind'] in ['bridge','stairs','dock']:
                category(beam('RoadRail',aa+n+Vector((0,0,1)),bb+n+Vector((0,0,1)),.12,'wood','East'),'roads')
                for j in range(max(2,int(d.length/2))):p=aa.lerp(bb,j/max(1,int(d.length/2)-1))+n;solid('RailPost',p+Vector((0,0,.6)),(.16,.16,1.2),'wood','roads')
            else:category(beam('Curb',aa+n,bb+n,.18,'stoneLight','East'),'roads')
# Rounded, solid junctions close the ribbon gaps at every road corner.
widths={key:0 for key in nodes}
grades={key:[] for key in nodes}
for r in routes:
    for key in r['points']:widths[key]=max(widths[key],r['width'])
    for a,b in zip(r['points'],r['points'][1:]):
        d=Vector(nodes[b])-Vector(nodes[a]);g=Vector((d.x,d.y,0))*d.z/max(.001,d.x*d.x+d.y*d.y)
        grades[a].append(g);grades[b].append(g)
for key,p in nodes.items():
    sides=16;radius=widths[key]/2
    g=sum(grades[key],Vector())/max(1,len(grades[key]))
    verts=[(p[0]+radius*math.cos(j*math.tau/sides),p[1]+radius*math.sin(j*math.tau/sides),p[2]+.008+radius*(g.x*math.cos(j*math.tau/sides)+g.y*math.sin(j*math.tau/sides))) for j in range(sides)]
    o=category(mesh('Junction_'+key,verts,[tuple(range(sides))],'road','East'),'roads');o['walkable']=True
    m=o.modifiers.new('Road thickness','SOLIDIFY');m.thickness=.45;m.offset=-1
# Keep walkable geometry separate from rails/steps; merge by shared material for rendering.
for walkable,name in [(True,'RoadSurfaces'),(False,'RoadStructures')]:
    objects=[o for o in scene.objects if o.get('layer')=='roads' and bool(o.get('walkable'))==walkable]
    bpy.ops.object.select_all(action='DESELECT')
    for o in objects:
        o.select_set(True);bpy.context.view_layer.objects.active=o
        for m in list(o.modifiers):bpy.ops.object.modifier_apply(modifier=m.name)
    bpy.context.view_layer.objects.active=objects[0];bpy.ops.object.join();o=bpy.context.object;o.name='CE_'+name;o['layer']='roads';o['walkable']=walkable
# Bridge and jetty foundations are real solids, not floating road graphics.
for yy in [-43,-58]:
    for xx in [-37,-33]:solid('BridgePier',(xx,yy,1.4),(1.1,1.6,2.8),'earth','roads')
for xx in [10.8,13.2]:
    for yy in [-43,-49]:solid('DockPier',(xx,yy,1.3),(.25,.25,2.6),'wood','roads')

# Preserve and scale the project's authored mushroom-house components.

for name,x,y,r,h,col in sites:
    before=set(scene.objects);house(name,x,y,ground_height(x,y)+.12,r,h,col,'East',True,name=='Market');join_new(before,name,'buildings')
# The large timber guild: deep walls, a pitched slate roof, porch, gables and two towers.
before=set(scene.objects);gx,gy,gz=40,35,24.2
box('GuildFoot',(gx,gy,gz+.4),(23,16,.8),'stoneLight','Hall',.12)
box('GuildWalls',(gx,gy,gz+5.5),(21,14,10),'wall','Hall',.1)
box('GuildRoofL',(gx-5.7,gy,gz+12),(12.8,17,.7),'slate','Hall',.12).rotation_euler.y=-.55
box('GuildRoofR',(gx+5.7,gy,gz+12),(12.8,17,.7),'slate','Hall',.12).rotation_euler.y=.55
for xx in [gx-10,gx-5,gx,gx+5,gx+10]:beam('GuildFrontTimber',(xx,gy-7.05,gz+.6),(xx,gy-7.05,gz+10.5),.34,'wood','Hall')
for zz in [gz+.9,gz+5.5,gz+10]:beam('GuildCrossTimber',(gx-10,gy-7.10,zz),(gx+10,gy-7.10,zz),.28,'wood','Hall')
# Actual gable faces close the roof silhouette.
mesh('GuildGable',[(gx-11,gy-7.5,gz+10),(gx+11,gy-7.5,gz+10),(gx,gy-7.5,gz+15.5)],[(0,1,2)],'wall','Hall')
for sign in [-1,1]:beam('GuildGableBeam',(gx+sign*10.9,gy-7.55,gz+10),(gx,gy-7.55,gz+15.4),.28,'wood','Hall')
door('GuildDoor',gx,gy-7.14,gz+.8,3.4,5.4,'Hall')
for xx in [gx-7,gx+7]:
    window('GuildWindow',xx,gy-7.16,gz+1.8,2.3,3.4,'Hall');window('GuildUpperWindow',xx,gy-7.16,gz+6.2,1.6,2.6,'Hall')
window('GuildRoseWindow',gx,gy-7.59,gz+10.1,2.3,2.7,'Hall')
for xx in [gx-10,gx+10]:
    box('GuildTurret',(xx,gy+3,gz+10),(4.2,4.2,20),'wall','Hall',.06)
    for h in [gz+4,gz+10,gz+18]:box('TurretBelt',(xx,gy+3,h),(4.4,4.4,.32),'wood','Hall',.06)
    mesh('TurretRoof',[(xx-2.9,gy+.1,gz+20),(xx+2.9,gy+.1,gz+20),(xx+2.9,gy+5.9,gz+20),(xx-2.9,gy+5.9,gz+20),(xx,gy+3,gz+27)],[(0,1,4),(1,2,4),(2,3,4),(3,0,4)],'slate','Hall')
    window('TurretWindow',xx,gy+.87,gz+14,1.5,2.6,'Hall')
for zz in [0,.25,.5]:box('GuildPorchStep',(gx,gy-9-zz*3,gz+zz),(7.5,1.3,.25),'stoneLight','Hall',.05)
for xx in [gx-3.3,gx+3.3]:beam('GuildPorchPost',(xx,gy-9.5,gz+.6),(xx,gy-9.5,gz+5.8),.3,'wood','Hall')
box('GuildPorchRoof',(gx,gy-9,gz+5.8),(8,4,.6),'slate','Hall',.07)
join_new(before,'ArcherGuild','buildings')
# Training garden, village props, signs, awnings and lamps give the street human scale.
solid('GuildGarden',(40,21,24.38),(21,7,.18),'grass','props')
for xx in [31,40,49]:
    solid('TargetStand',(xx,22,25.5),(.15,.25,2.1),'wood','props');target=category(ringform('Target',(0,0,0),[(.7,-.06),(.7,.06)],'cream','East',24),'props');target.location=(xx,22,25.6);target.rotation_euler.x=math.pi/2
for x,y,z in [(-29,-14,3),(-18,-16,3),(-7,-12,3),(17,-20,3),(58,-23,3),(-54,-23,3)]:
    z=ground_height(x,y)+.14
    solid('StallCounter',(x,y,z+1),(3,1.8,1.7),'wood','props');solid('StallCanopy',(x,y,z+3),(4,2.8,.2),'cream','props')
    for dx in [-1.6,1.6]:solid('StallPost',(x+dx,y,z+1.5),(.16,.16,3),'honeywood','props')
# Quiet branch mouths use small posts and a curved rail, never a marker through the hidden soil.
for key in ['gardenW','rootEntry']:
    x,y,z=nodes[key]
    solid('TrailPost',(x-2.2,y,z+1),(.20,.20,2),'honeywood','props')
    solid('TrailBoard',(x-2.2,y,z+1.7),(1.4,.18,.48),'cream','props')
for a,p in nodes.items():
    if a in ['westCross','marketFront','central','gardenFront','eastCross','hallFrontW','hallFrontE','riverCross']:
        x,y,z=p;solid('StreetLampPole',(x,y+3,z+2),(.16,.16,4),'iron','props');before=set(scene.objects);lantern(x,y+3,z+4,'East');join_new(before,'Lantern','props')

# Import real CC0 plants once, then use linked data copies at measured sizes.
templates=[]
for filename,height in [('CommonTree_1',12),('CommonTree_2',13),('TwistedTree_1',12),('Bush_Common',1.1),('Flower_3_Group',.65),('Rock_Medium_1',2)]:
    before=set(scene.objects);bpy.ops.import_scene.gltf(filepath=VENDOR+filename+'.gltf');added=[o for o in scene.objects if o not in before];objs=[o for o in added if o.type=='MESH'];bpy.ops.object.select_all(action='DESELECT')
    for o in objs:o.select_set(True)
    bpy.context.view_layer.objects.active=objs[0];bpy.ops.object.join();t=bpy.context.object;bpy.ops.object.transform_apply(location=True,rotation=True,scale=True)
    low=min(v.co.z for v in t.data.vertices)
    for v in t.data.vertices:v.co.z-=low
    size=max(v.co.z for v in t.data.vertices);t.name='CE_Template_'+filename;t.hide_render=True;t.hide_set(True);templates.append((t,height/max(size,.01)))
    for o in added:
        if o!=t and o.name in bpy.data.objects:bpy.data.objects.remove(o,do_unlink=True)

def plant(index,p,scale=1):
    t,s=templates[index];o=t.copy();o.data=t.data;scene.collection.objects.link(o);o.name='CE_Plant';o.hide_render=False;o.hide_set(False);o.location=p;o.scale=(s*scale,)*3;o.rotation_euler.z=rng.random()*math.tau;o['layer']='vegetation';o['license']='CC0 Quaternius';return o

def street_distance(x,y):
    best=1000
    for r in routes:
        for a,b in zip(r['points'],r['points'][1:]):
            p,q=nodes[a],nodes[b];dx=q[0]-p[0];dy=q[1]-p[1];t=max(0,min(1,((x-p[0])*dx+(y-p[1])*dy)/(dx*dx+dy*dy)));d=math.hypot(x-p[0]-t*dx,y-p[1]-t*dy)-r['width']/2;best=min(best,d)
    return best
for i in range(220):
    x=rng.uniform(-98,98);y=rng.uniform(-36,61)
    if street_distance(x,y)<3:continue
    if any(math.hypot(x-h[1],y-h[2])<h[3]*1.5+1 for h in sites):continue
    if 23<x<56 and 18<y<47:continue
    z=ground_height(x,y)
    plant(i%3,(x,y,z),rng.uniform(.65,1.1))
for i in range(85):
    x=rng.uniform(-160,160);y=rng.uniform(65,160);z=6+(y-61)/12*2.8+12*math.sin(x*.035+(y-61)/12*.47)**2+10*math.cos(x*.04-(y-61)/12*.13)**2;plant(i%3,(x,y,z),rng.uniform(.8,1.6))
for i in range(46):plant(i%3,(rng.uniform(-110,110),rng.uniform(-94,-71),2.1),rng.uniform(.7,1.3))
for i in range(180):
    x=rng.uniform(-85,85);y=rng.uniform(-40,45)
    if street_distance(x,y)<.7:continue
    if any(math.hypot(x-h[1],y-h[2])<h[3]*1.32 for h in sites) or 22<x<58 and 20<y<47:continue
    z=ground_height(x,y)
    plant(3+i%3,(x,y,z),rng.uniform(.7,1.2))
for t,_ in templates:bpy.data.objects.remove(t,do_unlink=True)
layout={'name':'初弦地东边村落','units':'metres','axis':'Blender Z-up; glTF Y-up','previewOnly':True,'nodes':nodes,'routes':routes,'landmarks':{'guild':[40,35,24],'market':[-18,-2,ground_height(-18,-2)],'garden':[38,-9,ground_height(38,-9)],'river':[12,-43,1.8]},'characterHeight':1.8,'hiddenPlaces':{'flowerLane':'gardenN','rootHollow':'rootHollow'},'fixedCamera':{'pitch':.24,'yaw':0,'pixelsPerMetre':45,'zoom':1.2,'fov':38,'source':'client/src/features/henesys/view.ts default pitch .24, yaw 0, FOV 38; preview zoom 1.2, 45px/metre at zoom 1'}}
scene['layout']=json.dumps(layout,ensure_ascii=False)
scene['source']='chuxian-town-panorama-v1.png; authored spatial interpretation, not TMS collision'
scene.world=bpy.data.worlds.new('CE_Morning');scene.world.use_nodes=True;next(n for n in scene.world.node_tree.nodes if n.type=='BACKGROUND').inputs[0].default_value=(.59,.72,.81,1)
lightdata=bpy.data.lights.new('CE_Sun','SUN');lightdata.energy=2.5;lightdata.angle=.15;sun=bpy.data.objects.new('CE_Sun',lightdata);scene.collection.objects.link(sun);sun.rotation_euler=(.48,-.6,-.5)
camdata=bpy.data.cameras.new('CE_Camera');cam=bpy.data.objects.new('CE_Camera',camdata);scene.collection.objects.link(cam);scene.camera=cam;cam.location=(-105,-157,125);target=Vector((8,8,9));cam.rotation_euler=(target-cam.location).to_track_quat('-Z','Y').to_euler();camdata.type='PERSP';camdata.lens=42
scene.render.engine='CYCLES';scene.cycles.samples=24;scene.render.resolution_x=1600;scene.render.resolution_y=1000;scene.render.resolution_percentage=100
for image in bpy.data.images:
    if image.name.startswith('CE_') or image.filepath and 'Stylized Nature' in image.filepath:image.pack()
# Fit the current viewport without changing other scene data.
for area in bpy.context.screen.areas:
    if area.type=='VIEW_3D':
        area.spaces.active.region_3d.view_distance=185;area.spaces.active.region_3d.view_location=target;area.spaces.active.region_3d.view_rotation=cam.rotation_euler.to_quaternion();area.spaces.active.shading.type='MATERIAL'
assert len(routes)==16 and len([o for o in scene.objects if o.get('layer')=='buildings'])==11
bpy.ops.wm.save_as_mainfile(filepath=OUT+'/models/chuxian-east.blend')
bpy.ops.export_scene.gltf(filepath=OUT+'/models/chuxian-east.glb',use_active_scene=True,export_extras=True,export_animations=False,export_lights=False,export_cameras=False)
print('CHUXIAN_EAST_SAVED',len(scene.objects),'nodes',len(nodes),'routes',len(routes))
