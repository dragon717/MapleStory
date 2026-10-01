import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as T from 'three';
const east = JSON.parse(fs.readFileSync(new URL('../../../../shared/chuxian-east.json', import.meta.url), 'utf8'));
const load = (name, returns) => {
  const source = fs.readFileSync(new URL(name, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext}}).outputText.replace(/^import .*;\r?\n/gm, '').replace(/^export (?=class |function |const )/gm, '');
  return new Function('T', 'east', `${js};return {${returns}};`)(T, east);
};
const {GroundFeedback, surfaceForRoute} = load('./ground-feedback.ts', 'GroundFeedback,surfaceForRoute');
const {point3d, segmentAt} = load('./coordinates.ts', 'point3d,segmentAt');
const ground = x => { const {a, b} = segmentAt(x); return a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x); };
const events = new Map(), add = (type, callback) => { if (!events.has(type)) events.set(type, new Set()); events.get(type).add(callback); }, remove = (type, callback) => events.get(type)?.delete(callback);
let focused = true;
globalThis.document = {hidden: false, hasFocus: () => focused, addEventListener: add, removeEventListener: remove};
globalThis.window = {addEventListener: add, removeEventListener: remove};
const climate = {moisture: 0, snow: 0, daylight: 1};
function fixture(overrides = {}) {
  const actor = {id: 'player', x: east.routes[0].start + 100, y: 0, grounded: true, action: 'walk', ...overrides}; actor.y = ground(actor.x);
  const steps = [], scene = new T.Scene(), feedback = new GroundFeedback(scene, step => steps.push({...step, point: [...step.point], direction: [...step.direction]}));
  let now = 1000;
  const tick = (dx = 0, dt = 1000 / 60) => { now += dt; actor.x += dx; actor.y = ground(actor.x); feedback.update([actor], climate, now, point3d(actor.x, actor.y), 2, 480); };
  feedback.update([actor], climate, now, point3d(actor.x, actor.y), 2, 480);
  return {actor, steps, scene, feedback, tick, get now() { return now; }};
}
function travel(speed, mount = false, surface = 'stone', weather = climate) {
  const f = fixture({mount, surface});
  for (let i = 0; i < 180; i++) {
    f.actor.x += speed * east.pixelsPerMetre / 60; f.actor.y = ground(f.actor.x);
    f.feedback.update([f.actor], weather, 1000 + (i + 1) * 1000 / 60, point3d(f.actor.x, f.actor.y), 1, 480);
  }
  const result = {particles: f.feedback.cursor, steps: f.steps, shapes: f.feedback.shapes.slice(), colors: f.feedback.colors.slice()};
  f.feedback.destroy(); return result;
}

for (const route of east.routes) assert.equal(surfaceForRoute(route), route.kind === 'dock' ? 'wood' : 'stone');
assert.equal(surfaceForRoute({name: '林根小径', kind: 'branch'}), 'stone', 'route names never invent a grass surface');
for (const surface of ['grass', 'soil', 'sand', 'stone', 'wood']) assert.equal(surfaceForRoute({surface}), surface);
assert.equal(surfaceForRoute({material: 'earth'}), 'soil');

const sampler = fixture();
for (const route of east.routes) for (const node of route.nodes) {
  const actor = {id: 'sample', x: node.x, y: node.y, grounded: true};
  sampler.feedback.sample(actor);
  assert.ok(sampler.feedback.scratch.every((v, i) => Math.abs(v - point3d(actor.x, actor.y)[i]) < 1e-8), 'in-place sampler exactly mirrors shared point3d');
}
const buffers = sampler.feedback.attributes.map(a => a.array);
for (let i = 0; i < 120; i++) sampler.tick(125 / 60);
assert.ok(sampler.steps.length >= 3);
for (let i = 1; i < sampler.steps.length; i++) assert.equal(sampler.steps[i].side, -sampler.steps[i - 1].side, 'left and right feet alternate');
assert.ok(sampler.steps.every(step => Math.abs(Math.hypot(step.direction[0], step.direction[2]) - 1) < 1e-7));
assert.ok(sampler.steps.every(step => Math.abs(Math.hypot(step.point[0] - point3d(step.x, step.y)[0], step.point[2] - point3d(step.x, step.y)[2]) - .12) < 1e-7));
assert.ok(sampler.feedback.attributes.every((a, i) => a.array === buffers[i]), 'no particle buffer replacement during updates');
assert.equal(sampler.feedback.points.geometry.attributes.position.count, 1024);
assert.equal(sampler.feedback.points.material.depthTest, true); assert.equal(sampler.feedback.points.material.depthWrite, false);
sampler.feedback.destroy(); assert.equal(sampler.scene.children.length, 0);

const walk = travel(2.8), fast = travel(6.8, true), wet = travel(2.8, false, 'stone', {moisture: 1, snow: 0}), snow = travel(2.8, false, 'stone', {moisture: 1, snow: 1});
assert.ok(walk.particles > 0 && fast.particles > walk.particles * 2, 'faster mounted motion raises density');
assert.ok(fast.shapes[0] > walk.shapes[0], 'speed also increases particle area continuously');
assert.equal(wet.particles, 0, 'saturated surfaces suppress dust'); assert.ok(wet.steps.length > 0, 'foot rhythm survives without dust or audio');
assert.ok(snow.particles > walk.particles, 'snow powder remains visible on a wet snow layer');
for (let i = 0; i < snow.particles; i++) { assert.equal(snow.shapes[i * 3 + 2], 1); assert.ok(snow.colors[i * 3] > .75 && snow.colors[i * 3 + 2] > .95, 'snow is near-white instead of soil tint'); }
assert.ok(travel(2.8, false, 'grass').particles < walk.particles);
assert.ok(travel(2.8, false, 'wood').particles < walk.particles);
assert.ok(travel(2.8, false, 'sand').particles > walk.particles);
assert.ok(travel(2.8, false, 'soil').particles > walk.particles);

for (const overrides of [{grounded: false}, {hp: 0}, {chair: {}}, {climbing: true}, {action: 'stand'}, {action: 'jump'}, {action: 'attack'}, {action: 'dead'}, {action: 'sit'}, {teleported: true}]) {
  const f = fixture(overrides); for (let i = 0; i < 120; i++) f.tick(125 / 60);
  assert.equal(f.steps.length, 0, `inactive actor cannot emit: ${JSON.stringify(overrides)}`); assert.equal(f.feedback.cursor, 0); f.feedback.destroy();
}
const boundary = fixture();
for (let i = 0; i < 120; i++) boundary.tick(125 / 60);
const before = boundary.steps.length, beforeParticles = boundary.feedback.cursor;
boundary.tick(450); assert.equal(boundary.steps.length, before); assert.equal(boundary.feedback.cursor, beforeParticles, 'teleport cannot paint a dust trail');
boundary.tick(1); assert.equal(boundary.steps.length, before, 'teleport cannot leave stride debt');
boundary.tick(150, 1000); boundary.tick(1); assert.equal(boundary.steps.length, before, 'stale frame cannot emit or catch up');
focused = false; boundary.tick(1); assert.equal(boundary.feedback.points.visible, false); assert.equal(boundary.steps.length, before);
focused = true; boundary.tick(1); assert.equal(boundary.steps.length, before, 'focus return starts a fresh stride');
document.hidden = true; for (const callback of events.get('visibilitychange')) callback(); boundary.tick(1); assert.equal(boundary.steps.length, before);
document.hidden = false; boundary.tick(1); assert.equal(boundary.steps.length, before); boundary.feedback.destroy();
const stopped = fixture();
for (let i = 0; i < 60; i++) stopped.tick(125 / 60);
const stoppedAt = stopped.steps.length; for (let i = 0; i < 120; i++) stopped.tick();
assert.equal(stopped.steps.length, stoppedAt, 'walk animation alone never emits'); assert.equal(stopped.feedback.points.visible, false, 'old births expire on the GPU clock'); stopped.feedback.destroy();
const npc = fixture(); delete npc.actor.action;
for (let i = 0; i < 120; i++) npc.tick(125 / 60);
assert.ok(npc.steps.length >= 3, 'moving NPC snapshots need no player walk enum'); npc.feedback.destroy();

// Real chart changes and loop wraps are small physical steps despite distant game x values.
const junction = east.junctions.find(j => j.entries.some(e => e.route === 0) && j.entries.some(e => e.route === 1));
const entry = junction.entries.find(e => e.route === 0), exit = junction.entries.find(e => e.route === 1);
for (const [from, to] of [[entry.x - 20, exit.x + 20], ...east.routes.filter(r => r.loop).map(r => [r.end - 20, r.start + 20])]) {
  const f = fixture({x: from}); f.actor.x = to; f.actor.y = ground(to);
  f.feedback.update([f.actor], climate, 1100, point3d(to, f.actor.y), 1, 480);
  const track = f.feedback.tracks.find(t => t.id === f.actor.id);
  assert.ok(Math.abs(from - to) > 500); assert.ok(track.distance > .1 && track.speed > 0, 'chart seam must preserve physical movement'); f.feedback.destroy();
}

const scene = new T.Scene(), cappedSteps = [], capped = new GroundFeedback(scene, step => cappedSteps.push(step.actorId));
const crowd = Array.from({length: 80}, (_, i) => ({id: `crowd-${i}`, x: east.routes[0].start + 100, y: 0, grounded: true, action: 'walk', mount: true, point: [(i - 40) * .18, 0, 0]}));
capped.update(crowd, climate, 1000, [0, 0, 0], 1, 480);
assert.equal(capped.tracks.filter(t => t.id).length, 48); assert.ok(!capped.tracks.some(t => t.id === 'crowd-0'), 'nearest actors receive the finite slots');
let maxBirths = 0;
for (let i = 0; i < 24; i++) {
  for (const actor of crowd) actor.point[2] += .5;
  const old = capped.cursor; capped.update(crowd, climate, 1050 + i * 50, [0, 0, i * .5], 1, 480);
  const births = (capped.cursor - old + 1024) % 1024;
  assert.ok(births <= 96, 'global single-frame birth budget holds'); maxBirths = Math.max(maxBirths, births);
}
assert.equal(maxBirths, 96, 'crowd actually reaches the budget boundary');
capped.update([], climate, 2300, [0, 0, 0], 1, 480); assert.equal(capped.tracks.filter(t => t.id).length, 0, 'departed actors free history');
capped.destroy(); capped.destroy(); assert.equal(scene.children.length, 0);
assert.equal(events.get('blur').size, 0); assert.equal(events.get('visibilitychange').size, 0, 'destruction removes lifecycle listeners');
console.log(`PASS: exact shared feet/materials, ${walk.particles}/${fast.particles} slow/fast births, wet/snow/grass/sand/soil/wood, alternating feet, NPC/multiplayer, all stop/air/death/chair/climb/teleport/focus/stale boundaries, real chart/ring seams, fixed 1024 pool/48 actors/96 frame births and disposal.`);
