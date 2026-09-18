const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'client/public-tms273');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const manifest = read(path.join(assets, 'assets/manifest.json'));
const catalogs = Object.fromEntries(['mounts', 'chairs'].map(kind => [kind, read(path.join(root, 'shared', kind + '.json')).items]));
const references = new Set();
let sceneCount = 0;

function frames(list, label) {
  for (const frame of list) {
    assert(Number.isFinite(frame.delay) && frame.delay >= 0, `${label}: invalid delay`);
    assert(frame.parts.length, `${label}: empty frame`);
    for (const part of frame.parts) {
      for (const key of ['x', 'y', 'z', 'width', 'height']) assert(Number.isFinite(part[key]), `${label}: invalid ${key}`);
      assert(part.width > 0 && part.height > 0, `${label}: empty canvas`);
      assert(part.url.startsWith('/assets/tms273/'), `${label}: foreign image`);
      references.add(part.url);
    }
  }
}
for (const kind of ['mounts', 'chairs']) {
  for (const [id, item] of Object.entries(catalogs[kind])) {
    if (kind === 'chairs' && !/^Item\/Install\/(0301\d*|0302)\//.test(item.source)) continue;
    const entry = manifest.rideScenes?.[kind]?.[id];
    assert(entry, `${kind}/${id}: silently omitted from scene audit`);
    if (!entry.url) {
      assert(entry.reason, `${kind}/${id}: missing without reason`);
      continue;
    }
    references.add(entry.url);
    const scene = read(path.join(assets, entry.url.slice(1)));
    assert.equal(Number(scene.itemId), Number(id), `scene bound to wrong item: ${entry.url}`);
    for (const [action, list] of Object.entries(scene.actions)) frames(list, `${id}/${action}`);
    for (const layer of scene.effects ?? []) frames(layer.frames, `${id}/effect`);
    for (const variant of Object.values(scene.variants ?? {})) {
      for (const [action, list] of Object.entries(variant.actions)) frames(list, `${id}/variant/${action}`);
    }
    sceneCount++;
  }
}
for (const url of references) assert(fs.statSync(path.join(assets, url.slice(1))).size > 0, `missing/empty ${url}`);
const boar = read(path.join(assets, manifest.rideScenes.mounts['1902000'].url.slice(1)));
assert(boar.actions.stand1?.length && boar.actions.walk1?.length && boar.actions.jump?.length, 'boar movement art absent');
assert.deepEqual(boar.actions.stand1[0].anchors.navel, { x: 3, y: -51 }, 'WZ map is origin-relative; never subtract origin twice');
const saddle = read(path.join(assets, manifest.rideScenes.mounts['1912000'].url.slice(1)));
assert(saddle.variants?.['1902000']?.actions.stand1?.length, 'saddle mount-specific branch omitted');
const chair = read(path.join(assets, manifest.rideScenes.chairs['3010000'].url.slice(1)));
assert(chair.effects?.some(layer => layer.frames.length && layer.pos === 1), 'chair effect/brow binding absent');
const ridingChair = read(path.join(assets, manifest.rideScenes.chairs['3010029'].url.slice(1)));
assert(Object.values(ridingChair.actions).some(list => list.length), 'tamingMob chair omitted');
for (const id of ['1902000', '1912000', '3010000']) {
  assert(manifest.items[id]?.url, `shared icon missing ${id}`);
  assert.deepEqual(manifest.items[id], manifest.items[id.padStart(8, '0')], `split icon aliases ${id}`);
}
for (const relative of ['assets/manifest.json', 'assets/entry/appearance.json']) {
  const file = path.join(assets, relative), bytes = fs.readFileSync(file);
  for (const [ext, decompress] of [['.br', zlib.brotliDecompressSync], ['.gz', zlib.gunzipSync]]) {
    if (fs.existsSync(file + ext)) assert(bytes.equals(decompress(fs.readFileSync(file + ext))), `stale compressed ${relative}${ext}`);
  }
}
console.log(`Ride/chair catalogue coverage, ${sceneCount} scenes, ${references.size} resource references, icons and compressed payloads passed.`);
