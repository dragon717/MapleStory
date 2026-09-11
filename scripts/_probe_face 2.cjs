const wz = require('@tybys/wz');
const DATA = '/Users/muniao/Library/Mobile Documents/com~apple~CloudDocs/游戏/github/MapleStory/参考/273/TMS273少爷一键端/客户端/TMS273.7/Data';
(async () => {
  for (const file of ['Face.wz', 'Face_000.wz']) {
    const f = new wz.WzFile(DATA + '/Character/Face/' + file, wz.WzMapleVersion.BMS, 273);
    console.log(file, 'parse', await f.parseWzFile());
    const root = f.wzDirectory;
    console.log('  dirs:', [...root.wzDirectories].map(d=>d.name));
    console.log('  images:', [...root.wzImages].map(i=>i.name).slice(0,5), 'count', [...root.wzImages].length);
    f.dispose();
  }
})().catch(e => { console.error(e.stack || e); process.exit(1); });
