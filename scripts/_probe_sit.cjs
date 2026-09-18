#!/usr/bin/env node
// 可行性判定：坐姿（sit）到底需要哪些部件？
// 契约（export_tms273_avatar.cjs L36-43）说只有 body/head + Cap/Longcoat/Coat/Hair 有 sit。
// 这里逐部位**实测**：结构健全的部位直接按逻辑路径读；结构被裁的部位退到 `_Canvas`
// 只读**树形**（节点名在镜像里保留，属性不保留），用来判断「sit 这一层在源里存不存在」。
const path = require('node:path');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = '/Users/muniao/Code/MapleStory';
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');

const SAMPLES = [
  ['body      ', 'Character/00002000.img'],
  ['head      ', 'Character/00012000.img'],
  ['face      ', 'Character/Face/00020000.img'],
  ['hair      ', 'Character/Hair/00030020.img'],
  ['pants     ', 'Character/Pants/01060003.img'],
  ['shoes     ', 'Character/Shoes/01070000.img'],
  ['cap       ', 'Character/Cap/01002067.img'],
  ['coat      ', 'Character/Coat/01040002.img'],
  ['longcoat  ', 'Character/Longcoat/01052095.img'],
  ['weapon    ', 'Character/Weapon/01302000.img'],
];

async function layerNames(reader, imagePath, action) {
  // 返回 {frames: n, layers: {frameIdx: [layerName,...]}} —— 逐帧枚举子节点名
  const out = {};
  for (let f = 0; ; f++) {
    try {
      const node = await reader.get(`${imagePath}/${action}/${f}`);
      const kids = node.wzProperties ? [...node.wzProperties] : [];
      if (!kids.length) break;
      out[f] = kids.map(k => k.name);
    } catch (e) {
      break;
    }
  }
  return out;
}

(async () => {
  const reader = createReader(DATA);
  try {
    for (const [label, imagePath] of SAMPLES) {
      // 哪些动作在源里存在？枚举 image 的直接子节点名。
      let actions = [];
      try {
        const img = await reader.get(imagePath);
        // 直接命中映像本身时，`getObject` 不会替它解析（只有继续往里走才会）；
        // 不解析就拿不到 `wzProperties`。
        if (typeof img.parseImage === 'function' && !img.parsed) await img.parseImage();
        actions = img.wzProperties ? [...img.wzProperties].map(p => p.name) : [];
      } catch (e) {
        console.log(`${label} ✗ ${e.message}`);
        continue;
      }
      const hasSit = actions.includes('sit');
      console.log(`\n${label} ${imagePath}`);
      console.log(`   动作数=${actions.length} 有 sit=${hasSit ? 'YES' : 'no'}`);
      if (hasSit) {
        const frames = await layerNames(reader, imagePath, 'sit');
        console.log(`   sit 帧: ${JSON.stringify(frames)}`);
        // 逐层读 z / origin
        for (const [f, names] of Object.entries(frames)) {
          for (const n of names) {
            try {
              const layer = await reader.get(`${imagePath}/sit/${f}/${n}`);
              const z = layer.at?.('z')?.wzValue;
              const og = layer.at?.('origin')?.wzValue;
              console.log(`      sit/${f}/${n}: z=${z ?? '无'} origin=${og ? JSON.stringify(og) : '无'}`);
            } catch (e) {
              console.log(`      sit/${f}/${n}: ✗ ${e.message}`);
            }
          }
        }
      }
    }
  } finally {
    reader.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
