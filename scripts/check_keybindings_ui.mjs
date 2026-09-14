// Offline UI/input integration: no game service, account or database access.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { evidencePath } from './evidence-path.cjs';
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'client/package.json'));
const { build } = require('esbuild');
const { chromium } = require('/Users/muniao/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const output = evidencePath('keybindings');
await fs.mkdir(output, { recursive: true });
await build({ stdin: { contents: `
import { KeyBindings } from './src/features/keybindings/model';
import { KeybindingsView } from './src/features/keybindings/view';
import { HudView } from './src/features/hud/view';
import { SkillView } from './src/features/skills/view';
import { PlayerInput } from './src/features/player/input';
import { InventoryView } from './src/features/inventory/view';
import { CharacterInfoView } from './src/features/character/view';
import { WorldMapView } from './src/features/world/worldmap-view';
import { installKeybindingRouter } from './src/app/ui-router';
import './src/app/style.css';
import './src/features/hud/style.css';
const manifest = await (await fetch('/assets/manifest.json')).json();
window.sent=[];
window.player={id:'keybindings-offline',username:'键位检查',job:200,hp:100,maxHp:100,mp:100,maxMp:100,level:8,exp:0,expToNext:100,mesos:0,inventory:[{itemId:'02000000',slot:1,quantity:3}],action:'stand',grounded:true,skills:{1000:3,1001:1,1002:1,2000006:1,2001008:0},skillPoints:{0:0,200:0}};
window.bindings = new KeyBindings(); bindings.setCharacter(player.id,player.job);
window.view=new KeybindingsView(document.querySelector('#ui-windows'),manifest,bindings,text=>window.message=text);
view.update(player);
window.hud=new HudView(document.querySelector('#hud'),manifest,()=>{},undefined,undefined,undefined,{
 keySlots:()=>bindings.slots,resolveBinding:(code,shift)=>bindings.resolve(code,shift),bindingLabel:b=>view.bindingLabel(b),
 castSkill:id=>{sent.push(id);return 'cast';},bindSkill:(slot,id)=>view.bindSkillToSlot(slot,id),editSlot:slot=>{view.open();view.selectSlot(slot);}
});
window.skills=new SkillView(document.querySelector('#ui-windows'),manifest,{send:()=>true}); skills.update(player);skills.hotkeysEnabled=false;
window.inv=new InventoryView(document.querySelector('#ui-windows'),manifest,()=>{},()=>true);inv.hotkeysEnabled=false;
window.character=new CharacterInfoView(document.querySelector('#ui-windows'),manifest,()=>{},()=>true);character.hotkeysEnabled=false;
window.worldmap=new WorldMapView(document.querySelector('#ui-windows'),manifest);worldmap.hotkeysEnabled=false;
window.routed=[];installKeybindingRouter({resolve:(code,shift)=>bindings.resolve(code,shift),blocked:()=>view.isOpen(),activate:action=>{if(action==='inventory'){routed.push(action);return true;}return false;}});
window.input=new PlayerInput(m=>sent.push(m),{nearestDrop:()=>null,enterPortal:()=>{},nearestNpc:()=>null,talkTo:()=>{},toggleQuestLog:()=>{},resolveBinding:(c,s)=>bindings.resolve(c,s),castSkill:id=>sent.push(id),playerState:()=>player,isBlocked:()=>view.isOpen()}); input.setReady(true);
bindings.subscribe(()=>{input.reset();hud.update(player);});hud.update(player);view.open();
`, resolveDir: path.join(root, 'client'), loader: 'ts' }, bundle: true, format: 'esm', outfile: path.join(output, 'check.js'), logLevel: 'silent' });
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = (await fs.readdir(cache)).filter(n => n.startsWith('chromium_headless_shell-')).sort((a,b)=>Number(b.split('-').at(-1))-Number(a.split('-').at(-1)))[0];
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || path.join(cache,installed,'chrome-headless-shell-mac-arm64/chrome-headless-shell') });
try {
 const page = await browser.newPage({ viewport: {width:1440,height:900} });
 const errors=[]; page.on('pageerror', e=>errors.push(String(e)));
 await page.route('**/*', async route => {
  const url=new URL(route.request().url()); assert.equal(url.hostname,'keybindings.test');
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/check.css"><body class="game-mode"><div id="game-shell" style="position:fixed;inset:0;background:#7fa3b8"><div id="game" tabindex="0"></div><div id="ui-windows"></div><div id="hud"></div></div><script type="module" src="/check.js"></script>'});
  const file=url.pathname.startsWith('/assets/')?path.join(root,'client/public-tms273',decodeURIComponent(url.pathname)):path.join(output,path.basename(url.pathname));
  await route.fulfill({body:await fs.readFile(file),contentType:({'.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png'})[path.extname(file)] || 'application/octet-stream'});
 });
 await page.goto('http://keybindings.test');
 await page.waitForSelector('.keybindings-window');
 assert.equal(await page.locator('.keybindings-slot').count(),32);
 assert.equal(await page.locator('.keybindings-choice').count(),3,'learned beginner actives available, passive/unlearned mage skills excluded');
 await page.locator('.keybindings-choice').first().click();
 await page.locator('.keybindings-key[data-code="KeyI"]').click();
 assert.deepEqual(await page.evaluate(()=>bindings.resolve('KeyI',false)),{type:'skill',skillId:1000});
 await page.locator('.keybindings-slot[data-slot="0"]').click();
 await page.keyboard.press('i');
 assert.equal(await page.evaluate(()=>bindings.slots[0].code),'KeyI');
 assert.deepEqual(await page.evaluate(()=>bindings.resolve('Digit1',false)),{type:'skill',skillId:2001008},'changing visible slot does not rewrite keyboard assignment');
 await page.getByRole('button',{name:'完成',exact:true}).click();
 await page.keyboard.press('i');
 assert(await page.evaluate(()=>sent.includes(1000)),'remapped I casts beginner skill after mage transfer');
 assert.equal(await page.evaluate(()=>routed.length),0,'old inventory hotkey cannot intercept assigned skill');
 await page.evaluate(()=>{bindings.bind('KeyC',false,{type:'skill',skillId:1001});bindings.bind('KeyM',false,{type:'skill',skillId:1002});});
 await page.keyboard.press('c');await page.keyboard.press('m');
 assert(await page.evaluate(()=>sent.includes(1001)&&sent.includes(1002)),'C/M do not open old windows');
 await page.reload();await page.waitForSelector('.keybindings-window');
 assert.deepEqual(await page.evaluate(()=>bindings.resolve('KeyI',false)),{type:'skill',skillId:1000},'reload keeps key binding');
 assert.equal(await page.evaluate(()=>bindings.slots[0].code),'KeyI','reload keeps bar position');
 await page.evaluate(()=>{view.close();skills.open();});
 await page.locator('.skill-cell[data-skill-id="1000"]').dragTo(page.locator('.tms-shortcut-cell[data-shortcut-code="Digit2"][data-shortcut-shift="false"]'));
 assert.deepEqual(await page.evaluate(()=>bindings.resolve('Digit2',false)),{type:'skill',skillId:1000},'skill card drops onto HUD');
 await page.evaluate(()=>{skills.close();view.open();});
 for(const [name,width,height] of [['wide',1440,900],['landscape',844,390],['portrait',390,844],['resized',1024,768]]) {
  await page.setViewportSize({width,height});
  await page.locator('.keybindings-window').evaluate(el=>el.scrollTop=0);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.screenshot({path:path.join(output,`${name}.png`)});
  const bounds=await page.locator('.keybindings-window').evaluate(el=>({scroll:el.scrollWidth,width:el.clientWidth,left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right}));
  assert(bounds.scroll<=bounds.width+1,`${name}: no horizontal content overflow`);
  assert(bounds.left>=0&&bounds.right<=width,`${name}: panel stays in viewport`);
  const visibleHp=await page.evaluate(()=>document.querySelector('.keybindings-window').getBoundingClientRect().bottom<=document.querySelector('.tms-status').getBoundingClientRect().top);
  assert(visibleHp,`${name}: key window does not cover HP/MP`);
  await page.getByRole('button',{name:'完成',exact:true}).scrollIntoViewIfNeeded();
  assert(await page.getByRole('button',{name:'完成',exact:true}).isVisible(),`${name}: footer reachable`);
 }
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,checks:['learned beginner palette','bind and replace I/C/M','32 independent bar slots','reload persistence','skill drag to HUD','4 responsive sizes'],evidence:output}));
} finally { await browser.close(); await fs.rm(path.join(output,'check.js'),{force:true}); await fs.rm(path.join(output,'check.css'),{force:true}); }
