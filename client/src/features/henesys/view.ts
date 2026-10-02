import * as T from 'three';
import Phaser from 'phaser';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import type { MapDefinition } from '../../assets/manifest';
import { resolveAssetUrl } from '../../assets/resource-url';
import { PIXELS_PER_METRE, point3d, segmentAt, SKY_CITY_MAP_ID } from './coordinates';
import { VoyageCity } from '../entry/voyage-city';
import { Sunlight } from './sunlight';
import { LocalReveal } from './local-reveal';
import { villageInstruments } from './instruments';
import { VillageEnvironment } from './environment';
import type { EnvironmentSettings } from './environment-settings';
import type { PlayerState, NpcState, MonsterState } from '../../../../shared/protocol';
import { GroundFeedback, type GroundActor } from './ground-feedback';
import { SnowSurface, type SnowCover } from './ground-snow';
import { TownLamps, type LampActor } from './town-lamps';
import { sampleActorLight, multiplyArtTint } from './actor-lighting';
import './style.css';

type Display = Phaser.GameObjects.GameObject & {x:number;y:number;scaleX:number;scaleY:number;depth:number;visible:boolean;setPosition(x:number,y:number):Display;setScale(x:number,y:number):Display;setDepth(n:number):Display;getBounds():Phaser.Geom.Rectangle};
type Saved={o:Display;x:number;y:number;sx:number;sy:number;depth:number;z:number};
type ActorFoot={x:number;y:number;revealHeight?:number;revealWidth?:number;sceneTime?:number};
/** World retains every actor, animation, interaction and input. Only drawing coordinates
 * are projected for one render, then restored before any gameplay callback runs. */
export class HenesysView {
 private root=document.createElement('div');
 private roadLabel=document.createElement('div');
 private renderer:T.WebGLRenderer;
 private scene=new T.Scene();
 private camera=new T.PerspectiveCamera(38,1,.1,700);
 private paperScene=new T.Scene();
 private paperCamera=new T.OrthographicCamera(-1,1,1,-1,0,1);
 private texture:T.ExternalTexture;
 private phaser:Phaser.Renderer.WebGL.WebGLRenderer;
 private actors:Phaser.Renderer.WebGL.RenderTarget;
 private capturing=false;
 private depthTarget=new T.WebGLRenderTarget(1,1,{minFilter:T.NearestFilter,magFilter:T.NearestFilter,depthBuffer:false});
 private depthScene=new T.Scene();
 private depthGeometry=new T.PlaneGeometry(1,1);
 private depthMaterial=new T.ShaderMaterial({glslVersion:T.GLSL3,depthTest:false,depthWrite:false,toneMapped:false,
  vertexShader:'out vec3 encoded;void main(){encoded=instanceColor;gl_Position=instanceMatrix*vec4(position.xy,0.,1.);}',
  fragmentShader:'in vec3 encoded;out vec4 outColor;void main(){outColor=vec4(encoded,1.);}'});
 private depthRects?:T.InstancedMesh;
 private paper:T.Mesh<T.PlaneGeometry,T.ShaderMaterial>;
 private saved:Saved[]=[];
 private rasterCamera?:Pick<Phaser.Cameras.Scene2D.Camera,'x'|'y'|'width'|'height'|'scrollX'|'scrollY'|'zoomX'|'zoomY'|'roundPixels'|'useBounds'>;
 private model:T.Group;
 private city?:VoyageCity;
 private surfaces:T.Object3D[]=[];
 private reveal:LocalReveal;
 private shadowCell=new T.Vector3(Infinity,Infinity,Infinity);
 private footShadow=new T.Mesh(new T.CircleGeometry(.55,24),new T.MeshBasicMaterial({color:0x22382b,transparent:true,opacity:.18,depthWrite:false}));
 private sun=new T.DirectionalLight(0xffe6c2,3.1);
 private sunlight=new Sunlight();
 private environment:T.WebGLRenderTarget;
 private dawnEnvironment:T.WebGLRenderTarget;
 private pmrem:T.PMREMGenerator;
 private climate:VillageEnvironment;
 private sourceMaterials=new Set<T.Material>();
 private snow:SnowSurface;
 private groundFeedback:GroundFeedback;
 private townLamps:TownLamps;
 private groundActors:GroundActor[]=[];
 private lampActors:LampActor[]=[];
 private selfId='';
 private actorArt:{art:Phaser.GameObjects.GameObject;point:readonly number[]}[]=[];
 private lightTints:{image:Phaser.GameObjects.Image;tl:number;tr:number;bl:number;br:number;fill:boolean}[]=[];
 private lightTintCount=0;
 private artLight={r:1,g:1,b:1};
 private width=0;private height=0;private pitch=.24;private yaw=0;private zoom=1.2;
 private disposed=false;private quality=true;private drag?:{id:number;x:number;y:number};
 private skyPreview=false;
 static async create(world:Phaser.Scene,map:MapDefinition,self:()=>ActorFoot|undefined,current:()=>boolean){
  const [gltf,hdr]=await Promise.all([new GLTFLoader().loadAsync(resolveAssetUrl(map.id===SKY_CITY_MAP_ID?'/assets/entry/sky-city.glb':'/assets/henesys/chuxian-east.glb')),new EXRLoader().loadAsync(resolveAssetUrl('/assets/henesys/dawn.exr'))]);
  if(!current()){HenesysView.disposeModel(gltf.scene);hdr.dispose();return undefined;}
  try{return new HenesysView(world,map,gltf.scene,hdr,self);}catch(e){HenesysView.disposeModel(gltf.scene);hdr.dispose();throw e;}
 }
 constructor(private world:Phaser.Scene,private map:MapDefinition,model:T.Group,hdr:T.DataTexture,private self:()=>ActorFoot|undefined){
  if(map.id!==SKY_CITY_MAP_ID)model.add(villageInstruments());this.model=model;this.root.className='henesys-view';this.root.setAttribute('aria-label',`${map.name}，方向键沿路行走并选择路口方向，交互与跳跃可共键，右键调整视角`);
  this.roadLabel.className='henesys-road-label';this.root.append(this.roadLabel);
  this.phaser=world.game.renderer as Phaser.Renderer.WebGL.WebGLRenderer;
  if(!(this.phaser.gl instanceof WebGL2RenderingContext))throw new Error('初弦地需要WebGL2');
  // Share one GPU context: the paper dolls stay in a framebuffer, never read back through a canvas.
  this.renderer=new T.WebGLRenderer({canvas:world.game.canvas,context:this.phaser.gl as WebGL2RenderingContext});
  this.actors=new Phaser.Renderer.WebGL.RenderTarget(this.phaser,1,1,1,1,true,true,false,true);
  this.renderer.outputColorSpace=T.SRGBColorSpace;this.renderer.toneMapping=T.NeutralToneMapping;this.renderer.toneMappingExposure=1.1;
  this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=T.PCFSoftShadowMap;
  this.pmrem=new T.PMREMGenerator(this.renderer);this.environment=this.dawnEnvironment=this.pmrem.fromEquirectangular(hdr);hdr.dispose();
  this.scene.environment=this.environment.texture;
  this.sun.castShadow=true;Object.assign(this.sun.shadow.camera,{left:-64,right:64,top:58,bottom:-58,near:1,far:350});this.sun.shadow.mapSize.set(4096,4096);this.sun.shadow.normalBias=.05;this.sun.shadow.bias=-.00006;
  this.sun.shadow.autoUpdate=false;this.sun.shadow.needsUpdate=true;
  this.scene.add(this.sun,this.sun.target,model);this.footShadow.rotation.x=-Math.PI/2;this.scene.add(this.footShadow);model.updateMatrixWorld(true);
  const vegetation:T.Object3D[]=[];
  model.traverse(o=>{
   if(o.userData.layer==='vegetation')vegetation.push(o);
   if(!(o instanceof T.Mesh))return;o.castShadow=true;o.receiveShadow=true;this.surfaces.push(o);
   for(const m of Array.isArray(o.material)?o.material:[o.material]){this.sourceMaterials.add(m);const p=m as T.MeshStandardMaterial;if(p.map)p.map.anisotropy=Math.min(4,this.renderer.capabilities.getMaxAnisotropy());}
   if((o.userData.layer??o.parent?.userData.layer)==='water'){o.material=new T.MeshPhysicalMaterial({color:0x69aaa1,roughness:.22,metalness:.15,transparent:true,opacity:.92});o.castShadow=false;}
  });
  // Native Three instancing of the existing CC0 trees; source objects remain in Blender.
  const batches=new Map<string,{geometry:T.BufferGeometry;material:T.Material;objects:T.Mesh[]}>();
  for(const v of vegetation)v.traverse(o=>{if(!(o instanceof T.Mesh)||Array.isArray(o.material))return;const key=o.geometry.uuid+o.material.uuid,b=batches.get(key)??{geometry:o.geometry,material:o.material,objects:[] as T.Mesh[]};b.objects.push(o);batches.set(key,b);});
  const forest=new T.Group();forest.userData.layer='vegetation';model.add(forest);
  for(const b of batches.values()){if(b.objects.length<2)continue;const inst=new T.InstancedMesh(b.geometry,b.material,b.objects.length);inst.castShadow=true;inst.receiveShadow=true;b.objects.forEach((o,i)=>{inst.setMatrixAt(i,o.matrixWorld);o.visible=false;});inst.computeBoundingSphere();forest.add(inst);}
  if(map.id===SKY_CITY_MAP_ID)this.city=new VoyageCity(model);
  this.reveal=new LocalReveal(model);
  this.climate=new VillageEnvironment(this.scene,this.sun,model);
  this.snow=new SnowSurface(model);
  this.groundFeedback=new GroundFeedback(this.scene,step=>this.snow.stamp({x:step.point[0],y:step.point[1],z:step.point[2]},{x:step.direction[0],z:step.direction[2]},step.mount));
  this.townLamps=new TownLamps(this.scene);
  this.texture=new T.ExternalTexture(this.actors.texture.webGLTexture);
  const material=new T.ShaderMaterial({glslVersion:T.GLSL3,transparent:true,premultipliedAlpha:true,depthTest:true,depthWrite:true,toneMapped:false,uniforms:{image:{value:this.texture},actorDepth:{value:this.depthTarget.texture}},vertexShader:`out vec2 screenUv;void main(){screenUv=uv;gl_Position=vec4(position.xy,0.,1.);}`,fragmentShader:`uniform sampler2D image,actorDepth;in vec2 screenUv;out vec4 outColor;
#define gl_FragColor outColor
void main(){vec4 art=texture(image,screenUv);if(art.a<.005)discard;vec3 encoded=texture(actorDepth,screenUv).rgb;gl_FragDepth=dot(encoded,vec3(65536.,256.,1.))*255./16777215.;outColor=art;
// The Phaser RGBA8 framebuffer already contains display-space pixel art.
}`});
  this.paper=new T.Mesh(new T.PlaneGeometry(2,2),material);this.paperScene.add(this.paper);
  const canvas=this.root;canvas.addEventListener('pointerdown',this.down);canvas.addEventListener('pointermove',this.move);canvas.addEventListener('pointerup',this.up);canvas.addEventListener('pointercancel',this.up);canvas.addEventListener('contextmenu',this.context);canvas.addEventListener('wheel',this.wheel,{passive:false});
  world.game.canvas.parentElement!.append(this.root);world.game.canvas.parentElement!.classList.add('show-henesys');
  world.game.events.on('prerender',this.prepare);world.game.events.on('postrender',this.draw);
  this.renderer.resetState();this.phaser.pipelines.rebind();
 }
 movementView(){
  const source=this.world.cameras.main,distance=source.height/PIXELS_PER_METRE/(2*Math.tan(T.MathUtils.degToRad(19)))*this.zoom;
  // Projection at the character's feet includes the camera's target height.
  return {yaw:this.yaw,pitch:Math.atan2(distance*Math.sin(this.pitch)+Math.min(270,source.height*.3)/PIXELS_PER_METRE,distance*Math.cos(this.pitch))};
 }
 resetCamera(){this.yaw=0;this.pitch=.24;this.zoom=1.2;}
 get snowCover():SnowCover{return {...this.snow.cover};}
 setSnowCover(cover:SnowCover){this.snow.cover={...cover};}
 toggleQuality(){this.quality=!this.quality;this.townLamps.setQuality(this.quality);this.sunlight.resize(this.depthTarget.width,this.depthTarget.height,this.quality);}
 /** Same interpolated positions as the authored art, not another movement simulation. */
 syncActors(players:readonly PlayerState[],npcs:readonly NpcState[],monsters:readonly MonsterState[],selfId:string,art:Map<string,Phaser.GameObjects.GameObject>,teleported:ReadonlySet<string>){
  this.selfId=selfId;this.groundActors.length=0;this.lampActors.length=0;this.actorArt.length=0;
  for(const player of players){
   const point=this.point(player.x,player.y),body=art.get(player.id);
   this.groundActors.push({...player,point,surface: this.city?'stone':undefined,teleported:teleported.has(player.id)});
   this.lampActors.push({id:player.id,kind:'player',point,facing:player.facing,townLamp:player.townLamp,heightMetres:body?(body as Display).getBounds().height/PIXELS_PER_METRE:undefined});
   if(body)this.actorArt.push({art:body,point});
  }
  for(const npc of npcs){
   const id='npc:'+npc.id,point=this.point(npc.x,npc.y),body=art.get(id);
   this.groundActors.push({id,x:npc.x,y:npc.y,grounded:true,point,surface:this.city?'stone':undefined});
   this.lampActors.push({id,kind:'npc',point,facing:npc.facing,townLamp:npc.townLamp,heightMetres:body?(body as Display).getBounds().height/PIXELS_PER_METRE:undefined});
   if(body)this.actorArt.push({art:body,point});
  }
  for(const mob of monsters){const id='mob:'+mob.id,point=this.point(mob.x,mob.y),body=art.get(id);if(mob.emissive)this.lampActors.push({id,kind:'monster',point,emissive:mob.emissive});if(body)this.actorArt.push({art:body,point});}
 }
 private shadeArt(root:Phaser.GameObjects.GameObject){
  if(root.type==='Container'){for(const child of (root as Phaser.GameObjects.Container).list)this.shadeArt(child);return;}
  if(root.type!=='Image'&&root.type!=='Sprite')return;
  const image=root as Phaser.GameObjects.Image;
  const saved=this.lightTints[this.lightTintCount]??{image,tl:0,tr:0,bl:0,br:0,fill:false};
  saved.image=image;saved.tl=image.tintTopLeft;saved.tr=image.tintTopRight;saved.bl=image.tintBottomLeft;saved.br=image.tintBottomRight;saved.fill=image.tintFill;
  this.lightTints[this.lightTintCount++]=saved;
  const tl=multiplyArtTint(saved.tl,this.artLight),tr=multiplyArtTint(saved.tr,this.artLight),bl=multiplyArtTint(saved.bl,this.artLight),br=multiplyArtTint(saved.br,this.artLight);
  if(saved.fill)image.setTintFill(tl,tr,bl,br);else image.setTint(tl,tr,bl,br);
 }
 private point(x:number,y:number):[number,number,number]{
  const point=point3d(x,y,this.map.id);
  if(this.city){const {route}=segmentAt(x,this.map.id),t=T.MathUtils.clamp((x-route.start)/(route.end-route.start),0,1);point[1]+=.025+this.city.nodeOffset(route.nodes[0].name)*(1-t)+this.city.nodeOffset(route.nodes.at(-1)!.name)*t;}
  return point;
 }
 setEnvironment(value:EnvironmentSettings){this.climate.set(value);}
 previewSky(enabled:boolean){this.skyPreview=enabled;}
 project(x:number,y:number){const p=new T.Vector3(...this.point(x,y)).project(this.camera);return {x:(p.x+1)*this.width/2,y:(1-p.y)*this.height/2,z:(p.z+1)/2};}
 private prepare=(_renderer?:unknown,_time?:number,delta=1000/60)=>{
  if(this.disposed||!this.world.sys.isActive()||!this.world.sys.isVisible())return;
  const source=this.world.cameras.main,parent=this.root.parentElement!;if(!parent.clientWidth||!parent.clientHeight)return;
  // Environment quality must not lower the source pixel/text resolution.
  const ratio=Math.min(devicePixelRatio,2);
  if(this.width!==parent.clientWidth||this.height!==parent.clientHeight||this.renderer.getPixelRatio()!==ratio){this.width=parent.clientWidth;this.height=parent.clientHeight;this.renderer.setPixelRatio(ratio);this.renderer.setSize(this.width,this.height,false);this.camera.aspect=this.width/this.height;this.camera.updateProjectionMatrix();const w=Math.round(this.width*ratio),h=Math.round(this.height*ratio);this.sunlight.resize(w,h,this.quality);this.depthTarget.setSize(w,h);}
  const actor=this.self();if(!actor)return;
  this.city?.update(delta/1000,matchMedia('(prefers-reduced-motion: reduce)').matches,1,actor.sceneTime);
  const foot=new T.Vector3(...this.point(actor.x,actor.y)),base=foot.clone().add(new T.Vector3(0,Math.min(270,source.height*.3)/PIXELS_PER_METRE,0));
  const distance=source.height/PIXELS_PER_METRE/(2*Math.tan(T.MathUtils.degToRad(19)))*this.zoom;
  const offset=new T.Vector3(Math.sin(this.yaw)*Math.cos(this.pitch),Math.sin(this.pitch),Math.cos(this.yaw)*Math.cos(this.pitch)).multiplyScalar(distance);
  // Road changes only update the continuous foot target; reframing is manual.
  this.camera.position.copy(base).add(offset);this.camera.lookAt(base);this.camera.updateMatrixWorld();
  if(this.skyPreview){this.camera.position.copy(base).add(new T.Vector3(Math.sin(this.yaw)*distance*2,14,Math.cos(this.yaw)*distance*2));this.camera.lookAt(this.climate.light.daylight>.5?this.climate.uniforms.solarDirection.value.clone().multiplyScalar(490):base.clone().add(new T.Vector3(0,40,-180)));this.camera.updateMatrixWorld();}
  // Static scenery needs a new shadow only when the local coverage cell changes.
  const cell=new T.Vector3(Math.floor(base.x/8)*8,Math.floor(base.y/8)*8,Math.floor(base.z/8)*8);
  if(!this.shadowCell.equals(cell)){this.shadowCell.copy(cell);this.sun.shadow.needsUpdate=true;}
  this.sun.target.position.copy(cell);this.sun.position.copy(cell).addScaledVector(this.climate.uniforms.solarDirection.value,150);
  const now=performance.now(),seconds=now/1000;
  this.climate.update(base,seconds,ratio);
  if(this.snow.update(this.climate.settings,Math.min(delta/1000,.1),seconds))this.sun.shadow.needsUpdate=true;
  this.climate.uniforms.winterSnow.value=this.snow.amount;
  this.groundFeedback.update(this.groundActors,{moisture:this.climate.light.wet,snow:this.snow.amount,daylight:this.climate.light.daylight},now,foot.toArray(),ratio,this.height);
  const samples=this.townLamps.update(this.lampActors,this.selfId,seconds,{right:[Math.cos(this.yaw),0,-Math.sin(this.yaw)],strength:.15+.85*(1-this.climate.light.daylight)});
  for(const actor of this.actorArt){sampleActorLight(actor.point,this.climate.light.daylight,samples,this.artLight);this.shadeArt(actor.art);}
  if(this.climate.consumeSkyChange()){
   this.renderer.resetState();
   if(this.environment!==this.dawnEnvironment)this.environment.dispose();
   const s=this.climate.settings;
   this.environment=s.hour>=5.5&&s.hour<=7.5&&s.weather==='clear'?this.dawnEnvironment:this.pmrem.fromScene(this.climate.skyScene,0,.1,700);
   this.scene.environment=this.environment.texture;this.scene.environmentIntensity=.35+this.climate.light.daylight*.75;
   this.renderer.resetState();this.phaser.pipelines.rebind();
  }
  const ground=segmentAt(actor.x,this.map.id),t=(actor.x-ground.a.x)/(ground.b.x-ground.a.x),groundY=-(ground.a.y+(ground.b.y-ground.a.y)*t)/PIXELS_PER_METRE;
  const roadName=`${this.map.name} · ${ground.route.name}`;if(this.roadLabel.textContent!==roadName)this.roadLabel.textContent=roadName;
  this.footShadow.position.set(foot.x,this.point(actor.x,-groundY*PIXELS_PER_METRE)[1]+.018,foot.z);this.footShadow.material.opacity=.18/(1+Math.max(0,foot.y-groundY));
  this.reveal.update(foot,this.camera,this.width,this.height,ratio,delta,performance.now(),actor.revealHeight,actor.revealWidth);
  // Rasterize at final physical resolution before any detail can be lost.
  this.resizeSource(this.depthTarget.width,this.depthTarget.height);
  this.rasterCamera={x:source.x,y:source.y,width:source.width,height:source.height,scrollX:source.scrollX,scrollY:source.scrollY,zoomX:source.zoomX,zoomY:source.zoomY,roundPixels:source.roundPixels,useBounds:source.useBounds};
  source.setViewport(0,0,this.depthTarget.width,this.depthTarget.height).setZoom(1).setScroll(0,0);source.useBounds=false;source.roundPixels=false;
  const texts=[...this.world.children.list];
  for(let i=0;i<texts.length;i++){const o=texts[i] as Phaser.GameObjects.Text|Phaser.GameObjects.Container;if(o.type==='Text'){const text=o as Phaser.GameObjects.Text;if(text.style.resolution<2)text.setResolution(2);}else if(o.type==='Container')texts.push(...(o as Phaser.GameObjects.Container).list);}
  this.saved=[];
  for(const item of this.world.children.list){const o=item as Display;if(!o.visible||typeof o.x!=='number'||typeof o.getBounds!=='function')continue;
   // A 2D name below the feet would be inside the 3D ground; use its above-head display anchor.
   const y=o.getData('projectionY')??o.y,p=this.project(o.x,y);if(p.z<0||p.z>1)continue;
   const v=new T.Vector3(...this.point(o.x,y)).applyMatrix4(this.camera.matrixWorldInverse);const scale=this.height/(-v.z*2*Math.tan(T.MathUtils.degToRad(19)))/PIXELS_PER_METRE;
   this.saved.push({o,x:o.x,y:o.y,sx:o.scaleX,sy:o.scaleY,depth:o.depth,z:p.z});
   // Labels keep their authored CSS size; perspective remains on sprite art.
   const artScale=(o.type==='Text'?Math.max(1,scale):scale)*ratio;
   o.setPosition(Math.round(p.x*ratio),Math.round(p.y*ratio)).setScale(o.scaleX*artScale,o.scaleY*artScale).setDepth(-p.z*100000+o.depth*.001);
  }
  // ponytail: one packed depth rectangle per root; split only a VFX root with visible depth variation.
  if(!this.depthRects||this.saved.length>this.depthRects.instanceMatrix.count){
   this.depthRects?.dispose();this.depthScene.clear();this.depthRects=new T.InstancedMesh(this.depthGeometry,this.depthMaterial,Math.max(16,2**Math.ceil(Math.log2(this.saved.length))));this.depthRects.frustumCulled=false;this.depthRects.instanceMatrix.setUsage(T.DynamicDrawUsage);this.depthScene.add(this.depthRects);
  }
  const matrix=new T.Matrix4(),color=new T.Color(),w=this.depthTarget.width,h=this.depthTarget.height;
  [...this.saved].sort((a,b)=>b.z-a.z).forEach((s,i)=>{
   const b=s.o.getBounds(),x=Math.floor(b.x),y=Math.floor(b.y),bw=Math.ceil(b.width)+1,bh=Math.ceil(b.height)+1,packed=Math.round(s.z*16777215);
   matrix.makeScale(bw*2/w,bh*2/h,1).setPosition((x+bw/2)*2/w-1,1-(y+bh/2)*2/h,0);
   this.depthRects!.setMatrixAt(i,matrix);this.depthRects!.setColorAt(i,color.setRGB((packed>>>16)/255,(packed>>>8&255)/255,(packed&255)/255));
  });
  this.depthRects.count=this.saved.length;this.depthRects.instanceMatrix.needsUpdate=true;if(this.depthRects.instanceColor)this.depthRects.instanceColor.needsUpdate=true;
  this.actors.bind(true,w,h);this.phaser.setProjectionMatrix(w,h);this.capturing=true;
 };
 private resizeSource(width:number,height:number){const canvas=this.world.game.canvas;if(canvas.width===width&&canvas.height===height&&this.phaser.width===width&&this.phaser.height===height)return;canvas.width=width;canvas.height=height;this.phaser.resize(width,height);}
 private restore(){
  for(let i=0;i<this.lightTintCount;i++){const s=this.lightTints[i],image=s.image;if(!image.scene)continue;if(s.fill)image.setTintFill(s.tl,s.tr,s.bl,s.br);else image.setTint(s.tl,s.tr,s.bl,s.br);}
  this.lightTintCount=0;
  for(const s of this.saved){if(s.o.scene)s.o.setPosition(s.x,s.y).setScale(s.sx,s.sy).setDepth(s.depth);}this.saved=[];
  if(this.rasterCamera){const c=this.world.cameras.main,s=this.rasterCamera;c.setViewport(s.x,s.y,s.width,s.height).setZoom(s.zoomX,s.zoomY).setScroll(s.scrollX,s.scrollY);c.roundPixels=s.roundPixels;c.useBounds=s.useBounds;c.preRender();this.rasterCamera=undefined;}
 }
 private draw=()=>{
  if(this.capturing){this.actors.unbind(true);this.phaser.resetProjectionMatrix();this.capturing=false;}
  if(this.disposed||!this.saved.length){this.restore();return;}
  try{this.phaser.pipelines.clear();this.renderer.resetState();this.texture.sourceTexture=this.actors.texture.webGLTexture;this.renderer.setRenderTarget(this.depthTarget);this.renderer.setClearColor(0xffffff,1);this.renderer.render(this.depthScene,this.paperCamera);this.renderer.setClearColor(0,0);this.renderer.setRenderTarget(null);this.sunlight.render(this.renderer,this.scene,this.camera,this.sun,this.climate);this.renderer.autoClear=false;this.renderer.render(this.paperScene,this.paperCamera);this.renderer.autoClear=true;}finally{this.renderer.resetState();this.phaser.pipelines.rebind();this.restore();}
 };
 private forward(e:PointerEvent,type:string){const b=this.root.getBoundingClientRect(),c=this.world.game.canvas,s=c.getBoundingClientRect();c.dispatchEvent(new MouseEvent(type,{clientX:s.left+(e.clientX-b.left)/b.width*s.width,clientY:s.top+(e.clientY-b.top)/b.height*s.height,button:0,buttons:e.buttons&1,bubbles:true,cancelable:true,view:window}));}
 private down=(e:PointerEvent)=>{e.preventDefault();this.root.setPointerCapture(e.pointerId);if(e.button===2)this.drag={id:e.pointerId,x:e.clientX,y:e.clientY};else if(e.button===0)this.forward(e,'mousedown');};
 private move=(e:PointerEvent)=>{if(this.drag?.id===e.pointerId){this.yaw=T.MathUtils.clamp(this.yaw-(e.clientX-this.drag.x)*.004,-.45,.45);this.pitch=T.MathUtils.clamp(this.pitch+(e.clientY-this.drag.y)*.003,.08,.46);this.drag={id:e.pointerId,x:e.clientX,y:e.clientY};}else this.forward(e,'mousemove');};
 private up=(e:PointerEvent)=>{if(this.drag?.id===e.pointerId)this.drag=undefined;else if(e.button===0)this.forward(e,'mouseup');};
 private context=(e:Event)=>e.preventDefault();
 private wheel=(e:WheelEvent)=>{e.preventDefault();this.zoom=T.MathUtils.clamp(this.zoom*Math.exp(T.MathUtils.clamp(e.deltaY,-100,100)*.002),.9,1.7);};
 private static disposeModel(root:T.Object3D){const textures=new Set<T.Texture>(),materials=new Set<T.Material>(),geometries=new Set<T.BufferGeometry>();root.traverse(o=>{if(!(o instanceof T.Mesh))return;geometries.add(o.geometry);for(const m of Array.isArray(o.material)?o.material:[o.material]){materials.add(m);for(const v of Object.values(m))if(v instanceof T.Texture)textures.add(v);}});textures.forEach(t=>t.dispose());materials.forEach(m=>m.dispose());geometries.forEach(g=>g.dispose());}
 destroy(){if(this.disposed)return;this.disposed=true;this.restore();this.world.game.events.off('prerender',this.prepare);this.world.game.events.off('postrender',this.draw);this.root.parentElement?.classList.remove('show-henesys');this.root.remove();this.resizeSource(this.world.game.scale.width,this.world.game.scale.height);this.groundFeedback.destroy();this.snow.destroy();this.townLamps.destroy();HenesysView.disposeModel(this.scene);HenesysView.disposeModel(this.paperScene);this.reveal.destroy();this.sourceMaterials.forEach(m=>m.dispose());this.depthRects?.dispose();this.depthGeometry.dispose();this.depthMaterial.dispose();this.depthTarget.dispose();this.sunlight.destroy();this.climate.destroy();this.sun.shadow.dispose();if(this.environment!==this.dawnEnvironment)this.environment.dispose();this.dawnEnvironment.dispose();this.pmrem.dispose();this.actors.destroy();this.texture.dispose();this.renderer.dispose();this.phaser.pipelines.rebind();}
}
