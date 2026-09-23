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
// `receiveDamageEvent` 的第一道闸门就是 `damageNumberLayers`（`combat/view.ts:197`）。
// 与 `sound.check.mjs` 一样按源规则给个非空桩，否则本检查里任何一次受击事件都会
// 直接 `ReferenceError`（本文件直到 2026-09-23 才第一次用受击事件，所以此前没暴露）。
globalThis.damageNumberLayers = (damage, mpDamage = 0) => [
  ...(Number.isFinite(damage) && damage > 0 ? [{ kind: 'damage', value: damage, offsetY: 0 }] : []),
  ...(Number.isFinite(mpDamage) && mpDamage > 0 ? [{ kind: 'mp', value: mpDamage, offsetY: damage > 0 ? 20 : 0 }] : []),
];
// `view.ts` 的 import 被整段剥掉，所以它从 `player/input.ts` 取的那三张镜像名单也成了
// 未定义全局。这里**不是手抄一份桩**：把 `player/input.ts` 按同一套「转译 + 剥 import」
// 求值，注入它的**真值**——手抄的桩会在名单改动时静默说谎，而这正是本检查要防的事。
{
  const inputSource = await readFile(new URL('../player/input.ts', import.meta.url), 'utf8');
  const { outputText: inputOutput } = ts.transpileModule(inputSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  const inputModule = await import(`data:text/javascript;base64,${Buffer.from(inputOutput.replace(/^import .*;\r?\n/gm, '')).toString('base64')}`);
  for (const name of ['INFINITY_SKILLS', 'DEMON_SUMMON_SKILLS', 'CASTER_ANCHORED_BUFFS', 'HYPER_ADVENTURER_SKILLS']) {
    assert.ok(Array.isArray(inputModule[name]) && inputModule[name].length > 0, `player/input.ts 必须导出非空的 ${name}`);
    globalThis[name] = inputModule[name];
  }
}
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

// ---- 火毒／主教四转「同一格副本」的表现接线（2026-09-23）------------------------
//
// 服务端把三条分支的同名技能合进一张表（`world.rs` 的 `INFINITY_SKILLS` /
// `MAPLE_CURE_SKILLS` / `MAPLE_WARRIOR_SKILLS` / `DEMON_SUMMON_SKILLS`），
// `player/input.ts` 是同一份名单的客户端镜像。改前这三处写死 `222xxxx`：
// 火毒／主教玩家放同一格技能时**完全没有表现**——無限没有持续特效、召喚火魔的
// 周期打击不切攻击帧、枫葉祝福不跟随施法者。下面逐条钉住，并各配一条反向断言，
// 免得「把名单改宽」也能骗过检查。
{
  const sibling = new CombatView(scene, undefined, 0, () => now, 'combat-hit', {
    '2221004': { special: frames }, '2121004': { special: frames }, '2321004': { special: frames },
  });
  for (const book of [2221004, 2121004, 2321004]) {
    sibling.clear();
    sibling.syncPlayers([{ id: 'infinity', hp: 10, x: 3, y: 4, facing: 1, derivedStats: { skillBuffs: { [String(book)]: 5000 }, infinityEnhanced: true } }]);
    assert.equal(sibling.skillVisuals.length, 1, `無限 ${book} 的持续特效没立起来`);
    assert.equal(sibling.skillVisuals[0].event.skillId, book, `無限立起来的不是 ${book} 自己那本`);
  }
  // 反向：判据仍是「有增益 **且** `infinityEnhanced`」，不是「名字里有無限」。
  sibling.clear();
  sibling.syncPlayers([{ id: 'infinity', hp: 10, x: 3, y: 4, facing: 1, derivedStats: { skillBuffs: { '2121004': 5000 } } }]);
  assert.equal(sibling.skillVisuals.length, 0, '没有 infinityEnhanced 就不该有無限持续特效');
  sibling.clear();
  console.log('PASS: 無限三本副本各自立起持续特效，且仍受 infinityEnhanced 约束。');
}

{
  const demon = new CombatView(scene, undefined, 0, () => now, 'combat-hit', {
    '2121005': { summonStand: frames, summonAttack: frames },
  });
  // 只留「周期打击切帧」这一条判据，受击的数字与命中特效不在本检查范围内。
  demon.spawnDamageNumber = () => {};
  demon.spawnSkillHit = () => {};
  demon.syncSummons([{ id: 'demon', playerId: 'p', skillId: 2121005, x: 10, y: 10, facing: 1, expiresInMs: 5000, stationary: true }]);
  const demonState = demon.summons.get('demon');
  assert.ok(demonState, '召喚火魔必须按快照建出召唤物');
  assert.equal(demonState.attackAt, undefined, '未受击前不该是攻击帧');
  demon.receiveDamageEvent({ type: 'damageEvent', eventId: 'fire-1', targetId: 'mob', serverTick: 1, x: 10, y: 10, damage: 1, attackerId: 'p', skillId: 2121005, segment: 1 });
  assert.equal(typeof demonState.attackAt, 'number', '召喚火魔的周期打击必须切到 summonAttack 帧');
  demon.clear();
  console.log('PASS: 召喚火魔的周期打击与冰魔同路（该名单里不再只有冰雷那两件）。');
}

{
  // 施法者锚定：贴图落点会随 `owner` 有无而变（`combat/view.ts:604` 的名单决定 owner），
  // 所以用一个记录 `setPosition` 的假 scene 直接读出落点，而不是只看「有没有建贴图」。
  const anchoredPositions = [];
  const anchorScene = {
    textures: { exists: () => true },
    add: { image: () => ({
      setOrigin() { return this; }, setDepth() { return this; }, setVisible() { return this; },
      setTexture() { return this; }, setAlpha() { return this; }, setFlipX() { return this; },
      setPosition(x, y) { anchoredPositions.push([x, y]); return this; }, destroy() {},
    }) },
  };
  // 2121000 是枫葉祝福的火毒副本（在名单里）；2201001 精神強化是同样只有 `effect` 组、
  // 但**不在**名单里的对照。帧宽 1、`frame.x = 0`，所以 facing=1 时 left = base.x - 1。
  for (const [skillId, expected] of [[2121000, [99, 200]], [2201001, [6, 8]]]) {
    const anchored = new CombatView(anchorScene, undefined, 0, () => now, 'combat-hit', {
      [String(skillId)]: { effect: frames },
    });
    anchored.syncPlayers([{ id: 'caster', hp: 10, x: 100, y: 200, facing: 1, derivedStats: {} }]);
    anchored.receiveSkillCast({ type: 'skillCast', eventId: `cast-${skillId}`, requestId: '', playerId: 'caster', skillId, serverTick: 1, x: 7, y: 8, facing: 1, durationMs: 0 });
    anchoredPositions.length = 0;
    anchored.update(now);
    assert.deepEqual(anchoredPositions.at(-1), expected, `技能 ${skillId} 的贴图落点不对`);
    anchored.clear();
  }
  console.log('PASS: 枫葉祝福副本锚在施法者身上，不在名单里的技能仍用事件坐标。');
}
