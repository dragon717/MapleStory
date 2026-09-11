const wz = require('@tybys/wz');
const { createReader } = require('./tms273_wz.cjs');
const path = require('node:path');
const DATA = path.join(__dirname, '..', '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const reader = createReader(DATA);
function kids(n){ const s = n?.wzProperties; return s? [...s] : []; }
(async () => {
  for (const id of ['03010000','03015174','03010005']) {
    const group = '0' + id.slice(0,5);
    const chair = await reader.get(`Item/Install/${group}.img/${id}`);
    const info = kids(chair).find(k=>k.name==='info');
    const eff = kids(chair).find(k=>k.name==='effect');
    const infoKeys = kids(info).map(k=>`${k.name}:${k.propertyType}`).join(',');
    const effKeys = kids(eff).map(k=>k.name).join(',');
    console.log(id, '| info:', infoKeys);
    console.log('   effect:', effKeys);
    const first = kids(eff).find(k=>k.name==='0');
    if (first) {
      console.log('   effect/0 type', first.propertyType, 'children', kids(first).map(k=>k.name).join(','));
      const bmp = await first.getBitmap?.();
      console.log('   bitmap', bmp && (bmp.width+'x'+bmp.height), 'origin?', kids(first).map(k=>k.name).includes('origin'));
    }
  }
  reader.close?.();
})().catch(e=>console.log('ERR', e.message));
