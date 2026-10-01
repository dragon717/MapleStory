// Validate served roads against authority; works with both a source tree and a runtime resource package.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
function validate(root=path.resolve(__dirname,'..')) {
 const assembly=process.env.MAPLE_ASSEMBLY_OUTPUT_ROOT?path.resolve(process.env.MAPLE_ASSEMBLY_OUTPUT_ROOT):root;
 const read=(base,file)=>JSON.parse(fs.readFileSync(path.join(base,file),'utf8'));
 const east=read(root,'shared/chuxian-east.json'),publicRoot=path.join(assembly,'client/public-tms273');
 const buffer=fs.readFileSync(path.join(publicRoot,'assets/henesys/chuxian-east.glb'));
 assert.equal(buffer.toString('ascii',0,4),'glTF');assert.equal(buffer.readUInt32LE(8),buffer.length);
 const gltf=JSON.parse(buffer.subarray(20,20+buffer.readUInt32LE(12)).toString('utf8').trim());
 assert.equal(gltf.asset.version,'2.0');assert(gltf.images.length>0&&gltf.images.every(i=>i.bufferView!==undefined&&!i.uri),'local textures must be embedded');
 const source=JSON.parse(gltf.scenes[gltf.scene].extras.layout);
 assert.equal(east.routes.length,source.routes.length,'初弦地路径错误：模型与导航道路数量不一致');assert.equal(east.mapId,'100000000');
 const routeIndices=new Set([0]);for(let i=0;i<east.routes.length;i++)for(const j of east.junctions)if(j.entries.some(e=>routeIndices.has(e.route)))j.entries.forEach(e=>routeIndices.add(e.route));assert.equal(routeIndices.size,east.routes.length,'初弦地路径错误：道路未连接');
 for(const [i,r] of east.routes.entries()) {
  assert.equal(r.name,source.routes[i].name);assert.equal(r.nodes.length,source.routes[i].points.length,'初弦地路径错误：路段数量不一致');
  for(const [j,n] of r.nodes.entries()) {
   const name=source.routes[i].points[j],p=source.nodes[name];assert.equal(n.name,name);
   assert.deepEqual(n.position,[p[0],p[2],-p[1]||0],`初弦地路径错误：${r.name}/${name} 模型与导航位置不一致`);assert.equal(n.y,-p[2]*east.pixelsPerMetre);
   if(j){const a=r.nodes[j-1];assert(n.x>a.x);assert(Math.abs(n.x-a.x-Math.hypot(n.position[0]-a.position[0],n.position[2]-a.position[2])*east.pixelsPerMetre)<1e-5,'初弦地路径错误：道路弧长不一致');}
  }
 }
 // Source packages are optional for players; when present, keep the existing authoring checks.
 if(fs.existsSync(path.join(root,east.source)))assert.deepEqual(read(root,east.source),source,'GLB layout and editable source differ');
 const authored=path.join(root,'resources/scenes/chuxian-east-v1/models/chuxian-east.glb');
 if(fs.existsSync(authored))assert(fs.readFileSync(authored).equals(buffer),'published GLB differs from source');
 const semantic=gltf.nodes.filter(n=>n.extras?.layer);assert(semantic.filter(n=>n.extras.layer==='buildings').length>=11);assert(semantic.filter(n=>n.extras.layer==='roads').length>=10);assert(semantic.some(n=>n.extras.layer==='water'));
 const hdr=fs.readFileSync(path.join(publicRoot,'assets/henesys/dawn.exr'));
 const hash=crypto.createHash('sha256').update(hdr).digest('hex');assert.equal(hash,'411cb7d75b2dea46a496342fab84203c413edf24b7dfd494337e705519ead31a');
 const licenseFile='resources/scenes/chuxian-east-v1/vendor/lighting/source.json';if(fs.existsSync(path.join(root,licenseFile)))assert(JSON.stringify(read(root,licenseFile)).includes('CC0'));
 const maps=read(assembly,'shared/maps.json'),manifest=read(publicRoot,'assets/manifest.json'),gameplay=read(assembly,'shared/gameplay.json');
 const findMaps=value=>Array.isArray(value)?value:value.maps;
 for(const m of [findMaps(maps).find(m=>m.id===east.mapId),manifest.mapCatalog.maps.find(m=>m.id===east.mapId)]) {
  assert(m,'初弦地路径错误：地图缺失');assert.deepEqual(m.footholds,east.platforms);assert.deepEqual(m.bounds,east.bounds);assert.equal(m.spawn.x,east.spawn.x);
  for(const p of [...m.portals,...(m.reactors??[])])assert(east.platforms.some(f=>p.x>=f.x1&&p.x<=f.x2&&Math.abs(p.y-(f.y1+(f.y2-f.y1)*(p.x-f.x1)/(f.x2-f.x1)))<1e-5),'portal/reactor foot off road');
 }
 const npcs=gameplay.npcSpawns.filter(n=>n.mapId===east.mapId),originalFile='resources/tms273-export/gameplay.json';
 if(fs.existsSync(path.join(root,originalFile)))assert.deepEqual(npcs.map(n=>n.id),read(root,originalFile).npcSpawns.filter(n=>n.mapId===east.mapId).map(n=>n.id),'NPC identity changed');
 for(const n of npcs)assert(east.platforms.some(f=>n.footholdId===f.id&&n.x>=f.x1&&n.x<=f.x2&&Math.abs(n.y-(f.y1+(f.y2-f.y1)*(n.x-f.x1)/(f.x2-f.x1)))<1e-5),'NPC foot off road');
 assert.equal(manifest.contentVersion,gameplay.contentVersion);assert.equal(manifest.miniMap.maps[east.mapId].url,'/assets/henesys/east-minimap.svg');
 return {ok:true,routes:east.routes.length,junctions:east.junctions.length,segments:east.platforms.length,npcs:npcs.length,glbBytes:buffer.length,hdriBytes:hdr.length,sha256:hash,content:manifest.contentVersion};
}
if(require.main===module)console.log(JSON.stringify(validate()));
module.exports={validate};
