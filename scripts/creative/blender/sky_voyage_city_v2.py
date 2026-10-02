"""Editable v2 city geometry chunk. Run after sky_voyage_common_v2.py, then call build_sky_voyage_city_v2().

The common chunk owns the scene, city root, axis conversion, materials, layout, and
source assets. This file owns only the SV2 city detail collection; it never saves,
exports, starts a Blender process, or edits the authoritative source-layout file.
"""
import json
import math


_SV2_C2_STATE = json.loads('{"target":null,"water":null,"routes":null,"rivers":null,"ponds":null}')
SV2_C2_PROFILE = json.loads('[[1.0,-2],[1.01,-13],[0.985,-44],[1.012,-66],[0.95,-120],[0.995,-141],[0.93,-210],[1.005,-230],[0.89,-305],[0.78,-365],[0.62,-410],[0.4,-452],[0.18,-478],[0.015,-492]]')
SV2_C2_ISLAND_RX = 900.0
SV2_C2_ISLAND_RZ = 640.0


def _sv2c2_collection():
    """Clear only this chunk's prior collection and parent a fresh one under SV2_City."""
    old = bpy.data.collections.get('SV2_CityChunkV2')
    if old is not None:
        for obj in list(old.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        for child in list(old.children):
            old.children.unlink(child)
        for owner in list(bpy.data.collections):
            if old.name in owner.children:
                owner.children.unlink(old)
        bpy.data.collections.remove(old)
    target = bpy.data.collections.new('SV2_CityChunkV2')
    CITY.children.link(target)
    for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.materials):
        for data in list(datablocks):
            if data.name.startswith('SV2_C2_') and data.users == 0:
                datablocks.remove(data)
    return target


def _sv2c2_mesh(name, vertices, faces, mats, face_materials=None,
                parent=None, smooth=False, uv=True):
    c2_target = _SV2_C2_STATE['target']
    return mesh_d(name, vertices, faces, mats, face_materials,
                  parent=parent or city, target=c2_target,
                  smooth=smooth, uv=uv)


def _sv2c2_batch_boxes(name, records, materials, parent=None):
    """Create disconnected beveled-looking but editable cuboids in one mesh."""
    vertices, faces, material_ids = [], [], []
    face_template = json.loads('[[0,3,2,1],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]]')
    for record in records:
        center, size = record[:2]
        mat_index = int(record[2]) if len(record) > 2 else 0
        yaw = float(record[3]) if len(record) > 3 else 0.0
        cx, cy, cz = center
        sx, sy, sz = (v * .5 for v in size)
        c, s = math.cos(yaw), math.sin(yaw)
        local = [(-sx, -sy, -sz), (sx, -sy, -sz),
                 (sx, sy, -sz), (-sx, sy, -sz),
                 (-sx, -sy, sz), (sx, -sy, sz),
                 (sx, sy, sz), (-sx, sy, sz)]
        base = len(vertices)
        for px, py, pz in local:
            vertices.append((cx + px * c + pz * s, cy + py,
                             cz - px * s + pz * c))
        faces.extend(tuple(base + index for index in face) for face in face_template)
        material_ids.extend([mat_index] * len(face_template))
    if not vertices:
        return None
    return _sv2c2_mesh(name, vertices, faces, materials, material_ids,
                       parent=parent, smooth=False)


def _sv2c2_curve(points, steps=14):
    """Sample a Catmull-Rom route, retaining exact shared layout endpoints."""
    if len(points) < 2:
        return [tuple(point) for point in points]
    sampled = []
    for index in range(len(points) - 1):
        p0 = points[max(0, index - 1)]
        p1 = points[index]
        p2 = points[index + 1]
        p3 = points[min(len(points) - 1, index + 2)]
        for step in range(steps):
            t = step / steps
            t2, t3 = t * t, t * t * t
            point = []
            for axis in range(3):
                point.append(.5 * ((2 * p1[axis]) + (-p0[axis] + p2[axis]) * t
                                   + (2 * p0[axis] - 5 * p1[axis] + 4 * p2[axis]
                                      - p3[axis]) * t2
                                   + (-p0[axis] + 3 * p1[axis] - 3 * p2[axis]
                                      + p3[axis]) * t3))
            sampled.append(tuple(point))
    sampled.append(tuple(points[-1]))
    return sampled


def _sv2c2_segment_nearest(x, z, points):
    best_d2, best_y = float('inf'), 0.0
    for a, b in zip(points, points[1:]):
        dx, dz = b[0] - a[0], b[2] - a[2]
        denom = dx * dx + dz * dz
        if denom < 1e-8:
            t = 0.0
        else:
            t = max(0.0, min(1.0, ((x - a[0]) * dx + (z - a[2]) * dz) / denom))
        qx, qz = a[0] + dx * t, a[2] + dz * t
        d2 = (x - qx) ** 2 + (z - qz) ** 2
        if d2 < best_d2:
            best_d2 = d2
            best_y = a[1] + (b[1] - a[1]) * t
    return math.sqrt(best_d2), best_y


def _sv2c2_base_height(x, z):
    radial = min(1.0, math.sqrt((x / SV2_C2_ISLAND_RX) ** 2
                                + (z / SV2_C2_ISLAND_RZ) ** 2))
    return (60.0 + 4.0 * (1.0 - radial) ** 1.45
            + 1.2 * math.sin(x / 185.0 + .25) * math.cos(z / 210.0)
            + .85 * math.sin(z / 118.0 + x / 330.0))


def _sv2c2_hydrology_depression(x, z, base):
    c2_ponds = _SV2_C2_STATE['ponds']
    c2_rivers = _SV2_C2_STATE['rivers']
    for pond in c2_ponds or ():
        cx, _, cz = pond['center']
        rx, rz = pond['size'][0] * .5 * 1.23, pond['size'][1] * .5 * 1.23
        r = math.sqrt(((x - cx) / rx) ** 2 + ((z - cz) / rz) ** 2)
        if r < 1.0:
            t = max(0.0, min(1.0, (1.0 - r) / .43))
            smooth = t * t * (3.0 - 2.0 * t)
            base -= pond['basinDepth'] * smooth
    for river in c2_rivers or ():
        distance, surface_y = _sv2c2_segment_nearest(x, z, river['_sampled'])
        bank_width = river['width'] * 2.2
        if distance < bank_width:
            t = max(0.0, min(1.0, 1.0 - distance / bank_width))
            smooth = t * t * (3.0 - 2.0 * t)
            bed_y = surface_y - river['depth']
            base -= max(0.0, base - bed_y) * smooth
    return base


def _sv2c2_terrain_height(x, z):
    c2_routes = _SV2_C2_STATE['routes']
    base = _sv2c2_base_height(x, z)
    best_weight, weighted_y, total_weight = 0.0, 0.0, 0.0
    for route in c2_routes or ():
        distance, route_y = _sv2c2_segment_nearest(x, z, route['_sampled'])
        reach = route['width'] * 1.6 + 16.0
        if distance >= reach:
            continue
        t = max(0.0, 1.0 - distance / reach)
        weight = t * t * (3.0 - 2.0 * t)
        if weight > best_weight:
            best_weight, weighted_y, total_weight = weight, route_y * weight, weight
        elif weight > 0 and abs(route_y - weighted_y / max(total_weight, 1e-8)) < 1.2:
            weighted_y += route_y * weight
            total_weight += weight
            best_weight = max(best_weight, weight)
    if total_weight > 0:
        road_grade = weighted_y / total_weight
        base = base * (1.0 - best_weight) + road_grade * best_weight
    return _sv2c2_hydrology_depression(x, z, base)


def _sv2c2_edge_wobble(theta):
    return 1.0 + .007 * math.sin(theta * 3.0 + .6) + .004 * math.cos(theta * 7.0 - .4)


def _sv2c2_build_main_island():
    c2_target = _SV2_C2_STATE['target']
    radial_steps, sides = 32, 256
    vertices = [(0.0, _sv2c2_terrain_height(0, 0), 0.0)]
    for ring in range(1, radial_steps + 1):
        radial = ring / radial_steps
        for index in range(sides):
            theta = math.tau * index / sides
            edge = _sv2c2_edge_wobble(theta)
            x = SV2_C2_ISLAND_RX * radial * edge * math.cos(theta)
            z = SV2_C2_ISLAND_RZ * radial * edge * math.sin(theta)
            vertices.append((x, _sv2c2_terrain_height(x, z), z))
    faces, mats = [], []
    first = 1
    for index in range(sides):
        faces.append((0, first + index, first + (index + 1) % sides))
        mats.append(0)
    for ring in range(1, radial_steps):
        inner = 1 + (ring - 1) * sides
        outer = 1 + ring * sides
        for index in range(sides):
            faces.append((inner + index, outer + index, outer + (index + 1) % sides,
                          inner + (index + 1) % sides))
            mats.append(1 if math.sin(index*.071+ring*.37)+math.cos(index*.043-ring*.21)>1.15 else 0)
    _sv2c2_mesh('SV2_C2_MainIsland_TopPlateau', vertices, faces,
                [M['grass'], M['grassLight']], mats, smooth=True)

    vertices, faces, mats = [], [], []
    for profile_index, (radial, drop) in enumerate(SV2_C2_PROFILE):
        for index in range(sides):
            theta = math.tau * index / sides
            edge = _sv2c2_edge_wobble(theta)
            x = SV2_C2_ISLAND_RX * radial * edge * math.cos(theta)
            z = SV2_C2_ISLAND_RZ * radial * edge * math.sin(theta)
            y = _sv2c2_terrain_height(x, z) + drop
            vertices.append((x, y, z))
    band_material = json.loads('[0,1,0,2,1,2,0,2,1,2,2,1,2]')
    for layer in range(len(SV2_C2_PROFILE) - 1):
        material_index = band_material[layer]
        for index in range(sides):
            a = layer * sides + index
            b = layer * sides + (index + 1) % sides
            c = (layer + 1) * sides + (index + 1) % sides
            d = (layer + 1) * sides + index
            faces.append((a, b, c, d))
            mats.append(material_index)
    bottom_index = len(vertices)
    vertices.append((0.0, 60.0 + SV2_C2_PROFILE[-1][1], 0.0))
    last = (len(SV2_C2_PROFILE) - 1) * sides
    for index in range(sides):
        faces.append((last + index, last + (index + 1) % sides, bottom_index))
        mats.append(2)
    rock = _sv2c2_mesh('SV2_C2_MainIsland_StratifiedCore', vertices, faces,
                       [M['rockLight'], M['rock'], M['rockDark']], mats,
                       smooth=False)
    rock['verticalReliefMetres'] = 492.0
    rock['profileDescription'] = 'layered cliff bands, recessed strata, broken ledges, tapered underside'

    for index, (drop, inner_r, outer_r) in enumerate(json.loads('[[92,0.944,1.012],[226,0.927,1.018],[338,0.842,0.997]]')):
        ledge_vertices = []
        for radial in (inner_r, outer_r):
            for side in range(sides):
                theta = math.tau * side / sides
                wobble = _sv2c2_edge_wobble(theta)
                x = SV2_C2_ISLAND_RX * radial * wobble * math.cos(theta)
                z = SV2_C2_ISLAND_RZ * radial * wobble * math.sin(theta)
                y = _sv2c2_terrain_height(x, z) - drop
                ledge_vertices.append((x, y, z))
        ledge_faces = [(side, (side + 1) % sides,
                        sides + (side + 1) % sides, sides + side)
                       for side in range(sides)]
        _sv2c2_mesh('SV2_C2_MainIsland_Ledge_%02d' % (index + 1),
                    ledge_vertices, ledge_faces,
                    [M['rockLight'], M['stoneShade']],
                    [int((side // 5) % 2) for side in range(sides)], smooth=False)

    for index in range(20):
        theta = math.tau * (index + .37) / 20.0
        start_drop = 45.0 + (index % 3) * 14.0
        end_drop = 390.0 + (index % 4) * 12.0
        points = []
        for step in range(13):
            t = step / 12
            drop = start_drop + (end_drop - start_drop) * t
            radial = _sv2c2_profile_radius(drop) * 1.004
            edge = _sv2c2_edge_wobble(theta)
            x = SV2_C2_ISLAND_RX * radial * edge * math.cos(theta)
            z = SV2_C2_ISLAND_RZ * radial * edge * math.sin(theta)
            points.append((x, _sv2c2_terrain_height(x, z) - drop, z))
        tube('SV2_C2_MainIsland_Fissure_%02d' % (index + 1), points,
             .32 if index % 4 else .58, M['rockDark'], city, c2_target, 6)


def _sv2c2_profile_radius(drop):
    for (ra, da), (rb, db) in zip(SV2_C2_PROFILE, SV2_C2_PROFILE[1:]):
        if da >= -drop >= db:
            t = (drop + da) / max(1e-6, da - db)
            return ra + (rb - ra) * t
    return SV2_C2_PROFILE[-1][0]


def _sv2c2_init_route_and_water_data():
    c2_routes, c2_ponds, c2_rivers, c2_water = [], [], [], []
    _SV2_C2_STATE.update({'routes': c2_routes, 'ponds': c2_ponds,
                         'rivers': c2_rivers, 'water': c2_water})
    for source in LAYOUT['city']['routes']:
        route = dict(source)
        route['_sampled'] = _sv2c2_curve(source['points'], 14)
        c2_routes.append(route)

    pond_specs = json.loads('[["west-rear-reflecting-pool",-370,-490,74,58,1.35,2.6,[0.36,0.12],0.07],["east-rear-reflecting-pool",370,-490,74,58,1.35,2.6,[-0.36,0.12],0.07],["west-formal-garden-pool",-300,60,68,50,1.1,2.6,[0.16,0.22],0.035],["east-formal-garden-pool",300,60,68,50,1.1,2.6,[-0.16,0.22],0.035]]')
    for name, x, z, width, length, water_offset, depth, flow, speed in pond_specs:
        base = _sv2c2_base_height(x, z)
        c2_ponds.append({
            'id': name,
            'center': [float(x), base - water_offset, float(z)],
            'size': [float(width), float(length)],
            'surfaceY': base - water_offset,
            'bedY': base - water_offset - depth,
            'basinDepth': depth + water_offset,
            'waterDepth': depth,
            'flowDirection': [float(flow[0]), float(flow[1])],
            'flowSpeed': speed,
        })

    river_specs = json.loads('[["west-falls-creek","west-rear-reflecting-pool",[[-370,-490],[-485,-544],[-610,-526],[-690,-406]],10.0,1.6,1.6],["east-falls-creek","east-rear-reflecting-pool",[[370,-490],[485,-544],[610,-526],[690,-406]],10.0,1.6,1.6]]')
    for name, source_pool_id, horizontal_points, width, depth, flow in river_specs:
        source_pool = next(pond for pond in c2_ponds
                           if pond['id'] == source_pool_id)
        start_y = source_pool['surfaceY']
        end_x, end_z = horizontal_points[-1]
        end_y = _sv2c2_base_height(end_x, end_z) - 2.6
        points = []
        for index, (x, z) in enumerate(horizontal_points):
            t = index / max(1, len(horizontal_points) - 1)
            points.append((x, start_y + (end_y - start_y) * t, z))
        sampled = _sv2c2_curve(points, 16)
        c2_rivers.append({
            'id': name, 'points': points, 'width': width, 'bedDepth': depth,
            'depth': depth, 'flow': flow,
            'sourcePoolId': source_pool_id,
            'direction': [points[-1][0] - points[0][0],
                          points[-1][2] - points[0][2]],
            '_sampled': sampled,
        })

    waterfalls = []
    angles = (.22, 1.95, 2.60, 3.30, 3.80, 4.45, 5.17, 5.59)
    for index, theta in enumerate(angles, 1):
        edge = _sv2c2_edge_wobble(theta)
        sx = SV2_C2_ISLAND_RX * edge * math.cos(theta)
        sz = SV2_C2_ISLAND_RZ * edge * math.sin(theta)
        sy = _sv2c2_base_height(sx, sz) - 2.6
        ex = sx * 1.036
        ez = sz * 1.036
        end_y = sy - (300.0 + (index % 3) * 24.0)
        waterfalls.append({
            'id': 'cliff-fall-%02d' % index,
            'from': [round(sx, 2), round(sy, 2), round(sz, 2)],
            'to': [round(ex, 2), round(end_y, 2), round(ez, 2)],
            'width': 10.0 if index % 3 else 14.0,
        })
    west_river = next(river for river in c2_rivers
                      if river['id'] == 'west-falls-creek')
    west_lip = next(fall for fall in waterfalls
                    if fall['id'] == 'cliff-fall-05')['from']
    west_river['points'][-1] = tuple(west_lip)
    west_river['direction'] = [west_river['points'][-1][0] - west_river['points'][0][0],
                               west_river['points'][-1][2] - west_river['points'][0][2]]
    west_river['_sampled'] = _sv2c2_curve(west_river['points'], 16)

    # River bed and runtime surface begin at the source pool's ellipse edge,
    # not at its center.  Locate that crossing on the already-smoothed path.
    for river in c2_rivers:
        source_pool = next(pond for pond in c2_ponds
                           if pond['id'] == river['sourcePoolId'])
        center_x, _, center_z = source_pool['center']
        radius_x, radius_z = (value * .5 for value in source_pool['size'])
        samples = river['_sampled']

        def pool_radius(point):
            return math.sqrt(((point[0] - center_x) / radius_x) ** 2
                             + ((point[2] - center_z) / radius_z) ** 2)

        exit_index = next((index for index, point in enumerate(samples)
                           if index > 0 and pool_radius(point) >= 1.0), None)
        if exit_index is not None:
            inside, outside = samples[exit_index - 1], samples[exit_index]
            low_t, high_t = 0.0, 1.0
            for _ in range(18):
                middle_t = (low_t + high_t) * .5
                middle = tuple(inside[axis] + (outside[axis] - inside[axis]) * middle_t
                               for axis in range(3))
                if pool_radius(middle) < 1.0:
                    low_t = middle_t
                else:
                    high_t = middle_t
            exit_point = tuple(inside[axis] + (outside[axis] - inside[axis]) * high_t
                               for axis in range(3))
            river['_sampled'] = [exit_point] + samples[exit_index:]
            river['direction'] = [river['_sampled'][-1][0] - exit_point[0],
                                  river['_sampled'][-1][2] - exit_point[2]]

    c2_water.clear()
    c2_water.extend({'kind': 'pool', 'id': pond['id'],
                        'center': [round(v, 3) for v in pond['center']],
                        'size': pond['size'], 'depth': pond['waterDepth']}
                       for pond in c2_ponds)
    c2_water.extend({'kind': 'river', 'id': river['id'],
                        'points': [[round(v, 3) for v in point]
                                   for point in river['_sampled']],
                        'width': river['width'], 'depth': river['depth'],
                        'flow': river['flow']}
                       for river in c2_rivers)
    c2_water.extend({'kind': 'fall', 'id': fall['id'],
                        'from': fall['from'], 'to': fall['to'],
                        'width': fall['width']}
                       for fall in waterfalls)
    return waterfalls


def _sv2c2_build_water_beds(waterfalls):
    """Build only pool rims, riverbeds and waterfall lips; water surfaces remain runtime-owned."""
    ponds, rivers = _SV2_C2_STATE['ponds'], _SV2_C2_STATE['rivers']
    target = _SV2_C2_STATE['target']
    for pond in ponds:
        x, y, z = pond['center']
        rx, rz = (v * .5 for v in pond['size'])
        ring_vertices = []
        ring_radii = (1.04, 1.13, 1.23)
        for index in range(40):
            angle = math.tau * index / 40
            samples = []
            for radial in ring_radii:
                px = x + rx * radial * math.cos(angle)
                pz = z + rz * radial * math.sin(angle)
                samples.append((px, _sv2c2_terrain_height(px, pz), pz))
            inner_y = max(samples[0][1] + .015, pond['surfaceY'] + .25)
            outer_y = samples[2][1] + .015
            middle_y = max(samples[1][1] + .015, (inner_y + outer_y) * .5)
            ring_vertices.extend(((samples[0][0], inner_y, samples[0][2]),
                                  (samples[1][0], middle_y, samples[1][2]),
                                  (samples[2][0], outer_y, samples[2][2])))
        ring = [ring_vertices[row * 3 + column]
                for column in range(3) for row in range(40)]
        ring_faces = []
        for band in range(2):
            inner_start, outer_start = band * 40, (band + 1) * 40
            ring_faces.extend((inner_start + index,
                               inner_start + (index + 1) % 40,
                               outer_start + (index + 1) % 40,
                               outer_start + index) for index in range(40))
        rim = _sv2c2_mesh('SV2_C2_WaterBank_' + pond['id'], ring,
                           ring_faces,
                           [M['stoneBright'], M['gold']], smooth=False)
        rim['waterBodyId'] = pond['id']
        anchor('SV2_WaterBody_' + pond['id'], pond['center'], city, target)['waterRole'] = 'runtime-surface-body'

    for river in rivers:
        points = river['_sampled']
        vertices = []
        cross_sections = (-1.0, -.5, 0.0, .5, 1.0)
        for i, point in enumerate(points):
            a, b = points[max(0, i - 1)], points[min(i + 1, len(points) - 1)]
            dx, dz = b[0] - a[0], b[2] - a[2]
            length = max(.001, math.hypot(dx, dz))
            for side in cross_sections:
                x = point[0] - dz / length * river['width'] * side
                z = point[2] + dx / length * river['width'] * side
                y = point[1] - river['depth'] if side == 0 else point[1] + .25
                vertices.append((x, y, z))
        faces = [(i * len(cross_sections) + j,
                  i * len(cross_sections) + j + 1,
                  (i + 1) * len(cross_sections) + j + 1,
                  (i + 1) * len(cross_sections) + j)
                 for i in range(len(points) - 1)
                 for j in range(len(cross_sections) - 1)]
        face_materials = [1 if column in (0, len(cross_sections) - 2) else 0
                          for _ in range(len(points) - 1)
                          for column in range(len(cross_sections) - 1)]
        bed = _sv2c2_mesh('SV2_C2_WaterBed_' + river['id'], vertices, faces,
                          [M['rockDark'], M['rock']], face_materials,
                          smooth=False)
        bed['waterChannelId'] = river['id']
        bed['bankFreeboardMetres'] = .25
        bed['runtimeWaterWidthMetres'] = river['width']
        anchor('SV2_WaterChannel_' + river['id'], points[0], city, target)['waterRole'] = 'runtime-flow-path'

    for fall in waterfalls:
        start, end = fall['from'], fall['to']
        cylinder('SV2_C2_WaterfallLip_' + fall['id'], (start[0], start[1] - .6, start[2]),
                 fall['width'] * .78, 1.2, M['rockLight'], city, target, 28)
        anchor('SV2_WaterfallStart_' + fall['id'], start, city, target)['waterRole'] = 'runtime-waterfall-source'
        anchor('SV2_WaterfallEnd_' + fall['id'], end, city, target)['waterRole'] = 'runtime-waterfall-landing'

def _sv2c2_build_roads():
    c2_routes = _SV2_C2_STATE['routes']
    for route in c2_routes:
        points = route['_sampled']
        width = float(route['width'])
        offsets = (-.5, -.43, -.08, .08, .43, .5)
        vertices, faces, material_ids = [], [], []
        lower_sections = []
        for index, point in enumerate(points):
            prev_point = points[max(0, index - 1)]
            next_point = points[min(len(points) - 1, index + 1)]
            dx, dz = next_point[0] - prev_point[0], next_point[2] - prev_point[2]
            length = max(.001, math.hypot(dx, dz))
            side_x, side_z = -dz / length, dx / length
            ground_l, ground_r = None, None
            for column, offset in enumerate(offsets):
                x = point[0] + side_x * width * offset
                z = point[2] + side_z * width * offset
                ground = _sv2c2_terrain_height(x, z)
                grade = point[1] + .34
                edge_t = abs(offset) * 2.0
                y = grade * (1.0 - .16 * edge_t) + (ground + .18) * (.16 * edge_t)
                vertices.append((x, y, z))
                if column == 0:
                    ground_l = ground
                elif column == len(offsets) - 1:
                    ground_r = ground
            top_left, top_right = vertices[-len(offsets)], vertices[-1]
            lower_sections.append((
                top_left, (top_left[0], ground_l - .35, top_left[2]),
                top_right, (top_right[0], ground_r - .35, top_right[2])))
            if index:
                prior = [(index - 1) * len(offsets) + i for i in range(len(offsets))]
                for column in range(len(offsets) - 1):
                    faces.append((prior[column], prior[column + 1],
                                  index * len(offsets) + column + 1,
                                  index * len(offsets) + column))
                    material_ids.append(1 if column in (1, 3) else 0)
        route_key = route['id'].replace('-', '_')
        road = _sv2c2_mesh('SV2_C2_Route_' + route_key, vertices, faces,
                           [M['stoneBright'], M['stone']], material_ids,
                           smooth=False)
        road['layoutRouteId'] = route['id']
        road['layoutFrom'] = route['from']
        road['layoutTo'] = route['to']
        road['layoutWidthMetres'] = width
        road['presentationOnly'] = True
        road['sourceLayoutPoints'] = json.dumps(route['points'])
        if len(lower_sections) > 1:
            lower_vertices, lower_faces = [], []
            for index, section in enumerate(lower_sections):
                lower_vertices.extend(section)
                if index:
                    previous, current = (index - 1) * 4, index * 4
                    lower_faces.extend(((previous, previous + 1,
                                         current + 1, current),
                                        (previous + 2, current + 2,
                                         current + 3, previous + 3)))
            foundation = _sv2c2_mesh('SV2_C2_RouteFoundation_' + route_key,
                                     lower_vertices, lower_faces,
                                     M['stoneShade'], smooth=False)
            foundation['supportsLayoutRouteId'] = route['id']
            foundation['presentationOnly'] = True


def _sv2c2_ring_roof(name, center, hx, hz, base_y, height, materials=None):
    """French mansard roof with two broken slopes and a clipped ridge."""
    mats = materials or [M['roof'], M['roofLight']]
    cx, _, cz = center
    rings = [
        (1.0, 1.0, base_y),
        (.76, .74, base_y + height * .58),
        (.34, .31, base_y + height),
    ]
    vertices = []
    for sx, sz, y in rings:
        vertices.extend(((cx - hx * sx, y, cz - hz * sz),
                         (cx + hx * sx, y, cz - hz * sz),
                         (cx + hx * sx, y, cz + hz * sz),
                         (cx - hx * sx, y, cz + hz * sz)))
    faces, material_ids = [], []
    for ring in range(2):
        lo, hi = ring * 4, (ring + 1) * 4
        for side in range(4):
            faces.append((lo + side, lo + (side + 1) % 4,
                          hi + (side + 1) % 4, hi + side))
            material_ids.append(ring)
    faces.append((8, 9, 10, 11))
    material_ids.append(1)
    roof = _sv2c2_mesh(name, vertices, faces, mats, material_ids, smooth=False)
    roof['roofStyle'] = 'two-stage French mansard with gilded seams'
    seams = []
    for side in range(4):
        lo, hi = rings[0], rings[1]
        c0 = (cx - hx * (1 if side in (0, 3) else -1), base_y,
              cz - hz * (1 if side in (0, 1) else -1))
        c1 = (cx - hx * (.76 if side in (0, 3) else -.76), base_y + height * .58,
              cz - hz * (.74 if side in (0, 1) else -.74))
        c2 = (cx - hx * (.34 if side in (0, 3) else -.34), base_y + height,
              cz - hz * (.31 if side in (0, 1) else -.31))
        seams.append((c0, c1, c2))
    _sv2c2_tube_batch(name + '_GiltSeams', seams, .14, M['goldLight'], 6)
    return roof


def _sv2c2_tube_batch(name, paths, radius, mat, sides=8):
    c2_target = _SV2_C2_STATE['target']
    vertices, faces = [], []
    for path in paths:
        points = [Vector(d_to_b(point)) for point in path]
        if len(points) < 2:
            continue
        base = len(vertices)
        for index, point in enumerate(points):
            tangent = points[min(index + 1, len(points) - 1)] - points[max(index - 1, 0)]
            if tangent.length < 1e-6:
                tangent = Vector((0, 0, 1))
            tangent.normalize()
            ref = Vector((0, 0, 1)) if abs(tangent.z) < .9 else Vector((0, 1, 0))
            u = tangent.cross(ref).normalized()
            v = tangent.cross(u).normalized()
            for side in range(sides):
                theta = math.tau * side / sides
                p = point + radius * (math.cos(theta) * u + math.sin(theta) * v)
                vertices.append(tuple(p))
        for segment in range(len(points) - 1):
            for side in range(sides):
                a = base + segment * sides + side
                b = base + segment * sides + (side + 1) % sides
                c = base + (segment + 1) * sides + (side + 1) % sides
                d = base + (segment + 1) * sides + side
                faces.append((a, b, c, d))
    if not vertices:
        return None
    obj = mesh_b(name, vertices, faces, mat, parent=city,
                 target=c2_target, smooth=True)
    return obj


def _sv2c2_arch_outline(cx, base_y, width, height):
    radius = width * .5
    spring = base_y + height - radius
    points = [(-radius, 0.0), (radius, 0.0), (radius, spring - base_y)]
    for step in range(1, 13):
        theta = math.pi * step / 12.0
        points.append((radius * math.cos(theta), spring - base_y + radius * math.sin(theta)))
    points.append((-radius, 0.0))
    return [(cx + x, base_y + y) for x, y in points]


def _sv2c2_arch_windows(name, specs, axis, face, facing=1):
    """Batch Gothic/Beaux-Arts arched panes and nested frame rings onto one facade."""
    glass_vertices, glass_faces = [], []
    frame_vertices, frame_faces = [], []
    mullions = []
    for spec in specs:
        u, base_y, width, height = spec
        outer = _sv2c2_arch_outline(u, base_y, width, height)
        inset = max(.12, width * .105)
        inner = _sv2c2_arch_outline(u, base_y + inset, width - inset * 2,
                                    height - inset * 1.35)
        count = min(len(outer), len(inner))
        outer, inner = outer[:count], inner[:count]

        def position(horizontal, vertical, depth):
            if axis == 'z':
                return (horizontal, vertical, face + facing * depth)
            return (face + facing * depth, vertical, horizontal)

        pane_offset = len(glass_vertices)
        glass_vertices.extend(position(u0, y0, .045) for u0, y0 in inner)
        glass_faces.append(tuple(range(pane_offset, pane_offset + count)))
        frame_offset = len(frame_vertices)
        frame_vertices.extend(position(u0, y0, .12) for u0, y0 in outer)
        frame_vertices.extend(position(u0, y0, .125) for u0, y0 in inner)
        for index in range(count - 1):
            frame_faces.append((frame_offset + index, frame_offset + index + 1,
                                frame_offset + count + index + 1,
                                frame_offset + count + index))
        frame_faces.append((frame_offset + count - 1, frame_offset,
                            frame_offset + count, frame_offset + count * 2 - 1))
        if axis == 'z':
            mullions.extend((
                ((u, base_y + height * .49, face + facing * .16),
                 (.09, height * .76, .10), 0),
                ((u, base_y + height * .34, face + facing * .18),
                 (width * .68, .085, .10), 0),
            ))
        else:
            mullions.extend((
                ((face + facing * .16, base_y + height * .49, u),
                 (.10, height * .76, .09), 0),
                ((face + facing * .18, base_y + height * .34, u),
                 (.10, .085, width * .68), 0),
            ))
    if glass_vertices:
        glass = _sv2c2_mesh(name + '_Glass', glass_vertices, glass_faces,
                            M['glass'], smooth=False)
        glass['windowStyle'] = 'tall arch, human-scale repeated openings'
    if frame_vertices:
        frame = _sv2c2_mesh(name + '_IvoryGoldFrames', frame_vertices, frame_faces,
                            M['gold'], smooth=False)
        frame['windowStyle'] = 'individual raised arch surrounds'
    _sv2c2_batch_boxes(name + '_Mullions', mullions,
                       [M['goldLight']], parent=city)


def _sv2c2_dome(name, x, base_y, z, radius, height, mat=None, ribs=12):
    c2_target = _SV2_C2_STATE['target']
    mat = mat or M['roofLight']
    segments, profile = 32, json.loads('[[1.0,0.0],[0.96,0.13],[0.85,0.31],[0.68,0.53],[0.47,0.73],[0.25,0.89],[0.06,0.99]]')
    vertices = []
    for radial, lift in profile:
        for index in range(segments):
            angle = math.tau * index / segments
            vertices.append((x + radius * radial * math.cos(angle),
                             base_y + height * lift,
                             z + radius * radial * math.sin(angle)))
    faces = []
    for ring in range(len(profile) - 1):
        for index in range(segments):
            a = ring * segments + index
            b = ring * segments + (index + 1) % segments
            c = (ring + 1) * segments + (index + 1) % segments
            d = (ring + 1) * segments + index
            faces.append((a, b, c, d))
    cap_index = len(vertices)
    vertices.append((x, base_y + height, z))
    last = (len(profile) - 1) * segments
    for index in range(segments):
        faces.append((last + index, last + (index + 1) % segments, cap_index))
    dome = _sv2c2_mesh(name, vertices, faces, mat, smooth=True)
    dome['domeStyle'] = 'ribbed French fairy-tale cupola'
    paths = []
    for index in range(ribs):
        theta = math.tau * index / ribs
        paths.append([(x + radius * radial * math.cos(theta),
                       base_y + height * lift + .08,
                       z + radius * radial * math.sin(theta))
                      for radial, lift in profile])
    _sv2c2_tube_batch(name + '_ChampagneRibs', paths,
                      max(.13, radius * .012), M['goldLight'], 6)
    cylinder(name + '_LanternDrum', (x, base_y + .45, z),
             radius * 1.03, .9, M['stoneBright'], city, c2_target, 32,
             top_radius=radius * .97)
    cylinder(name + '_FinialStem', (x, base_y + height + 1.4, z),
             max(.45, radius * .055), 2.8, M['gold'], city, c2_target,
             12, top_radius=.09)
    return dome


def _sv2c2_castle_tower(name, x, z, base_y, radius, shaft_height,
                        crown_height, teal=True, window_count=4):
    c2_target = _SV2_C2_STATE['target']
    roof_mat = M['roofLight'] if teal else M['roof']
    cylinder(name + '_TieredFoot', (x, base_y + 1.2, z), radius * 1.42,
             2.4, M['stoneShade'], city, c2_target, 28,
             top_radius=radius * 1.34)
    cylinder(name + '_GiltFootBand', (x, base_y + 2.55, z), radius * 1.39,
             .34, M['gold'], city, c2_target, 28)
    cylinder(name + '_PorcelainShaft', (x, base_y + 2.6 + shaft_height * .5, z),
             radius, shaft_height, M['stoneBright'], city, c2_target, 24,
             top_radius=radius * .84)
    for fraction in (.27, .52, .76, .93):
        y = base_y + 2.6 + shaft_height * fraction
        cylinder(name + '_Belt_%02d' % int(fraction * 100), (x, y, z),
                 radius * (1.04 - .12 * fraction), .42, M['stone'],
                 city, c2_target, 24)
        cylinder(name + '_GiltBelt_%02d' % int(fraction * 100), (x, y + .24, z),
                 radius * (1.045 - .12 * fraction), .12, M['goldLight'],
                 city, c2_target, 24)
    crown_y = base_y + 2.6 + shaft_height
    cylinder(name + '_CrownDeck', (x, crown_y + 1.1, z), radius * 1.2,
             2.2, M['stoneBright'], city, c2_target, 24)
    cylinder(name + '_CrownGilt', (x, crown_y + 2.25, z), radius * 1.22,
             .25, M['goldLight'], city, c2_target, 24)
    for index in range(window_count):
        y = base_y + 9.0 + (shaft_height - 24.0) * (index + .5) / window_count
        box(name + '_Lancet_%02d' % index,
            (x, y, z + radius * .87),
            (max(.72, radius * .24), min(3.8, shaft_height / (window_count + 1)), .16),
            M['glass'], city, c2_target, .07)
        box(name + '_LancetGilt_%02d' % index,
            (x, y, z + radius * .99),
            (.11, min(3.6, shaft_height / (window_count + 1)), .08),
            M['goldLight'], city, c2_target, .025)
    dome_height = crown_height
    _sv2c2_dome(name + '_TurquoiseCupola', x, crown_y + 2.45, z,
                 radius * 1.08, dome_height, roof_mat, 10)
    cylinder(name + '_GoldNeedle', (x, crown_y + 2.45 + dome_height + 2.4, z),
             .34, 4.8, M['goldLight'], city, c2_target, 12,
             top_radius=.045)


def _sv2c2_pediment(name, cx, base_y, z, half_width, height, mat):
    vertices = [(cx - half_width, base_y, z), (cx + half_width, base_y, z),
                (cx, base_y + height, z)]
    obj = _sv2c2_mesh(name, vertices, json.loads('[[0,1,2]]'), mat, smooth=False)
    _sv2c2_tube_batch(name + '_GoldMoulding', [[vertices[0], vertices[2], vertices[1]]],
                      .24, M['goldLight'], 8)
    return obj


def _sv2c2_build_palace():
    # A 450 x 300 m Beaux-Arts palace district; all doors, panes and steps retain human scale.
    c2_target = _SV2_C2_STATE['target']
    box('SV2_C2_PalaceFoundation', (0, 82, -180), (450, 5.0, 300),
        M['stoneShade'], city, c2_target, 1.8)
    box('SV2_C2_PalaceTerrace', (0, 85.1, -180), (444, 1.8, 294),
        M['stoneBright'], city, c2_target, .8)
    box('SV2_C2_PalaceGiltTerraceBand', (0, 86.1, -180), (447, .20, 296),
        M['goldLight'], city, c2_target, .08)

    # West and east wings frame a tall central reception block.
    box('SV2_C2_PalaceWestWing', (-142, 99.0, -198), (154, 31.0, 175),
        M['stoneBright'], city, c2_target, .42)
    box('SV2_C2_PalaceEastWing', (142, 99.0, -198), (154, 31.0, 175),
        M['stoneBright'], city, c2_target, .42)
    box('SV2_C2_PalaceCentralHall', (0, 105.5, -198), (154, 44.0, 138),
        M['stoneBright'], city, c2_target, .55)
    box('SV2_C2_PalaceCentralPianoNobile', (0, 149.5, -202), (102, 22.0, 92),
        M['stoneBright'], city, c2_target, .50)
    box('SV2_C2_PalaceRearChapel', (0, 102.0, -291), (134, 35.0, 62),
        M['stone'], city, c2_target, .48)
    for name, center, size in json.loads('[["West",[-142,84.0,-198],[157,1.1,178]],["East",[142,84.0,-198],[157,1.1,178]],["Central",[0,84.0,-198],[158,1.1,141]],["Rear",[0,84.0,-291],[138,1.1,65]]]'):
        box('SV2_C2_Palace' + name + 'GiltBase', center, size, M['gold'],
            city, c2_target, .20)

    for name, center, half_w, half_d, base, height in json.loads('[["WestWing",[-142,0,-198],77,87,115.2,26],["EastWing",[142,0,-198],77,87,115.2,26],["CentralHall",[0,0,-198],78,70,128.0,33],["PianoNobile",[0,0,-202],53,48,161.0,24],["RearChapel",[0,0,-291],68,34,119.8,24]]'):
        _sv2c2_ring_roof('SV2_C2_Palace' + name + 'Mansard',
                          (center[0], base, center[2]), half_w, half_d,
                          base, height,
                          [M['roof'], M['roofLight']] if 'Central' in name
                          or 'Piano' in name else [M['roof'], M['roof']])

    # Three upper pavilions and their small teal domes build the palace skyline.
    for index, x in enumerate((-142, 0, 142)):
        width = 66 if x == 0 else 61
        depth = 66 if x == 0 else 62
        z = -198 if x else -203
        base_y = 142 if x else 161
        height = 21 if x else 15
        box('SV2_C2_PalaceUpperPavilion_%02d' % index,
            (x, base_y + height * .5, z), (width, height, depth),
            M['stoneBright'], city, c2_target, .40)
        box('SV2_C2_PalacePavilionCornice_%02d' % index,
            (x, base_y + height, z), (width + 2.6, .62, depth + 2.6),
            M['goldLight'], city, c2_target, .20)
        roof_base = base_y + height + .4
        _sv2c2_ring_roof('SV2_C2_PalacePavilionRoof_%02d' % index,
                          (x, roof_base, z), width * .5 + 1.3,
                          depth * .5 + 1.3, roof_base, 14 if x else 10,
                          [M['roofLight'], M['roof']])
        _sv2c2_dome('SV2_C2_PalacePavilionDome_%02d' % index,
                    x, roof_base + (14 if x else 10), z,
                    12 if x else 25, 21 if x else 33,
                    M['roofLight'], 12)

    # Human-scale window rows, glazing, mouldings and a ceremonial arched entry.
    central_front = -129.0
    wing_front = -110.5
    rear_back = -322.0
    central_windows = []
    for y in (89.0, 103.0, 116.0):
        central_windows.extend((x, y, 2.3, 5.0)
                               for x in range(-63, 64, 14))
    _sv2c2_arch_windows('SV2_C2_PalaceCentralFacade', central_windows,
                        'z', central_front, 1)
    for side, center_x in json.loads('[["West",-142],["East",142]]'):
        wing_windows = []
        for y in (89.0, 103.0):
            wing_windows.extend((x, y, 2.1, 4.7)
                                for x in range(int(center_x - 65),
                                               int(center_x + 66), 13))
        _sv2c2_arch_windows('SV2_C2_Palace' + side + 'Facade', wing_windows,
                            'z', wing_front, 1)
    rear_windows = [(x, y, 2.0, 4.5)
                    for y in (90.0, 104.0)
                    for x in range(-54, 55, 13)]
    _sv2c2_arch_windows('SV2_C2_PalaceRearChapelFacade', rear_windows,
                        'z', rear_back, -1)

    side_windows = []
    for sign in (-1, 1):
        face = sign * 219.0
        rows = [(z, y, 2.0, 4.8) for y in (89.0, 103.0)
                for z in range(-268, -125, 20)]
        _sv2c2_arch_windows('SV2_C2_PalaceSideFacade_' + ('West' if sign < 0 else 'East'),
                            rows, 'x', face, sign)

    # Monumental portico and a broad, gently rising ceremonial stair.
    portico_z = -106.0
    column_xs = [float(x) for x in range(-80, 81, 16)]
    column_records = []
    for x in column_xs:
        cylinder('SV2_C2_PorticoColumnBase_%03d' % int(x),
                 (x, 86.8, portico_z), .92, 1.4, M['stone'],
                 city, c2_target, 20)
        cylinder('SV2_C2_PorticoColumnShaft_%03d' % int(x),
                 (x, 92.3, portico_z), .56, 10.2, M['stoneBright'],
                 city, c2_target, 20, top_radius=.50)
        cylinder('SV2_C2_PorticoColumnCapital_%03d' % int(x),
                 (x, 97.6, portico_z), .92, 1.05, M['goldLight'],
                 city, c2_target, 20)
    box('SV2_C2_PorticoEntablature', (0, 99.1, portico_z), (176, 2.0, 15),
        M['stone'], city, c2_target, .35)
    box('SV2_C2_PorticoGiltCornice', (0, 100.3, portico_z + .15), (179, .48, 15.6),
        M['goldLight'], city, c2_target, .18)
    _sv2c2_pediment('SV2_C2_PalacePorticoPediment', 0, 100.5,
                    portico_z + 7.7, 84, 17, M['stoneBright'])
    arch_paths = []
    for left, right in zip(column_xs, column_xs[1:]):
        middle, radius = (left + right) * .5, (right - left) * .5
        arch_paths.append([(left, 97.8, portico_z + .2),
                           (left, 100.0, portico_z + .2),
                           (middle - radius * .70, 103.0, portico_z + .2),
                           (middle, 104.7, portico_z + .2),
                           (middle + radius * .70, 103.0, portico_z + .2),
                           (right, 100.0, portico_z + .2),
                           (right, 97.8, portico_z + .2)])
    _sv2c2_tube_batch('SV2_C2_PorticoArcadeVoussoirs', arch_paths,
                      .38, M['stoneBright'], 8)
    steps = []
    for index in range(31):
        y = 80.25 + index * .245
        z = -80.0 - index * .86
        steps.append(((0, y, z), (52, .50, 1.02), 0))
    _sv2c2_batch_boxes('SV2_C2_PalaceProcessionalStair', steps,
                       [M['stoneBright']])
    box('SV2_C2_PalaceStairUpperLanding', (0, 87.8, -108), (58, 1.0, 8),
        M['stone'], city, c2_target, .25)
    entry = json.loads('[[0,88.0,4.6,7.2]]')
    _sv2c2_arch_windows('SV2_C2_PalaceRoyalEntry', entry, 'z', -128.8, 1)
    box('SV2_C2_PalaceDoorLeaf', (0, 91.6, -128.65), (3.2, 7.0, .20),
        M['green'], city, c2_target, .32)
    box('SV2_C2_PalaceDoorGiltSeam', (0, 91.6, -128.49), (.12, 6.4, .08),
        M['goldLight'], city, c2_target, .025)

    # Six roofline towers around the ceremonial hall and a 350 m central crown.
    _sv2c2_castle_tower('SV2_C2_PalaceCrownTower', 0, -198, 123,
                        13.0, 172.0, 33.0, True, 6)
    towers = json.loads('[[-204,-111,82,7.0,121,20],[204,-111,82,7.0,121,20],[-204,-282,82,8.5,153,23],[204,-282,82,8.5,153,23],[-68,-193,157,6.0,82,17],[68,-193,157,6.0,82,17]]')
    for index, (x, z, base, radius, shaft, dome) in enumerate(towers, 1):
        _sv2c2_castle_tower('SV2_C2_PalaceTurret_%02d' % index,
                            x, z, base, radius, shaft, dome,
                            teal=index % 2 == 0, window_count=4)

    # Four garden loggias, courts and gated walks prevent the palace from filling the island.
    for sign, side in json.loads('[[-1,"West"],[1,"East"]]'):
        col_x = sign * 306
        loggia_z = -40
        box('SV2_C2_' + side + 'GardenLoggiaFloor',
            (col_x, 61.5, loggia_z), (74, 1.5, 32), M['stoneBright'],
            city, c2_target, .40)
        for index in range(7):
            x = col_x - 32 + index * 10.7
            cylinder('SV2_C2_' + side + 'LoggiaPillar_%02d' % index,
                     (x, 66.1, loggia_z), .43, 8.5, M['stoneBright'],
                     city, c2_target, 16, top_radius=.37)
        box('SV2_C2_' + side + 'GardenLoggiaRoof',
            (col_x, 70.7, loggia_z), (78, 1.1, 36), M['roofLight'],
            city, c2_target, .28)
        for dz in (-28, 28):
            box('SV2_C2_' + side + 'GardenParterreBorder_' + str(dz),
                (sign * 364, 61.0, dz), (48, .8, 4), M['stone'],
                city, c2_target, .2)


def _sv2c2_build_plazas_and_lamps():
    # Arrival court and plaza remain aligned to the exact authored layout nodes.
    c2_routes = _SV2_C2_STATE['routes']
    c2_target = _SV2_C2_STATE['target']
    for name, center, size in json.loads('[["ArrivalDock",[0,60.6,520],[126,1.2,62]],["SkyHarborPlaza",[0,62.6,250],[148,1.2,116]],["PalaceForecourt",[0,80.35,-80],[138,0.7,76]]]'):
        box('SV2_C2_' + name + '_Paving', center, size,
            M['stoneBright'], city, c2_target, 1.1)
        box('SV2_C2_' + name + '_GoldInlay',
            (center[0], center[1] + .64, center[2]),
            (size[0] - 5, .08, size[2] - 5), M['goldLight'],
            city, c2_target, .2)
        box('SV2_C2_' + name + '_InnerStone',
            (center[0], center[1] + .69, center[2]),
            (size[0] - 8, .08, size[2] - 8), M['stone'],
            city, c2_target, .22)

    # A gently curved promenade materializes the harbour approach without changing its nodes.
    for side in (-1, 1):
        pillar_x = side * 49
        cylinder('SV2_C2_DockBeaconBase_' + str(side),
                 (pillar_x, 64.5, 545), 3.1, 7.8, M['stoneBright'],
                 city, c2_target, 20, top_radius=2.4)
        cylinder('SV2_C2_DockBeaconGilt_' + str(side),
                 (pillar_x, 68.3, 545), 2.6, .35, M['goldLight'],
                 city, c2_target, 20)
        _sv2c2_dome('SV2_C2_DockBeaconCupola_' + str(side), pillar_x,
                    68.7, 545, 2.3, 4.2, M['roofLight'], 8)

    lamps = []
    for route in c2_routes:
        for index, point in enumerate(route['_sampled'][3:-3:7]):
            offset = -2.5 if index % 2 else 2.5
            lamps.extend((((point[0] + offset, point[1] + 3.8, point[2]),
                           (.62, 7.6, .62), 0),
                          ((point[0] + offset, point[1] + 7.6, point[2]),
                           (1.8, .62, 1.8), 1)))
    _sv2c2_batch_boxes('SV2_C2_RouteLanternPostsAndHoods', lamps,
                       [M['gold'], M['stoneBright']])


def _sv2c2_build_villas():
    c2_target = _SV2_C2_STATE['target']
    specs = json.loads('[[-548,61,230,24,19,13],[-365,61,204,27,20,14],[-558,66,84,21,19,12],[-492,64,-8,25,21,14],[-360,62,-33,24,20,12],[-700,68,110,22,18,13],[548,61,230,24,19,13],[365,61,204,27,20,14],[558,66,84,21,19,12],[492,64,-8,25,21,14],[360,62,-33,24,20,12],[700,68,110,22,18,13]]')
    for index, (x, y, z, width, depth, height) in enumerate(specs, 1):
        body_y = y + height * .5
        box('SV2_C2_GardenVilla_%02d_Body' % index,
            (x, body_y, z), (width, height, depth),
            M['stoneBright'] if index % 3 else M['stone'], city, c2_target, .32)
        box('SV2_C2_GardenVilla_%02d_BaseBand' % index,
            (x, y + 1.4, z), (width + 1.2, .7, depth + 1.0),
            M['goldLight'], city, c2_target, .16)
        roof_height = 7.0 if height > 12 else 5.8
        _sv2c2_ring_roof('SV2_C2_GardenVilla_%02d_Mansard' % index,
                          (x, y + height, z), width * .56, depth * .56,
                          y + height, roof_height,
                          [M['roofLight'], M['roof']])
        count = max(2, int(width // 8))
        windows = [(x - width * .35 + i * width * .7 / (count - 1),
                    y + 3.0, 1.5, 3.1) for i in range(count)]
        _sv2c2_arch_windows('SV2_C2_GardenVilla_%02d_Front' % index,
                            windows, 'z', z + depth * .5 + .04, 1)
        if index % 3 == 0:
            _sv2c2_castle_tower('SV2_C2_GardenVilla_%02d_LanternTurret' % index,
                                x, z, y + height + roof_height, 2.2, 10, 4.6,
                                teal=True, window_count=1)


def _sv2c2_satellite_island(name, x, y, z, rx, rz, depth, seed):
    c2_target = _SV2_C2_STATE['target']
    object_name = 'SV2_C2_' + name
    saved_rng = rng.getstate()
    try:
        rng.seed(seed)
        before = set(bpy.data.objects)
        island(object_name, x, y, z, rx, rz, depth, city)
    finally:
        rng.setstate(saved_rng)
    for obj in (item for item in bpy.data.objects if item not in before):
        for linked in list(obj.users_collection):
            if linked == CITY:
                linked.objects.unlink(obj)
        c2_target.objects.link(obj)
        obj['islandGroup'] = name.split('_')[0]
        obj['islandTopY'] = y
    return {'name': name, 'x': x, 'y': y, 'z': z,
            'rx': rx, 'rz': rz, 'depth': depth}

def _sv2c2_build_skybridge(name, start, end, width, rise):
    """Use the shared arched-span builder; this remains visual, not server navigation."""
    c2_target = _SV2_C2_STATE['target']
    arch_bridge(name, start, end, width, rise, city, c2_target)
    deck = bpy.data.objects.get(name + '_Walk')
    deck['presentationOnly'] = True
    deck['navigationClaim'] = 'visual floating span only; authoritative path remains separately defined'
    deck['endpointsDesign'] = json.dumps([list(start), list(end)])
    return deck

def _sv2c2_import_kenney_module(filename, object_name, scale, position,
                                mat, rotation=0.0):
    c2_target = _SV2_C2_STATE['target']
    path = (ROOT + '/resources/scenes/sky-voyage-v2/vendor/castle/modules/'
            + filename)
    obj = import_joined(path, object_name, c2_target, city, True)
    obj.name = object_name
    obj.data.name = object_name + '_MeshData'
    if len(obj.data.materials):
        obj.data.materials.clear()
    obj.data.materials.append(mat)
    for polygon in obj.data.polygons:
        polygon.material_index = 0
    obj.location = d_to_b(position)
    obj.scale = (scale, scale, scale)
    obj.rotation_euler[2] = rotation
    obj['asset_creator'] = 'Kenney'
    obj['asset_source'] = 'https://kenney.nl/assets/castle-kit'
    obj['asset_license'] = 'CC0 1.0 Universal; commercial use and modification allowed; attribution optional'
    obj['asset_modified'] = 'scaled and assigned SV2 palette material'
    return obj


def _sv2c2_tree_variant(template, variant_name, palette_colors):
    data = template.copy()
    data.name = 'SV2_C2_TreeMesh_' + variant_name
    for index, original in enumerate(list(data.materials)):
        if original is None or not any(token in original.name.lower()
                                       for token in ('leaf', 'leaves')):
            continue
        material_copy = original.copy()
        material_copy.name = 'SV2_C2_LeafMaterial_' + variant_name
        material_copy.use_nodes = True
        nodes = material_copy.node_tree.nodes
        links = material_copy.node_tree.links
        shader = next((node for node in nodes if node.type == 'BSDF_PRINCIPLED'), None)
        if shader is None:
            continue
        base_color = shader.inputs.get('Base Color')
        if base_color is None:
            continue
        image_nodes = [node for node in nodes
                       if node.type == 'TEX_IMAGE' and node.image is not None]
        leaf_image = next((node for node in image_nodes
                           if 'leaf' in node.image.name.lower()), None)
        if leaf_image is None and len(image_nodes) == 1:
            leaf_image = image_nodes[0]
        base_links = [link for link in links if link.to_socket == base_color]
        alpha_input = shader.inputs.get('Alpha')
        if leaf_image is not None and alpha_input is not None:
            alpha_links = [link for link in links if link.to_socket == alpha_input]
            alpha_source = next((link.from_socket for link in alpha_links
                                 if link.from_socket.node.type == 'TEX_IMAGE'), None)
            if alpha_source is None:
                for link in alpha_links:
                    links.remove(link)
                links.new(leaf_image.outputs['Alpha'], alpha_input)
        # Preserve the authored PNG's cutout silhouette through Alpha while
        # using a solid pastel baseColorFactor. This exports cleanly without
        # Blender-only RGBToBW/ColorRamp nodes or muddy green-RGB multiplies.
        for link in base_links:
            links.remove(link)
        tint = (*palette_colors[1], 1.0)
        base_color.default_value = tint
        material_copy.diffuse_color = tint
        material_copy['sv2LeafTextureAlpha'] = (leaf_image.image.name
                                                if leaf_image else 'none')
        material_copy['sv2LeafTint'] = list(palette_colors[1])
        data.materials[index] = material_copy
    return data


def _sv2c2_place_trees(islands):
    c2_target = _SV2_C2_STATE['target']
    common = make_veg_template('CommonTree_1', 'CommonTree_1')
    twisted = make_veg_template('TwistedTree_1', 'TwistedTree_1')
    variants = {
        'Rose': _sv2c2_tree_variant(common, 'Rose',
                                    json.loads('[[0.43,0.14,0.25],[0.86,0.42,0.64],[1.0,0.78,0.88]]')),
        'CloudBlue': _sv2c2_tree_variant(common, 'CloudBlue',
                                         json.loads('[[0.12,0.3,0.48],[0.36,0.64,0.87],[0.72,0.87,1.0]]')),
        'Buttercup': _sv2c2_tree_variant(common, 'Buttercup',
                                         json.loads('[[0.47,0.31,0.1],[0.85,0.67,0.29],[1.0,0.92,0.64]]')),
        'TwistedRose': _sv2c2_tree_variant(twisted, 'TwistedRose',
                                           json.loads('[[0.43,0.14,0.25],[0.86,0.42,0.64],[1.0,0.78,0.88]]')),
    }
    garden_positions = []
    for sign in (-1, 1):
        for index in range(9):
            x = sign * (282 + (index % 3) * 43)
            z = 111 + (index // 3) * 42
            garden_positions.append((x, _sv2c2_terrain_height(x, z) + .25, z,
                                     ('Rose', 'CloudBlue', 'Buttercup')[index % 3],
                                     8.4 + (index % 4) * 1.0))
        for index in range(5):
            x = sign * (420 + index * 33)
            z = -70 - index * 27
            garden_positions.append((x, _sv2c2_terrain_height(x, z) + .25, z,
                                     ('CloudBlue', 'Buttercup', 'Rose')[index % 3],
                                     9.2 + (index % 3) * 1.3))
    for index, (x, y, z, variant, height) in enumerate(garden_positions, 1):
        obj = plant(variants[variant], 'SV2_C2_GardenTree_%03d_%s' % (index, variant),
                    (x, y, z), height, city,
                    rotation=(index * .731) % math.tau)
        for collection in list(obj.users_collection):
            if collection == CITY:
                collection.objects.unlink(obj)
        if obj.name not in c2_target.objects:
            c2_target.objects.link(obj)
        obj['palette'] = variant
        obj['gardenDistrict'] = 'formal palace island gardens'

    # The mainland canopy is grouped in deliberate rose, sky-blue, and
    # buttercup groves.  A staggered shared-mesh lattice keeps adult trees
    # human-scale while leaving every source route, watercourse, pool, villa,
    # and the palace precinct clear.
    grove_specs = json.loads('[ ["Rose",-620,260,148], ["Rose",-690,-80,148], ["Rose",-570,-350,148], ["CloudBlue",620,260,148], ["CloudBlue",690,-80,148], ["CloudBlue",570,-350,148], ["Buttercup",-180,390,148], ["Buttercup",180,390,148], ["Buttercup",-180,-520,148], ["Buttercup",180,-520,148] ]')
    villa_specs = json.loads('[[-548,230,24,19],[-365,204,27,20],[-558,84,21,19],[-492,-8,25,21],[-360,-33,24,20],[-700,110,22,18],[548,230,24,19],[365,204,27,20],[558,84,21,19],[492,-8,25,21],[360,-33,24,20],[700,110,22,18]]')
    forest_count = 0
    lattice_step = 24.6
    for grove_index, (variant, center_x, center_z, grove_radius) in enumerate(grove_specs):
        candidates = []
        for row in range(-7, 8):
            base_z = center_z + row * lattice_step * .8660254037844386
            for column in range(-7, 8):
                base_x = center_x + (column + row * .5) * lattice_step
                if (base_x - center_x) ** 2 + (base_z - center_z) ** 2 > grove_radius ** 2:
                    continue
                x = base_x + 3.1 * math.sin(row * 17.1 + column * 4.7 + center_x)
                z = base_z + 3.1 * math.cos(row * 7.3 - column * 11.9 + center_z)
                height = 15.5 + ((row * 7 + column * 11 + grove_index * 3) % 6) * 1.4
                canopy = height * .29
                radial = math.sqrt((x / SV2_C2_ISLAND_RX) ** 2
                                   + (z / SV2_C2_ISLAND_RZ) ** 2)
                if radial > .88 or (abs(x) < 275 and -370 < z < 25):
                    continue
                if any(_sv2c2_segment_nearest(x, z, route['_sampled'])[0]
                       <= route['width'] * .5 + canopy + 6.0
                       for route in _SV2_C2_STATE['routes']):
                    continue
                if any(_sv2c2_segment_nearest(x, z, river['_sampled'])[0]
                       <= river['width'] * .5 + canopy + 6.0
                       for river in _SV2_C2_STATE['rivers']):
                    continue
                if any(((x - pond['center'][0])
                        / (pond['size'][0] * .5 + canopy + 7.0)) ** 2
                       + ((z - pond['center'][2])
                          / (pond['size'][1] * .5 + canopy + 7.0)) ** 2 <= 1.0
                       for pond in _SV2_C2_STATE['ponds']):
                    continue
                if any(abs(x - villa[0]) <= villa[2] * .5 + canopy + 7.0
                       and abs(z - villa[1]) <= villa[3] * .5 + canopy + 7.0
                       for villa in villa_specs):
                    continue
                if any(math.hypot(x - tree[0], z - tree[2])
                       <= canopy + tree[4] * .29 + 7.0
                       for tree in garden_positions):
                    continue
                rank = (row * 193 + column * 389 + row * column * 101
                        + grove_index * 173) % 104729
                candidates.append((rank, row, column, x, z, height))
        candidates.sort()
        for tree_index, (_, row, column, x, z, height) in enumerate(candidates[:28], 1):
            forest_count += 1
            obj = plant(variants[variant],
                        'SV2_C2_MainGrove_%02d_Tree_%02d_%s'
                        % (grove_index + 1, tree_index, variant),
                        (x, _sv2c2_terrain_height(x, z) + .25, z), height,
                        city, rotation=(row * .47 + column * .73) % math.tau)
            for collection in list(obj.users_collection):
                if collection == CITY:
                    collection.objects.unlink(obj)
            if obj.name not in c2_target.objects:
                c2_target.objects.link(obj)
            obj['palette'] = variant
            obj['gardenDistrict'] = 'main-island ' + variant + ' woodland'
            obj['treeHeightMetres'] = height
            obj['sourceReference'] = 'CommonTree_1, Stylized Nature MegaKit Standard, CC0 Quaternius'

    endpoint_palettes = {'SkyIsland_West_04': 'Rose',
                         'SkyIsland_Dawn_04': 'Buttercup',
                         'SkyIsland_East_04': 'CloudBlue'}
    endpoint_offsets = json.loads('[[-0.44,-0.10],[-0.28,-0.40],[0,-0.48],[0.34,-0.31],[0.46,0.10],[0.23,0.44],[-0.18,0.42]]')
    for index, island in enumerate(islands):
        endpoint_variant = endpoint_palettes.get(island['name'])
        if endpoint_variant:
            for tree_index, (offset_x, offset_z) in enumerate(endpoint_offsets, 1):
                x = island['x'] + offset_x * island['rx']
                z = island['z'] + offset_z * island['rz']
                height = 8.5 + ((tree_index + index) % 5) * .55
                obj = plant(variants[endpoint_variant],
                            'SV2_C2_' + island['name'] + '_GroveTree_%02d_%s'
                            % (tree_index, endpoint_variant),
                            (x, island['y'] + 1.1, z), height, city,
                            rotation=(index * 1.11 + tree_index * .59) % math.tau)
                for collection in list(obj.users_collection):
                    if collection == CITY:
                        collection.objects.unlink(obj)
                if obj.name not in c2_target.objects:
                    c2_target.objects.link(obj)
                obj['palette'] = endpoint_variant
                obj['gardenDistrict'] = 'bridge-corridor endpoint grove'
                obj['sourceReference'] = 'CommonTree_1, Stylized Nature MegaKit Standard, CC0 Quaternius'
            continue
        if index % 3 == 1:
            continue
        variant = ('Rose', 'CloudBlue', 'Buttercup')[index % 3]
        height = min(12.0, max(6.5, island['rx'] * .12))
        x = island['x'] + math.sin(index * 1.4) * island['rx'] * .20
        z = island['z'] + math.cos(index * .9) * island['rz'] * .18
        obj = plant(variants[variant],
                    'SV2_C2_' + island['name'] + '_Tree_' + variant,
                    (x, island['y'] + 1.1, z), height, city,
                    rotation=(index * 1.11) % math.tau)
        for collection in list(obj.users_collection):
            if collection == CITY:
                collection.objects.unlink(obj)
        if obj.name not in c2_target.objects:
            c2_target.objects.link(obj)
        obj['palette'] = variant
        obj['sourceReference'] = 'CommonTree_1, Stylized Nature MegaKit Standard, CC0 Quaternius'


def _sv2c2_build_island_groups():
    island_specs = []
    corridor_data = json.loads('[["A","West",[-480,60,300],[[-795,43,370,78,66,82],[-1015,34,485,82,70,91],[-1235,43,610,92,77,105],[-1470,34,748,101,82,120]]],["B","Dawn",[0,60,520],[[0,42,760,74,65,76],[152,31,936,84,71,89],[336,42,1114,94,80,104],[548,34,1294,105,88,122]]],["C","East",[480,60,300],[[795,43,370,78,66,82],[1015,34,485,82,70,91],[1235,43,610,92,77,105],[1470,34,748,101,82,120]]]]')
    bridges = []
    for code, group, start, chain in corridor_data:
        prior = tuple(start)
        prior_y = float(start[1])
        for index, (x, y, z, rx, rz, depth) in enumerate(chain, 1):
            name = 'SkyIsland_%s_%02d' % (group, index)
            island = _sv2c2_satellite_island(name, x, y, z, rx, rz, depth,
                                              20261002 + len(island_specs) * 17)
            island['corridor'] = group
            island_specs.append(island)
            endpoint = (x, y + .8, z)
            bridges.append(('SV2_C2_BridgeCorridor_%s_%02d' % (code, index),
                            prior, endpoint, 12.0 if index < 4 else 14.0,
                            26.0 + index * 2.2, group))
            prior = endpoint
            prior_y = y

    scenic = json.loads('[["West_MoonGarden_01",-1130,46,-280,80,68,82],["West_MoonGarden_02",-1360,35,-150,68,58,76],["West_MoonGarden_03",-1580,49,-265,94,75,106],["West_MoonGarden_04",-1745,37,-405,72,66,89],["West_MoonGarden_05",-1260,29,-480,75,69,101],["West_MoonGarden_06",-1510,44,-610,101,82,117],["East_MoonGarden_01",1130,46,-280,80,68,82],["East_MoonGarden_02",1360,35,-150,68,58,76],["East_MoonGarden_03",1580,49,-265,94,75,106],["East_MoonGarden_04",1745,37,-405,72,66,89],["East_MoonGarden_05",1260,29,-480,75,69,101],["East_MoonGarden_06",1510,44,-610,101,82,117],["Rear_CelestialOrchard_01",-760,37,-812,74,60,82],["Rear_CelestialOrchard_02",-420,45,-1044,88,69,101],["Rear_CelestialOrchard_03",0,31,-1275,99,83,117],["Rear_CelestialOrchard_04",430,44,-1055,88,69,100],["Rear_CelestialOrchard_05",790,36,-825,75,64,87],["Front_CloudAtoll_01",-1020,38,1120,91,72,103],["Front_CloudAtoll_02",1020,38,1120,91,72,103],["Far_EasternSanctuary_01",1790,55,990,116,92,128]]')
    for index, spec in enumerate(scenic):
        name, x, y, z, rx, rz, depth = spec
        island_specs.append(_sv2c2_satellite_island(name, x, y, z, rx, rz,
                                                     depth, 2030001 + index * 29))
    for name, start, end, width, rise, group in bridges:
        deck = _sv2c2_build_skybridge(name, start, end, width, rise)
        deck['corridor'] = group
        deck['layoutSource'] = 'visual sky-bridge extension; not server navigation'
    return island_specs


def _sv2c2_build_lookouts(islands):
    c2_target = _SV2_C2_STATE['target']
    for index, island in enumerate(islands):
        if index % 4 != 0:
            continue
        x, y, z = island['x'], island['y'] + 1.0, island['z']
        cylinder('SV2_C2_' + island['name'] + '_LookoutBase',
                 (x, y + 1.0, z), min(island['rx'], island['rz']) * .26,
                 2.0, M['stoneBright'], city, c2_target, 16)
        cylinder('SV2_C2_' + island['name'] + '_LookoutShaft',
                 (x, y + 8.0, z), min(island['rx'], island['rz']) * .12,
                 12.0, M['stone'], city, c2_target, 16,
                 top_radius=min(island['rx'], island['rz']) * .10)
        cylinder('SV2_C2_' + island['name'] + '_LookoutGallery',
                 (x, y + 14.5, z), min(island['rx'], island['rz']) * .28,
                 1.0, M['goldLight'], city, c2_target, 16)
        cap_y = y + 15.2
        roof = _sv2c2_import_kenney_module('tower-hexagon-roof.glb',
                                            'SV2_C2_KenneyOutpostRoof_%02d' % index,
                                            max(7.0, min(island['rx'], island['rz']) * .30),
                                            (x, cap_y, z), M['roofLight'])
        roof['outpostAccent'] = True


def _sv2c2_build_gateway_assets(islands):
    targets = [island for island in islands
               if island['name'] in ('SkyIsland_West_02', 'SkyIsland_Dawn_02',
                                     'SkyIsland_East_02')]
    for index, island in enumerate(targets):
        obj = _sv2c2_import_kenney_module(
            'wall-doorway.glb', 'SV2_C2_KenneyGateway_%02d' % index,
            6.2, (island['x'], island['y'] + 1.2, island['z'] + island['rz'] * .28),
            M['stoneBright'], rotation=(index % 2) * math.pi)
        obj['accentForIsland'] = island['name']

    bridge_islands = [island for island in islands
                      if island['name'] in ('SkyIsland_West_03', 'SkyIsland_Dawn_03',
                                            'SkyIsland_East_03')]
    for index, island in enumerate(bridge_islands):
        obj = _sv2c2_import_kenney_module(
            'bridge-straight-pillar.glb', 'SV2_C2_KenneyBridgePillar_%02d' % index,
            6.4, (island['x'], island['y'] + 1.0,
                  island['z'] - island['rz'] * .22), M['stone'])
        obj['accentForIsland'] = island['name']


def build_sky_voyage_city_v2():
    """Build only the V2 city layer under the existing city root and return source counts."""
    assert city.name == 'SV2_City'
    assert LAYOUT['units'] == 'metres'
    assert tuple(round(float(value), 3) for value in city.location) == tuple(
        round(float(value), 3) for value in d_to_b(LAYOUT['roots']['SV2_City']['gameWorld']))
    c2_target = _sv2c2_collection()
    _SV2_C2_STATE['target'] = c2_target
    waterfalls = _sv2c2_init_route_and_water_data()
    c2_water = _SV2_C2_STATE['water']
    c2_routes = _SV2_C2_STATE['routes']

    _sv2c2_build_main_island()
    _sv2c2_build_water_beds(waterfalls)
    _sv2c2_build_roads()
    _sv2c2_build_palace()
    _sv2c2_build_plazas_and_lamps()
    _sv2c2_build_villas()
    islands = _sv2c2_build_island_groups()
    _sv2c2_build_lookouts(islands)
    _sv2c2_build_gateway_assets(islands)
    _sv2c2_place_trees(islands)

    LAYOUT['city']['waterBodies'] = c2_water
    water_json = json.dumps(c2_water, ensure_ascii=False)
    scene['sv_layout_json'] = json.dumps(LAYOUT, ensure_ascii=False)
    scene['sv2_water_bodies'] = water_json
    city['waterBodies'] = water_json
    scene['sv2_city_geometry_owner'] = 'scripts/creative/blender/sky_voyage_city_v2.py'
    scene['sv2_city_routes'] = len(c2_routes)
    scene['sv2_city_satellite_islands'] = len(islands)
    scene['sv2_city_bridge_spans'] = len(islands) - 20
    scene['sv2_city_water_surface_meshes'] = 0
    pool_count = sum(item['kind'] == 'pool' for item in c2_water)
    river_count = sum(item['kind'] == 'river' for item in c2_water)
    fall_count = sum(item['kind'] == 'fall' for item in c2_water)
    assert len(c2_routes) == len(LAYOUT['city']['routes'])
    assert len(islands) == 32
    assert pool_count == 4 and 2 <= river_count <= 3
    assert 6 <= fall_count <= 10
    return {
        'routes': len(c2_routes),
        'satelliteIslands': len(islands),
        'bridgeSpans': len(islands) - 20,
        'waterBodies': pool_count,
        'waterChannels': river_count,
        'waterfalls': fall_count,
        'mainIslandSize': LAYOUT['city']['mainIslandSize'],
        'palaceFootprintMetres': json.loads('[450,300]'),
    }
