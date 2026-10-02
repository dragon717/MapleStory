const fs = require('node:fs');
const assert = require('node:assert/strict');

const file = process.argv[2] || 'resources/scenes/sky-voyage-v3/models/voyage-book.glb';
const data = fs.readFileSync(file);
assert.equal(data.toString('ascii', 0, 4), 'glTF', 'not a binary glTF');
assert.equal(data.readUInt32LE(4), 2, 'unexpected glTF version');
const jsonLength = data.readUInt32LE(12);
const json = JSON.parse(data.subarray(20, 20 + jsonLength).toString('utf8'));

const names = json.nodes.map(node => node.name).filter(Boolean);
const has = name => names.includes(name);
const unique = name => names.filter(item => item === name).length === 1;
assert(has('SV3_DepartureBook'), 'runtime root node missing');
assert(has('SV3_BookRig'), 'book armature node missing');
assert(has('SV3_Cover_L') && has('SV3_Cover_R'), 'cover nodes missing');
assert(has('SV3_Page_L_00_S00') && has('SV3_Page_R_00_S00'), 'segmented page nodes missing');
assert(has('SV3_DepartureGlow'), 'late glow node missing');
assert(unique('SV3_DepartureBook') && unique('SV3_Cover_L') && unique('SV3_Cover_R'), 'runtime node names must be unique');
assert.equal(json.skins?.length, 1, 'expected one editable book rig skin');
assert(json.meshes.length >= 150, `geometry unexpectedly small: ${json.meshes.length} meshes`);

const animations = json.animations || [];
const animation = animations.find(item => item.name === 'SV3_BookOpenFlipGlow');
assert(animation, 'combined mixer clip missing');
assert(animation.channels.length >= 300, `page/cover channels missing: ${animation.channels.length}`);
const endSeconds = Math.max(...animation.samplers.map(sampler => {
  const accessor = json.accessors[sampler.input];
  return accessor.max?.[0] ?? 0;
}));
assert(endSeconds >= 2.0 && endSeconds <= 2.2, `unexpected animation duration: ${endSeconds}`);

const root = json.nodes.find(node => node.name === 'SV3_DepartureBook');
assert.equal(root.extras?.animation_clip, 'SV3_BookOpenFlipGlow', 'runtime animation contract missing');
assert.equal(root.extras?.animation_duration_seconds, 63 / 30, 'runtime duration contract missing');

console.log(JSON.stringify({
  file,
  gltf: json.asset,
  nodes: json.nodes.length,
  meshes: json.meshes.length,
  skins: json.skins.length,
  animation: animation.name,
  channels: animation.channels.length,
  durationSeconds: endSeconds,
  rootExtras: root.extras,
}, null, 2));
