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
const version = 'tms273-9';
const catalog = read('maps-rendered'), effects = read('effects'), entities = read('entities');
const avatar = read('avatar').avatar, gameplay = read('gameplay'), items = read('items');
const mageAvatar = read('mage-avatar');
Object.assign(avatar.actions, mageAvatar.actions);
for (const [key, actions] of Object.entries(mageAvatar.equipmentLoadouts)) Object.assign(avatar.equipmentLoadouts[key].actions, actions);
const windows = read('windows'), inventory = read('windows-inventory');
const emoticonExport = read('emoticon');
const maps = catalog.maps.map(map => ({...map, bgm:effects.bgm[map.id]}));
maps.forEach(require('./tms273_split_road.cjs').applySplitRoad);
// Map reactors are authored per map (Map.wz reactor subtree).  Each placement
// carries the source point plus the interaction box the *first* state declares,
// so the authoritative server can reject out-of-range hits without any client
// geometry, and the client can render the prop at its authored anchor.
{
  const reactor = read('reactor');
  const byMap = new Map();
  for (const placement of reactor.placements) {
    if (!byMap.has(placement.mapId)) byMap.set(placement.mapId, []);
    byMap.get(placement.mapId).push(placement);
  }
  for (const map of maps) {
    map.reactors = (byMap.get(map.id) ?? []).map(placement => {
      const template = reactor.templates[placement.templateId];
      assert(template, `Missing reactor template ${placement.templateId}`);
      // The last authored state is the "used up" empty state; the prop is
      // interactable for every state before it.
      const stateCount = Object.keys(template.states).length;
      const first = template.states['0'];
      const event = first?.events?.[0];
      return {
        id: placement.id,
        templateId: placement.templateId,
        x: placement.x,
        y: placement.y,
        flip: placement.flip,
        // Source seconds until the prop returns after being used up.
        reactorTime: placement.reactorTime,
        stateCount,
        // Type 9 reactors are clicked / bumped into, type 0 ones are hit with a
        // normal attack.  Both are server-decided; the client only sends intent.
        hitType: event?.type ?? 0,
        // Character-local interaction box (Reactor event lt/rb), authored for
        // the left-facing form exactly like the player attack hitbox.
        hitboxLt: event?.lt ?? null,
        hitboxRb: event?.rb ?? null,
      };
    });
  }
  assert(maps.reduce((sum,map)=>sum+map.reactors.length,0) === reactor.placements.length, 'Reactor placement export is stale');
}
const birth = maps.find(map => map.id === catalog.birthMapId);
assert(birth, 'Birth map absent');
assert(maps.length === JSON.parse(fs.readFileSync(path.join(root,'references/tms273-data/maps.json'),'utf8')).maps.length, 'Map export is stale');
assert.deepEqual(Object.keys(gameplay.sources.maps).sort(),maps.map(map=>map.id).sort(),'Gameplay export is stale');
const sourceQuests=JSON.parse(fs.readFileSync(path.join(root,'references/tms273-data/quests.json'),'utf8')).quests;
assert.deepEqual(gameplay.quests.map(q=>String(q.questId)).sort(),sourceQuests.map(q=>String(q.id)).sort(),'Quest export is stale');
const manifest = {
  schemaVersion:2, contentVersion:version,
  ...skillManifest(read('windows-skills'), read('skills')),
  bossEffects: read('boss-effects').bossEffects,
  npcQuestAvailable: read('npc-marker').npcQuestAvailable,
  skillEffects: Object.fromEntries(Object.entries(read('mage-effects').skillEffects).flatMap(([id, { levels, source, hidden, catalog, trigger, ...effects }]) => [
    [id, effects], ...Object.entries(levels ?? {}).map(([level, frames]) => [`${id}:${level}`, frames]),
  ])),
  skillSounds: Object.fromEntries(Object.entries(read('skill-sounds').skillSounds).map(([id, sounds]) => [id, { use: sounds.use, hit: sounds.hit, loop: sounds.nodes?.Loop, end: sounds.nodes?.End, special: sounds.nodes?.Special, summonAttack: sounds.nodes?.SummonedAttack1 }])),
  // P: choose the named LevelUp sequence; LevelUp2 is not proven to be an overlay.
  levelUp: { layers: [read('levelup').layers[0]], sound: read('levelup').sound },
  characterUi: read('character-ui').characterUi,
  characterLayout: read('character-ui').characterLayout,
  source:{gameVersion:'TMS273.7', parser:'scripts/tms273_wz.cjs'},
  avatar, map:birth, mapCatalog:{...catalog,maps},
  monsters:entities.monsters,npcs:entities.npcs,items:read('item-images'),
  hud:read('hud'),portals:read('portals'),combat:effects.combat,...windows,...inventory,chatUi:read('chat').chatUi,
  // Source-backed UI/ChatBalloon.img/0 used by PlayerView for map-chat bubbles
  // above speaking characters. PNGs are exported by export_tms273_balloon.cjs
  // and copied into client/public-tms273/assets.
  chatBalloon: read('balloon'),
  reactors: read('reactor'),
  // Source-backed UI/UIWindow.img/Trunk used by the account-warehouse window.
  // PNGs are exported by export_tms273_storage.cjs and copied into
  // client/public-tms273/assets alongside the other UI art.
  storageUi: read('storage'),
  // Source-backed UI/UIWindow.img/UserList (Party tab) used by the party
  // window.  PNGs are exported by export_tms273_party.cjs and copied into
  // client/public-tms273/assets alongside the other UI art.
  partyUi: read('party'),
  // Source-backed UI/UIWindow.img/UserList (Friend + BlackList tabs) used by
  // the friend window.  PNGs are exported by export_tms273_friend.cjs and
  // copied into client/public-tms273/assets alongside the other UI art.
  friendUi: read('friend'),
  // Source-backed UI/UIMap.img/MiniMap window plus one Map.wz miniMap canvas
  // per assembled map, used by the minimap window.  PNGs are exported by
  // export_tms273_minimap.cjs and copied into client/public-tms273/assets
  // alongside the other UI art.
  miniMap: read('minimap'),
  // Source-backed Map.wz WorldMap page art + UI/UIWindow2.img/WorldMap window
  // shell used by the world-map window.  PNGs are exported by
  // export_tms273_worldmap.cjs and copied into client/public-tms273/assets
  // alongside the other UI art.
  worldMap: read('worldmap'),
  // Source-backed UI/ChatEmoticon.img: the 表情 sticker catalogue (desc, 32x32
  // icon and the head animation frames) plus the 表情 window shell used by the
  // emoticon window.  PNGs are exported by export_tms273_emoticon.cjs and
  // copied into client/public-tms273/assets alongside the other UI art.
  emoticon: emoticonExport,
};
for(const id of Object.keys(items))assert(manifest.items[id],`Item image export is stale: ${id}`);
{
  const extra=read('combat-extra');
  Object.assign(manifest.combat,extra.combat);
  if(extra.avatarAttackSound?.url)manifest.avatar.attackSound=extra.avatarAttackSound.url;
  Object.assign(gameplay.player,{attackAfterMs:extra.attack.hitAtMs,attackLt:extra.attack.hitbox.lt,attackRb:extra.attack.hitbox.rb});
  if(extra.expTable?.length)gameplay.expTable=extra.expTable;
}
// Preserve same-version monster MP, boss flags and magic defense.
for (const monster of gameplay.monsters) {
  const raw = JSON.parse(fs.readFileSync(path.join(root, '参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW/Mob', monster.templateId.padStart(7, '0') + '.json'), 'utf8')).info;
  monster.maxMp = Number(raw.maxMP?._value ?? 0);
  monster.boss = Number(raw.boss?._value ?? 0) === 1;
  monster.mdRate = Number(raw.MDRate?._value ?? 0);
  assert(Number.isFinite(monster.mdRate) && monster.mdRate >= 0 && monster.mdRate <= 100);
  assert(Number.isSafeInteger(monster.maxMp) && monster.maxMp >= 0);
}
// P: temporary runnable level curve while TMS273's source EXP table is unavailable.
// P: level 200 permits every source Hyper level gate; replace with a verified EXP table.
if (!gameplay.expTable?.length) gameplay.expTable = Array.from({length: 200}, (_, i) => i === 199 ? 0 : 15 * (i + 1) ** 2);
gameplay.compatibility.experience = 'P: levels 1..199 need 15*level^2 EXP, level200 cap; each gained level grants 5 AP. Ordinary fourth-job SP stops at140; Hyper uses separate level-gated points. Not an official TMS273 EXP table.';
// ponytail: existing movement/basic-combat engine remains a compatibility adapter;
// replace these initial attributes only when verified 273 server rules are available.
gameplay.player={job:0,baseStr:12,baseDex:5,baseInt:4,baseLuk:4,weaponType:130,weaponWatk:items["1302000"].info.incPAD,
  mastery:0.1,maxHp:50,maxMp:5,climbSpeed:125,attackReach:88,attackHeight:62,
  attackAfterMs:450,contactInvulnerabilityMs:2000,...gameplay.player};
gameplay.contentVersion=version;
gameplay.compatibility.bossPractice = 'P: private level25 practice at source map102020500; no EXP, drops, quest credit or formal clear credit. T: source Boss3220000 HP7500, animation and attack timings. R: MobSkill112/113 are defense buffs,114 heals x. P: corresponding damage*85%, heal700 below80%HP, action order/gaps, circle attack2 and visual anchors. Blocked quests2813..2816 remain untouched; official spawn/rewards unknown.';
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
gameplay.compatibility.iceThirdRuntime = 'P: Hans level60 shortcut 220->221, 5 initial book221 SP, then 3 SP per level; existing points/story/saves preserved. Immediate ice hits and one movable or stationary sphere per player at 1080ms pulses; eight adaptation charges and persistent source cooldown. Original third-job scripts and execution timing are unavailable; skills, art and source values remain TMS273.7.';
gameplay.compatibility.beginnerRuntime = 'T: Skill/000.img and String/Skill.img define three beginner skills, max3, per-level MP/fixed damage/heal/speed/duration/cooldown. P: 5-second healing ticks inferred from source total and x; projectile reach/hit timing use the existing combat adapter. Buffs end on death/map exit/disconnect; skill levels, SP and cooldowns persist. Beginner SP follows the existing P 2..7 +1 rule. No shell item cost exists in the local skill source.';
gameplay.compatibility.iceFourthRuntime = 'P: level100 Hans shortcut 221->222 preserves story; 3 initial SP plus historical cross-region 101..140 tiers, fixed frost passive. Bind uses a single cast and source-limited hold; orb uses 4000ms/210ms and 180px/s with contact slowdown; Ice Demon pulses every1080ms alongside thunder sphere; Infinity restores base HP/MP and ramps damage every5s. These execution adapters are not original TMS scripts. Source skill values and artwork remain TMS273.7.';
gameplay.compatibility.player='Initial attributes and base combat formula use the existing runtime adapter; they are not certified TMS273 server parity.';
// Chat emoticons (表情貼圖).  The server only needs what it must *own*: the set
// of sendable sticker ids and the source's own send budget
// (UI/ChatEmoticon.img/ChatLimit) — never the artwork, which is presentation.
// Both values are facts about TMS273.7, so validation and rate limiting reuse
// them instead of inventing a list or a token bucket.
{
  assert(emoticonExport.stickers.length > 0, 'Emoticon export is empty');
  const ids = emoticonExport.stickers.map(sticker => sticker.id);
  assert.equal(new Set(ids).size, ids.length, 'Emoticon export has duplicate sticker ids');
  // `<groupId>:<sourceName>`, e.g. `1036:10360001`.  The colon matters: group
  // 1043 re-releases group 1036's stickers under the same authored node names.
  assert(ids.every(id => /^\d{4,8}:\d{4,12}$/.test(id)), 'Emoticon export has a malformed sticker id');
  gameplay.emoticons = {
    limit: {
      count: emoticonExport.limit.count,
      timeMs: emoticonExport.limit.timeMs,
      source: emoticonExport.limit.source,
    },
    ids,
    source: emoticonExport.contentVersion,
  };
  gameplay.compatibility.chatEmoticon = `T: sendable sticker ids, per-sticker animation frames, the send budget (${emoticonExport.limit.count} per ${emoticonExport.limit.timeMs}ms) and every window coordinate come from UI/ChatEmoticon.img. P: the window is scoped to the selected group (${emoticonExport.groups.length} groups over ${emoticonExport.pageCount} strip pages of ${emoticonExport.layout.groupCount} chips, ${emoticonExport.sheetCount} sticker sheets), the authored pageUp/pageDown buttons and the pageIcon dots drive the group strip because that is the row they are drawn on, the ${emoticonExport.layout.slotCount}-cell grid shows one group at a time, the second sheet of a group wider than that grid is reached with the up/down keys, and selecting a sticker sends it and leaves the window open. Bookmark tabs, the key-setting window, the save/edit mode and limited-time stickers are not implemented.`;
}
const questText = read('quest-text'), npcNames = read('npc-names');
require('./tms273_chapter.cjs').applyChapter(gameplay, items, manifest, read('chapter'), questText, npcNames);
// P: portal beams are exported from `maps-rendered.json` before the chapter
// adapter assigns routes, and scripted gates (WZ `tm: 999999999`) carry no
// target at that point.  Every gate that now leads to *another* map reuses the
// shared `pv/default` beam so scripted doorways (楓之港 `east00` → 碼頭,
// 弓箭手村 `Achter00` → 培訓中心, …) are visible like any type-2 gate.
// Same-map links (type 10 `bottom0`/`top0`) stay invisible on purpose.
{
  const beam = Object.values(manifest.portals)[0];
  assert(beam?.frames?.length, 'Missing shared portal beam');
  const assembled = new Set(maps.map(map => map.id));
  for (const map of maps) for (const portal of map.portals) {
    if (!portal.targetMapId || portal.targetMapId === map.id) continue;
    // Gates into maps that are not part of the current 41-map catalog stay
    // invisible; a beam there would advertise a route the player cannot take.
    if (!assembled.has(portal.targetMapId)) continue;
    const key = `${map.id}/${portal.name}`;
    if (manifest.portals[key]) continue;
    manifest.portals[key] = { ...beam, mapId: map.id, portalName: portal.name, type: portal.type, frames: beam.frames, frameDelay: beam.frameDelay };
  }
}
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
for(const [name,data] of Object.entries({gameplay,items,'quest-text':questText,'npc-names':npcNames,map:birth,maps:{birthMapId:birth.id,maps}})) {
  // Rendering layers belong to the client manifest, not the server's map catalog.
  const serverData=name==='map'?(({layers,...map})=>map)(data):name==='maps'?{...data,maps:data.maps.map(({layers,...map})=>map)}:data;
  write(path.join(root,'shared',name+'.json'),serverData);
  if(name==='gameplay'||name==='items')write(path.join(publicRoot,'assets',name+'.json'),data);
}
write(path.join(publicRoot,'assets/manifest.json'),manifest);
write(path.join(root,'shared/mage-skills.json'),mageRules(read('skills')));
console.log(JSON.stringify({version,maps:maps.length,assets:urls.size,npcs:Object.keys(entities.npcs).length,monsters:Object.keys(entities.monsters).length}));
