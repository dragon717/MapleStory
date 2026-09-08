const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const read=file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
const manifest=read('client/public-tms273/assets/manifest.json');
const gameplay=read('shared/gameplay.json'),catalog=read('shared/maps.json');
assert.equal(manifest.contentVersion,'tms273-2');
assert.deepEqual(gameplay.expTable, Array.from({length:60}, (_, i) => i === 59 ? 0 : 15*(i+1)**2));
assert(gameplay.compatibility.experience.startsWith('P:'));
for(const mob of gameplay.monsters)assert(Number.isSafeInteger(mob.maxMp)&&mob.maxMp>=0);
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
