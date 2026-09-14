import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const inputSource = await readFile(new URL('../player/input.ts', import.meta.url), 'utf8');
const { outputText: inputJs } = ts.transpileModule(inputSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const inputUrl = `data:text/javascript;base64,${Buffer.from(inputJs).toString('base64')}`;
const source = await readFile(new URL('./model.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const modelJs = outputText.replace(/from ['"]\.\.\/player\/input['"]/, `from '${inputUrl}'`);
const { KeyBindings, SLOT_COUNT, keyLabel, FIXED_CODES, STORAGE_PREFIX } = await import(`data:text/javascript;base64,${Buffer.from(modelJs).toString('base64')}`);

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
}

const storage = new MemoryStorage();
const changes = [];
const bindings = new KeyBindings({ storage });
const unsubscribe = bindings.subscribe(slots => changes.push(slots));
assert.equal(bindings.setCharacter('beginner', 0), true);
assert.equal(bindings.slots.length, SLOT_COUNT);
assert.deepEqual(bindings.resolve('Digit1'), { type: 'skill', skillId: 1000 });
assert.deepEqual(bindings.resolve('Numpad1'), { type: 'skill', skillId: 1000 });
assert.deepEqual(bindings.resolve('ControlLeft'), { type: 'action', action: 'attack' });
assert.deepEqual(bindings.resolve('KeyC'), { type: 'action', action: 'character' });
assert.equal(bindings.resolve('ArrowLeft'), null);
assert.ok(changes.length > 0);

assert.equal(bindings.bind('KeyB', false, { type: 'skill', skillId: 1000 }), true);
assert.deepEqual(bindings.resolve('KeyB'), { type: 'skill', skillId: 1000 });
assert.equal(bindings.bind('KeyA', false, null), true, 'clearing a default key is persisted');
assert.equal(bindings.resolve('KeyA'), null);
assert.equal(bindings.setSlot(0, 'KeyB', false), true, 'slot key can be selected independently');
assert.equal(bindings.slots[0].code, 'KeyB');
assert.equal(bindings.slots[0].binding?.type, 'skill');
assert.equal(bindings.setSlot(1, 'KeyB', false), true, 'duplicate display keys exchange slot positions');
assert.equal(bindings.slots[0].code, 'Digit2');
assert.equal(bindings.slots[1].code, 'KeyB');
assert.deepEqual(bindings.resolve('KeyB'), { type: 'skill', skillId: 1000 });

unsubscribe();
const restored = new KeyBindings({ storage });
assert.equal(restored.setCharacter('beginner', 200), true);
assert.deepEqual(restored.resolve('KeyB'), { type: 'skill', skillId: 1000 }, 'job change keeps a custom beginner binding');
assert.equal(restored.resolve('KeyA'), null, 'cleared default remains cleared');
assert.equal(restored.slots[0].code, 'Digit2');
assert.equal(restored.slots[1].code, 'KeyB');
assert.equal(restored.resetDefaults(), true);
assert.deepEqual(restored.resolve('Digit1'), { type: 'skill', skillId: 2001008 });
assert.equal(restored.resolve('KeyB'), null);

storage.setItem(`${STORAGE_PREFIX}bad`, '{broken');
const repaired = new KeyBindings({ storage });
assert.equal(repaired.setCharacter('bad', 200), true);
assert.equal(repaired.slots.length, SLOT_COUNT, 'bad JSON falls back to a complete layout');
assert.equal(JSON.parse(storage.getItem(`${STORAGE_PREFIX}bad`)).version, 1, 'bad JSON is replaced by the validated schema');

const errors = [];
const failing = new KeyBindings({
  storage: { getItem: () => null, setItem: () => { throw new Error('quota'); } },
  onError: message => errors.push(message),
});
assert.equal(failing.setCharacter('quota', 0), false);
assert.equal(failing.bind('KeyB', false, { type: 'action', action: 'attack' }), false);
assert.equal(errors.length >= 2, true, 'save failures are observable');
assert.equal(failing.setSlot(0, FIXED_CODES[0], false), false, 'arrows remain fixed');
assert.equal(keyLabel('KeyA'), 'A');
assert.equal(keyLabel('Digit1', true), 'Shift + 1');
assert.equal(keyLabel('ArrowLeft'), '←');
console.log('PASS: keybinding map, 32 display slots, persistence validation, job preservation, and save errors.');
