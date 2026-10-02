"""Build the editable TMS273-referenced, v4-inspired sky-voyage model in Blender MCP."""
import bpy
import math
import random
from mathutils import Vector, Matrix

ROOT = '/Users/muniao/Code/MapleStory'
OUT = ROOT + '/resources/scenes/sky-voyage-v2'
BLEND = OUT + '/models/sky-voyage.blend'
GLB = OUT + '/models/sky-voyage.glb'
WING = ROOT + '/resources/scenes/sky-voyage-v1/vendor/wings/wings-michael-fuchs.glb'
NATURE = ROOT + '/resources/scenes/henesys/rail-v1/vendor/nature/Stylized Nature MegaKit[Standard]/glTF/'
SEED = 20261002
rng = random.Random(SEED)

scene = bpy.data.scenes.get('SV2_SkyVoyage') or bpy.data.scenes.new('SV2_SkyVoyage')
if bpy.context.window is not None:
    bpy.context.window.scene = scene
scene['sv_units'] = 'metres'
scene['sv_design_axes'] = 'x lateral, y up, z depth; bow=-z; Blender=(x,-z,y); glTF Y-up'
scene['sv_provenance'] = 'GMS83/TMS273 pixel-verified Orbis ship references; original P 3D structure and enlarged interior'

def collection(name):
    result = bpy.data.collections.get(name)
    if result is None:
        result = bpy.data.collections.new(name)
        scene.collection.children.link(result)
    return result

SHIP = collection('SV2_ShipModel')
CITY = collection('SV2_CityModel')
PREVIEW = collection('SV2_PreviewOnly')

def d_to_b(point):
    x, y, z = point
    return (x, -z, y)

def material(name, color, roughness=0.58, metallic=0.0, emission=0.0):
    m = bpy.data.materials.get('SV2_Mat_' + name) or bpy.data.materials.new('SV2_Mat_' + name)
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

import json
M = {key: material(*args) for key,args in json.loads('{"deck": ["ShipDeck", [0.58, 0.39, 0.22], 0.72], "plank": ["DeckPlank", [0.53, 0.31, 0.15], 0.69], "plankLight": ["DeckPlankLight", [0.64, 0.4, 0.205], 0.72], "woodDark": ["WoodDark", [0.54, 0.61, 0.6], 0.61], "wood": ["Wood", [0.91, 0.89, 0.82], 0.58], "woodLight": ["WoodLight", [0.98, 0.96, 0.89], 0.47], "green": ["ShipTeal", [0.025, 0.25, 0.235], 0.35, 0.12], "greenLight": ["ShipTealLight", [0.055, 0.39, 0.335], 0.38, 0.08], "gold": ["WarmBrass", [0.8, 0.64, 0.34], 0.28, 0.73], "goldLight": ["PaleGold", [0.97, 0.72, 0.25], 0.25, 0.64], "iron": ["Iron", [0.13, 0.17, 0.2], 0.42, 0.7], "cream": ["SailCream", [0.96, 0.94, 0.86], 0.86], "leaf": ["MapleCopper", [0.72, 0.19, 0.055], 0.48, 0.05], "leafVein": ["LeafGold", [0.98, 0.6, 0.18], 0.43, 0.18], "glass": ["CabinGlass", [0.09, 0.29, 0.46], 0.2, 0.22, 0.32], "windowWarm": ["WindowWarm", [1.0, 0.59, 0.23], 0.24, 0.05, 0.8], "stone": ["CastleIvory", [0.82, 0.8, 0.72], 0.69], "stoneBright": ["CastlePorcelain", [0.96, 0.925, 0.83], 0.54], "stoneShade": ["CastleShadow", [0.55, 0.59, 0.6], 0.78], "roof": ["DeepAzureRoof", [0.035, 0.23, 0.34], 0.28, 0.26], "roofLight": ["TurquoiseRoof", [0.08, 0.49, 0.56], 0.23, 0.2], "crystal": ["AetherCrystal", [0.07, 0.73, 0.92], 0.14, 0.25, 1.65], "water": ["WaterfallBlue", [0.12, 0.68, 0.88], 0.2, 0.06, 0.3], "waterBright": ["WaterfallFoam", [0.6, 0.89, 0.98], 0.19, 0.0, 0.5], "grass": ["IslandGrass", [0.49, 0.66, 0.57], 0.93], "grassLight": ["IslandGrassLight", [0.37, 0.56, 0.3], 0.91], "rock": ["FloatingRock", [0.37, 0.44, 0.49], 0.88], "rockLight": ["FloatingRockLight", [0.58, 0.63, 0.64], 0.91], "rockDark": ["FloatingRockShade", [0.2, 0.26, 0.31], 0.95], "cloudTint": ["MistPearl", [0.78, 0.86, 0.91], 0.74]}').items()}

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
    obj=import_joined(NATURE+filename+'.gltf','SV2_Template_'+name,CITY,None,True)
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

ship=bpy.data.objects.get('SV2_Ship') or anchor('SV2_Ship',(0,0,0),None,SHIP)
ship.empty_display_type='CUBE'
ship.empty_display_size=2.0
ship['runtime_root']=True
ship['source_class']='P'
ship['source_reference']='TMS273 Map.wz/Obj/vehicle.img/ship/ossyria/99 consulted as a 2D ship reference'
city=bpy.data.objects.get('SV2_City') or anchor('SV2_City',(450,-80,-2200),None,CITY)
city.empty_display_type='CUBE'
city.empty_display_size=5.0
city['runtime_root']=True
city['source_class']='P'
city['source_reference']='TMS273 Map.wz/Map/Map2/200000000.img (destination identity/layout context only)'


# Primary-owned presentation topology contract.
import json
LAYOUT = json.loads('{"schema": "maple.sky-voyage.source-layout.v2", "scene": "SV2_SkyVoyage", "units": "metres", "interpretation": "P: horizontal linear dimensions enlarged; human fittings retain human scale; no ticket/gameplay authority.", "axis": {"design": "x lateral, y up, z depth; bow=-z", "blenderZUpConversion": "design (x,y,z) -> Blender (x,-z,y)", "gltf": "Y-up"}, "roots": {"SV2_Ship": {"gameWorld": [0, 0, 0], "runtimeMovable": true}, "SV2_City": {"gameWorld": [450, -80, -2200], "runtimeMovable": false}}, "city": {"mainIslandSize": [1800, 1280], "sourceV1Size": [90, 64], "horizontalLinearMultiplier": 20, "topBaseY": 60, "nodes": {"dock": [0, 60, 520], "plaza": [0, 62, 250], "forecourt": [0, 80, -80], "lf": [-480, 60, 300], "lg": [-620, 64, 0], "lr": [-450, 75, -340], "rf": [480, 60, 300], "rg": [620, 64, 0], "rr": [450, 75, -340], "rear": [0, 80, -450]}, "routes": [{"id": "royal-axis", "from": "dock", "to": "plaza", "width": 18, "points": [[0, 60, 520], [0, 60, 420], [0, 62, 250]]}, {"id": "palace-approach", "from": "plaza", "to": "forecourt", "width": 18, "points": [[0, 62, 250], [0, 68, 110], [0, 80, -80]]}, {"id": "left-arrival", "from": "plaza", "to": "lf", "width": 14, "points": [[0, 62, 250], [-240, 61, 290], [-480, 60, 300]]}, {"id": "left-garden", "from": "lf", "to": "lg", "width": 12, "points": [[-480, 60, 300], [-590, 62, 160], [-620, 64, 0]]}, {"id": "left-upper", "from": "lg", "to": "lr", "width": 12, "points": [[-620, 64, 0], [-600, 70, -190], [-450, 75, -340]]}, {"id": "left-palace", "from": "lr", "to": "forecourt", "width": 14, "points": [[-450, 75, -340], [-260, 79, -150], [0, 80, -80]]}, {"id": "right-arrival", "from": "plaza", "to": "rf", "width": 14, "points": [[0, 62, 250], [240, 61, 290], [480, 60, 300]]}, {"id": "right-garden", "from": "rf", "to": "rg", "width": 12, "points": [[480, 60, 300], [590, 62, 160], [620, 64, 0]]}, {"id": "right-upper", "from": "rg", "to": "rr", "width": 12, "points": [[620, 64, 0], [600, 70, -190], [450, 75, -340]]}, {"id": "right-palace", "from": "rr", "to": "forecourt", "width": 14, "points": [[450, 75, -340], [260, 79, -150], [0, 80, -80]]}, {"id": "rear-west", "from": "lr", "to": "rear", "width": 10, "points": [[-450, 75, -340], [-240, 78, -470], [0, 80, -450]]}, {"id": "rear-east", "from": "rear", "to": "rr", "width": 10, "points": [[0, 80, -450], [240, 78, -470], [450, 75, -340]]}, {"id": "rim-west", "from": "dock", "to": "lf", "width": 10, "points": [[0, 60, 520], [-360, 60, 460], [-650, 60, 400], [-480, 60, 300]]}, {"id": "rim-east", "from": "dock", "to": "rf", "width": 10, "points": [[0, 60, 520], [360, 60, 460], [650, 60, 400], [480, 60, 300]]}], "layoutAuthority": "presentation geometry and future navigation source, not current server movement", "waterBodies": [{"kind": "pool", "id": "west-rear-reflecting-pool", "center": [-370, 60.395, -490], "size": [74, 58], "depth": 2.6}, {"kind": "pool", "id": "east-rear-reflecting-pool", "center": [370, 58.121, -490], "size": [74, 58], "depth": 2.6}, {"kind": "pool", "id": "west-formal-garden-pool", "center": [-300, 59.6, 60], "size": [68, 50], "depth": 2.6}, {"kind": "pool", "id": "east-formal-garden-pool", "center": [300, 62.999, 60], "size": [68, 50], "depth": 2.6}, {"kind": "river", "id": "west-falls-creek", "points": [[-399.994, 60.17, -506.98], [-404.263, 60.138, -509.459], [-411.815, 60.082, -513.763], [-419.688, 60.023, -518.125], [-427.805, 59.962, -522.451], [-436.089, 59.9, -526.65], [-444.464, 59.838, -530.63], [-452.852, 59.777, -534.297], [-461.176, 59.716, -537.56], [-469.36, 59.656, -540.326], [-477.327, 59.598, -542.504], [-485, 59.544, -544], [-492.583, 59.49, -545.067], [-500.313, 59.437, -545.996], [-508.168, 59.384, -546.754], [-516.119, 59.33, -547.308], [-524.144, 59.277, -547.624], [-532.216, 59.223, -547.671], [-540.311, 59.17, -547.414], [-548.402, 59.116, -546.821], [-556.465, 59.063, -545.858], [-564.475, 59.01, -544.493], [-572.406, 58.956, -542.692], [-580.233, 58.903, -540.423], [-587.932, 58.85, -537.652], [-595.476, 58.797, -534.347], [-602.84, 58.745, -530.474], [-610, 58.692, -526], [-617.141, 58.639, -520.524], [-624.428, 58.583, -513.79], [-631.805, 58.525, -505.982], [-639.217, 58.465, -497.286], [-646.608, 58.406, -487.886], [-653.923, 58.346, -477.967], [-661.104, 58.286, -467.713], [-668.098, 58.228, -457.31], [-674.847, 58.171, -446.942], [-681.296, 58.117, -436.794], [-687.389, 58.065, -427.05], [-693.071, 58.017, -417.896], [-698.286, 57.973, -409.517], [-702.978, 57.933, -402.096], [-707.091, 57.899, -395.819], [-710.57, 57.87, -390.87]], "width": 10, "depth": 1.6, "flow": 1.6}, {"kind": "river", "id": "east-falls-creek", "points": [[399.994, 58.013, -506.98], [404.263, 57.997, -509.459], [411.815, 57.97, -513.763], [419.688, 57.942, -518.125], [427.805, 57.912, -522.451], [436.089, 57.883, -526.65], [444.464, 57.853, -530.63], [452.852, 57.823, -534.297], [461.176, 57.793, -537.56], [469.36, 57.765, -540.326], [477.327, 57.737, -542.504], [485, 57.711, -544], [492.62, 57.685, -545.039], [500.454, 57.659, -545.893], [508.461, 57.634, -546.538], [516.602, 57.608, -546.953], [524.835, 57.582, -547.116], [533.12, 57.556, -547.006], [541.418, 57.531, -546.599], [549.688, 57.505, -545.875], [557.889, 57.479, -544.811], [565.981, 57.454, -543.385], [573.925, 57.428, -541.575], [581.68, 57.402, -539.359], [589.205, 57.377, -536.716], [596.46, 57.351, -533.623], [603.405, 57.325, -530.058], [610, 57.3, -526], [616.382, 57.273, -521.082], [622.7, 57.246, -515.061], [628.928, 57.217, -508.099], [635.039, 57.187, -500.359], [641.009, 57.158, -492.005], [646.812, 57.128, -483.197], [652.421, 57.098, -474.1], [657.812, 57.069, -464.875], [662.96, 57.04, -455.685], [667.837, 57.013, -446.693], [672.419, 56.987, -438.062], [676.68, 56.963, -429.953], [680.594, 56.94, -422.53], [684.136, 56.921, -415.955], [687.28, 56.903, -410.391], [690, 56.889, -406]], "width": 10, "depth": 1.6, "flow": 1.6}, {"kind": "fall", "id": "cliff-fall-01", "from": [885.63, 55.94, 140.83], "to": [917.51, -268.06, 145.9], "width": 10}, {"kind": "fall", "id": "cliff-fall-02", "from": [-334.58, 57.88, 597.07], "to": [-346.63, -290.12, 618.56], "width": 10}, {"kind": "fall", "id": "cliff-fall-03", "from": [-777.35, 57.77, 332.55], "to": [-805.33, -242.23, 344.52], "width": 14}, {"kind": "fall", "id": "cliff-fall-04", "from": [-880.56, 58.76, -100.03], "to": [-912.26, -265.24, -103.63], "width": 10}, {"kind": "fall", "id": "cliff-fall-05", "from": [-710.57, 57.87, -390.87], "to": [-736.15, -290.13, -404.95], "width": 10}, {"kind": "fall", "id": "cliff-fall-06", "from": [-235.79, 58.64, -624.29], "to": [-244.28, -241.36, -646.76], "width": 14}, {"kind": "fall", "id": "cliff-fall-07", "from": [396.01, 57.06, -571.82], "to": [410.26, -266.94, -592.4], "width": 10}, {"kind": "fall", "id": "cliff-fall-08", "from": [688.89, 56.89, -406.94], "to": [713.69, -291.11, -421.59], "width": 10}]}, "ship": {"beam": {"xMin": -35, "xMax": 35}, "length": {"zMin": -75, "zMax": 75}, "sourceV1Size": [14, 30], "horizontalLinearMultiplier": 5, "deckSurfaceY": 0, "layers": [-5, 0, 7], "cabin": {"xMin": -9, "xMax": 9, "zMin": 32, "zMax": 48, "floorY": 0, "wallHeight": 6, "frontWindowCount": 4, "windowAnchors": [[-5.4, 3.75, 31.78], [-1.8, 3.75, 31.78], [1.8, 3.75, 31.78], [5.4, 3.75, 31.78]], "roofToggleNode": "SV2_CabinRoof", "backWallHideNodes": ["SV2_CabinBackWall", "SV2_CabinBackTrim"]}, "beds": {"visualCount": 4, "anchors": [[-5.4, 0, 43], [-1.8, 0, 43], [1.8, 0, 43], [5.4, 0, 43]], "footLocal": [0, 0, 1.3], "sleepLocal": [0, 0.82, 0], "capacityPolicy": "visual berths do not cap account slots"}, "loginSign": {"node": "SV2_LoginSign", "anchor": [-8, 0, -20], "size": [4, 6]}, "deckAvatar": [0, 0.1, -24], "reference": {"exteriorSheet": "design/ship-orthographic-v2.png", "interiorSheet": "design/ship-interior-plan-v1.png", "sourceSprite": "references/tms273-orbis-ship-source.png", "scope": "Original Orbis silhouette reference; ivory/gold palette and expanded 3D passenger interiors are P adaptations, not official plans."}}, "runtimePresentation": {"owner": "client/src/features/entry/voyage.ts", "city": {"position": [450, -80, -2200], "uniformScale": 1}, "cameraPoses": {"far": {"eye": [1500, 1100, 2000], "aim": [250, 150, -1300]}, "mid": {"eye": [260, 150, 370], "aim": [170, 160, -700]}, "deck": {"eye": [22, 18, 36], "aim": [-8, 12, -160]}, "create": {"eye": [6, 6, 56], "aim": [6, 3.4, 31]}, "characters": {"eye": [0, 9, 51], "aim": [0, 0.5, 43]}, "city": {"eye": [1900, 1300, -600], "aim": [450, 70, -2200]}, "ship": {"eye": [155, 110, 180], "aim": [0, 30, 0]}, "water": {"eye": [165, 50, -2580], "aim": [80, -19.605, -2690]}, "cabin": {"eye": [7, 6, 56], "aim": [7, 3.4, 31]}}, "introSeconds": 12, "shipTravelZ": [180, 0], "cameraClipping": {"near": 1, "far": 24000}}}')
