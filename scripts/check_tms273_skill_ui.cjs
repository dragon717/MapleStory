#!/usr/bin/env node

// Minimal read-only contract check for windows-skills.json and its PNG assets.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'resources/tms273-export');
const MANIFEST = path.join(OUTPUT, 'windows-skills.json');
const PREFIX = '/assets/tms273/';
const STATES = ['normal', 'pressed', 'disabled', 'mouseOver'];
const BUTTONS = [
  'BtSpUp', 'BtModeChange', 'BtMacro', 'BtRide', 'BtGuildSkill', 'BtLinkSkill',
  'BtHyper', 'BtVMatrix', 'BtCooltimeEndAlarm', 'BtHexaMatrix', 'BtSequence',
];
const TAB_STATES = ['enabled', 'disabled', 'selected'];

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function localAsset(url) {
  assert(typeof url === 'string' && url.startsWith(PREFIX), `invalid asset URL: ${url}`);
  return path.join(OUTPUT, 'assets/tms273', url.slice(PREFIX.length));
}

function checkFrame(frame, label) {
  assert(frame && typeof frame === 'object', `${label}: missing frame`);
  assert(frame.source && frame.resolvedSource, `${label}: source link missing`);
  assert(frame.outlink, `${label}: source outlink missing`);
  assert(frame.origin && Number.isFinite(frame.origin.x) && Number.isFinite(frame.origin.y), `${label}: origin missing`);
  assert(Number.isFinite(frame.x) && Number.isFinite(frame.y), `${label}: source position missing`);
  assert(Number.isInteger(frame.width) && frame.width > 0, `${label}: width missing`);
  assert(Number.isInteger(frame.height) && frame.height > 0, `${label}: height missing`);
  assert(frame.delay === null || (Number.isFinite(frame.delay) && frame.delay > 0), `${label}: invalid delay`);
  assert(frame.delay === null ? frame.delaySource === 'missing-in-source' : frame.delaySource === 'source', `${label}: delay provenance missing`);
  assert(/^[a-f0-9]{64}$/.test(frame.sha256), `${label}: asset hash missing`);
  const file = localAsset(frame.url);
  assert(fs.existsSync(file), `${label}: PNG missing: ${file}`);
  assert(fs.statSync(file).size === frame.bytes, `${label}: PNG size changed`);
  assert.equal(digest(file), frame.sha256, `${label}: PNG hash changed`);
  assert.equal(fs.readFileSync(file).subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${label}: not a PNG`);
}

const data = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
assert.equal(data.status, 'complete');
assert.equal(data.sourceVersion, 'TMS273.7');
assert.equal(data.sourceNode, 'UI/UIWindow2.img/Skill/main');
assert.equal(data.window.width, 318, 'main background width changed');
assert.equal(data.window.height, 361, 'main background height changed');
assert.equal(data.window.backgrounds.backgrnd.width, 318);
assert.equal(data.window.backgrounds.backgrnd.height, 361);
assert.equal(data.window.backgrounds.backgrnd2.width, 306);
assert.equal(data.window.backgrounds.backgrnd2.height, 333);
assert.equal(data.window.backgrounds.backgrnd3.width, 304);
assert.equal(data.window.backgrounds.backgrnd3.height, 45);

for (const [name, frame] of Object.entries(data.window.backgrounds)) checkFrame(frame, `background ${name}`);
for (const [name, frame] of Object.entries(data.window.cells)) checkFrame(frame, `cell ${name}`);
for (const [name, frame] of Object.entries(data.window.decorations)) checkFrame(frame, `decoration ${name}`);
checkFrame(data.window.skillPoint, 'skillPoint');

for (const state of TAB_STATES) {
  assert.equal(data.window.tabs[state].length, 7, `Tab/${state} count changed`);
  data.window.tabs[state].forEach((frame, index) => checkFrame(frame, `Tab/${state}/${index}`));
}
for (const button of BUTTONS) {
  assert(data.window.buttons[button], `${button} missing`);
  for (const state of STATES) checkFrame(data.window.buttons[button][state], `${button}/${state}`);
}

assert(data.unverified.includes('skill point text content and runtime value'));
assert(data.unverified.includes('skill cell row/column positions and scroll behavior'));
assert.equal(data.optionalStructures.skillEx.status, 'present-but-not-exported');
assert.equal(data.optionalStructures.skillEx.source, 'UI/UIWindow2.img/SkillEx/main');
assert(data.optionalStructures.skillEx.reason.includes('no generic expanded layout emitted'));
assert(!JSON.stringify(data.window).includes('"rows"'));
assert(!JSON.stringify(data.window).includes('"columns"'));
assert(!JSON.stringify(data.window).includes('"spText"'));
for (const source of data.sourceFiles) {
  const file = path.join(ROOT, source.path);
  assert(fs.existsSync(file), `source archive missing: ${source.path}`);
  assert(source.bytes > 0, `source archive empty: ${source.path}`);
  assert.equal(digest(file), source.sha256, `source archive hash changed: ${source.path}`);
}

console.log(JSON.stringify({
  manifest: path.relative(ROOT, MANIFEST).split(path.sep).join('/'),
  status: data.status,
  mainBackground: [data.window.width, data.window.height],
  backgrounds: Object.fromEntries(Object.entries(data.window.backgrounds).map(([name, frame]) => [name, [frame.width, frame.height]])),
  tabs: Object.fromEntries(TAB_STATES.map(state => [state, data.window.tabs[state].length])),
  buttons: BUTTONS.length,
  sourceFiles: data.sourceFiles.length,
  skillEx: data.optionalStructures.skillEx.status,
}, null, 2));
