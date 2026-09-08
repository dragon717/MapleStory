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

const sphereView = new CombatView(scene, undefined, 0, () => now, 'combat-hit', {
  '2211011': { summonStand: frames, summonMove: frames, summonAttack: frames },
  '2211015': { summonStand: frames, summonAttack: frames },
});
const beforeSphere = sprites.length;
const sphere = { id: 's', playerId: 'p', skillId: 2211011, x: 20, y: 30, facing: 1, expiresInMs: 1000, stationary: false };
sphereView.syncSummons([sphere]); sphereView.update(now);
assert.equal(sprites.length, beforeSphere + 1, 'late snapshot creates the existing sphere');
sphereView.syncSummons([{ ...sphere, skillId: 2211015, stationary: true }]);
assert.equal(sprites.length, beforeSphere + 1, 'fixing a sphere reuses its visual');
sphereView.syncSummons([]);
assert(sprites[beforeSphere].destroyed, 'map snapshot removes absent spheres');
sphereView.syncSummons([{ ...sphere, id: 'expiry' }]);
now += 1000; sphereView.update(now);
assert(sprites.at(-1).destroyed, 'sphere expires without another snapshot');
sphereView.syncSummons([{ ...sphere, id: 'disconnect' }]);
sphereView.clear(); assert(sprites.at(-1).destroyed, 'disconnect clears every sphere');
console.log('PASS: summon late join, conversion reuse, map removal, expiry and disconnect.');

const levelOne = [{ ...frames[0], url: '/snail-1.png' }];
const levelThree = [{ ...frames[0], url: '/snail-3.png' }];
const snail = new CombatView(scene, undefined, 0, () => now, 'combat-hit', {
  '1000:1': { ball: levelOne, hit: levelOne }, '1000:3': { ball: levelThree, hit: levelThree },
});
const snailEvent = { ...event, eventId: 'snail', skillId: 1000, skillLevel: 3, targetX: 100, targetY: 8 };
assert.equal(snail.receiveSkillCast(snailEvent), true);
assert.equal(snail.skillVisuals[0].frames[0].url, '/snail-3.png');
snail.spawnSkillHit({ skillId: 1000, skillLevel: 1, x: 100, y: 8 });
assert.equal(snail.skillVisuals[1].frames[0].url, '/snail-1.png');
assert.equal(snail.receiveSkillCast(snailEvent), false);
snail.clear();
assert.equal(snail.skillVisuals.length, 0);
console.log('PASS: beginner projectile/hit use the authoritative skill level and clear safely.');

const heldView = new CombatView(scene, undefined, 0, () => now, 'combat-hit', {
  '2221011': { prepare: frames, keydown: frames, keydown0: frames, keydownend: frames },
  '2221004': { special: frames },
  '2221007': { tile: [0, 1].map(i => ({ ...frames[0], source: `Skill/222.img/skill/2221007/tile/${i}/0` })) },
});
const heldEvent = { ...event, eventId: 'hold', skillId: 2221011, durationMs: 10000 };
heldView.receiveSkillCast(heldEvent);
assert.equal(heldView.skillVisuals.length, 3);
assert.equal(heldView.skillVisuals.filter(v => v.loopMs).length, 2);
heldView.receiveSkillCast({ ...heldEvent, eventId: 'wrong-release', requestId: 'wrong', durationMs: 0 });
assert.equal(heldView.skillVisuals.filter(v => v.loopMs).length, 2, 'stale release cannot clear current hold');
heldView.receiveSkillCast({ ...heldEvent, eventId: 'release', durationMs: 0 });
assert.equal(heldView.skillVisuals.filter(v => v.loopMs).length, 0);
assert.equal(heldView.channelAudio.size, 0);
heldView.clear();
const observer = { id: 'observer', hp: 10, x: 1, y: 2, facing: 1, derivedStats: { skillBuffs: { '2221011': 5000 } } };
heldView.syncPlayers([observer]);
assert.equal(heldView.skillVisuals.length, 2, 'late join restores both source hold layers');
heldView.receiveSkillCast({ ...heldEvent, eventId: 'observer-release', playerId: 'observer', durationMs: 0 });
assert.equal(heldView.skillVisuals.filter(v => v.loopMs).length, 0, 'release clears recovered hold with unknown request ID');
heldView.clear();
heldView.syncPlayers([{ ...observer, derivedStats: { skillBuffs: { '2221004': 5000 }, infinityEnhanced: true } }]);
assert.equal(heldView.skillVisuals.length, 1);
heldView.syncPlayers([{ ...observer, derivedStats: {} }]);
assert.equal(heldView.skillVisuals.length, 0, 'expired Infinity removes its follower');
heldView.receiveSkillCast({ ...event, eventId: 'blizzard', skillId: 2221007 });
assert.equal(heldView.skillVisuals.length, 4);
assert(heldView.skillVisuals.every(v => v.frames.length === 1), 'tile variants never concatenate into one animation');
heldView.clear();
console.log('PASS: fourth hold layers, stale/current release, observer recovery, Infinity cleanup and tile variants.');
