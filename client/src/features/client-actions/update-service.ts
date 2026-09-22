/**
 * 强制更新状态机（v3 §6.3）。
 *
 * 空闲 → 检查（重复点击合并）→ 校验发布描述与协议/内容兼容 → 待应用
 *      → Web 导航到经校验的入口 / 桌面另有程序升级 → 完成或给出可重试原因。
 *
 * 硬边界（v3 §6.5）：不清 `localStorage`、不清 Cookie、不动服务端数据；
 * 检查失败**不改当前发布选择、不假装成功**（U02）。兼容性只做**校验**，
 * 不放宽——协议或内容与本页不一致如实报成 `blocked` 并在界面说明（U04）。
 *
 * **U04 的修正（2026-09-22）**：报 `blocked` 是**如实说明**，不是**扣着补救手段**。
 * 描述**就是服务端当前发布**，`entryUrl()` 指向的正是它 ⇒「把这一页换到那份发布上」
 * 在任何版本组合下都是收敛方向；而 `blocked` 恰恰是**最该重载**的情形（页面陈旧、
 * 或服务端在页面脚下换了一代）。此前 `apply()` 要求 `verified` 才导航，等于让
 * 「强制更新」在唯一需要它的场景里失效：用户点它只得到一句「请更新客户端后再登录」，
 * 而按钮自己的提示写着「重新装载页面」（2026-09-22 用户实测正是如此）。
 * 现在：`check()` 照旧如实报 `blocked`（校验没放宽），`apply()` 只要拿到描述就导航。
 *
 * 本模块不碰 DOM：导航与取发布描述均由构造时注入，便于离线定向检查。
 */

import { CONTENT_VERSION, PROTOCOL_VERSION } from '../../../../shared/protocol.ts';
import { fetchClientRelease, type ClientRelease } from '../../platform/runtime-config.ts';
import { bumpCacheEpoch, cacheEpoch } from '../../assets/resource-url.ts';

export type UpdatePhase = 'idle' | 'checking' | 'verified' | 'applying' | 'blocked' | 'failed';

export type UpdateReason =
  | 'none'
  | 'checking'
  | 'verified'
  | 'applying'
  | 'incompatible-protocol'
  | 'incompatible-content'
  | 'network'
  | 'bad-response';

export interface UpdateState {
  phase: UpdatePhase;
  reason: UpdateReason;
  release?: ClientRelease;
}

export type Compatibility = 'compatible' | 'incompatible-protocol' | 'incompatible-content';

/** 版本契约校验：协议与内容版本必须与本页一致，不一致就是阻塞，不降级。 */
export function evaluateCompatibility(release: ClientRelease): Compatibility {
  if (release.protocolVersion !== PROTOCOL_VERSION) return 'incompatible-protocol';
  if (release.contentVersion !== CONTENT_VERSION) return 'incompatible-content';
  return 'compatible';
}

/**
 * 经校验的入口地址：根目录 + 发布标识。
 *
 * 不用 `location.reload(true)`（该参数不是跨浏览器标准能力，v3 §6.3）：
 * 导航到带新 `r` 的入口，HTML 本身是 `no-cache`，新 HTML 指向新的带指纹
 * JS/CSS；`lang` 等既有参数保留。`ce`（资源修复代数）只在执行过修复时带上。
 */
export function entryUrl(baseHref: string, releaseId: string, epoch = 0): string {
  const url = new URL('/', baseHref);
  try {
    const lang = new URL(baseHref).searchParams.get('lang');
    if (lang) url.searchParams.set('lang', lang);
  } catch { /* 地址不可解析时不带附加参数。 */ }
  url.searchParams.set('r', releaseId);
  if (epoch > 0) url.searchParams.set('ce', String(epoch));
  return url.toString();
}

export interface UpdateServiceOptions {
  /** 导航到新入口。Web 传入真实跳转；离线检查传入记录器。 */
  navigate: (url: string) => void;
  /** 取当前发布描述；默认走 runtime-config 的 no-store 拉取。 */
  fetchRelease?: (noStore: boolean) => Promise<ClientRelease>;
  /** 当前页面地址，用于构造入口 URL。 */
  href?: () => string;
}

export class UpdateService {
  private state: UpdateState = { phase: 'idle', reason: 'none' };
  private inFlight?: Promise<UpdateState>;
  private readonly options: UpdateServiceOptions;
  onStateChange?: (state: UpdateState) => void;

  // 不用参数属性（parameter property）：离线检查用 Node 的类型剥离直接装载
  // 本模块，参数属性不可擦除会导致装载失败。
  constructor(options: UpdateServiceOptions) { this.options = options; }

  get current(): UpdateState {
    return { ...this.state };
  }

  /** 是否已有检查在进行：重复点击必须合并，不能并发清理资源（U01）。 */
  get busy(): boolean {
    return this.inFlight !== undefined;
  }

  private set(state: UpdateState): UpdateState {
    this.state = state;
    this.onStateChange?.(this.current);
    return this.current;
  }

  /** 联网检查最新兼容发布。并发调用返回同一个 Promise。 */
  check(): Promise<UpdateState> {
    // 合并：第二次点击复用在途任务，不发起第二次检查，也不重复导航。
    if (this.inFlight) return this.inFlight;
    this.set({ phase: 'checking', reason: 'checking' });
    const task = this.run();
    this.inFlight = task.finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  /**
   * 检查 + 应用。`repair` 为真时同时推进资源修复代数（仅用户明确选择）。
   *
   * **只要拿到了发布描述就导航**（不再要求 `verified` 相位）。理由见文件头
   * 「U04 的修正」：描述就是服务端当前发布，「换到那份发布上」在任何版本组合下
   * 都是收敛方向；`blocked` 更是最该重载的现场。校验没有放宽——`check()` 照旧
   * 把不一致如实报成 `blocked` 并说明，变的只是「报完之后给不给那条路」。
   * 真正没法收敛的只有「取不到描述」（`failed` / `bad-response`）⇒ 不导航。
   */
  async apply(repair = false): Promise<UpdateState> {
    const state = await this.check();
    if (!state.release) return state;
    const href = this.options.href?.() ?? (typeof location === 'object' ? location.href : '/');
    // 修复代数只在用户明确选择「重新下载所需资源」时推进（v3 §6.4）：
    // 普通刷新绝不改变，避免每次刷新都重新下载全部资源。
    const epoch = repair ? bumpCacheEpoch() : cacheEpoch();
    this.set({ phase: 'applying', reason: 'applying', release: state.release });
    this.options.navigate(entryUrl(href, state.release.releaseId, epoch));
    return this.current;
  }

  private async run(): Promise<UpdateState> {
    let release: ClientRelease;
    try {
      release = await (this.options.fetchRelease ?? ((noStore: boolean) => fetchClientRelease(noStore)))(true);
    } catch {
      // 检查失败：不清缓存、不改发布选择、不动用户设置（U02）。
      return this.set({ phase: 'failed', reason: 'network' });
    }
    const compatibility = evaluateCompatibility(release);
    if (compatibility === 'incompatible-protocol') return this.set({ phase: 'blocked', reason: 'incompatible-protocol', release });
    if (compatibility === 'incompatible-content') return this.set({ phase: 'blocked', reason: 'incompatible-content', release });
    return this.set({ phase: 'verified', reason: 'verified', release });
  }
}
