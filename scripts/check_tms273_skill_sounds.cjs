#!/usr/bin/env node

// Targeted read-only contract check for export_tms273_skill_sounds.cjs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'resources/tms273-export');
const manifestPath = path.join(OUTPUT, 'skill-sounds.json');
const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const expectedIds = [
  '2000006', '2000007', '2000010', '2001002', '2001008', '2001009', '2001011',
  '2001012', '2200000', '2200006', '2200007', '2200011', '2200012', '2201001',
  '2201005', '2201008', '2201009',
];
const expectedExecutable = [
  '2001002', '2001008', '2001009', '2001011', '2001012',
  '2201001', '2201005', '2201008', '2201009',
];
const expectedNodes = {
  '2001002': ['Use'],
  '2001008': ['Use', 'Hit', 'special'],
  '2001009': ['Use'],
  '2001011': ['Use'],
  '2001012': ['Use', 'Loop'],
  '2201001': ['Use'],
  '2201005': ['Use', 'Hit'],
  '2201008': ['Use', 'Hit'],
};
const missingIds = expectedIds.filter(id => !Object.hasOwn(expectedNodes, id));

function localAsset(url) {
  assert.equal(typeof url, 'string', 'exported node URL is missing');
  const prefix = '/assets/tms273/';
  assert(url.startsWith(prefix), `unexpected asset URL: ${url}`);
  return path.join(OUTPUT, 'assets/tms273', url.slice(prefix.length));
}

function fileSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

assert.equal(data.contentVersion, 'tms273-skill-sounds');
assert.equal(data.sourceVersion, 'TMS273.7');
assert.deepEqual(data.catalogSkillIds, expectedIds);
assert.deepEqual(data.executableSkillIds, expectedExecutable);
assert.deepEqual(Object.keys(data.skillSounds), expectedIds);
assert.equal(data.status, 'complete');
assert.equal(data.sourceFiles.length, 1);
for (const source of data.sourceFiles) {
  const sourcePath = path.join(ROOT, source.path);
  assert(fs.existsSync(sourcePath), `missing source archive: ${source.path}`);
  assert.equal(fs.statSync(sourcePath).size, source.bytes, `source archive size changed: ${source.path}`);
  assert.equal(fileSha256(sourcePath), source.sha256, `source archive fingerprint changed: ${source.path}`);
}

for (const [id, skill] of Object.entries(data.skillSounds)) {
  if (missingIds.includes(id)) {
    assert.equal(skill.status, 'missing', `${id} missing skill must be marked missing`);
    assert.equal(skill.available, false, `${id} missing skill must be unavailable`);
    assert.equal(skill.nodeNames.length, 0, `${id} missing skill unexpectedly has nodes`);
    assert.equal(skill.reason.includes('找不到 273 WZ 节点'), true, `${id} missing reason is not source-backed`);
    continue;
  }

  assert.equal(skill.status, 'complete', `${id} sound directory status`);
  assert.equal(skill.available, true, `${id} sound directory availability`);
  assert.deepEqual(skill.nodeNames, expectedNodes[id]);
  assert.deepEqual(Object.keys(skill.nodes), expectedNodes[id]);
  for (const name of expectedNodes[id]) {
    const node = skill.nodes[name];
    assert.equal(node.status, 'exported', `${id}/${name} status`);
    assert.equal(node.format, 'mp3', `${id}/${name} format`);
    assert(node.bytes > 0, `${id}/${name} has empty output`);
    assert.equal(node.source, `${skill.source}/${name}`);
    const assetPath = localAsset(node.url);
    assert(fs.existsSync(assetPath), `missing ${id}/${name} output: ${node.url}`);
    assert.equal(fs.statSync(assetPath).size, node.bytes, `${id}/${name} byte count`);
    assert.equal(fileSha256(assetPath), node.sha256, `${id}/${name} output fingerprint`);
    assert.equal(node.raw.sourceFile, data.sourceFiles[0].path, `${id}/${name} source archive`);
  }
}

const alias = data.skillSounds['2201001'].use;
assert.equal(alias.raw.type, 'WzUOLProperty');
assert.equal(alias.raw.link, '../2101001/Use');
assert.equal(alias.resolvedSource, 'Sound/Skill.img/2101001/Use');
assert(alias.url.includes('2101001_Use'), 'UOL output must use resolved asset source');

const exportedCount = Object.values(data.skillSounds)
  .flatMap(skill => Object.values(skill.nodes || {}))
  .filter(node => node.status === 'exported').length;
assert.equal(exportedCount, 13);

console.log(JSON.stringify({
  manifest: manifestPath,
  catalogSkills: expectedIds.length,
  missingSkillDirectories: missingIds,
  soundDirectories: Object.values(data.skillSounds).filter(skill => skill.available).length,
  exportedNodes: exportedCount,
  sourceArchive: data.sourceFiles[0],
}, null, 2));
