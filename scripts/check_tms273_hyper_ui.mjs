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
const output = path.join(root, 'output/playwright/hyper-ui');
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
const update = patch => page.evaluate(patch => { window.player={...window.player,...patch}; window.skills.update(window.player); window.hud.update(window.player); },patch);
const cell = id => page.locator(`.skill-cell-item[data-skill-id="${id}"]`);
try {
 await page.goto('http://hud.test/'); await page.waitForFunction(()=>window.skills&&window.hud);
 await page.evaluate(()=>window.skills.open());
 assert(await page.locator('.skill-bottom-button-BtHyper').isDisabled());
 await update({job:222,level:140,mesos:200000,skills:{2211007:10},skillPoints:{222:20},hyperPoints:{1:1,2:1},hyperResetCost:100000,hyperResetCount:0});
 await page.locator('.skill-bottom-button-BtHyper').click();
 assert.equal(await page.locator('.skill-cell-item').count(),9);
 assert(await cell(2220043).locator('.skill-cell-learn').isEnabled());
 assert(await cell(2220044).locator('.skill-cell-learn').isDisabled(),'level150 required despite ordinary SP');
 await cell(2220043).locator('.skill-cell-learn').click();
 assert.equal((await page.evaluate(()=>window.sent.at(-1))).type,'learnSkill');
 await update({skills:{2211007:10,2220043:1},hyperPoints:{1:0,2:1}});
 await page.locator('[data-hyper-control="tab-2"]').click();
 assert.equal(await page.locator('.skill-cell-item').count(),3,'hidden vortex excluded');
 assert(await cell(2221052).locator('.skill-cell-learn').isDisabled());
 assert(await cell(2221054).locator('.skill-cell-learn').isEnabled());
 await update({level:160,skills:{2211007:10,2220043:1,2221052:1,2221054:1},hyperPoints:{1:1,2:0}});
 await page.evaluate(()=>window.sent=[]);
 const held=cell(2221052).locator('.skill-cell-cast');
 await held.dispatchEvent('pointerdown',{button:0,pointerId:1});
 await page.evaluate(()=>window.dispatchEvent(new PointerEvent('pointerup',{pointerId:1})));
 const heldMessages=await page.evaluate(()=>window.sent);
 assert.deepEqual(heldMessages.map(x=>x.type),['castSkill','releaseSkill']);
 assert.equal(heldMessages[0].skillId,2221052);
 assert.equal(heldMessages[1].requestId,heldMessages[0].requestId);
 for(const [width,height] of [[1440,900],[844,390],[390,844],[320,568],[1440,900]]) {
  await page.setViewportSize({width,height});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  for(const selector of ['[data-hyper-control="reset"]','[data-hyper-control="tab-2"]']) {
   const r=await page.locator(selector).boundingBox();assert(r&&r.x>=0&&r.y>=0&&r.x+r.width<=width&&r.y+r.height<=height,`Hyper controls reachable ${width}x${height} ${selector} ${JSON.stringify(r)}`);
  }
  await page.screenshot({path:path.join(output,`hyper-${width}x${height}.png`)});
 }
 await page.evaluate(()=>window.sent=[]);
 page.once('dialog',dialog=>dialog.dismiss());
 await page.locator('[data-hyper-control="reset"]').click();
 assert.deepEqual(await page.evaluate(()=>window.sent),[],'cancel does not reset');
 page.once('dialog',dialog=>{assert.match(dialog.message(),/100,000/);return dialog.accept();});
 await page.locator('[data-hyper-control="reset"]').click();
 const reset=await page.evaluate(()=>window.sent.at(-1));
 assert.equal(reset.type,'resetHyper');assert.equal(reset.expectedCost,100000);
 await update({mesos:0});assert(await page.locator('[data-hyper-control="reset"]').isDisabled());
 assert.deepEqual(errors,[]);
 console.log('PASS Hyper UI: gates/two pools/hidden exclusion/held release/quoted reset and cancellation/5 viewport transitions; offline only.');
} finally {await browser.close();}
