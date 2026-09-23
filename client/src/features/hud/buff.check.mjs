#!/usr/bin/env node

/**
 * Buff bar DOM stub check.
 *
 * The buff row is the only HUD surface the server owns end to end: the snapshot
 * carries `derivedStats.skillBuffs` (skill id -> remaining ms) and the client
 * only draws it.  This check drives `BuffBar` with the project-wide DOM stub
 * (no jsdom) and asserts the plate is built from the authored 9-slice, the icon
 * rows are keyed by skill id and reused across ticks, expired buffs disappear,
 * and the whole bar hides when nothing is active.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

class FakeElement {
  constructor(tagName = 'div', ownerDocument = null) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this.style = {
      properties: new Map(),
      setProperty(name, value) { this.properties.set(name, String(value)); },
      getPropertyValue(name) { return this.properties.get(name) ?? ''; },
    };
    this.className = '';
    this.hidden = false;
    this._textContent = '';
    this.ownerDocument = ownerDocument;
  }
  appendChild(node) {
    if (node.parentNode) node.parentNode.children.splice(node.parentNode.children.indexOf(node), 1);
    this.children.push(node);
    node.parentNode = this;
    return node;
  }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  get textContent() {
    if (this.children.length === 0) return this._textContent;
    return this._textContent + this.children.map(child => child.textContent ?? '').join('');
  }
  set textContent(value) { this._textContent = String(value); this.children = []; }
  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  matchesSelector(selector) {
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.matchesSelector(selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
  querySelectorAll(selector) {
    const found = [];
    for (const child of this.children) {
      if (child.matchesSelector(selector)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }
}

class FakeDocument extends FakeElement {
  constructor() { super('#document'); this.ownerDocument = this; }
  createElement(tagName) { return new FakeElement(tagName, this); }
}

const source = await readFile(new URL('./buff-bar.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
})
  // 资源地址解析（v3 §3.1）：离线圈定下用恒等桩（与 dialogue.check.mjs 同一约定）。
  // 本检查不剥 import，所以必须**替换**这一行：留着相对说明符会让 `data:` 模块装载失败。
  .outputText.replace(/import \{[^}]*\} from '\.\.\/\.\.\/assets\/resource-url';/, 'const resolveAssetUrl = url => url;');
const { BuffBar, buffSeconds } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

globalThis.document = new FakeDocument();

// ── The remaining-seconds readout ──
assert.equal(buffSeconds(0), '', 'a spent buff shows no readout');
assert.equal(buffSeconds(-5), '', 'a negative remainder shows no readout');
assert.equal(buffSeconds(Number.NaN), '', 'a non-numeric remainder shows no readout');
assert.equal(buffSeconds(999), '1', 'sub-second remainders round up (never "0" while active)');
assert.equal(buffSeconds(1000), '1');
assert.equal(buffSeconds(59_000), '59');
assert.equal(buffSeconds(60_000), '1:00', 'a minute switches to m:ss');
assert.equal(buffSeconds(95_000), '1:35');
assert.equal(buffSeconds(600_000), '10:00');

const slice = name => ({ url: `favoriteBuff_${name}.png`, width: 5, height: 5, x: 0, y: 0, origin: { x: 0, y: 0 } });
const manifest = {
  buffUi: {
    contentVersion: 'tms273-9',
    source: 'UI/StatusBar3.img/BuffSetting',
    ui: {
      'favoriteBuff/nw': slice('nw'), 'favoriteBuff/n': slice('n'), 'favoriteBuff/ne': slice('ne'),
      'favoriteBuff/w': slice('w'), 'favoriteBuff/c': slice('c'), 'favoriteBuff/e': slice('e'),
      'favoriteBuff/sw': slice('sw'), 'favoriteBuff/s': slice('s'), 'favoriteBuff/se': slice('se'),
    },
    layout: { spaceX: 5, spaceY: 5 },
  },
  skillCatalog: {
    1001003: { name: '灵魂之力', icons: { normal: { url: 'icon_1001003.png', width: 32, height: 32 } } },
    2001002: { name: '魔法盾', icons: { normal: { url: 'icon_2001002.png', width: 32, height: 32 } } },
  },
};

const host = document.createElement('div');
const bar = new BuffBar(host, manifest);
const root = host.querySelector('.tms-buff-bar');
assert(root, 'the bar mounts onto the HUD row');
assert.equal(root.getAttribute('role'), 'status');
assert.equal(root.getAttribute('aria-label'), '增益状态');
assert.equal(root.hidden, true, 'the bar stays hidden until the server reports a buff');
assert.equal(root.dataset.available, 'true', 'the authored plate is available');
assert.equal(root.style.getPropertyValue('--tms-buff-space-x'), '5px', 'the icon gap comes from the authored spaceX');

const panel = root.querySelector('.tms-buff-panel');
assert.equal(panel.querySelectorAll('.tms-buff-slice').length, 9, 'all nine plate slices are drawn');
for (const name of ['nw', 'n', 'ne', 'w', 'c', 'e', 'sw', 's', 'se']) {
  assert(panel.querySelector(`.tms-buff-slice-${name}`), `slice ${name} is drawn`);
}

const list = root.querySelector('.tms-buff-list');
assert.equal(list.children.length, 0, 'no rows before the first snapshot');

// ── Two active buffs ──
bar.update({ 2001002: 45_000, 1001003: 5_400 });
assert.equal(root.hidden, false, 'the bar shows itself once a buff is active');
assert.equal(list.children.length, 2);
assert.deepEqual(list.children.map(entry => entry.dataset.skillId), ['1001003', '2001002'], 'rows are ordered by skill id');
const first = list.children[0];
assert.equal(first.querySelector('.tms-buff-icon').src, 'icon_1001003.png');
assert.equal(first.querySelector('.tms-buff-time').textContent, '6', '5.4 s reads as 6');

// ── A tick rewrites the text and keeps the same nodes ──
bar.update({ 2001002: 44_000, 1001003: 4_400 });
assert.equal(list.children.length, 2, 'a tick never rebuilds the row set');
assert.equal(list.children[0], first, 'the row node is reused');
assert.equal(first.querySelector('.tms-buff-time').textContent, '5');
assert.equal(list.children[1].querySelector('.tms-buff-time').textContent, '44');

// ── An expired buff is dropped, a new one is appended ──
bar.update({ 2001002: 0, 1001003: 3_400, 2221054: 90_000 });
assert.deepEqual(list.children.map(entry => entry.dataset.skillId), ['1001003', '2221054'], 'a spent buff leaves the row');
// 2221054 is not in the catalog: the row still mounts, it just has no icon.
const unknown = list.children[1];
assert.equal(unknown.querySelector('.tms-buff-icon').src, undefined, 'an unexported skill renders an empty slot, not a broken image');
assert.equal(unknown.querySelector('.tms-buff-time').textContent, '1:30');

// ── Everything expiring hides the bar again ──
bar.update({ 1001003: 0, 2221054: -1 });
assert.equal(root.hidden, true, 'no active buff hides the whole bar');
assert.equal(list.children.length, 0);

// ── Empty / missing maps are not an error ──
bar.update(undefined);
assert.equal(root.hidden, true, 'undefined buffs hide the bar');
bar.update({});
assert.equal(root.hidden, true);

// ── clear() and destroy() ──
bar.update({ 2001002: 10_000 });
assert.equal(root.hidden, false);
bar.clear();
assert.equal(list.children.length, 0, 'clear() empties the row');
assert.equal(root.hidden, true);
bar.update({ 2001002: 10_000 });
assert.equal(root.hidden, false, 'the bar can be repopulated after clear()');
bar.destroy();
assert.equal(host.querySelector('.tms-buff-bar'), null, 'destroy() unmounts the bar');

// ── A missing export degrades instead of throwing ──
const bare = document.createElement('div');
const bareBar = new BuffBar(bare, { skillCatalog: manifest.skillCatalog });
const bareRoot = bare.querySelector('.tms-buff-bar');
assert.equal(bareRoot.dataset.available, 'false', 'without the export the plate is reported as unavailable');
assert.equal(bareRoot.querySelectorAll('.tms-buff-slice').length, 0, 'no slices are invented');
bareBar.update({ 2001002: 1_000 });
assert.equal(bareRoot.hidden, false, 'icons still render without the plate');
assert.equal(bareRoot.querySelector('.tms-buff-list').children.length, 1);

console.log('PASS: buff plate 9-slice, durable rows by skill id, second readout, expiry, clear and destroy.');
