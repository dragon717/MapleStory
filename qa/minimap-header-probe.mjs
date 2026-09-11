// Probe the minimap header: measure the plate/badge boxes, screenshot the
// window, then click the four authored buttons and report what each does.
import { chromium } from '/Users/muniao/.npm/_npx/31e32ef8478fbf80/node_modules/playwright/index.mjs';

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell',
});
const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('console', message => console.log('[console]', message.type(), message.text()));
page.on('pageerror', error => console.log('[pageerror]', error.message));
await page.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.body.dataset.ready === 'true');

const describe = async label => {
  const data = await page.evaluate(() => {
    const minimap = globalThis.__minimap;
    const root = document.querySelector('.tms-minimap');
    const rect = element => {
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const mark = document.querySelector('.tms-minimap-mark');
    return {
      mode: root?.dataset.mode,
      unavailable: root?.dataset.unavailable ?? null,
      window: rect(document.querySelector('.tms-minimap-window')),
      mark: { rect: rect(mark), src: mark?.getAttribute('src'), display: mark?.style.display },
      buttons: [...document.querySelectorAll('.tms-minimap-button')].map(b => ({
        title: b.title, rect: rect(b),
        hit: (() => { const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return e ? (e.className || e.tagName) : null; })(),
      })),
      list: (() => {
        const el = document.querySelector('.tms-minimap-list');
        return el ? { display: el.style.display, rect: rect(el), rows: document.querySelectorAll('.tms-minimap-list-row').length } : null;
      })(),
      markers: document.querySelectorAll('.tms-minimap-marker').length,
      navi: document.querySelectorAll('.tms-minimap-marker.is-navi').length,
      worldMap: document.body.dataset.worldMap ?? null,
    };
  });
  console.log(`-- ${label} --`);
  console.log(JSON.stringify(data, null, 2));
  return data;
};

await describe('initial');

// The plate is drawn by the nw slice; crop the header so the badge can be seen.
await page.screenshot({ path: 'screenshots/header.png', clip: { x: 0, y: 0, width: 320, height: 130 } });

const press = async titleFragment => {
  const handle = await page.locator(`.tms-minimap-button[title*="${titleFragment}"]`).first();
  const count = await handle.count();
  if (count === 0) {
    console.log(`(no button matching ${titleFragment}; try the icon) `);
    return;
  }
  await handle.click({ force: true });
  await page.waitForTimeout(120);
};

await press('收起小地图');
await describe('after button:min (collapse)');
await press('展开小地图');
await describe('after button:max (restore)');
await press('NPC');
await describe('after BtNpc (npc list)');
await press('世界地圖');
await describe('after BtMap (world map)');

await page.screenshot({ path: 'screenshots/full.png' });
await browser.close();
