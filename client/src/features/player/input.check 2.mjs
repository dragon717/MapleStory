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
  input = new PlayerInput(message => messages.push(message), () => drop, () => portals++);
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
  document.activeElement = null;
  input.setReady(false);
  upKey('keydown');
  assert.equal(portals, 1, 'Disconnected input cannot enter a portal');
  input.setReady(true);
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
