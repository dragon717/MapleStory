#!/usr/bin/env node

// Read-only contract check for export_tms273_combat.cjs.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'resources/tms273-export');
const manifestPath = path.join(OUTPUT, 'combat-extra.json');

function localAsset(url) {
  assert.equal(typeof url, 'string', 'asset URL is missing');
  const prefix = '/assets/tms273/';
  assert(url.startsWith(prefix), `unexpected asset URL: ${url}`);
  return path.join(OUTPUT, 'assets/tms273', url.slice(prefix.length));
}

function finitePoint(point, label) {
  assert(point && Number.isFinite(point.x) && Number.isFinite(point.y), `${label} is not finite`);
}

const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const attack = data.attack;
assert.equal(data.contentVersion, 'tms273-combat');
assert.equal(attack.weaponSource, 'Character/Weapon/01302000.img');
assert.equal(attack.afterImage, 'swordOL');
assert.equal(attack.afterimage.source, 'Character/Afterimage/swordOL.img/0/swingO1');
assert.equal(attack.afterimage.firstFrame, 2);
assert.equal(attack.afterimage.startMs, 450);
assert.deepEqual(attack.bodyFrameDelaysMs, [300, 150, 350]);
assert.equal(attack.durationMs, 800);
assert.equal(attack.hitAtMs, 450);
finitePoint(attack.hitbox.lt, 'hitbox.lt');
finitePoint(attack.hitbox.rb, 'hitbox.rb');
assert.equal(attack.hitbox.lt.x, -88);
assert.equal(attack.hitbox.lt.y, -62);
assert.equal(attack.hitbox.rb.x, -18);
assert.equal(attack.hitbox.rb.y, -6);

assert(attack.afterimage.frames.length > 0, 'afterimage has no frames');
for (const frame of attack.afterimage.frames) {
  assert(frame.width > 0 && frame.height > 0 && frame.delay > 0, 'invalid afterimage frame');
  finitePoint(frame.lt, 'frame.lt');
  finitePoint(frame.rb, 'frame.rb');
  assert.equal(frame.width, 79);
  assert.equal(frame.height, 68);
  assert(frame.resolvedSource.includes('Character/Afterimage/_Canvas/swordOL.img'));
  assert(fs.existsSync(localAsset(frame.url)), `missing afterimage asset: ${frame.url}`);
}

const sound = data.avatarAttackSound;
assert.equal(sound.source, 'Sound/Weapon.img/swordL/Attack');
if (sound.status === 'exported') {
  const soundPath = localAsset(sound.url);
  assert.equal(sound.format, 'mp3');
  assert.equal(sound.bytes, 1326);
  assert(fs.existsSync(soundPath), `missing attack sound: ${sound.url}`);
  assert.equal(fs.statSync(soundPath).size, sound.bytes);
} else {
  assert.equal(sound.url, undefined, 'an unavailable sound must not have a fabricated URL');
  assert(sound.reason, 'an unavailable sound must explain the source failure');
}

assert.equal(data.initialPlayer.status, 'unavailable');
assert.equal(data.initialPlayer.level, null);
assert.equal(data.initialPlayer.exp, null);
assert.equal(data.initialPlayer.stats, null);
assert(data.initialPlayer.reason.includes('不伪造'));
const makeChar = data.initialPlayer.checkedSources.find(source => source.source === 'Etc/MakeCharInfo.img/000');
assert.equal(makeChar?.available, true);
const expTable = data.initialPlayer.checkedSources.find(source => source.source === 'Etc/ExpTable.img');
assert.equal(expTable?.available, false);
const excluded = data.initialPlayer.excludedSources.find(source => source.source.includes('MakeCharacterSetting.json'));
assert(excluded, 'private-server character settings must remain excluded');

console.log(JSON.stringify({
  manifest: manifestPath,
  afterimageFrames: attack.afterimage.frames.length,
  attackDurationMs: attack.durationMs,
  hitAtMs: attack.hitAtMs,
  soundStatus: sound.status,
  initialPlayer: data.initialPlayer.status,
}, null, 2));
