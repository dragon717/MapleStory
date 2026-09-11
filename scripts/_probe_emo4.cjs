const { createReader } = require('./tms273_wz.cjs');
const path = require('node:path');
const DATA = '/Users/muniao/Library/Mobile Documents/com~apple~CloudDocs/游戏/github/MapleStory/参考/273/TMS273少爷一键端/客户端/TMS273.7/Data';

(async () => {
  const reader = createReader(DATA);
  try {
    for (const p of [
      'UI/ChatEmoticon.img/Emoticon/1000/10000001',
      'UI/ChatEmoticon.img/Emoticon/1000/10000002',
      'UI/ChatEmoticon.img/Emoticon/1000/icon',
      'UI/ChatEmoticon.img/UI/ChatEmoticon/backgrnd',
      'UI/ChatEmoticon.img/UI/ChatEmoticon/button:close/normal/0',
      'UI/ChatEmoticon.img/UI/ChatEmoticon/slotBase',
    ]) {
      const node = await reader.get(p);
      const kids = node.wzProperties ? [...node.wzProperties].map(k => k.name + (k.wzProperties ? '{}' : '=' + JSON.stringify(k.value === undefined ? k.wzValue : k.value))) : null;
      console.log('--- ' + p);
      console.log('    kids:', kids ? kids.slice(0, 12).join(' | ') : '(leaf)');
      try {
        const f = await reader.frame(p, '/tmp/emo-probe');
        console.log('    frame:', JSON.stringify({ w: f.width, h: f.height, origin: f.origin, delay: f.delay, resolved: f.resolvedSource }));
      } catch (e) { console.log('    frame error:', e.message); }
    }
  } finally { reader.close(); }
})().catch(e => { console.error(e.stack || e); process.exit(1); });
