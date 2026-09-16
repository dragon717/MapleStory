import { evidencePath } from './evidence-path.cjs';
// 冒险笔记（图鉴）窗口的**几何与可读性**检查：真实视图 + 真实样式表 + 真实 PNG，
// 在无头浏览器里量真实布局盒。
//
// 为什么必须用浏览器量：这个窗口的画法建立在「槽位贴在源相册板的瓦片上」这一条
// 上。瓦片是**烤在 PNG 里**的，样式表用同一组数字算格位——两边一旦对不上，槽位
// 就会飘在半格上，而任何纯 CSS/纯 TS 的断言都看不出这件事。所以这里
//   ① 直接在源 PNG 上解出 5x5 瓦片的真实坐标，
//   ② 再量 DOM 里每个槽位的真实坐标，
//   ③ 断言两者逐格对齐（±1px）。
// 同理，「字压在白纸上」这件事只能对**计算后的颜色**断言：源底板内部是不透明的
// 白（255,255,255,255），浅色字压上去就是不可读——这正是改造前的问题。
//
// 离线组件检查：真实素材、不登录、不连服务器、不动任何游戏状态。
// 服务端状态由 `shared/notebook-catalog.json` 与真名字表推出，形状与服务端
// `notebook.rs::monster_rows` / `item_rows` 的 JSON 一致。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'client/package.json'));
const { build } = require('esbuild');
const { chromium } = require('/Users/muniao/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const output = evidencePath('notebook-ui');
await fs.mkdir(output, { recursive: true });

// ---------------------------------------------------------------------------
// 1. 本设计用到的每一帧都必须在导出里、并且已经装配到磁盘
//    （浏览器检查只打开两个页签，没打开的页签缺图不会自己暴露。）
let boardUrl;
{
  const exported = JSON.parse(await fs.readFile(path.join(root, 'resources/tms273-export/notebook.json'), 'utf8'));
  const used = {
    monster: [
      'backgrnd', 'layer:tab_line', 'Collection/backgrnd', 'Collection/monsterGrade/empty',
      'button:Close/normal', 'button:Close/pressed', 'button:Close/disabled', 'button:Close/mouseOver',
      'Collection/button:Prev/normal', 'Collection/button:Prev/mouseOver', 'Collection/button:Prev/pressed', 'Collection/button:Prev/disabled',
      'Collection/button:Next/normal', 'Collection/button:Next/mouseOver', 'Collection/button:Next/pressed', 'Collection/button:Next/disabled',
      ...Array.from({ length: 10 }, (unused, digit) => `number/${digit}`),
    ],
    item: ['category/itemComplete', 'category/itemIncomplete', 'category/backgrndN'],
  };
  const urls = new Set();
  for (const [panel, keys] of Object.entries(used)) {
    for (const key of keys) {
      const frame = exported.frames[panel][key];
      assert(frame, `导出缺少本设计使用的帧 ${panel}/${key}`);
      urls.add(frame.url);
    }
  }
  for (const url of urls) {
    const file = path.join(root, 'client/public-tms273', url);
    assert((await fs.stat(file)).size > 0, `素材没有装配到磁盘: ${url}`);
  }
  assert.equal(exported.frames.monster['Collection/backgrnd'].width, 666);
  assert.equal(exported.frames.monster['Collection/backgrnd'].height, 520);
  boardUrl = exported.frames.monster['Collection/backgrnd'].url;
}

// ---------------------------------------------------------------------------
// 2. 在源相册板上解出它真正烤着的瓦片坐标。
//    这就是样式表里那组数字的来源，也是下面 ③ 的对照面。PNG 是 8 位 RGBA、
//    非交错（`check_tms273_notebook.cjs` 已经钉住），所以自己解就行。
function readPng(buffer) {
  assert.equal(buffer.subarray(0, 8).toString('latin1'), '\x89PNG\r\n\x1a\n', '不是 PNG');
  let offset = 8, width = 0, height = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('latin1');
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      assert.equal(data[8], 8, '不是 8 位深'); assert.equal(data[9], 6, '不是 RGBA'); assert.equal(data[12], 0, '是交错 PNG');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= 4 ? pixels[(y - 1) * stride + x - 4] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        value += (pa <= pb && pa <= pc) ? left : (pb <= pc ? up : upLeft);
      }
      pixels[y * stride + x] = value & 0xff;
    }
  }
  return { width, height, pixels, at: (x, y) => { const i = y * stride + x * 4; return [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]]; } };
}

/** 相册板上「亮瓦片」的行带与列带：亮度 > 170 且不透明。
 *
 *  一行里有 5 块 68px 的瓦片 ⇒ 亮像素至少 340 个，所以「整行亮像素 > 120」
 *  只会在瓦片行上成立；列同理。两条带各自聚类成连续区间，区间起点就是瓦片的
 *  左边／顶边（行带顶上多一截高光，取顶边即可，瓦片的可见范围覆盖整带）。 */
function measureTiles(buffer) {
  const image = readPng(buffer);
  const isLight = (x, y) => {
    const [r, g, b, a] = image.at(x, y);
    return a > 200 && 0.299 * r + 0.587 * g + 0.114 * b > 170;
  };
  const collect = (length, cross, probe) => {
    const found = [];
    let run = null;
    for (let index = 0; index < length; index += 1) {
      let hits = 0;
      for (let step = 0; step < cross; step += 1) if (probe(index, step)) hits += 1;
      if (hits > 120) run = run ? [run[0], index] : [index, index];
      else { if (run && run[1] - run[0] > 20) found.push(run); run = null; }
    }
    if (run && run[1] - run[0] > 20) found.push(run);
    return found;
  };
  const rows = collect(image.height, image.width, (y, x) => isLight(x, y));
  const cols = collect(image.width, image.height, (x, y) => isLight(x, y));
  return { rows, cols, image };
}

const boardFile = path.join(root, 'client/public-tms273', boardUrl);
const tiles = measureTiles(await fs.readFile(boardFile));
assert.equal(tiles.rows.length, 5, `相册板必须有 5 行瓦片，实测 ${JSON.stringify(tiles.rows)}`);
assert.equal(tiles.cols.length, 5, `相册板必须有 5 列瓦片，实测 ${JSON.stringify(tiles.cols)}`);
// 行的起点是瓦片顶边（行带比瓦片高一截，因为顶上有高光带，取顶边即可）。
const tileRows = tiles.rows.map(([from]) => from);
const tileCols = tiles.cols.map(([from]) => from);
const tileSize = tiles.cols[0][1] - tiles.cols[0][0] + 1;
assert.equal(tileSize, 68, `瓦片宽度实测 ${tileSize}px`);
assert.equal(tiles.rows[0][1] - tileRows[0] + 1, 68, '瓦片高度实测应当是 68px');

/** 一块矩形区域的中位色：用来量「字画在哪层底上」。
 *
 *  行名画在瓦片行上方那段留白里（样式表 `bottom: calc(100% + 3px)` + 12px
 *  行高 ⇒ 板上 y ∈ [瓦片顶-15, 瓦片顶-3)），底色就是源板在那里的像素。
 *  取中位而不是均值：带上有源板自己的高光颗粒，几粒亮像素不该拉偏底色。 */
function bandColor(image, top, bottom, left, right) {
  const channels = [[], [], []];
  for (let y = Math.max(0, top); y < Math.min(image.height, bottom); y += 1) {
    for (let x = Math.max(0, left); x < Math.min(image.width, right); x += 1) {
      const [r, g, b, a] = image.at(x, y);
      if (a < 200) continue;
      channels[0].push(r); channels[1].push(g); channels[2].push(b);
    }
  }
  const median = values => values.sort((a, b) => a - b)[values.length >> 1] ?? 0;
  return channels.map(median);
}

const hexColor = ([r, g, b]) => `#${[r, g, b].map(value => value.toString(16).padStart(2, '0')).join('')}`;
// 行名那条留白带的实测底色：第 1 行的留白就在板子最上面，最干净。
const rowNameBacking = hexColor(bandColor(tiles.image, tileRows[0] - 15, tileRows[0] - 3, tileCols[0], tileCols[4] + tileSize));

// ---------------------------------------------------------------------------
// 3. 拼一份真实目录 + 服务端形状的私有状态，喂给真视图。
{
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'client/public-tms273/assets/manifest.json'), 'utf8'));
  const directory = JSON.parse(await fs.readFile(path.join(root, 'client/public-tms273/assets/notebook.json'), 'utf8'));
  const catalog = JSON.parse(await fs.readFile(path.join(root, 'shared/notebook-catalog.json'), 'utf8'));
  const mobNames = JSON.parse(await fs.readFile(path.join(root, 'shared/mob-names.json'), 'utf8')).names;
  // 物品名：服务端一页的 `label` 写的是 `catalog.item_label(id).unwrap_or(id)`，
  // 而 `item_label` 就是读这张表。夹具照抄这一步——不照抄的话 label 会退成
  // 物品 id，把真名字盖掉（第一版这里读的是目录里并不存在的 `items[id].name`，
  // 于是样张上每格都显示 1000000 这种 id）。
  const itemNames = JSON.parse(await fs.readFile(path.join(root, 'shared/items.json'), 'utf8'));

  // 只喂两个源分頁：视图把它排成两张相册板，页面本身不必铺满整个地区。
  const rows = Object.values(directory.monsterStructure.rows)
    .filter(row => row.region === 0 && (row.page === 0 || row.page === 1))
    .sort((a, b) => a.page - b.page || a.row - b.row);
  assert.equal(rows.length, 10, '地区 0 的前两个分頁应当各有 5 行');

  const monsterRows = rows.map(row => {
    const slots = row.entryIds.map(entryId => {
      const entry = directory.monsterEntries[entryId];
      assert(entry, `目录里没有条目 ${entryId}`);
      return {
        key: entryId,
        label: mobNames[entry.monsterTemplateId] ?? '',
        monsterTemplateId: entry.monsterTemplateId,
        registered: false,
        collectable: entry.collectable,
      };
    });
    return { key: row.rowKey, label: row.name, rowKey: row.rowKey, obtained: false, registered: false, slots };
  });

  const monsterFrames = {};
  const keepMonster = id => {
    const frame = manifest.monsters?.[id]?.actions?.stand?.[0];
    if (!frame) return;
    monsterFrames[id] = { actions: { stand: [frame] } };
  };
  for (const row of monsterRows) for (const slot of row.slots) keepMonster(slot.monsterTemplateId);

  const equipmentIds = directory.sections.equipment.slice(0, 60);
  assert.equal(equipmentIds.length, 60, '装备分区应当够一页');
  const equipmentRows = equipmentIds.map((id, index) => ({
    key: id,
    label: itemNames[id]?.name ?? id,
    itemId: id,
    // 前 12 件当作「已获得」，两种状态都要在画面上出现。
    obtained: index < 12,
    registered: index < 12,
    availability: directory.items[id]?.availability ?? 'obtainable',
  }));
  const itemFrames = {};
  // 清单里同一件装备可能同时有 7 位与 8 位键：两个都留，和真实清单一致。
  for (const id of equipmentIds) {
    for (const key of new Set([id, id.padStart(8, '0')])) {
      if (manifest.items?.[key]) itemFrames[key] = manifest.items[key];
    }
  }
  assert(Object.keys(itemFrames).length >= equipmentIds.length, '装备图标没有从清单里取到');

  const rel = url => url.replace(/^\//, '');
  for (const monster of Object.values(monsterFrames)) {
    for (const frame of monster.actions.stand) frame.url = rel(frame.url);
  }
  for (const frame of Object.values(itemFrames)) frame.url = rel(frame.url);
  const notebookFrames = { monster: {}, item: {} };
  for (const [panel, frames] of Object.entries(manifest.notebook.frames)) {
    for (const [key, frame] of Object.entries(frames)) notebookFrames[panel][key] = { ...frame, url: rel(frame.url) };
  }

  const trimmedDirectory = {
    catalogVersion: directory.catalogVersion,
    contentVersion: directory.contentVersion,
    sections: directory.sections,
    items: Object.fromEntries(equipmentIds.map(id => [id, directory.items[id]])),
    monsterStructure: {
      regions: directory.monsterStructure.regions,
      rows: Object.fromEntries(rows.map(row => [row.rowKey, row])),
    },
    monsterEntries: directory.monsterEntries,
    monsterText: {},
    collectableEntryCount: directory.collectableEntryCount,
    rewardItems: {},
    status: directory.status,
  };

  await fs.writeFile(path.join(output, 'data.json'), JSON.stringify({
    manifest: { notebook: { ...manifest.notebook, frames: notebookFrames }, monsters: monsterFrames, items: itemFrames },
    directory: trimmedDirectory,
    monsterRows,
    equipmentRows,
    summary: { monster: { registered: 0, total: 1550, collectable: 57 }, equipment: { registered: 12, total: 1738 } },
  }));
}

// ---------------------------------------------------------------------------
// 4. 生成 harness（真视图 + 真状态）并打包
const HARNESS = `// 由 scripts/check_tms273_notebook_ui.mjs 生成（该脚本会覆盖本文件）。
// 离线挂载真 NotebookView：目录与私有状态都在 ./data.json 里，PNG 走 ./assets。
import { NotebookView } from '../../../client/src/features/notebook/view';
import '../../../client/src/features/notebook/style.css';

const data = await (await fetch('./data.json')).json();
const host = document.querySelector('#ui-windows');
const sent = [];
const states = [];

const directory = data.directory;
const reply = message => {
  if (message.type !== 'notebookQuery') return;
  const last = states.at(-1);
  const samePage = last && last.section === message.section && last.page === message.page;
  const base = {
    type: 'notebookState',
    requestId: message.requestId,
    section: message.section,
    catalogVersion: directory.catalogVersion,
    scope: message.section === 'monster' ? 'account' : 'character',
    revision: samePage ? last.revision + 1 : 1,
    page: message.page,
    serverNowMs: 1,
  };
  const state = message.section === 'monster'
    ? { ...base, pageCount: 15, rows: data.monsterRows, summary: data.summary.monster, blockedReason: '本构建尚未接入收藏登记（该登记规则尚未核定），因此怪物页暂时没有已登记的条目。' }
    : { ...base, pageCount: signal.pageCount, rows: message.page === 0 ? data.equipmentRows : [], summary: data.summary.equipment };
  states.push(state);
  window.__sentCount = sent.length;
  setTimeout(() => view.receiveState(state), 0);
};
const signal = { pageCount: 29 };

const view = new NotebookView(host, data.manifest, {
  send: message => { sent.push(message); reply(message); return true; },
  status: message => { window.__status = (window.__status ?? []).concat(message); },
  loadDirectory: async () => directory,
});
window.__view = view;
window.__data = data;
view.open();
document.body.dataset.ready = 'true';
`;
await fs.writeFile(path.join(output, 'harness.ts'), HARNESS);
await build({
  entryPoints: [path.join(output, 'harness.ts')],
  bundle: true,
  format: 'esm',
  outfile: path.join(output, 'check.js'),
  logLevel: 'silent',
});
const INDEX_HTML = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>冒险笔记（图鉴）· 笔记本主题样张</title>
<link rel="stylesheet" href="./check.css">
<style>html,body{margin:0;height:100%;background:#172d2a;overflow:hidden}
#ui-windows{position:fixed;inset:0}</style>
<body><div id="ui-windows"></div><script type="module" src="./check.js"></script></body></html>
`;
await fs.writeFile(path.join(output, 'index.html'), INDEX_HTML);

// 交互样张要能从这个目录直接打开：assets 与装配好的素材目录同源。
const link = path.join(output, 'assets');
try { await fs.symlink('../../../client/public-tms273/assets', link); }
catch (error) { assert.equal(error.code, 'EEXIST', `无法建立 assets 软链: ${error.message}`); }

// ---------------------------------------------------------------------------
// 5. 跑起来
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = (await fs.readdir(cache)).filter(name => name.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)))[0];
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || path.join(cache, installed, 'chrome-headless-shell-mac-arm64/chrome-headless-shell') });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [], failed = [], logs = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => logs.push(`${message.type()}: ${message.text()}`));
page.on('requestfailed', request => failed.push(`${request.url()} ${request.failure()?.errorText}`));
await page.route('**/*', async route => {
  const url = new URL(route.request().url());
  assert.equal(url.hostname, 'notebook.test', `harness 只应访问自己的 host: ${url}`);
  const pathname = decodeURIComponent(url.pathname);
  if (pathname === '/notebook-ui/') return route.fulfill({ contentType: 'text/html', body: INDEX_HTML });
  const file = pathname.startsWith('/notebook-ui/assets/')
    ? path.join(root, 'client/public-tms273', pathname.slice('/notebook-ui/'.length))
    : path.join(output, path.basename(pathname));
  await route.fulfill({
    body: await fs.readFile(file),
    contentType: ({ '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream',
  });
});

const box = selector => page.locator(selector).first().boundingBox();
/** 计算后的前景/背景对比度。
 *
 *  槽位牌是**位图**不是 CSS 背景，所以底色由调用方给源实测值：把元素自己的
 *  背景色（可能是半透明的）合成到那个底色上，再算 WCAG 对比度。不去向上找
 *  DOM 祖先的底色——那会找到 harness 的页面底色，量的就不是玩家看到的那层了。
 *
 *  `asFill` 用于图形指示（角标这种没有文字的圆点）：它的「前景」不是 `color`
 *  而是元素自己那层底色，底则是外面的 fallback。按文本量它只会得到 1.00:1，
 *  因为圆点的 `color` 是 transparent（文字被 `font-size: 0` 藏掉了）。 */
const contrast = (selector, fallback, asFill = false) => page.evaluate(([sel, fallback, asFill]) => {
  /** 认 `#rgb`/`#rrggbb`/`#rrggbbaa` 与 `rgb()/rgba()` 两种写法：
   *  调用方给的源实测底色写作十六进制，元素自己的计算色是 `rgb()`。 */
  const parse = text => {
    const value = String(text).trim();
    if (value.startsWith('#')) {
      const hex = value.slice(1);
      const full = hex.length <= 4 ? [...hex].map(char => char + char).join('') : hex;
      const at = index => (index + 2 <= full.length ? parseInt(full.slice(index, index + 2), 16) : 0);
      return [at(0), at(2), at(4), full.length >= 8 ? at(6) / 255 : 1];
    }
    const parts = value.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];
    return [parts[0], parts[1], parts[2], parts[3] ?? 1];
  };
  const luminance = ([r, g, b]) => {
    const channel = value => { const v = value / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const node = document.querySelector(sel);
  if (!node) return null;
  const style = getComputedStyle(node);
  const base = parse(fallback);
  const own = parse(style.backgroundColor);
  const ownSolid = own[3] >= 1 ? own : [0, 1, 2].map(i => own[i] * own[3] + base[i] * (1 - own[3]));
  const fg = parse(style.color);
  const fgSolid = asFill ? ownSolid : (fg[3] >= 1 ? fg : [0, 1, 2].map(i => fg[i] * fg[3] + ownSolid[i] * (1 - fg[3])));
  const bgSolid = asFill ? base : ownSolid;
  const [light, dark] = [luminance(fgSolid), luminance(bgSolid)].sort((a, b) => b - a);
  return { ratio: (light + 0.05) / (dark + 0.05), color: style.color, background: style.backgroundColor };
}, [selector, fallback, asFill]);

const ratio = async (selector, fallback, label, minimum = 4.5, asFill = false) => {
  const result = await contrast(selector, fallback, asFill);
  assert(result, `找不到 ${selector}`);
  assert.ok(result.ratio >= minimum,
    `${label} 对比度只有 ${result.ratio.toFixed(2)}:1（${asFill ? 'fill' : 'color'} ${result.color} / bg ${result.background}），低于 ${minimum}:1`);
  return result.ratio;
};

try {
  await page.goto('http://notebook.test/notebook-ui/');
  await page.waitForFunction(() => window.__view && window.__data && document.body.dataset.ready === 'true');
  await page.waitForFunction(() => document.querySelectorAll('.notebook-monster-slot').length > 0);
  await page.evaluate(() => new Promise(resolve => { const done = () => document.querySelectorAll('.notebook-sheet-board').length && resolve(); done() || setTimeout(done, 50); }));

  // 1 — 窗口与源坐标：底板、页签、分隔线、索引栏、内容视口、分页
  const frame = await box('.notebook-window');
  assert.deepEqual([frame.width, frame.height], [891, 664], '窗口必须是源的 891x664');
  const near = (actual, expected, what) => {
    for (const key of ['x', 'y', 'width', 'height']) {
      assert.ok(Math.abs(actual[key] - expected[key]) <= 1, `${what}.${key} got ${actual[key]} want ${expected[key]}`);
    }
  };
  const at = (selector, x, y, w, h) => box(selector).then(value => near(value, { x: frame.x + x, y: frame.y + y, width: w, height: h }, selector));

  await at('.notebook-tabs', 22, 82, 847, 28);
  await at('.notebook-tab-rule', 13, 110, 865, 8);
  await at('.notebook-side', 19, 119, 182, 524);
  await at('.notebook-content', 204, 120, 666, 480);
  await box('.notebook-pager').then(value => assert.equal(Math.round(value.y - frame.y), 604, '分页行必须落在源的 y604'));
  await box('.notebook-backgrnd').then(value => near(value, { x: frame.x, y: frame.y, width: 891, height: 664 }, 'backgrnd'));
  assert.equal(await page.locator('.notebook-tab').count(), 4, '窗口必须有四个页签');
  // 源里有一个地区没有名字（`regions[100]`）。索引按钮若跟着留白，就是一个
  // 认不出来的空按钮；也不该给它编名字，所以标出「源未命名」这件事。
  const blankRegions = await page.evaluate(() => [...document.querySelectorAll('.notebook-region')]
    .filter(node => !(node.textContent ?? '').trim()).length);
  assert.equal(blankRegions, 0, '索引按钮不能有空的（源未命名的地区要标出来）');
  assert.equal(await page.locator('.notebook-tab-rule').count(), 1, '页签下缘的分隔线来自源素材，只有一条');
  const ruleSrc = await page.locator('.notebook-tab-rule').evaluate(node => node.getAttribute('src'));
  assert.match(ruleSrc, /layer_tab_line/, '分隔线必须用源 layer:tab_line，不是自绘的边框');

  // 2 — 进度读数用源位图数字，不是 DOM 文本（0 与 1550 共五位）
  assert.equal(await page.locator('.notebook-progress-digits img').count(), 5, '0 / 1550 共五位源位图数字');
  const digitSrc = await page.locator('.notebook-progress-digits img').first().evaluate(node => node.getAttribute('src'));
  assert.match(digitSrc, /number_0/, '进度读数必须是源 number/0 位图');

  // 3 — 相册页：板、页签卡、注记卡都在源板的实测位置上
  assert.equal(await page.locator('.notebook-sheet').count(), 2, '两个源分頁应当排成两张相册页');
  await box('.notebook-sheet-board').then(value => assert.deepEqual([value.width, value.height], [666, 520], '相册板必须是源 666x520'));
  await at('.notebook-sheet-card', 204 + 518, 120 + 66, 129, 162);
  await at('.notebook-sheet-note', 204 + 518, 120 + 232, 129, 248);
  const second = await page.locator('.notebook-sheet').nth(1).boundingBox();
  assert.equal(Math.round(second.y - frame.y - 120 - 480), 4, '第二张相册页紧跟第一张，间距就是样式表里的 4px');

  // 4 — 核心几何：每个槽位都贴在源相册板烤着的瓦片上（±1px）
  {
    const slots = await page.evaluate(() => [...document.querySelectorAll('.notebook-monster-row')].map(row => (
      [...row.querySelectorAll('.notebook-monster-slot')].map(node => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })
    )));
    assert.equal(slots.length, 10, '两张板共十行');
    // 槽位必须是行的 grid **直接**子项。曾经 `rowStrip()` 把它们包进一个
    // `.notebook-monster-slots`，那一层就独自吃掉第 1 格，5 个槽位在 68px 里
    // 折行成一列——窗口、板、列距全对，只有槽位整体偏到最左边。这类失效靠
    // 逐格对瓦片的断言能发现，但下面这条能直接说出原因。
    const strays = await page.evaluate(() => [...document.querySelectorAll('.notebook-monster-row')]
      .flatMap(row => [...row.children]
        .filter(node => !node.classList.contains('notebook-slot') && getComputedStyle(node).position !== 'absolute')
        .map(node => node.className || node.tagName)));
    assert.deepEqual(strays, [], `行里除绝对定位的行名外不该有别的东西，它们会占掉 grid 的格位：${strays.join(' | ')}`);
    const rowHeight = (await box('.notebook-monster-row')).height;
    assert.ok(Math.abs(rowHeight - 68) <= 1, `一行只有一格高，实测 ${rowHeight}（360 就说明槽位被挤成了一列）`);
    if (process.env.NB_DEBUG) {
      slots.forEach((line, index) => {
        process.stdout.write(`  row#${index} count=${line.length} x=[${line.map(slot => slot.x.toFixed(1)).join(', ')}] y=${line[0]?.y.toFixed(1)}\n`);
      });
      const rows = await box('.notebook-monster-rows');
      const row = await box('.notebook-monster-row');
      process.stdout.write(`  frame=${frame.x},${frame.y} 瓦片列=[${tileCols.join(', ')}] 瓦片行=[${tileRows.join(', ')}] 尺寸=${tileSize}\n`);
      process.stdout.write(`  rows容器=${rows.width}x${rows.height} 单行=${row.width}x${row.height}（单行高应当是 68；是 360 就说明槽位又被套进一层容器挤成了一列）\n`);
    }
    const expected = [];
    for (let row = 0; row < 5; row += 1) {
      for (let col = 0; col < 5; col += 1) expected.push({ x: tileCols[col], y: tileRows[row], size: tileSize });
    }
    for (const [sheetIndex, sheet] of [slots.slice(0, 5), slots.slice(5, 10)].entries()) {
      sheet.forEach((line, row) => {
        line.forEach((slot, col) => {
          assert.equal(slot.width, 68, '槽位必须是 68x68');
          assert.equal(slot.height, 68);
          const wantX = frame.x + 204 + expected[row * 5 + col].x;
          const wantY = frame.y + 120 + sheetIndex * 484 + expected[row * 5 + col].y;
          assert.ok(Math.abs(slot.x - wantX) <= 1, `第${sheetIndex + 1}板 行${row} 列${col} 的槽位没贴在源瓦片上: x=${slot.x} 期望 ${wantX}`);
          assert.ok(Math.abs(slot.y - wantY) <= 1, `第${sheetIndex + 1}板 行${row} 列${col} 的槽位没贴在源瓦片上: y=${slot.y} 期望 ${wantY}`);
        });
      });
    }
  }

  // 5 — 槽位底板来自源帧；且**没有**任何 filter 把图压暗（改造前的主因）
  const plateSrc = await page.locator('.notebook-monster-slot .notebook-slot-plate').first().evaluate(node => node.getAttribute('src'));
  assert.match(plateSrc, /monsterGrade_empty/, '怪物槽位底板必须用源 Collection/monsterGrade/empty');
  const filters = await page.evaluate(() => [...document.querySelectorAll('.notebook-slot-art')]
    .map(node => getComputedStyle(node).filter).filter(value => value && value !== 'none'));
  assert.deepEqual(filters, [], `槽位图不该再被 filter 压暗：${filters.join(' | ')}`);

  // 6 — 可读性：白纸上的字是墨色，深板上的字是浅色，逐处量对比度
  const contrasts = {};
  contrasts.region = await ratio('.notebook-region:not([data-active="true"])', '#ffffff', '索引条目');
  contrasts.regionActive = await ratio('.notebook-region[data-active="true"]', '#ffffff', '选中的索引条目');
  contrasts.rowName = await ratio('.notebook-monster-row-name', rowNameBacking, `行名（底 ${rowNameBacking} 取自源板留白带）`, 4.4);
  contrasts.slotLabel = await ratio('.notebook-monster-slot .notebook-slot-label', '#227788', '怪物名');
  contrasts.sheetTitle = await ratio('.notebook-sheet-title', '#333333', '页签卡标题');
  contrasts.sheetLegend = await ratio('.notebook-sheet-legend', '#333333', '图例');
  contrasts.noteText = await ratio('.notebook-sheet-note .notebook-note', '#333333', '注记卡正文');
  contrasts.progressNote = await ratio('.notebook-progress-note', '#ffffff', '进度说明');
  // 顶栏标题压在源窗口那条 a≈187 的半透明黑带与白纸的交界上：底取最亮的
  // 可能（源白纸 #ffffff），标题自己那层 rgba(0,0,0,.62) 由 contrast() 合成。
  contrasts.windowTitle = await ratio('.notebook-title', '#ffffff', '窗口标题（底＝源白纸，最坏情况）');

  // 6b — 计划要求「保留条目…明确标出当前版本尚不可收集」，所以每格都得有
  // 可核验的标记，且标记本身要看得见（非文本指示 3:1）。角标的底是压暗后的
  // 槽位牌：#228899 @0.45 叠板面 #222 ⇒ #225058（两个数都是实测/实测合成）。
  const flagCounts = await page.evaluate(() => {
    const slots = [...document.querySelectorAll('.notebook-monster-slot')];
    return {
      uncollectable: slots.filter(node => node.dataset.collectable === 'false').length,
      flagged: slots.filter(node => node.dataset.collectable === 'false' && node.querySelector('.notebook-slot-flag')).length,
      collectableFlagged: slots.filter(node => node.dataset.collectable === 'true' && node.querySelector('.notebook-slot-flag')).length,
    };
  });
  assert.ok(flagCounts.uncollectable > 0, '这版目录里应当有「尚不可收集」的条目');
  assert.equal(flagCounts.flagged, flagCounts.uncollectable, '每个「尚不可收集」的条目都要带角标（计划：明确标出，不静默丢弃）');
  assert.equal(flagCounts.collectableFlagged, 0, '「本版可收集」的条目不该带「尚不可收集」角标');
  contrasts.notYetFlag = await ratio('.notebook-slot-flag', '#225058', '「尚不可收集」角标（底＝压暗后的源槽位牌）', 3, true);
  await page.screenshot({ path: path.join(output, 'monster-1440x900.png') });

  // 7 — 换成装备页签：点页签真的换页，格架 6 列 x 60 格、不横向溢出
  await page.locator('.notebook-tab').nth(1).click();
  await page.waitForFunction(() => document.querySelectorAll('.notebook-item-slot').length > 0);
  assert.equal(await page.locator('.notebook-item-slot').count(), 60, '一页就是服务端的 60 格');
  const columns = await page.evaluate(() => getComputedStyle(document.querySelector('.notebook-item-grid')).gridTemplateColumns.split(' ').length);
  assert.equal(columns, 6, '物品格架必须是 6 列（7 列会横向溢出）');
  const firstRow = await page.evaluate(() => {
    const slots = [...document.querySelectorAll('.notebook-item-slot')].slice(0, 7).map(node => node.getBoundingClientRect());
    return slots.map(rect => ({ y: Math.round(rect.y), x: Math.round(rect.x), width: Math.round(rect.width) }));
  });
  assert.equal(new Set(firstRow.slice(0, 6).map(slot => slot.y)).size, 1, '前六格必须在同一行');
  assert.notEqual(firstRow[6].y, firstRow[0].y, '第七格必须换行（6 列的证明）');
  assert.ok(firstRow.every(slot => slot.width === 94), '物品槽位必须是源的 94x94');
  const overflow = await page.evaluate(() => {
    const content = document.querySelector('.notebook-content');
    return { contentX: content.scrollWidth - content.clientWidth, page: document.documentElement.scrollWidth - innerWidth };
  });
  assert.equal(overflow.contentX, 0, `内容区不该横向溢出（差 ${overflow.contentX}px）`);
  assert.equal(overflow.page, 0, `页面不该横向溢出（差 ${overflow.page}px）`);
  const wells = await page.locator('.notebook-item-slot .notebook-slot-well').count();
  assert.equal(wells, 60, '每个物品格都要有纸色孔位');
  const itemPlate = await page.locator('.notebook-item-slot .notebook-slot-plate').first().evaluate(node => node.getAttribute('src'));
  assert.match(itemPlate, /itemComplete|itemIncomplete/, '物品槽位牌必须来自源 itemCollection');
  contrasts.itemLabel = await ratio('.notebook-item-slot .notebook-slot-label', '#554433', '物品名');
  contrasts.headTitle = await ratio('.notebook-sheet-head-title', '#443322', '页眉丝带标题');
  await page.screenshot({ path: path.join(output, 'equipment-1440x900.png') });

  // 8 — 一个「已获得」的物品孔位必须比未获得的更亮（源牌子的聚光灯语义）
  {
    const brightness = await page.evaluate(() => {
      const sum = node => {
        const rect = node.getBoundingClientRect();
        return rect.width * rect.height;
      };
      return [...document.querySelectorAll('.notebook-item-slot')].map(node => ({
        obtained: node.dataset.obtained === 'true',
        opacity: Number(getComputedStyle(node.querySelector('.notebook-slot-plate')).opacity),
        area: sum(node),
      }));
    });
    const obtained = brightness.filter(entry => entry.obtained);
    const missing = brightness.filter(entry => !entry.obtained);
    assert.equal(obtained.length, 12, '前 12 件是已获得');
    assert.ok(obtained.every(entry => entry.opacity === 1), '已获得的牌子必须全亮');
    assert.ok(missing.every(entry => entry.opacity < 1), '未获得的牌子必须压暗，否则两种状态分不开');
  }

  // 9 — 视口：四档尺寸都不溢出，窄屏切流式布局
  for (const [width, height] of [[1440, 900], [1024, 768], [844, 390], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.locator('.notebook-tab').first().click();
    await page.waitForTimeout(60);
    const state = await page.evaluate(() => ({
      compact: document.querySelector('.notebook-window').classList.contains('notebook-compact'),
      pageOverflow: document.documentElement.scrollWidth - innerWidth,
      tabs: document.querySelectorAll('.notebook-tab').length,
      pager: document.querySelectorAll('.notebook-pager button').length,
      box: document.querySelector('.notebook-window').getBoundingClientRect().toJSON(),
    }));
    if (process.env.NB_DEBUG) {
      const host = await page.evaluate(() => {
        const node = document.querySelector('#ui-windows');
        const rect = node.getBoundingClientRect();
        return { id: node.id, style: getComputedStyle(node).cssText ? `${getComputedStyle(node).position}/${getComputedStyle(node).height}` : '-', rect: [rect.width, rect.height], body: [document.body.scrollWidth, document.body.clientHeight] };
      });
      process.stdout.write(`viewport ${width}x${height} compact=${state.compact} box=${state.box.width.toFixed(1)}x${state.box.height.toFixed(1)} @${state.box.x.toFixed(1)},${state.box.y.toFixed(1)} host=${JSON.stringify(host)}\n`);
    }
    assert.equal(state.pageOverflow, 0, `${width}x${height} 不该横向溢出`);
    assert.equal(state.compact, width < 900 || height < 690, `${width}x${height} 的紧凑布局判定不对`);
    assert.equal(state.tabs, 4, `${width}x${height} 必须保住四个页签`);
    assert.ok(state.pager >= 2, `${width}x${height} 必须保住分页按钮`);
    assert.ok(state.box.width <= width + 1 && state.box.height <= height + 1, `${width}x${height} 窗口不能超出视口`);
    await page.screenshot({ path: path.join(output, `viewport-${width}x${height}.png`) });
  }

  const broken = failed.filter(line => !line.includes('ERR_ABORTED'));
  assert.deepEqual(broken, [], '每个素材都必须能载入');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({
    check: 'PASS 冒险笔记（图鉴）UI',
    window: '891x664 @ source coords',
    albumTiles: `${tileCols.join('/')} x ${tileRows.join('/')} (${tileSize}px)`,
    slotsAligned: 50,
    itemGrid: '6 x 10 = 60',
    contrast: Object.fromEntries(Object.entries(contrasts).map(([key, value]) => [key, Number(value.toFixed(2))])),
    evidence: output,
  }, null, 2));
} catch (error) {
  // 浏览器里发生的事在 Node 这一侧看不到，失败时把它带出来。
  if (logs.length) console.error(`浏览器控制台:\n${logs.join('\n')}`);
  if (errors.length) console.error(`页面异常:\n${errors.join('\n')}`);
  if (failed.length) console.error(`请求失败:\n${failed.join('\n')}`);
  throw error;
} finally { await browser.close(); }
