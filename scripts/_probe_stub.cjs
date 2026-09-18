#!/usr/bin/env node
// 探针：pants / weapon 的帧解析到底给出真像素还是空壳？
const fs = require('node:fs');
const path = require('node:path');
const wz = require('@tybys/wz');
const avatar = require('./export_tms273_avatar.cjs');
const { reader, ASSETS } = avatar;

const SOURCES = [
  'Character/Pants/01060003.img/walk1/0/pants',
  'Character/Pants/01060003.img/walk1/1/pants',
  'Character/Pants/_Canvas/01060003.img/walk1/1/pants',
  'Character/Weapon/01312004.img/swingO2/2/weapon',
  'Character/00002000.img/stand1/0/body',
];

function pngSize(buf) {
  if (buf.length < 24) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

(async () => {
  for (const s of SOURCES) {
    try {
      const node = await reader.get(s);
      const chainInfo = await reader.resolveFrame(node);
      const resolved = chainInfo.resolved;
      const inl = resolved.at?.('_inlink')?.wzValue;
      const outl = resolved.at?.('_outlink')?.wzValue;
      const bmp = await resolved.getBitmap();
      const buf = bmp ? Buffer.from(await bmp.getBufferAsync('image/png')) : null;
      const size = buf ? pngSize(buf) : null;
      const frame = await reader.frame(s, ASSETS);
      const file = path.join(ASSETS, path.basename(frame.url ?? ''));
      console.log(`${s}`);
      console.log(`   链长=${chainInfo.chain.length} 终态=${resolved?.constructor?.name} 段数=${chainInfo.chain.length}`);
      console.log(`   inlink=${inl ?? '-'} outlink=${outl ?? '-'}`);
      console.log(`   位图=${buf ? buf.length + 'B ' + (size ? size.w + 'x' + size.h : '?') : 'null'}`);
      console.log(`   frame: url=${frame.url} w=${frame.width} h=${frame.height} src=${frame.resolvedSource}`);
      console.log(`   落盘=${fs.existsSync(file) ? fs.statSync(file).size + 'B' : '不存在'}`);
    } catch (error) {
      console.log(`${s}\n   异常 ${error.message.slice(0, 110)}`);
    }
  }
  reader.close?.();
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
