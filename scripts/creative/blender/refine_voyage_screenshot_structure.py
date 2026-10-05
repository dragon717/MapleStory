"""Close visible captain-shell gaps without changing any walking route."""
import bpy
import bmesh
import math
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from author_voyage_structural_routes import _box_mesh, _materials
from refine_voyage_prototype_finish import uv_component

PREFIX = 'SV3_CaptainFinish_'


def apply_structure(scene):
    ship = scene.objects['SV2_Ship']
    room = scene.objects['SV3_CaptainRoom']
    exterior = scene.objects['SV3_Exterior']
    for obj in list(scene.objects):
        if obj.name.startswith(PREFIX):
            bpy.data.objects.remove(obj, do_unlink=True)
    mats = _materials()
    deck = _box_mesh(PREFIX + 'DeckInfill', (0, -9, 5.36), (12.20, 18.24, .13), bpy.data.materials.get('SV3_Finish_Deck') or mats['deck'], exterior)
    mesh = bmesh.new()
    mesh.from_mesh(deck.data)
    bmesh.ops.recalc_face_normals(mesh, faces=list(mesh.faces))
    mesh.to_mesh(deck.data)
    mesh.free()
    deck['walk_surface'] = False
    deck['structural_role'] = 'visible deck beneath retained sealed captain shell; existing route remains authoritative'
    uv_component(deck, ship, 'timber')

    # Restore the measured wall mount, undoing the historical .34m outset.
    window_report = {}
    for name in ['SV3_CaptainPorthole_Frame', 'SV3_CaptainPorthole_Glass']:
        obj = scene.objects[name]
        transform = ship.matrix_world.inverted() @ obj.matrix_world
        inverse = transform.inverted()
        points = [transform @ v.co for v in obj.data.vertices]
        desired = 4.79 if name.endswith('Glass') else 4.65
        shift = desired - min(p.x for p in points)
        if abs(shift) > 1e-6:
            obj.data = obj.data.copy()
            for vertex in obj.data.vertices:
                point = transform @ vertex.co
                point.x += shift
                vertex.co = inverse @ point
            obj.data.update()
        obj['porthole_mount'] = 'original wall envelope; no floating outset'
        window_report[name] = {'x_min': desired, 'shift': shift}

    # The original hull was cut to radius 1.12, while the brass frame ends at
    # 1.06. A fitted timber return seals that annular gap and joins the curved
    # hull aperture to the wall-mounted frame without capping the glass.
    hull = scene.objects['SV3_Hull']
    hull_transform = ship.matrix_world.inverted() @ hull.matrix_world
    hull_bvh = BVHTree.FromPolygons([hull_transform @ v.co for v in hull.data.vertices], [p.vertices for p in hull.data.polygons])
    verts, collar_faces = [], []
    segments = 192
    for radius in [1.035, 1.22]:
        for i in range(segments):
            angle = i * math.tau / segments
            y, z = -3.3 + radius * math.cos(angle), 7 + radius * math.sin(angle)
            hit, _, _, _ = hull_bvh.ray_cast(Vector((7, y, z)), Vector((-1, 0, 0)), 4)
            if radius < 1.1:
                point = Vector((4.915, y, z))
            elif hit:
                point = hit + Vector((.008, 0, 0))
            else:
                # Some aperture sectors intersect the central rectangular cut.
                # Bridge to the actual surviving boundary, never to a face that
                # exists only in the uncut historical source.
                nearest, _, _, _ = hull_bvh.find_nearest(Vector((5.05, y, z)))
                assert nearest is not None, 'porthole has no retained boundary'
                point = nearest + Vector((.008, 0, 0))
            verts.append(point)
    for i in range(segments):
        j = (i + 1) % segments
        collar_faces.append((i, j, j + segments, i + segments))
    collar_data = bpy.data.meshes.new(PREFIX + 'PortholeReturn_Mesh')
    collar_data.from_pydata(verts, [], collar_faces); collar_data.update()
    # Face the outside of the starboard hull (+X).
    for polygon in collar_data.polygons:
        if polygon.normal.x < 0:
            polygon.flip()
    collar_data.materials.append(bpy.data.materials.get('SV3_Finish_Walnut') or mats['wood'])
    collar = bpy.data.objects.new(PREFIX + 'PortholeReturn', collar_data)
    scene.collection.objects.link(collar); collar.parent = room
    uv_component(collar, ship, 'timber')
    collar['structural_role'] = 'annular timber return from original curved hull aperture to fitted brass frame'

    # Four continuous beams share exact corner points. The end beams follow
    # the actual retained curved roof, rather than crossing it as flat bars.
    roof = scene.objects['SV3_CaptainRoof']
    to_ship = ship.matrix_world.inverted() @ roof.matrix_world
    roof_bvh = BVHTree.FromPolygons([to_ship @ v.co for v in roof.data.vertices], [p.vertices for p in roof.data.polygons])
    def height(x, y):
        point, _, _, _ = roof_bvh.ray_cast(Vector((x, y, 12)), Vector((0, 0, -1)), 5)
        return max(8.325, point.z - .045) if point else 8.325
    corners = [Vector((-4.85, 0, 8.325)), Vector((4.85, 0, 8.325)), Vector((4.85, -18, 8.325)), Vector((-4.85, -18, 8.325))]
    route = []
    for index, start in enumerate(corners):
        end = corners[(index + 1) % 4]
        for step in range(32):
            p = start.lerp(end, step / 32)
            if index in [0, 2] and step:
                p.z = height(p.x, -.08 if index == 0 else -17.92)
            route.append(p)
    vertices, faces = [], []
    sides = 10
    for i, p in enumerate(route):
        direction = (route[(i + 1) % len(route)] - route[(i - 1) % len(route)]).normalized()
        across = direction.cross(Vector((0, 0, 1))).normalized()
        up = across.cross(direction).normalized()
        for j in range(sides):
            angle = j * math.tau / sides
            vertices.append(p + across * (.11 * math.cos(angle)) + up * (.105 * math.sin(angle)))
    for i in range(len(route)):
        nxt = (i + 1) % len(route)
        for j in range(sides):
            faces.append((i * sides + j, i * sides + (j + 1) % sides, nxt * sides + (j + 1) % sides, nxt * sides + j))
    data = bpy.data.meshes.new(PREFIX + 'Crown_Mesh'); data.from_pydata(vertices, [], faces); data.update(); data.materials.append(bpy.data.materials.get('SV3_Finish_Walnut') or mats['wood'])
    mesh = bmesh.new(); mesh.from_mesh(data)
    bmesh.ops.recalc_face_normals(mesh, faces=list(mesh.faces))
    mesh.to_mesh(data); mesh.free()
    crown = bpy.data.objects.new(PREFIX + 'Crown', data); scene.collection.objects.link(crown); crown.parent = room
    for polygon in data.polygons: polygon.use_smooth = True
    uv_component(crown, ship, 'timber')
    crown['structural_role'] = 'closed timber perimeter following the retained captain roof'
    crown['closed_perimeter'] = True
    return {'deck_top': 5.425, 'deck_bounds': [[-6.10, -18.12], [6.10, .12]], 'porthole': window_report, 'porthole_return': '192 samples to current clipped hull; missing rays bridge to surviving boundary', 'crown_corners': [list(p) for p in corners], 'crown_closed': True}
