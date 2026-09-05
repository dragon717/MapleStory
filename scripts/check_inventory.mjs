import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from '../client/node_modules/typescript/lib/typescript.js';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const source = fs.readFileSync(`${root}/client/src/features/inventory/names.ts`, 'utf8')
  .replace("import { uiLocale } from '../../app/i18n';", "const uiLocale = () => globalThis.testLocale;")
  .replace("import catalog from '../../../../shared/items.json';", `const catalog = ${fs.readFileSync(`${root}/shared/items.json`, 'utf8')};`);
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const names = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
globalThis.testLocale = 'zh';
assert.equal(names.itemName('2000000'), '红色药水');
assert.match(names.itemDetails('2000000'), /50 HP/);
assert.match(names.itemDetails('1002067'), /需要等级: 5/);
const upgraded = names.itemDetails('1002067', { slot: 1, itemId: '1002067', quantity: 1, stats: { incPDD: 10 }, remainingSlots: 0, upgradeCount: 1 });
assert.match(upgraded, /物理防御: 10/);
assert.match(upgraded, /可升级次数: 0/);
assert.match(upgraded, /\(\+1\)/);
assert.equal(names.itemCategoryTab('4000019'), 3);
assert.equal(names.itemCategoryTab('01302000'), 0);
assert.equal(names.itemCategoryTab('10000001'), 3);
assert.equal(names.itemCategoryTab('1bad'), 3);
assert.equal(names.itemName('unknown'), 'unknown');
globalThis.testLocale = 'en';
assert.equal(names.itemName('2000000'), 'Red Potion');
assert.match(names.itemDescription('2000000'), /\nRecovers 50 HP/);
assert.match(names.itemDetails('1002067'), /Required level: 5/);
console.log('Inventory source metadata, Chinese/English labels and tooltip checks passed.');
const i18n = ts.transpileModule(fs.readFileSync(`${root}/client/src/app/i18n.ts`, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
for (const [search, expected] of [['', 'zh'], ['?lang=en', 'en'], ['?lang=zh', 'zh']]) {
  globalThis.window = { location: { search } };
  const module = await import(`data:text/javascript;base64,${Buffer.from(i18n).toString('base64')}#${expected}${search}`);
  assert.equal(module.uiLocale(), expected);
  assert.equal(module.uiText('inventoryTitle'), expected === 'zh' ? '物品栏' : 'Inventory');
  assert.equal(module.mapText('000010000', 'unknown'), expected === 'zh' ? '蘑菇村' : 'Mushroom Town');
}
console.log('Default Chinese and explicit language selection passed.');
if (process.argv.includes('--browser-fixture')) {
  const { build } = await import('../client/node_modules/esbuild/lib/main.js');
  await build({ entryPoints: [`${root}/qa/inventory_ui.ts`], bundle: true, format: 'esm', target: 'es2022', outfile: `${root}/client/dist-next/inventory-check.js` });
  fs.writeFileSync(`${root}/client/dist-next/inventory-check.html`, '<!doctype html><html lang="zh"><meta charset="utf-8"><title>Inventory UI verification</title><link rel="stylesheet" href="/inventory-check.css"><script type="module" src="/inventory-check.js"></script></html>', 'utf8');
  console.log('Browser fixture ready at /inventory-check.html (no account or game mutations).');
}
