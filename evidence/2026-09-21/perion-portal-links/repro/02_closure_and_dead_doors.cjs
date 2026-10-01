// 勇士部落传送链接取证 · ② 闭包与死门
//
//   NODE_PATH=scripts/node_modules node evidence/2026-09-21/perion-portal-links/repro/02_closure_and_dead_doors.cjs
//
// 输出三节：
//   A. 按源 streetName 枚举「勇士部落」全区的图（String.wz/Map.img/victoria）
//   B. 从已装配的 13 张出发、在**权威源（客户端打包 WZ）**上求 portal 闭包 → 装 / 不装两张表
//   C. 全目录层面的死门清单（已装配图的跨图门指向未装配图），并对每扇死门的目标做存在性判定
const fs = require('node:fs');
const path = require('node:path');
const { createReader } = require('../../../../scripts/tms273_wz.cjs');

const root = path.resolve(__dirname, '../../../..');
const data = path.join(root, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const reader = createReader(data, '/tmp/tms273-probe');
const reg = JSON.parse(fs.readFileSync(path.join(root, 'references/tms273-data/maps.json'), 'utf8'));
const registered = new Set(reg.maps.map(m => m.id));
const graph = JSON.parse(fs.readFileSync(
  path.join(root, '参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW/Map/Map/Graph.json'), 'utf8'));

const dec = v => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (['string','wstring','stringPool'].includes(v._dirType)) return String(v._value);
    if (['byte','short','int','long','ubyte','ushort','uint','ulong','float','double'].includes(v._dirType)) return Number(v._value);
    if (v._dirType === 'bool') return String(v._value).toLowerCase() === '1';
    const o = {};
    for (const [k, vv] of Object.entries(v)) if (!k.startsWith('_')) o[k] = dec(vv);
    return o;
  }
  return v;
};

const cache = new Map();
async function mapOf(id) {
  if (cache.has(id)) return cache.get(id);
  let r;
  try {
    const n = await reader.get('Map/Map/Map' + id[0] + '/' + id + '.img');
    if (n.parseImage && !n.parsed) await n.parseImage();
    const portals = [];
    const p = n.at('portal');
    if (p && p.wzProperties) for (const e of p.wzProperties) {
      const g = k => { const x = e.at(k); return x ? x.wzValue : undefined; };
      const tm = g('tm');
      portals.push({ name: String(g('pn') || ''), type: g('pt'),
        tm: (tm === undefined || tm === 999999999 || tm === '999999999') ? null : String(tm).padStart(9, '0') });
    }
    const info = n.at('info');
    const life = n.at('life');
    const mobs = new Set();
    let lifeN = 0;
    // 注意：@tybys/wz 的 `wzProperties` 是可迭代的 array-like，但**没有** `length`，
    // 只能靠遍历计数（`.length` 会得到 undefined）。
    if (life && life.wzProperties) for (const e of life.wzProperties) {
      lifeN += 1;
      if (e.at('type') && e.at('type').wzValue === 'm') mobs.add(String(e.at('id').wzValue));
    }
    r = { ok: true, portals, life: lifeN, mobs: [...mobs] };
  } catch (e) { r = { ok: false, error: String(e.message).slice(0, 60) }; }
  cache.set(id, r);
  return r;
}

// 全 Graph 的入边表：targetMap -> [来源门]
const inbound = {};
for (const group of Object.values(graph)) {
  if (!group || typeof group !== 'object') continue;
  for (const [mid, node] of Object.entries(group)) {
    if (mid.startsWith('_')) continue;
    const ps = node && node.portal;
    if (!ps || typeof ps !== 'object') continue;
    const list = ps.wzProperties ? ps.wzProperties.map(e => {
      const o = {}; for (const c of e.wzProperties) o[c.name] = dec(c.wzValue); return o;
    }) : Object.entries(ps).filter(([k]) => !k.startsWith('_')).map(([, v]) => dec(v));
    for (const v of list) {
      const tm = v.targetMap;
      if (typeof tm !== 'number' || tm >= 999999999) continue;
      const key = String(tm).padStart(9, '0');
      (inbound[key] ||= []).push(mid + '/' + v.portalNum);
    }
  }
}

(async () => {
  // ---- A. 源街区枚举 ----
  const names = JSON.parse(fs.readFileSync(
    path.join(root, '参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW/String/Map.json'), 'utf8'));
  const STREETS = new Set(['勇士之村', '南部岩山', '北部岩山', '火焰之地', '遺跡發掘地']);
  const region = [];
  for (const [k, v] of Object.entries(names.victoria || {})) {
    if (k.startsWith('_') || !/^\d+$/.test(k)) continue;
    const dv = dec(v);
    if (dv && STREETS.has(dv.streetName)) region.push({ id: k.padStart(9, '0'), street: dv.streetName, name: dv.mapName });
  }
  region.sort((a, b) => (a.id < b.id ? -1 : 1));
  console.log('=== A. 勇士部落全区（源 streetName 归簇）: ' + region.length + ' 张，已装配 '
    + region.filter(r => registered.has(r.id)).length + ' ===');
  for (const r of region) console.log('  ' + (registered.has(r.id) ? '[装]' : '[  ]') + ' ' + r.id + ' ' + r.street + '/' + r.name);

  // ---- B. 闭包（在权威源上 BFS） ----
  const seeds = ['102030100', '102040100']; // 已装配图里两扇死门的目标
  const toAssemble = new Set();
  const queue = [...seeds];
  while (queue.length) {
    const cur = queue.shift();
    if (toAssemble.has(cur) || registered.has(cur)) continue;
    toAssemble.add(cur);
    const r = await mapOf(cur);
    if (!r.ok) continue;
    for (const p of r.portals) if (p.tm && !registered.has(p.tm) && !toAssemble.has(p.tm)) queue.push(p.tm);
  }
  console.log('\n=== B. 闭包：装 ' + toAssemble.size + ' 张 ===');
  for (const id of [...toAssemble].sort()) {
    const r = await mapOf(id);
    const rn = (region.find(x => x.id === id) || {});
    console.log('  ' + id + ' ' + (rn.street || '?') + '/' + (rn.name || '?')
      + ' source=' + (r.ok ? 'YES' : 'NO')
      + ' life=' + (r.ok ? r.life : '-') + ' mobs=' + (r.ok ? JSON.stringify(r.mobs) : '-'));
  }
  const orphans = region.filter(r => !registered.has(r.id) && !toAssemble.has(r.id));
  console.log('\n=== B2. 不装 ' + orphans.length + ' 张（源无入边授权 ⇒ 孤岛） ===');
  for (const r of orphans) {
    const m = await mapOf(r.id);
    console.log('  ' + r.id + ' ' + r.street + '/' + r.name + ' source=' + (m.ok ? 'YES' : 'NO')
      + ' Graph入边=' + JSON.stringify(inbound[r.id] || []));
  }

  // ---- C. 全目录死门 ----
  const dead = new Map();
  for (const m of reg.maps) for (const p of m.portals || []) {
    if (p.targetMapId && !registered.has(p.targetMapId)) {
      if (!dead.has(p.targetMapId)) dead.set(p.targetMapId, []);
      dead.get(p.targetMapId).push(m.id + '/' + p.name);
    }
  }
  console.log('\n=== C. 全目录死门：' + [...dead.values()].reduce((a, b) => a + b.length, 0)
    + ' 扇，指向 ' + dead.size + ' 张未装配目标 ===');
  let inClient = 0;
  for (const target of [...dead.keys()].sort()) {
    const r = await mapOf(target);
    if (r.ok) inClient++;
    const perion = target.startsWith('102') ? '  <== 勇士部落' : '';
    console.log('  ' + (r.ok ? 'IN-CLIENT' : 'NO-IMAGE ') + ' ' + target
      + ' <- ' + JSON.stringify(dead.get(target)) + perion);
  }
  console.log('  目标在客户端 WZ 里可打开: ' + inClient + '/' + dead.size);
  reader.close();
})();
