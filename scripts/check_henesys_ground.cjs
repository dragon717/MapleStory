// Actual production World/render hooks on native WebGL; simulated snapshots, no account writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
(async()=>{
 const browser=await chromium.launch({headless:false,executablePath:path.join(os.homedir(),'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),args:['--use-angle=metal']});
 const out=path.resolve(__dirname,'../artifacts/henesys/ground');fs.mkdirSync(out,{recursive:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/THREE|shader|WebGL/i.test(m.text()))errors.push(m.text());});
  await page.goto('http://127.0.0.1:5187/henesys-preview.html');await page.bringToFront();
  await page.waitForFunction(()=>window.henesysPreview?.world.henesys&&window.henesysPreview.world.players.size,null,{timeout:90000});
  await page.evaluate(()=>{const p=window.henesysPreview;clearInterval(p.timer);p.world.setEnvironment({hour:10,season:'summer',weather:'clear',moisture:0});p.snapshot.players[0].townLamp={tier:1,issued:true,revision:1};});
  const move=async(snow)=>{
   await page.evaluate(async(snow)=>{
    const p=window.henesysPreview,w=p.world,v=w.henesys,{segmentAt}=await import('/src/features/henesys/coordinates.ts');
    w.setEnvironment({hour:10,season:snow?'winter':'summer',weather:'clear',moisture:0});
    if(snow)v.setSnowCover({amount:1,depth:.18,fall:0});
    const self=p.snapshot.players[0];self.x=101550;const road=segmentAt(self.x),height=x=>road.a.y+(road.b.y-road.a.y)*(x-road.a.x)/(road.b.x-road.a.x);self.y=height(self.x);self.action='walk';w.selfMotion.snap(self.id);
    p.snapshot.npcs=[{id:'snow-walker',templateId:'3003614',name:'Walking guard',nameZh:'踩雪守卫',x:self.x+100,y:height(self.x+100),facing:1,townLamp:{tier:1,kind:'lantern'}}];
    let last=performance.now(),start=last;
    await new Promise(resolve=>{function step(){const now=performance.now(),dt=Math.min(now-last,80);last=now;self.x+=dt*.18;self.y=height(self.x);const npc=p.snapshot.npcs[0];npc.x=self.x+100;npc.y=height(npc.x);p.snapshot.serverTick++;w.receive({...p.snapshot,players:[{...self}],npcs:[{...npc}]});if(now-start<2400)requestAnimationFrame(step);else resolve();}requestAnimationFrame(step);});
   },snow);
   await page.waitForTimeout(120);
   return page.evaluate(()=>{const w=window.henesysPreview.world,v=w.henesys,g=v.groundFeedback,s=v.snow;return {focus:document.hasFocus(),hidden:document.hidden,births:g.cursor,visible:g.points.visible,tiles:s.tiles.filter(t=>t.assigned).length,pressed:s.tiles.reduce((n,t)=>n+Array.from(t.press.array).filter((p,i)=>i%2===0&&p>0).length,0),cover:v.snowCover,actors:g.tracks.filter(t=>t.id&&t.eligible).map(t=>t.id)};});
  };
  const dust=await move(false);assert(dust.births>0&&dust.visible);await page.screenshot({path:path.join(out,'dust.png')});
  const snow=await move(true);assert(snow.tiles>0&&snow.pressed>0&&snow.actors.includes('npc:snow-walker'));await page.screenshot({path:path.join(out,'snow-footprints.png')});
  const teleport=await page.evaluate(async()=>{const p=window.henesysPreview,w=p.world,v=w.henesys;let suppressed=false;const update=v.groundFeedback.update.bind(v.groundFeedback);v.groundFeedback.update=(actors,...args)=>{suppressed ||= actors.some(a=>a.id===p.snapshot.selfId&&a.teleported);return update(actors,...args);};w.groundTeleports.add(p.snapshot.selfId);p.snapshot.players[0].x+=15;w.selfMotion.snap(p.snapshot.selfId);p.snapshot.serverTick++;w.receive({...p.snapshot});await new Promise(r=>setTimeout(r,150));v.groundFeedback.update=update;return suppressed;});assert(teleport,'small explicit teleport reaches render suppression');
  await page.evaluate(()=>window.henesysPreview.world.setEnvironment({hour:23,season:'winter',weather:'clear'}));await page.waitForTimeout(300);
  const lit=await page.evaluate(()=>{const p=window.henesysPreview,v=p.world.henesys;return {samples:v.townLamps.lightSamples,daylight:v.climate.light.daylight,restored:p.world.players.get(p.snapshot.selfId).body.list.filter(o=>o.type==='Image').every(o=>o.tintTopLeft===0xffffff)};});assert(lit.samples.some(s=>s.id==='preview')&&lit.samples.some(s=>s.id==='npc:snow-walker')&&lit.daylight===0&&lit.restored);await page.screenshot({path:path.join(out,'night-lamps.png')});
  await page.evaluate(()=>{const p=window.henesysPreview;p.snapshot.players[0].townLamp={tier:0,issued:true,revision:2};p.snapshot.serverTick++;p.world.receive({...p.snapshot});});await page.waitForTimeout(250);
  assert(await page.evaluate(()=>!window.henesysPreview.world.henesys.townLamps.lightSamples.some(s=>s.id==='preview')));await page.screenshot({path:path.join(out,'night-discarded.png')});
  await page.evaluate(async()=>{const {TownLampPanel}=await import('/src/features/henesys/town-lamp-view.ts'),p=window.henesysPreview,{segmentAt}=await import('/src/features/henesys/coordinates.ts');const source=await(await fetch('/src/features/henesys/town-lamp-view.ts')).text(),rules=(await import(/import rules from\s*['"]([^'"]+)['"]/.exec(source)[1])).default;const x=p.snapshot.players[0].x;window.testLampRequests=[];window.testLampPanel=new TownLampPanel(document.querySelector('#windows'),p.manifest,()=>{},m=>{window.testLampRequests.push(m);return true;});const guardX=101710.80331535098+rules.guard.spawnOffsetPixels,{a,b}=segmentAt(guardX),y=a.y+(b.y-a.y)*(guardX-a.x)/(b.x-a.x);window.testLampPanel.update({...p.snapshot.players[0],x:guardX,y,level:10,mesos:2000,townLamp:{tier:1,issued:true,revision:1}},'100000000');window.testLampPanel.open();});
  await page.getByRole('button',{name:'升级 500 枫币',exact:true}).click();assert.equal(await page.evaluate(()=>window.testLampRequests[0].action),'upgrade');assert.equal(await page.evaluate(()=>window.testLampRequests[0].expectedCost),500);await page.evaluate(()=>window.testLampPanel.reject(window.testLampRequests[0].requestId,'insufficient_mesos'));
  const layouts=[];for(const viewport of [{width:390,height:844},{width:844,height:390},{width:1440,height:900}]){await page.setViewportSize(viewport);await page.waitForTimeout(100);layouts.push(await page.evaluate(()=>{const r=document.querySelector('.town-lamp-panel').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1;}));}assert(layouts.every(Boolean),'lamp window stays reachable in portrait/landscape');await page.screenshot({path:path.join(out,'lamp-panel.png')});await page.getByRole('button',{name:'关闭灯具窗口',exact:true}).click();assert(await page.evaluate(()=>!window.testLampPanel.isOpen()));await page.evaluate(()=>window.testLampPanel.destroy());
  const cover=await page.evaluate(()=>window.henesysPreview.world.henesys.snowCover.amount);
  await page.evaluate(()=>window.henesysPreview.world.setThreeEnabled(false));await page.waitForFunction(()=>!window.henesysPreview.world.henesys&&window.henesysPreview.world.isLoaded);await page.evaluate(()=>window.henesysPreview.world.setThreeEnabled(true));await page.waitForFunction(()=>window.henesysPreview.world.henesys&&window.henesysPreview.world.isLoaded);assert(Math.abs(await page.evaluate(()=>window.henesysPreview.world.henesys.snowCover.amount)-cover)<.001);
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'check.json'),JSON.stringify({dust,snow,teleport,lit,cover,errors},null,2)+'\n','utf8');console.log('PASS: native dust/snow shaders, player/NPC footprints, explicit teleport suppression, lamp presence/discard and tint restore, snow lifecycle. '+JSON.stringify({dust,snow,lights:lit.samples.length}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
