const wz = require('@tybys/wz');
const path = require('node:path');
const DATA = '/Users/muniao/Library/Mobile Documents/com~apple~CloudDocs/游戏/github/MapleStory/参考/273/TMS273少爷一键端/客户端/TMS273.7/Data';
const val = (o, n) => { const p = o && o.at && o.at(n); if (!p) return undefined; return p.value === undefined ? p.wzValue : p.value; };

(async () => {
  const f = new wz.WzFile(path.join(DATA, 'UI/UI_000.wz'), wz.WzMapleVersion.BMS, 273);
  await f.parseWzFile();
  const img = f.wzDirectory.at('ChatEmoticon.img');
  await img.parseImage();
  const panel = img.at('UI').at('ChatEmoticon');
  for (const p of panel.wzProperties) {
    const kids = p.wzProperties ? [...p.wzProperties].map(k => k.name) : null;
    if (kids) {
      console.log(p.name + ' [' + kids.join(',') + ']');
    } else {
      console.log(p.name + ' = ' + JSON.stringify(p.value === undefined ? p.wzValue : p.value));
    }
  }
  const info = n => {
    const node = panel.at(n);
    if (!node) return console.log(n + ': <missing>');
    const png = node.pngProperty;
    console.log(n + ': ' + (png ? png.width + 'x' + png.height : 'no-png') + ' origin=' + JSON.stringify(val(node, 'origin')));
  };
  console.log('--- leaf sizes ---');
  for (const n of ['backgrnd', 'groupBase', 'groupSelect', 'bookmark_ON', 'bookmark_OFF', 'pageIcon', 'groupOffset', 'groupSpace']) info(n);
  console.log('groupCount =', JSON.stringify(val(panel, 'groupCount')));
  console.log('groupSpace =', JSON.stringify(val(panel, 'groupSpace')));
  console.log('groupOffset =', JSON.stringify(val(panel, 'groupOffset')));
  console.log('groupSelect =', JSON.stringify(val(panel, 'groupSelect')));
  console.log('groupBase =', JSON.stringify(val(panel, 'groupBase')));
  f.dispose();
})().catch(e => { console.error(e.stack || e); process.exit(1); });
