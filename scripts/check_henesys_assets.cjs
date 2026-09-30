// Production boundary check: spatial source -> shared authority -> assembly -> actual served assets.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),assembly=process.env.MAPLE_ASSEMBLY_OUTPUT_ROOT?path.resolve(process.env.MAPLE_ASSEMBLY_OUTPUT_ROOT):root;
const read=(base,file)=>JSON.parse(fs.readFileSync(path.join(base,file),'utf8'));
const east=read(root,'shared/chuxian-east.json'),source=read(root,east.source);
assert.equal(east.routes.length,16);assert.equal(east.mapId,'100000000');
const routeIndices=new Set([0]);for(let i=0;i<16;i++)for(const j of east.junctions)if(j.entries.some(e=>routeIndices.has(e.route)))j.entries.forEach(e=>routeIndices.add(e.route));assert.equal(routeIndices.size,16,'disconnected road');
for(const [i,r] of east.routes.entries())for(const [j,n] of r.nodes.entries()){
 const p=source.nodes[source.routes[i].points[j]];assert.deepEqual(n.position,[p[0],p[2],-p[1]||0],'authority differs from reviewed Blender source');assert.equal(n.y,-p[2]*45);if(j)assert(n.x>r.nodes[j-1].x);
}
const buffer=fs.readFileSync(path.join(root,'resources/scenes/chuxian-east-v1/models/chuxian-east.glb'));
assert.equal(buffer.toString('ascii',0,4),'glTF');assert.equal(buffer.readUInt32LE(8),buffer.length);
const gltf=JSON.parse(buffer.subarray(20,20+buffer.readUInt32LE(12)).toString('utf8').trim());
assert.equal(gltf.asset.version,'2.0');assert(gltf.images.length>0&&gltf.images.every(i=>i.bufferView!==undefined&&!i.uri),'local textures must be embedded');
const layout=JSON.parse(gltf.scenes[gltf.scene].extras.layout);assert.deepEqual(layout,source,'GLB layout and authority source differ');
const semantic=gltf.nodes.filter(n=>n.extras?.layer);assert(semantic.filter(n=>n.extras.layer==='buildings').length>=11);assert(semantic.filter(n=>n.extras.layer==='roads').length>=10);assert(semantic.some(n=>n.extras.layer==='water'));
const publicRoot=path.join(assembly,'client/public-tms273');assert(fs.readFileSync(path.join(publicRoot,'assets/henesys/chuxian-east.glb')).equals(buffer),'published GLB differs');
const hdr=fs.readFileSync(path.join(publicRoot,'assets/henesys/dawn.exr')),license=read(root,'resources/scenes/chuxian-east-v1/vendor/lighting/source.json');
const hash=crypto.createHash('sha256').update(hdr).digest('hex');assert.equal(hash,'411cb7d75b2dea46a496342fab84203c413edf24b7dfd494337e705519ead31a');assert(JSON.stringify(license).includes('CC0'));
const maps=read(assembly,'shared/maps.json'),manifest=read(publicRoot,'assets/manifest.json'),gameplay=read(assembly,'shared/gameplay.json');
const findMaps=value=>Array.isArray(value)?value:value.maps;
for(const m of [findMaps(maps).find(m=>m.id===east.mapId),manifest.mapCatalog.maps.find(m=>m.id===east.mapId)]){assert.deepEqual(m.footholds,east.platforms);assert.deepEqual(m.bounds,east.bounds);assert.equal(m.spawn.x,east.spawn.x);for(const p of [...m.portals,...(m.reactors??[])])assert(east.platforms.some(f=>p.x>=f.x1&&p.x<=f.x2&&Math.abs(p.y-(f.y1+(f.y2-f.y1)*(p.x-f.x1)/(f.x2-f.x1)))<1e-5),'portal/reactor foot off road');}
const npcs=gameplay.npcSpawns.filter(n=>n.mapId===east.mapId),original=read(root,'resources/tms273-export/gameplay.json').npcSpawns.filter(n=>n.mapId===east.mapId);
assert.deepEqual(npcs.map(n=>n.id),original.map(n=>n.id),'NPC identity changed');
for(const n of npcs)assert(east.platforms.some(f=>n.footholdId===f.id&&n.x>=f.x1&&n.x<=f.x2&&Math.abs(n.y-(f.y1+(f.y2-f.y1)*(n.x-f.x1)/(f.x2-f.x1)))<1e-5),'NPC foot off road');
assert.equal(manifest.contentVersion,'tms273-50');assert.equal(manifest.miniMap.maps[east.mapId].url,'/assets/henesys/east-minimap.svg');
console.log(JSON.stringify({ok:true,routes:east.routes.length,junctions:east.junctions.length,segments:east.platforms.length,npcs:npcs.length,glbBytes:buffer.length,hdriBytes:hdr.length,sha256:hash,content:manifest.contentVersion}));
