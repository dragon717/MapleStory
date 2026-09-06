// NPC dialogue locale probe (zh default / en override).
//
// Verifies the server-authoritative per-language npc dialogue end to end:
//   register  creates a throwaway account (birth map 000010000, standing next
//             to Heena 2101 whose dialogue now localizes to zh/en)
//   verify <zh|en> connects over WS, sends hello with the lang, walks up to
//             Heena via npcTalk and asserts the dialog text language.
//
// Usage:
//   node qa/dialogue_i18n_probe.mjs register [--state FILE]
//   node qa/dialogue_i18n_probe.mjs verify <zh|en> [--state FILE]
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
  : '/tmp/dialogue-i18n-probe.json';

// Heena (2101) stands at the birth map exit.  Her root dialogue is the
// training-camp ask when the account has no active training quest.
const TARGET_NPC = '2101';
const EXPECTED = {
  en: { text: 'Are you done with your training?', name: 'Heena' },
  zh: { text: '你的训练都完成了吗？', name: 'Heena' },
};

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
  const username = `dlg_${randomUUID().slice(0, 12)}`;
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
  assert(EXPECTED[lang], `unknown lang ${lang}`);
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  const { ws, snapshot, messages, waitFor } = await connect(state, lang);
  const npc = (snapshot().npcs ?? []).find(entry => entry.templateId === TARGET_NPC);
  assert(npc, `birth map has no npc ${TARGET_NPC}`);
  const requestId = `dlg-${randomUUID().slice(0, 6)}`;
  ws.send(JSON.stringify({ type: 'npcTalk', requestId, npcId: npc.id, step: 'start' }));
  const result = await waitFor(
    messages,
    msg => msg.type === 'npcResult' && msg.requestId === requestId,
    `npcResult for ${lang}`,
  );
  assert(result.success, `npcTalk rejected: ${result.code}`);
  const want = EXPECTED[lang];
  assert.equal(result.name, want.name, `name mismatch (${lang})`);
  assert(result.dialog?.text, `dialog text missing (${lang})`);
  assert(
    result.dialog.text.includes(want.text),
    `dialog text not localized to ${lang}: ${result.dialog.text}`,
  );
  console.log(`PASS ${lang}: Heena dialogue localized: ${result.dialog.text.slice(0, 40)}…`);
  ws.close();
}

const mode = process.argv[2];
assert(['register', 'verify'].includes(mode), 'usage: register | verify <zh|en>');
if (mode === 'register') await register();
else await verify(process.argv[3]);
