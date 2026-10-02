# Execute in the live Blender MCP after prepare_user_sky_ship.py.
import bpy
import math
from mathutils import Vector

SV3_OUT = '/Users/muniao/Code/MapleStory/resources/scenes/sky-voyage-v3'
previous=bpy.data.scenes.get('SV3_ProductionRig')
if previous:
    bpy.context.window.scene=bpy.data.scenes['SV3_ShipRig']
    for obj in list(previous.objects):
        bpy.data.objects.remove(obj,do_unlink=True)
    bpy.data.scenes.remove(previous)
SV3_SCENE = bpy.data.scenes.new('SV3_ProductionRig')
bpy.context.window.scene = SV3_SCENE
bpy.ops.wm.obj_import(filepath=SV3_OUT+'/models/ship-parts.obj', forward_axis='Y', up_axis='Z')
SV3_PARTS = [o for o in SV3_SCENE.objects if o.type == 'MESH']
print('SV3_IMPORTED',len(SV3_PARTS),sum(len(o.data.polygons) for o in SV3_PARTS))
assert len(SV3_PARTS) == 18
assert sum(len(o.data.polygons) for o in SV3_PARTS) == 285840

SV3_NORMAL = bpy.data.images.load(SV3_OUT+'/vendor/user-ship/texture_pbr_20250901_normal.png',check_existing=True)
SV3_NORMAL.colorspace_settings.name='Non-Color'
SV3_MATERIALS = {}
for name,tile,color,metal,rough in [
    ('Enamel','enamel',(.96,.96,.96,1),.08,.43),
    ('Brass','brass',(.95,.88,.7,1),.82,.32),
    ('Wood','wood',(.84,.74,.64,1),0,.68),
    ('Linen','linen',(1,1,.98,1),0,.9),
    ('Sapphire',None,(.027,.30,.52,1),.35,.2),
    ('Jade',None,(.018,.32,.23,1),.4,.24),
    ('Navy',None,(.024,.058,.095,1),.65,.42),
    ('Amber',None,(.95,.18,.026,1),.15,.26),
]:
    mat=bpy.data.materials.get('SV3_M_'+name) or bpy.data.materials.new('SV3_M_'+name)
    mat.use_nodes=True
    mat.diffuse_color=color
    nodes=mat.node_tree.nodes
    nodes.clear()
    output=nodes.new('ShaderNodeOutputMaterial')
    shader=nodes.new('ShaderNodeBsdfPrincipled')
    mat.node_tree.links.new(shader.outputs['BSDF'],output.inputs['Surface'])
    shader.inputs['Base Color'].default_value=color
    shader.inputs['Metallic'].default_value=metal
    shader.inputs['Roughness'].default_value=rough
    if tile:
        texture=nodes.new('ShaderNodeTexImage')
        texture.image=bpy.data.images.load(SV3_OUT+'/textures/'+tile+'.png',check_existing=True)
        texture.image.colorspace_settings.name='sRGB'
        mat.node_tree.links.new(texture.outputs['Color'],shader.inputs['Base Color'])
    if name not in {'Linen','Amber'}:
        texture=nodes.new('ShaderNodeTexImage')
        texture.image=SV3_NORMAL
        uvnode=nodes.new('ShaderNodeUVMap')
        uvnode.uv_map='SourceUV'
        normal=nodes.new('ShaderNodeNormalMap')
        normal.uv_map='SourceUV'
        normal.inputs['Strength'].default_value=.22
        mat.node_tree.links.new(uvnode.outputs['UV'],texture.inputs['Vector'])
        mat.node_tree.links.new(texture.outputs['Color'],normal.inputs['Color'])
        mat.node_tree.links.new(normal.outputs['Normal'],shader.inputs['Normal'])
    if name=='Amber':
        shader.inputs['Emission Color'].default_value=(.85,.075,.006,1)
        shader.inputs['Emission Strength'].default_value=.65
    mat.use_backface_culling=False
    SV3_MATERIALS[name]=mat

SV3_SCALE=150/.851965
SV3_CENTRE=.0708055

def SV3_fold_delta(world):
    x=world.y/SV3_SCALE+SV3_CENTRE
    y=world.z/SV3_SCALE+.46
    z=world.x/SV3_SCALE
    if -.17<x<.25 and y>.503:
        pivot=Vector((0,(.216-SV3_CENTRE)*SV3_SCALE,(.626-.46)*SV3_SCALE))
        weight=min(1,max(0,(y-.513)/.04))*min(1,(x+.17)/.018)*min(1,(.25-x)/.018)
        if abs(x-.011)<.024 and abs(z)<.055:
            weight=0
        median=math.pi
    elif x<-.174 and y>.58:
        pivot=Vector((0,(-.209-SV3_CENTRE)*SV3_SCALE,(.58-.46)*SV3_SCALE))
        weight=min(1,max(0,(y-.58)/.022))*min(1,(-.174-x)/.025)
        median=math.radians(110)
    else:
        return Vector((0,0,0))
    local=world-pivot
    angle=math.atan2(local.z,local.y) % (2*math.pi)
    if median==math.pi:
        weight*=min(1,max(0,(math.radians(40)-abs(angle-median))/math.radians(8)))
    radius=math.hypot(local.y,local.z)
    angle=median+(angle-median)*.32
    target=Vector((world.x,pivot.y+radius*math.cos(angle),pivot.z+radius*math.sin(angle)))
    return (target-world)*weight

for obj in SV3_PARTS:
    obj.name=obj.name.split('.')[0]
    name=obj.name[4:]
    old=[m.name.removeprefix('SV3_').split('.')[0] for m in obj.data.materials]
    for i,key in enumerate(old):
        obj.data.materials[i]=SV3_MATERIALS[key]
    source=obj.data.uv_layers.active
    source.name='SourceUV'
    mapped=obj.data.uv_layers.new(name='MaterialUV')
    for polygon in obj.data.polygons:
        normal_axes=[abs(polygon.normal[i]) for i in range(3)]
        ax=normal_axes.index(max(normal_axes))
        for loop in polygon.loop_indices:
            co=obj.data.vertices[obj.data.loops[loop].vertex_index].co
            mapped.data[loop].uv=(co.y/12,(co.z if ax==0 else co.x)/12)
        polygon.use_smooth=True
    obj.data.uv_layers.active=mapped
    mapped.active_render=True
    source.active_render=False
    if name.startswith('MainFan'):
        pivot=(.216,.626,0)
        fold=0
        kind='fan'
    elif name.startswith('AftFan'):
        pivot=(-.209,.58,0)
        fold=0
        kind='fan'
    elif name in {'Hull','Crystal'}:
        pivot=(SV3_CENTRE,.46,0) if name=='Hull' else (0,.36,0)
        fold=0
        kind='fixed'
    else:
        side=-1 if name.endswith('Port') else 1
        prefix=name.split('_')[0]
        x,y={'Wheel':(.24,.46),'BowVane':(.376,.427),'AftVane':(-.134,.412),'Engine':(-.005,.435),'Nozzle':(.071,.435)}[prefix]
        pivot=(x,y,.055*side)
        kind={'Wheel':'wheel','BowVane':'rudder','AftVane':'rudder','Engine':'fixed','Nozzle':'nozzle'}[prefix]
        fold=.4*side if kind=='rudder' else 0
    location=Vector((pivot[2]*SV3_SCALE,(pivot[0]-SV3_CENTRE)*SV3_SCALE,(pivot[1]-.46)*SV3_SCALE))
    for vertex in obj.data.vertices:
        vertex.co-=location
    obj.location=location
    obj['rig_kind']=kind
    obj['fold_angle']=fold
    obj['source_triangles']=len(obj.data.polygons)
    obj['source_model']='user OBJ main connected component; original triangles retained'
    if kind=='wheel':
        yaw=bpy.data.objects.new(obj.name+'_Steering',None)
        SV3_SCENE.collection.objects.link(yaw)
        yaw.location=location
        yaw['rig_kind']='steering'
        obj.parent=yaw
        obj.location=(0,0,0)
    if kind in {'fan','rudder'} or name=='Hull':
        obj.shape_key_add(name='Basis')
        if kind=='fan' or name=='Hull':
            folded=obj.shape_key_add(name='DeployFold')
            for index,vertex in enumerate(obj.data.vertices):
                folded.data[index].co+=SV3_fold_delta(vertex.co+location)
            obj['fold_morph']='DeployFold'
    if kind in {'fan','rudder'}:
        pressure=obj.shape_key_add(name='WindPressure')
        cloth=set()
        frame=set()
        for polygon in obj.data.polygons:
            target=cloth if obj.data.materials[polygon.material_index].name=='SV3_M_Linen' else frame
            target.update(polygon.vertices)
        ymax=max(v.co.y for v in obj.data.vertices)
        ymin=min(v.co.y for v in obj.data.vertices)
        zmax=max(v.co.z for v in obj.data.vertices)
        zmin=min(v.co.z for v in obj.data.vertices)
        pins=obj.vertex_groups.new(name='FramePins')
        if frame:
            pins.add(sorted(frame),1,'REPLACE')
        for index in cloth-frame:
            co=obj.data.vertices[index].co
            u=(co.y-ymin)/max(.01,ymax-ymin)
            v=(co.z-zmin)/max(.01,zmax-zmin)
            weight=max(0,math.sin(math.pi*u)*math.sin(math.pi*v))
            pressure.data[index].co.x+=(-1 if co.x<0 else 1)*weight*1.6
        obj['wind_morph']='WindPressure'
    for frame,deploy,turn in [(1,1,0),(40,0,0),(65,1,-.8),(95,1,.8),(120,1,0)]:
        obj.rotation_euler=(fold*(1-deploy),0,turn*.38 if kind in {'rudder','nozzle'} else 0)
        obj.keyframe_insert(data_path='rotation_euler',frame=frame,group='Deployment and steering')
        if obj.data.shape_keys:
            if kind in {'fan','rudder'}:
                pressure=obj.data.shape_keys.key_blocks['WindPressure']
                pressure.value=deploy*.65
                pressure.keyframe_insert(data_path='value',frame=frame)
            if kind=='fan' or name=='Hull':
                folded=obj.data.shape_keys.key_blocks['DeployFold']
                folded.value=1-deploy
                folded.keyframe_insert(data_path='value',frame=frame)
        if obj.parent:
            obj.parent.rotation_euler.z=turn*.38
            obj.parent.keyframe_insert(data_path='rotation_euler',frame=frame)

SV3_SCENE.frame_start=1
SV3_SCENE.frame_end=120
SV3_SCENE.render.fps=24
SV3_SCENE.frame_set(1)
SV3_WORLD=bpy.data.worlds.new('SV3_World')
SV3_WORLD.use_nodes=True
background=next(n for n in SV3_WORLD.node_tree.nodes if n.type=='BACKGROUND')
background.inputs['Color'].default_value=(.34,.46,.57,1)
background.inputs['Strength'].default_value=.7
SV3_SCENE.world=SV3_WORLD
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type=='VIEW_3D':
            space=area.spaces.active
            space.region_3d.view_location=Vector((0,0,15))
            space.region_3d.view_distance=210
            space.region_3d.view_rotation=(Vector((0,0,15))-Vector((180,145,110))).to_track_quat('-Z','Y')
            space.region_3d.view_perspective='ORTHO'
            space.clip_end=20000
            space.shading.type='MATERIAL'
            space.overlay.show_overlays=False
bpy.ops.file.pack_all()
bpy.ops.wm.save_as_mainfile(filepath=SV3_OUT+'/models/sky-voyage.blend',compress=True)
print('SV3_RIG_OK',[(o.name,o['rig_kind'],len(o.data.polygons)) for o in SV3_PARTS])
