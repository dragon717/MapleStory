#!/usr/bin/env node

// Export the source-backed account-warehouse window (`UI/UIWindow.img/Trunk`).
//
// The original storage window is a fixed-size frame with a row highlight and a
// small set of authored buttons:
//
//   backgrnd  the window shell (put/get panes + the coin field)
//   select    the "this row is picked" highlight
//   Tab       the enabled/disabled tab sprites (0..4)
//   BtGet / BtPut / BtExit / BtGetAll / BtSort  action buttons, 4 states each
//   BtInCoin / BtOutCoin / BtCoin               mesos transfer buttons
//
// Every canvas keeps its WZ origin so the client anchors the shell and the
// buttons exactly where the source does.  The manifest key is `storageUi`;
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
const TRUNK = 'UI/UIWindow.img/Trunk';

/// Every authored element, as (manifest name -> WZ sub-path).  `states` lists
/// the WZ child names that hold frame 0; the manifest keeps one entry per
/// (element, state) so the client can swap a button's look without a rebuild.
const SHELL = {
  backgrnd: 'backgrnd',
  select: 'select',
};
const BUTTONS = {
  BtGet: 'BtGet',
  BtPut: 'BtPut',
  BtExit: 'BtExit',
  BtGetAll: 'BtGetAll',
  BtSort: 'BtSort',
  BtCoin: 'BtCoin',
  BtInCoin: 'BtInCoin',
  BtOutCoin: 'BtOutCoin',
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
/// (`BtGet/normal`) to match the existing `shopUi` manifest convention.
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
    const trunk = resolved(await get(TRUNK));
    assert(trunk instanceof wz.WzSubProperty, `${TRUNK} is not a sub-property`);

    const ui = {};
    for (const [name, sub] of Object.entries(SHELL)) {
      // Shell art (the window background, the row highlight) is a plain
      // canvas, not a state machine.
      ui[name] = await frame(`${TRUNK}/${sub}`);
    }
    for (const [name, sub] of Object.entries(BUTTONS)) {
      await exportStates(`${TRUNK}/${sub}`, ui, name);
    }
    // Tabs are a list of 5 authored sprites per state, not a single frame.
    let enabled = 0;
    let disabled = 0;
    for (const state of ['enabled', 'disabled']) {
      for (let index = 0; ; index += 1) {
        try {
          ui[`Tab/${state}/${index}`] = await frame(`${TRUNK}/Tab/${state}/${index}`);
          if (state === 'enabled') enabled += 1; else disabled += 1;
        } catch {
          break;
        }
      }
    }
    assert(enabled > 0 && disabled > 0, 'Tab exported no frames');

    const output = {
      contentVersion: 'tms273-storage',
      source: 'TMS273.7 client WZ / UI/UIWindow.img/Trunk',
      slotLimit: 24,
      ui,
    };
    const outputPath = path.join(OUTPUT, 'storage.json');
    fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      output: outputPath,
      source: TRUNK,
      pngs: exported.size,
      frames: Object.keys(ui).length,
      tabs: { enabled, disabled },
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

module.exports = { DATA, OUTPUT, ASSETS, TRUNK, main };
