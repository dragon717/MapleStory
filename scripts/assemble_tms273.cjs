// Assemble the active runtime only after every exported component is present.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { skillManifest, mageRules } = require('./tms273_skill_manifest.cjs');
const { assertNoConflictCopyName } = require('./check_icloud_conflict_copies.cjs');
const root = path.resolve(__dirname, '..');
const input = path.join(root, 'resources/tms273-export');
const publicRoot = path.join(root, 'client/public-tms273');
const read = name => JSON.parse(fs.readFileSync(path.join(input, name + '.json'), 'utf8'));
// ServeDir chooses a compressed sibling without checking its freshness. Never
// leave yesterday's JSON in front of today's poses or manifest after assembly.
const invalidateCompressed = file => { for (const ext of ['.br', '.gz']) fs.rmSync(file + ext, { force: true }); };
const write = (file, value) => { invalidateCompressed(file); fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, JSON.stringify(value) + '\n', 'utf8'); };
const version = 'tms273-44';
const catalog = read('maps-rendered'), effects = read('effects'), entities = read('entities');
const avatar = read('avatar').avatar, gameplay = read('gameplay'), items = read('items');
const cashshop = read('cashshop');
// Cash equipment is also inventory/persistence data, not just a shop icon.
// Keep both forms readable for purchases saved by the first shop build.
for (const [id, definition] of Object.entries(cashshop.itemDefinitions ?? {})) {
  const canonical = String(Number(id));
  items[canonical] ??= definition;
  items[canonical.padStart(8, '0')] ??= items[canonical];
}
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
  // 骑宠 `info/icon` 帧表（`export_tms273_mount_icons.cjs` → mount-images.json）。
  // 与 pets 同构：目录（名字/槽位/骑行数值）在 `shared/mounts.json`，这里只放帧。
  // 坐骑不在 `items.json` 里，所以 inventory 的图标查找链必须是
  // `items → pets → mounts`（见 client/src/features/inventory/view.ts）。
  mounts: read('mount-images'),
  rideScenes: read('ride-scenes'),
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
  keybindingsUi: (() => {
    const data = read('keybindings').windows;
    const source = data.statusKeyConfig.children;
    const custom = data.customDefaultKeyConfig.children;
    const buttons = {};
    for (const name of ['button:close', 'button:presetSave', 'button:presetUndo']) {
      for (const [state, entry] of Object.entries(custom[name].children)) {
        const frame = entry.children?.['0']?.frame;
        if (frame) buttons[`${name}/${state}/0`] = frame;
      }
    }
    return {
      source: 'UI/StatusBar3.img/CustomDefaultKeyConfig',
      background: custom.backgrnd.frame,
      keyPositions: source.keyPos.values,
      keys: Object.fromEntries(Object.entries(source.key.children).filter(([, value]) => value.frame).map(([key, value]) => [key, value.frame])),
      buttons,
    };
  })(),
  // Source-backed Map.wz WorldMap page art + UI/UIWindow2.img/WorldMap window
  // shell used by the world-map window.  PNGs are exported by
  // export_tms273_worldmap.cjs and copied into client/public-tms273/assets
  // alongside the other UI art.
  worldMap: read('worldmap'),
  petUi: read('pet-ui'),
  // Source-backed 怪物收藏 / 物品圖鑑 window (UI/UIWindow4.img).  PNGs are
  // exported by export_tms273_collection.cjs and copied into
  // client/public-tms273/assets alongside the other UI art.  The catalogue and
  // the rule tables that go with it are generated further down, once the item
  // tree is final.
  notebook: (() => {
    const { contentVersion, source, panels, states, menu, frames, values } = read('notebook');
    return { contentVersion, source, panels, states, menu, frames, values };
  })(),
  // Source-backed UI/CashShop.img window art (shell, the 11 sidebar tab
  // sprites whose highlight row encodes the active category, exit / buy /
  // magnifier buttons and the effect labels) used by the cash-shop window.
  // PNGs are exported by export_tms273_cashshop.cjs and copied into
  // client/public-tms273/assets alongside the other UI art.
  cashshopUi: cashshop.ui,
  // Source-backed per-item info/icon frames for every shippable cash-shop
  // commodity (a separate tree from the gameplay `items` icons so the two
  // catalogs never fight over one id space).
  cashItems: cashshop.itemIcons,
  // Source-backed UI/ChatEmoticon.img: the 表情 sticker catalogue (desc, 32x32
  // icon and the head animation frames) plus the 表情 window shell used by the
  // emoticon window.  PNGs are exported by export_tms273_emoticon.cjs and
  // copied into client/public-tms273/assets alongside the other UI art.
  emoticon: emoticonExport,
};
for (const [id, frame] of Object.entries(cashshop.itemIcons)) {
  const canonical = String(Number(id));
  manifest.items[canonical] ??= frame;
  manifest.items[canonical.padStart(8, '0')] ??= frame;
  if (manifest.pets[canonical]) manifest.pets[canonical.padStart(8, '0')] ??= manifest.pets[canonical];
}
// Every item surface (bag, equipment, storage, drops and hotkeys) reads this
// table. Special catalogues must not depend on one window's icon fallback.
for (const [id, frame] of Object.entries({ ...manifest.mounts, ...read('chair-images') })) {
  const canonical = String(Number(id));
  manifest.items[canonical] = frame;
  manifest.items[canonical.padStart(8, '0')] = frame;
}
for(const id of Object.keys(items))assert(manifest.items[id],`Item image export is stale: ${id}`);
{
  const extra=read('combat-extra');
  Object.assign(manifest.combat,extra.combat);
  if(extra.avatarAttackSound?.url)manifest.avatar.attackSound=extra.avatarAttackSound.url;
  Object.assign(gameplay.player,{attackAfterMs:extra.attack.hitAtMs,attackLt:extra.attack.hitbox.lt,attackRb:extra.attack.hitbox.rb});
  if(extra.expTable?.length)gameplay.expTable=extra.expTable;
}
// 楓之島災禍篇 36315 的最小场景执行：把已核定的击杀目标 8645261 放到一张已装配
// 且从出生图可达的地图上（P，依据与边界见 scripts/tms273_calamity.cjs）。
// 必须早于下面的怪物收尾循环，让新模板一并补齐 maxMp/boss/mdRate。
const calamity = require('./tms273_calamity.cjs').applyCalamity(gameplay, manifest);
assert.equal(calamity.placed, 1, '災禍篇场景执行数量与来源记录不一致');
// Preserve same-version monster MP, boss flags and magic defense.
for (const monster of gameplay.monsters) {
  const raw = JSON.parse(fs.readFileSync(path.join(root, '参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW/Mob', monster.templateId.padStart(7, '0') + '.json'), 'utf8')).info;
  monster.maxMp = Number(raw.maxMP?._value ?? 0);
  monster.boss = Number(raw.boss?._value ?? 0) === 1;
  monster.mdRate = Number(raw.MDRate?._value ?? 0);
  assert(Number.isFinite(monster.mdRate) && monster.mdRate >= 0 && monster.mdRate <= 100);
  assert(Number.isSafeInteger(monster.maxMp) && monster.maxMp >= 0);
  // 击退阈值只从生成器导入，装配器这边**只断言不自算**（换算口径只许一处定义）。
  // 缺这一格 = 导出树是旧的：服务端读到的永远是推不动，而且没有任何别的门禁会发现
  // ——`pushed` 没有参与任何数值，少它不会让任何既有断言变红。
  assert(raw.pushed?._value !== undefined, `monster ${monster.templateId} 的源有 info/pushed，导出树却少这一格（导出树过期，重跑生成器）`);
  assert(Number.isSafeInteger(monster.pushed), `monster ${monster.templateId} 的 pushed 必须是整数`);
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
// User-requested shortcut (2026-09-08), separate from the missing original quest
// scripts.  Widened from Magician-only to all four Explorer lines (2026-09-22):
// the source's 1401/1403/1404 are `executable:false` here (their original
// script counters are not in the export), so before this the three physical
// lines had no first transfer at all — and a job-advance trial can only fire
// for a character whose job already equals its `fromJob`, so their whole
// second/third/fourth chain was unreachable no matter how complete the config
// looked.  Callers that need the reachability contract: the two "this route
// can carry you" assertions in `check_tms273_job_advance.cjs`.
const crossroad = gameplay.npcs.find(npc => npc.templateId === '10201');
assert(crossroad && gameplay.npcSpawns.some(npc => npc.id === '001020000-life-1' && npc.templateId === '10201' && npc.mapId === '001020000'), 'Crossroad transfer NPC is missing');
// T: 1401/1402/1403/1404「…之路」(Quest.wz/QuestData) all gate the original
// first transfer at `Check.0.lvmin = 10`.  The shortcut sits on the same floor,
// so a level-4 beginner never reaches the profession menu — it used to be
// offered at level 0 and the server granted the job.  The mage keeps a
// user-requested level-8 exception through the 1402 quest path only
// (`auth::FIRST_MAGE_JOB_LEVEL`); this menu is level-10 for every line.
// Ordering is the menu order the player sees; indices must stay contiguous.
const FIRST_JOBS = [
  { job: 100, zh: '剑士', en: 'Warrior' },
  { job: 200, zh: '法师', en: 'Magician' },
  { job: 300, zh: '弓箭手', en: 'Bowman' },
  { job: 400, zh: '飞侠', en: 'Rogue' },
];
crossroad.script = {
  start: 'gate',
  nodes: {
    gate: { branch: { cond: { levelAtLeast: 10 }, then: 'choose', else: 'junior' } },
    junior: { say: { text: { zh: '转职需要达到10级。先去提升等级吧。', en: 'Job advancement requires level 10.' }, kind: 'ok' } },
    choose: { menu: { text: { zh: '请选择你想成为的职业。', en: 'Choose your profession.' }, options:
      FIRST_JOBS.map(({ job, zh, en }, index) => ({ index, text: { zh, en }, next: `advance-${job}` })) } },
    ...Object.fromEntries(FIRST_JOBS.flatMap(({ job, zh, en }) => [
      [`advance-${job}`, { act: { kind: 'jobAdvance', fromJob: 0, job, next: `advanced-${job}` } }],
      [`advanced-${job}`, { say: { text: { zh: `转职成功！你现在是一名${zh}了。`, en: `Job advancement complete! You are now a ${en}.` }, kind: 'ok' } }],
    ])),
  },
};
gameplay.compatibility.firstJobTransfer = 'User-requested profession selection at 001020000 / Hans for all four Explorer lines (Magician since 2026-09-08; Warrior/Bowman/Rogue since 2026-09-22); not the original q1401/q1402/q1403/q1404 quest scripts, whose executable bodies are absent from the local export. T: the level-10 floor matches Check.0.lvmin of all four source quests, so the shortcut is nowhere looser than the quest path. P: 5 starter points in the new first-job book, mirroring the mage grant; the companion hidden skills and the 100 MP floor stay mage-only because no source field authorizes them for the physical lines, and no physical skill path spends MP today.';
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
  for (const frame of [...Object.values(cashshop.ui), ...Object.values(cashshop.itemIcons)]) {
    assert(frame.url.startsWith('/assets/tms273/'), `Cash-shop asset would not be copied: ${frame.url}`);
  }
  const sns = new Set(cashshop.commodities.map(entry => entry.sn));
  assert.equal(sns.size, cashshop.commodities.length, 'Cash-shop export has duplicate SNs');
  for (const entry of cashshop.commodities) {
    assert(entry.count >= 1 && entry.price >= 0, `Cash-shop row is malformed: ${entry.sn}`);
    assert(cashshop.itemIcons[entry.itemId], `Cash-shop item has no icon: ${entry.itemId}`);
    // The islot contract binds character equipment only: pet gear (180/190/194)
    // ships without an islot on the cash tab by design (see export_tms273_cashshop.cjs).
    if (Number(entry.itemId) < 2_000_000 && items[entry.itemId]?.inventoryType === 1) {
      assert(items[entry.itemId]?.info?.islot, `Cash equipment has no source slot: ${entry.itemId}`);
    }
    // SN is an opaque purchase key; the source mixes 8- and 9-digit forms
    // (92000000 vs 92001703), so only "all digits" is a contract.
    assert(/^\d{8,9}$/.test(entry.sn), `Cash-shop SN must be numeric: ${entry.sn}`);
    assert(/^\d{8}$/.test(entry.itemId), `Cash-shop itemId must be 8 digits: ${entry.sn}`);
  }
  gameplay.compatibility.cashShop = `T: ${cashshop.commodities.length} sellable entries are derived from TMS273.7 Etc/Commodity.img OnSale rows; UI/CashShop.img, item names, icons and item definitions use the same client version. ${cashshop.excluded.length} exclusions and their exact reasons are recorded in cashshop.json (missing art or unsupported local service/pet-equipment mechanics, not presumed retired items). P: category placement is inferred from SN groups and item families; the four 911xxxx inventory expansion services deliver the existing 2430768–2430771 coupons with sourceItemId/deliveryRule retained. Avatar preview and world characters share source-backed appearance composition. Gift, wishlist, mileage redemption and cash locker mechanics remain unavailable. The local cash balance is granted through GM /cash, without a real charging service.`;
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
// 冒险笔记（图鉴）。  Catalogue + rules are generated *here* and not in
// `build_tms273.cjs`, because the item tree is only final at this point: the
// chapter and remaster adapters above inject their own items, and the cash-shop
// definitions were folded in at the top of this file.  Running the generator
// earlier classifies those items as absent, which is silently wrong rather
// than loudly broken.
//
// `shared/notebook-catalog.json` is the "what exists" half the server loads;
// `shared/monster-collection-rules.json` is the "what it means" half, and its
// every rule the same-version source cannot prove stays `unverified` with the
// reason written out.  Nothing here fills in a probability, a slot count or a
// completion condition.
{
  const notebook = read('notebook');
  const { buildCatalog } = require('./generate_tms273_notebook_catalog.cjs');
  // 骑宠（`Character/TamingMob/*`）不在 `items` 里——那份是可获得分母，
  // 塞进去会改动分母（见 `server/src/inventory.rs::shipped_mounts`）。
  // 它们单独成表，而且**按源 `islot` 再分成两页**：`Tm` = 骑宠、`Sd` = 鞍具。
  const shippedMounts = JSON.parse(fs.readFileSync(path.join(root, 'shared/mounts.json'), 'utf8')).items;
  const { catalog, rules } = buildCatalog({
    notebook,
    items,
    mounts: shippedMounts,
    // 椅子同族：`shared/chairs.json`（源 `Item/Install/0301*`、`0302`）。物品树里
    // 只带着那一件真的进商店的椅子，剩下的 2798 件只存在于这张表，因此它们也
    // 只归椅子页——留在物品页会让同一件东西属于两个分区。
    chairs: JSON.parse(fs.readFileSync(path.join(root, 'shared/chairs.json'), 'utf8')).items,
    gameplay,
    creation: JSON.parse(fs.readFileSync(path.join(root, 'shared/character-creation.json'), 'utf8')),
  });
  // 骑宠／鞍具的拆分要**双向**核：合起来仍是坐骑表的键集（拆错不会静默丢件），
  // 而且每一件都落在源字段说的那一侧（只看「加起来对」会让「全塞进骑宠页」也过）。
  assert.deepEqual(
    [...Object.keys(catalog.mounts), ...Object.keys(catalog.saddles)].sort(),
    Object.keys(shippedMounts).sort(),
    '骑宠与鞍具两个分区合起来必须正好是 shared/mounts.json 的键集');
  assert(catalog.mountCount > 0 && catalog.saddleCount > 0, '骑宠与鞍具两侧都不能为空');
  for (const [id, saddle] of Object.entries(catalog.saddles)) {
    assert.equal(saddle.equipmentSlot, 'Sd', `鞍具 ${id} 的源槽位不是 Sd`);
  }
  for (const [id, mount] of Object.entries(catalog.mounts)) {
    assert.notEqual(mount.equipmentSlot, 'Sd', `骑宠 ${id} 实际是鞍具（源槽位 Sd）`);
  }
  assert.equal(rules.registration.mode, 'unverified', '正式内容不得携带伪造的登记概率');
  assert.equal(rules.exploration.slotCount, null, '正式内容不得携带未经核定的探险槽位');
  assert.equal(manifest.notebook.menu.type, 22, '图鉴入口必须仍是原「怪物收藏」菜单项');
  assert.deepEqual(
    Object.keys(catalog.monsterStructure.rows).sort(),
    notebook.collection.regions.flatMap(region => region.pages.flatMap(page => page.rows.map(row => `mc-${region.region}-${page.page}-${row.row}`))).sort(),
    '图鉴行目录与导出的收藏源不一致');
  // The authored reward set has to agree with the item tree in both directions:
  // a key the client ships a definition for must have been imported, and a key
  // it does not must not have been invented.  A mismatch here means the reward
  // backfill did not run (or ran before the collection export) — a build-order
  // bug, not a source boundary.
  for (const reward of Object.values(catalog.rewardItems)) {
    assert.equal(
      reward.inItemIndex,
      reward.definitionStatus === 'json-present',
      `奖励物品 ${reward.itemId} 与物品目录不一致（源定义 ${reward.definitionStatus}，目录内 ${reward.inItemIndex}）：请检查 scripts/backfill_tms273_notebook_rewards.py 的执行顺序`);
  }
  write(path.join(root, 'shared/notebook-catalog.json'), catalog);
  write(path.join(root, 'shared/monster-collection-rules.json'), rules);
  // The client projection is the *public* half of the catalogue only.  The
  // quest section is deliberately withheld: the task page is computed on the
  // server from what the character actually obtained, so shipping the static
  // list here would hand the client rows it must never render (plan §12.2).
  assert(catalog.sections.quest.length > 0, '任务道具分区为空');
  const clientSections = Object.fromEntries(Object.entries(catalog.sections).filter(([key]) => key !== 'quest'));
  write(path.join(publicRoot, 'assets/notebook.json'), {
    catalogVersion: catalog.catalogVersion,
    contentVersion: catalog.contentVersion,
    sections: clientSections,
    items: Object.fromEntries(Object.entries(catalog.items).map(([id, item]) => [id, {
      inventoryType: item.inventoryType,
      equipmentSlot: item.equipmentSlot,
      isPet: item.isPet,
      availability: item.availability,
      questIds: item.questIds,
    }])),
    // 骑宠分区：名字与图标归 `mount-index.json` / 素材表，这里只带「它是哪一档坐骑」。
    mounts: Object.fromEntries(Object.entries(catalog.mounts).map(([id, mount]) => [id, {
      tamingMob: mount.tamingMob,
      reqLevel: mount.reqLevel,
      availability: mount.availability,
    }])),
    // 鞍具分区：同族但**没有** `tamingMob`（源没给，它不是坐骑），所以这里也不带
    // 这一栏——客户端只显示服务器与目录都认得的字段，不替源补一个空档位。
    saddles: Object.fromEntries(Object.entries(catalog.saddles).map(([id, saddle]) => [id, {
      reqLevel: saddle.reqLevel,
      availability: saddle.availability,
    }])),
    // 椅子分区：名字与图标归 `chair-names.json` / 素材表，这里只带恢复量与
    // 间隔（间隔缺席＝源未核定，不替源编一个）。
    chairs: Object.fromEntries(Object.entries(catalog.chairs).map(([id, chair]) => [id, {
      recoveryHP: chair.recoveryHP,
      recoveryMP: chair.recoveryMP,
      recoveryIntervalMs: chair.recoveryIntervalMs,
      availability: chair.availability,
    }])),
    monsterStructure: catalog.monsterStructure,
    monsterEntries: Object.fromEntries(Object.entries(catalog.monsterEntries).map(([id, entry]) => [id, {
      monsterTemplateId: entry.monsterTemplateId,
      rowKey: entry.rowKey,
      slot: entry.slot,
      sourceType: entry.sourceType,
      collectable: entry.collectable,
      hasEpisode: entry.hasEpisode,
    }])),
    monsterText: catalog.monsterText,
    collectableEntryCount: catalog.collectableEntryCount,
    // The authored rewards the window has to *name*, even when this build
    // cannot hand the item out: the source pays 方塊椅子 that the TMS273
    // client ships no definition for, and a row whose reward is invisible is
    // worse than one shown as "this version cannot deliver it".  An item with
    // a catalogue entry of its own is referenced, never copied — the window
    // reads its name and icon from `assets/items.json`.
    rewardItems: Object.fromEntries(Object.entries(catalog.rewardItems).map(([id, reward]) => [id, {
      roles: reward.roles,
      referenceCounts: reward.referenceCounts,
      definitionStatus: reward.definitionStatus,
      definitionAvailable: reward.definitionAvailable,
      // Only a reward with no catalogue entry carries its own text (resolved
      // from the same-version String table); everything else is a reference.
      name: reward.name,
      nameSource: reward.nameSource,
      reason: reward.reason,
    }])),
    // Which original mechanics this build cannot run, in the words the server
    // also uses.  The window shows these instead of inventing a number.
    status: {
      registration: rules.registration.mode,
      registrationReason: rules.registration.blockedReason,
      rewardCondition: rules.rewards.row.mode,
      rewardReason: rules.rewards.row.blockedReason,
      rewardItemAvailability: rules.rewards.itemAvailability.mode,
      rewardItemReason: rules.rewards.itemAvailability.blockedReason,
      rewardItemCounts: {
        deliverable: rules.rewards.itemAvailability.deliverableCount,
        definitionMissing: rules.rewards.itemAvailability.definitionMissingCount,
      },
      exploration: rules.exploration.mode,
      explorationReason: rules.exploration.blockedReason,
      sourceType: rules.sourceType.mode,
    },
  });
  gameplay.compatibility.notebook = `T: the window shell, its button states, the grid furniture, the grade marks and every vector come from TMS273.7 UI/UIWindow4.img (monsterCollection + itemCollection); the collection's region/page/row/slot structure, per-row recordID/rewardID/exploration cycle and per-slot monster id come from Etc/mobCollection.img; per-monster text, authored spawn maps and authored reward items come from String/MonsterBook.img. ${catalog.itemDefinitionCount} item templates are classified from the assembled item catalogue (${catalog.aliasDedupe.deduped} seven/eight-digit aliases deduped), and the menu entry is source entry ${manifest.notebook.menu.key} (type ${manifest.notebook.menu.type}) renamed only in the localised label. U: the source authors no registration probability, qualification gate, per-slot grade, reward completion condition, exploration slot count or daily limit, so ${rules.registration.mode} stays the production mode and the registration/reward/exploration paths report a blocked reason rather than a made-up number. P: the collection is account-scoped and the item records are character-scoped; the "collectable today" denominator is the deployed monster templates.`;
  console.log(JSON.stringify({ notebook: { items: catalog.itemDefinitionCount, mounts: catalog.mountCount, saddles: catalog.saddleCount, chairs: catalog.chairCount, monsterEntries: catalog.monsterEntryCount, rows: Object.keys(catalog.monsterStructure.rows).length, rewards: catalog.rewardItemCount, rewardDefinitionMissing: catalog.definitionMissingRewardCount, registration: rules.registration.mode } }));
}
const urls=new Set();
function collect(value) {
  if(typeof value==='string' && value.startsWith('/assets/')) { assert(value.startsWith('/assets/tms273/'),`Foreign asset: ${value}`);urls.add(value); }
  else if(value&&typeof value==='object')for(const child of Object.values(value))collect(child);
}
collect(manifest);
for (const group of [manifest.rideScenes.mounts, manifest.rideScenes.chairs]) {
  for (const [id, entry] of Object.entries(group)) {
    if (!entry.url) continue;
    const scene = JSON.parse(fs.readFileSync(path.join(input, entry.url.slice(1)), 'utf8'));
    assert.equal(Number(scene.itemId), Number(id), `Ride scene binding mismatch: ${entry.url}`);
    collect(scene);
  }
}
const appearance = read('appearance');
// A valid inventory definition alone is not a renderable paper-doll item.
// Fail assembly before deployment if a playable ordinary layer was omitted.
// Po（口袋）、Tm（图腾，源在 Character/Mechanic）、Ri（戒指，源在
// Character/Ring）与 Pe（吊坠）/Me（勋章）/Ba+Be（徽章，两种拼写在
// TMS273 Accessory 并存；四个家族在源目录全部 info-only，无纸娃娃
// Canvas——2026-09-15 全目录核验）按设计没有纸娃娃层，导出器与这里
// 共用同一份豁免。
const NON_DOLL_ISLOTS = ['Po', 'Tm', 'Ri', 'Pe', 'Me', 'Ba', 'Be'];
// 源包分卷被裁剪（见 `scripts/audit_tms273_source_volumes.cjs`：`Weapon_000.wz` /
// `Pants_000.wz` 等 6 个分卷缺席），这些件的像素只剩 `_Canvas` 镜像、结构属性读不出来，
// **合成不出**纸娃娃层。`export_tms273_avatar_parts.cjs --gap-fill` 逐条带 id/映像/原因
// 记录在 `cashAppearance.unrenderableEquipment`，这里据此放行——判据来自导出产物，
// 不是手写清单。件一旦变得可合成，记录就会消失，这里就重新要求它。
const unrenderable = new Map((appearance.cashAppearance?.unrenderableEquipment ?? [])
  .map(entry => [String(Number(entry.itemId)), entry]));
for (const [id, entry] of unrenderable) {
  assert(items[id], `不可合成件登记了、却不在物品目录里: ${id}`);
  assert(!appearance.layers[id] && !appearance.cashAppearance?.items?.[id.padStart(8, '0')],
    `件 ${id} 已经可以合成出外观层，应从 unrenderableEquipment 中移除（${entry.image ?? entry.reason ?? ''}）`);
  assert(entry.reason, `不可合成件 ${id} 必须带上原因，不能只登记 id`);
}
for (const [id, definition] of Object.entries(items)) {
  const info = definition.info;
  if (!info?.islot || info.cash === 1 || NON_DOLL_ISLOTS.includes(info.islot)) continue;
  if (unrenderable.has(String(Number(id)))) continue;
  const layer = appearance.layers[String(Number(id))];
  const entry = appearance.cashAppearance?.items[String(id).padStart(8, '0')];
  assert(layer || entry, `Missing ordinary equipment appearance: ${id}`);
}
collect(appearance);
// The first-screen catalogue contains only an index; copy each selected
// item's JSON and its textures without putting them in the initial preload.
// 教训（2026-09-18）：`entry.url` 指向的就是那件装备自己的外观 JSON，它和
// layer 里的贴图一样是运行期要 fetch 的产物。这里原先只 `collect(layer)`，
// 索引 JSON 从未进入复制清单——于是它们能否出现在 client/public-tms273 全靠
// 手工拷贝，漏了 20 个（01004230/01040063/…/01482011）也无人察觉，直到
// Windows 打包门禁按 appearance.json 的引用逐条校验才炸。索引 JSON 必须和
// 贴图一起由这份清单派生，两者不能有两种来源。
for (const entry of Object.values(appearance.cashAppearance?.items ?? {})) {
  assert(entry.url.startsWith('/assets/tms273/'), `Invalid cash appearance URL: ${entry.url}`);
  collect(entry.url);
  const layer = JSON.parse(fs.readFileSync(path.join(input, entry.url.slice(1)), 'utf8'));
  assert.equal(Number(layer.itemId ?? layer.id), Number(entry.itemId), `Cash appearance binding mismatch: ${entry.itemId}`);
  collect(layer);
}
write(path.join(publicRoot,'assets/entry/appearance.json'),appearance);
// resources/tms273-export 是 .gitignore 覆盖的本地导出树，所以 check_icloud_conflict_copies.cjs
// 在 pre-commit 里看不到它——而这里正是副本泄漏进受控树的入口：源侧一个
// 「xxx 2.png」被清单引用后，就被原样复制进 client/public-tms273，两边各留一份。
// 在复制前对清单里的每个名字做反向断言，把这条链掐断在源头。
for(const url of urls) assertNoConflictCopyName(path.basename(url), `清单引用的导出资源 ${url}`);
// 撞到第一个缺口就 throw，只能告诉你一个名字——而导出树被中途失败的导出
// 破坏时，缺口从来是成片的（2026-09-18：一次 rm -rf + 中途崩溃留下跨
// appearance-cashshop / boss-effects / mage-effects 的缺口）。这里把「文件
// 不存在」与「文件存在但是 0 字节」分开，一次列全，与
// scripts/package_win_bundle.cjs 的 assertPackClosure 同一口径：修复者需要
// 一眼看到全部，而不是逐个重跑脚本。
{
  const missing=[];const zeroByte=[];
  for(const url of urls){
    let stat=null;
    try{stat=fs.statSync(path.join(input,url.slice(1)));}catch{missing.push(url);continue;}
    if(stat.size===0)zeroByte.push(url);
  }
  // 终端报告必须截断（缺口可能上千条），但修复者需要的是全量，所以全量落成台账。
  // **每次装配都重写**：这份台账的含义是「**最近一次**校验的结论」，不是失败历史。
  // 装配通过了却留着一份旧的失败清单，正是本项目反复吃亏的「自述 ≠ 事实」
  // （对照 metadata.json 的 contentVersion：只校验自述，就能让旧二进制贴上新清单上线）。
  // 因此不设「只在失败时写」——成功就必须把台账改写成空。
  const ledger=path.join(root,'artifacts/tms273_assemble_missing.json');
  write(ledger,{version,input:path.relative(root,input),checked:urls.size,missing,zeroByte});
  if(missing.length||zeroByte.length){
    const sections=[`全量清单已落盘：${path.relative(root,ledger)}`];
    if(missing.length)sections.push(`导出树缺少 ${missing.length} 个清单引用的资源：\n  ${missing.slice(0,20).join('\n  ')}${missing.length>20?`\n  …（共 ${missing.length} 个，完整清单见台账）`:''}`);
    if(zeroByte.length)sections.push(`导出树里 ${zeroByte.length} 个清单引用的资源是 0 字节：\n  ${zeroByte.slice(0,20).join('\n  ')}`);
    assert(false,sections.join('\n\n'));
  }
}
for(const url of urls) {
  const destination=path.join(publicRoot,url.slice(1));fs.mkdirSync(path.dirname(destination),{recursive:true});
  if (destination.endsWith('.json')) invalidateCompressed(destination);
  fs.copyFileSync(path.join(input,url.slice(1)),destination);
}
// 反向核对：服务目录里的外观索引 JSON 必须恰好等于清单派生的那一批。
// 少一个 ⇒ entry/appearance.json 引用了一个没落地的文件，运行时 404；
// 多一个 ⇒ 源侧已经改名/下架的旧层赖在包里，从此没人会清理。
// `.br`/`.gz` 是离线预压缩副本，不是独立条目，不参与这条判据。
const cashAppearanceLayers = (() => {
  const dir = path.join(publicRoot, 'assets/tms273/appearance-cashshop');
  const declared = new Set(Object.values(appearance.cashAppearance?.items ?? {}).map(entry => path.basename(entry.url)));
  const landed = fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.endsWith('.json')) : [];
  for (const name of landed) assert(declared.has(name), `Stale cash appearance layer in public root: ${name}`);
  for (const name of declared) assert(landed.includes(name), `Cash appearance layer not copied: ${name}`);
  return landed.length;
})();
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
console.log(JSON.stringify({version,maps:maps.length,assets:urls.size,cashAppearanceLayers,npcs:Object.keys(entities.npcs).length,monsters:Object.keys(entities.monsters).length}));
