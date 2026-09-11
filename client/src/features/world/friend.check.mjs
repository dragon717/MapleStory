import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Same pattern as the other client checks: transpile the module, drop its
// imports (i18n / character helpers pull in browser-only code), and drive the
// view under node with a minimal DOM stub.
//
// The server owns every friend decision, so this only verifies the presentation
// contract.  The things that would actually break the game if the client got
// them wrong are checked explicitly:
//   1. the window never invents a row — friends and blocked rows only ever come
//      from an authoritative `friendState`, and both lists are required because
//      a block also dissolves a friendship;
//   2. opening *asks* (friendOpen) instead of waiting: a friend row is an
//      account fact, so unlike the party roster it is not pushed unprompted;
//   3. every action is an intent carrying a unique request id, and the client
//      never sends a level, an online flag or a list of its own;
//   4. an intent the server would refuse for a missing argument (no name, no
//      selected row) is refused locally instead of being sent;
//   5. an offline row shows no location at all.
const source = await readFile(new URL('./friend-view.ts', import.meta.url), 'utf8');
const outputText = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
  .replace(/^import .*\r?\n/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

// The module's imports are stripped above, so re-supply the four helpers it
// calls: the locale, the error text, the map label and the shared job name.
const helpers = [
  "const uiLocale = () => 'en';",
  "const protocolText = (code, fallback) => (fallback === undefined ? code : fallback);",
  'const mapText = (id, name) => name;',
  'const characterJobName = job => `job-${job}`;',
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
    this.hidden = false;
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
  querySelector() { return null; }
  addEventListener() {}
  removeEventListener() {}
}
class Img extends El {
  constructor() { super('img'); this.src = ''; this.width = 0; this.height = 0; this.draggable = true; this.alt = ''; }
}
class Input extends El {
  constructor() { super('input'); this.value = ''; this.type = ''; this.maxLength = 0; this.placeholder = ''; }
}
globalThis.document = {
  createElement: tag => (tag === 'img' ? new Img() : tag === 'input' ? new Input() : new El(tag)),
  createTextNode: text => { const node = new El('#text'); node.textContent = text; return node; },
  addEventListener() {},
  removeEventListener() {},
};
globalThis.window = { addEventListener() {}, removeEventListener() {} };

const moduleText = helpers + outputText;
const { FriendView } = await import(`data:text/javascript;base64,${Buffer.from(moduleText).toString('base64')}`);

// ---------------------------------------------------------------- fixtures
const frame = (url, w = 24, h = 24) => ({ url, width: w, height: h, origin: { x: 0, y: 0 }, x: 0, y: 0, delay: 100 });
const manifest = {
  friendUi: {
    contentVersion: 'tms273-friend',
    source: 'test',
    tabCount: 6,
    ui: {
      backgrnd: frame('/assets/tms273/userlist-backgrnd.png', 312, 389),
      'Tab/enabled/0': frame('/assets/tms273/tab0-on.png', 27, 15),
      'Tab/disabled/0': frame('/assets/tms273/tab0-off.png', 25, 14),
      'Tab/enabled/1': frame('/assets/tms273/tab1-on.png', 26, 16),
      'Tab/disabled/1': frame('/assets/tms273/tab1-off.png', 25, 14),
      'BtAddFriend/normal': frame('/assets/tms273/btaddfriend.png', 65, 18),
      'BtDelete/normal': frame('/assets/tms273/btdelete.png', 47, 19),
      'BtBlock/normal': frame('/assets/tms273/btblock.png', 60, 18),
      'BlackList/BtAdd/normal': frame('/assets/tms273/bladd.png', 68, 17),
      'BlackList/BtDelete/normal': frame('/assets/tms273/bldelete.png', 68, 17),
    },
  },
};
const entry = (id, online = false, mapId = '', job = 0, level = 1) => ({ id, name: id, level, job, online, mapId });

/** Collect every intent the view sends, without a live connection. */
function harness(selfId = 'a') {
  const sent = [];
  const host = new El('div');
  const view = new FriendView(host, manifest, () => {}, message => { sent.push(message); return true; }, () => selfId);
  return { host, view, sent };
}

/** Every leaf label of a subtree, in render order. */
function labels(root) {
  const out = [];
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.textContent === 'string' && node.textContent) out.push(node.textContent);
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return out;
}

/** Every rendered row, keyed by the player id the view stamped on it. */
function rows(root) {
  const out = [];
  const collect = node => {
    if (node?.dataset?.playerId) out.push(node);
    for (const child of node.children ?? []) collect(child);
  };
  collect(root);
  return out;
}

/** The labels of the action buttons currently offered. */
function actionLabels(root) {
  const find = node => {
    if (!node || typeof node !== 'object') return null;
    if (node.className === 'friend-actions') return node.children.map(child => child.title);
    for (const child of node.children ?? []) {
      const hit = find(child);
      if (hit) return hit;
    }
    return null;
  };
  return find(root) ?? [];
}

// ---------------------------------------------------------------- checks
// h01 — opening asks the server for the rows instead of waiting: a friend row
// is an account fact, so nothing pushes it unprompted the way a party does.
{
  const { host, view, sent } = harness();
  view.open();
  assert.equal(view.isOpen(), true, 'window should report open');
  assert.equal(sent.length, 1, 'opening must ask the server for the rows');
  assert.equal(sent[0].type, 'friendOpen');
  assert.match(sent[0].requestId, /^friend-open-/, 'intent needs a unique request id');
  assert.deepEqual(Object.keys(sent[0]).sort(), ['requestId', 'type'], 'an open carries no ids or flags');
  assert.ok(host.children.length > 0, 'window should be attached to the host');
  assert.ok(
    labels(host.children[0]).some(text => /no friends yet/i.test(text)),
    'an empty friend list should be explained',
  );
  view.destroy();
}

// h02 — rows only ever come from an authoritative friendState, and both lists
// are required: a block dissolves a friendship, so a half-window would let the
// client show a row the account no longer has.
{
  const { host, view } = harness();
  view.open();
  assert.equal(view.friends, undefined, 'no friends before the server answers');

  view.receiveState({ friends: [entry('b', true, 'm')] });
  assert.equal(view.friends, undefined, 'a half view must be ignored');

  view.receiveState({ friends: [entry('b', true, 'm')], blocked: [] });
  assert.equal(view.friends.length, 1);
  assert.equal(rows(host.children[0]).length, 1, 'the row comes from the message');
  view.destroy();
}

// h03 — adding sends the trimmed name and nothing else; an empty name is
// refused locally instead of being sent.
{
  const { view, sent } = harness();
  view.open();
  sent.length = 0;
  view.nameInput.value = '  Maple  ';
  view.addFriend();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'friendAdd');
  assert.equal(sent[0].playerName, 'Maple', 'the name is trimmed');
  assert.match(sent[0].requestId, /^friend-add-/);
  assert.deepEqual(
    Object.keys(sent[0]).sort(),
    ['playerName', 'requestId', 'type'],
    'an add must not carry an id, a level or an online flag',
  );
  assert.equal(view.nameInput.value, '', 'the field clears so the same name can be retyped');

  sent.length = 0;
  view.nameInput.value = '   ';
  view.addFriend();
  assert.equal(sent.length, 0, 'an empty name must not be sent');
  view.destroy();
}

// h04 — removing needs a selected row and sends only that row's id.
{
  const { view, sent } = harness();
  view.receiveState({ friends: [entry('b'), entry('c')], blocked: [] });
  view.open();
  sent.length = 0;

  view.removeFriend();
  assert.equal(sent.length, 0, 'a removal with no selection must not be sent');

  view.selectedId = 'b';
  view.removeFriend();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'friendRemove');
  assert.equal(sent[0].playerId, 'b');
  assert.match(sent[0].requestId, /^friend-remove-/);
  view.destroy();
}

// h05 — blocking sends a typed name; unblocking needs a selected row and sends
// only that row's id.
{
  const { view, sent } = harness();
  view.receiveState({ friends: [], blocked: [entry('b')] });
  view.tab = 1;
  view.open();
  sent.length = 0;

  view.nameInput.value = 'Nova';
  view.block();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'friendBlock');
  assert.equal(sent[0].playerName, 'Nova');
  assert.deepEqual(Object.keys(sent[0]).sort(), ['playerName', 'requestId', 'type']);

  view.unblock();
  assert.equal(sent.length, 1, 'an unblock with no selection must not be sent');

  view.selectedId = 'b';
  view.unblock();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].type, 'friendUnblock');
  assert.equal(sent[1].playerId, 'b');
  assert.match(sent[1].requestId, /^friend-unblock-/);
  view.destroy();
}

// h06 — the action row follows the tab, so a window showing friends can never
// offer "unblock" and a window showing the blacklist can never offer "delete".
{
  const { host, view } = harness();
  view.receiveState({ friends: [entry('b')], blocked: [entry('c')] });
  view.tab = 0;
  view.open();
  const friendActions = actionLabels(host.children[0]);
  assert.ok(friendActions.some(label => /add friend/i.test(label)), 'the friend tab offers add');
  assert.ok(friendActions.some(label => /delete friend/i.test(label)), 'the friend tab offers delete');
  assert.ok(!friendActions.some(label => /unblock/i.test(label)), 'the friend tab must not offer unblock');

  view.tab = 1;
  view.render();
  const blockedActions = actionLabels(host.children[0]);
  assert.ok(blockedActions.some(label => /unblock/i.test(label)), 'the blacklist tab offers unblock');
  assert.ok(!blockedActions.some(label => /delete friend/i.test(label)), 'the blacklist tab must not offer delete');
  view.destroy();
}

// h07 — a row shows the online flag, the name, the job and the level, and an
// offline row shows no location at all rather than a stale one.
{
  const { host, view } = harness();
  view.receiveState({
    friends: [entry('b', true, 'map-1', 200, 30), entry('c', false, '', 0, 5)],
    blocked: [],
  });
  view.open();
  const rendered = rows(host.children[0]);
  assert.equal(rendered.length, 2, 'one row per friend');
  const online = rendered.find(node => node.dataset.playerId === 'b');
  const offline = rendered.find(node => node.dataset.playerId === 'c');
  assert.ok(online.classList.contains('is-online'), 'the live row is flagged online');
  assert.ok(offline.classList.contains('is-offline'), 'the absent row is flagged offline');

  const onlineText = labels(online);
  assert.ok(onlineText.includes('b'), 'the name comes from the message');
  assert.ok(onlineText.includes('job-200'), 'the job comes from the message');
  assert.ok(onlineText.includes('30'), 'the level comes from the message');
  assert.ok(onlineText.includes('map-1'), 'a live character shows where it is');

  const offlineText = labels(offline);
  assert.ok(!offlineText.includes(''), 'an offline row shows no location');
  assert.equal(offlineText.filter(text => text === 'map-1').length, 0, 'no stale map id for an offline row');
  view.destroy();
}

// h08 — a row that disappears from the pushed state cannot stay selected:
// acting on a stale id is exactly what the server would refuse.
{
  const { view } = harness();
  view.receiveState({ friends: [entry('b'), entry('c')], blocked: [] });
  view.selectedId = 'b';
  view.receiveState({ friends: [entry('c')], blocked: [] });
  assert.equal(view.selectedId, undefined, 'a removed row must not stay selected');
  view.destroy();
}

// h09 — clicking a row toggles the selection, and clicking it again clears it.
{
  const { host, view } = harness();
  view.receiveState({ friends: [entry('b')], blocked: [] });
  view.open();
  const row = rows(host.children[0]).find(node => node.dataset.playerId === 'b');
  row.onclick();
  assert.equal(view.selectedId, 'b', 'the first click selects');
  rows(host.children[0]).find(node => node.dataset.playerId === 'b').onclick();
  assert.equal(view.selectedId, undefined, 'the second click clears');
  view.destroy();
}

// h10 — a refusal shows the localized server code and is flagged as an error.
{
  const { view } = harness();
  view.open();
  view.receiveResult('friend_already', false);
  assert.equal(view.statusLine.textContent, 'friend_already', 'a refusal shows the localized code');
  assert.equal(view.statusLine.classList.contains('is-error'), true);

  view.receiveResult('', true);
  assert.equal(view.statusLine.classList.contains('is-error'), false, 'a success is not an error');
  view.destroy();
}

// h11 — closing clears the selection and the window node; destroy also drops
// the cached rows so a later session cannot render the previous account's list.
{
  const { host, view } = harness();
  // Unlike a party roster, an incoming `friendState` must never pop the window
  // open by itself — it is also pushed when a friend merely logs in.
  view.receiveState({ friends: [entry('b')], blocked: [] });
  assert.equal(view.isOpen(), false, 'an unsolicited refresh must not open the window');
  view.open();
  assert.equal(view.isOpen(), true);
  view.selectedId = 'b';
  view.close();
  assert.equal(view.isOpen(), false);
  assert.equal(view.selectedId, undefined, 'selection must not survive a close');
  assert.ok(host.children[0].removed, 'the window node should be removed');

  view.destroy();
  assert.equal(view.friends, undefined, 'destroy must drop the cached rows');
}

// h12 — the authored tab plates drive the tab strip, and switching tabs drops a
// selection that belonged to the other list.
{
  const { host, view } = harness();
  view.receiveState({ friends: [entry('b')], blocked: [entry('c')] });
  view.open();

  const tabs = [];
  const collect = node => {
    if (node?.className?.includes('friend-tab') && node.classList) tabs.push(node);
    for (const child of node.children ?? []) collect(child);
  };
  collect(host.children[0]);
  const strip = tabs.filter(node => node.getAttribute('role') === 'tab');
  assert.equal(strip.length, 2, 'the window drives the two authored tabs');
  assert.equal(strip[0].getAttribute('aria-selected'), 'true', 'the friend tab starts selected');
  assert.equal(strip[1].getAttribute('aria-selected'), 'false');
  // The selected tab uses the authored `enabled` plate and the other the
  // `disabled` one, so the strip cannot be invented locally.
  assert.equal(strip[0].children[0].src, manifest.friendUi.ui['Tab/enabled/0'].url);
  assert.equal(strip[1].children[0].src, manifest.friendUi.ui['Tab/disabled/1'].url);

  view.selectedId = 'b';
  strip[1].onclick();
  assert.equal(view.tab, 1, 'clicking the blacklist tab switches the window');
  assert.equal(view.selectedId, undefined, 'a selection from the other list must be dropped');
  view.destroy();
}

console.log('friend.check.mjs: 12 checks passed');
