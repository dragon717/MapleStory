"""Update explicit cutaway semantics in a staged, editable sky-city source."""
import bpy,json,importlib.util
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3];dest=ROOT/'resources/scenes/sky-voyage-v3/prototypes'
scene=bpy.data.scenes['SC_SpatialPrototype'];bpy.context.window.scene=scene
layout=json.loads((dest/'sky-city-spatial-layout.json').read_text(encoding='utf-8'))
source=Path(__file__).with_name('tag_sky_city_interiors.py');spec=importlib.util.spec_from_file_location('city_interiors',source);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);module.tag_interiors(scene,layout)
bpy.ops.wm.save_as_mainfile(filepath=str(dest/'sky-city-spatial-prototype.blend'))
bpy.ops.export_scene.gltf(filepath=str(dest/'sky-city-spatial-prototype.glb'),export_format='GLB',use_active_scene=True,export_animations=False,export_extras=True,export_cameras=False,export_lights=False)
print('TOWER_CUTAWAY_EXPORTED')
