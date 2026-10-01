#!/usr/bin/env node
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const git = (args, input) => execFileSync('git', args, { cwd: root, encoding: 'utf8', input });
const source = [
  'client/src/app/main.ts', 'shared/maps.json', 'client/package-lock.json', 'server/Cargo.lock',
  'client/src-tauri/icons/32x32.png', '.workbuddy-ai/skills/maplestory-skill-copy-wiring/SKILL.md',
  'evidence/INDEX.md', 'evidence/2026-09-21/perion-portal-links/根因核对.md',
  'evidence/2026-09-21/perion-portal-links/repro/01_compare_assembled_vs_source.cjs',
  'artifacts/portal_closure_check.py', 'artifacts/refactor/debt-register.json',
  'artifacts/refactor/baseline-metrics.json', 'artifacts/tms273_item_definition_backfill.json',
  'scripts/_probe_canvas_volumes.json', 'references/tms273_research_pack/01_SOURCE_REGISTER.json',
  'references/tms273-data/ice-fourth-job-source.json', 'artifacts/tms273_export_gap_repair.json',
];
const generated = [
  'server/data/tms273.sqlite3', 'runtime/3010-control/bot-credentials.json', 'build/current/client/index.html',
  'client/node_modules/phaser/package.json', 'server/target/debug/maplestory-server',
  'client/src-tauri/icon-source.png', 'resources/scenes/chuxian-east-v1/models/model.glb',
  'artifacts/henesys/3010-startup.log', 'artifacts/henesys/east-village/live/performance-final.json',
  'artifacts/refactor/frontend-deps.json', 'artifacts/windbell/candidate-assets.json',
  'references/browser-probe/check-results.json', 'references/tms273-data/maps.json',
  'references/tms273-data/quests.json', 'references/tms273-data/manifest.json',
  'artifacts/tms273_assemble_missing.json',
  'scripts/_probe_skill_outlinks.json', 'evidence/2026-09-17/notebook-ui/harness.ts',
  'evidence/2026-09-17/notebook-ui/check.js', 'evidence/2026-09-17/notebook-ui/data.json',
];
const ignored = new Set(git(['check-ignore', '--no-index', '-z', '--stdin'], [...source, ...generated].join('\0') + '\0').split('\0'));
for (const file of source) assert(!ignored.has(file), `Source/input is ignored: ${file}`);
for (const file of generated) assert(ignored.has(file), `Generated/private output is not ignored: ${file}`);
const trackedIgnored = git(['ls-files', '-ci', '-z', '--exclude-standard']).split('\0').filter(Boolean);
assert.deepEqual(trackedIgnored, [], 'Ignored files are still tracked; use git rm --cached to preserve local copies');
console.log(`PASS gitignore: ${source.length} source/input paths, ${generated.length} output paths, no ignored files tracked`);
