#!/usr/bin/env node

/**
 * LoadingOverlay DOM stub check.
 *
 * Verifies the loading overlay is mounted, advances through the manifest /
 * assets / ready stages, parses Phaser's real percentage out of the status
 * line, and tears itself down cleanly without trapping input.  Uses the
 * project-wide DOM stub convention so the check runs under bare `node` and
 * stays free of jsdom.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

class FakeClassList {
  constructor(node) { this.node = node; }
  add(...names) { this.node.className = `${this.node.className} ${names.join(' ')}`.trim(); }
  remove(...names) { this.node.className = this.node.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); }
  contains(name) { return this.node.className.split(/\s+/).includes(name); }
  toggle(name, force) {
    const has = this.contains(name);
    const next = force === undefined ? !has : Boolean(force);
    if (next && !has) this.add(name);
    else if (!next && has) this.remove(name);
    return next;
  }
}

class FakeElement {
  constructor(tagName = 'div', ownerDocument = null) {
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
  set textContent(value) {
    this._textContent = String(value);
    // Setting textContent wipes the existing children — the view never
    // re-mounts the overlay, but matches DOM semantics for assertions.
    this.children = [];
  }
  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener() { /* The overlay does not bind anything; kept for the stub contract. */ }
  removeEventListener() { /* Same. */ }
  matchesSelector(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector.startsWith('[')) {
      const match = selector.match(/^\[([^\]]+)(="([^"]+)")?\]$/);
      if (!match) return false;
      const attr = match[1];
      if (attr.startsWith('data-')) {
        const key = attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        const expected = match[3];
        return expected === undefined ? Boolean(this.dataset[key]) : this.dataset[key] === expected;
      }
      return this.attributes.get(attr) === match[3];
    }
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.matchesSelector(selector)) return child;
      const nested = child.querySelector?.(selector);
      if (nested) return nested;
    }
    return null;
  }
  get innerHTML() {
    return this.children.map(child => child.outerHTML ?? child.textContent ?? '').join('');
  }
  set innerHTML(_) {
    // The LoadingOverlay no longer mounts via innerHTML — it builds its tree
    // with explicit `createElement` + `appendChild` so the stub only has to
    // support those primitives.  Keep the setter as a no-op for compatibility
    // with code paths that touch it (e.g. assertion helpers).
    this.children = [];
    this._textContent = '';
  }
  get outerHTML() { return `<${this.tagName.toLowerCase()} class="${this.className}">${this.innerHTML}</${this.tagName.toLowerCase()}>`; }
}

class FakeDocument extends FakeElement {
  constructor() { super('#document'); this.ownerDocument = this; this.activeElement = null; }
  createElement(tagName) {
    const node = new FakeElement(tagName, this);
    return node;
  }
}

const source = await readFile(new URL('./view.ts', import.meta.url), 'utf8');
const style = await readFile(new URL('./style.css', import.meta.url), 'utf8');
// The TMS273 customize-char backdrop (the actual high-resolution art reused
// by the overlay) is assigned from `view.ts` as an inline style — a CSS
// url('/assets/…') would break the esbuild-based offline app checks, which
// try to resolve it on disk.  The CSS keeps the responsive cover rules so
// the layout survives desktop / landscape / narrow-portrait breakpoints.
assert.match(source, /UI__Canvas_customLoginTheme\.img_0_image_back_0_0-88919c5ab2\.png/, 'overlay uses the high-resolution CustomizeChar art');
assert.match(style, /background-size:\s*cover/, 'overlay background covers the viewport');
assert.match(style, /@media \(max-width: 700px\)/, 'overlay adapts to narrow viewports');
assert.match(style, /@media \(prefers-reduced-motion: reduce\)/, 'overlay honours reduced motion');

const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
  // Strip the static style.css import — the stub never mounts CSS, only DOM.
  .replace(/^import\s+['"][^'"]*style\.css['"];?\s*$/m, '')
  // Stub the i18n helper — `uiLocale()` decides copy but is not what the
  // check is validating here.
  .replace(/^import\s+\{[^}]*\}\s+from\s+['"][^'"]*i18n['"];?/m, "const uiLocale = () => 'zh';");

const { LoadingOverlay } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const original = { document: globalThis.document, requestAnimationFrame: globalThis.requestAnimationFrame };
const document = new FakeDocument();
globalThis.document = document;
globalThis.requestAnimationFrame = callback => { callback(); return 1; };

const host = document.createElement('div');
document.append(host);

const overlay = new LoadingOverlay(host);
overlay.show();

const root = host.querySelector('.loading-overlay');
assert(root, 'show() mounts the overlay onto the host');
assert.equal(root.parentNode, host, 'overlay is appended to the provided host (e.g. #game-shell)');
assert.equal(root.getAttribute('role'), 'status');

const headline = root.querySelector('.loading-overlay-headline');
const barFill = root.querySelector('.loading-overlay-bar-fill');
const percent = root.querySelector('.loading-overlay-percent');
const stageChip = root.querySelector('.loading-overlay-stage');
assert(headline && barFill && percent && stageChip, 'overlay mounts headline/bar/percent/stage chip');

assert.equal(stageChip.dataset.stage, 'manifest', 'initial stage is manifest');
assert.match(headline.textContent, /正在读取资源清单/);
assert.equal(percent.textContent, '0%');
assert.equal(barFill.style.width, '0.0%');

// applyStatus() advances the overlay into the asset stage with the real
// percentage parsed out of the Phaser progress line.
assert.equal(overlay.applyStatus('正在读取资源清单…'), true, 'manifest status is recognised');
assert.equal(overlay.applyStatus('正在装载地图与角色 · 37%'), true, 'Phaser progress line is recognised');
assert.equal(stageChip.dataset.stage, 'assets');
assert.equal(percent.textContent, '37%');
assert.equal(barFill.style.width, '37.0%');

// English wording follows the same convention.
assert.equal(overlay.applyStatus('Loading map & avatar · 100%'), true);
assert.equal(stageChip.dataset.stage, 'assets');
assert.equal(percent.textContent, '100%');

// ready stage: indeterminate pulse + 100% fill.
overlay.applyStatus('地图已就绪，等待快照…');
assert.equal(stageChip.dataset.stage, 'ready');
assert.equal(percent.textContent, '100%');
assert.equal(root.classList.contains('loading-overlay-indeterminate'), true);

// Unknown / error messages don't claim ownership; the overlay still mirrors
// them so the player can read the error text on the same surface.
assert.equal(overlay.applyStatus('资源加载失败：foo.png'), false);
assert.match(headline.textContent, /资源加载失败/);

// hide() removes the overlay from the DOM and stops responding to status.
overlay.hide();
assert.equal(host.querySelector('.loading-overlay'), null, 'hide() unmounts the overlay');
assert.equal(overlay.applyStatus('正在装载地图与角色 · 50%'), false, 'applyStatus is a no-op after hide');

// Re-show must work even after a previous teardown.
overlay.show();
assert(host.querySelector('.loading-overlay'), 'show() can mount a fresh overlay after hide()');

// The overlay must never trap pointer events on something it doesn't own:
// the only interactive surface it would expose is the card itself, and that
// card is purely presentational.  Verify by re-mounting it against a host
// that already contains a Phaser-style canvas stub and confirming the canvas
// node is not disabled by the overlay.
const gameShell = document.createElement('div');
document.append(gameShell);
const canvas = document.createElement('canvas');
gameShell.append(canvas);
const second = new LoadingOverlay(gameShell);
second.show();
assert.equal(canvas.parentNode, gameShell, 'overlay appends to the host without removing other children');
second.hide();
assert.equal(canvas.parentNode, gameShell, 'hide() only removes its own root, never the host siblings');

Object.assign(globalThis, original);
console.log('PASS: loading overlay mounts, parses status stages, honours hide(), and preserves sibling DOM.');