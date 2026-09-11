const { createReader } = require('./tms273_wz.cjs');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const DATA = '/Users/muniao/Library/Mobile Documents/com~apple~CloudDocs/游戏/github/MapleStory/参考/273/TMS273少爷一键端/客户端/TMS273.7/Data';

(async () => {
  const reader = createReader(DATA);
  try {
    const paths = [
      'UI/ChatEmoticon.img/Emoticon/1000/icon',
      'UI/ChatEmoticon.img/Emoticon/1000/10000001/info/icon',
      'UI/ChatEmoticon.img/Emoticon/1000/10000002/info/icon',
      'UI/ChatEmoticon.img/Emoticon/1001/icon',
      'UI/ChatEmoticon.img/Emoticon/1001/10010001/info/icon',
    ];
    const hashes = new Map();
    for (const p of paths) {
      const node = await reader.get(p);
      const f = await reader.frame(p, '/tmp/emo-probe2');
      const buf = await reader.pngBuffer(node, p);
      const sha = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
      hashes.set(p, sha);
      console.log(`${p} -> ${f.width}x${f.height} origin=${JSON.stringify(f.origin)} sha=${sha}`);
    }
    // how many distinct effect frames per sticker, sample
    let frames = 0;
    const groups = ['1000', '1001', '1010', '1025', '1051'];
    for (const g of groups) {
      for (let i = 1; i <= 10; i += 1) {
        for (let n = 0; n < 10; n += 1) {
          try { await reader.get(`UI/ChatEmoticon.img/Emoticon/${g}/effect/${n}`); } catch { break; }
        }
      }
    }
    console.log('probe done');
  } finally { reader.close(); }
})().catch(e => { console.error(e.stack || e); process.exit(1); });
