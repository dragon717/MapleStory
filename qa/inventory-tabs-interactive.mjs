// Probe: switch through the tabs and confirm selection + slot render behaves.
import { chromium } from '/Users/muniao/.npm/_npx/31e32ef8478fbf80/node_modules/playwright/index.mjs';

const browser = await chromium.launch({ headless: true, executablePath: process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell' });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const url = 'http://127.0.0.1:8765/inventory-check.html';
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForSelector('.tms273-inventory-host .inventory-tab');

async function describe(label) {
  const data = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.inventory-tab')].map(b => {
      const r = b.getBoundingClientRect();
      return {
        tab: b.dataset.tab, state: b.dataset.state,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      };
    });
    return { tabs, dataset_tab: document.querySelector('.inventory-window').dataset.tab };
  });
  console.log(`-- ${label} --`);
  console.log(JSON.stringify(data, null, 2));
}

await describe('initial');
for (let i = 0; i < 5; i++) {
  await page.click(`.inventory-tab[data-tab="${i}"]`);
  await page.waitForTimeout(120);
  await describe(`after click tab ${i}`);
}
await browser.close();
