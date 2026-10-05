#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require(path.join(__dirname, '..', 'client', 'node_modules', 'esbuild'));

const root = path.resolve(__dirname, '..');
const asset = path.join(root, 'client', 'public-tms273', 'assets', 'entry', 'voyage-book.glb');
const sourceAsset = path.join(root, 'resources', 'scenes', 'sky-voyage-v3', 'models', 'voyage-book.glb');
assert(fs.readFileSync(asset).equals(fs.readFileSync(sourceAsset)), 'published voyage-book.glb must match the Blender export');

function loadRuntime() {
  const result = esbuild.buildSync({
    stdin: {
      contents: [
        "import * as THREE from 'three';",
        'export { THREE };',
        "export { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';",
        "export { createVoyageBookPageRig } from './src/features/entry/voyage-book-pages.ts';",
      ].join('\n'),
      resolveDir: path.join(root, 'client'),
      sourcefile: 'check-voyage-book-visibility.ts',
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

function finite(value, label) {
  assert(Number.isFinite(value), `${label} is not finite: ${value}`);
}

function meshWorldVertices(THREE, mesh) {
  const position = mesh.geometry?.getAttribute?.('position');
  if (!position) return [];
  const result = [];
  const local = new THREE.Vector3();
  for (let index = 0; index < position.count; index++) {
    if (mesh.isSkinnedMesh) mesh.getVertexPosition(index, local);
    else local.fromBufferAttribute(position, index);
    result.push(local.clone().applyMatrix4(mesh.matrixWorld));
  }
  return result;
}

function range(THREE, meshes) {
  const box = new THREE.Box3();
  let skinnedVertices = 0;
  for (const mesh of meshes) {
    const vertices = meshWorldVertices(THREE, mesh);
    if (mesh.isSkinnedMesh) skinnedVertices += vertices.length;
    for (const vertex of vertices) {
      finite(vertex.x, `${mesh.name} x`);
      finite(vertex.y, `${mesh.name} y`);
      finite(vertex.z, `${mesh.name} z`);
      box.expandByPoint(vertex);
    }
  }
  return { box, skinnedVertices };
}

function select(scene, predicate) {
  const result = [];
  scene.traverse(object => { if (object.visible && object.isMesh && predicate(object)) result.push(object); });
  return result;
}

function rayVisibility(THREE, pageMeshes, coverMeshes) {
  const raycaster = new THREE.Raycaster();
  const direction = new THREE.Vector3(0, 0, -1);
  let rays = 0;
  let pageFirst = 0;
  let coverFirst = 0;
  let pageBehindCover = 0;
  for (let row = 0; row < 31; row++) for (let column = 0; column < 41; column++) {
    raycaster.set(new THREE.Vector3(-.72 + 1.44 * column / 40, -.55 + 1.1 * row / 30, 2), direction);
    const pages = raycaster.intersectObjects(pageMeshes, true);
    const covers = raycaster.intersectObjects(coverMeshes, true);
    rays++;
    if (pages.length && (!covers.length || pages[0].distance < covers[0].distance)) pageFirst++;
    else if (covers.length) {
      coverFirst++;
      if (pages.length) pageBehindCover++;
    }
  }
  return { rays, pageFirst, coverFirst, pageBehindCover, pageVisibleFraction: pageFirst / rays };
}

async function main() {
  const { THREE, GLTFLoader, createVoyageBookPageRig } = loadRuntime();
  const bytes = fs.readFileSync(asset);
  const loader = new GLTFLoader();
  const times = [.85, 1.3];
  const report = [];

  for (const seconds of times) {
    const native = await parse(loader, bytes);
    const clip = native.animations.find(item => item.name === 'SV3_BookOpenFlipGlow');
    assert(clip, 'book animation clip missing');
    const mixer = new THREE.AnimationMixer(native.scene);
    mixer.clipAction(clip).setLoop(THREE.LoopOnce, 1).play();
    mixer.setTime(seconds);
    native.scene.updateMatrixWorld(true);
    const nativePages = select(native.scene, mesh => /^SV3_Page_[LR]_\d{2}_S\d{2}$/.test(mesh.name));
    const nativeCovers = select(native.scene, mesh => mesh.name.startsWith('SV3_Cover_'));
    assert.equal(nativePages.length, 96, 'native GLB page strip count');
    const nativePageRange = range(THREE, nativePages);
    const nativeCoverRange = range(THREE, nativeCovers);
    const nativeRay = rayVisibility(THREE, nativePages, nativeCovers);
    assert.equal(nativePageRange.skinnedVertices, 0, 'the authored book should not silently become an unbound SkinnedMesh');
    assert(nativeRay.pageFirst > 0, `native page ray visibility at ${seconds}s`);
    assert.equal(nativeRay.pageBehindCover, 0, `native paper must not be behind the cover at ${seconds}s`);

    const physical = await parse(loader, bytes);
    const physicalClip = physical.animations.find(item => item.name === 'SV3_BookOpenFlipGlow');
    const physicalMixer = new THREE.AnimationMixer(physical.scene);
    physicalMixer.clipAction(physicalClip).setLoop(THREE.LoopOnce, 1).play();
    const rig = createVoyageBookPageRig(physical.scene);
    rig.reset();
    for (let frame = 1; frame <= Math.round(seconds * 60); frame++) {
      const delta = 1 / 60;
      physicalMixer.update(delta);
      rig.update(delta, (frame / 60) / physicalClip.duration, false);
    }
    physical.scene.updateMatrixWorld(true);
    const physicalPages = select(physical.scene, mesh => mesh.name.startsWith('SV3_PhysicalPage_'));
    const physicalCovers = select(physical.scene, mesh => mesh.name.startsWith('SV3_Cover_'));
    assert.equal(physicalPages.length, 12, 'physical page surface count');
    const physicalPageRange = range(THREE, physicalPages);
    const physicalCoverRange = range(THREE, physicalCovers);
    const physicalRay = rayVisibility(THREE, physicalPages, physicalCovers);
    assert(physicalPageRange.box.min.z >= .105 - 1e-5, `physical page front depth at ${seconds}s`);
    assert(physicalCoverRange.box.max.z < .105, `opened cover must retreat behind the page face at ${seconds}s`);
    assert(physicalRay.pageFirst > 0, `physical page ray visibility at ${seconds}s`);
    assert.equal(physicalRay.pageBehindCover, 0, `physical paper must be in front of cover at ${seconds}s`);
    report.push({
      seconds,
      native: {
        pages: nativePages.length,
        skinnedVertices: nativePageRange.skinnedVertices,
        paperZ: [nativePageRange.box.min.z, nativePageRange.box.max.z],
        coverZ: [nativeCoverRange.box.min.z, nativeCoverRange.box.max.z],
        ray: nativeRay,
      },
      physical: {
        pages: physicalPages.length,
        paperZ: [physicalPageRange.box.min.z, physicalPageRange.box.max.z],
        coverZ: [physicalCoverRange.box.min.z, physicalCoverRange.box.max.z],
        ray: physicalRay,
      },
      coverBones: ['SV3_Cover_L_Bone', 'SV3_Cover_R_Bone'].map(name => ({
        name,
        rotationZ: physical.scene.getObjectByName(name).rotation.z,
      })),
    });
  }
  console.log(JSON.stringify({ asset, skinnedMeshNote: '0 authored SkinnedMesh nodes; getVertexPosition branch is guarded for any future skinned page mesh', report }, null, 2));
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
