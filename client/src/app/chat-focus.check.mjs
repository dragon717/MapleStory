import { evidencePath } from '../../../scripts/evidence-path.cjs';
// Offline repro: chat input focus & game-keyword isolation in the real app.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/Users/muniao/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(import.meta.dirname, '../..');
const output = evidencePath('playwright-chat-focus');
await fs.mkdir(output, { recursive: true });
const source = await fs.readFile(path.join(root, 'src/app/main.ts'), 'utf8');
await build({
  stdin: { contents: source + '\nObject.assign(window, {check: { enterGame, leaveGame, status, getGame:()=>game, getWorld:()=>world, getHud:()=>hud }});', resolveDir: path.join(root, 'src/app'), loader: 'ts' },
  bundle: true, format: 'esm', outfile: path.join(output, 'check.js'),
  define: { __RELEASE_VERSION__: '"offline-check"', __RELEASE_TIME__: '"2026-09-10"' }, logLevel: 'silent',
  plugins: [{
    name: 'offline-boundaries', setup(b) {
      b.onResolve({ filter: /network\/session$/ }, () => ({ path: 'session', namespace: 'offline' }));
      b.onResolve({ filter: /features\/entry\/view$/ }, () => ({ path: 'entry', namespace: 'offline' }));
      b.onLoad({ filter: /.*/, namespace: 'offline' }, ({ path: p }) => ({ loader: 'js', contents: p === 'entry'
        ? 'export class EntryView { showLogin(){} returnTo(){} }'
        : `export class Connection {
            constructor(session, message, state){ this.message=message; this.state=state; window.connection=this; window.sent=[]; this._last=undefined; this._t=null; }
            _report(s){ if(this._last===s) return; this._last=s; this.state(s); }
            connect(){ this._report("online");
              // Server pushes a snapshot every world tick (~50ms) once in-game,
              // like world.rs. Wait for the world (and the injected self player)
              // before streaming so pre-join snapshots never hit the UI.
              const self=this; let n=0; const ready=()=>!!(window.check?.getWorld?.()?.loaded && window.player);
              const mapId=()=>{ const w=window.check?.getWorld?.(); return w ? w.mapId : "001020000"; };
              this._t = setInterval(()=>{
                if (!ready()) return;
                if (window.__legacyOnlineEverySnapshot) { self._last="online"; self.state("online"); }  // pre-fix bug
                self.message({type:"snapshot",mapId:mapId(),selfId:"offline",players:[window.player],monsters:[],npcs:[],drops:[],serverTick:++n,tickMs:50});
              }, 50);
            }
            close(){ if(this._t) clearInterval(this._t); this._t=null; }
            send(message){ window.sent.push(message); return true; }
          }` }));
    },
  }],
});
const manifest = JSON.parse(await fs.readFile(path.join(root, 'public-tms273/assets/manifest.json'), 'utf8'));
manifest.mapCatalog.maps = manifest.mapCatalog.maps.filter(map => map.id === '001020000');
manifest.avatar.equipmentLoadouts = {};
for (const key of ['monsters', 'npcs', 'portals', 'skillEffects', 'skillSounds', 'levelUp']) delete manifest[key];
delete manifest.map.bgm;
delete manifest.avatar.attackSound;
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = (await fs.readdir(cache)).filter(n => n.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)))[0];
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || path.join(cache, installed, 'chrome-headless-shell-mac-arm64/chrome-headless-shell') });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.route('**/*', async route => {
  const url = new URL(route.request().url());
  assert.equal(url.hostname, 'viewport.test', 'No live network');
  if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/check.css"><div id="app"></div><script type="module" src="/check.js"></script>' });
  if (url.pathname === '/assets/manifest.json') return route.fulfill({ json: manifest });
  if (url.pathname === '/assets/entry/appearance.json') return route.fulfill({ json: { base: {}, layers: {} } });
  const file = url.pathname.startsWith('/assets/') ? path.join(root, 'public-tms273', decodeURIComponent(url.pathname)) : path.join(output, path.basename(url.pathname));
  try { return route.fulfill({ body: await fs.readFile(file), contentType: ({ '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.mp3': 'audio/mpeg' })[path.extname(file)] || 'application/octet-stream' }); }
  catch { return route.fulfill({ status: 404, body: 'missing test resource' }); }
});
try {
  await page.goto('http://viewport.test/');
  await page.waitForFunction(() => window.check);
  await page.evaluate(() => window.check.enterGame({ username: '离线冒险者', token: 'offline', playerId: 'offline' }));
  await page.waitForFunction(() => window.check.getWorld()?.loaded, {}, { timeout: 60000 });
  await page.evaluate(() => {
    const w = window.check.getWorld(), b = w.manifest.map.bounds;
    window.player = { id: 'offline', username: '离线冒险者', x: (b.xMin + b.xMax) / 2, y: (b.yMin + b.yMax) / 2, vx: 0, vy: 0, facing: 1, grounded: true, action: 'stand', actionId: null, actionStartedTick: 0, lastInputSeq: 0, climbing: false, ladderId: null, hp: 50, maxHp: 100, mp: 40, maxMp: 80, level: 10, exp: 25, expToNext: 100, mesos: 100, inventory: [], equipped: [] };
    window.connection.message({ type: 'snapshot', mapId: w.mapId, selfId: 'offline', players: [window.player], monsters: [], npcs: [], drops: [], serverTick: 0, tickMs: 50 });
  });
  await page.waitForFunction(() => document.querySelector('.maple-chat')?.dataset.available === 'true');
  const probe = await page.evaluate(() => ({
    chatId: !!document.querySelector('#chat'),
    mapleChat: !!document.querySelector('.maple-chat'),
    chat273Input: !!document.querySelector('.chat273-input'),
    playHidden: document.querySelector('#play')?.hidden,
    gameShellChildren: [...(document.querySelector('#game-shell')?.children ?? [])].map(n => n.id || n.className),
  }));
  console.log('PROBE', JSON.stringify(probe));
  assert(probe.chatId && probe.mapleChat, `chat not mounted: ${JSON.stringify(probe)}`);
  const diag = await page.evaluate(() => {
    const input = document.querySelector('.chat273-input');
    const chat = document.querySelector('#chat');
    const game = document.querySelector('#game');
    const hud = document.querySelector('#hud');
    const rectOf = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom }; };
    return {
      inputDisabled: input?.disabled, inputVisible: !!(input?.offsetWidth && input?.offsetHeight),
      inputRect: input ? rectOf(input) : null,
      chat: rectOf(chat), game: rectOf(game), hud: rectOf(hud),
      active: document.activeElement?.className,
    };
  });
  assert.equal(diag.inputDisabled, false, `input must be enabled: ${JSON.stringify(diag)}`);
  assert(diag.inputVisible && diag.inputRect, `input must be visible: ${JSON.stringify(diag)}`);
  assert(diag.chat.bottom <= diag.hud.y, `chat overlaps hud: ${JSON.stringify(diag)}`);

  // 1) press Enter in the world -> chat input should receive focus.
  await page.evaluate(() => { window.sent = []; });
  await page.keyboard.press('Enter');
  const afterEnter = await page.evaluate(() => ({
    sent: window.sent.slice(),
    activeClass: document.activeElement?.className,
    activeTag: document.activeElement?.tagName,
  }));
  console.log('AFTER_ENTER', JSON.stringify(afterEnter));
  const gameAction = m => m.type === 'attack' || m.type === 'castSkill' || m.type === 'pickup' || m.type === 'releaseSkill' || (m.type === 'input' && (m.direction !== 0 || m.jump || m.vertical !== 0));
  assert(!afterEnter.sent.some(gameAction), `Enter leaked a game action: ${JSON.stringify(afterEnter)}`);
  assert(afterEnter.activeClass === 'chat273-input', `Enter did not focus input: ${JSON.stringify(afterEnter)}`);

  // 2) typing letters/numbers must land in the input, not the game.
  await page.evaluate(() => { window.sent = []; });
  await page.keyboard.type('hello 123');
  const typed = await page.locator('.chat273-input').inputValue();
  assert.equal(typed, 'hello 123', `typed text must land in input, got "${typed}"`);
  const leaked = await page.evaluate(() => window.sent);
  assert.equal(leaked.filter(m => m.type === 'input' || m.type === 'attack' || m.type === 'castSkill' || m.type === 'pickup').length, 0, `game actions leaked while typing: ${JSON.stringify(leaked)}`);

  // 3) arrows / space / Z / X must not move or act while the input has focus.
  await page.evaluate(() => { window.sent = []; });
  const gameKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'KeyZ', 'KeyX', 'Digit1', 'Digit2', 'KeyA', 'KeyD'];
  for (const key of gameKeys) {
    const before = await page.evaluate(() => window.sent.filter(m => m.type === 'attack' || m.type === 'castSkill' || m.type === 'pickup' || m.type === 'releaseSkill' || (m.type === 'input' && (m.direction !== 0 || m.jump || m.vertical !== 0))).length);
    await page.keyboard.press(key);
    const after = await page.evaluate(() => window.sent.filter(m => m.type === 'attack' || m.type === 'castSkill' || m.type === 'pickup' || m.type === 'releaseSkill' || (m.type === 'input' && (m.direction !== 0 || m.jump || m.vertical !== 0))).length);
    assert.equal(after, before, `game key ${key} leaked while chat focused`);
  }
  const leaked2 = await page.evaluate(() => window.sent);
  assert.equal(leaked2.filter(gameAction).length, 0, `game actions leaked on game keys: ${JSON.stringify(leaked2)}`);
  assert.equal(await page.locator('.chat273-input').inputValue(), 'hello 123 zx12ad', 'printable keys must land in input');

  // 4) Enter submits while focused; text leaves the box and a pending line shows.
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.sent.some(m => m.type === 'chatSend'));
  assert.match(await page.evaluate(() => window.sent.find(m => m.type === 'chatSend').text), /^hello 123/);
  assert.equal(await page.locator('.chat273-input').inputValue(), '');
  assert.equal(await page.locator('.chat273-pending-line').count(), 1);

  // 5) Escape returns focus to the game and the game keys work again.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement === document.querySelector('#game'));
  await page.evaluate(() => { window.sent = []; });
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(250);
  await page.keyboard.up('ArrowRight');
  assert(await page.evaluate(() => window.sent.some(m => m.type === 'input')), 'ArrowRight should move after Escape');

  // 6) mouse click on the chat input box must also focus it and isolate keys.
  await page.evaluate(() => { window.sent = []; });
  await page.locator('.chat273-input').click();
  await page.waitForFunction(() => document.activeElement?.classList.contains('chat273-input'));
  await page.keyboard.type(' mouse');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('.chat273-input').inputValue(), ' mouse', 'mouse focus typing must land');
  const leaked3 = await page.evaluate(() => window.sent);
  assert.equal(leaked3.filter(gameAction).length, 0, `mouse-focus leaked game actions: ${JSON.stringify(leaked3)}`);
  await page.keyboard.press('Escape');

  // 7) hold a movement key in the world, then open chat while still holding it.
  await page.evaluate(() => {
    window.sent = [];
    window.heldTrace = [];
    const hook = () => window.heldTrace.push({
      t: performance.now().toFixed(0),
      active: document.activeElement?.className || document.activeElement?.tagName,
      sent: window.sent.length,
    });
    document.addEventListener('keydown', hook, true);
    document.addEventListener('focusin', hook, true);
    window.__heldTraceOff = () => document.removeEventListener('keydown', hook, true) || document.removeEventListener('focusin', hook, true);
  });
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(200);
  await page.keyboard.press('Enter');
  const whileHolding = await page.evaluate(() => ({
    activeClass: document.activeElement?.className,
    sent: window.sent.slice(),
  }));
  await page.keyboard.type('held');
  await page.keyboard.press('Enter');            // send
  await page.waitForFunction(() => window.sent.some(m => m.type === 'chatSend'));
  await page.waitForTimeout(220);                 // allow held-repeat windows
  await page.keyboard.up('ArrowRight');           // release while still typing
  const afterRelease = await page.evaluate(() => ({
    value: document.querySelector('.chat273-input')?.value,
    activeClass: document.activeElement?.className,
    sent: window.sent.slice(-8),
    trace: window.heldTrace.slice(-25),
  }));
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__heldTraceOff());
  console.log('HELD_SCENARIO', JSON.stringify({ whileHolding, afterRelease }));
  const heldAction = m => m.type === 'attack' || m.type === 'castSkill' || m.type === 'pickup' || m.type === 'releaseSkill' || (m.type === 'input' && m.direction !== 0);
  // Focusing the chat input makes PlayerInput reset, which emits one direction:0
  // input (the "stop" boundary, the last direction:0 before any chatSend). Any
  // non-zero input with a higher seq than that stop was sent while the chat
  // input already held focus -> real leak.
  const preSend = afterRelease.sent.filter(m => m.type !== 'chatSend');
  const stopSeq = [...preSend].reverse().find(m => m.type === 'input' && m.direction === 0)?.seq;
  const leakedDuringChat = afterRelease.sent.filter(m => heldAction(m) && (stopSeq === undefined || m.seq > stopSeq));
  assert.equal(leakedDuringChat.length, 0, `held-move leaked while chat focused: ${JSON.stringify(afterRelease)}`);
  assert.equal(afterRelease.value, '', 'submitted chat must clear the input');

  // 8) collapse the panel, then Enter must reopen + focus the input.
  await page.evaluate(() => { window.sent = []; });
  await page.locator('.chat273-toggle').click();
  await page.waitForFunction(() => document.querySelector('.maple-chat')?.dataset.state === 'closed');
  assert(await page.locator('.chat273-input').evaluate(e => e.disabled), 'collapsed input must be disabled');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.maple-chat')?.dataset.state === 'open');
  await page.waitForFunction(() => document.activeElement?.classList.contains('chat273-input'));
  assert.equal(await page.locator('.chat273-input').evaluate(e => e.disabled), false, 'Enter must re-enable the input');
  await page.keyboard.type('reopened');
  assert.equal(await page.locator('.chat273-input').inputValue(), 'reopened', 'typing after collapsed-Enter must land');
  const leak8 = await page.evaluate(() => window.sent);
  assert.equal(leak8.filter(heldAction).length, 0, `collapsed-Enter leaked game actions: ${JSON.stringify(leak8)}`);
  await page.keyboard.press('Escape');

  // 9) clicking the chat surface (not the input, not a button) focuses the input.
  await page.evaluate(() => { window.sent = []; });
  const shell = await page.locator('.chat273-surface').boundingBox();
  assert(shell, 'chat surface must exist');
  const inputBox = await page.locator('.chat273-input').boundingBox();
  // pick a point on the surface left of the input, on the decorative art.
  const px = Math.max(shell.x + 10, shell.x);
  const py = Math.max(shell.y + 8, shell.y);
  const inInput = inputBox && px >= inputBox.x && px <= inputBox.x + inputBox.width && py >= inputBox.y && py <= inputBox.y + inputBox.height;
  if (!inInput) {
    await page.mouse.click(px, py);
    await page.waitForFunction(() => document.activeElement?.classList.contains('chat273-input'));
    await page.keyboard.type('surf');
    assert.equal(await page.locator('.chat273-input').inputValue(), 'reopenedsurf', 'surface-click typing must land');
    const leak9 = await page.evaluate(() => window.sent);
    assert.equal(leak9.filter(heldAction).length, 0, `surface-click leaked game actions: ${JSON.stringify(leak9)}`);
    await page.keyboard.press('Escape');
  }

  // 10) Focus must survive the server's ~50ms snapshot stream. Regression for
  // "Enter focuses, then the caret disappears" caused by state('online') being
  // re-reported on every snapshot (which ran focusGame and stole the input).
  // 10a) legacy bug: mock re-reports online on every snapshot -> focus stolen.
  await page.evaluate(() => { window.__legacyOnlineEverySnapshot = true; window.sent = []; });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.classList.contains('chat273-input'));
  await page.waitForTimeout(260); // let several 50ms snapshots arrive
  const stolen = await page.evaluate(() => ({
    active: document.activeElement?.className || document.activeElement?.tagName,
    focusCount: (window.__focusGameLog || []).length,
  }));
  console.log('LEGACY_STOLEN', JSON.stringify(stolen));
  assert.notEqual(stolen.active, 'chat273-input', `legacy per-snapshot online must steal focus: ${JSON.stringify(stolen)}`);
  // 10b) fixed: online is reported only on change -> focus persists under snapshots.
  await page.evaluate(() => {
    window.__legacyOnlineEverySnapshot = false;
    const game = document.querySelector('#game');
    window.__focusGameLog = [];
    game.focus = (...a) => { window.__focusGameLog.push(1); return HTMLElement.prototype.focus.apply(game, a); };
  });
  await page.waitForTimeout(80); // let the rAF queued by 10a's Escape/legacy online drain
  await page.evaluate(() => { window.__focusGameLog = []; window.sent = []; });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.classList.contains('chat273-input'));
  await page.waitForTimeout(400); // ~8 snapshots
  const kept = await page.evaluate(() => ({
    active: document.activeElement?.className || document.activeElement?.tagName,
    focusCalls: window.__focusGameLog.length,
  }));
  console.log('FIXED_KEPT', JSON.stringify(kept));
  assert.equal(kept.active, 'chat273-input', `fixed online reporting must keep focus: ${JSON.stringify(kept)}`);
  assert.equal(kept.focusCalls, 0, `focusGame must not run after first online: ${JSON.stringify(kept)}`);
  await page.evaluate(() => { const i = document.querySelector('.chat273-input'); if (i) i.value = ''; });
  await page.keyboard.type('steady');
  assert.equal(await page.locator('.chat273-input').inputValue(), 'steady', 'typing under snapshot stream must land');
  await page.keyboard.press('Escape');

  await page.screenshot({ path: path.join(output, 'typing.png') });
  assert.deepEqual(errors, []);
  console.log('chat-focus: Enter focuses input, typing isolated from game keys, submit + Escape return-to-game passed.');
} finally { await browser.close(); }
