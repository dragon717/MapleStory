"""Restore the original ship volume removed for the obsolete side-facing wheels.

The wheel is now an outboard X/Z fan. Its old Y/Z clearance disk must not
remain as a circular hole in the hull. Recover only the archived body faces
removed by that old predicate, keeping the authored jewel apertures and all
current captain-room work. Neither source archive nor navigation is edited.
"""
import bpy
import math
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree
from clip_voyage_hull import build, partition
from refine_voyage_wheel_rear_orientation import apply as apply_wheels

BASE = 'SV3_WheelHull_BeforeVolumeRestoration'
REVISION = '2026-10-05: original body recovered; wheels and brackets fully outboard'


def _convex_outline(points):
    points = sorted(set(points))
    def cross(a, b, c):
        return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
    def chain(values):
        result = []
        for p in values:
            while len(result) > 1 and cross(result[-2], result[-1], p) <= 0:
                result.pop()
            result.append(p)
        return result
    return chain(points)[:-1] + chain(reversed(points))[:-1]


def _close_original_wheel_void(scene, hull, source):
    """Loft two curved shell panels through the source's original wheel void.

    The imported body itself has no faces inside the old 9.68m wheel circle.
    Interpolate the adjacent source shell in Y/Z, clipped to its measured
    silhouette. The new shell has opposite sides and edge returns, making a
    closed body volume rather than an opaque axle disk.
    """
    name = 'SV3_HullWheelVolumeClosure'
    previous = scene.objects.get(name)
    if previous:
        bpy.data.objects.remove(previous, do_unlink=True)
    clouds = {side: {} for side in (-1, 1)}
    for p in source.polygons:
        if not any(k in source.materials[p.material_index].name for k in ('HullIvory', 'DeckTeak')):
            continue
        for index in p.vertices:
            co = source.vertices[index].co
            if not (18.5 <= co.y <= 41.3 and -12 <= co.z <= 11.5) or abs(co.x) < .1:
                continue
            side = 1 if co.x > 0 else -1
            key = (round(co.y, 2), round(co.z, 2))
            # Retain the outside skin when an original cross-section also
            # contains interior timber at the same projected coordinate.
            clouds[side][key] = max(clouds[side].get(key, 0), abs(co.x))
    outlines, fields = {}, {}
    for side, cloud in clouds.items():
        assert len(cloud) > 500, 'missing adjacent source hull profile'
        outlines[side] = _convex_outline(cloud)
        points = [(key, value) for key, value in cloud.items() if math.hypot(key[0]-29.79,key[1]) >= 9.60]
        tree = KDTree(len(points))
        for i, ((y, z), _) in enumerate(points):
            tree.insert((y, z, 0), i)
        tree.balance()
        fields[side] = (tree, points)
    # Clip each small grid cell both to the source silhouette and to a
    # slightly overlapping circle. Seam returns sit inside the retained ring.
    cuts = []
    for outline in outlines.values():
        for i, a in enumerate(outline):
            b = outline[(i+1) % len(outline)]
            normal = Vector((-(b[1]-a[1]), b[0]-a[0], 0)).normalized()
            cuts.append((normal, normal.dot(Vector((*a, 0)))))
    for i in range(160):
        angle = i * math.tau / 160
        normal = Vector((-math.cos(angle), -math.sin(angle), 0))
        cuts.append((normal, normal.dot(Vector((29.79, 0, 0))) - 10.05))
    yz_vertices, surface_faces, lookup = [], [], {}
    weld = 1e-4
    def vertex(y, z):
        # Adjacent clipped cells calculate the same intersection a few
        # micrometres apart. Weld before building the returns so those seams
        # cannot create four faces sharing one cross-body edge.
        key = (math.floor(y/weld), math.floor(z/weld))
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                for index in lookup.get((key[0]+dy, key[1]+dz), []):
                    a, b = yz_vertices[index]
                    if math.hypot(y-a, z-b) < weld:
                        return index
        index = len(yz_vertices)
        yz_vertices.append((y, z))
        lookup.setdefault(key, []).append(index)
        return index
    for row in range(58):
        y0 = 19.74 + row * .35
        for column in range(63):
            z0 = -10.05 + column * .35
            poly = [(Vector((y0, z0, 0)), [], Vector((0,0,1))),
                    (Vector((y0+.35, z0, 0)), [], Vector((0,0,1))),
                    (Vector((y0+.35, z0+.35, 0)), [], Vector((0,0,1))),
                    (Vector((y0, z0+.35, 0)), [], Vector((0,0,1)))]
            inside = partition(poly, cuts)[0]
            if len(inside) >= 3:
                face = tuple(vertex(co.x, co.y) for co, _, _ in inside)
                if len(set(face)) >= 3:
                    surface_faces.append(face)
    verts = []
    for side in (-1, 1):
        tree, points = fields[side]
        for y, z in yz_vertices:
            neighbours = tree.find_n((y, z, 0), 12)
            weights = [(points[index][1], 1 / max(distance, .12)**2) for _, index, distance in neighbours]
            x = sum(x*w for x, w in weights) / sum(w for _, w in weights)
            # A small inset under the recovered boundary prevents coplanar
            # overlays while keeping the interior surface comfortably curved.
            r = math.hypot(y-29.79, z)
            inset = .04 + .20 * max(0, min(1, (r-8.8)/1.25))
            verts.append((side * max(.15, x-inset), y, z))
    n = len(yz_vertices)
    neighbours = [set() for _ in yz_vertices]
    for face in surface_faces:
        for i, a in enumerate(face):
            b = face[(i+1) % len(face)]
            neighbours[a].add(b); neighbours[b].add(a)
    # Smooth the unsupported middle through the ring's measured boundary.
    # This removes noise from the imported skin while retaining the curved
    # joins. The same scalar field is shared by neighbouring grid cells.
    for side_index in range(2):
        start = side_index*n
        values = [v[0] for v in verts[start:start+n]]
        for _ in range(35):
            values = [value if math.hypot(yz_vertices[i][0]-29.79,yz_vertices[i][1]) >= 9.2 or not neighbours[i]
                      else .5*value + .5*sum(values[j] for j in neighbours[i])/len(neighbours[i])
                      for i, value in enumerate(values)]
        for i, value in enumerate(values):
            _, y, z = verts[start+i]
            verts[start+i] = (value, y, z)
    faces = [tuple(reversed(face)) for face in surface_faces] + [tuple(i+n for i in face) for face in surface_faces]
    edges = {}
    for face in surface_faces:
        for i, a in enumerate(face):
            b = face[(i+1) % len(face)]
            key = tuple(sorted((a, b)))
            edges[key] = edges.get(key, 0) + 1
    for (a, b), count in edges.items():
        if count == 1:
            faces.append((a, b, b+n, a+n))
    data = bpy.data.meshes.new(name+'_Mesh')
    data.from_pydata(verts, [], faces); data.update()
    data.materials.append(bpy.data.materials['SV3_Finish_Deck'])
    data.materials.append(bpy.data.materials['SV3_Finish_Ivory'])
    obj = bpy.data.objects.new(name, data); scene.collection.objects.link(obj); obj.parent = hull
    import bmesh
    bm = bmesh.new(); bm.from_mesh(data)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    assert all(len(edge.link_faces) == 2 for edge in bm.edges), 'wheel volume closure must be manifold'
    bm.to_mesh(data); bm.free()
    for p in data.polygons:
        p.material_index = 0 if p.center.z <= 7.8 else 1
        p.use_smooth = True
    for label in ('SourceUV', 'MaterialUV'):
        uv = data.uv_layers.new(name=label)
        for p in data.polygons:
            axis = max(range(3), key=lambda i: abs(p.normal[i]))
            pair = [(1,2), (0,2), (1,0)][axis]
            for li in p.loop_indices:
                co = data.vertices[data.loops[li].vertex_index].co
                uv.data[li].uv = (co[pair[0]]/5, co[pair[1]]/2)
    data.uv_layers.active = data.uv_layers['MaterialUV']
    obj['structural_repair_child'] = True
    obj['structural_role'] = 'closed curved body across the original wheel void; measured source silhouette and shell profiles'
    obj['wheel_volume_shell'] = True
    obj['walk_surface'] = False
    hull_bvh = BVHTree.FromPolygons(verts, faces)
    probes = []
    for side in (-1, 1):
        for y in (24, 28, 32, 36):
            for z in (-2, 0, 2, 4):
                hit = hull_bvh.ray_cast(Vector((side*30,y,z)), Vector((-side,0,0)), 60)[0]
                assert hit is not None and hit.x*side > .1, 'original centre void remains open'
                probes.append([side, y, z, hit.x])
    coverage = 0
    for y in range(20, 41):
        for z in range(-9, 10):
            point = Vector((y,z,0))
            if math.hypot(y-29.79,z) > 9.6 or any(normal.dot(point) < offset+1e-4 for normal,offset in cuts):
                continue
            for side in (-1,1):
                hit = hull_bvh.ray_cast(Vector((side*30,y,z)),Vector((-side,0,0)),60)[0]
                assert hit is not None and hit.x*side > .1, 'measured body silhouette remains open'
                coverage += 1
    return {'object': obj.name, 'vertices': len(verts), 'faces': len(faces),
            'curve_source': 'outermost adjacent archived shell points; inverse-distance loft',
            'silhouette': 'intersection of measured port and starboard Y/Z outlines',
            'manifold_edges': len(data.edges), 'edge_face_count': 2,
            'silhouette_coverage_probes': coverage,
            'closed_boundary_returns': sum(count==1 for count in edges.values()),
            'centre_void_probes': probes}


def _record(mesh, polygon):
    return [(mesh.vertices[mesh.loops[i].vertex_index].co.copy(),
             [layer.data[i].uv.copy() for layer in mesh.uv_layers],
             mesh.corner_normals[i].vector.copy()) for i in polygon.loop_indices]


def apply(scene):
    hull = scene.objects['SV3_Hull']
    archive = bpy.data.objects['BeforeRepair_SV3_Hull'].data
    # Reapplying the finishing job always rebuilds from the pre-restoration
    # cache, so source faces can never accumulate or produce z fighting.
    if hull.get('wheel_hull_restore_revision') == REVISION and bpy.data.meshes.get(BASE):
        base = bpy.data.meshes[BASE]
    else:
        base = hull.data.copy()
        base.name = BASE
        base.use_fake_user = True
    body = [(p, _record(archive, p)) for p in archive.polygons
            if abs(p.center.x) > 4 and math.hypot(p.center.y - 29.79, p.center.z) < 10.7
            and any(k in archive.materials[p.material_index].name for k in ('HullIvory', 'DeckTeak'))]
    assert len(body) > 1000, 'original wheel-area hull faces are unavailable'
    ivory = base.materials.find('SV3_Finish_Ivory')
    deck = base.materials.find('SV3_Finish_Deck')
    assert min(ivory, deck) >= 0, 'current hull finish slots missing'
    kept = [(_record(base, p), p.material_index, p.use_smooth) for p in base.polygons]
    added = []
    jewel_cuts = []
    for side in (-1, 1):
        planes = [(Vector((side, 0, 0)), 7.5)]
        for i in range(64):
            angle = i * math.tau / 64
            normal = Vector((0, -math.cos(angle), -math.sin(angle)))
            planes.append((normal, normal.dot(Vector((0, 21.2, 8.15))) - 3 * 1.08))
        jewel_cuts.append(planes)
    for source_polygon, source_poly in body:
        remaining = [source_poly]
        for cut in jewel_cuts:
            remaining = [part for poly in remaining for part in partition(poly, cut)[1]]
        for poly in remaining:
            # Same timber/ivory boundary used by the retained ship shell.
            material = deck if sum(v[0].z for v in poly) / len(poly) <= 7.8 else ivory
            normal = source_polygon.normal
            axis = max(range(3), key=lambda i: abs(normal[i]))
            pair = [(1, 2), (0, 2), (1, 0)][axis]
            for co, uvs, _ in poly:
                # The archive's SourceUV remains exact. Only the current
                # metre-scale finish UV is refreshed for the body material.
                uvs[1] = Vector((co[pair[0]] / 5, co[pair[1]] / 2))
            added.append((poly, material, source_polygon.use_smooth))
    hull.data = build('SV3_Hull_CompleteWheelVolume', kept + added, base)
    hull['wheel_hull_restore_revision'] = REVISION
    hull['wheel_hull_original_faces_recovered'] = len(body)
    hull['wheel_clearance_carving'] = False
    source_bvh = BVHTree.FromPolygons([v.co for v in archive.vertices], [p.vertices for p, _ in body])
    restored_bvh = BVHTree.FromPolygons([v.co for v in hull.data.vertices], [p.vertices for p in hull.data.polygons])
    probes = []
    for side in (-1, 1):
        for y in (20, 40):
            for z in (-4, -2, 0, 2):
                start, direction = Vector((side * 30, y, z)), Vector((-side, 0, 0))
                source_hit = source_bvh.ray_cast(start, direction, 60)[0]
                if source_hit is None or source_hit.x*side <= 0:
                    continue
                hit = restored_bvh.ray_cast(start, direction, 60)[0]
                error = (hit - source_hit).length if hit is not None else 999
                assert error < .015, 'restored wheel-area body does not match the original shell'
                probes.append({'side': side, 'y': y, 'z': z, 'original_x': source_hit.x, 'restored_x': hit.x, 'error_m': error})
    assert len(probes) >= 8, 'insufficient actual recovered-boundary probes'
    closure = _close_original_wheel_void(scene, hull, archive)
    # No hull faces are deleted to clear the new fan. The outboard mount is
    # computed beyond the whole fixed body plus the fan's full spin radius.
    fixed_x = max(abs(v.co.x) for v in hull.data.vertices)
    report = apply_wheels(scene, minimum_hub_x=fixed_x + 10.58 + 1.10)
    scene['wheel_hull_restore_revision'] = REVISION
    return {'revision': REVISION, 'source': 'BeforeRepair_SV3_Hull',
            'source_faces_recovered': len(body), 'restored_fragments': len(added),
            'hull_faces': len(hull.data.polygons), 'fixed_hull_x_extent': fixed_x,
            'original_body_ray_probes': probes,
            'original_centre_void_closure': closure,
            'body_faces_removed_for_clearance': 0, 'wheels': report}
