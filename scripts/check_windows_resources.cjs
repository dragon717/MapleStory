const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_JSON = [
  'shared/gameplay.json',
  'shared/map.json',
  'shared/maps.json',
  'shared/mage-skills.json',
  'shared/quest-text.json',
  'shared/npc-names.json',
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
  return {
    protocolVersion: protocol.protocolVersion,
    contentVersion: protocol.contentVersion,
    checkedFiles: REQUIRED_JSON.length,
    checkedAssets,
    mapCount: mapCatalog.maps.length,
  };
}

function main(root = process.argv[2] || path.resolve(__dirname, '..')) {
  const result = validate(root);
  console.log(`Windows runtime resources: protocol ${result.protocolVersion}, ${result.contentVersion}; ${result.checkedFiles} JSON files and ${result.checkedAssets} asset references checked; ${result.mapCount} maps.`);
  return result;
}

if (require.main === module) main();

module.exports = { main, validate };
