#!/usr/bin/env node
// 验证 `_Canvas` 回退：先用真图源表，再看每部位 action 能否取到画布叶。
const avatar = require('./export_tms273_avatar.cjs');
const { get, isCanvas, leavesFor, loadSourceTables, DEFAULT_SOURCES, STARTER_WEAPON, HEAD, HAIR, zmap } = avatar;

const PART_OF = {
  [DEFAULT_SOURCES.body]: 'body',
  [HEAD]: 'head',
  [HAIR]: 'hair',
  [DEFAULT_SOURCES.shoes]: 'shoes',
  [DEFAULT_SOURCES.pants]: 'pants',
  [STARTER_WEAPON]: 'weapon',
};

(async () => {
  await loadSourceTables();
  console.log(`zmap 装载 ${zmap.size} 层；pants=${zmap.get('pants')} weapon=${zmap.get('weapon')}\n`);
  for (const [image, part] of Object.entries(PART_OF)) {
    for (const action of ['stand1', 'walk1', 'jump', 'sit']) {
      try {
        const leaves = await leavesFor(image, part, action, 0);
        const canvases = leaves.filter(leaf => isCanvas(leaf.object));
        console.log(`${canvases.length ? 'OK  ' : '空  '} ${part.padEnd(7)} ${action.padEnd(6)} 叶=${leaves.length} 画布=${canvases.length}`);
      } catch (error) {
        console.log(`FAIL ${part.padEnd(7)} ${action.padEnd(6)} ${error.message.slice(0, 70)}`);
      }
    }
  }
  avatar.reader.close?.();
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
