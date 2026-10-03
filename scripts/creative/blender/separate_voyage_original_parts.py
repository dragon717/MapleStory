"""Separate existing ship faces without rebuilding, moving or recolouring them.

Apply to the restored production scene. The original body, stern platform and
engine meshes remain the authority. Only the wheel's old opaque backing disks
are removed. Every face moved to a new object keeps coordinates, UV and normals.
"""
import bpy, hashlib, json, struct
from collections import Counter


def face_signature(mesh, polygon):
    h=hashlib.sha256()
    for i in polygon.loop_indices:
        v=mesh.vertices[mesh.loops[i].vertex_index].co
        h.update(struct.pack('<3f',*v))
        for uv in mesh.uv_layers:h.update(struct.pack('<2f',*uv.data[i].uv))
    h.update(mesh.materials[polygon.material_index].name.encode('utf-8'))
    return h.hexdigest()


def subset_mesh(old, faces, name):
    used=sorted({v for p in faces for v in p.vertices});lookup={v:i for i,v in enumerate(used)}
    mesh=bpy.data.meshes.new(name)
    mesh.from_pydata([old.vertices[i].co.copy() for i in used],[],[[lookup[i] for i in p.vertices] for p in faces]);mesh.update()
    for material in old.materials:mesh.materials.append(material)
    for layer in old.uv_layers:
        target=mesh.uv_layers.new(name=layer.name)
        for dst,src in zip(mesh.polygons,faces):
            for a,b in zip(dst.loop_indices,src.loop_indices):target.data[a].uv=layer.data[b].uv
        target.active_render=layer.active_render
    if old.uv_layers.active:mesh.uv_layers.active=mesh.uv_layers.get(old.uv_layers.active.name)
    normals=[]
    for dst,src in zip(mesh.polygons,faces):
        dst.material_index=src.material_index;dst.use_smooth=src.use_smooth
        normals.extend(old.corner_normals[i].vector.copy() for i in src.loop_indices)
    mesh.normals_split_custom_set(normals)
    # Retain source FACE labels when present; indices become local to each part.
    for attr in old.attributes:
        if attr.domain=='FACE' and attr.data_type=='INT':
            target=mesh.attributes.new(attr.name,'INT','FACE')
            for dst,src in zip(mesh.polygons,faces):target.data[dst.index].value=attr.data[src.index].value
    return mesh


def split_object(scene,obj,classify,retained):
    old=obj.data;before=Counter(face_signature(old,p) for p in old.polygons);groups={}
    for p in old.polygons:groups.setdefault(classify(p),[]).append(p)
    results=[]
    for key,faces in groups.items():
        data=subset_mesh(old,faces,obj.name+'_'+key+'_Mesh')
        if key==retained:
            obj.data=data;target=obj
        else:
            target=bpy.data.objects.new(obj.name+'_'+key,data);scene.collection.objects.link(target);target.parent=obj
        target['original_part']=key;target['split_from']=obj.name;target['split_geometry_contract']='existing faces only; exact positions/UV preserved'
        if target is not obj:target['structural_repair_child']=True
        results.append(target)
    after=Counter(face_signature(part.data,p) for part in results for p in part.data.polygons)
    assert before==after,obj.name+' separation changed original faces or UV'
    return {'object':obj.name,'parts':{part.name:len(part.data.polygons) for part in results},'original_faces':sum(before.values()),'geometry_and_uv_identical':True}


def apply_original_parts(scene):
    hull=scene.objects['SV3_Hull'];reports=[]
    # Keep one editable in-file authority per source so rerunning separation
    # never works from a previously reduced body or duplicates child parts.
    for name in ['SV3_Hull','SV3_Engine_Port','SV3_Engine_Starboard']:
        obj=scene.objects[name];key='SV3_OriginalPartSource_'+name.removeprefix('SV3_')
        data=bpy.data.meshes.get(key)
        if data is None:
            data=obj.data.copy();data.name=key;data.use_fake_user=True
        obj.data=data.copy()
        for child in list(obj.children):
            if child.get('split_from')==name:bpy.data.objects.remove(child,do_unlink=True)
    # The stern is already a curved stacked platform in the source mesh.
    # Move those entire original polygons to a child, retaining all galleries,
    # fascia, windows and the former upper roof deck exactly as authored.
    reports.append(split_object(scene,hull,lambda p:'SternPlatform' if p.center.y<-39.0 else 'Body','Body'))
    for side in ['Port','Starboard']:
        engine=scene.objects['SV3_Engine_'+side]
        # Retained FACE labels survive the rejected all-ivory repaint. Restore
        # those original regions, rather than classifying by height or colour.
        labels=engine.data.attributes['PrototypeMaterialRegion']
        regions={0:('Shell','HullIvory'),5:('MetalBand','BrassTrim'),6:('EndCap','NavyIron')}
        for p in engine.data.polygons:
            part,semantic=regions[labels.data[p.index].value]
            mat=bpy.data.materials['SV3_Prototype_'+semantic]
            index=engine.data.materials.find(mat.name)
            if index<0:engine.data.materials.append(mat);index=len(engine.data.materials)-1
            p.material_index=index
        def engine_part(p):
            return regions[labels.data[p.index].value][0]
        reports.append(split_object(scene,engine,engine_part,'Shell'))
    # This old repair added two opaque 10.7 m discs behind the existing sails.
    # Delete those original cap/ring faces only, retaining the narrow axle.
    socket=scene.objects.get('SV3_Repaired_WheelHullSockets')
    if socket:
        old=socket.data
        keep=[p for p in old.polygons if old.materials[p.material_index].name.endswith('SparWood')]
        removed=len(old.polygons)-len(keep);socket.data=subset_mesh(old,keep,socket.name+'_AxlesOnly')
        socket['removed_backing_disks']=2;socket['retained_original_axle_faces']=len(keep)
        reports.append({'object':socket.name,'removed_disk_faces':removed,'retained_axle_faces':len(keep)})
    # Every other mesh, platform roof, main spar and original wheel cloth stays.
    hull['restored_structure']='original model platform retained; no replacement galleries or cabins'
    scene['original_part_separation']=json.dumps(reports,ensure_ascii=False)
    print('ORIGINAL_PARTS_READY',json.dumps(reports,ensure_ascii=False))
    return reports
