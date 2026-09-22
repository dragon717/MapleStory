// update-service.check.ts — 强制更新状态机的离线检查（v3 §6.3 / U01 U02 U04）。
//
// 钉住的是**契约**，不是某次网络结果：
//   * 兼容性只做校验、不放宽：协议或内容版本不一致**如实**报成 blocked（U04）；但
//     `blocked` 是说明、不是死路——用户明确点的「应用」必须导航到那份发布（见 ⑤/⑤b）；
//   * 检查失败不假报成功，也不导航；
//   * 重复点击合并成一次检查（U01），导航只发生一次；
//   * 入口 URL 不用 `location.reload(true)`：导航到带发布标识的根地址；
//   * 修复代数只在用户明确选择修复时推进，普通更新保持原代数。
//
// 仓库约定：`.ts` 检查会被 `tsc --noEmit` 类型检查，因此这里不 import
// `node:*`（项目没有 @types/node），断言用本文件自带的 equal/ok。

export {};
// runtime-config 在模块顶层读取 `__CODE_MODE__`（构建期 define），stub 必须先于装载。
Object.defineProperty(globalThis, '__CODE_MODE__', { value: 'BUILT_PACKAGE' });

const { UpdateService, evaluateCompatibility, entryUrl } = await import('./update-service.ts');
const { PROTOCOL_VERSION, CONTENT_VERSION } = await import('../../../../shared/protocol.ts');

function equal(actual: unknown, expected: unknown, label = '') {
  if (actual !== expected) throw new Error(`${label} expected ${String(expected)}, received ${String(actual)}`);
}
function ok(label: string) { console.log(`  ok  ${label}`); }

const compatible = { releaseId: 'r-1', protocolVersion: PROTOCOL_VERSION, contentVersion: CONTENT_VERSION, assetRevision: null, desktop: null };

// ① 兼容性：只校验，不放宽。
equal(evaluateCompatibility(compatible as never), 'compatible', 'compatible');
equal(evaluateCompatibility({ ...compatible, protocolVersion: PROTOCOL_VERSION + 1 } as never), 'incompatible-protocol', 'protocol');
equal(evaluateCompatibility({ ...compatible, contentVersion: `${CONTENT_VERSION}-next` } as never), 'incompatible-content', 'content');
ok('协议 / 内容版本不一致分别被判为两种阻塞，不降级放行');

// ② 重复点击合并：一次检查、一次导航。
let fetches = 0;
let navigated: string[] = [];
const service = new UpdateService({
  navigate: url => { navigated.push(url); },
  fetchRelease: async () => { fetches++; return compatible as never; },
  href: () => 'http://127.0.0.1:3010/?lang=zh',
});
// 真的是**并发**两次点击（都在在途任务结束前发起），不是先等一次再发起第二次。
const [first, second] = await Promise.all([service.check(), service.check()]);
equal(fetches, 1, 'U01 并发点击');
equal(first.phase, 'verified', 'first');
equal(second.phase, 'verified', 'second');
ok('U01：并发点击合并为单个在途任务');

// ③ 应用：导航一次，地址带发布标识，保留既有的 lang 参数。
await service.apply(false);
equal(navigated.length, 1, '一次确认只导航一次');
const url = new URL(navigated[0] ?? '');
equal(url.pathname, '/', 'pathname');
equal(url.searchParams.get('r'), 'r-1', 'release id');
equal(url.searchParams.get('lang'), 'zh', 'lang');
equal(url.searchParams.get('ce'), null, '普通更新不得带修复代数');
ok('U03：入口 URL 带发布标识，普通更新不带修复代数');

// ④ 失败路径：不导航、不假成功。
navigated = [];
const failing = new UpdateService({
  navigate: url2 => { navigated.push(url2); },
  fetchRelease: async () => { throw new Error('offline'); },
  href: () => 'http://127.0.0.1:3010/',
});
const failed = await failing.apply(true);
equal(failed.phase, 'failed', 'failed phase');
equal(failed.reason, 'network', 'failed reason');
equal(navigated.length, 0, '检查失败不得导航');
ok('U02：检查失败停在 failed，不导航、不报成功');

// ⑤ 不兼容发布：`check()` 照旧**如实**报 blocked（校验不放宽）；但用户明确点的
//    「强制更新」必须给得出补救——导航到那份发布（`blocked` 恰恰是最该重载的现场：
//    页面陈旧 / 服务端在页面脚下换了一代）。此前这里钉的是「不兼容不得导航」，
//    结果「强制更新」在唯一需要它的场景里失效（2026-09-22 用户实测）。
navigated = [];
const blocked = new UpdateService({
  navigate: url3 => { navigated.push(url3); },
  fetchRelease: async () => ({ ...compatible, protocolVersion: PROTOCOL_VERSION + 1 }) as never,
  href: () => 'http://127.0.0.1:3010/',
});
const blockedState = await blocked.check();
equal(blockedState.phase, 'blocked', 'blocked phase');
equal(blockedState.reason, 'incompatible-protocol', 'blocked reason');
equal(navigated.length, 0, '只检查、用户还没点应用时不得导航');
await blocked.apply(false);
equal(navigated.length, 1, '用户点应用后必须导航一次');
equal(new URL(navigated[0] ?? '').searchParams.get('r'), 'r-1', '导航到该发布的入口');
ok('U04：不兼容如实报 blocked（不放宽校验），且用户点应用时给出重载这条路');

// ⑤b 内容版本不一致（页面陈旧的常见形态）同样：报告 + 可重载。
navigated = [];
const blockedContent = new UpdateService({
  navigate: url4 => { navigated.push(url4); },
  fetchRelease: async () => ({ ...compatible, contentVersion: `${CONTENT_VERSION}-next` }) as never,
  href: () => 'http://127.0.0.1:3010/',
});
const contentState = await blockedContent.apply(false);
equal(contentState.phase, 'applying', 'applying phase');
equal(contentState.reason, 'applying', 'applying reason');
equal(navigated.length, 1, '内容不一致同样给得出重载');
ok('内容版本不一致（页面陈旧）：同样给得出重载，不再停在死路');

// ⑥ 修复代数：只有明确修复才出现在 URL 上。
equal(new URL(entryUrl('http://127.0.0.1:3010/', 'r-9', 3)).searchParams.get('ce'), '3', 'repair epoch');
equal(new URL(entryUrl('http://127.0.0.1:3010/', 'r-9')).searchParams.get('ce'), null, 'no epoch');
ok('修复代数只随用户确认的修复进入入口地址');

console.log('\nupdate-service.check: 7 组断言全部通过');
