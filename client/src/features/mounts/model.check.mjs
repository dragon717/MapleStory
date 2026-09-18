#!/usr/bin/env node
// mounts/model.check.mjs — 坐骑客户端的**只读**投影特征测试。
//
// 这里刻意走**真的** `names.ts`（只把 i18n 打桩、把 json 导入换成 data: URL），
// 与 `inventory/view-model.check.mjs` 同一装法。理由是本次最容易悄悄坏掉的一条
// 恰恰在 names 里：坐骑不在 items.json，`equipmentSlot` 必须靠 mount-index 的
// `islot` 回落到 18/19；只测 model.ts 打桩版看不出这个回归。
//
// 断言清单（每条都对着一条"不许编"的边界）：
//   1. 装备槽：`Tm` → 18、`Sd` → 19（与 server/src/inventory.rs::equipment_slot 同源）
//   2. `isMountItem` 看 `tamingMob`，**不看** `islot`：`Sd` 整族（馬鞍）与 21 件
//      现金件都不是坐骑
//   3. 快照缺席 ⇒ 无读数：**不**从「装备里有坐骑」推出「我在骑」
//   4. 读数原样透传 + `mountSpeedLabel` 的百分比口径（100 = 常规）
//   5. 开关目标失败即不给：不一致/槽位不对时返回 undefined，不硬凑一个槽

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const dataUrl = (mime, text) => `data:${mime};base64,${Buffer.from(text).toString('base64')}`;

async function jsonUrl(relative) {
  const text = await readFile(new URL(relative, import.meta.url), 'utf8');
  return { text: JSON.stringify(await JSON.parse(text)), url: dataUrl('application/json', text) };
}

const items = await jsonUrl('../../../../shared/items.json');
const pets = await jsonUrl('../../../../shared/pets.json');
const mountIndex = JSON.parse(await readFile(new URL('../../../../shared/mount-index.json', import.meta.url), 'utf8'));
const chairs = JSON.parse(await readFile(new URL('../../../../shared/chair-names.json', import.meta.url), 'utf8'));

// names.ts：i18n 打桩（视图层关心 zh 文案），四张 json 换成 data: URL 并补上
// Node ESM 要求的 `with { type: 'json' }`。
const namesCode = compile(await readFile(new URL('../inventory/names.ts', import.meta.url), 'utf8'))
  .replace(/import .* from '..\/..\/app\/i18n';/, "const uiLocale = () => 'zh'; const displayText = x => x;")
  .replace(/^import catalog from '.*items\.json';$/m, `import catalog from ${JSON.stringify(items.url)} with { type: 'json' };`)
  .replace(/^import petCatalog from '.*pets\.json';$/m, `import petCatalog from ${JSON.stringify(pets.url)} with { type: 'json' };`)
  .replace(/^import mountIndex from '.*mount-index\.json';$/m, `import mountIndex from ${JSON.stringify(dataUrl('application/json', JSON.stringify(mountIndex)))} with { type: 'json' };`)
  .replace(/^import chairNames from '.*chair-names\.json';$/m, `import chairNames from ${JSON.stringify(dataUrl('application/json', JSON.stringify(chairs)))} with { type: 'json' };`);
assert.equal(
  (namesCode.match(/with \{ type: 'json' \}/g) ?? []).length,
  4,
  'names.ts 的四个 json 导入没有全部替换（导入语句变了？）',
);
const namesUrl = dataUrl('text/javascript', namesCode);

const modelCode = compile(await readFile(new URL('./model.ts', import.meta.url), 'utf8'))
  .replace(/'\.\.\/inventory\/names'/, JSON.stringify(namesUrl));
const model = await import(namesUrl);
const mounts = await import(dataUrl('text/javascript', modelCode));

// --- 1. 装备槽 ------------------------------------------------------------
const tmId = Object.keys(mountIndex).find(id => mountIndex[id].islot === 'Tm');
const sdId = Object.keys(mountIndex).find(id => mountIndex[id].islot === 'Sd');
assert(tmId && sdId, 'mount-index 里找不到 Tm / Sd 两族');
assert.equal(model.equipmentSlot(tmId), 18, `${tmId} 的 islot=Tm 必须解析到 18`);
assert.equal(model.equipmentSlot(sdId), 19, `${sdId} 的 islot=Sd 必须解析到 19`);
assert.deepEqual(mounts.MOUNT_BODY_SLOTS, [18, 19], '骑宠身体槽是 18/19');

// --- 2. isMountItem 看 tamingMob，不看 islot ------------------------------
const rideableId = Object.keys(mountIndex).find(id => mountIndex[id].tamingMob !== undefined);
const noTamingMob = Object.keys(mountIndex).filter(id => mountIndex[id].tamingMob === undefined && mountIndex[id].islot === 'Tm');
assert(rideableId, 'mount-index 里找不到带 tamingMob 的坐骑');
assert(model.isMountItem(rideableId), `${rideableId} 带 tamingMob，应判为坐骑`);
assert(model.isMountItem(sdId) === false, `${sdId} 是 Sd 槽的馬鞍，不带 tamingMob，不是坐骑`);
assert(noTamingMob.length > 0 && noTamingMob.every(id => model.isMountItem(id) === false), 'Tm 槽里不带 tamingMob 的现金件不是坐骑');
assert(model.isMountItem('1302000') === false, '普通装备不是坐骑');
assert(model.isMountItem('1912000') === false, '1912000（馬鞍）不带 tamingMob');

// --- 3. 快照缺席 ⇒ 无读数（不从 equipped 推导） ----------------------------
assert.equal(mounts.mountReadout(undefined), undefined);
assert.equal(mounts.mountReadout({}), undefined);
const equippedOnly = { equipped: [{ slot: 18, itemId: rideableId, quantity: 1 }] };
assert.equal(mounts.mountReadout(equippedOnly), undefined,
  '装备里有坐骑 ≠ 在骑：mountReadout 只看 player.mount');

// --- 4. 读数原样透传 + 百分比口径 -----------------------------------------
const state = {
  mount: { itemId: rideableId, tamingMob: 1, speed: 150, jump: 120, fs: 10, fatigue: 5 },
};
const readout = mounts.mountReadout(state);
assert.equal(readout.itemId, rideableId);
assert.deepEqual(
  [readout.tamingMob, readout.speed, readout.jump, readout.fs, readout.fatigue],
  [1, 150, 120, 10, 5],
  '读数必须原样透传，不换算成像素/秒',
);
assert.equal(mounts.mountSpeedLabel({ ...readout, speed: 100 }), '100%', '100 = 常规速度，不带增量');
assert.equal(mounts.mountSpeedLabel({ ...readout, speed: 150 }), '150% (+50)');
assert.equal(mounts.mountSpeedLabel({ ...readout, speed: 80 }), '80% (-20)');

// --- 5. 开关目标：失败即不给 ---------------------------------------------
assert.equal(mounts.mountToggleTarget(undefined), undefined);
assert.equal(mounts.mountToggleTarget({}), undefined, '装备里没有带 tamingMob 的行 ⇒ 不给开关');
assert.equal(
  mounts.mountToggleTarget({ equipped: [{ slot: 18, itemId: '1912000', quantity: 1 }] }),
  undefined,
  '馬鞍在 18 槽上也不算可骑坐骑',
);
assert.deepEqual(
  mounts.mountToggleTarget({ equipped: [{ slot: 18, itemId: rideableId, quantity: 1 }] }),
  { itemId: rideableId, slot: 18, riding: false },
  '装备着但没骑：目标槽取权威装备行',
);
assert.deepEqual(
  mounts.mountToggleTarget({ equipped: [{ slot: -18, itemId: rideableId, quantity: 1 }] }),
  { itemId: rideableId, slot: 18, riding: false },
  '权威装备行的槽号符号不影响判定（取绝对值）',
);
assert.deepEqual(
  mounts.mountToggleTarget({ ...state, equipped: [{ slot: 18, itemId: rideableId, quantity: 1 }] }),
  { itemId: rideableId, slot: 18, riding: true },
);
assert.equal(
  mounts.mountToggleTarget({ ...state, equipped: [{ slot: 5, itemId: rideableId, quantity: 1 }] }),
  undefined,
  '快照说在骑但权威行不在 18/19 槽 ⇒ 不发请求（宁可不切也不硬凑槽位）',
);
assert.equal(mounts.mountToggleTarget({ ...state }), undefined, '快照说在骑但 equipped 里找不到那一行 ⇒ 不发请求');

console.log('Mounts projection: slot vocabulary, tamingMob gate, no-derivation and fail-closed toggle passed.');
