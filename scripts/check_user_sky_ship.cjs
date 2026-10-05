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
  if (name === 'production') {
    assert(g.scenes[0].extras?.structural_repair_revision, 'production records the authorized geometry repair');
    assert(meshTriangles > 10000 && meshTriangles < sourceTriangles, 'repair replaces fused high-poly cloth without adding a heavier copy');
    for (const n of parts.filter(n => /Fan_|Vane_|Wheel_|Crystal$|Hull$/.test(n.name))) assert(n.extras.repair_source_scene, `${n.name} retains its original source in the Blender archive`);
  } else assert.equal(meshTriangles, sourceTriangles, `${name} original exported geometry total`);
  const names = g.nodes.map(n => n.name ?? '');
  assert(![...names, ...g.meshes.map(m => m.name ?? '')].some(n => /^SV2_Sail(?:_|$)/.test(n)));
  assert(!names.some(n => /^(?:node_0|.*(?:original|orthographic|top.?view|front.?view|side.?view|three.?view))/i.test(n)));
  if (name === 'production') {
    assert.deepEqual(g.scenes[0].nodes.map(i => g.nodes[i].name).sort(), ['SV2_Ship']);
    for (const n of under(g, 'SV3_Exterior').filter(n => n.mesh !== undefined)) {
      const e=n.extras??{};
      const wheelDepth=n.name.startsWith('SV3_WheelDepth_')&&e.wheel_depth_owned&&/^SV3_Wheel_(Port|Starboard)$/.test(e.wheel_depth_parent);
      const fixedHardware=/^SV3_(Wheel_(Port|Starboard)_(SocketElbow|OutboardBrace|AxleConnector)|BowPlatform_(TipRail|Rail_|Post_))/.test(n.name)&&e.rigid_axle_support&&e.rig_kind;
      const captainFinish=n.name.startsWith('SV3_CaptainFinish_')&&e.structural_role;
      const restoredDoor=n.name==='SV3_CaptainHullDoorRepair'&&e.door_aperture_repair;
      const bowDeck=n.name==='SV3_BowPlatform_Deck'&&e.walk_surface&&e.bow_contract;
      assert(e.source_triangles||e.structural_repair_child||wheelDepth||fixedHardware||captainFinish||restoredDoor||bowDeck, `${n.name} has no source or repair ownership`);
    }
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
  assert(uv.baseColor.has(1), `${name} material UV mappings missing`);
  if (name === 'standalone') assert(uv.normal.has(0), 'the archived rig retains the original normal atlas');
  if (name === 'production') {
    const rigid = g.nodes.filter(n => n.extras?.rigid_wind_pins);
    assert.equal(rigid.length, 18, 'all six fans and twelve rudder patches have separate timber');
    for (const n of rigid) assert(!(g.meshes[n.mesh].extras?.targetNames ?? []).includes('WindPressure'), `${n.name} wood cannot billow`);
    const crystal = g.nodes.find(n => n.name === 'SV3_Crystal');
    assert(crystal.extras.energy_crystal_separate);
    assert(g.nodes.some(n => n.name === 'SV3_EnergyCradle_Timber'));
    const mat = g.materials[g.meshes[crystal.mesh].primitives[0].material];
    assert(mat.extensions?.KHR_materials_transmission?.transmissionFactor > .8, 'energy jewel transmits light');
  }
  assert(g.buffers.every(b => !b.uri || b.uri.startsWith('data:')));
  for (const image of g.images ?? []) image.uri
    ? assert(image.uri.startsWith('data:'), `${name} has external image`)
    : assert(g.bufferViews[image.bufferView], `${name} image is not embedded`);
  const exteriorTriangles = under(g, 'SV3_Exterior').filter(n => n.mesh !== undefined).reduce((sum, n) => sum + triangles(g, n), 0);
  return { parts: parts.length, sourceTriangles, meshTriangles, exteriorTriangles, counts, morphs: { fold, wind },
    uv: { attributes: ['TEXCOORD_0', 'TEXCOORD_1'], baseColor: [...uv.baseColor], normal: [...uv.normal] },
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
assert.equal(board.filter(n => /^SV3_Board_Mount_-?2\.9$/.test(n.name)).length, 2, 'retained noticeboard has two original mounting posts');
assert.equal(board.filter(n => n.name.startsWith('SV3_Board_MountBand_')).length, 4, 'four mounting bands attach the retained board');
const boardRoot = g.nodes.find(n => n.name === 'SV2_LoginSign');
assert(Math.abs(boardRoot.translation[0] - 10.3) < 1e-5 && Math.abs(boardRoot.translation[2]) < 1e-5, 'noticeboard stays at the side amidships');
if (board.some(n=>n.name==='SV3_LoginRedesign_Root')) {
  const loginRoot = board.find(n => n.name === 'SV3_LoginRedesign_Root');
  const loginDescendants = under(g, 'SV3_LoginRedesign_Root');
  const loginByName = new Map(loginDescendants.map(n => [n.name, n]));
  const childNodes = node => (node.children ?? []).map(index => {
    assert(g.nodes[index], `${node.name} has an invalid child index`);
    return g.nodes[index];
  });
  const parseExtraJson = (node, key, expectedType) => {
    const raw = node.extras?.[key];
    assert.equal(typeof raw, 'string', `${node.name} must record ${key}`);
    let value;
    try { value = JSON.parse(raw); } catch (error) { assert.fail(`${node.name} ${key} is not JSON: ${error.message}`); }
    if (expectedType === 'array') assert(Array.isArray(value), `${node.name} ${key} must be an array`);
    return value;
  };

  // The recipe must prove that it rebuilt from unchanged source sign meshes
  // and that no generated relief enters the DOM projection keepout.
  assert.equal(typeof loginRoot.extras?.source_fingerprint_before, 'string', 'login recipe missing source fingerprint before');
  assert.equal(typeof loginRoot.extras?.source_fingerprint_after, 'string', 'login recipe missing source fingerprint after');
  assert.equal(loginRoot.extras.source_fingerprint_before, loginRoot.extras.source_fingerprint_after, 'login source fingerprint changed during recipe');
  assert.deepEqual(parseExtraJson(loginRoot, 'surface_keepout_violations', 'array'), [], 'login decoration crosses the DOM keepout');

  // Every object explicitly recorded by the recipe must survive the GLB
  // hierarchy. This catches silent exporter drops without relying on a fixed
  // mesh count as the design evolves.
  const generatedNames = parseExtraJson(loginRoot, 'generated_objects', 'array');
  assert.equal(loginRoot.extras.generated_object_count, generatedNames.length + 1, 'login generated object audit count is stale');
  const generatedSet = new Set(generatedNames);
  assert.equal(generatedSet.size, generatedNames.length, 'login generated object audit contains duplicates');
  for (const name of generatedNames) {
    const node = loginByName.get(name);
    assert(node, `login generated object ${name} was dropped from the GLB`);
    const isLampRoot = /^SV3_LoginRedesign_Lantern_[LR]_Root$/.test(name);
    if (isLampRoot) assert.equal(node.mesh, undefined, `${name} lamp root should remain an Empty`);
    else {
      assert(Number.isInteger(node.mesh), `${name} generated decoration has no exported mesh`);
      assert(g.meshes[node.mesh], `${name} points at a missing exported mesh`);
      for (const primitive of g.meshes[node.mesh].primitives) {
        assert(Number.isInteger(primitive.material) && g.materials[primitive.material], `${name} has an invalid exported material`);
      }
    }
  }

  // The selection-cabin lantern is the source of truth for both login lamps:
  // each root has exactly the authored Empty+12-child shape and each child
  // retains the source naming/material contract.
  assert.equal(loginRoot.extras?.login_lamp_source_root, 'SV3_CabinLamp_0', 'login root lost lamp source name');
  assert.equal(loginRoot.extras?.login_lamp_child_count, 12, 'login root lost lamp child count');
  assert.equal(loginRoot.extras?.login_lamp_shared_mesh_material, true, 'login root lost shared lamp provenance');
  const lampMounts = JSON.parse(loginRoot.extras.login_lamp_mounts_local);
  assert.deepEqual(lampMounts, { left: [-3.91, -0.30, 6.15], right: [3.91, -0.30, 6.15] });
  const expectedLampChildren = ['Base', 'Cage_0', 'Cage_1', 'Cage_2', 'Cage_3', 'Cage_4', 'Cage_5', 'Crown', 'Finial', 'Glass', 'HangingLoop', 'Stem'];
  const lampMeshes = new Map();
  assert.equal(loginDescendants.filter(n => /^SV3_LoginRedesign_Lantern_[LR]_Root$/.test(n.name)).length, 2, 'login must export exactly two refined lamp roots');
  for (const side of ['L', 'R']) {
    const lamp = loginByName.get(`SV3_LoginRedesign_Lantern_${side}_Root`);
    assert(lamp, `login ${side} refined lamp root missing`);
    assert((loginRoot.children ?? []).includes(g.nodes.indexOf(lamp)), `${lamp.name} is not mounted under the login redesign root`);
    assert.equal(lamp.extras?.SV3_LoginRedesign_source_lamp, 'SV3_CabinLamp_0', `${lamp.name} lost source lamp name`);
    assert.equal(lamp.extras?.SV3_LoginRedesign_source_lamp_clone, true, `${lamp.name} is not marked as a source clone`);
    assert.equal(lamp.extras?.SV3_LoginRedesign_shared_mesh_material, true, `${lamp.name} lost shared mesh/material provenance`);
    assert.equal(lamp.extras?.SV3_LoginRedesign_child_count, 12, `${lamp.name} source child count changed`);
    assert.equal(lamp.extras?.SV3_LoginRedesign_mount_local, 'x=±3.91, y=-0.30, z=6.15', `${lamp.name} mount metadata changed`);
    const children = childNodes(lamp);
    assert.equal(children.length, 12, `${lamp.name} must export exactly 12 children`);
    assert.deepEqual(children.map(n => n.name.replace(`SV3_LoginRedesign_Lantern_${side}_`, '')).sort(), [...expectedLampChildren].sort(), `${lamp.name} child shape changed`);
    for (const child of children) {
      assert(Number.isInteger(child.mesh), `${child.name} lamp child has no mesh`);
      const expectedMaterial = child.name.endsWith('_Glass') ? 'SV3_CabinLampGlass' : 'SV3_Finish_Brass';
      const materials = new Set(g.meshes[child.mesh].primitives.map(p => g.materials[p.material]?.name));
      assert.deepEqual([...materials], [expectedMaterial], `${child.name} lost source lamp material ${expectedMaterial}`);
      const suffix = child.name.replace(`SV3_LoginRedesign_Lantern_${side}_`, '');
      if (side === 'L') lampMeshes.set(suffix, child.mesh);
      else assert.equal(child.mesh, lampMeshes.get(suffix), `${child.name} no longer shares the source mesh with the left lamp`);
    }
  }

  // The crest must sample the original transparent sail image through the
  // actual exported UV channel, rather than merely carrying a material name.
  const crest = loginByName.get('SV3_LoginRedesign_MapleLeafCrest');
  assert(crest, 'login maple crest mesh missing');
  assert.equal(crest.extras?.SV3_LoginRedesign_uv_role, 'Emblem', 'login crest lost Emblem UV provenance');
  assert.equal(crest.extras?.SV3_LoginRedesign_maple_material, 'SV3_MainSail_MapleDecal', 'login crest lost sail decal material provenance');
  assert.equal(crest.extras?.SV3_LoginRedesign_maple_image, 'maple-crest.png', 'login crest lost original image provenance');
  assert.equal(loginRoot.extras?.maple_decal_material, 'SV3_MainSail_MapleDecal', 'login root lost sail decal material provenance');
  assert.equal(loginRoot.extras?.maple_decal_image, 'maple-crest.png', 'login root lost original maple image provenance');
  assert.equal(loginRoot.extras?.maple_decal_uv_map, 'Emblem', 'login root lost Emblem UV provenance');
  assert(Number.isInteger(crest.mesh), 'login maple crest has no exported mesh');
  assert.equal(g.meshes[crest.mesh].primitives.length, 1, 'login maple crest must be one decal primitive');
  assert.equal(triangles(g, crest), 2, 'login maple crest must remain a single quad');
  for (const primitive of g.meshes[crest.mesh].primitives) {
    const material = g.materials[primitive.material];
    assert.equal(material?.name, 'SV3_MainSail_MapleDecal', 'login crest has a non-sail material overlay');
    assert.equal(material.alphaMode, 'BLEND', 'login crest sail decal lost transparent alpha mode');
    const textureInfo = material.pbrMetallicRoughness?.baseColorTexture;
    assert(textureInfo && g.textures[textureInfo.index], 'login crest sail material has no base-color texture');
    const image = g.images[g.textures[textureInfo.index].source];
    // Blender's GLB exporter removes the .png suffix from embedded image
    // names, while the source datablock and recipe extras retain it.
    assert(['maple-crest', 'maple-crest.png'].includes(image?.name), 'login crest does not sample the original maple image');
    const channel = textureInfo.extensions?.KHR_texture_transform?.texCoord ?? textureInfo.texCoord ?? 0;
    const uvAccessorIndex = primitive.attributes[`TEXCOORD_${channel}`];
    assert(Number.isInteger(uvAccessorIndex), `login crest sail texture channel TEXCOORD_${channel} is missing`);
    const uvAccessor = g.accessors[uvAccessorIndex];
    assert(uvAccessor && uvAccessor.type === 'VEC2', `login crest TEXCOORD_${channel} is not a VEC2 accessor`);
    const componentBytes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[uvAccessor.componentType];
    const componentReaders = { 5120: 'readInt8', 5121: 'readUInt8', 5122: 'readInt16LE', 5123: 'readUInt16LE', 5125: 'readUInt32LE', 5126: 'readFloatLE' };
    assert(componentBytes && componentReaders[uvAccessor.componentType], `login crest TEXCOORD_${channel} has unsupported component type`);
    const uvView = g.bufferViews[uvAccessor.bufferView];
    assert(uvView, `login crest TEXCOORD_${channel} has no buffer view`);
    const uvStride = uvView.byteStride ?? componentBytes * 2;
    const uvRead = (index, component) => {
      assert(index >= 0 && index < uvAccessor.count, `login crest TEXCOORD_${channel} sample index out of range`);
      const offset = (uvView.byteOffset ?? 0) + (uvAccessor.byteOffset ?? 0) + index * uvStride + component * componentBytes;
      assert(offset >= 0 && offset + componentBytes <= production.binary.length, `login crest TEXCOORD_${channel} sample exceeds GLB buffer`);
      return production.binary[componentReaders[uvAccessor.componentType]](offset);
    };
    const uvMin = [Infinity, Infinity], uvMax = [-Infinity, -Infinity], uvCorners = new Set();
    for (let index = 0; index < uvAccessor.count; index++) {
      const uv = [uvRead(index, 0), uvRead(index, 1)];
      assert(uv.every(Number.isFinite), `login crest TEXCOORD_${channel} contains a non-finite sample`);
      for (let component = 0; component < 2; component++) {
        uvMin[component] = Math.min(uvMin[component], uv[component]);
        uvMax[component] = Math.max(uvMax[component], uv[component]);
        assert(uv[component] >= -1e-5 && uv[component] <= 1 + 1e-5, `login crest TEXCOORD_${channel} is not normalized Emblem UV`);
      }
      const cornerU = Math.abs(uv[0]) <= 1e-5 ? 0 : Math.abs(uv[0] - 1) <= 1e-5 ? 1 : undefined;
      const cornerV = Math.abs(uv[1]) <= 1e-5 ? 0 : Math.abs(uv[1] - 1) <= 1e-5 ? 1 : undefined;
      if (cornerU !== undefined && cornerV !== undefined) uvCorners.add(`${cornerU},${cornerV}`);
    }
    assert.deepEqual(uvMin.map(value => Math.round(value)), [0, 0], `login crest TEXCOORD_${channel} lower bound is not [0,0]`);
    assert.deepEqual(uvMax.map(value => Math.round(value)), [1, 1], `login crest TEXCOORD_${channel} upper bound is not [1,1]`);
    assert.deepEqual([...uvCorners].sort(), ['0,0', '0,1', '1,0', '1,1'], `login crest TEXCOORD_${channel} does not contain all four Emblem corners`);
  }
  assert(!board.some(n => /SV3_LoginRedesign_MapleLeafCrest_(?:Stem|Veins(?:_R)?)/.test(n.name)), 'login crest retains obsolete geometric leaf overlays');
} else assert.equal(board.filter(n => /^SV3_Board_Strap_.*_6\.94$/.test(n.name)).length, 2, 'two retained upper straps hold the spatial login board');
const read = (index, vertex, component = 0) => {
  const a = g.accessors[index], v = g.bufferViews[a.bufferView], size = {5123: 2, 5125: 4, 5126: 4}[a.componentType];
  const offset = (v.byteOffset ?? 0) + (a.byteOffset ?? 0) + vertex * (v.byteStride ?? size * ({VEC2: 2, VEC3: 3}[a.type] ?? 1)) + component * size;
  return production.binary[{5123: 'readUInt16LE', 5125: 'readUInt32LE', 5126: 'readFloatLE'}[a.componentType]](offset);
};
let mappedTriangles = 0;
for (const node of under(g, 'SV3_Exterior').filter(n => n.mesh !== undefined)) for (const p of g.meshes[node.mesh].primitives) {
  // The three decal gores include physical seam edges whose UV collapses to
  // the shared image border. Their cloth-grid/shared-emblem contracts are
  // checked by check_voyage_cloth and check_sky_voyage_assets.
  if (node.name.startsWith('SV3_MainSail_Crest_')) continue;
  const material = g.materials[p.material];
  const color = material.pbrMetallicRoughness?.baseColorTexture;
  const normal = material.normalTexture;
  const texture = color ?? normal;
  if (!texture) continue;
  const channel = texture.extensions?.KHR_texture_transform?.texCoord ?? texture.texCoord ?? 0;
  const uvAccessor = p.attributes[`TEXCOORD_${channel}`];
  assert(Number.isInteger(uvAccessor), `${node.name} has no UV for its actual material texture`);
  for (let i = 0; i < g.accessors[p.indices].count; i += 3) {
    const indices = [0, 1, 2].map(j => read(p.indices, i + j));
    const edges = [1, 2].map(j => [0, 1, 2].map(c => read(p.attributes.POSITION, indices[j], c) - read(p.attributes.POSITION, indices[0], c)));
    const [a, b] = edges, area = Math.hypot(a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]);
    if (area < 1e-4) continue;
    const uv = [1, 2].map(j => [0, 1].map(c => read(uvAccessor, indices[j], c) - read(uvAccessor, indices[0], c)));
    // The retained component finish uses metre-scale material UV; inspect the
    // channel actually sampled by that texture, including source bed/board UV0.
    const density = Math.abs(uv[0][0]*uv[1][1]-uv[0][1]*uv[1][0]) / area;
    assert(density > (node.name === 'SV3_Hull' ? .003 : 1e-7), `${node.name} has stretched/degenerate material UV`);
    mappedTriangles++;
  }
}
summary.boardAndMaterialProjection = { parts: board.length, mappedTriangles };
for (const mat of g.materials.filter(m => m.extras?.wood_bump_from_basecolor)) {
  const factor = mat.pbrMetallicRoughness.baseColorFactor;
  assert(factor && factor[0] > factor[1] && factor[1] > factor[2] && factor[0] <= 1, `${mat.name} lost its authored walnut tint during export`);
  const authored = mat.extras.export_base_color_multiplier;
  assert(authored && authored.every((value, i) => Math.abs(value - factor[i]) < 1e-6), `${mat.name} exported tint differs from the native shader`);
}
const hullMaterials = new Set(g.meshes[g.nodes.find(n => n.name === 'SV3_Hull').mesh].primitives.map(p => g.materials[p.material].extras?.voyage_material_semantic));
for (const semantic of ['HullIvory', 'DeckTeak', 'SparWood']) assert(hullMaterials.has(semantic), `retained hull preserves independent ${semantic} region`);
for (let i = 1; i <= 4; i++) assert.equal(names.filter(n => n === `SV2_CabinFrontWindow_0${i}`).length, 1);
for (const name of ['warrior', 'mage', 'archer', 'rogue']) {
  const glass = g.nodes.find(n => n.name === `SV3_StainedGlass_${name}`);
  assert(glass?.extras?.stained_glass_class === name, `${name} has an actual glass mesh`);
  const mat = g.materials[g.meshes[glass.mesh].primitives[0].material];
  for (const texture of [mat.emissiveTexture, mat.pbrMetallicRoughness.baseColorTexture])
    assert.equal(g.images[g.textures[texture.index].source].name, `stained-glass-${name}`, 'glass color and emission retain the generated painting');
  assert(g.nodes.some(n => n.name === `SV3_PointArchFrame_${name}`), `${name} has a physical pointed-arch frame`);
}
for (let i = 0; i < 12; i++) for (const anchor of ['FootAnchor', 'SleepAnchor']) assert(names.includes(`SV2_Bed_${i}_${anchor}`));
assert(!names.some(name => /^(SV2_City|SV2_C2_|SC_)/.test(name)), 'ship cannot embed the separate city map');
summary.preserved = { windows: 4, beds: 12, bedAnchors: 24, independentShip: true };
const files = ['resources/scenes/sky-voyage-v3/models/sky-voyage.blend', 'resources/scenes/sky-voyage-v3/models/user-ship-import.blend',
  'resources/scenes/sky-voyage-v3/models/ship-parts.obj', 'resources/scenes/sky-voyage-v3/models/ship-parts.mtl', sourcePath];
for (const file of files) assert(fs.statSync(path.join(root, file)).size > 0, `${file} is empty`);
summary.sourcesNonzero = true;
const output = path.join(root, 'evidence/2026-10-02/sky-voyage-v3/assets.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(summary, null, 2));
