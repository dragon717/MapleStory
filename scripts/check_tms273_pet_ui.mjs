// Offline pet/HUD component regression: real source art, no game server or account.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { evidencePath } from './evidence-path.cjs';
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'client/package.json'));

export async function checkPetPanel(page, output = evidencePath('pet-refactor')) {
  await fs.mkdir(output, { recursive: true });
  await require('esbuild').build({ stdin: { contents: `
import { PetPanel } from './src/features/pet/panel';
import { HudView } from './src/features/hud/view';
import './src/app/style.css';
import './src/features/hud/style.css';
const manifest = await (await fetch('/assets/manifest.json')).json();
window.sent = [];
window.player = {id:'offline',username:'离线冒险者',hp:50,maxHp:50,mp:5,maxMp:5,level:2,exp:4,expToNext:60,mesos:0,inventory:[{slot:1,itemId:'5000000',quantity:1},{slot:2,itemId:'5000001',quantity:1},{slot:3,itemId:'5000021',quantity:1}],action:'stand',pets:[{id:'p1',itemId:'5000000',name:'褐色小貓',inventorySlot:1,x:0,y:0,facing:1,action:'move',baseSpeed:120,moveSpeed:240,mode:'loot'},{id:'p2',itemId:'5000001',name:'褐色小狗',inventorySlot:2,x:0,y:0,facing:1,action:'move',baseSpeed:180,moveSpeed:170,mode:'follow'}]};
window.panel = new PetPanel(document.querySelector('#ui-windows'), manifest, ()=>{}, message=>{window.sent.push(message);return true;});
window.hud = new HudView(document.querySelector('#hud'), manifest, ()=>{}, undefined, undefined, undefined, {openPets:()=>window.panel.toggle()});
window.panel.update(window.player); window.hud.update(window.player);
window.layoutObserver = new ResizeObserver(()=>document.querySelector('#game-shell').style.setProperty('--hud-height',document.querySelector('#hud').getBoundingClientRect().height+'px'));
window.layoutObserver.observe(document.querySelector('#hud'));
`, resolveDir: path.join(root, 'client'), loader: 'ts' }, bundle: true, format: 'esm', outfile: path.join(output, 'check.js'), logLevel: 'silent' });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.unrouteAll();
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    assert.equal(url.hostname, 'pet.test');
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/check.css"><body class="game-mode"><div id="game-shell" style="position:fixed;inset:0;background:#81978e"><div id="game" tabindex="0"></div><div id="ui-windows"></div><div id="hud"></div></div><script type="module" src="/check.js"></script>' });
    const file = url.pathname.startsWith('/assets/') ? path.join(root, 'client/public-tms273', decodeURIComponent(url.pathname)) : path.join(output, path.basename(url.pathname));
    await route.fulfill({ body: await fs.readFile(file), contentType: ({'.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png'})[path.extname(file)] || 'application/octet-stream' });
  });
  await page.goto('http://pet.test/');
  await page.waitForFunction(() => window.panel && window.hud);
  const measurements = [];
  for (const [width, height] of [[1440,900],[844,390],[390,844],[320,568]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => window.panel.close());
    await page.waitForFunction(() => Math.abs(parseFloat(document.querySelector('#game-shell').style.getPropertyValue('--hud-height')) - document.querySelector('#hud').getBoundingClientRect().height) < 1);
    const entry = page.getByRole('button', { name: '宠物', exact: true });
    assert(await entry.isVisible(), `pet menu entry must be visible at ${width}x${height}`);
    await entry.click({ timeout: 3000 });
    await page.locator('.pet-tab[data-slot="2"]').click({ timeout: 3000 });
    assert.equal(await page.locator('.pet-tab.is-selected').getAttribute('data-slot'), '2');
    await page.locator('.pet-tab[data-slot="0"]').click({ timeout: 3000 });
    await page.evaluate(() => Promise.all([...document.images].filter(image => image.getAttribute('src')).map(image => image.decode())));
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert(await page.locator('.pet-source-preview').isVisible(), 'selected pet must appear in the source portrait');
    const layout = await page.evaluate(() => {
      const panel = document.querySelector('.pet-window');
      const box = panel.getBoundingClientRect();
      return { width: innerWidth, height: innerHeight, x: box.x, y: box.y, right: box.right, bottom: box.bottom, hudTop: document.querySelector('#hud').getBoundingClientRect().top, sourceHeight: document.querySelector('.pet-source-panel').getBoundingClientRect().height, overflow: panel.scrollWidth > panel.clientWidth, pageOverflow: document.documentElement.scrollWidth > innerWidth, tabs: [...document.querySelectorAll('.pet-tab')].map(tab => tab.getBoundingClientRect().x) };
    });
    assert.equal(layout.sourceHeight, 196, 'source panel keeps its authored height on narrow screens');
    assert(layout.bottom <= layout.hudTop + 1, `pet window must leave HP/MP and the menu visible: ${JSON.stringify(layout)}`);
    assert(!layout.overflow && !layout.pageOverflow, JSON.stringify(layout));
    assert(layout.x >= 0 && layout.y >= 0 && layout.right <= width + 1 && layout.bottom <= height + 1, JSON.stringify(layout));
    assert(new Set(layout.tabs).size === 3, 'three source tabs cannot overlap');
    measurements.push(layout);
    await page.screenshot({ path: path.join(output, `pet-${width}x${height}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const dragBox = await page.locator('.pet-window').boundingBox();
  await page.mouse.move(dragBox.x + 8, dragBox.y + 8);
  await page.mouse.down();
  await page.mouse.move(1430, 890, { steps: 5 });
  await page.mouse.up();
  assert(await page.evaluate(() => document.querySelector('.pet-window').getBoundingClientRect().bottom <= document.querySelector('#hud').getBoundingClientRect().top + 1), 'dragging cannot cover HUD');
  await page.setViewportSize({ width: 320, height: 568 });
  await page.waitForFunction(() => !document.querySelector('.pet-window').dataset.windowPositioned);
  assert(await page.evaluate(() => document.querySelector('.pet-window').getBoundingClientRect().right <= innerWidth), 'resize recovers a dragged window');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.pet-owned-action').first().focus();
  assert(await page.evaluate(() => {
    const button = document.activeElement;
    for (let i = 0; i < 30; i++) {
      window.player.pets[0].moveSpeed = 230 + i;
      window.panel.update(window.player);
    }
    return document.activeElement === button && button.isConnected;
  }), 'snapshot ticks must preserve the focused action button');
  await page.locator('.pet-owned-action').first().click();
  const intent = await page.evaluate(() => window.sent.at(-1));
  assert.equal(intent.type, 'useItem');
  assert.equal(intent.inventoryType, 5);
  assert.equal(intent.sourceSlot, 1);
  assert.equal(intent.itemId, '5000000');
  await page.keyboard.press('Escape');
  assert(!(await page.locator('.pet-window').isVisible()));
  await page.evaluate(() => {window.player.pets = []; window.player.inventory = []; window.panel.update(window.player); window.panel.open();});
  assert.match(await page.locator('.pet-owned-list').innerText(), /没有可用宠物/);
  assert.deepEqual(errors, []);
  await page.evaluate(() => {window.panel.destroy(); window.hud.destroy(); window.layoutObserver.disconnect();});
  assert.equal(await page.locator('.pet-window').count(), 0);
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, measurements, intent, errors }, null, 2) + '\n', 'utf8');
  return { passed: true, output, viewports: measurements.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const installed = (await fs.readdir(cache)).filter(name => name.startsWith('chromium_headless_shell-')).sort((a,b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)))[0];
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || path.join(cache, installed, 'chrome-headless-shell-mac-arm64/chrome-headless-shell') });
  try { console.log(JSON.stringify(await checkPetPanel(await browser.newPage()))); }
  finally { await browser.close(); }
}
