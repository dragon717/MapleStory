const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
function validate(root=path.resolve(__dirname,'..')) {
  const config=JSON.parse(fs.readFileSync(path.join(root,'shared/colossus.json'),'utf8'));
  let bytes=0;
  for(const url of Object.values(config.art)) {
    assert(url.startsWith('/assets/colossus/')&&!url.includes('..'),'Invalid colossus resource path');
    const data=fs.readFileSync(path.join(root,'client/public-tms273',url));
    assert.equal(data.subarray(0,8).toString('hex'),'89504e470d0a1a0a',`Invalid PNG: ${url}`);
    assert(data.readUInt32BE(16)>=512 && data.readUInt32BE(20)>=512,`Undersized art: ${url}`);
    bytes+=data.length;
  }
  const crypto=require('node:crypto');
  const rig=JSON.parse(fs.readFileSync(path.join(root,'shared/colossus-rig.json'),'utf8'));
  assert.equal(config.scale.humanHeight,2);assert.equal(config.scale.colossusHeight,100000);
  for(const [name,url] of Object.entries(config.models)) {
    assert(url.startsWith('/assets/colossus/redesign/')&&!url.includes('..'));
    const data=fs.readFileSync(path.join(root,'client/public-tms273',url));
    assert.equal(data.subarray(0,4).toString(),'glTF');assert.equal(data.readUInt32LE(4),2);assert.equal(data.readUInt32LE(8),data.length);
    const gltf=JSON.parse(data.subarray(20,20+data.readUInt32LE(12)).toString('utf8'));
    assert(gltf.scenes[gltf.scene??0].nodes.length>0,`Empty model: ${name}`);
    if(name==='colossus-rigged') {
      assert.equal(gltf.skins[0].joints.length,48);assert.equal(rig.sourceSha256,crypto.createHash('sha256').update(data).digest('hex'));
      const positions=gltf.meshes[0].primitives.map(p=>{ assert(p.attributes.JOINTS_0!==undefined&&p.attributes.WEIGHTS_0!==undefined);return gltf.accessors[p.attributes.POSITION]; });
      const height=Math.max(...positions.map(p=>p.max[1]))-Math.min(...positions.map(p=>p.min[1]));
      assert(Math.abs(height-100000)<.05,`Colossus height mismatch: ${height}`);
      assert.equal(rig.bones.filter(b=>/^(index|middle|ring|little|thumb)\./.test(b.name)).length,30);
    }
    bytes+=data.length;
  }
  for(const cue of ['rope_sever','bridge_land','step_stone','step_wood'])assert(fs.statSync(path.join(root,`client/public-tms273/assets/windbell/sfx/${cue}.ogg`)).size>0,`Missing harbor sound: ${cue}`);
  return {version:config.version,files:Object.keys(config.art).length+Object.keys(config.models).length,bytes};
}
if(require.main===module) console.log('Colossus bundle:',validate());
module.exports={validate};
