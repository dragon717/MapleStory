const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const read=file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
// 服务端生产源码（递归 server/src/**/*.rs，排除 *_acceptance.rs 与 world_tests.rs）。
//
// 为什么不按单个文件读：这些断言问的是"服务端是否实现/定义了某条规则"，
// 而"某段代码当前落在哪个文件"不是契约。`world.rs` 拆分模块时（通讯职责搬去
// `messaging.rs`）按文件名读取的断言会假失败——真出问题的是断言的作用域，不是实现。
// 排除 `*_acceptance.rs` 是必要的：测试文件提到一个拒绝码，不能算作
// "服务端会发这个码"。`world_tests.rs`（R11 从 world.rs 内嵌 mod tests 搬出的
// 外置测试模块）同理排除——理由完全相同。子目录也递归，便于后续按目录拆分。
let serverSourceCache=null;
const serverSource=()=>{
  if(serverSourceCache!==null) return serverSourceCache;
  const files=[];
  const walk=dir=>{
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      const abs=path.join(dir,entry.name);
      if(entry.isDirectory()) walk(abs);
      else if(entry.name.endsWith('.rs') && !entry.name.endsWith('_acceptance.rs') && entry.name !== 'world_tests.rs') files.push(abs);
    }
  };
  walk(path.join(root,'server/src'));
  serverSourceCache=files.sort().map(file=>fs.readFileSync(file,'utf8')).join('\n');
  return serverSourceCache;
};
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
// 地面怪移动能力 (ground-monster movement): `Mob.wz/info/speed` is an optional
// offset on a mob's own walk speed, never the switch that turns walking on —
// 3111 of the 11614 TMS273 mobs ship no `speed` node, 731 of those still author
// a `move`, and 541 write the default out as an explicit `0`.  The authored
// "stands still" form is the `-100` sentinel (城門/寶箱/訓練用木頭人/稻草人,
// and the server rejects anything below it).  The runtime half of the rule
// (an absent node reads as the default 0 offset) is
// `MonsterTemplate::movement_force`, driven from real data by
// `server/src/mob_move_acceptance.rs`; this block pins the source side.
//
// The dump only materialises a mob's *own* nodes, so a mob with `info/link`
// (嫩寶 0100000 -> 0100100, 菇菇寶貝 0100004 -> 1210102) carries no animations of
// its own and takes them — plus any info field it omits — from the linked
// image.  The exporter follows that rule when it picks the sprite, so this
// audit must resolve the link too; reading only the mob's own nodes would call
// 嫩寶 animation-less and invent a bug that does not exist.
{
  const mobJson=id=>read(`参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW/Mob/${String(id).padStart(7,'0')}.json`);
  const ownSpeed=node=>node.info?.speed===undefined?null:Number(node.info.speed._value ?? node.info.speed);
  const linkOf=node=>{const link=node.info?.link;if(link===undefined||link===null)return null;return String(Number(link._value ?? link));};
  // The image the client actually walks: own nodes first, linked image for the
  // animation tree and any field the mob itself omits.
  const resolved=id=>{
    const seen=new Set([String(id)]),nodes=[];let node=mobJson(id);nodes.push(node);
    for(;;){const link=linkOf(node);if(!link||seen.has(link))break;seen.add(link);node=mobJson(link);nodes.push(node);}
    return nodes;
  };
  const walks=id=>{
    const nodes=resolved(id);
    const authored=nodes.map(ownSpeed).find(speed=>speed!==null)??null;
    return nodes.some(node=>Boolean(node.move))&&(authored??0)>-100;
  };
  const deployed=new Set(gameplay.spawns.map(spawn=>spawn.templateId));
  assert.equal(deployed.size,17,'the deployed monster surface changed');
  for(const mob of gameplay.monsters) {
    const own=mobJson(mob.templateId);
    // The export writes exactly the mob's own authored value (and omits it
    // otherwise), so a regenerated source cannot drift without failing here.
    assert.equal(mob.speed ?? null,ownSpeed(own),`speed export drifted from the source: ${mob.templateId}`);
  }
  assert.equal(linkOf(mobJson('100004')),'1210102','菇菇寶貝 must keep its source link');
  const broken=[...deployed].filter(id=>!walks(id));
  assert.deepEqual(broken,[],'deployed monsters without an authored walk');
  // Teeth: the same predicate must still call the authored static props static
  // and the other no-`speed` walkers walkers, so neither "everything moves" nor
  // "a missing `speed` node is broken" can pass this audit.
  for(const id of ['3300112','9602083','9601337']) assert.equal(walks(id),false,`authored static prop counted as a walker: ${id}`);
  for(const id of ['2400100','1210100']) assert.equal(walks(id),true,`no-speed walker lost its walk: ${id}`);
  for(const id of ['1210102','100004']) {
    assert(resolved(id).some(node=>Boolean(node.move)),`菇菇寶貝 must keep its move animation: ${id}`);
    assert.equal(resolved(id).map(ownSpeed).find(speed=>speed!==null)??null,null,`菇菇寶貝 is the documented no-speed case: ${id}`);
    assert(!(gameplay.monsters.find(mob=>mob.templateId===id)??{}).speed,`no speed may be invented for ${id}`);
  }
}
assert.equal(catalog.maps.length,44);
// 傳送類消耗品 (map-move consumables): the client never names a destination —
// the server reads `spec.moveTo` off the item and resolves a 回家卷軸 through
// the sheet's own `Map.wz info/returnMap`.  Both halves are source data, so both
// are pinned here: a missing or un-normalized entry would silently turn a
// working scroll into a refused one, or worse, land a character on the wrong map.
{
  const reference=read('references/tms273-data/maps.json').maps;
  assert.deepEqual(Object.keys(catalog.returnMaps).sort(),catalog.maps.map(map=>map.id).sort(),'returnMap table must cover every assembled map');
  for(const map of catalog.maps) {
    const source=reference.find(entry=>entry.id===map.id).returnMap;
    assert.match(catalog.returnMaps[map.id],/^\d{9}$/,`returnMap must be the 9-digit form: ${map.id}`);
    assert.equal(catalog.returnMaps[map.id],String(Math.trunc(Number(source))).padStart(9,'0'),`returnMap drifted from the source: ${map.id}`);
  }
  // The two authored map-move consumables and nothing else.  2030000 uses the
  // 999999999 sentinel ("this map's returnMap"), 2030001 names 維多利亞港.
  const movable=Object.entries(read('shared/items.json')).filter(([,item])=>item.spec&&'moveTo' in item.spec);
  assert.deepEqual(movable.map(([id])=>id).sort(),['2030000','2030001'],'the map-move consumable set changed');
  assert.equal(movable.find(([id])=>id==='2030000')[1].spec.moveTo,999999999);
  assert.equal(movable.find(([id])=>id==='2030001')[1].spec.moveTo,104000000);
  // A town the catalog does not ship stays legal data: the scroll is refused at
  // use time.  Pinning it keeps the refusal honest rather than a silent wrong map.
  const unshipped=Object.entries(catalog.returnMaps).filter(([,id])=>!catalog.maps.some(map=>map.id===id));
  assert.deepEqual(unshipped.map(([from,to])=>`${from}->${to}`).sort(),['310040200->310000000','310050000->310000000'],'unshipped returnMap targets changed');
}
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
// 用户指定规则（2026-09-10）：瞬移全等级 10MP + 等级冷却。设置该规则的唯一来源是
// scripts/tms273_skill_manifest.cjs 的 USER_SPECIFIED_SKILL_RULES；原版 TMS273 为
// mpCon 28→20 且没有 cooltime，所以这里同时锁定"运行时数值=指定值、rawCommon=源记录"。
{
  const teleport=manifest.skillCatalog['2001009'];
  assert.equal(teleport.maxLevel,5);
  assert.equal(teleport.levelDescriptions.length,5);
  for(const description of teleport.levelDescriptions) assert.match(description,/^消耗10MP，/);
  assert.match(teleport.levelDescriptions[4],/朝左右瞬移190並朝上下瞬移295/,'source distance must stay verbatim');
  const rules=read('shared/mage-skills.json').skills['2001009'];
  assert.deepEqual(rules.levels.map(level=>level.mpCon),[10,10,10,10,10]);
  assert.deepEqual(rules.levels.map(level=>level.cooldownMs),[1200,1050,900,750,600]);
  assert.equal(rules.rawCommon.mpCon,'30-2*x');
}

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
  // 維多利亞港三家商店：原版 273 的三个 type-2 店门必须能进，且双向都贴地。
  for(const [mapId,name,target,gate] of [
    ['104000000','in00','104000001','out00'],
    ['104000000','in01','104000002','out01'],
    ['104000000','in02','104000003','out00'],
  ]) {
    const town=byId.get(mapId).portals.find(p=>p.name===name);
    assert.equal(town.targetMapId,target,`${mapId}/${name} must enter the source shop map`);
    assert.equal(town.targetPortalName,gate);
    const shop=byId.get(target),exit=shop.portals.find(p=>p.name===gate);
    assert.equal(exit.targetMapId,mapId,`${target}/${gate} must return to 維多利亞港`);
    assert.equal(exit.targetPortalName,name);
    assert(manifest.portals[`${mapId}/${name}`]?.frames.length>0,`${mapId}/${name} gate must be visible`);
    assert(manifest.portals[`${target}/${gate}`]?.frames.length>0,`${target}/${gate} gate must be visible`);
  }
}
for(const spawn of gameplay.spawns)assert(manifest.monsters[spawn.templateId]?.actions.move.length,spawn.id);
for(const spawn of gameplay.npcSpawns)assert(manifest.npcs[spawn.templateId]?.stand.length,spawn.id);
for(const shop of gameplay.shops)for(const entry of shop.items)assert(manifest.items[entry.itemId],entry.itemId);
for(const id of ['36301','36302','36303','36304','36306','36307'])assert(gameplay.quests.some(q=>q.questId===id));
const sourceQuests=read('references/tms273-data/quests.json').quests;
// 70 since the adventurer prerequisite set was widened to the full
// 1401/1403/1404/1405/2570/2684 group; the count is the source import's own
// contract and must be bumped with it, or the launcher's precheck stops here.
assert.equal(sourceQuests.length,70);
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
let healed=0;
function visit(value) {
  if(typeof value==='string'&&value.startsWith('/assets/')) {
    assert(value.startsWith('/assets/tms273/'),value);
    // client/public-tms273/ 是生成物且不被 git 跟踪。本仓库躺在 iCloud 同步盘里，
    // 2026-09-12 出现过同一个装配 PNG 在数分钟内被外界删除两次（dist 快照始终完好）。
    // 因此这里选择自愈：缺失且 dist 快照（最近一次构建时 public 的拷贝）里有同名文件
    // ⇒ 原地补回再继续，不挡启动；两处都没有才是真装配缺口，报错并指向重跑装配。
    const asset=path.join(root,'client/public-tms273',value);
    let size;
    try { size=fs.statSync(asset).size; }
    catch {
      const twin=path.join(root,'build/current/client',value);
      if(fs.existsSync(twin)&&fs.statSync(twin).size>0) {
        fs.mkdirSync(path.dirname(asset),{recursive:true});
        fs.copyFileSync(twin,asset);
        size=fs.statSync(asset).size;
        healed++;
      } else {
        throw new Error(`装配资源缺失且 dist 快照里也没有: ${value}\n  修复提示: 重跑装配脚本，不要改本 check`);
      }
    }
    assert(size>0,value);checked++;
  } else if(value&&typeof value==='object')for(const child of Object.values(value))visit(child);
}
visit(manifest);
console.log(`TMS273 runtime: ${catalog.maps.length} maps; ${checked} source references; client/server geometry and quest generation agree.`);
if(healed>0)console.log(`注意: ${healed} 个装配资源在 public-tms273 里缺失，已从 dist 快照自动补回（本仓库在 iCloud 盘，资源会无故消失；若反复出现请把仓库移出同步盘或排除 client/public-tms273）。`);

// Account warehouse: the client window is drawn entirely from the TMS273
// UIWindow.img/Trunk export, and its row cap must agree with the server's
// STORAGE_SLOT_LIMIT or the UI would offer slots the server refuses.
assert(manifest.storageUi,'storage window export is missing');
assert(manifest.storageUi.contentVersion==='tms273-storage',manifest.storageUi.contentVersion);
for(const key of ['backgrnd','select','BtGet/normal','BtPut/normal','BtExit/normal','BtGetAll/normal','BtSort/normal','BtInCoin/normal','BtOutCoin/normal']) {
  assert(manifest.storageUi.ui[key],`storage art missing: ${key}`);
}
for(const state of ['normal','pressed','disabled','mouseOver']) {
  for(const button of ['BtGet','BtPut','BtExit','BtGetAll','BtSort']) {
    assert(manifest.storageUi.ui[`${button}/${state}`],`storage state missing: ${button}/${state}`);
  }
}
for(const state of ['enabled','disabled']) {
  for(let i=0;i<5;i+=1) assert(manifest.storageUi.ui[`Tab/${state}/${i}`],`storage tab missing: ${state}/${i}`);
}
{
  const worldSrc=serverSource();
  const limit=Number(worldSrc.match(/pub const STORAGE_SLOT_LIMIT: u16 = (\d+);/)?.[1]);
  assert(limit>0,'STORAGE_SLOT_LIMIT not found in the server source');
  assert.equal(manifest.storageUi.slotLimit,limit,'storage slot limit drifted between client and server');
}

// Friend & blacklist: the window shares the authored UserList shell with the
// party window, and the buttons it drives must exist in the TMS273 export or
// the window silently falls back to text buttons.
assert(manifest.friendUi,'friend window export is missing');
assert(manifest.friendUi.contentVersion==='tms273-friend',manifest.friendUi.contentVersion);
for(const key of ['backgrnd','Tab/enabled/0','Tab/enabled/1','BtAddFriend/normal','BtDelete/normal','BtBlock/normal','BlackList/BtAdd/normal','BlackList/BtDelete/normal']) {
  assert(manifest.friendUi.ui[key],`friend art missing: ${key}`);
}
for(const state of ['normal','pressed','disabled','mouseOver']) {
  for(const button of ['BtAddFriend','BtDelete','BtBlock','BlackList/BtAdd','BlackList/BtDelete']) {
    assert(manifest.friendUi.ui[`${button}/${state}`],`friend state missing: ${button}/${state}`);
  }
}
assert(manifest.friendUi.tabCount>=2,`friend tab strip too short: ${manifest.friendUi.tabCount}`);
{
  // The friend caps live in auth.rs and are enforced server-side; the client
  // only ever renders what the server pushes, so a drift here would show up as
  // a window that cannot explain a refusal.
  const authSrc=serverSource();
  assert(/const FRIEND_LIMIT: i64 = \d+;/.test(authSrc),'FRIEND_LIMIT not found in the server source');
  assert(/const BLACKLIST_LIMIT: i64 = \d+;/.test(authSrc),'BLACKLIST_LIMIT not found in the server source');
}

// World map (大地图): the window is drawn from the Map.wz/WorldMap page art plus
// the UIWindow2.img shell, and it is only worth opening if every assembled map
// can be located on a page — the location plate is the whole point.
//
// The archive stores `MapList/*/mapNo` as a bare integer, so the export has to
// pad it to the 9-digit form that `shared/maps.json` and the server snapshot
// speak.  When it did not, the 16 Maple Island spots never matched, the whole
// WorldMap000 page was skipped, and the root page's 楓之島 plate became a dead
// link — the assertions below pin exactly that.
{
  const world=manifest.worldMap;
  assert(world,'world map export is missing');
  assert.equal(world.contentVersion,'tms273-worldmap',world.contentVersion);
  assert(world.pages[world.root],`world map root page missing: ${world.root}`);
  // Every page in the archive, so a plate into a region this catalog cannot
  // reach is recognisable as intentional rather than a typo.
  const archivePages=new Set(read('resources/tms273-export/worldmap.json').allPages);
  for(const [page,entry] of Object.entries(world.pages)) {
    assert.equal(entry.page,page);
    assert(entry.baseImg.url&&entry.baseImg.width>0&&entry.baseImg.height>0,`world map page art missing: ${page}`);
    // Every exported page must be navigable out of, and reachable in: a page
    // no plate points at would ship art the player can never open.
    if(entry.parent!==null) {
      assert(world.pages[entry.parent],`world map page ${page} cannot be navigated out of`);
      const parent=world.pages[entry.parent];
      assert(parent.mapLinks.some(link=>link.page===page),`world map page ${page} has no plate pointing at it`);
    }
    for(const link of entry.mapLinks) {
      assert(link.page===null||world.pages[link.page]||archivePages.has(link.page),
        `world map plate points at a page the archive does not have: ${page} -> ${link.page}`);
    }
    for(const spot of entry.mapList) for(const id of spot.mapIds) {
      assert.match(id,/^\d{9}$/,`world map spot id must be the 9-digit form: ${page} -> ${id}`);
    }
  }
  // The archive authors no spot at all for this map, so it is the one assembled
  // map the window legitimately cannot mark.  Anything else missing is a bug.
  const WORLD_MAP_ABSENT=new Set(['002010000']);
  const located=new Set(Object.values(world.pages).flatMap(entry=>entry.mapList.flatMap(spot=>spot.mapIds)));
  const absent=catalog.maps.map(map=>map.id).filter(id=>!located.has(id)&&!WORLD_MAP_ABSENT.has(id));
  assert.deepEqual(absent,[],`assembled maps missing from the world map: ${absent.join(', ')}`);
  // Maple Island is the region that regressed, so name it: 選擇岔道 is where a
  // new character starts, and 楓之港/碼頭 are the first ferries off the island.
  for(const id of ['001020000','002000000','002000100','000010000','001000000']) {
    assert(located.has(id),`Maple Island spot missing from the world map: ${id}`);
  }
  for(const key of ['border','plate']) assert(world.ui[key]?.url,`world map shell art missing: ${key}`);
  for(const state of ['normal','mouseOver','pressed','disabled']) {
    for(const control of ['close','before','next','all']) {
      const frames=control==='close'?world.ui.close:world.ui.nav[control];
      assert(frames[state]?.url,`world map control state missing: ${control}/${state}`);
    }
  }
}

assert(!manifest.skillCatalog['2220014']);
for(const id of ['2221004','2221005','2221006','2221007','2221011','2221012']) assert(manifest.avatar.actions['skill'+id].length>0);
for(const key of ['prepare','keydown','keydown0','keydownend']) assert(manifest.skillEffects['2221011'][key].length>0);
assert(manifest.skillEffects['2220014'].hit.length>0);
assert(manifest.skillEffects['2221000'].effect0.length>0);
assert(manifest.skillEffects['2221004'].special.length>0);
assert(manifest.skillSounds['2221011'].loop.url && manifest.skillSounds['2221011'].end.url);

// Chat emoticons (表情貼圖): the window is drawn from UI/ChatEmoticon.img, the
// head animation plays the exported `effect` frames, and the *server* owns the
// catalogue and the send budget.  The client and server therefore have to agree
// about both, or the window would offer stickers the server refuses (or hide
// ones it accepts).
{
  const emoticon=manifest.emoticon;
  assert(emoticon,'emoticon export is missing');
  assert.equal(emoticon.contentVersion,'tms273-emoticon',emoticon.contentVersion);
  assert.equal(emoticon.groups.length,51);
  assert.equal(emoticon.stickers.length,298);
  assert.equal(emoticon.limit.count,4);
  assert.equal(emoticon.limit.timeMs,5000);
  assert.equal(emoticon.limit.source,'UI/ChatEmoticon.img/ChatLimit');
  // `<groupId>:<sourceName>`.  The group qualifier is load-bearing: group 1043
  // re-releases group 1036's six stickers under the same authored node names.
  const ids=emoticon.stickers.map(sticker=>sticker.id);
  for(const id of ids) assert.match(id,/^\d{4,8}:\d{4,12}$/,`malformed sticker id: ${id}`);
  assert.equal(new Set(ids).size,ids.length,'sticker ids must be unique');
  // The grid is 3x3 and the row count is *proved* by the authored empty-state
  // panel: it is drawn over exactly one grid, so a fourth row would overflow it.
  const {columns,rows,slotCount,slotOffset,slotSpace,slotSize,groupCount,pageOffset,pageIconSpace}=emoticon.layout;
  assert.deepEqual([columns,rows,slotCount],[3,3,9]);
  assert.equal(slotCount,columns*rows);
  const gridWidth=slotOffset.x+(columns-1)*slotSpace.x+slotSize.width;
  const gridHeight=slotOffset.y+(rows-1)*slotSpace.y+slotSize.height;
  const background=emoticon.ui.backgrnd;
  assert(gridWidth<=background.width&&gridHeight<=background.height,'slot grid overflows the window');
  const empty=emoticon.ui['layer:emptySlot'];
  assert(empty,'authored empty-state panel is missing');
  assert(Math.abs(gridWidth-slotOffset.x-empty.width)<=4,`empty-state panel width disagrees with the grid: ${empty.width}`);
  assert(Math.abs(gridHeight-slotOffset.y-empty.height)<=4,`empty-state panel height disagrees with the grid: ${empty.height}`);
  // The authored nav buttons sit on the chip row and flank the strip, while the
  // dots are drawn 5px under the chips: that geometry is what makes the strip --
  // not the grid -- the thing `pageUp`/`pageDown`/`pageIcon` page, so it is
  // asserted here and a source revision cannot quietly move them elsewhere.
  const groupBase=emoticon.ui.groupBase,upButton=emoticon.ui['button:pageUp/normal'],downButton=emoticon.ui['button:pageDown/normal'];
  const stripRight=emoticon.layout.groupOffset.x+(groupCount-1)*emoticon.layout.groupSpace.x+groupBase.width;
  const chipBottom=emoticon.layout.groupOffset.y+groupBase.height;
  assert(upButton.x<emoticon.layout.groupOffset.x,'pageUp does not sit left of the group strip');
  assert(downButton.x>=stripRight,'pageDown does not sit right of the group strip');
  for(const [name,button] of [['pageUp',upButton],['pageDown',downButton]]) {
    assert(button.y<chipBottom&&button.y+button.height>emoticon.layout.groupOffset.y,`${name} is not on the group strip row`);
  }
  assert(pageOffset.y>=chipBottom&&pageOffset.y<slotOffset.y,'the page dots do not sit between the strip and the grid');
  // The grid is scoped to the selected group, so the sheet count is summed over
  // the groups instead of being derived from the flat catalogue length.
  assert.equal(emoticon.pageCount,Math.ceil(emoticon.groups.length/groupCount));
  assert.equal(emoticon.sheetCount,emoticon.groups.reduce((total,group)=>total+group.sheetCount,0));
  assert(emoticon.groups.some(group=>group.sheetCount>1),'no group overflows one sheet any more; the sheet model was built for exactly one');
  let cursor=0;
  for(const group of emoticon.groups) {
    assert(group.stickerCount>=1,`group ${group.id} has no stickers`);
    assert.equal(group.firstSticker,cursor,`${group.id} does not start where the previous group ended`);
    assert.equal(group.sheetCount,Math.ceil(group.stickerCount/slotCount),`${group.id} sheet count drifted`);
    for(let offset=0;offset<group.stickerCount;offset++) assert.equal(emoticon.stickers[cursor+offset].groupId,group.id,`${group.id} stickers are not contiguous in the catalogue`);
    cursor+=group.stickerCount;
  }
  assert.equal(cursor,emoticon.stickers.length,'group ranges do not cover the catalogue');
  // Dots have to fit between `pageOffset` and the authored `pageDown` button.
  assert.equal(emoticon.dotCapacity,Math.floor((downButton.x-pageOffset.x-emoticon.ui['pageIcon/on'].width)/pageIconSpace)+1);
  assert(emoticon.pageCount<=emoticon.dotCapacity,`the strip needs ${emoticon.pageCount} dots but only ${emoticon.dotCapacity} fit before pageDown`);
  // The window has to place its grid from the exported group ranges; a flat walk
  // would put a group's stickers on a page that its own chip does not describe.
  const viewSrc=fs.readFileSync(path.join(root,'client/src/features/chat/emoticon-view.ts'),'utf8');
  assert(/group\.firstSticker/.test(viewSrc),'the emoticon window does not slice a group out of the catalogue');
  assert(/sheetCount/.test(viewSrc),'the emoticon window ignores the exported sheet count');
  for(const key of ['backgrnd','slotBase','layer:emptySlot','groupBase','groupSelect','pageIcon/on','pageIcon/off']) {
    assert(emoticon.ui[key],`emoticon art missing: ${key}`);
  }
  for(const state of ['normal','pressed','disabled','mouseOver']) {
    for(const button of ['close','pageUp','pageDown']) {
      assert(emoticon.ui[`button:${button}/${state}`],`emoticon button state missing: ${button}/${state}`);
    }
  }
  const groupIds=new Set(emoticon.groups.map(group=>group.id));
  for(const group of emoticon.groups) assert(group.icon?.url,`group icon missing: ${group.id}`);
  const perGroup=new Map();
  for(const sticker of emoticon.stickers) {
    assert(groupIds.has(sticker.groupId),`sticker ${sticker.id} names an unknown group`);
    assert(sticker.frames.length>0,`sticker ${sticker.id} has no animation frames`);
    assert.equal(sticker.durationMs,sticker.frames.reduce((sum,frame)=>sum+frame.delay,0),`sticker ${sticker.id} duration drifted`);
    perGroup.set(sticker.groupId,(perGroup.get(sticker.groupId)??0)+1);
  }
  for(const group of emoticon.groups) assert((perGroup.get(group.id)??0)>0,`group ${group.id} has no stickers`);
  // The authoritative world validates ids against its own flattened copy of the
  // same list and enforces the same authored budget.
  assert.equal(gameplay.emoticons.source,emoticon.contentVersion);
  assert.deepEqual(gameplay.emoticons.ids,ids,'client and server emoticon catalogues disagree');
  assert.equal(gameplay.emoticons.limit.count,emoticon.limit.count);
  assert.equal(gameplay.emoticons.limit.timeMs,emoticon.limit.timeMs);
  // Both refusal codes the server can send must be explainable in the UI,
  // otherwise the window would show a bare code.
  const serverSrc=serverSource();
  const i18nSrc=fs.readFileSync(path.join(root,'client/src/app/i18n.ts'),'utf8');
  for(const code of ['emoticon_unknown','emoticon_rate_limited']) {
    assert(serverSrc.includes(`"${code}"`),`server never sends ${code}`);
    assert(i18nSrc.includes(`${code}:`),`the client cannot explain ${code}`);
  }
}
