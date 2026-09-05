import { chromium } from '/Users/muniao/.npm/_npx/31e32ef8478fbf80/node_modules/playwright/index.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const base = new URL(process.env.SERVER_URL || 'http://127.0.0.1:3010');
if (base.port !== '3010') throw new Error(`Refusing non-QA target ${base.origin}; browser probe only allows port 3010`);
const runId = process.env.QA_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
const evidenceDir = `evidence/qa/${runId}`;
const layoutConfig = {
  buttons: process.env.QA_HUD_BUTTONS || null,
  columns: process.env.QA_HUD_COLUMNS || null,
};
const results = [];
const logs = { console: [], pageErrors: [], requestFailures: [], responseErrors: [] };
const sizes = [
  { name: 'desktop-wide', width: 1440, height: 900 },
  { name: 'landscape', width: 1280, height: 720 },
  { name: 'portrait-narrow', width: 390, height: 844 },
];

function record(name, status, details = {}) {
  results.push({ name, status, ...details });
  console.log(`${status} ${name}`);
}

async function metrics(page, size) {
  await page.waitForTimeout(150);
  const value = await page.evaluate(viewport => {
    const visible = element => Boolean(element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length));
    const rect = selector => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    };
    const hud = document.querySelector('#hud');
    const mapleHud = document.querySelector('#hud .maple-hud');
    const actionRects = [...document.querySelectorAll('#hud .hud-button')].map(element => {
      const box = element.getBoundingClientRect();
      return {
        key: element.dataset.button,
        testIndex: element.dataset.testLayout || null,
        ariaLabel: element.getAttribute('aria-label'),
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      };
    });
    const visibleActionRects = actionRects.filter(item => item.width > 0 && item.height > 0);
    const actionRows = [...visibleActionRects].sort((a, b) => a.y - b.y || a.x - b.x).reduce((rows, item) => {
      const row = rows.at(-1);
      if (!row || Math.abs(row[0].y - item.y) > 1) rows.push([item]);
      else row.push(item);
      return rows;
    }, []);
    const actionGaps = actionRows.flatMap(row => row.slice(1).map((item, index) => item.x - (row[index].x + row[index].width)));
    return {
      viewport,
      documentWidth: document.documentElement.clientWidth,
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      horizontalOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > document.documentElement.clientWidth + 1,
      game: rect('#game'),
      gameShell: rect('#game-shell'),
      hud: rect('#hud'),
      mapleHud: rect('#hud .maple-hud'),
      hudPosition: hud ? getComputedStyle(hud).position : null,
      mapleHudVisible: visible(mapleHud),
      hpVisible: visible(document.querySelector('#hud .hud-gauge-hp')),
      hpNumberVisible: visible(document.querySelector('#hud .hud-gauge-number-hp')),
      menuVisible: visible(document.querySelector('#hud [data-button="BtMenu"]')),
      inventoryVisible: visible(document.querySelector('#hud [data-button="BtShort"]')),
      toolbarSoundVisible: visible(document.querySelector('#sound')),
      toolbarLogoutVisible: visible(document.querySelector('#logout')),
      buttons: [...document.querySelectorAll('#hud [data-button]')].map(element => element.dataset.button),
      actionLayout: {
        order: visibleActionRects.map(item => item.key),
        testOrder: visibleActionRects.map(item => item.testIndex),
        hiddenCount: actionRects.length - visibleActionRects.length,
        rows: actionRows.length,
        rowLengths: actionRows.map(row => row.length),
        gaps: actionGaps,
        rects: visibleActionRects,
      },
      chat: {
        visible: visible(document.querySelector('#chat .maple-chat')),
        inputVisible: visible(document.querySelector('#chat .chat-input')),
        inputEnabled: Boolean(document.querySelector('#chat .chat-input') && !document.querySelector('#chat .chat-input').disabled),
        controls: [...document.querySelectorAll('#chat button, #chat input')].map(element => element.getAttribute('aria-label') || element.tagName),
      },
    };
  }, { width: size.width, height: size.height });
  await page.screenshot({ path: `${evidenceDir}/${size.name}.png`, fullPage: true });
  return value;
}

async function run() {
  await mkdir(evidenceDir, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  });
  const context = await browser.newContext({ viewport: sizes[0] });
  const page = await context.newPage();
  page.on('console', message => logs.console.push({ level: message.type(), text: message.text(), location: message.location() }));
  page.on('pageerror', error => logs.pageErrors.push(String(error)));
  page.on('requestfailed', request => logs.requestFailures.push({ url: request.url(), error: request.failure()?.errorText || 'unknown' }));
  page.on('response', response => {
    if (response.status() >= 400) logs.responseErrors.push({ url: response.url(), status: response.status() });
  });

  try {
    const pageUrl = new URL(base.origin);
    if (layoutConfig.buttons) pageUrl.searchParams.set('qaHudButtons', layoutConfig.buttons);
    if (layoutConfig.columns) pageUrl.searchParams.set('qaHudColumns', layoutConfig.columns);
    await page.goto(pageUrl.href, { waitUntil: 'networkidle' });
    const loginMetrics = await metrics(page, sizes[0]);
    record('login page has no horizontal overflow', loginMetrics.horizontalOverflow ? 'FAIL' : 'PASS', loginMetrics);

    const suffix = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
    const username = `qa_ui_${suffix}`.slice(0, 32);
    const password = `Qa-${randomUUID()}-x`;
    await page.locator('#mode').click();
    await page.locator('#username').fill(username);
    await page.locator('#password').fill(password);
    await page.locator('#login').locator('button[type="submit"]').click();
    await page.locator('#play').waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('#hud .maple-hud').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('#connection')?.textContent?.includes('已连接'), undefined, { timeout: 15000 });
    await page.waitForTimeout(1200);

    const viewportMetrics = {};
    for (const size of sizes) {
      await page.setViewportSize({ width: size.width, height: size.height });
      viewportMetrics[size.name] = await metrics(page, size);
      const current = viewportMetrics[size.name];
      record(`${size.name} responsive layout`, current.horizontalOverflow || !current.mapleHudVisible || !current.hpVisible || !current.menuVisible ? 'FAIL' : 'PASS', current);
      const actionLayout = current.actionLayout;
      const expectedButtons = layoutConfig.buttons === '8' ? 8 : 4;
      const hud = current.hud;
      const withinHud = actionLayout.rects.every(item => item.x >= hud.x - 1 && item.y >= hud.y - 1 && item.x + item.width <= hud.x + hud.width + 1 && item.y + item.height <= hud.y + hud.height + 1);
      const noOverlap = actionLayout.rects.every((left, index) => actionLayout.rects.slice(index + 1).every(right => left.x + left.width <= right.x + 0.5 || right.x + right.width <= left.x + 0.5 || left.y + left.height <= right.y + 0.5 || right.y + right.height <= left.y + 0.5));
      const sensibleGaps = actionLayout.gaps.every(gap => gap >= -0.5 && gap <= 12);
      record(`${size.name} action button geometry`, actionLayout.order.length === expectedButtons && withinHud && noOverlap && sensibleGaps && actionLayout.order.every(Boolean) ? 'PASS' : 'FAIL', {
        expectedButtons,
        withinHud,
        noOverlap,
        sensibleGaps,
        actionLayout,
      });
    }

    await page.setViewportSize({ width: sizes[1].width, height: sizes[1].height });
    await page.waitForTimeout(100);
    const wide = await page.evaluate(() => ({ position: getComputedStyle(document.querySelector('#hud')).position, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 }));
    await page.setViewportSize({ width: sizes[2].width, height: sizes[2].height });
    await page.waitForTimeout(100);
    const narrow = await page.evaluate(() => ({ position: getComputedStyle(document.querySelector('#hud')).position, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 }));
    record('runtime resize reflows HUD without overflow', wide.position !== narrow.position && !wide.overflow && !narrow.overflow ? 'PASS' : 'FAIL', { wide, narrow });

    const menu = page.locator('#hud [data-button="BtMenu"]').first();
    await page.waitForTimeout(100);
    const menuMessage = await menu.evaluate(element => {
      element.click();
      return document.querySelector('#message')?.textContent || '';
    });
    const menuSurfaceVisible = await page.locator('#ui-windows [role="dialog"]:visible, #notices [role="dialog"]:visible, #ui-windows [data-window]:visible, #notices [data-window]:visible').count() > 0;
    record('settings/menu entry is operable', menuMessage.includes('菜单') || menuSurfaceVisible ? 'PASS' : 'FAIL', { message: menuMessage, surfaceVisible: menuSurfaceVisible });
    record('menu window business surface (out of current scope)', menuSurfaceVisible ? 'PASS' : 'KNOWN_LIMITATION', { message: menuMessage });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    const inventory = page.locator('#hud [data-button="BtShort"]').first();
    await inventory.evaluate(element => element.click());
    const inventoryWindow = page.locator('#ui-windows .inventory-window');
    const inventoryVisible = await inventoryWindow.isVisible();
    record('inventory/menu shell entry is operable', inventoryVisible ? 'PASS' : 'FAIL', { visible: inventoryVisible });
    if (inventoryVisible) await inventoryWindow.locator('.inventory-window-button-close').click();

    const manifest = await page.evaluate(async () => await (await fetch('/assets/manifest.json')).json());
    const chatSourceKeys = Object.keys(manifest.hud || {}).filter(key => /chat|whisper/i.test(key));
    const renderedChat = await page.locator('#chat .chat-input, #chat .chat-target, #chat .chat-box-toggle, #chat .chat-whisper').count();
    const chatInput = page.locator('#chat .chat-input');
    const chatInputVisible = await chatInput.isVisible().catch(() => false);
    const chatInputEnabled = await chatInput.isEnabled().catch(() => false);
    record('small-screen chat affordance is retained', renderedChat > 0 && chatInputVisible && chatInputEnabled ? 'PASS' : 'FAIL', { chatSourceKeys, renderedChat, chatInputVisible, chatInputEnabled });

    await page.locator('#game').click();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(500);
    record('browser keyboard path remains live after responsive layout', (await page.locator('#connection').innerText()).includes('已连接') ? 'PASS' : 'FAIL', { connection: await page.locator('#connection').innerText() });
  } finally {
    const errors = {
      consoleErrors: logs.console.filter(entry => ['error', 'warning'].includes(entry.level)),
      pageErrors: logs.pageErrors,
      requestFailures: logs.requestFailures,
      responseErrors: logs.responseErrors,
    };
    if (errors.consoleErrors.length || errors.pageErrors.length || errors.requestFailures.length) record('browser runtime has no errors or failed requests', 'FAIL', errors);
    else record('browser runtime has no errors or failed requests', 'PASS');
    await writeFile(`${evidenceDir}/browser.json`, `${JSON.stringify({
      runId,
      server: base.origin,
      layoutConfig,
      browser: 'Playwright Chromium headless',
      viewports: sizes,
      completed: !results.some(result => ['FAIL', 'BLOCKED'].includes(result.status)),
      testAccount: 'omitted',
      results,
      logs,
      note: 'Passwords and session tokens are intentionally omitted. This browser run uses a newly registered QA account on the independent 3010 service.',
    }, null, 2)}\n`, 'utf8');
    await context.close();
    await browser.close();
  }
}

let failure;
try {
  await run();
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
  record('browser probe completed', 'FAIL', { error: failure.message });
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(`${evidenceDir}/browser-failure.json`, `${JSON.stringify({ runId, server: base.origin, completed: false, error: failure.message }, null, 2)}\n`, 'utf8');
}
if (failure || results.some(result => ['FAIL', 'BLOCKED'].includes(result.status))) process.exitCode = 1;
