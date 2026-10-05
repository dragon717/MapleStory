"""Bounded native correction of the original lookout and existing mast stays.

No cloth, hull or platform reconstruction. Split whole original faces, retain
UVs/normals, centre the lookout, and normalise only the four existing stays for
endpoint constraints. Blender preview and runtime use the same morph anchors.
"""
import bpy, json, math, importlib.util, hashlib, array
from pathlib import Path
from mathutils import Vector
from collections import Counter
ROOT=Path(__file__).resolve().parents[3]

def module(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

def gltf(v):return [float(v.x),float(v.z),float(-v.y)]
def fingerprint(obj):
    values=array.array('f',[0])*(len(obj.data.vertices)*3);obj.data.vertices.foreach_get('co',values)
    return hashlib.sha256(values.tobytes()).hexdigest()

def apply_mast(scene):
    split=module('separate_voyage_original_parts')
    hull=scene.objects['SV3_Hull'];mast=scene.objects['SV3_Repaired_MainMastAndStays']
    before={o.name:fingerprint(o) for o in scene.objects if o.type=='MESH' and o not in [hull,mast]}
    report={}
    nest=scene.objects.get('SV3_CrowNest')
    if nest is None:
        old=hull.data
        crown=[p for p in old.polygons if p.center.z>44 and abs(p.center.x)<6 and -17<p.center.y<-4]
        assert len(crown)>1000,'original lookout faces not found'
        crown_indices={p.index for p in crown}
        keep=[p for p in old.polygons if p.index not in crown_indices]
        nest=bpy.data.objects.new('SV3_CrowNest',split.subset_mesh(old,crown,'SV3_CrowNest_OriginalFaces'))
        scene.collection.objects.link(nest);nest.parent=hull
        hull.data=split.subset_mesh(old,keep,'SV3_Hull_WithoutCrowNest')
        assert Counter(split.face_signature(old,p) for p in old.polygons)==Counter(split.face_signature(o.data,p) for o in [hull,nest] for p in o.data.polygons)
        # Finial is the authored axis, rather than the torn lower mesh skirt.
        tip=[v.co for v in nest.data.vertices if v.co.z>51]
        centre=Vector(((min(v.x for v in tip)+max(v.x for v in tip))/2,(min(v.y for v in tip)+max(v.y for v in tip))/2,0))
        nest.location=Vector((0,-10.5,0))-centre
        nest['split_from']='SV3_Hull';nest['lookout_axis_design']=[0,-10.5]
        nest['original_face_uv_contract']='entire original faces and UV retained; axis translated onto mast'
        report['lookout']={'faces':len(crown),'axis_before':list(centre),'translation':list(nest.location),'original_faces_uv_preserved':True}
    if not scene.objects.get('SV3_MastStayAnchor'):
        def anchor(name,parent,position):
            o=bpy.data.objects.new(name,None);scene.collection.objects.link(o);o.parent=parent;o.location=position;o.empty_display_size=.25;return o
        origin=Vector((0,-10.5,46.8));start=anchor('SV3_MastStayAnchor',hull,origin)
        fan=scene.objects['SV3_MainFan_0'];spar=scene.objects['SV3_MainFan_0_TimberSpars']
        targets=[anchor('SV3_MainFan_RootAnchor',fan,(0,0,0))]
        for sign,label in [(-1,'Port'),(1,'Starboard')]:
            tip=Vector((sign*10,-40,43))-fan.location
            indices=[v.index for v in spar.data.vertices if (v.co-tip).length<.45]
            assert len(indices)==12,(label,indices)
            base=sum((spar.data.vertices[i].co for i in indices),Vector())/len(indices)
            fold=sum((spar.data.shape_keys.key_blocks['DeployFold'].data[i].co for i in indices),Vector())/len(indices)
            o=anchor('SV3_MainFan_TipAnchor_'+label,fan,base)
            o['rig_morph_owner']=spar.name;o['rig_morph_rest']=gltf(base);o['rig_morph_delta']=gltf(fold-base)
            # Native Blender uses the actual spar key value, including the
            # authored interpolation; no independent copied animation curve.
            for axis in range(3):
                d=o.driver_add('location',axis).driver;d.type='SCRIPTED'
                variable=d.variables.new();variable.name='fold';variable.type='SINGLE_PROP'
                variable.targets[0].id_type='KEY';variable.targets[0].id=spar.data.shape_keys
                variable.targets[0].data_path='key_blocks["DeployFold"].value'
                d.expression=f'{base[axis]:.12g}+fold*{fold[axis]-base[axis]:.12g}'
            targets.append(o)
        targets.append(anchor('SV3_AftFan_RootAnchor',scene.objects['SV3_AftFan_0'],(0,0,0)))
        old=mast.data
        # Each disconnected cylinder has its own original vertex range. Keep
        # the mast/collars, and move all four stay faces without regeneration.
        faces=[p for p in old.polygons if min(p.vertices)>=160]
        stay_faces=[]
        for i,target in enumerate(targets):
            lo=160+i*16;subset=[p for p in faces if min(p.vertices)>=lo and max(p.vertices)<lo+16]
            assert len(subset)==10,(i,len(subset))
            mesh=split.subset_mesh(old,subset,'SV3_MastStay_'+str(i)+'_OriginalFaces');stay_faces.extend(subset)
            o=bpy.data.objects.new('SV3_MastStay_'+str(i),mesh);scene.collection.objects.link(o);o.parent=hull
            end=sum((old.vertices[j].co for j in range(lo+8,lo+16)),Vector())/8
            direction=end-origin;length=direction.length;q=Vector((0,0,1)).rotation_difference(direction.normalized())
            inverse=q.inverted()
            for v in mesh.vertices:
                v.co=inverse@(v.co-origin);v.co.z/=length
            # Explicit custom split normals follow the same inverse rotation.
            mesh.normals_split_custom_set([inverse@old.corner_normals[k].vector for p in subset for k in p.loop_indices])
            o.location=origin;o.rotation_mode='QUATERNION';o.rotation_quaternion=q;o.scale=(1,1,length)
            o['rig_link_start']=start.name;o['rig_link_end']=target.name
            o['original_face_uv_contract']='existing tube only; normalised longitudinal axis, original grain UV retained'
            c=o.constraints.new('COPY_LOCATION');c.target=start
            c=o.constraints.new('DAMPED_TRACK');c.target=target;c.track_axis='TRACK_Z'
            d=o.driver_add('scale',2).driver;d.type='SCRIPTED';v=d.variables.new();v.name='length';v.type='LOC_DIFF';v.targets[0].id=start;v.targets[1].id=target;d.expression='length'
        mast.data=split.subset_mesh(old,[p for p in old.polygons if min(p.vertices)<160],'SV3_FixedMastAndCollars')
        assert len(mast.data.polygons)+len(stay_faces)==len(old.polygons)
        report['stays']={'existing_stays':4,'mast_and_collars_faces':len(mast.data.polygons),'tip_anchors':'sampled from original spar DeployFold end rings','native_constraints':'copy location + damped track + endpoint distance; radial thickness fixed'}
    for name,value in before.items():assert fingerprint(scene.objects[name])==value,name+' unrelated geometry changed'
    report['unchanged_meshes']=len(before)
    scene['mast_connections_revision']='centred original lookout; four existing stays constrained to live morph endpoints'
    print('MAST_CONNECTIONS_READY',json.dumps(report,ensure_ascii=False))
    return report

def save_export(scene):
    bpy.context.window.scene=scene;scene.frame_set(1)
    ship=scene.objects['SV2_Ship']
    owned={ship, *ship.children_recursive}
    for o in scene.objects:o.select_set(o in owned and o.type in {'MESH','EMPTY'})
    bpy.context.view_layer.objects.active=scene.objects['SV2_Ship'];bpy.context.preferences.filepaths.save_version=0
    bpy.ops.file.pack_all();dest=ROOT/'resources/scenes/sky-voyage-v3/models'
    bpy.ops.wm.save_as_mainfile(filepath=str(dest/'sky-voyage.blend'),compress=True)
    bpy.ops.export_scene.gltf(filepath=str(dest/'sky-voyage.glb'),export_format='GLB',use_selection=True,use_active_scene=True,export_yup=True,export_extras=True,export_apply=False,export_animations=True)

if __name__=='__main__':
    scene=bpy.data.scenes['SV3_ProductionRig'];bpy.context.window.scene=scene;scene.frame_set(1)
    report=apply_mast(scene)
    report['route']=module('author_voyage_structural_routes').author(scene)
    report['wheels']=module('refine_voyage_wheel_rear_orientation').apply(scene)
    save_export(scene)
    evidence=ROOT/'evidence/2026-10-04/voyage-mast-light-labels';evidence.mkdir(parents=True,exist_ok=True)
    (evidence/'native-model-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
