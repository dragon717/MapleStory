#!/usr/bin/env node
// 判定「用 stand1 几何代替 sit」有多离谱：量同一层在 stand1 与 sit 两张画布上的
// 像素尺寸差。若尺寸一致，说明这张画基本沿用同一构图；若差得远，替代就明显错位。
const fs = require('node:fs');
const path = require('node:path');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = '/Users/muniao/Code/MapleStory';
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const EXPORT = path.join(ROOT, 'resources/tms273-export');
const appearance = JSON.parse(fs.readFileSync(path.join(EXPORT, 'appearance.json'), 'utf8'));

const TARGETS = [
  ['body   ', 'Character/00002000.img', ['body', 'arm']],
  ['head   ', 'Character/00012000.img', ['head']],
  ['hair   ', 'Character/Hair/00030020.img', ['hair', 'hairOverHead']],
  ['pants  ', 'Character/Pants/01060003.img', ['pants']],
  ['shoes  ', 'Character/Shoes/01070000.img', ['shoes']],
  ['coat   ', 'Character/Coat/01040002.img', ['mail', 'mailArm']],
];

(async () => {
  const reader = createReader(DATA);
  try {
    // 9-17 基线里 stand 的第 0 帧，作为对照
    const baseParts = appearance.base['0'].actions.stand[0].parts;
    console.log('=== 9-17 基线 base.stand[0] ===');
    for (const p of baseParts) {
      console.log(`  ${String(p.name).padEnd(10)} ${p.width}x${p.height} origin=${JSON.stringify(p.origin)} x=${p.x} y=${p.y} z=${p.z} anchor=${p.anchor ?? '-'}`);
    }
    console.log('=== 9-17 基线 base.walk[0] / attack[0] 中 pants ===');
    for (const act of ['walk', 'attack', 'ladder']) {
      const f = appearance.base['0'].actions[act]?.[0];
      const p = f?.parts.find(x => x.name === 'pants');
      if (p) console.log(`  ${act}: ${p.width}x${p.height} origin=${JSON.stringify(p.origin)} x=${p.x} y=${p.y} anchor=${p.anchor ?? '-'}`);
    }

    console.log('\n=== 源镜像里 stand1 vs sit 的画布尺寸 ===');
    for (const [label, image, layers] of TARGETS) {
      for (const layer of layers) {
        const sizes = {};
        for (const action of ['stand1', 'sit']) {
          try {
            const node = await reader.get(`${image}/${action}/0/${layer}`);
            const f = await reader.frame(node, null);
            sizes[action] = `${f.width}x${f.height}`;
          } catch (e) {
            sizes[action] = `✗${e.message.slice(0, 28)}`;
          }
        }
        const same = sizes.stand1 === sizes.sit ? '  ← 同尺寸' : '';
        console.log(`  ${label} ${layer.padEnd(14)} stand1=${sizes.stand1.padEnd(10)} sit=${sizes.sit.padEnd(10)}${same}`);
      }
    }
  } finally {
    reader.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
