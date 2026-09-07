// Export the selected 273 maps and UI from their own WZ files; no v83 fallback.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const wz = require('@tybys/wz');
const { createReader } = require('./tms273_wz.cjs');
const root = path.resolve(__dirname, '..');
const data = path.join(root, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const output = path.join(root, 'resources/tms273-export');
const assets = path.join(output, 'assets/tms273');
const reader = createReader(data, path.join(output, 'ms'));
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
async function frame(source) {
  if (!exported.has(source)) {
    const f = await reader.frame(source, assets);
    assert(f.width > 0 && f.height > 0 && Number.isFinite(f.delay) && f.delay > 0, source);
    exported.set(source, { ...f, url: '/assets/tms273/' + f.url });
    if (exported.size % 25 === 0) console.log(`273 exported ${exported.size} source frames`);
  }
  return exported.get(source);
}
async function frames(source) {
  const n = resolved(await get(source));
  if (n instanceof wz.WzCanvasProperty) return [await frame(source)];
  const nodes = numeric(n);
  assert(nodes.length, `No drawable animation: ${source}`);
  const result = [];
  for (const c of nodes) result.push(await frame(source + '/' + c.name));
  return result;
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
    const ids=[...new Set(maps.flatMap(m=>m.life.filter(l=>l.type===kind&&!l.hide).map(l=>String(Number(l.id)))))].sort();
    for(const id of ids) {
      const source=`${folder}/${id.padStart(7,'0')}.img`;
      const node=await get(source), info=node.at('info');
      const link=val(info,'link',null), sprite=link?`${folder}/${String(link).padStart(7,'0')}.img`:source;
      if(kind==='n') {
        const name=val(await get(`String/Npc.img/${id}`),'name',id);
        const hidden=Boolean(val(info,'hide'));
        // Preserve template visibility separately; map life and quest conditions decide placement.
        result.npcs[id]={name,source,hidden,stand:await frames(sprite+'/stand')};
      } else {
        const actions={};
        for(const [action,sourceAction] of [['stand','stand'],['move','move'],['hit','hit1'],['die','die1']]) actions[action]=await frames(sprite+'/'+sourceAction);
        result.monsters[id]={templateId:id,source,info:Object.fromEntries(children(info).filter(n=>['number','string'].includes(typeof n.wzValue)).map(n=>[n.name,n.wzValue])),actions};
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
    items[id]=await frame(item.spriteSource);
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
  save('maps-rendered.json',{contentVersion:'tms273',birthMapId:maps[0].id,source:'TMS273.7 client WZ',maps});
}
if(require.main===module)main().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(()=>reader.close());
module.exports={exportMap,geometry};
