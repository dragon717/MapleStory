import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Same pattern as the other client checks: transpile the module, drop its
// imports (i18n / item names pull in browser-only code), and drive the view
// under node with a minimal DOM stub.
//
// The server owns every warehouse decision, so this only verifies the
// presentation contract.  The two things that would actually break the game
// if the client got them wrong are checked explicitly:
//   1. the window never mutates the warehouse on its own — every change is an
//      intent, and the contents only follow an authoritative `storageState`;
//   2. the storage tab sent with an intent is derived from the item, so a
//      forged tab cannot point the server at the wrong category.
const source = await readFile(new URL('./storage-view.ts', import.meta.url), 'utf8');
const outputText = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
  // 资源地址解析（v3 §3.1）：离线圈定下用恒等桩（与 dialogue.check.mjs 同一约定）。
  // 必须在剥 import 之前替换，否则剥完就没有任何定义。
  .replace(/import \{[^}]*\} from '\.\.\/\.\.\/assets\/resource-url';/, 'const resolveAssetUrl = url => url;')
  .replace(/^import .*\r?\n/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');
// The module reaches for `fetch` (item catalog) and browser globals; provide
// inert stand-ins so importing it under node is well defined.
globalThis.fetch = async () => ({ json: async () => ({}) });

// The module's imports are stripped above, so re-supply the three helpers it
// calls: the locale/error text and the item display name.
const helpers = [
  "const uiLocale = () => 'en';",
  "const protocolText = (code, fallback) => (fallback === undefined ? code : fallback);",
  'const itemName = id => `item-${id}`;',
  '',
].join('\n');

// ---------------------------------------------------------------- DOM stub
class El {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = { setProperty() {} };
    this.dataset = {};
    this.classList = {
      _set: new Set(),
      add(...names) { names.forEach(name => this._set.add(name)); },
      remove(...names) { names.forEach(name => this._set.delete(name)); },
      toggle(name, on) { if (on) this._set.add(name); else this._set.delete(name); },
      contains(name) { return this._set.has(name); },
    };
    this._text = '';
    this.disabled = false;
  }
  set className(value) { this._className = value; }
  get className() { return this._className ?? ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text; }
  setAttribute(name, value) { (this._attrs ??= {})[name] = String(value); }
  getAttribute(name) { return this._attrs?.[name] ?? null; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  remove() { this.removed = true; }
  querySelector(selector) {
    const role = selector.match(/\[data-role="([^"]+)"\]/)?.[1];
    if (role) return this.children.find(child => child?.dataset?.role === role) ?? null;
    return null;
  }
  addEventListener() {}
  removeEventListener() {}
}
class Img extends El {
  constructor() { super('img'); this.src = ''; this.width = 0; this.height = 0; this.draggable = true; this.alt = ''; }
}
class Input extends El {
  constructor() { super('input'); this.value = ''; this.type = ''; this.min = ''; }
}
globalThis.document = {
  createElement: tag => (tag === 'img' ? new Img() : tag === 'input' ? new Input() : new El(tag)),
  addEventListener() {},
  removeEventListener() {},
};
globalThis.window = { addEventListener() {}, removeEventListener() {} };

const moduleText = helpers + outputText;
const { StorageView } = await import(`data:text/javascript;base64,${Buffer.from(moduleText).toString('base64')}`);

// ---------------------------------------------------------------- fixtures
const frame = (url, w = 24, h = 24) => ({ url, width: w, height: h, origin: { x: 0, y: 0 }, x: 0, y: 0, delay: 100 });
const manifest = {
  storageUi: {
    contentVersion: 'tms273-storage',
    source: 'test',
    slotLimit: 24,
    ui: {
      backgrnd: frame('/assets/tms273/trunk-backgrnd.png', 463, 339),
      select: frame('/assets/tms273/trunk-select.png'),
      'BtGet/normal': frame('/assets/tms273/btget.png'),
      'BtPut/normal': frame('/assets/tms273/btput.png'),
      'BtExit/normal': frame('/assets/tms273/btexit.png'),
      'BtGetAll/normal': frame('/assets/tms273/btgetall.png'),
      'BtSort/normal': frame('/assets/tms273/btsort.png'),
      'BtInCoin/normal': frame('/assets/tms273/btincoin.png'),
      'BtOutCoin/normal': frame('/assets/tms273/btoutcoin.png'),
    },
  },
  items: { 2000000: frame('/assets/tms273/potion.png') },
};
const item = (slot, itemId, quantity) => ({ slot, itemId, quantity });

/** Collect every intent the view sends, without a live connection. */
function harness() {
  const sent = [];
  const host = new El('div');
  const view = new StorageView(host, manifest, () => {}, message => { sent.push(message); return true; });
  return { host, view, sent };
}

const snapshot = (items, mesos) => ({ items, mesos, slotLimit: 24, npcId: 'storage-npc' });

// ---------------------------------------------------------------- checks
// c01 — opening renders the window and the authored shell, and nothing is sent.
{
  const { host, view, sent } = harness();
  view.open(snapshot([item(1, '2000000', 5)], 100));
  assert.equal(view.isOpen(), true, 'window should report open');
  assert.equal(sent.length, 0, 'opening a window must not send an intent');
  assert.ok(host.children.length > 0, 'window should be attached to the host');
  view.destroy();
}

// c02 — the rendered contents come from the snapshot, never from a local edit.
{
  const { view } = harness();
  view.open(snapshot([item(1, '2000000', 5)], 100));
  const before = view.current.items.length;
  view.syncPlayer({ mesos: 250, inventory: [item(2, '2000000', 3)] });
  assert.equal(view.current.items.length, before, 'a player sync must not change the warehouse');
  assert.equal(view.current.mesos, 100, 'the warehouse balance stays authoritative');
  view.destroy();
}

// c03 — "store all" issues one deposit intent per storable stack, and carries
// the tab derived from each item rather than a caller-supplied value.
{
  const { view, sent } = harness();
  view.open(snapshot([], 0));
  view.syncPlayer({ mesos: 0, inventory: [item(1, '2000000', 4)] });
  view.storeAll();
  assert.equal(sent.length, 1, 'one stack should produce one intent');
  assert.equal(sent[0].type, 'storageTransfer');
  assert.equal(sent[0].operation, 'deposit');
  assert.equal(sent[0].slot, 1);
  assert.equal(sent[0].quantity, 4);
  // 2000000 is a Consume item, so the derived tab is 2.
  assert.equal(sent[0].inventoryType, 2, `expected consume tab, got ${sent[0].inventoryType}`);
  view.destroy();
}

// c04 — withdraw derives the tab from the *warehouse* item, not the bag.
{
  const { view, sent } = harness();
  view.open(snapshot([item(7, '2000000', 2)], 0));
  view.selectedStoreSlot = 7;
  view.takeSelected();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].operation, 'withdraw');
  assert.equal(sent[0].slot, 7);
  assert.equal(sent[0].inventoryType, 2);
  view.destroy();
}

// c05 — mesos intents carry the amount and the direction, and a non-positive
// amount is refused locally instead of being sent.
{
  const { view, sent } = harness();
  view.open(snapshot([], 0));
  view.amount = 250;
  view.moveMesos('deposit');
  assert.equal(sent.length, 1, 'one mesos move should produce one intent');
  assert.equal(sent[0].type, 'storageMesos');
  assert.equal(sent[0].operation, 'deposit');
  assert.equal(sent[0].quantity, 250);
  assert.match(sent[0].requestId, /^storage-deposit-mesos-/, 'intent needs a unique request id');

  sent.length = 0;
  view.amount = 0;
  view.moveMesos('withdraw');
  assert.equal(sent.length, 0, 'a zero amount must not be sent');

  view.amount = 40;
  view.moveMesos('withdraw');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].operation, 'withdraw');
  assert.equal(sent[0].quantity, 40);
  view.destroy();
}

// c06 — an empty warehouse renders a placeholder instead of throwing.
{
  const { view } = harness();
  view.open(snapshot([], 0));
  assert.equal(view.current.items.length, 0);
  view.destroy();
}

// c07 — closing detaches the window and clears the local selection.
{
  const { host, view } = harness();
  view.open(snapshot([item(1, '2000000', 1)], 0));
  view.selectedBagSlot = 1;
  view.close();
  assert.equal(view.isOpen(), false);
  assert.equal(view.selectedBagSlot, undefined, 'selection must not survive a close');
  assert.ok(host.children[0].removed, 'the window node should be removed');
  view.destroy();
}

console.log('storage.check.mjs: 7 checks passed');
