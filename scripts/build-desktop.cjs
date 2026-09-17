#!/usr/bin/env node
/**
 * 桌面安装包构建（v3 §10.2）。
 *
 * 这个脚本只负责**把同一份 Web 前端装进系统 WebView 并产出安装包**，不发明第二套
 * 业务，也不碰正在运行的发布目录。四条硬边界：
 *
 *   1. **独立暂存区**：产物落在 `build/desktop/<target>/<buildId>/`，绝不写
 *      `build/current`（那是正在跑的服务读的目录），也不与配对发布的 `build/tmp`
 *      争用那个「可被清空」的目录（v3 §10.2）。
 *   2. **前端来源一致**：`frontendDist` 由本脚本生成的 config overlay 指定，
 *      与 vite 的 `MAPLE_DESKTOP_DIST` 指向**同一个**目录，不靠人去对齐两处配置。
 *   3. **来源进编译期**：`MAPLE_API_BASE` / `MAPLE_ASSET_BASE` 同时写进 Rust 常量
 *      （`option_env!`）与 CSP，所以「页面能连的」与「外壳注入的」必然一致，
 *      也不会出现只改了一侧的错配。
 *   4. **不伪造分发产物**：没有签名身份时不生成下载目录、不写更新指针——
 *      那属于真实发布环境（v3 §10.3 / §12-D1），缺什么就在这里如实报出来。
 *
 * 用法：
 *   node scripts/build-desktop.cjs --api-base https://world.example.com \
 *        --asset-base https://content.example.com
 *   node scripts/build-desktop.cjs --plan            # 只打印将要执行的步骤
 *   node scripts/build-desktop.cjs --frontend-only   # 只产出暂存前端（不做原生打包）
 */

'use strict';

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CLIENT = path.join(ROOT, 'client');
const TAURI = path.join(CLIENT, 'src-tauri');
const DESKTOP_ROOT = path.join(ROOT, 'build/desktop');
/** Tauri 2 的 config overlay 只覆盖需要变的字段，其余继承 tauri.conf.json。 */
const OVERLAY_FILE = 'tauri.conf.generated.json';

function parseArgs(argv) {
  const options = { apiBase: '', assetBase: '', target: '', plan: false, frontendOnly: false, targetTriple: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--api-base') options.apiBase = argv[++index] ?? '';
    else if (arg === '--asset-base') options.assetBase = argv[++index] ?? '';
    else if (arg === '--target') options.targetTriple = argv[++index] ?? '';
    else if (arg === '--plan') options.plan = true;
    else if (arg === '--frontend-only') options.frontendOnly = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node scripts/build-desktop.cjs [--api-base <url>] [--asset-base <url>] [--target <triple>] [--plan|--frontend-only]');
      process.exit(0);
    } else {
      console.error(`未知参数: ${arg}`);
      process.exit(2);
    }
  }
  return options;
}

/** 只接受 http(s) 绝对来源；来源位不允许出现路径/查询/空白。 */
function sanitizeBase(value, label) {
  if (value === '') return '';
  const trimmed = value.trim().replace(/\/+$/, '');
  const match = /^(https?):\/\/([^\s/?#]+)$/i.exec(trimmed);
  if (!match) {
    console.error(`${label} 必须是 http(s) 的 scheme+主机形式（不能带路径/查询/空白）：${value}`);
    process.exit(2);
  }
  return `${match[1].toLowerCase()}://${match[2]}`;
}

/**
 * 桌面 CSP（v3 §9.4）。只放**实际用到**的来源：
 *   - `connect-src` 必须含远端 API 与内容来源，因为 Phaser 用 XHR 加载图片和音频，
 *     不是走 `<img>`/`<audio>` 标签；
 *   - `img-src`/`media-src` 另加 `blob:`（Phaser 解码后的对象 URL）；
 *   - `style-src` 需要 `'unsafe-inline'`：现有 DOM UI 大量使用内联样式，
 *     先盘点再收窄，而不是放一个最严格策略然后声称能跑。
 */
function contentSecurityPolicy(apiBase, assetBase) {
  const connect = ["'self'"];
  const img = ["'self'", 'data:', 'blob:'];
  const media = ["'self'", 'blob:'];
  if (assetBase !== '') {
    connect.push(assetBase);
    img.push(assetBase);
    media.push(assetBase);
  }
  if (apiBase !== '') {
    connect.push(apiBase);
    // WebSocket 走 ws:/wss:，不是 http(s):，必须单独列出。
    connect.push(apiBase.replace(/^http/, 'ws'));
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src ${img.join(' ')}`,
    `media-src ${media.join(' ')}`,
    `font-src 'self'`,
    `connect-src ${connect.join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function shortRevision() {
  try {
    return execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    // 没有 git 也要能构建：用时间戳兜底，并在产物里标明无法追溯来源。
    return 'nogit';
  }
}

/** `YYYYMMDDHHmmss-<短哈希>`，与仓库既有候选发布 id 同形。 */
function buildId() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${shortRevision()}`;
}

function hostTriple() {
  const architecture = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const platform = process.platform === 'darwin' ? 'apple-darwin' : process.platform === 'win32' ? 'pc-windows-msvc' : 'unknown-linux-gnu';
  return `${architecture}-${platform}`;
}

/** 防止把暂存区指到正在运行的发布目录或配对发布的可清空目录（v3 §10.2）。 */
function assertStagingIsIsolated(staging) {
  for (const forbidden of [path.join(ROOT, 'build/current'), path.join(ROOT, 'build/tmp')]) {
    if (staging === forbidden || staging.startsWith(forbidden + path.sep)) {
      console.error(`拒绝构建：桌面暂存区不得落在 ${path.relative(ROOT, forbidden)} 内（那是运行中/配对发布的目录）`);
      process.exit(1);
    }
  }
  if (!staging.startsWith(DESKTOP_ROOT + path.sep)) {
    console.error(`拒绝构建：桌面暂存区必须位于 ${path.relative(ROOT, DESKTOP_ROOT)} 之下`);
    process.exit(1);
  }
}

function sha256OfFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 收集 Tauri 产出的安装包（dmg/nsis/msi/appimage/deb…），排除中间目录。 */
function collectArtifacts(targetDir) {
  const extensions = new Set(['.dmg', '.exe', '.msi', '.appimage', '.deb', '.rpm', '.app.tar.gz', '.sig']);
  const found = [];
  const walk = dir => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // bundle 下的 `macos/<App>.app` 是中间产物，最终 dmg 才是交付物。
        if (entry.name.endsWith('.app')) continue;
        walk(full);
      } else if (extensions.has(path.extname(entry.name).toLowerCase()) || entry.name.endsWith('.app.tar.gz')) {
        found.push(full);
      }
    }
  };
  walk(path.join(targetDir, 'release', 'bundle'));
  return found;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const apiBase = sanitizeBase(options.apiBase, '--api-base');
  const assetBase = sanitizeBase(options.assetBase, '--asset-base');
  const targetTriple = options.targetTriple || hostTriple();
  const id = buildId();
  const staging = path.join(DESKTOP_ROOT, targetTriple, id);
  const frontendDist = path.join(staging, 'frontend');
  assertStagingIsIsolated(frontendDist);

  const runner = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const steps = [
    `暂存区        ${path.relative(ROOT, staging)}`,
    `前端输出      MAPLE_DESKTOP_DIST=${path.relative(ROOT, frontendDist)}（vite build）`,
    `配置覆盖      ${path.relative(ROOT, path.join(staging, OVERLAY_FILE))}（frontendDist / CSP / 版本）`,
    `编译期来源    MAPLE_API_BASE=${apiBase || '(未设置)'}  MAPLE_ASSET_BASE=${assetBase || '(未设置)'}`,
    `原生打包      ${runner} tauri build --config <覆盖> --target ${targetTriple}`,
    `产物审计      node scripts/check_tms273_desktop_package.cjs --staging ${path.relative(ROOT, staging)}`,
  ];
  console.log(`桌面构建 ${id}（目标 ${targetTriple}）`);
  for (const step of steps) console.log(`  · ${step}`);
  if (apiBase === '' || assetBase === '') {
    // v3 §10.3：服务端与资源服务是发布前提，不是打包按钮能变出来的能力。
    console.log('  ! 未设置 api-base/asset-base：产物只能连同源端点，**不可用于正式分发**。');
  }
  if (options.plan) return;

  fs.mkdirSync(staging, { recursive: true });
  const overlay = {
    version: id,
    build: { frontendDist: path.relative(TAURI, frontendDist).split(path.sep).join('/') },
    app: { security: { csp: contentSecurityPolicy(apiBase, assetBase) } },
  };
  fs.writeFileSync(path.join(staging, OVERLAY_FILE), JSON.stringify(overlay, null, 2));

  console.log('\n[1/3] 构建前端到桌面暂存区 …');
  const env = { ...process.env, MAPLE_DESKTOP_DIST: frontendDist };
  execFileSync(runner, ['vite', 'build'], { cwd: CLIENT, stdio: 'inherit', env });
  if (!fs.existsSync(path.join(frontendDist, 'index.html'))) {
    console.error(`前端构建没有产出 index.html：${frontendDist}`);
    process.exit(1);
  }

  if (!options.frontendOnly) {
    console.log('\n[2/3] 原生打包（Tauri）…');
    execFileSync(
      runner,
      ['tauri', 'build', '--config', path.join(staging, OVERLAY_FILE), '--target', targetTriple],
      {
        cwd: CLIENT,
        stdio: 'inherit',
        env: { ...env, MAPLE_API_BASE: apiBase, MAPLE_ASSET_BASE: assetBase },
      },
    );
  }

  console.log('\n[3/3] 清点产物 …');
  const artifacts = collectArtifacts(path.join(TAURI, 'target', targetTriple));
  const manifest = {
    buildId: id,
    target: targetTriple,
    apiBase: apiBase || null,
    assetBase: assetBase || null,
    createdAt: new Date().toISOString(),
    frontend: path.relative(ROOT, frontendDist).split(path.sep).join('/'),
    artifacts: artifacts.map(file => ({
      path: path.relative(ROOT, file).split(path.sep).join('/'),
      bytes: fs.statSync(file).size,
      sha256: sha256OfFile(file),
    })),
  };
  fs.writeFileSync(path.join(staging, 'artifacts.json'), JSON.stringify(manifest, null, 2));
  for (const artifact of manifest.artifacts) {
    console.log(`  · ${artifact.path}  ${(artifact.bytes / 1048576).toFixed(1)}MB  sha256=${artifact.sha256.slice(0, 16)}…`);
  }
  if (manifest.artifacts.length === 0) {
    // 不谎报成功：没有安装包就不打印「构建完成」。
    console.log('  ! 未找到安装包产物；若只跑了 --frontend-only，这是预期结果。');
  }
  console.log(`\n清单已写入 ${path.relative(ROOT, path.join(staging, 'artifacts.json'))}`);
  console.log('发布前仍需（v3 §12-D1，不在本脚本内冒充）：平台签名/公证、按平台的下载目录与更新指针。');
}

main();
