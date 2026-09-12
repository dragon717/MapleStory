#!/usr/bin/env node
/**
 * 在 macOS 上打出 Windows 端可用的资源包。
 *
 * 产物：artifacts/win-bundle/MapleStory-win-<content版本>.zip
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
const STAGE = path.join(ROOT, 'artifacts', 'win-bundle');
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
  'start.bat',
  'stop.bat',
];

const DIRS = [
  'shared',                          // 全部运行时 JSON + protocol.ts
  'server/src',
  'client/src',
  'client/public-tms273/assets',     // 约 311MB 静态美术/音频资源
];

// 明确不打包：node_modules、dist-*（Windows 端现场构建）、evidence、.DS_Store 等
const README_NAME = 'README-WIN.md';

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
     大约需要几分钟。构建日志在 \`evidence/runtime/windows-3010/build.log\`。
   - 构建完成后服务监听 \`0.0.0.0:3010\`。
3. 浏览器打开 http://127.0.0.1:3010/ （局域网其他设备用 http://<本机IP>:3010/）。
4. 停止：双击 \`stop.bat\`（账号数据库会保留）。

## 数据与常见问题

- 账号 / 角色数据在 \`server/data/tms273.sqlite3\`，首次启动自动创建。
  备份这一个文件即等于备份全部存档。
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

  console.log(`[win-bundle] 内容版本: ${version}`);
  fs.mkdirSync(PKG_ROOT, { recursive: true });
  fs.rmSync(PKG_ROOT, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });
  fs.mkdirSync(PKG_ROOT, { recursive: true });

  console.log('[win-bundle] 复制文件...');
  for (const rel of FILES) copyFile(rel);
  console.log('[win-bundle] 复制目录（assets 约 311MB，请稍候）...');
  for (const rel of DIRS) {
    console.log(`  - ${rel}`);
    copyDir(rel);
  }
  stripJunk(PKG_ROOT);
  writeReadme(version);

  console.log('[win-bundle] 压缩 zip...');
  execFileSync('zip', ['-rq', zipPath, 'MapleStory'], { cwd: STAGE, stdio: 'inherit' });

  const mb = (n) => (n / 1024 / 1024).toFixed(1) + 'MB';
  console.log(`[win-bundle] 目录: ${PKG_ROOT} (${mb(dirSize(PKG_ROOT))})`);
  console.log(`[win-bundle] 产物: ${zipPath} (${mb(fs.statSync(zipPath).size)})`);

  // zip 已生成，暂存目录（zip 内容本体）用完即删，只留产物
  fs.rmSync(PKG_ROOT, { recursive: true, force: true });
  console.log('[win-bundle] 暂存目录已清理，artifacts/win-bundle/ 只保留 zip');
}

main();
