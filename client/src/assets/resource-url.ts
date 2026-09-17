/**
 * 资源 URL 解析（v3 §3.1 / §6.4）。
 *
 * 「逻辑资源标识」与「下载地址」在此一处分流：现在两者相同（内容寻址索引
 * 尚未建立），但缓存修复代数（cacheEpoch）只在用户明确选择「重新下载所需
 * 资源」时改变，并只落在传输 URL 的 `ce=` 参数上——逻辑 key 一律不变，
 * 因此 Phaser 纹理、DOM `<img>`、音频缓存键的既有引用语义全部保持。
 *
 * 边界（v3 §15-5）：普通刷新不带任何时间戳/代数，不给正常请求加 Date.now；
 * 代数为 0 时 resolve 是恒等函数，本模块接入前后的网络请求逐字节相同。
 */

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
 * 逻辑资源 URL → 传输 URL。逻辑 key（= 字符串本身）保持原样，只允许在
 * 代数 > 0 时附加 `ce=` 查询参数；已带查询串的 URL 用 `&` 追加。
 */
export function resolveAssetUrl(url: string): string {
  const epoch = loadEpoch();
  if (epoch <= 0 || !url.startsWith('/assets/')) return url;
  return url.includes('?') ? `${url}&ce=${epoch}` : `${url}?ce=${epoch}`;
}
