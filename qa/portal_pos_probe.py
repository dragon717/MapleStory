#!/usr/bin/env python3
"""Composite map layers from the served manifest and mark portal coordinates.

Usage: python3 qa/portal_pos_probe.py [mapId]   (default 000010000)
"""
from datetime import datetime, timezone, timedelta
import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
MAP_ID = sys.argv[1] if len(sys.argv) > 1 else '000010000'
m = json.loads((ROOT / 'client/public-gameplay/assets/manifest.json').read_text())
entry = next(e for e in m['mapCatalog']['maps'] if e['id'] == MAP_ID)
b = entry['bounds']
W = b['xMax'] - b['xMin']
H = b['yMax'] - b['yMin']
assets = ROOT / 'client/public-gameplay/assets'

canvas = Image.new('RGBA', (W, H), (0, 0, 0, 0))
layers = sorted(entry['layers'], key=lambda l: l['depth'])
missing = 0
for l in layers:
    p = assets / l['url'].replace('/assets/', '')
    if not p.is_file():
        missing += 1
        continue
    img = Image.open(p).convert('RGBA')
    x = l['x'] - b['xMin']
    y = l['y'] - b['yMin']
    canvas.alpha_composite(img, (x, y))
print(f'map {MAP_ID}: layers={len(layers)} missing={missing} size={W}x{H}')

draw = ImageDraw.Draw(canvas)
COLORS = {'in00': (60, 155, 255, 255), 'out00': (255, 60, 60, 255),
          'east00': (255, 140, 0, 255), 'west00': (255, 140, 0, 255)}

def mark(px, py, color, label, beam=None):
    X = px - b['xMin']
    Y = py - b['yMin']
    draw.line([(X, 0), (X, H)], fill=color, width=2)
    draw.ellipse([X - 12, Y - 12, X + 12, Y + 12], outline=color, width=3)
    draw.text((X + 8, H - 60), f'{label} ({px},{py})', fill=color)
    if beam:  # (left_x, top_y, w, h) world coords of the sprite rect
        rx = beam[0] - b['xMin']
        ry = beam[1] - b['yMin']
        draw.rectangle([rx, ry, rx + beam[2], ry + beam[3]], outline=(255, 255, 0, 255), width=2)
        draw.text((rx, ry - 18), f'beam {label}', fill=(255, 255, 0, 255))

for p in entry['portals']:
    if p['name'] in ('in00', 'out00', 'east00', 'west00'):
        pa = m.get('portals', {}).get(f'{MAP_ID}/{p["name"]}')
        beam = None
        if pa and pa.get('frames'):
            f0 = pa['frames'][0]
            ox = f0.get('origin', {}).get('x', 0)
            oy = f0.get('origin', {}).get('y', f0['height'])
            # steady-state anchor (world.ts): anchorY = p.y + (h - oy)
            anchor_y = p['y'] + (f0['height'] - oy)
            beam = (p['x'] - ox, anchor_y - oy, f0['width'], f0['height'])
        mark(p['x'], p['y'], COLORS.get(p['name'], (200, 0, 255, 255)), p['name'], beam)

day = datetime.now(timezone(timedelta(hours=8))).date().isoformat()
out = ROOT / f'evidence/{day}/portal-map/portal-map-composite-{MAP_ID}.png'
out.parent.mkdir(parents=True, exist_ok=True)
canvas.convert('RGB').save(out)
print('saved', out)
