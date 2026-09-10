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
/** Terminal results must stop the retry loop, otherwise two pages or a banned
 *  session would fight forever over the same character. */
const TERMINAL_CODES = new Set([
  'unauthenticated',
  'invalid_hello',
  'session_replaced',
  'banned',
  'character_missing',
]);

export class Connection {
  private socket?: WebSocket;
  private timeout?: ReturnType<typeof setTimeout>;
  private lastState?: 'connecting' | 'online' | 'offline';
  private retry?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private stopped = false;
  constructor(private session: LoginResponse, private message: (message: ServerMessage) => void, private state: (status: 'connecting' | 'online' | 'offline', reason?: string) => void) {}
  /** The server pushes a snapshot every world tick (~50 ms), so `onmessage`
   *  sees one constantly. Only report a status change when the connection
   *  state actually changes; otherwise every snapshot re-runs the app's
   *  "online" handler, which returns focus to the game viewport and yanks the
   *  caret out of the chat input right after Enter. */
  private report(status: 'connecting' | 'online' | 'offline', reason?: string) {
    if (this.lastState === status) return;
    this.lastState = status;
    this.state(status, reason);
  }
  connect() {
    this.stopped = false;
    this.close();
    this.report('connecting');
    let handshakeFailure = '';
    let acknowledged = false;
    const socket = this.socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    this.timeout = setTimeout(() => { if (this.socket === socket) { this.report('offline', '连接超时，请重连。'); socket.close(); } }, 10000);
    socket.onopen = () => this.send({ type: 'hello', token: this.session.token, protocolVersion: PROTOCOL_VERSION, contentVersion: CONTENT_VERSION, lang: uiLocale() });
    socket.onmessage = event => {
      if (this.socket !== socket) return;
      try {
        const message = JSON.parse(event.data) as ServerMessage;
        if (message.type === 'snapshot') { acknowledged = true; clearTimeout(this.timeout); this.attempt = 0; this.report('online'); }
        else if (message.type === 'rejected' && !acknowledged) handshakeFailure = `${message.message} (${message.code})`;
        this.message(message);
      } catch { this.report('offline', '服务器消息无法解析，请重连。'); socket.close(); }
    };
    socket.onclose = event => {
      if (this.socket !== socket) return;
      clearTimeout(this.timeout);
      this.report('offline', event.reason || handshakeFailure || '连接已断开，正在尝试恢复…');
      this.scheduleReconnect(handshakeFailure);
    };
    socket.onerror = () => { if (this.socket === socket) this.report('offline', '无法连接服务器，请检查网络。'); };
  }
  /** Exponential backoff with jitter.  Hidden pages wait longer because a
   *  background tab is typically frozen and would only burn timers. */
  private scheduleReconnect(handshakeFailure = '') {
    if (this.stopped) return;
    const code = handshakeFailure.match(/\(([a-z_]+)\)\s*$/)?.[1];
    if (code && TERMINAL_CODES.has(code)) {
      this.stopped = true;
      this.report('offline', code === 'session_replaced' ? '该角色已在其他页面或设备恢复。' : '登录状态已失效，请重新登录。');
      return;
    }
    const base = document.hidden ? 8000 : 1000;
    const delay = Math.min(base * 2 ** Math.min(this.attempt, 5), 30_000);
    this.attempt += 1;
    const jitter = delay * (0.5 + Math.random() * 0.5);
    clearTimeout(this.retry);
    this.retry = setTimeout(() => { if (!this.stopped) this.connect(); }, jitter);
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
  close() { clearTimeout(this.timeout); clearTimeout(this.retry); this.stopped = true; const socket = this.socket; this.socket = undefined; socket?.close(); }
}
