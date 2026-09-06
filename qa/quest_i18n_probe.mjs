// M3 bilingual questList probe.
//
// Verifies the server-authoritative multilingual quest push end to end:
//   1. `register` creates a throwaway account and saves its session to a
//      state file (the account is then seeded with player_quests rows by the
//      caller so the join has persisted quest state to localize).
//   2. `verify <en|zh>` connects over the real WebSocket, sends hello with the
//      given lang, waits for the pushed questList and asserts the localized
//      display text for the seeded rows.
//
// Usage:
//   node qa/quest_i18n_probe.mjs register [--state FILE]
//   node qa/quest_i18n_probe.mjs verify <en|zh> [--state FILE]
//   # register 后需为 playerId 播种 player_quests：
//   #   1000 active / 1021 active / 1204 completed / 1205 active / maple-road-training completed
//
// Env: SERVER_URL defaults to http://127.0.0.1:3010.  Requires Node >= 22
// (global fetch/WebSocket).  Never mutates server logic; only ever creates a
// throwaway account (caller may add player_quests rows for that account).
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const base = new URL(process.env.SERVER_URL || 'http://127.0.0.1:3010');
const defaultState = '/tmp/quest-i18n-probe.json';
const stateFile = process.argv.includes('--state')
  ? process.argv[process.argv.indexOf('--state') + 1]
  : defaultState;

const expected = {
  en: {
    '1000': { name: "Borrowing Sera's Mirror", status: 'active' },
    '1021': { name: "Roger's Apple", status: 'active', summary: true },
    '1204': { name: 'Lord Pirate', status: 'completed' },
    '1205': { name: 'Romeo and Juliet', status: 'active' },
    'maple-road-training': { name: 'Training Camp Check', status: 'completed', summary: true },
  },
  zh: {
    // 1000/1204/1205 来自官方中文语料(mxd.dvg.cn 国服译名，kind=official-cn，1204/1205 为候选复核提拔)；
    // 1021/maple-road-training 为 pinned 人工版
    '1000': { name: '借来莎丽的镜子', status: 'active' },
    '1021': { name: '罗杰的苹果', status: 'active', summary: true },
    '1204': { name: '海盗船组队任务', status: 'completed' },
    '1205': { name: '拯救罗密欧和朱丽叶', status: 'active' },
    'maple-road-training': { name: '训练营任务确认', status: 'completed', summary: true },
  },
};

async function auth(path, credentials, expectedStatus) {
  const response = await fetch(new URL(path, base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  const data = await response.json();
  assert.equal(
    response.status,
    expectedStatus,
    `${path}: ${response.status} ${data.error || ''}`,
  );
  return data;
}

async function register() {
  const username = `probe_${randomUUID().slice(0, 12)}`;
  const credentials = { username, password: randomUUID() };
  await auth('/api/register', credentials, 201);
  const login = await auth('/api/login', credentials, 200);
  assert.equal(login.protocolVersion, 6, 'protocol must be 6');
  assert.equal(login.contentVersion, 'gms83-quest-2', 'content must be gms83-quest-2');
  const state = { token: login.token, playerId: login.playerId, username };
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify(state, null, 2));
  console.log(`registered ${username} (${login.playerId})`);
}

async function connect(state, lang) {
  const url = new URL('/ws', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url);
  const events = [];
  let snapshot = null;
  const errors = [];
  const send = value => ws.send(JSON.stringify(value));
  ws.addEventListener('error', () => errors.push('WebSocket error'));
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.type === 'snapshot') snapshot = message;
    else events.push(message);
  });
  const deadline = Date.now() + 8000;
  while (ws.readyState !== WebSocket.OPEN && Date.now() < deadline && !errors.length) {
    await sleep(20);
  }
  assert.equal(errors.length, 0, 'websocket error before open');
  assert.equal(ws.readyState, WebSocket.OPEN, 'websocket did not open');
  send({
    type: 'hello',
    token: state.token,
    protocolVersion: 6,
    contentVersion: 'gms83-quest-2',
    lang,
  });
  while (Date.now() < deadline) {
    if (events.some(event => event.type === 'questList')) break;
    if (events.some(event => event.type === 'rejected')) break;
    await sleep(20);
  }
  ws.close();
  assert(snapshot, 'no snapshot; handshake rejected? ' + JSON.stringify(events.slice(0, 3)));
  const list = events.find(event => event.type === 'questList');
  assert(list, 'server never pushed questList after join');
  return list.quests;
}

async function verify(lang) {
  assert(expected[lang], `unknown lang ${lang}`);
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  const quests = await connect(state, lang);
  const byId = id => quests.find(entry => entry.questId === id);
  for (const [questId, want] of Object.entries(expected[lang])) {
    const entry = byId(questId);
    assert(entry, `missing seeded quest ${questId} in questList for ${lang}`);
    assert.equal(entry.name, want.name, `name mismatch for ${questId} (${lang})`);
    assert.equal(entry.status, want.status, `status mismatch for ${questId} (${lang})`);
    assert(entry.summary || !want.summary, `summary must not be empty for ${questId} (${lang})`);
  }
  console.log(
    `PASS ${lang}: questList localized (${quests.length} rows): ` +
      Object.values(expected[lang])
        .map(want => want.name)
        .join(' / '),
  );
}

const mode = process.argv[2];
assert(['register', 'verify'].includes(mode), 'usage: register | verify <en|zh>');
if (mode === 'register') await register();
else await verify(process.argv[3]);
