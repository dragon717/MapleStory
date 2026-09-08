import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./view.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
globalThis.frameAt = (delays, elapsed, loop) => {
  const total = delays.reduce((sum, delay) => sum + delay, 0);
  let value = Math.max(0, elapsed);
  if (loop && total > 0) value %= total;
  for (let index = 0; index < delays.length; index++) {
    if (value < delays[index]) return index;
    value -= delays[index];
  }
  return Math.max(0, delays.length - 1);
};
globalThis.assetFrameAlpha = () => 1;
globalThis.damageNumberAdvances = () => [];
const stripped = outputText.replace(/^import .*;\r?\n/gm, '');
const { CombatView } = await import(`data:text/javascript;base64,${Buffer.from(stripped).toString('base64')}`);

let now = 100;
const sprites = [];
const scene = {
  add: {
    image: () => {
      const sprite = {
        visible: false,
        destroyed: false,
        setOrigin() { return this; },
        setDepth() { return this; },
        setVisible(value) { this.visible = value; return this; },
        setTexture() { return this; },
        setAlpha() { return this; },
        setPosition() { return this; },
        setFlipX() { return this; },
        destroy() { this.destroyed = true; },
      };
      sprites.push(sprite);
      return sprite;
    },
  },
};
const frames = [{ url: '/skill.png', width: 1, height: 1, origin: { x: 0, y: 0 }, x: 0, y: 0, delay: 20 }];
const view = new CombatView(scene, undefined, 0, () => now, 'combat-hit', { '2001009': { effect: frames } });
const event = { type: 'skillCast', eventId: 'instant', serverTick: 1, playerId: 'player', skillId: 2001009, requestId: 'cast-1', x: 4, y: 8, facing: 1, durationMs: 0 };
assert.equal(view.receiveSkillCast(event), true, 'first skillCast event is accepted');
assert.equal(view.receiveSkillCast(event), false, 'duplicate skillCast event is rejected');
assert.equal(sprites.length, 1, 'duplicate skillCast events create one VFX');
view.update(now);
assert.equal(sprites[0].visible, true, 'duration zero still starts the source VFX');
now += 20;
view.update(now);
assert.equal(sprites[0].destroyed, true, 'source frame timing controls VFX lifetime');
view.receiveSkillCast({ ...event, eventId: 'clear-me' });
assert.equal(sprites.length, 2);
view.clear();
assert.equal(sprites[1].destroyed, true, 'clear destroys pending skill VFX');
console.log('PASS: zero-duration skill VFX, event deduplication, source timing, and clear.');

const tile = { ...frames[0], width: 20, source: 'Skill/220.img/skill/2201009/tile/1/0' };
const fieldView = new CombatView(scene, undefined, 0, () => now, 'combat-hit', { '2201009': { tile: [tile] } });
const firstTile = sprites.length;
const fieldEvent = { ...event, skillId: 2201009, eventId: 'field', targetX: 44, targetY: 8, durationMs: 6000 };
fieldView.receiveSkillCast(fieldEvent);
fieldView.receiveSkillCast(fieldEvent);
assert.equal(sprites.length - firstTile, 3, 'one authoritative segment is tiled once');
now += 40;
fieldView.update(now);
assert(sprites.slice(firstTile).every(sprite => sprite.visible && !sprite.destroyed), 'field loops after one source animation');
now += 5960;
fieldView.update(now);
assert(sprites.slice(firstTile).every(sprite => sprite.destroyed), 'field expires at authoritative duration');
console.log('PASS: ice field source tiles, deduplication, loop and server lifetime.');
