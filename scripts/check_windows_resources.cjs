const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
// 风铃运行期资源不属于下面这套「遍历 manifest/entry 里的 /assets/**」判据的射程：
// 风铃地图不在 manifest.json 里（客户端 installWindbellMaps 注入），素材地址又硬编码在
// scene.ts 的 preload 清单里。判据单独成模块，这里只登记调用点——**Windows 包缺一张
// 风铃图，是整张地图装载失败，而 start.bat 照样过**（2026-09-18 实况）。
const windbellBundle = require('./check_windbell_bundle.cjs');

const REQUIRED_JSON = [
  'shared/gameplay.json',
  'shared/map.json',
  'shared/maps.json',
  'shared/mage-skills.json',
  'shared/quest-text.json',
  'shared/npc-names.json',
  'shared/npc-dialogue.json',
  'shared/npc-scripts.json',
  // 转职任务目录（2026-09-21）：服务端启动时**硬校验**（缺文件即启动失败），
  // 因此它漏进包的后果是 3010 起不来，而不是「转职能用、别的不能用」。
  'shared/job-advance.json',
  'shared/character-creation.json',
  'shared/items.json',
  'client/public-tms273/assets/manifest.json',
  'client/public-tms273/assets/gameplay.json',
  'client/public-tms273/assets/items.json',
  'client/public-tms273/assets/entry/manifest.json',
  'client/public-tms273/assets/entry/appearance.json',
  'client/public-tms273/assets/entry/creation.json',
];

const ASSET_REFERENCE_JSON = [
  'client/public-tms273/assets/manifest.json',
  'client/public-tms273/assets/entry/manifest.json',
  'client/public-tms273/assets/entry/appearance.json',
  'client/public-tms273/assets/entry/creation.json',
];

function readJson(root, relativePath) {
  const absolutePath = path.join(root, relativePath);
  assert(fs.existsSync(absolutePath), `Missing runtime file: ${relativePath}`);
  const stat = fs.statSync(absolutePath);
  assert(stat.isFile() && stat.size > 0, `Runtime file is empty: ${relativePath}`);
  try {
    return JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid JSON in ${relativePath}: ${error.message}`);
  }
}

function readProtocol(root) {
  const relativePath = 'shared/protocol.ts';
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  const protocolMatch = source.match(/export\s+const\s+PROTOCOL_VERSION\s*=\s*(\d+)\s*;/);
  const contentMatch = source.match(/export\s+const\s+CONTENT_VERSION\s*=\s*(['"])([^'"]+)\1\s*;/);
  assert(protocolMatch, `Cannot read PROTOCOL_VERSION from ${relativePath}`);
  assert(contentMatch, `Cannot read CONTENT_VERSION from ${relativePath}`);
  return { protocolVersion: Number(protocolMatch[1]), contentVersion: contentMatch[2] };
}

function checkAssetReferences(root, relativePath, publicRoot) {
  const document = readJson(root, relativePath);
  let checked = 0;
  const visit = (value, location) => {
    if (typeof value === 'string' && value.startsWith('/assets/')) {
      let assetPath;
      try {
        assetPath = decodeURIComponent(value.split(/[?#]/, 1)[0]);
      } catch {
        throw new Error(`Invalid encoded asset URL in ${relativePath}:${location}`);
      }
      const relativeAsset = assetPath.replace(/^\/+/, '');
      const absoluteAsset = path.resolve(publicRoot, relativeAsset);
      const relativeToPublic = path.relative(publicRoot, absoluteAsset);
      assert(relativeToPublic && !relativeToPublic.startsWith('..') && !path.isAbsolute(relativeToPublic),
        `Asset URL escapes public root: ${relativePath}:${location}`);
      assert(fs.existsSync(absoluteAsset), `Missing asset: ${relativePath}:${location} -> ${value}`);
      const stat = fs.statSync(absoluteAsset);
      assert(stat.isFile() && stat.size > 0, `Empty asset: ${relativePath}:${location} -> ${value}`);
      checked += 1;
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) visit(child, `${location}.${key}`);
  };
  visit(document, '$');
  return checked;
}

function validate(root = path.resolve(__dirname, '..')) {
  const projectRoot = path.resolve(root);
  const protocol = readProtocol(projectRoot);
  assert(Number.isSafeInteger(protocol.protocolVersion) && protocol.protocolVersion > 0,
    'PROTOCOL_VERSION must be a positive integer');
  assert(protocol.contentVersion, 'CONTENT_VERSION must not be empty');

  const documents = Object.fromEntries(REQUIRED_JSON.map(relativePath => [
    relativePath,
    readJson(projectRoot, relativePath),
  ]));
  const manifest = documents['client/public-tms273/assets/manifest.json'];
  const sharedGameplay = documents['shared/gameplay.json'];
  const publicGameplay = documents['client/public-tms273/assets/gameplay.json'];
  const sharedItems = documents['shared/items.json'];
  const publicItems = documents['client/public-tms273/assets/items.json'];
  const creation = documents['shared/character-creation.json'];
  assert.deepEqual(documents['client/public-tms273/assets/entry/creation.json'], creation);
  require('./tms273_creation_catalog.cjs')(creation, sharedItems, 'shared/items.json');
  const mapCatalog = documents['shared/maps.json'];

  assert.equal(manifest.contentVersion, protocol.contentVersion,
    'client manifest contentVersion does not match shared/protocol.ts');
  assert.equal(sharedGameplay.contentVersion, protocol.contentVersion,
    'shared/gameplay.json contentVersion does not match shared/protocol.ts');
  assert.equal(publicGameplay.contentVersion, protocol.contentVersion,
    'public gameplay contentVersion does not match shared/protocol.ts');
  assert.deepEqual(publicGameplay, sharedGameplay,
    'client/public-tms273/assets/gameplay.json is stale; rebuild the resource export');
  assert.deepEqual(publicItems, sharedItems,
    'client/public-tms273/assets/items.json is stale; rebuild the resource export');
  assert.equal(manifest.map?.id, mapCatalog.birthMapId,
    'client manifest birth map does not match shared/maps.json');
  assert.equal(manifest.mapCatalog?.maps?.length, mapCatalog.maps?.length,
    'client manifest map catalog does not match shared/maps.json');

  const publicRoot = path.join(projectRoot, 'client', 'public-tms273');
  const checkedAssets = ASSET_REFERENCE_JSON.reduce(
    (count, relativePath) => count + checkAssetReferences(projectRoot, relativePath, publicRoot),
    0,
  );
  const windbell = windbellBundle.validate(projectRoot);
  const colossus = require('./check_colossus_bundle.cjs').validate(projectRoot);
  return {
    protocolVersion: protocol.protocolVersion,
    contentVersion: protocol.contentVersion,
    checkedFiles: REQUIRED_JSON.length,
    checkedAssets,
    windbell,
    colossus,
    mapCount: mapCatalog.maps.length,
  };
}

function main(root = process.argv[2] || path.resolve(__dirname, '..')) {
  const result = validate(root);
  console.log(`Windows runtime resources: protocol ${result.protocolVersion}, ${result.contentVersion}; ${result.checkedFiles} JSON files and ${result.checkedAssets} asset references checked; ${result.mapCount} maps.`);
  console.log(`Windbell bundle: ${result.windbell.files} ledgered files (${(result.windbell.bytes / 1024 / 1024).toFixed(1)}MB) + ${result.windbell.catalogFrames} TMS273 frames checked.`);
  return result;
}

if (require.main === module) main();

module.exports = { main, validate };
