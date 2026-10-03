"""Check a wheel-crossing source face and preservation against a saved candidate.

Run Blender on the repaired file, then pass --before <previous.blend> after --.
"""
import bpy, hashlib, importlib.util, json, math, struct, sys
from pathlib import Path
from mathutils import Vector

def load(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module

clip=load('clip_voyage_hull');boundary=load('repair_voyage_cut_boundaries')
def vertex(y,z):return (Vector((8,y,z)),[Vector((y*.3,z*.2))],Vector((1,0,0)))
face=[vertex(39.5,-2),vertex(42,0),vertex(39.5,2)]
center=sum((v[0] for v in face),Vector())/3
assert math.hypot(center.y-29.79,center.z)<10.7,'fixture must reproduce old whole-face loss'
_,parts=clip.partition(face,boundary.cylinder(29.79,0,10.7,10.7))
assert parts,'wheel-crossing source face must retain its exterior surface'
assert any(abs(v[0].y-42)<1e-6 for poly in parts for v in poly),'outside tip must survive'
for poly in parts:
    for co,uv,n in poly:
        assert math.hypot(co.y-29.79,co.z)>=10.7-1e-5,'wheel opening remains empty'
        assert (uv[0]-Vector((co.y*.3,co.z*.2))).length<1e-5,'source UV interpolation'
        assert abs(n.length-1)<1e-6,'source normal interpolation'

def snapshot():
    scene=bpy.data.scenes['SV3_ProductionRig'];bpy.context.window.scene=scene;scene.frame_set(1)
    result={}
    for o in scene.objects:
        if o.type!='MESH' or o.name in {'SV3_Hull','SV3_CaptainRoof'}:continue
        m=o.data;h=hashlib.sha256()
        for v in m.vertices:h.update(struct.pack('<3f',*v.co))
        for p in m.polygons:
            h.update(struct.pack('<II',len(p.vertices),p.material_index))
            h.update(struct.pack('<'+'I'*len(p.vertices),*p.vertices))
        for layer in m.uv_layers:
            h.update(layer.name.encode('utf-8'))
            for u in layer.data:h.update(struct.pack('<2f',*u.uv))
        if m.shape_keys:
            for k in m.shape_keys.key_blocks:
                h.update(k.name.encode('utf-8'))
                for v in k.data:h.update(struct.pack('<3f',*v.co))
        result[o.name]=h.hexdigest()
    return result

args=sys.argv[sys.argv.index('--')+1:]
before=Path(args[args.index('--before')+1]).resolve()
after=snapshot();bpy.ops.wm.open_mainfile(filepath=str(before));original=snapshot()
assert original.keys()==after.keys(),'unrelated mesh set changed'
assert all(original[n]==after[n] for n in original),'unrelated mesh geometry/UV/morph changed'
print('PASS voyage cut boundaries',json.dumps({'wheelCrossingFacePreserved':True,'unchangedMeshes':len(original),'before':str(before)},ensure_ascii=False))
