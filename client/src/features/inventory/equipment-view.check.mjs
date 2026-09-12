#!/usr/bin/env node
// equipment-view.check.mjs — EquipmentView 的 DOM stub 检查（计划 §8.2/§8.3）。
// 覆盖：资源缺失提前返回（不开窗）、开合状态与根容器显隐同步、
// 渲染状态类（occupied/targetable）、槽位点击分支（卷轴目标/空槽提示/双击卸下）、
// close 按钮请求、tooltip 钩子经注入的 controller。
// names 依赖经 data URL 装载；view 的窗口拖动状态不在本模块。

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const b64 = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;

// ---- 依赖装载：i18n → items.json → names → equipment-view ----
globalThis.window = { location: { search: '' } };
const i18nCode = compile(await readFile(new URL('../../app/i18n.ts', import.meta.url), 'utf8'))
  .replace("import OpenCC from 'opencc-js/t2cn';", 'const OpenCC = { Converter: () => text => text };');
const i18nUrl = b64(i18nCode);
const itemsUrl = `data:application/json;base64,${Buffer.from(await readFile(new URL('../../../../shared/items.json', import.meta.url), 'utf8')).toString('base64')}`;
const namesCode = compile(await readFile(new URL('./names.ts', import.meta.url), 'utf8'))
  .replaceAll("from '../../app/i18n'", `from '${i18nUrl}'`)
  .replaceAll("from '../../../../shared/items.json'", `from '${itemsUrl}' with { type: 'json' }`);
const namesUrl = b64(namesCode);
const equipCode = compile(await readFile(new URL('./equipment-view.ts', import.meta.url), 'utf8'))
  .replaceAll("from './names'", `from '${namesUrl}'`);
const { EquipmentView } = await import(b64(equipCode));

// ---- DOM stub ----
const created = [];
class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.tabIndex = 0;
    this.title = '';
    this.draggable = false;
    this.listeners = new Map();
    this.classes = new Set();
    this._className = '';
    this.className = '';
    this.classList = {
      add: name => this.classes.add(name),
      remove: (...names) => { for (const name of names) this.classes.delete(name); },
      toggle: (name, force) => {
        const want = force === undefined ? !this.classes.has(name) : force;
        if (want) this.classes.add(name); else this.classes.delete(name);
        return want;
      },
      contains: name => this.classes.has(name),
    };
  }
  appendChild(node) { this.children.push(node); return node; }
  get className() { return this._className; }
  set className(value) {
    // 单类名赋值是本检查中的唯一写法；保持 classes 与之一致以支持 querySelectorAll。
    for (const name of [...this.classes]) if (!value.split(/\s+/).includes(name)) this.classes.delete(name);
    for (const name of value.split(/\s+/)) if (name) this.classes.add(name);
    this._className = value;
  }
  append(...nodes) { for (const n of nodes) this.appendChild(n); }
  setAttribute(name, value) { this.attrs = { ...(this.attrs ?? {}), [name]: value }; }
  getAttribute(name) { return (this.attrs ?? {})[name]; }
  removeAttribute() {}
  replaceChildren(...nodes) { this.children = [...nodes]; }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  emit(type, event = { preventDefault() {} }) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  querySelectorAll(selector) {
    const wanted = selector.replace(/^\./, '');
    const found = [];
    const walk = node => {
      for (const child of node.children ?? []) {
        if (child.classList?.contains(wanted)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
}
globalThis.document = { createElement: tag => { const el = new FakeElement(tag); created.push(el); return el; } };
globalThis.requestAnimationFrame = () => {};

// ---- 宿主 stub ----
const state = {
  equipped: new Map(),
  selecting: false,
  inventoryOpen: false,
  rootVisible: null,
  statusLog: [],
  scrollTargets: [],
  announced: [],
  unequipped: [],
  closeRequests: 0,
  tooltipHides: 0,
};
const item = (slot, itemId) => ({ slot, itemId, quantity: 1 });
const tooltips = { hide: () => { state.tooltipHides += 1; }, noteAnchorEnter() {}, noteAnchorLeave() {}, noteAnchorFocus() {}, noteAnchorBlur() {}, showForItem() {}, position() {} };
const layout = {
  width: 300,
  height: 400,
  close: { x: 280, y: 8 },
  itemOffset: { x: 4, y: 4 },
  slots: { 1: { x: 10, y: 10, width: 32, height: 32 }, 5: { x: 10, y: 50, width: 32, height: 32 }, 11: { x: 10, y: 90, width: 32, height: 32 } },
};
const ui = { backgrnd: { url: 'bg.png', width: 300, height: 400 }, 'main/button:close/normal/0': { url: 'close.png', width: 12, height: 12 }, 'EquipTab/canvas:equip': { url: 'canvas.png', x: 2, y: 2, width: 1, height: 1 } };
const makeHost = () => ({
  equippedItemAt: slot => state.equipped.get(slot),
  selectingTarget: () => state.selecting,
  itemFrame: itemId => ({ url: itemId + '.png', width: 32, height: 32 }),
  assetImage: frame => Object.assign(new FakeElement('img'), { srcFrame: frame }),
  translate: (zh, en) => (globalThis.__en ? en : zh),
  status: message => state.statusLog.push(message),
  createWindowButton: (parent, kind, assets, normalKey, action) => {
    const button = new FakeElement('button');
    button.action = action;
    parent.append(button);
    return button;
  },
  positionWindowButton: () => {},
  syncRootVisibility: () => {
    // 与 view.ts 中的实现一致：物品栏也关着时整组隐藏。
    if (!state.inventoryOpen) {
      root.hidden = true;
      root.dataset.open = 'false';
    }
    state.rootVisible = root.dataset.open;
  },
  chooseScrollTarget: (slotNumber, target) => state.scrollTargets.push([slotNumber, target?.itemId]),
  announceSelection: target => state.announced.push(target.itemId),
  unequip: target => state.unequipped.push(target.itemId),
  onCloseRequest: () => { state.closeRequests += 1; },
  drag: { bindEquipmentSlot() {} },
  tooltips,
});

const manifest = { equipmentUi: ui };
const root = new FakeElement();
root.dataset = {};

// 资源缺失：无 backgrnd → 窗口不创建，open() 无效。
const bare = new EquipmentView(root, { equipmentUi: {} }, layout, makeHost());
assert.equal(bare.window, undefined, '缺资源时窗口不创建');
bare.open();
assert.equal(bare.isOpen(), false, '缺资源时 open 是 no-op');

// 完整资源：窗口创建、槽位数量与 layout 一致、close 按钮存在。
const host = makeHost();
const view = new EquipmentView(root, manifest, layout, host);
assert.ok(view.window, '资源齐全时窗口创建');
assert.equal(view.window.querySelectorAll('.equipment-slot').length, 3, '三个装备槽');
assert.equal(view.isOpen(), false);
assert.equal(root.children.at(-1), view.window, '窗口挂在根容器上');

// open/close：开合状态、根容器显隐同步、tooltip 隐藏。
view.open();
assert.equal(view.isOpen(), true);
assert.equal(root.dataset.open, 'true');
view.close();
assert.equal(view.isOpen(), false);
assert.equal(root.dataset.open, 'false', '物品栏关闭时整组隐藏');
assert.equal(state.rootVisible, 'false', 'close 经 syncRootVisibility 同步根容器');
assert.equal(state.tooltipHides, 1, 'close 隐藏 tooltip');

// 渲染：占用/空槽/选择目标类。
state.equipped.set(1, item(-1, '1002067'));
state.selecting = false;
view.render();
const slots = view.window.querySelectorAll('.equipment-slot');
const slotByNumber = new Map(slots.map(button => [Number(button.dataset.slot), button]));
assert.ok(slotByNumber.get(1).classList.contains('equipment-slot-occupied'), '占用槽有 occupied 类');
assert.ok(!slotByNumber.get(5).classList.contains('equipment-slot-occupied'), '空槽无 occupied 类');
assert.ok(!slotByNumber.get(1).classList.contains('equipment-slot-targetable'));
state.selecting = true;
view.render();
assert.ok(slotByNumber.get(1).classList.contains('equipment-slot-targetable'), '卷轴阶段占用槽可作目标');
assert.ok(!slotByNumber.get(5).classList.contains('equipment-slot-targetable'), '空槽不可作目标');
state.selecting = false;

// 槽位点击分支：卷轴阶段选占用槽 → chooseScrollTarget；空槽 → 状态提示。
state.selecting = true;
slotByNumber.get(1).emit('click');
assert.deepEqual(state.scrollTargets.at(-1), [1, '1002067']);
slotByNumber.get(5).emit('click');
assert.match(state.statusLog.at(-1), /已装备的目标|occupied equipment slot/);
// 非卷轴阶段点击占用槽 → 选中提示；双击 → 卸下。
state.selecting = false;
slotByNumber.get(1).emit('click');
assert.deepEqual(state.announced, ['1002067']);
slotByNumber.get(1).emit('dblclick');
assert.deepEqual(state.unequipped, ['1002067']);
// 右键：卷轴阶段同 click；非卷轴阶段同双击。
state.selecting = true;
slotByNumber.get(1).emit('contextmenu');
assert.equal(state.scrollTargets.length, 2);
state.selecting = false;
slotByNumber.get(5).emit('contextmenu');
assert.equal(state.unequipped.length, 1, '空槽右键无卸下意图');

// close 按钮：经 host.createWindowButton 创建，点击走 onCloseRequest。
const closeRequests = state.closeRequests;
view.window.children.filter(child => child.action).at(-1).action();
assert.equal(state.closeRequests, closeRequests + 1, 'close 按钮请求关闭');

console.log('inventory equipment-view: window build, open/close sync, render states, slot click branches, close request passed.');
