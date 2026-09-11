"""Backfill the TMS273.7 inventory-slot-expansion coupons into `shared/items.json`.

Why this exists
---------------
The runtime inventory is fixed at 24 slots per tab, but TMS273 authors a family
of Consume items that double as a character-action to grow one tab's slot
count up to 128.  They are not cosmetic: the source marks them with an
`info.slotExpand` field naming the target tab (1=equip, 2=use, 3=setup,
4=etc) and the String catalog gives them a human name and description, e.g.

    `2430768` 裝備欄 8格擴充券  "道具點兩下時，可增加8格裝備道具欄位。最多可擴增到128格欄位。"

This script adds those items (and only those) to the runtime catalog.  It reads
nothing but the local TMS273.7 WZ JSON, so every value below is a T-source
fact, not a guess.

Selected coupon set (one per ordinary tab, plus the "choose" forms):
  2430768  slotExpand=1  equip   8 slots
  2430769  slotExpand=2  use     8 slots
  2430770  slotExpand=3  setup   8 slots
  2430771  slotExpand=4  etc     8 slots
  2434653  slotExpand=-1 choose  4 slots   (equip/use/setup/etc pick one)
  2634366  slotExpand=-1 choose  8 slots   (equip/use/setup/etc pick one)

The `slotExpand=-1` "choose" coupons are authored as NPC-script driven in the
source (`consume_2434653` etc).  Their script semantics are not executable
here; they are imported as data so a client/`useItem` handler may later pick
the target, but the runtime only expands the *fixed* `slotExpand` 1..4 forms
this round.  The -1 forms are kept out of the shop to avoid implying a
selection UI that does not exist yet.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WZ = ROOT / '参考/273/TMS273少爷一键端/手工服务端/tms273/WZ_JSON_TW/Item'
STR = WZ.parent / 'String' / 'Consume.json'
TARGET = ROOT / 'shared/items.json'
MIRRORS = [
    ROOT / 'client/public-tms273/assets/items.json',
    ROOT / 'resources/tms273-export/items.json',
]

# id -> (target tab or -1, slots, source `script`).  All are inventoryType 2.
COUPONS = {
    '2430768': 1,
    '2430769': 2,
    '2430770': 3,
    '2430771': 4,
    '2434653': -1,   # choose, 4 slots — imported for data only
    '2634366': -1,   # choose, 8 slots — imported for data only
}


def wz_scalar(raw):
    """Unwrap a WZ JSON scalar `{'..','_value':..}` to a plain int/str/None."""
    if isinstance(raw, dict):
        raw = raw.get('_value')
    if raw is None:
        return None
    text = str(raw)
    try:
        return int(text)
    except ValueError:
        return text


def load_strings():
    if not STR.exists():
        return {}
    data = json.loads(STR.read_text(encoding='utf-8'))
    result = {}
    for item_id, node in data.items():
        name = (node or {}).get('name')
        desc = (node or {}).get('desc')
        result[item_id] = (
            name.get('_value') if isinstance(name, dict) else None,
            desc.get('_value') if isinstance(desc, dict) else None,
        )
    return result


def tms_item(item_id: str):
    padded = f'{int(item_id):08d}'
    path = WZ / 'Consume' / padded[:4] / f'{padded}.json'
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding='utf-8'))
    info = data.get('info') or {}
    spec = data.get('spec') or {}
    # info is authoritative for these coupons; slotExpand lives in `info`.
    slot_expand = wz_scalar(info.get('slotExpand'))
    return {
        'slotExpand': slot_expand,
        'slotMax': wz_scalar(info.get('slotMax')),
        'price': wz_scalar(info.get('price')),
        'notConsume': wz_scalar(info.get('notConsume')),
        'tradeBlock': wz_scalar(info.get('tradeBlock')),
        'script': wz_scalar(spec.get('script')),
        'npc': wz_scalar(spec.get('npc')),
    }


def main() -> None:
    items = json.loads(TARGET.read_text(encoding='utf-8'))
    strings = load_strings()
    added, changed = [], []
    for item_id, slot_expand in COUPONS.items():
        src = tms_item(item_id)
        if src is None or src['slotExpand'] != slot_expand:
            raise SystemExit(f'{item_id}: TMS273 slotExpand mismatch ({src})')
        name, description = strings.get(item_id, (None, None))
        entry = {
            'inventoryType': 2,
            'slotMax': src['slotMax'] or 200,
            'info': {
                'slotMax': src['slotMax'] or 200,
            },
            'spec': {},
            'source': f'Item/Consume/0243/{item_id}.json',
            'sourceItemId': f'{int(item_id):08d}',
            'spriteSource': f'Item/Consume/0243.img/{int(item_id):08d}/info/icon',
            'spriteSourceStatus': 'json-present',
            'name': name or item_id,
            'description': description or '',
        }
        if src['price'] is not None:
            entry['info']['price'] = src['price']
        if src['notConsume'] is not None:
            entry['info']['notConsume'] = src['notConsume']
        if src['tradeBlock'] is not None:
            entry['info']['tradeBlock'] = src['tradeBlock']
        if src['script'] is not None:
            entry['spec']['script'] = src['script']
        if src['npc'] is not None:
            entry['spec']['npc'] = src['npc']
        # The runtime reads `slotExpand` from `info`, mirroring the source node.
        entry['info']['slotExpand'] = slot_expand
        if item_id in items:
            changed.append((item_id, 'updated'))
        else:
            added.append((item_id, entry['name']))
        items[item_id] = entry

    payload = json.dumps(items, ensure_ascii=False, indent=2) + '\n'
    TARGET.write_text(payload, encoding='utf-8')
    for mirror in MIRRORS:
        if mirror.exists():
            mirror.write_text(payload, encoding='utf-8')

    print(f'added {len(added)} slot-expand coupons, updated {len(changed)}')
    for item_id, name in added:
        print(f'  {item_id} {name} -> slotExpand={COUPONS[item_id]}')


if __name__ == '__main__':
    main()
