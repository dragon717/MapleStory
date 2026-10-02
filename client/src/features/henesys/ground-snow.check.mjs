import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as T from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const source = fs.readFileSync(new URL('./ground-snow.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const { SnowSurface, advanceSnowCover, EMPTY_SNOW } = new Function('T', `${js};return {SnowSurface,advanceSnowCover,EMPTY_SNOW};`)(T);
const winter = { season: 'winter', weather: 'snow' }, clear = { ...winter, weather: 'clear' }, summer = { season: 'summer', weather: 'clear' };
let cover = { ...EMPTY_SNOW };
for (let i = 0; i < 45; i++) cover = advanceSnowCover(cover, winter, 1);
assert.ok(cover.amount > .999 && cover.depth > .179);
assert.deepEqual(advanceSnowCover(cover, clear, 1), cover, 'stopping winter snow preserves coverage and tracks');
assert.deepEqual(advanceSnowCover(cover, winter, NaN), cover);
assert.deepEqual(advanceSnowCover(cover, winter, -1), cover);
const previousFall = cover.fall;
cover = advanceSnowCover(cover, winter, 1);
assert.ok(cover.fall > previousFall, 'fresh snow still refills footprints after maximum depth');
for (let i = 0; i < 71; i++) cover = advanceSnowCover(cover, summer, 1);
assert.equal(cover.amount, 0, 'warm-season melt reaches zero');

const model = new T.Group(), roadMaterial = new T.MeshStandardMaterial(), roofMaterial = new T.MeshStandardMaterial();
roadMaterial.name = 'CE_road'; roofMaterial.name = 'CE_red';
for (const material of [roadMaterial, roofMaterial]) {
  material.customProgramCacheKey = () => 'reveal-climate-existing';
  material.onBeforeCompile = shader => { shader.uniforms.existingHook = { value: 1 }; shader.fragmentShader += '\n// reveal-climate-existing'; };
}
function road(x, y, slope = 0) {
  const geometry = new T.PlaneGeometry(10, 10).rotateX(-Math.PI / 2), p = geometry.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, y + p.getX(i) * slope);
  const mesh = new T.Mesh(geometry, roadMaterial); mesh.position.x = x; mesh.userData.layer = 'roads'; mesh.userData.walkable = true; model.add(mesh); return mesh;
}
const lower = road(0, 0), nearLayer = road(0, .12), bridge = road(0, 3), slope = road(13, 6, .5);
const roof = new T.Mesh(new T.PlaneGeometry(4, 4).rotateX(-Math.PI / 2), roofMaterial); roof.position.set(0, 7, 0); roof.userData.layer = 'buildings'; model.add(roof);
const capGeometry = new T.SphereGeometry(2, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2);
for (let i = 0; i < capGeometry.index.count; i += 3) { const b = capGeometry.index.getX(i + 1); capGeometry.index.setX(i + 1, capGeometry.index.getX(i + 2)); capGeometry.index.setX(i + 2, b); }
const inwardCap = new T.Mesh(capGeometry, roofMaterial); inwardCap.name = 'InwardRoofCap'; inwardCap.position.set(20, 8, 0); inwardCap.userData.layer = 'buildings'; model.add(inwardCap);
const underside = new T.Mesh(new T.PlaneGeometry(4, 4).rotateX(Math.PI / 2), roofMaterial); underside.name = 'RoofUnderside'; underside.position.set(20, 7.9, 0); underside.userData.layer = 'buildings'; model.add(underside);
const roofWall = new T.Mesh(new T.PlaneGeometry(4, 2), roofMaterial); roofWall.name = 'RoofWall'; roofWall.position.set(20, 7, 2); roofWall.userData.layer = 'buildings'; model.add(roofWall);
const roofBox = new T.Mesh(new T.BoxGeometry(4, .4, 4), roofMaterial); roofBox.name = 'ClosedRoofBox'; roofBox.position.set(26, 8, 0); roofBox.userData.layer = 'buildings'; model.add(roofBox);
const snow = new SnowSurface(model);
for (let i = 0; i < 45; i++) snow.update(winter, 1, i);
const sourcePositions = lower.geometry.attributes.position.array.slice();
assert.equal(snow.tiles.length, 12);
assert.ok(snow.shells.some(s => s.name === 'CE_Snow_' + roof.name), 'real roof gets a separate snow shell');
assert.ok(snow.shells.some(s => s.name === 'CE_Snow_InwardRoofCap'), 'a wholly inward dome gets outward-facing snow over its summit');
assert.ok(!snow.shells.some(s => /RoofUnderside|RoofWall/.test(s.name)), 'the same coloured coating does not turn an underside or wall into a snowy surface');
const boxSnow = snow.shells.find(s => s.name === 'CE_Snow_ClosedRoofBox');
assert.ok(boxSnow && [...boxSnow.geometry.attributes.position.array].filter((_, i) => i % 3 === 1).every(y => Math.abs(y - 8.2) < 1e-5), 'a closed roof box keeps its original top selection and excludes the underside');
assert.ok(snow.shells.every(s => s.geometry.attributes.snowTop.array.includes(0)), 'snow shell skirts close down to the supporting surface');
assert.equal(snow.stamp({ x: 1, y: 0, z: 1 }, { x: 1, z: 0 }), true);
const lowTile = snow.tiles.find(t => t.assigned && Math.abs(snow.tileHeight(t, 1, 1)) < .01);
assert.ok(lowTile);
const lowPress = lowTile.press.array.slice();
assert.equal(snow.stamp({ x: 1, y: .12, z: 1 }, { x: 1, z: 0 }), true);
const nearTile = snow.tiles.find(t => t.assigned && Math.abs(snow.tileHeight(t, 1, 1) - .12) < .001);
assert.ok(nearTile && nearTile !== lowTile, 'even nearby overlapping road sheets retain distinct heightfields');
assert.deepEqual(lowTile.press.array, lowPress);
assert.equal(snow.stamp({ x: 1, y: 3, z: 1 }, { x: 1, z: 0 }), true);
const highTile = snow.tiles.find(t => t.assigned && Math.abs(snow.tileHeight(t, 1, 1) - 3) < .01);
assert.ok(highTile && highTile !== lowTile, 'same XZ on the bridge and below it uses separate heightfields');
assert.deepEqual(lowTile.press.array, lowPress, 'a bridge footprint leaves the lower road untouched');
const bridgeShell = snow.shells.find(s => snow.shellSources.get(s) === bridge);
bridge.visible = false; snow.update(clear, 0, 46);
assert.equal(bridgeShell.visible, false, 'cutaway removes the supporting upper-road snow');
assert.equal(highTile.mesh.visible, false, 'upper-road tracks follow their supporting surface');
assert.equal(lowTile.mesh.visible, true, 'current lower-road snow remains visible');
assert.equal(snow.uniforms.snowTiles.value[snow.tiles.indexOf(highTile)].z, 0);
assert.equal(snow.stamp({ x: 2, y: 3, z: 2 }, { x: 1, z: 0 }), false, 'hidden surfaces cannot receive tracks');
bridge.visible = true;
const exterior = new T.Group(); model.add(exterior); exterior.add(bridge); exterior.visible = false;
snow.update(clear, 0, 47); assert.equal(bridgeShell.visible, false, 'hidden ancestors also hide snow');
exterior.visible = true; snow.update(clear, 0, 48);
assert.equal(bridgeShell.visible, true); assert.equal(highTile.mesh.visible, true);
assert.deepEqual(lowTile.press.array, lowPress, 'cutaway and restoration preserve existing footprints');
assert.equal(snow.stamp({ x: 1, y: 1.5, z: 1 }, { x: 1, z: 0 }), false, 'a point between road layers cannot stamp either');
assert.equal(snow.stamp({ x: NaN, y: 0, z: 1 }, { x: 1, z: 0 }), false);
assert.equal(snow.stamp({ x: 13, y: 6, z: 1 }, { x: 1, z: 0 }), true);
const slopeTile = snow.tiles.find(t => t.assigned && Math.abs(snow.tileHeight(t, 13, 1) - 6) < .01);
assert.ok(slopeTile && Math.abs(snow.tileHeight(slopeTile, 14, 1) - 6.5) < .01, 'the local grid preserves the actual road grade');
const active = snow.tiles.filter(t => t.assigned);
assert.ok(active.every(t => t.mesh.geometry.attributes.position.count === 65 * 65));
assert.ok(active.every(t => Math.max(...t.press.array.filter((_, i) => i % 2 === 0)) > 0), 'footprint centres have real vertex depressions');
assert.deepEqual(lower.geometry.attributes.position.array, sourcePositions, 'authoritative/source geometry is never displaced');
assert.equal(lower.material, roadMaterial); assert.equal(nearLayer.material, roadMaterial); assert.equal(bridge.material, roadMaterial); assert.equal(slope.material, roadMaterial); assert.equal(roof.material, roofMaterial);

const shell = snow.shells[0], shader = { uniforms: {}, vertexShader: T.ShaderLib.standard.vertexShader, fragmentShader: T.ShaderLib.standard.fragmentShader };
shell.material.onBeforeCompile(shader, {});
assert.equal(shader.uniforms.existingHook.value, 1); assert.match(shell.material.customProgramCacheKey(), /reveal-climate-existing/);
assert.match(shader.fragmentShader, /reveal-climate-existing/);
assert.match(shader.vertexShader, /transformed.y\+=/, 'snow thickness and indentation affect vertices');
assert.match(shader.fragmentShader, /dFdx\(snowViewPosition\)/, 'deformed snow gets its actual geometric light normal');
assert.match(shader.fragmentShader, /abs\(layerHeight-snowBasePosition.y\)<.025/, 'coarse road shell is replaced only at the same altitude with its real local grade');
const depthShader = { uniforms: {}, vertexShader: T.ShaderLib.depth.vertexShader, fragmentShader: T.ShaderLib.depth.fragmentShader };
shell.customDepthMaterial.onBeforeCompile(depthShader, {});
assert.match(depthShader.vertexShader, /snowIndent/); assert.match(depthShader.fragmentShader, /snowLayerMap/);
assert.ok(snow.update(clear, 0, 100));
assert.equal(snow.update(clear, 0, 100.1), false, 'unchanged snow does not repeatedly redraw the shadow map');
assert.ok(snow.stamp({ x: 2, y: 0, z: 2 }, { x: 1, z: 0 }));
assert.equal(snow.update(clear, 0, 100.2), false, 'fresh prints share the bounded shadow refresh budget');
assert.equal(snow.update(clear, 0, 100.5), true);
for (let i = 0; i < 71; i++) snow.update(summer, 1, 101 + i);
assert.equal(snow.amount, 0); assert.ok(snow.tiles.every(t => !t.mesh.visible && t.press.array.every(p => p === 0)), 'fully melted snow removes old tracks');
let sourceDisposals = 0; lower.geometry.addEventListener('dispose', () => sourceDisposals++); roadMaterial.addEventListener('dispose', () => sourceDisposals++);
snow.destroy(); snow.destroy(); assert.equal(sourceDisposals, 0); assert.equal(snow.root.parent, null);

// Read the actual exported GLB without decoding its unrelated embedded textures.
const glb = fs.readFileSync(new URL('../../../../resources/scenes/chuxian-east-v1/models/chuxian-east.glb', import.meta.url));
const jsonLength = glb.readUInt32LE(12), json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8'));
delete json.images; delete json.textures;
for (const material of json.materials ?? []) {
  delete material.normalTexture; delete material.emissiveTexture; delete material.occlusionTexture;
  if (material.pbrMetallicRoughness) { delete material.pbrMetallicRoughness.baseColorTexture; delete material.pbrMetallicRoughness.metallicRoughnessTexture; }
}
const encoded = Buffer.from(JSON.stringify(json), 'utf8'), padded = Buffer.alloc(Math.ceil(encoded.length / 4) * 4, 32); encoded.copy(padded);
const binary = glb.subarray(20 + jsonLength), header = Buffer.alloc(20); header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + padded.length + binary.length, 8); header.writeUInt32LE(padded.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
const copy = Buffer.concat([header, padded, binary]);
const loaded = await new Promise((resolve, reject) => new GLTFLoader().parse(copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength), '', resolve, reject));
const capSources = [];
loaded.scene.traverse(o => { if (o instanceof T.Mesh && (/CE_CottageHoney/.test(o.name) && /CE_yellow/.test(o.material.name) || /CE_Market/.test(o.name) && /CE_orange/.test(o.material.name) || /CE_CottageRose/.test(o.name) && /CE_red/.test(o.material.name))) capSources.push(o); });
const actual = new SnowSurface(loaded.scene);
assert.equal(capSources.length, 3);
for (const cap of capSources) {
  const shell = actual.shells.find(s => s.name === 'CE_Snow_' + cap.name);
  assert.ok(shell && new T.Box3().setFromObject(shell).max.y >= new T.Box3().setFromObject(cap).max.y - .02, `${cap.name}: snow covers the actual coloured cap summit, not only white roof spots`);
}
assert.ok(actual.shells.length >= 14, 'the formal village produces roof, terrain and road snow geometry');
assert.ok(actual.bins.size > 100, 'the formal walkable mesh supplies real road-height samples');
for (let i = 0; i < 45; i++) actual.update(winter, 1, i);
assert.ok(actual.stamp({ x: -34, y: 5, z: 20 }, { x: 1, z: 0 }), 'the real main-road junction accepts a grounded footprint');
assert.ok(actual.stamp({ x: -35, y: 3.2, z: 50 }, { x: 0, z: 1 }), 'the real bridge accepts its own-height footprint');
assert.equal(actual.stamp({ x: -35, y: .65, z: 50 }, { x: 0, z: 1 }), false, 'a water-height point under the actual bridge cannot indent its snow');
const vertexCount = actual.shells.reduce((n, mesh) => n + mesh.geometry.attributes.position.count, 0) + actual.tiles.reduce((n, tile) => n + tile.position.count, 0);
assert.ok(vertexCount < 150000, 'the formal snow geometry has a fixed modest vertex budget');
const shellCount = actual.shells.length, binCount = actual.bins.size; actual.destroy();
console.log(`PASS: accumulation/retention/melt/refill, real heightfield indentation, bridge layers/slopes, shader hook and shadow chaining, fixed buffers and isolated disposal; formal GLB ${shellCount} snow shells, ${binCount} road bins, ${vertexCount} vertices.`);
