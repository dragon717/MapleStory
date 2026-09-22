// 一次性定向重算（2026-09-21）：装配器 `assemble_tms273.cjs` 因上一轮「勇士部落 13 图」
// 的中间态跑不动（entities 缺 9 个新怪模板 ⇒ gameplay 停在 198 图，与 maps-rendered 211 图
// 不一致），本轮只重算与法师技能书有关的两个产物，**不碰地图与实体**。
// 用的就是装配器那两行的同一批函数（`skillManifest` / `mageRules`），不另写一套口径；
// 产物的正确性由 `check_tms273_skill_manifest.cjs` 与 `check_tms273_runtime.cjs` 从源独立重算验证。
const fs = require('node:fs');
const path = require('node:path');
const { skillManifest, mageRules } = require('./tms273_skill_manifest.cjs');
const root = path.resolve(__dirname, '..');
const input = path.join(root, 'resources/tms273-export');
const read = name => JSON.parse(fs.readFileSync(path.join(input, name + '.json'), 'utf8'));
const write = (file, value) => {
  for (const ext of ['.br', '.gz']) fs.rmSync(file + ext, { force: true });
  fs.writeFileSync(file, JSON.stringify(value) + '\n', 'utf8');
};

write(path.join(root, 'shared/mage-skills.json'), mageRules(read('skills')));

const manifestPath = path.join(root, 'client/public-tms273/assets/manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
Object.assign(manifest, skillManifest(read('windows-skills'), read('skills')));
write(manifestPath, manifest);
console.log('mage-skills', Object.keys(mageRules(read('skills')).skills).length,
  'manifest.skillCatalog', Object.keys(manifest.skillCatalog).length,
  'manifest.skillBooks', Object.keys(manifest.skillBooks).length);
