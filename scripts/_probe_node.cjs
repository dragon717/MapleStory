const wz = require('@tybys/wz');
const path = require('node:path');
const fs = require('node:fs');
const DATA = '/Users/muniao/Library/Mobile Documents/com~apple~CloudDocs/游戏/github/MapleStory/参考/273/TMS273少爷一键端/客户端/TMS273.7/Data';

// usage: node _probe_node.cjs UI/UIEmoticonPanel.img [depth] [subpath]
const logical = process.argv[2];
const maxDepth = Number(process.argv[3] ?? 2);
const subPath = process.argv[4] || '';

function dump(node, depth, name) {
  const kids = node.wzProperties ? [...node.wzProperties] : null;
  const pads = '  '.repeat(depth);
  if (kids) {
    console.log(pads + name + ' [' + kids.map(k => k.name).slice(0, 20).join(',') + (kids.length > 20 ? ',...(' + kids.length + ')' : '') + ']');
    if (depth < maxDepth) for (const k of kids) dump(k, depth + 1, k.name);
  } else {
    const v = node.value === undefined ? node.wzValue : node.value;
    console.log(pads + name + ' = ' + JSON.stringify(v) + '  <' + (node.propertyType || '?') + '>');
  }
}

(async () => {
  const parts = logical.split('/');
  const imgIndex = parts.findIndex(s => /\.img$/i.test(s));
  const dir = path.join(DATA, ...parts.slice(0, imgIndex));
  const stem = parts[imgIndex - 1];
  const files = fs.readdirSync(dir).filter(n => new RegExp('^' + stem + '(_\\d+)?\\.wz$', 'i').test(n)).sort();
  for (const file of files) {
    const f = new wz.WzFile(path.join(dir, file), wz.WzMapleVersion.BMS, 273);
    if (await f.parseWzFile() !== 1) continue;
    let node = f.wzDirectory.at(parts[imgIndex]);
    if (!node) { f.dispose(); continue; }
    await node.parseImage();
    console.log('### ' + file + ' :: ' + logical);
    for (const seg of subPath.split('/').filter(Boolean)) { node = node.at(seg); if (!node) break; }
    if (node) dump(node, 0, subPath || logical);
    f.dispose();
    break;
  }
})().catch(e => { console.error(e.stack || e); process.exit(1); });
