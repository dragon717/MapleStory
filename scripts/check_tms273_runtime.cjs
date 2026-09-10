const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const read=file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
const manifest=read('client/public-tms273/assets/manifest.json');
const gameplay=read('shared/gameplay.json'),catalog=read('shared/maps.json');
assert.equal(manifest.contentVersion,process.argv[2] ?? 'tms273-9');
assert.deepEqual(gameplay.expTable, Array.from({length:200}, (_, i) => i === 199 ? 0 : 15*(i+1)**2));
assert(gameplay.compatibility.experience.startsWith('P:'));
for(const mob of gameplay.monsters) {
  const raw=read(`参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW/Mob/${mob.templateId.padStart(7,'0')}.json`).info;
  assert.equal(mob.maxMp,Number(raw.maxMP?._value ?? 0));
  assert.equal(mob.mdRate,Number(raw.MDRate?._value ?? 0));
  assert.equal(mob.boss,Number(raw.boss?._value ?? 0)===1);
}
assert.equal(catalog.maps.length,41);
assert.equal(gameplay.monsters.find(mob=>mob.templateId==='3220000').maxHp,7500);
assert(!gameplay.spawns.some(spawn=>spawn.templateId==='3220000'),'practice Boss must not become a formal map spawn');
assert(gameplay.compatibility.bossPractice.startsWith('P:'));
for(const id of ['112','113']) {
  assert.equal(manifest.bossEffects[id].mob0.reduce((sum,f)=>sum+f.delay,0),800);
  assert.equal(manifest.bossEffects[id].mob.length,1);
}
assert.equal(manifest.bossEffects['114'].mob0.reduce((sum,f)=>sum+f.delay,0),2060);
assert(!manifest.bossEffects['114'].effect,'missing source art must stay absent');
assert.equal(Object.keys(manifest.skillCatalog).length,56);
for (const effects of Object.values(manifest.skillEffects)) assert(Object.values(effects).every(Array.isArray), 'runtime effect groups must remain frame arrays');
for (const id of ['1000','1001','1002']) {
  assert.equal(manifest.skillCatalog[id].bookId,'0');
  assert.equal(manifest.skillCatalog[id].maxLevel,3);
  assert.equal(manifest.skillCatalog[id].levelDescriptions.length,3);
}
for (const level of ['1','2','3']) for (const kind of ['ball','hit']) assert(manifest.skillEffects[`1000:${level}`][kind].length>0);
for (const id of ['1001','1002']) assert(manifest.skillEffects[id].effect.length>0);
assert.equal(manifest.skillCatalog['2211015'].hidden,true);
for(const id of ['2211011','2211015']) for(const key of ['summonStand','summonAttack']) assert(manifest.skillEffects[id][key].length>0);
for(const id of ['2211002','2211007','2211011','2211012','2211014']) assert(manifest.avatar.actions['skill'+id].length>0);
assert.equal(gameplay.contentVersion,manifest.contentVersion);
assert.equal(manifest.map.id,catalog.birthMapId);
assert.deepEqual(manifest.map.bounds,{xMin:-1310,xMax:960,yMin:-892,yMax:915});
for(const map of catalog.maps) {
  const rendered=manifest.mapCatalog.maps.find(entry=>entry.id===map.id);
  assert(rendered?.layers.length,`Map lacks source layers: ${map.id}`);
  for(const field of ['bounds','footholds','portals','ladders','spawn'])assert.deepEqual(rendered[field],map[field]);
}
// Every gate leading to another assembled map must expose a beam.  Scripted
// doorways (WZ `tm: 999999999`, e.g. 楓之港 `east00` → 碼頭 via `pt_southperry`)
// get their route from the chapter adapter, so the beam is added after it runs.
{
  const assembled=new Set(catalog.maps.map(map=>map.id));
  const missing=[];
  for(const map of catalog.maps)for(const portal of map.portals) {
    if(!portal.targetMapId || portal.targetMapId===map.id)continue;
    if(!assembled.has(portal.targetMapId))continue;
    const beam=manifest.portals[`${map.id}/${portal.name}`];
    if(!beam?.frames?.length)missing.push(`${map.id}/${portal.name}`);
  }
  assert.deepEqual(missing,[],`Scripted cross-map portal lacks a beam: ${missing.join(', ')}`);
  assert(manifest.portals['002000000/east00']?.frames.length>0,'楓之港 → 碼頭 gate must be visible');
  assert(manifest.portals['002000100/west00']?.frames.length>0,'碼頭 → 楓之港 gate must be visible');
}
// A warp must land on the floor, not in mid-air.  Mirrors `world.rs`'s arrival
// resolution (`ground_near` + the 24 px snap window): when the resolved ground
// is farther than that the player stays airborne and falls on the next tick.
// Landing on a destination's default `sp` was the bug — a WZ `sp` marks the
// authored spawn, which sits up to 129 px above the walkable floor.
{
  const byId=new Map(catalog.maps.map(map=>[map.id,map]));
  const groundNear=(map,x,y)=>{
    let best=null;
    for(const f of map.footholds) {
      if(f.x1===f.x2)continue;                       // a wall has no `at()`
      const lo=Math.min(f.x1,f.x2),hi=Math.max(f.x1,f.x2);
      if(!(lo-0.001<=x && x<=hi+0.001))continue;
      const g=f.y1+(x-f.x1)/(f.x2-f.x1)*(f.y2-f.y1);
      if(best===null||Math.abs(g-y)<Math.abs(best-y))best=g;
    }
    return best;
  };
  const floating=[];
  for(const map of catalog.maps)for(const portal of map.portals) {
    const targetId=portal.targetMapId;
    if(!targetId || targetId===map.id || !byId.has(targetId))continue;
    const target=byId.get(targetId);
    const landing=target.portals.find(p=>p.name===portal.targetPortalName) ?? target.spawn;
    const ground=groundNear(target,landing.x,landing.y);
    if(ground===null||Math.abs(ground-landing.y)>24)floating.push(`${map.id}/${portal.name} → ${targetId}/${portal.targetPortalName ?? 'spawn'} (Δ${ground===null?'none':Math.round(ground-landing.y)}px)`);
  }
  assert.deepEqual(floating,[],`Warp landing is not grounded: ${floating.join('; ')}`);
  // The pier ferry in both directions, per `Map/Map/Graph.json`.
  const pier=byId.get('002000000').portals.find(p=>p.name==='east00');
  assert.equal(pier.targetMapId,'002000100');
  assert.equal(pier.targetPortalName,'west00','楓之港 → 碼頭 must land on the pier gate');
  const back=byId.get('002000100').portals.find(p=>p.name==='west00');
  assert.equal(back.targetMapId,'002000000');
  assert.equal(back.targetPortalName,'in00','碼頭 → 楓之港 must land on the town gate');
}
for(const spawn of gameplay.spawns)assert(manifest.monsters[spawn.templateId]?.actions.move.length,spawn.id);
for(const spawn of gameplay.npcSpawns)assert(manifest.npcs[spawn.templateId]?.stand.length,spawn.id);
for(const shop of gameplay.shops)for(const entry of shop.items)assert(manifest.items[entry.itemId],entry.itemId);
for(const id of ['36301','36302','36303','36304','36306','36307'])assert(gameplay.quests.some(q=>q.questId===id));
const sourceQuests=read('references/tms273-data/quests.json').quests;
assert.equal(sourceQuests.length,64);
assert(sourceQuests.some(q=>q.id==='1402' && !q.executable));
assert.equal(gameplay.quests.filter(q=>q.executable).length,15);
for(const id of ['1402','36308','36309','36310','36311','36312','36313','36314']) {
  const raw=sourceQuests.find(q=>q.id===id), runtime=gameplay.quests.find(q=>q.questId===id);
  const sourceIds=Object.values(raw.Check['0'].quest).filter(q=>q?.id).map(q=>String(q.id._value));
  assert.deepEqual(runtime.start.conditions.quests.map(q=>q.questId),sourceIds);
}
assert(gameplay.compatibility.adventurerContinuation.temporaryRules.startsWith('P:'));
const chapter=read('resources/tms273-export/chapter.json');
assert.equal(chapter.items['1003134'].info.reqLevel,0);
for(const id of ['4033888','4033889','4036847','1003134'])assert(manifest.items[id]);
const appearance=read('client/public-tms273/assets/entry/appearance.json');
assert(appearance.layers['1003134'],'quest disguise must have real appearance layers');
assert(gameplay.npcSpawns.some(n=>n.templateId==='1541003'&&n.mapId==='130000000'));
assert(gameplay.npcSpawns.every(n=>catalog.maps.some(m=>m.id===n.mapId)));
assert(!gameplay.quests.some(q=>q.questId==='1021'||q.questId.startsWith('322')));
let checked=0;
function visit(value) {
  if(typeof value==='string'&&value.startsWith('/assets/')) {
    assert(value.startsWith('/assets/tms273/'),value);
    assert(fs.statSync(path.join(root,'client/public-tms273',value)).size>0,value);checked++;
  } else if(value&&typeof value==='object')for(const child of Object.values(value))visit(child);
}
visit(manifest);
console.log(`TMS273 runtime: ${catalog.maps.length} maps; ${checked} source references; client/server geometry and quest generation agree.`);

assert(!manifest.skillCatalog['2220014']);
for(const id of ['2221004','2221005','2221006','2221007','2221011','2221012']) assert(manifest.avatar.actions['skill'+id].length>0);
for(const key of ['prepare','keydown','keydown0','keydownend']) assert(manifest.skillEffects['2221011'][key].length>0);
assert(manifest.skillEffects['2220014'].hit.length>0);
assert(manifest.skillEffects['2221000'].effect0.length>0);
assert(manifest.skillEffects['2221004'].special.length>0);
assert(manifest.skillSounds['2221011'].loop.url && manifest.skillSounds['2221011'].end.url);
