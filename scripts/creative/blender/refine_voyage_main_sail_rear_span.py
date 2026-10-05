"""Open the installed main sail farther outboard in the rear view.

The accepted orthographic line work keeps the side Y/Z silhouette while the
front/rear view reads as a broad fan beyond the hull.  Scaling each existing
main-fan root only on local X preserves its cloth topology, UVs, fold morphs,
and Y/Z side profile; the authored tip anchors and stay constraints inherit
the same transform, so no duplicate sail or loose support is introduced.
"""

from __future__ import annotations

import json
from pathlib import Path

import bpy


ROOT = Path(__file__).resolve().parents[3]
SCALE = 1.55


def apply(scene):
    report = {"scale": SCALE, "fans": []}
    for index in range(3):
        fan = scene.objects[f"SV3_MainFan_{index}"]
        previous = float(fan.get("main_sail_rear_span_scale", 1.0))
        factor = SCALE / previous
        fan.scale.x *= factor
        fan["main_sail_rear_span_scale"] = SCALE
        fan["main_sail_side_profile_preserved"] = True
        fan["main_sail_rear_contract"] = "deployed front/rear fan opens beyond hull; local X span only"
        report["fans"].append({"name": fan.name, "previous_scale": previous, "factor": factor, "applied_scale": fan.scale.x})
    scene["main_sail_rear_span_revision"] = "2026-10-05: local-X fan opening 1.55x; Y/Z silhouette retained"
    bpy.context.view_layer.update()
    return report


if __name__ == "__main__":
    import importlib.util

    scene = bpy.data.scenes["SV3_ProductionRig"]
    report = apply(scene)
    wheel_path = Path(__file__).with_name("refine_voyage_wheel_rear_orientation.py")
    spec = importlib.util.spec_from_file_location("voyage_wheel_orientation", wheel_path)
    wheel = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(wheel)
    report["wheels"] = wheel.apply(scene)
    wheel.save_export(scene)
    evidence = ROOT / "evidence/2026-10-05/voyage-structural-routes"
    evidence.mkdir(parents=True, exist_ok=True)
    (evidence / "main-sail-rear-span-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("VOYAGE_MAIN_SAIL_REAR_SPAN_READY", json.dumps(report, ensure_ascii=False))
