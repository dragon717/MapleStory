// Portal sprite export: per map, look up the source-backed portal effect in
// Map.wz/MapHelper.img/portal/game/{pv,ph,psh}/N. The WZ editor sprites under
// portal/editor/ are map-editor diagnostics (red rectangle + yellow arrow)
// and are intentionally not used here. Mirrors scripts/export_npcs.cjs safety
// rules (serial decode, PNG IHDR dimension check).
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

// v83's in-game portal effects live in Map.wz/MapHelper.img/portal/game/.
// pv (portable visual, "visible portal beam"), ph (hidden), psh (script hidden).
// game/pv is an animation of 8 frames; ph/psh are single-frame on the default
// sub-key plus psh which animates over 4 stages. Each portal record keeps a
// `frames` array so the client can render either as a static image or cycle
// through the animation with a single code path.
function gameKey(pt) {
  if (pt === 0) return 'ph';
  if (pt === 1 || pt === 2 || pt === 7 || pt === 8 || pt === 10 || pt === 11) return 'pv';
  if (pt === 9) return 'psh';
  return 'pv';
}
const FRAME_DELAY_MS = 100;
const MAX_ANIMATION_FRAMES = 8;

(async () => {
  const manifestPath = path.join(out, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const mapsCatalog = JSON.parse(fs.readFileSync(path.join(root, 'shared/maps.json'), 'utf8'));

  const gameLib = await node('Map.wz/MapHelper.img/portal/game');
  // Materialise the game portal library once. ph/psh wrap their canvas inside a
  // WzSubProperty (game/ph/default, game/psh/{default,1,2,3,4}); pv holds the
  // canvases directly. Recurse to collect every WzCanvasProperty descendant
  // and dedupe by fullPath so UOL links to pv/ph frames are not duplicated.
  const gameCache = new Map();
  function collectCanvases(root, out) {
    for (const child of children(root)) {
      const node = child instanceof wz.WzUOLProperty ? child.linkValue : child;
      if (node instanceof wz.WzCanvasProperty) out.push(node);
      else if (node instanceof wz.WzImage || node instanceof wz.WzSubProperty) collectCanvases(node, out);
    }
    return out;
  }
  for (const spriteNode of children(gameLib)) {
    const canvasList = collectCanvases(spriteNode, []);
    const seen = new Set();
    const dedup = canvasList.filter(c => {
      const key = c.fullPath.match(/[^/]+\.wz\/.*/)[0];
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    dedup.sort((a, b) => a.fullPath.localeCompare(b.fullPath, undefined, { numeric: true }));
    gameCache.set(spriteNode.name, dedup);
  }
  log(`MapHelper.portal.game sprites: ${[...gameCache.keys()].map(k => `${k}(${gameCache.get(k).length})`).join(',')}`);
  if (!gameCache.has('pv') || !gameCache.has('ph') || !gameCache.has('psh')) {
    log('FATAL: game/{pv,ph,psh} missing; aborting'); process.exitCode = 2; return;
  }

  const portals = {};
  let count = 0, missing = 0;
  for (const map of mapsCatalog.maps) {
    for (const portal of (map.portals ?? [])) {
      const key = gameKey(portal.type);
      const canvasList = gameCache.get(key);
      if (!canvasList?.length) { missing++; log(`portal ${map.id}/${portal.name} pt=${portal.type} NO GAME FRAMES`); continue; }
      try {
        const t = Date.now();
        const frames = [];
        for (const canvas of canvasList) {
          const frame = await png(canvas, `Map.wz/MapHelper.img/portal/game/${key}`);
          frames.push({ ...frame, delay: FRAME_DELAY_MS });
          if (frames.length >= MAX_ANIMATION_FRAMES) break;
        }
        const first = frames[0];
        portals[`${map.id}/${portal.name}`] = {
          mapId: map.id, portalName: portal.name,
          spriteKey: key,
          type: portal.type,
          // first frame metadata kept at top level for any caller that only
          // needs the static fallback (it matches the editor/pv size).
          url: first.url, width: first.width, height: first.height,
          origin: first.origin, x: first.x, y: first.y,
          frames,
          frameDelay: FRAME_DELAY_MS,
          source: `Map.wz/MapHelper.img/portal/game/${key}`,
        };
        count++;
        log(`portal ${map.id}/${portal.name} pt=${portal.type} -> game/${key} (${frames.length} frames, ${Date.now() - t}ms)`);
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