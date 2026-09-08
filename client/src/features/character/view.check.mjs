#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

class FakeClassList {
  constructor(node) { this.node = node; }
  add(...names) { this.node.className = `${this.node.className} ${names.join(' ')}`.trim(); }
  remove(...names) { this.node.className = this.node.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); }
  contains(name) { return this.node.className.split(/\s+/).includes(name); }
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.className = '';
    this.classList = new FakeClassList(this);
    this.hidden = false;
    this._textContent = '';
    this.isContentEditable = false;
  }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  appendChild(node) { this.children.push(node); node.parentNode = this; return node; }
  get textContent() { return this._textContent + this.children.map(child => child.textContent ?? '').join(''); }
  set textContent(value) { this._textContent = String(value); }
  remove() { this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, listener) { const set = this.listeners.get(type) ?? new Set(); set.add(listener); this.listeners.set(type, set); }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatchEvent(event) { event.target ??= this; for (const listener of this.listeners.get(event.type) ?? []) listener.call(this, event); return !event.defaultPrevented; }
  matches(selector) {
    if (selector.includes('input') && this.tagName === 'INPUT') return true;
    if (selector.includes('textarea') && this.tagName === 'TEXTAREA') return true;
    if (selector.includes('select') && this.tagName === 'SELECT') return true;
    return selector.includes('[contenteditable="true"]') && this.attributes.get('contenteditable') === 'true';
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.matchesSelector?.(selector)) return child;
      const nested = child.querySelector?.(selector);
      if (nested) return nested;
    }
    return null;
  }
  matchesSelector(selector) {
    const field = selector.match(/^\[data-field="([^"]+)"\]$/)?.[1];
    if (field) return this.dataset.field === field;
    const derivedField = selector.match(/^\[data-derived-field="([^"]+)"\]$/)?.[1];
    if (derivedField) return this.dataset.derivedField === derivedField;
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
  focus() { this.ownerDocument.activeElement = this; }
}

class FakeDocument extends FakeElement {
  constructor() {
    super('#document');
    this.ownerDocument = this;
    this.activeElement = null;
  }
  createElement(tagName) {
    const node = new FakeElement(tagName);
    node.ownerDocument = this;
    return node;
  }
}

const source = await readFile(new URL('./view.ts', import.meta.url), 'utf8');
const style = await readFile(new URL('./style.css', import.meta.url), 'utf8');
assert.match(style, /overflow-x:\s*hidden/);
assert.match(style, /@media \(max-width: 483px\)/);
assert.match(style, /grid-template-columns: minmax\(0, 1fr\)/);
const outputText = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/^import .*;\r?\n/gm, '');
const { CharacterInfoView } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

const original = { document: globalThis.document, requestAnimationFrame: globalThis.requestAnimationFrame };
const document = new FakeDocument();
globalThis.document = document;
globalThis.requestAnimationFrame = callback => { callback(); return 1; };

const game = document.createElement('main');
game.setAttribute('id', 'game');
document.append(game);
const host = document.createElement('div');
document.append(host);
const frame = { url: '/asset.png', x: 0, y: 0, width: 1, height: 1 };
const manifest = {
  characterUi: {
    'common/main/backgrnd': frame,
    'local/detail/backgrnd': frame,
    'common/main/button:close/normal/0': frame,
    'local/detailStat/button:lvUpStr/normal/0': frame,
    'local/detailStat/button:lvUpStr/disabled/0': frame,
  },
  characterLayout: {
    'common/main/vector:lvPos': { x: 4, y: 5 },
    'common/main/vector:jobPos': { x: 6, y: 7 },
    'common/main/vector:namePos': { x: 8, y: 9 },
  },
};
const messages = [];
const requests = [];
const view = new CharacterInfoView(host, manifest, message => messages.push(message), request => { requests.push(request); return true; });
const player = {
  id: 'mage', username: '冰法', x: 0, y: 0, vx: 0, vy: 0, facing: 1, grounded: true,
  action: 'stand', actionId: null, actionStartedTick: 0, lastInputSeq: 0, climbing: false,
  ladderId: null, hp: 80, maxHp: 100, mp: 40, maxMp: 70, job: 200, level: 12,
  exp: 345, expToNext: 500, mesos: 678, inventory: [],
  abilityStats: { strength: 9, dexterity: 11, intelligence: 44, luck: 6, availableAp: 3 },
  derivedStats: {
    magicAttack: 55, defense: 9, moveSpeed: 120, magicGuard: true,
    strength: 12, dexterity: 11, intelligence: 48, luck: 6,
  },
};
view.update(player);
const root = host.querySelector('.tms273-character-host');
assert(root, 'Character root is mounted');
assert.equal(root.hidden, true, 'The window starts closed');
assert.equal(root.querySelector('[data-field="username"]').children.at(-1).textContent, '冰法');
assert.equal(root.querySelector('[data-field="magicAttack"]').textContent, '55');
assert.equal(root.querySelector('[data-field="mesos"]').children.at(-1).textContent, '678');
assert.equal(root.querySelector('[data-field="moveSpeed"]').textContent, '120 px/s');
assert.equal(root.querySelector('[data-field="strength"]').textContent, '9');
assert.equal(root.querySelector('[data-field="dexterity"]').textContent, '11');
assert.equal(root.querySelector('[data-field="intelligence"]').textContent, '44');
assert.equal(root.querySelector('[data-field="luck"]').textContent, '6');
assert.equal(root.querySelector('[data-derived-field="strength"]').textContent, '总 12');
assert.equal(root.querySelector('[data-field="exp"]').children.at(-1).textContent, '345 / 500 · 69.00%');
assert.equal(root.querySelector('[data-field="availableAp"]').children.at(-1).textContent, '3');
assert.match(root.querySelector('.character-growth-note').textContent, /^P：临时成长规则/);
view.update({ ...player, exp: 123, expToNext: 0 });
assert.equal(root.querySelector('[data-field="exp"]').children.at(-1).textContent, '123 / MAX · 100%', 'Zero next-level EXP is shown as capped');
view.update(player);
const strengthButton = root.querySelector('.character-ap-button');
assert(strengthButton && !strengthButton.disabled, 'Available AP enables native +1 buttons');
assert.equal(strengthButton.children.at(-1).src, '/asset.png', 'Source AP art is used when exported');
strengthButton.dispatchEvent({ type: 'click', defaultPrevented: false });
assert.equal(requests.length, 1, 'AP button sends one request');
assert.equal(requests[0].stat, 'strength');
assert.equal(root.querySelector('[data-field="strength"]').textContent, '9', 'AP click waits for authoritative result');
assert.equal(strengthButton.disabled, true, 'Pending AP blocks duplicate clicks');
strengthButton.dispatchEvent({ type: 'click', defaultPrevented: false });
assert.equal(requests.length, 1, 'Pending AP does not send duplicate request');
view.receiveAbilityResult({ type: 'abilityResult', requestId: requests[0].requestId, success: true, code: 'ok', abilityStats: { strength: 10, dexterity: 11, intelligence: 44, luck: 6, availableAp: 2 } });
view.update({ ...player, abilityStats: { ...player.abilityStats, strength: 10, availableAp: 2 } });
assert.equal(root.querySelector('[data-field="strength"]').textContent, '10', 'Authoritative AP result refreshes the raw value');
assert.equal(root.querySelector('[data-field="availableAp"]').children.at(-1).textContent, '2');
assert.equal(strengthButton.disabled, false);
view.update({ ...player, derivedStats: { ...player.derivedStats, strength: 10, intelligence: 45 } });
assert.equal(root.querySelector('[data-field="strength"]').textContent, '9', 'Raw attributes remain separate from derived values');
assert.equal(root.querySelector('[data-derived-field="strength"]').textContent, '总 10', 'Derived attributes refresh with snapshots');
assert.equal(root.querySelector('[data-derived-field="intelligence"]').textContent, '总 45', 'Derived attributes use current server values');
view.update({ ...player, derivedStats: { magicAttack: 55, defense: 9, moveSpeed: 120, magicGuard: true } });
assert.equal(root.querySelector('[data-field="luck"]').textContent, '6', 'Raw attributes survive older derived snapshots');
view.update({ ...player, hp: 0 });
assert.equal(strengthButton.disabled, true, 'Dead players cannot allocate AP');
view.update({ ...player, abilityStats: { ...player.abilityStats, availableAp: 0 } });
assert.equal(strengthButton.disabled, true, 'No AP disables allocation');

const key = (code, target = document) => {
  const event = {
    type: 'keydown', code, key: code === 'KeyC' ? 'c' : 'Escape', repeat: false, isComposing: false,
    metaKey: false, altKey: false, ctrlKey: false, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
  target.dispatchEvent(event);
  return event;
};
assert.equal(key('KeyC').defaultPrevented, true, 'C opens the window');
assert.equal(root.hidden, false);
assert.equal(key('KeyC').defaultPrevented, true, 'C toggles the window closed');
assert.equal(root.hidden, true);
key('KeyC');
assert.equal(key('Escape').defaultPrevented, true, 'Escape closes the window');
assert.equal(root.hidden, true);
const input = document.createElement('input');
assert.equal(key('KeyC', input).defaultPrevented, false, 'C in an input is ignored');
assert.equal(root.hidden, true);

view.open();
view.update(undefined);
assert.equal(root.hidden, true, 'Disconnect update closes the window');
assert.equal(root.querySelector('[data-field="username"]').children.at(-1).textContent, '—', 'Disconnect clears values');
view.destroy();
assert.equal(host.querySelector('.tms273-character-host'), null, 'Destroy unmounts the window');
key('KeyC');
assert.equal(host.querySelector('.tms273-character-host'), null, 'Destroy removes the keyboard listener');
assert.deepEqual(messages, [], 'Complete character assets do not emit a missing-resource status');

Object.assign(globalThis, original);
console.log('PASS: character info fields, C/Escape lifecycle, disconnect clear, focus-safe input, and teardown.');
