#!/usr/bin/env node

// Export the source-backed chat emoticon catalogue plus its window chrome from
// `UI/ChatEmoticon.img` (TMS273.7 client WZ).
//
// Two halves of the same authored image are exported:
//
//   Emoticon/<groupId>/<stickerId>
//                   the sticker catalogue.  `desc` is the authored name of the
//                   sticker (開心, 愛心!, …), `info/icon` is the 32x32 list
//                   icon (every sticker of a group outlinks to that group's
//                   own icon — asserted below), and `effect/<n>` is the short
//                   animation the original plays above the speaker's head,
//                   each frame carrying its own origin/z/delay.
//   ChatLimit       the authored send budget: `count` stickers inside `time`
//                   milliseconds.  This is the source's own rate rule, so the
//                   server reuses it instead of inventing a bucket.
//   UI/ChatEmoticon the 表情 window shell: `backgrnd`, the authored buttons
//                   (close / pageUp / pageDown / bookmarkTab / bookmark_ON /
//                   bookmark_OFF / edit / save / help / keySettingUI), the grid
//                   slot art (`slotBase`, `layer:emptySlot`), the paging dots
//                   (`pageIcon/on|off`) and the authored geometry
//                   (`slotOffset`, `slotSpace`, `emoticon`, `pageOffset`,
//                   `pageIconSpace`, `groupOffset`, `groupSpace`, `groupCount`,
//                   `name/*`).
//
// Bookmark groups (`bookmarkTab` + `edit`/`save`), the key-setting window and
// the limited-time sticker alert (`timeLimit` / `expiredAlert`) are exported
// because they belong to the same authored panel, but no rule exists for them
// yet — the view must not invent one, so they stay unbound.
//
// Every canvas keeps its WZ origin/x/y so the client anchors the shell, the
// slots and the sticker animation exactly where the source does.  The manifest
// key is `emoticon`; nothing here invents geometry or artwork.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const wz = require('@tybys/wz');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const OUTPUT = path.join(ROOT, 'resources/tms273-export');
const ASSETS = path.join(OUTPUT, 'assets/tms273');
const IMAGE = 'UI/ChatEmoticon.img';
const CATALOGUE = `${IMAGE}/Emoticon`;
const PANEL = `${IMAGE}/UI/ChatEmoticon`;

/// The authored button states, in the order the source authors them.
const STATES = ['normal', 'pressed', 'disabled', 'mouseOver'];

/// Authored panel buttons.  Only `button:close`, `button:pageUp` and
/// `button:pageDown` carry an intent in this round; the rest are part of the
/// same authored row and are exported so a later round does not re-derive them.
const BUTTONS = [
  'button:close',
  'button:pageUp',
  'button:pageDown',
  'button:bookmarkTab',
  'bookmark_ON',
  'bookmark_OFF',
  'button:edit',
  'button:save',
  'button:help',
  'button:keySettingUI',
];

/// Highest sticker animation frame index to probe.  The count is discovered
/// from the source rather than assumed.
const MAX_EFFECT_FRAMES = 256;
/// Highest sticker index to probe inside one group.
const MAX_GROUP_STICKERS = 64;

const reader = createReader(DATA);
const exported = new Map();

const value = (node, name) => {
  const property = node?.at?.(name);
  if (!property) return undefined;
  return property.value === undefined ? property.wzValue : property.value;
};

const vector = (node, name) => {
  const point = name ? value(node, name) : node?.wzValue;
  return point && Number.isFinite(point.x) && Number.isFinite(point.y) ? { x: point.x, y: point.y } : null;
};

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

/// A `normal/pressed/...` button.  Only the states the source authors are
/// exported, so an element that ships a single look is not a missing asset.
async function exportStates(base, index, prefix) {
  let found = 0;
  for (const state of STATES) {
    try {
      index[`${prefix}/${state}`] = await frame(`${base}/${state}/0`);
      found += 1;
    } catch {
      // Not authored for this element; leaving it out is correct.
    }
  }
  if (!found) throw new Error(`no states exported for ${base}`);
  return found;
}

/// Probe `<base>/<n>` until an index is missing.  Returns the sticker frames.
async function exportEffect(base) {
  const frames = [];
  for (let index = 0; index < MAX_EFFECT_FRAMES; index += 1) {
    let result;
    try {
      result = await frame(`${base}/${index}`);
    } catch {
      break;
    }
    const node = await get(`${base}/${index}`);
    frames.push({
      ...result,
      z: Number(value(node, 'z') ?? 0),
      delay: Math.max(1, Number(result.delay) || 100),
    });
  }
  assert(frames.length, `sticker has no effect frames: ${base}`);
  return frames;
}

async function main() {
  fs.mkdirSync(ASSETS, { recursive: true });
  try {
    const limitNode = await get(`${IMAGE}/ChatLimit`);
    const limit = {
      count: Number(value(limitNode, 'count')),
      timeMs: Number(value(limitNode, 'time')),
      source: `${IMAGE}/ChatLimit`,
    };
    assert(Number.isSafeInteger(limit.count) && limit.count > 0, 'ChatLimit.count is not a positive integer');
    assert(Number.isSafeInteger(limit.timeMs) && limit.timeMs > 0, 'ChatLimit.time is not a positive integer');

    const catalogue = await get(CATALOGUE);
    const groupIds = [...catalogue.wzProperties].filter(property => property.wzProperties).map(property => property.name);
    assert(groupIds.length, `${CATALOGUE} has no groups`);

    const groups = [];
    const stickers = [];
    for (const groupId of groupIds) {
      const groupNode = await get(`${CATALOGUE}/${groupId}`);
      const groupName = String(value(groupNode, 'desc') ?? groupId);
      const icon = await frame(`${CATALOGUE}/${groupId}/icon`);
      groups.push({ id: groupId, name: groupName, icon });

      // Sticker ids are the group id followed by a 4-digit ordinal, but the
      // ordinal is not always contiguous — walk the authored children instead
      // of doing arithmetic, so a gap never invents an id.
      const stickerNodes = [...groupNode.wzProperties]
        .filter(property => property.wzProperties && /^\d+$/.test(property.name))
        .slice(0, MAX_GROUP_STICKERS);
      assert(stickerNodes.length, `${CATALOGUE}/${groupId} has no stickers`);
      for (const stickerNode of stickerNodes) {
        const sourceName = stickerNode.name;
        const base = `${CATALOGUE}/${groupId}/${sourceName}`;
        // The authored node name is only unique *inside its group*: group 1043
        // re-releases group 1036's six stickers under the same node names with
        // different captions (byte-identical canvases).  Source semantics are
        // therefore a (group, node) pair, and the catalogue id carries both —
        // `:` is already part of the protocol's id alphabet, so the id stays a
        // plain validated string instead of a compound wire value.
        const stickerId = `${groupId}:${sourceName}`;
        // The 32x32 list icon is authored per sticker and *may* outlink to the
        // group icon (10000001 does) or carry its own canvas (10000002 does),
        // so it is resolved per sticker and never assumed.  Identical canvases
        // collapse onto one PNG because the writer keys by resolved source.
        const stickerIcon = await frame(`${base}/info/icon`);
        assert(stickerIcon.width >= 8 && stickerIcon.width <= 64 && stickerIcon.height >= 8 && stickerIcon.height <= 64, `${base} icon has an implausible size`);
        const frames = await exportEffect(`${base}/effect`);
        stickers.push({
          id: stickerId,
          groupId,
          sourceName,
          name: String(value(stickerNode, 'desc') ?? sourceName),
          icon: stickerIcon,
          frames,
          durationMs: frames.reduce((total, frame) => total + frame.delay, 0),
        });
      }
    }
    {
      const ids = stickers.map(sticker => sticker.id);
      assert.equal(new Set(ids).size, ids.length, 'Catalogue ids must be globally unique');
    }

    // Flat keys (`slotBase`, `button:close/normal`, …) match the existing
    // `storageUi` / `partyUi` / `friendUi` convention.
    const ui = {};
    for (const element of ['backgrnd', 'slotBase', 'layer:emptySlot', 'groupBase', 'groupSelect', 'pageIcon/on', 'pageIcon/off']) {
      ui[element] = await frame(`${PANEL}/${element}`);
    }
    for (const name of BUTTONS) await exportStates(`${PANEL}/${name}`, ui, name);
    for (const name of ['slotBase', 'layer:emptySlot', 'groupBase', 'groupSelect']) {
      assert(ui[name], `missing emoticon window piece ${name}`);
    }
    assert(ui['button:close/normal'] && ui['button:pageUp/normal'] && ui['button:pageDown/normal'], 'missing emoticon window buttons');

    const nameNode = await get(`${PANEL}/name`);
    const nameFont = await get(`${PANEL}/name/font:name`);
    const layout = {
      // 9 slots per page: the source grid starts at `slotOffset` and repeats
      // every `slotSpace`.  The row count is not guessed — it is *proved* below
      // by `layer:emptySlot`, the authored "在本頁籤沒有可以使用的表情符號。"
      // panel, which is drawn over exactly one grid: 321x302 == 3 columns and 3
      // rows of `slotBase` plus the authored spacing.  A fourth row would land
      // on the window's own bottom information bar.
      columns: 3,
      rows: 3,
      slotCount: 9,
      slotOffset: vector(await get(`${PANEL}/slotOffset`)),
      slotSpace: vector(await get(`${PANEL}/slotSpace`)),
      slotSize: { width: ui.slotBase.width, height: ui.slotBase.height },
      emoticon: vector(await get(`${PANEL}/emoticon`)),
      pageOffset: vector(await get(`${PANEL}/pageOffset`)),
      pageIconSpace: Number(value(await get(`${PANEL}/pageIcon`), 'iconSpace')),
      groupOffset: vector(await get(`${PANEL}/groupOffset`)),
      groupSpace: vector(await get(`${PANEL}/groupSpace`)),
      groupCount: Number((await get(`${PANEL}/groupCount`)).wzValue),
      name: {
        offset: vector(nameNode, 'vector:nameOffset'),
        width: Number(value(nameNode, 'width')),
        font: String(value(nameFont, 'font') ?? ''),
        size: Number(value(nameFont, 'fontSize') ?? 12),
        color: String(value(nameFont, 'fontColor') ?? 'FFFFFFFF'),
        bold: Number(value(nameFont, 'bold') ?? value(nameFont, 'fontBold') ?? 0) === 1,
      },
    };
    for (const key of ['slotOffset', 'slotSpace', 'emoticon', 'pageOffset', 'groupOffset', 'groupSpace', 'name']) {
      assert(layout[key], `missing emoticon layout geometry: ${key}`);
    }
    assert(layout.slotSize.width > 0 && layout.slotSize.height > 0, 'slotBase has no size');
    assert(Number.isSafeInteger(layout.groupCount) && layout.groupCount > 0, 'groupCount is not positive');
    assert(layout.slotCount === layout.columns * layout.rows, 'slotCount must equal columns * rows');
    // The authored grid has to fit inside the authored shell, otherwise the
    // constants above are wrong and the window would clip its own slots.
    const gridWidth = layout.slotOffset.x + (layout.columns - 1) * layout.slotSpace.x + layout.slotSize.width;
    const gridHeight = layout.slotOffset.y + (layout.rows - 1) * layout.slotSpace.y + layout.slotSize.height;
    assert(gridWidth <= ui.backgrnd.width, 'slot grid overflows the window width');
    assert(gridHeight <= ui.backgrnd.height, 'slot grid overflows the window height');
    // Cross-check the row/column count against the one piece of art that *is*
    // authored for a whole grid: the empty-state panel.  This is what pins the
    // grid at 3x3 instead of "whatever fits", so a future source revision that
    // changes the grid size fails here rather than silently mis-drawing.
    const emptySlot = ui['layer:emptySlot'];
    assert(emptySlot, 'missing the authored empty-state panel');
    for (const [what, grid, panel] of [
      ['width', gridWidth - layout.slotOffset.x, emptySlot.width],
      ['height', gridHeight - layout.slotOffset.y, emptySlot.height],
    ]) {
      assert.equal(Math.abs(grid - panel) <= 4, true, `slot grid ${what} (${grid}) does not match the empty-state panel (${panel})`);
    }

    // Navigation model, read off the authored geometry instead of invented.
    // Every signal below is in the source art:
    //   * `button:pageUp` resolves to x=80 and `button:pageDown` to x=321, both
    //     at y=50 — i.e. the two buttons sit *on the chip row* and flank it.
    //     The chips are drawn from `groupOffset` = 113 and step `groupSpace` =
    //     41, so five of them end at 309: 80 is left of the strip, 321 is right
    //     of it.  The 3x3 grid (y = 115..417) has no button beside it at all.
    //   * `pageIcon` is drawn 5px *under* the chips (dots at y=83, chips end at
    //     78), so the dots belong to the strip row too, not to the grid.
    //   * The shipped catalogue has 51 groups; at `groupCount` = 5 that is
    //     exactly 11 strip pages, which is what the authored dot strip holds
    //     before it would run under `pageDown`.
    //   * The content is authored as sheets: 50 of the 51 groups hold <= 9
    //     stickers, so one group is one 3x3 grid.  `layer:emptySlot` — a
    //     full-grid overlay reading "在本頁籤沒有可以使用的表情符號。" — then
    //     describes a *group* with nothing to show, a state a walk over the flat
    //     list could never reach.
    // So `pageUp`/`pageDown`/`pageIcon` drive the strip and the grid is scoped to
    // the selected group.  A group is one sheet unless it overflows `slotCount`
    // (only group 1000 does: 10 stickers, so it takes two sheets), and the flat
    // `stickers` array stays contiguous per group so a group's sheet is a slice.
    const stripRight = layout.groupOffset.x + (layout.groupCount - 1) * layout.groupSpace.x + ui.groupBase.width;
    const chipBottom = layout.groupOffset.y + ui.groupBase.height;
    for (const name of ['pageUp', 'pageDown']) {
      const button = ui[`button:${name}/normal`];
      assert(button.y < chipBottom && button.y + button.height > layout.groupOffset.y, `${name} is not aligned with the group strip row`);
    }
    assert(ui['button:pageUp/normal'].x < layout.groupOffset.x, 'pageUp does not sit left of the group strip');
    assert(ui['button:pageDown/normal'].x >= stripRight, 'pageDown does not sit right of the group strip');
    assert(layout.pageOffset.y >= chipBottom, 'the page dots are not drawn under the group strip');
    assert(layout.pageOffset.y < layout.slotOffset.y, 'the page dots do not sit between the strip and the grid');

    const stickerCountByGroup = new Map();
    for (const sticker of stickers) {
      stickerCountByGroup.set(sticker.groupId, (stickerCountByGroup.get(sticker.groupId) ?? 0) + 1);
    }
    let sheetCount = 0;
    let cursor = 0;
    for (const group of groups) {
      const count = stickerCountByGroup.get(group.id) ?? 0;
      assert(count >= 1, `${group.id} has no stickers`);
      // The view slices a group out of the flat catalogue, so the range has to
      // be contiguous in the order the stickers were pushed.
      for (let offset = 0; offset < count; offset++) {
        assert.equal(stickers[cursor + offset].groupId, group.id, `${group.id} stickers are not contiguous in the catalogue`);
      }
      group.stickerCount = count;
      group.firstSticker = cursor;
      group.sheetCount = Math.ceil(count / layout.slotCount);
      sheetCount += group.sheetCount;
      cursor += count;
    }
    assert.equal(cursor, stickers.length, 'group ranges do not cover the catalogue');

    const pageCount = Math.ceil(groups.length / layout.groupCount);
    // How many dots fit before the strip would draw under `pageDown`.
    const dotCapacity = Math.floor((ui['button:pageDown/normal'].x - layout.pageOffset.x - ui['pageIcon/on'].width) / layout.pageIconSpace) + 1;
    assert(pageCount <= dotCapacity, `the strip needs ${pageCount} dots but only ${dotCapacity} fit before pageDown`);

    const output = {
      contentVersion: 'tms273-emoticon',
      source: 'TMS273.7 client WZ / UI/ChatEmoticon.img (Emoticon catalogue + UI/ChatEmoticon window)',
      limit,
      /** Pages of the group strip (`groupCount` chips each).  This is what the
       *  authored `pageUp`/`pageDown` buttons and the `pageIcon` dots drive. */
      pageCount,
      /** Sticker sheets in the whole catalogue: the sum of each group's own
       *  `slotCount`-cell sheets, because the grid is scoped to one group. */
      sheetCount,
      /** Dots the authored strip holds before running under `pageDown`. */
      dotCapacity,
      groups,
      stickers,
      layout,
      ui,
    };
    const outputPath = path.join(OUTPUT, 'emoticon.json');
    fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      output: outputPath,
      groups: groups.length,
      stickers: stickers.length,
      stripPages: output.pageCount,
      sheets: output.sheetCount,
      dotCapacity: output.dotCapacity,
      frames: stickers.reduce((total, sticker) => total + sticker.frames.length, 0),
      pngs: exported.size,
      ui: Object.keys(ui).length,
      limit,
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

module.exports = { DATA, OUTPUT, ASSETS, IMAGE, CATALOGUE, PANEL, main };
