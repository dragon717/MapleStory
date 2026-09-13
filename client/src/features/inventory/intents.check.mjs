#!/usr/bin/env node
// intents.check.mjs — InventoryIntents 意图构造与请求生命周期检查（R11 第二批）。
// 覆盖：requestId 格式、move/drop/gather-sort/use/mesos 五类消息形状与 inventoryType
// 映射钉扎、practice 门控、prompt 取消/无效数量、pending 操作互斥、卷轴目标模式
// 翻转回调、use 结果消费一次性、resetPending 语义。
// 真值经 InventoryIntentHost 回调注入；names/view-model/i18n/items.json 经 data URL 装载。

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const b64 = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;

// ---- 依赖装载：i18n → items.json → names → view-model → intents ----
globalThis.window = { location: { search: '' }, prompt: () => null };
const i18nCode = compile(await readFile(new URL('../../app/i18n.ts', import.meta.url), 'utf8'))
  .replace("import OpenCC from 'opencc-js/t2cn';", 'const OpenCC = { Converter: () => text => text };');
const i18nUrl = b64(i18nCode);
const itemsUrl = `data:application/json;base64,${Buffer.from(await readFile(new URL('../../../../shared/items.json', import.meta.url), 'utf8')).toString('base64')}`;
const petsUrl = `data:application/json;base64,${Buffer.from(await readFile(new URL('../../../../shared/pets.json', import.meta.url), 'utf8')).toString('base64')}`;
const namesCode = compile(await readFile(new URL('./names.ts', import.meta.url), 'utf8'))
  .replaceAll("from '../../app/i18n'", `from '${i18nUrl}'`)
  .replaceAll("from '../../../../shared/items.json'", `from '${itemsUrl}' with { type: 'json' }`)
  .replaceAll("from '../../../../shared/pets.json'", `from '${petsUrl}' with { type: 'json' }`);
const namesUrl = b64(namesCode);
const viewModelCode = compile(await readFile(new URL('./view-model.ts', import.meta.url), 'utf8'))
  .replaceAll("from './names'", `from '${namesUrl}'`);
const viewModelUrl = b64(viewModelCode);
const intentsCode = compile(await readFile(new URL('./intents.ts', import.meta.url), 'utf8'))
  .replaceAll("from './names'", `from '${namesUrl}'`)
  .replaceAll("from './view-model'", `from '${viewModelUrl}'`);
const { InventoryIntents } = await import(b64(intentsCode));

// ---- 宿主 stub：真值注入 + 发送/状态记录 ----
const state = {
  practice: false,
  selectedTab: 0,
  mesos: 1000,
  inventory: new Map(), // `${tab}:${slot}` -> item
  slotLimits: { 0: 24, 1: 24, 2: 24, 3: 24, 4: 24 },
  promptAnswer: null,
  sendOk: true,
};
const sent = [];
const statuses = [];
const targetModes = [];
const host = {
  status: message => statuses.push(message),
  t: (zh, _en) => zh,
  itemAt: (slot, tab) => state.inventory.get(`${tab}:${slot}`),
  slotLimit: tab => state.slotLimits[tab] ?? 24,
  itemLabel: item => `label:${item.itemId}`,
  practice: () => state.practice,
  selectedTab: () => state.selectedTab,
  mesos: () => state.mesos,
  onTargetModeChange: selecting => targetModes.push(selecting),
};
const send = message => {
  if (!state.sendOk) return false;
  sent.push(message);
  return true;
};
const item = (slot, itemId, quantity = 1) => ({ slot, itemId, quantity });
const controller = new InventoryIntents(send, host);
const lastStatus = () => statuses[statuses.length - 1];
window.prompt = () => state.promptAnswer;

// ---- requestId：前缀 + 64 字符上限 ----
const id1 = controller.moveSlot(0, 0, 1); // 无物品：不应发送
assert.equal(sent.length, 0, '空槽移动不发送');
controller.resetPending();
state.inventory.set('0:1', item(1, '2000000', 3));
controller.moveSlot(0, 1, 5);
assert.equal(sent.length, 1, '有效移动已发送');
assert.equal(sent[0].type, 'inventoryMove');
assert.equal(sent[0].inventoryType, 1, '页签 0 → inventoryType 1（映射钉扎）');
assert.ok(sent[0].requestId.startsWith('move-'), 'requestId 带前缀');
assert.ok(sent[0].requestId.length <= 64, 'requestId ≤64');

// moveSlot：越界目标 / 失败 send / 状态文案
controller.moveSlot(0, 1, 0);
controller.moveSlot(0, 1, 25);
assert.equal(sent.length, 1, '越界目标不发送');
state.sendOk = false;
controller.moveSlot(0, 1, 5);
assert.equal(lastStatus(), '物品栏操作需要保持在线。', '离线状态提示');
state.sendOk = true;
state.inventory.set('1:2', item(2, '1302000'));
controller.moveSlot(1, 2, 3);
assert.equal(sent.at(-1).inventoryType, 2, '页签 1 → inventoryType 2');

// dropSlot：practice 门控 + prompt 流
const sentBeforeDrop = sent.length;
state.practice = true;
controller.dropSlot(0, 1);
assert.equal(lastStatus(), '请退出练习后再丢弃物品。', '练习中禁止丢弃');
assert.equal(sent.length, sentBeforeDrop, '练习门控不发消息');
state.practice = false;
state.inventory.set('0:3', item(3, '2000001', 7));
state.promptAnswer = null;
controller.dropSlot(0, 3);
assert.equal(sent.length, sentBeforeDrop, 'prompt 取消不发送');
state.promptAnswer = '99';
controller.dropSlot(0, 3);
assert.equal(lastStatus(), '丢弃数量无效。', '无效数量提示');
state.promptAnswer = '4';
controller.dropSlot(0, 3);
assert.equal(sent.at(-1).type, 'dropItem');
assert.equal(sent.at(-1).quantity, 4, 'prompt 数量进入消息');
assert.equal(sent.at(-1).inventoryType, 1, 'dropItem inventoryType 映射');
// 数量 1：不 prompt 直接丢弃
state.inventory.set('0:4', item(4, '2000002'));
controller.dropSlot(0, 4);
assert.equal(sent.at(-1).quantity, 1, '堆叠 1 不询问数量');

// inventoryAction：pending 互斥 + gather/sort 消息
const sentBeforeAction = sent.length;
controller.inventoryAction('gather');
assert.equal(sent.at(-1).type, 'inventoryGather');
assert.equal(sent.at(-1).inventoryType, 1, 'gather 使用当前页签映射');
controller.inventoryAction('sort');
assert.equal(lastStatus(), '正在整理物品栏，请稍候。', 'pending 期间拒绝新操作');
assert.equal(sent.length, sentBeforeAction + 1, 'pending 期间不发送');
controller.resetPendingOperation();
controller.inventoryAction('sort');
assert.equal(sent.at(-1).type, 'inventorySort', 'resetPendingOperation 后可再次发起');

// submitUseItem：普通使用 / 卷轴目标 / pending 互斥
const sentBeforeUse = sent.length;
state.inventory.set('0:5', item(5, '2020000'));
controller.submitUseItem(0, 5, item(5, '2020000'));
assert.equal(sent.at(-1).type, 'useItem');
assert.equal(sent.at(-1).itemId, '2020000');
assert.equal(sent.at(-1).inventoryType, 1);
assert.equal(targetModes.at(-1), false, '普通使用后目标模式关闭');
// 进入卷轴目标模式
const scrollItem = item(1, '2041006');
controller.beginScrollTarget(1, 1, scrollItem);
assert.equal(targetModes.at(-1), true, '卷轴目标模式开启');
assert.deepEqual(controller.scrollTarget(), { sourceTab: 1, sourceSlot: 1, item: scrollItem });
// 对装备使用：pendingUse 记录，目标模式保持
const equipTarget = item(-9, '1102173');
controller.submitUseItem(1, 1, scrollItem, -9, equipTarget);
assert.equal(sent.at(-1).type, 'useItem');
assert.equal(sent.at(-1).targetSlot, -9);
assert.equal(sent.at(-1).targetItemId, '1102173');
const pendingId = sent.at(-1).requestId;
controller.submitUseItem(0, 5, item(5, '2020000'));
assert.equal(lastStatus(), '正在等待上一次卷轴操作。', 'pending use 期间拒绝新使用');
assert.equal(sent.length, sentBeforeUse + 2, 'pending use 期间不发送（前有普通使用+卷轴带目标两次发送）');
// 消费 requestId：一次性
assert.equal(controller.completeUseRequest('other-id'), false, '不匹配的 requestId 不消费');
assert.equal(controller.completeUseRequest(pendingId), true, '匹配的 requestId 消费成功');
assert.equal(controller.completeUseRequest(pendingId), false, '消费是一次性的');
// 视图侧语义：use 结果消费命中后随即取消滚动目标（receiveInventoryResult 同步行为）
controller.cancelScrollTarget(false);
assert.equal(targetModes.at(-1), false, '消费后取消滚动目标并翻转模式');
// 无 pendingScroll 的带目标使用：清目标模式（原分支语义）
controller.submitUseItem(0, 5, item(5, '2020000'), -9, equipTarget);
assert.equal(targetModes.at(-1), false, '无滚动目标时带目标使用关闭模式');

// cancelScrollTarget：notify 语义 + 幂等
controller.beginScrollTarget(1, 1, scrollItem);
controller.cancelScrollTarget(true);
assert.equal(lastStatus(), '已取消卷轴使用。', 'notify=true 提示取消');
assert.equal(controller.scrollTarget(), undefined);
const statusCountAfterCancel = statuses.length;
controller.cancelScrollTarget(true);
assert.equal(statuses.length, statusCountAfterCancel, '无目标时 cancel 不重复提示');
assert.equal(targetModes.filter(mode => mode === false).length >= 2, true, '每次清除都翻转模式回调');

// resetPending：同时清滚动目标与 pending use
controller.beginScrollTarget(1, 1, scrollItem);
controller.submitUseItem(1, 1, scrollItem, -9, equipTarget);
controller.resetPending();
assert.equal(controller.scrollTarget(), undefined);
controller.submitUseItem(0, 5, item(5, '2020000'));
assert.equal(sent.at(-1).type, 'useItem', 'resetPending 后 pending use 已清');

// dropMesos：practice / 下限 / prompt 无效 / 有效
state.practice = true;
controller.dropMesos();
assert.equal(lastStatus(), '请退出练习后再丢弃金币。', '练习中禁止丢金币');
state.practice = false;
state.mesos = 5;
controller.dropMesos();
assert.equal(lastStatus(), '至少需要 10 金币才能丢弃。', '低于下限拒绝');
state.mesos = 1000;
state.promptAnswer = '5';
controller.dropMesos();
assert.equal(lastStatus(), '金币数量无效。', '金币无效数量提示');
state.promptAnswer = '60000';
controller.dropMesos();
assert.equal(lastStatus(), '金币数量无效。', '超过 50000 上限拒绝');
state.promptAnswer = '250';
controller.dropMesos();
assert.equal(sent.at(-1).type, 'dropMesos');
assert.equal(sent.at(-1).quantity, 250, '丢金币数量进入消息');
assert.ok(sent.at(-1).requestId.startsWith('mesos-'), '丢金币 requestId 前缀');
state.promptAnswer = null;
controller.dropMesos();
assert.equal(sent.at(-1).quantity, 250, 'prompt 取消不发送');

console.log('inventory intents: message shapes, inventoryType pinning, practice gates, prompt flow, pending lifecycle passed.');
