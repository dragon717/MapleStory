#!/usr/bin/env node

// Export the source-backed player-to-player trade window
// (`UI/UIWindow2.img/TradingRoom`).
//
// The original window is a fixed-size shell with two offer panes and a small
// set of authored buttons:
//
//   backgrnd / backgrnd2 / backgrnd3   window shell layers (outlinked canvases)
//   BtTrade   提出交易 (confirm the offer)
//   BtReset   取消 (drop the current offer / leave the window)
//   BtCoin    楓幣 (open the mesos input)
//   BtEnter   輸入 (commit the typed mesos amount)
//   BtClame   確認收下 (accept the partner's confirmed offer)
//
// Every canvas keeps its WZ origin and the outlink chain is resolved by the
// shared reader, so the client anchors the shell exactly where the source
// does.  The manifest key is `tradeUi`; nothing here invents geometry.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const wz = require('@tybys/wz');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const OUTPUT = path.join(ROOT, 'resources/tms273-export');
const ASSETS = path.join(OUTPUT, 'assets/tms273');
const TRADING_ROOM = 'UI/UIWindow2.img/TradingRoom';

const SHELL = {
  backgrnd: 'backgrnd',
  backgrnd2: 'backgrnd2',
  backgrnd3: 'backgrnd3',
};
const BUTTONS = {
  BtTrade: 'BtTrade',
  BtReset: 'BtReset',
  BtCoin: 'BtCoin',
  BtEnter: 'BtEnter',
  BtClame: 'BtClame',
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
    const room = resolved(await get(TRADING_ROOM));
    assert(room instanceof wz.WzSubProperty, `${TRADING_ROOM} is not a sub-property`);

    const ui = {};
    for (const [name, sub] of Object.entries(SHELL)) {
      ui[name] = await frame(`${TRADING_ROOM}/${sub}`);
    }
    for (const [name, sub] of Object.entries(BUTTONS)) {
      await exportStates(`${TRADING_ROOM}/${sub}`, ui, name);
    }

    const output = {
      contentVersion: 'tms273-trade',
      source: 'TMS273.7 client WZ / UI/UIWindow2.img/TradingRoom',
      ui,
    };
    const outputPath = path.join(OUTPUT, 'trade.json');
    fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      output: outputPath,
      source: TRADING_ROOM,
      pngs: exported.size,
      frames: Object.keys(ui).length,
      buttons: Object.keys(BUTTONS).length,
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

module.exports = { DATA, OUTPUT, ASSETS, TRADING_ROOM, main };
