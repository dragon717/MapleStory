// Geometry/catalog checks plus the actual Rust selector versus the client hint mirror.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'..'),read=file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
const city=read('shared/sky-city.json'),source=read(city.source),maps=read('shared/maps.json').maps,sky=maps.find(m=>m.id===city.mapId);
assert.equal(city.routes.length,source.edges.length);assert(city.routes.length>=201);assert(source.fourWayJunctions);assert.equal(sky.footholds.length,city.platforms.length);assert.deepEqual({x:sky.spawn.x,y:sky.spawn.y},city.spawn);
for(const [i,r] of city.routes.entries()){
 assert.equal(r.edgeId,source.edges[i].id);assert.deepEqual(r.nodes.map(n=>n.position),source.edges[i].points);
 for(const n of r.nodes)assert(Math.abs(n.y+n.position[1]*city.pixelsPerMetre)<1e-8);
}
assert(Math.abs(sky.portals.find(p=>p.name==='chuxian').x-city.spawn.x)>48,'dock spawn must clear the return gate');
const gates=maps.flatMap(m=>m.portals.filter(p=>p.targetMapId).map(p=>({from:m.id,...p})));
assert.equal(gates.length,2,'permanently disconnected legacy graph');
for(const p of gates){assert(['100000000','200000000'].includes(p.from));const other=maps.find(m=>m.id===p.targetMapId).portals.find(q=>q.name===p.targetPortalName);assert.equal(other.targetMapId,p.from);assert.equal(other.targetPortalName,p.name);}
const actors=read('shared/gameplay.json').npcSpawns.filter(n=>n.mapId===city.mapId);
for(const n of actors){const f=city.platforms.find(f=>f.id===n.footholdId);assert(f&&n.x>=f.x1&&n.x<=f.x2);assert(Math.abs(n.y-f.y1-(f.y2-f.y1)*(n.x-f.x1)/(f.x2-f.x1))<1e-5);}
const output=path.join(root,'build/.checks/sky-city.cjs');fs.mkdirSync(path.dirname(output),{recursive:true});
createRequire(path.join(root,'client/package.json'))('esbuild').buildSync({entryPoints:[path.join(root,'client/src/features/henesys/coordinates.ts')],bundle:true,platform:'node',format:'cjs',outfile:output});
const {junctionDirections,point3d}=require(output);
assert(point3d(city.spawn.x,city.spawn.y,city.mapId).every((v,i)=>Math.abs(v-[-200,0,338][i])<1e-8));
const cargo=process.env.CARGO_BIN??path.join(process.env.HOME,'.cargo/bin/cargo');
const result=spawnSync(cargo,['test','--manifest-path','server/Cargo.toml','sky_city_routes_and_turns','--','--nocapture'],{cwd:root,env:{...process.env,CARGO_TARGET_DIR:path.join(root,'build/.cargo-cache')},encoding:'utf8',maxBuffer:8*1024*1024});
assert.equal(result.status,0,result.stderr.slice(-4000));
const line=result.stdout.split('\n').find(line=>line.startsWith('CITY_JUNCTION_CHOICES='));assert(line,'Rust selector fixture');
const samples=JSON.parse(line.slice('CITY_JUNCTION_CHOICES='.length));
for(const s of samples){assert(s.choices.every(d=>['up','down','left','right'].includes(d)));}
for(const s of samples)assert.deepEqual(new Set(junctionDirections(s.x,s.view??undefined,city.mapId)),new Set(s.choices),`server/client road choice at ${s.x} ${JSON.stringify(s.view)}`);
console.log(JSON.stringify({ok:true,routes:city.routes.length,junctions:city.junctions.length,segments:city.platforms.length,portals:gates.length,hintSamples:samples.length,npcs:actors.length}));
