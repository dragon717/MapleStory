"""Copy the selected WZ export into the browser's fixed runtime schema."""
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'references/browser-probe'
TARGET = ROOT / 'client/public/assets'

def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

if __name__ == '__main__':
    manifest = json.loads((SOURCE / 'manifest.json').read_text(encoding='utf-8'))
    source_map = json.loads((SOURCE / 'map.json').read_text(encoding='utf-8'))
    assert manifest['contentVersion'] == 'gms83-mvp-1'
    TARGET.mkdir(parents=True, exist_ok=True)
    actions = {name: action['frames'] if isinstance(action, dict) else action
               for name, action in manifest['avatar']['actions'].items()}
    manifest['avatar']['actions'] = actions
    count = 0
    for record in list(manifest['map']['layers']) + [p for frames in actions.values() for f in frames for p in f['parts']]:
        relative = Path(record['url'])
        assert not relative.is_absolute() and '..' not in relative.parts
        source = SOURCE / relative
        assert source.is_file(), str(source)
        destination = TARGET / relative.name
        shutil.copyfile(str(source), str(destination))
        record['url'] = '/assets/' + relative.name
        count += 1
    bgm = ROOT / 'resources/gms83-export/audio-by-path/Sound.wz/Bgm00.img/FloralLife.mp3'
    shutil.copyfile(str(bgm), str(TARGET / 'FloralLife.mp3'))
    manifest['map']['bgm'] = '/assets/FloralLife.mp3'
    # Character.wz/Weapon/01302029.img/info/sfx is "swordS".
    attack_sound = ROOT / 'resources/gms83-export/audio-by-path/Sound.wz/Weapon.img/swordS/Attack.mp3'
    shutil.copyfile(str(attack_sound), str(TARGET / 'swordS-Attack.mp3'))
    manifest['avatar']['attackSound'] = '/assets/swordS-Attack.mp3'
    manifest['avatar']['attackSoundSource'] = 'Character.wz/Weapon/01302029.img/info/sfx=swordS -> Sound.wz/Weapon.img/swordS/Attack'
    assert sum(f['delay'] for f in actions['attack']) == 800
    footholds = [dict(f, id=int(str(f['id']).split('/')[-1])) for f in source_map['footholds']]
    assert len({f['id'] for f in footholds}) == len(footholds)
    spawn = source_map.get('spawn') or source_map['spawns'][0]
    save(ROOT / 'shared/map.json', {'id': source_map['id'], 'bounds': source_map['bounds'],
         'spawn': {'x': spawn['x'], 'y': spawn['y']}, 'footholds': footholds, 'source': source_map['source']})
    save(TARGET / 'manifest.json', manifest)
    print('Integrated', count, 'image references;', len(footholds), 'footholds; attack 800ms')
