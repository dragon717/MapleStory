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
const version = 'tms273-16';
const catalog = read('maps-rendered'), effects = read('effects'), entities = read('entities');
const avatar = read('avatar').avatar, gameplay = read('gameplay'), items = read('items');
require('./tms273_creation_catalog.cjs')(
  JSON.parse(fs.readFileSync(path.join(root, 'shared/character-creation.json'), 'utf8')), items, 'export/items.json');
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
        // P drop table resolved from the template `action` script name.  A
        // reactor whose action has no known drop semantics ships `null` and
        // simply yields nothing when used up (see export_tms273_reactor.cjs).
        dropTable: template.drops ?? null,
      };
    });
  }
  assert(maps.reduce((sum,map)=>sum+map.reactors.length,0) === reactor.placements.length, 'Reactor placement export is stale');
}
const birth = maps.find(map => map.id === catalog.birthMapId);
assert(birth, 'Birth map absent');
assert(maps.length === JSON.parse(fs.readFileSync(path.join(root,'references/tms273-data/maps.json'),'utf8')).maps.length, 'Map export is stale');
// `returnMaps` is the per-map `info/returnMap` lookup a 回家卷軸 resolves
// against.  It is a catalog fact, not geometry, so it is asserted as a whole
// table: one entry per assembled map, always in the 9-digit form the server
// snapshot and the scroll handler speak.  A town outside this catalog is
// legal data (the archive has maps this build does not ship) — the scroll is
// refused at use time instead of teleporting into nothing.
const returnMaps = catalog.returnMaps ?? {};
assert.deepEqual(Object.keys(returnMaps).sort(), maps.map(map => map.id).sort(), 'returnMap export is stale');
for (const [mapId, townId] of Object.entries(returnMaps)) assert.match(townId, /^\d{9}$/, `returnMap target must be the 9-digit form: ${mapId} -> ${townId}`);
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
  // Source-backed TMS273 pets (Item/Pet + String/Pet.json): icon plus the
  // stand0/move/jump loops, keyed by pet item id.  PNGs are exported by
  // export_tms273_pet.cjs and copied into client/public-tms273/assets.
  pets: read('pet-images'),
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
  // Source-backed UI/StatusBar3.img/BuffSetting/favoriteBuff panel (the plate
  // behind the on-screen buff icons, with its authored 5 px icon spacing) plus
  // the authored quick-slot fold keys.  PNGs are exported by
  // export_tms273_buff.cjs and copied into client/public-tms273/assets
  // alongside the other UI art.
  buffUi: read('buff'),
  // Source-backed Map.wz WorldMap page art + UI/UIWindow2.img/WorldMap window
  // shell used by the world-map window.  PNGs are exported by
  // export_tms273_worldmap.cjs and copied into client/public-tms273/assets
  // alongside the other UI art.
  worldMap: read('worldmap'),
  petUi: read('pet-ui'),
  // Source-backed UI/CashShop.img window art (shell, the 11 sidebar tab
  // sprites whose highlight row encodes the active category, exit / buy /
  // magnifier buttons and the effect labels) used by the cash-shop window.
  // PNGs are exported by export_tms273_cashshop.cjs and copied into
  // client/public-tms273/assets alongside the other UI art.
  cashshopUi: read('cashshop').ui,
  // Source-backed per-item info/icon frames for every shippable cash-shop
  // commodity (a separate tree from the gameplay `items` icons so the two
  // catalogs never fight over one id space).
  cashItems: read('cashshop').itemIcons,
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
  // T: 1402「法師之路」(Quest.wz/QuestData/1402.img) gates the original first
  // transfer at `Check.0.lvmin = 10`.  The shortcut sits on the same floor, so
  // a level-4 beginner never reaches the profession menu — it used to be
  // offered at level 0 and the server granted the job.
  start: 'gate',
  nodes: {
    gate: { branch: { cond: { levelAtLeast: 10 }, then: 'choose', else: 'junior' } },
    junior: { say: { text: { zh: '转职需要达到10级。先去提升等级吧。', en: 'Job advancement requires level 10.' }, kind: 'ok' } },
    choose: { menu: { text: { zh: '请选择你想成为的职业。', en: 'Choose your profession.' }, options: [
      { index: 0, text: { zh: '法师', en: 'Magician' }, next: 'advance' },
    ] } },
    advance: { act: { kind: 'jobAdvance', fromJob: 0, job: 200, next: 'advanced' } },
    advanced: { say: { text: { zh: '转职成功！你现在是一名法师了。', en: 'Job advancement complete! You are now a Magician.' }, kind: 'ok' } },
  },
};
gameplay.compatibility.mageTransfer = 'User-requested Magician selection at 001020000 / Hans; not the original q1402 quest script. T: the level-10 floor matches 1402 Check.0.lvmin, so the shortcut is not looser than the quest path.';
gameplay.compatibility.iceRuntime = 'P: Hans level30 shortcut 200->220, 5 initial book220 SP and 3 SP per later level; immediate multi-hit timing, five freeze layers with one layer change per cast/target, self-only Meditation and temporary teleport field execution. Source Skill values/art are TMS273.7; original transfer scripts and execution timing remain unverified.';
gameplay.compatibility.iceThirdRuntime = 'P: Hans level60 shortcut 220->221, 5 initial book221 SP, then 3 SP per level; existing points/story/saves preserved. Immediate ice hits and one movable or stationary sphere per player at 1080ms pulses; eight adaptation charges and persistent source cooldown. Original third-job scripts and execution timing are unavailable; skills, art and source values remain TMS273.7.';
gameplay.compatibility.beginnerRuntime = 'T: Skill/000.img and String/Skill.img define three beginner skills, max3, per-level MP/fixed damage/heal/speed/duration/cooldown. P: 5-second healing ticks inferred from source total and x; projectile reach/hit timing use the existing combat adapter. Buffs end on death/map exit/disconnect; skill levels, SP and cooldowns persist. Beginner SP follows the existing P 2..7 +1 rule. No shell item cost exists in the local skill source.';
gameplay.compatibility.iceFourthRuntime = 'P: level100 Hans shortcut 221->222 preserves story; 3 initial SP plus historical cross-region 101..140 tiers, fixed frost passive. Bind uses a single cast and source-limited hold; orb uses 4000ms/210ms and 180px/s with contact slowdown; Ice Demon pulses every1080ms alongside thunder sphere; Infinity restores base HP/MP and ramps damage every5s. These execution adapters are not original TMS scripts. Source skill values and artwork remain TMS273.7.';
gameplay.compatibility.player='Initial attributes and base combat formula use the existing runtime adapter; they are not certified TMS273 server parity.';
// The minimap's repaired presentation boundaries: the MaxMap corner badge is
// the source's own `MapHelper.img/mark/<info/mapMark>` at the authored
// `vector:mapMark`; `BtNpc` opens the source's `npcList` window and picking a
// row marks that NPC with the source's `iconNavi`.
gameplay.compatibility.minimapUi = 'T: the corner badge, the npcList panel/rows geometry (listLT..listRB, 18 px pitch, vector:namePos), the close button states and the iconNavi pick marker are TMS273.7 art and vectors. P: the source\'s MaxMap/nw2 black "MINI MAP" title card is exported by the source but deliberately not painted (user-directed presentation, 2026-09-12) — the names keep their authored MaxMap vectors and sit on the corner shell; the local snapshot does not classify NPCs into the authored row flavours (icon/npc|eventnpc|shop|trunk|transport), so every row draws npc; the popup anchors below the window and its close button sits in the panel top-right corner (neither position is authored); row scrolling and the combo:Order sort are not implemented (12 rows fit the authored strip); BtFilter/BtTown/BtNavigation/BtDungeonMap belong to unimplemented features.';
// 傳送類消耗品 (map-move consumables).  The item side is source data
// (`Item/Consume` `spec.moveTo`), the destination side is source data
// (`Map.wz .../info/returnMap`), and the runtime only joins them.
{
  const moveItems = Object.entries(items).filter(([, item]) => item.spec && 'moveTo' in item.spec);
  assert(moveItems.length > 0, 'No map-move consumable is present in the item export');
  for (const [itemId, item] of moveItems) {
    const value = item.spec.moveTo;
    assert(Number.isInteger(value) && value > 0, `moveTo must be a positive integer: ${itemId}`);
  }
  gameplay.compatibility.returnScroll = 'T: `Item/Consume` spec.moveTo selects the map-move consumables (2030000 回家卷軸 sentinel 999999999, 2030001 維多利亞港卷軸 104000000, 2030002 魔法森林卷軸 101000000) and Map.wz info/returnMap is the town 2030000 targets. The runtime consumes one unit and lands the body on the destination map\'s authored `sp` spawn. P: the landing is a scroll\'s own arrival (no landing gate exists in the source item), and a town outside the assembled catalog is refused instead of being entered; field-limit rules that would forbid a scroll are not implemented.';
}
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
// 現金商店 (TMS273 Commodity.img)。  服务器只需要能**拥有购买**的最小事实：
// 分类、在售商品（SN 为购买键）与金额字段；美术与名称只属于客户端。
// 页签归属是 P 级推断（WZ 无逐商品页签字段，按 SN 组 + 物品家族映射），
// 排除的无美术在售条目数与原因记录在 excluded。
{
  const cashshop = read('cashshop');
  assert(cashshop.commodities.length > 500, 'Cash-shop export is stale');
  assert(cashshop.categories.length === 8, 'Cash-shop category table drifted');
  const sns = new Set(cashshop.commodities.map(entry => entry.sn));
  assert.equal(sns.size, cashshop.commodities.length, 'Cash-shop export has duplicate SNs');
  for (const entry of cashshop.commodities) {
    assert(entry.count >= 1 && entry.price >= 0, `Cash-shop row is malformed: ${entry.sn}`);
    // SN is an opaque purchase key; the source mixes 8- and 9-digit forms
    // (92000000 vs 92001703), so only "all digits" is a contract.
    assert(/^\d{8,9}$/.test(entry.sn), `Cash-shop SN must be numeric: ${entry.sn}`);
    assert(/^\d{8}$/.test(entry.itemId), `Cash-shop itemId must be 8 digits: ${entry.sn}`);
  }
  gameplay.compatibility.cashShop = `T: commodities come from Etc/Commodity.img with OnSale=1 only (${cashshop.commodities.length} of 12617 rows; SN 900 楓點充值 / SN 910 楓幣兌換 / SN 800 兌換券 carry no local purchase path and are skipped; ${cashshop.excluded.length} on-sale rows reference items whose art left the client pack and are excluded, see cashshop.json excluded). Window art, sidebar tab sprites and per-item icons are TMS273.7. P: the WZ has no per-commodity tab field — the main tab is derived from the SN group plus an item-family fallback, so tab placement is an inference, not a source fact; 時裝 sub-tabs reuse the equip family table; no gift, wishlist, mileage, coupon, avatar-preview or locker feature exists; the balance is a local P field (no real charging), topped up only through the GM /cash command.`;
  gameplay.cashShop = {
    contentVersion: cashshop.contentVersion,
    categories: cashshop.categories,
    commodities: cashshop.commodities,
  };
}
const questText = read('quest-text'), npcNames = read('npc-names');
require('./tms273_chapter.cjs').applyChapter(gameplay, items, manifest, read('chapter'), questText, npcNames);
// 36314 之后的后续章节：按 TMS273.7 Quest.wz 源补齐运行时规格，并逐条登记
// 不可执行边界（脚本体缺失）。放在章节适配之后，避免与开场/续章路线冲突。
const remaster = require('./tms273_remaster.cjs').applyRemaster(gameplay, items, manifest, questText);
assert.equal(remaster.total, 55, '后续章节任务数量与源盘点不一致');
// P: portal beams are exported from `maps-rendered.json` before the chapter
// adapter assigns routes, and scripted gates (WZ `tm: 999999999`) carry no
// target at that point.  Every gate that now leads to *another* map reuses the
// shared `pv/default` beam so scripted doorways (楓之港 `east00` → 碼頭,
// 弓箭手村 `Achter00` → 培訓中心, …) are visible like any type-2 gate.
// Same-map links (type 10 `bottom0`/`top0`) stay invisible on purpose.
// Only types the client actually draws with `pv` art may carry that beam —
// see `scripts/tms273_portal_sprite.cjs` for the WZ evidence.  Collision gates
// (type 3) are invisible in game, so beaming them invented the two stacked
// beams on 六條岔道's tree (`top00`/`top01`) that the user reported.
{
  const { beamSpriteForType, portalTypeCode } = require('./tms273_portal_sprite.cjs');
  const beam = Object.values(manifest.portals)[0];
  assert(beam?.frames?.length, 'Missing shared portal beam');
  const assembled = new Set(maps.map(map => map.id));
  for (const map of maps) for (const portal of map.portals) {
    if (!portal.targetMapId || portal.targetMapId === map.id) continue;
    // Gates into maps that are not part of the assembled catalog stay
    // invisible; a beam there would advertise a route the player cannot take.
    if (!assembled.has(portal.targetMapId)) continue;
    // `pt: 3` is the collision family (`pc`): the client only has editor art
    // for it, so it draws nothing.  The gate still works on touch.
    if (beamSpriteForType(portal.type) !== 'pv') continue;
    const key = `${map.id}/${portal.name}`;
    const exported = manifest.portals[key];
    if (exported) {
      // `export_tms273.cjs portals` already wrote this one straight from the WZ
      // `tm` route; keep it, but never let a stale entry change the type.
      assert.equal(exported.type, portal.type, `Stale beam type for ${key}: export ${portalTypeCode(exported.type)} vs catalog ${portalTypeCode(portal.type)}`);
      continue;
    }
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
for(const [name,data] of Object.entries({gameplay,items,'quest-text':questText,'npc-names':npcNames,map:birth,maps:{birthMapId:birth.id,returnMaps,maps}})) {
  // Rendering layers belong to the client manifest, not the server's map catalog.
  const serverData=name==='map'?(({layers,...map})=>map)(data):name==='maps'?{...data,maps:data.maps.map(({layers,...map})=>map)}:data;
  write(path.join(root,'shared',name+'.json'),serverData);
  if(name==='gameplay'||name==='items')write(path.join(publicRoot,'assets',name+'.json'),data);
}
// Client cash-shop catalog: same commodities as gameplay.cashShop plus the zh
// display names (the server has no use for them, so they stay client-side).
{
  const cashshop = read('cashshop');
  write(path.join(publicRoot,'assets/cashshop.json'), {
    contentVersion: cashshop.contentVersion,
    categories: cashshop.categories,
    commodities: cashshop.commodities,
    itemNames: cashshop.itemNames,
  });
}
write(path.join(publicRoot,'assets/manifest.json'),manifest);
write(path.join(root,'shared/mage-skills.json'),mageRules(read('skills')));
console.log(JSON.stringify({version,maps:maps.length,assets:urls.size,npcs:Object.keys(entities.npcs).length,monsters:Object.keys(entities.monsters).length}));
