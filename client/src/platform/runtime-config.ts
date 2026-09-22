/**
 * 运行环境与发布身份（v3 §3 / §4）。
 *
 * 拉取一次「当前发布描述」（/api/client-release，no-store），供首页
 * 客户端操作区显示版本与判断是否有新发布。它不是游戏大清单：
 * 只有发布组合标识与兼容性字段，不含任何玩家数据。
 *
 * 强制更新检查走同一端点，但每次检查都以 `cache: 'no-store'` 重新拉取，
 * 不复用本模块缓存的副本（见 features/client-actions/update-service.ts）。
 */

import { apiBase } from './desktop-config.ts';

declare const __CODE_MODE__: 'DEV_SOURCE' | 'BUILT_PACKAGE';

export type CodeMode = typeof __CODE_MODE__;

/**
 * 页面身份：源码开发页（5173）或构建产物页（3010）。
 *
 * 用 `typeof` 兜一层再取值，而不是直接读裸全局：生产构建由 vite `define` 把它
 * 替换成字面量，但本模块也会被**离线打包器**打进 bundle（例如
 * `features/entry/view.check.mjs` 的 esbuild、以及任何忘了注入 define 的宿主），
 * 那里没有注入 ⇒ 直接读会在模块求值时抛 `ReferenceError`，**整个包连登录界面都
 * 出不来**（2026-09-22 把它接进 entry 依赖链时实测踩到，`entry/view.check.mjs`
 * 由绿转红、且只报「背景图加载失败」这一层症状）。`typeof` 对未声明标识符是安全的，
 * 注入缺失时按**构建产物页**处理——这是宿主约定（离线检查也这么 stub），
 * 而不是让页面白屏。
 */
export const codeMode: CodeMode = typeof __CODE_MODE__ === 'undefined' ? 'BUILT_PACKAGE' : __CODE_MODE__;

export interface ClientRelease {
  releaseId: string;
  protocolVersion: number;
  contentVersion: string;
  createdAt?: string;
  /** 资源清单修订标识；服务器未生成索引时为 null。 */
  assetRevision: string | null;
  /** 桌面客户端发布描述；尚未发布真实安装包时为 null（不伪造下载地址）。 */
  desktop: { version: string; platform: string; url: string }[] | null;
}

/** 校验响应形状：字段缺失或类型不符一律视为检查失败，不用残缺数据更新。 */
function parseRelease(body: unknown): ClientRelease {
  if (typeof body !== 'object' || body === null) throw new Error('发布描述格式无效');
  const record = body as Record<string, unknown>;
  const releaseId = record.releaseId;
  const protocolVersion = record.protocolVersion;
  const contentVersion = record.contentVersion;
  if (typeof releaseId !== 'string' || releaseId.length === 0) throw new Error('发布描述缺少 releaseId');
  if (typeof protocolVersion !== 'number' || !Number.isSafeInteger(protocolVersion)) throw new Error('发布描述缺少 protocolVersion');
  if (typeof contentVersion !== 'string' || contentVersion.length === 0) throw new Error('发布描述缺少 contentVersion');
  const desktop = record.desktop;
  return {
    releaseId,
    protocolVersion,
    contentVersion,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : undefined,
    assetRevision: typeof record.assetRevision === 'string' ? record.assetRevision : null,
    desktop: Array.isArray(desktop) ? desktop as ClientRelease['desktop'] : null,
  };
}

/**
 * 拉取当前发布描述。`noStore` 为 true 时绕过一切缓存副本（强制更新检查）；
 * 默认 false 供启动时显示版本使用。
 *
 * 地址走 `apiBase`（浏览器为空串 ⇒ 输出与写死根相对路径**逐字节相同**）；
 * 桌面包里外壳注入真实服务端来源且**不代理 `/api`**，写死 `/api/...` 会打到外壳
 * 自身来源、永远取不到描述（2026-09-22 随「页面陈旧自愈」一并纠正：自愈要靠这份
 * 描述，桌面包不许在这条路上掉队）。
 */
export async function fetchClientRelease(noStore = false): Promise<ClientRelease> {
  const response = await fetch(`${apiBase}/api/client-release`, { cache: noStore ? 'no-store' : 'default' });
  if (!response.ok) throw new Error(`发布检查失败 (${response.status})`);
  return parseRelease(await response.json());
}
