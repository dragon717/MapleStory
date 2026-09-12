import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';
const config=JSON.parse(await fs.readFile(new URL('../../../../shared/windbell.json',import.meta.url),'utf8'));
async function load(name, replacements={}) {
  let source=await fs.readFile(new URL(name,import.meta.url),'utf8');
  for(const [before,after] of Object.entries(replacements)) source=source.replace(before,after);
  const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}
const configImport={"import config from '../../../../shared/windbell.json';":`const config=${JSON.stringify(config)};`};
const {installWindbellMaps}=await load('./maps.ts',configImport);
const original={id:'original',bounds:{},layers:[]};
const manifest={map:original,mapCatalog:{maps:[original],birthMapId:'original'}};
installWindbellMaps(manifest);installWindbellMaps(manifest);
assert.equal(manifest.map,original);assert.equal(manifest.mapCatalog.maps.length,3);
for(const kind of ['island','bridge']){
  const actual=manifest.mapCatalog.maps.find(m=>m.id===`windbell-${kind}`);
  assert.deepEqual(actual.footholds,config.maps[kind].footholds);
  assert.deepEqual(actual.ladders,config.maps[kind].ladders);
  for(const layer of actual.layers)await fs.access(new URL(`../../../public-tms273${layer.url}`,import.meta.url));
  await fs.access(new URL(`../../../public-tms273${actual.bgm}`,import.meta.url));
}
const assets=JSON.parse(await fs.readFile(new URL('../../../public-tms273/assets/windbell/tms273.json',import.meta.url),'utf8'));
for(const name of ['fire','branch','cloud','bridge','ground','rock','rope']){
  assert.ok(assets[name]?.length,`missing ${name}`);
  for(const frame of assets[name]){
    assert.ok(frame.width>0 && frame.height>0 && frame.delay>0);
    assert.ok(Number.isFinite(frame.origin.x) && Number.isFinite(frame.origin.y));
    await fs.access(new URL(`../../../public-tms273${frame.url}`,import.meta.url));
  }
}
assert.ok(assets.fire.length>1,'fire must use a real animation');
const {frameAt}=await load('../player/animation.ts');
const {WindbellScene}=await load('./scene.ts',{
 ...configImport,
 "import { frameAt } from '../player/animation';":`const frameAt=${frameAt.toString()};`,
 "import { WINDBELL_ASSETS as A } from './maps';":"const A='/assets/windbell/';"
});
// Run the actual constructor/preload/state path with a minimal Phaser drawing surface.
const queued=new Set(), played=[];
function object(x=0,y=0,key=''){
 return {x,y,key,width:768,visible:true,rotation:0,children:[],
  setDepth(){return this},setAlpha(){return this},setScrollFactor(){return this},setScale(){return this},setOrigin(){return this},setFlipX(){return this},
  setRotation(v){this.rotation=v;return this},setVisible(v){this.visible=v;return this},setTexture(v){this.key=v;return this},setPosition(x,y){this.x=x;this.y=y;return this},setX(x){this.x=x;return this},
  add(child){this.children.push(child);return this},destroy(){this.destroyed=true;this.children.forEach(c=>c.destroy())}};
}
const scene={cache:{json:{exists:()=>true,get:()=>assets},audio:{exists:()=>true}},textures:{exists:()=>false},
 load:{image:(key)=>queued.add(key)},sound:{play:key=>played.push(key)},
 add:{image:(x,y,key)=>object(x,y,key),container:(x,y)=>object(x,y),tileSprite:(x,y,w,h,key)=>object(x,y,key)}};
let complete;
WindbellScene.preload({...scene,cache:{...scene.cache,json:{exists:()=>false}},load:{...scene.load,once:(_event,fn)=>complete=fn,json:()=>{}}},'island');
assert.equal(typeof complete,'function');complete('catalog','json',assets);
for(const kind of ['island','bridge'])WindbellScene.preload(scene,kind);
for(const url of queued)await fs.access(new URL(`../../../public-tms273${url}`,import.meta.url));
for(const cue of WindbellScene.sounds)await fs.access(new URL(`../../../public-tms273/assets/windbell/sfx/${cue}.ogg`,import.meta.url));
const island=new WindbellScene(scene,'island',()=>{},()=>{}), bridge=new WindbellScene(scene,'bridge',()=>{},()=>{});
const state={treeBridge:'held',heat:'dry',bridgeStage:'working',cartUpright:true,bridgeSegments:1,cartX:450};
island.update(state,undefined,20);bridge.update(state,undefined,20);
assert.equal(played.length,0,'restored facts do not replay sounds');
assert.equal(island.fire.visible,false);assert.equal(bridge.segments[0].visible,true);assert.equal(bridge.segments[1].visible,false);
island.update({...state,heat:'burning'},undefined,20);
assert.equal(island.fire.key,assets.fire[0].url);
island.update({...state,heat:'burning'},undefined,assets.fire[0].delay);
assert.equal(island.fire.key,assets.fire[1].url,'respect original frame delays');
assert.equal(island.fire.x,config.island.heat.branch.x-50-assets.fire[1].origin.x,'respect frame origin and authored fire-pit offset');
island.update({...state,treeBridge:'falling'},undefined,2000,50);
const f=config.island.treeBridge.dynamicFoothold;
assert.ok(Math.abs(island.bridge.rotation-Math.atan2(f.y2-f.y1,f.x2-f.x1))<1e-12);
island.update({...state,leafwing:true},{x:1080,y:900,grounded:false,facing:-1},20);
assert.equal(island.wing.visible,true);assert.equal(island.wing.x,1080);assert.equal(island.wing.y,862);
island.update({...state,leafwing:true},{x:1080,y:900,grounded:true,facing:1},20);
assert.equal(island.wing.visible,false);
bridge.update({...state,cartX:770,bridgeSegments:3},undefined,20);
assert.equal(bridge.cart.x,770);assert.equal(bridge.segments[2].visible,true);
assert.ok(played.some(key=>key.endsWith('/craftsman_install.ogg')));
const objects=[...island.objects,...bridge.objects];island.destroy();bridge.destroy();island.destroy();
assert.ok(objects.every(o=>o.destroyed),'release scene objects on exit');
console.log('Windbell 2D: original frame timing/origins, preload files, authoritative bridge/fire/wing/cart states and cleanup passed.');
