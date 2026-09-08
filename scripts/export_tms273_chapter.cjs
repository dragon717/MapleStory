#!/usr/bin/env node

// Export the TMS273 opening chapter's source nodes and image assets.
// This is a source manifest only.  Missing q363xx script bodies remain P/U
// boundaries in the manifest instead of being invented from display text.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const OUTPUT = path.join(ROOT, 'resources/tms273-export/chapter.json');
const ASSETS = path.join(ROOT, 'resources/tms273-export/assets/tms273/chapter');
const ASSET_PREFIX = '/assets/tms273/chapter/';

const QUEST_IDS = [
  '36301', '36302', '36303', '36304', '36306', '36307',
  '1402', '36337', '36308', '36309', '36310', '36311', '36312', '36313', '36314',
];
const NPC_IDS = [
  '1541000', '1541001', '1541002',
  '1032001', '1541009', '1012100', '1101002', '1541003', '1541004', '1541005',
];
const NPC_LIVES = [
  { mapId: '000010000', lifeId: '1', templateId: '1541000' },
  { mapId: '000020000', lifeId: '8', templateId: '1541001' },
  { mapId: '104000000', lifeId: '10', templateId: '1541002' },
  { mapId: '101000003', lifeId: '0', templateId: '1032001' },
  { mapId: '101010100', lifeId: '18', templateId: '1541009' },
  { mapId: '100000201', lifeId: '0', templateId: '1012100' },
  { mapId: '130000000', lifeId: '1', templateId: '1101002' },
  { mapId: '130090000', lifeId: '1', templateId: '1101002' },
  { mapId: '100000201', lifeId: '5', templateId: '1541003' },
  { mapId: '310040200', lifeId: '3', templateId: '1541004' },
  { mapId: '310050000', lifeId: '4', templateId: '1541005' },
];
const ITEM_SPECS = {
  '4036846': { category: 'Etc', inventoryType: 4 },
  '4033914': { category: 'Etc', inventoryType: 4 },
  '4033919': { category: 'Etc', inventoryType: 4 },
  '4033888': { category: 'Etc', inventoryType: 4 },
  '4033889': { category: 'Etc', inventoryType: 4 },
  '4036847': { category: 'Etc', inventoryType: 4 },
  // This is equipment data.  It is intentionally read from Character/Cap,
  // because no Item/Etc node is authoritative for the Black Wings hat.
  '1003134': { category: 'Cap', inventoryType: 1, sourceId: '01003134' },
};
const ITEM_IDS = Object.keys(ITEM_SPECS);

// These are deliberate source boundaries for the chapter continuation.  The
// QuestData images and map portal fields are present, while the referenced
// executable script bodies are not present in the local TMS273 client source.
// Keep them visible in the artifact so a runtime adapter cannot mistake a
// display string for recovered server behavior.
const MISSING_SOURCES = [
  {
    kind: 'quest-script-bodies',
    quests: QUEST_IDS,
    status: 'unavailable',
    boundary: 'QuestData retains Check/QuestInfo and script-name references, but no matching executable q*.js body was found in the local TMS273 source tree.',
  },
  {
    kind: 'map-portal-script-bodies',
    scripts: ['enterMagiclibrar', 'enterAchter', 'outArchterMap', 'enterBlackWing', 'enterBlackWingHD'],
    status: 'unavailable',
    boundary: 'The named portal entries and targets are present in map WZ, but their script implementations are absent; transport and hat-gating behavior remain P.',
  },
];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

function relative(file) {
  return path.relative(ROOT, path.resolve(file)).split(path.sep).join('/');
}

function sourceFile(file) {
  const absolute = path.resolve(file);
  assert(fs.existsSync(absolute), `missing source archive: ${absolute}`);
  const stat = fs.statSync(absolute);
  return { path: relative(absolute), bytes: stat.size, sha256: sha256File(absolute) };
}

function children(node) {
  return [...(node?.wzProperties || node?.properties || [])];
}

function numericChildren(node) {
  return children(node)
    .filter(child => /^\d+$/.test(child.name))
    .sort((left, right) => Number(left.name) - Number(right.name));
}

function scalarValue(node) {
  const value = node?.wzValue;
  if (typeof value === 'bigint') {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : String(value);
  }
  if (['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (value && typeof value === 'object' && Number.isFinite(Number(value.x)) && Number.isFinite(Number(value.y))) {
    return { x: Number(value.x), y: Number(value.y) };
  }
  return undefined;
}

function scalar(node, name, fallback = null) {
  const value = scalarValue(node?.at?.(name));
  return value === undefined ? fallback : value;
}

function scalarFields(node) {
  return Object.fromEntries(children(node)
    .map(child => [child.name, scalarValue(child)])
    .filter(([, value]) => value !== undefined));
}

function toJson(node, seen = new Set()) {
  const direct = scalarValue(node);
  const nested = children(node);
  if (!nested.length && direct !== undefined) return direct;
  if (seen.has(node)) return '[cycle]';
  const next = new Set(seen).add(node);
  const output = {};
  if (direct !== undefined && nested.length) output._value = direct;
  for (const child of nested) output[child.name] = toJson(child, next);
  return output;
}

function point(node, name) {
  const value = scalar(node, name);
  return value && Number.isFinite(value.x) && Number.isFinite(value.y) ? value : null;
}

async function parseIfImage(node) {
  if (typeof node?.parseImage === 'function' && !node.parsed) await node.parseImage();
  return node;
}

async function archiveFor(reader, logicalSource) {
  const { paths, targetPath } = reader.candidates(logicalSource);
  const segments = targetPath.split('/');
  for (const filePath of paths) {
    const file = await reader.file(filePath);
    let current = file.wzDirectory;
    for (const segment of segments) {
      await parseIfImage(current);
      current = current?.at?.(segment) ?? null;
      if (!current) break;
    }
    if (current) return filePath;
  }
  return null;
}

async function addArchive(reader, sourceFiles, logicalSource) {
  const filePath = await archiveFor(reader, logicalSource);
  assert(filePath, `cannot resolve source archive for ${logicalSource}`);
  sourceFiles.set(path.resolve(filePath), sourceFile(filePath));
}

async function exportFrame(reader, source, sourceFiles) {
  const raw = await reader.get(source);
  const resolved = await reader.resolveFrame(raw);
  for (const item of resolved.chain) {
    if (item.meta?.filePath) sourceFiles.set(path.resolve(item.meta.filePath), sourceFile(item.meta.filePath));
  }
  const result = await reader.frame(raw, ASSETS);
  assert(result.url, `missing PNG for ${source}`);
  const outputFile = path.join(ASSETS, result.url);
  assert(fs.existsSync(outputFile), `PNG was not written: ${source}`);
  return {
    url: `${ASSET_PREFIX}${result.url}`,
    width: result.width,
    height: result.height,
    origin: result.origin,
    x: result.x,
    y: result.y,
    delay: result.delay,
    rawDelay: scalar(raw, 'delay'),
    map: result.map,
    source: result.source,
    resolvedSource: result.resolvedSource,
    sha256: sha256File(outputFile),
  };
}

async function exportAnimation(reader, source, sourceFiles) {
  const node = await parseIfImage(await reader.get(source));
  const frames = numericChildren(node);
  assert(frames.length, `no animation frames: ${source}`);
  const output = [];
  for (const frame of frames) output.push(await exportFrame(reader, `${source}/${frame.name}`, sourceFiles));
  return output;
}

function canonicalMapSource(mapId, suffix = '') {
  return `Map.wz/Map/Map${mapId[0]}/${mapId}.img${suffix ? `/${suffix}` : ''}`;
}

function mapLogicalSource(mapId, suffix = '') {
  return `Map/Map/Map${mapId[0]}/${mapId}.img${suffix ? `/${suffix}` : ''}`;
}

function findFoothold(node, footholdId, currentPath = ['foothold']) {
  const x1 = scalar(node, 'x1');
  const y1 = scalar(node, 'y1');
  const x2 = scalar(node, 'x2');
  const y2 = scalar(node, 'y2');
  if ([x1, y1, x2, y2].every(value => typeof value === 'number') && Number(node?.name) === Number(footholdId)) {
    return { id: Number(footholdId), path: currentPath.join('/'), x1, y1, x2, y2 };
  }
  for (const child of children(node)) {
    const result = findFoothold(child, footholdId, [...currentPath, child.name]);
    if (result) return result;
  }
  return null;
}

function landingY(foothold, x, fallback) {
  if (!foothold || foothold.x1 === foothold.x2) return fallback;
  const ratio = (x - foothold.x1) / (foothold.x2 - foothold.x1);
  return foothold.y1 + (foothold.y2 - foothold.y1) * ratio;
}

function objectSpec(node, objectPath) {
  const fields = scalarFields(node);
  const nested = {};
  for (const child of children(node)) {
    if (scalarValue(child) === undefined) nested[child.name] = toJson(child);
  }
  return { path: objectPath, ...fields, ...(Object.keys(nested).length ? nested : {}) };
}

async function exportNpc(reader, sourceFiles, id, mapLives) {
  const source = `Npc/${id}.img`;
  const node = await parseIfImage(await reader.get(source));
  const info = node.at('info');
  const stringSource = `String/Npc.img/${id}`;
  const stringNode = await reader.get(stringSource);
  await addArchive(reader, sourceFiles, source);
  await addArchive(reader, sourceFiles, stringSource);
  const stand = await exportAnimation(reader, `${source}/stand`, sourceFiles);
  const name = scalar(stringNode, 'name', id);
  const value = {
    name,
    source,
    stand,
    sourceInfo: { source: `${source}/info`, ...scalarFields(info) },
    mapLives: mapLives.map(life => ({
      mapId: life.mapId,
      source: life.source,
      mapLifeHide: life.hide,
      enabledByMapLife: life.hide === 0,
    })),
  };
  return {
    value,
    template: {
      templateId: id,
      name,
      func: '',
      source,
      stand,
      sourceInfo: { source: `${source}/info`, ...scalarFields(info) },
      visibility: { templateInfoHide: scalar(info, 'hide'), mapLives: value.mapLives },
    },
  };
}

function itemSource(id) {
  const spec = ITEM_SPECS[String(id)];
  assert(spec, `missing item specification: ${id}`);
  if (spec.category === 'Cap') return `Character/Cap/${spec.sourceId}.img`;
  const padded = String(id).padStart(8, '0');
  return `Item/Etc/${padded.slice(0, 4)}.img/${padded}`;
}

function itemStringSource(id) {
  const spec = ITEM_SPECS[String(id)];
  assert(spec, `missing item specification: ${id}`);
  return spec.category === 'Cap'
    ? `String/Eqp.img/Eqp/Cap/${id}`
    : `String/Etc.img/Etc/${id}`;
}

async function exportItem(reader, sourceFiles, id) {
  const spec = ITEM_SPECS[String(id)];
  assert(spec, `missing item specification: ${id}`);
  const source = itemSource(id);
  const node = await parseIfImage(await reader.get(source));
  const infoNode = node.at('info');
  assert(infoNode, `missing item info: ${source}/info`);
  const stringSource = itemStringSource(id);
  const stringNode = await reader.get(stringSource);
  await addArchive(reader, sourceFiles, source);
  await addArchive(reader, sourceFiles, stringSource);
  const icon = await exportFrame(reader, `${source}/info/icon`, sourceFiles);
  const iconRaw = await exportFrame(reader, `${source}/info/iconRaw`, sourceFiles);
  const name = scalar(stringNode, 'name', String(id));
  const description = scalar(stringNode, 'desc', '');
  return {
    catalog: {
      inventoryType: spec.inventoryType,
      slotMax: scalar(infoNode, 'slotMax', 1),
      info: scalarFields(infoNode),
      spec: {},
      source,
      sourceItemId: spec.sourceId || String(id).padStart(8, '0'),
      sourceCategory: spec.category,
      spriteSource: `${source}/info/icon`,
      spriteSourceStatus: 'wz-verified',
      name,
      description,
      stringSource,
      requirements: {
        reqLevel: scalar(infoNode, 'reqLevel', null),
        reqJob: scalar(infoNode, 'reqJob', null),
      },
      icon,
      iconRaw,
    },
    image: icon,
  };
}

async function exportQuest(reader, sourceFiles, id) {
  const source = `Quest/QuestData/${id}.img`;
  const node = await parseIfImage(await reader.get(source));
  await addArchive(reader, sourceFiles, source);
  return { source, raw: toJson(node) };
}

async function exportLives(reader, sourceFiles) {
  const output = [];
  const mapCache = new Map();
  for (const spec of NPC_LIVES) {
    const mapSource = mapLogicalSource(spec.mapId);
    const map = mapCache.get(spec.mapId) || await parseIfImage(await reader.get(mapSource));
    mapCache.set(spec.mapId, map);
    const life = map.at('life')?.at(spec.lifeId);
    assert(life, `missing NPC map life ${spec.mapId}/${spec.lifeId}`);
    const lifeSource = mapLogicalSource(spec.mapId, `life/${spec.lifeId}`);
    await addArchive(reader, sourceFiles, lifeSource);
    const x = scalar(life, 'x');
    const sourceY = scalar(life, 'y');
    const footholdId = scalar(life, 'fh');
    const foothold = findFoothold(map.at('foothold'), footholdId);
    const y = landingY(foothold, x, scalar(life, 'cy', sourceY));
    const mapLife = {
      id: `${spec.mapId}-life-${spec.lifeId}`,
      mapId: spec.mapId,
      templateId: spec.templateId,
      x,
      y,
      sourceY,
      facing: scalar(life, 'f') === 0 ? -1 : 1,
      sourceFacing: scalar(life, 'f'),
      footholdId,
      source: canonicalMapSource(spec.mapId, `life/${spec.lifeId}`),
      hide: scalar(life, 'hide', 0),
      cy: scalar(life, 'cy', null),
      rx0: scalar(life, 'rx0', null),
      rx1: scalar(life, 'rx1', null),
      foothold,
    };
    output.push(mapLife);
  }
  return output;
}

async function exportInteraction(reader, sourceFiles) {
  const mapId = '000010000';
  const mapSource = mapLogicalSource(mapId);
  const map = await parseIfImage(await reader.get(mapSource));
  const layer = map.at('5');
  const object = layer?.at('obj')?.at('0');
  assert(object, 'missing 000010000 layer 5 obj/0 leaf pile');
  const objectSource = 'Map/Obj/acc1.img/mapleIsland/maple/6';
  const objectValue = objectSpec(object, '5/obj/0');
  const mapObject = {
    layer: 5,
    oS: scalar(object, 'oS'),
    l0: scalar(object, 'l0'),
    l1: scalar(object, 'l1'),
    l2: scalar(object, 'l2'),
    x: scalar(object, 'x'),
    y: scalar(object, 'y'),
    z: scalar(object, 'z'),
    zM: scalar(object, 'zM'),
    f: scalar(object, 'f'),
    piece: scalar(object, 'piece'),
  };
  assert.deepEqual(mapObject, { layer: 5, oS: 'acc1', l0: 'mapleIsland', l1: 'maple', l2: '6', x: -432, y: 646, z: 9, zM: 2, f: 0, piece: 0 }, 'leaf pile source changed');
  await addArchive(reader, sourceFiles, objectSource);
  const frames = await exportAnimation(reader, objectSource, sourceFiles);
  const firstFrame = frames[0];
  const frameRect = {
    x: mapObject.x + firstFrame.x,
    y: mapObject.y + firstFrame.y,
    width: firstFrame.width,
    height: firstFrame.height,
    right: mapObject.x + firstFrame.x + firstFrame.width,
    bottom: mapObject.y + firstFrame.y + firstFrame.height,
  };
  const reactor = map.at('reactor');
  const reactorChildren = children(reactor).map(child => child.name);
  return {
    questId: '36301',
    mapId,
    label: '落葉堆（P互動綁定）',
    mapLayerKey: 'obj-5-0',
    x: mapObject.x,
    y: mapObject.y,
    source: objectSource,
    objectPath: objectValue.path,
    object: objectValue,
    mapObject,
    frameRect,
    hitTest: { coordinateSpace: 'world', rect: frameRect, sourceAnchor: { x: mapObject.x, y: mapObject.y } },
    frames,
    reactor: {
      source: `${canonicalMapSource(mapId)}/reactor`,
      present: reactorChildren.length > 0,
      childCount: reactorChildren.length,
      children: reactorChildren,
    },
    interactionEvidence: 'T: Map layer 5 object 0 is the visible acc1/mapleIsland/maple/6 leaf pile at (-432,646), rendered rect (-539,619)-(-324,674). The original q36301 script binding is absent; binding this source object is P. No reactor child exists in the authored map.',
  };
}

async function main() {
  fs.rmSync(ASSETS, { recursive: true, force: true });
  fs.mkdirSync(ASSETS, { recursive: true });
  const reader = createReader(DATA);
  const sourceFiles = new Map();
  try {
    const npcSpawns = await exportLives(reader, sourceFiles);
    const livesByNpc = Object.fromEntries(NPC_IDS.map(id => [id, npcSpawns.filter(spawn => spawn.templateId === id)]));
    const npcs = {};
    const npcTemplates = [];
    for (const id of NPC_IDS) {
      const exported = await exportNpc(reader, sourceFiles, id, livesByNpc[id]);
      npcs[id] = exported.value;
      npcTemplates.push(exported.template);
    }

    const items = {};
    const itemImages = {};
    for (const id of ITEM_IDS) {
      const exported = await exportItem(reader, sourceFiles, id);
      items[id] = exported.catalog;
      itemImages[id] = exported.image;
    }

    const quests = {};
    for (const id of QUEST_IDS) quests[id] = await exportQuest(reader, sourceFiles, id);
    const interaction = await exportInteraction(reader, sourceFiles);

    const output = {
      contentVersion: 'tms273-chapter',
      sourceVersion: 'TMS273.7',
      source: {
        authoritative: 'TMS273.7 client WZ; generated quest mirrors are cross-checks only',
        classes: {
          T: [
            'NPC templates, map life, foothold geometry, map objects, item info/icon, String names/descriptions, QuestData Check/QuestInfo',
          ],
          R: [
            'Quest state/objective structure only; no TMS273 IDs or rewards are inferred from the guide',
          ],
          P: [
            'q36301 leaf-pile click adapter, q1402/q36308–q36314 dialogue/transport scripts, and the selected 4033919 ticket mapping where source Act is empty',
            'enterMagiclibrar/enterAchter/outArchterMap/enterBlackWing transport and hat-gating adapters because their script bodies are absent',
          ],
        },
        ruleSources: [
          { class: 'R', url: 'https://maplestory.nexon.co.jp/gameguide/basic/quest/', scope: 'quest state/objective structure only' },
        ],
      },
      quests,
      npcs,
      npcTemplates,
      npcSpawns,
      interaction,
      items,
      itemImages,
      missingSources: MISSING_SOURCES,
      // q36304's Act is empty and q36306 Check/1 has no item node. 4033919 is
      // selected as a P mapping because its source description names Basil.
      ticketItemId: '4033919',
      ticketItemIds: ['4033914', '4033919'],
      ticketResolution: {
        status: 'P-selected',
        selectedForP: '4033919',
        selectionBasis: 'T: String/Etc.img/Etc/4033919 explicitly says to give the ticket to Basil; this does not prove the missing q36304 Act reward.',
        candidates: [
          { itemId: '4033914', description: '前往維多利亞島的船票。拿給糖果。', source: 'String/Etc.img/Etc/4033914' },
          { itemId: '4033919', description: '前往維多利亞島的船票。交給楓之港的船長，霸西力。', source: 'String/Etc.img/Etc/4033919' },
        ],
        boundary: 'TMS273 QuestData/36304/Act is empty and 36306/Check/1 has no item ID; 4033919 is a P mapping, not a recovered original Act reward.',
      },
      pUnknown: [
        'q36301–q36307 executable script bodies are absent; runtime dialogue, click completion, transport and job branch remain P.',
        'q1402/q36337/q36308–q36314 QuestData is source-backed, but the referenced executable script bodies are absent; Hans/Des/Helena/Neinheart/Olivia/Rendo positions are source-backed only.',
        'The named enterMagiclibrar, enterAchter, outArchterMap, enterBlackWing and enterBlackWingHD portal script bodies are absent; map targets alone do not establish runtime transport or the q36313 hat gate.',
        'The authored q36301 visual interaction is layer 5 obj/0 acc1/mapleIsland/maple/6; original script binding and runtime quest gating remain P.',
        'The q36304→q36306 ticket mapping is absent from QuestData Act/Check; 4033919 is selected only as a P mapping while 4033914 remains a real candidate.',
      ],
      sourceFiles: [...sourceFiles.values()].sort((left, right) => left.path.localeCompare(right.path)),
    };
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      output: relative(OUTPUT),
      npcs: NPC_IDS,
      npcSpawns: npcSpawns.length,
      interaction: { mapId: interaction.mapId, mapLayerKey: interaction.mapLayerKey, frameRect: interaction.frameRect, frames: interaction.frames.length, reactor: interaction.reactor.childCount },
      items: ITEM_IDS,
      ticketItemId: output.ticketItemId,
      ticketItemIds: output.ticketItemIds,
      sourceFiles: output.sourceFiles.length,
    }, null, 2));
  } finally {
    reader.close();
  }
}

if (require.main === module) main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});

module.exports = { DATA, OUTPUT, ASSETS, main };
