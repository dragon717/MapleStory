#!/usr/bin/env node

// Export only the source effect sequences needed by the first-job mage.
// Damage, hit timing, and skill execution remain outside this asset export.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const OUTPUT = path.join(ROOT, 'resources/tms273-export/mage-effects.json');
const ASSETS = path.join(ROOT, 'resources/tms273-export/assets/tms273/mage-effects');
const UNPACKER = path.join(ROOT, 'scripts/unpack_tms273_ms/target/debug/unpack_tms273_ms');
const SKILL_EXPORT = path.join(ROOT, 'resources/tms273-export/skills.json');

// 2001012 stores the visible sequence under `special`; it is the only
// effect-class sequence for that skill, so it is normalized to output `effect`.
const SOURCES = {
  '2001002': 'Skill/200.img/skill/2001002/effect',
  '2001009': 'Skill/200.img/skill/2001009/effect',
  '2001011': 'Skill/200.img/skill/2001011/effect',
  '2001012': 'Skill/200.img/skill/2001012/special',
};
const EXTRA_SOURCES = {
  '2201001': {
    effect: 'Skill/220.img/skill/2201001/effect',
  },
  '2201009': {
    tile: 'Skill/220.img/skill/2201009/tile',
    hit: 'Skill/220.img/skill/2201009/hit',
  },
  '2200011': {
    mob: 'Skill/220.img/skill/2200011/mob',
  },
};
const PROJECTED_SKILLS = ['2001008', '2201008', '2201005'];
const PROJECTED_SKILL = PROJECTED_SKILLS[0];
const SKILL_SOURCE_JSON = path.join(ROOT, '参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW/Skill/200.json');
const SKILL_220_SOURCE_JSON = path.join(ROOT, '参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW/Skill/220.json');
const STRING_SOURCE_JSON = path.join(ROOT, '参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW/String/Skill.json');
const PACK_SOURCE = path.join(DATA, 'Packs/Skill_00000.ms');
const PACK_220_SOURCE = path.join(DATA, 'Packs/Skill_00001.ms');
const CANVAS_SOURCE = path.join(DATA, 'Skill/_Canvas/_Canvas_035.wz');
const CANVAS_220_SOURCE = path.join(DATA, 'Skill/_Canvas/_Canvas_040.wz');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function relative(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function sourceFile(file) {
  assert(fs.existsSync(file), `missing source file: ${file}`);
  const stat = fs.statSync(file);
  return { path: relative(file), bytes: stat.size, sha256: sha256(file) };
}

function children(node) {
  return [...(node?.wzProperties || [])];
}

function numericChildren(node) {
  return children(node)
    .filter(child => /^\d+$/.test(child.name))
    .sort((left, right) => Number(left.name) - Number(right.name));
}

function primitive(node, name) {
  const value = node?.at?.(name)?.wzValue;
  return ['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'bigint'
    ? value
    : null;
}

function point(node, name) {
  const value = node?.at?.(name)?.wzValue;
  return value && Number.isFinite(Number(value.x)) && Number.isFinite(Number(value.y))
    ? { x: Number(value.x), y: Number(value.y) }
    : null;
}

function displayDelay(rawDelay) {
  if (rawDelay === null || rawDelay === undefined || rawDelay === '') return 0;
  const value = Number(rawDelay);
  return Number.isFinite(value) ? Math.abs(value) : 0;
}

function linkCanvasArchives(tempRoot) {
  const targetDir = path.join(tempRoot, 'Skill/_Canvas');
  fs.mkdirSync(targetDir, { recursive: true });
  for (const source of [CANVAS_SOURCE, CANVAS_220_SOURCE]) {
    assert(fs.existsSync(source), `missing Canvas source: ${source}`);
    fs.symlinkSync(source, path.join(targetDir, path.basename(source)));
  }
}

function unpackSkillImages(tempRoot) {
  assert(fs.existsSync(UNPACKER), `missing Rust MS unpacker: ${UNPACKER}`);
  const images = ['Skill/200.img', 'Skill/220.img'];
  const result = spawnSync(UNPACKER, [
    '--packs', path.join(DATA, 'Packs'),
    '--out', tempRoot,
    ...images.flatMap(image => ['--image', image]),
  ], { encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Skill image unpack failed:\n${result.stdout}\n${result.stderr}`);
  const reportPath = path.join(tempRoot, 'manifest.json');
  assert(fs.existsSync(reportPath), `missing unpack manifest: ${reportPath}`);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const entries = Object.fromEntries(images.map(image => {
    const entry = report.entries?.find(item => item.image === image && item.status === 'ok');
    assert(entry && fs.existsSync(path.join(tempRoot, image)), `${image} was not unpacked`);
    return [image, entry];
  }));
  return entries;
}

async function collectFrameSources(reader, source, node = null) {
  const current = node || await reader.get(source);
  const nested = numericChildren(current);
  if (nested.length === 0) return [source];
  const result = [];
  for (const child of nested) {
    result.push(...await collectFrameSources(reader, `${source}/${child.name}`, child));
  }
  return result;
}

async function exportFrame(reader, source) {
  const raw = await reader.get(source);
  const frame = await reader.frame(raw, ASSETS);
  assert(frame.url, `missing PNG for ${source}`);
  const file = path.join(ASSETS, frame.url);
  assert(fs.existsSync(file), `PNG was not written: ${source}`);

  const origin = point(raw, 'origin') || frame.origin || null;
  const x = origin ? -origin.x : 0;
  const y = origin ? -origin.y : 0;
  const rawDelay = primitive(raw, 'delay');
  const outlink = primitive(raw, '_outlink');
  return {
    url: `/assets/tms273/mage-effects/${frame.url}`,
    x,
    y,
    width: frame.width,
    height: frame.height,
    delay: displayDelay(rawDelay),
    rawDelay,
    origin,
    source,
    outlink,
    resolvedSource: frame.resolvedSource,
    sha256: sha256(file),
  };
}

async function exportSourceGroups(reader, skillId, groups) {
  const output = { source: {} };
  for (const [kind, source] of Object.entries(groups)) {
    const sourceNode = await reader.get(source);
    const frameSources = await collectFrameSources(reader, source, sourceNode);
    assert(frameSources.length > 0, `${source} has no numeric animation frames`);
    output[kind] = [];
    output.source[kind] = source;
    for (const frameSource of frameSources) output[kind].push(await exportFrame(reader, frameSource));
  }
  assert(Object.keys(output).length > 1, `${skillId} has no exported groups`);
  return output;
}

function projectExistingFrame(frame) {
  const origin = frame.origin || null;
  const x = origin ? -Number(origin.x) : 0;
  const y = origin ? -Number(origin.y) : 0;
  const rawDelay = frame.rawDelay ?? frame.delay ?? null;
  return {
    url: frame.url,
    x,
    y,
    width: frame.width,
    height: frame.height,
    delay: displayDelay(rawDelay),
    rawDelay,
    origin,
    source: frame.source,
    outlink: frame.outlink ?? null,
    resolvedSource: frame.resolvedSource ?? null,
    sha256: frame.sha256,
  };
}

async function main() {
  fs.mkdirSync(ASSETS, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tms273-mage-effects-'));
  let reader;
  try {
    const extraction = unpackSkillImages(tempRoot);
    linkCanvasArchives(tempRoot);
    reader = createReader(tempRoot, tempRoot);

    const skillEffects = {};
    for (const [skillId, source] of Object.entries(SOURCES)) {
      const sourceNode = await reader.get(source);
      const frameSources = await collectFrameSources(reader, source, sourceNode);
      assert(frameSources.length > 0, `${source} has no numeric animation frames`);
      skillEffects[skillId] = {
        effect: [],
        source: { effect: source },
      };
      for (const frameSource of frameSources) {
        skillEffects[skillId].effect.push(await exportFrame(reader, frameSource));
      }
    }

    for (const [skillId, groups] of Object.entries(EXTRA_SOURCES)) {
      skillEffects[skillId] = await exportSourceGroups(reader, skillId, groups);
    }

    const existing = JSON.parse(fs.readFileSync(SKILL_EXPORT, 'utf8'));
    for (const skillId of PROJECTED_SKILLS) {
      const projected = existing.skills?.[skillId];
      assert(projected, `${SKILL_EXPORT} has no ${skillId} skill output`);
      skillEffects[skillId] = {
        effect: (projected.assets?.effect || []).map(projectExistingFrame),
        hit: (projected.assets?.hit || []).map(projectExistingFrame),
        ball: (projected.assets?.ball || []).map(projectExistingFrame),
        source: { projection: relative(SKILL_EXPORT) },
      };
      assert(skillEffects[skillId].effect.length > 0, `projected ${skillId} effect is empty`);
    }

    const output = {
      contentVersion: 'tms273-mage-effects',
      sourceVersion: 'TMS273.7',
      sourceFiles: [
        sourceFile(SKILL_SOURCE_JSON),
        sourceFile(SKILL_220_SOURCE_JSON),
        sourceFile(STRING_SOURCE_JSON),
        sourceFile(PACK_SOURCE),
        sourceFile(PACK_220_SOURCE),
        sourceFile(CANVAS_SOURCE),
        sourceFile(CANVAS_220_SOURCE),
        sourceFile(SKILL_EXPORT),
      ],
      extraction: {
        image: 'Skill/200.img',
        archive: extraction['Skill/200.img'].archive,
        entryIndex: extraction['Skill/200.img'].entry_index,
        bytes: extraction['Skill/200.img'].bytes,
        canvasArchive: relative(CANVAS_SOURCE),
        images: Object.fromEntries(Object.entries(extraction).map(([image, entry]) => [image, {
          archive: entry.archive,
          entryIndex: entry.entry_index,
          bytes: entry.bytes,
        }])),
        canvasArchives: {
          [relative(CANVAS_SOURCE)]: relative(CANVAS_SOURCE),
          [relative(CANVAS_220_SOURCE)]: relative(CANVAS_220_SOURCE),
        },
      },
      skillEffects,
    };
    fs.writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      output: relative(OUTPUT),
      sourceVersion: output.sourceVersion,
      skills: Object.fromEntries(Object.entries(skillEffects).map(([id, value]) => [id, {
        effect: value.effect?.length || 0,
        hit: value.hit?.length || 0,
        ball: value.ball?.length || 0,
        tile: value.tile?.length || 0,
        mob: value.mob?.length || 0,
      }])),
      pngs: Object.values(skillEffects).flatMap(value => Object.values(value)
        .filter(frames => Array.isArray(frames))
        .flat()).filter(frame => frame.url.includes('/mage-effects/')).length,
    }, null, 2));
  } finally {
    reader?.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

module.exports = { main, SOURCES, PROJECTED_SKILL };
