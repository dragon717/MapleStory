// Probe-only: load the inventory check fixture and dump the rendered
// DOM positions of the tab buttons + size button.  No account, no game state.
import { chromium } from '/Users/muniao/.npm/_npx/31e32ef8478fbf80/node_modules/playwright/index.mjs';

const url = 'http://127.0.0.1:8765/inventory-check.html';
const browser = await chromium.launch({ headless: true, executablePath: process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell' });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
page.on('console', m => console.log('[browser]', m.text()));
page.on('pageerror', e => console.log('[browser:error]', e.message));
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForSelector('.tms273-inventory-host .inventory-tab');
const dump = async (label) => {
  const data = await page.evaluate(() => {
    const host = document.querySelector('.tms273-inventory-host');
    const win = document.querySelector('.inventory-window');
    const winRect = win?.getBoundingClientRect();
    const tabs = [...document.querySelectorAll('.inventory-tab')].map(b => {
      const img = b.querySelector('img');
      const r = b.getBoundingClientRect();
      return {
        tab: b.dataset.tab, state: b.dataset.state,
        style: { x: b.style.left, y: b.style.top, w: b.style.width, h: b.style.height },
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        parentRect: (() => { const p = b.parentElement.getBoundingClientRect(); return { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.width), h: Math.round(p.height) }; })(),
        offsetParent: b.offsetParent?.tagName ?? null,
        img: img ? { src: img.src.split('/').pop(), w: img.naturalWidth, h: img.naturalHeight } : null,
      };
    });
    const buttons = [...document.querySelectorAll('.inventory-window-button')].map(b => {
      const img = b.querySelector('img');
      const r = b.getBoundingClientRect();
      return { kind: b.className.split(' ')[1], title: b.title, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, src: img?.src.split('/').pop() ?? null };
    });
    const bg = document.querySelector('.inventory-window-background');
    const bgRect = bg?.getBoundingClientRect();
    return {
      window: win ? { size: win.dataset.size, rect: { x: Math.round(winRect.x), y: Math.round(winRect.y), w: Math.round(winRect.width), h: Math.round(winRect.height) } } : null,
      background: bg ? { src: bg.src.split('/').pop(), natW: bg.naturalWidth, natH: bg.naturalHeight, rect: { x: Math.round(bgRect.x), y: Math.round(bgRect.y), w: Math.round(bgRect.width), h: Math.round(bgRect.height) } } : null,
      tabs,
      buttons,
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
    };
  });
  console.log(`--- ${label} ---\n` + JSON.stringify(data, null, 2));
};
await dump('initial (small)');
await page.click('.inventory-window-button-size');
await page.waitForTimeout(300);
await dump('after expand (full)');
const expandedButtons = await page.evaluate(() => {
  // Show size-button content + neighbour elements to confirm collapse button is rendered
  const buttons = [...document.querySelectorAll('.inventory-window-button-size')].map(b => ({
    title: b.title, src: b.querySelector('img').src.split('/').pop(),
    state: b.dataset.state,
    rect: b.getBoundingClientRect().toJSON ? b.getBoundingClientRect().toJSON() : (() => {
      const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };
    })(),
    cursor: getComputedStyle(b).cursor,
    pointerEvents: getComputedStyle(b).pointerEvents,
    parentVisibility: b.parentElement.hidden ? 'hidden' : 'visible',
    parentRect: (() => { const r = b.parentElement.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
  }));
  const close = [...document.querySelectorAll('.inventory-window-button-close')].map(b => ({
    title: b.title, src: b.querySelector('img').src.split('/').pop(),
    rect: (() => { const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
  }));
  return { sizeButtons: buttons, close };
});
console.log('expanded buttons detail:', JSON.stringify(expandedButtons, null, 2));
await page.click('.inventory-window-button-size');
await page.waitForTimeout(300);
await dump('after collapse (small)');
await browser.close();
