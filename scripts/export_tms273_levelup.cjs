#!/usr/bin/env node

// Export the source-backed TMS273 level-up effect and its game sound.
// LevelUp and LevelUp2 are authored as separate synchronized layers; keep
// them separate so the caller can preserve each WZ timeline and origin.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const wz = require('@tybys/wz');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const OUTPUT = path.join(ROOT, 'resources/tms273-export/levelup.json');
const EXPORT_ROOT = path.dirname(OUTPUT);
const ASSETS = path.join(ROOT, 'resources/tms273-export/assets/tms273/levelup');
const ASSET_PREFIX = '/assets/tms273/levelup/';
const EFFECT_SOURCES = [
  { key: 'LevelUp', source: 'Effect/BasicEff.img/LevelUp' },
  { key: 'LevelUp2', source: 'Effect/BasicEff.img/LevelUp2' },
];
const SOUND_SOURCE = 'Sound/Game.img/LevelUp';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

function relative(file) {
  return path.relative(ROOT, path.resolve(file)).split(path.sep).join('/');
}

function sourceFile(file) {
  const absolute = path.resolve(file);
  assert(fs.existsSync(absolute), `missing source file: ${absolute}`);
  const stat = fs.statSync(absolute);
  return { path: relative(absolute), bytes: stat.size, sha256: sha256File(absolute) };
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

function assetName(source, extension) {
  const safe = source.replace(/[^A-Za-z0-9_.-]/g, '_');
  const digest = crypto.createHash('sha1').update(source, 'utf8').digest('hex').slice(0, 10);
  return `${safe}-${digest}.${extension}`;
}

function addSourceFile(files, file) {
  if (!file) return;
  const absolute = path.resolve(file);
  files.set(absolute, sourceFile(absolute));
}

function addFrameAlpha(frame, result) {
  for (const key of ['alpha', 'a0', 'a1']) {
    if (result[key] !== undefined && result[key] !== null) frame[key] = result[key];
  }
}

async function exportFrame(reader, source, sourceFiles) {
  const raw = await reader.get(source);
  const resolved = await reader.resolveFrame(raw);
  for (const item of resolved.chain) addSourceFile(sourceFiles, item.meta.filePath);

  const result = await reader.frame(raw, ASSETS);
  assert(result.url, `missing PNG for ${source}`);
  const outputFile = path.join(ASSETS, result.url);
  assert(fs.existsSync(outputFile), `PNG was not written: ${source}`);
  const origin = point(raw, 'origin') || result.origin;
  const frame = {
    url: `${ASSET_PREFIX}${result.url}`,
    x: result.x,
    y: result.y,
    width: result.width,
    height: result.height,
    delay: result.delay,
    rawDelay: primitive(raw, 'delay'),
    origin,
    source,
    outlink: primitive(raw, '_outlink'),
    resolvedSource: result.resolvedSource,
    sha256: sha256File(outputFile),
  };
  addFrameAlpha(frame, result);
  return frame;
}

async function exportLayer(reader, source, sourceFiles) {
  const node = await reader.get(source);
  if (node instanceof wz.WzImage) await node.parseImage();
  const frames = numericChildren(node);
  assert(frames.length > 0, `${source} has no numeric frames`);
  const exported = [];
  for (const child of frames) exported.push(await exportFrame(reader, `${source}/${child.name}`, sourceFiles));
  return exported;
}

async function exportSound(reader, source, sourceFiles) {
  const node = await reader.get(source);
  assert(typeof node.getBytes === 'function', `${source} is not a binary sound node`);
  const bytes = Buffer.from(await node.getBytes());
  assert(bytes.length > 0, `${source} is empty`);
  assert(bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0, `${source} is not an MP3 payload`);
  addSourceFile(sourceFiles, node.wzReader?._path);
  const filename = assetName(source, 'mp3');
  const outputFile = path.join(ASSETS, filename);
  fs.mkdirSync(ASSETS, { recursive: true });
  fs.writeFileSync(outputFile, bytes);
  return {
    url: `${ASSET_PREFIX}${filename}`,
    source,
    format: 'mp3',
    bytes: bytes.length,
    sha256: sha256(bytes),
  };
}

function checkManifest() {
  const data = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
  assert.equal(data.sourceVersion, 'TMS273.7');
  assert.deepEqual(data.layerSources, EFFECT_SOURCES.map(({ key, source }) => ({ key, source })));
  assert.deepEqual(data.layerFrameCounts, [21, 23]);
  assert.equal(data.layers?.length, 2);
  assert.equal(data.layers[0].length, 21);
  assert.equal(data.layers[1].length, 23);
  assert.equal(data.layers[0][0].rawDelay, 500);
  assert(data.layers[0].slice(1).every(frame => frame.rawDelay === 90 && frame.delay === 90));
  assert(data.layers[1].every(frame => frame.rawDelay === null && frame.delay === 100));
  for (const layer of data.layers) for (const frame of layer) {
    assert(frame.url.startsWith(ASSET_PREFIX), frame.url);
    const file = path.join(EXPORT_ROOT, frame.url.slice(1));
    assert(fs.existsSync(file), `missing frame asset: ${frame.url}`);
    assert.equal(sha256File(file), frame.sha256, `frame fingerprint changed: ${frame.url}`);
    assert(frame.source && frame.resolvedSource && frame.origin, 'frame source metadata missing');
  }
  assert.equal(data.sound?.source, SOUND_SOURCE);
  const soundFile = path.join(EXPORT_ROOT, data.sound.url.slice(1));
  assert(fs.existsSync(soundFile), `missing sound asset: ${data.sound.url}`);
  assert.equal(sha256File(soundFile), data.sound.sha256, 'sound fingerprint changed');
  for (const source of data.sourceFiles) {
    const file = path.join(ROOT, source.path);
    assert(fs.existsSync(file), `missing source archive: ${source.path}`);
    assert.equal(fs.statSync(file).size, source.bytes, `source archive size changed: ${source.path}`);
    assert.equal(sha256File(file), source.sha256, `source archive fingerprint changed: ${source.path}`);
  }
  console.log(JSON.stringify({ check: 'tms273-levelup', output: relative(OUTPUT), layers: data.layerFrameCounts, sourceFiles: data.sourceFiles, sound: data.sound }, null, 2));
}

async function main() {
  if (process.argv.includes('--check')) return checkManifest();
  fs.mkdirSync(ASSETS, { recursive: true });
  const reader = createReader(DATA);
  const sourceFiles = new Map();
  try {
    const layers = [];
    for (const { source } of EFFECT_SOURCES) layers.push(await exportLayer(reader, source, sourceFiles));
    const sound = await exportSound(reader, SOUND_SOURCE, sourceFiles);
    const output = {
      contentVersion: 'tms273-levelup',
      sourceVersion: 'TMS273.7',
      source: 'TMS273.7 client WZ / Effect/BasicEff.img and Sound/Game.img',
      layerSources: EFFECT_SOURCES,
      layerFrameCounts: layers.map(layer => layer.length),
      layers,
      sound,
      sourceFiles: [...sourceFiles.values()].sort((left, right) => left.path.localeCompare(right.path)),
    };
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      output: relative(OUTPUT),
      layers: output.layerFrameCounts,
      sound: sound.source,
      sourceFiles: output.sourceFiles.map(file => file.path),
    }, null, 2));
  } finally {
    reader.close();
  }
}

if (require.main === module) main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});

module.exports = { DATA, OUTPUT, ASSETS, EFFECT_SOURCES, SOUND_SOURCE, main, checkManifest };
