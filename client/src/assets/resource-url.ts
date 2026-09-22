/**
 * 资源 URL 解析（v3 §3.1 / §4.1 / §6.4）。
 *
 * 「逻辑资源标识」与「下载地址」在此一处分流，分两步：
 *
 *   1. **内容寻址**：逻辑地址（`/assets/tms273/...`，装配管线可原地改写）查
 *      `asset-index` 的映射表，换成 `/assets/objects/sha256/<摘要>.png`。后者
 *      地址由字节决定，服务端才敢给 `immutable` **强缓存**——刷新时浏览器直接
 *      用本地副本、一个字节都不联网。没有映射表（对象库未建立/网络失败）就退回
 *      逻辑地址照常联网，资源仍可取到。
 *   2. **修复代数**：只有用户明确选择「重新下载所需资源」时 `ce=` 才出现，用来
 *      绕过浏览器已有的同地址副本。逻辑 key 一律不变，Phaser 纹理、DOM `<img>`、
 *      音频缓存键的既有引用语义全部保持。
 *
 * 边界（v3 §15-5）：普通刷新不带任何时间戳/代数，不给正常请求加 Date.now；
 * 代数为 0 且映射表缺失时 resolve 是恒等函数。
 */

// 显式 `.ts` 后缀：本模块被 `update-service.check.ts` / `layer-animation.check.ts`
// 这类**直接由 Node 装载**（`--experimental-strip-types`）的检查引用，而 Node 的 ESM
// 解析器不给相对导入补后缀 ⇒ 少了后缀整条链装载失败、检查等于没人跑（2026-09-22 修）。
import { assetObjectUrl } from './asset-index.ts';
import { assetBase } from '../platform/desktop-config.ts';

const EPOCH_STORAGE_KEY = 'maple-cache-epoch';
/** 非敏感恢复标记：偏好存储不可用时（无痕/被禁），代数也能跨刷新传递（v3 §6.4）。 */
const EPOCH_URL_PARAM = 'ce';

let memoryEpoch = 0;
let loaded = false;

/** 从 URL 读代数；没有 window（离线检查）或参数非法时返回 0。 */
function urlEpoch(): number {
  try {
    const value = new URLSearchParams(window.location.search).get(EPOCH_URL_PARAM);
    if (value === null) return 0;
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
  } catch { return 0; }
}

function loadEpoch(): number {
  if (loaded) return memoryEpoch;
  loaded = true;
  let stored = 0;
  try {
    const raw = localStorage.getItem(EPOCH_STORAGE_KEY);
    const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) stored = parsed;
  } catch { /* 存储不可用（无痕/被禁）时退回本页内存代数，修复仍可用。 */ }
  // 取两者较大值：URL 能在存储写失败时保住一次修复，存储能让后续刷新不必带参数。
  memoryEpoch = Math.max(stored, urlEpoch());
  return memoryEpoch;
}

/** 当前缓存修复代数；0 表示从未执行过修复。 */
export function cacheEpoch(): number {
  return loadEpoch();
}

/** 用户在更新对话框里明确选择「重新下载所需资源」时调用；普通刷新绝不调用。 */
export function bumpCacheEpoch(): number {
  memoryEpoch = loadEpoch() + 1;
  try { localStorage.setItem(EPOCH_STORAGE_KEY, String(memoryEpoch)); } catch { /* 内存代数继续生效。 */ }
  return memoryEpoch;
}

/**
 * 逻辑资源 URL → 传输 URL。
 *
 * 三步，顺序不能换：
 *   ① 换成内容寻址地址（有映射时）；
 *   ② 按修复代数附加 `ce=`（只在明确修复后）；
 *   ③ 最后才加桌面 `assetBase` 前缀——**只加在 `/assets/**` 上**，前端自己的
 *      JS/CSS 在桌面包本地，不能被一起搬到远端（v3 §9.2）。
 *
 * 逻辑 key（= 字符串本身，由调用方保留）始终不变。
 */
export function resolveAssetUrl(url: string): string {
  const epoch = loadEpoch();
  const resolved = assetObjectUrl(url) ?? url;
  // 非游戏内容（`/api/**`、外部地址、页面自身资源）不归本函数管。
  if (!resolved.startsWith('/assets/')) return resolved;
  const withEpoch = epoch > 0
    ? (resolved.includes('?') ? `${resolved}&ce=${epoch}` : `${resolved}?ce=${epoch}`)
    : resolved;
  return assetBase === '' ? withEpoch : `${assetBase}${withEpoch}`;
}
