"""Apply the screenshot corrections to the current production source in place."""
import bpy
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).parent))
from refine_voyage_screenshot_structure import apply_structure
from redesign_voyage_cabin import apply_cabin_redesign
from redesign_voyage_login import apply_login_redesign
from refine_voyage_mast_connections import save_export
from refine_voyage_wheel_depth import refine_hardware_material_uv
from refine_voyage_fixed_hardware_uv import refine_fixed_hardware_uv
from restore_voyage_wheel_hull import apply as restore_wheel_hull
from voyage_material_refinement import refine_texture_multipliers

scene = bpy.data.scenes['SV3_ProductionRig']
bpy.context.window.scene = scene
scene.frame_set(1)
report = {
    'complete_wheel_hull': restore_wheel_hull(scene),
    'wheel_hardware_uv': refine_hardware_material_uv(scene),
    'captain_finish': apply_structure(scene),
    'cabin_redesign': apply_cabin_redesign(scene),
    'login_redesign': apply_login_redesign(scene),
    'fixed_hardware_uv': refine_fixed_hardware_uv(scene),
    'texture_multipliers': refine_texture_multipliers(scene),
}
save_export(scene)
output = ROOT / 'evidence/2026-10-05/voyage-screenshot-fixes/native-model-report.json'
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print('VOYAGE_SCREENSHOT_FIXES_READY', json.dumps(report, ensure_ascii=False))
