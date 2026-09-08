// Assemble the active runtime only after every exported component is present.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { skillManifest, mageRules } = require('./tms273_skill_manifest.cjs');
const root = path.resolve(__dirname, '..');
const input = path.join(root, 'resources/tms273-export');
const publicRoot = path.join(root, 'client/public-tms273');
const read = name => JSON.parse(fs.readFileSync(path.join(input, name + '.json'), 'utf8'));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, JSON.stringify(value) + '\n', 'utf8'); };
const version = 'tms273-2';
const catalog = read('maps-rendered'), effects = read('effects'), entities = read('entities');
const avatar = read('avatar').avatar, gameplay = read('gameplay'), items = read('items');
const mageAvatar = read('mage-avatar');
Object.assign(avatar.actions, mageAvatar.actions);
for (const [key, actions] of Object.entries(mageAvatar.equipmentLoadouts)) Object.assign(avatar.equipmentLoadouts[key].actions, actions);
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
  ...skillManifest(read('windows-skills'), read('skills')),
  npcQuestAvailable: read('npc-marker').npcQuestAvailable,
  skillEffects: read('mage-effects').skillEffects,
  skillSounds: Object.fromEntries(Object.entries(read('skill-sounds').skillSounds).map(([id, sounds]) => [id, { use: sounds.use, hit: sounds.hit }])),
  characterUi: read('character-ui').characterUi,
  characterLayout: read('character-ui').characterLayout,
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
// Preserve the same-version monster MP and boss flags for Magic Drain.
for (const monster of gameplay.monsters) {
  const raw = JSON.parse(fs.readFileSync(path.join(root, '参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW/Mob', monster.templateId.padStart(7, '0') + '.json'), 'utf8')).info;
  monster.maxMp = Number(raw.maxMP?._value ?? 0);
  monster.boss = Number(raw.boss?._value ?? 0) === 1;
  assert(Number.isSafeInteger(monster.maxMp) && monster.maxMp >= 0);
}
// P: temporary runnable level curve while TMS273's source EXP table is unavailable.
// Level 60 is this curve's current ceiling; replace with a verified table to extend it.
if (!gameplay.expTable?.length) gameplay.expTable = Array.from({length: 60}, (_, i) => i === 59 ? 0 : 15 * (i + 1) ** 2);
gameplay.compatibility.experience = 'P: levels 1..59 need 15*level^2 EXP, level60 cap; each gained level grants 5 AP. Not an official TMS273 EXP table.';
// ponytail: existing movement/basic-combat engine remains a compatibility adapter;
// replace these initial attributes only when verified 273 server rules are available.
gameplay.player={job:0,baseStr:12,baseDex:5,baseInt:4,baseLuk:4,weaponType:130,weaponWatk:items["1302000"].info.incPAD,
  mastery:0.1,maxHp:50,maxMp:5,climbSpeed:125,attackReach:88,attackHeight:62,
  attackAfterMs:450,contactInvulnerabilityMs:2000,...gameplay.player};
gameplay.contentVersion=version;
// User-requested shortcut (2026-09-08), separate from the missing original quest scripts.
const mage = gameplay.npcs.find(npc => npc.templateId === '10201');
assert(mage && gameplay.npcSpawns.some(npc => npc.id === '001020000-life-1' && npc.templateId === '10201' && npc.mapId === '001020000'), 'Mage transfer NPC is missing');
mage.script = {
  start: 'choose',
  nodes: {
    choose: { menu: { text: { zh: '请选择你想成为的职业。', en: 'Choose your profession.' }, options: [
      { index: 0, text: { zh: '法师', en: 'Magician' }, next: 'advance' },
    ] } },
    advance: { act: { kind: 'jobAdvance', fromJob: 0, job: 200, next: 'advanced' } },
    advanced: { say: { text: { zh: '转职成功！你现在是一名法师了。', en: 'Job advancement complete! You are now a Magician.' }, kind: 'ok' } },
  },
};
gameplay.compatibility.mageTransfer = 'User-requested Magician selection at 001020000 / Hans; not the original q1402 quest script.';
gameplay.compatibility.iceRuntime = 'P: Hans level30 shortcut 200->220, 5 initial book220 SP and 3 SP per later level; immediate multi-hit timing, five freeze layers with one layer change per cast/target, self-only Meditation and temporary teleport field execution. Source Skill values/art are TMS273.7; original transfer scripts and execution timing remain unverified.';
gameplay.compatibility.player='Initial attributes and base combat formula use the existing runtime adapter; they are not certified TMS273 server parity.';
const urls=new Set();
function collect(value) {
  if(typeof value==='string' && value.startsWith('/assets/')) { assert(value.startsWith('/assets/tms273/'),`Foreign asset: ${value}`);urls.add(value); }
  else if(value&&typeof value==='object')for(const child of Object.values(value))collect(child);
}
collect(manifest);
const appearance = read('appearance');
collect(appearance);
write(path.join(publicRoot,'assets/entry/appearance.json'),appearance);
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
write(path.join(root,'shared/mage-skills.json'),mageRules(read('skills')));
console.log(JSON.stringify({version,maps:maps.length,assets:urls.size,npcs:Object.keys(entities.npcs).length,monsters:Object.keys(entities.monsters).length}));
