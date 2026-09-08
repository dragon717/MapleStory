#!/usr/bin/env node

// Export the verified mage skill assets from the TMS273.7 client data.
// Retain source formulas and derive their level values; combat remains server-owned.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const wz = require('@tybys/wz');
const { createReader } = require('./tms273_wz.cjs');
const { evaluate } = require('./tms273_skill_formulas.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const OUTPUT = path.join(ROOT, 'resources/tms273-export');
const ASSETS = path.join(OUTPUT, 'assets/tms273');
const UNPACKER = path.join(ROOT, 'scripts/unpack_tms273_ms/target/debug/unpack_tms273_ms');
const SKILLS = [
  {
    id: '2001008',
    job: 200,
    image: 'Skill/200.img',
    skillJson: 'Skill/200.json',
    canvasArchive: 'Skill/_Canvas/_Canvas_035.wz',
    bodyAction: 'energyBolt',
    assetKinds: ['icon', 'iconMouseOver', 'iconDisabled', 'effect', 'ball', 'special', 'hit'],
    missingAssetKinds: [],
    unlockReason: 'Skill/200.img only exposes skillList[0]=400021000; no job/level unlock rule is present in this export.',
  },
  {
    id: '2201008',
    job: 220,
    image: 'Skill/220.img',
    skillJson: 'Skill/220.json',
    canvasArchive: 'Skill/_Canvas/_Canvas_040.wz',
    bodyAction: 'coldBeam',
    assetKinds: ['icon', 'iconMouseOver', 'iconDisabled', 'effect', 'effect0', 'hit'],
    missingAssetKinds: ['ball', 'special'],
    unlockReason: 'Skill/220.img does not provide a verified job/level unlock condition in this export.',
  },
  {
    id: '2201005',
    job: 220,
    image: 'Skill/220.img',
    skillJson: 'Skill/220.json',
    canvasArchive: 'Skill/_Canvas/_Canvas_040.wz',
    bodyAction: 'thunderBolt',
    assetKinds: ['icon', 'iconMouseOver', 'iconDisabled', 'effect', 'hit'],
    missingAssetKinds: ['effect0', 'ball', 'special'],
    unlockReason: 'Skill/220.img does not provide a verified job/level unlock condition in this export.',
  },
];
const SKILL_ID = SKILLS[0].id;
const SKILL_IMAGE = SKILLS[0].image;
const SKILL_SOURCE = `Skill/200.img/skill/${SKILL_ID}`;
const BODY_SOURCE = `Character/00002000.img/${SKILLS[0].bodyAction}`;
const STRING_JSON = path.join(ROOT, '参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW/String/Skill.json');

function children(node) {
  return [...(node?.wzProperties || [])];
}

function numeric(node) {
  return children(node).filter(child => /^\d+$/.test(child.name)).sort((a, b) => Number(a.name) - Number(b.name));
}

function primitive(node, name, fallback = null) {
  const value = node?.at?.(name)?.wzValue;
  return ['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'bigint' ? value : fallback;
}

function point(node, name) {
  const value = node?.at?.(name)?.wzValue;
  return value && Number.isFinite(Number(value.x)) && Number.isFinite(Number(value.y))
    ? { x: Number(value.x), y: Number(value.y) }
    : null;
}

function unwrap(value) {
  if (!value || typeof value !== 'object') return value;
  if (value._dirType === 'vector') return { x: value._x, y: value._y };
  if (Object.prototype.hasOwnProperty.call(value, '_value')) return value._value;
  if (value._dirType === 'sub') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== '_dirType').map(([key, child]) => [key, unwrap(child)]));
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, unwrap(child)]));
}

function hasField(node, name) {
  return Boolean(node && Object.prototype.hasOwnProperty.call(node, name));
}

function fieldValue(node, name) {
  return hasField(node, name) ? unwrap(node[name]) : null;
}

function catalogDisplayFlags(rawSkill) {
  const passiveFields = ['psd', 'psdWT', 'psdWeaponBooster'];
  return {
    // These are source-presence markers. They do not decide whether a skill
    // can be learned or whether it belongs to an SP group.
    hasInvisible: hasField(rawSkill, 'invisible'),
    derived: {
      passive: passiveFields.some(field => hasField(rawSkill, field)),
      fixedLevel: hasField(rawSkill, 'fixLevel'),
      skillType: hasField(rawSkill, 'skillType'),
      showFromTheHead: hasField(rawSkill.info, 'showFromTheHead'),
    },
    source: {
      invisible: fieldValue(rawSkill, 'invisible'),
      psd: fieldValue(rawSkill, 'psd'),
      psdWT: fieldValue(rawSkill, 'psdWT'),
      psdWeaponBooster: fieldValue(rawSkill, 'psdWeaponBooster'),
      fixLevel: fieldValue(rawSkill, 'fixLevel'),
      skillType: fieldValue(rawSkill, 'skillType'),
      infoShowFromTheHead: fieldValue(rawSkill.info, 'showFromTheHead'),
    },
  };
}

// Only the four fields consumed by ordinary attack skill descriptions are
// calculated here. No player-stat damage or server hit timing is inferred.
function levelValues(common) {
  const maximum = Number(common.maxLevel);
  assert(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= 100, 'invalid maxLevel');
  return Array.from({ length: maximum }, (_, index) => {
    const level = index + 1;
    const row = { level };
    for (const field of ['mpCon', 'damage', 'mobCount', 'attackCount']) {
      assert(typeof common[field] === 'string', `missing formula: ${field}`);
      const value = evaluate(common[field], level);
      assert(Number.isSafeInteger(value) && value >= 0, `invalid ${field} at level ${level}`);
      row[field] = value;
    }
    return row;
  });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function relative(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function sourceFile(file) {
  const stat = fs.statSync(file);
  return { path: relative(file), bytes: stat.size, sha256: sha256(file) };
}

async function get(reader, source) {
  try {
    const node = await reader.get(source);
    if (node instanceof wz.WzImage) assert(await node.parseImage(), source);
    return node;
  } catch (error) {
    throw new Error(`${source}: ${error.message}`, { cause: error });
  }
}

function runUnpacker(tempRoot, images) {
  assert(fs.existsSync(UNPACKER), `missing Rust MS unpacker: ${UNPACKER}`);
  const result = spawnSync(UNPACKER, [
    '--packs', path.join(DATA, 'Packs'),
    '--out', tempRoot,
    ...images.flatMap(image => ['--image', image]),
  ], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`技能图像解包失败:\n${result.stdout}\n${result.stderr}`);
  const reportPath = path.join(tempRoot, 'manifest.json');
  assert(fs.existsSync(reportPath), `MS unpack manifest missing: ${reportPath}`);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const entries = Object.fromEntries(images.map(image => {
    const entry = report.entries?.find(item => item.image === image && item.status === 'ok');
    assert(entry, `MS unpack did not produce ${image}`);
    assert(fs.existsSync(path.join(tempRoot, image)), `unpacked ${image} missing`);
    return [image, entry];
  }));
  return { report, entries };
}

function linkCanvasArchives(tempRoot, archives) {
  const directory = path.join(tempRoot, 'Skill/_Canvas');
  fs.mkdirSync(directory, { recursive: true });
  for (const archive of archives) {
    assert(fs.existsSync(archive), `missing Canvas source: ${archive}`);
    // ResourceReader selects _Canvas*.wz by the logical _Canvas directory stem.
    fs.symlinkSync(archive, path.join(directory, path.basename(archive)));
  }
}

async function exportFrame(reader, source, kind) {
  const raw = await get(reader, source);
  const frame = await reader.frame(source, ASSETS);
  const assetPath = path.join(ASSETS, frame.url);
  assert(fs.existsSync(assetPath), `asset was not written: ${source}`);
  assert(frame.width > 0 && frame.height > 0, `invalid Canvas dimensions: ${source}`);
  const rawDelay = primitive(raw, 'delay');
  const rawOrigin = point(raw, 'origin');
  const rawOutlink = primitive(raw, '_outlink');
  const missing = [];
  if (!rawOrigin) missing.push('origin');
  if (rawDelay === null) missing.push('delay');
  if (!rawOutlink) missing.push('outlink');
  const staticKind = kind === 'icon' || kind === 'iconMouseOver' || kind === 'iconDisabled';
  const metadataStatus = staticKind && missing.length === 1 && missing[0] === 'delay'
    ? 'static-delay-missing'
    : missing.length ? 'incomplete' : 'complete';
  return {
    source,
    resolvedSource: frame.resolvedSource,
    status: 'exported',
    metadataStatus,
    outlink: rawOutlink,
    origin: rawOrigin,
    delay: rawDelay,
    width: frame.width,
    height: frame.height,
    url: `/assets/tms273/${frame.url}`,
    bytes: fs.statSync(assetPath).size,
    sha256: sha256(assetPath),
  };
}

async function exportCatalogIcons(reader, skillSource, skillNode, skillId, iconGaps) {
  const icons = {};
  const iconKinds = [
    ['icon', 'normal'],
    ['iconMouseOver', 'mouseOver'],
    ['iconDisabled', 'disabled'],
  ];
  const available = new Set(children(skillNode).map(child => child.name));
  for (const [sourceKind, outputKind] of iconKinds) {
    const source = `${skillSource}/${sourceKind}`;
    if (!available.has(sourceKind)) {
      iconGaps.push({
        skill: skillId,
        source,
        group: outputKind,
        status: 'source-missing',
        reason: `${source} is absent from the TMS273.7 Skill image; no icon was fabricated.`,
      });
      icons[outputKind] = null;
      continue;
    }
    icons[outputKind] = await exportFrame(reader, source, sourceKind);
  }
  return icons;
}

async function exportBodyTimeline(reader, source) {
  const node = await get(reader, source);
  const frames = numeric(node).map(frame => {
    const rawFrame = primitive(frame, 'frame');
    const rawDelay = primitive(frame, 'delay');
    return {
      index: Number(frame.name),
      source: `${source}/${frame.name}`,
      action: primitive(frame, 'action'),
      frame: Number.isFinite(Number(rawFrame)) ? Number(rawFrame) : rawFrame,
      delay: Number.isFinite(Number(rawDelay)) ? Number(rawDelay) : rawDelay,
      move: point(frame, 'move'),
    };
  });
  assert(frames.length > 0, `${source} timeline is empty`);
  assert(frames.every(frame => typeof frame.action === 'string' && Number.isFinite(frame.frame) && Number.isFinite(frame.delay)), `${source} timeline is incomplete`);
  return { source, frames };
}

async function exportAssetGroup(reader, skillSource, kind) {
  const source = `${skillSource}/${kind}`;
  const node = await get(reader, source);
  const groups = [];
  for (const child of numeric(node)) {
    const childSource = `${source}/${child.name}`;
    const nested = numeric(child);
    if (nested.length === 0) {
      groups.push(await exportFrame(reader, childSource, kind));
      continue;
    }
    for (const frame of nested) {
      groups.push(await exportFrame(reader, `${childSource}/${frame.name}`, kind));
    }
  }
  assert(groups.length > 0, `${source} has no Canvas frames`);
  return groups;
}

function sourceGap(skillSource, kind, reason) {
  return {
    source: `${skillSource}/${kind}`,
    group: kind,
    status: 'source-missing',
    reason,
  };
}

function missingAssetReason(skillSource, kind) {
  return `${skillSource}/${kind} is absent from the TMS273.7 Skill image; no asset was fabricated.`;
}

function uniqueFiles(files) {
  const seen = new Set();
  return files.filter(file => {
    const key = path.resolve(file);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function main() {
  fs.mkdirSync(ASSETS, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tms273-skill-'));
  let reader;
  let bodyReader;
  try {
    const images = [...new Set(SKILLS.map(skill => skill.image))];
    const extraction = runUnpacker(tempRoot, images);
    const canvasArchives = [...new Set(SKILLS.map(skill => path.join(DATA, skill.canvasArchive)))];
    linkCanvasArchives(tempRoot, canvasArchives);
    reader = createReader(tempRoot, tempRoot);
    // Character/00002000.img is a separate WZ archive. Keep the targeted
    // Skill extraction reader isolated from the original body archive so the
    // MS unpacker never needs to copy or scan unrelated client data.
    bodyReader = createReader(DATA);

    const skillJsonPaths = new Map();
    for (const skill of SKILLS) {
      const file = path.join(ROOT, '参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW', skill.skillJson);
      if (!skillJsonPaths.has(skill.skillJson)) skillJsonPaths.set(skill.skillJson, file);
    }
    const skillJsons = new Map([...skillJsonPaths].map(([name, file]) => [name, JSON.parse(fs.readFileSync(file, 'utf8'))]));
    const stringJson = JSON.parse(fs.readFileSync(STRING_JSON, 'utf8'));
    const bodyArchive = path.join(DATA, 'Character/Character_000.wz');
    const skillOutputs = {};
    const metadataGaps = [];
    const assetGaps = [];
    for (const definition of SKILLS) {
      const skillSource = `${definition.image}/skill/${definition.id}`;
      const rawSkill = skillJsons.get(definition.skillJson)?.skill?.[definition.id];
      const rawString = stringJson[definition.id];
      assert(rawSkill && rawString, `${definition.id} source JSON is missing`);
      const skillNode = await get(reader, skillSource);
      const availableKinds = new Set(children(skillNode).map(child => child.name));
      const assetGroups = {};
      for (const kind of definition.assetKinds) {
        if (!availableKinds.has(kind)) {
          assetGaps.push({ skill: definition.id, ...sourceGap(skillSource, kind, missingAssetReason(skillSource, kind)) });
          continue;
        }
        assetGroups[kind] = kind.startsWith('icon')
          ? [await exportFrame(reader, `${skillSource}/${kind}`, kind)]
          : await exportAssetGroup(reader, skillSource, kind);
      }
      for (const kind of definition.missingAssetKinds) {
        assert(!availableKinds.has(kind), `${skillSource}/${kind} unexpectedly exists; add it to assetKinds`);
        assetGaps.push({ skill: definition.id, ...sourceGap(skillSource, kind, missingAssetReason(skillSource, kind)) });
      }
      const skillMetadataGaps = Object.values(assetGroups).flat().filter(frame => frame.metadataStatus !== 'complete');
      metadataGaps.push(...skillMetadataGaps.map(frame => ({ skill: definition.id, source: frame.source, status: frame.metadataStatus })));
      const timeline = await exportBodyTimeline(bodyReader, `Character/00002000.img/${definition.bodyAction}`);
      const sourceFields = unwrap(rawSkill);
      skillOutputs[definition.id] = {
        id: definition.id,
        job: definition.job,
        name: unwrap(rawString.name),
        source: {
          skillJson: `WZ_JSON_TW/${definition.skillJson}#skill.${definition.id}`,
          stringJson: `WZ_JSON_TW/String/Skill.json#${definition.id}`,
          skillImage: skillSource,
          bodyAction: timeline.source,
        },
        rawWz: { skill: rawSkill, string: rawString },
        sourceFields,
        levelValues: levelValues(sourceFields.common),
        string: unwrap(rawString),
        runtimeUnknowns: [
          {
            field: 'unlockCondition',
            status: 'unverified',
            reason: definition.unlockReason,
          },
          {
            field: 'formulaEvaluation',
            status: 'unimplemented',
            reason: 'Source MP, damage percentage and hit/target counts are evaluated in levelValues; final player-stat damage and runtime execution remain unimplemented.',
          },
          {
            field: 'serverHitTiming',
            status: 'unverified',
            reason: `${definition.bodyAction} is the source body action timeline; server input, hit and cancel windows are not inferred from animation delay.`,
          },
        ],
        bodyTimeline: timeline,
        assets: assetGroups,
      };
    }

    const catalogBooks = {};
    const catalogSkills = {};
    const catalogIconGaps = [];
    const catalogDefinitions = [...new Map(SKILLS.map(skill => [String(skill.job), skill])).values()];
    for (const definition of catalogDefinitions) {
      const bookId = String(definition.job);
      const skillRoot = skillJsons.get(definition.skillJson)?.skill;
      assert(skillRoot, `${definition.skillJson} skill root is missing`);
      const bookString = stringJson[bookId];
      assert(bookString && hasField(bookString, 'bookName'), `${bookId} bookName source is missing`);
      const bookName = unwrap(bookString.bookName);
      catalogBooks[bookId] = {
        id: bookId,
        job: definition.job,
        name: bookName,
        bookName,
        source: {
          skillJson: `WZ_JSON_TW/${definition.skillJson}#skill`,
          stringJson: `WZ_JSON_TW/String/Skill.json#${bookId}`,
        },
        string: unwrap(bookString),
      };

      const skillIds = Object.keys(skillRoot)
        .filter(id => /^\d+$/.test(id))
        .sort((left, right) => Number(left) - Number(right));
      assert.equal(skillIds.length, bookId === '200' ? 8 : 9, `${bookId} catalog node count changed`);
      for (const id of skillIds) {
        const rawSkill = skillRoot[id];
        const rawString = stringJson[id];
        assert(rawSkill && rawString, `${id} catalog source JSON is missing`);
        const skillSource = `${definition.image}/skill/${id}`;
        // A catalog entry is valid only when its actual Skill root exists;
        // icon children may be absent and are then reported explicitly.
        const skillNode = await get(reader, skillSource);
        const sourceFields = {
          common: fieldValue(rawSkill, 'common'),
          maxLevel: fieldValue(rawSkill.common, 'maxLevel'),
          req: fieldValue(rawSkill, 'req'),
          info: fieldValue(rawSkill, 'info'),
          info2: fieldValue(rawSkill, 'info2'),
        };
        catalogSkills[id] = {
          id,
          job: definition.job,
          book: bookId,
          name: fieldValue(rawString, 'name'),
          description: fieldValue(rawString, 'desc'),
          source: {
            skillJson: `WZ_JSON_TW/${definition.skillJson}#skill.${id}`,
            stringJson: `WZ_JSON_TW/String/Skill.json#${id}`,
            skillImage: skillSource,
          },
          rawWz: { skill: rawSkill, string: rawString },
          sourceFields,
          // Keep the source fields addressable without requiring a formula
          // evaluator or a second catalog-specific schema.
          common: sourceFields.common,
          maxLevel: sourceFields.maxLevel,
          req: sourceFields.req,
          info: sourceFields.info,
          info2: sourceFields.info2,
          string: unwrap(rawString),
          displayFlags: catalogDisplayFlags(rawSkill),
          learnability: {
            status: 'unverified',
            reason: 'Skill source has no verified job, unlock or SP learning rule in this catalog; source display markers are not grants.',
          },
          icons: await exportCatalogIcons(reader, skillSource, skillNode, id, catalogIconGaps),
        };
      }
    }

    const sourceArchivePaths = Object.values(extraction.entries).map(entry => path.join(ROOT, entry.archive));
    const sourceFiles = uniqueFiles([
      path.join(ROOT, '参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW/Skill/200.json'),
      STRING_JSON,
      path.join(DATA, 'Packs/Skill_00000.ms'),
      path.join(DATA, 'Skill/_Canvas/_Canvas_035.wz'),
      bodyArchive,
      ...SKILLS.slice(1).map(skill => path.join(ROOT, '参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW', skill.skillJson)),
      ...canvasArchives,
      ...sourceArchivePaths,
    ]).map(sourceFile);
    const firstExtraction = extraction.entries[SKILL_IMAGE];
    const extractionImages = Object.fromEntries(Object.entries(extraction.entries).map(([image, entry]) => [image, {
      archive: entry.archive,
      entryIndex: entry.entry_index,
      bytes: entry.bytes,
    }]));
    const output = {
      contentVersion: 'tms273-skills',
      sourceVersion: 'TMS273.7',
      source: 'TMS273.7 client WZ',
      status: metadataGaps.some(frame => frame.status === 'incomplete') ? 'incomplete' : 'complete',
      metadataGaps,
      assetGaps,
      sourceFiles,
      extraction: {
        image: SKILL_IMAGE,
        archive: firstExtraction.archive,
        entryIndex: firstExtraction.entry_index,
        bytes: firstExtraction.bytes,
        canvasArchive: relative(path.join(DATA, SKILLS[0].canvasArchive)),
        images: extractionImages,
        canvasArchives: Object.fromEntries(canvasArchives.map(file => [path.relative(DATA, file).split(path.sep).join('/'), relative(file)])),
      },
      formulaSemantics: {
        classification: 'R',
        source: 'https://github.com/Kagamia/WzComparerR2/blob/4b691cf55695fd13effdd0ba8f3826a8b6b81552/WzComparerR2.Common/Calculator.cs#L341-L355',
        levelBinding: 'https://github.com/Kagamia/WzComparerR2/blob/4b691cf55695fd13effdd0ba8f3826a8b6b81552/WzComparerR2.Common/CharaSim/SummaryParser.cs#L63',
        x: 'skill level', d: 'floor', u: 'ceil',
        scope: 'Source expressions only; not official server damage or hit timing.',
      },
      catalog: {
        books: catalogBooks,
        skills: catalogSkills,
        iconGaps: catalogIconGaps,
      },
      skills: skillOutputs,
    };
    const outputPath = path.join(OUTPUT, 'skills.json');
    fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      output: outputPath,
      skill: SKILL_ID,
      status: output.status,
      groups: Object.fromEntries(Object.entries(skillOutputs).map(([id, skill]) => [id, Object.fromEntries(Object.entries(skill.assets).map(([key, frames]) => [key, frames.length]))])),
      catalogBooks: Object.keys(catalogBooks).length,
      catalogSkills: Object.keys(catalogSkills).length,
      catalogIconGaps: catalogIconGaps.length,
      metadataGaps: output.metadataGaps.length,
      sourceFiles: sourceFiles.length,
    }, null, 2));
  } finally {
    reader?.close();
    bodyReader?.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });

module.exports = { main, SKILL_ID, SKILL_SOURCE };
