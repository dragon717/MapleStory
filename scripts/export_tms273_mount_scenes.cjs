#!/usr/bin/env node

// Export source-backed mount/chair scenes and chair icons for TMS273.7.
//
// This file deliberately keeps the WZ facts visible in the output: Canvas
// source/resolved paths, origin/map anchors, source z names and the chair
// effect pos/z/body metadata are all retained.  The client can therefore
// align a ride by the authored navel/brow without a hand-tuned pixel table.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const wz = require('@tybys/wz');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const WZ_JSON = path.join(ROOT, '参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW');
const OUTPUT = path.join(ROOT, 'resources/tms273-export');
const ASSETS = path.join(OUTPUT, 'assets/tms273');
const SCENE_ASSETS = path.join(ASSETS, 'ride-scenes');
const ICON_ASSETS = path.join(ASSETS, 'chairs');
const MOUNT_CATALOG = path.join(ROOT, 'shared/mounts.json');
const CHAIR_CATALOG = path.join(ROOT, 'shared/chairs.json');

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const children = node => [...(resolveUol(node)?.wzProperties || [])];
const numeric = node => children(node).filter(child => /^\d+$/.test(child.name)).sort((a, b) => Number(a.name) - Number(b.name));
const numericName = value => /^\d+$/.test(String(value));
const mirrorOf = id => String(id).padStart(8, '0');
const finite = value => Number.isFinite(Number(value));
const point = value => value && finite(value.x) && finite(value.y) ? { x: Number(value.x), y: Number(value.y) } : null;

function primitive(node, name) {
  const property = node?.at?.(name) || resolveUol(node)?.at?.(name);
  if (!property) return undefined;
  const value = property.wzValue ?? property.value;
  if (value && typeof value === 'object' && !Array.isArray(value)) return undefined;
  return value;
}

function vector(node, name) {
  const property = name ? (node?.at?.(name) || resolveUol(node)?.at?.(name)) : node;
  return point(property?.wzValue ?? property?.value);
}

function resolveUol(node) {
  const seen = new Set();
  let current = node;
  while (current instanceof wz.WzUOLProperty) {
    if (seen.has(current)) throw new Error(`UOL cycle at ${node?.name || '<unnamed>'}`);
    seen.add(current);
    current = current.linkValue;
  }
  return current;
}

function valueThroughUol(node, name) {
  const direct = primitive(node, name);
  if (direct !== undefined) return direct;
  const target = resolveUol(node);
  return target === node ? undefined : primitive(target, name);
}

function zNameOf(node) {
  const direct = valueThroughUol(node, 'z');
  return direct === undefined || direct === null ? undefined : String(direct);
}

function isDrawable(node) {
  try {
    const resolved = resolveUol(node);
    return resolved instanceof wz.WzCanvasProperty;
  } catch {
    return false;
  }
}

function isSubtree(node) {
  return Boolean(resolveUol(node)?.wzProperties);
}

function legalChairSource(source) {
  return /^Item\/Install\/(?:0301\d*|0302)\//.test(source);
}

function sourceGroup(source) {
  return String(source).split('/')[2] || '';
}

function readRawInfo(file) {
  try {
    return readJson(file).info || {};
  } catch {
    return {};
  }
}

function rawValue(node, name) {
  const value = node?.[name];
  if (value === undefined || value === null) return undefined;
  if (value && typeof value === 'object' && '_value' in value) return value._value;
  return value;
}

function collectChairDescriptors() {
  const catalog = readJson(CHAIR_CATALOG).items || {};
  const descriptors = new Map();
  for (const [id, item] of Object.entries(catalog)) {
    descriptors.set(String(id), { id: String(id), source: item.source, spriteSource: item.spriteSource });
  }

  // The catalogue is intentionally gameplay-oriented and older snapshots
  // omitted info-only 03015159/03015161.  The source directory is the final
  // authority for the legal 0301*/0302 chair families, so include every raw
  // source file as well.
  const install = path.join(WZ_JSON, 'Item/Install');
  for (const group of fs.readdirSync(install).sort()) {
    if (!/^0301\d*|^0302$/.test(group)) continue;
    const dir = path.join(install, group);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir).filter(name => /^\d+\.json$/.test(name)).sort()) {
      const id = String(Number(path.basename(file, '.json')));
      if (descriptors.has(id)) continue;
      const mirror = path.basename(file, '.json');
      descriptors.set(id, {
        id,
        source: `Item/Install/${group}/${file}`,
        spriteSource: `Item/Install/${group}.img/${mirror}/info/icon`,
      });
    }
  }
  return [...descriptors.values()].sort((a, b) => Number(a.id) - Number(b.id));
}

function addAnchors(anchors, frame, part) {
  for (const [name, local] of Object.entries(frame.map || {})) {
    const p = point(local);
    if (!p || anchors[name]) continue;
    // WZ `map` points are relative to the Canvas origin.  `frame.x/y` is
    // already the negative origin used for drawing, so restore the origin
    // before projecting the authored anchor into actor coordinates.
    anchors[name] = {
      x: part.x + part.origin.x + p.x,
      y: part.y + part.origin.y + p.y,
    };
  }
}

function normalizedUrl(dir, frame, prefix) {
  assert(frame?.url, 'reader.frame returned no PNG URL');
  return `${prefix}/${frame.url}`.replaceAll('//', '/');
}

function sourceLeafName(source) {
  const parts = String(source).split('/');
  return parts.at(-1) || 'part';
}

function frameDelay(frameNode, rootNode, count) {
  const own = primitive(frameNode, 'delay');
  const root = primitive(rootNode, 'delay');
  if (own !== undefined && finite(own)) return Math.max(0, Number(own));
  if (root !== undefined && finite(root)) return Math.max(0, Number(root));
  return count === 1 ? 0 : 100;
}

function delaySource(frameNode, rootNode, count) {
  if (primitive(frameNode, 'delay') !== undefined) return 'source-frame';
  if (primitive(rootNode, 'delay') !== undefined) return 'source-root';
  return count === 1 ? 'missing-static' : 'reader-default-100';
}

function framePartSources(node, baseSource) {
  if (isDrawable(node)) return [{ node, source: baseSource }];
  const output = [];
  for (const child of children(node)) {
    const childSource = `${baseSource}/${child.name}`;
    if (isDrawable(child)) output.push({ node: child, source: childSource });
    else if (isSubtree(child)) {
      // Some mount frames have one extra named grouping around their Canvas
      // leaves.  Recurse, but never descend into scalar/vector map nodes.
      const nested = children(child).some(grandchild => isDrawable(grandchild) || isSubtree(grandchild));
      if (nested) output.push(...framePartSources(child, childSource));
    }
  }
  return output;
}

function actionCandidates(root) {
  return children(root)
    .filter(node => node.name !== 'info' && isSubtree(node))
    .filter(node => numeric(node).some(frame => framePartSources(frame, `${root.__source}/${node.name}/${frame.name}`).length))
    .map(node => node.name);
}

function variantCandidates(root) {
  return children(root)
    .filter(node => numericName(node.name) && isSubtree(node))
    .filter(node => {
      node.__source = `${root.__source}/${node.name}`;
      return actionCandidates(node).length;
    })
    .map(node => ({ name: node.name, key: String(Number(node.name)) }));
}

async function readNode(reader, source) {
  const node = await reader.get(source);
  if (node instanceof wz.WzImage) await node.parseImage();
  return node;
}

async function loadZmap(reader) {
  const root = await readNode(reader, 'Base/zmap.img');
  const result = new Map();
  for (const [index, child] of children(root).entries()) result.set(child.name, index);
  return result;
}

async function makePart(reader, source, zmap, fallbackZ, diagnostics) {
  const frame = await reader.frame(source, SCENE_ASSETS);
  const raw = await reader.get(source);
  const zName = zNameOf(raw);
  const z = zName !== undefined && zmap.has(zName) ? zmap.get(zName) : fallbackZ;
  const part = {
    key: sourceLeafName(source),
    url: normalizedUrl(SCENE_ASSETS, frame, '/assets/tms273/ride-scenes'),
    x: Number(frame.x), y: Number(frame.y), z: Number(z),
    width: Number(frame.width), height: Number(frame.height), origin: frame.origin,
    map: frame.map || {}, source: frame.source, resolvedSource: frame.resolvedSource,
  };
  for (const key of ['alpha', 'a0', 'a1']) {
    if (frame[key] !== undefined && frame[key] !== null) part[key] = Number(frame[key]);
  }
  if (zName !== undefined) part.zName = zName;
  if (zName !== undefined && !zmap.has(zName)) {
    diagnostics.push({ kind: 'unknown-z', source, zName, fallback: fallbackZ });
  }
  return { frame, part };
}

async function makeFrame(reader, frameNode, frameSource, frameIndex, rootNode, zmap, fallbackZ, diagnostics) {
  const partSources = framePartSources(frameNode, frameSource);
  const built = [];
  const anchors = {};
  for (const { source } of partSources) {
    try {
      const result = await makePart(reader, source, zmap, fallbackZ, diagnostics);
      built.push(result);
    } catch (error) {
      diagnostics.push({ kind: 'missing-pixel', source, reason: String(error.message || error).slice(0, 240) });
    }
  }
  // A mount frame can contain several Canvas layers.  Their map.navel values
  // are authored attachment points, not already-composed screen positions.
  // Keep the first navel-bearing layer as the frame's anchor owner and place
  // every other navel-bearing layer against that same target, exactly like
  // the avatar compositor places body/head/equipment layers.
  const owner = built.find(entry => point(entry.frame.map?.navel));
  if (owner) {
    const ownerMap = point(owner.frame.map.navel);
    const target = {
      x: owner.part.x + owner.part.origin.x + ownerMap.x,
      y: owner.part.y + owner.part.origin.y + ownerMap.y,
    };
    for (const entry of built) {
      const map = point(entry.frame.map?.navel);
      if (!map) continue;
      entry.part.x = target.x - entry.part.origin.x - map.x;
      entry.part.y = target.y - entry.part.origin.y - map.y;
    }
  }
  const parts = built.map(entry => entry.part);
  for (const entry of built) addAnchors(anchors, entry.frame, entry.part);
  if (!parts.length) return null;
  const count = numeric(rootNode).length;
  const frameResult = {
    index: Number.isFinite(Number(frameIndex)) ? Number(frameIndex) : frameIndex,
    delay: frameDelay(frameNode, rootNode, count),
    delaySource: delaySource(frameNode, rootNode, count),
    parts,
  };
  if (Object.keys(anchors).length) frameResult.anchors = anchors;
  for (const key of ['action', 'characterAction', 'forceCharacterAction']) {
    const value = primitive(frameNode, key);
    if (typeof value === 'string' && value.length) { frameResult.action = value; break; }
  }
  const forcedIndex = primitive(frameNode, 'forceCharacterActionFrameIndex');
  if (forcedIndex !== undefined && finite(forcedIndex)) frameResult.forceCharacterActionFrameIndex = Number(forcedIndex);
  return frameResult;
}

async function buildActions(reader, root, source, zmap, diagnostics) {
  root.__source = source;
  const result = {};
  for (const action of actionCandidates(root)) {
    const actionNode = root.at(action);
    const frameNodes = numeric(actionNode);
    const frames = [];
    for (const frameNode of frameNodes) {
      const frame = await makeFrame(reader, frameNode, `${source}/${action}/${frameNode.name}`, frameNode.name, actionNode, zmap, 0, diagnostics);
      if (frame) frames.push(frame);
    }
    if (frames.length) result[action] = frames;
  }
  return result;
}

async function buildMount(reader, descriptor, zmap) {
  const mirror = mirrorOf(descriptor.id);
  const source = `Character/TamingMob/${mirror}.img`;
  const diagnostics = [];
  const root = await readNode(reader, source);
  root.__source = source;
  const scene = {
    schemaVersion: 1, kind: 'mount-scene', itemId: descriptor.id, source,
    actions: await buildActions(reader, root, source, zmap, diagnostics),
  };
  const variants = {};
  for (const variantEntry of variantCandidates(root)) {
    const variant = variantEntry.name;
    const variantNode = root.at(variant);
    const variantSource = `${source}/${variant}`;
    variantNode.__source = variantSource;
    const actions = await buildActions(reader, variantNode, variantSource, zmap, diagnostics);
    if (Object.keys(actions).length) variants[variantEntry.key] = { source: variantSource, actions };
  }
  if (Object.keys(variants).length) scene.variants = variants;
  const info = root.at('info');
  for (const key of ['forceCharacterAction', 'characterAction', 'sitAction', 'flip', 'forceCharacterFlip', 'forceFaceHide']) {
    const value = primitive(info, key);
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && !value.length) continue;
    scene[key] = finite(value) ? Number(value) : value;
  }
  const forcedIndex = primitive(info, 'forceCharacterActionFrameIndex');
  if (forcedIndex !== undefined && finite(forcedIndex)) scene.forceCharacterActionFrameIndex = Number(forcedIndex);
  const removeBody = primitive(info, 'removeBody');
  if (removeBody !== undefined && removeBody !== null) {
    scene.removeBody = finite(removeBody) ? Number(removeBody) : removeBody;
    scene.hideBody = finite(removeBody) ? Number(removeBody) !== 0 : Boolean(removeBody);
  }
  scene.status = Object.keys(scene.actions).length || Object.keys(variants).length ? (diagnostics.length ? 'partial' : 'exported') : 'missing';
  if (diagnostics.length) scene.diagnostics = diagnostics;
  return scene;
}

function infoTamingMob(infoNode) {
  const property = infoNode?.at?.('tamingMob');
  if (!property) return [];
  const direct = property.wzValue ?? property.value;
  if (finite(direct)) return [Number(direct)];
  return children(property).filter(child => numericName(child.name) && finite(child.wzValue ?? child.value)).map(child => Number(child.wzValue ?? child.value));
}

function effectRoots(root) {
  return children(root).filter(node => /^effect\d*$/.test(node.name) && isSubtree(node));
}

async function buildEffect(reader, effectRoot, source, zmap, diagnostics) {
  const frameNodes = numeric(effectRoot);
  const frames = [];
  for (const frameNode of frameNodes) {
    const frame = await makeFrame(reader, frameNode, `${source}/${frameNode.name}`, frameNode.name, effectRoot, zmap, 0, diagnostics);
    if (frame) frames.push(frame);
  }
  if (!frames.length) return null;
  const zValue = primitive(effectRoot, 'z');
  const posValue = primitive(effectRoot, 'pos');
  const effect = {
    frames,
    z: finite(zValue) ? Number(zValue) : 0,
    pos: finite(posValue) ? Number(posValue) : 0,
    source,
  };
  if (zValue === undefined) effect.zSource = 'missing-default-zero';
  if (posValue === undefined) effect.posSource = 'missing-default-zero';
  for (const key of ['fixed', 'repeat', 'delay', 'bodyRelMove']) {
    const value = key === 'bodyRelMove' ? vector(effectRoot, key) : primitive(effectRoot, key);
    if (value !== undefined && value !== null) effect[key] = value;
  }
  return effect;
}

async function buildChair(reader, descriptor, zmap) {
  const group = sourceGroup(descriptor.source);
  const mirror = mirrorOf(descriptor.id);
  const source = `Item/Install/${group}.img/${mirror}`;
  const diagnostics = [];
  const scene = { schemaVersion: 1, kind: 'chair-scene', itemId: descriptor.id, source, actions: {}, effects: [] };
  let root;
  try {
    root = await readNode(reader, source);
  } catch (error) {
    scene.status = 'missing';
    scene.reason = String(error.message || error).slice(0, 240);
    return scene;
  }
  const info = root.at('info');
  const tamingMobs = infoTamingMob(info);
  if (tamingMobs.length) {
    scene.tamingMob = tamingMobs[0];
    if (tamingMobs.length > 1) scene.tamingMobVariants = tamingMobs;
    const mobScenes = [];
    for (const mob of tamingMobs) {
      const mobSource = `Character/TamingMob/${mirrorOf(mob)}.img`;
      try {
        const mobRoot = await readNode(reader, mobSource);
        const actions = await buildActions(reader, mobRoot, mobSource, zmap, diagnostics);
        if (Object.keys(actions).length) mobScenes.push({ source: mobSource, actions });
      } catch (error) {
        diagnostics.push({ kind: 'missing-tamingMob', tamingMob: mob, source: mobSource, reason: String(error.message || error).slice(0, 240) });
      }
    }
    if (mobScenes.length) {
      scene.actions = mobScenes[0].actions;
      if (mobScenes.length > 1) scene.actionVariants = Object.fromEntries(mobScenes.map((entry, index) => [String(tamingMobs[index]), entry.actions]));
      scene.tamingMobSources = mobScenes.map(entry => entry.source);
    }
  }
  const bodyRelMove = vector(info, 'bodyRelMove');
  if (bodyRelMove) scene.bodyRelMove = bodyRelMove;
  const sitAction = primitive(info, 'sitAction');
  if (typeof sitAction === 'string' && sitAction.length) scene.sitAction = sitAction;
  const removeBody = primitive(info, 'removeBody');
  if (removeBody !== undefined) { scene.removeBody = Number(removeBody); scene.hideBody = Number(removeBody) !== 0; }
  for (const key of ['forceCharacterAction', 'characterAction']) {
    const value = primitive(info, key);
    if (typeof value === 'string' && value.length) scene[key] = value;
  }
  for (const effectRoot of effectRoots(root)) {
    const effect = await buildEffect(reader, effectRoot, `${source}/${effectRoot.name}`, zmap, diagnostics);
    if (effect) scene.effects.push(effect);
  }
  if (!scene.effects.length && !Object.keys(scene.actions).length) {
    scene.status = 'missing';
    scene.reason = legalChairSource(descriptor.source) ? 'chair source has no drawable effect or tamingMob action' : 'catalog item is not a 0301*/0302 chair source';
  } else scene.status = diagnostics.length ? 'partial' : 'exported';
  if (diagnostics.length) scene.diagnostics = diagnostics;
  return scene;
}

async function exportIcon(reader, descriptor, images, ledger) {
  try {
    const frame = await reader.frame(descriptor.spriteSource, ICON_ASSETS);
    images[descriptor.id] = {
      ...frame,
      url: normalizedUrl(ICON_ASSETS, frame, '/assets/tms273/chairs'),
    };
    ledger.items[descriptor.id] = { status: 'exported', source: descriptor.spriteSource, url: images[descriptor.id].url };
  } catch (error) {
    ledger.items[descriptor.id] = { status: 'missing', source: descriptor.spriteSource, reason: String(error.message || error).slice(0, 240) };
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function indexEntry(scene, url, descriptor) {
  const entry = { source: descriptor.source, status: scene.status };
  if (scene.status === 'missing') entry.reason = scene.reason || 'no drawable source';
  else entry.url = url;
  return entry;
}

async function main() {
  const cliArgs = process.argv.slice(2);
  const mountsOnly = cliArgs.includes('--mounts-only');
  const chairsOnly = cliArgs.includes('--chairs-only');
  assert(!(mountsOnly && chairsOnly), 'choose at most one of --mounts-only/--chairs-only');
  const selected = cliArgs.filter(arg => /^\d+$/.test(arg)).map(String);
  const mountCatalog = readJson(MOUNT_CATALOG).items || {};
  const chairDescriptors = collectChairDescriptors();
  const mountDescriptors = Object.keys(mountCatalog).sort((a, b) => Number(a) - Number(b)).map(id => ({ id, source: mountCatalog[id].source }));
  const reader = createReader(DATA);
  fs.mkdirSync(SCENE_ASSETS, { recursive: true });
  fs.mkdirSync(ICON_ASSETS, { recursive: true });
  const zmap = await loadZmap(reader);
  assert(zmap.size > 100, `Base/zmap.img unexpectedly small: ${zmap.size}`);
  const previousIndex = fs.existsSync(path.join(OUTPUT, 'ride-scenes.json')) ? readJson(path.join(OUTPUT, 'ride-scenes.json')) : null;
  const previousIcons = fs.existsSync(path.join(OUTPUT, 'chair-images.json')) ? readJson(path.join(OUTPUT, 'chair-images.json')) : {};
  const previousLedger = fs.existsSync(path.join(OUTPUT, 'chair-images-missing.json')) ? readJson(path.join(OUTPUT, 'chair-images-missing.json')) : null;
  const index = {
    schemaVersion: 1, contentVersion: 'tms273-32', sourceVersion: 'TMS273.7',
    mounts: mountsOnly ? {} : (chairsOnly ? (previousIndex?.mounts || {}) : {}),
    chairs: chairsOnly ? {} : (mountsOnly ? (previousIndex?.chairs || {}) : {}),
  };
  const icons = mountsOnly ? previousIcons : {};
  const iconLedger = mountsOnly
    ? (previousLedger || { schemaVersion: 1, sourceVersion: 'TMS273.7', items: {}, counts: {} })
    : { schemaVersion: 1, sourceVersion: 'TMS273.7', items: {}, counts: {} };
  try {
    if (!chairsOnly) for (const descriptor of mountDescriptors) {
      if (selected.length && !selected.includes(descriptor.id)) continue;
      const sceneUrl = `/assets/tms273/ride-scenes/mounts/${descriptor.id}.json`;
      try {
        const scene = await buildMount(reader, descriptor, zmap);
        writeJson(path.join(SCENE_ASSETS, 'mounts', `${descriptor.id}.json`), scene);
        index.mounts[descriptor.id] = indexEntry(scene, sceneUrl, descriptor);
      } catch (error) {
        index.mounts[descriptor.id] = { source: descriptor.source, status: 'missing', reason: String(error.message || error).slice(0, 240) };
      }
    }
    if (!mountsOnly) for (const descriptor of chairDescriptors) {
      if (selected.length && !selected.includes(descriptor.id)) continue;
      await exportIcon(reader, descriptor, icons, iconLedger);
      const sceneUrl = `/assets/tms273/ride-scenes/chairs/${descriptor.id}.json`;
      try {
        const scene = await buildChair(reader, descriptor, zmap);
        writeJson(path.join(SCENE_ASSETS, 'chairs', `${descriptor.id}.json`), scene);
        index.chairs[descriptor.id] = indexEntry(scene, sceneUrl, descriptor);
      } catch (error) {
        index.chairs[descriptor.id] = { source: descriptor.source, status: 'missing', reason: String(error.message || error).slice(0, 240) };
      }
    }
  } finally {
    reader.close();
  }
  iconLedger.counts = {
    total: Object.keys(iconLedger.items).length,
    exported: Object.values(iconLedger.items).filter(item => item.status === 'exported').length,
    missing: Object.values(iconLedger.items).filter(item => item.status === 'missing').length,
  };
  const mountIndex = Object.keys(index.mounts).length;
  const chairIndex = Object.keys(index.chairs).length;
  index.counts = {
    mounts: mountIndex,
    chairs: chairIndex,
    mountExported: Object.values(index.mounts).filter(item => item.url).length,
    mountMissing: Object.values(index.mounts).filter(item => !item.url).length,
    chairExported: Object.values(index.chairs).filter(item => item.url).length,
    chairMissing: Object.values(index.chairs).filter(item => !item.url).length,
    chairLegal: chairDescriptors.filter(item => legalChairSource(item.source)).length,
  };
  writeJson(path.join(OUTPUT, 'ride-scenes.json'), index);
  writeJson(path.join(OUTPUT, 'chair-images.json'), icons);
  writeJson(path.join(OUTPUT, 'chair-images-missing.json'), iconLedger);
  console.log(JSON.stringify({
    output: ['ride-scenes.json', 'chair-images.json', 'chair-images-missing.json'],
    zmap: zmap.size,
    counts: index.counts,
    icons: iconLedger.counts,
  }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
