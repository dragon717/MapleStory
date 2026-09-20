// Blender exports are the source of the shared rest skeleton, never hand-authored bone offsets.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const source = path.join(root,'resources/scenes/colossus/redesign');
const target = path.join(root,'client/public-tms273/assets/colossus/redesign');
fs.mkdirSync(target,{recursive:true});
const file = fs.readFileSync(path.join(source,'models/colossus-rigged.glb'));
const gltf = JSON.parse(file.subarray(20,20+file.readUInt32LE(12)).toString('utf8'));
assert.equal(gltf.skins.length,1); assert.equal(gltf.skins[0].joints.length,48);
assert(gltf.meshes[0].primitives.every(p=>p.attributes.JOINTS_0!==undefined&&p.attributes.WEIGHTS_0!==undefined));
const jointIds = new Set(gltf.skins[0].joints), bones=[];
function visit(id,parent) {
 const node=gltf.nodes[id];
 if(jointIds.has(id)) {
  assert(!node.matrix,'Bone matrix must be exported as TRS');
  bones.push({name:node.name,parent,position:node.translation??[0,0,0],rotation:node.rotation??[0,0,0,1],flex:[node.extras.flex_min,node.extras.flex_max]});
  parent=node.name;
 }
 for(const child of node.children??[])visit(child,parent);
}
for(const id of gltf.scenes[gltf.scene??0].nodes)visit(id,null);
assert.equal(bones.length,48);assert.equal(bones.filter(b=>/^(index|middle|ring|little|thumb)\./.test(b.name)).length,30);
fs.writeFileSync(path.join(root,'shared/colossus-rig.json'),JSON.stringify({version:1,metres:true,sourceSha256:crypto.createHash('sha256').update(file).digest('hex'),bones},null,2)+'\n','utf8');
const config=JSON.parse(fs.readFileSync(path.join(root,'shared/colossus.json'),'utf8'));
for(const url of Object.values(config.models)) {
 const name=path.basename(url);fs.copyFileSync(path.join(source,'models',name),path.join(target,name));
}
for(const name of ['limestone-painted.png','grass-painted.png'])fs.copyFileSync(path.join(source,'textures',name),path.join(target,name));
console.log('Colossus: 48 rigid bones / 30 finger joints; model and texture copies assembled.');
