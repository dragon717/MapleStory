import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Same pattern as the other client checks: transpile the module, drop its
// imports (i18n pulls in browser-only code), and drive the view under node with
// a minimal DOM stub.
//
// The window is a pure view — the page graph, the plate positions and the spot
// that marks the player all come from the exported WZ nodes — so this verifies
// the two things a reader would actually notice if they were wrong:
//   1. the window opens on the region page that holds the current map, because
//      that is the only way `上一頁`/`下一頁` and the "you are here" plate make
//      sense at all;
//   2. a plate whose region this catalog cannot reach stays inert instead of
//      navigating into a page that was never exported.
const source = await readFile(new URL('./worldmap-view.ts', import.meta.url), 'utf8');
const outputText = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
  .replace(/^import .*\r?\n/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

// The module's imports are stripped above, so re-supply the three helpers it
// calls: the locale, the window copy and the map-name lookup.
const helpers = [
  "const installWindowDrag = () => () => {}; const clampIntoHost = () => {}; const bringToFront = () => {};",
  "const uiLocale = () => 'en';",
  'const uiText = key => `ui:${key}`;',
  "const mapText = (text, fallback) => text || fallback || '';",
  '',
].join('\n');

// ---------------------------------------------------------------- DOM stub
class El {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.classList = {
      _set: new Set(),
      add(...names) { names.forEach(name => this._set.add(name)); },
      remove(...names) { names.forEach(name => this._set.delete(name)); },
      toggle(name, on) { if (on) this._set.add(name); else this._set.delete(name); },
      contains(name) { return this._set.has(name); },
    };
    this.hidden = false;
    this.disabled = false;
    this.tabIndex = 0;
    this.title = '';
    this._text = '';
    this._listeners = new Map();
    // The view sets inline styles both by assignment (style.left) and via
    // setProperty (--worldmap-scale), so the stub has to answer both.
    this.style = { setProperty: (name, value) => { this.style[name] = value; } };
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
  focus() { this.focused = true; }
  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }
  removeEventListener(type, handler) {
    const list = this._listeners.get(type) ?? [];
    this._listeners.set(type, list.filter(entry => entry !== handler));
  }
}
class Img extends El {
  constructor() { super('img'); this.src = ''; this.width = 0; this.height = 0; this.draggable = true; this.alt = ''; }
}
class Button extends El {
  constructor() { super('button'); this.type = ''; }
}
const documentListeners = new Map();
globalThis.document = {
  createElement: tag => (tag === 'img' ? new Img() : tag === 'button' ? new Button() : new El(tag)),
  addEventListener(type, handler) {
    if (!documentListeners.has(type)) documentListeners.set(type, []);
    documentListeners.get(type).push(handler);
  },
  removeEventListener(type, handler) {
    documentListeners.set(type, (documentListeners.get(type) ?? []).filter(entry => entry !== handler));
  },
};
const windowListeners = new Map();
globalThis.window = {
  innerWidth: 1280,
  innerHeight: 800,
  addEventListener(type, handler) {
    if (!windowListeners.has(type)) windowListeners.set(type, []);
    windowListeners.get(type).push(handler);
  },
  removeEventListener(type, handler) {
    windowListeners.set(type, (windowListeners.get(type) ?? []).filter(entry => entry !== handler));
  },
};

/** Fire a listener registered on an element (the view attaches click handlers). */
function fire(element, type, event = {}) {
  for (const handler of element._listeners.get(type) ?? []) handler(event);
}
function fireWindow(type, event) {
  for (const handler of windowListeners.get(type) ?? []) handler(event);
}
function fireDocument(type, event) {
  for (const handler of documentListeners.get(type) ?? []) handler(event);
}

const moduleText = helpers + outputText;
const { WorldMapView } = await import(`data:text/javascript;base64,${Buffer.from(moduleText).toString('base64')}`);

// ---------------------------------------------------------------- fixtures
const frame = (url, width = 20, height = 20, ox = 0, oy = 0) => ({
  url, width, height, origin: { x: ox, y: oy }, x: -ox, y: -oy, delay: 100,
});
const states = name => ({
  normal: frame(`${name}-normal.png`),
  mouseOver: frame(`${name}-over.png`, 22, 22),
  pressed: frame(`${name}-press.png`),
  disabled: frame(`${name}-off.png`),
});
const spot = (x, y, mapIds) => ({ spot: { x, y }, type: 0, mapIds });
const link = (toolTip, page) => ({ toolTip, page, image: frame(`${toolTip}.png`, 60, 30, 10, 10) });
const page = (name, parent, mapList, mapLinks) => ({
  page: name, parent, name, baseImg: frame(`${name}.png`, 640, 470, 320, 235), mapList, mapLinks,
});

// The shape of the real export: the root groups whole continents, the region
// pages list the maps one by one, and a region this catalog cannot reach is
// still authored as a plate (冰原雪域山脈 here).
const manifest = {
  worldMap: {
    contentVersion: 'tms273-worldmap',
    source: 'test',
    root: 'WorldMap',
    pages: {
      WorldMap: page('WorldMap', null,
        [spot(10, 20, ['000010000', '100000000'])],
        [link('楓之島', 'WorldMap000'), link('維多利亞島', 'WorldMap010'), link('冰原雪域山脈', 'WorldMap020')]),
      WorldMap000: page('WorldMap000', 'WorldMap', [spot(5, 6, ['000010000', '001020000'])], []),
      WorldMap010: page('WorldMap010', 'WorldMap', [spot(7, 8, ['100000000'])], []),
    },
    ui: {
      border: frame('border.png', 654, 537),
      plate: frame('plate.png', 15, 15, 7, 7),
      close: states('close'),
      nav: { before: states('before'), next: states('next'), all: states('all') },
    },
  },
};

function harness(data = manifest) {
  const host = new El('div');
  const status = [];
  const view = new WorldMapView(host, data);
  view.onStatus = (message, error) => status.push({ message, error });
  return { host, view, status };
}
const plateOf = view => view.plate;

// ---------------------------------------------------------------- checks
// w01 — opening lands on the region page and marks the player, and the window
// is the only thing that changed.
{
  const { host, view } = harness();
  view.open('000010000');
  assert.equal(view.isOpen(), true, 'the window should report open');
  assert.equal(view.page, 'WorldMap000', 'opens on the deepest page that lists the current map');
  assert.equal(plateOf(view).hidden, false, 'the location plate is shown');
  assert.equal(host.children.length, 1, 'exactly one window node is attached');
  view.destroy();
}

// w02 — a map no exported page authors a spot for opens the world overview
// rather than guessing a region.
{
  const { view } = harness();
  view.open('002010000');
  assert.equal(view.page, 'WorldMap', 'an unlisted map falls back to the overview');
  assert.equal(plateOf(view).hidden, true, 'no plate when no page carries the map');
  view.destroy();
}

// w03 — reopening re-targets to wherever the player is now.
{
  const { view } = harness();
  view.open('000010000');
  assert.equal(view.page, 'WorldMap000');
  view.close();
  view.open('100000000');
  assert.equal(view.page, 'WorldMap010', 'reopening follows the current map, not the last page browsed');
  view.destroy();
}

// w04 — a plate into a region this catalog cannot reach is inert, and the
// reachable ones navigate.
{
  const { view } = harness();
  view.open('002010000'); // overview
  const inert = view.links.find(button => button.title.startsWith('冰原雪域山脈'));
  assert.ok(inert, 'the authored plate is still drawn');
  assert.equal(inert.disabled, true, 'an unexported region must not be clickable');
  assert.equal(inert.dataset.inert, 'true');
  assert.match(inert.title, /ui:worldMapMissing/, 'and it says why');

  const reachable = view.links.find(button => button.title === '楓之島');
  assert.equal(reachable.disabled, false, 'an exported region stays clickable');
  fire(reachable, 'click');
  assert.equal(view.page, 'WorldMap000', 'clicking a plate drills into its page');
  view.destroy();
}

// w05 — 上一頁/下一頁 walk the sibling regions and clamp at the ends, and
// 全部 returns to the overview.
{
  const { view } = harness();
  view.open('000010000'); // WorldMap000, the first of two siblings
  assert.equal(view.beforeButton.element.disabled, true, 'the first region has no previous page');
  assert.equal(view.nextButton.element.disabled, false, 'but it does have a next one');
  assert.equal(view.allButton.element.disabled, false, 'and 全部 can leave the region');
  fire(view.nextButton.element, 'click');
  assert.equal(view.page, 'WorldMap010', '下一頁 steps to the sibling region');
  assert.equal(view.nextButton.element.disabled, true, 'the last region clamps');
  assert.equal(view.beforeButton.element.disabled, false);
  fire(view.allButton.element, 'click');
  assert.equal(view.page, 'WorldMap', '全部 returns to the overview');
  assert.equal(view.allButton.element.disabled, true, 'and is unavailable once there');
  assert.equal(view.beforeButton.element.disabled, true, 'the overview has no siblings');
  assert.equal(view.nextButton.element.disabled, true);
  view.destroy();
}

// w06 — Esc closes, and closing detaches the window.
{
  const { host, view } = harness();
  view.open('000010000');
  fireWindow('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(view.isOpen(), false, 'Esc closes the window');
  assert.equal(host.children[0].hidden, true, 'the window node is hidden');
  assert.equal((windowListeners.get('keydown') ?? []).length, 0, 'the key handler is detached');
  view.destroy();
}

// w07 — a snapshot only moves the plate; it never yanks the player out of the
// page they are browsing.
{
  const { view } = harness();
  view.open('100000000'); // WorldMap010
  assert.equal(plateOf(view).hidden, false);
  view.setMap('000010000');
  assert.equal(view.page, 'WorldMap010', 'a snapshot must not change the open page');
  assert.equal(plateOf(view).hidden, true, 'the plate follows the authoritative map');
  view.setMap('100000000');
  assert.equal(plateOf(view).hidden, false, 'and comes back when the player returns');
  view.destroy();
}

// w08 — a build without the world-map export reports instead of opening a
// blank window.
{
  const { host, view, status } = harness({});
  view.open('000010000');
  assert.equal(view.isOpen(), false, 'no window without source art');
  assert.equal(host.children.length, 0, 'and nothing is attached to the host');
  assert.equal(status.length, 1);
  assert.equal(status[0].error, true);
  assert.equal(status[0].message, 'ui:worldMapNoSource');
  view.destroy();
}

// w09 — the `M` hotkey (source 世界地圖 keybind default) toggles the window,
// skips typing targets, and dies with the view.
{
  const { view } = harness();
  fireDocument('keydown', { code: 'KeyM', preventDefault() {} });
  assert.equal(view.isOpen(), true, 'M opens the world map');
  fireDocument('keydown', { code: 'KeyM', preventDefault() {} });
  assert.equal(view.isOpen(), false, 'M again closes it');
  const typing = { matches: selector => selector.includes('input') };
  fireDocument('keydown', { code: 'KeyM', target: typing, preventDefault() {} });
  assert.equal(view.isOpen(), false, 'M while typing in an input is ignored');
  fireDocument('keydown', { code: 'KeyM', repeat: true, preventDefault() {} });
  assert.equal(view.isOpen(), false, 'auto-repeat does not reopen it');
  fireDocument('keydown', { code: 'KeyM', ctrlKey: true, preventDefault() {} });
  assert.equal(view.isOpen(), false, 'modified M is left to browser shortcuts');
  fireDocument('keydown', { code: 'KeyZ', preventDefault() {} });
  assert.equal(view.isOpen(), false, 'other keys do nothing');
  view.destroy();
  fireDocument('keydown', { code: 'KeyM', preventDefault() {} });
  assert.equal(view.isOpen(), false, 'destroy detaches the hotkey');
  assert.equal((documentListeners.get('keydown') ?? []).length, 0, 'the hotkey handler is released');
}

// w10 — the snapshot-fed map id decides which page M opens onto, so the
// hotkey lands on the region the character stands in without an argument.
{
  const { view } = harness();
  view.setMap('100000000');
  fireDocument('keydown', { code: 'KeyM', preventDefault() {} });
  assert.equal(view.page, 'WorldMap010', 'M opens the region holding the tracked map');
  view.destroy();
}

// w11 — activity routes reuse the same shell and restore the original map on exit.
{
  const config = JSON.parse(await readFile(new URL('../../../../shared/colossus.json', import.meta.url), 'utf8'));
  const source = await readFile(new URL('../colossus/maps.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/^import .*\r?\n/gm, '');
  const { ColossusMaps } = await import('data:text/javascript;base64,' + Buffer.from('const config = ' + JSON.stringify(config) + ';\n' + code).toString('base64'));
  const maps = new ColossusMaps(manifest), { view, host } = harness();
  view.open('000010000'); const shell = host.children[0];
  view.setMap('colossus:gardens'); view.setActivityData(maps.world);
  assert.equal(host.children[0], shell, 'activity uses the existing window');
  assert.equal(view.page, 'colossus:gardens');
  assert.equal(view.spots.length, 0, 'the route map must never offer unauthorised teleport');
  assert.equal(Object.keys(maps.world.pages).length, 7);
  for (const [region] of Object.entries(config.regions)) {
    const [track, rail] = Object.entries(config.tracks).find(([,t])=>t.region===region);
    const body = {track, s: 0, grounded: true, facing: 1, position: rail.points[0], velocity: [0,0,0]};
    const state = {region, actors:[{id:'self',body}],people:[],frame:{position:[0,0,0],yaw:0}};
    const input = maps.input(state, [{id:'self'}], 'self');
    assert.equal(input.self.x, rail.points[0][0]);
    assert.equal(input.self.y, rail.points[0][2]);
    assert(input.map.url.startsWith('data:image/svg+xml'));
    assert(input.portals.length >= 2);
  }
  const p=[20,10,30], yaw=.7, origin=[300,40,100];
  const body={track:'gardens',s:0,grounded:false,facing:1,position:[origin[0]+Math.cos(yaw)*p[0]+Math.sin(yaw)*p[2],origin[1]+p[1],origin[2]-Math.sin(yaw)*p[0]+Math.cos(yaw)*p[2]],velocity:[0,1,0]};
  const input=maps.input({region:'gardens',actors:[{id:'self',body}],people:[],frame:{position:origin,yaw}},[{id:'self'}],'self');
  assert(Math.abs(input.self.x-p[0])<1e-8 && Math.abs(input.self.y-p[2])<1e-8,'airborne map marker shares the carrier reference frame');
  view.setMap('100000000'); view.setActivityData(undefined);
  assert.equal(view.page, 'WorldMap010');
  assert.equal(host.children[0], shell);
  view.destroy();
}
console.log('worldmap.check.mjs: 11 checks passed');
