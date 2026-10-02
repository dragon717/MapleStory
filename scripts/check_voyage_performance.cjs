#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const esbuild = require(path.join(__dirname, '..', 'client', 'node_modules', 'esbuild'));

const root = path.resolve(__dirname, '..');
const client = path.join(root, 'client');
const modelPath = path.join(client, 'public-tms273', 'assets', 'entry', 'sky-city.glb');
const WIDTH = 1440;
const HEIGHT = 900;
const FRAME_COUNT = 120;
const DT = 1 / 60;
const CITY_POSITION = [-1300, -80, -2200];
const CITY_SCALE = 1.8;

function readGlb(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF', 'city asset is not a GLB');
  assert.equal(bytes.readUInt32LE(4), 2, 'city asset is not glTF 2');
  assert.equal(bytes.readUInt32LE(8), bytes.length, 'city GLB length header is wrong');
  const jsonLength = bytes.readUInt32LE(12);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, 'city GLB has no JSON chunk');
  const jsonEnd = 20 + jsonLength;
  assert(jsonEnd + 8 <= bytes.length, 'city GLB JSON chunk is truncated');
  assert.equal(bytes.readUInt32LE(jsonEnd + 4), 0x004e4942, 'city GLB has no binary chunk');
  return { json: JSON.parse(bytes.toString('utf8', 20, jsonEnd)), binary: bytes.subarray(jsonEnd) };
}

// Keep the same geometry-only loading path as check_voyage_cloth.cjs. The
// published GLB is real input; only browser texture decode is removed.
function geometryOnlyGlb(bytes) {
  const { json, binary } = readGlb(bytes);
  delete json.images;
  delete json.textures;
  for (const material of json.materials ?? []) {
    delete material.normalTexture;
    delete material.emissiveTexture;
    delete material.occlusionTexture;
    delete material.alphaTexture;
    for (const key of ['baseColorTexture', 'metallicRoughnessTexture']) {
      delete material.pbrMetallicRoughness?.[key];
    }
  }
  const encoded = Buffer.from(JSON.stringify(json), 'utf8');
  const padded = Buffer.alloc(Math.ceil(encoded.length / 4) * 4, 0x20);
  encoded.copy(padded);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + padded.length + binary.length, 8);
  header.writeUInt32LE(padded.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, padded, binary]);
}

function loadRuntimeModule() {
  const result = esbuild.buildSync({
    stdin: {
      contents: [
        "import * as THREE from 'three';",
        'export { THREE };',
        "export { VoyageCity } from './src/features/entry/voyage-city.ts';",
        "export { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';",
      ].join('\n'),
      resolveDir: client,
      sourcefile: 'check-voyage-performance-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    write: false,
    logLevel: 'silent',
  });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

function parse(loader, bytes) {
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Promise((resolve, reject) => loader.parse(arrayBuffer, '', resolve, reject));
}

async function makeCity(runtime, geometry) {
  const gltf = await parse(new runtime.GLTFLoader(), geometry);
  const rootNode = gltf.scene;
  rootNode.position.fromArray(CITY_POSITION);
  rootNode.scale.setScalar(CITY_SCALE);
  rootNode.updateMatrixWorld(true);
  const city = new runtime.VoyageCity(rootNode);
  rootNode.updateMatrixWorld(true);
  return { city, root: rootNode };
}

function makeCamera(THREE, position, lookAt) {
  const camera = new THREE.PerspectiveCamera(38, WIDTH / HEIGHT, 1, 24000);
  camera.position.fromArray(position);
  camera.lookAt(new THREE.Vector3().fromArray(lookAt));
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

function setCamera(THREE, camera, position, lookAt) {
  camera.position.fromArray(position);
  camera.lookAt(new THREE.Vector3().fromArray(lookAt));
  camera.updateMatrixWorld(true);
}

function stateList(city) {
  const states = city.deformed;
  assert(Array.isArray(states) && states.length > 0, 'sky-city.glb has no deformed road meshes');
  return states;
}

function positionAttributes(states) {
  return states.map(state => state.mesh.geometry.getAttribute('position'));
}

function versions(states) {
  return positionAttributes(states).map(attribute => attribute.version);
}

function changedCount(before, after) {
  return after.reduce((count, version, index) => count + (version !== before[index] ? 1 : 0), 0);
}

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)];
}

function percentile(values, fraction) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)];
}

function changeSummary(values) {
  return {
    median: median(values),
    p95: percentile(values, .95),
    min: Math.min(...values),
    max: Math.max(...values),
    total: values.reduce((sum, value) => sum + value, 0),
  };
}

function maxAbsDifference(a, b) {
  assert.equal(a.length, b.length, 'attribute arrays have different lengths');
  let result = 0;
  for (let index = 0; index < a.length; index++) result = Math.max(result, Math.abs(a[index] - b[index]));
  return result;
}

function offsetError(cityA, cityB) {
  let result = 0;
  for (const node of cityA.layout.nodes) {
    result = Math.max(result, Math.abs(cityA.nodeOffset(node.id) - cityB.nodeOffset(node.id)));
  }
  return result;
}

function update(cityRecord, camera, time) {
  // The renderer refreshes world matrices around a frame. Keeping this here
  // makes frustum checks use the previous rendered transform and lets the
  // following frame see the newly written island motion.
  cityRecord.root.updateMatrixWorld(true);
  cityRecord.city.update(DT, false, 1, time, camera, HEIGHT);
  cityRecord.root.updateMatrixWorld(true);
}

function measure(cityRecord, camera, startTime = 0) {
  const states = stateList(cityRecord.city);
  const cpuMs = [];
  const changed = [];
  let previous = versions(states);
  for (let frame = 0; frame < FRAME_COUNT; frame++) {
    const start = performance.now();
    update(cityRecord, camera, startTime + frame * DT);
    cpuMs.push(performance.now() - start);
    const next = versions(states);
    changed.push(changedCount(previous, next));
    previous = next;
  }
  return {
    cpuMs: { median: median(cpuMs), p95: percentile(cpuMs, .95) },
    changed,
    totalChanged: changed.reduce((sum, value) => sum + value, 0),
    attributes: states.length,
  };
}

function buildFrustum(THREE, camera) {
  return new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
}

function visibleStateIndices(THREE, cityRecord, camera) {
  const motion = cityRecord.city.layout.landscape.motion;
  const margin = 2 * (motion.commonAmplitude + motion.localAmplitude) + .44;
  const frustum = buildFrustum(THREE, camera);
  const sphere = new THREE.Sphere();
  return stateList(cityRecord.city).flatMap((state, index) => {
    sphere.copy(state.bounds);
    sphere.radius += margin;
    sphere.applyMatrix4(state.mesh.matrixWorld);
    return frustum.intersectsSphere(sphere) ? [index] : [];
  });
}

function projectedError(THREE, fullRecord, gatedRecord, camera, indices) {
  const fullStates = stateList(fullRecord.city);
  const gatedStates = stateList(gatedRecord.city);
  const fullPoint = new THREE.Vector3();
  const gatedPoint = new THREE.Vector3();
  let maxError = 0;
  let samples = 0;
  for (const index of indices) {
    const fullState = fullStates[index];
    const gatedState = gatedStates[index];
    const fullPosition = fullState.mesh.geometry.getAttribute('position').array;
    const gatedPosition = gatedState.mesh.geometry.getAttribute('position').array;
    assert.equal(fullPosition.length, gatedPosition.length, `road ${index} position length`);
    for (let offset = 0; offset < fullPosition.length; offset += 3) {
      fullPoint.fromArray(fullPosition, offset).applyMatrix4(fullState.mesh.matrixWorld).project(camera);
      gatedPoint.fromArray(gatedPosition, offset).applyMatrix4(gatedState.mesh.matrixWorld).project(camera);
      if (![fullPoint.x, fullPoint.y, fullPoint.z, gatedPoint.x, gatedPoint.y, gatedPoint.z].every(Number.isFinite)) continue;
      const onScreen = (point) => Math.abs(point.x) <= 1.1 && Math.abs(point.y) <= 1.1 && point.z >= -1.1 && point.z <= 1.1;
      if (!onScreen(fullPoint) && !onScreen(gatedPoint)) continue;
      const error = Math.hypot((fullPoint.x - gatedPoint.x) * WIDTH / 2, (fullPoint.y - gatedPoint.y) * HEIGHT / 2);
      maxError = Math.max(maxError, error);
      samples++;
    }
  }
  assert(samples > 0, 'city camera has no projected road samples');
  return { maxPixelError: maxError, samples };
}

function compareOffsets(fullRecord, gatedRecord, label) {
  const error = offsetError(fullRecord.city, gatedRecord.city);
  assert(error <= 1e-9, `${label} node offsets diverged by ${error}`);
  return error;
}

function assertRecovery(fullRecord, gatedRecord, camera, indices, label) {
  const error = projectedError(fullRecord.runtime.THREE, fullRecord, gatedRecord, camera, indices);
  assert(error.maxPixelError <= .1 + 1e-7, `${label} projected error ${error.maxPixelError}px exceeds 0.1px`);
  return error;
}

async function main() {
  assert(fs.existsSync(modelPath), `missing real city asset: ${modelPath}`);
  const runtime = loadRuntimeModule();
  const bytes = fs.readFileSync(modelPath);
  const geometry = geometryOnlyGlb(bytes);
  const nearCamera = makeCamera(runtime.THREE, [43, 20, 43], [6.5, 11, 0]);
  const hideCamera = makeCamera(runtime.THREE, [43, 20, 43], [200, 20, 43]);
  const cityCamera = makeCamera(runtime.THREE, [150, 1300, -600], [-1300, 70, -2200]);

  const full = await makeCity(runtime, geometry);
  const gated = await makeCity(runtime, geometry);
  full.runtime = runtime;
  gated.runtime = runtime;
  const states = stateList(full.city);
  assert.equal(states.length, stateList(gated.city).length, 'full and gated city state counts differ');

  const fullMeasurement = measure(full, undefined);
  const gatedMeasurement = measure(gated, nearCamera);
  const offsetMaxError = compareOffsets(full, gated, 'near-camera');
  const reducedFrames = gatedMeasurement.changed.filter((value, index) => value < fullMeasurement.changed[index]).length;
  const changedRatio = gatedMeasurement.totalChanged / Math.max(1, fullMeasurement.totalChanged);
  assert(reducedFrames > FRAME_COUNT / 2, `near-camera attribute reduction only occurred on ${reducedFrames}/${FRAME_COUNT} frames`);
  assert(changedRatio < .5, `near-camera attribute version reduction is not substantial: ratio ${changedRatio}`);

  // Recreate independent records for the transition/recovery checks. This
  // keeps the 120-frame measurement above from hiding a stale-state bug.
  const fullTransition = await makeCity(runtime, geometry);
  const gatedTransition = await makeCity(runtime, geometry);
  fullTransition.runtime = runtime;
  gatedTransition.runtime = runtime;
  update(fullTransition, undefined, 0);
  update(gatedTransition, nearCamera, 0);
  const beforeEntryVersions = versions(stateList(gatedTransition.city));
  setCamera(runtime.THREE, cityCamera, [150, 1300, -600], [-1300, 70, -2200]);
  update(fullTransition, undefined, DT);
  update(gatedTransition, cityCamera, DT);
  const afterEntryVersions = versions(stateList(gatedTransition.city));
  const entryChanged = changedCount(beforeEntryVersions, afterEntryVersions);
  const entryVisible = visibleStateIndices(runtime.THREE, gatedTransition, cityCamera);
  assert(entryVisible.length > 0, 'city camera did not see a dynamic road');
  assert(entryChanged > 0, 'city camera did not update any visible road attribute');
  const entryError = assertRecovery(fullTransition, gatedTransition, cityCamera, entryVisible, 'city entry');

  const targetIndex = entryVisible[0];
  const targetBeforeHidden = versions(stateList(gatedTransition.city))[targetIndex];
  const hiddenVisible = visibleStateIndices(runtime.THREE, gatedTransition, hideCamera);
  assert(!hiddenVisible.includes(targetIndex), 'hide camera still sees the selected city road');
  let hiddenTargetChanged = false;
  for (let frame = 2; frame <= 61; frame++) {
    update(fullTransition, undefined, frame * DT);
    const before = versions(stateList(gatedTransition.city))[targetIndex];
    update(gatedTransition, hideCamera, frame * DT);
    const after = versions(stateList(gatedTransition.city))[targetIndex];
    if (after !== before) hiddenTargetChanged = true;
  }
  assert.equal(hiddenTargetChanged, false, 'offscreen road kept writing position attributes while hidden');
  const hiddenTargetVersion = versions(stateList(gatedTransition.city))[targetIndex];
  assert.equal(hiddenTargetVersion, targetBeforeHidden, 'hidden road attribute version drifted');

  setCamera(runtime.THREE, cityCamera, [150, 1300, -600], [-1300, 70, -2200]);
  const beforeRecoveryVersions = versions(stateList(gatedTransition.city));
  update(fullTransition, undefined, 62 * DT);
  update(gatedTransition, cityCamera, 62 * DT);
  const afterRecoveryVersions = versions(stateList(gatedTransition.city));
  const recoveryChanged = changedCount(beforeRecoveryVersions, afterRecoveryVersions);
  const recoveryVisible = visibleStateIndices(runtime.THREE, gatedTransition, cityCamera);
  assert(recoveryVisible.length > 0, 'city camera did not see a road after recovery');
  assert(recoveryChanged > 0, 'visible roads were not restored after offscreen motion');
  assert(afterRecoveryVersions[targetIndex] !== beforeRecoveryVersions[targetIndex], 'entry road did not refresh after recovery');
  const recoveryError = assertRecovery(fullTransition, gatedTransition, cityCamera, recoveryVisible, 'city recovery');
  const recoveryOffsetError = compareOffsets(fullTransition, gatedTransition, 'city recovery');

  console.log(JSON.stringify({
    status: 'passed',
    asset: {
      path: path.relative(root, modelPath),
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      geometryOnlyTextureDecode: true,
    },
    viewport: { width: WIDTH, height: HEIGHT },
    nearCamera: { fov: nearCamera.fov, position: [43, 20, 43], lookAt: [6.5, 11, 0] },
    cityCamera: { fov: cityCamera.fov, position: [150, 1300, -600], lookAt: [-1300, 70, -2200] },
    city: { dynamicMeshes: states.length, layoutNodes: full.city.layout.nodes.length },
    comparison: {
      frames: FRAME_COUNT,
      nodeOffsetMaxError: offsetMaxError,
      full: { cpuMs: fullMeasurement.cpuMs, positionAttributeChanges: changeSummary(fullMeasurement.changed) },
      nearCamera: { cpuMs: gatedMeasurement.cpuMs, positionAttributeChanges: changeSummary(gatedMeasurement.changed) },
      reducedFrames,
      changedAttributeRatio: changedRatio,
    },
    transition: {
      visibleRoads: entryVisible.length,
      changedPositionAttributes: entryChanged,
      maxPixelError: entryError.maxPixelError,
      projectedSamples: entryError.samples,
    },
    recovery: {
      hiddenFrames: 60,
      targetRoadIndex: targetIndex,
      hiddenTargetVersionDelta: hiddenTargetVersion - targetBeforeHidden,
      visibleRoads: recoveryVisible.length,
      changedPositionAttributes: recoveryChanged,
      maxPixelError: recoveryError.maxPixelError,
      projectedSamples: recoveryError.samples,
      nodeOffsetMaxError: recoveryOffsetError,
    },
  }, null, 2));
}

main().catch(error => {
  console.error(`FAIL: ${error.stack || error.message || error}`);
  process.exitCode = 1;
});
