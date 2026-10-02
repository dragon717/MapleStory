"""Live Blender script. Host injects LAYOUT from sky-city-spatial-layout.json.
Owns only SC_SpatialPrototype and SC_ data; keeps all approved ship scenes.
This is editable massing/circulation geometry, not authoritative game navigation.
"""
import bpy
import math
import json
from mathutils import Vector, noise

NAME = 'SC_SpatialPrototype'
DEST = '/Users/muniao/Code/MapleStory/resources/scenes/sky-voyage-v3/prototypes/'
engine = bpy.context.scene.render.engine
old = bpy.data.scenes.get(NAME)
if old:
    assert all(o.name.startswith('SC_') for o in old.objects)
    for obj in list(old.objects): bpy.data.objects.remove(obj, do_unlink=True)
    bpy.data.scenes.remove(old)
scene = bpy.data.scenes.new(NAME)
bpy.context.window.scene = scene
scene['spatial_layout'] = json.dumps(LAYOUT, ensure_ascii=False)
scene['stage'] = 'editable massing and circulation; not game navigation'


def material(name, color):
    mat = bpy.data.materials.get('SC_'+name)
    if mat is None: mat = bpy.data.materials.new('SC_'+name)
    mat.use_nodes = True
    shader = next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    shader.inputs['Base Color'].default_value = (*color,1)
    shader.inputs['Roughness'].default_value = .78
    mat.diffuse_color = (*color,1)
    return mat


def color(hexcode):
    return tuple(int(hexcode[i:i+2],16)/255 for i in (1,3,5))


def native(p): return (p[0],-p[2],p[1])


def box(name, p, size, mat, parent=None):
    if name.endswith('_Floor'):
        p=list(p); p[2 if parent else 1]+=.02  # Avoid coplanar room floors and arrival pads.
    bpy.ops.mesh.primitive_cube_add(size=1, location=native(p) if parent is None else p)
    obj=bpy.context.object; obj.name='SC_'+name
    obj.dimensions=(size[0],size[2],size[1]) if parent is None else size
    obj.data.materials.append(mat)
    if parent: obj.parent=parent
    return obj


def slab(name, a, b, width, mat, base_height=None):
    # ponytail: 1.5cm visual lift avoids coplanar pad seams; merge faces when producing collision meshes.
    if abs(a[1]-b[1])<.000001:
        a=list(a); b=list(b); a[1]+=.015; b[1]+=.015
    dx,dz=b[0]-a[0],b[2]-a[2]; run=math.hypot(dx,dz)
    assert run>0
    perp=(dz/run*width/2,-dx/run*width/2)
    points=[[a[0]-perp[0],a[1],a[2]-perp[1]], [a[0]+perp[0],a[1],a[2]+perp[1]],
            [b[0]+perp[0],b[1],b[2]+perp[1]], [b[0]-perp[0],b[1],b[2]-perp[1]]]
    verts=[native(p) for p in points]+[native([p[0],p[1]-.8 if base_height is None else base_height,p[2]]) for p in points]
    mesh=bpy.data.meshes.new('SC_'+name)
    mesh.from_pydata(verts,[],[(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)])
    mesh.update()
    obj=bpy.data.objects.new('SC_'+name,mesh); scene.collection.objects.link(obj); mesh.materials.append(mat)
    obj['walk_surface']='upper only'; obj['underside_walkable']=False
    return obj


def pad(name,p,radius,mat):
    bpy.ops.mesh.primitive_cylinder_add(vertices=32,radius=radius,depth=.8,location=native([p[0],p[1]-.4,p[2]]))
    obj=bpy.context.object; obj.name='SC_'+name; obj.data.materials.append(mat)
    return obj


def ring(name,center,inner,outer,height,mat):
    verts=[]; faces=[]; count=64
    for i in range(count):
        theta=2*math.pi*i/count
        for r in (inner,outer): verts.append(native([center[0]+r*math.cos(theta),height,center[2]+r*math.sin(theta)]))
    for i in range(count):
        j=(i+1)%count; faces.append((2*i,2*j,2*j+1,2*i+1))
    mesh=bpy.data.meshes.new('SC_'+name); mesh.from_pydata(verts,[],faces); mesh.update()
    obj=bpy.data.objects.new('SC_'+name,mesh); scene.collection.objects.link(obj); mesh.materials.append(mat)
    return obj


neutral=material('Ivory',(0.79,.82,.85)); wall=material('Wall',(.68,.73,.8))
roof=material('Azure',(.27,.47,.69)); accent=material('Gold',(.72,.58,.3))
rock=material('FloatingStone',(.42,.52,.59)); green=material('GardenLeaves',(.23,.48,.31))
wood=material('CraftWood',(.36,.21,.11)); glass=material('AlchemyGlass',(.18,.65,.61))
rainbow=[]
for i,c in enumerate([(.75,.22,.3),(.95,.48,.2),(.94,.78,.3),(.25,.7,.5),(.23,.65,.88),(.35,.4,.82),(.62,.35,.78)]):
    mat=material('Rainbow_'+str(i),c)
    shader=next(n for n in mat.node_tree.nodes if n.type=='BSDF_PRINCIPLED')
    shader.inputs['Roughness'].default_value=.2
    shader.inputs['Metallic'].default_value=.35
    if shader.inputs.get('Emission Color'): shader.inputs['Emission Color'].default_value=(*c,1)
    if shader.inputs.get('Emission Strength'): shader.inputs['Emission Strength'].default_value=.65
    rainbow.append(mat)
flowers={key:material('Flowers_'+key,c) for key,c in [('red',(.72,.16,.19)),('yellow',(.94,.68,.17)),('blue',(.19,.45,.85))]}
zones={b['id']:material('Zone_'+b['id'],color(b['color'])) for b in LAYOUT['blocks']}
route_mats={r['id']:material('Route_'+r['id'],color(r['color'])) for r in LAYOUT['routes']}
nodes={n['id']:n for n in LAYOUT['nodes']}
radii={l['node']:l['radius'] for l in LAYOUT['landings']}
for landing in LAYOUT['landings']:
    n=nodes[landing['node']]
    obj=pad(n['id']+'_Landing',n['position'],landing['radius'],neutral if landing['radius']>=12 else zones[n['zone']])
    obj['node_id']=n['id']; obj['zone']=n['zone']; obj['flat_landing']=True

def road_object(e,verts,faces):
    mesh=bpy.data.meshes.new('SC_'+e['id']); mesh.from_pydata(verts,[],faces); mesh.update()
    obj=bpy.data.objects.new('SC_'+e['id'],mesh); scene.collection.objects.link(obj)
    mesh.materials.append(wood if e.get('surface')=='suspension' else neutral)
    obj['edge_id']=e['id']; obj['kind']=e['kind']; obj['surface']=e.get('surface','terrace'); obj['path_centerline']=json.dumps(e['points'])
    obj['walk_surface']='upper tread/road surface only'; obj['underside_walkable']=False
    obj['carrier']=e['carrier']
    if e.get('surface')=='floating-stairs': obj['collision_role']='floating treads carried by fragment islands; no unplanned lower access'
    elif e['kind']=='stairs': obj['collision_role']='closed under-stair backing; no pass-through'
    return obj

def road_mesh(e):
    points=[list(p) for p in e['points']]
    if e['kind']=='stairs':
        start=points[0][1]; rise=points[-1][1]-start
        count=math.ceil(abs(rise)/LAYOUT['roadRules']['maxStepHeight']); step=rise/count
        stepped=[points[0]]
        for a,b in zip(points,points[1:]):
            if abs(b[1]-a[1])<.000001:
                stepped.append(list(b)); continue
            cuts=[0,1]
            for i in range(1,count):
                t=(start+i*step-a[1])/(b[1]-a[1])
                if .000001<t<.999999: cuts.append(t)
            cuts.sort()
            for t0,t1 in zip(cuts,cuts[1:]):
                left=[a[k]+(b[k]-a[k])*t0 for k in range(3)]
                right=[a[k]+(b[k]-a[k])*t1 for k in range(3)]
                progress=((left[1]+right[1])/2-start)/step
                top=start+(math.ceil(progress-.000001) if step>0 else math.floor(progress+.000001))*step
                left[1]=top; right[1]=top
                stepped.extend([left,right])
        stepped[-1]=list(points[-1]); points=stepped
    if e.get('surface')=='floating-stairs':
        verts=[]; faces=[]
        for a,b in zip(points,points[1:]):
            dx,dz=b[0]-a[0],b[2]-a[2]; run=math.hypot(dx,dz)
            if run<.000001 or abs(b[1]-a[1])>.001: continue
            perp=(dz/run*e['width']/2,-dx/run*e['width']/2); gap=min(.015,run*.025)
            left=[a[0]+dx/run*gap,a[1]+.015,a[2]+dz/run*gap]; right=[b[0]-dx/run*gap,b[1]+.015,b[2]-dz/run*gap]
            corners=[[p[0]+sign*perp[0],p[1],p[2]+sign*perp[1]] for p,sign in [(left,-1),(left,1),(right,1),(right,-1)]]
            offset=len(verts); verts.extend([native(p) for p in corners]); verts.extend([native([p[0],p[1]-1.4,p[2]]) for p in corners])
            faces.extend([tuple(offset+i for i in f) for f in [(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]])
        return road_object(e,verts,faces)
    # Continuous mitered strip: turns and risers share vertices, so road bends have no wedge gaps.
    verts=[]; bottom=[]
    for i,p in enumerate(points):
        previous=p; following=p
        for j in range(i-1,-1,-1):
            if math.hypot(points[j][0]-p[0],points[j][2]-p[2])>.00001: previous=points[j]; break
        for j in range(i+1,len(points)):
            if math.hypot(points[j][0]-p[0],points[j][2]-p[2])>.00001: following=points[j]; break
        dx,dz=following[0]-previous[0],following[2]-previous[2]; length=math.hypot(dx,dz)
        assert length>0
        normal=[dz/length,-dx/length]; miter=1
        if following is not p:
            dx2,dz2=following[0]-p[0],following[2]-p[2]; length2=math.hypot(dx2,dz2)
            miter=1/max(.5,abs(normal[0]*dz2/length2-normal[1]*dx2/length2))
        lift=.015
        for sign in (-1,1):
            v=[p[0]+sign*normal[0]*e['width']/2*miter,p[1]+lift,p[2]+sign*normal[1]*e['width']/2*miter]
            verts.append(native(v)); v[1]=min(x[1] for x in points)-.8 if e['kind']=='stairs' else p[1]-1.35; bottom.append(native(v))
    count=len(verts); verts.extend(bottom); faces=[]
    if e.get('surface')=='rainbow':
        stripes=[]; stripe_faces=[]
        for i in range(len(points)):
            left=Vector(verts[2*i]); right=Vector(verts[2*i+1])
            for j in range(8): stripes.append(left.lerp(right,j/7))
        for i in range(len(points)-1):
            for j in range(7): stripe_faces.append((i*8+j,(i+1)*8+j,(i+1)*8+j+1,i*8+j+1))
        # A deep crystalline deck is the carrier, with a coloured walking crown.
        obj=road_object(e,verts,[])
        mesh=obj.data; mesh.clear_geometry()
        offset=len(verts)
        side_faces=[]
        for i in range(len(points)-1):
            a=2*i; b=a+2
            side_faces.extend([(a+count,a+1+count,b+1+count,b+count),(a,a+count,b+count,b),(a+1,b+1,b+1+count,a+1+count)])
        mesh.from_pydata(verts+stripes,[],side_faces+[tuple(offset+j for j in f) for f in stripe_faces]); mesh.update()
        for mat in rainbow: mesh.materials.append(mat)
        for i,poly in enumerate(mesh.polygons): poly.material_index=0 if i<len(side_faces) else 1+(i-len(side_faces))%7
        obj['rainbow_bridge']=True
        return obj
    for i in range(len(points)-1):
        a=2*i; b=a+2
        faces.extend([(a,b,b+1,a+1),(a+count,a+1+count,b+1+count,b+count),
            (a,a+count,b+count,b),(a+1,b+1,b+1+count,a+1+count)])
    faces.extend([(0,1,1+count,count),(count-2,2*count-2,2*count-1,count-1)])
    return road_object(e,verts,faces)


for e in LAYOUT['edges']: road_mesh(e)

# Real three-level cloister and 27 individually editable room shells.
for floor in range(3):
    ring('F_Cloister_%d'%floor,[160,0,-300],45,53,94+14*floor,neutral)
    slab('F_FlatLanding_%d'%floor,[195,94+14*floor,-300],[213,94+14*floor,-300],6,neutral)
for room in LAYOUT['rooms']:
    p=room['center']; theta=math.atan2(p[2]+300,p[0]-160)
    root=bpy.data.objects.new('SC_'+room['id'],None); scene.collection.objects.link(root)
    root.location=native(p); root.rotation_euler.z=-theta-math.pi/2
    root['map_id']=room['mapId']; root['room_label']=room['label']; root['door_id']=room['door']
    box(room['id']+'_Floor',(0,0,-.4),(18,18,.8),neutral,root)
    box(room['id']+'_Back',(0,9,4),(18,.6,8),wall,root)
    box(room['id']+'_Left',(-9,0,4),(.6,18,8),wall,root)
    box(room['id']+'_Right',(9,0,4),(.6,18,8),wall,root)
    for x in (-5.75,5.75): box(room['id']+'_DoorJamb',(x,-9,4),(6.5,.6,8),wall,root)
    box(room['id']+'_Lintel',(0,-9,6),(5,.6,4),wall,root)
pad('F_Hall',[160,94,-300],35,neutral)
pad('F_UpperHall',[160,122,-300],35,neutral)

# Original twenty floors plus two basement levels, with an internal spiral and landings.
tower=LAYOUT['tower']; centre=tower['center']
for i,level in enumerate(tower['levels']):
    height=centre[1]-i*tower['floorHeight']
    floor=ring('G_Floor_%s'%level,centre,12,tower['radius'],height,zones['G'])
    floor['original_floor']=level
    slab('G_FlatLanding_%s'%level,[centre[0]+8,height,centre[2]],[centre[0]+16,height,centre[2]],3,zones['G'])
for theta in (math.pi/4,3*math.pi/4,5*math.pi/4,7*math.pi/4):
    box('G_Column',[centre[0]+15*math.cos(theta),-62,centre[2]+15*math.sin(theta)],[1,150,1],wall)
for room in LAYOUT['sideRooms']:
    x,y,z=room['center']; sx,sy,sz=room['size']
    obj=box(room['id']+'_Floor',[x,y-.4,z],[sx,.8,sz],neutral); obj['original_map_id']=room['mapId']
    box(room['id']+'_Back',[x+sx/2,y+sy/2,z],[.6,sy,sz],wall)
    for side in (-1,1): box(room['id']+'_Side',[x,y+sy/2,z+side*sz/2],[sx,sy,.6],wall)

# Five distinct craft/read houses are P content, with door openings rather than sealed boxes.
for i,label in enumerate(LAYOUT['crafts']):
    x=-360+(i%3)*48; z=65+(i//3)*58
    box('B_Craft_%d_Floor'%i,[x,23.6,z],[32,.8,32],neutral)
    box('B_Craft_%d_Back'%i,[x,30,z-16],[32,12,1],wall)
    box('B_Craft_%d_Side'%i,[x-16,30,z],[1,12,32],wall)
    obj=box('B_Craft_%d_Roof'%i,[x,37,z],[34,1,34],roof); obj['content']=label

# Region studies: road-aligned terraces, small editable architecture, and CC0 gate/roof modules.
def column(name,p,radius,height,mat):
    bpy.ops.mesh.primitive_cylinder_add(vertices=12,radius=radius,depth=height,location=native([p[0],p[1]+height/2,p[2]]))
    obj=bpy.context.object; obj.name='SC_'+name; obj.data.materials.append(mat); return obj


def foundation(name,p,radius,depth):
    verts=[]; faces=[]; count=12
    for level in range(3):
        for i in range(count):
            theta=2*math.pi*i/count; r=radius*(.98,.72,.25)[level]*(1+.025*math.sin(i*4.3))
            verts.append(native([p[0]+r*math.cos(theta),p[1]-.8-depth*(0,.55,1)[level],p[2]+r*math.sin(theta)]))
    for level in range(2):
        for i in range(count):
            j=(i+1)%count; faces.append((level*count+i,level*count+j,(level+1)*count+j,(level+1)*count+i))
    faces.append(tuple(range(2*count,3*count)))
    mesh=bpy.data.meshes.new('SC_'+name); mesh.from_pydata(verts,[],faces); mesh.update()
    obj=bpy.data.objects.new('SC_'+name,mesh); scene.collection.objects.link(obj); mesh.materials.append(rock); return obj


def clear_of_roads(p,radius,height):
    for e in LAYOUT['edges']:
        for a,b in zip(e['points'],e['points'][1:]):
            if max(a[1],b[1])<p[1]-1 or min(a[1],b[1])>p[1]+height+3.2: continue
            dx,dz=b[0]-a[0],b[2]-a[2]; length2=dx*dx+dz*dz
            if length2<.000001: continue
            t=max(0,min(1,((p[0]-a[0])*dx+(p[2]-a[2])*dz)/length2))
            if math.hypot(p[0]-a[0]-t*dx,p[2]-a[2]-t*dz)<radius+e['width']/2+1: return False
    return True


templates={}
def asset(module,name,p,scale,angle,mat):
    if module not in templates:
        before=set(scene.objects)
        bpy.ops.import_scene.gltf(filepath='/Users/muniao/Code/MapleStory/resources/scenes/sky-voyage-v2/vendor/castle/modules/'+module+'.glb')
        imported=[o for o in scene.objects if o not in before]; meshes=[o for o in imported if o.type=='MESH']; assert len(meshes)==1
        obj=meshes[0]
        for o in scene.objects: o.select_set(False)
        obj.select_set(True); bpy.context.view_layer.objects.active=obj
        bpy.ops.object.transform_apply(location=False,rotation=True,scale=True)
        obj.name='SC_Template_'+module; obj.data.materials.clear(); obj.data.materials.append(mat)
        obj.hide_render=True; obj.hide_set(True); templates[module]=obj
        for other in imported:
            if other!=obj: other.name='SC_Template_'+module+'_Root'
    template=templates[module]; obj=template.copy(); scene.collection.objects.link(obj)
    obj.name='SC_'+name; obj.hide_render=False; obj.hide_set(False); obj.location=native(p); obj.scale=scale; obj.rotation_euler.z=angle
    obj['asset_license']='CC0 1.0'; obj['asset_source']='Kenney Castle Kit'; obj['asset_module']=module
    return obj


def house(name,p,size,mat=roof):
    x,y,z=p; sx,sy,sz=size
    box(name+'_Floor',[x,y-.4,z],[sx,.8,sz],neutral)
    box(name+'_Back',[x,y+sy/2,z-sz/2],[sx,sy,.6],wall)
    for side in (-1,1): box(name+('_SideWest' if side<0 else '_SideEast'),[x+side*sx/2,y+sy/2,z],[.6,sy,sz],wall)
    # Two roof pitches; the open front is an intentional modelling cutaway.
    slab(name+'_RoofL',[x-sx/2-1,y+sy,z],[x,y+sy+4,z],sz+2,mat)
    slab(name+'_RoofR',[x,y+sy+4,z],[x+sx/2+1,y+sy,z],sz+2,mat)


for n in LAYOUT['nodes']:
    r=radii[n['id']]
    if n.get('gate') or n.get('interior') or n['id'] in ('P12','P13','P14','P22','P23','P25'): continue
    p=n['position']; depth=min(14,r*.55)
    # Avoid filling an already planned lower passage with the underside of a terrace.
    for other in LAYOUT['nodes']:
        if other['id']==n['id'] or other['position'][1]>=p[1]-.1: continue
        if math.hypot(p[0]-other['position'][0],p[2]-other['position'][2])<r+radii[other['id']]:
            depth=min(depth,max(0,p[1]-other['position'][1]-4))
    if r<12 or n['zone'] in ('A','B','F','G','H'): continue
    for i in range(10):
        theta=2*math.pi*i/10; q=[p[0]+r*.78*math.cos(theta),p[1],p[2]+r*.78*math.sin(theta)]
        if not clear_of_roads(q,1.8,7): continue
        column(n['zone']+'_'+n['id']+'_Plinth',q,1.3,.6,neutral)
        column(n['zone']+'_'+n['id']+'_Column',[q[0],q[1]+.6,q[2]],.6,6,neutral)
        column(n['zone']+'_'+n['id']+'_Capital',[q[0],q[1]+6.6,q[2]],.95,.5,accent)
    for i in range(8):
        theta=2*math.pi*(i+.5)/8; q=[p[0]+r*.61*math.cos(theta),p[1],p[2]+r*.61*math.sin(theta)]
        if not clear_of_roads(q,2.1,2.2): continue
        column(n['zone']+'_'+n['id']+'_Planter',q,2,.7,neutral)
        column(n['zone']+'_'+n['id']+'_Leaves',[q[0],q[1]+.7,q[2]],1.8,1.1,green)
        if n['id'] in ('P06','P07','P08','P09','P10','P11'):
            key='red' if n['id'] in ('P06','P07') else 'yellow' if n['id'] in ('P08','P09') else 'blue'
            column('C_'+n['id']+'_Flowers',[q[0],q[1]+1.8,q[2]],1.3,.25,flowers[key])

house('A_Ticket',[-171,0,310],[8,6,8]); house('A_Waiting',[-228,0,295],[8,7,10])
gate=asset('wall-doorway','A_CityGate',[-150,12,258],(2,30,7),math.pi/2,neutral)
gate['net_opening_width']=10.8; gate['net_opening_height']=4.97
for i in range(5):
    x=-360+(i%3)*48; z=65+(i//3)*58
    foundation('B_Craft_%d_Base'%i,[x,23.6,z],20,6)
    oldroof=bpy.data.objects.get('SC_B_Craft_%d_Roof'%i)
    if oldroof: bpy.data.objects.remove(oldroof,do_unlink=True)
    slab('B_Craft_%d_RoofL'%i,[x-17,36.5,z],[x,42,z],34,roof)
    slab('B_Craft_%d_RoofR'%i,[x,42,z],[x+17,36.5,z],34,roof)
    box('B_Craft_%d_Table'%i,[x+5,25.5,z],[9,.4,5],wood)
    for side in (-1,1): box('B_Craft_%d_TableLeg'%i,[x+5+side*3,24.7,z],[.6,1.4,3],wood)
    if i==0:
        for row in range(3):
            box('B_LibraryShelf',[x,25+row*2.4,z-13],[25,.4,2],wood)
            for j in range(12): box('B_Book',[x-11+j*1.9,25.9+row*2.4,z-13],[1.2,1.4,1.3],flowers['blue' if j%2 else 'yellow'])
    elif i==1:
        column('B_Forge',[x+8,24,z-9],2,3,wall); column('B_Embers',[x+8,27,z-9],1.4,.2,flowers['red'])
        box('B_Anvil',[x+5,26,z],[4,.7,1.7],rock)
    elif i==2:
        for side in (-1,1): box('B_LoomPost',[x+side*3,27,z-5],[.5,6,.5],wood)
        for height in (25,29): box('B_LoomBeam',[x,height,z-5],[6.5,.5,.6],wood)
        for j in range(12): box('B_LoomThread',[x-2.6+j*.47,27,z-5],[.12,3.6,.12],flowers['yellow'])
    elif i==3:
        for j in range(6): box('B_Timber',[x-8,24.5+j*.5,z-7],[8,.4,1.2],wood)
        box('B_CarpentryBench',[x+4,26,z],[10,.5,4],wood)
    else:
        for j in range(4):
            column('B_Flask',[x+2+j*1.7,25.7,z],.6,1.1,glass)
            column('B_FlaskNeck',[x+2+j*1.7,26.8,z],.23,.7,glass)
house('B_HeroTemple',[-350,38,-88],[20,10,14])
for side in (-1,1): column('B_HeroPortico',[-350+side*7,38,-80],.7,9,neutral)
for nid in ('D03','D04','E01'):
    n=nodes[nid]; x,y,z=n['position']
    if nid=='D04': house('D_OldHouse',[x+7,y,z-5],[8,7,8])
    else:
        for i in range(3):
            p=[x+7+i*2,y,z-7]
            if clear_of_roads(p,1,5): column(n['zone']+'_BrokenColumn',p,.7,2+i,wall)
pad('F_PalaceBase',[160,94,-300],80,neutral); foundation('F_PalaceFoundation',[160,94,-300],80,18)
house('F_CentralHall',[160,122,-300],[24,13,24])
# The arrival path approaches the hall from +X; its east side has a real ten-metre doorway.
east=bpy.data.objects.get('SC_F_CentralHall_SideEast')
if east: bpy.data.objects.remove(east,do_unlink=True)
for side in (-1,1): box('F_EastDoorJamb',[172,128.5,-300+side*8.5],[.6,13,7],wall)
box('F_EastDoorLintel',[172,132.5,-300],[.6,5,10],wall)
column('F_CrownTower',[160,122,-335],6,25,neutral)
asset('tower-hexagon-roof','F_CrownRoof',[160,147,-335],(18,18,18),0,roof)
for x,z in [(145,-315),(175,-315),(145,-285),(175,-285)]:
    column('F_HallTurret',[x,122,z],3,16,neutral)
    asset('tower-hexagon-roof','F_HallTurretRoof',[x,138,z],(10,10,10),0,roof)
house('H_Headquarters',[520,72,-451],[22,12,18]); foundation('H_HeadquartersFoundation',[520,72,-451],16,8)
for x,z in [(490,-400),(505,-350),(550,-405)]:
    assert clear_of_roads([x,72,z],9,8)
    house('H_VillageHouse',[x,72,z],[12,8,12])
pad('H_TowerFoot',[538,99,-485],5,neutral); foundation('H_TowerFootFoundation',[538,99,-485],5,8)
column('H_Tower',[538,99,-485],4,20,neutral)
asset('tower-hexagon-roof','H_TowerRoof',[538,119,-485],(13,13,13),0,roof)

# Broad landscape blocks sit below the road surfaces. Plant roots and cliffs use the same height field.
grass=material('Meadow',(.18,.34,.23)); darkgrass=material('OldGarden',(.21,.28,.25))
water=material('Water',(.10,.43,.55))
land_roads=LAYOUT['edges']
building_floors=[]
for obj in scene.objects:
    if obj.type=='MESH' and obj.name.endswith('_Floor'):
        bounds=[obj.matrix_world@Vector(c) for c in obj.bound_box]
        building_floors.append((min(c[0] for c in bounds)-2,max(c[0] for c in bounds)+2,
            min(-c[1] for c in bounds)-2,max(-c[1] for c in bounds)+2,max(c[2] for c in bounds)))

def nearby_segments(spec):
    x,y,z=spec['center']; rx,rz=spec['radii']; result=[]
    for e in land_roads:
        if e['interior'] and nodes[e['start']]['zone']=='G': continue
        for a,b in zip(e['points'],e['points'][1:]):
            if max(a[0],b[0])<x-rx-30 or min(a[0],b[0])>x+rx+30 or max(a[2],b[2])<z-rz-30 or min(a[2],b[2])>z+rz+30: continue
            result.append((a,b,e['width']/2))
    return result

def distance_to_segment(x,z,a,b):
    dx,dz=b[0]-a[0],b[2]-a[2]; length=dx*dx+dz*dz
    t=max(0,min(1,((x-a[0])*dx+(z-a[2])*dz)/length)) if length>.000001 else 0
    return math.hypot(x-a[0]-t*dx,z-a[2]-t*dz),a[1]+t*(b[1]-a[1])

def ground_height(spec,x,z,segments):
    cx,base,cz=spec['center']; rx,rz=spec['radii']; rho=min(1,math.hypot((x-cx)/rx,(z-cz)/rz))
    h=base-.9+(0 if spec['biome'] in ('town','sanctuary') else (1-rho)*(3+3*math.sin(x*.045+z*.032)**2))
    for a,b,halfwidth in segments:
        d,y=distance_to_segment(x,z,a,b)
        if base-12<=y<=base+40: h=min(h,y-.9+max(0,d-halfwidth-20)*.4)
    for left,right,back,front,y in building_floors:
        if left<=x<=right and back<=z<=front and base-12<=y<=base+12: h=min(h,y-.9)
    return h

def underside_height(spec,x,z,top,segments):
    cx,base,cz=spec['center']; rx,rz=spec['radii']; rho=min(1,math.hypot((x-cx)/rx,(z-cz)/rz))
    rough=noise.fractal(Vector((x*.035,z*.035,base*.028)),.9,2.0,4)
    bottom=base-.9-spec['depth']*(1-.62*rho)+rough*spec['depth']*.18
    for a,b,halfwidth in segments:
        d,y=distance_to_segment(x,z,a,b)
        if y<top-4.8 and d<halfwidth+22: bottom=max(bottom,y+4.8)
    return min(top-.4,bottom)

terrain_objects=[]
apron=ring('G_EntranceCarrier',LAYOUT['tower']['center'],12,32,11.1,rock)
apron['island_binding']='A03'; apron['zone']='G'; apron['carrier']='tower entrance foundation with an open central shaft'
terrain_objects.append(apron)
for spec in LAYOUT['landscape']['islands']:
    cx,base,cz=spec['center']; rx,rz=spec['radii']; count=72; rings=8; segments=nearby_segments(spec)
    verts=[native([cx,ground_height(spec,cx,cz,segments),cz])]; faces=[]
    for j in range(1,rings+1):
        for i in range(count):
            theta=2*math.pi*i/count; r=j/rings*(1+.045*math.sin(theta*5+.7)+.025*math.sin(theta*9))
            x=cx+rx*r*math.cos(theta); z=cz+rz*r*math.sin(theta)
            verts.append(native([x,ground_height(spec,x,z,segments),z]))
    for i in range(count): faces.append((0,1+(i+1)%count,1+i))
    for j in range(rings-1):
        for i in range(count):
            a=1+j*count+i; b=1+j*count+(i+1)%count; c=a+count; d=b+count
            faces.extend([(a,b,d),(a,d,c)])
    # Lower routes cut a canyon through the land block. The tower shaft stays open.
    top_faces=[]; tower_centre=LAYOUT['tower']['center']
    for face in faces:
        x=sum(verts[i][0] for i in face)/3; z=-sum(verts[i][1] for i in face)/3; blocked=False
        if base>=tower_centre[1]-3 and any(math.hypot(verts[i][0]-tower_centre[0],-verts[i][1]-tower_centre[2])<25 for i in face): continue
        for a,b,halfwidth in segments:
            d,y=distance_to_segment(x,z,a,b)
            if y<base-12 and d<halfwidth+18: blocked=True; break
        if not blocked: top_faces.append(face)
    faces=top_faces; top_count=len(faces); vcount=len(verts); boundary={}
    for f in faces:
        for a,b in zip(f,(f[1],f[2],f[0])):
            key=(min(a,b),max(a,b))
            if key in boundary: boundary[key]=None
            else: boundary[key]=(a,b)
    fixed_bottom=set()
    for edge in boundary.values():
        if edge is not None and min(edge)<1+(rings-1)*count: fixed_bottom.update(edge)
    for i,p in enumerate(list(verts)):
        x,z=p[0],-p[1]
        if i not in fixed_bottom:
            rho=min(1,math.hypot((x-cx)/rx,(z-cz)/rz))
            broad=noise.fractal(Vector((x*.024,z*.024,base*.02)),.9,2.0,4)
            ridge=noise.ridged_multi_fractal(Vector((x*.065,z*.065,base*.03)),.9,2.0,3,1.0,2.0)
            taper=max(.10,min(.86,.12+.62*rho+.09*broad+.035*(ridge-1)))
            x=cx+(x-cx)*taper; z=cz+(z-cz)*taper
        verts.append(native([x,underside_height(spec,x,z,p[2],segments),z]))
    for f in list(faces): faces.append(tuple(vcount+i for i in reversed(f)))
    for edge in boundary.values():
        if edge is None: continue
        a,b=edge; faces.extend([(a,b,b+vcount),(a,b+vcount,a+vcount)])
    mesh=bpy.data.meshes.new('SC_'+spec['id']+'_Terrain'); mesh.from_pydata(verts,[],faces); mesh.update()
    obj=bpy.data.objects.new('SC_'+spec['zone']+'_'+spec['id']+'_Island',mesh); scene.collection.objects.link(obj)
    mesh.materials.append(darkgrass if spec['biome']=='ruin' else grass); mesh.materials.append(rock)
    for polygon in mesh.polygons: polygon.material_index=0 if polygon.index<top_count else 1
    obj['zone']=spec['zone']; obj['island_id']=spec['id']; obj['island_binding']=spec['id']; obj['landscape_role']=spec['label']; obj['origin']='P'
    terrain_objects.append(obj)

# Import the original CC0 meshes once; instances share editable geometry and texture dependencies.
nature_templates={}
def nature_asset(module,name,p,height,angle):
    if module not in nature_templates:
        before=set(scene.objects)
        bpy.ops.import_scene.gltf(filepath='/Users/muniao/Code/MapleStory/resources/scenes/sky-voyage-v3/vendor/landscape/'+module+'.gltf')
        imported=[o for o in scene.objects if o not in before]; meshes=[o for o in imported if o.type=='MESH']; assert meshes
        for obj in scene.objects: obj.select_set(False)
        for obj in meshes: obj.select_set(True)
        bpy.context.view_layer.objects.active=meshes[0]
        if len(meshes)>1: bpy.ops.object.join()
        obj=bpy.context.object
        bpy.ops.object.transform_apply(location=True,rotation=True,scale=True)
        bounds=[obj.matrix_world@Vector(c) for c in obj.bound_box]; bottom=min(c[2] for c in bounds)
        for vertex in obj.data.vertices: vertex.co.z-=bottom
        obj.name='SC_Template_Nature_'+module; obj.hide_render=True; obj.hide_set(True); nature_templates[module]=obj
        for other in list(scene.objects):
            if other in imported and other!=obj: bpy.data.objects.remove(other,do_unlink=True)
    template=nature_templates[module]; obj=template.copy(); scene.collection.objects.link(obj)
    obj.name='SC_'+name; obj.hide_render=False; obj.hide_set(False); obj.location=native(p); obj.rotation_euler.z=angle
    scale=height/template.dimensions.z; obj.scale=(scale,scale,scale)
    obj['asset_source']='Quaternius Stylized Nature MegaKit Standard'; obj['asset_license']='CC0 1.0'; obj['asset_module']=module
    return obj

for spec in LAYOUT['landscape']['islands']:
    if spec['biome']=='sanctuary': continue
    cx,base,cz=spec['center']; rx,rz=spec['radii']; segments=nearby_segments(spec)
    for i in range(60):
        theta=i*2.399963+len(spec['id'])*.35; radius=.45+.43*((i*7)%13)/12
        x=cx+rx*radius*math.cos(theta); z=cz+rz*radius*math.sin(theta); y=ground_height(spec,x,z,segments)
        height=14+8*(.5+.5*math.sin(i*2.3)) if i%2==0 else 1.5+1.5*(.5+.5*math.cos(i))
        p=[x,y,z]
        if not clear_of_roads(p,4 if i%2==0 else 2,height): continue
        # Keep the five craft shells and the central palace free of vegetation.
        if spec['zone']=='B' and any(abs(x-(-360+(j%3)*48))<22 and abs(z-(65+(j//3)*58))<22 for j in range(5)): continue
        if spec['zone']=='H' and any(abs(x-hx)<18 and abs(z-hz)<18 for hx,hz in [(520,-451),(490,-400),(505,-350),(550,-405),(538,-485)]): continue
        if spec['zone']=='B' and abs(x+350)<20 and abs(z+88)<20: continue
        module=('DeadTree_1' if spec['biome']=='ruin' and i%4==0 else 'CommonTree_4' if i%4==0 else 'CommonTree_1') if i%2==0 else 'Rock_Medium_1' if i%7==1 else 'Bush_Common_Flowers' if i%4==1 else 'Bush_Common'
        obj=nature_asset(module,spec['zone']+'_'+spec['id']+'_Nature',p,height,theta); obj['island_binding']=spec['id']
    if spec['biome'] in ('blue','woodland'):
        for i in range(4):
            theta=i*1.57+.35; x=cx+rx*.55*math.cos(theta); z=cz+rz*.55*math.sin(theta); y=ground_height(spec,x,z,segments)+.12
            if not clear_of_roads([x,y,z],11,1): continue
            obj=pad(spec['zone']+'_'+spec['id']+'_Pool',[x,y,z],9,water); obj.scale.y=.6; obj['island_binding']=spec['id']; obj['landscape_role']='decorative water; not simulated fluid'
            break

# Ray checks use the actual terrain triangles, so an upper island cannot quietly fill a lower passage.
from mathutils.bvhtree import BVHTree
def support_tree(objects):
    vertices=[]; polygons=[]
    for obj in objects:
        offset=len(vertices); vertices.extend([obj.matrix_world@v.co for v in obj.data.vertices])
        polygons.extend([tuple(offset+i for i in f.vertices) for f in obj.data.polygons])
    return BVHTree.FromPolygons(vertices,polygons)

terrain_tree=support_tree(terrain_objects)
carriers=[]; fragment_count=0
external_roads=[e for e in land_roads if not e['interior'] and e['surface'] not in ('suspension','rainbow')]
all_segments=[(e['id'],a,b,e['width']/2) for e in land_roads for a,b in zip(e['points'],e['points'][1:])]
for e in external_roads:
    verts=[]; faces=[]; road_segments=list(zip(e['points'],e['points'][1:]))
    def road_height(x,z):
        best=1000000; height=0
        for a,b in road_segments:
            distance,y=distance_to_segment(x,z,a,b)
            if distance<best: best=distance; height=y
        return height
    for a,b in road_segments:
        dx,dz=b[0]-a[0],b[2]-a[2]; run=math.hypot(dx,dz)
        if run<.001: continue
        count=max(1,math.ceil(run/LAYOUT['landscape']['roadCarriers']['fragmentSpacing']))
        for i in range(count+1):
            t=i/count; p=[a[k]+t*(b[k]-a[k]) for k in range(3)]
            missing=False
            for side in (-.45,0,.45):
                q=[p[0]+side*e['width']*dz/run,p[1]+.03,p[2]-side*e['width']*dx/run]
                if terrain_tree.ray_cast(Vector(native(q)),Vector((0,0,-1)),1.83)[0] is None: missing=True
            if not missing: continue
            # ponytail: merge fragments per street; split to individual rigid bodies when physics navigation is connected.
            phase=fragment_count*2.399963; fragment_count+=1
            rx=e['width']/2+2.5+1.2*math.sin(phase)**2; rz=4.5+2*math.cos(phase*.7)**2
            nearby=[(eid,c,d,hw) for eid,c,d,hw in all_segments if eid!=e['id'] and max(c[0],d[0])>=p[0]-rx-15 and min(c[0],d[0])<=p[0]+rx+15 and max(c[2],d[2])>=p[2]-rx-15 and min(c[2],d[2])<=p[2]+rx+15]
            def crown(x,z):
                y=road_height(x,z)-1.2
                for eid,c,d,hw in nearby:
                    distance,other=distance_to_segment(x,z,c,d)
                    if distance<hw+2 and abs(other-y)<4.8: y=min(y,other-1.2)
                return y
            depth=5+9*abs(math.sin(phase*.3)); top=[]; size=12
            for j in range(size):
                theta=2*math.pi*j/size; r=1+.09*math.sin(theta*3+phase)
                along=rz*r*math.cos(theta); across=rx*r*math.sin(theta)
                x=p[0]+along*dx/run+across*dz/run; z=p[2]+along*dz/run-across*dx/run
                top.append([x,crown(x,z),z])
            offset=len(verts); verts.append(native([p[0],crown(p[0],p[2]),p[2]]))
            for ring_index in range(1,5):
                for q in top:
                    x=p[0]+(q[0]-p[0])*ring_index/4; z=p[2]+(q[2]-p[2])*ring_index/4
                    verts.append(native([x,crown(x,z),z]))
            for j in range(size): faces.append((offset,offset+1+(j+1)%size,offset+1+j))
            for ring_index in range(3):
                for j in range(size):
                    k=(j+1)%size; u=offset+1+ring_index*size+j; v=offset+1+ring_index*size+k
                    faces.extend([(u,v,v+size),(u,v+size,u+size)])
            for j,q in enumerate(top):
                x=p[0]+(q[0]-p[0])*.34; z=p[2]+(q[2]-p[2])*.34
                bottom=q[1]-depth*(.5+.15*math.sin(j*1.7+phase))
                for eid,c,d,hw in nearby:
                    distance,other=distance_to_segment(x,z,c,d)
                    if other<q[1]-4.8 and distance<hw+rx+2: bottom=max(bottom,other+4.8)
                verts.append(native([x,min(q[1]-.25,bottom),z]))
            tip_y=crown(p[0],p[2])-depth
            for eid,c,d,hw in nearby:
                distance,other=distance_to_segment(p[0],p[2],c,d)
                if other<tip_y+depth-4.8 and distance<hw+rx+2: tip_y=max(tip_y,other+4.8)
            tip=len(verts); verts.append(native([p[0]+.6*math.sin(phase),min(crown(p[0],p[2])-.25,tip_y),p[2]]))
            for j in range(size):
                k=(j+1)%size; u=offset+1+3*size+j; v=offset+1+3*size+k; l=u+size; m=v+size
                faces.extend([(u,v,m),(u,m,l),(tip,l,m)])
    if verts:
        mesh=bpy.data.meshes.new('SC_Support_'+e['id']); mesh.from_pydata(verts,[],faces); mesh.update()
        obj=bpy.data.objects.new('SC_Support_'+e['id'],mesh); scene.collection.objects.link(obj); mesh.materials.append(rock)
        obj['support_edge']=e['id']; obj['zones']=nodes[e['start']]['zone']+nodes[e['end']]['zone']; obj['carrier']='fragment-island-chain'; carriers.append(obj)
terrain_objects.extend(carriers)
vertices=[]; polygons=[]
for obj in terrain_objects:
    offset=len(vertices); vertices.extend([obj.matrix_world@v.co for v in obj.data.vertices])
    polygons.extend([tuple(offset+i for i in f.vertices) for f in obj.data.polygons])
terrain_tree=BVHTree.FromPolygons(vertices,polygons)
conflicts=[]; sample_count=0
for e in land_roads:
    for a,b in zip(e['points'],e['points'][1:]):
        dx,dz=b[0]-a[0],b[2]-a[2]; run=math.hypot(dx,dz)
        if run<.0001: continue
        count=max(1,math.ceil(run/2))
        for i in range(count+1):
            t=i/count; p=[a[k]+t*(b[k]-a[k]) for k in range(3)]
            for side in (-.45,0,.45):
                q=[p[0]+side*e['width']*dz/run,p[1]+.035,p[2]-side*e['width']*dx/run]
                hit=terrain_tree.ray_cast(Vector(native(q)),Vector((0,0,1)),3.2); sample_count+=1
                if hit[0] is not None: conflicts.append((e['id'],q))
assert not conflicts,('terrain blocks road headroom',len(conflicts),conflicts[:8])
scene['terrain_clearance_check']=json.dumps({'ray_samples':sample_count,'conflicts':len(conflicts),'height':3.2,'scope':'terrain faces only; not authoritative character collision'})
unsupported=[]; support_samples=0
for e in external_roads:
    for a,b in zip(e['points'],e['points'][1:]):
        dx,dz=b[0]-a[0],b[2]-a[2]; run=math.hypot(dx,dz)
        if run<.001: continue
        count=max(1,math.ceil(run/2))
        for i in range(count+1):
            t=i/count; p=[a[k]+t*(b[k]-a[k]) for k in range(3)]
            for side in (-.45,0,.45):
                q=[p[0]+side*e['width']*dz/run,p[1]+.03,p[2]-side*e['width']*dx/run]; support_samples+=1
                if terrain_tree.ray_cast(Vector(native(q)),Vector((0,0,-1)),1.83)[0] is None: unsupported.append((e['id'],q))
assert not unsupported,('exterior roads need a carrier',len(unsupported),unsupported[:8])
scene['road_carrier_check']=json.dumps({'samples':support_samples,'unsupported':len(unsupported),'fragments':fragment_count,'fragment_meshes':len(carriers),'max_gap':1.8})
for obj in list(scene.objects):
    if obj.name.startswith('SC_Template_'): bpy.data.objects.remove(obj,do_unlink=True)
for e in LAYOUT['edges']:
    obj=bpy.data.objects.get('SC_'+e['id']); obj['zones']=nodes[e['start']]['zone']+nodes[e['end']]['zone']
for obj in scene.objects:
    if obj.get('zone'): continue
    name=obj.name[3:]
    if name.startswith('Template_'): obj['zone']='template'; continue
    if name.startswith('B_Craft_') or name.startswith(('B_','G_','F_','A_','C_','D_','E_','H_')): obj['zone']=name[0]
    elif obj.parent and obj.parent.get('map_id'): obj['zone']='F'
for room in LAYOUT['rooms']:
    root=bpy.data.objects.get('SC_'+room['id']); root['zone']='F'
for obj in scene.objects:
    if obj.type in ('LIGHT','CAMERA') or obj.parent or obj.get('edge_id') or obj.get('support_edge') or obj.get('island_binding'): continue
    if obj.get('node_id'): obj['motion_node']=obj['node_id']; continue
    zone=obj.get('zone')
    if not zone or zone not in 'ABCDEFGH': continue
    if zone=='G': obj['island_binding']='A03'; continue
    if zone=='F' and (obj.get('map_id') or obj.name.startswith(('SC_F_Cloister','SC_F_FlatLanding','SC_F_Hall','SC_F_UpperHall','SC_F_Central','SC_F_East','SC_F_Crown'))):
        obj['island_binding']='F01'; continue
    p=obj.location if obj.type!='MESH' else sum([obj.matrix_world@Vector(c) for c in obj.bound_box],Vector())/8
    best=None; best_cost=1000000
    for spec in LAYOUT['landscape']['islands']:
        if spec['zone']!=zone: continue
        c=spec['center']; r=spec['radii']; cost=math.hypot((p.x-c[0])/r[0],(-p.y-c[2])/r[1])+abs(p.z-c[1])*.045
        if cost<best_cost: best=spec['id']; best_cost=cost
    obj['island_binding']=best

def pipe(name,points,radius,mat):
    verts=[]; faces=[]; count=8
    for i,p in enumerate(points):
        tangent=Vector(native(points[min(i+1,len(points)-1)]))-Vector(native(points[max(0,i-1)]))
        tangent.normalize(); side=tangent.cross(Vector((0,0,1)))
        if side.length<.001: side=Vector((1,0,0))
        side.normalize(); up=tangent.cross(side).normalized(); centre=Vector(native(p))
        for j in range(count): verts.append(centre+radius*(side*math.cos(j*2*math.pi/count)+up*math.sin(j*2*math.pi/count)))
    for i in range(len(points)-1):
        for j in range(count): faces.append((i*count+j,i*count+(j+1)%count,(i+1)*count+(j+1)%count,(i+1)*count+j))
    faces.extend([tuple(range(count-1,-1,-1)),tuple(range((len(points)-1)*count,len(points)*count))])
    mesh=bpy.data.meshes.new('SC_'+name); mesh.from_pydata(verts,[],faces); mesh.update()
    obj=bpy.data.objects.new('SC_'+name,mesh); scene.collection.objects.link(obj); mesh.materials.append(mat); return obj

for link in LAYOUT['physicalLinks']:
    if link['surface']!='suspension': continue
    points=link['points']; width=next(e['width'] for e in LAYOUT['edges'] if e['id']==link['edges'][0]); distances=[0]
    for a,b in zip(points,points[1:]): distances.append(distances[-1]+math.hypot(b[0]-a[0],b[2]-a[2]))
    for sign in (-1,1):
        cable=[]
        for i,p in enumerate(points):
            before=points[max(0,i-1)]; after=points[min(len(points)-1,i+1)]
            dx,dz=after[0]-before[0],after[2]-before[2]; run=math.hypot(dx,dz)
            if run<.0001: continue
            t=distances[i]/distances[-1]; h=1.3+3*(math.cosh((2*t-1)*1.4)-1)/(math.cosh(1.4)-1)
            q=[p[0]+sign*(width/2+.4)*dz/run,p[1]+h,p[2]-sign*(width/2+.4)*dx/run]; cable.append(q)
            obj=pipe('Bridge_'+link['id']+'_Hanger',[[q[0],p[1],q[2]],q],.12,accent)
            obj['bridge_edge']=link['id']; obj['zones']=nodes[link['start']]['zone']+nodes[link['end']]['zone']
        obj=pipe('Bridge_'+link['id']+'_Cable',cable,.18,wood); obj['bridge_edge']=link['id']; obj['zones']=nodes[link['start']]['zone']+nodes[link['end']]['zone']
scene['stage']='editable district modelling study; not game navigation'

world=bpy.data.worlds.new('SC_World'); world.use_nodes=True; scene.world=world
background=next(n for n in world.node_tree.nodes if n.type=='BACKGROUND')
background.inputs['Color'].default_value=(.49,.68,.87,1); background.inputs['Strength'].default_value=.6
data=bpy.data.lights.new('SC_Sun','SUN'); data.energy=3; data.angle=.2; data.color=(1,.92,.8)
obj=bpy.data.objects.new('SC_Sun',data); scene.collection.objects.link(obj); obj.rotation_euler=(.5,-.3,-.7)
data=bpy.data.cameras.new('SC_Camera'); data.type='ORTHO'; data.ortho_scale=1500; data.clip_end=6000
camera=bpy.data.objects.new('SC_Camera',data); scene.collection.objects.link(camera)
camera.location=(950,-950,850); target=Vector((50,20,0))
camera.rotation_euler=(target-camera.location).to_track_quat('-Z','Y').to_euler(); scene.camera=camera
scene.render.engine=engine
scene.render.resolution_x=1600; scene.render.resolution_y=1000; scene.render.resolution_percentage=100
formats=[x.identifier for x in scene.render.image_settings.bl_rna.properties['file_format'].enum_items]
assert 'PNG' in formats; scene.render.image_settings.file_format='PNG'
scene.render.filepath=DEST+'city-blender-massing.png'
transforms=[i.identifier for i in scene.view_settings.bl_rna.properties['view_transform'].enum_items]
if 'Standard' in transforms: scene.view_settings.view_transform='Standard'
scene.view_settings.exposure=.6
assert len([o for o in scene.objects if o.get('node_id')])==len(LAYOUT['nodes'])
assert len([o for o in scene.objects if o.get('map_id')])==27
assert len([o for o in scene.objects if 'original_floor' in o])==22
assert len([o for o in scene.objects if o.get('edge_id')])==len(LAYOUT['edges'])
exec(compile(open('/Users/muniao/Code/MapleStory/scripts/creative/blender/tag_sky_city_interiors.py',encoding='utf-8').read(),'tag_sky_city_interiors.py','exec'))
tag_interiors(scene,LAYOUT)
bpy.ops.wm.save_as_mainfile(filepath=DEST+'sky-city-spatial-prototype.blend')
bpy.ops.export_scene.gltf(filepath=DEST+'sky-city-spatial-prototype.glb',export_format='GLB',use_active_scene=True,
    export_animations=False,export_extras=True,export_cameras=False,export_lights=False)
bpy.ops.render.render(write_still=True)
detail=bpy.data.cameras.new('SC_RoadDetailCamera'); detail.type=data.type; detail.ortho_scale=105; detail.clip_end=data.clip_end
detail_obj=bpy.data.objects.new('SC_RoadDetailCamera',detail); scene.collection.objects.link(detail_obj)
detail_target=Vector((-140,80,52)); detail_obj.location=detail_target+Vector((65,-90,85))
detail_obj.rotation_euler=(detail_target-detail_obj.location).to_track_quat('-Z','Y').to_euler()
scene.camera=detail_obj; scene.render.filepath=DEST+'city-road-landing.png'
bpy.ops.render.render(write_still=True)
for zone in 'ABCDEFGH':
    positions=[Vector(native(n['position'])) for n in LAYOUT['nodes'] if n['zone']==zone and not n.get('gate')]
    centre=sum(positions,Vector())/len(positions)
    spread=max(max(p[k] for p in positions)-min(p[k] for p in positions) for k in range(3))
    camera.data.ortho_scale=max(110,spread*1.25)
    camera.location=centre+Vector((spread*.55+70,-spread*.6-80,spread*.52+85))
    camera.rotation_euler=(centre-camera.location).to_track_quat('-Z','Y').to_euler()
    for obj in scene.objects:
        if obj.type in ('LIGHT','CAMERA'): continue
        obj.hide_render=not (obj.get('zone')==zone or zone in obj.get('zones',''))
    def fit_visible():
        right=camera.rotation_euler.to_quaternion()@Vector((1,0,0)); up=camera.rotation_euler.to_quaternion()@Vector((0,1,0))
        points=[]
        for obj in scene.objects:
            if obj.type=='MESH' and not obj.hide_render and obj.get('zone')==zone:
                points.extend([obj.matrix_world@Vector(c) for c in obj.bound_box])
        xs=[(p-centre).dot(right) for p in points]; ys=[(p-centre).dot(up) for p in points]
        shift=right*(min(xs)+max(xs))/2+up*(min(ys)+max(ys))/2
        camera.location+=shift
        aspect=scene.render.resolution_x/scene.render.resolution_y
        camera.data.ortho_scale=max(max(xs)-min(xs),(max(ys)-min(ys))*aspect)*1.15
    scene.render.resolution_x=1200 if zone=='G' else 1600
    scene.render.resolution_y=1600 if zone=='G' else 1000
    fit_visible()
    scene.camera=camera; scene.render.filepath=DEST+'district-'+zone+'-model.png'
    bpy.ops.render.render(write_still=True)
    def close_view(filename,p,scale,levels=None):
        centre=Vector(native(p)); camera.location=centre+Vector((scale*.55,-scale*.7,scale*.65))
        camera.rotation_euler=(centre-camera.location).to_track_quat('-Z','Y').to_euler(); camera.data.ortho_scale=scale
        for obj in scene.objects:
            if obj.type in ('LIGHT','CAMERA'): continue
            obj.hide_render=not (obj.get('zone')==zone or zone in obj.get('zones',''))
            if not obj.hide_render and levels and obj.type=='MESH':
                heights=[(obj.matrix_world@Vector(c))[2] for c in obj.bound_box]
                obj.hide_render=min(heights)<levels[0]-.82 or max(heights)>levels[1]+9
        scene.render.filepath=DEST+filename; bpy.ops.render.render(write_still=True)
    if zone=='C':
        close_view('district-C-lower-model.png',[20,28,155],390,(19,34))
        close_view('district-C-upper-model.png',[5,45,45],440,(35,55))
    if zone=='D':
        for i,spec in enumerate(LAYOUT['landscape']['islands'][16:22]):
            close_view('district-D-park-'+str(i+1)+'-model.png',spec['center'],max(spec['radii'])*3)
    if zone=='E':
        close_view('district-E-crossing-model.png',[-140,53,-80],230)
        close_view('district-E-stairs-model.png',[-30,99,-215],280)
        close_view('district-E-dark-model.png',[-150,110,-285],220)
    if zone=='H': close_view('district-H-high-model.png',[568,92,-430],240)
    if zone=='G':
        scene.render.resolution_x=1400; scene.render.resolution_y=1100
        for i,(low,high) in enumerate([(-30,12),(-79,-37),(-135,-86)]):
            close_view('district-G-section-'+str(i+1)+'-model.png',[-85,(low+high)/2,193],90,(low,high))
    if zone=='F':
        for floor in range(3):
            height=94+floor*14; centre=Vector((160,300,height))
            camera.data.ortho_scale=185; camera.location=centre+Vector((115,-155,170))
            camera.rotation_euler=(centre-camera.location).to_track_quat('-Z','Y').to_euler()
            for obj in scene.objects:
                if obj.type in ('LIGHT','CAMERA'): continue
                obj.hide_render=True
                if obj.get('zone')!='F' and 'F' not in obj.get('zones',''): continue
                if obj.type=='MESH':
                    heights=[(obj.matrix_world@Vector(c))[2] for c in obj.bound_box]
                    obj.hide_render=min(heights)<height-.82 or max(heights)>height+9
            scene.render.filepath=DEST+'district-F-level-'+str(floor+1)+'-model.png'
            fit_visible()
            bpy.ops.render.render(write_still=True)
    if zone=='B':
        centre=Vector((-320,-108,26)); camera.location=centre+Vector((90,-130,135))
        camera.rotation_euler=(centre-camera.location).to_track_quat('-Z','Y').to_euler(); camera.data.ortho_scale=205
        for obj in scene.objects:
            if 'B_Craft_' in obj.name and 'Roof' in obj.name: obj.hide_render=True
        scene.render.filepath=DEST+'district-B-craft-cutaway.png'; bpy.ops.render.render(write_still=True)
        centre=Vector((-350,78,42)); camera.location=centre+Vector((75,-100,90))
        camera.rotation_euler=(centre-camera.location).to_track_quat('-Z','Y').to_euler(); camera.data.ortho_scale=95
        scene.render.filepath=DEST+'district-B-hero-model.png'; bpy.ops.render.render(write_still=True)
for label,point,span,allowed in [('rainbow',[35,100,-230],370,'EF'),('carriers',[-142,18,245],175,'ADG')]:
    centre=Vector(native(point)); camera.location=centre+Vector((span*.45,-span*.65,span*.42))
    camera.rotation_euler=(centre-camera.location).to_track_quat('-Z','Y').to_euler(); camera.data.ortho_scale=span
    scene.camera=camera; scene.render.resolution_x=1600; scene.render.resolution_y=1000
    for obj in scene.objects:
        if obj.type in ('LIGHT','CAMERA'): continue
        obj.hide_render=not (obj.get('zone','?') in allowed or any(z in obj.get('zones','') for z in allowed))
    scene.render.filepath=DEST+'city-'+label+'-model.png'; bpy.ops.render.render(write_still=True)
for obj in scene.objects: obj.hide_render=False
scene.render.resolution_x=1600; scene.render.resolution_y=1000
camera.location=(950,-950,850); camera.rotation_euler=(target-camera.location).to_track_quat('-Z','Y').to_euler(); camera.data.ortho_scale=1500
scene.camera=camera; scene.render.filepath=DEST+'city-blender-massing.png'
bpy.ops.wm.save_as_mainfile(filepath=DEST+'sky-city-spatial-prototype.blend')
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type=='VIEW_3D':
            area.spaces.active.clip_end=6000
            area.spaces.active.region_3d.view_perspective='CAMERA'
            area.spaces.active.shading.type='MATERIAL'
print({'scene':scene.name,'objects':len(scene.objects),'maps':len(LAYOUT['mapAssignments']),
       'rooms':27,'tower_floors':22,'walk_nodes':len(LAYOUT['nodes']),'unique_roads':len(LAYOUT['edges']),
       'islands':len(LAYOUT['landscape']['islands']),'stage':'district modelling study; authority/navigation not connected'})
