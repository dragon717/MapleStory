// CC0 recorded footsteps: keep original bytes and make the ignored cache reproducible.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),spec=require('../shared/chuxian-audio.json');
const cache=path.join(root,'resources/sfx/chuxian');
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const valid=(file,hash)=>fs.existsSync(file)&&digest(fs.readFileSync(file))===hash;
function download(){
 for(const entry of spec.downloads){
  const file=path.join(cache,entry.input);if(valid(file,entry.sha256))continue;
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const bytes=execFileSync('curl',['--fail','--silent','--show-error','--location','--max-time','60',entry.url],{maxBuffer:1024*1024});
  assert.equal(digest(bytes),entry.sha256,'download changed: '+entry.url);fs.writeFileSync(file,bytes);
 }
 for(const sound of Object.values(spec.sounds).flat().filter(s=>s.input.startsWith('sources/tinyworlds/'))){
  const file=path.join(cache,sound.input);if(valid(file,sound.sha256))continue;
  const bytes=execFileSync('tar',['-xOf',path.join(cache,'sources/different-steps.zip'),path.basename(sound.input)]);
  assert.equal(digest(bytes),sound.sha256);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);
 }
}
function assemble(outputRoot=root){
 const publicRoot=path.join(outputRoot,'client/public-tms273');
 for(const sound of Object.values(spec.sounds).flat()){
  const input=path.join(cache,sound.input),file=path.join(publicRoot,sound.url);
  assert(valid(input,sound.sha256),'missing/changed recorded footstep; run node scripts/assemble_chuxian_audio.cjs --download: '+sound.input);
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.copyFileSync(input,file);
  for(const ext of ['.br','.gz'])fs.rmSync(file+ext,{force:true});
 }
 const file=path.join(publicRoot,'assets/chuxian/audio/sources.json');
 fs.writeFileSync(file,JSON.stringify(spec)+'\n','utf8');for(const ext of ['.br','.gz'])fs.rmSync(file+ext,{force:true});
 return Object.values(spec.sounds).flat().length;
}
if(require.main===module){if(process.argv.includes('--download'))download();console.log(JSON.stringify({recordedFootsteps:assemble(process.env.MAPLE_ASSEMBLY_OUTPUT_ROOT?path.resolve(process.env.MAPLE_ASSEMBLY_OUTPUT_ROOT):root)}));}
module.exports={assemble};
