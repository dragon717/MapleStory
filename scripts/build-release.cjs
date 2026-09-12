#!/usr/bin/env node
// Build and rotate the paired client/server release without touching the live tree.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ITEM_NAMES = ['client', 'server', 'metadata.json'];
const SCHEMA_VERSION = 1;

function exists(file) {
  try { fs.lstatSync(file); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function remove(file) {
  fs.rmSync(file, { recursive: true, force: true });
}

function mkdir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(file, value) {
  mkdir(path.dirname(file));
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(temp, value, { encoding: 'utf8', mode: 0o644 });
  fs.renameSync(temp, file);
}

function renameIfExists(source, target) {
  if (!exists(source)) return false;
  if (exists(target)) throw new Error(`目标已存在，无法安全轮替：${target}`);
  mkdir(path.dirname(target));
  fs.renameSync(source, target);
  return true;
}

function rootPaths(root) {
  const build = path.join(root, 'build');
  return {
    root,
    build,
    current: path.join(build, 'current'),
    previous: path.join(build, 'previous'),
    tmp: path.join(build, 'tmp'),
    lock: path.join(build, '.release.lock'),
    transaction: path.join(build, '.activation.json'),
  };
}

function acquireLock(paths) {
  mkdir(paths.build);
  let fd;
  try {
    fd = fs.openSync(paths.lock, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, 'utf8');
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if (error.code === 'EEXIST') throw new Error(`已有构建/轮替正在进行：${paths.lock}`);
    throw error;
  }
  return () => {
    try { fs.closeSync(fd); } finally { remove(paths.lock); }
  };
}

function withLock(root, action) {
  const paths = rootPaths(root);
  const release = acquireLock(paths);
  try { return action(paths); } finally { release(); }
}

function relativePathWithin(base, value, label) {
  if (typeof value !== 'string' || value.length === 0 || path.isAbsolute(value)) {
    throw new Error(`${label} 必须是候选目录内的相对路径`);
  }
  const absolute = path.resolve(base, value);
  const relative = path.relative(base, absolute);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error(`${label} 越出候选目录：${value}`);
  }
  return absolute;
}

function readMetadata(file) {
  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`无法读取发布清单 ${file}: ${error.message}`);
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error(`发布清单不是对象：${file}`);
  }
  return metadata;
}

function expectedServerName() {
  return `maplestory-server${process.platform === 'win32' ? '.exe' : ''}`;
}

function validateMetadata(metadata, candidate) {
  if (metadata.schemaVersion !== SCHEMA_VERSION) throw new Error(`不支持的发布清单版本：${metadata.schemaVersion}`);
  for (const field of ['releaseId', 'platform', 'contentVersion', 'createdAt']) {
    if (typeof metadata[field] !== 'string' || metadata[field].length === 0) {
      throw new Error(`发布清单缺少 ${field}`);
    }
  }
  if (!Number.isSafeInteger(metadata.protocolVersion) || metadata.protocolVersion <= 0) {
    throw new Error('发布清单 protocolVersion 无效');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(metadata.releaseId)) throw new Error('发布清单 releaseId 含有非法字符');
  if (metadata.clientPath !== 'client') throw new Error('发布清单 clientPath 必须为 client');
  if (metadata.serverPath !== `server/${expectedServerName()}`) {
    throw new Error(`发布清单 serverPath 必须为 server/${expectedServerName()}`);
  }
  relativePathWithin(candidate, metadata.clientPath, 'clientPath');
  relativePathWithin(candidate, metadata.serverPath, 'serverPath');
  const client = path.join(candidate, metadata.clientPath);
  const server = path.join(candidate, metadata.serverPath);
  const index = path.join(client, 'index.html');
  if (!exists(client) || !fs.statSync(client).isDirectory()) throw new Error('候选客户端目录不完整');
  if (!exists(index) || !fs.statSync(index).isFile() || fs.statSync(index).size === 0) {
    throw new Error('候选客户端缺少有效 index.html');
  }
  if (!exists(server) || !fs.statSync(server).isFile() || fs.statSync(server).size === 0) {
    throw new Error('候选服务端可执行文件不完整');
  }
  return metadata;
}

function validateCandidate(root, candidate = rootPaths(root).tmp) {
  if (!exists(candidate) || !fs.statSync(candidate).isDirectory()) throw new Error(`候选目录不存在：${candidate}`);
  const metadataFile = path.join(candidate, 'metadata.json');
  if (!exists(metadataFile) || !fs.statSync(metadataFile).isFile()) throw new Error('候选缺少 metadata.json');
  return validateMetadata(readMetadata(metadataFile), candidate);
}

function readProtocol(root) {
  const source = fs.readFileSync(path.join(root, 'shared', 'protocol.ts'), 'utf8');
  const protocol = source.match(/export\s+const\s+PROTOCOL_VERSION\s*=\s*(\d+)\s*;/);
  const content = source.match(/export\s+const\s+CONTENT_VERSION\s*=\s*(['"])([^'"]+)\1\s*;/);
  if (!protocol || !content) throw new Error('无法从 shared/protocol.ts 读取协议或内容版本');
  return { protocolVersion: Number(protocol[1]), contentVersion: content[2] };
}

function executable(name) {
  const candidates = [];
  if (path.isAbsolute(name)) candidates.push(name);
  else {
    const pathValue = process.env.PATH || '';
    for (const dir of pathValue.split(path.delimiter)) if (dir) candidates.push(path.join(dir, name));
    if (process.platform === 'win32' && !name.toLowerCase().endsWith('.exe')) {
      for (const dir of pathValue.split(path.delimiter)) if (dir) candidates.push(path.join(dir, `${name}.exe`));
    }
  }
  const found = candidates.find(candidate => exists(candidate) && fs.statSync(candidate).isFile());
  if (found) return found;
  throw new Error(`找不到可执行文件：${name}`);
}

function run(command, args, root, env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} 构建失败（exit ${result.status ?? 'unknown'}）`);
}

function npmInvocation() {
  const configured = process.env.NPM_BIN || (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const command = path.isAbsolute(configured) ? configured : executable(configured);
  if (process.platform !== 'win32' || !/\.cmd$/i.test(command)) return { command, prefix: [] };
  const cli = path.join(path.dirname(command), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!exists(cli)) throw new Error(`无法定位 npm CLI：${cli}`);
  return { command: process.execPath, prefix: [cli] };
}

function prepare(root) {
  return withLock(root, paths => {
    if (exists(paths.transaction)) throw new Error('存在未完成的发布轮替，请先 commit 或 rollback');
    const candidate = paths.tmp;
    remove(path.join(candidate, 'client'));
    remove(path.join(candidate, 'server'));
    remove(path.join(candidate, 'metadata.json'));
    remove(path.join(candidate, 'cargo-target'));
    mkdir(candidate);

    const targetDir = path.join(candidate, 'cargo-target');
    try {
      const cargo = process.env.CARGO_BIN || (process.platform === 'win32' ? 'cargo.exe' : 'cargo');
      const env = { ...process.env, CARGO_INCREMENTAL: '0' };
      const cargoCommand = path.isAbsolute(cargo) ? cargo : executable(cargo);
      const npm = npmInvocation();
      run(cargoCommand, [
        'build', '--locked', '--manifest-path', path.join(root, 'server', 'Cargo.toml'),
        '--target-dir', targetDir,
      ], root, env);
      run(npm.command, [...npm.prefix, 'run', 'build', '--prefix', path.join(root, 'client')], root, env);

      const builtServer = path.join(targetDir, 'debug', expectedServerName());
      if (!exists(builtServer) || !fs.statSync(builtServer).isFile()) throw new Error(`Cargo 未生成 ${builtServer}`);
      const serverDir = path.join(candidate, 'server');
      mkdir(serverDir);
      const server = path.join(serverDir, expectedServerName());
      fs.copyFileSync(builtServer, server);
      if (process.platform !== 'win32') fs.chmodSync(server, 0o755);
      remove(targetDir);

      const versions = readProtocol(root);
      const releaseId = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(4).toString('hex')}`;
      const metadata = {
        schemaVersion: SCHEMA_VERSION,
        releaseId,
        platform: `${process.platform}-${process.arch}`,
        protocolVersion: versions.protocolVersion,
        contentVersion: versions.contentVersion,
        createdAt: new Date().toISOString(),
        clientPath: 'client',
        serverPath: `server/${expectedServerName()}`,
      };
      atomicWrite(path.join(candidate, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
      validateCandidate(root, candidate);
      return metadata;
    } catch (error) {
      remove(path.join(candidate, 'client'));
      remove(path.join(candidate, 'server'));
      remove(path.join(candidate, 'metadata.json'));
      remove(targetDir);
      throw error;
    }
  });
}

function livePid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function processReference(root) {
  // Windows control calls Assert-FreePort before activate; PowerShell also owns PID identity.
  if (process.platform === 'win32') return null;
  const result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('无法检查 macOS 进程表，拒绝切换');
  const rootMarker = `${root}${path.sep}`;
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match || !match[2].includes('maplestory-server') || !match[2].includes(rootMarker)) continue;
    return { pid: Number(match[1]), command: match[2] };
  }
  return null;
}

function runningReference(root) {
  const stateFiles = [
    path.join(root, 'runtime', '3010-control', 'server.pid'),
    path.join(root, 'runtime', 'windows-3010', 'server.json'),
  ];
  for (const file of stateFiles) {
    if (!exists(file)) continue;
    let pid;
    try {
      if (file.endsWith('.json')) pid = Number(readMetadata(file).pid);
      else pid = Number(fs.readFileSync(file, 'utf8').trim());
    } catch (error) {
      throw new Error(`无法判断运行引用 ${file}：${error.message}`);
    }
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`运行控制文件中的 PID 无效：${file}`);
    if (livePid(pid)) return { file, pid };
  }
  const process = processReference(root);
  return process ? { file: 'process table', ...process } : null;
}

function assertNoRunningReferences(root) {
  const reference = runningReference(root);
  if (reference) throw new Error(`仍有运行实例引用发布目录（PID ${reference.pid}，${reference.file}），拒绝切换`);
}

function transactionFor(paths) {
  if (!exists(paths.transaction)) return null;
  const transaction = readMetadata(paths.transaction);
  if (transaction.schemaVersion !== SCHEMA_VERSION || typeof transaction.releaseId !== 'string') {
    throw new Error(`轮替事务清单无效：${paths.transaction}`);
  }
  return transaction;
}

function buildRelative(paths, file) {
  const relative = path.relative(paths.build, file);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error(`轮替路径越出 build：${file}`);
  }
  return relative;
}

function buildAbsolute(paths, relative) {
  const file = path.resolve(paths.build, relative);
  const inside = path.relative(paths.build, file);
  if (!inside || inside.startsWith(`..${path.sep}`) || inside === '..' || path.isAbsolute(inside)) {
    throw new Error(`轮替清单路径越出 build：${relative}`);
  }
  return file;
}

function moveItem(sourceRoot, name, destinationRoot, paths, transaction, rename = fs.renameSync) {
  const source = path.join(sourceRoot, name);
  const target = path.join(destinationRoot, name);
  if (!exists(source)) return false;
  if (exists(target)) throw new Error(`目标已存在，无法安全轮替：${target}`);
  mkdir(path.dirname(target));
  if (!transaction) {
    rename(source, target);
    return true;
  }
  const entry = { source: buildRelative(paths, source), target: buildRelative(paths, target), done: false };
  transaction.moves.push(entry);
  atomicWrite(paths.transaction, `${JSON.stringify(transaction, null, 2)}\n`);
  try {
    rename(source, target);
    entry.done = true;
    atomicWrite(paths.transaction, `${JSON.stringify(transaction, null, 2)}\n`);
  } catch (error) {
    entry.error = error.message;
    atomicWrite(paths.transaction, `${JSON.stringify(transaction, null, 2)}\n`);
    throw error;
  }
  return true;
}

function activate(root, expectedReleaseId, options = {}) {
  return withLock(root, paths => {
    if (transactionFor(paths)) throw new Error('已有未完成的发布轮替');
    assertNoRunningReferences(root);
    const metadata = validateCandidate(root, paths.tmp);
    if (expectedReleaseId && metadata.releaseId !== expectedReleaseId) {
      throw new Error(`候选 releaseId 不匹配：${metadata.releaseId}`);
    }
    const transactionDir = path.join(paths.tmp, `.activation-${metadata.releaseId}-${crypto.randomBytes(4).toString('hex')}`);
    const oldCurrent = path.join(transactionDir, 'old-current');
    const oldPrevious = path.join(transactionDir, 'old-previous');
    const newCandidate = path.join(transactionDir, 'candidate');
    mkdir(oldCurrent); mkdir(oldPrevious); mkdir(newCandidate);
    const transaction = {
      schemaVersion: SCHEMA_VERSION,
      releaseId: metadata.releaseId,
      directory: path.relative(paths.build, transactionDir),
      state: 'activating',
      moves: [],
    };
    try {
      atomicWrite(paths.transaction, `${JSON.stringify(transaction, null, 2)}\n`);
    } catch (error) {
      remove(transactionDir);
      throw error;
    }
    const rename = options.rename || fs.renameSync;
    try {
      for (const name of ITEM_NAMES) moveItem(paths.previous, name, oldPrevious, paths, transaction, rename);
      for (const name of ITEM_NAMES) moveItem(paths.current, name, oldCurrent, paths, transaction, rename);
      for (const name of ITEM_NAMES) moveItem(paths.tmp, name, newCandidate, paths, transaction, rename);
      mkdir(paths.current); mkdir(paths.previous);
      for (const name of ITEM_NAMES) moveItem(oldCurrent, name, paths.previous, paths, transaction, rename);
      for (const name of ITEM_NAMES) moveItem(newCandidate, name, paths.current, paths, transaction, rename);
      transaction.state = 'active';
      atomicWrite(paths.transaction, `${JSON.stringify(transaction, null, 2)}\n`);
      return metadata;
    } catch (error) {
      try { restoreActivation(paths, transaction); } catch (restoreError) {
        throw new Error(`${error.message}；且无法恢复旧版本：${restoreError.message}`);
      }
      throw error;
    }
  });
}

function restoreActivation(paths, transaction) {
  for (const entry of [...(transaction.moves || [])].reverse()) {
    const source = buildAbsolute(paths, entry.source);
    const target = buildAbsolute(paths, entry.target);
    const sourceExists = exists(source);
    const targetExists = exists(target);
    if (!targetExists) {
      if (entry.done) throw new Error(`轮替记录与文件状态冲突：${entry.target}`);
      continue;
    }
    if (sourceExists) throw new Error(`恢复目标已存在：${entry.source}`);
    fs.renameSync(target, source);
  }
  remove(path.resolve(paths.build, transaction.directory));
  remove(paths.transaction);
}

function finish(root, expectedReleaseId, rollback) {
  return withLock(root, paths => {
    const transaction = transactionFor(paths);
    if (!transaction) throw new Error('没有待完成的发布轮替');
    if (expectedReleaseId && transaction.releaseId !== expectedReleaseId) {
      throw new Error(`事务 releaseId 不匹配：${transaction.releaseId}`);
    }
    if (!rollback && transaction.state !== 'active') throw new Error('轮替尚未完成，不能提交');
    // commit is called after the new server passes health and may keep that
    // current executable running; rollback still requires a fully stopped
    // process before moving either version back.
    if (rollback) assertNoRunningReferences(root);
    const transactionDir = path.resolve(paths.build, transaction.directory);
    if (!exists(transactionDir)) throw new Error(`轮替事务目录不存在：${transactionDir}`);
    const oldCurrent = path.join(transactionDir, 'old-current');
    const oldPrevious = path.join(transactionDir, 'old-previous');
    const newCandidate = path.join(transactionDir, 'candidate');
    if (!rollback) {
      const active = validateCandidate(root, paths.current);
      if (active.releaseId !== transaction.releaseId) throw new Error('当前版本与待提交事务不一致');
      remove(oldPrevious);
      remove(transactionDir);
      remove(paths.transaction);
      return active;
    }
    restoreActivation(paths, transaction);
    return validateCurrent(root);
  });
}

function validateCurrent(root) {
  const paths = rootPaths(root);
  if (!exists(path.join(paths.current, 'metadata.json'))) return null;
  return validateMetadata(readMetadata(path.join(paths.current, 'metadata.json')), paths.current);
}

function usage() {
  return [
    '用法：node scripts/build-release.cjs <prepare|validate|activate|commit|rollback> [--root 目录] [--release-id ID]',
    'prepare 运行 Cargo/Vite 并生成 build/tmp 候选；activate 切换三件制品；commit/rollback 完成健康检查后的结果。',
  ].join('\n');
}

function options(argv) {
  const result = { root: path.resolve(__dirname, '..'), releaseId: undefined };
  for (let index = 3; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--root' && argv[index + 1]) result.root = path.resolve(argv[++index]);
    else if (value === '--release-id' && argv[index + 1]) result.releaseId = argv[++index];
    else throw new Error(`未知参数：${value}`);
  }
  return result;
}

function main(argv = process.argv) {
  const command = argv[2];
  if (!command) throw new Error(usage());
  const opts = options(argv);
  let result;
  if (command === 'prepare') result = prepare(opts.root);
  else if (command === 'validate') result = validateCandidate(opts.root);
  else if (command === 'activate') result = activate(opts.root, opts.releaseId);
  else if (command === 'commit') result = finish(opts.root, opts.releaseId, false);
  else if (command === 'rollback') result = finish(opts.root, opts.releaseId, true);
  else throw new Error(usage());
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`发布失败：${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  ITEM_NAMES,
  SCHEMA_VERSION,
  activate,
  assertNoRunningReferences,
  finish,
  main,
  prepare,
  readMetadata,
  rootPaths,
  withLock,
  validateCandidate,
  validateCurrent,
};
