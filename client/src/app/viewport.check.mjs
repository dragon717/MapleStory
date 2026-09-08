// Offline: actual app, Phaser and local 273 art; connection and entry are in-memory.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/Users/muniao/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(import.meta.dirname, '../..');
const output = path.join(root, '../output/playwright/viewport');
await fs.mkdir(output, { recursive: true });
const source = await fs.readFile(path.join(root, 'src/app/main.ts'), 'utf8');
await build({ stdin: { contents: source + '\nObject.assign(window, {check: { enterGame, leaveGame, status, showNews, getGame:()=>game, getWorld:()=>world, getHud:()=>hud }});', resolveDir: path.join(root,'src/app'), loader:'ts' }, bundle:true, format:'esm', outfile:path.join(output,'check.js'), define:{__RELEASE_VERSION__:'"offline-check"',__RELEASE_TIME__:'"2026-09-08"'}, logLevel:'silent', plugins:[{name:'offline-boundaries',setup(b){
  b.onResolve({filter:/network\/session$/},()=>({path:'session',namespace:'offline'}));
  b.onResolve({filter:/features\/entry\/view$/},()=>({path:'entry',namespace:'offline'}));
  b.onLoad({filter:/.*/,namespace:'offline'},({path:p})=>({loader:'js',contents:p==='entry' ? 'export class EntryView {showLogin(){} returnTo(){}}' : 'export class Connection { constructor(session,message,state){this.message=message;this.state=state;window.connection=this;window.sent=[];} connect(){this.state("online");} close(){} send(message){window.sent.push(message);return true;} }'}));
}}] });
const manifest = JSON.parse(await fs.readFile(path.join(root,'public-tms273/assets/manifest.json'),'utf8'));
// One real map and default avatar suffice for the viewport; skip unrelated preload catalogs.
manifest.mapCatalog.maps=manifest.mapCatalog.maps.filter(map=>map.id==='001020000');
manifest.avatar.equipmentLoadouts={};
for(const key of ['monsters','npcs','portals','skillEffects','skillSounds','levelUp']) delete manifest[key];
delete manifest.map.bgm;
delete manifest.avatar.attackSound;
const cache = path.join(os.homedir(),'Library/Caches/ms-playwright');
const installed=(await fs.readdir(cache)).filter(n=>n.startsWith('chromium_headless_shell-')).sort((a,b)=>Number(b.split('-').at(-1))-Number(a.split('-').at(-1)))[0];
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || path.join(cache,installed,'chrome-headless-shell-mac-arm64/chrome-headless-shell')});
const page=await browser.newPage({viewport:{width:1440,height:900}});
const errors=[];page.on('pageerror',e=>errors.push(String(e)));
await page.route('**/*',async route=>{
 const url=new URL(route.request().url());
 assert.equal(url.hostname,'viewport.test','No live network');
 if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/check.css"><div id="app"></div><script type="module" src="/check.js"></script>'});
 if(url.pathname==='/assets/manifest.json')return route.fulfill({json:manifest});
 if(url.pathname==='/assets/entry/appearance.json')return route.fulfill({json:{base:{},layers:{}}});
 const file=url.pathname.startsWith('/assets/')?path.join(root,'public-tms273',decodeURIComponent(url.pathname)):path.join(output,path.basename(url.pathname));
 try{return route.fulfill({body:await fs.readFile(file),contentType:({'.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.mp3':'audio/mpeg'})[path.extname(file)]||'application/octet-stream'});}catch{return route.fulfill({status:404,body:'missing test resource'});}
});
try{
 await page.goto('http://viewport.test/');
 await page.waitForFunction(()=>window.check);
 await page.evaluate(()=>window.check.enterGame({username:'离线冒险者',token:'offline',playerId:'offline'}));
 await page.waitForFunction(()=>window.check.getWorld()?.loaded,{},{timeout:60000});
 await page.evaluate(()=>{
  const w=window.check.getWorld(), b=w.manifest.map.bounds;
  window.player={id:'offline',username:'离线冒险者',x:(b.xMin+b.xMax)/2,y:(b.yMin+b.yMax)/2,vx:0,vy:0,facing:1,grounded:true,action:'stand',actionId:null,actionStartedTick:0,lastInputSeq:0,climbing:false,ladderId:null,hp:50,maxHp:100,mp:40,maxMp:80,level:10,exp:25,expToNext:100,mesos:100,inventory:[],equipped:[]};
  window.connection.message({type:'snapshot',mapId:w.mapId,selfId:'offline',players:[window.player],monsters:[],npcs:[],drops:[],serverTick:0,tickMs:50});
 });
 const evidence=[];
 await page.evaluate(()=>window.connection.message({type:'questList',quests:[{questId:'36301',name:'教程：希娜的请求',status:'active',summary:'帮助希娜寻找发夹。',objectives:[{text:'发夹',current:0,required:1}],nextAction:'点击落叶堆寻找发夹，然后向希娜交付。'}]}));
 assert(await page.locator('.quest-tracker').isVisible());
 for(const [width,height] of [[1440,900],[844,390],[390,844],[320,568],[1920,1080],[844,390]]){
  await page.setViewportSize({width,height});
  await page.waitForFunction(({width,height})=>window.check.getGame().scale.width===width&&window.check.getGame().scale.height===height,{width,height});
  await page.waitForFunction(()=>document.querySelector('#game-shell').style.getPropertyValue('--hud-height')===`${document.querySelector('#hud').getBoundingClientRect().height}px`);
  const state=await page.evaluate(()=>{
   const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
   return {game:rect('#game'),canvas:rect('#game canvas'),hud:rect('#hud'),chat:rect('#chat'),scroll:document.documentElement.scrollWidth,width:innerWidth,height:innerHeight,camera:{width:window.check.getWorld().cameras.main.width,height:window.check.getWorld().cameras.main.height},buttons:[...document.querySelectorAll('.tms-hud-actions button')].map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom};})};
  });
  assert.deepEqual([state.game.x,state.game.y,state.game.width,state.game.height],[0,0,width,height]);
  assert.deepEqual([state.canvas.width,state.canvas.height],[width,height]);
  assert.deepEqual([state.camera.width,state.camera.height],[width,height]);
  assert(state.scroll<=width);assert(state.chat.bottom<=state.hud.y);
  const nameBottom=await page.evaluate(()=>{const w=window.check.getWorld();return window.player.y-w.cameras.main.scrollY+30;});
  assert(nameBottom < state.hud.y, `player name overlaps HUD at ${width}x${height}`);
  assert(state.buttons.every(r=>r.x>=0&&r.y>=0&&r.right<=width&&r.bottom<=height));
  await page.locator('.quest-tracker').click();
  const questBounds=await page.locator('.quest-log').boundingBox();
  assert(questBounds.x>=0&&questBounds.y>=0&&questBounds.x+questBounds.width<=width&&questBounds.y+questBounds.height<=height, `quest bounds at ${width}x${height}`);
  assert(questBounds.y+questBounds.height<=state.hud.y, 'quest log covers life HUD');
  assert(!(await page.locator('.quest-tracker').isVisible()), 'tracker overlays open log');
  assert(await page.locator('.quest-log-body').evaluate(e=>e.scrollWidth<=e.clientWidth));
  assert((await page.locator('.quest-log-body').innerText()).includes('0 / 1'));
  await page.screenshot({path:path.join(output,`quest-${width}x${height}.png`)});
  await page.locator('.quest-log-close').click();
  await page.locator('.tms-hud-actions button[aria-label="菜单"]').click();
  await page.locator('[data-menu-item="menu/buttonInfo/6/1"]').click();
  assert(await page.locator('#maple-news').evaluate(e=>e.open));
  assert.equal(await page.locator('#maple-news #map-name').count(),1);
  assert.equal(await page.locator('#maple-news #connection').count(),1);
  assert.equal(await page.locator('#maple-news #language').count(),1);
  assert.equal(await page.locator('#maple-news .release-badge').count(),1);
  const bounds=await page.locator('#maple-news').boundingBox();
  assert(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=width&&bounds.y+bounds.height<=height);
  assert(await page.locator('#maple-news').evaluate(e=>e.scrollWidth<=e.clientWidth));
  await page.locator('#maple-news summary').focus();
  await page.evaluate(()=>window.sent=[]);await page.keyboard.press('ArrowRight');await page.keyboard.press('Space');
  assert(!(await page.evaluate(()=>window.sent)).some(m=>m.type==='attack'||m.type==='castSkill'||m.direction===1||m.jump));
  await page.screenshot({path:path.join(output,`news-${width}x${height}.png`)});
  await page.keyboard.press('Escape');assert(!(await page.locator('#maple-news').evaluate(e=>e.open)));
  await page.locator('#game-alert').evaluate(e=>e.hidden=true);
  await page.screenshot({path:path.join(output,`game-${width}x${height}.png`)});
  evidence.push(state);
 }
 // Use the actual source leaf rectangle; server fixture supplies intent metadata only.
 await page.evaluate(()=>{
  const w=window.check.getWorld(),leaf=w.manifest.map.layers.find(l=>l.key==='obj-5-0');
  if(!leaf)throw Error('missing actual leaf pile');
  window.player.x=leaf.mapObject.x;window.player.y=leaf.mapObject.y;
  window.connection.message({type:'snapshot',mapId:w.mapId,selfId:'offline',players:[window.player],monsters:[],npcs:[],drops:[],serverTick:1,tickMs:50,questInteractions:[{questId:'36301',mapId:w.mapId,x:leaf.mapObject.x,y:leaf.mapObject.y,range:120,label:'落叶堆',mapLayerKey:leaf.key}]});
 });
 await page.waitForFunction(()=>window.check.getWorld().questTargets.size===1);
 const leafPoint=await page.evaluate(()=>{const w=window.check.getWorld(),l=w.manifest.map.layers.find(l=>l.key==='obj-5-0');return {x:l.x+l.width/2-w.cameras.main.scrollX,y:l.y+l.height/2-w.cameras.main.scrollY};});
 await page.evaluate(()=>window.sent=[]);await page.mouse.click(leafPoint.x,leafPoint.y);
 await page.waitForFunction(()=>window.sent.some(m=>m.type==='questInteract'&&m.questId==='36301'));
 assert.equal((await page.evaluate(()=>window.sent.filter(m=>m.type==='questInteract'))).length,1);
 await page.evaluate(()=>{
  window.connection.message({type:'questUpdate',questId:'36301',name:'教程：希娜的请求',status:'objectivesComplete',summary:'找到发夹。',objectives:[{text:'发夹',current:1,required:1}],nextAction:'返回希娜交付。',reward:{mesos:0,exp:0,items:[]}});
  const w=window.check.getWorld();window.connection.message({type:'snapshot',mapId:w.mapId,selfId:'offline',players:[window.player],monsters:[],npcs:[],drops:[],serverTick:2,tickMs:50});
 });
 await page.waitForFunction(()=>window.check.getWorld().questTargets.size===0);
 assert((await page.locator('.quest-tracker').innerText()).includes('可交付'));
 // Reproduce the reported crossroads view at tall desktop sizes, then resize back.
 await page.evaluate(()=>window.check.getWorld().switchMap('001020000'));
 await page.waitForFunction(()=>window.check.getWorld().loaded);
 for (const [width,height] of [[1800,1083],[2560,1440],[3600,2166],[390,844],[844,390],[1800,1083]]) {
  await page.setViewportSize({width,height});
  await page.waitForFunction(({width,height})=>window.check.getGame().scale.width===width&&window.check.getGame().scale.height===height,{width,height});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const colors=await page.evaluate(async()=>{
   const renderer=window.check.getGame().renderer;
   const sample=(x,y)=>new Promise(resolve=>renderer.snapshotPixel(x,y,c=>resolve([c.r,c.g,c.b])));
   return [await sample(5,2),await sample(innerWidth-5,Math.round(innerHeight/4)),await sample(innerWidth-5,innerHeight-30)];
  });
  for(const color of colors) assert.notDeepEqual(color,[180,223,224],`background exposed at ${width}x${height}: ${JSON.stringify(colors)}`);
  await page.screenshot({path:path.join(output,`background-${width}x${height}.png`)});
 }
 await page.evaluate(()=>{window.oldBackgrounds=window.check.getWorld().backgrounds.flatMap(v=>v.images);});
 await page.evaluate(()=>{for(let i=0;i<35;i++)window.check.status(`消息${i}`);window.check.status('消息34');});
 assert.equal(await page.locator('#news-log li').count(),30);
 await page.evaluate(()=>window.connection.state('offline','连接已断开，请重新连接。'));
 assert(!(await page.locator('.quest-tracker').isVisible()));
 assert(await page.evaluate(()=>window.oldBackgrounds.every(image=>!image.scene)), 'background sprites must be destroyed on clear');
 assert(await page.locator('#game-alert').isVisible());await page.locator('#game-alert').click();
 await page.locator('#reconnect').click();assert(await page.locator('#connection').evaluate(e=>e.classList.contains('online')));
 await page.locator('#news-close').click();
 await page.evaluate(()=>window.check.leaveGame());
 assert.equal(await page.locator('body.game-mode').count(),0);
 assert.equal(await page.locator('#app>header #connection').count(),1);
 assert.equal(await page.locator('#app>footer').count(),1);
 assert(!(await page.locator('#maple-news').evaluate(e=>e.open)));
 assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(output,'results.json'),JSON.stringify(evidence,null,2)+'\n','utf8');
 console.log('Chapter/viewport/news: leaf click intent, progress/cleanup, quest window, real Phaser resize, 5 sizes, HUD/chat bounds, menu routing, modal input, bounded log, reconnect and leave passed.');
}finally{await browser.close();}
