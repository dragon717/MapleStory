#!/usr/bin/env node
// asset-index.check.mjs — 内容寻址索引 + 资源解析器（v3 §4.1 / §3.1 / §5.3）。
//
// 分两段测，因为两者的失败方式不同：
//   A. `asset-index.ts` 自己：指针形状校验、幂等、降级不抛、原因可诊断。
//   B. `resource-url.ts` 的解析契约：**有映射 ⇒ 内容寻址地址；没映射 ⇒ 恒等**。
//
// B 段把 asset-index 换成一行可注入的桩，而不是把真模块也塞进 data: URL。
// 原因：同一个 data: URL 被 import 两次会得到**两份模块状态**，桩写不进解析器
// 读到的那一份，断言会失败在一个与产品无关的地方。两模块在真实构建里同源同实例
// （Vite 只打一份），所以这里改测「契约 + 接线」：
//   - 接线：resource-url.ts 必须 import asset-index（改写说明符失败即视为依赖被移除）。
//   - 契约：映射命中/未命中/带修复代数三种传输地址。
//
// 顺序有意为之：修复代数写进模块内存且不可回退，所以「无参数」的断言放在递进
// 代数之前；否则断言会因为 `?ce=N` 而被误判为失败。
//
// 装载方式沿用仓库既有约定：typescript 转译后经 `data:` URL 导入。

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const REVISION = 'c'.repeat(64);
const OBJECT = '/assets/objects/sha256/' + 'd'.repeat(64) + '.png';
const LOGICAL = '/assets/tms273/actor/00002000.img/stand1.0.png';
const read = name => readFile(new URL(`./${name}`, import.meta.url), 'utf8');
const transpile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const asDataUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;

// ── A. asset-index.ts ────────────────────────────────────────────────────────
const index = await import(asDataUrl(transpile(await read('./asset-index.ts'))));

/** 可切换的 fetch 桩：每次 loadAssetIndex() 都读当前行为。 */
let route = () => ({ status: 404, body: null });
globalThis.fetch = async url => {
  const { status, body, throwError } = route(String(url));
  if (throwError) throw new Error('network down');
  return { ok: status >= 200 && status < 300, status, json: async () => body };
};
const serve = (pointer, objects) => {
  route = url => {
    if (url === index.ASSET_POINTER_URL) return { status: 200, body: pointer };
    if (url === `/assets/objects/index/${REVISION}.json`) return { status: 200, body: { objects } };
    return { status: 404, body: null };
  };
};
const publish = () => serve({ revision: REVISION, index: `/assets/objects/index/${REVISION}.json` }, { [LOGICAL]: OBJECT });

// A1. 正常路径：指针自洽 ⇒ 建立映射并报告 revision。
publish();
await index.loadAssetIndex();
assert.equal(index.currentAssetRevision(), REVISION, '索引就绪后应报告 revision');
assert.equal(index.assetIndexFailure(), null, '成功时不应留下降级原因');
assert.equal(index.assetObjectUrl(LOGICAL), OBJECT, '逻辑地址应映射到内容寻址地址');
assert.equal(index.assetObjectUrl('/assets/not-in-index.png'), null, '未收录地址必须返回 null，而不是猜一个地址');

// A2. 幂等：把桩换成「一律 404」，若实现二次拉取就会清空映射。
route = () => ({ status: 404, body: null });
await index.loadAssetIndex();
assert.equal(index.assetObjectUrl(LOGICAL), OBJECT, 'loadAssetIndex 必须幂等，不得二次拉取覆盖映射');

// A3. 形状不符一律拒收，且必须留下可诊断原因。
for (const [label, pointer, objects] of [
  ['revision 过短', { revision: 'abc', index: '/assets/objects/index/abc.json' }, {}],
  ['revision 非十六进制', { revision: 'z'.repeat(64), index: `/assets/objects/index/${'z'.repeat(64)}.json` }, {}],
  ['索引地址与 revision 不一致', { revision: REVISION, index: '/assets/objects/index/other.json' }, {}],
  ['索引缺少 objects 映射', { revision: REVISION, index: `/assets/objects/index/${REVISION}.json` }, null],
]) {
  index.resetAssetIndexForTest();
  serve(pointer, objects);
  await index.loadAssetIndex();
  assert.equal(index.assetObjectUrl(LOGICAL), null, `${label}：不得建立映射`);
  assert.equal(index.currentAssetRevision(), null, `${label}：不得报告 revision`);
  assert.ok(index.assetIndexFailure() !== null, `${label}：必须留下可诊断的降级原因`);
}

// A4. 降级：对象库未建立 / 网络异常 —— 都不抛。
index.resetAssetIndexForTest();
route = () => ({ status: 404, body: null });
await index.loadAssetIndex();
assert.equal(index.assetObjectUrl(LOGICAL), null, '对象库未建立（指针 404）时不得建立映射');

index.resetAssetIndexForTest();
route = () => ({ throwError: true });
await index.loadAssetIndex();
assert.equal(index.assetObjectUrl(LOGICAL), null, '网络异常不得建立映射');
assert.ok(index.assetIndexFailure() !== null, '网络异常必须留下原因');

// ── B. resource-url.ts 的解析契约 ───────────────────────────────────────────
// 两个依赖都换成桩：asset-index（可注入映射）与 platform/desktop-config（可注入
// 远端来源）。裸路径在 data: URL 里解析不了，必须改写说明符。
const MAP_STUB = asDataUrl('export const assetObjectUrl = url => (globalThis.__assetObjects ?? {})[url] ?? null;');
const webConfigStub = asDataUrl('export const assetBase = "";\nexport const apiBase = "";');
const desktopConfigStub = asDataUrl('export const assetBase = "https://content.example.com";\nexport const apiBase = "https://world.example.com";');

const original = await read('./resource-url.ts');
function buildResourceModule(configStub) {
  const before = transpile(original);
  // 说明符允许带 `.ts` 后缀：本仓库对**直接由 Node 装载**的检查要求显式后缀
  // （见 resource-url.ts 顶部注释），而本检查只关心「这两个依赖还在、还能被改写」，
  // 不关心写不写后缀。写死「无后缀」会在依赖保留的情况下误报「依赖被移除」。
  const after = before
    .replace(/(['"])\.\/asset-index(?:\.ts)?\1/, `'${MAP_STUB}'`)
    .replace(/(['"])\.\.\/platform\/desktop-config(?:\.ts)?\1/, `'${configStub}'`);
  assert.notEqual(after, before, 'resource-url.ts 的依赖说明符改写失败（说明 asset-index / desktop-config 依赖被移除）');
  return asDataUrl(after);
}
const { resolveAssetUrl, bumpCacheEpoch, cacheEpoch } = await import(buildResourceModule(webConfigStub));

globalThis.__assetObjects = { [LOGICAL]: OBJECT };
assert.equal(resolveAssetUrl(LOGICAL), OBJECT, '映射命中 ⇒ 传输地址走内容寻址地址（强缓存）');
assert.equal(resolveAssetUrl('/assets/not-in-index.png'), '/assets/not-in-index.png', '映射未命中 ⇒ 恒等退回逻辑地址照常联网');
assert.equal(resolveAssetUrl('/api/health'), '/api/health', '非资源地址不受影响');
assert.equal(cacheEpoch(), 0, '未执行修复时代数为 0');
assert.equal(resolveAssetUrl(LOGICAL), OBJECT, '代数为 0 的普通刷新不带任何查询参数');

bumpCacheEpoch();
assert.equal(cacheEpoch(), 1, '确认修复后代数递增');
assert.equal(resolveAssetUrl(LOGICAL), `${OBJECT}?ce=1`, '修复代数应附加在内容寻址地址上（绕过本地旧副本）');
assert.equal(resolveAssetUrl('/assets/not-in-index.png'), '/assets/not-in-index.png?ce=1', '未收录资源同样要绕过旧副本');

globalThis.__assetObjects = {};
assert.equal(resolveAssetUrl(LOGICAL), `${LOGICAL}?ce=1`, '索引缺失时仍按逻辑地址取，且保留修复代数');

// ── C. 桌面远端来源：只作用于 /assets/**，且与修复代数叠加 ─────────────────
// 单独一份模块实例（代数为 0），避免复用上面已经递增过的代数。
globalThis.__assetObjects = { [LOGICAL]: OBJECT };
const desktop = await import(buildResourceModule(desktopConfigStub));
assert.equal(
  desktop.resolveAssetUrl(LOGICAL),
  `https://content.example.com${OBJECT}`,
  '桌面：游戏内容必须指向远端 assetBase（本地打包的前端里没有 843MB 美术）',
);
assert.equal(
  desktop.resolveAssetUrl('/assets/not-in-index.png'),
  'https://content.example.com/assets/not-in-index.png',
  '桌面：未收录资源同样走远端来源',
);
assert.equal(desktop.resolveAssetUrl('/api/health'), '/api/health', '桌面：API 不归资源解析器管，不得被 assetBase 前缀污染');
assert.equal(desktop.cacheEpoch(), 0, '新的模块实例代数为 0');
desktop.bumpCacheEpoch();
assert.equal(
  desktop.resolveAssetUrl(LOGICAL),
  `https://content.example.com${OBJECT}?ce=1`,
  '桌面：修复代数要加在远端对象地址上（前缀先于参数）',
);

console.log('assets asset-index: pointer shape guarded, wiring asserted, object address + cacheEpoch + desktop assetBase + graceful fallback pinned.');
