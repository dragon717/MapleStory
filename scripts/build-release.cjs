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
    if (error.code === 'EEXIST') {
      // Only reclaim a valid lock whose owner has exited; unknown/live owners stay protected.
      let owner;
      try { owner = JSON.parse(fs.readFileSync(paths.lock, 'utf8')); } catch {}
      if (Number.isSafeInteger(owner?.pid) && owner.pid > 0 && !livePid(owner.pid)) {
        fs.unlinkSync(paths.lock);
        return acquireLock(paths);
      }
      throw new Error(`已有构建/轮替正在进行：${paths.lock}`);
    }
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

function run(command, args, root, env, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    windowsHide: true,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} 构建失败（exit ${result.status ?? 'unknown'}）`);
  return capture ? { stdout: result.stdout || '', stderr: result.stderr || '' } : undefined;
}

function npmInvocation() {
  const configured = process.env.NPM_BIN || (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const command = path.isAbsolute(configured) ? configured : executable(configured);
  if (process.platform !== 'win32' || !/\.cmd$/i.test(command)) return { command, prefix: [] };
  const cli = path.join(path.dirname(command), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!exists(cli)) throw new Error(`无法定位 npm CLI：${cli}`);
  return { command: process.execPath, prefix: [cli] };
}

function recoverInterrupted(paths) {
  const interrupted = transactionFor(paths);
  if (!interrupted) return;
  assertNoRunningReferences(paths.root);
  restoreActivation(paths, interrupted);
  process.stderr.write('已恢复上次中断的发布轮替，继续启动。\n');
}

const STAMP_VERSION = 1;
const MODULE_REGEX = /(\d+) modules transformed/;

function hashFile(file) {
  const hash = crypto.createHash('sha1');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

// Stat fingerprint for the large generated asset tree (tens of thousands of
// PNGs): content hashing would cost seconds per startup, while size+mtime
// catches every pipeline write at negligible cost. False positives (an edit
// that keeps size and mtime) merely delay a rebuild by one start.
function statFingerprint(dir, base, entries) {
  const queue = [dir];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const name of fs.readdirSync(current)) {
      if (name === '.DS_Store') continue;
      const file = path.join(current, name);
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) queue.push(file);
      else if (stat.isFile()) entries.push(`${path.relative(base, file)}:${stat.size}:${stat.mtimeMs}`);
    }
  }
}

function computeFingerprint(root) {
  try {
    const hash = crypto.createHash('sha1');
    const contentInputs = [
      'client/index.html', 'client/vite.config.ts', 'client/tsconfig.json',
      'client/package.json', 'client/package-lock.json',
      'server/Cargo.toml', 'server/Cargo.lock',
    ];
    for (const name of contentInputs) {
      const file = path.join(root, name);
      if (!exists(file)) return null;
      hash.update(`${name}:${hashFile(file)}\n`);
    }
    // 内容数据（client/public-tms273）刻意不参与构建指纹：它不由构建产出，也不进产物
    // （见 client/vite.config.ts），服务端按 ASSETS_DIR 直接读源目录。把它算进指纹有两重
    // 代价：每次改内容都作废候选、再付一次全量拷贝；每次判定都要白扫 7 万个文件。
    for (const dir of ['client/src', 'client/scripts', 'server/src', 'shared']) {
      const base = path.join(root, dir);
      if (!exists(base)) return null;
      const entries = [];
      statFingerprint(base, base, entries);
      entries.sort();
      hash.update(`${dir}\n${entries.join('\n')}\n`);
    }
    return hash.digest('hex');
  } catch (error) {
    // Any fingerprint trouble degrades to the always-rebuild behavior.
    return null;
  }
}

function stampFile(paths) {
  return path.join(paths.build, '.prepare-stamp.json');
}

function loadStamp(paths) {
  try {
    const stamp = readMetadata(stampFile(paths));
    if (stamp.schemaVersion !== STAMP_VERSION || typeof stamp.fingerprint !== 'string') return null;
    return stamp;
  } catch (error) {
    return null;
  }
}

function freshReleaseId() {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(4).toString('hex')}`;
}

function metadataFor(root, releaseId) {
  const versions = readProtocol(root);
  return {
    schemaVersion: SCHEMA_VERSION,
    releaseId,
    platform: `${process.platform}-${process.arch}`,
    protocolVersion: versions.protocolVersion,
    contentVersion: versions.contentVersion,
    createdAt: new Date().toISOString(),
    clientPath: 'client',
    serverPath: `server/${expectedServerName()}`,
  };
}

function prepare(root) {
  return withLock(root, paths => {
    const commandStarted = Date.now();
    recoverInterrupted(paths);
    const candidate = paths.tmp;

    // Fast path: when every build input is unchanged since the last prepare,
    // reuse the validated candidate and only refresh its release metadata.
    // Build inputs are code-only（内容数据不参与，见 computeFingerprint），所以
    // 复用候选的判定只需读源码与清单，不必再扫 7 万个内容资源文件。
    const fingerprint = computeFingerprint(root);
    if (fingerprint) {
      const stamp = loadStamp(paths);
      const clientIndex = path.join(candidate, 'client', 'index.html');
      const serverBin = path.join(candidate, 'server', expectedServerName());
      if (stamp && stamp.fingerprint === fingerprint && exists(clientIndex) && exists(serverBin)) {
        try {
          validateCandidate(root, candidate);
          const metadata = metadataFor(root, freshReleaseId());
          atomicWrite(path.join(candidate, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
          validateCandidate(root, candidate);
          const modules = Number.isSafeInteger(stamp.clientModules) ? stamp.clientModules : '?';
          // stamp.releaseId 的语义是「本指纹产出的那个发布的 id」。复用候选时它就是该发布，
          // 必须一起刷新：否则 commit 之后 currentFresh 恒假，每次启动都要空跑一遍
          // prepare+activate（只为换一个 id），跳过构建的快路径永远走不到。
          atomicWrite(stampFile(paths), `${JSON.stringify({
            schemaVersion: STAMP_VERSION,
            fingerprint,
            clientModules: stamp.clientModules ?? null,
            releaseId: metadata.releaseId,
          }, null, 2)}\n`);
          // The launcher greps "N modules transformed" from prepare.log; keep the phrase intact.
          process.stdout.write(`✓ 输入未变化，复用候选构建（client ${modules} modules transformed，跳过 Cargo 与 tsc/vite）\n`);
          // [prepare] 行是启动脚本唯一的分项耗时来源，格式固定为 `mode | 明细`。
          // mode 只含 ASCII：启动脚本据此判断走了哪条路径，不靠中文/正则去猜
          // （macOS 上 grep 对多字节模式并不总是可靠）。
          process.stdout.write(`[prepare] reuse | 复用候选构建（跳过 cargo 与 tsc/vite） · 合计 ${((Date.now() - commandStarted) / 1000).toFixed(1)}s\n`);
          return metadata;
        } catch (error) {
          process.stderr.write(`候选复用校验失败，改为全量构建：${error.message}\n`);
        }
      }
    }

    remove(path.join(candidate, 'client'));
    remove(path.join(candidate, 'server'));
    remove(path.join(candidate, 'metadata.json'));
    mkdir(candidate);

    // Persistent cargo cache: rebuilding into a throwaway target dir forced a
    // full non-incremental server compile on every startup (the launcher's
    // dominant cost). Fingerprints here survive across runs, so an unchanged
    // tree recompiles in seconds. The dot dir sits beside current/previous/tmp
    // and is never touched by release rotation.
    const targetDir = path.join(paths.build, '.cargo-cache');
    try {
      const cargo = process.env.CARGO_BIN || (process.platform === 'win32' ? 'cargo.exe' : 'cargo');
      const env = { ...process.env, CARGO_INCREMENTAL: '0' };
      const cargoCommand = path.isAbsolute(cargo) ? cargo : executable(cargo);
      const npm = npmInvocation();
      const cargoStarted = Date.now();
      run(cargoCommand, [
        'build', '--quiet', '--locked', '--manifest-path', path.join(root, 'server', 'Cargo.toml'),
        '--target-dir', targetDir,
      ], root, env);
      const cargoSeconds = ((Date.now() - cargoStarted) / 1000).toFixed(1);
      // client/package.json 的 build 是 `tsc --noEmit && vite build`，所以这一段量的是
      // 「客户端整条流水线」（类型检查 + 打包），不要只标成 vite。
      const clientStarted = Date.now();
      const npmBuild = run(npm.command, [...npm.prefix, 'run', 'build', '--prefix', path.join(root, 'client')], root, env, true);
      const clientSeconds = ((Date.now() - clientStarted) / 1000).toFixed(1);
      process.stdout.write(npmBuild.stdout);
      process.stderr.write(npmBuild.stderr);

      const builtServer = path.join(targetDir, 'debug', expectedServerName());
      if (!exists(builtServer) || !fs.statSync(builtServer).isFile()) throw new Error(`Cargo 未生成 ${builtServer}`);
      const serverDir = path.join(candidate, 'server');
      mkdir(serverDir);
      const server = path.join(serverDir, expectedServerName());
      fs.copyFileSync(builtServer, server);
      if (process.platform !== 'win32') fs.chmodSync(server, 0o755);
      // targetDir is a persistent cache: keep it for the next prepare.

      const metadata = metadataFor(root, freshReleaseId());
      atomicWrite(path.join(candidate, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
      validateCandidate(root, candidate);
      if (fingerprint) {
        const moduleMatch = MODULE_REGEX.exec(npmBuild.stdout);
        atomicWrite(stampFile(paths), `${JSON.stringify({
          schemaVersion: STAMP_VERSION,
          fingerprint,
          clientModules: moduleMatch ? Number(moduleMatch[1]) : null,
          releaseId: metadata.releaseId,
        }, null, 2)}\n`);
      }
      const totalSeconds = ((Date.now() - commandStarted) / 1000).toFixed(1);
      // 余量可能因四舍五入变成 -0.0，钳到 0（展示用的数字不该出现负号）。
      const overheadSeconds = Math.max(0, totalSeconds - cargoSeconds - clientSeconds).toFixed(1);
      // 启动脚本从 prepare.log 的 [prepare] 行取分项，展示在「[2/4] 构建打包」那一行里。
      // `mode | 明细` 里的 mode 只含 ASCII（见复用路径同款说明）。
      process.stdout.write(`[prepare] build | cargo ${cargoSeconds}s · 客户端(tsc+vite) ${clientSeconds}s · 清理与校验 ${overheadSeconds}s · 合计 ${totalSeconds}s\n`);
      return metadata;
    } catch (error) {
      remove(path.join(candidate, 'client'));
      remove(path.join(candidate, 'server'));
      remove(path.join(candidate, 'metadata.json'));
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

// 只用于日志：数一个目录（或单个文件＝1）里有几个文件。「按文件」的操作在 iCloud 卷上
// 慢好几个数量级，所以文件数是判断一次轮替会不会被拖住的关键数字。遍历本身只是读目录项，
// 实测 7 万个文件 0.42s（约 6µs/文件），而正常发布目录只有个位数文件，所以这一步的代价
// 可以忽略；真正贵的是被它计数的那些搬移。
function countFiles(target) {
  try {
    if (!fs.lstatSync(target).isDirectory()) return 1;
  } catch (error) {
    return 0;
  }
  let files = 0;
  const queue = [target];
  while (queue.length > 0) {
    const current = queue.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) queue.push(path.join(current, entry.name));
      else files += 1;
    }
  }
  return files;
}

// 2026-09-16 实测（本仓库所在 iCloud 卷，全部为真机数字）：
//   改名「文件」                = 0.00s（5 天前的老文件也一样）
//   改名「老目录」              = 10.81s / 36.65s / 95.57s（最后一个的目录里有 11166 个文件）
//   mkdir / writeFileSync / fs.rmSync = 0.00~0.04s
//   「建新目录 + 逐个搬文件」搬同一个 11166 文件的目录 = 1.13s（约 0.1ms/文件）
// ⇒ **整目录改名在这块卷上是负数优化**：同一棵树 95.57s vs 1.13s，差 85 倍。iCloud 会对
// 「有同步历史的目录」在改名时收敛状态，代价与目录里的文件数完全不成比例。
// 这正是 2026-09-16 那次「停旧与切换 325s」的来源：activate 要搬的 9 个条目都是上一版
// 留下的目录（311s ÷ 9 ≈ 34.6s/次），而每个目录里其实只有个位数文件。
// 因此：小树一律「建目录 + 逐个搬文件」，只有超过 PERFILE_LIMIT 的大树才赌一次整目录
// 改名（那是本地盘上的单系统调用优化；发布目录按设计已不再含大内容树）。
const PERFILE_LIMIT = 20000;

// 只 mkdir 目录、只 rename 文件：**绝不对目录做改名**。
// mkdir 与文件改名在本卷都是 0.00s 级，所以整棵树的成本≈文件数×0.1ms，与目录的年龄无关。
function moveFlat(source, target) {
  mkdir(target);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) moveFlat(from, to);
    else fs.renameSync(from, to);
  }
  fs.rmdirSync(source);
}

// iCloud can block renaming populated directories. Move files into ordinary
// directories instead; rollback can merge a partially moved tree after
// interruption. A whole-directory rename is only attempted for very large
// trees, where one syscall still beats a per-file walk on ordinary disks.
function moveTree(source, target) {
  if (!fs.lstatSync(source).isDirectory()) {
    if (exists(target)) throw new Error(`恢复目标已存在：${target}`);
    fs.renameSync(source, target);
    return;
  }
  if (countFiles(source) <= PERFILE_LIMIT) {
    moveFlat(source, target);
    return;
  }
  try {
    fs.renameSync(source, target);
  } catch (error) {
    // 这条回退仍然保留：大树改名在本卷上可能失败，也可能「成功但很慢」。
    const files = countFiles(source);
    const began = Date.now();
    process.stderr.write(`[rotate] 目录改名失败（${error.code || error.message}），回退逐文件搬移：${path.basename(source)}，${files} 个文件\n`);
    moveFlat(source, target);
    process.stderr.write(`[rotate] 逐文件搬移完成：${path.basename(source)}，${files} 个文件用了 ${((Date.now() - began) / 1000).toFixed(1)}s\n`);
  }
}

function moveItem(sourceRoot, name, destinationRoot, paths, transaction, rename = moveTree) {
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
    // 轮替这一段过去没有任何可观测性：一旦被文件系统拖住，启动脚本只会表现为
    // 「几分钟没有任何输出」。这里把子步骤耗时与本次搬移的文件数都打出来
    // （`[rotate]` 行），失败也打——否则「卡在哪一步」永远只能靠猜。
    const startedAt = Date.now();
    let checkpoint = startedAt;
    const phases = [];
    const moved = [];
    let movedFiles = 0;
    let reported = false;
    const mark = label => {
      const now = Date.now();
      phases.push(`${label} ${((now - checkpoint) / 1000).toFixed(1)}s`);
      checkpoint = now;
    };
    // 失败路径上内层 catch 会先报一次，外层再补一次；同一段轮替只留一行，
    // 否则回看 activate.log 时两个「合计」互相矛盾（后一个是含恢复的时长）。
    // 分两行写：`[rotate]` 是给人看的摘要（会被启动脚本贴进进度行，必须短），
    // `[rotate-all]` 是 12 项搬移的完整账本，只留在 activate.log 里备查。
    const report = () => {
      if (reported) return;
      reported = true;
      const slow = moved
        .filter(item => item.seconds > 0.5)
        .sort((left, right) => right.seconds - left.seconds)
        .slice(0, 4)
        .map(item => `${item.label} ${item.seconds.toFixed(1)}s/${item.files}文件`);
      process.stdout.write(
        `[rotate] ${phases.join(' · ')} · 合计 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
        + `${moved.length > 0 ? ` · 搬移 ${movedFiles} 个文件` : ''}`
        + `${slow.length > 0 ? ` · 慢项 ${slow.join('，')}` : ''}\n`,
      );
      if (moved.length > 0) {
        process.stdout.write(`[rotate-all] ${moved.map(item => `${item.label} ${item.seconds.toFixed(1)}s/${item.files}文件`).join('，')}\n`);
      }
    };
    const rename = options.rename || ((source, target) => {
      const label = `${path.basename(path.dirname(source))}/${path.basename(source)}`;
      const files = countFiles(source);
      const began = Date.now();
      try {
        moveTree(source, target);
      } finally {
        const seconds = (Date.now() - began) / 1000;
        movedFiles += files;
        moved.push({ label, seconds, files });
        // 发布目录里正常只有个位数文件（内容数据已移出构建产物）。单次搬移超过 3 秒
        // 说明大目录又回到了发布路径上，必须立刻可见，而不是等 5 分钟。
        if (seconds > 3) {
          process.stderr.write(`[rotate] 搬移 ${label} 用了 ${seconds.toFixed(1)}s（${files} 个文件），远高于正常值\n`);
        }
      }
    });
    try {
      if (transactionFor(paths)) throw new Error('已有未完成的发布轮替');
      mark('事务检查');
      assertNoRunningReferences(root);
      mark('进程扫描');
      const metadata = validateCandidate(root, paths.tmp);
      if (expectedReleaseId && metadata.releaseId !== expectedReleaseId) {
        throw new Error(`候选 releaseId 不匹配：${metadata.releaseId}`);
      }
      mark('候选校验');
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
      try {
        for (const name of ITEM_NAMES) moveItem(paths.previous, name, oldPrevious, paths, transaction, rename);
        mark('搬走旧上一版');
        for (const name of ITEM_NAMES) moveItem(paths.current, name, oldCurrent, paths, transaction, rename);
        mark('搬走现行版');
        for (const name of ITEM_NAMES) moveItem(paths.tmp, name, newCandidate, paths, transaction, rename);
        mark('搬入候选');
        mkdir(paths.current); mkdir(paths.previous);
        for (const name of ITEM_NAMES) moveItem(oldCurrent, name, paths.previous, paths, transaction, rename);
        mark('回填上一版');
        for (const name of ITEM_NAMES) moveItem(newCandidate, name, paths.current, paths, transaction, rename);
        mark('候选就位');
        transaction.state = 'active';
        atomicWrite(paths.transaction, `${JSON.stringify(transaction, null, 2)}\n`);
        mark('落事务');
        report();
        return metadata;
      } catch (error) {
        report();
        try { restoreActivation(paths, transaction); } catch (restoreError) {
          throw new Error(`${error.message}；且无法恢复旧版本：${restoreError.message}`);
        }
        throw error;
      }
    } catch (error) {
      report();
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
    if (targetExists) moveTree(target, source);
    else if (!sourceExists) throw new Error(`轮替记录与文件状态冲突：${entry.target}`);
    transaction.moves.pop();
    atomicWrite(paths.transaction, `${JSON.stringify(transaction, null, 2)}\n`);
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
    '用法：node scripts/build-release.cjs <recover|prepare|validate|current-fresh|activate|commit|rollback> [--root 目录] [--release-id ID]',
    'prepare 运行 Cargo/Vite 并生成 build/tmp 候选；activate 切换三件制品；commit/rollback 完成健康检查后的结果。',
    'current-fresh 判定输入指纹未变化且现行版本即该指纹产物（启动脚本据此跳过构建与轮替）。',
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

// True when no rebuild is needed: every build input matches the last prepare
// fingerprint and build/current is exactly the release that fingerprint
// produced. The launcher uses this to skip Cargo/Vite and the whole rotation
// on unchanged restarts. Any doubt (missing stamp, pending transaction,
// invalid current) returns false and the caller falls back to a full build.
function currentFresh(root) {
  const paths = rootPaths(root);
  if (transactionFor(paths)) return false;
  const fingerprint = computeFingerprint(root);
  if (!fingerprint) return false;
  const stamp = loadStamp(paths);
  if (!stamp || stamp.fingerprint !== fingerprint) return false;
  const active = validateCurrent(root);
  if (!active || active.releaseId !== stamp.releaseId) return false;
  if (!exists(path.join(paths.current, 'client', 'index.html'))) return false;
  if (!exists(path.join(paths.current, 'server', expectedServerName()))) return false;
  return true;
}

function main(argv = process.argv) {
  const command = argv[2];
  if (!command) throw new Error(usage());
  const opts = options(argv);
  let result;
  if (command === 'recover') result = withLock(opts.root, paths => { recoverInterrupted(paths); return null; });
  else if (command === 'prepare') result = prepare(opts.root);
  else if (command === 'validate') result = validateCandidate(opts.root);
  else if (command === 'current-fresh') result = currentFresh(opts.root);
  else if (command === 'activate') result = activate(opts.root, opts.releaseId);
  else if (command === 'commit') result = finish(opts.root, opts.releaseId, false);
  else if (command === 'rollback') result = finish(opts.root, opts.releaseId, true);
  else throw new Error(usage());
  process.stdout.write(`${JSON.stringify(result)}\n`);
  // current-fresh 的判定结果通过退出码表达：false 必须 exit 1，
  // 否则启动脚本会误判「现行版本新鲜」而跳过构建（曾导致旧版本顶替新协议被拉起）。
  if (command === 'current-fresh' && !result) process.exitCode = 1;
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
  computeFingerprint,
  currentFresh,
  finish,
  main,
  prepare,
  readMetadata,
  rootPaths,
  withLock,
  validateCandidate,
  validateCurrent,
};
