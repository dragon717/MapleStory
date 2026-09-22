// 临时取证：新图 NPC 的 `stand` 像素到底指到哪儿、为什么 3001359 取不到。
'use strict';
const path = require('node:path');
const wz = require('@tybys/wz');
const { createReader } = require('./tms273_wz.cjs');

const DATA = path.join(__dirname, '..', '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const reader = createReader(DATA, path.join(__dirname, '..', 'resources/tms273-export', 'ms'));
const children = n => [...(n?.wzProperties ?? [])];
const val = (n, k, fallback = null) => n?.at?.(k)?.wzValue ?? fallback;

(async () => {
  for (const id of ['9040000', '9040002', '9040008', '9040011', '1022102', '9010113', '3001359']) {
    const source = `Npc/${id.padStart(7, '0')}.img`;
    let node;
    try {
      node = await reader.get(source);
      if (node instanceof wz.WzImage) await node.parseImage();
    } catch (error) {
      console.log(`${id}: 源里打不开 ${source} → ${error.message}`);
      continue;
    }
    const info = node.at('info');
    const link = val(info, 'link');
    const standChildren = children(node.at('stand')).map(c => c.name);
    console.log(`\n${id}: info.link=${link}  stand 子节点=[${standChildren.join(' ')}]`);
    for (const frame of standChildren.slice(0, 1)) {
      for (const logicalPath of [`${source}/stand/${frame}`, `Npc/${String(link ?? id).padStart(7, '0')}.img/stand/${frame}`]) {
        try {
          const out = await reader.frame(logicalPath, null);
          console.log(`   ${logicalPath} → OK ${out.width}x${out.height} resolved=${out.resolvedSource}`);
        } catch (error) {
          console.log(`   ${logicalPath} → ${error.message}`);
        }
      }
    }
  }
})().catch(error => { console.error(error.stack || error.message); process.exit(1); });
