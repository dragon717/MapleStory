#!/usr/bin/env node
'use strict';

const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), models = path.join(root, 'resources/scenes/sky-voyage-v3/models');

function readGlb(name) {
  const bytes = fs.readFileSync(path.join(models, name));
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF'); assert.equal(bytes.readUInt32LE(4), 2);
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  let json, binary;
  for (let at = 12; at < bytes.length;) {
    const size = bytes.readUInt32LE(at), type = bytes.readUInt32LE(at + 4), start = at + 8;
    assert(start + size <= bytes.length, `${name} truncated chunk`);
    if (type === 0x4e4f534a) json = JSON.parse(bytes.toString('utf8', start, start + size));
    if (type === 0x004e4942) binary = bytes.subarray(start, start + size);
    at = start + size;
  }
  assert(json && binary, `${name} missing GLB chunks`);
  return { json, binary, bytes: bytes.length };
}
function triangles(g, node) {
  return g.meshes[node.mesh].primitives.reduce((sum, p) => {
    assert.equal(p.mode ?? 4, 4, `${node.name} is not triangle geometry`);
    const count = g.accessors[p.indices ?? p.attributes.POSITION]?.count;
    assert(Number.isInteger(count) && count % 3 === 0, `${node.name} invalid triangle accessor`);
    return sum + count / 3;
  }, 0);
}
function under(g, name) {
  const rootIndex = g.nodes.findIndex(n => n.name === name);
  assert(rootIndex >= 0 && g.nodes.filter(n => n.name === name).length === 1, `expected one ${name}`);
  const result = [], seen = new Set(), pending = [rootIndex];
  while (pending.length) {
    const i = pending.pop();
    assert(g.nodes[i] && !seen.has(i), `${name} has invalid hierarchy`);
    seen.add(i); result.push(g.nodes[i]); pending.push(...(g.nodes[i].children ?? []));
  }
  return result;
}
function validate(name, asset, expectedParts) {
  const g = asset.json;
  assert.equal(g.scenes.length, 1, `${name} must contain one target scene`);
  assert.equal(g.scenes[0].name, 'SV3_ProductionRig');
  const parts = g.nodes.filter(n => Number.isInteger(n.extras?.source_triangles));
  assert.deepEqual(parts.map(n => n.name).sort(), expectedParts.map(n => `SV3_${n}`).sort());
  for (const n of parts) assert.equal(n.extras.source_triangles, source.parts[n.name.slice(4)].triangles);
  const sourceTriangles = parts.reduce((s, n) => s + n.extras.source_triangles, 0);
  const meshTriangles = parts.reduce((s, n) => s + triangles(g, n), 0);
  assert.equal(sourceTriangles, 285840, `${name} source_triangles total`);
  assert.equal(meshTriangles, sourceTriangles, `${name} exported geometry total`);
  const names = g.nodes.map(n => n.name ?? '');
  assert(![...names, ...g.meshes.map(m => m.name ?? '')].some(n => /^SV2_Sail(?:_|$)/.test(n)));
  assert(!names.some(n => /^(?:node_0|.*(?:original|orthographic|top.?view|front.?view|side.?view|three.?view))/i.test(n)));
  if (name === 'production') {
    assert.deepEqual(g.scenes[0].nodes.map(i => g.nodes[i].name).sort(), ['SV2_City', 'SV2_Ship']);
    assert.deepEqual(under(g, 'SV3_Exterior').filter(n => n.mesh !== undefined).map(n => n.name).sort(),
      expectedParts.map(n => `SV3_${n}`).sort());
  } else {
    assert.equal(g.meshes.length, 18, 'standalone rig has extra meshes');
    assert.deepEqual(g.scenes[0].nodes.map(i => g.nodes[i].name), ['SV3_Exterior']);
    assert.deepEqual(g.nodes.filter(n => n.mesh !== undefined).map(n => n.name).sort(),
      expectedParts.map(n => `SV3_${n}`).sort());
  }

  const counts = Object.fromEntries([['fans', /^SV3_(?:Aft|Main)Fan_[0-2]$/],
    ['rudders', /^SV3_(?:Aft|Bow)Vane_(?:Port|Starboard)$/], ['wheels', /^SV3_Wheel_(?:Port|Starboard)$/],
    ['nozzles', /^SV3_Nozzle_(?:Port|Starboard)$/]].map(([k, re]) => [k, names.filter(n => re.test(n)).length]));
  assert.deepEqual(counts, { fans: 6, rudders: 4, wheels: 2, nozzles: 2 });
  const steering = g.nodes.filter(n => n.extras?.rig_kind === 'steering');
  assert.deepEqual(steering.map(n => n.name).sort(), ['SV3_Wheel_Port_Steering', 'SV3_Wheel_Starboard_Steering']);
  for (const n of steering) {
    const side = n.name.includes('_Port_') ? 'Port' : 'Starboard';
    assert.equal(n.mesh, undefined); assert.deepEqual((n.children ?? []).map(i => g.nodes[i].name), [`SV3_Wheel_${side}`]);
  }

  let fold = 0, wind = 0;
  const uv = { mesh: [0, 1], baseColor: new Set(), normal: new Set() };
  for (const n of parts) {
    const mesh = g.meshes[n.mesh], targetNames = mesh.extras?.targetNames ?? [];
    for (const [field, tally] of [['fold_morph', 'fold'], ['wind_morph', 'wind']]) {
      const targetName = n.extras[field];
      if (!targetName) continue;
      const index = targetNames.indexOf(targetName);
      assert(index >= 0, `${n.name} ${field} missing from targetNames`);
      for (const p of mesh.primitives) {
        assert(p.targets?.[index] && Object.values(p.targets[index]).length && Object.values(p.targets[index]).every(i => g.accessors[i]),
          `${n.name} ${targetName} has no morph data`);
      }
      assert(mesh.primitives.some(p => {
        const accessor = g.accessors[p.targets[index].POSITION];
        return accessor && [...(accessor.min ?? []), ...(accessor.max ?? [])]
          .some(v => Number.isFinite(v) && Math.abs(v) > 1e-4);
      }), `${n.name} ${targetName} has no POSITION displacement`);
      if (tally === 'fold') fold++; else wind++;
    }
    for (const p of mesh.primitives) {
      for (const set of uv.mesh) assert(Number.isInteger(p.attributes[`TEXCOORD_${set}`]));
      const material = g.materials[p.material];
      assert(material, `${n.name} missing material`);
      for (const [info, used] of [[material.pbrMetallicRoughness?.baseColorTexture, uv.baseColor], [material.normalTexture, uv.normal]]) {
        if (!info) continue;
        assert(g.textures[info.index], `${n.name} material has invalid texture`);
        const set = info.extensions?.KHR_texture_transform?.texCoord ?? info.texCoord ?? 0;
        assert(Number.isInteger(p.attributes[`TEXCOORD_${set}`]), `${n.name} texture UV${set} missing`);
        used.add(set);
      }
    }
  }
  assert(fold && wind, `${name} missing fold/wind morphs`);
  assert(uv.baseColor.has(1) && uv.normal.has(0), `${name} material UV mappings missing`);
  assert(g.buffers.every(b => !b.uri || b.uri.startsWith('data:')));
  for (const image of g.images ?? []) image.uri
    ? assert(image.uri.startsWith('data:'), `${name} has external image`)
    : assert(g.bufferViews[image.bufferView], `${name} image is not embedded`);
  return { parts: parts.length, triangles: sourceTriangles, counts, morphs: { fold, wind },
    uv: { attributes: ['TEXCOORD_0', 'TEXCOORD_1'], baseColor: [1], normal: [0] },
    embeddedImages: g.images?.length ?? 0 };
}
const sourcePath = 'resources/scenes/sky-voyage-v3/rig-source.json';
const source = JSON.parse(fs.readFileSync(path.join(root, sourcePath), 'utf8'));
assert.equal(source.mainTriangles, 285840);
assert.equal(source.sourceTriangles, 500356);
assert.equal(source.excludedTriangles, 214516);
const expected = Object.keys(source.parts);
const production = readGlb('sky-voyage.glb');
const rig = readGlb('user-ship-rig.glb');
const summary = {
  status: 'passed',
  production: validate('production', production, expected),
  standaloneRig: validate('standalone', rig, expected),
};
const g = production.json, names = g.nodes.map(n => n.name);
const board = under(g, 'SV2_LoginSign');
const surface = board.find(n => n.name === 'SV3_LoginSurface');
assert.deepEqual([surface?.extras.width, surface?.extras.height], [6.65, 5.42]);
assert(!surface.rotation || Math.abs(surface.rotation[0]) < 1e-5, 'paper input plane must face glTF +Z');
assert.equal(board.filter(n => n.name.startsWith('SV3_Board_Post')).length, 2);
assert.equal(board.filter(n => n.name.startsWith('SV3_Board_PaperClip')).length, 2);
const read = (index, vertex, component = 0) => {
  const a = g.accessors[index], v = g.bufferViews[a.bufferView], size = {5123: 2, 5125: 4, 5126: 4}[a.componentType];
  const offset = (v.byteOffset ?? 0) + (a.byteOffset ?? 0) + vertex * (v.byteStride ?? size * ({VEC2: 2, VEC3: 3}[a.type] ?? 1)) + component * size;
  return production.binary[{5123: 'readUInt16LE', 5125: 'readUInt32LE', 5126: 'readFloatLE'}[a.componentType]](offset);
};
let mappedTriangles = 0;
for (const node of g.nodes.filter(n => n.extras?.source_triangles)) for (const p of g.meshes[node.mesh].primitives) {
  for (let i = 0; i < g.accessors[p.indices].count; i += 3) {
    const indices = [0, 1, 2].map(j => read(p.indices, i + j));
    const edges = [1, 2].map(j => [0, 1, 2].map(c => read(p.attributes.POSITION, indices[j], c) - read(p.attributes.POSITION, indices[0], c)));
    const [a, b] = edges, area = Math.hypot(a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]);
    if (area < 1e-4) continue;
    const uv = [1, 2].map(j => [0, 1].map(c => read(p.attributes.TEXCOORD_1, indices[j], c) - read(p.attributes.TEXCOORD_1, indices[0], c)));
    assert(Math.abs(uv[0][0]*uv[1][1]-uv[0][1]*uv[1][0]) / area > .04, `${node.name} has stretched/degenerate material UV`);
    mappedTriangles++;
  }
}
summary.boardAndMaterialProjection = { parts: board.length, mappedTriangles };
for (let i = 1; i <= 4; i++) assert.equal(names.filter(n => n === `SV2_CabinFrontWindow_0${i}`).length, 1);
for (let i = 0; i < 4; i++) for (const anchor of ['FootAnchor', 'SleepAnchor']) assert(names.includes(`SV2_Bed_${i}_${anchor}`));
const city = g.nodes.find(n => n.name === 'SV2_City');
const water = typeof city?.extras?.waterBodies === 'string' ? JSON.parse(city.extras.waterBodies) : city?.extras?.waterBodies;
assert.deepEqual(Object.fromEntries(['pool', 'river', 'fall'].map(k => [k, water.filter(x => x.kind === k).length])), { pool: 4, river: 2, fall: 8 });
summary.preserved = { windows: 4, beds: 4, bedAnchors: 8, cityWaterBodies: { pools: 4, rivers: 2, falls: 8 } };
const files = ['resources/scenes/sky-voyage-v3/models/sky-voyage.blend', 'resources/scenes/sky-voyage-v3/models/user-ship-import.blend',
  'resources/scenes/sky-voyage-v3/models/ship-parts.obj', 'resources/scenes/sky-voyage-v3/models/ship-parts.mtl', sourcePath];
for (const file of files) assert(fs.statSync(path.join(root, file)).size > 0, `${file} is empty`);
summary.sourcesNonzero = true;
const output = path.join(root, 'evidence/2026-10-02/sky-voyage-v3/assets.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(summary, null, 2));
