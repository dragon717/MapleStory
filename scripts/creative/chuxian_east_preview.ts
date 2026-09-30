import * as T from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
// The bundle injects these assets into one offline HTML.
declare const ART:any,MODEL:string;
const $=(s:string)=>document.querySelector(s) as any;
const canvas=$('#scene'),stage=canvas.parentElement,mini=$('#minimap'),mc=mini.getContext('2d');
const renderer=new T.WebGLRenderer({canvas,antialias:true,alpha:false,preserveDrawingBuffer:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFShadowMap;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=.93;
const scene=new T.Scene(),people=new T.Scene();scene.background=new T.Color('#e0eced');scene.fog=new T.FogExp2('#d9e5df',.0015);
const camera=new T.PerspectiveCamera(38,1,.15,800),controls=new OrbitControls(camera,canvas);
controls.enableDamping=true;controls.dampingFactor=.09;controls.minDistance=12;controls.maxDistance=290;controls.maxPolarAngle=Math.PI*.46;controls.target.set(7,8,0);
scene.add(new T.HemisphereLight('#e3f3ff','#6e7951',1.35));
const sun=new T.DirectionalLight('#ffe4b7',3.0);sun.position.set(-75,135,65);sun.target.position.set(10,8,0);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);sun.shadow.camera.left=-145;sun.shadow.camera.right=145;sun.shadow.camera.top=145;sun.shadow.camera.bottom=-145;sun.shadow.camera.near=1;sun.shadow.camera.far=400;sun.shadow.normalBias=.08;sun.shadow.bias=-.0003;scene.add(sun,sun.target);
const ray=new T.Raycaster(),ndc=new T.Vector2(),roles:any[]=[],segments:any[]=[],roads:T.Object3D[]=[],surfaces:T.Object3D[]=[],layers:Record<string,T.Object3D[]>={},frames:any={},nodeMap:any={},adj:any={};
const pathGroup=new T.Group();people.add(pathGroup);
const circle=new T.Mesh(new T.RingGeometry(.65,.8,40),new T.MeshBasicMaterial({color:'#fff3ba',side:T.DoubleSide,transparent:true,opacity:.95,depthWrite:false}));circle.rotation.x=-Math.PI/2;people.add(circle);
const nameplate=document.createElement('div');nameplate.className='person-name';stage.append(nameplate);
let model:T.Group,layout:any,ready=false,selectedId='self',serial=0,mode='game',placing:string|null=null,following=false,exploded=false,pointer:any=null,last=0,time=0,W=1,H=1,hoverId:string|null=null;
const original=new Map<T.Object3D,T.Vector3>(),keys=new Set<string>(),fromBlender=(p:number[])=>new T.Vector3(p[0],p[2],-p[1]);
const selected=()=>roles.find(r=>r.id===selectedId);
const rng=(seed:number)=>{let n=seed;return()=>((n=Math.imul(n,1664525)+1013904223>>>0)/4294967296)};const random=rng(8219);
function project(p:T.Vector3){camera.updateMatrixWorld();const v=p.clone().project(camera);return {x:(v.x+1)*W/2,y:(1-v.y)*H/2,z:v.z};}
function nearest(p:T.Vector3){let best:any;for(const s of segments){const d=s.b.clone().sub(s.a),t=T.MathUtils.clamp(p.clone().sub(s.a).dot(d)/d.lengthSq(),0,1),q=s.a.clone().addScaledVector(d,t),distance=q.distanceTo(p);if(!best||distance<best.distance)best={p:q,segment:s,t,distance};}return best;}
function pathBetween(start:any,end:any){if(start.segment.id===end.segment.id)return [end.p.clone()];const graph:any=Object.fromEntries(Object.entries(adj).map(([id,e]:any)=>[id,[...e]]));graph.start=[];graph.end=[];for(const [key,hit] of [['start',start],['end',end]] as any)for(const id of [hit.segment.ai,hit.segment.bi]){const cost=hit.p.distanceTo(nodeMap[id]);graph[key].push({id,cost});graph[id].push({id:key,cost});}
 const costs:any={start:0},previous:any={},open=new Set(Object.keys(graph));
 // ponytail: a village graph with fewer than 400 nodes; a linear minimum scan suffices.
 while(open.size){let next:any=null;for(const id of open)if(next===null||(costs[id]??Infinity)<(costs[next]??Infinity))next=id;if(!Number.isFinite(costs[next]))break;open.delete(next);if(next==='end')break;for(const e of graph[next])if(open.has(e.id)&&costs[next]+e.cost<(costs[e.id]??Infinity)){costs[e.id]=costs[next]+e.cost;previous[e.id]=next;}}
 if(!Number.isFinite(costs.end))return [];const ids=['end'];while(ids[0]!=='start')ids.unshift(previous[ids[0]]);return ids.slice(1).map(id=>id==='end'?end.p.clone():nodeMap[id].clone());}
function count(){ $('#player-count').textContent=roles.filter(r=>r.type==='player').length;$('#npc-count').textContent=roles.filter(r=>r.type==='npc').length;}
function frameOf(r:any){return r.type==='npc'?frames.npc[r.art%frames.npc.length]:(r.path.length?frames.walk:frames.stand)[Math.floor(time/(r.path.length?150:650)+r.phase)%((r.path.length?frames.walk:frames.stand).length)];}
function syncSelection(){const r=selected();if(!r)return;$('#selected-name').textContent=r.name+(r.type==='npc'?' · NPC':'');$('#selected-info').textContent=nearest(r.p).segment.route.name+' · '+(r.path.length?'行走':'站立');$('#walk-status').textContent=r.path.length?'正在沿路行走':'2米人物 · 真实纵深';const f=frameOf(r);$('#portrait').src=f.preview??=f.image.toDataURL();}
function choose(r:any){selectedId=r.id;syncSelection();if(r.type==='npc'){$('#npc-name').textContent=r.name+' · 模拟居民';$('#npc-copy').textContent=r.copy??'环路通向不同的风景，沿着路慢慢走吧。';$('#dialogue').hidden=false;}else $('#dialogue').hidden=true;drawPath();}
function role(type:string,p:T.Vector3,i:number,name?:string,art=0){const r:any={id:i===0?'self':'role-'+(++serial),type,name:name??(type==='player'?['拾光','青禾','晚风','南枝','栗子','月桂','松果','苔绿'][i%8]+' '+i:ART.npcs[art].label),art,p:p.clone(),path:[],phase:random()*5,facing:1,rest:i*.14};
 r.sprite=new T.Sprite(new T.SpriteMaterial({map:frameOf(r).texture,transparent:true,alphaTest:.15,depthTest:true,depthWrite:false,toneMapped:false,fog:false}));r.sprite.userData.role=r;r.sprite.center.set(.5,0);people.add(r.sprite);
 r.shadow=new T.Mesh(new T.CircleGeometry(.43,16),new T.MeshBasicMaterial({color:'#273c27',transparent:true,opacity:.20,depthWrite:false}));r.shadow.rotation.x=-Math.PI/2;r.shadow.scale.y=.58;people.add(r.shadow);roles.push(r);return r;}
function populate(n=32){for(const r of roles){people.remove(r.sprite,r.shadow);r.sprite.material.dispose();r.shadow.geometry.dispose();r.shadow.material.dispose();}roles.length=0;serial=0;const rand=rng(9030+n);for(let i=0;i<n;i++){let p:any;for(let k=0;k<400;k++){const s=segments[Math.floor(rand()*segments.length)];p=s.a.clone().lerp(s.b,.10+rand()*.8);if(!roles.some(r=>r.p.distanceTo(p)<4.5))break;}if(i===0)p=nodeMap.central;role('player',p,i,i===0?'你 · 旅行者':undefined);}
 const names=['长老斯坦','卡蜜拉','皮亚','赫丽娜','明明夫人','蕾雅','流浪铁匠'],places=['hallFrontW','gardenFront','marketFront','hallSW','marketCross','dockHead','eastCross'];places.forEach((id,i)=>{const r=role('npc',nodeMap[id],i+200,names[i],i);r.copy=['沿着环路走，山坡和溪边都是村子的日常。','花店在拐角，今天的阳光会照到门前。','从大道往山上走，能看见整个东边村落。','大厅前有训练庭院，路过时来坐坐。','这只是街道模拟，正式任务会沿用游戏里原有的流程。','沿溪小径很安静，木桥就在前面。','村子的东门很远，别急着走完每一条路。'][i];});selectedId='self';placing=null;following=false;count();syncSelection();drawPath();}
function drawPath(){pathGroup.clear();const r=selected();if(!r?.path.length)return;const geometry=new T.BufferGeometry().setFromPoints([r.p,...r.path].map((p:T.Vector3)=>p.clone().add(new T.Vector3(0,.12,0))));const line=new T.Line(geometry,new T.LineDashedMaterial({color:'#f3d78e',dashSize:.6,gapSize:.4,depthTest:true}));line.computeLineDistances();pathGroup.add(line);}
function go(r:any,target:T.Vector3){const a=nearest(r.p),b=nearest(target);r.p.copy(a.p);r.path=pathBetween(a,b);if(r.id===selectedId){syncSelection();drawPath();}return r.path.length>0;}
function toast(s:string){$('#toast').textContent=s;$('#toast').classList.add('show');clearTimeout((toast as any).timer);(toast as any).timer=setTimeout(()=>$('#toast').classList.remove('show'),1800);}
function cameraTo(target:T.Vector3,offset:T.Vector3){const damping=controls.enableDamping;controls.enableDamping=false;controls.update();controls.target.copy(target);camera.position.copy(target).add(offset);controls.update();controls.enableDamping=damping;}
function zoomReference(){return mode==='game'?H/(2*Math.tan(T.MathUtils.degToRad(camera.fov/2))*layout.fixedCamera.pixelsPerMetre):155;}
function gameOffset(){const f=layout.fixedCamera,d=zoomReference();controls.minDistance=d*.75;controls.maxDistance=d*1.4;return new T.Vector3(0,Math.sin(f.pitch),Math.cos(f.pitch)).multiplyScalar(d*f.zoom);}
let gameLift=0,gameDistance=0;const gameFoot=new T.Vector3(Infinity,Infinity,Infinity);
function gameTarget(offset:T.Vector3,force=false){const p=selected().p,base=p.clone().add(new T.Vector3(0,1.2,0));if(force||gameFoot.distanceTo(p)>.6||Math.abs(gameDistance-offset.length())>.3){gameFoot.copy(p);gameDistance=offset.length();gameLift=0;const foot=p.clone().add(new T.Vector3(0,.16,0));for(;gameLift<6;gameLift+=.5){const eye=base.clone().add(offset).add(new T.Vector3(0,gameLift,0));ray.set(eye,foot.clone().sub(eye).normalize());ray.far=eye.distanceTo(foot)-.06;if(!ray.intersectObjects([...layers.terrain,...layers.roads],true).length)break;}ray.far=Infinity;}return base.add(new T.Vector3(0,gameLift,0));}
function fixedMode(on:boolean){controls.enableRotate=!on;controls.enablePan=!on;$('#zoom').min=on?'71':'80';$('#zoom').max=on?'133':'420';if(!on){controls.minDistance=12;controls.maxDistance=290;}}
function view(v:string){mode=v;following=v==='stroll'||v==='game';fixedMode(v==='game');document.querySelectorAll('[data-view]').forEach((b:any)=>b.setAttribute('aria-pressed',String(b.dataset.view===v)));$('#scene-heading').textContent={game:'沿坡入村，转弯见小径',east:'东村高低全景',stroll:'沿一条路，慢慢走',overview:'高地、街坊与溪岸'}[v]??'东边村落';$('#scene-caption').textContent=v==='game'?'固定游戏视角 · 沿路行走 · 坡后藏着花巷与林根小径':'独立3D对象 · 可旋转镜头 · 2D人物的真实遮挡';if(v==='overview')cameraTo(new T.Vector3(0,12,-12),new T.Vector3(-118,150,180));else if(v==='east')cameraTo(new T.Vector3(10,13,-4),new T.Vector3(-99,102,140));else if(selected()){const offset=v==='game'?gameOffset():new T.Vector3(-12,18,28);cameraTo(v==='game'?gameTarget(offset,true):selected().p.clone().add(new T.Vector3(0,1.2,0)),offset);}}

function focus(id:string){mode='place';following=false;fixedMode(false);const key=id==='riverside'?'river':id;const target=fromBlender(layout.landmarks[key]);cameraTo(target,new T.Vector3(-26,29,44));$('#scene-heading').textContent={guild:'弓手大厅',garden:'蘑菇街坊',market:'晨光集市',riverside:'东溪码头'}[id];document.querySelectorAll('[data-view]').forEach((b:any)=>b.setAttribute('aria-pressed','false'));}
function explode(on:boolean){exploded=on;following=false;for(const [name,objects] of Object.entries(layers))for(const o of objects){o.position.copy(original.get(o)!);o.position.y+=on?({buildings:18,roads:3,vegetation:9,props:6,water:-2}[name]??0):0;}people.visible=!on;$('#explode').setAttribute('aria-pressed',String(on));$('#explode').textContent=on?'合回场景':'拆分查看';toast(on?'建筑、道路、植被、地形分别拆开。':'已合回立体村落。');}
function pointerRay(e:any){camera.updateMatrixWorld();const b=canvas.getBoundingClientRect();ndc.set((e.clientX-b.left)/b.width*2-1,-(e.clientY-b.top)/b.height*2+1);ray.setFromCamera(ndc,camera);}
function ground(e:any){pointerRay(e);const hit=ray.intersectObjects(model.children,true)[0];return hit&&(hit.object.userData.walkable??hit.object.parent?.userData.walkable)?hit.point:undefined;}
function hitRole(e:any){pointerRay(e);const hits=ray.intersectObjects([...roles.map(r=>r.sprite),model],true);return hits[0]?.object.userData.role;}
canvas.addEventListener('pointerdown',(e:any)=>{if(!ready||exploded||e.button!==0)return;const r=hitRole(e);pointer={x:e.clientX,y:e.clientY,role:r,moved:false};if(r||placing){controls.enabled=false;e.preventDefault();canvas.setPointerCapture(e.pointerId);}if(placing){const p=ground(e);if(p){const r=role(placing,nearest(p).p,100+serial,placing==='player'?'新旅人 '+(serial+1):undefined,serial%7);choose(r);count();placing=null;toast('已放到真实道路上。');}else toast('请放在道路、桥面或石阶上。');pointer=null;controls.enabled=true;}else if(r)choose(r);});
canvas.addEventListener('pointermove',(e:any)=>{if(pointer&&Math.hypot(e.clientX-pointer.x,e.clientY-pointer.y)>4)pointer.moved=true;if(pointer?.role&&pointer.moved){const p=ground(e);if(p){pointer.role.p.copy(nearest(p).p);pointer.role.path=[];syncSelection();drawPath();}}else if(!pointer&&ready&&!exploded){hoverId=hitRole(e)?.id??null;canvas.style.cursor=placing?'crosshair':hoverId?'grab':'default';}});
canvas.addEventListener('pointerup',(e:any)=>{if(pointer&&!pointer.role&&!pointer.moved&&!exploded){const p=ground(e),r=selected();if(p&&r)go(r,p);}pointer=null;controls.enabled=true;});canvas.addEventListener('pointercancel',()=>{pointer=null;controls.enabled=true;});
window.addEventListener('keydown',(e:any)=>{if(/INPUT|SELECT|BUTTON/.test(e.target.tagName))return;if(e.key==='Escape'){placing=null;$('#dialogue').hidden=true;}if(e.key.startsWith('Arrow')){e.preventDefault();keys.add(e.key);}if(e.key===' '){e.preventDefault();controls.mouseButtons.LEFT=T.MOUSE.PAN;}});window.addEventListener('keyup',(e:any)=>{keys.delete(e.key);if(e.key===' ')controls.mouseButtons.LEFT=T.MOUSE.ROTATE;});window.addEventListener('blur',()=>keys.clear());
for(const b of document.querySelectorAll('[data-view]') as any)b.onclick=()=>view(b.dataset.view);for(const b of document.querySelectorAll('[data-place]') as any)b.onclick=()=>focus(b.dataset.place);
$('#collapse-tools').onclick=()=>{const c=$('#tools').classList.toggle('collapsed');$('#collapse-tools').textContent=c?'＋':'−';$('#collapse-tools').setAttribute('aria-expanded',String(!c));$('#collapse-tools').setAttribute('aria-label',c?'展开人物工具':'收起人物工具');};
$('#density').onchange=(e:any)=>populate(+e.target.value);$('#roam').onchange=()=>{if(!$('#roam').checked)for(const r of roles)if(r.id!==selectedId&&r.type==='player')r.path=[];};$('#add-player').onclick=()=>{placing='player';if(exploded)explode(false);toast('点击3D道路放置玩家。');};$('#add-npc').onclick=()=>{placing='npc';if(exploded)explode(false);toast('点击3D道路放置NPC。');};$('#follow').onclick=()=>view('stroll');$('#stop').onclick=()=>{const r=selected();if(r){r.path=[];syncSelection();drawPath();}};$('#close-dialogue').onclick=()=>$('#dialogue').hidden=true;
$('#delete-role').onclick=()=>{const r=selected();if(!r)return;people.remove(r.sprite,r.shadow);r.sprite.material.dispose();r.shadow.geometry.dispose();r.shadow.material.dispose();roles.splice(roles.indexOf(r),1);selectedId=roles[0]?.id;count();if(selected())syncSelection();drawPath();$('#dialogue').hidden=true;};
$('#routes').onchange=()=>{scene.getObjectByName('NavigationLines')!.visible=$('#routes').checked;};$('#labels').onchange=()=>$('#pins').hidden=!$('#labels').checked;$('#explode').onclick=()=>explode(!exploded);
$('#sunlight').oninput=(e:any)=>{sun.intensity=+e.target.value;sunlight.material.uniforms.strength.value=+e.target.value*.0045;};$('#rays').onchange=()=>sunlight.material.uniforms.strength.value=$('#rays').checked?sun.intensity*.0045:0;
function zoom(f:number){camera.position.sub(controls.target).multiplyScalar(f).add(controls.target);controls.update();if(mode==='game'){const offset=camera.position.clone().sub(controls.target);cameraTo(gameTarget(offset,true),offset);}}$('#zoom-in').onclick=()=>zoom(.85);$('#zoom-out').onclick=()=>zoom(1.18);$('#zoom').oninput=(e:any)=>{const d=zoomReference()/(+e.target.value/100);zoom(d/camera.position.distanceTo(controls.target));};
function reset(){if(exploded)explode(false);$('#density').value='32';$('#roam').checked=true;$('#routes').checked=false;$('#labels').checked=false;scene.getObjectByName('NavigationLines')!.visible=false;$('#pins').hidden=true;populate();view('game');$('#dialogue').hidden=true;}$('#reset-layout').onclick=reset;
$('#save-image').onclick=()=>{render();const a=document.createElement('a');a.download='初弦地东边村落-3D.png';a.href=canvas.toDataURL('image/png');a.click();};
mini.addEventListener('pointerdown',(e:any)=>{const b=mini.getBoundingClientRect(),x=(e.clientX-b.left)/b.width*200-100,z=(e.clientY-b.top)/b.height*170-70;following=false;const delta=new T.Vector3(x,controls.target.y,z).sub(controls.target);camera.position.add(delta);controls.target.add(delta);controls.update();});
function minimap(){const w=183,h=92;mc.fillStyle='#e0e6d2';mc.fillRect(0,0,w,h);mc.fillStyle='#a6c5c0';mc.fillRect(0,58,w,12);for(const s of segments){mc.beginPath();mc.moveTo((s.a.x+100)/200*w,(s.a.z+70)/170*h);mc.lineTo((s.b.x+100)/200*w,(s.b.z+70)/170*h);mc.strokeStyle=s.route.kind==='loop'?'#93a477':'#b8a27e';mc.lineWidth=1.3;mc.stroke();}for(const r of roles){mc.fillStyle=r.id===selectedId?'#785834':r.type==='npc'?'#b78851':'#809477';mc.fillRect((r.p.x+100)/200*w-1,(r.p.z+70)/170*h-1,2,2);}mc.strokeStyle='#55765b';mc.lineWidth=1.4;mc.strokeRect((controls.target.x+100)/200*w-7,(controls.target.z+70)/170*h-5,14,10);}
function occluded(p:T.Vector3){const d=p.distanceTo(camera.position);ray.set(camera.position,p.clone().sub(camera.position).normalize());ray.far=d-.06;const hidden=ray.intersectObject(model,true).length>0;ray.far=Infinity;return hidden;}
function render(){sunlight.render(renderer,scene,camera,sun);renderer.autoClear=false;renderer.render(people,camera);renderer.autoClear=true;}
function tick(now:number){requestAnimationFrame(tick);if(!ready||now-last<33)return;const dt=Math.min((now-last)/1000,.1);last=now;time=now;controls.update();if(!exploded)for(const r of roles){if(r.id!==selectedId&&r.type==='player'&&$('#roam').checked&&!r.path.length){r.rest-=dt;if(r.rest<=0){const ids=Object.keys(nodeMap);go(r,nodeMap[ids[Math.floor(random()*ids.length)]]);r.rest=5+random()*9;}}if(r.path.length){const q=r.path[0],d=r.p.distanceTo(q),step=2*dt;if(d<=step){r.p.copy(q);r.path.shift();if(!r.path.length&&r.id===selectedId){syncSelection();drawPath();}}else{r.facing=q.x>=r.p.x?1:-1;r.p.lerp(q,step/d);}}const f=frameOf(r);r.sprite.material.map=f.texture;r.sprite.center.set(f.footX/f.width,1-f.footY/f.height);r.sprite.scale.set(1.8*f.width/f.height,1.8,1);r.sprite.position.copy(r.p).add(new T.Vector3(0,.045,0));r.shadow.position.copy(r.p).add(new T.Vector3(0,.025,0));}
 const r=selected();if(r){circle.position.copy(r.p).add(new T.Vector3(0,.04,0));if(following){const target=mode==='game'?gameTarget(camera.position.clone().sub(controls.target)):r.p.clone().add(new T.Vector3(0,1.2,0));const delta=target.sub(controls.target).multiplyScalar(Math.min(1,dt*3));controls.target.add(delta);camera.position.add(delta);}if(keys.size&&!r.path.length){const forward=camera.getWorldDirection(new T.Vector3());forward.y=0;forward.normalize();const side=forward.clone().cross(new T.Vector3(0,1,0));const q=r.p.clone().addScaledVector(forward,(+keys.has('ArrowUp')-+keys.has('ArrowDown'))*4).addScaledVector(side,(+keys.has('ArrowRight')-+keys.has('ArrowLeft'))*4);go(r,q);}const p=project(r.p);nameplate.style.left=p.x+'px';nameplate.style.top=(p.y+9)+'px';nameplate.hidden=exploded||p.z>1||p.x<0||p.x>W||p.y<0||p.y>H||occluded(r.p.clone().add(new T.Vector3(0,1.5,0)));nameplate.textContent=r.name;}
 for(const b of document.querySelectorAll('.pin') as any){const p=project(fromBlender(layout.landmarks[b.dataset.key]));b.style.left=p.x+'px';b.style.top=(p.y-18)+'px';b.hidden=p.z>1||p.x<30||p.x>W-30||p.y<100||p.y>H-30;}$('#zoom-value').textContent=Math.round(zoomReference()/camera.position.distanceTo(controls.target)*100)+'%';$('#zoom').value=Math.round(zoomReference()/camera.position.distanceTo(controls.target)*100);minimap();render();}
function resize(){W=stage.clientWidth;H=stage.clientHeight;renderer.setSize(W,H,false);camera.aspect=W/H;camera.updateProjectionMatrix();const size=renderer.getDrawingBufferSize(new T.Vector2());sunlight.resize(size.x,size.y);mini.width=183;mini.height=92;if(ready&&mode==='game')view('game');}
async function image(src:string){return new Promise<HTMLImageElement>((resolve,reject)=>{const im=new Image();im.onload=()=>resolve(im);im.onerror=reject;im.src=src;});}
function tex(im:any){const texture=new T.CanvasTexture(im);texture.colorSpace=T.SRGBColorSpace;texture.minFilter=T.LinearFilter;texture.magFilter=T.NearestFilter;texture.generateMipmaps=false;return texture;}
async function compose(parts:any[]){const x0=Math.min(...parts.map(p=>p.x)),y0=Math.min(...parts.map(p=>p.y)),x1=Math.max(...parts.map(p=>p.x+p.width)),y1=Math.max(0,...parts.map(p=>p.y+p.height));const c=document.createElement('canvas');c.width=x1-x0;c.height=y1-y0;const ctx=c.getContext('2d')!,ims=await Promise.all(parts.map(p=>image(p.data)));parts.forEach((p,i)=>ctx.drawImage(ims[i],p.x-x0,p.y-y0));return {image:c,texture:tex(c),width:c.width,height:c.height,footX:-x0,footY:-y0};}
async function init(){const bytes=Uint8Array.from(atob(MODEL),c=>c.charCodeAt(0));const gltf=await new GLTFLoader().parseAsync(bytes.buffer,'');model=gltf.scene;scene.add(model);layout=JSON.parse(model.userData.layout);model.traverse((o:any)=>{if(o.userData.layer){(layers[o.userData.layer]??=[]).push(o);original.set(o,o.position.clone());}if(!o.isMesh)return;o.castShadow=true;o.receiveShadow=true;const layer=o.userData.layer??o.parent?.userData.layer??'terrain';surfaces.push(o);if(layer==='roads'&&(o.userData.walkable??o.parent?.userData.walkable))roads.push(o);if(layer==='water'){o.material=new T.MeshPhysicalMaterial({color:'#66a9a0',roughness:.2,metalness:.20,transparent:true,opacity:.9});o.castShadow=false;}});
 // Native instancing reduces repeated plant draws; the Blender/glTF objects stay editable.
 model.updateMatrixWorld(true);const batches=new Map<string,any>();
 for(const root of layers.vegetation??[])root.traverse((o:any)=>{if(!o.isMesh||Array.isArray(o.material))return;const key=o.geometry.uuid+':'+o.material.uuid;const batch=batches.get(key)??{geometry:o.geometry,material:o.material,objects:[]};batch.objects.push(o);batches.set(key,batch);});
 const forest=new T.Group();forest.name='VegetationInstances';model.add(forest);
 for(const b of batches.values()){if(b.objects.length<2)continue;const inst=new T.InstancedMesh(b.geometry,b.material,b.objects.length);inst.castShadow=true;inst.receiveShadow=true;b.objects.forEach((o:any,i:number)=>{inst.setMatrixAt(i,o.matrixWorld);o.visible=false;});inst.computeBoundingSphere();forest.add(inst);}
 (layers.vegetation??=[]).push(forest);original.set(forest,forest.position.clone());
 for(const [key,p] of Object.entries(layout.nodes) as any){nodeMap[key]=fromBlender(p);adj[key]=[];}const lines=new T.Group();lines.name='NavigationLines';lines.visible=false;scene.add(lines);const seen=new Set<string>();for(const route of layout.routes)for(let i=1;i<route.points.length;i++){const ai=route.points[i-1],bi=route.points[i],id=[ai,bi].sort().join(':');if(seen.has(id))continue;seen.add(id);const a=nodeMap[ai],b=nodeMap[bi];segments.push({id,a,b,ai,bi,route});const cost=a.distanceTo(b);adj[ai].push({id:bi,cost});adj[bi].push({id:ai,cost});const line=new T.Line(new T.BufferGeometry().setFromPoints([a.clone().add(new T.Vector3(0,.18,0)),b.clone().add(new T.Vector3(0,.18,0))]),new T.LineBasicMaterial({color:route.kind==='loop'?'#c4dd8b':'#f1cc85',depthTest:false}));lines.add(line);}
 for(const action of ['stand','walk'])frames[action]=await Promise.all(ART.frames[action].map(compose));frames.npc=await Promise.all(ART.npcs.map(async(n:any)=>{const im=await image(n.data);const c=document.createElement('canvas');c.width=n.width;c.height=n.height;c.getContext('2d')!.drawImage(im,0,0);return {image:c,texture:tex(c),width:n.width,height:n.height,footX:n.origin.x,footY:n.origin.y};}));
 for(const [key,p] of Object.entries(layout.landmarks)){const b=document.createElement('button');b.className='pin';b.dataset.key=key;b.textContent={guild:'弓手大厅',market:'晨光集市',garden:'花坡街坊',river:'东溪码头'}[key];b.onclick=()=>focus(key==='river'?'riverside':key);$('#pins').append(b);}$('#pins').hidden=true;ready=true;populate();resize();new ResizeObserver(resize).observe(stage);view('game');if(innerWidth<650){$('#tools').classList.add('collapsed');$('#collapse-tools').textContent='＋';$('#collapse-tools').setAttribute('aria-expanded','false');}$('#object-count').textContent=Object.values(layers).reduce((n,a)=>n+a.length,0);$('#loading').remove();requestAnimationFrame(tick);
 (window as any).chuxianEast3D={ready,scene,model,people,camera,controls,layout,roles,segments,layers,roads,ray,nodeMap,project,nearest,pathBetween,go,choose,view,focus,explode,render,reset,get selected(){return selected();},get exploded(){return exploded;},get mode(){return mode;},get placing(){return placing;}};
}
/** Depth-bounded single scattering, using the same sun shadow as the terrain. */
class VillageSunlight {
  private target = new T.WebGLRenderTarget(1, 1, { type: T.HalfFloatType, depthTexture: new T.DepthTexture(1, 1) });
  private scattering = new T.WebGLRenderTarget(1, 1, { type: T.HalfFloatType, depthBuffer: false });
  private bloom = new UnrealBloomPass(new T.Vector2(32, 32), .045, .45, .7);
  private scene = new T.Scene();
  private camera = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  material = new T.ShaderMaterial({
    glslVersion: T.GLSL3,
    depthTest: false, depthWrite: false,
    uniforms: {
      image: { value: this.target.texture }, depth: { value: this.target.depthTexture },
      shadow: { value: null }, shadowMatrix: { value: new T.Matrix4() },
      inverseProjection: { value: new T.Matrix4() }, cameraWorld: { value: new T.Matrix4() },
      eye: { value: new T.Vector3() }, sunDirection: { value: new T.Vector3() },
      strength: { value: .035 }, rail: { value: new T.Vector2(220, 0) },
    },
    vertexShader: `out vec2 screenUv;
      void main() { screenUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `precision highp sampler2DShadow;
      uniform sampler2D image, depth;
      uniform sampler2DShadow shadow;
      uniform mat4 inverseProjection, cameraWorld, shadowMatrix;
      uniform vec3 eye, sunDirection;
      uniform float strength;
      uniform vec2 rail;
      in vec2 screenUv;
      out vec4 outColor;
      void main() {
        vec4 view = inverseProjection * vec4(screenUv * 2.0 - 1.0, texture(depth, screenUv).r * 2.0 - 1.0, 1.0);
        vec3 end = (cameraWorld * vec4(view.xyz / view.w, 1.0)).xyz;
        vec3 ray = normalize(end - eye);
        float rayLength = min(distance(end, eye), 100.0);
        float stepSize = rayLength / 32.0;
        float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898,78.233))) * 43758.5453);
        float light = 0.0, opticalDepth = 0.0;
        // ponytail: 32 samples, increase only if visible banding survives pixel jitter.
        for (int i = 0; i < 32; i++) {
          vec3 p = eye + ray * (float(i) + jitter) * stepSize;
          vec4 projected = shadowMatrix * vec4(p, 1.0);
          vec3 s = projected.xyz / projected.w;
          float inside = step(0.0,s.x)*step(s.x,1.0)*step(0.0,s.y)*step(s.y,1.0)*step(0.0,s.z)*step(s.z,1.0);
          float lit = texture(shadow, vec3(s.xy, s.z - .0015)) * inside;
          float density = exp(-max(p.y-2.0,0.0)*.075)*smoothstep(-1.0,2.0,p.y);
          opticalDepth += density * stepSize * .0018;
          light += lit * density * stepSize * exp(-opticalDepth);
        }
        float phase = .35 + pow(max(dot(ray, sunDirection), 0.0), 8.0) * 1.8;
        outColor = vec4(vec3(1.0,.8,.52) * light * strength * phase,exp(-opticalDepth));
      }`,
  });
  private composite = new T.ShaderMaterial({
    glslVersion: T.GLSL3, depthTest: true, depthWrite: true, depthFunc: T.AlwaysDepth,
    uniforms: { image: { value: this.target.texture }, depth: { value: this.target.depthTexture }, scattering: { value: this.scattering.texture } },
    vertexShader: `out vec2 screenUv; void main() { screenUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }`,
    fragmentShader: `uniform sampler2D image, depth, scattering;
      in vec2 screenUv; out vec4 outColor;
      #define gl_FragColor outColor
      void main() {
        vec4 volume=texture(scattering,screenUv);
        outColor=vec4(texture(image,screenUv).rgb*volume.a+volume.rgb,1.0);
        gl_FragDepth=texture(depth,screenUv).r;
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  private quad = new T.Mesh(new T.PlaneGeometry(2, 2), this.material);
  constructor() { this.scene.add(this.quad); }
  resize(width: number, height: number) {
    this.target.setSize(width, height);
    this.bloom.setSize(width, height);
    // Half each dimension for scattering only; scene depth and pixel art stay full size.
    this.scattering.setSize(Math.ceil(width / 2), Math.ceil(height / 2));
  }
  render(renderer: T.WebGLRenderer, scene: T.Scene, camera: T.PerspectiveCamera, sun: T.DirectionalLight) {
    renderer.setRenderTarget(this.target);
    renderer.render(scene, camera);
    // Bloom only the HDR environment; sprites and UI are drawn after composition.
    this.bloom.render(renderer, this.target, this.target, 0, false);
    const u = this.material.uniforms;
    u.shadow.value = sun.shadow.map!.depthTexture;
    u.shadowMatrix.value.copy(sun.shadow.matrix);
    u.inverseProjection.value.copy(camera.projectionMatrixInverse);
    u.cameraWorld.value.copy(camera.matrixWorld);
    u.eye.value.copy(camera.position);
    u.sunDirection.value.copy(sun.position).sub(sun.target.position).normalize();
    this.quad.material = this.material;
    renderer.setRenderTarget(this.scattering);
    renderer.render(this.scene, this.camera);
    this.quad.material = this.composite;
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
  }
  destroy() { this.target.dispose(); this.scattering.dispose(); this.bloom.dispose(); this.quad.geometry.dispose(); this.material.dispose(); this.composite.dispose(); }
}

const sunlight=new VillageSunlight();
sunlight.material.uniforms.strength.value=.0135;
init().catch(e=>{$('#loading').textContent='3D加载失败：'+String(e);console.error(e);});
