import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./view.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
// `view.ts` 的 import 被整段剥掉（与 skill.check.mjs 同一套做法），所以它依赖的纯函数
// 只能按全局桩提供。`damageNumberLayers` 是 `damage-number.ts` 的「一次承伤画几根」
// 判据——`receiveDamageEvent` 拿它当入口闸门，缺了它这里会直接 `ReferenceError`
// （2026-09-21 实测：本文件当时还没进 `run-checks.mjs` 的清单，所以红了很久没人知道）。
// 本检查只关心音效，所以按源规则给个非空的桩即可。
globalThis.damageNumberLayers = (damage, mpDamage = 0) => [
  ...(Number.isFinite(damage) && damage > 0 ? [{ kind: 'damage', value: damage, offsetY: 0 }] : []),
  ...(Number.isFinite(mpDamage) && mpDamage > 0 ? [{ kind: 'mp', value: mpDamage, offsetY: damage > 0 ? 20 : 0 }] : []),
];
const { CombatView } = await import(`data:text/javascript;base64,${Buffer.from(outputText.replace(/^import .*;\r?\n/gm, '')).toString('base64')}`);
const played = [];
const scene = { sound: { play: key => played.push(key) }, cache: { audio: { exists: key => ['combat-hit', 'mob-hit-100101'].includes(key) } } };
const view = new CombatView(scene, undefined, 0);
let numbers = 0;
view.spawnDamageNumber = () => numbers++;
const event = { type: 'damageEvent', eventId: 'one', targetId: 'blue-snail', serverTick: 1, x: 1, y: 1, damage: 4 };
view.receiveDamageEvent(event, 'mob-hit-100101');
view.receiveDamageEvent(event, 'mob-hit-100101');
assert.deepEqual(played, ['mob-hit-100101'], 'Correct monster sound is played once per authoritative event');
view.receiveDamageEvent({ ...event, eventId: 'two' }, 'mob-hit-missing');
assert.equal(numbers, 2, 'Missing audio does not suppress authoritative damage');
assert.equal(played.length, 1, 'Missing monster audio does not use another monster sound');
console.log('PASS: species-specific hit audio, deduplication and missing audio.');

const skillInstances = [];
scene.cache.audio.exists = key => key === '/use.mp3' || key === '/hit.mp3';
scene.sound.add = key => {
  const sound = { key, destroyed: false, complete: null,
    once(_, fn) { this.complete = fn; }, play() { return true; }, destroy() { this.destroyed = true; } };
  skillInstances.push(sound);
  return sound;
};
const skills = new CombatView(scene, undefined, 0, undefined, undefined, undefined,
  { '2201008': { use: { url: '/use.mp3' }, hit: { url: '/hit.mp3' } } });
skills.spawnDamageNumber = () => {};
const cast = { type: 'skillCast', eventId: 'skill-use', serverTick: 1, playerId: 'a', skillId: 2201008, requestId: 'cast', x: 0, y: 0, facing: 1, durationMs: 500 };
skills.receiveSkillCast(cast);
skills.receiveSkillCast(cast);
assert.equal(skillInstances.length, 1, 'duplicate cast sounds once');
skills.receiveDamageEvent({ ...event, eventId: 'skill-hit', skillId: 2201008, attackerId: 'a', segment: 1 });
skills.receiveDamageEvent({ ...event, eventId: 'skill-hit', skillId: 2201008, attackerId: 'a', segment: 1 });
skills.receiveDamageEvent({ ...event, eventId: 'skill-hit-2', skillId: 2201008, attackerId: 'a', segment: 2 });
assert.equal(skillInstances.length, 2, 'first segment hit sound is not duplicated by later segments');
skillInstances[1].complete();
assert(skillInstances[1].destroyed, 'completed audio releases itself');
skills.clearSkillPlayer('a');
assert(skillInstances[0].destroyed, 'departing player audio is stopped');
skills.receiveSkillCast({ ...cast, eventId: 'clear', playerId: 'b' });
skills.clear();
assert(skillInstances[2].destroyed, 'scene cleanup stops remaining audio');
console.log('PASS: source skill audio, event deduplication, segment policy and lifecycle cleanup.');
