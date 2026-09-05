"""Integrate selected v83 exports into the isolated gameplay build, never live v1."""
import json
import shutil
from pathlib import Path
from map_catalog import apply_catalog

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'references/gameplay-assets'
TARGET = ROOT / 'client/public-gameplay/assets'

def read(path):
    return json.loads(path.read_text(encoding='utf-8'))

def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

def copy_urls(value, source):
    if isinstance(value, dict):
        if 'url' in value:
            relative = Path(value['url'])
            assert not relative.is_absolute() and '..' not in relative.parts
            assert (source / relative).is_file(), str(relative)
            shutil.copyfile(str(source / relative), str(TARGET / relative.name))
            value['url'] = '/assets/' + relative.name
        for child in value.values():
            copy_urls(child, source)
    elif isinstance(value, list):
        for child in value:
            copy_urls(child, source)

if __name__ == '__main__':
    TARGET.mkdir(parents=True, exist_ok=True)
    avatar = read(SOURCE / 'avatar/manifest.json')
    gameplay = read(SOURCE / 'manifest.json')
    rendered_catalog = read(SOURCE / 'maps/catalog.json')
    assert gameplay['contentVersion'] == 'gms83-npc-1'
    rules = read(ROOT / 'shared/gameplay.json')
    assert {template['templateId'] for template in rules['monsters']} <= gameplay['monsters'].keys()
    assert all(asset['actions']['stand'] for asset in gameplay['monsters'].values())
    assert avatar['avatar']['look']['weapon'][1] == '01302000.img'
    loadouts = avatar['avatar'].get('equipmentLoadouts', {})
    assert 'empty' in loadouts
    for item_id in ('1002067', '1040002', '1052095', '1302000'):
        assert any(item_id in loadout.get('itemIds', []) for key, loadout in loadouts.items() if key != 'empty')
    for loadout in loadouts.values():
        assert all(loadout['actions'].get(action) for action in ('stand', 'walk', 'jump', 'attack'))
    required = {str(item['id']) for item in rendered_catalog.get('maps', []) if str(item.get('id')) in {
        '000010000', '000020000', '000020001', '000030000', '000030001', '000040000',
        '000040001', '000040002', '000050000', '000050001', '000060000', '000060001',
        '001000000', '001000001', '001000002', '001000003', '001000004', '001000005', '001000006',
        '001010000', '001020000', '002000000', '002000001',
    }}
    assert required == {
        '000010000', '000020000', '000020001', '000030000', '000030001', '000040000',
        '000040001', '000040002', '000050000', '000050001', '000060000', '000060001',
        '001000000', '001000001', '001000002', '001000003', '001000004', '001000005', '001000006',
        '001010000', '001020000', '002000000', '002000001',
    }, f'missing required rendered maps: {required}'
    assert not rendered_catalog.get('failures'), rendered_catalog.get('failures')
    actions = avatar['avatar']['actions']
    assert sum(frame['delay'] for frame in actions['attack']) == 800
    for action in ['ladder', 'rope']:
        assert len(actions[action]) == 2
        assert all(part['part'] != 'face' for frame in actions[action] for part in frame['parts'])
    copy_urls(avatar, SOURCE / 'avatar')
    copy_urls(gameplay, SOURCE)
    actions['climb'] = actions['ladder']
    audio = ROOT / 'resources/gms83-export/audio-by-path/Sound.wz'
    for src, name in [
        ('Bgm00.img/FloralLife.mp3', 'FloralLife.mp3'),
        ('Bgm00.img/RestNPeace.mp3', 'RestNPeace.mp3'),
        ('Bgm00.img/GoPicnic.mp3', 'GoPicnic.mp3'),
        ('Weapon.img/swordL/Attack.mp3', 'swordL-Attack.mp3'),
        ('Mob.img/0100100/Damage.mp3', 'Mob.wz_0100100_Damage.mp3'),
    ]:
        shutil.copyfile(str(audio / src), str(TARGET / name))
    avatar['map']['bgm'] = '/assets/FloralLife.mp3'
    avatar['avatar']['attackSound'] = '/assets/swordL-Attack.mp3'
    avatar['avatar']['attackSoundSource'] = 'Character.wz/Weapon/01302000.img/info/sfx=swordL'
    copy_urls(rendered_catalog, SOURCE)
    avatar.update(gameplay)
    apply_catalog(avatar, rendered_catalog)
    bgm_urls = {
        'Bgm00/FloralLife': '/assets/FloralLife.mp3',
        'Bgm00/RestNPeace': '/assets/RestNPeace.mp3',
        'Bgm00/GoPicnic': '/assets/GoPicnic.mp3',
    }
    for map_entry in avatar.get('mapCatalog', {}).get('maps', []):
        if map_entry.get('bgm') in bgm_urls:
            map_entry['bgm'] = bgm_urls[map_entry['bgm']]
    avatar['map']['bgm'] = bgm_urls.get(avatar['map'].get('bgm'), '/assets/FloralLife.mp3')

    source_map = read(SOURCE / 'avatar/map.json')
    footholds = [dict(f, id=int(str(f['id']).split('/')[-1])) for f in source_map['footholds']]
    assert len({f['id'] for f in footholds}) == len(footholds)
    birth_rendered = next(item for item in rendered_catalog['maps'] if str(item['id']) == '000010000')
    ladders = birth_rendered['ladders']
    ladders = [dict(ladder, id=int(ladder['id'])) for ladder in ladders]
    spawn = source_map.get('spawn') or source_map['spawns'][0]
    avatar['map']['spawn'] = spawn
    for map_entry in avatar.get('mapCatalog', {}).get('maps', []):
        if map_entry.get('id') == '000010000':
            map_entry['spawn'] = spawn
    avatar['map']['ladders'] = ladders
    save(TARGET / 'manifest.json', avatar)
    save(ROOT / 'shared/map.json', dict(id=source_map['id'], bounds=source_map['bounds'], spawn=dict(x=spawn['x'], y=spawn['y']), footholds=footholds, ladders=ladders, source=source_map['source']))
    server_map_entries = []
    for item in rendered_catalog['maps']:
        entry = {key: item[key] for key in ('id', 'bounds', 'spawn', 'footholds', 'ladders', 'portals') if key in item}
        if entry.get('id') == '000010000':
            entry['spawn'] = {'x': spawn['x'], 'y': spawn['y']}
        server_map_entries.append(entry)
    server_maps = {
        'birthMapId': '000010000',
        'source': rendered_catalog.get('source', ''),
        'maps': server_map_entries,
    }
    save(ROOT / 'shared/maps.json', server_maps)
    print('Integrated isolated gameplay assets:', gameplay['checks'], 'footholds:', len(footholds), 'ladders:', len(ladders))
