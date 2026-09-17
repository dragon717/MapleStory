/**
 * 桌面环境配置（v3 §9.2）。
 *
 * 浏览器里不存在任何覆盖：`apiBase` 与 `assetBase` 都是空串，`apiUrl` /
 * `resolveAssetUrl` 的输出与接入前**逐字节相同**。桌面包由外壳在加载本地前端
 * 之前注入 `window.__MAPLE_DESKTOP__`，业务代码不需要知道自己跑在哪个壳里
 * （v3 §15-3：环境适配只改地址来源，不改业务）。
 *
 * 为什么资源不能一刀切：桌面包把**应用代码**打包在本地（`tauri://` 来源），
 * 而 `public-tms273` 的 843MB 美术音频不进包——它们仍从远端内容服务按修订取。
 * 所以只能给 `/assets/**` 加 `assetBase`，不能把前端自己的 JS/CSS 一起搬走。
 *
 * 校验（v3 §9.4 / §D05）：只接受 `http(s)://` 的绝对地址；其它值（含相对路径、
 * 带空白的脏值）一律忽略并退回空串，宁可让资源指向本机也不把地址指向任意来源。
 */

/** 外壳注入的配置形状。字段全部可选：缺失即「与浏览器一致」。 */
export interface DesktopConfig {
  /** 权威世界（Rust 3010）的绝对来源，用于 /api 与 /ws。 */
  apiBase?: unknown;
  /** 游戏静态内容的绝对来源，只作用于 `/assets/**`。 */
  assetBase?: unknown;
}

function injected(): DesktopConfig {
  try {
    return (window as Window & { __MAPLE_DESKTOP__?: DesktopConfig }).__MAPLE_DESKTOP__ ?? {};
  } catch {
    // 离线检查（node）没有 window：等同于浏览器默认。
    return {};
  }
}

/** 只接受 http(s) 绝对来源，去掉尾斜杠；其余一律视为「没有覆盖」。 */
function normalizeBase(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/i.test(trimmed)) return '';
  return trimmed;
}

const config = injected();

/** 权威世界来源；空串＝同源（浏览器默认行为）。 */
export const apiBase = normalizeBase(config.apiBase);
/** 游戏内容来源；空串＝同源。 */
export const assetBase = normalizeBase(config.assetBase);
