const wz = require('@tybys/wz');
const path = require('node:path');
const fs = require('node:fs');
const DATA = '/Users/muniao/Library/Mobile Documents/com~apple~CloudDocs/游戏/github/MapleStory/参考/273/TMS273少爷一键端/客户端/TMS273.7/Data';

const val = (o, n) => {
  const p = o && o.at && o.at(n);
  if (!p) return undefined;
  return p.value === undefined ? p.wzValue : p.value;
};

(async () => {
  const f = new wz.WzFile(path.join(DATA, 'UI/UI_000.wz'), wz.WzMapleVersion.BMS, 273);
  console.log('parse', await f.parseWzFile());
  const img = f.wzDirectory.at('ChatEmoticon.img');
  await img.parseImage();
  const top = k => img.at(k);
  console.log('ChatLimit:', JSON.stringify({ count: val(top('ChatLimit'), 'count'), time: val(top('ChatLimit'), 'time') }));
  const set = top('Emoticon');
  const ids = [...set.wzProperties].map(p => p.name);
  console.log('Emoticon sets:', ids.length, ids.join(','));
  const first = set.at(ids[0]);
  console.log('first set props:', [...first.wzProperties].map(p => p.name));
  console.log('first set desc =', JSON.stringify(val(first, 'desc')));
  console.log('icon node:', JSON.stringify({ w: first.at('icon')?.pngProperty?.width, h: first.at('icon')?.pngProperty?.height, origin: val(first.at('icon'), 'origin') }));
  for (const sid of ids.slice(0, 6)) {
    const s = set.at(sid);
    const frames = [...s.wzProperties].filter(p => /^\d+$/.test(p.name));
    console.log(sid, 'desc=', JSON.stringify(val(s, 'desc')), 'frames=', frames.length,
      'sizes=', frames.slice(0, 3).map(p => `${p.name}:${p.pngProperty?.width}x${p.pngProperty?.height}@${JSON.stringify(val(p, 'origin'))}/${val(p, 'delay')}`).join(' '));
  }
  console.log('UI node:', [...(top('UI')?.wzProperties || [])].map(p => p.name).join(','));
  console.log('Tooltip node:', [...(top('Tooltip')?.wzProperties || [])].map(p => p.name).join(','));
  f.dispose();
})().catch(e => { console.error(e.stack || e); process.exit(1); });
