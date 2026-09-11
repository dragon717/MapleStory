#!/usr/bin/env node

// Export the TMS273 buff display and the authored quick-slot fold keys.
//
// Why this module exists
// ----------------------
// The status bar (UI/StatusBar3.img/mainBar) already ships in `hud.json`, but
// two pieces of it were never exported:
//
//   * `mainBar/quickSlot/button:Extend` and `button:Fold` — the authored
//     expand / collapse keys for the quick-slot bar.  The HUD used to draw a
//     text "−" / "+" instead, which is not the original art.
//   * `BuffSetting/favoriteBuff` — the panel behind the on-screen buff icons
//     (row of skill icons with their remaining seconds), plus its authored
//     icon spacing `spaceX` / `spaceY`, and the four `minimizedIcon` category
//     sprites the setting window uses.
//
// Verified against the local TMS273.7 client (all T class):
//   UI/StatusBar3.img/mainBar/quickSlot/{button:Extend,button:Fold}/<state>/0
//     four states each: normal / mouseOver / pressed / disabled
//   UI/StatusBar3.img/BuffSetting/favoriteBuff/{nw,n,ne,w,c,e,sw,s,se}
//     the 9-slice panel behind the buff icons
//   UI/StatusBar3.img/BuffSetting/favoriteBuff/{spaceX,spaceY}
//     authored icon spacing in pixels (both 5 in this client)
//   UI/StatusBar3.img/BuffSetting/minimizedIcon/{mySkill,othersSkill,commonSkill,itemSkill}
//     the four category sprites of the buff-settings window
//
// Output: resources/tms273-export/buff.json
//   { contentVersion, source, ui: { "<key>": frame }, layout: { spaceX, spaceY } }
// PNGs land in resources/tms273-export/assets/tms273/ and are copied into
// client/public-tms273 by scripts/assemble_tms273.cjs (it walks every
// `/assets/...` string in the manifest).
//
// Usage: node scripts/export_tms273_buff.cjs

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createReader } = require('./tms273_wz.cjs');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'resources/tms273-export');
const reader = createReader(path.join(root, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data'));
const imageRoot = path.join(output, 'assets/tms273');

const QUICK_SLOT = 'UI/StatusBar3.img/mainBar/quickSlot/';
const BUFF = 'UI/StatusBar3.img/BuffSetting/';
const STATES = ['normal', 'mouseOver', 'pressed', 'disabled'];
const PANEL_SLICES = ['nw', 'n', 'ne', 'w', 'c', 'e', 'sw', 's', 'se'];

async function main() {
  const ui = {};
  const add = async (source, key) => {
    const node = await reader.get(source);
    const frame = await reader.frame(source, imageRoot);
    assert(frame.width > 0 && frame.height > 0, `Empty frame: ${source}`);
    const file = path.join(imageRoot, frame.url);
    ui[key] = {
      ...frame,
      url: '/assets/tms273/' + frame.url,
      delay: 0,
      rawDelay: node.at('delay')?.wzValue ?? null,
      outlink: node.at('_outlink')?.wzValue ?? null,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    };
  };

  // The two authored fold keys, all four states.
  for (const key of ['button:Extend', 'button:Fold']) {
    for (const state of STATES) await add(`${QUICK_SLOT}${key}/${state}/0`, `quickSlot/${key}/${state}/0`);
  }

  // The buff panel 9-slice.
  for (const slice of PANEL_SLICES) await add(`${BUFF}favoriteBuff/${slice}`, `favoriteBuff/${slice}`);

  // The authored icon spacing — a source value, not a guess.
  const favoriteBuff = await reader.get(`${BUFF}favoriteBuff`);
  const spaceX = favoriteBuff.at('spaceX')?.wzValue;
  const spaceY = favoriteBuff.at('spaceY')?.wzValue;
  assert.equal(spaceX, 5, 'favoriteBuff/spaceX must be the authored 5 px');
  assert.equal(spaceY, 5, 'favoriteBuff/spaceY must be the authored 5 px');

  // Geometry guards measured off the exported art.  The fold keys are tall
  // narrow strips on the left edge of the quick-slot plate; the buff panel is a
  // tiny 5 px bevel grid.  A source revision changes these numbers and fails
  // here instead of silently resizing the HUD.
  assert.deepEqual([ui['quickSlot/button:Extend/normal/0'].width, ui['quickSlot/button:Extend/normal/0'].height], [13, 71]);
  assert.deepEqual([ui['quickSlot/button:Fold/normal/0'].width, ui['quickSlot/button:Fold/normal/0'].height], [12, 71]);
  for (const slice of ['nw', 'ne', 'sw', 'se']) {
    const frame = ui[`favoriteBuff/${slice}`];
    assert.deepEqual([frame.width, frame.height], [5, 5], `favoriteBuff/${slice} must stay a 5x5 corner`);
  }
  assert.deepEqual([ui['favoriteBuff/c'].width, ui['favoriteBuff/c'].height], [1, 1], 'favoriteBuff/c must stay a 1x1 fill');

  const result = {
    contentVersion: 'tms273-9',
    source: 'TMS273.7 client WZ / UI/StatusBar3.img/mainBar/quickSlot + BuffSetting/favoriteBuff',
    // P note: `BuffSetting/minimizedIcon/<category>/{on,off}` also exists in the
    // source (the category chips of the buff-settings window).  This round does
    // not implement that settings window, so those sprites stay unexported.
    ui,
    layout: { spaceX, spaceY },
  };
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'buff.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(`273 buff: ${Object.keys(ui).length} canvases, spacing ${spaceX}/${spaceY}`);
}

const assert = require('node:assert/strict');

main()
  .then(() => reader.close())
  .catch(error => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
