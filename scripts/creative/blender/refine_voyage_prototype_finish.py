"""Finish the retained ship by component; never regenerate its silhouette or rig.

Run against the current saved SV3_ProductionRig. Original vertices, SourceUV,
anchors and morphs stay authoritative. The three curved stern fascias are
painted on their existing faces, not replaced by new cylinders or galleries.
The caller can use --dry-run to inspect without saving/exporting.
"""
import bpy, math, json, hashlib, array, sys, importlib.util
from collections import Counter
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[3]
DEST = ROOT / 'resources/scenes/sky-voyage-v3'
REFERENCE = 'resources/scenes/sky-voyage-v2/design/ship-orthographic-v1.png'

def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); return mod

def geometry(obj):
    m = obj.data; values = array.array('f', [0]) * (len(m.vertices) * 3)
    m.vertices.foreach_get('co', values)
    h = hashlib.sha256(values.tobytes())
    for p in m.polygons: h.update(array.array('I', p.vertices).tobytes())
    if m.shape_keys:
        for key in m.shape_keys.key_blocks:
            key.data.foreach_get('co', values); h.update(values.tobytes())
    uv = m.uv_layers.get('SourceUV')
    if uv:
        values = array.array('f', [0]) * (len(m.loops) * 2)
        uv.data.foreach_get('uv', values); h.update(values.tobytes())
    return h.hexdigest()

def material(name, color, roughness, metallic=0, texture=None, normal_strength=.12):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True; nodes = m.node_tree.nodes; nodes.clear(); links = m.node_tree.links
    sh = nodes.new('ShaderNodeBsdfPrincipled'); out = nodes.new('ShaderNodeOutputMaterial')
    links.new(sh.outputs['BSDF'], out.inputs['Surface'])
    sh.inputs['Base Color'].default_value = (*color, 1)
    sh.inputs['Roughness'].default_value = roughness; sh.inputs['Metallic'].default_value = metallic
    if texture:
        uv = nodes.new('ShaderNodeUVMap'); uv.uv_map = 'MaterialUV'
        def image_node(suffix, non_color=False):
            path = DEST / 'textures' / (texture + '-' + suffix + '.png')
            assert path.exists(), str(path)
            n = nodes.new('ShaderNodeTexImage'); n.image = bpy.data.images.load(str(path), check_existing=True)
            n.image.colorspace_settings.name = 'Non-Color' if non_color else 'sRGB'
            n.extension = 'REPEAT'; links.new(uv.outputs['UV'], n.inputs['Vector']); return n
        links.new(image_node('basecolor').outputs['Color'], sh.inputs['Base Color'])
        normal = nodes.new('ShaderNodeNormalMap'); normal.uv_map = 'MaterialUV'
        normal.inputs['Strength'].default_value = normal_strength
        links.new(image_node('normal', True).outputs['Color'], normal.inputs['Color'])
        links.new(normal.outputs['Normal'], sh.inputs['Normal'])
        rough = DEST / 'textures' / (texture + '-roughness.png')
        if rough.exists(): links.new(image_node('roughness', True).outputs['Color'], sh.inputs['Roughness'])
        metal = DEST / 'textures' / (texture + '-metallic.png')
        if metal.exists(): links.new(image_node('metallic', True).outputs['Color'], sh.inputs['Metallic'])
    if name.endswith(('Ivory', 'Brass', 'Teal')):
        sh.inputs['Coat Weight'].default_value = .18; sh.inputs['Coat Roughness'].default_value = .34
    m.diffuse_color = (*color, 1); m['prototype_reference'] = REFERENCE
    m['finish_recipe'] = 'retained-component-finish-v1'; return m

def set_slot(obj, polygon, mat):
    index = obj.data.materials.find(mat.name)
    if index < 0: obj.data.materials.append(mat); index = len(obj.data.materials) - 1
    polygon.material_index = index

def uv_component(obj, ship, kind):
    """Use component axes: board length, upright grain or engine circumference."""
    mesh = obj.data; uv = mesh.uv_layers.get('MaterialUV') or mesh.uv_layers.new(name='MaterialUV')
    transform = ship.matrix_world.inverted() @ obj.matrix_world
    for p in mesh.polygons:
        normal = transform.to_3x3() @ p.normal
        for li in p.loop_indices:
            local = mesh.vertices[mesh.loops[li].vertex_index].co; co = transform @ local
            if kind == 'engine':
                # Longitudinal Y is the original engine axis; each panel spans
                # 1.5 m axially and about 1.2 m around the original shell.
                x, z = local.x + 1.35, local.z + 1.0
                uv.data[li].uv = (math.atan2(z, x) / math.tau * 3, local.y / 6.0)
            elif kind == 'cloth': uv.data[li].uv = (co.y / .7, co.z / .7)
            elif abs(normal.z) > .65:
                uv.data[li].uv = (co.y / 5.0, co.x / 2.0)
            elif kind == 'mast': uv.data[li].uv = (co.z / 6.0, co.x / 1.5 if abs(normal.y) > abs(normal.x) else co.y / 1.5)
            elif kind == 'spar':
                # Existing spar tube UV already follows its animated endpoints.
                uv.data[li].uv *= .22
            elif kind == 'stern':
                angle = math.atan2(co.x / 15.2, -(co.y + 51.0) / 16.5)
                uv.data[li].uv = (co.z / 5.0, angle * 15.2 / 3.0)
            else:
                # Vertical cabin panels have upright grain, floor faces above
                # retain their independent physical board scale.
                uv.data[li].uv = (co.z / 5.0, (co.x if abs(normal.y) > abs(normal.x) else co.y) / 2.0)
        if kind == 'engine':
            values=[uv.data[i].uv.x for i in p.loop_indices]
            if max(values)-min(values)>1.5:
                for li in p.loop_indices:
                    if uv.data[li].uv.x<0: uv.data[li].uv.x+=3
        if len(p.loop_indices)==3:
            a,b,c=[uv.data[i].uv.copy() for i in p.loop_indices]
            determinant=abs((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x))
            if p.area>1e-5 and determinant/max(p.area,1e-8)<1e-6:
                # Tube end caps and interior returns cannot use longitudinal
                # cylinder UVs. Give those original faces a planar end grain.
                axis=max(range(3),key=lambda i:abs(normal[i]))
                pair=[(1,2),(0,2),(0,1)][axis]
                for li in p.loop_indices:
                    co=transform@mesh.vertices[mesh.loops[li].vertex_index].co
                    uv.data[li].uv=(co[pair[0]]/5,co[pair[1]]/2)
    mesh.uv_layers.active = uv; uv.active_render = True
    obj['finish_uv'] = kind + ': component longitudinal direction; metre-scale repeat'

def stern_regions(obj, mats):
    """Trace each original curved gallery band independently, retaining posts.

    Bands were measured in the saved source's side and rear views. Radial
    facing and elliptical envelope exclude inward timber, floors and window
    posts; the mild camber follows the authored curved fascia rather than
    classifying the entire stern by height.
    """
    counts = Counter()
    fascia=material('SV3_Finish_SternFascia',(1,1,1),.53,texture='finish-stern-fascia')
    crown=material('SV3_Finish_SternCrown',(1,1,1),.53,texture='finish-stern-crown')
    uv=obj.data.uv_layers['MaterialUV']
    for p in obj.data.polygons:
        c = p.center; radial = Vector((c.x / (15.2 ** 2), (c.y + 51) / (16.5 ** 2), 0))
        envelope = math.hypot(c.x / 15.2, (c.y + 51) / 16.5)
        facing = p.normal.dot(radial.normalized()) if radial.length else 0
        semantic = 'Walnut'
        if envelope > .60 and facing > .08 and abs(p.normal.z)<.9 and c.y < -40:
            camber = .0025 * (c.y + 55) ** 2
            height = c.z - camber
            for bottom, top in [(-7.8, -3.5), (.7, 3.25), (9.05, 13.7)]:
                if bottom - .18 <= height <= top + .18:
                    semantic = 'Brass' if min(abs(height-bottom), abs(height-top)) < .30 else 'Teal' if height < bottom + .95 else 'Ivory'
                    break
            # Paint continuously across original triangles in component UVs.
            # Face-centre thresholds alone leave serrated colour boundaries.
            set_slot(obj,p,fascia)
            for li in p.loop_indices:
                v=obj.data.vertices[obj.data.loops[li].vertex_index].co
                theta=math.atan2(v.x/15.2,-(v.y+51)/16.5)
                uv.data[li].uv=(theta/math.tau+.5,(v.z+10)/30)
            us=[uv.data[li].uv.x for li in p.loop_indices]
            if max(us)-min(us)>.5:
                for li in p.loop_indices:
                    if uv.data[li].uv.x<.5: uv.data[li].uv.x+=1
        elif envelope>.76 and abs(p.normal.z)>.7 and c.z>13.5 and c.y<-40:
            semantic='Crown';set_slot(obj,p,crown)
            for li in p.loop_indices:
                v=obj.data.vertices[obj.data.loops[li].vertex_index].co
                theta=math.atan2(v.x/15.2,-(v.y+51)/16.5)
                radius=math.hypot(v.x/15.2,(v.y+51)/16.5)
                uv.data[li].uv=(theta/math.tau+.5,radius/1.4)
            us=[uv.data[li].uv.x for li in p.loop_indices]
            if max(us)-min(us)>.5:
                for li in p.loop_indices:
                    if uv.data[li].uv.x<.5:uv.data[li].uv.x+=1
        else: set_slot(obj, p, mats['Walnut'])
        counts[semantic] += 1
    obj['finish_reference'] = REFERENCE; obj['finish_regions'] = json.dumps(dict(counts))
    assert counts['Ivory'] > 1500 and counts['Walnut'] > 1500 and counts['Teal'] > 300
    return dict(counts)

def apply_finish(scene):
    ship = scene.objects['SV2_Ship']; scene.frame_set(1); ship.update_tag(); bpy.context.view_layer.update()
    source = {o.name: geometry(o) for o in scene.objects if o.type == 'MESH' and not o.name.startswith('SV3_CabinFinish_')}
    poses = {o.name: tuple(v for row in o.matrix_local for v in row) for o in scene.objects if not o.name.startswith('SV3_CabinFinish_')}
    mats = {
        'Ivory': material('SV3_Finish_Ivory', (.79,.745,.65), .48, .08),
        'Brass': material('SV3_Finish_Brass', (.58,.36,.09), .34, .72),
        'Teal': material('SV3_Finish_Teal', (.009,.20,.19), .42, .12),
        'Navy': material('SV3_Finish_Navy', (.018,.034,.058), .48, .48),
        'Walnut': material('SV3_Finish_Walnut', (1,1,1), .76, texture='finish-walnut'),
        'Deck': material('SV3_Finish_Deck', (1,1,1), .78, texture='finish-honey-teak'),
        'Linen': material('SV3_Finish_Linen', (1,1,1), .94, texture='finish-ivory-linen', normal_strength=.10),
        'Engine': material('SV3_Finish_Engine', (1,1,1), .51, .18, 'finish-enamel-panels', .18),
    }
    for key,semantic in [('Linen','SailLinen'),('Deck','DeckTeak'),('Walnut','SparWood'),('Ivory','HullIvory'),('Brass','BrassTrim'),('Navy','NavyIron'),('Teal','TealRibbon')]:
        mats[key]['voyage_material_semantic']=semantic
    replaced = Counter()
    # Change live slots only; archived pre-repair scenes remain available.
    for obj in scene.objects:
        if obj.type != 'MESH': continue
        original = [m.name if m else '' for m in obj.data.materials]
        changed = False
        for i, name in enumerate(original):
            key = None
            if name in ['SV3_M_Wood','SV3_Prototype_DeckTeak']: key = 'Deck'
            elif name in ['SV3_Prototype_SternWalnut','SV3_Prototype_SparWood','SV3_HullPlanks','SV3_CabinWalnut','SV3_Board_Walnut']: key = 'Walnut'
            elif name in ['SV3_Prototype_SailLinen','SV3_M_Linen']: key = 'Linen'
            elif name in ['SV3_Prototype_HullIvory','SV3_M_Enamel']: key = 'Ivory'
            elif name in ['SV3_Prototype_BrassTrim','SV3_Board_Brass','SV3_M_Brass']: key = 'Brass'
            elif name in ['SV3_Prototype_NavyIron','SV3_M_Navy']: key = 'Navy'
            elif name == 'SV3_Prototype_TealRibbon': key = 'Teal'
            if key:
                obj.data.materials[i] = mats[key]; replaced[key] += 1; changed = True
        if changed:
            # Cloth UV2 is the physics grid; its UV0 is the historical source.
            # Neither is overwritten by this material UV pass.
            if obj.get('cloth_canvas_vertex_start') == 0 or 'Patch_' in obj.name:
                uv_component(obj, ship, 'cloth')
            elif 'TimberSpars' in obj.name or 'MastStay_' in obj.name:
                if obj.get('finish_uv') is None: uv_component(obj, ship, 'spar')
            elif obj.name in ['SV3_Repaired_MainMastAndStays','SV3_CrowNest']: uv_component(obj, ship, 'mast')
            elif 'SternPlatform' in obj.name: uv_component(obj, ship, 'stern')
            else: uv_component(obj, ship, 'timber')
        # Correct stale reference metadata on live objects and live materials.
        if 'prototype_reference' in obj: obj['prototype_reference'] = REFERENCE
        if obj.parent and obj.name.startswith(('SV3_JewelCollar_','SV3_Repaired_')):
            obj['structural_repair_child'] = True
        if obj.get('split_from') or obj.name.startswith('SV3_MastStay_'):
            obj['structural_repair_child'] = True
            if obj.name.startswith('SV3_MastStay_'): obj['split_from']='SV3_Repaired_MainMastAndStays'
        if obj.name.startswith(('SV3_CaptainWindow_', 'SV3_CaptainWall_', 'SV3_CaptainRoof', 'SV3_CaptainDoor', 'SV3_CaptainPorthole_', 'SV3_CaptainPortal', 'SV3_CabinDeckPortal', 'SV3_Adventure')):
            obj['structural_repair_child']=True
            obj['detail_source_recipe']='repair_voyage_captain_boundary + refine_voyage_cabin_details; existing retained geometry'
    stern = stern_regions(scene.objects['SV3_Hull_SternPlatform'], mats)
    # Original prow: preserve wooden deck/rails, distinguish the outer pale
    # shell beneath them. Original geometry and all deck collision stay intact.
    hull=scene.objects['SV3_Hull'];bow_faces=0
    for p in hull.data.polygons:
        if p.center.y>45 and p.center.z<-.8 and abs(p.normal.z)<.7:
            current=hull.data.materials[p.material_index]
            if current==mats['Walnut']:
                set_slot(hull,p,mats['Ivory']);bow_faces+=1
    cradle=scene.objects.get('SV3_EnergyCradle_Timber');cradle_faces=0
    if cradle:
        for p in cradle.data.polygons:
            if p.center.z<.42:
                set_slot(cradle,p,mats['Brass']);cradle_faces+=1
    for side in ['Port','Starboard']:
        engine = scene.objects['SV3_Engine_'+side]
        for p in engine.data.polygons: set_slot(engine,p,mats['Engine'])
        uv_component(engine, ship, 'engine')
        for suffix,key in [('MetalBand','Brass'),('EndCap','Navy'),('BrassCollars','Brass')]:
            obj = scene.objects.get('SV3_Engine_'+side+'_'+suffix)
            if obj:
                for p in obj.data.polygons: set_slot(obj,p,mats[key])
    # Colored gems read as the prototype's small blue/green cabochons; the
    # separate hanging energy crystal keeps its existing transmitting shader.
    for name,color in [('SV3_Prototype_JadeGlass',(.015,.32,.14)),('SV3_Prototype_SapphireGlass',(.009,.17,.46))]:
        m=bpy.data.materials.get(name)
        if m:
            sh=next(n for n in m.node_tree.nodes if n.type=='BSDF_PRINCIPLED')
            sh.inputs['Base Color'].default_value=(*color,1)
            sh.inputs['Transmission Weight'].default_value=.25; sh.inputs['Roughness'].default_value=.15
            sh.inputs['Coat Weight'].default_value=.6; m['prototype_reference']=REFERENCE
    for o in scene.objects:
        if o.type=='MESH':
            for m in o.data.materials:
                if m and 'prototype_reference' in m: m['prototype_reference']=REFERENCE
    cabin = module('refine_voyage_cabin_finish').apply_cabin_finish(scene, mats)
    for name,modifier in cabin['bevel_modifiers']:
        obj=scene.objects[name]; bpy.context.view_layer.objects.active=obj
        bpy.ops.object.modifier_apply(modifier=modifier)
        uv_component(obj,ship,'timber')
    assert all(geometry(scene.objects[name]) == fingerprint for name,fingerprint in source.items()), 'original mesh/morph/SourceUV changed'
    assert all(tuple(v for row in scene.objects[name].matrix_local for v in row) == pose for name,pose in poses.items()), 'original anchor or pivot moved'
    scene['ship_material_reference']=REFERENCE; scene['component_finish_revision']=1
    return {'reference':REFERENCE,'material_slots':dict(replaced),'stern_faces':stern,'bow_shell_faces':bow_faces,'cradle_brass_faces':cradle_faces,'cabin':cabin,'original_mesh_morph_source_uv_and_anchors_preserved':True}

if __name__ == '__main__':
    scene=bpy.data.scenes['SV3_ProductionRig']; bpy.context.window.scene=scene
    report=apply_finish(scene)
    if '--dry-run' not in sys.argv:
        module('refine_voyage_mast_connections').save_export(scene)
    out=ROOT/'evidence/2026-10-04/voyage-prototype-finish'; out.mkdir(parents=True,exist_ok=True)
    (out/'native-finish-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print('COMPONENT_FINISH_OK',json.dumps(report,ensure_ascii=False))
