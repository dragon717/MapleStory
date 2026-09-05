// Selected v83 gameplay/UI sources only; this never writes to the running client.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict'), { spawnSync } = require('node:child_process');
const wz = require('../参考/tools/wz-audit/node_modules/@tybys/wz');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'references/gameplay-assets');
const archives = new Map(), images = new Map(), pngs = new Map();
const children = n => [...(n?.wzProperties || [])];
const at = (n, key) => n?.at?.(key);
const value = (n, key) => at(n, key)?.wzValue;
const vec = n => n?.wzValue && Number.isFinite(n.wzValue.x) ? { x: n.wzValue.x, y: n.wzValue.y } : null;
const MAP_IDS = [
  '000010000', '000020000', '000020001', '000030000', '000030001',
  '000040000', '000040001', '000040002', '000050000', '000050001',
  '000060000', '000060001',
  '001000000', '001000001', '001000002', '001000003',
  '001000004', '001000005', '001000006',
];
const REQUIRED_MAP_IDS = MAP_IDS.slice(0, 12);
async function node(source) {
  const [file, ...segments] = source.split('/');
  if (!archives.has(file)) { const a = new wz.WzFile(path.join(root, '参考/assets/gms83/83', file), wz.WzMapleVersion.GMS, 83); assert.equal(await a.parseWzFile(), wz.WzFileParseStatus.SUCCESS); archives.set(file, a); }
  let n = archives.get(file).wzDirectory;
  for (const segment of segments) { n = at(n, segment); assert(n, source); if (segment.endsWith('.img') && !images.has(n.fullPath)) { assert(await n.parseImage()); images.set(n.fullPath, n); } }
  return n;
}
function resolve(n, seen = new Set()) {
  assert(!seen.has(n), 'UOL cycle'); seen.add(n);
  return n instanceof wz.WzUOLProperty ? resolve(n.linkValue, seen) : n;
}
async function png(raw, source) {
  const n = resolve(raw); assert(n instanceof wz.WzCanvasProperty, source);
  const resolvedSource = n.fullPath.match(/[^/]+\.wz\/.*/)[0];
  if (!pngs.has(resolvedSource)) {
    const bitmap = await n.getBitmap(), bytes = Buffer.from(await bitmap.getBufferAsync('image/png'));
    const name = resolvedSource.replace(/[^A-Za-z0-9_.-]/g, '_') + '.png', target = path.join(out, 'assets', name);
    fs.writeFileSync(target, bytes);
    const check = spawnSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-i', target, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 32 * 1024 * 1024 });
    assert.equal(check.status, 0, String(check.stderr));
    assert.equal(check.stdout.length, n.pngProperty.width * n.pngProperty.height * 4);
    pngs.set(resolvedSource, { url: 'assets/' + name, width: n.pngProperty.width, height: n.pngProperty.height,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'), rgbaDecodeOk: true });
  }
  const origin = vec(at(raw, 'origin')) || vec(at(n, 'origin')) || { x: 0, y: 0 };
  return { ...pngs.get(resolvedSource), source, resolvedSource, origin, x: -origin.x, y: -origin.y,
    delay: value(raw, 'delay') ?? value(n, 'delay') ?? 100,
    map: Object.fromEntries(children(at(n, 'map')).map(p => [p.name, vec(p)])),
    lt: vec(at(n, 'lt')), rb: vec(at(n, 'rb')), uol: raw instanceof wz.WzUOLProperty ? raw.value : null };
}
async function flatCanvases(n, source, output, key = '') {
  const resolved = resolve(n);
  if (resolved instanceof wz.WzCanvasProperty) { output[key] = await png(n, source); return; }
  for (const c of children(resolved)) await flatCanvases(c, source + '/' + c.name, output, key ? key + '/' + c.name : c.name);
}
function info(n) { return Object.fromEntries(children(n).filter(p => ['number', 'string'].includes(typeof p.wzValue)).map(p => [p.name, p.wzValue])); }
function scalar(n, name, fallback = null) {
  const current = value(n, name);
  return current === undefined || current === null ? fallback : current;
}
function sourcePath(n) {
  const match = n?.fullPath?.match(/[^/]+\.wz\/.*$/);
  assert(match, `WZ source path missing: ${n?.fullPath || '<unknown>'}`);
  return match[0];
}
function numericChildren(n) { return children(n).filter(c => /^\d+$/.test(c.name)).sort((a, b) => +a.name - +b.name); }
function canvasBranch(n, raw = n) {
  if (!n) return null;
  if (n instanceof wz.WzUOLProperty) {
    if (!n.linkValue) return null;
    return canvasBranch(n.linkValue, raw);
  }
  if (n instanceof wz.WzCanvasProperty) return { node: n, raw };
  for (const child of children(n)) {
    if (['map', 'foothold'].includes(child.name)) continue;
    const found = canvasBranch(child, raw instanceof wz.WzUOLProperty ? raw : child);
    if (found) return found;
  }
  return null;
}
function mapId(value) {
  if (value === undefined || value === null || String(value) === '999999999') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(Math.trunc(numeric)).padStart(9, '0') : String(value).padStart(9, '0');
}
function collectFootholds(map) {
  const footholds = [];
  function walk(node, currentPath = ['foothold']) {
    if (!node) return;
    const x1 = scalar(node, 'x1'), y1 = scalar(node, 'y1'), x2 = scalar(node, 'x2'), y2 = scalar(node, 'y2');
    if ([x1, y1, x2, y2].every(Number.isFinite)) {
      const foot = { id: Number(currentPath.at(-1)), path: currentPath.join('/'), x1, y1, x2, y2,
        prev: scalar(node, 'prev', 0), next: scalar(node, 'next', 0) };
      const forbidFallDown = scalar(node, 'forbidFallDown');
      if (forbidFallDown !== null) foot.forbidFallDown = forbidFallDown;
      footholds.push(foot);
    }
    for (const child of children(node)) walk(child, [...currentPath, child.name]);
  }
  walk(at(map, 'foothold'));
  return footholds;
}
function collectLadders(map) {
  return numericChildren(at(map, 'ladderRope')).map(node => ({
    id: Number(node.name), l: scalar(node, 'l', 0), uf: scalar(node, 'uf', 0), x: scalar(node, 'x', 0),
    y1: scalar(node, 'y1', 0), y2: scalar(node, 'y2', 0), page: scalar(node, 'page', 0),
  }));
}
function collectPortals(map) {
  return numericChildren(at(map, 'portal')).map(node => {
    const portal = {
      name: scalar(node, 'pn', ''), type: scalar(node, 'pt', 0), x: scalar(node, 'x', 0), y: scalar(node, 'y', 0),
      targetMapId: mapId(scalar(node, 'tm')), targetPortalName: scalar(node, 'tn') || null,
    };
    const script = scalar(node, 'script');
    if (typeof script === 'string' && script) portal.script = script;
    for (const field of ['onlyOnce', 'hideTooltip', 'delay']) {
      const current = scalar(node, field);
      if (current !== null) portal[field] = field === 'onlyOnce' ? Boolean(current) : current;
    }
    return portal;
  });
}
function mapSpawns(portals, footholds) {
  return portals.filter(portal => portal.name === 'sp').map((portal, index) => {
    const foothold = footholds.find(candidate => candidate.y1 === portal.y && portal.x >= Math.min(candidate.x1, candidate.x2) && portal.x <= Math.max(candidate.x1, candidate.x2));
    return { id: `sp-${index}`, x: portal.x, y: portal.y, ...(foothold ? { foothold: foothold.id, footholdPath: foothold.path } : {}) };
  });
}
function mapBounds(infoNode, layers) {
  const direct = { xMin: scalar(infoNode, 'VRLeft'), xMax: scalar(infoNode, 'VRRight'), yMin: scalar(infoNode, 'VRTop'), yMax: scalar(infoNode, 'VRBottom') };
  if ([direct.xMin, direct.xMax, direct.yMin, direct.yMax].every(Number.isFinite) && direct.xMax > direct.xMin && direct.yMax > direct.yMin) return direct;
  const xMin = Math.min(...layers.map(layer => layer.x));
  const xMax = Math.max(...layers.map(layer => layer.x + layer.width));
  const yMin = Math.min(...layers.map(layer => layer.y));
  const yMax = Math.max(...layers.map(layer => layer.y + layer.height));
  assert([xMin, xMax, yMin, yMax].every(Number.isFinite), 'map has no VR bounds or drawable layers');
  return { xMin: xMin - 100, xMax: xMax + 100, yMin: yMin - 100, yMax: yMax + 100 };
}
async function exportMap(mapId) {
  const mapSource = `Map.wz/Map/Map0/${mapId}.img`;
  const map = await node(mapSource);
  const infoNode = at(map, 'info');
  const layers = [];
  const missing = { backgrounds: [], tiles: [], objects: [] };

  for (const back of children(at(map, 'back'))) {
    const backSet = scalar(back, 'bS', '');
    if (!backSet) continue;
    const no = scalar(back, 'no', Number(back.name));
    let backImage;
    try { backImage = await node(`Map.wz/Back/${backSet}.img`); } catch (_) { missing.backgrounds.push(`${backSet}/${no}`); continue; }
    const animated = scalar(back, 'ani', 0) === 1;
    const branch = canvasBranch(animated ? at(at(backImage, 'ani'), String(no)) : at(at(backImage, 'back'), String(no)))
      || canvasBranch(at(at(backImage, 'back'), String(no)))
      || canvasBranch(at(at(backImage, 'ani'), String(no)));
    if (!branch) { missing.backgrounds.push(`${backSet}/${no}`); continue; }
    const image = await png(branch.raw, sourcePath(branch.raw));
    const origin = vec(at(branch.raw, 'origin')) || vec(at(branch.node, 'origin')) || { x: 0, y: 0 };
    const background = Object.fromEntries(['x', 'y', 'rx', 'ry', 'cx', 'cy', 'type', 'front', 'ani', 'f'].map(field => [field, scalar(back, field, 0)]));
    layers.push({ key: `back-${mapId}-${back.name}`, source: sourcePath(branch.raw), resolvedSource: sourcePath(branch.node), url: image.url,
      x: background.x - origin.x, y: background.y - origin.y, origin, width: image.width, height: image.height,
      depth: scalar(branch.node, 'z', 0), alpha: scalar(back, 'a', 255), type: background.type, background });
  }

  for (const mapLayer of numericChildren(map)) {
    const layerInfo = at(mapLayer, 'info');
    const tileset = scalar(layerInfo, 'tS');
    if (tileset) {
      let tileImage;
      try { tileImage = await node(`Map.wz/Tile/${tileset}.img`); } catch (_) { missing.tiles.push(`tileset/${tileset}`); tileImage = null; }
      if (tileImage) {
        for (const tile of children(at(mapLayer, 'tile'))) {
          const values = Object.fromEntries(children(tile).map(property => [property.name, property.wzValue]));
          const tileNode = at(at(tileImage, values.u), String(values.no));
          const branch = canvasBranch(tileNode);
          if (!branch) { missing.tiles.push(`${tileset}/${values.u}/${values.no}`); continue; }
          const image = await png(branch.raw, sourcePath(branch.raw));
          const origin = vec(at(branch.raw, 'origin')) || vec(at(branch.node, 'origin')) || { x: 0, y: 0 };
          layers.push({ key: `tile-${mapLayer.name}-${tile.name}`, source: sourcePath(branch.raw), resolvedSource: sourcePath(branch.node), url: image.url,
            x: values.x - origin.x, y: values.y - origin.y, origin, width: image.width, height: image.height,
            depth: Number(mapLayer.name) * 100 + Number(values.zM || 0) * 10 + Number(scalar(branch.node, 'z', 0)), flip: Boolean(values.f),
            mapTile: { layer: Number(mapLayer.name), x: values.x, y: values.y, u: values.u, no: values.no, zM: values.zM } });
        }
      }
    }
    for (const object of children(at(mapLayer, 'obj'))) {
      const values = Object.fromEntries(children(object).map(property => [property.name, property.wzValue]));
      let objectImage;
      try { objectImage = await node(`Map.wz/Obj/${values.oS}.img`); } catch (_) { missing.objects.push(`${values.oS}`); continue; }
      const objectNode = at(at(at(objectImage, values.l0), values.l1), values.l2);
      const branch = canvasBranch(objectNode);
      if (!branch) { missing.objects.push(`${values.oS}/${values.l0}/${values.l1}/${values.l2}`); continue; }
      const image = await png(branch.raw, sourcePath(branch.raw));
      const origin = vec(at(branch.raw, 'origin')) || vec(at(branch.node, 'origin')) || { x: 0, y: 0 };
      layers.push({ key: `obj-${mapLayer.name}-${object.name}`, source: sourcePath(branch.raw), resolvedSource: sourcePath(branch.node), url: image.url,
        x: values.x - origin.x, y: values.y - origin.y, origin, width: image.width, height: image.height,
        depth: Number(mapLayer.name) * 100 + Number(values.zM || 0) * 10 + Number(values.z || 0), flip: Boolean(values.f),
        mapObject: { layer: Number(mapLayer.name), oS: values.oS, l0: values.l0, l1: values.l1, l2: values.l2, x: values.x, y: values.y, z: values.z, zM: values.zM } });
    }
  }

  assert(layers.some(layer => !layer.background), `${mapSource} has no drawable tile/object layers`);
  const footholds = collectFootholds(map);
  const ladders = collectLadders(map);
  const portals = collectPortals(map);
  const spawns = mapSpawns(portals, footholds);
  const result = { id: mapId, source: mapSource, bounds: mapBounds(infoNode, layers), bgm: scalar(infoNode, 'bgm'), layers, footholds, ladders, portals,
    ...(spawns.length ? { spawn: spawns[0], spawns } : {}), resourceChecks: { layerCount: layers.length, tileCount: layers.filter(layer => layer.mapTile).length,
      objectCount: layers.filter(layer => layer.mapObject).length, footholdCount: footholds.length, ladderCount: ladders.length, portalCount: portals.length, missing } };
  return result;
}
async function exportMaps() {
  const maps = [], failures = [];
  for (const mapId of MAP_IDS) {
    try {
      const map = await exportMap(mapId);
      maps.push(map);
      console.log(`Map ${mapId}: ${map.layers.length} layers, ${map.footholds.length} footholds, ${map.ladders.length} ladders, ${map.portals.length} portals`);
    } catch (error) {
      failures.push({ id: mapId, error: error instanceof Error ? error.message : String(error) });
      console.error(`Map ${mapId} export failed:`, error);
    }
  }
  const requiredFailures = failures.filter(failure => REQUIRED_MAP_IDS.includes(failure.id));
  assert.equal(requiredFailures.length, 0, `required map export failures: ${JSON.stringify(requiredFailures)}`);
  fs.mkdirSync(path.join(out, 'maps'), { recursive: true });
  fs.writeFileSync(path.join(out, 'maps/catalog.json'), JSON.stringify({ source: 'Map.wz/Map/Map0/*.img', maps, failures }, null, 2) + '\n', 'utf8');
  return { maps, failures };
}
(async () => {
  fs.mkdirSync(path.join(out, 'assets'), { recursive: true }); await wz.init();
  if (process.argv.includes('--equipment-ui')) {
    const equipmentUi = {};
    await flatCanvases(await node('UI.wz/UIWindow.img/Equip'), 'UI.wz/UIWindow.img/Equip', equipmentUi);
    const manifestPath = path.join(out, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.equipmentUi = equipmentUi;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify({ equipmentUi: Object.keys(equipmentUi), pngs: pngs.size }));
    for (const archive of archives.values()) archive.dispose();
    return;
  }

  const mobSource = 'Mob.wz/0100100.img', mob = await node(mobSource);
  const monster = { templateId: '100100', source: mobSource, info: info(at(mob, 'info')), actions: {} };
  for (const [publicName, original] of Object.entries({ stand: 'stand', move: 'move', hit: 'hit1', die: 'die1' })) {
    monster.actions[publicName] = [];
    for (const frame of children(at(mob, original)).filter(n => /^\d+$/.test(n.name)).sort((a, b) => +a.name - +b.name)) monster.actions[publicName].push(await png(frame, mobSource + '/' + original + '/' + frame.name));
    assert(monster.actions[publicName].length);
  }
  // Basic sword combat presentation is source-backed too.  The attack body
  // already exports Character.wz/Weapon/01302000.img/swingO1 (0, 1, 2);
  // this is the matching GMS83 swordOL afterimage.  The original client
  // starts it at attack frame 2, i.e. after the 300 ms + 150 ms body frames.
  const afterimageSource = 'Character.wz/Afterimage/swordOL.img/0/swingO1';
  const afterimage = at(await node(afterimageSource), '2');
  const afterimageFrames = [];
  for (const frame of children(afterimage).filter(n => /^\d+$/.test(n.name)).sort((a, b) => +a.name - +b.name)) {
    afterimageFrames.push(await png(frame, afterimageSource + '/2/' + frame.name));
  }
  assert.equal(afterimageFrames.length, 1);

  // Build these maps explicitly while retaining each digit's source origin metadata.
  async function numberSetResolved(name) {
    const source = 'Effect.wz/BasicEff.img/' + name;
    const set = await node(source);
    const result = {};
    for (const frame of children(set).filter(n => /^\d$/.test(n.name)).sort((a, b) => +a.name - +b.name)) {
      result[frame.name] = await png(frame, source + '/' + frame.name);
    }
    assert.equal(Object.keys(result).length, 10);
    return result;
  }
  const damageNumbers = {
    normal: { first: await numberSetResolved('NoRed0'), rest: await numberSetResolved('NoRed1') },
    critical: { first: await numberSetResolved('NoCri0'), rest: await numberSetResolved('NoCri1') },
  };
  const dropSql = fs.readFileSync(path.join(root, '参考/repos/P0nk__Cosmic/src/main/resources/db/data/152-drop-data.sql'), 'utf8');
  const drops = [...dropSql.matchAll(/\(100100, (\d+), (\d+), (\d+), (\d+), (\d+)\)/g)].map(m => ({ itemId: m[1], minimum: +m[2], maximum: +m[3], questId: +m[4], chance: +m[5] }));
  // The source file has three INSERT sections and no DELETE/UPDATE; later snail rows add cards, mesos and equipment.
  assert.equal(drops.length, 17);
  assert.equal(new Set(drops.map(d => d.itemId)).size, 17);
  const items = {};
  for (const drop of drops) {
    if (drop.itemId === '0') continue;
    const padded = drop.itemId.padStart(8, '0');
    const category = { '100': 'Cap', '104': 'Coat', '105': 'Longcoat', '130': 'Weapon' }[drop.itemId.slice(0, 3)];
    const source = drop.itemId.startsWith('1') ? 'Character.wz/' + category + '/' + padded + '.img/info/icon'
      : 'Item.wz/' + (drop.itemId.startsWith('2') ? 'Consume' : 'Etc') + '/' + padded.slice(0, 4) + '.img/' + padded + '/info/icon';
    items[drop.itemId] = await png(await node(source), source);
  }
  const mesoSource = 'Item.wz/Special/0900.img/09000000/iconRaw';
  const mesoFrames = [];
  for (const frame of children(await node(mesoSource))) mesoFrames.push(await png(frame, mesoSource + '/' + frame.name));
  items['0'] = { ...mesoFrames[0], frames: mesoFrames };
  const hud = {}; await flatCanvases(await node('UI.wz/StatusBar.img'), 'UI.wz/StatusBar.img', hud);
  const equipmentUi = {}; await flatCanvases(await node('UI.wz/UIWindow.img/Equip'), 'UI.wz/UIWindow.img/Equip', equipmentUi);
  const inventoryUi = {}; await flatCanvases(await node('UI.wz/UIWindow.img/Item'), 'UI.wz/UIWindow.img/Item', inventoryUi);
  const closeButton = {}; await flatCanvases(await node('UI.wz/Basic.img/BtClose'), 'UI.wz/Basic.img/BtClose', closeButton);
  const tabUi = {}; await flatCanvases(await node('UI.wz/Basic.img/Tab2'), 'UI.wz/Basic.img/Tab2', tabUi);
  const noticeUi = {}; await flatCanvases(await node('UI.wz/Basic.img/Notice'), 'UI.wz/Basic.img/Notice', noticeUi);
  const okButton = {}; await flatCanvases(await node('UI.wz/Basic.img/BtOK'), 'UI.wz/Basic.img/BtOK', okButton);
  const gameMenuUi = {}; await flatCanvases(await node('UI.wz/UIWindow.img/GameMenu'), 'UI.wz/UIWindow.img/GameMenu', gameMenuUi);
  const shortcutUi = {}; await flatCanvases(await node('UI.wz/UIWindow.img/ShortCut'), 'UI.wz/UIWindow.img/ShortCut', shortcutUi);
  const mapExports = await exportMaps();
  const result = { contentVersion: 'gms83-gameplay-2', monsters: { '100100': monster }, items, hud, inventoryUi, equipmentUi, closeButton, tabUi, noticeUi, okButton, gameMenuUi, shortcutUi,
    combat: {
      attack: { afterimage: { source: afterimageSource, firstFrame: 2, startMs: 450, frames: afterimageFrames } },
      hit: { sound: '/assets/Mob.wz_0100100_Damage.mp3', soundSource: 'Sound.wz/Mob.img/0100100/Damage' },
      damageNumbers,
    },
    drops: { source: 'P0nk/Cosmic/src/main/resources/db/data/152-drop-data.sql:88-97,9614,10572,12532-12536', officialParity: 'reference private-server table; not independently verified against official GMS83', entries: drops },
    checks: { uniquePng: pngs.size, rgbaDecoded: pngs.size, renderedMapCount: mapExports.maps.length, mapExportFailures: mapExports.failures } };
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ monster: monster.info, actions: Object.fromEntries(Object.entries(monster.actions).map(([k, v]) => [k, v.map(f => f.delay)])), hud: Object.keys(hud).length, items: Object.keys(items), pngs: pngs.size }, null, 2));
  for (const a of archives.values()) a.dispose();
})().catch(e => { console.error(e); process.exitCode = 1; });
