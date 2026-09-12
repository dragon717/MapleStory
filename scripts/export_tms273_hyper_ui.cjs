#!/usr/bin/env node

// Export the TMS273 Hyper entry art and the two source-backed skill-window
// shells that can host it.  The client-side Hyper page is intentionally not
// inferred here: the inspected UI WZ contains BtHyper/BtHyperAni, but no
// UI/Hyper panel node.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const wz = require('@tybys/wz');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const OUTPUT = path.join(ROOT, 'resources/tms273-export');
const ASSET_ROOT = path.join(OUTPUT, 'assets/tms273/hyper-ui');
const OUTPUT_PATH = path.join(OUTPUT, 'hyper-ui.json');

const MAIN = 'UI/UIWindow2.img/Skill/main';
const EXPANDED = 'UI/UIWindow2.img/SkillEx/main';
const STATES = ['normal', 'pressed', 'disabled', 'mouseOver'];
const TAB_STATES = ['enabled', 'disabled', 'selected'];
const TAB_COUNT = 7;
const HYPER_IDS = ['2221052', '2221053', '2221054', '2221055'];

function value(node, key) {
  const result = node?.at?.(key)?.wzValue;
  return result === undefined ? null : result;
}

function point(node, key) {
  const result = value(node, key);
  return result && Number.isFinite(Number(result.x)) && Number.isFinite(Number(result.y))
    ? { x: Number(result.x), y: Number(result.y) }
    : null;
}

function relative(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function get(reader, source) {
  const node = await reader.get(source);
  if (node instanceof wz.WzImage) assert(await node.parseImage(), source);
  return node;
}

function sourceFile(file) {
  return { path: relative(file), bytes: fs.statSync(file).size, sha256: sha256(file) };
}

async function exportFrame(reader, source) {
  const node = await get(reader, source);
  const rawOrigin = point(node, 'origin');
  const rawOutlink = value(node, '_outlink');
  const rawDelay = value(node, 'delay');
  const rawLevel = value(node, 'level');
  const rawZ = value(node, 'z');
  const frame = await reader.frame(source, ASSET_ROOT);
  assert(frame.url, `${source}: frame did not produce an asset`);
  const file = path.join(ASSET_ROOT, frame.url);
  assert(fs.existsSync(file), `${source}: PNG missing`);
  assert(frame.width > 0 && frame.height > 0, `${source}: invalid dimensions`);
  return {
    source,
    resolvedSource: frame.resolvedSource,
    origin: rawOrigin ?? frame.origin,
    resolvedOrigin: frame.origin,
    x: frame.x,
    y: frame.y,
    width: frame.width,
    height: frame.height,
    ...(rawZ === null ? {} : { z: Number(rawZ) }),
    ...(rawLevel === null ? {} : { level: Number(rawLevel) }),
    delay: rawDelay === null ? null : Number(rawDelay),
    delaySource: rawDelay === null ? 'missing-in-source' : 'source',
    outlink: typeof rawOutlink === 'string' && rawOutlink.length > 0 ? rawOutlink : null,
    metadataStatus: rawDelay === null ? 'static-delay-missing' : 'complete',
    url: `/assets/tms273/hyper-ui/${frame.url}`,
    bytes: fs.statSync(file).size,
    sha256: sha256(file),
  };
}

async function exportStates(reader, base, name) {
  const states = {};
  for (const state of STATES) states[state] = await exportFrame(reader, `${base}/${name}/${state}/0`);
  return states;
}

async function exportTabs(reader, base) {
  const tabs = {};
  for (const state of TAB_STATES) {
    tabs[state] = [];
    for (let index = 0; index < TAB_COUNT; index++) {
      tabs[state].push(await exportFrame(reader, `${base}/Tab/${state}/${index}`));
    }
  }
  return tabs;
}

async function exportShell(reader, base, { expanded = false } = {}) {
  const backgrounds = {};
  for (const name of expanded ? ['backgrnd', 'backgrnd2'] : ['backgrnd', 'backgrnd2', 'backgrnd3']) {
    backgrounds[name] = await exportFrame(reader, `${base}/${name}`);
  }
  const cells = {};
  for (const name of expanded ? ['skill0', 'skill1'] : ['skill0', 'skill1', 'skillBlank']) {
    cells[name] = await exportFrame(reader, `${base}/${name}`);
  }
  const skillPoint = expanded ? null : await exportFrame(reader, `${base}/skillPoint`);
  const tabs = await exportTabs(reader, base);
  const hyper = await exportStates(reader, base, 'BtHyper');
  const hyperAnimation = [];
  for (let index = 0; index < 4; index++) {
    hyperAnimation.push(await exportFrame(reader, `${base}/BtHyperAni/normal/${index}`));
  }
  const windowSize = {
    width: backgrounds.backgrnd.width,
    height: backgrounds.backgrnd.height,
  };
  return {
    sourceNode: base,
    window: windowSize,
    backgrounds,
    cells,
    skillPoint,
    tabs,
    hyperEntry: {
      sourceNode: `${base}/BtHyper`,
      label: { client: '超级技能', source: 'image-only' },
      states: hyper,
      animation: {
        sourceNode: `${base}/BtHyperAni/normal`,
        frameCount: hyperAnimation.length,
        frames: hyperAnimation,
      },
    },
  };
}

function sourceFiles(reader) {
  return [...reader.files.keys()]
    .sort()
    .map(sourceFile);
}

function reusedSkillIcons() {
  const file = path.join(OUTPUT, 'skills.json');
  if (!fs.existsSync(file)) {
    return { status: 'artifact-not-found', artifact: relative(file), skills: {} };
  }
  const skillExport = JSON.parse(fs.readFileSync(file, 'utf8'));
  const skills = {};
  for (const id of HYPER_IDS) {
    const entry = skillExport.catalog?.skills?.[id];
    skills[id] = entry
      ? { source: entry.source, icons: entry.icons }
      : { source: `Skill/222.img/skill/${id}`, status: 'not-in-current-skills-artifact' };
  }
  return {
    status: 'reused-from-existing-export',
    artifact: relative(file),
    skills,
  };
}

async function main() {
  assert(fs.existsSync(DATA), `missing TMS273.7 Data: ${DATA}`);
  fs.mkdirSync(ASSET_ROOT, { recursive: true });
  const reader = createReader(DATA);
  try {
    const mainShell = await exportShell(reader, MAIN);
    const expandedShell = await exportShell(reader, EXPANDED, { expanded: true });
    const output = {
      contentVersion: 'tms273-hyper-window',
      sourceVersion: 'TMS273.7',
      source: 'TMS273.7 client WZ',
      status: 'source-backed-entry-and-shells',
      sourceScope: {
        uiImage: 'UI/UIWindow2.img',
        inspectedNodes: [
          'UI/UIWindow2.img/Skill/main',
          'UI/UIWindow2.img/SkillEx/main',
        ],
        hyperNodeSearch: {
          result: 'no-dedicated-hyper-panel-node',
          inspectedNames: ['Skill', 'SkillEx', 'BtHyper', 'BtHyperAni'],
          boundary: 'BtHyper/BtHyperAni are source-backed entry art; panel content/layout is not exposed as UI/Hyper in this WZ tree.',
        },
      },
      entry: {
        hyperSkillIds: HYPER_IDS,
        hyperBookId: '222',
        main: mainShell.hyperEntry,
        expanded: expandedShell.hyperEntry,
      },
      layouts: {
        main: mainShell,
        expandedSkillEx: {
          ...expandedShell,
          relation: 'source-backed SkillEx variant; no explicit WZ link from BtHyper to SkillEx/Hyper was found',
        },
      },
      tabStateSemantics: {
        indexToMinimumLevel: { '0': null, '1': 10, '2': 30, '3': 60, '4': 100, '5': 200, '6': 260 },
        selectedOutlinkNote: 'main selected tabs resolve through UI/_Canvas/UIWindow2.img/Skill/main/Tab/DualTab; preserve resolvedSource per frame.',
        hyperNote: 'Hyper is a bottom entry button, not one of the seven level tabs in this source tree.',
      },
      skillIcons: reusedSkillIcons(),
      researchEvidence: {
        pdf: [
          'references/tms273_research_pack/MapleStory273_Source_Index.pdf#page=2 (coverage)',
          'references/tms273_research_pack/MapleStory273_Source_Index.pdf#page=6 (C06)',
          'references/tms273_research_pack/MapleStory273_Source_Index.pdf#page=8 (sources)',
        ],
        gallery: [
          'references/tms273_research_pack/MapleStory273_Online_Gallery.html#coverage',
          'references/tms273_research_pack/MapleStory273_Online_Gallery.html#C06',
          'references/tms273_research_pack/MapleStory273_Online_Gallery.html#S03',
          'references/tms273_research_pack/MapleStory273_Online_Gallery.html#S04',
        ],
        conclusion: 'The research pack has no TMS273 Hyper window screenshot or verified frame sequence. C06 is a GMS/general skill-list reference; S03/S04 are unextracted videos. It does not override the WZ geometry above.',
      },
      unverified: [
        'separate Hyper page shell and its row/column layout',
        'whether the runtime opens Skill/main or SkillEx/main after clicking BtHyper',
        'runtime tab labels and Hyper skill placement/scroll behavior',
        'Hyper SP authority and learning rules (skill source only supplies IDs/requirements)',
      ],
      sourceFiles: sourceFiles(reader),
    };
    fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      output: relative(OUTPUT_PATH),
      status: output.status,
      entry: { main: [mainShell.hyperEntry.states.normal.width, mainShell.hyperEntry.states.normal.height], expanded: [expandedShell.hyperEntry.states.normal.width, expandedShell.hyperEntry.states.normal.height] },
      windows: { main: mainShell.window, expandedSkillEx: expandedShell.window },
      assetCount: [...reader.pngOutputs.keys()].length,
      sourceFiles: output.sourceFiles.length,
      hyperIds: HYPER_IDS,
    }, null, 2));
  } finally {
    reader.close();
  }
}

if (require.main === module) main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});

module.exports = { main, MAIN, EXPANDED, HYPER_IDS };
