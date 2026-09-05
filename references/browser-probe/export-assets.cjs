// Export a small, real GMS83 paper-doll/map sample for the browser probe.
// The browser consumes PNGs plus this source-derived metadata; it does not fake WZ data.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const wz = require('../tools/wz-audit/node_modules/@tybys/wz');

const root = path.resolve(__dirname, '../..');
const wzRoot = path.join(root, '参考/assets/gms83/83');
const out = process.env.WZ_EXPORT_OUT ? path.resolve(process.env.WZ_EXPORT_OUT) : __dirname;
const assetOut = path.join(out, 'assets');
const actions = { stand: 'stand1', walk: 'walk1', jump: 'jump', attack: 'swingO1' };
if (process.env.WZ_CLIMB === '1') Object.assign(actions, { ladder: 'ladder', rope: 'rope', dead: 'dead' });
const look = {
  body: '00002000.img',
  head: '00012000.img',
  face: ['Face', '00020000.img'],
  hair: ['Hair', '00030020.img'],
  cap: ['Cap', '01000001.img'],
  coat: ['Coat', '01040002.img'],
  pants: ['Pants', '01060003.img'],
  shoes: ['Shoes', '01070000.img'],
  weapon: ['Weapon', process.env.WZ_WEAPON || '01302029.img'],
};

const type = n => wz.WzPropertyType[n.propertyType] || n.constructor.name;
const kids = n => [...(n?.wzProperties || [])];
const at = (n, name) => n?.at?.(name) || null;
const value = n => n?.wzValue;
const prop = (n, name) => value(at(n, name));
const vector = n => {
  const v = value(n);
  return v && Number.isFinite(v.x) && Number.isFinite(v.y) ? { x: v.x, y: v.y } : null;
};
const childVector = (n, name) => vector(at(n, name));
const source = (n, file) => `${file}/${n.fullPath.split(`${file}/`).pop()}`;
const numericChildren = n => kids(n).filter(c => /^\d+$/.test(c.name)).sort((a, b) => Number(a.name) - Number(b.name));

function mapOf(n) {
  const m = at(n, 'map');
  return Object.fromEntries(kids(m).map(p => [p.name, vector(p)]).filter(([, v]) => v));
}

function stringMap(n) {
  return Object.fromEntries(kids(n).map(p => [p.name, value(p)]).filter(([, v]) => typeof v === 'string'));
}

function canvasBranch(n, raw = n) {
  if (!n) return null;
  if (n instanceof wz.WzUOLProperty) {
    assert(n.linkValue, `Unresolved UOL: ${n.fullPath}`);
    return canvasBranch(n.linkValue, raw);
  }
  if (n instanceof wz.WzCanvasProperty) return { node: n, raw };
  for (const c of kids(n)) {
    if (['map', 'foothold'].includes(c.name)) continue;
    const found = canvasBranch(c, raw instanceof wz.WzUOLProperty ? raw : c);
    if (found) return found;
  }
  return null;
}

function collectBranches(n, part, outList = []) {
  if (n instanceof wz.WzCanvasProperty || n instanceof wz.WzUOLProperty) {
    const found = canvasBranch(n, n);
    if (found) outList.push({ part, name: n.name || part, ...found });
    return outList;
  }
  for (const c of kids(n)) {
    if (['delay', 'face', 'action', 'frame', 'map', 'foothold'].includes(c.name)) continue;
    const found = canvasBranch(c, c);
    if (found) outList.push({ part, name: c.name, ...found });
  }
  return outList;
}

function actionFrame(img, action, frame) {
  const exact = at(at(img, action), String(frame));
  if (exact) return exact;
  const fallback = at(at(img, 'default'), String(frame)) || at(at(img, 'default'), '0');
  return fallback;
}

function layerMeta(branch, file) {
  const raw = branch.raw;
  const resolved = branch.node;
  const origin = vector(at(raw, 'origin')) || vector(at(resolved, 'origin')) || { x: 0, y: 0 };
  const map = mapOf(raw);
  const resolvedMap = Object.keys(map).length ? map : mapOf(resolved);
  const zValue = prop(raw, 'z') ?? prop(resolved, 'z') ?? branch.name;
  const zName = typeof zValue === 'string' ? zValue : String(zValue);
  return { raw, resolved, origin, map: resolvedMap, zName, zValue };
}

function charAnchorFor(branches) {
  const body = branches.find(x => x.part === 'body' && x.name === 'body');
  assert(body, 'body Canvas missing');
  const b = layerMeta(body, 'Character.wz');
  const bnavel = b.map.navel || { x: 0, y: 0 };
  const bneck = b.map.neck || { x: 0, y: 0 };
  const arm = branches.find(x => x.part === 'body' && x.name === 'arm');
  const a = arm ? layerMeta(arm, 'Character.wz') : null;
  const hand = a?.map.hand && a.map.navel
    ? { x: bnavel.x - a.map.navel.x + a.map.hand.x, y: bnavel.y - a.map.navel.y + a.map.hand.y }
    : bnavel;
  const head = branches.find(x => x.part === 'head');
  const h = head ? layerMeta(head, 'Character.wz') : null;
  const brow = h?.map.neck && h.map.brow
    ? { x: bneck.x - h.map.neck.x + h.map.brow.x, y: bneck.y - h.map.neck.y + h.map.brow.y }
    : bneck;
  return { navel: bnavel, neck: bneck, hand, brow };
}

function targetFor(anchors, map) {
  for (const name of ['navel', 'hand', 'brow', 'neck']) {
    if (map[name]) return { target: anchors[name], own: map[name], anchor: name };
  }
  return { target: anchors.navel, own: { x: 0, y: 0 }, anchor: 'navel-fallback' };
}

function pngName(sourcePath) {
  return sourcePath.replace(/[^A-Za-z0-9_.-]+/g, '_') + '.png';
}

const pngCache = new Map();
async function exportPng(branch, file) {
  const resolvedSource = source(branch.node, file);
  if (pngCache.has(resolvedSource)) return pngCache.get(resolvedSource);
  const bitmap = await branch.node.getBitmap();
  assert(bitmap, `Canvas did not decode: ${resolvedSource}`);
  const png = Buffer.from(await bitmap.getBufferAsync('image/png'));
  const fileName = pngName(resolvedSource);
  const target = path.join(assetOut, fileName);
  fs.writeFileSync(target, png);
  const check = spawnSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-i', target, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 64 * 1024 * 1024 });
  assert.equal(check.status, 0, String(check.stderr));
  assert.equal(check.stdout.length, branch.node.pngProperty.width * branch.node.pngProperty.height * 4);
  const result = { url: `assets/${fileName}`, width: branch.node.pngProperty.width, height: branch.node.pngProperty.height, sha256: crypto.createHash('sha256').update(png).digest('hex'), rgbaDecodeOk: true };
  pngCache.set(resolvedSource, result);
  return result;
}

async function exportPart(branch, file, zmap, anchors) {
  const m = layerMeta(branch, file);
  const { target, own, anchor } = targetFor(anchors, m.map);
  const png = await exportPng(branch, file);
  const z = zmap.has(m.zName) ? zmap.get(m.zName) : zmap.size;
  return {
    key: png.url.slice('assets/'.length),
    part: branch.part,
    source: source(m.raw, file),
    resolvedSource: source(m.resolved, file),
    uol: m.raw instanceof wz.WzUOLProperty ? m.raw.value : null,
    url: png.url,
    width: png.width,
    height: png.height,
    x: target.x - own.x - m.origin.x,
    y: target.y - own.y - m.origin.y,
    origin: m.origin,
    map: m.map,
    anchor,
    z,
    zName: m.zName,
    sha256: png.sha256,
    rgbaDecodeOk: png.rgbaDecodeOk,
  };
}

function scalar(n, name, fallback = null) {
  const v = prop(n, name);
  return v === undefined ? fallback : v;
}

async function mapData(mapArchive, zmap) {
  const mapImg = at(at(at(mapArchive.wzDirectory, 'Map'), 'Map0'), '000010000.img');
  assert(mapImg && await mapImg.parseImage());
  const info = at(mapImg, 'info');
  const backRoot = at(at(mapArchive.wzDirectory, 'Back'), 'grassySoil.img');
  assert(backRoot && await backRoot.parseImage());
  const layers = [];
  for (const b of kids(at(mapImg, 'back'))) {
    const no = scalar(b, 'no', Number(b.name));
    const bs = scalar(b, 'bS', 'grassySoil');
    if (bs !== 'grassySoil') continue;
    const branch = canvasBranch(at(at(backRoot, 'back'), String(no)));
    if (!branch) continue;
    const png = await exportPng(branch, 'Map.wz/Back/grassySoil.img');
    const origin = vector(at(branch.node, 'origin')) || { x: 0, y: 0 };
    const z = scalar(branch.node, 'z', 0);
    layers.push({
      key: `back-${no}`,
      source: source(branch.node, 'Map.wz'),
      url: png.url,
      x: scalar(b, 'x', 0) - origin.x,
      y: scalar(b, 'y', 0) - origin.y,
      origin,
      width: png.width,
      height: png.height,
      depth: z,
      alpha: scalar(b, 'a', 255),
      type: scalar(b, 'type', 0),
      background: Object.fromEntries(['x', 'y', 'rx', 'ry', 'cx', 'cy', 'type', 'front', 'ani', 'f'].map(name => [name, scalar(b, name, 0)])),
    });
  }
  const footholds = [];
  function walk(n, p = []) {
    if (!n) return;
    const x1 = scalar(n, 'x1');
    const y1 = scalar(n, 'y1');
    const x2 = scalar(n, 'x2');
    const y2 = scalar(n, 'y2');
    if ([x1, y1, x2, y2].every(Number.isFinite)) footholds.push({ id: Number(p.at(-1)), path: p.join('/'), x1, y1, x2, y2, prev: scalar(n, 'prev', 0), next: scalar(n, 'next', 0), forbidFallDown: scalar(n, 'forbidFallDown', 0) });
    for (const c of kids(n)) walk(c, [...p, c.name]);
  }
  walk(at(mapImg, 'foothold'), ['foothold']);
  const tileRoot = at(at(mapArchive.wzDirectory, 'Tile'), 'grassySoil.img');
  assert(tileRoot && await tileRoot.parseImage());
  const tileLayers = [];
  const objectLayers = [];
  const parsedMapImages = new Set();
  async function parsedImage(group, name) {
    const img = at(at(mapArchive.wzDirectory, group), name);
    assert(img, `Missing ${group}/${name}`);
    if (!parsedMapImages.has(`${group}/${name}`)) { assert(await img.parseImage()); parsedMapImages.add(`${group}/${name}`); }
    return img;
  }
  for (const layer of numericChildren(mapImg)) {
    const layerInfo = at(layer, 'info');
    const tileset = prop(layerInfo, 'tS');
    if (tileset) {
      const tileSetImg = await parsedImage('Tile', `${tileset}.img`);
      for (const t of kids(at(layer, 'tile'))) {
        const tv = Object.fromEntries(kids(t).map(p => [p.name, value(p)]));
        const node = at(at(tileSetImg, tv.u), String(tv.no));
        if (!node) continue;
        const branch = canvasBranch(node);
        if (!branch) continue;
        const png = await exportPng(branch, 'Map.wz/Tile');
        const origin = vector(at(branch.node, 'origin')) || { x: 0, y: 0 };
        tileLayers.push({ key: `tile-${layer.name}-${t.name}`, source: source(branch.raw, 'Map.wz'), resolvedSource: source(branch.node, 'Map.wz'), url: png.url, x: tv.x - origin.x, y: tv.y - origin.y, origin, width: png.width, height: png.height, depth: Number(layer.name) * 100 + (tv.zM || 0) * 10 + Number(prop(branch.node, 'z') || 0), flip: Boolean(tv.f), mapTile: { layer: Number(layer.name), x: tv.x, y: tv.y, u: tv.u, no: tv.no, zM: tv.zM } });
      }
    }
    for (const o of kids(at(layer, 'obj'))) {
      const ov = Object.fromEntries(kids(o).map(p => [p.name, value(p)]));
      const objImg = await parsedImage('Obj', `${ov.oS}.img`);
      const node = at(at(at(objImg, ov.l0), ov.l1), ov.l2);
      if (!node) continue;
      const branch = canvasBranch(node);
      if (!branch) continue;
      const png = await exportPng(branch, 'Map.wz/Obj');
      const origin = vector(at(branch.node, 'origin')) || { x: 0, y: 0 };
      objectLayers.push({ key: `obj-${layer.name}-${o.name}`, source: source(branch.raw, 'Map.wz'), resolvedSource: source(branch.node, 'Map.wz'), url: png.url, x: ov.x - origin.x, y: ov.y - origin.y, origin, width: png.width, height: png.height, depth: Number(layer.name) * 100 + (ov.zM || 0) * 10 + (ov.z || 0), flip: Boolean(ov.f), mapObject: { layer: Number(layer.name), oS: ov.oS, l0: ov.l0, l1: ov.l1, l2: ov.l2, x: ov.x, y: ov.y, z: ov.z, zM: ov.zM } });
    }
  }
  const ground = tileLayers.find(t => t.mapTile.layer === 2 && t.mapTile.x === 675 && t.mapTile.y === 390 && t.mapTile.u === 'enH0' && t.mapTile.no === 0);
  const tileSample = ground ? { ...ground, key: 'ground-sample-enH0-0', foothold: { x1: 675, y1: 365, x2: 765, y2: 365, source: 'Map.wz/Map/Map0/000010000.img/foothold/2/1/19' } } : null;
  layers.push(...tileLayers, ...objectLayers);
  return {
    id: '000010000',
    name: 'Mushroom Village',
    source: 'Map.wz/Map/Map0/000010000.img',
    bounds: { xMin: scalar(info, 'VRLeft'), xMax: scalar(info, 'VRRight'), yMin: scalar(info, 'VRTop'), yMax: scalar(info, 'VRBottom') },
    bgm: scalar(info, 'bgm'),
    layers,
    footholds,
    spawn: { id: 'probe-a', x: 630, y: 365, foothold: 20, footholdPath: 'foothold/2/1/20', facing: -1 },
    spawns: [
      { id: 'probe-a', x: 630, y: 365, foothold: 20, footholdPath: 'foothold/2/1/20', facing: -1 },
      { id: 'probe-b', x: 1050, y: 365, foothold: 40, footholdPath: 'foothold/2/1/40', facing: 1 },
    ],
    tileSample,
    tileCount: tileLayers.length,
    objectCount: objectLayers.length,
  };
}

(async () => {
  fs.mkdirSync(assetOut, { recursive: true });
  for (const file of fs.readdirSync(assetOut)) {
    if (file.endsWith('.png')) fs.unlinkSync(path.join(assetOut, file));
  }
  await wz.init();
  const character = new wz.WzFile(path.join(wzRoot, 'Character.wz'), wz.WzMapleVersion.GMS, 83);
  const map = new wz.WzFile(path.join(wzRoot, 'Map.wz'), wz.WzMapleVersion.GMS, 83);
  assert.equal(await character.parseWzFile(), wz.WzFileParseStatus.SUCCESS);
  assert.equal(await map.parseWzFile(), wz.WzFileParseStatus.SUCCESS);
  const zmapImg = at(character.wzDirectory, '00002000.img');
  assert(zmapImg && await zmapImg.parseImage());
  const base = new wz.WzFile(path.join(wzRoot, 'Base.wz'), wz.WzMapleVersion.GMS, 83);
  assert.equal(await base.parseWzFile(), wz.WzFileParseStatus.SUCCESS);
  const zmapNode = at(base.wzDirectory, 'zmap.img');
  assert(zmapNode && await zmapNode.parseImage());
  const zmap = new Map(kids(zmapNode).map((p, i) => [p.name, i]));
  const smapNode = at(base.wzDirectory, 'smap.img');
  assert(smapNode && await smapNode.parseImage());
  const smap = stringMap(smapNode);
  const body = at(character.wzDirectory, look.body);
  const head = at(character.wzDirectory, look.head);
  assert(body && head && await body.parseImage() && await head.parseImage());
  const cap = at(at(character.wzDirectory, look.cap[0]), look.cap[1]);
  assert(cap && await cap.parseImage());
  const capInfo = at(cap, 'info');
  const capSlots = { islot: scalar(capInfo, 'islot'), vslot: scalar(capInfo, 'vslot') };
  const capVslot = typeof capSlots.vslot === 'string' ? capSlots.vslot : '';
  const avatarActions = {};
  const actionStats = {};
  for (const [publicAction, sourceAction] of Object.entries(actions)) {
    const frames = numericChildren(at(body, sourceAction));
    assert(frames.length, `Missing body action ${sourceAction}`);
    const outputFrames = [];
    for (const frameNode of frames) {
      const frame = Number(frameNode.name);
      const branches = collectBranches(at(body, sourceAction).at(String(frame)), 'body');
      collectBranches(actionFrame(head, sourceAction, frame), 'head', branches);
      for (const [part, segs] of Object.entries(look).filter(([p]) => !['body', 'head'].includes(p))) {
        if (part === 'face' && scalar(frameNode, 'face', 1) === 0) continue;
        const img = part === 'cap' ? cap : segs.length === 2 ? at(at(character.wzDirectory, segs[0]), segs[1]) : null;
        assert(img && await img.parseImage());
        const node = part === 'face' ? at(at(img, 'default'), 'face') : actionFrame(img, sourceAction, frame);
        collectBranches(node, part, branches);
      }
      const anchors = charAnchorFor(branches);
      const filteredParts = [];
      const drawableBranches = branches.filter(branch => {
        if (branch.part !== 'hair' || !capVslot) return true;
        const meta = layerMeta(branch, 'Character.wz');
        const slotCode = smap[meta.zName];
        if (typeof slotCode !== 'string' || !capVslot.includes(slotCode)) return true;
        filteredParts.push({
          part: branch.part,
          name: branch.name,
          source: source(branch.raw, 'Character.wz'),
          resolvedSource: source(branch.node, 'Character.wz'),
          zName: meta.zName,
          slotCode,
          cap: look.cap[1],
          vslot: capVslot,
          rule: `Base.wz/smap.img/${meta.zName}=${slotCode}; ${look.cap[1]}/info/vslot contains ${slotCode}`,
        });
        return false;
      });
      const parts = [];
      for (const branch of drawableBranches) parts.push(await exportPart(branch, 'Character.wz', zmap, anchors));
      parts.sort((a, b) => b.z - a.z);
      outputFrames.push({ index: frame, delay: scalar(frameNode, 'delay', 100), parts, anchors, filteredParts });
    }
    avatarActions[publicAction] = outputFrames;
    actionStats[publicAction] = { sourceAction, frameCount: outputFrames.length, delays: outputFrames.map(f => f.delay) };
  }
  const mapOutput = await mapData(map, zmap);
  const manifest = {
    schemaVersion: 1,
    contentVersion: 'gms83-mvp-1',
    source: { parser: '@tybys/wz@1.7.1', gameVersion: 83, files: ['Character.wz', 'Base.wz', 'Map.wz'] },
    avatar: {
      defaultFacing: -1,
      facingConvention: 'Source GMS83 canvas is left-facing; mirror the complete character container for right-facing.',
      look,
      zmap: [...zmap.entries()].map(([name, index]) => ({ name, index })),
      smap,
      equipmentSlots: { cap: { source: `Character.wz/${look.cap[0]}/${look.cap[1]}/info`, ...capSlots } },
      actionSources: actionStats,
      actions: avatarActions,
      instances: mapOutput.spawns.map((s, i) => ({ id: s.id, x: s.x, y: s.y, facing: s.facing, action: i ? 'walk' : 'stand' })),
    },
    map: { id: mapOutput.id, name: mapOutput.name, bounds: mapOutput.bounds, layers: mapOutput.layers, bgm: mapOutput.bgm },
    limitations: ['Representative look only: one body/head/face/hair/cap/coat/pants/shoes/weapon.', 'One GMS83 map with all its selected map-0/2/4 tile and object placements; other maps and tile sets are not covered.', 'Two browser instances share this look to validate world placement and flipping.'],
  };
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(out, 'map.json'), JSON.stringify(mapOutput, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(out, 'export-summary.json'), JSON.stringify({ actions: actionStats, map: { id: mapOutput.id, layers: mapOutput.layers.length, footholds: mapOutput.footholds.length }, pngs: pngCache.size }, null, 2) + '\n', 'utf8');
  character.dispose(); map.dispose(); base.dispose();
  console.log(JSON.stringify({ actions: actionStats, map: { id: mapOutput.id, bounds: mapOutput.bounds, layers: mapOutput.layers.length, footholds: mapOutput.footholds.length }, pngs: pngCache.size }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
