"""Prepare local-only Henesys references and portable texture/source inputs.

Usage: python3 scripts/creative/blender/prepare_henesys.py --source /path/to/MapleStory
No writes to the source project. Pillow/numpy are existing authoring dependencies.
"""
import argparse
import json
import shutil
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[3]


def prepare(source):
    out = ROOT / 'resources/scenes/henesys'
    for folder in ('references', 'textures', 'models', 'previews', 'logs', 'vegetation'):
        (out / folder).mkdir(parents=True, exist_ok=True)
    maps = json.loads((source / 'resources/tms273-export/maps-rendered.json').read_text(encoding='utf-8'))
    village = next(m for m in maps['maps'] if m['id'] == '100000000')
    (out / 'references/map-source.json').write_text(json.dumps(village, ensure_ascii=False, indent=2), encoding='utf-8')
    canvas = Image.new('RGBA', (6400, 2000), (172, 213, 211, 255))
    for layer in sorted(village['layers'], key=lambda a: a['depth']):
        if 'background' in layer:
            continue
        image = Image.open(source / 'client/public-tms273' / layer['url'].lstrip('/')).convert('RGBA')
        if layer.get('flipX') or layer.get('f'):
            image = image.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        canvas.alpha_composite(image, (round(layer['x']), round(layer['y'] + 1200)))
    canvas.save(out / 'references/tms273-henesys-full.png')
    canvas.resize((1920, 600)).save(out / 'references/tms273-henesys-overview.png')
    plants = source / 'resources/scenes/colossus/redesign/vegetation/kenney-nature-kit'
    shutil.copy2(plants / 'License.txt', out / 'vegetation/License.txt')
    for name in ('tree_oak', 'tree_default', 'plant_bushDetailed', 'grass', 'flower_yellowA', 'flower_purpleA'):
        for ext in ('obj', 'mtl'):
            shutil.copy2(plants / 'Models/OBJ format' / f'{name}.{ext}', out / 'vegetation' / f'{name}.{ext}')
    # Small authored, tileable color maps: wood pores/grain remain in the GLB.
    # Macro timber structure is geometry; no procedural-only render material.
    n = 512
    y, x = np.mgrid[0:n, 0:n] / n
    rng = np.random.default_rng(273)
    noise = rng.normal(0, 1, (n, n))
    broad = np.sin(2*np.pi*x*3) * np.cos(2*np.pi*y*2)
    grain = np.sin(2*np.pi*(x*31 + .22*np.sin(2*np.pi*y*2) + .12*np.sin(2*np.pi*y*5)))
    fine = np.sin(2*np.pi*(x*97 + .7*np.sin(2*np.pi*y)))
    palettes = {
        'timber': ((125, 76, 38), 15*grain + 6*fine + 6*noise + 8*broad),
        'plaster': ((235, 218, 175), 4*noise + 5*broad),
        'stone': ((148, 158, 141), 6*noise + 13*broad),
        'cap': ((238, 225, 205), 3*noise + 7*broad),
        'earth': ((137, 110, 76), 8*noise + 7*broad),
        'leaf': ((153, 178, 102), 5*noise + 16*broad),
    }
    for name, (base, values) in palettes.items():
        rgb = np.clip(np.array(base)[None, None, :] + values[..., None], 0, 255).astype('uint8')
        Image.fromarray(rgb).save(out / 'textures' / f'{name}.png')
    shutil.copy2(source / 'client/public-tms273/assets/colossus/handpainted-timber.png', out / 'textures/timber-painted.png')
    # Exact original coordinate data is retained separately; never inferred from visual meshes.
    paths = {'source': village['source'], 'mapId': village['id'], 'purpose': 'reference-only; not registered as gameplay collision',
             'transform': {'pixelsPerMetre': 45, 'xOrigin': 3285, 'yOrigin': 450},
             'footholds': village['footholds'], 'ladders': village['ladders'], 'portals': village['portals']}
    (out / 'models/source-layout.json').write_text(json.dumps(paths, ensure_ascii=False, indent=2), encoding='utf-8')
    # Composite the exporter-owned original layers without scaling or repainting.
    avatar = json.loads((source / 'resources/tms273-export/avatar.json').read_text(encoding='utf-8'))['avatar']
    frames = {}
    for action in ('stand', 'walk'):
        frames[action] = []
        for index, frame in enumerate(avatar['actions'][action]):
            parts = frame['parts']
            left = min(p['x'] for p in parts); top = min(p['y'] for p in parts)
            right = max(p['x'] + p['width'] for p in parts); bottom = max(p['y'] + p['height'] for p in parts)
            image = Image.new('RGBA', (right-left, bottom-top))
            for part in sorted(parts, key=lambda p: -p['z']):
                layer = Image.open(source / 'client/public-tms273' / part['url'].lstrip('/')).convert('RGBA')
                image.alpha_composite(layer, (part['x']-left, part['y']-top))
            filename = f'actor-{action}-{index}.png'; image.save(out / 'textures' / filename)
            frames[action].append({'url': 'textures/'+filename, 'left': left, 'top': top, 'delay': frame['delay']})
    (out / 'models/actor.json').write_text(json.dumps({'source': 'TMS273.7 original starter avatar', 'actions': frames}, indent=2), encoding='utf-8')
    assert len(paths['footholds']) == 426 and len(paths['ladders']) == 5
    assert all((out / 'textures' / f'{name}.png').stat().st_size > 0 for name in palettes)
    print(f'Prepared {out}; 426 source footholds preserved, no gameplay files changed.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    prepare(parser.parse_args().source.resolve())
