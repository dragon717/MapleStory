#!/usr/bin/env node
// Per-item check runner for `npm run check`.
//
// The previous `check` script chained every check with `&&`, so the first
// failure (features/npc/dialogue.check.mjs) silently hid the remaining
// items.  This runner executes every check, streams each item's output,
// prints a pass/fail summary, and exits non-zero when ANY item fails.
// The order mirrors the historical chain; flags are per-item because some
// checks rely on --experimental-strip-types / --experimental-transform-types.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const clientRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const checks = [
  ['features/player/animation.check.ts', ['--experimental-strip-types']],
  ['scenes/layer-animation.check.ts', ['--experimental-strip-types']],
  ['features/hud/gauge.check.ts', ['--experimental-transform-types']],
  ['app/i18n.check.ts', ['--experimental-strip-types']],
  ['features/ui/window-shell.check.mjs', []],
  ['features/hud/buff.check.mjs', []],
  ['features/player/input.check.mjs', []],
  ['features/world/minimap.check.mjs', []],
  ['features/inventory/view-model.check.mjs', []],
  ['features/inventory/tooltip-view.check.mjs', []],
  ['network/session.check.mjs', []],
  ['features/npc/dialogue.check.mjs', []],
  ['features/skills/view.check.mjs', []],
  ['features/npc/view.check.mjs', []],
  ['features/combat/skill.check.mjs', []],
  ['features/character/view.check.mjs', []],
  ['features/loading/view.check.mjs', []],
  ['features/player/levelup.check.mjs', []],
  ['features/world/water.check.mjs', []],
  ['features/world/reactor.check.mjs', []],
];

const results = [];
for (const [file, flags] of checks) {
  const label = `node ${flags.join(' ')} src/${file}`.replace(/\s+/g, ' ');
  process.stdout.write(`\n=== ${label} ===\n`);
  const result = spawnSync(process.execPath, [...flags, path.join(clientRoot, 'src', file)], {
    cwd: clientRoot,
    stdio: 'inherit',
  });
  results.push({ label, ok: result.status === 0, status: result.status });
}

const failed = results.filter(item => !item.ok);
console.log(`\n=== check summary: ${results.length - failed.length}/${results.length} passed ===`);
for (const item of results) {
  console.log(`  ${item.ok ? 'PASS' : 'FAIL'}  ${item.label}`);
}
if (failed.length > 0) {
  console.error(`\ncheck failed: ${failed.length} item(s) failed (see output above).`);
  process.exit(1);
}
console.log('\nAll checks passed.');
