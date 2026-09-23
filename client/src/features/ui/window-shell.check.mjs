#!/usr/bin/env node

/**
 * Window chrome (drag / button states / z-order) DOM stub check.
 *
 * `window-shell.ts` is the shared implementation behind every draggable panel,
 * so a regression here silently breaks the minimap, skills, quest, chat and
 * menu windows at once.  This check drives it with the project-wide DOM stub
 * (no jsdom) and asserts the rules written down in `docs/technical/UI_WINDOW_SYSTEM.md` §2:
 * the four drag gates, the activation distance, the lazy de-centring, host
 * clamping, pointer capture, the disposer and the four button states.
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
    if (next && !has) this.add(name); else if (!next && has) this.remove(name);
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
    this.style = {
      properties: new Map(),
      setProperty(name, value) { this.properties.set(name, String(value)); },
      getPropertyValue(name) { return this.properties.get(name) ?? ''; },
    };
    this.className = '';
    this.classList = new FakeClassList(this);
    this.hidden = false;
    this._textContent = '';
    this.ownerDocument = ownerDocument;
    this.rect = { left: 0, top: 0, width: 200, height: 100 };
    this.captured = new Set();
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
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  removeEventListener(type, handler) {
    const list = this.listeners.get(type);
    if (!list) return;
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }
  matchesSelector(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (node.matchesSelector?.(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.matchesSelector(selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
  getBoundingClientRect() { return { ...this.rect }; }
  setPointerCapture(pointerId) { this.captured.add(pointerId); }
  releasePointerCapture(pointerId) { this.captured.delete(pointerId); }
  /** Test helper: replay a listener recorded by `addEventListener`. */
  fire(type, event = {}) {
    const list = [...(this.listeners.get(type) ?? [])];
    let prevented = false;
    for (const handler of list) {
      const payload = { button: 0, pointerId: 1, target: this, preventDefault: () => { prevented = true; }, ...event };
      handler(payload);
    }
    return prevented;
  }
}

class FakeDocument extends FakeElement {
  constructor() { super('#document'); this.ownerDocument = this; }
  createElement(tagName) { return new FakeElement(tagName, this); }
}

const source = await readFile(new URL('./window-shell.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
})
  // 资源地址解析（v3 §3.1）：离线圈定下用恒等桩（与 dialogue.check.mjs 同一约定）。
  // 本检查不剥 import，所以必须**替换**这一行：留着相对说明符会让 `data:` 模块装载失败。
  .outputText.replace(/import \{[^}]*\} from '\.\.\/\.\.\/assets\/resource-url';/, 'const resolveAssetUrl = url => url;');
const { installWindowDrag, bringToFront, createAssetButton, positionAssetButton, clampIntoHost } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const document = new FakeDocument();
globalThis.document = document;
// `installWindowDrag` rejects targets with `target instanceof Element`, so the
// stub class has to be the global `Element` for the gate to be exercised.
globalThis.Element = FakeElement;

/** Build host + window with predictable geometry. */
const makeWindow = ({ hostRect = { left: 0, top: 0, width: 1000, height: 600 }, winRect = { left: 300, top: 200, width: 200, height: 100 } } = {}) => {
  const host = document.createElement('div');
  host.rect = hostRect;
  const win = document.createElement('div');
  win.rect = winRect;
  host.append(win);
  return { host, win };
};

const TITLE = 24;
/**
 * Press in the title bar and move to `to`.  The first move only arms the drag
 * (it has to de-centre the window before it can be moved), so the destination
 * is replayed — the second move is the one that actually repositions.
 */
const drag = (win, { from, to, button = 0, target, pointerId = 1 } = {}) => {
  win.fire('pointerdown', { button, pointerId, target: target ?? win, clientX: from[0], clientY: from[1] });
  win.fire('pointermove', { pointerId, clientX: to[0], clientY: to[1] });
  win.fire('pointermove', { pointerId, clientX: to[0], clientY: to[1] });
};

// ── R2.1 gate: only a primary-button press inside the title bar arms a drag ──
{
  const { host, win } = makeWindow();
  let activated = 0;
  installWindowDrag(host, win, { titleHeight: TITLE, isOpen: () => true, onActivate: () => { activated += 1; } });

  // Below the title strip: nothing happens even after a long move.
  drag(win, { from: [400, 260], to: [500, 360] });
  assert.equal(win.dataset.windowPositioned, undefined, 'press below the title bar never drags');
  assert.equal(activated, 0);

  // Non-primary button.
  drag(win, { from: [400, 210], to: [500, 310], button: 2 });
  assert.equal(win.dataset.windowPositioned, undefined, 'secondary button never drags');
}

// ── R2.1 gate: closed windows ignore the gesture ──
{
  const { host, win } = makeWindow();
  installWindowDrag(host, win, { titleHeight: TITLE, isOpen: () => false });
  drag(win, { from: [400, 210], to: [500, 310] });
  assert.equal(win.dataset.windowPositioned, undefined, 'a closed window is not draggable');
}

// ── R2.1 gate: a press on a button is not a drag (unless allowed) ──
{
  const { host, win } = makeWindow();
  const button = document.createElement('button');
  win.append(button);
  installWindowDrag(host, win, { titleHeight: TITLE, isOpen: () => true });
  drag(win, { from: [400, 210], to: [500, 310], target: button });
  assert.equal(win.dataset.windowPositioned, undefined, 'pressing a title-bar button does not drag');

  const { host: host2, win: win2 } = makeWindow();
  const tracker = document.createElement('button');
  win2.append(tracker);
  installWindowDrag(host2, win2, { titleHeight: TITLE, isOpen: () => true, allowOnButtons: true });
  drag(win2, { from: [400, 210], to: [500, 310], target: tracker });
  assert.equal(win2.dataset.windowPositioned, 'true', 'allowOnButtons keeps the tracker draggable');
}

// ── R2.1: the activation distance keeps a click from nudging the window ──
{
  const { host, win } = makeWindow();
  let activated = 0;
  installWindowDrag(host, win, { titleHeight: TITLE, isOpen: () => true, onActivate: () => { activated += 1; } });
  win.fire('pointerdown', { clientX: 400, clientY: 210 });
  win.fire('pointermove', { clientX: 402, clientY: 211 });
  assert.equal(win.dataset.windowPositioned, undefined, 'a 2 px jitter stays a click');
  assert.equal(activated, 0, 'no activation below the activation distance');
}

// ── R2.2: the first real movement de-centres at the *current* spot ──
{
  const { host, win } = makeWindow();
  let activated = 0;
  installWindowDrag(host, win, { titleHeight: TITLE, isOpen: () => true, onActivate: () => { activated += 1; } });
  win.fire('pointerdown', { clientX: 400, clientY: 210 });
  win.fire('pointermove', { clientX: 460, clientY: 250 });
  assert.equal(win.dataset.windowPositioned, 'true');
  assert.equal(activated, 1, 'onActivate fires once per drag');
  assert.equal(win.style.transform, 'none', 'the CSS centring transform is dropped');
  // The window was at (300,200) inside a host at (0,0) — it must not jump.
  assert.equal(win.style.left, '300px', 'de-centring keeps the on-screen position');
  assert.equal(win.style.top, '200px');
  assert.equal(win.captured.has(1), true, 'pointer capture holds the drag');

  // Continuing the gesture follows the pointer with the grab offset applied.
  win.rect = { left: 360, top: 240, width: 200, height: 100 };
  // Grab offset: the press was 100 px right of / 10 px below the window origin.
  win.fire('pointermove', { clientX: 500, clientY: 300 });
  assert.equal(win.style.left, '400px', 'moves keep the grab offset (500-100)');
  assert.equal(win.style.top, '290px', 'moves keep the grab offset (300-10)');

  win.fire('pointerup', { clientX: 500, clientY: 300 });
  assert.equal(win.captured.has(1), false, 'pointer capture is released on pointerup');
  // A move after the release must not keep dragging the window.
  win.fire('pointermove', { clientX: 900, clientY: 500 });
  assert.equal(win.style.left, '400px', 'the drag stops at pointerup');
  assert.equal(win.style.top, '290px', 'the drag stops at pointerup');
  assert.equal(activated, 1);
}

// ── R2.3: the window never leaves the host box ──
{
  const { host, win } = makeWindow();
  installWindowDrag(host, win, { titleHeight: TITLE, isOpen: () => true });
  drag(win, { from: [400, 210], to: [4000, 4000] });
  assert.equal(win.style.left, '800px', 'right edge is clamped to host width - window width');
  assert.equal(win.style.top, '500px', 'bottom edge is clamped to host height - window height');
  // Grab it again at its clamped spot and throw it past the top-left corner.
  win.rect = { left: 800, top: 500, width: 200, height: 100 };
  drag(win, { from: [900, 510], to: [-500, -500] });
  assert.equal(win.style.left, '0px', 'left edge never goes negative');
  assert.equal(win.style.top, '0px');
}

// ── R2.4: pointercancel ends the drag too ──
{
  const { host, win } = makeWindow();
  installWindowDrag(host, win, { titleHeight: TITLE, isOpen: () => true });
  win.fire('pointerdown', { clientX: 400, clientY: 210 });
  win.fire('pointermove', { clientX: 500, clientY: 310 });
  win.fire('pointermove', { clientX: 500, clientY: 310 });
  assert.equal(win.style.left, '400px', 'the drag is live before the cancel');
  win.fire('pointercancel', { clientX: 500, clientY: 310 });
  win.fire('pointermove', { clientX: 900, clientY: 500 });
  assert.equal(win.style.left, '400px', 'pointercancel releases the drag');
}

// ── R2.5: the disposer removes every listener ──
{
  const { host, win } = makeWindow();
  const dispose = installWindowDrag(host, win, { titleHeight: TITLE, isOpen: () => true });
  dispose();
  assert.equal(win.listeners.get('pointerdown').length, 0);
  assert.equal(win.listeners.get('pointermove').length, 0);
  assert.equal(win.listeners.get('pointerup').length, 0);
  assert.equal(win.listeners.get('pointercancel').length, 0);
  drag(win, { from: [400, 210], to: [500, 310] });
  assert.equal(win.dataset.windowPositioned, undefined, 'a disposed drag is inert');
}

// ── R3: z-order raises through a host counter and a CSS variable ──
{
  const { host, win } = makeWindow();
  const other = document.createElement('div');
  host.append(other);
  bringToFront(host, win);
  assert.equal(win.style.getPropertyValue('--ui-window-z'), '1');
  bringToFront(host, other);
  assert.equal(other.style.getPropertyValue('--ui-window-z'), '2', 'the counter is per host and increasing');
  document.defaultView = { getComputedStyle: node => ({ zIndex: node === other ? '60' : '1' }) };
  bringToFront(host, win);
  assert.equal(win.style.getPropertyValue('--ui-window-z'), '61', 'activation must exceed unmigrated static window layers');
  document.defaultView = undefined;
}

// ── R4: source-frame buttons carry four states and fall back to normal ──
const frame = (url, width = 16, height = 16) => ({ url, width, height, x: 0, y: 0, origin: { x: 0, y: 0 } });
{
  const assets = {
    'AutoBuild/button:close/normal/0': frame('normal.png'),
    'AutoBuild/button:close/mouseOver/0': frame('over.png'),
    'AutoBuild/button:close/pressed/0': frame('pressed.png'),
  };
  let clicked = 0;
  const control = createAssetButton({
    assets, base: 'AutoBuild/button:close', label: '关闭', action: () => { clicked += 1; },
  });
  assert(control, 'a button is built when the normal frame exists');
  assert.equal(control.image.src, 'normal.png');
  assert.equal(control.button.title, '关闭');
  control.button.fire('pointerenter');
  assert.equal(control.button.dataset.state, 'mouseOver');
  assert.equal(control.image.src, 'over.png');
  control.button.fire('pointerdown');
  assert.equal(control.image.src, 'pressed.png');
  control.button.fire('pointerup');
  assert.equal(control.image.src, 'normal.png', 'pointerup returns to normal');
  // `disabled` was never authored → the state falls back to the normal frame.
  control.setState('disabled');
  assert.equal(control.button.dataset.state, 'disabled');
  assert.equal(control.image.src, 'normal.png', 'a missing state falls back to normal');
  control.setState('normal');
  control.button.fire('click', {});
  assert.equal(clicked, 1, 'clicks run the action while enabled');

  // Disabled buttons neither act nor react to hover.
  const disabledControl = createAssetButton({
    assets: { ...assets, 'AutoBuild/button:close/disabled/0': frame('disabled.png') },
    base: 'AutoBuild/button:close', label: '关闭', action: () => { clicked += 1; }, disabled: () => true,
  });
  assert.equal(disabledControl.image.src, 'disabled.png', 'a disabled button starts on its disabled frame');
  disabledControl.button.fire('pointerenter');
  assert.equal(disabledControl.image.src, 'disabled.png', 'hover does not light a disabled button');
  let prevented = disabledControl.button.fire('click', {});
  assert.equal(clicked, 1, 'a disabled click never runs the action');
  assert.equal(prevented, true, 'a disabled click is prevented so it cannot bubble into a drag');

  // A missing normal frame means "not exported" — never a dead button.
  assert.equal(createAssetButton({ assets: {}, base: 'nope', label: 'nope', action: () => {} }), undefined);

  // An empty base addresses windows whose close button has no prefix.
  const bare = createAssetButton({ assets: { 'normal/0': frame('bare.png') }, base: '', label: '关闭', action: () => {} });
  assert.equal(bare.image.src, 'bare.png', 'an empty base resolves `normal/0` directly');
}

// ── Positioning / clamping helpers ──
{
  const button = document.createElement('button');
  positionAssetButton(button, { x: 10, y: 20, width: 16, height: 16 }, 4);
  assert.equal(button.style.left, '6px');
  assert.equal(button.style.top, '16px');
  assert.equal(button.style.width, '24px', 'the hit box is widened by the padding');
  assert.equal(button.style.height, '24px');

  const { host, win } = makeWindow();
  // An unpositioned window is left to CSS (it is still centred).
  clampIntoHost(host, win);
  assert.equal(win.style.left, undefined, 'clampIntoHost skips windows that CSS still positions');
  win.dataset.windowPositioned = 'true';
  win.rect = { left: 900, top: 560, width: 200, height: 100 };
  clampIntoHost(host, win);
  assert.equal(win.style.left, '800px', 'clampIntoHost pulls a window back inside the host');
  assert.equal(win.style.top, '500px');
}

console.log('PASS: window drag gates, activation distance, de-centring, clamping, capture, dispose and button states.');
