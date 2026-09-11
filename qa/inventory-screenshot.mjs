// Render the inventory fixture in two window sizes and save PNG screenshots
// so we can visually compare against the user's reported UI.
import { chromium } from '/Users/muniao/.npm/_npx/31e32ef8478fbf80/node_modules/playwright/index.mjs';
import { writeFile, mkdir } from 'node:fs/promises';

const browser = await chromium.launch({ headless: true, executablePath: process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell' });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const url = 'http://127.0.0.1:8765/inventory-check.html';
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForSelector('.tms273-inventory-host .inventory-tab');
await mkdir('output/inventory-check/screenshots', { recursive: true });
await page.screenshot({ path: 'output/inventory-check/screenshots/inventory-small.png', fullPage: false });
console.log('small screenshot OK');
await page.click('.inventory-window-button-size');
await page.waitForTimeout(300);
await page.screenshot({ path: 'output/inventory-check/screenshots/inventory-expanded.png', fullPage: false });
console.log('expanded screenshot OK');

// Zoom in on the tab strip region of the expanded window
const big = await page.evaluate(() => {
  const w = document.querySelector('.inventory-window');
  const r = w.getBoundingClientRect();
  return { x: Math.max(0, Math.floor(r.x - 20)), y: Math.max(0, Math.floor(r.y - 20)), width: Math.min(1280, Math.ceil(r.width + 40)), height: Math.min(800, Math.ceil(r.height + 40)) };
});
await page.screenshot({ path: 'output/inventory-check/screenshots/inventory-window-only.png', clip: big });
console.log('window-only clip OK');

// Also a tightly-cropped view of just the top of the expanded window to
// inspect the tab strip / button area:
const top = { x: big.x, y: big.y, width: big.width, height: Math.min(big.height, 130) };
await page.screenshot({ path: 'output/inventory-check/screenshots/inventory-top.png', clip: top });
console.log('top crop OK');

// Now do the small window similarly
await page.click('.inventory-window-button-size');
await page.waitForTimeout(200);
const smallTop = await page.evaluate(() => {
  const w = document.querySelector('.inventory-window');
  const r = w.getBoundingClientRect();
  return { x: Math.max(0, Math.floor(r.x - 5)), y: Math.max(0, Math.floor(r.y - 5)), width: Math.ceil(r.width + 10), height: Math.min(800, Math.ceil(r.height + 10)) };
});
await page.screenshot({ path: 'output/inventory-check/screenshots/inventory-small-full.png', clip: smallTop });
const smallOnlyHeader = { x: smallTop.x, y: smallTop.y, width: smallTop.width, height: Math.min(smallTop.height, 110) };
await page.screenshot({ path: 'output/inventory-check/screenshots/inventory-small-top.png', clip: smallOnlyHeader });

await browser.close();
