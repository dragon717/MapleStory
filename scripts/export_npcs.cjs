// Npc/shop asset export for the rendered npc set. Reads references/gameplay-assets/manifest.json,
// appends npcs / shopUi / dialogUi keys and 17 shop item icons, then writes back. Safe against the
// running client: only adds keys the client treats as optional.
//
// Faster than the first attempt: raw decoded-bitmap length assertion instead of a per-PNG ffmpeg
// decode, and per-NPC/UI progress lines so slow steps are visible.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const wz = require('../参考/tools/wz-audit/node_modules/@tybys/wz');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'references/gameplay-assets');
const archives = new Map(), images = new Map(), pngs = new Map();
const children = n => [...(n?.wzProperties || [])];
const at = (n, key) => n?.at?.(key);
const value = (n, key) => at(n, key)?.wzValue;
const vec = n => n?.wzValue && Number.isFinite(n.wzValue.x) ? { x: n.wzValue.x, y: n.wzValue.y } : null;

const NPC_IDS = ['2000', '2001', '2002', '2003', '2004', '2005', '2100', '2101', '2102', '2103',
  '10000', '10200', '10201', '10202', '10203', '10204', '11000', '11100', '12000', '12100',
  '12101', '20001', '20002', '20100', '21000', '22000', '9000000', '9010000'];
const NPC_NAMES = {
  2000: 'Roger', 2001: 'Sen', 2002: 'Peter', 2003: 'Robin', 2004: 'Todd', 2005: 'Sam',
  2100: 'Sera', 2101: 'Heena', 2102: 'Nina', 2103: 'Maria', 10000: 'Pio',
  10200: 'Athena Pierce', 10201: 'Grendel the Really Old', 10202: 'Dances with Balrog',
  10203: 'Dark Lord', 10204: 'Kyrin', 11000: 'Sid', 11100: 'Lucy', 12000: 'Lucas',
  12100: 'Mai', 12101: 'Rain', 20001: 'Bari', 20002: 'Biggs', 20100: 'Yoona',
  21000: 'Pan', 22000: 'Shanks', 9000000: 'Paul', 9010000: 'Maple Administrator',
};
const SHOP_ITEMS = {
  1332005: 'Character.wz/Weapon/01332005.img/info/icon',
  1072001: 'Character.wz/Shoes/01072001.img/info/icon',
  1061008: 'Character.wz/Pants/01061008.img/info/icon',
  1061002: 'Character.wz/Pants/01061002.img/info/icon',
  1060006: 'Character.wz/Pants/01060006.img/info/icon',
  1060002: 'Character.wz/Pants/01060002.img/info/icon',
  1041011: 'Character.wz/Coat/01041011.img/info/icon',
  1041010: 'Character.wz/Coat/01041010.img/info/icon',
  1041006: 'Character.wz/Coat/01041006.img/info/icon',
  1041002: 'Character.wz/Coat/01041002.img/info/icon',
  1040010: 'Character.wz/Coat/01040010.img/info/icon',
  1040006: 'Character.wz/Coat/01040006.img/info/icon',
  1040002: 'Character.wz/Coat/01040002.img/info/icon',
  2010002: 'Item.wz/Consume/0201.img/02010002/info/icon',
  2010000: 'Item.wz/Consume/0201.img/02010000/info/icon',
  2000002: 'Item.wz/Consume/0200.img/02000002/info/icon',
  2000001: 'Item.wz/Consume/0200.img/02000001/info/icon',
};
const SHOP_UI = 'UI.wz/UIWindow.img/Shop';
const DIALOG_UI = 'UI.wz/UIWindow.img/UtilDlgEx';

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
    // IHDR sits right after the 8-byte PNG signature (len 4 + 'IHDR' 4); width/height are big-endian.
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
    delay: value(raw, 'delay') ?? value(n, 'delay') ?? 100,
    map: Object.fromEntries(children(at(n, 'map')).map(p => [p.name, vec(p)])),
    lt: vec(at(n, 'lt')), rb: vec(at(n, 'rb')), head: vec(at(raw, 'head')) || vec(at(n, 'head')),
    uol: raw instanceof wz.WzUOLProperty ? raw.value : null };
}
async function flatCanvases(n, source, output, key = '') {
  const resolved = resolve(n);
  if (resolved instanceof wz.WzCanvasProperty) {
    log(`ui canvas ${key}`);
    output[key] = await png(n, source);
    return;
  }
  for (const c of children(resolved)) await flatCanvases(c, source + '/' + c.name, output, key ? key + '/' + c.name : c.name);
}
const log = m => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

(async () => {
  const manifestPath = path.join(out, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const npcs = {};
  for (const id of NPC_IDS) {
    const t = Date.now();
    const source = `Npc.wz/${id.padStart(7, '0')}.img`;
    const image = await node(source);
    const stand = at(image, 'stand');
    const frames = [];
    if (stand) {
      // Serial decode only: wz canvas decode is not re-entrant for frames of the
      // same img — Promise.all on a multi-frame stand hangs the process.
      for (const frame of children(stand).filter(n => /^\d+$/.test(n.name)).sort((a, b) => +a.name - +b.name)) {
        frames.push(await png(frame, `${source}/stand/${frame.name}`));
      }
    }
    npcs[id] = { name: NPC_NAMES[id], source, stand: frames };
    log(`npc ${id} ${NPC_NAMES[id]} frames=${frames.length} (${Date.now() - t}ms)`);
  }

  for (const [itemId, source] of Object.entries(SHOP_ITEMS)) {
    const t = Date.now();
    const icon = await png(await node(source), source);
    manifest.items[itemId] = icon;
    log(`item ${itemId} ${icon.width}x${icon.height} (${Date.now() - t}ms)`);
  }

  const shopUi = {}; await flatCanvases(await node(SHOP_UI), SHOP_UI, shopUi);
  log(`shopUi canvases=${Object.keys(shopUi).length}`);
  const dialogUi = {}; await flatCanvases(await node(DIALOG_UI), DIALOG_UI, dialogUi);
  log(`dialogUi canvases=${Object.keys(dialogUi).length}`);

  manifest.npcs = npcs;
  manifest.shopUi = shopUi;
  manifest.dialogUi = dialogUi;
  manifest.contentVersion = 'gms83-npc-1';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  for (const a of archives.values()) a.dispose();
  log(JSON.stringify({
    npcs: Object.keys(npcs).length,
    npcFrames: Object.values(npcs).reduce((total, npc) => total + npc.stand.length, 0),
    npcsWithoutStand: Object.entries(npcs).filter(([, npc]) => !npc.stand.length).map(([id]) => id),
    shopItems: Object.keys(SHOP_ITEMS).length,
    shopUi: Object.keys(shopUi), dialogUi: Object.keys(dialogUi),
    newPngs: pngs.size,
  }, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; });
