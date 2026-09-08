#!/usr/bin/env node

// Read-only contract check for export_tms273_skills.cjs.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'resources/tms273-export');
const MANIFEST = path.join(OUTPUT, 'skills.json');
const PREFIX = '/assets/tms273/';

function localAsset(url) {
  assert(typeof url === 'string' && url.startsWith(PREFIX), `invalid asset URL: ${url}`);
  return path.join(OUTPUT, 'assets/tms273', url.slice(PREFIX.length));
}

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const data = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const skill = data.skills?.['2001008'];
assert(skill, '2001008 is missing');
assert(data.skills?.['2201008'], '2201008 is missing');
assert(data.skills?.['2201005'], '2201005 is missing');
assert(!data.skills?.['2201004'], '2201004 must not be exported without a Skill/220.json node');
assert.equal(data.sourceVersion, 'TMS273.7');
assert.equal(data.extraction.image, 'Skill/200.img');
assert(data.extraction.archive.endsWith('Skill_00000.ms'));
assert(data.extraction.images?.['Skill/200.img']?.archive.endsWith('Skill_00000.ms'));
assert(data.extraction.images?.['Skill/220.img']?.archive.endsWith('Skill_00001.ms'));
assert(data.extraction.canvasArchive.endsWith('Skill/_Canvas/_Canvas_035.wz'));
assert(data.extraction.canvasArchives?.['Skill/_Canvas/_Canvas_040.wz']?.endsWith('Skill/_Canvas/_Canvas_040.wz'));
assert(data.sourceFiles.length >= 8);
for (const source of data.sourceFiles) {
  assert(/^[a-f0-9]{64}$/.test(source.sha256), `source sha256 missing: ${source.path}`);
  assert(source.bytes > 0, `source is empty: ${source.path}`);
}

assert.equal(data.formulaSemantics.classification, 'R');
assert.equal(data.formulaSemantics.d, 'floor');
assert.equal(data.formulaSemantics.u, 'ceil');
const levelExamples = {
  '2001008': [[1, 16, 21], [4, 16, 30], [5, 18, 33], [20, 24, 78]],
  '2201005': [[1, 20, 138], [3, 20, 154], [4, 25, 162], [10, 30, 210]],
  '2201008': [[1, 12, 104], [3, 12, 114], [4, 15, 119], [20, 27, 199]],
};
for (const [id, examples] of Object.entries(levelExamples)) {
  const entry = data.skills[id];
  assert.equal(entry.levelValues.length, Number(entry.sourceFields.common.maxLevel));
  for (const [level, mpCon, damage] of examples) {
    assert.deepEqual(entry.levelValues[level - 1], {
      level, mpCon, damage,
      mobCount: id === '2001008' ? 4 : 6,
      attackCount: id === '2001008' ? 4 : 3,
    }, `${id} level ${level} source values changed`);
  }
}

const catalog = data.catalog;
assert(catalog, 'catalog is missing');
assert.deepEqual(Object.keys(catalog.books).sort(), ['200', '220']);
assert.equal(catalog.books['200'].name, '法師入門');
assert.equal(catalog.books['200'].bookName, '法師入門');
assert.equal(catalog.books['220'].name, '冰/雷魔法指南');
assert.equal(catalog.books['220'].bookName, '冰/雷魔法指南');
assert.equal(catalog.books['200'].string.bookName, '法師入門');
assert.equal(catalog.books['220'].string.bookName, '冰/雷魔法指南');
assert.equal(Object.keys(catalog.skills).length, 17);
assert(!catalog.skills['2201004'], '2201004 must not be cataloged without a Skill node');
const expectedCatalogIds = [
  '2000006', '2000007', '2000010', '2001002', '2001008', '2001009', '2001011', '2001012',
  '2200000', '2200006', '2200007', '2200011', '2200012', '2201001', '2201005', '2201008', '2201009',
];
assert.deepEqual(Object.keys(catalog.skills).sort(), expectedCatalogIds.sort());
const expectedCatalogMaxLevels = {
  '2000006': '20', '2000007': '1', '2000010': '9', '2001002': '10', '2001008': '20', '2001009': '5', '2001011': '1', '2001012': '1',
  '2200000': '9', '2200006': '10', '2200007': '5', '2200011': '1', '2200012': '10', '2201001': '20', '2201005': '10', '2201008': '20', '2201009': '10',
};
const expectedCatalogReq = {
  '2000010': { '2001002': '3' },
  '2200000': { '2200006': '5' },
  '2201001': { '2200000': '3' },
};
const catalogIconKinds = { normal: 'icon', mouseOver: 'iconMouseOver', disabled: 'iconDisabled' };
for (const id of expectedCatalogIds) {
  const entry = catalog.skills[id];
  const job = id.startsWith('200') ? 200 : 220;
  assert.equal(entry.book, String(job), `${id} book mapping changed`);
  assert.equal(entry.job, job, `${id} job mapping changed`);
  assert.equal(entry.source.skillJson, `WZ_JSON_TW/Skill/${job}.json#skill.${id}`);
  assert.equal(entry.source.stringJson, `WZ_JSON_TW/String/Skill.json#${id}`);
  assert.equal(entry.source.skillImage, `Skill/${job}.img/skill/${id}`);
  assert.equal(entry.name, entry.string.name, `${id} String name was not preserved`);
  assert.equal(entry.description, entry.string.desc, `${id} String description was not preserved`);
  assert.equal(entry.sourceFields.maxLevel, expectedCatalogMaxLevels[id], `${id} maxLevel changed`);
  assert.equal(entry.maxLevel, expectedCatalogMaxLevels[id], `${id} maxLevel alias changed`);
  assert.deepEqual(entry.req, expectedCatalogReq[id] || null, `${id} req changed`);
  assert.deepEqual(entry.sourceFields.req, expectedCatalogReq[id] || null, `${id} source req changed`);
  assert(Object.prototype.hasOwnProperty.call(entry.sourceFields, 'common'), `${id} common source missing`);
  assert(Object.prototype.hasOwnProperty.call(entry.sourceFields, 'info'), `${id} info source missing`);
  assert(Object.prototype.hasOwnProperty.call(entry.sourceFields, 'info2'), `${id} info2 source missing`);
  assert(entry.rawWz?.skill?.common?.maxLevel, `${id} raw common missing`);
  assert.equal(entry.rawWz.skill.common.maxLevel._value, expectedCatalogMaxLevels[id], `${id} raw maxLevel changed`);
  assert.equal(entry.learnability?.status, 'unverified', `${id} learnability was inferred`);
  assert(!Object.prototype.hasOwnProperty.call(entry, 'levelValues'), `${id} catalog gained evaluated formulas`);
  assert.deepEqual(Object.keys(entry.icons).sort(), ['disabled', 'mouseOver', 'normal']);
  for (const [outputKind, sourceKind] of Object.entries(catalogIconKinds)) {
    const frame = entry.icons[outputKind];
    assert(frame, `${id} ${outputKind} icon missing`);
    assert.equal(frame.status, 'exported', `${id} ${outputKind} icon was not exported`);
    assert(frame.source.startsWith(`Skill/${job}.img/skill/${id}/${sourceKind}`), `${id} ${outputKind} source changed`);
    assert(frame.resolvedSource.startsWith('Skill/_Canvas/'), `${id} ${outputKind} resolved source missing`);
    assert(frame.outlink, `${id} ${outputKind} source outlink missing`);
    assert(frame.origin && Number.isFinite(frame.origin.x) && Number.isFinite(frame.origin.y), `${id} ${outputKind} source origin missing`);
    assert.equal(frame.delay, null, `${id} ${outputKind} fabricated delay`);
    assert.equal(frame.metadataStatus, 'static-delay-missing', `${id} ${outputKind} metadata status changed`);
    const file = localAsset(frame.url);
    assert(fs.existsSync(file), `missing ${id} ${outputKind} asset: ${file}`);
    assert.equal(fs.readFileSync(file).subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${id} ${outputKind} asset is not PNG`);
    assert.equal(fs.statSync(file).size, frame.bytes, `${id} ${outputKind} byte count changed`);
    assert.equal(digest(file), frame.sha256, `${id} ${outputKind} sha256 mismatch`);
  }
}
assert.deepEqual(catalog.iconGaps, [], 'catalog icon gaps must be explicit and empty for the 17 source nodes');
for (const id of ['2000007', '2001012']) {
  assert.equal(catalog.skills[id].displayFlags.hasInvisible, true, `${id} invisible marker missing`);
  assert.equal(catalog.skills[id].displayFlags.source.invisible, '1', `${id} invisible source value changed`);
}
for (const id of expectedCatalogIds.filter(id => !['2000007', '2001012'].includes(id))) {
  assert.equal(catalog.skills[id].displayFlags.hasInvisible, false, `${id} invented invisible marker`);
}
for (const id of ['2000006', '2000010', '2001009', '2200006', '2200007', '2200012']) {
  assert.equal(catalog.skills[id].displayFlags.derived.passive, true, `${id} passive source marker missing`);
}
assert.equal(catalog.skills['2200011'].displayFlags.derived.fixedLevel, true, '2200011 fixed-level source marker missing');
assert(Object.values(catalog.skills).every(entry => !entry.learnable), 'catalog must not grant learning');

assert.equal(skill.name, '魔靈彈');
assert.equal(skill.sourceFields.info.type, '2');
assert(!Object.prototype.hasOwnProperty.call(skill.sourceFields.info, 'magicDamage'), 'invented magicDamage field');
assert.equal(skill.sourceFields.common.mpCon, '16+2*d(x/5)');
assert.equal(skill.sourceFields.common.damage, '18+3*x');
assert.equal(skill.sourceFields.common.mobCount, '4');
assert.equal(skill.sourceFields.common.attackCount, '4');
assert.equal(skill.sourceFields.action['0'], 'energyBolt');
assert.equal(skill.string.h, '消耗MP#mpCon，最多對#mobCount名的敵人以#damage%的傷害值進行攻擊#attackCount次');
assert.deepEqual(skill.runtimeUnknowns.map(item => item.field), ['unlockCondition', 'formulaEvaluation', 'serverHitTiming']);
assert(skill.runtimeUnknowns.every(item => item.status && item.reason), 'runtime unknowns must be explicit');

assert.deepEqual(skill.bodyTimeline.frames.map(frame => frame.action), ['alert', 'swingO3', 'swingO3']);
assert.deepEqual(skill.bodyTimeline.frames.map(frame => frame.frame), [2, 0, 1]);
assert.deepEqual(skill.bodyTimeline.frames.map(frame => frame.delay), [-60, -330, 270]);
assert.deepEqual(skill.bodyTimeline.frames.map(frame => frame.move), [null, { x: 6, y: 0 }, { x: 22, y: 0 }]);

const expectedCounts = { icon: 1, iconMouseOver: 1, iconDisabled: 1, effect: 16, ball: 10, hit: 8, special: 11 };
for (const [kind, count] of Object.entries(expectedCounts)) {
  const frames = skill.assets[kind];
  assert.equal(frames.length, count, `${kind} frame count changed`);
  for (const frame of frames) {
    assert.equal(frame.status, 'exported', `${kind} frame was not exported`);
    assert(frame.source.startsWith(`Skill/200.img/skill/2001008/${kind}`), `wrong ${kind} source: ${frame.source}`);
    assert(frame.resolvedSource.startsWith('Skill/_Canvas/200.img/skill/2001008/'), `wrong resolved source: ${frame.resolvedSource}`);
    assert(frame.width > 0 && frame.height > 0, `invalid ${kind} dimensions`);
    const file = localAsset(frame.url);
    assert(fs.existsSync(file), `missing ${kind} asset: ${file}`);
    assert.equal(fs.readFileSync(file).subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${kind} asset is not PNG`);
    assert.equal(fs.statSync(file).size, frame.bytes, `${kind} byte count changed`);
    assert.equal(digest(file), frame.sha256, `${kind} sha256 mismatch`);
    assert(frame.outlink, `${kind} source outlink missing`);
    assert(frame.origin && Number.isFinite(frame.origin.x) && Number.isFinite(frame.origin.y), `${kind} source origin missing`);
    if (kind.startsWith('icon')) {
      assert.equal(frame.delay, null, `${kind} fabricated delay`);
      assert.equal(frame.metadataStatus, 'static-delay-missing');
    }
    else assert(Number.isFinite(frame.delay) && frame.delay > 0, `${kind} source delay missing`);
  }
}

assert(!Object.values(skill.sourceFields.common).some(value => typeof value === 'number' && value === 18), 'damage formula was evaluated');

function checkAssets(id, expectedCounts, image, resolvedImage) {
  const entry = data.skills[id];
  for (const [kind, count] of Object.entries(expectedCounts)) {
    const frames = entry.assets[kind];
    assert.equal(frames.length, count, `${id} ${kind} frame count changed`);
    for (const frame of frames) {
      assert.equal(frame.status, 'exported', `${id} ${kind} frame was not exported`);
      assert(frame.source.startsWith(`Skill/${image}.img/skill/${id}/${kind}`), `wrong ${id} ${kind} source: ${frame.source}`);
      assert(frame.resolvedSource.startsWith(`Skill/_Canvas/${resolvedImage}.img/skill/${id}/${kind}`), `wrong ${id} ${kind} resolved source: ${frame.resolvedSource}`);
      assert.equal(frame.outlink, frame.resolvedSource, `${id} ${kind} outlink changed`);
      assert(frame.origin && Number.isFinite(frame.origin.x) && Number.isFinite(frame.origin.y), `${id} ${kind} source origin missing`);
      assert(frame.width > 0 && frame.height > 0, `${id} ${kind} dimensions invalid`);
      const file = localAsset(frame.url);
      assert(fs.existsSync(file), `missing ${id} ${kind} asset: ${file}`);
      assert.equal(fs.readFileSync(file).subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${id} ${kind} asset is not PNG`);
      assert.equal(fs.statSync(file).size, frame.bytes, `${id} ${kind} byte count changed`);
      assert.equal(digest(file), frame.sha256, `${id} ${kind} sha256 mismatch`);
      if (kind.startsWith('icon')) {
        assert.equal(frame.delay, null, `${id} ${kind} fabricated delay`);
        assert.equal(frame.metadataStatus, 'static-delay-missing');
      } else {
        assert(Number.isFinite(frame.delay) && frame.delay > 0, `${id} ${kind} source delay missing`);
      }
    }
  }
}

const coldBeam = data.skills['2201008'];
assert.equal(coldBeam.name, '冰錐劍');
assert.equal(coldBeam.sourceFields.info.magicDamage, '1');
assert.equal(coldBeam.sourceFields.info2.mes, 'cold');
assert.equal(coldBeam.sourceFields.action['0'], 'coldBeam');
assert.equal(coldBeam.sourceFields.common.mpCon, '12+3*d(x/4)');
assert.equal(coldBeam.sourceFields.common.damage, '99+5*x');
assert.equal(coldBeam.sourceFields.effect.property.delay, '60');
assert.equal(coldBeam.sourceFields.effect0.fix, '1');
assert.deepEqual(coldBeam.bodyTimeline.frames.map(frame => frame.action), ['swingO2', 'swingO2', 'swingO2', 'swingO2', 'swingO2', 'swingO2', 'swingO2', 'alert']);
assert.deepEqual(coldBeam.bodyTimeline.frames.map(frame => frame.frame), [1, 0, 0, 1, 2, 2, 2, 0]);
assert.deepEqual(coldBeam.bodyTimeline.frames.map(frame => frame.delay), [-90, -90, -210, -60, 60, 60, 120, 120]);
assert.deepEqual(coldBeam.bodyTimeline.frames.map(frame => frame.move), [null, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 0, y: 0 }, { x: -11, y: 0 }, { x: -13, y: 0 }, { x: -14, y: 0 }, { x: -4, y: 0 }]);
assert(!coldBeam.assets.ball && !coldBeam.assets.special, 'coldBeam fabricated absent asset groups');

const thunderBolt = data.skills['2201005'];
assert.equal(thunderBolt.name, '電閃雷鳴');
assert.equal(thunderBolt.sourceFields.info.magicDamage, '1');
assert.equal(thunderBolt.sourceFields.action['0'], 'thunderBolt');
assert.equal(thunderBolt.sourceFields.common.mpCon, '20+5*d(x/4)');
assert.equal(thunderBolt.sourceFields.common.damage, '130+8*x');
assert.deepEqual(thunderBolt.bodyTimeline.frames.map(frame => frame.action), ['swingO3', 'stabO1']);
assert.deepEqual(thunderBolt.bodyTimeline.frames.map(frame => frame.frame), [0, 1]);
assert.deepEqual(thunderBolt.bodyTimeline.frames.map(frame => frame.delay), [-300, 510]);
assert.deepEqual(thunderBolt.bodyTimeline.frames.map(frame => frame.move), [{ x: 1, y: 0 }, { x: 1, y: 0 }]);
assert(!thunderBolt.assets.effect0 && !thunderBolt.assets.ball && !thunderBolt.assets.special, 'thunderBolt fabricated absent asset groups');

const gaps = new Set(data.assetGaps.map(item => `${item.skill}:${item.group}:${item.status}`));
for (const group of ['ball', 'special']) assert(gaps.has(`2201008:${group}:source-missing`));
for (const group of ['effect0', 'ball', 'special']) assert(gaps.has(`2201005:${group}:source-missing`));
assert(data.assetGaps.every(item => item.reason.includes('no asset was fabricated')));
checkAssets('2201008', { icon: 1, iconMouseOver: 1, iconDisabled: 1, effect: 13, effect0: 19, hit: 6 }, '220', '220');
checkAssets('2201005', { icon: 1, iconMouseOver: 1, iconDisabled: 1, effect: 14, hit: 12 }, '220', '220');

console.log(JSON.stringify({
  manifest: MANIFEST,
  status: data.status,
  sourceVersion: data.sourceVersion,
  catalog: {
    books: Object.fromEntries(Object.entries(catalog.books).map(([id, book]) => [id, book.name])),
    skills: Object.keys(catalog.skills).length,
    invisibleSourceIds: Object.entries(catalog.skills)
      .filter(([, entry]) => String(entry.displayFlags.source.invisible) === '1')
      .map(([id]) => id),
    derivedCandidates: Object.entries(catalog.skills)
      .filter(([, entry]) => Object.values(entry.displayFlags.derived).some(Boolean))
      .map(([id]) => id),
    iconGaps: catalog.iconGaps,
  },
  skills: Object.fromEntries(Object.entries(data.skills).map(([id, entry]) => [id, Object.fromEntries(Object.entries(entry.assets).map(([kind, frames]) => [kind, frames.length]))])),
  metadataGaps: data.metadataGaps,
}, null, 2));
