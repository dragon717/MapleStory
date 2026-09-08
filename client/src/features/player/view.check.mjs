import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./view.ts', import.meta.url), 'utf8');
const outputText = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/^import .*;\r?\n/gm, '');
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
const makeImage = (texture) => ({
  texture,
  setOrigin() { return this; },
  setTintFill() { return this; },
  clearTint() { return this; },
});
const scene = {
  time: { get now() { return now; } },
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
