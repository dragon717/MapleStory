"""Backfill missing consumable `spec` (and `slotMax`) from the local TMS273.7 WZ.

Why this exists
---------------
`shared/items.json` was exported from the **v83** WZ XML (`export_inventory.py`).
v83's Consume `spec` node does not carry the fields this version needs, so every
one of the 41 consumables ended up with `spec: {}` and the default `slotMax` of
100.  The consequence is not cosmetic:

* `inventory::use_effect` reads `spec.hp` / `spec.mp`, finds nothing, and
  returns `ItemNotUsable` for **every** potion.  紅色藥水／白色藥水／蘋果 and
  every other recovery item in the game cannot be used at all.
* The same `spec` node is where TMS273 authors `hpR`/`mpR` (percentage
  recovery, e.g. 超級藥水 hpR=100) — the original has both a flat and a
  percentage recovery form, and only the flat one was ever wired up.
* `slotMax` is authored per item in the source (紅色藥水 = 3000, 蘋果 = 300).
  The blanket 100 makes every stack far smaller than the original.

TMS273.7 authors all of these, and it is the version this project is
remaking, so it is the correct source.  Only *missing* keys are filled; an
existing value is never overwritten, so the verified v83 equipment table is
untouched.

Fields read (all from `Item/Consume/<4-digit>/<8-digit>.json`)
-------------------------------------------------------------
* `spec.hp`   — flat HP restored                    (紅色藥水 50)
* `spec.mp`   — flat MP restored                    (藍色藥水 300)
* `spec.hpR`  — HP restored as a % of max HP        (超級藥水 100)
* `spec.mpR`  — MP restored as a % of max MP        (超級藥水 100)
* `spec.time` — optional use cooldown in **ms**; absent means no cooldown,
  which is exactly how the original treats ordinary potions.  Only the items
  that author it (mostly later percentage-recovery items) get one.
* `info.slotMax` — authored stack ceiling

Source boundary
---------------
T: every value above is read from the local TMS273.7 client
   `参考/273/.../WZ_JSON_TW/Item/Consume/`.  No value is invented: an item the
   TMS273 set does not contain keeps its empty `spec` and stays unusable
   rather than being guessed.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WZ = ROOT / '参考/273/TMS273少爷一键端/手工服务端/tms273/WZ_JSON_TW/Item'
TARGET = ROOT / 'shared/items.json'
# The same file is mirrored for the browser bundle; both must stay in step.
MIRRORS = [
    ROOT / 'client/public-tms273/assets/items.json',
    ROOT / 'resources/tms273-export/items.json',
]

KIND_BY_TYPE = {2: 'Consume'}
# Only these `spec` keys are meaningful to the server's use effect.  The source
# `spec` node also carries npc/script/recipe/morph entries for item types this
# project does not execute; copying them in would only imply support that does
# not exist.
SPEC_KEYS = ('hp', 'mp', 'hpR', 'mpR', 'time')


def wz_value(raw):
    """WZ JSON scalars are wrapped as {'_dirType':..,'_value':..}."""
    if isinstance(raw, dict):
        raw = raw.get('_value')
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def tms_spec(item_id: str, kind: str):
    """Return (spec_fields, slot_max) authored for one item id, or (None, None).

    `time` is the authored use cooldown in milliseconds.  It is read but never
    required: the vast majority of potions author no cooldown at all, and a
    server-side default here would be an invented rule.
    """
    if not item_id.isdigit():
        return None, None
    padded = f'{int(item_id):08d}'
    path = WZ / kind / padded[:4] / f'{padded}.json'
    if not path.exists():
        return None, None
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None, None
    spec = data.get('spec') or {}
    fields = {}
    for key in SPEC_KEYS:
        value = wz_value(spec.get(key))
        if value is not None:
            fields[key] = value
    slot_max = wz_value((data.get('info') or {}).get('slotMax'))
    return fields, slot_max


def main() -> None:
    items = json.loads(TARGET.read_text(encoding='utf-8'))
    filled, stack_fixed, skipped = [], [], []
    for item_id, item in items.items():
        kind = KIND_BY_TYPE.get(item.get('inventoryType'))
        if kind is None:
            continue
        fields, slot_max = tms_spec(item_id, kind)
        if fields is None and slot_max is None:
            skipped.append(item_id)
            continue
        spec = item.setdefault('spec', {})
        changed = False
        for key, value in fields.items():
            if spec.get(key) is None:
                spec[key] = value
                changed = True
        if changed:
            filled.append((item_id, item.get('name', item_id), dict(spec)))
        # The v83 export wrote a blanket 100; the source value is authoritative.
        if slot_max is not None and item.get('slotMax') != slot_max:
            item['slotMax'] = slot_max
            stack_fixed.append((item_id, item.get('name', item_id), slot_max))

    payload = json.dumps(items, ensure_ascii=False, indent=2) + '\n'
    TARGET.write_text(payload, encoding='utf-8')
    for mirror in MIRRORS:
        if mirror.exists():
            mirror.write_text(payload, encoding='utf-8')

    print(f'filled spec for {len(filled)} consumables from TMS273')
    for item_id, name, spec in filled[:12]:
        print(f'  {item_id} {name} -> {spec}')
    print(f'corrected slotMax for {len(stack_fixed)} items')
    for item_id, name, value in stack_fixed[:8]:
        print(f'  {item_id} {name} -> {value}')
    if skipped:
        print(f'  no TMS273 Consume entry for {len(skipped)}: ' + ', '.join(skipped[:20]))


if __name__ == '__main__':
    main()
