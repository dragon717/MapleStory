import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Same pattern as the other client checks: transpile the module and replace
// its imports with local stubs (Phaser and the asset pipeline are not
// available under node), then drive the view with a minimal scene stub.
// The server owns every tombstone decision (existence, stage, expiry, mourn
// dedup), so this pins the presentation contract only:
//   - the ghost IS the dead player's gray form: stand-frame parts become
//     tinted images (gray), only after every texture is actually loaded;
//   - until then the abstract wisp stays visible (fallback, never blank);
//   - the stage label is always the server word, never a local guess.
const source = await readFile(new URL('./tombstone.ts', import.meta.url), 'utf8');
const outputText = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/^import .*;\r?\n/gm, '');

// Stub the lazy-texture entry the view imports. ensureTextures is a SYNC
// boolean in the real pipeline (it queues loads and reports readiness), so the
// stub mirrors that: ready only while every requested url is in this list.
const injected = `
var availableTextures = [];
globalThis.__setGhostTextures = list => { availableTextures = list; };
globalThis.__currentGhostTextures = () => availableTextures;
var ensureTextures = (_scene, urls) => urls.every(url => availableTextures.includes(url));
`;
const moduleText = `${injected}\n${outputText}`;
const { TombstoneWorldView } = await import(`data:text/javascript;base64,${Buffer.from(moduleText).toString('base64')}`);

const snapshot = (overrides = {}) => ({
  id: 'tomb-death-1', x: 320, y: 200,
  characterName: '木鸟', epitaph: '别为我停太久，前面有怪。',
  stage: 0, stageName: '潜伏', mourners: 0, expiresInMs: 1_700_000,
  ...overrides,
});
const ghostFrames = [
  {
    delay: 500,
    parts: [
      { key: 'body', url: 'ghost-body.png', x: -6, y: -30, origin: { x: 0, y: 0 }, z: 0 },
      { key: 'arm', url: 'ghost-arm.png', x: 4, y: -26, origin: { x: 0, y: 0 }, z: 1 },
    ],
  },
];
const allGhostTextures = ['ghost-body.png', 'ghost-arm.png'];

function fakeScene() {
  const created = [];
  const make = (kind, extra = {}) => {
    const node = {
      kind, destroyed: false, active: true, x: 0, y: 0, text: '', added: [],
      tint: null, alpha: 1, visible: true, handlers: {},
      add(...children) { this.added.push(...children); return this; },
      addAt(child, index) { this.added.splice(index, 0, child); return this; },
      setDepth() { return this; },
      setOrigin() { return this; },
      setPosition(x, y) { this.x = x; this.y = y; return this; },
      setText(t) { this.text = t; return this; },
      setInteractive() { return this; },
      on(name, handler) { this.handlers[name] = handler; return this; },
      clear() { return this; },
      setVisible(flag) { this.visible = flag; return this; },
      setTint(tint) { this.tint = tint; return this; },
      setAlpha(alpha) { this.alpha = alpha; return this; },
      fillStyle() { return this; },
      fillCircle() { return this; },
      fillRect() { return this; },
      fillRoundedRect() { return this; },
      lineStyle() { return this; },
      lineBetween() { return this; },
      strokeRoundedRect() { return this; },
      destroy() { this.destroyed = true; this.active = false; },
      ...extra,
    };
    created.push(node);
    return node;
  };
  return {
    created,
    textures: { exists: url => __currentGhostTextures().includes(url) },
    add: {
      container: (x, y) => make('container', { x, y }),
      graphics: () => make('graphics'),
      text: (x, y, text) => make('text', { text }),
      zone: (x, y, w, h) => make('zone', { x, y, w, h }),
      image: (_x, _y, url) => make('image', { url }),
    },
  };
}

// The ghost container is the one whose children are exactly the tinted images
// (the outer tombstone container also holds 2 entries: a child array + zone).
const ghostContainerOf = scene =>
  scene.created.find(node => node.kind === 'container'
    && node.added.length === ghostFrames[0].parts.length
    && node.added.every(child => child.kind === 'image'));

// --- gray ghost: the dead player's look, rendered only once textures exist ---
{
  __setGhostTextures([]);
  const scene = fakeScene();
  const mourns = [];
  const view = new TombstoneWorldView(scene, snapshot(), 42, id => mourns.push(id), ghostFrames);
  const texts = scene.created.filter(node => node.kind === 'text');
  assert.deepEqual(texts.map(node => node.text), ['木鸟', '虚影 · 潜伏'], 'name and authoritative stage label are rendered');
  assert.equal(mourns.length, 0, 'no mourn intent before any click');

  // 贴图备齐前：光点兜底可见，灰影未出现——绝不允许两者都空白。
  assert.equal(ghostContainerOf(scene), undefined, 'no ghost container before textures are ready');
  const wisp = scene.created.filter(node => node.kind === 'graphics')[1];
  assert.equal(wisp.visible, true, 'the fallback wisp stays visible until the gray ghost is ready');

  // 贴图到齐后，下一帧 update 把灰影拼出来（每帧重试，成一次即止）。
  __setGhostTextures(allGhostTextures);
  view.update(snapshot(), 16);
  const ghost = ghostContainerOf(scene);
  assert.ok(ghost, 'the gray ghost is composed after textures load');
  assert.deepEqual(ghost.added.map(node => node.tint), [0x94a3ad, 0x94a3ad], 'every ghost part carries the gray tint');
  assert.deepEqual(ghost.added.map(node => node.url), ['ghost-arm.png', 'ghost-body.png'], 'parts are laid out in z order (back to front)');
  assert.equal(wisp.visible, false, 'the wisp retires once the gray ghost is on stage');

  // 阶段推进只改观感：位置/透明度由 update 驱动，标签永远用服务器的词。
  view.update(snapshot({ stage: 2, stageName: '凝聚' }), 16);
  assert.equal(ghost.alpha > 0, true, 'the gray ghost is visible at stage 2');
  const stageLabel = texts[1];
  assert.equal(stageLabel.text, '虚影 · 凝聚', 'the stage label follows the snapshot verbatim');

  view.destroy();
  assert.equal(ghost.destroyed, false, 'the child dies with the parent container, not separately');
}

// --- fallback: missing texture keeps the wisp, never a half-built ghost ------
{
  __setGhostTextures(['ghost-body.png']);
  const scene = fakeScene();
  const view = new TombstoneWorldView(scene, snapshot(), 42, () => {}, ghostFrames);
  view.update(snapshot(), 16);
  view.update(snapshot(), 16);
  const containers = scene.created.filter(node => node.kind === 'container');
  assert.equal(containers.length, 1, 'a missing texture never yields a partial ghost');
  const wisp = scene.created.filter(node => node.kind === 'graphics')[1];
  assert.equal(wisp.visible, true, 'the wisp still covers for the missing texture');
}

// --- no appearance at all: same fallback path ---------------------------------
{
  __setGhostTextures(allGhostTextures);
  const scene = fakeScene();
  const view = new TombstoneWorldView(scene, snapshot(), 42, () => {}, undefined);
  view.update(snapshot(), 16);
  assert.equal(scene.created.filter(node => node.kind === 'image').length, 0, 'no ghost parts without supplied frames');
}

// --- click = one bare mourn intent --------------------------------------------
{
  __setGhostTextures([]);
  const scene = fakeScene();
  const mourns = [];
  new TombstoneWorldView(scene, snapshot(), 42, id => mourns.push(id), ghostFrames);
  const zone = scene.created.find(node => node.kind === 'zone');
  assert.equal(typeof zone.handlers.pointerdown, 'function', 'the tombstone body is clickable');
  const stop = { calls: 0, stopPropagation() { this.calls += 1; } };
  zone.handlers.pointerdown({ button: 0 }, 0, 0, stop);
  assert.deepEqual(mourns, ['tomb-death-1'], 'a click reports exactly the snapshot id');
  assert.equal(stop.calls, 1, 'the click does not fall through to npc/reactor hit tests');
}
