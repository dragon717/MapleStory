// Export the selected 273 maps and UI from their own WZ files; no v83 fallback.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const wz = require('@tybys/wz');
const { createReader } = require('./tms273_wz.cjs');
const root = path.resolve(__dirname, '..');
const data = path.join(root, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const output = path.join(root, 'resources/tms273-export');
const assets = path.join(output, 'assets/tms273');
const bossEffectsAssets = path.join(assets, 'boss-effects');
const unpacker = path.join(root, 'scripts/unpack_tms273_ms/target/debug/unpack_tms273_ms');
const mobSkillSourceJson = path.join(root, '参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW/Skill/MobSkill');
const reader = createReader(data, path.join(output, 'ms'));
// The first Victoria boss was unpacked separately from the same TMS273.7 MS
// archive flow because it is not placed in the 30-map life catalog.  Keep the
// source reader pointed at that real image; do not synthesize boss frames.
const bossReader = createReader(data, '/tmp/tms273-inspect-boss');
const children = n => [...(n?.wzProperties || [])];
const val = (n, k, fallback = 0) => n?.at?.(k)?.wzValue ?? fallback;
const numeric = n => children(n).filter(c => /^\d+$/.test(c.name)).sort((a, b) => Number(a.name) - Number(b.name));
const save = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + '\n', 'utf8');
async function get(source) {
  try {
    const n = await reader.get(source);
    if (n instanceof wz.WzImage) assert(await n.parseImage(), source);
    return n;
  } catch (error) { throw new Error(`${source}: ${error.message}`, { cause: error }); }
}
function resolved(n) {
  const seen = new Set();
  while (n instanceof wz.WzUOLProperty) {
    assert(!seen.has(n), 'UOL cycle'); seen.add(n); n = n.linkValue;
  }
  return n;
}
const exported = new Map();
async function frameFrom(resourceReader, source) {
  const cacheKey = resourceReader === reader ? source : `boss\0${source}`;
  if (!exported.has(cacheKey)) {
    const f = await resourceReader.frame(source, assets);
    assert(f.width > 0 && f.height > 0 && Number.isFinite(f.delay) && f.delay > 0, source);
    exported.set(cacheKey, { ...f, url: '/assets/tms273/' + f.url });
    if (exported.size % 25 === 0) console.log(`273 exported ${exported.size} source frames`);
  }
  return exported.get(cacheKey);
}
async function frame(source) { return frameFrom(reader, source); }

const bossEffectFrames = new Map();
function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function relative(file) {
  return path.relative(root, path.resolve(file)).split(path.sep).join('/');
}
function jsonValue(value) {
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : String(value);
  }
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === 'object') {
    if (Number.isFinite(Number(value.x)) && Number.isFinite(Number(value.y))) {
      return { x: Number(value.x), y: Number(value.y) };
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]));
  }
  return value;
}
function authoredFields(node) {
  const fields = {};
  for (const child of children(node)) {
    if (/^\d+$/.test(child.name)) continue;
    const value = child.wzValue;
    if (value === null || value === undefined) continue;
    const converted = jsonValue(value);
    if (['string', 'number', 'boolean'].includes(typeof converted)
      || converted === null
      || (converted && typeof converted === 'object' && Number.isFinite(converted.x) && Number.isFinite(converted.y))) {
      fields[child.name] = converted;
    }
  }
  return fields;
}
async function bossFrame(resourceReader, source) {
  const cacheKey = `${resourceReader.dataRoot}\0${source}`;
  if (!bossEffectFrames.has(cacheKey)) {
    const raw = await resourceReader.get(source);
    const rendered = await resourceReader.frame(source, bossEffectsAssets);
    assert(rendered.width > 0 && rendered.height > 0 && Number.isFinite(rendered.delay) && rendered.delay > 0, source);
    assert(rendered.url, `missing boss PNG: ${source}`);
    const file = path.join(bossEffectsAssets, rendered.url);
    assert(fs.existsSync(file), `missing boss PNG file: ${file}`);
    bossEffectFrames.set(cacheKey, {
      ...rendered,
      url: '/assets/tms273/boss-effects/' + rendered.url,
      rawDelay: raw.at?.('delay')?.wzValue ?? null,
      outlink: raw.at?.('_outlink')?.wzValue ?? null,
      sha256: sha256File(file),
    });
  }
  return bossEffectFrames.get(cacheKey);
}
async function getFrom(resourceReader, source) {
  try {
    const n = await resourceReader.get(source);
    if (n instanceof wz.WzImage) assert(await n.parseImage(), source);
    return n;
  } catch (error) { throw new Error(`${source}: ${error.message}`, { cause: error }); }
}
// 源里确实没有这个节点时返回 null（而不是抛错）。只吞 reader 的"找不到节点"，
// 解包损坏、PNG 缺失一类的真错误继续抛出去。用途见 `exportEntities` 的可选动作。
const MISSING_NODE = '找不到 273 WZ 节点';
async function optionalFrom(resourceReader, source) {
  try {
    return await getFrom(resourceReader, source);
  } catch (error) {
    if (String(error.message).includes(MISSING_NODE)) return null;
    throw error;
  }
}
async function framesFrom(resourceReader, source) {
  const n = resolved(await getFrom(resourceReader, source));
  if (n instanceof wz.WzCanvasProperty) return [await frameFrom(resourceReader, source)];
  const nodes = numeric(n);
  assert(nodes.length, `No drawable animation: ${source}`);
  const result = [];
  for (const c of nodes) result.push(await frameFrom(resourceReader, source + '/' + c.name));
  return result;
}
async function frames(source) { return framesFrom(reader, source); }

const bossEffectSpecs = [
  { skillId: '112', level: 1 },
  { skillId: '113', level: 1 },
  { skillId: '114', level: 15 },
];

function linkMobSkillCanvasArchives(tempRoot) {
  const sourceDir = path.join(data, 'Skill/MobSkill/_Canvas');
  const targetDir = path.join(tempRoot, 'Skill/MobSkill/_Canvas');
  fs.mkdirSync(targetDir, { recursive: true });
  const archives = fs.readdirSync(sourceDir).filter(name => name.endsWith('.wz')).sort();
  assert(archives.length, `missing MobSkill Canvas archives: ${sourceDir}`);
  for (const name of archives) fs.symlinkSync(path.join(sourceDir, name), path.join(targetDir, name));
  return archives.map(name => `Skill/MobSkill/_Canvas/${name}`);
}

function unpackMobSkillImages(tempRoot) {
  assert(fs.existsSync(unpacker), `missing MS unpacker: ${unpacker}`);
  const images = bossEffectSpecs.map(({ skillId }) => `Skill/MobSkill/${skillId}.img`);
  const result = spawnSync(unpacker, [
    '--packs', path.join(data, 'Packs'), '--out', tempRoot,
    ...images.flatMap(image => ['--image', image]),
  ], { encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `MobSkill image unpack failed:\n${result.stdout}\n${result.stderr}`);
  const manifestPath = path.join(tempRoot, 'manifest.json');
  assert(fs.existsSync(manifestPath), `missing MobSkill unpack manifest: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const image of images) {
    const entry = manifest.entries?.find(item => item.image === image && item.status === 'ok');
    assert(entry && fs.existsSync(path.join(tempRoot, image)), `${image} was not unpacked`);
  }
  linkMobSkillCanvasArchives(tempRoot);
  return manifest;
}

function drawableGroupNames(levelNode) {
  return children(levelNode)
    .filter(child => !/^\d+$/.test(child.name))
    .filter(child => {
      const value = child.wzValue;
      if (value !== null && value !== undefined && (typeof value !== 'object' || value.x === undefined || value.y === undefined)) return false;
      const group = resolved(child);
      return group instanceof wz.WzCanvasProperty || numeric(group).length > 0;
    })
    .map(child => child.name);
}

async function exportBossEffects() {
  fs.mkdirSync(bossEffectsAssets, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tms273-boss-effects-'));
  let skillReader;
  try {
    const unpackManifest = unpackMobSkillImages(tempRoot);
    skillReader = createReader(tempRoot, tempRoot);
    const bossEffects = {};
    const metadata = {};
    for (const { skillId, level } of bossEffectSpecs) {
      const source = `Skill/MobSkill/${skillId}.img`;
      const levelSource = `${source}/level/${level}`;
      const levelNode = resolved(await getFrom(skillReader, levelSource));
      const imageFile = path.join(tempRoot, source);
      const sourceJsonFile = path.join(mobSkillSourceJson, `${skillId}.json`);
      assert(fs.existsSync(imageFile), `missing unpacked MobSkill source: ${imageFile}`);
      assert(fs.existsSync(sourceJsonFile), `missing MobSkill JSON source: ${sourceJsonFile}`);
      const sourceHash = sha256File(sourceJsonFile);
      const binaryHash = sha256File(imageFile);
      const unpackEntry = unpackManifest.entries.find(item => item.image === source);
      const archive = unpackEntry?.archive && fs.existsSync(unpackEntry.archive) ? unpackEntry.archive : null;
      const skillMetadata = {
        source,
        level,
        sourceHash,
        sourceSha256: sourceHash,
        binarySha256: binaryHash,
        sourceJson: { path: relative(sourceJsonFile), bytes: fs.statSync(sourceJsonFile).size, sha256: sourceHash },
        sourceImage: { path: source, bytes: fs.statSync(imageFile).size, sha256: binaryHash },
        sourceArchive: archive ? { path: relative(archive), bytes: fs.statSync(archive).size, sha256: sha256File(archive) } : null,
        levelFields: authoredFields(levelNode),
        groups: {},
      };
      const groups = {};
      for (const groupName of drawableGroupNames(levelNode)) {
        const groupSource = `${levelSource}/${groupName}`;
        const groupNode = resolved(await getFrom(skillReader, groupSource));
        const frameNodes = numeric(groupNode);
        const frames = [];
        for (const node of frameNodes) {
          const frameSource = `${groupSource}/${node.name}`;
          frames.push(await bossFrame(skillReader, frameSource));
        }
        assert(frames.length, `${groupSource} has no drawable frames`);
        groups[groupName] = frames;
        skillMetadata.groups[groupName] = {
          source: groupSource,
          fields: authoredFields(groupNode),
          frameCount: frames.length,
          status: 'source-backed',
        };
      }
      // The selected 114/15 level has no effect group in TMS273.7.  Keep the
      // missing source explicit so consumers cannot silently invent a frame.
      for (const groupName of ['effect', 'mob', 'mob0']) {
        if (!skillMetadata.groups[groupName]) {
          skillMetadata.groups[groupName] = {
            source: `${levelSource}/${groupName}`,
            fields: null,
            frameCount: 0,
            status: 'source-missing',
          };
        }
      }
      bossEffects[skillId] = groups;
      metadata[skillId] = skillMetadata;
      console.log(`273 MobSkill ${skillId} level ${level}: ${Object.entries(groups).map(([name, frames]) => `${name}=${frames.length}`).join(', ')}`);
    }
    save('boss-effects.json', {
      schemaVersion: 1,
      contentVersion: 'tms273',
      source: 'TMS273.7 client WZ / Data/Packs',
      sourceImages: bossEffectSpecs.map(({ skillId }) => `Skill/MobSkill/${skillId}.img`),
      metadata,
      bossEffects,
    });
  } finally {
    if (skillReader) skillReader.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
function geometry(map, id) {
  const info = map.at('info'), footholds = [];
  function visit(n, p) {
    if (typeof val(n, 'x1', null) === 'number') {
      footholds.push({ id: Number(n.name), path: p, ...Object.fromEntries(['x1','y1','x2','y2','prev','next','forbidFallDown'].map(k => [k,val(n,k)])) });
    } else for (const c of children(n)) visit(c, p + '/' + c.name);
  }
  visit(map.at('foothold'), 'foothold');
  const portals = numeric(map.at('portal')).map(n => ({
    name: val(n,'pn',''), type: val(n,'pt'), x: val(n,'x'), y: val(n,'y'),
    targetMapId: val(n,'tm',999999999) === 999999999 ? null : String(val(n,'tm')).padStart(9,'0'),
    targetPortalName: val(n,'tn','') || null, script: val(n,'script',''), onlyOnce: Boolean(val(n,'onlyOnce')),
  }));
  const spawns = portals.filter(p => p.name === 'sp').map((p,i) => ({id:`sp-${i}`,x:p.x,y:p.y}));
  const ladders = numeric(map.at('ladderRope')).map(n => ({id:Number(n.name), ...Object.fromEntries(['l','uf','x','y1','y2','page'].map(k=>[k,val(n,k)]))}));
  let bounds = Object.fromEntries([['xMin','VRLeft'],['xMax','VRRight'],['yMin','VRTop'],['yMax','VRBottom']].map(([k,v])=>[k,val(info,v,null)]));
  if (!Object.values(bounds).every(Number.isFinite)) {
    const minimap=map.at('miniMap');
    const [w,h,cx,cy]=['width','height','centerX','centerY'].map(k=>val(minimap,k,null));
    assert([w,h,cx,cy].every(Number.isFinite) && w>0 && h>0,`Missing authored bounds: ${id}`);
    bounds={xMin:-cx,xMax:w-cx,yMin:-cy,yMax:h-cy};
  }
  // WZ scalar subtraction can preserve a signed zero.  It is the same
  // authored world coordinate, but strict metadata comparison would reject
  // -0 against the JSON source's 0.
  bounds=Object.fromEntries(Object.entries(bounds).map(([key,value]) => [key, Object.is(value,-0) ? 0 : value]));
  assert(spawns.length && footholds.length && Object.values(bounds).every(Number.isFinite), `Missing geometry: ${id}`);
  return {id, name:id, streetName:'', assetStatus:'rendered', source:`TMS273/Map/Map/Map${id[0]}/${id}.img`, bounds, spawn:spawns[0], spawns, footholds, ladders, portals,
    bgmSource:val(info,'bgm',''), entryScripts:{first:val(info,'onFirstUserEnter',''),each:val(info,'onUserEnter','')}};
}
async function exportMap(id) {
  const map = await get(`Map/Map/Map${id[0]}/${id}.img`);
  const result = geometry(map,id), layers=[];
  async function layer(source, entry) {
    const animation = await frames(source), first=animation[0];
    layers.push({...entry, source, url:first.url, origin:first.origin, width:first.width, height:first.height,
      x:entry.x-first.origin.x, y:entry.y-first.origin.y, ...(animation.length>1 ? {frames:animation}: {})});
  }
  for(const n of numeric(map.at('back'))) {
    const bS=val(n,'bS','');if(!bS)continue;
    const ani=val(n,'ani'), no=val(n,'no');
    const background=Object.fromEntries(['x','y','rx','ry','cx','cy','type','front','ani','f'].map(k=>[k,val(n,k)]));
    assert(ani===0 || ani===1, `Unsupported background animation ${ani}: ${id}/${n.name}`);
    await layer(`Map/Back/${bS}.img/${ani?'ani':'back'}/${no}`,{key:`back-${id}-${n.name}`,x:background.x,y:background.y,depth:background.front?10000:-1000+Number(n.name),alpha:val(n,'a',255),background,type:background.type});
  }
  for(const l of numeric(map)) {
    const tS=val(l.at('info'),'tS','');
    for(const n of numeric(l.at('tile'))) {
      const m=Object.fromEntries(['x','y','u','no','zM'].map(k=>[k,val(n,k)]));
      const source=`Map/Tile/${tS}.img/${m.u}/${m.no}`;
      const tile=resolved(await get(source));
      await layer(source,{key:`tile-${l.name}-${n.name}`,x:m.x,y:m.y,depth:Number(l.name)*100+m.zM*10+val(tile,'z'),flip:Boolean(val(n,'f')),mapTile:{layer:Number(l.name),...m}});
    }
    for(const n of numeric(l.at('obj'))) {
      const m=Object.fromEntries(['oS','l0','l1','l2','x','y','z','zM'].map(k=>[k,val(n,k)]));
      await layer(`Map/Obj/${m.oS}.img/${m.l0}/${m.l1}/${m.l2}`,{key:`obj-${l.name}-${n.name}`,x:m.x,y:m.y,depth:Number(l.name)*100+m.zM*10+m.z,flip:Boolean(val(n,'f')),mapObject:{layer:Number(l.name),...m}});
    }
  }
  assert(layers.some(l=>!l.background), `No map layers: ${id}`);
  console.log(`273 ${id}: ${layers.length} layers, ${layers.filter(l=>l.frames).length} animations`);
  return {...result,layers};
}
async function exportUi() {
  const ui={};
  async function walk(source,key,parents=new Set()) {
    const n=resolved(await get(source));
    if(n instanceof wz.WzCanvasProperty) {ui[key]=await frame(source);return;}
    assert(!parents.has(n),`Cyclic UI source: ${source}`);
    const ancestors=new Set(parents).add(n);
    for(const c of children(n)) await walk(source+'/'+c.name,key+'/'+c.name,ancestors);
  }
  // Source-keyed modern status bar; consumers keep the original source proportions.
  for(const section of ['mainBar/status/backgrnd','mainBar/status/layer:cover','mainBar/status/layer:Lv','mainBar/status/lvNumber','mainBar/status/gauge/number','mainBar/status/gauge/hp/layer:0','mainBar/status/gauge/mp/layer:0','mainBar/menu/button:CashShop','mainBar/menu/button:Event','mainBar/menu/button:Character','mainBar/menu/button:Community','mainBar/menu/button:Setting','mainBar/menu/button:Menu','mainBar/quickSlot/backgrnd','mainBar/EXPBar']) {
    await walk('UI/StatusBar3.img/'+section,section);
  }
  return ui;
}
async function exportWindows() {
  const result={};
  async function walk(source, target, key='') {
    const n=resolved(await get(source));
    if(n instanceof wz.WzCanvasProperty) {target[key]=await frame(source);return;}
    for(const c of children(n)) await walk(source+'/'+c.name,target,key?key+'/'+c.name:c.name);
  }
  for(const [key,source] of Object.entries({
    dialogUi:'UI/UIWindow2.img/UtilDlgEx', shopUi:'UI/UIWindow2.img/Shop',
    closeButton:'UI/Basic.img/BtClose', tabUi:'UI/Basic.img/Tab2',
    noticeUi:'UI/Basic.img/Notice', okButton:'UI/Basic.img/BtOK',
  })) {result[key]={};await walk(source,result[key]);}
  const source='UI/UITotalMenu.img/main', ui={};
  for(const key of ['backgrnd','button:close','menu/buttonInfo','button:gameQuit']) await walk(source+'/'+key,ui,key);
  const menu=await get(source+'/menu'),start=val(menu,'vector:startPos'),entries=[];
  for(const column of numeric(menu.at('buttonInfo'))) for(const row of numeric(column)) entries.push({
    key:`menu/buttonInfo/${column.name}/${row.name}`,label:val(row,'info',''),type:val(row,'type'),
    x:start.x+Number(column.name)*val(menu,'offsetX'), y:start.y+Number(row.name)*val(menu,'offsetY'),
  });
  result.totalMenuUi=ui;result.totalMenuEntries=entries;
  result.questUi={};
  const questSource='UI/Quest.img/Main/questList';
  for(const key of ['backgrnd','button:close','tab:categoryTab']) await walk(questSource+'/'+key,result.questUi,key);
  const quest=await get(questSource);
  result.questLayout={listLT:val(quest,'vector:listLT'),listRB:val(quest,'vector:listRB')};
  save('windows.json',result);
}
async function exportEntities() {
  const maps=JSON.parse(fs.readFileSync(path.join(root,'references/tms273-data/maps.json'),'utf8')).maps;
  const result={npcs:{},monsters:{}};
  for(const [kind,folder,table] of [['n','Npc','npcs'],['m','Mob','monsters']]) {
    // Export every map life template, including map-hidden NPCs.  Placement
    // visibility remains in the map life record; dropping hidden templates
    // here would make legitimate server-side interactions impossible to load.
    const idsSet=new Set(maps.flatMap(m=>m.life.filter(l=>l.type===kind).map(l=>String(Number(l.id)))));
    // P practice-only Boss template, plus 36315's 核定击杀目标 8645261 藍色蘑菇王:
    // neither has an authored Map.life row (the source practice map 993166xxx is
    // not decodable locally), so they are exported explicitly.  See
    // scripts/tms273_calamity.cjs for the placement decision.
    if(kind==='m') for(const extra of ['3220000','8645261']) idsSet.add(extra);
    const ids=[...idsSet].sort((a,b)=>Number(a)-Number(b));
    for(const id of ids) {
      const source=`${folder}/${id.padStart(7,'0')}.img`;
      const entityReader=kind==='m'&&id==='3220000'?bossReader:reader;
      const node=await getFrom(entityReader, source), info=node.at('info');
      const link=val(info,'link',null), sprite=link?`${folder}/${String(link).padStart(7,'0')}.img`:source;
      if(kind==='n') {
        const name=val(await get(`String/Npc.img/${id}`),'name',id);
        const hidden=Boolean(val(info,'hide'));
        // Preserve template visibility separately; map life and quest conditions decide placement.
        result.npcs[id]={name,source,hidden,stand:await frames(sprite+'/stand')};
      } else {
        const actions={};
        // 源里没有该动作节点的怪导出**空表**，不把 `move` 别名成 `stand`：
        // 服务端 `monsters.rs::movement_force` 用「无 `info.speed` 且无 `move`
        // 时长」判定"源授权的不能移动"，别名会让这类怪凭空按默认速度走起来。
        // 空表经 `generate_tms273_gameplay.py` 自然省略 `moveDurationMs`
        // （那里是 `if duration:`），正好把这个源事实带给服务端；客户端的
        // `features/mob/view.ts` 对空表回退 `stand` 展示。
        // T（2026-09-15，全 165 图 51 个模板逐个核验）：只有 `2230103 黃蜘蛛`
        // 与 `2230104 紅蜘蛛`（均只在 `221022600`）源里没有 `move` —— 两个文件
        // 只写 `stand/hit1/die1`，`info` 里既无 `speed` 也无 `fs`，`dirType` 为
        // `1N`（固定朝向），即原版授权的固定怪。
        for(const [action,sourceAction] of [['stand','stand'],['move','move'],['hit','hit1'],['die','die1']]) {
          const actionSource=`${sprite}/${sourceAction}`;
          actions[action]=await optionalFrom(entityReader, actionSource)?await framesFrom(entityReader, actionSource):[];
        }
        // `stand` 是客户端构造精灵的必需帧（`view.ts` 读 `actions.stand[0].url`）：
        // 缺它属于导出缺陷而非源边界，必须在导出阶段就炸掉。
        assert(actions.stand.length, `Mob ${id} has no stand animation`);
        const entity={templateId:id,source,info:Object.fromEntries(children(info).filter(n=>['number','string'].includes(typeof n.wzValue)).map(n=>[n.name,n.wzValue])),actions};
        if(id==='3220000') {
          const actionMeta={};
          for(const action of ['attack1','attack2','skill1']) {
            const actionSource=`${source}/${action}`;
            const actionNode=await getFrom(entityReader, actionSource);
            const actionFrames=await framesFrom(entityReader, actionSource);
            actions[action]=actionFrames;
            const metadata={source:actionSource,frameCount:actionFrames.length,durationMs:actionFrames.reduce((total,frame)=>total+frame.delay,0)};
            const actionInfo=actionNode.at('info');
            const attackAfter=val(actionInfo,'attackAfter',null);
            if(attackAfter!==null) metadata.attackAfter=attackAfter;
            const range=actionInfo?.at?.('range');
            if(range) metadata.range=Object.fromEntries(children(range).map(child=>[child.name, child.wzValue]));
            actionMeta[action]=metadata;
          }
          entity.actionMeta=actionMeta;
        }
        result.monsters[id]=entity;
      }
      console.log(`273 ${folder} ${id}`);
    }
  }
  save('entities.json',result);
}
async function exportPortals() {
  const maps=JSON.parse(fs.readFileSync(path.join(output,'maps-rendered.json'),'utf8')).maps,portals={};
  // Type 2 is the visible gate. Invisible doors retain interaction without a beam.
  const animation=await frames('Map/MapHelper.img/portal/game/pv/default');
  for(const map of maps)for(const portal of map.portals)if(portal.type===2&&portal.targetMapId&&!portal.script) {
    portals[`${map.id}/${portal.name}`]={...animation[0],mapId:map.id,portalName:portal.name,type:portal.type,spriteKey:'pv/default',frames:animation,frameDelay:animation[0].delay};
  }
  save('portals.json',portals);
}
async function exportEffects() {
  const sounds={};
  async function sound(source) {
    if(sounds[source]) return sounds[source];
    const n=resolved(await get(source));
    assert(typeof n.getBytes==='function',source);
    const bytes=Buffer.from(await n.getBytes(false));assert(bytes.length,source);
    const name=source.replace(/[^a-zA-Z0-9_-]/g,'_')+'.mp3';
    fs.writeFileSync(path.join(assets,name),bytes);
    return sounds[source]='/assets/tms273/'+name;
  }
  const maps=JSON.parse(fs.readFileSync(path.join(output,'maps-rendered.json'),'utf8')).maps,bgm={};
  for(const m of maps){const [archive,...rest]=m.bgmSource.split('/');bgm[m.id]=await sound(`Sound/${archive}.img/${rest.join('/')}`);}
  const damageNumbers={};
  for(const [kind,prefix] of [['normal','NoRed'],['critical','NoCri']]) {
    const set={};for(const [place,index] of [['first',0],['rest',1]]) {
      set[place]={};for(let i=0;i<10;i++)set[place][String(i)]=await frame(`Effect/BasicEff.img/${prefix}${index}/${i}`);
    }damageNumbers[kind]=set;
  }
  save('effects.json',{bgm,combat:{damageNumbers}});
}
async function exportItems() {
  const data=JSON.parse(fs.readFileSync(path.join(output,'items.json'),'utf8')),items={};
  for(const [id,item] of Object.entries(data)) {
    assert(item.spriteSource&&!item.spriteSource.includes('*'),`Missing item image source: ${id}`);
    // Split client packs sometimes carry only the base image (0204.img) while
    // the unpacked JSON tree kept an updated `0204 2` sibling; those items
    // link to the base image's canvas, so fall back to it before failing.
    try {
      items[id]=await frame(item.spriteSource);
    } catch (error) {
      const fallback=item.spriteSource.replace(/(\d+) 2\.img\//,'$1.img/');
      if(fallback===item.spriteSource) throw error;
      items[id]=await frame(fallback);
    }
  }
  items['0']=await frame('Item/Special/0900.img/09000000/iconRaw/0');
  save('item-images.json',items);
}
async function main() {
  fs.mkdirSync(output,{recursive:true});
  const mode=process.argv[2] || 'maps';
  if(mode==='ui') {const hud=await exportUi();save('hud.json',hud);console.log(`273 UI: ${Object.keys(hud).length} canvases`);return;}
  if(mode==='entities') return exportEntities();
  if(mode==='windows') return exportWindows();
  if(mode==='portals') return exportPortals();
  if(mode==='effects') return exportEffects();
  if(mode==='items') return exportItems();
  if(mode==='boss-effects') return exportBossEffects();
  const ids=process.argv.slice(2).filter(x=>/^\d{9}$/.test(x));
  const metadata=JSON.parse(fs.readFileSync(path.join(root,'references/tms273-data/maps.json'),'utf8')).maps;
  const selected=ids.length?ids:metadata.map(m=>m.id);
  const maps=[];for(const id of selected) {
    const map=await exportMap(id), reference=metadata.find(m=>m.id===id);
    if(reference) {
      if(Object.values(reference.bounds).every(Number.isFinite)) assert.deepEqual(map.bounds,reference.bounds,`273 client/server map mismatch: ${id}`);
      map.name=reference.name;map.streetName=reference.streetName;
    }
    maps.push(map);
  }
  // `Map.wz .../info/returnMap` is the town a 回家卷軸 (`Item/Consume` `spec.moveTo
  // = 999999999`) sends a character back to.  The archive stores it as a bare
  // integer while the whole runtime speaks 9-digit map ids, so normalize it here
  // — the same defect class as `MapList/*/mapNo` on the world map.  It is a
  // catalog-level lookup unlike the per-map geometry, so it is written once for
  // every exported map rather than repeated inside each map record.
  const returnMaps={};
  for(const id of selected) {
    const reference=metadata.find(m=>m.id===id);
    const target=reference?.returnMap ?? reference?.info?.returnMap;
    if(target===undefined||target===null||target==='')continue;
    const value=Math.trunc(Number(target));
    assert(Number.isFinite(value)&&value>0&&value<999999999,`273 returnMap is not a map id: ${id} -> ${target}`);
    returnMaps[id]=String(value).padStart(9,'0');
  }
  assert.equal(Object.keys(returnMaps).length,maps.length,'273 returnMap export is incomplete');
  save('maps-rendered.json',{contentVersion:'tms273',birthMapId:maps[0].id,returnMaps,source:'TMS273.7 client WZ',maps});
}
if(require.main===module)main().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(()=>{reader.close();bossReader.close();});
module.exports={exportMap,geometry};
