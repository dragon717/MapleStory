// 临时探针：用导出器自己的 reader 判定每个部件路径能否解析（含 sit 帧）。
// 用完即删。跑法：node scripts/_probe_parts.cjs
const avatar = require('./export_tms273_avatar.cjs');

const children = node => [...(node?.wzProperties || [])];

const targets = [
  ['BODY', avatar.BODY],
  ['HEAD', avatar.HEAD],
  ['FACE', avatar.FACE],
  ['HAIR', avatar.HAIR],
  ['PANTS', avatar.PANTS],
  ['SHOES', avatar.SHOES],
  ['WEAPON', avatar.STARTER_WEAPON],
  ['TAMINGMOB', 'Character/TamingMob/01902000.img'],
];

(async () => {
  for (const [label, logical] of targets) {
    try {
      const node = await avatar.reader.get(logical);
      const top = children(node).map(child => child.name);
      const sit = children(node).find(child => child.name === 'sit');
      console.log(
        'OK  ', label.padEnd(10), logical,
        '| 顶层:', top.slice(0, 7).join(',') || '(空)',
        '| sit:', sit ? children(sit).map(c => c.name).join(',') : '无',
      );
    } catch (error) {
      console.log('FAIL', label.padEnd(10), logical, '->', String(error.message || error).slice(0, 90));
    }
  }
})();
