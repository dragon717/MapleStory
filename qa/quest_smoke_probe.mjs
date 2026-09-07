// End-to-end quest probe against the 3010 QA server.
// maple-road-training: accept at Sera(2100), turn in at Heena(2101) for mesos.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const base = new URL(process.env.SERVER_URL || 'http://127.0.0.1:3010');
const probeLang = process.env.QUEST_LANG === 'zh' ? 'zh' : 'en';
const reHeena = /Heena|希娜|希娜娅|image room|影像室|训练营/;
const reTurninText = /reward|rewarded|Sera|希娜|奖励|莎丽|训练营|image room|影像室/;
if (base.port !== '3010') throw new Error(`Refusing non-QA target ${base.origin}`);
const checks = [];
function check(name, status, details = {}) { checks.push({ name, status, ...details }); console.log(`${status} ${name}`); }
async function waitUntil(predicate, label, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (predicate()) return; await sleep(25); }
  throw new Error(`Timeout: ${label}`);
}
async function request(path, options = {}) {
  const response = await fetch(new URL(path, base), { ...options, signal: AbortSignal.timeout(15000) });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}
async function registerAndLogin(username) {
  const password = `Qa-${randomUUID()}-x`;
  const reg = await request('/api/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  if (reg.response.status === 409 || reg.response.status === 201) {
    const login = await request('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    assert.equal(login.response.status, 200, `login failed: ${JSON.stringify(login.body)}`);
    return { token: login.body.token, playerId: login.body.playerId, protocolVersion: login.body.protocolVersion, contentVersion: login.body.contentVersion };
  }
  assert.equal(reg.response.status, 200, `register failed: ${JSON.stringify(reg.body)}`);
  return { token: reg.body.token, playerId: reg.body.playerId };
}
function openSession({ token, protocolVersion, contentVersion }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${base.hostname}:${base.port}/ws`);
    const messages = [];
    let snapshot = null;
    const send = (payload) => ws.send(JSON.stringify(payload));
    ws.addEventListener('open', () => send({ type: 'hello', token, protocolVersion, contentVersion, lang: probeLang }));
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      messages.push(msg);
      if (msg.type === 'snapshot') snapshot = msg;
    });
    ws.addEventListener('error', () => reject(new Error('ws error')));
    resolve({
      ws, send, snapshot: () => snapshot, messages,
      close: () => ws.close(),
      ready: waitUntil(() => Boolean(snapshot), 'snapshot'),
      lastNpcResult: () => [...messages].reverse().find((m) => m.type === 'npcResult'),
      lastQuestUpdate: () => [...messages].reverse().find((m) => m.type === 'questUpdate'),
    });
  });
}

const username = `quest-${Date.now().toString(36)}`;
const { token, protocolVersion, contentVersion } = await registerAndLogin(username);
const session = await openSession({ token, protocolVersion, contentVersion });
await session.ready;

const snapshot = session.snapshot();
const self = snapshot.players.find((p) => p.id === snapshot.selfId);
assert.ok(self, 'self in snapshot');
const npc = (templateId) => snapshot.npcs.find((n) => n.templateId === templateId);
const seraI = npc('2100');
const heenaI = npc('2101');
assert.ok(seraI, 'Sera placed');
assert.ok(heenaI, 'Heena placed');
const talk = (instance, payload = {}) => session.send({ type: 'npcTalk', requestId: randomUUID(), npcId: instance.id, ...payload });
const mesosBefore = self.mesos;
console.log(`player mesos before: ${mesosBefore}`);

// 1) Sera: menu -> accept help (index 0).
talk(seraI, { step: 'start' });
await waitUntil(() => {
  const r = session.lastNpcResult();
  return r && r.npcId === seraI.id && r.dialog?.kind === 'simple';
}, 'Sera menu');
const menu = session.lastNpcResult();
check('Sera offers the quest menu', menu.dialog.options.length === 2, { options: menu.dialog.options.map((o) => o.text) });

talk(seraI, { step: 'select', selection: 0 });
await waitUntil(() => {
  const r = session.lastNpcResult();
  return r && r.dialog?.kind === 'next' && reHeena.test(r.dialog?.text ?? '');
}, 'Sera instructions');
check('Sera explains the quest', true, { text: session.lastNpcResult().dialog.text.slice(0, 60) });

talk(seraI, { step: 'next' });
await waitUntil(() => {
  const r = session.lastNpcResult();
  return r && r.npcId === seraI.id && (r.ended === true);
}, 'Sera accept ends');
check('Quest accepted (Sera ends)', true);
await waitUntil(() => {
  const u = session.lastQuestUpdate();
  return u && u.questId === 'maple-road-training' && u.status === 'active';
}, 'questUpdate active');
const acceptedUpdate = session.lastQuestUpdate();
check('Server pushes questUpdate on accept', acceptedUpdate.status === 'active', { name: acceptedUpdate.name, summary: acceptedUpdate.summary });

// 2) Heena: completing branch now appears.
talk(heenaI, { step: 'start' });
await waitUntil(() => {
  const r = session.lastNpcResult();
  return r && r.npcId === heenaI.id && r.dialog?.kind === 'next' && reTurninText.test(r.dialog?.text ?? '');
}, 'Heena completion branch');
check('Heena offers the completion page', true, { text: session.lastNpcResult().dialog.text.slice(0, 60) });

talk(heenaI, { step: 'next' });
await waitUntil(() => {
  const r = session.lastNpcResult();
  return r && r.npcId === heenaI.id && (r.ended === true);
}, 'Heena turn-in ends');

// Wait for the next snapshot to reflect the +300 mesos reward.
let mesosAfter = null;
await waitUntil(() => {
  const snap = session.snapshot();
  const p = snap.players.find((x) => x.id === snap.selfId);
  if (p && p.mesos !== mesosBefore) { mesosAfter = p.mesos; return true; }
  return false;
}, 'mesos reward snapshot', 15000);
check('Quest reward granted (+300 mesos)', mesosAfter === mesosBefore + 300, { before: mesosBefore, after: mesosAfter });
await waitUntil(() => {
  const u = session.lastQuestUpdate();
  return u && u.questId === 'maple-road-training' && u.status === 'completed';
}, 'questUpdate completed');
const completedUpdate = session.lastQuestUpdate();
check('Server pushes questUpdate on turn-in', completedUpdate.reward?.mesos === 300, { name: completedUpdate.name, reward: completedUpdate.reward });

// 3) Re-accept must be impossible: Sera now falls back to the intro.
talk(seraI, { step: 'start' });
await waitUntil(() => {
  const r = session.lastNpcResult();
  return r && r.npcId === seraI.id && reTurninText.test(r.dialog?.text ?? '');
}, 'Sera intro after completion');
check('Quest cannot be re-accepted (Sera intro)', true);

session.close();
const failed = checks.filter((c) => c.status === 'FAIL');
console.log(`\nquest probe: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(JSON.stringify(failed, null, 2)); process.exit(1); }
