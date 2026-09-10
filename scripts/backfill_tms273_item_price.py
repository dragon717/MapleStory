"""Backfill missing catalog `price` values from the local TMS273.7 WZ JSON.

Why this exists
---------------
`shared/items.json` is exported from the v83 WZ XML (`export_inventory.py`),
whose Consume `info` node carries no `price`.  Every one of the 41 consumables
in the rendered set therefore had no price at all, which made them unsellable
once the shop sell-back was implemented: the server cannot invent a value for
an item that has none.

The TMS273.7 WZ JSON does author the value (紅色藥水 02000000 -> price 3), and
it is the same version this project is remaking, so it is the correct source.
Only *missing* prices are filled; an existing value is never overwritten, so
the v83-derived equipment table stays exactly as it is.

Source boundary
---------------
T: price read from `参考/273/.../WZ_JSON_TW/Item/{Consume,Etc,Cash}/<4-digit>/<8-digit>.json`
   of the local TMS273.7 client.  Items the TMS273 set does not contain keep
   their missing price and stay unsellable rather than being guessed.
"""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WZ = ROOT / '参考/273/TMS273少爷一键端/手工服务端/tms273/WZ_JSON_TW/Item'
TARGET = ROOT / 'shared/items.json'
# Same file is mirrored for the browser bundle; both must stay in step.
MIRRORS = [
    ROOT / 'client/public-tms273/assets/items.json',
    ROOT / 'resources/tms273-export/items.json',
]

# inventoryType -> TMS273 WZ subdirectory.  Type 1 (Equip) already carries its
# price from the v83 export and is deliberately not touched: the TMS273 Equip
# tree is laid out differently and rewriting it would churn verified values.
KIND_BY_TYPE = {2: 'Consume', 3: 'Install', 4: 'Etc', 5: 'Cash'}


def wz_value(raw):
    """WZ JSON scalars are wrapped as {'_dirType':..,'_value':..}."""
    if isinstance(raw, dict):
        raw = raw.get('_value')
    if raw is None:
        return None
    try:
        price = int(raw)
    except (TypeError, ValueError):
        return None
    return price if price > 0 else None


def auto_price_table():
    """The original Etc price standard (T).

    `Item/ItemSellPriceStandard.json` maps an Etc item's `lv` to its shop
    value (category 400: lv*n -> n*2, so a lv-1 item is worth 2 mesos).  Etc
    items carry `autoPrice` instead of an authored `price`, so this table —
    not a guess — is what gives monster drops such as 嫩寶殼 a real value.
    """
    path = WZ / 'ItemSellPriceStandard.json'
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}
    table = {}
    for category, entries in data.items():
        if not isinstance(entries, dict):
            continue
        for level, raw in entries.items():
            if not level.isdigit():
                continue
            price = wz_value(raw)
            if price is not None:
                table[(category, int(level))] = price
    return table


def tms_price(item_id: str, kind: str, standard=None):
    """Read the TMS273 shop value for one item id.

    Two authored forms exist in the source:
      * `info.price`        — the explicit value (consumables),
      * `info.autoPrice` + `info.lv` — Etc items priced off
        `ItemSellPriceStandard.json` by their `lv`.
    """
    padded = f'{int(item_id):08d}' if item_id.isdigit() else None
    if padded is None:
        return None
    path = WZ / kind / padded[:4] / f'{padded}.json'
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None
    info = data.get('info') or {}
    price = wz_value(info.get('price'))
    if price is not None:
        return price
    # Etc: `autoPrice` marks the item as priced by the standard table.
    if wz_value(info.get('autoPrice')) is not None and standard is not None:
        level = wz_value(info.get('lv'))
        if level is not None:
            return standard.get((padded[:3], level)) or standard.get(('400', level))
    return None


def main() -> None:
    items = json.loads(TARGET.read_text(encoding='utf-8'))
    standard = auto_price_table()
    filled, still_missing = [], []
    for item_id, item in items.items():
        if wz_value((item.get('info') or {}).get('price')) is not None:
            continue
        kind = KIND_BY_TYPE.get(item.get('inventoryType'))
        if kind is None:
            continue
        price = tms_price(item_id, kind, standard)
        if price is None:
            still_missing.append(item_id)
            continue
        item.setdefault('info', {})['price'] = price
        filled.append((item_id, item.get('name', item_id), price))

    TARGET.write_text(json.dumps(items, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    for mirror in MIRRORS:
        if mirror.exists():
            mirror.write_text(
                json.dumps(items, ensure_ascii=False, indent=2) + '\n', encoding='utf-8'
            )
    print(f'filled {len(filled)} prices from TMS273, {len(still_missing)} still have none')
    for item_id, name, price in filled[:10]:
        print(f'  {item_id} {name} -> {price}')
    if still_missing:
        print('  no TMS273 price for: ' + ', '.join(still_missing[:20]))


if __name__ == '__main__':
    main()
