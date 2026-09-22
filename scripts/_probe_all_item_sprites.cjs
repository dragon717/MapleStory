#!/usr/bin/env node
// 只读探针：遍历 items.json 全部道具，统计 spriteSource 在客户端 WZ 里解析不了的清单。
// 只调 reader.get()，不调 frame()，不落盘。
const fs = require('node:fs');
const path = require('node:path');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const items = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources/tms273-export/items.json'), 'utf8'));
const oldImages = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources/tms273-export/item-images.json'), 'utf8'));

(async () => {
  const reader = createReader(DATA);
  const failed = [];
  let ok = 0;
  try {
    for (const [id, item] of Object.entries(items)) {
      const sprite = item.spriteSource;
      if (!sprite || sprite.includes('*')) { failed.push({ id, sprite, why: 'spriteSource 缺失/带通配符' }); continue; }
      try { await reader.get(sprite); ok += 1; }
      catch (error) { failed.push({ id, sprite, why: error.message.slice(0, 60), hasOldImage: id in oldImages }); }
    }
  } finally { reader.close?.(); }
  console.log(`items.json=${Object.keys(items).length}  sprite 可解析=${ok}  失败=${failed.length}`);
  const withImg = failed.filter(f => f.hasOldImage).length;
  console.log(`失败项中「既有 item-images.json 已有条目」的=${withImg}，真正没有条目的=${failed.length - withImg}`);
  console.log('\n--- 失败清单（前 30，带 hasOldImage）---');
  for (const f of failed.slice(0, 30)) console.log(`  ${f.id}  hasOldImage=${f.hasOldImage}  ${f.sprite}  ${f.why}`);
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
