// Standalone design check: file:// only, no game server or account writes.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE}:{})});
 const page=await browser.newPage({viewport:{width:1560,height:980},deviceScaleFactor:1,acceptDownloads:true});
 const errors=[],network=[];page.on('pageerror',e=>errors.push(String(e)));page.on('request',r=>{if(/^https?:/.test(r.url()))network.push(r.url());});
 const out=path.resolve('artifacts/henesys');fs.mkdirSync(out,{recursive:true});
 try{
  await page.goto(pathToFileURL(path.resolve('docs/design/prototypes/chuxian-space.html')).href);
  await page.waitForFunction(()=>window.chuxianPrototype?.ready,null,{timeout:10000});
  const geometry=await page.evaluate(()=>{const p=window.chuxianPrototype;return {players:p.roles.filter(r=>r.type==='player').length,npcs:p.roles.filter(r=>r.type==='npc').length,zones:p.zones.length,bridges:p.bridges.length,error:Math.max(...p.zones.map(z=>{const q=p.project(...z.center,z.h),r=p.inverse(q.x,q.y,z.h);return Math.hypot(r.x-z.center[0],r.z-z.center[1]);}))};});
  assert.deepEqual({...geometry,error:0},{players:12,npcs:7,zones:5,bridges:5,error:0});assert(geometry.error<1e-7);
  await page.screenshot({path:path.join(out,'prototype-overview.png')});
  const screen=await page.locator('#scene').boundingBox();
  const start=await page.evaluate(()=>{const p=window.chuxianPrototype;return p.roleScreen(p.selected);});
  const destination=await page.evaluate(()=>{const p=window.chuxianPrototype;return p.project(-300,170,80);});
  await page.mouse.move(screen.x+start.x,screen.y+start.y-20);await page.mouse.down();await page.mouse.move(screen.x+destination.x,screen.y+destination.y,{steps:8});await page.mouse.up();
  const dragged=await page.evaluate(()=>({x:window.chuxianPrototype.selected.x,z:window.chuxianPrototype.selected.z}));
  assert(Math.hypot(dragged.x+300,dragged.z-170)<12,'drag must preserve the selected feet on the projected ground');
  await page.locator('#place-zone').selectOption('hall');
  assert.equal(await page.evaluate(()=>window.chuxianPrototype.selected.zone),'hall');
  await page.getByRole('button',{name:'＋ 放置玩家',exact:true}).click();
  const target=await page.evaluate(()=>window.chuxianPrototype.project(-400,575,-90));
  await page.mouse.click(screen.x+target.x,screen.y+target.y);
  assert.equal(await page.evaluate(()=>window.chuxianPrototype.roles.filter(r=>r.type==='player').length),13);
  await page.getByRole('button',{name:'＋ 放置 NPC',exact:true}).click();
  const npcTarget=await page.evaluate(()=>window.chuxianPrototype.project(950,545,-90));await page.mouse.click(screen.x+npcTarget.x,screen.y+npcTarget.y);
  assert.equal(await page.evaluate(()=>window.chuxianPrototype.roles.filter(r=>r.type==='npc').length),8);
  await page.getByRole('button',{name:'恢复初始布置',exact:true}).click();
  assert.equal(await page.locator('#npc-count').textContent(),'7');
  for(const view of ['stroll','plan','overview']){
   await page.locator(`[data-view="${view}"]`).click();
   assert.equal(await page.evaluate(()=>window.chuxianPrototype.view),view);
   const roundTrip=await page.evaluate(()=>{const p=window.chuxianPrototype,z=p.zones[2],q=p.project(...z.center,z.h),r=p.inverse(q.x,q.y,z.h);return Math.hypot(r.x-z.center[0],r.z-z.center[1]);});assert(roundTrip<1e-7);
   if(view!=='overview')await page.screenshot({path:path.join(out,'prototype-'+view+'.png')});
  }
  await page.locator('#angle').fill('30');assert.equal(await page.locator('#angle-value').textContent(),'30°');
  const rotated=await page.evaluate(()=>{const p=window.chuxianPrototype,z=p.zones[1],q=p.project(...z.center,z.h),r=p.inverse(q.x,q.y,z.h);return Math.hypot(r.x-z.center[0],r.z-z.center[1]);});assert(rotated<1e-7);
  await page.getByRole('button',{name:'恢复初始布置',exact:true}).click();
  await page.locator('#density').selectOption('32');assert.equal(await page.evaluate(()=>window.chuxianPrototype.roles.length),39);
  await page.locator('#density').selectOption('64');assert.equal(await page.evaluate(()=>window.chuxianPrototype.roles.length),71);
  await page.locator('#roam').check();const before=await page.evaluate(()=>window.chuxianPrototype.roles[1].x);await page.waitForFunction(x=>Math.abs(window.chuxianPrototype.roles[1].x-x)>.01,before);await page.locator('#roam').uncheck();
  await page.locator('#layers').check();await page.screenshot({path:path.join(out,'prototype-crowd.png')});
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'保存画面',exact:true}).click();assert((await download).suggestedFilename().endsWith('.png'));
  const sizes=[];
  for(const viewport of [{width:1024,height:768},{width:390,height:844}]){await page.setViewportSize(viewport);await page.waitForFunction(()=>document.querySelector('#scene').width===Math.round(document.querySelector('#scene').getBoundingClientRect().width));const result=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,canvas:document.querySelector('#scene').getBoundingClientRect().width,exportVisible:document.querySelector('#export').getBoundingClientRect().right<=innerWidth}));assert(result.scroll<=result.width);assert(result.exportVisible);sizes.push(result);if(viewport.width===390)await page.screenshot({path:path.join(out,'prototype-mobile.png'),fullPage:true});}
  assert.deepEqual(errors,[]);assert.deepEqual(network,[],'the HTML must work without network assets or a server');
  const result={geometry,dragged,density:[12,32,64],views:3,export:'PNG',sizes,errors,network};fs.writeFileSync(path.join(out,'prototype-check.json'),JSON.stringify(result,null,2)+'\n','utf8');console.log('PASS: standalone sprites, five layers/links, projection round trips, drag/drop, add player/NPC, camera views, crowd motion, PNG export and responsive widths.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
