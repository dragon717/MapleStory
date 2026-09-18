// 判定「Web 强缓存」在真实浏览器里到底生效了没有。
//
// 为什么要用浏览器实测：服务端的 `Cache-Control` 用 curl 看是「对的」，但
// 「对」不等于浏览器用了本地副本。唯一可信的判据是浏览器自己的记录：
// 走 CDP 的 Network.responseReceived 读 fromDiskCache，再配合
// loadingFinished 的 encodedDataLength（命中缓存时为 0）。
//
// 做法：同一页面加载两次（首次 → reload），分别汇总 /assets/** 的联网字节。
// 首次必然有联网量；**reload 若仍接近首次，说明强缓存没吃上**。
//
// 运行：node qa/cache-effect-probe.mjs
import { chromium } from '/Users/muniao/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import { existsSync, readdirSync } from 'node:fs';

const base = new URL(process.env.SERVER_URL || 'http://127.0.0.1:3010');
// 3011 是本机隔离实例（`BIND_ADDR=127.0.0.1:3011 ACCOUNT_DB=/tmp/...`），用于在**不打扰
// 用户正在跑的 3010** 的前提下验证改动；两端口之外一律拒绝，避免把探针打到别处。
if (!['3010', '3011'].includes(base.port)) {
  throw new Error(`Refusing target ${base.origin}; this probe only allows ports 3010/3011`);
}

/** 把 URL 归到「谁负责它的缓存」这一层。 */
function kind(url) {
  const path = new URL(url).pathname;
  if (path.startsWith('/assets/objects/sha256/')) return 'object(immutable)';
  if (path.startsWith('/assets/objects/index/')) return 'index(immutable)';
  if (path === '/assets/objects/current.json') return 'pointer(no-cache)';
  if (path === '/api/client-release') return 'api(no-store)';
  if (path.startsWith('/assets/entry/')) return 'entry-json(no-cache)';
  if (/^\/assets\/[^/]+\.json$/.test(path)) return 'content-json(no-cache)';
  if (path.startsWith('/assets/') && /\.(png|jpe?g|webp|svg|ogg|mp3|wav|glb)$/i.test(path)) return 'logical-asset';
  if (path.startsWith('/assets/')) return 'other-asset';
  if (path.startsWith('/ws')) return 'ws';
  return 'page';
}

async function run(page, cdp, label) {
  const byRequest = new Map();
  const rows = [];
  const onRequest = event => {
    // 条件请求是「浏览器愿不愿意用本地副本」的直接证据：带 If-Modified-Since /
    // If-None-Match 才说明它存了这份资源；两者都没有 ⇒ 它压根没存。
    byRequest.set(event.requestId, {
      conditional: Boolean(event.request.headers['If-Modified-Since'] || event.request.headers['If-None-Match']),
      requestHeaders: event.request.headers,
    });
  };
  const onResponse = event => {
    const previous = byRequest.get(event.requestId) ?? {};
    byRequest.set(event.requestId, {
      ...previous,
      url: event.response.url,
      status: event.response.status,
      fromDiskCache: Boolean(event.response.fromDiskCache),
      fromPrefetch: Boolean(event.response.fromPrefetchCache),
    });
  };
  const onFinished = event => {
    const row = byRequest.get(event.requestId);
    if (row) rows.push({ ...row, bytes: event.encodedDataLength });
    byRequest.delete(event.requestId);
  };
  cdp.on('Network.requestWillBeSent', onRequest);
  cdp.on('Network.responseReceived', onResponse);
  cdp.on('Network.loadingFinished', onFinished);
  try {
    if (label === 'second') await page.reload({ waitUntil: 'load' });
    else await page.goto(new URL('/', base).href, { waitUntil: 'load' });
    // 首屏要拉 60MB 内容 JSON 并解码角色预演图，给足时间。
    await page.waitForTimeout(20000);
  } finally {
    cdp.off('Network.requestWillBeSent', onRequest);
    cdp.off('Network.responseReceived', onResponse);
    cdp.off('Network.loadingFinished', onFinished);
  }

  const summary = new Map();
  for (const row of rows) {
    // 命中磁盘缓存时 encodedDataLength 是 0，但仍算「取到了资源」。
    const key = kind(row.url);
    const bucket = summary.get(key) ?? { count: 0, cached: 0, bytes: 0, statuses: new Set() };
    bucket.count += 1;
    if (row.fromDiskCache) bucket.cached += 1;
    bucket.bytes += row.bytes;
    bucket.statuses.add(row.status);
    summary.set(key, bucket);
  }

  const total = { count: rows.length, cached: rows.filter(r => r.fromDiskCache).length, bytes: rows.reduce((a, r) => a + r.bytes, 0) };
  console.log(`\n================ ${label} ================`);
  console.log(`${'类别'.padEnd(24)}${'请求'.padStart(7)}${'磁盘缓存'.padStart(9)}${'联网字节'.padStart(13)}  状态`);
  for (const [key, bucket] of [...summary].sort((a, b) => b[1].count - a[1].count)) {
    console.log(
      `${key.padEnd(24)}${String(bucket.count).padStart(7)}${String(bucket.cached).padStart(9)}`
      + `${String(bucket.bytes).padStart(13)}  ${[...bucket.statuses].join(',')}`,
    );
  }
  console.log(`${'合计'.padEnd(24)}${String(total.count).padStart(7)}${String(total.cached).padStart(9)}${String(total.bytes).padStart(13)}`);

  console.log('  —— 按联网字节排序（前 8 条）——');
  for (const row of [...rows].sort((a, b) => b.bytes - a.bytes).slice(0, 8)) {
    const path = new URL(row.url).pathname;
    console.log(
      `  ${String(row.bytes).padStart(11)} B  ${String(row.status).padStart(3)}  `
      + `${row.conditional ? '条件请求' : '无条件  '}  ${path.length > 60 ? `${path.slice(0, 57)}...` : path}`,
    );
  }
  return { rows, summary, total };
}

// 沙箱会给进程注入 HTTP_PROXY；本机目标必须直连，否则量到的是代理的缓存。
//
// 本机装的 chromium 修订号未必与 playwright 期望的一致（npx / codex 两份缓存
// 都要 1234/1243，而本地只有 1217/1228），所以自己挑一个实际存在的可执行文件，
// 不为了跑一次探针去下 500MB 浏览器。
function pickChromium() {
  const home = process.env.HOME;
  const roots = [`${home}/Library/Caches/ms-playwright`, `${home}/.cache/ms-playwright`];
  const candidates = [];
  for (const root of roots) {
    let entries = [];
    try { entries = readdirSync(root); } catch { continue; }
    for (const entry of entries) {
      if (entry.startsWith('chromium_headless_shell-')) {
        candidates.push(`${root}/${entry}/chrome-headless-shell-mac-arm64/chrome-headless-shell`);
      }
      if (entry.startsWith('chromium-')) {
        candidates.push(`${root}/${entry}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`);
      }
    }
  }
  return candidates.find(file => existsSync(file));
}

const executablePath = process.env.CHROMIUM_PATH || pickChromium();
if (!executablePath) throw new Error('找不到本机 chromium，可设 CHROMIUM_PATH 指定');
console.log(`chromium: ${executablePath}`);
const browser = await chromium.launch({ args: ['--no-proxy-server'], executablePath });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', error => consoleErrors.push(`pageerror: ${error.message}`));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');

  const first = await run(page, cdp, 'first');
  const second = await run(page, cdp, 'second(reload)');

  const assetsFirst = first.total.bytes;
  const assetsSecond = second.total.bytes;
  console.log('\n================ 判定 ================');
  console.log(`首次联网 ${assetsFirst} B，刷新联网 ${assetsSecond} B`);
  console.log(`刷新/首次 = ${assetsFirst === 0 ? 'n/a' : (assetsSecond / assetsFirst * 100).toFixed(1)}%`);
  const objectRows = second.rows.filter(r => kind(r.url) === 'object(immutable)');
  console.log(`刷新时内容寻址对象请求 ${objectRows.length} 个，其中命中磁盘缓存 ${objectRows.filter(r => r.fromDiskCache).length} 个`);
  const logicalRows = second.rows.filter(r => kind(r.url) === 'logical-asset');
  console.log(`刷新时「逻辑地址」图片请求 ${logicalRows.length} 个（应为 0 或极少；多即说明书未接上对象索引）`);
  if (consoleErrors.length > 0) {
    console.log('\n控制台错误（前 10 条）：');
    for (const line of consoleErrors.slice(0, 10)) console.log(`  ${line}`);
  }
} finally {
  await browser.close();
}
