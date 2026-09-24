#!/usr/bin/env node

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'resources/tms273-export/mage-effects.json');
// 全量登记：这个脚本校验的是**导出器产出的整张表**，所以名单必须跟着
// `export_tms273_mage_effects.cjs` 的源表一起长。2026-09-08 时这里是 10 条，
// 之后导出器陆续加了 221/222 四转，名单没跟，门禁就一直红着；2026-09-23
// 补进 212/232 七条时一并把名单补全。
const EXPECTED = [
  '1000', '1001', '1002',
  '2001002', '2001008', '2001009', '2001011', '2001012',
  '2121000', '2121004', '2121005', '2121008', '2121053', '2121054',
  '2200011', '2201001', '2201005', '2201008', '2201009',
  '2210000', '2211002', '2211007', '2211011', '2211012', '2211014', '2211015', '2211017',
  '2220014', '2221000', '2221004', '2221005', '2221006', '2221007', '2221008',
  '2221011', '2221012', '2221052', '2221053', '2221054', '2221055',
  '2321000', '2321003', '2321004', '2321005', '2321009', '2321053',
];
const DIRECT_EFFECTS = [
  '2001002', '2001009', '2001011', '2001012', '2201001',
  // 火毒／主教四转的「同一格副本」（2026-09-23）：它们的效果帧来自 `212.img`／`232.img`，
  // 不能沿用原来写死的 `Skill/220.img` 前缀，所以走下面的 `SOURCE_IMAGE` 表。
  '2121000', '2121004', '2121005', '2121008', '2121053',
  '2321000', '2321004', '2321009', '2321053',
  // 進階祝福（2026-09-23 接增益窗与属性层）：效果帧同样来自 `232.img`。
  '2321005',
  // 召喚聖龍（主教四转召唤，2026-09-23）：效果帧同样来自 `232.img`。
  '2321003',
];
const PROJECTED = ['2001008', '2201005', '2201008'];
// 每个技能的特效帧来自哪本 `Skill/<n>.img`。缺省仍是 220.img（一转与冰雷线）。
const SOURCE_IMAGE = {
  '2121000': '212.img',
  '2121004': '212.img',
  '2121005': '212.img',
  '2121008': '212.img',
  '2121053': '212.img',
  '2121054': '212.img',
  '2321000': '232.img',
  '2321003': '232.img',
  '2321004': '232.img',
  '2321005': '232.img',
  '2321009': '232.img',
  '2321053': '232.img',
};
// 少数组的运行期键名与源节点名不同形（召唤帧的源路径是 `summon/stand` 这类）。
const GROUP_SOURCE = {
  summonStand: 'summon/stand',
  summonMove: 'summon/move',
  summonAttack: 'summon/attack1',
};
// **逐技能**的源节点名覆盖：只有「同一个运行期键在源里换了节点名」时才登记。
// 召喚聖龍 `2321003` 的位移组在源里叫 `summon/fly`（冰魔／火魔叫 `summon/move`）——
// 它在 `summon` 下的子节点顺序与那两本**逐位相同**
// （`summoned / <位移> / stand / attack1 / die`），所以运行期仍走同一个 `summonMove` 键，
// 客户端一行不用改。下面 `main()` 里有一条断言保证这张表不会变成「登记了却没人用」。
const GROUP_SOURCE_BY_SKILL = {
  '2321003': { summonMove: 'summon/fly' },
};
const EXTRA_GROUPS = {
  '2201001': { effect: 19 },
  '2201009': { tile: 24, hit: 11 },
  '2200011': { mob: 30 },
  // 下面七条把 2026-09-23 新增副本的帧数钉死：数字变了说明源素材或导出规则被改动。
  '2121000': { effect: 13, effect0: 29 },
  '2121004': { effect: 25, effect0: 25, special: 16, special0: 16, specialAffected: 16, specialAffected0: 16 },
  '2121005': { effect: 10, hit: 9, summonStand: 12, summonMove: 12, summonAttack: 18 },
  '2121008': { effect: 17, effect0: 12 },
  '2321000': { effect: 13, effect0: 29 },
  '2321004': { effect: 25, effect0: 25, special: 16, special0: 16, specialAffected: 16, specialAffected0: 16 },
  '2321009': { effect: 17, effect0: 12 },
  // 傳說冒險：三本（2221053 / 2121053 / 2321053）源组名与帧数逐组相同，
  // 所以下面 `SIBLING_ART_PARITY` 也把它俩钉在冰雷那本上。
  '2121053': { effect: 17, effect0: 22, affected: 11 },
  '2321053': { effect: 17, effect0: 22, affected: 11 },
  // 火靈結界（火毒四转開關技能，2026-09-24 接执行链）：它是**同一格机制、不同形态**，
  // 所以既不进 `SIBLING_ART_PARITY`（那张表钉的是「同一格副本」的美术逐组同形），
  // 也不进 `DIRECT_EFFECTS`（那一条要求有 `effect` 组）。源 `Skill/212.img/skill/2121054`
  // 的子节点是 `icon / start / start0 / repeat / repeat0 / end / end0 / special / special0 / hit`
  // ——**没有 `effect`**：冰雷那本的可见主体是围绕队员飞的光团（`effect` 组 15 帧），
  // 火灵结界是脚下的地面结界（`repeat` 16 帧，实测每帧 340×72 的横向带）。
  // 只导运行期真正消费的三组，帧数实测自 `.img`（不是 JSON dump）。
  '2121054': { start: 6, repeat: 16, end: 8 },
  // 召喚聖龍（2026-09-23）：帧数实测自 `Skill/232.img`。它**不**与冰魔／火魔同格
  // （位移组是 `fly` 12 帧、攻击组 20 帧，那两本是 `move` 12 帧、攻击组 18 帧），
  // 所以不进 `FIRE_DEMON_SUMMON_PARITY`——那是「同一格副本」的断言，这里不是。
  '2321003': { effect: 17, hit: 7, summonStand: 12, summonMove: 12, summonAttack: 20 },
  // 進階祝福（2026-09-23）：帧数实测自 `Skill/232.img`。它比 楓葉祝福 `2321000`
  // 多出 `affected` / `affected0` 两组「被加持者」的表现——与源 `info` 的
  // `massSpell=1`（队伍增益）一致，**不**与 2321000 同格，所以不进
  // `SIBLING_ART_PARITY`（那张表钉的是「同一格副本」）。
  '2321005': { effect: 12, effect0: 17, affected: 16, affected0: 16 },
};
// 「同一格副本」的美术同格性：服务端把这七条与冰雷那三条合进同一张表，前提就是
// 它们的美术组逐组同形。这里用逐组帧数相等来钉住这个前提——两边一旦分叉，
// 要么是源素材被换过，要么是导出规则只对其中一边生效，两种都必须当场暴露。
// 召喚火魔只对 `hit` 与 `summon*` 成立：它的 `effect` 节点本身帧数就与冰魔不同
// （10 对 17），这是源里的事实，不是接线缺口。
const SIBLING_ART_PARITY = [
  ['2121000', '2221000'],
  ['2321000', '2221000'],
  ['2121004', '2221004'],
  ['2321004', '2221004'],
  ['2121008', '2221008'],
  ['2321009', '2221008'],
  ['2121053', '2221053'],
  ['2321053', '2221053'],
];
// 冰魔／火魔是**同一格副本**（源 `common` 与召唤组逐组同帧），所以逐组钉相等。
// 召喚聖龍 `2321003` **不在**这张表里：它是主教的独立召唤，位移组是 `fly`、攻击组 20 帧，
// 与那两本不同格（帧数已在 `EXTRA_GROUPS` 里逐组钉死）。
const FIRE_DEMON_SUMMON_PARITY = ['2121005', '2221005'];

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function localPath(url) {
  assert(typeof url === 'string' && url.startsWith('/'), `invalid asset URL: ${url}`);
  assert(url.startsWith('/assets/'), `asset URL is outside the exported asset root: ${url}`);
  return path.join(ROOT, 'resources/tms273-export', url.slice(1));
}

function checkFrame(frame) {
  for (const field of ['url', 'source', 'width', 'height', 'delay', 'rawDelay', 'origin', 'outlink', 'sha256']) {
    assert(Object.prototype.hasOwnProperty.call(frame, field), `frame missing ${field}`);
  }
  assert(Number.isSafeInteger(frame.width) && frame.width > 0, `invalid width: ${frame.source}`);
  assert(Number.isSafeInteger(frame.height) && frame.height > 0, `invalid height: ${frame.source}`);
  assert(Number.isFinite(frame.delay) && frame.delay >= 0, `invalid display delay: ${frame.source}`);
  if (frame.origin) {
    assert.equal(frame.x, frame.origin.x === 0 ? 0 : -frame.origin.x, `x/origin mismatch: ${frame.source}`);
    assert.equal(frame.y, frame.origin.y === 0 ? 0 : -frame.origin.y, `y/origin mismatch: ${frame.source}`);
  } else {
    assert.equal(frame.x, 0, `missing-origin x must be zero: ${frame.source}`);
    assert.equal(frame.y, 0, `missing-origin y must be zero: ${frame.source}`);
  }
  if (frame.rawDelay === null) assert.equal(frame.delay, 0, `missing delay must be static: ${frame.source}`);
  else assert.equal(frame.delay, Math.abs(Number(frame.rawDelay)), `raw/display delay mismatch: ${frame.source}`);
  const file = localPath(frame.url);
  assert(fs.existsSync(file), `PNG missing: ${file}`);
  assert.equal(sha256(file), frame.sha256, `PNG hash mismatch: ${frame.source}`);
}

function checkGroup(id, kind, frames, count) {
  assert(Array.isArray(frames), `${id} ${kind} group is missing`);
  assert.equal(frames.length, count, `${id} ${kind} frame count changed`);
  const image = SOURCE_IMAGE[id] || '220.img';
  const node = GROUP_SOURCE_BY_SKILL[id]?.[kind] || GROUP_SOURCE[kind] || kind;
  for (const frame of frames) {
    checkFrame(frame);
    assert(frame.source.startsWith(`Skill/${image}/skill/${id}/${node}/`), `wrong ${id} ${kind} source: ${frame.source}`);
    assert(typeof frame.resolvedSource === 'string' && frame.resolvedSource.length > 0, `${id} ${kind} missing resolvedSource`);
    // `outlink` 是节点里原始的 `_outlink` 字符串，`resolvedSource` 是实际取图路径。
    // 自带美术的节点（例如 `2221000` 的 effect）没有 outlink，此时前者为 null；
    // 有 outlink 时必须与解析结果一致，否则说明多跳了一层间接引用。
    if (frame.outlink !== null) {
      assert.equal(frame.outlink, frame.resolvedSource, `${id} ${kind} outlink changed`);
    }
  }
}

function groupCounts(skill) {
  const counts = {};
  for (const [kind, frames] of Object.entries(skill)) {
    if (Array.isArray(frames) && frames.length > 0) counts[kind] = frames.length;
  }
  return counts;
}

function main() {
  assert(fs.existsSync(OUTPUT), `missing ${OUTPUT}`);
  const output = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
  assert.equal(output.sourceVersion, 'TMS273.7');
  assert.deepEqual(Object.keys(output.skillEffects).sort(), [...EXPECTED].sort());
  assert(output.extraction.images?.['Skill/220.img']?.archive.endsWith('Skill_00001.ms'));
  assert(output.extraction.images?.['Skill/212.img'], 'Skill/212.img must be unpacked');
  assert(output.extraction.images?.['Skill/232.img'], 'Skill/232.img must be unpacked');
  assert(output.extraction.canvasArchives?.['参考/273/TMS273少爷一键端/客户端/TMS273.7/Data/Skill/_Canvas/_Canvas_040.wz']?.endsWith('Skill/_Canvas/_Canvas_040.wz'));
  // 212.img／232.img 各占一个分卷（实测：038 装 212、045 装 232）。少登记一卷就会在
  // 解析 outlink 时失败，所以这里把两条分卷的存在性也钉住。
  assert(output.extraction.canvasArchives?.['参考/273/TMS273少爷一键端/客户端/TMS273.7/Data/Skill/_Canvas/_Canvas_038.wz']?.endsWith('Skill/_Canvas/_Canvas_038.wz'));
  assert(output.extraction.canvasArchives?.['参考/273/TMS273少爷一键端/客户端/TMS273.7/Data/Skill/_Canvas/_Canvas_045.wz']?.endsWith('Skill/_Canvas/_Canvas_045.wz'));
  for (const id of DIRECT_EFFECTS) {
    const skill = output.skillEffects[id];
    assert(Array.isArray(skill.effect) && skill.effect.length > 0, `${id} effect is empty`);
    for (const frame of [...skill.effect, ...(skill.hit || []), ...(skill.ball || [])]) checkFrame(frame);
  }
  for (const id of PROJECTED) {
    const skill = output.skillEffects[id];
    assert(skill.source?.projection?.endsWith('resources/tms273-export/skills.json'), `${id} must be projected`);
    assert(skill.effect.length > 0, `${id} projected effect is empty`);
    for (const frame of [...skill.effect, ...(skill.hit || []), ...(skill.ball || [])]) {
      checkFrame(frame);
      assert(!frame.url.includes('/mage-effects/'), `${id} was re-exported`);
    }
  }
  for (const [id, groups] of Object.entries(EXTRA_GROUPS)) {
    for (const [kind, count] of Object.entries(groups)) checkGroup(id, kind, output.skillEffects[id][kind], count);
  }
  // 逐技能的源节点覆盖必须**真的被 `EXTRA_GROUPS` 校验到**：登记了却没人用，说明那一组
  // 已经改回默认节点名，这条覆盖就退化成一段永远不生效的注释。
  for (const [id, overrides] of Object.entries(GROUP_SOURCE_BY_SKILL)) {
    for (const kind of Object.keys(overrides)) {
      assert.ok(
        EXTRA_GROUPS[id]?.[kind] !== undefined,
        `GROUP_SOURCE_BY_SKILL 给 ${id} 登记了 ${kind} 的源节点覆盖，`
          + '但 EXTRA_GROUPS 没有校验这一组——覆盖不会被走到',
      );
    }
  }
  for (const [copyId, originalId] of SIBLING_ART_PARITY) {
    assert.deepEqual(
      groupCounts(output.skillEffects[copyId]),
      groupCounts(output.skillEffects[originalId]),
      `${copyId} 与 ${originalId} 的美术组已分叉`,
    );
  }
  const [fireDemon, iceDemon] = FIRE_DEMON_SUMMON_PARITY;
  for (const kind of ['hit', 'summonStand', 'summonMove', 'summonAttack']) {
    assert.equal(
      output.skillEffects[fireDemon][kind]?.length,
      output.skillEffects[iceDemon][kind]?.length,
      `${fireDemon} 的 ${kind} 与 ${iceDemon} 不同格`,
    );
  }
  for (const file of output.sourceFiles || []) {
    const absolute = path.join(ROOT, file.path);
    assert(fs.existsSync(absolute), `source missing: ${file.path}`);
    assert.equal(fs.statSync(absolute).size, file.bytes, `source size changed: ${file.path}`);
    assert.equal(sha256(absolute), file.sha256, `source hash changed: ${file.path}`);
  }
  console.log(JSON.stringify({ output: path.relative(ROOT, OUTPUT), sourceVersion: output.sourceVersion, skills: EXPECTED.length, ok: true }, null, 2));
}

if (require.main === module) main();

module.exports = { main };
