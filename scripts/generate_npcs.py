"""Generate v83 NPC templates, authored spawns, dialogue state machines and shops.

⚠️  BOOTSTRAP-ONLY.  Re-running REPLACES shared/gameplay.json npcs/npcSpawns/shops
from the raw references: it drops the hand-authored Roger (2000) quest script,
any post-generation dialogue edits and the localized zh text.  Never run it
against the live gameplay file; after a rebuild you must re-apply
`scripts/npc_i18n/apply_dialogue_zh.py` and re-add hand-authored quest nodes.

Sources (all local, all GMS83 / v83-era reference):
  * Map.wz/Map/Map0/*.img.xml            -> life entries with type 'n' (mapId/x/y/fh/f/hide)
  * String.wz/Npc.img.xml                -> display names
  * Npc.wz                               -> stand frames (exported into the asset manifest)
  * P0nk/Cosmic scripts/npc/*.js         -> dialogue flow (HeavenMS/OdinMS derived)
  * P0nk/Cosmic db/data/10{1,2}-shops-*.sql -> shop inventory (private-server table)
"""
import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WZ = ROOT / '参考/repos/P0nk__Cosmic/wz'
SCRIPTS = WZ.parent / 'scripts/npc'
DB = WZ.parent / 'src/main/resources/db/data'

# Visible npc templates present in the rendered map set. 0002007 (Maple Administrator)
# is authored with hide=1 in 000010000 and therefore excluded, same rule as mobs.
SCRIPT_IDS = ['2003', '2100', '2101', '22000', '9000000', '11000',
              '10200', '10201', '10202', '10203', '10204', '12101']


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def text_of(source):
    return source


def authored_spawns(maps):
    spawns = []
    for map_entry in maps:
        relative = f"Map.wz/Map/Map0/{map_entry['id']}.img.xml"
        life = ET.parse(WZ / relative).getroot().find("imgdir[@name='life']")
        for entry in life if life is not None else []:
            values = {child.get('name'): child.get('value') for child in entry}
            if values.get('type') != 'n' or int(values.get('hide', 0)):
                continue
            x, y, foothold_id = (int(values[key]) for key in ('x', 'y', 'fh'))
            foothold = next((f for f in map_entry['footholds'] if f['id'] == foothold_id), None)
            assert foothold and min(foothold['x1'], foothold['x2']) <= x <= max(foothold['x1'], foothold['x2']), (relative, values)
            # Snap y to the foothold's platform top when the WZ life y sits within
            # 24 pixels of a flat platform; otherwise the npc visibly floats above
            # the platform in the rendered scene. Foot anchors rest at the platform's
            # top edge (= y1 = y2 for a horizontal foothold).
            if foothold['y1'] == foothold['y2'] and abs(y - foothold['y1']) <= 24:
                snapped_y = foothold['y1']
            else:
                snapped_y = y
            spawns.append({
                'id': f"{map_entry['id']}-life-{entry.get('name')}",
                'mapId': map_entry['id'], 'templateId': str(int(values['id'])),
                'x': x, 'y': snapped_y, 'footholdId': foothold_id,
                'sourceY': y,
                'facing': -1 if int(values.get('f', 0)) else 1,
                'source': f"{relative}/life/{entry.get('name')}",
            })
    assert len({spawn['id'] for spawn in spawns}) == len(spawns)
    return spawns


def display_names():
    root = ET.parse(WZ / 'String.wz/Npc.img.xml').getroot()
    return {entry.get('name'): {child.get('name'): child.get('value') for child in entry}
            for entry in root}


# --- dialogue helpers -------------------------------------------------------
# Node shapes consumed by server/src/npc.rs:
#   {"say": {"text", "kind": next|nextPrev|prev|ok, "next"?, "prev"?}}
#   {"ask": {"text", "kind": "yesNo", "yes", "no"}}
#   {"menu": {"text", "options": [{"index", "text", "next"}]}}
#   {"act": {"kind": "end"|"warp"|"shop", "mapId"?, "shopId"?}}
#   {"branch": {"cond", "then", "else"}}
def say(text, kind, next=None, prev=None):
    node = {'text': text, 'kind': kind}
    if next is not None:
        node['next'] = next
    if prev is not None:
        node['prev'] = prev
    return {'say': node}


def ask(text, yes, no):
    return {'ask': {'text': text, 'kind': 'yesNo', 'yes': yes, 'no': no}}


def menu(text, options):
    return {'menu': {'text': text, 'options': [
        {'index': index, 'text': label, 'next': target} for index, (label, target) in enumerate(options)]}}


def act(kind, **extra):
    return {'act': {'kind': kind, **extra}}


def branch(cond, then, other):
    return {'branch': {'cond': cond, 'then': then, 'else': other}}


def script(start, nodes):
    return {'start': start, 'nodes': nodes}


def job_instructor(template_id, description, job, trial_map):
    """Cosmic scripts/npc/{10200..10204}.js: identical flow, different copy/target."""
    return script('describe', {
        'describe': say(description, 'next', next='offer'),
        'offer': ask(f"Would you like to experience what it's like to be a {job}?", 'trial', 'declined'),
        # The warp target is outside the rendered map set; see `incomplete`.
        'trial': act('end', note=f'warp {trial_map} not rendered'),
        'declined': say(f"If you wish to experience what it's like to be a {job}, come see me again.", 'ok'),
    })


def robin():
    """Cosmic scripts/npc/2003.js: 17-entry sendSimple with per-entry follow-ups."""
    source = (SCRIPTS / '2003.js').read_text(encoding='utf-8')
    intro = re.search(r'cm\.sendSimple\("(.*?)"\);', source, re.S).group(1)
    first = {int(index): body for index, body in
             re.findall(r'sel == (\d+)\) \{\s*cm\.sendNext\("(.*?)"\);', source, re.S)}
    second = {int(index): body for index, body in
              re.findall(r'sel == (\d+)\) \{\s*cm\.sendNextPrev\("(.*?)"\);', source, re.S)}
    labels = [(index, re.sub(r'#[a-zA-Z]', '', label)) for index, label in
              ((int(i), l) for i, l in re.findall(r'#L(\d+)#(.*?)#l', intro, re.S))]
    assert labels and {index for index, _ in labels} == set(first), (len(labels), sorted(first))
    nodes = {'menu': menu(intro, [(label, f'answer{index}') for index, label in labels])}
    for index, _ in labels:
        nodes[f'answer{index}'] = say(first[index], 'next', next=f'detail{index}')
        if index in second:
            nodes[f'detail{index}'] = say(second[index], 'nextPrev', next='menu', prev=f'answer{index}')
        else:
            nodes[f'detail{index}'] = act('end')
    return script('menu', nodes)


def paul():
    """Cosmic scripts/npc/9000000.js: event assistant, nested sendSimple menus."""
    source = (SCRIPTS / '9000000.js').read_text(encoding='utf-8')
    texts = re.findall(r'cm\.send(?:Next|Simple)\("(.*?)"\);', source, re.S)
    intro, event_text, game_text = texts[0], texts[1], texts[3]
    declined, answers = texts[4], texts[5:11]

    def labels(body):
        return [re.sub(r'#[a-zA-Z]', '', label) for _, label in
                ((int(index), label) for index, label in re.findall(r'#L(\d+)#(.*?)#l', body, re.S))]

    event_labels, game_labels = labels(event_text), labels(game_text)
    assert len(event_labels) == 3 and len(game_labels) == 6 and len(answers) == 6, (len(event_labels), len(game_labels))
    nodes = {
        'intro': say(intro, 'next', next='eventMenu'),
        'eventMenu': menu(event_text, [(label, f'event{index}') for index, label in enumerate(event_labels)]),
        'event0': say(answers[0], 'ok'),
        'event1': menu(game_text, [(label, f'game{index}') for index, label in enumerate(game_labels)]),
        'event2': say(declined, 'ok'),
    }
    for index, _ in enumerate(game_labels):
        nodes[f'game{index}'] = say(answers[index], 'ok')
    return script('intro', nodes)


def shanks():
    """Cosmic scripts/npc/22000.js: meso / level / recommendation-letter gate.

    The terminal warp to 104000000 (Lith Harbor) is outside the rendered map set, so no
    meso or letter is consumed and the trip does not happen; see `incomplete`.
    """
    return script('offer', {
        'offer': ask(
            "Take this ship and you'll head off to a bigger continent. For #e150 mesos#n, I'll take you to "
            "#bVictoria Island#k. The thing is, once you leave this place, you can't ever come back. What do "
            "you think? Do you want to go to Victoria Island?", 'letter', 'declined'),
        'declined': say('Hmm... I guess you still have things to do here?', 'ok'),
        'letter': branch({'haveItem': '4031801'}, 'hasLetter', 'noLetter'),
        'hasLetter': say(
            "Okay, now give me 150 mesos... Hey, what's that? Is that the recommendation letter from Lucas, the "
            "chief of Amherst? Hey, you should have told me you had this. I, Shanks, recognize greatness when I "
            "see one, and since you have been recommended by Lucas, I see that you have a great, great potential "
            "as an adventurer. No way would I charge you for this trip!", 'next', next='freeTrip'),
        'noLetter': say('Bored of this place? Here... Give me #e150 mesos#n first...', 'next', next='checkLevel'),
        'freeTrip': say(
            "Since you have the recommendation letter, I won't charge you for this. Alright, buckle up, because "
            "we're going to head to Victoria Island right now, and it might get a bit turbulent!!", 'ok'),
        'checkLevel': branch({'levelAtLeast': 7}, 'checkMeso', 'tooWeak'),
        'tooWeak': say("Let's see... I don't think you are strong enough. You'll have to be at least Level 7 to "
                       "go to Victoria Island.", 'ok'),
        'checkMeso': branch({'mesoAtLeast': 150}, 'paid', 'noMeso'),
        'noMeso': say("What? You're telling me you wanted to go without any money? You're one weirdo...", 'ok'),
        'paid': say('Awesome! #e150#n mesos accepted! Alright, off to Victoria Island!', 'ok'),
    })


def npc_scripts():
    jobs = {'10200': 'Bowman', '10201': 'Magician', '10202': 'Warrior', '10203': 'Thief', '10204': 'Pirate'}
    trials = {'10200': '1020300', '10201': '1020200', '10202': '1020100', '10203': '1020400', '10204': '1020500'}
    result = {}
    for template_id, job in jobs.items():
        source = (SCRIPTS / f'{template_id}.js').read_text(encoding='utf-8')
        description = re.search(r'cm\.sendNext\("(.*?)"\);', source, re.S).group(1)
        result[template_id] = job_instructor(template_id, description, job, trials[template_id])
    result['2003'] = robin()
    result['9000000'] = paul()
    result['22000'] = shanks()
    result['2100'] = script('imageRoom', {
        # Map 000010000 is neither 0 nor 3, so only the image-room branch of
        # scripts/npc/2100.js is reachable here.
        'imageRoom': say(
            'This is the image room where your first training program begins. In this room, you will have an '
            'advance look into the job of your choice.', 'next', next='aboutJobs'),
        'aboutJobs': say(
            'Once you train hard enough, you will be entitled to occupy a job. You can become a Bowman in '
            'Henesys, a Magician in Ellinia, a Warrior in Perion, and a Thief in Kerning City...',
            'prev', prev='imageRoom'),
    })
    result['2101'] = script('ask', {
        'ask': ask('Are you done with your training? If you wish, I will send you out from this training camp.',
                   'sendOut', 'notYet'),
        'notYet': say("Haven't you finished the training program yet? If you want to leave this place, please do "
                      "not hesitate to tell me.", 'ok'),
        'sendOut': say('Then, I will send you out from here. Good job.', 'next', next='leave'),
        'leave': act('warp', mapId='000040000', portal=0),
    })
    result['11000'] = script('shop', {'shop': act('shop', shopId='11000')})
    result['11100'] = script('shop', {'shop': act('shop', shopId='11100')})
    result['21000'] = script('shop', {'shop': act('shop', shopId='21000')})
    result['12101'] = script('amherst', {
        'amherst': say(
            'This is the town called #bAmherst#k, located at the northeast part of the Maple Island. You know '
            'that Maple Island is for beginners, right? I\'m glad there are only weak monsters around this place.',
            'next', next='southperry'),
        'southperry': say(
            'If you want to get stronger, then go to #bSouthperry#k where there\'s a harbor. Ride on the gigantic '
            'ship and head to the place called #bVictoria Island#k. It\'s incomparable in size compared to this '
            'tiny island.', 'nextPrev', next='perion', prev='amherst'),
        'perion': say(
            'At the Victoria Island, you can choose your job. Is it called #bPerion#k...? I heard there\'s a bare, '
            'desolate town where warriors live. A highland...what kind of a place would that be?',
            'prev', prev='southperry'),
    })
    return result


def shops(npc_ids, items):
    """Shop catalogues from the reference SQL, restricted to npcs placed on a rendered map."""
    shops_sql = (DB / '101-shops-data.sql').read_text(encoding='utf-8')
    items_sql = (DB / '102-shopitems-data.sql').read_text(encoding='utf-8')
    owners = {npc_id for npc_id, _ in re.findall(r'\((\d+),\s*(\d+)\)', shops_sql)} & set(npc_ids)
    rows = [row for row in re.findall(r'\((\d+),\s*(\d+),\s*(-?\d+),\s*(-?\d+),\s*(\d+)\)', items_sql)
            if row[0] in owners]
    result, missing = [], []
    for shop_id in sorted({row[0] for row in rows}):
        if shop_id not in npc_ids:
            continue  # shop owner not placed on a rendered map
        entries = [row for row in rows if row[0] == shop_id]
        entries.sort(key=lambda row: int(row[4]))
        catalogue, skipped = [], []
        for _, item_id, price, _, position in entries:
            if item_id in items:
                catalogue.append({'itemId': item_id, 'price': int(price), 'position': int(position)})
            else:
                skipped.append(item_id)
        if not catalogue:
            continue
        missing.extend(skipped)
        result.append({'shopId': shop_id, 'npcId': shop_id, 'items': catalogue,
                       'source': 'P0nk/Cosmic/src/main/resources/db/data/102-shopitems-data.sql',
                       **({'omittedItemIds': skipped} if skipped else {})})
    return result, missing


def generate(base, manifest, maps, items):
    spawns = authored_spawns(maps)
    names = display_names()
    scripts = npc_scripts()
    sprite_manifest = manifest.get('npcs', {})
    placed = {spawn['templateId'] for spawn in spawns}
    shop_list, missing = shops(placed, items)
    templates = []
    for template_id in sorted(placed, key=int):
        entry = names.get(template_id)
        assert entry and entry.get('name'), template_id
        sprite = sprite_manifest.get(template_id)
        templates.append({
            'templateId': template_id, 'name': entry['name'], 'func': entry.get('func', ''),
            'shopId': next((shop['shopId'] for shop in shop_list if shop['npcId'] == template_id), None),
            'stand': (sprite or {}).get('stand', []),
            'script': scripts.get(template_id),
            'source': f"String.wz/Npc.img.xml/{template_id}"
                      + (f" + Cosmic scripts/npc/{template_id}.js" if template_id in scripts else ''),
            **({'spriteSource': sprite['source']} if sprite else {}),
        })
    result = {**base, 'npcs': templates, 'npcSpawns': spawns, 'shops': shop_list}
    sources = {**base.get('sources', {}),
               'npcs': 'String.wz/Npc.img.xml names + Cosmic local v83 Map.wz/Map/Map0/*.img.xml life(type=n); '
                       'mapId/x/y/fh/f/hide retained, hide=1 excluded',
               'npcDialogue': 'P0nk/Cosmic scripts/npc/*.js (HeavenMS/OdinMS derived); ported verbatim text with '
                              'status-machine normalisation, not an official GMS83 script dump',
               'shops': 'P0nk/Cosmic db/data/101-shops-data.sql + 102-shopitems-data.sql; private-server table, '
                        'official v83 shop prices are not independently verified'}
    result['sources'] = sources
    incomplete = [note for note in base.get('incomplete', [])]
    notes = [
        f"{sum(1 for template in templates if template['script'] is None)} of the {len(templates)} placed npc "
        "templates have no reference dialogue script in P0nk/Cosmic scripts/npc; they render and can be targeted "
        "but answer nothing.",
        'Job-instructor npcs (10200-10204) end on a warp to their trial maps '
        '(1020300/1020200/1020100/1020400/1020500); those maps are outside the rendered 23-map set, so the warp '
        'is not performed.',
        'Shanks (22000) keeps the meso/level/recommendation-letter checks for dialogue only: the terminal warp to '
        '104000000 is outside the rendered map set, so no meso or letter is consumed.',
        'Selling to npc shops is not implemented; no authoritative v83 sell-price formula was available in the '
        'local reference, so only buying is enabled.',
        'Npc 0002004 (Todd) and 0002005 (Sam) have no `stand` node in Npc.wz (info only), so they have no sprite '
        'frames in this build.',
        'Sid (11000) has a reference script (shop 11000), but Lucy (11100) and Pan (21000) have no script in '
        'P0nk/Cosmic scripts/npc: their shop association comes only from 101-shops-data.sql (shopid = npcid).',
    ]
    if missing:
        notes.append(f"{len(set(missing))} shop item ids are absent from shared/items.json and were omitted from "
                     f"the catalogue: {', '.join(sorted(set(missing)))}")
    for note in notes:
        if note not in incomplete:
            incomplete.append(note)
    result['incomplete'] = incomplete
    return result


if __name__ == '__main__':
    gameplay = generate(read(ROOT / 'shared/gameplay.json'),
                        read(ROOT / 'references/gameplay-assets/manifest.json'),
                        read(ROOT / 'shared/maps.json')['maps'], read(ROOT / 'shared/items.json'))
    assert len(gameplay['npcSpawns']) == 34, len(gameplay['npcSpawns'])
    assert len(gameplay['npcs']) == 28, len(gameplay['npcs'])
    assert not any(spawn['templateId'] == '2007' for spawn in gameplay['npcSpawns'])
    assert sum(1 for npc in gameplay['npcs'] if npc['script']) == 14
    assert [shop['shopId'] for shop in gameplay['shops']] == ['11000', '11100', '21000']
    text = json.dumps(gameplay, ensure_ascii=False, indent=2) + '\n'
    (ROOT / 'shared/gameplay.json').write_text(text, encoding='utf-8')
    print(f"Generated {len(gameplay['npcs'])} npc templates, {len(gameplay['npcSpawns'])} authored spawns and "
          f"{len(gameplay['shops'])} shops; {sum(1 for n in gameplay['npcs'] if n['stand'])} have sprite frames.")
