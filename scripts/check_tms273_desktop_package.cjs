#!/usr/bin/env node
//
// 门禁：桌面交付边界（v3 §9 / §10 / §13-D04 / §15）。
//
// 钉住的是「这个桌面包到底有没有越界」，而不是「能不能打包成功」。打包成功但把
// 服务器数据库、bot 凭据、签名私钥或 843MB 源素材一起发出去，比打不出来更糟。
//
//   1. **外壳是薄壳**：存在必要文件；依赖里没有 fs/shell/http 插件；capabilities
//      只授予 core 默认能力——没有通配文件系统、没有任意原生命令；
//   2. **不是第二份权威世界**：Rust 侧不得出现数据库、世界 tick、业务规则；
//      只允许「创建窗口 + 注入来源 + 校验来源」；
//   3. **来源受校验**：Rust 与客户端两侧都必须收窄 scheme，且 CSP 由构建脚本
//      按实际来源生成（`connect-src` 同时含 http 与 ws 变体）；
//   4. **暂存区隔离**：构建脚本禁止写 `build/current` 与 `build/tmp`，且产物目录
//      已被 .gitignore 忽略；
//   5. **暂存前端不含内容资源**：`frontendDist` 里只能有 index.html + 指纹 JS/CSS，
//      不能混进 manifest、地图美术、数据库或凭据（传 `--staging` 时逐项检查）。
//
// 本脚本只读；不启停服务、不访问网络、不碰数据库。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TAURI = path.join(ROOT, 'client/src-tauri');
const read = file => fs.readFileSync(file, 'utf8');
const rel = file => path.relative(ROOT, file).split(path.sep).join('/');
const group = label => console.log(`  ✔ ${label}`);

const stagingIndex = process.argv.indexOf('--staging');
const staging = stagingIndex >= 0 ? path.resolve(process.argv[stagingIndex + 1]) : null;

// ── 1. 外壳文件齐全 ────────────────────────────────────────────────────────
for (const file of ['Cargo.toml', 'build.rs', 'src/main.rs', 'tauri.conf.json', 'capabilities/default.json']) {
  assert.ok(fs.existsSync(path.join(TAURI, file)), `桌面外壳缺少 ${file}`);
}
const conf = JSON.parse(read(path.join(TAURI, 'tauri.conf.json')));
assert.equal(conf.identifier, 'cn.tms273.maplestory.desktop', 'identifier 必须是稳定的反向域名，发布后不可改');
for (const icon of conf.bundle.icon) {
  assert.ok(fs.existsSync(path.join(TAURI, icon)), `bundle.icon 声明的图标不存在：${icon}`);
}
// 只声明桌面目标：没有经过图形/音频验收的平台不许出现在发布清单里（v3 §10.1）。
for (const target of conf.bundle.targets) {
  assert.ok(['dmg', 'nsis', 'msi', 'app', 'deb', 'appimage'].includes(target), `未验收的打包目标：${target}`);
}
group('外壳文件与图标齐全，打包目标限于已验收平台');

// ── 2. 薄壳：依赖与权限都要收窄 ─────────────────────────────────────────────
const cargo = read(path.join(TAURI, 'Cargo.toml'));
// 去掉 TOML 注释再扫描：Cargo.toml 里正好用注释说明「没有引入 tauri-plugin-shell」，
// 不剥注释的话那句说明本身会被当成一次插件声明（假失败）。
const cargoCode = cargo.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
// 反向断言：能力插件必须逐个具名。清单为空＝当前一个插件都不允许，
// 想加就必须同时在这里登记，否则门禁失败。
const ALLOWED_PLUGINS = [];
const declaredPlugins = [...cargoCode.matchAll(/tauri-plugin-([a-z0-9-]+)/g)].map(match => match[1]);
const unregistered = declaredPlugins.filter(plugin => !ALLOWED_PLUGINS.includes(plugin));
assert.deepEqual(
  unregistered,
  [],
  `这些 Tauri 插件能力未登记（加插件必须说明「它替页面做了什么、为什么 WebView 做不到」）：\n${unregistered.join('\n')}`,
);
for (const forbidden of ['tauri-plugin-fs', 'tauri-plugin-shell', 'tauri-plugin-http', 'tauri-plugin-process']) {
  assert.ok(!cargoCode.includes(forbidden), `不得为「不改前端」而引入高权限插件：${forbidden}`);
}
const capability = JSON.parse(read(path.join(TAURI, 'capabilities/default.json')));
assert.deepEqual(capability.windows, ['main'], '权限只能授予主窗口');
for (const permission of capability.permissions) {
  assert.ok(!/^(fs|shell|http|process|dialog):/.test(permission), `权限越界：${permission}`);
  assert.ok(!permission.includes('*'), `不允许通配权限：${permission}`);
}
assert.deepEqual(capability.permissions, ['core:default'], '权限清单收窄到 core:default，新增必须显式改本检查');
group('依赖无高权限插件，权限收窄到 core:default（无通配）');

// ── 3. 不是第二份权威世界 ──────────────────────────────────────────────────
const shell = read(path.join(TAURI, 'src/main.rs'));
for (const forbidden of ['sqlite', 'rusqlite', 'ACCOUNT_DB', 'TICK_MS', 'tokio::spawn', 'std::net::TcpListener']) {
  assert.ok(!shell.includes(forbidden), `桌面外壳不得承载权威世界职责（发现 ${forbidden}）`);
}
assert.ok(shell.includes('WebviewWindowBuilder'), '必须由 Rust 侧创建窗口（才能在页面脚本前注入来源）');
assert.ok(shell.includes('__MAPLE_DESKTOP__'), '必须注入 window.__MAPLE_DESKTOP__（v3 §9.2）');
assert.ok(/serde_json::json!/.test(shell), '注入值必须经 JSON 序列化，不能手工拼字符串');
assert.ok(shell.includes('option_env!'), '来源必须是编译期常量：CSP 与注入值才必然一致');
// 两侧都要校验 scheme（Rust sanitize ↔ TS normalizeBase），单侧放宽就会错配。
assert.ok(shell.includes('fn sanitize('), 'Rust 侧必须校验来源 scheme');
const desktopConfig = read(path.join(ROOT, 'client/src/platform/desktop-config.ts'));
assert.ok(desktopConfig.includes('function normalizeBase('), '客户端侧必须同样校验来源');
assert.ok(/\^https\?:\\\/\\\/\[\\s\/\]\+/i.test(desktopConfig) || desktopConfig.includes('^https?:\\/\\/[^\\s/]+'), '客户端必须只接受 http(s) 绝对来源');
group('外壳不含数据库/世界 tick，来源两侧都收窄且经 JSON 注入');

// ── 4. 构建脚本与暂存区隔离 ─────────────────────────────────────────────────
const build = read(path.join(ROOT, 'scripts/build-desktop.cjs'));
assert.ok(build.includes('build/current') && build.includes('build/tmp'), '必须显式拒绝写运行中/配对发布目录');
assert.ok(/assertStagingIsIsolated/.test(build), '必须真的调用隔离断言，而不是只写注释');
assert.ok(build.includes('build/desktop'), '桌面产物必须在独立暂存区');
assert.ok(build.includes('MAPLE_DESKTOP_DIST'), '前端输出必须与 config overlay 指向同一目录');
const viteConfig = read(path.join(ROOT, 'client/vite.config.ts'));
assert.ok(viteConfig.includes('MAPLE_DESKTOP_DIST'), 'vite 必须支持桌面输出目标');
assert.ok(
  viteConfig.includes("resolve(projectRoot, 'build/tmp/client')"),
  '未设桌面目标时必须回落到原有 Web 输出目录（默认行为不变）',
);
const ignore = read(path.join(ROOT, '.gitignore'));
for (const entry of ['client/src-tauri/target/', 'build/desktop/']) {
  assert.ok(ignore.includes(entry), `.gitignore 必须忽略构建产物：${entry}`);
}
group('暂存区隔离、vite 目标可切换、构建产物不进版本库');

// ── 5. CSP 覆盖：远端来源要同时进 http 与 ws 变体 ───────────────────────────
assert.ok(/connect\.push\(apiBase\)/.test(build), 'CSP 的 connect-src 必须包含远端 API 来源');
assert.ok(/apiBase\.replace\(\/\^http\/, 'ws'\)/.test(build), 'CSP 必须单独列出 ws/wss 变体（WS 不是 http scheme）');
assert.ok(/connect\.push\(assetBase\)/.test(build), 'Phaser 用 XHR 取图音，内容来源也必须进 connect-src');
assert.ok(conf.app.security.csp.includes("default-src 'self'"), 'tauri.conf.json 必须保留同源默认 CSP');
group('CSP 按实际来源生成，http 与 ws 变体都覆盖');

// ── 6. 暂存前端不得夹带内容资源 / 凭据（传 --staging 时检查） ───────────────
if (staging !== null) {
  assert.ok(fs.existsSync(path.join(staging, 'frontend/index.html')), `暂存前端缺少 index.html：${rel(staging)}`);
  const overlay = JSON.parse(read(path.join(staging, 'tauri.conf.generated.json')));
  assert.ok(
    overlay.build.frontendDist.endsWith('/frontend'),
    'config overlay 的 frontendDist 必须指向暂存区内的 frontend 目录',
  );
  const offenders = [];
  const forbiddenNames = /(\.sqlite3(-shm|-wal)?$|\.wz$|\.dll$|credentials|bot.*\.json$|\.pem$|\.p12$|\.key$)/i;
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      // 内容资源目录（843MB 美术音频）绝不能被打进安装包。
      if (full.includes(`${path.sep}tms273${path.sep}`) || forbiddenNames.test(entry.name)) offenders.push(rel(full));
    }
  };
  walk(path.join(staging, 'frontend'));
  for (const name of ['manifest.json', 'gameplay.json', 'items.json', 'appearance.json']) {
    if (fs.existsSync(path.join(staging, 'frontend/assets', name))) offenders.push(rel(path.join(staging, 'frontend/assets', name)));
  }
  assert.deepEqual(offenders.slice(0, 20), [], `暂存前端夹带了不该进包的内容：\n${offenders.slice(0, 20).join('\n')}`);
  const scriptCount = fs.readdirSync(path.join(staging, 'frontend/assets')).filter(name => /\.js$/.test(name)).length;
  console.log(`  ✔ 暂存前端只有入口与指纹产物（${scriptCount} 个 JS chunk），无内容资源/凭据`);
} else {
  console.log('  · 未传 --staging：跳过暂存前端内容审计（构建后请带该参数复跑）');
}

console.log('\n桌面交付边界检查通过。');
