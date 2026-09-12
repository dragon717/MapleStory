import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from '../client/node_modules/typescript/lib/typescript.js';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const source = fs.readFileSync(`${root}/client/src/features/inventory/names.ts`, 'utf8')
  .replace("import { uiLocale, displayText } from '../../app/i18n';", "const uiLocale = () => globalThis.testLocale; const displayText = text => text;")
  .replace("import catalog from '../../../../shared/items.json';", `const catalog = ${fs.readFileSync(`${root}/shared/items.json`, 'utf8')};`);
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const names = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
globalThis.testLocale = 'zh';
assert.equal(names.itemName('2000000'), '紅色藥水');
assert.match(names.itemDetails('2000000'), /恢復HP約50/);
assert.match(names.itemDetails('1002067'), /需要等级: 5/);
const upgraded = names.itemDetails('1002067', { slot: 1, itemId: '1002067', quantity: 1, stats: { incPDD: 10 }, remainingSlots: 0, upgradeCount: 1 });
assert.match(upgraded, /物理防御: 10/);
assert.match(upgraded, /可升级次数: 0/);
assert.match(upgraded, /\(\+1\)/);
assert.equal(names.equipmentSlot('1002067'), 1);
assert.equal(names.equipmentSlot('1040002'), 5);
assert.equal(names.equipmentSlot('1302000'), 11);
assert.equal(names.equipmentSlot('unknown'), undefined);
const candidate = { slot: 2, itemId: '1002067', quantity: 1, stats: { incPDD: 0, incINT: 5, incMAD: 7 } };
const current = { slot: 1, itemId: '1002043', quantity: 1, stats: { incPDD: 10, incINT: 2, incMAD: 3 } };
const comparison = names.itemComparisonDetails(candidate, current);
assert.match(comparison, /当前同部位：青銅頭盔/);
assert.match(comparison, /物理防御: 当前 10 → 候选 0 \(-10\)/);
assert.match(comparison, /智力: 当前 2 → 候选 5 \(\+3\)/);
assert.match(comparison, /魔法攻击力: 当前 3 → 候选 7 \(\+4\)/);
const noEquipped = names.itemComparisonDetails(candidate, null);
assert.match(noEquipped, /当前同部位：无已装备/);
assert.doesNotMatch(noEquipped, /物理防御/);
const differentSlot = names.itemComparisonDetails(candidate, { slot: 11, itemId: '1302000', quantity: 1 });
assert.match(differentSlot, /当前同部位：无已装备/);
const sameInstance = names.itemComparisonDetails(current, current);
assert.match(sameInstance, /物理防御: 当前 10 → 候选 10 \(0\)/);
const unknownComparison = names.itemComparisonDetails({ slot: 3, itemId: 'unknown', quantity: 1 }, null);
assert.match(unknownComparison, /装备部位：未知/);
const finalValues = names.itemDetails('1302000', {
  slot: 11, itemId: '1302000', quantity: 1, stats: { incPAD: 0, incMAD: 13, incINT: 7 },
});
assert.doesNotMatch(finalValues, /攻击力: 15/);
assert.match(finalValues, /魔法攻击力: 13/);
assert.match(finalValues, /智力: 7/);
// The tab sequence mirrors the source tab:category/<n> frame order:
// 0 裝備 / 1 消耗 / 2 其他 / 3 裝飾 / 4 現金 — *not* a straight inventoryType-1.
assert.equal(names.itemCategoryTab('4000019'), 2); // 4xxxx = Etc → tab 2 "其他"
assert.equal(names.itemCategoryTab('01302000'), 0); // 1xxxx = 裝備 → tab 0
assert.equal(names.itemCategoryTab('2000000'), 1); // 2xxxx = 消耗 → tab 1
assert.equal(names.itemCategoryTab('3000000'), 3); // 3xxxx = 裝飾 → tab 3
assert.equal(names.itemCategoryTab('5000000'), 4); // 5xxxx = 現金 → tab 4
assert.equal(names.itemCategoryTab('10000001'), 2); // unknown numeric id falls through to 其他
assert.equal(names.itemCategoryTab('1bad'), 2);
assert.equal(names.itemName('unknown'), 'unknown');
globalThis.testLocale = 'en';
assert.equal(names.itemName('2000000'), '紅色藥水');
assert.match(names.itemDescription('2000000'), /恢復HP/);
assert.match(names.itemDetails('1002067'), /Required level: 5/);
console.log('Inventory source metadata, Chinese/English labels and tooltip checks passed.');
const i18n = ts.transpileModule(fs.readFileSync(`${root}/client/src/app/i18n.ts`, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace("import OpenCC from 'opencc-js/t2cn';", "const OpenCC = { Converter: () => text => text };");
for (const [search, expected] of [['', 'zh'], ['?lang=en', 'en'], ['?lang=zh', 'zh']]) {
  globalThis.window = { location: { search } };
  const module = await import(`data:text/javascript;base64,${Buffer.from(i18n).toString('base64')}#${expected}${search}`);
  assert.equal(module.uiLocale(), expected);
  assert.equal(module.uiText('inventoryTitle'), expected === 'zh' ? '物品栏' : 'Inventory');
  assert.equal(module.mapText('000010000', 'unknown'), 'unknown');
}
console.log('Default Chinese and explicit language selection passed.');

// The source-authored tab canvas (UI/UIInventory.img/Inventory) draws the five
// tabs in the order 裝備 / 消耗 / 其他 / 裝飾 / 現金, with the frame for
// 裝飾 numbered *before* the frame for 其他-adjacent 現金 — i.e. frame 4
// precedes frame 3.  These assertions pin the view constants to that source
// order so a future reshuffle cannot silently reintroduce the straight ±1
// mapping that once put 其他 items under 現金 and 裝飾 items under 其他.
// The tab constants moved to features/inventory/view-model.ts in the R4 split
// (plan §8.2); the pin follows the declaration, the source order it protects
// is unchanged.
const viewModelSource = fs.readFileSync(`${root}/client/src/features/inventory/view-model.ts`, 'utf8');
const labelsMatch = viewModelSource.match(/const TAB_LABEL_KEYS = \[([^\]]+)\] as const/);
assert.ok(labelsMatch, 'view-model.ts must keep an explicit TAB_LABEL_KEYS order');
const labels = labelsMatch[1].split(',').map(part => part.trim().replace(/^'|'$/g, ''));
assert.deepEqual(
  labels,
  ['inventoryEquip', 'inventoryUse', 'inventoryEtc', 'inventorySetup', 'inventoryCash'],
  'tab order must mirror the source frame sequence 裝備/消耗/其他/裝飾/現金',
);
const typeMatch = viewModelSource.match(/const TAB_INVENTORY_TYPE: Readonly<Record<number, number>> = \{([\s\S]*?)\};/);
assert.ok(typeMatch, 'view-model.ts must keep an explicit TAB_INVENTORY_TYPE map');
const tabTypeEntries = Object.fromEntries(
  typeMatch[1].split('\n')
    .map(line => line.match(/(\d+):\s*(\d+)/))
    .filter(Boolean)
    .map(match => [match[1], Number(match[2])]),
);
assert.deepEqual(
  tabTypeEntries,
  { 0: 1, 1: 2, 2: 4, 3: 3, 4: 5 },
  'visible tab -> server inventoryType must be 1/2/4/3/5 (frame 4 before frame 3)',
);
// The manifest must actually carry the five source frames the view renders,
// in both compact and expanded window modes.
const manifest = JSON.parse(fs.readFileSync(`${root}/client/public-tms273/assets/manifest.json`, 'utf8'));
for (const mode of ['AutoBuild', 'FullAutoBuild']) {
  for (const state of ['normal', 'selected']) {
    for (let index = 0; index < 5; index++) {
      assert.ok(
        manifest.inventoryUi?.[`${mode}/tab:category/${state}/${index}`],
        `inventoryUi must carry ${mode}/tab:category/${state}/${index}`,
      );
    }
  }
}
assert.equal(manifest.inventoryLayout?.categoryCount, 5, 'inventory layout must author five categories');
assert.equal(manifest.inventoryLayout?.small?.tabs?.count, 5, 'compact window must author five tabs');
assert.equal(manifest.inventoryLayout?.full?.tabs?.count, 5, 'expanded window must author five tabs');
// Slot-expansion coupons: the four TMS273 coupons must keep their icons (the
// grid skips rendering an item whose icon is missing) and their shop price.
for (const couponId of ['2430768', '2430769', '2430770', '2430771']) {
  assert.ok(manifest.items?.[couponId], `manifest.items must carry the coupon icon ${couponId}`);
}
console.log('Inventory tab frame order (4 before 3) and slot-expansion coupon assets verified.');
if (process.argv.includes('--browser-fixture')) {
  const { build } = await import('../client/node_modules/esbuild/lib/main.js');
  const output = `${root}/output/inventory-check`;
  fs.mkdirSync(output, { recursive: true });
  await build({ entryPoints: [`${root}/qa/inventory_ui.ts`], bundle: true, format: 'esm', target: 'es2022', outfile: `${output}/inventory-check.js` });
  const assets = `${output}/assets`;
  if (!fs.existsSync(assets)) fs.symlinkSync(`${root}/client/public-tms273/assets`, assets, 'dir');
  fs.writeFileSync(`${output}/inventory-check.html`, '<!doctype html><html lang="zh"><meta charset="utf-8"><title>Inventory UI verification</title><link rel="stylesheet" href="/inventory-check.css"><script type="module" src="/inventory-check.js"></script></html>', 'utf8');
  console.log('Browser fixture ready at output/inventory-check/inventory-check.html (no account or game mutations).');
}
