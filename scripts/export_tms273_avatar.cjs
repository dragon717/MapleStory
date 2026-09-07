#!/usr/bin/env node

// Export one source-backed TMS273 paper-doll.  The image positions are
// calculated from the named map anchors in each Canvas; no v83 pixel offsets
// or animation timings are carried into this manifest.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const wz = require('@tybys/wz');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const OUTPUT = path.join(ROOT, 'resources/tms273-export');
const ASSETS = path.join(OUTPUT, 'assets/tms273');

const BODY = 'Character/00002000.img';
const HEAD = 'Character/00012000.img';
const FACE = 'Character/Face/00020000.img';
const HAIR = 'Character/Hair/00030020.img';
const PANTS = 'Character/Pants/01060003.img';
const SHOES = 'Character/Shoes/01070000.img';
// The server's starter equipment is item 1302000, so the default paper-doll
// and its attack source must use the matching 273 long-sword image.
const STARTER_WEAPON = 'Character/Weapon/01302000.img';

const ACTIONS = [
  ['stand', 'stand1'],
  ['walk', 'walk1'],
  ['jump', 'jump'],
  ['attack', 'swingO1'],
  ['ladder', 'ladder'],
  ['rope', 'rope'],
];

// These are the four item ids accepted by PlayerView.  The twelve keys below
// are the non-conflicting combinations already exposed by the client: a
// longcoat occupies both the coat and pants slots, so coat+longcoat is not a
// valid loadout.
const SUPPORT = new Map([
  ['1002067', { part: 'cap', image: 'Character/Cap/01002067.img' }],
  ['1040002', { part: 'coat', image: 'Character/Coat/01040002.img' }],
  ['1052095', { part: 'coat', image: 'Character/Longcoat/01052095.img', longcoat: true }],
  ['1302000', { part: 'weapon', image: 'Character/Weapon/01302000.img' }],
]);

const LOADOUT_IDS = [
  ['1002067'], ['1040002'], ['1052095'], ['1302000'], [],
  ['1002067', '1040002'], ['1002067', '1052095'], ['1002067', '1302000'],
  ['1040002', '1302000'], ['1002067', '1040002', '1302000'],
  ['1052095', '1302000'], ['1002067', '1052095', '1302000'],
];

const reader = createReader(DATA);
const zmap = new Map();
const smap = new Map();
const frameCache = new Map();

function children(node) {
  return [...(node?.wzProperties || [])];
}

function numeric(node) {
  return children(node)
    .filter(child => /^\d+$/.test(child.name))
    .sort((a, b) => Number(a.name) - Number(b.name));
}

function value(node, name, fallback = undefined) {
  const result = node?.at?.(name)?.wzValue;
  return result === undefined || result === null ? fallback : result;
}

function primitive(node, name, fallback = undefined) {
  const result = value(node, name, fallback);
  return ['string', 'number', 'boolean'].includes(typeof result) || typeof result === 'bigint'
    ? result
    : fallback;
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

function isCanvas(node) {
  try {
    return resolved(node) instanceof wz.WzCanvasProperty;
  } catch {
    return false;
  }
}

function slashPath(...parts) {
  return parts.filter(Boolean).join('/');
}

function relativeUol(node) {
  const link = node instanceof wz.WzUOLProperty ? node.value : undefined;
  return typeof link === 'string' && link.length ? link : undefined;
}

function layerName(source, imageSource, action, frameIndex) {
  const prefix = `${imageSource}/${action}/${frameIndex}/`;
  return source.startsWith(prefix) ? source.slice(prefix.length).split('/')[0] : source.split('/').at(-1);
}

function layerZName(node, fallbackName) {
  const direct = primitive(node, 'z');
  if (typeof direct === 'string' && direct.length) return direct;
  const target = resolved(node);
  const inherited = primitive(target, 'z');
  if (typeof inherited === 'string' && inherited.length) return inherited;
  return fallbackName;
}

// WZ animation subtrees contain both drawable leaves and metadata (delay,
// face, map, ...).  UOL leaves are retained as their original source so the
// common ResourceReader resolves their relative link and outlink correctly.
function drawableLeaves(node, source, result = []) {
  if (isCanvas(node)) {
    result.push({ node, source });
    return result;
  }
  let next = children(node);
  // hairShade is a color/variant container in Character.wz.  A paper-doll
  // frame uses its authored default variant (0); exporting every color
  // variant would draw the same layer repeatedly.
  if (node?.name === 'hairShade') {
    const variants = next.filter(child => /^\d+$/.test(child.name));
    next = variants.find(child => child.name === '0') ? [variants.find(child => child.name === '0')] : variants.slice(0, 1);
  }
  for (const child of next) {
    if (['origin', 'map', 'z', 'group', '_outlink', '_inlink', 'delay', 'face'].includes(child.name)) continue;
    drawableLeaves(child, `${source}/${child.name}`, result);
  }
  return result;
}

async function sourceFrame(source) {
  if (!frameCache.has(source)) {
    const frame = await reader.frame(source, ASSETS);
    assert(frame.width > 0 && frame.height > 0, `invalid Canvas: ${source}`);
    assert(frame.url, `Canvas was not written: ${source}`);
    frameCache.set(source, {
      ...frame,
      url: `/assets/tms273/${frame.url}`,
    });
  }
  return frameCache.get(source);
}

async function sourceInfo(image, source) {
  const imageNode = await get(image);
  const info = imageNode?.at?.('info');
  return {
    source: `${image}/info`,
    islot: primitive(info, 'islot', ''),
    vslot: primitive(info, 'vslot', ''),
  };
}

function tokens(valueString) {
  if (typeof valueString !== 'string') return [];
  // Longest forms first.  vslot strings are compact (for example CpH1H5),
  // while smap values are concatenated slot codes (for example MaGw).
  const pattern = /H[1-6]|Hs|Hf|Hb|Af|Ay|As|Ae|Cp|Hd|Ma|Pn|So|Si|Wp|Gw|Gl|Bd|Fc|Sr|Wg|Cc|Am|At|Ri|Tm|Sd/g;
  return valueString.match(pattern) || [];
}

function hidesBaseLayer(zName, itemInfos) {
  const required = tokens(smap.get(zName));
  if (!required.length) return undefined;
  for (const item of itemInfos) {
    const slots = new Set(tokens(item.vslot));
    const overlap = required.find(slot => slots.has(slot));
    if (overlap) return { item, overlap, required: required.join(''), vslot: item.vslot };
  }
  return undefined;
}

function anchorPoint(frame, anchor) {
  const point = frame.map?.[anchor];
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined;
  return {
    x: frame.x + frame.origin.x + point.x,
    y: frame.y + frame.origin.y + point.y,
  };
}

function preferredAnchors(candidate) {
  if (candidate.part === 'head') return ['neck'];
  if (candidate.part === 'face' || candidate.part === 'hair' || candidate.part === 'cap') return ['brow'];
  if (candidate.part === 'weapon') return ['hand', 'navel'];
  if (candidate.part === 'body' && candidate.layerName === 'body') return ['navel', 'neck'];
  return ['navel', 'hand', 'neck', 'brow'];
}

function targetFor(anchor, anchors) {
  return anchors[anchor];
}

function compose(candidate, anchors) {
  const available = candidate.frame.map || {};
  const anchor = preferredAnchors(candidate).find(name => available[name] && targetFor(name, anchors));
  if (!anchor) {
    return { ...candidate.frame, key: candidate.frame.url, part: candidate.part, name: candidate.layerName,
      zName: candidate.zName, z: zmap.get(candidate.zName), anchor: undefined,
      itemId: candidate.itemId };
  }
  const mapPoint = available[anchor];
  const target = targetFor(anchor, anchors);
  const result = {
    ...candidate.frame,
    key: candidate.frame.url,
    part: candidate.part,
    name: candidate.layerName,
    zName: candidate.zName,
    z: zmap.get(candidate.zName),
    anchor,
    itemId: candidate.itemId,
    x: target.x - candidate.frame.origin.x - mapPoint.x,
    y: target.y - candidate.frame.origin.y - mapPoint.y,
  };
  const uol = relativeUol(candidate.node);
  if (uol) result.uol = uol;
  return result;
}

function finalAnchor(part, anchor) {
  const point = part.map?.[anchor];
  return point && Number.isFinite(point.x) && Number.isFinite(point.y)
    ? { x: part.x + part.origin.x + point.x, y: part.y + part.origin.y + point.y }
    : undefined;
}

async function leavesFor(image, part, action, frameIndex, owner, include = undefined) {
  const source = `${image}/${action}/${frameIndex}`;
  let frameNode;
  try {
    frameNode = resolved(await get(source));
  } catch (error) {
    // Some equipment has no ladder/rope or has a deliberately omitted layer.
    // The body action remains authoritative; only the missing equipment layer
    // is skipped.
    if (error.message.includes('找不到 273 WZ 节点')) return [];
    throw error;
  }
  const leaves = drawableLeaves(frameNode, source).filter(({ source: leafSource }) => {
    if (!include) return true;
    const name = layerName(leafSource, image, action, frameIndex);
    return include.includes(name);
  });
  const result = [];
  for (const leaf of leaves) {
    const name = layerName(leaf.source, image, action, frameIndex);
    const frame = await sourceFrame(leaf.source);
    const zName = layerZName(leaf.node, name);
    assert(zmap.has(zName), `273 zmap missing layer ${zName} from ${leaf.source}`);
    result.push({ node: leaf.node, source: leaf.source, frame, part, layerName: name, owner, zName });
  }
  return result;
}

async function staticFace() {
  const source = `${FACE}/default/face`;
  const node = await get(source);
  assert(isCanvas(node), `face is not a Canvas: ${source}`);
  const frame = await sourceFrame(source);
  const zName = layerZName(node, 'face');
  assert(zmap.has(zName), `273 zmap missing layer ${zName}`);
  return { node, source, frame, part: 'face', layerName: 'face', owner: 'face', zName };
}

async function itemCandidates(itemIds, starter) {
  const result = [];
  const selected = starter
    ? [
      { itemId: 'starter-cap', part: 'cap', image: 'Character/Cap/01000001.img' },
      { itemId: 'starter-coat', part: 'coat', image: 'Character/Coat/01040002.img' },
      { itemId: 'starter-weapon', part: 'weapon', image: STARTER_WEAPON },
    ]
    : itemIds.map(id => ({ itemId: id, ...SUPPORT.get(id) }));
  for (const item of selected) {
    const info = await sourceInfo(item.image, item.image);
    result.push({ ...item, ...info });
  }
  return result;
}

async function buildAction(action, sourceAction, frameNode, selected, starter) {
  const frameIndex = frameNode.name;
  const faceVisible = Number(value(frameNode, 'face', 1)) !== 0;
  const selectedInfos = await itemCandidates(selected, starter);
  const candidates = [];
  const rejected = [];

  async function add(image, part, owner, include, itemId = undefined, base = false) {
    const leaves = await leavesFor(image, part, sourceAction, frameIndex, owner, include);
    for (const leaf of leaves) {
      if (base) {
        const hidden = hidesBaseLayer(leaf.zName, selectedInfos);
        if (hidden) {
          rejected.push({
            part,
            name: leaf.layerName,
            source: leaf.source,
            resolvedSource: leaf.frame.resolvedSource,
            zName: leaf.zName,
            slotCode: hidden.overlap,
            vslot: hidden.vslot,
            itemId: hidden.item.itemId,
            rule: `Base/smap.img/${leaf.zName}=${smap.get(leaf.zName)}; ${hidden.item.source} vslot contains ${hidden.overlap}`,
          });
          continue;
        }
      }
      candidates.push({ ...leaf, itemId });
    }
  }

  // First collect body and head so their authored neck/navel/brow/hand
  // anchors become the targets for every equipment Canvas.
  await add(BODY, 'body', 'body', ['body', 'arm', 'lHand', 'rHand'], undefined, true);
  await add(HEAD, 'head', 'head', ['head'], undefined, true);
  await add(HAIR, 'hair', 'hair', undefined, undefined, true);
  if (faceVisible) {
    const face = await staticFace();
    candidates.push(face);
  }

  // Longcoat's MaPn vslot replaces the base pants slot.  The same rule is
  // expressed in source data, and kept here only to avoid loading an
  // impossible duplicate appearance when this loadout is selected.
  const longcoat = selectedInfos.some(item => item.longcoat);
  if (!longcoat) await add(PANTS, 'pants', 'pants', undefined, undefined, true);
  await add(SHOES, 'shoes', 'shoes', undefined, undefined, true);

  for (const item of selectedInfos) {
    await add(item.image, item.part, item.itemId, undefined, item.itemId, false);
  }

  const bodyPart = candidates.find(candidate => candidate.part === 'body' && candidate.layerName === 'body');
  const armPart = candidates.find(candidate => candidate.part === 'body' && candidate.layerName === 'arm');
  const headPart = candidates.find(candidate => candidate.part === 'head' && candidate.layerName === 'head');
  assert(bodyPart && headPart, `273 ${action}/${frameIndex} missing body or head`);
  // Compose the anchor owners in dependency order.  Canvas map points are
  // relative to the Canvas origin, so reading a raw head/arm frame before it
  // has been placed would produce the local map point rather than its actor
  // coordinate.
  const rawBodyAnchors = {
    navel: anchorPoint(bodyPart.frame, 'navel'),
    neck: anchorPoint(bodyPart.frame, 'neck'),
  };
  assert(rawBodyAnchors.navel && rawBodyAnchors.neck, `273 ${action}/${frameIndex} missing body anchor`);
  const rendered = new Map();
  const bodyPlaced = compose(bodyPart, rawBodyAnchors);
  rendered.set(bodyPart, bodyPlaced);
  const actorAnchors = {
    navel: finalAnchor(bodyPlaced, 'navel'),
    neck: finalAnchor(bodyPlaced, 'neck'),
  };
  assert(actorAnchors.navel && actorAnchors.neck, `273 ${action}/${frameIndex} body placement failed`);

  if (armPart) {
    const armPlaced = compose(armPart, actorAnchors);
    rendered.set(armPart, armPlaced);
    actorAnchors.hand = finalAnchor(armPlaced, 'hand');
  }
  if (!actorAnchors.hand) actorAnchors.hand = finalAnchor(bodyPlaced, 'hand');
  const headPlaced = compose(headPart, actorAnchors);
  rendered.set(headPart, headPlaced);
  actorAnchors.brow = finalAnchor(headPlaced, 'brow');
  assert(actorAnchors.brow, `273 ${action}/${frameIndex} head brow placement failed`);

  const parts = candidates.map(candidate => rendered.get(candidate) || compose(candidate, actorAnchors));
  assert(parts.every(part => Number.isSafeInteger(part.z)), `273 ${action}/${frameIndex} has unknown z index`);
  parts.sort((a, b) => b.z - a.z);
  const renderedAnchors = Object.fromEntries(Object.entries(actorAnchors).filter(([, point]) => point));

  return {
    index: Number(frameIndex),
    delay: Number(value(frameNode, 'delay', 0)),
    parts,
    anchors: renderedAnchors,
    filteredParts: rejected,
  };
}

async function actionFrames(action, sourceAction, selected, starter) {
  const actionNode = resolved(await get(`${BODY}/${sourceAction}`));
  const bodyFrames = numeric(actionNode);
  assert(bodyFrames.length, `273 body has no ${sourceAction} frames`);
  const result = [];
  for (const bodyFrame of bodyFrames) {
    const delay = Number(value(bodyFrame, 'delay', 0));
    assert(Number.isFinite(delay) && delay > 0, `273 body ${sourceAction}/${bodyFrame.name} has no positive delay`);
    result.push(await buildAction(action, sourceAction, bodyFrame, selected, starter));
  }
  return result;
}

async function loadSourceTables() {
  const z = resolved(await get('Base/zmap.img'));
  for (const [index, node] of children(z).entries()) zmap.set(node.name, index);
  const s = resolved(await get('Base/smap.img'));
  for (const node of children(s)) {
    const mapped = node?.wzValue;
    if (typeof mapped === 'string') smap.set(node.name, mapped);
  }
  assert(zmap.size > 100, `273 zmap unexpectedly small: ${zmap.size}`);
}

async function actionSet(selected, starter) {
  const actions = {};
  const actionSources = {};
  for (const [action, sourceAction] of ACTIONS) {
    const actionNode = resolved(await get(`${BODY}/${sourceAction}`));
    const frames = numeric(actionNode);
    const delays = frames.map(frame => Number(value(frame, 'delay', 0)));
    assert(frames.length && delays.every(delay => Number.isFinite(delay) && delay > 0), `273 action ${sourceAction} delay data invalid`);
    actions[action] = await actionFrames(action, sourceAction, selected, starter);
    actionSources[action] = { sourceAction, frameCount: frames.length, delays };
  }
  return { actions, actionSources };
}

async function equipmentSlots() {
  const entries = {};
  const images = new Map([
    ['cap', 'Character/Cap/01002067.img'],
    ['coat', 'Character/Coat/01040002.img'],
    ['longcoat', 'Character/Longcoat/01052095.img'],
    ['weapon', 'Character/Weapon/01302000.img'],
  ]);
  for (const [slot, image] of images) {
    const info = await sourceInfo(image, image);
    entries[slot] = info;
  }
  return entries;
}

async function main() {
  fs.mkdirSync(ASSETS, { recursive: true });
  await loadSourceTables();

  const starter = await actionSet([], true);
  const avatar = {
    defaultFacing: -1,
    facingConvention: 'Source TMS273 Canvas is left-facing; mirror the complete character container for right-facing.',
    look: {
      body: '00002000.img',
      head: '00012000.img',
      face: ['Face', '00020000.img'],
      hair: ['Hair', '00030020.img'],
      cap: ['Cap', '01000001.img'],
      coat: ['Coat', '01040002.img'],
      pants: ['Pants', '01060003.img'],
      shoes: ['Shoes', '01070000.img'],
      weapon: ['Weapon', '01302000.img'],
    },
    zmap: [...zmap].map(([name, index]) => ({ name, index })),
    smap: Object.fromEntries(smap),
    equipmentSlots: await equipmentSlots(),
    actionSources: starter.actionSources,
    actions: { ...starter.actions, climb: starter.actions.ladder },
    equipmentLoadouts: {},
    instances: [],
  };

  for (const itemIds of LOADOUT_IDS) {
    const key = itemIds.length ? [...itemIds].sort().join('+') : 'empty';
    const result = await actionSet(itemIds, false);
    avatar.equipmentLoadouts[key] = { itemIds, actions: result.actions };
    console.log(`273 avatar ${key}: ${Object.values(result.actions).map(frames => frames.length).join('/')} frames`);
  }

  const output = {
    contentVersion: 'tms273-avatar',
    source: 'TMS273.7 client WZ / Character + Base',
    avatar,
  };
  fs.writeFileSync(path.join(OUTPUT, 'avatar.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    output: path.relative(ROOT, path.join(OUTPUT, 'avatar.json')),
    pngs: frameCache.size,
    zmap: zmap.size,
    loadouts: Object.keys(avatar.equipmentLoadouts),
    actions: Object.fromEntries(Object.entries(avatar.actionSources).map(([key, stat]) => [key, stat.delays])),
  }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
}).finally(() => reader.close());
