// Preserve TMS273 identities; only placements and the authored spatial authority change.
const east = require('../shared/chuxian-east.json');
const surface = x => east.platforms.find(f=>x>=f.x1&&x<=f.x2);
const height = (f,x) => f.y1+(f.y2-f.y1)*(x-f.x1)/(f.x2-f.x1);
function at(route,ratio){const r=east.routes[route],x=r.start+(r.end-r.start)*ratio,f=surface(x);return {x,y:height(f,x),f};}
function applyHenesysLayout(maps,gameplay){
  const map=maps.find(m=>m.id===east.mapId);if(!map)throw new Error('初弦地 source map missing');
  map.footholds=east.platforms.map(f=>({...f}));map.bounds={...east.bounds};map.spawn={...map.spawn,...east.spawn};map.ladders=[];
  // Door identities remain intact: large hall, market and eastern homes receive the existing entrances.
  let door=0;
  for(const p of map.portals){const a=p.name==='sp'?{...east.spawn}:p.name.startsWith('west')?at(0,.018):p.name.startsWith('east')?at(0,.98):at([1,3,5,11][door%4],.15+(.13*Math.floor(door++/4))% .7);p.x=a.x;p.y=a.y;}
  const npcs=gameplay.npcSpawns.filter(s=>s.mapId===east.mapId);
  npcs.forEach((s,i)=>{const a=at([0,1,1,3,5,11,12,6][i%8],.12+Math.floor(i/8)*.13);Object.assign(s,{x:a.x,y:a.y,footholdId:a.f.id});});
  for(const s of gameplay.spawns.filter(s=>s.mapId===east.mapId)){const a=at(6,.3);Object.assign(s,{x:a.x,y:a.y,footholdId:a.f.id,rx0:a.f.x1,rx1:a.f.x2});}
  (map.reactors??[]).forEach((p,i)=>{const a=at(1,.25+i*.04);p.x=a.x;p.y=a.y;});
  gameplay.compatibility.henesysRail='P: 初弦地东边村落; 16 spatial roads and server-owned junctions from shared/chuxian-east.json; TMS273 identities retained.';
}
module.exports={applyHenesysLayout};
