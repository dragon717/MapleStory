import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const base = new URL(process.env.SERVER_URL || 'http://127.0.0.1:3010');
if (base.port !== '3010') throw new Error(`Refusing non-QA target ${base.origin}`);
const runId = process.env.QA_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
const evidenceDir = `evidence/qa/${runId}`;
const checks = [];
const bots = [];

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, /password|token/i.test(key) ? '[redacted]' : redact(item),
    ]));
  }
  return value;
}

function check(name, status, details = {}) {
  checks.push({ name, status, ...details });
  console.log(`${status} ${name}`);
}

async function waitUntil(predicate, label, timeoutMs = 6000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`Timeout: ${label}`);
}

async function request(path, options = {}) {
  const response = await fetch(new URL(path, base), { ...options, signal: AbortSignal.timeout(15000) });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function registerAndLogin(username) {
  const password = `Qa-${randomUUID()}-x`;
  const registered = await request('/api/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(registered.response.status, 201, JSON.stringify(redact(registered.body)));
  const loggedIn = await request('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(loggedIn.response.status, 200, JSON.stringify(redact(loggedIn.body)));
  return loggedIn.body;
}

async function connect(login) {
  const url = new URL('/ws', base);
  url.protocol = 'ws:';
  const ws = new WebSocket(url);
  const bot = { ws, login, seq: 0, snapshots: [], messages: [], errors: [] };
  bots.push(bot);
  ws.addEventListener('error', () => bot.errors.push('WebSocket error'));
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    bot.messages.push(message);
    if (message.type === 'snapshot') {
      bot.snapshots.push(message);
      if (bot.snapshots.length > 240) bot.snapshots.shift();
    }
  });
  await waitUntil(() => ws.readyState === WebSocket.OPEN || bot.errors.length, 'WebSocket open');
  assert.deepEqual(bot.errors, []);
  ws.send(JSON.stringify({
    type: 'hello', token: login.token, protocolVersion: login.protocolVersion, contentVersion: login.contentVersion,
  }));
  await waitUntil(() => bot.snapshots.length > 0, 'authenticated snapshot');
  bot.send = message => ws.send(JSON.stringify(message));
  bot.input = (direction, vertical = 0, jump = false) => bot.send({ type: 'input', seq: ++bot.seq, direction, vertical, jump });
  bot.self = () => bot.snapshots.at(-1)?.players.find(player => player.id === login.playerId);
  return bot;
}

function aliveMonsters(bot) {
  return bot.snapshots.at(-1)?.monsters?.filter(monster => monster.hp > 0) ?? [];
}

function nearestMonster(bot) {
  const player = bot.self();
  return [...aliveMonsters(bot)].sort((a, b) => Math.abs(a.x - player.x) - Math.abs(b.x - player.x))[0];
}

async function stayInContactUntilDead(bot, timeoutMs) {
  const startedAt = Date.now();
  let lastReportAt = startedAt;
  while (Date.now() - startedAt < timeoutMs) {
    const player = bot.self();
    if (!player) throw new Error('Player disappeared during real contact death test');
    if (player.hp <= 0 || player.action === 'dead') return { startedAt, endedAt: Date.now(), player };
    const target = nearestMonster(bot);
    if (!target) {
      bot.input(0);
    } else {
      const dx = target.x - player.x;
      bot.input(Math.abs(dx) <= 24 ? 0 : Math.sign(dx));
    }
    if (Date.now() - lastReportAt >= 15000) {
      console.log(`PROGRESS contact-death hp=${player.hp} x=${player.x.toFixed(1)}`);
      lastReportAt = Date.now();
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for natural contact death after ${timeoutMs}ms`);
}

async function run() {
  const health = await request('/api/health');
  assert.equal(health.response.status, 200);
  assert.deepEqual(health.body, { ok: true, protocolVersion: 3, contentVersion: 'gms83-gameplay-2' });
  check('health and v2 content contract', 'PASS', health.body);

  const suffix = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
  const login = await registerAndLogin(`qa_revive_${suffix}`.slice(0, 32));
  const bot = await connect(login);
  await waitUntil(() => aliveMonsters(bot).length > 0, 'alive monster available', 16000);
  const initial = bot.self();
  assert.equal(initial.hp, initial.maxHp);
  check('fresh QA account starts at full HP', 'PASS', { playerId: login.playerId, hp: initial.hp, maxHp: initial.maxHp });

  const death = await stayInContactUntilDead(bot, 125000);
  const dead = bot.self();
  assert.ok(dead.hp <= 0);
  assert.equal(dead.action, 'dead');
  check('natural monster contact reaches authoritative dead state', 'PASS', {
    hp: dead.hp,
    action: dead.action,
    elapsedMs: death.endedAt - death.startedAt,
  });

  const deadPosition = { x: dead.x, y: dead.y };
  bot.input(1);
  await sleep(400);
  const deadAfterInput = bot.self();
  assert.equal(deadAfterInput.action, 'dead');
  assert.equal(deadAfterInput.hp, 0);
  assert.equal(deadAfterInput.x, deadPosition.x);
  assert.equal(deadAfterInput.y, deadPosition.y);
  check('dead player ignores movement input', 'PASS', { x: deadAfterInput.x, y: deadAfterInput.y });

  const deadAttackRequest = `dead-attack-${suffix}`;
  bot.send({ type: 'attack', requestId: deadAttackRequest });
  await waitUntil(() => bot.messages.some(message => message.requestId === deadAttackRequest), 'dead attack rejection');
  const deadAttack = bot.messages.find(message => message.requestId === deadAttackRequest);
  assert.equal(deadAttack.type, 'rejected');
  assert.equal(deadAttack.code, 'invalid_state');
  check('dead player attack is rejected by authority', 'PASS', { code: deadAttack.code });

  const visibleDrop = bot.snapshots.at(-1)?.drops?.[0];
  const deadPickupRequest = `dead-pickup-${suffix}`;
  bot.send({ type: 'pickup', requestId: deadPickupRequest, dropId: visibleDrop?.id ?? `missing-${suffix}` });
  await waitUntil(() => bot.messages.some(message => message.requestId === deadPickupRequest), 'dead pickup result');
  const deadPickup = bot.messages.find(message => message.requestId === deadPickupRequest);
  assert.equal(deadPickup.type, 'rejected');
  assert.ok(['drop_unavailable', 'drop_owned', 'out_of_range'].includes(deadPickup.code));
  assert.equal(bot.messages.some(message => message.requestId === deadPickupRequest && message.type === 'pickupResult'), false);
  check('dead player cannot receive a pickup reward', 'PASS', { code: deadPickup.code, dropObserved: Boolean(visibleDrop) });

  const requestId = `revive-e2e-${suffix}`;
  bot.send({ type: 'revive', requestId });
  await waitUntil(() => bot.messages.some(message => message.type === 'reviveResult' && message.requestId === requestId), 'revive result', 5000);
  const revive = bot.messages.find(message => message.type === 'reviveResult' && message.requestId === requestId);
  assert.equal(revive.success, true);
  await waitUntil(() => {
    const player = bot.self();
    return player && player.hp === player.maxHp && player.action !== 'dead';
  }, 'revived full HP snapshot', 3000);
  const revived = bot.self();
  assert.ok(Math.abs(revived.x - 630) <= 1);
  assert.ok(Math.abs(revived.y - 365) <= 1);
  assert.equal(revived.mp, dead.mp);
  check('manual revive restores full HP at authoritative spawn', 'PASS', {
    requestId,
    success: revive.success,
    hp: revived.hp,
    maxHp: revived.maxHp,
    mpPreserved: revived.mp === dead.mp,
    action: revived.action,
    x: revived.x,
    y: revived.y,
  });

  const hpAfterRevive = revived.hp;
  bot.send({ type: 'revive', requestId });
  await waitUntil(() => bot.messages.filter(message => message.type === 'reviveResult' && message.requestId === requestId).length >= 2, 'duplicate revive result', 5000);
  const replay = bot.messages.filter(message => message.type === 'reviveResult' && message.requestId === requestId).at(-1);
  assert.equal(replay.success, false);
  assert.equal(replay.code, 'revive_stale');
  await sleep(250);
  assert.equal(bot.self().hp, hpAfterRevive);
  check('replayed revive request is stale and idempotent', 'PASS', { code: replay.code, hpPreserved: true });

  const secondDeath = await stayInContactUntilDead(bot, 125000);
  const deadAgain = bot.self();
  assert.ok(deadAgain.hp <= 0);
  assert.equal(deadAgain.action, 'dead');
  check('second natural death reaches dead state', 'PASS', {
    hp: deadAgain.hp,
    action: deadAgain.action,
    elapsedMs: secondDeath.endedAt - secondDeath.startedAt,
  });

  const beforeOldReplay = bot.messages.filter(message => message.type === 'reviveResult' && message.requestId === requestId).length;
  bot.send({ type: 'revive', requestId });
  await waitUntil(() => bot.messages.filter(message => message.type === 'reviveResult' && message.requestId === requestId).length > beforeOldReplay, 'old revive request after second death');
  const oldAfterSecondDeath = bot.messages.filter(message => message.type === 'reviveResult' && message.requestId === requestId).at(-1);
  assert.equal(oldAfterSecondDeath.success, false);
  assert.equal(oldAfterSecondDeath.code, 'revive_stale');
  assert.equal(bot.self().action, 'dead');
  check('old revive request cannot revive a later death', 'PASS', { code: oldAfterSecondDeath.code, stillDead: true });

  const secondRequestId = `revive-second-${suffix}`;
  bot.send({ type: 'revive', requestId: secondRequestId });
  await waitUntil(() => bot.messages.some(message => message.type === 'reviveResult' && message.requestId === secondRequestId), 'second revive result', 5000);
  const secondRevive = bot.messages.find(message => message.type === 'reviveResult' && message.requestId === secondRequestId);
  assert.equal(secondRevive.success, true);
  await waitUntil(() => bot.self()?.hp === bot.self()?.maxHp && bot.self()?.action !== 'dead', 'second revived full HP', 3000);
  check('new request revives the later death', 'PASS', { requestId: secondRequestId, hp: bot.self().hp, action: bot.self().action });
  bot.ws.close();
}

let failure;
try {
  await run();
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
  check('revive e2e probe completed', 'FAIL', { error: failure.message });
} finally {
  for (const bot of bots) if (bot.ws.readyState === WebSocket.OPEN) bot.ws.close();
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(`${evidenceDir}/revive-e2e.json`, `${JSON.stringify({
    runId,
    server: base.origin,
    completed: !failure && !checks.some(item => ['FAIL', 'BLOCKED'].includes(item.status)),
    error: failure?.message || null,
    checks,
    bots: bots.map(bot => ({
      playerId: bot.login.playerId,
      username: bot.login.username,
      errors: bot.errors,
      messages: redact(bot.messages.slice(-100)),
      lastSnapshot: bot.snapshots.at(-1),
    })),
    note: 'Passwords and session tokens omitted; natural contact damage only, no direct HP/role/database mutation.',
  }, null, 2)}\n`, 'utf8');
}
if (failure || checks.some(item => ['FAIL', 'BLOCKED'].includes(item.status))) process.exitCode = 1;
