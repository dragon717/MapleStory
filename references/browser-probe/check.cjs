const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const map = JSON.parse(fs.readFileSync(path.join(root, 'map.json'), 'utf8'));
assert.equal(manifest.avatar.equipmentSlots.cap.islot, 'Cp');
assert.equal(manifest.avatar.equipmentSlots.cap.vslot, 'CpH1H5');
assert.equal(manifest.avatar.smap.hairOverHead, 'H1');
const actionStats = {};
for (const [name, frames] of Object.entries(manifest.avatar.actions)) {
  assert(Array.isArray(frames) && frames.length, `${name} has no frames`);
  assert(frames.every(f => Number.isFinite(f.delay) && f.delay > 0), `${name} delay missing`);
  assert(frames.every(f => f.parts.some(p => p.part === 'face')), `${name} face missing`);
  assert(frames.every(f => f.parts.some(p => p.part === 'head' && p.uol === '../../front/head')), `${name} head UOL missing`);
  for (const f of frames) {
    assert(f.parts.some(p => p.part === 'cap' && p.zName === 'cap'), `${name}/${f.index} cap missing`);
    assert(!f.parts.some(p => p.part === 'hair' && p.zName === 'hairOverHead'), `${name}/${f.index} covered H1 hair rendered`);
    assert(f.filteredParts.some(p => p.part === 'hair' && p.zName === 'hairOverHead' && p.slotCode === 'H1'), `${name}/${f.index} H1 filter evidence missing`);
    for (const zName of ['hair', 'hairShade', 'hairBelowBody']) {
      assert(f.parts.some(p => p.part === 'hair' && p.zName === zName), `${name}/${f.index} ${zName} missing`);
    }
    const body = f.parts.find(p => p.part === 'body' && p.key.includes('00002000'));
    assert(body && body.x + body.origin.x === 0 && body.y + body.origin.y === 0, `${name}/${f.index} foot drift`);
  }
  actionStats[name] = { frames: frames.length, delays: frames.map(f => f.delay), partsPerFrame: frames.map(f => f.parts.length) };
}
assert.equal(map.footholds.length, 83);
for (const spawn of map.spawns) {
  const f = map.footholds.find(x => x.id === spawn.foothold);
  assert(f && spawn.x >= Math.min(f.x1, f.x2) && spawn.x <= Math.max(f.x1, f.x2) && spawn.y === f.y1, `${spawn.id} is off foothold`);
}
const files = new Set(fs.readdirSync(path.join(root, 'assets')));
const urls = new Set([...manifest.map.layers.map(x => x.url), ...Object.values(manifest.avatar.actions).flatMap(fs => fs.flatMap(f => f.parts.map(p => p.url)))].map(x => path.basename(x)));
assert([...urls].every(x => files.has(x)), 'manifest references missing PNG');
const result = { ok: true, actionStats, footholds: map.footholds.length, tileCount: map.tileCount, objectCount: map.objectCount, pngs: urls.size, spawnFootholds: map.spawns.map(s => ({ id: s.id, foothold: s.foothold, x: s.x, y: s.y })) };
console.log(JSON.stringify(result, null, 2));
fs.writeFileSync(path.join(root, 'check-results.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
