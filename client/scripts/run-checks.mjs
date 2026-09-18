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
  ['assets/preload-plan.check.mjs', []],
  ['assets/lazy-texture.check.mjs', []],
  ['assets/asset-index.check.mjs', []],
  ['features/windbell/runtime.check.mjs', []],
  ['app/page-shell.check.mjs', []],
  ['features/ui/window-shell.check.mjs', []],
  ['features/hud/buff.check.mjs', []],
  ['features/player/input.check.mjs', []],
  ['features/keybindings/model.check.mjs', []],
  ['features/world/minimap.check.mjs', []],
  ['features/world/worldmap.check.mjs', []],
  ['features/inventory/view-model.check.mjs', []],
  ['features/inventory/intents.check.mjs', []],
  ['features/inventory/tooltip-view.check.mjs', []],
  ['features/inventory/drag-controller.check.mjs', []],
  ['features/inventory/equipment-view.check.mjs', []],
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
  ['features/quest/log.check.mjs', []],
  ['features/notebook/view-model.check.mjs', []],
  ['features/notebook/view.check.mjs', ['--experimental-strip-types']],
  ['features/client-actions/update-service.check.ts', ['--experimental-strip-types']],
  ['features/client-actions/desktop-downloads.check.ts', ['--experimental-strip-types']],
  ['features/net-motion/motion-interpolator.check.mjs', []],
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

// Repo-level gate (R10): cross-domain import / dependency-cycle audit.
// Runs from the repository root because the audit scans the whole repo
// (client/src + shared + server) and writes artifacts/refactor/*.json.
// A non-zero exit here blocks `npm run check` just like any other item.
const auditLabel = 'node scripts/refactor_audit.cjs --deps --check (repo root)';
process.stdout.write(`\n=== ${auditLabel} ===\n`);
const audit = spawnSync(
  process.execPath,
  [path.join(clientRoot, '..', 'scripts', 'refactor_audit.cjs'), '--deps', '--check'],
  { cwd: path.join(clientRoot, '..'), stdio: 'inherit' },
);
results.push({ label: auditLabel, ok: audit.status === 0, status: audit.status });

for (const file of ['check_repository_layout.cjs', 'check_protocol_errors.cjs', 'check_inventory_surface.cjs', 'check_tms273_remaster.cjs', 'check_tms273_notebook.cjs', 'check_tms273_npc_dialogue.cjs', 'check_tms273_npc_scripts.cjs', 'check_tms273_player_status.cjs', 'check_tms273_damage_pipeline.cjs', 'check_tms273_attributes.cjs', 'check_tms273_client_actions.cjs', 'check_tms273_desktop_package.cjs', 'build-release.check.cjs', 'publish-package.check.cjs']) {
  const result = spawnSync(process.execPath, [path.join(clientRoot, '..', 'scripts', file)], {
    cwd: path.join(clientRoot, '..'), stdio: 'inherit',
  });
  results.push({ label: file, ok: result.status === 0, status: result.status });
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
