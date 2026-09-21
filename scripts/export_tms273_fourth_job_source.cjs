#!/usr/bin/env node

// 火毒（212）／主教（232）四转技能**来源核定**产物生成器。
//
// 为什么单独成脚本：`references/tms273-data/ice-fourth-job-source.json` 是**手写留档**，
// 没有可重跑的生成器 ⇒ 数值、节点集与源之间的对应关系只能靠人读。本脚本把同一层
// 事实从源树**独立重算**出来（节点集、每级公式、需求等级、前置、标记），产出同样格式的
// 留档，任何人可以重跑并逐字节比对。
//
// 边界（必须保留）：
//   * 只读源 JSON（`WZ_JSON_TW/Skill/*.json` + `String/Skill.json`），**不读也不写**导出树；
//   * 只记录源里**确实存在**的字段，不推断转职脚本、SP 授予、服务端时序或官方行为；
//   * 不导出图片与音频 —— 图集/动作/Sound 的挂载属于「接运行」阶段，本产物明确记为未解析；
//   * 技能名走**双根查找**：`TMS273/WZ_JSON_TW` 缺 `String/Skill.json`，`手工服务端/tms273/WZ_JSON_TW` 有；
//     两条候选路径都会进报错信息，不允许悄悄退化成一个根。
//
// 用法：
//   node scripts/export_tms273_fourth_job_source.cjs          # 生成/覆盖 artifacts
//   node scripts/export_tms273_fourth_job_source.cjs --print  # 只打印，不落盘

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { evaluate } = require('./tms273_skill_formulas.cjs');
const { RUNTIME_INTEGER_FIELDS } = require('./tms273_skill_manifest.cjs');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'references/tms273-data');

// 两份 WZ_JSON_TW **互补**（见 2026-09-21 记录 §13.2）：技能 JSON 两边都有，
// 技能名/书名只在《手工服务端》那份里有。
const SKILL_ROOTS = [
  path.join(ROOT, '参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW'),
  path.join(ROOT, '参考/273/TMS273少爷一键端/手工服务端/tms273/WZ_JSON_TW'),
];

const BOOKS = [
  {
    book: '212',
    artifact: 'fire-fourth-job-source',
    job: 212,
    previousJob: 211,
    jobName: '火毒大魔導士',
    branch: '火毒（F/P）',
    expectation: { nodes: 24, ordinary: 11, hyper: 12, hidden: 1 },
  },
  {
    book: '232',
    artifact: 'holy-fourth-job-source',
    job: 232,
    previousJob: 231,
    jobName: '主教',
    branch: '僧侶→祭司→主教（Cleric/Holy）',
    expectation: { nodes: 27, ordinary: 13, hyper: 12, hidden: 2 },
  },
  {
    // 冰雷线是已接运行的那条：放进同一脚本只为**对照**，不重写既有留档。
    book: '222',
    artifact: 'ice-fourth-job-source',
    job: 222,
    previousJob: 221,
    jobName: '冰雷大魔導士',
    branch: '冰雷（I/L）',
    reference: true,
    expectation: { nodes: 26, ordinary: 11, hyper: 12, hidden: 3 },
  },
];

function pickRoot(relative) {
  const candidates = SKILL_ROOTS.map(root => path.join(root, relative));
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`源文件不存在，已试过的候选路径：\n${candidates.map(c => `  - ${c}`).join('\n')}`);
  }
  return found;
}

function readSource(relative) {
  const file = pickRoot(relative);
  const bytes = fs.readFileSync(file);
  return {
    file,
    text: bytes.toString('utf8'),
    meta: {
      // 路径写成仓库相对形式，产物换机器也能读。
      path: path.relative(ROOT, file),
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    },
  };
}

const value = node => (node && typeof node === 'object' ? node._value : node);

/** 源里的一层 `_dirType` 包装：取值的标量，其余递归成普通对象。 */
function unwrap(node) {
  if (Array.isArray(node)) return node.map(unwrap);
  if (!node || typeof node !== 'object') return node;
  if (Object.prototype.hasOwnProperty.call(node, '_value')) return node._value;
  const plain = {};
  for (const [key, child] of Object.entries(node)) {
    if (key === '_dirType' || key === '_x' || key === '_y') continue;
    plain[key] = unwrap(child);
  }
  return plain;
}

function flag(node, key) {
  const raw = value(node?.[key]);
  return raw === undefined ? null : String(raw);
}

function flagNumber(node, key) {
  const raw = flag(node, key);
  return raw === null ? 0 : Number(raw);
}

/** 逐级取值：只在运行期契约的整数字段上取整（与 `tms273_skill_manifest.cjs` 同一张表）。 */
function projectScalar(field, result) {
  if (Number.isSafeInteger(result)) return result;
  if (!RUNTIME_INTEGER_FIELDS.has(field)) return result;
  return Math.round(result);
}

function evaluateLevel(common, level) {
  const row = {};
  for (const [field, raw] of Object.entries(common)) {
    if (field === 'maxLevel') continue;
    if (typeof raw !== 'string') {
      // 向量（起止点）等非公式字段原样保留，不参与求值。
      row[field] = raw;
      continue;
    }
    if (!/^-?\d+(?:\.\d+)?$/.test(raw.trim()) && !/[a-zA-Z]/.test(raw)) continue;
    const result = evaluate(raw, level);
    assert(Number.isFinite(result), `非有限求值结果 ${field}@${level}`);
    row[field] = projectScalar(field, result);
  }
  return row;
}

function buildBook(definition) {
  const skillSource = readSource(path.join('Skill', `${definition.book}.json`));
  const stringSource = readSource(path.join('String', 'Skill.json'));
  const skillRoot = JSON.parse(skillSource.text).skill ?? {};
  const stringRoot = JSON.parse(stringSource.text);

  assert.equal(value(stringRoot[definition.book]?._dirType), 'sub', `${definition.book} 书名节点缺失`);
  const bookName = value(stringRoot[definition.book].bookName);

  const nodeIds = Object.keys(skillRoot).filter(id => /^\d+$/.test(id)).sort((a, b) => Number(a) - Number(b));
  const skills = {};
  const ordinary = [];
  const hyper = [];
  const hidden = [];
  const fixed = [];

  for (const id of nodeIds) {
    const node = skillRoot[id];
    const string = stringRoot[id];
    assert(string, `${id} 缺少 String/Skill 条目`);
    const common = unwrap(node.common) ?? {};
    const maxLevel = Number(value(node.common?.maxLevel));
    assert(Number.isSafeInteger(maxLevel) && maxLevel > 0 && maxLevel <= 100, `${id} maxLevel 异常：${maxLevel}`);
    const isHyper = flagNumber(node, 'hyper') > 0;
    const isHidden = flag(node, 'invisible') === '1';
    // 学习前置读**源 `req`**（`req` 才是「需先把某技能练到 N 级」）；`psdSkill` 是
    // 同族/变体标记（会自指，也会指向其它职业的变体号如 214xxxx），**不是**加点前置。
    // 这条区分在 `export_tms273_skills.cjs` 里也是这么落的（`sourceFields.req`）。
    const req = unwrap(node.req) ?? {};
    const variantGroup = Object.keys(unwrap(node.psdSkill) ?? {}).sort();
    if (isHidden) hidden.push(id);
    else if (isHyper) hyper.push(id);
    else ordinary.push(id);
    if (flagNumber(node, 'fixLevel') === 1) fixed.push(id);

    skills[id] = {
      id,
      name: value(string.name),
      description: value(string.desc) ?? null,
      perLevelDescription: value(string.h) ?? null,
      maxLevel,
      infoType: Number(value(node.info?.type) ?? 0),
      elemAttr: value(node.elemAttr) ?? null,
      action: unwrap(node.action) ?? null,
      hyper: flagNumber(node, 'hyper'),
      requiredLevel: flagNumber(node, 'reqLev'),
      fixLevel: flagNumber(node, 'fixLevel') === 1,
      hidden: isHidden,
      notRemoved: flagNumber(node, 'notRemoved') === 1,
      prerequisites: Object.fromEntries(Object.entries(req).sort().map(([key, level]) => [key, Number(level)])),
      variantGroup,
      commonFormulas: common,
      // 只留首末两级：这两级足够核对公式，且避免把 30 级 × 11 字段的表塞满产物。
      levelValues: { '1': evaluateLevel(common, 1), [String(maxLevel)]: evaluateLevel(common, maxLevel) },
    };
  }

  const counts = { ordinary: ordinary.length, hyper: hyper.length, hidden: hidden.length };
  assert.equal(nodeIds.length, counts.ordinary + counts.hyper + counts.hidden);
  // 三条分支的四转必须同形：普通技能的最大等级之和都是 256，扣掉那条源 `fixLevel` 固定技能
  // （不消耗 SP）后各是 255。这条断言是把「设计上说的对称」变成可重算的事实，
  // 而不是让 212/232/222 各自抄一份数（冰雷留档的 spEvidence.localLearnableSpTotal 也是 255）。
  const ordinaryMaxTotal = ordinary.reduce((sum, id) => {
    const fixedNode = flagNumber(skillRoot[id], 'fixLevel') === 1;
    return sum + (fixedNode ? 0 : Number(value(skillRoot[id].common?.maxLevel)));
  }, 0);
  assert.equal(ordinaryMaxTotal, 255, `${definition.book} 可学 SP 与三条分支的 255 不一致`);
  const expectation = definition.expectation;
  assert.equal(nodeIds.length, expectation.nodes, `${definition.book} 节点数与已核定值不一致`);
  assert.deepEqual(counts, {
    ordinary: expectation.ordinary, hyper: expectation.hyper, hidden: expectation.hidden,
  }, `${definition.book} 普通/超技能/隐藏分组与已核定值不一致`);

  return {
    sourceVersion: 'TMS273.7',
    artifact: definition.artifact,
    status: definition.reference ? 'source-verified（已在运行期接线的对照线）' : 'source-verified（设计留档，尚未接运行）',
    authority: {
      primary: 'TMS273.7 WZ_JSON_TW 源导出（Skill/<book>.json + String/Skill.json），字段逐条直读，公式按源串独立求值',
      crossCheck: '客户端 TMS273.7 Data/Skill（含 _Canvas）与打包 .ms 仅作为后续接运行时的素材来源，本产物未解析其图集',
      officialClaim: false,
      boundary: '只记录源里确实存在的节点、公式、需求等级与前置；不推断转职脚本、SP 授予规则、服务端时序或官方数值口径。',
    },
    scope: {
      bookId: definition.book,
      branch: definition.branch,
      job: definition.job,
      previousJob: definition.previousJob,
      jobName: {
        zh: definition.jobName,
        // 本包里**没有** Job.json 之类的职业名权威表（已核：String/ 下无 Job*），
        // 所以名号取「书名 + 层级」与源内可见证据，等级记为 P，不冒充 T。
        classification: 'P',
        evidence: `源书名「${bookName}」与转职层级；本包无职业名权威表，名号沿用项目既有中文命名`,
      },
      bookName: {
        value: bookName,
        source: `String/Skill.img/${definition.book}/bookName`,
      },
      nodeCount: nodeIds.length,
      classificationCounts: counts,
      classificationRule: 'hidden = 源节点 invisible=1；hyper = 源节点 hyper>0（1/2 为两个 Hyper 池）；其余为普通节点。三者互斥，按 hidden > hyper > ordinary 判定。',
      skillIds: nodeIds,
      ordinaryIds: ordinary,
      hyperIds: hyper,
      hiddenIds: hidden,
      fixedLevelIds: fixed,
      formulaPolicy: 'commonFormulas 原样保留源公式串；levelValues 仅记 1 级与满级，并按 RUNTIME_INTEGER_FIELDS（与 server/src/mage.rs::MageLevel 双向断言的那张表）在投影处取整，非契约字段原样带出。',
      learnabilityPolicy: '本产物**不**声称任何节点可学：普通/超技能/隐藏只是源侧分类，职业归属、SP 花费、转职顺序与等级门槛仍由运行期拥有。',
      visualPolicy: '未解析图集。图标/特效帧所在的 _Canvas_XXX.wz、角色动作（bodyAction/avatarAction）需在接运行时按 ice-fourth-job-source.json 的 visualGroups 口径补齐。',
      soundPolicy: '未解析音频。Sound/Skill 子节点与 UOL 链接需在接运行时补齐。',
    },
    sourceFiles: [skillSource.meta, stringSource.meta],
    skills,
    conclusions: {
      bookName,
      nodeCount: nodeIds.length,
      classificationCounts: counts,
      fixedLevelSkills: fixed,
      unverified: [
        '转职脚本（源链 1452/1453、36330–36333 的执行脚本 q1453s/q1453e 等在本包中不存在）',
        'SP 授予与逐级分档',
        '各技能的服务端命中时序与结算',
        '图集/动作/音效的挂载与体积',
      ],
    },
  };
}

function main() {
  const print = process.argv.includes('--print');
  const outputs = [];
  for (const definition of BOOKS) {
    const artifact = buildBook(definition);
    outputs.push(artifact);
    if (print) continue;
    const file = path.join(OUT_DIR, `${definition.artifact}.json`);
    if (definition.reference) {
      // 对照线：既有留档是手写格式（用 skillCount 而非 nodeCount），本脚本只做**只读**核对，不覆盖它。
      // 这是本产物最有价值的一次交叉验证：手写留档与「从源独立重算」必须对上。
      const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
      const existingCount = existing.scope.skillCount ?? existing.scope.nodeCount;
      assert.equal(existingCount, artifact.scope.nodeCount,
        `${definition.book} 既有留档节点数与源重算不一致`);
      assert.deepEqual(existing.scope.classificationCounts, artifact.scope.classificationCounts,
        `${definition.book} 既有留档分组与源重算不一致`);
      assert.deepEqual([...existing.scope.skillIds].sort(), [...artifact.scope.skillIds].sort(),
        `${definition.book} 既有留档节点集与源重算不一致`);
      console.log(`对照 ${definition.artifact}.json：节点集/节点数/分组与源重算一致（未改写）`);
      continue;
    }
    fs.writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    console.log(`写出 ${path.relative(ROOT, file)}：${artifact.scope.nodeCount} 节点 `
      + `(普通 ${artifact.scope.classificationCounts.ordinary} / 超技能 ${artifact.scope.classificationCounts.hyper} / 隐藏 ${artifact.scope.classificationCounts.hidden})`);
  }
  if (print) console.log(JSON.stringify(outputs, null, 2));
}

main();
