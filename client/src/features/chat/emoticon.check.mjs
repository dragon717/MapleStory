import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Same pattern as the other client checks: transpile the module, replace the
// imports node cannot resolve, and drive the view through a minimal DOM stub.
//
// The server owns every emoticon decision (does the id exist, is the send
// budget exhausted, who in the map room sees it), so what is worth verifying
// here is the *presentation* contract: that every control lands on the
// coordinate the TMS273 export recorded, that the strip and the grid page the
// way the authored art says they do, and that picking a sticker sends exactly
// one intent carrying nothing but the catalogue id.
const source = (await readFile(new URL('./emoticon-view.ts', import.meta.url), 'utf8')).replace(
  /^import \{ protocolText, uiLocale \} from '\.\.\/\.\.\/app\/i18n';$/m,
  "const uiLocale = () => 'zh';\n" +
  "const protocolText = (code, fallback) => code + ': ' + fallback;",
)
  // 资源地址解析（v3 §3.1）：离线圈定下用恒等桩（与 dialogue.check.mjs 同一约定）。
  // 必须在剥 import 之前替换，否则剥完就没有任何定义。
  .replace(
    /^import \{ resolveAssetUrl \} from '\.\.\/\.\.\/assets\/resource-url';$/m,
    'const resolveAssetUrl = url => url;',
  );
const outputText = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/^import .*;\r?\n/gm, '');
const { EmoticonView } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

// --- a DOM stub just large enough for the window ---------------------------
function makeElement(tag) {
  const element = {
    tagName: tag, className: '', textContent: '', title: '', type: '', disabled: false,
    children: [], attributes: {}, style: { setProperty() {} }, removed: false,
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } },
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); },
    remove() {
      this.removed = true;
      // Detach like the real thing: the window is rebuilt on reopen, and a stub
      // that left the old node in `children` would make `children[0]` the corpse.
      if (this.parent) {
        this.parent.children = this.parent.children.filter(child => child !== this);
        this.parent = undefined;
      }
    },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name]; },
    addEventListener() {},
    removeEventListener() {},
  };
  element.classList = {
    add: name => { if (!element.className.split(' ').includes(name)) element.className = `${element.className} ${name}`.trim(); },
    contains: name => element.className.split(' ').includes(name),
    toggle: (name, force) => { const on = force ?? !element.classList.contains(name); if (on) element.classList.add(name); else element.className = element.className.split(' ').filter(part => part !== name).join(' '); return on; },
  };
  return element;
}
// The window binds its keyboard handler on `window`, so the stub records them
// and `press` replays one, which is how the arrow-key sheet switch is driven.
const keyHandlers = [];
globalThis.document = { createElement: makeElement };
globalThis.window = {
  addEventListener: (type, handler) => { if (type === 'keydown') keyHandlers.push(handler); },
  removeEventListener() {},
};
const press = key => {
  for (const handler of keyHandlers) handler({ key, repeat: false, preventDefault() {}, stopImmediatePropagation() {} });
};

const findByClass = (node, className) => {
  const out = [];
  const walk = value => {
    if (value.className?.split(' ').includes(className)) out.push(value);
    for (const child of value.children ?? []) walk(child);
  };
  walk(node);
  return out;
};

// --- a miniature catalogue in the exported shape ---------------------------
const frame = (url, delay = 100) => ({ url, width: 32, height: 32, origin: { x: 16, y: 16 }, x: -16, y: -16, delay });
const layout = {
  columns: 3, rows: 3, slotCount: 9,
  slotOffset: { x: 23, y: 115 }, slotSpace: { x: 109, y: 102 }, slotSize: { width: 101, height: 97 },
  emoticon: { x: 50, y: 38 }, pageOffset: { x: 169, y: 83 }, pageIconSpace: 11,
  groupOffset: { x: 113, y: 46 }, groupSpace: { x: 41, y: 0 }, groupCount: 5,
  name: { offset: { x: 11, y: 76 }, width: 79, font: 'MD摩利斯9', size: 12, color: 'FFFFFFFF', bold: false },
};
const ui = {
  backgrnd: { url: 'bg', width: 370, height: 530, origin: { x: 0, y: 0 }, x: 0, y: 0, delay: 100 },
  slotBase: { url: 'slot', width: 101, height: 97, origin: { x: 0, y: 0 }, x: 0, y: 0, delay: 100 },
  'layer:emptySlot': { url: 'empty', width: 321, height: 302, origin: { x: -22, y: -115 }, x: 22, y: 115, delay: 100 },
  groupBase: { url: 'gbase', width: 32, height: 32, origin: { x: 0, y: 0 }, x: 0, y: 0, delay: 100 },
  groupSelect: { url: 'gsel', width: 48, height: 48, origin: { x: 8, y: 8 }, x: -8, y: -8, delay: 100 },
  'pageIcon/on': { url: 'dotOn', width: 9, height: 9, origin: { x: 0, y: 0 }, x: 0, y: 0, delay: 100 },
  'pageIcon/off': { url: 'dotOff', width: 9, height: 9, origin: { x: 0, y: 0 }, x: 0, y: 0, delay: 100 },
  'button:close/normal': { url: 'close', width: 11, height: 11, origin: { x: -346, y: -12 }, x: 346, y: 12, delay: 100 },
  'button:pageUp/normal': { url: 'up', width: 21, height: 26, origin: { x: -80, y: -50 }, x: 80, y: 50, delay: 100 },
  'button:pageUp/mouseOver': { url: 'upH', width: 21, height: 26, origin: { x: -80, y: -50 }, x: 80, y: 50, delay: 100 },
  'button:pageUp/pressed': { url: 'upP', width: 21, height: 26, origin: { x: -80, y: -50 }, x: 80, y: 50, delay: 100 },
  'button:pageDown/normal': { url: 'down', width: 21, height: 26, origin: { x: -321, y: -50 }, x: 321, y: 50, delay: 100 },
  'button:pageDown/mouseOver': { url: 'downH', width: 21, height: 26, origin: { x: -321, y: -50 }, x: 321, y: 50, delay: 100 },
  'button:pageDown/pressed': { url: 'downP', width: 21, height: 26, origin: { x: -321, y: -50 }, x: 321, y: 50, delay: 100 },
};
// The dots must stay clear of the authored `pageDown` button, which is what
// caps the strip; the export records this as `dotCapacity` and the view obeys it.
const dotCapacity = Math.floor((ui['button:pageDown/normal'].x - layout.pageOffset.x - ui['pageIcon/on'].width) / layout.pageIconSpace) + 1;
assert.equal(dotCapacity, 14, 'the stub geometry should leave room for 14 dots');

// Seven groups, one of them wider than the 3x3 grid, so the strip needs two
// pages (7 groups / 5 chips) and the grid needs a second sheet only for that
// group — the two paging axes the shipped catalogue actually has.
const sizes = [4, 3, 2, 10, 6, 5, 2];
const groups = [];
const stickers = [];
sizes.forEach((size, index) => {
  const id = String(1000 + index);
  groups.push({
    id, name: `組${index}`, icon: frame(`group${index}`),
    stickerCount: size, firstSticker: stickers.length, sheetCount: Math.ceil(size / layout.slotCount),
  });
  for (let n = 0; n < size; n++) {
    const ordinal = stickers.length;
    stickers.push({
      id: `${id}:${10000000 + ordinal}`, groupId: id, sourceName: String(10000000 + ordinal),
      name: `表情${ordinal}`, icon: frame(`icon${ordinal}`), frames: [frame(`effect${ordinal}`, 100)], durationMs: 100,
    });
  }
});
assert.equal(stickers.length, 32, 'the stub catalogue should hold 32 stickers');

const emoticon = {
  contentVersion: 'tms273-emoticon', source: 'test',
  limit: { count: 4, timeMs: 5000, source: 'UI/ChatEmoticon.img/ChatLimit' },
  pageCount: Math.ceil(groups.length / layout.groupCount),
  sheetCount: groups.reduce((total, group) => total + group.sheetCount, 0),
  dotCapacity,
  groups, stickers, layout, ui,
};
assert.equal(emoticon.pageCount, 2);
assert.equal(emoticon.sheetCount, 8);

const host = makeElement('div');
const sent = [];
const statuses = [];
const view = new EmoticonView(host, { emoticon }, (message, error) => statuses.push([message, error]), message => { sent.push(message); return true; });

// --- closed until asked ----------------------------------------------------
assert.equal(view.isOpen(), false);
view.open();
assert.equal(view.isOpen(), true);
const root = host.children[0];
const closeButton = () => findByClass(root, 'emoticon-button-close')[0];
const pageDown = () => findByClass(root, 'emoticon-button-pageDown')[0];
const pageUp = () => findByClass(root, 'emoticon-button-pageUp')[0];
const slots = () => findByClass(root, 'emoticon-slot');
const chips = () => findByClass(root, 'emoticon-group');
const dots = () => findByClass(root, 'emoticon-dot');
const caption = () => findByClass(root, 'emoticon-caption')[0];
const names = () => slots().filter(cell => !cell.classList.contains('is-empty')).map(cell => findByClass(cell, 'emoticon-slot-name')[0].textContent);

// --- authored geometry ------------------------------------------------------
assert.equal(closeButton().style.left, '346px', 'the close button sits where the canvas origin puts it');
assert.equal(closeButton().style.top, '12px');
assert.equal(pageUp().style.left, '80px');
assert.equal(pageDown().style.left, '321px');
assert.equal(findByClass(root, 'emoticon-backgrnd').length, 1, 'the shell is the authored backgrnd');

// --- the grid is the exported 3x3 walk --------------------------------------
assert.equal(slots().length, 9, 'the window shows exactly slotCount cells');
const slot0 = slots()[0], slot8 = slots()[8];
assert.equal(slot0.style.left, '23px');
assert.equal(slot0.style.top, '115px');
assert.equal(slot8.style.left, `${23 + 2 * 109}px`, 'cell 9 is the last column of the third row');
assert.equal(slot8.style.top, `${115 + 2 * 102}px`);
assert.equal(findByClass(slot0, 'emoticon-slot-plate').length, 1);
assert.equal(findByClass(slot0, 'emoticon-slot-icon')[0].style.left, `${50 - 16}px`, 'the icon centres on the authored point');
assert.equal(findByClass(root, 'emoticon-slot-name')[0].textContent, '表情0');

// --- the grid is scoped to one group, so a short group leaves cells empty ---
assert.equal(slots().filter(cell => cell.classList.contains('is-empty')).length, 5, 'group 0 holds 4 of the 9 cells');
assert.equal(slots().filter(cell => cell.classList.contains('is-empty'))[0].disabled, true);
assert.deepEqual(names(), ['表情0', '表情1', '表情2', '表情3'], 'only that group is on screen');

// --- the strip is the authored five-chip page that holds the selection ------
assert.equal(chips().length, 5, 'the strip carries groupCount chips');
assert.equal(chips()[0].style.left, '113px');
assert.equal(chips()[1].style.left, `${113 + 41}px`);
assert.deepEqual(chips().map(chip => chip.title), ['組0', '組1', '組2', '組3', '組4']);
assert.equal(chips()[0].classList.contains('is-active'), true, 'the selected group is marked');
assert.equal(findByClass(chips()[0], 'emoticon-group-select').length, 1, 'the active chip wears the authored ring');
assert.equal(chips()[0].getAttribute('aria-pressed'), 'true');

// --- the authored nav buttons page the strip and clamp ----------------------
assert.equal(pageUp().disabled, true, 'the first strip page cannot go up');
assert.equal(pageDown().disabled, false);
pageDown().onclick();
assert.deepEqual(chips().map(chip => chip.title), ['組5', '組6'], 'the second page carries the groups that are left');
assert.deepEqual(names(), ['表情25', '表情26', '表情27', '表情28', '表情29'], 'paging the strip lands on the first group of the page');
assert.equal(pageDown().disabled, true, 'the last strip page cannot go down');
pageUp().onclick();
assert.deepEqual(names(), ['表情0', '表情1', '表情2', '表情3'], 'paging back lands on the first group of the first page');
assert.equal(pageUp().disabled, true, 'the strip clamps at the first page');

// --- a group chip selects that group, and the strip follows it --------------
const chipFor = title => chips().find(chip => chip.title === title);
chipFor('組3').onclick();
assert.equal(chips().find(chip => chip.classList.contains('is-active')).title, '組3');
assert.equal(names().length, 9, 'the wide group fills the grid');
assert.equal(findByClass(root, 'emoticon-slot-name')[0].textContent, '表情9', 'the chip jumped to that group');
assert.equal(caption().textContent, '第 1/2 頁 · ↑↓ 切換', 'a group wider than the grid says how to reach the rest');

// --- the second sheet of an overflowing group is reachable ------------------
press('ArrowDown');
assert.equal(findByClass(root, 'emoticon-slot-name')[0].textContent, '表情18');
assert.equal(slots().filter(cell => cell.classList.contains('is-empty')).length, 8, 'the second sheet holds one sticker');
assert.equal(caption().textContent, '第 2/2 頁 · ↑↓ 切換');
press('ArrowDown');
assert.equal(findByClass(root, 'emoticon-slot-name')[0].textContent, '表情18', 'the sheet clamps at the last one');
press('ArrowUp');
press('ArrowUp');
assert.equal(findByClass(root, 'emoticon-slot-name')[0].textContent, '表情9', 'and at the first one');

// --- every sticker of the catalogue is reachable exactly once ---------------
{
  const reached = new Set();
  for (let index = 0; index < groups.length; index++) {
    let found = false;
    for (let attempt = 0; attempt < 8 && !found; attempt++) {
      const chip = chipFor(`組${index}`);
      if (chip) { chip.onclick(); found = true; break; }
      pageDown().onclick();
    }
    assert.equal(found, true, `group ${index} cannot be reached from the strip`);
    // Walk the group's sheets, then stop: the sheet clamps, so extra presses are
    // harmless and the set keeps the sweep honest.
    for (let sheet = 0; sheet < 3; sheet++) {
      for (const name of names()) reached.add(name);
      press('ArrowDown');
    }
  }
  assert.equal(reached.size, stickers.length, 'every catalogue sticker is reachable from the window');
}

// --- the dots are one per strip page and jump to that page ------------------
// The sweep above left the strip on its last page, so walk back first.
for (let attempt = 0; attempt < 8 && !chipFor('組0'); attempt++) pageUp().onclick();
chipFor('組0').onclick();
assert.equal(dots().length, 2, 'one dot per strip page');
assert.equal(dots()[0].style.left, '169px');
assert.equal(dots()[1].style.left, `${169 + 11}px`);
assert.equal(dots().filter(dot => dot.getAttribute('aria-current') === 'true').length, 1, 'exactly one dot marks the current page');
assert.equal(findByClass(dots()[0], 'emoticon-dot-icon')[0].src, 'dotOn');
assert.equal(findByClass(dots()[1], 'emoticon-dot-icon')[0].src, 'dotOff');
dots()[0].onclick();
assert.deepEqual(names(), ['表情0', '表情1', '表情2', '表情3'], 'a dot jumps to its strip page');

// --- picking sends one intent and nothing else -----------------------------
const firstCell = slots()[0];
firstCell.onclick();
assert.equal(sent.length, 1);
assert.equal(sent[0].type, 'emoticonSend');
assert.equal(sent[0].emoticonId, '1000:10000000', 'only the catalogue id travels up');
assert.equal(Object.keys(sent[0]).sort().join(','), 'emoticonId,requestId,type', 'no author, room or timestamp is claimed');
assert.equal(caption().textContent, '表情0');
slots()[1].onclick();
assert.notEqual(sent[1].requestId, sent[0].requestId, 'every pick carries a fresh request id');

// --- a refusal is shown where the player is looking ------------------------
sent.length = 0;
view.receiveRejection('emoticon_rate_limited', '表情发送太快，请稍后再试。');
assert.equal(caption().textContent, 'emoticon_rate_limited: 表情发送太快，请稍后再试。');
assert.equal(caption().classList.contains('is-error'), true);
assert.equal(sent.length, 0, 'a refusal never re-sends');

// --- closing and reopening resets to the first group ------------------------
closeButton().onclick();
assert.equal(view.isOpen(), false);
assert.equal(root.removed, true);
view.open();
assert.equal(findByClass(host.children[0], 'emoticon-caption')[0].textContent, '點選一個表情即可發送。');
assert.deepEqual(names(), ['表情0', '表情1', '表情2', '表情3'], 'the window reopens on the first group');

// --- a catalogue longer than the authored dot strip slides its dots --------
{
  const wide = Array.from({ length: 80 }, (_, index) => ({
    id: String(2000 + index), name: `長組${index}`, icon: frame(`wgroup${index}`),
    stickerCount: 1, firstSticker: index, sheetCount: 1,
  }));
  const wideStickers = wide.map((group, index) => ({
    id: `${group.id}:${20000000 + index}`, groupId: group.id, sourceName: String(20000000 + index),
    name: `長表情${index}`, icon: frame(`wicon${index}`), frames: [frame(`weffect${index}`, 100)], durationMs: 100,
  }));
  const wideHost = makeElement('div');
  const wideView = new EmoticonView(wideHost, {
    emoticon: { ...emoticon, pageCount: Math.ceil(wide.length / layout.groupCount), sheetCount: wide.length, groups: wide, stickers: wideStickers },
  });
  wideView.open();
  const wideRoot = wideHost.children[0];
  const wideDots = () => findByClass(wideRoot, 'emoticon-dot');
  assert.equal(wideDots().length, dotCapacity, 'the dot strip never exceeds what the authored spacing fits');
  assert.equal(findByClass(wideRoot, 'emoticon-button-pageDown')[0].disabled, false);
  for (let step = 0; step < 8; step++) findByClass(wideRoot, 'emoticon-button-pageDown')[0].onclick();
  const current = wideDots().filter(dot => dot.getAttribute('aria-current') === 'true');
  assert.equal(current.length, 1, 'still exactly one dot marks the current page');
  // Eight pages in, the dot window starts at `page - floor(shown / 2)` = 1 and
  // the current page therefore sits at index 7 of the fourteen.
  assert.equal(current[0].style.left, `${169 + 7 * 11}px`, 'the dot window slides to keep the current page inside it');
  for (let step = 0; step < 8; step++) findByClass(wideRoot, 'emoticon-button-pageDown')[0].onclick();
  const last = wideDots().filter(dot => dot.getAttribute('aria-current') === 'true')[0];
  // 16 pages of dots in a 14-dot window: at the end the window clamps, so the
  // last page is the last dot instead of the strip running off the shell.
  assert.equal(last.style.left, `${169 + 13 * 11}px`, 'the dot window clamps at the end of the catalogue');
  wideView.destroy();
}

// --- a manifest without the export degrades instead of throwing ------------
{
  const bare = new EmoticonView(makeElement('div'), {}, message => statuses.push([message, true]));
  bare.open();
  assert.equal(bare.isOpen(), false, 'no export means the window never opens');
  assert.equal(statuses.at(-1)[1], true);
}

console.log('emoticon.check.mjs: 12 scenarios passed');
