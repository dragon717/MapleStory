"""Partition the user's mesh, retaining every triangle and its original UV.

Run on the host; import the resulting OBJ through the live Blender MCP.
The geometric masks describe this particular generated model, not future ships.
"""
from collections import Counter, defaultdict
from pathlib import Path
import json
import math
from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'resources/scenes/sky-voyage-v3'
SOURCE = OUT / 'vendor/user-ship'
SCALE = 150 / .851965
CENTRE = .0708055


def part_at(x, y, z):
    side = 'Port' if z < 0 else 'Starboard'
    angle = math.degrees(math.atan2(y - .626, x - .216)) % 360
    if -.159 < x < .238 and y > .503 and 160 < angle < 204:
        if abs(x - .011) < .007 and abs(z) < .013:
            return 'Hull'
        return 'MainFan_' + str(0 if angle < 175 else 1 if angle < 187 else 2)
    if x < -.174 and y > .584:
        angle = math.degrees(math.atan2(y - .58, x + .209))
        return 'AftFan_' + str(0 if angle < 80 else 1 if angle < 120 else 2)
    radius = math.hypot(x - .24, y - .46)
    if radius < .055 and abs(z) > .018:
        return 'Wheel_' + side
    if x > .185 and y < .426:
        return 'BowVane_' + side
    if x < -.115 and y < .411:
        return 'AftVane_' + side
    if -.113 < x < .10 and .401 < y < .461 and abs(z) > .039:
        return ('Nozzle_' if x > .06 else 'Engine_') + side
    if -.072 < x < .064 and y < .373:
        return 'Crystal'
    return 'Hull'


def paint(part, point, rgb):
    x, y, z = point
    r, g, b = rgb
    if max(rgb) < 110 and b > r * .9:
        return 'Navy'
    if part == 'Crystal' and r > g * 1.16 and r > b * 1.5:
        return 'Amber'
    if b > r * 1.4 and g > r * 1.1:
        return 'Sapphire'
    if g > r * 1.09 and g > b * 1.08:
        return 'Jade'
    if r > g * 1.09 and g > b * 1.25:
        return 'Wood' if .465 < y < .53 and -.18 < x < .185 else 'Brass'
    if max(rgb) < 82:
        return 'Navy'
    if 'Fan' in part or 'Vane' in part or 'Wheel' in part:
        return 'Linen' if min(rgb) > 92 and max(rgb) - min(rgb) < 76 else 'Brass'
    return 'Enamel'


def main():
    vertices, uv, faces = [], [], []
    for line in (SOURCE / 'd04169d2e8fd6eec32b5de965560538a.obj').read_text(encoding='utf-8').splitlines():
        values = line.split()
        if not values:
            continue
        if values[0] == 'v':
            vertices.append(tuple(map(float, values[1:4])))
        elif values[0] == 'vt':
            uv.append(tuple(map(float, values[1:3])))
        elif values[0] == 'f':
            faces.append(tuple(tuple(int(v) - 1 for v in value.split('/')[:2]) for value in values[1:]))
    parent = list(range(len(vertices)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for face in faces:
        a = find(face[0][0])
        for index, _ in face[1:]:
            parent[find(index)] = a
    roots = [find(i) for i in range(len(vertices))]
    main_root, count = Counter(roots).most_common(1)[0]
    assert count == 142692, 'Source changed; inspect the connected components before using the masks.'
    image = Image.open(SOURCE / 'texture_pbr_20250901.png').convert('RGB')
    pix = image.load()
    groups = defaultdict(list)
    source_count = 0
    for index, face in enumerate(faces):
        if roots[face[0][0]] != main_root:
            continue
        source_count += 1
        centre = tuple(sum(vertices[v][i] for v, _ in face) / 3 for i in range(3))
        tex = tuple(sum(uv[t][i] for _, t in face) / 3 for i in range(2))
        rgb = pix[min(image.width - 1, int(tex[0] * image.width)), min(image.height - 1, int((1 - tex[1]) * image.height))]
        part = part_at(*centre)
        material = paint(part, centre, rgb)
        if part.startswith('MainFan') and (material == 'Wood' or
                (abs(centre[0] - .011) < .024 and abs(centre[2]) < .055 and material != 'Linen') or
                (centre[1] < .558 and centre[0] < -.065 and material in {'Sapphire', 'Jade', 'Navy'})):
            part = 'Hull'
        if part.startswith('AftFan') and centre[1] < .62 and material in {'Sapphire', 'Jade', 'Wood', 'Navy'}:
            part = 'Hull'
        groups[part].append((face, material, index))
    assert source_count == 285840
    assert sum(len(group) for group in groups.values()) == source_count
    # Atlas lighting creates isolated colour labels. Vote over shared vertices
    # within each component; retain the source topology and broad colour borders.
    for part, group in groups.items():
        for _ in range(3):
            votes = defaultdict(Counter)
            for face, material, _ in group:
                for vertex, _ in face:
                    votes[vertex][material] += 1
            cleaned = []
            for face, material, index in group:
                neighbours = Counter({material: 3})
                for vertex, _ in face:
                    neighbours.update(votes[vertex])
                cleaned.append((face, neighbours.most_common(1)[0][0], index))
            group = cleaned
        groups[part] = group
    pivots = {
        'Hull': (CENTRE, .46, 0), 'Crystal': (0, .36, 0),
        **{f'MainFan_{i}': (.216, .626, 0) for i in range(3)},
        **{f'AftFan_{i}': (-.209, .58, 0) for i in range(3)},
    }
    for side, z in [('Port', -.055), ('Starboard', .055)]:
        for kind, x, y in [('Wheel', .24, .46), ('BowVane', .376, .427), ('AftVane', -.134, .412), ('Engine', -.005, .435), ('Nozzle', .071, .435)]:
            pivots[kind + '_' + side] = (x, y, z)
    materials = ['Enamel', 'Brass', 'Wood', 'Linen', 'Sapphire', 'Jade', 'Navy', 'Amber']
    with (OUT / 'models/ship-parts.obj').open('w', encoding='utf-8') as output:
        output.write('mtllib ship-parts.mtl\n')
        offset, tex_offset = 0, 0
        for part, group in sorted(groups.items()):
            output.write('o SV3_' + part + '\n')
            indices = sorted({i for face, _, _ in group for i, _ in face})
            tex_indices = sorted({i for face, _, _ in group for _, i in face})
            lookup = {index: i + offset + 1 for i, index in enumerate(indices)}
            tex_lookup = {index: i + tex_offset + 1 for i, index in enumerate(tex_indices)}
            for i in indices:
                x, y, z = vertices[i]
                output.write(f'v {z * SCALE:.7f} {(x - CENTRE) * SCALE:.7f} {(y - .46) * SCALE:.7f}\n')
            for i in tex_indices:
                output.write('vt %.7f %.7f\n' % uv[i])
            current = None
            for face, material, _ in group:
                if material != current:
                    output.write('usemtl SV3_' + material + '\n')
                    current = material
                output.write('f ' + ' '.join(f'{lookup[v]}/{tex_lookup[t]}' for v, t in face) + '\n')
            offset += len(indices)
            tex_offset += len(tex_indices)
    (OUT / 'models/ship-parts.mtl').write_text(''.join(f'newmtl SV3_{m}\nKd 0.8 0.8 0.8\n\n' for m in materials), encoding='utf-8')
    sheet = Image.open(OUT / 'textures/material-sheet.png')
    for name, box in [('enamel', (0, 0, .5, .5)), ('brass', (.5, 0, 1, .5)), ('wood', (0, .5, .5, 1)), ('linen', (.5, .5, 1, 1))]:
        sheet.crop(tuple(round(v * sheet.width) for v in box)).save(OUT / f'textures/{name}.png')
    manifest = {
        'sourceTriangles': len(faces), 'mainTriangles': source_count,
        'excludedTriangles': len(faces) - source_count, 'scale': SCALE,
        'axes': 'Blender X=width, Y=aft-to-bow, Z=up; glTF X=width,Y=up,-Z=bow',
        'originalUv': 'SourceUV retained alongside the material projection UV',
        'parts': {name: {'triangles': len(group), 'pivotBlender': [pivots[name][2] * SCALE, (pivots[name][0] - CENTRE) * SCALE, (pivots[name][1] - .46) * SCALE],
                         'materials': dict(Counter(material for _, material, _ in group))} for name, group in sorted(groups.items())},
    }
    (OUT / 'rig-source.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(manifest, ensure_ascii=False))


if __name__ == '__main__':
    main()
