#!/usr/bin/env node
// `buildAction` 的硬断言要求：body 帧必须有 `map.navel` + `map.neck`，arm 必须有 `map.hand`，
// head 必须有 `map.brow`（没有就 assert 失败，整套动作立不起来）。
// 这里逐条核对 **sit** 帧是否带齐这些锚点，以及各装备层用哪个锚点落位。
const fs = require('node:fs');
const path = require('node:path');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = '/Users/muniao/Code/MapleStory';
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');

const CASES = [
  ['body    ', 'Character/00002000.img', ['body', 'arm', 'face']],
  ['head    ', 'Character/00012000.img', ['head']],
  ['hair    ', 'Character/Hair/00030020.img', ['hairOverHead', 'hair', 'hairShade', 'hairBelowBody']],
  ['pants   ', 'Character/Pants/01060003.img', ['pants']],
  ['shoes   ', 'Character/Shoes/01070000.img', ['shoes']],
  ['cap     ', 'Character/Cap/01002067.img', ['default']],
  ['coat    ', 'Character/Coat/01040002.img', ['mail', 'mailArm']],
  ['longcoat', 'Character/Longcoat/01052095.img', ['mail', 'mailArm']],
];

(async () => {
  const reader = createReader(DATA);
  try {
    for (const [label, image, layers] of CASES) {
      console.log(`\n${label} ${image} :: sit/0`);
      for (const layer of layers) {
        let node;
        try {
          node = await reader.get(`${image}/sit/0/${layer}`);
        } catch (e) {
          console.log(`   ${layer.padEnd(14)} ✗ ${e.message}`);
          continue;
        }
        const f = await reader.frame(node, null).catch(e => ({ error: e.message }));
        if (f.error) { console.log(`   ${layer.padEnd(14)} frame ✗ ${f.error}`); continue; }
        const mapKeys = Object.keys(f.map || {});
        console.log(`   ${layer.padEnd(14)} ${String(f.width + 'x' + f.height).padEnd(8)} origin=${JSON.stringify(f.origin)} map={${mapKeys.join(',')}}${mapKeys.length ? ' ' + JSON.stringify(f.map) : ''}`);
      }
    }
  } finally {
    reader.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
