const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const assemblyRoot = process.env.MAPLE_ASSEMBLY_OUTPUT_ROOT
  ? path.resolve(process.env.MAPLE_ASSEMBLY_OUTPUT_ROOT)
  : root;
const expectedContentVersion = 'tms273-49';
const mapId = '100000000';
const rail = JSON.parse(fs.readFileSync(path.join(root, 'shared/henesys-rail.json'), 'utf8'));
const sourceModelPath = path.join(root, 'resources/scenes/henesys/rail-v1/models/rail-v1.glb');
const publicRoot = path.join(assemblyRoot, 'client/public-tms273');
const publishedModelPath = path.join(publicRoot, 'assets/henesys/rail-v1.glb');

const readJson = (base, relative) => JSON.parse(fs.readFileSync(path.join(base, relative), 'utf8'));
const finite = (value, name) => assert(Number.isFinite(value), `${name} must be finite`);
const sameNumber = (actual, expected, name) => assert(Math.abs(actual - expected) < 1e-7, `${name}: ${actual} !== ${expected}`);

assert.equal(rail.mapId, mapId, 'shared/henesys-rail.json mapId changed');
for (const [name, value] of Object.entries(rail)) {
  if (name !== 'mapId' && name !== 'platforms' && name !== 'spawn' && name !== 'bounds' && name !== 'decks' && name !== 'ladders') finite(value, `rail.${name}`);
}
assert(Array.isArray(rail.platforms) && rail.platforms.length > 1, 'rail must have multiple platforms');
assert(rail.platformThickness > 0 && rail.platformDepth > 0, 'rail platform dimensions must be positive');
assert(rail.bounds && rail.spawn, 'rail bounds and spawn are required');
for (const [name, value] of Object.entries(rail.bounds)) finite(value, `rail.bounds.${name}`);
finite(rail.spawn.x, 'rail.spawn.x'); finite(rail.spawn.y, 'rail.spawn.y');

const platformIds = new Set();
for (let i = 0; i < rail.platforms.length; i++) {
  const platform = rail.platforms[i];
  assert(Number.isInteger(platform.id) && platform.id > 0, `rail platform ${i} id is invalid`);
  assert(!platformIds.has(platform.id), `duplicate rail platform id ${platform.id}`);
  platformIds.add(platform.id);
  for (const name of ['x1', 'y1', 'x2', 'y2']) finite(platform[name], `rail platform ${platform.id}.${name}`);
  assert(platform.x2 > platform.x1, `rail platform ${platform.id} has no width`);
  assert.equal(platform.forbidFallDown, 1, `rail platform ${platform.id} must be a solid jump platform`);
  if (i === 0) {
    assert.equal(platform.x1, rail.bounds.xMin, 'first rail platform must start at bounds.xMin');
  } else {
    const previous = rail.platforms[i - 1];
    assert.equal(platform.x1, previous.x2, `rail platforms ${previous.id} and ${platform.id} are not continuous`);
    assert.equal(Math.abs(platform.y1 - previous.y2), 50, `rail step ${previous.id}->${platform.id} must be 50 pixels`);
  }
}
assert.equal(rail.platforms.at(-1).x2, rail.bounds.xMax, 'last rail platform must end at bounds.xMax');

const platformAt = x => {
  finite(x, 'platform lookup x');
  return rail.platforms.find((platform, index) => x >= platform.x1 && (x < platform.x2 || index === rail.platforms.length - 1));
};
const spawnPlatform = platformAt(rail.spawn.x);
assert(spawnPlatform, 'rail spawn is outside all platforms');
sameNumber(rail.spawn.y, spawnPlatform.y1, 'rail spawn height');

function parseGlb(file, label) {
  assert(file.length >= 20, `${label} is too short to be a GLB`);
  assert.equal(file.toString('ascii', 0, 4), 'glTF', `${label} has invalid GLB magic`);
  assert.equal(file.readUInt32LE(4), 2, `${label} must use glTF 2`);
  assert.equal(file.readUInt32LE(8), file.length, `${label} length header is stale`);

  const JSON_CHUNK = 0x4e4f534a; // JSON
  const BIN_CHUNK = 0x004e4942; // BIN\0
  let offset = 12;
  let jsonChunk;
  let binaryChunk;
  while (offset < file.length) {
    assert(offset + 8 <= file.length, `${label} has a truncated chunk header`);
    const length = file.readUInt32LE(offset);
    const type = file.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    assert(end <= file.length, `${label} has a chunk outside the file`);
    const payload = file.subarray(start, end);
    if (type === JSON_CHUNK) {
      assert(!jsonChunk, `${label} has duplicate JSON chunks`);
      jsonChunk = payload;
    } else if (type === BIN_CHUNK) {
      assert(!binaryChunk, `${label} has duplicate BIN chunks`);
      binaryChunk = { start, length };
    }
    offset = end;
  }
  assert.equal(offset, file.length, `${label} chunk lengths do not cover the file`);
  assert(jsonChunk, `${label} is missing its JSON chunk`);
  assert(binaryChunk, `${label} is missing its binary chunk`);

  let gltf;
  try {
    gltf = JSON.parse(jsonChunk.toString('utf8').replace(/\0+$/u, '').trim());
  } catch (error) {
    throw new Error(`${label} JSON chunk is invalid: ${error.message}`);
  }
  assert.equal(gltf.asset?.version, '2.0', `${label} asset version must be 2.0`);
  assert(Array.isArray(gltf.buffers) && gltf.buffers.length === 1, `${label} must have one binary buffer`);
  assert(gltf.buffers[0].byteLength <= binaryChunk.length, `${label} binary buffer exceeds its BIN chunk`);
  for (const [index, view] of (gltf.bufferViews ?? []).entries()) {
    const startInBin = view.byteOffset ?? 0;
    assert.equal(view.buffer, 0, `${label} bufferView ${index} must use the embedded buffer`);
    assert(startInBin >= 0 && view.byteLength >= 0 && startInBin + view.byteLength <= binaryChunk.length,
      `${label} bufferView ${index} exceeds its BIN chunk`);
  }
  return gltf;
}

const sourceFile = fs.readFileSync(sourceModelPath);
const gltf = parseGlb(sourceFile, 'rail-v1 source GLB');
assert(Array.isArray(gltf.images) && gltf.images.length > 0, 'rail-v1 GLB must contain embedded textures');
for (const [index, image] of gltf.images.entries()) {
  assert(Number.isInteger(image.bufferView), `rail-v1 texture ${index} is not embedded`);
  assert.equal(image.uri, undefined, `rail-v1 texture ${index} must not use an external URI`);
  assert.match(image.mimeType ?? '', /^image\//u, `rail-v1 texture ${index} has no image MIME type`);
  const view = gltf.bufferViews[image.bufferView];
  assert(view, `rail-v1 texture ${index} references a missing bufferView`);
}

const nodes = gltf.nodes ?? [];
const platformNode = nodes.find(node => node.name === 'HR_Platform');
assert(platformNode?.mesh !== undefined, 'rail-v1 GLB must contain HR_Platform geometry');
assert.equal(platformNode.extras?.role, 'platform', 'HR_Platform must be marked as a platform');
assert.deepEqual(platformNode.extras?.footholdIds, rail.platforms.map(platform => platform.id),
  'GLB platform IDs differ from shared/henesys-rail.json');
sameNumber(platformNode.extras?.platformThickness, rail.platformThickness, 'GLB platform thickness');
for (const deck of rail.decks) {
  const node=nodes.find(n=>n.extras?.footholdId===deck.id);
  assert(node?.mesh!==undefined,`upper deck mesh missing: ${deck.id}`);
  sameNumber(node.extras.platformThickness,rail.deckThickness,'upper deck thickness');
}

const quaternius = nodes.filter(node => node.extras?.role === 'CC0_Quaternius');
assert(quaternius.length > 0, 'rail-v1 GLB must contain Quaternius objects');
assert(quaternius.every(node => node.mesh !== undefined), 'every Quaternius object must contain mesh geometry');
assert(quaternius.some(node => String(node.name).startsWith('HR_Nature_')), 'rail-v1 GLB is missing Quaternius nature objects');
const landmarks = nodes.filter(node => node.extras?.landmark);
for (const name of ['WestTower','Market','MarketTower','ParkCottage','MayaHouse','Windmill','HairSalon','Shop','ArcherHall','ParkGate']) {
  assert(landmarks.some(node => node.extras.landmark === name), `Henesys landmark missing: ${name}`);
}
assert.equal(landmarks.length, 10, 'Henesys must retain its ten authored landmarks');

const manifest = readJson(assemblyRoot, 'client/public-tms273/assets/manifest.json');
const gameplay = readJson(assemblyRoot, 'client/public-tms273/assets/gameplay.json');
const serverGameplay = readJson(assemblyRoot, 'shared/gameplay.json');
const serverMaps = readJson(assemblyRoot, 'shared/maps.json');
assert.equal(manifest.contentVersion, expectedContentVersion, `candidate manifest must be ${expectedContentVersion}`);
assert.equal(gameplay.contentVersion, expectedContentVersion, `candidate gameplay must be ${expectedContentVersion}`);
assert.equal(serverGameplay.contentVersion, expectedContentVersion, `candidate shared gameplay must be ${expectedContentVersion}`);

const candidateMap = manifest.mapCatalog?.maps?.find(map => map.id === mapId);
const candidateServerMap = serverMaps.maps?.find(map => map.id === mapId);
assert(candidateMap, `candidate manifest is missing map ${mapId}`);
assert(candidateServerMap, `candidate shared maps is missing map ${mapId}`);
for (const [label, map] of [['candidate manifest', candidateMap], ['candidate shared maps', candidateServerMap]]) {
  assert.deepEqual(map.footholds, [...rail.platforms, ...rail.decks], `${label} platforms differ from shared/henesys-rail.json`);
  assert.deepEqual(map.bounds, rail.bounds, `${label} bounds differ from shared/henesys-rail.json`);
  assert.deepEqual({ x: map.spawn.x, y: map.spawn.y }, rail.spawn, `${label} spawn differs from shared/henesys-rail.json`);
  assert.deepEqual(map.ladders, rail.ladders, `${label} must retain climbing links`);
  for (const ladder of rail.ladders) {
    assert(rail.decks.some(d=>d.x1<=ladder.x&&d.x2>=ladder.x&&d.y1===ladder.y1), 'ladder top must land on a deck');
    assert.equal(platformAt(ladder.x).y1,ladder.y2,'ladder bottom must reach the street');
  }
}

function checkNpcHeights(data, label) {
  const npcs = (data.npcSpawns ?? []).filter(npc => npc.mapId === mapId);
  assert(npcs.length > 0, `${label} has no Henesys NPC spawns`);
  for (const npc of npcs) {
    const platform = platformAt(npc.x);
    assert(platform, `${label} NPC ${npc.id} is outside the rail`);
    sameNumber(npc.y, platform.y1, `${label} NPC ${npc.id} height`);
    assert.equal(npc.footholdId, platform.id, `${label} NPC ${npc.id} foothold`);
  }
  return npcs.length;
}
const npcCount = checkNpcHeights(gameplay, 'candidate gameplay');
checkNpcHeights(serverGameplay, 'candidate shared gameplay');

const publishedFile = fs.readFileSync(publishedModelPath);
parseGlb(publishedFile, 'published rail-v1 GLB');
assert.equal(Buffer.compare(sourceFile, publishedFile), 0, 'published rail-v1 GLB differs from the source GLB');

console.log(`PASS: rail-v1 GLB (${sourceFile.length} bytes), ${rail.platforms.length} continuous 50px platforms, ${quaternius.length} Quaternius objects, ${npcCount} Henesys NPC heights, candidate content ${expectedContentVersion}.`);
