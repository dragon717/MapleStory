// Same-version Orbis names and portals for the 3D layout discussion.
// Run: node scripts/export_orbis_topology.cjs
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createReader } = require('./tms273_wz.cjs');

const root = path.resolve(__dirname, '..');
const packageRoot = path.join(root, '参考/273/TMS273少爷一键端');
const stringsPath = path.join(packageRoot, 'TMS273/WZ_JSON_TW/String/Map.json');
const dataRoot = path.join(packageRoot, '客户端/TMS273.7/Data');
const outputRoot = path.join(root, 'resources/scenes/sky-voyage-v3/references');
const scalar = (node, key) => node?.at?.(key)?.wzValue;
const groupFor = id => {
  const n = Number(id);
  if (n >= 200000000 && n < 200010000) return '城镇与港口';
  if (n >= 200010000 && n < 200080100) return '云彩公园与庭园';
  if (n >= 200080100 && n < 200090000) return '天空之城塔';
  if (n >= 200090000 && n < 200100000) return '航行地图（含相邻地区航线）';
  if (n >= 200100000 && n < 200110000) return '克里塞旧目录';
  if (n >= 200110000 && n < 200120000) return '跨地区移动地图';
  if (n >= 200120000 && n < 200130000) return '克里塞另一组目录';
  if (n >= 920010000 && n < 920012000) return '雅典娜禁地／女神之塔';
  if (n >= 920012000 && n < 920013000) return '克里塞组队目录';
  return null;
};

async function main() {
  const strings = JSON.parse(fs.readFileSync(stringsPath, 'utf8'));
  const names = new Map();
  for (const group of Object.values(strings)) {
    if (!group || typeof group !== 'object') continue;
    for (const [id, entry] of Object.entries(group)) {
      if (!/^\d{9}$/.test(id) || !entry?.mapName?._value) continue;
      names.set(id, { id, name: entry.mapName._value.trim(), street: entry.streetName?._value?.trim() ?? '' });
    }
  }
  const reader = createReader(dataRoot);
  const maps = [];
  try {
    for (const named of [...names.values()].filter(m => groupFor(m.id)).sort((a, b) => a.id.localeCompare(b.id))) {
      const source = `Map/Map/Map${named.id[0]}/${named.id}.img`;
      const row = { ...named, group: groupFor(named.id), source, status: 'missing', portals: [], npcs: [] };
      let image;
      try { image = await reader.get(source); }
      catch (error) {
        if (!error.message.startsWith('找不到 273 WZ 节点:')) throw error;
        maps.push(row);
        continue;
      }
      if (!image.parsed) await image.parseImage();
      row.status = image.at('info') ? 'structure' : 'minimap-only';
      row.link = scalar(image.at('info'), 'link') ?? null;
      row.returnMap = scalar(image.at('info'), 'returnMap') ?? null;
      for (const p of image.at('portal')?.wzProperties ?? []) {
        row.portals.push({ index: p.name, name: scalar(p, 'pn'), type: scalar(p, 'pt'),
          x: scalar(p, 'x'), y: scalar(p, 'y'), target: String(scalar(p, 'tm') ?? ''),
          targetPortal: scalar(p, 'tn') ?? '', script: scalar(p, 'script') ?? '' });
      }
      for (const life of image.at('life')?.wzProperties ?? []) {
        if (scalar(life, 'type') === 'n') row.npcs.push(String(scalar(life, 'id')));
      }
      maps.push(row);
    }
  } finally { reader.close(); }
  const links = maps.flatMap(m => m.portals.filter(p => /^\d{9}$/.test(p.target) && p.target !== '999999999' && p.target !== m.id)
    .map(p => ({ from: m.id, to: p.target, portal: p.name, targetPortal: p.targetPortal, type: p.type, script: p.script })));
  // One runnable source check: a changed parser cannot silently publish an empty or guessed graph.
  assert(maps.find(m => m.id === '200000000')?.name === '天空之城');
  assert(maps.find(m => m.id === '200000301')?.name.includes('英雄之殿'));
  for (const [from, to] of [['200000000','200010000'], ['200010100','200010110'],
    ['200010111','200010200'], ['200010121','200010200'], ['200010131','200010200'],
    ['200080100','200080200'], ['200082200','200082300']]) {
    assert(links.some(l => l.from === from && l.to === to), `source edge missing: ${from} → ${to}`);
  }
  assert(maps.filter(m => m.group === '天空之城塔' && /<\d+層>/.test(m.name)).length === 20);
  assert(maps.filter(m => m.group === '雅典娜禁地／女神之塔').length === 27);
  const provenance = { version: 'TMS273', encoding: 'UTF-8',
    names: path.relative(root, stringsPath), namesSha256: crypto.createHash('sha256').update(fs.readFileSync(stringsPath)).digest('hex'),
    portals: path.relative(root, dataRoot),
    notes: ['名称目录包含历史与实例地图；结构存在不等于当前可进入。',
      'links 仅为 WZ 固定目标，脚本/NPC/事件交通未据此猜测。',
      'minimap-only 表示该包只留缩略图，不能据其验证传送门。'] };
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.writeFileSync(path.join(outputRoot, 'orbis-map-topology-tms273.json'), JSON.stringify({ provenance, maps, links }, null, 2) + '\n', 'utf8');
  const statusName = { structure: '完整结构', 'minimap-only': '仅缩略图残留', missing: '名称表有名，WZ无图' };
  const md = ['# 天空之城 TMS273 地图名称与连接', '',
    '原版名称保留繁体。完整结构只表示本地源包有地图；历史、NPC脚本与组队实例不得当作普通步行连接。', '',
    `共 ${maps.length} 个名称记录；固定跨图传送门 ${links.length} 条（按实际门户计，非去重地区边）。`, ''];
  for (const group of [...new Set(maps.map(m => m.group))]) {
    const rows = maps.filter(m => m.group === group);
    md.push(`## ${group}（${rows.length}）`, '', '| 地图编号 | 原版地图名 | 本地证据 | 固定出口 → 地图 | 脚本入口 |', '| --- | --- | --- | --- | --- |');
    for (const m of rows) {
      const targets = [...new Set(links.filter(l => l.from === m.id).map(l => l.to))];
      const scripts = [...new Set(m.portals.map(p => p.script).filter(Boolean))];
      md.push(`| ${m.id} | ${m.name} | ${statusName[m.status]} | ${targets.map(id => `${names.get(id)?.name ?? '名称未收录'} (${id})`).join('；')} | ${scripts.join('、')} |`);
    }
    md.push('');
  }
  md.push('## 来源', '', `- 名称：\`${provenance.names}\``, `- 名称文件 SHA-256：\`${provenance.namesSha256}\``,
    `- 门户：\`${provenance.portals}\` 内对应 Map2 / Map9 分卷。`,
    '- 提取脚本：`node scripts/export_orbis_topology.cjs`；复用现有 `tms273_wz.cjs` 解析器。', '');
  fs.writeFileSync(path.join(outputRoot, 'orbis-map-topology-tms273.md'), md.join('\n'), 'utf8');
  console.log(JSON.stringify({ maps: maps.length, groups: Object.fromEntries([...new Set(maps.map(m => m.group))].map(g => [g, maps.filter(m => m.group === g).length])),
    status: Object.fromEntries(['structure','minimap-only','missing'].map(s => [s,maps.filter(m => m.status === s).length])), fixedPortals: links.length, checks: 'passed' }));
}
main().catch(error => { console.error(error.stack ?? error); process.exitCode = 1; });
