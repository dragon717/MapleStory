// Offline UI check: real DOM/artwork, in-memory HTTP replies; never contacts a game server.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { build } = require('esbuild');
const { chromium } = require('/Users/muniao/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(import.meta.dirname, '../../../..');
const publicRoot = process.env.MAPLE_PREVIEW_ASSETS || path.join(root,'client/public-tms273');
const output = process.env.MAPLE_ENTRY_EVIDENCE || path.join(root, 'evidence/2026-10-03/voyage-deck-walk/flow');
await fs.mkdir(output, { recursive: true });
await build({ stdin: { contents: `import './src/app/style.css'; import { EntryView } from './src/features/entry/view'; import { MenuView } from './src/features/menu/view'; import { installGameAudio } from './src/features/world/game-audio'; const audio=installGameAudio(document.getElementById('welcome'),()=>undefined); window.__entryAudio=audio; const entry = new EntryView(document.getElementById('welcome'), async (session,ready) => { if(window.__failEntry)throw new Error('offline entry restoration check');if(!await ready())return;if(audio.entry.playing)throw new Error('entry music must stop when the world is ready');document.getElementById('entered').textContent=session.username; },audio.entry); window.__entry=entry; document.getElementById('show-menu').onclick=async()=>{const manifest=await fetch('/assets/manifest.json').then(r=>r.json()); const menu=new MenuView(document.getElementById('menu-host'),manifest,message=>document.getElementById('entered').textContent=message,()=>document.getElementById('entered').textContent='inventory'); menu.open('game');};`, resolveDir: path.join(root, 'client'), loader: 'ts' }, bundle: true, external: ['/assets/*'], format: 'esm', outfile: path.join(output, 'entry-check.js'), logLevel: 'silent' });
const browserCache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = (await fs.readdir(browserCache)).filter(name=>name.startsWith('chromium_headless_shell-')).sort((a,b)=>Number(b.split('-').at(-1))-Number(a.split('-').at(-1)))[0];
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (installed && path.join(browserCache, installed, 'chrome-headless-shell-mac-arm64/chrome-headless-shell'));
const browser = await chromium.launch({ headless: true, executablePath });
const page = await browser.newPage({ viewport: process.argv.includes('--deck-only') ? {width:960,height:640} : { width: 1440, height: 900 }, reducedMotion: 'reduce' });
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error' && /shader|WebGLProgram|VALIDATE_STATUS/i.test(message.text())) errors.push(message.text()); });
const manifest = JSON.parse(await fs.readFile(path.join(publicRoot,'assets/manifest.json'), 'utf8'));
// The handshake constants must match shared/protocol.ts, or authenticate()
// refuses the stub session exactly like it refuses an outdated server.
const sharedProtocol = await fs.readFile(path.join(root, 'shared/protocol.ts'), 'utf8');
const protocolVersion = Number(sharedProtocol.match(/PROTOCOL_VERSION = (\d+)/)?.[1]);
const contentVersion = sharedProtocol.match(/CONTENT_VERSION = '([^']+)'/)?.[1];
assert(protocolVersion > 0 && Boolean(contentVersion), 'shared protocol constants must be parseable');
const accountSession = { token: 'account-token', playerId: 'account-id', username: 'entry_check', protocolVersion, contentVersion };
let characters = [];
let creations = 0, selections = 0;
// A character whose current equipped rows differ from the frozen creation
// look: the selection/quick-start paper doll must render the equipped items
// (cap 1002067, coat 1040002), not the creation longcoat 1050286.
const swapCharacter = { id: 'preview-swap', name: '旅人', level: 5, job: 0, appearance: { gender: 0, face: 20100, hair: 30000, skin: 0, coat: 1050286, pants: 0, shoes: 1072833, weapon: 1302000 }, equipped: [{ slot: 1, itemId: '1002067', quantity: 1 }, { slot: 5, itemId: '1040002', quantity: 1 }, { slot: 7, itemId: '1072833', quantity: 1 }, { slot: 11, itemId: '1302000', quantity: 1 }] };
characters.push(swapCharacter, ...Array.from({length:4}, (_,i)=>({...swapCharacter,id:`passenger-${i}`,name:`乘客${i}`})));
await page.route('http://entry.test/**', async route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/entry-check.css"></head><body><div id="app"><main><section id="welcome"></section></main></div><div id="entered"></div><button id="show-menu" style="position:fixed;right:0;bottom:0;z-index:100">test menu</button><div id="menu-host" style="position:fixed;inset:0;pointer-events:none;z-index:99"></div><script type="module" src="/entry-check.js"></script></body></html>' });
  if (url.pathname === '/api/register') return route.fulfill({ json: { ok: true } });
  if (url.pathname === '/api/login') return route.fulfill({ json: accountSession });
  if (url.pathname === '/api/lobby') {
    const request = route.request().postDataJSON();
    assert.equal(request.token, accountSession.token);
    if (request.action === 'list') return route.fulfill({ json: { characters, slotLimit: 12, channelId: 1 } });
    if (request.action === 'checkName') return route.fulfill({ json: { available: !characters.some(item => item.name === request.name) } });
    if (request.action === 'create') { assert(!('job' in request), 'class preview must not grant a job'); creations++; const look = request.appearance; const character = { id: String(creations).padStart(64, '0'), name: request.name, appearance: look, level: 1, job: 0, equipped: [[5, look.coat], [6, look.pants], [7, look.shoes], [11, look.weapon]].filter(([, itemId]) => itemId).map(([slot, itemId]) => ({ slot, itemId, quantity: 1 })) }; characters.push(character); return route.fulfill({ json: { character } }); }
    if (request.action === 'select') { selections++; const character = characters.find(item => item.id === request.characterId); assert(character); assert.equal(request.channelId, 1); return route.fulfill({ json: { ...accountSession, token: 'character-token', playerId: character.id, username: character.name } }); }
    throw new Error(`Unknown action ${request.action}`);
  }
  const decoration = { 'panel': 'entry-panel', 'button': 'entry-button', 'crest': 'maple-crest' };
  const kind = url.pathname.match(/^\/assets\/entry\/voyage-(panel|button|crest)\.png$/)?.[1];
  const file = kind ? path.join(root, 'resources/scenes/sky-voyage-v3/textures', decoration[kind]+'.png') : url.pathname === '/assets/entry/sky-voyage.glb' ? path.join(root,'resources/scenes/sky-voyage-v3/models/sky-voyage.glb') : url.pathname === '/assets/entry/voyage-book.glb' ? path.join(root,'resources/scenes/sky-voyage-v3/models/voyage-book.glb') : url.pathname === '/assets/entry/captain-sign-wood.png' ? path.join(root,'resources/scenes/sky-voyage-v3/textures/deck-planks.png') : url.pathname === '/assets/entry/sky-city.glb' ? path.join(root,'resources/scenes/sky-voyage-v3/prototypes/sky-city-spatial-prototype.glb') : url.pathname.startsWith('/assets/') ? path.join(publicRoot,decodeURIComponent(url.pathname)) : path.join(output, path.basename(url.pathname));
  try { const body = await fs.readFile(file); const ext = path.extname(file); return route.fulfill({ body, contentType: ({ '.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg' })[ext] ?? 'application/octet-stream' }); }
  catch { return route.fulfill({ status: 404, body: 'missing test resource' }); }
});
const artReady = () => page.waitForFunction(() => [...document.querySelectorAll('.entry-background img,.entry-avatar img,.maple-menu img')].every(img => img.complete && img.naturalWidth > 0));
try {
  await page.goto('http://entry.test/');
  await page.locator('.entry-background img').first().waitFor({ state: 'attached' });
  await artReady();
  await page.locator('.entry-voyage-ready').waitFor({timeout:60000});
  assert.equal(await page.locator('.entry-avatar').count(),0,'first login must not invent a player');
  assert.equal(await page.locator('.voyage-canvas').count(),1);
  if(process.argv.includes('--visual-only')) {
    const {captureVoyageVisuals}=await import('./voyage.visual.check.mjs');
    await captureVoyageVisuals(page,output,errors);
    assert.deepEqual(errors,[]);
  } else {
  if(!process.argv.includes('--deck-only')) await page.screenshot({ path: path.join(output, 'login-desktop.png') });
  await page.locator('#username').fill('entry_check');
  await page.locator('#password').fill('entry-check-password');
  await page.locator('#submit').click();console.log('Visible native login submitted');
  await page.locator('.entry-stage-channel').waitFor();
  assert.equal(await page.locator('.voyage-adventure').count(),1);
  await artReady();
  const quickAvatar = page.locator('.voyage-deck-avatar .entry-avatar');
  assert(await quickAvatar.locator('img[src*="01002067"]').count() > 0, 'quick-start preview must render the equipped cap');
  assert(await quickAvatar.locator('img[src*="01040002"]').count() > 0, 'quick-start preview must render the equipped coat');
  assert.equal(await quickAvatar.locator('img[src*="01050286"]').count(), 0, 'quick-start preview must not fall back to the creation longcoat');
  const deckState = () => page.evaluate(() => { const v=window.__entry.voyage, d=v.deck, doll=v.passengers.root.getObjectByName('SV3_Passenger_preview-swap'); return { position:d.position.toArray(), spawn:d.spawn.toArray(), moving:d.moving, action:v.passengerAction('preview-swap'), cameraFacing:doll.quaternion.angleTo(v.ship.getWorldQuaternion(doll.quaternion.clone()).invert().multiply(v.camera.getWorldQuaternion(doll.quaternion.clone()))), keys:v.keys.size }; });
  await page.waitForFunction(()=>{const v=window.__entry.voyage,d=v.passengers.root.getObjectByName("SV3_Passenger_preview-swap");return d && d.quaternion.angleTo(v.ship.getWorldQuaternion(d.quaternion.clone()).invert().multiply(v.camera.getWorldQuaternion(d.quaternion.clone())))<.00001;});
  await page.evaluate(()=>{const v=window.__entry.voyage;window.__cameraRayTimes=[];const original=v.avoidCameraSurface.bind(v);v.avoidCameraSurface=(...args)=>{const t=performance.now();try{return original(...args);}finally{window.__cameraRayTimes.push(performance.now()-t);}};});
  const beforeWalk = await deckState();
  assert(beforeWalk.position[1]>5.4 && beforeWalk.position[1]<5.5, 'feet stand on the actual hull surface');
  assert(beforeWalk.cameraFacing<.00001, 'passenger keeps the complete camera-facing foot plane');
  await page.evaluate(()=>{ const v=window.__entry.voyage; window.__renderClouds=v.clouds.render.bind(v.clouds); v.clouds.render=()=>{}; });
  await page.keyboard.down('ArrowLeft');
  await page.waitForFunction(() => window.__entry.voyage.deck.moving, null, {timeout:10000});
  assert.equal((await deckState()).action,'walk');
  await page.waitForFunction(start => Math.hypot(...[0,2].map(i=>window.__entry.voyage.deck.position.toArray()[i]-start[i]))>.5, beforeWalk.position);
  await page.keyboard.up('ArrowLeft');
  await page.waitForFunction(() => !window.__entry.voyage.passengers.deckMoving);
  assert.equal((await deckState()).action,'stand');
  const stopped = (await deckState()).position;
  await page.keyboard.press('Space');await page.waitForFunction(()=>window.__entry.voyage.deck.jumping && window.__entry.voyage.passengerAction("preview-swap")==="jump");
  assert.equal((await deckState()).action,'jump');await page.waitForFunction(()=>!window.__entry.voyage.deck.jumping);
  assert(Math.abs((await deckState()).position[1]-stopped[1])<.0001,'jump lands on the same actual floor');
  assert.equal(selections,0,'walking never selects a world session');
  await page.keyboard.down('KeyA'); await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  assert.equal((await deckState()).keys,0,'losing focus clears all held movement'); await page.keyboard.up('KeyA');
  await page.evaluate(()=>{const v=window.__entry.voyage;v.clouds.render=window.__renderClouds;v.updateActivity();});
  await page.screenshot({ path: path.join(output, 'channel-desktop.png') });
  if(process.argv.includes('--voyage-only')) {
    const zoom=await page.evaluate(()=>window.__entry.voyage.zoom);await page.mouse.move(450,300);await page.mouse.wheel(0,80);assert((await page.evaluate(()=>window.__entry.voyage.zoom))>zoom);
    const pitch=await page.evaluate(()=>window.__entry.voyage.pitch);await page.mouse.move(450,300);await page.mouse.down({button:'right'});await page.mouse.move(450,340);await page.mouse.up({button:'right'});assert((await page.evaluate(()=>window.__entry.voyage.pitch))>pitch);
    await page.evaluate(()=>{const v=window.__entry.voyage;v.pitch=.24;v.yaw=0;v.zoom=1.2;v.deck.place(v.deck.position.clone().set(6.4,5.445,11.65));v.entranceArmed=true;v.updateActivity();});
    await page.keyboard.down('ArrowDown');await page.locator('.entry-stage-characters').waitFor();await page.keyboard.up('ArrowDown');console.log('Real doorway entered');
    assert.equal(selections,0,'walking through the real door only enters the existing selection cabin');
    await page.evaluate(()=>{const v=window.__entry.voyage;v.cabinDeck.place(v.cabinDeck.position.clone().set(0,0,46));v.passengers.finishWake();v.updateActivity();});
    const cabinBefore=await page.evaluate(()=>window.__entry.voyage.cabinDeck.position.toArray());
    await page.keyboard.down('ArrowLeft');await page.waitForFunction(p=>window.__entry.voyage.cabinDeck.position.distanceTo(window.__entry.voyage.cabinDeck.spawn.clone().fromArray(p))>.3,cabinBefore);await page.keyboard.up('ArrowLeft');
    await page.evaluate(()=>document.querySelector('[data-select="passenger-0"]').click());
    assert.equal(await page.evaluate(()=>window.__entry.selected),'passenger-0');assert(await page.evaluate(()=>window.__entry.voyage.passengers.returning.has('preview-swap')));
    await page.waitForFunction(()=>window.__entry.voyage.passengers.sleeping('preview-swap'),null,{timeout:4000});
    await page.evaluate(()=>{const v=window.__entry.voyage,p=v.ship.worldToLocal(v.model.getObjectByName('SV2_Bed_5_SleepAnchor').getWorldPosition(v.camera.position.clone())).add(v.camera.position.clone().set(1.55,0,.98));p.y=0;v.cabinDeck.place(p);v.passengers.finishWake();v.updateActivity();});
    await page.keyboard.down('ArrowLeft');await page.keyboard.down('ArrowDown');await page.locator('#create-character').waitFor();await page.keyboard.up('ArrowLeft');await page.keyboard.up('ArrowDown');console.log('Empty bed opened form');
    assert.equal(creations,0,'approaching an empty bed opens the existing form without creating anything');
    await page.locator('#character-name').fill('冒险自检');await page.locator('#create-character button[type="submit"]').click();await page.locator('.entry-stage-characters').waitFor();assert.equal(creations,1);assert.equal(selections,0);
    await page.evaluate(()=>{const v=window.__entry.voyage;v.cabinDeck.place(v.cabinDeck.position.clone().set(0,0,45.3));v.passengers.finishWake();v.exitArmed=true;v.updateActivity();});
    await page.keyboard.down('ArrowDown');await page.keyboard.down('ArrowRight');await page.locator('.entry-stage-channel').waitFor();await page.keyboard.up('ArrowDown');await page.keyboard.up('ArrowRight');console.log('Cabin portal returned to deck');
    await page.evaluate(()=>{const v=window.__entry.voyage;v.deck.place(v.deck.position.clone().set(6.5,5.445,-35));v.updateActivity();});await page.waitForFunction(()=>!document.querySelector('.voyage-adventure-shortcut').hidden);
    await page.evaluate(()=>{const v=window.__entry.voyage;v.deck.place(v.deck.position.clone().set(2,5.445,7));v.updateActivity();});await page.waitForFunction(()=>!document.querySelector('.voyage-adventure').hidden);
    assert(await page.locator('.voyage-adventure').isEnabled(),'physical board remains clickable well beyond the old distance limit');
    await page.screenshot({path:path.join(output,'deck-exterior.png')});
    const transmission=await page.evaluate(()=>{const v=window.__entry.voyage;const mats=[];v.model.traverse(o=>{for(const m of o.material?Array.isArray(o.material)?o.material:[o.material]:[]){if(m.name==='SV3_Prototype_SapphireGlass')mats.push({physical:m.isMeshPhysicalMaterial,transmission:m.transmission,ior:m.ior});}});document.querySelector('.entry-scene').style.visibility='hidden';v.camera.position.set(18,8.3,-21.2);v.camera.lookAt(10.8,8.15,-21.2);v.camera.updateMatrixWorld(true);v.clouds.render(v.renderer,v.scene,v.camera,v.sun);return mats;});
    assert(transmission.length&&transmission.every(m=>m.physical&&m.transmission>.93&&m.ior>1.45));await page.screenshot({path:path.join(output,'sapphire-transmission.png')});
    await page.evaluate(()=>{document.querySelector('.entry-scene').style.visibility='';window.__entry.voyage.updateActivity();});
    await page.locator('.voyage-adventure').click();await page.locator('#entered').waitFor({state:'visible'});assert.equal(selections,1);
    const cameraRay=await page.evaluate(()=>{const a=window.__cameraRayTimes.sort((a,b)=>a-b);return{samples:a.length,medianMs:a[Math.floor(a.length*.5)],p95Ms:a[Math.floor(a.length*.95)],maxMs:a.at(-1)};});assert.deepEqual(errors,[]);await fs.writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,mode:'offline production WebGL and local cabin lifecycle; in-memory account replies',transmission,cameraRay,selections,creations,errors},null,2));console.log('Camera collision ray CPU:',JSON.stringify(cameraRay));console.log('Production ship/cabin walking, jump, camera, empty-bed creation, return and physical transmission passed');
  } else   if(process.argv.includes('--deck-only')) { assert.deepEqual(errors,[]); await fs.writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,mode:'offline lobby geometry and keyboard input',beforeWalk,stopped,selections,errors},null,2)); console.log('Lobby upright feet, walking, skill isolation and blur checks passed'); } else {
  await page.locator('[data-action="channel"]').click();
  await artReady();
  assert.equal(await page.locator('.entry-character').count(),4,'four bunks per page, not an account cap');
  assert.equal(await page.locator('[data-page]').count(),3,'all twelve slots remain accessible');
  await page.locator('[data-page="1"]').click();
  assert.equal(await page.locator('[data-select="passenger-3"]').count(),1);
  await page.locator('[data-page="0"]').click();
  const swapAvatar = page.locator('[data-character="preview-swap"]');
  assert(await swapAvatar.locator('img[src*="01002067"]').count() > 0, 'selection preview must render the equipped cap');
  assert(await swapAvatar.locator('img[src*="01040002"]').count() > 0, 'selection preview must render the equipped coat');
  assert.equal(await swapAvatar.locator('img[src*="01050286"]').count(), 0, 'selection preview must not fall back to the creation longcoat');
  await page.screenshot({ path: path.join(output, 'characters-empty-desktop.png') });
  await page.locator('[data-action="create"]').first().click();
  assert.equal(await page.locator('.voyage-cabin-window').count(),4);
  await page.locator('[data-profession="3"]').click();
  assert.equal(await page.locator('[data-option="skin"]').first().isDisabled(),true);
  assert.equal(await page.locator('[data-option="pants"]').first().isDisabled(),true);
  await page.locator('#character-name').fill('冒险自检');
  await page.locator('[data-action="check-name"]').click();
  await page.locator('.entry-notice').filter({ hasText: '此名称可以使用' }).waitFor();
  const appearanceControls = page.locator('.entry-appearance-options button');
  assert(await appearanceControls.count() > 6, 'creation must offer real appearance options');
  await artReady();
  await page.screenshot({ path: path.join(output, 'create-desktop.png') });
  const sizes = [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1440, height: 900 }];
  const fit = [];
  for (const size of sizes) {
    await page.setViewportSize(size);
    const metrics = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, controls: [...document.querySelectorAll('#create-character button,#create-character input')].map(node => { const r=node.getBoundingClientRect(); return { left:r.left,right:r.right,width:r.width }; }) }));
    assert(metrics.scrollWidth <= metrics.width, 'page must not overflow horizontally');
    assert(metrics.controls.every(control => control.left >= 0 && control.right <= metrics.width && control.width > 0), 'creation controls fit width');
    const actions = await page.locator('.entry-create-actions').boundingBox();
    assert(actions && actions.y >= 0 && actions.y + actions.height <= size.height, 'create/cancel actions stay visible without scrolling the page');
    for (const window of await page.locator('[data-profession]').all()) { const r = await window.boundingBox(); assert(r && r.x >= 0 && r.y >= 0 && r.x+r.width <= size.width && r.y+r.height <= size.height, 'all four class windows fit the viewport'); }
    assert(await page.locator('.voyage-window-portrait img').evaluateAll(es=>es.every(e=>e.complete&&e.naturalWidth>0)), 'generated window art loads on small screens');
    fit.push({ size, ...metrics });
    await artReady();
  await page.screenshot({ path: path.join(output, `create-${size.width}x${size.height}.png`), fullPage: true });
  }
  await page.locator('#create-character button[type="submit"]').click();
  await page.locator('.voyage-leaving-cabin').waitFor();
  assert.equal(characters.at(-1).job,0);
  assert.equal(await page.locator('.voyage-deck-avatar [data-character]').count(),1);
  await page.locator('[data-action="channel"]').click();
  await page.locator('[data-select].selected').waitFor();
  assert.equal(creations, 1);
  await artReady();
  await page.screenshot({ path: path.join(output, 'characters-desktop.png') });
  await page.locator('[data-select].selected').dblclick();
  assert.equal(selections, 0, 'selecting or double-clicking a bed cannot enter the game');
  await page.evaluate(() => { window.__failEntry = true; });
  await page.locator('[data-action="enter"]').click();
  await page.locator('.entry-notice').filter({ hasText: 'offline entry restoration check' }).waitFor();
  assert.equal(await page.locator('.voyage-canvas').count(), 1, 'entry failure restores the scene');
  assert(await page.locator('[data-action="enter"]').isEnabled());
  await page.evaluate(() => { window.__failEntry = false; });
  await page.locator('[data-action="enter"]').click();
  await page.locator('#entered').filter({ hasText: '冒险自检' }).waitFor();
  assert.equal(await page.locator('.voyage-canvas').count(),0,'entering the game disposes the entry renderer');
  assert.equal(await page.evaluate(()=>window.__entryAudio.entry.playing),false,'entry music is released before game loading');
  await page.locator('#show-menu').click();
  await page.locator('.maple-menu-item').nth(41).waitFor();
  await artReady();
  await page.screenshot({ path: path.join(output, 'menu-desktop.png') });
  assert.equal(await page.locator('.maple-menu-item').count(), 42);
  for (const size of sizes) {
    await page.setViewportSize(size);
    await artReady();
    await page.waitForFunction(() => document.querySelector('.maple-menu').getBoundingClientRect().right <= innerWidth);
    await page.screenshot({ path: path.join(output, `menu-${size.width}x${size.height}.png`) });
  }
  await page.keyboard.press('Escape');
  assert(await page.locator('.maple-menu-layer').isHidden());
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, mode: 'offline HTTP stubs; no live accounts or game server', creations, fit, errors }, null, 2));
  console.log('Entry offline flow, creation controls and responsive widths passed. Evidence:', output);
  }
  }
} finally { await browser.close(); }
