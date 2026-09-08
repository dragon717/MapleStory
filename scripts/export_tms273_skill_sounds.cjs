#!/usr/bin/env node

// Export the skill sounds that are actually present in the TMS273.7 Sound WZ.
// The catalog is intentionally kept separate from the client manifest: this
// file records raw Use/Hit (and any other named child) nodes, including UOL
// aliases and missing nodes, so consumers cannot silently fall back to v83.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const wz = require('@tybys/wz');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const OUTPUT = path.join(ROOT, 'resources/tms273-export');
const ASSETS = path.join(OUTPUT, 'assets/tms273');
const CATALOG_PATH = path.join(OUTPUT, 'skills.json');
const OUTPUT_PATH = path.join(OUTPUT, 'skill-sounds.json');
const SOUND_ROOT = 'Sound/Skill.img';

// These are the executable entries in the 17-skill 200/220 catalog. Passive
// entries remain in the output with an explicit absent source; this prevents a
// missing sound from being mistaken for an omitted skill.
const EXECUTABLE_SKILL_IDS = [
  '2001002', '2001008', '2001009', '2001011', '2001012',
  '2201001', '2201005', '2201008', '2201009',
];

const reader = createReader(DATA);
const sourceFileCache = new Map();

function children(node) {
  return [...(node?.wzProperties || [])];
}

function relativeSource(filePath) {
  return filePath ? path.relative(ROOT, filePath).split(path.sep).join('/') : undefined;
}

function assetName(source, extension) {
  const safe = source.replace(/[^A-Za-z0-9_.-]/g, '_');
  const hash = crypto.createHash('sha1').update(source, 'utf8').digest('hex').slice(0, 10);
  return `${safe}-${hash}.${extension}`;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function resolvedSourceFor(source, baseSource, link) {
  if (!link) return source;
  return path.posix.normalize(`${baseSource}/${link}`);
}

function finiteNumber(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function sourceFileEvidence(filePath) {
  if (!filePath) return undefined;
  const absolute = path.resolve(filePath);
  if (sourceFileCache.has(absolute)) return sourceFileCache.get(absolute);
  const stat = fs.statSync(absolute);
  const digest = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
  const result = { path: relativeSource(absolute), bytes: stat.size, sha256: digest };
  sourceFileCache.set(absolute, result);
  return result;
}

function rawNodeEvidence(rawNode, resolvedNode, link, resolvedSource) {
  const sourceFile = relativeSource(resolvedNode?.wzReader?._path || rawNode?.wzReader?._path);
  const raw = {
    type: rawNode?.constructor?.name || '<unknown>',
    name: rawNode?.name,
    sourceFile,
    resolvedType: resolvedNode?.constructor?.name || '<unknown>',
    resolvedSource,
  };
  if (link) raw.link = link;
  const soundDataLen = finiteNumber(resolvedNode?.soundDataLen);
  const length = finiteNumber(resolvedNode?.length);
  const offset = finiteNumber(resolvedNode?.offs);
  if (soundDataLen !== undefined) raw.soundDataLen = soundDataLen;
  if (length !== undefined) raw.length = length;
  if (offset !== undefined) raw.offset = offset;
  return raw;
}

async function nodeBytes(node) {
  if (!(node instanceof wz.WzBinaryProperty) || typeof node.getBytes !== 'function') return null;
  const value = await node.getBytes();
  return value == null ? null : Buffer.from(value);
}

async function exportNode(rawNode, source, baseSource) {
  let resolvedNode = rawNode;
  let link;
  if (rawNode instanceof wz.WzUOLProperty) {
    link = typeof rawNode.value === 'string' ? rawNode.value : undefined;
    try {
      resolvedNode = rawNode.linkValue;
    } catch (error) {
      return {
        source,
        status: 'undecodable',
        nodeName: rawNode.name,
        raw: rawNodeEvidence(rawNode, null, link, resolvedSourceFor(source, baseSource, link)),
        reason: `UOL 目标解析失败: ${error.message}`,
      };
    }
  }

  const resolvedSource = resolvedSourceFor(source, baseSource, link);
  const raw = rawNodeEvidence(rawNode, resolvedNode, link, resolvedSource);
  const sourceFile = raw.sourceFile;
  let bytes;
  try {
    bytes = await nodeBytes(resolvedNode);
  } catch (error) {
    return { source, status: 'undecodable', nodeName: rawNode.name, raw, reason: `读取声音字节失败: ${error.message}` };
  }
  if (!bytes) {
    return {
      source,
      status: 'undecodable',
      nodeName: rawNode.name,
      raw,
      reason: `节点类型 ${resolvedNode?.constructor?.name || '<unknown>'} 不是声音属性`,
    };
  }

  // WzBinaryProperty.getBytes() returns the embedded MP3 payload. Refuse to
  // create an asset for an unsupported payload rather than inventing a URL.
  const isMp3 = bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  if (!isMp3) {
    return {
      source,
      status: 'undecodable',
      nodeName: rawNode.name,
      raw,
      reason: `声音字节不是可识别的 MP3 帧 (length=${bytes.length})`,
    };
  }

  fs.mkdirSync(ASSETS, { recursive: true });
  const filename = assetName(resolvedSource, 'mp3');
  const outputFile = path.join(ASSETS, filename);
  fs.writeFileSync(outputFile, bytes);
  if (sourceFile) sourceFileEvidence(path.resolve(ROOT, sourceFile));
  return {
    source,
    resolvedSource,
    sourceFile,
    status: 'exported',
    nodeName: rawNode.name,
    url: `/assets/tms273/${filename}`,
    format: 'mp3',
    bytes: bytes.length,
    sha256: sha256(bytes),
    raw,
  };
}

async function exportSkill(id) {
  const base = `${SOUND_ROOT}/${id}`;
  let node;
  try {
    node = await reader.get(base);
  } catch (error) {
    return {
      source: base,
      available: false,
      status: 'missing',
      nodeNames: [],
      reason: `273 WZ 节点不存在: ${error.message}`,
    };
  }

  const result = { source: base, available: true, status: 'complete', nodeNames: [], nodes: {} };
  for (const rawNode of children(node)) {
    const source = `${base}/${rawNode.name}`;
    const entry = await exportNode(rawNode, source, base);
    result.nodeNames.push(rawNode.name);
    result.nodes[rawNode.name] = entry;
    const lowerName = rawNode.name.toLowerCase();
    if (lowerName === 'use' || lowerName === 'hit') result[lowerName] = entry;
  }
  if (result.nodeNames.length === 0) {
    result.available = false;
    result.status = 'missing';
    result.reason = '273 WZ 技能目录存在但没有子节点';
  }
  return result;
}

function catalogSkillIds() {
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const skills = catalog?.catalog?.skills;
  assert(skills && typeof skills === 'object', `catalog.skills missing: ${CATALOG_PATH}`);
  const ids = Object.keys(skills).sort();
  assert.equal(ids.length, 17, `expected 17 catalog skills, got ${ids.length}`);
  for (const id of EXECUTABLE_SKILL_IDS) assert(id in skills, `executable skill missing from catalog: ${id}`);
  return ids;
}

async function main() {
  const ids = catalogSkillIds();
  const skillSounds = {};
  for (const id of ids) skillSounds[id] = await exportSkill(id);

  const sourceFiles = [...sourceFileCache.values()].sort((a, b) => a.path.localeCompare(b.path));
  const executable = new Set(EXECUTABLE_SKILL_IDS);
  const output = {
    contentVersion: 'tms273-skill-sounds',
    sourceVersion: 'TMS273.7',
    source: 'TMS273.7 client WZ / Sound/Skill.img',
    status: 'complete',
    contract: {
      skillSounds: 'skillSounds[id].use/hit are optional source-backed MP3 entries; nodes preserves every exact Sound child name.',
      missing: 'A skill or sound node without a 273 source is represented by available:false/status missing; no URL is fabricated.',
      timing: 'Audio bytes and WZ raw metadata only; animation delay is not server timing.',
    },
    catalogSkillIds: ids,
    executableSkillIds: EXECUTABLE_SKILL_IDS,
    passiveOrTriggeredSkillIds: ids.filter(id => !executable.has(id)),
    sourceFiles,
    skillSounds,
  };
  fs.mkdirSync(OUTPUT, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  const exported = Object.values(skillSounds).flatMap(skill => Object.values(skill.nodes || {}))
    .filter(node => node.status === 'exported');
  console.log(JSON.stringify({
    output: OUTPUT_PATH,
    catalogSkills: ids.length,
    executableSkills: EXECUTABLE_SKILL_IDS.length,
    soundDirectories: Object.values(skillSounds).filter(skill => skill.available).length,
    exportedNodes: exported.length,
    sourceFiles: sourceFiles.map(source => source.path),
  }, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  }).finally(() => reader.close());
}

module.exports = { DATA, OUTPUT, ASSETS, OUTPUT_PATH, main };
