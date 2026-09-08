import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Exercise the real scene's portal methods without a renderer or live account.
const source = await readFile(new URL('./world.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const moduleSource = 'const Phaser = { Scene: class {} };\n' + outputText.replace(/^import .*;\r?\n/gm, '');
const { World } = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`);
const requests = [];
const statuses = [];
const portal = { name: 'out00', type: 2, x: 100, y: 100, targetMapId: 'next', targetPortalName: 'in00' };
const world = new World({ map: { id: 'birth', portals: [portal] } }, (message, error) => statuses.push({ message, error }), request => requests.push(request));
const player = { id: 'self', hp: 50, action: 'stand', x: 100, y: 100 };
world.loaded = true;
world.snapshot = { selfId: 'self', players: [player] };
world.tryPortal(player, true);
assert.equal(requests.length, 0, 'Walking into a regular portal does not warp');
world.enterPortal();
assert.equal(requests.length, 1, 'Up enters the regular portal');
world.enterPortal();
assert.equal(requests.length, 1, 'Cooldown blocks duplicate requests');
world.portalCooldownUntil = 0;
player.action = 'attack';
world.enterPortal();
player.action = 'stand';
player.hp = 0;
world.enterPortal();
player.hp = 50;
player.x = 300;
world.enterPortal();
assert.equal(requests.length, 1, 'Attacking, dead, and distant players cannot enter');
player.x = 100;
portal.type = 3;
world.tryPortal(player, true);
assert.equal(requests.length, 2, 'Touch portals keep their automatic trigger');
world.portalCooldownUntil = 0;
portal.type = 10;
portal.targetMapId = 'birth';
world.tryPortal(player, true);
assert.equal(requests.length, 2, 'Hidden same-map portals require Up');
world.enterPortal();
assert.equal(requests.length, 3, 'Up enters hidden same-map portals');
assert.equal(requests.at(-1).targetMapId, 'birth');
world.portalCooldownUntil = 0;
world.loaded = false;
world.enterPortal();
assert.equal(requests.length, 3, 'Loading a map cannot enter a portal');
world.receive({ type: 'portalResult', success: false, code: 'out_of_range' });
assert.equal(statuses.at(-1).error, undefined, 'A rejected portal request must not disconnect the game');

// 48 px horizontal tolerance (mirrors `world.rs::handle_portal`'s server guard).
// The 36 px ceiling used to silently drop requests when the player stood one
// step away from a gate.  Existing `portal` here sits at (100, 100); pushing
// the player to (55, 100) exercises the new ceiling.
world.loaded = true;
world.portalCooldownUntil = 0;
world.snapshot = { selfId: 'self', players: [{ id: 'self', hp: 50, action: 'stand', x: 55, y: 100 }] };
world.enterPortal();
assert.equal(requests.length, 4, 'Δx = 45 px is within the new client/server guard');

// Two gates in range — closest one wins, not JSON-order first.  Add a second
// gate 200 px east of the existing one and put the player roughly between them
// so the Euclidean nearest-neighbour choice is observable.
const east = { name: 'east00', type: 2, x: 300, y: 100, targetMapId: 'east', targetPortalName: 'sp' };
world.manifest.map.portals.push(east);
world.portalCooldownUntil = 0;
// 30 px east of `portal`, 170 px west of `east` → closer to `portal`.
world.snapshot = { selfId: 'self', players: [{ id: 'self', hp: 50, action: 'stand', x: 130, y: 100 }] };
world.enterPortal();
assert.equal(requests.length, 5, 'When the player is closer to one of two gates, that gate wins');
assert.equal(requests.at(-1).portalName, 'out00');
// Now 40 px west of `east`, 220 px east of `portal` → `east00` should win.
world.portalCooldownUntil = 0;
world.snapshot = { selfId: 'self', players: [{ id: 'self', hp: 50, action: 'stand', x: 260, y: 100 }] };
world.enterPortal();
assert.equal(requests.length, 6, 'Closer-to-east gate now wins');
assert.equal(requests.at(-1).portalName, 'east00');

console.log('PASS: manual regular portals, touch portals, cooldown, player guards, range ceiling, and nearest-gate selection.');
