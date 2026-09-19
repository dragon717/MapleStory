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

// ---- 依赖装载：i18n → shared/*.json → names → equipment-view ----
globalThis.window = { location: { search: '' } };
const i18nCode = compile(await readFile(new URL('../../app/i18n.ts', import.meta.url), 'utf8'))
  .replace("import OpenCC from 'opencc-js/t2cn';", 'const OpenCC = { Converter: () => text => text };');
const i18nUrl = b64(i18nCode);
// names.ts 依赖 shared/ 下的四张表（items / pets / mount-index / chair-names）。
// 这里**按实际导入逐个**换，不写死名单：新加一张表时若忘了换，会在这里整块炸掉
// 而不是静默漏测（漏测的表现是"names 少回落一层"，很难看出来）。
let namesCode = compile(await readFile(new URL('./names.ts', import.meta.url), 'utf8'))
  .replaceAll("from '../../app/i18n'", `from '${i18nUrl}'`);
const sharedJson = [...new Set([...namesCode.matchAll(/from '\.\.\/\.\.\/\.\.\/\.\.\/shared\/([\w.-]+\.json)'/g)].map(match => match[1]))];
assert(sharedJson.length >= 4, `names.ts 的 shared/*.json 导入只认出 ${sharedJson.length} 张，装载器可能失效了`);
for (const file of sharedJson) {
  const url = `data:application/json;base64,${Buffer.from(await readFile(new URL(`../../../../shared/${file}`, import.meta.url), 'utf8')).toString('base64')}`;
  namesCode = namesCode.replaceAll(`from '../../../../shared/${file}'`, `from '${url}' with { type: 'json' }`);
}
const namesUrl = b64(namesCode);
const equipCode = compile(await readFile(new URL('./equipment-view.ts', import.meta.url), 'utf8'))
  .replaceAll("from './names'", `from '${namesUrl}'`)
  .replaceAll("from '../mounts/model'", `from '${b64(compile(await readFile(new URL('../mounts/model.ts', import.meta.url), 'utf8')).replaceAll("from '../inventory/names'", `from '${namesUrl}'`))}'`);
const { EquipmentView, MOUNT_FOOTER_HEIGHT } = await import(b64(equipCode));

// ---- DOM stub ----
const created = [];
class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    // 装备窗用 `style.setProperty` 把骑宠行的高度传给样式表
    // （`--equipment-mount-footer-height`），stub 里也要有这个方法。
    this.style = { setProperty: (name, value) => { this.style[name] = value; } };
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
  /** 服务器快照里正在骑乘的骑宠 id；缺席＝没在骑（装备里装着骑宠 ≠ 在骑）。 */
  mountedId: undefined,
  selecting: false,
  inventoryOpen: false,
  rootVisible: null,
  statusLog: [],
  scrollTargets: [],
  announced: [],
  unequipped: [],
  used: [],
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
  slots: {
    1: { x: 10, y: 10, width: 32, height: 32 },
    5: { x: 10, y: 50, width: 32, height: 32 },
    11: { x: 10, y: 90, width: 32, height: 32 },
    // 18/19（源 Tm/Sd）本轮在源 UI 里不存在，但双击判定按源 islot 走，
    // 所以这两格要在**测试布局**里造出来才能覆盖到（见 equipment-view.ts 的注）。
    18: { x: 10, y: 130, width: 32, height: 32 },
    19: { x: 10, y: 170, width: 32, height: 32 },
  },
};
const ui = { backgrnd: { url: 'bg.png', width: 300, height: 400 }, 'main/button:close/normal/0': { url: 'close.png', width: 12, height: 12 }, 'EquipTab/canvas:equip': { url: 'canvas.png', x: 2, y: 2, width: 1, height: 1 } };
const makeHost = () => ({
  equippedItemAt: slot => state.equipped.get(slot),
  mountedItemId: () => state.mountedId,
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
  useItem: (sourceTab, sourceSlot, target) => state.used.push([sourceTab, sourceSlot, target.itemId]),
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
assert.equal(view.window.querySelectorAll('.equipment-slot').length, 5, '五个装备槽');
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

// 双击已装备的骑宠 = 上下马，**不是**卸下（審計第 30 项）。
// 判据是源 tamingMob；鞍具只有 Sd 槽位，不是可骑宠物。
const mountIndex = JSON.parse(await readFile(new URL('../../../../shared/mount-index.json', import.meta.url), 'utf8'));
const mountId = Object.keys(mountIndex).find(id => mountIndex[id].islot === 'Tm' && mountIndex[id].tamingMob);
const saddleId = Object.keys(mountIndex).find(id => mountIndex[id].islot === 'Sd');
assert(mountId && saddleId, '坐骑索引里找不到 Tm / Sd 两族，这条覆盖就白做了');
const unequippedBefore = state.unequipped.length;
state.equipped.set(18, item(18, mountId));
view.render();
slotByNumber.get(18).emit('dblclick');
assert.deepEqual(state.used.at(-1), [0, -18, mountId], '双击 Tm 槽骑宠提交 useItem(tab 0, −18, id)');
assert.equal(state.unequipped.length, unequippedBefore, '双击骑宠不产生卸下意图');
state.equipped.set(19, item(19, saddleId));
view.render();
slotByNumber.get(19).emit('dblclick');
assert.deepEqual(state.unequipped.at(-1), saddleId, '无 tamingMob 的馬鞍双击卸下');
// 普通装备仍然双击即卸下：这一支没被骑乘分支吞掉。
state.equipped.set(11, item(11, '1002067'));
view.render();
slotByNumber.get(11).emit('dblclick');
assert.equal(state.used.length, 1, '普通装备不进骑乘通道');
assert.equal(state.unequipped.length, unequippedBefore + 2, '普通装备双击仍是卸下');

console.log('inventory equipment-view: window build, open/close sync, render states, slot click branches, mount ride branch, close request passed.');

// Real source layout has no Tm/Sd slots: equipped mounts must still be visible
// and removable, rather than disappearing into an unreachable equipment row.
const sourceLayout = { ...layout, slots: { 1: layout.slots[1] } };
const sourceView = new EquipmentView(new FakeElement(), manifest, sourceLayout, makeHost());
sourceView.render();
const extra = sourceView.window.querySelectorAll('.equipment-slot');
const mountSlot = extra.find(button => button.dataset.slot === '18');
assert.equal(mountSlot.children[0].srcFrame.url, mountId + '.png');
assert.match(mountSlot.getAttribute('aria-label'), /右键卸下/);
mountSlot.emit('contextmenu');
assert.equal(state.unequipped.at(-1), mountId);
// 窗口总高＝源装备画布高度 + 骑宠行高度：行高只有一个来源（`MOUNT_FOOTER_HEIGHT`），
// 检查也对着它算，而不是在测试里再抄一个 460。
assert.equal(sourceView.window.style.height, `${layout.height + MOUNT_FOOTER_HEIGHT}px`);
assert.equal(sourceView.window.style['--equipment-mount-footer-height'], `${MOUNT_FOOTER_HEIGHT}px`, '行高传给样式表');
assert.deepEqual(
  extra.map(button => Number(button.dataset.slot)), [1, 18, 19],
  '源画布缺的 Tm/Sd 两格由底部行补上，而不是消失',
);
const mountLabels = sourceView.window.querySelectorAll('.equipment-mount-label');
assert.deepEqual(mountLabels.map(label => label.textContent), ['骑宠', '鞍具'], '未骑乘时标签只说槽名');

// 骑乘状态：同一个装备行，`mount.itemId` 在不在决定高亮与文案——只看图标分不出
// 「装着骑宠」和「正在骑」，所以这一条必须落在 DOM 上，而不是只在 title 里。
state.equipped.set(18, item(18, mountId));
state.mountedId = mountId;
sourceView.render();
assert.ok(mountSlot.classList.contains('equipment-slot-riding'), '正在骑的骑宠格加 riding 类');
assert.match(mountSlot.getAttribute('aria-label'), /骑乘中，双击下马/);
assert.equal(mountLabels[0].textContent, '骑宠 · 骑乘中', '骑宠格标签说出骑乘状态');
assert.ok(mountLabels[0].classList.contains('is-riding'));
assert.equal(mountLabels[1].textContent, '鞍具', '鞍具格不跟着变');
// 下马（快照里 mount 消失）后高亮必须清掉，不能留着一个"还在骑"的假象。
state.mountedId = undefined;
sourceView.render();
assert.ok(!mountSlot.classList.contains('equipment-slot-riding'), '下马后 riding 类清掉');
assert.equal(mountLabels[0].textContent, '骑宠');
assert.ok(!mountLabels[0].classList.contains('is-riding'));
// 快照与装备行对不上（说在骑，装备里却找不到那一行）时**不做任何高亮**：
// 客户端只显示服务器给的事实，不在本地补第二套判定把状态圆过去。
state.mountedId = '1999999';
sourceView.render();
assert.ok(!mountSlot.classList.contains('equipment-slot-riding'));
assert.equal(mountLabels[0].textContent, '骑宠');
state.mountedId = undefined;
sourceView.render();
