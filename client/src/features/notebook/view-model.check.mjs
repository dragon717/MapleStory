import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// 冒险笔记（图鉴）视图层的定向检查（NB-07，计划 §16.4）。
//
// 只钉**客户端这一半可以做错的决定**：任务页没有「未获得」开关、分母的展示规则、
// 分页窗口的边界、目录结构的排序。这些全是纯函数——不碰 DOM、不发消息，所以这里
// 也不需要 DOM：把模块转译后直接用真实数据跑。
// 「哪些行是已获得的」由服务器判定，这里一条都不碰。

const source = await readFile(new URL('./view-model.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
assert.ok(!/^import (?!type )/m.test(code), 'view-model 只该有类型导入');
const {
  NOTEBOOK_TABS, BROWSE_MODES, MOUNT_MODES, CHAIR_MODES, browseModesFor, defaultModeFor,
  regionList, pagesOfRegion, rowsOfPage, rowsOfRegion, groupRowsByPage,
  pageWindow, progressOf, catalogMismatch,
} = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

// --- 六个页签：顺序固定，任务页在最后 ------------------------------------
assert.deepEqual(NOTEBOOK_TABS.map(tab => tab.section), ['monster', 'equipment', 'use', 'mount', 'chair', 'quest']);

// --- 任务页没有「未获得」开关 --------------------------------------------
// 未获得的任务条目从服务器的基集合里就不存在，给一个开关等于暗示它存在。
assert.deepEqual(browseModesFor('quest'), ['all']);
assert.deepEqual(browseModesFor('monster'), BROWSE_MODES);
assert.deepEqual(browseModesFor('equipment'), BROWSE_MODES);
assert.equal(defaultModeFor('equipment'), 'available');
// --- 骑宠页没有「当前可获得」---------------------------------------------
// 源把骑宠标成 notSale / only，本版本没有一条开放获取途径：按它过滤会得到空页，
// 读起来像「本版本没有坐骑」。所以基集合是整张坐骑表，默认看全部。
assert.deepEqual(browseModesFor('mount'), MOUNT_MODES);
assert.deepEqual(MOUNT_MODES, ['all', 'obtained', 'missing']);
assert.equal(defaultModeFor('mount'), 'all');
// --- 椅子页同样没有「当前可获得」-----------------------------------------
// 源把椅子整族排除在掉落与商店之外，2799 件里真进商店的是个位数：按它过滤
// 会得到几乎空页。所以基集合是整张椅子表，默认看全部。
assert.deepEqual(browseModesFor('chair'), CHAIR_MODES);
assert.deepEqual(CHAIR_MODES, ['all', 'obtained', 'missing']);
assert.equal(defaultModeFor('chair'), 'all');

// --- 分母：任务页没有分母，怪物页把「当前可收集」分开报 ------------------
// 未来的任务条目总数不是公开信息（§5.5），所以 total 必须是 null 而不是 0。
assert.deepEqual(progressOf('quest', { registered: 0, total: 21, collected: 0, collectable: 0, recorded: 3 }), { done: 3, total: null });
assert.deepEqual(progressOf('monster', { registered: 5, total: 200, collectable: 57 }), { done: 5, total: 200, note: '57' });
assert.deepEqual(progressOf('equipment', { registered: 2, total: 40, collectable: 0 }), { done: 2, total: 40 });
// 摘要里没有 recorded 时任务页退回 registered，不显示"未定义"。
assert.deepEqual(progressOf('quest', { registered: 4, total: 0, collectable: 0 }), { done: 4, total: null });

// --- 分页窗口：首尾常在、越界不绕回、不会造出不存在的页码 ----------------
assert.deepEqual(pageWindow(0, 1), [0]);
assert.deepEqual(pageWindow(0, 3), [0, 1, 2]);
assert.deepEqual(pageWindow(0, 30), [0, 1, 2, '…', 29]);
assert.deepEqual(pageWindow(15, 30), [0, '…', 13, 14, 15, 16, 17, '…', 29]);
assert.deepEqual(pageWindow(29, 30), [0, '…', 27, 28, 29]);
// 越界页码夹回合法范围，而不是返回空数组让分页条消失。
assert.deepEqual(pageWindow(99, 30), [0, '…', 27, 28, 29]);
assert.deepEqual(pageWindow(-5, 30), [0, 1, 2, '…', 29]);
assert.deepEqual(pageWindow(0, 0), []);

// --- 目录结构：地区按数值排序，不是字典序 --------------------------------
// 源的地区键是字符串（0/1/10/100/2…），按字典序排会把 10 排在 2 前面。
const directory = {
  monsterStructure: {
    regions: {
      '100': { region: 100, name: '時間之路', pages: [0] },
      '2': { region: 2, name: '冰原', pages: [0, 1] },
      '10': { region: 10, name: '水下', pages: [0] },
      '0': { region: 0, name: '楓之島', pages: [0, 1] },
    },
    rows: {
      'mc-0-0-0': { rowKey: 'mc-0-0-0', region: 0, page: 0, pageName: '楓之島 1', row: 0, name: '行0', entryIds: [] },
      'mc-0-1-0': { rowKey: 'mc-0-1-0', region: 0, page: 1, pageName: '楓之島 2', row: 0, name: '行1', entryIds: [] },
      'mc-0-0-1': { rowKey: 'mc-0-0-1', region: 0, page: 0, pageName: '楓之島 1', row: 1, name: '行2', entryIds: [] },
      'mc-2-0-0': { rowKey: 'mc-2-0-0', region: 2, page: 0, pageName: '冰原 1', row: 0, name: '行3', entryIds: [] },
    },
  },
};
assert.deepEqual(regionList(directory).map(region => region.region), [0, 2, 10, 100]);
assert.deepEqual(pagesOfRegion(directory, 0).map(entry => entry.page), [0, 1]);
assert.deepEqual(pagesOfRegion(directory, 0).map(entry => entry.name), ['楓之島 1', '楓之島 2']);
assert.deepEqual(rowsOfPage(directory, 0, 0).map(row => row.rowKey), ['mc-0-0-0', 'mc-0-0-1']);
assert.deepEqual(rowsOfRegion(directory, 0).map(row => row.rowKey), ['mc-0-0-0', 'mc-0-0-1', 'mc-0-1-0']);

// --- 服务器给的行按分頁分组，顺序保持服务器给的顺序 ----------------------
const rows = [
  { key: 'a', label: 'a', obtained: false, registered: false, rowKey: 'mc-0-1-0' },
  { key: 'b', label: 'b', obtained: true, registered: true, rowKey: 'mc-0-0-1' },
  { key: 'c', label: 'c', obtained: false, registered: false, rowKey: 'mc-0-0-0' },
  { key: 'd', label: 'd', obtained: false, registered: false, rowKey: 'mc-unknown' },
];
const groups = groupRowsByPage(directory, rows);
assert.deepEqual(groups.map(group => group.page), [-1, 0, 1]);
assert.deepEqual(groups[1].rows.map(row => row.key), ['b', 'c'], '同分页内保持服务器顺序，不重排');
assert.equal(groups[1].name, '楓之島 1');
// 目录里查不到的行键不丢：它单独成组，而不是被静默丢掉。
assert.deepEqual(groups[0].rows.map(row => row.key), ['d']);

// --- 版本错配：客户端必须自己发现，不能拿旧页码解释新目录 ----------------
assert.equal(catalogMismatch('A', { catalogVersion: 'A' }), false);
assert.equal(catalogMismatch('B', { catalogVersion: 'A' }), true);

console.log('notebook view-model check passed');
