#!/usr/bin/env node

// Export the authored TMS273 skill-window art and source geometry only.
// This manifest is a resource handoff; it does not implement the window or
// infer skill-grid, SP text, or SkillEx behavior that the source does not state.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const wz = require('@tybys/wz');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const OUTPUT = path.join(ROOT, 'resources/tms273-export');
const ASSETS = path.join(OUTPUT, 'assets/tms273');
const SOURCE = 'UI/UIWindow2.img/Skill/main';
const STATES = ['normal', 'pressed', 'disabled', 'mouseOver'];
const TAB_STATES = ['enabled', 'disabled', 'selected'];
const TAB_COUNT = 7;
const BUTTONS = [
  'BtSpUp',
  'BtModeChange',
  'BtMacro',
  'BtRide',
  'BtGuildSkill',
  'BtLinkSkill',
  'BtHyper',
  'BtVMatrix',
  'BtCooltimeEndAlarm',
  'BtHexaMatrix',
  'BtSequence',
];
const DECORATIONS = ['line', 'tip0', 'tip1', 'tip2'];

function children(node) {
  return [...(node?.wzProperties || [])];
}

function primitive(node, key) {
  const value = node?.at?.(key)?.wzValue;
  return value === undefined ? null : value;
}

function point(node, key) {
  const value = primitive(node, key);
  return value && Number.isFinite(Number(value.x)) && Number.isFinite(Number(value.y))
    ? { x: Number(value.x), y: Number(value.y) }
    : null;
}

function relative(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sourceFile(file) {
  const stat = fs.statSync(file);
  return { path: relative(file), bytes: stat.size, sha256: sha256(file) };
}

async function get(reader, source) {
  const node = await reader.get(source);
  if (node instanceof wz.WzImage) assert(await node.parseImage(), source);
  return node;
}

function rawFrameFields(node) {
  const origin = point(node, 'origin');
  const outlink = primitive(node, '_outlink');
  const delay = primitive(node, 'delay');
  const z = primitive(node, 'z');
  const level = primitive(node, 'level');
  return {
    origin,
    outlink: typeof outlink === 'string' && outlink.length > 0 ? outlink : null,
    delay: delay === null ? null : Number(delay),
    delaySource: delay === null ? 'missing-in-source' : 'source',
    ...(z === null ? {} : { z: Number(z) }),
    ...(level === null ? {} : { level: Number(level) }),
  };
}

function assetPath(url) {
  assert(typeof url === 'string' && url.startsWith('/assets/tms273/'), `invalid asset URL: ${url}`);
  return path.join(ASSETS, url.slice('/assets/tms273/'.length));
}

async function exportFrame(reader, source) {
  const node = await get(reader, source);
  const raw = rawFrameFields(node);
  assert(raw.origin, `${source}: source origin missing`);
  assert(raw.outlink, `${source}: source outlink missing`);
  const frame = await reader.frame(source, ASSETS);
  const file = assetPath(`/assets/tms273/${frame.url}`);
  assert(fs.existsSync(file), `${source}: PNG missing`);
  assert(frame.width > 0 && frame.height > 0, `${source}: invalid dimensions`);
  const missing = [];
  if (!raw.origin) missing.push('origin');
  if (!raw.outlink) missing.push('outlink');
  if (raw.delay === null) missing.push('delay');
  const metadataStatus = missing.length === 0
    ? 'complete'
    : missing.length === 1 && missing[0] === 'delay'
      ? 'static-delay-missing'
      : 'incomplete';
  assert.notEqual(metadataStatus, 'incomplete', `${source}: incomplete source metadata`);
  return {
    source,
    resolvedSource: frame.resolvedSource,
    resolvedOrigin: frame.origin,
    origin: raw.origin,
    outlink: raw.outlink,
    x: frame.x,
    y: frame.y,
    width: frame.width,
    height: frame.height,
    ...(raw.z === undefined ? {} : { z: raw.z }),
    ...(raw.level === undefined ? {} : { level: raw.level }),
    delay: raw.delay,
    delaySource: raw.delaySource,
    metadataStatus,
    url: `/assets/tms273/${frame.url}`,
    bytes: fs.statSync(file).size,
    sha256: sha256(file),
  };
}

async function exportButton(reader, button) {
  const result = {};
  for (const state of STATES) {
    result[state] = await exportFrame(reader, `${SOURCE}/${button}/${state}/0`);
  }
  return result;
}

async function exportTabs(reader) {
  const result = {};
  for (const state of TAB_STATES) {
    result[state] = [];
    for (let index = 0; index < TAB_COUNT; index++) {
      result[state].push(await exportFrame(reader, `${SOURCE}/Tab/${state}/${index}`));
    }
  }
  return result;
}

function archiveSources(reader) {
  return [...new Set([
    ...reader.files.keys(),
    ...reader.images.keys(),
  ])].sort().map(sourceFile);
}

async function main() {
  assert(fs.existsSync(DATA), `missing TMS273.7 Data: ${DATA}`);
  fs.mkdirSync(ASSETS, { recursive: true });
  const reader = createReader(DATA);
  try {
    const backgrounds = {};
    for (const name of ['backgrnd', 'backgrnd2', 'backgrnd3']) {
      backgrounds[name] = await exportFrame(reader, `${SOURCE}/${name}`);
    }

    const cells = {};
    for (const name of ['skill0', 'skill1', 'skillBlank']) {
      cells[name] = await exportFrame(reader, `${SOURCE}/${name}`);
    }

    const decorations = {};
    for (const name of DECORATIONS) decorations[name] = await exportFrame(reader, `${SOURCE}/${name}`);

    const buttons = {};
    for (const name of BUTTONS) buttons[name] = await exportButton(reader, name);

    const tabs = await exportTabs(reader);
    const skillPoint = await exportFrame(reader, `${SOURCE}/skillPoint`);

    // SkillEx lives beside Skill under UIWindow2.img.  Confirm its actual
    // presence from the parsed image tree, but do not generalize its
    // special-class expanded layout into the ordinary skill window.
    const window2 = await get(reader, 'UI/UIWindow2.img');
    const hasSkillEx = children(window2).some(child => child.name === 'SkillEx');
    const skillEx = hasSkillEx
      ? {
        status: 'present-but-not-exported',
        source: 'UI/UIWindow2.img/SkillEx/main',
        reason: 'Special-class expansion source requires separate state confirmation; no generic expanded layout emitted.',
      }
      : {
        status: 'source-not-found',
        source: 'UI/UIWindow2.img/SkillEx/main',
        reason: 'No SkillEx node was found in the inspected TMS273.7 tree; no generic expanded layout emitted.',
      };

    const windowSize = { width: backgrounds.backgrnd.width, height: backgrounds.backgrnd.height };
    const output = {
      contentVersion: 'tms273-skill-window',
      sourceVersion: 'TMS273.7',
      source: 'TMS273.7 client WZ',
      status: 'complete',
      sourceNode: SOURCE,
      researchReference: {
        pdf: 'references/tms273_research_pack/MapleStory273_Source_Index.pdf#page=6 (C06)',
        html: 'references/tms273_research_pack/MapleStory273_Online_Gallery.html#C06',
        image: 'https://grandislibrary.com/images/info/skill-expanded-ui.png',
        role: 'structure-only; GMS reference, not TMS273 geometry or values',
      },
      window: {
        width: windowSize.width,
        height: windowSize.height,
        backgrounds,
        cells,
        skillPoint,
        tabs,
        buttons,
        decorations,
      },
      optionalStructures: { skillEx },
      unverified: [
        'skill point text content and runtime value',
        'skill cell row/column positions and scroll behavior',
        'generic SkillEx collapsed/expanded layout and special-class rules',
        'window shell, skill learning, SP authority, and playable skill behavior',
      ],
      sourceFiles: archiveSources(reader),
    };
    const outputPath = path.join(OUTPUT, 'windows-skills.json');
    fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      output: relative(outputPath),
      status: output.status,
      sourceNode: output.sourceNode,
      window: windowSize,
      backgrounds: Object.fromEntries(Object.entries(backgrounds).map(([name, frame]) => [name, [frame.width, frame.height]])),
      cells: Object.fromEntries(Object.entries(cells).map(([name, frame]) => [name, [frame.width, frame.height]])),
      tabs: Object.fromEntries(Object.entries(tabs).map(([state, frames]) => [state, frames.length])),
      buttons: Object.keys(buttons).length,
      frames: Object.values(backgrounds).length + Object.values(cells).length + Object.values(decorations).length
        + Object.values(buttons).reduce((sum, states) => sum + Object.keys(states).length, 0)
        + Object.values(tabs).reduce((sum, frames) => sum + frames.length, 0) + 1,
      skillEx: skillEx.status,
      sourceFiles: output.sourceFiles.length,
    }, null, 2));
  } finally {
    reader.close();
  }
}

if (require.main === module) main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});

module.exports = { main, SOURCE, BUTTONS, TAB_STATES };
