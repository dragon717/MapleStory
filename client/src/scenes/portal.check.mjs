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

// TMS273 scripted doorways (楓之港 `east00` → 碼頭 via `pt_southperry`) carry a
// `script` payload but are real gates once the chapter adapter assigns their
// route.  A `script` field must never hide the beam or block entry again.
{
  const scripted = { name: 'east00', type: 7, x: 2520, y: 290, targetMapId: '002000100', targetPortalName: 'sp', script: 'pt_southperry' };
  const sameMap = { name: 'top0', type: 10, x: 1859, y: -5, targetMapId: '002000000', targetPortalName: 'bottom0' };
  const pier = new World({ map: { id: '002000000', portals: [scripted, sameMap] } }, () => {}, request => requests.push(request));
  pier.loaded = true;
  pier.portalCooldownUntil = 0;
  pier.snapshot = { selfId: 'self', players: [{ id: 'self', hp: 50, action: 'stand', x: 2520, y: 290 }] };
  pier.enterPortal();
  assert.equal(requests.length, 7, 'A scripted cross-map gate accepts the Up key');
  assert.equal(requests.at(-1).portalName, 'east00');
  assert.equal(requests.at(-1).targetMapId, '002000100');
  // Stand next to the same-map link instead: it is enterable but must never be
  // preferred over a real gate, and it is excluded from beam rendering.
  pier.portalCooldownUntil = 0;
  pier.snapshot = { selfId: 'self', players: [{ id: 'self', hp: 50, action: 'stand', x: 1859, y: -5 }] };
  pier.enterPortal();
  assert.equal(requests.at(-1).portalName, 'top0', 'Same-map links stay enterable');
  assert.equal(requests.at(-1).targetMapId, '002000000');
}

// Gates into maps this build does not assemble must never be requested.  The
// source archive carries routes the catalog does not ship (六條岔道's tree-top
// `top00`/`top01` → 104020100 維多利亞樹木站台, 礦山入口 `side00` → 310040210,
// 弓箭手村 `in00` → 100000100 …), and `pt: 3` slots fire on touch, so climbing
// 六條岔道's rope spammed `传送失败：map_unavailable` on every snapshot tick.
// A closed gate now explains itself once per visit; real gates keep working.
{
  const closedTouch = { name: 'top00', type: 3, x: 100, y: 100, targetMapId: '104020100', targetPortalName: 'st00' };
  const closedUp = { name: 'side01', type: 2, x: 500, y: 100, targetMapId: '310040210', targetPortalName: 'out00' };
  const openUp = { name: 'eli00', type: 2, x: 300, y: 100, targetMapId: '101010100', targetPortalName: 'south00' };
  const catalog = { maps: [{ id: '104020000', portals: [closedTouch, closedUp, openUp] }, { id: '101010100', portals: [] }] };
  const notices = [];
  const hill = new World({ map: catalog.maps[0], mapCatalog: catalog }, (message, error) => notices.push({ message, error }), request => requests.push(request));
  hill.loaded = true;
  const stand = (x) => {
    hill.portalCooldownUntil = 0;
    hill.snapshot = { selfId: 'self', players: [{ id: 'self', hp: 50, action: 'stand', x, y: 100 }] };
    return hill.snapshot.players[0];
  };
  hill.tryPortal(stand(100), true);
  assert.equal(requests.length, 8, 'A touch gate into an unassembled map is not requested');
  assert.equal(notices.length, 1, 'It explains itself instead of failing silently');
  assert.match(notices[0].message, /104020100/, 'The notice names the missing destination');
  assert.equal(notices[0].error, undefined, 'A route this build does not ship is not an error');
  hill.tryPortal(stand(100), true);
  assert.equal(notices.length, 1, 'The same gate does not re-notice on the next snapshot tick');
  hill.tryPortal(stand(500), false);
  assert.equal(requests.length, 8, 'The Up key is refused by the same rule');
  assert.match(notices.at(-1).message, /310040210/);
  hill.tryPortal(stand(300), false);
  assert.equal(requests.length, 9, 'A gate whose destination this build ships still works');
  assert.equal(requests.at(-1).portalName, 'eli00');
}

console.log('PASS: manual regular portals, touch portals, cooldown, player guards, range ceiling, nearest-gate selection, scripted gate entry, and unassembled destinations.');
