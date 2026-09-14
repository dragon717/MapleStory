#!/usr/bin/env node

// Export the TMS273 keyboard configuration, custom preset and quick-slot art.
// The JSON keeps the authored WZ tree (values, origins, ids and labels) while
// every canvas reference is materialized as a source-backed PNG frame.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const OUTPUT = path.join(ROOT, 'resources/tms273-export');
const ASSETS = path.join(OUTPUT, 'assets/tms273');

const SOURCES = {
  statusKeyConfig: 'UI/StatusBar3.img/KeyConfig',
  customDefaultKeyConfig: 'UI/StatusBar3.img/CustomDefaultKeyConfig',
  quickSlot: 'UI/StatusBar3.img/mainBar/quickSlot',
  legacyKeyConfig: 'UI/UIWindow2.img/KeyConfig',
};

const reader = createReader(DATA);
const exportedFrames = new Map();

function primitive(node, key) {
  const property = node?.at?.(key);
  if (!property) return undefined;
  try {
    return property.wzValue;
  } catch {
    return undefined;
  }
}

function jsonValue(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'object') {
    if (Number.isFinite(value.x) && Number.isFinite(value.y)) return { x: value.x, y: value.y };
    if (Array.isArray(value)) return value.map(jsonValue);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return String(value);
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      const normalized = jsonValue(child);
      if (normalized !== undefined) result[key] = normalized;
    }
    return result;
  }
  return String(value);
}

function relative(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function get(source) {
  const node = await reader.get(source);
  if (typeof node.parseImage === 'function' && !node.parsed) assert(await node.parseImage(), source);
  return node;
}

async function frame(source) {
  if (!exportedFrames.has(source)) {
    const result = await reader.frame(source, ASSETS);
    assert(result.url && result.width > 0 && result.height > 0, `invalid Canvas: ${source}`);
    const file = path.join(ASSETS, result.url);
    assert(fs.existsSync(file), `missing exported Canvas: ${source}`);
    exportedFrames.set(source, {
      ...result,
      url: `/assets/tms273/${result.url}`,
      bytes: fs.statSync(file).size,
      sha256: sha256(file),
    });
  }
  return exportedFrames.get(source);
}

function hasCanvasLink(node) {
  return typeof primitive(node, '_outlink') === 'string' || typeof primitive(node, '_inlink') === 'string';
}

async function exportTree(source, node = null) {
  const current = node || await get(source);
  const result = {
    source,
    propertyType: current.propertyType,
  };
  const currentChildren = current.wzProperties || [];
  if (currentChildren.length === 0) {
    const ownValue = jsonValue(current.wzValue);
    if (ownValue !== undefined && ownValue !== null) result.value = ownValue;
  }
  if (hasCanvasLink(current)) result.frame = await frame(source);

  const values = {};
  const children = {};
  for (const child of currentChildren) {
    const childSource = `${source}/${child.name}`;
    if ((child.wzProperties || []).length === 0) {
      const value = jsonValue(child.wzValue);
      if (value !== undefined) values[child.name] = value;
    } else {
      children[child.name] = await exportTree(childSource, child);
    }
  }
  if (Object.keys(values).length) result.values = values;
  if (Object.keys(children).length) result.children = children;
  return result;
}

function childCount(tree, child) {
  return Object.keys(tree.children?.[child]?.children || {}).length;
}

async function main() {
  assert(fs.existsSync(DATA), `missing TMS273.7 Data: ${DATA}`);
  fs.mkdirSync(ASSETS, { recursive: true });

  const windows = {};
  for (const [name, source] of Object.entries(SOURCES)) windows[name] = await exportTree(source);

  const status = windows.statusKeyConfig;
  const keyPositions = status.children?.keyPos?.values || {};
  const iconPlaced = status.children?.iconPlaced?.children || {};
  const aniPlaced = status.children?.aniPlaced?.children || {};
  assert(Object.keys(keyPositions).length === 73, `unexpected keyPos count: ${Object.keys(keyPositions).length}`);
  assert(Object.keys(iconPlaced).length > 0, 'StatusBar3 KeyConfig has no placed icons');
  assert(Object.keys(aniPlaced).length === 4, `unexpected aniPlaced count: ${Object.keys(aniPlaced).length}`);

  const output = {
    contentVersion: 'tms273-keybindings',
    sourceVersion: 'TMS273.7',
    source: 'TMS273.7 client WZ',
    status: 'complete',
    notes: [
      'StatusBar3 KeyConfig is the current TMS273 key-position and custom-key source.',
      'CustomDefaultKeyConfig contains the source custom-default-key and quick-slot geometry.',
      'UIWindow2 KeyConfig is retained as the legacy/classic preview and quick-slot configuration source.',
    ],
    summary: {
      keyPositionCount: Object.keys(keyPositions).length,
      placedIconCount: Object.keys(iconPlaced).length,
      placementAnimationCount: Object.keys(aniPlaced).length,
      quickSlotBackground: windows.quickSlot.children?.backgrnd?.frame?.width && {
        width: windows.quickSlot.children.backgrnd.frame.width,
        height: windows.quickSlot.children.backgrnd.frame.height,
      },
      customDefaultBackground: windows.customDefaultKeyConfig.children?.backgrnd?.frame?.width && {
        width: windows.customDefaultKeyConfig.children.backgrnd.frame.width,
        height: windows.customDefaultKeyConfig.children.backgrnd.frame.height,
      },
    },
    windows,
    exportedPngCount: exportedFrames.size,
  };
  const outputPath = path.join(OUTPUT, 'keybindings.json');
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    output: relative(outputPath),
    sourceVersion: output.sourceVersion,
    keyPositionCount: output.summary.keyPositionCount,
    placedIconCount: output.summary.placedIconCount,
    placementAnimationCount: output.summary.placementAnimationCount,
    quickSlotBackground: output.summary.quickSlotBackground,
    customDefaultBackground: output.summary.customDefaultBackground,
    pngs: output.exportedPngCount,
  }, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  }).finally(() => reader.close());
}

module.exports = { DATA, OUTPUT, ASSETS, SOURCES, main };
