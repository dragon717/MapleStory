#!/usr/bin/env node

// Export source-backed appearance layers for the TMS273 character creator.
// The full paper-doll exporter owns the WZ reader, anchor composition, and
// vslot/smap filtering rules; this file only selects individual layers so the
// client can combine an empty base with an appearance/equipment choice.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const avatar = require('./export_tms273_avatar.cjs');
const {
  DATA,
  OUTPUT,
  BODY,
  HEAD,
  PANTS,
  SHOES,
  reader,
  SUPPORT,
  loadSourceTables,
  actionSet,
  mageActionSet,
  get,
  isCanvas,
  layerZName,
  zmap,
  children,
  sourceInfo,
  staticFace,
  leavesFor,
  compose,
} = avatar;

const ASSETS = path.join(OUTPUT, 'assets/tms273');
const CASHSHOP = path.join(OUTPUT, 'cashshop.json');
const CASH_APPEARANCE_DIR = path.join(ASSETS, 'appearance-cashshop');
const CASH_APPEARANCE_URL = '/assets/tms273/appearance-cashshop';
const MAKE_CHAR_INFO = path.join(
  path.resolve(DATA, '../../..'),
  '手工服务端/tms273/WZ_JSON_TW/Etc/MakeCharInfo.json',
);

const NORMAL_SOURCES = {
  0: {
    body: BODY,
    head: HEAD,
    pants: 'Character/Pants/01060003.img',
    shoes: SHOES,
  },
  1: {
    // MakeCharInfo's gender flag selects clothing; body/head IDs select skin
    // tone. Creation skin 0 therefore shares the skin-0 base for both genders.
    body: BODY,
    head: HEAD,
    pants: 'Character/Pants/01061002.img',
    shoes: 'Character/Shoes/01071000.img',
  },
};

const EXTRA_EQUIPMENT = [
  { id: 1002067, part: 'cap', image: 'Character/Cap/01002067.img' },
  { id: 1003134, part: 'cap', image: 'Character/Cap/01003134.img' },
  { id: 1040002, part: 'coat', image: 'Character/Coat/01040002.img' },
  { id: 1052095, part: 'coat', image: 'Character/Longcoat/01052095.img', longcoat: true },
];

const CASH_EQUIPMENT_DIRECTORIES = {
  100: 'Cap', 101: 'Accessory', 102: 'Accessory', 103: 'Accessory', 104: 'Coat',
  105: 'Longcoat', 106: 'Pants', 107: 'Shoes', 108: 'Glove', 109: 'Shield',
  110: 'Cape', 111: 'Accessory', 112: 'Accessory', 113: 'Accessory', 116: 'Accessory',
  118: 'Accessory', 120: 'Accessory', 160: 'Cape', 170: 'Weapon',
};
function unpack(node) {
  if (!node || typeof node !== 'object') return node;
  if (node._dirType === 'int') return Number(node._value);
  if (node._dirType === 'string') return String(node._value);
  return Object.fromEntries(Object.entries(node)
    .filter(([key]) => key !== '_dirType')
    .map(([key, child]) => [key, unpack(child)]));
}

function uniqueNumbers(values) {
  return [...new Set(values.map(Number).filter(Number.isSafeInteger))];
}

function numberedValues(section) {
  return uniqueNumbers(Object.entries(section || {})
    .filter(([key]) => /^\d+$/.test(key))
    .map(([, value]) => value));
}

function groupSections(group, gender) {
  const source = unpack(group?.[gender]);
  assert(source && typeof source === 'object', `MakeCharInfo/000/${gender} missing`);
  const hair = source['1'] || {};
  const colors = Object.values(hair.color || {}).flatMap(numberedValues);
  return {
    face: numberedValues(source['0']),
    hair: uniqueNumbers([...numberedValues(hair), ...colors]),
    hairDefault: Number(Object.values(hair.color || {})[0] ? numberedValues(Object.values(hair.color || {})[0])[0] : numberedValues(hair)[0]),
    coat: numberedValues(source['2']),
    shoes: numberedValues(source['3']),
    weapon: numberedValues(source['4']),
  };
}

function imageForPart(part, id) {
  const padded = String(id).padStart(8, '0');
  if (part === 'face') return `Character/Face/${padded}.img`;
  if (part === 'hair') return `Character/Hair/${padded}.img`;
  if (part === 'shoes') return `Character/Shoes/${padded}.img`;
  if (part === 'weapon') return `Character/Weapon/${padded}.img`;
  if (part === 'coat') return Number(id) >= 1050000 && Number(id) < 1060000
    ? `Character/Longcoat/${padded}.img`
    : `Character/Coat/${padded}.img`;
  throw new Error(`Unknown appearance part: ${part}`);
}

function equipmentDescriptor(id) {
  const numericId = Number(id);
  // Keep the explicit source-backed descriptors keyed by their own id.  The
  // old implementation used the id as an array index here, which silently
  // bound 1040002 to the cap 1003134 and 1052095 to the coat 1040002.
  const extra = EXTRA_EQUIPMENT.find(item => item.id === numericId);
  if (extra) return extra;
  if (numericId >= 1040000 && numericId < 1050000) return { id: numericId, part: 'coat', image: imageForPart('coat', numericId) };
  if (numericId >= 1050000 && numericId < 1060000) return { id: numericId, part: 'coat', image: imageForPart('coat', numericId), longcoat: true };
  if (numericId >= 1070000 && numericId < 1080000) return { id: numericId, part: 'shoes', image: imageForPart('shoes', numericId) };
  if (numericId >= 1200000 && numericId < 1800000) return { id: numericId, part: 'weapon', image: imageForPart('weapon', numericId) };
  throw new Error(`Unsupported MakeCharInfo equipment id: ${id}`);
}

function canonicalItemId(id) {
  const value = String(id).trim();
  if (!/^\d+$/.test(value)) throw new Error(`Invalid numeric item id: ${id}`);
  return value.padStart(8, '0');
}

function weaponBranchForItemId(id) {
  const numericId = Number(id);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) return undefined;
  const family = Math.floor(numericId / 10000);
  const branch = family % 100;
  return branch > 0 ? String(branch) : undefined;
}

function supportedWeaponTypes(genderOptions) {
  const types = new Set();
  for (const options of Object.values(genderOptions)) {
    for (const id of options.weapon) {
      const branch = weaponBranchForItemId(id);
      if (branch) types.add(branch);
    }
  }
  // These are the ordinary, source-backed item definitions assembled for
  // gameplay.  Do not derive branches from cash item ids: a cash weapon's
  // numeric family (for example 170) does not identify its authored pose.
  const ordinaryItems = path.join(OUTPUT, 'items.json');
  if (fs.existsSync(ordinaryItems)) {
    const items = JSON.parse(fs.readFileSync(ordinaryItems, 'utf8'));
    for (const [id, definition] of Object.entries(items)) {
      if (!definition?.info?.islot?.startsWith('Wp') || definition.info.cash === 1) continue;
      const branch = weaponBranchForItemId(id);
      if (branch) types.add(branch);
    }
  }
  return [...types].sort((a, b) => Number(a) - Number(b));
}

function cashPart(islot, family) {
  if (islot === 'Af') return { part: 'faceAccessory', static: true };
  if (islot === 'Ay' || islot === 'Ae') return { part: 'accessory' };
  if (islot === 'Cp' || islot === 'HrCp' || islot.startsWith('HrCp')) return { part: 'cap' };
  if (islot === 'MaPn') return { part: 'coat', longcoat: true };
  if (islot === 'Ma') return { part: 'coat' };
  if (islot === 'Pn') return { part: 'pants' };
  if (islot === 'So') return { part: 'shoes' };
  if (islot === 'Gv' || islot === 'GlGw') return { part: 'glove' };
  if (islot === 'Sr') return { part: 'cape' };
  if (islot === 'Si') return { part: 'shield' };
  if (islot.startsWith('Wp')) return { part: 'weapon' };
  // A new family should be added from its authored `info.islot`, rather than
  // guessing from the numeric prefix.  Keep the family in the error so the
  // export report identifies the source row that needs review.
  return undefined;
}

async function cashEquipmentDescriptors(weaponTypes) {
  if (!fs.existsSync(CASHSHOP)) return { descriptors: [], skipped: [] };
  const cashshop = JSON.parse(fs.readFileSync(CASHSHOP, 'utf8'));
  const descriptors = [];
  const skipped = [];
  for (const rawId of Object.keys(cashshop.itemIcons ?? {})) {
    const itemId = canonicalItemId(rawId);
    const numericId = Number(itemId);
    const family = Math.floor(numericId / 10000);
    const directory = CASH_EQUIPMENT_DIRECTORIES[family];
    if (!directory) continue;
    const image = `Character/${directory}/${itemId}.img`;
    let info;
    let imageNode;
    try {
      imageNode = await get(image);
      info = await sourceInfo(image, image);
    } catch (error) {
      skipped.push({ itemId, reason: error.message });
      continue;
    }
    const shape = cashPart(info.islot, family);
    if (!shape) {
      skipped.push({ itemId, reason: `unsupported islot ${info.islot || '<empty>'}` });
      continue;
    }
    const groups = shape.part === 'weapon'
      ? children(imageNode).filter(node => /^\d+$/.test(node.name)).map(node => node.name)
      : [];
    // Cash weapon images author a separate branch for each compatible weapon
    // type.  Retain only the source-proven mage branches used by this build;
    // a sword/bow branch would bind the cash art to the wrong hand pose.
    const compatibleGroups = groups.filter(group => weaponTypes.has(group));
    if (shape.part === 'weapon' && !compatibleGroups.length) {
      skipped.push({
        itemId,
        reason: `cash weapon has no supported branch (source types ${groups.join(',') || '<empty>'})`,
        supportedWeaponTypes: [...weaponTypes],
      });
      continue;
    }
    const actionPrefix = compatibleGroups.length === 1 ? compatibleGroups[0] : undefined;
    descriptors.push({
      id: numericId,
      itemId,
      part: shape.part,
      image,
      longcoat: shape.longcoat,
      static: shape.static,
      actionPrefix,
      weaponGroups: compatibleGroups,
      sourceWeaponGroups: groups,
      islot: info.islot,
      vslot: info.vslot,
      cash: true,
      lazy: true,
    });
  }
  if (skipped.length) console.warn(`Skipped ${skipped.length} cash appearance sources`, skipped.slice(0, 5));
  return { descriptors, skipped };
}

function actionSourcesFor(set) {
  return set.actionSources;
}

function withParts(frame, parts) {
  return { ...frame, parts };
}

function filterActions(actions, predicate) {
  return Object.fromEntries(Object.entries(actions).map(([name, frames]) => [
    name,
    frames.map(frame => withParts(frame, frame.parts.filter(predicate))),
  ]));
}

function addActions(target, actions) {
  Object.assign(target, actions);
}

function sourceConfig(gender, overrides = {}) {
  return { ...NORMAL_SOURCES[gender], ...overrides };
}

async function exportBase(gender, includeSkills) {
  const sources = sourceConfig(gender, { face: undefined, hair: undefined });
  const set = await actionSet([], false, { sources, appearanceVariants: true });
  const actions = filterActions(set.actions, part => ['body', 'head', 'pants', 'shoes'].includes(part.part));
  const actionSources = { ...actionSourcesFor(set) };
  if (includeSkills) {
    const skills = await mageActionSet([], false, { sources });
    Object.assign(actionSources, actionSourcesFor(skills));
    addActions(actions, filterActions(skills.actions, part => ['body', 'head', 'pants', 'shoes'].includes(part.part)));
  }
  return {
    gender,
    body: sources.body,
    head: sources.head,
    pants: sources.pants,
    shoes: sources.shoes,
    actions,
    actionSources,
  };
}

async function exportAppearanceLayer(gender, part, id, base) {
  const image = imageForPart(part, id);
  const actions = {};
  const layerPart = part;
  const staticLayer = part === 'face' ? await staticFace(image) : undefined;
  const baseActions = base.actions;
  for (const [action, frames] of Object.entries(baseActions)) {
    // Skill pose frames are already source-linked and use a different body
    // timeline. Appearance layers are exported for the same skill keys by
    // composing their Canvas with that frame's actor anchors.
    const layerFrames = [];
    for (const [index, baseFrame] of frames.entries()) {
      const sourceAction = baseFrame.linkedAction || base.actionSources[action]?.sourceAction;
      if (!sourceAction) {
        layerFrames.push(withParts(baseFrame, []));
        continue;
      }
      if (part === 'face' && ['ladder', 'rope'].includes(action)) {
        layerFrames.push(withParts(baseFrame, []));
        continue;
      }
      const frameIndex = baseFrame.linkedFrame ?? baseFrame.index ?? index;
      const candidates = staticLayer
        ? [staticLayer]
        : await leavesFor(image, 'hair', sourceAction, frameIndex, 'hair');
      const rendered = candidates.map(candidate => compose(candidate, baseFrame.anchors));
      layerFrames.push(withParts(baseFrame, rendered.filter(candidate => candidate.part === layerPart)));
    }
    actions[action] = layerFrames;
  }
  const info = await sourceInfo(image, image);
  return {
    id: Number(id),
    part,
    slot: info.islot,
    islot: info.islot,
    vslot: info.vslot,
    source: image,
    gender,
    actions,
  };
}

async function exportEquipmentLayer(gender, descriptor, includeSkills) {
  const itemId = descriptor.itemId ?? String(descriptor.id);
  const support = {
    part: descriptor.part,
    image: descriptor.image,
    longcoat: descriptor.longcoat,
    actionPrefix: descriptor.actionPrefix,
    itemId,
  };
  // `actionSet` receives the canonical id, while old creation data still uses
  // the unpadded form.  Register both spellings in the exporter map; the
  // emitted cash layer itself keeps the canonical 8-digit itemId.
  SUPPORT.set(itemId, support);
  SUPPORT.set(String(Number(itemId)), support);
  const sources = sourceConfig(gender, {
    face: imageForPart('face', gender === 0 ? 20100 : 21700),
    hair: imageForPart('hair', gender === 0 ? 30000 : 31000),
  });
  const normal = await actionSet([itemId], false, { sources, appearanceVariants: true });
  const actions = filterActions(normal.actions, part => part.itemId === itemId && part.part === descriptor.part);
  const actionSources = { ...actionSourcesFor(normal) };
  if (includeSkills) {
    const skills = await mageActionSet([itemId], false, { sources });
    Object.assign(actionSources, actionSourcesFor(skills));
    addActions(actions, filterActions(skills.actions, part => part.itemId === itemId && part.part === descriptor.part));
  }
  const info = await sourceInfo(descriptor.image, descriptor.image);
  return {
    id: Number(descriptor.id),
    itemId,
    part: descriptor.part,
    slot: info.islot,
    islot: info.islot,
    vslot: info.vslot,
    source: descriptor.image,
    gender,
    actions,
    actionSources,
    ...(descriptor.lazy ? { cash: Boolean(descriptor.cash), lazy: true } : {}),
    ...(descriptor.standAction ? { standAction: descriptor.standAction, walkAction: descriptor.walkAction } : {}),
    ...(descriptor.weaponGroups?.length ? { weaponGroups: descriptor.weaponGroups, weaponType: descriptor.actionPrefix } : {}),
  };
}

/**
 * Cash weapons can contain several authored weapon-type branches in one WZ
 * image.  Keep every branch so the client can choose from the player's actual
 * weapon/job; exporting only the first numeric branch makes a wand render as
 * a sword (or disappear during attack) with no diagnostic.
 */
async function exportCashWeaponLayer(gender, descriptor) {
  const groups = descriptor.weaponGroups ?? [];
  if (!groups.length) return exportEquipmentLayer(gender, descriptor, false);
  const variants = {};
  let actionSources;
  for (const weaponType of groups) {
    const variant = await exportEquipmentLayer(gender, { ...descriptor, actionPrefix: weaponType }, true);
    variants[weaponType] = variant.actions;
    actionSources ??= variant.actionSources;
  }
  // A single authored branch is safe as the default.  When several authored
  // branches are present, leave the default unset: the runtime must provide
  // the player's actual weapon type instead of silently choosing one.
  const defaultType = groups.length === 1 ? groups[0] : undefined;
  const fallback = defaultType ? variants[defaultType] : {};
  return {
    id: Number(descriptor.id),
    itemId: descriptor.itemId,
    part: descriptor.part,
    slot: descriptor.islot,
    islot: descriptor.islot,
    vslot: descriptor.vslot,
    source: descriptor.image,
    gender,
    actions: fallback,
    actionSources: actionSources ?? {},
    actionsByWeaponType: variants,
    weaponGroups: groups,
    sourceWeaponGroups: descriptor.sourceWeaponGroups,
    ...(defaultType ? { weaponType: defaultType } : {}),
    cash: true,
    lazy: true,
  };
}

/** Export a face accessory's authored static Canvas against every body pose. */
async function exportStaticEquipmentLayer(gender, descriptor, base) {
  const itemId = descriptor.itemId ?? String(descriptor.id);
  const source = `${descriptor.image}/default/default`;
  const node = await get(source);
  assert(isCanvas(node), `Face accessory is not a Canvas: ${source}`);
  const frame = await avatar.sourceFrame(source);
  const zName = layerZName(node, 'default');
  assert(zmap.has(zName), `273 zmap missing layer ${zName} from ${source}`);
  const candidate = {
    node,
    source,
    frame,
    part: descriptor.part,
    layerName: 'default',
    owner: itemId,
    zName,
    itemId,
  };
  const actions = {};
  for (const [action, frames] of Object.entries(base.actions)) {
    actions[action] = frames.map(baseFrame => {
      // Face accessories follow the face's authored visibility rule.  The
      // character face is hidden on ladder/rope poses in this catalogue.
      if (['ladder', 'rope'].includes(action)) return withParts(baseFrame, []);
      return withParts(baseFrame, [compose(candidate, baseFrame.anchors)]);
    });
  }
  const info = await sourceInfo(descriptor.image, descriptor.image);
  return {
    id: Number(descriptor.id),
    itemId,
    part: descriptor.part,
    slot: info.islot,
    islot: info.islot,
    vslot: info.vslot,
    source: descriptor.image,
    gender,
    actions,
    actionSources: base.actionSources,
    cash: true,
    lazy: true,
  };
}

function addLayer(layers, key, layer) {
  const existing = layers[key];
  if (!existing) {
    layers[key] = { ...layer };
    return;
  }
  existing.actionsByGender ??= {};
  existing.actionsByGender[String(existing.gender)] = existing.actions;
  existing.actionsByGender[String(layer.gender)] = layer.actions;
  existing.actionSourcesByGender ??= {};
  existing.actionSourcesByGender[String(existing.gender)] = existing.actionSources;
  existing.actionSourcesByGender[String(layer.gender)] = layer.actionSources;
  if (existing.actionsByWeaponType || layer.actionsByWeaponType) {
    existing.actionsByWeaponTypeByGender ??= {};
    if (existing.actionsByWeaponType) {
      existing.actionsByWeaponTypeByGender[String(existing.gender)] = existing.actionsByWeaponType;
      delete existing.actionsByWeaponType;
    }
    if (layer.actionsByWeaponType) existing.actionsByWeaponTypeByGender[String(layer.gender)] = layer.actionsByWeaponType;
  }
  // Keep the male set at the direct `actions` key for the game path that has
  // historically rendered the starter avatar; gender-aware callers select
  // the matching entry in actionsByGender.
  existing.actions = existing.actionsByGender['0'];
  existing.actionSources = existing.actionSourcesByGender['0'];
  if (existing.actionsByWeaponTypeByGender) {
    existing.actionsByWeaponType = existing.actionsByWeaponTypeByGender['0'];
  }
  delete existing.gender;
}

function layerActionTrees(layer) {
  const trees = [layer.actions];
  trees.push(...Object.values(layer.actionsByGender ?? {}));
  trees.push(...Object.values(layer.actionsByWeaponType ?? {}));
  for (const byGender of Object.values(layer.actionsByWeaponTypeByGender ?? {})) {
    trees.push(...Object.values(byGender));
  }
  return trees;
}

function validateCashLayer(layer, itemId) {
  assert.equal(layer.itemId, itemId, `cash layer ${itemId} itemId drifted`);
  assert(layer.lazy, `appearance layer ${itemId} lost lazy marker`);
  let frameCount = 0;
  for (const actions of layerActionTrees(layer)) {
    for (const frames of Object.values(actions ?? {})) {
      for (const frame of frames ?? []) {
        frameCount += 1;
        for (const part of frame.parts ?? []) {
          assert.equal(part.itemId, itemId, `cash layer ${itemId} contains another item id`);
          assert(typeof part.url === 'string' && part.url.startsWith('/assets/tms273/'), `cash layer ${itemId} has an invalid asset URL`);
          const file = path.join(OUTPUT, part.url.replace(/^\//, ''));
          assert(fs.existsSync(file), `cash layer ${itemId} references missing PNG: ${part.url}`);
        }
      }
    }
  }
  assert(frameCount > 0, `cash layer ${itemId} has no authored frames`);
}

function cashAppearanceMetadata(layer, itemId) {
  return {
    itemId,
    id: layer.id,
    part: layer.part,
    islot: layer.islot,
    vslot: layer.vslot,
    source: layer.source,
    url: `${CASH_APPEARANCE_URL}/${itemId}.json`,
    cash: Boolean(layer.cash),
    lazy: true,
    ...(layer.weaponGroups?.length ? { weaponGroups: layer.weaponGroups } : {}),
    ...(layer.sourceWeaponGroups?.length ? { sourceWeaponGroups: layer.sourceWeaponGroups } : {}),
    ...(layer.weaponType ? { weaponType: layer.weaponType } : {}),
  };
}

function compactAppearancePart(part) {
  // Runtime composition only needs the already-resolved placement, zmap slot,
  // and image dimensions.  Source maps/UOL audit fields belong to the export
  // report and made every cash item repeat hundreds of bytes per frame.
  return {
    key: part.key,
    url: part.url,
    x: part.x,
    y: part.y,
    origin: part.origin,
    z: part.z,
    width: part.width,
    height: part.height,
    part: part.part,
    zName: part.zName,
    itemId: part.itemId,
  };
}

function compactAppearanceActions(actions) {
  return Object.fromEntries(Object.entries(actions ?? {}).map(([name, frames]) => [
    name,
    (frames ?? []).map(frame => ({ delay: frame.delay, parts: (frame.parts ?? []).map(compactAppearancePart) })),
  ]));
}

function compactCashLayer(layer) {
  const compact = {
    ...layer,
    actions: compactAppearanceActions(layer.actions),
    actionSourcesByGender: undefined,
  };
  if (layer.actionsByGender) {
    // The direct `actions` tree is the authored gender-0 tree.  Keep only the
    // other gender in the map so loading one item does not duplicate it.
    compact.actionsByGender = Object.fromEntries(Object.entries(layer.actionsByGender)
      .filter(([gender]) => gender !== '0')
      .map(([gender, actions]) => [gender, compactAppearanceActions(actions)]));
  }
  if (layer.actionsByWeaponType) {
    compact.actionsByWeaponType = Object.fromEntries(Object.entries(layer.actionsByWeaponType)
      .map(([type, actions]) => [type, compactAppearanceActions(actions)]));
  }
  if (layer.actionsByWeaponTypeByGender) {
    compact.actionsByWeaponTypeByGender = Object.fromEntries(Object.entries(layer.actionsByWeaponTypeByGender)
      .filter(([gender]) => gender !== '0')
      .map(([gender, byType]) => [gender, Object.fromEntries(Object.entries(byType)
        .map(([type, actions]) => [type, compactAppearanceActions(actions)]))]));
  }
  return compact;
}

function writeCashAppearance(cashLayers, skipped, weaponTypes) {
  fs.rmSync(CASH_APPEARANCE_DIR, { recursive: true, force: true });
  fs.mkdirSync(CASH_APPEARANCE_DIR, { recursive: true });
  const items = {};
  let bytes = 0;
  const itemIds = Object.keys(cashLayers).sort();
  for (const itemId of itemIds) {
    const layer = compactCashLayer(cashLayers[itemId]);
    validateCashLayer(layer, itemId);
    const serialized = `${JSON.stringify(layer)}\n`;
    fs.writeFileSync(path.join(CASH_APPEARANCE_DIR, `${itemId}.json`), serialized, 'utf8');
    bytes += Buffer.byteLength(serialized, 'utf8');
    items[itemId] = cashAppearanceMetadata(layer, itemId);
  }
  const index = {
    contentVersion: 'tms273-cash-appearance',
    sourceVersion: 'TMS273.7',
    source: 'TMS273.7 client WZ / Character cash equipment; layers are fetched per item',
    weaponTypes,
    items,
    skipped,
  };
  const serialized = `${JSON.stringify(index, null, 2)}\n`;
  const target = path.join(OUTPUT, 'appearance-cashshop.json');
  fs.writeFileSync(target, serialized, 'utf8');
  return { index, target, bytes: Buffer.byteLength(serialized, 'utf8'), itemBytes: bytes };
}

function layerKey(part, id) {
  return `${part}:${id}`;
}

// The starter avatar remains a valid persisted look even when MakeCharInfo
// no longer offers its face/hair. Keep its source layers composable in shops.
async function exportDefaultAppearanceLayers(bases, layers) {
  for (const gender of [0, 1]) {
    for (const part of ['face', 'hair']) {
      const id = Number(path.basename(avatar.DEFAULT_SOURCES[part], '.img'));
      const layer = await exportAppearanceLayer(gender, part, id, bases[gender]);
      addLayer(layers, layerKey(part, id), layer);
    }
  }
}

// All playable equipment is a consumer of the same appearance catalogue.
// Keep the historical cashAppearance wire name; ordinary layers use cash:false.
async function exportOrdinaryEquipment(bases, layers, index) {
  const items = JSON.parse(fs.readFileSync(path.join(OUTPUT, 'items.json'), 'utf8'));
  let count = 0;
  for (const [id, definition] of Object.entries(items)) {
    const info = definition.info;
    if (!info?.islot || info.cash === 1 || layers[String(Number(id))]) continue;
    // Po is a pocket item, with no paper-doll Canvas by design.
    // Tm (totem, e.g. 1612000 埃德爾斯坦商店新品) sources under
    // Character/Mechanic and likewise has no doll layer in TMS273.
    if (info.islot === 'Po' || info.islot === 'Tm') continue;
    const shape = cashPart(info.islot);
    assert(shape, `Unsupported ordinary equipment slot ${id}: ${info.islot}`);
    const itemId = canonicalItemId(id);
    const image = definition.source.replace(/\.json$/, '.img');
    assert(image.startsWith('Character/'), `Missing Character source for ${id}`);
    const source = await sourceInfo(image, image);
    assert.equal(source.islot, info.islot, `Ordinary equipment slot drift: ${id}`);
    const noVisual = children(await get(image)).every(node => node.name === 'info');
    const descriptor = { id: Number(id), itemId, image, ...shape, cash: false, lazy: true,
      ...(shape.part === 'weapon' ? { standAction: info.stand === 2 ? 'stand2' : 'stand', walkAction: info.walk === 2 ? 'walk2' : 'walk' } : {}),
    };
    const combined = {};
    for (const gender of [0, 1]) {
      const layer = shape.static
        ? { ...await exportStaticEquipmentLayer(gender, descriptor, bases[gender]), cash: false }
        : await exportEquipmentLayer(gender, descriptor, true);
      addLayer(combined, itemId, layer);
    }
    const layer = compactCashLayer(combined[itemId]);
    validateCashLayer(layer, itemId);
    if (noVisual) {
      // Source-only secondary weapons have info/icon but no actor Canvas.
      // They must not hide the primary weapon via their inventory vslot.
      layer.vslot = '';
      layer.sourceVisibility = 'info-only';
    } else {
      assert(layer.actions[descriptor.standAction ?? 'stand'].some(frame => frame.parts.length), `Ordinary equipment has no stand Canvas: ${image}`);
    }
    fs.mkdirSync(CASH_APPEARANCE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CASH_APPEARANCE_DIR, `${itemId}.json`), JSON.stringify(layer) + '\n', 'utf8');
    index.items[itemId] = cashAppearanceMetadata(layer, itemId);
    if (++count % 100 === 0) console.log(`Exported ${count} ordinary equipment layers`);
  }
  index.source = 'TMS273.7 client WZ / Character equipment; cash and ordinary layers fetched per item';
  fs.writeFileSync(path.join(OUTPUT, 'appearance-cashshop.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');
  return count;
}

async function main() {
  fs.mkdirSync(ASSETS, { recursive: true });
  await loadSourceTables();
  const rawCatalog = JSON.parse(fs.readFileSync(MAKE_CHAR_INFO, 'utf8'));
  const group = rawCatalog['000'];
  assert(group, 'Missing TMS273 MakeCharInfo/000 source');
  const genderOptions = { 0: groupSections(group, 'male'), 1: groupSections(group, 'female') };
  const cashWeaponTypes = supportedWeaponTypes(genderOptions);
  const bases = {
    0: await exportBase(0, true),
    1: await exportBase(1, true),
  };
  const layers = {};
  const actionSources = { ...bases[0].actionSources };

  for (const gender of [0, 1]) {
    const options = genderOptions[gender];
    const defaultFace = options.face[0];
    const defaultHair = options.hairDefault;
    for (const id of options.face) {
      const layer = await exportAppearanceLayer(gender, 'face', id, bases[gender]);
      addLayer(layers, layerKey('face', id), layer);
    }
    for (const id of options.hair) {
      const layer = await exportAppearanceLayer(gender, 'hair', id, bases[gender]);
      addLayer(layers, layerKey('hair', id), layer);
    }
    // The default appearance is kept in the metadata for clients that need
    // to render an item before a character's explicit appearance arrives.
    bases[gender].defaultAppearance = { face: defaultFace, hair: defaultHair };
  }

  await exportDefaultAppearanceLayers(bases, layers);

  const equipment = new Map(EXTRA_EQUIPMENT.map(item => [String(item.id), item]));
  for (const gender of [0, 1]) {
    for (const part of ['coat', 'shoes', 'weapon']) {
      for (const id of genderOptions[gender][part]) equipment.set(String(id), equipmentDescriptor(id));
    }
  }
  for (const descriptor of equipment.values()) {
    for (const gender of [0, 1]) {
      const layer = await exportEquipmentLayer(gender, descriptor, true);
      addLayer(layers, String(descriptor.id), layer);
      if (gender === 0) Object.assign(actionSources, layer.actionSources);
    }
  }

  // Cash-shop equipment is deliberately kept out of `layers`: the normal
  // appearance catalogue is part of the first-screen preload, while these
  // layers are fetched/registered only when a player equips or previews the
  // corresponding item.  `writeCashAppearance` emits one JSON file per item;
  // the assembler copies those files and their authored PNGs explicitly.
  const cashLayers = {};
  const cashSources = await cashEquipmentDescriptors(new Set(cashWeaponTypes));
  const cashDescriptors = cashSources.descriptors;
  const cashPngsBefore = avatar.reader.pngOutputs.size;
  const cashSkipped = cashSources.skipped;
  for (const descriptor of cashDescriptors) {
    for (const gender of [0, 1]) {
    const layer = descriptor.static
        ? await exportStaticEquipmentLayer(gender, descriptor, bases[gender])
        : descriptor.part === 'weapon'
          ? await exportCashWeaponLayer(gender, descriptor)
        : await exportEquipmentLayer(gender, descriptor, true);
      addLayer(cashLayers, descriptor.itemId, layer);
      if (gender === 0) Object.assign(actionSources, layer.actionSources);
    }
  }
  // Keep the first-screen appearance catalogue small.  Each file below is
  // complete for one item (both genders and, for a weapon, its authored 37/38
  // branches); only the selected file is fetched by the client.
  const cashAppearance = writeCashAppearance(cashLayers, cashSkipped, cashWeaponTypes);

  await exportOrdinaryEquipment(bases, layers, cashAppearance.index);

  const output = {
    contentVersion: 'tms273-avatar-parts',
    sourceVersion: 'TMS273.7',
    source: 'TMS273.7 client WZ / Character + Base / MakeCharInfo.img#000',
    actionSources,
    zmap: [...avatar.zmap].map(([name, index]) => ({ name, index })),
    smap: Object.fromEntries(avatar.smap),
    base: Object.fromEntries(Object.entries(bases).map(([gender, base]) => [gender, base])),
    layers,
    cashAppearance: cashAppearance.index,
    catalog: genderOptions,
  };
  const target = path.join(OUTPUT, 'appearance.json');
  fs.writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    output: path.relative(path.resolve(__dirname, '..'), target),
    layers: Object.keys(layers).length,
    cashAppearanceItems: Object.keys(cashLayers).length,
    cashAppearanceIndexBytes: cashAppearance.bytes,
    cashAppearanceItemBytes: cashAppearance.itemBytes,
    cashAppearancePngs: avatar.reader.pngOutputs.size - cashPngsBefore,
    cashWeaponTypes,
    genders: Object.keys(bases),
    actionKeys: Object.keys(actionSources),
    pngs: avatar.reader.pngOutputs.size,
  }, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  }).finally(() => reader.close());
}

module.exports = {
  DATA,
  OUTPUT,
  MAKE_CHAR_INFO,
  NORMAL_SOURCES,
  groupSections,
  imageForPart,
  equipmentDescriptor,
  exportDefaultAppearanceLayers,
  main,
};
