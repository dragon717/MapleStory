const { createReader } = require('./tms273_wz.cjs');
const wz = require('@tybys/wz');
const DATA = '/Users/muniao/Library/Mobile Documents/com~apple~CloudDocs/游戏/github/MapleStory/参考/273/TMS273少爷一键端/客户端/TMS273.7/Data';
(async () => {
  const f = new wz.WzFile(DATA + '/Character/Face/Face.wz', wz.WzMapleVersion.BMS, 273);
  console.log('parse', await f.parseWzFile());
  const names = [...f.wzDirectory.wzImages].map(i => i.name);
  console.log('faces count', names.length, names.slice(0, 10));
  const pick = names.find(n => n.startsWith('20000')) || names[0];
  const img = f.wzDirectory.at(pick);
  await img.parseImage();
  console.log('face', pick, 'props:', [...img.wzProperties].map(p => p.name));
  for (const p of img.wzProperties) {
    if (p.wzProperties) console.log('  ', p.name, '->', [...p.wzProperties].map(c => c.name).slice(0, 30));
    else console.log('  ', p.name, '(leaf)', typeof (p.value ?? p.wzValue));
  }
  f.dispose();
})().catch(e => { console.error(e.stack || e); process.exit(1); });
