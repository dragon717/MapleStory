const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function readGlb(file) {
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.readUInt32LE(0), 0x46546c67); assert.equal(bytes.readUInt32LE(4), 2); assert.equal(bytes.readUInt32LE(8), bytes.length);
  const jsonLength = bytes.readUInt32LE(12), binaryHeader = 20 + jsonLength;
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a);
  assert.equal(bytes.readUInt32LE(binaryHeader + 4), 0x004e4942, 'GLB must include its binary chunk');
  const binaryLength = bytes.readUInt32LE(binaryHeader);
  assert.equal(binaryHeader + 8 + binaryLength, bytes.length, 'unexpected GLB chunks');
  return { bytes, gltf: JSON.parse(bytes.toString('utf8', 20, binaryHeader)), binaryOffset: binaryHeader + 8, binaryLength };
}
function assertFinite(value, label) {
  if (typeof value === 'number') assert(Number.isFinite(value), `${label} contains a non-finite coordinate`);
  else if (Array.isArray(value)) value.forEach((item, index) => assertFinite(item, `${label}[${index}]`));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) assertFinite(item, `${label}.${key}`);
}
function assertFinitePositions(glb) {
  const accessors = new Set(glb.gltf.meshes.flatMap(mesh => mesh.primitives.map(primitive => primitive.attributes.POSITION)));
  let vertices = 0;
  for (const index of accessors) {
    const accessor = glb.gltf.accessors[index];
    assert.equal(accessor.type, 'VEC3'); assert.equal(accessor.componentType, 5126);
    assert(!accessor.sparse, `position accessor ${index} must be directly readable`);
    const view = glb.gltf.bufferViews[accessor.bufferView], stride = view.byteStride ?? 12;
    assert.equal(view.buffer, 0); assert(stride >= 12);
    const start = glb.binaryOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    assert(start + (accessor.count - 1) * stride + 12 <= glb.binaryOffset + glb.binaryLength, `position accessor ${index} exceeds GLB binary data`);
    for (let vertex = 0; vertex < accessor.count; vertex++) for (let axis = 0; axis < 3; axis++) {
      assert(Number.isFinite(glb.bytes.readFloatLE(start + vertex * stride + axis * 4)), `position accessor ${index} has a non-finite coordinate`);
    }
    vertices += accessor.count;
  }
  return vertices;
}
function checkSkyCity(publicDirectory) {
  const source = path.join(root, 'resources/scenes/sky-voyage-v3/prototypes/sky-city-spatial-prototype.glb');
  const glb = readGlb(source), { gltf } = glb;
  assert.equal(gltf.scenes.length, 1);
  const scene = gltf.scenes[0], extras = scene.extras ?? {};
  const embeddedLayout = JSON.parse(extras.spatial_layout);
  const layout = JSON.parse(fs.readFileSync(path.join(root, 'resources/scenes/sky-voyage-v3/prototypes/sky-city-spatial-layout.json'), 'utf8'));
  assert.deepEqual(embeddedLayout, layout, 'GLB layout metadata differs from its source layout');
  assert(fs.existsSync(path.resolve(root, layout.provenance)), 'spatial layout provenance source is missing');
  assert(layout.nodes.length >= 177);assert(layout.fourWayJunctions); assert.equal(layout.landings.length, 177);
  assert(layout.edges.length >= 201); assert.equal(layout.mapAssignments.length, 287);
  assert.equal(layout.physicalLinks.filter(link => link.surface === 'suspension').length, 41);
  assert.equal(layout.physicalLinks.filter(link => link.surface === 'rainbow').length, 1);
  const islands = gltf.nodes.filter(node => node.name?.endsWith('_Island') && node.extras?.island_id);
  assert.equal(islands.length, 35); assert.equal(new Set(islands.map(node => node.extras.island_id)).size, 35);
  const edgeNodes = gltf.nodes.filter(node => Boolean(node.extras?.edge_id));
  assert.equal(edgeNodes.length, layout.edges.length);
  assert.deepEqual(new Set(edgeNodes.map(node => node.extras?.edge_id)), new Set(layout.edges.map(edge => edge.id)));
  assert.deepEqual(new Set(layout.edges.map(edge => edge.carrier)), new Set([
    'land-or-fragment-islands', 'suspension-cables', 'rainbow-energy-bridge', 'building-floor', 'existing-courtyard-landing'
  ]));
  const roadCheck = JSON.parse(extras.road_carrier_check);
  const terrainCheck = JSON.parse(extras.terrain_clearance_check);
  assert.equal(roadCheck.unsupported, 0); assert.equal(roadCheck.fragments, 840); assert.equal(roadCheck.fragment_meshes, 41);
  assert.equal(gltf.nodes.filter(node => node.mesh !== undefined && node.extras?.carrier === 'fragment-island-chain').length, 41);
  assert.equal(terrainCheck.conflicts, 0);
  assertFinite(layout, 'spatial_layout');
  for (const [index, node] of gltf.nodes.entries()) assertFinite({ translation: node.translation, rotation: node.rotation, scale: node.scale, matrix: node.matrix }, `nodes[${index}]`);
  const positionVertices = assertFinitePositions(glb);
  const candidate = path.join(publicDirectory, 'assets/entry/sky-city.glb');
  const cityAssemblyMatch = fs.existsSync(candidate)
    ? (assert(fs.readFileSync(candidate).equals(glb.bytes), 'assembled sky-city.glb differs from its saved source'), 'byte-identical')
    : 'not-present';
  return { mainIslands: islands.length, routePoints: layout.nodes.length, edges: layout.edges.length,
    identities: layout.mapAssignments.length, suspensionConnections: 41, rainbowConnections: 1,
    fragmentMeshes: roadCheck.fragment_meshes, fragments: roadCheck.fragments, positionVertices,
    sourceChecks: 'passed', assembly: cityAssemblyMatch };
}
function validate(assembly = root, publicDirectory = path.join(assembly, 'client/public-tms273')) {
  const directory = path.join(publicDirectory, 'assets/entry');
  const bytes = fs.readFileSync(path.join(directory, 'sky-voyage.glb'));
  assert.equal(bytes.readUInt32LE(0), 0x46546c67); assert.equal(bytes.readUInt32LE(4), 2); assert.equal(bytes.readUInt32LE(8), bytes.length);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a);
  const gltf = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)));
  const names = gltf.nodes.map(node => node.name);
  assert.equal(gltf.scenes.length, 1, 'export must contain only the current voyage scene');
  assert(!names.some(name => /^(CE_|HR_)/.test(name)), 'other authoring scenes must stay out of voyage export');
  for (const name of ['SV2_Ship', 'SV2_City', 'SV2_CabinRoof', 'SV2_CabinBackWall', 'SV2_CabinBackTrim',
    ...Array.from({ length: 4 }, (_, i) => `SV2_CabinFrontWindow_0${i + 1}`),
    ...Array.from({ length: 4 }, (_, i) => `SV2_Bed_${i}_FootAnchor`),
    ...Array.from({ length: 4 }, (_, i) => `SV2_Bed_${i}_SleepAnchor`)]) {
    assert.equal(names.filter(value => value === name).length, 1, `missing or ambiguous ${name}`);
  }
  assert(!names.some(name => name?.startsWith('SV2_CabinFrontWindowGlass_')), 'window apertures must remain open');
  assert(gltf.meshes.length > 30, 'scene must contain real editable hull/castle/island geometry');
  assert(gltf.materials.length > 5); assert(gltf.buffers.every(buffer => !buffer.uri), 'GLB must be self contained');
  assert((gltf.images ?? []).every(image => !image.uri || image.uri.startsWith('data:')), 'no external texture dependency');
  const city = gltf.nodes.find(node => node.name === 'SV2_City');
  const waterBodies = JSON.parse(city.extras.waterBodies);
  assert.equal(waterBodies.filter(body => body.kind === 'pool').length, 4);
  assert.equal(waterBodies.filter(body => body.kind === 'river').length, 2);
  assert.equal(waterBodies.filter(body => body.kind === 'fall').length, 8);
  assert(gltf.nodes.filter(node => node.name?.startsWith('SV2_C2_') && node.mesh !== undefined).length > 30, 'city geometry was excluded from export');
  assert(!gltf.nodes.some(node => node.mesh !== undefined && /WaterSurface|WaterfallSheet/.test(node.name)), 'water geometry belongs to the program');
  const ship = gltf.nodes.find(node => node.name === 'SV2_Ship');
  assert.equal(ship.extras.rig_version, 1);
  const parts = gltf.nodes.filter(node => node.extras?.source_triangles);
  assert.equal(parts.length, 18);
  assert.equal(parts.reduce((sum, node) => sum + node.extras.source_triangles, 0), 285840);
  assert.equal(parts.filter(node => node.extras.rig_kind === 'fan').length, 6);
  const fans=parts.filter(node=>node.extras.rig_kind==='fan');
  for(const fan of fans){
    assert.equal(fan.extras.cloth_canvas_vertex_start,0);
    assert.equal(fan.extras.cloth_columns,12);assert.equal(fan.extras.cloth_rows,32);
    assert.equal(fan.extras.cloth_two_sides,true);assert.equal(fan.extras.cloth_grid_uv,'uv2');
    assert(fan.extras.cloth_pins.length>0);
    assert(gltf.meshes[fan.mesh].primitives.every(p=>p.attributes.TEXCOORD_2!==undefined),'cloth grid UV must survive export');
  }
  const crest=gltf.nodes.filter(node=>node.name==='SV3_MainSail_Crest');
  assert.equal(crest.length,1,'only the main sail carries a maple crest');
  assert.equal(crest[0].extras.cloth_grid_uv,'uv1');
  const book=readGlb(path.join(directory,'voyage-book.glb')).gltf;
  assert(book.nodes.some(n=>n.name==='SV3_DepartureBook'));
  assert(book.animations.some(a=>a.name==='SV3_BookOpenFlipGlow'));
  assert(fs.readFileSync(path.join(root,'resources/scenes/sky-voyage-v3/models/voyage-book.glb')).equals(fs.readFileSync(path.join(directory,'voyage-book.glb'))),'published book must match Blender export');
  for (const part of parts.filter(node => node.extras.fold_morph || node.extras.wind_morph)) {
    const mesh = gltf.meshes[part.mesh];
    for (const name of [part.extras.fold_morph, part.extras.wind_morph].filter(Boolean)) {
      const index = mesh.extras.targetNames.indexOf(name);
      assert(index >= 0 && mesh.primitives.every(p => p.targets?.[index]?.POSITION !== undefined), `${part.name}: missing ${name}`);
    }
  }
  const layout = JSON.parse(fs.readFileSync(path.join(directory, 'sky-voyage-layout.json'), 'utf8'));
  assert.equal(layout.units, 'metres'); assert.equal(layout.ship.cabin.frontWindowCount, 4); assert.equal(layout.ship.beds.visualCount, 4);
  assert.deepEqual(layout.city.mainIslandSize, [1800, 1280]);
  assert.deepEqual(layout.city.waterBodies, waterBodies, 'water domains must match the authored layout');
  assert.equal(layout.ship.length.zMax - layout.ship.length.zMin, 150);
  assert(Math.abs(layout.ship.beam.xMax - layout.ship.beam.xMin - .218466 * 150 / .851965) < 1e-6);
  assert(layout.ship.layers.length >= 3);
  const connected = new Set(['dock']);
  for (let pass = 0; pass < Object.keys(layout.city.nodes).length; pass++) {
    for (const route of layout.city.routes) {
      assert.deepEqual(route.points[0], layout.city.nodes[route.from]);
      assert.deepEqual(route.points.at(-1), layout.city.nodes[route.to]);
      if (connected.has(route.from) || connected.has(route.to)) { connected.add(route.from); connected.add(route.to); }
    }
  }
  assert.equal(connected.size, Object.keys(layout.city.nodes).length, 'presentation roads have an isolated node');
  for (const name of ['panel', 'button', 'crest']) {
    const image = fs.readFileSync(path.join(directory, `voyage-${name}.png`));
    assert.equal(image.toString('hex', 0, 8), '89504e470d0a1a0a');
    assert.equal(image[25], 6, 'generated decoration must keep RGBA');
  }
  const provenance = JSON.parse(fs.readFileSync(path.join(directory, 'sky-voyage-source.json'), 'utf8'));
  assert(provenance.generatedGeometry.startsWith('P:')); assert(provenance.tms273References.some(source => source.mapName === '天空之城'));
  const license = fs.readFileSync(path.join(directory, 'sky-voyage-wings-license.md'), 'utf8');
  assert(license.includes('Michael Fuchs') && license.includes('CC BY 3.0') && license.includes('https://poly.pizza/m/dw-IMS0xk71'));
  let authoringAndAssemblyMatch = false;
  const authored = path.join(root, 'resources/scenes/sky-voyage-v3/models/sky-voyage.glb');
  if (fs.existsSync(authored)) {
    assert(fs.readFileSync(authored).equals(bytes), 'published model differs from saved source');
    assert(fs.readFileSync(path.join(root, 'resources/scenes/sky-voyage-v3/source-layout.json')).equals(
      fs.readFileSync(path.join(directory, 'sky-voyage-layout.json'))), 'published layout differs from source');
    const blend = fs.readFileSync(path.join(path.dirname(authored), 'sky-voyage.blend'));
    const decoded = blend.readUInt32LE(0) === 0xfd2fb528 ? require('node:zlib').zstdDecompressSync(blend) : blend;
    assert.equal(decoded.toString('ascii', 0, 7), 'BLENDER');
    assert(decoded.includes(Buffer.from('SV3_ProductionRig')), 'saved source scene is missing');
    authoringAndAssemblyMatch = true;
  }
  return { meshes: gltf.meshes.length, nodes: gltf.nodes.length, bytes: bytes.length, sha256: hash(bytes), authoringAndAssemblyMatch,
    skyCity: checkSkyCity(publicDirectory) };
}
if (require.main === module) {
  const args = process.argv.slice(2); let assembly = root, publicDirectory, citySourceOnly = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--city-source-only') citySourceOnly = true;
    else if (args[i] === '--public') {
      assert(args[i + 1] && !args[i + 1].startsWith('--'), '--public requires a public directory path');
      publicDirectory = path.resolve(args[++i]);
    } else {
      assert(!args[i].startsWith('--') && assembly === root, `unexpected argument: ${args[i]}`);
      assembly = path.resolve(args[i]);
    }
  }
  console.log(JSON.stringify(citySourceOnly
    ? { skyCity: checkSkyCity(publicDirectory ?? path.join(assembly, 'client/public-tms273')) }
    : validate(assembly, publicDirectory)));
}
module.exports = { validate };
