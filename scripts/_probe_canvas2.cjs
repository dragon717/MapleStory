#!/usr/bin/env node
// 决定性探针 v2：复用仓库自己的 reader（已证明能用），对比
// 「结构分卷里的画布节点」与「_Canvas 并行树里的同名节点」各带哪些属性。
const path = require('node:path');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = '/Users/muniao/Code/MapleStory';
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');

function dump(node, label) {
  if (!node) { console.log(`  ${label}: <null>`); return; }
  const props = node.wzProperties ? [...node.wzProperties] : null;
  console.log(`  ${label}: ${node.constructor.name} name=${node.name} props=${props ? props.length : 'n/a'}`);
  if (props) {
    for (const p of props) {
      let v;
      try { v = JSON.stringify(p.wzValue); } catch { v = '<err>'; }
      if (typeof v === 'string' && v.length > 90) v = v.slice(0, 90) + '…';
      console.log(`      · ${p.name} = ${v}`);
    }
  }
}

(async () => {
  const reader = createReader(DATA);
  try {
    const targets = [
      ['结构健全 · Coat', 'Character/Coat/01040003.img/stand1/0/coat'],
      ['结构健全 · Coat 的 _Canvas 镜像', 'Character/Coat/_Canvas/01040003.img/stand1/0/coat'],
      ['结构被裁 · Pants', 'Character/Pants/01060003.img/stand1/0/pants'],
      ['结构被裁 · Pants 的 _Canvas 镜像', 'Character/Pants/_Canvas/01060003.img/stand1/0/pants'],
      ['结构被裁 · Weapon weapon3', 'Character/Weapon/01212000.img/stand1/0/weapon3'],
      ['结构被裁 · Weapon 的 _Canvas 镜像', 'Character/Weapon/_Canvas/01212000.img/stand1/0/weapon3'],
    ];
    for (const [label, logical] of targets) {
      console.log(`\n=== ${label} ===\n  path: ${logical}`);
      let node;
      try {
        node = await reader.get(logical);
      } catch (e) {
        console.log(`  ✗ ${e.message}`);
        continue;
      }
      dump(node, '节点');
      const origin = node.at?.('origin');
      const z = node.at?.('z');
      const outlink = node.at?.('_outlink')?.wzValue;
      const inlink = node.at?.('_inlink')?.wzValue;
      console.log(`      >>> origin=${origin ? JSON.stringify(origin.wzValue) : '无'}  z=${z ? z.wzValue : '无'}  _outlink=${outlink ?? '无'}  _inlink=${inlink ?? '无'}`);
      try {
        const f = await reader.frame(node, null);
        console.log(`      >>> frame(): origin=${JSON.stringify(f.origin)} x=${f.x} y=${f.y} w=${f.width} h=${f.height} resolvedSource=${f.resolvedSource}`);
      } catch (e) {
        console.log(`      >>> frame() ✗ ${e.message}`);
      }
    }
  } finally {
    reader.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
