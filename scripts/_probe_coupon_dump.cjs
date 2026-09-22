#!/usr/bin/env node
// 只读探针：从权威客户端 WZ 读优惠券的 info/spec 字段，按 WZ_JSON_TW 形状重建 JSON。
// 自校验：768/769/770 的重建结果必须与既有文件完全一致，才允许据此生成 771。
const fs = require('node:fs');
const path = require('node:path');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const TREE = path.join(ROOT, '参考/273/TMS273少爷一键端/手工服务端/tms273/WZ_JSON_TW/Item/Consume/0243');
const IDS = ['02430768', '02430769', '02430770', '02430771'];

function scalar(prop) {
  if (!prop) return null;
  let v = prop.value;
  if (v === undefined || v === null) v = prop.wzValue;
  return v;
}

(async () => {
  const reader = createReader(DATA);
  const built = {};
  try {
    for (const id of IDS) {
      let img;
      try { img = await reader.get(`Item/Consume/0243.img/${id}`); }
      catch (error) { console.log(`${id} ❌ ${error.message.slice(0, 60)}`); continue; }
      if (typeof img.parseImage === 'function' && !img.parsed) await img.parseImage();
      const info = img.at('info');
      const spec = img.at('spec');
      const num = (node, field) => {
        const v = scalar(node?.at(field));
        return v === null || v === undefined ? null : String(v);
      };
      const str = (node, field) => {
        const v = scalar(node?.at(field));
        return v === null || v === undefined ? null : String(v);
      };
      const json = {
        info: {
          _dirType: 'sub',
          slotMax: { _dirType: 'int', _value: num(info, 'slotMax') },
          price: { _dirType: 'int', _value: num(info, 'price') },
          notConsume: { _dirType: 'int', _value: num(info, 'notConsume') },
          slotExpand: { _dirType: 'int', _value: num(info, 'slotExpand') },
        },
        spec: {
          _dirType: 'sub',
          script: { _dirType: 'string', _value: str(spec, 'script') },
          npc: { _dirType: 'int', _value: num(spec, 'npc') },
        },
        _dirType: 'sub',
      };
      // 既有文件里 768/769/770 的 info 字段顺序是 slotMax/price/notConsume/slotExpand，
      // 770 的顺序不同但内容相同 —— 比对按**解析后的对象**，不按字符串。
      const text = JSON.stringify(json);
      built[id] = text;
      const file = path.join(TREE, `${id}.json`);
      if (fs.existsSync(file)) {
        const a = JSON.parse(fs.readFileSync(file, 'utf8'));
        const b = JSON.parse(text);
        const same = JSON.stringify(a) === JSON.stringify(b) ||
          JSON.stringify(sortDeep(a)) === JSON.stringify(sortDeep(b));
        console.log(`${id}  ${same ? '✅ 与既有文件语义一致' : '⚠️ 与既有文件不一致'}`);
      } else {
        console.log(`${id}  (树里没有该文件，重建如下)\n     ${text}`);
      }
    }
  } finally { reader.close?.(); }
  fs.writeFileSync('/tmp/coupon_02430771.json', built['02430771'] ?? '', 'utf8');
  console.log('\n771 重建结果已写到 /tmp/coupon_02430771.json');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, sortDeep(value[k])]));
  }
  return value;
}
