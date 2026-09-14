import { CONTENT_VERSION, PROTOCOL_VERSION, type ClientMessage, type LoginResponse, type ServerMessage } from '../../../shared/protocol';
import { protocolText, uiLocale } from '../app/i18n';
// authenticate（认证 HTTP）已迁到 ./auth-api（计划 §9.2）；本文件只保留实时连接。
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
  private lastReason?: string;
  private retry?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private stopped = false;
  constructor(private session: LoginResponse, private message: (message: ServerMessage) => void, private state: (status: 'connecting' | 'online' | 'offline', reason?: string) => void) {}
  /** The server pushes a snapshot every world tick (~50 ms), so `onmessage`
   *  sees one constantly. Only report a status change when the connection
   *  state actually changes; otherwise every snapshot re-runs the app's
   *  "online" handler, which returns focus to the game viewport and yanks the
   *  caret out of the chat input right after Enter.
   *
   *  The reason participates in the dedupe: a rejected handshake reports
   *  `offline` a second time with the actionable text, and dropping that would
   *  leave the player staring at "无法连接服务器，请检查网络。" when the real
   *  answer is "登录状态已失效，请重新登录。" — exactly what a server restart
   *  (in-memory session table) produces. */
  private report(status: 'connecting' | 'online' | 'offline', reason?: string) {
    if (this.lastState === status && this.lastReason === reason) return;
    this.lastState = status;
    this.lastReason = reason;
    this.state(status, reason);
  }
  connect() {
    this.stopped = false;
    this.closeSocket();
    this.report('connecting');
    let handshakeFailure = '';
    let handshakeCode = '';
    let acknowledged = false;
    const socket = this.socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    this.timeout = setTimeout(() => { if (this.socket === socket) { this.report('offline', '连接超时，请重连。'); socket.close(); } }, 10000);
    socket.onopen = () => this.send({ type: 'hello', token: this.session.token, protocolVersion: PROTOCOL_VERSION, contentVersion: CONTENT_VERSION, lang: uiLocale() });
    socket.onmessage = event => {
      if (this.socket !== socket) return;
      try {
        const message = JSON.parse(event.data) as ServerMessage;
        if (message.type === 'snapshot') { acknowledged = true; clearTimeout(this.timeout); this.attempt = 0; this.report('online'); }
        // The localized line comes first; the raw code stays in the console so
        // a handshake failure is still diagnosable without showing it to the
        // player on the connection screen.
        else if (message.type === 'rejected' && !acknowledged) {
          handshakeCode = message.code;
          handshakeFailure = protocolText(message.code, message.message);
          console.debug('[protocol] 握手被拒', message.code, message.message);
        }
        this.message(message);
      } catch { this.report('offline', '服务器消息无法解析，请重连。'); socket.close(); }
    };
    socket.onclose = event => {
      if (this.socket !== socket) return;
      clearTimeout(this.timeout);
      this.report('offline', event.reason || handshakeFailure || '连接已断开，正在尝试恢复…');
      this.scheduleReconnect(handshakeCode);
    };
    socket.onerror = () => { if (this.socket === socket) this.report('offline', '无法连接服务器，请检查网络。'); };
  }
  /** Exponential backoff with jitter.  Hidden pages wait longer because a
   *  background tab is typically frozen and would only burn timers.
   *
   *  The terminal code arrives as its own field, never re-parsed out of the
   *  player-facing sentence: the display text is localized, so any `(code)`
   *  shape it used to carry is not part of the contract. */
  private scheduleReconnect(handshakeCode = '') {
    if (this.stopped) return;
    if (handshakeCode && TERMINAL_CODES.has(handshakeCode)) {
      this.stopped = true;
      this.report('offline', handshakeCode === 'session_replaced' ? '该角色已在其他页面或设备恢复。' : '登录状态已失效，请重新登录。');
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
  /** Tears down the live socket and pending timers **without** touching the
   *  retry gate.  `connect()` reuses this to swap sockets; the public
   *  `close()` is the explicit teardown that additionally stops reconnecting.
   *  (§9.3: the previous shape called `close()` from `connect()`, which left
   *  `stopped = true` after every connect and silently disabled the
   *  reconnect loop — pinned by session.check.mjs scenario 1.) */
  private closeSocket() { clearTimeout(this.timeout); clearTimeout(this.retry); const socket = this.socket; this.socket = undefined; socket?.close(); }
  close() { this.stopped = true; this.closeSocket(); }
}
