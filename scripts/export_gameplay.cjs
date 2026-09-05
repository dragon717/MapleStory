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
(async () => {
  fs.mkdirSync(path.join(out, 'assets'), { recursive: true }); await wz.init();
  const mobSource = 'Mob.wz/0100100.img', mob = await node(mobSource);
  const monster = { templateId: '100100', source: mobSource, info: info(at(mob, 'info')), actions: {} };
  for (const [publicName, original] of Object.entries({ stand: 'stand', move: 'move', hit: 'hit1', die: 'die1' })) {
    monster.actions[publicName] = [];
    for (const frame of children(at(mob, original)).filter(n => /^\d+$/.test(n.name)).sort((a, b) => +a.name - +b.name)) monster.actions[publicName].push(await png(frame, mobSource + '/' + original + '/' + frame.name));
    assert(monster.actions[publicName].length);
  }
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
  const inventoryUi = {}; await flatCanvases(await node('UI.wz/UIWindow.img/Item'), 'UI.wz/UIWindow.img/Item', inventoryUi);
  const closeButton = {}; await flatCanvases(await node('UI.wz/Basic.img/BtClose'), 'UI.wz/Basic.img/BtClose', closeButton);
  const tabUi = {}; await flatCanvases(await node('UI.wz/Basic.img/Tab2'), 'UI.wz/Basic.img/Tab2', tabUi);
  const noticeUi = {}; await flatCanvases(await node('UI.wz/Basic.img/Notice'), 'UI.wz/Basic.img/Notice', noticeUi);
  const okButton = {}; await flatCanvases(await node('UI.wz/Basic.img/BtOK'), 'UI.wz/Basic.img/BtOK', okButton);
  const gameMenuUi = {}; await flatCanvases(await node('UI.wz/UIWindow.img/GameMenu'), 'UI.wz/UIWindow.img/GameMenu', gameMenuUi);
  const shortcutUi = {}; await flatCanvases(await node('UI.wz/UIWindow.img/ShortCut'), 'UI.wz/UIWindow.img/ShortCut', shortcutUi);
  const result = { contentVersion: 'gms83-gameplay-2', monsters: { '100100': monster }, items, hud, inventoryUi, closeButton, tabUi, noticeUi, okButton, gameMenuUi, shortcutUi,
    drops: { source: 'P0nk/Cosmic/src/main/resources/db/data/152-drop-data.sql:88-97,9614,10572,12532-12536', officialParity: 'reference private-server table; not independently verified against official GMS83', entries: drops },
    checks: { uniquePng: pngs.size, rgbaDecoded: pngs.size } };
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ monster: monster.info, actions: Object.fromEntries(Object.entries(monster.actions).map(([k, v]) => [k, v.map(f => f.delay)])), hud: Object.keys(hud).length, items: Object.keys(items), pngs: pngs.size }, null, 2));
  for (const a of archives.values()) a.dispose();
})().catch(e => { console.error(e); process.exitCode = 1; });
