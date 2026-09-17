#!/usr/bin/env node
// session.check.mjs — Connection 断线重连 / 主动关闭语义（计划 §9.3）。
//
// §9.3 的静态审查怀疑：connect() 先把 stopped 置 false、随后调用的 close()
// 又把它置回 true，之后 scheduleReconnect() 以 stopped 决定是否重试 ⇒
// **自动重连被永久抑制**。本检查用 DOM/WS stub 钉住三条语义：
//   1. 非终端断线后必须安排重试定时器（重连活着）；
//   2. 终端握手码（session_replaced 等）必须停止重试；
//   3. 主动 close() 必须停止重试，挂起的重试回调不得再连接。
// 场景 1 是对既有缺陷的特征断言；修复必须单独进行，不藏在搬移提交里。

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const code = compile(await readFile(new URL('./session.ts', import.meta.url), 'utf8'))
  .replace(/^import .*from '\.\.\/\.\.\/\.\.\/shared\/protocol';$/m,
    "const CONTENT_VERSION = 'cv'; const PROTOCOL_VERSION = 'pv';")
  // protocolText 的桩刻意**不**回填 code：终端判定若又退回去从展示串里反解
  // `(code)`，这里就会失去可解析的形状，场景 2/4 立刻变红。
  .replace(/^import .*from '\.\/endpoints';$/m,
    // 端点收敛后 WS 地址来自 `network/endpoints.ts`；这里给一个同形同义的桩
    // （同源 + 相对路径），不改动 Connection 自身的重连语义。
    "const wsUrl = (path = '/ws') => `ws://stub${path}`;")
  .replace(/^import .*from '\.\.\/app\/i18n';$/m,
    "const uiLocale = () => 'zh'; const protocolText = (code, fallback) => fallback || '已拒绝';");
const { Connection } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

// ---- stubs ----
class FakeWebSocket {
  static OPEN = 1;
  static instances = [];
  readyState = 0;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  closed = false;
  constructor(url) { this.url = url; FakeWebSocket.instances.push(this); }
  send() { /* 记录在案即可 */ }
  close() { if (!this.closed) { this.closed = true; this.readyState = 3; } }
}
globalThis.WebSocket = FakeWebSocket;
globalThis.location = { protocol: 'http:', host: 'test' };
globalThis.document = { hidden: false };

const timers = [];
globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
globalThis.clearTimeout = handle => { if (timers[handle - 1]) timers[handle - 1].cleared = true; };

const statuses = [];
const connection = new Connection(
  { token: 't', protocolVersion: 'pv', contentVersion: 'cv' },
  () => {},
  (status, reason) => statuses.push([status, reason]),
);
const lastSocket = () => FakeWebSocket.instances.at(-1);

// 场景 1：非终端断线 ⇒ 必须安排重试。
timers.length = 0;
connection.connect();
const socket = lastSocket();
socket.onclose({ reason: '' });
const retries = timers.filter(timer => !timer.cleared);
assert.ok(retries.length > 0, '非终端断线后必须安排重试定时器（§9.3 缺陷：connect() 内部调 close() 把 stopped 置回 true，重连被永久抑制）');
const retryTimer = retries.at(-1);
assert.ok(retryTimer.ms >= 500 && retryTimer.ms <= 30_000,
  `重试应有退避延迟（1000ms 基准 × 0.5~1.0 抖动，实际 ${retryTimer.ms}ms）`);

// 场景 2：终端握手码 ⇒ 停止重试。终端判定读取的是握手期 `rejected` 消息
// 捕获的 handshakeFailure（事件 reason 不参与终端判定）。
timers.length = 0;
connection.connect();
const second = lastSocket();
second.onmessage({ data: JSON.stringify({ type: 'rejected', message: 'replaced', code: 'session_replaced' }) });
second.onclose({ reason: '' });
assert.equal(timers.filter(timer => !timer.cleared).length, 0, 'session_replaced 必须停止自动重试');

// 场景 3：主动 close() ⇒ 停止重试；挂起回调不得再连。
timers.length = 0;
connection.connect();
connection.close();
const stillPending = timers.filter(timer => !timer.cleared);
for (const timer of stillPending) timer.fn();
const countAfterClose = FakeWebSocket.instances.length;
// 挂起的重试回调执行后不应新建 socket（stopped 闸门）。
for (const timer of timers) if (!timer.cleared) timer.fn();
assert.equal(FakeWebSocket.instances.length, countAfterClose, '主动关闭后挂起的重试回调不得再连接');

// 场景 4：终端码的可操作文案不得被先前的离线文案吞掉。
// 服务端会话表是进程内的（`auth.rs` 的 `sessions: HashMap`），所以每次重启
// 3010 都会让在线页面握手失败于 `unauthenticated`。此时 `onerror` 先报一次
// 「无法连接服务器，请检查网络。」，紧接着终端分支要报「登录状态已失效，请
// 重新登录。」——`report` 若只按 status 去重，后一句永远显示不出来（2026-09-13
// 重启后玩家实测看到的就是网络错误，不知道该重新登录）。
timers.length = 0;
statuses.length = 0;
connection.connect();
const third = lastSocket();
third.onerror();
third.onmessage({ data: JSON.stringify({ type: 'rejected', message: 'Invalid or expired session', code: 'unauthenticated' }) });
third.onclose({ reason: '' });
assert.equal(statuses.at(-1)[0], 'offline');
assert.equal(
  statuses.at(-1)[1],
  '登录状态已失效，请重新登录。',
  '终端码的可操作提示必须覆盖先前的 offline 文案（report 去重要把 reason 算进去）',
);
assert.equal(timers.filter(timer => !timer.cleared).length, 0, 'unauthenticated 必须停止自动重试');

console.log('network session: reconnect scheduling, terminal codes and active-close semantics passed.');
