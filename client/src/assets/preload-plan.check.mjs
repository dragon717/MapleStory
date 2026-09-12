#!/usr/bin/env node
// preload-plan.check.mjs — 预加载计划纯函数检查（计划 §10.3）。
// 钉扎：图片保序去重（key===url）、音频原顺序（升级→技能→BGM→普攻→受击→怪物）、
// BGM 的 skipIfCached 标记（cache 短路仍在 Scene）。manifest 只需本检查用到的字段。

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const code = ts.transpileModule(await readFile(new URL('./preload-plan.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { buildPreloadPlan } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

const manifest = {
  map: {
    id: 'map1',
    bgm: 'bgm-shared.mp3',
    layers: [
      { url: 'layer-a.png' },
      { url: 'layer-b.png', frames: [{ url: 'layer-b-0.png' }, { url: 'layer-a.png' }] },
    ],
    portals: [],
  },
  mapCatalog: {
    maps: [
      { id: 'map2', bgm: 'bgm-shared.mp3', layers: [{ url: 'layer-c.png' }], portals: [] },
      { id: 'map3', bgm: 'bgm-sleepy.mp3', layers: [], portals: [] },
    ],
  },
  avatar: { actions: { walk: [{ parts: [{ url: 'body-walk.png' }] }] }, equipmentLoadouts: { cap: { actions: { walk: [{ parts: [{ url: 'cap-walk.png' }] }] } } }, attackSound: 'attack.mp3' },
  monsters: { 8140000: { templateId: '8140000', actions: { stand: [{ url: 'mob-stand.png' }] }, damageSound: { url: 'mob-hit-8140000.mp3' } } },
  items: { 2000000: { url: 'potion.png' } },
  worldMap: { ui: { nav: {}, close: {} }, pages: {} },
  combat: { hit: { sound: 'combat-hit.mp3' }, attack: { afterimage: { frames: [{ url: 'afterimage.png' }] } }, damageNumbers: {} },
  skillEffects: { 1000: { attack: [{ url: 'skill-fx.png' }] } },
  skillSounds: { 1000: { use: { url: 'skill-use.mp3' }, hit: { url: 'skill-hit.mp3' } } },
  levelUp: { sound: { url: 'levelup.mp3' } },
};

const plan = buildPreloadPlan(manifest);

// 图片：保序、去重（layer-a 出现两次只保留首次）。
const urls = plan.images.map(entry => entry.url);
assert.equal(urls[0], 'layer-a.png');
assert.equal(urls[1], 'layer-b.png');
assert.equal(urls.filter(url => url === 'layer-a.png').length, 1, '重复 url 只入队一次');
for (const expected of ['layer-c.png', 'body-walk.png', 'cap-walk.png', 'mob-stand.png', 'potion.png', 'afterimage.png', 'skill-fx.png']) {
  assert.ok(urls.includes(expected), `缺少 ${expected}`);
}
for (const entry of plan.images) assert.equal(entry.key, entry.url, 'key 与 url 相同（与原实现一致）');

// 音频：原顺序，BGM 去重并带 skipIfCached。
assert.deepEqual(plan.audio.map(entry => entry.key), [
  'levelup.mp3',
  'skill-use.mp3',
  'skill-hit.mp3',
  'bgm-shared.mp3',
  'bgm-sleepy.mp3',
  'attack',
  'combat-hit',
  'mob-hit-8140000',
]);
const bgm = plan.audio.filter(entry => entry.skipIfCached);
assert.deepEqual(bgm.map(entry => entry.url), ['bgm-shared.mp3', 'bgm-sleepy.mp3'], 'BGM 跨地图去重');
assert.ok(plan.audio.every(entry => !entry.skipIfCached || entry.url.includes('bgm')), 'skipIfCached 只标在 BGM 上');

console.log('assets preload-plan: order-preserving dedup images, ordered audio with bgm cache-flag passed.');
