#!/usr/bin/env python3
"""Compute the portal closure of the registered TMS273 map set."""
import json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WZ = os.path.join(ROOT, '参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW/Map/Map')

INT_T = {'byte','short','int','long','ubyte','ushort','uint','ulong','float','double'}
def dec(v):
    if isinstance(v, dict):
        t = v.get('_dirType')
        if t in INT_T: return int(str(v.get('_value')))
        if t in ('string','wstring','stringPool'): return str(v.get('_value',''))
        if t == 'bool': return str(v.get('_value')).lower() in ('1','true')
    return v

def portals_of(map_id):
    p = os.path.join(WZ, f"Map{map_id[0]}", f"{map_id}.json")
    if not os.path.exists(p):
        return None
    raw = json.load(open(p, encoding='utf-8'))
    out = []
    for k, ch in (raw.get('portal') or {}).items():
        if not isinstance(ch, dict):
            continue
        d = {k2: dec(v2) for k2, v2 in ch.items() if not k2.startswith('_')}
        tm = d.get('tm')
        tmap = None if tm in (None, '', 999999999, '999999999') else str(tm).zfill(9)
        out.append({'name': str(d.get('pn','')), 'type': d.get('pt',0), 'targetMapId': tmap})
    return out

def main():
    d = json.load(open(os.path.join(ROOT,'references/tms273-data/maps.json'), encoding='utf-8'))
    reg = {m['id']: m for m in d['maps']}
    allmaps = dict(reg)
    missing_src = []
    frontier = set(reg)
    while frontier:
        nxt = set()
        for mid in sorted(frontier):
            for t in {p['targetMapId'] for p in allmaps[mid]['portals'] if p.get('targetMapId')}:
                if t in allmaps: continue
                ports = portals_of(t)
                if ports is None:
                    missing_src.append(t)
                    continue
                allmaps[t] = {'id': t, 'portals': ports}
                nxt.add(t)
        frontier = nxt
    new = sorted(set(allmaps) - set(reg))
    print('closure total:', len(allmaps), 'new needed:', len(new))
    print('\n'.join(new))
    if missing_src:
        print('SOURCE MISSING:', sorted(set(missing_src)))
    # where does each new map get referenced from
    refs = {}
    for m in allmaps.values():
        for p in m['portals']:
            t = p.get('targetMapId')
            if t and t in new:
                refs.setdefault(t, []).append(f"{m['id']}/{p['name']}")
    out = os.path.join(ROOT, 'artifacts/portal-closure.json')
    json.dump({'new': new, 'refs': refs}, open(out,'w',encoding='utf-8'), ensure_ascii=False, indent=1)
    print('wrote', out)

if __name__ == '__main__':
    main()
