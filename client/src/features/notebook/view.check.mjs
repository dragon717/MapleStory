import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// 冒险笔记（图鉴）窗口的定向检查（NB-07，计划 §16.4）。
//
// 钉的是窗口这一层的三条隐私与生命周期契约：
//   1. 共享 host 只 append 自己的节点，绝不 replaceChildren 清掉别的窗口（§6.4）；
//   2. 过期响应（requestId／页签对不上）必须被丢弃，上一页的结果不能覆盖当前页（§6.5）；
//   3. 目录版本错配时拒绝排版并给出可见原因，而不是拿旧页码解释新目录（§12.2）。
// 此外还钉查询消息的形状：只带页签／页码／目录版本／筛选，**不带任何身份字段**。
//
// Same harness as the other client checks: transpile the module, replace its
// runtime imports with stubs, import through a data: URL, and drive it with a
// minimal DOM.  `view-model` 是纯函数，直接用真模块（本文件以
// --experimental-strip-types 运行）。

const here = new URL('./', import.meta.url);
const fileUrl = spec => new URL(spec.replace(/\.ts$/, '') + '.ts', here).href;

const source = await readFile(new URL('./view.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
  .replace(
    "import { displayText, uiLocale, uiText } from '../../app/i18n';",
    "const displayText = x => x, uiLocale = () => 'zh', uiText = (key, fallback) => fallback ?? key;",
  )
  .replace(
    "import { bringToFront, clampIntoHost, installWindowDrag, } from '../ui/window-shell';",
    "const bringToFront = () => {}, clampIntoHost = () => {}, installWindowDrag = () => () => {};",
  )
  .replace(
    "import { itemDetails, itemName } from '../inventory/names';",
    "const itemDetails = id => `detail:${id}`, itemName = id => `name:${id}`;",
  )
  .replace(
    "import { loadNotebookDirectory, } from './directory';",
    "const loadNotebookDirectory = () => Promise.reject(new Error('offline'));",
  )
  // 两个 section 渲染器只记录"被要求画了哪些行"——这正是隐私断言要看的。
  .replace(
    "import { renderMonsterPage } from './monster-section';",
    "const renderMonsterPage = ctx => { globalThis.__painted.push(['monster', ctx.rows.map(row => row.key)]); return document.createElement('div'); };",
  )
  .replace(
    "import { renderItemPage } from './item-section';",
    "const renderItemPage = ctx => { globalThis.__painted.push(['item', ctx.rows.map(row => row.key)]); return document.createElement('div'); };",
  )
  .replace("from './view-model';", `from '${fileUrl('./view-model')}';`);
// `view-model` 被改写成绝对 file: URL（它是纯函数，直接跑真模块）；其余运行时
// 依赖全部打桩，不能有第二条相对导入混进来。
assert.ok(!/from '\.\.?\//.test(code), 'every runtime import must be stubbed before the data: URL load');

globalThis.__painted = [];

const element = () => ({
  children: [], className: '', type: '', title: '', textContent: '', hidden: false, value: '',
  disabled: false, src: '', width: 0, height: 0, alt: '', draggable: false, placeholder: '', maxLength: 0,
  style: { setProperty() { } }, dataset: {}, listeners: {}, attributes: {},
  classList: { add() { }, remove() { }, toggle() { }, contains: () => false },
  append(...kids) { this.children.push(...kids); },
  appendChild(child) { this.children.push(child); },
  replaceChildren(...kids) { this.children = [...kids]; },
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
  removeEventListener() { },
  setAttribute(name, value) { this.attributes[name] = value; },
  getAttribute(name) { return this.attributes[name]; },
  matches: () => false,
  querySelector: () => null,
  getBoundingClientRect: () => ({ height: 0, width: 0, top: 0, left: 0 }),
  remove() { this.removed = true; }, focus() { }, select() { },
});

const documentListeners = {};
const original = { document: globalThis.document, ResizeObserver: globalThis.ResizeObserver };
globalThis.document = {
  createElement: element,
  addEventListener(type, fn) { (documentListeners[type] ??= []).push(fn); },
  removeEventListener() { },
};
globalThis.ResizeObserver = class { observe() { } disconnect() { } };

try {
  const { NotebookView } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

  const directory = {
    catalogVersion: 'v1',
    contentVersion: 'tms273-29',
    sections: { equipment: ['1302000'], use: ['2000000'], setup: [], etc: [], cash: [], pet: [], mount: ['1902000'], chair: ['3010000'] },
    items: { '1302000': { inventoryType: 1, isPet: false, availability: 'obtainable', questIds: [] } },
    // 骑宠不在 `items` 里：源 notSale / only，另有自己的表。
    mounts: { '1902000': { tamingMob: 1, reqLevel: 60, availability: 'unverified' } },
    // 椅子同族（`Item/Install/0301*`、`0302`）：另有自己的表。
    chairs: { '3010000': { recoveryHP: 50, recoveryMP: null, recoveryIntervalMs: 10000, availability: 'unverified' } },
    monsterStructure: {
      regions: { '0': { region: 0, name: '楓之島', pages: [0] } },
      rows: { 'mc-0-0-0': { rowKey: 'mc-0-0-0', region: 0, page: 0, pageName: '楓之島 1', row: 0, name: '行0', entryIds: [] } },
    },
    monsterEntries: {}, monsterText: {}, collectableEntryCount: 0, rewardItems: {},
    status: {},
  };

  const host = element();
  host.clientWidth = 1440;
  host.clientHeight = 900;
  const sent = [];
  const view = new NotebookView(host, { notebook: { frames: { monster: {}, item: {} } } }, {
    send: message => { sent.push(message); return true; },
    loadDirectory: async () => directory,
  });

  // --- 1. 共享 host 只被 append，绝不 replaceChildren ----------------------
  assert.equal(host.children.length, 1, '窗口必须把自己的根节点 append 进共享 host');

  // --- 打开：先取目录，再问服务器要当前页的私有快照 ------------------------
  view.open();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(sent.length, 1, '开窗必须发一次查询');
  const first = sent[0];
  assert.equal(first.type, 'notebookQuery');
  assert.equal(first.section, 'monster');
  assert.equal(first.catalogVersion, 'v1');
  // 查询里绝不能出现任何身份字段：主体只由连接决定。
  for (const key of Object.keys(first)) {
    assert.ok(!/account|character|player|owner/i.test(key), `查询带上了身份字段 ${key}`);
  }
  assert.ok(!('mode' in first), '怪物页没有浏览方式，不该发 mode');

  const stateFor = (requestId, rows, overrides = {}) => ({
    type: 'notebookState', requestId, section: 'monster', catalogVersion: 'v1',
    scope: 'account', revision: 4, page: 0, pageCount: 15, rows,
    summary: { registered: 1, total: 200, collectable: 57 }, serverNowMs: 1, ...overrides,
  });

  // --- 2. 过期响应被丢弃 ---------------------------------------------------
  globalThis.__painted = [];
  view.receiveState(stateFor('stale-request', [{ key: 'leak', label: '', obtained: false, registered: false }]));
  assert.equal(globalThis.__painted.length, 0, 'requestId 对不上的响应必须整份丢弃');

  // 页签对不上同样丢弃：即使 requestId 是这一份，也不是这一页的。
  view.receiveState(stateFor('notebook-monster-1', [], { section: 'equipment' }));
  assert.equal(globalThis.__painted.length, 0, '页签对不上的响应必须丢弃');

  view.receiveState(stateFor('notebook-monster-1', [
    { key: 'entry-1', label: '行0', obtained: true, registered: true, rowKey: 'mc-0-0-0', slots: [] },
  ]));
  assert.equal(globalThis.__painted.length, 1);
  assert.deepEqual(globalThis.__painted[0], ['monster', ['entry-1']]);

  // --- 3. 目录版本错配：拒绝排版，并给出可见原因 ---------------------------
  view.open();
  await new Promise(resolve => setTimeout(resolve, 0));
  globalThis.__painted = [];
  const mismatchId = sent[sent.length - 1].requestId;
  view.receiveState(stateFor(mismatchId, [{ key: 'entry-2', label: '', obtained: false, registered: false }], { catalogVersion: 'v0' }));
  assert.deepEqual(globalThis.__painted, [['monster', []]], '版本错配时一行都不能排版');

  // --- 4. 私有事实变了就重新问，不自己推测 --------------------------------
  const before = sent.length;
  view.receiveChange({ type: 'notebookChanged', scope: 'account', revision: 5, section: 'monster', addedKeys: ['entry-9'] });
  assert.equal(sent.length, before + 1, 'revision 前进必须重新查询');
  const again = sent[sent.length - 1].requestId;
  view.receiveChange({ type: 'notebookChanged', scope: 'account', revision: 5, section: 'monster', addedKeys: [] });
  assert.equal(sent.length, before + 1, 'revision 没有前进就不重复查询');

  // --- 5. 点页签必须真的换页（每一页都在同一个窗口里） ---------------------
  // 这条是回归检查：页签的 click 监听挂在每次重绘新建的按钮上，一旦重绘路径变了
  // （比如把监听挂到容器上、或在 replaceChildren 之后才绑），页签会「点了没反应」
  // ——而且这种断线不会让任何布局检查失败。
  view.open();
  await new Promise(resolve => setTimeout(resolve, 0));
  view.receiveState(stateFor(sent[sent.length - 1].requestId, []));
  const strip = host.children[0].children.find(child => child.className === 'notebook-tabs');
  assert.equal(strip.children.length, 6, '窗口必须有六个页签');
  for (const [index, section] of ['monster', 'equipment', 'use', 'mount', 'chair', 'quest'].entries()) {
    assert.equal((strip.children[index].listeners.click ?? []).length, 1, `${section} 页签没有 click 监听`);
    // 标签是画上去的 DOM 文字；源底板把字形烧在图里，所以底板必须另画（见第 8 节）。
    assert.equal(strip.children[index].textContent, section, `${section} 页签没画出自己的标签`);
    assert.equal(strip.children[index].getAttribute('aria-selected'), index === 0 ? 'true' : 'false', `${section} 页签的选中态不对`);
  }
  const beforeTab = sent.length;
  strip.children[1].listeners.click[0]();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(sent.length, beforeTab + 1, '点装备页签必须发一次查询');
  assert.equal(sent[sent.length - 1].section, 'equipment');
  assert.equal(sent[sent.length - 1].mode, 'available', '装备页必须带默认浏览方式');
  assert.equal(sent[sent.length - 1].page, 0, '换页签必须从第一页开始');

  // 骑宠页默认「全部」：源把骑宠标成 notSale / only，本版本没有开放获取途径，
  // 按「当前可获得」问会得到空页——读起来像「本版本没有坐骑」。
  const beforeMount = sent.length;
  strip.children[3].listeners.click[0]();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(sent.length, beforeMount + 1, '点骑宠页签必须发一次查询');
  assert.equal(sent[sent.length - 1].section, 'mount');
  assert.equal(sent[sent.length - 1].mode, 'all', '骑宠页默认必须看全部');

  // 椅子页同骑宠页默认「全部」：2799 件里真进商店的是个位数，按「当前可获得」
  // 问会得到几乎空页。
  const beforeChair = sent.length;
  strip.children[4].listeners.click[0]();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(sent.length, beforeChair + 1, '点椅子页签必须发一次查询');
  assert.equal(sent[sent.length - 1].section, 'chair');
  assert.equal(sent[sent.length - 1].mode, 'all', '椅子页默认必须看全部');

  // --- 5b. 骑宠页的子页：骑宠 ⇄ 鞍具 --------------------------------------
  // 鞍具与骑宠出自同一张 `shared/mounts.json`（源 islot = Sd / Tm），所以它不进顶栏
  // 当第七个页签，而是骑宠页里的子页；切换子页 = 换一种查询分区，不是本地过滤。
  const side = host.children[0].children.find(child => child.className === 'notebook-side');
  const subTabs = () => side.children.find(child => child.className === 'notebook-subtabs');
  const modes = () => side.children.find(child => child.className === 'notebook-modes');
  const activeTab = () => strip.children
    .find(child => child.getAttribute('aria-selected') === 'true')?.dataset.section;
  // 侧栏内容随服务器回包一起重绘（与换页签同一节奏），所以每次交互后都要喂一份
  // 快照——不然看到的是上一页的侧栏。
  const deliver = (section, rows = []) => {
    const last = sent[sent.length - 1];
    view.receiveState({
      type: 'notebookState', requestId: last.requestId, section, catalogVersion: 'v1',
      scope: 'character', revision: 1, page: last.page, pageCount: 1, rows,
      summary: { registered: 0, total: rows.length }, serverNowMs: 1,
    });
  };

  strip.children[3].listeners.click[0]();
  await new Promise(resolve => setTimeout(resolve, 0));
  deliver('mount');
  const mountGroup = subTabs();
  assert.ok(mountGroup, '骑宠页必须给出「骑宠 / 鞍具」子页');
  assert.equal(mountGroup.children.length, 2, '骑宠页只有两个子页');
  assert.deepEqual(
    mountGroup.children.map(child => child.dataset.section),
    ['mount', 'saddle'],
    '子页顺序必须是「骑宠、鞍具」');
  assert.deepEqual(
    mountGroup.children.map(child => child.getAttribute('aria-selected')),
    ['true', 'false'],
    '默认停在骑宠子页');
  for (const child of mountGroup.children) {
    assert.equal((child.listeners.click ?? []).length, 1, '每个子页都要有 click 监听');
  }
  assert.equal(activeTab(), 'mount', '骑宠子页上顶栏选中的是骑宠页签');

  const beforeSaddle = sent.length;
  mountGroup.children[1].listeners.click[0]();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(sent.length, beforeSaddle + 1, '点鞍具子页必须发一次查询');
  assert.equal(sent[sent.length - 1].section, 'saddle', '鞍具是服务端的独立分区，不是本地过滤');
  assert.equal(sent[sent.length - 1].mode, 'all', '鞍具默认也必须看全部：源里没有开放获取途径');
  assert.equal(sent[sent.length - 1].page, 0, '换子页必须从第一页开始');
  deliver('saddle');
  // 子页**不是**页签：顶栏仍是六个，且鞍具子页上要把父页签（骑宠）标成选中，
  // 否则玩家看到的是一页没有归属的条目。
  assert.equal(strip.children.length, 6, '子页不得挤进顶栏');
  assert.equal(activeTab(), 'mount', '鞍具子页上顶栏仍要选中骑宠页签');
  const saddleGroup = subTabs();
  assert.deepEqual(
    saddleGroup.children.map(child => child.getAttribute('aria-selected')),
    ['false', 'true'],
    '切到鞍具子页后选中态要跟着走');
  // 鞍具子页的浏览方式与骑宠页同一口径（没有「当前可获得」）。
  assert.deepEqual(
    modes().children.map(child => child.textContent),
    ['all', 'obtained', 'missing'],
    '鞍具子页的浏览方式必须与骑宠页一致（没有「当前可获得」）');
  assert.deepEqual(globalThis.__painted.at(-1), ['item', []], '鞍具子页走物品格架');

  // 切回骑宠子页：子页各自持有自己的页码／浏览方式，所以这里必须再问一次。
  const beforeBack = sent.length;
  saddleGroup.children[0].listeners.click[0]();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(sent.length, beforeBack + 1, '切回骑宠子页必须再问一次');
  assert.equal(sent[sent.length - 1].section, 'mount');
  deliver('mount');
  assert.deepEqual(
    subTabs().children.map(child => child.getAttribute('aria-selected')),
    ['true', 'false'],
    '切回骑宠子页后选中态要跟着走');

  // 别的页签不该出现子页：装备页既没有子页也不该漏出骑宠的。
  strip.children[1].listeners.click[0]();
  await new Promise(resolve => setTimeout(resolve, 0));
  deliver('equipment');
  assert.equal(subTabs(), undefined, '只有骑宠页才有「骑宠 / 鞍具」子页');

  // --- 6. 任务页：不发「未获得」请求，且查询仍不带身份 ---------------------
  view.open('quest');
  await new Promise(resolve => setTimeout(resolve, 0));
  const quest = sent[sent.length - 1];
  assert.equal(quest.section, 'quest');
  assert.ok(quest.requestId !== again, '换页签必须换 requestId');

  // --- 7. 关窗与销毁 -------------------------------------------------------
  view.close();
  assert.equal(view.isOpen(), false);
  view.destroy();
  assert.equal(host.children[0].removed, true, '销毁必须移除自己的根节点');
  assert.ok((documentListeners.keydown ?? []).length > 0, '窗口装过 ESC 监听');
} finally {
  globalThis.document = original.document;
  globalThis.ResizeObserver = original.ResizeObserver;
}

// ---------------------------------------------------------------------------
// 8. 页签必须真的点得到，而且标签是画上去的（不叠字）
//
// 窗口挂在共享浮层 `#ui-windows` 下，而那个 host 是 `pointer-events:none` 的：
// 窗口根节点不把事件收回来，页签／关闭／分页就全部「点了没反应」，而**这种断线
// 不会让任何布局断言失败**（上面的点页签检查是直接调 click 监听，也照样通过）。
// 同理，源 `Tab/enabled|disabled` 底板把页签文字烧在位图里，贴图 + 画字就是叠字。
//
// 两条都只能对样式表与源码断言，所以在这里单独钉。
{
  const style = await readFile(new URL('./style.css', import.meta.url), 'utf8');
  const appStyle = await readFile(new URL('../../app/style.css', import.meta.url), 'utf8');
  const mainSource = await readFile(new URL('../../app/main.ts', import.meta.url), 'utf8');
  const monsterSource = await readFile(new URL('./monster-section.ts', import.meta.url), 'utf8');

  // 对照面：共享浮层确实是惰性的（它变了，这条检查的前提就变了）。
  assert.match(
    appStyle,
    /#game-shell>#ui-windows\{[^}]*pointer-events:none/,
    '共享 UI 浮层必须是 pointer-events:none（本检查的前提）',
  );
  assert.match(
    style,
    /\.notebook-window\s*\{[^}]*pointer-events:\s*auto;/,
    '窗口必须在共享惰性浮层里把事件收回来，否则页签点了没反应',
  );

  // 底板重画，不贴源图；选中态由 aria-selected 选中。
  assert.match(style, /--notebook-tab-off-image:\s*linear-gradient\(/, '未选中的页签底板要按源配色重画');
  assert.match(style, /--notebook-tab-on-image:\s*linear-gradient\(/, '选中的页签底板要按源配色重画');
  assert.match(
    style,
    /\.notebook-tab\[aria-selected='true'\]\s*\{[^}]*--notebook-tab-on-image/,
    '选中态必须切到源 enabled 配色',
  );
  assert.doesNotMatch(
    style,
    /\.notebook-tab[^{]*\{[^}]*url\(/,
    '页签底板不能贴源 Tab 图：源把页签文字烧在图里，贴图再画字就是叠字',
  );
  // 源码里不能再出现源 Tab 帧的**键字面量**（注释里提到它不算）。
  assert.doesNotMatch(code, /'Tab\/(enabled|disabled)/, '页签不该再引用源 Tab 帧');
  assert.doesNotMatch(code, /backgroundImage/, '页签底板归样式表，源码里不该再设 backgroundImage');
  // 字色跟着源烧在图里的字形走：选中底板是纯白，未选中底板最亮只到浅灰。
  assert.match(style, /\.notebook-tab\s*\{[^}]*color:\s*#999999;/, '未选中页签的字色要跟源字形一致（源该态没有纯白像素）');
  assert.match(style, /\.notebook-tab\[aria-selected='true'\]\s*\{[^}]*color:\s*#ffffff;/, '选中页签的字色要跟源字形一致（纯白）');

  // 分区状态说明（登记规则尚未核定）画在页内，不抬成全局红字。
  assert.match(monsterSource, /'notebook-note'/, '怪物页要把分区状态说明画在页内');
  assert.match(
    mainSource,
    /if \(message\.type === 'notebookState'\) notebook\?\.receiveState\(message\);/,
    'notebookState 整份交给窗口，不在分发处再解释一次',
  );
  assert.doesNotMatch(
    mainSource,
    /status\(message\.blockedReason/,
    '分区的阻塞说明是已知事实，不能播报成全局错误',
  );
}

console.log('notebook view check passed');
