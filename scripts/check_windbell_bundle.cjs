#!/usr/bin/env node
'use strict';
/**
 * 风铃运行期资源包的**单一权威**完整性断言。
 *
 * ## 为什么必须单独有一份判据
 *
 * `client/public-tms273/assets/manifest.json` 里**没有风铃地图**：两张风铃图由
 * `client/src/features/windbell/maps.ts` 的 `installWindbellMaps()` 在客户端注入，
 * 而它用到的素材地址又**硬编码**在 `client/src/features/windbell/scene.ts` 的
 * `preload()` 清单里。于是既有那条判据——「遍历 manifest/entry 等 JSON 里出现过的
 * `/assets/**` 再看文件在不在」——**完全看不见风铃**。
 *
 * 2026-09-18 就是这样漏的：`prop-cart.png` 从磁盘上消失后，
 * ① macOS 启动门禁（`scripts/check_tms273_runtime.cjs`）通过，
 * ② Windows 资源门禁（`scripts/check_windows_resources.cjs`）通过，
 * ③ 打包器照常出货；只有玩家那边表现为
 *    「资源加载失败：/assets/windbell/prop-cart.png?ce=1 · tms273-31」
 *    ——`world.ts` 的 `loaderror` 回调只在首屏那一趟触发并置 `failed`，
 *    所以**一张缺图会拦住整张地图**（不是少一个道具那么简单）。
 *
 * ## 判据从哪来（不另抄一份清单）
 *
 * 用**产出这批文件的生成器自己的台账**：
 *   - `assets/windbell/runtime_asset_report.json`（`prepare_windbell_runtime.py`）
 *   - `assets/windbell/models/report.json`（同一脚本的 `prepare_models()`）
 *   - `assets/windbell/tms273.json` 的帧目录（`prepare_windbell_tms.cjs`）
 *
 * 台账每条 path/bytes/sha256 都在这里**独立重算**比对，所以「文件被删」「文件被改」
 * 「台账没跟上」三种都会红，报错直接给出路径。再加一条**反向**断言：bundle 根层
 * 不许出现台账未登记的文件（跑过生成器的人一眼知道该补台账还是补文件）。
 *
 * 无 npm 依赖 ⇒ macOS 启动门禁、Windows `start.bat`、打包器三处都能直接 require。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const BUNDLE = 'client/public-tms273/assets/windbell';
/** 内容根内外都以此前缀为「可打包」的判定：写超出去说明台账本身错了。 */
const CONTENT_ROOT = 'client/public-tms273/';
const CATALOG = `${BUNDLE}/tms273.json`;

const LEDGERS = [
  { relative: `${BUNDLE}/runtime_asset_report.json`, collection: 'records', label: '风铃运行期资源台账' },
  { relative: `${BUNDLE}/models/report.json`, collection: 'models', label: '风铃模型台账' },
];

/**
 * bundle 根层里这两个文件由别的产出物负责，不进运行期台账的 `records`：
 *   - `runtime_asset_report.json` 是台账自身；
 *   - `tms273.json` 是 `prepare_windbell_tms.cjs` 的帧目录（它的帧由 catalog 断言覆盖）。
 * 新增根层文件时**要么进台账**（跑生成器），**要么**带着理由写进这里——两选一。
 */
const ROOT_OWNED_ELSEWHERE = new Set(['runtime_asset_report.json', 'tms273.json']);

function sha256(file) {
  // 本 bundle 单个文件最大约 10MB（两个 GLB），一次读入即可，不必分块。
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function assertPresent(root, relativePath) {
  const file = path.join(root, relativePath);
  assert(fs.existsSync(file), `风铃运行期资源缺失：${relativePath}`);
  const stat = fs.statSync(file);
  assert(stat.isFile() && stat.size > 0, `风铃运行期资源为空：${relativePath}`);
  return stat;
}

function checkLedger(root, spec) {
  const ledgerPath = path.join(root, spec.relative);
  assert(fs.existsSync(ledgerPath), `${spec.label}缺失：${spec.relative}`);
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  const records = ledger[spec.collection];
  assert(Array.isArray(records) && records.length > 0, `${spec.label}里没有任何记录：${spec.relative}`);
  let bytes = 0;
  for (const record of records) {
    assert(typeof record.path === 'string' && record.path.startsWith(CONTENT_ROOT),
      `${spec.label}记录的路径不在内容根内：${record.path}`);
    const stat = assertPresent(root, record.path);
    assert.equal(stat.size, record.bytes,
      `${spec.label}记的字节数与磁盘不符（文件被改写，或台账没重跑）：${record.path}`);
    assert.equal(sha256(path.join(root, record.path)), record.sha256,
      `${spec.label}记的 sha256 与磁盘不符（文件被改写，或台账没重跑）：${record.path}`);
    bytes += stat.size;
  }
  return { relative: spec.relative, files: records.length, bytes, ledger };
}

/** 反向：bundle 根层的文件必须逐条登记在册，否则「悄悄塞进来的文件」无人复核。 */
function checkRootCoverage(root, report) {
  const recorded = new Set(report.records
    .filter(record => path.posix.dirname(record.path) === BUNDLE)
    .map(record => path.posix.basename(record.path)));
  const orphans = fs.readdirSync(path.join(root, BUNDLE), { withFileTypes: true })
    .filter(entry => entry.isFile() && !ROOT_OWNED_ELSEWHERE.has(entry.name) && !recorded.has(entry.name))
    .map(entry => entry.name)
    .sort();
  assert.deepEqual(orphans, [],
    `风铃目录里有未登记的文件（跑生成器补台账，或写进 ROOT_OWNED_ELSEWHERE 并说明归属）：${orphans.join('、')}`);
}

/** 帧目录：TMS273 侧导出的帧地址逐条落盘核对（与 Windows 门禁的引用遍历同一条规则）。 */
function checkCatalog(root) {
  const catalogPath = path.join(root, CATALOG);
  assert(fs.existsSync(catalogPath), `风铃 TMS273 帧目录缺失：${CATALOG}`);
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const publicRoot = path.join(root, 'client/public-tms273');
  let frames = 0;
  let bytes = 0;
  for (const [category, list] of Object.entries(catalog)) {
    assert(Array.isArray(list) && list.length > 0, `风铃帧目录的分类为空：${category}`);
    for (const frame of list) {
      assert(typeof frame.url === 'string' && frame.url.startsWith('/assets/'),
        `风铃帧地址不是 /assets/ 逻辑地址：${category} -> ${frame.url}`);
      const relative = frame.url.replace(/^\/+/, '');
      const inside = path.relative(publicRoot, path.resolve(publicRoot, relative));
      assert(inside && !inside.startsWith('..') && !path.isAbsolute(inside),
        `风铃帧地址越出内容根：${frame.url}`);
      bytes += assertPresent(root, `${CONTENT_ROOT}${relative}`).size;
      frames += 1;
    }
  }
  return { frames, bytes };
}

/**
 * @param {string} [root] 内容根：仓库根，或 Windows 包的暂存根（`<stage>/MapleStory`）。
 *   两种布局里资源相对路径一致，所以打包器可以直接拿暂存树跑同一份断言。
 */
function validate(root = path.resolve(__dirname, '..')) {
  const projectRoot = path.resolve(root);
  const ledgers = LEDGERS.map(spec => checkLedger(projectRoot, spec));
  checkRootCoverage(projectRoot, ledgers[0].ledger);
  const catalog = checkCatalog(projectRoot);
  return {
    ledgers: ledgers.map(({ relative, files, bytes }) => ({ relative, files, bytes })),
    files: ledgers.reduce((sum, ledger) => sum + ledger.files, 0),
    bytes: ledgers.reduce((sum, ledger) => sum + ledger.bytes, 0),
    catalogFrames: catalog.frames,
  };
}

function main(root = process.argv[2] || path.resolve(__dirname, '..')) {
  const result = validate(root);
  const mb = n => (n / 1024 / 1024).toFixed(1) + 'MB';
  console.log(`Windbell runtime bundle: ${result.files} ledgered files (${mb(result.bytes)}) + ${result.catalogFrames} TMS273 frames; path/size/sha256 recomputed, root layer fully accounted.`);
  return result;
}

if (require.main === module) main();

module.exports = { main, validate, BUNDLE, CATALOG, LEDGERS };
