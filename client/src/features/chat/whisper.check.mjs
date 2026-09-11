import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Same pattern as the other client checks: transpile the module, drop its
// imports, and drive the view under node with a minimal DOM stub.
//
// A whisper is the missing half of the chat module, and the client half of it
// is deliberately thin — every decision is the server's.  What has to be true
// here is the presentation contract:
//   1. the client sends a *name* and a body, never an id, a map or a channel;
//   2. the two-step input (target, then body) never invents a second window —
//      it reuses the one 273 input bar;
//   3. a whisper line is rendered only from an authoritative whisperMessage,
//      and the direction comes from `selfId`, not from a client-supplied flag;
//   4. the sender's echo merges its pending line by request id, so a message is
//      never shown twice (including on a replayed echo);
//   5. a rejection restores the draft *and* keeps the target, so the player can
//      simply correct the line and send again.
const source = await readFile(new URL('./view.ts', import.meta.url), 'utf8');
const outputText = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
  .replace(/^import .*\r?\n/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

// The module's imports are stripped above, so re-supply what it calls.
const helpers = [
  'const appendChatLogLine = (parent, line) => { parent.children.push(line); };',
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
  // Real DOM semantics: reading a node with children returns their combined
  // text, so a line that was re-rendered no longer reports its old label.
  get textContent() {
    return this.children.length
      ? this.children.map(child => (typeof child === 'object' ? child.textContent : String(child))).join('')
      : this._text;
  }
  setAttribute(name, value) { (this._attrs ??= {})[name] = String(value); }
  getAttribute(name) { return this._attrs?.[name] ?? null; }
  removeAttribute(name) { if (this._attrs) delete this._attrs[name]; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  remove() { this.removed = true; }
  focus() {}
  blur() {}
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
const { ChatView } = await import(`data:text/javascript;base64,${Buffer.from(moduleText).toString('base64')}`);

// ---------------------------------------------------------------- fixtures
const frame = (url, w = 24, h = 24) => ({ url, width: w, height: h, origin: { x: 0, y: 0 }, x: 0, y: 0, delay: 100 });
const nineSlice = () => Object.fromEntries(
  ['nw', 'n', 'ne', 'w', 'c', 'e', 'sw', 's', 'se'].map(name => [name, frame(`/assets/tms273/chat-${name}.png`, 8, 8)]),
);
const states = () => ({ normal: frame('/assets/tms273/chat-target.png', 18, 18) });
const manifest = {
  chatUi: {
    contentVersion: 'tms273-chat',
    source: 'test',
    panel: {
      background: nineSlice(),
      collapsedBackground: nineSlice(),
      collapseButton: states(),
      expandButton: states(),
    },
    input: { background: nineSlice(), target: states(), whisper: states() },
  },
};

function harness(selfId = 'alice', sendWhisper = true) {
  const sent = [];
  const statuses = [];
  const host = new El('div');
  const hooks = {
    send: (requestId, text) => { sent.push({ type: 'chatSend', requestId, text }); return true; },
    selfId: () => selfId,
  };
  if (sendWhisper) {
    hooks.sendWhisper = (requestId, targetName, text) => {
      sent.push({ type: 'whisperSend', requestId, targetName, text });
      return true;
    };
  }
  const view = new ChatView(host, manifest, message => statuses.push(message), hooks);
  view.setAvailable(true);
  return { host, view, sent, statuses };
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

const lines = view => view.systemLog.children;

// w01 — `/w <name> <text>` is one whisper intent carrying a name and a body and
// nothing else: no id, no map, no direction.
{
  const { view, sent } = harness();
  view.input.value = '/w  bob   晚上一起打怪吗  ';
  view.submit();
  assert.equal(sent.length, 1, 'a whisper command must send exactly one intent');
  assert.equal(sent[0].type, 'whisperSend');
  assert.equal(sent[0].targetName, 'bob');
  assert.equal(sent[0].text, '晚上一起打怪吗');
  assert.deepEqual(
    Object.keys(sent[0]).sort(),
    ['requestId', 'targetName', 'text', 'type'],
    'a whisper carries no id, map or channel',
  );
  view.destroy();
}

// w02 — the 273 whisper button collects the target first and the body second,
// and the first step sends nothing at all.
{
  const { view, sent, statuses } = harness();
  view.beginWhisper();
  assert.equal(sent.length, 0, 'entering a target is not an intent');
  assert.equal(view.input.placeholder, '悄悄話对象名字');
  view.input.value = '  bob  ';
  view.submit();
  assert.equal(sent.length, 0, 'the target step must not send anything');
  assert.equal(view.input.placeholder, '悄悄話 → bob', 'the second step names the target');
  view.input.value = '在吗';
  view.submit();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].targetName, 'bob');
  assert.equal(sent[0].text, '在吗');
  assert.ok(statuses.length === 0, 'a successful send reports nothing');
  view.destroy();
}

// w03 — an empty line leaves whisper input instead of sending a blank message.
{
  const { view, sent } = harness();
  view.beginWhisper('bob');
  view.input.value = '   ';
  view.submit();
  assert.equal(sent.length, 0, 'a blank body must never be sent');
  assert.equal(view.input.placeholder, '地图聊天', 'the input returns to the map channel');
  view.destroy();
}

// w04 — an incoming whisper is rendered from the authoritative envelope only,
// and it is labelled as an incoming one.
{
  const { view } = harness('alice');
  view.appendWhisperMessage({
    messageId: 'whisper-bob-1',
    fromId: 'bob',
    fromName: 'bob',
    toId: 'alice',
    toName: 'alice',
    text: '晚上一起打怪吗',
    occurredAtTick: 12,
  });
  assert.equal(lines(view).length, 1);
  const text = labels(lines(view)[0]).join('');
  // The tag is the source's own word for the button (ToolTip = 悄悄話).
  assert.match(text, /悄悄話/, 'a whisper is tagged as a whisper');
  assert.match(text, /bob/, 'the sender is the authoritative fromName');
  assert.match(text, /晚上一起打怪吗/);
  assert.ok(!text.includes('致'), 'an incoming line is not labelled as outgoing');
  view.destroy();
}

// w05 — the sender's own echo upgrades its pending line instead of adding a
// second one, and it is labelled with the recipient.
{
  const { view, sent } = harness('alice');
  view.beginWhisper('bob');
  view.input.value = '在吗';
  view.submit();
  const requestId = sent[0].requestId;
  assert.equal(lines(view).length, 1, 'a pending line shows while sending');
  assert.match(labels(lines(view)[0]).join(''), /发送中/);

  view.appendWhisperMessage({
    messageId: 'whisper-alice-1',
    requestId,
    fromId: 'alice',
    fromName: 'alice',
    toId: 'bob',
    toName: 'bob',
    text: '在吗',
    occurredAtTick: 12,
  });
  assert.equal(lines(view).length, 1, 'the echo must merge, not duplicate');
  const text = labels(lines(view)[0]).join('');
  assert.match(text, /致 bob/, 'an outgoing line names the recipient');
  assert.ok(!text.includes('发送中'), 'the pending marker is gone');
  view.destroy();
}

// w06 — a replayed echo (server re-sending the same request id) still merges
// into the same line rather than appending a duplicate.
{
  const { view, sent } = harness('alice');
  view.beginWhisper('bob');
  view.input.value = '在吗';
  view.submit();
  const requestId = sent[0].requestId;
  const envelope = {
    messageId: `whisper-alice-replay-${requestId}`,
    requestId,
    replay: true,
    fromId: 'alice',
    fromName: 'alice',
    toId: 'bob',
    toName: 'bob',
    text: '在吗',
    occurredAtTick: 13,
  };
  view.appendWhisperMessage(envelope);
  view.appendWhisperMessage(envelope);
  assert.equal(lines(view).length, 1, 'a replayed echo must not add a line');
  view.destroy();
}

// w07 — a rejected whisper restores the draft and keeps the target, so the
// player corrects the line instead of retyping the conversation.
{
  const { view, sent } = harness('alice');
  view.beginWhisper('bob');
  view.input.value = '在吗';
  view.submit();
  const requestId = sent[0].requestId;
  view.failPending(requestId, '对方已把你加入黑名单。');
  assert.equal(view.input.value, '在吗', 'the draft comes back');
  assert.equal(view.input.placeholder, '悄悄話 → bob', 'still addressed to the same target');
  view.destroy();
}

// w08 — leaving the world drops a half-typed whisper: a stale target must not
// be pre-filled into the next session's map chat.
{
  const { view, sent } = harness('alice');
  view.beginWhisper('bob');
  view.input.value = '在吗';
  view.submit();
  view.clear();
  assert.equal(view.input.placeholder, '地图聊天');
  assert.equal(view.input.value, '');
  sent.length = 0;
  // `clear()` also marks the surface unavailable (it runs on disconnect), so a
  // fresh session has to make it available again before it can send.
  view.setAvailable(true);
  view.input.value = '大家好';
  view.submit();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'chatSend', 'after clear the input is map chat again');
  view.destroy();
}

// w09 — without a whisper hook nothing is sent and nothing is lost: the view
// reports instead of silently dropping the line into map chat.
{
  const { view, sent, statuses } = harness('alice', false);
  view.beginWhisper('bob');
  view.input.value = '在吗';
  view.submit();
  assert.equal(sent.length, 0);
  assert.ok(statuses.some(message => message.includes('密语未发送')), 'the failure is reported');
  view.destroy();
}

console.log('chat whisper check: 9 scenarios passed');
