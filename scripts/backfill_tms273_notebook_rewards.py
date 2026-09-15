#!/usr/bin/env python3
"""Backfill the authored 怪物收藏 reward items into the runtime item catalogue.

Why this exists
---------------
`Etc/mobCollection.img` authors one reward per row, per page (分頁) and per
region (地區) — the 方塊椅子 family, the 探險箱 boxes, the 怪物收藏蛋 and the
two region 勳章.  The runtime item catalogue never contained any of them,
because nothing else in the pipeline references those ids:
`generate_tms273_gameplay.py` seeds its id set from usable equipment, map drops
and shop rows only.

The plan asks for exactly this, and only this (§11, §5.6):

    原版机制所需的奖励物品按核定来源补入现有物品目录和获得链路，
    不借机扩展无关商城、掉落经济或任务线。

Scope
-----
The id list is *read*, never re-derived: `resources/tms273-export/notebook.json`
carries the region/page/row keys as `collection.rewardItems`, which
`export_tms273_collection.cjs` resolved against the same-version client
together with the stat JSON and `String/*.json` name each one has.

  * an id whose stat JSON the client really ships is added with the source's own
    `info`/`spec`/`slotMax` and its source name/description;
  * an id the client ships **no** stat JSON for is not added at all.  It stays a
    recorded source boundary (`statStatus: json-missing` in the notebook
    catalogue) instead of a fabricated default-stat item — the same rule
    `generate_tms273_gameplay.py` applies to removed reward rows.

Sprite paths
------------
The unpacked tree keeps split client packs as `<group> 2/` next to `<group>/`,
and the WZ image spelling follows the directory it was found in.  That is
verified, not assumed: all 52 items in `shared/items.json` whose stat JSON lives
in a ` 2` directory are addressed as `<group> 2.img` (and none of the other way
round).  So the sprite path is derived from the directory the stat JSON was
found in, and `export_tms273.cjs items` fails loudly if the node is not there.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WZ = ROOT / '参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW'
NOTEBOOK = ROOT / 'resources/tms273-export/notebook.json'
# The freshly generated gameplay catalogue lives in the export dir; this script
# must add the rewards *there* (the item-image export reads this file right
# after) — never the other way round, or a stale assemble output would be
# mirrored over the regenerated catalogue and drop every new definition.
TARGET = ROOT / 'resources/tms273-export/items.json'
MIRRORS = [
    ROOT / 'shared/items.json',
    ROOT / 'client/public-tms273/assets/items.json',
]


def unwrap(value):
    """Unbox WZ_JSON_TW typed nodes, mirroring generate_tms273_gameplay.py."""
    if isinstance(value, list):
        return [unwrap(item) for item in value]
    if not isinstance(value, dict):
        return value
    kind = value.get('_dirType')
    if kind == 'vector' or ('_x' in value and '_y' in value):
        return {'x': int(value.get('_x') or 0), 'y': int(value.get('_y') or 0)}
    if '_value' in value:
        return value.get('_value')
    return {key: unwrap(item) for key, item in value.items() if key != '_dirType'}


def scalar(value):
    """A WZ scalar as a plain int/str/None, preserving id-sized values."""
    if isinstance(value, dict):
        value = value.get('_value')
    if value is None:
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return int(value)
    text = str(value).strip()
    try:
        return int(text, 10)
    except ValueError:
        return text


def sprite_source(stat_source, item_id):
    """The WZ node path of one reward item's icon.

    The two trees name their images differently, and the dump's directory
    layout mirrors the image layout exactly:

        Item/Consume/0243 2/02434929.json
          -> Item/Consume/0243 2.img/02434929/info/icon
             (the *group directory* is the image, the id is a node inside it)
        Character/Accessory/01142996.json
          -> Character/Accessory/01142996.img/info/icon
             (for equipment the *id itself* is the image)

    The split-client-pack suffix is carried over verbatim — verified, not
    assumed: all 52 items in `shared/items.json` whose stat JSON lives in a
    ` 2` directory are addressed as `<group> 2.img`, and none the other way
    round.  `export_tms273.cjs items` fails loudly if the node is not there.
    """
    parts = stat_source.split('/')
    if len(parts) < 3 or not parts[-1].endswith('.json'):
        raise SystemExit(f'unexpected stat path shape for {item_id}: {stat_source}')
    padded = item_id.zfill(8)
    head = '/'.join(parts[:-1])
    if parts[0] == 'Item':
        return f'{head}.img/{padded}/info/icon'
    return f'{head}/{padded}.img/info/icon'


def definition(item_id, reward):
    stat_source = reward.get('statSource')
    if not stat_source:
        raise SystemExit(f'{item_id}: reward record has no stat JSON to read')
    path = WZ / stat_source
    if not path.exists():
        raise SystemExit(f'{item_id}: recorded stat JSON is gone: {stat_source}')
    raw = json.loads(path.read_text(encoding='utf-8'))
    info = unwrap(raw.get('info') or {})
    spec = unwrap(raw.get('spec') or {})
    if not isinstance(info, dict) or not isinstance(spec, dict):
        raise SystemExit(f'{item_id}: malformed source info/spec in {stat_source}')
    name = reward.get('name')
    if not name:
        # A reward item with no name would render as a bare id in the notebook.
        raise SystemExit(f'{item_id}: no same-version name was resolved for this reward')
    inventory_type = int(item_id) // 1_000_000
    slot_max = scalar(info.get('slotMax'))
    defaults = []
    if not isinstance(slot_max, int) or slot_max <= 0:
        slot_max = 1 if inventory_type == 1 else 100
        defaults.append('slotMax')
    entry = {
        'inventoryType': inventory_type,
        'slotMax': slot_max,
        'info': info,
        'spec': spec,
        'source': stat_source,
        'sourceItemId': item_id.zfill(8),
        'spriteSource': sprite_source(stat_source, item_id),
        'spriteSourceStatus': 'json-present',
        'name': name,
    }
    description = reward.get('description')
    if description:
        entry['description'] = description
    if defaults:
        entry['defaultsApplied'] = defaults
    return entry


def main() -> None:
    if not NOTEBOOK.exists():
        raise SystemExit(f'{NOTEBOOK} is missing; run scripts/export_tms273_collection.cjs first')
    notebook = json.loads(NOTEBOOK.read_text(encoding='utf-8'))
    rewards = notebook['collection'].get('rewardItems') or {}
    if not rewards:
        raise SystemExit('the notebook export carries no reward items to backfill')

    items = json.loads(TARGET.read_text(encoding='utf-8'))
    added, updated, skipped = [], [], []
    for item_id in sorted(rewards, key=int):
        reward = rewards[item_id]
        if reward.get('statStatus') != 'json-present':
            skipped.append((item_id, reward.get('name'), reward.get('statSource')))
            continue
        entry = definition(item_id, reward)
        # This script owns exactly the notebook's reward ids — nothing else in
        # the pipeline authors them — so a re-run rewrites its own records
        # instead of leaving a stale definition behind.  (The slot-expand
        # backfill fills missing keys only, because its ids *are* authored
        # elsewhere and a downstream price/spec pass must keep winning.)
        previous = items.get(item_id)
        items[item_id] = entry
        if previous is None:
            added.append((item_id, entry['name'], reward['statSource']))
        elif previous != entry:
            updated.append((item_id, entry['name'], reward['statSource']))

    payload = json.dumps(items, ensure_ascii=False, indent=2) + '\n'
    TARGET.write_text(payload, encoding='utf-8')
    for mirror in MIRRORS:
        if mirror.exists():
            mirror.write_text(payload, encoding='utf-8')

    print(f'added {len(added)}, refreshed {len(updated)} collection reward items; '
          f'{len(skipped)} keys have no stat JSON in this client version')
    for item_id, name, source in added:
        print(f'  + {item_id} {name} <- {source}')
    for item_id, name, source in updated:
        print(f'  ~ {item_id} {name} <- {source}')
    for item_id, name, _ in skipped:
        print(f'  - {item_id} {name} (source boundary: no stat JSON)')


if __name__ == '__main__':
    sys.exit(main())
