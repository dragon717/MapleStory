// Portal sprite export: per map, look up the shared editor portal sprite keyed
// by the portal's `pt` type, and add a small render manifest entry that the
// client portal view consumes. Mirrors scripts/export_npcs.cjs safety rules
// (serial decode, PNG IHDR dimension check).
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const wz = require('../参考/tools/wz-audit/node_modules/@tybys/wz');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'references/gameplay-assets');
const archives = new Map(), images = new Map(), pngs = new Map();
const children = n => [...(n?.wzProperties || [])];
const at = (n, key) => n?.at?.(key);
const vec = n => n?.wzValue && Number.isFinite(n.wzValue.x) ? { x: n.wzValue.x, y: n.wzValue.y } : null;

async function node(source) {
  const [file, ...segments] = source.split('/');
  if (!archives.has(file)) {
    const a = new wz.WzFile(path.join(root, '参考/assets/gms83/83', file), wz.WzMapleVersion.GMS, 83);
    const st = await a.parseWzFile();
    assert.equal(st, wz.WzFileParseStatus.SUCCESS, `${file} parse status`);
    archives.set(file, a);
  }
  let n = archives.get(file).wzDirectory;
  for (const segment of segments) {
    n = at(n, segment);
    assert(n, `${source} (at ${segment})`);
    if (segment.endsWith('.img') && !images.has(n.fullPath)) {
      assert(await n.parseImage(), `${source} parseImage`);
      images.set(n.fullPath, n);
    }
  }
  return n;
}
function resolve(n, seen = new Set()) {
  assert(!seen.has(n), 'UOL cycle');
  seen.add(n);
  return n instanceof wz.WzUOLProperty ? resolve(n.linkValue, seen) : n;
}
async function png(raw, source) {
  const n = resolve(raw);
  assert(n instanceof wz.WzCanvasProperty, source);
  const resolvedSource = n.fullPath.match(/[^/]+\.wz\/.*/)[0];
  if (!pngs.has(resolvedSource)) {
    const bitmap = await n.getBitmap();
    assert(bitmap, `${resolvedSource} no bitmap`);
    const bytes = Buffer.from(await bitmap.getBufferAsync('image/png'));
    assert(bytes.length > 24, `${resolvedSource} png too short`);
    assert.equal(bytes.readUInt32BE(16), n.pngProperty.width, `${resolvedSource} IHDR width`);
    assert.equal(bytes.readUInt32BE(20), n.pngProperty.height, `${resolvedSource} IHDR height`);
    const name = resolvedSource.replace(/[^A-Za-z0-9_.-]/g, '_') + '.png', target = path.join(out, 'assets', name);
    fs.writeFileSync(target, bytes);
    pngs.set(resolvedSource, { url: 'assets/' + name, width: n.pngProperty.width, height: n.pngProperty.height,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'), rgbaDecodeOk: true });
  }
  const origin = vec(at(raw, 'origin')) || vec(at(n, 'origin')) || { x: 0, y: 0 };
  return { ...pngs.get(resolvedSource), source, resolvedSource, origin, x: -origin.x, y: -origin.y,
    delay: 0,
    map: Object.fromEntries(children(at(n, 'map')).map(p => [p.name, vec(p)])),
    lt: vec(at(n, 'lt')), rb: vec(at(n, 'rb')), head: vec(at(raw, 'head')) || vec(at(n, 'head')),
    uol: raw instanceof wz.WzUOLProperty ? raw.value : null };
}
const log = m => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

// Map portal `pt` type to MapHelper.img/portal/editor/{key} sub-name.
// v83 sprite keys observed: sp, pi, pv, pc, pg, tp, ps, pgi, psi, pcs, ph, psh, pcj, pci, pcig.
// pt=0 (hidden/spawn) -> sp; pt>=2 (regular interactive) -> pv; the rest fall back to pv.
function editorKey(pt) {
  if (pt === 0) return 'sp';
  return 'pv';
}

(async () => {
  const manifestPath = path.join(out, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const mapsCatalog = JSON.parse(fs.readFileSync(path.join(root, 'shared/maps.json'), 'utf8'));

  // Materialise the editor portal library once.
  const editorLib = await node('Map.wz/MapHelper.img/portal/editor');
  const spriteCache = new Map();
  for (const spriteNode of children(editorLib)) {
    const canvas = spriteNode instanceof wz.WzUOLProperty ? spriteNode.linkValue : spriteNode;
    if (!(canvas instanceof wz.WzCanvasProperty)) continue;
    spriteCache.set(spriteNode.name, canvas);
  }
  log(`MapHelper.portal.editor sprites: ${[...spriteCache.keys()].join(',')}`);
  if (!spriteCache.has('pv')) {
    log('FATAL: editor/pv not present; aborting'); process.exitCode = 2; return;
  }

  const portals = {};
  let count = 0, missing = 0;
  for (const map of mapsCatalog.maps) {
    for (const portal of (map.portals ?? [])) {
      if (portal.type === 9) continue; // scripted portals (tutorial, etc.) reuse the editor's pv sprite anyway
      const key = editorKey(portal.type);
      const spriteNode = spriteCache.get(key) ?? spriteCache.get('pv');
      try {
        const t = Date.now();
        const frame = await png(spriteNode, `Map.wz/MapHelper.img/portal/editor/${key}`);
        portals[`${map.id}/${portal.name}`] = { ...frame, mapId: map.id, portalName: portal.name,
          x: portal.x, y: portal.y, type: portal.type, spriteKey: key };
        count++;
        log(`portal ${map.id}/${portal.name} pt=${portal.type} -> ${key} (${Date.now() - t}ms)`);
      } catch (error) {
        missing++;
        log(`portal ${map.id}/${portal.name} pt=${portal.type} FAIL ${String(error.message || error).slice(0, 80)}`);
      }
    }
  }
  manifest.portals = portals;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  for (const a of archives.values()) a.dispose();
  log(JSON.stringify({ portals: count, missing, samples: Object.keys(portals).slice(0, 6) }, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; });