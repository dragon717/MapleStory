/**
 * 页面陈旧时的版本自愈（根因修复，2026-09-22）。
 *
 * **病根**：页面的协议/内容版本是**构建期烘进包里的常量**（`shared/protocol.ts`
 * 被 vite 内联进 bundle），服务端的同名常量是**编译期常量**。而一次发布
 * （`启动3010.command` 的 prepare → rotate → serve）是在**已经打开的页面脚下**
 * 把服务端换成新一代的 ⇒ 那个标签页里的常量再也追不上服务端。
 * 原来的处置只有一句「客户端与服务器版本不一致，请刷新页面。」——把
 * 「换一份一致的客户端」这件事**整个推给用户手动按 F5**，而页面自己明明有
 * 全部素材（发布描述 + 发布标识 + 入口地址）可以自动完成。
 *
 * **修法**：不一致时不要只报错，用**既有的**发布描述（`/api/client-release`，
 * `no-store`）与**既有的**入口地址（`entryUrl`，带发布标识）把这一页导航到
 * 服务端当前发布上。不新增机制、不清缓存、不清 Cookie、不动服务端数据
 * （v3 §6.5），也**不放宽兼容性校验**（U04）：这里换掉的是**本页自己**，
 * 不是让服务端给旧客户端降级。
 *
 * **两个触发时刻**（同一份判据、同一组护栏，只是挂点不同）：
 *   1. **进入首页即静默核对**（`features/entry/view` 构造时）——覆盖「这次载入
 *      拿到的就是旧的 HTML/旧包」以及「服务端在本页脚下换了代」这两种一进页面
 *      就已经陈旧的情形，不必等玩家点「登录」才把「请刷新页面」摆到脸上；
 *   2. **点登录拿到版本不一致时**——覆盖「页面开着不动、期间服务端换了代」，
 *      那次登录本身就是最早能发现它的时刻。
 * 与本页同一版时两处都是**空操作**（`describesThisBuild` 一致即返回），
 * 所以正常加载不会多跳一次。
 *
 * **与 `update-service.ts` 的分工**：那个是**用户点**的强制更新——校验服务端
 * 发布的版本与本页是否一致，不一致就停在 `blocked` 让界面说明；本模块方向相反
 * ——**本页旧、服务端新**，目标是让这一页自己收敛到服务端。
 *
 * **防重载环**：记忆载体是**地址里的 `r` 参数**，不是布尔标记，也不再依赖
 * `sessionStorage`（无痕模式下不可用会退化成每次都导航、可能成环）。
 * `entryUrl` 导航后本页 URL 就带上了 `r=<releaseId>`，所以：
 *
 *   1. 只在**描述确实与本页不同**时才导航——描述与本页一致说明不是「页面陈旧」，
 *      交回调用方照旧报错；
 *   2. 取描述失败 ⇒ 不导航（U02 同款：不假成功、不猜测）；
 *   3. 地址里的 `r` **已经等于**这次要去的 `releaseId` ⇒ 说明上一步就是为它导航的，
 *      仍然不一致便老实报错 ⇒ **结构上不可能无限重载**；
 *   4. 下一次发布是**新的** `releaseId` ⇒ 自动重新获得一次自愈机会，
 *      不需要任何人来「清标记」。
 */

import { CONTENT_VERSION, PROTOCOL_VERSION } from '../../../../shared/protocol.ts';
import { fetchClientRelease, type ClientRelease } from '../../platform/runtime-config.ts';
import { entryUrl } from './update-service.ts';

export type HealOutcome =
  /** 已经在导航，本页即将被卸载。 */
  | 'reloaded'
  /** 服务端当前发布与本页同一版 ⇒ 不是「页面陈旧」，不导航。 */
  | 'descriptor-agrees'
  /** 本页地址已经带上了这次要去的发布标识 ⇒ 刚试过，不再试。 */
  | 'already-tried'
  /** 取发布描述失败 ⇒ 不导航。 */
  | 'unavailable';

export interface HealDeps {
  /** 当前页面地址，用于派生入口地址（`lang` 等既有参数会被保留）。 */
  href: string;
  /** 取服务端当前发布描述。 */
  fetchRelease: () => Promise<ClientRelease>;
  /** 导航到新入口。 */
  navigate: (url: string) => void;
}

/** 发布描述描述的**还是不是本页这一版**？ */
export function describesThisBuild(release: ClientRelease): boolean {
  return (
    release.protocolVersion === PROTOCOL_VERSION &&
    release.contentVersion === CONTENT_VERSION
  );
}

/** 本页地址里已经记着的发布标识（`entryUrl` 写入的那一个）。 */
export function triedReleaseId(href: string): string | null {
  try {
    return new URL(href).searchParams.get('r');
  } catch {
    // 地址不可解析：当作「没有记忆」，只影响护栏 3，不影响护栏 1、2。
    return null;
  }
}

export async function healStalePage(deps: HealDeps): Promise<HealOutcome> {
  let release: ClientRelease;
  try {
    release = await deps.fetchRelease();
  } catch {
    return 'unavailable';
  }
  if (describesThisBuild(release)) return 'descriptor-agrees';
  if (triedReleaseId(deps.href) === release.releaseId) return 'already-tried';
  deps.navigate(entryUrl(deps.href, release.releaseId));
  return 'reloaded';
}

/** 浏览器接线：导航用真实跳转，描述走既有的 no-store 拉取。 */
export function browserHealDeps(href: string): HealDeps {
  return {
    href,
    fetchRelease: () => fetchClientRelease(true),
    navigate: url => {
      location.assign(url);
    },
  };
}
