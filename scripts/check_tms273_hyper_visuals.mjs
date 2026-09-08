import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from '../client/node_modules/typescript/lib/typescript.js';

const frameAt = (delays, elapsed, loop) => {
  const total = delays.reduce((sum, delay) => sum + delay, 0);
  let value = Math.max(0, elapsed);
  if (loop && total > 0) value %= total;
  for (let i = 0; i < delays.length; i++) { if (value < delays[i]) return i; value -= delays[i]; }
  return Math.max(0, delays.length - 1);
};
globalThis.frameAt = frameAt;
globalThis.assetFrameAlpha = () => 1;
globalThis.damageNumberAdvances = () => [];
globalThis.actorDepthForLayers = () => 1;
globalThis.appearanceKey = () => '';
globalThis.composeAppearance = () => undefined;

async function loadClass(path, name) {
  const source = await readFile(new URL(`../client/src/${path}`, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const stripped = output.replace(/^import .*;\r?\n/gm, '');
  return (await import(`data:text/javascript;base64,${Buffer.from(stripped).toString('base64')}`))[name];
}
const CombatView = await loadClass('features/combat/view.ts', 'CombatView');
const PlayerView = await loadClass('features/player/view.ts', 'PlayerView');

let now = 100;
function scene() {
  const sprites = [], sounds = [], plays = [];
  const image = (_x, _y, key = '') => {
    const value = { visible: false, destroyed: false, texture: key, list: [],
      setOrigin() { return this; }, setDepth() { return this; }, setVisible(v) { this.visible = v; return this; },
      setTexture(v) { this.texture = v; return this; }, setAlpha() { return this; }, setPosition() { return this; },
      setFlipX() { return this; }, setTintFill() { return this; }, clearTint() { return this; },
      destroy() { this.destroyed = true; },
    };
    sprites.push(value); return value;
  };
  const soundAdd = key => {
    const value = { key, destroyed: false, complete: undefined,
      once(_event, callback) { this.complete = callback; },
      play(options) { if (!this.destroyed) plays.push({ key, options }); return true; },
      destroy() { this.destroyed = true; },
    };
    sounds.push(value); return value;
  };
  const container = () => ({ list: [], setDepth() { return this; }, setPosition() { return this; }, setScale() { return this; },
    removeAll() { this.list = []; return this; }, add(child) { this.list.push(child); return this; }, destroy() { this.list = []; } });
  const text = () => ({ setOrigin() { return this; }, setDepth() { return this; }, setPosition() { return this; }, destroy() {} });
  return { sprites, sounds, plays, time: { now }, add: { image, container, text },
    sound: { add: soundAdd, play: key => plays.push({ key }) }, cache: { audio: { exists: () => true } },
    tweens: { killTweensOf() {} },
  };
}
const f = (url, source = url, delay = 20) => ({ url, source, width: 10, height: 10, origin: { x: 0, y: 0 }, x: 0, y: 0, delay });
const effects = {
  '2221052': { prepare: [f('/prep')], keydown: [f('/hold')], keydownend: [f('/final')], hit: [f('/hit')], special: [f('/special')] },
  '2221054': { start: [f('/barrier-start')], repeat: [f('/barrier-repeat')], end: [f('/barrier-end')] },
  '2221055': { tile: [0, 1, 2].map(i => f(`/tile-${i}`, `Skill/222.img/skill/2221055/tile/${i}/0`)), tile0: [0, 1, 2].map(i => f(`/tile0-${i}`, `Skill/222.img/skill/2221055/tile0/${i}/0`)) },
};
const sounds = {
  '2221052': { use: { url: '/thunder-use' }, loop: { url: '/thunder-loop' }, end: { url: '/thunder-end' }, special: { url: '/thunder-special' } },
  '2221054': { use: { url: '/barrier-use' }, loop: { url: '/barrier-loop' }, end: { url: '/barrier-end' } },
  '2221055': { end: { url: '/vortex-end' } },
};
const event = (extra = {}) => ({ type: 'skillCast', eventId: 'cast', serverTick: 1, playerId: 'p', skillId: 2221052, requestId: 'r', x: 0, y: 0, facing: 1, durationMs: 100, ...extra });
const playerState = (extra = {}) => ({ id: 'p', username: 'P', hp: 100, x: 0, y: 0, facing: 1, action: 'stand', level: 1, ...extra });

const combatScene = scene();
const combat = new CombatView(combatScene, undefined, 0, () => now, 'combat-hit', effects, sounds);
assert.equal(combat.receiveSkillCast(event({ phase: 'prepare' })), true);
assert.equal(combat.receiveSkillCast(event({ eventId: 'sustain', serverTick: 2, phase: 'sustain', durationMs: 200 })), true);
assert.equal(combat.receiveSkillCast(event({ eventId: 'sustain-duplicate', serverTick: 2, phase: 'sustain', durationMs: 200 })), false, 'same phase does not replay');
assert.equal(combat.receiveSkillCast(event({ eventId: 'release', serverTick: 3, phase: 'sustain', durationMs: 0 })), true, 'zero release is accepted once');
assert.equal(combat.skillVisuals.filter(v => v.loopMs).length, 0);
assert.equal(combat.channelAudio.size, 0);
assert.equal(combat.receiveSkillCast(event({ eventId: 'final', serverTick: 4, phase: 'final', durationMs: 40 })), true);
assert.equal(combat.receiveSkillCast(event({ eventId: 'final-duplicate', serverTick: 4, phase: 'final', durationMs: 40 })), false);

const playerScene = scene();
const actionFrame = name => [{ delay: 20, parts: [{ key: name, url: name, x: 0, y: 0, origin: { x: 0, y: 0 }, z: 0 }] }];
const playerManifest = { map: { layers: [] }, avatar: { defaultFacing: 1, actions: { stand: actionFrame('stand'), skill2221052prepare: actionFrame('prepare'), skill2221052: actionFrame('hold'), skill2221052final: actionFrame('final') } } };
const player = new PlayerView(playerScene, playerManifest, 'P', true);
playerScene.time.now = 100; player.startSkill(2221052, 100, 'prepare'); player.update(playerState(), 0);
assert.equal(player.body.list[0].texture, 'prepare', 'prepare action uses exported suffix');
playerScene.time.now = 110; player.startSkill(2221052, 100, 'sustain'); player.update(playerState(), 0);
assert.equal(player.body.list[0].texture, 'hold', 'sustain action uses base action');
player.startSkill(2221052, 0, 'sustain'); player.update(playerState(), 0);
assert.equal(player.body.list[0].texture, 'stand', 'zero release returns to stand');
playerScene.time.now = 120; player.startSkill(2221052, 40, 'final'); player.update(playerState(), 0);
assert.equal(player.body.list[0].texture, 'final', 'final action uses exported suffix');

const barrierScene = scene();
const barrier = new CombatView(barrierScene, undefined, 0, () => now, 'combat-hit', effects, sounds);
const active = playerState({ derivedStats: { hyperBarrierActive: true } });
barrier.receiveSkillCast(event({ skillId: 2221054, eventId: 'barrier-on', requestId: 'b', durationMs: 600 }));
barrier.syncPlayers([active]); barrier.syncPlayers([{ ...active }]);
assert.equal(barrierScene.plays.filter(play => play.key === '/barrier-use').length, 1, 'duplicate active snapshots do not replay Use');
assert.equal(barrierScene.sounds.filter(sound => sound.key === '/barrier-loop').length, 1, 'duplicate active snapshots do not duplicate loop');
barrier.syncPlayers([playerState({ derivedStats: {} })]);
assert.equal(barrierScene.plays.filter(play => play.key === '/barrier-end').length, 1, 'deactivation plays End once');
barrier.syncPlayers([playerState({ derivedStats: {} })]);
assert.equal(barrierScene.plays.filter(play => play.key === '/barrier-end').length, 1);

const summonScene = scene();
const summonView = new CombatView(summonScene, undefined, 0, () => now, 'combat-hit', effects, sounds);
const alive = playerState();
const summon = (id, owner = 'p') => ({ id, playerId: owner, skillId: 2221055, x: 10, y: 20, facing: 1, expiresInMs: 1_000, stationary: true });
summonView.syncPlayers([alive]); summonView.syncSummons([summon('gone')]);
assert.equal(summonView.skillVisuals.filter(v => v.sourceSummonId === 'gone').length, 6, 'tile/tile0 variants are rendered separately');
summonView.syncSummons([]);
assert.equal(summonScene.plays.filter(play => play.key === '/vortex-end').length, 1);
assert(summonScene.sprites.filter(sprite => sprite.destroyed).length >= 6, 'snapshot removal destroys every source variant');
summonView.syncSummons([summon('dead')]); summonView.syncPlayers([playerState({ hp: 0, action: 'dead' })]); summonView.syncSummons([]);
assert.equal(summonScene.plays.filter(play => play.key === '/vortex-end').length, 1, 'death suppresses End');
summonView.syncSummons([summon('left')]); summonView.syncPlayers([]); summonView.syncSummons([]);
assert.equal(summonScene.plays.filter(play => play.key === '/vortex-end').length, 1, 'map leave suppresses End');
summonView.syncSummons([summon('reset')]); summonView.clear();
assert.equal(summonScene.plays.filter(play => play.key === '/vortex-end').length, 1, 'reset suppresses End');
console.log('PASS: TMS273 Hyper 1052 phases/release, 1054 snapshot audio, and 1055 lifecycle cleanup.');
