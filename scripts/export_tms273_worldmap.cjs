#!/usr/bin/env node

// Export the TMS273 world map (大地图): the authored window shell, the authored
// per-region page art, and the authored page graph (region links + map spots).
//
// Source shapes (verified against the local TMS273.7 client)
// ---------------------------------------------------------
//   Map/WorldMap/WorldMap*.img        one image per page of the world map tree
//     info/parentMap   string   the page this one is opened from (root has none)
//     info/WorldMap    string   this page's own name
//     BaseImg/0        canvas   640x470, origin (320,235) — the drawn page
//     MapList/<n>      spot {x,y} + type + mapNo/0..n (the map ids on this page)
//     MapLink/<n>      toolTip + link/linkImg (canvas) + link/linkMap (a page)
//   UI/UIWindow2.img/WorldMap
//     Border/0         canvas   654x537 — the window plate, titled 世界地圖
//     BtBefore/BtNext/BtAll     the authored page controls, four states each
//   UI/UIMExplorer.img/worldMap
//     #mapImage        canvas   15x15, origin (7,7) — the map plate's frame
//     btClose          the authored close button, four states
//
// Coordinate model
// ----------------
// `BaseImg/0` is authored with origin (320,235), i.e. it is meant to be drawn
// centred on the page's own coordinate space: a spot at (x, y) lands at
// (320 + x, 235 + y) inside the 640x470 canvas.  `MapLink/linkImg` carries its
// own origin for the same reason, so every position this module writes out is
// the source vector and nothing is re-derived.
//
// Scope
// -----
// Only the pages that can show an assembled map, plus their ancestors up to the
// root, are exported: the world map's navigation/search/hyper-teleport/bookmark
// features belong to a UI this round does not implement, and exporting the 30
// other region pages would ship art no route can reach.
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
const WORLD_MAP_FILE = path.join(DATA, 'Map/WorldMap/WorldMap_000.wz');
const UI_WINDOW = 'UI/UIWindow2.img/WorldMap';
const UI_EXPLORER = 'UI/UIMExplorer.img/worldMap';
/** The authored root page: `Map/WorldMap/WorldMap.img` has no `parentMap`. */
const ROOT_PAGE = 'WorldMap';

const reader = createReader(DATA);
const exported = new Map();

/** Every page image inside the world map WZ, discovered from the archive. */
async function listPages() {
  await wz.init();
  const file = new wz.WzFile(WORLD_MAP_FILE, wz.WzMapleVersion.BMS, 273);
  const status = await file.parseWzFile();
  assert(status === wz.WzFileParseStatus.SUCCESS, 'WorldMap.wz 无法解析');
  const pages = [...(file.wzDirectory.wzImages ?? [])].map(image => image.name.replace(/\.img$/, ''));
  file.dispose();
  assert(pages.length > 0, 'WorldMap.wz 里没有任何页面');
  return pages;
}

function children(node) {
  const raw = node?.wzProperties;
  return raw && typeof raw[Symbol.iterator] === 'function' ? [...raw] : [];
}

function scalar(node, name) {
  const value = node?.at?.(name)?.wzValue;
  return value === undefined || value === null ? null : Number(value);
}

function vector(node, name) {
  const value = node?.at?.(name)?.wzValue;
  return value && Number.isFinite(value.x) && Number.isFinite(value.y) ? { x: Number(value.x), y: Number(value.y) } : null;
}

function string(node, name) {
  const value = node?.at?.(name)?.wzValue;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The archive stores `mapNo` as a bare integer, so `Maple Island`'s 10000 comes
 * out as the string `"10000"`.  Every other layer — `maps.json`, the server
 * snapshot, the client's `mapId` — speaks the 9-digit form (`"000010000"`), so
 * the raw value has to be padded here or the page/spot lookups silently miss.
 */
function mapId(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(Math.trunc(numeric)).padStart(9, '0') : String(value).padStart(9, '0');
}

async function pageNode(page) {
  const node = await reader.get(`Map/WorldMap/${page}.img`);
  if (node instanceof wz.WzImage) await node.parseImage();
  return node;
}

async function frame(source) {
  if (!exported.has(source)) {
    const result = await reader.frame(source, ASSETS);
    assert(result.url && result.width > 0 && result.height > 0, `invalid Canvas: ${source}`);
    exported.set(source, { ...result, url: `/assets/tms273/${result.url}` });
  }
  return exported.get(source);
}

/** The four authored button states, keyed by state name. */
async function buttonStates(source) {
  const states = {};
  for (const state of ['normal', 'mouseOver', 'pressed', 'disabled']) {
    const node = await reader.get(`${source}/${state}`);
    const child = children(node).find(item => /^\d+$/.test(item.name));
    states[state] = await frame(`${source}/${state}/${child ? child.name : '0'}`);
  }
  return states;
}

async function exportPage(page) {
  const node = await pageNode(page);
  const base = children(node.at('BaseImg')).find(item => item.name === '0');
  assert(base, `${page} 缺少 BaseImg/0`);
  const baseFrame = await frame(`Map/WorldMap/${page}.img/BaseImg/0`);
  const mapList = children(node.at('MapList')).map(entry => ({
    spot: vector(entry, 'spot'),
    type: scalar(entry, 'type'),
    mapIds: children(entry.at('mapNo')).map(item => mapId(item.wzValue)),
  }));
  assert(mapList.every(entry => entry.spot), `${page} 有缺少 spot 的 MapList 条目`);
  const mapLinks = [];
  for (const entry of children(node.at('MapLink'))) {
    const image = await frame(`Map/WorldMap/${page}.img/MapLink/${entry.name}/link/linkImg`);
    mapLinks.push({
      toolTip: string(entry, 'toolTip') ?? '',
      page: string(entry.at('link'), 'linkMap'),
      image,
    });
  }
  return {
    page,
    parent: string(node.at('info'), 'parentMap'),
    name: string(node.at('info'), 'WorldMap') ?? page,
    baseImg: baseFrame,
    mapList,
    mapLinks,
  };
}

/** The pages that can show an assembled map, plus their ancestors. */
async function selectPages(all, assembled) {
  const info = new Map();
  for (const page of all) {
    const node = await pageNode(page);
    info.set(page, {
      parent: string(node.at('info'), 'parentMap'),
      mapIds: children(node.at('MapList')).flatMap(entry => children(entry.at('mapNo')).map(item => mapId(item.wzValue))),
    });
  }
  assert(info.has(ROOT_PAGE), `世界地图根页面 ${ROOT_PAGE} 不存在`);
  const wanted = new Set([ROOT_PAGE]);
  for (const [page, entry] of info) {
    if (!entry.mapIds.some(id => assembled.has(id))) continue;
    // Walk up to the root so every exported page can be navigated out of.
    for (let current = page; current && !wanted.has(current); current = info.get(current)?.parent) {
      assert(info.has(current), `页面 ${current} 的父链断裂`);
      wanted.add(current);
    }
  }
  // Keep the discovery order stable (root first, then the archive order).
  return all.filter(page => wanted.has(page));
}

async function exportUi() {
  const border = await frame(`${UI_WINDOW}/Border/0`);
  const plate = await frame(`${UI_EXPLORER}/#mapImage`);
  const close = await buttonStates(`${UI_EXPLORER}/btClose`);
  const before = await buttonStates(`${UI_WINDOW}/BtBefore`);
  const next = await buttonStates(`${UI_WINDOW}/BtNext`);
  const all = await buttonStates(`${UI_WINDOW}/BtAll`);
  return { border, plate, close, nav: { before, next, all } };
}

async function main() {
  fs.mkdirSync(ASSETS, { recursive: true });
  const sources = JSON.parse(fs.readFileSync(MAPS, 'utf8')).maps;
  const assembled = new Set(sources.map(map => map.id));
  const all = await listPages();
  const pages = await selectPages(all, assembled);
  const pageData = {};
  for (const page of pages) pageData[page] = await exportPage(page);
  const ui = await exportUi();
  const output = {
    contentVersion: 'tms273-worldmap',
    source: 'TMS273.7 client WZ / Map.wz WorldMap + UI/UIWindow2.img/WorldMap + UI/UIMExplorer.img/worldMap',
    root: ROOT_PAGE,
    pages: pageData,
    ui,
    // Every page in the archive, so a reader can tell "not exported" from
    // "does not exist" without opening the WZ again.
    allPages: all,
  };
  const outputPath = path.join(OUTPUT, 'worldmap.json');
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    output: outputPath,
    pages: Object.keys(pageData).length,
    pageNames: Object.keys(pageData),
    skippedPages: all.length - pages.length,
    spots: Object.values(pageData).reduce((sum, entry) => sum + entry.mapList.length, 0),
    links: Object.values(pageData).reduce((sum, entry) => sum + entry.mapLinks.length, 0),
    pngs: exported.size,
  }, null, 2));
}

if (require.main === module) {
  main().then(() => reader.close()).catch(error => {
    console.error(error.stack || error.message);
    reader.close();
    process.exitCode = 1;
  });
}

module.exports = { main, ROOT_PAGE };
