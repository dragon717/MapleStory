//! 认证 HTTP API（计划 §9.2：R5 从 network/session.ts 机械搬出）。
//!
//! 只包含登录 / 注册请求与协议版本检查；实时连接生命周期（`Connection`）
//! 仍在 `network/session.ts`，由应用装配（`app/main.ts`）持有。
//! 语义与搬移前逐行一致：同一 fetch 形状、同一错误信息、同一版本拒绝。

import { CONTENT_VERSION, PROTOCOL_VERSION, type LoginResponse } from '../../../shared/protocol';

export async function authenticate(username: string, password: string, register: boolean): Promise<LoginResponse> {
  async function post(path: string) {
    const response = await fetch(`/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
    return body;
  }
  if (register) await post('register');
  const session: LoginResponse = await post('login');
  if (session.protocolVersion !== PROTOCOL_VERSION || session.contentVersion !== CONTENT_VERSION) throw new Error('客户端与服务器版本不一致，请刷新页面。');
  return session;
}
