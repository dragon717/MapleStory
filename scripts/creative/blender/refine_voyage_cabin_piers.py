"""Compatibility shim for the retired cabin bridge-detail authoring pass.

The old ``SV2_CabinAftWalk*`` bridge and its pier trim are archive-only.  The
production scene now owns the continuous 09→18→02→17→15→16→08 route in
``author_voyage_structural_routes.py``.  Keeping this tiny no-op entry point
lets older orchestration commands finish without reintroducing stale meshes.
"""

from __future__ import annotations

import bpy


def apply_piers(scene):
    if scene is None:
        raise ValueError("apply_piers(scene) requires a Blender scene")
    removed = []
    for obj in list(scene.objects):
        if not obj.name.startswith("SV3_CabinPierDetail_"):
            continue
        removed.append(obj.name)
        bpy.data.objects.remove(obj, do_unlink=True)
    return {
        "retired": True,
        "removed_previous": tuple(removed),
        "replacement": "SV3_VoyageRouteStructure authored floors and supports",
    }


__all__ = ["apply_piers"]
