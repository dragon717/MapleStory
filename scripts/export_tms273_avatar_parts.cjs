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
  sourceInfo,
  staticFace,
  leavesFor,
  compose,
} = avatar;

const ASSETS = path.join(OUTPUT, 'assets/tms273');
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
  { id: 1040002, part: 'coat', image: 'Character/Coat/01040002.img' },
  { id: 1052095, part: 'coat', image: 'Character/Longcoat/01052095.img', longcoat: true },
];

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
  if (part === 'coat') return String(id).startsWith('104')
    ? `Character/Coat/${padded}.img`
    : `Character/Longcoat/${padded}.img`;
  throw new Error(`Unknown appearance part: ${part}`);
}

function equipmentDescriptor(id) {
  const numericId = Number(id);
  if (numericId === 1002067) return EXTRA_EQUIPMENT[0];
  if (numericId === 1040002) return EXTRA_EQUIPMENT[1];
  if (numericId === 1052095) return EXTRA_EQUIPMENT[2];
  if (numericId >= 1040000 && numericId < 1050000) return { id: numericId, part: 'coat', image: imageForPart('coat', numericId) };
  if (numericId >= 1050000 && numericId < 1060000) return { id: numericId, part: 'coat', image: imageForPart('coat', numericId), longcoat: true };
  if (numericId >= 1070000 && numericId < 1080000) return { id: numericId, part: 'shoes', image: imageForPart('shoes', numericId) };
  if (numericId >= 1200000 && numericId < 1800000) return { id: numericId, part: 'weapon', image: imageForPart('weapon', numericId) };
  throw new Error(`Unsupported MakeCharInfo equipment id: ${id}`);
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
  const set = await actionSet([], false, { sources });
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
  SUPPORT.set(String(descriptor.id), {
    part: descriptor.part,
    image: descriptor.image,
    longcoat: descriptor.longcoat,
  });
  const sources = sourceConfig(gender, {
    face: imageForPart('face', gender === 0 ? 20100 : 21700),
    hair: imageForPart('hair', gender === 0 ? 30000 : 31000),
  });
  const normal = await actionSet([String(descriptor.id)], false, { sources });
  const actions = filterActions(normal.actions, part => part.itemId === String(descriptor.id) && part.part === descriptor.part);
  const actionSources = { ...actionSourcesFor(normal) };
  if (includeSkills) {
    const skills = await mageActionSet([String(descriptor.id)], false, { sources });
    Object.assign(actionSources, actionSourcesFor(skills));
    addActions(actions, filterActions(skills.actions, part => part.itemId === String(descriptor.id) && part.part === descriptor.part));
  }
  const info = await sourceInfo(descriptor.image, descriptor.image);
  return {
    id: Number(descriptor.id),
    itemId: String(descriptor.id),
    part: descriptor.part,
    slot: info.islot,
    islot: info.islot,
    vslot: info.vslot,
    source: descriptor.image,
    gender,
    actions,
    actionSources,
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
  // Keep the male set at the direct `actions` key for the game path that has
  // historically rendered the starter avatar; gender-aware callers select
  // the matching entry in actionsByGender.
  existing.actions = existing.actionsByGender['0'];
  existing.actionSources = existing.actionSourcesByGender['0'];
  delete existing.gender;
}

function layerKey(part, id) {
  return `${part}:${id}`;
}

async function main() {
  fs.mkdirSync(ASSETS, { recursive: true });
  await loadSourceTables();
  const rawCatalog = JSON.parse(fs.readFileSync(MAKE_CHAR_INFO, 'utf8'));
  const group = rawCatalog['000'];
  assert(group, 'Missing TMS273 MakeCharInfo/000 source');
  const genderOptions = { 0: groupSections(group, 'male'), 1: groupSections(group, 'female') };
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

  const output = {
    contentVersion: 'tms273-avatar-parts',
    sourceVersion: 'TMS273.7',
    source: 'TMS273.7 client WZ / Character + Base / MakeCharInfo.img#000',
    actionSources,
    zmap: [...avatar.zmap].map(([name, index]) => ({ name, index })),
    smap: Object.fromEntries(avatar.smap),
    base: Object.fromEntries(Object.entries(bases).map(([gender, base]) => [gender, base])),
    layers,
    catalog: genderOptions,
  };
  const target = path.join(OUTPUT, 'appearance.json');
  fs.writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    output: path.relative(path.resolve(__dirname, '..'), target),
    layers: Object.keys(layers).length,
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
  main,
};
