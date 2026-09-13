import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./view.ts', import.meta.url), 'utf8');
const appearanceSource = await readFile(new URL('../entry/appearance.ts', import.meta.url), 'utf8');
const outputText = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/^import .*;\r?\n/gm, '');
const appearanceOutputText = ts.transpileModule(appearanceSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/^import .*;\r?\n/gm, '');
const appearance = await import(`data:text/javascript;base64,${Buffer.from(appearanceOutputText).toString('base64')}`);
Object.assign(globalThis, {
  appearanceKey: appearance.appearanceKey,
  appearanceAssetUrls: appearance.appearanceAssetUrls,
  appearanceLayer: appearance.appearanceLayer,
  appearanceWeaponType: appearance.appearanceWeaponType,
  cashAppearanceEntry: appearance.cashAppearanceEntry,
  composeAppearance: appearance.composeAppearance,
  loadAppearanceLayer: appearance.loadAppearanceLayer,
  normalizeAppearanceItemId: appearance.normalizeAppearanceItemId,
});
globalThis.actorDepthForLayers = () => 0;
globalThis.frameAt = (delays, elapsed, loop) => {
  const duration = delays.reduce((sum, delay) => sum + delay, 0);
  let cursor = loop && duration > 0 ? Math.max(0, elapsed) % duration : Math.min(Math.max(0, elapsed), duration - 0.001);
  for (let index = 0; index < delays.length; index++) {
    cursor -= delays[index];
    if (cursor < 0) return index;
  }
  return delays.length - 1;
};
const { PlayerView } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

let now = 100;
const textures = new Set();
const queuedTextures = new Set();
const completeListeners = [];
const loader = {
  once(event, callback) {
    if (event === 'complete') completeListeners.push(callback);
    return this;
  },
  image(key) {
    queuedTextures.add(key);
    return this;
  },
  isLoading() { return false; },
  start() {
    for (const key of queuedTextures) textures.add(key);
    queuedTextures.clear();
    for (const callback of completeListeners.splice(0)) callback();
    return this;
  },
};
const makeImage = (texture) => ({
  texture,
  setOrigin() { return this; },
  setTintFill() { return this; },
  clearTint() { return this; },
});
const scene = {
  time: { get now() { return now; } },
  textures: { exists: texture => textures.has(texture) },
  load: loader,
  add: {
    container() {
      return {
        list: [],
        setDepth() { return this; },
        removeAll() { this.list = []; return this; },
        add(image) { this.list.push(image); return this; },
        setPosition() { return this; },
        setScale() { return this; },
        destroy() { this.list = []; },
      };
    },
    text() { return { setOrigin() { return this; }, setDepth() { return this; }, setPosition() { return this; }, destroy() {} }; },
    image(_x, _y, texture) { return makeImage(texture); },
  },
};
const part = (url) => ({ url, x: 0, y: -20, z: 0 });
const frame = (url) => ({ parts: [part(url)], delay: 100 });
const manifest = {
  map: { layers: [] },
  avatar: {
    defaultFacing: 1,
    actions: {
      stand: [frame('stand')],
      jump: [frame('jump')],
      skill2001008: [frame('skill')],
    },
  },
};
const player = { hp: 100, action: 'stand', equipped: [], vy: 0, facing: 1, x: 0, y: 0, ladderId: null };
const view = new PlayerView(scene, manifest, 'mage', true);
view.startSkill(2001008, 1000);
view.update(player, 0);
assert.equal(view.body.list[0].texture, 'skill', 'accepted cast starts the skill pose');

now = 110;
view.hitFeedback();
view.update({ ...player, action: 'jump', vy: -1 }, 0);
assert.equal(view.body.list[0].texture, 'jump', 'hurt feedback cancels the skill pose for authoritative jump');
now = 200;
view.update({ ...player, action: 'jump', vy: -1 }, 0);
assert.equal(view.body.list[0].texture, 'jump', 'cancelled skill pose does not return during its old duration');
view.destroy();
console.log('PASS: hurt feedback cancels an active skill pose and follows the server jump action.');

// Map path regression: an indexed ordinary layer must load its JSON and PNG,
// then appear in stand/walk/skill; removing that item must remove only its
// layer instead of returning to the old starter loadout.
const ordinaryUrl = '/assets/test/ordinary-1212000.png';
const ordinaryItemId = '01212000';
const lazyLayer = {
  id: 1212000,
  itemId: ordinaryItemId,
  part: 'weapon',
  islot: 'Wp',
  vslot: 'Wp',
  cash: false,
  lazy: true,
  actions: Object.fromEntries(['stand', 'walk', 'skill2001008'].map(action => [action, [{ delay: 100, parts: [{ url: ordinaryUrl, x: 3, y: -8, z: 10, part: 'weapon', zName: 'weapon', itemId: ordinaryItemId }] }]])),
};
const lazyCatalog = {
  sourceVersion: 'test',
  smap: {},
  base: { '0': { actions: Object.fromEntries(['stand', 'walk', 'skill2001008'].map(action => [action, [{ delay: 100, parts: [{ url: `${action}-body`, x: 0, y: -20, z: 0, part: 'body', zName: 'body' }] }]])) } },
  layers: {
    'face:1': { id: 1, part: 'face', islot: '', vslot: '', actions: Object.fromEntries(['stand', 'walk', 'skill2001008'].map(action => [action, [{ delay: 100, parts: [{ url: `${action}-face`, x: 0, y: -18, z: 2, part: 'face', zName: 'face', itemId: '1' }] }]])) },
    'hair:2': { id: 2, part: 'hair', islot: '', vslot: '', actions: Object.fromEntries(['stand', 'walk', 'skill2001008'].map(action => [action, [{ delay: 100, parts: [{ url: `${action}-hair`, x: 0, y: -22, z: 1, part: 'hair', zName: 'hair', itemId: '2' }] }]])) },
  },
  cashAppearance: { contentVersion: 'test', sourceVersion: 'test', source: 'test', items: {
    [ordinaryItemId]: { itemId: ordinaryItemId, id: 1212000, part: 'weapon', islot: 'Wp', vslot: 'Wp', source: 'Character/Weapon/01212000.img', url: '/assets/test/ordinary-1212000.json', cash: false, lazy: true },
  } },
};
const lazyManifest = {
  map: { layers: [] },
  avatar: { defaultFacing: 1, actions: { stand: [frame('starter')], walk: [frame('starter')], jump: [frame('starter')], skill2001008: [frame('starter')] } },
  appearanceCatalog: lazyCatalog,
};
const lazyPlayer = { hp: 100, action: 'stand', equipped: [{ itemId: '1212000', slot: 11 }], appearance: { gender: 0, skin: 0, face: 1, hair: 2, coat: 0, pants: 0, shoes: 0, weapon: 1212000 }, vy: 0, facing: 1, x: 0, y: 0, ladderId: null };
const oldFetch = globalThis.fetch;
globalThis.fetch = async url => ({ ok: true, status: 200, json: async () => lazyLayer });
const lazyView = new PlayerView(scene, lazyManifest, 'ordinary', true);
lazyView.update(lazyPlayer, 0);
assert(!scene.textures.exists(ordinaryUrl), 'ordinary layer texture loaded before lazy request completed');
await new Promise(resolve => setTimeout(resolve, 0));
lazyView.update(lazyPlayer, 0);
assert.equal(lazyView.body.list.filter(image => image.texture === ordinaryUrl).length, 1, 'ordinary lazy weapon did not render on the map');
lazyPlayer.action = 'walk';
lazyView.update(lazyPlayer, 100);
assert(lazyView.body.list.some(image => image.texture === ordinaryUrl), 'ordinary lazy weapon disappeared while walking');
lazyView.startSkill(2001008, 1000);
lazyPlayer.action = 'stand';
lazyView.update(lazyPlayer, 100);
assert(lazyView.body.list.some(image => image.texture === ordinaryUrl), 'ordinary lazy weapon disappeared during skill pose');
lazyPlayer.equipped = [];
lazyView.update(lazyPlayer, 100);
assert(!lazyView.body.list.some(image => image.texture === ordinaryUrl), 'unequipped ordinary layer remained on the map');
lazyView.destroy();
globalThis.fetch = oldFetch;
console.log('PASS: PlayerView loads an indexed ordinary layer, renders stand/walk/skill, and removes it on unequip.');
