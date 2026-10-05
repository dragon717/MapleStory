"""Fit the captain door to its portal and author the separate tapered bow."""
import bpy
import bmesh
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from author_voyage_structural_routes import _box_mesh, _materials, _empty


def fit_door(scene):
    ship = scene.objects['SV2_Ship']
    room = scene.objects['SV3_CaptainRoom']
    inverse = ship.matrix_world.inverted()
    source_hull = bpy.data.objects['BeforeRepair_SV3_Hull'].data
    hull_bvh = BVHTree.FromPolygons([v.co for v in source_hull.vertices], [p.vertices for p in source_hull.polygons])
    def surface_x(y, z):
        start = Vector((7,y,max(5.5,z)))
        for _ in range(12):
            hit, normal, _, _ = hull_bvh.ray_cast(start, Vector((-1,0,0)), 3)
            if hit is None: break
            if normal.x > .65: return hit.x
            start = hit + Vector((-.001,0,0))
        raise RuntimeError(f'Original captain hull surface missing at {y}, {z}')
    changed = []
    for obj in list(room.children_recursive):
        if obj.type != 'MESH' or not obj.name.startswith(('SV3_CaptainDoorSeal', 'SV3_CaptainDoorLintel', 'SV3_CaptainDoorDetail_')):
            continue
        backup = obj.name + '_BeforePortalFit'
        original = bpy.data.meshes.get(backup)
        if original is None:
            original = obj.data.copy(); original.name = backup; original.use_fake_user = True
        obj.data = original.copy()
        to_ship = inverse @ obj.matrix_world
        to_local = to_ship.inverted()
        for vertex in obj.data.vertices:
            point = to_ship @ vertex.co
            source_x = point.x
            point.y = -13.25 + (point.y + 13.25) * (1.05 / 2.5)
            point.z = 5.445 + (point.z - 5.42) * (1.48 / 2.7)
            point.x = surface_x(point.y, point.z) + .04 + (source_x - 4.97) * .75
            vertex.co = to_local @ point
        obj.data.update(); obj['portal_size_fit'] = 'slightly larger than the 0.975 x 1.4 local portal; shared floor baseline'
        changed.append(obj.name)
    for obj in list(scene.objects):
        if obj.name.startswith('SV3_CaptainDoorSurround_'):
            bpy.data.objects.remove(obj, do_unlink=True)
    wall = scene.objects['SV3_CaptainWall_Middle']
    cache_name = wall.name + '_BeforeDoorInfill'
    original = bpy.data.meshes.get(cache_name)
    if original is None:
        original = wall.data.copy(); original.name = cache_name; original.use_fake_user = True
    wall.data = original.copy()
    # The exterior aperture reveals the inner wall as a floating rectangle.
    # Recover its original curved hull and deck faces, interpolating source UV
    # and normals at the historical cut boundaries; no flat backing panel.
    previous = scene.objects.get('SV3_CaptainHullDoorRepair')
    if previous: bpy.data.objects.remove(previous, do_unlink=True)
    import clip_voyage_hull as clip
    import refine_voyage_prototype_finish as finish
    source = bpy.data.objects['BeforeRepair_SV3_Hull'].data
    bounds = [clip.box((4,-14.5,5.35),(7,-12,8.15)), clip.box((4,-14.5,8.15),(5.05,-12,8.35))]
    timber = clip.box((-100,-38,.4),(100,33,7.8))
    deck_index = next(i for i,m in enumerate(source.materials) if m.name == 'SV3_Prototype_DeckTeak')
    ivory_index = next(i for i,m in enumerate(source.materials) if m.name == 'SV3_Prototype_HullIvory')
    recovered = []
    for poly in source.polygons:
        points = [(source.vertices[source.loops[i].vertex_index].co.copy(), [uv.data[i].uv.copy() for uv in source.uv_layers], source.corner_normals[i].vector.copy()) for i in poly.loop_indices]
        for planes in bounds:
            part = clip.partition(points, planes)[0]
            if len(part) < 3: continue
            if poly.material_index in [deck_index, ivory_index]:
                wood, paint = clip.partition(part, timber)
                if len(wood) >= 3: recovered.append((wood, deck_index, poly.use_smooth))
                recovered.extend((p, ivory_index, poly.use_smooth) for p in paint)
            else: recovered.append((part, poly.material_index, poly.use_smooth))
    mesh = clip.build('SV3_CaptainHullDoorRepair_Mesh', recovered, source)
    mesh.materials[deck_index] = bpy.data.materials['SV3_Finish_Deck']
    mesh.materials[ivory_index] = bpy.data.materials['SV3_Finish_Ivory']
    repair = bpy.data.objects.new('SV3_CaptainHullDoorRepair', mesh)
    scene.collection.objects.link(repair); repair.parent = room
    finish.uv_component(repair, ship, 'timber')
    repair['door_aperture_repair'] = 'original curved hull and floor recovered from retained source'
    repair['walk_surface'] = False
    opening = scene.objects['SV3_CaptainDoorOpening']
    opening.location.x = 6.0775; opening.location.z = 5.445; opening['width'] = 1.05; opening['height'] = 1.48
    return {'changed': changed, 'door_width':1.05, 'door_height':1.48, 'floor':5.445, 'separate_wall_panel':False, 'deck_aperture_repaired':True, 'restored_hull_faces':len(mesh.polygons), 'door_mount':'fitted to retained hull surface'}


def bow_platform(scene, layout):
    ship = scene.objects['SV2_Ship']; exterior = scene.objects['SV3_Exterior']
    for obj in list(scene.objects):
        if obj.name.startswith('SV3_BowPlatform_') or obj.name == 'SV3_BowCabinPortal':
            bpy.data.objects.remove(obj, do_unlink=True)
    spec = layout['bowRoute']; stations = spec['stations']; thickness = spec['thickness']; materials = _materials()
    verts = []
    for z, y, width in stations:
        verts.extend([(-width,-z,y),(width,-z,y),(-width,-z,y-thickness),(width,-z,y-thickness)])
    faces = []
    for i in range(len(stations)-1):
        a=i*4; b=a+4
        faces.extend([(a,a+1,b+1,b),(a+2,b+2,b+3,a+3),(a,b,a+2+4,a+2),(a+1,a+3,b+3,b+1)])
    faces.extend([(0,2,3,1),tuple((len(stations)-1)*4+j for j in [0,1,3,2])])
    mesh=bpy.data.meshes.new('SV3_BowPlatform_Deck_Mesh'); mesh.from_pydata(verts,[],faces); mesh.update(); mesh.materials.append(materials['deck'])
    for name in ['SourceUV','MaterialUV']:
        uv=mesh.uv_layers.new(name=name)
        for poly in mesh.polygons:
            for index in poly.loop_indices:
                point=mesh.vertices[mesh.loops[index].vertex_index].co
                uv.data[index].uv=(point.x/2.5,point.y/2.5) if abs(poly.normal.z)>.5 else (point.y/2.5,point.z/2.5)
    mesh.uv_layers.active=mesh.uv_layers['MaterialUV']
    deck=bpy.data.objects.new('SV3_BowPlatform_Deck',mesh); scene.collection.objects.link(deck); deck.parent=exterior
    deck['walk_surface']=True; deck['bow_contract']=spec['contract']; deck['slope_section']='15'; deck['platform_section']='16/08'
    # Side rails follow each station, leaving the lower ramp entrance open.
    rails=bpy.data.objects.new('SV3_BowPlatform_Rails',None); scene.collection.objects.link(rails); rails.parent=exterior
    from refine_voyage_wheel_rear_orientation import _tube
    def tube(name,a,b,radius,material):
        obj=_tube(name,a,b,radius,material,rails); obj['rig_kind']='rigid-bow-railing'; return obj
    for side in [-1,1]:
        for i,(z,y,width) in enumerate(stations):
            tube(f'SV3_BowPlatform_Post_{side}_{i}',(side*width,-z,y),(side*width,-z,y+spec['railHeight']),.09,materials['brass'])
            if i:
                z0,y0,w0=stations[i-1]
                tube(f'SV3_BowPlatform_Rail_{side}_{i}',(side*w0,-z0,y0+spec['railHeight']),(side*width,-z,y+spec['railHeight']),.095,materials['wood'])
    z,y,width=stations[-1]
    tube('SV3_BowPlatform_TipRail',(-width,-z,y+spec['railHeight']),(width,-z,y+spec['railHeight']),.095,materials['wood'])
    target=spec['spawn']
    _empty('SV3_BowCabinPortal',(target[0],target[2],target[1]),exterior,interaction='Space returns to the cabin end opening')
    return {'stations':stations,'thickness':thickness,'rail_height':spec['railHeight'],'main_deck_connected':False}


def apply(scene, layout):
    return {'door':fit_door(scene),'bow':bow_platform(scene,layout)}
