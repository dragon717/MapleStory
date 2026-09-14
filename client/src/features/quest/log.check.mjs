import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// 任务视窗的自助入口（審計 T03 / C02 的前端一半）。
//
// 源里 `QuestInfo/selfStart` / `selfComplete` 为真、且 Check 里根本没有 NPC 的阶段，
// 任务视窗就是它唯一的入口。所以"按钮出不出现"必须严格等于"这个阶段在源里是不是
// 自助的"：给错方向就等于替玩家伪造了一个不存在的 NPC 对话，漏给就等于把可完成的
// 任务藏起来。服务端仍会在 `apply_quest_effect_at` 里重判并可能回
// `quest_self_service_unavailable`，这条检查只钉前端契约：哪些行给按钮、按钮发什么
// 动作、请求怎么带 requestId、没有 handler 时不许抛。
//
// Same harness as the other client checks: transpile the module, replace its runtime
// imports with stubs, import through a data: URL, and drive it with a minimal DOM.

const source = await readFile(new URL('./log.ts', import.meta.url), 'utf8');
const compile = text => ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const i18nStub = "const uiLocale = () => 'zh', displayText = x => x;";
const dragStub = 'const installWindowDrag = () => () => {};';
const code = compile(source)
  .replace("import { uiLocale, displayText } from '../../app/i18n';", i18nStub)
  .replace("import { installWindowDrag } from '../ui/window-shell.ts';", dragStub);
assert.ok(!/^import /m.test(code), 'every runtime import must be stubbed before the data: URL load');
const { QuestLogView } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

const element = () => ({
  children: [], className: '', type: '', title: '', textContent: '', hidden: false,
  style: {}, dataset: {}, listeners: {}, attributes: {},
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  append(...kids) { this.children.push(...kids); },
  appendChild(child) { this.children.push(child); },
  replaceChildren(...kids) { this.children = [...kids]; },
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
  removeEventListener() {},
  setAttribute(name, value) { this.attributes[name] = value; },
  matches: () => false,
  getBoundingClientRect: () => ({ height: 0, width: 0, top: 0, left: 0 }),
  remove() {}, focus() {}, select() {}, querySelector: () => null,
});

const original = { document: globalThis.document };
try {
  const listeners = {};
  globalThis.document = {
    createElement: element,
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    removeEventListener() {},
  };

  const host = element();
  // An empty manifest has no Quest.img frame, so the view takes its CSS fallback
  // chrome — the entry buttons are the same either way.
  const view = new QuestLogView(host, {});
  const calls = [];
  view.onService = (questId, action) => calls.push([questId, action]);

  const entry = (questId, status, selfStart, selfComplete) => ({
    questId, status, selfStart, selfComplete,
    name: `${questId} 任務`, summary: `${questId} 摘要`, objectives: [],
  });
  view.setList([
    entry('36315', 'available', true, true),
    entry('36316', 'available', false, false),
    entry('36332', 'objectivesComplete', false, true),
    entry('36317', 'objectivesComplete', false, false),
    entry('36314', 'active', true, true),
    entry('36313', 'completed', true, true),
    // T05：源边界挡住的一段。即使源标了自助标志，blocked 行也不许变成按钮。
    {
      questId: '36319', status: 'blocked', selfStart: true, selfComplete: true,
      name: '36319 任務', summary: '36319 摘要', objectives: [],
      nextAction: '原版此步驟在弓箭手培訓中心的赫麗娜接取，尚未開放',
      blockReason: '尚未開放：原版劇情場景尚未復刻',
    },
  ]);

  const rows = () => view.body.children;
  const rowOf = questId => rows().find(row => row.children[0].children[0].textContent === `${questId} 任務`);
  const actionOf = questId => rowOf(questId).children.find(child => child.className === 'quest-log-action');

  // 自助接取：只有 available + selfStart 才有按钮，而且点下去只发一个 start。
  const startButton = actionOf('36315');
  assert.ok(startButton, '36315 是源自助接取，任务视窗必须给出接取入口');
  assert.equal(startButton.dataset.action, 'start');
  assert.equal(startButton.textContent, '接取任務');
  startButton.listeners.click[0]();
  assert.deepEqual(calls, [['36315', 'start']], '按钮只提出一个 start 请求');

  // available 但源里不是 selfStart：这一侧有 NPC，视窗不许替他接取。
  assert.ok(!actionOf('36316'), '36316 的接取有 NPC，视窗不得提供接取按钮');

  // 自助交付：objectivesComplete + selfComplete。
  const completeButton = actionOf('36332');
  assert.ok(completeButton, '36332 是源自助交付，任务视窗必须给出交付入口');
  assert.equal(completeButton.dataset.action, 'complete');
  assert.equal(completeButton.textContent, '完成任務');
  completeButton.listeners.click[0]();
  assert.deepEqual(calls.at(-1), ['36332', 'complete']);

  // objectivesComplete 但不是 selfComplete：必须在 NPC 面前交付。
  assert.ok(!actionOf('36317'), '36317 的交付有 NPC，视窗不得提供交付按钮');

  // 進行中 / 已领奖的阶段没有可推进的方向，即使源标了自助。
  assert.ok(!actionOf('36314'), '进行中的任务不该再出现接取按钮');
  assert.ok(!actionOf('36313'), '已领奖的任务不该再出现按钮');

  // T05：blocked 行说明"为什么停下"，而不是给出按下去必被拒的入口。
  const blockedRow = rowOf('36319');
  assert.ok(blockedRow, '36319 必须在日志里');
  assert.ok(
    blockedRow.className.includes('quest-log-blocked'),
    'blocked 行要有自己的样式：' + blockedRow.className,
  );
  assert.equal(blockedRow.children[0].children[1].textContent, '尚未开放');
  const blockedNote = blockedRow.children.find(child => child.className === 'quest-next');
  assert.equal(blockedNote.textContent, '尚未開放：原版劇情場景尚未復刻', '优先显示阻塞原因');
  assert.ok(!actionOf('36319'), 'blocked 行不得给出接取或交付按钮');
  // 排在最后：它是"到此为止"的说明，不是当前要做的事。
  assert.equal(rows().at(-1), blockedRow, 'blocked 行排在最后');
  // 追踪条也不该把玩家指向一个做不了的目标：它跟的是还能行动的那一条。
  assert.ok(!view.tracker.hidden, '还有可行动的任务时追踪条显示');
  assert.ok(
    !String(view.tracker.textContent).includes('尚未開放'),
    '追踪条不该指向 blocked 行：' + view.tracker.textContent,
  );

  // 未接线时点击必须是空操作（视窗先于会话建立）。
  view.onService = undefined;
  assert.doesNotThrow(() => completeButton.listeners.click[0](), '没有 handler 时点击不许抛');

  // 关闭请求仍然由视窗自己处理，不受入口按钮影响。
  assert.ok(view.isOpen() === false, '任务视窗默认关闭');
  view.destroy();
} finally {
  Object.assign(globalThis, original);
}

console.log('Quest log self-service entry: 接取/交付按钮严格跟随源自助标记，点击只提出对应动作。');
