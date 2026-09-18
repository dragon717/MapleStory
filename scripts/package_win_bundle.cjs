#!/usr/bin/env node
/**
 * 在 macOS 上打出 Windows 端可用的资源包。
 *
 * 产物：build/current/packages/windows/MapleStory-win-<content版本>.zip
 * 解压后目录结构与仓库一致，Windows 端双击 start.bat 即可
 * （scripts/windows-control.ps1 会自动 npm ci → cargo build → vite build）。
 *
 * 用法：node scripts/package_win_bundle.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(ROOT, 'build', 'tmp'), { recursive: true });
const STAGE = fs.mkdtempSync(path.join(ROOT, 'build', 'tmp', 'windows-package-'));
const { publish } = require('./publish-package.cjs');
// 风铃运行期资源的单一权威断言模块；Windows 端 start.bat 跑的是同一个模块。
const windbellBundle = require('./check_windbell_bundle.cjs');
const PKG_ROOT = path.join(STAGE, 'MapleStory');

// ---------------------------------------------------------------------------
// 打包清单：与 scripts/windows-control.ps1 + server/src/main.rs 的运行时依赖对齐
// ---------------------------------------------------------------------------
const FILES = [
  'server/Cargo.toml',
  'server/Cargo.lock',
  'client/package.json',
  'client/package-lock.json',
  'client/tsconfig.json',
  'client/vite.config.ts',
  'client/index.html',
  'scripts/windows-control.ps1',
  'scripts/check_windows_resources.cjs',
  // 下面两行是 check_windows_resources.cjs 自己的 require：清单漏一个，Windows 端
  // start.bat 就在资源校验这一步 MODULE_NOT_FOUND 直接失败（包本身看不出问题）。
  // 复现依据：`tms273_creation_catalog.cjs` 一直是这条漏网（2026-09-18 实测），
  // 而 `check_windbell_bundle.cjs` 是新增的风铃台账断言模块。
  // 现在由本文件的 assertPackClosure() 反向核对，不再只靠人记得加。
  'scripts/tms273_creation_catalog.cjs',
  'scripts/check_windbell_bundle.cjs',
  'scripts/build-release.cjs',
  'start.bat',
  'stop.bat',
];

const DIRS = [
  'shared',                          // 全部运行时 JSON + protocol.ts
  'server/src',
  'client/src',
  'client/public-tms273/assets',     // 静态美术/音频 + 内容寻址对象库（实测约 1.5GB，其中 objects/ 638MB）
];
// `client/public-tms273/assets` 是**整棵**复制，风铃（assets/windbell）与其余内容簇一样
// 自动进包 ⇒ 这里**不要再单列**一条 `assets/windbell`，那会把同一批文件复制两份。
// 但「跟着复制过来」不等于「进包且完整」：拷完立刻拿风铃自己的台账逐条重算一遍
// （见 main 里的 windbellBundle.validate），缺一张图当场不产 zip。
// 风铃需要的额外照看是有原因的：它的地图不在 manifest.json 里（客户端 installWindbellMaps
// 注入），素材地址又硬编码在 scene.ts 的 preload 清单里，所以「遍历 manifest 引用」那套
// 判据看不见它——2026-09-18 就是这么让一张 prop-cart.png 丢了还照常出货的。

// 明确不打包：node_modules、dist-*（Windows 端现场构建）、evidence、.DS_Store 等
const README_NAME = 'README.md';

function contentVersion() {
  const proto = fs.readFileSync(path.join(ROOT, 'shared', 'protocol.ts'), 'utf8');
  const m = proto.match(/CONTENT_VERSION\s*=\s*["']([^"']+)["']/);
  return m ? m[1] : 'unknown';
}

function copyFile(rel) {
  const src = path.join(ROOT, rel);
  const dst = path.join(PKG_ROOT, rel);
  if (!fs.existsSync(src)) throw new Error(`缺少必需文件: ${rel}`);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function copyDir(rel) {
  const src = path.join(ROOT, rel);
  const dst = path.join(PKG_ROOT, rel);
  if (!fs.existsSync(src)) throw new Error(`缺少必需目录: ${rel}`);
  fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: false });
}

function stripJunk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.name === '.DS_Store' || entry.name === 'Thumbs.db') {
      fs.rmSync(full, { force: true });
    } else if (entry.isDirectory()) {
      stripJunk(full);
    }
  }
}

/**
 * 包内脚本的本地依赖必须闭合。
 *
 * 打包清单是**手写**的数组，所以「新增一行 `require('./x.cjs')` 却忘了加清单」这类
 * 漏网在 macOS 上完全看不出来（源仓库里那个文件一直在），到了 Windows 才以
 * `MODULE_NOT_FOUND` 炸在 start.bat 的资源校验步骤上。这里反过来读一遍清单里每个脚本，
 * 把 `require('./x')` 与 PowerShell 的 `$PSScriptRoot 'x'` 解析到**暂存树**里核对，
 * 缺哪个一次性列全，而不是让 Windows 端一次只报一个。
 *
 * 只查 `$PSScriptRoot`（= 脚本目录）而不查 `Join-Path $Root`：后者指的是构建产物、
 * 运行时目录、数据库这些**包交付后才产生**的路径，打包时刻本来就不该存在。
 */
function assertPackClosure() {
  const missing = [];
  for (const rel of FILES) {
    const file = path.join(PKG_ROOT, rel);
    const text = fs.readFileSync(file, 'utf8');
    const references = rel.endsWith('.ps1')
      ? [...text.matchAll(/\$PSScriptRoot\s+['"]([^'"]+)['"]/g)].map(match => `scripts/${match[1]}`)
      : [...text.matchAll(/require\((['"])(\.[^'"]+)\1\)/g)]
        .map(match => path.posix.join(path.posix.dirname(rel), match[2]));
    for (const reference of references) {
      const target = path.posix.normalize(reference);
      if (!fs.existsSync(path.join(PKG_ROOT, target))) missing.push(`${rel} -> ${target}`);
    }
  }
  if (missing.length) {
    throw new Error(`打包清单不闭合，Windows 端会 MODULE_NOT_FOUND：\n  ${missing.join('\n  ')}`);
  }
  console.log(`[win-bundle] 包内脚本依赖闭合（${FILES.length} 个清单项的 require / $PSScriptRoot 逐条核对）`);
}

function writeReadme(version) {
  const text = `# MapleStory Windows 端资源包使用说明

> 打包自 macOS 开发机，内容版本：${version}
> 本包不含预构建产物，Windows 端首次启动时由 start.bat 现场构建，保证与源码一致。

## 包内容

- \`shared/\` 服务端与客户端共用数据（地图、物品、技能、任务文本等）
- \`server/\` 服务端 Rust 源码（Cargo.toml / Cargo.lock / src）
- \`client/\` 客户端源码与静态资源（public-tms273/assets，约 311MB）
- \`scripts/windows-control.ps1\` 等启动控制脚本
- \`start.bat\` / \`stop.bat\` 一键启动 / 停止

## 环境要求（Windows）

1. Windows 10/11 64 位
2. Node.js ≥ 22.12（推荐 24 LTS）：https://nodejs.org
3. Rust（rustup 默认 MSVC 工具链）：https://rustup.rs
   以及 Visual Studio "使用 C++ 的桌面开发" 生成工具（首次编译需要）
4. 首次构建需要联网（npm ci 拉取依赖）

## 使用步骤

1. 将 \`MapleStory-win-*.zip\` 解压到本地磁盘任意目录。
   建议：纯英文路径，且不要放在 OneDrive / iCloud 等云同步盘里（同步盘会与构建产物抢写文件）。
2. 双击 \`start.bat\`：
   - 首次运行会自动：资源完整性校验 → \`npm ci\` → \`cargo build\` → \`vite build\`，
     大约需要几分钟。构建日志在 \`runtime/windows-3010/build.log\`。
   - 构建完成后服务监听 \`0.0.0.0:3010\`。
3. 浏览器打开 http://127.0.0.1:3010/ （局域网其他设备用 http://<本机IP>:3010/）。
4. 停止：双击 \`stop.bat\`（账号数据库会保留）。

## 数据与常见问题

- 账号 / 角色数据在 \`server/data/tms273.sqlite3\`，首次启动自动创建。
  停止服务后备份整个 server/data 目录，保留 SQLite 相关文件。
- 端口 3010 被占用时 start.bat 会报错退出，且不会强杀其他进程；
  请先手动结束占用者（或改系统里该进程）再启动。
- 更新代码后：先 \`stop.bat\` 再 \`start.bat\`，会自动重新构建并加载。
- 若杀毒软件拦截 maplestory-server.exe，加入信任即可（本地自编译产物）。
`;
  fs.writeFileSync(path.join(PKG_ROOT, README_NAME), text, 'utf8');
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

function main() {
  const version = contentVersion();
  const zipName = `MapleStory-win-${version}.zip`;
  const zipPath = path.join(STAGE, zipName);
  const mb = (n) => (n / 1024 / 1024).toFixed(1) + 'MB';

  console.log(`[win-bundle] 内容版本: ${version}`);
  fs.mkdirSync(PKG_ROOT, { recursive: true });
  fs.rmSync(PKG_ROOT, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });
  fs.mkdirSync(PKG_ROOT, { recursive: true });

  console.log('[win-bundle] 复制文件...');
  for (const rel of FILES) copyFile(rel);
  console.log('[win-bundle] 复制目录（assets 约 1.5GB，请稍候）...');
  for (const rel of DIRS) {
    console.log(`  - ${rel}`);
    copyDir(rel);
  }
  stripJunk(PKG_ROOT);
  assertPackClosure();

  // 包内容自证（压缩前跑，红了就不出货）。判据直接作用在**暂存树**上，而不是源仓库：
  // 这样证明的是「zip 里那份确实完整」，而不是「我源目录里看着挺全」。
  console.log('[win-bundle] 校验风铃运行期资源...');
  const windbell = windbellBundle.validate(PKG_ROOT);
  console.log(`[win-bundle] 风铃资源在包内：${windbell.files} 个台账文件（${mb(windbell.bytes)}）+ ${windbell.catalogFrames} 个 TMS273 帧，路径/字节/摘要逐条重算通过`);

  writeReadme(version);

  console.log('[win-bundle] 压缩 zip...');
  execFileSync('zip', ['-rq', zipPath, 'MapleStory'], { cwd: STAGE, stdio: 'inherit' });
  execFileSync('unzip', ['-tq', zipPath], { stdio: 'inherit' });

  console.log(`[win-bundle] 目录: ${PKG_ROOT} (${mb(dirSize(PKG_ROOT))})`);
  console.log(`[win-bundle] 产物: ${zipPath} (${mb(fs.statSync(zipPath).size)})`);

  // zip 已生成，暂存目录（zip 内容本体）用完即删，只留产物
  fs.rmSync(PKG_ROOT, { recursive: true, force: true });
  const published = publish(ROOT, 'windows', STAGE);
  console.log(`[win-bundle] 已发布：${published}；上一包保留在 build/previous/packages/windows/`);
}

try { main(); } finally { fs.rmSync(STAGE, { recursive: true, force: true }); }
