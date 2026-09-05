// Runs the real launcher from outside the project, then checks build-failure safety.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const control = join(root, 'evidence/runtime/3010-control');
function launch(env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/zsh', [join(root, '启动3010.command')], {
      cwd: tmpdir(), env, detached: true, stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', resolve);
  });
}
const serverPid = await readFile(join(control, 'server.pid'), 'utf8');
const mock = await mkdtemp(join(tmpdir(), 'maple-launcher-check-'));
try {
  await writeFile(join(mock, 'cargo'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  assert.notEqual(await launch({ ...process.env, PATH: `${mock}:${process.env.PATH}` }), 0);
  assert.equal(await readFile(join(control, 'server.pid'), 'utf8'), serverPid);
  assert.equal((await fetch('http://127.0.0.1:3010/api/health')).status, 200);
} finally {
  await rm(mock, { recursive: true, force: true });
}
assert.equal(await launch(), 0);
const protocol = await readFile(join(root, 'shared/protocol.ts'), 'utf8');
const health = await (await fetch('http://127.0.0.1:3010/api/health')).json();
assert.equal(health.protocolVersion, Number(protocol.match(/PROTOCOL_VERSION = (\d+)/)[1]));
assert.equal(health.contentVersion, protocol.match(/CONTENT_VERSION = '([^']+)'/)[1]);
console.log('PASS: launch from another directory, protocol match, failed build preserves running server.');
