#!/usr/bin/env node

// Small source/manifest regression check for the paper-doll exporter.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'resources/tms273-export');
const ASSET_ROOT = path.join(OUTPUT, 'assets/tms273');
const data = JSON.parse(fs.readFileSync(path.join(OUTPUT, 'avatar.json'), 'utf8'));
const avatar = data.avatar;
const STATIC_ACTIONS = new Set(['sit', 'prone']);

assert.deepEqual(avatar.look.weapon, ['Weapon', '01302000.img']);

const expectedLoadouts = [
  '1002067', '1040002', '1052095', '1302000', 'empty',
  '1002067+1040002', '1002067+1052095', '1002067+1302000',
  '1040002+1302000', '1002067+1040002+1302000',
  '1052095+1302000', '1002067+1052095+1302000',
];
assert.deepEqual(Object.keys(avatar.equipmentLoadouts), expectedLoadouts);
assert.equal(avatar.zmap.length, new Set(avatar.zmap.map(entry => entry.name)).size);
assert.equal(avatar.zmap.length, new Set(avatar.zmap.map(entry => entry.index)).size);

function point(part, name) {
  const map = part.map?.[name];
  return map && { x: part.x + part.origin.x + map.x, y: part.y + part.origin.y + map.y };
}

function same(a, b, context) {
  assert(a && b, `${context}: missing named anchor`);
  assert.equal(a.x, b.x, `${context}: x mismatch`);
  assert.equal(a.y, b.y, `${context}: y mismatch`);
}

function checkActionSet(name, actions) {
  for (const [action, frames] of Object.entries(actions)) {
    assert(frames.length, `${name}/${action}: no frames`);
    for (const [index, frame] of frames.entries()) {
      assert(STATIC_ACTIONS.has(action) ? frame.delay >= 0 : frame.delay > 0,
        `${name}/${action}/${index}: invalid body delay`);
      const body = frame.parts.find(part => part.part === 'body' && part.name === 'body');
      const head = frame.parts.find(part => part.part === 'head' && part.name === 'head');
      assert(body && head, `${name}/${action}/${index}: body/head missing`);
      same(point(body, 'neck'), point(head, 'neck'), `${name}/${action}/${index} neck`);
      const arm = frame.parts.find(part => part.part === 'body' && part.name === 'arm');
      const weapon = frame.parts.find(part => part.part === 'weapon');
      if (arm?.map?.hand && weapon?.map?.hand) same(point(arm, 'hand'), point(weapon, 'hand'), `${name}/${action}/${index} hand`);
      for (const part of frame.parts) {
        assert(Number.isInteger(part.z), `${name}/${action}/${index}/${part.name}: z missing`);
        assert(part.url.startsWith('/assets/tms273/'), `${name}/${action}/${index}/${part.name}: wrong URL root`);
        assert(fs.existsSync(path.join(ASSET_ROOT, part.url.slice('/assets/tms273/'.length))), `${part.url}: PNG missing`);
        if (part.anchor) assert(point(part, part.anchor), `${name}/${action}/${index}/${part.name}: anchor missing`);
        if (part.anchor === 'navel') same(point(part, 'navel'), frame.anchors.navel, `${name}/${action}/${index}/${part.name} navel`);
        if (part.anchor === 'brow') same(point(part, 'brow'), frame.anchors.brow, `${name}/${action}/${index}/${part.name} brow`);
      }
      if (action === 'ladder' || action === 'rope') assert(!frame.parts.some(part => part.part === 'face'), `${name}/${action}/${index}: face must follow body.face=0`);
    }
  }
}

checkActionSet('starter', avatar.actions);
for (const [key, loadout] of Object.entries(avatar.equipmentLoadouts)) checkActionSet(key, loadout.actions);
for (const [action, frames] of Object.entries(avatar.actions)) {
  if (action === 'ladder' || action === 'rope' || action === 'climb' || STATIC_ACTIONS.has(action)) continue;
  assert(frames.every(frame => frame.parts.some(part => part.part === 'weapon' && part.source?.includes('Character/Weapon/01302000.img'))), `${action}: starter look must use 273 weapon 01302000`);
}
for (const [key, loadout] of Object.entries(avatar.equipmentLoadouts)) {
  const hasWeapon = Object.values(loadout.actions).some(frames => frames.some(frame => frame.parts.some(part => part.part === 'weapon')));
  if (key === 'empty' || !key.includes('1302000')) assert.equal(hasWeapon, false, `${key}: empty/non-weapon loadout must not add a weapon`);
  if (key.includes('1302000')) assert.equal(hasWeapon, true, `${key}: weapon loadout lost its weapon`);
}
assert.deepEqual(avatar.actionSources.stand.delays, [500, 500, 500]);
assert.deepEqual(avatar.actionSources.walk.delays, [180, 180, 180, 180]);
assert.deepEqual(avatar.actionSources.jump.delays, [200]);
assert.deepEqual(avatar.actionSources.attack.delays, [300, 150, 350]);
assert.deepEqual(avatar.actionSources.ladder.delays, [250, 250]);
assert.deepEqual(avatar.actionSources.rope.delays, [250, 250]);
console.log(JSON.stringify({
  contentVersion: data.contentVersion,
  actions: Object.fromEntries(Object.entries(avatar.actionSources).map(([name, value]) => [name, value.frameCount])),
  loadouts: Object.keys(avatar.equipmentLoadouts).length,
  pngs: new Set(Object.values(avatar.actions).flat().flatMap(frame => frame.parts.map(part => part.url))).size,
}, null, 2));
