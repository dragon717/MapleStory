// Diagnose the 开始游戏 → loading flow with the REAL EntryView UI.
// Offline: real app + Phaser + real 273 art; only network/session and entry/api
// are stubbed so the Connection never delivers a snapshot — the loading overlay
// window stays open and we can sample exactly what is on screen.
//
// Run: node qa/loading-flow-diagnose.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const root = path.resolve(import.meta.dirname, '..');
const requireClient = createRequire(path.join(root, 'client', 'package.json'));
const { build } = requireClient('esbuild');
const { chromium } = requireClient('/Users/muniao/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const client = path.join(root, 'client');
const output = path.join(root, 'output/playwright/loading-flow');
await fs.mkdir(output, { recursive: true });

const source = await fs.readFile(path.join(client, 'src/app/main.ts'), 'utf8');
await build({
  stdin: {
    contents: source + '\nObject.assign(window, {check: {status, getWorld: () => world}});',
    resolveDir: path.join(client, 'src/app'),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  outfile: path.join(output, 'check.js'),
  define: { __RELEASE_VERSION__: '"offline-check"', __RELEASE_TIME__: '"2026-09-11"' },
  logLevel: 'silent',
  plugins: [{
    name: 'offline-boundaries',
    setup(b) {
      b.onResolve({ filter: /network\/session$/ }, () => ({ path: 'session', namespace: 'offline' }));
      // entry/view.ts imports the lobby api as './api', so match the raw
      // specifier (esbuild filters run before path resolution).
      b.onResolve({ filter: /^\.\/api$/ }, args => args.resolveDir.endsWith('features/entry') ? ({ path: 'entry-api', namespace: 'offline' }) : undefined);
      b.onLoad({ filter: /.*/, namespace: 'offline' }, ({ path: p }) => ({ loader: 'js', contents: p === 'session' ? `
export async function authenticate(username, password, register) {
  return { token: 'offline-token', username, playerId: 'c1', protocolVersion: 13, contentVersion: 'tms273-9' };
}
export class Connection {
  constructor(session, message, state) { this.message = message; this.state = state; window.__connection = this; }
  connect() {
    this.state('connecting');
    // Reproduce the real server: the WebSocket handshake lands in tens of
    // milliseconds and snapshots start flowing while Phaser is still
    // preloading.  300ms is well inside the multi-second preload.
    setTimeout(() => {
      const w = window.check?.getWorld?.();
      const bounds = w?.manifest?.map?.bounds ?? { xMin: 0, xMax: 100, yMin: 0, yMax: 100 };
      window.player = { id: 'c1', username: '诊断冒险者', x: (bounds.xMin + bounds.xMax) / 2, y: (bounds.yMin + bounds.yMax) / 2, vx: 0, vy: 0, facing: 1, grounded: true, action: 'stand', actionId: null, actionStartedTick: 0, lastInputSeq: 0, climbing: false, ladderId: null, hp: 50, maxHp: 100, mp: 40, maxMp: 80, level: 10, exp: 25, expToNext: 100, mesos: 100, inventory: [], equipped: [] };
      this.message({ type: 'snapshot', mapId: w ? w.mapId : '000010000', selfId: 'c1', players: [window.player], monsters: [], npcs: [], drops: [], serverTick: 0, tickMs: 50 });
      this.state('online');
    }, 300);
  }
  close() {}
  send() { return true; }
}` : `
export async function lobbyRequest(session, action, fields = {}) {
  if (action === 'list') return { characters: [{ id: 'c1', name: '诊断冒险者', level: 10, job: 0, appearance: { gender: 0, skin: 2000, face: 20000, hair: 30000, coat: 1040002, pants: 1060002, shoes: 1072001, weapon: 1302000 } }], slotLimit: 12, channelId: 1 };
  if (action === 'select') return { token: session.token, username: session.username, playerId: 'c1', protocolVersion: 13, contentVersion: 'tms273-9' };
  throw new Error('unexpected lobby action ' + action);
}` }));
    },
  }],
});

const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = (await fs.readdir(cache)).filter(n => n.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)))[0];
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || path.join(cache, installed, 'chrome-headless-shell-mac-arm64/chrome-headless-shell') });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => { errors.push(String(e)); console.error('[pageerror]', String(e)); });
page.on('console', m => { if (m.type() === 'error') console.error('[console]', m.text()); });
await page.route('**/*', async route => {
  const url = new URL(route.request().url());
  assert.equal(url.hostname, 'loading-flow.test', 'No live network');
  if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/check.css"><div id="app"></div><script type="module" src="/check.js"></script>' });
  const file = url.pathname.startsWith('/assets/') ? path.join(client, 'public-tms273', decodeURIComponent(url.pathname)) : path.join(output, path.basename(url.pathname));
  try {
    return route.fulfill({ body: await fs.readFile(file), contentType: ({ '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.mp3': 'audio/mpeg' })[path.extname(file)] || 'application/octet-stream' });
  } catch { return route.fulfill({ status: 404, body: 'missing test resource' }); }
});

try {
  await page.goto('http://loading-flow.test/');
  await page.waitForSelector('#login', { timeout: 20000 });
  await page.fill('#username', 'diagnose');
  await page.fill('#password', 'diagnose-password');
  await page.click('#submit');
  await page.waitForSelector('.entry-stage-channel', { timeout: 20000 });
  await page.screenshot({ path: path.join(output, '01-channel-stage.png') });
  await page.click('[data-action="channel"]');
  await page.waitForSelector('.entry-stage-characters', { timeout: 20000 });
  await page.screenshot({ path: path.join(output, '02-characters-stage.png') });

  // Click 开始游戏 and start sampling immediately.
  await page.click('[data-action="enter"]');
  const started = Date.now();
  const samples = [];
  for (let i = 0; i < 40; i++) {
    const t = Date.now() - started;
    const state = await page.evaluate(() => {
      const rect = s => { const n = document.querySelector(s); if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), display: getComputedStyle(n).display, z: getComputedStyle(n).zIndex, inDom: Boolean(n.offsetParent || n.getClientRects().length) }; };
      const overlay = document.querySelector('.loading-overlay');
      return {
        bodyClass: document.body.className,
        welcomeHidden: document.querySelector('#welcome').hidden,
        playHidden: document.querySelector('#play').hidden,
        headerParent: document.querySelector('#app > header') ? '#app' : (document.querySelector('#news-content > header') ? 'news-dialog' : 'other'),
        overlay: rect('.loading-overlay'),
        overlayHeadline: document.querySelector('.loading-overlay-headline')?.textContent ?? null,
        overlayPercent: document.querySelector('.loading-overlay-percent')?.textContent ?? null,
        alert: { ...rect('#game-alert'), text: document.querySelector('#game-alert').textContent, hiddenAttr: document.querySelector('#game-alert').hidden },
        message: { text: document.querySelector('#message').textContent, inDom: Boolean(document.querySelector('#message').offsetParent) },
        newsOpen: document.querySelector('#maple-news').open,
        hudInDom: Boolean(document.querySelector('#hud').offsetParent || document.querySelector('#hud').getClientRects().length),
      };
    });
    samples.push({ t, ...state });
    if (i % 4 === 0) await page.screenshot({ path: path.join(output, `03-loading-${String(i).padStart(2, '0')}.png`) });
    const done = await page.evaluate(() => Boolean(window.check?.getWorld?.()?.loaded));
    if (done && i > 8) { samples.push({ t: Date.now() - started, done: true }); break; }
    await page.waitForTimeout(250);
  }
  console.log(JSON.stringify(samples, null, 1));
  await fs.writeFile(path.join(output, 'samples.json'), JSON.stringify(samples, null, 1));
  const pageErrors = errors.filter(e => !e.includes('favicon'));
  console.log('pageerrors:', pageErrors.length ? pageErrors : 'none');
} finally {
  await browser.close();
}
