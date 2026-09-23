import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Same pattern as the other view checks: transpile the module, drop its
// imports (i18n reads `window` at load; window-shell needs a real host) and
// drive the class through a minimal DOM stub.  This check pins the repaired
// presentation contract: the MaxMap corner plate carries the source's
// markMark badge and the source's black "MINI MAP" title card is NOT painted,
// BtNpc opens the authored NPC 目录, a picked row marks that NPC with the navi
// chevron, the strip restore button returns to the mode collapsed from, the zh
// tooltips are the source's own strings, and — the regression this round — the
// controls survive a snapshot stream instead of being rebuilt under the
// pointer.
const source = await readFile(new URL('./minimap-view.ts', import.meta.url), 'utf8');
const outputText = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
  // 资源地址解析（v3 §3.1）：离线圈定下用恒等桩（与 dialogue.check.mjs 同一约定）。
  // 必须在剥 import 之前替换，否则剥完就没有任何定义。
  .replace(/import \{[^}]*\} from '\.\.\/\.\.\/assets\/resource-url';/, 'const resolveAssetUrl = url => url;')
  .replace(/^import .*;\r?\n/gm, '');

// --- DOM stub ---------------------------------------------------------------

function makeElement(tag) {
  const element = {
    tagName: tag,
    children: [],
    parentElement: null,
    className: '',
    dataset: {},
    title: '',
    type: '',
    alt: '',
    draggable: false,
    width: 0,
    height: 0,
    src: null,
    textContent: '',
    style: {
      _props: {},
      setProperty(name, value) { this._props[name] = value; },
      getPropertyValue(name) { return this._props[name] ?? ''; },
    },
    _attributes: new Map(),
    _listeners: new Map(),
    setAttribute(name, value) { this._attributes.set(name, String(value)); },
    getAttribute(name) { return this._attributes.has(name) ? this._attributes.get(name) : null; },
    removeAttribute(name) { this._attributes.delete(name); },
    classList: {
      _set: new Set(),
      add(...names) { for (const name of names) this._set.add(name); },
      remove(...names) { for (const name of names) this._set.delete(name); },
      toggle(name, force) {
        const next = force === undefined ? !this._set.has(name) : Boolean(force);
        if (next) this._set.add(name); else this._set.delete(name);
        return next;
      },
      contains(name) { return this._set.has(name); },
    },
    append(...nodes) {
      for (const node of nodes) {
        node.parentElement = element;
        element.children.push(node);
      }
    },
    replaceChildren(...nodes) {
      for (const child of element.children) child.parentElement = null;
      element.children = [];
      element.append(...nodes);
    },
    remove() {
      if (element.parentElement) {
        const siblings = element.parentElement.children;
        const index = siblings.indexOf(element);
        if (index >= 0) siblings.splice(index, 1);
      }
      element.parentElement = null;
    },
    addEventListener(name, handler) {
      if (!element._listeners.has(name)) element._listeners.set(name, []);
      element._listeners.get(name).push(handler);
    },
    removeEventListener(name, handler) {
      const list = element._listeners.get(name) ?? [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    dispatch(name, event) {
      for (const handler of element._listeners.get(name) ?? []) handler(event);
    },
  };
  return element;
}

const documentStub = {
  createElement: tag => makeElement(tag),
  _keyHandlers: [],
  addEventListener(name, handler) {
    if (name === 'keydown') documentStub._keyHandlers.push(handler);
  },
  removeEventListener(name, handler) {
    const index = documentStub._keyHandlers.indexOf(handler);
    if (index >= 0) documentStub._keyHandlers.splice(index, 1);
  },
  dispatchKey(event) {
    for (const handler of [...documentStub._keyHandlers]) handler(event);
  },
};

const windowStub = {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};

globalThis.document = documentStub;
globalThis.window = windowStub;
globalThis.uiLocale = () => 'zh';
globalThis.uiText = key => ({
  minimapNpc: 'NPC 目录',
  minimapNpcListClose: '关闭 NPC 目录',
  minimapNpcListEmpty: '这张地图上没有 NPC。',
  minimapShow: '展开小地图',
  minimapHide: '收起小地图',
  minimapCompact: '切换为精简小地图',
  minimapFull: '切换为完整小地图',
  minimapWorld: '世界地图',
  minimapSelf: '你的位置',
}[key] ?? key);
globalThis.mapText = (_mapId, text) => text;
globalThis.installWindowDrag = () => () => {};

const { MiniMapView, miniMapArrow, miniMapPixel, miniMapContains, miniMapBox } =
  await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

// --- pure helpers -----------------------------------------------------------

{
  const map = {
    width: 200, height: 100,
    world: { xMin: 0, yMin: 0, width: 1000, height: 500 },
  };
  assert.deepEqual(miniMapPixel(map, 500, 250), { x: 100, y: 50 });
  assert.equal(miniMapContains(map, 999, 499), true);
  assert.equal(miniMapContains(map, 1000, 500), true);
  assert.equal(miniMapContains(map, 1001, 0), false);
  // Facing wins on the ground; airborne bodies take the vertical diagonal.
  assert.equal(miniMapArrow({ facing: 1, grounded: true, vy: 0, action: 'stand' }), 'e');
  assert.equal(miniMapArrow({ facing: -1, grounded: true, vy: 0, action: 'walk' }), 'w');
  assert.equal(miniMapArrow({ facing: 1, grounded: false, vy: -2, action: 'jump' }), 'ne');
  assert.equal(miniMapArrow({ facing: 1, grounded: false, vy: 2, action: 'jump' }), 'se');
  assert.equal(miniMapArrow({ facing: -1, grounded: true, vy: -2, action: 'ladder' }), 'n');
  // The box fits the interior and keeps the authored minimum width.
  const box = miniMapBox({ width: 1000, height: 500 }, 185);
  assert.equal(box.fit < 1, true);
  assert.equal(box.width >= 185, true);
  const narrow = miniMapBox({ width: 50, height: 20 }, 185);
  assert.equal(narrow.fit, 1);
  assert.equal(narrow.width, 185);
}

// --- fixture manifest -------------------------------------------------------

const frameOf = (url, width = 10, height = 10) => ({ url, width, height, origin: { x: 0, y: 0 }, x: 0, y: 0, delay: 100 });
const manifest = {
  mapCatalog: { maps: [{ id: '100000000', streetName: '弓箭手村', name: '弓箭手村射箭场' }] },
  map: { id: '100000000', name: '弓箭手村射箭场' },
  miniMap: {
    contentVersion: 'check',
    maps: {
      100000000: {
        mapId: '100000000', url: 'map.png', width: 100, height: 50,
        world: { xMin: 0, yMin: 0, width: 1000, height: 500 },
        centerX: 0, centerY: 0, mag: 4, mark: 'Henesys',
      },
    },
    missing: [],
    ui: {
      'MaxMap/nw': frameOf('nw.png', 44, 76),
      'MaxMap/ne': frameOf('ne.png', 15, 76),
      'MaxMap/n': frameOf('n.png', 1, 70),
      'MaxMap/w': frameOf('w.png', 9, 1),
      'MaxMap/e': frameOf('e.png', 9, 1),
      'MaxMap/sw': frameOf('sw.png', 15, 16),
      'MaxMap/s': frameOf('s.png', 1, 10),
      'MaxMap/se': frameOf('se.png', 15, 16),
      'MaxMap/c': frameOf('c.png', 1, 1),
      'MinMap/nw': frameOf('mnw.png', 15, 36),
      'MinMap/ne': frameOf('mne.png', 15, 36),
      'MinMap/n': frameOf('mn.png', 1, 30),
      'MinMap/w': frameOf('mw.png', 9, 1),
      'MinMap/e': frameOf('me.png', 9, 1),
      'MinMap/sw': frameOf('msw.png', 15, 16),
      'MinMap/s': frameOf('ms.png', 1, 10),
      'MinMap/se': frameOf('mse.png', 15, 16),
      'MinMap/c': frameOf('mc.png', 1, 1),
      'Min/w': frameOf('stw.png', 10, 30),
      'Min/c': frameOf('stc.png', 1, 30),
      'Min/e': frameOf('ste.png', 10, 30),
      'BtMap/normal': frameOf('btmap.png', 21, 21),
      'BtNpc/normal': frameOf('btnpc.png', 21, 21),
      'button:min/normal': frameOf('min.png', 21, 21),
      'button:max/normal': frameOf('max.png', 21, 21),
      'button:small/normal': frameOf('small.png', 21, 21),
      'button:big/normal': frameOf('big.png', 21, 21),
      'npcList/backgrnd': frameOf('list.png', 184, 286),
      'npcList/button:close/normal': frameOf('close.png', 11, 11),
    },
    icons: {
      npc: frameOf('npc-icon.png', 7, 10),
      portal: frameOf('portal-icon.png', 13, 15),
      navi: frameOf('navi.png', 18, 21),
      direction: { e: frameOf('dir-e.png', 17, 17) },
      marks: { Henesys: frameOf('mark-henesys.png', 38, 38) },
      npcList: { npc: frameOf('row-npc.png', 7, 10) },
    },
    layout: {
      minWidth: 185, buttonInterval: 21,
      docks: { left: { x: 5, y: 5 }, right: { x: -26, y: 5 } },
      mapName: { x: 50, y: 48 },
      streetName: { x: 50, y: 30 },
      mapMark: { x: 6, y: 28 },
      minStreetName: { x: 52, y: 7 },
      minInterval: 5,
      fonts: { mapName: { family: 'f', size: 12, color: '#FFFFFF', alpha: 1 }, streetName: { family: 'f', size: 12, color: '#D4E1E5', alpha: 1 } },
      npcList: { namePos: { x: 30, y: 4 }, rowHeight: 18, listLT: { x: 11, y: 59 }, listRB: { x: 165, y: 275 } },
    },
    tooltips: { BtMap: '點擊開啟世界地圖。', BtNpc: '點擊可察看目前所在地區的NPC目錄。' },
  },
};

function findIn(root, className) {
  const visit = node => {
    if (!node || typeof node !== 'object') return null;
    if (node.className === className) return node;
    for (const child of node.children ?? []) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  return visit(root);
}

function buttonsOf(view) {
  return [
    ...view.buttonsLeft.children,
    ...view.buttonsRight.children,
  ];
}

// --- view behaviour ---------------------------------------------------------

const host = makeElement('div');
const view = new MiniMapView(host, manifest);
view.mount();
const root = view.root;
assert.ok(root, 'mount builds the root');

const input = {
  mapId: '100000000',
  self: { id: 'p1', username: '木鸟', x: 500, y: 250, facing: 1, grounded: true, vy: 0, action: 'stand' },
  players: [],
  npcs: [{ id: 'n1', name: 'Head Patrol Officer', nameZh: '巡查队长', x: 300, y: 100 }],
  portals: [],
  partyIds: [],
};
view.update(input);

// 1. The corner plate carries the source badge at the authored vector; the
// source's black "MINI MAP" title card is not painted at all.
{
  const mark = findIn(root, 'tms-minimap-mark');
  assert.ok(mark, 'mark icon element exists');
  assert.equal(mark.style.display, 'block');
  assert.equal(mark.src, 'mark-henesys.png');
  assert.equal(mark.style.left, '6px');
  assert.equal(mark.style.top, '28px');
  // `MaxMap/nw2` is authored in the source but the delivered window drops it:
  // the view must not hand the stylesheet a card layer to paint.
  assert.equal(root.style.getPropertyValue('--minimap-nw2'), '', 'the MINI MAP title card is not painted');
  assert.equal(root.style.getPropertyValue('--minimap-nw2-x'), '', 'no title-card anchor is emitted');
  // A map whose source authors `None` draws nothing.
  manifest.miniMap.maps['100000000'].mark = 'None';
  view.update(input);
  assert.equal(mark.style.display, 'none');
  manifest.miniMap.maps['000000000'] = { ...manifest.miniMap.maps['100000000'], mapId: '000000000', mark: 'None' };
  view.update({ ...input, mapId: '000000000' });
  assert.equal(findIn(root, 'tms-minimap-mark').style.display, 'none', 'a None map draws no badge');
  view.update(input);
  manifest.miniMap.maps['100000000'].mark = 'Henesys';
  view.update(input);
  assert.equal(mark.style.display, 'block');
}

// 2. Names: street from the catalog, map from the catalog entry.
assert.equal(findIn(root, 'tms-minimap-street').textContent, '弓箭手村');
assert.equal(findIn(root, 'tms-minimap-name').textContent, '弓箭手村射箭场');

// 3. BtNpc opens the authored NPC 目录; the zh tooltip is the source string.
{
  const btNpc = buttonsOf(view).find(button => button.title === '點擊可察看目前所在地區的NPC目錄。');
  assert.ok(btNpc, 'BtNpc carries the source tooltip');
  btNpc.dispatch('click', {});
  assert.equal(view.npcListShown(), true);
  const list = findIn(root, 'tms-minimap-list');
  assert.ok(list, 'npc list window built');
  assert.equal(list.style.display, 'block');
  const rows = findIn(root, 'tms-minimap-list-rows');
  const row = rows.children.find(child => child.className === 'tms-minimap-list-row');
  assert.ok(row, 'the map NPC has a row');
  assert.equal(row.children.find(child => child.className === 'tms-minimap-list-name').textContent, '巡查队长');
  assert.equal(row.getAttribute('aria-pressed'), 'false');
  // Picking a row marks that NPC with the navi chevron on the map.  The rows
  // are rebuilt on pick, so re-read the row afterwards.
  row.dispatch('click', {});
  const pickedRow = rows.children.find(child => child.className === 'tms-minimap-list-row');
  assert.equal(pickedRow.getAttribute('aria-pressed'), 'true');
  const markers = findIn(root, 'tms-minimap-markers');
  const navi = markers.children.find(child => child.className === 'tms-minimap-marker is-navi');
  assert.ok(navi, 'the picked NPC carries the navi chevron');
  assert.equal(navi.style.marginTop, '-21px');
  // Toggling the row again drops the pick.
  pickedRow.dispatch('click', {});
  assert.equal(view.npcListShown(), true);
  assert.ok(!markers.children.some(child => child.className === 'tms-minimap-marker is-navi'));
  // Escape closes the window.
  documentStub.dispatchKey({ key: 'Escape', code: 'Escape', defaultPrevented: false, repeat: false, preventDefault() {} });
  assert.equal(view.npcListShown(), false);
  assert.equal(list.style.display, 'none');
  // Reopening keeps working and rows are refilled.
  btNpc.dispatch('click', {});
  assert.equal(view.npcListShown(), true);
  const rowsAgain = findIn(root, 'tms-minimap-list-rows');
  assert.ok(rowsAgain.children.some(child => child.className === 'tms-minimap-list-row'));
  btNpc.dispatch('click', {});
  assert.equal(view.npcListShown(), false);
}

// 4. Collapse and restore: `button:max` returns to the mode collapsed from.
{
  const compact = buttonsOf(view).find(button => button.title === '切换为精简小地图');
  compact.dispatch('click', {});
  assert.equal(root.dataset.mode, 'compact');
  const min = buttonsOf(view).find(button => button.title === '收起小地图');
  min.dispatch('click', {});
  assert.equal(root.dataset.mode, 'strip');
  const max = buttonsOf(view).find(button => button.title === '展开小地图');
  max.dispatch('click', {});
  assert.equal(root.dataset.mode, 'compact', 'restore returns to the collapsed-from mode, not always full');
  // Collapsing again from full restores full.
  const small = buttonsOf(view).find(button => button.title === '切换为完整小地图');
  small.dispatch('click', {});
  assert.equal(root.dataset.mode, 'full');
}

// 5. Snapshot churn: the controls must survive a stream of updates.  `paint()`
// runs for every authoritative snapshot and the server ticks at 50 ms, so a
// strip rebuilt per snapshot detaches the element a press started on and the
// click never fires — the bug this scenario pins.
{
  assert.equal(root.dataset.mode, 'full');
  const before = buttonsOf(view);
  assert.equal(before.length, 4, 'the full window carries four authored controls');
  for (let i = 0; i < 40; i++) view.update(input);
  const after = buttonsOf(view);
  assert.equal(after.length, 4, 'still four controls after forty snapshots');
  for (let i = 0; i < 4; i++) {
    assert.equal(after[i], before[i], `control ${i} is the same element after forty snapshots`);
  }
  // A real control-set change still redraws the strip, so the guard above is
  // not vacuously true.
  buttonsOf(view).find(button => button.title === '切换为精简小地图').dispatch('click', {});
  assert.equal(root.dataset.mode, 'compact');
  const compact = buttonsOf(view);
  assert.notEqual(compact[1], before[1], 'a mode change redraws the strip');
  assert.equal(compact.length, 4);
  buttonsOf(view).find(button => button.title === '切换为完整小地图').dispatch('click', {});
  assert.equal(root.dataset.mode, 'full');
}

// 6. A map without a source minimap shows nothing at all — like the original:
// the whole window is hidden, the NPC 目录 and its pick are dropped, and
// stepping back onto a minimap map restores the window.
{
  // Opening the 目录 first proves the unavailable path closes it.
  buttonsOf(view).find(button => button.title === '點擊可察看目前所在地區的NPC目錄。').dispatch('click', {});
  assert.equal(view.npcListShown(), true);
  view.update({ ...input, mapId: '999999999' });
  assert.equal(root.dataset.unavailable, 'true');
  assert.equal(root.style.display, 'none', 'no authored minimap -> the whole window is hidden');
  assert.ok(!view.npcListShown(), 'the hidden window drops the NPC 目录');
  view.update(input);
  assert.equal(root.dataset.unavailable, undefined);
  assert.equal(root.style.display, '', 'a map with a minimap shows the window again');
}

view.destroy();
assert.ok(!host.children.includes(root), 'destroy removes the view');
assert.equal(documentStub._keyHandlers.length, 0, 'the Escape listener is disposed');

console.log('minimap.check.mjs: 6 scenarios passed');
