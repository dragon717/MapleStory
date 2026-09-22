// 临时取证：源 `MapList/<n>` 到底有没有「每个点自己的美术」。
// 结论决定「世界地图只显示当前点」是导出漏了，还是源本来就这样。
'use strict';
const path = require('node:path');
const wz = require('@tybys/wz');
const { createReader } = require('./tms273_wz.cjs');

const DATA = path.join(__dirname, '..', '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const reader = createReader(DATA);
const children = n => [...(n?.wzProperties ?? [])];

(async () => {
  for (const page of ['WorldMap', 'WorldMap000', 'WorldMap010']) {
    const node = await reader.get(`Map/WorldMap/${page}.img`);
    if (node instanceof wz.WzImage) await node.parseImage();
    const list = node.at('MapList');
    const entries = children(list);
    console.log(`\n=== ${page}: MapList ${entries.length} 条 ===`);
    for (const entry of entries.slice(0, 3)) {
      const kids = children(entry).map(child => {
        const kind = child.constructor?.name ?? '?';
        const value = child.wzValue;
        const shown = value && typeof value === 'object' ? JSON.stringify(value) : String(value);
        return `${child.name}(${kind}:${shown})`;
      });
      const grandkids = children(entry).flatMap(child => children(child).map(gc => `${child.name}/${gc.name}`));
      console.log(`  ${entry.name}: ${kids.join(' ')}`);
      if (grandkids.length) console.log(`     孙节点: ${grandkids.join(' ')}`);
    }
    console.log(`  BaseImg 子节点: ${children(node.at('BaseImg')).map(c => c.name).join(' ')}`);
    console.log(`  顶层节点: ${children(node).map(c => c.name).join(' ')}`);
  }
})().catch(error => { console.error(error.stack || error.message); process.exit(1); });
