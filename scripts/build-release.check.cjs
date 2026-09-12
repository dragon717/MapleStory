#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const {
  activate,
  prepare,
  withLock,
  finish,
  rootPaths,
  validateCandidate,
} = require('./build-release.cjs');

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, 'utf8');
}

function metadata(id) {
  return {
    schemaVersion: 1,
    releaseId: id,
    platform: 'check',
    protocolVersion: 1,
    contentVersion: 'check',
    createdAt: new Date(0).toISOString(),
    clientPath: 'client',
    serverPath: 'server/maplestory-server',
  };
}

function putRelease(root, slot, id) {
  const dir = path.join(root, 'build', slot);
  write(path.join(dir, 'client', 'index.html'), `<html>${id}</html>\n`);
  write(path.join(dir, 'server', 'maplestory-server'), `server ${id}\n`);
  write(path.join(dir, 'metadata.json'), `${JSON.stringify(metadata(id))}\n`);
}

function putCandidate(root, id) {
  putRelease(root, 'tmp', id);
}

function idAt(root, slot) {
  return JSON.parse(fs.readFileSync(path.join(root, 'build', slot, 'metadata.json'), 'utf8')).releaseId;
}

function assertOnlyVersionItems(root, slot) {
  const entries = fs.readdirSync(path.join(root, 'build', slot)).sort();
  assert(entries.includes('client') && entries.includes('metadata.json') && entries.includes('server'), `${slot} must retain version items`);
  assert(entries.every(entry => ['client', 'metadata.json', 'server', 'packages'].includes(entry)), `${slot} contains an unexpected item`);
}

function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maple-release-check-'));
  try {
    const paths = rootPaths(root);
    putRelease(root, 'current', 'r1');
    fs.mkdirSync(path.join(paths.current, 'packages', 'windows'), { recursive: true });
    write(path.join(paths.current, 'packages', 'windows', 'r1.zip'), 'package r1');

    for (const id of ['r2', 'r3', 'r4']) {
      putCandidate(root, id);
      validateCandidate(root);
      activate(root, id);
      finish(root, id, false);
    }
    assert.equal(idAt(root, 'current'), 'r4');
    assert.equal(idAt(root, 'previous'), 'r3');
    assert.equal(fs.readFileSync(path.join(paths.current, 'packages', 'windows', 'r1.zip'), 'utf8'), 'package r1');
    assertOnlyVersionItems(root, 'current');
    assertOnlyVersionItems(root, 'previous');
    assert.deepEqual(fs.readdirSync(paths.tmp), [], 'successful rotations leave no candidate or transaction');

    putCandidate(root, 'broken');
    fs.rmSync(path.join(paths.tmp, 'server'), { recursive: true, force: true });
    assert.throws(() => activate(root), /候选服务端可执行文件不完整/);
    assert.equal(idAt(root, 'current'), 'r4');
    assert.equal(idAt(root, 'previous'), 'r3');

    putCandidate(root, 'r5');
    activate(root, 'r5');
    finish(root, 'r5', true);
    assert.equal(idAt(root, 'current'), 'r4', 'failed health must restore current');
    assert.equal(idAt(root, 'previous'), 'r3', 'failed health must restore previous');

    putCandidate(root, 'rename-failure');
    let renameCount = 0;
    assert.throws(() => activate(root, 'rename-failure', {
      rename(source, target) {
        renameCount += 1;
        if (renameCount === 7) throw new Error('injected rename failure');
        fs.renameSync(source, target);
      },
    }), /injected rename failure/);
    assert.equal(idAt(root, 'current'), 'r4', 'mid-rotation failure must restore current');
    assert.equal(idAt(root, 'previous'), 'r3', 'mid-rotation failure must restore previous');
    assert.equal(idAt(root, 'tmp'), 'rename-failure', 'mid-rotation failure must preserve candidate');

    putCandidate(root, 'partial-tree');
    write(path.join(paths.tmp, 'client', 'assets', 'one.png'), 'one');
    write(path.join(paths.tmp, 'client', 'assets', 'two.png'), 'two');
    assert.throws(() => activate(root, 'partial-tree', {
      rename(source, target) {
        if (source === path.join(paths.tmp, 'client')) {
          fs.mkdirSync(path.join(target, 'assets'), { recursive: true });
          fs.renameSync(path.join(source, 'assets', 'one.png'), path.join(target, 'assets', 'one.png'));
          throw new Error('interrupted file move');
        }
        fs.renameSync(source, target);
      },
    }), /interrupted file move/);
    assert.equal(idAt(root, 'current'), 'r4');
    assert.equal(fs.readFileSync(path.join(paths.tmp, 'client', 'assets', 'one.png'), 'utf8'), 'one');
    assert.equal(fs.readFileSync(path.join(paths.tmp, 'client', 'assets', 'two.png'), 'utf8'), 'two');

    putCandidate(root, 'r6');
    fs.mkdirSync(path.dirname(path.join(root, 'runtime', '3010-control', 'server.pid')), { recursive: true });
    write(path.join(root, 'runtime', '3010-control', 'server.pid'), `${process.pid}\n`);
    assert.throws(() => activate(root, 'r6'), /仍有运行实例引用发布目录/);
    assert.equal(idAt(root, 'current'), 'r4');
    fs.rmSync(path.join(root, 'runtime'), { recursive: true, force: true });

    const exited = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
    assert.equal(exited.status, 0);
    write(paths.lock, JSON.stringify({ pid: exited.pid }));
    withLock(root, () => assert.equal(JSON.parse(fs.readFileSync(paths.lock, 'utf8')).pid, process.pid));
    assert(!fs.existsSync(paths.lock), 'dead owner lock is recovered and released');
    write(paths.lock, JSON.stringify({ pid: process.pid }));
    assert.throws(() => withLock(root, () => assert.fail('live lock acquired')), /已有构建/);
    fs.unlinkSync(paths.lock);

    // A terminated activation can leave a move persisted before its rename.
    activate(root, 'r6');
    const interrupted = JSON.parse(fs.readFileSync(paths.transaction, 'utf8'));
    interrupted.state = 'activating';
    interrupted.moves.at(-1).done = false;
    write(paths.transaction, JSON.stringify(interrupted));
    const cargoBefore = process.env.CARGO_BIN;
    process.env.CARGO_BIN = path.join(root, 'missing-cargo');
    try {
      assert.throws(() => prepare(root), /ENOENT/);
    } finally {
      if (cargoBefore === undefined) delete process.env.CARGO_BIN;
      else process.env.CARGO_BIN = cargoBefore;
    }
    assert.equal(idAt(root, 'current'), 'r4', 'interrupted activation restores current before building');
    assert.equal(idAt(root, 'previous'), 'r3');
    assert(!fs.existsSync(paths.transaction));
    assert(!fs.existsSync(paths.lock));

    fs.mkdirSync(paths.lock, { recursive: true });
    assert.throws(() => activate(root, 'r6'), /已有构建\/轮替正在进行/);
    fs.rmSync(paths.lock, { recursive: true, force: true });

    console.log(`PASS: offline release rotation checks (${root})`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main();
