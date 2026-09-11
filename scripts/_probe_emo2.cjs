const wz = require('@tybys/wz');
const path = require('node:path');
const DATA = '/Users/muniao/Library/Mobile Documents/com~apple~CloudDocs/游戏/github/MapleStory/参考/273/TMS273少爷一键端/客户端/TMS273.7/Data';
const val = (o, n) => { const p = o && o.at && o.at(n); if (!p) return undefined; return p.value === undefined ? p.wzValue : p.value; };

function dump(node, depth, maxDepth, name) {
  const kids = node.wzProperties ? [...node.wzProperties] : null;
  const pads = '  '.repeat(depth);
  if (kids && depth < maxDepth) {
    console.log(pads + name + ' [' + kids.map(k => k.name).slice(0, 18).join(',') + (kids.length > 18 ? ',...(' + kids.length + ')' : '') + ']');
    for (const k of kids) dump(k, depth + 1, maxDepth, k.name);
  } else if (kids) {
    const kids2 = kids.map(k => k.name);
    console.log(pads + name + ' [' + kids2.slice(0, 18).join(',') + (kids2.length > 18 ? ',...(' + kids2.length + ')' : '') + ']');
  } else {
    console.log(pads + name + ' = ' + JSON.stringify(node.value === undefined ? node.wzValue : node.value));
  }
}

(async () => {
  const f = new wz.WzFile(path.join(DATA, 'UI/UI_000.wz'), wz.WzMapleVersion.BMS, 273);
  await f.parseWzFile();
  const img = f.wzDirectory.at('ChatEmoticon.img');
  await img.parseImage();
  console.log('===== UI/ChatEmoticon =====');
  dump(img.at('UI').at('ChatEmoticon'), 0, 3, 'ChatEmoticon');
  console.log('===== UI/FavoriteEmoticonBar =====');
  dump(img.at('UI').at('FavoriteEmoticonBar'), 0, 3, 'FavoriteEmoticonBar');
  f.dispose();
})().catch(e => { console.error(e.stack || e); process.exit(1); });
