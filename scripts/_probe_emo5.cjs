const wz = require('@tybys/wz');
const path = require('node:path');
const DATA = '/Users/muniao/Library/Mobile Documents/com~apple~CloudDocs/游戏/github/MapleStory/参考/273/TMS273少爷一键端/客户端/TMS273.7/Data';

function shape(node, depth, maxDepth, name) {
  const kids = node.wzProperties ? [...node.wzProperties] : null;
  const pads = '  '.repeat(depth);
  if (kids) {
    console.log(pads + name + ' [' + kids.map(k => k.name).slice(0, 14).join(',') + (kids.length > 14 ? ',...(' + kids.length + ')' : '') + ']');
    if (depth < maxDepth) for (const k of kids.slice(0, 6)) shape(k, depth + 1, maxDepth, k.name);
  } else {
    console.log(pads + name + ' = ' + JSON.stringify(node.value === undefined ? node.wzValue : node.value));
  }
}

(async () => {
  const f = new wz.WzFile(path.join(DATA, 'UI/UI_000.wz'), wz.WzMapleVersion.BMS, 273);
  await f.parseWzFile();
  const img = f.wzDirectory.at('ChatEmoticon.img');
  await img.parseImage();
  const set = img.at('Emoticon').at('1000').at('10000001');
  console.log('=== Emoticon/1000/10000001 ===');
  shape(set, 0, 3, '10000001');
  console.log('=== 1000/10000001/effect ===');
  shape(img.at('Emoticon').at('1000').at('10000001').at('effect'), 0, 2, 'effect');

  // totals
  const sets = img.at('Emoticon');
  let stickers = 0, frames = 0;
  const perSet = [];
  for (const s of sets.wzProperties) {
    const items = [...s.wzProperties].filter(p => /^\d+$/.test(p.name));
    stickers += items.length;
    perSet.push(s.name + ':' + items.length);
  }
  console.log('total sets', perSet.length, 'total stickers', stickers);
  console.log(perSet.join(' '));
  f.dispose();
})().catch(e => { console.error(e.stack || e); process.exit(1); });
