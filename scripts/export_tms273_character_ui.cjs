const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createReader } = require('./tms273_wz.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'resources/tms273-export');
const reader = createReader(path.join(root, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data'));
const base = 'UI/UICharacterInfo.img/';
const states = ['normal', 'mouseOver', 'pressed', 'disabled'];
const apButtonGroups = [
  'local/detailStat/button:lvUpStr',
  'local/detailStat/button:lvUpDex',
  'local/detailStat/button:lvUpInt',
  'local/detailStat/button:lvUpLuk',
  'local/detailStat/button:lvUpHp',
  'local/detailStat/button:lvUpMp',
  'local/detailStat/button:apDistribution',
  'local/detailStat/Addon:apDistribution/button:apAuto',
  'local/detailStat/Addon:apDistribution/button:apAutoStr',
  'local/detailStat/Addon:apDistribution/button:apAutoDex',
  'local/detailStat/Addon:apDistribution/button:apAutoXenon1',
  'local/detailStat/Addon:apDistribution/button:apAutoXenon2',
  'local/detailStat/Addon:apDistribution/button:apAutoXenon3',
];
const keys = ['common/main/backgrnd', 'local/detail/backgrnd', 'local/detail/layer:stat',
  'common/detailStat/canvas:attackBack', 'common/detailStat/canvas:utilityBack',
  'common/detailStat/canvas:mainStatFont', 'common/detailStat/canvas:attackFont',
  'common/detailStat/canvas:utilityFont', 'common/detailStat/canvas:defenseFont',
  'local/detailStat/canvas:mainStatBack',
  ...states.map(state => `common/main/button:close/${state}/0`),
  ...apButtonGroups.flatMap(group => states.map(state => `${group}/${state}/0`))];
async function main() {
  const characterUi = {}, characterLayout = {};
  for (const key of keys) {
    const source = base + key, node = await reader.get(source);
    const frame = await reader.frame(source, path.join(output, 'assets/tms273'));
    const rawDelay = node.at('delay')?.wzValue ?? null;
    const file = path.join(output, 'assets/tms273', frame.url);
    assert(frame.width > 0 && frame.height > 0);
    assert(node.at('origin'), `Missing original origin: ${source}`);
    assert.equal(frame.x, -frame.origin.x);
    assert.equal(frame.y, -frame.origin.y);
    assert.equal(rawDelay, null, `Expected static UI: ${source}`);
    characterUi[key] = { ...frame, url: '/assets/tms273/' + frame.url, delay: 0, rawDelay,
      outlink: node.at('_outlink')?.wzValue ?? null,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
  }
  assert.equal(characterUi['common/main/backgrnd'].width, 472);
  assert.equal(characterUi['common/main/backgrnd'].height, 230);
  assert.equal(characterUi['local/detail/backgrnd'].height, 479);
  assert.equal(characterUi['local/detailStat/button:lvUpStr/normal/0'].width, 16);
  assert.equal(characterUi['local/detailStat/button:lvUpStr/normal/0'].height, 16);
  assert.equal(characterUi['local/detailStat/button:apDistribution/normal/0'].width, 10);
  assert.equal(characterUi['local/detailStat/button:apDistribution/normal/0'].height, 81);
  assert.equal(characterUi['local/detailStat/Addon:apDistribution/button:apAuto/normal/0'].width, 138);
  assert.equal(characterUi['local/detailStat/Addon:apDistribution/button:apAuto/normal/0'].height, 44);
  assert.equal(characterUi['local/detailStat/Addon:apDistribution/button:apAutoStr/normal/0'].height, 22);
  for (const group of ['common/main', 'common/detailStat', 'local/detail', 'local/detailStat', 'local/detailStat/Addon:apDistribution']) {
    const node = await reader.get(base + group);
    for (const child of node.wzProperties ?? []) if (child.name.startsWith('vector:')) {
      const { x, y } = child.wzValue;
      assert(Number.isFinite(x) && Number.isFinite(y));
      characterLayout[group + '/' + child.name] = { x, y };
    }
  }
  assert.deepEqual(characterLayout['local/detailStat/vector:apDistributionLT'], { x: 461, y: 38 });
  assert.deepEqual(characterLayout['local/detailStat/Addon:apDistribution/vector:pointPos'], { x: 110, y: 9 });
  assert.deepEqual(characterLayout['local/detailStat/Addon:apDistribution/vector:tutorialPos'], { x: -104, y: -65 });
  fs.writeFileSync(path.join(output, 'character-ui.json'), JSON.stringify({ sourceVersion: 'TMS273.7', source: base, characterUi, characterLayout }, null, 2) + '\n', 'utf8');
  console.log(`Exported ${keys.length} original character UI images and ${Object.keys(characterLayout).length} source positions`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => reader.close());
