const { createReader } = require('./tms273_wz.cjs');
const fs = require('node:fs');
const crypto = require('node:crypto');
const DATA = '/Users/muniao/Library/Mobile Documents/com~apple~CloudDocs/游戏/github/MapleStory/参考/273/TMS273少爷一键端/客户端/TMS273.7/Data';
const OUT = '/tmp/emo-probe3';

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
    for (const p of paths) {
      const f = await reader.frame(p, OUT);
      const local = OUT + '/' + f.url;
      const buf = fs.readFileSync(local);
      console.log(`${p} -> ${f.resolvedSource} ${f.width}x${f.height} bytes=${buf.length} sha=${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12)}`);
    }
  } finally { reader.close(); }
})().catch(e => { console.error(e.stack || e); process.exit(1); });
