"""Merge the npc-dialogue zh draft into shared/gameplay.json.

English stays authored-in (Cosmic/v83 reference text, kept byte-for-byte except
that `menu` lead texts have their original `#L..#l` choice lines stripped so the
rendered prompt no longer echoes the option list).  Every player-facing text
node then carries `{"zh": ..., "en": ...}` and the server picks per-player lang
with zh as default (see server/src/npc.rs `LocalizedText`).

Idempotent: re-running re-reads the current `en` from gameplay.json, so manual
en edits survive.  `--dry-run` only reports what would change.

Usage:
  python3 scripts/npc_i18n/apply_dialogue_zh.py [--dry-run] [gameplay.json ...]
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ZH_FILE = ROOT / 'shared/npc-dialogue-zh.json'
DEFAULT = ROOT / 'shared/gameplay.json'

COLOUR_MARK = re.compile(r'#[a-zA-Z]')


def clean_menu_lead(text: str) -> str:
    """Keep only the prompt before the first `#L<idx>#` choice line."""
    cut = re.search(r'#L\d+#', text)
    if cut:
        text = text[:cut.start()]
    text = COLOUR_MARK.sub('', text)
    text = text.replace('\\r\\n', ' ')
    text = re.sub(r'\s+', ' ', text)
    return text.strip()


def localize_plain(body, kind: str, zh: str) -> int:
    """say/ask: body.text -> {en, zh}."""
    en = body['text']
    if isinstance(en, str):
        body['text'] = {'en': en, 'zh': zh}
        return 1
    changed = 0
    if en.get('zh') != zh:
        en['zh'] = zh
        changed += 1
    if not en.get('en'):
        raise ValueError('existing localized text lost its en value')
    return changed


def localize_menu(body, zh_lead: str, zh_options) -> int:
    """menu: body.text -> {en, zh} (en without the #L..#l echo) and localize options."""
    changed = 0
    en = body['text']
    if isinstance(en, str):
        if '#L' in en:
            en = clean_menu_lead(en)
            changed += 1
        body['text'] = {'en': en, 'zh': zh_lead}
        changed += 1
    else:
        if '#' in en.get('en', '') and '#L' in en['en']:
            en['en'] = clean_menu_lead(en['en'])
            changed += 1
        if en.get('zh') != zh_lead:
            en['zh'] = zh_lead
            changed += 1
    options = body.get('options', [])
    if len(options) != len(zh_options):
        raise ValueError(f'menu option count mismatch: expected {len(zh_options)}, got {len(options)}')
    for option, label_zh in zip(options, zh_options):
        if isinstance(option['text'], str):
            option['text'] = {'en': option['text'], 'zh': label_zh}
            changed += 1
        elif option['text'].get('zh') != label_zh:
            option['text']['zh'] = label_zh
            changed += 1
    return changed


def apply(gameplay_path: Path, zh_data: dict, dry_run: bool) -> int:
    game = json.loads(gameplay_path.read_text(encoding='utf-8'))
    by_id = {str(t['templateId']): t for t in game.get('npcs', [])}
    total = 0
    for tid, npc_zh in zh_data.get('npcs', {}).items():
        template = by_id.get(str(tid))
        if template is None:
            raise ValueError(f'gameplay has no npc template {tid}')
        script = template.get('script')
        if not script:
            raise ValueError(f'npc {tid} has no dialogue script')
        nodes = script['nodes']
        for node_id, zh_node in npc_zh.items():
            node = nodes.get(node_id)
            if node is None:
                raise ValueError(f'npc {tid} has no dialogue node {node_id}')
            kind = list(node)[0]
            if kind == 'say':
                zh_text = zh_node.get('say')
                if zh_text is None:
                    raise ValueError(f'npc {tid} node {node_id}: zh draft missing "say"')
                total += localize_plain(node['say'], 'say', zh_text)
            elif kind == 'ask':
                zh_text = zh_node.get('ask')
                if zh_text is None:
                    raise ValueError(f'npc {tid} node {node_id}: zh draft missing "ask"')
                total += localize_plain(node['ask'], 'ask', zh_text)
            elif kind == 'menu':
                zh_lead = zh_node.get('menu')
                zh_options = zh_node.get('options')
                if zh_lead is None or zh_options is None:
                    raise ValueError(f'npc {tid} node {node_id}: zh draft missing menu/options')
                total += localize_menu(node['menu'], zh_lead, zh_options)
            else:
                raise ValueError(f'npc {tid} node {node_id} is a {kind}, cannot localize')
    if dry_run:
        print(f'{gameplay_path.name}: {total} text fields would change')
        return total
    gameplay_path.write_text(
        json.dumps(game, ensure_ascii=False, separators=(',', ':')), encoding='utf-8'
    )
    print(f'{gameplay_path.name}: {total} text fields localized')
    return total


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    dry_run = '--dry-run' in sys.argv
    zh_data = json.loads(ZH_FILE.read_text(encoding='utf-8'))
    targets = [Path(a) for a in args] or [DEFAULT]
    for path in targets:
        apply(path, zh_data, dry_run)


if __name__ == '__main__':
    main()
