const wz = require('@tybys/wz');
const path = require('node:path');
const fs = require('node:fs');
const DATA = '/Users/muniao/Library/Mobile Documents/com~apple~CloudDocs/游戏/github/MapleStory/参考/273/TMS273少爷一键端/客户端/TMS273.7/Data';
const filter = (process.argv[2] || '').toLowerCase();

(async () => {
  const dir = path.join(DATA, 'UI');
  const files = fs.readdirSync(dir).filter(n => /^UI(_\d+)?\.wz$/i.test(n)).sort();
  for (const file of files) {
    const f = new wz.WzFile(path.join(dir, file), wz.WzMapleVersion.BMS, 273);
    const status = await f.parseWzFile();
    if (status !== 1) { console.log(file, 'parse fail', status); continue; }
    const walk = (node, prefix) => {
      const dirs = [...node.wzDirectories].map(d => d.name);
      const imgs = [...node.wzImages].map(i => i.name);
      for (const d of dirs) walk(node.at(d), prefix + d + '/');
      for (const i of imgs) {
        const full = prefix + i;
        if (!filter || full.toLowerCase().includes(filter)) console.log(file + ' :: ' + full);
      }
    };
    walk(f.wzDirectory, '');
    f.dispose();
  }
})().catch(e => { console.error(e.stack || e); process.exit(1); });
