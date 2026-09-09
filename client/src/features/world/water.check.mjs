import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Same pattern as the other client checks: transpile the module, drop its
// imports (Phaser is not available under node) and exercise the pure
// simulation — the surface field and the buoyant bodies.
const source = await readFile(new URL('./water.ts', import.meta.url), 'utf8');
const outputText = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/^import .*;\r?\n/gm, '');
const { WaterSurface, FloatingBodies, WATER_TUNING } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

const ZONE = {
  xMin: 0, xMax: 580, yMin: 224, yMax: 340,
  floor: [{ x: 0, y: 278 }, { x: 45, y: 284 }, { x: 88, y: 296 }, { x: 94, y: 340 }, { x: 486, y: 340 }, { x: 493, y: 296 }, { x: 533, y: 284 }, { x: 575, y: 278 }, { x: 580, y: 278 }],
};
const STEP = 1 / 120;
const run = (surface, seconds) => { for (let i = 0; i < Math.round(seconds / STEP); i++) surface.update(STEP); };

// 1. Calm water stays finite and bounded, and never claims water outside the bank.
const calm = new WaterSurface(ZONE);
run(calm, 4);
assert.ok(Number.isFinite(calm.surfaceAt(290)), 'surface sample is finite');
assert.ok(calm.maxDisplacementNow() <= WATER_TUNING.maxDisplacement, 'ambient stays inside the safety clamp');
assert.equal(calm.surfaceAt(-5), null, 'left of the pool there is no water');
assert.equal(calm.surfaceAt(600), null, 'right of the pool there is no water');

// 2. One impulse spreads and then decays instead of pumping energy in.
const splash = new WaterSurface(ZONE);
splash.splash(290, 420, 40);
run(splash, 0.25);
const nearPeak = splash.maxDisplacementNow();
assert.ok(nearPeak > 0.4, `splash moves the surface (got ${nearPeak.toFixed(3)})`);
run(splash, 6);
assert.ok(splash.maxDisplacementNow() < nearPeak, 'the wave envelope decays when nothing drives it');

// 3. The injected momentum does not depend on how fine the grid is.
const fine = new WaterSurface(ZONE, WATER_TUNING, 96);
const coarse = new WaterSurface(ZONE, WATER_TUNING, 24);
fine.splash(300, 400, 40);
coarse.splash(300, 400, 40);
const ratio = fine.momentumIntegral() / coarse.momentumIntegral();
assert.ok(Math.abs(ratio - 1) < 0.02, `grid-independent impulse (ratio ${ratio.toFixed(4)})`);

// 4. Buoyancy settles at the authored draft and rests on shallow rock instead of sinking through.
const bodies = new FloatingBodies();
let bottom = 226;
for (let i = 0; i < 240; i++) {
  const surface = calm.surfaceAt(290);
  const result = bodies.update('drop-1', 290, 24, bottom, surface, calm.floorAt(290), calm.slopeAt(290), STEP);
  bottom = result.bottom;
  calm.update(STEP);
}
assert.ok(Math.abs(bottom - (calm.surfaceAt(290) + WATER_TUNING.floatDraft)) < 1.5,
  `floats at the authored draft (bottom ${bottom.toFixed(2)}, surface ${calm.surfaceAt(290).toFixed(2)})`);
// Very shallow water: the draft cannot be reached, so the body rests on the bed.
const shallowSurface = new WaterSurface({ xMin: 0, xMax: 100, yMin: 200, yMax: 206, floor: [{ x: 0, y: 206 }, { x: 100, y: 206 }] });
const shallowBodies = new FloatingBodies();
let shallowBottom = 204;
for (let i = 0; i < 240; i++) {
  const result = shallowBodies.update('drop-2', 50, 24, shallowBottom, shallowSurface.surfaceAt(50), shallowSurface.floorAt(50), 0, STEP, true);
  shallowBottom = result.bottom;
  shallowSurface.update(STEP);
}
assert.ok(shallowBottom <= shallowSurface.floorAt(50) + 0.001, `shallow body rests on the bed (${shallowBottom.toFixed(2)})`);
assert.ok(Math.abs(shallowBottom - shallowSurface.floorAt(50)) < 1.5, 'shallow body sinks onto the bed instead of hovering');

// 5. A dry icon above the water line gets no buoyancy, and re-entry splashes exactly once.
const splashBodies = new FloatingBodies();
assert.equal(splashBodies.update('drop-3', 290, 24, 150, 224, 340, 0, STEP, true), null, 'icon on the deck is dry');
let entered = 0;
let y = 150;
for (let i = 0; i < 200; i++) {
  const result = splashBodies.update('drop-3', 290, 24, y, 224, 340, 0, STEP, false);
  if (result?.entered) entered++;
  y = result ? Math.max(result.bottom, y + 6) : y + 6;
  if (y > 340) break;
}
assert.equal(entered, 1, 'the crossing into the water is reported once');

// 6. Repeated abuse never produces NaN or an unbounded surface.
const stress = new WaterSurface(ZONE);
for (let i = 0; i < 400; i++) {
  stress.splash(30 + (i * 7) % 520, 900, 60);
  stress.update(STEP);
}
run(stress, 1);
assert.ok(Number.isFinite(stress.surfaceAt(300)), 'surface stays finite under stress');
assert.ok(stress.maxDisplacementNow() <= WATER_TUNING.maxDisplacement, 'displacement stays clamped under stress');

console.log('PASS: planar water surface propagates, decays and stays bounded; drops float at the authored draft.');
