// Reuse installed Three/esbuild; this is an offline spatial review, with no game or account connection.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const out = path.join(root, 'resources/scenes/sky-voyage-v3/prototypes');
const { build } = createRequire(path.join(root, 'client/package.json'))('esbuild');
const layout = JSON.parse(fs.readFileSync(path.join(out, 'sky-city-spatial-layout.json'), 'utf8'));
const model = fs.readFileSync(path.join(out, 'sky-city-spatial-prototype.glb')).toString('base64');
function islandOffset(s,t,energy,config){return energy*(config.commonAmplitude*Math.sin(t*2*Math.PI/config.commonPeriod)+config.localAmplitude*Math.sin(t*2*Math.PI/s.motionPeriod+s.motionPhase));}
// One runnable check for the bounded motion and source anchor ownership.
const assert=require('node:assert/strict'), config=layout.landscape.motion;
for(const s of layout.landscape.islands)for(let t=0;t<=180;t+=.5)assert.ok(Number.isFinite(islandOffset(s,t,2,config))&&Math.abs(islandOffset(s,t,2,config))<=(config.commonAmplitude+config.localAmplitude)*2+.00001);
for(const n of layout.nodes){assert.ok(Math.abs(Object.values(n.islandWeights).reduce((a,b)=>a+b,0)-1)<.00001);assert.ok(Object.keys(n.islandWeights).every(id=>layout.landscape.islands.some(s=>s.id===id)));}
const entry = `
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VoyageCity } from './src/features/entry/voyage-city';
const layout=${JSON.stringify(layout)}, model=${JSON.stringify(model)};
const nodes=new Map(layout.nodes.map(n=>[n.id,n])), edges=new Map(layout.edges.map(e=>[e.id,e]));
let city, energy=1;
function nodeOffset(id){return city?.nodeOffset(id)||0;}
function updateMotion(dt){energy=THREE.MathUtils.clamp(Number(document.getElementById('energy').value)||0,0,2);
city.update(document.getElementById('animate').checked&&!document.hidden?dt:0,false,energy);
if(window.__skyRoadPreview)Object.assign(window.__skyRoadPreview,city.status(),{energy,marker:marker.position.toArray()});}
const scene=new THREE.Scene();scene.background=new THREE.Color('#dbe5eb');
const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.outputColorSpace=THREE.SRGBColorSpace;document.getElementById('view').appendChild(renderer.domElement);
const camera=new THREE.PerspectiveCamera(42,1,.1,6000), controls=new OrbitControls(camera,renderer.domElement);
controls.enableDamping=true;controls.minDistance=6;controls.maxDistance=2400;
scene.add(new THREE.HemisphereLight(0xffffff,0x7c8492,2.1));
const sun=new THREE.DirectionalLight(0xfff3dc,2.6);sun.position.set(-200,600,400);scene.add(sun);
const vector=p=>new THREE.Vector3(...p);
const marker=new THREE.Group();
const body=new THREE.Mesh(new THREE.CapsuleGeometry(.35,1.05,4,8),new THREE.MeshStandardMaterial({color:0x294a63}));body.position.y=1;marker.add(body);
const head=new THREE.Mesh(new THREE.SphereGeometry(.28,12,8),new THREE.MeshStandardMaterial({color:0xe8c9a7}));head.position.y=1.9;marker.add(head);scene.add(marker);
let route=[], routeMeta=[], arc=[], length=0, distance=0, moving=false, overlay=null, ready=false;
const start=document.getElementById('start'), end=document.getElementById('end'), status=document.getElementById('status');
for(const b of layout.blocks){for(const select of [start,end]){const group=document.createElement('optgroup');group.label=b.label;
for(const n of layout.nodes.filter(n=>n.zone===b.id&&!n.gate)){const option=document.createElement('option');option.value=n.id;option.textContent=n.label+' · '+n.position[1]+'米';group.append(option);}select.append(group);}}
start.value='P01';end.value='P05';
function routePoint(i){const p=vector(route[i]),meta=routeMeta[i];if(meta){p.y+=nodeOffset(meta.start)*(1-meta.u)+nodeOffset(meta.end)*meta.u;if(meta.surface==='suspension')p.x+=.22*energy*Math.sin((city?.status().motionTime||0)*1.1)*Math.sin(Math.PI*meta.u)**2;}return p;}
function sample(d){if(!route.length)return new THREE.Vector3();for(let i=1;i<arc.length;i++)if(d<=arc[i])return routePoint(i-1).lerp(routePoint(i),(d-arc[i-1])/(arc[i]-arc[i-1]));return routePoint(route.length-1);}
function chooseRoute(){
const graph=new Map(layout.nodes.map(n=>[n.id,[]]));for(const e of layout.edges){graph.get(e.start).push([e.end,e]);graph.get(e.end).push([e.start,e]);}
const best=new Map([[start.value,0]]), previous=new Map(), todo=new Set(nodes.keys());
while(todo.size){let current=null;for(const n of todo)if(current===null||(best.get(n)??Infinity)<(best.get(current)??Infinity))current=n;
if(!Number.isFinite(best.get(current)))break;todo.delete(current);if(current===end.value)break;
for(const [target,e]of graph.get(current)){const cost=best.get(current)+e.length;if(cost<(best.get(target)??Infinity)){best.set(target,cost);previous.set(target,[current,e]);}}}
if(!best.has(end.value)){status.textContent='这两个位置没有连通路径。';return;}
let current=end.value, steps=[];while(current!==start.value){const [before,e]=previous.get(current);steps.unshift([before,e]);current=before;}
route=[];routeMeta=[];for(const [before,e]of steps){const points=e.start===before?e.points:[...e.points].reverse();for(let i=route.length?1:0;i<points.length;i++){route.push(points[i]);routeMeta.push({...e,u:projection(vector(points[i]),e.points)});}}
if(!route.length){route=[nodes.get(start.value).position,nodes.get(start.value).position.map((v,i)=>v+(i===0?.001:0))];routeMeta=route.map(()=>({start:start.value,end:start.value,u:0}));}
arc=[0];for(let i=1;i<route.length;i++)arc.push(arc.at(-1)+vector(route[i]).distanceTo(vector(route[i-1])));length=arc.at(-1);distance=0;moving=false;
if(overlay){scene.remove(overlay);overlay.geometry.dispose();overlay.material.dispose();}
overlay=new THREE.Line(new THREE.BufferGeometry().setFromPoints(route.map((p,i)=>routePoint(i).add(new THREE.Vector3(0,.18,0)))),new THREE.LineBasicMaterial({color:0xc85518}));scene.add(overlay);
marker.position.copy(sample(0));status.textContent=nodes.get(start.value).label+' → '+nodes.get(end.value).label+' · 沿路面 '+Math.round(length)+'米';
window.__skyRoadPreview={ready,path:route,edgeIds:steps.map(s=>s[1].id),length,start:start.value,end:end.value};
}
start.onchange=end.onchange=chooseRoute;
document.getElementById('walk').onclick=()=>{if(!ready)return;distance=0;moving=true;document.getElementById('follow').checked=true;};
document.getElementById('pause').onclick=()=>{moving=false;document.getElementById('follow').checked=false;};
function focus(zone){moving=false;document.getElementById('follow').checked=false;
const points=layout.nodes.filter(n=>zone==='all'||n.zone===zone).map(n=>vector(n.position));const bounds=new THREE.Box3().setFromPoints(points),centre=bounds.getCenter(new THREE.Vector3()),size=bounds.getSize(new THREE.Vector3());
const extent=Math.max(size.x,size.y,size.z,90);controls.target.copy(centre);camera.position.copy(centre).add(new THREE.Vector3(extent*.65,extent*.64,extent*.9));controls.update();}
const zone=document.getElementById('zone');for(const b of layout.blocks){const option=document.createElement('option');option.value=b.id;option.textContent=b.label;zone.append(option);}zone.onchange=()=>focus(zone.value);
document.getElementById('town').onclick=()=>{start.value='P01';end.value='P03';chooseRoute();focus('A');};
document.getElementById('gardens').onclick=()=>{start.value='P01';end.value='P05';chooseRoute();focus('A');};
function resize(){const view=document.getElementById('view');camera.aspect=view.clientWidth/view.clientHeight;camera.updateProjectionMatrix();renderer.setSize(view.clientWidth,view.clientHeight);}
window.addEventListener('resize',resize);resize();focus('all');
new GLTFLoader().parse(Uint8Array.from(atob(model),c=>c.charCodeAt(0)).buffer,'',gltf=>{scene.add(gltf.scene);scene.updateMatrixWorld(true);
city=new VoyageCity(gltf.scene);
ready=true;chooseRoute();document.getElementById('walk').disabled=false;},error=>{status.textContent='模型读取失败，请重新打开预览。';console.error(error);});
let last=performance.now();renderer.setAnimationLoop(now=>{const dt=Math.min(.05,(now-last)/1000);last=now;if(ready)updateMotion(dt);
if(moving){distance=Math.min(length,distance+dt*12);if(distance>=length)moving=false;}const p=sample(distance);marker.position.copy(p);
if(overlay){const positions=overlay.geometry.attributes.position;for(let i=0;i<route.length;i++){const q=routePoint(i);positions.setXYZ(i,q.x,q.y+.18,q.z);}positions.needsUpdate=true;}
if(document.getElementById('follow').checked&&ready){const ahead=sample(Math.min(length,distance+10)),forward=ahead.clone().sub(p);forward.y=0;if(forward.lengthSq()>.001)forward.normalize();else forward.set(0,0,-1);
controls.target.copy(p).addScaledVector(forward,8).add(new THREE.Vector3(0,3,0));camera.position.copy(p).addScaledVector(forward,-15).add(new THREE.Vector3(0,9,0));}
controls.update();renderer.render(scene,camera);});
window.addEventListener('pagehide',()=>{renderer.setAnimationLoop(null);controls.dispose();renderer.dispose();},{once:true});
`;

async function main() {
  const result=await build({stdin:{contents:entry,resolveDir:path.join(root,'client'),loader:'js'},bundle:true,format:'iife',write:false,minify:true,logLevel:'silent'});
  const js=result.outputFiles[0].text.replace(/<\/script/gi,'<\\/script');
const html=`<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>天空之城 · 全城路网空间预览</title><style>
  *{box-sizing:border-box}body{margin:0;background:#dbe5eb;color:#253849;font:14px/1.5 "PingFang SC",sans-serif}#view{height:100vh}canvas{display:block}.panel{position:absolute;left:22px;top:22px;width:330px;max-width:calc(100vw - 44px);padding:20px;background:#f8f7f0ed;border:1px solid #c5d0ce;border-radius:12px;box-shadow:0 8px 30px #35506115}h1{font-size:21px;margin:0 0 8px}p{margin:8px 0;color:#5c6c76}label{display:block;margin-top:10px}select{width:100%;padding:7px;background:#fff;border:1px solid #bac7c8;color:#253849;border-radius:5px}button{padding:7px 11px;margin:10px 4px 0 0;border:1px solid #b4c1c4;border-radius:5px;background:#fff;color:#253849;cursor:pointer}button:disabled{opacity:.5;cursor:wait}input{accent-color:#ce723c}#status{color:#a25b2b}details summary{cursor:pointer}a{color:#486582}@media(max-width:650px){.panel{left:10px;top:10px;max-width:calc(100vw - 20px);width:280px;padding:12px;font-size:12px}.panel h1{font-size:17px}}
  </style><div id="view"></div><aside class="panel"><h1>天空之城 · 浮岛与动态道路</h1><p>拖动旋转，滚轮缩放。岛、建筑与植被一起浮动；桥和阶梯随两端联动。</p><label><input id="animate" type="checkbox" checked>能量浮动</label><label>能量强度<input id="energy" type="range" min="0" max="2" step="0.1" value="1" aria-label="能量强度"></label><label>观察范围<select id="zone"><option value="all">全城</option></select></label><details><summary>选择起终点，查看走法</summary><label>从哪里出发<select id="start"></select></label><label>去哪里<select id="end"></select></label></details><button id="town">码头 → 生活庭</button><button id="gardens">码头 → 三色分岔</button><p id="status" role="status">正在读取白模…</p><button id="walk" disabled>开始沿路预览</button><button id="pause">停止跟随</button><label><input type="checkbox" id="follow">跟随行走视角</label><p>浮岛和道路已动态联动；小人是沿路尺度演示，正式角色碰撞与多人导航尚未接入。</p><a href="city-atlas.html#lines">打开总图与各区路网</a></aside><script>${js}</script></html>`;
  fs.writeFileSync(path.join(out,'city-walk-preview.html'),html,'utf8');
  console.log('Built self-contained city road preview ('+fs.statSync(path.join(out,'city-walk-preview.html')).size+' bytes)');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
