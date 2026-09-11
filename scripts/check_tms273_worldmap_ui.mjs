// Offline component check: real 273 assets, no account, server or gameplay mutation.
//
// The world-map window is the second half of the minimap feature (the `BtMap`
// button opens it), and its whole job is geometry: the authored page canvas,
// the authored plates and the authored controls all carry source coordinates,
// and the window only reads right if the browser lands them on exactly those
// coordinates.  So this drives the real view + real CSS + real PNGs in a
// headless browser and measures the laid-out boxes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'client/package.json'));
const { build } = require('esbuild');
const { chromium } = require('/Users/muniao/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const output = path.join(root, 'output/playwright/worldmap');
await fs.mkdir(output, { recursive: true });

// Every frame the window can draw must exist on disk: the browser check below
// only ever opens a handful of pages, so a missing PNG for an unvisited page
// would otherwise slip through.
{
  const exported = JSON.parse(await fs.readFile(path.join(root, 'resources/tms273-export/worldmap.json'), 'utf8'));
  const urls = new Set();
  const walk = value => {
    if (value && typeof value === 'object') {
      if (typeof value.url === 'string' && value.url.startsWith('/assets/')) urls.add(value.url);
      for (const child of Object.values(value)) walk(child);
    }
  };
  walk(exported.pages);
  walk(exported.ui);
  assert.equal(urls.size, 47, `the world map export should reference 47 frames, got ${urls.size}`);
  for (const url of urls) {
    const file = path.join(root, 'client/public-tms273', url);
    assert.equal((await fs.stat(file)).size > 0, true, `missing world map asset: ${url}`);
  }
}

await build({ stdin: { contents: `
import { WorldMapView } from './src/features/world/worldmap-view';
import './src/features/world/worldmap.css';
const manifest = await (await fetch('/assets/manifest.json')).json();
window.data = manifest.worldMap;
window.status = [];
window.worldmap = new WorldMapView(document.querySelector('#ui-windows'), manifest);
window.worldmap.onStatus = (message, error) => window.status.push({ message, error });
window.page = () => window.worldmap.page;
`, resolveDir: path.join(root, 'client'), loader: 'ts' }, bundle: true, format: 'esm', outfile: path.join(output, 'check.js'), logLevel: 'silent' });
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = (await fs.readdir(cache)).filter(n => n.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)))[0];
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || path.join(cache, installed, 'chrome-headless-shell-mac-arm64/chrome-headless-shell') });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [], failed = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('requestfailed', request => failed.push(`${request.url()} ${request.failure()?.errorText}`));
await page.route('**/*', async route => {
  const url = new URL(route.request().url());
  assert.equal(url.hostname, 'worldmap.test');
  if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/check.css"><body style="margin:0"><div id="ui-windows" style="position:fixed;inset:0"></div><script type="module" src="/check.js"></script>' });
  const file = url.pathname.startsWith('/assets/') ? path.join(root, 'client/public-tms273', decodeURIComponent(url.pathname)) : path.join(output, path.basename(url.pathname));
  await route.fulfill({ body: await fs.readFile(file), contentType: ({ '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream' });
});

/** Every authored frame the view can place, straight from the export. */
const ui = () => page.evaluate(() => {
  // Controls are placed by their own origin (`left = -origin.x`); the location
  // plate is placed *from* its origin (`left = reference + spot - origin`).
  const pos = frame => ({ x: -frame.origin.x, y: -frame.origin.y, w: frame.width, h: frame.height });
  const u = window.data.ui;
  return {
    page: { x: 7, y: 40, w: 640, h: 470 },
    plate: { ox: u.plate.origin.x, oy: u.plate.origin.y, w: u.plate.width, h: u.plate.height },
    close: pos(u.close.normal),
    before: pos(u.nav.before.normal),
    next: pos(u.nav.next.normal),
    all: pos(u.nav.all.normal),
    root: window.data.root,
  };
});
/** The rendered page, its authored reference point, and the spot for one map. */
const spot = mapId => page.evaluate(id => {
  const entry = window.data.pages[window.page()];
  const found = entry.mapList.find(spot => spot.mapIds.includes(id));
  return { page: entry.page, reference: entry.baseImg.origin, spot: found ? found.spot : null };
}, mapId);
const box = selector => page.locator(selector).boundingBox();
const near = (actual, expected, what) => {
  for (const key of ['x', 'y', 'width', 'height']) {
    assert.ok(Math.abs(actual[key] - expected[key]) <= 1, `${what}.${key}: got ${actual[key]}, want ${expected[key]}`);
  }
};
const control = name => page.evaluate(name => window.worldmap[name].element.getBoundingClientRect().toJSON(), name);

try {
  await page.goto('http://worldmap.test/');
  await page.waitForFunction(() => window.worldmap && window.data);
  const frames = await ui();

  // 1 — nothing is on screen until the window is asked for.
  assert.equal(await page.locator('.worldmap-window').isVisible(), false, 'the window starts hidden');

  // 2 — opening on Maple Island: the window lands on the page that holds the
  // map, not on the world overview, and marks it.
  await page.evaluate(() => window.worldmap.open('001020000'));
  assert.equal(await page.evaluate(() => window.page()), 'WorldMap000', '選擇岔道 must open its own region page');
  const shell = await box('.worldmap-shell');
  near(shell, { x: shell.x, y: shell.y, width: 654, height: 537 }, 'shell');
  assert.ok(Math.abs(shell.x + shell.width / 2 - 720) <= 1 && Math.abs(shell.y + shell.height / 2 - 450) <= 1, 'the plate is centred in the viewport');

  // 3 — the page canvas sits at the authored (7,40) inside the plate.
  const pageBox = await box('.worldmap-page');
  near(pageBox, { x: shell.x + frames.page.x, y: shell.y + frames.page.y, width: frames.page.w, height: frames.page.h }, 'page canvas');

  // 4 — the location plate lands exactly on the authored page point: the spot
  // is a vector in the page canvas whose reference is the BaseImg origin, and
  // the 15x15 `#mapImage` carries its own (7,7) origin, so its top-left must
  // sit at reference + spot - plateOrigin measured from the page canvas.
  {
    const info = await spot('001020000');
    assert.ok(info.spot, 'the export must carry a spot for 選擇岔道');
    near(await box('.worldmap-plate'), {
      x: shell.x + frames.page.x + info.reference.x + info.spot.x - frames.plate.ox,
      y: shell.y + frames.page.y + info.reference.y + info.spot.y - frames.plate.oy,
      width: frames.plate.w, height: frames.plate.h,
    }, 'location plate');
    const plateBox = await box('.worldmap-plate');
    assert.ok(Math.abs(plateBox.x + plateBox.width / 2 - (pageBox.x + info.reference.x + info.spot.x)) <= 1
      && Math.abs(plateBox.y + plateBox.height / 2 - (pageBox.y + info.reference.y + info.spot.y)) <= 1,
      'the plate centre must land on the authored spot');
    assert.ok(plateBox.x >= pageBox.x && plateBox.x + plateBox.width <= pageBox.x + pageBox.width
      && plateBox.y >= pageBox.y && plateBox.y + plateBox.height <= pageBox.y + pageBox.height,
      'the plate must stay inside the page canvas');
    assert.match(await page.locator('.worldmap-plate').evaluate(node => getComputedStyle(node).animationName), /blink/, 'the marker keeps its authored blink affordance');
  }
  await page.screenshot({ path: path.join(output, 'worldmap-maple-island.png') });

  // 5 — the authored controls land on their own source origins, and the close
  // button grows around its centre instead of jumping when hovered.
  const close = await control('closeButton');
  near(close, { x: shell.x + frames.close.x, y: shell.y + frames.close.y, width: frames.close.w, height: frames.close.h }, 'close button');
  assert.ok(close.x > shell.x + shell.width / 2 && close.y < shell.y + shell.height / 2, 'close belongs in the top-right corner');
  await page.locator('.worldmap-close').hover();
  const hovered = await control('closeButton');
  assert.equal(hovered.width, 17, 'the hovered close button uses its authored bigger frame');
  assert.ok(Math.abs((hovered.x + hovered.width / 2) - (close.x + close.width / 2)) <= 1 && Math.abs((hovered.y + hovered.height / 2) - (close.y + close.height / 2)) <= 1, 'hover must grow around the same centre');
  await page.mouse.move(0, 0);

  const before = await control('beforeButton'), next = await control('nextButton'), all = await control('allButton');
  near(before, { x: shell.x + frames.before.x, y: shell.y + frames.before.y, width: frames.before.w, height: frames.before.h }, '上一頁');
  near(next, { x: shell.x + frames.next.x, y: shell.y + frames.next.y, width: frames.next.w, height: frames.next.h }, '下一頁');
  near(all, { x: shell.x + frames.all.x, y: shell.y + frames.all.y, width: frames.all.w, height: frames.all.h }, '全部');
  assert.ok(before.x < next.x, '上一頁 sits left of 下一頁');
  assert.ok(before.y > shell.y + 400, 'the page controls belong on the bottom band, below the page canvas');
  assert.ok(all.y < shell.y + frames.page.y, '全部 belongs in the title band, above the page canvas');
  assert.equal(await page.locator('.worldmap-before').isDisabled(), true, '楓之島 is the first region');
  assert.equal(await page.locator('.worldmap-next').isEnabled(), true);
  assert.equal(await page.locator('.worldmap-all').isEnabled(), true, '全部 can leave the region');

  // 6 — the plates: an exported region navigates, an unexported one is inert.
  assert.equal(await page.locator('.worldmap-link').count(), 0, 'the region page authors no plates');
  await page.evaluate(() => window.worldmap.open('100000000'));
  assert.equal(await page.evaluate(() => window.page()), 'WorldMap010', '維多利亞港 opens the Victoria page');
  {
    const links = await page.evaluate(() => [...document.querySelectorAll('.worldmap-link')].map(node => ({ title: node.title, disabled: node.disabled, rect: node.getBoundingClientRect().toJSON() })));
    assert.equal(links.length, 8, 'the Victoria page authors eight plates');
    assert.ok(links.every(link => link.title && link.rect.width > 0 && link.rect.height > 0), 'every authored plate is drawn');
    // The plates are appended in `MapLink` order, so the rendered disabled flags
    // must line up with "the target page is not part of this catalog".
    const expected = await page.evaluate(() => window.data.pages[window.page()].mapLinks.map(link => link.page === null || !window.data.pages[link.page]));
    assert.deepEqual(links.map(link => link.disabled), expected, 'a plate must be inert exactly when its target page was never exported');
    assert.ok(expected.some(Boolean), 'the Victoria page authors at least one region this catalog cannot reach');
  }
  await page.screenshot({ path: path.join(output, 'worldmap-victoria.png') });

  // 7 — 全部 walks out to the world overview, where every region plate is
  // drawn and the reachable ones are live.  Plates are appended in `MapLink`
  // order, so they are matched by index rather than by (localised) label.
  await page.locator('.worldmap-all').click();
  assert.equal(await page.evaluate(() => window.page()), frames.root, '全部 returns to the overview');
  assert.equal(await page.locator('.worldmap-all').isDisabled(), true, 'and is unavailable once there');
  assert.equal(await page.locator('.worldmap-before').isDisabled(), true, 'the overview has no sibling regions');
  assert.equal(await page.locator('.worldmap-next').isDisabled(), true);
  const overviewLinks = () => page.evaluate(() => ({
    rendered: [...document.querySelectorAll('.worldmap-link')].map(node => ({ title: node.title, disabled: node.disabled })),
    authored: window.data.pages[window.page()].mapLinks.map(link => link.page),
    exported: Object.keys(window.data.pages),
  }));
  {
    const links = await overviewLinks();
    assert.equal(links.rendered.length, 15, 'the overview authors fifteen region plates');
    assert.equal(links.authored.length, 15);
    assert.deepEqual(
      links.rendered.map(link => link.disabled),
      links.authored.map(page => page === null || !links.exported.includes(page)),
      'a region plate is live exactly when its target page was exported',
    );
    const maple = links.authored.indexOf('WorldMap000');
    assert.ok(maple >= 0 && !links.rendered[maple].disabled, '楓之島 is exported, so its plate is live');
    const inert = links.authored.indexOf('WorldMap020');
    assert.ok(inert >= 0 && links.rendered[inert].disabled, 'a region this catalog cannot reach stays inert');
    assert.equal((await page.evaluate(() => window.status.at(-1)?.message)) ?? '', '', 'opening the overview reports nothing');
  }
  await page.screenshot({ path: path.join(output, 'worldmap-overview.png') });

  // 8 — clicking a live plate drills in, and Esc closes the window.
  await page.evaluate(() => {
    const links = window.data.pages[window.page()].mapLinks;
    document.querySelectorAll('.worldmap-link')[links.findIndex(link => link.page === 'WorldMap000')].click();
  });
  assert.equal(await page.evaluate(() => window.page()), 'WorldMap000', 'a live plate drills into its page');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.worldmap-window').isVisible(), false, 'Esc closes the window');

  // 9 — a map the original world map does not list opens the overview without
  // pretending to know where it is.
  await page.evaluate(() => window.worldmap.open('002010000'));
  assert.equal(await page.evaluate(() => window.page()), frames.root, 'an unlisted map falls back to the overview');
  assert.equal(await page.locator('.worldmap-plate').isVisible(), false, 'and draws no marker');

  // 10 — narrow viewports scale the plate instead of overflowing the screen.
  for (const [width, height] of [[1440, 900], [844, 390], [390, 844], [320, 568], [1440, 900]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => window.worldmap.open('001020000'));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal overflow at ${width}x${height}`);
    const scaled = await box('.worldmap-shell');
    assert.ok(scaled.width <= width && scaled.height <= height, `the plate fits ${width}x${height}`);
    assert.ok(Math.abs(scaled.x + scaled.width / 2 - width / 2) <= 1 && Math.abs(scaled.y + scaled.height / 2 - height / 2) <= 1, `the plate stays centred at ${width}x${height}`);
    await page.screenshot({ path: path.join(output, `worldmap-${width}x${height}.png`) });
  }

  // A page switch cancels whatever PNG was still in flight for the page being
  // left behind, which the browser reports as `ERR_ABORTED`.  That is the
  // intended behaviour, not a broken asset — and every frame's existence is
  // already covered by the static pre-check above.  Any other failure is real.
  const broken = failed.filter(line => !line.includes('ERR_ABORTED'));
  assert.deepEqual(broken, [], 'every authored asset must load');
  assert.deepEqual(errors, []);
  console.log('PASS World map UI: region-page open/plate on authored spot/8 plates + inert/controls on source origins/overview 15 plates/Esc/5 viewport transitions; offline only.');
} finally { await browser.close(); }
