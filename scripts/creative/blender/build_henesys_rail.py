"""Run through Blender MCP with RAIL, FOOTHOLDS, NATURE and OUT supplied by host.

NATURE is a list of local glTF files from Quaternius' CC0 Standard pack.
Only HR_ scene data is replaced. Collision tops and underside thickness come
from the same source as Rust; deep cliff dressing stays behind the walking rail.
"""
import bpy
import math
import random
from mathutils import Vector

rng = random.Random(2730930)
for old in list(bpy.data.scenes):
    if old.name == 'HR_Henesys':
        for obj in list(old.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.scenes.remove(old)
scene = bpy.data.scenes.new('HR_Henesys')
bpy.context.window.scene = scene
scene['mapId'] = RAIL['mapId']
scene['railRadius'] = RAIL['radius']
scene['platformThickness'] = RAIL['platformThickness']
scene['axis'] = 'Blender Z up; glTF Y up; source x is rail arc distance'
ppm = RAIL['pixelsPerMetre']

def point(x, y, depth=0):
    a = (x - RAIL['originX']) / ppm / RAIL['radius']
    r = RAIL['radius'] - depth
    return (r * math.sin(a), -(RAIL['paperDepth'] + RAIL['radius'] - r * math.cos(a)), (RAIL['originY'] - y) / ppm)

def material(name, base):
    mat = bpy.data.materials.new('HR_' + name)
    mat.use_nodes = True
    mat.diffuse_color = (*base, 1)
    bsdf = next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Roughness'].default_value = .92
    image = bpy.data.images.new('HR_' + name, width=512, height=512)
    pixels = []
    for y in range(512):
        for x in range(512):
            u, w = x / 512, y / 512
            v = .9 + .08*math.sin(u*math.tau*3)*math.cos(w*math.tau*4) + rng.random()*.04
            if name == 'WarmStone':
                px, py = u*5, w*5
                ix, iy = math.floor(px), math.floor(py)
                distances = []
                for dy in [-1,0,1]:
                    for dx in [-1,0,1]:
                        gx, gy = (ix+dx)%5, (iy+dy)%5
                        hx = (math.sin(gx*127.1+gy*311.7)*43758.5453)%1
                        hy = (math.sin(gx*269.5+gy*183.3)*43758.5453)%1
                        distances.append((px-ix-dx-.2-.6*hx)**2+(py-iy-dy-.2-.6*hy)**2)
                distances.sort()
                edge = math.sqrt(distances[1])-math.sqrt(distances[0])
                v = .5 if edge < .025 else .82 + .20*min(1,edge*4)
                v += rng.random()*.045
            pixels.extend([min(1, c * v) for c in base] + [1])
    image.pixels.foreach_set(pixels)
    image.pack()
    node = mat.node_tree.nodes.new('ShaderNodeTexImage'); node.image = image
    mat.node_tree.links.new(node.outputs['Color'], bsdf.inputs['Base Color'])
    return mat

grass = material('Grass', (.36, .49, .18))
earth = material('WarmStone', (.43, .36, .25))
path = material('Path', (.68, .59, .39))
far_grass = material('DistantMeadow', (.30, .44, .32))

def ledge(name, f, front, back, thickness, top_material):
    # Short segments keep the rendered arc within a fraction of one source pixel.
    count = max(1, math.ceil((f['x2'] - f['x1']) / 45))
    verts, faces = [], []
    for i in range(count + 1):
        t = i / count
        x = f['x1'] + (f['x2'] - f['x1']) * t
        y = f['y1'] + (f['y2'] - f['y1']) * t
        verts.extend([point(x, y, front), point(x, y, back), point(x, y + thickness, front), point(x, y + thickness, back)])
    for i in range(count):
        a, b = i * 4, (i + 1) * 4
        faces.extend([(a, b, b+1, a+1), (a+2, a+3, b+3, b+2), (a, a+2, b+2, b), (a+1, b+1, b+3, a+3)])
    faces.extend([(0,1,3,2),(count*4,count*4+2,count*4+3,count*4+1)])
    data = bpy.data.meshes.new(name); data.from_pydata(verts, [], faces); data.update()
    obj = bpy.data.objects.new(name, data); scene.collection.objects.link(obj)
    data.materials.append(top_material); data.materials.append(earth)
    uv = data.uv_layers.new(name='UVMap')
    for poly in data.polygons:
        poly.material_index = 0 if poly.index % 4 == 0 and poly.index < count * 4 else 1
        axes = (0,1) if poly.material_index == 0 else (0,2)
        for li in poly.loop_indices:
            p = data.vertices[data.loops[li].vertex_index].co
            uv.data[li].uv = (p[axes[0]] * .14, p[axes[1]] * .14)
    obj['platformThickness'] = thickness; obj['footholdId'] = f['id']; obj['role'] = 'platform' if name.startswith('HR_Platform') else 'dressing'
    return obj

floors = list({(f['x1'],f['y1'],f['x2'],f['y2']): f for f in FOOTHOLDS if f['x2'] > f['x1']}.values())
for f in floors:
    is_deck = f['id'] in [d['id'] for d in RAIL['decks']]
    ledge(('HR_Deck_' if is_deck else 'HR_Platform_') + str(f['id']), f, .65,
          -1.2 if is_deck else .65 - RAIL['platformDepth'],
          RAIL['deckThickness'] if is_deck else RAIL['platformThickness'], grass)
    if not is_deck:
        ledge('HR_Garden_' + str(f['id']), f, .65 - RAIL['platformDepth'], -24, RAIL['platformThickness'], grass)
    trail = dict(f); trail['y1'] -= .05; trail['y2'] -= .05
    ledge('HR_Path_' + str(f['id']), trail, .24, -.48, .1, path)
# Decoration sits on the main street; upper decks are reserved for climbing.
floors = [f for f in floors if f['id'] not in [d['id'] for d in RAIL['decks']]]

# Rolling hills: one continuous height field behind the playable terraces.
verts, faces = [], []
cols = 91
for j in range(13):
    depth = -12 - j*7
    for i in range(cols):
        x = -1200 + i*100
        y = 370 - j*23 - 70*math.sin(x/650+j*.23) - 35*math.sin(x/270)
        verts.append(point(x,y,depth))
for j in range(12):
    for i in range(cols-1):
        a=j*cols+i
        faces.append((a,a+1,a+1+cols,a+cols))
data=bpy.data.meshes.new('HR_Meadow');data.from_pydata(verts,[],faces);data.update()
obj=bpy.data.objects.new('HR_Meadow',data);scene.collection.objects.link(obj);data.materials.append(far_grass)
for poly in data.polygons: poly.use_smooth=True

# Import authored vegetation; never substitute hand-built tree primitives.
templates = []
for asset in NATURE:
    before = set(scene.objects)
    bpy.ops.import_scene.gltf(filepath=asset['file'])
    added = [o for o in scene.objects if o not in before]
    meshes = [o for o in added if o.type == 'MESH']
    if not meshes:
        continue
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes: o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1: bpy.ops.object.join()
    obj = bpy.context.object
    obj.name = 'HR_Template_' + str(len(templates))
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    low = min(v.co.z for v in obj.data.vertices)
    for v in obj.data.vertices: v.co.z -= low
    obj.hide_render = True; obj.hide_set(True)
    templates.append((obj, asset))
    for other in added:
        if other.name in bpy.data.objects and other != obj and other.type != 'MESH':
            bpy.data.objects.remove(other, do_unlink=True)
assert templates, 'Download CC0 glTF vegetation before building the scene'

house_sites = [800, 2110, 3280, 4460, 5790]
sites = []
for x in range(420, 6200, 190):
    if any(abs(x - h) < 160 for h in house_sites): continue
    heights = sorted({f['y1'] + (x-f['x1'])/(f['x2']-f['x1'])*(f['y2']-f['y1']) for f in floors if f['x1'] <= x <= f['x2']})
    if heights:
        sites.append((x, heights[-1]))
        if heights[-1] - heights[0] > 170: sites.append((x, heights[0]))
for i, (x, y) in enumerate(sites):
    trees = [(t,a) for t,a in templates if a['kind'] == 'tree' and 'CommonTree' in a['file']]
    template, asset = trees[i % len(trees)]
    obj = template.copy(); obj.data = template.data
    obj.name = 'HR_Nature_' + str(i); scene.collection.objects.link(obj)
    obj.hide_render = False; obj.hide_set(False)
    obj.location = point(x, y, -2.3 - rng.random())
    height = max(v.co.z for v in obj.data.vertices)
    size = (3.8 + rng.random() * 2.7) / max(height, .01)
    obj.scale = (size, size, size)
    obj.rotation_euler.z = rng.random() * math.tau
    obj['role'] = 'CC0_Quaternius'

for i,x in enumerate(range(460,6200,145)):
    f=next(f for f in floors if f['x1']<=x<f['x2'])
    template,asset=trees[i%len(trees)]
    obj=template.copy();obj.data=template.data;scene.collection.objects.link(obj)
    obj.name='HR_Nature_Forest_'+str(i);obj.hide_render=False;obj.hide_set(False)
    obj.location=point(x,f['y1'],-10-rng.random()*5)
    size=(7+rng.random()*3)/max(max(v.co.z for v in obj.data.vertices),.01)
    obj.scale=(size,size,size);obj.rotation_euler.z=rng.random()*math.tau
    obj['role']='CC0_Quaternius'

small = [(t,a) for t,a in templates if a['kind'] != 'tree']
for i, x in enumerate(range(400, 6200, 55)):
    surfaces = [f for f in floors if f['x1'] <= x <= f['x2']]
    if not surfaces: continue
    def surface_height(f):
        return f['y1']
    f = max(surfaces, key=surface_height)
    y = f['y1'] + (x-f['x1'])/(f['x2']-f['x1'])*(f['y2']-f['y1'])
    template, asset = small[i % len(small)]
    obj = template.copy(); obj.data = template.data
    obj.name = 'HR_Nature_Detail_' + str(i); scene.collection.objects.link(obj)
    obj.hide_render = False; obj.hide_set(False)
    obj.location = point(x, y, -.85 - rng.random() * 2.5)
    size = asset['height'] / max(max(v.co.z for v in obj.data.vertices), .01)
    obj.scale = (size,size,size); obj.rotation_euler.z = rng.random() * math.tau
    obj['role'] = 'CC0_Quaternius'

# Reuse the previous authored mushroom geometry with the current curved rail.
# Viewed reference: TMS273 100000000; depth and volume are authored interpretations.
C = {name: scene.collection for name in ['West','Market','Park','East','Hall']}
M = {}
for name, color in [('wall',(.91,.79,.55)),('stoneLight',(.65,.69,.56)),
    ('wood',(.34,.18,.07)),('darkwood',(.17,.09,.035)),('honeywood',(.56,.33,.12)),
    ('red',(.85,.16,.045)),('orange',(1,.37,.025)),('yellow',(1,.68,.07)),
    ('green',(.43,.57,.09)),('cream',(.98,.85,.58)),('roofSpot',(1,.76,.18)),
    ('shadow',(.045,.04,.025)),('iron',(.15,.17,.13)),('gold',(.74,.46,.06)),('window',(1,.62,.18))]:
    m = bpy.data.materials.new('HR_House_' + name); m.use_nodes = True
    bsdf = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Base Color'].default_value = (*color,1)
    bsdf.inputs['Roughness'].default_value = .72
    if name == 'window':
        bsdf.inputs['Emission Color'].default_value = (*color,1)
        bsdf.inputs['Emission Strength'].default_value = .35
    M[name] = m
def mesh(name, verts, faces, material, group, uv=None, smooth=False):
    data = bpy.data.meshes.new('HR_Landmark_'+name); data.from_pydata(verts,[],faces); data.update()
    obj = bpy.data.objects.new('HR_Landmark_'+name,data); C[group].objects.link(obj)
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


landmarks = [(800,1.65,4.1,'red','WestTower'),(1571,2.25,2.9,'green','Market'),
    (2110,1.65,4.3,'orange','MarketTower'),(2931,2.15,3.0,'yellow','ParkCottage'),
    (3741,2.25,3.1,'red','MayaHouse'),(4330,1.7,4.8,'yellow','Windmill'),
    (4918,2.2,3.3,'orange','HairSalon'),(5073,1.8,2.7,'yellow','Shop'),
    (5707,3.0,5.4,'red','ArcherHall')]
for x,r,h,color,name in landmarks:
    f = next(f for f in floors if f['x1'] <= x < f['x2'])
    before=set(scene.objects)
    if name.endswith('Tower'): tower(name,0,0,0,r,h,color,'West')
    else: house(name,0,0,0,r,h,color,'East',True,name=='ArcherHall')
    if name == 'Windmill':
        for turn in [0,math.pi/2]:
            for sign in [-1,1]:
                u,v=sign*math.cos(turn),sign*math.sin(turn)
                beam('Sail',(0,-r-.4,h+.8),(u*3.1,-r-.4,h+.8+v*3.1),.19,'wood','East')
                sail=box('SailCloth',(u*2,-r-.4,h+.8+v*2),(2.2,.13,.48),'cream','East')
                sail.rotation_euler.y=-turn
    objects=[o for o in scene.objects if o not in before and o.type=='MESH']
    bpy.ops.object.select_all(action='DESELECT')
    for o in objects:o.select_set(True)
    for o in objects:
        bpy.context.view_layer.objects.active=o
        for mod in list(o.modifiers): bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.context.view_layer.objects.active=objects[0]; bpy.ops.object.join()
    obj=bpy.context.object; obj.name='HR_Landmark_'+name
    a=(x-RAIL['originX'])/ppm/RAIL['radius']
    obj.location=point(x,f['y1'],-3.8); obj.rotation_euler.z=-a
    obj['source']='TMS273/Map/Map1/100000000.img; authored volume'
    obj['landmark']=name;obj['railX']=x
x=2931;f=next(f for f in floors if f['x1']<=x<f['x2'])
base=Vector(point(x,f['y1'],-.75));a=(x-RAIL['originX'])/ppm/RAIL['radius']
before=set(scene.objects)
for u in [-1.45,1.45]:box('ParkGatePillar',(u,0,1.8),(.5,.55,3.6),'stoneLight','Park')
box('ParkGateLintel',(0,0,3.65),(3.5,.65,.55),'stoneLight','Park')
objects=[o for o in scene.objects if o not in before]
bpy.ops.object.select_all(action='DESELECT')
for o in objects:o.select_set(True)
bpy.context.view_layer.objects.active=objects[0];bpy.ops.object.join()
obj=bpy.context.object;obj.name='HR_Landmark_ParkGate';obj.location=base;obj.rotation_euler.z=-a;obj['landmark']='ParkGate'
assert len([o for o in scene.objects if 'landmark' in o]) == 10

scene.view_settings.view_transform = 'Standard'
scene.view_settings.exposure = .5
scene.world = bpy.data.worlds.new('HR_Sky'); scene.world.use_nodes = True
next(n for n in scene.world.node_tree.nodes if n.type == 'BACKGROUND').inputs[0].default_value = (.48,.66,.76,1)
next(n for n in scene.world.node_tree.nodes if n.type == 'BACKGROUND').inputs[1].default_value = .65
sun_data = bpy.data.lights.new('HR_Sun','SUN'); sun_data.energy = 2.2; sun_data.angle = .12
sun = bpy.data.objects.new('HR_Sun',sun_data); scene.collection.objects.link(sun)
sun.rotation_euler = (.45,-.5,-.4)
camera_data = bpy.data.cameras.new('HR_Camera'); camera = bpy.data.objects.new('HR_Camera',camera_data)
scene.collection.objects.link(camera); scene.camera = camera
target = Vector(point(1200,150)); a = (1200-RAIL['originX'])/ppm/RAIL['radius']
camera.location = target + Vector((-math.sin(a)*28,-math.cos(a)*28,9))
camera.rotation_euler = (target-camera.location).to_track_quat('-Z','Y').to_euler()
camera_data.type = 'ORTHO'; camera_data.ortho_scale = 30
scene.render.engine = 'CYCLES'; scene.cycles.samples = 24
scene.render.resolution_x = 1600; scene.render.resolution_y = 900; scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = OUT + '/previews/overview.png'
for template, asset in templates:
    bpy.data.objects.remove(template, do_unlink=True)
for prefix in ['HR_Platform_', 'HR_Path_', 'HR_Garden_']:
    objects = [o for o in scene.objects if o.name.startswith(prefix)]
    bpy.ops.object.select_all(action='DESELECT')
    for o in objects: o.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join(); bpy.context.object.name = prefix.rstrip('_')
    if prefix == 'HR_Platform_':
        bpy.context.object['footholdIds'] = [f['id'] for f in floors]
        bpy.context.object['platformThickness'] = RAIL['platformThickness']
for image in bpy.data.images:
    if image.filepath:
        if max(image.size) > 1024:
            factor = 1024/max(image.size); image.scale(max(1,round(image.size[0]*factor)),max(1,round(image.size[1]*factor)))
        image.pack()
bpy.ops.wm.save_as_mainfile(filepath=OUT + '/models/henesys-rail.blend')
bpy.ops.export_scene.gltf(filepath=OUT + '/models/rail-v1.glb', use_active_scene=True, export_extras=True, export_animations=False, export_lights=False, export_cameras=False)
print('HENESYS_RAIL_SAVED', len(floors), len(sites))
