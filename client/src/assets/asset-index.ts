/**
 * 内容寻址资源索引（v3 §4.1 / §3.1）。
 *
 * 交付两段式，缺一不可：
 *   ① `<resources>/objects/current.json` —— 固定名的**发布指针**，可被后续发布改写，
 *      因此服务端只给它 `no-cache`（用前重新验证，文件很小，代价是几百字节）。
 *   ② 指针指向的 `objects/index/<revision>.json` —— 由自身摘要命名，服务端给
 *      `immutable`，浏览器**直接用本地副本、不联网**。它是本地「逻辑 URL → 内容
 *      寻址地址」映射表，本模块把它读进内存，交给 `resource-url.ts`。
 *
 * 为什么不把 28k 个地址写死在代码里：地址必须与服务器上真实存在的对象一致，
 * 而对象库是构建产物。指针 + 索引让「一批资源」始终以一个 revision 整体切换
 * （v3 §C08：不出现新 manifest 配旧 appearance）。
 *
 * 降级（v3 §5.3）：指针缺失、索引缺失、网络失败、存储被禁——一律**不抛错**，
 * 退回「没有映射表」＝`resolveAssetUrl` 恒等，资源照常按逻辑地址联网获取。
 * 强缓存是「少下载」的手段，不是资源能否获取的前提。
 */

/** 发布指针的固定地址；只有它是可变的，其余地址都由内容摘要决定。 */
export const ASSET_POINTER_URL = '/assets/objects/current.json';
/** 索引地址的固定前缀；完整地址必须是 `<前缀><revision>.json`。 */
const INDEX_PREFIX = '/assets/objects/index/';
const REVISION_PATTERN = /^[0-9a-f]{16,}$/;

/** 逻辑 URL → 内容寻址 URL。没有索引时为空表。 */
let mapping: Map<string, string> | null = null;
let revision: string | null = null;
let failure: string | null = null;
let pending: Promise<void> | null = null;

/** 已发布的资源修订；未取到索引时为 null（不猜、不用构建时间冒充）。 */
export function currentAssetRevision(): string | null {
  return revision;
}

/** 上一次降级原因；成功时为 null。用于诊断「强缓存为什么没生效」。 */
export function assetIndexFailure(): string | null {
  return failure;
}

/**
 * 逻辑 URL 对应的内容寻址地址；没有映射时返回 null。
 *
 * 返回 null 与返回原地址是**不同**语义：前者表示「这次没进强缓存」，调用方
 * 必须退回逻辑地址联网获取，而不是把一个不存在的对象地址发出去。
 */
export function assetObjectUrl(logicalUrl: string): string | null {
  if (mapping === null) return null;
  return mapping.get(logicalUrl) ?? null;
}

/** 供离线检查重置模块状态；运行时不调用。 */
export function resetAssetIndexForTest(): void {
  mapping = null;
  revision = null;
  failure = null;
  pending = null;
}

/**
 * 读取索引。幂等：同一页面内只真正拉取一次，并发调用共享同一个 Promise。
 *
 * 解析出的映射表**整表替换**而不是增量合并，避免两个不同 revision 的条目混在
 * 一起（那正是 §C08 要挡的情况）。
 */
export function loadAssetIndex(): Promise<void> {
  if (pending !== null) return pending;
  pending = (async () => {
    try {
      const pointerResponse = await fetch(ASSET_POINTER_URL, { cache: 'no-cache' });
      if (!pointerResponse.ok) {
        // 对象库尚未建立是**正常**状态（脚本没跑过），不是错误。
        failure = `指针不可用 (${pointerResponse.status})`;
        return;
      }
      const pointer = await pointerResponse.json() as { revision?: unknown; index?: unknown };
      const pointerRevision = pointer.revision;
      const indexUrl = pointer.index;
      if (typeof pointerRevision !== 'string' || !REVISION_PATTERN.test(pointerRevision)) {
        failure = '指针缺少合法 revision';
        return;
      }
      // 索引地址必须由 revision 自身命名，与服务端 AssetIndex::load 的同名断言
      // 成对：任一侧放宽，另一侧的读方就会拿到拼不出索引的修订号。
      if (indexUrl !== `${INDEX_PREFIX}${pointerRevision}.json`) {
        failure = '索引地址与 revision 不一致';
        return;
      }
      const indexResponse = await fetch(indexUrl);
      if (!indexResponse.ok) {
        failure = `索引不可用 (${indexResponse.status})`;
        return;
      }
      const index = await indexResponse.json() as { objects?: unknown };
      const objects = index.objects;
      if (typeof objects !== 'object' || objects === null) {
        failure = '索引缺少 objects 映射';
        return;
      }
      const next = new Map<string, string>();
      for (const [logical, object] of Object.entries(objects as Record<string, unknown>)) {
        if (typeof object === 'string') next.set(logical, object);
      }
      mapping = next;
      revision = pointerRevision;
      failure = null;
    } catch (error) {
      // 网络失败/存储被禁/JSON 坏：不抛，退回恒等解析（v3 §5.3）。
      failure = error instanceof Error ? error.message : String(error);
    }
  })();
  return pending;
}
