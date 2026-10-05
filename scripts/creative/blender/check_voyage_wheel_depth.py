import bpy
import hashlib
import json
import math
import os
import struct
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

BLEND = '/Users/muniao/Code/MapleStory/resources/scenes/sky-voyage-v3/models/sky-voyage.blend'
GLB = '/Users/muniao/Code/MapleStory/resources/scenes/sky-voyage-v3/models/sky-voyage.glb'
OUT = '/Users/muniao/Code/MapleStory/evidence/2026-10-05/voyage-spatial-correction/wheel-depth/wheel-depth-sweep.json'
SAMPLES = 720
NEAREST_STRIDE = 4
EPS = 1.0e-6


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def tup(v):
    return (float(v[0]), float(v[1]), float(v[2]))


def add(a, b): return (a[0] + b[0], a[1] + b[1], a[2] + b[2])
def sub(a, b): return (a[0] - b[0], a[1] - b[1], a[2] - b[2])
def cross(a, b): return (a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0])
def dot(a, b): return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]
def norm2(a): return dot(a, a)
def dist(a, b):
    d = sub(a, b)
    return math.sqrt(norm2(d))


def tri_intersects(a, b, eps=EPS):
    # SAT for two closed convex triangles, including touching within eps.
    axes = []
    for tri in (a, b):
        e0 = sub(tri[1], tri[0]); e1 = sub(tri[2], tri[1]); e2 = sub(tri[0], tri[2])
        axes.append(cross(e0, e1))
        if tri is a:
            ae = (e0, e1, e2)
        else:
            be = (e0, e1, e2)
    for ea in ae:
        for eb in be:
            axes.append(cross(ea, eb))
    for axis in axes:
        if norm2(axis) < 1.0e-18:
            continue
        pa = [dot(axis, p) for p in a]
        pb = [dot(axis, p) for p in b]
        if max(pa) < min(pb) - eps or max(pb) < min(pa) - eps:
            return False
    return True


def mesh_triangles(obj):
    if obj.type != 'MESH':
        return []
    me = obj.data
    me.calc_loop_triangles()
    out = []
    wm = obj.matrix_world
    for tri in me.loop_triangles:
        out.append(tuple(tup(wm @ me.vertices[i].co) for i in tri.vertices))
    return out


def bounds(points):
    if not points:
        return None
    return [[min(p[i] for p in points), max(p[i] for p in points)] for i in range(3)]


def mesh_uv_status(obj):
    if obj.type != 'MESH':
        return {'ok': True, 'layers': [], 'loop_count': 0}
    names = [u.name for u in obj.data.uv_layers]
    loop_count = len(obj.data.loops)
    missing = [n for n in ('SourceUV', 'MaterialUV') if n not in names]
    wrong = [n for n in ('SourceUV', 'MaterialUV') if n in names and len(obj.data.uv_layers[n].data) != loop_count]
    return {'ok': not missing and not wrong, 'layers': names, 'loop_count': loop_count, 'missing': missing, 'wrong_length': wrong}


def descendants(root):
    return [root] + list(root.children_recursive)


def collect_wheel(name):
    root = bpy.data.objects.get(name)
    if root is None:
        raise RuntimeError('missing wheel ' + name)
    meshes = [o for o in descendants(root) if o.type == 'MESH']
    tris = []
    points = []
    for o in meshes:
        ts = mesh_triangles(o)
        tris.extend(ts)
        points.extend(p for t in ts for p in t)
    steering = root.parent
    center = tup(steering.matrix_world.translation if steering else root.matrix_world.translation)
    # Source Blender wheel plane is X/Z; its runtime spin axis is Blender Y.
    axis_source = (0.0, 1.0, 0.0)
    rvals = [math.sqrt((p[0]-center[0])**2 + (p[2]-center[2])**2) for p in points]
    yvals = [p[1] for p in points]
    frame_nodes = [o for o in meshes if '_FrameFront' in o.name or '_FrameRear' in o.name or '_FrameDepthTies' in o.name]
    frame_points = [p for o in frame_nodes for t in mesh_triangles(o) for p in t]
    props = {k: str(root[k]) for k in root.keys() if k in ('spin_axis', 'spin_sign', 'spin_origin', 'wheel_face_axis')}
    return {
        'root': root,
        'steering': steering,
        'meshes': meshes,
        'triangles': tris,
        'points': points,
        'center': center,
        'axis_source_blender': list(axis_source),
        'axis_runtime': [0.0, 0.0, 1.0],
        'spin_sign': float(root.get('spin_sign', 1.0)),
        'props': props,
        'bounds': bounds(points),
        'radius': [min(rvals), max(rvals)],
        'source_axis_depth': [min(yvals), max(yvals)],
        'frame_radius': [min(math.sqrt((p[0]-center[0])**2 + (p[2]-center[2])**2) for p in frame_points), max(math.sqrt((p[0]-center[0])**2 + (p[2]-center[2])**2) for p in frame_points)] if frame_points else None,
        'frame_depth': bounds(frame_points),
        'uv': {o.name: mesh_uv_status(o) for o in meshes},
    }


def build_target(name):
    o = bpy.data.objects.get(name)
    if o is None:
        raise RuntimeError('missing target ' + name)
    tris = mesh_triangles(o)
    verts = [Vector(p) for t in tris for p in t]
    polys = [(i*3, i*3+1, i*3+2) for i in range(len(tris))]
    tree = BVHTree.FromPolygons(verts, polys, all_triangles=True)
    return {'name': name, 'object': o, 'triangles': tris, 'tree': tree, 'bounds': bounds([p for t in tris for p in t]), 'faces': len(tris), 'excluded': False}


def rotate_point(p, center, angle):
    # Source wheel geometry uses Blender Y as the runtime-Z axis.
    m = Matrix.Translation(Vector(center)) @ Matrix.Rotation(angle, 4, 'Y') @ Matrix.Translation(-Vector(center))
    return tup(m @ Vector(p))


def sampled_target(wheel, target):
    tris = wheel['triangles']
    center = wheel['center']
    sign = wheel['spin_sign']
    target_tris = target['triangles']
    target_tree = target['tree']
    min_vertex_gap = float('inf')
    min_witness = None
    overlap_samples = 0
    exact_pair_total = 0
    broad_pair_total = 0
    first_hit = None
    max_exact_pairs = 0
    max_broad_pairs = 0
    for i in range(SAMPLES):
        raw = 2.0 * math.pi * i / SAMPLES
        theta = raw * sign
        wt = [tuple(rotate_point(p, center, theta) for p in tri) for tri in tris]
        verts = [Vector(p) for tri in wt for p in tri]
        polys = [(j*3, j*3+1, j*3+2) for j in range(len(wt))]
        wtree = BVHTree.FromPolygons(verts, polys, all_triangles=True)
        pairs = wtree.overlap(target_tree)
        broad_pair_total += len(pairs)
        max_broad_pairs = max(max_broad_pairs, len(pairs))
        exact = []
        for wi, ti in pairs:
            if 0 <= wi < len(wt) and 0 <= ti < len(target_tris) and tri_intersects(wt[wi], target_tris[ti]):
                exact.append((wi, ti))
        if exact:
            overlap_samples += 1
            exact_pair_total += len(exact)
            max_exact_pairs = max(max_exact_pairs, len(exact))
            if first_hit is None:
                first_hit = {'sample': i, 'degrees': i * 360.0 / SAMPLES, 'pairs': len(exact), 'example_pair': [exact[0][0], exact[0][1]]}
        elif i % NEAREST_STRIDE == 0:
            for vi, p in enumerate(verts):
                near = target_tree.find_nearest(p)
                if near is None:
                    continue
                d = float(near[3])
                if d < min_vertex_gap:
                    min_vertex_gap = d
                    min_witness = {'sample': i, 'degrees': i * 360.0 / SAMPLES, 'vertex': vi, 'target_triangle': int(near[2]), 'point': [float(x) for x in p], 'nearest': [float(x) for x in near[0]]}
    return {
        'target': target['name'],
        'target_faces': target['faces'],
        'sample_count': SAMPLES,
        'nearest_stride': NEAREST_STRIDE,
        'exact_triangle_intersection': overlap_samples > 0,
        'intersection_sample_count': overlap_samples,
        'first_intersection': first_hit,
        'exact_pair_total': exact_pair_total,
        'max_exact_pairs_per_sample': max_exact_pairs,
        'broadphase_pair_total': broad_pair_total,
        'max_broadphase_pairs_per_sample': max_broad_pairs,
        'sampled_min_vertex_distance': None if min_vertex_gap == float('inf') else min_vertex_gap,
        'min_distance_witness': min_witness,
        'interpretation': 'intersecting' if overlap_samples else 'no exact triangle intersection in sampled full turn',
    }


def parse_glb(path):
    data = open(path, 'rb').read()
    off = 12; doc = None
    while off < len(data):
        length, kind = struct.unpack_from('<I4s', data, off)
        payload = data[off+8:off+8+length]
        if kind == b'JSON':
            doc = json.loads(payload.rstrip(b'\x00').decode('utf-8'))
        off += 8 + length
    return doc


def glb_wheel_check(doc):
    nodes = doc.get('nodes', [])
    parents = {}
    for i, n in enumerate(nodes):
        for c in n.get('children', []): parents[c] = i
    by_name = {n.get('name'): i for i, n in enumerate(nodes) if n.get('name')}
    out = {}
    for root_name in ('SV3_Wheel_Port', 'SV3_Wheel_Starboard'):
        ri = by_name.get(root_name)
        if ri is None:
            out[root_name] = {'present': False}; continue
        stack = [ri]; ids = []
        while stack:
            ni = stack.pop(); ids.append(ni); stack.extend(nodes[ni].get('children', []))
        missing_uv = []; primitive_count = 0; mesh_count = 0; depth_count = 0
        for ni in ids:
            n = nodes[ni]
            if n.get('name', '').startswith('SV3_WheelDepth_'): depth_count += 1
            mi = n.get('mesh')
            if mi is None: continue
            mesh_count += 1
            for pi, prim in enumerate(doc['meshes'][mi].get('primitives', [])):
                primitive_count += 1
                attrs = prim.get('attributes', {})
                if 'TEXCOORD_0' not in attrs or 'TEXCOORD_1' not in attrs:
                    missing_uv.append({'node': n.get('name'), 'primitive': pi, 'missing': [x for x in ('TEXCOORD_0','TEXCOORD_1') if x not in attrs]})
        extras = nodes[ri].get('extras', {}) or {}
        out[root_name] = {
            'present': True,
            'node_index': ri,
            'spin_axis': extras.get('spin_axis'),
            'spin_sign': extras.get('spin_sign'),
            'descendant_node_count': len(ids),
            'depth_node_count': depth_count,
            'mesh_node_count': mesh_count,
            'primitive_count': primitive_count,
            'uv_attributes_ok': not missing_uv,
            'missing_uv': missing_uv,
        }
    return out

scene = bpy.data.scenes.get('SV3_ProductionRig')
if scene is None:
    raise RuntimeError('SV3_ProductionRig missing')
# Source geometry is loaded only; no save/export operation is called.
wheel_data = {side: collect_wheel('SV3_Wheel_' + side) for side in ('Port', 'Starboard')}
# Hull body and fixed supports are checked. AxleConnector is intentionally excluded
# because it is the axial connection itself, not an unintended collision target.
target_names = ['SV3_Hull', 'SV3_HullWheelVolumeClosure', 'SV3_Repaired_WheelHullSockets']
for side in ('Port', 'Starboard'):
    target_names += [
        'SV3_Wheel_' + side + '_SocketElbow',
        'SV3_Wheel_' + side + '_OutboardBrace',
    ]
targets = {name: build_target(name) for name in target_names}
results = {
    'schema': 'voyage-wheel-depth-sweep-v1',
    'method': {
        'source_scene': scene.name,
        'axis_source_blender': [0.0, 1.0, 0.0],
        'axis_runtime': [0.0, 0.0, 1.0],
        'samples': SAMPLES,
        'exact_test': 'BVH broadphase followed by closed-triangle SAT; full 360 degrees',
        'nearest_test': 'wheel vertices to target BVH at every fourth sample when no exact hit',
        'excluded_targets': ['SV3_Wheel_Port_AxleConnector', 'SV3_Wheel_Starboard_AxleConnector'],
        'excluded_reason': 'axial wheel connection is intentionally not treated as an unintended fixed-support penetration',
    },
    'source': {
        'blend': BLEND,
        'blend_sha256': sha256(BLEND),
        'glb': GLB,
        'glb_sha256': sha256(GLB),
    },
    'wheels': {},
    'targets': {name: {'bounds': t['bounds'], 'faces': t['faces']} for name, t in targets.items()},
}
for side, wheel in wheel_data.items():
    item = {k: v for k, v in wheel.items() if k not in ('root', 'steering', 'meshes', 'triangles', 'points')}
    item['mesh_count'] = len(wheel['meshes'])
    item['mesh_names'] = [o.name for o in wheel['meshes']]
    item['target_results'] = {}
    for target_name, target in targets.items():
        # Check Hull and shared socket once per side; only side-specific supports apply to that side.
        if target_name.endswith('_Port_SocketElbow') or target_name.endswith('_Port_OutboardBrace'):
            applies = side == 'Port'
        elif target_name.endswith('_Starboard_SocketElbow') or target_name.endswith('_Starboard_OutboardBrace'):
            applies = side == 'Starboard'
        else:
            applies = True
        if applies:
            item['target_results'][target_name] = sampled_target(wheel, target)
    item['uv_summary'] = {
        'all_source_uv_ok': all(v['ok'] for v in wheel['uv'].values()),
        'missing_or_bad': {k: v for k, v in wheel['uv'].items() if not v['ok']},
        'mesh_count': len(wheel['uv']),
    }
    results['wheels'][side] = item

doc = parse_glb(GLB)
results['glb'] = {
    'asset_sha256': sha256(GLB),
    'wheel_nodes': glb_wheel_check(doc),
}
results['status'] = {
    'hull_original_volume_restored': scene.objects['SV3_Hull'].get('wheel_hull_original_faces_recovered', 0) > 1000
        and scene.objects['SV3_Hull'].get('wheel_clearance_carving') is False,
    'source_spin_sign_opposite': results['wheels']['Port']['spin_sign'] == 1.0 and results['wheels']['Starboard']['spin_sign'] == -1.0,
    'glb_spin_sign_opposite': results['glb']['wheel_nodes'].get('SV3_Wheel_Port', {}).get('spin_sign') == 1.0 and results['glb']['wheel_nodes'].get('SV3_Wheel_Starboard', {}).get('spin_sign') == -1.0,
    'source_uv_ok': all(x['uv_summary']['all_source_uv_ok'] for x in results['wheels'].values()),
    'glb_uv_ok': all(x.get('uv_attributes_ok') for x in results['glb']['wheel_nodes'].values() if x.get('present')),
    'hull_exact_intersection_free': all(not results['wheels'][side]['target_results']['SV3_Hull']['exact_triangle_intersection'] for side in ('Port', 'Starboard')),
    'complete_hull_volume_intersection_free': all(not results['wheels'][side]['target_results']['SV3_HullWheelVolumeClosure']['exact_triangle_intersection'] for side in ('Port', 'Starboard')),
    'all_checked_fixed_supports_intersection_free': all(
        not result['exact_triangle_intersection']
        for side in ('Port', 'Starboard')
        for name, result in results['wheels'][side]['target_results'].items()
        if name.endswith('_SocketElbow') or name.endswith('_OutboardBrace')
    ),
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(results, f, ensure_ascii=False, indent=2)
    f.write('\n')
print('WHEEL_DEPTH_AUDIT_WRITTEN', OUT)
print(json.dumps(results['status'], ensure_ascii=False, sort_keys=True))
for side, item in results['wheels'].items():
    print('WHEEL', side, 'center', item['center'], 'r', item['radius'], 'frame_r', item['frame_radius'], 'spin_sign', item['spin_sign'])
    for name, r in item['target_results'].items():
        print('TARGET', side, name, 'intersect', r['exact_triangle_intersection'], 'samples', r['intersection_sample_count'], 'min_vertex_distance', r['sampled_min_vertex_distance'])
if not all(results['status'].values()):
    raise RuntimeError('wheel/hull audit failed: ' + json.dumps(results['status'], ensure_ascii=False))
