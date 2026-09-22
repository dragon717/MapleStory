#!/usr/bin/env node
// drag-controller.check.mjs — DragController 的意图路由检查（计划 §8.3）。
// 覆盖：dragstart 抑制条件、drop 意图路由（移动/丢弃/卸下/卷轴上装/装备使用）、
// 跨页签 drop 忽略、document 级拖出丢弃、**窗口外落点认领（HUD 快捷栏）不得丢弃**、
// 拖拽载荷读回、destroy 移除 document 监听。
// 真值经 DragHost 回调注入；names/view-model/i18n/items.json 经 data URL 装载。

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const b64 = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;

// ---- 依赖装载：i18n → shared/*.json → names → view-model → drag-controller ----
globalThis.window = { location: { search: '' } };
const i18nCode = compile(await readFile(new URL('../../app/i18n.ts', import.meta.url), 'utf8'))
  .replace("import OpenCC from 'opencc-js/t2cn';", 'const OpenCC = { Converter: () => text => text };');
const i18nUrl = b64(i18nCode);
// names.ts 依赖 shared/ 下的四张表。**按实际导入逐个**换成 data: URL 并补上
// Node ESM 要的 json 导入属性 —— 新加一张表时若忘了换，这里会以
// ERR_UNSUPPORTED_RESOLVE_REQUEST 整块炸掉（响亮），而不是静默漏掉一层回落。
let namesCode = compile(await readFile(new URL('./names.ts', import.meta.url), 'utf8'))
  .replaceAll("from '../../app/i18n'", `from '${i18nUrl}'`);
const sharedJson = [...new Set([...namesCode.matchAll(/from '\.\.\/\.\.\/\.\.\/\.\.\/shared\/([\w.-]+\.json)'/g)].map(match => match[1]))];
assert(sharedJson.length >= 4, `names.ts 的 shared/*.json 导入只认出 ${sharedJson.length} 张，装载器可能失效了`);
for (const file of sharedJson) {
  // JSON 必须是 application/json：Node 的 `with { type: 'json' }` 会校验 MIME。
  const url = `data:application/json;base64,${Buffer.from(await readFile(new URL(`../../../../shared/${file}`, import.meta.url), 'utf8')).toString('base64')}`;
  namesCode = namesCode.replaceAll(`from '../../../../shared/${file}'`, `from '${url}' with { type: 'json' }`);
}
const namesUrl = b64(namesCode);
const viewModelCode = compile(await readFile(new URL('./view-model.ts', import.meta.url), 'utf8'))
  .replaceAll("from './names'", `from '${namesUrl}'`);
const viewModelUrl = b64(viewModelCode);
const dragCode = compile(await readFile(new URL('./drag-controller.ts', import.meta.url), 'utf8'))
  .replaceAll("from './names'", `from '${namesUrl}'`)
  .replaceAll("from './view-model'", `from '${viewModelUrl}'`);
const { DragController, readInventoryDrag, hasInventoryDrag } = await import(b64(dragCode));

// ---- document stub（只覆盖 add/removeEventListener）----
globalThis.Node = class Node {};
const nodeTarget = (insideWindow, dropZone = false) => Object.assign(new globalThis.Node(), { insideWindow, dropZone });
const docListeners = new Map();
globalThis.document = {
  addEventListener(type, fn) {
    if (!docListeners.has(type)) docListeners.set(type, []);
    docListeners.get(type).push(fn);
  },
  removeEventListener(type, fn) {
    const list = docListeners.get(type);
    const index = list ? list.indexOf(fn) : -1;
    if (index >= 0) list.splice(index, 1);
  },
};
const emitDocument = (type, event) => {
  for (const fn of docListeners.get(type) ?? []) fn(event);
};
const docListenerCount = () => [...docListeners.values()].reduce((total, list) => total + list.length, 0);

// ---- 事件与元素 stub ----
const makeTransfer = () => {
  const data = new Map();
  return {
    types: [],
    setData(type, value) { data.set(type, String(value)); if (!this.types.includes(type)) this.types.push(type); },
    getData(type) { return data.get(type) ?? ''; },
    effectAllowed: '',
    dropEffect: '',
  };
};
const makeEvent = overrides => ({
  target: null,
  dataTransfer: makeTransfer(),
  preventDefaultCalls: 0,
  preventDefault() { this.preventDefaultCalls += 1; },
  ...overrides,
});
class FakeElement {
  constructor(tag = 'button') {
    this.tagName = tag.toUpperCase();
    this.className = '';
    this.dataset = {};
    this.disabled = false;
    this.listeners = new Map();
    this.classList = {
      toggle: () => {},
      add: name => { this.classes.add(name); },
      remove: (...names) => { for (const name of names) this.classes.delete(name); },
      contains: name => this.classes.has(name),
    };
    this.classes = new Set();
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  emit(type, event) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}

// ---- 宿主 stub：真值注入 + 意图记录 ----
const state = {
  selectedTab: 0,
  scrollPending: false,
  windowOpen: true,
  inventory: new Map(), // `${tab}:${slot}` -> item
  equipped: new Map(),  // slot -> item
};
const intents = [];
const host = {
  selectedTab: () => state.selectedTab,
  scrollPending: () => state.scrollPending,
  windowOpen: () => state.windowOpen,
  containsTarget: node => Boolean(node && node.insideWindow),
  // HUD 快捷栏那类窗口外落点：自报 dropZone 的节点由它自己处理。
  claimsExternalDrop: node => Boolean(node && node.dropZone),
  inventoryItemAt: (slot, tab) => state.inventory.get(`${tab}:${slot}`),
  equippedItemAt: slot => state.equipped.get(slot),
  isScroll: item => item.itemId.startsWith('204'),
  moveItem: (tab, slot, target) => intents.push(['move', tab, slot, target]),
  dropItem: (tab, slot) => intents.push(['drop', tab, slot]),
  unequip: item => intents.push(['unequip', item.itemId]),
  useScrollOnEquipment: (tab, slot, item, targetSlot, target) => intents.push(['scrollOn', item.itemId, targetSlot, target?.itemId]),
  useItem: (tab, slot, item) => intents.push(['use', item.itemId]),
  clearDragMarks: () => intents.push(['clearMarks']),
};
const item = (slot, itemId) => ({ slot, itemId, quantity: 1 });
const controller = new DragController(host);
const slot = new FakeElement();
controller.bindInventorySlot(slot, 3);

// dragstart：无物品 → 阻止且无状态。
let event = makeEvent();
slot.emit('dragstart', event);
assert.equal(event.preventDefaultCalls, 1, '空槽 dragstart 被阻止');
assert.equal(controller.dragSource(), undefined);

// dragstart：卷轴阶段 → 阻止。
state.inventory.set('0:3', item(3, '2000000'));
state.scrollPending = true;
event = makeEvent();
slot.emit('dragstart', event);
assert.equal(event.preventDefaultCalls, 1, '卷轴阶段 dragstart 被阻止');
state.scrollPending = false;

// dragstart：正常记录来源。
event = makeEvent();
slot.emit('dragstart', event);
assert.equal(event.preventDefaultCalls, 0);
assert.deepEqual(controller.dragSource(), { tab: 0, slot: 3, item: item(3, '2000000') });
assert.ok(slot.classList.contains('inventory-slot-dragging'));
// 载荷形状是窗口外落点（HUD 快捷栏）读它绑定的唯一来源：写进去与读出来必须同形。
assert.ok(hasInventoryDrag(event.dataTransfer), 'dragstart 写出的 MIME 让落点在 dragover 就认得出');
assert.deepEqual(readInventoryDrag(event.dataTransfer), { inventoryType: 1, sourceSlot: 3, itemId: '2000000' },
  '拖拽载荷可被落点原样读回（栏位号/槽位/物品）');
assert.equal(readInventoryDrag(makeTransfer()), undefined, '非背包拖拽读不出载荷');
const broken = makeTransfer(); broken.setData('application/x-maple-inventory', '{"itemId":"2000000"}');
assert.equal(readInventoryDrag(broken), undefined, '缺栏位号/槽位的坏载荷按「不是背包拖拽」处理');

// drop 同页签 → moveItem 意图。
event = makeEvent();
slot.emit('drop', event);
assert.deepEqual(intents.at(-2), ['move', 0, 3, 3]);
assert.deepEqual(intents.at(-1), ['clearMarks'], 'drop 后清空拖拽状态');
assert.equal(controller.dragSource(), undefined);

// 跨页签 drop → 无移动意图。
slot.emit('dragstart', makeEvent());
state.selectedTab = 1;
slot.emit('drop', makeEvent());
assert.equal(intents.at(-1)[0], 'clearMarks', '跨页签 drop 只清理');
state.selectedTab = 0;

// 装备物品拖到背包装备页签（tab 0）→ 卸下意图。
state.equipped.set(-1, item(-1, '1040002'));
state.selectedTab = 0;
const emptySlot = new FakeElement();
controller.bindInventorySlot(emptySlot, 5);
const equipSource = new FakeElement('button');
controller.bindEquipmentSlot(equipSource, -1);
equipSource.emit('dragstart', makeEvent());
assert.ok(controller.draggedEquipped(), '装备拖拽来源已记录');
emptySlot.emit('drop', makeEvent());
assert.deepEqual(intents.filter(intent => intent[0] === 'unequip').length, 1, '装备→背包页签 = 卸下');

// 装备槽接收：卷轴来源 + 目标占用 → 卷轴上装意图；空目标 → 无意图。
state.inventory.set('1:2', item(2, '2041006'));
const scrollSlot = new FakeElement();
controller.bindInventorySlot(scrollSlot, 2);
state.selectedTab = 1;
scrollSlot.emit('dragstart', makeEvent());
const equipTarget = new FakeElement('button');
state.equipped.set(5, item(-9, '1102173'));
controller.bindEquipmentSlot(equipTarget, 5);
equipTarget.emit('drop', makeEvent());
assert.deepEqual(intents.filter(intent => intent[0] === 'scrollOn').pop(), ['scrollOn', '2041006', -5, '1102173']);
// 装备类来源（非卷轴）落到已装备槽 → useItem 意图（无 targetSlot）。
scrollSlot.emit('drop', makeEvent()); // 清理上一次状态
state.inventory.set('1:2', item(2, '1302000'));
scrollSlot.emit('dragstart', makeEvent());
equipTarget.emit('drop', makeEvent());
assert.deepEqual(intents.filter(intent => intent[0] === 'use').pop(), ['use', '1302000']);

// 卷轴落到空装备槽 → 无意图（canDropOnEquipment 要求 Boolean(target)）。
const emptyEquipTarget = new FakeElement('button');
controller.bindEquipmentSlot(emptyEquipTarget, 6);
state.inventory.set('1:2', item(2, '2041006'));
scrollSlot.emit('dragstart', makeEvent());
emptyEquipTarget.emit('drop', makeEvent());
assert.equal(intents.filter(intent => intent[0] === 'scrollOn').length, 1, '空装备槽不触发卷轴意图');

// document 级：窗口外 drop 背包物品 → dropItem（拖出丢弃）。
state.selectedTab = 1;
scrollSlot.emit('dragstart', makeEvent());
emitDocument('drop', makeEvent({ target: nodeTarget(false) }));
assert.deepEqual(intents.filter(intent => intent[0] === 'drop').pop(), ['drop', 1, 2], '拖出窗口 = 丢弃意图');
// 窗口内的 document drop 不接管（槽位自身已处理）。
scrollSlot.emit('dragstart', makeEvent());
emitDocument('drop', makeEvent({ target: nodeTarget(true) }));
assert.equal(intents.filter(intent => intent[0] === 'drop').length, 1, '窗口内 drop 不重复入账');
// 窗口未开时 document drop 完全忽略。
state.windowOpen = false;
scrollSlot.emit('dragstart', makeEvent());
emitDocument('drop', makeEvent({ target: nodeTarget(false) }));
assert.equal(intents.filter(intent => intent[0] === 'drop').length, 1, '窗口关闭时拖拽已不起源');
state.windowOpen = true;

// 窗口外**自报认领**的落点（HUD 快捷栏）：document 级既不放行也不丢弃，交回落点。
const dropCount = intents.filter(intent => intent[0] === 'drop').length;
state.selectedTab = 1;
scrollSlot.emit('dragstart', makeEvent());
let zoneEvent = makeEvent({ target: nodeTarget(false, true) });
emitDocument('dragover', zoneEvent);
assert.equal(zoneEvent.preventDefaultCalls, 0, '认领落点的 dragover 不由 document 替它放行');
emitDocument('drop', zoneEvent);
assert.equal(intents.filter(intent => intent[0] === 'drop').length, dropCount, '拖到快捷栏不得变成丢弃');
assert.ok(controller.dragSource(), '落点自己处理 drop，拖拽来源不被 document 提前清空');
// 同一拍里，非落点的窗口外目标仍然是丢弃。
let outEvent = makeEvent({ target: nodeTarget(false) });
emitDocument('dragover', outEvent);
assert.equal(outEvent.preventDefaultCalls, 1, '窗口外的空地仍由 document 放行（拖出丢弃）');
emitDocument('drop', outEvent);
assert.equal(intents.filter(intent => intent[0] === 'drop').length, dropCount + 1, '没人认领的窗口外 drop 仍是丢弃');

// destroy：document 监听被移除，之后 document 事件不再触发意图。
const before = docListenerCount();
controller.destroy();
assert.ok(docListenerCount() < before, 'destroy 移除 document 监听');
scrollSlot.emit('dragstart', makeEvent());
emitDocument('drop', makeEvent({ target: nodeTarget(false) }));
assert.equal(intents.filter(intent => intent[0] === 'drop').length, dropCount + 1, 'destroy 后 document drop 失效');

console.log('inventory drag-controller: intent routing, scroll-target gates, document drop-out, claimed drop zones, payload round-trip, destroy cleanup passed.');
