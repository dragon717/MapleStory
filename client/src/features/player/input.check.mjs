import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./input.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { PlayerInput } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const original = { window: globalThis.window, document: globalThis.document, setInterval, clearInterval };
const timers = new Map();
const messages = [];
let nextTimer = 0;
let input;
try {
  globalThis.window = new EventTarget();
  globalThis.document = Object.assign(new EventTarget(), { hidden: false, activeElement: null });
  globalThis.setInterval = (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; };
  globalThis.clearInterval = id => timers.delete(id);
  let drop = 'first';
  let portals = 0;
  let questLogToggles = 0;
  let skillToggles = 0;
  const skillCasts = [];
  let grounded = true;
  let job = 200;
  const learnedSkills = {
    '2001002': 1, '2001008': 1, '2001009': 1, '2001011': 1, '2001012': 1,
    '2201001': 1, '2201005': 1, '2201008': 1, '2201009': 1,
  };
  let modalBlocked = false;
  input = new PlayerInput(message => messages.push(message), {
    nearestDrop: () => drop,
    enterPortal: () => portals++,
    nearestNpc: () => null,
    talkTo: () => {},
    toggleQuestLog: () => questLogToggles++,
    toggleSkills: () => skillToggles++,
    castSkill: (skillId, direction, vertical) => skillCasts.push({ skillId, direction, vertical }),
    playerState: () => ({ grounded, job, skills: learnedSkills }),
    isBlocked: () => modalBlocked,
  });
  input.setReady(true);
  const key = (type, repeat = false) => window.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { code: 'KeyZ', repeat }));
  const upKey = (type, repeat = false) => window.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { code: 'ArrowUp', repeat }));
  upKey('keydown');
  assert.equal(portals, 1, 'Up requests a portal');
  assert.equal(messages.at(-1).vertical, -1, 'Up still climbs ladders');
  upKey('keydown', true);
  [...timers.values()].find(timer => timer.delay === 150).callback();
  assert.equal(portals, 1, 'Repeat/heartbeat cannot bounce through portals');
  upKey('keyup');
  document.activeElement = { matches: () => true };
  upKey('keydown');
  assert.equal(portals, 1, 'Typing in UI cannot enter a portal');
  window.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { code: 'KeyQ', repeat: false }));
  assert.equal(questLogToggles, 0, 'Typing Q in UI cannot toggle the quest log');
  window.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { code: 'KeyK', repeat: false }));
  assert.equal(skillToggles, 0, 'Typing K in UI cannot open skills');
  document.activeElement = { matches: () => false, closest: () => null, isContentEditable: true };
  upKey('keydown');
  assert.equal(portals, 1, 'Contenteditable UI cannot enter a portal');
  document.activeElement = null;
  input.setReady(false);
  upKey('keydown');
  assert.equal(portals, 1, 'Disconnected input cannot enter a portal');
  input.setReady(true);
  for (const repeat of [false, true]) window.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { code: 'KeyK', repeat }));
  assert.equal(skillToggles, 1, 'K opens skills once and ignores OS repeat');
  window.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { code: 'KeyK', repeat: false, ctrlKey: true }));
  assert.equal(skillToggles, 1, 'Ctrl+K remains a browser shortcut');
  const dispatchCode = (code, repeat = false) => window.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { code, repeat }));
  dispatchCode('Digit1');
  dispatchCode('Digit2');
  dispatchCode('Digit3');
  assert.deepEqual(skillCasts.slice(-3).map(cast => cast.skillId), [2001008, 2001009, 2001002], '1/2/3 cast the first-job shortcuts');
  job = 220;
  for (const code of ['Digit4', 'Digit5', 'Digit6', 'Digit7']) dispatchCode(code);
  assert.deepEqual(skillCasts.slice(-4).map(cast => cast.skillId), [2201008, 2201005, 2201001, 2201009], '4/5/6/7 cast Ice/Lightning shortcuts');
  job = 200;
  const shortcutInputCount = messages.filter(message => message.type === 'input').length;
  learnedSkills['2201008'] = 0;
  dispatchCode('Digit4');
  assert.equal(skillCasts.at(-1).skillId, 2201009, 'unlearned second-job shortcut does not cast');
  assert.equal(messages.filter(message => message.type === 'input').length, shortcutInputCount, 'unlearned shortcut does not become movement input');
  learnedSkills['2201008'] = 1;
  dispatchCode('ArrowUp');
  dispatchCode('Space');
  assert.equal(skillCasts.at(-1).skillId, 2001011, 'up + jump requests the wave skill');
  dispatchCode('ArrowUp');
  grounded = false;
  dispatchCode('Space');
  assert.equal(skillCasts.at(-1).skillId, 2001012, 'air jump requests the authoritative float intent');
  window.dispatchEvent(Object.assign(new Event('keyup'), { code: 'ArrowUp' }));
  const pickups = () => messages.filter(message => message.type === 'pickup');
  const repeat = () => [...timers.values()].find(timer => timer.delay === 200);
  key('keydown');
  assert.equal(pickups().length, 1);
  assert.ok(repeat(), 'Repeat interval is 200 ms');
  key('keydown', true);
  assert.equal(pickups().length, 1, 'OS repeat does not trigger extra pickups');
  drop = 'second';
  repeat().callback();
  assert.deepEqual(pickups().map(message => message.dropId), ['first', 'second']);
  assert.notEqual(pickups()[0].requestId, pickups()[1].requestId);
  drop = null;
  repeat().callback();
  assert.equal(pickups().length, 2);
  key('keyup');
  assert.equal(repeat(), undefined);
  const attackCount = messages.filter(message => message.type === 'attack').length;
  const consumed = Object.assign(new Event('keydown', { cancelable: true }), { code: 'KeyX', repeat: false });
  consumed.preventDefault();
  window.dispatchEvent(consumed);
  window.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { code: 'KeyX', repeat: false, isComposing: true }));
  assert.equal(messages.filter(message => message.type === 'attack').length, attackCount, 'Consumed or composing keys cannot attack');
  upKey('keydown');
  modalBlocked = true;
  [...timers.values()].find(timer => timer.delay === 150).callback();
  assert.equal(messages.at(-1).vertical, 0, 'A modal opened without focus releases held movement on heartbeat');
  modalBlocked = false;
  [...timers.values()].find(timer => timer.delay === 150).callback();
  assert.equal(messages.at(-1).vertical, 0, 'Closing the modal cannot resume stale held keys');
  key('keydown');
  modalBlocked = true;
  repeat().callback();
  assert.equal(repeat(), undefined, 'Modal opening cancels held pickup without waiting for keyup');
  window.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { code: 'KeyX', repeat: false }));
  assert.equal(messages.filter(message => message.type === 'attack').length, attackCount, 'Modal input cannot attack');
  modalBlocked = false;
  for (const stop of [
    () => window.dispatchEvent(new Event('blur')),
    () => { document.hidden = true; document.dispatchEvent(new Event('visibilitychange')); },
    () => { document.activeElement = { matches: () => true }; document.dispatchEvent(new Event('focusin')); },
    () => input.setReady(false),
    () => input.destroy(),
  ]) {
    document.hidden = false;
    document.activeElement = null;
    input.setReady(true);
    key('keydown');
    assert.ok(repeat());
    stop();
    assert.equal(repeat(), undefined, 'Release/focus loss/disconnect/destroy stops pickup');
  }
  assert.equal(timers.size, 0);
  console.log('PASS: immediate pickup, 200 ms repeats, fresh targets, and all stop conditions.');
} finally {
  input?.destroy();
  Object.assign(globalThis, original);
}
