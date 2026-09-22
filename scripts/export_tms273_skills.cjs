#!/usr/bin/env node

// Export verified skill assets from the TMS273.7 client data.
// Retain source formulas/direct beginner rows; combat remains server-owned.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const wz = require('@tybys/wz');
const { createReader } = require('./tms273_wz.cjs');
const { evaluate } = require('./tms273_skill_formulas.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const OUTPUT = path.join(ROOT, 'resources/tms273-export');
const ASSETS = path.join(OUTPUT, 'assets/tms273');
const UNPACKER = path.join(ROOT, 'scripts/unpack_tms273_ms/target/debug/unpack_tms273_ms');
const SKILLS = [
  {
    id: '2001008',
    job: 200,
    image: 'Skill/200.img',
    skillJson: 'Skill/200.json',
    canvasArchive: 'Skill/_Canvas/_Canvas_035.wz',
    bodyAction: 'energyBolt',
    assetKinds: ['icon', 'iconMouseOver', 'iconDisabled', 'effect', 'ball', 'special', 'hit'],
    missingAssetKinds: [],
    unlockReason: 'Skill/200.img only exposes skillList[0]=400021000; no job/level unlock rule is present in this export.',
  },
  {
    id: '2201008',
    job: 220,
    image: 'Skill/220.img',
    skillJson: 'Skill/220.json',
    canvasArchive: 'Skill/_Canvas/_Canvas_040.wz',
    bodyAction: 'coldBeam',
    assetKinds: ['icon', 'iconMouseOver', 'iconDisabled', 'effect', 'effect0', 'hit'],
    missingAssetKinds: ['ball', 'special'],
    unlockReason: 'Skill/220.img does not provide a verified job/level unlock condition in this export.',
  },
  {
    id: '2201005',
    job: 220,
    image: 'Skill/220.img',
    skillJson: 'Skill/220.json',
    canvasArchive: 'Skill/_Canvas/_Canvas_040.wz',
    bodyAction: 'thunderBolt',
    assetKinds: ['icon', 'iconMouseOver', 'iconDisabled', 'effect', 'hit'],
    missingAssetKinds: ['effect0', 'ball', 'special'],
    unlockReason: 'Skill/220.img does not provide a verified job/level unlock condition in this export.',
  },
  {
    id: '2211002',
    job: 221,
    image: 'Skill/221.img',
    skillJson: 'Skill/221.json',
    canvasArchive: 'Skill/_Canvas/_Canvas_040.wz',
    bodyAction: 'iceStrike',
    assetKinds: ['icon', 'iconMouseOver', 'iconDisabled', 'effect', 'effect0', 'hit'],
    missingAssetKinds: [],
    unlockReason: 'Skill/221.img has no verified job/level unlock rule in this export; the P job-transfer rule is applied by the runtime owner.',
  },
  {
    // The client/source uses a six-digit id under Skill/000.img.  Runtime
    // payloads use the normalized numeric id while every source reference
    // keeps the original leading zeroes for auditability.
    id: '1000',
    sourceId: '0001000',
    job: 0,
    image: 'Skill/000.img',
    skillJson: 'Skill/000.json',
    canvasArchive: 'Skill/_Canvas/_Canvas_000.wz',
    sourceAction: 'swingO1',
    avatarAction: 'attack',
    bodyAction: null,
    assetKinds: ['icon', 'iconMouseOver', 'iconDisabled'],
    levelAssetKinds: ['ball', 'hit'],
    missingAssetKinds: [],
    unlockReason: 'Skill/000.img has no verified job/level unlock rule in this export; beginner SP and availability remain runtime-owned.',
  },
  {
    id: '1001',
    sourceId: '0001001',
    job: 0,
    image: 'Skill/000.img',
    skillJson: 'Skill/000.json',
    canvasArchive: 'Skill/_Canvas/_Canvas_000.wz',
    bodyAction: null,
    assetKinds: ['icon', 'iconMouseOver', 'iconDisabled', 'effect'],
    levelAssetKinds: [],
    missingAssetKinds: [],
    unlockReason: 'Skill/000.img has no verified job/level unlock rule in this export; beginner SP and availability remain runtime-owned.',
  },
  {
    id: '1002',
    sourceId: '0001002',
    job: 0,
    image: 'Skill/000.img',
    skillJson: 'Skill/000.json',
    canvasArchive: 'Skill/_Canvas/_Canvas_000.wz',
    bodyAction: null,
    assetKinds: ['icon', 'iconMouseOver', 'iconDisabled', 'effect'],
    levelAssetKinds: [],
    missingAssetKinds: [],
    unlockReason: 'Skill/000.img has no verified job/level unlock rule in this export; beginner SP and availability remain runtime-owned.',
  },
  // The fourth-job book includes ordinary and Hyper source nodes.
  // Hidden Hyper 2221055 remains a server-only variant, never a learning grant.
  // The ordinary final-attack variant remains outside this catalog.
  {
    id: '2221000',
    job: 222,
    image: 'Skill/222.img',
    skillJson: 'Skill/222.json',
    canvasArchives: [
      'Skill/_Canvas/_Canvas_003.wz',
      'Skill/_Canvas/_Canvas_038.wz',
      'Skill/_Canvas/_Canvas_040.wz',
    ],
    bodyAction: null,
    assetKinds: ['icon', 'iconMouseOver', 'iconDisabled', 'effect', 'effect0'],
    missingAssetKinds: [],
    catalogDefinition: true,
    catalogSkillIds: [
      '2220010', '2220013', '2220015',
      '2221000', '2221004', '2221005', '2221006', '2221007',
      '2221008', '2221011', '2221012',
      '2220043', '2220044', '2221045', '2220046', '2220047', '2220048',
      '2220049', '2220050', '2220051', '2221052', '2221053', '2221054', '2221055',
    ],
    unlockReason: 'Skill/222.img has no verified job/level unlock rule in this export; the P job-transfer and SP rule remain runtime-owned.',
  },
  {
    id: '2220010',
    job: 222,
    image: 'Skill/222.img',
    skillJson: 'Skill/222.json',
    canvasArchives: ['Skill/_Canvas/_Canvas_038.wz', 'Skill/_Canvas/_Canvas_040.wz'],
    assetKinds: ['icon', 'iconMouseOver', 'iconDisabled', 'number'],
    missingAssetKinds: [],
    unlockReason: 'Source passive node; no verified job/level unlock rule is present in this export.',
  },
  {
    id: '2220013',
    job: 222,
    image: 'Skill/222.img',
    skillJson: 'Skill/222.json',
    canvasArchive: 'Skill/_Canvas/_Canvas_040.wz',
    assetKinds: ['icon', 'iconMouseOver', 'iconDisabled'],
    missingAssetKinds: [],
    unlockReason: 'Source passive node; no verified job/level unlock rule is present in this export.',
  },
  {
    id: '2220014',
    job: 222,
    image: 'Skill/222.img',
    skillJson: 'Skill/222.json',
    canvasArchive: 'Skill/_Canvas/_Canvas_040.wz',
    assetKinds: ['icon', 'iconMouseOver', 'iconDisabled', 'hit'],
    missingAssetKinds: ['effect', 'effect0'],
    includeInCatalog: false,
    unlockReason: 'Hidden final-attack source variant; exported for triggered hit/effect provenance only and excluded from the learnable catalog.',
  },
  {
    id: '2220015',
    job: 222,
    image: 'Skill/222.img',
    skillJson: 'Skill/222.json',
    canvasArchive: 'Skill/_Canvas/_Canvas_040.wz',
    assetKinds: ['icon', 'iconMouseOver', 'iconDisabled'],
    missingAssetKinds: [],
    unlockReason: 'Source fixed-level passive node; no verified job/level unlock rule is present in this export.',
  },
  {
    id: '2221004',
    job: 222,
    image: 'Skill/222.img',
    skillJson: 'Skill/222.json',
    canvasArchives: ['Skill/_Canvas/_Canvas_038.wz', 'Skill/_Canvas/_Canvas_040.wz'],
    bodyAction: 'alert2',
    assetKinds: ['icon', 'iconMouseOver', 'iconDisabled', 'effect', 'effect0', 'special', 'special0', 'specialAffected', 'specialAffected0'],
    missingAssetKinds: [],
    unlockReason: 'Skill/222.img has no verified job/level unlock rule in this export; the P job-transfer and SP rule remain runtime-owned.',
  },
  {
    id: '2221005',
    job: 222,
    image: 'Skill/222.img',
    skillJson: 'Skill/222.json',
    canvasArchive: 'Skill/_Canvas/_Canvas_040.wz',
    bodyAction: 'alert2',
    assetKinds: ['icon', 'iconMouseOver', 'iconDisabled', 'effect', 'hit'],
    missingAssetKinds: [],
    levelValues: true,
    unlockReason: 'Skill/222.img has no verified job/level unlock rule in this export; source req 2200006:10 is preserved for the runtime owner.',
  },
  {
    id: '2221006',
    job: 222,
    image: 'Skill/222.img',
    skillJson: 'Skill/222.json',
    canvasArchive: 'Skill/_Canvas/_Canvas_040.wz',
    bodyAction: 'chainLightningNew',
    assetKinds: ['icon', 'iconMouseOver', 'iconDisabled', 'effect', 'ball', 'hit', 'mob'],
    missingAssetKinds: [],
    levelValues: true,
    unlockReason: 'Skill/222.img has no verified job/level unlock rule in this export; chain target count and penalty remain source/runtime fields.',
  },
  {
    id: '2221007',
    job: 222,
    image: 'Skill/222.img',
    skillJson: 'Skill/222.json',
    canvasArchive: 'Skill/_Canvas/_Canvas_040.wz',
    bodyAction: 'blizzardNew',
    assetKinds: ['icon', 'iconMouseOver', 'iconDisabled', 'effect', 'effect0', 'hit', 'tile'],
    missingAssetKinds: [],
    levelValues: true,
    unlockReason: 'Skill/222.img has no verified job/level unlock rule in this export; 12 hits/15 targets and hidden additional attack stay source/runtime-owned.',
  },
  {
    id: '2221008',
    job: 222,
    image: 'Skill/222.img',
    skillJson: 'Skill/222.json',
    canvasArchives: ['Skill/_Canvas/_Canvas_003.wz', 'Skill/_Canvas/_Canvas_040.wz'],
    assetKinds: ['icon', 'iconMouseOver', 'iconDisabled', 'effect', 'effect0'],
    missingAssetKinds: [],
    unlockReason: 'Skill/222.img has no verified job/level unlock rule in this export; common.time=1 is retained without resolving the source String description timing.',
  },
  {
    id: '2221011',
    job: 222,
    image: 'Skill/222.img',
    skillJson: 'Skill/222.json',
    canvasArchive: 'Skill/_Canvas/_Canvas_040.wz',
    bodyAction: 'armorMelting',
    assetKinds: ['icon', 'iconMouseOver', 'iconDisabled', 'mob', 'special', 'specialAffected', 'prepare', 'keydown', 'keydown0', 'keydownend'],
    missingAssetKinds: ['effect', 'effect0', 'ball', 'hit'],
    levelValues: true,
    unlockReason: 'Skill/222.img has no verified job/level unlock rule in this export; keydown bind duration formula and server start/cancel timing remain runtime-owned.',
  },
  {
    id: '2221012',
    job: 222,
    image: 'Skill/222.img',
    skillJson: 'Skill/222.json',
    canvasArchive: 'Skill/_Canvas/_Canvas_040.wz',
    bodyAction: 'frozenOrb',
    assetKinds: ['icon', 'iconMouseOver', 'iconDisabled', 'effect', 'hit', 'ball'],
    missingAssetKinds: [],
    levelValues: true,
    unlockReason: 'Skill/222.img has no verified job/level unlock rule in this export; common.time=4000 and attackDelay=210 remain raw source units.',
  },
];
// T: Hyper visuals and body pose; source animation timing is not hit scheduling.
for (const [id, groups, bodyAction] of [
  ['2221052', ['prepare', 'keydown', 'keydownend', 'special', 'hit'], 'HY222lightningSphere'],
  ['2221053', ['effect', 'effect0', 'affected'], null],
  ['2221054', ['effect', 'start', 'repeat', 'end'], null],
  ['2221055', ['effect', 'tile', 'tile0'], null],
]) SKILLS.push({
  id, job: 222, image: 'Skill/222.img', skillJson: 'Skill/222.json', bodyAction,
  canvasArchives: ['Skill/_Canvas/_Canvas_003.wz', 'Skill/_Canvas/_Canvas_038.wz', 'Skill/_Canvas/_Canvas_040.wz'],
  assetKinds: ['icon', 'iconMouseOver', 'iconDisabled', ...groups], missingAssetKinds: [],
  unlockReason: 'T: source hyper/reqLev and hidden flags; independent Hyper points use the documented R/P runtime rule.',
});
// ── 火毒（210/211）与僧侶（230/231）分支 ──────────────────────────────────────
// 口径与冰雷三本一致：**每本书只登记会被服务端执行的施法技能**，其余节点由该书的
// catalogDefinition 自动展开成图鉴条目（图标 + 名称 + 逐级字段），不重复登记资产。
// 因此这里每个 job 的第一条同时充当该书的分词定义，`image`/`skillJson` 由它决定。
//
// 分卷归属是实测的（2026-09-21 逐卷枚举 `Skill/_Canvas/*.wz` 的顶层映像名）：
//   000.img → `_Canvas_000.wz`；200/210/211.img → `_Canvas_035.wz`；
//   220/221/222.img → `_Canvas_040.wz`；230/231.img → `_Canvas_043.wz`
// 外链解析按卷名排序取**第一个含该映像**的卷，所以列多了不会错、列少了会整块缺图。
// 跨书引用必须跟着挂：2300000/2301002 的 `effect` 落在 210.img、2300011 的图标即
// 2100011 的图标、2310010 的图标即 2110011 的图标 ⇒ 230/231 两条**同时**要挂 035。
// 2311004 的 `mob` 落在 10100.img（`_Canvas_000.wz`）——挂 000 是为了这个，不是 231 本体。
// 2310013 的图标即 2311009 的、2311017 的图标即 2311015 的，两者都还在 043 里，不用额外挂。
// 判据出自 `Skill/_Canvas/*.wz` 逐卷枚举，不是从文件名猜的；215 章以后的源树若重新分卷，
// 这里必须重跑同一枚举，别只改编号。
const FIRE_POISON_BRANCHES = [
  {
    id: '2101004',
    job: 210,
    // 210/211 本身归 035；跨书引用也只落在 035 上，所以这一组只需一卷。
    canvasArchives: ['Skill/_Canvas/_Canvas_035.wz'],
    bodyAction: 'flameOrb',
    assetKinds: ['icon', 'iconMouseOver', 'iconDisabled', 'effect', 'hit'],
  },
  {
    id: '2101005',
    job: 210,
    canvasArchives: ['Skill/_Canvas/_Canvas_035.wz'],
    bodyAction: 'poisonBreath',
    assetKinds: ['icon', 'iconMouseOver', 'iconDisabled', 'effect', 'hit'],
  },
  {
    id: '2111002',
    job: 211,
    canvasArchives: ['Skill/_Canvas/_Canvas_035.wz'],
    bodyAction: 'explosion',
    assetKinds: ['icon', 'iconMouseOver', 'iconDisabled', 'effect', 'hit'],
  },
  {
    id: '2301002',
    job: 230,
    // 本体在 043；`effect` 落在 210.img、图鉴里 2300011 的图标即 2100011 的图标 ⇒ 还要 035。
    canvasArchives: ['Skill/_Canvas/_Canvas_035.wz', 'Skill/_Canvas/_Canvas_043.wz'],
    bodyAction: 'alert2',
    assetKinds: ['icon', 'iconMouseOver', 'iconDisabled', 'effect', 'effect0', 'affected', 'affected0', 'hit'],
  },
  {
    id: '2301005',
    job: 230,
    canvasArchives: ['Skill/_Canvas/_Canvas_035.wz', 'Skill/_Canvas/_Canvas_043.wz'],
    bodyAction: 'holyArrow',
    assetKinds: ['icon', 'iconMouseOver', 'iconDisabled', 'effect', 'hit'],
  },
  {
    id: '2311004',
    job: 231,
    // 本体在 043；2311004 的 `mob` 落在 10100.img（`_Canvas_000.wz`）⇒ 还要挂 000。
    canvasArchives: [
      'Skill/_Canvas/_Canvas_000.wz',
      'Skill/_Canvas/_Canvas_035.wz',
      'Skill/_Canvas/_Canvas_043.wz',
    ],
    bodyAction: 'alert5',
    assetKinds: ['icon', 'iconMouseOver', 'iconDisabled', 'effect', 'effect0', 'hit', 'mob'],
  },
];
for (const entry of FIRE_POISON_BRANCHES) SKILLS.push({
  ...entry,
  image: `Skill/${entry.job}.img`,
  skillJson: `Skill/${entry.job}.json`,
  missingAssetKinds: [],
  unlockReason: `Skill/${entry.job}.img has no verified job/level unlock rule in this export; the P job-transfer and SP rule remain runtime-owned.`,
});
// ── 四转：火毒 212 / 主教 232（与冰雷 222 同一转职层级）─────────────────────
// 这两本与 222 同形：**只登记图鉴条目**（名称 / 描述 / 逐级字段 / 图标），不导出施法资产。
// 原因与 210/211/230/231 那一段不同——那四本的施法技能已被服务端执行，所以登记了资产；
// 212／232 的施法技能本轮**没有服务端执行路径**（源转职链 1452／1453 的目标地图不在源包，
// 见 `docs/design/法师分支转职设计_火毒与主教.md`），登记资产等于把一批没有消费者的图集
// 挂进产物。等哪条四转技能真的被服务端接管，再比照 222 的那组为它单独登记。
// 条目数由 `Skill/<book>.json` 的全部数字节点决定（212 = 24、232 = 27，含 invisible 变体），
// 由下面的 `expectedCatalogCounts` 逐本钉住。
//
// 图集分卷是**实测**的（2026-09-21 逐卷枚举 `Skill/_Canvas/*.wz` 的顶层映像名，与上面
// 210/211/230/231 那一段同一条判据）：`212.img → _Canvas_038.wz`、`232.img → _Canvas_045.wz`
// （222.img 在 040）。图标外链必须落在这些卷里才解得开像素——不挂卷会在导出期直接报
// 「像素分卷缺失」，而不是静默出空图。230/231 的 043 与 210/211 的 035 一并挂上，是因为
// 四转书的图标与既有分支同源（例如 2120014 元素強化沿用元素吸收族的图标）。
const FOURTH_JOB_BOOKS = [
  {
    id: '2121000',
    job: 212,
    canvasArchives: [
      'Skill/_Canvas/_Canvas_035.wz',
      'Skill/_Canvas/_Canvas_038.wz',
    ],
    unlockReason: 'Skill/212.img carries no verified job/level unlock rule in this export; 火毒四转的转职链与 SP 授予仍由运行期持有。',
  },
  {
    id: '2321000',
    job: 232,
    canvasArchives: [
      'Skill/_Canvas/_Canvas_043.wz',
      'Skill/_Canvas/_Canvas_045.wz',
    ],
    unlockReason: 'Skill/232.img carries no verified job/level unlock rule in this export; 主教四转的转职链与 SP 授予仍由运行期持有。',
  },
];
for (const entry of FOURTH_JOB_BOOKS) SKILLS.push({
  ...entry,
  image: `Skill/${entry.job}.img`,
  skillJson: `Skill/${entry.job}.json`,
  bodyAction: null,
  // 只做图鉴条目：图标由 catalog 循环统一导出，这里不额外登记任何资产组。
  assetKinds: [],
  missingAssetKinds: [],
});
const SKILL_ID = SKILLS[0].id;
const SKILL_IMAGE = SKILLS[0].image;
const SKILL_SOURCE = `Skill/200.img/skill/${SKILL_ID}`;
const BODY_SOURCE = `Character/00002000.img/${SKILLS[0].bodyAction}`;
// 源树里有**两份** WZ_JSON_TW，且不完整的是导出器原先指着的那一份（2026-09-21 实测）：
//   A = `TMS273/WZ_JSON_TW`            —— 缺 `Skill/220.json`、缺 `String/Skill.json`
//   B = `手工服务端/tms273/WZ_JSON_TW`  —— `Skill/` 八本齐全，且有 `String/Skill.json`
//                                        （14480 条技能名/描述，含 210/211/230/231）
// 两份**同名的** `Skill/*.json` 已逐字节比对过，完全相同 ⇒ 按 A→B 顺序取第一个存在的文件，
// 对既有产物零影响，只是把 A 缺的那两个补上。写死单一路径会让导出在源树漂移时直接跑不动。
const WZ_JSON_ROOTS = [
  path.join(ROOT, '参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW'),
  path.join(ROOT, '参考/273/TMS273少爷一键端/手工服务端/tms273/WZ_JSON_TW'),
];

/** 在已知的两份源树里找第一个存在的文件；都没有就报出两条候选路径。 */
function sourceJsonPath(relativePath) {
  for (const root of WZ_JSON_ROOTS) {
    const candidate = path.join(root, relativePath);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`${relativePath} 在已知的两份 WZ_JSON_TW 里都不存在：\n${WZ_JSON_ROOTS.join('\n')}`);
}

const STRING_JSON = sourceJsonPath('String/Skill.json');

function sourceSkillId(definition, id = definition.id) {
  return definition.sourceId || id;
}

function runtimeSkillId(definition, id = definition.id) {
  if (definition.job === 0 && /^0+\d+$/.test(id)) return String(Number(id));
  return definition.runtimeId || id;
}

function children(node) {
  return [...(node?.wzProperties || [])];
}

function numeric(node) {
  return children(node).filter(child => /^\d+$/.test(child.name)).sort((a, b) => Number(a.name) - Number(b.name));
}

function primitive(node, name, fallback = null) {
  const value = node?.at?.(name)?.wzValue;
  return ['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'bigint' ? value : fallback;
}

function point(node, name) {
  const value = node?.at?.(name)?.wzValue;
  return value && Number.isFinite(Number(value.x)) && Number.isFinite(Number(value.y))
    ? { x: Number(value.x), y: Number(value.y) }
    : null;
}

function unwrap(value) {
  if (!value || typeof value !== 'object') return value;
  if (value._dirType === 'vector') return { x: value._x, y: value._y };
  if (Object.prototype.hasOwnProperty.call(value, '_value')) return value._value;
  if (value._dirType === 'sub') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== '_dirType').map(([key, child]) => [key, unwrap(child)]));
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, unwrap(child)]));
}

function hasField(node, name) {
  return Boolean(node && Object.prototype.hasOwnProperty.call(node, name));
}

function fieldValue(node, name) {
  return hasField(node, name) ? unwrap(node[name]) : null;
}

function catalogDisplayFlags(rawSkill) {
  const passiveFields = ['psd', 'psdWT', 'psdWeaponBooster'];
  return {
    // These are source-presence markers. They do not decide whether a skill
    // can be learned or whether it belongs to an SP group.
    hasInvisible: hasField(rawSkill, 'invisible'),
    derived: {
      passive: passiveFields.some(field => hasField(rawSkill, field)),
      fixedLevel: hasField(rawSkill, 'fixLevel'),
      skillType: hasField(rawSkill, 'skillType'),
      showFromTheHead: hasField(rawSkill.info, 'showFromTheHead'),
    },
    source: {
      invisible: fieldValue(rawSkill, 'invisible'),
      psd: fieldValue(rawSkill, 'psd'),
      psdWT: fieldValue(rawSkill, 'psdWT'),
      psdWeaponBooster: fieldValue(rawSkill, 'psdWeaponBooster'),
      fixLevel: fieldValue(rawSkill, 'fixLevel'),
      skillType: fieldValue(rawSkill, 'skillType'),
      infoShowFromTheHead: fieldValue(rawSkill.info, 'showFromTheHead'),
    },
  };
}

// Only the four fields consumed by ordinary attack skill descriptions are
// calculated here. No player-stat damage or server hit timing is inferred.
function levelValues(common) {
  const maximum = Number(common.maxLevel);
  assert(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= 100, 'invalid maxLevel');
  return Array.from({ length: maximum }, (_, index) => {
    const level = index + 1;
    const row = { level };
    for (const field of ['mpCon', 'damage', 'mobCount', 'attackCount']) {
      assert(typeof common[field] === 'string', `missing formula: ${field}`);
      const value = evaluate(common[field], level);
      assert(Number.isSafeInteger(value) && value >= 0, `invalid ${field} at level ${level}`);
      row[field] = value;
    }
    return row;
  });
}

// Beginner Skill/000.img stores concrete rows under `level` instead of the
// formula-bearing `common` node used by mage books. Keep those rows intact in
// sourceFields; mageRules performs the narrow numeric projection for combat.
function beginnerLevelRows(sourceFields) {
  const levels = sourceFields?.level;
  assert(levels && typeof levels === 'object', 'beginner level rows are missing');
  const entries = Object.entries(levels)
    .filter(([level]) => /^\d+$/.test(level))
    .sort(([left], [right]) => Number(left) - Number(right));
  assert(entries.length > 0, 'beginner level rows are empty');
  return entries.map(([level, row]) => ({ level: Number(level), ...row }));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function relative(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function sourceFile(file) {
  const stat = fs.statSync(file);
  return { path: relative(file), bytes: stat.size, sha256: sha256(file) };
}

async function get(reader, source) {
  try {
    const node = await reader.get(source);
    if (node instanceof wz.WzImage) assert(await node.parseImage(), source);
    return node;
  } catch (error) {
    throw new Error(`${source}: ${error.message}`, { cause: error });
  }
}

function runUnpacker(tempRoot, images) {
  assert(fs.existsSync(UNPACKER), `missing Rust MS unpacker: ${UNPACKER}`);
  const result = spawnSync(UNPACKER, [
    '--packs', path.join(DATA, 'Packs'),
    '--out', tempRoot,
    ...images.flatMap(image => ['--image', image]),
  ], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`技能图像解包失败:\n${result.stdout}\n${result.stderr}`);
  const reportPath = path.join(tempRoot, 'manifest.json');
  assert(fs.existsSync(reportPath), `MS unpack manifest missing: ${reportPath}`);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const entries = Object.fromEntries(images.map(image => {
    const entry = report.entries?.find(item => item.image === image && item.status === 'ok');
    assert(entry, `MS unpack did not produce ${image}`);
    assert(fs.existsSync(path.join(tempRoot, image)), `unpacked ${image} missing`);
    return [image, entry];
  }));
  return { report, entries };
}

function linkCanvasArchives(tempRoot, archives) {
  const directory = path.join(tempRoot, 'Skill/_Canvas');
  fs.mkdirSync(directory, { recursive: true });
  for (const archive of archives) {
    assert(fs.existsSync(archive), `missing Canvas source: ${archive}`);
    // ResourceReader selects _Canvas*.wz by the logical _Canvas directory stem.
    fs.symlinkSync(archive, path.join(directory, path.basename(archive)));
  }
}

async function exportFrame(reader, source, kind) {
  const raw = await get(reader, source);
  const frame = await reader.frame(source, ASSETS);
  const assetPath = path.join(ASSETS, frame.url);
  assert(fs.existsSync(assetPath), `asset was not written: ${source}`);
  assert(frame.width > 0 && frame.height > 0, `invalid Canvas dimensions: ${source}`);
  const rawDelay = primitive(raw, 'delay');
  const rawOrigin = point(raw, 'origin');
  const rawOutlink = primitive(raw, '_outlink');
  const missing = [];
  if (!rawOrigin) missing.push('origin');
  if (rawDelay === null) missing.push('delay');
  if (!rawOutlink) missing.push('outlink');
  const staticKind = kind === 'icon' || kind === 'iconMouseOver' || kind === 'iconDisabled';
  const metadataStatus = staticKind && missing.length === 1 && missing[0] === 'delay'
    ? 'static-delay-missing'
    : missing.length ? 'incomplete' : 'complete';
  return {
    source,
    resolvedSource: frame.resolvedSource,
    status: 'exported',
    metadataStatus,
    outlink: rawOutlink,
    origin: rawOrigin,
    delay: rawDelay,
    width: frame.width,
    height: frame.height,
    url: `/assets/tms273/${frame.url}`,
    bytes: fs.statSync(assetPath).size,
    sha256: sha256(assetPath),
  };
}

async function exportCatalogIcons(reader, skillSource, skillNode, skillId, iconGaps) {
  const icons = {};
  const iconKinds = [
    ['icon', 'normal'],
    ['iconMouseOver', 'mouseOver'],
    ['iconDisabled', 'disabled'],
  ];
  const available = new Set(children(skillNode).map(child => child.name));
  for (const [sourceKind, outputKind] of iconKinds) {
    const source = `${skillSource}/${sourceKind}`;
    if (!available.has(sourceKind)) {
      iconGaps.push({
        skill: skillId,
        source,
        group: outputKind,
        status: 'source-missing',
        reason: `${source} is absent from the TMS273.7 Skill image; no icon was fabricated.`,
      });
      icons[outputKind] = null;
      continue;
    }
    icons[outputKind] = await exportFrame(reader, source, sourceKind);
  }
  return icons;
}

async function exportBodyTimeline(reader, source) {
  const node = await get(reader, source);
  const frames = numeric(node).map(frame => {
    const rawFrame = primitive(frame, 'frame');
    const rawDelay = primitive(frame, 'delay');
    return {
      index: Number(frame.name),
      source: `${source}/${frame.name}`,
      action: primitive(frame, 'action'),
      frame: Number.isFinite(Number(rawFrame)) ? Number(rawFrame) : rawFrame,
      delay: Number.isFinite(Number(rawDelay)) ? Number(rawDelay) : rawDelay,
      move: point(frame, 'move'),
    };
  });
  assert(frames.length > 0, `${source} timeline is empty`);
  assert(frames.every(frame => typeof frame.action === 'string' && Number.isFinite(frame.frame) && Number.isFinite(frame.delay)), `${source} timeline is incomplete`);
  return { source, frames };
}

async function exportAssetGroup(reader, skillSource, kind) {
  const source = `${skillSource}/${kind}`;
  const node = await get(reader, source);
  const groups = [];
  // Most groups use numeric children, while `number`, `ball/front/rear`,
  // and a few summon branches use named Canvas/sub-property children.  Keep
  // both source forms and ignore scalar metadata nodes.
  const numericChildren = numeric(node);
  const namedFrames = new Set(['front', 'rear']);
  const candidates = children(node)
    .filter(child => /^\d+$/.test(child.name)
      || (numericChildren.length === 0
        && ['WzCanvasProperty', 'WzSubProperty', 'WzUOLProperty'].includes(child?.constructor?.name))
      || namedFrames.has(child.name))
    .sort((left, right) => {
      const leftNumeric = /^\d+$/.test(left.name);
      const rightNumeric = /^\d+$/.test(right.name);
      if (leftNumeric && rightNumeric) return Number(left.name) - Number(right.name);
      if (leftNumeric) return -1;
      if (rightNumeric) return 1;
      return left.name.localeCompare(right.name);
    });
  for (const child of candidates) {
    const childSource = `${source}/${child.name}`;
    const nested = numeric(child);
    if (nested.length === 0) {
      groups.push(await exportFrame(reader, childSource, kind));
      continue;
    }
    for (const frame of nested) {
      groups.push(await exportFrame(reader, `${childSource}/${frame.name}`, kind));
    }
  }
  assert(groups.length > 0, `${source} has no Canvas frames`);
  return groups;
}

function sourceGap(skillSource, kind, reason) {
  return {
    source: `${skillSource}/${kind}`,
    group: kind,
    status: 'source-missing',
    reason,
  };
}

function missingAssetReason(skillSource, kind) {
  return `${skillSource}/${kind} is absent from the TMS273.7 Skill image; no asset was fabricated.`;
}

function uniqueFiles(files) {
  const seen = new Set();
  return files.filter(file => {
    const key = path.resolve(file);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function main() {
  fs.mkdirSync(ASSETS, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tms273-skill-'));
  let reader;
  let bodyReader;
  try {
    const images = [...new Set(SKILLS.map(skill => skill.image))];
    const extraction = runUnpacker(tempRoot, images);
    const canvasArchives = [...new Set(SKILLS.flatMap(skill => {
      const archives = skill.canvasArchives || (skill.canvasArchive ? [skill.canvasArchive] : []);
      return archives.map(archive => path.join(DATA, archive));
    }))];
    linkCanvasArchives(tempRoot, canvasArchives);
    reader = createReader(tempRoot, tempRoot);
    // Character/00002000.img is a separate WZ archive. Keep the targeted
    // Skill extraction reader isolated from the original body archive so the
    // MS unpacker never needs to copy or scan unrelated client data.
    bodyReader = createReader(DATA);

    const skillJsonPaths = new Map();
    for (const skill of SKILLS) {
      const file = sourceJsonPath(skill.skillJson);
      if (!skillJsonPaths.has(skill.skillJson)) skillJsonPaths.set(skill.skillJson, file);
    }
    const skillJsons = new Map([...skillJsonPaths].map(([name, file]) => [name, JSON.parse(fs.readFileSync(file, 'utf8'))]));
    const stringJson = JSON.parse(fs.readFileSync(STRING_JSON, 'utf8'));
    const bodyArchive = path.join(DATA, 'Character/Character_000.wz');
    const skillOutputs = {};
    const metadataGaps = [];
    const assetGaps = [];
    for (const definition of SKILLS) {
      const sourceId = sourceSkillId(definition);
      const runtimeId = runtimeSkillId(definition);
      const skillSource = `${definition.image}/skill/${sourceId}`;
      const rawSkill = skillJsons.get(definition.skillJson)?.skill?.[sourceId];
      const rawString = stringJson[sourceId];
      assert(rawSkill && rawString, `${sourceId} source JSON is missing`);
      const skillNode = await get(reader, skillSource);
      const availableKinds = new Set(children(skillNode).map(child => child.name));
      const assetGroups = {};
      for (const kind of definition.assetKinds) {
        if (!availableKinds.has(kind)) {
          assetGaps.push({ skill: runtimeId, ...sourceGap(skillSource, kind, missingAssetReason(skillSource, kind)) });
          continue;
        }
        assetGroups[kind] = kind.startsWith('icon')
          ? [await exportFrame(reader, `${skillSource}/${kind}`, kind)]
          : await exportAssetGroup(reader, skillSource, kind);
      }
      for (const kind of definition.missingAssetKinds) {
        assert(!availableKinds.has(kind), `${skillSource}/${kind} unexpectedly exists; add it to assetKinds`);
        assetGaps.push({ skill: runtimeId, ...sourceGap(skillSource, kind, missingAssetReason(skillSource, kind)) });
      }
      const levelAssetGroups = {};
      if (definition.levelAssetKinds?.length) {
        const levelRootSource = `${skillSource}/level`;
        const levelRoot = await get(reader, levelRootSource);
        const levelNodes = numeric(levelRoot);
        assert(levelNodes.length > 0, `${levelRootSource} has no level nodes`);
        for (const levelNode of levelNodes) {
          const level = levelNode.name;
          const levelSource = `${levelRootSource}/${level}`;
          const availableLevelKinds = new Set(children(levelNode).map(child => child.name));
          levelAssetGroups[level] = {};
          for (const kind of definition.levelAssetKinds) {
            const source = `${levelSource}/${kind}`;
            if (!availableLevelKinds.has(kind)) {
              assetGaps.push({ skill: runtimeId, level: Number(level), ...sourceGap(levelSource, kind, missingAssetReason(levelSource, kind)) });
              continue;
            }
            levelAssetGroups[level][kind] = await exportAssetGroup(reader, levelSource, kind);
          }
        }
      }
      const allAssetFrames = [
        ...Object.values(assetGroups).flat(),
        ...Object.values(levelAssetGroups).flatMap(level => Object.values(level).flat()),
      ];
      const skillMetadataGaps = allAssetFrames.filter(frame => frame.metadataStatus !== 'complete');
      metadataGaps.push(...skillMetadataGaps.map(frame => ({ skill: runtimeId, source: frame.source, status: frame.metadataStatus })));
      const timeline = definition.bodyAction
        ? await exportBodyTimeline(bodyReader, `Character/00002000.img/${definition.bodyAction}`)
        : null;
      const sourceFields = unwrap(rawSkill);
      const directBeginnerLevels = definition.job === 0 ? beginnerLevelRows(sourceFields) : null;
      const source = {
        skillJson: `WZ_JSON_TW/${definition.skillJson}#skill.${sourceId}`,
        stringJson: `WZ_JSON_TW/String/Skill.json#${sourceId}`,
        skillImage: skillSource,
        bodyAction: timeline?.source ?? null,
      };
      if (definition.sourceAction) {
        source.action = definition.sourceAction;
        source.actionSource = `${skillSource}/action/0`;
        source.reuseAvatarAction = definition.avatarAction;
      }
      skillOutputs[runtimeId] = {
        id: runtimeId,
        sourceSkillId: sourceId,
        job: definition.job,
        name: unwrap(rawString.name),
        source,
        rawWz: { skill: rawSkill, string: rawString },
        sourceFields,
        // Beginner rows are concrete source values (including fixdamage and
        // healing x), so they stay under sourceFields.level rather than the
        // four-field mage levelValues projection.
        ...(definition.levelValues ? { levelValues: levelValues(sourceFields.common) } : {}),
        string: unwrap(rawString),
        runtimeUnknowns: [
          {
            field: 'unlockCondition',
            status: 'unverified',
            reason: definition.unlockReason,
          },
          {
            field: 'formulaEvaluation',
            status: definition.job === 0 ? 'source-values' : 'unimplemented',
            reason: definition.job === 0
              ? `Skill/000.img provides ${directBeginnerLevels.length} concrete per-level rows; final runtime execution remains server-owned.`
              : 'Source MP, damage percentage and hit/target counts are evaluated in levelValues; final player-stat damage and runtime execution remain unimplemented.',
          },
          {
            field: 'serverHitTiming',
            status: 'unverified',
            reason: timeline
              ? `${definition.bodyAction} is the source body action timeline; server input, hit and cancel windows are not inferred from animation delay.`
              : definition.sourceAction
                ? `Skill source action ${definition.sourceAction} reuses avatar.actions.${definition.avatarAction}; server input, hit and cancel windows are not inferred from animation delay.`
                : 'This skill has no exported body action timeline; server input, effect and cancel windows remain runtime-owned.',
          },
        ],
        bodyTimeline: timeline,
        assets: assetGroups,
        ...(Object.keys(levelAssetGroups).length ? { levelAssets: levelAssetGroups } : {}),
      };
    }

    const catalogBooks = {};
    const catalogSkills = {};
    const catalogIconGaps = [];
    const catalogDefinitions = [...new Set(
      SKILLS
        .filter(skill => skill.includeInCatalog !== false)
        .map(skill => String(skill.job)),
    )].map(bookId => SKILLS.find(skill => String(skill.job) === bookId && skill.catalogDefinition)
      || SKILLS.find(skill => String(skill.job) === bookId && skill.includeInCatalog !== false));
    for (const definition of catalogDefinitions) {
      const bookId = String(definition.job);
      const sourceBookId = definition.job === 0 ? '000' : bookId;
      const skillRoot = skillJsons.get(definition.skillJson)?.skill;
      assert(skillRoot, `${definition.skillJson} skill root is missing`);
      const bookString = stringJson[sourceBookId];
      assert(bookString && hasField(bookString, 'bookName'), `${sourceBookId} bookName source is missing`);
      const bookName = unwrap(bookString.bookName);
      catalogBooks[bookId] = {
        id: bookId,
        job: definition.job,
        name: bookName,
        bookName,
        source: {
          skillJson: `WZ_JSON_TW/${definition.skillJson}#skill`,
          stringJson: `WZ_JSON_TW/String/Skill.json#${sourceBookId}`,
        },
        sourceId: sourceBookId,
        string: unwrap(bookString),
      };

      const skillIds = definition.catalogSkillIds
        ? [...definition.catalogSkillIds].sort((left, right) => Number(left) - Number(right))
        : definition.job === 0
        ? SKILLS.filter(skill => skill.job === 0).map(skill => sourceSkillId(skill)).sort((left, right) => Number(left) - Number(right))
        : Object.keys(skillRoot)
          .filter(id => /^\d+$/.test(id))
          .sort((left, right) => Number(left) - Number(right));
      // 每本书的图鉴节点数＝该书 `Skill/<book>.json` 里全部数字节点的个数（含 invisible 变体），
      // 与 SKILLS 里登记的施法技能条数无关。**这里是唯一权威**：`tms273_skill_manifest.cjs`
      // 只断言总数，不再按书重复一遍（避免「书范围」出现第四处硬编码）。
      const expectedCatalogCounts = {
        '0': 3, '200': 8, '210': 10, '211': 11, '220': 9, '221': 12, '222': 24, '230': 10, '231': 15,
        '212': 24, '232': 27,
      };
      assert(Object.prototype.hasOwnProperty.call(expectedCatalogCounts, bookId), `skill book ${bookId} has no expected catalog count`);
      assert.equal(skillIds.length, expectedCatalogCounts[bookId], `${bookId} catalog node count changed`);
      for (const sourceId of skillIds) {
        const id = runtimeSkillId(definition, sourceId);
        const rawSkill = skillRoot[sourceId];
        const rawString = stringJson[sourceId];
        assert(rawSkill && rawString, `${sourceId} catalog source JSON is missing`);
        const skillSource = `${definition.image}/skill/${sourceId}`;
        // A catalog entry is valid only when its actual Skill root exists;
        // icon children may be absent and are then reported explicitly.
        const skillNode = await get(reader, skillSource);
        // Keep the complete unwrapped Skill node in the catalog projection.
        // The previous projection retained only common/req/info fields, which
        // silently discarded 221 summon lifecycle and special-variant fields.
        const sourceFields = unwrap(rawSkill);
        const common = sourceFields.common || {};
        const maxLevel = common.maxLevel ?? (sourceFields.level ? String(Object.keys(sourceFields.level).length) : null);
        const req = sourceFields.req ?? null;
        const info = sourceFields.info ?? null;
        const info2 = sourceFields.info2 ?? null;
        catalogSkills[id] = {
          id,
          sourceSkillId: sourceId,
          job: definition.job,
          book: bookId,
          name: fieldValue(rawString, 'name'),
          description: fieldValue(rawString, 'desc'),
          source: {
            skillJson: `WZ_JSON_TW/${definition.skillJson}#skill.${sourceId}`,
            stringJson: `WZ_JSON_TW/String/Skill.json#${sourceId}`,
            skillImage: skillSource,
          },
          rawWz: { skill: rawSkill, string: rawString },
          sourceFields,
          // Keep the source fields addressable without requiring a formula
          // evaluator or a second catalog-specific schema.
          common,
          maxLevel,
          req,
          info,
          info2,
          string: unwrap(rawString),
          displayFlags: catalogDisplayFlags(rawSkill),
          learnability: {
            status: 'unverified',
            reason: 'Skill source has no verified job, unlock or SP learning rule in this catalog; source display markers are not grants.',
          },
          icons: await exportCatalogIcons(reader, skillSource, skillNode, id, catalogIconGaps),
        };
      }
    }

    const sourceArchivePaths = Object.values(extraction.entries).map(entry => path.join(ROOT, entry.archive));
    const sourceFiles = uniqueFiles([
      ...SKILLS.map(skill => sourceJsonPath(skill.skillJson)),
      STRING_JSON,
      path.join(DATA, 'Packs/Skill_00000.ms'),
      path.join(DATA, 'Skill/_Canvas/_Canvas_035.wz'),
      bodyArchive,
      ...canvasArchives,
      ...sourceArchivePaths,
    ]).map(sourceFile);
    const firstExtraction = extraction.entries[SKILL_IMAGE];
    const extractionImages = Object.fromEntries(Object.entries(extraction.entries).map(([image, entry]) => [image, {
      archive: entry.archive,
      entryIndex: entry.entry_index,
      bytes: entry.bytes,
    }]));
    const output = {
      contentVersion: 'tms273-skills',
      sourceVersion: 'TMS273.7',
      source: 'TMS273.7 client WZ',
      status: metadataGaps.some(frame => frame.status === 'incomplete') ? 'incomplete' : 'complete',
      metadataGaps,
      assetGaps,
      sourceFiles,
      extraction: {
        image: SKILL_IMAGE,
        archive: firstExtraction.archive,
        entryIndex: firstExtraction.entry_index,
        bytes: firstExtraction.bytes,
        canvasArchive: relative(path.join(DATA, SKILLS[0].canvasArchive)),
        images: extractionImages,
        canvasArchives: Object.fromEntries(canvasArchives.map(file => [path.relative(DATA, file).split(path.sep).join('/'), relative(file)])),
      },
      formulaSemantics: {
        classification: 'R',
        source: 'https://github.com/Kagamia/WzComparerR2/blob/4b691cf55695fd13effdd0ba8f3826a8b6b81552/WzComparerR2.Common/Calculator.cs#L341-L355',
        levelBinding: 'https://github.com/Kagamia/WzComparerR2/blob/4b691cf55695fd13effdd0ba8f3826a8b6b81552/WzComparerR2.Common/CharaSim/SummaryParser.cs#L63',
        x: 'skill level', d: 'floor', u: 'ceil',
        scope: 'Source expressions only; not official server damage or hit timing.',
      },
      catalog: {
        books: catalogBooks,
        skills: catalogSkills,
        iconGaps: catalogIconGaps,
      },
      skills: skillOutputs,
    };
    const outputPath = path.join(OUTPUT, 'skills.json');
    fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      output: outputPath,
      skill: SKILL_ID,
      status: output.status,
      groups: Object.fromEntries(Object.entries(skillOutputs).map(([id, skill]) => [id, Object.fromEntries(Object.entries(skill.assets).map(([key, frames]) => [key, frames.length]))])),
      catalogBooks: Object.keys(catalogBooks).length,
      catalogSkills: Object.keys(catalogSkills).length,
      catalogIconGaps: catalogIconGaps.length,
      metadataGaps: output.metadataGaps.length,
      sourceFiles: sourceFiles.length,
    }, null, 2));
  } finally {
    reader?.close();
    bodyReader?.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });

module.exports = { main, SKILL_ID, SKILL_SOURCE };
