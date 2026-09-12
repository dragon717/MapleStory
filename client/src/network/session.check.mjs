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
  .replace(/^import .*from '\.\.\/app\/i18n';$/m, "const uiLocale = () => 'zh';");
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

console.log('network session: reconnect scheduling, terminal codes and active-close semantics passed.');
