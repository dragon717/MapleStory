// Preserve TMS273 identities; only placements and the authored spatial authority change.
const east = require('../shared/chuxian-east.json');
const city = require('../shared/sky-city.json');
const surface = x => east.platforms.find(f=>x>=f.x1&&x<=f.x2);
const height = (f,x) => f.y1+(f.y2-f.y1)*(x-f.x1)/(f.x2-f.x1);
function at(route,ratio){const r=east.routes[route],x=r.start+(r.end-r.start)*ratio,f=surface(x);return {x,y:height(f,x),f};}
function applyHenesysLayout(maps,gameplay){
  const map=maps.find(m=>m.id===east.mapId);if(!map)throw new Error('初弦地 source map missing');
  map.footholds=east.platforms.map(f=>({...f}));map.bounds={...east.bounds};map.spawn={...map.spawn,...east.spawn};map.ladders=[];
  const sky=maps.find(m=>m.id===city.mapId);if(!sky)throw Error('天空之城 source map missing');
  Object.assign(sky,{name:city.name,streetName:city.district,footholds:city.platforms.map(f=>({...f})),bounds:{...city.bounds},spawn:{...sky.spawn,...city.spawn},ladders:[]});
  const skyAt=(i,t)=>{const r=city.routes[i],x=r.start+(r.end-r.start)*t,f=city.platforms.find(f=>x>=f.x1&&x<=f.x2);return {x,y:height(f,x),footholdId:f.id};};
  gameplay.npcSpawns.filter(s=>s.mapId===city.mapId).forEach((s,i)=>Object.assign(s,skyAt(i%3,.2+(Math.floor(i/3)%5)*.13)));
  gameplay.spawns.filter(s=>s.mapId===city.mapId).forEach((s,i)=>{const a=skyAt(2,.7);Object.assign(s,a,{rx0:city.routes[2].start,rx1:city.routes[2].end});});
  (sky.reactors??[]).forEach((r,i)=>Object.assign(r,skyAt(0,.25+i*.05)));
  const npcs=gameplay.npcSpawns.filter(s=>s.mapId===east.mapId);
  npcs.forEach((s,i)=>{const a=at([0,1,1,3,5,11,12,6][i%8],.12+Math.floor(i/8)*.13);Object.assign(s,{x:a.x,y:a.y,footholdId:a.f.id});});
  for(const s of gameplay.spawns.filter(s=>s.mapId===east.mapId)){const a=at(6,.3);Object.assign(s,{x:a.x,y:a.y,footholdId:a.f.id,rx0:a.f.x1,rx1:a.f.x2});}
  (map.reactors??[]).forEach((p,i)=>{const a=at(1,.25+i*.04);p.x=a.x;p.y=a.y;});
  gameplay.compatibility.henesysRail='P: 初弦地东边村落; 16 spatial roads and server-owned junctions from shared/chuxian-east.json; TMS273 identities retained.';
}
function connectMigratedWorld(maps){
  // Permanently retire the old portal graph; source exports and saves remain available.
  for(const m of maps)m.portals=m.portals.filter(p=>p.name==='sp').map(p=>({...p,targetMapId:null,targetPortalName:null,script:null}));
  const sky=maps.find(m=>m.id===city.mapId);if(!sky)throw Error('天空之城 source map missing');
  Object.assign(sky,{name:city.name,streetName:city.district,footholds:city.platforms.map(f=>({...f})),bounds:{...city.bounds},spawn:{...sky.spawn,...city.spawn},ladders:[],entryScripts:[]});
  const map=maps.find(m=>m.id===east.mapId);
  map.entryScripts=[];
  const gate=at(0,.98);
  const portal=(name,point,targetMapId,targetPortalName)=>({name,type:2,x:point.x,y:point.y,targetMapId,targetPortalName,script:null});
  map.portals=[{name:'sp',type:0,...east.spawn},portal('skyCity',gate,city.mapId,'chuxian')];
  sky.portals=[{name:'sp',type:0,...city.spawn},portal('chuxian',city.routes[0].nodes[0],east.mapId,'skyCity')];
}
module.exports={applyHenesysLayout,connectMigratedWorld};
