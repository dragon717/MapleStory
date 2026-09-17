#!/usr/bin/env node

// 诊断：iCloud 未落地占位文件（dataless placeholder）盘点。
//
// 为什么需要它：本仓库在 iCloud Drive 上，macOS 空间紧张时会把大文件「驱逐」成占位稿——
// `stat` 仍有 `size`，但 `blocks === 0`，数据块不在本地。此时**读取不会报错，而是永久阻塞**，
// 表现为「进程活着、CPU 0%、磁盘零写入、日志不再推进」，极易被误判成「太慢」或「死锁」。
// 已实测三种卡死形态（2026-09-17）：
//   1. Node `fs.readFileSync` —— 批量遍历卡在某个文件上不再前进；
//   2. `rustc` 对内联 `.rlib` 做 `mmap` —— 栈为
//      `CrateLocator::find_library_crate → get_rlib_metadata → memmap2::map_copy_read_only → __mmap`，
//      卡在**加载外部 crate 元数据**阶段，根本进不了 codegen，且它**持有 cargo 构建锁**；
//   3. `require()` —— `node_modules/<pkg>/package.json` 是占位，整条检查链静默挂死。
//
// 用法：
//   node scripts/scan_icloud_dataless.cjs                 # 全仓盘点（按区域汇总）
//   node scripts/scan_icloud_dataless.cjs --fail-under 0  # 有占位即非零退出（可用作门禁）
//   node scripts/scan_icloud_dataless.cjs --json          # 机器可读
//
// 修法（代码里改不动，必须人来做）：
//   · `node_modules/**` ⇒ 删掉目录后 `npm install --prefer-offline`（走本地 ~/.npm 缓存）。
//     **单跑 `npm install` 没用**——它判定「up to date」不会重新取包。
//   · 其它文件（`server/target`、`参考/`、`resources/` 等）⇒ **在 Terminal（非沙箱）**跑
//     `brctl download <目录>`；沙箱内 `brctl` 会被拒绝（`Trying to invoke brctl from a sandboxed process`）。
//
// 本脚本只读 `stat`，**不读取任何文件内容**——正因如此它自己不会被占位文件卡住。

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const wantJson = argv.includes('--json');
const failIndex = argv.indexOf('--fail-under');
const failUnder = failIndex >= 0 ? Number(argv[failIndex + 1]) : null;

const IGNORED_DIRS = new Set(['.git']);

const groups = new Map();
let total = 0;
let totalBytes = 0;

function walk(dir, top) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full, top); continue; }
    if (!entry.isFile()) continue;
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.blocks === 0 && stat.size > 0) {
      total += 1;
      totalBytes += stat.size;
      const bucket = groups.get(top) ?? { count: 0, bytes: 0, sample: [] };
      bucket.count += 1;
      bucket.bytes += stat.size;
      if (bucket.sample.length < 3) bucket.sample.push(path.relative(ROOT, full));
      groups.set(top, bucket);
    }
  }
}

for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue;
  walk(path.join(ROOT, entry.name), entry.name);
}

const mb = value => Number((value / 1048576).toFixed(1));
const ranked = [...groups].sort((a, b) => b[1].bytes - a[1].bytes).map(([area, v]) => ({
  area, count: v.count, mb: mb(v.bytes), sample: v.sample,
}));

if (wantJson) {
  console.log(JSON.stringify({ total, totalMb: mb(totalBytes), areas: ranked }, null, 2));
} else {
  console.log(`iCloud 占位文件：${total} 个 / ${mb(totalBytes)}MB`);
  if (total === 0) {
    console.log('全部已落地，无需处理。');
  } else {
    console.log('');
    for (const row of ranked) {
      console.log(`  ${row.area.padEnd(18)}${String(row.count).padStart(7)} 个 ${String(row.mb).padStart(9)}MB`);
      for (const s of row.sample) console.log(`        e.g. ${s}`);
    }
    console.log('');
    console.log('修法：node_modules ⇒ 删目录 + npm install --prefer-offline；');
    console.log('      其它 ⇒ 在 Terminal（非沙箱）brctl download <目录>。');
  }
}

if (failUnder !== null && Number.isFinite(failUnder) && total > failUnder) {
  console.error(`占位文件 ${total} 个，超过允许的 ${failUnder} 个。`);
  process.exit(1);
}
