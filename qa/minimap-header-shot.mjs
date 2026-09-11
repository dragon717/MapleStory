// Capture the repaired minimap header from the REAL game shell.
//
// `minimap-buttons-probe.mjs` presses the four controls; this one is the
// presentation twin: it boots the same real `app/main.ts` (real CSS, real
// Phaser, only the network boundary stubbed), forces the full window, reads the
// header out of the live DOM and writes tight, annotation-free crops so the
// corner can be inspected without an image viewer.
//
// Run: node qa/minimap-header-shot.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const root = path.resolve(import.meta.dirname, '..');
const requireClient = createRequire(path.join(root, 'client', 'package.json'));
const { build } = requireClient('esbuild');
const { chromium } = requireClient('/Users/muniao/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const client = path.join(root, 'client');
const output = path.join(root, 'output/playwright/minimap-header');
const deliver = path.join(root, 'output/minimap-fix');
await fs.mkdir(output, { recursive: true });
await fs.mkdir(deliver, { recursive: true });

const source = await fs.readFile(path.join(client, 'src/app/main.ts'), 'utf8');
await build({
  stdin: {
    contents: source + '\nObject.assign(window, {check: {getWorld: () => world, getMiniMap: () => miniMap}});',
    resolveDir: path.join(client, 'src/app'),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  outfile: path.join(output, 'check.js'),
  define: { __RELEASE_VERSION__: '"probe"', __RELEASE_TIME__: '"2026-09-12"' },
  logLevel: 'silent',
  plugins: [{
    name: 'offline-boundaries',
    setup(b) {
      b.onResolve({ filter: /network\/session$/ }, () => ({ path: 'session', namespace: 'offline' }));
      b.onResolve({ filter: /^\.\/api$/ }, args => args.resolveDir.endsWith('features/entry') ? ({ path: 'entry-api', namespace: 'offline' }) : undefined);
      b.onLoad({ filter: /.*/, namespace: 'offline' }, ({ path: p }) => ({ loader: 'js', contents: p === 'session' ? `
const TICK_MS = 50;
export async function authenticate(username, password, register) {
  return { token: 'probe-token', username, playerId: 'c1', protocolVersion: 13, contentVersion: 'tms273-9' };
}
export class Connection {
  constructor(session, message, state) { this.message = message; this.state = state; this.tick = 0; }
  connect() {
    this.state('connecting');
    setTimeout(() => {
      const w = window.check?.getWorld?.();
      const bounds = w?.manifest?.map?.bounds ?? { xMin: 0, xMax: 100, yMin: 0, yMax: 100 };
      const cx = (bounds.xMin + bounds.xMax) / 2;
      const cy = (bounds.yMin + bounds.yMax) / 2;
      const mapId = w ? w.mapId : '000010000';
      this.state('online');
      this.timer = setInterval(() => {
        this.tick += 1;
        const drift = Math.sin(this.tick / 8) * 6;
        window.player = { id: 'c1', username: '探针角色', x: cx + drift, y: cy, vx: 0, vy: 0, facing: 1, grounded: true, action: 'stand', actionId: null, actionStartedTick: 0, lastInputSeq: 0, climbing: false, ladderId: null, hp: 50, maxHp: 100, mp: 40, maxMp: 80, level: 10, exp: 25, expToNext: 100, mesos: 100, inventory: [], equipped: [] };
        this.message({
          type: 'snapshot', mapId, selfId: 'c1',
          players: [window.player], monsters: [], drops: [],
          serverTick: this.tick, tickMs: TICK_MS,
          npcs: [
            { id: 'n1', name: 'Heena', nameZh: '希娜', x: cx - 60, y: cy, facing: 1 },
            { id: 'n2', name: 'Roger', nameZh: '罗杰', x: cx + 60, y: cy, facing: -1 },
          ],
          portals: [
            { name: 'west00', x: bounds.xMin + 10, y: cy, targetMapId: mapId },
            { name: 'east00', x: bounds.xMax - 10, y: cy, targetMapId: mapId },
          ],
        });
      }, TICK_MS);
    }, 300);
  }
  close() { clearInterval(this.timer); }
  send() { return true; }
}` : `
export async function lobbyRequest(session, action, fields = {}) {
  if (action === 'list') return { characters: [{ id: 'c1', name: '探针角色', level: 10, job: 0, appearance: { gender: 0, skin: 2000, face: 20000, hair: 30000, coat: 1040002, pants: 1060002, shoes: 1072001, weapon: 1302000 } }], slotLimit: 12, channelId: 1 };
  if (action === 'select') return { token: session.token, username: session.username, playerId: 'c1', protocolVersion: 13, contentVersion: 'tms273-9' };
  throw new Error('unexpected lobby action ' + action);
}` }));
    },
  }],
});

const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = (await fs.readdir(cache)).filter(n => n.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)))[0];
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || path.join(cache, installed, 'chrome-headless-shell-mac-arm64/chrome-headless-shell') });
const page = await browser.newPage({ viewport: { width: 1100, height: 820 }, deviceScaleFactor: 2 });
page.on('pageerror', e => console.error('[pageerror]', String(e)));
await page.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.hostname !== 'minimap-header.test') return route.abort();
  if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/check.css"><div id="app"></div><script type="module" src="/check.js"></script>' });
  const file = url.pathname.startsWith('/assets/') ? path.join(client, 'public-tms273', decodeURIComponent(url.pathname)) : path.join(output, path.basename(url.pathname));
  try {
    return route.fulfill({ body: await fs.readFile(file), contentType: ({ '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.mp3': 'audio/mpeg' })[path.extname(file)] || 'application/octet-stream' });
  } catch { return route.fulfill({ status: 404, body: 'missing' }); }
});

// What the header is actually made of, straight out of the live DOM.
const header = () => page.evaluate(() => {
  const root = document.querySelector('.tms-minimap');
  const windowBox = root?.querySelector('.tms-minimap-window');
  const mark = root?.querySelector('.tms-minimap-mark');
  const badge = mark && mark.style.display !== 'none' ? mark.getBoundingClientRect() : null;
  const windowRect = windowBox?.getBoundingClientRect();
  const local = node => {
    if (!node || !windowRect) return null;
    const r = node.getBoundingClientRect();
    return { x: Math.round(r.x - windowRect.x), y: Math.round(r.y - windowRect.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  return {
    mode: root?.dataset.mode,
    window: windowRect ? { x: Math.round(windowRect.x), y: Math.round(windowRect.y), w: Math.round(windowRect.width), h: Math.round(windowRect.height) } : null,
    // The black `MaxMap/nw2` "MINI MAP" card must resolve to no background.
    nw2: getComputedStyle(root).getPropertyValue('--minimap-nw2').trim(),
    nw2x: getComputedStyle(root).getPropertyValue('--minimap-nw2-x').trim(),
    backgroundImage: getComputedStyle(windowBox).backgroundImage,
    badge: badge ? { src: mark.getAttribute('src'), ...local(mark) } : null,
    streets: [...(root?.querySelectorAll('.tms-minimap-street') ?? [])].map(n => n.textContent),
    names: [...(root?.querySelectorAll('.tms-minimap-name') ?? [])].map(n => n.textContent),
    nameBox: local(root?.querySelector('.tms-minimap-street')) ?? null,
    buttons: [...(root?.querySelectorAll('.tms-minimap-button') ?? [])].map(b => b.dataset.control),
  };
});

try {
  await page.goto('http://minimap-header.test/');
  await page.waitForSelector('#login', { timeout: 30000 });
  await page.fill('#username', 'probe');
  await page.fill('#password', 'probe-password');
  await page.click('#submit');
  await page.waitForSelector('.entry-stage-channel', { timeout: 30000 });
  await page.click('[data-action="channel"]');
  await page.waitForSelector('.entry-stage-characters', { timeout: 30000 });
  await page.click('[data-action="enter"]');
  await page.waitForSelector('.tms-minimap', { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('.loading-overlay'), { timeout: 120000 });
  await page.waitForTimeout(1200);

  // Full window: the only mode that has ever carried the corner plate.
  await page.evaluate(() => {
    const view = window.check?.getMiniMap?.();
    if (view?.setMode) view.setMode('full');
    const button = [...document.querySelectorAll('.tms-minimap-button')].find(b => b.dataset.control === 'button:max');
    if (button && document.querySelector('.tms-minimap')?.dataset.mode !== 'full') button.click();
  });
  await page.waitForTimeout(600);

  const state = await header();
  console.log('-- full window header --');
  console.log(JSON.stringify(state, null, 1));

  const clip = (rect, margin = 6) => ({
    x: Math.max(0, rect.x - margin),
    y: Math.max(0, rect.y - margin),
    width: Math.min(1100, rect.w + margin * 2),
    height: Math.min(820, rect.h + margin * 2),
  });
  await page.screenshot({ path: path.join(deliver, 'live-window.png'), clip: clip(state.window, 4) });
  // The corner itself: badge + both names, the region the red annotation boxed.
  await page.screenshot({ path: path.join(deliver, 'live-header.png'), clip: { x: state.window.x - 4, y: state.window.y - 4, width: 220, height: 84 } });

  // Same corner with the NPC 目录 open, and with the strip collapsed.
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('.tms-minimap-button')].find(b => b.dataset.control === 'BtNpc');
    button?.click();
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(deliver, 'live-with-npc-list.png'), clip: { x: state.window.x - 4, y: state.window.y - 4, width: 220, height: 380 } });
  console.log('npc list open:', JSON.stringify(await page.evaluate(() => document.querySelector('.tms-minimap-list')?.style.display)));
  console.log('wrote:', ['live-window.png', 'live-header.png', 'live-with-npc-list.png'].join(', '));
} finally {
  await browser.close();
}
