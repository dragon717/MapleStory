#!/usr/bin/env node
// tooltip-view.check.mjs — TooltipController 的 DOM stub 检查（计划 §8.3）。
// 覆盖：显示/隐藏、悬停保持、定时器清除、refresh 回调裁决、destroy 清理、视口定位钳制。
// 数据来源经回调注入（detailsFor / assetImage），因此本检查不需要 names/items.json。

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const code = compile(await readFile(new URL('./tooltip-view.ts', import.meta.url), 'utf8'));
const { TooltipController, tooltipSkin } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

// ---- 最小 DOM stub（仅覆盖 TooltipController 实际触碰的面）----
class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = { setProperty(name, value) { this['--' + name] = value; } };
    this.hidden = false;
    this.className = '';
    this.classes = new Set();
    this.classList = {
      toggle: (name, force) => { if (force) this.classes.add(name); else this.classes.delete(name); },
      contains: name => this.classes.has(name),
    };
    this.id = '';
    this.tabIndex = 0;
    this.textContentValue = '';
    this.listeners = new Map();
    this.rect = { left: 100, top: 100, right: 140, bottom: 130, width: 40, height: 30 };
    this.offsetWidth = 220;
    this.offsetHeight = 60;
  }
  appendChild(node) { this.children.push(node); return node; }
  append(...nodes) { for (const n of nodes) this.appendChild(n); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  set textContent(value) { this.textContentValue = value; this.children = []; }
  get textContent() { return this.textContentValue; }
  addEventListener(type, fn) { (this.listeners.get(type) ?? this.listeners.set(type, []).get(type)).push(fn); }
  emit(type) { for (const fn of this.listeners.get(type) ?? []) fn(); }
  setAttribute() {}
  removeAttribute() {}
  getBoundingClientRect() { return this.rect; }
}

const timers = { handle: 0, pending: null, cleared: new Set() };
const fakeWindow = {
  setTimeout(fn) { timers.pending = fn; return ++timers.handle; },
  clearTimeout(handle) { timers.cleared.add(handle); if (timers.pending) timers.pending = null; },
  innerWidth: 800,
  innerHeight: 600,
};
const created = [];
globalThis.window = fakeWindow;
globalThis.document = { createElement: tag => { const el = new FakeElement(tag); created.push(el); return el; } };

const item = (slot, itemId) => ({ slot, itemId, quantity: 1 });
const anchor = new FakeElement('button');
const root = new FakeElement();
const controller = new TooltipController(root, tooltipSkin(undefined), {
  assetImage: () => new FakeElement('img'),
  detailsFor: (it, comparison) => `details:${it.itemId}${comparison ? '|cmp:' + comparison.itemId : ''}`,
});

// tooltip 元素挂到 root、默认隐藏、id 保留（CSS/测试投影依赖它）。
assert.equal(controller.element, root.children[0]);
assert.equal(controller.element.id, 'inventory-tooltip');
assert.equal(controller.element.hidden, true);

// 显示：正文经 detailsFor 注入，dataset 记录 itemId，元素可见。
controller.showForItem(item(1, '2000000'), anchor);
assert.equal(controller.element.hidden, false);
assert.equal(controller.element.children.at(-1).textContent, 'details:2000000');
assert.equal(controller.element.dataset.itemId, '2000000');
assert.equal(controller.currentAnchor(), anchor);

// 对比目标透传。
controller.showForItem(item(2, '1002043'), anchor, item(-1, '1002067'));
assert.equal(controller.element.children.at(-1).textContent, 'details:1002043|cmp:1002067');

// 定位：右侧放不下时翻到锚点左侧，并钳制在视口内。
anchor.rect = { left: 760, top: 20, right: 790, bottom: 50, width: 30, height: 30 };
controller.showForItem(item(1, '2000000'), anchor);
const left = Number(controller.element.style.left.replace('px', ''));
const top = Number(controller.element.style.top.replace('px', ''));
assert.ok(left + 220 <= 800, 'tooltip 宽度钳制在视口内: ' + left);
assert.ok(top >= 0 && top + 60 <= 600, 'tooltip 高度钳制在视口内: ' + top);

// 悬停保持：anchorHovered 期间定时器到期不隐藏。
controller.noteAnchorEnter();
controller.scheduleHide();
const pendingHide = timers.pending;
assert.ok(pendingHide, 'scheduleHide 挂起一个定时器');
pendingHide();
assert.equal(controller.element.hidden, false, '悬停锚点上定时器到期仍保持可见');

// 离开锚点后定时器到期隐藏。
controller.noteAnchorLeave();
controller.scheduleHide();
timers.pending();
assert.equal(controller.element.hidden, true, '无悬停时到期隐藏');
assert.equal(controller.element.dataset.itemId, undefined, '隐藏清除 itemId 投影');

// 重新显示会清掉挂起的隐藏定时器（跨过间隙不闪没）。
controller.noteAnchorEnter();
controller.showForItem(item(1, '2000000'), anchor);
controller.noteAnchorLeave();
controller.scheduleHide();
controller.showForItem(item(1, '2000000'), anchor);
assert.ok(timers.cleared.size >= 1, 'showForItem 清除挂起定时器');
timers.pending?.();
assert.equal(controller.element.hidden, false, '清除后的定时器不再隐藏');

// refresh：由宿主裁决锚点是否仍指向可显示物品。
controller.refresh(() => true);
assert.equal(controller.element.hidden, false, 'keepVisible=true 保持');
controller.refresh(() => false);
assert.equal(controller.element.hidden, true, 'keepVisible=false 隐藏');
// refresh 在已隐藏时是 no-op，不再回调。
let refreshCalls = 0;
controller.refresh(() => { refreshCalls += 1; return true; });
assert.equal(refreshCalls, 0, '隐藏状态不回调 keepVisible');

// 隐藏 + destroy：销毁清定时器，之后定时器不再触发隐藏。
controller.showForItem(item(1, '2000000'), anchor);
controller.noteAnchorLeave();
controller.scheduleHide();
controller.destroy();
const destroyedPending = timers.pending;
timers.pending = null;
destroyedPending?.();
assert.equal(controller.element.hidden, false, 'destroy 后挂起定时器已失效');

// 空皮肤（无 tooltip:top/mid/btm）也能构造：只有 content，缺省宽度参与定位。
const comparisonController = new TooltipController(root, tooltipSkin(undefined), {
  assetImage: () => new FakeElement('img'),
  detailsFor: it => it.itemId,
  itemFrame: itemId => ({ url: itemId + '.png', width: 32, height: 32 }),
  itemLabel: itemId => 'name:' + itemId,
});
comparisonController.showForItem(item(2, '1002043'), anchor, item(-1, '1002067'));
const comparisonRoot = comparisonController.element.children.at(-1).children.at(-1);
assert.equal(comparisonRoot.className, 'inventory-comparison', '装备对比使用左右双栏');
assert.equal(comparisonRoot.children.length, 2, '装备对比包含候选与已装备两栏');
assert.ok(comparisonRoot.children[1].classList.contains('inventory-comparison-equipped'), '已装备栏保留黄框状态类');

const bare = new TooltipController(root, tooltipSkin(undefined), {
  assetImage: () => new FakeElement('img'),
  detailsFor: it => it.itemId,
});
assert.equal(bare.element.className, 'inventory-tooltip');

console.log('inventory tooltip-view: show/hide, hover keep-alive, timer hygiene, refresh裁决 passed.');
