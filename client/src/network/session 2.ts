import { CONTENT_VERSION, PROTOCOL_VERSION, type ClientMessage, type LoginResponse, type ServerMessage } from '../../../shared/protocol';
import { uiLocale } from '../app/i18n';
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
export class Connection {
  private socket?: WebSocket;
  private timeout?: ReturnType<typeof setTimeout>;
  constructor(private session: LoginResponse, private message: (message: ServerMessage) => void, private state: (status: 'connecting' | 'online' | 'offline', reason?: string) => void) {}
  connect() {
    this.close();
    this.state('connecting');
    let handshakeFailure = '';
    let acknowledged = false;
    const socket = this.socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    this.timeout = setTimeout(() => { if (this.socket === socket) { this.state('offline', '连接超时，请重连。'); socket.close(); } }, 10000);
    socket.onopen = () => this.send({ type: 'hello', token: this.session.token, protocolVersion: PROTOCOL_VERSION, contentVersion: CONTENT_VERSION, lang: uiLocale() });
    socket.onmessage = event => {
      if (this.socket !== socket) return;
      try {
        const message = JSON.parse(event.data) as ServerMessage;
        if (message.type === 'snapshot') { acknowledged = true; clearTimeout(this.timeout); this.state('online'); }
        else if (message.type === 'rejected' && !acknowledged) handshakeFailure = `${message.message} (${message.code})`;
        this.message(message);
      } catch { this.state('offline', '服务器消息无法解析，请重连。'); socket.close(); }
    };
    socket.onclose = event => { if (this.socket === socket) { clearTimeout(this.timeout); this.state('offline', event.reason || handshakeFailure || '连接已断开，请重新连接。'); } };
    socket.onerror = () => { if (this.socket === socket) this.state('offline', '无法连接服务器，请检查网络。'); };
  }
  send(message: ClientMessage): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }
  close() { clearTimeout(this.timeout); const socket = this.socket; this.socket = undefined; socket?.close(); }
}
