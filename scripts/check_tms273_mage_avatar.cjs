const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../resources/tms273-export');
const data = JSON.parse(fs.readFileSync(path.join(root, 'mage-avatar.json'), 'utf8'));
assert.equal(data.sourceVersion, 'TMS273.7');
assert.equal(Object.keys(data.equipmentLoadouts).length, 12);
for (const actions of [data.actions, ...Object.values(data.equipmentLoadouts)]) {
  assert.deepEqual(actions.skill2001008.map(f => f.rawDelay), [-60, -330, 270]);
  assert.deepEqual(actions.skill2001008.map(f => f.move.x), [0, 6, 22]);
  assert.deepEqual(actions.skill2001011.map(f => f.rawDelay), [-30, 360]);
  assert.equal(actions.skill2001012[0].linkedAction, 'fly');
  assert.deepEqual(actions.skill2201008.map(f => f.rawDelay), [-90, -90, -210, -60, 60, 60, 120, 120]);
  assert.deepEqual(actions.skill2201008.map(f => f.linkedAction), ['swingO2', 'swingO2', 'swingO2', 'swingO2', 'swingO2', 'swingO2', 'swingO2', 'alert']);
  assert.deepEqual(actions.skill2201005.map(f => f.rawDelay), [-300, 510]);
  assert.deepEqual(actions.skill2201005.map(f => f.linkedAction), ['swingO3', 'stabO1']);
  assert.deepEqual(actions.skill2201001.map(f => f.rawDelay), [200, 200, 200]);
  assert.deepEqual(actions.skill2201001.map(f => f.linkedAction), ['alert', 'alert', 'alert']);
  for (const frames of Object.values(actions)) for (const frame of frames) {
    assert.equal(frame.delay, Math.abs(frame.rawDelay));
    assert(frame.parts.some(p => p.part === 'body'));
    assert(frame.parts.some(p => p.part === 'head'));
    for (const part of frame.parts) {
      assert([part.x, part.y, part.z].every(Number.isFinite));
      assert(part.url.startsWith('/assets/tms273/'));
      assert(fs.statSync(path.join(root, part.url)).size > 0);
    }
  }
}
console.log('PASS: mage source poses, signed delays, movement, body/head and all 12 loadouts.');
