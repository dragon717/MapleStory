import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Same pattern as the other client checks: transpile the module, drop its
// imports (i18n / character helpers pull in browser-only code), and drive the
// view under node with a minimal DOM stub.
//
// The server owns every party decision, so this only verifies the presentation
// contract.  The four things that would actually break the game if the client
// got them wrong are checked explicitly:
//   1. the window never invents a roster — members only ever come from an
//      authoritative `partyState`, and a `closed` state closes the window;
//   2. every action is an intent carrying a unique request id, and the client
//      never sends a position, a damage value or a party id of its own;
//   3. an intent that the server would refuse for a missing argument (no name,
//      no selected member) is refused locally instead of being sent;
//   4. an unanswered invitation is answered exactly once.
const source = await readFile(new URL('./party-view.ts', import.meta.url), 'utf8');
const outputText = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
  // 资源地址解析（v3 §3.1）：离线圈定下用恒等桩（与 dialogue.check.mjs 同一约定）。
  // 必须在剥 import 之前替换，否则剥完就没有任何定义。
  .replace(/import \{[^}]*\} from '\.\.\/\.\.\/assets\/resource-url';/, 'const resolveAssetUrl = url => url;')
  .replace(/^import .*\r?\n/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

// The module's imports are stripped above, so re-supply the three helpers it
// calls: the locale/error text and the shared job display name.
const helpers = [
  "const uiLocale = () => 'en';",
  "const protocolText = (code, fallback) => (fallback === undefined ? code : fallback);",
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
const { PartyView } = await import(`data:text/javascript;base64,${Buffer.from(moduleText).toString('base64')}`);

// ---------------------------------------------------------------- fixtures
const frame = (url, w = 24, h = 24) => ({ url, width: w, height: h, origin: { x: 0, y: 0 }, x: 0, y: 0, delay: 100 });
const manifest = {
  partyUi: {
    contentVersion: 'tms273-party',
    source: 'test',
    memberSlots: 6,
    ui: {
      backgrnd: frame('/assets/tms273/userlist-backgrnd.png', 312, 389),
      party5: frame('/assets/tms273/party5.png', 279, 18),
      party2: frame('/assets/tms273/party2.png', 279, 4),
      icon0: frame('/assets/tms273/icon0.png', 13, 13),
      icon1: frame('/assets/tms273/icon1.png', 17, 16),
      'BtCreate/normal': frame('/assets/tms273/btcreate.png', 47, 19),
      'BtInvite/normal': frame('/assets/tms273/btinvite.png', 47, 19),
      'BtKick/normal': frame('/assets/tms273/btkick.png', 47, 19),
      'BtWithdraw/normal': frame('/assets/tms273/btwithdraw.png', 47, 19),
      'BtChangeBoss/normal': frame('/assets/tms273/btchangeboss.png', 47, 19),
    },
  },
};
const member = (id, leader = false, job = 0, level = 1) => ({
  id, name: id, level, job, mapId: 'm', hp: 50, maxHp: 50, mp: 5, maxMp: 5, leader,
});

/** Collect every intent the view sends, without a live connection. */
function harness(selfId = 'a') {
  const sent = [];
  const host = new El('div');
  const view = new PartyView(host, manifest, () => {}, message => { sent.push(message); return true; }, () => selfId);
  return { host, view, sent };
}

/** Relative coordinates, in render order, of a subtree's leaf labels. */
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

// ---------------------------------------------------------------- checks
// h01 — opening with no roster renders the solo prompt and sends nothing.
{
  const { host, view, sent } = harness();
  view.open();
  assert.equal(view.isOpen(), true, 'window should report open');
  assert.equal(sent.length, 0, 'opening a window must not send an intent');
  assert.ok(host.children.length > 0, 'window should be attached to the host');
  assert.ok(
    labels(host.children[0]).some(text => /not in a party/i.test(text)),
    'an ungrouped character should be told to create a party',
  );
  view.destroy();
}

// h02 — the roster only ever comes from an authoritative partyState.
{
  const { view } = harness();
  view.open();
  assert.equal(view.roster, undefined, 'no roster before the server sends one');
  view.receiveState({ closed: true });
  assert.equal(view.roster, undefined, 'a closed state must not invent a roster');

  view.receiveState({ partyId: 'p1', leaderId: 'a', members: [member('a', true), member('b')] });
  assert.equal(view.roster.members.length, 2, 'the roster comes from the message');
  assert.equal(view.roster.leaderId, 'a');
  view.destroy();
}

// h03 — a closed state closes the window, which is how a kicked member learns
// the party is over.
{
  const { host, view } = harness();
  view.receiveState({ partyId: 'p1', leaderId: 'a', members: [member('a', true), member('b')] });
  assert.equal(view.isOpen(), true);
  view.receiveState({ closed: true });
  assert.equal(view.isOpen(), false, 'a closed state must close the window');
  assert.ok(host.children[0].removed, 'the window node should be removed');
  assert.equal(view.selectedId, undefined, 'a pending selection must not survive');
  view.destroy();
}

// h04 — inviting sends the name and nothing else, with a unique request id.
{
  const { view, sent } = harness();
  view.open();
  view.nameInput.value = '  Maple  ';
  view.invite();
  assert.equal(sent.length, 1, 'one invite should produce one intent');
  assert.equal(sent[0].type, 'partyInvite');
  assert.equal(sent[0].playerName, 'Maple', 'the name is trimmed');
  assert.match(sent[0].requestId, /^party-invite-/, 'intent needs a unique request id');
  assert.deepEqual(
    Object.keys(sent[0]).sort(),
    ['playerName', 'requestId', 'type'],
    'an invite must not carry a party id, a position or a level',
  );
  assert.equal(view.nameInput.value, '', 'the field clears so the same name can be retyped');

  sent.length = 0;
  view.nameInput.value = '   ';
  view.invite();
  assert.equal(sent.length, 0, 'an empty name must not be sent');
  view.destroy();
}

// h05 — answering an invitation happens exactly once, and the prompt closes.
{
  const { view, sent } = harness('b');
  view.receiveInvite({ invitationId: 'inv-1', fromId: 'a', fromName: 'a' });
  assert.equal(view.isOpen(), true, 'an invitation opens the window');
  view.respond(true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'partyRespond');
  assert.equal(sent[0].accept, true);
  assert.deepEqual(Object.keys(sent[0]).sort(), ['accept', 'requestId', 'type'], 'the answer names no invitation id');
  assert.equal(view.prompt, undefined, 'the prompt is consumed');

  view.respond(false);
  assert.equal(sent.length, 1, 'a prompt already answered must not answer again');
  view.destroy();
}

// h06 — a declined invitation is answered with accept:false (the server, not the
// client, decides that the inviter is told).
{
  const { view, sent } = harness('b');
  view.receiveInvite({ invitationId: 'inv-2', fromId: 'a', fromName: 'a' });
  view.respond(false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].accept, false);
  view.destroy();
}

// h07 — kick / hand-over need a selected member and send only that member's id.
{
  const { view, sent } = harness('a');
  view.receiveState({ partyId: 'p1', leaderId: 'a', members: [member('a', true), member('b')] });

  view.kick();
  assert.equal(sent.length, 0, 'a kick with no selection must not be sent');
  view.handOver();
  assert.equal(sent.length, 0, 'a hand-over with no selection must not be sent');

  view.selectedId = 'b';
  view.kick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'partyKick');
  assert.equal(sent[0].playerId, 'b');
  assert.match(sent[0].requestId, /^party-kick-/);

  view.handOver();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].type, 'partyLeader');
  assert.equal(sent[1].playerId, 'b');
  assert.match(sent[1].requestId, /^party-leader-/);
  view.destroy();
}

// h08 — leaving the party is a single intent.
{
  const { view, sent } = harness('b');
  view.receiveState({ partyId: 'p1', leaderId: 'a', members: [member('a', true), member('b')] });
  view.leave();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'partyLeave');
  assert.match(sent[0].requestId, /^party-leave-/);
  view.destroy();
}

// h09 — the roster renders every member (up to the cap) with the leader marked,
// and the leader's own row is flagged so the player can find itself.
{
  const { host, view } = harness('b');
  view.receiveState({
    partyId: 'p1',
    leaderId: 'a',
    members: [member('a', true, 200, 30), member('b', false, 0, 5)],
  });
  const text = labels(host.children[0]);
  assert.ok(text.includes('a') && text.includes('b'), 'both members should render');
  assert.ok(text.includes('job-200') && text.includes('job-0'), 'a member job comes from the roster message');
  assert.ok(text.includes('30') && text.includes('5'), 'a member level comes from the roster message');
  assert.ok(host.children[0].children.length > 0, 'the shell should hold the roster');

  const rows = [];
  const collect = node => {
    if (node?.dataset?.memberId) rows.push(node);
    for (const child of node.children ?? []) collect(child);
  };
  collect(host.children[0]);
  assert.equal(rows.length, 2, 'one row per member');
  assert.equal(rows[0].children[0].src, manifest.partyUi.ui['icon1'].url, 'the leader row uses the leader marker');
  assert.equal(rows[1].children[0].src, manifest.partyUi.ui['icon0'].url, 'a plain member row uses the plain marker');
  assert.ok(rows[1].classList.contains('is-self'), 'the local character row should be flagged');
  view.destroy();
}

// h10 — a roster larger than the authored slot count is clamped, so the window
// cannot draw a row the source art (and the server's cap) never provided.
{
  const { host, view } = harness('a');
  view.receiveState({
    partyId: 'p1',
    leaderId: 'a',
    members: Array.from({ length: 9 }, (_, index) => member(`p${index}`, index === 0)),
  });
  const rows = [];
  const collect = node => {
    if (node?.dataset?.memberId) rows.push(node);
    for (const child of node.children ?? []) collect(child);
  };
  collect(host.children[0]);
  assert.equal(rows.length, 6, `expected the 6 authored slots, got ${rows.length}`);
  view.destroy();
}

// h11 — results and notices are shown, and a refusal is flagged as an error.
{
  const { view } = harness('a');
  view.receiveState({ partyId: 'p1', leaderId: 'a', members: [member('a', true), member('b')] });
  view.receiveResult('party_full', false);
  assert.equal(view.statusLine.textContent, 'party_full', 'a refusal shows the localized server code');
  assert.equal(view.statusLine.classList.contains('is-error'), true);

  view.receiveResult('', true);
  assert.equal(view.statusLine.classList.contains('is-error'), false);

  view.receiveNotice('party_kicked', 'a');
  assert.equal(view.statusLine.textContent, 'a · party_kicked', 'a notice names the character that caused it');
  assert.equal(view.statusLine.classList.contains('is-error'), true);
  view.destroy();
}

// h12 — closing clears the selection so a stale member id cannot be acted on.
{
  const { host, view } = harness('a');
  view.receiveState({ partyId: 'p1', leaderId: 'a', members: [member('a', true), member('b')] });
  view.selectedId = 'b';
  view.close();
  assert.equal(view.isOpen(), false);
  assert.equal(view.selectedId, undefined, 'selection must not survive a close');
  assert.ok(host.children[0].removed, 'the window node should be removed');
  view.destroy();
}

console.log('party.check.mjs: 12 checks passed');
