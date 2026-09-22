#!/usr/bin/env node
// 只读探针：优惠券 0243076 8-771 在权威客户端 WZ 里的节点情况。
const path = require('node:path');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const IDS = ['02430768', '02430769', '02430770', '02430771'];
const FIELDS = ['slotExpand', 'slotMax', 'price', 'notConsume', 'tradeBlock'];

(async () => {
  const reader = createReader(DATA);
  try {
    for (const id of IDS) {
      const logical = `Item/Consume/0243.img/${id}`;
      let node;
      try { node = await reader.get(logical); }
      catch (error) { console.log(`${id}  ❌ ${error.message.slice(0, 70)}`); continue; }
      if (typeof node.parseImage === 'function' && !node.parsed) await node.parseImage();
      const info = node.at('info');
      if (info && typeof info.parseImage === 'function' && !info.parsed) await info.parseImage();
      const read = name => {
        const p = info?.at(name);
        if (!p) return null;
        const v = p.value ?? p.wzValue;
        return v && typeof v === 'object' ? JSON.stringify(v) : v;
      };
      const fields = Object.fromEntries(FIELDS.map(f => [f, read(f)]));
      const hasIcon = info?.at('icon') != null;
      console.log(`${id}  ✅ 存在  ${JSON.stringify(fields)}  info/icon=${hasIcon}`);
    }
  } finally { reader.close?.(); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
