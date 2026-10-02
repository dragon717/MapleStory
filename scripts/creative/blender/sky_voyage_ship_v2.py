"""Reference-led Orbis airship geometry; run after sky_voyage_common_v2.py."""
import math

assert ship.name == 'SV2_Ship'
assert tuple(round(float(v), 3) for v in ship.location) == (0.0, 0.0, 0.0)
assert all(abs(float(v) - 1.0) < 1e-5 for v in ship.scale)

# Re-running this chunk replaces only ship descendants and SV2 ship geometry.
SV2_OLD_OBJECTS = {}
for obj in list(bpy.data.objects):
    if obj == ship:
        continue
    parent = obj.parent
    while parent is not None and parent != ship:
        parent = parent.parent
    if parent == ship:
        SV2_OLD_OBJECTS[obj.name] = obj
for obj in list(SHIP.objects):
    if obj != ship and obj.name.startswith('SV2_'):
        SV2_OLD_OBJECTS[obj.name] = obj
for obj in SV2_OLD_OBJECTS.values():
    bpy.data.objects.remove(obj, do_unlink=True)

ship['runtime_root'] = True
ship['design_axes'] = 'x lateral, y up, z depth; bow=-z; Blender=(x,-z,y)'
ship['model_version'] = 2
ship['reference_basis'] = 'TMS273 Orbis ship parts; orthographic-v2 dimensional adaptation'


def sv2_material(name, color, roughness=.42, metallic=0.0, emission=0.0):
    mat = bpy.data.materials.get('SV2_M_' + name) or bpy.data.materials.new('SV2_M_' + name)
    mat.diffuse_color = (*color, 1.0)
    mat.use_nodes = True
    shader = next(node for node in mat.node_tree.nodes if node.type == 'BSDF_PRINCIPLED')
    shader.inputs['Base Color'].default_value = (*color, 1.0)
    shader.inputs['Roughness'].default_value = roughness
    shader.inputs['Metallic'].default_value = metallic
    if emission:
        shader.inputs['Emission Color'].default_value = (*color, 1.0)
        shader.inputs['Emission Strength'].default_value = emission
    return mat


SV2_M = {
    'silver': sv2_material('SilverEnamel', (.79, .84, .86), .27, .66),
    'silverLight': sv2_material('SilverHighlight', (.93, .95, .94), .24, .53),
    'silverShade': sv2_material('SilverShadow', (.34, .42, .47), .34, .72),
    'iron': sv2_material('BlueIron', (.075, .12, .17), .31, .78),
    'gold': sv2_material('ChampagneBrass', (.78, .54, .25), .27, .76),
    'goldLight': sv2_material('PaleBrass', (.97, .78, .43), .22, .66),
    'green': sv2_material('JadeEnamel', (.018, .25, .19), .25, .43),
    'greenLight': sv2_material('JadeHighlight', (.045, .43, .31), .24, .34),
    'gemBlue': sv2_material('Sapphire', (.025, .25, .68), .17, .42, .20),
    'gemCyan': sv2_material('Aquamarine', (.03, .59, .78), .15, .32, .30),
    'gemGreen': sv2_material('Emerald', (.015, .52, .25), .17, .35, .18),
    'gemRed': sv2_material('Ruby', (.69, .045, .075), .19, .35, .08),
    'gemAmber': sv2_material('AmberCrystal', (1.0, .19, .012), .16, .24, 1.25),
    'wood': sv2_material('WarmOak', (.40, .23, .12), .67),
    'woodLight': sv2_material('HoneyOak', (.64, .42, .22), .62),
    'woodPale': sv2_material('LightOak', (.76, .56, .34), .62),
    'woodDark': sv2_material('OiledOak', (.22, .12, .07), .61),
    'canvas': sv2_material('CreamCanvas', (.94, .91, .82), .77),
    'glass': sv2_material('BluePortholeGlass', (.018, .09, .16), .17, .28, .12),
    'glassWarm': sv2_material('LanternGlass', (1.0, .48, .12), .2, .12, 1.0),
    'rope': sv2_material('CanvasRope', (.61, .49, .31), .75),
    'shadow': sv2_material('InsetShadow', (.025, .035, .045), .76),
}


def sv2_box_batch(name, entries, mats, parent=ship, bevel=0.0):
    vertices, faces, face_mats = [], [], []
    cube_faces = ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
                  (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7))
    for center, size, mat_index in entries:
        x, y, z = center
        sx, sy, sz = (part * .5 for part in size)
        base = len(vertices)
        vertices.extend(((x-sx,y-sy,z-sz),(x+sx,y-sy,z-sz),
                         (x+sx,y+sy,z-sz),(x-sx,y+sy,z-sz),
                         (x-sx,y-sy,z+sz),(x+sx,y-sy,z+sz),
                         (x+sx,y+sy,z+sz),(x-sx,y+sy,z+sz)))
        faces.extend(tuple(base + index for index in face) for face in cube_faces)
        face_mats.extend([mat_index] * len(cube_faces))
    obj = mesh_d(name, vertices, faces, mats, face_materials=face_mats,
                 parent=parent, target=SHIP, uv=False)
    if bevel:
        mod = obj.modifiers.new('SV2 softened metalwork', 'BEVEL')
        mod.width = bevel
        mod.segments = 2
    return obj


def sv2_cross(a, b):
    return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])


def sv2_norm(v):
    length = math.sqrt(sum(value*value for value in v))
    if length < 1e-7:
        return (0.0, 0.0, 1.0)
    return tuple(value / length for value in v)


def sv2_tube_batch(name, paths, radius, mat, parent=ship, sides=8):
    vertices, faces = [], []
    for points in paths:
        if len(points) < 2:
            continue
        base = len(vertices)
        for i, point in enumerate(points):
            before = points[max(0, i-1)]
            after = points[min(len(points)-1, i+1)]
            tangent = sv2_norm(tuple(after[k]-before[k] for k in range(3)))
            reference = (0.0, 0.0, 1.0) if abs(tangent[2]) < .90 else (0.0, 1.0, 0.0)
            u = sv2_norm(sv2_cross(tangent, reference))
            v = sv2_norm(sv2_cross(tangent, u))
            for j in range(sides):
                angle = math.tau*j/sides
                vertices.append(tuple(point[k] + radius*(math.cos(angle)*u[k] + math.sin(angle)*v[k])
                                      for k in range(3)))
        for i in range(len(points)-1):
            for j in range(sides):
                a = base + i*sides + j
                b = base + i*sides + (j+1)%sides
                faces.append((a, b, b+sides, a+sides))
        faces.append(tuple(base+j for j in reversed(range(sides))))
        end = base + (len(points)-1)*sides
        faces.append(tuple(end+j for j in range(sides)))
    return mesh_d(name, vertices, faces, mat, parent=parent, target=SHIP,
                  smooth=True, uv=False)


def sv2_spheres(name, balls, mat, parent=ship, segments=8, rings=5):
    vertices, faces = [], []
    for center, scale in balls:
        x, y, z = center
        rx, ry, rz = scale
        base = len(vertices)
        vertices.append((x, y+ry, z))
        for ring in range(1, rings):
            phi = math.pi*ring/rings
            for column in range(segments):
                theta = math.tau*column/segments
                vertices.append((x+rx*math.sin(phi)*math.cos(theta),
                                 y+ry*math.cos(phi),
                                 z+rz*math.sin(phi)*math.sin(theta)))
        south = len(vertices)
        vertices.append((x, y-ry, z))
        for column in range(segments):
            faces.append((base, base+1+column, base+1+(column+1)%segments))
        middle_rings = rings-1
        for ring in range(middle_rings-1):
            a = base+1+ring*segments
            b = a+segments
            for column in range(segments):
                j = (column+1)%segments
                faces.append((a+column, b+column, b+j, a+j))
        last = base+1+(middle_rings-1)*segments
        for column in range(segments):
            faces.append((last+column, south, last+(column+1)%segments))
    return mesh_d(name, vertices, faces, mat, parent=parent, target=SHIP,
                  smooth=False, uv=False)


def sv2_torus_batch(name, centers, major_radius, minor_radius, mat,
                    parent=ship, axis='x', segments=24, sides=6):
    vertices, faces = [], []
    for center in centers:
        cx, cy, cz = center
        base = len(vertices)
        for i in range(segments):
            theta = math.tau*i/segments
            c, s = math.cos(theta), math.sin(theta)
            for j in range(sides):
                phi = math.tau*j/sides
                tube_side = minor_radius*math.sin(phi)
                radial = major_radius + minor_radius*math.cos(phi)
                if axis == 'x':
                    vertices.append((cx+tube_side, cy+radial*c, cz+radial*s))
                elif axis == 'z':
                    vertices.append((cx+radial*c, cy+radial*s, cz+tube_side))
                else:
                    vertices.append((cx+radial*c, cy+tube_side, cz+radial*s))
        for i in range(segments):
            for j in range(sides):
                a = base+i*sides+j
                b = base+i*sides+(j+1)%sides
                c = base+((i+1)%segments)*sides+(j+1)%sides
                d = base+((i+1)%segments)*sides+j
                faces.append((a, b, c, d))
    return mesh_d(name, vertices, faces, mat, parent=parent, target=SHIP,
                  smooth=True, uv=False)


def sv2_disks_x(name, centers, radius, mat, segments=20):
    vertices, faces = [], []
    for x, y, z in centers:
        base = len(vertices)
        vertices.append((x, y, z))
        vertices.extend((x, y+radius*math.cos(math.tau*i/segments),
                         z+radius*math.sin(math.tau*i/segments))
                        for i in range(segments))
        for i in range(segments):
            faces.append((base, base+1+i, base+1+(i+1)%segments))
    return mesh_d(name, vertices, faces, mat, parent=ship, target=SHIP,
                  smooth=True, uv=False)


def sv2_gem_x_batch(name, centers, radius, mat, sides=8):
    vertices, faces = [], []
    for x, y, z in centers:
        base = len(vertices)
        vertices.extend(((x-radius*.55, y, z), (x+radius*.55, y, z)))
        for ring_y, ring_z, x_offset in ((radius, radius*.65, -.34*radius),
                                         (radius, radius*.65, .34*radius)):
            for i in range(sides):
                a = math.tau*i/sides
                vertices.append((x+x_offset, y+ring_y*math.cos(a), z+ring_z*math.sin(a)))
        back, front = base, base+1
        ring0, ring1 = base+2, base+2+sides
        for i in range(sides):
            j = (i+1)%sides
            faces.append((back, ring0+i, ring0+j))
            faces.append((front, ring1+j, ring1+i))
            faces.append((ring0+i, ring1+i, ring1+j, ring0+j))
    return mesh_d(name, vertices, faces, mat, parent=ship, target=SHIP,
                  smooth=False, uv=False)


SV2_STATIONS = [
    (-75.0, 1.1, 16.5, 4.0), (-72.0, 4.5, 15.0, -2.0),
    (-66.0, 10.0, 12.4, -8.0), (-57.0, 17.0, 9.5, -13.0),
    (-45.0, 24.0, 7.4, -16.5), (-27.0, 31.0, 6.0, -18.5),
    (-5.0, 35.0, 5.7, -19.0), (20.0, 34.0, 6.2, -18.0),
    (37.0, 31.5, 7.6, -16.0), (49.0, 29.5, 9.4, -13.2),
    (57.0, 27.0, 11.5, -10.0), (65.0, 22.0, 13.6, -6.0),
    (71.0, 14.5, 15.5, -1.0), (75.0, 2.0, 16.5, 4.0),
]
SV2_CROSS = [(-1.0,1.0),(-.96,.82),(-.83,.58),(-.63,.34),(-.36,.13),
             (0.0,0.0),(.36,.13),(.63,.34),(.83,.58),(.96,.82),(1.0,1.0)]
SV2_SIDE_PROFILE = [(0.0,0.0),(.11,.36),(.30,.63),(.56,.84),(.82,.96),(1.0,1.0)]


def sv2_profile(z):
    z = max(SV2_STATIONS[0][0], min(SV2_STATIONS[-1][0], z))
    for a, b in zip(SV2_STATIONS, SV2_STATIONS[1:]):
        if z <= b[0]:
            t = (z-a[0])/(b[0]-a[0])
            return tuple(a[i] + (b[i]-a[i])*t for i in range(1,4))
    return SV2_STATIONS[-1][1:]


def sv2_halfwidth_at_y(z, y):
    width, top, keel = sv2_profile(z)
    if y < keel or y > top or width <= .01:
        return 0.0
    h = (y-keel)/(top-keel)
    for (h0,x0),(h1,x1) in zip(SV2_SIDE_PROFILE,SV2_SIDE_PROFILE[1:]):
        if h <= h1:
            t = (h-h0)/(h1-h0)
            return width*(x0+(x1-x0)*t)
    return width


def sv2_outer_x(z, y, side, offset=0.0):
    return side*(sv2_halfwidth_at_y(z,y)+offset)


# Continuous silver hull loft, with a broad deck line and a raised needle bow.
SV2_HULL_VERTS, SV2_HULL_FACES, SV2_HULL_MATS = [], [], []
for z, width, top, keel in SV2_STATIONS:
    SV2_HULL_VERTS.extend((ratio*width, keel+(top-keel)*height, z)
                          for ratio,height in SV2_CROSS)
for station in range(len(SV2_STATIONS)-1):
    for row in range(len(SV2_CROSS)-1):
        i = station*len(SV2_CROSS)+row
        SV2_HULL_FACES.append((i,i+1,i+len(SV2_CROSS)+1,i+len(SV2_CROSS)))
        SV2_HULL_MATS.append(2 if row in (0,1,8,9) else (1 if row in (2,7) else 0))
SV2_HULL_FACES.extend((tuple(range(len(SV2_CROSS))),
                       tuple(reversed(range((len(SV2_STATIONS)-1)*len(SV2_CROSS),
                                            len(SV2_STATIONS)*len(SV2_CROSS))))))
SV2_HULL_MATS.extend((0,0))
SV2_HULL = mesh_d('SV2_Hull_ContinuousSilverShell', SV2_HULL_VERTS,
                  SV2_HULL_FACES,
                  [SV2_M['silver'],SV2_M['silverLight'],SV2_M['silverShade']],
                  face_materials=SV2_HULL_MATS, parent=ship, target=SHIP,
                  smooth=True, uv=False)
SV2_HULL['design_envelope_m'] = [150.0,70.0]
SV2_HULL['reference_profile'] = 'long low mechanical shell, rising bow cowl, rounded open stern'


def sv2_deck_mesh(name, z0, z1, y, materials, holes=(), upper=False, rows=72, columns=64):
    vertices, faces, face_mats = [], [], []
    for r in range(rows+1):
        z = z0+(z1-z0)*r/rows
        width = (max(0.0, min(29.0, sv2_halfwidth_at_y(z,0.0)-2.3)) if upper
                 else max(0.0, sv2_halfwidth_at_y(z,y)-.55))
        for c in range(columns+1):
            vertices.append(((2.0*c/columns-1.0)*width,y,z))
    for r in range(rows):
        zm = z0+(z1-z0)*(r+.5)/rows
        for c in range(columns):
            i = r*(columns+1)+c
            xm = (vertices[i][0]+vertices[i+1][0]+vertices[i+columns+1][0]
                  +vertices[i+columns+2][0])*.25
            if any(abs(xm-hx)<hw*.5 and hz0<=zm<=hz1 for hx,hz0,hz1,hw in holes):
                continue
            faces.append((i,i+columns+1,i+columns+2,i+1))
            face_mats.append(c % len(materials))
    obj = mesh_d(name, vertices, faces, materials, face_materials=face_mats,
                 parent=ship, target=SHIP, uv=False)
    obj['walkable_design_y'] = y
    return obj


SV2_WOOD_DECK = [SV2_M['wood'],SV2_M['woodLight'],SV2_M['woodPale']]
SV2_LOWER_DECK = sv2_deck_mesh('SV2_LowerDeck_YMinus5',-66.0,70.0,-5.0,SV2_WOOD_DECK,rows=74)
SV2_MAIN_DECK = sv2_deck_mesh('SV2_MainDeck_Y0',-72.0,73.0,0.0,SV2_WOOD_DECK,
                              holes=[(0.0,32.0,48.0,18.0)],rows=82)
SV2_UPPER_DECK = sv2_deck_mesh('SV2_UpperDeck_Y7',-63.0,31.0,7.0,SV2_WOOD_DECK,
                               holes=[(-3.0,-30.0,-14.0,20.0)],
                               upper=True,rows=58)

# Transverse ribs bind the three floors into one vessel rather than three plates.
SV2_MAIN_RIBS, SV2_UPPER_RIBS = [], []
for z in range(-56,57,8):
    width = max(3.0,sv2_halfwidth_at_y(float(z),0.0)-1.0)
    SV2_MAIN_RIBS.append(((0.0,-2.45,float(z)),(width*2,.48,1.45),0))
for z in range(-52,29,8):
    width = max(3.0,sv2_halfwidth_at_y(float(z),0.0)-1.8)
    SV2_UPPER_RIBS.append(((0.0,3.55,float(z)),(width*2,.52,1.30),0))
sv2_box_batch('SV2_MainDeckStructuralRibs',SV2_MAIN_RIBS,[SV2_M['iron']],bevel=.10)
sv2_box_batch('SV2_UpperDeckStructuralRibs',SV2_UPPER_RIBS,[SV2_M['silverShade']],bevel=.10)

# Thin enamel lines and plate seams follow the loft; rivets are one combined mesh.
SV2_SEAM_PATHS, SV2_JADE_PATHS, SV2_GOLD_PATHS = [], [], []
for side in (-1,1):
    for z in range(-59,61,8):
        points=[]
        for y in (-12.0,-8.0,-3.0,2.0,5.0):
            _,top,keel=sv2_profile(float(z))
            if keel < y < top:
                points.append((sv2_outer_x(float(z),y,side,.08),y,float(z)))
        if len(points)>1:
            SV2_SEAM_PATHS.append(points)
    for y,color_paths,offset in ((1.3,SV2_JADE_PATHS,.22),(1.75,SV2_GOLD_PATHS,.28)):
        points=[]
        for z in range(-64,65,4):
            if sv2_halfwidth_at_y(float(z),y)>4:
                points.append((sv2_outer_x(float(z),y,side,offset),y,float(z)))
        if len(points)>1:
            color_paths.append(points)
sv2_tube_batch('SV2_ArmorPanelSeams',SV2_SEAM_PATHS,.055,SV2_M['silverShade'])
sv2_tube_batch('SV2_JadeEnamelHullLines',SV2_JADE_PATHS,.16,SV2_M['green'])
sv2_tube_batch('SV2_GiltHullLines',SV2_GOLD_PATHS,.060,SV2_M['goldLight'])
SV2_RIVETS=[]
for side in (-1,1):
    for y in (-10.0,-6.0,-2.0,2.0,4.5):
        for z in range(-55,56,4):
            if sv2_halfwidth_at_y(float(z),y)>7.0:
                x=sv2_outer_x(float(z),y,side,.15)
                SV2_RIVETS.append(((x,y,float(z)),(.12,.14,.14)))
sv2_spheres('SV2_SilverShellRivets',SV2_RIVETS,SV2_M['goldLight'],segments=7,rings=4)

# Paired blue-glass porthole banks and jewel bezels are batched by finish.
SV2_PORTHOLES=[]
for y,radius in ((-10.0,.78),(-5.4,.70),(-.8,.62)):
    for z in range(-53,54,11):
        if 31.0<=z<=49.0 and y> -6.0:
            continue
        if sv2_halfwidth_at_y(float(z),y)>7:
            for side in (-1,1):
                x=sv2_outer_x(float(z),y,side,.20)
                SV2_PORTHOLES.append((side,float(z),y,radius,x))
sv2_torus_batch('SV2_HullPortholeBrass',[(x,y,z) for _,z,y,_,x in SV2_PORTHOLES],
                .72,.12,SV2_M['goldLight'],axis='x')
sv2_disks_x('SV2_HullPortholeGlass',
            [(x-.05*side,y,z) for side,z,y,_,x in SV2_PORTHOLES],.61,SV2_M['glass'])
SV2_JEWEL_CENTERS=[]
SV2_JEWEL_COLORS=[SV2_M['gemBlue'],SV2_M['gemGreen'],SV2_M['gemCyan'],
                  SV2_M['gemRed'],SV2_M['gemBlue']]
for side in (-1,1):
    for z in (-43.0,-22.0,0.0,22.0,43.0):
        y=2.45
        if sv2_halfwidth_at_y(z,y)>8:
            x=sv2_outer_x(z,y,side,.48)
            SV2_JEWEL_CENTERS.append((side,x,y,z))
sv2_torus_batch('SV2_GemstoneBezels',[(x,y,z) for _,x,y,z in SV2_JEWEL_CENTERS],
                1.02,.20,SV2_M['gold'],axis='x',segments=28,sides=8)
for color_index,mat in enumerate(SV2_JEWEL_COLORS):
    centers=[(x+side*.13,y,z) for side,x,y,z in SV2_JEWEL_CENTERS
             if abs(z-(-43+21*color_index))<.01]
    if centers:
        sv2_gem_x_batch('SV2_HullGems_%02d'%color_index,centers,.78,mat)

# Three open crescent galleries project beyond the rounded stern at the real deck heights.
SV2_AFT_CENTER_Z=51.0
SV2_AFT_OUTER=24.0
SV2_AFT_INNER=19.0


def sv2_aft_arc_mesh(name,y,outer=SV2_AFT_OUTER,inner=SV2_AFT_INNER,segments=36):
    vertices,faces=[],[]
    for i in range(segments+1):
        angle=-math.pi*.5+math.pi*i/segments
        for radius in (inner,outer):
            vertices.append((radius*math.sin(angle),y,
                             SV2_AFT_CENTER_Z+radius*math.cos(angle)))
    for i in range(segments):
        base=i*2
        faces.append((base,base+1,base+3,base+2))
    return mesh_d(name,vertices,faces,SV2_WOOD_DECK[1],parent=ship,target=SHIP,uv=False)


SV2_AFT_DECKS=[]
SV2_AFT_RAIL_PATHS=[]
SV2_AFT_POSTS=[]
for y,tag in ((-5.0,'Lower'),(0.0,'Main'),(7.0,'Upper')):
    deck=sv2_aft_arc_mesh('SV2_AftGallery_'+tag+'_Crescent',y)
    deck['walkable_design_y']=y
    SV2_AFT_DECKS.append(deck)
    rail_y=y+1.18
    arc=[]
    for i in range(37):
        angle=-math.pi*.5+math.pi*i/36
        x=SV2_AFT_OUTER*math.sin(angle)
        z=SV2_AFT_CENTER_Z+SV2_AFT_OUTER*math.cos(angle)
        arc.append((x,rail_y,z))
        if i%2==0:
            SV2_AFT_POSTS.append(((x,y+.55,z),(.18,1.10,.18),0))
    SV2_AFT_RAIL_PATHS.append(arc)
    # Short return rails close the open gallery ends against the hull shoulder.
    SV2_AFT_RAIL_PATHS.append([(-19.0,rail_y,SV2_AFT_CENTER_Z),
                               (-21.5,rail_y,SV2_AFT_CENTER_Z+.4)])
    SV2_AFT_RAIL_PATHS.append([(19.0,rail_y,SV2_AFT_CENTER_Z),
                               (21.5,rail_y,SV2_AFT_CENTER_Z+.4)])
sv2_box_batch('SV2_AftGalleryBalusters',SV2_AFT_POSTS,[SV2_M['gold']],bevel=.025)
for layer_index,y in enumerate((-5.0,0.0,7.0)):
    paths=[path for index,path in enumerate(SV2_AFT_RAIL_PATHS) if index//3==layer_index]
    sv2_tube_batch('SV2_AftGalleryHandrail_%02d'%layer_index,paths,.10,SV2_M['goldLight'])


def sv2_stairs(name,x,y0,z0,y1,z1,steps,width):
    treads=[]
    balusters=[]
    rail_paths=[[],[]]
    dz=(z1-z0)/steps
    dy=(y1-y0)/steps
    for i in range(steps):
        y=y0+dy*(i+1)
        z=z0+dz*(i+.5)
        treads.append(((x,y-.12,z),(width,.24,abs(dz)+.08),i%len(SV2_WOOD_DECK)))
        for side in (-1,1):
            if i%3==0 or i==steps-1:
                balusters.append(((x+side*(width*.5+.12),y+.45,z),(.12,.90,.12),0))
            rail_paths[0 if side<0 else 1].append((x+side*(width*.5+.12),y+.92,z))
    sv2_box_batch(name+'_Treads',treads,SV2_WOOD_DECK,bevel=.035)
    sv2_box_batch(name+'_RailPosts',balusters,[SV2_M['gold']],bevel=.018)
    sv2_tube_batch(name+'_Handrails',rail_paths,.075,SV2_M['goldLight'])


for side,suffix in ((-1,'Port'),(1,'Starboard')):
    stair_x=side*18.0
    sv2_stairs('SV2_AftStair_LowerToMain_'+suffix,stair_x,-5.0,57.2,0.0,61.4,10,2.0)
    sv2_stairs('SV2_AftStair_MainToUpper_'+suffix,stair_x,0.0,61.4,7.0,65.8,14,2.0)

# Upper-level aft side walks bridge the berth cabin to the crescent galleries.
for side,suffix in ((-1,'Port'),(1,'Starboard')):
    x=side*11.45
    sv2_box_batch('SV2_CabinAftWalk_'+suffix,[((x,6.82,42.5),(2.15,.36,22.0),0)],
                  [SV2_M['woodLight']],bevel=.06)
    sv2_tube_batch('SV2_CabinAftWalkRail_'+suffix,
                   [[(side*12.48,8.05,z) for z in (31.5,37,43,49,53.5)]],
                   .085,SV2_M['gold'])
    sv2_box_batch('SV2_CabinAftWalkPosts_'+suffix,
                  [((side*12.48,7.52,z),(.12,1.04,.12),0)
                   for z in (33,39,45,51)], [SV2_M['gold']],bevel=.015)
SV2_WALK_PIERS=[]
for side in (-1,1):
    for z in (34,39,44,49,53):
        x=side*12.48
        SV2_WALK_PIERS.extend((((x,3.20,z),(.44,6.40,.44),0),
                               ((x,.28,z),(.68,.56,.68),1),
                               ((x,6.38,z),(.62,.48,.62),2)))
sv2_box_batch('SV2_CabinAftWalkSupportPiers',SV2_WALK_PIERS,
              [SV2_M['silver'],SV2_M['gold'],SV2_M['goldLight']],bevel=.045)

# A low barrel-vault roof and an arched round-hull door mark the central deck entry.
SV2_CANOPY_CENTER_Z=14.0
SV2_CANOPY_VERTS=[]
SV2_CANOPY_FACES=[]
for row in range(2):
    z=SV2_CANOPY_CENTER_Z+(-8.5 if row==0 else 8.5)
    for column in range(25):
        u=column/24*2.0-1.0
        x=u*5.8
        y=7.0+2.45*math.sqrt(max(0.0,1-u*u))
        SV2_CANOPY_VERTS.append((x,y,z))
for column in range(24):
    SV2_CANOPY_FACES.append((column,column+1,25+column+1,25+column))
SV2_CANOPY=mesh_d('SV2_CentralBarrelVaultRoof',SV2_CANOPY_VERTS,SV2_CANOPY_FACES,
                   [SV2_M['woodLight'],SV2_M['woodPale']],
                   face_materials=[column%2 for column in range(24)],
                   parent=ship,target=SHIP,smooth=True,uv=False)
SV2_CANOPY_RIBS=[]
for z in (5.5,9.5,14.0,18.5,22.5):
    path=[]
    for column in range(25):
        u=column/24*2.0-1.0
        path.append((u*5.82,7.0+2.45*math.sqrt(max(0.0,1-u*u)),z))
    SV2_CANOPY_RIBS.append(path)
sv2_tube_batch('SV2_CentralCanopyBentOakRibs',SV2_CANOPY_RIBS,.16,SV2_M['woodDark'])
sv2_tube_batch('SV2_CentralCanopyGiltEdges',
               [[(-5.82,7.02,5.5),(-5.82,7.02,22.5)],
                [(5.82,7.02,5.5),(5.82,7.02,22.5)]],.085,SV2_M['goldLight'])
SV2_ENTRY=anchor('SV2_RoundHullDoorEntry',(0.0,7.0,22.5),ship,SHIP)
SV2_ENTRY['clear_opening_design_size']=[1.85,2.55]
SV2_ENTRY['facing_design']=[0,0,1]
sv2_tube_batch('SV2_RoundHullDoorArch',[
    [( -.92,7.02,22.55),(-.92,8.55,22.55),(-.72,9.25,22.55),
     (0,9.62,22.55),(.72,9.25,22.55),(.92,8.55,22.55),(.92,7.02,22.55)]
],.105,SV2_M['goldLight'])
sv2_box_batch('SV2_RoundHullDoorLeaf',[
    ((-.43,8.20,22.46),(.78,2.35,.12),0),
    ((.43,8.20,22.46),(.78,2.35,.12),0),
], [SV2_M['wood']],bevel=.05)
sv2_box_batch('SV2_RoundHullDoorBraces',[
    ((0,7.34,22.56),(1.62,.13,.10),0),
    ((0,9.05,22.56),(1.62,.13,.10),0),
    ((-.38,8.2,22.56),(.10,1.6,.10),1),
    ((.38,8.2,22.56),(.10,1.6,.10),1),
], [SV2_M['gold'],SV2_M['woodDark']],bevel=.025)

# Contracted berth cabin: the front is assembled around four real through-openings.
SV2_CABIN_WALLS=[]
SV2_CABIN_WALLS.extend((((-9.0,3.0,40.0),(.40,6.0,16.0),0),
                        ((9.0,3.0,40.0),(.40,6.0,16.0),0)))
sv2_box_batch('SV2_CabinSideWalls',SV2_CABIN_WALLS,[SV2_M['woodLight']],bevel=.055)
sv2_box_batch('SV2_CabinFrontWallBands',[
    ((0,1.125,31.78),(18,2.25,.42),0),
    ((0,5.625,31.78),(18,.75,.42),0),
], [SV2_M['woodLight']],bevel=.035)
SV2_WINDOW_X=(-5.4,-1.8,1.8,5.4)
SV2_FRONT_PIERS=[]
previous=-9.0
for x in SV2_WINDOW_X:
    left,right=x-.90,x+.90
    if left>previous:
        SV2_FRONT_PIERS.append((((left+previous)*.5,3.75,31.78),(left-previous,3.0,.42),0))
    previous=right
if previous<9.0:
    SV2_FRONT_PIERS.append((((previous+9.0)*.5,3.75,31.78),(9.0-previous,3.0,.42),0))
sv2_box_batch('SV2_CabinFrontWallPiers',SV2_FRONT_PIERS,[SV2_M['woodLight']],bevel=.035)
SV2_CABIN_FLOOR=mesh_d('SV2_CabinFloor',
    [(-9,-.025,32),(9,-.025,32),(9,-.025,48),(-9,-.025,48)],
    [(0,3,2,1)],SV2_M['woodPale'],parent=ship,target=SHIP,uv=False)
SV2_BACK_WALL=box('SV2_CabinBackWall',(0,3,48),(18,6,.42),SV2_M['woodLight'],ship,SHIP,.055)
SV2_BACK_TRIM=box('SV2_CabinBackTrim',(0,6.08,48),(18.7,.22,.62),SV2_M['goldLight'],ship,SHIP,.055)
SV2_BACK_WALL['runtime_hide_toggle']=True
SV2_BACK_TRIM['runtime_hide_toggle']=True
box('SV2_CabinFrontCap',(0,6.08,31.78),(18.7,.22,.62),SV2_M['goldLight'],ship,SHIP,.055)
for side,suffix in ((-1,'Port'),(1,'Starboard')):
    box('SV2_CabinSideBaseTrim_'+suffix,(side*9.22,.18,40),(.22,.30,16.3),SV2_M['gold'],ship,SHIP,.045)
    box('SV2_CabinSideCrown_'+suffix,(side*9.22,5.9,40),(.22,.20,16.4),SV2_M['goldLight'],ship,SHIP,.04)
for i,x in enumerate(SV2_WINDOW_X,1):
    window=anchor('SV2_CabinFrontWindow_%02d'%i,(x,3.75,31.78),ship,SHIP)
    window['runtime_anchor_design']=[x,3.75,31.78]
    window['facing_design']=[0,0,-1]
    sv2_box_batch('SV2_CabinWindowFrame_%02d'%i,[
        ((-.98,0,-.24),(.13,3.08,.19),0),((.98,0,-.24),(.13,3.08,.19),0),
        ((0,-1.50,-.24),(2.02,.16,.19),0),((0,1.50,-.24),(2.02,.16,.19),0),
        ((0,0,-.25),(.075,2.55,.12),1),((0,.10,-.25),(1.62,.075,.12),1),
    ], [SV2_M['gold'],SV2_M['goldLight']],parent=window,bevel=.02)
    sv2_box_batch('SV2_CabinWindowSill_%02d'%i,[((0,-1.63,-.30),(2.35,.17,.42),0)],
                  [SV2_M['woodPale']],parent=window,bevel=.035)

SV2_ROOF=anchor('SV2_CabinRoof',(0,0,0),ship,SHIP)
SV2_ROOF['runtime_hide_toggle']=True
SV2_ROOF['runtime_hide_group']='SV2_CabinRoof'
for side,suffix in ((-1,'Port'),(1,'Starboard')):
    panel=mesh_d('SV2_CabinRoofPanel_'+suffix,
        [(0,8.35,31.45),(side*9.9,6.2,31.45),(side*9.9,6.2,48.55),(0,8.35,48.55)],
        [(0,1,2,3)],SV2_M['silver'],parent=SV2_ROOF,target=SHIP,uv=False)
    panel['runtime_hide_toggle']=True
    panel['runtime_hide_group']='SV2_CabinRoof'
    eave=tube('SV2_CabinRoofEave_'+suffix,
              [(side*9.9,6.2,31.45),(side*9.9,6.2,48.55)],
              .13,SV2_M['gold'],SV2_ROOF,SHIP,8)
    eave['runtime_hide_toggle']=True
    eave['runtime_hide_group']='SV2_CabinRoof'
SV2_ROOF_RIDGE=tube('SV2_CabinRoofRidge',[(0,8.38,31.2),(0,8.38,48.8)],
                    .18,SV2_M['goldLight'],SV2_ROOF,SHIP,10)
SV2_ROOF_RIDGE['runtime_hide_toggle']=True
SV2_ROOF_RIDGE['runtime_hide_group']='SV2_CabinRoof'
for z in (31.45,48.55):
    gable=tube('SV2_CabinRoofGableTrim_%s'%int(z),
               [(-9.9,6.2,z),(0,8.35,z),(9.9,6.2,z)],
               .11,SV2_M['goldLight'],SV2_ROOF,SHIP,8)
    gable['runtime_hide_toggle']=True
    gable['runtime_hide_group']='SV2_CabinRoof'

# Four contracted beds remain human-sized inside the separate berth room.
for i,x in enumerate(SV2_WINDOW_X):
    bed=anchor('SV2_Bed_%d'%i,(x,0,43),ship,SHIP)
    bed['runtime_anchor']=True
    bed['runtime_anchor_design']=[x,0,43]
    anchor('SV2_Bed_%d_SleepAnchor'%i,(0,.82,0),bed,SHIP)
    anchor('SV2_Bed_%d_FootAnchor'%i,(0,0,1.3),bed,SHIP)
    sv2_box_batch('SV2_BedFrame_%d'%i,[((x,.23,43),(1.48,.42,2.70),0),
                                      ((x,.48,41.73),(1.58,.88,.16),0)],
                  [SV2_M['gold']],bevel=.06)
    box('SV2_BedMattress_%d'%i,(x,.56,43),(1.34,.22,2.48),SV2_M['woodPale'],ship,SHIP,.10)
    box('SV2_BedQuilt_%d'%i,(x,.70,43.35),(1.28,.11,1.33),SV2_M['green'],ship,SHIP,.06)
    box('SV2_BedPillow_%d'%i,(x,.72,42.08),(.86,.18,.48),SV2_M['silverLight'],ship,SHIP,.08)
    sv2_box_batch('SV2_BedCanopyPosts_%d'%i,[
        ((x+dx*.66,1.03,43+dz*1.14),(.10,2.05,.10),0)
        for dx in (-1,1) for dz in (-1,1)], [SV2_M['gold']],bevel=.015)
    for side in (-1,1):
        sv2_spheres('SV2_BedLamp_%d_%d'%(i,side),[((x+side*1.08,1.75,43),(.12,.18,.12))],
                    SV2_M['glassWarm'],segments=8,rings=4)

# Blank four-by-six-metre login plate faces aft (+z) toward its camera.
SV2_SIGN=anchor('SV2_LoginSign',(-8,0,-20),ship,SHIP)
SV2_SIGN['runtime_anchor_design']=[-8,0,-20]
SV2_SIGN['physical_size_metres']=[4,6]
SV2_SIGN['facing_design']=[0,0,1]
box('SV2_LoginSignBack',(0,3,0),(4,6,.42),SV2_M['silverShade'],SV2_SIGN,SHIP,.16)
box('SV2_LoginSignBlankPanel',(0,3,.24),(3.64,5.60,.12),SV2_M['silverLight'],SV2_SIGN,SHIP,.10)
sv2_box_batch('SV2_LoginSignMetalFrame',[
    ((-1.88,3,.35),(.14,5.84,.14),0),((1.88,3,.35),(.14,5.84,.14),0),
    ((0,.10,.35),(3.90,.14,.14),0),((0,5.90,.35),(3.90,.14,.14),0)],
    [SV2_M['goldLight']],parent=SV2_SIGN,bevel=.025)
sv2_spheres('SV2_LoginSignCornerStuds',[
    ((x,y,.43),(.095,.095,.095)) for x in (-1.6,1.6) for y in (.4,5.6)],
    SV2_M['greenLight'],parent=SV2_SIGN,segments=8,rings=4)
SV2_AVATAR=anchor('SV2_DeckAvatar',(0,.1,-24),ship,SHIP)
SV2_AVATAR['runtime_anchor_design']=[0,.1,-24]
SV2_AVATAR['facing_design']=[0,0,1]

# Four side-sail wheels: radial ivory panels share a grouped spoke/rim assembly.
def sv2_side_wheel(side,suffix,center_y=15.0,center_z=31.0,radius=8.7):
    center_x=side*28.2
    panel_v,panel_f=[],[]
    spoke_paths=[]
    for blade in range(8):
        a0=math.tau*blade/8+.035
        a1=math.tau*(blade+1)/8-.035
        base=len(panel_v)
        radial_steps=5
        angular_steps=4
        for radial in range(radial_steps+1):
            r=.95+(radius-.95)*radial/radial_steps
            for angular in range(angular_steps+1):
                a=a0+(a1-a0)*angular/angular_steps
                y=center_y+r*math.sin(a)
                z=center_z+r*math.cos(a)
                x=center_x+side*.10*math.sin(math.pi*r/radius)
                panel_v.append((x,y,z))
        for radial in range(radial_steps):
            for angular in range(angular_steps):
                i=base+radial*(angular_steps+1)+angular
                panel_f.append((i,i+1,i+angular_steps+2,i+angular_steps+1))
        spoke_paths.append([(center_x,center_y,center_z),
                            (center_x,center_y+radius*math.sin(a0),center_z+radius*math.cos(a0))])
    mesh_d('SV2_SideSailWheel_'+suffix+'_Canvas',panel_v,panel_f,SV2_M['canvas'],
           parent=ship,target=SHIP,smooth=True,uv=False)
    sv2_tube_batch('SV2_SideSailWheel_'+suffix+'_Spars',spoke_paths,.17,SV2_M['woodDark'])
    rim=[]
    for i in range(33):
        a=math.tau*i/32
        rim.append((center_x,center_y+radius*math.sin(a),center_z+radius*math.cos(a)))
    sv2_tube_batch('SV2_SideSailWheel_'+suffix+'_Rim',[rim],.16,SV2_M['goldLight'])
    sv2_torus_batch('SV2_SideSailWheel_'+suffix+'_HubRings',
                    [(center_x,center_y,center_z)],1.25,.23,SV2_M['gold'],axis='x')
    sv2_spheres('SV2_SideSailWheel_'+suffix+'_Hub',
                [((center_x+side*.12,center_y,center_z),(.58,.72,.72))],
                SV2_M['gemBlue'],segments=12,rings=6)
    # A short axle and struts tie the wheel to the broad silver shoulder.
    sv2_tube_batch('SV2_SideSailWheel_'+suffix+'_Axle',[
        [(side*22.0,center_y,center_z),(center_x,center_y,center_z)]],.52,SV2_M['iron'])
    sv2_tube_batch('SV2_SideSailWheel_'+suffix+'_Braces',[
        [(side*24,4,center_z),(side*25,center_y,center_z)],
        [(side*24,4,center_z),(side*28,center_y,center_z+5)],
        [(side*24,4,center_z),(side*28,center_y,center_z-5)]],.16,SV2_M['silverShade'])


sv2_side_wheel(-1,'Port')
sv2_side_wheel(1,'Starboard')

# Long-axis engine pods sit beneath the keel, clear of the cabin volume.
def sv2_axial_loft_z(name,cx,cy,sections,mats,segments=24):
    vertices,faces,face_mats=[],[],[]
    for z,rx,ry,mat_index in sections:
        for i in range(segments):
            a=math.tau*i/segments
            vertices.append((cx+rx*math.cos(a),cy+ry*math.sin(a),z))
    for row in range(len(sections)-1):
        for i in range(segments):
            j=(i+1)%segments
            faces.append((row*segments+i,row*segments+j,
                          (row+1)*segments+j,(row+1)*segments+i))
            face_mats.append(sections[row][3])
    faces.extend((tuple(reversed(range(segments))),
                  tuple(range((len(sections)-1)*segments,len(sections)*segments))))
    face_mats.extend((sections[0][3],sections[-1][3]))
    return mesh_d(name,vertices,faces,mats,face_materials=face_mats,
                  parent=ship,target=SHIP,smooth=True,uv=False)


SV2_ENGINE=sv2_axial_loft_z('SV2_KeelEngine_CentralPod',0.0,-27.0,
    [(-16,2.2,2.4,0),(-12,5.4,5.4,1),(-7,7.5,6.1,0),(0,8.0,6.2,0),
     (8,7.0,5.8,0),(14,4.8,4.5,1),(18,2.0,2.4,0)],
    [SV2_M['silver'],SV2_M['gold']],segments=32)
SV2_ENGINE['below_deck_only']=True
SV2_ENGINE_BANDS=[]
for z,rx,ry in ((-9,5.8,5.8),(0,8.0,6.25),(9,6.5,5.5)):
    band=[]
    for i in range(33):
        a=math.tau*i/32
        band.append((rx*math.cos(a),-27+ry*math.sin(a),z))
    SV2_ENGINE_BANDS.append(band)
sv2_tube_batch('SV2_KeelEngine_CircumferentialBands',SV2_ENGINE_BANDS,.20,SV2_M['goldLight'])
SV2_ENGINE_STRUTS=[]
for z in (-11,10):
    for side in (-1,1):
        SV2_ENGINE_STRUTS.append([(side*6,-16,z),(side*4.8,-21,z),(side*3.2,-23,z)])
sv2_tube_batch('SV2_KeelEngine_SupportStruts',SV2_ENGINE_STRUTS,.38,SV2_M['silverShade'])

for side,suffix in ((-1,'Port'),(1,'Starboard')):
    pod=sv2_axial_loft_z('SV2_SideEngine_'+suffix,side*28.0,-1.6,
        [(-21,1.8,1.6,1),(-17,3.5,3.4,0),(-10,4.4,3.8,0),
         (-2,4.4,3.8,0),(5,3.3,3.0,1),(9,1.0,1.0,0)],
        [SV2_M['silver'],SV2_M['gold']],segments=24)
    pod['side_engine']=True
    rings=[]
    for z,rx,ry in ((-16,3.5,3.4),(-2,4.4,3.8),(5,3.3,3.0)):
        ring=[]
        for i in range(25):
            a=math.tau*i/24
            ring.append((side*28.0+rx*math.cos(a),-1.6+ry*math.sin(a),z))
        rings.append(ring)
    sv2_tube_batch('SV2_SideEngine_'+suffix+'_Bands',rings,.12,SV2_M['goldLight'])

# Faceted amber crystal hangs from a cradle beneath the central engine.
SV2_CRYSTAL_VERTS=[(0,-32,0),(0,-50,0)]
for y,rx,rz in ((-34,3.2,2.7),(-39,2.5,2.1),(-45,1.55,1.35)):
    for i in range(8):
        a=math.tau*i/8
        SV2_CRYSTAL_VERTS.append((rx*math.cos(a),y,rz*math.sin(a)))
SV2_CRYSTAL_FACES=[]
for i in range(8):
    j=(i+1)%8
    SV2_CRYSTAL_FACES.append((0,2+i,2+j))
    for ring in range(2):
        lower=2+ring*8
        upper=lower+8
        SV2_CRYSTAL_FACES.append((lower+i,upper+i,upper+j,lower+j))
    SV2_CRYSTAL_FACES.append((18+i,1,18+j))
SV2_CRYSTAL=mesh_d('SV2_KeelAmberSuspensionCrystal',SV2_CRYSTAL_VERTS,SV2_CRYSTAL_FACES,
                   SV2_M['gemAmber'],parent=ship,target=SHIP,smooth=False,uv=False)
sv2_torus_batch('SV2_KeelCrystalSetting',[(0,-32.5,0)],3.6,.36,SV2_M['goldLight'],axis='y')
sv2_tube_batch('SV2_KeelCrystalHangers',[
    [(-4,-17,0),(-3.5,-24,0),(0,-32.3,0)],
    [(4,-17,0),(3.5,-24,0),(0,-32.3,0)],
],.21,SV2_M['gold'])

# Raised mechanical bow cowling and nozzle point toward z=-75.
SV2_BOW_COWL=sv2_axial_loft_z('SV2_BowCowl_ArmoredNose',0.0,9.0,
    [(-47,3.2,3.1,0),(-51,4.8,4.4,0),(-59,4.7,4.2,0),
     (-66,3.5,3.2,1),(-71,2.2,2.4,0),(-74.5,.75,1.0,1)],
    [SV2_M['silverLight'],SV2_M['gold']],segments=32)
for z,rx,ry in ((-52,4.5,4.25),(-63,4.0,3.7),(-70,2.4,2.6)):
    ring=[]
    for i in range(33):
        a=math.tau*i/32
        ring.append((rx*math.cos(a),9.0+ry*math.sin(a),z))
    sv2_tube_batch('SV2_BowCowl_Ring_%d'%abs(z),[ring],.22,SV2_M['goldLight'])
sv2_torus_batch('SV2_BowNozzleLip',[(0,9.0,-74.7)],1.35,.24,SV2_M['iron'],axis='z')
sv2_spheres('SV2_BowNozzleLens',[((0,9.0,-74.72),(.92,.92,.20))],
            SV2_M['gemBlue'],segments=16,rings=8)

# Main fan sail: three billowed gores radiate aft from one hinged forward point.
SV2_CREST_PATH='/Users/muniao/Code/MapleStory/resources/scenes/sky-voyage-v2/textures/maple-crest.png'
SV2_CREST_IMAGE=bpy.data.images.load(SV2_CREST_PATH,check_existing=True)
SV2_CREST_MAT=bpy.data.materials.get('SV2_M_CrestDecal') or bpy.data.materials.new('SV2_M_CrestDecal')
SV2_CREST_MAT.use_nodes=True
SV2_CREST_NODES=SV2_CREST_MAT.node_tree.nodes
SV2_CREST_LINKS=SV2_CREST_MAT.node_tree.links
SV2_CREST_NODES.clear()
SV2_CREST_TEXTURE=SV2_CREST_NODES.new('ShaderNodeTexImage')
SV2_CREST_TEXTURE.name='SV2_MapleCrest_RGBA'
SV2_CREST_TEXTURE.image=SV2_CREST_IMAGE
SV2_CREST_TEXTURE.extension='CLIP'
SV2_CREST_UV=SV2_CREST_NODES.new('ShaderNodeUVMap')
SV2_CREST_UV.uv_map='SV2_CrestUV'
SV2_CREST_SHADER=SV2_CREST_NODES.new('ShaderNodeBsdfPrincipled')
SV2_CREST_SHADER.inputs['Roughness'].default_value=.70
SV2_CREST_LINKS.new(SV2_CREST_UV.outputs['UV'],SV2_CREST_TEXTURE.inputs['Vector'])
SV2_CREST_LINKS.new(SV2_CREST_TEXTURE.outputs['Color'],SV2_CREST_SHADER.inputs['Base Color'])
SV2_CREST_LINKS.new(SV2_CREST_TEXTURE.outputs['Alpha'],SV2_CREST_SHADER.inputs['Alpha'])
SV2_CREST_OUT=SV2_CREST_NODES.new('ShaderNodeOutputMaterial')
SV2_CREST_LINKS.new(SV2_CREST_SHADER.outputs['BSDF'],SV2_CREST_OUT.inputs['Surface'])
if hasattr(SV2_CREST_MAT,'surface_render_method'):
    SV2_CREST_MAT.surface_render_method='DITHERED'
elif hasattr(SV2_CREST_MAT,'blend_method'):
    SV2_CREST_MAT.blend_method='BLEND'


def sv2_fan_gore(name,root,pivot,end_a,end_b,bulge,crest=False):
    cols,rows=18,14
    grid_size=(cols+1)*(rows+1)
    base_grid=[]
    faces=[]
    pins=set()
    for row in range(rows+1):
        v=row/rows
        for column in range(cols+1):
            u=column/cols
            outer_y=end_a[1]*(1-v)+end_b[1]*v
            outer_z=end_a[2]*(1-v)+end_b[2]*v
            x=bulge*math.sin(math.pi*u)*math.sin(math.pi*v)
            y=pivot[1]+u*(outer_y-pivot[1])
            z=pivot[2]+u*(outer_z-pivot[2])
            base_grid.append((x+pivot[0],y,z))
            if row in (0,rows) or column==0:
                pins.add(row*(cols+1)+column)
    for row in range(rows):
        for column in range(cols):
            i=row*(cols+1)+column
            faces.append((i,i+1,i+cols+2,i+cols+1))
    vertices=list(base_grid)
    face_list=list(faces)
    face_mats=[0]*len(faces)
    # The two offset image skins share the exact rest topology with the cloth.
    for side in (-1,1):
        offset=len(vertices)
        vertices.extend((x+side*.045,y,z) for x,y,z in base_grid)
        for face in faces:
            copied=tuple(offset+i for i in face)
            face_list.append(tuple(reversed(copied)) if side<0 else copied)
            face_mats.append(1 if crest else 0)
    mats=[SV2_M['canvas'],SV2_CREST_MAT] if crest else [SV2_M['canvas']]
    obj=mesh_d(name,vertices,face_list,mats,face_materials=face_mats,
               parent=root,target=SHIP,smooth=True,uv=False)
    uv_main=obj.data.uv_layers.new(name='UVMap')
    uv_crest=obj.data.uv_layers.new(name='SV2_CrestUV')
    for polygon in obj.data.polygons:
        for loop_index in polygon.loop_indices:
            vertex_index=obj.data.loops[loop_index].vertex_index
            grid_index=vertex_index//grid_size
            local=vertex_index%grid_size
            row,column=divmod(local,cols+1)
            u,v=column/cols,row/rows
            uv_main.data[loop_index].uv=(u,v)
            if grid_index==0 or not crest:
                uv_crest.data[loop_index].uv=(u,v)
            else:
                uv_crest.data[loop_index].uv=((u-.70)/.30+.5,(v-.50)/.55+.5)
    canonical_pin_indices=sorted(pins)
    pin_indices=[]
    for grid in range(3):
        pin_indices.extend(grid*grid_size+i for i in canonical_pin_indices)
    pin_indices=sorted(set(pin_indices))
    group=obj.vertex_groups.new(name=name+'_ClothPins')
    group.add(pin_indices,1.0,'REPLACE')
    cloth=obj.modifiers.new(name+'_SourceCloth','CLOTH')
    cloth.settings.quality=5
    cloth.settings.mass=.25
    cloth.settings.vertex_group_mass=group.name
    cloth.settings.pin_stiffness=1.0
    radial_a=math.dist(pivot,end_a)
    radial_b=math.dist(pivot,end_b)
    obj['cloth']=True
    obj['cloth_columns']=cols
    obj['cloth_rows']=rows
    obj['cloth_grid_vertex_count']=grid_size
    obj['cloth_grid_count']=3
    obj['cloth_canvas_vertex_start']=0
    obj['cloth_crest_front_vertex_start']=grid_size
    obj['cloth_crest_back_vertex_start']=grid_size*2
    obj['cloth_width']=(radial_a+radial_b)*.5
    obj['cloth_height']=math.dist(end_a,end_b)
    obj['cloth_pin_group']=group.name
    obj['cloth_pins']=canonical_pin_indices
    obj['cloth_pin_vertex_count']=len(canonical_pin_indices)
    obj['cloth_pin_expanded_count']=len(pin_indices)
    obj['pin_v']=1.0
    obj['uv_axes']='U: hinge-to-aft 0..1; V: neighboring fan rib 0..1'
    obj['cloth_edges']='V=0 and V=1 attached ribs; U=0 shared hinge'
    obj['crest_texture_path']=SV2_CREST_PATH if crest else ''
    obj['crest_uv_center']=[.70,.50] if crest else [0,0]
    obj['crest_uv_scale']=[.30,.55] if crest else [0,0]
    obj['export_rest_mesh']=True
    return obj


SV2_MAIN_PIVOT=(0.0,55.0,-45.0)
SV2_MAIN_RIBS=[(0.0,90.0,25.0),(0.0,72.0,25.0),
               (0.0,51.0,25.0),(0.0,30.0,25.0)]
SV2_MAIN_SAIL_ROOT=anchor('SV2_Sail_Main_Root',(0.0,0.0,0.0),ship,SHIP)
SV2_MAIN_SAIL_ROOT['cloth_pivot_design']=list(SV2_MAIN_PIVOT)
SV2_MAIN_SAIL_ROOT['fan_rib_endpoints_design']=[list(p) for p in SV2_MAIN_RIBS]
for i,(a,b) in enumerate(zip(SV2_MAIN_RIBS,SV2_MAIN_RIBS[1:]),1):
    sv2_fan_gore('SV2_Sail_Main_Gore_%02d'%i,SV2_MAIN_SAIL_ROOT,
                 SV2_MAIN_PIVOT,a,b,2.8,crest=(i==2))
SV2_MAIN_SPARS=[]
for rib in SV2_MAIN_RIBS:
    SV2_MAIN_SPARS.append([SV2_MAIN_PIVOT,rib])
sv2_tube_batch('SV2_Sail_Main_FanSpars',SV2_MAIN_SPARS,.28,SV2_M['woodDark'])
sv2_torus_batch('SV2_Sail_Main_ForwardHinge',[(0,55,-45)],2.15,.38,SV2_M['goldLight'],axis='x')
sv2_spheres('SV2_Sail_Main_HingeJewel', [((.42,55,-45),(.48,.78,.78))],
            SV2_M['gemBlue'],segments=12,rings=6)
sv2_tube_batch('SV2_Sail_Main_MastHeadStay',[
    [(0,92,-6),(0,91,6),(0,90,25)],[(0,91,-6),(0,82,-22),(0,55,-45)]],
    .12,SV2_M['goldLight'])

# The smaller aft fan uses the same deformable grid but no repeated crest art.
SV2_AFT_PIVOT=(0.0,38.0,18.0)
SV2_AFT_RIBS=[(0.0,56.0,71.0),(0.0,43.0,71.0),
              (0.0,29.0,71.0),(0.0,15.0,71.0)]
SV2_AFT_SAIL_ROOT=anchor('SV2_Sail_Aft_Root',(0.0,0.0,0.0),ship,SHIP)
SV2_AFT_SAIL_ROOT['cloth_pivot_design']=list(SV2_AFT_PIVOT)
SV2_AFT_SAIL_ROOT['fan_rib_endpoints_design']=[list(p) for p in SV2_AFT_RIBS]
for i,(a,b) in enumerate(zip(SV2_AFT_RIBS,SV2_AFT_RIBS[1:]),1):
    sv2_fan_gore('SV2_Sail_Aft_Gore_%02d'%i,SV2_AFT_SAIL_ROOT,
                 SV2_AFT_PIVOT,a,b,1.8,crest=False)
sv2_tube_batch('SV2_Sail_Aft_FanSpars',[[SV2_AFT_PIVOT,p] for p in SV2_AFT_RIBS],
               .20,SV2_M['woodDark'])
sv2_torus_batch('SV2_Sail_Aft_Hinge',[(0,38,18)],1.55,.28,SV2_M['gold'],axis='x')

# Main mast and smaller stern mast preserve the illustrated rising silhouette.
cylinder('SV2_MainMast',(0,46,-6),.86,92,SV2_M['woodDark'],ship,SHIP,24,top_radius=.38)
for i,y in enumerate((12,34,56,78,90),1):
    cylinder('SV2_MainMastCollar_%02d'%i,(0,y,-6),1.20,.30,SV2_M['gold'],ship,SHIP,24)
cylinder('SV2_MainMastCrown',(0,93.0,-6),2.15,2.0,SV2_M['iron'],ship,SHIP,24,top_radius=1.55)
sv2_tube_batch('SV2_MainMastShrouds',[
    [(0,91,-6),(-26,7,-2)],[(0,91,-6),(26,7,-2)],
    [(0,62,-6),(-28,0,-24)],[(0,62,-6),(28,0,-24)]],.095,SV2_M['rope'])
cylinder('SV2_AftMast',(0,31.5,18),.48,49,SV2_M['woodDark'],ship,SHIP,20,top_radius=.22)
for i,y in enumerate((16,31,46,55),1):
    cylinder('SV2_AftMastCollar_%02d'%i,(0,y,18),.72,.24,SV2_M['gold'],ship,SHIP,20)

# Human-scale lantern clusters and cargo sit away from the bed and window anchors.
SV2_LANTERN_SUPPORTS=[]
SV2_LANTERN_GLOBES=[]
for z in (-57,-40,-22,2,24,55):
    width=max(4.0,sv2_halfwidth_at_y(float(z),0.0)-3.0)
    for side in (-1,1):
        x=side*width
        SV2_LANTERN_SUPPORTS.append(((x,1.25,float(z)),(.16,2.5,.16),0))
        SV2_LANTERN_GLOBES.append(((x,2.75,float(z)),(.30,.32,.30)))
sv2_box_batch('SV2_MainDeckLanternStanchions',SV2_LANTERN_SUPPORTS,[SV2_M['gold']],bevel=.025)
sv2_spheres('SV2_MainDeckWarmLanterns',SV2_LANTERN_GLOBES,SV2_M['glassWarm'],segments=8,rings=4)

SV2_CARGO=[]
for x,y,z,sx,sy,sz in ((-20,.70,-58,2.8,1.4,2.2),(19,.76,-52,2.8,1.5,2.4),
                        (-22,-4.2,-45,3.0,1.5,2.3),(22,-4.2,-38,3.1,1.5,2.3),
                        (-22,.7,54,2.8,1.4,2.1),(22,.7,55,2.6,1.4,2.0)):
    SV2_CARGO.append(((x,y,z),(sx,sy,sz),0))
sv2_box_batch('SV2_OrbisDeckCargoCrates',SV2_CARGO,[SV2_M['woodLight']],bevel=.10)
SV2_BARRELS=[]
for x,z in ((-17,57),(17,57),(-22,47),(22,47)):
    SV2_BARRELS.append(((x,.74,z),(1.2,1.45,1.2)))
sv2_spheres('SV2_OrbisDeckCargoBales',
            [((x,y+.12,z),(sx,sy,sz)) for (x,y,z),(sx,sy,sz) in SV2_BARRELS],
            SV2_M['wood'],segments=10,rings=6)

# Contract checks keep UI-facing names and bed/window positions stable.
SV2_EXPECTED_BEDS={
    'SV2_Bed_0':(-5.4,0.0,43.0),'SV2_Bed_1':(-1.8,0.0,43.0),
    'SV2_Bed_2':(1.8,0.0,43.0),'SV2_Bed_3':(5.4,0.0,43.0),
}
for name,position in SV2_EXPECTED_BEDS.items():
    obj=bpy.data.objects.get(name)
    assert obj is not None and obj.parent==ship
    assert all(abs(float(obj['runtime_anchor_design'][i])-position[i])<1e-4 for i in range(3))
    assert bpy.data.objects.get(name+'_SleepAnchor') is not None
    assert bpy.data.objects.get(name+'_FootAnchor') is not None
for i,x in enumerate(SV2_WINDOW_X,1):
    obj=bpy.data.objects.get('SV2_CabinFrontWindow_%02d'%i)
    assert obj is not None and obj.parent==ship
    assert all(abs(float(obj['runtime_anchor_design'][j])-target)<1e-4
               for j,target in enumerate((x,3.75,31.78)))
assert bpy.data.objects.get('SV2_CabinRoof') is SV2_ROOF
assert bpy.data.objects.get('SV2_CabinBackWall') is SV2_BACK_WALL
assert bpy.data.objects.get('SV2_CabinBackTrim') is SV2_BACK_TRIM
assert tuple(round(float(v),3) for v in SV2_SIGN['runtime_anchor_design'])==(-8.0,0.0,-20.0)
assert tuple(round(float(v),3) for v in SV2_AVATAR['runtime_anchor_design'])==(0.0,.1,-24.0)
assert SV2_STATIONS[0][0]==-75.0 and SV2_STATIONS[-1][0]==75.0
assert max(station[1] for station in SV2_STATIONS)<=35.0
assert len(SV2_MAIN_SAIL_ROOT['fan_rib_endpoints_design'])==4
print('SV2_REFERENCE_LED_SHIP_OK','hull=150x70m','decks=-5/0/7',
      'aft_galleries=3','main_fan_gores=3','cloth=18x14','beds=4','windows=4')
