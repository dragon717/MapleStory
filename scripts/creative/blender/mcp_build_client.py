"""Small stdlib MCP stdio client used to leave reproducible Blender evidence.

It intentionally talks to the official ``blender-mcp`` package over MCP
stdio.  The actual scene construction is sent as the content of
``build_windbell_assets.py`` through ``execute_blender_code``; this keeps the
Blender socket command attributable to a real MCP tool call while the source
stays reviewable in this repository.
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[3]
SCRIPT = PROJECT / "scripts" / "creative" / "blender" / "build_windbell_assets.py"
EVIDENCE = PROJECT / "resources" / "creative" / "windbell" / "blender" / "logs" / "mcp_evidence.json"
UVX = "/Users/muniao/.local/bin/uvx"
HOST = "localhost"
PORT = "9987"


class MCPClient:
    def __init__(self):
        env = os.environ.copy()
        env.update({
            "BLENDER_HOST": HOST,
            "BLENDER_PORT": PORT,
            "BLENDER_MCP_SAFE_MODE": "1",
            "DISABLE_TELEMETRY": "1",
            "MCP_DISABLE_TELEMETRY": "1",
        })
        self.proc = subprocess.Popen(
            [UVX, "--python", "3.11", "blender-mcp"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        self.next_id = 1

    def request(self, method, params=None):
        request_id = self.next_id
        self.next_id += 1
        payload = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            payload["params"] = params
        wire = (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        self.proc.stdin.write(wire)
        self.proc.stdin.flush()
        while True:
            line = self.proc.stdout.readline()
            if not line:
                err = self.proc.stderr.read().decode("utf-8", errors="replace")
                raise RuntimeError("MCP stdio closed: " + err[-2000:])
            message = json.loads(line.decode("utf-8"))
            if message.get("id") == request_id:
                return message

    def notify(self, method, params=None):
        payload = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            payload["params"] = params
        wire = (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        self.proc.stdin.write(wire)
        self.proc.stdin.flush()

    def call_tool(self, name, arguments):
        return self.request("tools/call", {"name": name, "arguments": arguments})

    def close(self):
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            self.proc.terminate()
            self.proc.wait(timeout=8)


def result_text(response):
    return response.get("result", response.get("error", response))


def main():
    client = MCPClient()
    evidence = {
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "server": "ahujasid/blender-mcp",
        "command": [UVX, "--python", "3.11", "blender-mcp"],
        "env": {"BLENDER_HOST": HOST, "BLENDER_PORT": PORT, "BLENDER_MCP_SAFE_MODE": "1", "DISABLE_TELEMETRY": "1"},
        "calls": [],
    }
    try:
        initialize = client.request("initialize", {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "maple-windbell-builder", "version": "1.0"},
        })
        evidence["initialize"] = initialize
        client.notify("notifications/initialized")
        listed = client.request("tools/list", {})
        tool_names = [t.get("name") for t in listed.get("result", {}).get("tools", [])]
        evidence["tools_list"] = {"response": listed, "names": tool_names}

        status = client.call_tool("get_addon_status", {"user_prompt": "Maple Windbell asset build"})
        evidence["calls"].append({"tool": "get_addon_status", "response": status})
        scene_before = client.call_tool("get_scene_info", {"user_prompt": "Inspect the independent Blender scene before build"})
        evidence["calls"].append({"tool": "get_scene_info_before", "response": scene_before})

        code = SCRIPT.read_text(encoding="utf-8")
        build = client.call_tool("execute_blender_code", {"code": code, "user_prompt": "Build the editable Maple Windbell Bridge and Windbell Island asset library from the reviewed project script."})
        evidence["calls"].append({"tool": "execute_blender_code", "response": build})

        scene_after = client.call_tool("get_scene_info", {"user_prompt": "Verify generated scenes and collections after build"})
        evidence["calls"].append({"tool": "get_scene_info_after", "response": scene_after})
        screenshot = client.call_tool("get_viewport_screenshot", {"max_size": 1200, "user_prompt": "Capture the independent Windbell Blender viewport after the asset build."})
        evidence["calls"].append({"tool": "get_viewport_screenshot", "response": screenshot})
        verify_code = """import bpy
required = ['WB_BridgeRoot','WB_Bridge_Common','WB_Bridge_State_Broken','WB_Bridge_State_Working','WB_Bridge_State_Connected','WB_Bridge_State_Inhabited','WB_Bridge_State_AnimationStudy','IS_WindbellIslandRoot','IS_Common','IS_RootPath_6_to_8_Modules','IS_TreeBridge','IS_Rope_StateVariants','IS_StoneTrough_Dry_Heat_Burn_Ember','IS_WetWood_Wet_Steam_Dry','IS_LeafWing_Closed_Open_Wind_Folded','IS_Station','IS_Dragon_Glide_Wingbeat_Rest']
collections = {n: len(bpy.data.collections[n].objects) if bpy.data.collections.get(n) else None for n in required}
world_states = {s: len([o for o in bpy.data.objects if o.get('world_state') == s]) for s in ['broken','working','connected','inhabited','complete','worn','severed','charred','dry','heated','burning','ember','wet','steaming','closed']}
animated = [o.name for o in bpy.data.objects if o.animation_data and o.animation_data.action]
scene_children = {s.name: sorted([c.name for c in s.collection.children]) for s in bpy.data.scenes if s.name.startswith(('WindbellBridge_','WindbellIsland_'))}
print({'scenes':[s.name for s in bpy.data.scenes], 'collections':collections, 'world_states':world_states, 'windbell_objects':len([o for o in bpy.data.objects if o.name.startswith(('WB_','IS_'))]), 'animated_rigs':animated, 'scene_children':scene_children, 'frames':{'leafwing':[1,20,34,52,70], 'bridge':[1,20,40], 'dragon':[1,15,30,45,60,120,240]}, 'artifact_blend':bpy.data.filepath})"""
        verify = client.call_tool("execute_blender_code", {"code": verify_code, "user_prompt": "Independently verify Windbell scene links, collections, world states, object count, animation rigs and authored frames."})
        evidence["calls"].append({"tool": "execute_blender_code_verify", "response": verify})
        for object_name in ["WB_Bridge_LeftBroken_RIG", "WB_Bridge_Connected_RIG", "IS_LeafWing_ROOT", "IS_PatrolDragon_ROOT"]:
            obj_info = client.call_tool("get_object_info", {"object_name": object_name, "user_prompt": "Verify a representative authored Windbell rig."})
            evidence["calls"].append({"tool": "get_object_info:" + object_name, "response": obj_info})
        evidence["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        EVIDENCE.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"status": "ok", "tool_count": len(tool_names), "evidence": str(EVIDENCE)}, ensure_ascii=False))
    finally:
        client.close()


if __name__ == "__main__":
    main()
