#!/usr/bin/env node

// Export the small set of TMS273 Canvas frames used by Windbell Island.
//
// The split TMS273 archives keep the primary WZ files beside a second set of
// `_Canvas` archives.  ResourceReader expects those archives to be visible in
// a logical imageRoot, so this script creates a temporary symlink view and
// leaves the source/origin/delay values in the generated catalog.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createReader } = require('../tms273_wz.cjs');

const root = path.resolve(__dirname, '../..');
const data = path.join(root, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const exportRoot = path.join(root, 'resources/tms273-export');
const exportAssets = path.join(exportRoot, 'windbell-2d');
const publicRoot = path.join(root, 'client/public-tms273/assets/windbell/tms273');
const catalogPath = path.join(exportRoot, 'windbell-2d.json');
const publicCatalogPath = path.join(root, 'client/public-tms273/assets/windbell/tms273.json');

const specs = {
  // Six real Canvas frames from the Maple Island burning-house fire layer.
  // They are bright flame/smoke sprites rather than the dark Camp lighting mask.
  fire: [
    ...Array.from({ length: 6 }, (_, index) => `Map/Obj/acc1.img/mapleIsland/burningHouse4/2/${index}`),
  ],
  // These are static pale cloud variants, not an animation. The scene may use
  // cloud[0] repeatedly, while retaining the alternatives for composition.
  cloud: [
    'Map/Obj/2025DimensionTower.img/2023ForestBlast/back/cloud1/0',
    'Map/Obj/2025DimensionTower.img/2023ForestBlast/back/cloud4_Y/0',
    'Map/Obj/2025DimensionTower.img/2023ForestBlast/back/cloud5_Y/0',
    'Map/Obj/19thEvent.img/obj/cloud/3/0',
    'Map/Obj/19thEvent.img/obj/cloud/4/0',
  ],
  bridge: ['Map/Tile/woodBridge.img/enH0/0'],
  ground: ['Map/Tile/grassySoil.img/enH0/0'],
  rock: ['Map/Obj/acc1.img/dryRock/nature/18/0'],
  rope: ['Map/Obj/connect.img/rope/0/3/0'],
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
    const sourceDir = path.join(data, 'Map', category);
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

function cleanOutput() {
  mkdir(exportAssets);
  mkdir(publicRoot);
}

function assertFrame(frame, category, source) {
  if (!(frame.width > 0 && frame.height > 0 && frame.delay > 0)) {
    throw new Error(`TMS273 ${category} 帧尺寸或 delay 无效: ${source}`);
  }
  if (!Number.isFinite(frame.origin?.x) || !Number.isFinite(frame.origin?.y)) {
    throw new Error(`TMS273 ${category} 帧 origin 无效: ${source}`);
  }
}

function frameWithCatalogUrl(frame, category) {
  const file = path.basename(frame.url);
  return {
    ...frame,
    url: `/assets/windbell/tms273/${category}/${file}`,
    sourceArchive: 'TMS273.7/Data',
  };
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'windbell-tms273-'));
  let reader;
  const itemFrames = JSON.parse(fs.readFileSync(path.join(exportRoot, 'item-images.json'), 'utf8'));
  const catalog = { branch: ['4000003', '4000018'].map(id => {
    const frame = itemFrames[id];
    if (!frame || !fs.existsSync(path.join(root, 'client/public-tms273', frame.url))) throw new Error(`Missing TMS273 fuel item ${id}`);
    return { ...frame, sourceArchive: 'TMS273.7/Data' };
  }) };
  try {
    cleanOutput();
    createArchiveView(tempRoot);
    reader = createReader(tempRoot, tempRoot);
    for (const [category, sources] of Object.entries(specs)) {
      const targetDir = path.join(exportAssets, category);
      const publicDir = path.join(publicRoot, category);
      mkdir(targetDir);
      mkdir(publicDir);
      catalog[category] = [];
      for (const source of sources) {
        const frame = await reader.frame(source, targetDir);
        assertFrame(frame, category, source);
        const generated = path.join(targetDir, frame.url);
        const result = frameWithCatalogUrl(frame, category);
        fs.copyFileSync(generated, path.join(publicDir, path.basename(generated)));
        catalog[category].push(result);
      }
    }
  } finally {
    reader?.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  const json = `${JSON.stringify(catalog, null, 2)}\n`;
  fs.writeFileSync(catalogPath, json, 'utf8');
  fs.writeFileSync(publicCatalogPath, json, 'utf8');
  console.log(`TMS273 Windbell catalog: ${catalogPath}`);
  for (const [category, frames] of Object.entries(catalog)) {
    console.log(`${category}: ${frames.length} frame(s)`);
  }
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
