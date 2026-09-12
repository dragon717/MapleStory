const { evidencePath } = require('./evidence-path.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { skillManifest, mageRules } = require('./tms273_skill_manifest.cjs');
const root = path.resolve(__dirname, '..');
const input = path.join(root, 'resources/tms273-export');
const read = name => JSON.parse(fs.readFileSync(path.join(input, `${name}.json`), 'utf8'));
const skills = read('skills');
const rules = mageRules(skills);
assert.equal(Object.keys(rules.skills).length, 56);
assert.equal(rules.skills['2001008'].levels[19].damage, 78);
assert.equal(rules.skills['2201008'].bookId, 220);
assert.equal(rules.skills['2201008'].levels[19].damage, 199);
assert.equal(rules.skills['2201005'].levels[9].mobCount, 6);
assert.equal(rules.skills['2200011'].fixedLevel, true);
assert.equal(rules.skills['2200012'].boosterActionSpeed, -2);
assert.equal(rules.skills['2200006'].levels[8].cr, 5);

assert.equal(rules.skills['2001002'].levels[0].mpCon, 9);
assert.equal(rules.skills['2001002'].levels[9].x, 85);
// 用户指定规则（2026-09-12）：魔心防禦的结算改用逐级「MP 抵偿率」阶梯，
// 源 x（15+7*x = 22→85，含义是「以 MP 代替的伤害百分比」）继续原样留在投影与源记录里。
assert.deepEqual(rules.skills['2001002'].levels.map(level => level.mpSubstitutePercent),
  [100, 98, 96, 94, 92, 90, 88, 86, 84, 80]);
assert.equal(rules.skills['2001002'].rawCommon.x, '15+7*x');
assert.equal(rules.skills['2001009'].levels[4].y, 295);
// 用户指定规则（2026-09-10）：瞬移全等级 10 MP + 等级冷却；原版记录保留在 rawCommon。
assert.deepEqual(rules.skills['2001009'].levels.map(level => level.mpCon), [10, 10, 10, 10, 10]);
assert.deepEqual(rules.skills['2001009'].levels.map(level => level.cooldownMs), [1200, 1050, 900, 750, 600]);
assert.equal(rules.skills['2001009'].rawCommon.mpCon, '30-2*x');
assert.equal(rules.skills['2001009'].levels[4].x, 190);
assert.equal(rules.skills['2000006'].levels[19].lv2mmp, 120);
assert.deepEqual(rules.skills['2000010'].prerequisites, { '2001002': 3 });
assert.equal(rules.skills['2001012'].hidden, true);
assert.deepEqual(rules.skills['2001008'].levels[0].lt, skills.catalog.skills['2001008'].common.lt);
const invalidRules = structuredClone(skills);
invalidRules.catalog.skills['2000006'].common.actionSpeed = 'unknown()';
assert.throws(() => mageRules(invalidRules));
const windowExport = read('windows-skills');
const sourceDescription = skills.catalog.skills['2200011'].string.h;
const projected = skillManifest(windowExport, skills);
assert.equal(Object.keys(projected.skillCatalog).length, 56);
assert.deepEqual(projected.skillCatalog['2000010'].prerequisites, { '2001002': 3 });
assert.deepEqual(projected.skillCatalog['2200000'].prerequisites, { '2200006': 5 });
assert.deepEqual(projected.skillCatalog['2201001'].prerequisites, { '2200000': 3 });
assert.equal(projected.skillCatalog['2001008'].levelDescriptions[19], '消耗MP24，最多對4名的敵人以78%的傷害值進行攻擊4次');
// 用户指定规则（2026-09-12）：技能窗文案同表驱动，99% 为固定比例、抵偿率逐级 100→80，
// 抵偿率化不去的差额由护盾消解（不是回落 HP），HP 只承担未被接下的那 1%。
assert.equal(projected.skillCatalog['2001002'].levelDescriptions[9],
  '消耗MP 13。启用期间受到伤害的99%转由魔力承受，魔力以80%的抵偿率将其化去，化不去的部分由护盾消解；未被转走的那1%仍由生命承担。');
assert.equal(projected.skillCatalog['2001002'].levelDescriptions[0],
  '消耗MP 9。启用期间受到伤害的99%转由魔力承受，魔力以100%的抵偿率将其化去，化不去的部分由护盾消解；未被转走的那1%仍由生命承担。');
assert.match(projected.skillCatalog['2001002'].description, /99%转由魔力承受/);
assert.match(projected.skillCatalog['2001002'].description, /由护盾代为消解/);
assert.match(projected.skillCatalog['2001002'].description, /那1%会落到你身上/);
assert.doesNotMatch(projected.skillCatalog['2001002'].description, /守恒/);
// 源文案本身不得被改写（同 2200011 的源记录断言）。
assert.equal(skills.catalog.skills['2001002'].string.h, '消耗MP #mpCon，啟用期間受到的傷害的#x%以MP代替。');
assert.match(projected.skillCatalog['2001009'].levelDescriptions[4], /消耗10MP，朝左右瞬移190並朝上下瞬移295/);
assert.match(projected.skillCatalog['2001009'].levelDescriptions[0], /消耗10MP，朝左右瞬移130並朝上下瞬移275/);
assert.match(projected.skillCatalog['2201008'].levelDescriptions[0], /冰凍8秒。$/);
assert.match(projected.skillCatalog['2200011'].levelDescriptions[0], /#c爆擊傷害值增加2%/);
assert.equal(Object.hasOwn(projected.skillCatalog['2001012'], 'levelDescriptions'), false);
assert.equal(skills.catalog.skills['2200011'].string.h, sourceDescription);

const unknown = structuredClone(skills);
unknown.catalog.skills['2200011'].string.h = '#c#unknown #xyz #x';
assert.equal(skillManifest(windowExport, unknown).skillCatalog['2200011'].levelDescriptions[0], '#c#unknown #xyz 2');

const invalidFormula = structuredClone(skills);
invalidFormula.catalog.skills['2001002'].common.mpCon = 'invalid()';
assert.throws(() => skillManifest(windowExport, invalidFormula), /unknown identifier 'invalid'/);

const changed = structuredClone(skills);
changed.catalog.skills['2001008'].displayFlags.source.invisible = '0';
assert.equal(skillManifest(windowExport, changed).skillCatalog['2001008'].hidden, false);
changed.catalog.skills['2001008'].displayFlags.source.invisible = '1';
assert.equal(skillManifest(windowExport, changed).skillCatalog['2001008'].hidden, true);
changed.catalog.skills['2001008'].displayFlags.source.invisible = 'unknown';
assert.throws(() => skillManifest(windowExport, changed));
console.log('PASS: 56 source skills, level descriptions, prerequisites, level values, explicit invisible flag values, and the user-specified teleport rule.');

if (process.argv.includes('--browser-fixture')) {
  const output = evidencePath('skills-check');
  fs.mkdirSync(path.join(output, 'assets'), { recursive: true });
  const assets = path.join(output, 'assets/tms273');
  if (!fs.existsSync(assets)) fs.symlinkSync(path.join(input, 'assets/tms273'), assets, 'dir');
  const current = JSON.parse(fs.readFileSync(path.join(root, 'client/public-tms273/assets/manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(output, 'assets/manifest.json'), JSON.stringify({ ...projected, closeButton: current.closeButton }), 'utf8');
  require('../client/node_modules/esbuild').build({
    entryPoints: [path.join(root, 'qa/skills_ui.ts')], bundle: true, format: 'esm',
    target: 'es2022', outfile: path.join(output, 'skills-check.js'),
  }).then(() => {
    fs.writeFileSync(path.join(output, 'skills-check.html'), '<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Skills UI check</title><link rel="stylesheet" href="/skills-check.css"><script type="module" src="/skills-check.js"></script></html>', 'utf8');
    console.log('Fixture ready in the dated evidence directory');
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
