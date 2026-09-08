#!/usr/bin/env node

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'resources/tms273-export/mage-effects.json');
const EXPECTED = ['2001002', '2001008', '2001009', '2001011', '2001012', '2200011', '2201001', '2201005', '2201008', '2201009'];
const DIRECT_EFFECTS = ['2001002', '2001009', '2001011', '2001012', '2201001'];
const PROJECTED = ['2001008', '2201005', '2201008'];
const EXTRA_GROUPS = {
  '2201001': { effect: 19 },
  '2201009': { tile: 24, hit: 11 },
  '2200011': { mob: 30 },
};

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function localPath(url) {
  assert(typeof url === 'string' && url.startsWith('/'), `invalid asset URL: ${url}`);
  assert(url.startsWith('/assets/'), `asset URL is outside the exported asset root: ${url}`);
  return path.join(ROOT, 'resources/tms273-export', url.slice(1));
}

function checkFrame(frame) {
  for (const field of ['url', 'source', 'width', 'height', 'delay', 'rawDelay', 'origin', 'outlink', 'sha256']) {
    assert(Object.prototype.hasOwnProperty.call(frame, field), `frame missing ${field}`);
  }
  assert(Number.isSafeInteger(frame.width) && frame.width > 0, `invalid width: ${frame.source}`);
  assert(Number.isSafeInteger(frame.height) && frame.height > 0, `invalid height: ${frame.source}`);
  assert(Number.isFinite(frame.delay) && frame.delay >= 0, `invalid display delay: ${frame.source}`);
  if (frame.origin) {
    assert.equal(frame.x, frame.origin.x === 0 ? 0 : -frame.origin.x, `x/origin mismatch: ${frame.source}`);
    assert.equal(frame.y, frame.origin.y === 0 ? 0 : -frame.origin.y, `y/origin mismatch: ${frame.source}`);
  } else {
    assert.equal(frame.x, 0, `missing-origin x must be zero: ${frame.source}`);
    assert.equal(frame.y, 0, `missing-origin y must be zero: ${frame.source}`);
  }
  if (frame.rawDelay === null) assert.equal(frame.delay, 0, `missing delay must be static: ${frame.source}`);
  else assert.equal(frame.delay, Math.abs(Number(frame.rawDelay)), `raw/display delay mismatch: ${frame.source}`);
  const file = localPath(frame.url);
  assert(fs.existsSync(file), `PNG missing: ${file}`);
  assert.equal(sha256(file), frame.sha256, `PNG hash mismatch: ${frame.source}`);
}

function checkGroup(id, kind, frames, count) {
  assert(Array.isArray(frames), `${id} ${kind} group is missing`);
  assert.equal(frames.length, count, `${id} ${kind} frame count changed`);
  for (const frame of frames) {
    checkFrame(frame);
    assert(frame.source.startsWith(`Skill/220.img/skill/${id}/${kind}/`), `wrong ${id} ${kind} source: ${frame.source}`);
    assert.equal(frame.outlink, frame.resolvedSource, `${id} ${kind} outlink changed`);
  }
}

function main() {
  assert(fs.existsSync(OUTPUT), `missing ${OUTPUT}`);
  const output = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
  assert.equal(output.sourceVersion, 'TMS273.7');
  assert.deepEqual(Object.keys(output.skillEffects).sort(), [...EXPECTED].sort());
  assert(output.extraction.images?.['Skill/220.img']?.archive.endsWith('Skill_00001.ms'));
  assert(output.extraction.canvasArchives?.['参考/273/TMS273少爷一键端/客户端/TMS273.7/Data/Skill/_Canvas/_Canvas_040.wz']?.endsWith('Skill/_Canvas/_Canvas_040.wz'));
  for (const id of DIRECT_EFFECTS) {
    const skill = output.skillEffects[id];
    assert(Array.isArray(skill.effect) && skill.effect.length > 0, `${id} effect is empty`);
    for (const frame of [...skill.effect, ...(skill.hit || []), ...(skill.ball || [])]) checkFrame(frame);
  }
  for (const id of PROJECTED) {
    const skill = output.skillEffects[id];
    assert(skill.source?.projection?.endsWith('resources/tms273-export/skills.json'), `${id} must be projected`);
    assert(skill.effect.length > 0, `${id} projected effect is empty`);
    for (const frame of [...skill.effect, ...(skill.hit || []), ...(skill.ball || [])]) {
      checkFrame(frame);
      assert(!frame.url.includes('/mage-effects/'), `${id} was re-exported`);
    }
  }
  for (const [id, groups] of Object.entries(EXTRA_GROUPS)) {
    for (const [kind, count] of Object.entries(groups)) checkGroup(id, kind, output.skillEffects[id][kind], count);
  }
  for (const file of output.sourceFiles || []) {
    const absolute = path.join(ROOT, file.path);
    assert(fs.existsSync(absolute), `source missing: ${file.path}`);
    assert.equal(fs.statSync(absolute).size, file.bytes, `source size changed: ${file.path}`);
    assert.equal(sha256(absolute), file.sha256, `source hash changed: ${file.path}`);
  }
  console.log(JSON.stringify({ output: path.relative(ROOT, OUTPUT), sourceVersion: output.sourceVersion, skills: EXPECTED.length, ok: true }, null, 2));
}

if (require.main === module) main();

module.exports = { main };
