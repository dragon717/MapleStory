#!/usr/bin/env node

// Export the source-backed party window (`UI/UIWindow.img/UserList`, `Party` tab).
//
// The original UserList window is one shell (`backgrnd`, 312x389) shared by the
// Friend / Party / Guild / Expedition tabs, with one `Party` subtree holding the
// party tab's own chrome.  This script exports only what the party window uses:
//
//   backgrnd   the shared window shell (UserList/backgrnd)
//   icon0      13x13 bare gold star — a normal member's row marker
//   icon1      17x16 star on a blue plate — the leader's row marker
//   party0     281x27 "隊伍開放" toggle plate (recruitment open)
//   party1     279x18 column divider lines
//   party2     279x4  thin double separator
//   party3     278x1  hairline separator
//   party4     281x27 "隊伍關閉" toggle plate (recruitment closed)
//   party5     279x18 authored column header: 名稱 / 職業 / 等級
//   BtCreate / BtInvite / BtKick / BtWithdraw / BtWhisper / BtChat /
//   BtChangeBoss / BtHP    action buttons, up to 4 authored states each
//
// IMPORTANT — verified by inspecting the exported art, not by guessing from the
// node names: `party0..party3` are *not* a six-slice roster row, and
// `party4`/`party5` are not further row slices.  The source draws a member row
// as text plus the divider lines, so the window renders its own rows and uses
// party1/party2/party3 only as separators.  Do not "reassemble" a row out of
// party0..party5: that would invent geometry the source does not have.
//
// `party0`..`party5` is also why `PARTY_MAX_MEMBERS` is 6 in the server: the
// source authors exactly six roster slots, so the window cannot render a
// seventh row the art never provided.  `PartySearch` (the separate
// "find a party" dialog) is not part of this window and stays unexported.
//
// Every canvas keeps its WZ origin so the client anchors the shell, the row
// markers and the buttons exactly where the source does.  The manifest key is
// `partyUi`; nothing here invents geometry or artwork.
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
const PARTY = `${USERLIST}/Party`;

/// Roster slots the source authors: `party0` .. `party5`, which is also the
/// server's `PARTY_MAX_MEMBERS`.
const MEMBER_SLOTS = 6;

/// The window shell lives on `UserList`, not on the `Party` tab.
const SHELL = {
  backgrnd: `${USERLIST}/backgrnd`,
};

/// Plain canvases on the `Party` tab.  All six `partyN` pieces are window
/// chrome (toggle plates, dividers, the authored column header), never a row
/// background — see the header comment.
const CANVASES = {
  icon0: `${PARTY}/icon0`,
  icon1: `${PARTY}/icon1`,
  ...Object.fromEntries(
    Array.from({ length: MEMBER_SLOTS }, (_, slot) => [`party${slot}`, `${PARTY}/party${slot}`]),
  ),
};

/// Authored action buttons on the `Party` tab, in source order.
const BUTTONS = {
  BtCreate: `${PARTY}/BtCreate`,
  BtInvite: `${PARTY}/BtInvite`,
  BtKick: `${PARTY}/BtKick`,
  BtWithdraw: `${PARTY}/BtWithdraw`,
  BtWhisper: `${PARTY}/BtWhisper`,
  BtChat: `${PARTY}/BtChat`,
  BtChangeBoss: `${PARTY}/BtChangeBoss`,
  BtHP: `${PARTY}/BtHP`,
};
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
/// (`BtKick/normal`) to match the existing `shopUi` / `storageUi` convention.
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

async function main() {
  fs.mkdirSync(ASSETS, { recursive: true });
  try {
    const party = resolved(await get(PARTY));
    assert(party instanceof wz.WzSubProperty, `${PARTY} is not a sub-property`);

    const ui = {};
    for (const [name, source] of Object.entries(SHELL)) ui[name] = await frame(source);
    for (const [name, source] of Object.entries(CANVASES)) ui[name] = await frame(source);
    for (const [name, source] of Object.entries(BUTTONS)) {
      await exportStates(source, ui, name);
    }

    // The chrome the window actually needs: the shell, both row markers, the
    // authored column header and at least one separator.
    for (const name of ['backgrnd', 'icon0', 'icon1', 'party5', 'party1']) {
      assert(ui[name], `missing party window piece ${name}`);
    }

    const output = {
      contentVersion: 'tms273-party',
      source: 'TMS273.7 client WZ / UI/UIWindow.img/UserList (Party tab)',
      memberSlots: MEMBER_SLOTS,
      ui,
    };
    const outputPath = path.join(OUTPUT, 'party.json');
    fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      output: outputPath,
      source: PARTY,
      pngs: exported.size,
      frames: Object.keys(ui).length,
      memberSlots: MEMBER_SLOTS,
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

module.exports = { DATA, OUTPUT, ASSETS, USERLIST, PARTY, MEMBER_SLOTS, main };
