#!/usr/bin/env node
// iCloud Drive resolves a sync conflict by keeping the local file and writing the
// other side next to it as `<name> 2.<ext>`.  The copy is a stale snapshot by
// construction, but nothing about the *name* tells a tool that: `git add -A`
// swept six of them into 3a399d0, `tsc` had to be given an exclude, and three
// guards were taught to skip them instead of rejecting them.  One survivor,
// server/src/lobby 2.rs, sat 181 lines behind lobby.rs while `grep` kept
// matching the stale one first.
//
// The rule this guard enforces: a conflict copy is never *content*.  If a file
// named `<anything> <digits>[.<ext>]` has a sibling with the same name minus the
// numeric suffix, the copy is residue and belongs in the bin — not in an
// exclude, a skip predicate or an allowlist.  A copy whose original is *missing*
// is reported too: that shape means the real file was lost or renamed, which is
// worse than a surplus copy.
//
// Reads the git index plus untracked-but-not-ignored files, so it rejects a copy
// that is merely staged as well as one already committed.  Runs from
// .githooks/pre-commit; enable once per clone with
// `git config core.hooksPath .githooks`.
//
// Reuse on a copy path that this guard cannot see (ignored local trees such as
// resources/tms273-export, which is how a copy leaked into client/public-tms273):
//
//   const { assertNoConflictCopyName } = require('./check_icloud_conflict_copies.cjs');
//   assertNoConflictCopyName(assetName, 'the map manifest');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');

// `<name> 2`, `<name> 2.rs`, `<name> 23.json` …  iCloud numbers the copy, and
// macOS's own "Duplicate" command produces the same shape.
const CONFLICT_COPY = /^(?<base>.+?) \d+(?<ext>\.[A-Za-z0-9]+)?$/;

/** The name this one would have if it were not a conflict copy, else null. */
function conflictCopyOf(name) {
  const match = CONFLICT_COPY.exec(name);
  if (match === null) return null;
  return `${match.groups.base}${match.groups.ext ?? ''}`;
}

/** Throws unless `name` is an ordinary name rather than an iCloud conflict copy. */
function assertNoConflictCopyName(name, where) {
  const original = conflictCopyOf(name);
  assert(
    original === null,
    `${name} is an iCloud conflict copy of ${original} (${where}). ` +
      'Delete the copy — it is a stale snapshot, not content — instead of excluding, skipping or allowlisting it.',
  );
}

const git = (args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const nullSeparated = (args) => git(args).split('\0').filter(Boolean);

// Everything Git would carry: the index (staged or committed) plus untracked
// files .gitignore does not cover.  Ignored trees such as 参考/ and
// client/public-tms273/ are local derivations and deliberately out of scope here
// — the reverse assertion in assemble_tms273.cjs keeps their sources clean.
const visible = [
  ...nullSeparated(['ls-files', '-z']),
  ...nullSeparated(['ls-files', '-z', '--others', '--exclude-standard']),
];

// Only scan when run as the guard itself; require() only wants the helpers above.
if (require.main === module) {
  const surplus = [];
  const orphans = [];
  for (const rel of visible) {
    const dir = path.dirname(rel);
    const original = conflictCopyOf(path.basename(rel));
    if (original === null) continue;
    if (fs.existsSync(path.join(root, dir, original))) surplus.push({ rel, original });
    else orphans.push({ rel, original });
  }

  assert(
    surplus.length === 0,
    `these version-controlled files are iCloud conflict copies of a sibling that is already in the tree:\n  ` +
      `${surplus.map(({ rel, original }) => `${rel}  ->  ${original}`).join('\n  ')}\n` +
      'Delete each copy (git rm) and drop whatever exclude or skip predicate was keeping it quiet.',
  );

  assert(
    orphans.length === 0,
    `these version-controlled files are iCloud conflict copies whose original is missing:\n  ` +
      `${orphans.map(({ rel, original }) => `${rel}  (expected sibling ${original})`).join('\n  ')}\n` +
      'Recover or rebuild the real file first, then delete the copy.',
  );

  console.log(
    `PASS iCloud conflict copies: ${visible.length} version-controlled file(s) scanned, ` +
      `${surplus.length} surplus, ${orphans.length} orphan`,
  );
}

module.exports = { conflictCopyOf, assertNoConflictCopyName, CONFLICT_COPY };
