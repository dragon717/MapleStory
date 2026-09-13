#!/usr/bin/env node
// view-model.check.mjs — 纯转换特征测试（计划 §8.3：页签/槽位/堆叠/装备实例）。
// 页签顺序是源美术事实（1,2,4,3,5），这里钉住；改规则需产品确认。

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;

// view-model 运行期只依赖 names.ts（而 names 依赖 i18n 与 items.json），
// 按 dialogue.check 的方式装进同一模块图：i18n 打桩、items.json 保真。
const itemsJson = await readFile(new URL('../../../../shared/items.json', import.meta.url), 'utf8');
const itemsUrl = `data:application/json;base64,${Buffer.from(itemsJson).toString('base64')}`;
const petsJson = await readFile(new URL('../../../../shared/pets.json', import.meta.url), 'utf8');
const petsUrl = `data:application/json;base64,${Buffer.from(petsJson).toString('base64')}`;
const namesCode = compile(await readFile(new URL('./names.ts', import.meta.url), 'utf8'))
  .replace(/import .* from '..\/..\/app\/i18n';/, "const uiLocale = () => 'zh', uiText = x => x, displayText = x => x;")
  .replace(/^import catalog from '.*items\.json';$/m, `import catalog from ${JSON.stringify(itemsUrl)} with { type: 'json' };`)
  .replace(/^import petCatalog from '.*pets\.json';$/m, `import petCatalog from ${JSON.stringify(petsUrl)} with { type: 'json' };`);
const namesUrl = `data:text/javascript;base64,${Buffer.from(namesCode).toString('base64')}`;

const code = compile(await readFile(new URL('./view-model.ts', import.meta.url), 'utf8'))
  .replace(/'\.\/names'/, JSON.stringify(namesUrl));
const vm = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

const item = (slot, itemId, quantity = 1) => ({ slot, itemId, quantity });

// 页签映射：可见页签 0..4 -> 服务器 inventoryType 1,2,4,3,5（非直线 +1）。
assert.deepEqual([0, 1, 2, 3, 4].map(vm.inventoryTypeForTab), [1, 2, 4, 3, 5]);
assert.equal(vm.TAB_INVENTORY_TYPE[2], 4, 'Etc 在装饰之前，这是源美术帧顺序');

// itemAtSlot：按可见页签（非 inventoryType）找槽位。
const inventory = [item(1, '1302000'), item(1, '2000000', 12), item(3, '4000000', 2)];
assert.equal(vm.itemAtSlot(inventory, 1, 0)?.itemId, '1302000', '装备页签 0 = type 1');
assert.equal(vm.itemAtSlot(inventory, 1, 1)?.itemId, '2000000', '消耗页签 1 = type 2');
assert.equal(vm.itemAtSlot(inventory, 1, 2), undefined, '其他页签 2 = type 4，槽 1 没有物品');
assert.equal(vm.itemAtSlot(inventory, 3, 2)?.itemId, '4000000');

// equippedAtSlot：装备实例 slot 为负号身体部位，按绝对值匹配。
const equipped = [{ slot: -11, itemId: '1302000', quantity: 1 }];
assert.equal(vm.equippedAtSlot(equipped, 11)?.itemId, '1302000');
assert.equal(vm.equippedAtSlot(equipped, 12), undefined);

// slotLimit：服务端容量覆盖，缺省回退布局默认。
const caps = { 2: 36 };
assert.equal(vm.slotLimit(caps, 1, 24), 36, '消耗页签用 type 2 的容量');
assert.equal(vm.slotLimit(caps, 0, 24), 24, '未扩容页签回退 backendSlotLimit');
assert.equal(vm.slotLimit({}, 2, 24), 24);

// comparisonTarget：同身体部位装备参与对比，非装备返回 undefined。
const worn = { slot: -1, itemId: '1002067', quantity: 1 };
assert.equal(vm.comparisonTarget(item(2, '1002043'), [worn])?.itemId, '1002067', '同是帽子 → 对比');
assert.equal(vm.comparisonTarget(item(2, '1002043'), []), null, '部位已知但没穿 → null');
assert.equal(vm.comparisonTarget(item(1, '2000000'), [worn]), undefined, '消耗品无部位 → undefined');

// cooldownSeconds：向上取整，服务端毫秒权威。
assert.equal(vm.cooldownSeconds(1), 1);
assert.equal(vm.cooldownSeconds(1000), 1);
assert.equal(vm.cooldownSeconds(1001), 2);

// slotsDataset：测试/工具读取格子的投影串（tab+1：1302000→1，2000000→2，4000000→其他页签+1=3）。
assert.equal(vm.slotsDataset(inventory), '1:1:1302000:1,2:1:2000000:12,3:3:4000000:2');
assert.equal(vm.slotsDataset([]), '');

// slotsSignature：物品、装备、冷却秒与容量任一变化都触发重绘；冷却只在秒数变化时触发。
const base = { inventory, equipped, potionCooldowns: { '2000000': 5000 }, inventorySlots: caps };
const signature = vm.slotsSignature(base);
assert.equal(vm.slotsSignature({ ...base }), signature, '同输入同签名');
assert.notEqual(vm.slotsSignature({ ...base, inventory: [...inventory, item(2, '4000001')] }), signature, '新物品改变签名');
assert.notEqual(vm.slotsSignature({ ...base, equipped: [] }), signature, '卸下装备改变签名');
assert.notEqual(vm.slotsSignature({ ...base, inventorySlots: { 2: 48 } }), signature, '扩容改变签名');
assert.equal(vm.slotsSignature({ ...base, potionCooldowns: { '2000000': 4500 } }), signature, '同秒内毫秒变化不触发重绘');
assert.notEqual(vm.slotsSignature({ ...base, potionCooldowns: { '2000000': 3500 } }), signature, '冷却秒变化触发重绘');

console.log('inventory view-model: tab mapping, slot lookups, signature stability passed.');
