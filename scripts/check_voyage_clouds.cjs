const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'build/.checks/voyage-clouds.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
const requireClient = createRequire(path.join(root, 'client/package.json'));
requireClient('esbuild').buildSync({ stdin: { contents: "export * from './voyage-clouds'; export * as T from 'three';", resolveDir: path.join(root, 'client/src/features/entry'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: output });
const { VoyageClouds, T } = require(output);
const start = performance.now(), cloud = new VoyageClouds(), second = new VoyageClouds();
const generationMs = (performance.now() - start) / 2;
assert.deepEqual(cloud.noise.image.data, second.noise.image.data, 'fixed seed must produce the same volume');
assert.equal(cloud.noise.image.depth, 64); assert.equal(cloud.noise.image.data.length, 64 ** 3 * 4);
assert.equal(cloud.noise.wrapS, T.RepeatWrapping); assert.equal(cloud.noise.wrapT, T.RepeatWrapping); assert.equal(cloud.noise.wrapR, T.RepeatWrapping);
const voxel = (x, y, z, channel = 0) => cloud.noise.image.data[((z * 64 + y) * 64 + x) * 4 + channel];
for (const axis of [0, 1, 2]) {
  const line = Array.from({ length: 64 }, (_, i) => { const p = [21, 31, 17]; p[axis] = i; return voxel(...p); });
  assert(Math.max(...line) - Math.min(...line) > 35, 'density must vary through every spatial axis');
}
assert.notEqual(voxel(21, 31, 17, 0), voxel(21, 31, 17, 2), 'shape and erosion must be separate procedural fields');
cloud.resize(3840, 2160);
assert.equal(cloud.sceneTarget.width, 3840); assert.equal(cloud.sceneTarget.height, 2160);
assert.equal(cloud.volumeTarget.width, 640); assert.equal(cloud.volumeTarget.height, 360);
cloud.resize(390, 844);
assert.equal(cloud.volumeTarget.width, 167); assert.equal(cloud.volumeTarget.height, 360);
cloud.resize(NaN, 1); assert.equal(cloud.sceneTarget.width, 390);
cloud.update(1 / 60); const time = cloud.uniforms.cloudTime.value;
cloud.update(3600, false, false); cloud.update(3600, true); cloud.update(NaN); cloud.update(-1);
assert.equal(cloud.uniforms.cloudTime.value, time, 'hidden/reduced/invalid updates must stay still');
cloud.update(3600); assert(Math.abs(cloud.uniforms.cloudTime.value - time - .05) < 1e-10, 'resume delta must stay bounded');

const scene = new T.Scene(), camera = new T.PerspectiveCamera(46, 1, 1, 24000), sun = new T.DirectionalLight(0xfff3cf, .95);
camera.position.set(0, -420, -1600); sun.position.set(220, 380, 100); sun.target.position.z = -30;
scene.add(sun, sun.target); scene.fog = new T.Fog(0xd8e8ee, 2600, 11000);
let target = null, scissor = true; const draws = [];
const renderer = { autoClear: false, getRenderTarget: () => target, getActiveCubeFace: () => 0, getActiveMipmapLevel: () => 0,
  getScissorTest: () => scissor, setScissorTest: value => { scissor = value; }, setRenderTarget: value => { target = value; },
  render: (s, c) => { s.updateMatrixWorld(true); c.updateMatrixWorld(true); draws.push({ scene: s, target }); } };
cloud.render(renderer, scene, camera, sun);
assert.deepEqual(draws.map(draw => draw.target), [cloud.sceneTarget, cloud.volumeTarget, null], 'one scene capture, one volume, one composite');
assert.equal(renderer.autoClear, false); assert.equal(scissor, true); assert.equal(target, null);
assert.deepEqual(cloud.uniforms.eye.value.toArray(), camera.position.toArray(), 'camera inside the cloud uses the actual eye');
assert(cloud.uniforms.sunDirection.value.distanceTo(new T.Vector3(220, 380, 130).normalize()) < 1e-7);
renderer.render = () => { throw Error('render failure'); };
assert.throws(() => cloud.render(renderer, scene, camera, sun), /render failure/);
assert.equal(renderer.autoClear, false); assert.equal(scissor, true); assert.equal(target, null, 'failed pass must restore renderer state');

// Shader contract checks accompany runtime ownership checks; GPU compilation/appearance is a separate targeted preview check.
assert.match(cloud.volume.fragmentShader, /finish=min\(interval\.y,sceneDistance\(uv\)\)/, 'opaque depth bounds the integral');
assert.match(cloud.volume.fragmentShader, /exp\(-cloud\*stepLength\*extinction\)/, 'extinction depends on traveled distance');
assert.match(cloud.volume.fragmentShader, /density\(p\+sunDirection\*/, 'sun shadow samples the same density field');
assert.match(cloud.composite.fragmentShader, /volume\/totalWeight : integrateClouds\(screenUv\)/, 'unmatched depth edges need their own ray');
let disposals = 0;
for (const resource of [cloud.sceneTarget, cloud.volumeTarget, cloud.noise, cloud.quad.geometry, cloud.volume, cloud.composite]) resource.addEventListener('dispose', () => disposals++);
cloud.destroy(); cloud.destroy(); cloud.update(1); cloud.resize(200, 200);
assert.equal(disposals, 6, 'all six GPU owners release exactly once'); assert.equal(cloud.noise.image.data.length, 0);
assert.equal(cloud.scene.children.length, 0); assert.equal(cloud.sceneTarget.width, 390);
second.destroy();
console.log(`Voyage clouds: deterministic 3D field, bounded targets/time, render ownership/depth contract/disposal passed; CPU generation ${generationMs.toFixed(1)} ms per volume. GPU appearance is not asserted here.`);
