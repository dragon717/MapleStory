// Dump TMS273 WZ image trees back into the typed-JSON layout that
// `import_tms273.py` consumes (`Map/Map/Map<digit>/<id>.json`).
//
// The unpacked `WZ_JSON_TW/Map/Map/Map*` tree is not part of the current
// checkout, so map metadata cannot be re-imported from it.  This dumper
// restores the exact same typed shape (`{_dirType,_value}` wrappers, `sub`
// containers, `vector` `_x`/`_y`) from the real TMS273.7 WZ archives, so new
// maps can still be added with source-backed metadata instead of hand-written
// records.
//
// Usage:
//   node scripts/dump_tms273_wz_json.cjs --out DIR Map/Map/Map1/104000001.img ...
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const wz = require('@tybys/wz');
const { createReader } = require('./tms273_wz.cjs');

const root = path.resolve(__dirname, '..');
const data = path.join(root, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');

function numericString(value) {
  assert(Number.isFinite(value), `non-finite WZ number: ${value}`);
  return String(value);
}

function typedProperty(property) {
  const children = [...(property.wzProperties ?? [])];
  if (property instanceof wz.WzSubProperty || property instanceof wz.WzConvexProperty) {
    const node = { _dirType: property instanceof wz.WzConvexProperty ? 'convex' : 'sub' };
    for (const child of children) node[child.name] = typedProperty(child);
    return node;
  }
  if (property instanceof wz.WzVectorProperty) {
    // Most vectors expose `value:{x,y}` once parsed, but town maps carry
    // `seat` vectors whose `value` stays undefined while the child
    // `x`/`y` int properties hold the real coordinates (e.g. 玩具城
    // seat/0 = -438,102).  Fall back to those children instead of refusing
    // the whole image; the unpacked-tree contract only cares about shape.
    const value = property.value;
    const x = value && Number.isFinite(value.x) ? value.x : property.x?.val;
    const y = value && Number.isFinite(value.y) ? value.y : property.y?.val;
    assert(Number.isFinite(x) && Number.isFinite(y), `invalid vector: ${property.fullPath}`);
    return { _dirType: 'vector', _x: x, _y: y };
  }
  // `miniMap/canvas` holds a rendered minimap bitmap.  The unpacked tree that
  // `import_tms273.py` consumes carries no canvas payloads at all — every
  // existing `WZ_JSON_TW/Map/Map/**` map stores this node as `{_dirType:"null"}`
  // — so mirror that shape instead of refusing the whole image.
  if (property instanceof wz.WzCanvasProperty) return { _dirType: 'null' };
  if (property instanceof wz.WzUOLProperty) return { _dirType: 'uol', _value: String(property.value ?? '') };
  if (property instanceof wz.WzNullProperty) return { _dirType: 'null' };
  if (property instanceof wz.WzStringProperty) return { _dirType: 'string', _value: String(property.value ?? '') };
  if (property instanceof wz.WzIntProperty) return { _dirType: 'int', _value: numericString(property.value) };
  if (property instanceof wz.WzShortProperty) return { _dirType: 'short', _value: numericString(property.value) };
  if (property instanceof wz.WzLongProperty) return { _dirType: 'long', _value: numericString(property.value) };
  if (property instanceof wz.WzFloatProperty) return { _dirType: 'float', _value: numericString(property.value) };
  if (property instanceof wz.WzDoubleProperty) return { _dirType: 'double', _value: numericString(property.value) };
  // Maps carry no lua/binary/sound nodes beyond the canvas handled above.
  // Refuse to invent a shape for anything else rather than silently dropping
  // source data.
  throw new Error(`unsupported WZ property for typed JSON: ${property.propertyType} ${property.fullPath}`);
}

async function dump(reader, imagePath, outRoot) {
  const image = await reader.get(imagePath);
  if (typeof image.parseImage === 'function' && !image.parsed) await image.parseImage();
  assert(image instanceof wz.WzImage, `not a WZ image: ${imagePath}`);
  const tree = {};
  for (const child of [...image.wzProperties]) tree[child.name] = typedProperty(child);
  // `import_tms273.py` addresses the unpacked tree as `.../Map1/<id>.json`,
  // i.e. without the `.img` suffix used by the WZ logical path.
  const target = path.join(outRoot, `${imagePath.replace(/\.img$/i, '')}.json`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(tree) + '\n', 'utf8');
  return { imagePath, target, properties: Object.keys(tree).length };
}

async function main() {
  const argv = process.argv.slice(2);
  const outIndex = argv.indexOf('--out');
  assert(outIndex >= 0 && argv[outIndex + 1], 'missing --out DIR');
  const outRoot = path.resolve(argv[outIndex + 1]);
  const images = argv.filter((value, index) => value !== '--out' && index !== outIndex + 1);
  assert(images.length, 'no WZ images requested');
  const reader = createReader(data, '/tmp/tms273-wz-json');
  try {
    const done = [];
    for (const image of images) done.push(await dump(reader, image, outRoot));
    console.log(JSON.stringify({ outRoot, done }, null, 2));
  } finally {
    reader.close();
  }
}

if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = { typedProperty };
