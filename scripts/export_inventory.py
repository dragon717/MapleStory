"""Export inventory metadata for the rendered item set from the local v83 WZ XML."""
import json
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WZ = ROOT / '参考/repos/P0nk__Cosmic/wz'


def values(node):
    return {
        child.attrib['name']: int(child.attrib['value'])
        if child.tag in ('int', 'short', 'long') else child.attrib['value']
        for child in node if 'value' in child.attrib
    } if node is not None else {}


def export():
    manifest = json.loads((ROOT / 'references/gameplay-assets/manifest.json').read_text(encoding='utf-8'))
    strings = [ET.parse(path).getroot() for path in (WZ / 'String.wz').glob('*.img.xml')]
    result = {}
    for item_id, asset in manifest['items'].items():
        if item_id == '0':
            continue
        parts = asset['source'].split('/')
        index = next(i for i, part in enumerate(parts) if part.endswith('.img'))
        path = WZ.joinpath(*parts[:index + 1]).with_suffix('.img.xml')
        tree = ET.parse(path).getroot()
        item = tree if parts[0] == 'Character.wz' else tree.find(f"imgdir[@name='{int(item_id):08d}']")
        assert item is not None, item_id
        info = values(item.find("imgdir[@name='info']"))
        spec = values(item.find("imgdir[@name='spec']"))
        text = {}
        for source in strings:
            node = source.find(f".//imgdir[@name='{item_id}']")
            if node is not None and node.find("string[@name='name']") is not None:
                text = values(node)
                break
        result[item_id] = {
            'inventoryType': int(item_id[0]),
            'slotMax': info.get('slotMax', 1 if item_id[0] == '1' else 100),
            'name': text.get('name', item_id), 'description': text.get('desc', ''),
            'info': info, 'spec': spec, 'source': str(path.relative_to(WZ)),
        }
    assert result['2000000']['spec']['hp'] == 50
    assert result['2010009']['spec']['mp'] == 30
    assert result['4000019']['slotMax'] == 200
    assert result['2060000']['slotMax'] == 2000
    assert all(item['slotMax'] == 1 for item in result.values() if item['inventoryType'] == 1)
    return result


if __name__ == '__main__':
    result = export()
    (ROOT / 'shared/items.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Exported and checked {len(result)} inventory item definitions.')
