"""Restore retained ship geometry from the source archives and existing recipes.

Withdraw the rejected reference galleries/cabins/rods and return to the previous
platform. Nothing is redesigned: reconstruction uses the same stored source
meshes and the same earlier boundary and wheel recipes.
"""
import bpy, math, json, ast, importlib.util
from pathlib import Path
from mathutils import Vector, Matrix


def _module(path,name):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


def restore_retained_structure(scene):
    base=Path(__file__).resolve().parent
    hull=scene.objects['SV3_Hull']
    if bpy.data.meshes.get('SV3_OriginalPartSource_Hull'):
        return
    if not hull.data.name.startswith('SV3_Hull_SeparatedStern'):
        return
    for obj in list(scene.objects):
        if obj.name.startswith('SV3_Reference_'):bpy.data.objects.remove(obj,do_unlink=True)
    old=bpy.data.objects['BeforeCaptainRepair_Hull'].data
    source=bpy.data.objects['BeforeRepair_SV3_Hull'].data
    # Use the same welded fragment audit as the established captain-boundary
    # recipe. This only restores its former output, without rerunning room/UI.
    keys={};vkeys=[]
    for v in old.vertices:
        k=tuple(round(x,4) for x in v.co);vkeys.append(keys.setdefault(k,len(keys)))
    parents=list(range(len(keys)))
    def find(i):
        while parents[i]!=i:parents[i]=parents[parents[i]];i=parents[i]
        return i
    for p in old.polygons:
        vs=[vkeys[v] for v in p.vertices];a=find(vs[0])
        for v in vs[1:]:parents[find(v)]=a
    components={}
    for p in old.polygons:components.setdefault(find(vkeys[p.vertices[0]]),[]).append(p.index)
    fragments=set()
    for ids in components.values():
        if len(ids)>8:continue
        pts=[old.vertices[i].co for j in ids for i in old.polygons[j].vertices]
        if min(v.z for v in pts)>15 and max(v.z for v in pts)<20:fragments.update(ids)
    clip=_module(base/'clip_voyage_hull.py','restore_clip')
    boundary=_module(base/'repair_voyage_cut_boundaries.py','restore_boundary')
    repaired,_=boundary.repair(old,source,clip,fragments)
    hull.data,roof=clip.refine_hull(repaired,set())
    bpy.data.meshes.remove(roof)
    # Reuse only the earlier pure geometry constructors and its exact wheel
    # loop. Do not run the old script's broad Hull changes or save/export.
    tree=ast.parse((base/'repair_sky_ship_structure.py').read_text(encoding='utf-8'))
    definitions=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in {'preserve','make_mesh','morph','child','tube'}]
    materials={k:bpy.data.materials['SV3_Prototype_'+k] for k in ['SparWood','SailLinen','BrassTrim','NavyIron','AmberCrystal','HullIvory','SternWalnut']}
    scope={'bpy':bpy,'math':math,'json':json,'Vector':Vector,'Matrix':Matrix,'scene':scene,'archive':bpy.data.scenes['SV3_BeforeStructureRepair'],'M':materials}
    exec(compile(ast.Module(body=definitions,type_ignores=[]),'retained_geometry_functions','exec'),scope)
    for side in ['Port','Starboard']:
        child=bpy.data.objects.get('SV3_Wheel_'+side+'_TimberSpokesAndHub')
        if child:bpy.data.objects.remove(child,do_unlink=True)
    wheel_loop=next(node for node in tree.body if isinstance(node,ast.For) and isinstance(node.target,ast.Name) and node.target.id=='suffix' and any(isinstance(n,ast.Constant) and n.value=='SV3_Wheel_' for n in ast.walk(node)))
    exec(compile(ast.Module(body=[wheel_loop],type_ignores=[]),'retained_wheel_recipe','exec'),scope)
    # Restore the former roof deck verbatim, retaining its original dimensions.
    if not scene.objects.get('SV3_Repaired_SternRoofDeck'):
        v=[(0,-55,15.25)]+[(12*math.cos(i*math.tau/48),-55+17*math.sin(i*math.tau/48),15.25) for i in range(48)]
        f=[((0,i+1,(i+1)%48+1),0) for i in range(48)]
        scope['child']('SV3_Repaired_SternRoofDeck',hull,v,f,[materials['SternWalnut']])
    # Retain only the former narrow socket axles. The unwanted backing discs
    # are explicitly removed under the user's latest instruction.
    socket=scene.objects.get('SV3_Repaired_WheelHullSockets')
    if socket:bpy.data.objects.remove(socket,do_unlink=True)
    v=[];f=[];u=[]
    for side in [-1,1]:scope['tube'](v,f,(side*4.6,29.79,0),(side*9.68,29.79,0),1.3,0,16,u)
    scope['child']('SV3_Repaired_WheelHullSockets',hull,v,f,[materials['SparWood']],uvs=u)
    # Restore the material setup used by the previous retained source, before
    # this round's rejected whole-ship reference-material recipe.
    _module(base/'voyage_material_refinement.py','retained_materials').refine_materials(scene)
    print('RETAINED_STRUCTURE_RESTORED',json.dumps({'hull_faces':len(hull.data.polygons),'platform_roof_restored':True,'replacement_geometry_removed':True,'source':'BeforeCaptainRepair_Hull + established boundary recipes'},ensure_ascii=False))
