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
// Exercise actual scene state handling with a finite renderer double.
const created=[];
function object(x=0,y=0,width=80,height=120){
 const o={x,y,width,height,children:[],setDepth(){return this},setOrigin(){return this},setRotation(v){this.rotation=v;return this},setDisplaySize(w,h){this.width=w;this.height=h;return this},setVisible(){return this},setPosition(x,y){this.x=x;this.y=y;return this},setAngle(){return this},add(v){this.children.push(v)},removeAll(){this.children=[]},destroy(){},lineStyle(){},lineBetween(){},fillStyle(){},fillEllipse(){},fillTriangle(){}};created.push(o);return o;
}
const played=[];
const scene={cache:{audio:{exists:()=>true}},sound:{play(key){played.push(key)}},add:{container:()=>object(),image:object,text:object,graphics:()=>object(),tileSprite:object}};
const {WindbellScene}=await load('./scene.ts',{
 ...configImport,"import Phaser from 'phaser';":"const Phaser={Math:{Linear:(a,b,t)=>a+(b-a)*t}};",
 "import { WINDBELL_ASSETS as A } from './maps';":"const A='/assets/windbell/';"
});
for(const name of WindbellScene.sounds)await fs.access(new URL(`../../../public-tms273/assets/windbell/sfx/${name}.ogg`,import.meta.url));
const bridge=new WindbellScene(scene,'bridge');
const state={treeBridge:'held',heat:'dry',bridgeStage:'working',cartUpright:true,bridgeSegments:1,cartX:450};
bridge.update(state,undefined,20);
assert.equal(played.length,0,'restored facts do not replay sounds');
assert.equal(bridge.dynamic.children.length,2,'one actual bridge segment and cart');
assert.equal(bridge.dynamic.children[0].width,config.bridge.segments[0].x2-config.bridge.segments[0].x1);
bridge.update({...state,cartX:770},undefined,20);assert.equal(bridge.cart.x,770,'continuous authoritative transport');
bridge.update({...state,bridgeSegments:3},undefined,20);assert.equal(bridge.dynamic.children.length,4);
assert.ok(played.some(key=>key.endsWith('/craftsman_install.ogg')));
bridge.destroy();
const island=new WindbellScene(scene,'island');
island.update({...state,treeBridge:'falling'},undefined,2000,50);
const f=config.island.treeBridge.dynamicFoothold;
assert.ok(Math.abs(island.falling.rotation-Math.atan2(f.y2-f.y1,f.x2-f.x1))<1e-10);
island.update({...state,treeBridge:'landed'},undefined,20);
assert.equal(island.dynamic.children[0].width,Math.hypot(f.x2-f.x1,f.y2-f.y1));
island.destroy();
console.log('Windbell: preserved base maps, shared geometry, runtime assets, partial bridge, cart movement and landed tree surface passed.');
