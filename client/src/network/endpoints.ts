/**
 * 网络端点集中点（v3 §3）。
 *
 * 浏览器默认同源；开发借 Vite 代理；桌面包由外壳注入 `window.__MAPLE_DESKTOP__`
 * 的 `apiBase` 指向真实服务器（v3 §9.2），业务模块不自行拼主机名。`apiBase`
 * 为空串时两个函数的输出与接入前**逐字节相同**。
 */

import { apiBase } from '../platform/desktop-config';

export function apiUrl(path: string): string {
  if (!path.startsWith('/api/')) throw new Error(`非法 API 路径：${path}`);
  return `${apiBase}${path}`;
}

/**
 * WebSocket 端点：同源时沿用 location.host 与 http/https → ws/wss 的既有推导；
 * 有 `apiBase` 时从它推导（http→ws、https→wss），不再依赖页面来源。
 */
export function wsUrl(path = '/ws'): string {
  if (!path.startsWith('/ws')) throw new Error(`非法 WS 路径：${path}`);
  if (apiBase !== '') {
    const scheme = apiBase.startsWith('https://') ? 'wss:' : 'ws:';
    return `${scheme}//${apiBase.replace(/^https?:\/\//, '')}${path}`;
  }
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${path}`;
}
