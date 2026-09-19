#!/usr/bin/env node
// preload-plan.check.mjs — 首屏预加载计划纯函数检查（计划 §10.3）。
//
// 2026-09-18 起策略从「全量预加载」改成「首屏必需集」，所以本检查**双向**钉扎：
//   正向：当前地图 / 本角色 / 战斗与界面 必须在首屏（少一个就是画错）；
//   反向：按需类别（别的地图、怪物、NPC、宠物、物品、表情）**一个都不许**进首屏，
//         并且 `DEFERRED_CATEGORIES` 这张表要与这里的清单一一对应——删掉某类的
//         按需装载却忘了改表，或者往表里加类别却没加断言，都要失败。
// 音频仍钉扎原顺序与 BGM 的 skipIfCached 标记（cache 短路仍在 Scene）。
//
// 2026-09-18 的度量背景（为什么敢这么裁）：「开始游戏 → 100%」26.1s / 22,594 张，
// 其中当前地图只有 92 张，宠物 7,850、其余地图 4,461、表情 3,727、物品 2,454。

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const code = ts.transpileModule(await readFile(new URL('./preload-plan.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { buildPreloadPlan, DEFERRED_CATEGORIES } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

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
  npcs: { 9000000: { name: 'npc', source: 'Npc.wz/9000000.img', stand: [{ url: 'npc-stand.png' }] } },
  pets: { 5000000: { name: 'pet', icon: { url: 'pet-icon.png' }, stand: [{ url: 'pet-stand.png' }], move: [], jump: [] } },
  emoticon: {
    ui: { frame: { url: 'emo-ui.png' } },
    groups: [{ icon: { url: 'emo-group.png' } }],
    stickers: [{ id: '1', icon: { url: 'emo-icon.png' }, frames: [{ url: 'emo-frame.png' }] }],
  },
  worldMap: { ui: { nav: {}, close: {} }, pages: {} },
  combat: {
    hit: { sound: 'combat-hit.mp3' },
    attack: { afterimage: { frames: [{ url: 'afterimage.png' }] } },
    damageNumbers: {
      normal: { first: { 0: { url: 'dmg-red-0.png' } }, rest: {} },
      critical: { first: { 0: { url: 'dmg-crit-0.png' } }, rest: {} },
      recoverHp: { first: { 0: { url: 'dmg-green-0.png' } }, rest: {} },
      recoverMp: { first: { 0: { url: 'dmg-blue-0.png' } }, rest: {} },
    },
  },
  skillEffects: { 1000: { attack: [{ url: 'skill-fx.png' }] } },
  skillSounds: { 1000: { use: { url: 'skill-use.mp3' }, hit: { url: 'skill-hit.mp3' } } },
  levelUp: { sound: { url: 'levelup.mp3' } },
};

const plan = buildPreloadPlan(manifest);
const urls = plan.images.map(entry => entry.url);

// ── 正向：首屏必需集 ────────────────────────────────────────────────────────
// 图片：保序、去重（layer-a 出现两次只保留首次）。
assert.equal(urls[0], 'layer-a.png');
assert.equal(urls[1], 'layer-b.png');
assert.equal(urls.filter(url => url === 'layer-a.png').length, 1, '重复 url 只入队一次');
for (const expected of ['layer-b-0.png', 'body-walk.png', 'cap-walk.png', 'afterimage.png']) {
  assert.ok(urls.includes(expected), `首屏缺少 ${expected}`);
}
// 四套数字集**全部**进首屏（含绿/蓝）：跳字是「事件那一帧就要画」的表现，蓝字
// （魔心扣魔/回魔）与绿字（回血）漏进预加载 = 线上永远画不出来、离线检查全绿
// ——2026-09-19 魔心防禦扣魔不跳字的实锤根因，这里双向钉死。
for (const expected of ['dmg-red-0.png', 'dmg-crit-0.png', 'dmg-green-0.png', 'dmg-blue-0.png']) {
  assert.ok(urls.includes(expected), `数字集必须整本进首屏：缺少 ${expected}`);
}
assert.ok(!urls.includes('layer-c.png'), '其余地图不得进首屏（切图时 scene.restart 会重新 preload）');
for (const entry of plan.images) assert.equal(entry.key, entry.url, 'key 与 url 相同（与原实现一致）');

// ── 反向：按需类别一个都不许进首屏，且必须登记在 DEFERRED_CATEGORIES ─────────
const deferred = {
  'mapCatalog.maps': 'layer-c.png',
  skillEffects: 'skill-fx.png',
  pets: 'pet-stand.png',
  monsters: 'mob-stand.png',
  npcs: 'npc-stand.png',
  items: 'potion.png',
  emoticon: 'emo-frame.png',
};
for (const [category, url] of Object.entries(deferred)) {
  assert.ok(!urls.includes(url), `${category} 必须按需装载（lazy-texture），不得进首屏（${url}）`);
  assert.ok(
    DEFERRED_CATEGORIES.some(entry => entry.startsWith(category)),
    `DEFERRED_CATEGORIES 缺少 ${category}：改了按需装载就必须同步这张表`,
  );
}
assert.equal(
  DEFERRED_CATEGORIES.length,
  Object.keys(deferred).length,
  'DEFERRED_CATEGORIES 与本检查的按需清单必须一一对应（加/删类别两处一起改）',
);

// ── 音频：原顺序，BGM 去重并带 skipIfCached，且只装载当前地图的 BGM ─────────
assert.deepEqual(plan.audio.map(entry => entry.key), [
  'levelup.mp3',
  'skill-use.mp3',
  'skill-hit.mp3',
  'bgm-shared.mp3',
  'attack',
  'combat-hit',
  'mob-hit-8140000',
]);
const bgm = plan.audio.filter(entry => entry.skipIfCached);
assert.deepEqual(bgm.map(entry => entry.url), ['bgm-shared.mp3'], '只装载当前地图的 BGM（其余地图切图时再取）');
assert.ok(plan.audio.every(entry => !entry.skipIfCached || entry.url.includes('bgm')), 'skipIfCached 只标在 BGM 上');

console.log('assets preload-plan: 首屏必需集（当前地图/角色/战斗/界面）+ 按需类别双向断言 + 音频顺序 通过。');
