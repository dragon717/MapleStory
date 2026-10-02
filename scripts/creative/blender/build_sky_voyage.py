"""Build the editable TMS273-referenced, v4-inspired sky-voyage model in Blender MCP."""
import bpy
import math
import random
from mathutils import Vector, Matrix

ROOT = '/Users/muniao/Code/MapleStory'
OUT = ROOT + '/resources/scenes/sky-voyage-v1'
BLEND = OUT + '/models/sky-voyage.blend'
GLB = OUT + '/models/sky-voyage.glb'
WING = OUT + '/vendor/wings/wings-michael-fuchs.glb'
NATURE = ROOT + '/resources/scenes/henesys/rail-v1/vendor/nature/Stylized Nature MegaKit[Standard]/glTF/'
SEED = 20261002
rng = random.Random(SEED)

old_scene = bpy.data.scenes.get('SV_SkyVoyage')
if old_scene is not None:
    for old_object in list(old_scene.objects):
        bpy.data.objects.remove(old_object, do_unlink=True)
    bpy.data.scenes.remove(old_scene)
for old_mesh in list(bpy.data.meshes):
    if old_mesh.name.startswith('SV_') and old_mesh.users == 0:
        bpy.data.meshes.remove(old_mesh)
for old_material in list(bpy.data.materials):
    if old_material.name.startswith('SV_Mat_') and old_material.users == 0:
        bpy.data.materials.remove(old_material)

scene = bpy.data.scenes.new('SV_SkyVoyage')
if bpy.context.window is not None:
    bpy.context.window.scene = scene
scene['sv_units'] = 'metres'
scene['sv_design_axes'] = 'x lateral, y up, z depth; bow=-z; Blender=(x,-z,y); glTF Y-up'
scene['sv_provenance'] = 'TMS273 map references plus original P geometry based on the user-provided v4 concept'

def collection(name):
    result = bpy.data.collections.new(name)
    scene.collection.children.link(result)
    return result

SHIP = collection('SV_ShipModel')
CITY = collection('SV_CityModel')
PREVIEW = collection('SV_PreviewOnly')

def d_to_b(point):
    x, y, z = point
    return (x, -z, y)

def material(name, color, roughness=0.58, metallic=0.0, emission=0.0):
    m = bpy.data.materials.new('SV_Mat_' + name)
    m.diffuse_color = (*color, 1.0)
    m.use_nodes = True
    shader = next(node for node in m.node_tree.nodes if node.type == 'BSDF_PRINCIPLED')
    shader.inputs['Base Color'].default_value = (*color, 1.0)
    shader.inputs['Roughness'].default_value = roughness
    shader.inputs['Metallic'].default_value = metallic
    if emission:
        shader.inputs['Emission Color'].default_value = (*color, 1.0)
        shader.inputs['Emission Strength'].default_value = emission
    return m

M = {
    'deck': material('ShipDeck', (0.39, 0.205, 0.091), .72),
    'plank': material('DeckPlank', (0.53, 0.31, 0.15), .69),
    'plankLight': material('DeckPlankLight', (0.64, 0.40, 0.205), .72),
    'woodDark': material('WoodDark', (0.16, 0.075, 0.035), .61),
    'wood': material('Wood', (0.34, 0.17, 0.073), .58),
    'woodLight': material('WoodLight', (0.61, 0.355, 0.13), .47),
    'green': material('ShipTeal', (0.025, 0.25, 0.235), .35, .12),
    'greenLight': material('ShipTealLight', (0.055, 0.39, 0.335), .38, .08),
    'gold': material('WarmBrass', (0.82, 0.48, 0.105), .28, .73),
    'goldLight': material('PaleGold', (0.97, 0.72, 0.25), .25, .64),
    'iron': material('Iron', (0.13, 0.17, 0.20), .42, .70),
    'cream': material('SailCream', (0.91, 0.83, 0.65), .86),
    'leaf': material('MapleCopper', (0.72, 0.19, 0.055), .48, .05),
    'leafVein': material('LeafGold', (0.98, 0.60, 0.18), .43, .18),
    'glass': material('CabinGlass', (0.09, 0.29, 0.46), .2, .22, .32),
    'windowWarm': material('WindowWarm', (1.0, 0.59, 0.23), .24, .05, .8),
    'stone': material('CastleIvory', (0.82, 0.80, 0.72), .69),
    'stoneBright': material('CastlePorcelain', (0.96, 0.925, 0.83), .54),
    'stoneShade': material('CastleShadow', (0.55, 0.59, 0.60), .78),
    'roof': material('DeepAzureRoof', (0.035, 0.23, 0.34), .28, .26),
    'roofLight': material('TurquoiseRoof', (0.08, 0.49, 0.56), .23, .2),
    'crystal': material('AetherCrystal', (0.07, 0.73, 0.92), .14, .25, 1.65),
    'water': material('WaterfallBlue', (0.12, 0.68, 0.88), .2, .06, .30),
    'waterBright': material('WaterfallFoam', (0.60, 0.89, 0.98), .19, 0.0, .5),
    'grass': material('IslandGrass', (0.20, 0.40, 0.23), .93),
    'grassLight': material('IslandGrassLight', (0.37, 0.56, 0.30), .91),
    'rock': material('FloatingRock', (0.30, 0.35, 0.39), .88),
    'rockLight': material('FloatingRockLight', (0.48, 0.50, 0.49), .91),
    'rockDark': material('FloatingRockShade', (0.20, 0.26, 0.31), .95),
    'cloudTint': material('MistPearl', (0.78, 0.86, 0.91), .74)
}

def mesh_b(name, vertices, faces, mats, face_materials=None, parent=None, target=SHIP, smooth=False, uv=True):
    data = bpy.data.meshes.new(name + '_Mesh')
    data.from_pydata(vertices, [], faces)
    data.update()
    for mat in mats if isinstance(mats, (list, tuple)) else [mats]:
        data.materials.append(mat)
    for poly in data.polygons:
        poly.use_smooth = smooth
    if face_materials:
        for poly, index in zip(data.polygons, face_materials):
            poly.material_index = index
    if uv:
        layer = data.uv_layers.new(name='UVMap')
        for loop in data.loops:
            p = data.vertices[loop.vertex_index].co
            layer.data[loop.index].uv = (p.x * .16, p.y * .16)
    obj = bpy.data.objects.new(name, data)
    target.objects.link(obj)
    if parent is not None:
        obj.parent = parent
        obj.matrix_parent_inverse = Matrix.Identity(4)
    return obj

def mesh_d(name, vertices, faces, mats, face_materials=None, parent=None, target=SHIP, smooth=False, uv=True):
    return mesh_b(name, [d_to_b(v) for v in vertices], faces, mats, face_materials, parent, target, smooth, uv)

def anchor(name, at, parent, target):
    obj = bpy.data.objects.new(name, None)
    target.objects.link(obj)
    obj.empty_display_type = 'SPHERE'
    obj.empty_display_size = .32
    obj.location = d_to_b(at)
    if parent is not None:
        obj.parent = parent
        obj.matrix_parent_inverse = Matrix.Identity(4)
    return obj

def box(name, center, size, mat, parent, target, bevel=0.0):
    cx, cy, cz = center
    sx, sy, sz = [v * .5 for v in size]
    points = [
        (cx-sx, cy-sy, cz-sz), (cx+sx, cy-sy, cz-sz),
        (cx+sx, cy+sy, cz-sz), (cx-sx, cy+sy, cz-sz),
        (cx-sx, cy-sy, cz+sz), (cx+sx, cy-sy, cz+sz),
        (cx+sx, cy+sy, cz+sz), (cx-sx, cy+sy, cz+sz)
    ]
    obj = mesh_d(name, points, [(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)], mat, parent=parent, target=target)
    if bevel:
        mod = obj.modifiers.new('Hand softened edges', 'BEVEL')
        mod.width = min(bevel, min(size) * .2)
        mod.segments = 2
    return obj

def cylinder(name, center, radius, height, mat, parent, target, sides=20, top_radius=None, bottom_radius=None):
    x, y, z = center
    rb = bottom_radius if bottom_radius is not None else radius
    rt = top_radius if top_radius is not None else radius
    verts = []
    for yy, rr in ((y-height*.5, rb), (y+height*.5, rt)):
        for i in range(sides):
            t = i * math.tau / sides
            verts.append((x + rr * math.cos(t), yy, z + rr * math.sin(t)))
    faces = [tuple(reversed(range(sides))), tuple(range(sides, sides*2))]
    faces += [(i, (i+1)%sides, (i+1)%sides+sides, i+sides) for i in range(sides)]
    return mesh_d(name, verts, faces, mat, parent=parent, target=target, smooth=True)

def tube(name, points, radius, mat, parent, target, sides=8):
    ps = [Vector(d_to_b(p)) for p in points]
    if len(ps) < 2:
        return None
    verts = []
    for i, p in enumerate(ps):
        tangent = ps[min(i+1, len(ps)-1)] - ps[max(i-1, 0)]
        if tangent.length < .0001:
            tangent = Vector((0, 0, 1))
        tangent.normalize()
        reference = Vector((0, 0, 1)) if abs(tangent.z) < .90 else Vector((0, 1, 0))
        u = tangent.cross(reference).normalized()
        v = tangent.cross(u).normalized()
        for j in range(sides):
            t = math.tau * j / sides
            p2 = p + radius * (math.cos(t) * u + math.sin(t) * v)
            verts.append(tuple(p2))
    faces = [(i*sides+j, i*sides+(j+1)%sides, (i+1)*sides+(j+1)%sides, (i+1)*sides+j)
             for i in range(len(ps)-1) for j in range(sides)]
    faces += [tuple(reversed(range(sides))), tuple((len(ps)-1)*sides+j for j in range(sides))]
    return mesh_b(name, verts, faces, mat, parent=parent, target=target, smooth=True)

def maple_leaf(name, center, scale, mat, parent, target, depth=.12, veins=True):
    cx, cy, cz = center
    outline = [
        (0,.72),(-.11,.45),(-.31,.58),(-.27,.30),(-.53,.38),(-.40,.10),
        (-.67,.03),(-.38,-.15),(-.46,-.43),(-.13,-.28),(0,-.82),
        (.13,-.28),(.46,-.43),(.38,-.15),(.67,.03),(.40,.10),
        (.53,.38),(.27,.30),(.31,.58),(.11,.45)
    ]
    n = len(outline)
    verts = []
    for side in (1, -1):
        for px, py in outline:
            verts.append(d_to_b((cx+px*scale, cy+py*scale, cz+side*depth*.5)))
    faces = [tuple(range(n)), tuple(reversed(range(n, 2*n)))]
    faces += [(i, (i+1)%n, (i+1)%n+n, i+n) for i in range(n)]
    obj = mesh_b(name, verts, faces, mat, parent=parent, target=target)
    if veins:
        vein_z = cz + depth*.54
        for i, index in enumerate((0,2,4,6,8,11,13,15,17,19)):
            px, py = outline[index]
            tube(name + '_Vein_' + str(i), [(cx,cy,vein_z),(cx+px*scale*.52,cy+py*scale*.52,vein_z+.015),(cx+px*scale,cy+py*scale,vein_z+.01)], .012*scale, M['leafVein'], parent, target, 5)
    return obj

def arch_bridge(name, start, end, width, rise, parent, target):
    a, b = Vector(start), Vector(end)
    dx, dz = b.x-a.x, b.z-a.z
    length = math.hypot(dx, dz)
    if length < .1:
        return
    side = Vector((-dz/length, 0, dx/length))
    sections = 22
    left, right, left_rail, right_rail = [], [], [], []
    for i in range(sections+1):
        t = i/sections
        c = a.lerp(b, t)
        c.y += rise * math.sin(math.pi*t)
        left.append(tuple(c-side*width*.5))
        right.append(tuple(c+side*width*.5))
        ql, qr = c-side*(width*.5+.23), c+side*(width*.5+.23)
        ql.y += .95
        qr.y += .95
        left_rail.append(tuple(ql))
        right_rail.append(tuple(qr))
    verts = []
    for l, r in zip(left, right):
        verts.extend((l,r))
    faces = [(2*i,2*i+1,2*i+3,2*i+2) for i in range(sections)]
    mesh_d(name+'_Walk', verts, faces, M['stoneBright'], parent=parent, target=target)
    tube(name+'_RailL', left_rail, .22, M['stone'], parent, target, 8)
    tube(name+'_RailR', right_rail, .22, M['stone'], parent, target, 8)
    for i in range(1, sections, 3):
        t = i/sections
        c = a.lerp(b,t)
        c.y += rise*math.sin(math.pi*t)
        for sign in (-1,1):
            q = c + side * sign * (width*.5+.22)
            box(name+'_Baluster', (q.x,q.y+.42,q.z), (.23,.84,.23), M['gold'], parent, target, .06)
    for sign in (-1,1):
        under=[]
        for i in range(sections+1):
            t=i/sections
            c=a.lerp(b,t)
            c.y += rise*math.sin(math.pi*t)-.65
            c += side * sign * width*.31
            under.append(tuple(c))
        tube(name+'_ArchSupport', under, .30, M['stoneShade'], parent, target, 10)

def waterfall(name, x, z, y_top, height, width, phase, parent, target):
    rows, columns = 14, 3
    verts = []
    for r in range(rows+1):
        t = r/rows
        y = y_top - height*t
        wave = .32*math.sin(t*11+phase) + .15*math.sin(t*23+phase*.7)
        for c in range(columns+1):
            u = c/columns-.5
            xx = x + u*width + wave*(.3+abs(u))
            zz = z + .14*math.sin(t*8+phase+u*2)
            verts.append((xx,y,zz))
    faces=[]
    for r in range(rows):
        for c in range(columns):
            i=r*(columns+1)+c
            faces.append((i,i+columns+1,i+columns+2,i+1))
    mesh_d(name+'_Water', verts, faces, M['water'], parent=parent, target=target, smooth=True)
    for side in (-1,1):
        points=[]
        for r in range(rows+1):
            t=r/rows
            points.append((x+side*width*.37+.18*math.sin(t*15+phase), y_top-height*t, z+.18*math.cos(t*10+phase)))
        tube(name+'_Glint',points,.055,M['waterBright'],parent,target,5)

def island(name, x, y_top, z, rx, rz, depth, parent):
    sides = 48
    profiles = [(1.0,0.0),(.97,-1.3),(.79,-depth*.34),(.60,-depth*.72),(.34,-depth),(0.05,-depth-1.1)]
    verts=[]
    for layer,(rad,dy) in enumerate(profiles):
        for i in range(sides):
            t=math.tau*i/sides
            wobble=1+.045*math.sin(t*3+1.3)+.026*math.cos(t*7+.5)
            verts.append((x+rx*rad*wobble*math.cos(t),y_top+dy+.18*math.sin(t*5+layer),z+rz*rad*wobble*math.sin(t)))
    faces=[]
    mats=[]
    for layer in range(len(profiles)-1):
        for i in range(sides):
            faces.append((layer*sides+i,layer*sides+(i+1)%sides,(layer+1)*sides+(i+1)%sides,(layer+1)*sides+i))
            mats.append((i+layer*3)%3)
    center_index=len(verts)
    verts.append((x,y_top-depth-1.1,z))
    for i in range(sides):
        faces.append(((len(profiles)-1)*sides+i,(len(profiles)-1)*sides+(i+1)%sides,center_index))
        mats.append(2)
    mesh_d(name+'_RockBody',verts,faces,[M['rock'],M['rockLight'],M['rockDark']],mats,parent=parent,target=CITY,smooth=False)
    topverts=[(x,y_top+.08,z)]
    for i in range(sides):
        t=math.tau*i/sides
        wobble=1+.035*math.sin(t*3+1.3)+.018*math.cos(t*7+.5)
        topverts.append((x+rx*.91*wobble*math.cos(t),y_top+.08+.12*math.sin(t*4),z+rz*.91*wobble*math.sin(t)))
    topfaces=[(0,i+1,(i+1)%sides+1) for i in range(sides)]
    mesh_d(name+'_GrassTop',topverts,topfaces,M['grass'],parent=parent,target=CITY,smooth=True)
    for i in range(10):
        t=math.tau*(i+.25)/10
        px=x+rx*.55*math.cos(t)
        pz=z+rz*.55*math.sin(t)
        hh=depth*rng.uniform(.17,.37)
        cylinder(name+'_UndersideShard',(px,y_top-depth*.62-hh*.5,pz),rng.uniform(.7,1.5),hh,M['rockDark'],parent,CITY,7,top_radius=.08,bottom_radius=rng.uniform(.5,1.1))
    return (x,y_top,z)

def tower(name,x,z,base_y,radius,height,parent,target=CITY,roof_mat=None):
    roof_mat=roof_mat or M['roof']
    cylinder(name+'_Foot',(x,base_y+.40,z),radius*1.32,.80,M['stoneShade'],parent,target,24)
    cylinder(name+'_FootTrim',(x,base_y+.90,z),radius*1.25,.24,M['gold'],parent,target,24)
    cylinder(name+'_Shaft',(x,base_y+height*.43,z),radius,height*.72,M['stoneBright'],parent,target,24,top_radius=radius*.86)
    cylinder(name+'_Crown',(x,base_y+height*.81,z),radius*1.10,.62,M['stone'],parent,target,24)
    cylinder(name+'_CrownGold',(x,base_y+height*.84,z),radius*1.12,.15,M['goldLight'],parent,target,24)
    cylinder(name+'_Roof',(x,base_y+height*.94,z),radius*1.05,height*.22,roof_mat,parent,target,24,top_radius=.20)
    cylinder(name+'_Finial',(x,base_y+height*1.065,z),.16,height*.10,M['gold'],parent,target,10,top_radius=.035)
    for i in range(8):
        t=i*math.tau/8
        px=x+math.cos(t)*radius*.89
        pz=z+math.sin(t)*radius*.89
        box(name+'_Merlon',(px,base_y+height*.88,pz),(.34,.68,.34),M['stoneBright'],parent,target,.07)
    for i,t in enumerate((-.55,0,.55)):
        px=x+math.sin(t)*radius*.82
        pz=z+math.cos(t)*radius*.82
        wy=base_y+height*.46
        box(name+'_WindowGlass',(px,wy,pz),(.78,height*.18,.15),M['glass'],parent,target,.06)
        box(name+'_WindowMullion',(px,wy,pz+.095),(.10,height*.20,.12),M['gold'],parent,target,.02)
        box(name+'_WindowCap',(px,wy+height*.10,pz),(.98,.19,.22),M['goldLight'],parent,target,.045)

def import_joined(path, object_prefix, target, parent, base_centering=True):
    before_objects=set(bpy.data.objects)
    before_collections=set(bpy.data.collections)
    bpy.ops.import_scene.gltf(filepath=path)
    added=[obj for obj in bpy.data.objects if obj not in before_objects]
    added_names=[obj.name for obj in added]
    meshes=[obj for obj in added if obj.type=='MESH']
    if not meshes:
        for obj in added:
            bpy.data.objects.remove(obj,do_unlink=True)
        raise RuntimeError('Imported GLB has no mesh: '+path)
    bpy.ops.object.select_all(action='DESELECT')
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active=meshes[0]
    bpy.ops.object.join()
    merged=bpy.context.object
    bpy.ops.object.transform_apply(location=True,rotation=True,scale=True)
    if base_centering:
        coords=[v.co for v in merged.data.vertices]
        lo=[min(p[i] for p in coords) for i in range(3)]
        hi=[max(p[i] for p in coords) for i in range(3)]
        offset=Vector(((lo[0]+hi[0])*.5,(lo[1]+hi[1])*.5,lo[2]))
        for vert in merged.data.vertices:
            vert.co-=offset
    merged.data.update()
    for name in added_names:
        leftover=bpy.data.objects.get(name)
        if leftover is not None and leftover != merged:
            bpy.data.objects.remove(leftover,do_unlink=True)
    for linked in list(merged.users_collection):
        linked.objects.unlink(merged)
    target.objects.link(merged)
    merged.name=object_prefix
    merged.parent=parent
    merged.matrix_parent_inverse=Matrix.Identity(4)
    merged.location=(0,0,0)
    for linked in list(bpy.data.collections):
        if linked not in before_collections and not linked.objects and not linked.children:
            bpy.data.collections.remove(linked)
    return merged

def make_veg_template(filename, name):
    obj=import_joined(NATURE+filename+'.gltf','SV_Template_'+name,CITY,None,True)
    coords=[v.co for v in obj.data.vertices]
    lo=[min(p[i] for p in coords) for i in range(3)]
    hi=[max(p[i] for p in coords) for i in range(3)]
    height=max(.01,hi[2]-lo[2])
    for vert in obj.data.vertices:
        vert.co.x/=height
        vert.co.y/=height
        vert.co.z/=height
    mesh_data=obj.data
    bpy.data.objects.remove(obj,do_unlink=True)
    return mesh_data

def plant(template,name,at,height,parent,rotation=0):
    obj=bpy.data.objects.new(name,template)
    CITY.objects.link(obj)
    obj.parent=parent
    obj.matrix_parent_inverse=Matrix.Identity(4)
    obj.location=d_to_b(at)
    obj.scale=(height,height,height)
    obj.rotation_euler.z=rotation
    obj['asset_license']='CC0 Quaternius'
    obj['asset_family']='Stylized Nature MegaKit Standard'
    return obj

ship=anchor('SV_Ship',(0,0,0),None,SHIP)
ship.empty_display_type='CUBE'
ship.empty_display_size=2.0
ship['runtime_root']=True
ship['source_class']='P'
ship['source_reference']='TMS273 Map.wz/Obj/vehicle.img/ship/ossyria/99 consulted as a 2D ship reference'
city=anchor('SV_City',(35,0,-140),None,CITY)
city.empty_display_type='CUBE'
city.empty_display_size=5.0
city['runtime_root']=True
city['source_class']='P'
city['source_reference']='TMS273 Map.wz/Map/Map2/200000000.img (destination identity/layout context only)'

# Ship hull and exact-height deck
sections=[(-15,.08,3.25,-.25),(-13.5,1.65,2.85,-1.5),(-10,4.10,2.35,-3.1),(-5,6.25,2.05,-4.2),(2,7.0,2.15,-4.55),(8,6.65,2.45,-3.8),(12,5.65,3.0,-2.4),(14,4.7,3.7,-.6),(15,3.6,4.8,1.4)]
hull_verts=[]
cross=[(-1.0,0.0),(-.91,-.34),(-.69,-.68),(0,-1.0),(.69,-.68),(.91,-.34),(1.0,0.0)]
for z,width,rail_y,keel_y in sections:
    for xratio,yratio in cross:
        x=xratio*width
        y=rail_y+(keel_y-rail_y)*max(0,1-abs(xratio))**.82
        hull_verts.append((x,y,z))
hull_faces=[]
for i in range(len(sections)-1):
    for j in range(len(cross)-1):
        k=i*len(cross)+j
        hull_faces.append((k,k+1,k+len(cross)+1,k+len(cross)))
mesh_d('SV_HullCarvedWood',hull_verts,hull_faces,[M['wood'],M['woodDark'],M['woodLight']],[j%3 for i in range(len(sections)-1) for j in range(len(cross)-1)],ship,SHIP,smooth=True)
box('SV_DeckSubfloor',(0,-.13,0),(13.1,.26,27.8),M['deck'],ship,SHIP,.1)
for i in range(30):
    z=-13.4+i*.92
    box('SV_DeckPlank_%02d'%i,(0,.018,z),(12.75,.055,.86),M['plankLight'] if i%4==0 else M['plank'],ship,SHIP,.035)
    for x in (-5.95,5.95):
        cylinder('SV_DeckNail',(x,.057,z),.045,.025,M['gold'],ship,SHIP,8)
for x in (-6.78,6.78):
    for j in range(21):
        z=-14+j*1.35
        box('SV_GunwalePost',(x,1.13,z),(.35,1.5,.36),M['woodLight'],ship,SHIP,.08)
    box('SV_Gunwale',(x,1.82,0),(.42,.30,28.7),M['gold'],ship,SHIP,.10)
    box('SV_RailTop',(x,2.02,0),(.48,.16,28.6),M['woodLight'],ship,SHIP,.06)
for z in (-12.8,12.8):
    box('SV_DeckCrossRail',(0,1.15,z),(13.15,1.32,.42),M['gold'],ship,SHIP,.1)

# Side planking, brass scrolls and portholes
for side in (-1,1):
    for index,z in enumerate((-10,-7,-4,-1,2,5,8,11)):
        width=6.5 if z<7 else 5.5
        box('SV_HullPlank_%s_%02d'%('L' if side<0 else 'R',index),(side*width,.25,z),(1.15,.25,2.82),M['green'] if index%2 else M['greenLight'],ship,SHIP,.12)
        box('SV_HullTrim_%s_%02d'%('L' if side<0 else 'R',index),(side*(width+.12),.88,z),(.20,.17,2.84),M['gold'],ship,SHIP,.05)
    tube('SV_BowScroll',[(side*5.4,.9,-13),(side*4.4,1.7,-14.5),(side*2.1,2.05,-14.7),(side*.35,2.5,-14.4)],.22,M['goldLight'],ship,SHIP,10)
    tube('SV_SternScroll',[(side*5.8,1.2,11),(side*5.7,2.7,13),(side*4.8,4.3,14.4),(side*3.4,4.7,14.6)],.22,M['gold'],ship,SHIP,10)
    for z in (5.5,9.5,12.2):
        cylinder('SV_CabinPortholeFrame',(side*5.82,3.1,z),.73,.26,M['gold'],ship,SHIP,24)
        cylinder('SV_CabinPortholeGlass',(side*5.94,3.1,z),.53,.12,M['glass'],ship,SHIP,24)

# Bow crest has real raised maple-leaf relief on both flanks
for side in (-1,1):
    maple_leaf('SV_BowMapleRelief',(side*1.5,1.05,-14.55),.9,M['leaf'],ship,SHIP,.13,True)

# Two working masts, curved sail skin with local UVs, geometric maple emblem and rigging
for mast_index,(mast_z,mast_height,mast_radius) in enumerate(((-4.1,17.8,.36),(-12.4,10.4,.25))):
    cylinder('SV_Mast_%02d'%mast_index,(0,mast_height*.5,mast_z),mast_radius,mast_height,M['woodDark'],ship,SHIP,16)
    for yy in (2.4,mast_height*.35,mast_height*.71,mast_height-.6):
        cylinder('SV_MastCollar_%02d'%mast_index,(0,yy,mast_z),mast_radius*1.55,.22,M['gold'],ship,SHIP,16)
    for dx in (-.5,.5):
        tube('SV_Yardarm_%02d'%mast_index,[(dx*5,mast_height*.63,mast_z),(dx*3,mast_height*.63,mast_z),(0,mast_height*.63,mast_z)],.12,M['woodLight'],ship,SHIP,8)
    for side in (-1,1):
        tube('SV_Rigging_%02d'%mast_index,[(0,mast_height*.80,mast_z),(side*6.2,2.15,mast_z+.4),(side*6.4,1.8,mast_z+2.2)],.035,M['woodLight'],ship,SHIP,5)
    if mast_index==0:
        rows,cols=12,12
        sail_verts=[]
        for r in range(rows+1):
            v=r/rows
            y=5.2+v*10.8
            half=5.0*(.84+.16*math.sin(math.pi*v))
            for c in range(cols+1):
                u=c/cols*2-1
                z=mast_z + .56*(1-u*u)*math.sin(v*math.pi*.9)
                sail_verts.append((u*half,y,z))
        sail_faces=[]
        for r in range(rows):
            for c in range(cols):
                i=r*(cols+1)+c
                sail_faces.append((i,i+1,i+cols+2,i+cols+1))
        sail=mesh_d('SV_MapleSail_UV',sail_verts,sail_faces,M['cream'],parent=ship,target=SHIP,smooth=True,uv=True)
        sail['detail']='curved 3D sail surface; maple motif is separate geometry'
        maple_leaf('SV_SailMapleGeometry',(0,10.5,mast_z+.72),2.15,M['leaf'],ship,SHIP,.055,True)
        for side in (-1,1):
            tube('SV_SailRope',[(side*.12,5.0,mast_z),(side*5.0,5.0,mast_z),(side*4.15,16.1,mast_z),(0,16.3,mast_z)],.055,M['gold'],ship,SHIP,6)
        for x in (-5.1,5.1):
            tube('SV_SailEdge',[(x*.82,5.15,mast_z),(x,8.1,mast_z),(x*.86,12.6,mast_z),(0,16.2,mast_z)],.075,M['woodLight'],ship,SHIP,7)
        # A small dimensional pennant adds a readable silhouette without using a flat concept image.
        pennant=[(0,mast_height-.05,mast_z),(3.3,mast_height-1.0,mast_z),(0,mast_height-2.0,mast_z-.1)]
        mesh_d('SV_GoldPennant',pennant,[(0,1,2)],M['goldLight'],parent=ship,target=SHIP)

# Cabin is a six-metre walled structure from deck level, 4<=z<=14.
cabin=anchor('SV_Cabin',(0,0,0),ship,SHIP)
box('SV_CabinFloor',(0,-.09,9),(11.4,.18,10.0),M['woodDark'],cabin,SHIP,.05)
for x in (-5.55,5.55):
    box('SV_CabinSideWall',(x,3.0,9),(.32,6.0,10.0),M['wood'],cabin,SHIP,.04)
    for y in (1.0,5.15):
        box('SV_CabinSideTrim',(x*1.025,y,9),(.18,.21,10.05),M['gold'],cabin,SHIP,.04)
for z in (14.0,):
    back_wall=box('SV_CabinBackWall',(0,3.0,z),(11.1,6.0,.32),M['wood'],cabin,SHIP,.035)
    back_wall['runtime_hide_toggle']=True
    back_trim=box('SV_CabinBackTrim',(0,5.17,z),(11.45,.23,.40),M['gold'],cabin,SHIP,.04)
    back_trim['runtime_hide_toggle']=True

# The city-facing z=4 wall is built around four real apertures.  The broad
# lower/upper bands and five narrow piers leave a continuous opening from the
# cabin through the hull-facing wall; no backing pane is placed behind a frame.
window_centres=(-4.05,-1.35,1.35,4.05)
front_opening_half_width=.89
front_bottom=2.22
front_top=5.28
box('SV_CabinFrontLowerWall',(0,front_bottom/2,4.0),(11.1,front_bottom,.32),M['wood'],cabin,SHIP,.035)
box('SV_CabinFrontUpperWall',(0,(front_top+6.0)/2,4.0),(11.1,6.0-front_top,.32),M['wood'],cabin,SHIP,.035)
last_edge=-5.55
for index,x in enumerate(window_centres):
    left_edge=x-front_opening_half_width
    pier_width=left_edge-last_edge
    if pier_width > .02:
        box('SV_CabinFrontPier_%02d'%index,((left_edge+last_edge)/2,(front_bottom+front_top)/2,4.0),(pier_width,front_top-front_bottom,.32),M['wood'],cabin,SHIP,.025)
    last_edge=x+front_opening_half_width
right_width=5.55-last_edge
if right_width > .02:
    box('SV_CabinFrontPier_04',((last_edge+5.55)/2,(front_bottom+front_top)/2,4.0),(right_width,front_top-front_bottom,.32),M['wood'],cabin,SHIP,.025)
box('SV_CabinFrontCap',(0,6.12,4.0),(11.45,.20,.40),M['gold'],cabin,SHIP,.04)

# Four gold-framed openings on the city-facing wall, without blue backing cards.
for i,x in enumerate((-4.05,-1.35,1.35,4.05),1):
    window_anchor=anchor('SV_CabinFrontWindow_%02d'%i,(x,3.75,3.78),cabin,SHIP)
    for dx in (-.82,.82):
        box('SV_CabinWindowFrameV_%02d'%i,(dx,0,.36),(.16,2.96,.28),M['gold'],window_anchor,SHIP,.045)
    for dy in (-1.44,1.44):
        box('SV_CabinWindowFrameH_%02d'%i,(0,dy,.36),(1.78,.18,.28),M['woodLight'],window_anchor,SHIP,.05)
    box('SV_CabinWindowCrossV_%02d'%i,(0,0,.38),(.08,2.42,.10),M['goldLight'],window_anchor,SHIP,.025)
    box('SV_CabinWindowCrossH_%02d'%i,(0,.08,.38),(1.28,.08,.10),M['goldLight'],window_anchor,SHIP,.025)
    window_anchor['facing']='city, ship-local design z=-1'

# Roof is a dedicated parent so runtime can hide all roof pieces together.
roof=anchor('SV_CabinRoof',(0,0,0),cabin,SHIP)
roof['runtime_hide_toggle']=True
for side in (-1,1):
    ridge=(0,8.30,9)
    eave=(side*6.6,6.0,9)
    verts=[]
    for z in (3.85,14.15):
        verts.extend(((side*.13,6.0,z),(0,8.3,z),(side*6.6,6.0,z)))
    roof_faces=[(0,1,4,3),(1,2,5,4),(0,3,5,2,1)]
    panel=mesh_d('SV_CabinRoofPanel',verts,roof_faces,M['woodDark'],parent=roof,target=SHIP,smooth=False)
    tube('SV_CabinRoofEdge',[(side*6.6,6.0,3.85),(0,8.3,3.85),(side*-0.13,6.0,3.85)],.12,M['gold'],roof,SHIP,7)
    box('SV_CabinRoofLongTrim',(side*3.4,7.17,9),(7.4,.22,10.55),M['woodLight'],roof,SHIP,.07)
box('SV_CabinRoofRidge',(0,8.37,9),(.34,.38,10.55),M['goldLight'],roof,SHIP,.09)
for z in (4.0,14.0):
    triangle=[(-5.6,6.0,z),(0,8.3,z),(5.6,6.0,z)]
    mesh_d('SV_CabinGable',triangle,[(0,1,2)],M['woodLight'],parent=roof,target=SHIP)

# Four independent visual berths and stable anchors; account capacity remains a runtime concern.
bed_positions=(-4.0,-1.3,1.3,4.0)
for i,x in enumerate(bed_positions):
    bed=anchor('SV_Bed_%d'%i,(x,0,9),cabin,SHIP)
    bed['runtime_anchor']=True
    bed['foot_anchor_design']=[x,0,9]
    foot=anchor('SV_Bed_%d_FootAnchor'%i,(0,0,1.3),bed,SHIP)
    foot['runtime_anchor']=True
    sleep=anchor('SV_Bed_%d_SleepAnchor'%i,(0,.82,0),bed,SHIP)
    sleep['runtime_anchor']=True
    box('SV_BedFrame_%d'%i,(0,.25,0),(1.18,.48,2.65),M['woodDark'],bed,SHIP,.12)
    box('SV_BedMattress_%d'%i,(0,.58,0),(1.10,.22,2.48),M['cream'],bed,SHIP,.11)
    box('SV_BedQuilt_%d'%i,(0,.73,.28),(1.04,.12,1.42),M['greenLight'],bed,SHIP,.08)
    box('SV_BedPillow_%d'%i,(0,.78,-.78),(.78,.20,.46),M['stoneBright'],bed,SHIP,.10)
    box('SV_BedHeadboard_%d'%i,(0,.83,-1.28),(1.27,1.0,.14),M['woodLight'],bed,SHIP,.055)
    for dx in (-.48,.48):
        cylinder('SV_BedPost_%d'%i,(dx,.74,-1.30),.075,.95,M['gold'],bed,SHIP,10)

# Physical 4x6 metre sign anchored exactly at (-4,0,0), with raised maple relief.
sign=anchor('SV_LoginSign',(-4,0,0),ship,SHIP)
sign['runtime_anchor_design']=[-4,0,0]
sign['physical_size_metres']=[4,6]
box('SV_LoginSignBack',(0,3.0,.02),(4.0,6.0,.40),M['woodDark'],sign,SHIP,.20)
box('SV_LoginSignBoard',(0,3.0,.25),(3.55,5.48,.24),M['plankLight'],sign,SHIP,.16)
for x in (-1.80,1.80):
    box('SV_LoginSignBrassEdge',(x,3.0,.43),(.15,5.56,.18),M['gold'],sign,SHIP,.06)
for y in (.32,5.68):
    box('SV_LoginSignBrassEdge',(0,y,.43),(3.75,.15,.18),M['gold'],sign,SHIP,.06)
for x in (-1.57,1.57):
    for y in (.56,5.44):
        cylinder('SV_LoginSignRivet',(x,y,.56),.075,.08,M['goldLight'],sign,SHIP,12)
maple_leaf('SV_LoginSignMapleGeometry',(0,4.02,.48),1.22,M['leaf'],sign,SHIP,.13,True)
for side in (-1,1):
    cylinder('SV_LoginSignPost',(side*1.55,-.33,0),.13,1.25,M['woodDark'],sign,SHIP,12)
box('SV_LoginSignFoot',(0,-.62,0),(4.25,.38,.75),M['gold'],sign,SHIP,.12)

# Main castle island and eight smaller floating stepping-stones.
island('SV_MainSkyIsland',0,28,0,45,32,38,city)
satellites=[
    (-58,48,-23,9,7,15), (58,52,-20,10,8,18),
    (-61,42,24,8,7,14), (64,47,25,10,8,16),
    (-37,72,-43,7,6,13), (39,76,-42,8,7,15),
    (-20,57,47,7,6,13), (19,60,51,7,6,14),
    (0,42,63,12,9,17)
]
for i,(x,y,z,rx,rz,d) in enumerate(satellites,1):
    island('SV_SatelliteIsland_%02d'%i,x,y,z,rx,rz,d,city)

# Low retaining rings and the walkable palace terrace.
box('SV_CastleFoundation',(0,30.3,0),(57,2.0,43),M['stoneShade'],city,CITY,.48)
box('SV_CastleTerrace',(0,31.55,0),(53,1.0,39),M['stoneBright'],city,CITY,.30)
box('SV_CastleTerraceInset',(0,32.12,0),(47,0.18,33),M['stone'],city,CITY,.08)
for x in (-25.3,25.3):
    for z in (-16.4,16.4):
        box('SV_TerraceCornerPlinth',(x,33.1,z),(1.9,2.1,1.9),M['stoneBright'],city,CITY,.18)

# Main keep: buttressed white walls, blue glazing, golden cornices and a forward-facing portal.
box('SV_CastleMainKeep',(0,45.3,-1),(24,25,22),M['stoneBright'],city,CITY,.50)
box('SV_CastleLowerCornice',(0,34.0,-1),(27,1.15,25),M['gold'],city,CITY,.20)
box('SV_CastleUpperCornice',(0,56.8,-1),(25.4,.80,23.5),M['goldLight'],city,CITY,.16)
box('SV_CastleFrontGable',(0,59.4,10.6),(11,4.7,.85),M['stone'],city,CITY,.18)
for x in (-10.8,10.8):
    box('SV_CastleButtress',(x,43.7,9.8),(2.0,19,2.2),M['stone'],city,CITY,.28)
    box('SV_CastleButtressCap',(x,53.7,9.8),(2.5,.65,2.6),M['gold'],city,CITY,.12)
for x in (-7.8,-3.8,3.8,7.8):
    box('SV_CastleFrontWindowGlass',(x,45.3,10.35),(1.48,7.8,.20),M['glass'],city,CITY,.18)
    box('SV_CastleFrontWindowMullion',(x,45.3,10.52),(.13,7.4,.12),M['gold'],city,CITY,.04)
    box('SV_CastleFrontWindowLintel',(x,49.3,10.48),(1.85,.25,.25),M['goldLight'],city,CITY,.07)
box('SV_CastlePortalShadow',(0,38.1,10.55),(5.8,8.5,.35),M['roof'],city,CITY,.44)
box('SV_CastlePortalGlass',(0,38.3,10.77),(3.3,6.5,.18),M['crystal'],city,CITY,.42)
box('SV_CastlePortalKeystone',(0,43.4,10.80),(.62,1.05,.32),M['goldLight'],city,CITY,.13)

# Tall center spire and paired lateral towers.
tower('SV_CentralSpire',0,-1,57.0,7.1,30.0,city,CITY,M['roof'])
for x,z,base,h,r in [(-18,10,32.2,28,4.8),(18,10,32.2,28,4.8),(-18,-12,32.2,33,4.4),(18,-12,32.2,33,4.4)]:
    tower('SV_CastleTower_%s_%s'%(int(x),int(z)),x,z,base,r,h,city,CITY,M['roofLight'] if x<0 else M['roof'])
for i,(x,z,base,h) in enumerate(((-10,-17,32.2,16),(10,-17,32.2,16),(-10,18,32.2,19),(10,18,32.2,19)),1):
    tower('SV_WatchTurret_%02d'%i,x,z,base,2.1,h,city,CITY,M['roofLight'])

# Blue crystal is a real faceted octahedral mesh above the wing crest.
crystal_center=(0,103.5,-2.0)
crystal_verts=[(0,111,-2),(1.55,103.5,-2),(0,103.5,-.45),(-1.55,103.5,-2),(0,103.5,-3.55),(0,96,-2)]
crystal_faces=[(0,1,2),(0,2,3),(0,3,4),(0,4,1),(5,2,1),(5,3,2),(5,4,3),(5,1,4)]
mesh_d('SV_AetherCrownCrystal',crystal_verts,crystal_faces,M['crystal'],parent=city,target=CITY)
for y in (93.0,94.0,95.0):
    cylinder('SV_CrystalSetting',(0,y,-2),2.0-(y-93)*.22,.35,M['gold'],city,CITY,12)

# CC-BY white feather pair imported as geometry and retained under its own replaceable node.
wing_root=anchor('SV_Wing_MichaelFuchs',(0,89.5,-3.0),city,CITY)
wing=import_joined(WING,'SV_WingMesh_MichaelFuchs',CITY,wing_root,True)
wing.scale=(.145,.145,.145)
wing['author']='Michael Fuchs'
wing['license']='CC-BY 3.0'
wing['source']='https://poly.pizza/m/dw-IMS0xk71'
wing['changes']='rescaled and placed as the castle crest'
wing_root['license']='CC-BY 3.0'

# Arched approaches connect the city precinct to planted satellite islands.
arch_bridge('SV_ArchBridge_Left',(-19,38,-4),(-56,49,-22),4.0,4.6,city,CITY)
arch_bridge('SV_ArchBridge_Right',(19,39,-4),(56,53,-18),4.0,5.2,city,CITY)
arch_bridge('SV_ArchBridge_Foreground',(0,36,17),(0,42,58),4.4,5.8,city,CITY)
arch_bridge('SV_ArchBridge_GardenLeft',(-22,36,5),(-60,42,22),3.1,3.7,city,CITY)
arch_bridge('SV_ArchBridge_GardenRight',(22,36,5),(62,47,23),3.1,4.4,city,CITY)

# Raised stairs, parapets and garden balustrades give the castle a legible approach.
for i in range(15):
    z=25.0-i*1.15
    y=32.2+i*.50
    box('SV_GrandApproachStep_%02d'%i,(0,y,z),(8.8,.60,1.30),M['stoneBright'],city,CITY,.13)
    for x in (-4.65,4.65):
        box('SV_GrandApproachPost_%02d'%i,(x,y+.62,z),(.26,1.1,.26),M['gold'],city,CITY,.06)
for x in (-23,23):
    box('SV_GardenBalustrade',(x,34.3,-1),(.7,2.6,25),M['stone'],city,CITY,.12)
    box('SV_GardenBalustradeCap',(x,35.7,-1),(1.0,.32,25.2),M['goldLight'],city,CITY,.08)

# Waterfalls fall below the main rim and satellite stones; all are modelled sheets with volume cues.
for i,(x,z,w,h) in enumerate(((-28,21,3.4,55),(18,27,4.2,61),(39,8,2.6,45),(-7,-29,3.2,43),(0,71,2.8,29),(-58,-23,1.9,18),(58,-20,2.2,22),(-61,24,1.8,16),(64,25,2.0,18),(0,63,3.4,21)),1):
    top=28 if abs(x)<45 and abs(z)<33 else next((item[1] for item in satellites if abs(item[0]-x)<.01 and abs(item[2]-z)<.01),48)
    waterfall('SV_Waterfall_%02d'%i,x, z, top-.1, h, w, i*.8,city,CITY)

# Source Quaternius CC0 trees, bushes, flowers and rocks are reused on the islands.
tree_a=make_veg_template('CommonTree_1','CommonTree_1')
tree_b=make_veg_template('TwistedTree_1','TwistedTree_1')
bush=make_veg_template('Bush_Common','Bush_Common')
flowers=make_veg_template('Flower_3_Group','Flower_3_Group')
rock=make_veg_template('Rock_Medium_1','Rock_Medium_1')
for i,(x,y,z,h) in enumerate(((-34,28,-10,9),(-37,28,7,7.6),(-30,28,16,8),(34,28,-12,8),(37,28,8,9),(31,28,16,7.2),(-5,42,-16,5.2),(6,42,-16,5.4)),1):
    plant(tree_a,'SV_QuaterniusTree_%02d'%i,(x,y,z),h,city,rng.random()*math.tau)
for i,(x,y,z,h) in enumerate(((-15,48,-23,5.3),(15,52,-19,5.8),(-61,42,24,4.8),(64,47,25,5.3),(-37,72,-43,4.4),(39,76,-42,4.8),(0,42,63,6.0)),1):
    plant(tree_b,'SV_QuaterniusTwistedTree_%02d'%i,(x,y,z),h,city,rng.random()*math.tau)
for i,(x,y,z) in enumerate(((-19,28,-20),(-22,28,-10),(19,28,-20),(21,28,-8),(-53,48,-22),(53,52,-19),(-18,57,47),(18,60,51),(0,42,63)),1):
    plant(bush,'SV_QuaterniusBush_%02d'%i,(x,y,z),1.7,city,rng.random()*math.tau)
    plant(flowers,'SV_QuaterniusFlowers_%02d'%i,(x, y+.1, z+1.5),.9,city,rng.random()*math.tau)
for i,(x,y,z) in enumerate(((-40,28,-21),(40,28,-21),(-33,28,23),(34,28,22),(-57,48,-27),(58,52,-24),(0,42,68)),1):
    plant(rock,'SV_QuaterniusRock_%02d'%i,(x,y,z),2.1,city,rng.random()*math.tau)

# Preview-only camera and lighting remain in Blender but never enter the selected GLB export.
world=bpy.data.worlds.new('SV_PreviewWorld')
world.use_nodes=True
background=next(node for node in world.node_tree.nodes if node.type=='BACKGROUND')
background.inputs['Color'].default_value=(.32,.48,.67,1)
background.inputs['Strength'].default_value=.52
scene.world=world
sun_data=bpy.data.lights.new('SV_PreviewSun_Data','SUN')
sun=bpy.data.objects.new('SV_PreviewSun',sun_data)
PREVIEW.objects.link(sun)
sun.rotation_euler=(math.radians(27),math.radians(-25),math.radians(-33))
sun_data.energy=2.4
fill_data=bpy.data.lights.new('SV_PreviewFill_Data','AREA')
fill=bpy.data.objects.new('SV_PreviewFill',fill_data)
PREVIEW.objects.link(fill)
fill.location=d_to_b((18,62,38))
fill.rotation_euler=(math.radians(18),math.radians(5),math.radians(-25))
fill_data.energy=1800
fill_data.shape='DISK'
fill_data.size=34
camera_data=bpy.data.cameras.new('SV_PreviewCamera_Data')
camera=bpy.data.objects.new('SV_PreviewCamera',camera_data)
PREVIEW.objects.link(camera)
camera.location=d_to_b((17,64,67))
target=Vector(d_to_b((18,46,-66)))
camera.rotation_euler=(target-Vector(camera.location)).to_track_quat('-Z','Y').to_euler()
camera_data.lens=48
scene.camera=camera
scene.render.resolution_x=1600
scene.render.resolution_y=900
scene.render.resolution_percentage=75
scene.render.image_settings.file_format='PNG'
scene.render.filepath=OUT+'/sky-voyage-preview.png'
try:
    scene.render.engine='BLENDER_EEVEE_NEXT'
except TypeError:
    pass
scene.render.film_transparent=False

# Assert requested anchors and root transforms before writing either artifact.
assert ship.location.length < .001
assert tuple(round(v,3) for v in city.location) == (35.0,140.0,0.0)
assert bpy.data.objects.get('SV_CabinRoof') is roof
assert tuple(round(v,3) for v in sign.location) == (-4.0,0.0,0.0)
assert len([o for o in scene.objects if o.name.startswith('SV_CabinFrontWindow_') and o.type=='EMPTY']) == 4
assert not any(o.name.startswith('SV_CabinFrontWindowGlass_') for o in scene.objects)
assert all(bpy.data.objects.get('SV_Bed_%d'%i) is not None for i in range(4))
assert all(bpy.data.objects.get('SV_Bed_%d_SleepAnchor'%i) is not None for i in range(4))
assert len([o for o in scene.objects if o.name.startswith('SV_SatelliteIsland_') and o.name.endswith('_RockBody')]) == len(satellites)
assert len([o for o in scene.objects if o.name.startswith('SV_Waterfall_') and o.name.endswith('_Water')]) >= 8
assert not any(o.name.startswith(('CE_', 'HN_', 'HR_')) for o in [*SHIP.objects,*CITY.objects])

# Pack imported source textures for a portable editable blend; export only SV mesh/anchor nodes.
bpy.ops.file.pack_all()
selection=[o for o in scene.objects if o.name.startswith('SV_') and o.type in {'MESH','EMPTY'}]
previous_selected=[]
for other_scene in bpy.data.scenes:
    for view_layer in other_scene.view_layers:
        for obj in list(view_layer.objects):
            try:
                if obj.select_get(view_layer=view_layer) and not obj.name.startswith('SV_'):
                    previous_selected.append((obj,view_layer))
                obj.select_set(False,view_layer=view_layer)
            except RuntimeError:
                pass
for obj in selection:
    obj.select_set(True)
bpy.context.view_layer.objects.active=ship
try:
    bpy.ops.export_scene.gltf(filepath=GLB,export_format='GLB',use_selection=True,export_yup=True,export_extras=True,export_apply=True)
except TypeError:
    bpy.ops.export_scene.gltf(filepath=GLB,export_format='GLB',use_selection=True,export_yup=True,export_extras=True)
for obj in selection:
    obj.select_set(False)
for obj,view_layer in previous_selected:
    try:
        if obj.name in bpy.data.objects:
            obj.select_set(True,view_layer=view_layer)
    except RuntimeError:
        pass

# Set a useful real 3D viewport framing for the before/after evidence screenshot.
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type=='VIEW_3D':
            space=area.spaces.active
            space.region_3d.view_location=Vector(d_to_b((17,45,-66)))
            space.region_3d.view_distance=212
            space.region_3d.view_rotation=(Vector(d_to_b((17,45,-66)))-Vector(d_to_b((17,64,67)))).to_track_quat('-Z','Y')
            space.region_3d.view_perspective='PERSP'
            space.shading.type='MATERIAL'
            space.shading.use_scene_lights=True
            space.shading.use_scene_world=True
bpy.ops.wm.save_as_mainfile(filepath=BLEND,compress=True)

print('SV_BUILD_OK',scene.name,'objects=',len(scene.objects),'selected=',len(selection),'glb=',GLB,'blend=',BLEND)
