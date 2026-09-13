import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, 'view.ts');
const stylePath = path.join(here, 'style.css');
const source = fs.readFileSync(sourcePath, 'utf8');
const style = fs.readFileSync(stylePath, 'utf8');
const appStyle = fs.readFileSync(path.join(here, '../../app/style.css'), 'utf8');
const mainSource = fs.readFileSync(path.join(here, '../../app/main.ts'), 'utf8');
const hudSource = fs.readFileSync(path.join(here, '../hud/view.ts'), 'utf8');

// The check intentionally stays offline: it exercises the exported catalogue
// filter without constructing a browser window or contacting the game server.
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replace(/^import .*?;\s*$/gm, '');
const module = await import(`data:text/javascript,${encodeURIComponent(javascript)}`);

assert.deepEqual(module.itemIdKeys('2430768'), ['2430768', '02430768']);
assert.equal(module.cashItemFamily('01002067'), 100);

const rows = [
  { sn: 'a', itemId: '01002067', count: 1, price: 100, bonus: 0, period: 0, gender: 2, reqLevel: 0, reqPop: 0, priority: 2, limit: 0, refundable: true, tab: 'fashion' },
  { sn: 'b', itemId: '05000001', count: 1, price: 500, bonus: 0, period: 0, gender: 2, reqLevel: 0, reqPop: 0, priority: 1, limit: 0, refundable: true, tab: 'pet' },
  { sn: 'c', itemId: '02430768', count: 1, price: 100, bonus: 0, period: 0, gender: 2, reqLevel: 0, reqPop: 0, priority: 3, limit: 0, refundable: true, tab: 'home' },
  { sn: 'd', itemId: '01002068', count: 1, price: 0, bonus: 0, period: 0, gender: 2, reqLevel: 0, reqPop: 0, priority: 4, limit: 0, refundable: true, tab: 'home' },
  { sn: 'e', itemId: '09100001', count: 1, price: 50, bonus: 0, period: 0, gender: 2, reqLevel: 0, reqPop: 0, priority: 5, limit: 0, refundable: true, tab: 'home' },
];
const names = new Map([
  ['01002067', '帽子時裝'],
  ['05000001', '小寵物'],
  ['02430768', '裝備欄位擴充券'],
  ['01002068', '未售出'],
  ['09100001', '楓點充值'],
]);
const nameOf = id => names.get(id) ?? id;
assert.deepEqual(module.filterCashCommodities(rows, 'fashion', '', { id: 'cap', label: '帽子', families: [100] }, nameOf).map(row => row.sn), ['a']);
assert.deepEqual(module.filterCashCommodities(rows, 'search', '擴充', undefined, nameOf).map(row => row.sn), ['c']);
assert.deepEqual(module.filterCashCommodities(rows, 'home', '', undefined, nameOf).map(row => row.sn), ['c']);
assert.deepEqual(module.filterCashCommodities(rows, 'search', '', undefined, nameOf), []);

const assembled = JSON.parse(fs.readFileSync(path.join(here, '../../../public-tms273/assets/cashshop.json'), 'utf8'));
const assembledNames = assembled.itemNames ?? {};
const assembledName = id => assembledNames[id] ?? id;
assert.ok(assembled.commodities.some(row => row.tab === 'fashion'), 'assembled catalogue has fashion rows');
assert.ok(assembled.commodities.some(row => row.tab === 'pet'), 'assembled catalogue has pet rows');
for (const itemId of ['02430768', '02430769', '02430770', '02430771']) {
  assert.ok(assembled.commodities.some(row => row.itemId === itemId), `assembled catalogue has ${itemId}`);
}
assert.equal(module.filterCashCommodities(assembled.commodities, 'search', '楓葉點數交換券', undefined, assembledName).length, 0);

assert.match(source, /syncPlayer\(player: PlayerState\)/);
assert.match(source, /this\.pending\.set\(requestId/);
assert.match(source, /pending\.source === 'cart'/);
assert.match(source, /row\.quantity -= pending\.quantity/);
assert.match(source, /image\.addEventListener\('error'/);
assert.match(source, /appearanceLayer\(catalog, entry\.itemId\)/);
assert.match(source, /appearanceWeaponType\(catalog, equipment, player\.appearance\.weapon\)/);
assert.doesNotMatch(source, /sourceImage\('backgrnd2'/);
assert.match(source, /availableWidth >= 1024 && availableHeight >= 768/);
assert.match(style, /\.cash-shop-sidebar[\s\S]*?left: 0;/);
assert.match(style, /\.cash-shop\s*\{[^}]*pointer-events:\s*auto;/, 'cash shop must re-enable events inside the shared inert overlay');
assert.match(style, /\.cash-shop-balance[\s\S]*?left: 704px/);
assert.match(style, /\.cash-shop-toolbar[\s\S]*?left: 136px[\s\S]*?width: 493px/);
assert.match(style, /data-tab='fashion'[\s\S]*?\.cash-shop-grid[\s\S]*?top: 108px/);
assert.match(style, /\.cash-shop\[data-layout='reflow'\]/);
assert.doesNotMatch(style, /top:\s*150px/);
assert.doesNotMatch(style, /left:\s*96px/);
assert.match(appStyle, /#game-shell>#ui-windows\{[^}]*pointer-events:none/);
assert.match(mainSource, /function openCashShop\(\)[\s\S]*?cashShop\?\.syncPlayer\(selfState\)[\s\S]*?cashShop\?\.open\(\)/);
assert.match(mainSource, /cashShop\?\.isOpen\(\)/, 'game input must be blocked while the cash shop is open');
assert.match(hudSource, /\['CashShop',\s*'商店'\]/);
assert.match(hudSource, /key === 'CashShop'[\s\S]*?options\.openCashShop\?\.\(\)/);

console.log(JSON.stringify({
  ok: true,
  itemIdAliases: true,
  filterRows: { fashionCap: 1, search: 1, home: 1, blankSearch: 0 },
  sourceShell: '1024x768 base artwork with 31px top bar',
  sourceSidebar: '126x370 / 10 rows × 37px',
  narrowLayout: 'flex column reflow with scrollable grid, preview and cart',
}, null, 2));

// Exercise the actual fitting method with positioned geometry: shrinking or
// switching layouts must keep the grabbed window inside its current host.
const shellSource = fs.readFileSync(path.join(here, '../ui/window-shell.ts'), 'utf8');
const shellJs = ts.transpileModule(shellSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const shell = await import(`data:text/javascript,${encodeURIComponent(shellJs)}`);
globalThis.clampIntoHost = shell.clampIntoHost;
globalThis.window = { innerWidth: 1440, innerHeight: 1000 };
let hostSize = { width: 1440, height: 1000, left: 20, top: 10 };
const root = {
  dataset: { windowPositioned: 'true' },
  style: { left: '400px', top: '220px', transform: 'none' },
  getBoundingClientRect() { return { left: hostSize.left + parseFloat(this.style.left), top: hostSize.top + parseFloat(this.style.top), width: parseFloat(this.style.width), height: parseFloat(this.style.height) }; },
};
const shop = Object.create(module.CashShopView.prototype);
shop.root = root;
shop.host = { getBoundingClientRect: () => hostSize };
for (const [width, height] of [[1440,1000], [1200,700], [844,390], [390,844], [1440,1000]]) {
  hostSize = { ...hostSize, width, height };
  shop.fitRootToHost();
  const box = root.getBoundingClientRect();
  assert(box.left >= hostSize.left && box.top >= hostSize.top);
  assert(box.left + box.width <= hostSize.left + width && box.top + box.height <= hostSize.top + height);
  assert.equal(root.style.transform, 'none', 'resizing never recentres a dragged window');
}
assert.match(source, /const CASH_SHOP_TITLE_HEIGHT = 31/);
assert.match(source, /titleHeight: CASH_SHOP_TITLE_HEIGHT/);
assert.match(source, /root.addEventListener\('pointerdown', this.activate\)/);
assert.match(source, /removeEventListener\('pointerdown', this.activate\)/);
assert.match(style, /\.cash-shop-drag-handle\s*\{[^}]*touch-action:\s*none;/);
assert.doesNotMatch(style, /width: calc\(100% - 12px\) !important/);
console.log('Cash shop window: title-only drag wiring, activation/disposal and five resize transitions passed.');
