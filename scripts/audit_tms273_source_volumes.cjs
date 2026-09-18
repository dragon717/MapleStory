#!/usr/bin/env node
// 源包分卷完备性审计（清单驱动，不写死任何部位名）。
//
// TMS273.7 客户端把一棵 WZ 拆成「索引 + 数据分卷」：`<Stem>.wz`、`<Stem>_000.wz` …，
// 并在同目录的 `<Stem>.ini` 里用 `LastWzIndex|N` **声明**数据分卷的编号上界。
// 另有并行的 `_Canvas/` 子树（`_Canvas.ini` 同样声明），它才是画布**像素**的所在。
//
// 因此「包被裁剪了哪些分卷」是一个可以直接算出来的事实：
//     应有 = <Stem>.wz + <Stem>_000.wz … <Stem>_00N.wz（N 来自同一目录的 .ini）
//     实有 = 目录里真实存在的同名文件
//     缺口 = 应有 − 实有
// 这比「逐个部位试读、失败才算缺」可靠：试读成功只说明**这次用到的那张图**在，
// 说明不了整棵子树完整。判据作用在文件集合上，作用域是整棵树。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');

/** 解析 `LastWzIndex|N`；文件不存在返回 null（= 该子树没有声明，不能判缺口）。 */
function declaredLastIndex(iniPath) {
  if (!fs.existsSync(iniPath)) return null;
  const text = fs.readFileSync(iniPath, 'utf8');
  const match = /LastWzIndex\s*\|\s*(-?\d+)/.exec(text);
  return match ? Number(match[1]) : null;
}

/**
 * 审计一个「索引 + 分卷」目录。
 * @param dir   存放 `<Stem>*.wz` 的目录
 * @param stem  文件名主干（根层等于目录名，`_Canvas` 子树固定为 `_Canvas`）
 * @param ini   声明文件
 */
function audit(dir, stem, ini) {
  const label = path.relative(DATA, dir) || '.';
  if (!fs.existsSync(dir)) return { label, stem, declared: null, present: [], missing: [], unknown: [] };
  const last = declaredLastIndex(ini);
  const present = fs.readdirSync(dir).filter(name => new RegExp(`^${stem}(?:_\\d+)?\\.wz$`, 'i').test(name)).sort();
  if (last === null) {
    // 没有 .ini 就没有「应有」的权威定义。只报告实有，不臆断缺口。
    return { label, stem, declared: null, present, missing: [], unknown: [] };
  }
  const expected = [`${stem}.wz`];
  for (let i = 0; i <= last; i++) expected.push(`${stem}_${String(i).padStart(3, '0')}.wz`);
  const existing = new Set(present.map(name => name.toLowerCase()));
  return {
    label,
    stem,
    declared: last,
    present,
    missing: expected.filter(name => !existing.has(name.toLowerCase())),
    unknown: [],
  };
}

function auditTree(root) {
  const results = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    if (entry.name === '_Canvas') continue;                       // 根层 `_Canvas` 单独审计
    results.push(audit(dir, entry.name, path.join(dir, `${entry.name}.ini`)));
    const canvas = path.join(dir, '_Canvas');
    if (fs.existsSync(canvas)) results.push(audit(canvas, '_Canvas', path.join(canvas, '_Canvas.ini')));
  }
  const rootCanvas = path.join(root, '_Canvas');
  if (fs.existsSync(rootCanvas)) results.push(audit(rootCanvas, '_Canvas', path.join(rootCanvas, '_Canvas.ini')));
  return results;
}

function report(results, title) {
  console.log(`\n========== ${title} ==========`);
  const gapped = results.filter(r => r.missing.length);
  const undeclared = results.filter(r => r.declared === null);
  const complete = results.filter(r => r.declared !== null && !r.missing.length);
  console.log(`子树 ${results.length} 棵：完整 ${complete.length}，有缺口 ${gapped.length}，无声明（不可判） ${undeclared.length}`);
  if (gapped.length) {
    console.log('\n--- 缺口（应有分卷 − 实有分卷） ---');
    for (const r of gapped) {
      console.log(`  ${r.label}  (声明 LastWzIndex|${r.declared}，实有 ${r.present.join(', ')})`);
      for (const name of r.missing) console.log(`      ✗ 缺 ${name}`);
    }
  }
  if (undeclared.length) {
    console.log('\n--- 无 .ini 声明（本次审计无法判定，不当作缺口） ---');
    for (const r of undeclared) console.log(`  ${r.label}  实有: ${r.present.join(', ') || '(无)'}`);
  }
  return gapped;
}

/**
 * 某部位子树是否缺分卷。`structure=true` 查 `<Part>/`，`structure=false` 查 `<Part>/_Canvas/`。
 * 供导出/补丁侧按「清单声明」判断某张图的 z/origin（结构）或像素（画布）是否可信。
 */
function partVolumeGap(part, structure = true) {
  const dir = structure
    ? path.join(DATA, 'Character', part)
    : path.join(DATA, 'Character', part, '_Canvas');
  if (!fs.existsSync(dir)) return null;
  const stem = structure ? part : '_Canvas';
  return audit(dir, stem, path.join(dir, `${stem}.ini`));
}

if (require.main === module) {
  const rootLevel = auditTree(DATA);
  const character = auditTree(path.join(DATA, 'Character'));
  const rootGaps = report(rootLevel, 'Data/ 根层分卷审计');
  const characterGaps = report(character, 'Data/Character 各部位分卷审计（纸娃娃源）');
  const gaps = [...rootGaps, ...characterGaps];
  const tree = [...rootLevel, ...character];

  // 把缺口落成机器可读的清单，供后续门禁/交接引用。
  const artifact = path.join(ROOT, 'artifacts', 'tms273_source_volume_audit.json');
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  fs.writeFileSync(artifact, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    rule: '应有分卷 = <Stem>.wz + <Stem>_000.wz … <Stem>_00N.wz，N 来自同目录 <Stem>.ini 的 LastWzIndex',
    dataRoot: path.relative(ROOT, DATA),
    subtrees: tree,
    gaps: gaps.map(g => ({ label: g.label, declared: g.declared, present: g.present, missing: g.missing })),
  }, null, 2)}\n`, 'utf8');
  console.log(`\n台账已写入 ${path.relative(ROOT, artifact)}`);

  if (characterGaps.length) {
    console.log('\nCharacter 子树缺口清单（这些就是「需要补回的分卷」）：');
    for (const g of characterGaps) for (const name of g.missing) console.log(`  ${g.label}/${name}`);
  } else {
    console.log('\nCharacter 子树无缺口。');
  }
}

module.exports = { DATA, ROOT, audit, auditTree, partVolumeGap };
