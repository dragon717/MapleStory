#!/usr/bin/env node
// 只读探针：新增道具的图标在权威客户端 WZ 里到底存不存在。
// 只调 reader.get()，不调 frame()，不落盘。
const fs = require('node:fs');
const path = require('node:path');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const fill = new Set(
  fs.readFileSync('/tmp/wz_json_gap_fill_manifest.txt', 'utf8')
    .split('\n').map(s => s.trim()).filter(Boolean).map(s => s.replace(/^\.\//, '')),
);

const items = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources/tms273-export/items.json'), 'utf8'));
const old = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/items.json'), 'utf8'));
const added = Object.keys(items).filter(id => !(id in old)).sort();

(async () => {
  const reader = createReader(DATA);
  const ok = [], missing = [];
  try {
    for (const id of added) {
      const sprite = items[id].spriteSource;
      const src = items[id].source;
      const restored = fill.has(src) || fill.has(String(src).replace(/^参考[^/]*\//, ''));
      try {
        await reader.get(sprite);
        ok.push({ id, sprite, restored, source: src });
      } catch (error) {
        missing.push({ id, sprite, restored, source: src, raw: items[id].spriteSourceRaw });
      }
    }
  } finally {
    reader.close?.();
  }
  console.log(`新增 ${added.length}：客户端 WZ 有图标 ${ok.length}，缺 ${missing.length}`);
  console.log('\n--- 缺图标的（前 20）---');
  for (const m of missing.slice(0, 20)) console.log(`  ${m.id}  ${m.sprite}  stats来自补入=${m.restored}`);
  console.log('\n--- 有图标的（前 10）---');
  for (const m of ok.slice(0, 10)) console.log(`  ${m.id}  ${m.sprite}`);
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
