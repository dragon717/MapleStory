#!/usr/bin/env node
// 探针：坐骑 / 椅子图标的权威路径与 frame() 解析结果。
const fs = require('node:fs');
const path = require('node:path');
const avatar = require('./export_tms273_avatar.cjs');
const { reader, ASSETS, get } = avatar;

const SOURCES = [
  'Character/TamingMob/01902000.img/info/icon',
  'Character/TamingMob/01902004.img/info/icon',
  'Character/TamingMob/01902035.img/info/icon',
  'Item/Install/03010001.img/info/icon',
  'Item/Install/03010001.img/icon',
  'Item/Install/03010001.img/info',
];

(async () => {
  for (const s of SOURCES) {
    try {
      const node = await get(s);
      const keys = [...(node.wzProperties ?? [])].map(x => x.name).slice(0, 10).join(',');
      console.log(`OK   ${s} :: 子项=[${keys}]`);
    } catch (error) {
      console.log(`FAIL ${s} :: ${error.message.slice(0, 80)}`);
      continue;
    }
    try {
      const frame = await reader.frame(s, ASSETS);
      const file = path.join(ASSETS, path.basename(frame.url ?? ''));
      console.log(`     frame url=${frame.url} ${frame.width}x${frame.height} origin=${JSON.stringify(frame.origin)} 落盘=${fs.existsSync(file) ? fs.statSync(file).size + 'B' : '无'}`);
    } catch (error) {
      console.log(`     frame 失败 :: ${error.message.slice(0, 90)}`);
    }
  }
  reader.close?.();
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
