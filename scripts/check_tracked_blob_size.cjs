#!/usr/bin/env node
// GitHub refuses any push that carries a blob above 100 MB, and a generated
// export can creep past that limit without any single commit looking wrong:
// references/tms273-data/maps.json grew 98 -> 139 -> 153 MB across three map
// assemblies and blocked the push only once it was already in history.
//
// This guard reads the git index, so it also rejects a file that is merely
// staged.  It runs from .githooks/pre-commit; enable it once per clone with
// `git config core.hooksPath .githooks`.
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');

// GitHub's hard limit is 100 MB; the margin leaves room for a file to grow
// between the guard and the push.
const LIMIT_BYTES = 90 * 1024 * 1024;

// Derived exports that are regenerated from 参考/ WZ packages.  These must stay
// out of version control no matter how small they currently are; the reverse
// assertion below fails the moment one of them is staged again.
const FORBIDDEN_PATHS = [
  {
    path: 'references/tms273-data/maps.json',
    why: 'a generated map catalog derived from the 参考/ WZ packages',
    rebuild: 'scripts/import_tms273.py + scripts/export_tms273.cjs',
  },
];

const git = (args, options = {}) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });

const records = git(['ls-files', '-s', '-z'])
  .split('\0')
  .filter(Boolean)
  .map((record) => {
    const tab = record.indexOf('\t');
    return { sha: record.slice(0, tab).split(' ')[1], file: record.slice(tab + 1) };
  });

for (const { path: forbidden, why, rebuild } of FORBIDDEN_PATHS) {
  assert(
    !records.some((record) => record.file === forbidden),
    `${forbidden} is tracked again: it is ${why}, and its size breaks GitHub's push limit. ` +
      `Rebuild it with ${rebuild}, and check that .gitignore still covers this path.`,
  );
}

const shas = [...new Set(records.map((record) => record.sha))];
const sizes = new Map();
if (shas.length > 0) {
  const checked = git(['cat-file', '--batch-check=%(objectname) %(objectsize)'], {
    input: `${shas.join('\n')}\n`,
  });
  for (const line of checked.split('\n').filter(Boolean)) {
    const [sha, size] = line.split(' ');
    sizes.set(sha, Number(size) || 0);
  }
}

const oversized = records
  .map((record) => ({ ...record, size: sizes.get(record.sha) || 0 }))
  .filter((record) => record.size > LIMIT_BYTES)
  .sort((left, right) => right.size - left.size);

assert(
  oversized.length === 0,
  `Tracked files above ${LIMIT_BYTES / 1048576} MB would be rejected by GitHub:\n  ` +
    `${oversized.map((record) => `${(record.size / 1048576).toFixed(2)} MB  ${record.file}`).join('\n  ')}\n` +
    'Keep large binaries and generated trees in the local resource archive and ignore them instead.',
);

let largest = 0;
for (const size of sizes.values()) largest = Math.max(largest, size);

console.log(
  `PASS tracked blob size: ${records.length} file(s), largest ${(largest / 1048576).toFixed(2)} MB, ` +
    `limit ${LIMIT_BYTES / 1048576} MB, ${FORBIDDEN_PATHS.length} forbidden derived export(s) absent`,
);
