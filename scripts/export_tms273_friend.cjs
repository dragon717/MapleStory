#!/usr/bin/env node

// Export the source-backed friend window (`UI/UIWindow.img/UserList`, `Friend`
// and `BlackList` tabs).
//
// The original UserList window is one shell (`backgrnd`, 312x389) shared by the
// Friend / Party / Guild / Expedition tabs — the party export already ships that
// shell, and this window reuses the very same sprite so the two windows cannot
// drift apart.  On top of the shell this script exports:
//
//   Tab/enabled/N   the authored tab plates, in source order.  Index 0 is the
//                   first tab plate of the strip; the friend window uses two
//                   (好友 / 黑名單).  Exported as `Tab/enabled/0` .. `/N`.
//   Tab/disabled/N  the same plates in their "not selected" look.
//   Friend/BtAddFriend / BtDelete / BtBlock / BtUnBlock / BtWhisper / BtWhere /
//   BtParty / BtShowAll / BtShowOnline / BtAdd / BtMod / BtAddGroup /
//   BtGroupWhisper / BtChat / BtSave / BtMate / BtMessage
//                   the authored Friend-tab buttons, up to 4 states each.
//   BlackList/BtAdd / BlackList/BtDelete
//                   the authored BlackList-tab buttons.  Their node names
//                   collide with the Friend tab's, so they are exported under
//                   the `BlackList/` prefix to keep the manifest flat but
//                   unambiguous.
//
// Only the buttons that carry a server intent in this round are referenced by
// the view (`BtAddFriend`, `BtDelete`, `BtBlock`, `BtUnBlock`, and the
// BlackList `BtAdd` / `BtDelete`); the rest are exported because they are part
// of the same authored row and would otherwise be re-exported ad hoc later.
// Group management (`BtAddGroup`, `BtMod` — 好友分組), the couple system
// (`BtMate`), group whisper (`BtGroupWhisper`) and the memo feature
// (`BtMessage`) have no rule behind them yet and stay unbound in the view.
//
// Every canvas keeps its WZ origin so the client anchors the shell and the
// buttons exactly where the source does.  The manifest key is `friendUi`;
// nothing here invents geometry or artwork.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const wz = require('@tybys/wz');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const OUTPUT = path.join(ROOT, 'resources/tms273-export');
const ASSETS = path.join(OUTPUT, 'assets/tms273');
const USERLIST = 'UI/UIWindow.img/UserList';
const FRIEND = `${USERLIST}/Friend`;
const BLACKLIST = `${USERLIST}/BlackList`;
const TAB = `${USERLIST}/Tab`;

/// Highest tab index to probe.  The source strip authors one plate per tab;
/// probing stops at the first missing index, so the real count is discovered
/// rather than hard-coded.
const MAX_TAB_INDEX = 8;

/// The window shell lives on `UserList`, not on the `Friend` tab.  It is the
/// same sprite the party window uses.
const SHELL = {
  backgrnd: `${USERLIST}/backgrnd`,
};

/// Authored action buttons on the `Friend` tab, in source order.
const FRIEND_BUTTONS = [
  'BtAddFriend',
  'BtAddGroup',
  'BtShowAll',
  'BtShowOnline',
  'BtMod',
  'BtAdd',
  'BtDelete',
  'BtWhere',
  'BtWhisper',
  'BtGroupWhisper',
  'BtChat',
  'BtSave',
  'BtMate',
  'BtParty',
  'BtBlock',
  'BtUnBlock',
  'BtMessage',
];

/// Authored action buttons on the `BlackList` tab.  Prefixed on export so the
/// two tabs' identically named buttons stay distinguishable.
const BLACKLIST_BUTTONS = ['BtAdd', 'BtDelete'];

const STATES = ['normal', 'pressed', 'disabled', 'mouseOver'];

const reader = createReader(DATA);
const exported = new Map();

function resolved(node) {
  const seen = new Set();
  let current = node;
  while (current instanceof wz.WzUOLProperty) {
    assert(!seen.has(current), `UOL cycle at ${node?.name || '<unnamed>'}`);
    seen.add(current);
    current = current.linkValue;
  }
  return current;
}

async function get(source) {
  try {
    const node = await reader.get(source);
    if (node instanceof wz.WzImage) assert(await node.parseImage(), source);
    return node;
  } catch (error) {
    throw new Error(`${source}: ${error.message}`, { cause: error });
  }
}

async function frame(source) {
  if (!exported.has(source)) {
    const result = await reader.frame(source, ASSETS);
    assert(result.url && result.width > 0 && result.height > 0, `invalid Canvas: ${source}`);
    exported.set(source, { ...result, url: `/assets/tms273/${result.url}` });
  }
  return exported.get(source);
}

/// A `normal/pressed/...` button: export the first frame of every authored
/// state that actually exists, so an element that only ships `normal` (or a
/// disabled look) is not turned into a missing-asset hole.  Keys are flat
/// (`BtDelete/normal`) to match the existing `shopUi` / `storageUi` /
/// `partyUi` convention.
async function exportStates(base, index, prefix) {
  let found = 0;
  for (const state of STATES) {
    try {
      index[`${prefix}/${state}`] = await frame(`${base}/${state}/0`);
      found += 1;
    } catch {
      // State is not authored for this element; leaving it out is correct.
    }
  }
  if (!found) throw new Error(`no states exported for ${base}`);
  return index;
}

/// `Tab/enabled` and `Tab/disabled` are plain numbered strips.  Probe until an
/// index is missing; the count is a fact about the source, not a guess.
async function exportStrip(name, source, ui) {
  let count = 0;
  for (let index = 0; index < MAX_TAB_INDEX; index += 1) {
    try {
      ui[`${name}/${index}`] = await frame(`${source}/${index}`);
      count += 1;
    } catch {
      break;
    }
  }
  return count;
}

async function main() {
  fs.mkdirSync(ASSETS, { recursive: true });
  try {
    const friend = resolved(await get(FRIEND));
    assert(friend instanceof wz.WzSubProperty, `${FRIEND} is not a sub-property`);
    const blacklist = resolved(await get(BLACKLIST));
    assert(blacklist instanceof wz.WzSubProperty, `${BLACKLIST} is not a sub-property`);

    const ui = {};
    for (const [name, source] of Object.entries(SHELL)) ui[name] = await frame(source);
    for (const name of FRIEND_BUTTONS) {
      await exportStates(`${FRIEND}/${name}`, ui, name);
    }
    for (const name of BLACKLIST_BUTTONS) {
      await exportStates(`${BLACKLIST}/${name}`, ui, `BlackList/${name}`);
    }
    const enabledTabs = await exportStrip('Tab/enabled', `${TAB}/enabled`, ui);
    const disabledTabs = await exportStrip('Tab/disabled', `${TAB}/disabled`, ui);
    // The window needs at least one selectable tab plate and its unselected
    // counterpart, otherwise the two-tab strip cannot be drawn at all.
    assert(enabledTabs > 0, `no enabled tab plates under ${TAB}/enabled`);
    assert(disabledTabs > 0, `no disabled tab plates under ${TAB}/disabled`);

    // The chrome the window actually needs: the shell and the four buttons
    // that carry a server intent this round.
    for (const name of [
      'backgrnd',
      'BtAddFriend/normal',
      'BtDelete/normal',
      'BtBlock/normal',
      'BtUnBlock/normal',
      'BlackList/BtAdd/normal',
      'BlackList/BtDelete/normal',
    ]) {
      assert(ui[name], `missing friend window piece ${name}`);
    }

    const output = {
      contentVersion: 'tms273-friend',
      source: 'TMS273.7 client WZ / UI/UIWindow.img/UserList (Friend + BlackList tabs)',
      tabCount: Math.min(enabledTabs, disabledTabs),
      ui,
    };
    const outputPath = path.join(OUTPUT, 'friend.json');
    fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      output: outputPath,
      source: `${FRIEND} + ${BLACKLIST} + ${TAB}`,
      pngs: exported.size,
      frames: Object.keys(ui).length,
      enabledTabs,
      disabledTabs,
    }, null, 2));
  } finally {
    reader.close();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { DATA, OUTPUT, ASSETS, USERLIST, FRIEND, BLACKLIST, TAB, main };
