"""Quality gate for the localized npc dialogue in shared/gameplay.json.

Rules (every failure aborts with a message):
  * every say/ask/menu lead and every menu option text is `{"en":..,"zh":..}`
    (both non-empty) - no legacy plain-string remains on scripted npcs
  * `en` menu lead no longer echoes `#L..#l` choice lines
  * `zh` carries no GMS colour/style markers (`#r`, `#b`, `#e`, ...) - the
    zh corpus is plain text by convention
  * menu option counts still line up with the zh draft file

Usage: python3 scripts/npc_i18n/verify_dialogue_lang.py [gameplay.json]
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT = ROOT / 'shared/gameplay.json'
ZH_DRAFT = ROOT / 'shared/npc-dialogue-zh.json'

MARK = re.compile(r'#[a-zA-Z]')
# Colour/style marks (would corrupt plain zh text) plus choice-list syntax.
FORBIDDEN_ZH = re.compile(r'#[a-zA-Z]|#L\d+#|#l')


def check_localized_text(node_id: str, path: str, value) -> list[str]:
    errors = []
    if not isinstance(value, dict):
        errors.append(f'{path} text is not localized: {value!r}')
        return errors
    en = value.get('en')
    zh = value.get('zh')
    if not en or not str(en).strip():
        errors.append(f'{path} (node {node_id}) has empty en')
    if not zh or not str(zh).strip():
        errors.append(f'{path} (node {node_id}) has empty zh')
    if zh and FORBIDDEN_ZH.search(str(zh)):
        errors.append(f'{path} (node {node_id}) zh carries WZ markers: {zh!r}')
    if 'L#' in str(en) or (en and re.search(r'#L\d+#', str(en))):
        errors.append(f'{path} (node {node_id}) en menu lead still echoes choices')
    return errors


def verify(path: Path) -> int:
    game = json.loads(path.read_text(encoding='utf-8'))
    errors = []
    counts = {'texts': 0}
    for template in game.get('npcs', []):
        script = template.get('script')
        if not script:
            continue
        for node_id, node in script['nodes'].items():
            kind = list(node)[0]
            if kind == 'say':
                counts['texts'] += 1
                errors += check_localized_text(node_id, f'npc {template["templateId"]} {node_id}.say', node['say']['text'])
            elif kind == 'ask':
                counts['texts'] += 1
                errors += check_localized_text(node_id, f'npc {template["templateId"]} {node_id}.ask', node['ask']['text'])
            elif kind == 'menu':
                counts['texts'] += 1 + len(node['menu'].get('options', []))
                errors += check_localized_text(node_id, f'npc {template["templateId"]} {node_id}.menu', node['menu']['text'])
                for i, option in enumerate(node['menu'].get('options', [])):
                    errors += check_localized_text(
                        node_id, f'npc {template["templateId"]} {node_id}.menu.options[{i}]', option['text']
                    )
    # Option-count parity with the zh draft (apply would have errored, but keep
    # the invariant explicit in the gate).
    zh = json.loads(ZH_DRAFT.read_text(encoding='utf-8'))
    for tid, npc_zh in zh.get('npcs', {}).items():
        template = next((t for t in game.get('npcs', []) if str(t['templateId']) == str(tid)), None)
        if not template:
            continue
        for node_id, zh_node in npc_zh.items():
            if 'options' not in zh_node:
                continue
            node = template['script']['nodes'].get(node_id)
            if node and list(node)[0] == 'menu':
                actual = len(node['menu'].get('options', []))
                if actual != len(zh_node['options']):
                    errors.append(f'npc {tid} node {node_id}: option count {actual} != zh draft {len(zh_node["options"])}')
    if errors:
        print(f'FAIL {path.name}: {len(errors)} error(s)')
        for error in errors:
            print(' -', error)
        return 1
    print(f'PASS {path.name}: npc dialogue localized ({counts["texts"]} texts, en+zh, plain-zh)')
    return 0


if __name__ == '__main__':
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
    raise SystemExit(verify(target))
