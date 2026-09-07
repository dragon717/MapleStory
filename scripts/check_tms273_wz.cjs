#!/usr/bin/env node

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createReader } = require('./tms273_wz.cjs');

const root = path.resolve(__dirname, '..');
const ui = path.join(root, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data/UI/UI_000.wz');
const canvas = path.join(root, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data/UI/_Canvas/_Canvas_005.wz');

(async () => {
  const reader = createReader(path.join(root, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data'));
  const frame = await reader.frame('UI/StatusBar3.img/mainBar/status/backgrnd');
  assert.equal(frame.width, 198);
  assert.equal(frame.height, 37);
  assert.equal(frame.origin.x, -2);
  assert.equal(frame.origin.y, -24);
  assert.equal(frame.resolvedSource, 'UI/_Canvas/StatusBar3.img/mainBar/status/backgrnd');
  assert.equal(frame.url, null);
  const glyph = await reader.get('UI/StatusBar3.img/mainBar/status/gauge/number/\\');
  assert.equal(glyph.name, '\\');
  const glyphFrame = await reader.frame(glyph);
  assert.equal(glyphFrame.width, 7);
  assert.equal(glyphFrame.height, 7);
  assert.equal(glyphFrame.resolvedSource, 'UI/_Canvas/StatusBar3.img/mainBar/status/gauge/number/\\');
  const dot = await reader.frame('UI/StatusBar3.img/mainBar/EXPBar/number/.');
  assert.equal((await reader.frame('Npc/0012101.img/stand/0')).delay, 1500);
  assert.equal(dot.width, 3);
  assert.equal(dot.height, 3);
  assert.equal(dot.source, 'UI/StatusBar3.img/mainBar/EXPBar/number/.');
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tms273-wz-check-'));
  const written = await reader.frame('UI/StatusBar3.img/mainBar/status/backgrnd', outputDir);
  const repeated = await reader.frame('UI/StatusBar3.img/mainBar/status/backgrnd', outputDir);
  assert.equal(written.url, repeated.url);
  const png = fs.readFileSync(path.join(outputDir, written.url));
  assert.equal(png.toString('ascii', 1, 4), 'PNG');
  assert.equal(png.readUInt32BE(16), 198);
  assert.equal(png.readUInt32BE(20), 37);
  assert.equal(fs.readdirSync(outputDir).length, 1);
  reader.close();
  assert(fs.existsSync(canvas));
  assert(fs.existsSync(ui));
  console.log(JSON.stringify({ check: 'tms273-statusbar3', frame, glyph: glyphFrame, dot }));
})().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
