import { evidencePath } from '../scripts/evidence-path.cjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const base = new URL(process.env.SERVER_URL || 'http://127.0.0.1:3010');
if (base.port !== '3010') {
  throw new Error(`Refusing non-QA target ${base.origin}; this probe only allows port 3010`);
}
const runId = process.env.QA_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
const evidenceDir = evidencePath(`qa-${runId}`);
const checks = [];
const bots = [];

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      /password|token/i.test(key) ? '[redacted]' : redact(item),
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

async function jsonRequest(path, options = {}) {
  const response = await fetch(new URL(path, base), { ...options, signal: AbortSignal.timeout(15000) });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function registerAndLogin(username) {
  const password = `Qa-${randomUUID()}-x`;
  const registered = await jsonRequest('/api/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(registered.response.status, 201, JSON.stringify(redact(registered.body)));
  const loggedIn = await jsonRequest('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(loggedIn.response.status, 200, JSON.stringify(redact(loggedIn.body)));
  assert.equal(typeof loggedIn.body.token, 'string');
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
      if (bot.snapshots.length > 80) bot.snapshots.shift();
    }
  });
  await waitUntil(() => ws.readyState === WebSocket.OPEN || bot.errors.length, 'WebSocket open');
  assert.deepEqual(bot.errors, []);
  ws.send(JSON.stringify({
    type: 'hello', token: login.token, protocolVersion: login.protocolVersion, contentVersion: login.contentVersion,
  }));
  await waitUntil(() => bot.snapshots.length > 0 || bot.messages.some(message => message.type === 'rejected'), 'authenticated snapshot');
  assert.ok(bot.snapshots.length, JSON.stringify(redact(bot.messages)));
  assert.equal(bot.snapshots.at(-1).selfId, login.playerId);
  bot.send = message => ws.send(JSON.stringify(message));
  bot.input = (direction, vertical = 0, jump = false) => bot.send({ type: 'input', seq: ++bot.seq, direction, vertical, jump });
  bot.self = () => bot.snapshots.at(-1)?.players.find(player => player.id === login.playerId);
  return bot;
}

function latestMonster(bot, id) {
  return bot.snapshots.at(-1)?.monsters?.find(monster => monster.id === id);
}

function latestDrop(bot, id) {
  return bot.snapshots.at(-1)?.drops?.find(drop => drop.id === id);
}

function profileOf(bot) {
  const player = bot.self();
  return player && {
    hp: player.hp,
    maxHp: player.maxHp,
    mp: player.mp,
    maxMp: player.maxMp,
    level: player.level,
    exp: player.exp,
    expToNext: player.expToNext,
    mesos: player.mesos,
    inventory: player.inventory,
  };
}

function inventoryQuantity(profile, itemId) {
  return itemId === '0'
    ? profile.mesos
    : profile.inventory.find(item => item.itemId === itemId)?.quantity ?? 0;
}

async function run() {
  const suffix = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
  const usernameA = `qa_net_a_${suffix}`.slice(0, 32);
  const usernameB = `qa_net_b_${suffix}`.slice(0, 32);
  const health = await jsonRequest('/api/health');
  assert.equal(health.response.status, 200);
  assert.deepEqual(health.body, { ok: true, protocolVersion: 3, contentVersion: 'gms83-gameplay-2' });
  check('health and v2 content contract', 'PASS', { health: health.body });

  const loginA = await registerAndLogin(usernameA);
  const loginB = await registerAndLogin(usernameB);
  const a = await connect(loginA);
  const b = await connect(loginB);
  await waitUntil(() => a.self() && b.self() && a.snapshots.at(-1).players.some(player => player.id === loginB.playerId), 'mutual visibility');
  check('two real accounts enter one authoritative world', 'PASS', {
    playerIds: [loginA.playerId, loginB.playerId],
    mapId: a.snapshots.at(-1).mapId,
  });

  const beforeSeq = a.self().lastInputSeq;
  a.send({ type: 'input', seq: beforeSeq + 1, direction: 0, vertical: 0, jump: false, playerId: loginB.playerId, x: 999999 });
  a.send({ type: 'attack', requestId: `forged-${suffix}`, damage: 999999 });
  await waitUntil(() => a.messages.filter(message => message.type === 'rejected' && message.code === 'invalid_message').length >= 2, 'forged fields rejected');
  check('forged ownership/position/damage fields rejected', 'PASS');

  a.input(1);
  await waitUntil(() => a.self().lastInputSeq > beforeSeq, 'fresh input accepted');
  const acceptedSeq = a.self().lastInputSeq;
  a.send({ type: 'input', seq: acceptedSeq - 1, direction: -1, vertical: 0, jump: false });
  await sleep(150);
  assert.equal(a.self().lastInputSeq, acceptedSeq);
  a.input(0);
  check('stale input sequence ignored', 'PASS', { acceptedSeq });

  let target = a.snapshots.at(-1).monsters?.find(monster => monster.hp > 0);
  if (!target) {
    check('monster snapshot available', 'FAIL', { reason: 'No live monster in snapshot' });
    throw new Error('No live monster in snapshot');
  }
  check('monster snapshot includes source-backed state', 'PASS', { templateId: target.templateId, monsterId: target.id });

  async function approach(bot, monsterId) {
    const end = Date.now() + 12000;
    while (Date.now() < end) {
      const player = bot.self();
      const monster = latestMonster(bot, monsterId) || latestMonster(a, monsterId);
      if (!player || !monster || monster.hp <= 0) return;
      const dx = monster.x - player.x;
      const direction = Math.abs(dx) <= 52 ? 0 : Math.sign(dx);
      bot.input(direction);
      if (Math.abs(dx) <= 52 && Math.abs(monster.y - player.y) <= 42) return;
      await sleep(100);
    }
    throw new Error(`Could not approach monster ${monsterId}`);
  }
  await Promise.all([approach(a, target.id), approach(b, target.id)]);
  a.input(0); b.input(0);
  await waitUntil(() => {
    const pa = a.self(); const pb = b.self(); const mob = latestMonster(a, target.id);
    return pa && pb && mob && Math.abs(pa.x - mob.x) <= 70 && Math.abs(pb.x - mob.x) <= 70;
  }, 'both players in attack range', 3000);

  const initialProfiles = { a: profileOf(a), b: profileOf(b) };
  const dropIdsBeforeKill = new Set((a.snapshots.at(-1).drops ?? []).map(drop => drop.id));
  const initialHp = latestMonster(a, target.id)?.hp ?? 0;
  const requestA = `hit-a-${suffix}`;
  const requestB = `hit-b-${suffix}`;
  a.send({ type: 'attack', requestId: requestA });
  b.send({ type: 'attack', requestId: requestB });
  await waitUntil(() => a.messages.some(message => message.type === 'actionStarted' && message.requestId === requestA)
    && b.messages.some(message => message.type === 'actionStarted' && message.requestId === requestB), 'dual attack accepted');
  await waitUntil(() => {
    const mob = latestMonster(a, target.id);
    return !mob || mob.hp < initialHp;
  }, 'authoritative monster damage', 4000);
  check('two accounts attack one monster with server-owned damage', 'PASS', { beforeHp: initialHp, afterHp: latestMonster(a, target.id)?.hp ?? 0 });

  const duplicateRequest = `duplicate-${suffix}`;
  await waitUntil(() => a.self()?.action !== 'attack', 'attack cooldown ends', 2500);
  a.send({ type: 'attack', requestId: duplicateRequest });
  await waitUntil(() => a.messages.some(message => message.type === 'actionStarted' && message.requestId === duplicateRequest)
    && b.messages.some(message => message.type === 'actionStarted' && message.requestId === duplicateRequest), 'duplicate source action');
  await waitUntil(() => a.self()?.action !== 'attack', 'duplicate action resolves', 2500);
  await sleep(100);
  const beforeDuplicateEvents = a.messages.filter(message => message.type === 'actionStarted' && message.requestId === duplicateRequest).length;
  const remoteBeforeDuplicate = b.messages.filter(message => message.type === 'actionStarted' && message.requestId === duplicateRequest).length;
  const beforeDuplicateProfile = profileOf(a);
  const beforeDuplicateMonster = latestMonster(a, target.id) && { ...latestMonster(a, target.id) };
  const beforeDuplicateDrops = a.snapshots.at(-1).drops;
  a.send({ type: 'attack', requestId: duplicateRequest });
  await sleep(250);
  const afterDuplicateEvents = a.messages.filter(message => message.type === 'actionStarted' && message.requestId === duplicateRequest).length;
  const remoteAfterDuplicate = b.messages.filter(message => message.type === 'actionStarted' && message.requestId === duplicateRequest).length;
  assert.equal(afterDuplicateEvents, beforeDuplicateEvents + 1);
  assert.equal(remoteAfterDuplicate, remoteBeforeDuplicate);
  assert.deepEqual(profileOf(a), beforeDuplicateProfile);
  const afterDuplicateMonster = latestMonster(a, target.id);
  if (beforeDuplicateMonster?.hp === 0) {
    assert.ok(!afterDuplicateMonster || afterDuplicateMonster.hp === 0);
  } else {
    assert.deepEqual(afterDuplicateMonster && { ...afterDuplicateMonster }, beforeDuplicateMonster);
  }
  assert.deepEqual(a.snapshots.at(-1).drops, beforeDuplicateDrops);
  check('duplicate attack request does not replay remotely', 'PASS', {
    localAcknowledgements: afterDuplicateEvents,
    remoteAcknowledgements: remoteAfterDuplicate,
  });

  async function attackUntilKilled(monsterId) {
    let lastHp = latestMonster(a, monsterId)?.hp ?? latestMonster(b, monsterId)?.hp ?? 0;
    for (let hit = 0; hit < 12; hit++) {
      const current = latestMonster(a, monsterId) || latestMonster(b, monsterId);
      if (!current || current.hp <= 0) return true;
      await waitUntil(() => a.self()?.action !== 'attack', 'kill attack cooldown', 2500);
      const requestId = `kill-${suffix}-${hit}`;
      a.send({ type: 'attack', requestId });
      await waitUntil(() => a.messages.some(message => message.type === 'actionStarted' && message.requestId === requestId), 'kill attack accepted');
      await waitUntil(() => {
        const mob = latestMonster(a, monsterId) || latestMonster(b, monsterId);
        return !mob || mob.hp < lastHp;
      }, 'kill attack damage', 4000);
      const after = latestMonster(a, monsterId) || latestMonster(b, monsterId);
      lastHp = after?.hp ?? 0;
      if (!after || after.hp <= 0) return true;
    }
    return false;
  }

  const killed = await attackUntilKilled(target.id);
  assert.equal(killed, true, 'Expected the target to reach hp=0 after authoritative attacks');
  await waitUntil(() => !latestMonster(a, target.id) || latestMonster(a, target.id).hp <= 0, 'monster death state', 2500);
  await sleep(100);
  const afterKillProfiles = { a: profileOf(a), b: profileOf(b) };
  const expGains = [
    afterKillProfiles.a.exp - initialProfiles.a.exp,
    afterKillProfiles.b.exp - initialProfiles.b.exp,
  ].filter(gain => gain > 0);
  assert.equal(expGains.length, 1, JSON.stringify(afterKillProfiles));
  assert.equal(expGains[0], 3);
  const rewardOwner = afterKillProfiles.a.exp > initialProfiles.a.exp ? a : b;
  const nonOwner = rewardOwner === a ? b : a;
  check('one account receives one authoritative EXP reward', 'PASS', { expGains, rewardOwner: rewardOwner.login.playerId });

  let drop;
  try {
    await waitUntil(() => (a.snapshots.at(-1)?.drops ?? []).some(candidate => !dropIdsBeforeKill.has(candidate.id)), 'new drop after kill', 2000);
    drop = a.snapshots.at(-1).drops.find(candidate => !dropIdsBeforeKill.has(candidate.id));
  } catch {
    drop = undefined;
  }
  if (!drop) {
    check('drop appears after kill', 'BLOCKED', { reason: 'The configured random drop table produced no drop in this run' });
  } else {
    check('drop appears after kill', 'PASS', { dropId: drop.id, itemId: drop.itemId, quantity: drop.quantity });
    async function approachDrop(bot) {
      const end = Date.now() + 5000;
      while (Date.now() < end) {
        const player = bot.self();
        const current = latestDrop(bot, drop.id) || latestDrop(a, drop.id);
        if (!player || !current) return;
        const dx = current.x - player.x;
        bot.input(Math.abs(dx) <= 20 ? 0 : Math.sign(dx));
        if (Math.abs(dx) <= 20 && Math.abs(current.y - player.y) <= 20) return;
        await sleep(100);
      }
      throw new Error(`Could not approach drop ${drop.id}`);
    }
    await Promise.all([approachDrop(a), approachDrop(b)]);
    a.input(0); b.input(0);
    await waitUntil(() => {
      const pa = a.self(); const pb = b.self();
      return pa && pb && Math.abs(pa.x - drop.x) <= 32 && Math.abs(pb.x - drop.x) <= 32;
    }, 'both players in pickup range', 3000);
    const paBefore = profileOf(a); const pbBefore = profileOf(b);
    const pickOwner = `pickup-owner-${suffix}`; const pickOther = `pickup-other-${suffix}`;
    rewardOwner.send({ type: 'pickup', requestId: pickOwner, dropId: drop.id });
    nonOwner.send({ type: 'pickup', requestId: pickOther, dropId: drop.id });
    await waitUntil(() => [rewardOwner, nonOwner].every(bot => bot.messages.some(message => [pickOwner, pickOther].includes(message.requestId))), 'concurrent pickup outcome');
    await sleep(250);
    const outcomes = [a, b].flatMap(bot => bot.messages.filter(message => [pickOwner, pickOther].includes(message.requestId)));
    const successes = outcomes.filter(message => message.type === 'pickupResult');
    const failures = outcomes.filter(message => message.type === 'rejected');
    assert.equal(successes.length, 1, JSON.stringify(redact(outcomes)));
    assert.equal(failures.length, 1, JSON.stringify(redact(outcomes)));
    assert.ok(['drop_owned', 'drop_unavailable'].includes(failures[0].code));
    assert.equal(successes[0].dropId, drop.id);
    assert.equal(successes[0].quantity, drop.quantity);
    assert.equal(successes[0].requestId, pickOwner);
    const nonOwnerOutcome = failures[0].code;
    const owner = rewardOwner;
    const other = nonOwner;
    await waitUntil(() => {
      const before = owner === a ? paBefore : pbBefore;
      const current = profileOf(owner);
      return current && inventoryQuantity(current, successes[0].itemId) - inventoryQuantity(before, successes[0].itemId) === successes[0].quantity;
    }, 'authoritative inventory/mesos increment');
    const ownerBeforeReplay = profileOf(owner);
    const otherBefore = other === a ? paBefore : pbBefore;
    assert.equal(inventoryQuantity(profileOf(other), successes[0].itemId), inventoryQuantity(otherBefore, successes[0].itemId));
    await waitUntil(() => !latestDrop(a, drop.id) && !latestDrop(b, drop.id), 'drop removed after pickup');
    const ownerReplayCount = owner.messages.filter(message => message.requestId === successes[0].requestId && message.type === 'pickupResult').length;
    owner.send({ type: 'pickup', requestId: successes[0].requestId, dropId: drop.id });
    await waitUntil(() => owner.messages.filter(message => message.requestId === successes[0].requestId && message.type === 'pickupResult').length > ownerReplayCount, 'duplicate pickup result');
    const replay = owner.messages.filter(message => message.requestId === successes[0].requestId && message.type === 'pickupResult').at(-1);
    assert.deepEqual({ dropId: replay.dropId, itemId: replay.itemId, quantity: replay.quantity }, {
      dropId: successes[0].dropId,
      itemId: successes[0].itemId,
      quantity: successes[0].quantity,
    });
    await sleep(150);
    assert.deepEqual(profileOf(owner), ownerBeforeReplay);
    check('concurrent pickup settles one reward', 'PASS', {
      dropId: drop.id,
      successCount: successes.length,
      rewardOwner: owner.login.playerId,
      nonOwnerRejected: nonOwnerOutcome,
      duplicatePickupPreservedProfile: true,
    });
  }

  const attackCountBeforeReconnect = a.messages.filter(message => message.type === 'actionStarted').length;
  a.ws.close();
  await waitUntil(() => !b.snapshots.at(-1).players.some(player => player.id === loginA.playerId), 'disconnect despawn');
  const reconnect = await connect(loginA);
  await waitUntil(() => reconnect.self(), 'reconnect snapshot');
  check('disconnect despawns and reconnect restores the account', 'PASS', {
    playerId: loginA.playerId,
    actionCountBeforeReconnect: attackCountBeforeReconnect,
  });
  reconnect.ws.close();
}

async function writeEvidence(error) {
  await mkdir(evidenceDir, { recursive: true });
  const sanitizedBots = bots.map(bot => ({
    playerId: bot.login.playerId,
    username: bot.login.username,
    errors: bot.errors,
    messages: redact(bot.messages.filter(message => message.type !== 'snapshot').slice(-40)),
    lastSnapshot: bot.snapshots.at(-1) && {
      serverTick: bot.snapshots.at(-1).serverTick,
      mapId: bot.snapshots.at(-1).mapId,
      selfId: bot.snapshots.at(-1).selfId,
      players: bot.snapshots.at(-1).players,
      monsters: bot.snapshots.at(-1).monsters,
      drops: bot.snapshots.at(-1).drops,
    },
  }));
  const report = {
    runId,
    server: base.origin,
    protocolVersion: 3,
    contentVersion: 'gms83-gameplay-2',
    completed: !error && !checks.some(check => ['FAIL', 'BLOCKED'].includes(check.status)),
    error: error?.message || null,
    checks,
    bots: sanitizedBots,
    note: 'Passwords and session tokens are intentionally omitted.',
  };
  await writeFile(`${evidenceDir}/network.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

let failure;
try {
  await run();
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
  check('network probe completed', 'FAIL', { error: failure.message });
} finally {
  for (const bot of bots) if (bot.ws.readyState === WebSocket.OPEN) bot.ws.close();
  await writeEvidence(failure);
}
if (failure || checks.some(check => ['FAIL', 'BLOCKED'].includes(check.status))) process.exitCode = 1;
