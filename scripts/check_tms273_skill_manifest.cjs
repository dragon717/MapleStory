const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { skillManifest, mageRules } = require('./tms273_skill_manifest.cjs');
const root = path.resolve(__dirname, '..');
const input = path.join(root, 'resources/tms273-export');
const read = name => JSON.parse(fs.readFileSync(path.join(input, `${name}.json`), 'utf8'));
const skills = read('skills');
const rules = mageRules(skills);
assert.equal(Object.keys(rules.skills).length, 17);
assert.equal(rules.skills['2001008'].levels[19].damage, 78);
assert.equal(rules.skills['2201008'].bookId, 220);
assert.equal(rules.skills['2201008'].levels[19].damage, 199);
assert.equal(rules.skills['2201005'].levels[9].mobCount, 6);
assert.equal(rules.skills['2200011'].fixedLevel, true);
assert.equal(rules.skills['2200012'].boosterActionSpeed, -2);
assert.equal(rules.skills['2200006'].levels[8].cr, 5);

assert.equal(rules.skills['2001002'].levels[0].mpCon, 9);
assert.equal(rules.skills['2001002'].levels[9].x, 85);
assert.equal(rules.skills['2001009'].levels[4].y, 295);
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
assert.equal(Object.keys(projected.skillCatalog).length, 17);
assert.deepEqual(projected.skillCatalog['2000010'].prerequisites, { '2001002': 3 });
assert.deepEqual(projected.skillCatalog['2200000'].prerequisites, { '2200006': 5 });
assert.deepEqual(projected.skillCatalog['2201001'].prerequisites, { '2200000': 3 });
assert.equal(projected.skillCatalog['2001008'].levelValues[19].mpCon, 24);
assert.equal(projected.skillCatalog['2001002'].levelDescriptions[9], '消耗MP 13，啟用期間受到的傷害的85%以MP代替。');
assert.match(projected.skillCatalog['2001009'].levelDescriptions[4], /消耗20MP，朝左右瞬移190並朝上下瞬移295/);
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
console.log('PASS: 17 source skills, level descriptions, prerequisites, level values, and explicit invisible flag values.');

if (process.argv.includes('--browser-fixture')) {
  const output = path.join(root, 'output/skills-check');
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
    console.log('Fixture ready: output/skills-check/skills-check.html');
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
