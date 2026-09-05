"""Integrate selected v83 exports into the isolated gameplay build, never live v1."""
import json
import shutil
from pathlib import Path

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
    assert gameplay['contentVersion'] == 'gms83-gameplay-2'
    assert avatar['avatar']['look']['weapon'][1] == '01302000.img'
    actions = avatar['avatar']['actions']
    assert sum(frame['delay'] for frame in actions['attack']) == 800
    for action in ['ladder', 'rope']:
        assert len(actions[action]) == 2
        assert all(part['part'] != 'face' for frame in actions[action] for part in frame['parts'])
    copy_urls(avatar, SOURCE / 'avatar')
    copy_urls(gameplay, SOURCE)
    actions['climb'] = actions['ladder']
    audio = ROOT / 'resources/gms83-export/audio-by-path/Sound.wz'
    for src, name in [('Bgm00.img/FloralLife.mp3', 'FloralLife.mp3'), ('Weapon.img/swordL/Attack.mp3', 'swordL-Attack.mp3')]:
        shutil.copyfile(str(audio / src), str(TARGET / name))
    avatar['map']['bgm'] = '/assets/FloralLife.mp3'
    avatar['avatar']['attackSound'] = '/assets/swordL-Attack.mp3'
    avatar['avatar']['attackSoundSource'] = 'Character.wz/Weapon/01302000.img/info/sfx=swordL'
    avatar.update(gameplay)

    source_map = read(SOURCE / 'avatar/map.json')
    footholds = [dict(f, id=int(str(f['id']).split('/')[-1])) for f in source_map['footholds']]
    assert len({f['id'] for f in footholds}) == len(footholds)
    ladders = read(ROOT / 'references/evidence/gms83-map-backgrounds.json')['ladders']
    ladders = [dict(ladder, id=int(ladder['id'])) for ladder in ladders]
    avatar['map']['ladders'] = ladders
    save(TARGET / 'manifest.json', avatar)
    spawn = source_map.get('spawn') or source_map['spawns'][0]
    save(ROOT / 'shared/map.json', dict(id=source_map['id'], bounds=source_map['bounds'], spawn=dict(x=spawn['x'], y=spawn['y']), footholds=footholds, ladders=ladders, source=source_map['source']))
    print('Integrated isolated gameplay assets:', gameplay['checks'], 'footholds:', len(footholds), 'ladders:', len(ladders))
