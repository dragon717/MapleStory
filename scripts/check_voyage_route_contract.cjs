const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const layout = JSON.parse(fs.readFileSync(path.join(root, 'shared/voyage-deck.json'), 'utf8'));
const sourceLayout = JSON.parse(fs.readFileSync(path.join(root, 'resources/scenes/sky-voyage-v3/source-layout.json'), 'utf8'));

assert.equal(layout.surface.mesh, 'SV3_Hull', 'the original hull is the main-deck surface');
assert.equal(layout.surface.height, 5.4, 'the original hull deck height is authoritative');
assert.equal(sourceLayout.ship.mainDeck.walkSurface, 'SV3_Hull');
assert.equal(sourceLayout.ship.mainDeck.overlay, false, 'the main deck has no overlay board');
assert.equal(sourceLayout.ship.mainDeck.bowWalkable, false, 'the main deck does not absorb the independent bow route');

const exterior = layout.routes[0];
assert.equal(exterior.closed, true);
assert.equal(layout.routes.length, 1, 'the production contract keeps only the original main-deck loop');
assert.deepEqual(exterior.nodes, ['右舷登船位', '右舷后端', '左舷后端', '左舷路口', '右舷路口', '右舷登船位']);
assert(!layout.routes.some(route => route.nodes.some(node => /^(08|船头|Bow)/.test(node))), 'the main deck must not include a bow route');
assert(!JSON.stringify(layout).includes('extensions'), 'retired bridge extension field is absent from the production contract');

const cabin = layout.cabinRoute;
assert.deepEqual(cabin.route, ['09', 'bedAisle', '17']);
assert(!cabin.route.includes('08'), 'the cabin route must not include a bow route');
assert.deepEqual(layout.cabinFrame.pivot, [0, 0, 40], 'cabin frame pivots around the ship centre');
assert.equal(layout.cabinFrame.rotationYRadians, Math.PI / 2, 'cabin frame keeps the authored quarter-turn');
assert.deepEqual(layout.cabinFrame.translation, [0, 0, 0], 'cabin frame has no compensating translation');
assert.deepEqual(cabin.spawn, [5.4, 40, 0.05]);
assert.equal(cabin.bedAisle.doorFacing, true);
assert.equal(cabin.bedAisle.sourceAisleLocalZ, sourceLayout.ship.beds.aisleLocalZ);
assert.deepEqual(new Set(Object.keys(cabin.nodes)), new Set(['09', '17', '18']));
assert.deepEqual(cabin.nodes['09'], [5.4, 53.1, 0.05]);
assert.deepEqual(cabin.nodes['18'], [5.4, 40, 0.05]);
assert.deepEqual(cabin.nodes['17'], [5.4, 26.9, 0.05]);
assert.deepEqual(cabin.floorRoots, ['SV2_CabinFloor'], 'cabin route keeps only the original cabin floor');
assert.equal(cabin.deckExit.mode, 'walk-through-bow-transfer');
assert.deepEqual(cabin.deckExit.target, [0, -42.4, 6.8]);
assert.deepEqual(cabin.sideOpenings, { sourceAisleZ: 45.4, width: 3.2, height: 6.2, sourceX: [-13.5, 13.5] });
for (const [section, point] of Object.entries(cabin.nodes)) {
  assert.equal(point.length, 3, `${section} stores x,z,y`);
  assert(point.every(Number.isFinite), `${section} is finite`);
}

const bow = layout.bowRoute;
assert.equal(typeof bow.contract, 'string');
assert.deepEqual(bow.floorRoots, ['SV3_BowPlatform_Deck']);
assert.deepEqual(bow.blockerRoots, ['SV3_BowPlatform_Rails']);
assert.deepEqual(bow.spawn, [0, -42.4, 6.8]);
assert.deepEqual(bow.nodes, [
  [0, -42.4, 6.8], [0, -48, 7.65], [0, -62, 7.65], [0, -69, 7.65],
]);
assert.deepEqual(bow.stations, [
  [-41.5, 6.65, 3.6], [-42, 6.65, 3.6], [-48, 7.65, 3.1],
  [-56, 7.65, 2.25], [-64, 7.65, 1.5], [-70, 7.65, .95],
]);
assert.equal(bow.thickness, .32);
assert.equal(bow.railHeight, .95);
assert(!JSON.stringify(exterior).includes('bowRoute'), 'main-deck route stays independent from the bow route');

const glbPath = path.join(root, 'resources/scenes/sky-voyage-v3/models/sky-voyage.glb');
const bytes = fs.readFileSync(glbPath);
assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
const jsonLength = bytes.readUInt32LE(12);
const gltf = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength));
const names = new Set(gltf.nodes.map(node => node.name));
for (const name of [
  'SV3_CaptainRoof', 'SV3_CaptainWall_Aft', 'SV3_CaptainWall_Bow',
  'SV3_CaptainWall_End_0', 'SV3_CaptainWall_End_18', 'SV3_CaptainWall_Middle', 'SV3_CaptainWall_Port',
  'SV3_CaptainWindow_5.65', 'SV3_CaptainWindow_8.09',
  'SV3_CaptainPorthole_Frame', 'SV3_CaptainPorthole_Glass',
  'SV3_Hull', 'SV3_VoyageRouteStructure',
  'SV3_WindowWallRestored_Base', 'SV3_WindowWallRestored_Crown', 'SV3_WindowWallRestored_EndPier',
  'SV3_RouteAnchor_09', 'SV3_RouteAnchor_17', 'SV3_RouteAnchor_18',
  'SV3_CabinToDeckLanding', 'SV3_BowCabinPortal', 'SV3_BowPlatform_Deck', 'SV3_BowPlatform_Rails',
]) {
  assert(names.has(name), `source GLB is missing ${name}`);
}
for (const name of ['SV3_MainDeck_Surface', 'SV3_Route_CabinAisle_02', 'SV3_Route_SternRoom_09']) {
  assert(!names.has(name), `source GLB must not retain ${name}`);
}
for (const node of gltf.nodes.filter(node => /^SV3_Route_/.test(node.name ?? ''))) {
  assert(['SV3_RouteInteriorStructure', 'SV3_RouteExteriorStructure', 'SV3_RouteAnchor_09', 'SV3_RouteAnchor_17', 'SV3_RouteAnchor_18', 'SV3_RouteTransfer_18'].includes(node.name), `source GLB retains unexpected route node ${node.name}`);
  assert.equal(node.mesh, undefined, `source GLB route node ${node.name} must be an empty`);
}
assert(!gltf.nodes.some(node => /^SV3_CabinDoor17_/.test(node.name ?? '')), 'source GLB must not retain old 17 door meshes');
for (const name of ['SV3_WindowWallRestored_Base', 'SV3_WindowWallRestored_Crown', 'SV3_WindowWallRestored_EndPier']) {
  const node = gltf.nodes.find(candidate => candidate.name === name);
  assert(node.mesh !== undefined && node.extras?.walk_surface === true, `${name} must be a walkable restored window wall`);
}
const door = gltf.nodes.find(node => node.name === 'SV3_CaptainDoorOpening');
assert(door && door.mesh === undefined, 'CaptainDoorOpening is an empty authored portal');
assert.deepEqual({ width: door.extras?.width, height: door.extras?.height }, { width: 1.05, height: 1.48 }, 'CaptainDoor keeps the authored opening size');
assert(Math.abs((door.translation?.[1] ?? NaN) - 5.445) < 1e-5, 'CaptainDoor uses the authored floor baseline');
assert.equal(door.extras?.lobby_target, 'SV3_CabinInterior');
assert.equal(door.extras?.trigger_radius, 1.15);
const bowDeck = gltf.nodes.find(node => node.name === 'SV3_BowPlatform_Deck');
assert.equal(bowDeck?.extras?.walk_surface, true, 'bow slope/platform is the independent walk surface');
assert.equal(bowDeck?.extras?.slope_section, '15');
assert.equal(bowDeck?.extras?.platform_section, '16/08');
const bowRails = gltf.nodes.find(node => node.name === 'SV3_BowPlatform_Rails');
assert(bowRails && bowRails.mesh === undefined, 'bow rails stay a separate blocker root');
for (const name of ['SV3_Wheel_Port', 'SV3_Wheel_Starboard']) {
  const node = gltf.nodes.find(candidate => candidate.name === name);
  assert.deepEqual(node?.extras?.spin_axis, [0, 0, 1], `${name} must spin around its hub axis`);
  assert.equal(node?.extras?.spin_origin, 'wheel hub centre; support rods stay fixed', `${name} must keep support rods fixed`);
}
for (const name of names) assert(!/^(Legacy_|SV2_CabinAftWalk|SV3_CabinPierDetail_|SV3_Repaired_SternRoofDeck|SV3_GlassWall_(Base|Crown|Pier_End))/.test(name ?? ''), `source GLB retains retired ${name}`);

console.log(JSON.stringify({
  passed: true,
  exteriorNodes: exterior.nodes,
  cabinRoute: cabin.route,
  floorRoots: cabin.floorRoots,
  sourceNodesChecked: names.size,
}, null, 2));
