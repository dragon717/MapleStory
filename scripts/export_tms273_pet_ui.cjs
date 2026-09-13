#!/usr/bin/env node

// Export the TMS273.7 pet-management window and the two authored entry
// buttons that lead to it.  The gallery has no pet screenshot card, so this
// exporter deliberately points at the local WZ nodes and preserves every
// source canvas/origin instead of re-drawing the chrome in CSS.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const wz = require('@tybys/wz');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const OUTPUT = path.join(ROOT, 'resources/tms273-export');
const ASSETS = path.join(OUTPUT, 'assets/tms273');
const PET = 'UI/UIWindow2.img/UserInfo/pet';
const PET_DIALOG = 'UI/UIWindow2.img/UtilDlgEx_Pet';
const CHARACTER_BUTTON = 'UI/UIWindow2.img/UserInfo/character/BtPet';
const INVENTORY_BUTTON = 'UI/UIWindow2.img/BitsSystem/inven/BtPet';
const BUTTON_STATES = ['normal', 'pressed', 'disabled', 'mouseOver'];

function relative(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function value(node, key) {
  const property = node?.at?.(key);
  return property?.wzValue ?? property?.value;
}

async function main() {
  assert(fs.existsSync(DATA), `missing TMS273.7 Data: ${DATA}`);
  fs.mkdirSync(ASSETS, { recursive: true });
  const reader = createReader(DATA);

  async function frame(source) {
    const node = await reader.get(source);
    if (node instanceof wz.WzImage) assert(await node.parseImage(), source);
    const origin = value(node, 'origin');
    assert(origin && Number.isFinite(origin.x) && Number.isFinite(origin.y), `${source}: source origin missing`);
    const delay = value(node, 'delay');
    assert(delay === undefined || delay === null, `${source}: pet UI must be static`);
    const rendered = await reader.frame(source, ASSETS);
    assert(rendered.width > 0 && rendered.height > 0, `${source}: invalid canvas`);
    const file = path.join(ASSETS, rendered.url);
    assert(fs.existsSync(file), `${source}: PNG missing`);
    return {
      ...rendered,
      url: `/assets/tms273/${rendered.url}`,
      source,
      resolvedSource: rendered.resolvedSource,
      delay: 0,
      rawDelay: delay ?? null,
      outlink: value(node, '_outlink') ?? null,
      sha256: sha256(file),
    };
  }

  async function states(base) {
    const result = {};
    for (const state of BUTTON_STATES) {
      try { result[state] = await frame(`${base}/${state}/0`); } catch (error) {
        if (!/not found|missing|找不到|不存在/i.test(String(error?.message ?? error))) throw error;
      }
    }
    assert(result.normal, `${base}: normal button state missing`);
    return result;
  }

  try {
    const ui = {};
    for (const name of ['backgrnd', 'backgrnd2', 'backgrnd3']) ui[`panel/${name}`] = await frame(`${PET}/${name}`);
    const tabs = { enabled: [], disabled: [] };
    for (const state of Object.keys(tabs)) {
      for (let index = 0; index < 3; index += 1) tabs[state].push(await frame(`${PET}/Tab/${state}/${index}`));
    }
    const actions = [];
    for (let index = 0; index < 3; index += 1) actions.push(await frame(`${PET}/ActionPet/${index}/0`));
    ui['button:exclude'] = await states(`${PET}/BtException`);
    const characterButton = await states(CHARACTER_BUTTON);
    const inventoryButton = await states(INVENTORY_BUTTON);
    const dialog = { backgrnd: await frame(`${PET_DIALOG}/backgrnd`) };

    const output = {
      contentVersion: 'tms273-pet-window',
      sourceVersion: 'TMS273.7',
      source: 'TMS273.7 client WZ',
      status: 'complete',
      sourceNode: PET,
      researchReference: {
        pdf: 'references/tms273_research_pack/MapleStory273_Source_Index.pdf (no pet card)',
        html: 'references/tms273_research_pack/MapleStory273_Online_Gallery.html (no pet card)',
        local: '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data/UI/UIWindow2.img',
        role: 'local WZ source; the research pack records no pet-specific image card',
      },
      window: {
        width: ui['panel/backgrnd'].width,
        height: ui['panel/backgrnd'].height,
        ui,
        tabs,
        actions,
        dialog,
      },
      buttons: { character: characterButton, inventory: inventoryButton },
      layout: {
        // These are the source canvases' placement anchors.  The detail page
        // is a single selected slot; tabs 1..3 represent the three slots.
        panel: { x: 0, y: 0 },
        panelInner: { x: 6, y: 7 },
        panelOverlay: { x: 7, y: 24 },
        action: { x: 10, y: 28 },
        tabCount: 3,
      },
      unverified: [
        'pet level, hunger, experience and other values absent from the current player contract are not rendered',
        'the server remains authoritative for cash-slot summon/recall actions',
      ],
      sourceFiles: [...new Set([...reader.files.keys(), ...reader.images.keys()])].sort().map(file => {
        const stat = fs.statSync(file);
        return { path: relative(file), bytes: stat.size, sha256: sha256(file) };
      }),
    };
    const outputPath = path.join(OUTPUT, 'pet-ui.json');
    fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      output: relative(outputPath),
      status: output.status,
      sourceNode: output.sourceNode,
      window: [output.window.width, output.window.height],
      tabs: tabs.enabled.length,
      actionCanvases: actions.length,
      buttons: Object.keys(output.buttons),
      sourceFiles: output.sourceFiles.length,
    }, null, 2));
  } finally {
    reader.close();
  }
}

if (require.main === module) main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});

module.exports = { main, PET, PET_DIALOG, CHARACTER_BUTTON, INVENTORY_BUTTON };
