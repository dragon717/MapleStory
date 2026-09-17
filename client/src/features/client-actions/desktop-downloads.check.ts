// desktop-downloads.check.ts — 桌面下载目录的纯函数检查（v3 §10.1 / D05）。
//
// 钉住的是「不给假链接」：列表为空、字段缺失、地址不是 http(s) 都如实当作
// 未发布；平台只是**推荐**，判断不出来就让用户自己选。
//
// 仓库约定：`.ts` 检查会被 `tsc --noEmit` 类型检查，因此这里不 import
// `node:*`（项目没有 @types/node）。

export {};
const { isSafeDownloadUrl, normalizeDesktopReleases, detectPlatform, releaseFor } = await import('./desktop-downloads.ts');

function equal(actual: unknown, expected: unknown, label = '') {
  if (actual !== expected) throw new Error(`${label} expected ${String(expected)}, received ${String(actual)}`);
}
function ok(label: string) { console.log(`  ok  ${label}`); }

// ① 只接受 http(s)。
for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'ftp://example.test/a.exe', '', '/relative/path.exe']) {
  equal(isSafeDownloadUrl(bad), false, `reject ${bad}`);
}
equal(isSafeDownloadUrl('https://example.test/win.exe'), true, 'https');
equal(isSafeDownloadUrl('http://example.test/win.dmg'), true, 'http');
ok('下载地址只接受 http(s)（v3 D05）');

// ② 未发布就是空列表，不补占位链接。
equal(normalizeDesktopReleases(undefined).length, 0, 'undefined');
equal(normalizeDesktopReleases([]).length, 0, 'empty');
equal(normalizeDesktopReleases([{ version: '0.1.0', platform: 'windows', url: 'javascript:alert(1)' }]).length, 0, 'bad url');
equal(normalizeDesktopReleases([{ version: '', platform: 'macos', url: 'https://x.test/a.dmg' }]).length, 0, 'empty version');
equal(normalizeDesktopReleases([{ version: '0.1.0', platform: 'solaris', url: 'https://x.test/a' }]).length, 0, 'bad platform');
ok('缺失字段 / 非法平台 / 非法协议一律丢弃，空列表即未发布');

// ③ 合法条目被保留且字段逐字保留。
const list = normalizeDesktopReleases([
  { version: '0.1.0', platform: 'macos', url: 'https://x.test/a.dmg', arch: 'aarch64', size: '12 MB', sha256: 'a'.repeat(64), publishedAt: '2026-09-17' },
  { junk: true },
]);
equal(list.length, 1, 'one release');
equal(list[0]?.platform, 'macos', 'platform');
equal(list[0]?.arch, 'aarch64', 'arch');
equal(list[0]?.sha256, 'a'.repeat(64), 'sha256');
ok('合法条目与其元数据逐字保留');

// ④ 平台只是推荐，不强制。
equal(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'windows', 'win');
equal(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'macos', 'mac');
equal(detectPlatform('Mozilla/5.0 (X11; Linux x86_64)'), 'linux', 'linux');
equal(detectPlatform(''), 'unknown', 'unknown');
equal(detectPlatform('', 'macOS'), 'macos', 'hint');
equal(releaseFor(list, 'unknown'), undefined, 'no recommendation');
equal(releaseFor(list, 'macos')?.url, 'https://x.test/a.dmg', 'macos url');
equal(releaseFor(list, 'windows'), undefined, 'windows missing');
ok('平台自述可推荐，unknown 时交给用户手动选择');

console.log('\ndesktop-downloads.check: 4 组断言全部通过');
