const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'build/.checks/voyage-physics.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
createRequire(path.join(root, 'client/package.json'))('esbuild').buildSync({ stdin: { contents: "export * from './voyage-physics'; export * from './voyage-ship';", resolveDir: path.join(root, 'client/src/features/entry'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: output });
const { ClothGrid, ShallowWater, ShipFlight } = require(output);
const mass = water => water.state.reduce((sum, value, i) => sum + (i % 3 === 0 ? value : 0), 0);
const water = new ShallowWater(24, 16, 20, 12, 1.5);
for (let i = 0; i < water.state.length; i += 3) water.state[i] += i / 3 % 24 < 12 ? .3 : -.3;
const before = water.state.slice(), initialMass = mass(water);
for (let i = 0; i < 360; i++) water.advance(1 / 60);
assert(water.state.every(Number.isFinite));
assert(water.state.every((value, i) => i % 3 !== 0 || value > 0), 'water depth must remain positive');
assert(Math.abs(mass(water) - initialMass) < 1e-7, 'closed basin must conserve water');
assert(water.state.some((value, i) => i % 3 === 0 && Math.abs(value - before[i]) > .1), 'dam break must propagate, not just animate a shader');
const disturbed = new ShallowWater(24, 16, 20, 12, 1.5);
disturbed.disturb(.5, .5, 4);
for (let i = 0; i < 30; i++) disturbed.advance(1 / 60);
assert(disturbed.state.some((value, i) => i % 3 === 0 && Math.abs(value - 1.5) > .001));
assert(Math.abs(mass(disturbed) - 24 * 16 * 1.5) < 1e-7);
const channel = new ShallowWater(24, 8, 8, 50, 1.2, 3);
for (let i = 0; i < 360; i++) channel.advance(1 / 60, .01);
assert(channel.state.every(Number.isFinite));
assert(channel.state.some((value, i) => i % 3 === 2 && value > 0), 'channel keeps directional momentum');
const a = new ShallowWater(8, 8, 4, 4, 1), b = new ShallowWater(8, 8, 4, 4, 1);
a.disturb(.3, .4); b.disturb(.3, .4); a.advance(3600); b.advance(.05);
assert.deepEqual(a.state, b.state, 'hidden-tab catchup is bounded');
const columns = 8, rows = 6, rest = new Float32Array((columns + 1) * (rows + 1) * 3);
for (let y = 0; y <= rows; y++) for (let x = 0; x <= columns; x++) rest.set([x * .25, y * .25, 0], (y * (columns + 1) + x) * 3);
const cloth = new ClothGrid(rest, columns, rows);
for (let i = 0; i < 240; i++) cloth.advance(1 / 60, [0, 0, 6]);
assert(cloth.positions.every(Number.isFinite));
for (let x = 0; x <= columns; x++) {
  const i = (rows * (columns + 1) + x) * 3;
  assert.deepEqual(cloth.positions.slice(i, i + 3), rest.slice(i, i + 3), 'yardarm pins stay fixed');
}
assert(Math.abs(cloth.positions[2]) > .05, 'wind deflects the free sail');
assert(Math.hypot(cloth.positions[0], cloth.positions[1] - 1.5, cloth.positions[2]) < 2, 'cloth remains attached under gravity');
assert.throws(() => new ClothGrid(rest, 1000, rows));
const fanRest = rest.slice(), fanPins = [];
for (let y = 0; y <= rows; y++) for (let x = 0; x <= columns; x++) {
  const i = y * (columns + 1) + x;
  fanRest.set([x / columns * 3, (y / rows - .5) * x / columns * 2, 0], i * 3);
  if (y === 0 || y === rows || x === 0) fanPins.push(i);
}
const fan = new ClothGrid(fanRest, columns, rows, fanPins);
for (let i = 0; i < 120; i++) fan.advance(1 / 60, [0, 0, 6]);
for (const i of fanPins) for (let axis = 0; axis < 3; axis++) assert(fan.positions[i * 3 + axis] === fanRest[i * 3 + axis], 'fan spars and hinge stay fixed');
assert(fan.positions.every(Number.isFinite));
assert(fan.positions.some((v, i) => i % 3 === 2 && Math.abs(v) > .01), 'triangular fan fabric billows between spars');
// Folding changes the rest shape while preserving finite motion and exact spar pins.
for(let step=0;step<120;step++){
 const folded=fanRest.map((v,i)=>i%3===0?v*(1-step/180):v);
 fan.retarget(folded); fan.advance(1/60,[0,0,6]);
 assert(fan.positions.every(Number.isFinite));
 for(const i of fanPins)for(let axis=0;axis<3;axis++)assert(fan.positions[i*3+axis]===folded[i*3+axis]);
}
const stableRest=fan.rest.slice();fan.retarget(new Float32Array([NaN]));assert.deepEqual(fan.rest,stableRest);
assert.throws(() => new ClothGrid(rest, columns, rows, [-1]));
assert.throws(() => new ShallowWater(2, 8, 4, 4, 1));
const open = new ShipFlight(), reefed = new ShipFlight();
open.setControls({ sail: 1, throttle: 0 }); reefed.setControls({ sail: 0, throttle: 0 });
for (let i = 0; i < 600; i++) { open.update(1 / 60); reefed.update(1 / 60); }
assert(open.thrust > reefed.thrust * 3 && open.speed > reefed.speed * 3, 'opening the actual sail increases force and forward speed');
const left = new ShipFlight(), right = new ShipFlight();
left.setControls({ steering: -1 }); right.setControls({ steering: 1 });
left.setTrial(true); right.setTrial(true);
for (let i = 0; i < 600; i++) { left.update(1 / 60); right.update(1 / 60); }
assert(left.position.x < 0 && right.position.x > 0 && Math.abs(left.position.x + right.position.x) < 1e-8, 'both turns use the same force/navigation rule');
right.setControls({ wind: NaN, sail: Infinity, throttle: 99, steering: -99 });
assert.deepEqual(right.controls, { sail: 1, wind: 8, throttle: 1, steering: -1 });
const boundedA = new ShipFlight(), boundedB = new ShipFlight();
boundedA.update(3600); boundedB.update(.05);
assert.equal(boundedA.speed, boundedB.speed, 'resuming must not integrate hidden time');
boundedA.update(NaN); assert(Number.isFinite(boundedA.speed));
right.setTrial(false); assert.equal(right.position.length(), 0); assert.equal(right.heading, 0);
console.log('Voyage cloth pins/wind/gravity and shallow-water flow/positive depth/mass/catchup checks passed');
