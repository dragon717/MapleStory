// Node 22 built-ins only. These clients never import or mutate server state.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const base = new URL(process.env.SERVER_URL || 'http://127.0.0.1:3000');
const mode = process.argv[2] || 'selftest';
assert(['selftest', 'demo'].includes(mode), 'Usage: node bots/run.mjs selftest|demo');
const clients = [];
async function until(check, label, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (check()) return; await sleep(25); }
  throw new Error('Timeout: ' + label);
}
async function auth(path, credentials, expected) {
  const response = await fetch(new URL(path, base), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials),
  });
  const data = await response.json();
  assert(expected.includes(response.status), `${path}: ${response.status} ${data.error || ''}`);
  return data;
}
async function connect(login) {
  const url = new URL('/ws', base); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url);
  const bot = { ws, login, seq: 0, snapshot: null, events: [], errors: [], send: value => ws.send(JSON.stringify(value)) };
  clients.push(bot);
  ws.addEventListener('error', () => bot.errors.push('WebSocket error'));
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.type === 'snapshot') bot.snapshot = message;
    else bot.events.push(message);
  });
  await until(() => ws.readyState === WebSocket.OPEN || bot.errors.length, 'WebSocket open');
  assert.equal(bot.errors.length, 0);
  bot.send({ type: 'hello', token: login.token, protocolVersion: login.protocolVersion, contentVersion: login.contentVersion });
  await until(() => bot.snapshot || bot.events.some(e => e.type === 'rejected'), 'authenticated map entry');
  assert(bot.snapshot, JSON.stringify(bot.events));
  assert.equal(bot.snapshot.selfId, login.playerId);
  bot.input = (direction, jump = false, vertical = 0) => bot.send({ type: 'input', seq: ++bot.seq, direction, vertical, jump });
  bot.self = () => bot.snapshot.players.find(p => p.id === login.playerId);
  return bot;
}
async function account(username) {
  const credentialsFile = process.env.BOT_CREDENTIALS_FILE;
  if (credentialsFile) {
    try {
      const credentials = JSON.parse(await readFile(credentialsFile, 'utf8'));
      assert(typeof credentials.username === 'string' && typeof credentials.password === 'string', 'Invalid bot credentials file');
      return auth('/api/login', credentials, [200]);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const credentials = { username, password: randomUUID() };
  await auth('/api/register', credentials, [201]);
  const login = await auth('/api/login', credentials, [200]);
  if (credentialsFile) {
    await mkdir(dirname(credentialsFile), { recursive: true, mode: 0o700 });
    await writeFile(credentialsFile, JSON.stringify(credentials) + '\n', { encoding: 'utf8', mode: 0o600 });
    await chmod(credentialsFile, 0o600);
  }
  return login;
}
async function selftest() {
  const run = Date.now().toString(36);
  const a = await connect(await account('check_a_' + run));
  const b = await connect(await account('check_b_' + run));
  const checks = [], trace = [];
  const pass = name => {
    checks.push(name);
    trace.push({ check: name, observedAt: new Date().toISOString(), clients: [a, b].map(bot => ({
      username: bot.login.username, snapshot: bot.snapshot, events: [...bot.events],
    })) });
    console.log('PASS', name);
  };
  await until(() => a.snapshot.players.some(p => p.id === b.login.playerId) && b.snapshot.players.some(p => p.id === a.login.playerId), 'mutual visibility');
  assert.notEqual(a.login.playerId, b.login.playerId); pass('distinct accounts login and mutual visibility');
  await until(() => a.self().grounded && b.self().grounded, 'ground contact');
  const start = { x: a.self().x, y: a.self().y };
  a.input(1, true); b.input(-1);
  await until(() => a.self().x > start.x && a.self().y < start.y && !a.self().grounded, 'authoritative move and jump');
  await until(() => b.snapshot.players.some(p => p.id === a.login.playerId && p.x > start.x && !p.grounded), 'remote jump');
  a.input(0); b.input(0); pass('movement and jump observed remotely');
  for (const bot of [a, b]) bot.send({ type: 'attack', requestId: 'attack-' + run });
  await until(() => [a, b].every(bot => [a, b].every(actor => bot.events.some(e => e.type === 'actionStarted' && e.playerId === actor.login.playerId))), 'both attacks on both clients');
  const event = a.events.find(e => e.type === 'actionStarted' && e.playerId === a.login.playerId);
  pass('both accounts normal attack accepted and broadcast');
  const remoteCount = b.events.filter(e => e.actionId === event.actionId).length;
  a.send({ type: 'attack', requestId: event.requestId });
  await until(() => a.events.filter(e => e.actionId === event.actionId).length === 2, 'duplicate acknowledgement');
  await sleep(150);
  assert.equal(b.events.filter(e => e.actionId === event.actionId).length, remoteCount);
  pass('duplicate request returns original action without remote replay');
  a.send({ type: 'input', seq: ++a.seq, direction: 1, vertical: 0, jump: false, playerId: b.login.playerId, x: 999999 });
  a.send({ type: 'attack', requestId: 'forged', damage: 999999 });
  await until(() => a.events.filter(e => e.code === 'invalid_message').length === 2, 'forged input rejected');
  pass('client position, ownership and damage fields rejected');
  a.input(1);
  await until(() => a.self().vx > 0, 'motion starts');
  await until(() => a.self().vx === 0, 'missing input heartbeat stops movement', 2000);
  pass('missing input heartbeat clears held movement');
  a.ws.close();
  await until(() => !b.snapshot.players.some(p => p.id === a.login.playerId), 'disconnect despawn');
  const reconnected = await connect(a.login);
  reconnected.send({ type: 'attack', requestId: event.requestId });
  await until(() => reconnected.events.some(e => e.actionId === event.actionId), 'dedup after reconnect');
  await sleep(150);
  assert.equal(b.events.filter(e => e.actionId === event.actionId).length, remoteCount);
  pass('disconnect cleans world; reconnect preserves process-lifetime attack dedup');
  const evidence = { completed: true, stage: 'A developer network self-test', date: new Date().toISOString(), server: base.origin,
    accounts: [a.login.username, b.login.username], playerIds: [a.login.playerId, b.login.playerId], mapId: b.snapshot.mapId,
    attack: { actionId: event.actionId, durationMs: event.durationMs }, checks, trace, userAcceptance: 'pending' };
  await mkdir('evidence', { recursive: true });
  await writeFile('evidence/bot-selftest-v2.json', JSON.stringify(evidence, null, 2) + '\n', 'utf8');
}
async function demo() {
  const bot = await connect(await account('demo_bot_' + Date.now().toString(36)));
  console.log(`Programmatic bot ${bot.login.username} connected to ${base.origin}; Ctrl+C stops it.`);
  const center = bot.self().x;
  let direction = 1, lastAttack = 0, lastJump = Date.now(), action = 0;
  let reviveRequest;
  while (bot.ws.readyState === WebSocket.OPEN) {
    const state = bot.self(), now = Date.now();
    if (state.action === 'dead') {
      reviveRequest ||= 'demo-revive-' + (++action);
      bot.send({ type: 'revive', requestId: reviveRequest });
      await sleep(250);
      continue;
    }
    reviveRequest = undefined;
    if (state.x > center + 120) direction = -1;
    if (state.x < center - 120) direction = 1;
    const jump = state.grounded && now - lastJump > 5000;
    if (jump) lastJump = now;
    bot.input(direction, jump);
    if (now - lastAttack > 1800) { bot.send({ type: 'attack', requestId: 'demo-' + (++action) }); lastAttack = now; }
    await sleep(100);
  }
  throw new Error('Demo bot connection closed');
}
const stop = () => { for (const bot of clients) bot.ws.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try { await (mode === 'demo' ? demo() : selftest()); }
finally { for (const bot of clients) bot.ws.close(); }
