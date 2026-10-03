"""Map one image across the existing three cloth patches; keep rig and mesh."""
import bpy


def place_single_crest(scene):
    ship=scene.objects['SV2_Ship']
    bpy.context.view_layer.update()
    inverse=ship.matrix_world.inverted()
    for sector in range(3):
        obj=scene.objects[f'SV3_MainSail_Crest_{sector}']
        frame=inverse @ obj.matrix_world
        art=obj.data.uv_layers.get('Emblem') or obj.data.uv_layers.active
        for loop in obj.data.loops:
            point=frame @ obj.data.vertices[loop.vertex_index].co
            art.data[loop.index].uv=(max(0,min(1,.5+(point.y+13)/16)),max(0,min(1,.5+(point.z-26)/16)))
        obj['emblem_single_image']=True
        obj['structural_repair_child']=True
        obj['emblem_ship_center_yz']=[-13,26]
        obj['emblem_ship_size']=16
        obj['emblem_rotation_degrees']=0
        obj['emblem_delta_clockwise_degrees']=90
        obj['emblem_sampler']='CLAMP_TO_EDGE'
    material=bpy.data.materials['SV3_MainSail_MapleDecal']
    # Blender's dithered preview made transparent pixels appear as black
    # over the linen. Standard alpha blending also exports as glTF BLEND.
    material.surface_render_method='BLENDED'
    nodes=material.node_tree.nodes;links=material.node_tree.links
    texture=next(n for n in nodes if n.type=='TEX_IMAGE')
    shader=next(n for n in nodes if n.type=='BSDF_PRINCIPLED')
    texture.extension='CLIP'
    uv=next((n for n in nodes if n.type=='UVMAP'),None) or nodes.new('ShaderNodeUVMap')
    uv.uv_map=art.name
    for socket in [texture.inputs['Vector'],shader.inputs['Alpha']]:
        for link in list(socket.links):links.remove(link)
    links.new(uv.outputs['UV'],texture.inputs['Vector'])
    links.new(texture.outputs['Alpha'],shader.inputs['Alpha'])
    linen=scene.objects['SV3_AftFan_0'].data.materials[0]
    for sector in range(3):
        obj=scene.objects[f'SV3_MainFan_{sector}']
        obj.data.materials.clear();obj.data.materials.append(linen)
        for p in obj.data.polygons:p.material_index=0
    print('SINGLE_CREST_READY: shared linen; existing cloth geometry and morphs retained; one 16m image at ship Y=-13, Z=26; additional clockwise 90 degrees')
