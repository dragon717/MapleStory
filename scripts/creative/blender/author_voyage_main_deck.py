"""Retain the original deck and author a separate cabin-to-bow transfer."""
import bpy, json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).parent))
from refine_voyage_mast_connections import save_export
from author_voyage_structural_routes import author
from refine_voyage_wheel_rear_orientation import apply as apply_wheels
from author_voyage_portal_and_bow import apply as apply_portal_bow
from refine_voyage_wheel_depth import apply as apply_wheel_depth
from refine_voyage_screenshot_structure import apply_structure
from redesign_voyage_cabin import apply_cabin_redesign
from redesign_voyage_login import apply_login_redesign
from restore_voyage_wheel_hull import apply as restore_wheel_hull
from refine_voyage_fixed_hardware_uv import refine_fixed_hardware_uv
from voyage_material_refinement import refine_texture_multipliers

scene = bpy.data.scenes['SV3_ProductionRig']
bpy.context.window.scene = scene
scene.frame_set(1)
layout = json.loads((ROOT / 'shared/voyage-deck.json').read_text(encoding='utf-8'))
removed = []
for obj in list(scene.objects):
    if obj.name.startswith(('SV3_MainDeck_Surface', 'SV3_DeckAccessRails', 'SV3_DeckRouteGuide', 'SV3_CaptainArcWalkway')):
        removed.append(obj.name)
        bpy.data.objects.remove(obj, do_unlink=True)
hull = scene.objects['SV3_Hull']
source = bpy.data.meshes['SV3_DeckPassage_OriginalHull']
hull.data = source.copy()
hull.data.name = 'SV3_Hull_OriginalDeckAndShell'
if 'wheel_hull_restore_revision' in hull:
    del hull['wheel_hull_restore_revision']
hull['deck_passage_original_faces_clipped'] = 0
hull['lobby_walkable'] = True
for key in ('central_shell_cleanup', 'central_enclosure_cleanup'):
    if key in hull:
        del hull[key]
portal = scene.objects['SV3_CaptainPortal']
portal.location.x = 6.45
portal['trigger_radius'] = 1.4
portal.location.z = layout['surface']['height'] + .025
ring = scene.objects.get('SV3_CaptainPortal_Ring')
if ring:
    ring.location.x = portal.location.x - 5.65
    for v in ring.data.vertices:
        v.co.z = layout['surface']['height'] + .04
scene['main_deck_walk_surface'] = json.dumps(layout, ensure_ascii=False)
report = {'originalHullFaces': len(hull.data.polygons), 'removedOverlay': removed, 'routes': author(scene), 'wheels': apply_wheels(scene), 'portal_bow': apply_portal_bow(scene,layout)}
report['wheel_depth'] = apply_wheel_depth(scene)
report['complete_wheel_hull'] = restore_wheel_hull(scene)
report['captain_finish'] = apply_structure(scene)
report['cabin_redesign'] = apply_cabin_redesign(scene)
report['login_redesign'] = apply_login_redesign(scene)
report['fixed_hardware_uv'] = refine_fixed_hardware_uv(scene)
report['texture_multipliers'] = refine_texture_multipliers(scene)
save_export(scene)
evidence = ROOT / 'evidence/2026-10-05/voyage-spatial-correction'
evidence.mkdir(parents=True, exist_ok=True)
(evidence / 'native-model-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print('VOYAGE_SPATIAL_CORRECTION_READY', json.dumps(report, ensure_ascii=False))
