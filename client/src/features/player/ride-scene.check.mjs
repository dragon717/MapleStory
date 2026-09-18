import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const animation = moduleUrl(compile(await readFile(new URL('./animation.ts', import.meta.url), 'utf8')));
const source = compile(await readFile(new URL('./ride-scene.ts', import.meta.url), 'utf8')).replace("'./animation'", `'${animation}'`);
const { rideFrame, composeRideFrame } = await import(moduleUrl(source));
const part = (url, x, y, z = 78) => ({ key: url, url, x, y, z, origin: { x: 0, y: 0 } });
const avatar = { delay: 0, anchors: { navel: { x: -2, y: -17 }, brow: { x: -5, y: -48 } }, parts: [part('body', -19, -28)] };
const stand = { delay: 100, anchors: { navel: { x: 3, y: -51 } }, parts: [part('boar', -34, -50, 90)] };
const walk = { ...stand, parts: [part('boar-walk', -34, -52, 90)] };
const mount = { kind: 'mount-scene', itemId: '1902000', actions: { stand1: [stand], walk1: [walk], jump: [stand, walk] } };
assert.deepEqual(rideFrame(mount, { action: 'walk', grounded: true, vy: 0 }, 0), walk);
assert.deepEqual(rideFrame(mount, { action: 'jump', grounded: false, vy: -1 }, 100), walk);
assert.deepEqual(rideFrame(mount, { action: 'jump', grounded: false, vy: 1 }, 0), stand, 'fall uses authored jump if no fall action');
const mounted = composeRideFrame(mount, stand, avatar, 0);
assert.deepEqual(mounted.map(p => [p.url, p.x, p.y]), [['boar', -34, -50], ['body', -14, -62]], 'navel aligns rider without subtracting origin twice');
const saddle = { delay: 100, parts: [{ ...part('saddle', -10, -20, 80), map: { navel: { x: 1, y: -49 } } }] };
assert.deepEqual(composeRideFrame(mount, stand, avatar, 0, saddle).find(p => p.url === 'saddle'), { ...saddle.parts[0], x: -8, y: -22 }, 'saddle uses same navel as mount');
assert.deepEqual(rideFrame({ actions: { stand1: [stand], sit: [walk] } }, { action: 'sit', grounded: true, vy: 0 }, 0), walk, 'tamingMob chairs use sit before stand');
assert.equal(composeRideFrame({ ...mount, bodyRelMove: { x: 0, y: -14 } }, stand, avatar, 0).find(p => p.url === 'body').y, -76, 'tamingMob and bodyRelMove can coexist');
const chair = { kind: 'chair-scene', itemId: '3010000', actions: {}, bodyRelMove: { x: 7, y: -9 }, effects: [
  { z: -1, pos: 1, frames: [{ delay: 100, parts: [part('chair-back', -21, 16)] }] },
  { z: 1, pos: 0, frames: [{ delay: 40, parts: [part('front-0', 0, 0)] }, { delay: 60, parts: [part('front-1', 1, 2)] }] },
] };
const seated = composeRideFrame(chair, undefined, avatar, 50);
assert.deepEqual(seated.map(p => [p.url, p.x, p.y]), [['chair-back', -26, -32], ['body', -12, -37], ['front-1', 1, 2]], 'chair effects have independent timing, brow anchoring and relative depth');
assert.equal(composeRideFrame(undefined, undefined, avatar, 0), avatar.parts, 'standing up removes all furniture and offsets');
assert.equal(composeRideFrame({ ...chair, hideBody: true }, undefined, avatar, 0).some(p => p.url === 'body'), false);
assert.equal(composeRideFrame({ ...chair, sitAction: 'hideBody' }, undefined, avatar, 0).some(p => p.url === 'body'), false);
const fading = { ...chair, effects: [{ z: 1, pos: 0, frames: [
  { delay: 40, parts: [part('wait', 0, 0)] },
  { delay: 100, parts: [{ ...part('fade', 0, 0), a0: 0, a1: 255 }] },
] }] };
assert.equal(composeRideFrame(fading, undefined, avatar, 90).find(p => p.url === 'fade').opacity, 0.5, 'alpha uses elapsed within this frame');
assert.equal(composeRideFrame({ ...chair, effects: [{ z: 0, pos: 0, frames: [{ delay: 0, parts: [{ ...part('static', 0, 0), alpha: 255 }] }] }] }, undefined, avatar, 0).find(p => p.url === 'static').opacity, 1, 'zero-delay static alpha stays finite');
assert.deepEqual(avatar.parts[0], part('body', -19, -28), 'composition never mutates shared avatar frames');
console.log('Ride/chair frame selection, source anchors, independent animation, depth and cleanup passed.');

// A late request must not put an old mount back after dismount, switching
// chairs or destroying the actor; two players share the same item request.
globalThis.resolveAssetUrl = url => url;
const requests = new Map();
globalThis.fetch = url => new Promise(resolve => requests.set(url, resolve));
const viewCode = compile(await readFile(new URL('./view.ts', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
const { PlayerView } = await import(moduleUrl(viewCode));
const manifest = { rideScenes: { mounts: { 1902000: { url: '/boar.json' } }, chairs: { 3010000: { url: '/chair.json' } } } };
const view = () => Object.assign(Object.create(PlayerView.prototype), { manifest, scene: { time: { now: 0 } }, rideKey: '', destroyed: false });
const one = view(), two = view();
one.updateRideScene({ mount: { itemId: '1902000' } });
two.updateRideScene({ mount: { itemId: '01902000' } });
assert.equal(requests.size, 1);
one.updateRideScene({ chair: { itemId: '3010000' } });
requests.get('/boar.json')({ ok: true, json: async () => mount });
await new Promise(resolve => setImmediate(resolve));
assert.equal(one.rideScene, undefined, 'stale mount request ignored');
assert.equal(two.rideScene, mount, 'other player still receives shared mount');
one.destroyed = true;
requests.get('/chair.json')({ ok: true, json: async () => chair });
await new Promise(resolve => setImmediate(resolve));
assert.equal(one.rideScene, undefined, 'destroyed view ignores completion');
two.updateRideScene({});
assert.equal(two.rideScene, undefined);
assert.equal(two.rideKey, '');
console.log('Ride scene shared loading, stale completion and teardown checks passed.');
