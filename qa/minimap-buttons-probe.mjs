import { evidencePath } from '../scripts/evidence-path.cjs';
// Reproduce the four minimap header buttons inside the REAL game shell.
//
// The isolated view harness proves MiniMapView's handlers work, so the failure
// lives in the shell around the view.  This probe boots the real `app/main.ts`
// (real CSS, real #game-shell, real Phaser) with only the network boundary
// stubbed, streams snapshots at the server's own cadence, then presses each
// authored button the way a human does — mousedown, a pause, mouseup — and
// reports what actually happened.
//
// Run: node qa/minimap-buttons-probe.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const root = path.resolve(import.meta.dirname, '..');
const requireClient = createRequire(path.join(root, 'client', 'package.json'));
const { build } = requireClient('esbuild');
const { chromium } = requireClient('/Users/muniao/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const client = path.join(root, 'client');
const output = evidencePath('playwright-minimap-buttons');
await fs.mkdir(output, { recursive: true });

// The server broadcasts a snapshot every `world::TICK_MS` (50 ms); the stub
// has to keep doing that, because "the buttons are rebuilt on every snapshot"
// is exactly the hypothesis under test.
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
  constructor(session, message, state) { this.message = message; this.state = state; this.tick = 0; window.__connection = this; }
  connect() {
    this.state('connecting');
    setTimeout(() => {
      const w = window.check?.getWorld?.();
      const bounds = w?.manifest?.map?.bounds ?? { xMin: 0, xMax: 100, yMin: 0, yMax: 100 };
      const cx = (bounds.xMin + bounds.xMax) / 2;
      const cy = (bounds.yMin + bounds.yMax) / 2;
      const mapId = w ? w.mapId : '000010000';
      this.state('online');
      // Same cadence as the Rust tick loop, and the same payload shape.
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
const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
page.on('pageerror', e => console.error('[pageerror]', String(e)));
page.on('console', m => { if (m.type() === 'error') console.error('[console]', m.text()); });
await page.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.hostname !== 'minimap-buttons.test') return route.abort();
  if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/check.css"><div id="app"></div><script type="module" src="/check.js"></script>' });
  const file = url.pathname.startsWith('/assets/') ? path.join(client, 'public-tms273', decodeURIComponent(url.pathname)) : path.join(output, path.basename(url.pathname));
  try {
    return route.fulfill({ body: await fs.readFile(file), contentType: ({ '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.mp3': 'audio/mpeg' })[path.extname(file)] || 'application/octet-stream' });
  } catch { return route.fulfill({ status: 404, body: 'missing' }); }
});

const state = () => page.evaluate(() => {
  const root = document.querySelector('.tms-minimap');
  const list = document.querySelector('.tms-minimap-list');
  const buttons = [...document.querySelectorAll('.tms-minimap-button')].map(button => {
    const r = button.getBoundingClientRect();
    const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
    return {
      title: button.title,
      centre: { cx, cy },
      top: (() => { const node = document.elementFromPoint(cx, cy); return node ? node.tagName : null; })(),
    };
  });
  return {
    mode: root?.dataset.mode,
    listDisplay: list ? list.style.display : null,
    listRows: document.querySelectorAll('.tms-minimap-list-row').length,
    buttons,
  };
});

// How many times per second the button strip is torn down and rebuilt.
const churn = () => page.evaluate(() => new Promise(resolve => {
  const node = document.querySelector('.tms-minimap-buttons-left');
  let mutations = 0;
  const observer = new MutationObserver(records => { mutations += records.length; });
  observer.observe(node, { childList: true });
  setTimeout(() => { observer.disconnect(); resolve(mutations); }, 1000);
}));

// A human click: press, hold for a normal tap duration, release.
const humanClick = async (title, holdMs = 120) => {
  const { cx, cy } = await page.evaluate(title => {
    const button = [...document.querySelectorAll('.tms-minimap-button')].find(b => b.title.includes(title));
    if (!button) return { cx: -1, cy: -1 };
    const r = button.getBoundingClientRect();
    return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
  }, title);
  if (cx < 0) { console.log(`(no button matching "${title}")`); return; }
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.waitForTimeout(holdMs);
  await page.mouse.up();
  await page.waitForTimeout(250);
};

try {
  await page.goto('http://minimap-buttons.test/');
  await page.waitForSelector('#login', { timeout: 30000 });
  await page.fill('#username', 'probe');
  await page.fill('#password', 'probe-password');
  await page.click('#submit');
  await page.waitForSelector('.entry-stage-channel', { timeout: 30000 });
  await page.click('[data-action="channel"]');
  await page.waitForSelector('.entry-stage-characters', { timeout: 30000 });
  await page.click('[data-action="enter"]');
  await page.waitForSelector('.tms-minimap', { timeout: 60000 });
  // The loading overlay only retires once the world reports `isLoaded`, the same
  // gate the live client uses; until then it swallows every click.
  await page.waitForFunction(() => !document.querySelector('.loading-overlay'), { timeout: 120000 });
  await page.waitForTimeout(1200);

  const initial = await state();
  console.log('-- initial --');
  console.log(JSON.stringify(initial, null, 1));
  console.log(`button-strip rebuilds in 1 s: ${await churn()}`);
  await page.screenshot({ path: path.join(output, '01-initial.png') });

  const results = [];
  for (const step of [
    { title: '收起小地图', expect: 'strip', label: 'button:min -> strip' },
    { title: '展开小地图', expect: 'full', label: 'button:max -> full' },
  ]) {
    await humanClick(step.title);
    const after = await state();
    results.push({ press: step.label, expected: step.expect, actual: after.mode, pass: after.mode === step.expect });
  }
  await humanClick('NPC');
  const afterNpc = await state();
  results.push({ press: 'BtNpc -> npc list', expected: 'block/2', actual: `${afterNpc.listDisplay}/${afterNpc.listRows}`, pass: afterNpc.listDisplay === 'block' });
  await humanClick('世界地圖');
  const afterMap = await state();
  const worldMapOpen = await page.evaluate(() => Boolean(document.querySelector('.tms-worldmap, .worldmap-window, [data-worldmap]')));
  results.push({ press: 'BtMap -> world map', expected: 'open', actual: String(worldMapOpen), pass: worldMapOpen });

  console.log('-- human-speed presses --');
  for (const row of results) console.log(`${row.pass ? 'PASS' : 'FAIL'}  ${row.press.padEnd(22)} expected=${row.expected} actual=${row.actual}`);
  console.log('meta:', JSON.stringify(await state().then(s => ({ mode: s.mode, npcList: s.listDisplay }))));
  await page.screenshot({ path: path.join(output, '01-final.png') });
  const failed = results.filter(row => !row.pass).length;
  console.log(failed === 0 ? 'ALL BUTTONS RESPOND TO A HUMAN-SPEED CLICK' : `${failed} BUTTON(S) SWALLOWED THE CLICK`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  await browser.close();
}
