// 勇士部落传送链接取证 · ① 逐门比对「已装配 13 图」⇄ 源（客户端打包 WZ）
//
//   NODE_PATH=scripts/node_modules node evidence/2026-09-21/perion-portal-links/repro/01_compare_assembled_vs_source.cjs
//
// 判据：已装配图的每一扇跨图门 (pt, tm, tn) 必须与源全等；脚本门逐条对 Graph.json 授权。
const fs = require('node:fs');
const path = require('node:path');
const { createReader } = require('../../../../scripts/tms273_wz.cjs');

const root = path.resolve(__dirname, '../../../..');
const data = path.join(root, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const reader = createReader(data, '/tmp/tms273-probe');
// 勇士部落 5 个街区里已装配的 13 张
const cluster = ['102000000','102000002','102000003','102010000','102010100','102020000','102020100',
  '102020200','102020300','102020400','102020500','102030000','102040000'];
const shared = JSON.parse(fs.readFileSync(path.join(root, 'shared/maps.json'), 'utf8')).maps;
const byId = Object.fromEntries(shared.map(m => [m.id, m]));
const graph = JSON.parse(fs.readFileSync(
  path.join(root, '参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW/Map/Map/Graph.json'), 'utf8'));

const dec = v => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (['string','wstring','stringPool'].includes(v._dirType)) return String(v._value);
    if (['byte','short','int','long','ubyte','ushort','uint','ulong','float','double'].includes(v._dirType)) return Number(v._value);
    if (v._dirType === 'bool') return String(v._value).toLowerCase() === '1';
  }
  return v;
};

(async () => {
  let problems = 0;
  for (const id of cluster) {
    const n = await reader.get('Map/Map/Map' + id[0] + '/' + id + '.img');
    if (n.parseImage && !n.parsed) await n.parseImage();
    const src = [];
    for (const p of n.at('portal').wzProperties) {
      const o = {};
      for (const c of p.wzProperties) o[c.name] = dec(c.wzValue);
      src.push({ name: String(o.pn), type: o.pt, x: o.x, y: o.y,
        tm: o.tm === 999999999 ? null : String(o.tm).padStart(9, '0'), tn: o.tn || null, script: o.script || '' });
    }
    const ours = byId[id].portals;
    const srcGates = src.filter(p => p.tm && p.type !== 0);
    const ourGates = ours.filter(p => p.targetMapId);
    for (const s of srcGates) {
      const o = ourGates.find(c => c.name === s.name && c.x === s.x && c.y === s.y);
      if (!o) { console.log('MISSING GATE ' + id + ' ' + s.name + ' -> ' + s.tm); problems++; continue; }
      if (o.targetMapId !== s.tm || (o.targetPortalName || null) !== s.tn || o.type !== s.type) {
        console.log('MISMATCH ' + id + '/' + s.name + ' src ' + s.type + ' ' + s.tm + '/' + s.tn
          + ' vs ours ' + o.type + ' ' + o.targetMapId + '/' + o.targetPortalName); problems++;
      }
    }
    for (const o of ourGates) {
      if (!srcGates.find(c => c.name === o.name && c.x === o.x && c.y === o.y)) {
        console.log('EXTRA GATE ' + id + '/' + o.name + ' (ours ' + o.targetMapId + ')'); problems++;
      }
    }
    // Graph.json 只在解包镜像里（客户端 WZ 不导出这张表），因此单独读镜像。
    const authorized = {};
    const gnode = (graph['10'] || {})[id];
    if (gnode && gnode.portal && !Array.isArray(gnode.portal) && gnode.portal.wzProperties) {
      for (const e of gnode.portal.wzProperties) {
        const vals = {};
        for (const c of e.wzProperties) vals[c.name] = dec(c.wzValue);
        authorized[String(vals.portalNum)] = vals;
      }
    } else if (gnode && gnode.portal && typeof gnode.portal === 'object') {
      for (const [k, v] of Object.entries(gnode.portal)) {
        if (k.startsWith('_')) continue;
        const vals = {};
        for (const [kk, vv] of Object.entries(v)) vals[kk] = dec(vv);
        authorized[String(vals.portalNum)] = vals;
      }
    }
    src.forEach((p, i) => {
      if (!p.script) return;
      const a = authorized[String(i)] || null;
      const mine = ours.find(o => o.name === p.name && o.x === p.x && o.y === p.y) || {};
      console.log('SCRIPT GATE ' + id + '/' + p.name + ' idx=' + i + ' pt=' + p.type + ' script=' + p.script
        + ' | Graph=' + (a ? JSON.stringify({ targetMap: a.targetMap, scriptPortal: a.scriptPortal }) : 'NO ENTRY')
        + ' | ours=' + mine.targetMapId);
    });
  }
  console.log(problems === 0 ? 'ALL ' + cluster.length + ' ASSEMBLED MAPS MATCH THE SOURCE PORTAL GRAPH' : problems + ' problems');
  reader.close();
})();
