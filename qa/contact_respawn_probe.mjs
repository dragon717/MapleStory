import { evidencePath } from '../scripts/evidence-path.cjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const base = new URL(process.env.SERVER_URL || 'http://127.0.0.1:3010');
if (base.port !== '3010') throw new Error(`Refusing non-QA target ${base.origin}`);
const runId = process.env.QA_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
const evidenceDir = evidencePath(`qa-${runId}`);
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

function wsUrl() {
  const url = new URL('/ws', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url;
}

async function connect(login) {
  const ws = new WebSocket(wsUrl());
  const bot = { ws, login, seq: 0, snapshots: [], messages: [], errors: [] };
  bots.push(bot);
  ws.addEventListener('error', () => bot.errors.push('WebSocket error'));
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    bot.messages.push(message);
    if (message.type === 'snapshot') {
      bot.snapshots.push(message);
      if (bot.snapshots.length > 160) bot.snapshots.shift();
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

function monster(bot, id) {
  return bot.snapshots.at(-1)?.monsters?.find(candidate => candidate.id === id);
}

async function moveNear(bot, id, mode) {
  const end = Date.now() + 9000;
  while (Date.now() < end) {
    const player = bot.self();
    const target = monster(bot, id);
    if (!player || !target || target.hp <= 0) return target;
    const dx = target.x - player.x;
    const distance = Math.abs(dx);
    const min = mode === 'attack' ? 25 : 0;
    const max = mode === 'attack' ? 75 : 24;
    if (distance < min) bot.input(dx >= 0 ? -1 : 1);
    else if (distance > max) bot.input(Math.sign(dx));
    else bot.input(0);
    if (distance >= min && distance <= max) return target;
    await sleep(100);
  }
  throw new Error(`Could not move near monster ${id} for ${mode}`);
}

async function run() {
  const health = await request('/api/health');
  assert.equal(health.response.status, 200);
  assert.deepEqual(health.body, { ok: true, protocolVersion: 3, contentVersion: 'gms83-gameplay-2' });
  check('health and v2 content contract', 'PASS', health.body);

  const suffix = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
  const login = await registerAndLogin(`qa_contact_${suffix}`.slice(0, 32));
  const bot = await connect(login);
  await waitUntil(() => aliveMonsters(bot).length > 0, 'alive monster available after respawn', 16000);
  check('authenticated account sees an alive monster', 'PASS', {
    playerId: login.playerId,
    monsterIds: aliveMonsters(bot).map(candidate => candidate.id),
  });

  const alive = aliveMonsters(bot);
  const player = bot.self();
  const target = [...alive].sort((a, b) => Math.abs(a.x - player.x) - Math.abs(b.x - player.x))[0];
  const initialIds = alive.map(candidate => candidate.id);
  const hpBeforeContact = bot.self().hp;
  const contactStartedAt = Date.now();
  await moveNear(bot, target.id, 'contact');
  await waitUntil(() => bot.self()?.hp < hpBeforeContact, 'authoritative contact damage', 5000);
  const hpAfterContact = bot.self().hp;
  assert.ok(hpAfterContact < hpBeforeContact);
  check('monster contact damage lowers authoritative player HP', 'PASS', {
    monsterId: target.id,
    hpBefore: hpBeforeContact,
    hpAfter: hpAfterContact,
    damage: hpBeforeContact - hpAfterContact,
    elapsedMs: Date.now() - contactStartedAt,
  });

  await sleep(1000);
  assert.equal(bot.self().hp, hpAfterContact);
  check('contact invulnerability prevents immediate repeat damage', 'PASS', { windowObservedMs: 1000, hp: hpAfterContact });

  const reviveAliveRequest = `revive-alive-${suffix}`;
  bot.send({ type: 'revive', requestId: reviveAliveRequest });
  await waitUntil(() => bot.messages.some(message => message.requestId === reviveAliveRequest), 'alive revive rejection');
  const reviveAlive = bot.messages.find(message => message.requestId === reviveAliveRequest);
  assert.equal(reviveAlive.type, 'rejected');
  assert.equal(reviveAlive.code, 'invalid_state');
  check('revive while alive is rejected by authority', 'PASS', { code: reviveAlive.code });

  async function killMonster(id, index) {
    await moveNear(bot, id, 'attack');
    let killed = false;
    for (let attempt = 0; attempt < 20 && !killed; attempt += 1) {
      const requestId = `respawn-attack-${suffix}-${index}-${attempt}`;
      bot.send({ type: 'attack', requestId });
      await sleep(600);
      const current = monster(bot, id);
      killed = !current || current.hp <= 0;
      if (!killed) await moveNear(bot, id, 'attack');
    }
    assert.equal(killed, true, `target ${id} did not die`);
  }

  const deathStartedAt = Date.now();
  for (const [index, id] of initialIds.entries()) await killMonster(id, index);
  await waitUntil(() => initialIds.every(id => !monster(bot, id)), 'all dead monster entities removed after die animation', 5000);
  check('all initial monster entities are removed before respawn', 'PASS', {
    deadIds: initialIds,
    elapsedMs: Date.now() - deathStartedAt,
  });

  const initialIdSet = new Set(initialIds);
  const respawnStartedAt = Date.now();
  await waitUntil(() => {
    const current = aliveMonsters(bot);
    return current.length >= initialIds.length && current.every(candidate => !initialIdSet.has(candidate.id));
  }, 'all killed monsters respawn with new ids', 16000);
  const respawned = aliveMonsters(bot).filter(candidate => !initialIdSet.has(candidate.id));
  assert.ok(respawned.length >= initialIds.length);
  check('all killed monsters respawn with fresh authoritative entity ids', 'PASS', {
    deadIds: initialIds,
    respawnedIds: respawned.map(candidate => candidate.id),
    templateIds: respawned.map(candidate => candidate.templateId),
    elapsedMs: Date.now() - respawnStartedAt,
  });

  check('successful manual revive from dead state', 'BLOCKED', {
    reason: 'Round-2 has no bounded test-only lethal fixture; live contact damage is 1 HP with a 2000 ms invulnerability window, so QA does not spend ~100 seconds manufacturing a death or forge HP.',
  });
  bot.ws.close();
}

let failure;
try {
  await run();
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
  check('contact/respawn probe completed', 'FAIL', { error: failure.message });
} finally {
  for (const bot of bots) if (bot.ws.readyState === WebSocket.OPEN) bot.ws.close();
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(`${evidenceDir}/contact-respawn.json`, `${JSON.stringify({
    runId,
    server: base.origin,
    completed: !failure && !checks.some(item => ['FAIL', 'BLOCKED'].includes(item.status)),
    error: failure?.message || null,
    checks,
    bots: bots.map(bot => ({
      playerId: bot.login.playerId,
      username: bot.login.username,
      errors: bot.errors,
      messages: redact(bot.messages.slice(-80)),
      lastSnapshot: bot.snapshots.at(-1),
    })),
    note: 'Passwords and session tokens omitted; all accounts were created through normal HTTP register/login on the independent 3010 service.',
  }, null, 2)}\n`, 'utf8');
}
if (failure || checks.some(item => ['FAIL', 'BLOCKED'].includes(item.status))) process.exitCode = 1;
