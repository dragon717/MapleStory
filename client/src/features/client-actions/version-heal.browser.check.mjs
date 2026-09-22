// version-heal.browser.check.mjs — 页面陈旧自愈的**接线**检查（2026-09-22 根因修复）。
//
// 离线契约由 `version-heal.check.ts` 钉住（决策与护栏）；本文件钉的是**接线**：
// ① 陈旧页面**一进首页就**导航到服务端当前发布（不靠登录触发）；
// ② 导航落地后**不会**再导航第二次（防重载环），此时登录才如实回落到原文案。
//
// 全程离线 HTTP stub：不连任何游戏服务、不写存档、不建账号。
// 跑法：node src/features/client-actions/version-heal.browser.check.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { build } = require('esbuild');
const { chromium } = require('/Users/muniao/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const root = path.resolve(import.meta.dirname, '../../../..');
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'version-heal-check-'));
await build({
  stdin: { contents: `import { EntryView } from './src/features/entry/view'; new EntryView(document.getElementById('welcome'), async () => {});`, resolveDir: path.join(root, 'client'), loader: 'ts' },
  bundle: true, format: 'esm', outfile: path.join(output, 'version-heal-check.js'), logLevel: 'silent',
});

// 本页烘在包里的版本常量必须与 `shared/protocol.ts` 一致：stub 的登录响应要**故意**
// 与它不同，才能造出「页面陈旧」这个现场。
const sharedProtocol = await fs.readFile(path.join(root, 'shared/protocol.ts'), 'utf8');
const protocolVersion = Number(sharedProtocol.match(/PROTOCOL_VERSION = (\d+)/)?.[1]);
const contentVersion = sharedProtocol.match(/CONTENT_VERSION = '([^']+)'/)?.[1];
assert(protocolVersion > 0 && Boolean(contentVersion), 'shared protocol constants must be parseable');

const browserCache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = (await fs.readdir(browserCache)).filter(name => name.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)))[0];
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (installed && path.join(browserCache, installed, 'chrome-headless-shell-mac-arm64/chrome-headless-shell'));
const browser = await chromium.launch({ headless: true, executablePath });

const page = await browser.newPage({ viewport: { width: 1024, height: 720 } });
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(String(error)));

let logins = 0;
// 陈旧现场必须造对方向：**服务端比本页新**。本页的常量烘在包里（= 上面解析出来的
// 真实版本），所以 stub 的服务端要报一个**不同的**内容版本，否则判据会正确地
// 判定「描述与本页同一版 ⇒ 不是页面陈旧 ⇒ 不导航」，那不是被测行为。
const serverContentVersion = `${contentVersion}-next`;
const staleSession = { token: 'stale-token', playerId: 'stale-id', username: 'stale_page', protocolVersion, contentVersion: serverContentVersion };
// 服务端当前发布：releaseId 与内容版本都比本页新 ⇒ 这就是「服务端已经换了一代」的现场。
const currentRelease = { releaseId: 'r-current', protocolVersion, contentVersion: serverContentVersion, assetRevision: null, desktop: null };

await page.route('http://stale.test/**', async route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/version-heal-check.css"></head><body><div id="welcome"></div><script type="module" src="/version-heal-check.js"></script></body></html>` });
  if (url.pathname === '/api/register') return route.fulfill({ json: { ok: true } });
  if (url.pathname === '/api/login') { logins++; return route.fulfill({ json: staleSession }); }
  if (url.pathname === '/api/client-release') return route.fulfill({ json: currentRelease });
  const file = url.pathname.startsWith('/assets/')
    ? path.join(root, 'client/public-tms273', decodeURIComponent(url.pathname))
    : path.join(output, path.basename(url.pathname));
  try {
    const body = await fs.readFile(file);
    const ext = path.extname(file);
    return route.fulfill({ body, contentType: ({ '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' })[ext] ?? 'application/octet-stream' });
  } catch { return route.fulfill({ status: 404, body: 'missing test resource' }); }
});

const submit = async () => {
  await page.locator('#username').fill('stale_page');
  await page.locator('#password').fill('stale-page-password');
  await page.locator('#submit').click();
};

try {
  // ① 载入即自愈：陈旧页面**不必等玩家点登录**，进入首页就收敛到服务端当前发布。
  await page.goto('http://stale.test/');
  await page.waitForURL(/[?&]r=r-current/, { timeout: 15000 });
  const landed = new URL(page.url());
  assert.equal(landed.pathname, '/', '落地在根地址');
  assert.equal(landed.searchParams.get('r'), 'r-current', '带上了服务端当前发布标识');
  assert.equal(landed.searchParams.get('ce'), null, '自愈不得携带资源修复代数');
  assert.equal(logins, 0, '载入即自愈，不靠登录触发');
  console.log('  ok  载入即自愈：进入首页就导航到服务端当前发布（不靠登录触发）');

  // ② 落地页地址已经记住该发布 ⇒ 载入不再跳（防重载环）；此时点登录也只在
  //    **登录本身**这一层揭穿，老实回落到原文案，由用户／运维看见真正的不一致。
  await page.locator('#submit').waitFor();
  assert.equal(new URL(page.url()).searchParams.get('r'), 'r-current', '落地后不得再跳一次');
  await submit();
  await page.locator('.entry-notice').filter({ hasText: '客户端与服务器版本不一致' }).waitFor({ timeout: 15000 });
  assert.equal(new URL(page.url()).searchParams.get('r'), 'r-current', '登录后也不得再跳');
  assert.equal(logins, 1, '登录只发生一次，没有第三跳');
  console.log('  ok  防重载环：同一发布只自愈一次，仍然不一致则如实报错');

  assert.deepEqual(pageErrors, [], '自愈路径不得抛出未捕获错误');
  console.log('\nversion-heal.browser.check: 2 组接线断言全部通过（离线 stub，无真实服务）');
} finally {
  await browser.close();
  await fs.rm(output, { recursive: true, force: true });
}
