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
const output = path.join(root, 'evidence/2026-09-08/entry-ui');
await fs.mkdir(output, { recursive: true });
await build({ stdin: { contents: `import './src/app/style.css'; import { EntryView } from './src/features/entry/view'; import { MenuView } from './src/features/menu/view'; const entry = new EntryView(document.getElementById('welcome'), async session => { document.getElementById('entered').textContent=session.username; }); document.getElementById('show-menu').onclick=async()=>{const manifest=await fetch('/assets/manifest.json').then(r=>r.json()); const menu=new MenuView(document.getElementById('menu-host'),manifest,message=>document.getElementById('entered').textContent=message,()=>document.getElementById('entered').textContent='inventory'); menu.open('game');};`, resolveDir: path.join(root, 'client'), loader: 'ts' }, bundle: true, format: 'esm', outfile: path.join(output, 'entry-check.js'), logLevel: 'silent' });
const browserCache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = (await fs.readdir(browserCache)).filter(name=>name.startsWith('chromium_headless_shell-')).sort((a,b)=>Number(b.split('-').at(-1))-Number(a.split('-').at(-1)))[0];
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (installed && path.join(browserCache, installed, 'chrome-headless-shell-mac-arm64/chrome-headless-shell'));
const browser = await chromium.launch({ headless: true, executablePath });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'client/public-tms273/assets/manifest.json'), 'utf8'));
// The handshake constants must match shared/protocol.ts, or authenticate()
// refuses the stub session exactly like it refuses an outdated server.
const sharedProtocol = await fs.readFile(path.join(root, 'shared/protocol.ts'), 'utf8');
const protocolVersion = Number(sharedProtocol.match(/PROTOCOL_VERSION = (\d+)/)?.[1]);
const contentVersion = sharedProtocol.match(/CONTENT_VERSION = '([^']+)'/)?.[1];
assert(protocolVersion > 0 && Boolean(contentVersion), 'shared protocol constants must be parseable');
const accountSession = { token: 'account-token', playerId: 'account-id', username: 'entry_check', protocolVersion, contentVersion };
let characters = [];
let creations = 0;
// A character whose current equipped rows differ from the frozen creation
// look: the selection/quick-start paper doll must render the equipped items
// (cap 1002067, coat 1040002), not the creation longcoat 1050286.
const swapCharacter = { id: 'preview-swap', name: '换装自检', level: 5, job: 0, appearance: { gender: 0, face: 20100, hair: 30000, skin: 0, coat: 1050286, pants: 0, shoes: 1072833, weapon: 1302000 }, equipped: [{ slot: 1, itemId: '1002067', quantity: 1 }, { slot: 5, itemId: '1040002', quantity: 1 }, { slot: 7, itemId: '1072833', quantity: 1 }, { slot: 11, itemId: '1302000', quantity: 1 }] };
characters.push(swapCharacter);
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
    if (request.action === 'create') { creations++; const look = request.appearance; const character = { id: String(creations).padStart(64, '0'), name: request.name, appearance: look, level: 1, job: 0, equipped: [[5, look.coat], [6, look.pants], [7, look.shoes], [11, look.weapon]].filter(([, itemId]) => itemId).map(([slot, itemId]) => ({ slot, itemId, quantity: 1 })) }; characters.push(character); return route.fulfill({ json: { character } }); }
    if (request.action === 'select') { const character = characters.find(item => item.id === request.characterId); assert(character); assert.equal(request.channelId, 1); return route.fulfill({ json: { ...accountSession, token: 'character-token', playerId: character.id, username: character.name } }); }
    throw new Error(`Unknown action ${request.action}`);
  }
  const file = url.pathname.startsWith('/assets/') ? path.join(root, 'client/public-tms273', decodeURIComponent(url.pathname)) : path.join(output, path.basename(url.pathname));
  try { const body = await fs.readFile(file); const ext = path.extname(file); return route.fulfill({ body, contentType: ({ '.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg' })[ext] ?? 'application/octet-stream' }); }
  catch { return route.fulfill({ status: 404, body: 'missing test resource' }); }
});
const artReady = () => page.waitForFunction(() => [...document.querySelectorAll('.entry-background img,.entry-avatar img,.maple-menu img')].every(img => img.complete && img.naturalWidth > 0));
try {
  await page.goto('http://entry.test/');
  await page.locator('.entry-background img').first().waitFor();
  await artReady();
  await page.screenshot({ path: path.join(output, 'login-desktop.png') });
  await page.locator('#username').fill('entry_check');
  await page.locator('#password').fill('entry-check-password');
  await page.locator('#submit').click();
  await page.locator('.entry-channel-button').waitFor();
  assert.equal(await page.locator('.entry-channel-button').count(), 1);
  await artReady();
  const quickAvatar = page.locator('.entry-quick .entry-avatar');
  assert(await quickAvatar.locator('img[src*="01002067"]').count() > 0, 'quick-start preview must render the equipped cap');
  assert(await quickAvatar.locator('img[src*="01040002"]').count() > 0, 'quick-start preview must render the equipped coat');
  assert.equal(await quickAvatar.locator('img[src*="01050286"]').count(), 0, 'quick-start preview must not fall back to the creation longcoat');
  await page.screenshot({ path: path.join(output, 'channel-desktop.png') });
  await page.locator('[data-action="channel"]').click();
  await artReady();
  const swapAvatar = page.locator('[data-character="preview-swap"]');
  assert(await swapAvatar.locator('img[src*="01002067"]').count() > 0, 'selection preview must render the equipped cap');
  assert(await swapAvatar.locator('img[src*="01040002"]').count() > 0, 'selection preview must render the equipped coat');
  assert.equal(await swapAvatar.locator('img[src*="01050286"]').count(), 0, 'selection preview must not fall back to the creation longcoat');
  await page.screenshot({ path: path.join(output, 'characters-empty-desktop.png') });
  await page.locator('[data-action="create"]').first().click();
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
    fit.push({ size, ...metrics });
    await artReady();
  await page.screenshot({ path: path.join(output, `create-${size.width}x${size.height}.png`), fullPage: true });
  }
  await page.locator('#create-character button[type="submit"]').click();
  await page.locator('[data-select].selected').waitFor();
  assert.equal(creations, 1);
  await artReady();
  await page.screenshot({ path: path.join(output, 'characters-desktop.png') });
  await page.locator('[data-action="enter"]').click();
  await page.locator('#entered').filter({ hasText: '冒险自检' }).waitFor();
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
} finally { await browser.close(); }
