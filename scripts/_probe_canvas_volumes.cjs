#!/usr/bin/env node
// 一次性探针：枚举 Skill/_Canvas/_Canvas_*.wz 各分卷的顶层映像名，
// 建立「技能书 → 像素所在分卷」的映射。用完即删（见 skill §12.2）。
const fs = require('node:fs');
const path = require('node:path');
const wz = require('@tybys/wz');

const ROOT = path.resolve(__dirname, '..');
const CANVAS = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data/Skill/_Canvas');

async function main() {
  await wz.init();
  const files = fs.readdirSync(CANVAS).filter(n => /^_Canvas_\d+\.wz$/i.test(n)).sort();
  const byVolume = {};
  for (const name of files) {
    const file = new wz.WzFile(path.join(CANVAS, name), wz.WzMapleVersion.BMS, 273);
    const status = await file.parseWzFile();
    if (status !== wz.WzFileParseStatus.SUCCESS) {
      byVolume[name] = { error: wz.getErrorDescription(status) };
      file.dispose();
      continue;
    }
    const images = [...file.wzDirectory.wzImages].map(image => image.name);
    byVolume[name] = images;
    file.dispose();
  }
  fs.writeFileSync(path.join(ROOT, 'scripts/_probe_canvas_volumes.json'), `${JSON.stringify(byVolume, null, 1)}\n`);
  const summary = Object.fromEntries(Object.entries(byVolume).map(([name, images]) => [name, Array.isArray(images) ? images.length : images]));
  console.log(JSON.stringify(summary, null, 1));
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
