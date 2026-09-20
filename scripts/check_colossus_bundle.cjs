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
  for(const cue of ['rope_sever','bridge_land','step_stone','step_wood'])assert(fs.statSync(path.join(root,`client/public-tms273/assets/windbell/sfx/${cue}.ogg`)).size>0,`Missing harbor sound: ${cue}`);
  return {version:config.version,files:Object.keys(config.art).length,bytes};
}
if(require.main===module) console.log('Colossus bundle:',validate());
module.exports={validate};
