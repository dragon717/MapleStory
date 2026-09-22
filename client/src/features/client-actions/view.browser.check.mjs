// view.browser.check.mjs — 首页右下角「强制更新」的**用户可见行为**检查（2026-09-22 修正）。
//
// 为什么必须有这一层：离线判据（`update-service.check.ts`）钉的是**状态机**，而这次
// 的真实缺陷在**接线**——状态机如实报了 `blocked`，界面却只在 `verified` 时才放出
// 「重新装载页面」，于是「强制更新」恰好在唯一需要它的场景（页面陈旧 / 服务端在页面
// 脚下换了一代）里失效：用户点完只看到「请更新客户端后再登录」，而按钮自己的提示写着
// 「重新装载页面」。服务层判据当时甚至把「不兼容不得导航」钉成了契约 ⇒ 这层缺口只能
// 由**真实浏览器点按钮**来钉。
//
// 全程离线 HTTP stub：不连任何游戏服务、不写存档、不建账号。
// 跑法：node src/features/client-actions/view.browser.check.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { build } = require('esbuild');
const { chromium } = require('/Users/muniao/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const root = path.resolve(import.meta.dirname, '../../../..');
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'client-actions-view-check-'));
await build({
  stdin: { contents: `import { ClientActionsView } from './src/features/client-actions/view'; new ClientActionsView(document.body, {});`, resolveDir: path.join(root, 'client'), loader: 'ts' },
  bundle: true, format: 'esm', outfile: path.join(output, 'view-check.js'), logLevel: 'silent',
});

// 本页烘在包里的版本常量（= 真实 `shared/protocol.ts`）。stub 的发布描述要**故意**
// 与它不同，才能造出「本页陈旧」这个现场；方向要造对（服务端比本页新）。
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

const staleRelease = { releaseId: 'r-current', protocolVersion, contentVersion: `${contentVersion}-next`, assetRevision: null, desktop: null };
const compatibleRelease = { releaseId: 'r-same', protocolVersion, contentVersion, assetRevision: null, desktop: null };
let served = staleRelease;

await page.route('http://client-actions.test/**', async route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/view-check.css"></head><body><script type="module" src="/view-check.js"></script></body></html>' });
  if (url.pathname === '/api/client-release') return route.fulfill({ json: served });
  const file = url.pathname.startsWith('/assets/')
    ? path.join(root, 'client/public-tms273', decodeURIComponent(url.pathname))
    : path.join(output, path.basename(url.pathname));
  try {
    const body = await fs.readFile(file);
    const ext = path.extname(file);
    return route.fulfill({ body, contentType: ({ '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' })[ext] ?? 'application/octet-stream' });
  } catch { return route.fulfill({ status: 404, body: 'missing test resource' }); }
});

const update = () => page.locator('[data-role="update"]');
const confirm = () => page.locator('[data-role="confirm"]');

try {
  await page.goto('http://client-actions.test/');
  await update().waitFor();
  assert.equal(await confirm().isVisible(), false, '未点击前不得显示确认面板');

  // ① 页面陈旧（服务端内容版本比本页新）：点「强制更新」必须
  //    (a) **如实说明**不一致（校验没放宽），(b) **同时**给出重载入口。
  await update().click();
  await page.locator('[data-role="status"]').filter({ hasText: '新发布的内容版本与本页面不一致' }).waitFor({ timeout: 15000 });
  await confirm().waitFor({ state: 'visible', timeout: 15000 });
  console.log('  ok  页面陈旧：点「强制更新」如实说明内容版本不一致，并同时给出确认面板');

  // ② 点「重新装载页面」必须真的导航到**那份发布**的入口（带 r、不带 ce）。
  await page.locator('[data-role="apply"]').click();
  await page.waitForURL(/[?&]r=r-current/, { timeout: 15000 });
  const landed = new URL(page.url());
  assert.equal(landed.pathname, '/', '落地在根地址');
  assert.equal(landed.searchParams.get('r'), 'r-current', '导航到服务端当前发布');
  assert.equal(landed.searchParams.get('ce'), null, '普通更新不得带资源修复代数');
  console.log('  ok  点「重新装载页面」导航到那份发布（带 r、不带 ce）');

  // ③ 回归：发布与本页兼容时，这条路径照旧可用。
  served = compatibleRelease;
  await update().waitFor();
  await update().click();
  await confirm().waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('[data-role="apply"]').click();
  await page.waitForURL(/[?&]r=r-same/, { timeout: 15000 });
  console.log('  ok  回归：兼容发布照旧可确认并重载');

  assert.deepEqual(pageErrors, [], '不得抛出未捕获错误');
  console.log('\nclient-actions/view.browser.check: 3 组用户可见行为断言全部通过（离线 stub，无真实服务）');
} finally {
  await browser.close();
  await fs.rm(output, { recursive: true, force: true });
}
