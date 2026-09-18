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

const DEFAULT_SOURCES = Object.freeze({
  body: BODY,
  head: HEAD,
  face: FACE,
  hair: HAIR,
  pants: PANTS,
  shoes: SHOES,
});

// [导出动作 key, 源动作名, 选项]。角色坐姿来自**角色自身**的部件帧，不是椅子贴图：
//   Character/00002000.img/sit    1 帧（body/arm/face，**无 delay**）
//   Character/00012000.img/sit    1 帧（head）
//   Character/{Cap,Longcoat,Coat,Hair}/<id>.img/sit   1 帧
//   Character/Weapon/<id>.img 与 Face/00020000.img   **没有** sit
//     ⇒ `leavesFor` 跳过缺失层（既有行为），整段动作仍成立，不破图。
// 静态单帧动作源里没有 delay，导出写 0 并由客户端 `frameAt` 短路为第 0 帧
// （否则 duration=0 会让 `elapsed % 0` 得到 NaN）。
const ACTIONS = [
  ['stand', 'stand1'],
  ['walk', 'walk1'],
  ['jump', 'jump'],
  ['attack', 'swingO1'],
  ['ladder', 'ladder'],
  ['rope', 'rope'],
  ['sit', 'sit', { static: true }],
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
  if (candidate.part === 'face' || candidate.part === 'hair' || candidate.part === 'cap'
    || candidate.part === 'faceAccessory' || candidate.part === 'accessory') return ['brow'];
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

async function leavesFor(image, part, action, frameIndex, owner, include = undefined, actionPrefix = undefined) {
  // Cash weapons keep the same action names as the ordinary weapon images,
  // but nest them below a numeric weapon-type node (for example `/30`).
  // `actionPrefix` is deliberately a path segment supplied by the descriptor,
  // rather than a guessed item-family rule, so ordinary equipment keeps the
  // direct source path.
  const actionRoot = actionPrefix ? `${image}/${actionPrefix}` : image;
  const source = `${actionRoot}/${action}/${frameIndex}`;
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
    const name = layerName(leafSource, actionRoot, action, frameIndex);
    return include.includes(name);
  });
  const result = [];
  for (const leaf of leaves) {
    const name = layerName(leaf.source, actionRoot, action, frameIndex);
    const frame = await sourceFrame(leaf.source);
    // Two legacy TMS273 cash capes author `z=0` on their UOL Canvas instead
    // of the named zmap entry.  Their authored slot is Sr, so the source
    // layer is the regular cape depth.  A pair of cap accessory leaves uses
    // the old `capBelowBody` spelling; TMS273's zmap names that same Cc depth
    // `capAccessoryBelowBody`. Keep both aliases narrow and source-backed.
    const authoredZName = layerZName(leaf.node, part === 'cape' ? 'cape' : name);
    // 01412004 retains the legacy below-body weapon spelling; Base/zmap
    // names the same depth weaponBelowBody in this client.
    // 01582001（埃德爾斯坦商店武器）authors the post-BB `weaponBelowHead`
    // spelling; TMS273's zmap keeps only the same-depth legacy name
    // `weaponOverArmBelowHead`, so alias it the same narrow way.
    // 爪类（147 家族，WZ 全目录扫描仅此家族共 9 帧）在武器帧里附带
    // `weaponWrist` 护腕绑带 Canvas，而 TMS273 的 zmap 没有为它编写深度。
    // 绑带与爪身在同一个武器帧里且紧跟 `weapon` 之后，按武器本体深度
    // 绘制（同深度按插入顺序，绑带画在爪身之后）。
    const zName = authoredZName === 'capBelowBody' ? 'capAccessoryBelowBody'
      : authoredZName === 'weaponBodyBelow' ? 'weaponBelowBody'
      : authoredZName === 'weaponBelowHead' ? 'weaponOverArmBelowHead'
      : authoredZName === 'weaponWrist' ? 'weapon' : authoredZName;
    assert(zmap.has(zName), `273 zmap missing layer ${zName} from ${leaf.source}`);
    result.push({ node: leaf.node, source: leaf.source, frame, part, layerName: name, owner, zName });
  }
  return result;
}

async function staticFace(image = FACE) {
  const source = `${image}/default/face`;
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

async function buildAction(action, sourceAction, frameNode, selected, starter, options = {}) {
  const sources = { ...DEFAULT_SOURCES, ...(options.sources || {}) };
  const frameIndex = frameNode.name;
  const faceVisible = Number(value(frameNode, 'face', 1)) !== 0;
  const selectedInfos = await itemCandidates(selected, starter);
  const candidates = [];
  const rejected = [];

  async function add(image, part, owner, include, itemId = undefined, base = false, actionPrefix = undefined) {
    const leaves = await leavesFor(image, part, sourceAction, frameIndex, owner, include, actionPrefix);
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
        }
        // Keep a hidden head/arm/body as an anchor owner.  A cap or coat can
        // cover that Canvas in the final list, but equipment still needs its
        // brow/hand/navel in actor coordinates before the covered part is
        // removed from the rendered output.
        candidates.push({ ...leaf, itemId, hidden: Boolean(hidden) });
        continue;
      }
      candidates.push({ ...leaf, itemId });
    }
  }

  // First collect body and head so their authored neck/navel/brow/hand
  // anchors become the targets for every equipment Canvas.
  await add(sources.body, 'body', 'body', ['body', 'arm', 'lHand', 'rHand'], undefined, true);
  await add(sources.head, 'head', 'head', ['head'], undefined, true);
  if (sources.hair) await add(sources.hair, 'hair', 'hair', undefined, undefined, true);
  if (faceVisible && sources.face) {
    const face = await staticFace(sources.face);
    candidates.push(face);
  }

  // Longcoat's MaPn vslot replaces the base pants slot.  The same rule is
  // expressed in source data, and kept here only to avoid loading an
  // impossible duplicate appearance when this loadout is selected.
  const longcoat = selectedInfos.some(item => item.longcoat);
  if (!longcoat && sources.pants) await add(sources.pants, 'pants', 'pants', undefined, undefined, true);
  if (sources.shoes) await add(sources.shoes, 'shoes', 'shoes', undefined, undefined, true);

  for (const item of selectedInfos) {
    await add(item.image, item.part, item.itemId, undefined, item.itemId, false, item.actionPrefix);
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

  const parts = candidates
    .filter(candidate => !candidate.hidden)
    .map(candidate => rendered.get(candidate) || compose(candidate, actorAnchors));
  assert(parts.every(part => Number.isSafeInteger(part.z)), `273 ${action}/${frameIndex} has unknown z index`);
  parts.sort((a, b) => b.z - a.z);
  const renderedAnchors = Object.fromEntries(Object.entries(actorAnchors).filter(([, point]) => point));

  return {
    index: Number(frameIndex),
    delay: Number(value(frameNode, 'delay', NaN)),
    parts,
    anchors: renderedAnchors,
    filteredParts: rejected,
  };
}

async function actionFrames(action, sourceAction, selected, starter, options = {}) {
  const bodySource = options.sources?.body || BODY;
  const actionNode = resolved(await get(`${bodySource}/${sourceAction}`));
  const bodyFrames = numeric(actionNode);
  assert(bodyFrames.length, `273 body has no ${sourceAction} frames`);
  // 静态动作必须是**单帧**：多帧却没有 delay 的话，`frameAt` 会停在第 0 帧，
  // 后面的帧永远不显示。所以这里不是"放宽断言"，而是换一条更强的断言。
  if (options.static) {
    assert(bodyFrames.length === 1, `273 static action ${sourceAction} must have exactly one frame`);
  }
  const result = [];
  for (const bodyFrame of bodyFrames) {
    const delay = Number(value(bodyFrame, 'delay', 0));
    assert(
      options.static ? Number.isFinite(delay) && delay >= 0 : Number.isFinite(delay) && delay > 0,
      `273 body ${sourceAction}/${bodyFrame.name} has no ${options.static ? 'valid' : 'positive'} delay`,
    );
    result.push(await buildAction(action, sourceAction, bodyFrame, selected, starter, options));
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

async function actionSet(selected, starter, options = {}) {
  const actions = {};
  const actionSources = {};
  const bodySource = options.sources?.body || BODY;
  for (const [action, sourceAction, actionOptions] of [...ACTIONS, ...(options.appearanceVariants ? [['stand2', 'stand2'], ['walk2', 'walk2']] : [])]) {
    const actionNode = resolved(await get(`${bodySource}/${sourceAction}`));
    const frames = numeric(actionNode);
    const delays = frames.map(frame => Number(value(frame, 'delay', 0)));
    assert(frames.length, `273 action ${sourceAction} has no frames`);
    assert(delays.every(delay => Number.isFinite(delay) && delay >= 0), `273 action ${sourceAction} delay data invalid`);
    // 单帧静态动作（源 `sit`）可以没有 delay；**多帧动作必须每一帧都有正 delay**，
    // 否则会出现"某帧永不显示"的静默缺陷。
    assert(frames.length === 1 || delays.every(delay => delay > 0), `273 action ${sourceAction} has a non-positive delay`);
    const merged = { ...options, ...(actionOptions ?? {}) };
    actions[action] = await actionFrames(action, sourceAction, selected, starter, merged);
    actionSources[action] = { sourceAction, frameCount: frames.length, delays };
  }
  return { actions, actionSources };
}

const MAGE_ACTIONS = [
  ['skill2001008', 'energyBolt'],
  ['skill2001011', 'manaWave'],
  ['skill2001012', 'manaWaveFloat'],
  ['skill2201008', 'coldBeam'],
  ['skill2201005', 'thunderBolt'],
  ['skill2201001', 'alert2'],
  ['skill2211002', 'iceStrike'],
  ['skill2211007', 'alert2'],
  ['skill2211011', 'thunderStorm'],
  ['skill2211012', 'elementalAdapting'],
  ['skill2211014', 'glacialWall'],
  ['skill2221004', 'alert2'],
  ['skill2221005', 'alert2'],
  ['skill2221006', 'chainLightningNew'],
  ['skill2221007', 'blizzardNew'],
  ['skill2221011', 'armorMelting'],
  ['skill2221012', 'frozenOrb'],
  ['skill2221052prepare', 'HY222lightningSphere_prep'],
  ['skill2221052', 'HY222lightningSphere'],
  ['skill2221052final', 'HY222lightningSphere_end'],
];

async function resolveMagePose(bodySource, sourceAction, frameNode) {
  const rawAction = value(frameNode, 'action', sourceAction);
  const rawFrame = value(frameNode, 'frame', frameNode.name);
  const actionName = String(rawAction || sourceAction);
  const frameText = String(rawFrame ?? frameNode.name);
  const numericFrame = /^\d+$/.test(frameText) ? Number(frameText) : null;
  const candidates = numericFrame === null
    ? [
      // A few Character skill timelines use the `frame` field as an action
      // alias (for example `alert`).  Resolve that alias to its authored 0th
      // frame instead of ever treating the string as a numeric frame index.
      { action: frameText, frame: 0, mode: 'frame-action-alias' },
      { action: actionName, frame: 0, mode: 'action-default-frame' },
    ]
    : [{ action: actionName, frame: numericFrame, mode: 'direct' }];
  let lastError;
  for (const candidate of candidates) {
    const source = `${bodySource}/${candidate.action}/${candidate.frame}`;
    try {
      const node = resolved(await get(source));
      return {
        node,
        source,
        linkedAction: candidate.action,
        linkedFrame: candidate.frame,
        rawAction,
        rawFrame,
        linkResolution: candidate.mode,
      };
    } catch (error) {
      lastError = error;
      if (!error.message.includes('找不到 273 WZ 节点')) throw error;
    }
  }
  throw new Error(
    `Unable to resolve mage pose link ${sourceAction}/${frameNode.name}: `
      + `${String(rawAction)}/${String(rawFrame)} (${lastError?.message || 'no candidate'})`,
    { cause: lastError },
  );
}

/** Export the source-linked mage pose set using the same frame compositor. */
async function mageActionSet(selected, starter, options = {}) {
  const bodySource = options.sources?.body || BODY;
  const actions = {};
  const actionSources = {};
  for (const [key, sourceAction] of MAGE_ACTIONS) {
    actions[key] = [];
    const sourceFrames = numeric(resolved(await get(`${bodySource}/${sourceAction}`)));
    for (const frameNode of sourceFrames) {
      const pose = await resolveMagePose(bodySource, sourceAction, frameNode);
      const frame = await buildAction(key, pose.linkedAction, pose.node, selected, starter, options);
      const rawDelay = Number(value(frameNode, 'delay', NaN));
      assert(Number.isFinite(rawDelay), `Missing skill pose delay ${sourceAction}/${frameNode.name}`);
      const move = value(frameNode, 'move', { x: 0, y: 0 });
      // P: a zero-duration source pose uses one display millisecond; raw timing remains intact.
      // Negative delay uses abs for presentation only, never a server hit schedule.
      frame.delay = Math.max(1, Math.abs(rawDelay));
      frame.rawDelay = rawDelay;
      frame.source = `${bodySource}/${sourceAction}/${frameNode.name}`;
      frame.linkedAction = pose.linkedAction;
      frame.linkedFrame = pose.linkedFrame;
      frame.rawLinkedAction = pose.rawAction;
      frame.rawLinkedFrame = pose.rawFrame;
      frame.linkResolution = pose.linkResolution;
      frame.linkedSource = pose.source;
      frame.move = { x: Number(move.x), y: Number(move.y) };
      for (const part of frame.parts) { part.x += frame.move.x; part.y += frame.move.y; }
      for (const anchor of Object.values(frame.anchors)) { anchor.x += frame.move.x; anchor.y += frame.move.y; }
      actions[key].push(frame);
    }
    assert(actions[key].length, `Missing skill pose ${sourceAction}`);
    actionSources[key] = { sourceAction, frameCount: actions[key].length, delays: actions[key].map(frame => frame.delay), rawDelays: actions[key].map(frame => frame.rawDelay) };
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

  if (process.argv.includes('--mage-actions')) {
    const mageActions = async (selected, starter) => (await mageActionSet(selected, starter)).actions;
    const output = { sourceVersion: 'TMS273.7', actions: await mageActions([], true), equipmentLoadouts: {} };
    for (const itemIds of LOADOUT_IDS) output.equipmentLoadouts[itemIds.length ? [...itemIds].sort().join('+') : 'empty'] = await mageActions(itemIds, false);
    fs.writeFileSync(path.join(OUTPUT, 'mage-avatar.json'), JSON.stringify(output, null, 2) + '\n', 'utf8');
    console.log('Exported original mage poses for starter and 12 equipment loadouts');
    return;
  }

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

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  }).finally(() => reader.close());
}

// Keep the original CLI as the full paper-doll exporter while allowing the
// appearance exporter to reuse the same source reader, anchor compositor,
// and z/smap filtering rules without copying them into a second script.
module.exports = {
  DATA,
  OUTPUT,
  ASSETS,
  BODY,
  HEAD,
  FACE,
  HAIR,
  PANTS,
  SHOES,
  STARTER_WEAPON,
  DEFAULT_SOURCES,
  ACTIONS,
  MAGE_ACTIONS,
  SUPPORT,
  LOADOUT_IDS,
  reader,
  zmap,
  smap,
  children,
  numeric,
  value,
  primitive,
  get,
  resolved,
  isCanvas,
  relativeUol,
  layerName,
  layerZName,
  drawableLeaves,
  sourceFrame,
  sourceInfo,
  anchorPoint,
  preferredAnchors,
  compose,
  finalAnchor,
  leavesFor,
  staticFace,
  itemCandidates,
  buildAction,
  actionFrames,
  loadSourceTables,
  actionSet,
  mageActionSet,
  equipmentSlots,
};
