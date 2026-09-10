import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Same pattern as the other client checks: transpile the module and drop its
// imports (Phaser is not available under node), then drive the view with a
// minimal scene stub.  The server owns every reactor decision, so this only
// verifies the presentation contract — most importantly that the client never
// advances a state on its own, which is what would make two clients disagree
// about whether a prop is still there.
const source = await readFile(new URL('./reactor-view.ts', import.meta.url), 'utf8');
const outputText = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/^import .*;\r?\n/gm, '');
const { ReactorView, reactorStateAsset } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

const frame = (url, delay = 150, w = 57, h = 74, ox = 24, oy = 47) => ({
  url, width: w, height: h, origin: { x: ox, y: oy }, x: -ox, y: -oy, delay,
});

const template = {
  templateId: '1022003',
  action: 'periFlower0',
  states: {
    // Idle loops (source repeat=1); the impact is a one-shot animation.
    0: {
      frames: [frame('idle0'), frame('idle1'), frame('idle2')],
      hitFrames: [frame('hit0', 80), frame('hit1', 80), frame('hit2', 80)],
      events: [{ type: 9, nextState: 1, lt: { x: -25, y: -25 }, rb: { x: 32, y: 26 } }],
      repeat: true,
    },
    // The "used up" state ships no art at all.
    1: { frames: [], hitFrames: [], events: [], repeat: false },
  },
};

function fakeScene() {
  const image = {
    url: null, visible: true, destroyed: false,
    setTexture(url) { this.url = url; return this; },
    setOrigin() { return this; },
    setPosition() { return this; },
    setDepth() { return this; },
    setFlipX() { return this; },
    setVisible(flag) { this.visible = flag; return this; },
    destroy() { this.destroyed = true; },
  };
  return {
    add: { image: (_x, _y, url) => { image.url = url; return image; } },
    get sprite() { return image; },
  };
}

// --- asset lookup -----------------------------------------------------------
assert.equal(reactorStateAsset({ '1022003': template }, '1022003', 0), template.states['0']);
assert.equal(reactorStateAsset({ '1022003': template }, '1022003', 1), template.states['1']);
// An unknown template yields nothing rather than a blank sprite.
assert.equal(reactorStateAsset({ '1022003': template }, '9999999', 0), undefined);
// An out-of-range state falls back to the first one instead of vanishing.
assert.equal(reactorStateAsset({ '1022003': template }, '1022003', 7), template.states['0']);

// --- idle animation loops ---------------------------------------------------
{
  const scene = fakeScene();
  const view = new ReactorView(scene, template.states['0'], 400, 200, false, 5);
  view.update(0);
  assert.equal(scene.sprite.url, 'idle0', 'first idle frame is shown immediately');
  // Three frames × 150 ms; `update` accumulates elapsed time.
  view.update(150);
  assert.equal(scene.sprite.url, 'idle1', 'a repeating idle animation advances');
  view.update(150);
  assert.equal(scene.sprite.url, 'idle2');
  view.update(150);
  assert.equal(scene.sprite.url, 'idle0', 'the idle animation wraps around');
  assert.equal(view.isSpent, false);

  // --- one-shot impact -----------------------------------------------------
  view.playHit(600);
  assert.equal(scene.sprite.url, 'hit0', 'the impact animation takes over');
  view.update(80);
  assert.equal(scene.sprite.url, 'hit1');
  view.update(80);
  assert.equal(scene.sprite.url, 'hit2');
  // Past the last frame (3 × 80 ms) the one-shot ends and idle resumes.
  view.update(80);
  assert.equal(scene.sprite.url, 'idle0', 'the impact ends and idle resumes');
  view.update(150);
  assert.equal(scene.sprite.url, 'idle1', 'idle keeps advancing after the impact');
  view.destroy();
  assert.equal(scene.sprite.destroyed, true);
}

// --- a non-repeating template holds its frame -------------------------------
{
  const single = { frames: [frame('only')], hitFrames: [frame('h')], events: [], repeat: false };
  const scene = fakeScene();
  const view = new ReactorView(scene, single, 0, 0, false, 1);
  view.update(10_000);
  assert.equal(scene.sprite.url, 'only', 'a single-frame prop never cycles');
}

// --- a spent prop is hidden and the client cannot revive it -----------------
{
  const scene = fakeScene();
  const view = new ReactorView(scene, template.states['0'], 100, 100, false, 2);
  view.setState(template.states['1'], 1, true);
  assert.equal(view.isSpent, true);
  assert.equal(view.currentState, 1);
  assert.equal(scene.sprite.visible, false, 'a used-up prop is invisible');
  view.playHit(600);
  view.update(600);
  assert.equal(view.currentState, 1, 'a spent prop cannot be animated by the client');

  // Coming back on the authored timer restores it.
  view.setState(template.states['0'], 0, false);
  assert.equal(view.isSpent, false);
  assert.equal(scene.sprite.visible, true);
  assert.equal(scene.sprite.url, 'idle0', 'a returned prop replays from its first frame');
}

console.log('reactor.check.mjs: 8 scenarios passed');
