#!/usr/bin/env node
// 探针：weapon3 是源作者层还是读取假象？zmap 里武器相关深度有哪些？
const avatar = require('./export_tms273_avatar.cjs');
const { get, resolved, loadSourceTables, zmap, layerZName, children, value } = avatar;

(async () => {
  await loadSourceTables();
  console.log('zmap 里含 weapon 的深度:', [...zmap.keys()].filter(k => /weapon/i.test(k)).join(', '));

  for (const p of ['Character/Weapon/01212000.img/stand1/0', 'Character/Weapon/_Canvas/01212000.img/stand1/0']) {
    try {
      const node = await get(p);
      const r = resolved(node);
      console.log(`\n=== ${p} === (${r.constructor.name})`);
      for (const child of children(r)) {
        const hasZ = child.at?.('z')?.wzValue;
        const cls = child.constructor.name;
        console.log(`   ${child.name} :: ${cls} z=${hasZ ?? '-'} origin=${JSON.stringify(child.at?.('origin')?.wzValue ?? null)}`);
      }
    } catch (error) {
      console.log(`FAIL ${p} :: ${error.message.slice(0, 90)}`);
    }
  }
  avatar.reader.close?.();
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
