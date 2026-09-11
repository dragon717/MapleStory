#!/usr/bin/env node

// Export the TMS273 minimap: one authored small-map canvas per assembled map,
// plus the `UI/UIMap.img/MiniMap` window chrome, markers, buttons and layout.
//
// Why this module exists
// ----------------------
// Every assembled map carries a source `miniMap` node in Map.wz.  The original
// client renders it as the navigation window: a thumbnail of the map's own
// background art with the player's arrow, party members, NPCs, monsters and
// portals plotted on top.  Nothing in the project consumed that node before —
// `bounds` was derived from it for maps without a VR rect and the canvas itself
// was thrown away.
//
// Source shapes (verified against the local TMS273.7 client)
// ---------------------------------------------------------
//   Map.wz/Map/MapX/<id>.img/miniMap
//     canvas   -> _outlink to Map/Map/MapX/_Canvas/<id>.img/miniMap/canvas
//     width    int  authored rectangle width, in world units
//     height   int  authored rectangle height, in world units
//     centerX  int  world x of the rectangle's LEFT edge, negated
//     centerY  int  world y of the rectangle's TOP edge, negated
//     mag      int  source magnification hint (4 on every assembled map)
//   UI/UIMap.img/MiniMap            <- the complete definition
//     MinMap  nw,n,ne,w,e,sw,s,se,c   compact window (36 px header, no text)
//     MaxMap  same nine slices        full window (76 px header, street + map)
//     Min     w,c,e                  collapsed strip (30 px)
//     BtMap / BtNpc                  WORLD / NPC buttons
//     button:small|big|min|max       shrink / grow / collapse / expand
//     iconNpc/0..3  iconPortal/0..3  marker sprites
//     iconDirection/<8 compass>      the self arrow, four-frame pulse
//     MaxMap/vector:streetName {50,30}   MaxMap/vector:mapName {50,48}
//     MaxMap/vector:mapMark    {6,28}    MinMap|MaxMap|Min/minWidth 185
//     Min/vector:streetName {52,7}       Min/interval 5
//     vector:left {5,5}  vecotr:right {-26,5}   (the authored dock points)
//     font:mapName    MD摩利斯9 / 12 px / #FFFFFFFF
//     font:streetName MD摩利斯9 / 12 px / #FFD4E1E5
//   `UI/UIWindow2.img/MiniMap` is a thinner duplicate that `_outlink`s into
//   this one; it is not used here.  It additionally ships a legacy `*Mirror`
//   chrome set for a left-docked window, which this round does not render.
//   `MapHelper.img/mark/<info/mapMark>` is the 38x38 town badge the original
//   draws on the MaxMap corner's white plate at `vector:mapMark` (`None`
//   authors no badge); `MiniMap/npcList` is the NPC 目录 window the `BtNpc`
//   button opens (backgrnd 184x286, rows at listLT..listRB, 18 px pitch,
//   `vector:namePos`, `button:close`, `icon/<flavour>`); `iconNavi` is the
//   chevron drawn over the NPC a player picked in that list.
//
// Coordinate model (the one fact this module must get right)
// ----------------------------------------------------------
// The authored rectangle in world space is
//     x ∈ [-centerX, width - centerX]   y ∈ [-centerY, height - centerY]
// which is exactly the range the assembler turns into `bounds` for maps that
// carry no explicit VR rect (see `references/tms273-data/maps.json`: 000030001
// has bounds [-768,707]x[-409,554] with centerX/centerY 768/409).  Canvas pixel
// (0,0) is the rectangle's top-left corner, so
//     px = (worldX + centerX) * canvasWidth  / width
//     py = (worldY + centerY) * canvasHeight / height
// Measured against 16 142 points sampled along authored footholds in every
// assembled map, this mapping puts 90.5% of them on a drawn pixel at offset
// (0,0) and 93.0% at the best neighbouring offset — the residual is the one
// pixel of slack the 1/16 downscale and the anti-aliased terrain edge leave.
//
// `mag` is kept for source tracing only: it is 4 on every assembled map and
// therefore carries no per-map information.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const wz = require('@tybys/wz');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const OUTPUT = path.join(ROOT, 'resources/tms273-export');
const ASSETS = path.join(OUTPUT, 'assets/tms273');
const MAPS = path.join(ROOT, 'references/tms273-data/maps.json');
const MINIMAP = 'UI/UIMap.img/MiniMap';

const reader = createReader(DATA);
const exported = new Map();
/** `MapHelper.img/mark/<name>` badges collected while exporting the UI, keyed
 *  by the source `info/mapMark` name. */
const marksIcons = {};

const SHELLS = {
  MinMap: { parts: ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se', 'c'] },
  // `MaxMap/nw2` (the 64x67 black "MINI MAP" title card) is authored but NOT
  // exported: the delivered window does not paint it, so shipping the slice
  // would only invite someone to wire a card the presentation deliberately
  // drops.  Re-adding it means adding it back here and to the window's
  // background layer list.
  MaxMap: { parts: ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se', 'c'] },
  Min: { parts: ['w', 'c', 'e'] },
};
/** Only the buttons this round wires are exported; the newer 導航 / 村莊過濾 /
 *  地城圖 buttons belong to features that are not implemented yet. */
const BUTTONS = ['BtMap', 'BtNpc', 'button:small', 'button:big', 'button:min', 'button:max'];
const BUTTON_STATES = ['normal', 'pressed', 'disabled', 'mouseOver'];
/** Marker variants.  `iconNpc` and `iconPortal` each author four sibling
 *  sprites, but only one NPC marker and one portal marker are drawn this round:
 *  the local client does not establish what the other variants mean (U), so the
 *  window does not guess a per-NPC-type mapping. */
const ICON_INDICES = ['0'];
const DIRECTIONS = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];
/** The NPC 目录 window rows: one icon per authored NPC flavour
 *  (`npcList/icon/*`).  The local snapshot does not classify NPCs into those
 *  flavours (U), so the client currently draws every row with `npc`. */
const NPC_LIST_ICONS = ['npc', 'eventnpc', 'shop', 'trunk', 'transport'];
const NPC_LIST_BUTTON = 'button:close';
const NPC_LIST_STATES = ['normal', 'pressed', 'mouseOver'];

function resolved(node) {
  const seen = new Set();
  let current = node;
  while (current instanceof wz.WzUOLProperty) {
    assert(!seen.has(current), 'UOL cycle');
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

/** A WZ scalar stored as `{"_dirType":"int","_value":"2313"}` in the map dump. */
function scalar(node, name) {
  const value = node?.[name]?._value;
  return value === undefined || value === null ? null : Number(value);
}

/** Walk a `/`-separated child path from a node. */
function atPath(node, path) {
  let current = node;
  for (const segment of String(path).split('/')) {
    current = current?.at?.(segment) ?? null;
    if (!current) return null;
  }
  return current;
}

/** Read a `vector:` child of the MiniMap root as `{x, y}`. */
function vector(root, name) {
  const value = atPath(root, name)?.wzValue;
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    throw new Error(`${MINIMAP}/${name} 不是有效坐标`);
  }
  return { x: Number(value.x), y: Number(value.y) };
}

/** Read a `font:` child of the MiniMap root: family, size and ARGB colour. */
function font(root, name) {
  const node = atPath(root, name);
  assert(node, `${MINIMAP}/${name} 缺失`);
  const raw = node.at('fontColor')?.wzValue;
  // `fontColor` is authored as an eight-digit ARGB hex literal (a WZ string:
  // FFFFFFFF for the map name, FFD4E1E5 for the street name), but a numeric
  // property would arrive as a signed 32-bit int.  Accept both.
  const text = typeof raw === 'string' ? raw.replace(/^0x/i, '') : (Number(raw) >>> 0).toString(16);
  const hex = text.padStart(8, '0').slice(-8);
  return {
    family: String(node.at('font')?.wzValue ?? ''),
    size: Number(node.at('fontSize')?.wzValue ?? 12),
    color: `#${hex.slice(2).toUpperCase()}`,
    alpha: Math.round(parseInt(hex.slice(0, 2), 16) / 255 * 100) / 100,
  };
}

/**
 * Export one node as a frame list.  A WZ Canvas is a single frame; a sub tree
 * of numbered children is an animation — `iconDirection/nw` authors four
 * frames (the arrow's pulse), all four `_outlink`-ing to a single PNG.
 */
async function framesOf(logical) {
  const node = resolved(await get(logical));
  if (node instanceof wz.WzCanvasProperty) return [await frame(logical)];
  const children = [...(node?.wzProperties ?? [])]
    .filter(child => /^\d+$/.test(child.name))
    .sort((a, b) => Number(a.name) - Number(b.name));
  assert(children.length > 0, `${logical} 既不是 Canvas 也没有编号帧`);
  const frames = [];
  for (const child of children) frames.push(await frame(`${logical}/${child.name}`));
  return frames;
}

async function exportMaps() {
  const sources = JSON.parse(fs.readFileSync(MAPS, 'utf8')).maps;
  const maps = {};
  const missing = [];
  const marks = new Set();
  for (const map of sources) {
    const raw = map.raw?.miniMap;
    const logical = map.sourceJson.replace(/\.json$/, '.img');
    if (!raw) {
      // Small interior maps (the three Victoria shops, 楓葉村武器店…) author no
      // minimap at all.  The original shows nothing for them either, so record
      // the gap instead of inventing a rectangle.
      missing.push({ mapId: map.id, name: map.name ?? map.nameRaw ?? '', reason: 'source 未提供 miniMap 节点' });
      continue;
    }
    const width = scalar(raw, 'width');
    const height = scalar(raw, 'height');
    const centerX = scalar(raw, 'centerX');
    const centerY = scalar(raw, 'centerY');
    assert(Number.isInteger(width) && width > 0, `${map.id} miniMap.width 无效`);
    assert(Number.isInteger(height) && height > 0, `${map.id} miniMap.height 无效`);
    assert(Number.isFinite(centerX) && Number.isFinite(centerY), `${map.id} miniMap 中心无效`);
    // `info/mapMark` names the town badge drawn on the MaxMap corner plate
    // (`vector:mapMark`); `None` authors no badge.  Collected here so the UI
    // pass exports exactly the badges the assembled maps use.
    const markName = String(map.raw?.info?.mapMark?._value ?? 'None');
    if (markName !== 'None') marks.add(markName);
    const canvas = await frame(`${logical}/miniMap/canvas`);
    maps[map.id] = {
      mapId: map.id,
      url: canvas.url,
      // Canvas pixels: this is the image the original client draws.
      width: canvas.width,
      height: canvas.height,
      // The authored rectangle this canvas covers, in world coordinates.
      world: { xMin: -centerX, yMin: -centerY, width, height },
      centerX,
      centerY,
      mag: scalar(raw, 'mag'),
      mark: markName,
      source: `Map.wz/${logical}/miniMap`,
      resolvedSource: canvas.resolvedSource,
    };
  }
  return { maps, missing, marks };
}

async function exportUi(marks) {
  const root = await get(MINIMAP);
  const ui = {};
  for (const [shell, { parts }] of Object.entries(SHELLS)) {
    for (const part of parts) ui[`${shell}/${part}`] = await frame(`${MINIMAP}/${shell}/${part}`);
  }
  // A button state is either a Canvas (`MinMap/nw`) or a numbered animation
  // (`BtMap/normal/0`); the window uses the first frame in both cases.
  for (const button of BUTTONS) for (const state of BUTTON_STATES) {
    ui[`${button}/${state}`] = (await framesOf(`${MINIMAP}/${button}/${state}`))[0];
  }
  // Markers.  Each `iconNpc`/`iconPortal` sprite is a single Canvas; each
  // `iconDirection/<compass>` authors four frames whose `_outlink`s all resolve
  // to one PNG, so the arrow is static and only the first frame is kept.
  const npc = (await framesOf(`${MINIMAP}/iconNpc/${ICON_INDICES[0]}`))[0];
  const portal = (await framesOf(`${MINIMAP}/iconPortal/${ICON_INDICES[0]}`))[0];
  const direction = {};
  for (const key of DIRECTIONS) direction[key] = (await framesOf(`${MINIMAP}/iconDirection/${key}`))[0];
  // The navigation chevron (`iconNavi/0..3`): the marker the original draws
  // over the NPC a player picked in the NPC 目录.  The four frames are a pulse;
  // the window keeps the first frame (measured static like `iconDirection`).
  const navi = (await framesOf(`${MINIMAP}/iconNavi`))[0];

  // The map mark badges: one `MapHelper.img/mark/<name>` shield per town the
  // assembled maps declare in `info/mapMark`.  Measured: every used badge is a
  // 38x38 square, and the MaxMap corner authors the white plate for it at
  // (7,29) 36x36 — `vector:mapMark (6,28)` puts the badge square on the plate.
  // A source revamp that changes any of these breaks here instead of drawing
  // a misaligned badge.
  const helperMarks = await get('Map/MapHelper.img/mark');
  const known = new Set([...(helperMarks.wzProperties ?? [])].map(child => child.name));
  for (const name of marks) {
    assert(known.has(name), `MapHelper.img/mark 缺少地图徽章: ${name}`);
    const badge = await frame(`Map/MapHelper.img/mark/${name}`);
    assert(badge.width === badge.height, `地图徽章不是方形: ${name} ${badge.width}x${badge.height}`);
    assert(badge.width === 38, `地图徽章尺寸偏离实测 38x38: ${name} ${badge.width}x${badge.height}`);
    marksIcons[name] = badge;
  }
  // The NPC 目录 window (`npcList`): panel art, close button and one row icon
  // per authored NPC flavour.
  const npcListBackgrnd = await frame(`${MINIMAP}/npcList/backgrnd`);
  // Measured off the panel: 184x286 with the row strip at listLT..listRB and
  // an 18 px row pitch — asserted so a revamp of the window breaks the export
  // instead of silently misaligning the rows.
  assert(npcListBackgrnd.width === 184 && npcListBackgrnd.height === 286, `npcList/backgrnd 尺寸偏离实测 184x286: ${npcListBackgrnd.width}x${npcListBackgrnd.height}`);
  ui['npcList/backgrnd'] = npcListBackgrnd;
  for (const state of NPC_LIST_STATES) {
    ui[`npcList/${NPC_LIST_BUTTON}/${state}`] = (await framesOf(`${MINIMAP}/npcList/${NPC_LIST_BUTTON}/${state}`))[0];
  }
  const npcListIcons = {};
  for (const flavour of NPC_LIST_ICONS) npcListIcons[flavour] = await frame(`${MINIMAP}/npcList/icon/${flavour}`);
  const npcListLayout = {
    namePos: vector(root, 'npcList/vector:namePos'),
    rowHeight: Number(root.at('npcList/rowHeight')?.wzValue ?? 18),
    listLT: vector(root, 'npcList/listLT'),
    listRB: vector(root, 'npcList/listRB'),
  };
  assert(npcListLayout.rowHeight > 0, 'npcList/rowHeight 无效');
  assert(npcListLayout.listRB.x > npcListLayout.listLT.x && npcListLayout.listRB.y > npcListLayout.listLT.y, 'npcList 列表矩形无效');

  // The authored tooltips: the window uses them verbatim for zh, the same way
  // it uses the source map names.  (`at()` only resolves one level; the nested
  // lookups go through `atPath`.)
  const tooltip = name => {
    const value = atPath(root, `${name}/toolTip`)?.wzValue;
    return value === undefined ? undefined : String(value);
  };
  const tooltips = { BtMap: tooltip('BtMap'), BtNpc: tooltip('BtNpc') };

  const layout = {
    // `minWidth` is the authored minimum window width shared by all three
    // modes; the client uses it verbatim and lets the map box take the rest.
    minWidth: Number(root.at('MinMap/minWidth')?.wzValue ?? 185),
    buttonInterval: Number(root.at('buttonInterval')?.wzValue ?? 21),
    // The two authored dock points.  `vecotr:right` is spelled that way in the
    // source; it is the right-anchored x offset (negative = inward).
    docks: { left: vector(root, 'vector:left'), right: vector(root, 'vecotr:right') },
    mapName: vector(root, 'MaxMap/vector:mapName'),
    streetName: vector(root, 'MaxMap/vector:streetName'),
    mapMark: vector(root, 'MaxMap/vector:mapMark'),
    minStreetName: vector(root, 'Min/vector:streetName'),
    minInterval: Number(root.at('Min/interval')?.wzValue ?? 5),
    fonts: { mapName: font(root, 'font:mapName'), streetName: font(root, 'font:streetName') },
    npcList: npcListLayout,
  };
  return {
    ui,
    icons: { npc, portal, direction, navi, marks: marksIcons, npcList: npcListIcons },
    layout,
    tooltips,
  };
}

async function main() {
  fs.mkdirSync(ASSETS, { recursive: true });
  try {
    const { maps, missing, marks } = await exportMaps();
    const { ui, icons, layout, tooltips } = await exportUi(marks);
    const output = {
      contentVersion: 'tms273-minimap',
      source: 'TMS273.7 client WZ / Map.wz miniMap + UI/UIMap.img/MiniMap + MapHelper.img/mark',
      maps,
      missing,
      ui,
      icons,
      layout,
      tooltips,
    };
    const outputPath = path.join(OUTPUT, 'minimap.json');
    fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      output: outputPath,
      maps: Object.keys(maps).length,
      missing: missing.map(entry => entry.mapId),
      marks: [...marks],
      ui: Object.keys(ui).length,
      icons: { npc: icons.npc.length, portal: icons.portal.length, direction: Object.keys(icons.direction).length, marks: Object.keys(icons.marks).length, npcList: Object.keys(icons.npcList).length },
      tooltips,
      layout,
      pngs: exported.size,
    }, null, 2));
  } finally {
    reader.close();
  }
}

if (require.main === module) {
  main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}

module.exports = { main, MINIMAP };
