import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const config = JSON.parse(fs.readFileSync(new URL('../../../../shared/henesys-rail.json', import.meta.url), 'utf8'));
const source = fs.readFileSync(new URL('./coordinates.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const api = {};
new Function('exports', 'require', js)(api, () => ({ default: config }));
for (const x of [370, 698, 1704, 3285, 4370, 6200]) {
  const p = api.point3d(x, 297), inverse = api.sourcePoint(...p);
  assert(Math.abs(inverse.x - x) < 1e-8 && Math.abs(inverse.y - 297) < 1e-8);
  const q = api.point3d(x + .01, 297);
  assert(Math.abs(Math.hypot(q[0]-p[0], q[2]-p[2]) * config.pixelsPerMetre - .01) < 1e-8, 'arc distance preserves walk speed');
  const angle = api.railAngle(x);
  assert(Math.abs((q[0]-p[0]) * -Math.sin(angle) + (q[2]-p[2]) * Math.cos(angle)) < 1e-7, 'camera normal perpendicular to travel');
  assert.equal(api.point3d(x, 197)[2], p[2], 'jump does not invent a depth lane');
}
assert(Math.abs(api.railAngle(6200) - api.railAngle(370)) > 1, 'route visibly turns');
for (const deck of config.decks) assert.equal(api.platformThickness(deck.id),config.deckThickness);
for (const platform of config.platforms) assert.equal(api.platformThickness(platform.id),config.platformThickness);
console.log('PASS: curved rail, inverse picking, constant travel speed, vertical jump and camera normal');
