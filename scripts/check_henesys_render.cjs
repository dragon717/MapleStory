// Same production World/render pipeline, driven by normal 20Hz snapshots; no account or database writes.
// Run client npm run dev, then node scripts/check_henesys_render.cjs.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const executable=process.env.PLAYWRIGHT_EXECUTABLE||path.join(os.homedir(),'Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:executable,args:process.env.MAPLE_RENDER_SOFTWARE==='1'?['--use-angle=swiftshader','--enable-unsafe-swiftshader']:[]});
 try{
  const page=await browser.newPage({viewport:{width:640,height:400},deviceScaleFactor:2});page.setDefaultTimeout(30000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(process.env.MAPLE_RENDER_URL||'http://127.0.0.1:5173/henesys-preview.html');
  await page.waitForFunction(()=>{const p=window.henesysPreview;if(!p?.world.henesys||!p.world.snapshot?.players.length)return false;window.__eastGame=p.game;p.world.henesys.quality=false;p.world.henesys.renderer.shadowMap.enabled=false;return true;},null,{timeout:60000,polling:1});
  await page.evaluate(()=>{
   const game=window.__eastGame,w=game.scene.keys.world,v=w.henesys;
   // Skip expensive volume work while measuring temporal alignment; pixel resolution must survive this mode.
   v.quality=false;w.__renderSamples=[];
   w.__renderProbe=()=>{const player=w.players.get(w.snapshot.selfId),saved=v.saved.find(s=>s.o===player?.body),name=player?.name;if(!saved)return;const ratio=v.renderer.getPixelRatio();w.__renderSamples.push({x:saved.x,y:saved.y,tick:w.snapshot.serverTick,serverX:w.snapshot.players[0].x,screenX:v.project(saved.x,saved.y).x,width:v.width,bufferWidth:game.canvas.width,outputWidth:v.renderer.domElement.width,labelScale:Math.abs(name.scaleX)/ratio,textResolution:name.style.resolution,sameFrame:!!w.renderedSelf&&Math.abs(w.renderedSelf.x-saved.x)<1e-8&&Math.abs(w.renderedSelf.y-saved.y)<1e-8});};
   game.events.on('prerender',w.__renderProbe);
  });
  await page.evaluate(()=>{
   const p=window.henesysPreview;clearInterval(p.timer);
   let player={...p.snapshot.players[0]},tick=p.snapshot.serverTick;
   p.timer=setInterval(()=>{
    const x=player.x+6.25,f=p.manifest.map.footholds.find(f=>f.x1<=x&&f.x2>=x);
    player={...player,x,y:f?f.y1+(f.y2-f.y1)*(x-f.x1)/(f.x2-f.x1):player.y,vx:125,action:'walk'};
    p.world.receive({...p.snapshot,serverTick:++tick,players:[player]});
   },50);
  });
  await page.waitForFunction(()=>{const s=window.__eastGame.scene.keys.world.__renderSamples;return s.length>=16&&Math.max(...s.map(p=>p.x))-Math.min(...s.map(p=>p.x))>50;},null,{timeout:90000,polling:200});
  await page.evaluate(()=>clearInterval(window.henesysPreview.timer));
  const samples=await page.evaluate(()=>{const g=window.__eastGame,w=g.scene.keys.world;g.events.off('prerender',w.__renderProbe);return w.__renderSamples;});
  const drift=Math.max(...samples.map(s=>Math.abs(s.screenX-s.width/2))),moved=Math.max(...samples.map(s=>s.x))-Math.min(...samples.map(s=>s.x));
  const renderer=await page.evaluate(()=>{const gl=window.__eastGame.scene.keys.world.henesys.renderer.getContext(),e=gl.getExtension('WEBGL_debug_renderer_info');return e?gl.getParameter(e.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);});
  const result={driver:'production World with 20Hz protocol snapshots',renderer,frames:samples.length,moved,cameraActorDriftCss:drift,sourceWidth:samples.at(-1)?.bufferWidth,outputWidth:samples.at(-1)?.outputWidth,minLabelScale:Math.min(...samples.map(s=>s.labelScale)),sameFrame:samples.every(s=>s.sameFrame),errors};
  const out=path.join(root,'artifacts/henesys/east-village/live');fs.mkdirSync(out,{recursive:true});const label='after-fix';
  fs.writeFileSync(path.join(out,label+'-render.json'),JSON.stringify({result,samples},null,2)+'\n','utf8');
  const cdp=await page.context().newCDPSession(page),shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,label+'-render.png'),Buffer.from(shot.data,'base64'));
  console.log(JSON.stringify(result));
  assert(samples.length>=6&&moved>20,'not enough movement frames');
  assert(result.sameFrame,'camera and actor must consume the same interpolated sample');
  assert(drift<1e-6,'self must remain centered while the scene scrolls');
  assert(samples.every(s=>s.bufferWidth===s.outputWidth&&s.bufferWidth===s.width*2),'DPR2 source must match final backing size');
  assert(result.minLabelScale>=1&&samples.every(s=>s.textResolution>=2),'text must not be downscaled before composition');assert.deepEqual(errors,[]);
  // A viewport change must retain logical input coordinates; leaving 3D must restore the source canvas.
  await page.setViewportSize({width:800,height:600});
  await page.waitForFunction(()=>{const w=window.__eastGame.scene.keys.world;return w?.game.canvas.width===1600&&w.cameras.main.width===800;});
  await page.locator('#activities').click();await page.getByRole('button',{name:'切换 2D 视图',exact:true}).click();
  assert.equal(await page.locator('.henesys-view').count(),0);
  assert.equal(await page.evaluate(()=>document.querySelector('#game>canvas').width),800,'2D buffer must be restored');
  console.log('henesys render: alignment, DPR2, text, resize and 2D restoration passed');
 }finally{await browser.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
