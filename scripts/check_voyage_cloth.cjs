#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const esbuild = require(path.join(__dirname, '..', 'client', 'node_modules', 'esbuild'));

const root = path.resolve(__dirname, '..');
const client = path.join(root, 'client');
const modelPath = path.join(client, 'public-tms273', 'assets', 'entry', 'sky-voyage.glb');

function finiteArray(value, label) {
  assert(value && typeof value.length === 'number', `${label} is not an array-like value`);
  for (let i = 0; i < value.length; i++) assert(Number.isFinite(value[i]), `${label}[${i}] is not finite`);
}

function close(a, b, epsilon = 1e-5) {
  return Math.abs(a - b) <= epsilon;
}

function equalArrays(a, b, label, epsilon = 1e-5) {
  assert.equal(a.length, b.length, `${label} length`);
  for (let i = 0; i < a.length; i++) assert(close(a[i], b[i], epsilon), `${label}[${i}] differs: ${a[i]} vs ${b[i]}`);
}

function readGlb(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF', 'ship asset is not a GLB');
  assert.equal(bytes.readUInt32LE(4), 2, 'ship asset is not glTF 2');
  assert.equal(bytes.readUInt32LE(8), bytes.length, 'ship GLB length header is wrong');
  const jsonLength = bytes.readUInt32LE(12);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, 'ship GLB has no JSON chunk');
  const jsonEnd = 20 + jsonLength;
  assert(jsonEnd + 8 <= bytes.length, 'ship GLB JSON chunk is truncated');
  assert.equal(bytes.readUInt32LE(jsonEnd + 4), 0x004e4942, 'ship GLB has no binary chunk');
  return { json: JSON.parse(bytes.toString('utf8', 20, jsonEnd)), binary: bytes.subarray(jsonEnd) };
}

// GLTFLoader can inspect the embedded geometry in Node without decoding the
// unrelated browser textures. Removing only texture references keeps every
// node, accessor, morph target, and UV set from the real published GLB.
function geometryOnlyGlb(bytes) {
  const { json, binary } = readGlb(bytes);
  delete json.images;
  delete json.textures;
  for (const material of json.materials ?? []) {
    delete material.normalTexture;
    delete material.emissiveTexture;
    delete material.occlusionTexture;
    delete material.alphaTexture;
    for (const key of ['baseColorTexture', 'metallicRoughnessTexture']) delete material.pbrMetallicRoughness?.[key];
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
        "export { THREE };",
        "export { projectLoginSurface, loginSurfaceOccluded } from './src/features/entry/voyage-login.ts';",
        "export { VoyageCity } from './src/features/entry/voyage-city.ts';",
        "export { VoyageDeck } from './src/features/entry/voyage-deck.ts';",
        "export { EntryVoyage, voyageOpeningPose } from './src/features/entry/voyage.ts';",
        "export { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';",
        "export { ShipFlight } from './src/features/entry/voyage-ship.ts';",
        "export { LocalReveal } from './src/features/henesys/local-reveal.ts';",
      ].join('\n'),
      resolveDir: client,
      sourcefile: 'check-voyage-cloth-entry.ts',
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
  // The bundle contains the same Three instance for EntryVoyage, GLTFLoader,
  // ShipFlight, and LocalReveal, so instanceof checks remain meaningful.
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

function parse(loader, bytes) {
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Promise((resolve, reject) => loader.parse(arrayBuffer, '', resolve, reject));
}

function morphIndex(mesh, name) {
  return mesh.morphTargetDictionary?.[name];
}

function setMorph(mesh, name, value) {
  const index = morphIndex(mesh, name);
  if (index !== undefined && mesh.morphTargetInfluences) mesh.morphTargetInfluences[index] = value;
}

function assertFiniteSails(sails, frame) {
  for (const [sailIndex, sail] of sails.entries()) {
    finiteArray(sail.simulation.positions, `sail ${sailIndex} simulation at frame ${frame}`);
    finiteArray(sail.simulation.previous, `sail ${sailIndex} previous at frame ${frame}`);
    for (const binding of sail.meshes) {
      finiteArray(binding.mesh.geometry.getAttribute('position').array, `${binding.mesh.name} position at frame ${frame}`);
      finiteArray(binding.offsets, `${binding.mesh.name} offsets`);
    }
  }
}

function checkSailBindings(runtime, scene) {
  const { EntryVoyage, ShipFlight, THREE } = runtime;
  const fanNames = [
    'SV3_AftFan_0', 'SV3_AftFan_1', 'SV3_AftFan_2',
    'SV3_MainFan_0', 'SV3_MainFan_1', 'SV3_MainFan_2',
  ];
  const fanRoots = fanNames.map(name => {
    const node = scene.getObjectByName(name);
    assert(node, `missing ${name}`);
    assert.equal(node.userData.cloth_columns, 12, `${name} cloth_columns`);
    assert.equal(node.userData.cloth_rows, 32, `${name} cloth_rows`);
    assert.equal(node.userData.cloth_two_sides, true, `${name} cloth_two_sides`);
    assert.equal(node.userData.cloth_grid_uv, 'uv2', `${name} cloth_grid_uv`);
    return node;
  });

  const timberBefore = [];
  const fanTimberBefore = [];
  scene.traverse(object => {
    if (!(object instanceof THREE.Mesh) || !object.name.includes('TimberSpars')) return;
    const position = object.geometry.getAttribute('position');
    const item = { object, position: position.array.slice(), dictionary: object.morphTargetDictionary };
    timberBefore.push(item);
    if (/^SV3_(?:Aft|Main)Fan_[0-2]_TimberSpars/.test(object.name)) fanTimberBefore.push(item);
  });
  assert.equal(timberBefore.length, 36, 'all exported timber-spar primitives must remain present');
  assert.equal(fanTimberBefore.length, 12, 'the six fan fold rigs must retain their timber-spar primitives');

  const subject = Object.create(EntryVoyage.prototype);
  subject.sails = [];
  EntryVoyage.prototype.bindSails.call(subject, scene);
  assert.equal(subject.sails.length, 12, 'six two-sided fans must produce twelve cloth solvers');

  const byRoot = new Map();
  for (const sail of subject.sails) {
    assert.equal(sail.simulation.columns, 12);
    assert.equal(sail.simulation.rows, 32);
    assert.equal(sail.simulation.positions.length, 429 * 3);
    assert.equal(sail.simulation.rest.length, 429 * 3);
    assert.equal(sail.simulation.pinned.length, 429);
    finiteArray(sail.simulation.rest, 'initial cloth rest positions');
    const root = sail.meshes[0].mesh;
    const roots = byRoot.get(root.name) ?? [];
    roots.push(sail);
    byRoot.set(root.name, roots);
    for (const binding of sail.meshes) {
      assert(!binding.mesh.name.includes('TimberSpars'), `${binding.mesh.name} was incorrectly added to cloth`);
      const valid = binding.map.filter(index => index >= 0);
      assert.equal(valid.length, 429, `${binding.mesh.name} must map one side to 429 points`);
      assert.equal(new Set(valid).size, 429, `${binding.mesh.name} has duplicate cloth grid ids`);
      assert.equal(Math.min(...valid), 0, `${binding.mesh.name} cloth map minimum`);
      assert.equal(Math.max(...valid), 428, `${binding.mesh.name} cloth map maximum`);
    }
  }
  for (const name of fanNames) {
    assert.equal(byRoot.get(name)?.length, 2, `${name} must have one solver per face`);
  }
  const mainSails = subject.sails.filter(s => s.meshes[0].mesh.name.startsWith('SV3_MainFan_'));
  assert.equal(mainSails.length, 6);
  const ranges=[];
  for(let sector=0;sector<3;sector++) {
    const crest=scene.getObjectByName(`SV3_MainSail_Crest_${sector}`);
    assert(crest, 'missing main gore crest');
    assert.equal(crest.userData.cloth_grid_uv,'uv1');
    const [u0,u1]=crest.userData.emblem_u_range;ranges.push([u0,u1]);
    const art=crest.geometry.getAttribute('uv'),grid=crest.geometry.getAttribute('uv1');
    for(let i=0;i<grid.count;i++){
      assert.equal(crest.userData.emblem_rotation_degrees,270);
      assert(close(art.getX(i),1-(grid.getY(i)-.30)/.40), 'whole emblem shifts toward the larger forward sail region');
      assert(close(art.getY(i),u0+(u1-u0)*grid.getX(i)+.12), 'each gore shares the globally inverted emblem');
    }
  }
  assert(close(ranges[0][0],0)&&close(ranges[2][1],1));
  for(let i=0;i<2;i++)assert(close(ranges[i][1],ranges[i+1][0]), 'emblem cannot jump at a gore seam');
  for (const sail of mainSails) {
    const [rootBinding, crestBinding] = sail.meshes;
    assert(crestBinding, 'every main gore must carry its portion of the same emblem');
    assert.deepEqual(crestBinding.map, rootBinding.map, 'crest and main sail must share grid mapping');
    equalArrays(crestBinding.offsets, rootBinding.offsets, 'crest/main cloth offsets');
    equalArrays(crestBinding.basis, rootBinding.basis, 'crest/main cloth base geometry');
  }

  for (const item of timberBefore) equalArrays(item.position, item.object.geometry.getAttribute('position').array, `${item.object.name} after bindSails`);

  const ship = scene.getObjectByName('SV2_Ship');
  assert(ship, 'missing SV2_Ship');
  const flight = new ShipFlight(ship);
  flight.setControls({ sail: .18, wind: 16, throttle: .7 });
  const dt = 1 / 60;
  for (let frame = 0; frame < 90; frame++) {
    flight.update(dt);
    // ShipFlight supplies the production fold rig. Keep a small wind morph
    // on the cloth meshes too so updateSails exercises both retarget inputs.
    for (const root of fanRoots) {
      const fold = .18 + .52 * (frame / 89);
      const pressure = .08 + .26 * (0.5 + 0.5 * Math.sin(frame * .19));
      setMorph(root, 'DeployFold', fold);
      setMorph(root, 'WindPressure', pressure);
      root.traverse(child => {
        if (child instanceof THREE.Mesh && child.userData.cloth_grid_uv === 'uv1') {
          setMorph(child, 'DeployFold', fold);
          setMorph(child, 'WindPressure', pressure);
        }
      });
    }
    EntryVoyage.prototype.updateSails.call(subject, dt, frame * dt);
    assertFiniteSails(subject.sails, frame);
  }

  for (const sail of mainSails) {
    const root = sail.meshes[0].mesh.geometry.getAttribute('position').array;
    const crestPosition = sail.meshes[1].mesh.geometry.getAttribute('position').array;
    equalArrays(root, crestPosition, 'crest follows the same simulated positions');
  }
  for (const item of fanTimberBefore) {
    equalArrays(item.position, item.object.geometry.getAttribute('position').array, `${item.object.name} remains outside cloth CPU writes`);
    const fold = morphIndex(item.object, 'DeployFold');
    assert(fold !== undefined, `${item.object.name} lost its original fold morph`);
    assert((item.object.morphTargetInfluences?.[fold] ?? 0) > 0, `${item.object.name} fold rig was not driven by ShipFlight`);
  }
  return { solvers: subject.sails.length, gridPointsPerSolver: 429, fans: fanNames.length, timberSparMeshes: timberBefore.length, fanFoldMeshes: fanTimberBefore.length, frames: 90 };
}

function checkLocalReveal(runtime) {
  const { LocalReveal, THREE } = runtime;
  const model = new THREE.Group();
  const source = new THREE.MeshStandardMaterial({ color: '#8b6a4a' });
  source.customProgramCacheKey = () => 'cloth-check-source-v1';
  source.onBeforeCompile = shader => {
    shader.uniforms.clothCheckSourceHook = { value: 1 };
    shader.fragmentShader += '\n// cloth-check-source-hook';
  };
  const block = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), source);
  block.name = 'ClothCheckMovingBuilding';
  block.userData.layer = 'buildings';
  model.add(block);
  model.updateMatrixWorld(true);

  const reveal = new LocalReveal(model);
  const patched = block.material;
  assert.notEqual(patched, source, 'LocalReveal must clone the source material');
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: `${THREE.ShaderLib.standard.fragmentShader}\n#include <clipping_planes_pars_fragment>\n#include <clipping_planes_fragment>`,
  };
  patched.onBeforeCompile(shader, undefined);
  assert.equal(shader.uniforms.clothCheckSourceHook.value, 1, 'LocalReveal dropped the source shader hook');
  assert.match(shader.fragmentShader, /cloth-check-source-hook/);
  assert(shader.uniforms.revealWindow && shader.uniforms.revealDepth && shader.uniforms.revealStrength, 'LocalReveal uniforms missing');
  assert.match(patched.customProgramCacheKey(), /cloth-check-source-v1:chuxian-local-reveal-v1/);

  const camera = new THREE.PerspectiveCamera(45, 4 / 3, .1, 100);
  camera.position.set(0, 0, 12); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
  reveal.update(new THREE.Vector3(0, 0, 0), camera, 800, 600, 1, 16, 0, 2.2, .6);
  assert.equal(reveal.candidates.length, 1);
  const before = reveal.candidates[0].bounds.clone();
  block.position.x = 8;
  model.updateMatrixWorld(true);
  reveal.update(new THREE.Vector3(0, 0, 0), camera, 800, 600, 1, 16, 100, 2.2, .6);
  const after = reveal.candidates[0].bounds;
  assert(after.min.x > before.min.x + 7, 'LocalReveal did not refresh moving-object bounds');
  reveal.destroy();
  return { sourceHook: true, cacheKey: true, movingBounds: true };
}

async function main() {
  const runtime = loadRuntimeModule();
  const bytes = fs.readFileSync(modelPath);
  const geometry = geometryOnlyGlb(bytes);
  const gltf = await parse(new runtime.GLTFLoader(), geometry);
  gltf.scene.updateMatrixWorld(true);
  const ship=gltf.scene.getObjectByName('SV2_Ship');
  ship.scale.setScalar(2);gltf.scene.updateMatrixWorld(true);
  const camera=new runtime.THREE.PerspectiveCamera(38,1440/900,1,24000);
  const walk=new runtime.VoyageDeck(ship);
  const base=ship.localToWorld(walk.position.clone());base.y+=1.65;
  camera.position.copy(base).add(new runtime.THREE.Vector3(0,Math.sin(.24),Math.cos(.24)).multiplyScalar(18));camera.lookAt(base);camera.updateMatrixWorld(true);
  const board=gltf.scene.getObjectByName('SV3_AdventureSurface');assert(board,'real exterior adventure board');
  const projected=runtime.projectLoginSurface({anchor:board,width:board.userData.width,height:board.userData.height},camera,{width:1440,height:900},{width:240,height:64});
  assert(projected,'the actual exterior camera must see the boat-side board from its front');
  const center=new runtime.THREE.Vector3(120,32,0).applyMatrix4(projected.matrix),actual=board.getWorldPosition(new runtime.THREE.Vector3()).project(camera);
  assert(close(center.x,(actual.x+1)*720)&&close(center.y,(1-actual.y)*450),'adventure must sit on the physical board');
  const loginCamera=new runtime.THREE.PerspectiveCamera(40,1440/900,1,24000);
  const paper=gltf.scene.getObjectByName('SV3_LoginSurface'),position=paper.getWorldPosition(new runtime.THREE.Vector3());
  const normal=new runtime.THREE.Vector3(0,0,1).applyNormalMatrix(new runtime.THREE.Matrix3().getNormalMatrix(paper.matrixWorld)).normalize();
  loginCamera.position.copy(position).addScaledVector(normal,17).add(new runtime.THREE.Vector3(0,3,8));loginCamera.lookAt(position.clone().add(new runtime.THREE.Vector3(0,.4,0)));loginCamera.updateMatrixWorld(true);
  const loginProjection=runtime.projectLoginSurface({anchor:paper,width:paper.userData.width,height:paper.userData.height},loginCamera,{width:1440,height:900},{width:430,height:360});
  assert(loginProjection && !runtime.loginSurfaceOccluded(loginCamera,loginProjection.points,[gltf.scene.getObjectByName('SV3_Exterior')]),'settled opening pose reads the exterior login surface without opaque shell obstruction');
  assert(walk.position.y>5.4&&walk.position.y<5.5,'spawn stays on the exterior floor');walk.destroy();
  const cloth = checkSailBindings(runtime, gltf.scene);
  const cityGltf=await parse(new runtime.GLTFLoader(),geometryOnlyGlb(fs.readFileSync(path.join(client,'public-tms273/assets/entry/sky-city.glb'))));
  const cityRoot=cityGltf.scene,city=new runtime.VoyageCity(cityRoot),shells=[];
  cityRoot.traverse(o=>{if(o.userData.tower_adjacent_shell)shells.push(o);});assert.equal(shells.length,2);
  const pairs=shells.map(shell=>{const original=cityRoot.getObjectByName(shell.name.replace('SC_G_AdjacentRockShell_',''));assert(original);assert.equal(shell.parent,city.islandRoot(shell.userData.island_binding));assert.equal(shell.parent,original.parent,'split shell shares the actual original island motion root');return {shell,original,before:shell.getWorldPosition(new runtime.THREE.Vector3()),originalBefore:original.getWorldPosition(new runtime.THREE.Vector3())};});
  city.update(.05,false,1,17);cityRoot.updateWorldMatrix(true,true);
  for(const {shell,original,before,originalBefore}of pairs){const movement=shell.getWorldPosition(new runtime.THREE.Vector3()).sub(before),islandMovement=original.getWorldPosition(new runtime.THREE.Vector3()).sub(originalBefore);assert(movement.length()>.01,'real island drift is exercised');assert(movement.distanceTo(islandMovement)<1e-7,'shell follows original floating island position exactly');}
  const reveal = checkLocalReveal(runtime);
  console.log(JSON.stringify({
    status: 'passed',
    asset: {
      path: path.relative(root, modelPath),
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      geometryOnlyTextureDecode: true,
    },
    cloth,
    localReveal: reveal,
  }, null, 2));
}

main().catch(error => {
  console.error(`FAIL: ${error.stack || error.message || error}`);
  process.exitCode = 1;
});
