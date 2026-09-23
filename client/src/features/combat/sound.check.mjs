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
// `view.ts` 的 import 被整段剥掉，所以它从 `player/input.ts` 取的那几张镜像名单也成了
// 未定义全局（2026-09-23 之前本文件只碰过 2201008，没走到那些分支）。这里把
// `player/input.ts` 按同一套「转译 + 剥 import」求值注入**真值**，而不是手抄一份桩
// ——手抄的桩会在名单改动时静默说谎。
{
  const inputSource = await readFile(new URL('../player/input.ts', import.meta.url), 'utf8');
  const { outputText: inputOutput } = ts.transpileModule(inputSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  const inputModule = await import(`data:text/javascript;base64,${Buffer.from(inputOutput.replace(/^import .*;\r?\n/gm, '')).toString('base64')}`);
  for (const name of ['INFINITY_SKILLS', 'DEMON_SUMMON_SKILLS', 'CASTER_ANCHORED_BUFFS', 'HYPER_ADVENTURER_SKILLS']) {
    assert.ok(Array.isArray(inputModule[name]) && inputModule[name].length > 0, `player/input.ts 必须导出非空的 ${name}`);
    globalThis[name] = inputModule[name];
  }
}
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

// ---- 召喚火魔的周期打击音（2026-09-23）----------------------------------------
//
// 「哪些技能算召唤物的周期打击」在 `receiveDamageEvent` 里也是一张镜像名单
// （`DEMON_SUMMON_SKILLS`）。改前只有 2211011／2211015 两件冰雷召唤，火毒那本打出去
// 一声不响。这里钉住火魔走同一条路，并配一条反向断言：不在名单里的技能不许借这条路出声。
{
  const fireInstances = [];
  scene.cache.audio.exists = key => key === '/fire-attack.mp3';
  scene.sound.add = key => {
    const sound = { key, destroyed: false, complete: null,
      once(_, fn) { this.complete = fn; }, play() { return true; }, destroy() { this.destroyed = true; } };
    fireInstances.push(sound);
    return sound;
  };
  // 只给火魔配 `summonAttack`：`2121004` 在 `skillSounds` 里刻意缺席，所以反向用例
  // 不会因为 `hit` 音而误报。
  const fire = new CombatView(scene, undefined, 0, undefined, undefined, undefined,
    { '2121005': { summonAttack: { url: '/fire-attack.mp3' } } });
  fire.spawnDamageNumber = () => {};
  const fireHit = { type: 'damageEvent', targetId: 'mob', serverTick: 1, x: 1, y: 1, damage: 3, attackerId: 'p', segment: 1 };
  fire.receiveDamageEvent({ ...fireHit, eventId: 'fire-1', skillId: 2121005 });
  assert.equal(fireInstances.length, 1, '召喚火魔的周期打击必须出声');
  assert.equal(fireInstances[0].key, '/fire-attack.mp3', '火魔周期打击放的是它自己那本的召唤音');
  fire.receiveDamageEvent({ ...fireHit, eventId: 'fire-2', serverTick: 2, skillId: 2121005 });
  assert.equal(fireInstances.length, 2, '不同的服务端 tick 是另一次周期打击，各自出声');
  fireInstances.length = 0;
  fire.receiveDamageEvent({ ...fireHit, eventId: 'infinity-1', serverTick: 3, skillId: 2121004 });
  assert.equal(fireInstances.length, 0, '非召唤技能不许走召唤周期打击的出声路径');
  fire.clear();
  console.log('PASS: 召喚火魔的周期打击与冰雷召唤同路，非召唤技能仍不出声。');
}
