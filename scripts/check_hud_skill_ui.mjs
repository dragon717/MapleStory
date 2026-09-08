// Offline component check: real 273 assets, no account, server or gameplay mutation.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'client/package.json'));
const { build } = require('esbuild');
const { chromium } = require('/Users/muniao/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const output = path.join(root, 'output/playwright/hud-skills');
await fs.mkdir(output, {recursive:true});
await build({stdin:{contents:`
import { HudView } from './src/features/hud/view';
import { SkillView } from './src/features/skills/view';
import './src/app/style.css';
import './src/features/hud/style.css';
const manifest = await (await fetch('/assets/manifest.json')).json();
window.sent=[];
window.player={id:'offline',username:'离线冒险者',job:0,hp:50,maxHp:50,mp:5,maxMp:5,level:2,exp:4,expToNext:60,mesos:0,inventory:[],action:'stand',skills:{1000:1,1001:1,1002:1},skillPoints:{0:0}};
window.hud=new HudView(document.querySelector('#hud'),manifest,()=>{},undefined,undefined,undefined,{castSkill:id=>{window.sent.push({type:'cast',id});return 'offline-cast';},releaseSkill:id=>window.sent.push({type:'release',id})});
window.skills=new SkillView(document.querySelector('#ui-windows'),manifest,{send:message=>{window.sent.push(message);return true;},status:message=>{window.lastStatus=message;}});
window.hud.update(window.player);window.skills.update(window.player);
`,resolveDir:path.join(root,'client'),loader:'ts'},bundle:true,format:'esm',outfile:path.join(output,'check.js'),logLevel:'silent'});
const cache=path.join(os.homedir(),'Library/Caches/ms-playwright');
const installed=(await fs.readdir(cache)).filter(n=>n.startsWith('chromium_headless_shell-')).sort((a,b)=>Number(b.split('-').at(-1))-Number(a.split('-').at(-1)))[0];
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || path.join(cache,installed,'chrome-headless-shell-mac-arm64/chrome-headless-shell')});
const page=await browser.newPage({viewport:{width:1440,height:900}});
const errors=[];page.on('pageerror',error=>errors.push(String(error)));
await page.route('**/*',async route=>{
 const url=new URL(route.request().url());assert.equal(url.hostname,'hud.test');
 if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/check.css"><body class="game-mode"><div id="game-shell" style="position:fixed;inset:0;background:#7fa3b8"><div id="game" tabindex="0"></div><div id="ui-windows"></div><div id="hud"></div></div><script type="module" src="/check.js"></script>'});
 const file=url.pathname.startsWith('/assets/')?path.join(root,'client/public-tms273',decodeURIComponent(url.pathname)):path.join(output,path.basename(url.pathname));
 await route.fulfill({body:await fs.readFile(file),contentType:({'.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png'})[path.extname(file)]||'application/octet-stream'});
});
try {
 await page.goto('http://hud.test/');await page.waitForFunction(()=>window.hud&&window.skills);
 await page.evaluate(()=>window.skills.open());
 if (process.argv.includes('--regeneration')) {
  assert.equal(await page.locator('[data-passive-id]').count(),0,'old server snapshot does not invent regeneration');
  await page.evaluate(()=>{window.player=structuredClone(window.player);window.player.derivedStats={regenerationPassives:[{id:'beginner-recovery',bookId:0,hpPerSecond:1,mpPerSecond:1}]};window.skills.update(window.player)});
  const passive=page.locator('[data-passive-id="beginner-recovery"]');
  assert.equal(await passive.count(),1);
  assert.match(await passive.innerText(),/HP\+1 MP\+1\/秒/);
  for(const [width,height] of [[1440,900],[844,390],[390,844],[320,568],[1440,900]]) {
   await page.setViewportSize({width,height});
   await passive.click();
   assert.match(await page.evaluate(()=>window.lastStatus),/永久被动.*不消耗技能点/);
   assert.deepEqual(await page.evaluate(()=>window.sent),[],'passive click sends no cast/learn intent');
   const rect=await passive.boundingBox();
   assert(rect&&rect.x>=0&&rect.y>=0&&rect.x+rect.width<=width&&rect.y+rect.height<=height);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   assert(await passive.locator('.skill-cell-name').evaluate(e=>e.scrollWidth<=e.clientWidth),'passive label fits');
   await page.screenshot({path:path.join(output,`regeneration-${width}x${height}.png`)});
  }
  for(const [job,bookId,id,hpPerSecond,mpPerSecond] of [[222,200,'magician-recovery',0,1],[112,100,'warrior-recovery',2,0]]) {
   await page.evaluate(({job,bookId,id,hpPerSecond,mpPerSecond})=>{window.player=structuredClone(window.player);window.player.job=job;window.player.derivedStats.regenerationPassives=[{id:'beginner-recovery',bookId:0,hpPerSecond:1,mpPerSecond:1},{id,bookId,hpPerSecond,mpPerSecond}];window.skills.update(window.player)}, {job,bookId,id,hpPerSecond,mpPerSecond});
   await page.locator(`[data-book-id="${bookId}"]`).click();
   assert.equal(await page.locator(`[data-passive-id="${id}"]`).count(),1);
   await page.locator('[data-book-id="0"]').click();
   assert.equal(await passive.count(),1,'later jobs retain beginner passive');
  }
  await page.evaluate(()=>{window.player=structuredClone(window.player);window.player.hp=0;window.player.action='dead';window.skills.update(window.player)});
  assert.equal(await passive.count(),1,'death does not remove permanent passive');
  assert.deepEqual(errors,[]);
  console.log('PASS: authoritative permanent regeneration cards, no action requests, class inheritance, death, legacy snapshot, 4 viewports and resize.');
 } else {
 await page.locator('.skill-cell[data-skill-id="1000"]').click();
 await page.waitForFunction(()=>[...document.images].every(i=>i.complete));
 for(const [width,height] of [[1440,900],[844,390],[390,844],[320,568],[1440,900]]){
  await page.setViewportSize({width,height});
  assert(await page.locator('.skill-detail-view').isVisible());
  const state=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth,images:[...document.querySelectorAll('.skill-detail-view img')].map(i=>({className:i.className,width:i.getBoundingClientRect().width,height:i.getBoundingClientRect().height})),buttons:[...document.querySelectorAll('#hud button')].filter(e=>e.getBoundingClientRect().width).map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom}})}));
  await page.screenshot({path:path.join(output,`detail-${width}x${height}.png`)});
  assert(state.scroll<=width,'no horizontal overflow');
  assert(state.images.every(i=>i.width<=32&&i.height<=32),`detail icons retain native bounds: ${JSON.stringify(state.images)}`);
  assert(state.buttons.every(r=>r.x>=0&&r.y>=0&&r.right<=width&&r.bottom<=height),'HUD buttons inside viewport');
 }
 await page.evaluate(()=>window.skills.close());
 assert.equal(await page.locator('.tms-shortcut-cell').count(),32);
 const first=page.locator('.tms-shortcut-cell[data-shortcut-code="Digit1"][data-shortcut-shift="false"]');
 const fourth=page.locator('.tms-shortcut-cell[data-shortcut-code="Digit6"][data-shortcut-shift="true"]');
 assert.equal(await first.getAttribute('data-skill-id'),'1000');
 assert(await fourth.isDisabled(),'fourth-job reserved slot disabled for beginner');
 assert(!(await first.locator('.tms-shortcut-cooldown').isVisible()),'no idle cooldown overlay');
 await page.locator('#game').focus();await first.click();assert(await page.locator('#game').evaluate(e=>e===document.activeElement),'pointer shortcut preserves gameplay focus');assert.deepEqual(await page.evaluate(()=>window.sent),[{type:'cast',id:1000}]);
 await page.evaluate(()=>{window.player.derivedStats={skillCooldowns:{1000:1500}};window.hud.update(window.player)});
 assert(await first.isDisabled());assert.equal(await first.locator('.tms-shortcut-cooldown').innerText(),'2');
 await page.locator('.tms-quick-slot-toggle').click();assert(!(await fourth.isVisible()));
 await page.locator('.tms-quick-slot-toggle').click();assert(await fourth.isVisible());
 await page.evaluate(()=>{Object.assign(window.player,{job:222,mp:1000,skills:{2221011:1},derivedStats:{}});window.hud.update(window.player);window.sent=[]});
 assert.equal(await fourth.getAttribute('data-skill-id'),'2221011');
 await fourth.hover();await page.mouse.down();
 await page.evaluate(()=>{window.player.derivedStats={skillBuffs:{2221011:5000}};window.hud.update(window.player)});
 await page.mouse.up();
 assert.deepEqual(await page.evaluate(()=>window.sent),[{type:'cast',id:2221011},{type:'release',id:'offline-cast'}],'hold releases after authoritative snapshot disables button');
 await page.evaluate(()=>{window.player.derivedStats={};window.hud.update(window.player);window.sent=[]});
 await fourth.focus();await page.keyboard.down('Space');
 await page.locator('.tms-quick-slot-toggle').focus();
 assert.equal(await page.evaluate(()=>window.sent.at(-1).type),'release','focus change releases before keyup');
 await page.keyboard.up('Space');
 assert.deepEqual(await page.evaluate(()=>window.sent),[{type:'cast',id:2221011},{type:'release',id:'offline-cast'}],'keyboard hold releases on focus change');
 await page.evaluate(()=>{window.player.derivedStats={};window.hud.update(window.player);window.sent=[]});
 await fourth.hover();await page.mouse.down();await page.evaluate(()=>window.hud.update(undefined));await page.mouse.up();
 assert.deepEqual(await page.evaluate(()=>window.sent),[{type:'cast',id:2221011},{type:'release',id:'offline-cast'}],'missing player releases held action');
 assert.deepEqual(errors,[]);
 console.log('PASS: offline real 273 skill detail and HUD at desktop, landscape, narrow portrait and resize.');
 }
} finally {await browser.close();}
