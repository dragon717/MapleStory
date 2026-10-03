"""Clip authored room/jewel voids and paint boundaries, retaining source UV/normals.

Face-centre deletion leaves a triangle-shaped fringe; the same centre-based
paint mask also makes the ivory/timber seam jagged. Split at the actual planes.
"""
import bpy, math
from mathutils import Vector

def split(poly, normal, offset):
    inside, outside = [], []
    for i, a in enumerate(poly):
        b = poly[(i+1) % len(poly)]
        da, db = normal.dot(a[0])-offset, normal.dot(b[0])-offset
        # Plane vertices belong to both results. Dropping them from the outside
        # result tears triangles when a second cut reuses the first cut's edge.
        if da >= -1e-7: inside.append(a)
        if da <= 1e-7: outside.append(a)
        if da > 1e-7 and db < -1e-7 or da < -1e-7 and db > 1e-7:
            t = da/(da-db)
            v = (a[0].lerp(b[0], t), [u.lerp(v, t) for u,v in zip(a[1],b[1])], a[2].lerp(b[2],t).normalized())
            inside.append(v); outside.append(v)
    return inside, outside

def partition(poly, planes):
    # Reject disjoint faces before splitting on an infinite plane. This keeps
    # remote source triangles intact and avoids a needless hull-wide retessellation.
    if any(all(n.dot(v[0]) < offset-1e-7 for v in poly) for n,offset in planes):
        return [], [poly]
    outside = []
    for normal, offset in planes:
        if len(poly) < 3: break
        poly, rest = split(poly, normal, offset)
        if len(rest) >= 3: outside.append(rest)
    return poly, outside

def box(lo, hi):
    return [(Vector(tuple(1 if a==axis else 0 for a in range(3))),lo[axis]) for axis in range(3)] + [(Vector(tuple(-1 if a==axis else 0 for a in range(3))),-hi[axis]) for axis in range(3)]

def build(name, polys, old):
    vertices, faces, uvs, normals, materials, smooth = [], [], [], [], [], []
    for poly, mat, sm in polys:
        start = len(vertices)
        for co,uv,n in poly: vertices.append(co); uvs.append(uv); normals.append(n)
        for i in range(1,len(poly)-1):
            faces.append((start,start+i,start+i+1)); materials.append(mat); smooth.append(sm)
    data = bpy.data.meshes.new(name); data.from_pydata(vertices,[],faces); data.update()
    for mat in old.materials: data.materials.append(mat)
    for k,layer in enumerate(old.uv_layers):
        dst = data.uv_layers.new(name=layer.name)
        for loop in data.loops: dst.data[loop.index].uv=uvs[loop.vertex_index][k]
    for p,mat,sm in zip(data.polygons,materials,smooth): p.material_index=mat; p.use_smooth=sm
    data.normals_split_custom_set([normals[loop.vertex_index] for loop in data.loops])
    return data

def refine_hull(old, fragments):
    reference = bpy.data.objects['BeforeRepair_SV3_Hull'].data
    labels = {tuple(sorted(p.vertices)):p.material_index for p in reference.polygons}
    cuts = [box((-5.05,-18,5.46),(5.05,0,8.35)), box((4,-14.5,5.35),(7,-12,8.15))]
    for side in [-1,1]:
        for y,z,r in [(12,3.5,2.25),(21.2,8.15,3),(-30,8,2.9)]:
            planes=[(Vector((side,0,0)),7.5)]
            # This opening is covered by an authored annular collar, never a flat opaque cap.
            for i in range(64):
                a=i*math.tau/64; n=Vector((0,-math.cos(a),-math.sin(a)))
                planes.append((n,n.dot(Vector((0,y,z)))-r*1.08))
            cuts.append(planes)
    roof_box=box((-5.1,-18,8.35),(5.1,0,10.6))
    timber_box=box((-100,-38,.4),(100,33,7.8))
    ivory=next(i for i,m in enumerate(old.materials) if m.name=='SV3_Prototype_HullIvory')
    wood=next(i for i,m in enumerate(old.materials) if m.name=='SV3_Prototype_DeckTeak')
    kept, roofs = [], []
    for p in old.polygons:
        if p.index in fragments: continue
        poly=[(old.vertices[old.loops[i].vertex_index].co.copy(),[l.data[i].uv.copy() for l in old.uv_layers],old.corner_normals[i].vector.copy()) for i in p.loop_indices]
        mat=labels.get(tuple(sorted(p.vertices)),p.material_index)
        roof, remain=partition(poly,roof_box)
        if len(roof)>=3: roofs.append((roof,mat,p.use_smooth))
        for cut in cuts:
            next_polys=[]
            for poly in remain: next_polys.extend(partition(poly,cut)[1])
            remain=next_polys
        for poly in remain:
            name=old.materials[mat].name
            if any(k in name for k in ['HullIvory','DeckTeak']):
                timber, painted=partition(poly,timber_box)
                kept.extend((part,ivory,p.use_smooth) for part in painted)
                if len(timber)>=3: kept.append((timber,wood,p.use_smooth))
            else: kept.append((poly,mat,p.use_smooth))
    return build('SV3_Hull_ExactOpenings',kept,old), build('SV3_CaptainRoof_Exact',roofs,old)
