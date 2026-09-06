// NPC nameplate probe (nameZh on snapshot / npcResult).
//
// Verifies the server ships the authoritative Chinese display name on both
// the world snapshot (drives the head nameplate) and npcResult (dialogue box
// / shop title).  The English name stays in `name`; zh is additive in
// `nameZh`, and the client picks per ui locale.
//
// Usage:
//   node qa/npc_nameplate_probe.mjs register [--state FILE]
//   node qa/npc_nameplate_probe.mjs verify <zh|en> [--state FILE]
//
// Env: SERVER_URL defaults to http://127.0.0.1:3010.  Needs Node >= 22.
import assert from 'node:assert/strict';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const base = new URL(process.env.SERVER_URL || 'http://127.0.0.1:3010');
const stateFile = process.argv.includes('--state')
  ? process.argv[process.argv.indexOf('--state') + 1]
  : '/tmp/npc-nameplate-probe.json';

const TARGET_NPC = '2101'; // Heena, standing at the birth map exit.
const EXPECTED = { en: 'Heena', zh: '希娜' };

async function auth(path, credentials, expectedStatus) {
  const response = await fetch(new URL(path, base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  const data = await response.json();
  assert.equal(response.status, expectedStatus, `${path}: ${response.status} ${data.error || ''}`);
  return data;
}

async function register() {
  const username = `npc_${randomUUID().slice(0, 12)}`;
  const credentials = { username, password: randomUUID() };
  await auth('/api/register', credentials, 201);
  const login = await auth('/api/login', credentials, 200);
  const state = { token: login.token, playerId: login.playerId, username };
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify(state, null, 2));
  console.log(`registered ${username} (${login.playerId})`);
}

async function connect(state, lang) {
  const ws = new WebSocket(`ws://${base.hostname}:${base.port}/ws`);
  const messages = [];
  let snapshot = null;
  const send = value => ws.send(JSON.stringify(value));
  await new Promise((resolve, reject) => {
    ws.addEventListener('error', event => reject(new Error(`ws error: ${event.message ?? 'unknown'}`)));
    ws.addEventListener('message', event => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'snapshot') snapshot = msg;
      else messages.push(msg);
    });
    ws.addEventListener('open', () => {
      send({
        type: 'hello',
        token: state.token,
        protocolVersion: 6,
        contentVersion: 'gms83-quest-2',
        lang,
      });
      resolve();
    });
    ws.addEventListener('close', event => {
      if (event.code !== 1000 && event.code !== 1005) reject(new Error(`ws closed ${event.code}`));
    });
  });
  const deadline = Date.now() + 8000;
  while (!snapshot && Date.now() < deadline) await sleep(20);
  assert(snapshot, 'no snapshot; handshake rejected?');
  return { ws, send, snapshot: () => snapshot, messages, waitFor };
}

async function waitFor(messages, predicate, label, timeoutMs = 6000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const hit = messages.find(predicate);
    if (hit) return hit;
    await sleep(20);
  }
  throw new Error(`Timeout waiting for ${label}`);
}

async function verify(lang) {
  const zhName = EXPECTED.zh;
  assert(lang === 'zh' || lang === 'en', `unknown lang ${lang}`);
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  const { ws, snapshot, messages, waitFor } = await connect(state, lang);

  // 1) world snapshot carries both authoritative names on NpcState.
  const npc = (snapshot().npcs ?? []).find(entry => entry.templateId === TARGET_NPC);
  assert(npc, `birth map has no npc ${TARGET_NPC}`);
  assert.equal(npc.name, EXPECTED.en, `snapshot name (${lang})`);
  assert.equal(npc.nameZh, zhName, `snapshot nameZh (${lang})`);

  // 2) npcResult carries both names for the dialogue box / shop title.
  const requestId = `npc-${randomUUID().slice(0, 6)}`;
  ws.send(JSON.stringify({ type: 'npcTalk', requestId, npcId: npc.id, step: 'start' }));
  const result = await waitFor(
    messages,
    msg => msg.type === 'npcResult' && msg.requestId === requestId,
    `npcResult for ${lang}`,
  );
  assert(result.success, `npcTalk rejected: ${result.code}`);
  assert.equal(result.name, EXPECTED.en, `result name (${lang})`);
  assert.equal(result.nameZh, zhName, `result nameZh (${lang})`);

  // The client's pick: zh locale prefers nameZh, en locale prefers name.
  const display = lang === 'en' ? (result.name ?? result.nameZh ?? '') : (result.nameZh ?? result.name ?? '');
  assert.equal(display, EXPECTED[lang], `client display pick (${lang})`);
  console.log(`PASS ${lang}: nameplate name = ${display} (name=${result.name}, nameZh=${result.nameZh})`);
  ws.close();
}

const mode = process.argv[2];
assert(['register', 'verify'].includes(mode), 'usage: register | verify <zh|en>');
if (mode === 'register') await register();
else await verify(process.argv[3]);
