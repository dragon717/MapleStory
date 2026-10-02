"""Restore actual cloth metadata on the repaired sail grids; pin spars and add one main-sail crest."""
import bpy, json, math
from pathlib import Path
ROOT=Path('/Users/muniao/Code/MapleStory');DEST=ROOT/'resources/scenes/sky-voyage-v3'
scene=bpy.data.scenes['SV3_ProductionRig'];bpy.context.window.scene=scene
image=bpy.data.images.load(str(DEST/'textures/maple-crest.png'),check_existing=True)
for prefix in ['MainFan','AftFan']:
    for sector in range(3):
        obj=bpy.data.objects['SV3_'+prefix+'_'+str(sector)]
        # The approved repair is two 33x13 grids, one on each side of the fan.
        assert len(obj.data.vertices)==858
        grid=obj.data.uv_layers.get('ClothGrid') or obj.data.uv_layers.new(name='ClothGrid')
        for loop in obj.data.loops:
            k=loop.vertex_index%429;grid.data[loop.index].uv=(k%13/12,k//13/32)
        obj.data.uv_layers.active=grid;grid.active_render=True
        obj['cloth_columns']=12;obj['cloth_rows']=32;obj['cloth_canvas_vertex_start']=0
        obj['cloth_two_sides']=True;obj['cloth_grid_uv']='uv2'
        obj['cloth_pins']=[i*13+j for i in range(33) for j in range(13) if i in (0,32) or j in (0,12)]
        group=obj.vertex_groups.get('ClothAttachments') or obj.vertex_groups.new(name='ClothAttachments')
        group.add(list(obj['cloth_pins'])+[n+429 for n in obj['cloth_pins']],1,'REPLACE')
        cloth=obj.modifiers.get('EditableCloth') or obj.modifiers.new('EditableCloth','CLOTH')
        cloth.settings.vertex_group_mass=group.name;cloth.settings.quality=5;cloth.settings.mass=.25
        cloth.show_viewport=False;cloth.show_render=False
        obj['cloth_source']='editable pinned Blender cloth; fixed-step runtime grid follows folding ribs'
        # One crest per main fan side, across the central gore; small sails stay unmarked.
        if prefix=='MainFan' and sector==1:
            old=bpy.data.objects.get('SV3_MainSail_Crest')
            if old:bpy.data.objects.remove(old,do_unlink=True)
            decal=obj.copy();decal.data=obj.data.copy();decal.name='SV3_MainSail_Crest';scene.collection.objects.link(decal)
            decal.parent=obj;decal.location=(0,0,0)
            for key in list(decal.keys()):del decal[key]
            decal['cloth_grid_uv']='uv1';decal['main_sail_crest']='existing maple-crest.png; one emblem on each face of main sail'
            decal.modifiers.clear()
            for vertex in decal.data.vertices:vertex.co.x+=math.copysign(.018,vertex.co.x)
            # Grid UV drives cloth; emblem UV crops the image to the central patch.
            for layer in list(decal.data.uv_layers):decal.data.uv_layers.remove(layer)
            art=decal.data.uv_layers.new(name='Emblem');grid=decal.data.uv_layers.new(name='ClothGrid')
            for loop in decal.data.loops:
                k=loop.vertex_index%429;u=k%13/12;v=k//13/32
                art.data[loop.index].uv=(u*3-1,v*2.5-1.3);grid.data[loop.index].uv=(u,v)
            decal.data.uv_layers.active=art;art.active_render=True
            mat=bpy.data.materials.get('SV3_MainSail_MapleDecal') or bpy.data.materials.new('SV3_MainSail_MapleDecal');mat.use_nodes=True
            mat.node_tree.nodes.clear();nodes=mat.node_tree.nodes;links=mat.node_tree.links
            shader=nodes.new('ShaderNodeBsdfPrincipled');shader.inputs['Roughness'].default_value=.85
            tex=nodes.new('ShaderNodeTexImage');tex.image=image;tex.extension='CLIP'
            links.new(tex.outputs['Color'],shader.inputs['Base Color']);links.new(tex.outputs['Alpha'],shader.inputs['Alpha'])
            out=nodes.new('ShaderNodeOutputMaterial');links.new(shader.outputs[0],out.inputs['Surface'])
            mat.surface_render_method='DITHERED';decal.data.materials.clear();decal.data.materials.append(mat)
for obj in scene.objects:obj.select_set(False)
for obj in scene.objects:
    if obj.type in {'MESH','EMPTY'}:obj.select_set(True)
bpy.context.view_layer.objects.active=bpy.data.objects['SV2_Ship']
bpy.ops.file.pack_all()
bpy.ops.wm.save_as_mainfile(filepath=str(DEST/'models/sky-voyage.blend'),compress=True)
bpy.ops.export_scene.gltf(filepath=str(DEST/'models/sky-voyage.glb'),export_format='GLB',use_selection=True,use_active_scene=True,export_yup=True,export_extras=True,export_apply=False,export_animations=True)
print('VOYAGE_SAIL_CLOTH_OK',6,'sail grids, main crest, pinned rigid spars')
