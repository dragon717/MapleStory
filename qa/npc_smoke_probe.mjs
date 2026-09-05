// Minimal npc/shop smoke probe against the 3010 QA server.
// Connects with WS, requests npcTalk and shopBuy against placed ids.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const base = new URL(process.env.SERVER_URL || 'http://127.0.0.1:3010');
if (base.port !== '3010') throw new Error(`Refusing non-QA target ${base.origin}`);
const runId = process.env.QA_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
const evidenceDir = `evidence/qa/npc-${runId}`;
await mkdir(evidenceDir, { recursive: true });
const checks = [];

function check(name, status, details = {}) {
  checks.push({ name, status, ...details });
  console.log(`${status} ${name}`);
}

async function waitUntil(predicate, label, timeoutMs = 8000) {
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
  const reg = await request('/api/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (reg.response.status === 409 || reg.response.status === 201) {
    const login = await request('/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    assert.equal(login.response.status, 200, `login failed: ${JSON.stringify(login.body)}`);
    return { token: login.body.token, playerId: login.body.playerId, username };
  }
  assert.equal(reg.response.status, 200, `register failed: ${JSON.stringify(reg.body)}`);
  return { token: reg.body.token, playerId: reg.body.playerId, username };
}

function openSession({ token, playerId, username }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${base.hostname}:${base.port}/ws`);
    const messages = [];
    let snapshot = null;
    const send = (payload) => ws.send(JSON.stringify(payload));
    ws.addEventListener('open', () => {
      send({ type: 'hello', token, protocolVersion: 4, contentVersion: 'gms83-npc-1' });
    });
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      messages.push(msg);
      if (msg.type === 'snapshot') snapshot = msg;
    });
    ws.addEventListener('error', (event) => reject(new Error(`ws error: ${event.message ?? 'unknown'}`)));
    ws.addEventListener('close', (event) => {
      if (event.code !== 1000 && event.code !== 1005) reject(new Error(`ws closed ${event.code}`));
    });
    resolve({
      ws, send, snapshot: () => snapshot, messages,
      close: () => ws.close(),
      username,
      playerId,
      ready: waitUntil(() => Boolean(snapshot), 'snapshot'),
    });
  });
}

const session = await openSession(await registerAndLogin(`qa-npc-${randomUUID().slice(0, 6)}`));
await session.ready;

const snapshot = session.snapshot();
const npcs = snapshot.npcs ?? [];
check('snapshot has npcs', npcs.length > 0 ? 'PASS' : 'FAIL', { count: npcs.length });

if (npcs.length) {
  const target = npcs[0];
  session.send({ type: 'input', seq: 1, direction: 0, vertical: 0, jump: false });
  await sleep(200);
  await waitUntil(() => (session.snapshot()?.npcs ?? []).some(npc => npc.id === target.id), 'npc in snapshot');

  // npcTalk start
  const reqId = `npc-${randomUUID().slice(0, 6)}`;
  session.send({ type: 'npcTalk', requestId: reqId, npcId: target.id, step: 'start' });
  let npcResult;
  await waitUntil(() => {
    npcResult = session.messages.find(msg => msg.type === 'npcResult' && msg.requestId === reqId);
    return Boolean(npcResult);
  }, 'npcResult', 5000);
  check('npcTalk returns result', npcResult && npcResult.success ? 'PASS' : 'FAIL',
    { npcId: target.id, hasDialog: Boolean(npcResult?.dialog), name: npcResult?.name });

  // If the response is a `next` dialog, follow it.
  if (npcResult?.dialog?.kind === 'next' || npcResult?.dialog?.kind === 'nextPrev') {
    const reqId2 = `npc-${randomUUID().slice(0, 6)}`;
    session.send({ type: 'npcTalk', requestId: reqId2, npcId: target.id, step: 'next' });
    let advance;
    await waitUntil(() => {
      advance = session.messages.find(msg => msg.type === 'npcResult' && msg.requestId === reqId2);
      return Boolean(advance);
    }, 'npcResult advance', 5000);
    check('npcTalk advance works', advance?.success ? 'PASS' : 'FAIL',
      { kind: advance?.dialog?.kind });
  }
}

// Shop buy smoke: find any npc on the current map that owns a shop and try
// buying its cheapest item.  The birth map usually does not carry a shop
// owner, so this is a best-effort probe.
const shopNpc = (session.snapshot()?.npcs ?? []).find(npc => npc.shopId);
if (shopNpc) {
  const reqId = `shop-${randomUUID().slice(0, 6)}`;
  // Cheapest item id across the registered shops (1302000 = 50 mesos in
  // Sid's catalogue); also a sane starter pick.
  session.send({ type: 'shopBuy', requestId: reqId, shopId: shopNpc.shopId, itemId: '1302000', quantity: 1 });
  let result;
  await waitUntil(() => {
    result = session.messages.find(msg => msg.type === 'shopResult' && msg.requestId === reqId);
    return Boolean(result);
  }, 'shopResult', 5000);
  check('shopBuy executes', result?.success ? 'PASS' : 'FAIL',
    { code: result?.code, mesosSpent: result?.mesosSpent });
} else {
  check('shop owner on birth map', 'SKIP', { reason: 'no shop owner placed on birth map' });
}

await session.close();
await writeFile(`${evidenceDir}/summary.json`, JSON.stringify({ checks, runId }, null, 2));
const failed = checks.filter(c => c.status === 'FAIL');
if (failed.length) {
  console.error(`${failed.length} check(s) failed`);
  process.exit(1);
}
console.log(`All ${checks.length} check(s) passed`);