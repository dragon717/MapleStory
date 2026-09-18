// 端到端量测：注册/登录 → 频道 → 创角 → 开始游戏 → 装载地图与角色 → 收工；
// 然后刷新再来一遍，比较两趟的联网字节。这是上一轮探针完全没覆盖的路径。
import { chromium } from '/Users/muniao/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const base = process.env.SERVER_URL || 'http://127.0.0.1:3011';
const outDir = process.env.PROBE_OUTPUT || '/tmp/postlogin';
fs.mkdirSync(outDir, { recursive: true });
const user = process.env.PROBE_USER || 'qaprobe1';
const password = 'qa-password-12345';
// 角色名**全局唯一**：固定名字会让第二个账号静默创角失败，测出来像「进不去游戏」。
const charName = process.env.PROBE_CHAR || `QA${Math.random().toString(36).slice(2, 8)}`;

function pickChromium() {
  const root = `${process.env.HOME}/Library/Caches/ms-playwright`;
  for (const dir of fs.readdirSync(root).filter(d => d.startsWith('chromium-')).sort().reverse()) {
    const candidate = path.join(root, dir, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** 一条请求的归类；分类口径与「谁该被强缓存」一一对应。 */
function classify(url, type) {
  if (url.startsWith('blob:')) return 'blob(本地生成)';
  if (url.startsWith('data:')) return 'data(内联)';
  const parsed = new URL(url);
  if (parsed.pathname.startsWith('/assets/objects/index/')) return 'object-index(immutable)';
  if (parsed.pathname.startsWith('/assets/objects/sha256/')) return 'object(immutable)';
  if (parsed.pathname.startsWith('/assets/objects/')) return 'object-pointer(no-cache)';
  if (parsed.pathname.startsWith('/api/')) return 'api(no-store)';
  if (parsed.pathname.startsWith('/assets/')) return type === 'Script' || type === 'Stylesheet' ? 'client-build' : 'logical-asset(no-cache)';
  return 'page';
}

const browser = await chromium.launch({ args: ['--no-proxy-server'], executablePath: process.env.CHROMIUM_PATH || pickChromium() });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');
// Phaser 缺纹理时会 `console.warn('Texture key not found')` 并画占位方块——这是
// 「按需装载有没有漏接线」最直接的信号，所以整轮把 console 都收下来。
const consoleNoise = [];
page.on('console', message => {
  const text = message.text();
  if (/texture key|Texture|not found|already in use|error/i.test(text)) consoleNoise.push(`[${message.type()}] ${text.slice(0, 200)}`);
});
page.on('pageerror', error => consoleNoise.push(`[pageerror] ${String(error).slice(0, 300)}`));

let records = new Map();
cdp.on('Network.requestWillBeSent', e => records.set(e.requestId, { url: e.request.url, type: e.type, status: null, fromDiskCache: null, bytes: null, encoding: null, cacheControl: null, conditional: Boolean(e.request.headers['if-none-match'] || e.request.headers['if-modified-since']) }));
cdp.on('Network.responseReceived', e => {
  const r = records.get(e.requestId);
  if (!r) return;
  r.status = e.response.status;
  r.fromDiskCache = e.response.fromDiskCache;
  r.encoding = e.response.headers['content-encoding'] || null;
  r.cacheControl = e.response.headers['cache-control'] || null;
});
cdp.on('Network.loadingFinished', e => { const r = records.get(e.requestId); if (r) r.bytes = e.encodedDataLength; });

function summary(label) {
  const list = [...records.values()];
  const buckets = new Map();
  let total = 0;
  for (const r of list) {
    const key = classify(r.url, r.type);
    const entry = buckets.get(key) || { count: 0, bytes: 0, cached: 0, conditional: 0 };
    entry.count += 1;
    entry.bytes += r.bytes || 0;
    if (r.fromDiskCache) entry.cached += 1;
    if (r.conditional) entry.conditional += 1;
    buckets.set(key, entry);
    total += r.bytes || 0;
  }
  console.log(`\n======== ${label} ========`);
  console.log('类别'.padEnd(26) + '请求'.padStart(7) + '磁盘缓存'.padStart(9) + '条件请求'.padStart(9) + '联网字节'.padStart(13));
  for (const [key, entry] of [...buckets].sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(key.padEnd(26) + String(entry.count).padStart(7) + String(entry.cached).padStart(9) + String(entry.conditional).padStart(9) + String(entry.bytes).padStart(13));
  }
  console.log('合计'.padEnd(26) + String(list.length).padStart(7) + ''.padStart(9) + ''.padStart(9) + String(total).padStart(13));
  console.log('—— 联网字节前 6 ——');
  for (const r of list.filter(r => (r.bytes || 0) > 0).sort((a, b) => (b.bytes || 0) - (a.bytes || 0)).slice(0, 6)) {
    console.log(`  ${String(r.bytes).padStart(10)} B  ${r.status}  ${r.fromDiskCache ? 'disk' : '----'}  ${r.url.slice(0, 96)}`);
  }
  return total;
}

async function ensureLoggedIn(tag) {
  await page.waitForSelector('#login', { timeout: 240000 });
  await page.click('#mode');
  await page.fill('#username', user);
  await page.fill('#password', password);
  await page.click('#submit');
  await page.waitForTimeout(6000);
  if (await page.$('#login')) {
    console.log(`[${tag}] 注册失败（账号已存在），改走登录`);
    await page.click('#mode');
    await page.fill('#username', user);
    await page.fill('#password', password);
    await page.click('#submit');
    await page.waitForTimeout(6000);
  }
  if (await page.$('#login')) throw new Error('登录失败');
}

async function enterGame(tag) {
  const channel = await page.$('.entry-channel-button');
  if (channel) { await channel.click(); await page.waitForTimeout(5000); }
  // 只在「一个角色都没有」时创角；否则会把已建好的角色栏位点成创角表单。
  const owned = await page.$$eval('.entry-character:not(.entry-empty)', els => els.length).catch(() => 0);
  if (owned === 0) {
    console.log(`[${tag}] 没有角色，创建中（名称 ${charName}）`);
    await page.click('[data-action="create"]');
    await page.waitForTimeout(2500);
    if (await page.$('#character-name')) {
      await page.fill('#character-name', charName);
      await page.click('[data-action="check-name"]').catch(() => {});
      await page.waitForTimeout(2500);
      await page.click('#create-character button[type=submit]').catch(() => {});
      await page.waitForTimeout(5000);
    }
  }
  // 创角是否真的成功：角色名是**全局唯一**的，探针若复用固定名字，新账号会因为
  // 「已被占用」而静默创角失败，随后这里就找不到「开始游戏」。所以名字带随机后缀，
  // 并且这里显式等一等，把「没进去」的原因说清楚。
  if (!await page.$('[data-action="enter"]')) {
    await page.waitForSelector('[data-action="enter"]', { timeout: 20000 }).catch(() => {});
    const reason = await page.$eval('.entry-create-error, .entry-error, [data-error]', el => el.textContent).catch(() => '');
    if (reason) console.log(`[${tag}] 创角报错：${reason.trim().slice(0, 120)}`);
  }
  const enter = await page.$('[data-action="enter"]');
  if (!enter) { console.log(`[${tag}] 找不到「开始游戏」按钮`); await page.screenshot({ path: path.join(outDir, `${tag}-stuck.png`) }); return false; }
  if (await enter.getAttribute('data-unavailable')) { console.log(`[${tag}] 「开始游戏」不可用`); return false; }
  console.log(`[${tag}] 点击开始游戏`);
  const startedAt = Date.now();
  await enter.click();
  // 完成判据：出现 100%，**或者**遮罩整个消失（100% 只停一瞬，1.5s 轮询会漏掉）。
  const deadline = Date.now() + 300000;
  let last = '';
  let reachedAt = null;
  let sawOverlay = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(700);
    const state = await page.evaluate(() => {
      const percent = document.querySelector('.loading-overlay-percent');
      const stage = document.querySelector('.loading-overlay-stage, .loading-overlay-headline');
      return `${stage ? stage.textContent : ''}|${percent ? percent.textContent : ''}`;
    }).catch(() => '');
    if (state !== last) { console.log(`[${tag}] +${((Date.now() - startedAt) / 1000).toFixed(1)}s ${state}`); last = state; }
    if (state !== '|') sawOverlay = true;
    if (/100%/.test(state) || (sawOverlay && state === '|')) { reachedAt = Date.now(); break; }
  }
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(outDir, `${tag}-ingame.png`) });
  if (reachedAt) {
    console.log(`[${tag}] 「开始游戏 → 装载完成」耗时 ${((reachedAt - startedAt) / 1000).toFixed(1)}s`);
    return (reachedAt - startedAt) / 1000;
  }
  console.log(`[${tag}] 计时超时（300s）`);
  return null;
}

// ——— 第一趟：全新上下文，冷缓存 ———
await page.goto(base, { waitUntil: 'domcontentloaded' });
await ensureLoggedIn('第一趟');
const firstSeconds = await enterGame('第一趟');
const first = summary('第一趟（冷）');

// ——— 冷加载之后：用 only-if-cached 直接问浏览器「这条还在不在缓存里」———
// 抽样按**抓取顺序**等距取点，从而区分「整体没缓存」与「装到后面把前面挤掉了」。
const objectOrder = [...records.values()].filter(r => r.url.includes('/assets/objects/sha256/')).map(r => r.url);
const sampleCount = 240;
const sample = Array.from({ length: sampleCount }, (_, i) => objectOrder[Math.floor(i * objectOrder.length / sampleCount)]);
const cacheHits = await page.evaluate(async urls => {
  const results = [];
  for (const url of urls) {
    try {
      const response = await fetch(url, { cache: 'only-if-cached', mode: 'same-origin' });
      results.push(response.status === 200 ? 1 : 0);
    } catch { results.push(0); }
  }
  return results;
}, sample);
const hits = cacheHits.reduce((a, b) => a + b, 0);
console.log(`\n======== 冷加载后缓存抽样（only-if-cached，共 ${objectOrder.length} 个对象）========`);
console.log(`命中 ${hits}/${sampleCount}；按抓取顺序的命中分布（每 20 个一格，■=命中）：`);
for (let block = 0; block < sampleCount; block += 20) {
  const chunk = cacheHits.slice(block, block + 20);
  console.log(`  位置 ${String(Math.round(100 * block / sampleCount)).padStart(3)}%  ${chunk.map(v => (v ? '■' : '·')).join('')}  ${chunk.reduce((a, b) => a + b, 0)}/20`);
}
// ——— 第二趟：离开页面 → 重新进入（等价用户刷新）———
await page.goto('about:blank');
await page.waitForTimeout(1000);
records = new Map();
await page.goto(base, { waitUntil: 'domcontentloaded' });
await ensureLoggedIn('第二趟');
const secondSeconds = await enterGame('第二趟');
const second = summary('第二趟（刷新后）');

// 第二趟之后再问一次：这一趟刚抓的对象留下没有？
const cacheHits2 = await page.evaluate(async urls => {
  const results = [];
  for (const url of urls) {
    try {
      const response = await fetch(url, { cache: 'only-if-cached', mode: 'same-origin' });
      results.push(response.status === 200 ? 1 : 0);
    } catch { results.push(0); }
  }
  return results;
}, sample);
console.log(`\n======== 第二趟之后同一批抽样 ========`);
console.log(`命中 ${cacheHits2.reduce((a, b) => a + b, 0)}/${sampleCount}`);
for (let block = 0; block < sampleCount; block += 20) {
  const chunk = cacheHits2.slice(block, block + 20);
  console.log(`  位置 ${String(Math.round(100 * block / sampleCount)).padStart(3)}%  ${chunk.map(v => (v ? '■' : '·')).join('')}  ${chunk.reduce((a, b) => a + b, 0)}/20`);
}

console.log(`\n======== 判定 ========`);
console.log(`「开始游戏 → 装载完成」  冷 ${firstSeconds}s / 刷新 ${secondSeconds}s`);
console.log(`联网字节  冷 ${first} B / 刷新 ${second} B（比值 ${(100 * second / Math.max(1, first)).toFixed(1)}%）`);
const unique = [...new Set(consoleNoise)];
console.log(`\n======== 控制台（缺纹理 / 报错 类）========`);
if (!unique.length) console.log('  干净：没有「Texture key not found」、没有 pageerror。');
else for (const line of unique.slice(0, 20)) console.log('  ' + line);
console.log(`  （共 ${unique.length} 条去重后的相关消息）`);
await browser.close();
