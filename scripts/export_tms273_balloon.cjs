#!/usr/bin/env node

// Export the source-backed map-chat balloon (UI/ChatBalloon.img style 0) that
// appears above a speaking character.  MapleStory renders the balloon as a
// nine-slice shell: four corners, four stretchable edges and a center fill,
// plus a separate `arrow` whose tip points down toward the speaker.  The
// normalized manifest keeps the WZ origin of every slice so the client can
// rebuild the box around a variable-size text area, exactly like the source
// UI (the arrow is not part of the box; it is placed below the bottom edge).
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const wz = require('@tybys/wz');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const OUTPUT = path.join(ROOT, 'resources/tms273-export');
const ASSETS = path.join(OUTPUT, 'assets/tms273');
// Style 0 is the normal map chat bubble (clr -16777216 = black text stroke/edge).
const STYLE = '0';
const BALL = `UI/ChatBalloon.img/${STYLE}`;
const PARTS = ['nw', 'n', 'ne', 'w', 'c', 'e', 'sw', 's', 'se', 'arrow'];

const reader = createReader(DATA);
const exported = new Map();

function resolved(node) {
  const seen = new Set();
  let current = node;
  while (current instanceof wz.WzUOLProperty) {
    assert(!seen.has(current), `UOL cycle at ${node?.name || '<unnamed>'}`);
    seen.add(current);
    current = current.linkValue;
  }
  return current;
}

async function get(source) {
  try {
    const node = await reader.get(source);
    if (node instanceof wz.WzImage) assert(await node.parseImage(), source);
    return node;
  } catch (error) {
    throw new Error(`${source}: ${error.message}`, { cause: error });
  }
}

async function frame(source) {
  if (!exported.has(source)) {
    const result = await reader.frame(source, ASSETS);
    assert(result.url && result.width > 0 && result.height > 0, `invalid Canvas: ${source}`);
    exported.set(source, { ...result, url: `/assets/tms273/${result.url}` });
  }
  return exported.get(source);
}

async function main() {
  fs.mkdirSync(ASSETS, { recursive: true });
  try {
    const style = resolved(await get(BALL));
    const slices = {};
    for (const part of PARTS) {
      const child = resolved(style.at?.(part));
      assert(child instanceof wz.WzCanvasProperty, `${BALL}/${part} is not a Canvas`);
      slices[part] = await frame(`${BALL}/${part}`);
    }
    const clrNode = style.at('clr');
    const output = {
      contentVersion: 'tms273-chatballoon',
      source: 'TMS273.7 client WZ / UI/ChatBalloon.img/0',
      style: STYLE,
      slices,
      clr: typeof clrNode?.wzValue === 'bigint' ? Number(clrNode.wzValue) : clrNode?.wzValue ?? -16777216,
    };
    const outputPath = path.join(OUTPUT, 'balloon.json');
    fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      output: outputPath,
      source: BALL,
      pngs: exported.size,
      parts: PARTS,
      sizes: Object.fromEntries(Object.entries(slices).map(([name, slice]) => [name, `${slice.width}x${slice.height}`])),
    }, null, 2));
  } finally {
    reader.close();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { DATA, OUTPUT, ASSETS, BALL, PARTS, main };
