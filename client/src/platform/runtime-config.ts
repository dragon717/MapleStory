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

declare const __CODE_MODE__: 'DEV_SOURCE' | 'BUILT_PACKAGE';

export type CodeMode = typeof __CODE_MODE__;

/** 页面身份：源码开发页（5173）或构建产物页（3010）。 */
export const codeMode: CodeMode = __CODE_MODE__;

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
 */
export async function fetchClientRelease(noStore = false): Promise<ClientRelease> {
  const response = await fetch('/api/client-release', { cache: noStore ? 'no-store' : 'default' });
  if (!response.ok) throw new Error(`发布检查失败 (${response.status})`);
  return parseRelease(await response.json());
}
