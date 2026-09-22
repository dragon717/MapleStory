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
// 技能特效按需装载（`assets/lazy-texture.ts`）。本检查用假 scene，没有 Phaser
// 装载器，所以与 frameAt/assetFrameAlpha 一样按全局桩注入；同时记下请求过的
// URL，用反向断言钉住「特效不许回到首屏预装载」这条接线。
const ensureRequests = [];
globalThis.ensureTextures = (_scene, urls) => { ensureRequests.push(...urls); return true; };
const stripped = outputText.replace(/^import .*;\r?\n/gm, '');
const { CombatView } = await import(`data:text/javascript;base64,${Buffer.from(stripped).toString('base64')}`);

let now = 100;
const sprites = [];
/** 「纹理就绪」的假缓存：默认全都有，需要模拟「还在路上」的用例把它关掉。 */
const ready = new Set();
let everyTextureReady = true;
const scene = {
  // 战斗表现的每一张贴图都必须在建对象**之前**确认 key 在纹理缓存里
  // （见 `view.ts::spriteFor`）。假 scene 的两个档位都用到：
  //   * `ready` 里有的 URL ⇒ 照常建贴图、照常画（下面绝大多数用例）；
  //   * 不在 `ready` 里的 ⇒ **一张都不许建**，否则就是 Phaser 的 `__MISSING`
  //     绿黑格子（「魔灵弹首次释放」那个异常）。
  textures: { exists: url => everyTextureReady || ready.has(url) },
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
assert.equal(view.skillVisuals.length, 1, 'duplicate skillCast events create one VFX');
view.update(now);
assert.equal(sprites.length, 1, 'the frame after the cast builds exactly one source sprite');
assert.equal(sprites[0].visible, true, 'duration zero still starts the source VFX');
assert.ok(ensureRequests.includes('/skill.png'), `技能特效必须走按需装载：${JSON.stringify(ensureRequests)}`);
now += 20;
view.update(now);
assert.equal(sprites[0].destroyed, true, 'source frame timing controls VFX lifetime');
view.receiveSkillCast({ ...event, eventId: 'clear-me' });
view.update(now);
assert.equal(sprites.length, 2, 'the second cast builds its sprite on the following frame');
view.clear();
assert.equal(sprites[1].destroyed, true, 'clear destroys pending skill VFX');
console.log('PASS: zero-duration skill VFX, event deduplication, source timing, and clear.');

// ---- 首帧不许把不存在的 key 交给 Phaser（「魔灵弹绿黑格子」的根因）----------
//
// `add.image` / `setTexture` 拿到一个不在纹理缓存里的 key 会落到 Phaser 的
// `__MISSING` 占位图 —— 那正是首次释放必现的绿黑框。判据两条：
//   ① 纹理没就绪时**一个贴图都不许建**；
//   ② 但这次施法**不许被丢掉** —— 纹理落地后的下一帧补建，且只建一个。
// 第 ② 条就是「整段不画」这种省事修法的反面：晚到的是贴图，不是事件。
{
  const pending = new Set();
  const lazySprites = [];
  const lazyScene = {
    textures: { exists: url => pending.has(url) },
    add: { image: (_x, _y, key) => {
      const sprite = {
        visible: false, destroyed: false, texture: key,
        setOrigin() { return this; }, setDepth() { return this; },
        setVisible(value) { this.visible = value; return this; },
        setTexture(value) { this.texture = value; return this; },
        setAlpha() { return this; }, setPosition() { return this; }, setFlipX() { return this; },
        destroy() { this.destroyed = true; },
      };
      lazySprites.push(sprite);
      return sprite;
    } },
  };
  // 魔灵弹（2001008）走的是 `ball` 那条投掷分支，即「首次释放」的形状。
  const lazily = new CombatView(lazyScene, undefined, 0, () => now, 'combat-hit', { '2001008': { ball: frames } });
  const bolt = { ...event, eventId: 'bolt', skillId: 2001008, targetX: 60, targetY: 40 };
  assert.equal(lazily.receiveSkillCast(bolt), true);
  lazily.update(now);
  assert.equal(lazySprites.length, 0, '纹理没就绪时不许建贴图（否则会渲染 Phaser 的 __MISSING 绿黑格子）');
  assert.equal(lazily.skillVisuals.length, 1, '纹理晚到不许把这次施法整段吞掉');
  pending.add('/skill.png');
  lazily.update(now);
  assert.equal(lazySprites.length, 1, '纹理落地后的下一帧补建一张贴图');
  assert.equal(lazySprites[0].texture, '/skill.png', '补建的贴图贴的是源帧 URL');
  assert.equal(lazySprites[0].visible, true, '补建的贴图当场可见');
  lazily.update(now + 10);
  assert.equal(lazySprites.length, 1, '补建之后复用同一张贴图，不再多建');
  assert.equal(lazySprites[0].destroyed, false, '补建之后沿同一张时间轴继续播（不是重播一次）');
  lazily.clear();
  assert(lazySprites[0].destroyed, 'clear 收掉补建的贴图');
  console.log('PASS: 首帧纹理未就绪不建贴图，纹理落地后补建且不丢这次施法。');
}

const tile = { ...frames[0], width: 20, source: 'Skill/220.img/skill/2201009/tile/1/0' };
const fieldView = new CombatView(scene, undefined, 0, () => now, 'combat-hit', { '2201009': { tile: [tile] } });
const firstTile = sprites.length;
const fieldEvent = { ...event, skillId: 2201009, eventId: 'field', targetX: 44, targetY: 8, durationMs: 6000 };
fieldView.receiveSkillCast(fieldEvent);
fieldView.receiveSkillCast(fieldEvent);
assert.equal(fieldView.skillVisuals.length, 3, 'one authoritative segment is tiled once');
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
sphereView.update(now);
assert(!sprites.at(-1).destroyed, 'expiry summon has a live sprite before its deadline');
now += 1000; sphereView.update(now);
assert(sprites.at(-1).destroyed, 'sphere expires without another snapshot');
sphereView.syncSummons([{ ...sphere, id: 'disconnect' }]);
sphereView.update(now);
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
