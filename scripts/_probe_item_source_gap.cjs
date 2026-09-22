#!/usr/bin/env node
// 只读探针：确认 1312004 是否属于 TMS273 客户端 WZ（而非 WZ_JSON_TW 抽取遗漏）。
// 只用 reader.get() 导航，不调用 reader.frame()，因此不会导出任何产物。
const path = require('node:path');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');

// 与 character-creation.json gender0 的 weapon 列表一一对应
const IDS = ['01302000', '01312004', '01322005'];
const FIELDS = ['islot', 'vslot', 'reqJob', 'reqLevel', 'incPAD', 'price', 'cash'];

function val(node) {
  if (node == null) return null;
  if (typeof node === 'object' && 'wzValue' in node) return node.wzValue;
  return node;
}

(async () => {
  const reader = createReader(DATA);
  try {
    for (const id of IDS) {
      const logical = `Character/Weapon/${id}.img`;
      let node;
      try {
        node = await reader.get(logical);
      } catch (error) {
        console.log(`${id}  ❌ 客户端 WZ 无此映像：${error.message.slice(0, 90)}`);
        continue;
      }
      if (typeof node.parseImage === 'function' && !node.parsed) await node.parseImage();
      const info = node.at('info');
      if (info && typeof info.parseImage === 'function' && !info.parsed) await info.parseImage();
      const fields = {};
      for (const field of FIELDS) {
        fields[field] = val(info?.at(field));
      }
      const hasIcon = info?.at('icon') != null;
      console.log(`${id}  ✅ 存在  ${JSON.stringify(fields)}  icon=${hasIcon}`);
    }
  } finally {
    reader.close?.();
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
