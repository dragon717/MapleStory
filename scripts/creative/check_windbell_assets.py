#!/usr/bin/env python3
"""Check Windbell assets after the classified resource-directory migration."""
import argparse
import json
import wave
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
SCENES = ROOT / 'resources' / 'scenes' / 'windbell'
SCENE_IMAGES = SCENES / 'images'
CHARACTERS = ROOT / 'resources' / 'characters' / 'windbell'
CHARACTER_IMAGES = CHARACTERS / 'images'
MUSIC = ROOT / 'resources' / 'music' / 'windbell'
SFX = ROOT / 'resources' / 'sfx' / 'windbell'
BLENDER = ROOT / 'resources' / 'blender' / 'windbell'
AUDIT = ROOT / 'resources' / 'ui' / 'windbell' / 'asset-audit.json'


def source_files():
    for root in (SCENES, CHARACTERS, MUSIC, SFX, BLENDER):
        if root.is_dir():
            yield from sorted(path for path in root.rglob('*') if path.is_file())


def png_info(path):
    with Image.open(path) as image:
        image.load()
        alpha = image.getchannel('A') if 'A' in image.getbands() else None
        limits = alpha.getextrema() if alpha else (255, 255)
        return {'width': image.width, 'height': image.height,
                'alpha_channel': alpha is not None,
                'has_transparent_pixels': limits[0] == 0,
                'has_visible_pixels': limits[1] > 0,
                'content_bounds': image.getbbox()}


def audit():
    missing, files = [], []
    for key in ('bridge-dormant', 'bridge-restored', 'island-keyart'):
        if not (SCENE_IMAGES / (key + '.png')).is_file():
            missing.append('image:' + key)
    for key in ('prop-cart', 'prop-materials', 'prop-bell', 'prop-waystation', 'prop-leafwing', 'prop-dragon'):
        if not (SCENE_IMAGES / 'clean' / (key + '.png')).is_file():
            missing.append('image:' + key)
    for key in ('npc-awei', 'npc-mucen', 'npc-lanzhi'):
        if not (CHARACTER_IMAGES / 'clean' / (key + '.png')).is_file():
            missing.append('portrait:' + key)

    alpha_paths = {
        SCENE_IMAGES / 'clean' / (key + '.png')
        for key in ('prop-cart', 'prop-materials', 'prop-bell', 'prop-waystation', 'prop-leafwing', 'prop-dragon')
    } | {
        CHARACTER_IMAGES / 'clean' / (key + '.png')
        for key in ('npc-awei', 'npc-mucen', 'npc-lanzhi')
    }
    for path in source_files():
        row = {'path': path.relative_to(ROOT).as_posix(), 'bytes': path.stat().st_size}
        if row['bytes'] == 0 and path.suffix != '.log':
            missing.append('empty:' + row['path'])
        if path.suffix == '.png':
            row.update(png_info(path))
            if path in alpha_paths and not (row['alpha_channel'] and row['has_transparent_pixels'] and row['has_visible_pixels']):
                missing.append('transparent alpha channel:' + row['path'])
        elif path.suffix == '.json':
            json.loads(path.read_text(encoding='utf-8'))
        elif path.suffix == '.wav':
            with wave.open(str(path), 'rb') as stream:
                row.update({'seconds': stream.getnframes() / stream.getframerate(), 'sample_rate': stream.getframerate(), 'channels': stream.getnchannels()})
                if not stream.getnframes():
                    missing.append('silent-empty wav:' + row['path'])
        files.append(row)

    for scene in ('bridge', 'island'):
        stems = list((MUSIC / scene).glob(scene + '_m[1-4]_*.wav'))
        if len(stems) != 4:
            missing.append(scene + ':four WAV stems')
        else:
            lengths = []
            for path in stems:
                with wave.open(str(path), 'rb') as stream:
                    lengths.append((stream.getnframes(), stream.getframerate(), stream.getnchannels()))
            if len(set(lengths)) != 1:
                missing.append(scene + ':aligned stem lengths')
        for suffix in ('.wav', '.ogg'):
            if not (MUSIC / scene / (scene + '_mix' + suffix)).is_file():
                missing.append(scene + ':mix' + suffix)
    if not list(BLENDER.rglob('*.blend')):
        missing.append('editable Blender project (scene contents require separate MCP inspection)')
    if len(list(BLENDER.rglob('*.glb'))) < 2:
        missing.append('two GLB scene exports')
    for name in ('characters.json', 'facts.json', 'dialogue.json', 'behavior_trees.json'):
        if not (SCENES / 'narrative' / name).is_file():
            missing.append('narrative:' + name)
    return {'scope': 'file integrity and requested asset categories only; no claim about art quality, MCP behavior, narrative semantics or game integration', 'complete_file_categories': not missing, 'missing': missing, 'files': files}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--partial', action='store_true', help='allow in-progress missing files; report still marks incomplete')
    args = parser.parse_args()
    result = audit()
    AUDIT.parent.mkdir(parents=True, exist_ok=True)
    AUDIT.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'files': len(result['files']), 'missing': result['missing']}, ensure_ascii=False))
    if result['missing'] and not args.partial:
        raise SystemExit(1)
