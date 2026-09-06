"""Give one-way map portals a return path.

The v83 WZ data models a map link asymmetrically: the outgoing side carries
the target (`tm`/`tn`) while the arrival side is a bare `pt=1` anchor with no
target at all.  That made every arrival portal a dead end — it is never
rendered (the client skips portals without `targetMapId`) and pressing ↑ is
rejected by the server (`handle_portal` requires `target_map_id`).

`apply_portal_returns` closes the loop: for every outgoing portal A/p that
points at B/q, if B/q has no destination of its own it inherits A/p as its
return path.  Portals that already have a destination are never overwritten,
and script/town-portal/touch slots are left alone.
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Interactive portal types that a player triggers with ↑ (or by walking into
# them).  pt=0 spawn anchors, pt=6 town-portal points, pt=9 script triggers
# and pt=3 touch portals are excluded: pt=3 auto-fires on contact, so giving
# it a return path would bounce the player back and forth forever.
RETURN_PORTAL_TYPES = frozenset({1, 2, 7, 8, 10, 11})


def portal_index(maps):
    return {str(entry['id']): entry for entry in maps}


def interactive(portal):
    return not portal.get('script') and portal.get('type') in RETURN_PORTAL_TYPES


def apply_portal_returns(maps):
    """Return the list of (mapId, portalName, returnMapId, returnPortalName)."""
    by_id = portal_index(maps)
    changes = []
    for entry in maps:
        for portal in entry.get('portals') or []:
            if not interactive(portal):
                continue
            target_map_id = portal.get('targetMapId')
            target_portal_name = portal.get('targetPortalName')
            if not target_map_id or not target_portal_name:
                continue
            target_map = by_id.get(str(target_map_id))
            if not target_map:
                continue
            back = next(
                (candidate for candidate in target_map.get('portals') or []
                 if candidate.get('name') == target_portal_name and interactive(candidate)),
                None,
            )
            if back is None or back.get('targetMapId'):
                continue
            back['targetMapId'] = str(entry['id'])
            back['targetPortalName'] = portal.get('name')
            changes.append((str(target_map['id']), back['name'], str(entry['id']), portal['name']))
    return changes


def dangling_links(maps):
    """Portals whose target map or target portal does not exist (arrival falls back to spawn)."""
    by_id = portal_index(maps)
    broken = []
    for entry in maps:
        for portal in entry.get('portals') or []:
            target_map_id = portal.get('targetMapId')
            if not target_map_id:
                continue
            target_map = by_id.get(str(target_map_id))
            if target_map is None:
                broken.append((str(entry['id']), portal['name'], str(target_map_id), portal.get('targetPortalName'), 'missing map'))
                continue
            target_portal_name = portal.get('targetPortalName')
            if target_portal_name and not any(candidate.get('name') == target_portal_name for candidate in target_map.get('portals') or []):
                broken.append((str(entry['id']), portal['name'], str(target_map_id), target_portal_name, 'missing target portal'))
    return broken


def report(maps, changes):
    by_id = portal_index(maps)
    lines = []
    for map_id, portal_name, return_map_id, return_portal_name in changes:
        lines.append(f"  {map_id}/{portal_name} -> {return_map_id}/{return_portal_name}"
                     f"  ({by_id[map_id].get('name', map_id)} -> {by_id[return_map_id].get('name', return_map_id)})")
    return lines


# Portal slots that v83 WZ points at but never declares on the target map.
# Each row materialises the missing arrival/return gate on a reachable layer of
# the target map, picked to stay clear of existing gates and the spawn.  The
# returned gate warps back to the very source portal that led there, so the
# pair is a closed round trip.
LINK_FILLS = [
    # 蘑菇村街道 (000020001) 回 蜗牛花园 (000020000)
    {'map': '000020000', 'name': 'in01', 'x': 140, 'y': 215, 'targetMapId': '000020001', 'targetPortalName': 'out00'},
    # 蜗牛狩猎场 II (000040001) 西口回 小森林 (000040000)
    {'map': '000040000', 'name': 'east00', 'x': 700, 'y': 155, 'targetMapId': '000040001', 'targetPortalName': 'west00'},
    # 蜗牛狩猎场 III (000040002) 东口回 危险森林 (000050000)
    {'map': '000050000', 'name': 'west00', 'x': 400, 'y': -25, 'targetMapId': '000040002', 'targetPortalName': 'east00'},
    # 南港西部平原 (000050001) 西口回 危险森林 (000050000)
    {'map': '000050000', 'name': 'east01', 'x': 1000, 'y': -85, 'targetMapId': '000050001', 'targetPortalName': 'west00'},
    # 彩虹村街道 (001000002) 回 彩虹村 (001000000)
    {'map': '001000000', 'name': 'in01', 'x': 420, 'y': -56, 'targetMapId': '001000002', 'targetPortalName': 'out00'},
    # 蜗牛花园 (001000004) 回 彩虹村 (001000000); source renamed to in03 below
    {'map': '001000000', 'name': 'in03', 'x': 1600, 'y': 154, 'targetMapId': '001000004', 'targetPortalName': 'out00'},
    # 森林中部狩猎场 I (001000005) 回 命运分岔路 (001020000)
    {'map': '001020000', 'name': 'in01', 'x': 520, 'y': 215, 'targetMapId': '001000005', 'targetPortalName': 'out00'},
    # 森林中部狩猎场 II (001000006) 回 命运分岔路 (001020000)
    {'map': '001020000', 'name': 'in02', 'x': -240, 'y': 215, 'targetMapId': '001000006', 'targetPortalName': 'out00'},
]

# 001000004/out00 used to point at the same 001000000/in01 slot as
# 001000002/out00; one gate cannot answer two sources, so it is re-pointed at
# the dedicated in03 gate above.
SOURCE_RENAMES = [
    ('001000004', 'out00', '001000000', 'in01', 'in03'),
]


def apply_link_fill(maps):
    """Materialise LINK_FILLS + SOURCE_RENAMES.  Idempotent; reports what changed."""
    by_id = portal_index(maps)
    actions = []
    for source_map, source_portal, target_map, old_name, new_name in SOURCE_RENAMES:
        for portal in by_id[source_map].get('portals') or []:
            if (portal.get('name') == source_portal
                    and portal.get('targetMapId') == target_map
                    and portal.get('targetPortalName') == old_name):
                portal['targetPortalName'] = new_name
                actions.append(('rename', source_map, source_portal, f'{target_map}/{old_name} -> {target_map}/{new_name}'))
    for fill in LINK_FILLS:
        dst = by_id[fill['map']]
        existing = next((p for p in dst.get('portals') or [] if p.get('name') == fill['name']), None)
        if existing is not None:
            want = (fill['targetMapId'], fill['targetPortalName'])
            have = (existing.get('targetMapId'), existing.get('targetPortalName'))
            if have != want:
                raise ValueError(f"portal {fill['map']}/{fill['name']} already exists targeting {have}, want {want}")
            continue
        gate = {
            'name': fill['name'],
            'type': 2,
            'x': fill['x'],
            'y': fill['y'],
            'targetMapId': fill['targetMapId'],
            'targetPortalName': fill['targetPortalName'],
        }
        dst.setdefault('portals', []).append(gate)
        actions.append(('fill', fill['map'], fill['name'],
                        f"@{fill['x']},{fill['y']} -> {fill['targetMapId']}/{fill['targetPortalName']}"))
    return actions


if __name__ == '__main__':
    maps_path = ROOT / 'shared/maps.json'
    manifest_path = ROOT / 'client/public-gameplay/assets/manifest.json'

    maps = json.loads(maps_path.read_text(encoding='utf-8'))
    fills = apply_link_fill(maps['maps'])
    for kind, map_id, portal_name, detail in fills:
        print(f'link {kind} {map_id}/{portal_name} {detail}')
    changes = apply_portal_returns(maps['maps'])
    print(f'shared/maps.json: {len(fills)} link fill(s), {len(changes)} return path(s) added')
    for line in report(maps['maps'], changes):
        print(line)

    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        catalog = manifest.get('mapCatalog') or {}
        catalog_maps = catalog.get('maps') or []
        catalog_fills = apply_link_fill(catalog_maps)
        catalog_changes = apply_portal_returns(catalog_maps)
        birth_id = str((manifest.get('map') or {}).get('id', ''))
        for entry in catalog_maps:
            if str(entry.get('id')) == birth_id:
                manifest['map']['portals'] = entry['portals']
                break
        print(f'client manifest mapCatalog: {len(catalog_fills)} link fill(s), {len(catalog_changes)} return path(s) added')
        for line in report(catalog_maps, catalog_changes):
            print(line)

    broken = dangling_links(maps['maps'])
    print(f'dangling portal links: {len(broken)}')
    for map_id, portal_name, target_map_id, target_portal_name, reason in broken:
        print(f'  {map_id}/{portal_name} -> {target_map_id}/{target_portal_name} ({reason})')

    if '--write' in __import__('sys').argv:
        maps_path.write_text(json.dumps(maps, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        if manifest_path.is_file():
            manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print('written: shared/maps.json, client/public-gameplay/assets/manifest.json')
    else:
        print('dry run; pass --write to persist')
