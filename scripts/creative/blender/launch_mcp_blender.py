"""Launch a disposable GUI Blender instance with the project-local addon.

The official addon refuses to start in background mode because Blender's main
thread would never drain its command queue.  This launcher imports the
installed project copy into a fresh GUI process, suppresses its default 9876
autostart, then starts the same addon on the project-only port 9987.
"""

import importlib.util
import pathlib
import sys
import bpy


# The launcher itself is copied to /tmp before LaunchServices starts Blender;
# use a stable ASCII path here so macOS does not block on an iCloud script
# path during Blender's early argument parsing.
ADDON_PATH = pathlib.Path("/tmp/maple_story_blender_mcp.py")
PORT = 9987

# Early marker makes launch verification possible even when Blender starts
# without a terminal console (macOS LaunchServices).
pathlib.Path("/tmp/maple_windbell_blender_launcher_ran").write_text("launcher-loaded", encoding="utf-8")


def load_addon():
    spec = importlib.util.spec_from_file_location("blender_mcp_project", str(ADDON_PATH))
    addon = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = addon
    spec.loader.exec_module(addon)
    return addon


addon = load_addon()

# register() has a convenience auto-start at 9876. Suppress only that call;
# the original implementation is restored before the dedicated server starts.
real_start = addon.BlenderMCPServer.start


def no_default_start(self):
    print("PROJECT_MCP: suppressing default 9876 autostart")


addon.BlenderMCPServer.start = no_default_start
addon.register()
addon.BlenderMCPServer.start = real_start


def start_project_server():
    scene = bpy.context.scene
    scene.blendermcp_port = PORT
    if hasattr(bpy.types, "blendermcp_server") and bpy.types.blendermcp_server:
        try:
            bpy.types.blendermcp_server.stop()
        except Exception:
            pass
    bpy.types.blendermcp_server = addon.BlenderMCPServer(port=PORT)
    bpy.types.blendermcp_server.start()
    scene.blendermcp_server_running = bpy.types.blendermcp_server.running
    print("PROJECT_MCP_READY", PORT, str(ADDON_PATH))
    return None


bpy.app.timers.register(start_project_server, first_interval=0.5)
