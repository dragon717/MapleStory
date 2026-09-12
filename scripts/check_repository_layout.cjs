#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const files = new Set(['README.md', 'AGENTS.md', 'MEMORY.md', 'start.bat', 'stop.bat', '启动3010.command', '关闭3010.command', '打包Windows资源包.command']);
const dirs = new Set(['docs', 'client', 'server', 'shared', 'resources', 'references', '参考', 'scripts', 'bots', 'qa', 'evidence', 'runtime', 'artifacts', 'build']);
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (entry.name.startsWith('.')) continue;
  assert((entry.isDirectory() ? dirs : files).has(entry.name), `Misplaced root entry: ${entry.name}`);
}
for (const file of ['README.md', 'AGENTS.md', 'MEMORY.md', 'docs/plan/PLAN.md', 'docs/plan/INDEX.md', 'docs/technical/BUSINESS_DEVELOPMENT.md', 'docs/technical/INDEX.md', 'docs/design/INDEX.md', 'evidence/INDEX.md']) {
  assert(fs.statSync(path.join(root, file)).isFile(), `Missing entry: ${file}`);
}
const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
assert(agents.includes('docs/plan/PLAN.md') && agents.includes('docs/technical/BUSINESS_DEVELOPMENT.md'), 'Stale Agent entry points');
for (const entry of fs.readdirSync(path.join(root, 'client'), { withFileTypes: true })) {
  assert(!entry.name.startsWith('dist'), `Unmanaged client build: ${entry.name}`);
}
for (const index of ['docs/plan/INDEX.md', 'docs/design/INDEX.md', 'docs/technical/INDEX.md', 'evidence/INDEX.md']) {
  const text = fs.readFileSync(path.join(root, index), 'utf8');
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, '').split('#')[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    assert(fs.existsSync(path.resolve(root, path.dirname(index), decodeURIComponent(target))), `${index}: broken index link ${target}`);
  }
}
console.log('PASS repository layout: root ownership, current entry points, indexes, no duplicate client builds');
