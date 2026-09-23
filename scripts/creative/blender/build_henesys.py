"""Astra-authored Henesys village. Execute in Blender's Python console/MCP.

Set HENESYS_ROOT to the checkout before exec. Only owns HN_ datablocks.
Original X/height relationships: TMS273 Map1/100000000, 45 px/metre.
Depth, construction and lighting are an authored first interpretation.
"""
import bpy, math, json, random, traceback, time
from pathlib import Path
from mathutils import Vector

ROOT = Path(globals().get('HENESYS_ROOT', Path(__file__).resolve().parents[3]))
OUT = ROOT / 'resources/scenes/henesys'
R = random.Random(2730923)
S = bpy.data.scenes.new('HN_Henesys')
bpy.context.window.scene = S
S['source'] = 'TMS273/Map/Map/Map1/100000000.img'
S['scope'] = 'Visual study. Original 2D actors; source collision is separate.'
S.unit_settings.scale_length = 1
C = {}
for name in ['Terrain', 'West', 'Market', 'Park', 'East', 'Windmill', 'Hall', 'Nature', 'Set']:
    c = bpy.data.collections.new('HN_' + name); S.collection.children.link(c); C[name] = c
M = {}

def mat(name, color, tex=None, rough=.78, emission=0):
    m = bpy.data.materials.new('HN_' + name); m.use_nodes = True
    m.diffuse_color = (*color, 1)
    p = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    p.inputs['Base Color'].default_value = (*color, 1); p.inputs['Roughness'].default_value = rough
    if tex:
        node = m.node_tree.nodes.new('ShaderNodeTexImage')
        node.image = bpy.data.images.load(str(OUT/'textures'/f'{tex}.png'), check_existing=True); node.image.pack()
        # Tint portable image using vertex/material color encoded into the pixels.
        if color != (1,1,1):
            image = node.image.copy(); image.name = 'HN_' + name + '_color'
            import numpy as np
            values = np.empty(len(image.pixels),dtype=np.float32); image.pixels.foreach_get(values)
            rgba = values.reshape(-1,4); rgba[:,:3] *= np.array(color)
            image.pixels.foreach_set(values); image.pack(); node.image = image
        m.node_tree.links.new(node.outputs['Color'],p.inputs['Base Color'])
        bump = m.node_tree.nodes.new('ShaderNodeBump'); bump.inputs['Strength'].default_value = .16
        bump.inputs['Distance'].default_value = .035
        m.node_tree.links.new(node.outputs['Color'],bump.inputs['Height']); m.node_tree.links.new(bump.outputs['Normal'],p.inputs['Normal'])
    if emission:
        p.inputs['Emission Color'].default_value = (*color,1); p.inputs['Emission Strength'].default_value = emission
    M[name] = m; return m

for args in [
 ('wood',(1,1,1),'timber'),('darkwood',(.50,.55,.58),'timber'),('honeywood',(1.2,1.2,1.08),'timber'),
 ('wall',(1,1,1),'plaster'),('pale',(1.04,1.04,1.0),'plaster'),('stone',(1,1,1),'stone'),
 ('stoneLight',(1.18,1.15,1.03),'stone'),('earth',(1,1,1),'earth'),('path',(1.4,1.38,1.24),'earth'),
 ('red',(.72,.18,.075),'cap'),('orange',(.94,.39,.08),'cap'),('yellow',(1,.73,.16),'cap'),
 ('green',(.52,.65,.15),'cap'),('cream',(1.03,.96,.76),'cap'),('grass',(.50,.65,.24),'leaf'),
 ('leaf',(.45,.63,.27),'leaf'),('leafLight',(.67,.78,.36),'leaf'),('leafDeep',(.30,.49,.30),'leaf')]: mat(*args)
for args in [('shadow',(.055,.071,.048)),('iron',(.13,.17,.15)),('gold',(.65,.36,.065)),('teal',(.15,.37,.38)),('flower',(.71,.42,.46)),('linen',(.89,.83,.62)),('water',(.22,.44,.43)),('roofSpot',(.98,.76,.30)),('window',(1,.58,.16),None,.4,1.2)]: mat(*args)

def mesh(name, verts, faces, material, group, uv=None, smooth=False):
    data = bpy.data.meshes.new('HN_'+name); data.from_pydata(verts,[],faces); data.update()
    obj = bpy.data.objects.new('HN_'+name,data); C[group].objects.link(obj)
    data.materials.append(M[material]); layer = data.uv_layers.new(name='UVMap')
    for poly in data.polygons:
        poly.use_smooth = smooth
        normal = poly.normal; axes = [i for i in range(3) if i != max(range(3),key=lambda i:abs(normal[i]))]
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
        mod = o.modifiers.new('Soft worked edges','BEVEL'); mod.width = min(bevel,min(dims)*.2); mod.segments = 2
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

def stair(name,a,b,width,group):
    a,b=Vector(a),Vector(b); count=max(1,int(abs(b.z-a.z)/.22)); delta=b-a
    for i in range(count):
        p=a+delta*(i+.5)/count
        box(name,p,(width,abs(delta.y)/count+.1,.25),'stoneLight',group,.04)
    for side in [-1,1]:
        beam(name+'Rail',a+Vector((side*width*.53,0,.85)),b+Vector((side*width*.53,0,.85)),.10,'wood',group)
        for f in [0,.5,1]:
            p=a+delta*f+Vector((side*width*.53,0,0)); beam(name+'Post',p,p+Vector((0,0,.93)),.14,'wood',group)

# Continuous, legible main street, with the original west basin and park rise.
profile=[(-66,3.3),(-56,3.3),(-47,3.2),(-42,2.8),(-39,.05),(-23,.05),(-19,2.9),(-10,3.0),(-6,3.0),(0,.05),(66,.05)]
vs=[]
for x,z in profile:vs.extend([(x,-8,-3),(x,11,-3),(x,-8,z),(x,11,z)])
fs=[]
for i in range(len(profile)-1):
    a=i*4;b=a+4;fs.extend([(a+2,b+2,b+3,a+3),(a,b,b+2,a+2),(a+1,a+3,b+3,b+1),(a,a+1,b+1,b)])
fs.extend([(0,2,3,1),(len(vs)-4,len(vs)-3,len(vs)-1,len(vs)-2)])
mesh('ContinuousVillageGround',vs,fs,'earth','Terrain')
def ground(x):
    for (xa,za),(xb,zb) in zip(profile,profile[1:]):
        if xa<=x<=xb:return za+(zb-za)*(x-xa)/(xb-xa)
    return 0
# Broad grass verges and a warm path; never place tall props in the road strip.
for i in range(132):
    x=-65.5+i; z=ground(x)
    box('StreetSurface',(x,-3.7,z+.025),(1.04,3.8,.08),'path','Terrain',.0)
    for y,w in [(1.7,6.7),(-6.9,2.55)]:box('LivingGrass',(x,y,z+.025),(1.04,w,.08),'grass','Terrain',0)
# Broken masonry embankment; not thousands of identical pebbles.
for i in range(100):
    x=-65.4+i*1.32
    for k in range(max(2,int((ground(x)+3)/.86))):
        o=box('BankStone',(x+(k%2)*.38,-8.03,-2.6+k*.84),(R.uniform(.95,1.40),.48,R.uniform(.65,.85)),'stoneLight' if R.random()<.4 else 'stone','Terrain',.15,R.uniform(-.07,.07))
# Park and upper windmill platform correspond to original elevated strips.
box('ParkEarth',(-3.8,4.2,2.45),(19.5,14.5,4.9),'earth','Park',.38)
box('ParkTurf',(-3.8,4.2,5.0),(19.7,14.6,.25),'grass','Park',.12)
box('WindmillEarth',(28.2,9.0,5.45),(20.3,12.7,10.9),'earth','Windmill',.35)
box('WindmillTurf',(28.2,9.0,11.03),(20.5,12.8,.27),'grass','Windmill',.12)
for group,lo,hi,y,top in [('Park',-13.4,5.8,-3.05,4.9),('Windmill',18.2,38.1,2.62,10.9)]:
    for k in range(int(top/.8)):
        for i in range(int((hi-lo)/1.2)):
            x=lo+i*1.2+(k%2)*.45
            box('TerraceMasonry',(x,y,.4+k*.8),(1.14,.58,.70),'stoneLight' if (i+k)%3 else 'stone',group,.14,R.uniform(-.06,.06))
    for x in [lo+.5,hi-.6]:
        for z in [top-1.8,top-.6]:box('TerraceQuoin',(x,y-.1,z),(.78,.77,.48),'stoneLight',group,.09)
    fence(lo+.4,hi-.4,y+.35,top+.13,group)
# Authored depth links, clearly separate from the original collision data.
# Park stairs are added after the source landmark offset below.
stair('UpperGardenSteps',(40,0,.1),(40,15,11.1),2.2,'Windmill')

# WEST: original landmark centers from source image rectangles.
tower('WestBellTower',-61.0,1.2,3.35,2.6,5.55,'red','West')
# Bell gallery under the giant cap: a real hanging bell in an open dark arch.
arch('BellGallery',-61,-1.10,7.0,2.3,1.9,'shadow','West')
ringform('BrassBell',(-61,-1.25,7.45),[(.65,0),(.52,.16),(.30,.67),(.24,.85)],'gold','West',32)
beam('BellHanger',(-61,-1.20,8.2),(-61,-1.20,8.8),.12,'darkwood','West')
# Green long-roof cottage with a low grassy canopy and several arches.
box('LonghousePlinth',(-35.7,2.3,3.15),(11.9,5.8,.5),'stoneLight','West',.15)
box('LonghousePlaster',(-35.7,2.3,4.60),(11.1,4.9,2.5),'wall','West',.30)
for xx in [-40,-38,-35.5,-33,-31.5]:
    window('LonghouseWindow',xx,-.21,3.8,.85,1.3,'West')
for xx in [-39.6,-31.7]:door('LonghouseDoor',xx,-.3,3.4,1.2,2.15,'West')
for xx,rr in [(-39.2,3.1),(-35.8,3.4),(-32.1,3.1)]:cap('LonghouseCanopy',(xx,2.3,5.5),rr,1.7,'green','West',False)
tower('LonghouseCupola',-35.4,2.65,6.65,1.13,1.75,'green','West')
for xx in [-40.4,-37.9,-33.4,-31.0]:beam('LonghouseTimber',(xx,-.24,3.5),(xx,-.24,5.7),.20,'wood','West')
# Low brown companion house, originally between longhouse and slim tower.
house('CottageUmber',-24.9,2.2,3.05,3.05,2.65,'orange','West',False)
tower('SlenderTownTower',-19.2,2.0,3.08,2.06,7.5,'orange','West')
ringform('TowerBalcony',(-19.2,2.0,7.3),[(2.6,0),(2.6,.16)],'wood','West')
fence(-21.2,-17.1,-.03,7.46,'West')
# Wheat stacks and flower beds carry the west's agricultural character.
for x,y,z in [(-47,1,3.3),(-48.3,1.2,3.3),(-47.8,1.1,4.35)]:
    box('StrawBale',(x,y,z+.52),(1.3,1.1,1),'linen','West',.18)
    for dx in [-.36,.36]:box('BaleTie',(x+dx,y-.565,z+.52),(.06,.04,.98),'wood','West',.01)
# A small western shrine/portal frame is a physical masonry arch, not a gameplay portal.
for dx in [-1,1]:box('ShrinePillar',(-44+dx,4.7,6.7),(.62,.75,3.0),'stoneLight','West',.09)
box('ShrineLintel',(-44,4.7,8.15),(2.9,.9,.48),'stoneLight','West',.08)
box('ShrineRoof',(-44,4.7,8.55),(3.25,1.65,.36),'yellow','West',.10)
arch('ShrineOpening',-44,4.66,5.2,1.30,2.5,'teal','West')

# MARKET: recognisable wood-framed HENESYS entrance in the original central gap.
for xx in [-11.6,-5.1]:
    beam('MarketLivingPost',(xx,-.7,3.0),(xx+.22,-.7,9.2),.34,'wood','Market')
    beam('MarketBrace',(xx,-.7,7.6),(xx+(1 if xx<-8 else -1),-.7,8.8),.21,'honeywood','Market')
box('VillageSignBoard',(-8.3,-.72,8.65),(7.9,.35,1.72),'wood','Market',.20,yaw=-.025)
box('VillageSignFace',(-8.3,-.93,8.65),(7.55,.06,1.35),'teal','Market',.1)
def text(name,body,p,size,material,group):
    data=bpy.data.curves.new('HN_'+name,'FONT');data.body=body;data.size=size;data.align_x='CENTER';data.extrude=.008
    o=bpy.data.objects.new('HN_'+name,data);C[group].objects.link(o);o.location=p;o.rotation_euler=(math.pi/2,0,0);data.materials.append(M[material]);return o
text('VillageLettering','H E N E S Y S',(-8.3,-.99,8.5),.66,'cream','Market')
text('MarketLettering','MARKET',(-8.3,-1,7.97),.30,'roofSpot','Market')
# Original market stall structure; restrained stripes and produce, not extra neon.
for xx in [-12.2,-4.2]:
    box('MarketCounter',(xx,1.8,3.6),(2.7,1.4,1.0),'wood','Market',.07)
    for dx in [-1.3,1.3]:beam('StallPost',(xx+dx,2.2,3.1),(xx+dx,2.2,5.9),.15,'honeywood','Market')
    for i in range(7):
        x=xx-1.5+i*.5
        mesh('StripedCanopy',[(x,2.6,6),(x+.5,2.6,6),(x+.5,.45,5.35),(x,.45,5.35)],[(0,1,2,3)],'linen' if i%2 else 'teal','Market')
        box('AwningScallop',(x+.25,.43,5.25),(.49,.06,.25),'linen' if i%2 else 'teal','Market',.06)
    for dx in [-.8,0,.8]:
        box('ProduceCrate',(xx+dx,1.6,4.2),(.66,.8,.34),'honeywood','Market',.04)
        for j in range(4):ringform('Produce',(xx+dx+R.uniform(-.22,.22),1.6+R.uniform(-.22,.22),4.3),[(.10,0),(.14,.12),(.08,.24)],'orange' if dx<0 else 'green','Market',10)

# PARK: stone entrance and white fencing, behind the central street.
for xx in [-4.7,1.0]:
    box('ParkGatePillar',(xx,1.2,6.9),(.76,.95,3.6),'stoneLight','Park',.10)
    box('ParkGateCapital',(xx,1.2,8.75),(1.1,1.1,.32),'stoneLight','Park',.06)
tube('ParkStoneArch',[(x,1.2,8.65+1.08*math.sin(math.pi*i/24)) for i,x in enumerate([-4.7+i*5.7/24 for i in range(25)])],.38,'stoneLight','Park',10)
box('ParkName',(-1.85,.72,8.99),(4.6,.16,.68),'stone','Park',.08)
text('ParkLetters','MUSHROOM PARK',(-1.85,.61,8.78),.30,'cream','Park')
for xx in [-8.0,3.5]:
    box('ParkBench',(xx,1.0,5.66),(2.55,.8,.18),'wood','Park',.05)
    box('ParkBenchBack',(xx,1.38,6.15),(2.55,.12,.55),'wood','Park',.04)
    for dx in [-.9,.9]:beam('BenchLeg',(xx+dx,1,5.1),(xx+dx,1,5.6),.16,'iron','Park')

# Source park gateway center is x≈3739px: +10.1m, behind the lower east homes.
for o in C['Park'].objects: o.location += Vector((12,6,2.15))
box('ParkLowerFoundation',(8.2,10.2,1.05),(19.5,14.5,2.1),'stone','Park',.12)
stair('ParkSideSteps',(19,-1,.1),(19,13,7.2),2.1,'Park')

# EAST: the lower main street runs in front of all facades.
house('EastSpottedHome',8.9,1.0,.12,3.9,3.3,'orange','East',True)
house('YellowTeahouse',20.6,1.2,.12,3.15,3.25,'yellow','East',False)
house('TailorTwoStorey',31.8,1.0,.12,2.65,5.2,'orange','East',False,True)
house('Workshop',38.8,1.2,.12,2.8,3.2,'orange','East',False)
house('GoldenShop',45.1,1.6,.12,3.2,3.35,'yellow','East',False)
# Workshop log stock and stone oven are silhouette-specific source details.
for j in range(3):beam('WorkshopLogs',(40.9,.7,4.3+j*.3),(42.8,.7,4.3+j*.3),.32,'wood','East')
ringform('WorkshopOven',(41.5,-.6,.1),[(1.15,0),(1.15,.9),(.9,1.7),(.3,2.2)],'stone','East',24)
arch('OvenMouth',41.5,-1.66,.3,1.25,1.45,'shadow','East')
# Upper windmill, little gold tower, and scissors house retain their left-to-right order.
tower('WindmillTower',24.1,9.0,11.2,1.85,4.25,'yellow','Windmill')
house('BarberShop',32.8,9.0,11.2,3.45,3.5,'orange','Windmill',True)
# Four lattice sails, in a plane facing the main camera; true geometry and timber joinery.
hub=Vector((24.1,6.85,17.1))
for j in range(4):
    t=j*math.pi/2+.15; direction=Vector((math.cos(t),0,math.sin(t))); side=Vector((-math.sin(t),0,math.cos(t)))
    beam('WindmillSpar',hub-direction*.4,hub+direction*4.4,.15,'darkwood','Windmill')
    for k in range(6):
        p=hub+direction*(1.3+k*.52)
        beam('WindmillRung',p,p+side*.92,.075,'honeywood','Windmill')
        if k<5:
            q=p+direction*.5
            mesh('SailLinen',[p+side*.09,q+side*.09,q+side*.85,p+side*.85],[(0,1,2,3)],'linen','Windmill')
    beam('WindmillOuterFrame',hub+direction*1.3+side*.92,hub+direction*3.95+side*.92,.10,'wood','Windmill')
ringform('WindmillAxle',(0,0,0),[(.44,-.25),(.44,.25)],'iron','Windmill',24).rotation_euler.x=math.pi/2
# Correct the axle from local construction to its village position.
C['Windmill'].objects[-1].location=hub
for dx in [-.52,.52]:
    tube('ScissorsLoop',[(32.8+dx+.36*math.cos(t),8.6,18.65+.43*math.sin(t)) for t in [i*2*math.pi/24 for i in range(25)]],.11,'red','Windmill')
beam('ScissorsBladeA',(32.28,8.6,18.4),(33.25,8.6,17.65),.10,'iron','Windmill')
beam('ScissorsBladeB',(33.32,8.6,18.4),(32.35,8.6,17.65),.10,'iron','Windmill')

# RIGHT: the tall wooded bowmaster hall with satellite turret roofs.
house('BowmasterHall',57.5,3.0,.15,5.6,6.6,'red','Hall',True)
for x,y,z,r,h,col in [(53.8,3.7,6.3,1.8,5.3,'orange'),(60.4,4.9,8.4,1.65,5.0,'yellow'),(62.0,1.2,1.2,1.8,4.6,'orange')]:tower('HallTurret',x,y,z,r,h,col,'Hall')
# Tall timber portal replacing ordinary small porch at the main hall.
for dx in [-1.2,1.2]:beam('HallPortalPost',(57.5+dx,-2.52,.4),(57.5+dx,-2.52,4.1),.30,'darkwood','Hall')
beam('HallGableLeft',(56.1,-2.52,3.9),(57.5,-2.52,5.3),.29,'honeywood','Hall')
beam('HallGableRight',(57.5,-2.52,5.3),(58.9,-2.52,3.9),.29,'honeywood','Hall')
for dx in [-2.65,2.65]:
    box('ArcheryBanner',(57.5+dx,-2.8,2.6),(.80,.09,2.25),'red','Hall',.025)
    tube('BannerBow',[(57.5+dx+.25*math.sin(t),-2.87,2.6+.68*math.cos(t)) for t in [i*math.pi/20 for i in range(21)]],.055,'roofSpot','Hall')
    beam('BannerArrow',(57.5+dx,-2.88,1.99),(57.5+dx,-2.88,3.23),.035,'roofSpot','Hall')

# A few baskets, barrels, planted boxes and street lamps unite the village scale.
for x in [-57,-30,-16,14.8,26.3,49,64]:
    z=ground(x)
    ringform('Barrel',(x,-.6,z+.07),[(.47,0),(.54,.35),(.56,.66),(.47,1.1)],'wood','West' if x<0 else 'East',24)
    for h in [.18,.9]:ringform('BarrelHoop',(x,-.6,z+.07),[(.52,h),(.54,h+.08)],'iron','West' if x<0 else 'East',24)
for x in [-51,-27,16,48]:
    z=ground(x);beam('StreetLampPost',(x,-.35,z),(x,-.35,z+3.4),.16,'wood','West' if x<0 else 'East')
    lantern(x,-.7,z+3.1,'West' if x<0 else 'East')
# Stone pavers down the road, irregular and sparse enough to keep a quiet broad color field.
for i in range(95):
    x=R.uniform(-64,65);y=R.uniform(-5.2,-2.35)
    box('PathPaver',(x,y,ground(x)+.10),(R.uniform(.25,.65),R.uniform(.24,.49),.035),'stoneLight','Terrain',.08,R.uniform(-.45,.45))

# Reuse the existing CC0 plant meshes, never procedurally invent substitute trees.
plant_sources={}
for name in ['tree_oak','tree_default','plant_bushDetailed','grass','flower_yellowA','flower_purpleA']:
    before=set(S.objects)
    bpy.ops.wm.obj_import(filepath=str(OUT/'vegetation'/f'{name}.obj'))
    objects=[o for o in S.objects if o not in before and o.type=='MESH']
    for o in objects:
        for c in list(o.users_collection):c.objects.unlink(o)
        C['Nature'].objects.link(o)
        o.name='HN_Source_'+name; o['license']='CC0-1.0'; o['source']='Kenney Nature Kit 2.1/'+name
        for i,m in enumerate(o.data.materials):
            s=m.name.lower(); o.data.materials[i]=M['wood' if 'wood' in s or 'bark' in s else 'roofSpot' if 'yellow' in s else 'flower' if 'purple' in s else 'leaf']
        for p in o.data.polygons:p.use_smooth=True
        o.hide_render=True;o.hide_set(True)
    # OBJ source axes are converted by the importer. Bounds determine the height.
    points=[o.matrix_world@Vector(p) for o in objects for p in o.bound_box]
    plant_sources[name]=(objects,min(p.z for p in points),max(p.z for p in points)-min(p.z for p in points))

def plant(name,p,height,tint=None):
    objects,low,h=plant_sources[name];scale=height/h;yaw=R.uniform(0,math.pi*2)
    for src in objects:
        o=src.copy();o.data=src.data;C['Nature'].objects.link(o);o.hide_render=False;o.hide_set(False)
        o.name='HN_'+name;o.location=Vector(p)+Vector((0,0,-low*scale));o.scale=tuple(v*scale for v in src.scale);o.rotation_euler.z+=yaw
        if tint:
            # Independent material slot mapping without duplicating geometry.
            for i,m in enumerate(o.data.materials):
                if m==M['leaf']:o.material_slots[i].link='OBJECT';o.material_slots[i].material=M[tint]
    return o
# Behind the houses: layered canopy islands, keeping roofs and the park gate visible.
for x,y,h,z in [(-64,8,9,3),(-52,8,11,3),(-46,8,8,3),(-42,10,10,3),(-29,10,11,3),(-22,10,9,3),(-15,8,10,3),(-2,14,9,7.2),(14,15,11,7.2),(11,9,11,0),(17,12,9,0),(26,16,9,11),(36,16,8,11),(46,10,10,0),(52,9,13,0),(58,11,18,0),(63,7,14,0)]:
    plant('tree_oak',(x,y,z),h,R.choice(['leaf','leafLight','leafDeep']))
# Distant borrowed trees add atmosphere in real depth rather than a painted backdrop.
for i in range(27):plant('tree_default',(-72+i*5.6,24+R.uniform(-2,7),-1),R.uniform(12,20),'leafDeep')
for i in range(110):
    x=R.uniform(-65,66);y=R.choice([R.uniform(-7.9,-6.2),R.uniform(4.0,7.0)])
    if -2<x<18 and y>3: z=7.25
    elif 18<x<39 and y>3:z=11.2
    else:z=ground(x)
    plant('plant_bushDetailed',(x,y,z),R.uniform(.42,1.1),'leafLight' if i%4 else 'leafDeep')
for i in range(170):
    x=R.uniform(-65,65);y=R.uniform(-7.8,-6.05);z=ground(x)
    plant('grass' if i%3 else 'flower_yellowA' if i%2 else 'flower_purpleA',(x,y,z+.07),R.uniform(.23,.65))
# Planter boxes and flowers near doors (all below the character's sightline).
for x,y,z in [(-39,-.7,3.35),(-21,-.3,3.15),(6,-2,.15),(19,-2,.15),(34,-1.4,.15),(44,-1.7,.15),(54,-2,.15),(30,5.7,11.3)]:
    box('WindowFlowerBox',(x,y,z+.22),(1.5,.6,.43),'wood','West' if x<0 else 'East',.06)
    for j in range(5):plant('flower_purpleA' if j%2 else 'flower_yellowA',(x-.6+j*.3,y,z+.45),.47)

# Lighting is authored, not exported as baked white glow. Portable PBR remains readable.
world=bpy.data.worlds.new('HN_SoftSky');S.world=world;world.use_nodes=True
background=next(n for n in world.node_tree.nodes if n.type=='BACKGROUND');background.inputs['Color'].default_value=(.46,.62,.69,1);background.inputs['Strength'].default_value=.45
ld=bpy.data.lights.new('HN_WarmSun','SUN');ld.energy=2.4;ld.angle=math.radians(12)
light=bpy.data.objects.new('HN_WarmSun',ld);C['Set'].objects.link(light);light.rotation_euler=(math.radians(28),math.radians(-25),math.radians(-28))
ld=bpy.data.lights.new('HN_SkyFill','AREA');ld.energy=3200;ld.shape='DISK';ld.size=80
light=bpy.data.objects.new('HN_SkyFill',ld);C['Set'].objects.link(light);light.location=(0,-28,48);light.rotation_euler=(.28,0,0)
# A simple continuous ground beyond the village hides any diorama void.
box('FarGround',(0,36,-3.8),(240,140,1),'grass','Terrain',.4)
camd=bpy.data.cameras.new('HN_Overview');cam=bpy.data.objects.new('HN_Overview',camd);C['Set'].objects.link(cam);S.camera=cam
cam.location=(1,-137,67);target=Vector((0,3,7));cam.rotation_euler=(target-cam.location).to_track_quat('-Z','Y').to_euler();camd.type='ORTHO';camd.ortho_scale=151;camd.lens=48
S.render.resolution_x=2400;S.render.resolution_y=1080;S.render.resolution_percentage=100
try:S.render.engine='CYCLES'
except TypeError:pass
S.cycles.samples=40;S.cycles.use_denoising=True
S.render.image_settings.file_format='PNG'
S.render.filepath=str(OUT/'previews/henesys-overview.png')
S.view_settings.exposure=0
# A second physical camera is saved for reproducible representative detail.
for name,pos,target,lens in [('West',( -35,-28,17),(-36,1,5),45),('East',(28,-29,16),(29,2,5),42),('Hall',(69,-24,15),(57,3,7),46)]:
    data=bpy.data.cameras.new('HN_Close'+name);ob=bpy.data.objects.new('HN_Close'+name,data);C['Set'].objects.link(ob)
    ob.location=pos;ob.rotation_euler=(Vector(target)-ob.location).to_track_quat('-Z','Y').to_euler();data.lens=lens
# Layout annotations are inspectable empties, never part of exported visual/collision.
S['landmarks'] = json.dumps({'westBell':-61,'longhouse':-35.7,'townTower':-19.2,'market':-8.3,'park':10.15,'windmill':24.1,'barber':32.8,'hall':57.5})
S['temporary_event_excluded']='TMS273 20th anniversary suspended event platform; permanent village only'
S['style_reference']='Text-only cinematic fairy-tale interpretation; shared original image unavailable'
S['source_pixels_per_metre']=45
S['draw_calls_note']='Editable native objects. GLB export joins evaluated geometry per district.'
# Leave one small, runnable structural check with the build.
assert len([o for o in S.objects if 'Cap' in o.name])>=18
assert len([o for o in S.objects if 'WindmillSpar' in o.name])==4
assert all(o.get('role')!='collision' for o in S.objects)
assert S.camera is cam
for image in bpy.data.images:
    if image.name.startswith('HN_') or '/henesys/' in image.filepath:
        if image.has_data:image.pack()
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'models/henesys.blend'))
(OUT/'logs/build.json').write_text(json.dumps({'status':'built','scene':S.name,'objects':len(S.objects),'meshes':len([o for o in S.objects if o.type=='MESH']),'landmarks':json.loads(S['landmarks']),'blender':bpy.app.version_string},indent=2),encoding='utf-8')
print('HENESYS_BUILD_DONE',len(S.objects))
