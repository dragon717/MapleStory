"""Build the source-backed Maple Road map catalog used by both integrations."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCOPE = ROOT / 'evidence/reference/mushroom-village-scope-2026-09-05.json'
BIRTH_MAP_ID = '000010000'
CORE_MAP_IDS = (
    '000010000', '000020000', '000020001', '000030000', '000030001',
    '000040000', '000040001', '000040002', '000050000', '000050001',
    '000060000', '000060001',
)
AMHERST_MAP_IDS = (
    '001000000', '001000001', '001000002', '001000003',
    '001000004', '001000005', '001000006',
)


def number(value):
    if value is None or value == '':
        return None
    value = float(value)
    return int(value) if value.is_integer() else value


def map_id(value):
    value = str(value)
    return None if value == '999999999' else value.zfill(9)


def control_guide():
    return [
        {'id': 'move', 'keys': ['← →', 'A D'], 'separator': '/', 'label': '移动'},
        {'id': 'climb', 'keys': ['↑ ↓'], 'separator': '/', 'label': '攀爬'},
        {'id': 'jump', 'keys': ['Space'], 'separator': '/', 'label': '跳跃'},
        {'id': 'downJump', 'keys': ['↓', 'Space'], 'separator': '+', 'label': '下跳'},
        {'id': 'attack', 'keys': ['X', 'Ctrl'], 'separator': '/', 'label': '普攻'},
        {'id': 'pickup', 'keys': ['Z'], 'separator': '/', 'label': '拾取'},
        {'id': 'inventory', 'keys': ['I'], 'separator': '/', 'label': '背包'},
    ]


def map_entry(record, current_id):
    name = record['names'][0]
    info = record.get('info', {})
    bounds = {key: number(info.get(source)) for key, source in (
        ('xMin', 'VRLeft'), ('xMax', 'VRRight'), ('yMin', 'VRTop'), ('yMax', 'VRBottom'))
    }
    portals = []
    for raw in record.get('portals', []):
        portal = {
            'name': raw.get('pn', ''),
            'type': number(raw.get('pt', 0)),
            'x': number(raw.get('x', 0)),
            'y': number(raw.get('y', 0)),
            'targetMapId': map_id(raw.get('tm', '999999999')),
            'targetPortalName': raw.get('tn') or None,
        }
        if raw.get('script'):
            portal['script'] = raw['script']
        if raw.get('onlyOnce') not in (None, ''):
            portal['onlyOnce'] = raw['onlyOnce'] == '1'
        portals.append(portal)
    return {
        'id': current_id,
        'name': name.get('mapName', current_id),
        'streetName': name.get('streetName', ''),
        'source': f'Map.wz/Map/Map0/{current_id}.img',
        'assetStatus': 'metadata',
        'bounds': bounds,
        'bgm': info.get('bgm'),
        'portals': portals,
    }


def build_map_catalog(rendered=None):
    scope = json.loads(SCOPE.read_text(encoding='utf-8'))
    records = {str(record['id']): record for record in scope['maps']}
    missing = [current_id for current_id in CORE_MAP_IDS + AMHERST_MAP_IDS if current_id not in records]
    if missing:
        raise ValueError(f"map catalog evidence missing: {', '.join(missing)}")

    catalog = {
        'birthMapId': BIRTH_MAP_ID,
        'source': scope['source'],
        'maps': [map_entry(records[current_id], current_id) for current_id in CORE_MAP_IDS],
        'omitted': [
            {'id': current_id, 'reason': '已确认 WZ metadata，但当前导出没有对应图层资源；资源接入后再启用。'}
            for current_id in AMHERST_MAP_IDS
        ],
    }
    if not rendered:
        return catalog

    rendered_maps = rendered.get('maps', rendered) if isinstance(rendered, dict) else rendered
    rendered_by_id = {str(item['id']): item for item in rendered_maps if isinstance(item, dict) and item.get('id')}
    present = {item['id'] for item in catalog['maps']}
    for item in catalog['maps']:
        source = rendered_by_id.get(item['id'])
        if source and source.get('layers'):
            item.update(source)
            item['assetStatus'] = 'rendered'
    for current_id in AMHERST_MAP_IDS:
        source = rendered_by_id.get(current_id)
        if current_id not in present and source and source.get('layers'):
            item = map_entry(records[current_id], current_id)
            item.update(source)
            item['assetStatus'] = 'rendered'
            catalog['maps'].append(item)
    rendered_ids = {item['id'] for item in catalog['maps'] if item['assetStatus'] == 'rendered'}
    catalog['omitted'] = [item for item in catalog['omitted'] if item['id'] not in rendered_ids]
    return catalog


def apply_catalog(manifest, rendered=None):
    catalog = build_map_catalog(rendered)
    birth = next(record for record in catalog['maps'] if record['id'] == BIRTH_MAP_ID)
    manifest['mapCatalog'] = catalog
    manifest['controls'] = control_guide()
    manifest['map'].update({key: birth[key] for key in ('id', 'name', 'source', 'bounds', 'bgm', 'portals') if key in birth})
    for key in ('layers', 'ladders', 'footholds', 'spawn', 'spawns'):
        if key in birth:
            manifest['map'][key] = birth[key]
    return manifest


if __name__ == '__main__':
    rendered_path = ROOT / 'references/gameplay-assets/maps/catalog.json'
    rendered = json.loads(rendered_path.read_text(encoding='utf-8')) if rendered_path.is_file() else None
    catalog = build_map_catalog(rendered)
    assert catalog['maps'][0]['id'] == BIRTH_MAP_ID
    assert catalog['maps'][0]['name'] == 'Mushroom Town'
    assert any(portal['targetMapId'] == '000020000' for portal in catalog['maps'][0]['portals'])
    assert any(control['id'] == 'inventory' and control['keys'] == ['I'] for control in control_guide())
    print(f"catalogued {len(catalog['maps'])} rendered/catalog maps; omitted {len(catalog['omitted'])} Amherst maps")
