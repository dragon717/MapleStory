/**
 * 桌面客户端下载目录（v3 §10.1）。
 *
 * 只有**服务器如实发布的**安装包才会出现在这里：列表为空、字段缺失或
 * 地址不是 http(s)，一律如实当作「未发布」，绝不补一个占位链接，也不把
 * 源码 ZIP、服务器程序或未签名临时构建标成正式客户端。
 *
 * 本模块是纯函数：不碰 DOM、不发起请求，便于离线定向检查。
 */

export type DesktopPlatform = 'windows' | 'macos' | 'linux' | 'unknown';

export interface DesktopRelease {
  version: string;
  platform: DesktopPlatform;
  url: string;
  arch?: string;
  size?: string;
  sha256?: string;
  publishedAt?: string;
}

const PLATFORMS: readonly DesktopPlatform[] = ['windows', 'macos', 'linux'];

/** 只接受 http(s)：`javascript:`、`data:`、`file:`、协议相对地址一律拒绝（v3 D05）。 */
export function isSafeDownloadUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0) return false;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  return parsed.protocol === 'https:' || parsed.protocol === 'http:';
}

function isPlatform(value: unknown): value is DesktopPlatform {
  return typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value);
}

/**
 * 把发布描述里的 `desktop` 字段收敛成可用的下载列表。
 * 逐条校验，坏条目整条丢弃（不因为一条坏数据就让整个面板不可用），
 * 但**列表为空就是空**，不允许回退成占位链接。
 */
export function normalizeDesktopReleases(value: unknown): DesktopRelease[] {
  if (!Array.isArray(value)) return [];
  const releases: DesktopRelease[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const { version, platform, url } = record;
    if (typeof version !== 'string' || version.length === 0) continue;
    if (!isPlatform(platform)) continue;
    if (!isSafeDownloadUrl(url)) continue;
    releases.push({
      version,
      platform,
      url,
      arch: typeof record.arch === 'string' ? record.arch : undefined,
      size: typeof record.size === 'string' ? record.size : undefined,
      sha256: typeof record.sha256 === 'string' ? record.sha256 : undefined,
      publishedAt: typeof record.publishedAt === 'string' ? record.publishedAt : undefined,
    });
  }
  return releases;
}

/** 按浏览器自述推荐平台；判断不出来就是 `unknown`，由用户手动选（v3 §10.1）。 */
export function detectPlatform(source: string, platformHint = ''): DesktopPlatform {
  const text = `${platformHint} ${source}`.toLowerCase();
  if (text.includes('win')) return 'windows';
  if (text.includes('mac') || text.includes('darwin') || text.includes('iphone') || text.includes('ipad')) return 'macos';
  if (text.includes('linux') || text.includes('x11') || text.includes('android')) return 'linux';
  return 'unknown';
}

/** 取某平台的最新一条（按版本号字符串倒序的稳定选择：列表顺序即发布顺序）。 */
export function releaseFor(list: readonly DesktopRelease[], platform: DesktopPlatform): DesktopRelease | undefined {
  if (platform === 'unknown') return undefined;
  return list.find(release => release.platform === platform);
}
