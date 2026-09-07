// Assemble the active runtime only after every exported component is present.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const input = path.join(root, 'resources/tms273-export');
const publicRoot = path.join(root, 'client/public-tms273');
const read = name => JSON.parse(fs.readFileSync(path.join(input, name + '.json'), 'utf8'));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, JSON.stringify(value) + '\n', 'utf8'); };
const version = 'tms273-1';
const catalog = read('maps-rendered'), effects = read('effects'), entities = read('entities');
const avatar = read('avatar').avatar, gameplay = read('gameplay'), items = read('items');
const windows = read('windows'), inventory = read('windows-inventory');
const maps = catalog.maps.map(map => ({...map, bgm:effects.bgm[map.id]}));
const birth = maps.find(map => map.id === catalog.birthMapId);
assert(birth, 'Birth map absent');
assert(maps.length === JSON.parse(fs.readFileSync(path.join(root,'references/tms273-data/maps.json'),'utf8')).maps.length, 'Map export is stale');
assert.deepEqual(Object.keys(gameplay.sources.maps).sort(),maps.map(map=>map.id).sort(),'Gameplay export is stale');
const sourceQuests=JSON.parse(fs.readFileSync(path.join(root,'references/tms273-data/quests.json'),'utf8')).quests;
assert.deepEqual(gameplay.quests.map(q=>String(q.questId)).sort(),sourceQuests.map(q=>String(q.id)).sort(),'Quest export is stale');
const manifest = {
  schemaVersion:2, contentVersion:version,
  source:{gameVersion:'TMS273.7', parser:'scripts/tms273_wz.cjs'},
  avatar, map:birth, mapCatalog:{...catalog,maps},
  monsters:entities.monsters,npcs:entities.npcs,items:read('item-images'),
  hud:read('hud'),portals:read('portals'),combat:effects.combat,...windows,...inventory,chatUi:read('chat').chatUi,
};
for(const id of Object.keys(items))assert(manifest.items[id],`Item image export is stale: ${id}`);
{
  const extra=read('combat-extra');
  Object.assign(manifest.combat,extra.combat);
  if(extra.avatarAttackSound?.url)manifest.avatar.attackSound=extra.avatarAttackSound.url;
  Object.assign(gameplay.player,{attackAfterMs:extra.attack.hitAtMs,attackLt:extra.attack.hitbox.lt,attackRb:extra.attack.hitbox.rb});
  if(extra.expTable?.length)gameplay.expTable=extra.expTable;
}
// ponytail: existing movement/basic-combat engine remains a compatibility adapter;
// replace these initial attributes only when verified 273 server rules are available.
gameplay.player={job:0,baseStr:12,baseDex:5,baseInt:4,baseLuk:4,weaponType:130,weaponWatk:items["1302000"].info.incPAD,
  mastery:0.1,maxHp:50,maxMp:5,climbSpeed:125,attackReach:88,attackHeight:62,
  attackAfterMs:450,contactInvulnerabilityMs:2000,...gameplay.player};
gameplay.contentVersion=version;
gameplay.compatibility.player='Initial attributes and base combat formula use the existing runtime adapter; they are not certified TMS273 server parity.';
const urls=new Set();
function collect(value) {
  if(typeof value==='string' && value.startsWith('/assets/')) { assert(value.startsWith('/assets/tms273/'),`Foreign asset: ${value}`);urls.add(value); }
  else if(value&&typeof value==='object')for(const child of Object.values(value))collect(child);
}
collect(manifest);
for(const url of urls) assert(fs.statSync(path.join(input,url.slice(1))).size>0,`Missing asset ${url}`);
for(const url of urls) {
  const destination=path.join(publicRoot,url.slice(1));fs.mkdirSync(path.dirname(destination),{recursive:true});
  fs.copyFileSync(path.join(input,url.slice(1)),destination);
}
for(const [name,data] of Object.entries({gameplay,items,'quest-text':read('quest-text'),'npc-names':read('npc-names'),map:birth,maps:{birthMapId:birth.id,maps}})) {
  // Rendering layers belong to the client manifest, not the server's map catalog.
  const serverData=name==='map'?(({layers,...map})=>map)(data):name==='maps'?{...data,maps:data.maps.map(({layers,...map})=>map)}:data;
  write(path.join(root,'shared',name+'.json'),serverData);
  if(name==='gameplay'||name==='items')write(path.join(publicRoot,'assets',name+'.json'),data);
}
write(path.join(publicRoot,'assets/manifest.json'),manifest);
console.log(JSON.stringify({version,maps:maps.length,assets:urls.size,npcs:Object.keys(entities.npcs).length,monsters:Object.keys(entities.monsters).length}));
