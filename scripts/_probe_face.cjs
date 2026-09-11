const wz = require('@tybys/wz');
const DATA = '/Users/muniao/Library/Mobile Documents/com~apple~CloudDocs/游戏/github/MapleStory/参考/273/TMS273少爷一键端/客户端/TMS273.7/Data';
const target = process.argv[2] || '00020000.img';

function dump(node, depth, maxDepth) {
  for (const p of (node.wzProperties || [])) {
    const pads = '  '.repeat(depth);
    const kids = p.wzProperties ? [...p.wzProperties].map(c => c.name) : null;
    if (kids) {
      const head = kids.slice(0, 14).join(',');
      console.log(pads + p.name + ' [' + head + (kids.length > 14 ? ',...' : '') + ']');
      if (depth < maxDepth) dump(p, depth + 1, maxDepth);
    } else {
      console.log(pads + p.name + ' = ' + JSON.stringify(p.value === undefined ? p.wzValue : p.value));
    }
  }
}

(async () => {
  const f = new wz.WzFile(DATA + '/Character/Face/Face_000.wz', wz.WzMapleVersion.BMS, 273);
  await f.parseWzFile();
  const img = f.wzDirectory.at(target);
  await img.parseImage();
  console.log('=== ' + target + ' ===');
  dump(img, 0, 2);
  f.dispose();
})().catch(e => { console.error(e.stack || e); process.exit(1); });
