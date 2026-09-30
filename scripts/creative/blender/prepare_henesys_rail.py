"""Write the Blender MCP payload from the shared rail and downloaded CC0 kits."""
import json
from pathlib import Path

root = Path(__file__).resolve().parents[3]
out = root / 'resources/scenes/henesys/rail-v1'
rail = json.loads((root / 'shared/henesys-rail.json').read_text(encoding='utf-8'))
nature_root = out / 'vendor/nature/Stylized Nature MegaKit[Standard]/glTF'
nature = [{'file': str(nature_root / (name + '.gltf')), 'kind': kind, 'height': height}
          for name, kind, height in [
              ('CommonTree_1','tree',5), ('CommonTree_2','tree',5), ('CommonTree_3','tree',5),
              ('TwistedTree_1','tree',5), ('TwistedTree_2','tree',5),
              ('Bush_Common','detail',.7), ('Grass_Common_Short','detail',.35),
              ('Flower_3_Group','detail',.45), ('Fern_1','detail',.55),
              ('Rock_Medium_1','detail',.8), ('Mushroom_Common','detail',.7)]]
for filename in [n['file'] for n in nature]:
    assert Path(filename).is_file(), filename
for directory in ['models','previews']:
    (out / directory).mkdir(parents=True, exist_ok=True)
values = dict(RAIL=rail, FOOTHOLDS=rail['platforms'] + rail['decks'], NATURE=nature, OUT=str(out))
payload = ''.join(key + ' = ' + repr(value) + '\n' for key, value in values.items())
payload += Path(__file__).with_name('build_henesys_rail.py').read_text(encoding='utf-8')
(out / 'build-payload.py').write_text(payload, encoding='utf-8')
print(out / 'build-payload.py')
