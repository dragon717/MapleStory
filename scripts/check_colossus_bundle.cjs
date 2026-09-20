const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const PNG_SIGNATURE=Buffer.from('89504e470d0a1a0a','hex');

function assetFile(root,url,label) {
  assert(typeof url==='string'&&url.startsWith('/assets/colossus/')&&!url.includes('..'),`Invalid colossus resource path: ${label||url}`);
  return path.join(root,'client/public-tms273/assets',url.slice('/assets/'.length));
}

function png(root,frame,label,{checkOrigin=true}={}) {
  assert(frame&&typeof frame==='object',`Missing frame: ${label}`);
  assert(Number.isInteger(frame.width)&&frame.width>0,`Invalid frame width: ${label}`);
  assert(Number.isInteger(frame.height)&&frame.height>0,`Invalid frame height: ${label}`);
  assert(frame.origin&&Number.isFinite(frame.origin.x)&&Number.isFinite(frame.origin.y),`Invalid frame origin: ${label}`);
  assert(Number.isFinite(frame.x)&&Number.isFinite(frame.y),`Invalid frame position: ${label}`);
  if(checkOrigin){
    assert.equal(frame.x+frame.origin.x,0,`Frame x must be -origin.x: ${label}`);
    assert.equal(frame.y+frame.origin.y,0,`Frame y must be -origin.y: ${label}`);
  }
  const data=fs.readFileSync(assetFile(root,frame.url,label));
  assert(data.length>=24,`Truncated PNG: ${label}`);
  assert(data.subarray(0,8).equals(PNG_SIGNATURE),`Invalid PNG: ${label}`);
  assert.equal(data.subarray(12,16).toString(),'IHDR',`Missing PNG IHDR: ${label}`);
  assert.equal(data.readUInt32BE(16),frame.width,`PNG width mismatch: ${label}`);
  assert.equal(data.readUInt32BE(20),frame.height,`PNG height mismatch: ${label}`);
  return data.length;
}

function frameList(root,list,label,options) {
  assert(Array.isArray(list),`Missing frame list: ${label}`);
  return list.reduce((bytes,frame,index)=>bytes+png(root,frame,`${label}[${index}]`,options),0);
}

function validate(root=path.resolve(__dirname,'..')) {
  const config=JSON.parse(fs.readFileSync(path.join(root,'shared/colossus.json'),'utf8'));
  let bytes=0;
  for(const url of Object.values(config.art)) {
    const data=fs.readFileSync(assetFile(root,url,url));
    assert(data.length>=24,`Truncated PNG: ${url}`);
    assert(data.subarray(0,8).equals(PNG_SIGNATURE),`Invalid PNG: ${url}`);
    assert(data.readUInt32BE(16)>=512 && data.readUInt32BE(20)>=512,`Undersized art: ${url}`);
    bytes+=data.length;
  }
  const crypto=require('node:crypto');
  const rig=JSON.parse(fs.readFileSync(path.join(root,'shared/colossus-rig.json'),'utf8'));
  assert.equal(config.scale.humanHeight,2);
  assert(Number.isFinite(config.scale.colossusHeight)&&config.scale.colossusHeight>0,'Invalid colossus height scale');
  for(const [name,url] of Object.entries(config.models)) {
    assert(url.startsWith('/assets/colossus/redesign/')&&!url.includes('..'));
    const data=fs.readFileSync(assetFile(root,url,url));
    assert.equal(data.subarray(0,4).toString(),'glTF');assert.equal(data.readUInt32LE(4),2);assert.equal(data.readUInt32LE(8),data.length);
    const gltf=JSON.parse(data.subarray(20,20+data.readUInt32LE(12)).toString('utf8'));
    assert(gltf.scenes[gltf.scene??0].nodes.length>0,`Empty model: ${name}`);
    if(name==='colossus-rigged') {
      assert.equal(gltf.skins[0].joints.length,48);assert.equal(rig.sourceSha256,crypto.createHash('sha256').update(data).digest('hex'));
      const positions=gltf.meshes[0].primitives.map(p=>{ assert(p.attributes.JOINTS_0!==undefined&&p.attributes.WEIGHTS_0!==undefined);return gltf.accessors[p.attributes.POSITION]; });
      const height=Math.max(...positions.map(p=>p.max[1]))-Math.min(...positions.map(p=>p.min[1]));
      assert(Math.abs(height-config.scale.colossusHeight)<.05,`Colossus height mismatch: ${height} vs ${config.scale.colossusHeight}`);
      assert.equal(rig.bones.filter(b=>/^(index|middle|ring|little|thumb)\./.test(b.name)).length,30);
    }
    bytes+=data.length;
  }
  const originals=JSON.parse(fs.readFileSync(path.join(root,'resources/scenes/colossus/originals/manifest.json'),'utf8'));
  assert(originals.monsters&&typeof originals.monsters==='object','Missing originals.monsters manifest');
  assert(originals.sceneAssets&&typeof originals.sceneAssets==='object','Missing originals.sceneAssets manifest');
  let manifestFrames=0;
  for(const [id,monster] of Object.entries(originals.monsters||{})) {
    assert(monster.actions&&typeof monster.actions==='object',`Missing monster actions: ${id}`);
    for(const [action,animation] of Object.entries(monster.actions||{})) {
      assert(Array.isArray(animation.frames),`Missing monster frames: ${id}/${action}`);
      manifestFrames+=animation.frames.length;
      bytes+=frameList(root,animation.frames,`originals.monsters.${id}.${action}`);
    }
  }
  // Scene assets carry authored world instance coordinates. They still need a
  // real PNG and matching dimensions, but their x/y values are not -origin.
  for(const [kind,assets] of Object.entries(originals.sceneAssets||{})) {
    assert(Array.isArray(assets),`Invalid scene asset list: ${kind}`);
    manifestFrames+=assets.length;
    bytes+=frameList(root,assets,`originals.sceneAssets.${kind}`,{checkOrigin:false});
  }
  const connections=JSON.parse(fs.readFileSync(path.join(root,'resources/scenes/colossus/connections/manifest.json'),'utf8'));
  assert(Array.isArray(connections.missing)&&connections.missing.length===0,'Colossus connection manifest has missing frames');
  assert(connections.props&&typeof connections.props==='object','Missing connections.props manifest');
  for(const [kind,frames] of Object.entries(connections.props||{})) {
    manifestFrames+=frames.length;
    bytes+=frameList(root,frames,`connections.props.${kind}`);
  }
  const mapSizes=[];
  for(let stage=1;stage<=4;stage++) {
    const url=`/assets/colossus/maps/stage-${stage}.png`;
    const data=fs.readFileSync(assetFile(root,url,url));
    assert(data.length>=24&&data.subarray(0,8).equals(PNG_SIGNATURE),`Invalid stage map PNG: ${url}`);
    assert.equal(data.subarray(12,16).toString(),'IHDR',`Missing stage map IHDR: ${url}`);
    const width=data.readUInt32BE(16),height=data.readUInt32BE(20);
    assert(width>0&&height>0,`Invalid stage map dimensions: ${url}`);
    mapSizes.push({width,height});bytes+=data.length;
  }
  const ratio=mapSizes[0].width/mapSizes[0].height;
  for(const [index,size] of mapSizes.entries()) assert(Math.abs(size.width/size.height-ratio)<1e-12,`Stage map aspect ratio mismatch: stage-${index+1}`);
  for(const cue of ['rope_sever','bridge_land','step_stone','step_wood'])assert(fs.statSync(path.join(root,`client/public-tms273/assets/windbell/sfx/${cue}.ogg`)).size>0,`Missing harbor sound: ${cue}`);
  return {version:config.version,files:Object.keys(config.art).length+Object.keys(config.models).length,manifestFrames,mapStages:mapSizes.length,bytes};
}
if(require.main===module) console.log('Colossus bundle:',validate());
module.exports={validate};
