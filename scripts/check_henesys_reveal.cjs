// Targeted native-GPU check of the production reveal/paper shaders; no backend or account writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
(async()=>{
 const browser=await chromium.launch({headless:false,executablePath:process.env.PLAYWRIGHT_EXECUTABLE||path.join(os.homedir(),'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),args:['--use-angle=metal']});
 try{
  const page=await browser.newPage({viewport:{width:1000,height:700},deviceScaleFactor:2}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/THREE|shader|WebGL/i.test(m.text()))errors.push(m.text());});
  await page.goto((process.env.HENESYS_URL||'http://127.0.0.1:5187')+'/henesys-preview.html');
  await page.waitForFunction(()=>window.henesysPreview?.world.henesys?.sun.shadow.map&&window.henesysPreview.world.players.size,null,{timeout:60000});
  const result=await page.evaluate(async()=>{
   const p=window.henesysPreview,v=p.world.henesys;clearInterval(p.timer);
   const source=await (await fetch('/src/features/henesys/local-reveal.ts')).text();
   const threeUrl=/from\s*["']([^"']*three[^"']*)["']/.exec(source)[1];
   const T=await import(threeUrl),{LocalReveal}=await import('/src/features/henesys/local-reveal.ts');
   const camera=new T.PerspectiveCamera(38,1.4,.1,700);camera.position.set(0,6,14);camera.lookAt(0,1,0);camera.updateMatrixWorld();
   const scene=new T.Scene(),model=new T.Group();scene.add(model);
   const shared=new T.MeshBasicMaterial({color:0xff0000}),front=new T.Mesh(new T.BoxGeometry(40,40,1),shared);front.userData.layer='buildings';front.position.z=5;model.add(front);
   const rear=new T.Mesh(new T.BoxGeometry(40,40,1),new T.MeshBasicMaterial({color:0x0000ff}));rear.userData.layer='buildings';rear.position.z=-5;model.add(rear);
   const reveal=new LocalReveal(model),foot=new T.Vector3();
   for(let i=0;i<50;i++)reveal.update(foot,camera,1000,700,1,16,i*16);
   const target=new T.WebGLRenderTarget(1000,700),data=new Uint8Array(1000*700*4),depth=new Uint8Array(4),shader=v.paper.material.clone();
   const bodyPoint=foot.clone().add(new T.Vector3(0,1.1,0)).project(camera);
   const aperture=reveal.window.value,cx=Math.round((bodyPoint.x+1)*500),cy=Math.round((bodyPoint.y+1)*350),packed=Math.round(((foot.clone().project(camera).z+1)/2)*16777215);
   for(let y=cy-20;y<=cy+20;y++)for(let x=cx-10;x<=cx+10;x++){const i=(y*1000+x)*4;data[i+1]=255;data[i+3]=255;}
   depth.set([(packed>>>16)&255,(packed>>>8)&255,packed&255,255]);
   const image=new T.DataTexture(data,1000,700),actorDepth=new T.DataTexture(depth,1,1);image.needsUpdate=actorDepth.needsUpdate=true;
   shader.uniforms.image.value=image;shader.uniforms.actorDepth.value=actorDepth;
   const paperScene=new T.Scene(),quad=new T.Mesh(new T.PlaneGeometry(2,2),shader),paperCamera=new T.OrthographicCamera(-1,1,1,-1,0,1);paperScene.add(quad);
   const pixels=new Uint8Array(1000*700*4),r=v.renderer;
   const render=()=>{r.resetState();r.setRenderTarget(target);r.setClearColor(0,1);r.autoClear=true;r.render(scene,camera);r.autoClear=false;r.render(paperScene,paperCamera);r.autoClear=true;r.readRenderTargetPixels(target,0,0,1000,700,pixels);return pixels.slice();};
   reveal.strength.value=0;const before=render();reveal.strength.value=1;const after=render();
   const pixel=(b,x,y)=>Array.from(b.slice((y*1000+x)*4,(y*1000+x)*4+3));
   let outsideChanged=0,featherRed=0,featherBlue=0,rearVisible=0;
   for(let y=0;y<700;y++)for(let x=0;x<1000;x++){
    const radius=Math.hypot((x-aperture.x)/aperture.z,(y-aperture.y)/aperture.w),i=(y*1000+x)*4;
    if(radius>1.01&&(before[i]!==after[i]||before[i+1]!==after[i+1]||before[i+2]!==after[i+2]))outsideChanged++;
    if(radius>.75&&radius<.85){if(after[i]>200)featherRed++;if(after[i+2]>200)featherBlue++;}
    if(radius<.5&&after[i+2]>200)rearVisible++;
   }
   const debug=r.getContext().getExtension('WEBGL_debug_renderer_info');
   const output={renderer:r.getContext().getParameter(debug.UNMASKED_RENDERER_WEBGL),before:pixel(before,cx,cy),after:pixel(after,cx,cy),outsideChanged,featherRed,featherBlue,rearVisible,patched:v.reveal.candidates.length,clippedInstances:v.reveal.candidates.filter(o=>o.mesh.isInstancedMesh).length};
   target.dispose();quad.geometry.dispose();shader.dispose();image.dispose();actorDepth.dispose();reveal.destroy();
   for(const o of [front,rear]){o.geometry.dispose();o.material.dispose();}shared.dispose();
   r.setRenderTarget(null);r.resetState();p.game.renderer.pipelines.rebind();return output;
  });
  assert(result.before[0]>200&&result.before[1]<20,'wall initially hides the paper actor');
  assert(result.after[1]>200&&result.after[0]<20,'same production paper/depth shader becomes visible through the local opening');
  assert.equal(result.outsideChanged,0,'outside the window the building must not disappear');
  assert(result.featherRed>100&&result.featherBlue>100,'feather blends pixel coverage rather than a hard circular cut');
  assert(result.rearVisible>100,'rear geometry remains visible and opaque');
  assert(result.patched>50&&result.clippedInstances>0,'production buildings/props/instanced trees are registered');
  const realOcclusion=await page.evaluate(async()=>{
   const p=window.henesysPreview,w=p.world,v=w.henesys;
   const source=await (await fetch('/src/features/henesys/local-reveal.ts')).text(),T=await import(/from\s*["']([^"']*three[^"']*)["']/.exec(source)[1]);
   const {point3d}=await import('/src/features/henesys/coordinates.ts'),coordinateSource=await (await fetch('/src/features/henesys/coordinates.ts')).text();
   const east=(await import(/import east from\s*["']([^"']+)["']/.exec(coordinateSource)[1])).default;
   const current=new T.Vector3(...point3d(w.renderedSelf.x,w.renderedSelf.y)),offset=v.camera.position.clone().sub(current),probe=v.camera.clone(),ray=new T.Raycaster();
   const buildings=v.reveal.candidates.filter(o=>{let n=o.mesh;while(n){if(n.userData.layer)return n.userData.layer==='buildings';n=n.parent;}return false;});let chosen;
   for(const road of east.routes){for(let i=1;i<road.nodes.length&&!chosen;i++)for(const f of [0,.25,.5,.75,1]){
    const a=road.nodes[i-1],b=road.nodes[i],x=a.x+(b.x-a.x)*f,y=a.y+(b.y-a.y)*f,foot=new T.Vector3(...point3d(x,y)),head=foot.clone().add(new T.Vector3(0,1.1,0));
    probe.position.copy(foot).add(offset);probe.updateMatrixWorld();ray.set(probe.position,head.clone().sub(probe.position).normalize());ray.far=probe.position.distanceTo(head)-.05;
    const nearby=buildings.filter(o=>o.bounds.distanceToPoint(foot)<10).map(o=>o.mesh);
    if(ray.intersectObjects(nearby,false).length){chosen={x,y,road:road.name};break;}
   }if(chosen)break;}
   if(!chosen)throw new Error('No actual road behind a building found');
   const self={...w.snapshot.players[0],x:chosen.x,y:chosen.y};w.selfMotion.snap(self.id);w.receive({...w.snapshot,serverTick:w.snapshot.serverTick+1,players:[self]});
   return chosen;
  });
  await page.waitForFunction(()=>window.henesysPreview.world.henesys.reveal.strength.value===1);
  const out=path.resolve(__dirname,'../artifacts/henesys/east-village/local-reveal');fs.mkdirSync(out,{recursive:true});
  await page.evaluate(()=>{const v=window.henesysPreview.world.henesys;v.reveal.__update=v.reveal.update;v.reveal.update=()=>{};v.reveal.strength.value=0;});
  await page.waitForTimeout(100);await page.screenshot({path:path.join(out,'building-before.png')});
  await page.evaluate(()=>{const v=window.henesysPreview.world.henesys;v.reveal.update=v.reveal.__update;delete v.reveal.__update;});
  await page.waitForFunction(()=>window.henesysPreview.world.henesys.reveal.strength.value===1);
  await page.screenshot({path:path.join(out,'building-after.png')});
  await page.evaluate(()=>{const v=window.henesysPreview.world.henesys;v.quality=false;});
  await page.waitForTimeout(150);await page.evaluate(()=>window.henesysPreview.world.henesys.quality=true);await page.waitForTimeout(150);
  await page.screenshot({path:path.join(out,'scene.png')});
  const lifecycle=await page.evaluate(async()=>{const p=window.henesysPreview,old=p.world.henesys.reveal;p.world.setThreeEnabled(false);const frame=()=>new Promise(resolve=>p.game.events.once('postrender',resolve));await frame();const cleared=old.candidates.length===0;p.world.setThreeEnabled(true);for(let i=0;i<600&&!p.world.henesys;i++)await frame();for(let i=0;i<3;i++)await frame();return {cleared,reentered:!!p.world.henesys?.reveal,contextHealthy:!p.game.renderer.gl.isContextLost()};});
  assert.deepEqual(lifecycle,{cleared:true,reentered:true,contextHealthy:true});assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'check.json'),JSON.stringify({result,realOcclusion,lifecycle,errors},null,2)+'\n','utf8');
  console.log('PASS: native GPU local opening, real paper/depth composition, untouched surroundings/rear surfaces, feather coverage, both quality modes and 3D→2D→3D lifecycle. '+JSON.stringify(result));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
