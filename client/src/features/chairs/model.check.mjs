#!/usr/bin/env node
// chairs/model.check.mjs — 坐姿客户端的**只读**投影特征测试。
//
// 与 mounts/model.check.mjs 同一装法：走真的 `names.ts`（i18n 打桩、json 换 data: URL），
// 因此「椅子名字回落」这条也在这里被钉住。
//
// 断言清单（每条对着一条"不许编"的边界）：
//   1. 快照缺席 ⇒ 无读数（不从设置栏里有一个椅子推出"我坐着"）
//   2. `recoveryIntervalMs` 缺席 ⇒ `secondsToRecovery === undefined`，**不套默认 10 秒**
//   3. 已核定的那一种：间隔与倒计时各自成整数秒，且 0 是"还剩 0 秒"而不是"没有"
//   4. 恢复量原样透传、不做百分比换算；两样都为 0 时不显示恢复串
//   5. 名字来自 `chair-names.json`（椅子不在 items.json 里）

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const dataUrl = (mime, text) => `data:${mime};base64,${Buffer.from(text).toString('base64')}`;

const jsonText = async relative => readFile(new URL(relative, import.meta.url), 'utf8');
const itemsText = await jsonText('../../../../shared/items.json');
const itemsUrl = dataUrl('application/json', itemsText);
const items = JSON.parse(itemsText);
const petsUrl = dataUrl('application/json', await jsonText('../../../../shared/pets.json'));
const mountIndexUrl = dataUrl('application/json', await jsonText('../../../../shared/mount-index.json'));
const chairText = await jsonText('../../../../shared/chair-names.json');
const chairNames = JSON.parse(chairText);

const namesCode = compile(await readFile(new URL('../inventory/names.ts', import.meta.url), 'utf8'))
  .replace(/import .* from '..\/..\/app\/i18n';/, "const uiLocale = () => 'zh'; const displayText = x => x;")
  .replace(/^import catalog from '.*items\.json';$/m, `import catalog from ${JSON.stringify(itemsUrl)} with { type: 'json' };`)
  .replace(/^import petCatalog from '.*pets\.json';$/m, `import petCatalog from ${JSON.stringify(petsUrl)} with { type: 'json' };`)
  .replace(/^import mountIndex from '.*mount-index\.json';$/m, `import mountIndex from ${JSON.stringify(mountIndexUrl)} with { type: 'json' };`)
  .replace(/^import chairNames from '.*chair-names\.json';$/m, `import chairNames from ${JSON.stringify(dataUrl('application/json', chairText))} with { type: 'json' };`);
assert.equal(
  (namesCode.match(/with \{ type: 'json' \}/g) ?? []).length,
  4,
  'names.ts 的四个 json 导入没有全部替换（导入语句变了？）',
);

const modelCode = compile(await readFile(new URL('./model.ts', import.meta.url), 'utf8'))
  .replace(/'\.\.\/inventory\/names'/, JSON.stringify(dataUrl('text/javascript', namesCode)));
const chairs = await import(dataUrl('text/javascript', modelCode));

// 两把椅子各自证明一件事：
// * `3010001` 同时在 items.json 与 chairs.json 里 ⇒ 两张表必须给出**同一个**名字
//   （跨表不打架，门禁 §6.2-4 的同一条判据）。
// * 只在 chairs.json 里、不在 items.json 里的那一把 ⇒ 名字回落链必须走到
//   `chair-names.json`，而不是回落成裸 id。
const BOTH_TABLE_CHAIR = '3010001';
const fallbackChairId = Object.keys(chairNames).find(id => !Object.prototype.hasOwnProperty.call(items, id));
assert(chairNames[BOTH_TABLE_CHAIR], `chair-names 里没有 ${BOTH_TABLE_CHAIR}`);
assert(items[BOTH_TABLE_CHAIR], `${BOTH_TABLE_CHAIR} 应同时在 items.json 里（跨表一致性由它来证）`);
assert(fallbackChairId, 'chairs 里找不到不在 items.json 的椅子，回落链这条就白测了');
// 下面所有"间隔/恢复量"的用例都拿 `3010001`（源默认那把「藍色木椅」）。
const chairId = BOTH_TABLE_CHAIR;

// --- 1. 快照缺席 ⇒ 无读数 --------------------------------------------------
assert.equal(chairs.chairReadout(undefined), undefined);
assert.equal(chairs.chairReadout({}), undefined,
  '设置栏里有椅子 ≠ 坐着：chairReadout 只看 player.chair');

// --- 2. 间隔未核定 ⇒ 不给倒计时，也不套默认值 ------------------------------
const unverified = { chair: { itemId: chairId, recoveryHp: 35, recoveryMp: 0 } };
const unverifiedReadout = chairs.chairReadout(unverified);
assert.equal(unverifiedReadout.secondsToRecovery, undefined, '间隔未核定 ⇒ secondsToRecovery 必须是 undefined，不是 0/10');
assert.equal(unverifiedReadout.intervalSeconds, undefined);
assert.equal(chairs.chairIntervalVerified(unverifiedReadout), false);
assert.equal(unverifiedReadout.recoveryHp, 35, '恢复量照旧显示：能坐，只是不恢复');

// --- 3. 已核定：整数秒，0 是"还剩 0 秒" ------------------------------------
const verified = chairs.chairReadout({
  chair: { itemId: chairId, recoveryHp: 35, recoveryMp: 0, recoveryIntervalMs: 10000, nextRecoveryInMs: 7300 },
});
assert.equal(verified.intervalSeconds, 10, '源文案写「每10秒」⇒ 10 秒');
assert.equal(verified.secondsToRecovery, 8, '7300ms 向上取整为 8 秒');
assert.equal(chairs.chairIntervalVerified(verified), true);
assert.equal(
  chairs.chairReadout({ chair: { itemId: chairId, recoveryHp: 1, recoveryMp: 0, recoveryIntervalMs: 10000, nextRecoveryInMs: 0 } }).secondsToRecovery,
  0,
  '刚好到点时是"还剩 0 秒"，仍是已核定（不能与 undefined 混为一谈）',
);

// --- 4. 恢复量原样透传 -----------------------------------------------------
assert.equal(chairs.chairRecoveryLabel(verified), 'HP +35', 'MP 为 0 时不占位');
assert.equal(
  chairs.chairRecoveryLabel({ ...verified, recoveryHp: 10, recoveryMp: 5 }),
  'HP +10 · MP +5',
);
assert.equal(
  chairs.chairRecoveryLabel({ ...verified, recoveryHp: 0, recoveryMp: 0 }),
  undefined,
  '两样都是 0 ⇒ 没有恢复量可显示',
);

// --- 5. 名字：跨表一致 + 回落链 -------------------------------------------
assert.equal(verified.name, chairNames[chairId], '椅子名必须来自源 String/Ins.json 的索引');
assert.equal(verified.name, items[chairId].name, '同一把椅子在 items.json 与 chairs.json 里必须同名');
assert.notEqual(verified.name, chairId, '椅子名不能回落成 id');
const fallbackReadout = chairs.chairReadout({ chair: { itemId: fallbackChairId, recoveryHp: 0, recoveryMp: 0 } });
assert.equal(fallbackReadout.name, chairNames[fallbackChairId], '不在 items.json 的椅子必须回落到 chair-names.json');
assert.notEqual(fallbackReadout.name, fallbackChairId, '回落链不能停在裸 id 上');

console.log('Chairs projection: no-derivation, unverified-interval honesty and recovery labels passed.');
