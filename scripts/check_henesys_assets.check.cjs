// A player resource package has no authoring tree; validate it and reject a mismatched road.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {validate}=require('./check_henesys_assets.cjs');
const root=path.resolve(__dirname,'..'),fixture=fs.mkdtempSync(path.join(os.tmpdir(),'maple-east-paths-'));
try {
 assert(!process.env.MAPLE_ASSEMBLY_OUTPUT_ROOT,'Run with the normal runtime resource root');
 fs.mkdirSync(path.join(fixture,'shared'));fs.mkdirSync(path.join(fixture,'client'));
 for(const name of ['maps.json','gameplay.json'])fs.symlinkSync(path.join(root,'shared',name),path.join(fixture,'shared',name));
 fs.symlinkSync(path.join(root,'client/public-tms273'),path.join(fixture,'client/public-tms273'),'dir');
 const file=path.join(fixture,'shared/chuxian-east.json'),east=JSON.parse(fs.readFileSync(path.join(root,'shared/chuxian-east.json'),'utf8'));
 fs.writeFileSync(file,JSON.stringify(east));
 assert.equal(validate(fixture).routes,16,'a runtime package works without the optional authoring assets');
 east.routes[0].nodes[0].position[0]+=1;
 fs.writeFileSync(file,JSON.stringify(east));
 assert.throws(()=>validate(fixture),/模型与导航位置不一致/,'visible road and authority mismatch must stop startup');
 console.log('PASS: runtime-only package accepted; mismatched visible/navigation road rejected.');
} finally { fs.rmSync(fixture,{recursive:true,force:true}); }
