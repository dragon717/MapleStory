#!/usr/bin/env node

// Minimal contract check for the source-backed NPC quest marker.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'resources/tms273-export');
const MANIFEST = path.join(OUTPUT, 'npc-marker.json');
const PREFIX = '/assets/tms273/';
const SOURCE = 'UI/UIWindow2.img/QuestIcon/30';
const SOURCE_FRAME_COUNT = 4;

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function localAsset(url) {
  assert(typeof url === 'string' && url.startsWith(PREFIX), `invalid asset URL: ${url}`);
  return path.join(OUTPUT, 'assets/tms273', url.slice(PREFIX.length));
}

function checkFrame(frame, index) {
  const label = `frame ${index}`;
  assert.equal(frame.index, index, `${label}: index changed`);
  assert.equal(frame.source, `${SOURCE}/${index}`, `${label}: source changed`);
  assert(frame.resolvedSource, `${label}: resolved source missing`);
  assert(frame.outlink, `${label}: outlink missing`);
  assert(frame.origin && Number.isFinite(frame.origin.x) && Number.isFinite(frame.origin.y), `${label}: origin missing`);
  assert.equal(frame.x, -frame.origin.x, `${label}: x is not -origin.x`);
  assert.equal(frame.y, -frame.origin.y, `${label}: y is not -origin.y`);
  assert(Number.isInteger(frame.width) && frame.width > 0, `${label}: width missing`);
  assert(Number.isInteger(frame.height) && frame.height > 0, `${label}: height missing`);
  assert.equal(frame.rawDelay, null, `${label}: static source unexpectedly has delay`);
  assert.equal(frame.delaySource, 'missing', `${label}: missing-delay provenance missing`);
  assert.equal(frame.delay, 0, `${label}: static marker delay must be zero`);
  assert(/^[a-f0-9]{64}$/.test(frame.sha256), `${label}: asset hash missing`);
  assert(Number.isInteger(frame.bytes) && frame.bytes > 0, `${label}: asset size missing`);
  const file = localAsset(frame.url);
  assert(fs.existsSync(file), `${label}: PNG missing: ${file}`);
  assert.equal(fs.statSync(file).size, frame.bytes, `${label}: PNG size changed`);
  assert.equal(digest(file), frame.sha256, `${label}: PNG hash changed`);
  assert.equal(fs.readFileSync(file).subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${label}: not a PNG`);
}

const data = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
assert.equal(data.status, 'complete');
assert.equal(data.sourceVersion, 'TMS273.7');
assert.equal(data.sourceNode, SOURCE);
assert.equal(data.npcQuestAvailable.frames.length, 1, 'static quest marker frame count changed');
assert.deepEqual(data.npcQuestAvailable.frames.map(frame => frame.delay), [0]);
assert.deepEqual(data.npcQuestAvailable.frames.map(frame => frame.origin), [
  { x: 21, y: 28 },
]);
assert.deepEqual(data.npcQuestAvailable.frames.map(frame => [frame.width, frame.height]), [
  [44, 55],
]);
data.npcQuestAvailable.frames.forEach(checkFrame);
assert.equal(data.provenance.sourceFrames.length, SOURCE_FRAME_COUNT, 'source frame metadata missing');
assert.deepEqual(data.provenance.sourceFrames.map(frame => frame.origin), [
  { x: 21, y: 28 },
  { x: 21, y: 29 },
  { x: 21, y: 30 },
  { x: 21, y: 29 },
]);
assert.deepEqual(data.provenance.sourceFrames.map(frame => [frame.width, frame.height]), [
  [44, 55],
  [44, 56],
  [44, 57],
  [44, 56],
]);
for (const [index, frame] of data.provenance.sourceFrames.entries()) {
  assert.equal(frame.index, index);
  assert.equal(frame.source, `${SOURCE}/${index}`);
  assert.equal(frame.rawDelay, null);
  assert.equal(frame.delaySource, 'missing');
  assert.equal(frame.x, -frame.origin.x);
  assert.equal(frame.y, -frame.origin.y);
  assert(frame.resolvedSource);
  assert(frame.outlink);
}
assert.equal(data.target.mapId, '001020000');
assert.equal(data.target.lifeId, '001020000-life-1');
assert.equal(data.target.templateId, '10201');
assert.equal(data.target.name, '漢斯');
assert(data.provenance.sourceFiles.length > 0, 'source archive provenance missing');
for (const source of data.provenance.sourceFiles) {
  const file = path.join(ROOT, source.path);
  assert(fs.existsSync(file), `source archive missing: ${source.path}`);
  assert(source.bytes > 0, `source archive empty: ${source.path}`);
  assert.equal(digest(file), source.sha256, `source archive hash changed: ${source.path}`);
}

console.log(JSON.stringify({
  manifest: path.relative(ROOT, MANIFEST).split(path.sep).join('/'),
  sourceNode: data.sourceNode,
  frames: data.npcQuestAvailable.frames.length,
  delays: data.npcQuestAvailable.frames.map(frame => frame.delay),
  sizes: data.npcQuestAvailable.frames.map(frame => [frame.width, frame.height]),
  target: `${data.target.mapId}/${data.target.templateId}`,
  sourceFiles: data.provenance.sourceFiles.length,
}, null, 2));
