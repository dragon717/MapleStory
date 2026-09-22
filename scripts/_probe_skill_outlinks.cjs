#!/usr/bin/env node
// 一次性探针：把目标技能书的 `Skill/<book>.img` 解包后**递归走一遍节点树**，
// 收集全部 `_outlink` 字符串，反查出每个外链目标映像所在 `_Canvas_XXX.wz` 分卷。
//
// 为什么要走 WZ 而不是 JSON：`Skill/<book>.json` 这份导出**不含 `_outlink`**
// （实测：对 24 本目标书递归扫 `_outlink` 键，0 命中），外链只存在于打包映像里。
// 用完即删（见 skill §12.2）。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const wz = require('@tybys/wz');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const UNPACKER = path.join(ROOT, 'scripts/unpack_tms273_ms/target/debug/unpack_tms273_ms');
const TARGETS = ['100', '110', '111', '112', '120', '121', '122', '130', '131', '132',
  '300', '310', '311', '312', '320', '321', '322', '400', '410', '411', '412', '420', '421', '422'];

function collectOutlinks(node, out, depth = 0) {
  if (!node || depth > 12) return out;
  const props = node.wzProperties ? [...node.wzProperties] : [];
  for (const child of props) {
    if (child.name === '_outlink' || child.name === '_inlink') {
      const value = child.value ?? child.wzValue;
      if (typeof value === 'string' && value.length) out.push({ from: node.fullPath ?? null, link: value });
      continue;
    }
    collectOutlinks(child, out, depth + 1);
  }
  return out;
}

async function main() {
  await wz.init();
  const images = TARGETS.map(book => `Skill/${book}.img`);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tms273-outlink-'));
  try {
    const result = spawnSync(UNPACKER, ['--packs', path.join(DATA, 'Packs'), '--out', tempRoot,
      ...images.flatMap(image => ['--image', image])], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`解包失败:\n${result.stdout}\n${result.stderr}`);
    const reader = createReader(tempRoot, tempRoot);
    const byBook = {};
    const needed = new Set();
    for (const book of TARGETS) {
      // ⚠️ `reader.get` 返回的 WzImage 要先 `await parseImage()` 才能 `wzProperties`，
      // 否则抛 `Image has not been parsed yet`（skill「@tybys/wz 使用坑」第 3 条）。
      const image = await reader.get(`Skill/${book}.img`);
      if (image instanceof wz.WzImage) await image.parseImage();
      const found = collectOutlinks(image, []);
      const links = [...new Set(found.map(item => item.link))].sort();
      byBook[book] = links;
      for (const link of links) {
        const match = /^Skill\/_Canvas\/([^/]+\.img)\//.exec(link);
        if (match && match[1] !== `${book}.img`) needed.add(match[1]);
      }
    }
    reader.close();
    const volumes = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/_probe_canvas_volumes.json'), 'utf8'));
    const rev = {};
    for (const [volume, names] of Object.entries(volumes)) {
      if (!Array.isArray(names)) continue;
      for (const name of names) (rev[name] ??= []).push(volume);
    }
    const report = { byBook, neededImages: {}, volumesByBook: {} };
    for (const image of [...needed].sort()) report.neededImages[image] = (rev[image] ?? []).sort();
    for (const book of TARGETS) {
      const own = `_Canvas_${(fs.existsSync(path.join(ROOT, `scripts/_probe_book_volumes.json`))
        ? JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/_probe_book_volumes.json'), 'utf8'))[book] ?? ''
        : '')}`;
      const extra = new Set();
      for (const link of byBook[book]) {
        const match = /^Skill\/_Canvas\/([^/]+\.img)\//.exec(link);
        if (!match || match[1] === `${book}.img`) continue;
        for (const volume of report.neededImages[match[1]] ?? []) extra.add(volume.replace('_Canvas_', '').replace('.wz', ''));
      }
      report.volumesByBook[book] = { own, extra: [...extra].sort() };
    }
    fs.writeFileSync(path.join(ROOT, 'scripts/_probe_skill_outlinks.json'), `${JSON.stringify(report, null, 1)}\n`);
    console.log(JSON.stringify({ booksWithOutlinks: Object.entries(byBook).filter(([, v]) => v.length).length,
      neededImages: Object.keys(report.neededImages).length,
      volumesByBook: report.volumesByBook }, null, 1));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
