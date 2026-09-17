/**
 * 网络端点集中点（v3 §3）。
 *
 * 浏览器默认同源；开发借 Vite 代理；Tauri 桌面包未来通过这里注入真实
 * 服务器地址（v3 §9.2），业务模块不自行拼主机名。当前三个既有入口
 * （auth-api 的 /api/login、entry/api 的 /api/lobby、session 的 location.host
 * 拼 /ws）全部收敛到这里，语义逐字保留。
 */

export function apiUrl(path: string): string {
  if (!path.startsWith('/api/')) throw new Error(`非法 API 路径：${path}`);
  return path;
}

/** WebSocket 端点：沿用 location.host 与 http/https → ws/wss 的既有推导。 */
export function wsUrl(path = '/ws'): string {
  if (!path.startsWith('/ws')) throw new Error(`非法 WS 路径：${path}`);
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${path}`;
}
