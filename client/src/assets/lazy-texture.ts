/**
 * 运行期按需装载（首屏体积收口）。
 *
 * 为什么需要它：`preload-plan.ts` 曾把**整份 manifest**（实测 22,594 张图）一次性
 * 入队。其中当前地图只有 92 张（0.4%），宠物 7,850 张（34.7%）、其余 198 张地图
 * 4,461 张、表情贴纸 3,727 张、物品图标 2,454 张——这些绝大多数在**进入游戏的
 * 那一刻根本用不到**。代价是实测「开始游戏 → 100%」26.1s（换算约 1.1ms/张，
 * 服务端 meanwhile 能跑 6,000 req/s，所以瓶颈在客户端逐张建纹理这一侧）。
 *
 * 收口方式：首屏只装载**当场就要画**的东西（当前地图 / 本角色 / 战斗与界面），
 * 其余类别改由本模块在**第一次真正要画它**时装载：
 *
 *     if (!ensureTextures(this, frames.map(frame => frame.url))) return;
 *
 * 约定与边界：
 *   ① 纹理 key 就是**逻辑 URL**（与 `preload-plan.ts` / `world.ts` 一致），
 *      所以判据是 `textures.exists(url)`，不需要另一套键名映射；
 *   ② 返回 `true` 表示「这批纹理现在就能画」；返回 `false` 表示「这一帧先别画」——
 *      调用方在下一帧自然重试，实体/贴纸晚一两帧出现，不必写异步回调；
 *   ③ **装载器忙时不插队**：正在跑的批次不会被临时塞文件（Phaser 的 `image()`
 *      加进正在跑的批次看不到），宁可下一帧再来；
 *   ④ 拉取失败**只记账不重试**（否则每帧都会重发同一个 404），并当作「已就绪」
 *      交给调用方按现状绘制——与今天「纹理没装载时画占位」的表现一致；
 *   ⑤ 空闲时清空等待集合：`isLoading()` 为假说明上一批已落地或已失败，
 *      集合里剩下的都是脏数据（`scene.restart()` 会重置装载器，必须能自愈）。
 */

import { resolveAssetUrl } from './resource-url';

/** 只依赖用到的三件事，便于离线检查塞一个假 scene。 */
export interface TextureHost {
  textures: { exists(key: string): boolean };
  load: {
    image(key: string, url: string): unknown;
    start(): unknown;
    isLoading(): boolean;
    on(event: string, handler: (file: unknown) => void): unknown;
  };
}

interface LazyState {
  /** 已交给装载器、还没见到纹理的 URL。 */
  pending: Set<string>;
  /** 拉取失败过的 URL：不再重试。 */
  failed: Set<string>;
  wired: boolean;
}

const states = new WeakMap<TextureHost, LazyState>();

function stateFor(scene: TextureHost): LazyState {
  let state = states.get(scene);
  if (!state) {
    state = { pending: new Set(), failed: new Set(), wired: false };
    states.set(scene, state);
  }
  if (!state.wired) {
    state.wired = true;
    // 只登记失败；成功靠 `textures.exists()` 观察，不需要额外事件。
    scene.load.on('loaderror', file => {
      const key = (file as { key?: unknown } | null)?.key;
      if (typeof key === 'string') state?.failed.add(key);
    });
  }
  return state;
}

/** 失败过的 URL（离线检查用；运行时无消费方）。 */
export function failedTextures(scene: TextureHost): string[] {
  return [...(states.get(scene)?.failed ?? [])];
}

/**
 * 确保这批 URL 的纹理可用；`false` ＝ 本帧先别画。
 *
 * 传入 `undefined`/空串会被忽略——调用点常常直接写 `asset.icon?.url`。
 */
export function ensureTextures(scene: TextureHost, urls: ReadonlyArray<string | undefined | null>): boolean {
  const state = stateFor(scene);
  const wanted: string[] = [];
  for (const url of urls) {
    if (typeof url === 'string' && url.length > 0 && !wanted.includes(url)) wanted.push(url);
  }
  if (wanted.length === 0) return true;
  // 装载器空闲 ⇒ 上一批必然已经结束，等待集合里剩下的都是脏数据。
  if (!scene.load.isLoading()) state.pending.clear();

  const missing: string[] = [];
  for (const url of wanted) {
    if (scene.textures.exists(url)) { state.pending.delete(url); continue; }
    if (state.failed.has(url)) continue;           // 失败过：按「已就绪」放行，不再重发
    if (state.pending.has(url)) return false;      // 这批还在路上
    missing.push(url);
  }
  if (missing.length === 0) return true;
  if (scene.load.isLoading()) return false;        // 不往正在跑的批次里插队
  for (const url of missing) {
    state.pending.add(url);
    scene.load.image(url, resolveAssetUrl(url));
  }
  scene.load.start();
  return false;
}
