#!/usr/bin/env node

// Export source-backed mage effect sequences for all local mage skill books.
// Damage, hit timing, summon lifecycle, and skill execution remain outside
// this asset export; named summon action arrays are visual source groups only.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const OUTPUT = path.join(ROOT, 'resources/tms273-export/mage-effects.json');
const ASSETS = path.join(ROOT, 'resources/tms273-export/assets/tms273/mage-effects');
const UNPACKER = path.join(ROOT, 'scripts/unpack_tms273_ms/target/debug/unpack_tms273_ms');
const SKILL_EXPORT = path.join(ROOT, 'resources/tms273-export/skills.json');

// 2001012 stores the visible sequence under `special`; it is the only
// effect-class sequence for that skill, so it is normalized to output `effect`.
const SOURCES = {
  '2001002': 'Skill/200.img/skill/2001002/effect',
  '2001009': 'Skill/200.img/skill/2001009/effect',
  '2001011': 'Skill/200.img/skill/2001011/effect',
  '2001012': 'Skill/200.img/skill/2001012/special',
};
const EXTRA_SOURCES = {
  '2201001': {
    effect: 'Skill/220.img/skill/2201001/effect',
  },
  '2201009': {
    tile: 'Skill/220.img/skill/2201009/tile',
    hit: 'Skill/220.img/skill/2201009/hit',
  },
  '2200011': {
    mob: 'Skill/220.img/skill/2200011/mob',
  },
};
// These groups are kept separate because the client renders the summon
// lifecycle from snapshots.  `summoned` is a cast/spawn aura and is retained
// only as source metadata below; it must not be used as the ball itself.
const THIRD_JOB_SOURCES = {
  '2210000': {
    effect: 'Skill/221.img/skill/2210000/special',
  },
  '2211002': {
    effect: 'Skill/221.img/skill/2211002/effect',
    effect0: 'Skill/221.img/skill/2211002/effect0',
    hit: 'Skill/221.img/skill/2211002/hit',
  },
  '2211007': {
    effect: 'Skill/221.img/skill/2211007/effect',
    effect0: 'Skill/221.img/skill/2211007/effect0',
    hit: 'Skill/221.img/skill/2211007/hit',
    mob: 'Skill/221.img/skill/2211007/mob',
  },
  '2211011': {
    effect: 'Skill/221.img/skill/2211011/effect',
    effect0: 'Skill/221.img/skill/2211011/effect0',
    hit: 'Skill/221.img/skill/2211011/hit',
    ball: 'Skill/221.img/skill/2211011/ball',
    summonStand: 'Skill/221.img/skill/2211011/summon/stand',
    summonMove: 'Skill/221.img/skill/2211011/summon/move',
    summonAttack: 'Skill/221.img/skill/2211011/summon/attack1',
  },
  '2211012': {
    effect: 'Skill/221.img/skill/2211012/effect',
    effect0: 'Skill/221.img/skill/2211012/effect0',
    special: 'Skill/221.img/skill/2211012/special',
    special0: 'Skill/221.img/skill/2211012/special0',
    number: 'Skill/221.img/skill/2211012/number',
  },
  '2211014': {
    effect: 'Skill/221.img/skill/2211014/effect',
    effect0: 'Skill/221.img/skill/2211014/effect0',
    hit: 'Skill/221.img/skill/2211014/hit',
    special: 'Skill/221.img/skill/2211014/special',
    special0: 'Skill/221.img/skill/2211014/special0',
  },
  '2211015': {
    hit: 'Skill/221.img/skill/2211015/hit',
    summonStand: 'Skill/221.img/skill/2211015/summon/stand',
    summonMove: 'Skill/221.img/skill/2211015/summon/move',
    summonAttack: 'Skill/221.img/skill/2211015/summon/attack1',
  },
  '2211017': {
    effect: 'Skill/221.img/skill/2211017/effect',
  },
};
const THIRD_JOB_SUMMON_SOURCES = {
  '2211011': 'Skill/221.img/skill/2211011/summon/summoned',
  '2211015': 'Skill/221.img/skill/2211015/summon/summoned',
};
// Fourth-job source groups are kept one-to-one with the WZ names.  In
// particular, Blizzard's hidden 2220014 final-attack variant is exported as
// a triggered hit source but is deliberately absent from the learnable book.
const FOURTH_JOB_SOURCES = {
  '2220014': {
    hit: 'Skill/222.img/skill/2220014/hit',
  },
  '2221000': {
    effect: 'Skill/222.img/skill/2221000/effect',
    effect0: 'Skill/222.img/skill/2221000/effect0',
  },
  '2221004': {
    effect: 'Skill/222.img/skill/2221004/effect',
    effect0: 'Skill/222.img/skill/2221004/effect0',
    special: 'Skill/222.img/skill/2221004/special',
    special0: 'Skill/222.img/skill/2221004/special0',
    specialAffected: 'Skill/222.img/skill/2221004/specialAffected',
    specialAffected0: 'Skill/222.img/skill/2221004/specialAffected0',
  },
  '2221005': {
    effect: 'Skill/222.img/skill/2221005/effect',
    hit: 'Skill/222.img/skill/2221005/hit',
    summonStand: 'Skill/222.img/skill/2221005/summon/stand',
    summonMove: 'Skill/222.img/skill/2221005/summon/move',
    summonAttack: 'Skill/222.img/skill/2221005/summon/attack1',
  },
  '2221006': {
    effect: 'Skill/222.img/skill/2221006/effect',
    ball: 'Skill/222.img/skill/2221006/ball',
    hit: 'Skill/222.img/skill/2221006/hit',
    mob: 'Skill/222.img/skill/2221006/mob',
  },
  '2221007': {
    effect: 'Skill/222.img/skill/2221007/effect',
    effect0: 'Skill/222.img/skill/2221007/effect0',
    hit: 'Skill/222.img/skill/2221007/hit',
    tile: 'Skill/222.img/skill/2221007/tile',
  },
  '2221008': {
    effect: 'Skill/222.img/skill/2221008/effect',
    effect0: 'Skill/222.img/skill/2221008/effect0',
  },
  '2221011': {
    mob: 'Skill/222.img/skill/2221011/mob',
    special: 'Skill/222.img/skill/2221011/special',
    specialAffected: 'Skill/222.img/skill/2221011/specialAffected',
    prepare: 'Skill/222.img/skill/2221011/prepare',
    keydown: 'Skill/222.img/skill/2221011/keydown',
    keydown0: 'Skill/222.img/skill/2221011/keydown0',
    keydownend: 'Skill/222.img/skill/2221011/keydownend',
  },
  '2221012': {
    effect: 'Skill/222.img/skill/2221012/effect',
    hit: 'Skill/222.img/skill/2221012/hit',
    ball: 'Skill/222.img/skill/2221012/ball',
  },
  // Hyper nodes are kept one-to-one with the source tree.  These are visual
  // groups only; execution, keydown cadence, and cooldown remain runtime
  // concerns.  Do not merge the stages into one animation array.
  '2221052': {
    prepare: 'Skill/222.img/skill/2221052/prepare',
    keydown: 'Skill/222.img/skill/2221052/keydown',
    keydownend: 'Skill/222.img/skill/2221052/keydownend',
    hit: 'Skill/222.img/skill/2221052/hit',
    special: 'Skill/222.img/skill/2221052/special',
  },
  '2221053': {
    effect: 'Skill/222.img/skill/2221053/effect',
    effect0: 'Skill/222.img/skill/2221053/effect0',
    affected: 'Skill/222.img/skill/2221053/affected',
  },
  '2221054': {
    effect: 'Skill/222.img/skill/2221054/effect',
    start: 'Skill/222.img/skill/2221054/start',
    repeat: 'Skill/222.img/skill/2221054/repeat',
    end: 'Skill/222.img/skill/2221054/end',
  },
  '2221055': {
    effect: 'Skill/222.img/skill/2221055/effect',
    tile: 'Skill/222.img/skill/2221055/tile',
    tile0: 'Skill/222.img/skill/2221055/tile0',
  },
  // ── 火毒（212）与主教（232）四转的「同一格副本」（2026-09-23） ──────────────
  // 与服务端 `world.rs::{INFINITY_SKILLS, MAPLE_CURE_SKILLS, DEMON_SUMMON_SKILLS}`
  // 逐条对应：只有**接了执行链**的那几条才登记，否则界面上会多出「能放但看不见」的按钮。
  // 源组名与冰雷那本逐组同形（`effect`/`effect0`、無限的 `special*`、召唤的
  // `summon/{stand,move,attack1}`），所以这里是同一套导出规则换个书号。
  '2121000': {
    effect: 'Skill/212.img/skill/2121000/effect',
    effect0: 'Skill/212.img/skill/2121000/effect0',
  },
  '2121004': {
    effect: 'Skill/212.img/skill/2121004/effect',
    effect0: 'Skill/212.img/skill/2121004/effect0',
    special: 'Skill/212.img/skill/2121004/special',
    special0: 'Skill/212.img/skill/2121004/special0',
    specialAffected: 'Skill/212.img/skill/2121004/specialAffected',
    specialAffected0: 'Skill/212.img/skill/2121004/specialAffected0',
  },
  '2121005': {
    effect: 'Skill/212.img/skill/2121005/effect',
    hit: 'Skill/212.img/skill/2121005/hit',
    summonStand: 'Skill/212.img/skill/2121005/summon/stand',
    summonMove: 'Skill/212.img/skill/2121005/summon/move',
    summonAttack: 'Skill/212.img/skill/2121005/summon/attack1',
  },
  '2121008': {
    effect: 'Skill/212.img/skill/2121008/effect',
    effect0: 'Skill/212.img/skill/2121008/effect0',
  },
  '2321000': {
    effect: 'Skill/232.img/skill/2321000/effect',
    effect0: 'Skill/232.img/skill/2321000/effect0',
  },
  '2321004': {
    effect: 'Skill/232.img/skill/2321004/effect',
    effect0: 'Skill/232.img/skill/2321004/effect0',
    special: 'Skill/232.img/skill/2321004/special',
    special0: 'Skill/232.img/skill/2321004/special0',
    specialAffected: 'Skill/232.img/skill/2321004/specialAffected',
    specialAffected0: 'Skill/232.img/skill/2321004/specialAffected0',
  },
  '2321009': {
    effect: 'Skill/232.img/skill/2321009/effect',
    effect0: 'Skill/232.img/skill/2321009/effect0',
  },
  // 傳說冒險：Hyper 主动的窗口增益，三本（2221053 / 2121053 / 2321053）源组名逐组同形
  // （`effect` / `effect0` / `affected`），实测帧数也逐组相同（17 / 22 / 11）。
  '2121053': {
    effect: 'Skill/212.img/skill/2121053/effect',
    effect0: 'Skill/212.img/skill/2121053/effect0',
    affected: 'Skill/212.img/skill/2121053/affected',
  },
  '2321053': {
    effect: 'Skill/232.img/skill/2321053/effect',
    effect0: 'Skill/232.img/skill/2321053/effect0',
    affected: 'Skill/232.img/skill/2321053/affected',
  },
  // 召喚聖龍（主教四转召唤，2026-09-23 接入 S5 通用召唤队列）：`summon` 节点的
  // 子节点顺序与冰魔／火魔**逐位相同**（`summoned / <位移> / stand / attack1 / die`），
  // 差别只在位移组叫 `fly` 而不叫 `move`——所以这里把它映射到运行期同一个
  // `summonMove` 键，客户端一行不用改（`combat/view.ts` 只认 stand/move/attack 三键）。
  // 帧数实测自 `Skill/232.img`（不是 JSON dump，`.img` 才是美术权威）：
  // effect 17 / hit 7 / summoned 10 / fly 12 / stand 12 / attack1 20 / die 11。
  '2321003': {
    effect: 'Skill/232.img/skill/2321003/effect',
    hit: 'Skill/232.img/skill/2321003/hit',
    summonStand: 'Skill/232.img/skill/2321003/summon/stand',
    summonMove: 'Skill/232.img/skill/2321003/summon/fly',
    summonAttack: 'Skill/232.img/skill/2321003/summon/attack1',
  },
};
const FOURTH_JOB_SUMMON_SOURCES = {
  '2221005': {
    summonSpawn: 'Skill/222.img/skill/2221005/summon/summoned',
    summonDie: 'Skill/222.img/skill/2221005/summon/die',
  },
  // 召喚火魔：与冰魔同格，召唤物的生命周期组逐组同形（`summoned` 是施放光环，
  // 只留作源证据；`die` 是到期收尾）。它们的帧不进 `summonStand`，因为客户端
  // 是从快照渲染持续召唤物的。
  '2121005': {
    summonSpawn: 'Skill/212.img/skill/2121005/summon/summoned',
    summonDie: 'Skill/212.img/skill/2121005/summon/die',
  },
  // 召喚聖龍：与冰魔／火魔同一条「施放光环只留源证据、`die` 是到期收尾」的口径。
  '2321003': {
    summonSpawn: 'Skill/232.img/skill/2321003/summon/summoned',
    summonDie: 'Skill/232.img/skill/2321003/summon/die',
  },
};
// Beginner projectile frames are authored separately for each level.  Keep
// the padded source ids in these paths while exposing normalized runtime keys.
const BEGINNER_SOURCES = {
  '1000': {
    levels: {
      '1': {
        ball: 'Skill/000.img/skill/0001000/level/1/ball',
        hit: 'Skill/000.img/skill/0001000/level/1/hit/0',
      },
      '2': {
        ball: 'Skill/000.img/skill/0001000/level/2/ball',
        hit: 'Skill/000.img/skill/0001000/level/2/hit/0',
      },
      '3': {
        ball: 'Skill/000.img/skill/0001000/level/3/ball',
        hit: 'Skill/000.img/skill/0001000/level/3/hit/0',
      },
    },
  },
  '1001': {
    effect: 'Skill/000.img/skill/0001001/effect',
  },
  '1002': {
    effect: 'Skill/000.img/skill/0001002/effect',
  },
};
const PROJECTED_SKILLS = ['2001008', '2201008', '2201005'];
const PROJECTED_SKILL = PROJECTED_SKILLS[0];
// 两份 `WZ_JSON_TW` 不是等价备份：权威树（少爷一键端）缺 `Skill/220.json`，也缺
// `String/Skill.json`，这两个都只在「手工服务端」那份里。`repair_tms273_export_gaps.cjs`
// 的注释早已标注这个前置条件。所以这里按「权威优先、手工兜底」查找，并额外断言两份都有的
// 文件必须逐字节一致——参考数据分叉属于必须当场暴露的问题，不能靠「先命中哪个算哪个」蒙过去。
const WZ_JSON_ROOTS = [
  path.join(ROOT, '参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW'),
  path.join(ROOT, '参考/273/TMS273少爷一键端/手工服务端/tms273/WZ_JSON_TW'),
];

function wzJson(relativePath) {
  const candidates = WZ_JSON_ROOTS.map((root) => path.join(root, relativePath)).filter((candidate) =>
    fs.existsSync(candidate),
  );
  assert(candidates.length > 0, `missing source file: WZ_JSON_TW/${relativePath}（两份 WZ_JSON_TW 都没有）`);
  if (candidates.length > 1) {
    const [authoritative, manual] = candidates;
    assert(
      sha256(authoritative) === sha256(manual),
      `WZ_JSON_TW/${relativePath} 在两份树里内容不一致：${relative(authoritative)} vs ${relative(manual)}`,
    );
  }
  return candidates[0];
}

const SKILL_SOURCE_JSON = wzJson('Skill/200.json');
const SKILL_220_SOURCE_JSON = wzJson('Skill/220.json');
const SKILL_221_SOURCE_JSON = wzJson('Skill/221.json');
const SKILL_222_SOURCE_JSON = wzJson('Skill/222.json');
const SKILL_212_SOURCE_JSON = wzJson('Skill/212.json');
const SKILL_232_SOURCE_JSON = wzJson('Skill/232.json');
const STRING_SOURCE_JSON = wzJson('String/Skill.json');
const PACK_SOURCE = path.join(DATA, 'Packs/Skill_00000.ms');
const PACK_220_SOURCE = path.join(DATA, 'Packs/Skill_00001.ms');
const PACK_222_SOURCE = path.join(DATA, 'Packs/Skill_00002.ms');
const CANVAS_SOURCE = path.join(DATA, 'Skill/_Canvas/_Canvas_035.wz');
const CANVAS_220_SOURCE = path.join(DATA, 'Skill/_Canvas/_Canvas_040.wz');
const CANVAS_COMMON_SOURCE = path.join(DATA, 'Skill/_Canvas/_Canvas_000.wz');
const CANVAS_112_SOURCE = path.join(DATA, 'Skill/_Canvas/_Canvas_003.wz');
// 212.img 与 232.img 的 Canvas 分卷（`_probe_canvas_volumes.json` 的实测结论：
// 038 装 212.img、045 装 232.img）。缺一卷就会在导出时报 outlink 解析失败。
const CANVAS_212_SOURCE = path.join(DATA, 'Skill/_Canvas/_Canvas_038.wz');
const CANVAS_232_SOURCE = path.join(DATA, 'Skill/_Canvas/_Canvas_045.wz');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function relative(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function sourceFile(file) {
  assert(fs.existsSync(file), `missing source file: ${file}`);
  const stat = fs.statSync(file);
  return { path: relative(file), bytes: stat.size, sha256: sha256(file) };
}

function children(node) {
  return [...(node?.wzProperties || [])];
}

function numericChildren(node) {
  return children(node)
    .filter(child => /^\d+$/.test(child.name))
    .sort((left, right) => Number(left.name) - Number(right.name));
}

function primitive(node, name) {
  const value = node?.at?.(name)?.wzValue;
  return ['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'bigint'
    ? value
    : null;
}

function point(node, name) {
  const value = node?.at?.(name)?.wzValue;
  return value && Number.isFinite(Number(value.x)) && Number.isFinite(Number(value.y))
    ? { x: Number(value.x), y: Number(value.y) }
    : null;
}

function displayDelay(rawDelay) {
  if (rawDelay === null || rawDelay === undefined || rawDelay === '') return 0;
  const value = Number(rawDelay);
  return Number.isFinite(value) ? Math.abs(value) : 0;
}

const SOURCE_METADATA_NAMES = new Set([
  'origin', 'z', 'delay', '_outlink', '_inlink', 'fix', 'info', 'pos', 'repeat',
]);

function isCanvasNode(node) {
  return node?.constructor?.name === 'WzCanvasProperty' || Boolean(node?.pngProperty);
}

function linkCanvasArchives(tempRoot) {
  const targetDir = path.join(tempRoot, 'Skill/_Canvas');
  fs.mkdirSync(targetDir, { recursive: true });
  for (const source of [
    CANVAS_SOURCE,
    CANVAS_220_SOURCE,
    CANVAS_COMMON_SOURCE,
    CANVAS_112_SOURCE,
    CANVAS_212_SOURCE,
    CANVAS_232_SOURCE,
  ]) {
    assert(fs.existsSync(source), `missing Canvas source: ${source}`);
    fs.symlinkSync(source, path.join(targetDir, path.basename(source)));
  }
}

function unpackSkillImages(tempRoot) {
  assert(fs.existsSync(UNPACKER), `missing Rust MS unpacker: ${UNPACKER}`);
  const images = ['Skill/000.img', 'Skill/200.img', 'Skill/212.img', 'Skill/220.img', 'Skill/221.img', 'Skill/222.img', 'Skill/232.img'];
  const result = spawnSync(UNPACKER, [
    '--packs', path.join(DATA, 'Packs'),
    '--out', tempRoot,
    ...images.flatMap(image => ['--image', image]),
  ], { encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Skill image unpack failed:\n${result.stdout}\n${result.stderr}`);
  const reportPath = path.join(tempRoot, 'manifest.json');
  assert(fs.existsSync(reportPath), `missing unpack manifest: ${reportPath}`);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const entries = Object.fromEntries(images.map(image => {
    const entry = report.entries?.find(item => item.image === image && item.status === 'ok');
    assert(entry && fs.existsSync(path.join(tempRoot, image)), `${image} was not unpacked`);
    return [image, entry];
  }));
  return entries;
}

async function collectFrameSources(reader, source, node = null) {
  const current = node || await reader.get(source);
  if (isCanvasNode(current)) return [source];
  const nested = numericChildren(current);
  // Most effect groups use numeric children, while number/icon groups use
  // named Canvas children.  Walk both forms but never descend into WZ
  // metadata such as summon attack ranges or fixed z markers.
  const candidates = children(current)
    .filter(child => !SOURCE_METADATA_NAMES.has(child.name))
    .filter(child => isCanvasNode(child)
      || ['WzSubProperty', 'WzUOLProperty'].includes(child?.constructor?.name)
      || children(child).length > 0)
    .sort((left, right) => {
      const leftNumeric = /^\d+$/.test(left.name);
      const rightNumeric = /^\d+$/.test(right.name);
      if (leftNumeric && rightNumeric) return Number(left.name) - Number(right.name);
      if (leftNumeric) return -1;
      if (rightNumeric) return 1;
      return left.name.localeCompare(right.name);
    });
  if (candidates.length === 0) return [source];
  const result = [];
  for (const child of candidates) {
    result.push(...await collectFrameSources(reader, `${source}/${child.name}`, child));
  }
  return result;
}

async function exportFrame(reader, source) {
  const raw = await reader.get(source);
  const frame = await reader.frame(raw, ASSETS);
  assert(frame.url, `missing PNG for ${source}`);
  const file = path.join(ASSETS, frame.url);
  assert(fs.existsSync(file), `PNG was not written: ${source}`);

  const origin = point(raw, 'origin') || frame.origin || null;
  const x = origin ? -origin.x : 0;
  const y = origin ? -origin.y : 0;
  const rawDelay = primitive(raw, 'delay');
  const outlink = primitive(raw, '_outlink');
  return {
    url: `/assets/tms273/mage-effects/${frame.url}`,
    x,
    y,
    width: frame.width,
    height: frame.height,
    delay: displayDelay(rawDelay),
    rawDelay,
    origin,
    source,
    outlink,
    resolvedSource: frame.resolvedSource,
    sha256: sha256(file),
  };
}

async function exportSourceGroups(reader, skillId, groups) {
  const output = { source: {} };
  for (const [kind, source] of Object.entries(groups)) {
    const sourceNode = await reader.get(source);
    const frameSources = await collectFrameSources(reader, source, sourceNode);
    assert(frameSources.length > 0, `${source} has no numeric animation frames`);
    output[kind] = [];
    output.source[kind] = source;
    for (const frameSource of frameSources) output[kind].push(await exportFrame(reader, frameSource));
  }
  assert(Object.keys(output).length > 1, `${skillId} has no exported groups`);
  return output;
}

async function sourceOnlyGroup(reader, source) {
  const sourceNode = await reader.get(source);
  const frames = await collectFrameSources(reader, source, sourceNode);
  return { source, frameCount: frames.length, role: 'cast-aura-only' };
}

function projectExistingFrame(frame) {
  const origin = frame.origin || null;
  const x = origin ? -Number(origin.x) : 0;
  const y = origin ? -Number(origin.y) : 0;
  const rawDelay = frame.rawDelay ?? frame.delay ?? null;
  return {
    url: frame.url,
    x,
    y,
    width: frame.width,
    height: frame.height,
    delay: displayDelay(rawDelay),
    rawDelay,
    origin,
    source: frame.source,
    outlink: frame.outlink ?? null,
    resolvedSource: frame.resolvedSource ?? null,
    sha256: frame.sha256,
  };
}

async function main() {
  fs.mkdirSync(ASSETS, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tms273-mage-effects-'));
  let reader;
  try {
    const extraction = unpackSkillImages(tempRoot);
    linkCanvasArchives(tempRoot);
    reader = createReader(tempRoot, tempRoot);

    const skillEffects = {};
    for (const [skillId, source] of Object.entries(SOURCES)) {
      const sourceNode = await reader.get(source);
      const frameSources = await collectFrameSources(reader, source, sourceNode);
      assert(frameSources.length > 0, `${source} has no numeric animation frames`);
      skillEffects[skillId] = {
        effect: [],
        source: { effect: source },
      };
      for (const frameSource of frameSources) {
        skillEffects[skillId].effect.push(await exportFrame(reader, frameSource));
      }
    }

    for (const [skillId, groups] of Object.entries(EXTRA_SOURCES)) {
      skillEffects[skillId] = await exportSourceGroups(reader, skillId, groups);
    }

    for (const [skillId, groups] of Object.entries(THIRD_JOB_SOURCES)) {
      skillEffects[skillId] = await exportSourceGroups(reader, skillId, groups);
      const summonSpawn = THIRD_JOB_SUMMON_SOURCES[skillId];
      if (summonSpawn) {
        // Keep the authored cast aura addressable for review, but do not put
        // its frames in effect/ball/summonStand: CombatView must render the
        // persistent summon from stand/move/attack snapshots instead.
        skillEffects[skillId].source.summonSpawn = await sourceOnlyGroup(reader, summonSpawn);
      }
    }

    for (const [skillId, groups] of Object.entries(FOURTH_JOB_SOURCES)) {
      skillEffects[skillId] = await exportSourceGroups(reader, skillId, groups);
      if (skillId === '2220014') {
        // 2220014 is a hidden Blizzard final-attack variant.  It has a real
        // hit tree but no separate effect tree in this client; preserve that
        // boundary explicitly instead of fabricating a duplicate effect.
        skillEffects[skillId].hidden = true;
        skillEffects[skillId].catalog = false;
        skillEffects[skillId].trigger = '2221007.finalAttack';
        skillEffects[skillId].source.missingEffect = {
          status: 'source-missing',
          reason: 'Skill/222.img/skill/2220014 has no effect/effect0 Canvas group in TMS273.7; hit is the source-backed additional attack tree.',
        };
      }
      if (skillId === '2221055') {
        // 2221055 is the authored hidden vortex variant paired with Hyper
        // 2221054.  Keep its source-backed effects addressable for a triggered
        // visual, while preventing it from becoming a learnable book entry.
        skillEffects[skillId].hidden = true;
        skillEffects[skillId].catalog = false;
        skillEffects[skillId].trigger = '2221054.hiddenVariant';
        skillEffects[skillId].source.relation = '2221054';
      }
      for (const [name, summonSource] of Object.entries(FOURTH_JOB_SUMMON_SOURCES[skillId] || {})) {
        skillEffects[skillId].source[name] = await sourceOnlyGroup(reader, summonSource);
      }
    }

    for (const [skillId, definition] of Object.entries(BEGINNER_SOURCES)) {
      if (!definition.levels) {
        // Heal and Nimble Feet keep the source's single root effect sequence;
        // there is no per-level Canvas branch for either skill.
        skillEffects[skillId] = await exportSourceGroups(reader, skillId, definition);
        continue;
      }
      const output = { levels: {}, source: { levels: {} } };
      for (const [level, groups] of Object.entries(definition.levels)) {
        const exported = await exportSourceGroups(reader, `${skillId}/level/${level}`, groups);
        const { source, ...frames } = exported;
        output.levels[level] = frames;
        output.source.levels[level] = source;
      }
      skillEffects[skillId] = output;
    }

    const existing = JSON.parse(fs.readFileSync(SKILL_EXPORT, 'utf8'));
    for (const skillId of PROJECTED_SKILLS) {
      const projected = existing.skills?.[skillId];
      assert(projected, `${SKILL_EXPORT} has no ${skillId} skill output`);
      skillEffects[skillId] = {
        effect: (projected.assets?.effect || []).map(projectExistingFrame),
        hit: (projected.assets?.hit || []).map(projectExistingFrame),
        ball: (projected.assets?.ball || []).map(projectExistingFrame),
        source: { projection: relative(SKILL_EXPORT) },
      };
      assert(skillEffects[skillId].effect.length > 0, `projected ${skillId} effect is empty`);
    }

    const output = {
      contentVersion: 'tms273-mage-effects',
      sourceVersion: 'TMS273.7',
      sourceFiles: [
        sourceFile(wzJson('Skill/000.json')),
        sourceFile(SKILL_SOURCE_JSON),
        sourceFile(SKILL_220_SOURCE_JSON),
        sourceFile(SKILL_221_SOURCE_JSON),
        sourceFile(SKILL_222_SOURCE_JSON),
        sourceFile(SKILL_212_SOURCE_JSON),
        sourceFile(SKILL_232_SOURCE_JSON),
        sourceFile(STRING_SOURCE_JSON),
        sourceFile(PACK_SOURCE),
        sourceFile(PACK_220_SOURCE),
        sourceFile(PACK_222_SOURCE),
        sourceFile(CANVAS_SOURCE),
        sourceFile(CANVAS_220_SOURCE),
        sourceFile(CANVAS_COMMON_SOURCE),
        sourceFile(CANVAS_112_SOURCE),
        sourceFile(CANVAS_212_SOURCE),
        sourceFile(CANVAS_232_SOURCE),
        sourceFile(SKILL_EXPORT),
      ],
      extraction: {
        image: 'Skill/200.img',
        archive: extraction['Skill/200.img'].archive,
        entryIndex: extraction['Skill/200.img'].entry_index,
        bytes: extraction['Skill/200.img'].bytes,
        canvasArchive: relative(CANVAS_SOURCE),
        images: Object.fromEntries(Object.entries(extraction).map(([image, entry]) => [image, {
          archive: entry.archive,
          entryIndex: entry.entry_index,
          bytes: entry.bytes,
        }])),
        canvasArchives: {
          [relative(CANVAS_COMMON_SOURCE)]: relative(CANVAS_COMMON_SOURCE),
          [relative(CANVAS_SOURCE)]: relative(CANVAS_SOURCE),
          [relative(CANVAS_220_SOURCE)]: relative(CANVAS_220_SOURCE),
          [relative(CANVAS_112_SOURCE)]: relative(CANVAS_112_SOURCE),
          [relative(CANVAS_212_SOURCE)]: relative(CANVAS_212_SOURCE),
          [relative(CANVAS_232_SOURCE)]: relative(CANVAS_232_SOURCE),
        },
      },
      skillEffects,
    };
    fs.writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      output: relative(OUTPUT),
      sourceVersion: output.sourceVersion,
      skills: Object.fromEntries(Object.entries(skillEffects).map(([id, value]) => [id, {
        effect: value.effect?.length || 0,
        effect0: value.effect0?.length || 0,
        hit: value.hit?.length || 0,
        ball: value.ball?.length || 0,
        tile: value.tile?.length || 0,
        mob: value.mob?.length || 0,
        summonStand: value.summonStand?.length || 0,
        summonMove: value.summonMove?.length || 0,
        summonAttack: value.summonAttack?.length || 0,
      }])),
      pngs: Object.values(skillEffects).flatMap(value => Object.values(value)
        .filter(frames => Array.isArray(frames))
        .flat()).filter(frame => frame.url.includes('/mage-effects/')).length,
    }, null, 2));
  } finally {
    reader?.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

module.exports = { main, SOURCES, BEGINNER_SOURCES, PROJECTED_SKILL };
