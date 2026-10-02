// One native-GPU check through production World, controls and shaders; no server/account writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
(async()=>{
 const browser=await chromium.launch({headless:false,executablePath:process.env.PLAYWRIGHT_EXECUTABLE||path.join(os.homedir(),'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),args:['--use-angle=metal']});
 const out=path.resolve(__dirname,'../artifacts/henesys/environment');fs.mkdirSync(out,{recursive:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/THREE|shader|WebGL/i.test(m.text())){errors.push(m.text());console.error(m.text());}});
  await page.goto((process.env.HENESYS_URL||'http://127.0.0.1:5187')+'/henesys-preview.html');
  await page.waitForFunction(()=>window.henesysPreview?.world.henesys?.sunlight.material.uniforms.shadow.value&&window.henesysPreview.world.players.size,null,{timeout:90000});
  const math=await page.evaluate(async()=>{
   const {environmentSettings,environmentLight,TIMES}=await import('/src/features/henesys/environment-settings.ts');
   const defaults=environmentSettings({hour:NaN,weather:'bad',season:'bad',moisture:Infinity,grade:-1}),east=environmentLight(environmentSettings({hour:6.4})),west=environmentLight(environmentSettings({hour:17})),night=environmentLight(environmentSettings({hour:22}));
   const p=window.henesysPreview;clearInterval(p.timer);const self={...p.snapshot.players[0],x:102431.66838016416,y:-225};p.world.selfMotion.snap(self.id);p.snapshot.players=[self];p.world.receive({...p.snapshot,serverTick:100});
   return {defaults,east,west,night,times:TIMES.map(([,hour])=>environmentLight(environmentSettings({hour})).direction)};
  });
  assert.equal(math.defaults.grade,0);assert.equal(math.defaults.weather,'clear');assert(math.times.every(d=>d.every(Number.isFinite)&&Math.abs(Math.hypot(...d)-1)<1e-8));assert(math.east.direction[0]>0&&math.west.direction[0]<0&&math.night.sunlight===0);
  await page.waitForTimeout(350);await page.screenshot({path:path.join(out,'morning.png')});
  const pixels=await page.evaluate(async()=>{
   const T=await import('/node_modules/.vite/deps/three.js'),v=window.henesysPreview.world.henesys;
   const read=t=>{const bytes=new Uint16Array(t.width*t.height*4);v.renderer.readRenderTargetPixels(t,0,0,t.width,t.height,bytes);let energy=0,minAlpha=1,max=0;for(let i=0;i<bytes.length;i++){const value=T.DataUtils.fromHalfFloat(bytes[i]);if(i%4===3)minAlpha=Math.min(minAlpha,value);else{energy+=value;max=Math.max(max,value);}}return {energy,minAlpha,max};};
   v.phaser.pipelines.clear();v.renderer.resetState();v.sunlight.render(v.renderer,v.scene,v.camera,v.sun,v.climate);
   const gi=read(v.sunlight.indirect),volume=read(v.sunlight.scattering),shadow=v.sun.shadow.matrix.toArray();
   v.sunlight.gi.uniforms.bounce.value=0;v.sunlight.material.uniforms.strength.value=0;v.sunlight.render(v.renderer,v.scene,v.camera,v.sun,v.climate);const zeroGI=read(v.sunlight.indirect),zeroVolume=read(v.sunlight.scattering);v.sunlight.gi.uniforms.bounce.value=.24;v.sunlight.material.uniforms.strength.value=1;v.renderer.resetState();v.phaser.pipelines.rebind();
   return {gi,volume,zeroGI,zeroVolume,shadow,full:[v.sunlight.target.width,v.sunlight.target.height],effects:[v.sunlight.scattering.width,v.sunlight.scattering.height],actorsSeparate:v.paper.parent===v.paperScene};
  });
  assert(pixels.gi.energy>0&&pixels.gi.minAlpha<1,'visible surfaces must contribute indirect light and occlusion');assert.equal(pixels.zeroGI.energy,0);assert(pixels.volume.energy>0&&pixels.volume.minAlpha<1);assert.equal(pixels.zeroVolume.energy,0);assert(pixels.actorsSeparate);assert.deepEqual(pixels.effects,pixels.full.map(v=>Math.ceil(v/2)));
  await page.getByRole('button',{name:'管理员之书',exact:true}).click();
  await page.getByLabel('时段',{exact:true}).selectOption('17');
  await page.waitForTimeout(250);const sunset=await page.evaluate(()=>{const v=window.henesysPreview.world.henesys;return {direction:v.climate.uniforms.solarDirection.value.toArray(),shadow:v.sun.shadow.matrix.toArray(),settings:window.henesysPreview.world.environment};});
  assert.notDeepEqual(sunset.shadow,pixels.shadow);assert(sunset.direction[0]<0);await page.evaluate(()=>window.henesysPreview.activities.close());await page.screenshot({path:path.join(out,'evening.png')});
  const weather=[];
  for(const [name,hour,season] of [['mist',9.5,'spring'],['drizzle',9.5,'summer'],['rain',14,'summer'],['snow',10,'winter'],['aurora',22,'autumn']]){
   await page.getByRole('button',{name:'管理员之书',exact:true}).click();await page.getByLabel('天气',{exact:true}).selectOption(name);await page.getByLabel('季节',{exact:true}).selectOption(season);
   await page.getByLabel('太阳时刻',{exact:true}).fill(String(hour));await page.getByLabel('太阳时刻',{exact:true}).dispatchEvent('input');await page.evaluate(()=>window.henesysPreview.activities.close());await page.waitForTimeout(400);
   weather.push(await page.evaluate(()=>{const v=window.henesysPreview.world.henesys,c=v.climate;return {settings:window.henesysPreview.world.environment,sun:v.sun.intensity,night:c.stars.material.uniforms.night.value,particles:c.precipitation.visible,amount:c.precipitation.material.uniforms.amount.value,fog:v.sunlight.material.uniforms.fogDensity.value,aurora:v.sunlight.material.uniforms.aurora.value,snow:c.uniforms.winterSnow.value};}));
   await page.screenshot({path:path.join(out,name+'.png')});
  }
  assert(weather[0].fog>math.east.fog);assert(weather[1].particles&&weather[2].amount>weather[1].amount);assert(weather[3].snow>0&&weather[3].snow<.1,'snow accumulates gradually rather than painting winter white instantly');assert(weather[4].sun===0&&weather[4].night>0&&weather[4].aurora>0);
  // Use the same sky-preview button as players. Hide only the settings window for the capture.
  await page.getByRole('button',{name:'管理员之书',exact:true}).click();await page.getByRole('button',{name:'仰望天空 / 回到村路',exact:true}).click();
  await page.evaluate(()=>document.querySelector('.admin-book-root').style.visibility='hidden');await page.waitForTimeout(200);await page.screenshot({path:path.join(out,'aurora-sky.png')});
  await page.evaluate(()=>document.querySelector('.admin-book-root').style.visibility='');
  await page.getByLabel('天气',{exact:true}).selectOption('clouds');await page.getByLabel('时段',{exact:true}).selectOption('12');await page.waitForTimeout(250);
  await page.evaluate(()=>document.querySelector('.admin-book-root').style.visibility='hidden');await page.screenshot({path:path.join(out,'sun-clouds.png')});
  await page.evaluate(()=>{document.querySelector('.admin-book-root').style.visibility='';window.henesysPreview.activities.close();});
  assert.equal(await page.evaluate(()=>window.henesysPreview.world.henesys.skyPreview),false,'closing settings restores walking camera');
  for(const viewport of [{width:390,height:844},{width:844,height:390},{width:1440,height:900}]){
   await page.setViewportSize(viewport);await page.getByRole('button',{name:'管理员之书',exact:true}).click();await page.getByLabel('天气',{exact:true}).scrollIntoViewIfNeeded();
   const layout=await page.evaluate(()=>{const root=document.querySelector('.admin-book-root'),r=root.getBoundingClientRect();return {width:innerWidth,scroll:document.documentElement.scrollWidth,left:r.left,right:r.right,controls:[...root.querySelectorAll('.environment-controls input,.environment-controls select')].map(c=>{const b=c.getBoundingClientRect();return b.left>=r.left&&b.right<=r.right+.5;})};});
   await page.screenshot({path:path.join(out,'settings-'+viewport.width+'.png')});assert(layout.scroll<=layout.width&&layout.left>=-.5&&layout.right<=layout.width+.5&&layout.controls.every(Boolean),'environment controls must fit narrow/landscape view: '+JSON.stringify(layout));await page.evaluate(()=>window.henesysPreview.activities.close());
  }
  await page.evaluate(()=>{window.henesysPreview.world.setEnvironment({hour:22,weather:'aurora',season:'autumn',moisture:.85,grade:.03});window.henesysPreview.world.setThreeEnabled(false);});
  await page.waitForFunction(()=>!window.henesysPreview.world.henesys&&window.henesysPreview.world.isLoaded);
  await page.evaluate(()=>window.henesysPreview.world.setThreeEnabled(true));await page.waitForFunction(()=>window.henesysPreview.world.henesys?.climate.settings.weather==='aurora');
  const restored=await page.evaluate(()=>({world:window.henesysPreview.world.environment,view:window.henesysPreview.world.henesys.climate.settings,saved:JSON.parse(localStorage.getItem('chuxian-environment'))}));assert.deepEqual(restored.world,restored.view);assert.deepEqual(restored.world,restored.saved);
  await page.reload();await page.waitForFunction(()=>window.henesysPreview?.world.henesys?.climate.settings.moisture===.85);
  await page.evaluate(async()=>{const {DEFAULT_ENVIRONMENT}=await import('/src/features/henesys/environment-settings.ts');window.henesysPreview.world.setEnvironment(DEFAULT_ENVIRONMENT);});
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'check.json'),JSON.stringify({math,pixels,sunset,weather,restored,errors},null,2)+'\n','utf8');console.log('PASS: sun orbit/shadows, HDR GI/AO and fog zero controls, weather/seasons, stars/aurora, original pixel-art pass, responsive settings and 2D/reload persistence. '+JSON.stringify({gi:pixels.gi,volume:pixels.volume,weather}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
