"""Generate map-specific v83 mob spawns and templates from local source exports."""
import json
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WZ = ROOT / '参考/repos/P0nk__Cosmic/wz'


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def authored_spawns(maps):
    spawns = []
    for map_entry in maps:
        relative = f"Map.wz/Map/Map0/{map_entry['id']}.img.xml"
        life = ET.parse(WZ / relative).getroot().find("imgdir[@name='life']")
        for entry in life if life is not None else []:
            values = {child.get('name'): child.get('value') for child in entry}
            if values.get('type') != 'm' or int(values.get('hide', 0)):
                continue
            x, y, foothold_id = (int(values[key]) for key in ('x', 'y', 'fh'))
            foothold = next((f for f in map_entry['footholds'] if f['id'] == foothold_id), None)
            assert foothold and min(foothold['x1'], foothold['x2']) <= x <= max(foothold['x1'], foothold['x2']), (relative, values)
            spawns.append({
                'id': f"{map_entry['id']}-life-{entry.get('name')}",
                'mapId': map_entry['id'], 'templateId': str(int(values['id'])),
                'x': x, 'y': y, 'footholdId': foothold_id,
                'facing': -1 if int(values.get('f', 0)) else 1,
                'mobTime': int(values.get('mobTime', 0)),
                'source': f"{relative}/life/{entry.get('name')}",
                'sourceLife': values,
            })
    assert len({spawn['id'] for spawn in spawns}) == len(spawns)
    return spawns


def generate(base, manifest, maps, items):
    spawns = authored_spawns(maps)
    templates = []
    quest_drops = []
    for template_id in sorted({spawn['templateId'] for spawn in spawns}, key=int):
        asset = manifest['monsters'][template_id]
        info, actions = asset['info'], asset['actions']
        body = actions['stand'][0]
        lt = body.get('lt') or {'x': body['x'], 'y': body['y']}
        rb = body.get('rb') or {'x': body['x'] + body['width'], 'y': body['y'] + body['height']}
        drops = []
        for drop in asset['drops']:
            if drop['questId']:
                quest_drops.append({'templateId': template_id, **drop})
                continue
            assert drop['itemId'] == '0' or drop['itemId'] in items, drop
            drops.append({'itemId': drop['itemId'], 'quantity': drop['minimum'],
                          'quantityMax': drop['maximum'], 'chance': drop['chance']})
        templates.append({
            'templateId': template_id, 'level': info['level'], 'maxHp': info['maxHP'],
            'PADamage': info.get('PADamage', 0), 'PDDamage': info.get('PDDamage', 0),
            'exp': info.get('exp', 0), 'bodyAttack': bool(info.get('bodyAttack', 0)),
            **({'speed': info.get('speed', 0)} if actions.get('move') else {}),
            'hitboxLt': lt, 'hitboxRb': rb,
            'dieDurationMs': sum(f['delay'] for f in actions['die']),
            'standDelayMs': sum(f['delay'] for f in actions['stand']),
            **({'moveDurationMs': sum(f['delay'] for f in actions['move'])} if actions.get('move') else {}),
            'drop': drops, 'source': asset['source'],
        })
    result = {**base, 'spawns': spawns, 'monsters': templates}
    result['sources'] = {**base.get('sources', {}),
        'monster': [template['source'] for template in templates],
        'spawns': 'Cosmic local v83 Map.wz/Map/Map0/*.img.xml life; mapId/x/y/fh/f/mobTime retained',
        'drops': {'source': 'P0nk/Cosmic/src/main/resources/db/data/152-drop-data.sql',
                  'officialParity': 'Private-server table; official GMS83 rates are not independently verified',
                  'deferredQuestDrops': quest_drops}}
    result['incomplete'] = [note for note in base.get('incomplete', []) if 'three Snail placements' not in note]
    quest_note = 'Quest-conditioned drops remain disabled until authoritative quest state is implemented; source rows retained in sources.drops.deferredQuestDrops.'
    if quest_note not in result['incomplete']:
        result['incomplete'].append(quest_note)
    return result


if __name__ == '__main__':
    gameplay = generate(read(ROOT / 'shared/gameplay.json'),
                        read(ROOT / 'references/gameplay-assets/manifest.json'),
                        read(ROOT / 'shared/maps.json')['maps'], read(ROOT / 'shared/items.json'))
    # Check the generated business configuration against independently counted XML life.
    assert len(gameplay['spawns']) == 168
    assert len(gameplay['monsters']) == 8
    assert not any(spawn['mapId'] == '000010000' for spawn in gameplay['spawns'])
    assert sum(spawn['mobTime'] == 1 for spawn in gameplay['spawns']) == 3
    text = json.dumps(gameplay, ensure_ascii=False, indent=2) + '\n'
    (ROOT / 'shared/gameplay.json').write_text(text, encoding='utf-8')
    print(f"Generated {len(gameplay['monsters'])} templates and {len(gameplay['spawns'])} authored spawns; birth map has no test monsters.")
