#!/usr/bin/env node

// Export the small set of source-backed connectors used by the Colossus scene.
// The WZ tree is exposed through a temporary archive view so that ResourceReader
// can follow the parallel `_Canvas` archives and keep the authored origin/delay.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const EXPORT_ROOT = path.join(ROOT, 'resources/scenes/colossus/connections');
const PUBLIC_ROOT = path.join(ROOT, 'client/public-tms273/assets/colossus/connections');
const SOURCE = 'TMS273.7/Data';
const SOURCE_VERSION = 'TMS273.7';
const PUBLIC_PREFIX = '/assets/colossus/connections';

// Keep the first pass small and composable. Every path ends at a real Canvas
// node; no manifest entry is made for a structural WZ node without pixels.
const SPECS = {
  flag: [
    'Map/Obj/flag_Obj.img/flag/daytime/0/0',
    'Map/Obj/flag_Obj.img/flag/daytime/3/0',
  ],
  vine: [
    'Map/Obj/acc3.img/skyStation/ivy/0/0',
    'Map/Obj/acc3.img/skyStation/ivy/10/0',
    'Map/Obj/acc3.img/skyStation/ivy/19/0',
  ],
  rope: [
    'Map/Obj/connect.img/rope/0/3/0',
    'Map/Obj/connect.img/rope/0/1/0',
  ],
  ladder: [
    'Map/Obj/connect.img/ladder/0/4/0',
  ],
  bridge: [
    'Map/Tile/woodBridge.img/enH0/0',
    'Map/Tile/woodBridge.img/enH0/1',
    'Map/Tile/woodBridge.img/enH0/2',
    'Map/Tile/woodBridge.img/enH1/0',
    'Map/Tile/woodBridge.img/enH1/1',
    'Map/Tile/woodBridge.img/enH1/2',
    'Map/Tile/woodBridge.img/edU/0',
    'Map/Tile/woodBridge.img/edD/0',
  ],
};

function mkdir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function link(source, target) {
  mkdir(path.dirname(target));
  try { fs.unlinkSync(target); } catch { /* first run */ }
  fs.symlinkSync(source, target);
}

function createArchiveView(tempRoot) {
  for (const category of ['Obj', 'Back', 'Tile']) {
    const sourceDir = path.join(DATA, 'Map', category);
    const targetDir = path.join(tempRoot, 'Map', category);
    mkdir(targetDir);

    for (const name of fs.readdirSync(sourceDir).filter(name => /\.wz$/i.test(name))) {
      link(path.join(sourceDir, name), path.join(targetDir, name));
    }

    const sourceCanvas = path.join(sourceDir, '_Canvas');
    const targetCanvas = path.join(targetDir, '_Canvas');
    mkdir(targetCanvas);
    for (const name of fs.readdirSync(sourceCanvas).filter(name => /\.wz$/i.test(name))) {
      link(path.join(sourceCanvas, name), path.join(targetCanvas, name));
    }
  }
}

function cleanOutputs() {
  fs.rmSync(EXPORT_ROOT, { recursive: true, force: true });
  fs.rmSync(PUBLIC_ROOT, { recursive: true, force: true });
  mkdir(EXPORT_ROOT);
  mkdir(PUBLIC_ROOT);
}

function assertFrame(frame, category, source, file) {
  if (!(frame.width > 0 && frame.height > 0 && frame.delay > 0)) {
    throw new Error(`TMS273 ${category} 帧尺寸或 delay 无效: ${source}`);
  }
  if (!Number.isFinite(frame.origin?.x) || !Number.isFinite(frame.origin?.y)) {
    throw new Error(`TMS273 ${category} 帧 origin 无效: ${source}`);
  }
  if (!fs.existsSync(file) || fs.statSync(file).size < 24) {
    throw new Error(`TMS273 ${category} 缺少真实 PNG: ${source}`);
  }
  const signature = fs.readFileSync(file).subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') {
    throw new Error(`TMS273 ${category} 输出不是 PNG: ${file}`);
  }
}

function publicFrame(frame, category) {
  const file = path.basename(frame.url);
  return {
    ...frame,
    file: `${category}/${file}`,
    url: `${PUBLIC_PREFIX}/${category}/${file}`,
    sourceArchive: SOURCE,
    sourceVersion: SOURCE_VERSION,
  };
}

function writeManifest(manifest) {
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(path.join(EXPORT_ROOT, 'manifest.json'), json, 'utf8');
  fs.writeFileSync(path.join(PUBLIC_ROOT, 'manifest.json'), json, 'utf8');
}

async function main() {
  if (!fs.existsSync(DATA)) throw new Error(`missing TMS273.7 Data: ${DATA}`);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'colossus-connections-'));
  let reader;
  const props = Object.fromEntries(Object.keys(SPECS).map(category => [category, []]));
  const missing = [];

  try {
    cleanOutputs();
    createArchiveView(tempRoot);
    reader = createReader(tempRoot, tempRoot);

    for (const [category, sources] of Object.entries(SPECS)) {
      const exportDir = path.join(EXPORT_ROOT, category);
      const publicDir = path.join(PUBLIC_ROOT, category);
      mkdir(exportDir);
      mkdir(publicDir);

      for (const source of sources) {
        try {
          const frame = await reader.frame(source, exportDir);
          const generated = path.join(exportDir, frame.url);
          assertFrame(frame, category, source, generated);
          fs.copyFileSync(generated, path.join(publicDir, path.basename(generated)));
          props[category].push(publicFrame(frame, category));
        } catch (error) {
          // Keep the category explicit while making source gaps reviewable. A
          // missing WZ node never becomes a fake JSON-only frame.
          missing.push({ category, source, reason: String(error?.message || error) });
        }
      }
    }
  } finally {
    reader?.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  const manifest = {
    schemaVersion: 1,
    kind: 'tms273-colossus-connections',
    source: SOURCE,
    sourceVersion: SOURCE_VERSION,
    props,
    missing,
    provenance: {
      dataRoot: '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data',
      reader: 'scripts/tms273_wz.cjs',
      pixelPolicy: 'Only decoded Canvas PNG frames are included; structural nodes are omitted.',
      notes: {
        flag: 'Red daytime banner/pennant candidates; no blue-only substitute required.',
        vine: 'Original ivy variants from Map/Obj/acc3.img.',
        rope: 'Original repeatable connect rope segments.',
        ladder: 'Original rope ladder segment from connect ladder/0/4.',
        bridge: 'Original woodBridge horizontal span, underside, and end pieces.',
      },
    },
  };
  writeManifest(manifest);

  console.log(JSON.stringify({
    output: 'resources/scenes/colossus/connections/manifest.json',
    publicOutput: 'client/public-tms273/assets/colossus/connections/manifest.json',
    counts: Object.fromEntries(Object.entries(props).map(([category, frames]) => [category, frames.length])),
    missing: missing.length,
  }, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { main, SPECS };
