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
await build({ stdin: { contents: `import './src/app/style.css'; import Phaser from 'phaser'; import * as Three from 'three'; window.__three=Three; import { EntryView } from './src/features/entry/view'; import { ClientActionsView } from './src/features/client-actions/view'; import { MenuView } from './src/features/menu/view'; import { installGameAudio } from './src/features/world/game-audio'; let audioGame; const audio=installGameAudio(document.getElementById('welcome'),()=>audioGame); window.__entryAudio=audio; window.__createAudioGame=()=>new Promise(resolve=>{audioGame=new Phaser.Game({type:Phaser.HEADLESS,width:1,height:1,banner:false,audio:{context:audio.context()},scene:{create(){resolve(this.sound instanceof Phaser.Sound.WebAudioSoundManager && this.sound.context===audio.context());}}});audio.bind(audioGame);});window.__destroyAudioGame=()=>{audioGame.destroy(true);audioGame=undefined;}; const entry = new EntryView(document.getElementById('welcome'), async (session,ready) => { if(window.__failEntry)throw new Error('offline entry restoration check');if(!await ready())return;if(audio.entry.playing)throw new Error('entry music must stop when the world is ready');document.getElementById('entered').textContent=session.username; },audio.entry); window.__entry=entry; if (new URL(location.href).searchParams.has('reference')) window.__actions=new ClientActionsView(document.getElementById('app')); document.getElementById('show-menu').onclick=async()=>{const manifest=await fetch('/assets/manifest.json').then(r=>r.json()); const menu=new MenuView(document.getElementById('menu-host'),manifest,message=>document.getElementById('entered').textContent=message,()=>document.getElementById('entered').textContent='inventory'); menu.open('game');};`, resolveDir: path.join(root, 'client'), loader: 'ts' }, bundle: true, external: ['/assets/*'], format: 'esm', outfile: path.join(output, 'entry-check.js'), logLevel: 'silent' });
const browserCache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = (await fs.readdir(browserCache)).filter(name=>name.startsWith('chromium_headless_shell-')).sort((a,b)=>Number(b.split('-').at(-1))-Number(a.split('-').at(-1)))[0];
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (installed && path.join(browserCache, installed, 'chrome-headless-shell-mac-arm64/chrome-headless-shell'));
const audioOnly = process.argv.includes('--audio-only') || process.argv.includes('--audio-gesture-only');
const browser = await chromium.launch({ headless: true, executablePath, args: [process.argv.includes('--audio-gesture-only') ? '--autoplay-policy=document-user-activation-required' : '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: (process.argv.includes('--deck-only') || process.argv.includes('--camera-motion-only') || process.argv.includes('--route-only')) ? {width:960,height:640} : { width: 1440, height: 900 }, reducedMotion: process.env.MAPLE_REDUCED_MOTION === 'no-preference' ? 'no-preference' : 'reduce' });
const errors = [];
const consoleErrors = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); if (message.type() === 'error' && /shader|WebGLProgram|VALIDATE_STATUS/i.test(message.text())) errors.push(message.text()); });
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
if(process.argv.includes('--details-only')) { characters[0].name='muniao';characters[1].name='乘风破浪冒险家'; }
const audioRequests = [];
page.on('request', request => { if (audioOnly) audioRequests.push({ url: new URL(request.url()).pathname, at: Date.now() }); });
if (audioOnly) await page.addInitScript(() => { window.__audioStarts = []; const create = AudioContext.prototype.createBufferSource; AudioContext.prototype.createBufferSource = function(...args) { const source = create.apply(this,args), start = source.start.bind(source); source.start = (...args) => { window.__audioStarts.push(Date.now()); return start(...args); }; return source; }; });
await page.route('http://entry.test/**', async route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/entry-check.css"></head><body><div id="app"><main><section id="welcome"></section></main></div><div id="entered"></div><button id="show-menu" style="position:fixed;right:0;bottom:0;z-index:100">test menu</button><div id="menu-host" style="position:fixed;inset:0;pointer-events:none;z-index:99"></div><script type="module" src="/entry-check.js"></script></body></html>' });
  if (url.pathname === '/api/register') return route.fulfill({ json: { ok: true } });
  if (url.pathname === '/api/login') return route.fulfill({ json: accountSession });
  if (url.pathname === '/api/lobby') {
    const request = route.request().postDataJSON();
    assert.equal(request.token, accountSession.token);
    if (request.action === 'logout') return route.fulfill({json:{ok:true}});
    if (request.action === 'list') return route.fulfill({ json: { characters, slotLimit: 12, channelId: 1 } });
    if (request.action === 'checkName') return route.fulfill({ json: { available: !characters.some(item => item.name === request.name) } });
    if (request.action === 'create') { assert(!('job' in request), 'class preview must not grant a job'); creations++; const look = request.appearance; const character = { id: String(creations).padStart(64, '0'), name: request.name, appearance: look, level: 1, job: 0, equipped: [[5, look.coat], [6, look.pants], [7, look.shoes], [11, look.weapon]].filter(([, itemId]) => itemId).map(([slot, itemId]) => ({ slot, itemId, quantity: 1 })) }; characters.push(character); return route.fulfill({ json: { character } }); }
    if (request.action === 'select') { selections++; const character = characters.find(item => item.id === request.characterId); assert(character); assert.equal(request.channelId, 1); return route.fulfill({ json: { ...accountSession, token: 'character-token', playerId: character.id, username: character.name } }); }
    throw new Error(`Unknown action ${request.action}`);
  }
  if (audioOnly && url.pathname === manifest.mapCatalog.maps.find(m=>m.id==='200000000').bgm) await new Promise(resolve=>setTimeout(resolve,800));
  const decoration = { 'panel': 'entry-panel', 'button': 'entry-button', 'crest': 'maple-crest' };
  const kind = url.pathname.match(/^\/assets\/entry\/voyage-(panel|button|crest)\.png$/)?.[1];
  const actionArt = url.pathname.match(/^\/assets\/entry\/(entry-(?:return-login|begin-adventure))\.png$/)?.[1];
  const file = actionArt ? path.join(root, 'resources/scenes/sky-voyage-v3/textures', actionArt + '.png') : kind ? path.join(root, 'resources/scenes/sky-voyage-v3/textures', decoration[kind]+'.png') : url.pathname === '/assets/entry/sky-voyage.glb' ? path.join(root,'resources/scenes/sky-voyage-v3/models/sky-voyage.glb') : url.pathname === '/assets/entry/voyage-book.glb' ? path.join(root,'resources/scenes/sky-voyage-v3/models/voyage-book.glb') : url.pathname === '/assets/entry/captain-sign-wood.png' ? path.join(root,'resources/scenes/sky-voyage-v3/textures/deck-planks.png') : url.pathname === '/assets/entry/sky-city.glb' ? path.join(root,'resources/scenes/sky-voyage-v3/prototypes/sky-city-spatial-prototype.glb') : url.pathname.startsWith('/assets/') ? path.join(publicRoot,decodeURIComponent(url.pathname)) : path.join(output, path.basename(url.pathname));
  try { const body = await fs.readFile(file); const ext = path.extname(file); return route.fulfill({ body, contentType: ({ '.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg' })[ext] ?? 'application/octet-stream' }); }
  catch { return route.fulfill({ status: 404, body: 'missing test resource' }); }
});
const capture = async name => { await page.evaluate(()=>{const v=window.__entry.voyage;if(v?.model){v.camera.updateMatrixWorld(true);v.renderer.render(v.scene,v.camera);}}); await page.screenshot({path:path.join(output,name)}); };
const artReady = async () => {
  try { await page.waitForFunction(() => [...document.querySelectorAll('.entry-background img,.entry-avatar img,.maple-menu img')].every(img => img.complete && img.naturalWidth > 0), undefined, { timeout: process.env.MAPLE_REDUCED_MOTION === 'no-preference' ? 90000 : 30000 }); }
  catch (error) { console.error('Unloaded artwork:',await page.locator('.entry-background img,.entry-avatar img,.maple-menu img').evaluateAll(images=>images.filter(img=>!img.complete||!img.naturalWidth).map(img=>img.src)));throw error; }
};
try {
  await page.goto(process.argv.includes('--reference-only') ? 'http://entry.test/?reference' : process.argv.includes('--english-only') ? 'http://entry.test/?lang=en' : 'http://entry.test/');
  if (process.argv.includes('--opening-only')) {
    const { checkVoyageOpening } = await import('./voyage.opening.check.mjs');
    await checkVoyageOpening(page, output, errors);
  } else if (audioOnly) {
    const { checkAudioOpening } = await import('./voyage.audio.check.mjs');
    await checkAudioOpening(page,output,audioRequests,errors,process.argv.includes('--audio-gesture-only'));
  } else {
  await page.locator('.entry-background img').first().waitFor({ state: 'attached' });
  await artReady();
  await page.locator('.entry-voyage-ready').waitFor({timeout:60000});
  await page.locator('#show-menu').evaluate(node => node.style.display = 'none');
  assert.equal(await page.locator('.entry-avatar').count(),0,'first login must not invent a player');
  assert.equal(await page.locator('.voyage-canvas').count(),1);
  if(process.argv.includes('--screenshot-fixes-only')) {
    const { checkScreenshotFixes } = await import('./voyage.screenshot-fixes.check.mjs');
    await checkScreenshotFixes(page, output, errors);
  } else if(process.argv.includes('--mast-only')) {
    const {captureMastLinks}=await import('./voyage.details.check.mjs');
    await captureMastLinks(page,output);
  } else if(process.argv.includes('--details-only')) {
    const {checkVoyageDetails}=await import('./voyage.details.check.mjs');
    await checkVoyageDetails(page,output,errors);
  } else if(process.argv.includes('--model-only')) {
    const {captureVoyageModel}=await import('./voyage.model.check.mjs');
    await captureVoyageModel(page,output,errors);
  } else if(process.argv.includes('--correction-only')) {
    const {checkVoyageCorrection}=await import('./voyage.correction.check.mjs');
    await checkVoyageCorrection(page,output,errors);
  } else if(process.argv.includes('--reference-only')) {
    const {checkVoyageReference}=await import('./voyage.reference.check.mjs');
    await checkVoyageReference(page,output,errors);
  } else if(process.argv.includes('--route-only')) {
    const {checkVoyageRoute}=await import('./voyage.route.check.mjs');
    await checkVoyageRoute(page,output,errors);
  } else if(process.argv.includes('--camera-motion-only')) {
    const {checkVoyageCameraMotion}=await import('./voyage.camera-motion.check.mjs');
    await checkVoyageCameraMotion(page,output,errors);
  } else if(process.argv.includes('--polish-only')) {
    const {checkVoyagePolish}=await import('./voyage.polish.check.mjs');
    await checkVoyagePolish(page,output,errors);
  } else if(process.argv.includes('--cabin-mask-only')) {
    const {checkCabinMask}=await import('./voyage.cabin-mask.check.mjs');
    await checkCabinMask(page,output,errors);
  } else if(process.argv.includes('--visual-only')) {
    const {captureVoyageVisuals}=await import('./voyage.visual.check.mjs');
    await captureVoyageVisuals(page,output,errors);
    assert.deepEqual(errors,[]);
  } else {
  if(!process.argv.includes('--deck-only')) await capture('login-desktop.png');
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
  assert(Math.abs(beforeWalk.position[1]-5.505)<.00001, 'feet stand on the authored main deck surface');
  assert(beforeWalk.cameraFacing<.00001, 'passenger keeps the complete camera-facing foot plane');
  await page.evaluate(()=>{ const v=window.__entry.voyage; window.__renderClouds=v.clouds.render.bind(v.clouds); v.clouds.render=()=>{}; });
  await page.keyboard.down('ArrowRight');
  await page.waitForFunction(() => window.__entry.voyage.deck.moving, null, {timeout:10000});
  assert.equal((await deckState()).action,'walk');
  await page.waitForFunction(start => Math.hypot(...[0,2].map(i=>window.__entry.voyage.deck.position.toArray()[i]-start[i]))>.35, beforeWalk.position);
  await page.keyboard.up('ArrowRight');
  await page.waitForFunction(() => !window.__entry.voyage.passengers.deckMoving);
  assert.equal((await deckState()).action,'stand');
  const stopped = (await deckState()).position;
  await page.keyboard.press('Space');await page.waitForFunction(()=>window.__entry.voyage.deck.jumping && window.__entry.voyage.passengerAction("preview-swap")==="jump");
  assert.equal((await deckState()).action,'jump');await page.waitForFunction(()=>!window.__entry.voyage.deck.jumping);
  assert(Math.abs((await deckState()).position[1]-stopped[1])<.0001,'jump lands on the same actual floor');
  const ringStart=await page.evaluate(()=>window.__entry.voyage.deck.routeDistance);
  await page.keyboard.down('ArrowLeft');
  try { await page.waitForFunction(start=>window.__entry.voyage.deck.routeDistance>start+86.1,ringStart,{timeout:90000}); }
  finally { await page.keyboard.up('ArrowLeft'); }
  assert(await page.evaluate(()=>{const d=window.__entry.voyage.deck;return Math.hypot(d.position.x-d.routePoint(d.position).x,d.position.z-d.routePoint(d.position).z)<.00001;}),'one held key walks the entire real deck loop through every bend');
  console.log('Closed deck loop completed with one continuously held key');
  assert.equal(selections,0,'walking never selects a world session');
  await page.keyboard.down('KeyA'); await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  assert.equal((await deckState()).keys,0,'losing focus clears all held movement'); await page.keyboard.up('KeyA');
  await page.evaluate(()=>{const v=window.__entry.voyage;v.clouds.render=window.__renderClouds;v.updateActivity();});
  await capture('channel-desktop.png');
  if(!process.argv.includes('--deck-only')) {
    const zoom=await page.evaluate(()=>window.__entry.voyage.zoom);await page.mouse.move(450,300);await page.mouse.wheel(0,80);assert((await page.evaluate(()=>window.__entry.voyage.zoom))>zoom);
    const pitch=await page.evaluate(()=>window.__entry.voyage.pitch);await page.mouse.move(450,300);await page.mouse.down({button:'right'});await page.mouse.move(450,340);await page.mouse.up({button:'right'});assert((await page.evaluate(()=>window.__entry.voyage.pitch))>pitch);
    await page.evaluate(()=>{const v=window.__entry.voyage;v.pitch=.24;v.yaw=0;v.zoom=1.2;v.deck.reset();v.entranceArmed=true;v.updateActivity();});
    await page.evaluate(()=>{const v=window.__entry.voyage;window.__routeClouds=v.clouds.render;v.clouds.render=()=>{};v.updateActivity();});
    // Walk freely across the real main deck toward the cabin portal. The
    // perpendicular starboard camera maps screen-left to aft, up to inboard.
    const walkUntil = async (codes, predicate) => {
      const held = Array.isArray(codes) ? codes : [codes];
      for (const code of held) await page.keyboard.down(code);
      try { await page.waitForFunction(predicate, undefined, { timeout: 12000 }); }
      finally { for (const code of held) await page.keyboard.up(code); }
    };
    await walkUntil('ArrowLeft', () => window.__entry.voyage.deck.position.z > 13.20);
    await page.waitForFunction(() => window.__entry.voyage.nearInteraction === 'enter-cabin', undefined, { timeout: 8000 });
    await page.keyboard.up('ArrowDown'); await page.keyboard.up('ArrowRight'); await page.keyboard.up('ArrowLeft');
    await page.evaluate(()=>{const v=window.__entry.voyage;v.updateActivity();});
    assert.equal(await page.locator('.entry-stage-channel').count(),1,'reaching the real portal does not auto-enter');
    await page.keyboard.press('Space');await page.locator('.entry-stage-characters').waitFor();console.log('Real portal entered with Space');
    assert(await page.evaluate(()=>{const v=window.__entry.voyage,p=v.model.getObjectByName('SV3_CaptainPortal_Original2D');return p.parent.name==='SV3_Exterior'&&!p.parent.visible;}),'exterior portal disappears with the exterior shell');
    assert.equal(selections,0,'walking to the real portal only arms the cabin interaction');
    await page.evaluate(()=>{const v=window.__entry.voyage;v.passengers.finishWake();v.updateActivity();});
    const cabinBefore=await page.evaluate(()=>window.__entry.voyage.cabinDeck.position.toArray());
    await page.keyboard.down('ArrowLeft');await page.waitForFunction(p=>window.__entry.voyage.cabinDeck.position.distanceTo(window.__entry.voyage.cabinDeck.spawn.clone().fromArray(p))>.3,cabinBefore);await page.keyboard.up('ArrowLeft');
    assert((await page.evaluate(()=>window.__entry.voyage.cabinDeck.position.x))<cabinBefore[0]-.3,'left input works immediately at the cabin arrival');
    const leftFoot=await page.evaluate(()=>window.__entry.voyage.cabinDeck.position.x);
    await page.keyboard.down('ArrowRight');await page.waitForFunction(x=>window.__entry.voyage.cabinDeck.position.x>x+.3,leftFoot);await page.keyboard.up('ArrowRight');
    assert.equal(await page.locator('[data-select]').count(),0,'remote bed clicks cannot select a character');
    await page.evaluate(()=>{const v=window.__entry.voyage,p=v.ship.worldToLocal(v.model.getObjectByName('SV2_Bed_1_FootAnchor').getWorldPosition(v.camera.position.clone())).add(v.camera.position.clone().set(0,0,.6));p.y=.025;v.cabinDeck.place(p);v.passengers.finishWake();v.updateActivity();});
    await page.waitForFunction(()=>window.__entry.voyage.nearInteraction==='role-details' && window.__entry.voyage.nearbyCharacterId==='passenger-0',null,{timeout:10000});
    assert.equal(await page.evaluate(()=>window.__entry.selected),'preview-swap','approaching a different bed does not select it');
    await page.keyboard.press('Space');await page.waitForFunction(()=>window.__entry.selected==='passenger-0');
    assert.equal(await page.evaluate(()=>window.__entry.selected),'passenger-0');
    await page.locator('.voyage-role-details').waitFor({state:'visible'});
    await page.locator('[data-action="close-role"]').click();
    await page.evaluate(()=>{const v=window.__entry.voyage,p=v.ship.worldToLocal(v.model.getObjectByName('SV2_Bed_0_FootAnchor').getWorldPosition(v.camera.position.clone())).add(v.camera.position.clone().set(0,0,.6));p.y=.025;v.cabinDeck.place(p);v.passengers.finishWake();v.updateActivity();});
    await page.waitForFunction(()=>window.__entry.voyage.nearInteraction==='role-details' && window.__entry.voyage.nearbyCharacterId==='preview-swap');
    assert.equal(await page.evaluate(()=>window.__entry.voyage.roleDetailOpen),false,'near an occupied bed alone does not open the paper');
    assert.equal(await page.locator('.voyage-role-details').evaluate(node=>getComputedStyle(node).visibility),'hidden','near an occupied bed keeps the paper hidden');
    await page.keyboard.press('Space');await page.waitForFunction(()=>window.__entry.voyage.roleDetailOpen);await page.waitForTimeout(160);await capture('role-paper-unfolding.png');await page.locator('.voyage-role-details').waitFor({state:'visible',timeout:12000}).catch(async error => { console.log('Paper state',await page.evaluate(()=>{const v=window.__entry.voyage,e=document.querySelector('.voyage-role-details');return{stage:v.stage,open:v.roleDetailOpen,progress:v.rolePaper.progress,surface:v.rolePaper.open,group:v.rolePaper.group.visible,style:e.style.cssText,size:[e.offsetWidth,e.offsetHeight],camera:v.camera.position.toArray(),aim:v.aim.toArray(),foot:v.cabinDeck.position.toArray(),near:v.nearInteraction};}));throw error; });await capture('role-paper-final.png');
    const roleFoot = await page.evaluate(()=>window.__entry.voyage.cabinDeck.position.toArray());
    await page.locator('[data-action="close-role"]').click();
    assert.equal(await page.evaluate(()=>window.__entry.voyage.roleDetailOpen),false);
    await page.waitForFunction(()=>!window.__entry.voyage.rolePaper.group.visible);
    assert.equal(await page.evaluate(()=>window.__entry.voyage.rolePaper.group.visible),false,'closing removes the old parchment mesh');
    assert.deepEqual(await page.evaluate(()=>window.__entry.voyage.cabinDeck.position.toArray()),roleFoot,'closing details preserves the aisle position');
    await page.evaluate(()=>{const v=window.__entry.voyage,p=v.ship.worldToLocal(v.model.getObjectByName('SV2_Bed_5_FootAnchor').getWorldPosition(v.camera.position.clone())).add(v.camera.position.clone().set(0,0,.6));p.y=.025;v.cabinDeck.place(p);v.passengers.finishWake();v.updateActivity();});
    await page.waitForFunction(()=>window.__entry.voyage.nearInteraction==='create-character');await page.keyboard.press('Space');await page.locator('#create-character').waitFor();await page.waitForTimeout(160);await capture('create-paper-unfolding.png');console.log('Empty bed opened form with Space');
    assert.equal(creations,0,'approaching an empty bed opens the existing form without creating anything');
    await page.locator('#character-name').waitFor({state:'visible'});
    const cancelFoot=await page.evaluate(()=>window.__entry.voyage.cabinDeck.position.toArray());
    await page.locator('[data-action="cancel-create"]').click();
    await page.locator('.entry-stage-characters').waitFor();
    assert.deepEqual(await page.evaluate(()=>window.__entry.voyage.cabinDeck.position.toArray()),cancelFoot,'cancel returns to the same aisle position');
    await page.waitForFunction(()=>!window.__entry.voyage.createPaper.group.visible);
    assert.equal(await page.evaluate(()=>window.__entry.voyage.createPaper.group.visible),false,'cancel removes the old parchment mesh');
    await page.waitForFunction(()=>window.__entry.voyage.nearInteraction==='create-character');
    await page.keyboard.press('Space');await page.locator('#character-name').waitFor({state:'visible'});
    await page.locator('#character-name').focus();await page.keyboard.press('Space');
    assert.deepEqual(await page.evaluate(()=>window.__entry.voyage.cabinDeck.position.toArray()),cancelFoot,'text input Space never moves the world');
    await capture('create-paper-final.png');const createFoot=await page.evaluate(()=>window.__entry.voyage.cabinDeck.position.toArray());await page.locator('#character-name').fill('冒险自检');await page.locator('#create-character button[type="submit"]').click();await page.locator('.entry-stage-characters').waitFor();assert.equal(creations,1);assert.equal(selections,0);assert.deepEqual(await page.evaluate(()=>window.__entry.voyage.cabinDeck.position.toArray()),createFoot,'creation returns to the same bed-side aisle position');
    await page.evaluate(()=>{const v=window.__entry.voyage;v.cabinDeck.place(v.cabinDeck.position.clone().set(0,0,45.3));v.passengers.finishWake();v.exitArmed=true;v.updateActivity();});
    await page.evaluate(()=>{const v=window.__entry.voyage,p=v.ship.worldToLocal(v.model.getObjectByName('SV3_CabinDeckPortal').getWorldPosition(v.camera.position.clone()));p.y=.025;v.cabinDeck.place(p);v.passengers.finishWake();v.updateActivity();});await page.waitForFunction(()=>window.__entry.voyage.nearInteraction==='return-deck');await page.keyboard.press('Space');await page.locator('.entry-stage-channel').waitFor();console.log('Cabin portal returned to deck with Space');
    assert.equal(await page.evaluate(() => { const v=window.__entry.voyage; return Boolean(v.model.getObjectByName('SV3_CaptainFloor')?.visible || v.model.getObjectByName('SV3_CaptainDoorThreshold')?.visible); }), false, 'former walk-in room floor and threshold are removed');
    assert.equal(await page.evaluate(() => window.__entry.voyage.ship.getObjectByName('SV3_CaptainDoorSeal').visible), true);
    await page.keyboard.down('ArrowUp');
    await page.waitForTimeout(500); await page.keyboard.up('ArrowUp');
    assert(await page.evaluate(() => { const d=window.__entry.voyage.deck; return Math.abs(d.position.x-6.5)<.00001 && Math.abs(d.position.y-5.505)<.00001 && d.canStand(d.position,5.48); }), 'perpendicular input cannot leave the deck loop or cross the cabin wall');
    assert(await page.evaluate(()=>{const v=window.__entry.voyage,p=v.model.getObjectByName('SV3_CaptainPortal_Original2D'),a=v.ship.worldToLocal(v.model.getObjectByName('SV3_CaptainPortal').getWorldPosition(v.camera.position.clone())),bottom=p.getWorldPosition(v.camera.position.clone());bottom.y-=p.geometry.parameters.height*p.getWorldScale(bottom.clone()).y/2;const local=v.ship.worldToLocal(bottom);return Math.abs(local.y-a.y-.035)<.00001&&p.rotation.x===0&&p.rotation.z===0&&Math.abs(p.geometry.parameters.height*p.getWorldScale(bottom.clone()).y-2.8)<.00001;}),'portal bottom stays on the floor with yaw-only facing and original world height');
    await capture('deck-exterior.png');
    const transmission=await page.evaluate(()=>{const v=window.__entry.voyage;const mats=[];v.model.traverse(o=>{for(const m of o.material?Array.isArray(o.material)?o.material:[o.material]:[]){if(m.name==='SV3_Prototype_SapphireGlass')mats.push({physical:m.isMeshPhysicalMaterial,transmission:m.transmission,ior:m.ior});}});document.querySelector('.entry-scene').style.visibility='hidden';v.camera.position.set(18,8.3,-21.2);v.camera.lookAt(10.8,8.15,-21.2);v.camera.updateMatrixWorld(true);v.clouds.render(v.renderer,v.scene,v.camera,v.sun);return mats;});
    assert(transmission.length&&transmission.every(m=>m.physical&&m.transmission>.93&&m.ior>1.45));await capture('sapphire-transmission.png');
    await page.evaluate(()=>{document.querySelector('.entry-scene').style.visibility='';window.__entry.voyage.updateActivity();});
    await page.locator('.voyage-adventure:visible,.voyage-start-adventure:visible').click();await page.locator('#entered').waitFor({state:'visible'});assert.equal(selections,1);
    const cameraRay=await page.evaluate(()=>{const a=window.__cameraRayTimes.sort((a,b)=>a-b);return{samples:a.length,medianMs:a[Math.floor(a.length*.5)],p95Ms:a[Math.floor(a.length*.95)],maxMs:a.at(-1)};});assert.deepEqual(errors,[]);await fs.writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,mode:'offline production WebGL and local cabin lifecycle; in-memory account replies',transmission,cameraRay,selections,creations,errors},null,2));console.log('Camera collision ray CPU:',JSON.stringify(cameraRay));console.log('Production ship/cabin walking, jump, camera, empty-bed creation, return and physical transmission passed');
  } else { assert.deepEqual(errors,[]); await fs.writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,mode:'offline lobby geometry and keyboard input',beforeWalk,stopped,selections,errors},null,2)); console.log('Lobby upright feet, walking, skill isolation and blur checks passed'); }
  }
  }
} catch (error) { const state=await page.evaluate(()=>{const e=window.__entry,v=e?.voyage;return{entryStage:e?.stage,busy:e?.busy,stage:v?.stage,cabinShown:v?.cabinShown,transition:v?.transition,reduced:v?.reduced.matches,host:v?.host.className,hidden:v?.host.hidden,previous:v?.previous,now:performance.now()};}).catch(()=>undefined);console.error('Browser diagnostics:',JSON.stringify({errors,consoleErrors,state})); throw error; } finally { await browser.close(); }
