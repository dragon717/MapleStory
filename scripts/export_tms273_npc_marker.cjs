#!/usr/bin/env node

// Export the authored TMS273.7 quest-available marker used above an NPC.
// QuestIcon/30 is the source-backed speech bubble containing the orange/red
// exclamation mark. Its four source canvases are static UI states without a
// WZ delay; export frame 0 as a static marker and retain all source metadata.
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
const SOURCE = 'UI/UIWindow2.img/QuestIcon/30';
const SOURCE_FRAME_COUNT = 4;
const EXPORT_FRAME_COUNT = 1;

function primitive(node, name) {
  const value = node?.at?.(name)?.wzValue;
  return value === undefined || value === null ? null : value;
}

function point(node, name) {
  const value = primitive(node, name);
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

function assetPath(url) {
  assert(typeof url === 'string' && url.startsWith('/assets/tms273/'), `invalid asset URL: ${url}`);
  return path.join(ASSETS, url.slice('/assets/tms273/'.length));
}

async function get(reader, source) {
  const node = await reader.get(source);
  if (node instanceof wz.WzImage) assert(await node.parseImage(), source);
  return node;
}

function archiveSources(reader) {
  return [...new Set([...reader.files.keys(), ...reader.images.keys()])]
    .sort()
    .map(sourceFile);
}

async function sourceMetadata(reader, index) {
  const source = `${SOURCE}/${index}`;
  const node = await get(reader, source);
  const origin = point(node, 'origin');
  const rawDelay = primitive(node, 'delay');
  const outlink = primitive(node, '_outlink');
  assert(origin, `${source}: source origin missing`);
  assert(typeof outlink === 'string' && outlink.length > 0, `${source}: source outlink missing`);
  const frame = await reader.frame(source, index < EXPORT_FRAME_COUNT ? ASSETS : null);
  assert(frame.width > 0 && frame.height > 0, `${source}: invalid dimensions`);

  const hasSourceDelay = Number.isFinite(Number(rawDelay)) && Number(rawDelay) > 0;
  if (hasSourceDelay) assert.equal(frame.delay, Number(rawDelay), `${source}: reader delay differs from source delay`);

  const metadata = {
    index,
    source,
    origin,
    x: -origin.x,
    y: -origin.y,
    width: frame.width,
    height: frame.height,
    rawDelay: hasSourceDelay ? Number(rawDelay) : null,
    delaySource: hasSourceDelay ? 'source' : 'missing',
    resolvedSource: frame.resolvedSource,
    outlink,
  };
  if (index >= EXPORT_FRAME_COUNT) return metadata;

  assert(frame.url, `${source}: exported URL missing`);
  const file = assetPath(`/assets/tms273/${frame.url}`);
  assert(fs.existsSync(file), `${source}: PNG missing`);
  assert(!hasSourceDelay, `${source}: static source unexpectedly has a delay`);

  return {
    ...metadata,
    url: `/assets/tms273/${frame.url}`,
    // AssetFrame.delay is required by the client type. A length-one marker
    // never schedules a cycle; zero records that no authored period exists.
    delay: 0,
    bytes: fs.statSync(file).size,
    sha256: sha256(file),
  };
}

async function main() {
  assert(fs.existsSync(DATA), `missing TMS273.7 Data: ${DATA}`);
  fs.mkdirSync(ASSETS, { recursive: true });
  const reader = createReader(DATA);
  try {
    const frames = [];
    const sourceFrames = [];
    for (let index = 0; index < SOURCE_FRAME_COUNT; index++) {
      const metadata = await sourceMetadata(reader, index);
      sourceFrames.push(metadata);
      if (index < EXPORT_FRAME_COUNT) frames.push(metadata);
    }

    const output = {
      contentVersion: 'tms273-npc-marker',
      sourceVersion: 'TMS273.7',
      status: 'complete',
      sourceNode: SOURCE,
      npcQuestAvailable: { frames },
      target: {
        mapId: '001020000',
        lifeId: '001020000-life-1',
        templateId: '10201',
        name: '漢斯',
        role: '法師轉職官',
      },
      provenance: {
        sourceVersion: 'TMS273.7',
        source: 'TMS273.7 client WZ',
        node: SOURCE,
        marker: 'speech-bubble orange/red exclamation mark (static source frame; WZ delay missing)',
        excludedAlternatives: [
          'UI/UIWindow.img/Quest/icon0 (standalone text !)',
          'UI/UIWindow2.img/QuestIcon/0 (lightbulb bubble)',
        ],
        sourceFrames,
        sourceFiles: archiveSources(reader),
      },
    };
    const outputPath = path.join(OUTPUT, 'npc-marker.json');
    fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      output: relative(outputPath),
      sourceNode: SOURCE,
      frames: frames.length,
      sourceFrames: sourceFrames.length,
      origins: frames.map(frame => frame.origin),
      sizes: frames.map(frame => [frame.width, frame.height]),
      delays: frames.map(frame => frame.delay),
      sourceFiles: output.provenance.sourceFiles.length,
    }, null, 2));
  } finally {
    reader.close();
  }
}

if (require.main === module) main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});

module.exports = { main, SOURCE, SOURCE_FRAME_COUNT, EXPORT_FRAME_COUNT };
