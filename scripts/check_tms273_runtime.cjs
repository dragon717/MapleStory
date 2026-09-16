const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const read=file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
const creation = read('shared/character-creation.json');
assert.deepEqual(read('client/public-tms273/assets/entry/creation.json'), creation, 'Creation choices differ between client and server');
for (const file of ['shared/items.json', 'client/public-tms273/assets/items.json']) {
  require('./tms273_creation_catalog.cjs')(creation, read(file), file);
}
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
assert.equal(manifest.contentVersion,process.argv[2] ?? 'tms273-29');
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
  // 源内**授权不动**的场地怪名单（唯一豁免来源）。前三个是既有的城门/道具怪，
  // 后两个见下方 2026-09-15 注释。少写一个就会让"缺动作的坏数据"混过去。
  const AUTHORED_STATIC_MOBS=['3300112','9602083','9601337','2230103','2230104'];
  const deployed=new Set(gameplay.spawns.map(spawn=>spawn.templateId));
  // 17 species before the 2026-09-13 portal-closure maps; the 弓箭手村东/墮落
  // 城市西/礦山 route rooms deployed nine more field species.  The 2026-09-14
  // 楓之島災禍篇 scene execution added 8645261 藍色蘑菇王 (36315's verified kill
  // target) on 001010000, taking the surface to 27.  The 2026-09-14 艾靈森林
  // region added 10 field species (4250000/4250001, 5250000-5250007), to 37.
  // The 2026-09-15 愛奧斯塔/地球防衛本部 region added 15 more (塔身 1~100 樓与
  // 路德斯湖街的场地怪), to 52.  The 2026-09-15 危險地帶/UFO 街 region added the
  // ten field species of 洛斯威爾草原Ⅰ~Ⅳ 与 UFO 内部
  // (4230127 馬堤安 / 4230128 培利堤安 / 4230129~4230134，分布在草原与走廊
  // 101/103/202/203/通風口 D-1~D-4；以及 4230141/4230142 新葛雷白/新葛雷黑，
  // 在走廊 H01~H03），to 62.  （4230137/4230138 只在 TMS273 WZ 里有怪物定义，
  // 本片 23 张图的 life 行没有任何一条引用它们，因此连怪物目录都不进。）
  assert.equal(deployed.size,62,'the deployed monster surface changed');
  for(const mob of gameplay.monsters) {
    const own=mobJson(mob.templateId);
    // The export writes exactly the mob's own authored value (and omits it
    // otherwise), so a regenerated source cannot drift without failing here.
    assert.equal(mob.speed ?? null,ownSpeed(own),`speed export drifted from the source: ${mob.templateId}`);
  }
  assert.equal(linkOf(mobJson('100004')),'1210102','菇菇寶貝 must keep its source link');
  const broken=[...deployed].filter(id=>!walks(id)&&!AUTHORED_STATIC_MOBS.includes(id));
  assert.deepEqual(broken,[],'deployed monsters without an authored walk');
  // Teeth: the same predicate must still call the authored static props static
  // and the other no-`speed` walkers walkers, so neither "everything moves" nor
  // "a missing `speed` node is broken" can pass this audit.
  // 2026-09-15：2230103 黃蜘蛛 / 2230104 紅蜘蛛（愛奧斯塔94樓）加入这张名单——
  // 它们的 WZ 只有 `stand/hit1/die1`、`info` 里既无 speed 也无 fs，原版就是固定怪。
  // 名单是**唯一豁免来源**：别的怪少了 `move` 照样被上面那条断言抓住。
  for(const id of AUTHORED_STATIC_MOBS) assert.equal(walks(id),false,`authored static prop counted as a walker: ${id}`);
  for(const id of ['2400100','1210100']) assert.equal(walks(id),true,`no-speed walker lost its walk: ${id}`);
  for(const id of ['1210102','100004']) {
    assert(resolved(id).some(node=>Boolean(node.move)),`菇菇寶貝 must keep its move animation: ${id}`);
    assert.equal(resolved(id).map(ownSpeed).find(speed=>speed!==null)??null,null,`菇菇寶貝 is the documented no-speed case: ${id}`);
    assert(!(gameplay.monsters.find(mob=>mob.templateId===id)??{}).speed,`no speed may be invented for ${id}`);
  }
}
// 50 maps before 2026-09-13; then +21 portal-closure maps — every map an
// assembled map's portal names that the TMS273 WZ JSON actually ships
// (弓箭手村 interiors, 墮落城市 west route, 蘑菇村 east road, 幸福村 platform, …).
// 2026-09-14 飞行船一期 +6 船图，二期 +10 船图/码头（耶雷弗簇 3 + 埃德爾斯坦簇 7）。
// 2026-09-14 艾靈森林章节 +21 图（现代侧 2：赫爾奧斯塔圖書館/時間監控室；
// 过去侧 19：亞泰爾營地、苔蘚森林、封印的森林与两间首領房）。
// 2026-09-15 玩具城與赫爾奧斯塔塔步行链路 +7 图（玩具城 + 武防店/雜貨店、
// 赫爾奧斯塔入口、塔身 100/99/2 樓）；同日玩具城⇄天空之城飞行船第三航线
// +9 图（玩具城售票处/碼頭、天空之城港口通道/碼頭、两张船图、天空之城城内
// 与它的两家源商店）。
// 2026-09-15 愛奧斯塔（Eos Tower）與地球防衛本部 +41 图（玩具城村莊、愛奧斯塔入口、
// 塔身 1~100 樓含三段分組梯層 `221021000/221021600/221022200` 与隱藏之塔、
// 地球防衛本部本部/通道/主控室/司令室/安全地帶）。
// 2026-09-15 危險地帶／洛斯威爾草原／UFO 街 +23 图（地球防衛總部街西段：
// `221030000 危險地帶` + 草原Ⅰ~Ⅳ 五张纯静态门链，加 UFO 內部 18 张
// 走廊/通風口图）。源里其余 19 张（操縱杆翼、无名字图、事件房与
// `BossCaoong` 首領房）没有任何授权入边，逐条落在下方的不装配清单里。
assert.equal(catalog.maps.length,188);
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
  // The four authored map-move consumables and nothing else.  2030000 uses the
  // 999999999 sentinel ("this map's returnMap"), 2030001 names 維多利亞港, and
  // 2030002 (魔法森林卷軸, sold by 1031100 妖精 蓮 in 魔法森林雜貨店) names
  // 魔法森林 101000000.
  const movable=Object.entries(read('shared/items.json')).filter(([,item])=>item.spec&&'moveTo' in item.spec);
  assert.deepEqual(movable.map(([id])=>id).sort(),['2030000','2030001','2030002','2030003'],'the map-move consumable set changed');
  assert.equal(movable.find(([id])=>id==='2030000')[1].spec.moveTo,999999999);
  assert.equal(movable.find(([id])=>id==='2030001')[1].spec.moveTo,104000000);
  assert.equal(movable.find(([id])=>id==='2030002')[1].spec.moveTo,101000000);
  assert.equal(movable.find(([id])=>id==='2030003')[1].spec.moveTo,102000000);
  // A town the catalog does not ship stays legal data: the scroll is refused at
  // use time.  Pinning it keeps the refusal honest rather than a silent wrong map.
  // Towns the catalog does not ship stay legal data: the scroll is refused at
  // use time.  Pinning them keeps the refusal honest rather than a silent
  // wrong map.  The 3100401xx/3100403xx entries left this list when
  // 310000000 埃德爾斯坦城 arrived with the 2026-09-14 phase-2 flight line;
  // 222020000/222020400 (圖書館/時間監控室 → 220000000) left it when 玩具城
  // arrived with the 2026-09-15 赫爾奧斯塔塔步行链路; the last two —
  // 200000100/200000170 → 200000000 — left it with the same day's
  // 玩具城⇄天空之城 flight line, which is what brought 天空之城城内 into the
  // catalog.  Every assembled flight-line map now resolves its returnMap.
  const unshipped=Object.entries(catalog.returnMaps).filter(([,id])=>!catalog.maps.some(map=>map.id===id));
  assert.deepEqual(unshipped.map(([from,to])=>`${from}->${to}`).sort(),[
    '100030400->100030102','103010100->103000000','120010100->120000000',
  ].sort(),'unshipped returnMap targets changed');
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
  for(const description of teleport.levelDescriptions) assert.match(description,/^消耗MP 10，/);
  assert.match(teleport.levelDescriptions[4],/朝左右瞬移190、上下瞬移295/,'source distance must stay verbatim');
  assert.match(teleport.levelDescriptions[4],/冷却 50ms/,'per-level cooldown must render');
  assert.match(teleport.description,/800ms→50ms/);
  const rules=read('shared/mage-skills.json').skills['2001009'];
  assert.deepEqual(rules.levels.map(level=>level.mpCon),[10,10,10,10,10]);
  assert.deepEqual(rules.levels.map(level=>level.cooldownMs),[800,650,450,250,50]);
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
// Beams follow the client's own sprite rule, not "any cross-map gate": only the
// types the client draws with `pv` art may carry the shared beam, everything
// else must stay beam-free.  Two failure modes are pinned here —
//   * a `pv` gate (type 2 Visible, type 7 Script) into an assembled map that
//     lost its beam, so a doorway players need is invisible again; scripted
//     doorways (WZ `tm: 999999999`, e.g. 楓之港 `east00` → 碼頭 via
//     `pt_southperry`) get their route from the chapter adapter, so their beam
//     is added after it runs;
//   * a beam on a type the client never draws, which is the 2026-09-13 report
//     「傳送陣多一個」: 六條岔道's rope-top pair `top00`/`top01` are both
//     `pt: 3` (collision → editor-only `pc` art) and glowed as two stacked
//     beams on the tree trunk.
{
  const { beamSpriteForType, portalTypeCode }=require('./tms273_portal_sprite.cjs');
  const assembled=new Set(catalog.maps.map(map=>map.id));
  const missing=[], phantom=[];
  for(const map of catalog.maps)for(const portal of map.portals) {
    if(!portal.targetMapId || portal.targetMapId===map.id)continue;
    if(!assembled.has(portal.targetMapId))continue;
    const beam=manifest.portals[`${map.id}/${portal.name}`];
    if(beamSpriteForType(portal.type)==='pv') {
      if(!beam?.frames?.length)missing.push(`${map.id}/${portal.name}`);
    } else if(beam) {
      phantom.push(`${map.id}/${portal.name} (pt=${portal.type} ${portalTypeCode(portal.type)})`);
    }
  }
  assert.deepEqual(missing,[],`Visible cross-map portal lacks a beam: ${missing.join(', ')}`);
  assert.deepEqual(phantom,[],`Beam invented for a portal type the client never draws: ${phantom.join(', ')}`);
  assert(manifest.portals['002000000/east00']?.frames.length>0,'楓之港 → 碼頭 gate must be visible');
  assert(manifest.portals['002000100/west00']?.frames.length>0,'碼頭 → 楓之港 gate must be visible');
  // The reported pair, named so a regression names the map the user saw.
  assert.equal(manifest.portals['104020000/top00'],undefined,'六條岔道 rope-top collision gates must not glow');
  assert.equal(manifest.portals['104020000/top01'],undefined,'六條岔道 rope-top collision gates must not glow');
  assert.equal(manifest.portals['104020100/under00'],undefined,'樹木站台 under-platform collision gates must not glow');
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
  // 愛奧斯塔 32樓/66樓：源 `tn` 指定的落点本身就是悬空锚（`221021200/st00`
  // y=644 而该 x 只有 y=705 的地板，Δ61px；`221021700/top00` Δ41px）。这两处
  // 是 pt:1 隐形锚，原版落上去也是自然下坠一小段——落点来自源，不能为了贴地
  // 把锚点搬下来。逐条钉住这 6 条边，别让别的图悄悄借这条豁免。
  const SOURCE_FLOATING_LANDINGS=[
    '221021300/under00','221021300/under01','221021300/under02',
    '221021300/under03','221021300/under04',
    '221021800/under00',
  ];
  const floating=[];
  for(const map of catalog.maps)for(const portal of map.portals) {
    // 埃德爾斯坦船的舱门（out00..09）由服务端 `ship.rs` 接管：检票相位
    // warp 回本端检票站台 `sp`，航行中不开门——静态 tn 落点（源 st00 悬空
    // 170px）不参与贴地审计。
    if(['200090600','200090601','200090610','200090611'].includes(map.id)&&/^out\d+$/.test(portal.name))continue;
    if(SOURCE_FLOATING_LANDINGS.includes(`${map.id}/${portal.name}`))continue;
    const targetId=portal.targetMapId;
    if(!targetId || targetId===map.id || !byId.has(targetId))continue;
    const target=byId.get(targetId);
    const landing=target.portals.find(p=>p.name===portal.targetPortalName) ?? target.spawn;
    const ground=groundNear(target,landing.x,landing.y);
    if(ground===null||Math.abs(ground-landing.y)>24)floating.push(`${map.id}/${portal.name} → ${targetId}/${portal.targetPortalName ?? 'spawn'} (Δ${ground===null?'none':Math.round(ground-landing.y)}px)`);
  }
  assert.deepEqual(floating,[],`Warp landing is not grounded: ${floating.join('; ')}`);
  // 豁免本身也会过期：这些边必须仍然真的悬空，否则名单该删。
  for(const edge of SOURCE_FLOATING_LANDINGS) {
    const [mapId,name]=edge.split('/');
    const portal=byId.get(mapId).portals.find(entry=>entry.name===name);
    const target=byId.get(portal.targetMapId);
    const landing=target.portals.find(entry=>entry.name===portal.targetPortalName);
    const ground=groundNear(target,landing.x,landing.y);
    assert(ground!==null&&Math.abs(ground-landing.y)>24,`${edge} 已不再悬空，豁免该删掉`);
  }
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
  // 魔法森林两家店：101000000 的 `in00`/`in01` 是原版 type-2 店门（无脚本体），
  // 目标图 101000001/101000002 必须装配，否则玩家只会看到「此路线尚未开放」。
  for(const [mapId,name,target,gate] of [
    ['101000000','in00','101000001','out00'],
    ['101000000','in01','101000002','out01'],
  ]) {
    const town=byId.get(mapId).portals.find(p=>p.name===name);
    assert.equal(town.targetMapId,target,`${mapId}/${name} must enter the source shop map`);
    assert.equal(town.targetPortalName,gate);
    const shop=byId.get(target),exit=shop.portals.find(p=>p.name===gate);
    assert.equal(exit.targetMapId,mapId,`${target}/${gate} must return to 魔法森林`);
    assert.equal(exit.targetPortalName,name);
    assert(manifest.portals[`${mapId}/${name}`]?.frames.length>0,`${mapId}/${name} gate must be visible`);
    assert(manifest.portals[`${target}/${gate}`]?.frames.length>0,`${target}/${gate} gate must be visible`);
  }
}
// 飞行船航线一期（2026-09-14）：六张船图随目录装配，甲板/船舱的 pt:3 接触门
// 双向互切必须与源一致；returnMap 决定死亡复活落点，随源钉死；检票员/播报员
// 必须站在检票地图上（服务端 ship.rs 以对话检票，源站台无静态登船门）。
{
  const byId=new Map(catalog.maps.map(map=>[map.id,map]));
  for(const id of ['200000100','200000112','200090000','200090001','200090010','200090011'])
    assert(byId.has(id),`ship map must be assembled: ${id}`);
  for(const [cabin,deck] of [['200090001','200090000'],['200090011','200090010']]) {
    for(const [from,name,to,gate] of [
      [deck,'in00',cabin,'st01'],[deck,'under00',cabin,'st00'],
      [cabin,'out00',deck,'in00'],[cabin,'out01',deck,'under00'],
    ]) {
      const portal=byId.get(from).portals.find(p=>p.name===name);
      assert(portal,`${from}/${name} must exist`);
      assert.equal(portal.targetMapId,to,`${from}/${name} must target ${to}`);
      assert.equal(portal.targetPortalName,gate,`${from}/${name} must land on ${gate}`);
    }
  }
  for(const [map,returnMap] of [
    ['200000100','200000000'],['200000112','200000100'],
    ['200090000','200000100'],['200090001','200000100'],
    ['200090010','104020110'],['200090011','104020110'],
  ]) assert.equal(catalog.returnMaps[map],returnMap,`${map} returnMap drifted`);
  for(const [map,template] of [
    ['104020110','1032007'],['104020110','1032008'],['200000100','2012000'],
  ]) assert(gameplay.npcSpawns.some(spawn=>spawn.mapId===map&&spawn.templateId===template),`${template} must stand on ${map}`);
  // 飞行船航线二期（2026-09-14）：耶雷弗线与埃德爾斯坦线的十张船图/码头随
  // 目录装配；returnMap 决定死亡复活落点，随源钉死；各侧检票员/播报员必须
  // 站在检票地图上（服务端 ship.rs 二期航线以对话检票）。
  for(const id of [
    '130000200','130000210','130090000',
    '200000170','200090600','200090601','200090610','200090611',
    '310000000','310000010',
  ]) assert(byId.has(id),`phase-2 ship map must be assembled: ${id}`);
  for(const [map,returnMap] of [
    ['130000200','130000000'],['130000210','130000000'],['130090000','130090000'],
    ['200000170','200000000'],
    ['200090600','200000170'],['200090601','200000170'],
    ['200090610','310000010'],['200090611','310000010'],
    ['310000000','310000000'],['310000010','310000000'],
  ]) assert.equal(catalog.returnMaps[map],returnMap,`${map} returnMap drifted`);
  for(const [map,template] of [
    ['104020120','1100007'],
    ['130000210','1100003'],['130000210','1100004'],
    ['104020130','2150010'],
    ['310000010','2150008'],['310000010','9072000'],
  ]) assert(gameplay.npcSpawns.some(spawn=>spawn.mapId===map&&spawn.templateId===template),`${template} must stand on ${map}`);
  // 耶雷弗城/埃德爾斯坦城入口衔接：渡口 out00 由服务端 P 级路由回前庭，
  // 前庭 in00 的源门必须指向渡口；码头 out00 必须通向城内（源 type-2 门）。
  assert.equal(byId.get('130000200').portals.find(p=>p.name==='in00').targetMapId,'130000210','耶雷弗前庭 in00 must face the dock');
  assert.equal(byId.get('310000010').portals.find(p=>p.name==='out00').targetMapId,'310000000','埃德爾斯坦码头 out00 must enter the town');
}
// 飞行船航线三期（2026-09-15）：玩具城⇄天空之城线。九张图按源装配；登船在
// 两端的碼頭（剪票员站在码头上），售票处/港口通道只报班次与引路；船图在源里
// 没有船舱也没有舱门，到站是服务端强制传送，所以这里只钉静态门与 returnMap。
// 关键一条是天空之城售票处 `east00`（pt:7 `station_in`，脚本体缺失）：它的
// P 级路由目标 200000120 港口通道的 `west00` 必须逐字回指 200000100/east00，
// 否则那扇门就是凭空多出来的方向。
{
  const byId=new Map(catalog.maps.map(map=>[map.id,map]));
  for(const id of [
    '220000100','220000110',
    '200000120','200000121',
    '200090100','200090110',
    '200000000','200000001','200000002',
  ]) assert(byId.has(id),`phase-3 ship map must be assembled: ${id}`);
  // 源静态 pt:2 门：玩具城售票处 ⇄ 碼頭，港口通道 → 碼頭，两家商店 ⇄ 城内。
  for(const [from,name,to,gate] of [
    ['220000000','station00','220000100','out00'],
    ['220000100','out00','220000000','station00'],
    ['220000100','east00','220000110','west00'],
    ['220000110','west00','220000100','east00'],
    ['200000120','east00','200000121','west00'],
    ['200000121','west00','200000100','east00'],
    ['200000100','west00','200000000','top00'],
    ['200000000','top00','200000100','west00'],
    ['200000000','in00','200000001','out00'],
    ['200000000','in01','200000002','out00'],
    ['200000001','out00','200000000','in00'],
    ['200000002','out00','200000000','in01'],
  ]) {
    const portal=byId.get(from).portals.find(p=>p.name===name);
    assert(portal,`${from}/${name} must exist`);
    assert.equal(portal.targetMapId,to,`${from}/${name} must target ${to}`);
    assert.equal(portal.targetPortalName,gate,`${from}/${name} must land on ${gate}`);
  }
  // 售票处 east00 是 pt:7 脚本门（`station_in`），源里没有静态目标——服务端
  // ship.rs 的 P 级路由必须落在 200000120 的 west00，而港口通道的 west00 必须
  // 回指它（源邻接证据）。两端一起钉，缺一条都是伪造映射。
  const stationIn=byId.get('200000100').portals.find(p=>p.name==='east00');
  assert.equal(stationIn.type,7,'售票处 east00 must stay a script gate in the source');
  assert.equal(stationIn.targetMapId,null,'售票处 east00 must have no static target');
  assert.equal(stationIn.script,'station_in');
  assert.equal(byId.get('200000120').portals.find(p=>p.name==='west00').targetPortalName,'east00',
    '港口通道 west00 must name the 售票处 east00 gate the server routes into it');
  for(const [map,returnMap] of [
    ['220000100','220000000'],['220000110','220000000'],
    ['200000120','200000000'],['200000121','200000000'],
    ['200090100','200000100'],['200090110','220000100'],
    ['200000000','200000000'],['200000001','200000000'],['200000002','200000000'],
  ]) {
    assert.equal(catalog.returnMaps[map],returnMap,`${map} returnMap drifted`);
    assert(catalog.maps.some(candidate=>candidate.id===returnMap),
      `phase-3 returnMap must resolve inside the catalog: ${map} -> ${returnMap}`);
  }
  // 两张船图在源里只有出生点：多一扇门就等于给玩家一条源里不存在的下船路。
  for(const deck of ['200090100','200090110'])
    assert.deepEqual(byId.get(deck).portals.map(p=>p.name).sort(),['sp'],
      `${deck} must ship only its spawn point`);
  // 检票员必须站在检票地图（码头）上；售票员站在售票处。
  for(const [map,template] of [
    ['220000110','2041000'],['200000121','2012013'],['220000100','2040000'],
    ['200000001','2012003'],['200000001','2012004'],['200000002','2012005'],
  ]) assert(gameplay.npcSpawns.some(spawn=>spawn.mapId===map&&spawn.templateId===template),
    `${template} must stand on ${map}`);
  // 天空之城两家源商店：Shop 行来自 data/Shop/*.json，商店必须随 NPC 挂上。
  const itemDefs=read('shared/items.json');
  for(const [shopId,template,map] of [['2012003','2012003','200000001'],['2012004','2012004','200000001'],['2012005','2012005','200000002']]) {
    const npc=gameplay.npcs.find(entry=>entry.templateId===template);
    assert(npc,`shop NPC ${template} must be assembled`);
    assert.equal(npc.shopId,shopId,`${template} must carry its source Shop row`);
    const shop=gameplay.shops.find(entry=>entry.shopId===shopId);
    assert(shop,`Shop row ${shopId} must be assembled`);
    assert(shop.items.length>0,`Shop row ${shopId} must sell something`);
    assert(shop.items.every(item=>itemDefs[item.itemId]),`every ${shopId} shelf item needs an item definition`);
    assert(gameplay.npcSpawns.some(spawn=>spawn.mapId===map&&spawn.templateId===template),`${template} must stand on ${map}`);
  }
  // 玩具城 ⇄ 售票处 的步行入口必须真的双向可达（本模块让玩具城第一次接上海路）。
  assert.equal(byId.get('220000000').portals.find(p=>p.name==='station00').targetMapId,'220000100',
    '玩具城 station00 must enter the ticket hall');
}
// 愛奧斯塔（Eos Tower）與地球防衛本部（路德斯湖街）步行链路（2026-09-15，审计 T06）。
// 玩具城第一次接上塔与湖街：城 `west00` → 村莊 `east00`、村莊 `west00` →
// 愛奧斯塔入口 `east00`；入口 `tower00` 直接上 100樓，塔身逐层下行到 1樓，
// 1樓 `under00` 落到地球防衛總部安全地帶，再由安全地帶接地球防衛本部城镇。
// 全程源内静态门，无 P 级路由——所以这里钉的是门的目标与落点，不是路由。
{
  const byId=new Map(catalog.maps.map(map=>[map.id,map]));
  const gate=(map,name)=>{
    const found=byId.get(map)?.portals.find(entry=>entry.name===name);
    assert(found,`${map}/${name} must exist`);
    return found;
  };
  // 1~100 樓自下而上，三段分組梯層（11~30/36~65/71~90 樓）各占一个槽位。
  const floors=[
    '221020000','221020100','221020200','221020300','221020400',
    '221020500','221020600','221020700','221020800','221020900',
    '221021000','221021100','221021200','221021300','221021400','221021500',
    '221021600','221021700','221021800','221021900','221022000','221022100',
    '221022200','221022300','221022400','221022500','221022600','221022700',
    '221022800','221022900','221023000','221023100','221023200',
  ];
  for(const floor of floors) assert(byId.has(floor),`愛奧斯塔楼层必须装配: ${floor}`);
  // 逐层不变式：本层 `top00` 上行到上一层（源里落 `st01` 或 `under00`，视该段
  // 用的是接触门还是静态门），上一层的 `under00` 原路下行回本层。任何一层错位
  // 都会让塔断成两截，这里逐段核出是哪一段。
  for(let index=0;index<floors.length-1;index+=1) {
    const lower=floors[index],upper=floors[index+1];
    assert.equal(gate(lower,'top00').targetMapId,upper,`${lower}/top00 must climb to ${upper}`);
    assert.equal(gate(upper,'under00').targetMapId,lower,`${upper}/under00 must descend to ${lower}`);
  }
  // 塔的两端：入口 `tower00` 进 100樓，100樓 `top00` 原路出塔；1樓 `under00`
  // 落到安全地帶，安全地帶 `tower00` 回 1樓。
  for(const [from,name,to,landing] of [
    ['220000000','west00','220000300','east00'],
    ['220000300','west00','220000400','east00'],
    ['220000300','east00','220000000','west00'],
    ['220000400','tower00','221023200','top00'],
    ['221023200','top00','220000400','tower00'],
    ['221020000','under00','221000400','tower00'],
    ['221000400','tower00','221020000','under00'],
    ['221000400','west00','221000000','east00'],
    ['221000000','east00','221000400','west00'],
  ]) {
    assert.equal(gate(from,name).targetMapId,to,`${from}/${name} must target ${to}`);
    assert.equal(gate(from,name).targetPortalName,landing,`${from}/${name} must land on ${landing}`);
  }
  // 上塔是可见门、塔内爬升是接触门：源里 100樓 横向回入口是 pt:2，
  // 99樓→100樓 是 pt:3（与原版"走进门口即换层、不算传送门"一致）。
  assert.equal(gate('220000400','tower00').type,2,'愛奧斯塔入口 tower00 must stay a visible gate');
  assert.equal(gate('221023100','top00').type,3,'99樓 top00 must stay a contact gate');
  // 地球防衛本部城内门链：主控室、通道（对侧门）、司令室，双向都指回上一间。
  for(const [from,name,to,landing] of [
    ['221000000','in00','221000100','out00'],
    ['221000100','out00','221000000','in00'],
    ['221000000','in01','221000001','out00'],
    ['221000001','out00','221000000','in01'],
    ['221000001','in00','221000100','out01'],
    ['221000100','out01','221000001','in00'],
    ['221000000','pt99','221000300','pt00'],
    ['221000100','in04','221000300','out00'],
    ['221000300','out00','221000100','in04'],
  ]) {
    assert.equal(gate(from,name).targetMapId,to,`${from}/${name} must target ${to}`);
    assert.equal(gate(from,name).targetPortalName,landing,`${from}/${name} must land on ${landing}`);
  }
  // 隱藏之塔挂在 4樓（源 pt:10 同族门，双向配对）。
  assert.equal(gate('221020300','in00').targetMapId,'221020701');
  assert.equal(gate('221020300','in00').targetPortalName,'out00');
  assert.equal(gate('221020701','out00').targetMapId,'221020300');
  assert.equal(gate('221020701','out00').targetPortalName,'in00');
  // returnMap 必须落在已装配城镇，塔内/本部内死亡复活不会落到未收录图。
  for(const map of ['220000300','220000400','221020000','221020701','221023200'])
    assert.equal(catalog.returnMaps[map],'220000000',`${map} must return to 玩具城`);
  for(const map of ['221000001','221000100','221000300','221000400'])
    assert.equal(catalog.returnMaps[map],'221000000',`${map} must return to 地球防衛本部`);
  // 源里没有 walk 动画的固定怪（2230103 黃蜘蛛 / 2230104 紅蜘蛛，只在 94樓）：
  // 动作表保留空 `move`、运行时不得冒出 `moveDurationMs`，否则服务端
  // `monsters.rs::movement_force` 会把它当能走的怪按默认速度推着跑。
  for(const id of ['2230103','2230104']) {
    assert.equal(manifest.monsters[id].actions.move.length,0,`${id} 源内没有 move 动画`);
    assert(manifest.monsters[id].actions.stand.length,`${id} 必须有 stand 动画`);
    const template=gameplay.monsters.find(mob=>mob.templateId===id);
    assert.equal(template?.moveDurationMs,undefined,`${id} 不得有 moveDurationMs`);
    assert(!template?.speed,`${id} 源内没有 speed`);
  }
}

// 楓之島災禍篇 36315 的最小场景执行（P，2026-09-14，适配器 scripts/tms273_calamity.cjs）。
// 36315 的完成是一次**已核定的击杀**（源 QuestInfo「擊殺藍色蘑菇王」+ Check.1.infoex
// kill），可它的原版修練图 993166xxx 几何本地不可解，所以目标怪 8645261 在源 Map.life
// 里没有行；没有可击杀目标，任务规格再完整也永远完不成（审计 C02）。适配器把该模板显式
// 放到从出生图可达的 001010000，地形复用该图已有刷怪锚点。这里校验装配后的实际面：
// 台账→模板→刷怪→地形锚点→任务目标五者必须逐项对得上，P 内容不许悄悄长出来。
{
  const ledger=gameplay.compatibility.mapleIslandCalamity;
  assert(ledger&&ledger.placements.length,'calamity placement ledger is missing');
  const record=read('references/tms273-data/maple-island-calamity-source.json');
  const mapById=new Map(catalog.maps.map(map=>[String(map.id),map]));
  for(const placement of ledger.placements){
    const template=gameplay.monsters.find(mob=>String(mob.templateId)===placement.mobId);
    assert(template,`calamity monster template ${placement.mobId} was not assembled`);
    const spawnId=`${placement.mapId}-calamity-${placement.mobId}`;
    const spawn=gameplay.spawns.find(entry=>entry.id===spawnId);
    assert(spawn&&spawn.mapId===placement.mapId,`calamity spawn ${spawnId} is missing`);
    const map=mapById.get(String(placement.mapId));
    assert(map,`calamity map ${placement.mapId} is not assembled`);
    const foothold=map.footholds.find(line=>Number(line.id)===Number(spawn.footholdId));
    assert(foothold,`calamity spawn ${spawnId} has no assembled foothold to land on`);
    const low=Math.min(foothold.x1,foothold.x2),high=Math.max(foothold.x1,foothold.x2);
    assert(spawn.x>=low&&spawn.x<=high,`calamity spawn ${spawnId} x=${spawn.x} is off foothold ${foothold.id} (${low}..${high})`);
    // 只有已核定击杀目标才能被放置，且该任务必须真的可执行、真的带类型化击杀目标。
    const quest=record.quests.find(entry=>String(entry.id)===placement.questId);
    assert(quest&&quest.classification.kill&&String(quest.classification.kill.mobId)===placement.mobId,`calamity placement ${placement.questId} is not backed by the source record`);
    const runtimeQuest=gameplay.quests.find(entry=>String(entry.questId)===placement.questId);
    assert(runtimeQuest&&runtimeQuest.executable,`calamity quest ${placement.questId} must be executable`);
    assert(runtimeQuest.objectives.some(objective=>objective.kind==='kill'&&String(objective.mobId)===placement.mobId&&Number(objective.required)>0),`calamity quest ${placement.questId} must carry a typed kill objective`);
  }
}
// 源里没有 `move` 动作的怪（WZ 无该节点、`info` 无 speed，原版固定的怪，如
// 2230103 黃蜘蛛 / 2230104 紅蜘蛛）清单里 move 是空表，服务端 `movement_force`
// 据此判"不能移动"。所以刷怪校验拆成两条：`stand` 必须存在（客户端建精灵要用），
// `move` 的有无必须与运行时 `moveDurationMs` 一致——否则要么凭空走起来、
// 要么走路不播动画。
for(const spawn of gameplay.spawns) {
  const template=manifest.monsters[spawn.templateId];
  assert(template?.actions.stand.length,spawn.id);
  const runtime=gameplay.monsters.find(monster=>String(monster.templateId)===String(spawn.templateId));
  assert.equal(Boolean(template.actions.move.length),Boolean(runtime?.moveDurationMs),`${spawn.id} move 动画与 moveDurationMs 不一致`);
}
for(const spawn of gameplay.npcSpawns)assert(manifest.npcs[spawn.templateId]?.stand.length,spawn.id);
for(const shop of gameplay.shops)for(const entry of shop.items)assert(manifest.items[entry.itemId],entry.itemId);
for(const id of ['36301','36302','36303','36304','36306','36307'])assert(gameplay.quests.some(q=>q.questId===id));
const sourceQuests=read('references/tms273-data/quests.json').quests;
// 70 since the adventurer prerequisite set was widened to the full
// 1401/1403/1404/1405/2570/2684 group; the count is the source import's own
// contract and must be bumped with it, or the launcher's precheck stops here.
assert.equal(sourceQuests.length,70);
assert(sourceQuests.some(q=>q.id==='1402' && !q.executable));
// 15 是开场六项 + 续章九项。后续章节适配器再补三条源可判定任务：36316 / 36332
// （续章与重制）以及 36315（災禍篇首条——它的击杀目标 8645261 由 P 场景执行放进
// 世界后，kill-target-missing 才解除，见上面的災禍篇断言）。数量变化必须来自源
// 适配器的显式改动，不能靠手改 JSON。
// 18 since the 災禍篇 36315 joined; the 2026-09-14 艾靈森林 region brought
// 36341-36366's 16 quests in (source has no job restriction there — the
// adapter's empty-job misclassification was fixed with the region).
assert.equal(gameplay.quests.filter(q=>q.executable).length,34);
{
  const remaster = gameplay.quests.filter(q=>q.ruleVersion==='tms273-remaster-p1');
  assert.equal(remaster.length,55);
  assert.deepEqual(remaster.filter(q=>q.executable).map(q=>q.questId),[
    '36315','36316','36332',
    // 艾靈森林编年史：进入三连（圖書館/時間監控室/小森林）+ 营地与森林段 +
    // 两个击杀段（含碴烏 36357 与艾畢奈亞 36360 的首領房）+ 收尾（36366 回圖書館）。
    '36341','36342','36343','36345','36346','36348','36349',
    '36354','36355','36356','36357','36358','36359','36360','36361','36366',
  ]);
  for(const quest of remaster) if(!quest.executable) assert(quest.blockedBy.length>0,`${quest.questId} must record a block reason`);
  assert(gameplay.compatibility.adventurerRemaster.unknown.startsWith('q36315'));
}
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
// 自愈来源＝装配的上游 resources/tms273-export。client/public-tms273 与 resources/ 都不被
// git 跟踪，本仓库又躺在 iCloud 同步盘里：2026-09-12 出现过同一个装配 PNG 在数分钟内被外界
// 删除两次。此前靠 build/current/client 的构建副本来补，该副本已随「内容数据不进构建产物」的
// 改造取消（见 client/vite.config.ts），改为直接用导出源——同为逐字节相同的文件，且不依赖
// 构建状态、永远比构建副本新。
// 按原路径一一对应即可：导出源 72156 个文件覆盖装配产物 70463 个中的 70462 个（实测差集只有
// 一个不被任何清单引用的孤儿副本），而这里只校验清单引用到的路径。
function healSourceFor(value) {
  const exact=path.join(root,'resources/tms273-export',value);
  if(fs.existsSync(exact)&&fs.statSync(exact).size>0)return exact;
  return null;
}
function visit(value) {
  if(typeof value==='string'&&value.startsWith('/assets/')) {
    assert(value.startsWith('/assets/tms273/'),value);
    const asset=path.join(root,'client/public-tms273',value);
    let size;
    try { size=fs.statSync(asset).size; }
    catch {
      const twin=healSourceFor(value);
      if(twin) {
        fs.mkdirSync(path.dirname(asset),{recursive:true});
        fs.copyFileSync(twin,asset);
        size=fs.statSync(asset).size;
        healed++;
      } else {
        throw new Error(`装配资源缺失且导出源里也没有: ${value}\n  修复提示: 重跑装配脚本，不要改本 check`);
      }
    }
    assert(size>0,value);checked++;
  } else if(value&&typeof value==='object')for(const child of Object.values(value))visit(child);
}
visit(manifest);
console.log(`TMS273 runtime: ${catalog.maps.length} maps; ${checked} source references; client/server geometry and quest generation agree.`);
if(healed>0)console.log(`注意: ${healed} 个装配资源在 public-tms273 里缺失，已从导出源 resources/tms273-export 自动补回（本仓库在 iCloud 盘，资源会无故消失；若反复出现请把仓库移出同步盘或排除 client/public-tms273）。`);

// 宠物（TMS273 Item/Pet）：装配清单必须携带与导出一致的宠物目录与精灵。
// 目录规模在这里钉住：pets.json（名字/属性）与 pet-images.json（帧）都来自
// export_tms273_pet.cjs，一旦某次导出意外缩水，装配与运行时能在启动前发现。
{
  const pets=read('shared/pets.json');
  const petImages=manifest.pets ?? {};
  assert.equal(Object.keys(pets).length,990,'shared/pets.json 宠物目录规模变化：确认导出后同步更新本断言');
  // manifest.pets 允许比 pets.json 多出 8 位填充别名（05000000）：现金商店
  // 图标循环（assemble_tms273.cjs）会对与真宠物 id 相撞的 cash itemIcons 补
  // `padStart(8)` 别名，帧与本体完全一致。除别名外必须与 pets.json 逐条一致，
  // 否则视为导出意外缩水/膨胀。
  {
    const petIds=new Set(Object.keys(pets));
    for(const [id,frame] of Object.entries(petImages)) {
      if(petIds.has(id))continue;
      const canonical=String(Number(id));
      assert(petIds.has(canonical)&&JSON.stringify(frame)===JSON.stringify(petImages[canonical]),`manifest.pets 出现非宠物别名的条目: ${id}`);
    }
    for(const id of petIds)assert(petImages[id],`manifest.pets 缺少宠物: ${id}`);
  }
  const first=petImages['5000000'];
  assert(first&&first.name==='褐色小貓'&&first.stand.length>0&&first.move.length>0,'宠物 5000000 装配不完整');
  assert(first.icon.url.startsWith('/assets/tms273/'));
  assert.equal(manifest.petUi?.sourceNode, 'UI/UIWindow2.img/UserInfo/pet');
  assert.equal(manifest.petUi.window.width, 271);
  assert.equal(manifest.petUi.window.tabs.enabled.length, 3);
  assert.equal(manifest.petUi.window.tabs.disabled.length, 3);
  for (const name of ['backgrnd', 'backgrnd2', 'backgrnd3']) {
    assert(manifest.petUi.window.ui[`panel/${name}`]?.url, `pet panel missing ${name}`);
  }
  assert(manifest.petUi.buttons.character.normal.url, 'pet menu entry art missing');
}

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
  // The archive authors no spot at all for these maps, so they are the only
  // assembled maps the window legitimately cannot mark.  Anything else missing
  // is a bug.  002010000 is the ship/travel staging map; 104020130 (前往埃德爾
  // 斯坦站台) is the one flight-station room `Map.wz WorldMap010.json` omits —
  // it authors spots for 104020100/110/120 only.  The four airship rooms
  // (200090xxx 甲板/船舱) arrived with the 2026-09-14 flying-ship route and
  // sit inside the Orbis spot's own area, so the archive marks none of them.
  const WORLD_MAP_ABSENT=new Set([
    '002010000','104020130','100030400','310040210',
    '200090000','200090001','200090010','200090011',
    // 飞行船二期（2026-09-14）：耶雷弗船图 130090000、埃德爾斯坦船图
    // 2000906xx 与天空之城码头 200000170 同样没有源 spot（船图随 200090xxx
    // 一期先例整组缺席）。
    '130090000','200000170','200090600','200090601','200090610','200090611',
    // 艾靈森林章节（2026-09-14）：時間監控室 222020400 与 104020130 同类——
    // WorldMap 归档不给它源 spot（圖書館与过去侧各图均有收录）。
    '222020400',
    // 飞行船三期（2026-09-15）：玩具城⇄天空之城的两张船图 200090100/
    // 200090110 与 200090xxx 整组同源——归档不给航海图任何 spot（这一层
    // 由 `export_tms273_worldmap.cjs::selectPages` 穷举归档全部页面判定，
    // 不是只看了导出的那几页：任何页面只要列到这两个 id 就会被拉进导出集）。
    '200090100','200090110',
    // 愛奧斯塔/地球防衛本部（2026-09-15）：隱藏之塔 221020701 是隐藏图，
    // 归档不给它 spot（同 222020400 的城市隐藏图先例）；其余 40 张新图——
    // 玩具城村莊/愛奧斯塔入口、塔身 1~100 樓、地球防衛本部全簇——都在源 spot 里。
    '221020701',
    // 危險地帶/UFO 街（2026-09-15）：走廊105 被源切成两段 221030550/221030551，
    // 而 WorldMap035 给 UFO 内部逐图列 spot 时**只跳过了这两段**——同一 spot 的
    // mapIds 从 221030540 直接跳到 221030600（Archiv 事实，逐图枚举过，非装配漏项）。
    // 与 221020701 同性质：源没给 spot，归档就没有它。
    '221030550','221030551',
  ]);
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
