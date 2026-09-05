// One-off asset addition: Item.wz/Consume/0201.img/02010007/info/icon
// (2010007 Roger's Apple), the reward prop used by v83 quest 1021.  Writes the
// same PNG into both the reference manifest dir and the running client asset
// dir, then patches both manifest.json files with the item entry.  Mirrors the
// decode rules in export_gameplay.cjs (local GMS83 archive, @tybys/wz).
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const wz = require('../参考/tools/wz-audit/node_modules/@tybys/wz');
const root = path.resolve(__dirname, '..');

const ARCHIVE = 'Item.wz';
const RESOLVED_SOURCE = `${ARCHIVE}/Consume/0201.img/02010007/info/icon`;
const PNG_NAME = 'Item.wz_Consume_0201.img_02010007_info_icon.png';
const TARGETS = [
  path.join(root, 'references/gameplay-assets/assets'),
  path.join(root, 'client/public-gameplay/assets'),
];

async function main() {
  const archive = new wz.WzFile(path.join(root, '参考/assets/gms83/83', ARCHIVE), wz.WzMapleVersion.GMS, 83);
  assert.equal(await archive.parseWzFile(), wz.WzFileParseStatus.SUCCESS);
  let n = archive.wzDirectory.at('Consume');
  n = n.at('0201.img');
  assert(n, 'Consume/0201.img missing');
  await n.parseImage();
  let raw = n.at('02010007').at('info').at('icon');
  assert(raw, RESOLVED_SOURCE + ' missing');
  const canvas = raw instanceof wz.WzUOLProperty ? raw.linkValue : raw;
  assert(canvas instanceof wz.WzCanvasProperty, 'icon is not a canvas');
  const bitmap = await canvas.getBitmap();
  const bytes = Buffer.from(await bitmap.getBufferAsync('image/png'));
  assert(bytes.length > 0);
  const { width, height } = canvas.pngProperty;
  const origin = { x: 0, y: 0 };
  const rawOrigin = n.at('02010007').at('info').at('icon').at('origin') || canvas.at('origin');
  if (rawOrigin && Number.isFinite(rawOrigin.wzValue?.x)) {
    origin.x = rawOrigin.wzValue.x;
    origin.y = rawOrigin.wzValue.y;
  }
  for (const dir of TARGETS) fs.writeFileSync(path.join(dir, PNG_NAME), bytes);
  const entry = {
    url: `assets/${PNG_NAME}`,
    width,
    height,
    origin,
    x: -origin.x,
    y: -origin.y,
    delay: 100,
    source: RESOLVED_SOURCE,
    resolvedSource: RESOLVED_SOURCE,
  };
  for (const manifestPath of [
    path.join(root, 'references/gameplay-assets/manifest.json'),
    path.join(root, 'client/public-gameplay/assets/manifest.json'),
  ]) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.items = manifest.items || {};
    manifest.items['2010007'] = entry;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log(`patched ${path.relative(root, manifestPath)}`);
  }
  console.log(`exported ${PNG_NAME} ${width}x${height} into ${TARGETS.length} dirs`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
