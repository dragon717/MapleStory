// version-heal.check.ts — 页面陈旧自愈的离线检查（2026-09-22 根因修复）。
//
// 钉住的是**契约**，不是某次网络结果：
//   * 服务端发布与本页同一版 ⇒ 不导航（不是「页面陈旧」）；
//   * 取发布描述失败 ⇒ 不导航、不猜测（U02 同款）；
//   * 陈旧页面 ⇒ 导航**一次**，且走既有 `entryUrl`（带发布标识、保留 lang）；
//   * 地址已带该发布标识 ⇒ 不导航——这是**防重载环**的唯一依据；
//   * 下一次发布换新 `releaseId` ⇒ 自动重新获得一次自愈机会（不需要清标记）。
//
// 仓库约定：`.ts` 检查会被 `tsc --noEmit` 类型检查，因此这里不 import
// `node:*`（项目没有 @types/node），断言用本文件自带的 equal/ok。

export {};
// runtime-config 在模块顶层读取 `__CODE_MODE__`（构建期 define），stub 必须先于装载。
Object.defineProperty(globalThis, '__CODE_MODE__', { value: 'BUILT_PACKAGE' });

const { healStalePage, describesThisBuild, triedReleaseId } = await import('./version-heal.ts');
const { entryUrl } = await import('./update-service.ts');
const { PROTOCOL_VERSION, CONTENT_VERSION } = await import('../../../../shared/protocol.ts');

function equal(actual: unknown, expected: unknown, label = '') {
  if (actual !== expected) throw new Error(`${label} expected ${String(expected)}, received ${String(actual)}`);
}
function ok(label: string) { console.log(`  ok  ${label}`); }

const ours = { releaseId: 'r-ours', protocolVersion: PROTOCOL_VERSION, contentVersion: CONTENT_VERSION, assetRevision: null, desktop: null };
const theirs = { ...ours, releaseId: 'r-3010', contentVersion: `${CONTENT_VERSION}-newer` };
const base = 'http://127.0.0.1:3010/?lang=zh';

// ① 判定方向：协议或内容任一不同都算「不是本页这一版」。
equal(describesThisBuild(ours as never), true, 'ours');
equal(describesThisBuild({ ...ours, protocolVersion: PROTOCOL_VERSION + 1 } as never), false, 'protocol');
equal(describesThisBuild(theirs as never), false, 'content');
ok('发布描述与本页是否同一版：协议与内容分别判定');

// ② 陈旧页面 ⇒ 导航一次，目标带发布标识、保留 lang，且**不带修复代数**。
//    （自愈不是「用户明确选择重新下载资源」，带上 `ce` 会让每次发布都重下全部资源。）
let navigated: string[] = [];
const reloaded = await healStalePage({ href: base, fetchRelease: async () => theirs as never, navigate: url => { navigated.push(url); } });
equal(reloaded, 'reloaded', 'outcome');
equal(navigated.length, 1, '一次自愈只导航一次');
const target = new URL(navigated[0] ?? '');
equal(target.pathname, '/', 'pathname');
equal(target.searchParams.get('r'), 'r-3010', '带发布标识');
equal(target.searchParams.get('lang'), 'zh', '保留 lang');
equal(target.searchParams.get('ce'), null, '自愈不得携带修复代数');
ok('陈旧页面：一次导航到服务端当前发布，保留 lang、不带修复代数');

// ③ 描述与本页同一版 ⇒ 不导航（可能只是登录真的失败）。
navigated = [];
const agrees = await healStalePage({ href: base, fetchRelease: async () => ours as never, navigate: url => { navigated.push(url); } });
equal(agrees, 'descriptor-agrees', 'outcome');
equal(navigated.length, 0, '同一版不得导航');
ok('发布与本页同一版：不导航，交回调用方照旧报错');

// ④ 取描述失败 ⇒ 不导航、不假成功。
navigated = [];
const offline = await healStalePage({ href: base, fetchRelease: async () => { throw new Error('offline'); }, navigate: url => { navigated.push(url); } });
equal(offline, 'unavailable', 'outcome');
equal(navigated.length, 0, '取不到描述不得导航');
ok('U02：取发布描述失败停在 unavailable，不导航');

// ⑤ 防重载环：地址已经带上这次要去的发布标识 ⇒ 不再导航。
navigated = [];
const landed = entryUrl(base, theirs.releaseId);
equal(triedReleaseId(landed), 'r-3010', '地址记住了发布标识');
const again = await healStalePage({ href: landed, fetchRelease: async () => theirs as never, navigate: url => { navigated.push(url); } });
equal(again, 'already-tried', 'outcome');
equal(navigated.length, 0, '同一发布不得二次导航');
ok('防重载环：同一 releaseId 只自愈一次，仍然不一致就老实报错');

// ⑥ 下一次发布换新标识 ⇒ 重新获得自愈机会（不需要任何人来清标记）。
navigated = [];
const next = { ...theirs, releaseId: 'r-3011' };
const rearmed = await healStalePage({ href: landed, fetchRelease: async () => next as never, navigate: url => { navigated.push(url); } });
equal(rearmed, 'reloaded', 'outcome');
equal(new URL(navigated[0] ?? '').searchParams.get('r'), 'r-3011', '去到新发布');
ok('新发布自动重新获得一次自愈机会，无需清标记');

// ⑦ 地址不可解析时护栏 3 失效但不得抛出：退化为「照常自愈」。
equal(triedReleaseId('not a url'), null, 'unparseable href');
ok('地址不可解析：当作没有记忆，不影响其余护栏');

console.log('\nversion-heal.check: 7 组断言全部通过');
