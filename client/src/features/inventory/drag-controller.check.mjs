#!/usr/bin/env node
// drag-controller.check.mjs — DragController 的意图路由检查（计划 §8.3）。
// 覆盖：dragstart 抑制条件、drop 意图路由（移动/丢弃/卸下/卷轴上装/装备使用）、
// 跨页签 drop 忽略、document 级拖出丢弃、destroy 移除 document 监听。
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
const { DragController } = await import(b64(dragCode));

// ---- document stub（只覆盖 add/removeEventListener）----
globalThis.Node = class Node {};
const nodeTarget = insideWindow => Object.assign(new globalThis.Node(), { insideWindow });
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
const makeEvent = overrides => ({
  target: null,
  dataTransfer: { setData() {}, effectAllowed: '', dropEffect: '' },
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

// destroy：document 监听被移除，之后 document 事件不再触发意图。
const before = docListenerCount();
controller.destroy();
assert.ok(docListenerCount() < before, 'destroy 移除 document 监听');
scrollSlot.emit('dragstart', makeEvent());
emitDocument('drop', makeEvent({ target: nodeTarget(false) }));
assert.equal(intents.filter(intent => intent[0] === 'drop').length, 1, 'destroy 后 document drop 失效');

console.log('inventory drag-controller: intent routing, scroll-target gates, document drop-out, destroy cleanup passed.');
