"""Repair only the old face-centre cuts beside the wheels and aft fan.

Use archived, labelled source surfaces within bounded repair regions. Keep the
rest of the retained hull verbatim; clip the original voids at their real planes
and wheel circle instead of deleting whole triangles that cross the boundary.
"""
import math
from mathutils import Vector


def cylinder(y, z, ry, rz, count=96):
    planes = []
    for i in range(count):
        a = math.tau * i / count
        n = Vector((0, -math.cos(a)/ry, -math.sin(a)/rz))
        planes.append((n, n.dot(Vector((0, y, z))) - 1))
    return planes


def repair(old, source, clip, fragments):
    labels = {tuple(sorted(p.vertices)): p.material_index for p in source.polygons}
    regions = [clip.box((4, 16.5, -11.5), (16, 42, 13.5)),
               clip.box((-16, 16.5, -11.5), (-4, 42, 13.5)),
               clip.box((-16, -43, 7), (16, -18, 19.5))]
    wheel = cylinder(29.79, 0, 10.7, 10.7)
    bow_bottom = clip.box((-100, 18, -100), (100, 100, -4.8))
    # The old -22m cutoff left fused static shell fins under the main fan.
    # Join this local trim to the actual captain roof's -18m end plane. The
    # floor is below this cut; live cloth/spars are separate meshes and untouched.
    aft = clip.box((-100, -42, 8), (100, -18, 100))
    stern_top = clip.box((-100, -100, 15.3), (100, -39, 100))
    gem = cylinder(-30, 8, 3.6, 3.2)
    kept = []

    def polygon(mesh, p):
        return [(mesh.vertices[mesh.loops[i].vertex_index].co.copy(),
                 [layer.data[i].uv.copy() for layer in mesh.uv_layers],
                 mesh.corner_normals[i].vector.copy()) for i in p.loop_indices]

    # Remove only the bounded portions from the currently retained hull.
    for p in old.polygons:
        if p.index in fragments:
            continue
        parts = [polygon(old, p)]
        for region in regions:
            parts = [part for poly in parts for part in clip.partition(poly, region)[1]]
        mat = labels.get(tuple(sorted(p.vertices)), p.material_index)
        kept.extend((poly, mat, p.use_smooth) for poly in parts)

    restored = 0
    for p in source.polygons:
        if 'SailLinen' in source.materials[p.material_index].name:
            continue  # Dynamic cloth is owned by the existing fan meshes.
        for index, region in enumerate(regions):
            poly, _ = clip.partition(polygon(source, p), region)
            if len(poly) < 3:
                continue
            parts = [poly]
            if index < 2:
                for cut in [wheel, bow_bottom]:
                    parts = [part for poly in parts for part in clip.partition(poly, cut)[1]]
            else:
                # Preserve the old gem setting exception, with an exact ellipse.
                inside, parts = clip.partition(poly, aft)
                if len(inside) >= 3:
                    for side in [-1, 1]:
                        opening, _ = clip.partition(inside, [(Vector((side, 0, 0)), 7.5)] + gem)
                        if len(opening) >= 3:
                            parts.append(opening)
                for cut in [stern_top, [(Vector((0, 0, 1)), 19)]]:
                    parts = [part for poly in parts for part in clip.partition(poly, cut)[1]]
            restored += len(parts)
            kept.extend((poly, p.material_index, p.use_smooth) for poly in parts)
    result = clip.build('SV3_Hull_LocalCutBoundaryRepair', kept, old)
    result['source_labels_propagated'] = True
    result['boundary_repair_regions'] = 'wheel circle/forward underside; aft fan cut edges'
    return result, restored
