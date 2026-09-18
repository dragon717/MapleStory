#!/usr/bin/env node
// lazy-texture.check.mjs — 运行期按需装载器的契约检查。
//
// 为什么值得单测：`ensureTextures` 是首屏体积收口的关键路径，它的失败方式是
// **静默**的——要么每帧重发同一个请求（失败重试风暴），要么把已就绪误判成未就绪
// （实体永远不出现），要么在 `scene.restart()` 之后被脏等待集合卡死。
// 三种都不报错，只是「不对劲」，所以判据必须是行为本身。
//
// 用假 scene（只实现 textures.exists / load.image / load.start / load.isLoading
// / load.on）而不是真 Phaser：这里要测的是判据与状态机，不是 Phaser 的装载实现。

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// `resource-url` 在真构建里同源同实例；这里换成恒等桩，免得把 asset-index 的
// fetch 状态也拖进来（与 asset-index.check.mjs 的处理一致）。
const source = (await readFile(new URL('./lazy-texture.ts', import.meta.url), 'utf8'))
  .replace(/import \{ resolveAssetUrl \} from '\.\/resource-url';/, 'const resolveAssetUrl = url => url;');
const code = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { ensureTextures, failedTextures } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

/** 假 scene：记录入队顺序、可控地宣布「装载完成」或「失败」。 */
function makeScene() {
  const keys = new Set();
  const enqueued = [];
  const listeners = new Map();
  let loading = false;
  return {
    keys, enqueued,
    settle() { loading = false; },
    fail(key) { for (const handler of listeners.get('loaderror') ?? []) handler({ key }); },
    scene: {
      textures: { exists: key => keys.has(key) },
      load: {
        image(key) { enqueued.push(key); },
        start() { loading = true; },
        isLoading: () => loading,
        on(event, handler) { listeners.set(event, [...(listeners.get(event) ?? []), handler]); },
      },
    },
  };
}

// ① 全部就绪 ⇒ true，且不再入队。
{
  const host = makeScene();
  host.keys.add('a.png');
  assert.equal(ensureTextures(host.scene, ['a.png']), true, '已就绪必须立刻返回 true');
  assert.deepEqual(host.enqueued, [], '已就绪不得重复入队');
}

// ② 缺一张 ⇒ 入队 + start + 本帧 false；同一帧再问一次不得重复入队。
{
  const host = makeScene();
  assert.equal(ensureTextures(host.scene, ['a.png']), false, '未就绪必须返回 false');
  assert.deepEqual(host.enqueued, ['a.png']);
  assert.equal(ensureTextures(host.scene, ['a.png']), false, '在途期间仍为 false');
  assert.deepEqual(host.enqueued, ['a.png'], '在途期间不得重复入队');
}

// ③ 落地之后 ⇒ true，等待集合自愈（不需要额外通知）。
{
  const host = makeScene();
  ensureTextures(host.scene, ['a.png', 'b.png']);
  assert.deepEqual(host.enqueued, ['a.png', 'b.png'], '一次请求多张只入队一次');
  host.keys.add('a.png');
  assert.equal(ensureTextures(host.scene, ['a.png']), true, '只问已就绪的那张 ⇒ 立刻放行');
  assert.equal(ensureTextures(host.scene, ['a.png', 'b.png']), false, '还差 b.png：false');
  host.keys.add('b.png');
  host.settle();
  assert.equal(ensureTextures(host.scene, ['a.png', 'b.png']), true, '全部落地后必须 true');
}

// ④ 同一个 URL 重复出现只入队一次（调用点常把 icon 与 frames 一起传）。
{
  const host = makeScene();
  ensureTextures(host.scene, ['a.png', 'a.png', 'b.png', 'a.png']);
  assert.deepEqual(host.enqueued, ['a.png', 'b.png']);
}

// ⑤ 空集合 / undefined / null ⇒ true（调用点写的是 `asset.icon?.url`）。
{
  const host = makeScene();
  assert.equal(ensureTextures(host.scene, []), true);
  assert.equal(ensureTextures(host.scene, [undefined, null, '']), true);
  assert.deepEqual(host.enqueued, []);
}

// ⑥ 失败只记一次账，并且当作「已就绪」放行——不能每帧重发同一个 404。
{
  const host = makeScene();
  ensureTextures(host.scene, ['broken.png']);
  host.fail('broken.png');
  host.settle();
  assert.equal(ensureTextures(host.scene, ['broken.png']), true, '失败过 ⇒ 放行给调用方按现状绘制');
  assert.deepEqual(host.enqueued, ['broken.png'], '失败后不得重试');
  assert.deepEqual(failedTextures(host.scene), ['broken.png']);
}

// ⑦ 装载器忙时不插队：不加文件、也不报「就绪」，下一帧再来。
{
  const host = makeScene();
  host.scene.load.start();                 // 假装首屏装载还在跑
  assert.equal(ensureTextures(host.scene, ['a.png']), false, '装载器忙 ⇒ 本帧先别画');
  assert.deepEqual(host.enqueued, [], '不得往正在跑的批次里塞文件');
}

// ⑧ scene.restart 自愈：装载器空闲后，上一轮的等待集合必须被清掉，
//    否则切换地图后再回到这张图会永远等一个不会落地的 key。
{
  const host = makeScene();
  ensureTextures(host.scene, ['a.png']);   // 入队，isLoading=true
  host.settle();                           // 场景重启：装载器被重置，纹理缓存仍在
  assert.equal(ensureTextures(host.scene, ['a.png']), false, '需要重新装载 ⇒ false');
  assert.deepEqual(host.enqueued, ['a.png', 'a.png'], '空闲后必须能重新入队（旧等待集合已清理）');
}

console.log('assets lazy-texture: 就绪判据 / 去重 / 不插队 / 失败不重试 / 空闲自愈 通过。');
