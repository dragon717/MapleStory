#!/usr/bin/env node

/*
 * Export only the TMS273.7 source art needed by the Colossus scene.
 *
 * This script deliberately reads the reference WZ tree and the already
 * generated map assets, then writes only the two independent `originals`
 * directories named below.  It does not touch the shared/server/client
 * implementation or the source/reference checkout.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '..');
const DATA_ROOT_REL = '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data';
const MOB_JSON_ROOT_REL = '参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW/Mob';
const MAPS_RENDERED_REL = 'resources/tms273-export/maps-rendered.json';
const EXPORT_ASSET_ROOT_REL = 'resources/tms273-export/assets/tms273';
const RESOURCE_OUTPUT_REL = 'resources/scenes/colossus/originals';
const PUBLIC_OUTPUT_REL = 'client/public-tms273/assets/colossus/originals';

// The worktree intentionally does not carry a second copy of the WZ reader's
// native dependency.  Prefer a local copy if one is later added, then use the
// read-only source checkout that already provides the dependency.
const referenceLink = path.join(REPO_ROOT, '参考');
const referenceRepository = fs.existsSync(referenceLink) ? path.dirname(fs.realpathSync(referenceLink)) : null;
const NODE_MODULE_CANDIDATES = [
  path.join(__dirname, 'node_modules'),
  referenceRepository ? path.join(referenceRepository, 'scripts', 'node_modules') : null,
  '/Users/muniao/Code/MapleStory/scripts/node_modules',
].filter(Boolean);
const nodeModulePaths = NODE_MODULE_CANDIDATES.filter(candidate => fs.existsSync(candidate));
if (nodeModulePaths.length) {
  process.env.NODE_PATH = [process.env.NODE_PATH, ...nodeModulePaths]
    .filter(Boolean)
    .join(path.delimiter);
  Module._initPaths();
}

const { createReader } = require('./tms273_wz.cjs');

const MONSTERS = [
  { id: '5130101', name: '石巨人', role: 'base stone golem' },
  { id: '5130102', name: '黑曜石巨人', role: 'dark stone golem' },
  { id: '5150000', name: '混種石巨人', role: 'mixed stone golem' },
];

const ACTIONS = [
  { key: 'stand', sourceAction: 'stand' },
  { key: 'move', sourceAction: 'move' },
  { key: 'hit', sourceAction: 'hit1' },
  { key: 'skill1', sourceAction: 'skill1' },
  { key: 'die', sourceAction: 'die1' },
];

function absolute(relativePath) {
  return path.resolve(REPO_ROOT, relativePath);
}

function posixPath(value) {
  return value.split(path.sep).join('/');
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertNoSymlinkAlongPath(target) {
  const resolvedTarget = path.resolve(target);
  if (!isWithin(REPO_ROOT, resolvedTarget)) {
    throw new Error(`输出路径越过工作树: ${resolvedTarget}`);
  }
  let current = resolvedTarget;
  while (true) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`拒绝写入符号链接路径: ${current}`);
    }
    if (current === REPO_ROOT) break;
    const parent = path.dirname(current);
    if (parent === current || !isWithin(REPO_ROOT, parent)) break;
    current = parent;
  }
}

function prepareOutputDirectory(relativePath) {
  const target = absolute(relativePath);
  assertNoSymlinkAlongPath(target);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  return target;
}

function assertFile(relativePath, label) {
  const filePath = absolute(relativePath);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${label}不存在: ${filePath}`);
  }
  return filePath;
}

function decodeTypedWz(value) {
  if (!value || typeof value !== 'object') return value;
  if (Object.prototype.hasOwnProperty.call(value, '_dirType')) {
    if (value._dirType === 'sub') {
      const result = {};
      for (const [key, child] of Object.entries(value)) {
        if (key !== '_dirType') result[key] = decodeTypedWz(child);
      }
      return result;
    }
    if (value._dirType === 'int' || value._dirType === 'float') {
      const number = Number(value._value);
      return Number.isFinite(number) ? number : value._value;
    }
    return value._value;
  }
  if (Array.isArray(value)) return value.map(decodeTypedWz);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, decodeTypedWz(child)]));
}

function readMonsterSourceMetadata(id) {
  const relativePath = `${MOB_JSON_ROOT_REL}/${id}.json`;
  const filePath = assertFile(relativePath, `513 石头人 ${id} 的源元数据`);
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return {
    path: relativePath,
    tree: decodeTypedWz(parsed),
  };
}

function numberSort(a, b) {
  return Number(a) - Number(b);
}

async function exportFrame(reader, source, outputDirectory) {
  const raw = await reader.get(source);
  const resolved = await reader.resolveFrame(raw);
  const frame = await reader.frame(raw, outputDirectory);
  const metadataFallback = [];
  if (!resolved.chain.some(entry => entry.object?.at?.('origin'))) metadataFallback.push('origin');
  if (!resolved.chain.some(entry => entry.object?.at?.('delay'))) metadataFallback.push('delay');
  return { ...frame, metadataFallback };
}

async function numericChildren(reader, actionPath) {
  const action = await reader.get(actionPath);
  if (!action?.wzProperties) throw new Error(`动作节点没有可枚举帧: ${actionPath}`);
  const names = [...action.wzProperties]
    .map(property => String(property.name))
    .filter(name => /^\d+$/.test(name))
    .sort(numberSort);
  if (!names.length) throw new Error(`动作没有数字帧: ${actionPath}`);
  return names;
}

function copyIfNeeded(source, target, copied) {
  if (copied.has(source)) return;
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new Error(`场景原图缺失: ${source}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  copied.add(source);
}

function mergeDefined(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null) continue;
    if (target[key] === undefined || target[key] === null) target[key] = value;
  }
}

function sceneCategory(source) {
  if (source.startsWith('Map/Back/') && /(?:portTown|vicportTown|nautilusPort)\.img\//.test(source)) return 'backgrounds';
  if (source.includes('/ship/')) return 'ships';
  if (source.includes('/dock/')) return 'dockObjects';
  if (/^Map\/Obj\/acc(?:1\.img\/portTown|2\.img\/vicportTown|9\.img\/nautilusPort)\//.test(source)) return 'portObjects';
  return null;
}

function rowPlacement(context, row) {
  const placement = {};
  for (const key of ['mapId', 'name', 'streetName', 'section']) {
    if (context[key] !== undefined && context[key] !== null) placement[key] = context[key];
  }
  for (const key of ['key', 'x', 'y', 'depth', 'flip']) {
    if (row[key] !== undefined && row[key] !== null) placement[key] = row[key];
  }
  return placement;
}

function walkMapRows(value, context, visit) {
  if (Array.isArray(value)) {
    for (const child of value) walkMapRows(child, context, visit);
    return;
  }
  if (!value || typeof value !== 'object') return;

  const nextContext = { ...context };
  for (const key of ['mapId', 'name', 'streetName']) {
    if (nextContext[key] === undefined && value[key] !== undefined) nextContext[key] = value[key];
  }
  if (typeof value.source === 'string' && typeof value.url === 'string') visit(value, nextContext);
  for (const [key, child] of Object.entries(value)) {
    walkMapRows(child, { ...nextContext, section: key }, visit);
  }
}

function collectSceneRows(mapsDocument) {
  const grouped = {
    backgrounds: new Map(),
    ships: new Map(),
    dockObjects: new Map(),
    portObjects: new Map(),
  };

  const add = (row, context) => {
    const category = sceneCategory(row.source);
    if (!category || Number(row.width) <= 1 || Number(row.height) <= 1) return;
    const key = `${row.source}\0${row.url}`;
    let entry = grouped[category].get(key);
    if (!entry) {
      entry = {
        source: row.source,
        originalUrl: row.url,
        fields: {},
        usedIn: [],
        placementKeys: new Set(),
      };
      grouped[category].set(key, entry);
    }
    mergeDefined(entry.fields, row);
    const placement = rowPlacement(context, row);
    const placementKey = JSON.stringify(placement);
    if (!entry.placementKeys.has(placementKey)) {
      entry.placementKeys.add(placementKey);
      entry.usedIn.push(placement);
    }
  };

  for (const map of mapsDocument.maps || []) {
    walkMapRows(map, { mapId: map.id, name: map.name, streetName: map.streetName }, add);
  }
  return grouped;
}

function sourceAssetPath(originalUrl, exportAssetRoot) {
  const prefix = '/assets/tms273/';
  if (!originalUrl.startsWith(prefix)) throw new Error(`未知的已导出资源 URL: ${originalUrl}`);
  const relative = originalUrl.slice(prefix.length);
  const source = path.resolve(exportAssetRoot, ...relative.split('/'));
  if (!isWithin(exportAssetRoot, source)) throw new Error(`场景资源 URL 越过导出根目录: ${originalUrl}`);
  return { source, relative: posixPath(path.relative(REPO_ROOT, source)) };
}

function uniqueSceneFile(category, originalUrl, usedNames) {
  const originalName = path.basename(originalUrl);
  let fileName = originalName;
  const existing = usedNames.get(fileName);
  if (existing && existing !== originalUrl) {
    const extension = path.extname(originalName);
    const stem = originalName.slice(0, -extension.length);
    const suffix = crypto.createHash('sha1').update(originalUrl, 'utf8').digest('hex').slice(0, 10);
    fileName = `${stem}-${suffix}${extension}`;
  }
  usedNames.set(fileName, originalUrl);
  return posixPath(path.join('scene', category, fileName));
}

function sceneAssetEntry(entry, category, outputRoot, exportAssetRoot, copied, usedNames) {
  const sourceAsset = sourceAssetPath(entry.originalUrl, exportAssetRoot);
  const file = uniqueSceneFile(category, entry.originalUrl, usedNames);
  const target = path.join(outputRoot, ...file.split('/'));
  copyIfNeeded(sourceAsset.source, target, copied);

  const result = {
    source: entry.source,
    sourceVersion: 'TMS273.7',
    sourceAsset: sourceAsset.relative,
    originalUrl: entry.originalUrl,
    file,
    url: `/assets/colossus/originals/${file}`,
    usedIn: entry.usedIn,
  };
  for (const key of ['width', 'height', 'origin', 'x', 'y', 'delay', 'map', 'resolvedSource', 'lt', 'rb', 'head', 'alpha', 'a0', 'a1']) {
    if (entry.fields[key] !== undefined && entry.fields[key] !== null) result[key] = entry.fields[key];
  }
  return result;
}

function exportSceneAssets(mapsDocument, outputRoot, exportAssetRoot) {
  const grouped = collectSceneRows(mapsDocument);
  const copied = new Set();
  const result = {};
  for (const category of ['backgrounds', 'ships', 'dockObjects', 'portObjects']) {
    const usedNames = new Map();
    result[category] = [...grouped[category].values()]
      .sort((a, b) => a.source.localeCompare(b.source) || a.originalUrl.localeCompare(b.originalUrl))
      .map(entry => sceneAssetEntry(entry, category, outputRoot, exportAssetRoot, copied, usedNames));
  }
  return result;
}

async function exportMonster(reader, monster, outputRoot) {
  const metadata = readMonsterSourceMetadata(monster.id);
  const monsterTree = metadata.tree;
  const result = {
    id: monster.id,
    templateId: monster.id,
    name: monster.name,
    role: monster.role,
    source: `Mob/${monster.id}.img`,
    sourceVersion: 'TMS273.7',
    sourceMetadata: metadata.path,
    info: monsterTree.info || {},
    missingActions: ['jump'],
    renderAlignment: 'P: bottom-center image bounds; source origin unavailable',
    actions: {},
  };

  for (const definition of ACTIONS) {
    const actionPath = `Mob/${monster.id}.img/${definition.sourceAction}`;
    const frameIndices = await numericChildren(reader, actionPath);
    const actionDirectory = path.join(outputRoot, 'monsters', monster.id, definition.key);
    fs.mkdirSync(actionDirectory, { recursive: true });
    const sourceActionMetadata = monsterTree[definition.sourceAction] || {};
    const action = {
      sourceAction: definition.sourceAction,
      source: actionPath,
      frameCount: frameIndices.length,
      frameIndices: frameIndices.map(Number),
      zigzag: sourceActionMetadata.zigzag ?? null,
      frames: [],
    };

    for (const frameIndex of frameIndices) {
      const frame = await exportFrame(reader, `${actionPath}/${frameIndex}`, actionDirectory);
      if (!frame.url) throw new Error(`动作帧未生成 PNG: ${actionPath}/${frameIndex}`);
      const file = posixPath(path.relative(outputRoot, path.join(actionDirectory, frame.url)));
      action.frames.push({
        index: Number(frameIndex),
        wzIndex: frameIndex,
        ...frame,
        file,
        url: `/assets/colossus/originals/${file}`,
      });
    }
    result.actions[definition.key] = action;
  }
  return result;
}

function copyDirectory(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
    else throw new Error(`输出目录包含不支持的文件类型: ${from}`);
  }
}

function boatComposition(sceneAssets) {
  const hullSource = 'Map/Obj/vehicle.img/ship/mapleIsland/1';
  const sailSource = 'Map/Obj/vehicle.img/ship/mapleIsland/0';
  const mapId = '104000000';
  const findPlacement = source => {
    const asset = sceneAssets.ships.find(item => item.source === source);
    const placement = asset?.usedIn.find(item => item.mapId === mapId);
    if (!placement || !Number.isFinite(Number(placement.x)) || !Number.isFinite(Number(placement.y))) {
      throw new Error(`找不到 ${mapId} 的船层布局: ${source}`);
    }
    return placement;
  };
  const hull = findPlacement(hullSource);
  const sail = findPlacement(sailSource);
  return {
    sourceLayout: mapId,
    baseSource: hullSource,
    overlaySource: sailSource,
    overlayLocalOffset: {
      x: Number(sail.x) - Number(hull.x),
      y: Number(sail.y) - Number(hull.y),
    },
    offsetFormula: 'overlay source layout position minus base source layout position',
    depthOrder: { overlay: sail.depth, base: hull.depth },
  };
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function main() {
  const dataRoot = assertFile(`${DATA_ROOT_REL}/Mob/Mob.wz`, 'TMS273.7 Mob.wz');
  const dataRootPath = path.dirname(path.dirname(dataRoot));
  const mapsRenderedPath = assertFile(MAPS_RENDERED_REL, '现有 maps-rendered.json');
  const exportAssetRoot = absolute(EXPORT_ASSET_ROOT_REL);
  if (!fs.existsSync(exportAssetRoot) || !fs.statSync(exportAssetRoot).isDirectory()) {
    throw new Error(`现有 TMS273 资源导出目录不存在: ${exportAssetRoot}`);
  }

  const resourceOutput = prepareOutputDirectory(RESOURCE_OUTPUT_REL);
  const publicOutput = prepareOutputDirectory(PUBLIC_OUTPUT_REL);
  const mapsDocument = JSON.parse(fs.readFileSync(mapsRenderedPath, 'utf8'));
  const reader = createReader(dataRootPath);

  try {
    const monsters = {};
    for (const monster of MONSTERS) {
      monsters[monster.id] = await exportMonster(reader, monster, resourceOutput);
    }

    const sceneAssets = exportSceneAssets(mapsDocument, resourceOutput, exportAssetRoot);
    const manifest = {
      schemaVersion: 1,
      kind: 'tms273-colossus-originals',
      source: {
        version: 'TMS273.7',
        dataRoot: DATA_ROOT_REL,
        mapsRendered: MAPS_RENDERED_REL,
        originalAssetRoot: EXPORT_ASSET_ROOT_REL,
        reader: 'scripts/tms273_wz.cjs',
        mapContentVersion: mapsDocument.contentVersion || null,
        mapSource: mapsDocument.source || null,
      },
      monsters,
      sceneAssets,
      recommendations: {
        defaultMonsterId: '5130101',
        defaultScale: 1,
        defaultScaleIsOriginal: true,
        reviewStatus: 'visual-reviewed',
        visualInspected: ['5130101/stand/0', '5130102/stand/0', '5150000/stand/0'],
        rationale: '5130101 是中性浅色石巨人，适合作为默认基准；5130102 是深色变体，5150000 是双色混种变体。三者均按原始像素尺寸导出，运行时缩放需由渲染层显式标记。',
        boatComposition: boatComposition(sceneAssets),
      },
    };

    writeJson(path.join(resourceOutput, 'manifest.json'), manifest);
    copyDirectory(resourceOutput, publicOutput);

    const counts = {
      monsters: Object.keys(monsters).length,
      monsterFrames: Object.values(monsters).reduce((sum, monster) => sum + Object.values(monster.actions).reduce((inner, action) => inner + action.frames.length, 0), 0),
      backgrounds: manifest.sceneAssets.backgrounds.length,
      ships: manifest.sceneAssets.ships.length,
      dockObjects: manifest.sceneAssets.dockObjects.length,
      portObjects: manifest.sceneAssets.portObjects.length,
    };
    console.log(JSON.stringify({ resourceOutput: RESOURCE_OUTPUT_REL, publicOutput: PUBLIC_OUTPUT_REL, counts }, null, 2));
  } finally {
    reader.close();
  }
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
