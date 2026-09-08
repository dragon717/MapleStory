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
