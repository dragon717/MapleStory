"""Orient the two wheel sails as face-on X/Y steering wheels.

The imported wheel cloth was a thin Y/Z sheet, which made it edge-on from the
ship's rear/front.  The source pivot is the steering empty at each wheel
centre; rotating the local mesh around that pivot keeps the axle, hub and
opposite blade pairs together while preserving topology, UV layers, shape-key
animation and the retained hull socket.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import bpy
from mathutils import Matrix, Vector


ROOT = Path(__file__).resolve().parents[3]
DEST = ROOT / "resources/scenes/sky-voyage-v3/models"


def _rotate_mesh(obj, angle):
    rotation = Matrix.Rotation(angle, 3, "Z")
    for vertex in obj.data.vertices:
        vertex.co = rotation @ vertex.co
    if obj.data.shape_keys:
        for key in obj.data.shape_keys.key_blocks:
            for vertex in key.data:
                vertex.co = rotation @ vertex.co
    obj.data.update()


def _tube(name, a, b, radius, material, parent, segments=12):
    a = Vector(a); b = Vector(b)
    axis = (b - a).normalized()
    helper = axis.cross(Vector((0.0, 0.0, 1.0)))
    if helper.length < 1.0e-6:
        helper = axis.cross(Vector((1.0, 0.0, 0.0)))
    helper.normalize(); other = axis.cross(helper).normalized()
    vertices = []
    for point in (a, b):
        for i in range(segments):
            angle = math.tau * i / segments
            vertices.append(tuple(point + radius * (helper * math.cos(angle) + other * math.sin(angle))))
    faces = []
    for i in range(segments):
        j = (i + 1) % segments
        faces.append((i, j, segments + j, segments + i))
    faces += [tuple(reversed(range(segments))), tuple(segments + i for i in range(segments))]
    mesh = bpy.data.meshes.new(name + "_Mesh")
    mesh.from_pydata(vertices, [], faces); mesh.update(); mesh.materials.append(material)
    source = mesh.uv_layers.new(name="SourceUV"); material_uv = mesh.uv_layers.new(name="MaterialUV")
    length = max((b - a).length, 1.0e-6)
    for poly in mesh.polygons:
        for loop_index in poly.loop_indices:
            co = mesh.vertices[mesh.loops[loop_index].vertex_index].co
            uv = ((co - a).length / length, loop_index % segments / segments)
            source.data[loop_index].uv = uv; material_uv.data[loop_index].uv = uv
    material_uv.active = True
    obj = bpy.data.objects.new(name, mesh); bpy.context.scene.collection.objects.link(obj); obj.parent = parent
    obj["rigid_axle_support"] = True
    obj["wheel_orientation_contract"] = "face-on X/Y cloth; axle along ship depth"
    return obj


def apply(scene, minimum_hub_x=22.0):
    exterior = scene.objects["SV3_Exterior"]
    spar_material = bpy.data.materials["SV3_Prototype_SparWood"]
    report = {"wheels": [], "connectors": []}
    for side, sign in (("Port", 1.0), ("Starboard", -1.0)):
        wheel = scene.objects[f"SV3_Wheel_{side}"]
        spokes = scene.objects[f"SV3_Wheel_{side}_TimberSpokesAndHub"]
        angle = sign * math.pi * 0.5
        if wheel.get("wheel_face_axis") not in {"runtime X/Z", "runtime X/Y"}:
            for obj in (wheel, spokes):
                _rotate_mesh(obj, angle)
        for obj in (wheel, spokes):
            obj["wheel_face_axis"] = "runtime X/Y"
            obj["wheel_rear_visible"] = True
            obj["wheel_orientation_radians"] = angle
            obj["source_topology_uv_preserved"] = True
        wheel["spin_axis"] = [0.0, 0.0, 1.0]
        wheel["spin_sign"] = sign
        wheel["spin_origin"] = "wheel hub centre; support rods stay fixed"
        steering = scene.objects[f"SV3_Wheel_{side}_Steering"]
        steering["wheel_face_axis"] = "runtime X/Y"
        steering["wheel_axle_socket"] = "SV3_Repaired_WheelHullSockets"
        # Clear the fixed hull socket as well as the new thick frame without
        # unnecessarily increasing the ship's overall width.
        target_x = sign * max(22.0, minimum_hub_x)
        if abs(float(steering.location.x) - target_x) > 1.0e-6:
            steering.location.x = target_x
            steering["outboard_x_applied"] = target_x
        x = float(steering.location.x)
        y = float(steering.location.y)
        z = float(steering.location.z)
        # The axle follows Blender Y (runtime ship-depth Z), from the retained
        # hull socket into the wheel centre.  It is rigid, never cloth.
        a = (x, y - 1.3, z)
        b = (x, y + 6.0, z)
        connector_name = f"SV3_Wheel_{side}_AxleConnector"
        connector = scene.objects.get(connector_name)
        if connector is not None:
            bpy.data.objects.remove(connector, do_unlink=True)
        connector = _tube(connector_name, a, b, .18, spar_material, exterior)
        connector["outboard_x_applied"] = target_x
        connector["connects_to"] = f"SV3_Wheel_{side}_OutboardBrace"
        connector["rig_kind"] = "rigid-wheel-axle"
        report["connectors"].append(connector.name)
        brace_name = f"SV3_Wheel_{side}_OutboardBrace"
        brace = scene.objects.get(brace_name)
        if brace is not None:
            bpy.data.objects.remove(brace, do_unlink=True)
        # Brace clears the full ±0.38-radian steering sweep as well as spin.
        # Only the stationary central axle
        # enters its hub. A support through the blade plane intersected it.
        brace = _tube(brace_name, (sign * 9.68, y + 6.0, z), (x, y + 6.0, z), .20, spar_material, exterior)
        brace["connects_to"] = "SV3_Repaired_WheelHullSockets"
        brace["rig_kind"] = "rigid-outboard-wheel-brace"
        brace["outboard_x_applied"] = target_x
        report["connectors"].append(brace.name)
        elbow_name = f"SV3_Wheel_{side}_SocketElbow"
        elbow = scene.objects.get(elbow_name)
        if elbow is not None:
            bpy.data.objects.remove(elbow, do_unlink=True)
        elbow = _tube(elbow_name, (sign * 9.68,y,z), (sign * 9.68,y + 6.0,z), .20, spar_material, exterior)
        elbow["rig_kind"] = "rigid-wheel-socket-elbow"
        elbow["connects_to"] = "SV3_Repaired_WheelHullSockets"
        report["connectors"].append(elbow.name)
        report["wheels"].append({"side": side, "angle_radians": angle, "face_axis": "runtime X/Y", "spin_axis": [0, 0, 1], "spin_sign": sign, "hub_x": target_x, "brace_depth_offset": 6.0})
    scene["wheel_orientation_revision"] = "2026-10-05: rear/front face-on wheel cloth and rigid hull axles"
    return report


def save_export(scene):
    ship = scene.objects["SV2_Ship"]
    bpy.context.window.scene = scene; scene.frame_set(1)
    owned = {ship, *ship.children_recursive}
    for obj in scene.objects: obj.select_set(obj in owned and obj.type in {"MESH", "EMPTY"})
    bpy.context.view_layer.objects.active = ship
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=str(DEST / "sky-voyage.blend"), compress=True)
    bpy.ops.export_scene.gltf(filepath=str(DEST / "sky-voyage.glb"), export_format="GLB", use_selection=True, use_active_scene=True, export_yup=True, export_extras=True, export_apply=False, export_animations=True)


if __name__ == "__main__":
    scene = bpy.data.scenes["SV3_ProductionRig"]
    report = apply(scene); save_export(scene)
    evidence = ROOT / "evidence/2026-10-05/voyage-structural-routes"; evidence.mkdir(parents=True, exist_ok=True)
    (evidence / "wheel-orientation-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("VOYAGE_WHEEL_ORIENTATION_READY", json.dumps(report, ensure_ascii=False))
