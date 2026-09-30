import * as T from 'three';
import type Phaser from 'phaser';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { Sky } from 'three/addons/objects/Sky.js';
import type { MapDefinition } from '../../assets/manifest';
import { resolveAssetUrl } from '../../assets/resource-url';
import { PIXELS_PER_METRE, point3d, segmentAt } from './coordinates';
import { Sunlight } from './sunlight';
import './style.css';

type Display = Phaser.GameObjects.GameObject & {x:number;y:number;scaleX:number;scaleY:number;depth:number;visible:boolean;setPosition(x:number,y:number):Display;setScale(x:number,y:number):Display;setDepth(n:number):Display;getBounds():Phaser.Geom.Rectangle};
type Saved={o:Display;x:number;y:number;sx:number;sy:number;depth:number;z:number};
/** World retains every actor, animation, interaction and input. Only drawing coordinates
 * are projected for one render, then restored before any gameplay callback runs. */
export class HenesysView {
 private root=document.createElement('div');
 private renderer:T.WebGLRenderer;
 private scene=new T.Scene();
 private camera=new T.PerspectiveCamera(38,1,.1,700);
 private paperScene=new T.Scene();
 private paperCamera=new T.OrthographicCamera(-1,1,1,-1,0,1);
 private texture:T.CanvasTexture;
 private depthCanvas=document.createElement('canvas');
 private depthTexture:T.CanvasTexture;
 private paper:T.Mesh<T.PlaneGeometry,T.ShaderMaterial>;
 private saved:Saved[]=[];
 private rasterCamera?:Pick<Phaser.Cameras.Scene2D.Camera,'x'|'y'|'width'|'height'|'scrollX'|'scrollY'|'zoomX'|'zoomY'|'roundPixels'|'useBounds'>;
 private liftAt=new T.Vector3(Infinity,Infinity,Infinity);private liftDistance=0;private wantedLift=0;
 private model:T.Group;
 private surfaces:T.Object3D[]=[];
 private faded=new Map<T.Mesh,T.Material|T.Material[]>();private fadeAt=0;
 private footShadow=new T.Mesh(new T.CircleGeometry(.55,24),new T.MeshBasicMaterial({color:0x22382b,transparent:true,opacity:.18,depthWrite:false}));
 private ray=new T.Raycaster();
 private sun=new T.DirectionalLight(0xffe6c2,3.1);
 private sunlight=new Sunlight();
 private environment:T.WebGLRenderTarget;
 private sourceMaterials=new Set<T.Material>();
 private width=0;private height=0;private pitch=.24;private yaw=0;private zoom=1.2;private lift=0;
 private disposed=false;private quality=true;private drag?:{id:number;x:number;y:number};
 static async create(world:Phaser.Scene,map:MapDefinition,self:()=>{x:number;y:number}|undefined,current:()=>boolean){
  const [gltf,hdr]=await Promise.all([new GLTFLoader().loadAsync(resolveAssetUrl('/assets/henesys/chuxian-east.glb')),new EXRLoader().loadAsync(resolveAssetUrl('/assets/henesys/dawn.exr'))]);
  if(!current()){HenesysView.disposeModel(gltf.scene);hdr.dispose();return undefined;}
  try{return new HenesysView(world,map,gltf.scene,hdr,self);}catch(e){HenesysView.disposeModel(gltf.scene);hdr.dispose();throw e;}
 }
 constructor(private world:Phaser.Scene,_map:MapDefinition,model:T.Group,hdr:T.DataTexture,private self:()=>{x:number;y:number}|undefined){
  this.model=model;this.root.className='henesys-view';this.root.setAttribute('aria-label','初弦地东边村落，方向键沿道路与岔口行走，跳跃，右键调整视角');
  this.renderer=new T.WebGLRenderer({antialias:true,powerPreference:'high-performance'});
  this.renderer.outputColorSpace=T.SRGBColorSpace;this.renderer.toneMapping=T.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.05;
  this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=T.PCFSoftShadowMap;this.root.append(this.renderer.domElement);
  const pmrem=new T.PMREMGenerator(this.renderer);this.environment=pmrem.fromEquirectangular(hdr);pmrem.dispose();hdr.dispose();
  this.scene.environment=this.environment.texture;this.scene.environmentIntensity=.85;
  const sky=new Sky();sky.scale.setScalar(500);Object.assign(sky.material.uniforms.turbidity,{value:3});sky.material.uniforms.rayleigh.value=1.6;sky.material.uniforms.mieCoefficient.value=.008;sky.material.uniforms.mieDirectionalG.value=.85;sky.material.uniforms.sunPosition.value.set(-26,20,-95);
  sky.material.fragmentShader=sky.material.fragmentShader.replace('vec4( texColor, 1.0 )','vec4( texColor * 0.075, 1.0 )');this.scene.add(sky);
  this.scene.add(new T.HemisphereLight(0xd4e9ff,0x72805c,.65));
  const bounce=new T.DirectionalLight(0xa8c9e6,.5);bounce.position.set(45,20,36);this.scene.add(bounce);
  this.sun.castShadow=true;Object.assign(this.sun.shadow.camera,{left:-42,right:42,top:36,bottom:-36,near:1,far:150});this.sun.shadow.mapSize.set(2048,2048);this.sun.shadow.normalBias=.025;this.sun.shadow.bias=-.00012;
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
  const forest=new T.Group();model.add(forest);
  for(const b of batches.values()){if(b.objects.length<2)continue;const inst=new T.InstancedMesh(b.geometry,b.material,b.objects.length);inst.castShadow=true;inst.receiveShadow=true;b.objects.forEach((o,i)=>{inst.setMatrixAt(i,o.matrixWorld);o.visible=false;});inst.computeBoundingSphere();forest.add(inst);}
  this.texture=new T.CanvasTexture(world.game.canvas);this.texture.colorSpace=T.SRGBColorSpace;this.texture.minFilter=T.NearestFilter;this.texture.magFilter=T.NearestFilter;this.texture.generateMipmaps=false;
  this.depthTexture=new T.CanvasTexture(this.depthCanvas);this.depthTexture.minFilter=T.NearestFilter;this.depthTexture.magFilter=T.NearestFilter;this.depthTexture.generateMipmaps=false;
  const material=new T.ShaderMaterial({glslVersion:T.GLSL3,transparent:true,depthTest:true,depthWrite:true,toneMapped:false,uniforms:{image:{value:this.texture},actorDepth:{value:this.depthTexture}},vertexShader:`out vec2 screenUv;void main(){screenUv=uv;gl_Position=vec4(position.xy,0.,1.);}`,fragmentShader:`uniform sampler2D image,actorDepth;in vec2 screenUv;out vec4 outColor;
#define gl_FragColor outColor
void main(){vec4 art=texture(image,screenUv);if(art.a<.005)discard;vec3 encoded=texture(actorDepth,screenUv).rgb;gl_FragDepth=dot(encoded,vec3(65536.,256.,1.))*255./16777215.;outColor=art;
#include <colorspace_fragment>
}`});
  this.paper=new T.Mesh(new T.PlaneGeometry(2,2),material);this.paperScene.add(this.paper);
  const canvas=this.renderer.domElement;canvas.addEventListener('pointerdown',this.down);canvas.addEventListener('pointermove',this.move);canvas.addEventListener('pointerup',this.up);canvas.addEventListener('pointercancel',this.up);canvas.addEventListener('contextmenu',this.context);canvas.addEventListener('wheel',this.wheel,{passive:false});
  world.game.canvas.parentElement!.append(this.root);world.game.canvas.parentElement!.classList.add('show-henesys');
  world.game.events.on('prerender',this.prepare);world.game.events.on('postrender',this.draw);
 }
 resetCamera(){this.yaw=0;this.pitch=.24;this.zoom=1.2;}
 toggleQuality(){this.quality=!this.quality;}
 project(x:number,y:number){const p=new T.Vector3(...point3d(x,y)).project(this.camera);return {x:(p.x+1)*this.width/2,y:(1-p.y)*this.height/2,z:(p.z+1)/2};}
 private prepare=(_renderer?:unknown,_time?:number,delta=1000/60)=>{
  if(this.disposed||!this.world.sys.isActive()||!this.world.sys.isVisible())return;
  const source=this.world.cameras.main,parent=this.root.parentElement!;if(!parent.clientWidth||!parent.clientHeight)return;
  // Environment quality must not lower the source pixel/text resolution.
  const ratio=Math.min(devicePixelRatio,2);
  if(this.width!==parent.clientWidth||this.height!==parent.clientHeight||this.renderer.getPixelRatio()!==ratio){this.width=parent.clientWidth;this.height=parent.clientHeight;this.renderer.setPixelRatio(ratio);this.renderer.setSize(this.width,this.height,false);this.camera.aspect=this.width/this.height;this.camera.updateProjectionMatrix();this.sunlight.resize(Math.round(this.width*ratio),Math.round(this.height*ratio));this.depthCanvas.width=Math.round(this.width*ratio);this.depthCanvas.height=Math.round(this.height*ratio);}
  const actor=this.self();if(!actor)return;
  const foot=new T.Vector3(...point3d(actor.x,actor.y)),base=foot.clone().add(new T.Vector3(0,Math.min(270,source.height*.3)/PIXELS_PER_METRE,0));
  const distance=source.height/PIXELS_PER_METRE/(2*Math.tan(T.MathUtils.degToRad(19)))*this.zoom;
  const offset=new T.Vector3(Math.sin(this.yaw)*Math.cos(this.pitch),Math.sin(this.pitch),Math.cos(this.yaw)*Math.cos(this.pitch)).multiplyScalar(distance);
  // Preserve the fixed angle; a bounded lift exposes the current foot without revealing remote hidden lanes.
  if(this.liftAt.distanceTo(foot)>.6||Math.abs(this.liftDistance-distance)>.3||this.drag){
  let wanted=0;for(;wanted<=6;wanted+=.5){const eye=base.clone().add(offset).add(new T.Vector3(0,wanted,0)),aim=foot.clone().add(new T.Vector3(0,.16,0));this.ray.set(eye,aim.clone().sub(eye).normalize());this.ray.far=eye.distanceTo(aim)-.08;if(!this.ray.intersectObjects(this.surfaces.filter(o=>o.userData.layer==='terrain'||o.userData.layer==='roads'),false).length)break;}
  this.wantedLift=Math.min(wanted,6);this.liftAt.copy(foot);this.liftDistance=distance;
  }
  this.lift=T.MathUtils.lerp(this.lift,this.wantedLift,1-Math.exp(-Math.min(delta,100)/130));base.y+=this.lift;this.camera.position.copy(base).add(offset);this.camera.lookAt(base);this.camera.updateMatrixWorld();
  this.sun.target.position.copy(base);this.sun.position.copy(base).add(new T.Vector3(-26,20,-95));
  const ground=segmentAt(actor.x),t=(actor.x-ground.a.x)/(ground.b.x-ground.a.x),groundY=-(ground.a.y+(ground.b.y-ground.a.y)*t)/PIXELS_PER_METRE;
  this.footShadow.position.set(foot.x,groundY+.018,foot.z);this.footShadow.material.opacity=.18/(1+Math.max(0,foot.y-groundY));
  if(performance.now()-this.fadeAt>180){
   this.fadeAt=performance.now();const blocked=new Set<T.Mesh>();
   for(const height of [.15,1.15]){const p=foot.clone().add(new T.Vector3(0,height,0));this.ray.set(this.camera.position,p.clone().sub(this.camera.position).normalize());this.ray.far=this.camera.position.distanceTo(p)-.05;
    for(const hit of this.ray.intersectObjects(this.surfaces,false)){const mesh=hit.object as T.Mesh,layer=mesh.userData.layer??mesh.parent?.userData.layer;
     if((layer==='props'||layer==='buildings')&&hit.point.distanceTo(foot)<5)blocked.add(mesh);
    }
   }
   for(const mesh of blocked)if(!this.faded.has(mesh)){this.faded.set(mesh,mesh.material);mesh.material=Array.isArray(mesh.material)?mesh.material.map(m=>m.clone()):mesh.material.clone();}
   for(const [mesh] of this.faded)for(const m of Array.isArray(mesh.material)?mesh.material:[mesh.material]){const on=blocked.has(mesh);if(m.transparent!==on){m.transparent=on;m.needsUpdate=true;}m.opacity=on ? .18 : 1;m.depthWrite=!on;}
  }
  // Rasterize at final physical resolution before any detail can be lost.
  this.resizeSource(this.depthCanvas.width,this.depthCanvas.height);
  this.rasterCamera={x:source.x,y:source.y,width:source.width,height:source.height,scrollX:source.scrollX,scrollY:source.scrollY,zoomX:source.zoomX,zoomY:source.zoomY,roundPixels:source.roundPixels,useBounds:source.useBounds};
  source.setViewport(0,0,this.depthCanvas.width,this.depthCanvas.height).setZoom(1).setScroll(0,0);source.useBounds=false;source.roundPixels=false;
  const texts=[...this.world.children.list];
  for(let i=0;i<texts.length;i++){const o=texts[i] as Phaser.GameObjects.Text|Phaser.GameObjects.Container;if(o.type==='Text'){const text=o as Phaser.GameObjects.Text;if(text.style.resolution<2)text.setResolution(2);}else if(o.type==='Container')texts.push(...(o as Phaser.GameObjects.Container).list);}
  this.saved=[];
  for(const item of this.world.children.list){const o=item as Display;if(!o.visible||typeof o.x!=='number'||typeof o.getBounds!=='function')continue;
   // A 2D name below the feet would be inside the 3D ground; use its above-head display anchor.
   const y=o.getData('projectionY')??o.y,p=this.project(o.x,y);if(p.z<0||p.z>1)continue;
   const v=new T.Vector3(...point3d(o.x,y)).applyMatrix4(this.camera.matrixWorldInverse);const scale=this.height/(-v.z*2*Math.tan(T.MathUtils.degToRad(19)))/PIXELS_PER_METRE;
   this.saved.push({o,x:o.x,y:o.y,sx:o.scaleX,sy:o.scaleY,depth:o.depth,z:p.z});
   // Labels keep their authored CSS size; perspective remains on sprite art.
   const artScale=(o.type==='Text'?Math.max(1,scale):scale)*ratio;
   o.setPosition(Math.round(p.x*ratio),Math.round(p.y*ratio)).setScale(o.scaleX*artScale,o.scaleY*artScale).setDepth(-p.z*100000+o.depth*.001);
  }
  const ctx=this.depthCanvas.getContext('2d')!;ctx.fillStyle='#ffffff';ctx.fillRect(0,0,this.depthCanvas.width,this.depthCanvas.height);
  // ponytail: one packed depth rectangle per Phaser root. Split a large VFX root if its depth variation becomes visible.
  for(const s of [...this.saved].sort((a,b)=>b.z-a.z)){const b=s.o.getBounds(),packed=Math.round(s.z*16777215);ctx.fillStyle=`rgb(${packed>>>16},${packed>>>8&255},${packed&255})`;ctx.fillRect(Math.floor(b.x-source.scrollX),Math.floor(b.y-source.scrollY),Math.ceil(b.width)+1,Math.ceil(b.height)+1);}
 };
 private resizeSource(width:number,height:number){const canvas=this.world.game.canvas;if(canvas.width===width&&canvas.height===height)return;canvas.width=width;canvas.height=height;this.world.game.renderer.resize(width,height);}
 private restore(){
  for(const s of this.saved){if(s.o.scene)s.o.setPosition(s.x,s.y).setScale(s.sx,s.sy).setDepth(s.depth);}this.saved=[];
  if(this.rasterCamera){const c=this.world.cameras.main,s=this.rasterCamera;c.setViewport(s.x,s.y,s.width,s.height).setZoom(s.zoomX,s.zoomY).setScroll(s.scrollX,s.scrollY);c.roundPixels=s.roundPixels;c.useBounds=s.useBounds;c.preRender();this.rasterCamera=undefined;}
 }
 private draw=()=>{
  if(this.disposed||!this.saved.length){this.restore();return;}
  try{this.texture.needsUpdate=true;this.depthTexture.needsUpdate=true;if(this.quality)this.sunlight.render(this.renderer,this.scene,this.camera,this.sun);else this.renderer.render(this.scene,this.camera);this.renderer.autoClear=false;this.renderer.render(this.paperScene,this.paperCamera);this.renderer.autoClear=true;}finally{this.restore();}
 };
 private forward(e:PointerEvent,type:string){const b=this.renderer.domElement.getBoundingClientRect(),c=this.world.game.canvas,s=c.getBoundingClientRect();c.dispatchEvent(new MouseEvent(type,{clientX:s.left+(e.clientX-b.left)/b.width*s.width,clientY:s.top+(e.clientY-b.top)/b.height*s.height,button:0,buttons:e.buttons&1,bubbles:true,cancelable:true,view:window}));}
 private down=(e:PointerEvent)=>{e.preventDefault();this.renderer.domElement.setPointerCapture(e.pointerId);if(e.button===2)this.drag={id:e.pointerId,x:e.clientX,y:e.clientY};else if(e.button===0)this.forward(e,'mousedown');};
 private move=(e:PointerEvent)=>{if(this.drag?.id===e.pointerId){this.yaw=T.MathUtils.clamp(this.yaw-(e.clientX-this.drag.x)*.004,-.45,.45);this.pitch=T.MathUtils.clamp(this.pitch+(e.clientY-this.drag.y)*.003,.08,.46);this.drag={id:e.pointerId,x:e.clientX,y:e.clientY};}else this.forward(e,'mousemove');};
 private up=(e:PointerEvent)=>{if(this.drag?.id===e.pointerId)this.drag=undefined;else if(e.button===0)this.forward(e,'mouseup');};
 private context=(e:Event)=>e.preventDefault();
 private wheel=(e:WheelEvent)=>{e.preventDefault();this.zoom=T.MathUtils.clamp(this.zoom*Math.exp(T.MathUtils.clamp(e.deltaY,-100,100)*.002),.9,1.7);};
 private static disposeModel(root:T.Object3D){const textures=new Set<T.Texture>(),materials=new Set<T.Material>(),geometries=new Set<T.BufferGeometry>();root.traverse(o=>{if(!(o instanceof T.Mesh))return;geometries.add(o.geometry);for(const m of Array.isArray(o.material)?o.material:[o.material]){materials.add(m);for(const v of Object.values(m))if(v instanceof T.Texture)textures.add(v);}});textures.forEach(t=>t.dispose());materials.forEach(m=>m.dispose());geometries.forEach(g=>g.dispose());}
 destroy(){if(this.disposed)return;this.disposed=true;this.restore();this.world.game.events.off('prerender',this.prepare);this.world.game.events.off('postrender',this.draw);this.root.parentElement?.classList.remove('show-henesys');this.root.remove();this.resizeSource(this.world.game.scale.width,this.world.game.scale.height);HenesysView.disposeModel(this.scene);HenesysView.disposeModel(this.paperScene);for(const material of this.faded.values())for(const m of Array.isArray(material)?material:[material])m.dispose();this.faded.clear();this.sourceMaterials.forEach(m=>m.dispose());this.depthTexture.dispose();this.sunlight.destroy();this.sun.shadow.dispose();this.environment.dispose();this.renderer.dispose();this.renderer.forceContextLoss();}
}
